import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import NativeDatabase from 'better-sqlite3-plugin'
import { createBetterSqlite3AppEngine } from '../src/main/db/appDbEngine.ts'
import { openDatabase } from '../src/main/db/database.ts'
import * as migration from '../src/main/db/migrate.ts'
import { ensureLineImportSchema } from '../src/main/db/lineImport.repo.ts'
import { SCHEMA_VERSION } from '../src/main/db/schema.ts'

const { migrate } = migration
const PENDING_INDEX_NAME = 'idx_messages_pending_ts'
const BASE_TS = 1_700_000_000_000

function openFixture() {
  const engine = createBetterSqlite3AppEngine({ driver: NativeDatabase })
  return openDatabase({ dbPath: ':memory:', engine })
}

function indexNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='messages' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name)
}

function seedBulk(db, { messages, chats, blockedChats = 0 }) {
  const insert = db.transaction(() => {
    db.exec(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${chats - 1})
       INSERT INTO chats(chat_id, name, is_group, blocked, first_seen_at, last_seen_at)
       SELECT 'c' || i, 'chat ' || i, i % 2, CASE WHEN i < ${blockedChats} THEN 1 ELSE 0 END, '2026-01-01', '2026-01-01' FROM n`
    )
    db.exec(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${messages - 1})
       INSERT INTO messages(msg_id, chat_id, ts, time_iso, direction, sender, text, content_type, processed, ingested_at)
       SELECT 'bulk' || i,
              'c' || CASE WHEN i % 10 < 3 THEN i % ${chats} ELSE i % ${Math.max(1, Math.floor(chats / 10))} END,
              ${BASE_TS} + i * 1000, '2026-01-01T00:00:00', 'in', NULL, 'x', 0,
              CASE WHEN i % 100 < 69 THEN 0 ELSE 1 END, '2026-01-01' FROM n`
    )
  })
  insert()
}

test('fresh database builds the v10 index set: partial pending index in, the two superseded indexes out', () => {
  const opened = openFixture()
  try {
    assert.equal(SCHEMA_VERSION, 11)
    assert.equal(opened.db.pragma('user_version', { simple: true }), 11)
    const names = indexNames(opened.db)
    assert.ok(names.includes(PENDING_INDEX_NAME), names.join(','))
    assert.ok(names.includes('idx_messages_chat_ts_msg'))
    assert.ok(!names.includes('idx_messages_chat_ts'), 'idx_messages_chat_ts is not built on new databases')
    assert.ok(!names.includes('idx_messages_unproc'), 'idx_messages_unproc is not built on new databases')
    const ddl = opened.db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(PENDING_INDEX_NAME).sql
    assert.match(ddl, /WHERE processed = 0/u)
  } finally {
    opened.close()
  }
})

test('migrate v8 to v10: creates the partial index first, then drops the two superseded indexes, leaves rows untouched', () => {
  const opened = openFixture()
  try {
    const { db } = opened
    seedBulk(db, { messages: 500, chats: 20 })
    db.exec('DROP INDEX idx_messages_pending_ts; CREATE INDEX idx_messages_chat_ts ON messages(chat_id, ts); CREATE INDEX idx_messages_unproc ON messages(processed, chat_id); PRAGMA user_version = 8;')
    const before = db.prepare('SELECT msg_id, chat_id, ts, processed FROM messages ORDER BY msg_id').all()
    assert.deepEqual(indexNames(db).filter((name) => /pending|chat_ts$|unproc/u.test(name)), ['idx_messages_chat_ts', 'idx_messages_unproc'])

    assert.deepEqual(migrate(db), { from: 8, to: 11 })

    assert.equal(db.pragma('user_version', { simple: true }), 11)
    const names = indexNames(db)
    assert.ok(names.includes(PENDING_INDEX_NAME))
    assert.ok(!names.includes('idx_messages_chat_ts'), 'M-I1 dropped it')
    assert.ok(!names.includes('idx_messages_unproc'), 'M-I2 dropped it')
    assert.deepEqual(db.prepare('SELECT msg_id, chat_id, ts, processed FROM messages ORDER BY msg_id').all(), before)
    const pending = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE processed = 0').get().n
    const viaIndex = db.prepare(`SELECT COUNT(*) AS n FROM messages INDEXED BY ${PENDING_INDEX_NAME} WHERE processed = 0`).get().n
    assert.equal(viaIndex, pending, 'the partial index covers every pending row')
    assert.deepEqual(migrate(db), { from: 11, to: 11 })
  } finally {
    opened.close()
  }
})

const PARTICIPANTS_INDEX = 'idx_message_participants_chat_key'
const OLD_INDEXES = ['idx_messages_chat_ts', 'idx_messages_unproc']

function makeV9Database(opened, { messages = 600, chats = 20 } = {}) {
  const { db } = opened
  ensureLineImportSchema(db)
  seedBulk(db, { messages, chats })
  db.exec(`
    CREATE INDEX idx_messages_chat_ts ON messages(chat_id, ts);
    CREATE INDEX idx_messages_unproc ON messages(processed, chat_id);
    CREATE INDEX ${PARTICIPANTS_INDEX} ON message_participants(chat_id, participant_key);
    INSERT INTO message_participants(msg_id, chat_id, participant_key, scope, key_version, identity_status, identity_reason, is_me)
      SELECT msg_id, chat_id, NULL, 'unknown', NULL, 'unknown', 'safe_storage_unavailable', CASE direction WHEN 'out' THEN 1 ELSE 0 END FROM messages;
    PRAGMA user_version = 9;
  `)
  return db
}

function allIndexNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name)
}

function schemaSnapshot(db) {
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map((row) => ({ ...row }))
}

function count(db, table) {
  return db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n
}

function quiet(fn) {
  const warns = []
  const saved = { warn: console.warn, info: console.info, log: console.log }
  console.warn = (...args) => { warns.push(args.join(' ')) }
  console.info = () => {}
  console.log = () => {}
  try {
    return { result: fn(), warns }
  } finally {
    console.warn = saved.warn
    console.info = saved.info
    console.log = saved.log
  }
}

function assertHealthy(db) {
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
  assert.deepEqual(db.pragma('foreign_key_check'), [])
}

test('migrate v9 to v10: all three indexes are gone, message_participants is an empty table of the standard shape, user_version is 10', () => {
  const opened = openFixture()
  try {
    const db = makeV9Database(opened)
    const messagesBefore = db.prepare('SELECT msg_id, chat_id, ts, processed FROM messages ORDER BY msg_id').all()
    assert.equal(count(db, 'message_participants'), 600)
    assert.deepEqual(OLD_INDEXES.concat(PARTICIPANTS_INDEX).filter((name) => !allIndexNames(db).includes(name)), [])

    const { result, warns } = quiet(() => migrate(db))
    assert.deepEqual(result, { from: 9, to: 11 })
    assert.deepEqual(warns, [])

    const names = allIndexNames(db)
    for (const gone of OLD_INDEXES.concat(PARTICIPANTS_INDEX)) assert.ok(!names.includes(gone), gone + ' still exists')
    assert.ok(names.includes(PENDING_INDEX_NAME))
    assert.ok(names.includes('idx_messages_chat_ts_msg'))
    assert.equal(count(db, 'message_participants'), 0)
    assert.equal(db.pragma('user_version', { simple: true }), 11)
    assert.deepEqual(db.prepare('SELECT msg_id, chat_id, ts, processed FROM messages ORDER BY msg_id').all(), messagesBefore)

    const fresh = openFixture()
    try {
      ensureLineImportSchema(fresh.db)
      const shape = (handle) => handle.prepare("SELECT sql FROM sqlite_master WHERE name = 'message_participants'").get().sql
      assert.equal(shape(db), shape(fresh.db), 'the recreated table is the ensureLineImportSchema table')
    } finally {
      fresh.close()
    }
    db.prepare("INSERT INTO message_participants(msg_id, chat_id, scope, identity_status, identity_reason, is_me) SELECT msg_id, chat_id, 'unknown', 'unknown', 'safe_storage_unavailable', 0 FROM messages LIMIT 1").run()
    assert.equal(count(db, 'message_participants'), 1, 'the recreated table accepts rows')
    assertHealthy(db)
  } finally {
    opened.close()
  }
})

test('migrate v10 M-P1 is skipped as a whole when a keyed row exists; M-I1 and M-I2 still run', () => {
  const opened = openFixture()
  try {
    const db = makeV9Database(opened)
    db.exec("UPDATE message_participants SET participant_key = 'k-1', scope = 'chat', key_version = 1, identity_status = 'keyed', identity_reason = NULL WHERE msg_id = (SELECT msg_id FROM message_participants LIMIT 1)")
    const participantsBefore = db.prepare('SELECT * FROM message_participants ORDER BY msg_id').all()

    const { result, warns } = quiet(() => migrate(db))
    assert.deepEqual(result, { from: 9, to: 11 })
    assert.equal(warns.length, 1, warns.join(' | '))
    assert.match(warns[0], /M-P1 skipped.*participant_key IS NOT NULL/u)

    assert.deepEqual(db.prepare('SELECT * FROM message_participants ORDER BY msg_id').all(), participantsBefore)
    const names = allIndexNames(db)
    assert.ok(names.includes(PARTICIPANTS_INDEX), 'M-I3 belongs to M-P1 and is skipped with it')
    for (const gone of OLD_INDEXES) assert.ok(!names.includes(gone), gone + ' still exists')
    assert.equal(db.pragma('user_version', { simple: true }), 11)
    assertHealthy(db)
  } finally {
    opened.close()
  }
})

test('migrate v10 M-P1 is skipped when any row is not scope=unknown AND identity_status=unknown', () => {
  const opened = openFixture()
  try {
    const db = makeV9Database(opened)
    db.exec("UPDATE message_participants SET scope = 'chat' WHERE msg_id = (SELECT msg_id FROM message_participants LIMIT 1)")
    const { warns } = quiet(() => migrate(db))
    assert.equal(warns.length, 1, warns.join(' | '))
    assert.match(warns[0], /M-P1 skipped.*not scope=unknown/u)
    assert.equal(count(db, 'message_participants'), 600)
    assert.ok(allIndexNames(db).includes(PARTICIPANTS_INDEX))
    for (const gone of OLD_INDEXES) assert.ok(!allIndexNames(db).includes(gone))
  } finally {
    opened.close()
  }
})

test('migrate v10 M-I2 is skipped while idx_messages_pending_ts does not exist; the other steps still run', () => {
  const opened = openFixture()
  try {
    const db = makeV9Database(opened)
    db.exec('DROP INDEX ' + PENDING_INDEX_NAME)
    const { result, warns } = quiet(() => migrate(db))
    assert.deepEqual(result, { from: 9, to: 11 })
    assert.equal(warns.length, 1, warns.join(' | '))
    assert.match(warns[0], /M-I2 skipped.*idx_messages_pending_ts/u)
    const names = allIndexNames(db)
    assert.ok(names.includes('idx_messages_unproc'), 'the old pending index stays until the partial index exists')
    assert.ok(!names.includes('idx_messages_chat_ts'))
    assert.ok(!names.includes(PARTICIPANTS_INDEX))
    assert.equal(count(db, 'message_participants'), 0)
  } finally {
    opened.close()
  }
})

test('migrate v8 to v10 creates the partial index before M-I2 runs, so M-I2 is not skipped', () => {
  const opened = openFixture()
  try {
    const db = makeV9Database(opened)
    db.exec('DROP INDEX ' + PENDING_INDEX_NAME + '; PRAGMA user_version = 8;')
    const { result, warns } = quiet(() => migrate(db))
    assert.deepEqual(result, { from: 8, to: 11 })
    assert.deepEqual(warns, [])
    assert.ok(allIndexNames(db).includes(PENDING_INDEX_NAME))
    assert.ok(!allIndexNames(db).includes('idx_messages_unproc'))
  } finally {
    opened.close()
  }
})

test('migrate v10 is idempotent: re-running it (also with user_version forced back to 9) changes nothing', () => {
  const opened = openFixture()
  try {
    const db = makeV9Database(opened)
    quiet(() => migrate(db))
    const afterFirst = schemaSnapshot(db)
    const rowsFirst = db.prepare('SELECT msg_id, processed FROM messages ORDER BY msg_id').all()

    assert.deepEqual(quiet(() => migrate(db)).result, { from: 11, to: 11 })
    db.pragma('user_version = 9')
    const again = quiet(() => migrate(db))
    assert.deepEqual(again.result, { from: 9, to: 11 })
    assert.deepEqual(again.warns, [])
    assert.deepEqual(schemaSnapshot(db), afterFirst)
    assert.deepEqual(db.prepare('SELECT msg_id, processed FROM messages ORDER BY msg_id').all(), rowsFirst)
    assert.equal(count(db, 'message_participants'), 0)

    const report = quiet(() => db.transaction(() => migration.runStorageMaintenanceV10(db))()).result
    assert.equal(report.changed, false)
    assert.deepEqual(report.steps.map((step) => step.status), ['noop', 'noop', 'noop'])
  } finally {
    opened.close()
  }
})

test('migrate v10 failing half way rolls everything back: indexes, participants rows and user_version', () => {
  const opened = openFixture()
  try {
    const db = makeV9Database(opened)
    const before = schemaSnapshot(db)
    const rowsBefore = count(db, 'message_participants')
    const failing = new Proxy(db, {
      get(target, prop) {
        const value = target[prop]
        if (prop === 'exec') {
          return (sql) => {
            if (/CREATE TABLE IF NOT EXISTS message_participants/u.test(sql)) throw new Error('injected failure after the drops')
            return target.exec(sql)
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    quiet(() => assert.throws(() => migrate(failing), /injected failure after the drops/u))
    assert.equal(db.pragma('user_version', { simple: true }), 9)
    assert.deepEqual(schemaSnapshot(db), before)
    assert.equal(count(db, 'message_participants'), rowsBefore)
    assertHealthy(db)
  } finally {
    opened.close()
  }
})

test('migrate v10 on a file database checkpoints the WAL afterwards (M-W) and the data survives a reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wp-m-wal-'))
  const dbPath = join(dir, 'line-todo.db')
  const engine = createBetterSqlite3AppEngine({ driver: NativeDatabase })
  try {
    const first = openDatabase({ dbPath, engine })
    makeV9Database(first, { messages: 3000, chats: 30 })
    first.close()

    const second = quiet(() => openDatabase({ dbPath, engine })).result
    try {
      assert.equal(second.db.pragma('user_version', { simple: true }), 11)
      assert.equal(count(second.db, 'message_participants'), 0)
      const walPath = dbPath + '-wal'
      assert.ok(!existsSync(walPath) || statSync(walPath).size === 0, 'wal_checkpoint(TRUNCATE) left an empty WAL')
      assert.equal(count(second.db, 'messages'), 3000)
      assertHealthy(second.db)
    } finally {
      second.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
