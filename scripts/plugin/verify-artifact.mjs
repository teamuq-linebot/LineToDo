// Verifies a built .tuqplugin the way TeamUQ 1.6.8 installs one, using the REAL validators of the pinned release commit (b8b96cb3, extracted with `git archive`):
//   reviewArtifact (packages/platform/plugin-artifact/src/install/reviewArtifact.ts):
//     file extension + size limit -> zip structure / entry names / ratio (zip/zipReader.ts) -> signature.json + integrity.json read ->
//     verifyIntegritySignature (trust/signature.ts, ed25519 over the exact integrity.json bytes, dev key looked up in a DevKeyStore) ->
//     parseIntegrity + assertCoverage (integrity.ts) -> manifest sha256 vs integrity -> PluginManifestV2Schema (plugin-sdk manifestV2.ts) ->
//     evaluateManifestSupport({ coreVersion: 1.6.8, win32-x64 }) -> auditNativeContent (native whitelist, .wasm is not native) ->
//     every file extracted + sha256/size compared + native magic check -> icon is a PNG within PLUGIN_ICON_MAX_BYTES.
// It runs entirely in a temporary directory: a fresh DevKeyStore (the shipped dev-e6301dd7a2967155.pub is the only key in it), no TeamUQ profile, no install.
// Then it audits the package content (no .ps1, no better-sqlite3-multiple-ciphers, no private key, no standalone better-sqlite3 11.x).
//
//   node scripts/plugin/verify-artifact.mjs [file.tuqplugin] [--pub <dev-key.pub>] [--core 1.6.8] [--report <file.json>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { DEV_KEY_ID, DIST, ROOT, TE_COMMIT, WORK } from './lib/paths.mjs'
import { devKeySecretNeedles, parseArgs, sha256Hex } from './lib/pack.mjs'
import { loadTeValidators } from './lib/te-snapshot.mjs'
import { auditPackage } from './lib/audit.mjs'
import { PLUGIN_ID, PLATFORM_ID } from './lib/manifest.mjs'
import { PINNED_NATIVE } from './build-plugin.mjs'

const TAR = process.platform === 'win32' ? 'C:/Windows/System32/tar.exe' : 'tar'
const DEFAULT_PUB = 'C:/teamuq/teamuq-plugins/_install/windows/dev-e6301dd7a2967155.pub'

function walk(dir, base = dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, base))
    else out.push({ path: path.relative(base, full).split(path.sep).join('/'), data: fs.readFileSync(full) })
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1))
}

/** sha256 of the STANDALONE app's better-sqlite3 11.x and better-sqlite3-multiple-ciphers binaries (this worktree and the main checkout), which must never be in the package. */
function standaloneBinaries() {
  const common = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' })
  const mainTree = common.status === 0 ? path.dirname(path.resolve(ROOT, common.stdout.trim())) : null
  const found = []
  for (const base of [ROOT, mainTree]) {
    if (!base) continue
    for (const pkg of ['better-sqlite3', 'better-sqlite3-multiple-ciphers']) {
      const file = path.join(base, 'node_modules', pkg, 'build', 'Release', 'better_sqlite3.node')
      if (fs.existsSync(file)) found.push({ pkg, file: file.split(path.sep).join('/'), sha256: sha256Hex(fs.readFileSync(file)) })
    }
  }
  return found
}

export async function verifyArtifact({ file, pubFile = DEFAULT_PUB, coreVersion = '1.6.8' }) {
  const { sdk, artifact } = await loadTeValidators()
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'line-todo-verify-'))
  const result = { teCommit: TE_COMMIT, file: path.basename(file), coreVersion, platform: PLATFORM_ID, steps: {}, ok: false, problems: [] }
  try {
    const bytes = fs.readFileSync(file)
    result.bytes = bytes.length
    result.sha256 = sha256Hex(bytes)
    result.limits = { ...artifact.PLUGIN_ARTIFACT_LIMITS }

    // the dev key: the public file the user imports, in a throwaway DevKeyStore
    const pluginsRoot = path.join(sandbox, 'plugins')
    fs.mkdirSync(pluginsRoot, { recursive: true })
    const devKeys = artifact.createDevKeyStore({ pluginsRoot })
    const pubText = fs.readFileSync(pubFile, 'utf8')
    const candidate = devKeys.inspect(pubText)
    result.steps.devKeyFile = { file: pubFile, keyId: candidate.keyId, fingerprint: candidate.fingerprint }
    if (candidate.keyId !== DEV_KEY_ID) throw new Error(`${pubFile} is ${candidate.keyId}, expected ${DEV_KEY_ID}`)
    await devKeys.add({ publicKey: pubText, label: 'line-todo verify' })

    // the official review (zip + integrity + signature + manifest + support + native + icon)
    const staged = await artifact.reviewArtifact(file, {
      pluginsRoot,
      anchors: artifact.TEAMUQ_TRUST_ANCHORS,
      devKeys,
      support: { coreVersion, platform: { id: PLATFORM_ID, osVersion: '10.0.26200' } },
      findInstalled: async () => null,
    })
    try {
      result.steps.reviewArtifact = {
        passed: true,
        signer: staged.signer,
        manifestSha256: staged.manifestSha256,
        integritySha256: staged.integritySha256,
        totalBytes: staged.totalBytes,
        fileCount: staged.fileCount,
        manifestId: staged.manifest.id,
        manifestVersion: staged.manifest.version,
      }
      const integrity = artifact.parseIntegrity(fs.readFileSync(path.join(staged.payloadDir, 'integrity.json')))
      result.steps.integrity = integrity.files.map((entry) => ({ path: entry.path, size: entry.size, kind: entry.kind, platform: entry.platform }))
      result.sizes = { archiveBytes: bytes.length, entries: integrity.files.length + 2, declaredUncompressed: integrity.files.reduce((total, entry) => total + entry.size, 0) }
      result.steps.limitsOk =
        result.sizes.archiveBytes <= artifact.PLUGIN_ARTIFACT_LIMITS.maxArchiveBytes &&
        result.sizes.declaredUncompressed <= artifact.PLUGIN_ARTIFACT_LIMITS.maxTotalUncompressedBytes &&
        result.sizes.entries <= artifact.PLUGIN_ARTIFACT_LIMITS.maxEntries
      // the validators again, standalone, on the staged manifest (what check-manifest reports)
      const parsed = sdk.PluginManifestV2Schema.safeParse(staged.manifest)
      result.steps.schema = { ok: parsed.success }
      result.steps.support = sdk.evaluateManifestSupport(parsed.data, { coreVersion, platform: { id: PLATFORM_ID, osVersion: '10.0.26200' } })
      result.manifest = staged.manifest
    } finally {
      await staged.discard()
    }

    // negative controls with the same validators: a tampered byte and a wrong core version must be refused (the verifier is not vacuous)
    const tampered = Buffer.from(bytes)
    tampered[Math.floor(tampered.length / 2)] ^= 0xff
    const tamperedFile = path.join(sandbox, 'tampered.tuqplugin')
    fs.writeFileSync(tamperedFile, tampered)
    const refuse = async (label, run) => {
      try { await run(); result.steps[label] = { refused: false } } catch (error) { result.steps[label] = { refused: true, code: error.code ?? String(error.message).slice(0, 80) } }
    }
    await refuse('negativeTamperedBytes', () => artifact.reviewArtifact(tamperedFile, { pluginsRoot, anchors: artifact.TEAMUQ_TRUST_ANCHORS, devKeys, support: { coreVersion, platform: { id: PLATFORM_ID, osVersion: '10.0.26200' } }, findInstalled: async () => null }))
    await refuse('negativeCore167', () => artifact.reviewArtifact(file, { pluginsRoot, anchors: artifact.TEAMUQ_TRUST_ANCHORS, devKeys, support: { coreVersion: '1.6.7', platform: { id: PLATFORM_ID, osVersion: '10.0.26200' } }, findInstalled: async () => null }))
    const emptyKeys = artifact.createDevKeyStore({ pluginsRoot: path.join(sandbox, 'empty-plugins') })
    await refuse('negativeUnknownSigner', () => artifact.reviewArtifact(file, { pluginsRoot, anchors: artifact.TEAMUQ_TRUST_ANCHORS, devKeys: emptyKeys, support: { coreVersion, platform: { id: PLATFORM_ID, osVersion: '10.0.26200' } }, findInstalled: async () => null }))

    // the content audit, on the unpacked zip (every entry, including manifest / integrity / signature)
    const unpacked = path.join(sandbox, 'unpacked')
    fs.mkdirSync(unpacked, { recursive: true })
    const untar = spawnSync(TAR, ['-xf', file, '-C', unpacked], { encoding: 'utf8' })
    if (untar.status !== 0) throw new Error(`cannot unpack: ${untar.stderr}`)
    const entries = walk(unpacked)
    const standalone = standaloneBinaries()
    const allowedNative = Object.fromEntries((result.manifest?.native?.files ?? []).map((entry) => [entry.path, entry.path.endsWith('koffi.node') ? PINNED_NATIVE.koffi.sha256 : PINNED_NATIVE.betterSqlite3.sha256]))
    const audit = auditPackage(entries, {
      allowedNative,
      standalone11Sha256: standalone.map((entry) => entry.sha256),
      secretNeedles: devKeySecretNeedles(),
    })
    result.steps.audit = { ok: audit.ok, problems: audit.problems, natives: audit.natives, entryCount: audit.listing.length, standalone11Compared: standalone, secretNeedlesChecked: devKeySecretNeedles().length }
    result.entries = audit.listing
    result.problems.push(...audit.problems)

    const failedNegatives = ['negativeTamperedBytes', 'negativeCore167', 'negativeUnknownSigner'].filter((label) => result.steps[label]?.refused !== true)
    for (const label of failedNegatives) result.problems.push(`${label}: the validator did not refuse`)
    if (result.steps.limitsOk !== true) result.problems.push('package size is outside the 1.6.8 limits')
    if (result.steps.support.length > 0) result.problems.push(`support issues: ${JSON.stringify(result.steps.support)}`)
    if (result.manifest?.id !== PLUGIN_ID) result.problems.push('unexpected plugin id')
    result.ok = result.problems.length === 0
  } catch (error) {
    result.ok = false
    result.problems.push(`${error.code ?? 'error'}: ${error.message}`)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const args = parseArgs(process.argv.slice(2))
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  const file = path.resolve(args._[0] ?? path.join(DIST, `${PLUGIN_ID}-${version}-win.tuqplugin`))
  const result = await verifyArtifact({ file, pubFile: args.pub ? String(args.pub) : DEFAULT_PUB, coreVersion: String(args.core ?? '1.6.8') })
  const text = JSON.stringify(result, null, 2)
  if (args.report) fs.writeFileSync(path.resolve(String(args.report)), text)
  fs.mkdirSync(WORK, { recursive: true })
  console.log(text)
  process.exit(result.ok ? 0 : 1)
}
