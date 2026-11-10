// Avatars in the local DB (lineAvatar.repo.ts, avatarReader.ts, avatarBackfill.ts), through the production wiring (assemble.ts).
//
// A-4 import-time writes: watchEngine collects one avatar source per distinct (chat, sender) on the connection that is already open (query count independent of the row count; chats come only from the address book),
//   the plugin backend creates the four tables, a poll through createPluginBackend writes the links (incoming only), getMessagesSince collects nothing.
// A-5 reader: three rules only (non-Square: line_entity; Square member: line_sender_profile; otherwise no picture), local only (no LINE open, no copy, median CPU time of calls 2..20 < 60 ms), R-AV-4 (avatarCache.load stats the key directly).
// A-6 backfill: 'any' only, messages only (no chats phase), newest first, <= 15 ms slices at about a 25 % duty cycle, interruptible and resumable, gap detection, dispose quiet.
// The LINE side is synthetic: a plain SQLite file with the LINE table shapes behind a fake engine (no real LINE, key or network is touched; fetch is replaced by a thrower).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import Database from 'better-sqlite3'

import { configureLineEnginePorts, getLineEnginePorts, resetLineEnginePorts } from '../../src/main/line/engine/enginePorts.ts'
import { collectAvatarMeta, getAvatarMetadata, getLineImportBatch, getMessagesSince } from '../../src/main/line/engine/watchEngine.ts'
import { createNodeLineFsPort } from '../../src/main/line/engine/nodeLineFsPort.ts'
import { avatarCacheKey, createAvatarCache } from '../../src/plugin/backend/avatarCache.ts'
import { createLayeredAvatarReader } from '../../src/plugin/backend/avatarReader.ts'
import * as linedb from '../../src/main/line/engine/linedb.ts'
import { AVATAR_BACKFILL_VERSION, advanceLinkWatermark, ensureLineAvatarSchema, createSenderLinker, hasLinkGap } from '../../src/main/db/lineAvatar.repo.ts'
import { ensureLineImportSchema } from '../../src/main/db/lineImport.repo.ts'
import { ensureLineEntitySchema, upsertEntity } from '../../src/main/db/lineEntity.repo.ts'
import { createAvatarBackfill } from '../../src/plugin/backend/avatarBackfill.ts'
import { LineSnapshotStore } from '../../src/main/line/engine/lineSnapshot.ts'
import { createLineAccess } from '../../src/main/line/engine/lineAccess.ts'
import { openDatabase } from '../../src/main/db/database.ts'
import { createPluginBackend } from '../../src/plugin/backend/assemble.ts'

const GOOD_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const ME = 'u-account-mid-0000'
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
/**
 * The time criterion of A-5 is the CPU time this process spends per call (process.cpuUsage, user + system), not the wall clock: the wall clock of a call is multiplied by whatever else
 * the machine is doing (a 31 ms call measured 242 ms under load) while its CPU cost stays put (reviewer-b r1 4(b)). Windows reports CPU time in steps of about 15.6 ms, so the
 * criterion is the MEDIAN of calls 2..N (the first, cold call is only recorded), never the maximum. No retry, no loosened threshold.
 */
async function withCpu(run) {
  const before = process.cpuUsage()
  const wall0 = performance.now()
  const value = await run()
  const used = process.cpuUsage(before)
  return { value, cpuMs: (used.user + used.system) / 1000, wallMs: performance.now() - wall0 }
}
const median = (values) => { const s = [...values].sort((a, b) => a - b); const mid = s.length >> 1; return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2 }
const CPU_MEDIAN_LIMIT_MS = 60
const WALL_STUCK_LIMIT_MS = 5_000
function assertCpuCriterion(samples, what) {
  const warm = samples.slice(1)
  const cpu = warm.map((s) => s.cpuMs)
  const detail = `${what}: cold call ${samples[0].cpuMs.toFixed(1)} ms CPU (recorded only); calls 2..${samples.length} CPU ms [${cpu.map((n) => n.toFixed(0)).join(',')}], wall ms [${warm.map((s) => s.wallMs.toFixed(0)).join(',')}]`
  assert.ok(median(cpu) < CPU_MEDIAN_LIMIT_MS, `median CPU time of calls 2..${samples.length} is ${median(cpu).toFixed(1)} ms, limit ${CPU_MEDIAN_LIMIT_MS} ms; ${detail}`)
  assert.ok(Math.max(...samples.map((s) => s.wallMs)) < WALL_STUCK_LIMIT_MS, `a call was stuck for ${Math.max(...samples.map((s) => s.wallMs)).toFixed(0)} ms; ${detail}`)
}
async function until(predicate, { timeout = 15_000, step = 10, message = 'condition' } = {}) {
  const t0 = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - t0 > timeout) assert.fail(`timed out waiting for ${message}`)
    await sleep(step)
  }
}

let savedKeyEnv
let savedFetch
let fetchCalls = 0
test.before(() => {
  savedKeyEnv = process.env.LINE_DB_KEY
  delete process.env.LINE_DB_KEY
  savedFetch = globalThis.fetch
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('the network is not available in tests') }
})
test.after(() => {
  resetLineEnginePorts()
  globalThis.fetch = savedFetch
  if (savedKeyEnv !== undefined) process.env.LINE_DB_KEY = savedKeyEnv
})

// ───────────── a synthetic LINE database (plain SQLite with the LINE table shapes) ─────────────

/**
 * spec: { me, chats: [{ id, name?, picture? }], contacts: [{ mid, name?, picture? }], messages: [{ chat, from, ts? }] | { count, chats, senders, outEvery } }
 * Message ids are 1000001.. in insertion order (so rowid order = id order = time order).
 */
function makeLineDb(path, spec) {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE _profile(_mid TEXT, _picturePath TEXT);
    CREATE TABLE _chat(_id TEXT PRIMARY KEY, _lastUpdatedTime INTEGER, _lastMessage TEXT);
    CREATE TABLE _groupChat(_chatMid TEXT PRIMARY KEY, _chatName TEXT, _picturePath TEXT);
    CREATE TABLE _contact(_mid TEXT PRIMARY KEY, _displayNameOverridden TEXT, _displayName TEXT, _targetProfileDetail TEXT, _picturePath TEXT);
    CREATE TABLE _message(_id TEXT, _chatId TEXT, _createdTime INTEGER, _from TEXT, _text TEXT, _contentType INTEGER, _contentMetadata TEXT, _contentInfo TEXT, _attribute INTEGER);
  `)
  if (!spec.noProfile) db.prepare('INSERT INTO _profile(_mid,_picturePath) VALUES (?,?)').run(spec.me ?? ME, '/p/me-picture')
  const addChat = db.prepare('INSERT INTO _chat(_id,_lastUpdatedTime) VALUES (?,?)')
  const addGroup = db.prepare('INSERT INTO _groupChat(_chatMid,_chatName,_picturePath) VALUES (?,?,?)')
  for (const chat of spec.chats) {
    addChat.run(chat.id, 1)
    if (chat.id.startsWith('c')) addGroup.run(chat.id, chat.name ?? `room ${chat.id}`, chat.picture ?? null)
  }
  const addContact = db.prepare('INSERT INTO _contact(_mid,_displayName,_picturePath,_targetProfileDetail) VALUES (?,?,?,?)')
  for (const contact of spec.contacts) addContact.run(contact.mid, contact.name ?? `name ${contact.mid}`, contact.picture ?? null, contact.detail ?? null)
  const add = db.prepare('INSERT INTO _message(_id,_chatId,_createdTime,_from,_text,_contentType,_contentMetadata,_contentInfo,_attribute) VALUES (?,?,?,?,?,0,NULL,NULL,0)')
  db.exec('BEGIN')
  let n = 0
  const rows = Array.isArray(spec.messages) ? spec.messages : generated(spec.messages, spec)
  for (const row of rows) {
    n += 1
    add.run(String(1_000_000 + n), row.chat, row.ts ?? 1_700_000_000_000 + n * 1000, row.from, `text ${n}`)
  }
  db.exec('COMMIT')
  db.close()
  return n
}

function generated({ count, outEvery = 0, nullEvery = 0 }, spec) {
  const chats = spec.chats.map((c) => c.id)
  const people = spec.contacts.map((c) => c.mid)
  const rows = []
  for (let i = 0; i < count; i += 1) {
    const chat = chats[i % chats.length]
    const from = outEvery && i % outEvery === 0 ? (spec.me ?? ME) : nullEvery && i % nullEvery === 0 ? null : people[(i * 7) % people.length]
    rows.push({ chat, from })
  }
  return rows
}

const people = (n, picture = true) => Array.from({ length: n }, (_, i) => ({ mid: `u-sender-${String(i).padStart(3, '0')}`, name: `Sender ${i}`, picture: picture ? `/p/pic-${i}` : null }))
const chatsOf = (n) => Array.from({ length: n }, (_, i) => ({ id: `c-room-${i}`, name: `Room ${i}`, picture: `/p/room-${i}` }))

/** A directory with the synthetic LINE database, plus a counting fs port and a counting fake SQLite engine over plain files. */
function stage(spec, { name = 'qw0001.edb' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'avatar-store-'))
  const lineDir = join(root, 'LINE', 'Data', 'db')
  const dataDir = join(root, 'data')
  mkdirSync(lineDir, { recursive: true })
  mkdirSync(join(dataDir, 'line-engine'), { recursive: true })
  const src = join(lineDir, name)
  const rowCount = makeLineDb(src, spec)
  const base = createNodeLineFsPort({ tempRoot: join(dataDir, 'line-engine') })
  const calls = { copy: 0, copyAsync: 0, opens: 0, queries: 0, sql: [] }
  const fs = {
    readDir: (d) => base.readDir(d), stat: (p) => base.stat(p), exists: (p) => base.exists(p), readFile: (p) => base.readFile(p),
    copyFile: (s, d) => { calls.copy += 1; base.copyFile(s, d) },
    copyFileAsync: async (s, d) => { calls.copyAsync += 1; await base.copyFileAsync(s, d) },
    readHead: (p, n) => base.readHead(p, n), makeTempDir: (p) => base.makeTempDir(p), removeDir: (d) => base.removeDir(d), ensureDir: (d) => base.ensureDir(d),
    readTextFile: (p) => base.readTextFile(p), writeTextFile: (p, t) => base.writeTextFile(p, t), renameFile: (a, b) => base.renameFile(a, b),
    listProcessIds: () => []
  }
  const hooks = { failWhen: null }
  const sqlite = {
    name: 'fake-plain-sqlite',
    open(path) {
      calls.opens += 1
      const db = new DatabaseSync(path, { readOnly: true })
      const run = (kind, sql, params) => {
        calls.queries += 1
        calls.sql.push(sql)
        if (hooks.failWhen?.(sql, params)) throw new Error('synthetic LINE read failure')
        const statement = db.prepare(sql)
        return kind === 'get' ? statement.get(...params) : statement.all(...params)
      }
      return { pragma: () => [], prepare: (sql) => ({ get: (...params) => run('get', sql, params), all: (...params) => run('all', sql, params) }), close: () => db.close() }
    }
  }
  writeFileSync(join(dataDir, '.linekey'), GOOD_KEY)
  const keyOpts = { cacheFile: join(dataDir, '.linekey') }
  return {
    root, lineDir, dataDir, src, fs, sqlite, calls, hooks, rowCount, keyOpts,
    stateFile: join(dataDir, '.watch_json_state'),
    copies: () => calls.copy + calls.copyAsync,
    legacyPorts: () => configureLineEnginePorts({ fs, sqlite, dbDir: lineDir }),
    cleanup: () => { resetLineEnginePorts(); rmSync(root, { recursive: true, force: true }) }
  }
}

const SPEC_SMALL = { chats: chatsOf(2), contacts: people(3), messages: { count: 30, outEvery: 5 } }

// ───────────── A-4: collection (watchEngine) ─────────────

test('A-4 collect: getLineImportBatch with avatarMeta reads one source per distinct (chat, sender) — never the account MID — and the query count does not grow with the row count', async () => {
  const bounds = []
  for (const count of [40, 400]) {
    const s = stage({ chats: chatsOf(2), contacts: people(3), messages: { count, outEvery: 4 } })
    try {
      s.legacyPorts()
      const cursor = { createdTime: 0, rowId: 0 }
      const q0 = s.calls.queries
      const plain = await getLineImportBatch({ stateFile: s.stateFile, keyOpts: s.keyOpts, cursor, limit: 1000 })
      const plainQueries = s.calls.queries - q0
      assert.equal(plain.avatarMeta, undefined, 'collection is opt-in')
      assert.equal(plain.items.length, count)
      const q1 = s.calls.queries
      const batch = await getLineImportBatch({ stateFile: s.stateFile, keyOpts: s.keyOpts, cursor, limit: 1000, avatarMeta: true })
      const extra = s.calls.queries - q1 - plainQueries
      const { senders } = batch.avatarMeta
      assert.equal(batch.avatarMeta.chats, undefined, 'chats are not collected: their pictures come only from the address book')
      const distinctSenders = new Set(batch.items.filter((i) => i.senderMid && i.senderMid !== ME).map((i) => `${i.message.chatId}\0${i.senderMid}`))
      assert.deepEqual(senders.map((x) => `${x.chatId}\0${x.senderMid}`).sort(), [...distinctSenders].sort())
      assert.equal(senders.some((x) => x.senderMid === ME), false, 'the account MID is not collected')
      assert.ok(senders.every((x) => x.source.locator?.startsWith('/p/pic-') && x.source.identity === x.senderMid))
      assert.ok(extra <= 7 * distinctSenders.size, `${extra} extra queries <= 7*${distinctSenders.size}`)
      bounds.push({ count, extra, senders: distinctSenders.size })
    } finally { s.cleanup() }
  }
  assert.equal(bounds[0].extra, bounds[1].extra, `ten times the rows, the same number of extra queries (${JSON.stringify(bounds)})`)
  assert.equal(bounds[0].senders, bounds[1].senders)
})

test('A-4 collect: getMessagesSince never collects (even when the engine options ask for it), and batchId does not depend on avatarMeta', async () => {
  const s = stage(SPEC_SMALL)
  try {
    s.legacyPorts()
    const cursor = { createdTime: 0, rowId: 0 }
    const q0 = s.calls.queries
    const withoutMeta = await getLineImportBatch({ stateFile: s.stateFile, keyOpts: s.keyOpts, cursor, limit: 100 })
    const plainQueries = s.calls.queries - q0
    const q1 = s.calls.queries
    const rows = await getMessagesSince(0, { stateFile: s.stateFile, keyOpts: s.keyOpts, avatarMeta: true })
    assert.equal(s.calls.queries - q1, plainQueries, 'the legacy window reader issues exactly the queries of a batch without avatarMeta')
    assert.equal(rows.length, withoutMeta.items.length)

    const full = await getLineImportBatch({ stateFile: s.stateFile, keyOpts: s.keyOpts, cursor, limit: 100, avatarMeta: true })
    assert.equal(full.batchId, withoutMeta.batchId)
  } finally { s.cleanup() }
})

test('A-4 collect: a lookup that throws drops only that sender, never the others and never the batch', () => {
  const con = {
    prepare: () => ({
      get: (...params) => { if (params.includes('bad-sender') || params.includes('bad-chat')) throw new Error('synthetic read failure'); return undefined },
      all: () => []
    })
  }
  const rows = [
    { chatId: 'c-ok', from: 'good-sender' }, { chatId: 'c-ok', from: 'bad-sender' }, { chatId: 'bad-chat', from: 'good-sender' },
    { chatId: 'c-ok', from: ME }, { chatId: 'c-ok', from: null }, { chatId: 'c-ok', from: 'good-sender' }
  ]
  const meta = collectAvatarMeta(con, rows, ME)
  assert.equal(meta.chats, undefined)
  assert.deepEqual(meta.senders.map((x) => `${x.chatId}/${x.senderMid}`), ['c-ok/good-sender', 'bad-chat/good-sender'])
})

// ───────────── A-4: the production wiring (createPluginBackend) ─────────────

const info = async (backend) => (await backend.call('backend', { path: 'backend.info', args: [] })).value
const lineStatus = async (backend) => (await backend.call('line', { path: 'line.status', args: [] })).value
const readTrace = (dataDir) => {
  const file = join(dataDir, 'logs', 'invoke-trace.log')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
}

async function startBackend(s, extra = {}) {
  writeFileSync(join(s.dataDir, 'settings.json'), JSON.stringify({ version: 1, reconcile: { enabled: false, scopeMonths: 0 } }))
  const backend = await createPluginBackend({
    pluginId: 'tuqdev.line-todo', version: 'test', dataDir: s.dataDir,
    linePorts: { fs: s.fs, sqlite: s.sqlite, dbDir: s.lineDir },
    watcher: { intervalSec: 3600, startupDelayMs: 20 },
    snapshot: { walOnly: true },
    trace: { eventMinMs: 0 },
    ...extra
  })
  return backend
}

/** The app DB through a second connection (the backend runs with WAL; a reader sees the committed state). */
function appDb(s) {
  return new Database(join(s.dataDir, 'line-todo.db'), { readonly: true })
}

test('A-4 wiring: through createPluginBackend the avatar tables exist (user_version unchanged), a poll writes sender profiles and links for incoming messages only, and the account MID is nowhere in the app DB', { timeout: 60_000 }, async () => {
  const s = stage(SPEC_SMALL)
  let backend
  try {
    backend = await startBackend(s, { avatarStore: { backfill: { enabled: false } } })
    await until(async () => (await lineStatus(backend)).state === 'running', { message: 'the first import' })
    const state = await info(backend)
    assert.equal(state.avatarStore.enabled, true)
    assert.equal(state.avatarStore.schemaReady, true)
    const db = appDb(s)
    try {
      assert.equal(db.pragma('user_version', { simple: true }), 10)
      await until(() => db.prepare('SELECT COUNT(*) AS n FROM messages').get().n === 30, { message: 'all 30 messages imported' })
      const incoming = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE direction='in'").get().n
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM line_message_sender').get().n, incoming, 'every incoming message is linked, no outgoing one')
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM line_message_sender ms JOIN messages m ON m.msg_id=ms.msg_id WHERE m.direction='out'").get().n, 0)
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM line_chat_avatar').get().n, 0, 'the chat level is not written any more')
      assert.ok(db.prepare('SELECT COUNT(*) AS n FROM line_sender_profile').get().n >= 3)
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM line_sender_profile WHERE sender_mid=?").get(ME).n, 0)
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
        const text = JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())
        assert.equal(text.includes(ME), false, `the account MID is not in ${name}`)
      }
      assert.ok(db.prepare("SELECT value FROM line_avatar_meta WHERE key='link_watermark'").get().value)
    } finally { db.close() }
    // nothing about the sender MIDs reaches diagnostics
    const everything = JSON.stringify(state) + readFileSync(join(s.dataDir, 'logs', 'invoke-trace.log'), 'utf8')
    assert.equal(/u-sender-\d{3}|u-account/.test(everything), false, 'no MID in backend.info, recentLog or the trace')
  } finally {
    await backend?.dispose()
    s.cleanup()
  }
})

test('A-4 wiring: avatarStore:{enabled:false} is the old behaviour — no table, no collection, no write', { timeout: 60_000 }, async () => {
  const s = stage(SPEC_SMALL)
  let backend
  try {
    backend = await startBackend(s, { avatarStore: { enabled: false } })
    await until(async () => (await lineStatus(backend)).state === 'running', { message: 'the first import' })
    const state = await info(backend)
    assert.equal(state.avatarStore.enabled, false)
    assert.equal(state.avatarStore.schemaReady, false)
    const db = appDb(s)
    try {
      await until(() => db.prepare('SELECT COUNT(*) AS n FROM messages').get().n === 30, { message: 'all 30 messages imported' })
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('line_avatar_meta','line_chat_avatar','line_sender_profile','line_message_sender')").get().n, 0)
    } finally { db.close() }
  } finally {
    await backend?.dispose()
    s.cleanup()
  }
})

// ───────────── A-5: the layered reader ─────────────

/** An app DB (the real schema, foreign keys on) with the avatar tables, some chats and some messages. */
function appDbWith({ chats = ['c-room-0'], messages = [] } = {}) {
  const opened = openDatabase({ dbPath: ':memory:' })
  const db = opened.db
  ensureLineAvatarSchema(db)
  ensureLineEntitySchema(db)
  const at = new Date('2026-11-02T00:00:00.000Z').toISOString()
  for (const chat of chats) db.prepare('INSERT INTO chats(chat_id,name,is_group,blocked,first_seen_at,last_seen_at) VALUES (?,?,1,0,?,?)').run(chat, chat, at, at)
  messages.forEach((m, i) => db.prepare(`INSERT INTO messages(msg_id,chat_id,ts,time_iso,direction,sender,text,content_type,processed,ingested_at)
    VALUES (?,?,?,?,?,?,?,0,0,?)`).run(m.id, m.chat ?? chats[0], 1_700_000_000_000 + i, at, m.direction ?? 'in', 'someone', `text ${i}`, at))
  return db
}

const src = (identity, locator, displayName = null, source = 'profile') => ({ identity, locator, displayName, source: locator ? source : null })
const counted = (impl) => { const f = async (input) => { f.calls.push(input); return impl ? impl(input) : { chats: {}, messages: {} } }; f.calls = []; return { read: f, calls: f.calls } }
const rowsOf = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n

/** Seeds `n` incoming messages from `senders` senders into one chat, linked the way an import would link them. */
function seedLinked(db, { chat = 'c-room-0', n = 200, senders = 5, tag = 'm', book = true } = {}) {
  const ids = Array.from({ length: n }, (_, i) => `i:${tag}${i}`)
  const at = new Date().toISOString()
  ids.forEach((id, i) => db.prepare(`INSERT INTO messages(msg_id,chat_id,ts,time_iso,direction,sender,text,content_type,processed,ingested_at)
    VALUES (?,?,?,?,'in','x','t',0,0,?)`).run(id, chat, 1_700_000_000_000 + i, at, at))
  const linker = createSenderLinker(db)
  const sid = Array.from({ length: senders }, (_, k) => linker.upsert(chat, `u-sender-${String(k).padStart(3, '0')}`, src('x', `/p/pic-${k}`, `Sender ${k}`), Date.now()))
  if (book) for (let k = 0; k < senders; k += 1) upsertEntity(db, { kind: 'contact', mid: `u-sender-${String(k).padStart(3, '0')}`, source: 'profile', locator: `/p/pic-${k}`, displayName: `Sender ${k}` }, Date.now())
  ids.forEach((id, i) => linker.link(id, chat, sid[i % senders]))
  return ids
}

test('A-5 local first: with 200 linked messages, 20 consecutive reads return the original sender identity and locator from the address book, the median CPU time of reads 2..20 is < 60 ms, and the reader has no way to reach LINE', async () => {
  const db = appDbWith()
  try {
    const ids = seedLinked(db, { n: 200, senders: 5 })
    upsertEntity(db, { kind: 'group', mid: 'c-room-0', source: 'profile', locator: '/p/room', displayName: 'Room 0' }, Date.now())
    const stats = { local: 0, miss: 0 }
    const reader = createLayeredAvatarReader({ getDb: () => db, entityOn: () => true, onStat: (kind, n) => { stats[kind] += n } })
    const samples = []
    for (let i = 0; i < 20; i += 1) {
      const { value: answer, cpuMs, wallMs } = await withCpu(() => reader.read({ chatId: 'c-room-0', msgIds: ids }))
      samples.push({ cpuMs, wallMs })
      assert.equal(Object.keys(answer.messages).length, 200)
      assert.deepEqual(answer.messages['i:m7'], { identity: 'u-sender-002', locator: '/p/pic-2', displayName: 'Sender 2', source: 'profile' })
    }
    const chats = await reader.read({ chatIds: ['c-room-0'] })
    assert.deepEqual(chats.chats['c-room-0'], { identity: 'c-room-0', locator: '/p/room', displayName: 'Room 0', source: 'profile' })
    assertCpuCriterion(samples, 'reader.read')
    assert.deepEqual(stats, { local: 20 * 200 + 1, miss: 0 })
  } finally { db.close() }
})

test('A-5 the three rules: (1) non-Square — line_entity with a locator is used, and it wins over an older line_sender_profile copy and over the retired line_chat_avatar; (2) Square member — line_sender_profile; (3) anything else — nothing, so the screen shows a letter', async () => {
  const db = appDbWith({ chats: ['c-room-0', 'c-square', 'c-nobody'] })
  try {
    const at = new Date().toISOString()
    const linker = createSenderLinker(db)
    const addMsg = (id, chat) => db.prepare("INSERT INTO messages(msg_id,chat_id,ts,time_iso,direction,sender,text,content_type,processed,ingested_at) VALUES (?,?,1,?,'in','x','t',0,0,?)").run(id, chat, at, at)
    const link = (id, chat, mid, source) => { addMsg(id, chat); linker.link(id, chat, linker.upsert(chat, mid, source, Date.now())) }
    link('i:contact', 'c-room-0', 'u-friend', src('x', '/p/OLD', 'Old name'))
    link('i:square', 'c-square', 'sq-member', src('x', '/p/square-member', 'Member', 'square'))
    link('i:unknown', 'c-nobody', 'u-stranger', src('x', '/p/stranger-copy', 'Stranger'))
    link('i:square-no-photo', 'c-square', 'sq-plain', src('x', null, 'Plain'))
    upsertEntity(db, { kind: 'contact', mid: 'u-friend', source: 'profile', locator: '/p/NEW', displayName: 'New name' }, Date.now())
    upsertEntity(db, { kind: 'contact', mid: 'sq-member', source: 'profile', locator: '/p/entity-must-not-win', displayName: 'X' }, Date.now())
    upsertEntity(db, { kind: 'group', mid: 'c-room-0', source: 'profile', locator: '/p/entity-room', displayName: 'Room' }, Date.now())
    db.prepare("INSERT INTO line_chat_avatar(chat_id,source,locator,display_name,refreshed_at) VALUES ('c-room-0','profile','/p/retired-chat-copy','Retired',?)").run(Date.now())
    db.prepare("INSERT INTO line_chat_avatar(chat_id,source,locator,display_name,refreshed_at) VALUES ('c-nobody','profile','/p/retired-only','Retired',?)").run(Date.now())
    const reader = createLayeredAvatarReader({ getDb: () => db, entityOn: () => true })

    const a = await reader.read({ chatIds: ['c-room-0', 'c-nobody'], chatId: 'c-room-0', msgIds: ['i:contact'] })
    assert.equal(a.chats['c-room-0'].locator, '/p/entity-room', 'rule 1: the address book, not the retired chat table')
    assert.equal('c-nobody' in a.chats, false, 'rule 3: the retired chat table is not read')
    assert.deepEqual(a.messages['i:contact'], { identity: 'u-friend', locator: '/p/NEW', displayName: 'New name', source: 'profile' }, 'rule 1: the address book wins over the older sender copy')

    const b = await reader.read({ chatId: 'c-square', msgIds: ['i:square', 'i:square-no-photo'] })
    assert.deepEqual(b.messages['i:square'], { identity: 'sq-member', locator: '/p/square-member', displayName: 'Member', source: 'square' }, 'rule 2: a Square member keeps the picture the import stored')
    assert.equal(b.messages['i:square-no-photo'], undefined, 'a sender copy that is not a Square member is not read')

    const c = await reader.read({ chatId: 'c-nobody', msgIds: ['i:unknown'] })
    assert.deepEqual(c.messages, {}, 'rule 3: not in the address book and not a Square member: nothing (the sender copy is not read)')
    const off = await createLayeredAvatarReader({ getDb: () => db, entityOn: () => false }).read({ chatIds: ['c-room-0'], chatId: 'c-room-0', msgIds: ['i:contact'] })
    assert.deepEqual(off.chats, {}, 'with the address book switched off a non-Square chat has no picture')
    assert.deepEqual(off.messages, {}, 'and neither has a contact')
  } finally { db.close() }
})

test('A-5 the reader never fails and never asks LINE: no db, no tables, a missing address book table, an entityOn that throws and empty requests all answer empty maps', async () => {
  const db = appDbWith()
  try {
    const bare = openDatabase({ dbPath: ':memory:' }).db
    try {
      for (const getDb of [() => bare, () => null]) {
        assert.deepEqual(await createLayeredAvatarReader({ getDb, entityOn: () => true }).read({ chatIds: ['c-q'] }), { chats: {}, messages: {} })
      }
    } finally { bare.close() }
    assert.deepEqual(await createLayeredAvatarReader({ getDb: () => db, entityOn: () => { throw new Error('flag') } }).read({ chatIds: ['c-room-0'] }), { chats: {}, messages: {} })
    db.exec('DROP TABLE line_entity')
    const stats = { local: 0, miss: 0 }
    const reader = createLayeredAvatarReader({ getDb: () => db, entityOn: () => true, onStat: (kind, n) => { stats[kind] += n } })
    assert.deepEqual(await reader.read({ chatIds: ['c-room-0', 'c-room-1'] }), { chats: {}, messages: {} }, 'the address book table is gone: still no throw')
    assert.deepEqual(stats, { local: 0, miss: 2 })
    assert.deepEqual(await reader.read({}), { chats: {}, messages: {} })
    assert.deepEqual(await reader.read({ chatId: 'c-room-0', msgIds: ['not-an-id'] }), { chats: {}, messages: {} })
  } finally { db.close() }
})

test('A-5 R-AV-4: avatarCache.load finds a cached image by stat-ing its key — it does not list the directory — and still falls back to listing when the key is not there', async () => {
  const root = mkdtempSync(join(tmpdir(), 'avatar-cache-'))
  try {
    const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])
    const dir = join(root, 'avatar-cache')
    mkdirSync(dir, { recursive: true })
    const seed = (identity, locator, ext) => {
      const name = `${avatarCacheKey(identity, locator)}.${ext}`
      writeFileSync(join(dir, name), jpeg)
      writeFileSync(join(dir, `${name}.sha256`), createHash('sha256').update(jpeg).digest('hex'))
      return name
    }
    seed('u-a', '/p/a', 'jpg')
    for (let i = 0; i < 50; i += 1) seed(`u-other-${i}`, `/p/other-${i}`, 'jpg') // a populated cache: listing would be 50+ stats
    const calls = { readdir: 0, stat: 0 }
    const real = await import('node:fs/promises')
    const fs = {
      mkdir: real.mkdir, readFile: real.readFile, rename: real.rename, unlink: real.unlink, utimes: real.utimes, writeFile: real.writeFile,
      readdir: async (p) => { calls.readdir += 1; return real.readdir(p) },
      stat: async (p) => { calls.stat += 1; return real.stat(p) }
    }
    let fetches = 0
    const cache = createAvatarCache({ dataDir: root, fs, fetchImpl: async () => { fetches += 1; throw new Error('offline') } })
    const hit = await cache.get({ identity: 'u-a', locator: '/p/a' })
    assert.equal(hit.cached, true)
    assert.equal(hit.path, `avatar-cache/${avatarCacheKey('u-a', '/p/a')}.jpg`)
    assert.equal(calls.readdir, 0, 'a hit never lists the directory')
    assert.ok(calls.stat <= 3, `at most one stat per extension (${calls.stat})`)
    seed('u-b', '/p/b', 'webp')
    const other = await cache.get({ identity: 'u-b', locator: '/p/b' }) // a webp that is not a real webp: found by the probe, rejected by the content check, the download then fails
    assert.equal(other, null)
    assert.equal(calls.readdir, 0, 'the key probe found the entry (it was then discarded as invalid)')
    assert.equal(await cache.get({ identity: 'u-missing', locator: '/p/missing' }), null)
    assert.ok(calls.readdir >= 1, 'when the probe finds nothing the directory is listed as the fallback (names this code did not write)')
    assert.equal(fetches, 2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

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

test('A-5 wiring: once the poll has stored the links and the address book has the contacts, media.avatar.prepareMessages is answered from the local DB — no LINE open, no copy, no download, the median CPU time of calls 2..20 is < 60 ms; an id the local DB lacks gets no picture and LINE is still not opened', { timeout: 90_000 }, async () => {
  const s = stage({ chats: chatsOf(1), contacts: people(6), messages: { count: 300, outEvery: 5 } })
  let backend
  try {
    for (let k = 0; k < 6; k += 1) seedAvatarCache(s.dataDir, `u-sender-${String(k).padStart(3, '0')}`, `/p/pic-${k}`)
    backend = await startBackend(s, { avatarStore: { backfill: { enabled: false } } })
    await until(async () => (await lineStatus(backend)).state === 'running', { message: 'the first import' })
    const db = appDb(s)
    try {
      const incoming = await until(() => { const n = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE direction='in'").get().n; return n === 240 ? n : 0 }, { message: '240 incoming messages' })
      await until(() => db.prepare('SELECT COUNT(*) AS n FROM line_message_sender').get().n === incoming, { message: 'every incoming message linked' })
      const ids = db.prepare("SELECT msg_id AS id FROM messages WHERE direction='in' AND chat_id='c-room-0' ORDER BY ts LIMIT 200").all().map((r) => r.id)
      assert.equal(ids.length, 200)
      const writer = new Database(join(s.dataDir, 'line-todo.db'))
      try {
        for (let k = 0; k < 6; k += 1) upsertEntity(writer, { kind: 'contact', mid: `u-sender-${String(k).padStart(3, '0')}`, source: 'profile', locator: `/p/pic-${k}`, displayName: `Sender ${k}` }, Date.now())
      } finally { writer.close() }

      const opensBefore = s.calls.opens
      const copiesBefore = s.copies()
      const before = (await info(backend)).avatarStore.reads
      const samples = []
      for (let i = 0; i < 20; i += 1) {
        const { value: answer, cpuMs, wallMs } = await withCpu(() => backend.call('media', { path: 'media.avatar.prepareMessages', args: ['c-room-0', ids] }))
        samples.push({ cpuMs, wallMs })
        assert.equal(answer.ok, true)
        assert.equal(Object.keys(answer.value.paths).length, 200, 'every message got its avatar path')
        assert.match(answer.value.paths[ids[0]], /^avatar-cache\/[0-9a-f]{64}\.jpg$/)
        assert.match(answer.value.names[ids[3]], /^Sender [0-9]$/)
      }
      assert.equal(s.calls.opens, opensBefore, 'the LINE database was not opened once')
      assert.equal(s.copies(), copiesBefore, 'nothing was copied')
      assert.equal(fetchCalls, 0, 'nothing was downloaded')
      assertCpuCriterion(samples, 'media.avatar.prepareMessages')
      const after = (await info(backend)).avatarStore.reads
      assert.deepEqual({ local: after.local - before.local, miss: after.miss - before.miss }, { local: 20 * 200, miss: 0 })
      assert.equal(after.fallback, undefined, 'there is no fallback counter any more')

      // an id the local DB lacks: no picture, and LINE is not opened for it (no snapshot read, no copy)
      const fresh = (await backend.call('media', { path: 'media.avatar.prepareMessages', args: ['c-room-0', [...ids.slice(0, 3), 'i:9999999']] })).value
      assert.equal(Object.keys(fresh.paths).length, 3)
      assert.equal(s.copies(), copiesBefore, 'still no copy')
      assert.equal(s.calls.opens, opensBefore, 'LINE was not opened for the missing id either')
      const miss = (await info(backend)).avatarStore.reads
      assert.equal(miss.local - after.local, 3)
      assert.equal(miss.miss - after.miss, 1)
      assert.equal((await info(backend)).keyHeld, true)
      assert.equal(fetchCalls, 0)
    } finally { db.close() }
  } finally {
    await backend?.dispose()
    s.cleanup()
  }
})

test('A-5 wiring: with nothing stored locally (and the snapshot disabled) an avatar request answers empty maps — ok:true, no error into the dispatcher', { timeout: 60_000 }, async () => {
  const s = stage(SPEC_SMALL)
  let backend
  try {
    backend = await startBackend(s, { snapshot: { enabled: false }, avatarStore: { backfill: { enabled: false } } })
    await until(async () => (await lineStatus(backend)).state === 'running', { message: 'the first import' })
    const answer = await backend.call('media', { path: 'media.avatar.prepareMessages', args: ['c-room-0', ['i:1000001', 'i:1000002']] })
    assert.equal(answer.ok, true)
    assert.deepEqual(answer.value, { paths: {}, names: {} })
    const chats = await backend.call('media', { path: 'media.avatar.prepareChats', args: [['c-room-0']] })
    assert.equal(chats.ok, true)
  } finally {
    await backend?.dispose()
    s.cleanup()
  }
})

// ───────────── A-6: the backfill ─────────────

/** A connection over a plain SQLite file with the LINE shapes; it records every row the backfill query returns (to prove the order). */
function openLineCon(path, log = null) {
  const db = new DatabaseSync(path, { readOnly: true })
  const wrap = (sql, rows) => { if (log && /ORDER BY rowid DESC/.test(sql)) log.push(rows.map((r) => Number(r._rowid))); return rows }
  return {
    pragma: () => [],
    prepare: (sql) => ({
      get: (...params) => db.prepare(sql).get(...params),
      all: (...params) => wrap(sql, db.prepare(sql).all(...params))
    }),
    close: () => db.close()
  }
}

/** Reads the synthetic LINE file back (rowid, chat, id, from) so the tests can compute what the backfill is expected to do. */
function lineRows(path) {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return db.prepare('SELECT rowid AS rid,_chatId AS chat,_id AS id,_from AS sender FROM _message ORDER BY rowid').all().map((r) => ({ ...r })) } finally { db.close() }
}

/**
 * Seeds the app DB the way an earlier import would have: every chat, a message row for each LINE row (incoming for other people, outgoing for ME), except every
 * `skipEvery`th row (not imported); plus two derived 'd:' ids that LINE does not know. Returns what the backfill is expected to link.
 */
function seedAppFromLine(db, path, { skipEvery = 0, forceOutEvery = 0, forceInEvery = 0, moveChatEvery = 0, chats }) {
  const rows = lineRows(path)
  const at = new Date('2026-11-02T00:00:00.000Z').toISOString()
  const addChat = db.prepare('INSERT OR IGNORE INTO chats(chat_id,name,is_group,blocked,first_seen_at,last_seen_at) VALUES (?,?,1,0,?,?)')
  for (const chat of chats) addChat.run(chat, chat, at, at)
  const add = db.prepare("INSERT OR IGNORE INTO messages(msg_id,chat_id,ts,time_iso,direction,sender,text,content_type,processed,ingested_at) VALUES (?,?,?,?,?,'x','t',0,0,?)")
  const expected = []
  db.exec('BEGIN')
  rows.forEach((row, i) => {
    if (skipEvery && i % skipEvery === 0) return
    const out = row.sender === ME
    // inconsistent rows the guard has to refuse: LINE says another person wrote it but the app DB has it as outgoing / under a different chat
    const forcedOut = !out && row.sender && forceOutEvery && i % forceOutEvery === 3
    const moved = !out && row.sender && moveChatEvery && i % moveChatEvery === 5 && chats.length > 1
    const appChat = moved ? chats[(chats.indexOf(row.chat) + 1) % chats.length] : row.chat
    // our own message filed as incoming (it was imported while the source _profile was empty)
    const misfiled = out && forceInEvery && i % forceInEvery === 2
    add.run(`i:${row.id}`, appChat, 1_700_000_000_000 + i, at, (out && !misfiled) || forcedOut ? 'out' : 'in', at)
    if (!out && !forcedOut && !moved && row.sender) expected.push([`i:${row.id}`, row.sender])
  })
  add.run('d:hash-1', chats[0], 1, at, 'in', at)
  add.run('d:hash-2', chats[0], 2, at, 'in', at)
  db.exec('COMMIT')
  return { expected, rows, scanned: rows.filter((r) => r.sender && r.sender !== ME).length }
}

const linksOf = (db) => db.prepare('SELECT ms.msg_id AS id, sp.sender_mid AS mid FROM line_message_sender ms JOIN line_sender_profile sp ON sp.sender_id=ms.sender_id ORDER BY ms.msg_id').all().map((r) => [r.id, r.mid])
const sortedPairs = (pairs) => [...pairs].sort((a, b) => (a[0] < b[0] ? -1 : 1))
const immediate = () => new Promise((resolveImmediate) => setImmediate(resolveImmediate))

/** One backfill over a LINE file and an app DB, with counters; sleeps are skipped (setImmediate) unless a test overrides them. */
function backfillOver(path, db, extra = {}) {
  const probe = { opens: 0, cleanups: 0, getDb: 0, rowsLog: [], slices: [], bursts: [], sleeps: [], yields: 0, yieldNow: false }
  const backfill = createAvatarBackfill({
    getDb: () => { probe.getDb += 1; return db },
    openSource: async () => {
      probe.opens += 1
      const con = openLineCon(path, probe.rowsLog)
      return { con, cleanup: () => { probe.cleanups += 1; con.close() }, shouldYield: () => probe.yieldNow }
    },
    sleep: async (ms) => { probe.sleeps.push(ms); await (ms >= 600_000 ? sleep(20) : immediate()) }, // the 10 minute "recheck" wait is not skipped (it would spin)
    yieldLoop: async () => { probe.yields += 1; await immediate() },
    onSlice: (info) => { const now = backfill.status(); probe.slices.push({ ...info, phase: now.phase, cursor: now.cursor }) },
    trace: (_phase, ms) => { probe.bursts.push(ms) },
    ...extra,
    budget: { startDelayMs: 0, ...extra.budget }
  })
  return { backfill, probe }
}

async function runToDone(backfill, { timeout = 60_000 } = {}) {
  backfill.start()
  await until(() => backfill.status().phase === 'done', { timeout, step: 5, message: 'the backfill to finish' })
}

test('A-6 backfill: messages only (no chats phase), newest to oldest by LINE rowid; only incoming messages that the app DB has are linked (no outgoing, no d: ids, no unknown rows, no row the app DB files under another chat); the account MID is never stored', async () => {
  const spec = { chats: chatsOf(3), contacts: people(8), messages: { count: 1500, outEvery: 6 } }
  const s = stage(spec)
  const db = appDbWith({ chats: [] })
  try {
    const seeded = seedAppFromLine(db, s.src, { skipEvery: 10, forceOutEvery: 13, moveChatEvery: 17, chats: spec.chats.map((c) => c.id) })
    const { backfill, probe } = backfillOver(s.src, db, { budget: { sliceMs: 1 } })
    await runToDone(backfill)
    await backfill.dispose()
    assert.deepEqual(sortedPairs(linksOf(db)), sortedPairs(seeded.expected), 'exactly the incoming messages the app DB knows are linked, with their original sender')
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM line_message_sender WHERE msg_id LIKE 'd:%'").get().n, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM line_sender_profile WHERE sender_mid=?').get(ME).n, 0)
    assert.equal(rowsOf(db, 'line_chat_avatar'), 0, 'the backfill does not store chats')
    const profile = db.prepare("SELECT source,locator,display_name FROM line_sender_profile WHERE sender_mid='u-sender-001'").get()
    assert.deepEqual({ ...profile }, { source: 'profile', locator: '/p/pic-1', display_name: 'Sender 1' })

    // there is no chats phase, and the messages phase walks rowid downwards without gaps
    const phases = probe.slices.map((x) => x.phase)
    assert.equal(phases.includes('chats'), false)
    assert.equal(phases[0], 'messages')
    const expectedRowIds = seeded.rows.filter((r) => r.sender && r.sender !== ME).map((r) => r.rid).sort((a, b) => b - a)
    assert.deepEqual([...new Set(probe.rowsLog.flat())], expectedRowIds, 'rowids come newest first and nothing is skipped (a row cut off by the slice budget is simply read again)')
    const cursors = probe.slices.filter((x) => x.phase === 'messages').map((x) => Number(x.cursor))
    assert.ok(cursors.length > 3 && cursors.every((c, i) => i === 0 || c < cursors[i - 1]), 'the cursor only moves towards older rows')
    assert.equal(cursors[0] <= expectedRowIds[0], true, 'the first slice starts at the newest row')

    const status = backfill.status()
    assert.equal(status.phase, 'done')
    assert.equal(status.scanned, seeded.scanned)
    assert.equal(status.linked, seeded.expected.length)
    assert.ok(status.doneAt && status.startedAt)
    assert.equal(probe.opens, probe.cleanups, 'every lease was released')
    assert.equal(JSON.stringify(status).includes('u-sender'), false, 'no MID in the status')
  } finally { db.close(); s.cleanup() }
})

test('A-6 backfill is interruptible and resumable: after a dispose in the middle a new instance continues from the stored cursor (older rows only), ends with exactly the same links as an uninterrupted run, and a re-run is idempotent', async () => {
  const spec = { chats: chatsOf(2), contacts: people(6), messages: { count: 2400, outEvery: 5 } }
  const s = stage(spec)
  const full = appDbWith({ chats: [] })
  const db = appDbWith({ chats: [] })
  try {
    const seededFull = seedAppFromLine(full, s.src, { skipEvery: 7, chats: spec.chats.map((c) => c.id) })
    seedAppFromLine(db, s.src, { skipEvery: 7, chats: spec.chats.map((c) => c.id) })
    const reference = backfillOver(s.src, full, { budget: { sliceMs: 1 } })
    await runToDone(reference.backfill)
    await reference.backfill.dispose()
    assert.ok(reference.probe.slices.length > 4, 'the run takes several slices')

    const first = backfillOver(s.src, db, { budget: { sliceMs: 1 }, yieldLoop: async () => { await sleep(4) } })
    first.backfill.start()
    await until(() => first.probe.slices.filter((x) => x.phase === 'messages').length >= 3 || first.backfill.status().phase === 'done', { message: 'a few message slices' })
    await first.backfill.dispose()
    const stopped = first.backfill.status()
    assert.notEqual(stopped.phase, 'done', 'it was interrupted')
    const cursor = Number(db.prepare("SELECT value FROM line_avatar_meta WHERE key='backfill_cursor'").get().value)
    assert.equal(String(cursor), stopped.cursor)
    const linkedSoFar = rowsOf(db, 'line_message_sender')
    assert.ok(linkedSoFar > 0 && linkedSoFar < seededFull.expected.length)
    assert.equal(first.probe.opens, first.probe.cleanups, 'the interrupted burst released its lease')
    const slicesAfterDispose = first.probe.slices.length
    await sleep(60)
    assert.equal(first.probe.slices.length, slicesAfterDispose, 'nothing runs after dispose')

    const second = backfillOver(s.src, db)
    await runToDone(second.backfill)
    await second.backfill.dispose()
    assert.ok(Math.max(...second.probe.rowsLog[0]) < cursor, 'the new instance starts below the stored cursor')
    assert.deepEqual(sortedPairs(linksOf(db)), sortedPairs(linksOf(full)), 'the interrupted run ends with the same links as the uninterrupted one')
    assert.equal(rowsOf(db, 'line_message_sender'), seededFull.expected.length, 'no duplicates')
    assert.equal(second.backfill.status().scanned, seededFull.scanned, 'the counters carry over the interruption')

    // idempotent: wipe the progress and run again — nothing changes
    const snapshot = JSON.stringify([db.prepare('SELECT * FROM line_sender_profile ORDER BY sender_id').all(), db.prepare('SELECT * FROM line_message_sender ORDER BY msg_id').all()])
    db.prepare("DELETE FROM line_avatar_meta WHERE key LIKE 'backfill_%'").run()
    const again = backfillOver(s.src, db)
    await runToDone(again.backfill)
    await again.backfill.dispose()
    assert.equal(JSON.stringify([db.prepare('SELECT * FROM line_sender_profile ORDER BY sender_id').all(), db.prepare('SELECT * FROM line_message_sender ORDER BY msg_id').all()]), snapshot)
  } finally { db.close(); full.close(); s.cleanup() }
})

test('A-6 backfill budget (fake clock): every slice is <= 15 ms, a burst is <= 300 ms plus a slice, the loop is yielded between slices, and the sleeps make the duty cycle about 25 %', async () => {
  const spec = { chats: chatsOf(2), contacts: people(8), messages: { count: 9000, outEvery: 4 } }
  const s = stage(spec)
  const db = appDbWith({ chats: [] })
  try {
    seedAppFromLine(db, s.src, { chats: spec.chats.map((c) => c.id) })
    let t = 0
    const probeSleeps = []
    const { backfill, probe } = backfillOver(s.src, db, {
      now: () => (t += 0.1), // every look at the clock costs 0.1 ms: deterministic "work"
      sleep: async (ms) => { probeSleeps.push(ms); t += ms; await (ms >= 600_000 ? sleep(20) : immediate()) }
    })
    await runToDone(backfill)
    await backfill.dispose()
    const messageSlices = probe.slices.filter((x) => x.phase === 'messages')
    assert.ok(messageSlices.length > 40, `many slices (${messageSlices.length})`)
    const longest = Math.max(...probe.slices.map((x) => x.ms))
    assert.ok(longest <= 15 + 1e-6, `the longest slice was ${longest.toFixed(2)} ms`)
    assert.ok(probe.bursts.length >= 5, `several bursts (${probe.bursts.length})`)
    assert.ok(Math.max(...probe.bursts) <= 300 + 15 + 1, `the longest burst was ${Math.max(...probe.bursts)} ms`)
    assert.ok(probe.yields > probe.slices.length / 2, 'the event loop was yielded between slices')
    const busy = probe.bursts.reduce((a, b) => a + b, 0)
    const idle = probeSleeps.filter((ms) => ms < 600_000).reduce((a, b) => a + b, 0)
    const duty = busy / (busy + idle)
    assert.ok(duty > 0.2 && duty < 0.3, `duty cycle ${(duty * 100).toFixed(1)} %`)
    assert.ok(probeSleeps.slice(1).every((ms) => ms >= 100), 'never less than 100 ms of sleep between bursts (the first sleep is the start delay)')
  } finally { db.close(); s.cleanup() }
})

test('A-6 backfill harness (real clock): 50,000 rows — slice times are recorded, no slice and no event-loop gap reaches 1 s, and the burst/sleep rhythm leaves the loop free', { timeout: 120_000 }, async () => {
  const spec = { chats: chatsOf(4), contacts: people(40), messages: { count: 50_000, outEvery: 5 } }
  const s = stage(spec)
  const db = appDbWith({ chats: [] })
  let last = performance.now()
  let lastCpu = process.cpuUsage()
  let maxGap = 0
  let maxWallGap = 0
  // CPU-busy gap: min(wall gap, CPU time burned in the gap). A loop that is really blocked burns CPU for the whole gap; a process that is just not scheduled on a starved machine does not.
  const timer = setInterval(() => {
    const now = performance.now()
    const cpu = process.cpuUsage()
    maxGap = Math.max(maxGap, Math.min(now - last, ((cpu.user - lastCpu.user) + (cpu.system - lastCpu.system)) / 1000))
    maxWallGap = Math.max(maxWallGap, now - last)
    last = now
    lastCpu = cpu
  }, 10)
  try {
    const seeded = seedAppFromLine(db, s.src, { chats: spec.chats.map((c) => c.id) })
    const { backfill, probe } = backfillOver(s.src, db, { sleep: async () => { await sleep(2) }, budget: { minSleepMs: 2, sleepFactor: 0 } })
    last = performance.now()
    lastCpu = process.cpuUsage()
    maxGap = 0
    maxWallGap = 0
    await runToDone(backfill, { timeout: 110_000 })
    await backfill.dispose()
    const ms = probe.slices.filter((x) => x.phase === 'messages').map((x) => x.ms).sort((a, b) => a - b)
    const p95 = ms[Math.floor(ms.length * 0.95)]
    assert.ok(ms.length > 20, `${ms.length} message slices`)
    assert.ok(probe.yields >= probe.slices.length / 2, `the loop is handed back between slices (${probe.yields} hand-backs for ${probe.slices.length} slices; deterministic, the wall-clock ceilings below only catch a catastrophe)`)
    // p95 and the 15 ms slice budget are deterministic in 'A-6 backfill budget (fake clock)'; the real-clock numbers depend on the machine's load, so they are not asserted, only the catastrophe ceiling is
    assert.ok(maxGap < 1_000, `the event loop was blocked for ${maxGap.toFixed(0)} ms (CPU-busy gap, catastrophe ceiling 1,000 ms; slice p95 ${p95.toFixed(1)} ms, max ${ms[ms.length - 1].toFixed(1)} ms and wall gap ${maxWallGap.toFixed(0)} ms are recorded only)`)
    assert.equal(backfill.status().linked, seeded.expected.length)
  } finally { clearInterval(timer); db.close(); s.cleanup() }
})

test('A-6 backfill only uses the existing snapshot (every acquire is any, no copy of its own) and a fresh update that arrives while it holds the lease waits at most one slice plus the copy — far less than the burst (shouldYield ends the burst)', { timeout: 120_000 }, async () => {
  const spec = { chats: chatsOf(2), contacts: people(20), messages: { count: 100_000, outEvery: 5 } }
  const s = stage(spec)
  const db = appDbWith({ chats: [] })
  try {
    s.legacyPorts()
    const store = new LineSnapshotStore({ fs: s.fs, dir: join(s.dataDir, 'line-engine', 'snapshot'), walOnly: true })
    const access = createLineAccess({ store })
    configureLineEnginePorts({ access })
    ;(await access.open({ dbPath: s.src, policy: 'fresh', keyOpts: s.keyOpts })).cleanup()
    const policies = []
    const acquire = store.acquire.bind(store)
    store.acquire = (src, policy) => { policies.push(policy); return acquire(src, policy) }
    const seeded = seedAppFromLine(db, s.src, { chats: spec.chats.map((c) => c.id) })
    const fullBefore = store.stats().fullCopies
    const copiesBefore = s.copies()
    let slicesRun = 0
    const backfill = createAvatarBackfill({
      getDb: () => db,
      openSource: () => access.open({ dbPath: null, policy: 'any', keyOpts: s.keyOpts }),
      onSlice: () => { slicesRun += 1 },
      budget: { startDelayMs: 0, burstMs: 3_000, sliceMs: 15, minSleepMs: 5, sleepFactor: 0 } // a 3 s burst: a lease wait that ignored shouldYield() would be 2.x s, far above the 1 s ceiling whatever the start-up jitter
    })
    backfill.start()
    await until(() => policies.includes('any'), { message: 'the first burst to open the snapshot' })
    await until(() => backfill.status().scanned > 0, { message: 'the first message slice' })
    assert.deepEqual([...new Set(policies)], ['any'])
    assert.equal(s.copies(), copiesBefore, 'the backfill copied nothing')
    // LINE "writes": the source signature changes, so the next fresh acquire has to replace the snapshot — it has to wait for the backfill lease
    const touched = new Date(Date.now() + 60_000)
    utimesSync(s.src, touched, touched)
    const t0 = performance.now()
    const slicesBefore = slicesRun
    const lease = await store.acquire(s.src, 'fresh')
    const waited = performance.now() - t0
    const slicesWhileWaiting = slicesRun - slicesBefore
    lease.release()
    // deterministic: shouldYield() ends the burst at the next slice boundary, so at most a slice or two run while the fresh update waits (a backfill that ignored it would go on slicing until the burst ends)
    assert.ok(slicesWhileWaiting <= 3, `${slicesWhileWaiting} backfill slices ran while the fresh update waited for the lease (shouldYield() must end the burst at the next slice boundary)`)
    assert.ok(waited < 1_000, `the fresh update waited ${waited.toFixed(0)} ms for the backfill lease (the burst may last 1,500 ms: shouldYield() ends it at the next slice boundary)`)
    assert.equal(store.stats().fullCopies, fullBefore + 1, 'the fresh acquire did the one copy')
    await until(() => backfill.status().phase === 'done', { timeout: 100_000, message: 'the backfill to finish on the replaced snapshot' })
    await backfill.dispose()
    assert.equal(store.stats().fullCopies, fullBefore + 1, 'the backfill never triggered a copy')
    assert.equal(policies.filter((p) => p === 'fresh').length, 1, 'the only fresh acquire is the test one')
    assert.equal(backfill.status().linked, seeded.expected.length)
  } finally { db.close(); s.cleanup() }
})

test('A-6 dispose is quiet: during the start delay nothing is touched; mid-run it finishes the slice, releases the lease and never reads the app DB again', async () => {
  const spec = { chats: chatsOf(1), contacts: people(4), messages: { count: 3000, outEvery: 5 } }
  const s = stage(spec)
  const db = appDbWith({ chats: [] })
  try {
    seedAppFromLine(db, s.src, { chats: spec.chats.map((c) => c.id) })
    const idle = backfillOver(s.src, db, { budget: { startDelayMs: 60_000 }, sleep: undefined })
    idle.backfill.start()
    await sleep(30)
    await idle.backfill.dispose()
    assert.deepEqual({ getDb: idle.probe.getDb, opens: idle.probe.opens }, { getDb: 0, opens: 0 }, 'the 30 s start delay was cut short without touching anything')

    const { backfill, probe } = backfillOver(s.src, db, { budget: { sliceMs: 1 } })
    backfill.start()
    await until(() => probe.slices.length >= 2, { message: 'two slices' })
    await backfill.dispose()
    const reads = probe.getDb
    const opens = probe.opens
    await sleep(80)
    assert.equal(probe.getDb, reads, 'getDb is not called again after dispose resolved')
    assert.equal(probe.opens, opens)
    assert.equal(probe.opens, probe.cleanups, 'the lease was released')
    await backfill.dispose()
    backfill.start()
    await sleep(20)
    assert.equal(probe.opens, opens, 'a disposed backfill does not start again')
  } finally { db.close(); s.cleanup() }
})

test('A-6 backfill waits when there is nothing to read (no snapshot or no key: openSource gives null) with a 30 s → 5 min backoff and touches nothing else; a read error backs off 30 s → 10 min, counts, and does not give up', async () => {
  const db = appDbWith({ chats: ['c-room-0'] })
  try {
    const sleeps = []
    let mode = 'null'
    let calls = 0
    const backfill = createAvatarBackfill({
      getDb: () => db,
      openSource: async () => { calls += 1; if (mode === 'throw') throw new Error('read failed'); return null },
      sleep: async (ms) => { sleeps.push(ms); await immediate() },
      budget: { startDelayMs: 0 }
    })
    backfill.start()
    await until(() => sleeps.length >= 9, { step: 2, message: 'a few retries' })
    mode = 'throw'
    await until(() => backfill.status().errors >= 6, { step: 2, message: 'a few errors' })
    await backfill.dispose()
    const nulls = sleeps.slice(1, 8)
    assert.deepEqual(nulls.slice(0, 5), [30_000, 60_000, 120_000, 240_000, 300_000], 'doubling up to the 5 minute cap')
    assert.ok(nulls.every((ms) => ms <= 300_000))
    assert.ok(sleeps.filter((ms) => ms > 300_000).every((ms) => ms <= 600_000), 'errors back off up to 10 minutes')
    assert.ok(Math.max(...sleeps) >= 480_000 || backfill.status().errors >= 6)
    assert.ok(calls >= 9)
    assert.equal(rowsOf(db, 'line_chat_avatar') + rowsOf(db, 'line_message_sender') + rowsOf(db, 'line_sender_profile'), 0, 'nothing was written')
  } finally { db.close() }
})

test('A-6 gap detection: a finished backfill starts over when the last import batch is more than a minute newer than link_watermark (or the algorithm version changed), and otherwise stays idle without opening the snapshot', async () => {
  const spec = { chats: chatsOf(1), contacts: people(4), messages: { count: 600, outEvery: 5 } }
  const s = stage(spec)
  const db = appDbWith({ chats: [] })
  try {
    ensureLineImportSchema(db)
    const seeded = seedAppFromLine(db, s.src, { chats: spec.chats.map((c) => c.id) })
    const first = backfillOver(s.src, db)
    await runToDone(first.backfill)
    await first.backfill.dispose()
    const batchAt = new Date('2026-11-02T12:00:00.000Z')
    const insertBatch = (id, at) => db.prepare(`INSERT INTO line_import_batches(batch_id,source,cursor_from_created_time,cursor_from_row_id,cursor_to_created_time,cursor_to_row_id,row_count,keyed_identity_count,unknown_identity_count,has_more,coverage_status,observed_at,committed_at)
      VALUES (?, 'line-watch', 0,0,0,0,0,0,0,0,'complete',?,?)`).run(id, at.toISOString(), at.toISOString())
    const setMark = (at) => db.prepare("INSERT INTO line_avatar_meta(key,value) VALUES ('link_watermark',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(at.toISOString())
    const rerun = async () => {
      const again = backfillOver(s.src, db, { budget: { recheckMs: 3_600_000 } })
      again.backfill.start()
      await sleep(150)
      const state = again.backfill.status()
      await again.backfill.dispose()
      return { opens: again.probe.opens, state }
    }

    insertBatch('b1', batchAt)
    setMark(new Date(batchAt.getTime() - 59_000))
    assert.equal((await rerun()).opens, 0, 'a gap of 59 s is not a gap: done stays done and nothing is opened')
    setMark(new Date(batchAt.getTime()))
    assert.equal((await rerun()).opens, 0, 'the watermark has caught up')

    setMark(new Date(batchAt.getTime() - 61_000))
    db.prepare('DELETE FROM line_message_sender').run()
    const reopened = await rerun()
    assert.ok(reopened.opens >= 1, 'a gap of 61 s reopens the backfill')
    assert.equal(reopened.state.phase, 'done')
    assert.equal(rowsOf(db, 'line_message_sender'), seeded.expected.length, 'and the rescan restored the links')
    assert.ok(Date.parse(db.prepare("SELECT value FROM line_avatar_meta WHERE key='link_watermark'").get().value) >= batchAt.getTime(), 'once the round is done the watermark (the round start, which is after that batch) has caught up')
    assert.equal((await rerun()).opens, 0, 'so the same gap does not reopen the backfill again and again')

    db.prepare("UPDATE line_avatar_meta SET value='0' WHERE key='backfill_version'").run()
    setMark(new Date(batchAt.getTime()))
    db.prepare('DELETE FROM line_message_sender').run()
    const upgraded = await rerun()
    assert.ok(upgraded.opens >= 1, 'a new algorithm version starts over')
    assert.equal(rowsOf(db, 'line_message_sender'), seeded.expected.length)
    assert.equal(db.prepare("SELECT value FROM line_avatar_meta WHERE key='backfill_version'").get().value, String(AVATAR_BACKFILL_VERSION))
  } finally { db.close(); s.cleanup() }
})

test('A-6 wiring: after a restart with the avatar store switched on, createPluginBackend backfills the messages an earlier import left unlinked — newest first through the existing snapshot (any only: no copy, no key scan) — and reports it in backend.info; the trace gets avatar_backfill events', { timeout: 90_000 }, async () => {
  const spec = { chats: chatsOf(2), contacts: people(6), messages: { count: 600, outEvery: 5 } }
  const s = stage(spec)
  let backend
  try {
    // run 1: the store is off, so the import (600 messages) leaves no avatar data
    backend = await startBackend(s, { avatarStore: { enabled: false } })
    await until(async () => (await lineStatus(backend)).state === 'running', { message: 'the first import' })
    const first = appDb(s)
    try {
      await until(() => first.prepare('SELECT COUNT(*) AS n FROM messages').get().n === 600, { message: 'all 600 messages imported' })
      assert.equal(first.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='line_sender_profile'").get().n, 0)
    } finally { first.close() }
    await backend.dispose()
    backend = undefined
    const copiesAfterRun1 = s.copies()

    // run 2: store on (default); the snapshot survives the restart, the LINE database has not changed (so the poll opens nothing and no key is held yet)
    backend = await startBackend(s, { avatarStore: { backfill: { startDelayMs: 30, sourceRetryMs: 40, sourceRetryMaxMs: 80, sleepFactor: 1, minSleepMs: 5 } } })
    await until(async () => (await lineStatus(backend)).state === 'running', { message: 'the poll after the restart' })
    await sleep(250)
    assert.equal((await info(backend)).avatarStore.backfill.phase, 'pending', 'no key, no snapshot read: it waits (and scans nothing)')
    assert.equal(s.copies(), copiesAfterRun1)
    // something opens the DB for the import path once (as the next LINE write would): the key is then held in memory and the backfill can read the snapshot
    ;(await getLineEnginePorts().access.open({ dbPath: s.src, policy: 'fresh', keyOpts: s.keyOpts })).cleanup()
    const status = await until(async () => { const b = (await info(backend)).avatarStore.backfill; return b.phase === 'done' ? b : null }, { message: 'the backfill to finish' })
    const db = appDb(s)
    try {
      const incoming = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE direction='in'").get().n
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM line_message_sender').get().n, incoming, 'every incoming message got its link')
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM line_chat_avatar').get().n, 0)
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM line_sender_profile WHERE sender_mid=?').get(ME).n, 0)
      assert.equal(status.linked, incoming)
      assert.equal(status.scanned, 480)
      assert.equal(status.errors, 0)
    } finally { db.close() }
    const state = await info(backend)
    assert.equal(state.lineSnapshot.fullCopies + state.lineSnapshot.walCopies, 0, 'run 2 copied nothing')
    assert.equal(state.lineSnapshot.reuse, 1, 'the one fresh open was a reuse; the backfill (any) is not counted and does not stat or copy')
    assert.equal(s.copies(), copiesAfterRun1)
    await until(() => readTrace(s.dataDir).some((e) => e.ev === 'bg' && e.p === 'avatar_backfill'), { message: 'an avatar_backfill bg event' })
    const everything = JSON.stringify(state) + readFileSync(join(s.dataDir, 'logs', 'invoke-trace.log'), 'utf8')
    assert.equal(/u-sender-\d{3}|u-account/.test(everything), false, 'no MID in backend.info or the trace')
    const answer = await backend.call('media', { path: 'media.avatar.prepareMessages', args: ['c-room-0', []] })
    assert.equal(answer.ok, true)
  } finally {
    await backend?.dispose()
    s.cleanup()
  }
})

test('A-6 wiring: backfill:{enabled:false}, snapshot:{enabled:false} and avatarStore:{enabled:false} all leave the backfill off (phase off) — it never runs without a snapshot', { timeout: 60_000 }, async () => {
  for (const extra of [{ avatarStore: { backfill: { enabled: false } } }, { snapshot: { enabled: false } }, { avatarStore: { enabled: false } }]) {
    const s = stage(SPEC_SMALL)
    let backend
    try {
      backend = await startBackend(s, extra)
      await until(async () => (await lineStatus(backend)).state === 'running', { message: 'the first import' })
      assert.equal((await info(backend)).avatarStore.backfill.phase, 'off', JSON.stringify(extra))
    } finally {
      await backend?.dispose()
      s.cleanup()
    }
  }
})

test('A-6 dispose: backend.dispose() stops the backfill first, closes the snapshot store (nothing leased or swapped afterwards) and forgets the key', { timeout: 60_000 }, async () => {
  const s = stage(SPEC_SMALL)
  let backend
  try {
    backend = await startBackend(s, { avatarStore: { backfill: { startDelayMs: 20, sourceRetryMs: 20, sleepFactor: 0, minSleepMs: 5 } } })
    await until(async () => (await lineStatus(backend)).state === 'running', { message: 'the first import' })
    const access = getLineEnginePorts().access
    assert.equal(access.keyHeld(), true)
    await until(async () => (await info(backend)).avatarStore.backfill.phase === 'done', { message: 'the backfill to finish' })
    await backend.dispose()
    assert.equal(access.keyHeld(), false, 'the in-memory key is forgotten')
    await assert.rejects(() => access.open({ dbPath: s.src, policy: 'fresh', keyOpts: s.keyOpts }), /snapshot_closed/, 'the closed store hands out nothing')
    assert.equal(await access.open({ dbPath: null, policy: 'any', keyOpts: s.keyOpts }), null)
    backend = undefined
  } finally {
    await backend?.dispose()
    s.cleanup()
  }
})

test('static: the sender MID table and column are named only in lineAvatar.repo.ts, and no MID, locator or display name is anywhere near a log, trace or backend.info line', () => {
  const root = resolve(import.meta.dirname, '..', '..', 'src')
  const files = readdirSync(root, { recursive: true }).map(String).filter((f) => /\.(ts|tsx)$/.test(f))
  assert.ok(files.length > 100, 'the whole src tree was scanned')
  const owner = 'lineAvatar.repo.ts'
  const holders = files.filter((f) => /line_sender_profile|sender_mid/.test(readFileSync(join(root, f), 'utf8'))).map((f) => f.split(/[\\/]/).pop())
  assert.deepEqual(holders, [owner])
  const entityHolders = files.filter((f) => /line_entity|entity_mid/.test(readFileSync(join(root, f), 'utf8'))).map((f) => f.split(/[\\/]/).pop())
  assert.deepEqual(entityHolders, ['lineEntity.repo.ts'], 'the address-book table and its MID column are named only in lineEntity.repo.ts')
  for (const f of ['plugin/backend/assemble.ts', 'plugin/backend/invokeTrace.ts']) {
    assert.equal(/senderMid|sender_mid|line_sender_profile/.test(readFileSync(join(root, f), 'utf8')), false, `${f} never names the sender MID`)
  }
  for (const f of ['plugin/backend/avatarBackfill.ts', 'plugin/backend/avatarReader.ts']) {
    const lines = readFileSync(join(root, f), 'utf8').split(/\r?\n/).filter((line) => /\blog\(|options\.log|options\.trace|trace\?\.|options\.onStat|stat\(/.test(line))
    assert.ok(lines.length > 0, `${f} has observation calls`)
    for (const line of lines) assert.equal(/mid|identity|locator|displayName|\.from\b|msgId/i.test(line), false, `${f}: ${line.trim()}`)
  }
})

// ───────────── fix 1: accountMid unknown or mis-filed, per-burst cache, round-start watermark, chats read failures ─────────────

const holders = (db, needle) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
  .filter(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all()).includes(needle)).map(({ name }) => name)
const avatarRows = (db) => ['line_chat_avatar', 'line_sender_profile', 'line_message_sender'].map((t) => rowsOf(db, t))

test('F1 collect: with the account MID unknown no sender is collected, whoever wrote the rows', () => {
  const con = { prepare: () => ({ get: () => undefined, all: () => [] }) }
  const rows = [{ chatId: 'c-ok', from: 'someone' }, { chatId: 'c-ok', from: ME }]
  for (const unknown of [null, '']) {
    const meta = collectAvatarMeta(con, rows, unknown)
    assert.deepEqual(meta.senders, [])
  }
})

test('F1 backfill: while the source cannot say who we are (_profile empty) the whole burst is skipped — nothing is written, it retries with backoff; once _profile shows up it runs to the end; the account MID is in no table at any point, even though the app DB filed some of our own messages as incoming', async () => {
  const spec = { chats: chatsOf(2), contacts: people(6), messages: { count: 400, outEvery: 4 }, noProfile: true }
  const s = stage(spec)
  const db = appDbWith({ chats: [] })
  try {
    const seeded = seedAppFromLine(db, s.src, { forceInEvery: 3, chats: spec.chats.map((c) => c.id) })
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE direction='in' AND sender='x'").get().n > seeded.expected.length, 'some of our own messages are filed as incoming')
    // The loop must stop by itself if the backoff were missing: past 30 attempts the source reports "nothing to read" after yielding a macrotask, so timers (and this test's polling) still run and the
    // assertions below fail on content (no backoff sleeps) instead of the test hanging with the event loop starved.
    const h = { calls: 0, capped: true }
    const { backfill, probe } = backfillOver(s.src, db, {
      openSource: async () => {
        h.calls += 1
        if (h.capped && h.calls > 30) { await immediate(); return null }
        h.probe.opens += 1
        const con = openLineCon(s.src, h.probe.rowsLog)
        return { con, cleanup: () => { h.probe.cleanups += 1; con.close() }, shouldYield: () => false }
      }
    })
    h.probe = probe
    backfill.start()
    await until(() => probe.opens >= 4, { message: 'a few skipped bursts' })
    assert.equal(probe.slices.length, 0, 'no slice ran')
    assert.deepEqual(avatarRows(db), [0, 0, 0])
    assert.deepEqual(holders(db, ME), [])
    assert.notEqual(backfill.status().phase, 'done')
    assert.deepEqual(probe.sleeps.slice(1, 4), [30_000, 60_000, 120_000], 'retried with the 30 s start / doubling backoff')
    assert.equal(probe.opens, probe.cleanups, 'the lease of a skipped burst is released')
    h.capped = false
    const writer = new DatabaseSync(s.src)
    writer.prepare('INSERT INTO _profile(_mid,_picturePath) VALUES (?,?)').run(ME, '/p/me')
    writer.close()
    await runToDone(backfill)
    await backfill.dispose()
    assert.deepEqual(sortedPairs(linksOf(db)), sortedPairs(seeded.expected), 'once the account is known the links are exactly the other people')
    assert.deepEqual(holders(db, ME), [], 'and our own mis-filed messages still created nothing')
  } finally { db.close(); s.cleanup() }
})

test('F1 backfill: a profile is only created for a message the app DB files as incoming under that chat — a person whose only message is outgoing in the app DB gets no profile at all', async () => {
  const rowsSpec = ['u-sender-000', 'u-sender-001', 'u-only-out', 'u-sender-000', 'u-sender-001', 'u-sender-000'].map((from) => ({ chat: 'c-room-0', from }))
  const spec = { chats: chatsOf(1), contacts: [...people(2), { mid: 'u-only-out', name: 'Only', picture: '/p/only' }], messages: rowsSpec }
  const s = stage(spec)
  const db = appDbWith({ chats: [] })
  try {
    seedAppFromLine(db, s.src, { chats: ['c-room-0'] })
    db.prepare("UPDATE messages SET direction='out' WHERE msg_id='i:1000003'").run()
    const { backfill } = backfillOver(s.src, db)
    await runToDone(backfill)
    await backfill.dispose()
    assert.deepEqual(db.prepare('SELECT sender_mid AS m FROM line_sender_profile ORDER BY sender_mid').all().map((r) => r.m), ['u-sender-000', 'u-sender-001'])
  } finally { db.close(); s.cleanup() }
})

test('F2 backfill: between two bursts an import rewrites a profile with a fresher picture and another sender is purged and re-created while LINE shows a new picture — the backfill never writes an older value over a fresher row, and it does not carry a source over from the previous burst', async () => {
  const spec = { chats: chatsOf(1), contacts: people(2), messages: { count: 600, outEvery: 5 } }
  const s = stage(spec)
  const db = appDbWith({ chats: [] })
  try {
    seedAppFromLine(db, s.src, { chats: ['c-room-0'] })
    let opens = 0
    const h = {}
    const { backfill, probe } = backfillOver(s.src, db, {
      budget: { burstMs: 5, sliceMs: 1 },
      yieldLoop: async () => { await sleep(3) },
      openSource: async () => {
        opens += 1
        h.probe.opens += 1
        // the first burst after a burst that already processed messages (so there is something cached from before)
        if (!h.hooked && backfill.status().scanned > 0) {
          h.hooked = true
          createSenderLinker(db).upsert('c-room-0', 'u-sender-000', { identity: 'u-sender-000', locator: '/p/NEW-000', displayName: 'Sender 0 new', source: 'profile' }, Date.now())
          db.prepare("DELETE FROM line_sender_profile WHERE sender_mid='u-sender-001'").run()
          const w = new DatabaseSync(s.src)
          w.prepare("UPDATE _contact SET _picturePath='/p/NEW-001' WHERE _mid='u-sender-001'").run()
          w.close()
        }
        const con = openLineCon(s.src)
        return { con, cleanup: () => { h.probe.cleanups += 1; con.close() }, shouldYield: () => false }
      }
    })
    h.probe = probe
    await runToDone(backfill)
    await backfill.dispose()
    assert.ok(opens >= 2, `the run took several bursts (${opens})`)
    const locator = (mid) => db.prepare('SELECT locator FROM line_sender_profile WHERE sender_mid=?').get(mid).locator
    assert.equal(locator('u-sender-000'), '/p/NEW-000', 'the fresher locator written by the import survived the backfill')
    assert.equal(locator('u-sender-001'), '/p/NEW-001', 'the re-created profile has what LINE says now, not what an earlier burst had cached')
    assert.deepEqual(holders(db, ME), [])
  } finally { db.close(); s.cleanup() }
})

test('watermark: a batch committed in the middle of a round that wrote no links is not swallowed — when the round ends the watermark is the round start, the gap is still there, and the next recheck runs another round that covers it', async () => {
  const spec = { chats: chatsOf(1), contacts: people(4), messages: { count: 400, outEvery: 4 } }
  const s = stage(spec)
  const db = appDbWith({ chats: [] })
  try {
    ensureLineImportSchema(db)
    const seeded = seedAppFromLine(db, s.src, { chats: ['c-room-0'] })
    const T0 = Date.parse('2031-03-03T03:03:03.000Z')
    const RECHECK = 3_600_000
    let wallNow = T0
    let injected = false
    let opens = 0
    const rechecks = []
    const mark = () => db.prepare("SELECT value FROM line_avatar_meta WHERE key='link_watermark'").get()?.value ?? null
    const backfill = createAvatarBackfill({
      getDb: () => db,
      openSource: async () => { opens += 1; const con = openLineCon(s.src); return { con, cleanup: () => con.close(), shouldYield: () => false } },
      sleep: async (ms) => { if (ms === RECHECK) await new Promise((resolve) => { rechecks.push(resolve) }); else await immediate() },
      yieldLoop: immediate,
      wallClock: () => wallNow,
      onSlice: () => {
        wallNow += 1000
        if (injected) return
        injected = true
        const at = new Date(T0 + 600_000).toISOString()
        db.prepare(`INSERT INTO line_import_batches(batch_id,source,cursor_from_created_time,cursor_from_row_id,cursor_to_created_time,cursor_to_row_id,row_count,keyed_identity_count,unknown_identity_count,has_more,coverage_status,observed_at,committed_at)
          VALUES ('mid-round','line-watch',0,0,0,0,0,0,0,0,'complete',?,?)`).run(at, at)
      },
      budget: { startDelayMs: 0, sliceMs: 1, recheckMs: RECHECK }
    })
    backfill.start()
    await until(() => rechecks.length === 1, { message: 'the first round to end and idle' })
    assert.equal(backfill.status().phase, 'done')
    assert.equal(mark(), new Date(T0).toISOString(), 'the watermark is the time the round started, not the latest batch')
    assert.equal(hasLinkGap(db, 60_000), true, 'the batch committed mid-round is still a gap')
    const firstRoundOpens = opens
    wallNow = T0 + 11 * 60_000
    rechecks.shift()()
    await until(() => rechecks.length === 1, { message: 'the second round to end' })
    assert.ok(opens > firstRoundOpens, 'the gap reopened the backfill')
    assert.ok(Date.parse(mark()) >= T0 + 11 * 60_000, 'the second round started after the batch, so the gap is closed')
    assert.equal(hasLinkGap(db, 60_000), false)
    assert.equal(rowsOf(db, 'line_message_sender'), seeded.expected.length)
    rechecks.shift()()
    await backfill.dispose()
  } finally { db.close(); s.cleanup() }
})

// ───────────── fix 2: the behaviours Reviewer r2 found unguarded (watermark never backwards, fillOnly fills only what is empty, one unreadable chat does not block the others) ─────────────

test('watermark: advancing never moves link_watermark backwards — a round that started before the current watermark leaves it where it is', async () => {
  const db = appDbWith({ chats: [] })
  try {
    const mark = () => db.prepare("SELECT value FROM line_avatar_meta WHERE key='link_watermark'").get()?.value ?? null
    advanceLinkWatermark(db, '2026-11-02T10:00:00.000Z')
    assert.equal(mark(), '2026-11-02T10:00:00.000Z', 'with nothing there yet it is set')
    advanceLinkWatermark(db, '2026-11-02T12:00:00.000Z')
    assert.equal(mark(), '2026-11-02T12:00:00.000Z', 'a later round start moves it forward')
    advanceLinkWatermark(db, '2026-11-02T10:30:00.000Z')
    assert.equal(mark(), '2026-11-02T12:00:00.000Z', 'an earlier round start does not pull it back')
    advanceLinkWatermark(db, 'not a date')
    assert.equal(mark(), '2026-11-02T12:00:00.000Z', 'junk changes nothing')
  } finally { db.close() }
})

test('watermark: a whole round whose start is earlier than the watermark an import already wrote (the import linked its batch during the round) leaves that watermark alone, so that batch is not turned into a gap', async () => {
  const spec = { chats: chatsOf(1), contacts: people(3), messages: { count: 200, outEvery: 4 } }
  const s = stage(spec)
  const db = appDbWith({ chats: [] })
  try {
    ensureLineImportSchema(db)
    seedAppFromLine(db, s.src, { chats: ['c-room-0'] })
    const T0 = Date.parse('2031-03-03T03:03:03.000Z')
    const later = new Date(T0 + 30 * 60_000).toISOString()
    db.prepare("INSERT INTO line_avatar_meta(key,value) VALUES ('link_watermark',?)").run(later)
    db.prepare(`INSERT INTO line_import_batches(batch_id,source,cursor_from_created_time,cursor_from_row_id,cursor_to_created_time,cursor_to_row_id,row_count,keyed_identity_count,unknown_identity_count,has_more,coverage_status,observed_at,committed_at)
      VALUES ('linked-by-import','line-watch',0,0,0,0,0,0,0,0,'complete',?,?)`).run(later, later)
    const { backfill } = backfillOver(s.src, db, { wallClock: () => T0 })
    await runToDone(backfill)
    await backfill.dispose()
    assert.equal(db.prepare("SELECT value FROM line_avatar_meta WHERE key='link_watermark'").get().value, later, 'the finished round (started at T0) did not pull the watermark back')
    assert.equal(hasLinkGap(db, 60_000), false)
  } finally { db.close(); s.cleanup() }
})

test('fillOnly (what the backfill uses): an empty locator is filled (with its source) and an empty display_name is filled — each on its own — and a value that is already there is never overwritten', () => {
  const db = appDbWith({ chats: ['c1'] })
  try {
    const row = (mid) => ({ ...db.prepare('SELECT source,locator,display_name FROM line_sender_profile WHERE sender_mid=?').get(mid) })
    const fill = (mid, source) => createSenderLinker(db, { fillOnly: true }).upsert('c1', mid, source, Date.now())

    // 1. the profile has a name but no locator: only the locator (and its source) is filled, the name stays
    fill('u-name-only', src('u-name-only', null, 'Kept name'))
    assert.deepEqual(row('u-name-only'), { source: null, locator: null, display_name: 'Kept name' })
    fill('u-name-only', src('u-name-only', '/p/filled', 'Another name', 'square'))
    assert.deepEqual(row('u-name-only'), { source: 'square', locator: '/p/filled', display_name: 'Kept name' }, 'locator and source filled, the existing name not overwritten')

    // 2. the profile has a locator but no name: only the name is filled, the locator stays
    fill('u-locator-only', src('u-locator-only', '/p/keep', null))
    assert.deepEqual(row('u-locator-only'), { source: 'profile', locator: '/p/keep', display_name: null })
    fill('u-locator-only', src('u-locator-only', '/p/other', 'Filled name', 'square'))
    assert.deepEqual(row('u-locator-only'), { source: 'profile', locator: '/p/keep', display_name: 'Filled name' }, 'name filled, the existing locator and source not overwritten')

    // 3. a completely empty profile gets both
    fill('u-empty', src('u-empty', null, null))
    fill('u-empty', src('u-empty', '/p/both', 'Both'))
    assert.deepEqual(row('u-empty'), { source: 'profile', locator: '/p/both', display_name: 'Both' })

    // 4. a complete profile is not touched at all
    fill('u-full', src('u-full', '/p/a', 'A'))
    fill('u-full', src('u-full', '/p/b', 'B', 'square'))
    assert.deepEqual(row('u-full'), { source: 'profile', locator: '/p/a', display_name: 'A' })
  } finally { db.close() }
})

// ───────────── the `_targetProfileDetail.picturePath` source and re-reading name-only rows (fix/line-todo-avatar-tpd) ─────────────

const PIC79 = `/${'a1B2c3D4e5'.repeat(7)}xyz_-Q7Z` // 1 + 70 + 7 + 1 = 79
const PIC166 = `/${'f0e1d2c3b4'.repeat(8)}/${'a9b8c7d6e5'.repeat(8)}abc_` // 1 + 80 + 1 + 80 + 4 = 166
const detailOf = (picturePath) => JSON.stringify({ profileName: 'x', pictureStatus: 'ok', picturePath })

test('profile source: a NULL _contact._picturePath falls back to _targetProfileDetail.picturePath (source profile); _picturePath still wins; bad JSON, a missing field or a non-string never throws and gives null', () => {
  assert.equal(PIC79.length, 79)
  assert.equal(PIC166.length, 166)
  const spec = {
    chats: [{ id: 'c-room-0' }, { id: 'u-peer-a' }, { id: 'u-peer-b' }],
    contacts: [
      { mid: 'u-null-detail166', picture: null, detail: detailOf(PIC166) },
      { mid: 'u-null-detail79', picture: null, detail: detailOf(PIC79) },
      { mid: 'u-both', picture: '/p/own-picture', detail: detailOf('/p/detail-picture') },
      { mid: 'u-bad-json', picture: null, detail: '{not json' },
      { mid: 'u-no-field', picture: null, detail: JSON.stringify({ profileName: 'only a name' }) },
      { mid: 'u-empty-field', picture: null, detail: detailOf('   ') },
      { mid: 'u-number-field', picture: null, detail: JSON.stringify({ picturePath: 12345 }) },
      { mid: 'u-json-null', picture: null, detail: 'null' },
      { mid: 'u-no-detail', picture: null, detail: null },
      { mid: 'u-peer-a', name: 'Peer A', picture: null, detail: detailOf(PIC79) },
      { mid: 'u-peer-b', name: 'Peer B', picture: '/p/peer-b', detail: detailOf('/p/ignored') }
    ],
    messages: []
  }
  const s = stage(spec)
  try {
    const con = openLineCon(s.src)
    try {
      const of = (mid) => linedb.senderAvatarSource(con, 'c-room-0', mid)
      assert.deepEqual({ ...of('u-null-detail166') }, { identity: 'u-null-detail166', locator: PIC166, displayName: 'name u-null-detail166', source: 'profile' })
      assert.deepEqual([of('u-null-detail79').locator, of('u-null-detail79').source], [PIC79, 'profile'])
      assert.deepEqual([of('u-both').locator, of('u-both').source], ['/p/own-picture', 'profile'], '_picturePath has priority')
      for (const mid of ['u-bad-json', 'u-no-field', 'u-empty-field', 'u-number-field', 'u-json-null', 'u-no-detail', 'u-unknown']) {
        const got = of(mid)
        assert.deepEqual([got.locator, got.source], [null, null], mid)
      }
      // a 1:1 chat takes the same path (chatAvatarSource -> profileSource)
      const peerA = linedb.chatAvatarSource(con, 'u-peer-a')
      assert.deepEqual([peerA.locator, peerA.source], [PIC79, 'profile'])
      assert.equal(linedb.chatAvatarSource(con, 'u-peer-b').locator, '/p/peer-b')
    } finally { con.close() }
  } finally { s.cleanup() }
})

test('profile source: locators of the _picturePath shape (leading slash, 79 and 166 characters) taken from _targetProfileDetail pass the unchanged safeImageUrl — the avatar cache requests the profile CDN URL for them, exactly as for the same string read from _picturePath', async () => {
  const root = mkdtempSync(join(tmpdir(), 'avatar-safe-url-'))
  try {
    const fetchBefore = fetchCalls
    const asked = []
    const cache = createAvatarCache({ dataDir: root, fetchImpl: async (url) => { asked.push(url); throw new Error('offline') } })
    const spec = {
      chats: [{ id: 'c-room-0' }],
      contacts: [
        { mid: 'u-d79', picture: null, detail: detailOf(PIC79) }, { mid: 'u-d166', picture: null, detail: detailOf(PIC166) },
        { mid: 'u-p79', picture: PIC79, detail: null }, { mid: 'u-p166', picture: PIC166, detail: null }
      ],
      messages: []
    }
    const s = stage(spec)
    try {
      const con = openLineCon(s.src)
      try {
        for (const mid of ['u-d79', 'u-d166', 'u-p79', 'u-p166']) {
          const source = linedb.senderAvatarSource(con, 'c-room-0', mid)
          await cache.get({ identity: mid, locator: source.locator })
        }
      } finally { con.close() }
    } finally { s.cleanup() }
    const url = (path) => `https://profile.line-scdn.net${path}`
    assert.deepEqual(asked, [url(PIC79), url(PIC166), url(PIC79), url(PIC166)], 'safeImageUrl accepted all four (a rejected locator would never reach fetch)')
    assert.equal(fetchCalls, fetchBefore, 'and the global fetch was never used')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('upgrade: a backfill saved in the retired chats phase continues with the messages — no chat is stored, the links are made, and the round ends', async () => {
  const spec = { chats: chatsOf(2), contacts: people(4), messages: { count: 200, outEvery: 5 } }
  const s = stage(spec)
  const db = appDbWith({ chats: [] })
  try {
    const seeded = seedAppFromLine(db, s.src, { chats: spec.chats.map((c) => c.id) })
    for (const [k, v] of [['backfill_version', String(AVATAR_BACKFILL_VERSION)], ['backfill_phase', 'chats'], ['backfill_started_at', new Date().toISOString()]]) db.prepare('INSERT INTO line_avatar_meta(key,value) VALUES (?,?)').run(k, v)
    const { backfill, probe } = backfillOver(s.src, db)
    await runToDone(backfill)
    await backfill.dispose()
    assert.equal(probe.slices.some((x) => x.phase === 'chats'), false)
    assert.equal(rowsOf(db, 'line_chat_avatar'), 0)
    assert.equal(rowsOf(db, 'line_message_sender'), seeded.expected.length)
  } finally { db.close(); s.cleanup() }
})
