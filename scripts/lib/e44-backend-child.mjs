// The "plugin backend" used by the 1.6.8 contract test. Bundled by esbuild (esm) into <installDir>/backend/index.mjs
// and run by Electron 44 as Node (ELECTRON_RUN_AS_NODE=1) with the verbatim 1.6.8 permission flags:
//   --permission --allow-fs-read=<bootstrap,installDir,dataDir> --allow-fs-write=<dataDir> --allow-addons
// i.e. Node fs can only read installDir/dataDir and write dataDir; spawn/worker are forbidden.
//
// It wires exactly what the Phase 2 backend assembly will: Win32LineFsPort (koffi) + the WASM SQLite3MC engine
// with the read-only node:fs VFS + dataDir workspace, then runs the full linedb suite on fixtures that live
// OUTSIDE dataDir. The host's runPermissionSelfCheck (verbatim copy of selfCheck.ts) is run before the engine
// loads, after koffi + WASM are loaded, and at the end.
//
// argv[2] = base64url JSON ExternalHostInit, argv[3] = base64url JSON { fixtureDir, linedir, expected, int64 }.
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { runPermissionSelfCheck } from './teamuq-contract.mjs'
import { runAllVariants } from './linedb-suite.mjs'
import { createWasmSqliteCipherEngine } from '../../src/main/line/engine/wasmSqliteCipherEngine.ts'
import { createWin32LineFsPort } from '../../src/main/line/engine/native/win32fs.ts'
import { configureLineEnginePorts } from '../../src/main/line/engine/enginePorts.ts'
import * as linedb from '../../src/main/line/engine/linedb.ts'

const init = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'))
const cfg = JSON.parse(Buffer.from(process.argv[3], 'base64url').toString('utf8'))
const out = { runtime: { electron: process.versions.electron, node: process.version, abi: process.versions.modules }, argvFlags: process.execArgv }

const denied = (fn) => {
  try {
    fn()
    return { denied: false }
  } catch (e) {
    return { denied: e?.code === 'ERR_ACCESS_DENIED', code: e?.code ?? null }
  }
}

try {
  out.selfCheckBoot = runPermissionSelfCheck(init)

  // koffi comes from the fixed install stage (Phase 5 will replace this with the addon shim).
  const requireFromInstall = createRequire(join(init.installDir, 'package.json'))
  const loadKoffi = () => requireFromInstall('koffi')
  const t0 = performance.now()
  const engine = await createWasmSqliteCipherEngine({ wasmDir: join(init.installDir, 'vendor', 'sqlite3mc-wasm'), int64: cfg.int64 })
  const winFs = createWin32LineFsPort({ workspaceRoot: join(init.dataDir, 'line-engine'), loadKoffi })
  out.engine = { info: engine.info, name: engine.name, loadMs: Math.round(performance.now() - t0), initWarnings: engine.initWarnings, int64: engine.int64 }
  out.selfCheckAfterEngine = runPermissionSelfCheck(init)

  // Negative controls: Node fs (and therefore the VFS) cannot see the fixtures; only koffi can.
  out.controls = {
    nodeFsReadOutside: denied(() => fs.readFileSync(join(cfg.fixtureDir, 'wal', 'm.edb'))),
    nodeFsListOutside: denied(() => fs.readdirSync(cfg.fixtureDir)),
    nodeFsWriteOutside: denied(() => fs.writeFileSync(join(cfg.fixtureDir, 'should-not-exist.txt'), 'x')),
    vfsDirectOpenOutside: (() => {
      try {
        engine.open(join(cfg.fixtureDir, 'wal', 'm.edb'))
        return { denied: false }
      } catch (e) {
        return { denied: true, message: String(e?.message).slice(0, 120) }
      }
    })(),
    koffiSeesFixture: winFs.exists(join(cfg.fixtureDir, 'wal', 'm.edb')),
  }

  configureLineEnginePorts({ fs: winFs, sqlite: engine, dbDir: cfg.linedir })
  out.findDb = linedb.findDb()
  out.suite = runAllVariants(linedb, { fixtureDir: cfg.fixtureDir, expected: cfg.expected })
  // openDb with no explicit path goes through findDb() -> koffi readDir/stat -> koffi copy -> WASM
  const viaFind = linedb.openDb(cfg.expected.key)
  try {
    out.viaFindDb = { myMid: linedb.myMid(viaFind.con), count: viaFind.con.prepare('SELECT count(*) AS c FROM _message').get().c }
  } finally {
    viaFind.cleanup()
  }

  out.leaks = {
    openConnections: engine.openConnections(),
    vfsOpenFiles: engine.vfs.openFiles(),
    vfsShmNodes: engine.vfs.shmNodes(),
    workspaceEntries: fs.readdirSync(join(init.dataDir, 'line-engine')),
    vfsStats: engine.vfs.stats,
    wasmHeapMB: engine.wasmHeapMB(),
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
  }
  out.selfCheckEnd = runPermissionSelfCheck(init)
} catch (e) {
  out.fatal = String(e?.stack ?? e).slice(0, 2000)
}
process.stdout.write('RESULT:' + JSON.stringify(out) + '\n')
