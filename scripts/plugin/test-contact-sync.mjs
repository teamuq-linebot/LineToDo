// LINE address-book sync: the `line_entity` table (lineEntity.repo.ts), the keyset readers (linedb.ts), the sync worker (contactSync.ts),
// the entity layer of the local reader (lineAvatar.repo.ts / avatarReader.ts) and the production wiring (assemble.ts).
// The LINE side is synthetic: a plain SQLite file with the LINE table shapes behind a fake connection; time is injected (now, wallClock, sleep, yieldLoop),
// there is no wall-clock threshold anywhere, no real LINE, key or network is touched.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import * as linedb from '../../src/main/line/engine/linedb.ts'
import { openDatabase } from '../../src/main/db/database.ts'
import { ensureLineAvatarSchema, isLineAvatarSchemaReady } from '../../src/main/db/lineAvatar.repo.ts'
import { ENTITY_KINDS, countEntities, ensureLineEntitySchema, isLineEntitySchemaReady, liveEntityMids, markGone, purgeGone, readEntities, upsertEntity } from '../../src/main/db/lineEntity.repo.ts'

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

test('S-3 schema: the columns of line_entity are exactly the design (no raw JSON column), the key is (kind, entity_mid), and the CHECKs reject bad values', () => {
  const db = appDbWith({ entity: true })
  try {
    const columns = db.prepare("PRAGMA table_info('line_entity')").all().map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, pk: c.pk }))
    assert.deepEqual(columns, [
      { name: 'kind', type: 'TEXT', notnull: 1, pk: 1 },
      { name: 'entity_mid', type: 'TEXT', notnull: 1, pk: 2 },
      { name: 'source', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'locator', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'display_name', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'synced_at', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'gone_at', type: 'INTEGER', notnull: 0, pk: 0 }
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

// ───────────── repo semantics (upsert / gone / purge / read) ─────────────

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

test('repo gone: markGone marks only live rows and keeps locator and name; an upsert from the source brings the row back (gone_at NULL) even with unchanged content', () => {
  const db = appDbWith({ entity: true })
  try {
    for (const mid of ['u1', 'u2', 'u3']) upsertEntity(db, person(mid, `/p/${mid}`, `N ${mid}`), 10)
    assert.deepEqual(liveEntityMids(db, 'contact').sort(), ['u1', 'u2', 'u3'])
    assert.equal(markGone(db, 'contact', ['u2'], 50), 1)
    assert.equal(markGone(db, 'contact', ['u2'], 60), 0, 'already gone: not touched again')
    assert.deepEqual(liveEntityMids(db, 'contact').sort(), ['u1', 'u3'])
    const gone = entityRows(db).find((r) => r.entity_mid === 'u2')
    assert.deepEqual({ gone_at: gone.gone_at, locator: gone.locator, name: gone.display_name }, { gone_at: 50, locator: '/p/u2', name: 'N u2' })
    assert.equal(markGone(db, 'group', ['u1'], 70), 0, 'a different kind is a different row')
    assert.equal(upsertEntity(db, person('u2', '/p/u2', 'N u2'), 80), true, 'revived')
    assert.equal(entityRows(db).find((r) => r.entity_mid === 'u2').gone_at, null)
  } finally { db.close() }
})

test('repo purge: only rows gone for longer than the retention go; live rows and kinds that are not listed stay', () => {
  const db = appDbWith({ entity: true })
  try {
    const now = 1_000 * DAY
    upsertEntity(db, person('old', '/p/o', 'Old'), now)
    upsertEntity(db, person('recent', '/p/r', 'Recent'), now)
    upsertEntity(db, person('live', '/p/l', 'Live'), now)
    upsertEntity(db, person('oldgroup', '/p/g', 'G', 'group'), now)
    markGone(db, 'contact', ['old'], now - 91 * DAY)
    markGone(db, 'contact', ['recent'], now - 89 * DAY)
    markGone(db, 'group', ['oldgroup'], now - 200 * DAY)
    assert.equal(purgeGone(db, now, 90 * DAY, ['contact']), 1)
    assert.deepEqual(entityRows(db).map((r) => `${r.kind}/${r.entity_mid}`).sort(), ['contact/live', 'contact/recent', 'group/oldgroup'])
    assert.equal(purgeGone(db, now, 90 * DAY), 1, 'now the group row too')
    assert.equal(purgeGone(db, now, 90 * DAY, []), 0)
    assert.equal(countEntities(db, 'contact'), 2)
  } finally { db.close() }
})

test('repo read: readEntities returns the rows asked for (gone ones too), per kind, in any batch size', () => {
  const db = appDbWith({ entity: true })
  try {
    for (let i = 0; i < 1000; i += 1) upsertEntity(db, person(`u${i}`, `/p/${i}`, `N${i}`), 1)
    upsertEntity(db, person('u5', '/g/5', 'Group five', 'group'), 1)
    markGone(db, 'contact', ['u7'], 2)
    const mids = Array.from({ length: 1005 }, (_, i) => `u${i}`)
    const contacts = readEntities(db, 'contact', mids)
    assert.equal(contacts.size, 1000)
    assert.equal(contacts.get('u7').goneAt, 2)
    assert.equal(contacts.get('u7').locator, '/p/7')
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
  if (!spec.noGroupTable) db.exec('CREATE TABLE _groupChat(_chatMid TEXT PRIMARY KEY, _chatName TEXT, _picturePath TEXT)')
  if (!spec.noSquareTable) db.exec('CREATE TABLE _squareChat(_squareChatMid TEXT PRIMARY KEY, _name TEXT, _chatImageObsHash TEXT)')
  if (!spec.noProfile) db.prepare('INSERT INTO _profile(_mid,_picturePath) VALUES (?,?)').run(spec.me ?? ME, '/p/me')
  populateLine(db, spec)
  db.close()
}

function populateLine(db, spec) {
  const cols = ['_mid', '_displayNameOverridden', '_displayName']
  if (!spec.noDetailColumn) cols.push('_targetProfileDetail')
  if (!spec.noPictureColumn) cols.push('_picturePath')
  const addContact = db.prepare(`INSERT INTO _contact(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
  db.exec('BEGIN')
  for (const c of spec.contacts ?? []) {
    const values = [c.mid, c.over ?? null, c.name ?? `name ${c.mid}`]
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
