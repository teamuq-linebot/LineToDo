// sqlite3mc WASM engine adapter. Loads the official SQLite3MultipleCiphers WASM build from the
// readable install stage, and opens a dataDir snapshot (edb [+ -wal + -shm]) with the exact
// linedb.ts openDb() sequence: RW open of the copy -> PRAGMA cipher -> kdf_iter -> key ->
// SELECT count(*) FROM sqlite_master -> PRAGMA wal_checkpoint(TRUNCATE) (non-fatal).
//
// The stock WASM build only ships Emscripten MEMFS-backed VFSes in Node ("unix*",
// "multipleciphers-unix-none" is the default), so the snapshot bytes are read from dataDir with
// node:fs (dataDir IS readable under the 1.6.8 flags) and placed into MEMFS via
// sqlite3_js_posix_create_file(). No native addon is involved.
import * as fs from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const WASM_DIR = join(HERE, '..', 'vendor', 'sqlite3mc-2.5.1-sqlite-3.53.4-wasm', 'sqlite3mc-wasm-3530400', 'jswasm')

export async function loadEngine() {
  const { default: init } = await import(pathToFileURL(join(WASM_DIR, 'sqlite3.mjs')).href)
  const wasmBytes = fs.readFileSync(join(WASM_DIR, 'sqlite3.wasm'))
  const warnings = []
  const origWarn = console.warn; const origErr = console.error
  console.warn = (...a) => warnings.push(a.map(String).join(' ').split('\n')[0])
  console.error = (...a) => warnings.push(a.map(String).join(' ').split('\n')[0])
  let sqlite3
  try {
    sqlite3 = await init({
      print: () => {},
      printErr: (s) => warnings.push(String(s)),
      instantiateWasm: (imports, onSuccess) => {
        WebAssembly.instantiate(wasmBytes, imports).then((r) => onSuccess(r.instance, r.module))
        return {}
      },
    })
  } finally { console.warn = origWarn; console.error = origErr }
  const probe = new sqlite3.oo1.DB(':memory:')
  const info = { engine: 'sqlite3mc-wasm', sqlite: probe.selectValue('select sqlite_version()'), mc: probe.selectValue('select sqlite3mc_version()'), defaultVfs: sqlite3.capi.sqlite3_js_vfs_list()[0], initWarnings: warnings }
  probe.close()
  let seq = 0
  return {
    info,
    sqlite3,
    // linekey.ts BatchVerifier pattern: copy the edb once, then per candidate open a readonly
    // connection, apply cipher/kdf_iter/key and probe sqlite_master. Returns per-key booleans.
    keyScan(srcBase, keys, cipher, kdfIter) {
      const memPath = `/scan${++seq}.edb`
      const buf = fs.readFileSync(srcBase)
      sqlite3.capi.sqlite3_js_posix_create_file(memPath, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
      const res = keys.map((k) => {
        let db = null
        try {
          db = new sqlite3.oo1.DB(memPath, 'r')
          db.exec(`PRAGMA cipher='${cipher}'`); db.exec(`PRAGMA kdf_iter=${kdfIter}`); db.exec(`PRAGMA key='${k}'`)
          db.selectValue('SELECT count(*) FROM sqlite_master')
          return true
        } catch { return false } finally { try { db?.close() } catch {} }
      })
      const w = sqlite3.wasm; const p = w.allocCString(memPath)
      try { w.exports.sqlite3__wasm_vfs_unlink(sqlite3.capi.sqlite3_vfs_find(null), p) } finally { w.dealloc(p) }
      return res
    },
    // srcBase: absolute path of "<dataDir>/.../m.edb" ; mode 'w' (RW, as linedb) or 'r' (readonly)
    openSnapshot(srcBase, key, cipher, kdfIter, { mode = 'w', withSidecars = true, exclusive = false } = {}) {
      const t = {}
      let t0 = performance.now()
      const memPath = `/snap${++seq}.edb` // MEMFS root (posix_create_file does not mkdir)
      const created = []
      for (const ext of withSidecars ? ['', '-wal', '-shm'] : ['']) {
        if (fs.existsSync(srcBase + ext)) {
          const buf = fs.readFileSync(srcBase + ext)
          // must be a plain Uint8Array (a Node Buffer subclass trips heapForSize())
          const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
          sqlite3.capi.sqlite3_js_posix_create_file(memPath + ext, bytes)
          created.push(memPath + ext)
        }
      }
      t.loadBytesMs = performance.now() - t0
      t0 = performance.now()
      const db = new sqlite3.oo1.DB(memPath, mode)
      const cleanup = () => {
        try { db.close() } catch {}
        // free the MEMFS copies (sqlite3.util is deleted after init, so call the raw wasm export)
        const w = sqlite3.wasm
        const pVfs = sqlite3.capi.sqlite3_vfs_find(null)
        for (const ext of ['', '-wal', '-shm', '-journal']) {
          const p = w.allocCString(memPath + ext)
          try { w.exports.sqlite3__wasm_vfs_unlink(pVfs, p) } catch {} finally { w.dealloc(p) }
        }
      }
      try {
        if (exclusive) db.exec('PRAGMA locking_mode=EXCLUSIVE')
        db.exec(`PRAGMA cipher='${cipher}'`)
        db.exec(`PRAGMA kdf_iter=${kdfIter}`)
        db.exec(`PRAGMA key='${key}'`)
        db.selectValue('SELECT count(*) FROM sqlite_master')
      } catch (e) {
        cleanup()
        const err = new Error('decryption failed — wrong key or cipher params: ' + String(e.message).slice(0, 160))
        err.inner = String(e.message)
        throw err
      }
      t.openVerifyMs = performance.now() - t0
      t0 = performance.now()
      let checkpoint = null
      if (mode === 'w') { try { checkpoint = db.selectArray('PRAGMA wal_checkpoint(TRUNCATE)') } catch (e) { checkpoint = 'ERR ' + String(e.message).slice(0, 120) } }
      t.checkpointMs = performance.now() - t0
      const journalMode = db.selectValue('PRAGMA journal_mode')
      const adapter = {
        get: (sql, args) => db.selectObject(sql, args.length ? args : undefined),
        all: (sql, args) => db.selectObjects(sql, args.length ? args : undefined),
      }
      return { adapter, cleanup, timings: t, checkpoint, journalMode, memFiles: created }
    },
  }
}
