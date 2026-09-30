import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { newMessagesAfter } from '../src/main/line/engine/linedb.ts'
import { rowToObj } from '../src/main/line/engine/rowToObj.ts'
import { commitLineImportBatch, ensureLineImportSchema } from '../src/main/db/lineImport.repo.ts'
import { commitAndAcknowledgeLineImportBatch, loadState, saveStateStrict } from '../src/main/line/engine/watchEngine.ts'
import { SCHEMA_DDL } from '../src/main/db/schema.ts'
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
