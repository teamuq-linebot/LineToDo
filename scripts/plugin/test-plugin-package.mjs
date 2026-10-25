// Phase 5 (G-08 / G-09) — the .tuqplugin built by the OFFICIAL author tool (scripts/plugin/vendor/tuq-plugin-tool.mjs: validate + pack --unsigned, then
// verify) for TeamUQ 1.7.13+ (vendored tool = Core 1.7.15): manifest, determinism, the tool's review, the content audit, and the SHIPPED BYTES running under the backend contract
// (Electron 44.2.0 run-as-node + the verbatim permission flags + self-check). Needs the same runtimes as test-backend-contract.mjs
// (Electron 31 writes the fake LINE DB, Electron 44 is the backend runtime). No key file and no teamuq-electron checkout are read.
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { analyzeBundle, patchKoffiLoader } from './build-backend.mjs'
import { PINNED_NATIVE, buildPackage, defaultKind, kindOverrides } from './build-plugin.mjs'
import { verifyArtifact } from './verify-artifact.mjs'
import { auditPackage } from './lib/audit.mjs'
import { sha256Hex } from './lib/pack.mjs'
import { BACKEND_METHODS, DESCRIPTION, MIN_CORE_VERSION, NATIVE_FILES, PERMISSIONS, PLUGIN_ID, RESIDENT_DESCRIPTION, RESIDENT_PERMISSION, buildManifest, permissionsFor, resolveResidentOption } from './lib/manifest.mjs'
import { ROOT, WORK } from './lib/paths.mjs'
import { UI_TEXT_FILES, copyTextAsLf, toLf } from './build-ui.mjs'
import { TOOL_RECORD, assertToolIntact, validateStage } from './lib/tuqTool.mjs'
import { BACKEND_METHOD_GROUPS } from '../../src/shared/pluginWire.ts'
import { PLUGIN_PAGE_PLACE } from '../../src/shared/teamuqPlaces.ts'
import { CORE_AI_CHAT_TITLE, SHIPPED_VERSION_SPECIFIC_PLACE } from './lib/fenced-text.mjs'
import { runPluginContract } from '../lib/plugin-contract-harness.mjs'
import { generateFixtures, makeTempRoot, rmQuiet } from '../lib/runtimes.mjs'

// the plugin version is package.json's (0.1.3: the fenced sentences name no version-specific place; 0.1.2: plugin-guide conformance; 0.1.1 was the dev-key-signed review-repair release)
const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
const TAR = process.platform === 'win32' ? 'C:/Windows/System32/tar.exe' : 'tar'

let built = null
function getBuilt() {
  if (!built) built = (async () => {
    const dir = makeTempRoot('line-todo-package-')
    const a = await buildPackage({ outDir: join(dir, 'a'), workDir: join(WORK, 'test-a') })
    const b = await buildPackage({ outDir: join(dir, 'b'), workDir: join(WORK, 'test-b') })
    return { a, b, dir, file: a.file }
  })()
  return built
}
test.after(async () => { if (built) rmQuiet((await built).dir) })

test('manifest: composed full-trust, ai:chat, both native modules, delete-on-uninstall, least permissions, one backend method per API namespace', async () => {
  const manifest = buildManifest({ version: VERSION })
  assert.equal(manifest.schemaVersion, 2)
  assert.equal(manifest.kind, 'plugin')
  assert.equal(manifest.id, PLUGIN_ID)
  assert.equal(manifest.trustTier, 'full-trust')
  assert.deepEqual(manifest.entry, { ui: 'ui/index.html', backend: 'backend/index.mjs' })
  // G-07: the allow-list is the method groups (<= 32), not a single api.invoke; driver is not in it
  assert.deepEqual(manifest.backendMethods, [...BACKEND_METHOD_GROUPS])
  assert.deepEqual(manifest.backendMethods, [...BACKEND_METHODS])
  assert.ok(manifest.backendMethods.length > 1 && manifest.backendMethods.length <= 32)
  assert.equal(manifest.backendMethods.includes('api.invoke'), false)
  assert.equal(manifest.backendMethods.includes('driver'), false)
  // G-06: the settings view stays, no settingsSchema, no settings:plugin
  assert.equal(manifest.settingsSchema, undefined)
  assert.ok(manifest.permissions.includes('ai:chat'))
  assert.deepEqual(manifest.permissions, [...PERMISSIONS])
  for (const unused of ['network:fetch', 'process:spawn', 'secrets:plugin', 'settings:plugin', 'storage:plugin-data', 'filesystem:user-folder']) assert.equal(manifest.permissions.includes(unused), false, `${unused} is not used by the plugin`)
  assert.deepEqual(manifest.native, { allowAddons: true, files: [...NATIVE_FILES] })
  assert.deepEqual(manifest.native.files.map((f) => f.path), ['backend/native/win32-x64/koffi.node', 'backend/native/win32-x64/better_sqlite3.node'])
  assert.equal(manifest.native.files.some((f) => /\.wasm$/.test(f.path)), false, '.wasm is code, not a native file')
  assert.deepEqual(manifest.data, { uninstall: 'delete' })
  assert.equal(manifest.minCoreVersion, '>=1.7.13', 'the backend runs the AI itself through context.host.ai.complete (Core 1.7.13+); unsigned packages also need a Core that accepts them (1.6.8 / 1.7.0 refuse with signature_missing)')
  assert.deepEqual(manifest.platforms, [{ id: 'win32-x64' }])
  assert.deepEqual(manifest.contributes.views.map((v) => [v.id, v.presentations]), [['board', ['tab', 'fullpage']], ['settings', ['settings']]])
  assert.ok(manifest.description.length <= 512, `description is ${manifest.description.length} chars`)
  for (const phrase of ['LINE.exe 的記憶體', 'TeamUQ 已登入的 AI', '模型與推理強度', '填入 LINE', 'CLI provider', '自訂 AI 端點', '看板不需要開著', 'TeamUQ 的 AI 歷史']) assert.ok(DESCRIPTION.includes(phrase), phrase)
})

test('the current author tool validates the stage and refuses an older Core and a manifest that breaks the contract', async () => {
  const tool = assertToolIntact()
  assert.equal(tool.sha256, TOOL_RECORD.sha256)
  assert.equal(TOOL_RECORD.builtFromCore, '1.7.15')
  const { a } = await getBuilt()
  assert.equal(a.report.validate.exit, 0, a.report.validate.stderr)
  assert.equal(a.report.validate.stdout.ok, true)
  assert.equal(a.report.validate.stdout.coreVersion, TOOL_RECORD.builtFromCore)
  assert.equal(a.report.pack.exit, 0, a.report.pack.stderr)
  assert.deepEqual(a.report.pack.stdout.signer, { kind: 'unsigned' })
  assert.match(a.report.pack.command, /pack \S+ --unsigned --out /)
  // the same stage against an older Core, and a stage with a 33rd backend method, are refused by the same tool (validate is not vacuous)
  const old = validateStage(a.stageDir, { coreVersion: '1.7.0', platform: 'win32-x64', osVersion: '26200' })
  assert.notEqual(old.exit, 0)
  assert.match(JSON.stringify(old.json ?? old.stderr), /core_version_incompatible/)
  // 1.7.12 is the Core of the previous devkit: it has host.ai but no host.ai.complete, so the package must not install there
  const noComplete = validateStage(a.stageDir, { coreVersion: '1.7.12', platform: 'win32-x64', osVersion: '26200' })
  assert.notEqual(noComplete.exit, 0)
  assert.match(JSON.stringify(noComplete.json ?? noComplete.stderr), /core_version_incompatible/)
  const broken = join(a.stageDir, '..', 'stage-broken')
  rmQuiet(broken)
  mkdirSync(broken, { recursive: true })
  for (const rel of ['ui/index.html', 'ui/settings.html', 'ui/icon.png', 'backend/index.mjs', ...NATIVE_FILES.map((f) => f.path)]) {
    mkdirSync(join(broken, ...rel.split('/').slice(0, -1)), { recursive: true })
    copyFileSync(join(a.stageDir, ...rel.split('/')), join(broken, ...rel.split('/')))
  }
  writeFileSync(join(broken, 'manifest.json'), JSON.stringify({ ...a.manifest, backendMethods: Array.from({ length: 33 }, (_, i) => `m${i}`) }))
  const tooMany = validateStage(broken)
  assert.notEqual(tooMany.exit, 0, 'more than 32 backendMethods is refused')
  rmQuiet(broken)
})

test('the build is deterministic: two builds from different work / output directories give byte-identical packages', async () => {
  const { a, b } = await getBuilt()
  assert.equal(a.report.sha256, b.report.sha256)
  assert.ok(a.zip.equals(b.zip))
  assert.equal(a.report.signer, 'unsigned')
  assert.equal(a.manifest.version, VERSION)
  assert.equal(a.outName, `tuqdev.line-todo-${VERSION}-win.tuqplugin`)
  // the overrides only restate kinds that differ from the tool's default (the two natives with their platform; html / css / wasm as code)
  assert.deepEqual(kindOverrides(a.files), a.report.overrides)
  for (const o of a.report.overrides) assert.ok(o.kind !== defaultKind(o.path) || o.platform !== undefined, o.path)
})

test('the package bytes depend on the commit, not on the checkout: authored text (ui html, theme-boot.js, THIRD_PARTY_NOTICES) is packed with LF even when core.autocrlf checked it out with CRLF', async () => {
  const { a } = await getBuilt()
  const sources = {
    'ui/index.html': ['src', 'plugin', 'ui', 'index.html'],
    'ui/settings.html': ['src', 'plugin', 'ui', 'settings.html'],
    'ui/theme-boot.js': ['src', 'plugin', 'ui', 'theme-boot.js'],
    'LICENSES/THIRD_PARTY_NOTICES.md': ['src', 'plugin', 'THIRD_PARTY_NOTICES.md']
  }
  assert.deepEqual(UI_TEXT_FILES.map((f) => `ui/${f}`), Object.keys(sources).filter((p) => p.startsWith('ui/')), 'every copied UI file is covered')
  for (const [entry, parts] of Object.entries(sources)) {
    const packed = a.files.find((f) => f.path === entry)
    assert.ok(packed, entry)
    assert.equal(packed.data.includes(0x0d), false, `${entry}: no CR byte`)
    assert.equal(packed.data.toString('utf8'), toLf(readFileSync(join(ROOT, ...parts), 'utf8')), `${entry}: the source with LF`)
  }
  // the same file checked out with LF and with CRLF is copied to the same bytes
  const dir = makeTempRoot('line-todo-eol-')
  try {
    for (const [entry, parts] of Object.entries(sources)) {
      const lf = toLf(readFileSync(join(ROOT, ...parts), 'utf8'))
      assert.ok(lf.includes('\n'), `${entry} has lines`)
      writeFileSync(join(dir, 'lf'), lf)
      writeFileSync(join(dir, 'crlf'), lf.replace(/\n/g, '\r\n'))
      copyTextAsLf(join(dir, 'lf'), join(dir, 'lf.out'))
      copyTextAsLf(join(dir, 'crlf'), join(dir, 'crlf.out'))
      assert.ok(readFileSync(join(dir, 'lf.out')).equals(readFileSync(join(dir, 'crlf.out'))), entry)
    }
  } finally { rmQuiet(dir) }
})

test('the tool\'s review (verify, same reviewArtifact as Core) for TeamUQ 1.7.15: unsigned, all integrity / manifest / native / icon checks pass; tampering, Core 1.7.0, Core 1.7.12 and another platform are refused', async () => {
  const { file } = await getBuilt()
  const verdict = await verifyArtifact({ file })
  assert.deepEqual(verdict.problems, [])
  assert.equal(verdict.ok, true)
  assert.equal(verdict.steps.verify.exit, 0)
  assert.deepEqual(verdict.steps.verify.stdout.signer, { kind: 'unsigned' })
  for (const label of ['tamperedByte', 'core170', 'core1712', 'linuxPlatform']) assert.equal(verdict.steps.negative[label].refused, true, label)
  // native: exactly the two listed modules, kind native + platform; the .wasm files are code
  const kinds = Object.fromEntries(verdict.steps.integrity.map((e) => [e.path, [e.kind, e.platform]]))
  assert.deepEqual(kinds['backend/native/win32-x64/koffi.node'], ['native', 'win32-x64'])
  assert.deepEqual(kinds['backend/native/win32-x64/better_sqlite3.node'], ['native', 'win32-x64'])
  assert.deepEqual(kinds['vendor/sqlite3mc-wasm/sqlite3.wasm'], ['code', null])
  assert.equal(verdict.steps.integrity.filter((e) => e.kind === 'native').length, 2)
})

test('package content: no .ps1, no better-sqlite3-multiple-ciphers, no private key, no signature, no standalone better-sqlite3 11.x, no node_modules', async () => {
  const { file } = await getBuilt()
  const verdict = await verifyArtifact({ file })
  assert.equal(verdict.steps.audit.ok, true, verdict.steps.audit.problems.join('; '))
  assert.equal(verdict.entries.some((e) => /\.ps1$/i.test(e.path)), false)
  assert.equal(verdict.entries.some((e) => /multiple-ciphers/i.test(e.path)), false)
  assert.equal(verdict.entries.some((e) => /node_modules/.test(e.path)), false)
  assert.deepEqual(verdict.steps.audit.signatureFiles, [], 'unsigned: no signature.json / delegation.json')
  assert.ok(verdict.steps.audit.standalone11Compared.length >= 1, 'the standalone 11.x binary hash was compared')
  assert.deepEqual(verdict.steps.audit.natives.map((n) => n.sha256).sort(), [PINNED_NATIVE.koffi.sha256, PINNED_NATIVE.betterSqlite3.sha256].sort())
})

test('0.1.3 r1: the shipped UI and backend name no TeamUQ place that only 1.6.8 or only 1.7.1 has (「設定 → 外掛」, 「TeamUQ 設定」, 「我的 AI › 外掛」)', async () => {
  const { a } = await getBuilt()
  // esbuild may write a character as \uXXXX: decode before matching, so the check sees what the user sees
  const decode = (s) => s.replace(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/g, (_, braced, plain) => String.fromCodePoint(parseInt(braced ?? plain, 16)))
  const shipped = ['ui/main.js', 'ui/settings.js', 'ui/index.html', 'ui/settings.html', 'backend/index.mjs', 'manifest.json']
  for (const rel of shipped) {
    const text = decode(readFileSync(join(a.stageDir, ...rel.split('/')), 'utf8'))
    const hit = text.match(SHIPPED_VERSION_SPECIFIC_PLACE)
    assert.equal(hit, null, `${rel}: ${hit ? text.slice(Math.max(0, hit.index - 40), hit.index + 60) : ''}`)
  }
  // the r1 place names are really in the shipped bundles (the sentences are assembled from them at run time)
  const ui = decode(readFileSync(join(a.stageDir, 'ui', 'main.js'), 'utf8'))
  const backend = decode(readFileSync(join(a.stageDir, 'backend', 'index.mjs'), 'utf8'))
  for (const name of [CORE_AI_CHAT_TITLE, PLUGIN_PAGE_PLACE, `」分頁`]) assert.ok(ui.includes(name), `ui/main.js: ${name}`)
  for (const name of [CORE_AI_CHAT_TITLE, PLUGIN_PAGE_PLACE]) assert.ok(backend.includes(name), `backend/index.mjs: ${name}`)
  assert.equal(SHIPPED_VERSION_SPECIFIC_PLACE.test('到 TeamUQ 設定 → 外掛重新允許'), true, 'not vacuous')
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

test('the shipped bytes under the backend contract: unpack the package (no node_modules anywhere), run Electron 44 + 1.6.8 flags; self-check passes; koffi + WASM + better-sqlite3 13.0.2 load from the package files and the fake LINE DB is imported', async () => {
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
      lineLocation: { lineDbDir: linedir, watcher: { intervalSec: 1, limit: 300 } },
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

// ───────────── background execution (background:resident): the build option that is OFF by default ─────────────

const keysDeep = (value, out = new Set()) => {
  if (value !== null && typeof value === 'object') for (const [key, inner] of Object.entries(value)) { out.add(key); keysDeep(inner, out) }
  return out
}

test('resident build option: off by default (permissions, minCoreVersion and description are exactly the 0.2.0 ones); on only with an explicit minCoreVersion; a bad or missing range is an error, never a guess', () => {
  assert.deepEqual(resolveResidentOption({ args: {}, env: {} }), { enabled: false })
  assert.deepEqual(resolveResidentOption({}), { enabled: false })
  assert.deepEqual(resolveResidentOption({ args: { 'resident-min-core': '>=1.8.0' }, env: { LINE_TODO_RESIDENT_MIN_CORE: '>=1.8.0' } }), { enabled: false }, 'a range alone does not switch it on')
  assert.deepEqual(permissionsFor({ enabled: false }), [...PERMISSIONS])
  assert.deepEqual(permissionsFor(undefined), [...PERMISSIONS])
  const off = buildManifest({ version: VERSION })
  assert.deepEqual(buildManifest({ version: VERSION, resident: { enabled: false } }), off, 'an explicit "off" is the default')
  assert.equal(off.minCoreVersion, MIN_CORE_VERSION)
  assert.equal(off.minCoreVersion, '>=1.7.13')
  assert.deepEqual(off.permissions, ['ui:view', 'backend:invoke', 'native:addons', 'ai:chat', 'assets:plugin-data'])
  assert.equal(off.description, DESCRIPTION)
  assert.equal(keysDeep(off).has('residency'), false)
  assert.equal(off.permissions.includes(RESIDENT_PERMISSION), false)

  for (const bad of [undefined, '', '1.8.0 ', '>= 1.8.0', '~1.8.0', '>=1.8', 'latest', '>=01.8.0']) {
    assert.throws(() => resolveResidentOption({ args: { resident: true, 'resident-min-core': bad }, env: {} }), /resident-min-core/, JSON.stringify(bad))
  }
  assert.throws(() => resolveResidentOption({ args: {}, env: { LINE_TODO_RESIDENT: '1' } }), /resident-min-core/, 'the environment switch needs the environment range too')
  assert.deepEqual(resolveResidentOption({ args: {}, env: { LINE_TODO_RESIDENT: '1', LINE_TODO_RESIDENT_MIN_CORE: '>=1.8.0' } }), { enabled: true, minCoreVersion: '>=1.8.0' })
  assert.deepEqual(resolveResidentOption({ args: { resident: true, 'resident-min-core': '^1.8.0' }, env: {} }), { enabled: true, minCoreVersion: '^1.8.0' })

  const resident = resolveResidentOption({ args: { resident: true, 'resident-min-core': '>=1.8.0' }, env: {} })
  const on = buildManifest({ version: VERSION, resident })
  assert.deepEqual(on.permissions, [...PERMISSIONS, 'background:resident'], 'one permission more, nothing else')
  assert.equal(on.minCoreVersion, '>=1.8.0', 'the value that was given')
  assert.equal(on.description, RESIDENT_DESCRIPTION)
  assert.notEqual(on.description, DESCRIPTION)
  assert.ok(on.description.length <= 512, `description is ${on.description.length} chars`)
  assert.ok(on.description.includes('關閉畫面後繼續在背景執行') && on.description.includes('預設是關閉'), 'it says what the switch is called and that it starts off')
  assert.ok(!on.description.includes('停止背景程式，之後開啟看板會補整理；每分鐘'), 'the "stops when idle" parenthesis of the default text is replaced')
  // Core rejects residency / reason in a manifest (design D:108, manifestV2.ts:230); background:resident needs full-trust and no provides (manifestV2.ts:249-252)
  assert.equal(keysDeep(on).has('residency'), false)
  assert.equal(keysDeep(on).has('reason'), false)
  assert.equal(on.trustTier, 'full-trust')
  assert.equal(on.provides, undefined)
  // the only differences from the default manifest
  const differing = Object.keys({ ...off, ...on }).filter((key) => JSON.stringify(off[key]) !== JSON.stringify(on[key])).sort()
  assert.deepEqual(differing, ['description', 'minCoreVersion', 'permissions'])
})

test('resident build option: the author tool of this repo (Core 1.7.15) refuses the resident manifest ONLY because it does not know the permission yet (permission_unknown); once the tool knows it the stage validates', async () => {
  const { a } = await getBuilt()
  const stage = join(a.stageDir, '..', 'stage-resident-probe')
  rmQuiet(stage)
  mkdirSync(stage, { recursive: true })
  for (const rel of ['ui/index.html', 'ui/settings.html', 'ui/icon.png', 'backend/index.mjs', ...NATIVE_FILES.map((f) => f.path)]) {
    mkdirSync(join(stage, ...rel.split('/').slice(0, -1)), { recursive: true })
    copyFileSync(join(a.stageDir, ...rel.split('/')), join(stage, ...rel.split('/')))
  }
  // minCoreVersion = the tool's own Core, so that an unreleased Core number is not a second reason to refuse
  const resident = buildManifest({ version: VERSION, resident: { enabled: true, minCoreVersion: `>=${TOOL_RECORD.builtFromCore}` } })
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(resident))
  const run = validateStage(stage)
  rmQuiet(stage)
  if (run.exit === 0) return // the vendored tool was replaced by one that knows background:resident: nothing left to refuse
  const errors = (run.json?.violations ?? []).filter((v) => v.severity === 'error')
  assert.equal(run.exit, 1, run.stderr)
  assert.deepEqual(errors.map((v) => [v.where, v.message]), [['support permission_unknown permissions', 'background:resident']], `the one reason: ${JSON.stringify(run.json ?? run.stderr).slice(0, 600)}`)
})
