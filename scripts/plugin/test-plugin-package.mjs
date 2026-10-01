// Phase 5 — the signed .tuqplugin: manifest, determinism, the pinned TeamUQ 1.6.8 validators, the content audit, and the SHIPPED BYTES running under the
// 1.6.8 backend contract (Electron 44.2.0 run-as-node + the verbatim permission flags + self-check). Needs the same runtimes as test-backend-contract.mjs
// (Electron 31 writes the fake LINE DB, Electron 44 is the backend runtime) and the shared development key file (only read, to sign).
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { analyzeBundle, patchKoffiLoader } from './build-backend.mjs'
import { PINNED_NATIVE, buildPackage } from './build-plugin.mjs'
import { verifyArtifact } from './verify-artifact.mjs'
import { auditPackage } from './lib/audit.mjs'
import { loadTeBuilder, sha256Hex } from './lib/pack.mjs'
import { loadTeValidators } from './lib/te-snapshot.mjs'
import { DESCRIPTION, NATIVE_FILES, PERMISSIONS, PLUGIN_ID, buildManifest } from './lib/manifest.mjs'
import { WORK } from './lib/paths.mjs'
import { runPluginContract } from '../lib/plugin-contract-harness.mjs'
import { generateFixtures, makeTempRoot, rmQuiet } from '../lib/runtimes.mjs'

// the plugin version is package.json's (0.1.1 is the review-repair release; 0.1.0 was never published)
const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
const TAR = process.platform === 'win32' ? 'C:/Windows/System32/tar.exe' : 'tar'
const PUB = 'C:/teamuq/teamuq-plugins/_install/windows/dev-e6301dd7a2967155.pub'

let built = null
function getBuilt() {
  if (!built) built = (async () => {
    const a = await buildPackage({ workDir: join(WORK, 'test-a') })
    const b = await buildPackage({ workDir: join(WORK, 'test-b') })
    const dir = makeTempRoot('line-todo-package-')
    const file = join(dir, a.outName)
    writeFileSync(file, a.zip)
    return { a, b, dir, file }
  })()
  return built
}
test.after(async () => { if (built) rmQuiet((await built).dir) })

test('manifest: composed full-trust, ai:chat, both native modules, delete-on-uninstall, least permissions', async () => {
  const { baseManifest } = await loadTeBuilder()
  const manifest = buildManifest({ baseManifest, version: VERSION })
  assert.equal(manifest.id, PLUGIN_ID)
  assert.equal(manifest.trustTier, 'full-trust')
  assert.deepEqual(manifest.entry, { ui: 'ui/index.html', backend: 'backend/index.mjs' })
  assert.deepEqual(manifest.backendMethods, ['api.invoke'])
  assert.ok(manifest.permissions.includes('ai:chat'))
  assert.deepEqual(manifest.permissions, [...PERMISSIONS])
  for (const unused of ['network:fetch', 'process:spawn', 'secrets:plugin', 'settings:plugin', 'storage:plugin-data', 'filesystem:user-folder']) assert.equal(manifest.permissions.includes(unused), false, `${unused} is not used by the plugin`)
  assert.deepEqual(manifest.native, { allowAddons: true, files: [...NATIVE_FILES] })
  assert.deepEqual(manifest.native.files.map((f) => f.path), ['backend/native/win32-x64/koffi.node', 'backend/native/win32-x64/better_sqlite3.node'])
  assert.equal(manifest.native.files.some((f) => /\.wasm$/.test(f.path)), false, '.wasm is code, not a native file')
  assert.deepEqual(manifest.data, { uninstall: 'delete' })
  assert.equal(manifest.minCoreVersion, '>=1.6.8')
  assert.deepEqual(manifest.platforms, [{ id: 'win32-x64' }])
  assert.deepEqual(manifest.contributes.views.map((v) => [v.id, v.presentations]), [['board', ['tab', 'fullpage']], ['settings', ['settings']]])
  assert.ok(manifest.description.length <= 512, `description is ${manifest.description.length} chars`)
  for (const phrase of ['LINE.exe 的記憶體', 'Codex', '填入 LINE', 'CLI provider', '自訂 AI 端點', '看板開著']) assert.ok(DESCRIPTION.includes(phrase), phrase)
  const { sdk } = await loadTeValidators()
  assert.equal(sdk.PluginManifestV2Schema.safeParse(manifest).success, true)
  assert.deepEqual(sdk.evaluateManifestSupport(sdk.PluginManifestV2Schema.parse(manifest), { coreVersion: '1.6.8', platform: { id: 'win32-x64', osVersion: '10.0.26200' } }), [])
  assert.notDeepEqual(sdk.evaluateManifestSupport(sdk.PluginManifestV2Schema.parse(manifest), { coreVersion: '1.6.7', platform: { id: 'win32-x64', osVersion: '10.0.26200' } }), [], '1.6.7 must be refused')
})

test('the build is deterministic: two builds from different work directories give byte-identical packages', async () => {
  const { a, b } = await getBuilt()
  assert.equal(a.report.sha256, b.report.sha256)
  assert.ok(a.zip.equals(b.zip))
  assert.equal(a.report.signerKeyId, 'dev-e6301dd7a2967155')
  assert.equal(VERSION, '0.1.1')
  assert.equal(a.outName, `tuqdev.line-todo-${VERSION}-win.tuqplugin`)
})

test('TeamUQ 1.6.8 validators (pinned commit b8b96cb3): zip + integrity + signature + manifest + native + icon pass; tampering / old core / unknown signer are refused', async () => {
  const { file } = await getBuilt()
  const verdict = await verifyArtifact({ file, pubFile: PUB, coreVersion: '1.6.8' })
  assert.deepEqual(verdict.problems, [])
  assert.equal(verdict.ok, true)
  assert.equal(verdict.steps.reviewArtifact.passed, true)
  assert.deepEqual(verdict.steps.reviewArtifact.signer, { kind: 'dev', keyId: 'dev-e6301dd7a2967155', label: 'line-todo verify' })
  assert.equal(verdict.steps.limitsOk, true)
  assert.ok(verdict.bytes < verdict.limits.maxArchiveBytes)
  for (const label of ['negativeTamperedBytes', 'negativeCore167', 'negativeUnknownSigner']) assert.equal(verdict.steps[label].refused, true, label)
  // native: exactly the two listed modules, kind native + platform; the .wasm files are code
  const kinds = Object.fromEntries(verdict.steps.integrity.map((e) => [e.path, [e.kind, e.platform]]))
  assert.deepEqual(kinds['backend/native/win32-x64/koffi.node'], ['native', 'win32-x64'])
  assert.deepEqual(kinds['backend/native/win32-x64/better_sqlite3.node'], ['native', 'win32-x64'])
  assert.deepEqual(kinds['vendor/sqlite3mc-wasm/sqlite3.wasm'], ['code', null])
  assert.equal(verdict.steps.integrity.filter((e) => e.kind === 'native').length, 2)
})

test('package content: no .ps1, no better-sqlite3-multiple-ciphers, no private key, no standalone better-sqlite3 11.x, no node_modules', async () => {
  const { file } = await getBuilt()
  const verdict = await verifyArtifact({ file, pubFile: PUB, coreVersion: '1.6.8' })
  assert.equal(verdict.steps.audit.ok, true, verdict.steps.audit.problems.join('; '))
  assert.equal(verdict.entries.some((e) => /\.ps1$/i.test(e.path)), false)
  assert.equal(verdict.entries.some((e) => /multiple-ciphers/i.test(e.path)), false)
  assert.equal(verdict.entries.some((e) => /node_modules/.test(e.path)), false)
  assert.equal(verdict.steps.audit.secretNeedlesChecked, 3, 'the private key material was searched for (3 encodings)')
  assert.ok(verdict.steps.audit.standalone11Compared.length >= 1, 'the standalone 11.x binary hash was compared')
  assert.deepEqual(verdict.steps.audit.natives.map((n) => n.sha256).sort(), [PINNED_NATIVE.koffi.sha256, PINNED_NATIVE.betterSqlite3.sha256].sort())
})

test('the content audit really flags forbidden content (guard is not vacuous)', () => {
  const ok = [
    { path: 'backend/native/win32-x64/better_sqlite3.node', data: Buffer.from('13') },
    { path: 'backend/index.mjs', data: Buffer.from('export {}') },
  ]
  const allowedNative = { 'backend/native/win32-x64/better_sqlite3.node': sha256Hex(Buffer.from('13')) }
  assert.equal(auditPackage(ok, { allowedNative }).ok, true)
  const bad = auditPackage([
    ...ok,
    { path: 'resources/line-driver/line-uia-host.ps1', data: Buffer.from('x') },
    { path: 'backend/native/win32-x64/other.node', data: Buffer.from('y') },
    { path: 'notes.txt', data: Buffer.from('uses better-sqlite3-multiple-ciphers') },
    { path: 'keys/dev-key.json', data: Buffer.from('{"privatePkcs8":"AAAA"}') },
    { path: 'a.txt', data: Buffer.from('-----BEGIN PRIVATE KEY-----') },
    { path: 'node_modules/x/index.js', data: Buffer.from('z') },
  ], { allowedNative, secretNeedles: [] })
  const joined = bad.problems.join('\n')
  for (const needle of ['PowerShell', 'not on the allow-list', 'better-sqlite3-multiple-ciphers', 'looks like a key file', 'private-key marker', 'node_modules']) assert.ok(joined.includes(needle), needle)
  const secret = Buffer.from('0123456789abcdef0123456789abcdef')
  assert.equal(auditPackage([...ok, { path: 'x.bin', data: Buffer.concat([Buffer.from('aa'), secret]) }], { allowedNative, secretNeedles: [secret] }).ok, false)
  const eleven = Buffer.from('eleven')
  const elevenEntry = { path: 'backend/native/win32-x64/better_sqlite3.node', data: eleven }
  assert.equal(auditPackage([elevenEntry], { allowedNative: { [elevenEntry.path]: sha256Hex(eleven) }, standalone11Sha256: [sha256Hex(eleven)] }).problems.some((p) => p.includes('standalone better-sqlite3 11.x')), true)
})

test('the koffi addon shim: patch needs the exact koffi 3.1.0 loader text; the inline bundle analysis rejects probing loaders and platform packages', () => {
  assert.throws(() => patchKoffiLoader('var native = somethingElse()', [['var native = loadStatic(pkg)', 'x']]), /expected text not found/)
  const metafile = (inputs, imports = []) => ({ inputs: Object.fromEntries(inputs.map((i) => [i, {}])), outputs: { 'out/index.mjs': { bytes: 1, imports: imports.map((p) => ({ path: p, external: true })) } } })
  const base = ['src/plugin/backend/index.ts', 'node_modules/better-sqlite3-plugin/lib/index.js', 'src/plugin/backend/stubs/llmProvider.ts', 'node_modules/koffi/src/koffi/index.js']
  assert.equal(analyzeBundle({ text: 'var native = require2(__ltKoffiNode);', metafile: metafile(base, ['node:fs']), outfile: 'out/index.mjs', koffi: 'inline' }).ok, true)
  const probing = analyzeBundle({ text: 'var native = loadStatic(pkg) ?? loadDynamic(dir); process.resourcesPath; require("@koromix/koffi-win32-x64"); __ltKoffiNode', metafile: metafile([...base, 'node_modules/@koromix/koffi-win32-x64/index.js'], ['node:fs']), outfile: 'out/index.mjs', koffi: 'inline' })
  assert.equal(probing.ok, false)
  const joined = probing.problems.join('\n')
  for (const needle of ['@koromix/koffi-* platform package', 'resourcesPath', "probing loaders", 'koffi platform package / static loader']) assert.ok(joined.includes(needle), needle)
  assert.equal(analyzeBundle({ text: '__ltKoffiNode', metafile: metafile(base, ['koffi']), outfile: 'out/index.mjs', koffi: 'inline' }).ok, false, 'a bare external koffi import must not survive in inline mode')
})

test('the shipped bytes under the 1.6.8 contract: unpack the signed package (no node_modules anywhere), run Electron 44 + 1.6.8 flags; self-check passes; koffi + WASM + better-sqlite3 13.0.2 load from the package files and the fake LINE DB is imported', async () => {
  const { file } = await getBuilt()
  const root = makeTempRoot('line-todo-pkg-contract-')
  try {
    const fixtureDir = join(root, 'fixtures')
    const expected = generateFixtures(fixtureDir, { baseN: 900, walN: 120 })
    const linedir = join(root, 'linedir')
    mkdirSync(linedir, { recursive: true })
    copyFileSync(join(fixtureDir, 'wal', 'm.edb'), join(linedir, 'qw0f0f.edb'))
    const scenario = { linedir, walSourceDir: join(fixtureDir, 'wal'), expected: { baseCount: expected.wal.baseOnly.messageCount, fullCount: expected.wal.messageCount } }
    const stage = async (workRoot) => {
      const installDir = join(workRoot, 'install')
      mkdirSync(installDir, { recursive: true })
      const untar = spawnSync(TAR, ['-xf', file, '-C', installDir], { encoding: 'utf8' })
      assert.equal(untar.status, 0, untar.stderr)
      assert.equal(existsSync(join(installDir, 'node_modules')), false, 'the install directory has no node_modules: koffi can only come from backend/native')
      for (const rel of ['backend/native/win32-x64/koffi.node', 'backend/native/win32-x64/better_sqlite3.node', 'vendor/sqlite3mc-wasm/sqlite3.wasm', 'vendor/sqlite3mc-wasm/sqlite3.mjs', 'backend/index.mjs']) assert.equal(existsSync(join(installDir, ...rel.split('/'))), true, rel)
      return { installDir, built: null }
    }
    const run = await runPluginContract({
      workRoot: join(root, 'run'),
      settings: { lineDbDir: linedir, linePollSec: 1, lineBatchLimit: 300 },
      preseed: ({ dataDir }) => {
        writeFileSync(join(dataDir, '.linekey'), expected.key)
        writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ version: 1, reconcile: { enabled: false, scopeMonths: 0 } }))
      },
      scenario,
      stage,
    })
    assert.equal(run.exitCode, 0, `exit code (stderr: ${run.stderr.slice(0, 800)} fatal: ${run.result?.fatal} steps: ${run.result?.steps})`)
    const r = run.result
    assert.ok(r, `RESULT present (stdout: ${run.stdout.slice(0, 800)})`)
    assert.equal(r.fatal, undefined, r.fatal)
    assert.equal(r.runtime.electron, '44.2.0')
    assert.equal(run.flags[0], '--permission')
    assert.ok(run.flags.includes('--allow-addons'))
    assert.ok(!run.flags.some((f) => /allow-child-process|allow-worker/.test(f)))
    for (const [label, report] of [['boot', r.selfCheckBoot], ['afterActivate', r.selfCheckAfterActivate], ['end', r.selfCheckEnd]]) {
      assert.equal(report.ok, true, `${label}: ok (code=${report.code})`)
      assert.equal(report.allowAddons, true)
      const failed = Object.entries(report.probes).filter(([, v]) => v === 'fail' || v === 'allowed' || v === 'absent')
      assert.deepEqual(failed, [], `${label}: no failed probe`)
    }
    assert.deepEqual(r.handlerKeys, ['call', 'diagnostics', 'dispose', 'openSession'])
    assert.deepEqual(r.info.appDb, { sqlite: '3.53.4' }, 'the app DB is the packaged better-sqlite3 13.0.2')
    assert.equal(r.baseImport.count, expected.wal.baseOnly.messageCount, 'koffi copied the fake LINE DB and the packaged WASM engine read every row')
    assert.equal(r.baseImport.status.lastError, null)
    assert.ok(r.reads.chats.ok && r.reads.chats.count >= 100)
    assert.equal(r.newMessages.count, expected.wal.messageCount, 'the WAL that LINE appends later (copied by koffi) is picked up and delivered as events')
    assert.ok(r.afterDispose.dataDir.includes('line-todo.db'))
    const noisy = run.stderr.split('\n').filter((l) => l.trim() && !/PERM0001|trace-warnings|--allow-addons/.test(l))
    assert.deepEqual(noisy, [], 'no unexpected stderr output')
    assert.ok(!r.logs.some((l) => /error/i.test(l) && !/PERM|OPFS|opfs/i.test(l)), `unexpected error logs: ${r.logs.filter((l) => /error/i.test(l)).join(' | ')}`)
  } finally {
    rmQuiet(root)
  }
})
