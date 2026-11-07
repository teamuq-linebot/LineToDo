import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { newMessagesAfter } from '../src/main/line/engine/linedb.ts'
import { rowToObj } from '../src/main/line/engine/rowToObj.ts'
import { commitLineImportBatch, ensureLineImportSchema } from '../src/main/db/lineImport.repo.ts'
import { ensureLineAvatarSchema, hasLinkGap, isLineAvatarSchemaReady } from '../src/main/db/lineAvatar.repo.ts'
import { openDatabase } from '../src/main/db/database.ts'
import { commitAndAcknowledgeLineImportBatch, loadState, saveStateStrict } from '../src/main/line/engine/watchEngine.ts'
import { SCHEMA_DDL, SCHEMA_VERSION } from '../src/main/db/schema.ts'
import { createParticipantIdentityProvider } from '../src/main/line/identity.ts'
import { reconcileMonth } from '../src/main/pipeline/reconcileRunner.ts'
import { fetchAndCommitImportWindow } from '../src/main/pipeline/importWindow.ts'

function createDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  db.exec(SCHEMA_DDL)
  ensureLineImportSchema(db)
  return db
}

function identityProvider(userDataDir) {
  return createParticipantIdentityProvider({ userDataDir, safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from([...Buffer.from(value)].reverse()),
    decryptString: (value) => Buffer.from([...value].reverse()).toString('utf8')
  } })
}

function item({ msgId, senderMid, sender = '同名', chatId = 'c-room', ts = 10 }) {
  return {
    sourceRowId: Number(msgId?.replace(/\D/g, '') || 1), senderMid, accountMid: 'u-account',
    message: { msgId, chat: chatId, chatId, isGroup: true, ts, time: new Date(ts).toISOString(), direction: 'in', sender, text: `synthetic ${msgId}`, contentType: 0 }
  }
}

function batch(items, batchId = 'batch-1', cursorTo = { createdTime: 10, rowId: 4 }, hasMore = false) {
  return { batchId, source: 'line-backfill', cursorFrom: { createdTime: 0, rowId: 0 }, cursorTo, hasMore, observedAt: new Date(0).toISOString(), items }
}

test('reconcile import pages preserve timestamp ties, replay is idempotent, and only newly inserted old IDs are processed', async () => {
  const db = createDb()
  const temp = mkdtempSync(join(tmpdir(), 'line-reconcile-import-test-'))
  const identity = identityProvider(temp)
  const pages = [
    batch([item({ msgId: 'old-1', senderMid: 'mid-1', ts: 5 })], 'reconcile-page-1', { createdTime: 5, rowId: 1 }, true),
    { ...batch([item({ msgId: 'recent-2', senderMid: 'mid-2', ts: 10 })], 'reconcile-page-2', { createdTime: 10, rowId: 2 }, true), cursorFrom: { createdTime: 5, rowId: 1 } },
    { ...batch([item({ msgId: 'recent-3', senderMid: 'mid-3', ts: 10 })], 'reconcile-page-3', { createdTime: 10, rowId: 3 }, false), cursorFrom: { createdTime: 10, rowId: 2 } }
  ]
  const run = async () => {
    let pageIndex = 0
    return reconcileMonth({ ym: '1970-01', monthStartMs: 1, monthEndMs: 1000, deficit: 2 }, {
      getImportBatch: async (cursor) => {
        const page = pages[pageIndex++]
        assert.deepEqual(page.cursorFrom, cursor)
        return page
      },
      commitImportBatch: (value, options) => commitLineImportBatch(db, value, identity, options)
    }, { limit: 1, maxSubWindows: 4, llmSkipCutoffMs: 10 })
  }
  assert.equal(await run(), 3)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM line_import_batches').get().n, 3)
  assert.equal(db.prepare("SELECT processed FROM messages WHERE msg_id='i:old-1'").get().processed, 1)
  assert.equal(db.prepare("SELECT processed FROM messages WHERE msg_id='i:recent-2'").get().processed, 0)
  assert.equal(db.prepare("SELECT processed FROM messages WHERE msg_id='i:recent-3'").get().processed, 0)
  // Existing rows do not reappear in insertedMsgIds on replay, so old-message marking stays insertion-scoped.
  assert.equal(await run(), 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM line_import_batches').get().n, 3)
  db.close()
  rmSync(temp, { recursive: true, force: true })
})

test('reconcile import failure rolls back message, participant and receipt together', async () => {
  const db = createDb()
  const temp = mkdtempSync(join(tmpdir(), 'line-reconcile-failure-test-'))
  const identity = identityProvider(temp)
  db.exec("CREATE TRIGGER fail_reconcile_participant BEFORE INSERT ON message_participants WHEN NEW.msg_id='i:reconcile-fail' BEGIN SELECT RAISE(ABORT,'synthetic participant failure'); END")
  const value = batch([item({ msgId: 'reconcile-fail', senderMid: 'mid-fail', ts: 10 })], 'reconcile-failure', { createdTime: 10, rowId: 9 }, false)
  await assert.rejects(() => reconcileMonth({ ym: '1970-01', monthStartMs: 1, monthEndMs: 1000, deficit: 1 }, {
    getImportBatch: async () => value,
    commitImportBatch: (input, options) => commitLineImportBatch(db, input, identity, options)
  }, { limit: 10, maxSubWindows: 2, llmSkipCutoffMs: 50 }))
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message_participants').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM line_import_batches').get().n, 0)
  db.close()
  rmSync(temp, { recursive: true, force: true })
})

test('backfill page consumer drains limit pages, commits before return, and replays idempotently', async () => {
  const db = createDb()
  const temp = mkdtempSync(join(tmpdir(), 'line-backfill-import-test-'))
  const identity = identityProvider(temp)
  const first = { ...batch([item({ msgId: 'bf-1', senderMid: 'mid-1', ts: 101 })], 'bf-page-1', { createdTime: 101, rowId: 1 }, true), cursorFrom: { createdTime: 100, rowId: Number.MAX_SAFE_INTEGER } }
  const second = { ...batch([item({ msgId: 'bf-2', senderMid: 'mid-2', ts: 101 })], 'bf-page-2', { createdTime: 101, rowId: 2 }, false), cursorFrom: { createdTime: 101, rowId: 1 } }
  const run = async () => {
    let index = 0
    return fetchAndCommitImportWindow(100, async (cursor, opts) => {
      assert.equal(opts.limit, 1)
      const next = [first, second][index++]
      assert.deepEqual(next.cursorFrom, cursor)
      return next
    }, (value) => commitLineImportBatch(db, value, identity), 1)
  }
  const firstRun = await run()
  assert.equal(firstRun.messages.length, 2)
  assert.equal(firstRun.commits.reduce((sum, commit) => sum + commit.inserted, 0), 2)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message_participants').get().n, 2)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM line_import_batches').get().n, 2)
  assert.equal(db.prepare("SELECT SUM(processed) AS n FROM messages").get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM todos').get().n, 0)
  const replay = await run()
  assert.equal(replay.messages.length, 2)
  assert.equal(replay.commits.reduce((sum, commit) => sum + commit.inserted, 0), 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 2)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM line_import_batches').get().n, 2)
  db.close()
  rmSync(temp, { recursive: true, force: true })
})


test('timestamp ties paginate by source rowid across a limit boundary', () => {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE _message(_chatId TEXT,_createdTime INTEGER,_from TEXT,_text TEXT,_contentType INTEGER,_id TEXT,_contentMetadata TEXT,_contentInfo TEXT,_attribute INTEGER)')
  const insert = db.prepare('INSERT INTO _message(_chatId,_createdTime,_from,_text,_contentType,_id) VALUES (?,?,?,?,?,?)')
  for (let i = 1; i <= 5; i++) insert.run('c-room', 100, `mid-${i}`, `body-${i}`, 0, `id-${i}`)
  insert.run('c-room', 101, 'mid-6', 'body-6', 0, 'id-6')

  const found = []
  let cursor = { createdTime: 0, rowId: 0 }
  for (;;) {
    const page = newMessagesAfter(db, cursor, null, 3)
    const hasMore = page.length > 2
    if (hasMore) page.pop()
    found.push(...page.map((row) => row.msgId))
    if (!hasMore) break
    const last = page.at(-1)
    cursor = { createdTime: last.createdTime, rowId: last.rowId }
  }
  assert.deepEqual(found, ['id-1', 'id-2', 'id-3', 'id-4', 'id-5', 'id-6'])
  db.close()
})

test('same display name keeps distinct identities, rename stays stable, missing MID stays unknown, replay is idempotent', () => {
  const db = createDb()
  const temp = mkdtempSync(join(tmpdir(), 'line-identity-test-'))
  const identity = identityProvider(temp)
  const items = [item({ msgId: 'm-1', senderMid: 'mid-A', sender: '同名' }), item({ msgId: 'm-2', senderMid: 'mid-B', sender: '同名' }), item({ msgId: 'm-3', senderMid: 'mid-A', sender: '改名' }), item({ msgId: 'm-4', senderMid: null })]
  const input = batch(items, 'batch-identity', { createdTime: 10, rowId: 4 }, true)
  const first = commitLineImportBatch(db, input, identity)
  const second = commitLineImportBatch(db, input, identity)
  assert.equal(first.inserted, 4)
  assert.equal(first.receiptInserted, true)
  assert.equal(second.inserted, 0)
  assert.equal(second.receiptInserted, false)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM line_import_batches').get().n, 1)
  assert.equal(db.prepare('SELECT coverage_status FROM line_import_batches').get().coverage_status, 'partial')
  assert.equal(db.prepare('SELECT processed FROM messages WHERE msg_id=\'i:m-1\'').get().processed, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM todos').get().n, 0)
  const a = db.prepare("SELECT participant_key FROM message_participants WHERE msg_id='i:m-1'").get().participant_key
  const b = db.prepare("SELECT participant_key FROM message_participants WHERE msg_id='i:m-2'").get().participant_key
  const renamed = db.prepare("SELECT participant_key FROM message_participants WHERE msg_id='i:m-3'").get().participant_key
  const missing = db.prepare("SELECT participant_key,identity_status,identity_reason FROM message_participants WHERE msg_id='i:m-4'").get()
  assert.notEqual(a, b)
  assert.equal(a, renamed)
  assert.deepEqual({ ...missing }, { participant_key: null, identity_status: 'unknown', identity_reason: 'source_id_missing' })
  const stored = JSON.stringify(db.prepare('SELECT * FROM message_participants').all())
  assert.equal(stored.includes('mid-A'), false)
  assert.equal(stored.includes('mid-B'), false)
  db.close()
  rmSync(temp, { recursive: true, force: true })
})

test('failed durable transaction leaves both rows and source cursor untouched', async () => {
  const db = createDb()
  db.exec(`CREATE TRIGGER fail_participant BEFORE INSERT ON message_participants WHEN NEW.msg_id='i:m-fail' BEGIN SELECT RAISE(ABORT,'synthetic commit failure'); END`)
  const input = batch([item({ msgId: 'm-fail', senderMid: 'mid-fail' })], 'batch-fail', { createdTime: 10, rowId: 9 })
  const temp = mkdtempSync(join(tmpdir(), 'line-import-test-'))
  const stateFile = join(temp, 'watch.json')
  const identity = identityProvider(join(temp, 'identity'))
  saveStateStrict(stateFile, { last_ts: 0, cursor: { createdTime: 0, rowId: 0 }, sig: null })
  await assert.rejects(() => commitAndAcknowledgeLineImportBatch(input, (value) => commitLineImportBatch(db, value, identity), { stateFile, dbPath: ':memory:' }))
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE msg_id='i:m-fail'").get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM line_import_batches').get().n, 0)
  assert.deepEqual(loadState(stateFile).cursor, { createdTime: 0, rowId: 0 })
  db.close()
  rmSync(temp, { recursive: true, force: true })
})

test('empty terminal import page records a receipt before live cursor acknowledgement', async () => {
  const db = createDb()
  const temp = mkdtempSync(join(tmpdir(), 'line-empty-import-test-'))
  const stateFile = join(temp, 'watch.json')
  const identity = identityProvider(join(temp, 'identity'))
  const input = batch([], 'empty-terminal', { createdTime: 0, rowId: 0 }, false)
  saveStateStrict(stateFile, { last_ts: 0, cursor: { createdTime: 0, rowId: 0 }, sig: null })
  await commitAndAcknowledgeLineImportBatch(input, (value) => commitLineImportBatch(db, value, identity), { stateFile, dbPath: ':memory:' })
  assert.equal(db.prepare('SELECT row_count FROM line_import_batches').get().row_count, 0)
  assert.deepEqual(loadState(stateFile).cursor, { createdTime: 0, rowId: 0 })
  db.close()
  rmSync(temp, { recursive: true, force: true })
})

test('missing contact display label never falls back to raw LINE MID', () => {
  const message = rowToObj({ chatId: 'c-room', createdTime: 1, from: 'raw-mid-secret', text: 'hello', contentType: 0, id: 'm1', contentMetadata: null, contentInfo: null, attribute: 0 }, {
    myMid: 'u-account', iso: () => '2026-01-01T00:00:00', chatName: 'Room', senderName: null
  })
  assert.equal(message.sender, '未知發話者')
  assert.equal(JSON.stringify(message).includes('raw-mid-secret'), false)
})

test('account/chat scope separates keys and safeStorage failure returns explicit unknown', () => {
  const temp = mkdtempSync(join(tmpdir(), 'line-identity-scope-test-'))
  const identity = identityProvider(temp)
  const a = identity.resolve({ senderMid: 'same-mid', accountMid: 'account-A', chatId: 'c-one' })
  const otherAccount = identity.resolve({ senderMid: 'same-mid', accountMid: 'account-B', chatId: 'c-one' })
  const otherChat = identity.resolve({ senderMid: 'same-mid', accountMid: 'account-A', chatId: 'c-two' })
  assert.ok(a.participantKey)
  assert.notEqual(a.participantKey, otherAccount.participantKey)
  assert.notEqual(a.participantKey, otherChat.participantKey)
  const reopened = identityProvider(temp).resolve({ senderMid: 'same-mid', accountMid: 'account-A', chatId: 'c-one' })
  assert.equal(reopened.participantKey, a.participantKey)
  const unavailable = createParticipantIdentityProvider({ userDataDir: join(temp, 'unavailable'), safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => { throw new Error('must not encrypt') },
    decryptString: () => { throw new Error('must not decrypt') }
  } })
  assert.deepEqual(unavailable.resolve({ senderMid: 'sender', accountMid: 'account', chatId: 'c-one' }), {
    participantKey: null, scope: 'unknown', keyVersion: null, status: 'unknown', reason: 'safe_storage_unavailable'
  })
  rmSync(temp, { recursive: true, force: true })
})

test('safeStorage outage clears persisted participant keys to unknown', () => {
  const db = createDb()
  const temp = mkdtempSync(join(tmpdir(), 'line-identity-outage-test-'))
  const keyed = identityProvider(join(temp, 'available'))
  commitLineImportBatch(db, batch([item({ msgId: 'm-before-outage', senderMid: 'mid-before' })], 'outage-first', { createdTime: 10, rowId: 1 }), keyed)
  const unavailable = createParticipantIdentityProvider({ userDataDir: join(temp, 'unavailable'), safeStorage: {
    isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => ''
  } })
  commitLineImportBatch(db, batch([item({ msgId: 'm-during-outage', senderMid: 'mid-during', ts: 11 })], 'outage-second', { createdTime: 11, rowId: 2 }), unavailable)
  const old = db.prepare("SELECT participant_key,identity_status,identity_reason FROM message_participants WHERE msg_id='i:m-before-outage'").get()
  assert.deepEqual({ ...old }, { participant_key: null, identity_status: 'unknown', identity_reason: 'safe_storage_unavailable' })
  db.close()
  rmSync(temp, { recursive: true, force: true })
})

test('install-key epoch change clears old participant keys instead of merging identities', () => {
  const db = createDb()
  const temp = mkdtempSync(join(tmpdir(), 'line-identity-reset-test-'))
  const firstIdentity = identityProvider(join(temp, 'first'))
  const first = batch([item({ msgId: 'm-old', senderMid: 'mid-old' })], 'epoch-first', { createdTime: 10, rowId: 1 })
  commitLineImportBatch(db, first, firstIdentity)
  const secondIdentity = identityProvider(join(temp, 'second'))
  const second = batch([item({ msgId: 'm-new', senderMid: 'mid-new', ts: 11 })], 'epoch-second', { createdTime: 11, rowId: 2 })
  commitLineImportBatch(db, second, secondIdentity)
  const old = db.prepare("SELECT participant_key,identity_status,identity_reason FROM message_participants WHERE msg_id='i:m-old'").get()
  assert.deepEqual({ ...old }, { participant_key: null, identity_status: 'unknown', identity_reason: 'identity_epoch_changed' })
  db.close()
  rmSync(temp, { recursive: true, force: true })
})

// ───────────── import-time avatar writes (additive tables, sender MID only where the design allows it) ─────────────

const ACCOUNT = 'u-account'
const srcOf = (locator, name = null, source = 'profile') => ({ identity: 'x', locator, displayName: name, source: locator ? source : null })

function avatarDb({ withTables = true } = {}) {
  const db = createDb()
  db.pragma(`user_version = ${SCHEMA_VERSION}`)
  if (withTables) ensureLineAvatarSchema(db)
  return db
}

function outItem(msgId, chatId = 'c-room', ts = 10) {
  const base = item({ msgId, senderMid: ACCOUNT, chatId, ts })
  return { ...base, message: { ...base.message, direction: 'out', sender: 'me' } }
}

/** A batch the way watchEngine builds it: avatarMeta carries one source per distinct chat and per distinct (chat, sender). */
function avatarBatch(items, { id = 'avatar-batch', senders, chats } = {}) {
  const mids = [...new Set(items.filter((i) => i.senderMid).map((i) => `${i.message.chatId}\0${i.senderMid}`))]
  return {
    ...batch(items, id, { createdTime: 20, rowId: 9 }),
    avatarMeta: {
      chats: chats ?? [...new Set(items.map((i) => i.message.chatId))].map((chatId) => ({ chatId, source: srcOf(`/chat-${chatId}`, `name-${chatId}`) })),
      senders: senders ?? mids.map((key) => { const [chatId, senderMid] = key.split('\0'); return { chatId, senderMid, source: srcOf(`/p-${senderMid}`, `n-${senderMid}`) } })
    }
  }
}

const dumpAll = (db) => {
  const out = {}
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) out[name] = JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())
  return out
}

test('avatar write: incoming messages get a sender profile and a link in the same transaction; replaying the batch changes nothing', () => {
  const db = avatarDb()
  const temp = mkdtempSync(join(tmpdir(), 'line-avatar-write-'))
  const identity = identityProvider(temp)
  const input = avatarBatch([item({ msgId: 'a-1', senderMid: 'mid-A' }), item({ msgId: 'a-2', senderMid: 'mid-B', ts: 11 }), item({ msgId: 'a-3', senderMid: 'mid-A', ts: 12 })])
  const first = commitLineImportBatch(db, input, identity)
  assert.equal(first.inserted, 3)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM line_sender_profile').get().n, 2)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM line_message_sender').get().n, 3)
  assert.deepEqual({ ...db.prepare('SELECT source,locator,display_name FROM line_sender_profile WHERE sender_mid=?').get('mid-A') }, { source: 'profile', locator: '/p-mid-A', display_name: 'n-mid-A' })
  assert.deepEqual({ ...db.prepare("SELECT source,locator,display_name FROM line_chat_avatar WHERE chat_id='c-room'").get() }, { source: 'profile', locator: '/chat-c-room', display_name: 'name-c-room' })
  const joined = db.prepare(`SELECT ms.msg_id AS id, sp.sender_mid AS mid FROM line_message_sender ms JOIN line_sender_profile sp ON sp.sender_id=ms.sender_id ORDER BY ms.msg_id`).all().map((r) => [r.id, r.mid])
  assert.deepEqual(joined, [['i:a-1', 'mid-A'], ['i:a-2', 'mid-B'], ['i:a-3', 'mid-A']])
  assert.ok(db.prepare("SELECT value FROM line_avatar_meta WHERE key='link_watermark'").get().value, 'link_watermark is the commit time of the batch')
  assert.equal(db.prepare("SELECT value FROM line_avatar_meta WHERE key='link_watermark'").get().value, db.prepare('SELECT committed_at AS c FROM line_import_batches').get().c)
  const pick = (tables) => Object.fromEntries(['line_chat_avatar', 'line_sender_profile', 'line_message_sender', 'messages'].map((name) => [name, tables[name]]))
  const before = pick(dumpAll(db))
  const replay = commitLineImportBatch(db, input, identity)
  assert.equal(replay.inserted, 0)
  assert.deepEqual(pick(dumpAll(db)), before, 'a replay writes nothing new (rows unchanged, no duplicate links; only the watermark moves forward)')
  db.close()
  rmSync(temp, { recursive: true, force: true })
})

test('avatar write, MID containment: dumping every table, the account MID appears nowhere and a sender MID only as line_sender_profile.sender_mid (message_participants never holds one)', () => {
  const db = avatarDb()
  const temp = mkdtempSync(join(tmpdir(), 'line-avatar-mid-'))
  const identity = identityProvider(temp)
  const input = avatarBatch([
    item({ msgId: 'm-1', senderMid: 'mid-A' }), item({ msgId: 'm-2', senderMid: 'mid-B', ts: 11 }),
    outItem('m-3', 'c-room', 12), item({ msgId: 'm-4', senderMid: null, ts: 13 })
  ], {
    // a hostile or buggy collector that also hands over the account MID must not get it stored
    senders: [
      { chatId: 'c-room', senderMid: 'mid-A', source: srcOf('/p-A', 'A') }, { chatId: 'c-room', senderMid: 'mid-B', source: srcOf('/p-B', 'B') },
      { chatId: 'c-room', senderMid: ACCOUNT, source: srcOf('/p-me', 'Me') }
    ]
  })
  commitLineImportBatch(db, input, identity)
  const tables = dumpAll(db)
  for (const [name, text] of Object.entries(tables)) assert.equal(text.includes(ACCOUNT), false, `the account MID is not in ${name}`)
  for (const mid of ['mid-A', 'mid-B']) {
    const holders = Object.entries(tables).filter(([, text]) => text.includes(mid)).map(([name]) => name)
    assert.deepEqual(holders, ['line_sender_profile'], `${mid} only lives in line_sender_profile`)
  }
  assert.equal(tables.message_participants.includes('mid-'), false)
  assert.deepEqual(db.prepare('SELECT sender_mid AS m FROM line_sender_profile ORDER BY sender_mid').all().map((r) => r.m), ['mid-A', 'mid-B'])
  db.close()
  rmSync(temp, { recursive: true, force: true })
})

test('avatar write: outgoing messages, a sender that equals the account MID (even marked incoming), a missing MID and d: ids create no link and no profile', () => {
  const db = avatarDb()
  const temp = mkdtempSync(join(tmpdir(), 'line-avatar-skip-'))
  const identity = identityProvider(temp)
  const selfIncoming = item({ msgId: 'self-in', senderMid: ACCOUNT, ts: 11 })
  const derived = item({ msgId: '', senderMid: 'mid-D', ts: 12 })
  const outOther = outItem('out-other', 'c-room', 14)
  outOther.senderMid = 'mid-OUT'
  const input = avatarBatch([outItem('out-1'), selfIncoming, item({ msgId: 'no-mid', senderMid: null, ts: 13 }), derived, outOther])
  commitLineImportBatch(db, input, identity)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 5)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM line_sender_profile WHERE sender_mid=?').get('mid-OUT').n, 0, 'a message the app DB files as outgoing creates no profile, whoever the source says wrote it')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM line_message_sender').get().n, 0)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE msg_id LIKE 'd:%'").get().n, 1, 'the derived id exists in messages')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM line_sender_profile').get().n, 0, 'no profile either (not even for the d: id sender)')
  db.close()
  rmSync(temp, { recursive: true, force: true })
})

test('avatar write: a sender MID longer than the column allows is skipped on its own — the rest of the batch still gets its links', () => {
  const db = avatarDb()
  const temp = mkdtempSync(join(tmpdir(), 'line-avatar-long-'))
  const identity = identityProvider(temp)
  const long = 'x'.repeat(200)
  const result = commitLineImportBatch(db, avatarBatch([item({ msgId: 'l-1', senderMid: 'mid-A' }), item({ msgId: 'l-2', senderMid: long, ts: 11 })]), identity)
  assert.equal(result.inserted, 2)
  assert.deepEqual(db.prepare('SELECT msg_id AS id FROM line_message_sender').all().map((r) => r.id), ['i:l-1'])
  assert.deepEqual(db.prepare('SELECT sender_mid AS m FROM line_sender_profile').all().map((r) => r.m), ['mid-A'])
  db.close()
  rmSync(temp, { recursive: true, force: true })
})

test('avatar write: null never overwrites a known value, a new locator does, and an unchanged row inside six hours is not rewritten', () => {
  const db = avatarDb()
  const temp = mkdtempSync(join(tmpdir(), 'line-avatar-upsert-'))
  const identity = identityProvider(temp)
  const run = (id, msgId, source, chat) => commitLineImportBatch(db, avatarBatch([item({ msgId, senderMid: 'mid-A', ts: 30 })], { id, senders: [{ chatId: 'c-room', senderMid: 'mid-A', source }], chats: [{ chatId: 'c-room', source: chat }] }), identity)
  const row = () => ({ ...db.prepare('SELECT source,locator,display_name,refreshed_at FROM line_sender_profile').get() })
  const chatRow = () => ({ ...db.prepare('SELECT source,locator,display_name FROM line_chat_avatar').get() })
  run('b1', 'u-1', srcOf('/old', 'Alice'), srcOf('/room', 'Room'))
  const first = row()
  assert.deepEqual([first.source, first.locator, first.display_name], ['profile', '/old', 'Alice'])
  run('b2', 'u-2', srcOf(null, null), srcOf(null, null))
  assert.deepEqual({ ...row(), refreshed_at: 0 }, { source: 'profile', locator: '/old', display_name: 'Alice', refreshed_at: 0 }, 'null locator and null name keep the old values')
  assert.deepEqual(chatRow(), { source: 'profile', locator: '/room', display_name: 'Room' })
  assert.equal(row().refreshed_at, first.refreshed_at, 'nothing changed and it is recent: the row was not rewritten')
  run('b3', 'u-3', srcOf('/new', null, 'square'), srcOf('/room', 'Renamed'))
  assert.deepEqual([row().source, row().locator, row().display_name], ['square', '/new', 'Alice'])
  assert.equal(chatRow().display_name, 'Renamed')
  run('b3b', 'u-3b', srcOf(null, 'Alicia'), srcOf(null, 'Roomy'))
  assert.deepEqual([row().source, row().locator, row().display_name], ['square', '/new', 'Alicia'], 'a new name with no locator updates the name only')
  assert.deepEqual(chatRow(), { source: 'profile', locator: '/room', display_name: 'Roomy' })
  run('b3c', 'u-3c', srcOf('/new', 'Alice', 'square'), srcOf('/room', 'Renamed'))
  assert.equal(row().display_name, 'Alice')
  db.prepare('UPDATE line_sender_profile SET refreshed_at=refreshed_at-?').run(7 * 3600 * 1000)
  const stale = row().refreshed_at
  run('b4', 'u-4', srcOf('/new', 'Alice', 'square'), srcOf('/room', 'Renamed'))
  assert.ok(row().refreshed_at > stale, 'an unchanged row older than six hours is refreshed')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM line_sender_profile').get().n, 1)
  db.close()
  rmSync(temp, { recursive: true, force: true })
})

test('avatar write is additive: a failure in the avatar tables rolls back only its savepoint (messages, participants and the receipt commit); a participant failure still rolls back everything including the avatar rows', () => {
  const temp = mkdtempSync(join(tmpdir(), 'line-avatar-isolation-'))
  const identity = identityProvider(temp)
  const db = avatarDb()
  db.exec("CREATE TRIGGER fail_link BEFORE INSERT ON line_message_sender BEGIN SELECT RAISE(ABORT,'synthetic avatar failure'); END")
  const result = commitLineImportBatch(db, avatarBatch([item({ msgId: 'iso-1', senderMid: 'mid-A' })], { id: 'iso-1' }), identity)
  assert.equal(result.inserted, 1)
  assert.equal(result.receiptInserted, true)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message_participants').get().n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM line_import_batches').get().n, 1)
  for (const table of ['line_sender_profile', 'line_message_sender', 'line_chat_avatar']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, `${table} was rolled back with the savepoint`)
  db.close()

  const db2 = avatarDb()
  db2.exec("CREATE TRIGGER fail_participant_avatar BEFORE INSERT ON message_participants WHEN NEW.msg_id='i:iso-2' BEGIN SELECT RAISE(ABORT,'synthetic participant failure'); END")
  assert.throws(() => commitLineImportBatch(db2, avatarBatch([item({ msgId: 'iso-2', senderMid: 'mid-A' })], { id: 'iso-2' }), identity), /synthetic participant failure/)
  for (const table of ['messages', 'message_participants', 'line_import_batches', 'line_sender_profile', 'line_message_sender', 'line_chat_avatar']) assert.equal(db2.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, `${table} is empty after the failed commit`)
  db2.close()
  rmSync(temp, { recursive: true, force: true })
})

test('avatar write without the tables (standalone, schema unavailable): silently skipped and no table is created; a batch without avatarMeta writes nothing either', () => {
  const temp = mkdtempSync(join(tmpdir(), 'line-avatar-absent-'))
  const identity = identityProvider(temp)
  const db = avatarDb({ withTables: false })
  assert.equal(isLineAvatarSchemaReady(db), false)
  const result = commitLineImportBatch(db, avatarBatch([item({ msgId: 'n-1', senderMid: 'mid-A' })]), identity)
  assert.equal(result.inserted, 1)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'line_%avatar%' OR name IN ('line_sender_profile','line_message_sender')").get().n, 0)
  ensureLineAvatarSchema(db)
  const plain = batch([item({ msgId: 'n-2', senderMid: 'mid-B', ts: 11 })], 'plain-batch', { createdTime: 11, rowId: 2 })
  commitLineImportBatch(db, plain, identity)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM line_message_sender').get().n, 0, 'standalone batches (no avatarMeta) never write avatar rows')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM line_sender_profile').get().n, 0)
  db.close()
  rmSync(temp, { recursive: true, force: true })
})

const unknownNoPersist = {
  resolve: () => ({ participantKey: null, scope: 'unknown', keyVersion: null, status: 'unknown', reason: 'safe_storage_unavailable' }),
  epoch: () => null,
  persistUnknown: false
}

test('unknown identity with persistUnknown=false writes no participant rows but keeps receipt counts', () => {
  const db = createDb()
  const items = [item({ msgId: 'm-1', senderMid: 'mid-A' }), item({ msgId: 'm-2', senderMid: null, ts: 11 }), item({ msgId: 'm-3', senderMid: 'mid-B', ts: 12 })]
  const result = commitLineImportBatch(db, batch(items, 'batch-no-persist', { createdTime: 12, rowId: 3 }), unknownNoPersist)
  assert.equal(result.inserted, 3)
  assert.equal(result.unknownIdentityCount, 3)
  assert.equal(result.keyedIdentityCount, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message_participants').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 3)
  const receipt = db.prepare('SELECT row_count,keyed_identity_count,unknown_identity_count FROM line_import_batches').get()
  assert.deepEqual({ ...receipt }, { row_count: 3, keyed_identity_count: 0, unknown_identity_count: 3 })
  db.close()
})

test('persistUnknown=false still writes keyed rows, and a throwing resolver is skipped the same way as an unknown one', () => {
  const db = createDb()
  const temp = mkdtempSync(join(tmpdir(), 'line-identity-nopersist-test-'))
  const keyed = identityProvider(temp)
  const keyedNoPersist = { resolve: (input) => keyed.resolve(input), epoch: () => keyed.epoch(), persistUnknown: false }
  commitLineImportBatch(db, batch([item({ msgId: 'm-1', senderMid: 'mid-A' }), item({ msgId: 'm-2', senderMid: null, ts: 11 })], 'batch-mixed', { createdTime: 11, rowId: 2 }), keyedNoPersist)
  const rows = db.prepare('SELECT msg_id,identity_status FROM message_participants ORDER BY msg_id').all().map((row) => ({ ...row }))
  assert.deepEqual(rows, [{ msg_id: 'i:m-1', identity_status: 'keyed' }])
  const throwing = { resolve: () => { throw new Error('resolver down') }, epoch: () => null, persistUnknown: false }
  const failed = commitLineImportBatch(db, batch([item({ msgId: 'm-3', senderMid: 'mid-C', ts: 12 })], 'batch-throwing', { createdTime: 12, rowId: 3 }), throwing)
  assert.equal(failed.unknownIdentityCount, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message_participants').get().n, 1)
  db.close()
  rmSync(temp, { recursive: true, force: true })
})

test('avatar schema: user_version stays at the current SCHEMA_VERSION for an old (v8, tables missing) database and for a new one, and running it again has no side effect', () => {
  const old = avatarDb({ withTables: false })
  assert.equal(old.pragma('user_version', { simple: true }), SCHEMA_VERSION)
  ensureLineAvatarSchema(old)
  assert.equal(old.pragma('user_version', { simple: true }), SCHEMA_VERSION)
  const once = dumpAll(old)
  ensureLineAvatarSchema(old)
  ensureLineAvatarSchema(old)
  assert.deepEqual(dumpAll(old), once)
  assert.equal(isLineAvatarSchemaReady(old), true)
  old.close()
  const fresh = openDatabase({ dbPath: ':memory:' })
  try {
    assert.equal(fresh.db.pragma('user_version', { simple: true }), SCHEMA_VERSION)
    ensureLineAvatarSchema(fresh.db)
    assert.equal(fresh.db.pragma('user_version', { simple: true }), SCHEMA_VERSION)
  } finally { fresh.db.close() }
})

test('avatar tables cascade: deleting a message drops its link, deleting a chat drops its chat avatar, profiles and links', () => {
  const db = avatarDb()
  const temp = mkdtempSync(join(tmpdir(), 'line-avatar-cascade-'))
  const identity = identityProvider(temp)
  commitLineImportBatch(db, avatarBatch([item({ msgId: 'k-1', senderMid: 'mid-A' }), item({ msgId: 'k-2', senderMid: 'mid-A', ts: 11 })]), identity)
  db.prepare("DELETE FROM messages WHERE msg_id='i:k-1'").run()
  assert.deepEqual(db.prepare('SELECT msg_id FROM line_message_sender').all().map((r) => r.msg_id), ['i:k-2'])
  db.prepare('DELETE FROM message_participants').run()
  db.prepare('DELETE FROM messages').run()
  db.prepare("DELETE FROM chats WHERE chat_id='c-room'").run()
  for (const table of ['line_chat_avatar', 'line_sender_profile', 'line_message_sender']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table)
  db.close()
  rmSync(temp, { recursive: true, force: true })
})

test('avatar write with the account MID unknown (the source _profile is not there yet): only the chat level is written — no sender profile and no link whoever the rows say wrote them, the watermark does not move and the gap detector still sees the batch; the next batch with a known account links normally', () => {
  const db = avatarDb()
  const temp = mkdtempSync(join(tmpdir(), 'line-avatar-unknown-account-'))
  const identity = identityProvider(temp)
  const unknown = (value) => ({ ...value, accountMid: null })
  // with no account MID our own message ('u-account') is filed as incoming too
  const own = unknown(item({ msgId: 'u-1', senderMid: 'u-account', ts: 11 }))
  const first = avatarBatch([unknown(item({ msgId: 'u-0', senderMid: 'mid-A' })), own], { id: 'unknown-1', senders: [
    { chatId: 'c-room', senderMid: 'mid-A', source: srcOf('/p-A', 'A') }, { chatId: 'c-room', senderMid: 'u-account', source: srcOf('/p-me', 'Me') }
  ] })
  commitLineImportBatch(db, first, identity)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 2)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM line_chat_avatar').get().n, 1, 'the chat level is still written')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM line_sender_profile').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM line_message_sender').get().n, 0)
  for (const [name, text] of Object.entries(dumpAll(db))) assert.equal(text.includes('u-account'), false, `the account MID is not in ${name}`)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM line_avatar_meta WHERE key='link_watermark'").get().n, 0, 'the watermark did not move')
  assert.equal(hasLinkGap(db, 60_000), true, 'so the gap detector hands this batch to the backfill')
  commitLineImportBatch(db, avatarBatch([item({ msgId: 'u-2', senderMid: 'mid-B', ts: 12 })], { id: 'known-2' }), identity)
  assert.deepEqual(db.prepare('SELECT msg_id AS id FROM line_message_sender').all().map((r) => r.id), ['i:u-2'])
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM line_avatar_meta WHERE key='link_watermark'").get().n, 1)
  db.close()
  rmSync(temp, { recursive: true, force: true })
})

test('a provider without persistUnknown keeps writing unknown rows', () => {
  const db = createDb()
  const legacy = { resolve: unknownNoPersist.resolve, epoch: () => null }
  commitLineImportBatch(db, batch([item({ msgId: 'm-1', senderMid: 'mid-A' })], 'batch-legacy', { createdTime: 10, rowId: 1 }), legacy)
  const rows = db.prepare('SELECT msg_id,identity_status,identity_reason FROM message_participants').all().map((row) => ({ ...row }))
  assert.deepEqual(rows, [{ msg_id: 'i:m-1', identity_status: 'unknown', identity_reason: 'safe_storage_unavailable' }])
  db.close()
})

test('a freshly created import schema no longer builds idx_message_participants_chat_key', () => {
  const db = createDb()
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='message_participants'").all().map((row) => row.name)
  assert.equal(names.includes('idx_message_participants_chat_key'), false)
  db.close()
})
