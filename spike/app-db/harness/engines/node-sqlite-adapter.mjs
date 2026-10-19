// Minimal better-sqlite3-shaped adapter over the runtime's built-in node:sqlite (DatabaseSync).
// Covers exactly the surface line-todo's src/main/db/** uses: new Database(path), prepare(sql)
// -> {run,get,all}, exec, pragma(src,{simple}), transaction(fn) (nested -> SAVEPOINT), close.
// Statements are handed out natively (StatementSync already has run/get/all with better-sqlite3
// argument conventions); only the two named-parameter strictness differences are aligned.
import { DatabaseSync } from 'node:sqlite'

export default class NodeSqliteDatabase {
  constructor(filename, options = {}) {
    this.inner = new DatabaseSync(filename, { readOnly: !!options.readonly, timeout: options.timeout ?? 5000 })
    this.depth = 0
  }
  prepare(sql) {
    const stmt = this.inner.prepare(sql)
    // better-sqlite3 ignores object keys that are not parameters of the statement; node:sqlite throws
    if (typeof stmt.setAllowUnknownNamedParameters === 'function') stmt.setAllowUnknownNamedParameters(true)
    return stmt
  }
  exec(sql) { this.inner.exec(sql); return this }
  pragma(source, options = {}) {
    const stmt = this.inner.prepare(`PRAGMA ${source}`)
    if (options.simple) { const row = stmt.get(); return row === undefined ? undefined : Object.values(row)[0] }
    return stmt.all()
  }
  get inTransaction() { return this.inner.isTransaction }
  get open() { return this.inner.isOpen }
  transaction(fn) {
    const self = this
    return function sqliteTransaction(...args) {
      const nested = self.inner.isTransaction
      const sp = `nsa_sp_${self.depth}`
      self.inner.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN')
      self.depth++
      try {
        const result = fn.apply(this, args)
        if (result && typeof result.then === 'function') throw new TypeError('Transaction function cannot return a promise')
        self.depth--
        self.inner.exec(nested ? `RELEASE ${sp}` : 'COMMIT')
        return result
      } catch (err) {
        self.depth--
        if (self.inner.isTransaction) {
          self.inner.exec(nested ? `ROLLBACK TO ${sp}` : 'ROLLBACK')
          if (nested) self.inner.exec(`RELEASE ${sp}`)
        }
        throw err
      }
    }
  }
  close() { if (this.inner.isOpen) this.inner.close(); return this }
}
