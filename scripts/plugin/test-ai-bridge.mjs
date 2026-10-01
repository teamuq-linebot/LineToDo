// Phase 4 — the backend half of the AI bridge (no LLM anywhere): AiTaskQueue (単次 AI 呼叫 的供料／收料), the UI-relay provider that replaces provider.complete(),
// the failure-code -> LlmProviderError mapping, the groupTopics payload fitter, and the dispatcher paths ai.* / extract.release / extract.system.format.
import assert from 'node:assert/strict'
import test from 'node:test'

import { LlmProviderError } from '../../src/main/llm/provider/types.ts'
import { EXTRACT_JSON_SCHEMA } from '../../src/main/llm/schema.ts'
import { EXTRACT_OUTPUT_CONTRACT, outputContractFor } from '../../src/plugin/backend/aiOutputContract.ts'
import {
  AI_RUN_PATHS, AI_TASK_MAX_SYSTEM_CHARS, AI_TASK_MAX_USER_CHARS, AiTaskError, AiTaskQueue, createUiAiProvider, fitUserPayload, toProviderError
} from '../../src/plugin/backend/aiTaskQueue.ts'
import { Dispatcher, SUPPORTED_API_PATHS, UNSUPPORTED_API_PATHS } from '../../src/plugin/backend/dispatcher.ts'
import { EventHub } from '../../src/plugin/backend/eventHub.ts'
import { CONTRACT } from '../lib/mock-tuq-ai.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const rejection = (promise) => promise.then(() => { throw new Error('expected a rejection') }, (error) => error)

function queue(options = {}) {
  let time = 1_000_000
  const events = []
  const q = new AiTaskQueue({ now: () => time, onPending: (info) => events.push(info), ...options })
  return { q, events, advance: (ms) => { time += ms }, now: () => time }
}

// ───────────── AiTaskQueue ─────────────

test('AiTaskQueue: a request waits for a UI consumer, is leased, answered, and the caller gets the text + model; the consumer must have shown up first', async () => {
  const { q, events } = queue()
  const early = await rejection(q.request({ kind: 'draftReply', system: 'S', user: 'U', expectJson: false }))
  assert.ok(early instanceof AiTaskError && early.code === 'ui_not_connected', 'no UI is polling: fail at once instead of waiting')
  q.touch()
  const pending = q.request({ kind: 'draftReply', system: 'SYS', user: 'USER', expectJson: false })
  assert.deepEqual(events, [{ pending: 1, tasks: true }])
  const pulled = q.pull({ max: 4 })
  assert.equal(pulled.tasks.length, 1)
  assert.deepEqual({ kind: pulled.tasks[0].kind, system: pulled.tasks[0].system, user: pulled.tasks[0].user, expectJson: pulled.tasks[0].expectJson }, { kind: 'draftReply', system: 'SYS', user: 'USER', expectJson: false })
  assert.equal(q.pull().tasks.length, 0, 'leased: not handed out twice')
  const [accepted] = q.commit({ results: [{ taskId: pulled.tasks[0].taskId, ok: true, text: '草稿', model: 'gpt-5-codex' }] }).results
  assert.equal(accepted.status, 'accepted')
  assert.deepEqual(await pending, { text: '草稿', model: 'gpt-5-codex' })
  assert.deepEqual(q.stats(), { pending: 0, leased: 0, consumerActive: true })
  assert.equal(q.commit({ results: [{ taskId: pulled.tasks[0].taskId, ok: true, text: 'again' }] }).results[0].status, 'unknown_task', 'a lease is single-use')
})

test('AiTaskQueue: failures from the UI reach the caller with their code (and retryAfterMs); malformed commits are refused; an empty text is not an answer', async () => {
  const { q } = queue()
  q.touch()
  const failed = q.request({ kind: 'groupTopics', system: 'S', user: 'U', expectJson: true })
  const { taskId } = q.pull().tasks[0]
  assert.equal(q.commit({ results: [{ taskId, ok: false, failCode: 'quota_exhausted', retryAfterMs: 90_000 }] }).results[0].status, 'failed_recorded')
  const error = await rejection(failed)
  assert.deepEqual({ code: error.code, retryAfterMs: error.retryAfterMs }, { code: 'quota_exhausted', retryAfterMs: 90_000 })

  const weird = q.request({ kind: 'draftReply', system: 'S', user: 'U', expectJson: false })
  const t2 = q.pull().tasks[0].taskId
  assert.equal(q.commit({ results: [{ taskId: t2, ok: false, failCode: '../../etc/passwd; DROP' }] }).results[0].status, 'failed_recorded')
  assert.equal((await rejection(weird)).code, 'ai_failed', 'an unexpected failCode is normalised, never echoed')

  const empty = q.request({ kind: 'draftReply', system: 'S', user: 'U', expectJson: false })
  const t3 = q.pull().tasks[0].taskId
  assert.equal(q.commit({ results: [{ taskId: t3, ok: true, text: '' }] }).results[0].status, 'bad_request')
  assert.equal((await rejection(empty)).code, 'empty_reply')
  assert.deepEqual(q.commit({ results: [{ taskId: '', ok: true }, { ok: 'yes' }] }).results.map((r) => r.status), ['bad_request', 'bad_request'])
})

test('AiTaskQueue: a lease that is never answered returns to the queue; release gives it back at once; a request nobody answers times out; limits and dispose', async () => {
  const a = queue({ leaseMs: 5000 })
  a.q.touch()
  const p = a.q.request({ kind: 'draftReply', system: 'S', user: 'U', expectJson: false })
  const lease1 = a.q.pull({ leaseMs: 5000 }).tasks[0].taskId
  assert.equal(a.q.pull().tasks.length, 0)
  a.advance(5001)
  const lease2 = a.q.pull().tasks[0].taskId
  assert.notEqual(lease1, lease2, 'expired lease: re-leased with a new id')
  assert.equal(a.q.commit({ results: [{ taskId: lease1, ok: true, text: 'late' }] }).results[0].status, 'unknown_task', 'the stale lease is refused')
  assert.equal(a.q.release({ taskIds: [lease2] }).released, 1)
  const lease3 = a.q.pull().tasks[0].taskId
  a.q.commit({ results: [{ taskId: lease3, ok: true, text: 'fine' }] })
  assert.equal((await p).text, 'fine')

  const b = queue({ timeoutMs: 30 })
  b.q.touch()
  assert.equal((await rejection(b.q.request({ kind: 'draftReply', system: 'S', user: 'U', expectJson: false }))).code, 'ai_task_timeout')
  assert.equal(b.q.stats().pending, 0, 'timed-out task is gone')

  const c = queue({ maxQueued: 2 })
  c.q.touch()
  const kept = [1, 2].map(() => c.q.request({ kind: 'draftReply', system: 'S', user: 'U', expectJson: false }))
  assert.equal((await rejection(c.q.request({ kind: 'draftReply', system: 'S', user: 'U', expectJson: false }))).code, 'ai_queue_full')
  assert.equal((await rejection(c.q.request({ kind: 'draftReply', system: 'S', user: 'x'.repeat(AI_TASK_MAX_USER_CHARS + 1), expectJson: false }))).code, 'input_too_large')
  assert.equal((await rejection(c.q.request({ kind: 'draftReply', system: 'S'.repeat(AI_TASK_MAX_SYSTEM_CHARS + 1), user: 'U', expectJson: false }))).code, 'system_too_large')
  c.q.dispose()
  for (const promise of kept) assert.equal((await rejection(promise)).code, 'backend_stopped')
  assert.equal((await rejection(c.q.request({ kind: 'draftReply', system: 'S', user: 'U', expectJson: false }))).code, 'backend_stopped')
  assert.ok(AI_TASK_MAX_USER_CHARS <= CONTRACT.limits.inputChars && AI_TASK_MAX_SYSTEM_CHARS === CONTRACT.limits.systemChars, 'queue limits fit the ai:chat contract')

  const d = queue({ consumerFreshMs: 1000 })
  d.q.touch()
  assert.equal(d.q.consumerActive(), true)
  d.advance(1001)
  assert.equal(d.q.consumerActive(), false, 'a UI that stopped polling (board hidden) stops counting as connected')
})

// ───────────── provider (the relay) ─────────────

test('UI-relay provider: complete() queues the request (kind from the ai.run context, JSON expectation, schema appended to the system prompt) — it has no network, no process, no key', async () => {
  const { q } = queue()
  q.touch()
  const provider = createUiAiProvider(q)
  assert.deepEqual({ id: provider.id, kind: provider.kind }, { id: 'codexCli', kind: 'cli' })

  const draft = q.runAs('draftReply', () => provider.complete({ system: 'DRAFT', user: '{"a":1}', temperature: 0.5 }))
  let task = q.pull().tasks[0]
  assert.deepEqual({ kind: task.kind, system: task.system, expectJson: task.expectJson }, { kind: 'draftReply', system: 'DRAFT', expectJson: false })
  q.commit({ results: [{ taskId: task.taskId, ok: true, text: '好的', model: 'gpt-5-codex' }] })
  const response = await draft
  assert.equal(response.text, '好的')
  assert.deepEqual({ provider: response.meta.provider, model: response.meta.model }, { provider: 'codexCli', model: 'gpt-5-codex' })
  assert.equal(typeof response.meta.durationMs, 'number')

  const notMine = q.runAs('analyzeNotMine', () => provider.complete({ system: 'ANALYZE', user: '{}' }))
  task = q.pull().tasks[0]
  assert.equal(task.expectJson, true, 'the analysis is JSON.parse\'d by core, so the UI must verify JSON even without a schema')
  q.commit({ results: [{ taskId: task.taskId, ok: true, text: '{"summary":"s"}' }] })
  await notMine

  const schema = { type: 'object', properties: { a: { type: 'string' } } }
  const topics = q.runAs('groupTopics', () => provider.complete({ system: 'TOPICS', user: '{}', jsonSchema: { name: 'group_topics', schema } }))
  task = q.pull().tasks[0]
  assert.equal(task.system, `TOPICS\n\n${outputContractFor(schema)}`)
  assert.ok(task.system.includes(JSON.stringify(schema)))
  assert.equal(task.expectJson, true)
  q.commit({ results: [{ taskId: task.taskId, ok: true, text: '{}' }] })
  await topics

  const bare = provider.complete({ system: 'X', user: 'Y' })
  task = q.pull().tasks[0]
  assert.equal(task.kind, 'unknown', 'outside ai.run the kind is unknown (and no JSON is expected without a schema)')
  assert.equal(task.expectJson, false)
  q.commit({ results: [{ taskId: task.taskId, ok: true, text: 'ok' }] })
  await bare

  assert.equal((await provider.health()).ok, true)
  const idle = createUiAiProvider(new AiTaskQueue())
  assert.equal((await idle.health()).ok, false)
})

test('UI-relay provider: every failure arrives as the LlmProviderError core already understands (right class, code, and a message the user can act on)', async () => {
  const cases = [
    ['ui_not_connected', 'invalid_config', /看板不在前景/], ['view_not_visible', 'transport', /看板不在前景/], ['ai_task_timeout', 'timeout', /逾時/], ['turn_timeout', 'timeout', /逾時/],
    ['rate_limited', 'rate_limited', /每分鐘 20 次/], ['quota_exhausted', 'quota_exceeded', /額度已用完/], ['provider_unavailable', 'invalid_config', /Codex/],
    ['unsupported_version', 'invalid_config', /Codex/], ['access_revoked', 'invalid_config', /ai:chat/], ['not_granted', 'invalid_config', /ai:chat/],
    ['invalid_json', 'bad_output', /格式/], ['invalid_result', 'bad_output', /格式/], ['empty_reply', 'bad_output', /沒有回覆內容/], ['reply_too_long', 'bad_output', /過長/],
    ['input_too_large', 'invalid_config', /8,000 字/], ['ai_queue_full', 'rate_limited', /排隊/], ['provider_error', 'unknown', /無法完成/], ['something_new', 'unknown', /無法完成/]
  ]
  for (const [code, llm, message] of cases) {
    const error = toProviderError(new AiTaskError(code))
    assert.ok(error instanceof LlmProviderError, code)
    assert.equal(error.code, llm, code)
    assert.match(error.userMessage, message, code)
  }
  assert.match(toProviderError(new AiTaskError('quota_exhausted', 95_000)).userMessage, /約 95 秒後/)
  assert.equal(toProviderError(new Error('boom')).code, 'unknown', 'a non-bridge error never leaks its message')
  // end to end through complete()
  const { q } = queue()
  q.touch()
  const provider = createUiAiProvider(q)
  const call = provider.complete({ system: 'S', user: 'U' })
  q.commit({ results: [{ taskId: q.pull().tasks[0].taskId, ok: false, failCode: 'rate_limited', retryAfterMs: 20_000 }] })
  const error = await rejection(call)
  assert.ok(error instanceof LlmProviderError)
  assert.equal(error.code, 'rate_limited')
  assert.match(error.userMessage, /約 20 秒後/)
  const none = await rejection(createUiAiProvider(new AiTaskQueue()).complete({ system: 'S', user: 'U' }))
  assert.equal(none.code, 'invalid_config')
})

// ───────────── payload fitting (groupTopics) ─────────────

test('fitUserPayload: leaves small payloads alone; for a group payload drops the oldest existing topics first, then shortens long messages — every message is kept; impossible input is refused', () => {
  const small = JSON.stringify({ existingLocalTopics: [], messages: [{ msgId: 'a', text: 'hi' }] })
  assert.equal(fitUserPayload(small, 7500), small)
  const topics = Array.from({ length: 100 }, (_, i) => ({ ref: `t${i}`, title: `議題${i}`, summary: '很長的摘要。'.repeat(20) }))
  const messages = Array.from({ length: 20 }, (_, i) => ({ msgId: `m${i}`, ts: i, direction: 'in', text: `訊息${i}：` + '內容'.repeat(60) }))
  const big = JSON.stringify({ existingLocalTopics: topics, messages })
  assert.ok(big.length > 7500)
  const fitted = fitUserPayload(big, 7500)
  assert.ok(fitted.length <= 7500, `${fitted.length}`)
  const parsed = JSON.parse(fitted)
  assert.deepEqual(parsed.messages.map((m) => m.msgId), messages.map((m) => m.msgId), 'assignments must cover every message: none dropped')
  assert.deepEqual(parsed.existingLocalTopics.map((t) => t.ref), topics.slice(0, parsed.existingLocalTopics.length).map((t) => t.ref), 'the newest topics (listed first) are the ones kept')
  // long messages and few topics: texts get shortened
  const longMessages = JSON.stringify({ existingLocalTopics: [], messages: Array.from({ length: 20 }, (_, i) => ({ msgId: `m${i}`, ts: i, direction: 'in', text: 'あ'.repeat(3000) })) })
  const shortened = JSON.parse(fitUserPayload(longMessages, 7500))
  assert.equal(shortened.messages.length, 20)
  assert.ok(shortened.messages.every((m) => m.text.length < 3000 && m.text.endsWith('…')))
  assert.throws(() => fitUserPayload('x'.repeat(8000), 7500), (e) => e instanceof AiTaskError && e.code === 'input_too_large')
  assert.throws(() => fitUserPayload(JSON.stringify([1].concat(Array(9000).fill('y'))), 7500), (e) => e.code === 'input_too_large')
  assert.throws(() => fitUserPayload(JSON.stringify({ messages: Array.from({ length: 700 }, (_, i) => ({ msgId: `m${i}`, text: 'z' })) }), 7500), (e) => e.code === 'input_too_large', 'too many messages even at 20 chars each')
})

// ───────────── output contract ─────────────

test('output contract: the extraction schema is spelled out in the prompt text (ai:chat has no structured output) and fits the system limit together with the rules', async () => {
  assert.ok(EXTRACT_OUTPUT_CONTRACT.includes(JSON.stringify(EXTRACT_JSON_SCHEMA.schema)))
  assert.match(EXTRACT_OUTPUT_CONTRACT, /不要用 Markdown/)
  const { EXTRACT_SYSTEM_PROMPT } = await import('../../src/main/llm/extractPrompt.ts')
  assert.ok(EXTRACT_SYSTEM_PROMPT.length + 2 + EXTRACT_OUTPUT_CONTRACT.length <= CONTRACT.limits.systemChars, `${EXTRACT_SYSTEM_PROMPT.length} + ${EXTRACT_OUTPUT_CONTRACT.length}`)
})

// ───────────── dispatcher ─────────────

function dispatcherWith({ api = {}, aiTasks, queue: q } = {}) {
  const hub = new EventHub()
  const dispatcher = new Dispatcher({
    getApi: () => api,
    hub,
    queue: q ?? { stats: () => ({}), pull: () => ({ ok: true, items: [] }), release: (p) => ({ ok: true, released: p.itemIds.length, unknown: [] }) },
    aiTasks,
    info: () => ({}),
    softDeadlineMs: 30,
    maxJobWaitMs: 50
  })
  return { dispatcher, hub, done: () => { dispatcher.dispose(); hub.dispose() } }
}
const invoke = (d, path, ...args) => d.call('api.invoke', { path, args })

test('dispatcher: ai.run runs the core method (draftReply / analyzeNotMine / groupTopics) with the right arguments inside the AI context; bad kinds and arguments are refused', async () => {
  const aiTasks = new AiTaskQueue()
  const seen = []
  const api = {
    db: { todos: { draftReply: async (id) => { seen.push(['draft', id]); return { draft: await createUiAiProvider(aiTasks).complete({ system: 'D', user: 'U' }).then((r) => r.text) } }, analyzeNotMine: async (id) => ({ ok: true, id }) } },
    groupTopics: { analyze: async (chatId) => ({ ok: true, chatId }) }
  }
  const { dispatcher, done } = dispatcherWith({ api, aiTasks })
  aiTasks.touch()
  const run = invoke(dispatcher, 'ai.run', { kind: 'draftReply', args: ['todo-1'] })
  await sleep(5)
  const pulled = await invoke(dispatcher, 'ai.pull', { max: 1 })
  assert.equal(pulled.ok, true)
  assert.equal(pulled.value.tasks.length, 1)
  assert.equal(pulled.value.tasks[0].kind, 'draftReply', 'the kind set by ai.run reaches the task')
  const committed = await invoke(dispatcher, 'ai.commit', { results: [{ taskId: pulled.value.tasks[0].taskId, ok: true, text: '草稿', model: 'm' }] })
  assert.equal(committed.value.results[0].status, 'accepted')
  assert.deepEqual(await run, { ok: true, value: { draft: '草稿' } })
  assert.deepEqual(seen, [['draft', 'todo-1']])
  assert.deepEqual((await invoke(dispatcher, 'ai.run', { kind: 'analyzeNotMine', args: ['f1'] })).value, { ok: true, id: 'f1' })
  assert.deepEqual((await invoke(dispatcher, 'ai.run', { kind: 'groupTopics', args: ['g1'] })).value, { ok: true, chatId: 'g1' })
  for (const bad of [{ kind: 'extract' }, { kind: '__proto__' }, { kind: 'constructor' }, { kind: 'draftReply', args: 'x' }, { kind: 'draftReply', args: [1, 2, 3, 4, 5] }, 'draftReply', null, {}]) {
    const result = await invoke(dispatcher, 'ai.run', bad)
    assert.deepEqual({ ok: result.ok, code: result.code }, { ok: false, code: 'invalid_args' }, JSON.stringify(bad))
  }
  assert.equal((await invoke(dispatcher, 'ai.commit', { results: [] })).code, 'invalid_args')
  assert.equal((await invoke(dispatcher, 'ai.commit', { results: Array(5).fill({}) })).code, 'invalid_args')
  assert.equal((await invoke(dispatcher, 'ai.release', { taskIds: [1] })).code, 'invalid_args')
  assert.equal((await invoke(dispatcher, 'ai.release', { taskIds: ['nope'] })).value.released, 0)
  done()
})

test('dispatcher: without the bridge the ai.* paths say so; the three direct AI paths stay "unsupported_in_plugin" (UI goes through ai.run); extract.release validates; extract.system carries the output format', async () => {
  const { dispatcher, done } = dispatcherWith({})
  for (const path of ['ai.pull', 'ai.commit', 'ai.release', 'ai.run']) assert.equal((await invoke(dispatcher, path, { kind: 'draftReply', results: [{}], taskIds: ['a'] })).code, 'ai_bridge_unavailable', path)
  for (const path of ['db.todos.draftReply', 'db.todos.analyzeNotMine', 'groupTopics.analyze']) {
    const result = await invoke(dispatcher, path, 'x')
    assert.deepEqual({ code: result.code, route: result.route }, { code: 'unsupported_in_plugin', route: 'ui_ai_chat' }, path)
    assert.ok(UNSUPPORTED_API_PATHS[path] && !SUPPORTED_API_PATHS.includes(path))
  }
  assert.deepEqual(Object.keys(AI_RUN_PATHS).sort(), ['analyzeNotMine', 'draftReply', 'groupTopics'])
  assert.equal((await invoke(dispatcher, 'extract.release', { itemIds: [] })).code, 'invalid_args')
  assert.equal((await invoke(dispatcher, 'extract.release', { itemIds: [1] })).code, 'invalid_args')
  assert.equal((await invoke(dispatcher, 'extract.release', { itemIds: Array(17).fill('a') })).code, 'invalid_args')
  assert.deepEqual((await invoke(dispatcher, 'extract.release', { itemIds: ['a', 'b'] })).value, { released: 2, unknown: [] })
  const system = (await invoke(dispatcher, 'extract.system')).value
  assert.equal(system.format, EXTRACT_OUTPUT_CONTRACT)
  assert.ok(system.chars + 2 + system.format.length <= CONTRACT.limits.systemChars)
  done()
})

test('dispatcher: an extract.pull counts as the UI being present, so a user action asked right after it is accepted instead of failing with ui_not_connected', async () => {
  const aiTasks = new AiTaskQueue({ consumerFreshMs: 10_000 })
  const { dispatcher, done } = dispatcherWith({ aiTasks, api: { db: { todos: { draftReply: async () => ({ draft: await createUiAiProvider(aiTasks).complete({ system: 'S', user: 'U' }).then((r) => r.text, (e) => e.userMessage) }) } } } })
  const before = await invoke(dispatcher, 'ai.run', { kind: 'draftReply', args: ['t'] })
  assert.match(before.value.draft, /看板不在前景/, 'nobody is polling yet')
  await invoke(dispatcher, 'extract.pull', {})
  const run = invoke(dispatcher, 'ai.run', { kind: 'draftReply', args: ['t'] })
  await sleep(5)
  assert.equal(aiTasks.stats().pending, 1, 'queued for the UI')
  const task = aiTasks.pull().tasks[0]
  aiTasks.commit({ results: [{ taskId: task.taskId, ok: true, text: '好' }] })
  assert.deepEqual((await run).value, { draft: '好' })
  done()
})
