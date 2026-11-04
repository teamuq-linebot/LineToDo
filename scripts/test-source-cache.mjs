import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import NativeDatabase from 'better-sqlite3-plugin'
import { createBetterSqlite3AppEngine } from '../src/main/db/appDbEngine.ts'
import { openDatabase } from '../src/main/db/database.ts'
import { createLineTodoRuntime, DATA_DIRECTORY_IN_USE } from '../src/core/runtime.ts'
import { migrate } from '../src/main/db/migrate.ts'
import { getMessagesByChatAndIds, getRecentByChat, getUnprocessedForPipeline, insertMessages, markProcessed } from '../src/main/db/messages.repo.ts'
import { SCHEMA_DDL, SCHEMA_VERSION } from '../src/main/db/schema.ts'
import {
  SOURCE_APPEND_EVENTS_GLOBAL_LIMIT,
  SOURCE_CACHED_CHATS_LIMIT,
  SOURCE_ROWS_GLOBAL_LIMIT,
  SOURCE_ROWS_PER_CHAT_LIMIT,
  SOURCE_TEXT_BYTES_GLOBAL_LIMIT,
  SOURCE_TEXT_BYTES_PER_CHAT_LIMIT,
  fingerprintSourceMessage,
  ROLLING_SOURCE_SESSION_POLICY,
  configureSourceSessionPolicy,
  recoverAbandonedSourceLeases,
  readChatSourceState,
  sharedSourceRows
} from '../src/main/db/sourceCache.ts'
import {
  ensureGroupTopicsSchema,
  GROUP_TOPICS_SCHEMA_VERSION,
  loadPendingMessages,
  setCrossChatEnabled,
  setEnabled
} from '../src/main/features/groupTopics/repository.ts'

const FIXED_NOW = '2026-10-28T03:30:00.000Z'
const FIXED_EXPIRY = '2026-10-28T04:30:00.000Z'

function openFixture(dbPath=':memory:') {
  const engine = createBetterSqlite3AppEngine({ driver: NativeDatabase })
  return openDatabase({ dbPath, engine })
}

function makeMessage(id, chatId = 'chat-a', ts = 1000, text = 'source ' + id, chat = 'Alpha') {
  return {
    msgId: id,
    chat,
    chatId,
    isGroup: true,
    ts,
    time: new Date(ts).toISOString().slice(0, 19),
    direction: 'in',
    sender: 'Alice',
    text,
    contentType: 0
  }
}

function storedId(id) {
  return 'i:' + id
}

function makeLegacyV6() {
  const db = new NativeDatabase(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec([
    'CREATE TABLE chats(chat_id TEXT PRIMARY KEY,name TEXT,is_group INTEGER NOT NULL DEFAULT 0,blocked INTEGER NOT NULL DEFAULT 0,block_reason TEXT,first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL);',
    'CREATE TABLE messages(msg_id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,ts INTEGER NOT NULL,time_iso TEXT NOT NULL,direction TEXT NOT NULL CHECK(direction IN (\'in\',\'out\')),sender TEXT,text TEXT,content_type INTEGER NOT NULL DEFAULT 0,processed INTEGER NOT NULL DEFAULT 0,ingested_at TEXT NOT NULL,key_material TEXT,orig_filename TEXT,file_size INTEGER,media_backed_up INTEGER NOT NULL DEFAULT 0,unsent INTEGER NOT NULL DEFAULT 0,FOREIGN KEY(chat_id) REFERENCES chats(chat_id));',
    'CREATE INDEX idx_messages_chat_ts ON messages(chat_id,ts);',
    "CREATE TABLE todos(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,bucket TEXT NOT NULL,status TEXT NOT NULL,title TEXT NOT NULL,detail TEXT,priority INTEGER NOT NULL DEFAULT 2,due_at TEXT,source_msg_ids TEXT NOT NULL,confidence REAL NOT NULL DEFAULT .5,completion_evidence TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,resolved_at TEXT,FOREIGN KEY(chat_id) REFERENCES chats(chat_id));",
    'INSERT INTO chats VALUES(\'legacy-chat\',\'Legacy\',1,0,NULL,\'2026-01-01\',\'2026-01-02\');',
    'INSERT INTO messages(msg_id,chat_id,ts,time_iso,direction,sender,text,content_type,processed,ingested_at,unsent) VALUES(\'legacy-msg\',\'legacy-chat\',10,\'2026-01-01T00:00:10\',\'in\',\'A\',\'legacy source\',0,1,\'2026-01-02\',0);',
    "INSERT INTO todos(id,chat_id,bucket,status,title,source_msg_ids,created_at,updated_at,resolved_at) VALUES('legacy-todo','legacy-chat','todo','done','Legacy task','[\"legacy-msg\"]','2026-01-01','2026-01-02','2026-01-02');",
    'PRAGMA user_version = 6;'
  ].join('\n'))
  return db
}

function acquire(cache, chatId, leaseId) {
  const result = cache.acquireLease(chatId, leaseId, FIXED_EXPIRY, FIXED_NOW)
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.lease
}

function startAttempt(cache, lease, fingerprint = 'todo-session-fingerprint-v1', payload = '{\"selected\":true}') {
  const currentLease = cache.setSessionFingerprint(lease, fingerprint, FIXED_NOW)
  assert.ok(currentLease)
  return { lease: currentLease, attempt: cache.beginAttempt(currentLease, payload, FIXED_NOW) }
}

test('the product appDbEngine opens the pinned plugin alias on its actual native SQLite driver', () => {
  const opened = openFixture()
  try {
    assert.equal(SCHEMA_VERSION, 8)
    assert.equal(opened.db.pragma('user_version', { simple: true }), 8)
    assert.equal(opened.db.pragma('foreign_keys', { simple: true }), 1)
    assert.equal(opened.db.prepare('SELECT sqlite_version() AS version').get().version, '3.53.4')
    const trigger = opened.db.prepare("SELECT 1 AS yes FROM sqlite_master WHERE type='trigger' AND name='trg_messages_cache_after_insert'").get()
    assert.equal(trigger.yes, 1)
    const reference = readFileSync(new URL('../src/main/db/schema.sql', import.meta.url), 'utf8')
    assert.match(reference, /chat_context_cache_window/u)
    assert.match(reference, /trg_messages_cache_after_source_update/u)
    assert.equal(GROUP_TOPICS_SCHEMA_VERSION, 3)
  } finally {
    opened.close()
  }
})

test('runtime SCHEMA_DDL and the readable schema.sql reference expose matching core objects', () => {
  const runtime = new NativeDatabase(':memory:')
  const reference = new NativeDatabase(':memory:')
  try {
    runtime.pragma('foreign_keys = ON')
    runtime.exec(SCHEMA_DDL)
    reference.exec(readFileSync(new URL('../src/main/db/schema.sql', import.meta.url), 'utf8'))
    const getObjects = (db) => db.prepare(
      "SELECT type,name,tbl_name FROM sqlite_master WHERE type IN ('table','index','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type,name"
    ).all()
    const runtimeObjects = getObjects(runtime)
    const referenceObjects = getObjects(reference)
    assert.deepEqual(referenceObjects, runtimeObjects)
    for (const object of runtimeObjects.filter((item) => item.type === 'table')) {
      const runtimeColumns = runtime.prepare('PRAGMA table_info(' + object.name + ')').all()
      const referenceColumns = reference.prepare('PRAGMA table_info(' + object.name + ')').all()
      assert.deepEqual(referenceColumns, runtimeColumns, object.name)
      const runtimeForeignKeys = runtime.prepare('PRAGMA foreign_key_list(' + object.name + ')').all()
      const referenceForeignKeys = reference.prepare('PRAGMA foreign_key_list(' + object.name + ')').all()
      assert.deepEqual(referenceForeignKeys, runtimeForeignKeys, object.name + ' foreign keys')
    }
  } finally {
    runtime.close()
    reference.close()
  }
})

test('Core v6 to v8 backfills cold cache and identity index state while preserving canonical IDs and source JSON', () => {
  const db = makeLegacyV6()
  try {
    const sourceJson = db.prepare('SELECT source_msg_ids FROM todos WHERE id=?').get('legacy-todo').source_msg_ids
    const migration = migrate(db)
    assert.deepEqual(migration, { from: 6, to: 8 })
    assert.equal(db.pragma('user_version', { simple: true }), 8)
    assert.deepEqual(db.prepare('SELECT msg_id,text FROM messages').get(), { msg_id: 'legacy-msg', text: 'legacy source' })
    assert.deepEqual(db.prepare('SELECT id,status,source_msg_ids FROM todos').get(), {
      id: 'legacy-todo',
      status: 'done',
      source_msg_ids: sourceJson
    })
    assert.equal(db.prepare('SELECT entity_revision FROM todos WHERE id=?').get('legacy-todo').entity_revision, 1)
    assert.equal(db.prepare('SELECT state FROM identity_index_meta WHERE chat_id=? AND entity_type=?').get('legacy-chat','todo').state, 'building')
    assert.deepEqual(readChatSourceState(db, 'legacy-chat'), {
      chatId: 'legacy-chat',
      cacheSchemaVersion: 1,
      stateVersion: 1,
      sourceEpoch: 1,
      appendSeq: 0,
      scopeRevision: 1,
      todoIdentityRevision: 0,
      topicIdentityRevision: 0,
      windowComplete: false,
      windowDigest: null,
      activeLeaseId: null,
      leaseExpiresAt: null,
      sessionEpoch: 0,
      sessionFingerprint: null,
      acceptedTurns: 0,
      submittedRequests: 0,
      submittedUserUtf8Bytes: 0,
      lastAcceptedAt: null,
      tainted: false,
      updatedAt: '2026-01-02'
    })
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    const cacheColumns = db.prepare('PRAGMA table_info(chat_context_cache)').all().map((column) => column.name)
    assert.equal(cacheColumns.includes('text'), false)
    const windowColumns = db.prepare('PRAGMA table_info(chat_context_cache_window)').all().map((column) => column.name)
    assert.equal(windowColumns.includes('text'), false)
  } finally {
    db.close()
  }
})

test('a failed Core v6 migration rolls back its DDL and leaves user_version and source rows intact', () => {
  const db = makeLegacyV6()
  try {
    db.exec('CREATE TABLE chat_context_cache(chat_id TEXT PRIMARY KEY);')
    assert.throws(() => migrate(db), /no column named cache_schema_version/u)
    assert.equal(db.pragma('user_version', { simple: true }), 6)
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='ux_messages_chat_msg'").get(), undefined)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1)
  } finally {
    db.close()
  }
})

test('direct source and scope triggers include prompt mutations and exclude progress or media-only writes', () => {
  const opened = openFixture()
  const db = opened.db
  try {
    ensureGroupTopicsSchema(db)
    insertMessages([
      makeMessage('matrix-a', 'chat-a', 10, 'source A', 'Alpha'),
      makeMessage('matrix-b', 'chat-b', 11, 'source B', 'Beta')
    ], db)
    const state = () => readChatSourceState(db, 'chat-a')
    let epoch = state().sourceEpoch
    const append = state().appendSeq
    db.prepare('UPDATE messages SET processed=1,key_material=?,orig_filename=?,file_size=?,media_backed_up=1 WHERE msg_id=?')
      .run('fixture-media-key', 'fixture.bin', 64, storedId('matrix-a'))
    assert.equal(state().sourceEpoch, epoch)
    assert.equal(state().appendSeq, append)
    db.prepare('UPDATE messages SET text=text WHERE msg_id=?').run(storedId('matrix-a'))
    assert.equal(state().sourceEpoch, epoch)

    const updates = [
      ['ts', 12],
      ['time_iso', '2026-10-28T00:00:12'],
      ['direction', 'out'],
      ['sender', 'Bob'],
      ['text', 'updated source'],
      ['content_type', 1],
      ['unsent', 1]
    ]
    for (const [column, value] of updates) {
      db.prepare('UPDATE messages SET ' + column + '=? WHERE msg_id=?').run(value, storedId('matrix-a'))
      epoch += 1
      assert.equal(state().sourceEpoch, epoch, column)
    }

    const scope = state().scopeRevision
    db.prepare('UPDATE chats SET name=name WHERE chat_id=?').run('chat-a')
    assert.equal(state().scopeRevision, scope)
    db.prepare('UPDATE chats SET name=? WHERE chat_id=?').run('Alpha 2', 'chat-a')
    assert.equal(state().scopeRevision, scope + 1)
    db.prepare('UPDATE chats SET is_group=0 WHERE chat_id=?').run('chat-a')
    assert.equal(state().scopeRevision, scope + 2)
    db.prepare('UPDATE chats SET blocked=1 WHERE chat_id=?').run('chat-a')
    assert.equal(state().scopeRevision, scope + 3)

    const updated = state().scopeRevision
    db.prepare('INSERT INTO group_topic_preferences(chat_id,enabled,cross_chat_enabled,updated_at) VALUES(?,1,0,?)')
      .run('chat-a', FIXED_NOW)
    assert.equal(state().scopeRevision, updated + 1)
    db.prepare('UPDATE group_topic_preferences SET enabled=1 WHERE chat_id=?').run('chat-a')
    assert.equal(state().scopeRevision, updated + 1)
    db.prepare('UPDATE group_topic_preferences SET cross_chat_enabled=1 WHERE chat_id=?').run('chat-a')
    assert.equal(state().scopeRevision, updated + 2)
    db.prepare('DELETE FROM group_topic_preferences WHERE chat_id=?').run('chat-a')
    assert.equal(state().scopeRevision, updated + 3)

    const appendBeforeDuplicate = state().appendSeq
    db.prepare('INSERT OR IGNORE INTO messages(msg_id,chat_id,ts,time_iso,direction,sender,text,content_type,processed,ingested_at,unsent) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(storedId('matrix-a'), 'chat-a', 10, '2026-10-28T00:00:10', 'in', 'Alice', 'duplicate', 0, 0, FIXED_NOW, 0)
    assert.equal(state().appendSeq, appendBeforeDuplicate)
  } finally {
    opened.close()
  }
})

test('Todo and GroupTopics preserve their independent selector IDs while sharing exact raw rows', () => {
  const opened = openFixture()
  const db = opened.db
  try {
    ensureGroupTopicsSchema(db)
    assert.equal(db.prepare('SELECT value FROM group_topics_meta WHERE key=?').get('schema_version').value, '3')
    db.prepare('UPDATE group_topics_meta SET value=? WHERE key=?').run('1', 'schema_version')
    db.exec('DROP TRIGGER trg_group_topic_preferences_cache_after_insert; DROP TRIGGER trg_group_topic_preferences_cache_after_update; DROP TRIGGER trg_group_topic_preferences_cache_after_delete;')
    ensureGroupTopicsSchema(db)
    assert.equal(db.prepare('SELECT value FROM group_topics_meta WHERE key=?').get('schema_version').value, '3')
    assert.equal(db.prepare('SELECT 1 AS yes FROM sqlite_master WHERE type=? AND name=?').get('trigger', 'trg_group_topic_preferences_cache_after_update').yes, 1)
    const batch = Array.from({ length: 105 }, (_, index) => {
      const number = index + 1
      const suffix = String(number).padStart(3, '0')
      return makeMessage('raw-' + suffix, 'chat-a', number, 'message ' + suffix)
    })
    const inserted = insertMessages(batch, db)
    assert.equal(inserted.inserted, 105)
    assert.deepEqual(readChatSourceState(db, 'chat-a') && {
      sourceEpoch: readChatSourceState(db, 'chat-a').sourceEpoch,
      appendSeq: readChatSourceState(db, 'chat-a').appendSeq
    }, { sourceEpoch: 1, appendSeq: 105 })

    const cache = sharedSourceRows(db)
    const todoPending = getUnprocessedForPipeline(200, db)
    assert.deepEqual(todoPending.map((row) => row.msgId), batch.map((row) => storedId(row.msgId)))
    const recent = getRecentByChat('chat-a', 10, db)
    assert.deepEqual(recent.map((row) => row.msgId), batch.slice(-10).map((row) => storedId(row.msgId)))
    const topicPending = loadPendingMessages(db, 'chat-a', 20, 100)
    assert.equal(topicPending.length, 20)
    assert.equal(topicPending[0].msgId, storedId('raw-006'))
    assert.equal(topicPending.some((row) => row.msgId === storedId('raw-006')), true)
    assert.equal(recent.some((row) => row.msgId === storedId('raw-006')), false)
    assert.equal(getMessagesByChatAndIds('another-chat', [storedId('raw-006')], db).length, 0)
    const beforeRepeat = cache.diagnostics()
    assert.equal(loadPendingMessages(db, 'chat-a', 20, 100).length, 20)
    const afterRepeat = cache.diagnostics()
    assert.ok(afterRepeat.hits - beforeRepeat.hits >= 20)

    const sourceEpoch = readChatSourceState(db, 'chat-a').sourceEpoch
    assert.equal(markProcessed([storedId('raw-006')], db), 1)
    assert.equal(readChatSourceState(db, 'chat-a').sourceEpoch, sourceEpoch)
    assert.equal(getUnprocessedForPipeline(200, db).some((row) => row.msgId === storedId('raw-006')), false)
    assert.equal(loadPendingMessages(db, 'chat-a', 20, 100).some((row) => row.msgId === storedId('raw-006')), true)

    const scopeBefore = readChatSourceState(db, 'chat-a').scopeRevision
    assert.equal(setEnabled(db, 'chat-a', true), true)
    assert.equal(readChatSourceState(db, 'chat-a').scopeRevision, scopeBefore + 1)
    assert.equal(setEnabled(db, 'chat-a', true), true)
    assert.equal(readChatSourceState(db, 'chat-a').scopeRevision, scopeBefore + 1)
    assert.equal(setCrossChatEnabled(db, 'chat-a', true), true)
    assert.equal(readChatSourceState(db, 'chat-a').scopeRevision, scopeBefore + 2)
  } finally {
    opened.close()
  }
})

test('real insertMessages appends warm L1 and rebase an old lease through repeated arrivals', () => {
  const opened = openFixture()
  const db = opened.db
  try {
    ensureGroupTopicsSchema(db)
    const batch = Array.from({ length: 12 }, (_, index) => makeMessage('base-' + index, 'chat-a', 100 + index, 'base row ' + index))
    insertMessages(batch, db)
    const cache = sharedSourceRows(db)
    const selected = getRecentByChat('chat-a', 10, db).at(-1)

    let firstLease = acquire(cache, 'chat-a', 'lease-first')
    const firstStart = startAttempt(cache, firstLease)
    firstLease = firstStart.lease
    assert.equal(firstStart.attempt.ok, true)
    const committed = cache.commitLease({
      lease: firstLease,
      selectedRows: [{ msgId: selected.msgId, contentFingerprint: fingerprintSourceMessage(selected) }],
      fallbackRecent: () => getRecentByChat('chat-a', 10, db),
      acceptedAt: FIXED_NOW
    })
    assert.equal(committed.ok, true, JSON.stringify(committed))
    assert.equal(committed.usedFallback, false)

    let oldLease = acquire(cache, 'chat-a', 'lease-held')
    assert.equal(oldLease.appendSeq, 12)
    const oldStart = startAttempt(cache, oldLease)
    oldLease = oldStart.lease
    assert.equal(oldStart.attempt.ok, true)
    const beforeEpoch = readChatSourceState(db, 'chat-a').sourceEpoch
    const beforeAppend = readChatSourceState(db, 'chat-a').appendSeq
    const arrivals = Array.from({ length: 8 }, (_, index) => makeMessage('live-' + index, 'chat-a', 200 + index, 'live append ' + index))
    arrivals.push(makeMessage('late-low-ts', 'chat-a', 3, 'late lower timestamp'))
    for (const row of arrivals) assert.equal(insertMessages([row], db).inserted, 1)
    assert.equal(readChatSourceState(db, 'chat-a').sourceEpoch, beforeEpoch)
    assert.equal(readChatSourceState(db, 'chat-a').appendSeq, beforeAppend + arrivals.length)

    let fallbackCalls = 0
    const oldCommit = cache.commitLease({
      lease: oldLease,
      selectedRows: [{ msgId: selected.msgId, contentFingerprint: fingerprintSourceMessage(selected) }],
      fallbackRecent: () => { fallbackCalls += 1; return getRecentByChat('chat-a', 10, db) },
      acceptedAt: FIXED_NOW
    })
    assert.equal(oldCommit.ok, true, JSON.stringify(oldCommit))
    assert.equal(oldCommit.appendCount, arrivals.length)
    assert.equal(oldCommit.usedAppendRebase, true)
    assert.equal(oldCommit.usedFallback, false)
    assert.equal(fallbackCalls, 0)
    const orderedWindow = db.prepare(
      'SELECT w.msg_id,m.ts FROM chat_context_cache_window w JOIN messages m ON m.chat_id=w.chat_id AND m.msg_id=w.msg_id WHERE w.chat_id=? ORDER BY w.position'
    ).all('chat-a')
    assert.equal(orderedWindow.length, 10)
    assert.deepEqual(orderedWindow, [...orderedWindow].sort((a, b) => a.ts - b.ts || a.msg_id.localeCompare(b.msg_id)))

    const hitBefore = cache.diagnostics().hits
    assert.equal(getMessagesByChatAndIds('chat-a', [storedId('live-7')], db).length, 1)
    assert.ok(cache.diagnostics().hits > hitBefore)
  } finally {
    opened.close()
  }
})

test('an append gap falls back once; a rewrite stales the lease and a source delete clears derived window refs', () => {
  const opened = openFixture()
  const db = opened.db
  try {
    insertMessages(Array.from({ length: 4 }, (_, index) => makeMessage('seed-' + index, 'chat-a', 10 + index)), db)
    const cache = sharedSourceRows(db)
    const selected = getRecentByChat('chat-a', 10, db).at(-1)
    let first = acquire(cache, 'chat-a', 'seed-lease')
    const firstStart = startAttempt(cache, first)
    first = firstStart.lease
    assert.equal(firstStart.attempt.ok, true)
    assert.equal(cache.commitLease({
      lease: first,
      selectedRows: [{ msgId: selected.msgId, contentFingerprint: fingerprintSourceMessage(selected) }],
      fallbackRecent: () => getRecentByChat('chat-a', 10, db),
      acceptedAt: FIXED_NOW
    }).ok, true)

    let gapLease = acquire(cache, 'chat-a', 'gap-lease')
    const gapStart = startAttempt(cache, gapLease)
    gapLease = gapStart.lease
    assert.equal(gapStart.attempt.ok, true)
    const sourceState = readChatSourceState(db, 'chat-a')
    db.prepare('INSERT INTO messages(msg_id,chat_id,ts,time_iso,direction,sender,text,content_type,processed,ingested_at,unsent) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run('i:direct-gap', 'chat-a', 30, '2026-10-28T00:00:30', 'in', 'Bob', 'direct source insert', 0, 0, FIXED_NOW, 0)
    assert.equal(readChatSourceState(db, 'chat-a').appendSeq, sourceState.appendSeq + 1)
    let fallbackCalls = 0
    const gapCommit = cache.commitLease({
      lease: gapLease,
      selectedRows: [{ msgId: selected.msgId, contentFingerprint: fingerprintSourceMessage(selected) }],
      fallbackRecent: () => { fallbackCalls += 1; return getRecentByChat('chat-a', 10, db) },
      acceptedAt: FIXED_NOW
    })
    assert.equal(gapCommit.ok, true, JSON.stringify(gapCommit))
    assert.equal(gapCommit.usedFallback, true)
    assert.equal(fallbackCalls, 1)

    let rewriteLease = acquire(cache, 'chat-a', 'rewrite-lease')
    const rewriteStart = startAttempt(cache, rewriteLease, 'todo-session-fingerprint-v2')
    rewriteLease = rewriteStart.lease
    assert.equal(rewriteStart.attempt.ok, true)
    const beforeRewriteEpoch = readChatSourceState(db, 'chat-a').sourceEpoch
    db.prepare('UPDATE messages SET text=? WHERE msg_id=?').run('rewritten source', selected.msgId)
    assert.equal(readChatSourceState(db, 'chat-a').sourceEpoch, beforeRewriteEpoch + 1)
    let applyCalled = false
    const stale = cache.commitLease({
      lease: rewriteLease,
      selectedRows: [{ msgId: selected.msgId, contentFingerprint: fingerprintSourceMessage(selected) }],
      fallbackRecent: () => getRecentByChat('chat-a', 10, db),
      apply: () => { applyCalled = true },
      acceptedAt: FIXED_NOW
    })
    assert.deepEqual(stale, { ok: false, reason: 'source_stale' })
    assert.equal(applyCalled, false)

    let replacement = acquire(cache, 'chat-a', 'delete-window-lease')
    const replacementStart = startAttempt(cache, replacement, 'todo-session-fingerprint-v3')
    replacement = replacementStart.lease
    assert.equal(replacementStart.attempt.ok, true)
    const latest = getRecentByChat('chat-a', 10, db).at(-1)
    assert.equal(cache.commitLease({
      lease: replacement,
      selectedRows: [{ msgId: latest.msgId, contentFingerprint: fingerprintSourceMessage(latest) }],
      fallbackRecent: () => getRecentByChat('chat-a', 10, db),
      acceptedAt: FIXED_NOW
    }).ok, true)
    const beforeDelete = readChatSourceState(db, 'chat-a').sourceEpoch
    const deletedId = db.prepare('SELECT msg_id FROM chat_context_cache_window WHERE chat_id=? ORDER BY position LIMIT 1').get('chat-a').msg_id
    assert.equal(db.prepare('DELETE FROM messages WHERE chat_id=? AND msg_id=?').run('chat-a', deletedId).changes, 1)
    assert.equal(readChatSourceState(db, 'chat-a').sourceEpoch, beforeDelete + 1)
    assert.equal(readChatSourceState(db, 'chat-a').windowComplete, false)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_context_cache_window WHERE chat_id=?').get('chat-a').n, 0)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    opened.close()
  }
})

test('RESTRICT on a derived cache window blocks a legal source delete; v7 CASCADE invalidates it instead', () => {
  const control = new NativeDatabase(':memory:')
  control.pragma('foreign_keys = ON')
  control.exec([
    'CREATE TABLE chats(chat_id TEXT PRIMARY KEY);',
    'CREATE TABLE messages(msg_id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,UNIQUE(chat_id,msg_id));',
    'CREATE TABLE cache(chat_id TEXT PRIMARY KEY REFERENCES chats(chat_id) ON DELETE CASCADE);',
    'CREATE TABLE cache_window(chat_id TEXT NOT NULL,msg_id TEXT NOT NULL,PRIMARY KEY(chat_id,msg_id),FOREIGN KEY(chat_id) REFERENCES cache(chat_id) ON DELETE CASCADE,FOREIGN KEY(chat_id,msg_id) REFERENCES messages(chat_id,msg_id) ON DELETE RESTRICT);',
    'INSERT INTO chats VALUES(\'chat-a\');',
    'INSERT INTO cache VALUES(\'chat-a\');',
    'INSERT INTO messages VALUES(\'m1\',\'chat-a\');',
    'INSERT INTO cache_window VALUES(\'chat-a\',\'m1\');'
  ].join('\n'))
  try {
    assert.throws(() => control.prepare('DELETE FROM messages WHERE msg_id=?').run('m1'), /FOREIGN KEY constraint failed/u)
  } finally {
    control.close()
  }

  const opened = openFixture()
  try {
    const db = opened.db
    insertMessages([makeMessage('cascade-row', 'chat-a', 10)], db)
    const cache = sharedSourceRows(db)
    const source = getRecentByChat('chat-a', 10, db)[0]
    let lease = acquire(cache, 'chat-a', 'cascade-lease')
    const leaseStart = startAttempt(cache, lease)
    lease = leaseStart.lease
    assert.equal(leaseStart.attempt.ok, true)
    assert.equal(cache.commitLease({
      lease,
      selectedRows: [{ msgId: source.msgId, contentFingerprint: fingerprintSourceMessage(source) }],
      fallbackRecent: () => getRecentByChat('chat-a', 10, db),
      acceptedAt: FIXED_NOW
    }).ok, true)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_context_cache_window').get().n, 1)
    const epoch = readChatSourceState(db, 'chat-a').sourceEpoch
    assert.equal(db.prepare('DELETE FROM messages WHERE chat_id=? AND msg_id=?').run('chat-a', source.msgId).changes, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_context_cache_window').get().n, 0)
    assert.equal(readChatSourceState(db, 'chat-a').sourceEpoch, epoch + 1)
  } finally {
    opened.close()
  }
})

test('a cached source message can move chats and invalidates both old and new chat epochs', () => {
  const opened = openFixture()
  const db = opened.db
  try {
    insertMessages([
      makeMessage('move-row', 'chat-a', 10, 'movable source', 'Alpha'),
      makeMessage('move-seed', 'chat-b', 20, 'other chat source', 'Beta')
    ], db)
    const cache = sharedSourceRows(db)
    const source = getRecentByChat('chat-a', 10, db)[0]
    let lease = acquire(cache, 'chat-a', 'move-lease')
    const started = startAttempt(cache, lease)
    lease = started.lease
    assert.equal(started.attempt.ok, true)
    assert.equal(cache.commitLease({
      lease,
      selectedRows: [{ msgId: source.msgId, contentFingerprint: fingerprintSourceMessage(source) }],
      fallbackRecent: () => getRecentByChat('chat-a', 10, db),
      acceptedAt: FIXED_NOW
    }).ok, true)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_context_cache_window').get().n, 1)

    const oldEpoch = readChatSourceState(db, 'chat-a').sourceEpoch
    const newEpoch = readChatSourceState(db, 'chat-b').sourceEpoch
    assert.equal(db.prepare('UPDATE messages SET chat_id=? WHERE msg_id=?').run('chat-b', source.msgId).changes, 1)
    assert.equal(readChatSourceState(db, 'chat-a').sourceEpoch, oldEpoch + 1)
    assert.equal(readChatSourceState(db, 'chat-b').sourceEpoch, newEpoch + 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_context_cache_window').get().n, 0)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    opened.close()
  }
})

test('insertMessages inside an outer import transaction leaves no phantom append event or L1 row on rollback', () => {
  const opened = openFixture()
  const db = opened.db
  try {
    insertMessages([makeMessage('outer-base', 'chat-a', 10)], db)
    const cache = sharedSourceRows(db)
    getRecentByChat('chat-a', 10, db)
    const beforeState = readChatSourceState(db, 'chat-a')
    const beforeCache = cache.diagnostics()
    const tx = db.transaction(() => {
      assert.equal(insertMessages([makeMessage('outer-rolled-back', 'chat-a', 20)], db).inserted, 1)
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE msg_id=?').get(storedId('outer-rolled-back')).n, 1)
      throw new Error('rollback outer import')
    })
    assert.throws(() => tx(), /rollback outer import/u)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE msg_id=?').get(storedId('outer-rolled-back')).n, 0)
    assert.equal(readChatSourceState(db, 'chat-a').appendSeq, beforeState.appendSeq)
    assert.equal(cache.diagnostics().cachedRows, beforeCache.cachedRows)
    assert.equal(cache.diagnostics().cachedAppendEvents, beforeCache.cachedAppendEvents)
  } finally {
    opened.close()
  }
})

test('only the exclusive runtime owner proof can recover abandoned lease metadata; a live-owner standby cannot release it',async()=>{
  const scratch='C:/teamuq/teamuq-plugins/output/linetodo-cache-identity-implementation-20261028/developer/phase3/scratch/runtime-owner-recovery'
  mkdirSync(scratch,{recursive:true})
  const dataDir=mkdtempSync(join(scratch,'owner-'))
  const dbPath=join(dataDir,'line-todo.db')
  const opened=openFixture(dbPath);const db=opened.db
  let owner=null;let takeover=null;let otherOwner=null;let otherDbOpened=null;let firstProof=null;let otherProof=null
  try{
    insertMessages([makeMessage('crash-recovery')],db)
    const row=getMessagesByChatAndIds('chat-a',[storedId('crash-recovery')],db)[0]
    const cache=sharedSourceRows(db)
    let lease=cache.acquireLease('chat-a','lease-before-commit',FIXED_EXPIRY,FIXED_NOW)
    assert.equal(lease.ok,true)
    let session=cache.setSessionFingerprint(lease.lease,'host-session',FIXED_NOW)
    assert.ok(session)
    assert.equal(cache.beginAttempt(session,'initial user payload',FIXED_NOW).ok,true)
    const committed=cache.commitLease({lease:session,selectedRows:[{msgId:row.msgId,contentFingerprint:fingerprintSourceMessage(row)}],fallbackRecent:()=>[row],acceptedAt:FIXED_NOW})
    assert.equal(committed.ok,true)
    const prior=readChatSourceState(db,'chat-a')
    assert.equal(prior.windowComplete,true)

    lease=cache.acquireLease('chat-a','lease-before-runtime-owner',FIXED_EXPIRY,FIXED_NOW)
    assert.equal(lease.ok,true)
    session=cache.setSessionFingerprint(lease.lease,'host-session',FIXED_NOW)
    assert.ok(session)
    assert.equal(cache.beginAttempt(session,'in-flight payload',FIXED_NOW).ok,true)

    let firstRecovery=0
    owner=await createLineTodoRuntime({dataDir,initialize:async(ownerProof)=>{
      firstProof=ownerProof
      firstRecovery=recoverAbandonedSourceLeases(db,ownerProof,dataDir,dbPath,FIXED_NOW)
      return{api:{},start:async()=>{},stop:async()=>{},dispose:async()=>{}}
    }})
    assert.equal(firstRecovery,1,'the runtime initializer receives a proof only after its lock is acquired')
    const recovered=readChatSourceState(db,'chat-a')
    assert.equal(recovered.activeLeaseId,null)
    assert.equal(recovered.leaseExpiresAt,null)
    assert.equal(recovered.tainted,true)
    assert.equal(recovered.windowComplete,true,'the last committed window is preserved')
    assert.equal(recovered.windowDigest,prior.windowDigest)
    assert.equal(db.prepare('SELECT text,processed FROM messages WHERE msg_id=?').get(row.msgId).text,'source crash-recovery')
    assert.equal(db.prepare('SELECT processed FROM messages WHERE msg_id=?').get(row.msgId).processed,0,'an abandoned lease never acknowledges source')

    lease=cache.acquireLease('chat-a','lease-live-owner',FIXED_EXPIRY,FIXED_NOW)
    assert.equal(lease.ok,true)
    session=cache.setSessionFingerprint(lease.lease,'host-session',FIXED_NOW)
    assert.ok(session)
    assert.equal(cache.beginAttempt(session,'live owner payload',FIXED_NOW).ok,true)
    assert.equal(recoverAbandonedSourceLeases(db,{},dataDir,dbPath,FIXED_NOW),0,'a missing/forged owner proof cannot release a live lease')
    assert.equal(readChatSourceState(db,'chat-a').activeLeaseId,'lease-live-owner')
    const otherDataDir=mkdtempSync(join(scratch,'other-owner-'))
    const otherDbPath=join(otherDataDir,'line-todo.db')
    otherOwner=await createLineTodoRuntime({dataDir:otherDataDir,initialize:async(ownerProof)=>{otherProof=ownerProof;return{api:{},start:async()=>{},stop:async()=>{},dispose:async()=>{}}}})
    assert.equal(recoverAbandonedSourceLeases(db,otherProof,dataDir,dbPath,FIXED_NOW),0,'a proof from another dataDir cannot recover this database')
    assert.equal(recoverAbandonedSourceLeases(db,firstProof,dataDir,otherDbPath,FIXED_NOW),0,'an owner proof cannot be paired with another DB path')
    assert.equal(readChatSourceState(db,'chat-a').activeLeaseId,'lease-live-owner')
    otherDbOpened=openFixture(otherDbPath)
    const otherDb=otherDbOpened.db
    insertMessages([makeMessage('foreign-resource')],otherDb)
    const foreignCache=sharedSourceRows(otherDb)
    const foreignLease=foreignCache.acquireLease('chat-a','lease-foreign-resource',FIXED_EXPIRY,FIXED_NOW)
    assert.equal(foreignLease.ok,true)
    const foreignSession=foreignCache.setSessionFingerprint(foreignLease.lease,'foreign-host-session',FIXED_NOW)
    assert.ok(foreignSession)
    assert.equal(foreignCache.beginAttempt(foreignSession,'foreign live payload',FIXED_NOW).ok,true)
    assert.equal(recoverAbandonedSourceLeases(otherDb,firstProof,dataDir,dbPath,FIXED_NOW),0,'an A proof cannot recover the actual B database handle even when the supplied path names A')
    assert.equal(readChatSourceState(otherDb,'chat-a').activeLeaseId,'lease-foreign-resource','the foreign B database lease is untouched')
    let standbyInitialized=false
    await assert.rejects(createLineTodoRuntime({dataDir,initialize:async(ownerProof)=>{standbyInitialized=true;recoverAbandonedSourceLeases(db,ownerProof,dataDir,dbPath,FIXED_NOW);return{api:{},start:async()=>{},stop:async()=>{},dispose:async()=>{}}}}),(error)=>error.code===DATA_DIRECTORY_IN_USE)
    assert.equal(standbyInitialized,false,'the second standby is refused before it can receive an owner proof or initialize DB recovery')
    assert.equal(readChatSourceState(db,'chat-a').activeLeaseId,'lease-live-owner','the failed standby leaves the valid owner lease intact')

    otherDbOpened.close();otherDbOpened=null
    await otherOwner.dispose();otherOwner=null
    await owner.dispose();owner=null
    assert.equal(recoverAbandonedSourceLeases(db,firstProof,dataDir,dbPath,FIXED_NOW),0,'a released runtime invalidates its proof')
    assert.equal(readChatSourceState(db,'chat-a').activeLeaseId,'lease-live-owner')
    let takeoverRecovery=0
    takeover=await createLineTodoRuntime({dataDir,initialize:async(ownerProof)=>{
      takeoverRecovery=recoverAbandonedSourceLeases(db,ownerProof,dataDir,dbPath,FIXED_NOW)
      return{api:{},start:async()=>{},stop:async()=>{},dispose:async()=>{}}
    }})
    assert.equal(takeoverRecovery,1,'only after exclusive owner takeover is the abandoned lease released')
    const afterTakeover=readChatSourceState(db,'chat-a')
    assert.equal(afterTakeover.windowComplete,true)
    assert.equal(afterTakeover.windowDigest,prior.windowDigest)
    assert.equal(afterTakeover.tainted,true)
    assert.equal(db.prepare('SELECT processed FROM messages WHERE msg_id=?').get(row.msgId).processed,0)
    const next=cache.acquireLease('chat-a','lease-after-restart',FIXED_EXPIRY,FIXED_NOW)
    assert.equal(next.ok,true)
    const fresh=cache.setSessionFingerprint(next.lease,'host-session',FIXED_NOW)
    assert.ok(fresh)
    assert.equal(fresh.sessionEpoch,afterTakeover.sessionEpoch+1,'tainted context starts a new Host epoch')
    assert.equal(cache.beginAttempt(fresh,'fresh current user payload',FIXED_NOW).ok,true)
    const seeded=readChatSourceState(db,'chat-a')
    assert.equal(seeded.submittedRequests,1)
    assert.equal(seeded.submittedUserUtf8Bytes,Buffer.byteLength('fresh current user payload','utf8'))
  }finally{if(owner)await owner.dispose();if(takeover)await takeover.dispose();if(otherDbOpened)otherDbOpened.close();if(otherOwner)await otherOwner.dispose();opened.close()}
})

test('lease attempts count actual UTF-8 bytes and failed apply rolls back source checkpoint and caller writes', () => {
  const opened = openFixture()
  const db = opened.db
  try {
    insertMessages([makeMessage('atomic-row', 'chat-a', 10)], db)
    const cache = sharedSourceRows(db)
    const row = getRecentByChat('chat-a', 10, db)[0]
    db.exec('CREATE TABLE apply_marker(value TEXT NOT NULL);')
    let lease = acquire(cache, 'chat-a', 'atomic-lease')
    lease = cache.setSessionFingerprint(lease, 'host-model-prompt-v1', FIXED_NOW)
    assert.ok(lease)
    const attempt = cache.beginAttempt(lease, '{\"m\":\"😀\"}', FIXED_NOW)
    assert.equal(attempt.ok, true)
    assert.equal(attempt.userUtf8Bytes, Buffer.byteLength('{\"m\":\"😀\"}', 'utf8'))
    const before = readChatSourceState(db, 'chat-a')
    assert.throws(() => cache.commitLease({
      lease,
      selectedRows: [{ msgId: row.msgId, contentFingerprint: fingerprintSourceMessage(row) }],
      fallbackRecent: () => getRecentByChat('chat-a', 10, db),
      apply: () => {
        db.prepare('INSERT INTO apply_marker(value) VALUES(?)').run('pending ack')
        throw new Error('inject apply failure')
      },
      acceptedAt: FIXED_NOW
    }), /inject apply failure/u)
    const after = readChatSourceState(db, 'chat-a')
    assert.equal(after.windowComplete, before.windowComplete)
    assert.equal(after.acceptedTurns, before.acceptedTurns)
    assert.equal(after.submittedRequests, before.submittedRequests)
    assert.equal(after.activeLeaseId, lease.leaseId)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM apply_marker').get().n, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_context_cache_window').get().n, 0)
    assert.equal(cache.beginAttempt(lease, 'x'.repeat(SOURCE_TEXT_BYTES_PER_CHAT_LIMIT + 1), FIXED_NOW).reason, 'byte_limit')
  } finally {
    opened.close()
  }
})

test('process L1 stays bounded per chat and globally, including append-event metadata', () => {
  const opened = openFixture()
  const db = opened.db
  try {
    const batch = []
    for (let chat = 0; chat < 32; chat += 1) {
      const chatId = 'bound-' + String(chat).padStart(2, '0')
      for (let row = 0; row < 130; row += 1) {
        batch.push(makeMessage('b-' + chat + '-' + row, chatId, chat * 1000 + row, 'bounded payload ' + row, chatId))
      }
    }
    assert.equal(insertMessages(batch, db).inserted, 4160)
    const cache = sharedSourceRows(db)
    let diagnostics = cache.diagnostics()
    assert.equal(diagnostics.cachedRows, SOURCE_ROWS_GLOBAL_LIMIT)
    assert.equal(diagnostics.cachedChats, 32)
    assert.equal(diagnostics.cachedAppendEvents, SOURCE_APPEND_EVENTS_GLOBAL_LIMIT)
    assert.ok(diagnostics.cachedTextBytes <= SOURCE_TEXT_BYTES_GLOBAL_LIMIT)
    const lastChat = cache.chatDiagnostics('bound-31')
    assert.equal(lastChat.cachedRows, SOURCE_ROWS_PER_CHAT_LIMIT)
    assert.ok(lastChat.cachedTextBytes <= SOURCE_TEXT_BYTES_PER_CHAT_LIMIT)

    const more = []
    for (let chat = 32; chat < 71; chat += 1) {
      const chatId = 'bound-' + String(chat).padStart(2, '0')
      more.push(makeMessage('single-' + chat, chatId, chat, 'small row', chatId))
    }
    assert.equal(insertMessages(more, db).inserted, more.length)
    diagnostics = cache.diagnostics()
    assert.equal(diagnostics.cachedChats, SOURCE_CACHED_CHATS_LIMIT)
    assert.ok(diagnostics.cachedRows <= SOURCE_ROWS_GLOBAL_LIMIT)
    assert.ok(diagnostics.cachedAppendEvents <= SOURCE_APPEND_EVENTS_GLOBAL_LIMIT)

    const wideTextBatch = []
    const wideText = 'y'.repeat(64 * 1024)
    for (let chat = 0; chat < 17; chat += 1) {
      const chatId = 'text-bound-' + chat
      for (let row = 0; row < 16; row += 1) {
        wideTextBatch.push(makeMessage('text-' + chat + '-' + row, chatId, chat * 100 + row, wideText, chatId))
      }
    }
    assert.equal(insertMessages(wideTextBatch, db).inserted, wideTextBatch.length)
    diagnostics = cache.diagnostics()
    assert.ok(diagnostics.cachedTextBytes <= SOURCE_TEXT_BYTES_GLOBAL_LIMIT)
    assert.ok(diagnostics.cachedTextBytes >= SOURCE_TEXT_BYTES_GLOBAL_LIMIT - (2 * 64 * 1024))
    assert.ok(cache.chatDiagnostics('text-bound-16').cachedTextBytes <= SOURCE_TEXT_BYTES_PER_CHAT_LIMIT)

    const huge = makeMessage('oversized', 'bound-70', 1000, 'x'.repeat(SOURCE_TEXT_BYTES_PER_CHAT_LIMIT + 1), 'bound-70')
    assert.equal(insertMessages([huge], db).inserted, 1)
    assert.ok(cache.chatDiagnostics('bound-70').cachedTextBytes <= SOURCE_TEXT_BYTES_PER_CHAT_LIMIT)
    assert.ok(cache.diagnostics().cachedTextBytes <= SOURCE_TEXT_BYTES_GLOBAL_LIMIT)

    ensureGroupTopicsSchema(db)
    db.exec('ANALYZE;')
    const recentPlan = db.prepare('EXPLAIN QUERY PLAN SELECT msg_id FROM messages WHERE chat_id=? ORDER BY ts DESC,msg_id DESC LIMIT 10').all('bound-70')
    const exactPlan = db.prepare('EXPLAIN QUERY PLAN SELECT msg_id FROM messages WHERE chat_id=? AND msg_id IN (?)').all('bound-70', storedId('oversized'))
    const topicPlan = db.prepare(
      'EXPLAIN QUERY PLAN SELECT m.msg_id FROM messages m ' +
      'WHERE m.chat_id=? AND m.unsent=0 AND m.content_type=0 AND m.text IS NOT NULL AND trim(m.text)<>\'\' ' +
      'AND m.msg_id IN (SELECT recent.msg_id FROM messages recent WHERE recent.chat_id=? AND recent.unsent=0 ' +
      'AND recent.content_type=0 AND recent.text IS NOT NULL AND trim(recent.text)<>\'\' ' +
      'ORDER BY recent.ts DESC,recent.msg_id DESC LIMIT ?) ' +
      'AND NOT EXISTS (SELECT 1 FROM topic_message_decisions d WHERE d.chat_id=m.chat_id AND d.msg_id=m.msg_id) ' +
      'ORDER BY m.ts,m.msg_id LIMIT ?'
    ).all('bound-70', 'bound-70', 100, 20)
    const planText = recentPlan.concat(exactPlan, topicPlan).map((row) => row.detail).join('\n')
    assert.match(planText, /SEARCH messages/u)
    assert.doesNotMatch(planText, /SCAN messages/u)
    assert.doesNotMatch(topicPlan.map((row) => row.detail).join('\n'), /SCAN m\b/u)
    console.log(JSON.stringify({
      driver: 'better-sqlite3-plugin@13.0.2',
      sqlite: db.prepare('SELECT sqlite_version() AS version').get().version,
      fixture: { chats: 88, attemptedMessages: batch.length + more.length + 1 + wideTextBatch.length },
      limits: {
        perChatRows: SOURCE_ROWS_PER_CHAT_LIMIT,
        perChatTextBytes: SOURCE_TEXT_BYTES_PER_CHAT_LIMIT,
        globalRows: SOURCE_ROWS_GLOBAL_LIMIT,
        globalTextBytes: SOURCE_TEXT_BYTES_GLOBAL_LIMIT,
        cachedChats: SOURCE_CACHED_CHATS_LIMIT,
        globalAppendEvents: SOURCE_APPEND_EVENTS_GLOBAL_LIMIT
      },
      observed: {
        cachedChats: diagnostics.cachedChats,
        cachedRows: diagnostics.cachedRows,
        cachedTextBytes: diagnostics.cachedTextBytes,
        cachedAppendEvents: diagnostics.cachedAppendEvents
      },
      queryPlans: { recent: recentPlan, exact: exactPlan, topicInitialBatch: topicPlan }
    }))
  } finally {
    opened.close()
  }
})

test('GroupTopics v1 conflict preserves duplicate evidence and refuses readiness without cleanup', () => {
  const db = new NativeDatabase(':memory:')
  try {
    db.exec([
      'CREATE TABLE chats(chat_id TEXT PRIMARY KEY);',
      'CREATE TABLE messages(msg_id TEXT PRIMARY KEY);',
      'CREATE TABLE discussion_topics(topic_id TEXT PRIMARY KEY,chat_id TEXT,last_source_ts INTEGER);',
      'CREATE TABLE topic_analysis_runs(run_id TEXT PRIMARY KEY);',
      'CREATE TABLE topic_evidence(topic_id TEXT NOT NULL,msg_id TEXT NOT NULL,relation TEXT,confidence REAL,relevance TEXT,relevance_evidence_msg_ids TEXT,run_id TEXT,PRIMARY KEY(topic_id,msg_id));',
      'INSERT INTO chats VALUES(\'chat-a\');',
      'INSERT INTO messages VALUES(\'msg-1\');',
      'INSERT INTO discussion_topics VALUES(\'topic-1\',\'chat-a\',1);',
      'INSERT INTO discussion_topics VALUES(\'topic-2\',\'chat-a\',2);',
      'INSERT INTO topic_analysis_runs VALUES(\'run-1\');',
      'INSERT INTO topic_evidence VALUES(\'topic-1\',\'msg-1\',\'about\',0.9,\'action\',\'[]\',\'run-1\');',
      'INSERT INTO topic_evidence VALUES(\'topic-2\',\'msg-1\',\'about\',0.8,\'awareness\',\'[]\',\'run-1\');'
    ].join('\n'))
    const before = db.prepare('SELECT topic_id,msg_id,confidence FROM topic_evidence ORDER BY topic_id').all()
    assert.throws(() => ensureGroupTopicsSchema(db), /UNIQUE constraint failed: topic_evidence.msg_id/u)
    assert.deepEqual(db.prepare('SELECT topic_id,msg_id,confidence FROM topic_evidence ORDER BY topic_id').all(), before)
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_topic_evidence_one_topic_per_message'").get(), undefined)
  } finally {
    db.close()
  }
})

test('SourceSessionPolicy: the default stops at 64 requests and 128 KiB per epoch; the rolling (plugin) policy zeroes the counters in place, keeping epoch, window and fingerprint', () => {
  for (const [label, policy] of [['default', null], ['rolling', ROLLING_SOURCE_SESSION_POLICY]]) {
    const opened = openFixture()
    const db = opened.db
    try {
      configureSourceSessionPolicy(db, policy)
      insertMessages([makeMessage('policy-row', 'chat-a', 10)], db)
      const cache = sharedSourceRows(db)
      let lease = acquire(cache, 'chat-a', 'policy-lease-' + label)
      lease = cache.setSessionFingerprint(lease, 'host-model-prompt-v1', FIXED_NOW)
      assert.ok(lease)
      let accepted = 0
      let refused = null
      for (let i = 0; i < 70; i += 1) {
        const result = cache.beginAttempt(lease, 'p', FIXED_NOW)
        if (!result.ok) { refused = result.reason; break }
        accepted += 1
      }
      assert.equal(accepted, 64, label)
      assert.equal(refused, 'request_limit', label + ': the database CHECK bounds the counters, so both policies stop here')
      const before = readChatSourceState(db, 'chat-a')
      if (policy === null) continue
      const rolled = cache.resetSessionCounters(lease, FIXED_NOW)
      assert.ok(rolled)
      const after = readChatSourceState(db, 'chat-a')
      assert.deepEqual([after.submittedRequests, after.submittedUserUtf8Bytes, after.acceptedTurns], [0, 0, 0])
      assert.equal(after.sessionEpoch, before.sessionEpoch, 'the epoch did not move')
      assert.equal(after.sessionFingerprint, before.sessionFingerprint)
      assert.equal(after.windowDigest, before.windowDigest)
      assert.equal(cache.beginAttempt(rolled, 'p', FIXED_NOW).ok, true, 'and the next attempt is accepted')
      const stale = { ...rolled, leaseId: 'someone-else' }
      assert.equal(cache.resetSessionCounters(stale, FIXED_NOW), null, 'only the lease owner can roll the counters')
    } finally { opened.close() }
  }
})

test('SourceSessionPolicy: tainted still rotates the epoch under the unbounded policy (the Host session is not what rotates, the context-reset marker is)', () => {
  const opened = openFixture()
  const db = opened.db
  try {
    configureSourceSessionPolicy(db, ROLLING_SOURCE_SESSION_POLICY)
    insertMessages([makeMessage('taint-row', 'chat-a', 10)], db)
    const cache = sharedSourceRows(db)
    let lease = cache.setSessionFingerprint(acquire(cache, 'chat-a', 'taint-lease-1'), 'host-model-prompt-v1', FIXED_NOW)
    assert.ok(lease)
    assert.equal(cache.releaseLease(lease, false, FIXED_NOW), true)
    assert.equal(cache.taintChat('chat-a', FIXED_NOW), true, 'a chat without a running lease can be marked context-lost')
    const next = cache.setSessionFingerprint(acquire(cache, 'chat-a', 'taint-lease-2'), 'host-model-prompt-v1', FIXED_NOW)
    assert.equal(next.sessionEpoch, lease.sessionEpoch + 1)
    assert.equal(cache.taintChat('chat-a', FIXED_NOW), false, 'a chat with a running lease is never tainted underneath its owner')
  } finally { opened.close() }
})
