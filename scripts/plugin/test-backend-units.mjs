// Phase 2 — unit tests for the plugin backend building blocks, run on plain Node 24 with the node:sqlite test adapter
// (the real better-sqlite3 13.0.2 / WASM / koffi / 1.6.8-permission path is exercised by test-backend-contract.mjs):
//   * ExtractQueue + runOnce(extractSink): supply (outbox) and receive (inbox), parity with the standalone apply path
//   * EventHub: seq/replay/gap/long-poll/capability session
//   * Dispatcher: allow-list routing, unsupported paths, 64 KiB chunking, soft-deadline jobs
//   * createPluginBackend: the whole assembly on a fake LINE port (no koffi, no WASM)
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULTS } from '../../src/main/config/defaults.ts'
import { openDatabase } from '../../src/main/db/database.ts'
import { getUnprocessedForPipeline, insertMessages } from '../../src/main/db/messages.repo.ts'
import { getLastRun } from '../../src/main/db/pipeline.repo.ts'
import { listTodos } from '../../src/main/db/todos.repo.ts'
import { EXTRACT_SYSTEM_PROMPT, buildUserPayload } from '../../src/main/llm/extractPrompt.ts'
import { runOnce } from '../../src/main/pipeline/runOnce.ts'
import { fixedWatchSource } from '../../src/main/pipeline/scheduler.ts'
import { Dispatcher } from '../../src/plugin/backend/dispatcher.ts'
import { EVENTS_CAPABILITY, EventHub, compactPayload } from '../../src/plugin/backend/eventHub.ts'
import { EXTRACT_SYSTEM_SHA256, ExtractQueue, partitionExtractInput } from '../../src/plugin/backend/extractQueue.ts'
import { createPluginBackend } from '../../src/plugin/backend/assemble.ts'

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
  newTodos: [{ bucket: 'todo', title, detail: null, priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds: msgIds.slice(0, 1) }],
  resolved: [], updates: []
})

const stable = (todos) => todos.map((t) => ({ chatId: t.chatId, bucket: t.bucket, status: t.status, title: t.title, priority: t.priority, sourceMsgIds: t.sourceMsgIds })).sort((a, b) => (a.title + a.chatId).localeCompare(b.title + b.chatId))

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

// ───────────── ExtractQueue + runOnce ─────────────

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
  const committed = queue.commit({ results: [{ itemId: items[0].itemId, ok: true, result: okResult(['m1', 'm2']) }] })
  assert.equal(committed.results[0].status, 'applied')
  assert.equal(committed.results[0].createdIds.length, 1)
  assert.equal(committed.run.todosCreated, 1)
  assert.equal(getUnprocessedForPipeline(100, db).length, 0)
  assert.deepEqual(stable(listTodos({}, db)), [{ chatId: 'u-alice', bucket: 'todo', status: 'pending', title: '回覆報價單', priority: 2, sourceMsgIds: ['m1'] }])
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
  res = queue.commit({ results: [{ itemId: item.itemId, ok: true, result: okResult(['m1']) }] })
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
  const first = queue.commit({ results: [{ itemId: item.itemId, ok: true, result: okResult(['m1']) }, { itemId: 'nope', ok: true, result: okResult(['m1']) }, { ok: true }, { itemId: 'x', ok: 'yes' }] })
  assert.deepEqual(first.results.map((r) => r.status), ['applied', 'unknown_item', 'bad_request', 'bad_request'])
  const again = queue.commit({ results: [{ itemId: item.itemId, ok: true, result: okResult(['m1']) }] })
  assert.equal(again.results[0].status, 'unknown_item', 'a committed lease cannot be committed twice')
  assert.equal(listTodos({}, db).length, 1)

  // lease expiry: the stale id stops working, the chat is handed out again under a new id
  await cycle(db, queue, [raw(2)])
  const [a] = queue.pull().items
  advance(6000)
  const [b] = queue.pull().items
  assert.notEqual(a.itemId, b.itemId)
  assert.equal(queue.commit({ results: [{ itemId: a.itemId, ok: true, result: okResult(['m2']) }] }).results[0].status, 'unknown_item')
  assert.equal(queue.commit({ results: [{ itemId: b.itemId, ok: true, result: okResult(['m2'], '另一件事') }] }).results[0].status, 'applied')
})

test('receive: messages that arrive while a lease is out are offered separately; in-flight messages are never duplicated', async () => {
  const { db } = freshDb()
  const { queue } = makeQueue(db)
  await cycle(db, queue, [raw(1), raw(2)])
  const [leased] = queue.pull().items
  await cycle(db, queue, [raw(3), raw(4)])
  const next = queue.pull()
  assert.equal(next.items.length, 0, 'one part per chat at a time: the chat is busy until its lease is resolved')
  queue.commit({ results: [{ itemId: leased.itemId, ok: true, result: okResult(['m1', 'm2']) }] })
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
    (input) => ({ importance: 'action', newTodos: [], resolved: input.openTodos.map((t) => ({ todoId: t.id, evidence: '對方已完成' })), updates: [] })
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
    const res = queue.commit({ results: [{ itemId: item.itemId, ok: true, result: { importance: 'fyi', newTodos: [], resolved: [], updates: [] } }] })
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
const inv = (d, path, ...args) => d.call('api.invoke', { path, args })

test('dispatcher: routes allow-listed paths, passes args, and returns in-band envelopes', async () => {
  const { d, dispose } = makeDispatcher(fakeApi())
  assert.deepEqual(await inv(d, 'ping'), { ok: true, value: { ok: true, ts: 1, version: 'test' } })
  assert.deepEqual(await inv(d, 'db.todos.list', { chatId: 'c' }), { ok: true, value: [{ id: 't1', q: { chatId: 'c' } }] })
  assert.deepEqual(await d.call('api.invoke', { path: 'db.todos.get', args: ['x'] }), { ok: true, value: null })
  assert.deepEqual(await inv(d, 'db.todos.update'), { ok: false, code: 'api_error', message: 'boom: update failed' })
  assert.equal((await d.call('nope', {})).code, 'method_unknown')
  dispose()
})

test('dispatcher: only allow-listed paths run; prototype tricks, malformed paths, subscriptions and unavailable features are refused', async () => {
  const { d, dispose } = makeDispatcher(fakeApi())
  for (const path of ['__proto__', 'constructor', 'db.todos.constructor', 'db.__proto__.x', 'toString', 'line.onMessage', 'db.todos', 'a..b', '', 'db/todos/list', 'x'.repeat(200)]) {
    const r = await inv(d, path)
    assert.equal(r.ok, false, path)
    assert.equal(r.code, 'path_unknown', path)
  }
  assert.equal((await inv(d, 'groupTopics.list', 'c')).code, 'unavailable', 'allowed path whose feature is disabled in this build')
  assert.equal((await d.call('api.invoke', { path: 'ping', args: 'nope' })).code, 'invalid_args')
  assert.equal((await d.call('api.invoke', { path: 'ping', args: new Array(9).fill(0) })).code, 'invalid_args')
  assert.equal((await d.call('api.invoke', null)).code, 'invalid_args')
  assert.equal((await d.call('api.invoke', { path: 5 })).code, 'invalid_args')
  dispose()
})

test('dispatcher: driver, CLI/AI provider and Electron-only paths answer unsupported_in_plugin (with the UI route where ai:chat takes over)', async () => {
  const { d, dispose } = makeDispatcher(fakeApi({ driver: { postDraft: async () => { throw new Error('must not run') } } }))
  for (const [path, route] of [
    ['driver.postDraft', 'none'], ['driver.status', 'none'], ['driver.focusLine', 'none'],
    ['media.open', 'none'], ['media.saveAs', 'none'], ['app.openDataFolder', 'none'], ['db.chats.openOriginal', 'none'],
    ['pipeline.testQwen', 'none'], ['pipeline.testAiProvider', 'none'], ['settings.setApiKey', 'none'], ['settings.clearApiKey', 'none'],
    ['db.todos.draftReply', 'ui_ai_chat'], ['db.todos.analyzeNotMine', 'ui_ai_chat'], ['groupTopics.analyze', 'ui_ai_chat']
  ]) {
    const r = await inv(d, path, 'x')
    assert.equal(r.ok, false, path)
    assert.equal(r.code, 'unsupported_in_plugin', path)
    assert.equal(r.route, route, path)
  }
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
    const res = await d.call('api.invoke', { path: 'result.chunk', args: [{ resultId: head.resultId, index: i }] })
    assert.equal(res.ok, true)
    assert.ok(Buffer.byteLength(JSON.stringify(res)) < 64 * 1024, `chunk ${i} response size`)
    assert.equal(res.value.last, i === head.chunks - 1)
    text += res.value.data
  }
  assert.deepEqual(JSON.parse(text), big)
  assert.equal(Buffer.byteLength(text), head.bytes)
  assert.equal((await d.call('api.invoke', { path: 'result.chunk', args: [{ resultId: head.resultId, index: 999 }] })).code, 'invalid_args')
  assert.equal((await d.call('api.invoke', { path: 'result.chunk', args: [{ resultId: 'gone', index: 0 }] })).code, 'result_expired')
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
  assert.equal((await d.call('api.invoke', { path: 'result.chunk', args: [{ resultId: a.resultId, index: 0 }] })).code, 'result_expired', 'oldest evicted at the cap')
  assert.equal((await d.call('api.invoke', { path: 'result.chunk', args: [{ resultId: c.resultId, index: 0 }] })).ok, true)
  clock += 2000
  assert.equal((await d.call('api.invoke', { path: 'result.chunk', args: [{ resultId: b.resultId, index: 0 }] })).code, 'result_expired')
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
  const still = await d.call('api.invoke', { path: 'job.poll', args: [{ jobId: pending.jobId, waitMs: 30 }] })
  assert.equal(still.pending, true, 'not finished yet')
  release()
  const done = await d.call('api.invoke', { path: 'job.poll', args: [{ jobId: pending.jobId, waitMs: 200 }] })
  assert.deepEqual(done, { ok: true, value: { done: true } })
  const err = await d.call('api.invoke', { path: 'job.poll', args: [{ jobId: failing.jobId, waitMs: 200 }] })
  assert.deepEqual(err, { ok: false, code: 'api_error', message: 'review exploded' })
  const bigDone = await d.call('api.invoke', { path: 'job.poll', args: [{ jobId: big.jobId, waitMs: 200 }] })
  assert.equal(bigDone.chunked, true, 'a long job with a big result is also chunked')
  assert.equal((await d.call('api.invoke', { path: 'job.poll', args: [{ jobId: 'missing' }] })).code, 'job_not_found')
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
  const poller = d.call('api.invoke', { path: 'job.poll', args: [{ jobId: first.jobId, waitMs: 5000 }] })
  setTimeout(() => d.dispose(), 20)
  assert.equal((await poller).code, 'backend_stopped')
  assert.equal((await inv(d, 'ping')).code, 'backend_stopped')
  void clock
  dispose()
})

test('dispatcher: backend.info, extract.* and events.* are reachable through api.invoke and lift component errors into the envelope', async () => {
  const { db } = freshDb()
  const { d, hub, queue, dispose } = (() => { const x = makeDispatcher(fakeApi()); return x })()
  assert.equal((await inv(d, 'backend.info')).value.ok, true)
  const system = await inv(d, 'extract.system')
  assert.equal(system.value.system, EXTRACT_SYSTEM_PROMPT)
  assert.equal(system.value.sha256, EXTRACT_SYSTEM_SHA256)
  assert.equal(system.value.ok, undefined, 'internal ok flags are not duplicated inside value')
  assert.deepEqual((await inv(d, 'extract.pull', { max: 2 })).value.items, [])
  assert.equal((await inv(d, 'extract.commit', {})).code, 'invalid_args')
  assert.equal((await inv(d, 'extract.commit', { results: [] })).code, 'invalid_args')
  assert.equal((await inv(d, 'extract.commit', { results: [{ itemId: 'zz', ok: true }] })).value.results[0].status, 'unknown_item')
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

function resourcesNow() {
  const counts = {}
  for (const name of process.getActiveResourcesInfo()) counts[name] = (counts[name] ?? 0) + 1
  return counts
}

test('assembly: activate-like start, fake LINE message -> events + db, supply/receive through api.invoke, dispose leaves nothing behind', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'plugin-backend-unit-'))
  const baseline = resourcesNow()
  const line = fakeLine()
  const backend = await createPluginBackend({ pluginId: 'tuqdev.line-todo', version: '9.9.9', dataDir, line: line.port, extract: { retryBaseMs: 50 } })
  const call = async (path, ...args) => backend.call('api.invoke', { path, args })
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

    // supply: a pipeline run only collects
    const run = (await call('pipeline.runOnce')).value
    assert.equal(run.chatsSkipped, 1)
    assert.equal(run.todosCreated, 0)
    const pulled = (await call('extract.pull', { max: 3 })).value
    assert.equal(pulled.items.length, 1)
    assert.equal(JSON.parse(pulled.items[0].user).newMessages.length, 2)

    // receive: invalid first, then valid
    const bad = (await call('extract.commit', { results: [{ itemId: pulled.items[0].itemId, ok: true, result: { importance: 'nope' } }] })).value
    assert.equal(bad.results[0].status, 'rejected')
    await new Promise((r) => setTimeout(r, 60))
    await call('pipeline.runOnce')
    const again = (await call('extract.pull')).value
    assert.equal(again.items.length, 1)
    const good = (await call('extract.commit', { results: [{ itemId: again.items[0].itemId, ok: true, result: okResult(['m1']) }] })).value
    assert.equal(good.results[0].status, 'applied')
    const todos = (await call('db.todos.list')).value
    assert.equal(todos.length, 1)
    assert.equal(todos[0].title, '回覆報價單')

    const after = (await call('events.pull', { sessionId: session.sessionId, afterSeq: events.seq, waitMs: 0 })).value
    const todosChanged = after.events.find((e) => e.type === 'todos-changed')
    assert.deepEqual(todosChanged.payload.createdIds, [todos[0].id])
    assert.ok(after.events.some((e) => e.type === 'pipeline-run'))
    assert.ok(after.events.some((e) => e.type === 'extract-pending'))

    // unsupported + AI paths
    assert.equal((await call('driver.postDraft')).code, 'unsupported_in_plugin')
    assert.equal((await call('db.todos.draftReply', todos[0].id)).route, 'ui_ai_chat')
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
  assert.equal((await backend.call('api.invoke', { path: 'ping' })).code, 'backend_stopped')
  await backend.dispose() // idempotent
  assert.ok(!readdirSync(dataDir).includes('.line-todo-owner.lock'), 'owner lock released')
  await new Promise((r) => setImmediate(r))
  const left = resourcesNow()
  for (const kind of ['Timeout', 'Immediate', 'FSWatcher', 'FSReqCallback']) {
    assert.ok((left[kind] ?? 0) <= (baseline[kind] ?? 0), `no leaked ${kind}: before=${baseline[kind] ?? 0} after=${left[kind] ?? 0}`)
  }
  rmSync(dataDir, { recursive: true, force: true })
})

test('assembly: reviewLastDays-style synchronous extraction rides the same queue and a long call becomes a job', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'plugin-backend-unit-'))
  const line = fakeLine()
  const sinceWindow = [raw(1, { text: '提醒我週五前交付報告', ts: Date.now() - 1000 }), raw(2, { text: '另外發票也要開', ts: Date.now() - 500 })]
  line.port.getMessagesSince = async () => sinceWindow
  const backend = await createPluginBackend({ pluginId: 'p', version: '1', dataDir, line: line.port, dispatcher: { softDeadlineMs: 30, maxJobWaitMs: 300 } })
  const call = (path, ...args) => backend.call('api.invoke', { path, args })
  try {
    const started = await call('pipeline.reviewLastDays', 7)
    assert.equal(started.pending, true, 'the review waits for the UI, so it is a job (not a blocked invoke)')
    const pulled = (await call('extract.pull')).value
    assert.equal(pulled.items.length, 1)
    assert.equal((await call('extract.commit', { results: [{ itemId: pulled.items[0].itemId, ok: true, result: okResult(['m1'], '交付週五報告') }] })).value.results[0].status, 'accepted')
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

test('assembly: dispose while a synchronous extraction and a long poll are outstanding does not hang', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'plugin-backend-unit-'))
  const line = fakeLine()
  line.port.getMessagesSince = async () => [raw(1, { ts: Date.now() - 1000 })]
  const backend = await createPluginBackend({ pluginId: 'p', version: '1', dataDir, line: line.port, dispatcher: { softDeadlineMs: 20 } })
  const call = (path, ...args) => backend.call('api.invoke', { path, args })
  const review = await call('pipeline.reviewLastDays', 1)
  const session = (await call('events.open', {})).value
  const poll = call('events.pull', { sessionId: session.sessionId, afterSeq: session.seq, waitMs: 4000 })
  assert.equal(review.pending, true)
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
