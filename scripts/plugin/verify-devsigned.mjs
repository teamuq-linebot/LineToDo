// Verifies the dev-signed variant (build-plugin-devsigned.mjs) the way TeamUQ installs and updates it, on TeamUQ 1.6.8 AND on 1.7.1:
//
//   npm run verify:plugin-devsigned [-- <file> --unsigned <file> --previous <0.1.1 file> --unsigned-sha256 <hex> --report <file.json>]
//
//   1. content: the dev-signed package and the unsigned package it was made from carry the same files, byte for byte, except
//      manifest.json (minCoreVersion only), integrity.json (only the manifest.json entry) and the added signature.json.
//   2. for each Core — TeamUQ 1.6.8 (teamuq-electron b8b96cb3) and TeamUQ 1.7.1 (the commit the vendored tuq-plugin-tool was built from) —
//      Core's own reviewArtifact + assertUpdateAllowed (lib/te-snapshot.mjs, read-only git archive), driven the way pluginInstallService.reviewPackage
//      drives them when the user picks a file (review without updateFrom; on already_installed / signer_not_allowed, once more with updateFrom =
//      the installed version; commitUpdate then re-checks assertUpdateAllowed). A throwaway plugins root trusts the public key file users import:
//        install   — nothing installed: must be accepted, signer dev-e6301dd7a2967155;
//        update    — 0.1.1 installed (its signer read from the REAL 0.1.1 package by the same Core): must be an update, not signer_changed;
//        negative controls (the check is not vacuous): the unsigned package of the same version as update (1.6.8 signature_missing, 1.7.1 signer_changed), the same
//        content signed by another development key as update (signer_changed), a flipped byte, Core 1.6.7, and no trusted key.
//   3. the official 1.7.1 author tool: `verify --anchors self --key-id … --public-key …` with the development public key (and without any key:
//      signer_unknown).
//   4. the content audit (lib/audit.mjs) with the development key's private material as needles: no key material, exactly one signature.json.
// Exit 0 only when every expectation holds. Nothing here installs anything into a TeamUQ profile.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEV_KEY_ID, DEV_PUB_FILE, DIST, DIST_DEVSIGNED, PREVIOUS_RELEASE, ROOT, TE_COMMIT } from './lib/paths.mjs'
import { parseArgs, sha256Hex } from './lib/pack.mjs'
import { auditPackage } from './lib/audit.mjs'
import { PLATFORM_ID, PLUGIN_ID } from './lib/manifest.mjs'
import { TARGET, TOOL_RECORD, runTool } from './lib/tuqTool.mjs'
import { loadTe168, loadTe171, resolveCommit } from './lib/te-snapshot.mjs'
import { devKeyIdOf, devKeySecretNeedles } from './lib/devKey.mjs'
import { PINNED_NATIVE } from './build-plugin.mjs'
import { buildDevsigned, devsignedFileName, trustedDevKeys, unpackChecked, unsignedFileName } from './build-plugin-devsigned.mjs'

const support = (coreVersion) => ({ coreVersion, platform: { id: PLATFORM_ID, osVersion: '10.0.26200' } })
const codeOf = (error) => error?.code ?? `error: ${String(error?.message ?? error).slice(0, 160)}`

/** Every non-generated difference between two unpacked packages. */
function compareContent(unsigned, devsigned, dirs) {
  const read = (dir, rel) => fs.readFileSync(path.join(dir, ...rel.split('/')))
  const names = [...new Set([...unsigned.entries, ...devsigned.entries])].sort()
  const same = []
  const differences = []
  for (const name of names) {
    const inU = unsigned.entries.includes(name)
    const inD = devsigned.entries.includes(name)
    if (!inU || !inD) { differences.push({ path: name, only: inU ? 'unsigned' : 'devsigned' }); continue }
    const a = read(dirs.unsigned, name)
    const b = read(dirs.devsigned, name)
    if (a.equals(b)) { same.push(name); continue }
    const diff = { path: name, unsigned: { size: a.length, sha256: sha256Hex(a) }, devsigned: { size: b.length, sha256: sha256Hex(b) } }
    if (name === 'manifest.json') {
      const ma = JSON.parse(a.toString('utf8'))
      const mb = JSON.parse(b.toString('utf8'))
      diff.changedKeys = [...new Set([...Object.keys(ma), ...Object.keys(mb)])].filter((key) => JSON.stringify(ma[key]) !== JSON.stringify(mb[key]))
      diff.values = Object.fromEntries(diff.changedKeys.map((key) => [key, { unsigned: ma[key], devsigned: mb[key] }]))
    }
    if (name === 'integrity.json') {
      const ia = new Map(JSON.parse(a.toString('utf8')).files.map((entry) => [entry.path, JSON.stringify(entry)]))
      const ib = new Map(JSON.parse(b.toString('utf8')).files.map((entry) => [entry.path, JSON.stringify(entry)]))
      diff.changedEntries = [...new Set([...ia.keys(), ...ib.keys()])].filter((key) => ia.get(key) !== ib.get(key))
    }
    differences.push(diff)
  }
  const expected =
    differences.length === 3 &&
    differences.some((d) => d.path === 'manifest.json' && d.changedKeys?.length === 1 && d.changedKeys[0] === 'minCoreVersion') &&
    differences.some((d) => d.path === 'integrity.json' && d.changedEntries?.length === 1 && d.changedEntries[0] === 'manifest.json') &&
    differences.some((d) => d.path === 'signature.json' && d.only === 'devsigned')
  return { sameFiles: same.length, same, differences, expected }
}

/** pluginInstallService.reviewPackage for a picked file, with Core `core`; `installed` is the installed record ({ id, version, signer }) or null. */
async function reviewLikeCore(core, file, { pluginsRoot, devKeys, coreVersion, installed, extra }) {
  const steps = []
  const common = {
    pluginsRoot,
    anchors: core.TEAMUQ_TRUST_ANCHORS,
    devKeys,
    support: support(coreVersion),
    findInstalled: async (id, kind) => (installed !== null && kind === 'plugin' && id === installed.id ? installed : null),
    ...extra,
  }
  const finish = async (staged, updateFrom) => {
    const out = { accepted: true, updateFrom, signer: staged.signer, version: staged.manifest.version, minCoreVersion: staged.manifest.minCoreVersion, integritySha256: staged.integritySha256, fileCount: staged.fileCount, steps }
    if (updateFrom !== null) {
      // commitUpdate re-checks the same policy against the installed record before anything moves
      try { core.assertUpdateAllowed(installed, { version: staged.manifest.version, signer: staged.signer }); out.commitUpdatePolicy = 'allowed' } catch (error) { out.accepted = false; out.commitUpdatePolicy = codeOf(error) }
    }
    await staged.discard()
    return out
  }
  try {
    const staged = await core.reviewArtifact(file, common)
    steps.push({ updateFrom: null, result: 'accepted' })
    return await finish(staged, null)
  } catch (error) {
    steps.push({ updateFrom: null, result: codeOf(error) })
    if (installed === null || !['already_installed', 'signer_not_allowed'].includes(error?.code)) return { accepted: false, code: codeOf(error), steps }
  }
  const updateFrom = { id: installed.id, version: installed.version }
  try {
    const staged = await core.reviewArtifact(file, { ...common, updateFrom })
    steps.push({ updateFrom, result: 'accepted' })
    return await finish(staged, updateFrom)
  } catch (error) {
    steps.push({ updateFrom, result: codeOf(error) })
    return { accepted: false, code: codeOf(error), steps }
  }
}

export async function verifyDevsigned({ file, unsignedFile, previousFile, unsignedSha256 }) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'line-todo-devsigned-'))
  const result = { file: path.basename(file), ok: false, problems: [], cores: {} }
  const expect = (label, condition, detail) => { if (!condition) result.problems.push(`${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`) }
  try {
    const bytes = fs.readFileSync(file)
    result.bytes = bytes.length
    result.sha256 = sha256Hex(bytes)
    const unsignedBytes = fs.readFileSync(unsignedFile)
    result.unsigned = { file: path.basename(unsignedFile), bytes: unsignedBytes.length, sha256: sha256Hex(unsignedBytes) }
    if (unsignedSha256 !== undefined) expect('the unsigned package is not the expected one', result.unsigned.sha256 === unsignedSha256, { expected: unsignedSha256, actual: result.unsigned.sha256 })
    const previousBytes = fs.readFileSync(previousFile.file)
    result.previous = { file: previousFile.file, bytes: previousBytes.length, sha256: sha256Hex(previousBytes), expectedSha256: previousFile.sha256 }
    expect('the installed-version package (0.1.1) is not the released one', result.previous.sha256 === previousFile.sha256, result.previous)

    // 1. content
    const dirs = { unsigned: path.join(sandbox, 'unsigned'), devsigned: path.join(sandbox, 'devsigned') }
    const u = unpackChecked(unsignedFile, dirs.unsigned)
    const d = unpackChecked(file, dirs.devsigned)
    result.content = compareContent(u, d, dirs)
    expect('content differs beyond manifest.minCoreVersion / integrity manifest entry / signature.json', result.content.expected, result.content.differences)
    const signature = JSON.parse(fs.readFileSync(path.join(dirs.devsigned, 'signature.json'), 'utf8'))
    result.signatureFile = { algorithm: signature.algorithm, keyId: signature.keyId }
    expect('signature.json keyId', signature.keyId === DEV_KEY_ID, signature.keyId)

    // a package with the same content signed by ANOTHER development key (negative control for signer_changed)
    const other = crypto.generateKeyPairSync('ed25519').privateKey
    const otherRaw = Buffer.from(crypto.createPublicKey(other).export({ type: 'spki', format: 'der' }).subarray(12))
    const otherKey = { keyId: devKeyIdOf(otherRaw), key: other, publicBase64: otherRaw.toString('base64') }
    const core168 = await loadTe168({ workDir: path.join(sandbox, 'work') })
    const otherStore = core168.createDevKeyStore({ pluginsRoot: path.join(sandbox, 'other-key-root') })
    await otherStore.add({ publicKey: otherKey.publicBase64, label: 'throwaway' })
    const otherBuilt = await buildDevsigned({ from: unsignedFile, outDir: path.join(sandbox, 'other-key'), outName: 'other-key.tuqplugin', signer: otherKey, devKeys: otherStore, verifySource: false })
    result.otherKeyPackage = { keyId: otherKey.keyId, sha256: otherBuilt.report.sha256 }
    const tampered = Buffer.from(bytes)
    tampered[Math.floor(tampered.length / 2)] ^= 0xff
    const tamperedFile = path.join(sandbox, 'tampered.tuqplugin')
    fs.writeFileSync(tamperedFile, tampered)

    // 2. both Cores
    const commit171 = TOOL_RECORD.teamuqElectronCommit
    const cores = [
      { label: '1.6.8', commit: TE_COMMIT, coreVersion: '1.6.8', load: async () => core168, extra: {} },
      // a picked file in 1.7.1 (pluginInstallService begin → pickAndInstall(…, 'accept') → reviewPackage(picked, false, 'accept', false)); no bundled ids
      { label: '1.7.1', commit: commit171, coreVersion: '1.7.1', load: () => loadTe171({ commit: commit171, workDir: path.join(sandbox, 'work') }), extra: { delegation: 'accept', isReservedId: async () => false, isOfficialId: async () => false, revokedArtifacts: [] } },
    ]
    for (const spec of cores) {
      const core = await spec.load()
      const out = { commit: resolveCommit(spec.commit), coreVersion: spec.coreVersion, reviewOptions: Object.keys(spec.extra) }
      result.cores[spec.label] = out
      const root = path.join(sandbox, `root-${spec.label}`)
      const { devKeys, pub } = await trustedDevKeys(core, path.join(root, 'plugins'))
      await devKeys.add({ publicKey: otherKey.publicBase64, label: 'throwaway (negative control)' })
      out.devPubFile = pub
      const run = (target, opts = {}) => reviewLikeCore(core, target, { pluginsRoot: path.join(root, 'plugins'), devKeys, coreVersion: spec.coreVersion, installed: null, extra: spec.extra, ...opts })

      const previous = await run(previousFile.file)
      out.previousInstall = previous
      expect(`${spec.label}: the 0.1.1 package does not review`, previous.accepted && previous.signer?.kind === 'dev' && previous.signer?.keyId === DEV_KEY_ID, previous)
      const installed = previous.accepted ? { id: PLUGIN_ID, version: previous.version, signer: previous.signer } : null

      out.install = await run(file)
      expect(`${spec.label}: install`, out.install.accepted && out.install.signer?.kind === 'dev' && out.install.signer?.keyId === DEV_KEY_ID, out.install)
      if (installed !== null) {
        out.update = await run(file, { installed })
        expect(`${spec.label}: update from 0.1.1`, out.update.accepted && out.update.updateFrom?.version === installed.version && out.update.commitUpdatePolicy === 'allowed' && out.update.signer?.keyId === installed.signer.keyId, out.update)
      }

      const neg = {}
      neg.unsignedInstall = await run(unsignedFile)
      if (installed !== null) neg.unsignedUpdate = await run(unsignedFile, { installed })
      if (installed !== null) neg.otherKeyUpdate = await run(otherBuilt.file, { installed })
      neg.tamperedByte = await run(tamperedFile)
      neg.core167 = await reviewLikeCore(core, file, { pluginsRoot: path.join(root, 'plugins'), devKeys, coreVersion: '1.6.7', installed: null, extra: spec.extra })
      const emptyRoot = path.join(root, 'empty-plugins')
      fs.mkdirSync(emptyRoot, { recursive: true })
      neg.noTrustedKey = await reviewLikeCore(core, file, { pluginsRoot: emptyRoot, devKeys: core.createDevKeyStore({ pluginsRoot: emptyRoot }), coreVersion: spec.coreVersion, installed: null, extra: spec.extra })
      out.negative = neg
      const refusedWith = (entry, code) => entry !== undefined && entry.accepted === false && entry.code === code
      if (spec.label === '1.6.8') {
        expect('1.6.8: the unsigned package install is not signature_missing', refusedWith(neg.unsignedInstall, 'signature_missing'), neg.unsignedInstall)
        expect('1.6.8: the unsigned package update is not signature_missing', refusedWith(neg.unsignedUpdate, 'signature_missing'), neg.unsignedUpdate)
        expect('1.6.8: no trusted key is not signer_unknown', refusedWith(neg.noTrustedKey, 'signer_unknown'), neg.noTrustedKey)
      } else {
        expect('1.7.1: the unsigned package update from dev-signed 0.1.1 is not signer_changed', refusedWith(neg.unsignedUpdate, 'signer_changed'), neg.unsignedUpdate)
        // no trusted key, picked file: 1.7.1 resolves the package to unsigned (refuseUnverifiedKey is off for a picked file) — recorded, not asserted
      }
      expect(`${spec.label}: another development key is not signer_changed`, refusedWith(neg.otherKeyUpdate, 'signer_changed'), neg.otherKeyUpdate)
      expect(`${spec.label}: a flipped byte is accepted`, neg.tamperedByte.accepted === false, neg.tamperedByte)
      expect(`${spec.label}: Core 1.6.7 is not core_version_incompatible`, neg.core167.accepted === false && neg.core167.code === 'core_version_incompatible', neg.core167)
    }

    // 3. the official 1.7.1 author tool
    const pubText = fs.readFileSync(DEV_PUB_FILE, 'utf8').trim()
    const target = ['--core-version', TARGET.coreVersion, '--platform', TARGET.platform, '--os-version', TARGET.osVersion]
    const brief = (r) => ({ command: r.command, exit: r.exit, stdout: r.json ?? r.stdout.trim(), stderr: r.stderr.trim() })
    // the tool takes a development public key only with `--anchors self` (commandVerify → withSelfDevKey); without it the key flags are ignored
    // and a dev-signed file is `signer_unknown` (no dev key is trusted by default) — recorded as the expected refusal
    result.tool171 = {
      withDevKey: brief(runTool(['verify', file, '--anchors', 'self', '--key-id', DEV_KEY_ID, '--public-key', pubText, ...target])),
      withoutKey: brief(runTool(['verify', file, ...target])),
    }
    expect('tuq-plugin-tool verify without any trusted key is not signer_unknown', result.tool171.withoutKey.exit !== 0 && /signer_unknown/.test(result.tool171.withoutKey.stderr), result.tool171.withoutKey)
    expect('tuq-plugin-tool verify with the development key', result.tool171.withDevKey.exit === 0 && result.tool171.withDevKey.stdout?.signer?.kind === 'dev' && result.tool171.withDevKey.stdout?.signer?.keyId === DEV_KEY_ID, result.tool171.withDevKey)

    // 4. content audit
    const entries = d.entries.map((name) => ({ path: name, data: fs.readFileSync(path.join(dirs.devsigned, ...name.split('/'))) }))
    const needles = devKeySecretNeedles()
    const allowedNative = Object.fromEntries((d.manifest.native?.files ?? []).map((entry) => [entry.path, entry.path.endsWith('koffi.node') ? PINNED_NATIVE.koffi.sha256 : PINNED_NATIVE.betterSqlite3.sha256]))
    const audit = auditPackage(entries, { allowedNative, secretNeedles: needles })
    const signatureFiles = d.entries.filter((name) => name === 'signature.json' || name === 'delegation.json')
    result.audit = { ok: audit.ok, problems: audit.problems, natives: audit.natives, entryCount: entries.length, secretNeedlesChecked: needles.length, signatureFiles }
    expect('content audit', audit.ok, audit.problems)
    expect('private-key needles were checked', needles.length === 3, needles.length)
    expect('signature files', signatureFiles.length === 1 && signatureFiles[0] === 'signature.json', signatureFiles)
    result.ok = result.problems.length === 0
  } catch (error) {
    result.ok = false
    result.problems.push(`${error.code ?? 'error'}: ${error.stack ?? error.message}`)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  const result = await verifyDevsigned({
    file: path.resolve(args._[0] ?? path.join(DIST_DEVSIGNED, devsignedFileName(version))),
    unsignedFile: path.resolve(args.unsigned ? String(args.unsigned) : path.join(DIST, unsignedFileName(version))),
    previousFile: { file: path.resolve(args.previous ? String(args.previous) : PREVIOUS_RELEASE.file), sha256: args['previous-sha256'] ? String(args['previous-sha256']) : PREVIOUS_RELEASE.sha256 },
    unsignedSha256: args['unsigned-sha256'] ? String(args['unsigned-sha256']) : undefined,
  })
  const text = JSON.stringify(result, null, 2)
  if (args.report) fs.writeFileSync(path.resolve(String(args.report)), text)
  console.log(text)
  process.exit(result.ok ? 0 : 1)
}
