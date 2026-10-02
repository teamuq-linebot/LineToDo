// Builds the DEVELOPMENT-KEY-SIGNED variant of the line-todo plugin package, for machines that already run 0.1.1 on TeamUQ 1.6.8.
//
//   npm run build:plugin && npm run build:plugin-devsigned
//   node scripts/plugin/build-plugin-devsigned.mjs [--from <unsigned .tuqplugin>] [--out <dir>]
//
// Why a variant: 0.1.1 was signed with the shared development key dev-e6301dd7a2967155. Core only updates a dev-signed plugin in place with a
// package signed by the SAME dev key (updatePolicy.ts assertUpdateAllowed → otherwise `signer_changed`), and TeamUQ 1.6.8 cannot read an
// unsigned package at all (reviewArtifact.ts → `signature_missing`). The default package (build-plugin.mjs, `pack --unsigned`, minCoreVersion
// >=1.7.1) stays exactly what it is; this script only RE-SIGNS it.
//
// Input: the unsigned package `npm run build:plugin` wrote (default dist/plugin-package/<id>-<version>-win.tuqplugin). Chain:
//   1. the official author tool (vendor/tuq-plugin-tool.mjs, 1.7.1) `verify`s the input: an unsigned package of this plugin and version;
//   2. it is unpacked and every file is checked against its integrity.json entry (size + sha256);
//   3. a stage directory gets every file of the input BYTE FOR BYTE, except manifest.json, in which only `minCoreVersion` changes
//      (MIN_CORE_VERSION → DEV_SIGNED_MIN_CORE_VERSION, lib/manifest.mjs; same JSON layout, nothing else moves);
//   4. the official tool `validate`s the stage (Core 1.7.1, win32-x64);
//   5. TeamUQ 1.6.8's own authoring packer — packArtifact of teamuq-electron @ b8b96cb3 (packages/platform/plugin-artifact/src/authoring/,
//      loaded read-only with git archive, lib/te-snapshot.mjs) — writes integrity.json (each file's kind / platform restated from the input's
//      integrity.json, so they stay identical), signs it with the development key, and runs Core 1.6.8's reviewArtifact on the result before the
//      file is written.
// Why not `tuq-plugin-tool pack --key`: the 1.7.1 tool accepts only an ENCRYPTED PKCS8 PEM plus a passphrase typed at a prompt; the development key
// is a plain PKCS8 file, and converting it would make a second copy of the private key. packArtifact takes the key as an in-memory KeyObject.
// The private key is never printed, logged or written (only its file PATH appears in the build report).
//
// Output: <out>/<id>-<version>-win-devsigned.tuqplugin and <file>.build.json (default out: dist/plugin-package-devsigned).
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DEV_KEY_FILE, DEV_KEY_ID, DEV_PUB_FILE, DIST, DIST_DEVSIGNED, ROOT, TE_COMMIT } from './lib/paths.mjs'
import { parseArgs, sha256Hex } from './lib/pack.mjs'
import { DEV_SIGNED_MIN_CORE_VERSION, MIN_CORE_VERSION, PLATFORM_ID, PLUGIN_ID } from './lib/manifest.mjs'
import { assertToolIntact, validateStage, verifyPackage } from './lib/tuqTool.mjs'
import { loadTe168 } from './lib/te-snapshot.mjs'
import { loadDevSigningKey } from './lib/devKey.mjs'

const TAR = process.platform === 'win32' ? 'C:/Windows/System32/tar.exe' : 'tar'
export const DEVSIGNED_SUFFIX = '-devsigned'
/** TeamUQ 1.6.8 on this machine's Windows build: the Core every review in this script stands for. */
export const CORE_168 = Object.freeze({ coreVersion: '1.6.8', platform: Object.freeze({ id: PLATFORM_ID, osVersion: '10.0.26200' }) })
const GENERATED = new Set(['integrity.json', 'signature.json', 'delegation.json'])

const toolRun = (run) => ({ command: run.command, exit: run.exit, stdout: run.json ?? run.stdout.trim(), stderr: run.stderr.trim() })

export const unsignedFileName = (version) => `${PLUGIN_ID}-${version}-win.tuqplugin`
export const devsignedFileName = (version) => `${PLUGIN_ID}-${version}-win${DEVSIGNED_SUFFIX}.tuqplugin`

function walk(dir, base = dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, base))
    else out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out.sort()
}

/** Unpacks a .tuqplugin into `dir` (emptied first) and returns { manifestText, manifest, integrity, entries } after checking every listed file. */
export function unpackChecked(file, dir) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const untar = spawnSync(TAR, ['-xf', file, '-C', dir], { encoding: 'utf8' })
  if (untar.status !== 0) throw new Error(`cannot unpack ${file}: ${untar.stderr}`)
  const entries = walk(dir)
  const integrity = JSON.parse(fs.readFileSync(path.join(dir, 'integrity.json'), 'utf8'))
  const listed = new Set(integrity.files.map((entry) => entry.path))
  for (const entry of integrity.files) {
    const data = fs.readFileSync(path.join(dir, ...entry.path.split('/')))
    if (data.length !== entry.size || sha256Hex(data) !== entry.sha256) throw new Error(`${file}: ${entry.path} differs from its integrity.json entry`)
  }
  const unlisted = entries.filter((name) => !listed.has(name) && !GENERATED.has(name))
  if (unlisted.length > 0) throw new Error(`${file}: files outside integrity.json: ${unlisted.join(', ')}`)
  const manifestText = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')
  return { manifestText, manifest: JSON.parse(manifestText), integrity, entries }
}

/** The input's manifest with ONLY minCoreVersion changed, in the same JSON layout (throws if the layout would move anything else). */
export function rewriteMinCoreVersion(manifestText, to = DEV_SIGNED_MIN_CORE_VERSION) {
  const manifest = JSON.parse(manifestText)
  if (`${JSON.stringify(manifest, null, 2)}\n` !== manifestText) throw new Error('manifest.json is not in the layout writeStage produces (JSON.stringify(…, null, 2) + LF)')
  if (manifest.minCoreVersion !== MIN_CORE_VERSION) throw new Error(`manifest.json minCoreVersion is ${manifest.minCoreVersion}, expected ${MIN_CORE_VERSION}`)
  const next = { ...manifest, minCoreVersion: to }
  const text = `${JSON.stringify(next, null, 2)}\n`
  const changed = Object.keys(next).filter((key) => JSON.stringify(next[key]) !== JSON.stringify(manifest[key]))
  if (changed.length !== 1 || changed[0] !== 'minCoreVersion') throw new Error(`unexpected manifest change: ${changed.join(', ')}`)
  return { text, manifest: next, change: { field: 'minCoreVersion', from: manifest.minCoreVersion, to } }
}

/** A DevKeyStore (Core 1.6.8 / 1.7.1 code) under `pluginsRoot` that trusts the public key file users import. */
export async function trustedDevKeys(core, pluginsRoot, pubFile = DEV_PUB_FILE) {
  fs.mkdirSync(pluginsRoot, { recursive: true })
  const devKeys = core.createDevKeyStore({ pluginsRoot })
  const pubText = fs.readFileSync(pubFile, 'utf8')
  const candidate = devKeys.inspect(pubText)
  if (candidate.keyId !== DEV_KEY_ID) throw new Error(`${pubFile} is ${candidate.keyId}, expected ${DEV_KEY_ID}`)
  await devKeys.add({ publicKey: pubText, label: 'line-todo devsigned build' })
  return { devKeys, pub: { file: pubFile, keyId: candidate.keyId, fingerprint: candidate.fingerprint } }
}

/**
 * Re-signs `from` (the unsigned package) into `outDir`. `signer` defaults to the development key; tests / negative controls pass another
 * { keyId, key } together with a `devKeys` store that trusts it. Returns { file, zip, report }.
 */
export async function buildDevsigned({ from, outDir = DIST_DEVSIGNED, outName, signer, devKeys: givenDevKeys, verifySource = true } = {}) {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  const source = path.resolve(from ?? path.join(DIST, unsignedFileName(version)))
  const name = outName ?? devsignedFileName(version)
  const work = path.join(outDir, '.work')
  const stageDir = path.join(outDir, `stage${name === devsignedFileName(version) ? '' : `-${path.basename(name, '.tuqplugin')}`}`)
  const overridesFile = path.join(outDir, `overrides${name === devsignedFileName(version) ? '' : `-${path.basename(name, '.tuqplugin')}`}.json`)
  const file = path.join(outDir, name)
  fs.mkdirSync(outDir, { recursive: true })
  const tool = assertToolIntact()
  const sourceBytes = fs.readFileSync(source)
  const report = {
    file: name,
    pluginId: PLUGIN_ID,
    version,
    source: { file: path.relative(ROOT, source).split(path.sep).join('/'), bytes: sourceBytes.length, sha256: sha256Hex(sourceBytes) },
    tool: { ...tool, file: path.relative(ROOT, tool.file).split(path.sep).join('/') },
    packer: { from: `teamuq-electron ${TE_COMMIT} (TeamUQ 1.6.8) packages/platform/plugin-artifact/src/authoring/packArtifact.ts`, review: CORE_168 },
  }

  // 1. the input is the official unsigned package of this plugin and version
  if (verifySource) {
    const verified = verifyPackage(source)
    report.source.verify = toolRun(verified)
    if (verified.exit !== 0) throw new Error(`the input is not accepted by tuq-plugin-tool verify (exit ${verified.exit}): ${verified.stderr.trim()}`)
    if (verified.json?.signer?.kind !== 'unsigned' || verified.json?.id !== PLUGIN_ID || verified.json?.version !== version) {
      throw new Error(`the input is not the unsigned ${PLUGIN_ID} ${version}: ${JSON.stringify({ id: verified.json?.id, version: verified.json?.version, signer: verified.json?.signer })}`)
    }
  }

  // 2. + 3. unpack, check, stage (byte for byte; manifest.json: minCoreVersion only)
  const unpacked = unpackChecked(source, path.join(work, 'unsigned'))
  if (unpacked.entries.some((entry) => entry === 'signature.json' || entry === 'delegation.json')) throw new Error('the input already carries a signature')
  const rewritten = rewriteMinCoreVersion(unpacked.manifestText)
  report.manifestChange = rewritten.change
  fs.rmSync(stageDir, { recursive: true, force: true })
  for (const entry of unpacked.integrity.files) {
    const target = path.join(stageDir, ...entry.path.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (entry.path === 'manifest.json') fs.writeFileSync(target, rewritten.text)
    else fs.copyFileSync(path.join(work, 'unsigned', ...entry.path.split('/')), target)
  }
  const overrides = unpacked.integrity.files
    .filter((entry) => entry.path !== 'manifest.json')
    .map((entry) => ({ path: entry.path, kind: entry.kind, ...(entry.platform === null ? {} : { platform: entry.platform }) }))
  fs.writeFileSync(overridesFile, `${JSON.stringify(overrides, null, 2)}\n`)

  // 4. the official tool validates the stage
  const validated = validateStage(stageDir)
  report.validate = toolRun(validated)
  if (validated.exit !== 0) throw new Error(`tuq-plugin-tool validate failed (exit ${validated.exit}): ${validated.stderr.trim()}`)

  // 5. Core 1.6.8's packer signs; Core 1.6.8's reviewArtifact accepts it before the file is written
  const core = await loadTe168({ workDir: work })
  const reviewRoot = fs.mkdtempSync(path.join(work, 'review-'))
  try {
    let devKeys = givenDevKeys
    if (devKeys === undefined) {
      const trusted = await trustedDevKeys(core, path.join(reviewRoot, 'plugins'))
      devKeys = trusted.devKeys
      report.devPubFile = trusted.pub
    }
    const key = signer ?? loadDevSigningKey()
    report.signer = { kind: 'dev', keyId: key.keyId, keyFile: signer === undefined ? DEV_KEY_FILE : '(given in memory)' } // the PATH only
    fs.rmSync(file, { force: true })
    const packed = await core.packArtifact({
      stageDir,
      outFile: file,
      signer: { keyId: key.keyId, key: key.key },
      files: overrides,
      review: { anchors: core.TEAMUQ_TRUST_ANCHORS, support: CORE_168, devKeys, workDir: reviewRoot },
    })
    const zip = fs.readFileSync(file)
    report.bytes = zip.length
    report.sha256 = sha256Hex(zip)
    if (packed.sha256 !== report.sha256) throw new Error(`packArtifact reported ${packed.sha256}, the file has ${report.sha256}`)
    report.review168 = {
      passed: true,
      signer: packed.verified.signer,
      manifestSha256: packed.verified.manifestSha256,
      integritySha256: packed.verified.integritySha256,
      fileCount: packed.verified.fileCount,
      totalBytes: packed.verified.totalBytes,
      minCoreVersion: packed.verified.manifest.minCoreVersion,
    }
    report.files = Object.fromEntries(unpacked.integrity.files.map((entry) => [entry.path, entry.path === 'manifest.json'
      ? { size: Buffer.byteLength(rewritten.text), sha256: sha256Hex(Buffer.from(rewritten.text)), kind: entry.kind, changed: 'minCoreVersion' }
      : { size: entry.size, sha256: entry.sha256, kind: entry.kind, ...(entry.platform === null ? {} : { platform: entry.platform }) }]))
    return { file, zip, report }
  } finally {
    fs.rmSync(reviewRoot, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  const outDir = path.resolve(ROOT, args.out ? String(args.out) : DIST_DEVSIGNED)
  const built = await buildDevsigned({ from: args.from ? path.resolve(String(args.from)) : undefined, outDir })
  fs.writeFileSync(`${built.file}.build.json`, JSON.stringify(built.report, null, 2))
  console.error(`${built.report.file}  ${(built.zip.length / 1024).toFixed(1)} KiB  sha256 ${built.report.sha256}  signer ${built.report.signer.keyId}  minCoreVersion ${built.report.manifestChange.to}  (from ${built.report.source.file} sha256 ${built.report.source.sha256}; validate exit ${built.report.validate.exit}; Core 1.6.8 review passed)`)
}
