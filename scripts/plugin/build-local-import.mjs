import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PLUGIN_ID = 'tuqdev.line-todo.pro'
export const TASK_ID = 'line-todo-release-0.2.14-20261105'
export const TARGET_CORE = '1.8.10'
export const TARGET_PLATFORM = 'win32-x64'
export const AUTHORING_TOOL_CORE = '1.8.10'
export const AUTHORING_TOOL_SHA256 = 'd61a389059e7b1fd6b3c2dc3027342759308d0214492216fc31da3200293cf83'
export const AUTHORING_TOOL_VERSION_TEXT = 'tuq-plugin-tool core 1.8.10'
export const EXPECTED_SIGNER = 'teamuq-root-2026a'
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT_FILE = fileURLToPath(import.meta.url)
const SIGN_SCRIPT = path.join(REPO, 'scripts', 'plugin', 'sign-local-import.mjs')

export const DEFAULT_INSTALLED_ROOT = path.join(os.homedir(), '.teamuq', 'plugins', 'installed', PLUGIN_ID)

const hash = (data) => crypto.createHash('sha256').update(data).digest('hex')
const fileHash = (file) => hash(fs.readFileSync(file))
const quotePs = (value) => "'" + String(value).replaceAll("'", "''") + "'"
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })

export function parseVersion(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error('版號必須是三段數字 x.y.z：' + value)
  }
  return value.split('.').map(Number)
}

export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

export function assertVersionIncrease(target, installed) {
  if (compareVersions(target, installed) <= 0) {
    throw new Error('套件版號必須嚴格高於已安裝版：target=' + target + ', installed=' + installed)
  }
  return true
}

export function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
}

export function assertSafeOutput(input, { repo = REPO, home = os.homedir(), localAppData = process.env.LOCALAPPDATA } = {}) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) throw new Error('--out 必須是絕對路徑')
  const output = path.resolve(input)
  if (isInside(repo, output)) throw new Error('--out 不可位於 LineTodo source tree')
  if (home && isInside(home, output)) throw new Error('--out 不可位於使用者 profile')
  if (localAppData && isInside(localAppData, output)) throw new Error('--out 不可位於 LocalAppData')
  if (output === path.parse(output).root) throw new Error('--out 不可為磁碟根目錄')
  return output
}

export function parseArgs(argv) {
  const options = { dryRun: false, validateOnly: false, help: false }
  const valueFlags = new Map([
    ['--out', 'out'],
    ['--tool', 'tool'],
    ['--core-exe', 'coreExe'],
    ['--installed-manifest', 'installedManifest'],
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--validate-only') options.validateOnly = true
    else if (valueFlags.has(arg)) {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error('缺少 ' + arg + ' 的值')
      options[valueFlags.get(arg)] = value
      index += 1
    } else throw new Error('未知參數：' + arg)
  }
  if (options.dryRun && options.validateOnly) throw new Error('--dry-run 與 --validate-only 不可同時使用')
  return options
}

function spawn(command, args, cwd, encoding = 'utf8') {
  const result = spawnSync(command, args, { cwd, encoding, windowsHide: true, maxBuffer: 1 << 26 })
  if (result.error) throw result.error
  return result
}

function readCoreMetadata(coreExe) {
  if (!fs.existsSync(coreExe)) throw new Error('找不到 Core 執行檔：' + coreExe)
  const ps = "$ErrorActionPreference='Stop'; $v=(Get-Item -LiteralPath " + quotePs(coreExe) + ").VersionInfo; [Console]::Out.Write(($v.FileVersion + '|' + $v.ProductVersion))"
  const result = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], REPO)
  if (result.status !== 0) throw new Error('讀取 Core 檔案版本失敗：' + result.stderr)
  const [fileVersion, productVersion] = result.stdout.split('|')
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.\d+)?$/.exec(fileVersion || '')
  if (!match) throw new Error('Core FileVersion 不是受支援的三段版本：' + fileVersion)
  return {
    executable: coreExe,
    fileVersion,
    productVersion,
    normalizedVersion: match.slice(1, 4).join('.'),
    bytes: fs.statSync(coreExe).size,
    sha256: fileHash(coreExe),
  }
}

export function readInstalledMetadata(manifestPath, explicit = false) {
  const installedRoot = path.dirname(manifestPath)
  if (!fs.existsSync(installedRoot)) {
    if (explicit) throw new Error('指定的已安裝 manifest 不存在：' + manifestPath)
    return { state: 'first-install', version: null, rootPath: installedRoot, manifestPath: null, manifestSha256: null, signer: null }
  }
  if (fs.statSync(installedRoot).isDirectory() && !fs.existsSync(manifestPath)) {
    const manifests = fs.readdirSync(installedRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(installedRoot, entry.name, 'manifest.json'))
      .filter((candidate) => fs.existsSync(candidate))
    if (manifests.length !== 1) throw new Error('安裝資料夾存在但無法唯一識別已安裝版本；拒絕假設 first-install：' + installedRoot)
    manifestPath = manifests[0]
  }
  if (!fs.existsSync(manifestPath)) throw new Error('安裝資料夾存在但 manifest 缺失；拒絕假設 first-install：' + installedRoot)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest.id !== PLUGIN_ID) throw new Error('已安裝 manifest id 不符：' + manifest.id)
  parseVersion(manifest.version)
  if (typeof manifest.trustTier !== 'string' || !Array.isArray(manifest.permissions)) throw new Error('已安裝 manifest 缺少 trustTier 或 permissions baseline')
  return { state: 'installed', rootPath: installedRoot, manifestPath, id: manifest.id, version: manifest.version, trustTier: manifest.trustTier, permissions: manifest.permissions, manifestSha256: fileHash(manifestPath), signer: 'teamuq-root-2026a' }
}

function checkTool(toolPath) {
  if (!toolPath || !path.isAbsolute(toolPath)) throw new Error('請以 --tool 指定已驗證 Core 1.8.10 author CLI 的絕對路徑')
  if (!fs.existsSync(toolPath)) throw new Error('找不到 Core 1.8.10 author CLI：' + toolPath)
  const actualSha = fileHash(toolPath)
  if (actualSha !== AUTHORING_TOOL_SHA256) throw new Error('Core 1.8.10 author CLI SHA-256 不符：' + actualSha)
  const version = spawn(process.execPath, [toolPath, '--version'], REPO)
  const versionText = (version.stdout || '').trim()
  if (version.status !== 0 || versionText !== AUTHORING_TOOL_VERSION_TEXT) throw new Error('author CLI 版號不符：' + versionText)
  return { path: toolPath, version: versionText, sha256: actualSha, builtFromCore: AUTHORING_TOOL_CORE }
}

function loadMetadata(options) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
  const packageLock = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8'))
  if (packageLock.version !== packageJson.version || packageLock.packages?.['']?.version !== packageJson.version) {
    throw new Error('package.json 與 package-lock.json 版號不同')
  }
  parseVersion(packageJson.version)
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const coreExe = path.resolve(options.coreExe || process.env.TEAMUQ_CORE_EXE || path.join(localAppData, 'Programs', 'TeamUQ', 'TeamUQ.exe'))
  const explicitInstalled = Boolean(options.installedManifest || process.env.LINE_TODO_INSTALLED_MANIFEST)
  const installedManifest = path.resolve(options.installedManifest || process.env.LINE_TODO_INSTALLED_MANIFEST || path.join(DEFAULT_INSTALLED_ROOT, 'manifest.json'))
  const toolInput = options.tool || process.env.TUQ_PLUGIN_TOOL_184
  if (!toolInput) throw new Error('請以 --tool 指定 Core 1.8.10 author CLI 路徑')
  const toolPath = path.resolve(toolInput)
  const core = readCoreMetadata(coreExe)
  if (core.normalizedVersion !== TARGET_CORE) throw new Error('目前 Core 為 ' + core.normalizedVersion + '；此 helper 僅支援已核對的 Core ' + TARGET_CORE)
  const installed = readInstalledMetadata(installedManifest, explicitInstalled)
  if (installed.state === 'installed') assertVersionIncrease(packageJson.version, installed.version)
  const tool = checkTool(toolPath)
  return {
    packageVersion: packageJson.version,
    packageJson,
    packageLock,
    core,
    installed,
    tool,
    target: { coreVersion: TARGET_CORE, platform: TARGET_PLATFORM },
  }
}

function runTool(toolPath, args) {
  const result = spawn(process.execPath, [toolPath, ...args], REPO)
  return {
    command: [process.execPath, toolPath, ...args],
    exitCode: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  }
}

function assertCommandOk(result, phase, outDir) {
  if (result.exitCode === 0) return
  writeJson(path.join(outDir, phase + '-failed.json'), { phase, ...result })
  throw new Error('Core author CLI ' + phase + ' exit ' + result.exitCode + ': ' + result.stderr)
}

export function enumerateStage(stageDir) {
  const rows = []
  const visit = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) throw new Error('stage 內禁止 symlink：' + file)
      const relative = prefix ? prefix + '/' + entry.name : entry.name
      if (entry.isDirectory()) visit(file, relative)
      else if (entry.isFile()) {
        const data = fs.readFileSync(file)
        rows.push({ path: relative.replaceAll('\\', '/'), bytes: data.length, sha256: hash(data) })
      } else throw new Error('stage 有非一般檔案：' + file)
    }
  }
  visit(stageDir, '')
  return rows.sort((a, b) => a.path.localeCompare(b.path))
}

function gitStatusEntries() {
  const result = spawn('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], REPO, 'buffer')
  if (result.status !== 0) throw new Error('無法列出 tracked/untracked dirty paths：' + result.stderr.toString('utf8'))
  const records = result.stdout.toString('utf8').split('\0').filter(Boolean)
  const entries = records.map((record) => {
    if (record.length < 4 || record[2] !== ' ') throw new Error('git status porcelain record 無法解析')
    const statusCode = record.slice(0, 2)
    if (statusCode.includes('R') || statusCode.includes('C')) throw new Error('source identity 暫不接受 rename/copy dirty path：' + record.slice(3))
    const dirtyKind = statusCode === '??' ? 'untracked' : 'tracked'
    return { path: record.slice(3), statusCode, dirtyKind }
  })
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

export function sourceIdentity() {
  const statusEntries = gitStatusEntries()
  if (statusEntries.length) throw new Error('建置來源必須是乾淨的 committed worktree；發現未提交路徑：' + statusEntries.map((entry) => entry.path).join(', '))
  const head = spawn('git', ['rev-parse', 'HEAD'], REPO)
  const tree = spawn('git', ['rev-parse', 'HEAD^{tree}'], REPO)
  if (head.status !== 0 || tree.status !== 0) throw new Error('無法讀取 committed source identity')
  const files = ['.gitignore', 'package.json', 'package-lock.json', 'scripts/plugin/build-plugin.mjs', 'scripts/plugin/build-local-import.mjs', 'scripts/plugin/sign-local-import.mjs']
  return {
    state: 'clean-committed-tree',
    repository: REPO,
    head: head.stdout.trim(),
    tree: tree.stdout.trim(),
    status: [],
    files: Object.fromEntries(files.map((name) => [name, fileHash(path.join(REPO, name))])),
  }
}

function writeBuildEvidence(outDir, data) {
  const evidenceDir = path.join(outDir, 'build-evidence')
  fs.mkdirSync(evidenceDir, { recursive: true })
  writeJson(path.join(evidenceDir, 'metafile-backend.json'), data.backendMetafile)
  writeJson(path.join(evidenceDir, 'metafiles-ui.json'), data.uiMetafiles)
  writeJson(path.join(evidenceDir, 'analysis-backend.json'), data.backendAnalysis)
  writeJson(path.join(evidenceDir, 'analysis-ui.json'), data.uiAnalysis)
}

export async function runBuild(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    process.stdout.write('用法：npm run import:local -- --tool <Core1.8.10 CLI> [--installed-manifest <目前安裝 manifest>] --out <新輸出目錄> [--dry-run|--validate-only] [--core-exe <TeamUQ.exe>]\n')
    return { status: 'help' }
  }
  const metadata = loadMetadata(options)
  if (options.dryRun) {
    const result = { status: 'dry-run-ready', pluginId: PLUGIN_ID, targetVersion: metadata.packageVersion, installed: metadata.installed, core: metadata.core, authoringTool: metadata.tool, compatibilityTarget: metadata.target, writesFiles: false, privateActions: false }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    return result
  }
  const outputInput = options.out || process.env.LINE_TODO_LOCAL_IMPORT_OUT
  if (!outputInput) throw new Error('完整輸出目錄必須以 --out 或 LINE_TODO_LOCAL_IMPORT_OUT 指定')
  const outDir = assertSafeOutput(outputInput)
  if (fs.existsSync(outDir)) throw new Error('輸出目錄已存在，請提供新的 task-owned 路徑：' + outDir)
  fs.mkdirSync(outDir, { recursive: true })
  const runToolPath = path.join(outDir, 'tool', 'tuq-plugin-tool.mjs')
  fs.mkdirSync(path.dirname(runToolPath), { recursive: true })
  fs.copyFileSync(metadata.tool.path, runToolPath, fs.constants.COPYFILE_EXCL)
  if (fileHash(runToolPath) !== AUTHORING_TOOL_SHA256) throw new Error('run-owned author CLI copy hash mismatch')
  metadata.tool.path = runToolPath
  const sourceBeforeBuild = sourceIdentity()
  const workDir = path.join(outDir, 'work')
  const stageDir = path.join(outDir, 'stage')
  const overridesFile = path.join(outDir, 'overrides.json')
  const artifact = path.join(outDir, PLUGIN_ID + '-' + metadata.packageVersion + '-win32-x64.unsigned.tuqplugin')
  const builder = await import(pathToFileURL(path.join(REPO, 'scripts', 'plugin', 'build-plugin.mjs')).href)
  const manifestLib = await import(pathToFileURL(path.join(REPO, 'scripts', 'plugin', 'lib', 'manifest.mjs')).href)
  const { files, backendAnalysis, uiAnalysis, backendMetafile, uiMetafiles } = await builder.collectPackageFiles({ workDir })
  if (!backendAnalysis.ok || !uiAnalysis.ok) throw new Error('LineTodo UI/backend bundle analysis rejected')
  const manifest = manifestLib.buildManifest({ version: metadata.packageVersion })
  if (manifest.id !== PLUGIN_ID || manifest.version !== metadata.packageVersion) throw new Error('manifest identity/version 與 package metadata 不一致')
  if (manifest.trustTier !== 'full-trust' || manifest.permissions.length !== 7 || JSON.stringify(manifest.permissions) !== JSON.stringify(['ui:view', 'backend:invoke', 'native:addons', 'ai:chat', 'assets:plugin-data', 'program:data:projects:write', 'program:data:tasks:write'])) {
    throw new Error('candidate trustTier 或 7 個 permissions 與已核准的 full-trust baseline 不完全相同')
  }
  if (metadata.installed.state === 'installed' && (manifest.trustTier !== metadata.installed.trustTier || JSON.stringify(manifest.permissions) !== JSON.stringify(metadata.installed.permissions))) {
    throw new Error('candidate trustTier 或 permissions 與目前安裝 baseline 不完全相同')
  }
  builder.writeStage(stageDir, manifest, files)
  const overrides = builder.kindOverrides(files)
  writeJson(overridesFile, overrides)
  writeBuildEvidence(outDir, { backendMetafile, uiMetafiles, backendAnalysis, uiAnalysis })
  const stageRows = enumerateStage(stageDir)
  const stageIndex = {
    pluginId: PLUGIN_ID,
    version: metadata.packageVersion,
    stage: stageDir,
    manifestSha256: fileHash(path.join(stageDir, 'manifest.json')),
    overridesSha256: fileHash(overridesFile),
    files: stageRows,
  }
  const stageIndexPath = path.join(outDir, 'stage-index.json')
  writeJson(stageIndexPath, stageIndex)
  const source = sourceIdentity()
  if (JSON.stringify(source) !== JSON.stringify(sourceBeforeBuild)) throw new Error('committed source HEAD/tree 在建置期間改變；候選已停止輸出 review request')
  const sourcePath = path.join(outDir, 'source-identity.json')
  writeJson(sourcePath, source)
  const sourceIdentitySha256 = fileHash(sourcePath)
  const common = ['--core-version', TARGET_CORE, '--platform', TARGET_PLATFORM]
  const validate = runTool(metadata.tool.path, ['validate', stageDir, '--json', ...common])
  assertCommandOk(validate, 'validate', outDir)
  if (options.validateOnly) {
    const result = { status: 'stage-validated-only', pluginId: PLUGIN_ID, version: metadata.packageVersion, target: metadata.target, tool: metadata.tool, stageIndex: stageIndexPath, commands: [validate], privateActions: false }
    writeJson(path.join(outDir, 'validate-result.json'), result)
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    return result
  }
  const pack = runTool(metadata.tool.path, ['pack', stageDir, '--unsigned', '--out', artifact, '--overrides', overridesFile, ...common])
  assertCommandOk(pack, 'pack', outDir)
  const verify = runTool(metadata.tool.path, ['verify', artifact, '--anchors', 'core', ...common])
  assertCommandOk(verify, 'verify', outDir)
  const verified = JSON.parse(verify.stdout)
  if (verified.id !== PLUGIN_ID || verified.version !== metadata.packageVersion || verified.signer?.kind !== 'unsigned') {
    throw new Error('Core verify 回傳的套件 ID／版號／簽署狀態不符')
  }
  const artifactHash = fileHash(artifact)
  const preflight = {
    taskId: TASK_ID,
    pluginId: PLUGIN_ID,
    version: metadata.packageVersion,
    installed: metadata.installed,
    core: metadata.core,
    authoringTool: metadata.tool,
    target: metadata.target,
    securityBaseline: { previousSigner: EXPECTED_SIGNER, trustTier: manifest.trustTier, permissions: manifest.permissions },
    signer: verified.signer,
    integritySha256: verified.integritySha256,
    unsignedArtifact: { path: artifact, bytes: fs.statSync(artifact).size, sha256: artifactHash },
    stageIndex: { path: stageIndexPath, sha256: fileHash(stageIndexPath) },
    sourceIdentity: { path: sourcePath, sha256: sourceIdentitySha256 },
    commands: [validate, pack, verify],
    import: { state: 'not-imported', nextStep: '待 Reviewer 審核並取得相符簽章收據；簽章驗證完成後才由 Core 1.8.10 UI 選檔安裝' },
  }
  const preflightPath = path.join(outDir, 'pre-sign-preflight.json')
  writeJson(preflightPath, preflight)
  const request = {
    taskId: TASK_ID,
    status: 'pending_independent_reviewer',
    pluginId: PLUGIN_ID,
    version: metadata.packageVersion,
    sourceCommit: source.head,
    sourceTree: source.tree,
    installedState: metadata.installed.state,
    installedState: metadata.installed.state,
    installedVersion: metadata.installed.version,
    target: metadata.target,
    authoringTool: { version: metadata.tool.version, sha256: metadata.tool.sha256, builtFromCore: metadata.tool.builtFromCore },
    signerExpected: EXPECTED_SIGNER,
    security: { trustTier: manifest.trustTier, permissions: manifest.permissions, previousSigner: EXPECTED_SIGNER },
    artifact: preflight.unsignedArtifact,
    integritySha256: verified.integritySha256,
    stageIndexSha256: fileHash(stageIndexPath),
    preflightSha256: fileHash(preflightPath),
    sourceIdentitySha256,
    reviewNotes: [
      '此檔是未簽章 package，尚不可匯入。',
      '請核對本 request、preflight、stage index、source identity、authoring tool 與 unsigned archive 的 hash。',
      'Reviewer 收據需含 status=approved、reviewer、approvedAt 與下方 bindings；不得沿用任何舊收據。',
    ],
    receiptSchema: { status: 'approved', reviewer: '<獨立 Reviewer>', approvedAt: '<ISO-8601>', bindings: '<與 pre-sign-bindings.json 完全相等>' },
  }
  const requestPath = path.join(outDir, 'pre-sign-review-request.json')
  writeJson(requestPath, request)
  const bindings = {
    task_id: request.taskId,
    plugin_id: PLUGIN_ID,
    version: metadata.packageVersion,
    installed_state: metadata.installed.state,
    installed_version: metadata.installed.version,
    platform: TARGET_PLATFORM,
    source_identity_sha256: sourceIdentitySha256,
    request_sha256: fileHash(requestPath),
    wrapper_sha256: fileHash(SIGN_SCRIPT),
    devkit_sha256: metadata.tool.sha256,
    stage_index_sha256: fileHash(stageIndexPath),
    unsigned_archive_sha256: artifactHash,
    unsigned_integrity_sha256: verified.integritySha256,
    preflight_sha256: fileHash(preflightPath),
    core_version: TARGET_CORE,
    devkit_built_from_core: metadata.tool.builtFromCore,
  }
  const bindingsPath = path.join(outDir, 'pre-sign-bindings.json')
  writeJson(bindingsPath, bindings)
  const result = {
    status: 'unsigned_package_verified_pending_reviewer',
    pluginId: PLUGIN_ID,
    version: metadata.packageVersion,
    target: metadata.target,
    signer: verified.signer,
    integritySha256: verified.integritySha256,
    unsignedArtifact: preflight.unsignedArtifact,
    reviewRequest: { path: requestPath, sha256: fileHash(requestPath) },
    bindings: { path: bindingsPath, sha256: fileHash(bindingsPath) },
    preflight: preflightPath,
    sourceIdentity: sourcePath,
    stageIndex: stageIndexPath,
    commands: [validate, pack, verify],
    manualImport: '尚未簽章，勿匯入；完成獨立 Reviewer 核准與受保護簽章後，使用 Core UI > 我的 AI > 外掛 > 更多與進階 > 從檔案安裝。',
  }
  writeJson(path.join(outDir, 'build-result.json'), result)
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  runBuild().catch((error) => {
    process.stderr.write('local import build failed: ' + (error?.stack || error) + '\n')
    process.exitCode = 1
  })
}
