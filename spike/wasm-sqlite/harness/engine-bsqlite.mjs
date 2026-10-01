// better-sqlite3-multiple-ciphers 11.10.0 engine adapter (baseline; ABI 125 = Electron 31 only).
// Opens the dataDir snapshot in place with the exact linedb.ts openDb() sequence. Snapshot is in
// dataDir, so the wrapper's fs.existsSync(dirname) guard is inside the readable scope.
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

export async function loadEngine() {
  const Database = require('better-sqlite3-multiple-ciphers')
  const probe = new Database(':memory:')
  const info = { engine: 'better-sqlite3-multiple-ciphers', sqlite: probe.prepare('select sqlite_version() v').get().v, mc: probe.prepare('select sqlite3mc_version() v').get().v }
  probe.close()
  return {
    info,
    // linekey.ts BatchVerifier.test(): readonly+fileMustExist open per candidate on one copy.
    keyScan(srcBase, keys, cipher, kdfIter) {
      return keys.map((k) => {
        let con = null
        try {
          con = new Database(srcBase, { readonly: true, fileMustExist: true })
          con.pragma(`cipher='${cipher}'`); con.pragma(`kdf_iter=${kdfIter}`); con.pragma(`key='${k}'`)
          con.prepare('SELECT count(*) FROM sqlite_master').get()
          return true
        } catch { return false } finally { try { con?.close() } catch {} }
      })
    },
    openSnapshot(srcBase, key, cipher, kdfIter, { mode = 'w' } = {}) {
      const t = { loadBytesMs: 0 }
      let t0 = performance.now()
      const con = mode === 'r' ? new Database(srcBase, { readonly: true, fileMustExist: true }) : new Database(srcBase)
      const cleanup = () => { try { con.close() } catch {} }
      try {
        con.pragma(`cipher='${cipher}'`)
        con.pragma(`kdf_iter=${kdfIter}`)
        con.pragma(`key='${key}'`)
        con.prepare('SELECT count(*) FROM sqlite_master').get()
      } catch (e) {
        cleanup()
        const err = new Error('decryption failed — wrong key or cipher params: ' + String(e.message).slice(0, 160))
        err.inner = String(e.message)
        throw err
      }
      t.openVerifyMs = performance.now() - t0
      t0 = performance.now()
      let checkpoint = null
      if (mode === 'w') { try { checkpoint = Object.values(con.pragma('wal_checkpoint(TRUNCATE)')[0]) } catch (e) { checkpoint = 'ERR ' + String(e.message).slice(0, 120) } }
      t.checkpointMs = performance.now() - t0
      const journalMode = con.pragma('journal_mode', { simple: true })
      // linedb.ts calls con.prepare() on every query (no statement cache); mirrored here.
      // (The WASM oo1 selectObject/selectObjects likewise prepare+finalize per call.)
      const adapter = {
        get: (sql, args) => con.prepare(sql).get(...args),
        all: (sql, args) => con.prepare(sql).all(...args),
      }
      return { adapter, cleanup, timings: t, checkpoint, journalMode, memFiles: [] }
    },
  }
}
