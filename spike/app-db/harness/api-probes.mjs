// Engine-level probes of the exact better-sqlite3 behaviours line-todo's src/main/db/** relies on
// (call-site survey in the report). Run on a scratch DB in dataDir through the SAME factory the
// bundled line-todo code uses, so adapter gaps show up here as differences vs better-sqlite3.
const capture = (fn) => { try { const v = fn(); return { ok: true, value: show(v) } } catch (e) { return { ok: false, error: `${e?.name ?? 'Error'}: ${String(e?.message ?? e).split('\n')[0].slice(0, 120)}`, code: e?.code ?? null } } }
function show(v) {
  if (v === undefined) return '<undefined>'
  if (typeof v === 'bigint') return `${v}n`
  if (Array.isArray(v)) return v.map(show)
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = show(x); return o }
  return v
}
const typeOf = (v) => (v === null ? 'null' : typeof v)

export function runApiProbes(factory, path) {
  const P = {}
  const db = factory(path)
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b INTEGER, r REAL, z BLOB)')
  // pragma(): simple and non-simple, assignment form (database.ts / migrate.ts)
  P.pragmaSimpleUserVersion = capture(() => db.pragma('user_version', { simple: true }))
  P.pragmaAssign = capture(() => db.pragma('user_version = 7'))
  P.pragmaSimpleAfterAssign = capture(() => db.pragma('user_version', { simple: true }))
  P.pragmaNonSimple = capture(() => db.pragma('table_info(t)').map((r) => r.name))
  P.pragmaJournalWal = capture(() => db.pragma('journal_mode = WAL'))
  P.pragmaQuickCheck = capture(() => db.pragma('quick_check', { simple: true }))
  // run(): positional; result shape + types (`.changes` is read everywhere)
  const ins = capture(() => db.prepare('INSERT INTO t(a,b,r) VALUES (?,?,?)').run('x', 1, 0.5))
  P.runPositional = ins
  P.runResultTypes = capture(() => { const r = db.prepare('INSERT INTO t(a,b) VALUES (?,?)').run('y', 2); return { changes: typeOf(r.changes), lastInsertRowid: typeOf(r.lastInsertRowid), keys: Object.keys(r).sort() } })
  // named parameters with bare keys (messages.repo / todos.repo / lineImport.repo use @name)
  P.runNamedAt = capture(() => db.prepare('INSERT INTO t(a,b) VALUES (@a,@b)').run({ a: 'n1', b: 3 }).changes)
  P.runNamedColon = capture(() => db.prepare('INSERT INTO t(a,b) VALUES (:a,:b)').run({ a: 'n2', b: 4 }).changes)
  P.runNamedDollar = capture(() => db.prepare('INSERT INTO t(a,b) VALUES ($a,$b)').run({ a: 'n3', b: 5 }).changes)
  P.namedReusedTwice = capture(() => db.prepare('SELECT @v AS x, @v AS y').get({ v: 9 }))
  P.namedExtraKey = capture(() => db.prepare('INSERT INTO t(a,b) VALUES (@a,@b)').run({ a: 'n4', b: 6, unused: 1 }).changes)
  P.namedMissingKey = capture(() => db.prepare('INSERT INTO t(a,b) VALUES (@a,@b)').run({ a: 'n5' }).changes)
  // get()/all(): no-row, spread args (getMessagesByIds uses .all(...ids)), row object shape
  P.getNoRow = capture(() => db.prepare('SELECT * FROM t WHERE id = ?').get(-1))
  P.allSpread = capture(() => db.prepare('SELECT a FROM t WHERE a IN (?,?,?) ORDER BY a').all('x', 'y', 'n1').map((r) => r.a))
  P.allEmpty = capture(() => db.prepare('SELECT * FROM t WHERE 0').all())
  P.rowPrototype = capture(() => { const r = db.prepare('SELECT a,b FROM t LIMIT 1').get(); const p = Object.getPrototypeOf(r); return p === Object.prototype ? 'Object.prototype' : p === null ? 'null' : 'other' })
  P.countType = capture(() => typeOf(db.prepare('SELECT COUNT(*) AS n FROM t').get().n))
  P.realType = capture(() => db.prepare('SELECT r FROM t WHERE r IS NOT NULL').get().r)
  // value binding edge cases (repos bind null/number/string only; these document the rest)
  P.bindNull = capture(() => db.prepare('SELECT ? AS v').get(null).v)
  P.bindUndefined = capture(() => db.prepare('SELECT ? AS v').get(undefined))
  P.bindBoolean = capture(() => db.prepare('SELECT ? AS v').get(true))
  P.bindBigInt = capture(() => db.prepare('SELECT ? AS v').get(9007199254740993n))
  P.readInt64Large = capture(() => db.prepare('SELECT 9007199254740993 AS v').get().v)
  P.bindBuffer = capture(() => { db.prepare('INSERT INTO t(a,z) VALUES (?,?)').run('blob', Buffer.from([1, 2, 3])); const z = db.prepare(`SELECT z FROM t WHERE a='blob'`).get().z; return { ctor: z?.constructor?.name, len: z?.length } })
  // exec(): multi-statement (migrate.ts / lineImport.repo.ts)
  P.execMulti = capture(() => { db.exec('CREATE TABLE m1(x); CREATE TABLE m2(y); INSERT INTO m1 VALUES (1);'); return db.prepare('SELECT count(*) n FROM m1').get().n })
  // transaction(): commit, args + return value, throw -> rollback, nested -> savepoint
  P.txCommit = capture(() => db.transaction((a, b) => { db.prepare('INSERT INTO t(a,b) VALUES (?,?)').run(a, b); return a + b })('tx', 1))
  P.txRollback = capture(() => { const before = db.prepare('SELECT count(*) n FROM t').get().n; try { db.transaction(() => { db.prepare('INSERT INTO t(a) VALUES (?)').run('gone'); throw new Error('boom') })() } catch {} ; return { unchanged: db.prepare('SELECT count(*) n FROM t').get().n === before, inTransaction: db.inTransaction } })
  P.txNestedInnerRollback = capture(() => {
    const outer = db.transaction(() => {
      db.prepare('INSERT INTO t(a) VALUES (?)').run('outer-kept')
      try { db.transaction(() => { db.prepare('INSERT INTO t(a) VALUES (?)').run('inner-gone'); throw new Error('inner') })() } catch {}
      return db.inTransaction
    })
    const inside = outer()
    return { insideWasTx: inside, outerKept: !!db.prepare(`SELECT 1 FROM t WHERE a='outer-kept'`).get(), innerGone: !db.prepare(`SELECT 1 FROM t WHERE a='inner-gone'`).get(), inTransactionAfter: db.inTransaction }
  })
  P.txNestedOuterRollback = capture(() => {
    try { db.transaction(() => { db.transaction(() => db.prepare('INSERT INTO t(a) VALUES (?)').run('nested-ok'))(); throw new Error('outer') })() } catch {}
    return { nestedRolledBackWithOuter: !db.prepare(`SELECT 1 FROM t WHERE a='nested-ok'`).get() }
  })
  P.txPromiseRejected = capture(() => db.transaction(async () => 1)())
  P.statementReuse = capture(() => { const s = db.prepare('SELECT a FROM t WHERE id = ?'); return [s.get(1)?.a, s.get(2)?.a, s.all(1).length] })
  P.doubleQuotedStringLiteral = capture(() => db.prepare('SELECT "not-a-column" AS v').get())
  P.foreignKeysDefault = capture(() => { const d2 = factory(path.replace(/\.db$/, '-fk.db')); const v = d2.pragma('foreign_keys', { simple: true }); d2.close(); return v })
  db.close()
  return P
}
