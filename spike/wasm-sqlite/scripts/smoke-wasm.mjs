// Unpermissioned smoke test of the sqlite3mc WASM bundle: load, report versions, compile options,
// and whether an encrypted in-memory-FS round trip with the line-todo cipher params works.
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MJS = join(ROOT, 'vendor', 'sqlite3mc-2.5.1-sqlite-3.53.4-wasm', 'sqlite3mc-wasm-3530400', 'jswasm', 'sqlite3.mjs')
const { default: init } = await import(pathToFileURL(MJS).href)
const { readFileSync } = await import('node:fs')
const wasmBytes = readFileSync(join(dirname(MJS), 'sqlite3.wasm'))
const sqlite3 = await init({
  print: () => {},
  printErr: (s) => console.error('[wasm]', s),
  // Node has no fetch(file://); hand the bytes over directly (same approach the backend must use).
  instantiateWasm: (imports, onSuccess) => {
    WebAssembly.instantiate(wasmBytes, imports).then((r) => onSuccess(r.instance, r.module))
    return {}
  },
})
const out = { node: process.versions.node, electron: process.versions.electron ?? null }
out.sqliteVersion = sqlite3.version
const db = new sqlite3.oo1.DB(':memory:')
const q = (sql) => db.selectValues(sql)
out.mcVersion = db.selectValue('select sqlite3mc_version()')
out.compileOptions = q('pragma compile_options').filter((o) => /WAL|CIPHER|MC|CODEC|THREAD|OMIT|MMAP|SHM/i.test(o))
db.close()
out.vfsList = sqlite3.capi.sqlite3_js_vfs_list()
out.hasFS = typeof sqlite3.capi.sqlite3_js_posix_create_file === 'function'
// encrypted round trip on Emscripten FS
const enc = new sqlite3.oo1.DB('/smoke.db', 'c')
enc.exec(`PRAGMA cipher='aes128cbc'`)
enc.exec('PRAGMA kdf_iter=1')
enc.exec(`PRAGMA key='00112233445566778899aabbccddeeff'`)
enc.exec('create table t(a); insert into t values (42)')
enc.close()
const re = new sqlite3.oo1.DB('/smoke.db', 'w')
re.exec(`PRAGMA cipher='aes128cbc'`)
re.exec('PRAGMA kdf_iter=1')
re.exec(`PRAGMA key='00112233445566778899aabbccddeeff'`)
out.roundTrip = re.selectValue('select a from t')
re.close()
const bad = new sqlite3.oo1.DB('/smoke.db', 'w')
try { bad.exec(`PRAGMA cipher='aes128cbc'`); bad.exec(`PRAGMA key='wrong'`); bad.selectValue('select count(*) from sqlite_master'); out.wrongKeyRejected = false } catch (e) { out.wrongKeyRejected = true; out.wrongKeyError = String(e.message).slice(0, 120) }
bad.close()
console.log(JSON.stringify(out, null, 2))
