// Phase 2 — unit tests for the plugin backend building blocks, run on plain Node 24 with the node:sqlite test adapter
// (the real better-sqlite3 13.0.2 / WASM / koffi / 1.6.8-permission path is exercised by test-backend-contract.mjs):
//   * ExtractQueue + runOnce(extractSink): supply (outbox) and receive (inbox), parity with the standalone apply path (0.2.0: the consumer is the in-process ExtractWorker; here the tests act as the consumer on the queue directly)
//   * EventHub: seq/replay/gap/long-poll/capability session
//   * Dispatcher: allow-list routing, unsupported paths, 64 KiB chunking, soft-deadline jobs
//   * createPluginBackend: the whole assembly on a fake LINE port (no koffi, no WASM)
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULTS } from '../../src/main/config/defaults.ts'
import { openDatabase } from '../../src/main/db/database.ts'
import { getUnprocessedForPipeline, insertMessages } from '../../src/main/db/messages.repo.ts'
import { getLastRun } from '../../src/main/db/pipeline.repo.ts'
import { createTodo, listTodos } from '../../src/main/db/todos.repo.ts'
import { readChatSourceState } from '../../src/main/db/sourceCache.ts'
import { EXTRACT_SYSTEM_PROMPT, buildUserPayload } from '../../src/main/llm/extractPrompt.ts'
import { runOnce } from '../../src/main/pipeline/runOnce.ts'
import { fixedWatchSource } from '../../src/main/pipeline/scheduler.ts'
import { Dispatcher, SUPPORTED_API_PATHS, UNSUPPORTED_API_PATHS } from '../../src/plugin/backend/dispatcher.ts'
import { EVENTS_CAPABILITY, EventHub, compactPayload } from '../../src/plugin/backend/eventHub.ts'
import { EXTRACT_SYSTEM_SHA256, ExtractQueue, partitionExtractInput } from '../../src/plugin/backend/extractQueue.ts'
import { createPluginBackend } from '../../src/plugin/backend/assemble.ts'
import { AI_SESSION_MAP_KEY_PREFIX, AiSessionMapStoreError, createAiSessionMapStore } from '../../src/plugin/backend/aiSessionMapStore.ts'
import { createExtractWorker } from '../../src/plugin/backend/extractWorker.ts'
import { createChatPromptStore } from '../../src/plugin/backend/chatPromptStore.ts'
import { createPromptService } from '../../src/plugin/backend/promptService.ts'
import { createSettingsStore } from '../../src/main/config/settings.ts'
import { createHostAiPort } from '../../src/plugin/backend/hostAi.ts'
import { BACKEND_METHOD_GROUPS, backendMethodFor } from '../../src/shared/pluginWire.ts'
import { createMockTuqAi } from '../lib/mock-tuq-ai.mjs'

// ───────────── helpers ─────────────

function raw(i, { chatId = 'u-alice', chat = 'Alice', isGroup = false, text, ts } = {}) {
  const t = ts ?? 1_700_000_000_000 + i * 1000
  return { msgId: `m${i}`, chat, chatId, isGroup, ts: t, time: new Date(t).toISOString(), direction: 'in', sender: chat, text: text ?? `請幫我處理第 ${i} 件事情，明天要交`, contentType: 0 }
}

function freshDb() {
  return openDatabase({ dbPath: ':memory:' })
}

const config = { ...DEFAULTS, concurrency: 2 }

function makeQueue(db, extra = {}) {
  const runs = []
  const pendings = []
  let clock = 1_000_000
  const queue = new ExtractQueue({
    db, getConfig: () => config, onRun: (r) => runs.push(r), onPending: (p) => pendings.push(p), now: () => clock,
    retryBaseMs: 1000, retryMaxMs: 60_000, leaseMs: 5000, ...extra
  })
  return { queue, runs, pendings, advance: (ms) => { clock += ms }, now: () => clock }
}

async function cycle(db, queue, messages) {
  const unusedExtract = async () => { throw new Error('extractFn must not be called in sink mode') }
  return runOnce({ db, config, watchSource: fixedWatchSource(messages), extractFn: unusedExtract, extractSink: queue })
}

const okResult = (msgIds, title = '回覆報價單') => ({
  importance: 'action',
  newTodos: [{ draftRef:`draft_${String(msgIds[0]??'none').replace(/[^a-z0-9_-]/giu,'_')}`, bucket: 'todo', title, detail: null, priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds: msgIds.slice(0, 1) }],
  identityDecisions: msgIds.length ? [{ draftRef:`draft_${String(msgIds[0]).replace(/[^a-z0-9_-]/giu,'_')}`,outcome:'new',candidateType:null,candidateId:null,relationKind:null,reasonCode:'insufficient_evidence',confidenceBand:'high',evidenceMsgIds:msgIds.slice(0,1)}] : [],
  resolved: [], updates: []
})

const stable = (todos) => todos.map((t) => ({ chatId: t.chatId, bucket: t.bucket, status: t.status, title: t.title, priority: t.priority, sourceMsgIds: t.sourceMsgIds })).sort((a, b) => (a.title + a.chatId).localeCompare(b.title + b.chatId))

test('AI session map uses hashed chat keys in existing app_settings and survives a new store adapter', async () => {
  const { db } = freshDb()
  const first = createAiSessionMapStore({ getDatabase: () => db })
  const chatId = 'u-alice'
  const record = { chatId, hostSessionId: '42', effective: { providerId: 'codex', modelId: 'gpt-6-luna', effort: 'medium' }, continuityFingerprint: 'a'.repeat(64) }
  try {
    await first.put(record)
    const key = `${AI_SESSION_MAP_KEY_PREFIX}${createHash('sha256').update(chatId, 'utf8').digest('hex')}`
    const row = db.prepare('SELECT key, value FROM app_settings WHERE key = ?').get(key)
    assert.equal(row.key, key)
    assert.deepEqual(JSON.parse(row.value), { schemaVersion: 1, ...record })
    assert.deepEqual(await createAiSessionMapStore({ getDatabase: () => db }).get(chatId), record)
    await first.put({ ...record, hostSessionId: '43' })
    assert.equal((await first.get(chatId)).hostSessionId, '43', 'upsert replaces only this chat mapping')
    await first.remove(chatId)
    assert.equal(await first.get(chatId), null)
    db.prepare('INSERT INTO app_settings(key, value) VALUES (?, ?)').run(key, JSON.stringify({ schemaVersion: 1, ...record, chatId: 'u-bob' }))
    await assert.rejects(first.get(chatId), (error) => error instanceof AiSessionMapStoreError && error.code === 'corrupt')
  } finally {
    db.close()
  }
})

// ───────────── partitionExtractInput ─────────────

function inputOf(messages, extra = {}) {
  return {
    now: '2026-10-01T10:00:00.000', chat: { chatId: 'u-alice', name: 'Alice', isGroup: false },
    newMessages: messages, recentContext: [], openTodos: [], ...extra
  }
}
const id = (n) => `i:m${n}` // deriveMsgId() prefixes the LINE message id
const dto = (i, text) => ({ msgId: `m${i}`, chatId: 'u-alice', ts: 1_700_000_000_000 + i, timeIso: new Date(1_700_000_000_000 + i).toISOString(), direction: 'in', sender: 'Alice', text, contentType: 0, processed: false, ingestedAt: '', origFilename: null, fileSize: null, unsent: false })

test('partition: a small chat is one part whose payload equals the standalone payload', () => {
  const msgs = [dto(1, '你好'), dto(2, '明天開會')]
  const parts = partitionExtractInput(inputOf(msgs), { maxChars: 7500, contextLimit: 10 })
  assert.equal(parts.length, 1)
  assert.deepEqual(parts[0].msgIds, ['m1', 'm2'])
  assert.equal(parts[0].user, buildUserPayload(inputOf(msgs)))
})

test('partition: a long chat is split into parts that each fit the budget and cover every message exactly once, in order', () => {
  const msgs = Array.from({ length: 60 }, (_, i) => dto(i, `第${i}則：` + '很長的訊息內容'.repeat(25)))
  const context = [dto(900, '先前的上下文一'), dto(901, '先前的上下文二')]
  const parts = partitionExtractInput(inputOf(msgs, { recentContext: context }), { maxChars: 3000, contextLimit: 3 })
  assert.ok(parts.length > 4, `expected several parts, got ${parts.length}`)
  assert.deepEqual(parts.flatMap((p) => p.msgIds), msgs.map((m) => m.msgId))
  for (const p of parts) {
    assert.ok(p.user.length <= 3000, `part payload ${p.user.length} chars`)
    const parsed = JSON.parse(p.user)
    assert.deepEqual(parsed.newMessages.map((m) => m.msgId), p.msgIds)
    assert.ok(parsed.recentContext.length <= 3)
  }
  // the second part's context is the tail of the first part
  const first = JSON.parse(parts[0].user)
  const second = JSON.parse(parts[1].user)
  assert.equal(second.recentContext.at(-1).msgId, first.newMessages.at(-1).msgId)
})

test('partition: one oversized message shrinks the context first, then its own text', () => {
  const huge = dto(1, '字'.repeat(20_000))
  const parts = partitionExtractInput(inputOf([huge], { recentContext: [dto(7, '上下文'.repeat(50))] }), { maxChars: 3000, contextLimit: 5 })
  assert.equal(parts.length, 1)
  assert.ok(parts[0].user.length <= 3000)
  assert.equal(parts[0].truncated, 1)
  assert.deepEqual(parts[0].msgIds, ['m1'])
  assert.equal(JSON.parse(parts[0].user).recentContext.length, 0)
})

test('partition: open todos that would eat the budget are cut to a prefix', () => {
  const openTodos = Array.from({ length: 200 }, (_, i) => ({ id: `t${i}`, chatId: 'u-alice', bucket: 'todo', status: 'pending', title: `待辦事項 ${i} `.repeat(4), detail: null, priority: 2, dueAt: null, sourceMsgIds: [], confidence: 1, completionEvidence: null, createdAt: '', updatedAt: '', resolvedAt: null }))
  const parts = partitionExtractInput(inputOf([dto(1, 'hi')], { openTodos }), { maxChars: 3000, contextLimit: 5 })
  assert.ok(parts[0].user.length <= 3000)
  const kept = JSON.parse(parts[0].user).openTodos
  assert.ok(kept.length > 0 && kept.length < 200)
  assert.deepEqual(kept.map((t) => t.todoId), openTodos.slice(0, kept.length).map((t) => t.id))
})

test('ExtractQueue leases current source text, selected rows and open todos, and accounts each repair payload once', async () => {
  const { db } = freshDb()
  const { queue } = makeQueue(db)
  try {
    await cycle(db, queue, [raw(901, { chatId: 'u-alice', text: '請處理這項新訊息' })])
    db.prepare('UPDATE messages SET text=? WHERE chat_id=? AND msg_id=?').run('來源在佇列等待期間已更新', 'u-alice', id(901))
    const latest = createTodo({ chatId: 'u-alice', bucket: 'todo', status: 'pending', title: '供料後才新增的既有代辦', sourceMsgIds: [], confidence: 1 }, db)
    const pulled = queue.pull({ max: 1 })
    assert.equal(pulled.items.length, 1)
    const item = pulled.items[0]
    const payload = JSON.parse(item.user)
    assert.equal(item.chatId, 'u-alice')
    assert.equal(payload.openTodos.some((todo) => todo.todoId === latest.id && todo.title === latest.title), true)
    assert.deepEqual(payload.newMessages.map((message) => message.msgId), [id(901)])
    assert.equal(payload.newMessages[0].text, '來源在佇列等待期間已更新', 'the leased model text is hydrated from the current source row')
    assert.equal(typeof item.sessionEpoch, 'number')
    assert.equal(typeof item.onAdditionalUserPayload, 'function')
    const beforeRepair=readChatSourceState(db,'u-alice')
    assert.equal(beforeRepair.submittedRequests,1)
    assert.equal(item.onAdditionalUserPayload('repair input bytes'),true)
    const afterRepair=readChatSourceState(db,'u-alice')
    assert.equal(afterRepair.submittedRequests,2)
    assert.equal(afterRepair.submittedUserUtf8Bytes,Buffer.byteLength(item.user,'utf8')+Buffer.byteLength('repair input bytes','utf8'))
    const committed = queue.commit({ results: [{ itemId: item.itemId, ok: true, result: { importance: 'noise', newTodos: [], identityDecisions: [], resolved: [], updates: [] } }] })
    assert.equal(committed.results[0].status, 'applied')
    assert.equal(queue.stats().leased, 0)
  } finally {
    queue.dispose()
    db.close()
  }
})

// ───────────── ExtractQueue + runOnce ─────────────

test('runOnce: explicit identity decisions keep distinct same-title drafts and update only the supplied canonical ID', async () => {
  const { db } = freshDb()
  const newTodo = (draftRef,title, sourceMsgIds) => ({
    draftRef,
    bucket: 'todo', title, detail: null, priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds
  })
  const firstMessages = [raw(101), raw(102), raw(103)]
  const first = await runOnce({
    db,
    config,
    watchSource: fixedWatchSource(firstMessages),
    extractFn: async (input) => ({
      importance: 'action',
      newTodos: [
        newTodo('draft_quote_a','回覆報價單', [input.newMessages[0].msgId]),
        newTodo('draft_quote_b','回覆 報價單！', [input.newMessages[1].msgId]),
        newTodo('draft_weekly','更新週報', [input.newMessages[2].msgId])
      ],
      identityDecisions:input.newMessages.map((message,index)=>({draftRef:['draft_quote_a','draft_quote_b','draft_weekly'][index],outcome:'new',candidateType:null,candidateId:null,relationKind:null,reasonCode:'distinct_action',confidenceBand:'high',evidenceMsgIds:[message.msgId]})),
      resolved: [],
      updates: []
    })
  })

  assert.equal(first.todosCreated, 3)
  assert.equal(first.todosMerged, 0,'normalized title equality alone does not merge distinct drafts')
  const initialTodos = listTodos({}, db)
  assert.equal(initialTodos.length, 3)
  const mergedTodo = initialTodos.find((todo) => todo.title === '回覆報價單')
  const completionTarget = initialTodos.find((todo) => todo.title === '更新週報')
  const otherSimilarTitle = initialTodos.find((todo) => todo.title === '回覆 報價單！')
  assert.ok(mergedTodo)
  assert.ok(completionTarget)
  assert.ok(otherSimilarTitle)
  assert.notEqual(mergedTodo.id,otherSimilarTitle.id)
  assert.deepEqual(mergedTodo.sourceMsgIds, [id(101)])
  assert.deepEqual(otherSimilarTitle.sourceMsgIds,[id(102)])

  const second = await runOnce({
    db,
    config,
    watchSource: fixedWatchSource([raw(104,{text:'回覆報價單的預約移到週五，也請通知團隊'})]),
    extractFn: async (input) => ({
      importance: 'action',
      newTodos: [
        newTodo('draft_quote_reschedule','回覆報價單。', [input.newMessages[0].msgId]),
        newTodo('draft_notify','通知團隊', [input.newMessages[0].msgId])
      ],
      identityDecisions:[
        {draftRef:'draft_quote_reschedule',outcome:'update_existing',candidateType:'todo',candidateId:mergedTodo.id,relationKind:null,reasonCode:'reschedule',confidenceBand:'high',evidenceMsgIds:[input.newMessages[0].msgId]},
        {draftRef:'draft_notify',outcome:'new',candidateType:null,candidateId:null,relationKind:null,reasonCode:'distinct_action',confidenceBand:'high',evidenceMsgIds:[input.newMessages[0].msgId]}
      ],
      resolved: [{ todoId: completionTarget.id, evidence: '已寄出',evidenceMsgIds:[input.newMessages[0].msgId] }],
      updates: []
    })
  })

  assert.equal(second.todosCreated, 1, 'a new distinct title is still created')
  assert.equal(second.todosMerged, 1, 'an existing open todo still absorbs a matching result')
  assert.equal(second.todosResolvedDone, 1, 'existing completion handling still applies')
  const finalTodos = listTodos({}, db)
  assert.equal(finalTodos.length, 4)
  const updatedMergedTodo = finalTodos.find((todo) => todo.id === mergedTodo.id)
  assert.deepEqual(updatedMergedTodo.sourceMsgIds, [id(101), id(104)])
  assert.deepEqual(finalTodos.find((todo)=>todo.id===otherSimilarTitle.id).sourceMsgIds,[id(102)])
  assert.equal(finalTodos.find((todo) => todo.id === completionTarget.id).status, 'done')
  assert.ok(finalTodos.some((todo) => todo.title === '通知團隊'))
})

test('supply: runOnce in sink mode stops before extractFn, keeps messages unprocessed, and offers one item per chat', async () => {
  const { db } = freshDb()
  const { queue, pendings } = makeQueue(db)
  const result = await cycle(db, queue, [raw(1), raw(2), raw(3, { chatId: 'u-bob', chat: 'Bob' })])
  assert.equal(result.newMsgs, 3)
  assert.equal(result.chatsSeen, 2)
  assert.equal(result.chatsSkipped, 2, 'deferred chats are counted as skipped')
  assert.equal(result.chatsFailed, 0)
  assert.equal(result.llmStatus, 'ok')
  assert.equal(result.todosCreated, 0)
  assert.equal(getUnprocessedForPipeline(100, db).length, 3, 'messages stay unprocessed until the inbox commits')
  assert.deepEqual(queue.stats(), { pending: 2, leased: 0, awaiting: 0, chatsBackingOff: 0, gen: 1 })
  assert.deepEqual(pendings, [{ pending: 2 }])

  const pulled = queue.pull({ max: 10 })
  assert.equal(pulled.items.length, 2)
  assert.equal(pulled.systemSha256, EXTRACT_SYSTEM_SHA256)
  assert.equal(EXTRACT_SYSTEM_PROMPT.length > 1000, true)
  for (const item of pulled.items) {
    const payload = JSON.parse(item.user)
    assert.equal(payload.chat.chatId, item.chatId)
    assert.equal(item.messageCount, payload.newMessages.length)
    assert.ok(item.userChars <= 7500)
  }
  assert.equal(queue.pull().items.length, 0, 'leased items are not handed out twice')
})

test('supply: re-offering the same backlog every cycle neither duplicates items nor spams onPending; a chat that disappears is dropped', async () => {
  const { db } = freshDb()
  const { queue, pendings } = makeQueue(db)
  await cycle(db, queue, [raw(1), raw(2)])
  await cycle(db, queue, [])
  await cycle(db, queue, [])
  assert.equal(queue.stats().pending, 1)
  assert.equal(pendings.length, 1, 'the pending set did not change, so there is a single notification')
  // the chat gets blocked (messages no longer returned by getUnprocessedForPipeline) -> the next cycle drops it
  db.prepare('UPDATE chats SET blocked = 1').run()
  await cycle(db, queue, [])
  assert.equal(queue.stats().pending, 0)
})

test('receive: a valid result is applied with the same logic as standalone; messages become processed; a pipeline run is recorded and reported', async () => {
  const { db } = freshDb()
  const { queue, runs } = makeQueue(db)
  await cycle(db, queue, [raw(1), raw(2)])
  const { items } = queue.pull()
  const committed = queue.commit({ results: [{ itemId: items[0].itemId, ok: true, result: okResult([id(1), id(2)]) }] })
  assert.equal(committed.results[0].status, 'applied')
  assert.equal(committed.results[0].createdIds.length, 1)
  assert.equal(committed.run.todosCreated, 1)
  assert.equal(getUnprocessedForPipeline(100, db).length, 0)
  assert.deepEqual(stable(listTodos({}, db)), [{ chatId: 'u-alice', bucket: 'todo', status: 'pending', title: '回覆報價單', priority: 2, sourceMsgIds: [id(1)] }])
  assert.equal(runs.length, 1)
  assert.deepEqual(runs[0].createdIds, committed.results[0].createdIds)
  assert.equal(runs[0].llmStatus, 'ok')
  const last = getLastRun(db)
  assert.equal(last.todosCreated, 1)
  assert.equal(last.llmStatus, 'ok')
  assert.equal(queue.stats().pending + queue.stats().leased, 0)
})

test('receive: malformed results are rejected (zod), the chat backs off, the messages stay unprocessed and retry later', async () => {
  const { db } = freshDb()
  const { queue, advance, runs } = makeQueue(db)
  const bad = [
    { importance: 'urgent', newTodos: [], resolved: [] }, // enum
    { importance: 'action', newTodos: [{ bucket: 'todo', title: '', priority: 2, confidence: 0.5, sourceMsgIds: ['m1'] }], resolved: [] }, // empty title
    { importance: 'action', newTodos: [{ bucket: 'todo', title: 'x', priority: 9, confidence: 0.5, sourceMsgIds: ['m1'] }], resolved: [] }, // priority
    { importance: 'action', newTodos: [{ bucket: 'todo', title: 'x', priority: 1, confidence: 0.5, sourceMsgIds: [] }], resolved: [] }, // no source
    { importance: 'action', newTodos: [{ bucket: 'todo', title: 'x', priority: 1, confidence: 7, sourceMsgIds: ['m1'] }], resolved: [] }, // confidence range
    'not json', null, [], { newTodos: 'x' }
  ]
  for (const [index, value] of bad.entries()) {
    advance(30 * 60_000) // past any backoff
    await cycle(db, queue, [index === 0 ? raw(1) : null].filter(Boolean))
    const pulled = queue.pull()
    assert.equal(pulled.items.length, 1, `case ${index}: the chat is offered again`)
    const res = queue.commit({ results: [{ itemId: pulled.items[0].itemId, ok: true, result: value }] })
    assert.equal(res.results[0].status, 'rejected', `case ${index}`)
    assert.equal(res.results[0].code, 'invalid_result')
    assert.ok(res.results[0].issues.length > 0)
    assert.equal(res.run, null, 'a rejected result never creates a run or a todo')
    assert.ok(res.results[0].retryInMs >= 1000)
  }
  assert.equal(listTodos({}, db).length, 0)
  assert.equal(getUnprocessedForPipeline(100, db).length, 1, 'rejected results never mark messages processed')
  assert.equal(runs.length, 0)
  assert.equal(queue.stats().chatsBackingOff, 1)
})

test('receive: failures back off exponentially per chat and a later success clears the memory', async () => {
  const { db } = freshDb()
  const { queue, advance } = makeQueue(db)
  await cycle(db, queue, [raw(1)])
  let [item] = queue.pull().items
  let res = queue.commit({ results: [{ itemId: item.itemId, ok: false, failCode: 'rate_limited', retryAfterMs: 0 }] })
  assert.equal(res.results[0].status, 'failed_recorded')
  assert.equal(res.results[0].retryInMs, 1000)
  const blocked = queue.pull()
  assert.equal(blocked.items.length, 0)
  assert.equal(blocked.retryAfterMs, 1000)
  advance(1001)
  ;[item] = queue.pull().items
  assert.equal(item.attempts, 1)
  res = queue.commit({ results: [{ itemId: item.itemId, ok: false, failCode: 'provider_error' }] })
  assert.equal(res.results[0].retryInMs, 2000, 'second failure doubles the delay')
  advance(2001)
  ;[item] = queue.pull().items
  res = queue.commit({ results: [{ itemId: item.itemId, ok: false, failCode: 'quota_exhausted', retryAfterMs: 30_000 }] })
  assert.equal(res.results[0].retryInMs, 30_000, 'a retryAfterMs hint larger than the backoff wins')
  advance(30_001)
  ;[item] = queue.pull().items
  res = queue.commit({ results: [{ itemId: item.itemId, ok: true, result: okResult([id(1)]) }] })
  assert.equal(res.results[0].status, 'applied')
  assert.equal(queue.stats().chatsBackingOff, 0)
  // a hostile failCode is normalised
  await cycle(db, queue, [raw(2)])
  ;[item] = queue.pull().items
  res = queue.commit({ results: [{ itemId: item.itemId, ok: false, failCode: '<script>' }] })
  assert.equal(res.results[0].code, 'ai_failed')
})

test('receive: unknown, stale, duplicated and malformed commit items are refused without touching the DB', async () => {
  const { db } = freshDb()
  const { queue, advance } = makeQueue(db)
  await cycle(db, queue, [raw(1)])
  const [item] = queue.pull().items
  const first = queue.commit({ results: [{ itemId: item.itemId, ok: true, result: okResult([id(1)]) }, { itemId: 'nope', ok: true, result: okResult([id(1)]) }, { ok: true }, { itemId: 'x', ok: 'yes' }] })
  assert.deepEqual(first.results.map((r) => r.status), ['applied', 'unknown_item', 'bad_request', 'bad_request'])
  const again = queue.commit({ results: [{ itemId: item.itemId, ok: true, result: okResult([id(1)]) }] })
  assert.equal(again.results[0].status, 'unknown_item', 'a committed lease cannot be committed twice')
  assert.equal(listTodos({}, db).length, 1)

  // lease expiry: the stale id stops working, the chat is handed out again under a new id
  await cycle(db, queue, [raw(2)])
  const [a] = queue.pull().items
  advance(6000)
  const [b] = queue.pull().items
  assert.notEqual(a.itemId, b.itemId)
  assert.equal(queue.commit({ results: [{ itemId: a.itemId, ok: true, result: okResult([id(2)]) }] }).results[0].status, 'unknown_item')
  assert.equal(queue.commit({ results: [{ itemId: b.itemId, ok: true, result: okResult([id(2)], '另一件事') }] }).results[0].status, 'applied')
})

test('receive: messages that arrive while a lease is out are offered separately; in-flight messages are never duplicated', async () => {
  const { db } = freshDb()
  const { queue } = makeQueue(db)
  await cycle(db, queue, [raw(1), raw(2)])
  const [leased] = queue.pull().items
  await cycle(db, queue, [raw(3), raw(4)])
  const next = queue.pull()
  assert.equal(next.items.length, 0, 'one part per chat at a time: the chat is busy until its lease is resolved')
  queue.commit({ results: [{ itemId: leased.itemId, ok: true, result: okResult([id(1), id(2)]) }] })
  assert.deepEqual(getUnprocessedForPipeline(100, db).map((m) => m.msgId), [id(3), id(4)])
  await cycle(db, queue, [])
  const [fresh] = queue.pull().items
  assert.deepEqual(JSON.parse(fresh.user).newMessages.map((m) => m.msgId), [id(3), id(4)])
})

test('receive: resolved / updates go through the shared apply logic (parity with standalone runOnce)', async () => {
  // path A: standalone runOnce with an inline extractFn
  const a = freshDb().db
  const script = [
    (input) => okResult(input.newMessages.map((m) => m.msgId)),
    (input) => ({ importance: 'action', newTodos: [], identityDecisions:[], resolved: input.openTodos.map((t) => ({ todoId: t.id, evidence: '對方已完成',evidenceMsgIds:[input.newMessages[0].msgId] })), updates: [] })
  ]
  let n = 0
  for (const batch of [[raw(1), raw(2)], [raw(3)]]) {
    await runOnce({ db: a, config, watchSource: fixedWatchSource(batch), extractFn: async (input) => script[n++](input) })
  }
  // path B: sink mode, UI answers with the same results
  const b = freshDb().db
  const { queue } = makeQueue(b)
  for (const [i, batch] of [[raw(1), raw(2)], [raw(3)]].entries()) {
    await cycle(b, queue, batch)
    const [item] = queue.pull().items
    const input = { newMessages: batch.map((m) => ({ msgId: id(m.msgId.slice(1)) })), openTodos: listTodos({}, b).filter((t) => t.status === 'pending') }
    const res = queue.commit({ results: [{ itemId: item.itemId, ok: true, result: script[i](input) }] })
    assert.equal(res.results[0].status, 'applied')
  }
  assert.deepEqual(stable(listTodos({}, b)), stable(listTodos({}, a)))
  assert.equal(listTodos({}, b)[0].status, 'done')
  assert.equal(getUnprocessedForPipeline(10, b).length, 0)
})

test('receive: a large chat is delivered in parts, one at a time; all parts commit; every message ends processed', async () => {
  const { db } = freshDb()
  const { queue } = makeQueue(db, { maxUserChars: 2500 })
  const messages = Array.from({ length: 40 }, (_, i) => raw(i + 1, { text: `訊息${i + 1}：` + '很長的內容'.repeat(30) }))
  await cycle(db, queue, messages)
  const total = queue.stats().pending
  assert.ok(total > 3, `expected the chat to be split, pending=${total}`)
  const seen = []
  for (let guard = 0; guard < 100; guard += 1) {
    await cycle(db, queue, [])
    const pulled = queue.pull()
    if (pulled.items.length === 0) break
    assert.equal(pulled.items.length, 1, 'one part per chat per pull')
    const item = pulled.items[0]
    assert.ok(item.userChars <= 2500)
    const ids = JSON.parse(item.user).newMessages.map((m) => m.msgId)
    seen.push(...ids)
    const res = queue.commit({ results: [{ itemId: item.itemId, ok: true, result: { importance: 'fyi', newTodos: [], identityDecisions:[], resolved: [], updates: [] } }] })
    assert.equal(res.results[0].status, 'applied')
  }
  assert.deepEqual(seen, messages.map((m) => id(m.msgId.slice(1))))
  assert.equal(getUnprocessedForPipeline(100, db).length, 0)
})

test('request(): the same pull/commit channel resolves a synchronous caller with the merged result of all parts; failure rejects; dispose rejects', async () => {
  const { db } = freshDb()
  const { queue } = makeQueue(db, { maxUserChars: 2500 })
  const msgs = Array.from({ length: 30 }, (_, i) => dto(i + 1, `訊息${i + 1}：` + '很長的內容'.repeat(30)))
  const promise = queue.request(inputOf(msgs))
  const parts = []
  for (let guard = 0; guard < 50 && queue.stats().awaiting > 0; guard += 1) {
    const { items } = queue.pull()
    if (items.length === 0) break
    parts.push(items[0])
    queue.commit({ results: [{ itemId: items[0].itemId, ok: true, result: okResult(JSON.parse(items[0].user).newMessages.map((m) => m.msgId), `事項 ${parts.length}`) }] })
  }
  const merged = await promise
  assert.ok(parts.length > 2)
  assert.equal(merged.newTodos.length, parts.length)
  assert.equal(getUnprocessedForPipeline(10, db).length, 0, 'awaited results are returned to the caller, not applied by the queue')
  assert.equal(listTodos({}, db).length, 0)

  const failing = queue.request(inputOf([dto(1, 'hi')]))
  const [item] = queue.pull().items
  queue.commit({ results: [{ itemId: item.itemId, ok: false, failCode: 'provider_error' }] })
  await assert.rejects(failing, /provider_error/)

  const waiting = queue.request(inputOf([dto(2, 'hi again')]))
  queue.dispose()
  await assert.rejects(waiting, /disposed/)
  assert.deepEqual(queue.stats(), { pending: 0, leased: 0, awaiting: 0, chatsBackingOff: 0, gen: 0 })
})

test('request(): an awaiting caller times out instead of hanging forever', async () => {
  const { db } = freshDb()
  const { queue } = makeQueue(db, { awaitTimeoutMs: 20 })
  await assert.rejects(queue.request(inputOf([dto(1, 'hi')])), /extract_await_timeout/)
  assert.equal(queue.stats().awaiting, 0)
  queue.dispose()
})

test('ExtractQueue.progress renews a long supported lease so a newly acquired queue lease does not cause a false stall timeout',async()=>{
  const {db}=freshDb()
  const timers=[]
  const {queue,advance}=makeQueue(db,{awaitTimeoutMs:1000,schedule:(fn,ms)=>{const timer={fn,ms,cancelled:false};timers.push(timer);return()=>{timer.cancelled=true}}})
  try{
    const waiting=queue.request(inputOf([dto(930,'合成長作業仍在進行')]))
    const item=queue.pull({max:1,leaseMs:5000}).items[0]
    assert.ok(item)
    advance(900);queue.progress(item.itemId)
    const first=timers.find((timer)=>!timer.cancelled);first.fn()
    assert.equal(queue.stats().awaiting,1,'progress refreshed the stall clock instead of rejecting the in-flight caller')
    advance(900);queue.progress(item.itemId)
    const latest=timers.filter((timer)=>!timer.cancelled).at(-1);latest.fn()
    assert.equal(queue.stats().awaiting,1)
    queue.commit({results:[{itemId:item.itemId,ok:true,result:{importance:'noise',newTodos:[],identityDecisions:[],resolved:[],updates:[]}}]})
    const result=await waiting
    assert.equal(result.importance,'noise')
  }finally{queue.dispose();db.close()}
})

// ───────────── EventHub ─────────────

test('hub: publish / open / pull use afterSeq (a lost response can be re-pulled without loss or duplicates)', async () => {
  const hub = new EventHub()
  hub.publish('a', { n: 1 })
  const opened = hub.open({})
  assert.equal(opened.ok, true)
  assert.equal(opened.seq, 1, 'a session that does not ask for a replay only sees new events')
  hub.publish('b', { n: 2 })
  hub.publish('c', { n: 3 })
  const first = await hub.pull({ sessionId: opened.sessionId, afterSeq: opened.seq })
  assert.deepEqual(first.events.map((e) => [e.seq, e.type]), [[2, 'b'], [3, 'c']])
  const replay = await hub.pull({ sessionId: opened.sessionId, afterSeq: opened.seq })
  assert.deepEqual(replay.events.map((e) => e.seq), [2, 3], 'same afterSeq -> same events')
  const next = await hub.pull({ sessionId: opened.sessionId, afterSeq: first.seq })
  assert.deepEqual(next.events, [])
  assert.equal(next.gap, false)
  hub.dispose()
})

test('hub: replay from a given sinceSeq, and a gap is reported when the ring has rolled past the caller', async () => {
  const hub = new EventHub({ maxEvents: 5 })
  for (let i = 1; i <= 12; i += 1) hub.publish('tick', { i })
  const opened = hub.open({ sinceSeq: 0 })
  assert.equal(opened.oldestSeq, 8)
  const res = await hub.pull({ sessionId: opened.sessionId, afterSeq: 0 })
  assert.equal(res.gap, true)
  assert.deepEqual(res.events.map((e) => e.seq), [8, 9, 10, 11, 12])
  const fine = await hub.pull({ sessionId: opened.sessionId, afterSeq: 7 })
  assert.equal(fine.gap, false)
  hub.dispose()
})

test('hub: a long poll wakes on publish, a newer pull replaces an older waiting one, a timeout returns empty', async () => {
  const hub = new EventHub({ maxWaitMs: 500 })
  const { sessionId, seq } = hub.open({})
  const waiting = hub.pull({ sessionId, afterSeq: seq, waitMs: 400 })
  setTimeout(() => hub.publish('line-message', { text: 'hi' }), 20)
  const woke = await waiting
  assert.equal(woke.events.length, 1)
  assert.ok(woke.seq > seq)
  const older = hub.pull({ sessionId, afterSeq: woke.seq, waitMs: 400 })
  const newer = hub.pull({ sessionId, afterSeq: woke.seq, waitMs: 30 })
  assert.deepEqual((await older).events, [], 'the superseded pull returns immediately')
  assert.deepEqual((await newer).events, [])
  hub.dispose()
})

test('hub: session cap evicts the idlest, unknown sessions are refused, close/dispose release waiting pulls and timers', async () => {
  const hub = new EventHub({ maxSessions: 2, idleMs: 60_000 })
  const a = hub.open({})
  const b = hub.open({})
  const c = hub.open({})
  assert.equal(hub.stats().sessions, 2)
  assert.equal((await hub.pull({ sessionId: a.sessionId, afterSeq: 0 })).code, 'session_not_found')
  assert.equal((await hub.pull({ sessionId: 'x', afterSeq: 0 })).code, 'session_not_found')
  const waiting = hub.pull({ sessionId: c.sessionId, afterSeq: 0, waitMs: 3000 })
  hub.close({ sessionId: c.sessionId })
  assert.equal((await waiting).closed, true)
  hub.dispose()
  assert.equal(hub.stats().sessions, 0)
  assert.equal((await hub.pull({ sessionId: b.sessionId, afterSeq: 0 })).code, 'backend_stopped')
  assert.equal(hub.open({}).code, 'backend_stopped')
})

test('hub: idle sessions expire on their own', async () => {
  const hub = new EventHub({ idleMs: 30 })
  const { sessionId } = hub.open({})
  await new Promise((r) => setTimeout(r, 80))
  assert.equal((await hub.pull({ sessionId, afterSeq: 0 })).code, 'session_not_found')
  hub.dispose()
})

test('hub: oversized event payloads are slimmed, then reduced to an overflow marker', () => {
  const slim = compactPayload({ ids: Array.from({ length: 500 }, (_, i) => `id-${i}`), text: 'x'.repeat(5000) }, 4096)
  assert.equal(slim.truncated, true)
  assert.equal(slim.ids.length, 50)
  assert.ok(slim.text.length <= 601)
  const overflow = compactPayload({ blob: Array.from({ length: 50 }, () => 'y'.repeat(600)) }, 1024)
  assert.equal(overflow.overflow, true)
  assert.equal(compactPayload(undefined, 100), null)
  const circular = {}; circular.self = circular
  assert.equal(compactPayload(circular, 100).overflow, true)
})

test('hub: capability session (openSession) replays, pushes batches within 16 KiB, answers ping, and refuses other capabilities', async () => {
  const hub = new EventHub({ flushMs: 5 })
  hub.publish('seed', { n: 0 })
  const sent = []
  let closed = null
  const channel = { send: (m) => sent.push(m), close: (r) => { closed = r } }
  assert.throws(() => hub.attachChannel({ sessionId: 's0', capability: 'speech', callerPluginId: 'x', options: {} }, channel), (e) => e.code === 'session_unsupported')
  const handler = hub.attachChannel({ sessionId: 's1', capability: EVENTS_CAPABILITY, callerPluginId: 'tuqdev.line-todo', options: { sinceSeq: 0 } }, channel)
  for (let i = 1; i <= 200; i += 1) hub.publish('line-message', { text: `訊息 ${i} `.repeat(20) })
  await new Promise((r) => setTimeout(r, 40))
  const events = sent.filter((m) => m.type === 'events').flatMap((m) => m.events)
  assert.equal(events.length, 201)
  assert.deepEqual(events.map((e) => e.seq), Array.from({ length: 201 }, (_, i) => i + 1))
  for (const m of sent) assert.ok(Buffer.byteLength(JSON.stringify(m)) <= 16 * 1024, 'every message fits CAPABILITY_LIMITS.messageBytes')
  assert.ok(sent.length < 201 && sent.length > 1, 'events are coalesced into batches')
  handler.message({ type: 'ping' }, undefined)
  assert.equal(sent.at(-1).type, 'pong')
  handler.message({ type: 'resume', sinceSeq: 199 }, undefined)
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(sent.at(-1).events.map((e) => e.seq), [200, 201])
  handler.close('provider_gone')
  hub.publish('after', {})
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(sent.at(-1).events?.some((e) => e.type === 'after') ?? false, false)
  assert.equal(closed, null)
  hub.dispose()
})

test('hub: a channel that the host already closed is dropped on the next send', async () => {
  const hub = new EventHub({ flushMs: 1 })
  const channel = { send: () => { throw Object.assign(new Error('session closed'), { code: 'session_closed' }) }, close: () => undefined }
  hub.attachChannel({ sessionId: 's', capability: EVENTS_CAPABILITY, callerPluginId: 'p', options: {} }, channel)
  hub.publish('x', {})
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(hub.stats().sessions, 0)
  hub.dispose()
})

// ───────────── Dispatcher ─────────────

function fakeApi(overrides = {}) {
  return {
    ping: async () => ({ ok: true, ts: 1, version: 'test' }),
    db: { todos: { list: async (q) => [{ id: 't1', q }], get: async () => null, update: async () => { throw new Error('boom: update failed') } }, chats: { list: async () => [] } },
    pipeline: { runOnce: async () => ({ ok: true }) },
    line: { onMessage: () => () => undefined },
    ...overrides
  }
}
function makeDispatcher(api, extra = {}) {
  const hub = new EventHub()
  const { db } = freshDb()
  const { queue } = makeQueue(db)
  const d = new Dispatcher({ getApi: () => api, hub, queue, info: () => ({ ok: true }), ...extra })
  return { d, hub, queue, dispose: () => { d.dispose(); hub.dispose(); queue.dispose() } }
}
const inv = (d, path, ...args) => d.call(backendMethodFor(path), { path, args })

test('dispatcher: routes allow-listed paths, passes args, and returns in-band envelopes', async () => {
  const { d, dispose } = makeDispatcher(fakeApi())
  assert.deepEqual(await inv(d, 'ping'), { ok: true, value: { ok: true, ts: 1, version: 'test' } })
  assert.deepEqual(await inv(d, 'db.todos.list', { chatId: 'c' }), { ok: true, value: [{ id: 't1', q: { chatId: 'c' } }] })
  assert.deepEqual(await d.call('db.todos', { path: 'db.todos.get', args: ['x'] }), { ok: true, value: null })
  assert.deepEqual(await inv(d, 'db.todos.update'), { ok: false, code: 'api_error', message: 'boom: update failed' })
  assert.equal((await d.call('nope', {})).code, 'method_unknown')
  dispose()
})

test('dispatcher: avatar batches stay in the media group and return only data-scope asset paths/names', async () => {
  const calls = []
  const avatars = {
    prepareChats: async (ids) => { calls.push(['chats', ids]); return { paths: { c1: 'avatar-cache/a.jpg' }, names: { c1: 'Chat name' } } },
    prepareMessages: async (chatId, ids) => { calls.push(['messages', chatId, ids]); return { paths: { 'i:1': 'avatar-cache/b.jpg' }, names: { 'i:1': 'Sender name' } } }
  }
  const { d, dispose } = makeDispatcher(fakeApi(), { avatars })
  assert.deepEqual(await inv(d, 'media.avatar.prepareChats', ['c1']), { ok: true, value: { paths: { c1: 'avatar-cache/a.jpg' }, names: { c1: 'Chat name' } } })
  assert.deepEqual(await inv(d, 'media.avatar.prepareMessages', 'c1', ['i:1']), { ok: true, value: { paths: { 'i:1': 'avatar-cache/b.jpg' }, names: { 'i:1': 'Sender name' } } })
  assert.deepEqual(calls, [['chats', ['c1']], ['messages', 'c1', ['i:1']]])
  dispose()
  const withoutAvatars = makeDispatcher(fakeApi())
  assert.equal((await inv(withoutAvatars.d, 'media.avatar.prepareChats', ['c1'])).code, 'avatar_unavailable')
  withoutAvatars.dispose()
})

test('dispatcher: only allow-listed paths run; prototype tricks, malformed paths, subscriptions and unavailable features are refused', async () => {
  const { d, dispose } = makeDispatcher(fakeApi())
  for (const path of ['__proto__', 'constructor', 'db.todos.constructor', 'db.__proto__.x', 'toString', 'line.onMessage', 'db.todos', 'a..b', '', 'db/todos/list', 'x'.repeat(200)]) {
    // a path with no method group is sent under some valid group: the backend still answers path_unknown
    const r = await d.call(backendMethodFor(path) ?? 'db.todos', { path, args: [] })
    assert.equal(r.ok, false, path)
    assert.equal(r.code, 'path_unknown', path)
  }
  assert.equal((await inv(d, 'groupTopics.list', 'c')).code, 'unavailable', 'allowed path whose feature is disabled in this build')
  assert.equal((await d.call('ping', { path: 'ping', args: 'nope' })).code, 'invalid_args')
  assert.equal((await d.call('ping', { path: 'ping', args: new Array(9).fill(0) })).code, 'invalid_args')
  assert.equal((await d.call('ping', null)).code, 'invalid_args')
  assert.equal((await d.call('ping', { path: 5 })).code, 'invalid_args')
  dispose()
})

test('dispatcher (G-07): the method must be the method group of the path; driver is no group at all; the old single api.invoke is gone', async () => {
  const { d, dispose } = makeDispatcher(fakeApi({ driver: { postDraft: async () => { throw new Error('must not run') } } }))
  // the method groups are the manifest's backendMethods: <= 32, each a valid method name, no duplicates
  assert.ok(BACKEND_METHOD_GROUPS.length <= 32)
  assert.equal(new Set(BACKEND_METHOD_GROUPS).size, BACKEND_METHOD_GROUPS.length)
  for (const group of BACKEND_METHOD_GROUPS) assert.match(group, /^[A-Za-z0-9._@-]{1,64}$/)
  // every path the backend serves (and every path it refuses in-band) belongs to exactly one declared group
  for (const path of [...SUPPORTED_API_PATHS, ...Object.keys(UNSUPPORTED_API_PATHS), 'backend.info', 'review.status', 'tasks.status', 'events.open', 'events.pull', 'events.close', 'extract.stats', 'ai.status', 'ai.options', 'media.prepare', 'media.avatar.prepareChats', 'media.avatar.prepareMessages', 'result.chunk', 'job.poll']) {
    assert.ok(BACKEND_METHOD_GROUPS.includes(backendMethodFor(path)), `${path} has a declared method group`)
  }
  assert.equal(backendMethodFor('db.todos.list'), 'db.todos')
  assert.equal(backendMethodFor('db.messages.count'), 'db.messages')
  assert.equal(backendMethodFor('ping'), 'ping')
  assert.equal(backendMethodFor('pingx'), null, 'a prefix must end at a dot')
  assert.equal(backendMethodFor('driver.postDraft'), null, 'driver is not a group: Core refuses it before the backend (backend_method_not_allowed)')
  for (const method of ['driver', 'api.invoke', 'shell.exec']) assert.equal((await d.call(method, { path: 'driver.postDraft', args: [] })).code, 'method_unknown', method)
  assert.equal((await d.call('db.todos', { path: 'settings.update', args: [{}] })).code, 'method_mismatch', 'settings.update cannot ride on the db.todos permission')
  assert.equal((await d.call('db', { path: 'db.todos.list', args: [] })).code, 'method_unknown', 'db alone is not a group')
  assert.equal((await d.call('pipeline', { path: 'ping', args: [] })).code, 'method_mismatch')
  assert.deepEqual(await d.call('ping', { path: 'ping', args: [] }), { ok: true, value: { ok: true, ts: 1, version: 'test' } })
  dispose()
})

test('dispatcher: CLI/AI provider and Electron-only paths answer unsupported_in_plugin; the three AI features are NOT among them any more (they run in the backend)', async () => {
  const { d, dispose } = makeDispatcher(fakeApi({ driver: { postDraft: async () => { throw new Error('must not run') } } }))
  for (const [path, route] of [
    ['media.open', 'none'], ['media.saveAs', 'none'], ['app.openDataFolder', 'none'], ['db.chats.openOriginal', 'none'],
    ['pipeline.testQwen', 'none'], ['pipeline.testAiProvider', 'none'], ['settings.setApiKey', 'none'], ['settings.clearApiKey', 'none']
  ]) {
    const r = await inv(d, path, 'x')
    assert.equal(r.ok, false, path)
    assert.equal(r.code, 'unsupported_in_plugin', path)
    assert.equal(r.route, route, path)
  }
  for (const path of ['db.todos.draftReply', 'db.todos.analyzeNotMine', 'groupTopics.analyze']) assert.ok(SUPPORTED_API_PATHS.includes(path) && !UNSUPPORTED_API_PATHS[path], `${path} is served by the backend`)
  dispose()
})

test('dispatcher: a result above the 64 KiB budget is chunked, every response stays under the host limit, and the chunks reassemble exactly', async () => {
  const big = Array.from({ length: 800 }, (_, i) => ({ id: `todo-${i}`, title: `很長的待辦標題 ${i} 😀 "quoted" \\ backslash \n newline`.repeat(3), detail: '內容'.repeat(60) }))
  const { d, dispose } = makeDispatcher(fakeApi({ db: { todos: { list: async () => big } } }))
  const head = await inv(d, 'db.todos.list')
  assert.equal(head.chunked, true)
  assert.ok(head.chunks > 3)
  assert.ok(Buffer.byteLength(JSON.stringify(head)) < 64 * 1024)
  let text = ''
  for (let i = 0; i < head.chunks; i += 1) {
    const res = await d.call('result', { path: 'result.chunk', args: [{ resultId: head.resultId, index: i }] })
    assert.equal(res.ok, true)
    assert.ok(Buffer.byteLength(JSON.stringify(res)) < 64 * 1024, `chunk ${i} response size`)
    assert.equal(res.value.last, i === head.chunks - 1)
    text += res.value.data
  }
  assert.deepEqual(JSON.parse(text), big)
  assert.equal(Buffer.byteLength(text), head.bytes)
  assert.equal((await d.call('result', { path: 'result.chunk', args: [{ resultId: head.resultId, index: 999 }] })).code, 'invalid_args')
  assert.equal((await d.call('result', { path: 'result.chunk', args: [{ resultId: 'gone', index: 0 }] })).code, 'result_expired')
  dispose()
})

test('dispatcher: chunked results expire, are capped in number, and absurdly large results are refused', async () => {
  let clock = 0
  const mk = (n) => Array.from({ length: n }, (_, i) => `row-${i}-` + 'x'.repeat(300))
  const api = fakeApi({ db: { todos: { list: async (q) => mk(q.n) } } })
  const { d, dispose } = makeDispatcher(api, { now: () => clock, resultTtlMs: 1000, maxResults: 2, maxResultBytes: 300_000 })
  const a = await inv(d, 'db.todos.list', { n: 400 })
  const b = await inv(d, 'db.todos.list', { n: 400 })
  const c = await inv(d, 'db.todos.list', { n: 400 })
  assert.equal((await d.call('result', { path: 'result.chunk', args: [{ resultId: a.resultId, index: 0 }] })).code, 'result_expired', 'oldest evicted at the cap')
  assert.equal((await d.call('result', { path: 'result.chunk', args: [{ resultId: c.resultId, index: 0 }] })).ok, true)
  clock += 2000
  assert.equal((await d.call('result', { path: 'result.chunk', args: [{ resultId: b.resultId, index: 0 }] })).code, 'result_expired')
  assert.equal((await inv(d, 'db.todos.list', { n: 5000 })).code, 'result_too_large')
  dispose()
})

test('dispatcher: a call slower than the soft deadline becomes a job that job.poll can collect; failures and big results flow through the same way', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const api = fakeApi({
    pipeline: {
      runOnce: async () => { await gate; return { done: true } },
      reviewLastDays: async () => { await gate; throw new Error('review exploded') },
      setRunning: async () => { await gate; return Array.from({ length: 3000 }, (_, i) => `row ${i} ` + 'z'.repeat(60)) }
    }
  })
  const { d, dispose } = makeDispatcher(api, { softDeadlineMs: 25, maxJobWaitMs: 200 })
  const pending = await inv(d, 'pipeline.runOnce')
  assert.equal(pending.pending, true)
  const failing = await inv(d, 'pipeline.reviewLastDays')
  const big = await inv(d, 'pipeline.setRunning', true)
  assert.equal(d.stats().jobs, 3)
  const still = await d.call('job', { path: 'job.poll', args: [{ jobId: pending.jobId, waitMs: 30 }] })
  assert.equal(still.pending, true, 'not finished yet')
  release()
  const done = await d.call('job', { path: 'job.poll', args: [{ jobId: pending.jobId, waitMs: 200 }] })
  assert.deepEqual(done, { ok: true, value: { done: true } })
  const err = await d.call('job', { path: 'job.poll', args: [{ jobId: failing.jobId, waitMs: 200 }] })
  assert.deepEqual(err, { ok: false, code: 'api_error', message: 'review exploded' })
  const bigDone = await d.call('job', { path: 'job.poll', args: [{ jobId: big.jobId, waitMs: 200 }] })
  assert.equal(bigDone.chunked, true, 'a long job with a big result is also chunked')
  assert.equal((await d.call('job', { path: 'job.poll', args: [{ jobId: 'missing' }] })).code, 'job_not_found')
  dispose()
})

test('dispatcher: jobs are capped, expire after their ttl, and dispose releases pollers', async () => {
  let clock = 0
  const never = new Promise(() => undefined)
  const api = fakeApi({ pipeline: { runOnce: async () => never } })
  const { d, dispose } = makeDispatcher(api, { softDeadlineMs: 5, maxJobs: 1, jobTtlMs: 100, now: () => clock, maxJobWaitMs: 5000 })
  const first = await inv(d, 'pipeline.runOnce')
  assert.equal(first.pending, true)
  assert.equal((await inv(d, 'pipeline.runOnce')).code, 'too_many_jobs')
  const poller = d.call('job', { path: 'job.poll', args: [{ jobId: first.jobId, waitMs: 5000 }] })
  setTimeout(() => d.dispose(), 20)
  assert.equal((await poller).code, 'backend_stopped')
  assert.equal((await inv(d, 'ping')).code, 'backend_stopped')
  void clock
  dispose()
})

test('dispatcher: backend.info, extract.stats and events.* are reachable through their method groups; the 0.1.x relay paths (extract.pull / commit / release / system) are gone', async () => {
  const { db } = freshDb()
  const { d, hub, queue, dispose } = (() => { const x = makeDispatcher(fakeApi()); return x })()
  assert.equal((await inv(d, 'backend.info')).value.ok, true)
  assert.deepEqual(Object.keys((await inv(d, 'extract.stats')).value).sort(), ['awaiting', 'chatsBackingOff', 'gen', 'leased', 'pending'])
  for (const path of ['extract.system', 'extract.pull', 'extract.commit', 'extract.release']) {
    const r = await inv(d, path, { max: 2, results: [], itemIds: ['a'] })
    assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: 'path_unknown' }, path)
  }
  const opened = await inv(d, 'events.open', {})
  assert.equal(opened.ok, true)
  hub.publish('todos-changed', { createdIds: ['a'] })
  const pulled = await inv(d, 'events.pull', { sessionId: opened.value.sessionId, afterSeq: opened.value.seq })
  assert.equal(pulled.value.events[0].type, 'todos-changed')
  assert.equal((await inv(d, 'events.pull', { sessionId: 'unknown', afterSeq: 0 })).code, 'session_not_found')
  assert.deepEqual((await inv(d, 'events.close', { sessionId: opened.value.sessionId })).value, {})
  void queue; void db
  dispose()
})

// ───────────── whole assembly on a fake LINE port ─────────────

function fakeLine() {
  const messageListeners = new Set()
  const statusListeners = new Set()
  let running = false
  const port = {
    start() { running = true },
    stop() { running = false },
    status: () => ({ state: running ? 'running' : 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 }),
    onMessage(cb) { messageListeners.add(cb); return () => messageListeners.delete(cb) },
    onStatus(cb) { statusListeners.add(cb); return () => statusListeners.delete(cb) },
    getMessagesSince: async () => []
  }
  return { port, emit: (m) => messageListeners.forEach((cb) => cb(m)), listeners: () => messageListeners.size + statusListeners.size }
}

function hostFailure(code) { return Object.assign(new Error(code), { code }) }

function makeSessionAwareHost(options = {}) {
  const sessions = new Map()
  const operations = []
  const completeCalls = []
  let nextSessionId = 0
  let maxActive = 0
  const effectiveFor = (selection = {}) => ({ providerId: selection.providerId ?? 'codex', modelId: selection.modelId ?? 'model-a', effort: selection.effort ?? 'medium' })
  const activeCount = () => [...sessions.values()].filter((session) => session.active).length
  const updateMaxActive = () => { maxActive = Math.max(maxActive, activeCount()) }
  const api = {
    async getOptions() {
      const base = {
        providers: [{ id: 'codex', label: 'Mock Codex', state: 'ready', models: [
          { id: 'model-a', label: 'Model A', efforts: ['low', 'medium'], defaultEffort: 'medium', supportsImages: false, isDefault: true },
          { id: 'model-b', label: 'Model B', efforts: ['low', 'medium'], defaultEffort: 'medium', supportsImages: false, isDefault: false },
        ] }],
        defaultProviderId: 'codex',
        limits: { systemChars: 16_000, transcriptLines: 40, transcriptChars: 60_000, inputChars: 8_000, imageBytes: 2 * 1024 * 1024, turnsPerMinute: 20 },
        quota: { state: 'ok', retryAfterMs: null },
      }
      return options.closedSessionResume === false ? base : { ...base, capabilities: { closedSessionResume: true } }
    },
    async complete(input) {
      completeCalls.push(structuredClone(input))
      const text = typeof options.completeReply==='function'?options.completeReply(input,completeCalls.length-1):options.completeReply ?? '這是一般 fresh completion'
      return { sessionId: '900', requestId: `plugin:900:complete-${completeCalls.length}`, providerTurnId: null, text, historySaved: 'saved' }
    },
    async openSession(input) {
      if ('resume' in input) {
        const id = input.resume
        operations.push({ op: 'resume', id })
        const existing = sessions.get(id)
        if (existing === undefined || options.rejectResume?.(id) === true) throw hostFailure('session_not_found')
        if (existing.active || activeCount() > 0) throw hostFailure('session_limit')
        existing.active = true
        updateMaxActive()
        return sessionFor(existing)
      }
      if (activeCount() > 0) throw hostFailure('session_limit')
      const id = String(++nextSessionId)
      const row = { id, effective: effectiveFor(input), providerIdentity: `provider:${id}`, active: true, sends: [], nextTurn: 0, lastTurnId: null, lastOutput: null, lastInput: null }
      sessions.set(id, row)
      operations.push({ op: 'fresh', id, input: structuredClone(input) })
      updateMaxActive()
      return sessionFor(row)
    },
  }
  function sessionFor(row) {
    const listeners = new Set()
    const publish = (event) => { for (const listener of [...listeners]) listener(event) }
    return {
      sessionId: row.id,
      effective: row.effective,
      turn: row.pendingTurn === true ? { turnId: 'a'.repeat(16), text: 'partial old turn', terminal: null } : null,
      async send({ text }) {
        if (!row.active) throw hostFailure('session_closed')
        let parsed = null
        try { parsed = JSON.parse(text) } catch { /* a repair prompt is plain text */ }
        if (parsed !== null) row.lastInput = parsed
        const turnId = (++row.nextTurn).toString(16).padStart(16, '0')
        const output = options.reply === undefined ? JSON.stringify({ importance: 'noise', newTodos: [], identityDecisions:[], resolved: [], updates: [] }) : options.reply({ row, text, parsed, sendIndex: row.sends.length })
        row.sends.push({ sessionId: row.id, turnId, text, output, parsed })
        if (row.lastTurnId !== null && options.replayPrevious !== false) {
          publish({ turnId: row.lastTurnId, kind: 'textDelta', text: row.lastOutput })
          publish({ turnId: row.lastTurnId, kind: 'completed' })
        }
        // Both replayed events and this turn's events are legal before send() resolves.
        publish({ turnId, kind: 'textDelta', text: output })
        publish({ turnId, kind: 'completed' })
        row.lastTurnId = turnId
        row.lastOutput = output
        return { turnId }
      },
      onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) },
      async interrupt() { return undefined },
      async close() {
        row.active = false
        operations.push({ op: 'close', id: row.id })
      },
    }
  }
  return { api, sessions, operations, completeCalls, get maxActive() { return maxActive }, deleteSession: (id) => sessions.delete(id) }
}

function memoryAiSessionMapStore() {
  const records = new Map()
  const operations = []
  return {
    records,
    operations,
    async get(chatId) { operations.push({ op: 'get', chatId }); return structuredClone(records.get(chatId) ?? null) },
    async put(record) { operations.push({ op: 'put', chatId: record.chatId, hostSessionId: record.hostSessionId }); records.set(record.chatId, structuredClone(record)) },
    async remove(chatId) { operations.push({ op: 'remove', chatId }); records.delete(chatId) },
  }
}

test('HostAi old Host capability omission keeps the fresh complete path and does not touch session maps', async () => {
  const host = makeSessionAwareHost({ closedSessionResume: false, completeReply: 'legacy response' })
  let mapReads = 0
  const port = createHostAiPort({
    ai: host.api,
    selection: () => ({ providerId: 'codex', modelId: 'model-a', effort: 'medium' }),
    sessionMapStore: { get: async () => { mapReads += 1; return null }, put: async () => undefined, remove: async () => undefined },
  })
  try {
    const result = await port.complete({ system: 'old host system', user: 'one shot', expectJson: false, priority: 'background', conversationScope: { kind: 'line-chat-extract', chatId: 'u-alice' } })
    assert.equal(result.text, 'legacy response')
    assert.equal(host.completeCalls.length, 1)
    assert.deepEqual(host.operations, [])
    assert.equal(mapReads, 0)
  } finally { port.stop() }
})

test('HostAi keeps JSON repair in one session and resets only the chat whose system fingerprint changed', async () => {
  const store = memoryAiSessionMapStore()
  const host = makeSessionAwareHost({ reply: ({ row, text, sendIndex }) => {
    if (row.id === '1' && sendIndex === 0) return '{invalid first response'
    if (row.id === '1' && text.includes('你上一則回覆無法使用')) return JSON.stringify({ importance: 'noise', newTodos: [], identityDecisions:[], resolved: [], updates: [] })
    return JSON.stringify({ importance: 'noise', newTodos: [], identityDecisions:[], resolved: [], updates: [] })
  } })
  const port = createHostAiPort({ ai: host.api, selection: () => ({ providerId: 'codex', modelId: 'model-a', effort: 'medium' }), sessionMapStore: store })
  const request = (chatId, system) => ({ system, user: JSON.stringify({ chatId, newMessages: [] }), expectJson: true, validate: (value) => ({ ok: true, value }), priority: 'background', conversationScope: { kind: 'line-chat-extract', chatId } })
  try {
    const first = await port.complete(request('u-alice', 'system A v1'))
    assert.equal(first.value.importance, 'noise')
    assert.equal(host.sessions.get('1').sends.length, 2, 'the repair is a second turn in the same session')
    assert.deepEqual(host.sessions.get('1').sends.map((turn) => turn.sessionId), ['1', '1'])
    assert.equal(host.sessions.get('1').active, false, 'the session closes after the extraction item')

    await port.complete(request('u-bob', 'system B'))
    const bobBefore = store.records.get('u-bob').hostSessionId
    const aliceBefore = store.records.get('u-alice').hostSessionId
    await port.complete(request('u-alice', 'system A v2'))
    await port.complete(request('u-bob', 'system B'))

    assert.notEqual(store.records.get('u-alice').hostSessionId, aliceBefore, 'changed prompt fingerprint starts a new identity for A')
    assert.equal(store.records.get('u-bob').hostSessionId, bobBefore, 'A reset leaves B mapping untouched until B settings are used')
    assert.deepEqual(host.operations.filter((entry) => entry.op === 'fresh' || entry.op === 'resume').map(({ op, id }) => [op, id]), [
      ['fresh', '1'], ['fresh', '2'], ['resume', '1'], ['fresh', '3'], ['resume', '2']
    ])
    assert.equal(host.maxActive, 1)
  } finally { port.stop() }
})

test('HostAi clears an invalid mapped resume and fails this item; the next source epoch opens fresh and seeds current input', async () => {
  const store = memoryAiSessionMapStore()
  const host = makeSessionAwareHost()
  const port = createHostAiPort({ ai: host.api, selection: () => ({ providerId: 'codex', modelId: 'model-a', effort: 'medium' }), sessionMapStore: store })
  const request = { system: 'same system', user: '{"current":"input"}', expectJson: true, validate: (value) => ({ ok: true, value }), priority: 'background', conversationScope: { kind: 'line-chat-extract', chatId: 'u-alice', sessionEpoch: 1 } }
  try {
    await port.complete(request)
    host.deleteSession('1')
    await assert.rejects(port.complete(request), (error) => error.code === 'continuity_lost')
    assert.equal(store.records.has('u-alice'), false)
    assert.deepEqual(host.operations.filter((entry) => entry.op === 'fresh' || entry.op === 'resume').map(({ op, id }) => [op, id]), [['fresh', '1'], ['resume', '1']])
    await port.complete({ ...request, conversationScope: { ...request.conversationScope, sessionEpoch: 2 } })
    assert.equal(host.sessions.get('2').sends[0].text, request.user, 'a new cache epoch starts with the fresh bounded request payload')
    assert.deepEqual(host.operations.filter((entry) => entry.op === 'fresh' || entry.op === 'resume').map(({ op, id }) => [op, id]), [['fresh', '1'], ['resume', '1'], ['fresh', '2']])
  } finally { port.stop() }
})

test('HostAi fingerprints the cache session epoch and reports the effective Host model and effort', async () => {
  const store=memoryAiSessionMapStore()
  const host=makeSessionAwareHost()
  const port=createHostAiPort({ai:host.api,selection:()=>({providerId:'codex',modelId:'model-a',effort:'low'}),sessionMapStore:store})
  const request=(sessionEpoch)=>({system:'same system',user:JSON.stringify({turn:sessionEpoch}),expectJson:false,priority:'background',conversationScope:{kind:'line-chat-extract',chatId:'u-alice',sessionEpoch}})
  try{
    assert.deepEqual(await port.effectiveSelection(),{providerId:'codex',modelId:'model-a',effort:'low'})
    await port.complete(request(4))
    await port.complete(request(4))
    assert.deepEqual(host.operations.filter((entry)=>entry.op==='fresh'||entry.op==='resume').map(({op,id})=>[op,id]),[['fresh','1'],['resume','1']])
    await port.complete(request(5))
    assert.deepEqual(host.operations.filter((entry)=>entry.op==='fresh'||entry.op==='resume').map(({op,id})=>[op,id]),[['fresh','1'],['resume','1'],['resume','1'],['fresh','2']])
    assert.equal(host.sessions.get('2').sends[0].text,request(5).user)
  }finally{port.stop()}
})

test('HostAi repair sends the full current SDK transcript and records its serialized user/assistant input once',async()=>{
  const user=JSON.stringify({chat:'synthetic-chat',message:'請保留完整修復上下文'})
  const host=makeSessionAwareHost({closedSessionResume:false,completeReply:(_input,index)=>index===0?'not-json':'{"importance":"noise"}'})
  const port=createHostAiPort({ai:host.api,selection:()=>({providerId:'codex',modelId:'model-a',effort:'medium'})})
  const additional=[]
  try{
    const result=await port.complete({system:'system',user,expectJson:true,validate:(value)=>({ok:true,value}),priority:'user',conversationScope:{kind:'line-chat-extract',chatId:'synthetic-chat'},onAdditionalUserPayload:(payload)=>{additional.push(payload);return true}})
    assert.deepEqual(result.value,{importance:'noise'})
    assert.equal(host.completeCalls.length,2)
    const repair=host.completeCalls[1]
    assert.deepEqual(repair.transcript,[{role:'user',text:user},{role:'assistant',text:'not-json'}],'the actual Host complete() receives the current complete transcript')
    assert.equal(additional.length,1)
    assert.equal(additional[0],[...repair.transcript.map((line)=>line.text),repair.text].join('\n'))
    assert.equal(Buffer.byteLength(additional[0],'utf8'),Buffer.byteLength(user,'utf8')+Buffer.byteLength('not-json','utf8')+Buffer.byteLength(repair.text,'utf8')+2,'two serialized transcript line separators are counted')
  }finally{port.stop()}
})

test('ExtractWorker and HostAi account the actual submitted primary and repair SDK text exactly once',async()=>{
  const {db}=freshDb()
  const {queue}=makeQueue(db,{leaseMs:120_000})
  const host=makeSessionAwareHost({reply:({sendIndex})=>sendIndex===0?'{invalid response':JSON.stringify({importance:'noise',newTodos:[],identityDecisions:[],resolved:[],updates:[]})})
  const port=createHostAiPort({ai:host.api,selection:()=>({providerId:'codex',modelId:'model-a',effort:'medium'}),sessionMapStore:memoryAiSessionMapStore(),config:{extractReserve:0,extractHourReserve:0}})
  const worker=createExtractWorker({queue,port,system:()=> 'extract system',config:{pollIntervalMs:60_000}})
  try{
    const source=raw(944,{chatId:'u-alice',text:'請保留當前來源並處理修復測試'})
    await cycle(db,queue,[source])
    worker.start()
    await worker.idle()
    const session=host.sessions.get('1')
    assert.equal(session.sends.length,2,'invalid primary response triggers exactly one same-purpose repair turn')
    assert.equal(session.sends[0].text.includes(source.text),true,'fresh Host session is seeded by the current leased source payload')
    assert.equal(worker.counters().extracted,1,'the repaired result commits through the owning queue transaction')
    assert.equal(queue.stats().pending,0)
    const state=readChatSourceState(db,'u-alice')
    assert.equal(state.submittedRequests,2)
    assert.equal(state.submittedUserUtf8Bytes,session.sends.reduce((sum,turn)=>sum+Buffer.byteLength(turn.text,'utf8'),0),'cache accounting matches the actual SDK session.send text fields')
    assert.equal(db.prepare('SELECT processed FROM messages WHERE chat_id=? AND msg_id=?').get('u-alice',id(944)).processed,1)
  }finally{worker.stop();port.stop();queue.dispose();db.close()}
})

test('HostAi never sends a new batch over a resumed session with an unfinished prior turn', async () => {
  const store = memoryAiSessionMapStore()
  const host = makeSessionAwareHost()
  const port = createHostAiPort({ ai: host.api, selection: () => ({ providerId: 'codex', modelId: 'model-a', effort: 'medium' }), sessionMapStore: store })
  const request = { system: 'same system', user: '{}', expectJson: true, validate: (value) => ({ ok: true, value }), priority: 'background', conversationScope: { kind: 'line-chat-extract', chatId: 'u-alice' } }
  try {
    await port.complete(request)
    const row = host.sessions.get('1')
    const sentBefore = row.sends.length
    row.pendingTurn = true
    await assert.rejects(port.complete(request), (error) => error.code === 'busy')
    assert.equal(row.sends.length, sentBefore, 'the new item does not inherit or overtake the prior unfinished turn')
    assert.equal(row.active, false, 'the unique slot is released before the lease is retried')
    assert.equal(store.records.get('u-alice').hostSessionId, '1', 'the durable mapping remains available for the next retry')
    assert.equal(host.operations.filter((entry) => entry.op === 'fresh').length, 1)
  } finally { port.stop() }
})

test('ExtractWorker releases a lease when the durable chat map is unavailable', async () => {
  const { db } = freshDb()
  const { queue } = makeQueue(db)
  const host = makeSessionAwareHost()
  const port = createHostAiPort({
    ai: host.api,
    selection: () => ({ providerId: 'codex', modelId: 'model-a', effort: 'medium' }),
    sessionMapStore: { get: async () => { throw new AiSessionMapStoreError('unavailable') }, put: async () => undefined, remove: async () => undefined },
  })
  const worker = createExtractWorker({ queue, port, system: () => 'extract system', config: { pollIntervalMs: 60_000 } })
  try {
    await cycle(db, queue, [raw(990, { chatId: 'u-alice' })])
    worker.start()
    await worker.idle()
    assert.equal(queue.stats().pending, 1)
    assert.equal(queue.stats().leased, 0)
    assert.equal(worker.counters().released, 1)
    assert.equal(worker.counters().failed, 0)
    assert.equal(getUnprocessedForPipeline(2000, db).length, 1, 'store unavailability does not commit or consume the source message')
    assert.deepEqual(host.operations, [], 'no Host session is opened until a chat map can be read')
  } finally {
    worker.stop()
    port.stop()
    queue.dispose()
    db.close()
  }
})

function resourcesNow() {
  const counts = {}
  for (const name of process.getActiveResourcesInfo()) counts[name] = (counts[name] ?? 0) + 1
  return counts
}

test('assembly: activate-like start, fake LINE message -> events + db, the backend supplies and its worker receives through host.ai.complete, dispose leaves nothing behind', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'plugin-backend-unit-'))
  const baseline = resourcesNow()
  const line = fakeLine()
  // the model: the first two answers (the original and its one repair) cannot pass the schema -> the chat fails and backs off; later answers are valid; a draft prompt gets a draft
  const ai = createMockTuqAi({ reply: (ctx) => (ctx.system.includes('草擬') ? '好的，我處理。' : ctx.turn < 2 ? JSON.stringify({ importance: 'nope' }) : JSON.stringify(okResult([JSON.parse(ctx.user).newMessages[0].msgId]))) })
  const backend = await createPluginBackend({ pluginId: 'tuqdev.line-todo', version: '9.9.9', dataDir, line: line.port, extract: { retryBaseMs: 50 }, hostAi: ai.ai, ai: { config: { optionsTtlMs: 20 }, worker: { pollIntervalMs: 40 } } })
  const call = async (path, ...args) => backend.call(backendMethodFor(path), { path, args })
  try {
    assert.equal((await call('ping')).value.version, '9.9.9')
    const status = await call('line.status')
    assert.equal(status.value.state, 'running')

    const session = (await call('events.open', {})).value
    line.emit(raw(1, { text: '請幫我寄報價單給客戶' }))
    line.emit(raw(2, { text: '下午三點開會，記得帶合約' }))
    const events = (await call('events.pull', { sessionId: session.sessionId, afterSeq: session.seq, waitMs: 100 })).value
    const types = events.events.map((e) => e.type)
    assert.ok(types.filter((t) => t === 'line-message').length === 2, `events: ${types}`)
    assert.ok(types.includes('messages-persisted'))
    assert.equal(events.events.find((e) => e.type === 'line-message').payload.chatId, 'u-alice')

    const chats = (await call('db.chats.list')).value
    assert.deepEqual(chats.map((c) => c.chatId), ['u-alice'])
    const messages = (await call('db.messages.list', { chatId: 'u-alice' })).value
    assert.equal(messages.length, 2)
    assert.deepEqual((await call('db.todos.list')).value, [])

    // supply: a pipeline run only collects; the backend's own worker then asks host.ai.complete (nobody pulls over the wire)
    const run = (await call('pipeline.runOnce')).value
    assert.equal(run.chatsSkipped, 1)
    assert.equal(run.todosCreated, 0)
    const until = async (probe, label) => { for (let i = 0; i < 300; i += 1) { const v = await probe(); if (v) return v; await new Promise((r) => setTimeout(r, 10)) } assert.fail(`timeout: ${label}`) }
    await until(async () => (await call('extract.stats')).value.chatsBackingOff === 1, 'the first answer (and its repair) cannot pass the schema: the chat backs off')
    assert.equal(ai.stats.completes, 2, 'the original turn and one repair turn')
    assert.equal(JSON.parse(ai.stats.turns[0].text).newMessages.length, 2, 'both messages of the chat went into one turn')
    assert.equal((await call('db.todos.list')).value.length, 0, 'a rejected result never marks messages processed or creates anything')
    assert.equal((await call('ai.status')).value.counters.failed, 1)

    // receive: after the chat backoff, the next cycle's supply is answered correctly
    await new Promise((r) => setTimeout(r, 60))
    await call('pipeline.runOnce')
    const todos = await until(async () => { const list = (await call('db.todos.list')).value; return list.length === 1 ? list : null }, 'the valid answer becomes a todo')
    assert.equal(todos[0].title, '回覆報價單')
    assert.equal((await call('ai.status')).value.counters.extracted, 1)
    assert.equal(ai.control.liveSessions(), 0)

    const after = (await call('events.pull', { sessionId: session.sessionId, afterSeq: events.seq, waitMs: 0 })).value
    const todosChanged = after.events.find((e) => e.type === 'todos-changed')
    assert.deepEqual(todosChanged.payload.createdIds, [todos[0].id])
    assert.ok(after.events.some((e) => e.type === 'pipeline-run'))
    // the status event is throttled (at most one per second, trailing): wait for it
    const withStatus = after.events.some((e) => e.type === 'ai-status') ? after : (await call('events.pull', { sessionId: session.sessionId, afterSeq: after.seq, waitMs: 2500 })).value
    assert.ok(withStatus.events.some((e) => e.type === 'ai-status'), 'the AI status is published as an event')
    assert.equal(after.events.some((e) => e.type === 'extract-pending'), false, 'there is no view-side consumer to wake up any more')

    // unsupported + AI paths
    assert.equal((await call('driver.postDraft')).code, 'method_unknown', 'driver is not a method group (G-07)')
    assert.deepEqual((await call('db.todos.draftReply', todos[0].id)).value, { draft: '好的，我處理。' }, 'the draft is produced in the backend')
    // settings never expose a key and the backend has no provider
    const settings = (await call('settings.get')).value
    assert.equal(settings.hasApiKey, true)
    assert.equal(settings.safeStorageAvailable, false)
    assert.equal((await call('pipeline.status')).value.llmStatus !== 'error', true)

    assert.equal(backend.diagnostics().appDbOpen, true)
    assert.ok(line.listeners() >= 2)
  } finally {
    await backend.dispose()
  }
  const diag = backend.diagnostics()
  assert.equal(diag.disposed, true)
  assert.equal(diag.appDbOpen, false, 'app DB connection closed')
  assert.equal(diag.eventSessions, 0)
  assert.deepEqual(diag.extract, { pending: 0, leased: 0, awaiting: 0 })
  assert.equal(line.listeners(), 0, 'LINE listeners removed')
  assert.equal((await backend.call('ping', { path: 'ping' })).code, 'backend_stopped')
  await backend.dispose() // idempotent
  assert.ok(!readdirSync(dataDir).includes('.line-todo-owner.lock'), 'owner lock released')
  await new Promise((r) => setImmediate(r))
  const left = resourcesNow()
  for (const kind of ['Timeout', 'Immediate', 'FSWatcher', 'FSReqCallback']) {
    assert.ok((left[kind] ?? 0) <= (baseline[kind] ?? 0), `no leaked ${kind}: before=${baseline[kind] ?? 0} after=${left[kind] ?? 0}`)
  }
  rmSync(dataDir, { recursive: true, force: true })
})

test('assembly: reviewLastDays-style synchronous extraction rides the same queue (answered by the worker) and a long call becomes a job', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'plugin-backend-unit-'))
  const line = fakeLine()
  const sinceWindow = [raw(1, { text: '提醒我週五前交付報告', ts: Date.now() - 1000 }), raw(2, { text: '另外發票也要開', ts: Date.now() - 500 })]
  line.port.getMessagesSince = async () => sinceWindow
  // the model takes ~100 ms, longer than the 30 ms soft deadline: the long call turns into a job
  const ai = createMockTuqAi({ reply: (ctx) => ({ text: JSON.stringify(okResult([JSON.parse(ctx.user).newMessages[0].msgId], '交付週五報告')), delay: () => new Promise((r) => setTimeout(r, 100)) }) })
  const backend = await createPluginBackend({ pluginId: 'p', version: '1', dataDir, line: line.port, dispatcher: { softDeadlineMs: 30, maxJobWaitMs: 300 }, hostAi: ai.ai, ai: { config: { optionsTtlMs: 20 }, worker: { pollIntervalMs: 40 } } })
  const call = (path, ...args) => backend.call(backendMethodFor(path), { path, args })
  try {
    const started = await call('pipeline.reviewLastDays', 7)
    assert.equal(started.pending, true, 'the review takes longer than the soft deadline, so it is a job (not a blocked invoke)')
    let result = null
    for (let i = 0; i < 20 && !result; i += 1) {
      const poll = await call('job.poll', { jobId: started.jobId, waitMs: 100 })
      if (!poll.pending) result = poll
    }
    assert.equal(result.ok, true)
    assert.equal(result.value.ok, true)
    assert.equal(result.value.todosCreated, 1)
    assert.deepEqual((await call('db.todos.list')).value.map((t) => t.title), ['交付週五報告'])
  } finally {
    await backend.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('assembly: dispose while a synchronous extraction (host call that never answers) and a long poll are outstanding does not hang', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'plugin-backend-unit-'))
  const line = fakeLine()
  line.port.getMessagesSince = async () => [raw(1, { ts: Date.now() - 1000 })]
  const ai = createMockTuqAi({ reply: () => ({ hang: true }) })
  const backend = await createPluginBackend({ pluginId: 'p', version: '1', dataDir, line: line.port, dispatcher: { softDeadlineMs: 20 }, hostAi: ai.ai, ai: { config: { optionsTtlMs: 20 }, worker: { pollIntervalMs: 40 } } })
  const call = (path, ...args) => backend.call(backendMethodFor(path), { path, args })
  const review = await call('pipeline.reviewLastDays', 1)
  const session = (await call('events.open', {})).value
  const poll = call('events.pull', { sessionId: session.sessionId, afterSeq: session.seq, waitMs: 4000 })
  assert.equal(review.pending, true)
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(ai.stats.completes, 1, 'the worker is inside a host call that will never be answered')
  const t0 = Date.now()
  await Promise.race([backend.dispose(), new Promise((_, reject) => setTimeout(() => reject(new Error('dispose hung')), 5000))])
  assert.ok(Date.now() - t0 < 2000)
  const pulled = await poll
  assert.ok(pulled.ok === false || pulled.value?.closed === true || pulled.value?.events?.length === 0)
  rmSync(dataDir, { recursive: true, force: true })
})

// ───────────── LINE DB directory without LOCALAPPDATA (the 1.6.8 env allowlist has none) ─────────────

test('LINE db dir: koffi asks Windows for LocalAppData; without koffi it falls back to env, then to TEMP; nothing else is guessed', async () => {
  const { createRequire } = await import('node:module')
  const { resolveLineDbDir, resolveLocalAppData } = await import('../../src/main/line/engine/native/knownFolders.ts')
  const koffi = createRequire(import.meta.url)('koffi')
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    assert.equal(resolveLocalAppData(koffi, {}), process.env.LOCALAPPDATA, 'known folder == %LOCALAPPDATA%, with an empty env')
    assert.equal(resolveLineDbDir(koffi, {}), join(process.env.LOCALAPPDATA, 'LINE', 'Data', 'db'))
  }
  const broken = { load: () => { throw new Error('no koffi') } }
  const local = ['C:', 'Users', 'x', 'AppData', 'Local'].join('\\')
  assert.equal(resolveLocalAppData(broken, { LOCALAPPDATA: local }), local)
  assert.equal(resolveLocalAppData(broken, { TEMP: `${local}\\Temp` }), local)
  assert.equal(resolveLocalAppData(broken, { TEMP: 'D:/scratch' }), null)
  assert.equal(resolveLineDbDir(broken, {}), null)
})

test('production assembly resumes each LINE chat across A→B→A and backend restart; repairs and replayed events stay on this item', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'line-todo-chat-session-'))
  const line = fakeLine()
  const host = makeSessionAwareHost({ reply: ({ row, text, sendIndex }) => {
    if (row.id === '1' && sendIndex === 0) return '{invalid initial JSON'
    if (row.id === '1' && text.includes('你上一則回覆無法使用')) {
      const sourceMsgId = row.lastInput?.newMessages?.[0]?.msgId
      return JSON.stringify({
        importance: 'action',
        newTodos: [{ draftRef:'draft_a',bucket: 'todo', title: 'A 初始待辦', detail: null, priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds: [sourceMsgId] }],
        identityDecisions:[{draftRef:'draft_a',outcome:'new',candidateType:null,candidateId:null,relationKind:null,reasonCode:'insufficient_evidence',confidenceBand:'high',evidenceMsgIds:[sourceMsgId]}],
        resolved: [], updates: []
      })
    }
    return JSON.stringify({ importance: 'noise', newTodos: [], identityDecisions:[], resolved: [], updates: [] })
  } })
  const createBackend = () => createPluginBackend({
    pluginId: 'tuqdev.line-todo', version: '9.9.9', dataDir, line: line.port,
    extract: { retryBaseMs: 1000, retryMaxMs: 5000 },
    hostAi: host.api,
    ai: { config: { optionsTtlMs: 20 }, worker: { pollIntervalMs: 20 } },
  })
  const waitUntil = async (probe, label, max = 400) => {
    for (let attempt = 0; attempt < max; attempt += 1) {
      const value = await probe()
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.fail(`timeout: ${label}`)
  }
  const extracted = async (backend) => (await backend.call(backendMethodFor('ai.status'), { path: 'ai.status', args: [] })).value.counters.extracted
  let backend = null
  try {
    backend = await createBackend()
    const firstCall = async (path, ...args) => backend.call(backendMethodFor(path), { path, args })
    line.emit(raw(3101, { chatId: 'u-alice', chat: 'Alice', text: 'A 第一輪訊息' }))
    await firstCall('pipeline.runOnce')
    await waitUntil(async () => (await extracted(backend)) === 1, 'A initial extraction commits after its in-session JSON repair')
    assert.equal(host.sessions.get('1').sends.length, 2)
    assert.deepEqual(host.sessions.get('1').sends.map((turn) => turn.sessionId), ['1', '1'], 'repair uses the same Host session')
    assert.equal(host.sessions.get('1').active, false, 'the extraction closes its single active Host slot')
    await backend.dispose()
    assert.equal(backend.diagnostics().appDbOpen, false)

    backend = await createBackend()
    const call = async (path, ...args) => backend.call(backendMethodFor(path), { path, args })
    line.emit(raw(3201, { chatId: 'u-bob', chat: 'Bob', text: 'B 第一輪訊息' }))
    await call('pipeline.runOnce')
    await waitUntil(async () => (await extracted(backend)) === 1, 'B gets an independent session after backend restart')
    line.emit(raw(3102, { chatId: 'u-alice', chat: 'Alice', text: 'A 第二輪訊息' }))
    await call('pipeline.runOnce')
    await waitUntil(async () => (await extracted(backend)) === 2, 'A resumes after B')

    const activeTodos = (await call('db.todos.list')).value
    const aliceTodo = activeTodos.find((todo) => todo.title === 'A 初始待辦')
    assert.ok(aliceTodo)
    assert.deepEqual(aliceTodo.sourceMsgIds, [id(3101)], 'replayed A1 completion was not committed for A2')
    const a2 = host.sessions.get('1').sends.at(-1)
    assert.deepEqual(a2.parsed.newMessages.map((message) => message.msgId), [id(3102)], 'the resumed turn carries only A2 current messages')
    assert.ok(a2.parsed.openTodos.some((todo) => todo.todoId === aliceTodo.id), 'the resumed A turn receives the current open todo snapshot')
    const b1 = host.sessions.get('2').sends[0]
    assert.deepEqual(b1.parsed.newMessages.map((message) => message.msgId), [id(3201)])
    assert.equal(b1.parsed.openTodos.some((todo) => todo.todoId === aliceTodo.id), false, 'B never receives A todo context')

    const sessionOps = host.operations.filter((entry) => entry.op === 'fresh' || entry.op === 'resume')
    assert.deepEqual(sessionOps.map(({ op, id: hostId }) => [op, hostId]), [['fresh', '1'], ['fresh', '2'], ['resume', '1']])
    assert.equal(host.sessions.get('1').providerIdentity, 'provider:1')
    assert.equal(host.sessions.get('2').providerIdentity, 'provider:2')
    assert.notEqual(host.sessions.get('1').providerIdentity, host.sessions.get('2').providerIdentity)
    assert.equal(host.maxActive, 1, 'the production caller never holds more than quota one')

    const ordinary = await call('db.todos.draftReply', aliceTodo.id)
    assert.equal(ordinary.ok, true)
    assert.equal(host.completeCalls.length, 1, 'other HostAi callers still use complete() without a conversation key')
    assert.equal(host.operations.filter((entry) => entry.op === 'fresh' || entry.op === 'resume').length, 3)

    host.deleteSession('1')
    line.emit(raw(3103, { chatId: 'u-alice', chat: 'Alice', text: 'A 的原 session 已失效' }))
    await call('pipeline.runOnce')
    await waitUntil(async () => (await call('extract.stats')).value.chatsBackingOff === 1, 'invalid mapped resume records a retry without committing')
    assert.equal(await extracted(backend), 2, 'continuity_lost is not committed as an extraction result')
    assert.equal(host.operations.filter((entry) => entry.op === 'fresh').length, 2, 'invalid resume does not silently open a replacement in the same attempt')
    assert.deepEqual(host.operations.filter((entry) => entry.op === 'resume').map((entry) => entry.id), ['1', '1'])
    await waitUntil(async () => (await extracted(backend)) === 3, 'the next leased retry creates a new identity after continuity_lost', 500)
    assert.equal(host.operations.filter((entry) => entry.op === 'fresh').length, 3)
    assert.equal(host.operations.at(-1).op, 'close')
    assert.equal(host.maxActive, 1)
  } finally {
    await backend?.dispose()
  }

  const { db: persistedDb } = openDatabase({ dbPath: join(dataDir, 'line-todo.db') })
  try {
    const rows = persistedDb.prepare('SELECT key, value FROM app_settings WHERE key LIKE ?').all(`${AI_SESSION_MAP_KEY_PREFIX}%`)
    const mappings = rows.map((row) => JSON.parse(row.value)).sort((left, right) => left.chatId.localeCompare(right.chatId))
    assert.deepEqual(mappings.map((mapping) => [mapping.chatId, mapping.hostSessionId]), [['u-alice', '3'], ['u-bob', '2']])
  } finally {
    persistedDb.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ───────────── per-chat prompt / my name (A12, A14) ─────────────

const chatPromptSetup = (db) => {
  const dir = mkdtempSync(join(tmpdir(), 'line-todo-units-prompt-'))
  const settings = createSettingsStore({ userDataDir: dir, secrets: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unused') }, decryptString: () => { throw new Error('unused') } } })
  const prompts = createPromptService(settings, { complete: async () => { throw new Error('unused') } }, { chatStore: createChatPromptStore({ getDatabase: () => db }) })
  return { prompts, settings, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('A12 ExtractQueue fingerprints each chat with its own effective system; an override change moves only that chat to a new session epoch', async () => {
  const { db } = freshDb()
  const { prompts, cleanup } = chatPromptSetup(db)
  const { queue } = makeQueue(db, { getSystemSha256: (chatId) => prompts.systemSha256(chatId) })
  const stateOf = (chatId) => readChatSourceState(db, chatId)
  const drain = () => {
    const { items } = queue.pull({ max: 2 })
    assert.equal(items.length, 2)
    for (const item of items) {
      const msgIds = JSON.parse(item.user).newMessages.map((message) => message.msgId)
      assert.equal(queue.commit({ results: [{ itemId: item.itemId, ok: true, result: okResult(msgIds) }] }).results[0].status, 'applied')
    }
  }
  try {
    await cycle(db, queue, [raw(1, { chatId: 'u-alice', chat: 'Alice' }), raw(2, { chatId: 'u-bob', chat: 'Bob' })])
    drain()
    const first = { alice: stateOf('u-alice'), bob: stateOf('u-bob') }
    assert.ok(first.alice.sessionFingerprint && first.bob.sessionFingerprint)
    assert.equal(first.alice.sessionFingerprint, first.bob.sessionFingerprint, 'no overrides: both chats share one effective system')

    prompts.chatSave('u-alice', { prompt: 'ALICE ONLY PROMPT', myName: null }, prompts.chatState('u-alice').revision)
    await cycle(db, queue, [raw(3, { chatId: 'u-alice', chat: 'Alice' }), raw(4, { chatId: 'u-bob', chat: 'Bob' })])
    drain()
    const second = { alice: stateOf('u-alice'), bob: stateOf('u-bob') }
    assert.notEqual(second.alice.sessionFingerprint, first.alice.sessionFingerprint, 'the overridden chat has a new fingerprint')
    assert.ok(second.alice.sessionEpoch > first.alice.sessionEpoch, 'and a new session epoch')
    assert.equal(second.bob.sessionFingerprint, first.bob.sessionFingerprint)
    assert.equal(second.bob.sessionEpoch, first.bob.sessionEpoch, 'the other chat keeps its session')
    assert.notEqual(second.alice.sessionFingerprint, second.bob.sessionFingerprint, 'two chats, two different fingerprints')

    assert.equal(queue.pull({ max: 1 }).systemSha256, prompts.revision(), 'the pull summary stays the default (no chat) value')
  } finally { queue.dispose(); db.close(); cleanup() }
})

test('A14 the chatPrompt and saveName paths run through the dispatcher: results, in-band errors, invalid_args and prompt_unavailable', async () => {
  const { db } = freshDb()
  for (const chatId of ['u-alice', 'u-bob']) db.prepare('INSERT INTO chats(chat_id, name, is_group, blocked, first_seen_at, last_seen_at) VALUES (?, ?, 0, 0, ?, ?)').run(chatId, chatId, '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z')
  const { prompts, cleanup } = chatPromptSetup(db)
  const { d, dispose } = makeDispatcher(fakeApi(), { prompts })
  const bare = makeDispatcher(fakeApi())
  try {
    for (const path of ['settings.prompt.saveName', 'settings.chatPrompt.get', 'settings.chatPrompt.save', 'settings.chatPrompt.reset', 'settings.chatPrompt.list']) {
      assert.equal((await inv(bare.d, path, { chatId: 'u-alice' })).code, 'prompt_unavailable', `${path} without a prompt service`)
    }
    const state = await inv(d, 'settings.prompt.get')
    assert.equal(state.value.myName, null)
    assert.equal(state.value.maxNameChars, 40)
    const named = await inv(d, 'settings.prompt.saveName', { myName: '王小明', expectedNameRevision: state.value.nameRevision })
    assert.equal(named.value.myName, '王小明')
    assert.equal((await inv(d, 'settings.prompt.saveName', { myName: 'x', expectedNameRevision: state.value.nameRevision })).code, 'prompt_conflict')
    assert.equal((await inv(d, 'settings.prompt.saveName', { myName: 'a\nb', expectedNameRevision: named.value.nameRevision })).code, 'my_name_invalid')
    assert.equal((await inv(d, 'settings.prompt.saveName', { myName: 'y'.repeat(41), expectedNameRevision: named.value.nameRevision })).code, 'my_name_too_long')
    assert.equal((await inv(d, 'settings.prompt.saveName')).code, 'invalid_args')

    const got = await inv(d, 'settings.chatPrompt.get', { chatId: 'u-alice' })
    assert.deepEqual([got.ok, got.value.promptSource, got.value.nameSource, got.value.effectiveName], [true, 'default', 'default', '王小明'])
    const saved = await inv(d, 'settings.chatPrompt.save', { chatId: 'u-alice', prompt: 'ALICE', myName: '阿華', expectedRevision: got.value.revision })
    assert.deepEqual([saved.ok, saved.value.overridePrompt, saved.value.overrideName], [true, 'ALICE', '阿華'])
    assert.equal((await inv(d, 'settings.chatPrompt.save', { chatId: 'u-alice', prompt: 'LATE', myName: null, expectedRevision: got.value.revision })).code, 'prompt_conflict')
    assert.equal((await inv(d, 'settings.chatPrompt.save', { chatId: 'u-alice', prompt: ' ', myName: null, expectedRevision: saved.value.revision })).code, 'prompt_empty')
    assert.equal((await inv(d, 'settings.chatPrompt.get', { chatId: 'u-ghost' })).code, 'chat_unknown')
    const listed = await inv(d, 'settings.chatPrompt.list')
    assert.deepEqual(listed.value, { items: [{ chatId: 'u-alice', hasPrompt: true, myName: '阿華', revision: saved.value.revision }] })
    for (const bad of [undefined, null, 'u-alice', { chatId: 42 }, {}]) {
      for (const path of ['settings.chatPrompt.get', 'settings.chatPrompt.save', 'settings.chatPrompt.reset']) assert.equal((await d.call(backendMethodFor(path), { path, args: bad === undefined ? [] : [bad] })).code, 'invalid_args', `${path} ${JSON.stringify(bad)}`)
    }
    const reset = await inv(d, 'settings.chatPrompt.reset', { chatId: 'u-alice', expectedRevision: saved.value.revision })
    assert.deepEqual([reset.ok, reset.value.overridePrompt, reset.value.promptSource], [true, null, 'default'])
    assert.deepEqual((await inv(d, 'settings.chatPrompt.list')).value, { items: [] })
    db.close()
    const closed = await inv(d, 'settings.chatPrompt.list')
    assert.equal(closed.code, 'chat_prompt_unavailable', 'a closed app DB is reported, never answered with an empty list')
  } finally { dispose(); bare.dispose(); cleanup() }
})


// ───────────── M1: per-chat session fingerprint through the production assembly ─────────────

test('M1 production assembly: an override saved for one chat moves only that chat to a new session_fingerprint and session_epoch in chat_context_cache (assemble.ts getSystemSha256 wiring)', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'line-todo-chat-fingerprint-'))
  const line = fakeLine()
  const host = makeSessionAwareHost()
  const createBackend = () => createPluginBackend({
    pluginId: 'tuqdev.line-todo', version: '9.9.9', dataDir, line: line.port,
    extract: { retryBaseMs: 1000, retryMaxMs: 5000 },
    hostAi: host.api,
    ai: { config: { optionsTtlMs: 20 }, worker: { pollIntervalMs: 20 } },
  })
  const waitUntil = async (probe, label, max = 600) => {
    for (let attempt = 0; attempt < max; attempt += 1) {
      if (await probe()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.fail(`timeout: ${label}`)
  }
  const readStates = () => {
    const { db } = openDatabase({ dbPath: join(dataDir, 'line-todo.db') })
    try { return { alice: readChatSourceState(db, 'u-alice'), bob: readChatSourceState(db, 'u-bob') } } finally { db.close() }
  }
  const runRound = async (emitIds, prepare) => {
    const backend = await createBackend()
    try {
      const call = (path, ...args) => backend.call(backendMethodFor(path), { path, args })
      if (prepare) await prepare(call)
      line.emit(raw(emitIds[0], { chatId: 'u-alice', chat: 'Alice', text: 'A 的訊息' }))
      line.emit(raw(emitIds[1], { chatId: 'u-bob', chat: 'Bob', text: 'B 的訊息' }))
      await call('pipeline.runOnce')
      await waitUntil(async () => (await call('ai.status')).value.counters.extracted === 2, 'both chats extracted')
    } finally { await backend.dispose() }
    return readStates()
  }
  try {
    const first = await runRound([4101, 4201])
    assert.ok(first.alice?.sessionFingerprint && first.bob?.sessionFingerprint, 'both chats have a recorded session fingerprint')
    assert.equal(first.alice.sessionFingerprint, first.bob.sessionFingerprint, 'no override: the two chats share one effective system')

    const second = await runRound([4102, 4202], async (call) => {
      const current = (await call('settings.chatPrompt.get', { chatId: 'u-alice' })).value
      const saved = await call('settings.chatPrompt.save', { chatId: 'u-alice', prompt: 'ALICE ONLY PROMPT M1', myName: null, expectedRevision: current.revision })
      assert.equal(saved.ok, true, 'the override is saved through the dispatcher')
    })
    assert.notEqual(second.alice.sessionFingerprint, first.alice.sessionFingerprint, 'the overridden chat gets a new fingerprint')
    assert.ok(second.alice.sessionEpoch > first.alice.sessionEpoch, 'and a new session epoch')
    assert.equal(second.bob.sessionFingerprint, first.bob.sessionFingerprint, 'the other chat keeps its fingerprint')
    assert.equal(second.bob.sessionEpoch, first.bob.sessionEpoch, 'and its session epoch')
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})


test('m2 saveName and chatPrompt.save need their keys present: an absent key is invalid_args and never clears the stored override or default name; an explicit null still clears', async () => {
  const { db } = freshDb()
  db.prepare('INSERT INTO chats(chat_id, name, is_group, blocked, first_seen_at, last_seen_at) VALUES (?, ?, 0, 0, ?, ?)').run('u-alice', 'u-alice', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z')
  const { prompts, cleanup } = chatPromptSetup(db)
  const { d, dispose } = makeDispatcher(fakeApi(), { prompts })
  try {
    const state = (await inv(d, 'settings.prompt.get')).value
    const named = (await inv(d, 'settings.prompt.saveName', { myName: '王小明', expectedNameRevision: state.nameRevision })).value
    assert.equal(named.myName, '王小明')
    const missingName = await inv(d, 'settings.prompt.saveName', { expectedNameRevision: named.nameRevision })
    assert.equal(missingName.code, 'invalid_args')
    assert.equal((await inv(d, 'settings.prompt.get')).value.myName, '王小明', 'the default name survives a save without myName')

    const base = (await inv(d, 'settings.chatPrompt.get', { chatId: 'u-alice' })).value
    const saved = (await inv(d, 'settings.chatPrompt.save', { chatId: 'u-alice', prompt: 'ALICE', myName: '阿華', expectedRevision: base.revision })).value
    assert.deepEqual([saved.overridePrompt, saved.overrideName], ['ALICE', '阿華'])
    assert.equal((await inv(d, 'settings.chatPrompt.save', { chatId: 'u-alice', myName: '阿華', expectedRevision: saved.revision })).code, 'invalid_args', 'no prompt key')
    assert.equal((await inv(d, 'settings.chatPrompt.save', { chatId: 'u-alice', prompt: 'ALICE', expectedRevision: saved.revision })).code, 'invalid_args', 'no myName key')
    assert.equal((await inv(d, 'settings.chatPrompt.save', { chatId: 'u-alice', expectedRevision: saved.revision })).code, 'invalid_args', 'neither key')
    const after = (await inv(d, 'settings.chatPrompt.get', { chatId: 'u-alice' })).value
    assert.deepEqual([after.overridePrompt, after.overrideName, after.revision], ['ALICE', '阿華', saved.revision], 'the stored override is untouched by the rejected saves')

    assert.throws(() => prompts.chatSave('u-alice', { prompt: undefined, myName: '阿華' }, saved.revision), /invalid_args/)
    assert.throws(() => prompts.chatSave('u-alice', { prompt: 'ALICE', myName: undefined }, saved.revision), /invalid_args/)
    assert.throws(() => prompts.saveName(undefined, named.nameRevision), /invalid_args/)

    const cleared = (await inv(d, 'settings.chatPrompt.save', { chatId: 'u-alice', prompt: null, myName: null, expectedRevision: saved.revision })).value
    assert.deepEqual([cleared.overridePrompt, cleared.overrideName], [null, null], 'an explicit null is a value and clears')
    const noName = (await inv(d, 'settings.prompt.saveName', { myName: null, expectedNameRevision: named.nameRevision })).value
    assert.equal(noName.myName, null, 'an explicit null clears the default name')
  } finally { dispose(); cleanup() }
})
