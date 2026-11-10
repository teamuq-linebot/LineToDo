// LINE address-book sync: the `line_entity` table (lineEntity.repo.ts), the keyset readers (linedb.ts), the sync worker (contactSync.ts),
// the reader (lineAvatar.repo.ts / avatarReader.ts: address book for non-Square, sender copy for Square members, nothing otherwise) and the production wiring (assemble.ts).
// The LINE side is synthetic: a plain SQLite file with the LINE table shapes behind a fake connection; time is injected (now, wallClock, sleep, yieldLoop),
// there is no wall-clock threshold anywhere, no real LINE, key or network is touched.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import Database from 'better-sqlite3'

import * as linedb from '../../src/main/line/engine/linedb.ts'
import { configureLineEnginePorts, resetLineEnginePorts } from '../../src/main/line/engine/enginePorts.ts'
import { createNodeLineFsPort } from '../../src/main/line/engine/nodeLineFsPort.ts'
import { walSig } from '../../src/main/line/engine/watchEngine.ts'
import { createLineAccess } from '../../src/main/line/engine/lineAccess.ts'
import { avatarCacheKey } from '../../src/plugin/backend/avatarCache.ts'
import { createPluginBackend } from '../../src/plugin/backend/assemble.ts'
import { createContactSync, normalizeSourceSig } from '../../src/plugin/backend/contactSync.ts'
import { openDatabase } from '../../src/main/db/database.ts'
import { createLayeredAvatarReader } from '../../src/plugin/backend/avatarReader.ts'
import { ensureLineAvatarSchema, isLineAvatarSchemaReady, readLocalAvatars } from '../../src/main/db/lineAvatar.repo.ts'
import { ENTITY_KINDS, countEntities, deleteEntities, ensureLineEntitySchema, entityMids, isLineEntitySchemaReady, readEntities, upsertEntity } from '../../src/main/db/lineEntity.repo.ts'

const DAY = 24 * 60 * 60 * 1000

// ───────────── helpers ─────────────

/** An app DB (the real schema, foreign keys on) with the four old avatar tables; `entity` also creates line_entity. */
function appDbWith({ entity = false, chats = [] } = {}) {
  const opened = openDatabase({ dbPath: ':memory:' })
  const db = opened.db
  ensureLineAvatarSchema(db)
  if (entity) ensureLineEntitySchema(db)
  const at = new Date('2026-11-02T00:00:00.000Z').toISOString()
  for (const chat of chats) db.prepare('INSERT INTO chats(chat_id,name,is_group,blocked,first_seen_at,last_seen_at) VALUES (?,?,1,0,?,?)').run(chat, chat, at, at)
  return db
}

const entityRows = (db) => db.prepare('SELECT * FROM line_entity ORDER BY kind, entity_mid').all().map((row) => ({ ...row }))
const tableDump = (db, table) => JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all())
const OLD_TABLES = ['line_avatar_meta', 'line_chat_avatar', 'line_sender_profile', 'line_message_sender']

// ───────────── S: schema ─────────────

test('S-1 schema: ensureLineEntitySchema on a database with the four old tables adds line_entity, leaves the old tables byte-for-byte alone, and is idempotent', () => {
  const db = appDbWith({ chats: ['c-room-0'] })
  try {
    db.prepare("INSERT INTO line_chat_avatar(chat_id,source,locator,display_name,refreshed_at) VALUES ('c-room-0','profile','/p/room','Room',5)").run()
    db.prepare("INSERT INTO line_sender_profile(chat_id,sender_mid,source,locator,display_name,refreshed_at) VALUES ('c-room-0','u-a','profile','/p/a','A',6)").run()
    const before = OLD_TABLES.map((t) => tableDump(db, t))
    assert.equal(isLineEntitySchemaReady(db), false)
    ensureLineEntitySchema(db)
    assert.equal(isLineEntitySchemaReady(db), true)
    const afterFirst = db.prepare("SELECT sql FROM sqlite_master WHERE name='line_entity'").get().sql
    ensureLineEntitySchema(db)
    assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name='line_entity'").get().sql, afterFirst, 'a second run changes nothing')
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='line_entity'").get().n, 1)
    assert.deepEqual(OLD_TABLES.map((t) => tableDump(db, t)), before, 'the old tables are verbatim the same')
  } finally { db.close() }
})

test('S-2 schema: isLineAvatarSchemaReady does not depend on whether line_entity exists', () => {
  const without = appDbWith()
  const withEntity = appDbWith({ entity: true })
  try {
    assert.equal(isLineAvatarSchemaReady(without), true)
    assert.equal(isLineAvatarSchemaReady(withEntity), true)
    withEntity.exec('DROP TABLE line_entity')
    assert.equal(isLineAvatarSchemaReady(withEntity), true, 'dropping the new table never turns the avatar feature off')
    assert.equal(isLineEntitySchemaReady(withEntity), false)
  } finally { without.close(); withEntity.close() }
})

test('S-3 schema: the columns of line_entity are exactly the design (no raw JSON column, no gone mark), the key is (kind, entity_mid), and the CHECKs reject bad values', () => {
  const db = appDbWith({ entity: true })
  try {
    const columns = db.prepare("PRAGMA table_info('line_entity')").all().map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, pk: c.pk }))
    assert.deepEqual(columns, [
      { name: 'kind', type: 'TEXT', notnull: 1, pk: 1 },
      { name: 'entity_mid', type: 'TEXT', notnull: 1, pk: 2 },
      { name: 'source', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'locator', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'display_name', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'synced_at', type: 'INTEGER', notnull: 1, pk: 0 }
    ])
    assert.equal(db.prepare("PRAGMA foreign_key_list('line_entity')").all().length, 0, 'no foreign key')
    assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name='line_entity'").get().sql, /WITHOUT ROWID/)
    const insert = (kind, mid, source) => db.prepare('INSERT INTO line_entity(kind,entity_mid,source,synced_at) VALUES (?,?,?,1)').run(kind, mid, source)
    assert.throws(() => insert('other', 'u1', null), /CHECK/)
    assert.throws(() => insert('contact', '', null), /CHECK/)
    assert.throws(() => insert('contact', 'x'.repeat(129), null), /CHECK/)
    assert.throws(() => insert('contact', 'u1', 'bogus'), /CHECK/)
    insert('contact', 'u1', null)
    insert('group', 'u1', 'profile')
    insert('square_chat', 'u1', 'square')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM line_entity').get().n, 3)
  } finally { db.close() }
})

// ───────────── repo semantics (upsert / delete / read) ─────────────

const person = (mid, locator, name, kind = 'contact') => ({ kind, mid, source: locator ? (kind === 'square_chat' ? 'square' : 'profile') : null, locator, displayName: name })

test('repo upsert: writes only when something changed; a NULL from the source never overwrites a known value; a changed locator or name is written; MIDs that are empty or too long are refused', () => {
  const db = appDbWith({ entity: true })
  try {
    assert.equal(upsertEntity(db, person('u1', '/p/1', 'One'), 100), true, 'new row')
    assert.equal(upsertEntity(db, person('u1', '/p/1', 'One'), 200), false, 'same content, nothing written')
    assert.equal(entityRows(db)[0].synced_at, 100, 'and the stamp is not touched')
    assert.equal(upsertEntity(db, person('u1', null, 'One Renamed'), 300), true, 'name changed, locator unknown')
    assert.deepEqual({ l: entityRows(db)[0].locator, n: entityRows(db)[0].display_name, s: entityRows(db)[0].source }, { l: '/p/1', n: 'One Renamed', s: 'profile' })
    assert.equal(upsertEntity(db, person('u1', null, null), 400), false, 'both unknown: nothing to say')
    assert.equal(upsertEntity(db, person('u1', '/p/2', 'One Renamed'), 500), true, 'picture changed')
    assert.equal(entityRows(db)[0].locator, '/p/2')
    assert.equal(upsertEntity(db, person('', '/p/x', 'x'), 1), false)
    assert.equal(upsertEntity(db, person('x'.repeat(129), '/p/x', 'x'), 1), false)
    assert.equal(entityRows(db).length, 1)
  } finally { db.close() }
})

test('repo delete: deleteEntities removes exactly the listed rows of that kind (in chunks of any size) and nothing else; entityMids lists every row of a kind; a deleted row comes back with the next upsert', () => {
  const db = appDbWith({ entity: true })
  try {
    for (const mid of ['u1', 'u2', 'u3']) upsertEntity(db, person(mid, `/p/${mid}`, `N ${mid}`), 10)
    upsertEntity(db, person('u2', '/g/2', 'Group two', 'group'), 10)
    assert.deepEqual(entityMids(db, 'contact').sort(), ['u1', 'u2', 'u3'])
    assert.equal(deleteEntities(db, 'contact', ['u2']), 1)
    assert.equal(deleteEntities(db, 'contact', ['u2']), 0, 'already deleted: nothing to do')
    assert.deepEqual(entityMids(db, 'contact').sort(), ['u1', 'u3'])
    assert.deepEqual(entityMids(db, 'group'), ['u2'], 'the group with the same mid is a different row')
    assert.equal(deleteEntities(db, 'contact', []), 0)
    assert.equal(upsertEntity(db, person('u2', '/p/u2', 'N u2'), 80), true, 'back again')
    for (let i = 0; i < 2500; i += 1) upsertEntity(db, person(`bulk${i}`, `/p/${i}`, `B${i}`), 1)
    assert.equal(deleteEntities(db, 'contact', Array.from({ length: 2500 }, (_, i) => `bulk${i}`)), 2500)
    assert.equal(countEntities(db, 'contact'), 3)
  } finally { db.close() }
})

test('repo read: readEntities returns the rows asked for, per kind, in any batch size', () => {
  const db = appDbWith({ entity: true })
  try {
    for (let i = 0; i < 1000; i += 1) upsertEntity(db, person(`u${i}`, `/p/${i}`, `N${i}`), 1)
    upsertEntity(db, person('u5', '/g/5', 'Group five', 'group'), 1)
    const mids = Array.from({ length: 1005 }, (_, i) => `u${i}`)
    const contacts = readEntities(db, 'contact', mids)
    assert.equal(contacts.size, 1000)
    assert.equal(contacts.get('u7').locator, '/p/7')
    assert.equal('goneAt' in contacts.get('u7'), false)
    assert.equal(readEntities(db, 'group', ['u5', 'u6']).get('u5').displayName, 'Group five')
    assert.equal(readEntities(db, 'group', ['u6']).size, 0)
    assert.equal(readEntities(db, 'contact', []).size, 0)
    assert.deepEqual([...ENTITY_KINDS], ['contact', 'group', 'square_chat'])
  } finally { db.close() }
})

// ───────────── a synthetic LINE database (plain SQLite with the LINE table shapes) ─────────────

const ME = 'u-account-mid-0000'
const HASH_OK = '0hAbCdEf_123-xyz'

/**
 * spec: { me?, contacts: [{ mid, name?, over?, picture?, detail? }], groups: [{ mid, name?, picture? }], squares: [{ mid, name?, hash? }],
 *         contactWithoutRowid?, noDetailColumn?, noPictureColumn?, noGroupTable?, noSquareTable?, noProfile? }
 */
function makeLine(path, spec = {}) {
  const db = new DatabaseSync(path)
  const without = spec.contactWithoutRowid ? ' WITHOUT ROWID' : ''
  const contactCols = ['_mid TEXT PRIMARY KEY', '_displayNameOverridden TEXT', '_displayName TEXT']
  if (!spec.noDetailColumn) contactCols.push('_targetProfileDetail TEXT')
  if (!spec.noPictureColumn) contactCols.push('_picturePath TEXT')
  db.exec(`CREATE TABLE _profile(_mid TEXT, _picturePath TEXT); CREATE TABLE _contact(${contactCols.join(', ')})${without};`)
  db.exec('CREATE TABLE _chat(_id TEXT PRIMARY KEY, _lastUpdatedTime INTEGER, _lastMessage TEXT); CREATE TABLE _message(_id TEXT, _chatId TEXT, _createdTime INTEGER, _from TEXT, _text TEXT, _contentType INTEGER, _contentMetadata TEXT, _contentInfo TEXT, _attribute INTEGER)')
  if (!spec.noGroupTable) db.exec('CREATE TABLE _groupChat(_chatMid TEXT PRIMARY KEY, _chatName TEXT, _picturePath TEXT)')
  if (!spec.noSquareTable) db.exec('CREATE TABLE _squareChat(_squareChatMid TEXT PRIMARY KEY, _name TEXT, _chatImageObsHash TEXT)')
  if (!spec.noProfile) db.prepare('INSERT INTO _profile(_mid,_picturePath) VALUES (?,?)').run(spec.me ?? ME, '/p/me')
  populateLine(db, spec)
  for (const chat of spec.chats ?? []) db.prepare('INSERT INTO _chat(_id,_lastUpdatedTime) VALUES (?,1)').run(chat)
  ;(spec.messages ?? []).forEach((m, i) => db.prepare('INSERT INTO _message(_id,_chatId,_createdTime,_from,_text,_contentType,_contentMetadata,_contentInfo,_attribute) VALUES (?,?,?,?,?,0,NULL,NULL,0)').run(String(1_000_001 + i), m.chat, 1_700_000_000_000 + i * 1000, m.from, `text ${i}`))
  db.close()
}

function populateLine(db, spec) {
  const cols = ['_mid', '_displayNameOverridden', '_displayName']
  if (!spec.noDetailColumn) cols.push('_targetProfileDetail')
  if (!spec.noPictureColumn) cols.push('_picturePath')
  const addContact = db.prepare(`INSERT INTO _contact(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
  db.exec('BEGIN')
  for (const c of spec.contacts ?? []) {
    const values = [c.mid, c.over ?? null, 'name' in c ? c.name : `name ${c.mid}`]
    if (!spec.noDetailColumn) values.push(c.detail ?? null)
    if (!spec.noPictureColumn) values.push(c.picture ?? null)
    addContact.run(...values)
  }
  if (!spec.noGroupTable) for (const g of spec.groups ?? []) db.prepare('INSERT INTO _groupChat(_chatMid,_chatName,_picturePath) VALUES (?,?,?)').run(g.mid, g.name ?? `group ${g.mid}`, g.picture ?? null)
  if (!spec.noSquareTable) for (const q of spec.squares ?? []) db.prepare('INSERT INTO _squareChat(_squareChatMid,_name,_chatImageObsHash) VALUES (?,?,?)').run(q.mid, q.name ?? `square ${q.mid}`, q.hash ?? null)
  db.exec('COMMIT')
}

/** A LINE connection over the plain file with the Db shape linedb.ts uses; every SQL text is recorded. */
function openLineCon(path, log = []) {
  const db = new DatabaseSync(path, { readOnly: true })
  return {
    sql: log,
    pragma: () => [],
    prepare: (sql) => ({
      get: (...params) => { log.push(sql); return db.prepare(sql).get(...params) },
      all: (...params) => { log.push(sql); return db.prepare(sql).all(...params) }
    }),
    close: () => db.close()
  }
}

const tempDir = () => mkdtempSync(join(tmpdir(), 'contact-sync-'))
const manyContacts = (n) => Array.from({ length: n }, (_, i) => ({ mid: `u-${String(i).padStart(5, '0')}`, name: `Name ${i}`, picture: `/p/${i}` }))

/** Reads a whole table page by page; returns the rows and the number of pages. */
function readAll(reader, con, limit) {
  const rows = []
  let cursor = null
  let pages = 0
  for (;;) {
    const page = reader(con, cursor, limit)
    if (page === null) return null
    pages += 1
    rows.push(...page.rows)
    if (!page.next) return { rows, pages }
    cursor = page.next
  }
}

// ───────────── C3: the keyset readers ─────────────

test('C3 keyset: contactRowsAfter pages through every _contact row exactly once in rowid order, with rowid > ? (never OFFSET)', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'line.edb')
    makeLine(path, { contacts: manyContacts(2500) })
    const con = openLineCon(path)
    const result = readAll(linedb.contactRowsAfter, con, 700)
    assert.equal(result.rows.length, 2500)
    assert.deepEqual(result.rows.map((r) => r._mid), manyContacts(2500).map((c) => c.mid))
    assert.equal(result.pages, 4)
    assert.ok(con.sql.some((q) => /WHERE rowid > \?/.test(q)))
    assert.equal(con.sql.some((q) => /OFFSET/i.test(q)), false)
    assert.deepEqual(Object.keys(result.rows[0]).sort(), ['_displayName', '_displayNameOverridden', '_mid', '_picturePath', '_targetProfileDetail'].sort(), 'the rowid helper column is not part of the row')
    con.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('C3 keyset: a WITHOUT ROWID _contact falls back to the primary key (_mid > ?) and still returns every row once', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'line.edb')
    makeLine(path, { contacts: manyContacts(1234), contactWithoutRowid: true })
    const con = openLineCon(path)
    const result = readAll(linedb.contactRowsAfter, con, 500)
    assert.deepEqual(result.rows.map((r) => r._mid), manyContacts(1234).map((c) => c.mid))
    assert.equal(result.pages, 3)
    assert.ok(con.sql.some((q) => /WHERE _mid > \?/.test(q)))
    assert.equal(con.sql.some((q) => /OFFSET/i.test(q)), false)
    con.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('C3 keyset: a missing _targetProfileDetail or _picturePath column degrades to the columns that exist; a missing table is null, not an error; other failures are thrown', () => {
  const dir = tempDir()
  try {
    const noDetail = join(dir, 'a.edb')
    makeLine(noDetail, { contacts: [{ mid: 'u1', name: 'One', picture: '/p/1' }], noDetailColumn: true, noGroupTable: true, noSquareTable: true })
    const a = openLineCon(noDetail)
    const rowsA = linedb.contactRowsAfter(a, null, 10)
    assert.deepEqual(rowsA.rows.map((r) => [r._mid, linedb.contactLocator(r), linedb.contactName(r)]), [['u1', '/p/1', 'One']])
    assert.equal(linedb.groupRowsAfter(a, null, 10), null, 'no _groupChat table')
    assert.equal(linedb.squareChatRowsAfter(a, null, 10), null, 'no _squareChat table')
    a.close()

    const noPicture = join(dir, 'b.edb')
    makeLine(noPicture, { contacts: [{ mid: 'u2', name: 'Two', detail: JSON.stringify({ picturePath: '/d/2' }) }], noPictureColumn: true })
    const b = openLineCon(noPicture)
    assert.deepEqual(linedb.contactRowsAfter(b, null, 10).rows.map((r) => [r._mid, linedb.contactLocator(r)]), [['u2', '/d/2']])
    b.close()

    const broken = {
      pragma: () => [],
      prepare: (sql) => ({
        get: () => { if (/sqlite_master/.test(sql)) return { ok: 1 }; throw new Error('database disk image is malformed') },
        all: () => { throw new Error('database disk image is malformed') }
      }),
      close: () => undefined
    }
    assert.throws(() => linedb.contactRowsAfter(broken, null, 10), /malformed/, 'the table exists but cannot be read: an error, not "missing"')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('C3 keyset: groups and Square chats are paged the same way, and _squareMember is never read', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'line.edb')
    const groups = Array.from({ length: 30 }, (_, i) => ({ mid: `c-${String(i).padStart(3, '0')}`, picture: `/g/${i}` }))
    const squares = Array.from({ length: 25 }, (_, i) => ({ mid: `s-${String(i).padStart(3, '0')}`, hash: i % 2 ? HASH_OK : 'not-a-hash' }))
    makeLine(path, { groups, squares })
    const con = openLineCon(path)
    const g = readAll(linedb.groupRowsAfter, con, 7)
    const q = readAll(linedb.squareChatRowsAfter, con, 10)
    assert.deepEqual(g.rows.map((r) => r._chatMid), groups.map((x) => x.mid))
    assert.deepEqual(q.rows.map((r) => r._squareChatMid), squares.map((x) => x.mid))
    assert.equal(q.rows.map((r) => linedb.squareChatLocator(r)).filter(Boolean).length, 12, 'only well-formed OBS hashes are locators')
    assert.equal(linedb.groupLocator({ _picturePath: '  ' }), null)
    assert.equal(linedb.groupLocator({ _picturePath: '/g/1' }), '/g/1')
    assert.equal(con.sql.some((query) => /_squareMember/.test(query)), false)
    con.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ───────────── C4: the sync worker (contactSync.ts) ─────────────

const sleepMs = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
async function until(predicate, { timeout = 20_000, step = 2, message = 'condition' } = {}) {
  const t0 = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - t0 > timeout) assert.fail(`timed out waiting for ${message}`)
    await sleepMs(step)
  }
}

const W0 = Date.parse('2026-11-10T00:00:00.000Z')
const MIN = 60_000

/** Counts every row the entity table has written (insert, update, delete) with triggers; returns a reader. */
function countEntityWrites(db) {
  db.exec(`CREATE TABLE tcount(n INTEGER NOT NULL); INSERT INTO tcount VALUES (0);
    CREATE TRIGGER t_ins AFTER INSERT ON line_entity BEGIN UPDATE tcount SET n=n+1; END;
    CREATE TRIGGER t_upd AFTER UPDATE ON line_entity BEGIN UPDATE tcount SET n=n+1; END;
    CREATE TRIGGER t_del AFTER DELETE ON line_entity BEGIN UPDATE tcount SET n=n+1; END;`)
  return () => db.prepare('SELECT n FROM tcount').get().n
}
const totalChanges = (db) => db.prepare('SELECT total_changes() AS n').get().n

/**
 * One sync worker over a LINE file and an app DB, time injected: `probe.wall` is the wall clock, the monotonic clock advances `probe.tick` per reading,
 * sleeps are 1 ms timers. `probe.sig` is what currentSig() reports, `probe.sourceSig` what the opened source says; `probe.yieldNow()` is shouldYield.
 */
function syncOver(path, db, extra = {}) {
  const probe = {
    opens: 0, cleanups: 0, getDb: 0, sigCalls: 0, yields: 0, slices: [], bursts: [], logs: [], sleeps: [], sql: [],
    wall: W0, tick: 1, mono: 0, sig: 'sig-0', sourceSig: { edb: [10, 20], wal: [30, 40] }, yieldNow: () => false, failWhen: null, db: extra.db ?? db
  }
  const sync = createContactSync({
    getDb: () => { probe.getDb += 1; return probe.db },
    openSource: async () => {
      probe.opens += 1
      const con = openLineCon(path, probe.sql)
      const guarded = probe.failWhen
        ? { ...con, prepare: (sql) => { if (probe.failWhen(sql)) throw new Error('synthetic LINE read failure'); return con.prepare(sql) } }
        : con
      return { con: guarded, cleanup: () => { probe.cleanups += 1; con.close() }, shouldYield: () => probe.yieldNow(probe.opens), source: probe.sourceSig }
    },
    currentSig: () => { probe.sigCalls += 1; return probe.sig },
    now: () => { probe.mono += probe.tick; return probe.mono },
    wallClock: () => probe.wall,
    sleep: async (ms) => { if (probe.sleeps.length < 50) probe.sleeps.push(ms); await sleepMs(1) },
    yieldLoop: async () => { probe.yields += 1; await new Promise((resolveYield) => setImmediate(resolveYield)) },
    onSlice: (info) => { probe.slices.push(info) },
    trace: (_phase, ms) => { probe.bursts.push(ms) },
    log: (line) => { probe.logs.push(line) },
    ...extra.options,
    budget: { startDelayMs: 0, pollMs: 2, sourceRetryMs: 2, errorBackoffMs: 2, minSleepMs: 1, ...extra.budget }
  })
  return { sync, probe }
}

/** Starts a worker over a fresh LINE file and a fresh app DB; `scan()` bumps the signature and the clock and waits for the next completed scan. */
async function started(spec, { entityRows: seed = [], budget, options, noStart = false } = {}) {
  const dir = tempDir()
  const path = join(dir, 'line.edb')
  makeLine(path, spec)
  const db = appDbWith({ entity: true })
  for (const row of seed) upsertEntity(db, row.entity, row.at ?? 1)
  const { sync, probe } = syncOver(path, db, { budget, options })
  const h = {
    dir, path, db, sync, probe,
    line(fn) { const w = new DatabaseSync(path); try { fn(w) } finally { w.close() } },
    async firstScan() { sync.start(); await until(() => sync.status().scans >= 1, { message: 'the first scan' }) },
    async scan({ advance = 6 * MIN } = {}) {
      const target = sync.status().scans + 1
      probe.wall += advance
      probe.sig = `sig-${target}`
      await until(() => sync.status().scans >= target, { message: `scan ${target}` })
    },
    async stop() { await sync.dispose(); db.close(); rmSync(dir, { recursive: true, force: true }) }
  }
  if (!noStart) await h.firstScan()
  return h
}

const spec49 = () => ({
  contacts: manyContacts(40),
  groups: Array.from({ length: 5 }, (_, i) => ({ mid: `c-${i}`, name: `Group ${i}`, picture: `/g/${i}` })),
  squares: [{ mid: 's-0', name: 'Sq0', hash: HASH_OK }, { mid: 's-1', name: 'Sq1', hash: HASH_OK + '1' }, { mid: 's-2', name: 'Sq2', hash: 'bad hash!' }, { mid: 's-3', name: 'Sq3' }]
})
const byMid = (db, kind, mid) => db.prepare('SELECT * FROM line_entity WHERE kind=? AND entity_mid=?').get(kind, mid)

// ── X: extraction ──

test('X-1 extraction: contactLocator and contactName agree with production profileSource / chatName on pictures in picturePath only, in the detail only, in both, bad JSON, blanks and every name source — and so does what the worker stores', async () => {
  const detail = (o) => JSON.stringify(o)
  const contacts = [
    { mid: 'x1', picture: '/p/1', name: 'N1' },
    { mid: 'x2', name: null, detail: detail({ picturePath: '/d/2', profileName: 'PN2' }) },
    { mid: 'x3', picture: '/p/3', detail: detail({ picturePath: '/d/3', profileName: 'PN3' }), name: 'N3' },
    { mid: 'x4', name: null, detail: '{bad json' },
    { mid: 'x5', picture: '   ', detail: '   ', name: '   ' },
    { mid: 'x6', over: 'Overridden', name: 'Plain' },
    { mid: 'x7', name: 'Plain7' },
    { mid: 'x8', name: null, detail: detail({ profileName: 'PN8' }) },
    { mid: 'x9', picture: ' ', detail: detail({ picturePath: '/d/9' }), name: 'N9' },
    { mid: 'x10', name: 'N10', detail: detail({ picturePath: 5 }) },
    { mid: 'x11', name: null }
  ]
  const h = await started({ contacts })
  try {
    const con = openLineCon(h.path)
    const rows = readAll(linedb.contactRowsAfter, con, 4).rows
    assert.equal(rows.length, contacts.length)
    for (const row of rows) {
      const production = linedb.senderAvatarSource(con, 'no-such-chat', row._mid)
      assert.equal(linedb.contactLocator(row), production.locator, `${row._mid}: locator`)
      assert.equal(linedb.contactName(row), production.displayName, `${row._mid}: name`)
      const stored = byMid(h.db, 'contact', row._mid)
      assert.equal(stored.locator, production.locator, `${row._mid}: stored locator`)
      assert.equal(stored.display_name, production.displayName, `${row._mid}: stored name`)
      assert.equal(stored.source, production.locator ? 'profile' : null, `${row._mid}: stored source`)
    }
    con.close()
  } finally { await h.stop() }
})

test('X-2 own MID: it is never written, whatever table it sits in; and when the source cannot say who we are nothing at all is written and the state is account_unknown', async () => {
  const spec = { ...spec49(), contacts: [...manyContacts(5), { mid: ME, name: 'Me', picture: '/p/me' }], groups: [{ mid: ME, name: 'also me', picture: '/g/me' }, { mid: 'c-1', name: 'G', picture: '/g/1' }] }
  const h = await started(spec)
  try {
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM line_entity WHERE entity_mid=?').get(ME).n, 0)
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM line_entity').get().n, 5 + 1 + 4)
    const everything = JSON.stringify(entityRows(h.db)) + JSON.stringify(h.db.prepare('SELECT * FROM line_avatar_meta').all()) + JSON.stringify(h.sync.status()) + h.probe.logs.join('\n')
    assert.equal(everything.includes(ME), false)
  } finally { await h.stop() }

  const unknown = await started({ ...spec49(), noProfile: true }, { noStart: true })
  try {
    unknown.sync.start()
    await until(() => unknown.sync.status().phase === 'account_unknown', { message: 'account_unknown' })
    await until(() => unknown.probe.opens >= 3, { message: 'it keeps retrying' })
    assert.equal(unknown.db.prepare('SELECT COUNT(*) AS n FROM line_entity').get().n, 0)
    assert.equal(unknown.db.prepare("SELECT COUNT(*) AS n FROM line_avatar_meta WHERE key LIKE 'contact_sync%'").get().n, 0, 'no completion meta either')
    assert.equal(unknown.sync.status().scans, 0)
    assert.equal(unknown.probe.cleanups, unknown.probe.opens, 'every source that was opened was released')
  } finally { await unknown.stop() }
})

// ── Y: sync ──

test('Y-1 first scan: contacts, groups and Square chats are all there with the right counts, locators, names and sources; _squareMember is never read', async () => {
  const h = await started(spec49())
  try {
    const status = h.sync.status()
    assert.deepEqual(status.counts, { contact: 40, group: 5, square_chat: 4 })
    assert.equal(status.written, 49)
    for (const [kind, n] of [['contact', 40], ['group', 5], ['square_chat', 4]]) assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM line_entity WHERE kind=?').get(kind).n, n, kind)
    assert.deepEqual({ ...byMid(h.db, 'contact', 'u-00003') }, { kind: 'contact', entity_mid: 'u-00003', source: 'profile', locator: '/p/3', display_name: 'Name 3', synced_at: W0 })
    assert.deepEqual({ l: byMid(h.db, 'group', 'c-2').locator, n: byMid(h.db, 'group', 'c-2').display_name, s: byMid(h.db, 'group', 'c-2').source }, { l: '/g/2', n: 'Group 2', s: 'profile' })
    assert.equal(h.probe.sql.some((q) => /_squareMember/.test(q)), false)
    assert.equal(h.sync.status().phase, 'done')
    assert.equal(h.db.prepare("SELECT value FROM line_avatar_meta WHERE key='contact_sync_version'").get().value, '1')
  } finally { await h.stop() }
})

test('Y-2 steady state: the source did not change, the signature did — the scan reads everything and writes no entity row (trigger count 0, table identical), only the five meta keys change', async () => {
  const h = await started(spec49())
  try {
    const writes = countEntityWrites(h.db)
    const before = JSON.stringify(entityRows(h.db))
    const changesBefore = totalChanges(h.db)
    const opensBefore = h.probe.opens
    await h.scan()
    assert.ok(h.probe.opens > opensBefore, 'the scan really read the source again')
    assert.equal(writes(), 0, 'no entity row was written')
    assert.equal(h.sync.status().written, 0)
    assert.equal(JSON.stringify(entityRows(h.db)), before, 'not even synced_at moved')
    assert.ok(totalChanges(h.db) - changesBefore <= 5, `only the meta keys were written (${totalChanges(h.db) - changesBefore} changes)`)
  } finally { await h.stop() }
})

test('Y-3 one change: changing one person\'s _picturePath writes exactly that one entity row', async () => {
  const h = await started(spec49())
  try {
    const writes = countEntityWrites(h.db)
    h.line((w) => w.prepare("UPDATE _contact SET _picturePath='/p/new' WHERE _mid='u-00007'").run())
    await h.scan()
    assert.equal(writes(), 1)
    assert.equal(h.sync.status().written, 1)
    assert.equal(byMid(h.db, 'contact', 'u-00007').locator, '/p/new')
    assert.equal(byMid(h.db, 'contact', 'u-00007').synced_at, h.probe.wall)
    assert.equal(byMid(h.db, 'contact', 'u-00008').synced_at, W0, 'the neighbours were not touched')
  } finally { await h.stop() }
})

test('Y-4 Garry: with _picturePath NULL the picture comes from _targetProfileDetail; once _picturePath shows up it wins', async () => {
  const h = await started({ contacts: [{ mid: 'u-garry', name: 'Garry', detail: JSON.stringify({ picturePath: '/d/garry', profileName: 'Garry' }) }] })
  try {
    assert.equal(byMid(h.db, 'contact', 'u-garry').locator, '/d/garry')
    assert.equal(byMid(h.db, 'contact', 'u-garry').source, 'profile')
    h.line((w) => w.prepare("UPDATE _contact SET _picturePath='/p/garry' WHERE _mid='u-garry'").run())
    await h.scan()
    assert.equal(byMid(h.db, 'contact', 'u-garry').locator, '/p/garry')
  } finally { await h.stop() }
})

test('Y-5 NULL does not overwrite: when the source loses the picture the local locator stays, while the name still updates', async () => {
  const h = await started({ contacts: [{ mid: 'u-a', name: 'Old Name', picture: '/p/a' }] })
  try {
    h.line((w) => w.prepare("UPDATE _contact SET _picturePath=NULL, _displayName='New Name' WHERE _mid='u-a'").run())
    await h.scan()
    assert.deepEqual({ l: byMid(h.db, 'contact', 'u-a').locator, n: byMid(h.db, 'contact', 'u-a').display_name, s: byMid(h.db, 'contact', 'u-a').source }, { l: '/p/a', n: 'New Name', s: 'profile' })
  } finally { await h.stop() }
})

test('Y-6 Square: an illegal OBS hash is stored as NULL, a legal one is stored with source square', async () => {
  const h = await started(spec49())
  try {
    assert.deepEqual({ ...byMid(h.db, 'square_chat', 's-0') }, { kind: 'square_chat', entity_mid: 's-0', source: 'square', locator: HASH_OK, display_name: 'Sq0', synced_at: W0 })
    for (const mid of ['s-2', 's-3']) assert.deepEqual({ l: byMid(h.db, 'square_chat', mid).locator, s: byMid(h.db, 'square_chat', mid).source, n: byMid(h.db, 'square_chat', mid).display_name }, { l: null, s: null, n: mid === 's-2' ? 'Sq2' : 'Sq3' })
  } finally { await h.stop() }
})

test('Y-7 defensive: a WITHOUT ROWID _contact, a missing _targetProfileDetail column, a missing _groupChat / _squareChat table — the scan still completes, the missing kinds are skipped and their existing rows are NOT deleted (a kind that was not scanned is left alone)', async () => {
  const seed = [
    { entity: { kind: 'group', mid: 'c-old', source: 'profile', locator: '/g/old', displayName: 'Old group' } },
    { entity: { kind: 'square_chat', mid: 's-old', source: 'square', locator: HASH_OK, displayName: 'Old square' } }
  ]
  for (const [label, extra] of [['without rowid', { contactWithoutRowid: true }], ['no detail column', { noDetailColumn: true }], ['no group/square tables', { noGroupTable: true, noSquareTable: true }], ['all of it', { contactWithoutRowid: true, noDetailColumn: true, noGroupTable: true, noSquareTable: true }]]) {
    const missingKinds = extra.noGroupTable
    const h = await started({ contacts: manyContacts(30), groups: [{ mid: 'c-1', picture: '/g/1' }], squares: [{ mid: 's-1', hash: HASH_OK }], ...extra }, { entityRows: seed })
    try {
      assert.equal(h.sync.status().scans, 1, label)
      assert.equal(h.sync.status().counts.contact, 30, label)
      assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM line_entity WHERE kind='contact'").get().n, 30, label)
      for (const [kind, mid] of [['group', 'c-old'], ['square_chat', 's-old']]) {
        const row = byMid(h.db, kind, mid)
        if (missingKinds) assert.notEqual(row, undefined, `${label}: ${kind} table is missing, the row is not deleted`)
        else assert.equal(row, undefined, `${label}: ${kind} table is there and the row vanished, so it is deleted`)
      }
      if (missingKinds) assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM line_entity WHERE kind IN ('group','square_chat')").get().n, 2, `${label}: nothing was added or removed for the missing kinds`)
      else {
        assert.notEqual(byMid(h.db, 'group', 'c-1'), undefined, `${label}: the group the scan saw is there`)
        assert.notEqual(byMid(h.db, 'square_chat', 's-1'), undefined, `${label}: the Square chat the scan saw is there`)
      }
    } finally { await h.stop() }
  }
})

// ── D: removal ──

test('D-1 mirror: a person removed at the source is deleted after a complete scan (the next read finds nothing), the others stay, and coming back at the source brings the row back', async () => {
  const h = await started(spec49())
  try {
    h.line((w) => w.prepare("DELETE FROM _contact WHERE _mid='u-00005'").run())
    await h.scan()
    assert.equal(byMid(h.db, 'contact', 'u-00005'), undefined)
    assert.equal(h.sync.status().deleted, 1)
    assert.equal(readEntities(h.db, 'contact', ['u-00005']).size, 0)
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM line_entity').get().n, 48, 'only that one went')
    h.line((w) => w.prepare("INSERT INTO _contact(_mid,_displayName,_picturePath) VALUES ('u-00005','Name 5','/p/5')").run())
    await h.scan()
    assert.equal(byMid(h.db, 'contact', 'u-00005').locator, '/p/5')
    assert.equal(h.sync.status().deleted, 0)
  } finally { await h.stop() }
})

test('D-2 mirror, no retention and no guard: a group and a Square chat removed at the source are deleted by the next complete scan, and so is everything when the source list is empty', async () => {
  const h = await started(spec49())
  try {
    h.line((w) => { w.prepare("DELETE FROM _groupChat WHERE _chatMid='c-1'").run(); w.prepare("DELETE FROM _squareChat WHERE _squareChatMid='s-1'").run() })
    await h.scan({ advance: 6 * MIN })
    assert.equal(byMid(h.db, 'group', 'c-1'), undefined)
    assert.equal(byMid(h.db, 'square_chat', 's-1'), undefined)
    assert.equal(h.sync.status().deleted, 2)
    h.line((w) => w.prepare('DELETE FROM _contact').run())
    await h.scan({ advance: 6 * MIN })
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM line_entity WHERE kind='contact'").get().n, 0, 'the mirror follows the source all the way')
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM line_entity WHERE kind='group'").get().n, 4)
    assert.equal(h.sync.status().counts.contact, 0)
  } finally { await h.stop() }
})

test('D-3 failure: a read failure in the middle deletes nothing, writes no completion meta, and the next round completes normally and deletes the vanished row', async () => {
  const failing = await started(spec49())
  try {
    failing.line((w) => w.prepare("DELETE FROM _contact WHERE _mid='u-00004'").run())
    const metaBefore = JSON.stringify(failing.db.prepare('SELECT * FROM line_avatar_meta ORDER BY key').all())
    const rowsBefore = JSON.stringify(entityRows(failing.db))
    const errorsBefore = failing.sync.status().errors
    let armed = true
    failing.probe.failWhen = (sql) => armed && /FROM _contact/.test(sql)
    const scans = failing.sync.status().scans
    failing.probe.wall += 6 * MIN
    failing.probe.sig = 'sig-fail'
    await until(() => failing.sync.status().errors > errorsBefore, { message: 'the failure' })
    assert.equal(failing.sync.status().scans, scans)
    assert.equal(JSON.stringify(entityRows(failing.db)), rowsBefore, 'nothing was deleted')
    assert.equal(JSON.stringify(failing.db.prepare('SELECT * FROM line_avatar_meta ORDER BY key').all()), metaBefore, 'no completion meta')
    assert.ok(failing.probe.logs.includes('[contact-sync] read_failed'))
    assert.equal(failing.probe.cleanups, failing.probe.opens)
    armed = false
    await until(() => failing.sync.status().scans > scans, { message: 'the retry completes' })
    assert.equal(byMid(failing.db, 'contact', 'u-00004'), undefined, 'and now the vanished row is gone')
  } finally { await failing.stop() }
})

// ── T: trigger and cost ──

test('T-1 trigger: openSource is called 0 times while the signature is unchanged, 0 times when it changed inside the minimum interval, once it changed after it; a version mismatch ignores the interval', async () => {
  const h = await started(spec49())
  try {
    const opens = () => h.probe.opens
    const settle = async () => { const c = h.probe.sigCalls; await until(() => h.probe.sigCalls >= c + 8, { message: 'the gate polled a few times' }) }
    let base = opens()
    await settle()
    assert.equal(opens(), base, 'same signature: no open')
    h.probe.sig = 'changed-but-early'
    h.probe.wall += 4 * MIN
    await settle()
    assert.equal(opens(), base, 'changed inside the 5 minute interval: no open')
    h.probe.wall += 2 * MIN
    await until(() => h.sync.status().scans >= 2, { message: 'the scan after the interval' })
    assert.equal(opens(), base + 1, 'exactly one open')
    base = opens()
    await settle()
    assert.equal(opens(), base, 'and quiet again')

    h.db.prepare("UPDATE line_avatar_meta SET value='0' WHERE key='contact_sync_version'").run()
    await until(() => h.sync.status().scans >= 3, { message: 'version mismatch scans at once' })
    assert.equal(opens(), base + 1, 'a version mismatch is not held back by the interval')
    assert.equal(h.db.prepare("SELECT value FROM line_avatar_meta WHERE key='contact_sync_version'").get().value, '1')
  } finally { await h.stop() }
})

test('T-3 slicing: 3000 contacts are read in several slices, none over the LIMIT cap, with a yield between slices and in one burst; shouldYield ends a burst and releases the source; resuming misses no row', async () => {
  const spec = { contacts: manyContacts(3000) }
  const one = await started(spec, { budget: { burstMs: 1e9 } })
  try {
    const contactSlices = one.probe.slices.filter((s) => s.rows > 0)
    assert.ok(contactSlices.length > 1, `${contactSlices.length} slices`)
    assert.ok(contactSlices.every((s) => s.rows <= 1000), 'no slice above the LIMIT cap')
    assert.equal(contactSlices.reduce((sum, s) => sum + s.rows, 0), 3000)
    assert.ok(one.probe.yields >= contactSlices.length - 1, `${one.probe.yields} yields for ${contactSlices.length} slices`)
    assert.equal(one.probe.opens, 1, 'one burst')
    assert.equal(one.db.prepare("SELECT COUNT(*) AS n FROM line_entity WHERE kind='contact'").get().n, 3000)
  } finally { await one.stop() }

  const yielding = await started(spec, { noStart: true })
  try {
    yielding.probe.yieldNow = (opens) => opens <= 4
    await yielding.firstScan()
    assert.ok(yielding.probe.opens >= 5, `${yielding.probe.opens} bursts`)
    assert.equal(yielding.probe.cleanups, yielding.probe.opens, 'every burst released its source')
    const sliced = yielding.probe.slices.filter((s) => s.rows > 0)
    assert.equal(sliced.reduce((sum, s) => sum + s.rows, 0), 3000, 'every row exactly once across the bursts')
    assert.equal(yielding.db.prepare("SELECT COUNT(*) AS n FROM line_entity WHERE kind='contact'").get().n, 3000)
    assert.equal(yielding.sync.status().deleted, 0, 'resuming across bursts never deleted anything')
    assert.equal(yielding.sync.status().counts.contact, 3000)
  } finally { await yielding.stop() }
})

test('T-4 dispose: disposing in the middle of a scan releases the source and the app DB is not touched afterwards', async () => {
  const h = await started({ contacts: manyContacts(3000) }, { noStart: true })
  try {
    h.probe.tick = 40
    h.sync.start()
    await until(() => h.probe.slices.length >= 1, { message: 'a slice' })
    await h.sync.dispose()
    const getDbAfter = h.probe.getDb
    const rowsAfter = h.db.prepare('SELECT COUNT(*) AS n FROM line_entity').get().n
    const opensAfter = h.probe.opens
    assert.equal(h.probe.cleanups, h.probe.opens, 'the source of the interrupted burst was released')
    assert.ok(rowsAfter < 3000, 'it really was interrupted')
    await sleepMs(60)
    assert.equal(h.probe.getDb, getDbAfter, 'no app DB access after dispose')
    assert.equal(h.probe.opens, opensAfter, 'no further source opened')
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM line_entity').get().n, rowsAfter)
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM line_avatar_meta WHERE key LIKE 'contact_sync%'").get().n, 0, 'an interrupted scan leaves no completion meta')
  } finally { await h.stop() }
})

test('T-5 transactions: every write transaction carries at most 1000 entity rows and nothing is written outside a transaction', async () => {
  const real = appDbWith({ entity: true })
  const log = { txRows: [], outside: [], inTx: false, rows: 0 }
  const wrapStatement = (target, sql) => new Proxy(target, {
    get(t, prop) {
      if (prop === 'run') {
        return (...args) => {
          if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql) && !log.inTx) log.outside.push(sql)
          if (log.inTx && /line_entity/.test(sql)) log.rows += 1
          return t.run(...args)
        }
      }
      const value = Reflect.get(t, prop)
      return typeof value === 'function' ? value.bind(t) : value
    }
  })
  const proxy = new Proxy(real, {
    get(t, prop) {
      if (prop === 'prepare') return (sql) => wrapStatement(t.prepare(sql), sql)
      if (prop === 'transaction') {
        return (fn) => t.transaction((...args) => {
          const outer = log.inTx
          if (!outer) { log.inTx = true; log.rows = 0 }
          try { return fn(...args) } finally { if (!outer) { log.inTx = false; log.txRows.push(log.rows) } }
        })
      }
      const value = Reflect.get(t, prop)
      return typeof value === 'function' ? value.bind(t) : value
    }
  })
  const dir = tempDir()
  try {
    const path = join(dir, 'line.edb')
    makeLine(path, { contacts: manyContacts(3500), groups: [{ mid: 'c-1', picture: '/g/1' }] })
    const { sync, probe } = syncOver(path, real, { db: proxy })
    sync.start()
    await until(() => sync.status().scans >= 1, { message: 'the scan' })
    await sync.dispose()
    assert.ok(probe.getDb > 0)
    assert.ok(log.txRows.length >= 4)
    assert.ok(Math.max(...log.txRows) <= 1000, `largest transaction ${Math.max(...log.txRows)} rows`)
    assert.equal(log.txRows.reduce((a, b) => a + b, 0) >= 3501, true)
    assert.deepEqual(log.outside, [], 'no write outside a transaction')
  } finally {
    real.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('T-6 signature: walSig() and a snapshot lease.source with the same content normalise to the same string, and a different file gives a different one', () => {
  const dir = tempDir()
  try {
    const edb = join(dir, 'qw0001.edb')
    writeFileSync(edb, 'main database bytes')
    writeFileSync(`${edb}-wal`, 'wal bytes')
    const fs = createNodeLineFsPort({ tempRoot: dir })
    configureLineEnginePorts({ fs })
    try {
      const sig = walSig(edb)
      const stat = (p) => { const s = fs.stat(p); return [Number(s.size), Number(s.mtimeNs)] }
      const leaseSource = { edb: stat(edb), wal: stat(`${edb}-wal`) }
      assert.equal(normalizeSourceSig(sig), normalizeSourceSig(leaseSource))
      assert.equal(typeof normalizeSourceSig(sig), 'string')
      writeFileSync(`${edb}-wal`, 'wal bytes, longer now')
      assert.notEqual(normalizeSourceSig(walSig(edb)), normalizeSourceSig(leaseSource))
      assert.equal(normalizeSourceSig({ edb: null, wal: null }), normalizeSourceSig({ edb: null, '-wal': null }))
      assert.equal(normalizeSourceSig(undefined), 'edb=-;wal=-')
    } finally { resetLineEnginePorts() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ───────────── C5: the entity layer of the local reader ─────────────

const ent = (kind, mid, locator, name) => ({ kind, mid, source: locator ? (kind === 'square_chat' ? 'square' : 'profile') : null, locator, displayName: name })
const putEntity = (db, e, at = 1) => { upsertEntity(db, e, at) }

/** Links one incoming message to one sender profile row, the way an import would. */
function linkSender(db, { chat = 'c-room-0', msg, mid, locator, name, source = 'profile', refreshedAt = 1 }) {
  const at = new Date('2026-11-02T00:00:00.000Z').toISOString()
  db.prepare(`INSERT OR IGNORE INTO messages(msg_id,chat_id,ts,time_iso,direction,sender,text,content_type,processed,ingested_at) VALUES (?,?,1,?,'in','x','t',0,0,?)`).run(msg, chat, at, at)
  db.prepare('INSERT INTO line_sender_profile(chat_id,sender_mid,source,locator,display_name,refreshed_at) VALUES (?,?,?,?,?,?)').run(chat, mid, locator ? source : null, locator, name, refreshedAt)
  const id = db.prepare('SELECT sender_id FROM line_sender_profile WHERE chat_id=? AND sender_mid=?').get(chat, mid).sender_id
  db.prepare('INSERT INTO line_message_sender(msg_id,sender_id) VALUES (?,?)').run(msg, id)
}

test('R-1 chat level: the order is group, Square chat, contact; the first row with a picture wins, otherwise the first with a name; the retired line_chat_avatar is never read; a row with neither, and a chat nobody knows, are simply absent', () => {
  const db = appDbWith({ entity: true, chats: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'] })
  try {
    for (const kind of ['group', 'square_chat', 'contact']) putEntity(db, ent(kind, 'm1', `/${kind}/m1`, `${kind} name`))
    putEntity(db, ent('square_chat', 'm2', '/sq/m2', 'Sq name'))
    putEntity(db, ent('contact', 'm2', '/ct/m2', 'Ct name'))
    putEntity(db, ent('group', 'm3', null, 'Group named only'))
    putEntity(db, ent('contact', 'm3', '/ct/m3', 'Ct name 3'))
    putEntity(db, ent('group', 'm4', null, 'Group named only 4'))
    putEntity(db, ent('contact', 'm4', null, 'Contact named only 4'))
    db.prepare("INSERT INTO line_chat_avatar(chat_id,source,locator,display_name,refreshed_at) VALUES ('m5','profile','/retired/m5','Retired',1)").run()
    putEntity(db, ent('contact', 'm5', '/ct/m5', 'Fresh from the address book'))
    db.prepare("INSERT INTO line_chat_avatar(chat_id,source,locator,display_name,refreshed_at) VALUES ('m6','profile','/retired/m6','Retired six',1)").run()
    putEntity(db, ent('contact', 'm6', null, null))
    const result = readLocalAvatars(db, { chatIds: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'], chatId: null, msgIds: [] }, { entity: true })
    const pick = (id) => [result.chats[id]?.locator ?? null, result.chats[id]?.displayName ?? null, result.chats[id]?.source ?? null]
    assert.deepEqual(pick('m1'), ['/group/m1', 'group name', 'profile'])
    assert.deepEqual(pick('m2'), ['/sq/m2', 'Sq name', 'square'], 'Square chat before contact')
    assert.deepEqual(pick('m3'), ['/ct/m3', 'Ct name 3', 'profile'], 'a picture further down beats a name higher up')
    assert.deepEqual(pick('m4'), [null, 'Group named only 4', null], 'no picture anywhere: the first name')
    assert.deepEqual(pick('m5'), ['/ct/m5', 'Fresh from the address book', 'profile'], 'the address book, not the retired table')
    assert.equal('m6' in result.chats, false, 'an entity row with neither picture nor name counts as no row, and the retired table is not asked')
    assert.equal('m7' in result.chats, false)
    assert.equal(Object.hasOwn(result, 'stale'), false)
    const off = readLocalAvatars(db, { chatIds: ['m1', 'm5'], chatId: null, msgIds: [] })
    assert.deepEqual(off.chats, {}, 'without the flag there is no address book layer, and nothing else to fall back to')
  } finally { db.close() }
})

test('R-2 message level: the address book replaces the older copy of a contact sender (A becomes B); a Square-sourced row keeps its own picture and is never overridden; a contact that is not in the address book gets nothing; an unlinked message is not invented', () => {
  const db = appDbWith({ entity: true, chats: ['c-room-0'] })
  try {
    linkSender(db, { msg: 'i:1', mid: 'u-a', locator: '/old/A', name: 'Old A' })
    putEntity(db, ent('contact', 'u-a', '/new/B', 'New B'))
    linkSender(db, { msg: 'i:2', mid: 'sq-member', locator: '0hMemberHash', name: 'Member', source: 'square' })
    putEntity(db, ent('contact', 'sq-member', '/contact/X', 'Same mid as a contact'))
    linkSender(db, { msg: 'i:3', mid: 'u-left', locator: '/old/G', name: 'Old G' })
    linkSender(db, { msg: 'i:4', mid: 'u-plain', locator: '/plain/P', name: 'Plain' })
    putEntity(db, ent('group', 'u-plain', '/group/same-mid', 'A group is not a contact'))
    const result = readLocalAvatars(db, { chatIds: [], chatId: 'c-room-0', msgIds: ['i:1', 'i:2', 'i:3', 'i:4', 'i:9'] }, { entity: true })
    assert.deepEqual([result.messages['i:1'].locator, result.messages['i:1'].displayName, result.messages['i:1'].identity], ['/new/B', 'New B', 'u-a'])
    assert.deepEqual([result.messages['i:2'].locator, result.messages['i:2'].source], ['0hMemberHash', 'square'], 'source square is not overridden by the address book')
    assert.equal('i:3' in result.messages, false, 'not in the address book: the sender copy is not used')
    assert.equal('i:4' in result.messages, false, 'only the contact kind answers for senders')
    assert.equal('i:9' in result.messages, false)
    const off = readLocalAvatars(db, { chatIds: [], chatId: 'c-room-0', msgIds: ['i:1', 'i:2'] })
    assert.deepEqual(Object.keys(off.messages), ['i:2'], 'with the flag off only the Square member is answered')
  } finally { db.close() }
})

test('R-3 no LINE access: the reader has no fallback at all — a chat or message nobody has stored is simply absent, and a LINE reader handed to it is never called', async () => {
  const db = appDbWith({ entity: true, chats: ['c-room-0', 'c-room-1'] })
  try {
    putEntity(db, ent('group', 'c-room-0', '/g/0', 'Room 0'))
    linkSender(db, { msg: 'i:1', mid: 'u-a', locator: '/old/A', name: 'A' })
    putEntity(db, ent('contact', 'u-a', '/new/A', 'A new'))
    const reader = createLayeredAvatarReader({ getDb: () => db, fallback: { read: () => { throw new Error('the reader must never call a LINE reader') } }, entityOn: () => true })
    const first = await reader.read({ chatIds: ['c-room-0', 'c-room-1'], chatId: 'c-room-0', msgIds: ['i:1'] })
    assert.equal(first.chats['c-room-0'].locator, '/g/0')
    assert.equal(first.messages['i:1'].locator, '/new/A')
    assert.equal('c-room-1' in first.chats, false, 'a chat nobody has stored: absent (a letter on screen)')
    const later = await reader.read({ chatIds: ['c-room-1'], chatId: null, msgIds: [] })
    assert.deepEqual(later.chats, {}, 'asked again: still nothing, and still no LINE read')
    const text = readFileSync(join(srcRoot, 'plugin', 'backend', 'avatarReader.ts'), 'utf8')
    assert.equal(/fallback|snapshot|getAvatarMetadata/i.test(text.replace(/\/\*[\s\S]*?\*\//, '')), false, 'avatarReader.ts has no fallback path')
  } finally { db.close() }
})

test('R-5 broken address book layer: with the table gone (or the flag off) the reader answers without it and does not throw', async () => {
  const db = appDbWith({ entity: true, chats: ['c-room-0'] })
  try {
    putEntity(db, ent('group', 'c-room-0', '/entity/0', 'Entity'))
    const reader = createLayeredAvatarReader({ getDb: () => db, entityOn: () => true })
    assert.equal((await reader.read({ chatIds: ['c-room-0'], chatId: null, msgIds: [] })).chats['c-room-0'].locator, '/entity/0')
    db.exec('DROP TABLE line_entity')
    assert.deepEqual((await reader.read({ chatIds: ['c-room-0'], chatId: null, msgIds: [] })).chats, {})
    const flagOff = createLayeredAvatarReader({ getDb: () => db })
    assert.deepEqual((await flagOff.read({ chatIds: ['c-room-0'], chatId: null, msgIds: [] })).chats, {})
  } finally { db.close() }
})

const holders = (db, needle) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
  .filter(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all()).includes(needle)).map(({ name }) => name)

// ───────────── C6: the production wiring (createPluginBackend) ─────────────

/** A directory with a synthetic LINE database (with messages), a counting fs port and a fake SQLite engine over plain files. */
function stage(spec) {
  const root = mkdtempSync(join(tmpdir(), 'contact-sync-wire-'))
  const lineDir = join(root, 'LINE', 'Data', 'db')
  const dataDir = join(root, 'data')
  mkdirSync(lineDir, { recursive: true })
  mkdirSync(join(dataDir, 'line-engine'), { recursive: true })
  const src = join(lineDir, 'qw0001.edb')
  makeLine(src, spec)
  const base = createNodeLineFsPort({ tempRoot: join(dataDir, 'line-engine') })
  const fs = {
    readDir: (d) => base.readDir(d), stat: (p) => base.stat(p), exists: (p) => base.exists(p), readFile: (p) => base.readFile(p),
    copyFile: (s, d) => base.copyFile(s, d), copyFileAsync: (s, d) => base.copyFileAsync(s, d),
    readHead: (p, n) => base.readHead(p, n), makeTempDir: (p) => base.makeTempDir(p), removeDir: (d) => base.removeDir(d), ensureDir: (d) => base.ensureDir(d),
    readTextFile: (p) => base.readTextFile(p), writeTextFile: (p, t) => base.writeTextFile(p, t), renameFile: (a, b) => base.renameFile(a, b),
    listProcessIds: () => []
  }
  const sqlite = {
    name: 'fake-plain-sqlite',
    open(path) {
      const db = new DatabaseSync(path, { readOnly: true })
      return { pragma: () => [], prepare: (sql) => ({ get: (...params) => db.prepare(sql).get(...params), all: (...params) => db.prepare(sql).all(...params) }), close: () => db.close() }
    }
  }
  writeFileSync(join(dataDir, '.linekey'), GOOD_KEY)
  return {
    root, lineDir, dataDir, src, fs, sqlite, keyOpts: { cacheFile: join(dataDir, '.linekey') },
    cleanup: () => { resetLineEnginePorts(); rmSync(root, { recursive: true, force: true }) }
  }
}

const GOOD_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const info = async (backend) => (await backend.call('backend', { path: 'backend.info', args: [] })).value
const lineStatus = async (backend) => (await backend.call('line', { path: 'line.status', args: [] })).value

async function startBackend(s, extra = {}) {
  writeFileSync(join(s.dataDir, 'settings.json'), JSON.stringify({ version: 1, reconcile: { enabled: false, scopeMonths: 0 } }))
  return createPluginBackend({
    pluginId: 'tuqdev.line-todo', version: 'test', dataDir: s.dataDir,
    linePorts: { fs: s.fs, sqlite: s.sqlite, dbDir: s.lineDir },
    watcher: { intervalSec: 1, startupDelayMs: 20 },
    snapshot: { walOnly: true },
    trace: { eventMinMs: 0 },
    ...extra,
    avatarStore: { backfill: { enabled: false }, ...extra.avatarStore }
  })
}

const FAST_SYNC = { startDelayMs: 0, pollMs: 25, minIntervalMs: 0, sourceRetryMs: 25, errorBackoffMs: 25, minSleepMs: 1 }
const appDbPath = (s) => join(s.dataDir, 'line-todo.db')
const appRead = (s) => new Database(appDbPath(s), { readonly: true })

/** Pre-seeds the avatar image cache the way a previous download would have (so no download, and no network, is needed). */
function seedAvatarCache(dataDir, identity, locator) {
  const jpeg = Buffer.from([0xff, 0xd8, 9, 9, 9, 0xff, 0xd9])
  const dir = join(dataDir, 'avatar-cache')
  mkdirSync(dir, { recursive: true })
  const name = `${avatarCacheKey(identity, locator)}.jpg`
  writeFileSync(join(dir, name), jpeg)
  writeFileSync(join(dir, `${name}.sha256`), createHash('sha256').update(jpeg).digest('hex'))
  return `avatar-cache/${name}`
}

const wireSpec = () => {
  const contacts = Array.from({ length: 4 }, (_, i) => ({ mid: `u-sender-00${i}`, name: `Sender ${i}`, picture: `/p/pic-${i}` }))
  return {
    contacts,
    groups: [{ mid: 'c-room-0', name: 'Room 0', picture: '/p/room-0' }],
    squares: [{ mid: 's-square-0', name: 'Square 0', hash: HASH_OK }],
    chats: ['c-room-0'],
    messages: Array.from({ length: 20 }, (_, i) => ({ chat: 'c-room-0', from: i % 5 === 0 ? ME : contacts[i % 4].mid }))
  }
}

test('R-4 end to end: a picture changed at the source is picked up by the sync and prepareMessages / prepareChats answer with the new path (a different avatarCache key); no fixture MID is in backend.info or the trace log (P-2), and the account MID is in no table', { timeout: 90_000 }, async () => {
  const s = stage(wireSpec())
  let backend
  try {
    const oldMsg = seedAvatarCache(s.dataDir, 'u-sender-001', '/p/pic-1')
    const newMsg = seedAvatarCache(s.dataDir, 'u-sender-001', '/p/new-1')
    const oldChat = seedAvatarCache(s.dataDir, 'c-room-0', '/p/room-0')
    const newChat = seedAvatarCache(s.dataDir, 'c-room-0', '/p/room-new')
    assert.notEqual(oldMsg, newMsg)
    backend = await startBackend(s, { avatarStore: { contactSync: FAST_SYNC } })
    await until(async () => (await lineStatus(backend)).state === 'running', { message: 'the first import' })
    await until(async () => (await info(backend)).avatarStore.contactSync.scans >= 1, { message: 'the first sync' })
    const db = appRead(s)
    try {
      await until(() => db.prepare('SELECT COUNT(*) AS n FROM messages').get().n === 20, { message: 'all 20 messages imported' })
      const ids = db.prepare("SELECT msg_id FROM messages WHERE sender IS NOT NULL ORDER BY msg_id").all().map((r) => r.msg_id)
      const msgOf = db.prepare("SELECT ms.msg_id AS id FROM line_message_sender ms JOIN line_sender_profile sp ON sp.sender_id=ms.sender_id WHERE sp.sender_mid='u-sender-001' LIMIT 1").get().id
      assert.ok(ids.length > 0)
      const before = (await backend.call('media', { path: 'media.avatar.prepareMessages', args: ['c-room-0', [msgOf]] })).value
      assert.equal(before.paths[msgOf], oldMsg)
      assert.equal((await backend.call('media', { path: 'media.avatar.prepareChats', args: [['c-room-0']] })).value.paths['c-room-0'], oldChat)

      const scansBefore = (await info(backend)).avatarStore.contactSync.scans
      const w = new DatabaseSync(s.src)
      w.prepare("UPDATE _contact SET _picturePath='/p/new-1' WHERE _mid='u-sender-001'").run()
      w.prepare("UPDATE _groupChat SET _picturePath='/p/room-new' WHERE _chatMid='c-room-0'").run()
      w.close()
      await until(() => db.prepare("SELECT locator FROM line_entity WHERE kind='contact' AND entity_mid='u-sender-001'").get()?.locator === '/p/new-1', { message: 'the entity row follows the source' })
      assert.ok((await info(backend)).avatarStore.contactSync.scans > scansBefore)
      const after = (await backend.call('media', { path: 'media.avatar.prepareMessages', args: ['c-room-0', [msgOf]] })).value
      assert.equal(after.paths[msgOf], newMsg, 'the message avatar points at the new picture')
      assert.notEqual(after.paths[msgOf], before.paths[msgOf])
      assert.equal((await backend.call('media', { path: 'media.avatar.prepareChats', args: [['c-room-0']] })).value.paths['c-room-0'], newChat, 'and so does the group avatar')

      // P-2: no fixture MID or picture path in the state or the trace, and our own MID in no table
      const state = JSON.stringify(await info(backend))
      const trace = readFileSync(join(s.dataDir, 'logs', 'invoke-trace.log'), 'utf8')
      for (const needle of [ME, 's-square-0', '/p/', HASH_OK, 'Sender ', 'Square 0']) {
        assert.equal((state + trace).includes(needle), false, `${needle} is nowhere in the state or the trace`)
      }
      assert.equal(/u-sender-d{3}|u-account/.test(state + trace), false, 'no sender MID in backend.info or the trace')
      assert.equal(JSON.stringify((await info(backend)).avatarStore.contactSync).includes('c-room-0'), false, 'and no group MID in the sync state')
      assert.deepEqual(holders(db, ME), [], 'the account MID is in no table')
    } finally { db.close() }
  } finally {
    await backend?.dispose()
    s.cleanup()
  }
})

test('K-1 switch off: with avatarStore.contactSync.enabled=false the worker never starts, the reader ignores entity rows that already exist (no picture), and the state says off; switched on again it uses them', { timeout: 90_000 }, async () => {
  const s = stage(wireSpec())
  let backend
  try {
    const entityChat = seedAvatarCache(s.dataDir, 'c-room-0', '/p/entity-only')
    backend = await startBackend(s, { avatarStore: { contactSync: FAST_SYNC } })
    await until(async () => (await info(backend)).avatarStore.contactSync.scans >= 1, { message: 'the first sync' })
    await backend.dispose()
    backend = null
    const w = new Database(appDbPath(s))
    w.prepare("UPDATE line_entity SET locator='/p/entity-only' WHERE kind='group' AND entity_mid='c-room-0'").run()
    w.close()

    backend = await startBackend(s, { avatarStore: { contactSync: { ...FAST_SYNC, enabled: false } } })
    await until(async () => (await lineStatus(backend)).state === 'running', { message: 'the import' })
    const state = (await info(backend)).avatarStore.contactSync
    assert.equal(state.enabled, false)
    assert.equal(state.phase, 'off')
    assert.equal(state.schemaReady, false)
    assert.equal((await backend.call('media', { path: 'media.avatar.prepareChats', args: [['c-room-0']] })).value.paths['c-room-0'], undefined, 'the entity row is ignored: no picture, a letter')
    await sleepMs(300)
    assert.equal((await info(backend)).avatarStore.contactSync.scans, 0, 'no worker ran')
    await backend.dispose()
    backend = null

    backend = await startBackend(s, { avatarStore: { contactSync: { ...FAST_SYNC, minIntervalMs: 3_600_000 } } })
    await until(async () => (await lineStatus(backend)).state === 'running', { message: 'the import' })
    assert.equal((await backend.call('media', { path: 'media.avatar.prepareChats', args: [['c-room-0']] })).value.paths['c-room-0'], entityChat, 'switched on, the entity row is used')
  } finally {
    await backend?.dispose()
    s.cleanup()
  }
})

test('K-2 table dropped at run time: the reader keeps answering (without a picture), the worker does not throw, and the state shows the schema as not ready', { timeout: 90_000 }, async () => {
  const s = stage(wireSpec())
  let backend
  try {
    backend = await startBackend(s, { avatarStore: { contactSync: FAST_SYNC } })
    await until(async () => (await info(backend)).avatarStore.contactSync.scans >= 1, { message: 'the first sync' })
    assert.equal((await info(backend)).avatarStore.contactSync.schemaReady, true)
    const w = new Database(appDbPath(s))
    w.exec('DROP TABLE line_entity')
    w.close()
    await until(async () => { const c = (await info(backend)).avatarStore.contactSync; return c.schemaReady === false && c.phase === 'schema_unavailable' }, { message: 'the state shows the missing schema' })
    const answer = await backend.call('media', { path: 'media.avatar.prepareChats', args: [['c-room-0']] })
    assert.equal(answer.ok, true)
    assert.equal(answer.value.paths['c-room-0'], undefined)
    assert.equal((await info(backend)).avatarStore.schemaReady, true, 'the avatar feature itself is untouched')
  } finally {
    await backend?.dispose()
    s.cleanup()
  }
})

test('T-2 any only: the worker opens the LINE source with policy any — the snapshot store is never asked for fresh — and the wiring names no other policy', async () => {
  const s = stage(wireSpec())
  const db = appDbWith({ entity: true })
  try {
    const calls = []
    const store = {
      acquire: async (_src, policy) => { calls.push(policy); return { path: s.src, source: { edb: [1, 2], wal: null }, release: () => undefined, shouldYield: () => false } },
      invalidate: () => undefined,
      stats: () => ({ fullCopies: 0 })
    }
    configureLineEnginePorts({ fs: s.fs, sqlite: s.sqlite, dbDir: s.lineDir })
    const access = createLineAccess({ store })
    configureLineEnginePorts({ access })
    ;(await access.open({ dbPath: s.src, policy: 'fresh', keyOpts: s.keyOpts })).cleanup()
    assert.deepEqual(calls, ['fresh'], 'the key is held after one fresh open (set-up)')
    calls.length = 0
    const { sync } = syncOver(s.src, db, { options: { openSource: () => access.open({ dbPath: null, policy: 'any', keyOpts: s.keyOpts }) } })
    sync.start()
    await until(() => sync.status().scans >= 1, { message: 'a scan through the real access' })
    await sync.dispose()
    assert.ok(calls.length >= 1)
    assert.deepEqual([...new Set(calls)], ['any'])
    assert.equal(calls.filter((policy) => policy === 'fresh').length, 0)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM line_entity WHERE kind='contact'").get().n, 4)

    const assemble = readFileSync(join(srcRoot, 'plugin', 'backend', 'assemble.ts'), 'utf8')
    const block = assemble.slice(assemble.indexOf('createContactSync({'), assemble.indexOf('budget: contactSyncBudget'))
    assert.ok(block.length > 100, 'found the wiring block')
    assert.match(block, /policy: 'any'/)
    assert.equal(/fresh/.test(block), false)
    assert.equal(/fresh/.test(readFileSync(join(srcRoot, 'plugin', 'backend', 'contactSync.ts'), 'utf8')), false, 'contactSync.ts knows nothing about fresh')
  } finally {
    db.close()
    s.cleanup()
  }
})

// ───────────── P: privacy (static) ─────────────

const srcRoot = resolve(import.meta.dirname, '..', '..', 'src')

test('P-1 static: the table and its MID column are named only in lineEntity.repo.ts; lineAvatar.repo.ts never names the entity MID column; contactSync.ts has no MID, locator or name near a log, trace or status line', () => {
  const files = readdirSync(srcRoot, { recursive: true }).map(String).filter((f) => /\.(ts|tsx)$/.test(f))
  assert.ok(files.length > 100, 'the whole src tree was scanned')
  const holdersOf = (pattern) => files.filter((f) => pattern.test(readFileSync(join(srcRoot, f), 'utf8'))).map((f) => f.split(/[\\/]/).pop())
  assert.deepEqual(holdersOf(/line_entity|entity_mid/), ['lineEntity.repo.ts'])
  assert.equal(/entity_mid|line_entity/.test(readFileSync(join(srcRoot, 'main', 'db', 'lineAvatar.repo.ts'), 'utf8')), false)
  for (const f of ['plugin/backend/assemble.ts', 'plugin/backend/invokeTrace.ts']) {
    assert.equal(/line_entity|entity_mid/.test(readFileSync(join(srcRoot, f), 'utf8')), false, `${f} never names the entity table`)
  }
  const text = readFileSync(join(srcRoot, 'plugin', 'backend', 'contactSync.ts'), 'utf8')
  const lines = text.split(/\r?\n/).filter((line) => /\blog\(|options\.log|options\.trace|trace\?\.|options\.onStat|stat\(|onSlice/.test(line))
  assert.ok(lines.length >= 5, 'contactSync.ts has observation calls')
  for (const line of lines) assert.equal(/mid|identity|locator|displayName|\.from\b|msgId/i.test(line), false, line.trim())
})
