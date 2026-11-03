// 0.2.0 — end to end: a mock `context.host.ai` (Core 1.7.15 semantics, scripts/lib/mock-tuq-ai.mjs) + the REAL backend (createPluginBackend on a fake LINE port, app DB = node:sqlite
// test adapter) + the REAL view adapter (createPluginLineTodoApi) for the screens that only READ the result. The AI runs inside the backend (HostAiPort + ExtractWorker), so:
//
//   message -> backend pipeline (供料) -> ExtractWorker -> host.ai.complete (system + format + user payload, reply with ```json fences) -> parse + zod -> queue.commit
//   -> backend persists -> todos.list / todos-changed
//
// plus the user actions (草擬回覆、誤判分析、群組議題分析、prompt 修正) as plain backend calls, quota / revocation / provider outages (no item is lost), review (reviewLastDays), a
// backend restart in the middle of a backlog, and the view wiring (the view never touches window.tuqPlugin.ai). No test here opens a board view for the AI to run.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { EXTRACT_SYSTEM_PROMPT } from '../../src/main/llm/extractPrompt.ts'
import { EXTRACT_JSON_SCHEMA } from '../../src/main/llm/schema.ts'
import { createPluginBackend } from '../../src/plugin/backend/assemble.ts'
import { bootBoard } from '../../src/plugin/ui/board.ts'
import { bootPluginApi } from '../../src/plugin/ui/host.ts'
import { createPluginLineTodoApi } from '../../src/renderer/platform/pluginApi.ts'
import { backendMethodFor } from '../../src/shared/pluginWire.ts'
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
/** Real-time knobs for a run that does not use the fake clock. */
const FAST_AI = { busyRetryMs: 10, busyBackoffMs: 50, providerRetryMs: 150, rateBackoffBaseMs: 40, rateBackoffMaxMs: 160, quotaDefaultMs: 300, revokedProbeMs: 120, optionsTtlMs: 20 }
const FAST_WORKER = { pollIntervalMs: 60, unavailableRetryMs: 40 }

/** The JSON a model would give for the payload our backend really sent (it cites the real msgId). */
function todoFor(user, title = '寄報價單給客戶') {
  const payload = JSON.parse(user)
  const first = payload.newMessages[0]
  const draftRef=`e2e_${String(first.msgId).replace(/[^a-z0-9_-]/giu,'_')}`
  return { importance: 'action', newTodos: [{ draftRef,bucket: 'todo', title, detail: `來自：${first.text.slice(0, 20)}`, priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds: [first.msgId] }], identityDecisions:[{draftRef,outcome:'new',candidateType:null,candidateId:null,relationKind:null,reasonCode:'insufficient_evidence',confidenceBand:'high',evidenceMsgIds:[first.msgId]}], resolved: [], updates: [] }
}
const fenced = (value) => '好的，整理如下：\n```json\n' + JSON.stringify(value, null, 2) + '\n```\n'

/** A backend with the AI wired the way index.ts wires it (`hostAi: context.host.ai`), and a view adapter that only reads. */
async function withStack(options, body) {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'plugin-ai-e2e-'))
  if (options.settings) writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(options.settings))
  const line = fakeLine()
  const calls = []
  const ai = createMockTuqAi({
    now: options.clock?.now,
    reply: (ctx) => { calls.push(ctx); return (options.reply ?? ((c) => fenced(todoFor(c.user))))(ctx) }
  })
  options.setup?.(ai)
  const backend = await createPluginBackend({
    pluginId: 'tuqdev.line-todo', version: '4.0.0', dataDir, line: line.port, extract: { retryBaseMs: 30 },
    dispatcher: { softDeadlineMs: 40, maxJobWaitMs: 300 }, hostAi: ai.ai,
    ai: { ...(options.clock ? { clock: options.clock } : {}), config: { ...FAST_AI, ...options.ai }, worker: { ...FAST_WORKER, ...options.worker } },
    ...options.backend
  })
  const mock = makeBackendHost(backend)
  const api = createPluginLineTodoApi({ host: mock.host, events: FAST_EVENTS, jobPollWaitMs: 100 })
  if (options.selection) await api.hostAi.setSelection(options.selection)
  try {
    await body({ api, backend, line, mock, ai, calls, dataDir })
    // review F1: in every scenario the board view (job polls, event long poll, status reads) stayed within the manifest's maxSessions and was never refused
    assert.equal(mock.state.busyRejections, 0, 'the host (maxSessions from the manifest) never refused a call')
    assert.ok(mock.state.maxInFlight <= RESOURCES.maxSessions, `in flight peaked at ${mock.state.maxInFlight}`)
    assert.equal(ai.control.liveSessions(), 0, 'no AI Session is left open')
  } finally {
    api.dispose()
    await backend.dispose()
    if (!options.dataDir) rmSync(dataDir, { recursive: true, force: true })
  }
}

const todos = (api) => api.db.todos.list()
const stats = (api) => api.plugin.extract.stats()
const aiState = async (api) => (await api.plugin.aiStatus())

async function seedTodo(api, line) {
  line.emit(raw(1, { text: '請幫我寄報價單給客戶' }))
  await api.pipeline.runOnce()
  return (await until(async () => { const list = await todos(api); return list.length === 1 ? list : null }, { message: 'a seeded todo' }))[0]
}

// ───────────── the headline: no view, no board ─────────────

test('(a) e2e without any view: the backend alone — scheduler cycle -> ExtractWorker -> host.ai.complete -> todo in the database. No board, no events session, no RPC from a view while the AI works', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'plugin-ai-e2e-noview-'))
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ pollIntervalSec: 5 })) // the scheduler's own timer offers new messages every 5 s (the minimum)
  const line = fakeLine()
  const ai = createMockTuqAi({ reply: (ctx) => fenced(todoFor(ctx.user)) })
  const backend = await createPluginBackend({ pluginId: 'tuqdev.line-todo', version: '4.0.0', dataDir, line: line.port, hostAi: ai.ai, ai: { config: FAST_AI, worker: FAST_WORKER } })
  let viewCalls = 0
  const call = (method, params) => { viewCalls += 1; return backend.call(method, params) }
  try {
    line.emit(raw(1, { text: '請幫我寄報價單給客戶，明天中午前' }))
    // nobody calls the backend: no board, no event long poll, no ai.* / extract.* RPC
    await until(() => ai.stats.completes >= 1, { timeout: 12_000, step: 50, message: 'the AI turn made by the backend on its own' })
    assert.equal(viewCalls, 0, 'not one backend.call from a view happened before the AI had done its work')
    assert.equal(backend.diagnostics().eventSessions, 0, 'no view event session exists')
    // the result is in the database: read it the way a board would, afterwards
    const list = await until(async () => { const r = await call(backendMethodFor('db.todos.list'), { path: 'db.todos.list', args: [] }); return r.ok && r.value.length === 1 ? r.value : null }, { message: 'the todo in the database' })
    assert.equal(list[0].title, '寄報價單給客戶')
    assert.equal(list[0].chatId, 'u-alice')
    assert.equal(ai.stats.turns.length, 1)
    assert.equal(ai.stats.errors.rate_limited + ai.stats.errors.session_limit + ai.stats.errors.view_not_visible, 0)
    assert.equal(ai.control.liveSessions(), 0)
    const status = (await call('ai', { path: 'ai.status', args: [] })).value
    assert.equal(status.state, 'running')
    assert.equal(status.counters.extracted, 1)
    assert.equal(status.counters.turns, 1)
  } finally {
    await backend.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ───────────── the main road ─────────────

test('e2e: a new LINE message becomes a todo — backend 供料 -> ExtractWorker -> host.ai.complete (```json reply) -> zod -> commit -> todos.list via the db.todos method', async () => {
  await withStack({}, async ({ api, line, mock, ai, calls }) => {
    const seen = []
    api.pipeline.onTodosChanged((event) => seen.push(event))
    line.emit(raw(1, { text: '請幫我寄報價單給客戶，明天中午前' }))
    assert.deepEqual(await todos(api), [])
    await until(async () => (await aiState(api)).state === 'running', { message: 'the AI to be ready' })

    const run = await api.pipeline.runOnce()
    assert.equal(run.todosCreated, 0, 'the pipeline cycle only 供料; the worker does the AI turn afterwards')

    const created = await until(async () => { const list = await todos(api); return list.length === 1 ? list : null }, { message: 'the todo to appear' })
    assert.equal(created[0].title, '寄報價單給客戶')
    assert.equal(created[0].bucket, 'todo')
    assert.equal(created[0].chatId, 'u-alice')
    assert.deepEqual(created[0].sourceMsgIds, ['i:m1'])
    assert.ok(created[0].detail.startsWith('來自：請幫我寄報價單給客戶'))

    // what went over host.ai.complete: the real system prompt + the output contract with the real schema, and the real user payload
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
    const queue = await stats(api)
    assert.equal(queue.pending + queue.leased, 0)
    const status = await aiState(api)
    assert.equal(status.counters.extracted, 1)
    assert.equal(status.queue.pending + status.queue.leased, 0)
    // the view never had a way to drive the AI
    for (const path of ['ai.pull', 'ai.commit', 'ai.run', 'extract.pull', 'extract.commit', 'extract.system']) assert.equal(mock.count(path), 0, path)
    assert.ok(mock.state.maxInFlight <= RESOURCES.maxSessions)
  })
})

test('(e) e2e contentSaved: a turn whose events include contentSaved (new in 1.7.15) is an ordinary turn for line-todo — the todo is created, nothing errors, nothing is retried', async () => {
  await withStack({ reply: (ctx) => ({ text: fenced(todoFor(ctx.user)), events: ['contentSaved'] }) }, async ({ api, line, ai, calls }) => {
    const todo = await seedTodo(api, line)
    assert.equal(todo.title, '寄報價單給客戶')
    assert.ok(ai.stats.droppedEvents.some((entry) => entry.event.kind === 'contentSaved'), 'the host really sent contentSaved for the turn')
    assert.equal(calls.length, 1, 'no retry')
    const status = await aiState(api)
    assert.equal(status.state, 'running')
    assert.equal(status.counters.failed, 0)
    assert.equal(status.counters.released, 0)
  })
})

test('saved TeamUQ model and effort reach extraction and reply calls; an unavailable selected model pauses without fallback and says so', async () => {
  await withStack({
    selection: { providerId: 'codex', modelId: 'gpt-5-codex', effort: 'high' },
    reply: (ctx) => (ctx.system.includes('草擬') ? '已收到，我今天處理。' : fenced(todoFor(ctx.user)))
  }, async ({ api, line, ai }) => {
    const todo = await seedTodo(api, line)
    assert.deepEqual([ai.stats.turns[0].modelId, ai.stats.turns[0].effort], ['gpt-5-codex', 'high'])
    await api.hostAi.setSelection({ providerId: 'codex', modelId: 'gpt-5-codex', effort: 'low' })
    assert.deepEqual(await api.db.todos.draftReply(todo.id), { draft: '已收到，我今天處理。' })
    assert.equal(ai.stats.turns.at(-1).effort, 'low', 'the new selection applies to the next call, no restart')
    const completes = ai.stats.completes
    await api.hostAi.setSelection({ providerId: 'codex', modelId: 'removed-model', effort: null })
    const unavailable = await api.db.todos.draftReply(todo.id)
    assert.match(unavailable.error, /Codex 目前無法使用/)
    assert.equal(ai.stats.completes, completes, 'no call is made with a different model')
    const status = await until(async () => { const s = await aiState(api); return s.reason === 'model_unavailable' ? s : null }, { message: 'removed model is reported' })
    assert.equal(status.state, 'unavailable')
    assert.deepEqual(await api.hostAi.getSelection(), { providerId: 'codex', modelId: 'removed-model', effort: null })
    // the settings screen reads the host's model list through the backend
    const options = await api.hostAi.getOptions()
    assert.equal(options.providers[0].models[0].id, 'gpt-5-codex')
    assert.equal(options.limits.turnsPerMinute, CONTRACT.limits.turnsPerMinute)
  })
})

test('A20 e2e: a per-chat prompt and name saved through the view API reach host.ai.complete only for that chat; the other chat keeps the default prompt plus the default name; a reset brings it back', async () => {
  const marker = 'ALICE_ONLY_RULE_9f3a'
  await withStack({
    selection: { providerId: 'codex', modelId: 'gpt-5-codex', effort: 'high' },
    reply: (ctx) => fenced(todoFor(ctx.user, '測試待辦'))
  }, async ({ api, line, ai, calls }) => {
    const state = await api.hostAi.prompts.get()
    await api.hostAi.prompts.saveName('預設小明', state.nameRevision)
    line.emit(raw(1, { chatId: 'u-alice', chat: 'Alice', text: '艾莉絲的請託：請寄報價單' }))
    line.emit(raw(2, { chatId: 'u-bob', chat: 'Bob', text: '鮑勃的請託：請寄報價單' }))
    const alice = await api.hostAi.chatPrompts.get('u-alice')
    assert.equal(alice.promptSource, 'default')
    const saved = await api.hostAi.chatPrompts.save('u-alice', { prompt: `${marker} 只看艾莉絲的對話`, myName: '艾莉絲專用名' }, alice.revision)
    assert.deepEqual([saved.promptSource, saved.nameSource, saved.effectiveName], ['chat', 'chat', '艾莉絲專用名'])
    assert.deepEqual((await api.hostAi.chatPrompts.list()).map((item) => item.chatId), ['u-alice'])
    await api.pipeline.runOnce()
    await until(async () => (await aiState(api)).counters.extracted >= 2, { message: 'both chats extracted' })
    const systemFor = (needle) => calls.find((call) => call.user.includes(needle)).system
    const aliceSystem = systemFor('艾莉絲的請託')
    const bobSystem = systemFor('鮑勃的請託')
    assert.ok(aliceSystem.startsWith(marker), 'alice: her own prompt replaces the default completely')
    assert.ok(!aliceSystem.includes(EXTRACT_SYSTEM_PROMPT))
    assert.ok(aliceSystem.includes(JSON.stringify('艾莉絲專用名')) && !aliceSystem.includes('預設小明'))
    assert.ok(bobSystem.startsWith(EXTRACT_SYSTEM_PROMPT), 'bob: the default prompt')
    assert.ok(bobSystem.includes(JSON.stringify('預設小明')) && !bobSystem.includes(marker))
    for (const system of [aliceSystem, bobSystem]) {
      assert.ok(system.endsWith(state.outputFormat), 'the fixed output contract stays last')
      assert.ok(system.length <= CONTRACT.limits.systemChars)
    }
    // the next item of alice uses the reset value at once, without a restart
    const reset = await api.hostAi.chatPrompts.reset('u-alice', saved.revision)
    assert.equal(reset.promptSource, 'default')
    line.emit(raw(3, { chatId: 'u-alice', chat: 'Alice', text: '艾莉絲的第二件請託：請寄合約' }))
    await api.pipeline.runOnce()
    await until(async () => (await aiState(api)).counters.extracted >= 3, { message: 'third extraction' })
    const after = systemFor('艾莉絲的第二件請託')
    assert.ok(after.startsWith(EXTRACT_SYSTEM_PROMPT) && after.includes(JSON.stringify('預設小明')) && !after.includes(marker))
    await assert.rejects(api.hostAi.chatPrompts.reset('u-alice', saved.revision), /prompt_conflict/)
    await assert.rejects(api.hostAi.chatPrompts.get('u-ghost'), /chat_unknown/)
  })
})

test('prompt refinement runs in the backend, needs adoption, and the next extraction already uses the saved prompt', async () => {
  let initialPrompt
  const marker = 'CUSTOM_PROMPT_RULE_FOR_NEXT_EXTRACTION'
  await withStack({
    selection: { providerId: 'codex', modelId: 'gpt-5-codex', effort: 'high' },
    reply: (ctx) => (ctx.system.includes('提示詞編輯者')
      ? JSON.stringify({ prompt: `${initialPrompt}\n${marker}`, changes: ['明確區分一般寒暄和可執行任務'] })
      : fenced(todoFor(ctx.user, ctx.system.includes(marker) ? '測試新 Prompt 的待辦' : '寄報價單給客戶')))
  }, async ({ api, line, ai, calls }) => {
    const initial = await api.hostAi.prompts.get()
    initialPrompt = initial.activePrompt
    await seedTodo(api, line)
    const proposal = await api.hostAi.prompts.refine({ prompt: initial.activePrompt, goal: '避免把一般寒暄當成任務' })
    assert.ok(proposal.prompt.includes(marker))
    assert.equal(proposal.modelId, 'gpt-5-codex')
    assert.deepEqual([ai.stats.turns.at(-1).modelId, ai.stats.turns.at(-1).effort], ['gpt-5-codex', 'high'], 'the saved model and effort')
    assert.equal((await api.hostAi.prompts.get()).revision, initial.revision, 'a suggestion is not automatically applied')
    const saved = await api.hostAi.prompts.save(proposal.prompt, initial.revision)
    assert.notEqual(saved.revision, initial.revision)
    line.emit(raw(2, { text: '請幫我完成提示詞測試' }))
    await api.pipeline.runOnce()
    await until(async () => (await aiState(api)).counters.extracted >= 2, { message: 'a new extraction after applying the prompt' })
    assert.ok(calls.at(-1).system.includes(marker), 'the saved prompt is what the worker sends')
    assert.ok(calls.at(-1).system.includes(initial.outputFormat), 'fixed JSON output requirements remain appended')
    await assert.rejects(api.hostAi.prompts.save('stale overwrite', initial.revision), /prompt_conflict/)
    assert.equal((await api.hostAi.prompts.reset(saved.revision)).activePrompt, initial.initialPrompt)
    // a refinement while the AI is down says why
    ai.control.set({ providerState: 'not_logged_in' })
    await sleep(60)
    await assert.rejects(api.hostAi.prompts.refine({ prompt: initial.activePrompt, goal: '再試一次' }), /provider_unavailable/)
  })
})

// ───────────── quota: waiting, not failing ─────────────

test('(b) e2e: many chats at once are drained one Session at a time, in 20-per-minute windows (shared fake clock), and every one ends up as a todo', async () => {
  // time is shared by the port, the worker and the mock host so the minute-long window runs fast; the backend still runs in real time
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
  await withStack({ clock, ai: { extractReserve: 0, busyRetryMs: 1 }, worker: { pollIntervalMs: 15_000 }, reply: ({ user }) => fenced(todoFor(user, `處理 ${JSON.parse(user).chat.name}`)) }, async ({ api, line, ai }) => {
    for (let i = 1; i <= 24; i += 1) line.emit(raw(i, { chatId: `u-${i}`, chat: `客戶${i}`, text: `請回覆客戶${i}的報價問題` }))
    await api.pipeline.runOnce()
    await until(() => ai.stats.completes >= 20, { message: '20 turns in the first window' })
    await sleep(100)
    assert.equal(ai.stats.completes, 20, 'the 21st turn waits for the window')
    assert.equal((await todos(api)).length, 20)
    await advance(60_400)
    await until(async () => (await todos(api)).length === 24, { message: 'the remaining 4 chats', timeout: 8000 })
    assert.equal(ai.stats.completes, 24)
    assert.equal(ai.stats.errors.rate_limited, 0)
    assert.equal(ai.stats.maxLiveSessions, 1)
    assert.deepEqual((await todos(api)).map((t) => t.chatId).sort(), Array.from({ length: 24 }, (_, i) => `u-${i + 1}`).sort())
  })
})

test('(b) e2e quota exhausted: the pending message is kept (no failure, no chat backoff), nothing is sent during the cooldown, and the todo appears afterwards', async () => {
  await withStack({ setup: (ai) => ai.control.exhaustQuota(500) }, async ({ api, line, ai }) => {
    line.emit(raw(1, { text: '請幫我處理報銷' }))
    await api.pipeline.runOnce()
    await until(async () => (await aiState(api)).reason === 'quota_exhausted', { message: 'the quota pause is reported' })
    const during = await stats(api)
    assert.equal(during.pending + during.leased, 1, 'the item is still waiting')
    assert.equal(during.chatsBackingOff, 0, 'a quota error is not the chat\'s failure')
    assert.deepEqual(await todos(api), [])
    assert.equal(ai.stats.completes, 0, 'no turn during the cooldown')
    const created = await until(async () => { const list = await todos(api); return list.length === 1 ? list : null }, { message: 'the todo after the cooldown', timeout: 8000 })
    assert.equal(created[0].title, '寄報價單給客戶')
    const status = await aiState(api)
    assert.equal(status.counters.failed, 0)
  })
})

test('(b) e2e: a quota error in the middle of a turn keeps the message, and a backend restart in the middle of the backlog loses nothing — the new backend extracts it from the database', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'plugin-ai-e2e-restart-'))
  try {
    // first run: the very first turn fails with quota_exhausted (Core's 5 minute cooldown), then the backend is "unloaded by TeamUQ" (dispose) with the item unprocessed
    await withStack({ dataDir, ai: { quotaDefaultMs: 60_000 }, reply: () => ({ fail: 'quota_exhausted' }) }, async ({ api, line, ai }) => {
      line.emit(raw(1, { text: '請幫我寄報價單給客戶' }))
      await api.pipeline.runOnce()
      await until(async () => (await aiState(api)).reason === 'quota_exhausted', { message: 'quota pause' })
      const queue = await stats(api)
      assert.equal(queue.pending + queue.leased, 1)
      assert.equal(queue.chatsBackingOff, 0)
      assert.deepEqual(await todos(api), [])
      assert.equal(ai.stats.completes, 1)
    })
    // second run on the same data directory (TeamUQ started the backend again): the message was never marked processed, so it is offered again and extracted
    await withStack({ dataDir }, async ({ api, ai, calls }) => {
      await api.pipeline.runOnce()
      const created = await until(async () => { const list = await todos(api); return list.length === 1 ? list : null }, { message: 'the todo after the restart' })
      assert.equal(created[0].title, '寄報價單給客戶')
      assert.equal(calls.length, 1)
      assert.equal(ai.stats.completes, 1)
    })
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})

test('(c) e2e: the host says rate_limited because other turns used the window — the item is kept, the worker waits with growing backoff and finishes when the window frees; the chat is never marked failed', async () => {
  let time = 9_000_000
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
  // the production backoff (5 s doubling to 60 s) in fake time: with the real-time test knobs the fake minute would take thousands of tiny steps
  await withStack({ clock, ai: { rateBackoffBaseMs: 5_000, rateBackoffMaxMs: 60_000, providerRetryMs: 60_000 }, setup: (ai) => ai.control.consumeTurns(20) }, async ({ api, line }) => {
    line.emit(raw(1, { text: '請幫我訂會議室' }))
    await api.pipeline.runOnce()
    await until(async () => (await aiState(api)).reason === 'rate_limited', { message: 'rate_limited reported' })
    assert.deepEqual(await todos(api), [])
    const during = await stats(api)
    assert.equal(during.chatsBackingOff, 0)
    assert.equal(during.pending + during.leased, 1)
    await advance(100_000)
    await until(async () => (await todos(api)).length === 1, { message: 'the todo once the window freed' })
    assert.equal((await aiState(api)).counters.failed, 0)
  })
})

test('(c) e2e: Codex not logged in -> the worker does not even lease items; logging in (provider ready) lets it finish the backlog', async () => {
  await withStack({ setup: (ai) => ai.control.set({ providerState: 'not_logged_in' }) }, async ({ api, line, ai }) => {
    line.emit(raw(1, { text: '請幫我訂便當' }))
    await api.pipeline.runOnce()
    const status = await until(async () => { const s = await aiState(api); return s.state === 'unavailable' ? s : null }, { message: 'unavailable' })
    assert.equal(status.reason, 'provider_not_logged_in')
    assert.deepEqual(await todos(api), [])
    const queue = await stats(api)
    assert.equal(queue.leased, 0, 'nothing leased while there is no usable AI')
    assert.equal(ai.stats.completes, 0)
    ai.control.set({ providerState: 'ready' })
    await until(async () => (await todos(api)).length === 1, { message: 'the todo after Codex became ready' })
    assert.equal((await aiState(api)).state, 'running')
  })
})

// ───────────── broken replies ─────────────

test('e2e limits: a chat with far more text than one turn can carry is split by the backend into several turns, each within 8,000 chars (system within 16,000); every message is processed exactly once', async () => {
  const titles = ['寄報價單給客戶', '訂明天的會議室', '回覆廠商合約條款', '匯款給設計師', '更新官網banner', '預約牙醫看診', '整理報稅資料', '採購辦公室咖啡豆']
  let n = 0
  await withStack({ ai: { extractReserve: 0 }, reply: ({ user }) => fenced(todoFor(user, titles[n++ % titles.length])) }, async ({ api, line, calls, ai }) => {
    for (let i = 1; i <= 30; i += 1) line.emit(raw(i, { chatId: 'u-big', chat: '大客戶', text: `第 ${i} 則：` + '很長的需求描述，'.repeat(60) }))
    await api.pipeline.runOnce()
    await until(async () => { const s = await stats(api); return calls.length >= 3 && s.pending + s.leased === 0 ? s : null }, { message: 'every part to be processed' })
    assert.ok(calls.length >= 3, `${calls.length} turns for ~20k chars of messages (each turn carries ~10 messages)`)
    for (const call of calls) {
      assert.ok(call.user.length <= CONTRACT.limits.inputChars, `user ${call.user.length} <= 8000`)
      assert.ok(call.system.length <= CONTRACT.limits.systemChars)
    }
    const covered = calls.flatMap((call) => JSON.parse(call.user).newMessages.map((m) => m.msgId))
    assert.equal(covered.length, 30, 'each message is sent once as a new message')
    assert.deepEqual([...new Set(covered)].sort(), Array.from({ length: 30 }, (_, i) => `i:m${i + 1}`).sort())
    assert.equal(ai.stats.errors.plugin_host_request_invalid, undefined, 'the host never saw an over-long input')
    const list = await todos(api)
    assert.equal(list.length, calls.length, 'one todo per part')
    await api.pipeline.runOnce()
    await sleep(150)
    assert.equal(calls.length, list.length, 'nothing is sent twice')
  })
})

test('e2e throughput: a long chat (200 new messages x ~100 chars, with recentContext) is carried in turns that are nearly full — ~ new-message chars / per-turn budget, not one turn per message — each <= 7,500 chars', async () => {
  await withStack({ ai: { extractReserve: 0 }, reply: () => fenced({ importance: 'fyi', newTodos: [], identityDecisions:[], resolved: [], updates: [] }) }, async ({ api, line, calls }) => {
    const text = (i) => `第 ${i} 則：請幫我確認一下這件事情的進度，並且在明天中午之前回覆給客戶，謝謝。` + '補充說明內容。'.repeat(8)
    // 40 older messages first: they are processed, and become the recentContext of the next cycle
    for (let i = 1; i <= 40; i += 1) line.emit(raw(i, { chatId: 'u-long', chat: '長聊天室', isGroup: true, text: text(i) }))
    await api.pipeline.runOnce()
    await until(async () => { const s = await stats(api); return calls.length >= 1 && s.pending + s.leased === 0 }, { message: 'the first batch to be processed' })
    calls.length = 0
    for (let i = 41; i <= 240; i += 1) line.emit(raw(i, { chatId: 'u-long', chat: '長聊天室', isGroup: true, text: text(i) }))
    await api.pipeline.runOnce()
    await until(async () => { const s = await stats(api); return calls.length >= 1 && s.pending + s.leased === 0 }, { message: 'the long batch to be processed', timeout: 15_000 })
    const payloads = calls.map((c) => JSON.parse(c.user))
    const messageChars = payloads.flatMap((p) => p.newMessages).reduce((sum, m) => sum + JSON.stringify(m).length, 0)
    const lowerBound = Math.ceil(messageChars / CONTRACT.limits.inputChars)
    assert.equal(payloads.flatMap((p) => p.newMessages).length, 200, 'all 200 messages were sent, once each')
    assert.ok(calls.length >= lowerBound, `${calls.length} turns >= lower bound ${lowerBound}`)
    assert.ok(calls.length <= Math.ceil(lowerBound * 1.5) + 1, `${calls.length} turns for ${messageChars} chars of new messages (lower bound ${lowerBound}) — it used to be one turn per message`)
    for (const [index, call] of calls.entries()) {
      assert.ok(call.user.length <= 7500, `turn ${index + 1}: user ${call.user.length} <= 7,500`)
      assert.ok(payloads[index].recentContext.length > 0, `turn ${index + 1} carries recentContext`)
      assert.ok(JSON.stringify(payloads[index].recentContext).length <= 1500 + 50, `turn ${index + 1}: recentContext is capped at ~20% of a turn (${JSON.stringify(payloads[index].recentContext).length} chars)`)
    }
  })
})

test('e2e: a model reply that is not usable never reaches the todo list — bad JSON (after one repair that replays the exchange) and schema-invalid JSON fail the chat; the messages stay unprocessed and the queue backs the chat off', async () => {
  await withStack({ reply: () => '我整理了一下，但格式可能不太對 {importance: action', backend: { extract: { retryBaseMs: 60_000 } } }, async ({ api, line, ai, calls }) => {
    line.emit(raw(1, { text: '請幫我寄合約' }))
    await api.pipeline.runOnce()
    await until(async () => (await stats(api)).chatsBackingOff === 1, { message: 'the chat to be backed off' })
    assert.equal(ai.stats.completes, 2, 'first reply + one repair')
    assert.match(calls[1].user, /不是合法的 JSON/)
    assert.deepEqual(calls[1].transcript.map((line_) => line_.role), ['user', 'assistant'], 'the repair replays the question and the bad answer')
    assert.deepEqual(await todos(api), [])
    const queue = await stats(api)
    assert.equal(queue.pending, 1, 'the messages are still waiting (unprocessed)')
    const status = await aiState(api)
    assert.equal(status.counters.failed, 1)
    assert.equal(status.state, 'running', 'one bad chat is not an AI outage')
  })
  await withStack({ reply: () => JSON.stringify({ importance: 'action', newTodos: [{ bucket: 'todo', title: '', priority: 2, confidence: 0.5, sourceMsgIds: ['i:m1'] }], resolved: [], updates: [] }), backend: { extract: { retryBaseMs: 60_000 } } }, async ({ api, line, ai }) => {
    line.emit(raw(1, { text: '請幫我寄合約' }))
    await api.pipeline.runOnce()
    await until(async () => (await stats(api)).chatsBackingOff === 1, { message: 'the chat to be backed off' })
    assert.deepEqual(await todos(api), [])
    assert.equal(ai.stats.completes, 2)
  })
})

// ───────────── revocation ─────────────

test('e2e: revoking the ai:chat permission stops extraction, every AI feature says how to fix it — and allowing it again resumes the backlog by itself', async () => {
  await withStack({}, async ({ api, line, ai, mock }) => {
    const todo = await seedTodo(api, line)
    const completes = ai.stats.completes
    ai.control.revoke()
    await api.plugin.aiStatus({ refresh: true }) // a board opening re-probes
    line.emit(raw(2, { chatId: 'u-bob', chat: 'Bob', text: '請幫我回電話' })) // another chat: a second message in Alice's chat would be merged into her todo
    await api.pipeline.runOnce()
    const status = await until(async () => { const s = await aiState(api); return s.state === 'revoked' ? s : null }, { message: 'revoked state' })
    assert.equal(status.reason, 'access_revoked')
    assert.deepEqual((await todos(api)).map((t) => t.id), [todo.id], 'only the todo from before the revocation')
    const draft = await api.db.todos.draftReply(todo.id)
    assert.match(draft.error, /ai:chat/)
    const review = await api.pipeline.reviewLastDays(3)
    assert.equal(review.ok, false)
    assert.equal(review.hasApiKey, true, 'the UI must not ask for an API key')
    assert.match(review.note, /ai:chat/)
    assert.equal(ai.stats.completes, completes, 'nothing was sent after the permission was switched off')
    assert.equal(mock.count('ai.run'), 0)
    const queue = await stats(api)
    assert.equal(queue.pending + queue.leased, 1, 'the message waits')
    // the user switches it on again in TeamUQ: the next probe lets the backlog through
    ai.control.grant()
    await until(async () => (await todos(api)).length === 2, { message: 'the todo after the permission came back', timeout: 8000 })
    assert.equal((await aiState(api)).state, 'running')
  })
})

// ───────────── the user actions ─────────────

test('e2e draftReply: the backend builds the prompt from its own data and asks host.ai.complete itself; the draft comes back as an ordinary db.todos call (no relay, no board involved in the AI)', async () => {
  await withStack({
    reply: (ctx) => (ctx.system.includes('草擬') ? '  好的，報價單我今天下午寄出，再請您確認。\n' : fenced(todoFor(ctx.user)))
  }, async ({ api, line, calls, mock, ai }) => {
    const todo = await seedTodo(api, line)
    const result = await api.db.todos.draftReply(todo.id)
    assert.deepEqual(result, { draft: '好的，報價單我今天下午寄出，再請您確認。' })
    const draftCall = calls.find((c) => c.system.includes('草擬'))
    assert.ok(draftCall, 'the draft prompt reached host.ai.complete')
    const payload = JSON.parse(draftCall.user)
    assert.equal(payload['代辦標題'], '寄報價單給客戶')
    assert.ok(payload['最近對話'].some((line_) => line_.includes('請幫我寄報價單給客戶')), 'recent conversation comes from the backend DB')
    assert.equal(mock.count('db.todos.draftReply'), 1)
    assert.equal(mock.count('ai.run') + mock.count('ai.pull') + mock.count('ai.commit'), 0, 'there is no relay any more')
    assert.equal(calls.filter((c) => c.system.includes('草擬')).length, 1)
    assert.equal(ai.stats.errors.session_limit, 0, 'extraction and the draft share the one Session slot without colliding')
  })
})

test('e2e draftReply failures are explicit and friendly: model refuses (empty reply), quota exhausted, Codex not logged in — never a fake draft', async () => {
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
    assert.equal(ai.stats.completes, 1, 'only the seeding turn; the quota check came first')
  })
  await withStack({}, async ({ api, line, ai }) => {
    const todo = await seedTodo(api, line)
    ai.control.set({ providerState: 'not_logged_in' })
    await api.plugin.aiStatus({ refresh: true })
    const result = await api.db.todos.draftReply(todo.id)
    assert.match(result.error, /Codex 目前無法使用/)
  })
})

test('e2e: a user action does not wait behind a backlog — while extraction waits for the minute window, the draft is answered at once', async () => {
  let time = 3_000_000
  const clock = { now: () => time, timers: new Map(), next: 1, setTimeout(fn, ms) { const id = this.next++; this.timers.set(id, { at: time + ms, fn }); return id }, clearTimeout(id) { this.timers.delete(id) } }
  await withStack({ clock, worker: { pollIntervalMs: 15_000 }, reply: (ctx) => (ctx.system.includes('草擬') ? '馬上回覆' : fenced(todoFor(ctx.user))) }, async ({ api, line, ai }) => {
    const todo = await seedTodo(api, line)
    for (let i = 2; i <= 30; i += 1) line.emit(raw(i, { chatId: `u-${i}`, chat: `客戶${i}`, text: `請回覆客戶${i}` }))
    await api.pipeline.runOnce()
    await until(() => ai.stats.completes >= 18, { message: 'extraction filled its share of the minute (18)' })
    await sleep(80)
    assert.equal(ai.stats.completes, 18, 'extraction keeps 2 turns of the window for the user')
    assert.deepEqual(await api.db.todos.draftReply(todo.id), { draft: '馬上回覆' })
    assert.equal(ai.stats.completes, 19)
    assert.equal(ai.stats.errors.rate_limited, 0)
  })
})

test('e2e: a very long draft is delivered whole — 0.1.x had to trim it to fit the ai.commit request; now it travels back to the view as an ordinary (chunked) result', async () => {
  const long = '您好，關於報價單的說明如下。'.repeat(1800) // ~ 23,400 characters ~ 70 KB: above one backend.call response, below the 32,000-character reply cap
  assert.ok(new TextEncoder().encode(long).byteLength > 60 * 1024)
  await withStack({ reply: (ctx) => (ctx.system.includes('草擬') ? long : fenced(todoFor(ctx.user))) }, async ({ api, line, mock }) => {
    const todo = await seedTodo(api, line)
    const result = await api.db.todos.draftReply(todo.id)
    assert.equal(result.error, undefined)
    assert.equal(result.draft, long, 'not trimmed, no truncation mark')
    assert.ok(mock.count('result.chunk') >= 1, 'it came back in chunks')
  })
})

test('e2e analyzeNotMine: the fenced JSON is cleaned by the AI port, validated and SAVED by the backend\'s own logic (analysis shows up in the review)', async () => {
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
        identityDecisions:[{draftRef:'launch',outcome:'new',candidateType:null,candidateId:null,relationKind:null,reasonCode:'insufficient_evidence',confidenceBand:'high',evidenceMsgIds:[payload.messages[0].msgId]}],
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
    reply: (ctx) => (ctx.system.includes('ONE group chat') ? JSON.stringify({ topics: [], identityDecisions:[], assignments: [{ msgId: 'ghost', topicRef: null, relation: 'uncertain', confidence: 0.1, relevance: 'unknown', relevanceEvidenceMsgIds: [] }] }) : fenced(todoFor(ctx.user)))
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

test('e2e reviewLastDays: the long review rides the job channel while the worker answers the extraction items (it was "尚未接上" without a board in 0.1.x); with Codex logged out it fails at once with the reason', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'plugin-ai-e2e-review-'))
  const fake = fakeLine()
  fake.port.getMessagesSince = async () => [raw(1, { text: '提醒我週五前交付報告', ts: Date.now() - 1000 }), raw(2, { text: '另外發票也要開', ts: Date.now() - 500 })]
  // Codex takes ~100 ms, longer than the backend's 30 ms soft deadline: the long call turns into a job the adapter polls
  const ai = createMockTuqAi({ reply: ({ user }) => ({ text: fenced(todoFor(user, '交付週五報告')), delay: () => sleep(100) }) })
  const backend = await createPluginBackend({ pluginId: 'p', version: '1', dataDir, line: fake.port, dispatcher: { softDeadlineMs: 30, maxJobWaitMs: 200 }, hostAi: ai.ai, ai: { config: FAST_AI, worker: FAST_WORKER } })
  const host = makeBackendHost(backend)
  const api = createPluginLineTodoApi({ host: host.host, events: FAST_EVENTS, jobPollWaitMs: 100 })
  try {
    ai.control.set({ providerState: 'not_logged_in' })
    const early = await api.pipeline.reviewLastDays(7)
    assert.equal(early.ok, false)
    assert.match(early.note, /尚未登入/, 'honest and immediate: no 15-minute wait for results nobody will deliver')
    assert.equal(ai.stats.completes, 0)
    ai.control.set({ providerState: 'ready' })
    await sleep(FAST_AI.providerRetryMs + 60)
    const review = await api.pipeline.reviewLastDays(7)
    assert.equal(review.ok, true, JSON.stringify(review))
    assert.equal(review.todosCreated, 1)
    assert.deepEqual((await todos(api)).map((t) => t.title), ['交付週五報告'])
    assert.ok(host.count('job.poll') >= 1, 'the long call became a job')
    assert.equal(ai.control.liveSessions(), 0)
  } finally {
    api.dispose()
    await backend.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ───────────── lifecycle ─────────────

test('dispose while the AI is working or waiting: no timer or Session is left behind, pending items stay in the database, a stopped backend answers backend_stopped', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'plugin-ai-e2e-dispose-'))
  try {
    await withStack({ dataDir, reply: (ctx) => ({ text: fenced(todoFor(ctx.user)), delay: () => sleep(200) }) }, async ({ api, backend, line, ai }) => {
      for (let i = 1; i <= 4; i += 1) line.emit(raw(i, { chatId: `u-${i}`, chat: `客戶${i}`, text: `請回覆客戶${i}` }))
      await api.pipeline.runOnce()
      await until(() => ai.stats.completes >= 1, { message: 'a turn is in flight' })
      await backend.dispose()
      assert.equal(backend.diagnostics().disposed, true)
      assert.equal((await backend.call('ping', { path: 'ping', args: [] })).code, 'backend_stopped')
      await sleep(300)
      assert.ok(ai.stats.completes <= 2, 'a disposed backend leases nothing more')
    })
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})

// ───────────── view wiring ─────────────

test('board.ts / host.ts: the board view wires the adapter only — it asks the backend to re-probe the AI and never touches window.tuqPlugin.ai; pagehide disposes; the settings view needs nothing extra', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'plugin-ai-e2e-host-'))
  const line = fakeLine()
  const ai = createMockTuqAi({ reply: ({ user }) => fenced(todoFor(user)) })
  const backend = await createPluginBackend({ pluginId: 'tuqdev.line-todo', version: '1', dataDir, line: line.port, dispatcher: { softDeadlineMs: 40, maxJobWaitMs: 300 }, hostAi: ai.ai, ai: { config: FAST_AI, worker: FAST_WORKER } })
  const { host, count, state } = makeBackendHost(backend)
  const handlers = new Map()
  const saved = { window: globalThis.window, document: globalThis.document }
  let aiTouched = 0
  try {
    globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
    // 0.2.0: the view has no business with window.tuqPlugin.ai — any access is a failure of this test
    const tuqPlugin = { ...host }
    Object.defineProperty(tuqPlugin, 'ai', { get() { aiTouched += 1; throw new Error('the view must not touch window.tuqPlugin.ai') }, enumerable: true })
    globalThis.window = { tuqPlugin, addEventListener: (type, cb) => handlers.set(`window:${type}`, cb) }
    const boot = bootBoard()
    assert.ok(boot, 'board view boots')
    assert.equal(boot.orchestrator, undefined, 'there is no view-side orchestrator any more')
    assert.equal(boot.api.plugin.transportStats().limit, 3, 'review F1: the board view budget is 3 host calls (event long poll included)')
    await until(() => count('ai.status') >= 1, { message: 'the board asks the backend to re-probe the AI' })
    assert.deepEqual(state.calls.find((c) => c.path === 'ai.status').args, [{ refresh: true }])
    const status = await until(async () => { const s = await boot.api.plugin.aiStatus(); return s.state === 'running' ? s : null }, { message: 'the AI is ready in the backend' })
    assert.equal(status.provider.modelId, 'gpt-5-codex')

    // it works end to end through host.ts's wiring
    line.emit(raw(1, { text: '請幫我寄報價單給客戶' }))
    await boot.api.pipeline.runOnce()
    await until(async () => (await boot.api.db.todos.list()).length === 1, { message: 'a todo via bootPluginApi' })
    // the status event reaches the board
    const events = []
    const off = boot.api.plugin.onAiStatus((s) => events.push(s.state))
    ai.control.set({ providerState: 'not_logged_in' })
    await boot.api.plugin.aiStatus({ refresh: true })
    await until(() => events.includes('unavailable'), { message: 'the ai-status event' })
    off()
    ai.control.set({ providerState: 'ready' })

    handlers.get('window:pagehide')()
    await until(async () => { try { await boot.api.ping(); return false } catch (error) { return error.code === 'disposed' } }, { message: 'api disposed after pagehide' })

    // the settings view: same adapter (budget 1, no event long poll); its AI features are plain backend calls and work
    handlers.clear()
    const settingsView = bootPluginApi({ maxConcurrentCalls: 1, events: false })
    assert.equal(settingsView.api.plugin.transportStats().limit, 1)
    const off2 = settingsView.api.pipeline.onStatus(() => undefined)
    await sleep(60)
    assert.equal(settingsView.api.plugin.eventsStats().running, false, 'the settings view never starts an event long poll')
    assert.equal(settingsView.api.plugin.eventsStats().pulls, 0)
    off2()
    await sleep(FAST_AI.providerRetryMs + 60)
    const options = await settingsView.api.hostAi.getOptions()
    assert.equal(options.defaultProviderId, 'codex')
    assert.match((await settingsView.api.db.todos.draftReply('does-not-exist')).error ?? '', /./, 'a draft for a todo that is not there fails with a message, through the backend')
    settingsView.api.dispose()

    assert.equal(aiTouched, 0, 'window.tuqPlugin.ai was never read')

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
