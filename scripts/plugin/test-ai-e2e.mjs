// Phase 4 — end to end: a mock `window.tuqPlugin.ai` (1.6.8 ai:chat semantics, scripts/lib/mock-tuq-ai.mjs) + the REAL Phase 2 backend (createPluginBackend on a fake
// LINE port, app DB = node:sqlite test adapter) + the REAL Phase 3 adapter (createPluginLineTodoApi) + the REAL orchestrator, wired the way src/plugin/ui/host.ts wires them.
//
// From a new LINE message to a todo showing up in query results (method groups, G-07) — with nothing but the mock standing in for Codex:
//   message -> backend pipeline (供料) -> extract-pending event -> orchestrator pulls -> system + format + user payload over ai:chat -> reply with ```json fences
//   -> parse + zod -> extract.commit -> backend re-validates + persists -> todos.list / todos-changed
// plus the three user actions (草擬回覆、誤判分析、群組議題分析) bridged through backend `ai.run`, the visibility pause, revocation, review (reviewLastDays), and host.ts wiring.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { EXTRACT_SYSTEM_PROMPT } from '../../src/main/llm/extractPrompt.ts'
import { EXTRACT_JSON_SCHEMA } from '../../src/main/llm/schema.ts'
import { createPluginBackend } from '../../src/plugin/backend/assemble.ts'
import { createAiOrchestrator } from '../../src/plugin/ui/aiOrchestrator.ts'
import { bootBoard } from '../../src/plugin/ui/board.ts'
import { bootPluginApi } from '../../src/plugin/ui/host.ts'
import { createPluginLineTodoApi, PLUGIN_AI_NOT_CONNECTED } from '../../src/renderer/platform/pluginApi.ts'
import { CONTRACT, createMockTuqAi } from '../lib/mock-tuq-ai.mjs'
import { RESOURCES } from './lib/manifest.mjs'

// ───────────── host mock (JSON-only, 64 KiB; busy when the calls being handled reach the manifest's maxSessions: backendController.ts:395, review F1) ─────────────

const LIMIT = 64 * 1024
const isJson = (value, depth = 0) => {
  if (depth > 40) return false
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 4096 && value.every((v) => isJson(v, depth + 1))
  if (typeof value === 'object') return Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every((v) => isJson(v, depth + 1))
  return false
}
const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength

function makeBackendHost(target) {
  const state = { calls: [], inFlight: 0, maxInFlight: 0, busyRejections: 0, maxSessions: RESOURCES.maxSessions }
  return {
    state,
    count: (path) => state.calls.filter((c) => c.path === path).length,
    host: {
      backend: {
        async call(method, params) {
          if (!/^[A-Za-z0-9._@-]{1,64}$/.test(method) || !isJson(params) || bytes(params) > LIMIT) throw new Error('backend_invoke_invalid')
          state.calls.push({ method, path: params.path, args: params.args })
          // the controller refuses a call when the calls already being handled reach resources.maxSessions; the view sees the invoke gate's spelling
          if (state.inFlight >= state.maxSessions) { state.busyRejections += 1; throw new Error('plugin_backend_unavailable') }
          state.inFlight += 1
          state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
          try {
            const result = JSON.parse(JSON.stringify((await target.call(method, JSON.parse(JSON.stringify(params)))) ?? null))
            if (bytes(result) > LIMIT) throw new Error('backend_invoke_too_large')
            return result
          } finally { state.inFlight -= 1 }
        }
      },
      assets: { url: (path) => `tuqplugin://tuqdev.line-todo/data/${path}` }
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(predicate, { timeout = 6000, step = 15, message = 'condition' } = {}) {
  const t0 = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - t0 > timeout) assert.fail(`timed out waiting for ${message}`)
    await sleep(step)
  }
}

function fakeLine() {
  const messageListeners = new Set()
  let running = false
  const port = {
    start() { running = true }, stop() { running = false },
    status: () => ({ state: running ? 'running' : 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 }),
    onMessage(cb) { messageListeners.add(cb); return () => messageListeners.delete(cb) },
    onStatus() { return () => {} },
    getMessagesSince: async () => []
  }
  return { port, emit: (m) => messageListeners.forEach((cb) => cb(m)) }
}

function raw(i, { chatId = 'u-alice', chat = 'Alice', text, isGroup = false, ts } = {}) {
  const t = ts ?? 1_700_000_000_000 + i * 1000
  return { msgId: `m${i}`, chat, chatId, isGroup, ts: t, time: new Date(t).toISOString(), direction: 'in', sender: chat, text: text ?? `請幫我處理第 ${i} 件事情，明天要交`, contentType: 0 }
}

const FAST_EVENTS = { waitMs: 200, idleStopMs: 30, backoffBaseMs: 10, backoffMaxMs: 40, minLoopMs: 5 }
const FAST_ORCH = { pollIntervalMs: 60, sendRetryMs: 10, hiddenProbeMs: 80, providerRetryMs: 200, busyBackoffMs: 50, backendBackoffMs: 50, rateBackoffBaseMs: 40, rateBackoffMaxMs: 160, quotaDefaultMs: 400 }

/** The JSON a model would give for the payload our backend really sent (it cites the real msgId). */
function todoFor(user, title = '寄報價單給客戶') {
  const payload = JSON.parse(user)
  const first = payload.newMessages[0]
  return { importance: 'action', newTodos: [{ bucket: 'todo', title, detail: `來自：${first.text.slice(0, 20)}`, priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds: [first.msgId] }], resolved: [], updates: [] }
}
const fenced = (value) => '好的，整理如下：\n```json\n' + JSON.stringify(value, null, 2) + '\n```\n'

async function withStack(options, body) {
  const dataDir = mkdtempSync(join(tmpdir(), 'plugin-ai-e2e-'))
  const line = fakeLine()
  const calls = []
  const ai = createMockTuqAi({
    reply: (ctx) => { calls.push(ctx); return (options.reply ?? ((c) => fenced(todoFor(c.user))))(ctx) }
  })
  const backend = await createPluginBackend({
    pluginId: 'tuqdev.line-todo', version: '4.0.0', dataDir, line: line.port, extract: { retryBaseMs: 30 },
    dispatcher: { softDeadlineMs: 40, maxJobWaitMs: 300 }, ...options.backend
  })
  const mock = makeBackendHost(backend)
  let orch = null
  const api = createPluginLineTodoApi({
    host: mock.host, events: FAST_EVENTS, jobPollWaitMs: 100,
    aiConnection: { connected: () => orch?.connected() ?? false, note: () => orch?.note() }
  })
  const visibility = { visible: true, listeners: new Set(), isVisible() { return this.visible }, subscribe(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb) }, set(v) { this.visible = v; for (const cb of [...this.listeners]) cb(v) } }
  orch = createAiOrchestrator({ ai: ai.ai, extract: api.plugin.extract, tasks: api.plugin.aiTasks, visibility, config: { ...FAST_ORCH, ...options.orch } })
  if (options.start !== false) orch.start()
  try {
    await body({ api, backend, line, mock, ai, orch, visibility, calls, dataDir })
    // review F1: in every scenario the board view (orchestrator pulls/commits, job polls, event long poll) stayed within the manifest's maxSessions and was never refused
    assert.equal(mock.state.busyRejections, 0, 'the host (maxSessions from the manifest) never refused a call')
    assert.ok(mock.state.maxInFlight <= RESOURCES.maxSessions, `in flight peaked at ${mock.state.maxInFlight}`)
  } finally {
    await orch.stop()
    api.dispose()
    await backend.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
}

const todos = (api) => api.db.todos.list()

// ───────────── the main road ─────────────

test('e2e: a new LINE message becomes a todo — backend 供料 -> orchestrator -> ai:chat (```json reply) -> zod -> commit -> todos.list via the db.todos method', async () => {
  await withStack({}, async ({ api, line, mock, ai, calls, orch }) => {
    const seen = []
    api.pipeline.onTodosChanged((event) => seen.push(event))
    line.emit(raw(1, { text: '請幫我寄報價單給客戶，明天中午前' }))
    assert.deepEqual(await todos(api), [])
    assert.equal(orch.connected(), true)

    const run = await api.pipeline.runOnce()
    assert.equal(run.todosCreated, 0, 'the backend only 供料: it did not (and cannot) call an LLM')

    const created = await until(async () => { const list = await todos(api); return list.length === 1 ? list : null }, { message: 'the todo to appear' })
    assert.equal(created[0].title, '寄報價單給客戶')
    assert.equal(created[0].bucket, 'todo')
    assert.equal(created[0].chatId, 'u-alice')
    assert.deepEqual(created[0].sourceMsgIds, ['i:m1'])
    assert.ok(created[0].detail.startsWith('來自：請幫我寄報價單給客戶'))

    // what went over ai:chat: the real system prompt + the output contract with the real schema, and the real user payload
    assert.equal(calls.length, 1)
    assert.ok(calls[0].system.startsWith(EXTRACT_SYSTEM_PROMPT), 'system = EXTRACT_SYSTEM_PROMPT ...')
    assert.ok(calls[0].system.includes('【輸出格式') && calls[0].system.includes(JSON.stringify(EXTRACT_JSON_SCHEMA.schema)), '... + the output contract with the JSON schema')
    assert.ok(calls[0].system.length <= CONTRACT.limits.systemChars, `system ${calls[0].system.length} <= 16000`)
    assert.ok(calls[0].user.length <= CONTRACT.limits.inputChars, `user ${calls[0].user.length} <= 8000`)
    assert.ok(JSON.parse(calls[0].user).newMessages.some((m) => m.text.includes('報價單')))
    assert.equal(ai.stats.errors.rate_limited + ai.stats.errors.session_limit + ai.stats.errors.view_not_visible, 0)
    assert.equal(ai.control.liveSessions(), 0)

    await until(() => seen.length >= 1, { message: 'todos-changed event' })
    // the messages are processed: another cycle offers nothing and creates nothing
    await api.pipeline.runOnce()
    await sleep(150)
    assert.equal((await todos(api)).length, 1)
    assert.equal(calls.length, 1, 'no second AI round for already-processed messages')
    const stats = await api.plugin.extract.stats()
    assert.equal(stats.pending + stats.leased, 0)
    assert.ok(mock.state.maxInFlight <= RESOURCES.maxSessions, `in flight peaked at ${mock.state.maxInFlight} (manifest maxSessions ${RESOURCES.maxSessions})`)
  })
})

test('e2e: many chats at once are drained one session at a time, in 20-per-minute windows (shared fake clock), and every one ends up as a todo', async () => {
  // time is shared by the orchestrator and the mock host so the minute-long window runs fast; the backend still runs in real time
  let time = 5_000_000
  const clock = { now: () => time, timers: new Map(), next: 1, setTimeout(fn, ms) { const id = this.next++; this.timers.set(id, { at: time + ms, fn }); return id }, clearTimeout(id) { this.timers.delete(id) } }
  const advance = async (ms) => {
    const end = time + ms
    for (;;) {
      const due = [...clock.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      time = Math.max(time, due[1].at); clock.timers.delete(due[0]); due[1].fn(); await sleep(15)
    }
    time = end
    await sleep(15)
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'plugin-ai-e2e-q-'))
  const line = fakeLine()
  const ai = createMockTuqAi({ now: clock.now, reply: ({ user }) => fenced(todoFor(user, `處理 ${JSON.parse(user).chat.name}`)) })
  const backend = await createPluginBackend({ pluginId: 'p', version: '1', dataDir, line: line.port })
  const mock = makeBackendHost(backend)
  let orch = null
  const api = createPluginLineTodoApi({ host: mock.host, events: FAST_EVENTS, aiConnection: { connected: () => orch?.connected() ?? false } })
  const visibility = { isVisible: () => true, subscribe: () => () => {} }
  orch = createAiOrchestrator({ ai: ai.ai, extract: api.plugin.extract, tasks: api.plugin.aiTasks, visibility, clock, config: { extractReserve: 0, sendRetryMs: 1 } })
  try {
    for (let i = 1; i <= 24; i += 1) line.emit(raw(i, { chatId: `u-${i}`, chat: `客戶${i}`, text: `請回覆客戶${i}的報價問題` }))
    await api.pipeline.runOnce()
    orch.start()
    await until(() => ai.stats.sends >= 20, { message: '20 turns in the first window' })
    await sleep(100)
    assert.equal(ai.stats.sends, 20, 'the 21st turn waits for the window')
    assert.equal((await todos(api)).length, 20)
    await advance(60_400)
    await until(async () => (await todos(api)).length === 24, { message: 'the remaining 4 chats', timeout: 8000 })
    assert.equal(ai.stats.sends, 24)
    assert.equal(ai.stats.errors.rate_limited, 0)
    assert.equal(ai.stats.maxLiveSessions, 1)
    assert.deepEqual((await todos(api)).map((t) => t.chatId).sort(), Array.from({ length: 24 }, (_, i) => `u-${i + 1}`).sort())
  } finally {
    await orch.stop()
    api.dispose()
    await backend.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('e2e limits: a chat with far more text than one turn can carry is split by the backend into several turns, each within 8,000 chars (system within 16,000); every message is processed exactly once', async () => {
  const titles = ['寄報價單給客戶', '訂明天的會議室', '回覆廠商合約條款', '匯款給設計師', '更新官網banner', '預約牙醫看診', '整理報稅資料', '採購辦公室咖啡豆']
  let n = 0
  await withStack({ reply: ({ user }) => fenced(todoFor(user, titles[n++ % titles.length])) }, async ({ api, line, calls, ai }) => {
    for (let i = 1; i <= 30; i += 1) line.emit(raw(i, { chatId: 'u-big', chat: '大客戶', text: `第 ${i} 則：` + '很長的需求描述，'.repeat(60) }))
    await api.pipeline.runOnce()
    await until(async () => { const s = await api.plugin.extract.stats(); return calls.length >= 3 && s.pending + s.leased === 0 ? s : null }, { message: 'every part to be processed' })
    assert.ok(calls.length >= 3, `${calls.length} turns for ~20k chars of messages (each turn carries ~10 messages)`)
    for (const call of calls) {
      assert.ok(call.user.length <= CONTRACT.limits.inputChars, `user ${call.user.length} <= 8000`)
      assert.ok(call.system.length <= CONTRACT.limits.systemChars)
    }
    const covered = calls.flatMap((call) => JSON.parse(call.user).newMessages.map((m) => m.msgId))
    assert.equal(covered.length, 30, 'each message is sent once as a new message')
    assert.deepEqual([...new Set(covered)].sort(), Array.from({ length: 30 }, (_, i) => `i:m${i + 1}`).sort())
    assert.equal(ai.stats.errors.request_invalid, 0, 'the host never saw an over-long input')
    const list = await todos(api)
    assert.equal(list.length, calls.length, 'one todo per part')
    await api.pipeline.runOnce()
    await sleep(150)
    assert.equal(calls.length, list.length, 'nothing is sent twice')
  })
})

test('e2e throughput: a long chat (200 new messages x ~100 chars, with recentContext) is carried in turns that are nearly full — ~ new-message chars / per-turn budget, not one turn per message — each <= 7,500 chars', async () => {
  await withStack({ reply: ({ user }) => fenced({ importance: 'fyi', newTodos: [], resolved: [], updates: [] }) }, async ({ api, line, calls, ai }) => {
    const text = (i) => `第 ${i} 則：請幫我確認一下這件事情的進度，並且在明天中午之前回覆給客戶，謝謝。` + '補充說明內容。'.repeat(8)
    // 40 older messages first: they are processed, and become the recentContext of the next cycle
    for (let i = 1; i <= 40; i += 1) line.emit(raw(i, { chatId: 'u-long', chat: '長聊天室', isGroup: true, text: text(i) }))
    await api.pipeline.runOnce()
    await until(async () => { const s = await api.plugin.extract.stats(); return calls.length >= 1 && s.pending + s.leased === 0 }, { message: 'the first batch to be processed' })
    calls.length = 0
    for (let i = 41; i <= 240; i += 1) line.emit(raw(i, { chatId: 'u-long', chat: '長聊天室', isGroup: true, text: text(i) }))
    await api.pipeline.runOnce()
    await until(async () => { const s = await api.plugin.extract.stats(); return calls.length >= 1 && s.pending + s.leased === 0 }, { message: 'the long batch to be processed', timeout: 15_000 })
    const payloads = calls.map((c) => JSON.parse(c.user))
    const messageChars = payloads.flatMap((p) => p.newMessages).reduce((sum, m) => sum + JSON.stringify(m).length, 0)
    const lowerBound = Math.ceil(messageChars / CONTRACT.limits.inputChars)
    assert.equal(payloads.flatMap((p) => p.newMessages).length, 200, 'all 200 messages were sent, once each')
    assert.ok(calls.length >= lowerBound, `${calls.length} turns >= lower bound ${lowerBound}`)
    assert.ok(calls.length <= Math.ceil(lowerBound * 1.5) + 1, `${calls.length} turns for ${messageChars} chars of new messages (lower bound ${lowerBound}) — it used to be one turn per message`)
    for (const [index, call] of calls.entries()) {
      assert.ok(call.user.length <= 7500, `turn ${index + 1}: user ${call.user.length} <= 7,500`)
      assert.ok(call.user.length <= CONTRACT.limits.inputChars)
      assert.ok(payloads[index].recentContext.length > 0, `turn ${index + 1} carries recentContext`)
      assert.ok(JSON.stringify(payloads[index].recentContext).length <= 1500 + 50, `turn ${index + 1}: recentContext is capped at ~20% of a turn (${JSON.stringify(payloads[index].recentContext).length} chars)`)
    }
    assert.equal(ai.stats.errors.request_invalid, 0, 'the host never saw an over-long input')
  })
})

test('e2e visibility: hidden board = no AI work (the lease stays in the backend, no session, no todo); visible again = it completes', async () => {
  await withStack({}, async ({ api, line, ai, visibility, calls, mock }) => {
    visibility.set(false)
    line.emit(raw(1, { text: '請幫我確認會議室' }))
    await api.pipeline.runOnce()
    await sleep(300)
    assert.deepEqual(await todos(api), [])
    assert.equal(ai.stats.openSession + ai.stats.sends, 0)
    assert.equal(calls.length, 0)
    const hiddenPulls = mock.count('extract.pull')
    visibility.set(true)
    await until(async () => (await todos(api)).length === 1, { message: 'the todo after the board became visible' })
    assert.ok(mock.count('extract.pull') > hiddenPulls)
  })
})

test('e2e: the host says view_not_visible although the page looks visible — the item is released to the backend without any penalty and completes later', async () => {
  await withStack({}, async ({ api, line, ai }) => {
    ai.control.visible = false
    line.emit(raw(1, { text: '請幫我訂便當' }))
    await api.pipeline.runOnce()
    await until(() => ai.stats.errors.view_not_visible >= 1, { message: 'the host refusal' })
    const stats = await api.plugin.extract.stats()
    assert.equal(stats.chatsBackingOff, 0, 'no per-chat backoff for a visibility problem')
    assert.deepEqual(await todos(api), [])
    ai.control.visible = true
    await until(async () => (await todos(api)).length === 1, { message: 'the todo once the host allows it' })
  })
})

test('e2e: extract.release returns a lease with no penalty (attempts unchanged, no backoff), and a commit for a released lease is refused', async () => {
  await withStack({ start: false }, async ({ api, line }) => {
    line.emit(raw(1, { text: '請幫我處理報銷' }))
    await api.pipeline.runOnce()
    const first = await api.plugin.extract.pull({ max: 1 })
    assert.equal(first.items.length, 1)
    assert.equal(first.items[0].attempts, 0)
    const released = await api.plugin.extract.release([first.items[0].itemId, 'not-a-lease'])
    assert.deepEqual(released, { released: 1, unknown: ['not-a-lease'] })
    const stats = await api.plugin.extract.stats()
    assert.equal(stats.chatsBackingOff, 0)
    const again = await api.plugin.extract.pull({ max: 1 })
    assert.equal(again.items.length, 1, 'immediately available again')
    assert.equal(again.items[0].attempts, 0)
    const stale = await api.plugin.extract.commit([{ itemId: first.items[0].itemId, ok: true, result: { importance: 'noise', newTodos: [], resolved: [], updates: [] } }])
    assert.equal(stale.results[0].status, 'unknown_item')
  })
})

test('e2e: a model reply that is not usable never reaches the todo list — bad JSON (after one repair) and schema-invalid JSON fail the chat; the messages stay unprocessed and the backend backs the chat off', async () => {
  await withStack({ reply: () => '我整理了一下，但格式可能不太對 {importance: action', backend: { extract: { retryBaseMs: 60_000 } } }, async ({ api, line, ai, calls }) => {
    line.emit(raw(1, { text: '請幫我寄合約' }))
    await api.pipeline.runOnce()
    await until(async () => (await api.plugin.extract.stats()).chatsBackingOff === 1, { message: 'the chat to be backed off' })
    assert.equal(ai.stats.sends, 2, 'first reply + one repair')
    assert.match(calls[1].user, /不是合法的 JSON/)
    assert.deepEqual(await todos(api), [])
    assert.equal(ai.control.liveSessions(), 0)
    const stats = await api.plugin.extract.stats()
    assert.equal(stats.pending, 1, 'the messages are still waiting (unprocessed)')
  })
  await withStack({ reply: () => JSON.stringify({ importance: 'action', newTodos: [{ bucket: 'todo', title: '', priority: 2, confidence: 0.5, sourceMsgIds: ['i:m1'] }], resolved: [], updates: [] }), backend: { extract: { retryBaseMs: 60_000 } } }, async ({ api, line, ai }) => {
    line.emit(raw(1, { text: '請幫我寄合約' }))
    await api.pipeline.runOnce()
    await until(async () => (await api.plugin.extract.stats()).chatsBackingOff === 1, { message: 'the chat to be backed off' })
    assert.deepEqual(await todos(api), [])
    assert.equal(ai.stats.sends, 2)
  })
})

test('e2e: revoking the ai:chat permission stops extraction for good and every AI feature says how to fix it — without calling the backend for them', async () => {
  await withStack({}, async ({ api, line, ai, orch, mock }) => {
    await orch.idle()
    ai.control.revoke()
    line.emit(raw(1, { text: '請幫我回電話' }))
    await api.pipeline.runOnce()
    await until(() => orch.status().state === 'revoked', { message: 'revoked state' })
    assert.equal(orch.connected(), false)
    assert.deepEqual(await todos(api), [])
    const draft = await api.db.todos.draftReply('whatever')
    assert.match(draft.error, /ai:chat/)
    assert.equal(mock.count('ai.run'), 0, 'not sent to the backend')
    const review = await api.pipeline.reviewLastDays(3)
    assert.equal(review.ok, false)
    assert.equal(review.hasApiKey, true, 'the UI must not ask for an API key')
    assert.match(review.note, /ai:chat/)
    assert.equal(mock.count('pipeline.reviewLastDays'), 0)
    assert.equal(ai.stats.sends, 0)
  })
})

// ───────────── the three user actions, bridged through backend `ai.run` ─────────────

async function seedTodo(api, line) {
  line.emit(raw(1, { text: '請幫我寄報價單給客戶' }))
  await api.pipeline.runOnce()
  return (await until(async () => { const list = await todos(api); return list.length === 1 ? list : null }, { message: 'a seeded todo' }))[0]
}

test('e2e draftReply: backend builds the prompt from its own data, the orchestrator asks ai:chat, the draft comes back through the ai method group ; the backend never calls an LLM', async () => {
  await withStack({
    reply: (ctx) => (ctx.system.includes('草擬') ? '  好的，報價單我今天下午寄出，再請您確認。\n' : fenced(todoFor(ctx.user)))
  }, async ({ api, line, calls, mock }) => {
    const todo = await seedTodo(api, line)
    const result = await api.db.todos.draftReply(todo.id)
    assert.deepEqual(result, { draft: '好的，報價單我今天下午寄出，再請您確認。' })
    const draftCall = calls.find((c) => c.system.includes('草擬'))
    assert.ok(draftCall, 'the draft prompt reached ai:chat')
    const payload = JSON.parse(draftCall.user)
    assert.equal(payload['代辦標題'], '寄報價單給客戶')
    assert.ok(payload['最近對話'].some((line_) => line_.includes('請幫我寄報價單給客戶')), 'recent conversation comes from the backend DB')
    assert.equal(mock.count('ai.run'), 1)
    assert.ok(mock.count('ai.pull') >= 1 && mock.count('ai.commit') >= 1)
    assert.equal(calls.filter((c) => c.system.includes('草擬')).length, 1)
  })
})

test('e2e draftReply failures are explicit and friendly: model refuses (empty reply), board hidden, quota exhausted — never a fake draft', async () => {
  await withStack({ reply: (ctx) => (ctx.system.includes('草擬') ? { empty: true } : fenced(todoFor(ctx.user))) }, async ({ api, line }) => {
    const todo = await seedTodo(api, line)
    const result = await api.db.todos.draftReply(todo.id)
    assert.equal(result.draft, undefined)
    assert.match(result.error, /沒有回覆內容/)
  })
  await withStack({}, async ({ api, line, ai }) => {
    const todo = await seedTodo(api, line)
    ai.control.exhaustQuota(60_000)
    const result = await api.db.todos.draftReply(todo.id)
    assert.match(result.error, /額度已用完/)
    assert.equal(ai.stats.sends, 1, 'only the seeding turn; the quota check came first')
  })
  await withStack({}, async ({ api, line, ai }) => {
    const todo = await seedTodo(api, line)
    ai.control.visible = false
    const result = await api.db.todos.draftReply(todo.id)
    assert.match(result.error, /看板不在前景/)
  })
})

test('e2e F8: a very long Chinese draft (more than fits one request) is trimmed by the view to what ai.commit can carry — it is delivered with a visible mark instead of being lost; an over-long JSON answer fails with reply_too_long', async () => {
  const long = '您好，關於報價單的說明如下。'.repeat(1800) // ~ 23,400 characters ~ 70 KB: above the 60 KiB request limit, below the 32,000-character ai:chat reply cap
  assert.ok(new TextEncoder().encode(long).byteLength > 60 * 1024)
  await withStack({ reply: (ctx) => (ctx.system.includes('草擬') ? long : fenced(todoFor(ctx.user))) }, async ({ api, line, mock }) => {
    const todo = await seedTodo(api, line)
    const result = await api.db.todos.draftReply(todo.id)
    assert.equal(result.error, undefined, 'the draft is delivered, not lost to request_too_large and a lease timeout')
    assert.ok(result.draft.endsWith('（回覆過長，已截斷）'))
    assert.ok(result.draft.startsWith('您好，關於報價單的說明如下。'))
    assert.ok(new TextEncoder().encode(result.draft).byteLength <= 48 * 1024)
    assert.equal(mock.count('ai.commit'), 1, 'one commit, accepted')
  })
  const bigJson = JSON.stringify({ inferredCauseCode: 'general_announcement', summary: '很長'.repeat(12_000), suggestedCondition: 'x', suggestedEffect: 'y' })
  await withStack({ reply: (ctx) => (ctx.system.includes('分類誤判分析') ? '```json\n' + bigJson + '\n```' : fenced(todoFor(ctx.user))) }, async ({ api, line }) => {
    const todo = await seedTodo(api, line)
    const marked = await api.db.todos.markNotMine(todo.id, 'general_announcement', '只是公告')
    const analysis = await api.db.todos.analyzeNotMine(marked.feedbackId)
    assert.equal(analysis.ok, false)
    assert.match(String(analysis.reason), /過長/, 'a JSON answer is never cut: it fails with the reply_too_long message')
  })
})

test('e2e analyzeNotMine: the fenced JSON from ai:chat is cleaned by the orchestrator, validated and SAVED by the backend\'s own logic (analysis shows up in the review)', async () => {
  await withStack({
    reply: (ctx) => (ctx.system.includes('分類誤判分析') ? '```json\n' + JSON.stringify({ inferredCauseCode: 'general_announcement', summary: '這是群組公告，不需要我處理', suggestedCondition: '群組公告類訊息', suggestedEffect: '不要產生待辦' }) + '\n```' : fenced(todoFor(ctx.user)))
  }, async ({ api, line, calls }) => {
    const todo = await seedTodo(api, line)
    const marked = await api.db.todos.markNotMine(todo.id, 'general_announcement', '只是公告')
    assert.equal(marked.ok, true)
    const result = await api.db.todos.analyzeNotMine(marked.feedbackId)
    assert.equal(result.ok, true)
    assert.equal(result.inferredCauseCode, 'general_announcement')
    assert.equal(result.summary, '這是群組公告，不需要我處理')
    assert.equal(result.providerId, 'codexCli')
    assert.equal(result.modelId, 'gpt-5-codex')
    const review = await api.db.todos.getNotMineReview(marked.feedbackId)
    assert.equal(review.analysis.summary, '這是群組公告，不需要我處理')
    assert.equal(review.analysis.suggestedCondition, '群組公告類訊息')
    const analysisCall = calls.find((c) => c.system.includes('分類誤判分析'))
    assert.ok(JSON.parse(analysisCall.user).evidence.length >= 1, 'the evidence came from the backend DB')
  })
  await withStack({ reply: (ctx) => (ctx.system.includes('分類誤判分析') ? '我認為這是公告。' : fenced(todoFor(ctx.user))) }, async ({ api, line }) => {
    const todo = await seedTodo(api, line)
    const marked = await api.db.todos.markNotMine(todo.id, 'other')
    const result = await api.db.todos.analyzeNotMine(marked.feedbackId)
    assert.equal(result.ok, false, 'not JSON even after the repair turn: nothing is saved')
    assert.equal((await api.db.todos.getNotMineReview(marked.feedbackId)).analysis, null)
  })
})

test('e2e groupTopics.analyze: the JSON Schema is put in the prompt (no structured output on ai:chat), the reply is validated by the backend\'s domain validator and saved as a topic', async () => {
  await withStack({
    reply: (ctx) => {
      if (!ctx.system.includes('ONE group chat')) return fenced(todoFor(ctx.user))
      const payload = JSON.parse(ctx.user)
      return '```json\n' + JSON.stringify({
        topics: [{ ref: 'launch', title: '產品發表會', summary: '討論發表會的場地與時間。' }],
        assignments: payload.messages.map((m) => ({ msgId: m.msgId, topicRef: 'launch', relation: 'about', confidence: 0.8, relevance: 'awareness', relevanceEvidenceMsgIds: [m.msgId] }))
      }) + '\n```'
    }
  }, async ({ api, line, calls }) => {
    for (let i = 1; i <= 3; i += 1) line.emit(raw(i, { chatId: 'g-launch', chat: '發表會籌備群', isGroup: true, text: `發表會場地第 ${i} 案要不要訂？` }))
    await until(async () => (await api.db.chats.get('g-launch')) !== null, { message: 'the group chat to be persisted' })
    assert.deepEqual(await api.groupTopics.setEnabled('g-launch', true), { ok: true })
    assert.equal(await api.groupTopics.pendingCount('g-launch') > 0, true)
    const analysis = await api.groupTopics.analyze('g-launch')
    assert.equal(analysis.ok, true, JSON.stringify(analysis))
    assert.equal(analysis.analyzedCount, 3)
    const listed = await api.groupTopics.list('g-launch')
    assert.equal(listed.topics.length, 1)
    assert.equal(listed.topics[0].title, '產品發表會')
    const topicCall = calls.find((c) => c.system.includes('ONE group chat'))
    assert.ok(topicCall.system.includes('【輸出格式') && topicCall.system.includes('"msgId"') && topicCall.system.includes('i:m1'), 'the per-batch JSON Schema (with the msgId enum) is in the prompt')
    assert.ok(topicCall.user.length <= CONTRACT.limits.inputChars)
  })
  // invalid output (an assignment for a message that was never sent) is rejected by the backend and nothing is saved
  await withStack({
    reply: (ctx) => (ctx.system.includes('ONE group chat') ? JSON.stringify({ topics: [], assignments: [{ msgId: 'ghost', topicRef: null, relation: 'uncertain', confidence: 0.1, relevance: 'unknown', relevanceEvidenceMsgIds: [] }] }) : fenced(todoFor(ctx.user)))
  }, async ({ api, line }) => {
    line.emit(raw(1, { chatId: 'g-x', chat: '群', isGroup: true, text: '大家好' }))
    await until(async () => (await api.db.chats.get('g-x')) !== null, { message: 'chat persisted' })
    await api.groupTopics.setEnabled('g-x', true)
    const analysis = await api.groupTopics.analyze('g-x')
    assert.equal(analysis.ok, false)
    assert.equal(analysis.failure?.stage, 'domain_validate')
    assert.deepEqual((await api.groupTopics.list('g-x')).topics, [])
  })
})

test('e2e reviewLastDays: with the orchestrator connected the long review rides the job + extract channel to the end (this was "尚未接上" in Phase 3)', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'plugin-ai-e2e-review-'))
  const fake = fakeLine()
  fake.port.getMessagesSince = async () => [raw(1, { text: '提醒我週五前交付報告', ts: Date.now() - 1000 }), raw(2, { text: '另外發票也要開', ts: Date.now() - 500 })]
  const backend = await createPluginBackend({ pluginId: 'p', version: '1', dataDir, line: fake.port, dispatcher: { softDeadlineMs: 30, maxJobWaitMs: 200 } })
  const host = makeBackendHost(backend)
  // Codex takes ~100 ms, longer than the backend's 30 ms soft deadline: the long call turns into a job the adapter polls
  const ai = createMockTuqAi({ reply: ({ user }) => ({ text: fenced(todoFor(user, '交付週五報告')), delay: () => sleep(100) }) })
  let orch = null
  const api = createPluginLineTodoApi({ host: host.host, events: FAST_EVENTS, jobPollWaitMs: 100, aiConnection: { connected: () => orch?.connected() ?? false, note: () => orch?.note() } })
  const visibility = { isVisible: () => true, subscribe: () => () => {} }
  orch = createAiOrchestrator({ ai: ai.ai, extract: api.plugin.extract, tasks: api.plugin.aiTasks, visibility, config: FAST_ORCH })
  try {
    // before the orchestrator starts: honest "not connected", no 15-minute wait
    const early = await api.pipeline.reviewLastDays(7)
    assert.equal(early.ok, false)
    orch.start()
    const review = await api.pipeline.reviewLastDays(7)
    assert.equal(review.ok, true, JSON.stringify(review))
    assert.equal(review.todosCreated, 1)
    assert.deepEqual((await todos(api)).map((t) => t.title), ['交付週五報告'])
    assert.ok(host.count('job.poll') >= 1, 'the long call became a job')
  } finally {
    await orch.stop()
    api.dispose()
    await backend.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ───────────── host.ts wiring ─────────────

test('board.ts / host.ts: bootBoard wires adapter + visibility + orchestrator for the board view, nothing for the settings view; pagehide stops and releases', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'plugin-ai-e2e-host-'))
  const line = fakeLine()
  const backend = await createPluginBackend({ pluginId: 'tuqdev.line-todo', version: '1', dataDir, line: line.port, dispatcher: { softDeadlineMs: 40, maxJobWaitMs: 300 } })
  const { host } = makeBackendHost(backend)
  const ai = createMockTuqAi({ reply: ({ user }) => fenced(todoFor(user)) })
  const handlers = new Map()
  const doc = { visibilityState: 'visible', addEventListener(type, cb) { handlers.set(`doc:${type}`, cb) }, removeEventListener(type) { handlers.delete(`doc:${type}`) } }
  const saved = { window: globalThis.window, document: globalThis.document }
  try {
    globalThis.document = doc
    globalThis.window = { tuqPlugin: { ...host, ai: ai.ai, presentation: { get: async () => ({ visible: true }), onChange: () => () => {} } }, addEventListener: (type, cb) => handlers.set(`window:${type}`, cb) }
    const boot = bootBoard()
    assert.ok(boot?.orchestrator, 'board view: orchestrator created')
    assert.equal(boot.api.plugin.transportStats().limit, 3, 'review F1: the board view budget is 3 host calls (event long poll included)')
    assert.equal(boot.orchestrator.status().state === 'running' || boot.orchestrator.status().state === 'paused', true)
    assert.equal(boot.orchestrator.connected(), true)

    // it works end to end through host.ts's wiring
    line.emit(raw(1, { text: '請幫我寄報價單給客戶' }))
    await boot.api.pipeline.runOnce()
    await until(async () => (await boot.api.db.todos.list()).length === 1, { message: 'a todo via bootPluginApi' })

    // page hidden -> the visibility source follows document.visibilityState
    doc.visibilityState = 'hidden'
    handlers.get('doc:visibilitychange')()
    await until(() => boot.orchestrator.status().reason === 'view_hidden', { message: 'hidden status' })
    doc.visibilityState = 'visible'
    handlers.get('doc:visibilitychange')()
    await until(() => boot.orchestrator.status().state === 'running', { message: 'running again' })

    handlers.get('window:pagehide')()
    await until(() => boot.orchestrator.status().state === 'stopped', { message: 'orchestrator stopped on pagehide' })
    await until(async () => { try { await boot.api.ping(); return false } catch (error) { return error.code === 'disposed' } }, { message: 'api disposed after pagehide' })
    assert.equal(ai.control.liveSessions(), 0)

    // the settings view: same adapter, but no orchestrator (a second webContents must not fight for the single ai:chat session) and AI features say "not connected"
    handlers.clear()
    const settingsBoot = bootPluginApi()
    assert.equal(settingsBoot.orchestrator, undefined, 'the settings boot has no orchestrator at all')
    assert.deepEqual(await settingsBoot.api.db.todos.draftReply('x'), { error: PLUGIN_AI_NOT_CONNECTED })
    settingsBoot.api.dispose()
    // the way settings.tsx boots: budget 1 and no event long poll, so board (3) + settings (1) = the manifest's maxSessions (4)
    const settingsView = bootPluginApi({ maxConcurrentCalls: 1, events: false })
    assert.equal(settingsView.api.plugin.transportStats().limit, 1)
    const off = settingsView.api.pipeline.onStatus(() => undefined)
    await sleep(60)
    assert.equal(settingsView.api.plugin.eventsStats().running, false, 'the settings view never starts an event long poll')
    assert.equal(settingsView.api.plugin.eventsStats().pulls, 0)
    off()
    settingsView.api.dispose()

    // a TeamUQ without ai:chat: board view still works, AI features explain why
    handlers.clear()
    globalThis.window = { tuqPlugin: { ...host }, addEventListener: (type, cb) => handlers.set(`window:${type}`, cb) }
    const noAi = bootBoard()
    assert.equal(noAi.orchestrator, null)
    assert.match((await noAi.api.db.todos.draftReply('x')).error, /沒有提供 ai:chat/)
    assert.equal((await noAi.api.pipeline.reviewLastDays(1)).ok, false)
    noAi.api.dispose()

    // not inside TeamUQ at all
    globalThis.window = {}
    assert.equal(bootBoard(), null)
    assert.equal(bootPluginApi(), null)
  } finally {
    globalThis.window = saved.window
    globalThis.document = saved.document
    await backend.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
