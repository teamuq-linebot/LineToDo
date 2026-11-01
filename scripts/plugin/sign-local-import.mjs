import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertSafeOutput, enumerateStage, readInstalledMetadata, sourceIdentity, PLUGIN_ID, TARGET_CORE, TARGET_PLATFORM, AUTHORING_TOOL_CORE, AUTHORING_TOOL_SHA256, AUTHORING_TOOL_VERSION_TEXT } from './build-local-import.mjs'

const SCRIPT_FILE = fileURLToPath(import.meta.url)
const REPO = path.resolve(path.dirname(SCRIPT_FILE), '..', '..')
const KEY_ID = 'teamuq-root-2026a'
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex')
const fileHash = (file) => hash(fs.readFileSync(file))
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const canonical = (value) => Array.isArray(value)
  ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object'
    ? '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
    : JSON.stringify(value)

export function parseArgs(argv) {
  const options = { mode: null, runDir: null, approval: null, help: false }
  const values = new Map([['--run-dir', 'runDir'], ['--approval', 'approval']])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--approved-sign' || arg === '--check' || arg === '--guard-probe') {
      if (options.mode) throw new Error('只能指定一個簽章模式')
      options.mode = arg
    } else if (values.has(arg)) {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error('缺少 ' + arg + ' 的值')
      options[values.get(arg)] = value
      index += 1
    } else throw new Error('未知簽章參數：' + arg)
  }
  options.runDir ||= process.env.LINE_TODO_LOCAL_IMPORT_RUN_DIR || null
  options.approval ||= process.env.LINE_TODO_LOCAL_IMPORT_APPROVAL || null
  if (!options.help && !options.mode) throw new Error('必須明確指定 --check、--guard-probe 或 --approved-sign')
  if (!options.help && !options.runDir) throw new Error('--run-dir 必填')
  if (options.mode === '--approved-sign' && !options.approval) throw new Error('--approved-sign 需要 Reviewer 的 --approval receipt')
  if (options.mode !== '--approved-sign' && options.approval) throw new Error('--approval 只適用於 --approved-sign')
  return options
}

export function assertApprovalBindings(receipt, expectedBindings) {
  if (!receipt || receipt.status !== 'approved') throw new Error('Reviewer receipt 不是 approved')
  if (typeof receipt.reviewer !== 'string' || receipt.reviewer.trim() === '') throw new Error('Reviewer receipt 缺少 reviewer')
  if (typeof receipt.approvedAt !== 'string' || !Number.isFinite(Date.parse(receipt.approvedAt))) throw new Error('Reviewer receipt 缺少有效 approvedAt')
  if (canonical(receipt.bindings) !== canonical(expectedBindings)) {
    throw new Error('Reviewer receipt bindings 與 request、wrapper、tool、stage、unsigned package、preflight 或 target 不完全相符')
  }
  return receipt
}

export async function runAfterApproval(receipt, expectedBindings, privateAction) {
  assertApprovalBindings(receipt, expectedBindings)
  return privateAction(receipt)
}

function spawn(command, args, cwd, encoding = 'utf8') {
  const result = spawnSync(command, args, { cwd, encoding, windowsHide: true, maxBuffer: 1 << 26 })
  if (result.error) throw result.error
  return result
}

function ensureWithin(runDir, file) {
  if (!requireInside(runDir, file)) throw new Error('review bundle 路徑超出 run directory：' + file)
}

function requireInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
}

function runTool(toolPath, args) {
  const result = spawn(process.execPath, [toolPath, ...args], REPO)
  return { command: [process.execPath, toolPath, ...args], exitCode: result.status, stdout: result.stdout || '', stderr: result.stderr || '' }
}

function assertOk(result, phase) {
  if (result.exitCode !== 0) throw new Error('Core author CLI ' + phase + ' exit ' + result.exitCode + ': ' + result.stderr)
}

function currentBindings(runDir) {
  const root = assertSafeOutput(runDir)
  if (!fs.statSync(root).isDirectory()) throw new Error('run directory 必須是目錄')
  const requestPath = path.join(root, 'pre-sign-review-request.json')
  const bindingsPath = path.join(root, 'pre-sign-bindings.json')
  const preflightPath = path.join(root, 'pre-sign-preflight.json')
  const stageIndexPath = path.join(root, 'stage-index.json')
  const sourcePath = path.join(root, 'source-identity.json')
  for (const file of [requestPath, bindingsPath, preflightPath, stageIndexPath, sourcePath]) {
    ensureWithin(root, file)
    if (!fs.existsSync(file)) throw new Error('缺少 pre-sign evidence：' + file)
  }
  const request = readJson(requestPath)
  const recorded = readJson(bindingsPath)
  const preflight = readJson(preflightPath)
  const stageIndex = readJson(stageIndexPath)
  const stageFiles = enumerateStage(stageIndex.stage)
  const storedTool = preflight.authoringTool
  const storedArchive = preflight.unsignedArtifact
  const storedSource = preflight.sourceIdentity
  const toolPath = storedTool.path
  const targetPath = storedArchive.path
  for (const file of [stageIndex.stage, storedArchive.path, storedSource.path, toolPath]) ensureWithin(root, file)
  if (canonical(stageFiles) !== canonical(stageIndex.files)) throw new Error('stage contents differ from stage index')
  if (fileHash(path.join(root, 'overrides.json')) !== stageIndex.overridesSha256) throw new Error('pack overrides hash differs from stage index')
  if (fileHash(stageIndexPath) !== preflight.stageIndex.sha256) throw new Error('stage index hash differs from preflight')
  if (fileHash(sourcePath) !== storedSource.sha256) throw new Error('source identity hash differs from preflight')
  if (canonical(sourceIdentity()) !== canonical(readJson(sourcePath))) throw new Error('committed source HEAD/tree 或 clean 狀態已改變；簽章 request 過期')
  if (request.pluginId !== PLUGIN_ID || request.version !== preflight.version || request.status !== 'pending_independent_reviewer') {
    throw new Error('review request identity/status mismatch')
  }
  if (request.target.coreVersion !== TARGET_CORE || request.target.platform !== TARGET_PLATFORM) throw new Error('review request target mismatch')
  if (request.sourceCommit !== readJson(sourcePath).head || request.sourceTree !== readJson(sourcePath).tree) throw new Error('review request committed source identity mismatch')
  if (storedTool.sha256 !== AUTHORING_TOOL_SHA256 || fileHash(toolPath) !== AUTHORING_TOOL_SHA256) throw new Error('Core 1.8.4 author tool hash mismatch')
  if (storedTool.builtFromCore !== AUTHORING_TOOL_CORE) throw new Error('author tool Core metadata mismatch')
  const version = spawn(process.execPath, [toolPath, '--version'], REPO)
  if (version.status !== 0 || version.stdout.trim() !== AUTHORING_TOOL_VERSION_TEXT) throw new Error('Core author tool version mismatch')
  if (!fs.existsSync(storedSource.path) || !fs.existsSync(targetPath)) throw new Error('source identity or unsigned archive missing')
  if (fileHash(targetPath) !== storedArchive.sha256) throw new Error('unsigned archive SHA-256 changed')
  const verify = runTool(toolPath, ['verify', targetPath, '--anchors', 'core', '--core-version', TARGET_CORE, '--platform', TARGET_PLATFORM])
  assertOk(verify, 'verify unsigned')
  const verified = JSON.parse(verify.stdout)
  if (verified.id !== PLUGIN_ID || verified.version !== preflight.version || verified.signer?.kind !== 'unsigned' || verified.integritySha256 !== preflight.integritySha256) {
    throw new Error('unsigned package identity, integrity, or signer mismatch')
  }
  const installed = preflight.installed
  if (!['first-install', 'installed'].includes(installed.state) || !installed.rootPath) {
    throw new Error('未知安裝狀態；拒絕使用簽章 request')
  }
  const freshInstalled = readInstalledMetadata(path.join(installed.rootPath, 'manifest.json'))
  if (canonical(freshInstalled) !== canonical(installed)) throw new Error('安裝狀態、manifest 或版本清單已改變；簽章 request 過期')
  if (request.installedState !== installed.state || request.installedVersion !== installed.version) throw new Error('review request 安裝狀態與 preflight 不符')
  if (!fs.existsSync(preflight.core.executable) || fileHash(preflight.core.executable) !== preflight.core.sha256) {
    throw new Error('Core executable changed; signing request is stale')
  }
  const expected = {
    task_id: request.taskId,
    plugin_id: PLUGIN_ID,
    version: preflight.version,
    installed_state: installed.state,
    installed_version: installed.version,
    platform: TARGET_PLATFORM,
    source_identity_sha256: fileHash(sourcePath),
    request_sha256: fileHash(requestPath),
    wrapper_sha256: fileHash(SCRIPT_FILE),
    devkit_sha256: fileHash(toolPath),
    stage_index_sha256: fileHash(stageIndexPath),
    unsigned_archive_sha256: fileHash(targetPath),
    unsigned_integrity_sha256: verified.integritySha256,
    preflight_sha256: fileHash(preflightPath),
    core_version: TARGET_CORE,
    devkit_built_from_core: AUTHORING_TOOL_CORE,
  }
  if (canonical(recorded) !== canonical(expected)) throw new Error('pre-sign bindings file is stale')
  return { root, request, preflight, stageIndex, expected, verify, toolPath, artifactPath: targetPath }
}

function readDpapiPassphrase(unlockPath) {
  const ps = [
    "$ErrorActionPreference='Stop'",
    '$blob = (Get-Content -LiteralPath ' + "'" + unlockPath.replaceAll("'", "''") + "'" + ' -Raw).Trim()',
    '$secure = ConvertTo-SecureString -String $blob',
    '$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
    'try { [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)))) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }',
  ].join('; ')
  const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  if (child.error || child.status !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(child.stdout)) throw new Error('DPAPI unlock failed: ' + unlockPath)
  const passphrase = Buffer.from(child.stdout, 'base64').toString('utf8')
  if (!passphrase) throw new Error('DPAPI returned an empty passphrase')
  return passphrase
}

async function approvedSign(prepared, runDir, approvalPath) {
  const receipt = readJson(approvalPath)
  await runAfterApproval(receipt, prepared.expected, async () => {
    if (process.platform !== 'win32') throw new Error('DPAPI signing is Windows-only')
    if (process.env.TEAMUQ_KEY_PASSPHRASE_FOR_TESTS) throw new Error('test passphrase environment variable is set')
    const key = path.join(os.homedir(), '.teamuq-keys', KEY_ID + '.key.pem')
    const unlock = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'TeamUQ', 'root-key', KEY_ID + '.unlock.dpapi')
    if (path.basename(key) !== KEY_ID + '.key.pem' || path.basename(unlock) !== KEY_ID + '.unlock.dpapi') throw new Error('only root2026a protected key paths are allowed')
    if (!fs.existsSync(key) || !fs.existsSync(unlock)) throw new Error('existing root2026a key/unlock files are unavailable')
    const signed = path.join(runDir, PLUGIN_ID + '-' + prepared.preflight.version + '-win32-x64.root2026a.signed.tuqplugin')
    if (fs.existsSync(signed)) throw new Error('refusing to overwrite signed output')
    const jobs = path.join(runDir, 'sign-jobs.json')
    fs.writeFileSync(jobs, JSON.stringify([{ stage: prepared.stageIndex.stage, out: signed, overrides: path.join(runDir, 'overrides.json') }], null, 2) + '\n', { flag: 'wx' })
    const devkit = await import(pathToFileURL(prepared.toolPath).href)
    const startedAt = new Date().toISOString()
    const signExit = await devkit.main(
      ['pack-batch', '--jobs', jobs, '--key', key, '--anchors', 'core', '--core-version', TARGET_CORE, '--platform', TARGET_PLATFORM],
      { readPassphrase: async () => readDpapiPassphrase(unlock) },
    )
    if (signExit !== 0) throw new Error('protected pack-batch failed with exit ' + signExit)
    const verified = runTool(prepared.toolPath, ['verify', signed, '--anchors', 'core', '--core-version', TARGET_CORE, '--platform', TARGET_PLATFORM])
    assertOk(verified, 'verify signed')
    const info = JSON.parse(verified.stdout)
    if (info.signer?.keyId !== KEY_ID || info.integritySha256 !== prepared.preflight.integritySha256) {
      throw new Error('signed signer or integrity differs from reviewed package')
    }
    const result = {
      taskId: prepared.request.taskId,
      status: 'signed_package_verified_ready_for_manual_import',
      signer: info.signer,
      integritySha256: info.integritySha256,
      artifact: { path: signed, bytes: fs.statSync(signed).size, sha256: fileHash(signed) },
      verification: info,
      startedAt,
      endedAt: new Date().toISOString(),
      reviewer: receipt.reviewer,
      manualImport: '未自動安裝；請在 Core UI 選取已驗證簽章檔。',
      secretHandling: 'DPAPI 解封字串與私鑰僅留在 process memory；不輸出至 result/log/argv/environment。',
    }
    fs.writeFileSync(path.join(runDir, 'sign-result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  })
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    process.stdout.write('用法：npm run import:local:approved-sign -- --run-dir <pre-sign 目錄> --approval <Reviewer receipt>\n')
    return
  }
  const prepared = currentBindings(options.runDir)
  if (options.mode === '--guard-probe') {
    let called = false
    let rejected = false
    let reason = ''
    try {
      await runAfterApproval({ status: 'approved', reviewer: 'fixture-only', approvedAt: '2026-10-30T00:00:00Z', bindings: { task_id: 'stale' } }, prepared.expected, async () => { called = true })
    } catch (error) {
      rejected = true
      reason = error.message
    }
    if (!rejected || called) throw new Error('stale review receipt was not rejected before private action')
    process.stdout.write(JSON.stringify({ result: 'rejected_before_private_action', reason, privateActionCalled: called }, null, 2) + '\n')
    return
  }
  if (options.mode === '--check') {
    process.stdout.write(JSON.stringify({ result: 'pre-sign bindings current; no private action', bindings: prepared.expected, unsignedVerification: prepared.verify }, null, 2) + '\n')
    return
  }
  await approvedSign(prepared, options.runDir, options.approval)
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  main().catch((error) => {
    process.stderr.write('protected local import signing gate failed: ' + (error?.stack || error) + '\n')
    process.exitCode = 1
  })
}
