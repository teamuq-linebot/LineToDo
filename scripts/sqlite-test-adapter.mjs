import { DatabaseSync } from 'node:sqlite'

/** Adapter with the subset of better-sqlite3 used by the focused pure repository tests. */
export default class SqliteTestAdapter {
  constructor(path) {
    this.inner = new DatabaseSync(path)
    this.transactionDepth = 0
  }
  exec(sql) { return this.inner.exec(sql) }
  prepare(sql) { return this.inner.prepare(sql) }
  pragma(sql, options = {}) {
    const statement = sql.startsWith('PRAGMA ') ? sql : `PRAGMA ${sql}`
    if (options.simple) {
      const row = this.inner.prepare(statement).get()
      return row ? Object.values(row)[0] : undefined
    }
    return this.inner.prepare(statement).all()
  }
  transaction(callback) {
    return (...args) => {
      const savepoint = `line_import_test_${this.transactionDepth}`
      const nested = this.transactionDepth > 0
      this.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE')
      this.transactionDepth++
      try {
        const result = callback(...args)
        this.transactionDepth--
        this.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT')
        return result
      } catch (error) {
        this.transactionDepth--
        this.exec(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}` : 'ROLLBACK')
        if (nested) this.exec(`RELEASE SAVEPOINT ${savepoint}`)
        throw error
      }
    }
  }
  close() { return this.inner.close() }
}
