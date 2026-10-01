// better-sqlite3-shaped adapter over the SQLite3MC WASM oo1 API, opened on the spike nodefs VFS.
// oo1 differs from better-sqlite3 in every call the repos use: statements must be stepped/reset/
// finalized by hand, named parameters must carry their sigil (@x), run() has no {changes}, there is
// no pragma()/transaction(). This file is the adapter cost of the WASM option.
export function makeWasmDatabaseClass(sqlite3, { vfsName, exclusive }) {
  const { capi, oo1 } = sqlite3
  const toNum = (v) => (typeof v === 'bigint' && v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v)
  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v)

  class WasmStatement {
    constructor(db, sql) {
      this.db = db
      this.s = db.raw.prepare(sql)
      this.reader = this.s.columnCount > 0
      this.paramNames = []
      for (let i = 1; i <= this.s.parameterCount; i++) this.paramNames.push(this.s.getParamName(i))
    }
    bindArgs(args) {
      this.s.reset(true)
      if (!args.length) return
      if (args.length === 1 && isPlainObject(args[0])) {
        const o = args[0]
        const values = this.paramNames.map((n) => {
          if (!n || n[0] === '?') throw new TypeError('positional parameter used with a named-parameter object')
          const key = n.slice(1)
          if (!(key in o)) throw new RangeError(`Missing named parameter "${key}"`)
          return o[key]
        })
        this.s.bind(values)
      } else {
        this.s.bind(args)
      }
    }
    run(...args) {
      try {
        this.bindArgs(args)
        while (this.s.step()) { /* drain */ }
        return { changes: capi.sqlite3_changes(this.db.raw.pointer), lastInsertRowid: toNum(capi.sqlite3_last_insert_rowid(this.db.raw.pointer)) }
      } finally { this.s.reset(true) }
    }
    get(...args) {
      try { this.bindArgs(args); return this.s.step() ? this.s.get({}) : undefined } finally { this.s.reset(true) }
    }
    all(...args) {
      try { this.bindArgs(args); const rows = []; while (this.s.step()) rows.push(this.s.get({})); return rows } finally { this.s.reset(true) }
    }
  }

  return class WasmDatabase {
    constructor(filename, options = {}) {
      this.raw = new oo1.DB({ filename, flags: options.readonly ? 'r' : 'c', vfs: vfsName })
      this.cache = new Map() // sql -> WasmStatement (oo1 finalizes them on close)
      this.depth = 0
      if (exclusive) this.raw.exec('PRAGMA locking_mode=EXCLUSIVE')
      this.raw.exec(`PRAGMA busy_timeout=${options.timeout ?? 5000}`)
    }
    prepare(sql) {
      let st = this.cache.get(sql)
      if (!st) { st = new WasmStatement(this, sql); this.cache.set(sql, st) }
      return st
    }
    exec(sql) { this.raw.exec(sql); return this }
    pragma(source, options = {}) {
      const st = this.prepare(`PRAGMA ${source}`)
      if (options.simple) { const row = st.get(); return row === undefined ? undefined : Object.values(row)[0] }
      return st.all()
    }
    get inTransaction() { return capi.sqlite3_get_autocommit(this.raw.pointer) === 0 }
    get open() { return this.raw.isOpen() }
    transaction(fn) {
      const self = this
      return function sqliteTransaction(...args) {
        const nested = self.inTransaction
        const sp = `wsa_sp_${self.depth}`
        self.raw.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN')
        self.depth++
        try {
          const result = fn.apply(this, args)
          if (result && typeof result.then === 'function') throw new TypeError('Transaction function cannot return a promise')
          self.depth--
          self.raw.exec(nested ? `RELEASE ${sp}` : 'COMMIT')
          return result
        } catch (err) {
          self.depth--
          if (self.inTransaction) {
            self.raw.exec(nested ? `ROLLBACK TO ${sp}` : 'ROLLBACK')
            if (nested) self.raw.exec(`RELEASE ${sp}`)
          }
          throw err
        }
      }
    }
    close() { if (this.raw.isOpen()) this.raw.close(); this.cache.clear(); return this }
  }
}
