// Runs INSIDE the permissioned child (Electron run-as-node + verbatim 1.6.8 buildBackendPermissionFlags),
// one process per phase. Order mirrors a full-trust backend boot:
//   1. 1.6.8 runPermissionSelfCheck (host refuses to boot when ok=false)
//   2. load the candidate SQLite engine, re-run self-check
//   3. install engine factory for the bundled, unmodified line-todo src/main/db/** and run the phase
//   4. self-check again; write the result into dataDir (the only writable place)
// Phase 'append-noclose' kills its own process afterwards without closing the DB (crash after commit).
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runPermissionSelfCheck } from './teamuq-contract.mjs'
import { runApiProbes } from './api-probes.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const init = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'))
const cfg = JSON.parse(Buffer.from(process.argv[3], 'base64url').toString('utf8'))
const errInfo = (e) => ({ code: e?.code ?? null, name: e?.name ?? null, message: String(e?.message ?? e).split('\n')[0].slice(0, 300) })
const replacer = (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)

const R = {
  phase: cfg.phase, label: cfg.label,
  runtime: { node: process.versions.node, electron: process.versions.electron ?? null, modules_abi: process.versions.modules, napi: process.versions.napi, sqliteBuiltin: process.versions.sqlite ?? null },
  permissionActive: typeof process.permission === 'object' && process.permission !== null,
}
R.selfCheckBoot = runPermissionSelfCheck(init)

const ENGINE_MODULE = { 'node-sqlite': './engines/node-sqlite.mjs', bsqlite: './engines/bsqlite.mjs', wasm: './engines/wasm-nodefs.mjs' }[cfg.engine]
let eng = null
const t0 = performance.now()
try {
  eng = await (await import(ENGINE_MODULE)).loadEngine(cfg, init)
  R.engine = { loaded: true, loadMs: Math.round((performance.now() - t0) * 100) / 100, info: eng.info, adapterFiles: eng.adapterFiles }
} catch (e) { R.engine = { loaded: false, ...errInfo(e) } }
R.selfCheckAfterEngine = runPermissionSelfCheck(init)

if (eng) {
  globalThis.__APPDB_FACTORY__ = eng.factory
  const ctx = { dataDir: init.dataDir, expectAppend: cfg.expectAppend, expectLegacy: cfg.expectLegacy, expectImport: cfg.expectImport }
  try {
    const bundle = await import(pathToFileURL(join(ROOT, 'build', 'appdb.bundle.mjs')).href)
    if (cfg.phase === 'create') {
      R.apiProbes = runApiProbes(eng.factory, join(init.dataDir, 'probe.db'))
      // scope probe: the same engine pointed OUTSIDE dataDir (system temp)
      const outside = join(os.tmpdir(), `appdb-outside-probe-${process.pid}.db`)
      try { const d = eng.factory(outside); d.exec('CREATE TABLE IF NOT EXISTS x(y)'); d.close(); R.outsideDataDirOpen = { opened: true, path: outside } } catch (e) { R.outsideDataDirOpen = { opened: false, path: outside, ...errInfo(e) } }
      R.phaseResult = bundle.phaseCreate(ctx)
    } else if (cfg.phase === 'legacy') R.phaseResult = bundle.phaseLegacy(ctx)
    else if (cfg.phase === 'import') R.phaseResult = bundle.phaseImport(ctx)
    else if (cfg.phase === 'append-noclose') R.phaseResult = bundle.phaseAppendNoClose(ctx)
    else if (cfg.phase === 'reopen') R.phaseResult = bundle.phaseReopen(ctx)
    else throw new Error('unknown phase ' + cfg.phase)
  } catch (e) { R.phaseError = { ...errInfo(e), stack: String(e?.stack ?? '').split('\n').slice(0, 6) } }
  if (eng.vfs) R.wasmVfs = { stats: { ...eng.vfs.stats, opened: [...new Set(eng.vfs.stats.opened)] }, lastError: eng.vfs.lastError(), openFiles: eng.vfs.openFiles() }
}
R.memoryRssMB = Math.round(process.memoryUsage().rss / 1048576)
R.selfCheckEnd = runPermissionSelfCheck(init)
fs.writeFileSync(join(init.dataDir, `.result-${cfg.phase}.json`), JSON.stringify(R, replacer))
process.stdout.write(`RESULT-WRITTEN ${cfg.phase}\n`)
if (cfg.phase === 'append-noclose') {
  // hard kill: no db.close(), no exit handlers (TerminateProcess on Windows)
  try { process.kill(process.pid, 'SIGKILL') } catch (e) { process.stdout.write('KILL-FAILED ' + errInfo(e).message + '\n'); process.reallyExit(9) }
}
