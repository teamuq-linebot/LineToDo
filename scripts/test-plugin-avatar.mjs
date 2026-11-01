import assert from 'node:assert/strict'
import test from 'node:test'

import { createPluginAvatars } from '../src/plugin/backend/avatar.ts'
import { openDatabase } from '../src/main/db/database.ts'
import { ensureGroupTopicsSchema } from '../src/main/features/groupTopics/repository.ts'

const profile = (identity, displayName, locator = '/p/profile-token') => ({ identity, displayName, locator, source: 'profile' })
const square = (identity, displayName, locator = '0hSquareHash_token-123') => ({ identity, displayName, locator, source: 'square' })

function harness({ chats = {}, messages = {}, cacheResult = { path: 'avatar-cache/test.jpg', mime: 'image/jpeg', size: 10, cached: false } } = {}) {
  const reads = []
  const cacheCalls = []
  const writes = []
  const service = createPluginAvatars({
    reader: { async read(input) { reads.push(input); return { chats, messages } } },
    cache: { async get(input) { cacheCalls.push(input); return cacheResult } },
    getDb: () => ({
      prepare(sql) { return { run(...args) { writes.push({ sql, args }) } } }
    })
  })
  return { service, reads, cacheCalls, writes }
}

test('batch chat lookup builds official Square URL inside backend and returns only asset path/name', async () => {
  const h = harness({ chats: { room: square('room', 'OpenChat name') } })
  const result = await h.service.prepareChats(['room', 'room'])
  assert.deepEqual(h.reads, [{ chatIds: ['room'] }])
  assert.deepEqual(h.cacheCalls, [{ identity: 'room', locator: 'https://obs.line-scdn.net/0hSquareHash_token-123' }])
  assert.deepEqual(result, { paths: { room: 'avatar-cache/test.jpg' }, names: { room: 'OpenChat name' } })
  assert.equal(h.writes.length, 1)
  assert.match(h.writes[0].sql, /UPDATE chats SET name/)
})

test('ordinary profile locator stays exact and missing cache preserves name with fallback path omitted', async () => {
  const h = harness({ chats: { direct: profile('direct', 'Contact name', '/picture-path') }, cacheResult: null })
  const result = await h.service.prepareChats(['direct'])
  assert.deepEqual(h.cacheCalls, [{ identity: 'direct', locator: '/picture-path' }])
  assert.deepEqual(result, { paths: {}, names: { direct: 'Contact name' } })
})

test('rejects malformed Square hash without constructing a URL', async () => {
  const h = harness({ chats: { room: square('room', 'Room', 'https://attacker.invalid/image') } })
  const result = await h.service.prepareChats(['room'])
  assert.deepEqual(result.paths, {})
  assert.equal(h.cacheCalls.length, 0)
})

test('historical message name enrichment updates only sender display text and leaves processed state alone', async () => {
  const h = harness({ messages: { 'i:42': square('p-sender', 'Square member') } })
  const result = await h.service.prepareMessages('room', ['i:42', 'i:42'])
  assert.deepEqual(h.reads, [{ chatId: 'room', msgIds: ['i:42'] }])
  assert.deepEqual(h.cacheCalls, [{ identity: 'p-sender', locator: 'https://obs.line-scdn.net/0hSquareHash_token-123' }])
  assert.deepEqual(result, { paths: { 'i:42': 'avatar-cache/test.jpg' }, names: { 'i:42': 'Square member' } })
  assert.equal(h.writes.length, 1)
  assert.match(h.writes[0].sql, /UPDATE messages SET sender/)
  assert.doesNotMatch(h.writes[0].sql, /processed|DELETE|UPDATE todos|UPDATE group_topics/u)
})

test('invalid requests and absent source metadata return empty maps without source/data mutation', async () => {
  const h = harness()
  assert.deepEqual(await h.service.prepareChats('not-an-array'), { paths: {}, names: {} })
  assert.deepEqual(await h.service.prepareMessages('', ['i:1']), { paths: {}, names: {} })
  assert.equal(h.reads.length, 0)
  assert.equal(h.cacheCalls.length, 0)
  assert.equal(h.writes.length, 0)
})

test('historical display refresh enriches only names and preserves processed messages, todos, topics and ids', async () => {
  const opened = openDatabase({ dbPath: ':memory:' })
  const db = opened.db
  try {
    const chatId = 'square-chat'
    const now = new Date('2026-10-30T00:00:00.000Z').toISOString()
    db.prepare('INSERT INTO chats(chat_id,name,is_group,blocked,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?)')
      .run(chatId, chatId, 1, 0, now, now)
    db.prepare(`INSERT INTO messages(msg_id,chat_id,ts,time_iso,direction,sender,text,content_type,processed,ingested_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run('i:42', chatId, Date.parse(now), now, 'in', '未知發話者', 'preserved source text', 0, 1, now)
    db.prepare(`INSERT INTO messages(msg_id,chat_id,ts,time_iso,direction,sender,text,content_type,processed,ingested_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run('i:43', chatId, Date.parse(now) + 1, now, 'in', 'another sender', 'unprocessed control', 0, 0, now)
    db.prepare(`INSERT INTO todos(id,chat_id,bucket,status,title,source_msg_ids,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run('todo-canonical', chatId, 'todo', 'pending', 'Keep this todo', '["i:42"]', now, now)
    ensureGroupTopicsSchema(db)
    db.prepare(`INSERT INTO discussion_topics(topic_id,chat_id,local_ref,title,summary,created_at,last_source_ts)
      VALUES(?,?,?,?,?,?,?)`).run('topic-canonical', chatId, 'fixture-ref', 'Keep this topic', 'summary', now, Date.parse(now))
    const before = {
      processed: db.prepare('SELECT processed FROM messages WHERE msg_id=?').get('i:42').processed,
      unprocessedCount: db.prepare('SELECT count(*) AS n FROM messages WHERE processed=0').get().n,
      todo: db.prepare('SELECT id,title,status FROM todos WHERE id=?').get('todo-canonical'),
      topic: db.prepare('SELECT topic_id,title,summary FROM discussion_topics WHERE topic_id=?').get('topic-canonical'),
      cache: db.prepare('SELECT source_epoch,append_seq FROM chat_context_cache WHERE chat_id=?').get(chatId)
    }
    const service = createPluginAvatars({
      reader: { async read(input) {
        if (input.chatIds) return { chats: { [chatId]: square(chatId, 'Verified Square name') }, messages: {} }
        return { chats: {}, messages: { 'i:42': square('p-member', 'Verified member name') } }
      } },
      cache: { async get() { return null } },
      getDb: () => db
    })
    const chatRefresh = await service.prepareChats([chatId])
    const messageRefresh = await service.prepareMessages(chatId, ['i:42'])
    const after = {
      processed: db.prepare('SELECT processed FROM messages WHERE msg_id=?').get('i:42').processed,
      unprocessedCount: db.prepare('SELECT count(*) AS n FROM messages WHERE processed=0').get().n,
      todo: db.prepare('SELECT id,title,status FROM todos WHERE id=?').get('todo-canonical'),
      topic: db.prepare('SELECT topic_id,title,summary FROM discussion_topics WHERE topic_id=?').get('topic-canonical'),
      cache: db.prepare('SELECT source_epoch,append_seq FROM chat_context_cache WHERE chat_id=?').get(chatId)
    }
    assert.equal(chatRefresh.names[chatId], 'Verified Square name')
    assert.equal(messageRefresh.names['i:42'], 'Verified member name')
    assert.equal(db.prepare('SELECT name FROM chats WHERE chat_id=?').get(chatId).name, 'Verified Square name')
    assert.equal(db.prepare('SELECT sender,text FROM messages WHERE msg_id=?').get('i:42').sender, 'Verified member name')
    assert.equal(db.prepare('SELECT text FROM messages WHERE msg_id=?').get('i:42').text, 'preserved source text')
    assert.equal(after.processed, before.processed)
    assert.equal(after.unprocessedCount, before.unprocessedCount, 'refresh does not create additional AI-eligible rows')
    assert.deepEqual(after.todo, before.todo)
    assert.deepEqual(after.topic, before.topic)
    assert.equal(after.cache.append_seq, before.cache.append_seq)
    assert.ok(after.cache.source_epoch > before.cache.source_epoch, 'display sender repair invalidates the stale source-context digest')
    assert.equal('pipeline' in service, false, 'metadata refresh has no AI/pipeline dependency')
  } finally {
    opened.close()
  }
})
