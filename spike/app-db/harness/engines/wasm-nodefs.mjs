// WASM candidate loader: SQLite3MultipleCiphers 2.5.1 WASM (copied into installDir/vendor/wasm by
// setup.mjs) + spike nodefs VFS + better-sqlite3-shaped adapter. cfg.wasmExclusive=true issues
// PRAGMA locking_mode=EXCLUSIVE right after open (the only way to get WAL without xShmMap).
import * as fs from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { installNodeFsVfs } from './wasm-nodefs-vfs.mjs'
import { makeWasmDatabaseClass } from './wasm-adapter.mjs'

const WASM_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor', 'wasm')

export async function loadEngine(cfg, init) {
  const { default: initModule } = await import(pathToFileURL(join(WASM_DIR, 'sqlite3.mjs')).href)
  const wasmBytes = fs.readFileSync(join(WASM_DIR, 'sqlite3.wasm'))
  const warnings = []
  const ow = console.warn, oe = console.error
  console.warn = (...a) => warnings.push(a.map(String).join(' ').split('\n')[0])
  console.error = (...a) => warnings.push(a.map(String).join(' ').split('\n')[0])
  let sqlite3
  try {
    sqlite3 = await initModule({
      print: () => {}, printErr: (s) => warnings.push(String(s)),
      instantiateWasm: (imports, onSuccess) => { WebAssembly.instantiate(wasmBytes, imports).then((r) => onSuccess(r.instance, r.module)); return {} },
    })
  } finally { console.warn = ow; console.error = oe }
  const tempDir = join(init.dataDir, '.wasm-tmp')
  fs.mkdirSync(tempDir, { recursive: true })
  const vfs = installNodeFsVfs(sqlite3, { name: 'nodefs', tempDir, syncMode: cfg.wasmSyncSkip ? 'skip-if-denied' : 'strict' })
  const WasmDatabase = makeWasmDatabaseClass(sqlite3, { vfsName: vfs.name, exclusive: !!cfg.wasmExclusive })
  const probe = new sqlite3.oo1.DB(':memory:')
  const info = {
    engine: 'sqlite3mc-wasm+nodefs-vfs', sqlite: probe.selectValue('select sqlite_version()'), mc: probe.selectValue('select sqlite3mc_version()'),
    vfsList: sqlite3.capi.sqlite3_js_vfs_list(), exclusiveLocking: !!cfg.wasmExclusive, syncMode: cfg.wasmSyncSkip ? 'skip-if-denied' : 'strict', initWarnings: warnings,
  }
  probe.close()
  return { info, factory: (filename, options) => new WasmDatabase(filename, options), adapterFiles: ['wasm-adapter.mjs', 'wasm-nodefs-vfs.mjs'], vfs }
}
