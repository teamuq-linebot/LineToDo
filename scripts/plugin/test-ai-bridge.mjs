// 0.2.0 — the backend side of the single-shot AI features (草擬回覆／誤判分析／群組議題分析／prompt 修正): the provider that replaces provider.complete() and calls the AI port,
// the failure-code -> LlmProviderError mapping, the groupTopics payload fitter, the output contract, and the dispatcher paths (db.todos.draftReply …, ai.status, ai.options,
// the review gate). There is no AI relay any more: no ai.pull / ai.commit / ai.run, no extract.pull / extract.commit / extract.system — the backend calls host.ai.complete itself.
import assert from 'node:assert/strict'
import test from 'node:test'

import { AiPortError } from '../../src/core/aiPort.ts'
import { LlmProviderError } from '../../src/main/llm/provider/types.ts'
import { EXTRACT_JSON_SCHEMA } from '../../src/main/llm/schema.ts'
import { EXTRACT_OUTPUT_CONTRACT, outputContractFor } from '../../src/plugin/backend/aiOutputContract.ts'
import { AI_RUN_PATHS, AI_TASK_MAX_USER_CHARS, createPortAiProvider, fitUserPayload, runAs, toProviderError } from '../../src/plugin/backend/aiProvider.ts'
import { Dispatcher, SUPPORTED_API_PATHS, UNSUPPORTED_API_PATHS } from '../../src/plugin/backend/dispatcher.ts'
import { EventHub } from '../../src/plugin/backend/eventHub.ts'
import { createPromptService } from '../../src/plugin/backend/promptService.ts'
import { BACKEND_METHOD_GROUPS, backendMethodFor } from '../../src/shared/pluginWire.ts'
import { CONTRACT } from '../lib/mock-tuq-ai.mjs'
import { EXPECTED_AI_CHAT_REVOKED_TASK_TEXT, namesVersionSpecificPlace } from './lib/fenced-text.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const rejection = (promise) => promise.then(() => { throw new Error('expected a rejection') }, (error) => error)

/** A recording AI port: what the provider asked for, and what it answers. */
function fakePort(answer = () => ({ text: 'ok', model: 'gpt-5-codex' })) {
  const requests = []
  return {
    requests,
    complete: async (request) => {
      requests.push(request)
      const result = await answer(request)
      if (result instanceof Error) throw result
      return result
    }
  }
}

// ───────────── provider ─────────────

test('port provider: complete() hands system/user to the AI port as a user-priority request (kind from the dispatcher context, JSON expectation, schema appended to the system prompt) — no network, no process, no key', async () => {
  const port = fakePort(() => ({ text: '好的', model: 'gpt-5-codex' }))
  const provider = createPortAiProvider(port)
  assert.deepEqual({ id: provider.id, kind: provider.kind }, { id: 'codexCli', kind: 'cli' })

  const draft = await runAs('draftReply', () => provider.complete({ system: 'DRAFT', user: '{"a":1}', temperature: 0.5 }))
  assert.deepEqual(port.requests[0], { system: 'DRAFT', user: '{"a":1}', expectJson: false, priority: 'user' })
  assert.equal(draft.text, '好的')
  assert.deepEqual({ provider: draft.meta.provider, model: draft.meta.model }, { provider: 'codexCli', model: 'gpt-5-codex' })
  assert.equal(typeof draft.meta.durationMs, 'number')

  await runAs('analyzeNotMine', () => provider.complete({ system: 'ANALYZE', user: '{}' }))
  assert.equal(port.requests[1].expectJson, true, 'the analysis is JSON.parse\'d by core, so the port must verify JSON even without a schema')

  const schema = { type: 'object', properties: { a: { type: 'string' } } }
  await runAs('groupTopics', () => provider.complete({ system: 'TOPICS', user: '{}', jsonSchema: { name: 'group_topics', schema } }))
  assert.equal(port.requests[2].system, `TOPICS\n\n${outputContractFor(schema)}`)
  assert.ok(port.requests[2].system.includes(JSON.stringify(schema)))
  assert.equal(port.requests[2].expectJson, true)

  await provider.complete({ system: 'X', user: 'Y' })
  assert.equal(port.requests[3].expectJson, false, 'outside a kind context and without a schema no JSON is expected')
  assert.ok(port.requests.every((request) => request.priority === 'user'), 'user actions never queue behind background extraction')

  assert.equal((await provider.health()).ok, true)
  assert.equal((await createPortAiProvider(port, { usable: () => false }).health()).ok, false)
})

test('port provider: a request with a chat becomes a line-chat scoped port request (system = static rules, schema travels as dynamicContract); without it nothing changes', async () => {
  const port = fakePort(() => ({ text: '好的', model: 'gpt-5-codex' }))
  const provider = createPortAiProvider(port)
  const schema = { type: 'object', properties: { a: { type: 'string' } } }
  await runAs('draftReply', () => provider.complete({ system: 'DRAFT', user: '{"a":1}', conversation: { chatId: 'u-alice', kind: 'draftReply' } }))
  assert.deepEqual(port.requests[0], { system: 'DRAFT', user: '{"a":1}', expectJson: false, priority: 'user', conversationScope: { kind: 'line-chat', chatId: 'u-alice', taskKind: 'draftReply' } })
  await runAs('groupTopics', () => provider.complete({ system: 'TOPICS', user: '{}', jsonSchema: { name: 'group_topics', schema }, conversation: { chatId: 'g-1', kind: 'groupTopics' } }))
  assert.equal(port.requests[1].system, 'TOPICS', 'a scoped request keeps the rules static: the per-call schema is not appended')
  assert.equal(port.requests[1].dynamicContract, outputContractFor(schema))
  assert.deepEqual(port.requests[1].conversationScope, { kind: 'line-chat', chatId: 'g-1', taskKind: 'groupTopics' })
  assert.equal(port.requests[1].expectJson, true)
  await provider.complete({ system: 'TOPICS', user: '{}', jsonSchema: { name: 'group_topics', schema } })
  assert.equal(port.requests[2].system, `TOPICS\n\n${outputContractFor(schema)}`, 'no chat: the one-shot request is unchanged')
  assert.equal(port.requests[2].conversationScope, undefined)
  assert.equal(port.requests[2].dynamicContract, undefined)
})

test('port provider: every failure arrives as the LlmProviderError core already understands (right class, code, and a message the user can act on)', async () => {
  const cases = [
    ['ai_task_timeout', 'timeout', /逾時/], ['turn_timeout', 'timeout', /逾時/],
    ['rate_limited', 'rate_limited', /TeamUQ 的 AI 呼叫上限/], ['quota_exhausted', 'quota_exceeded', /額度已用完/], ['provider_unavailable', 'invalid_config', /Codex/],
    ['provider_not_ready', 'invalid_config', /Codex/], ['unsupported_version', 'invalid_config', /Codex/], ['model_unavailable', 'invalid_config', /Codex/],
    ['access_revoked', 'invalid_config', /ai:chat/], ['not_granted', 'invalid_config', /ai:chat/],
    ['invalid_json', 'bad_output', /格式/], ['invalid_result', 'bad_output', /格式/], ['empty_reply', 'bad_output', /沒有回覆內容/], ['reply_too_long', 'bad_output', /過長/],
    ['input_too_large', 'invalid_config', /8,000 字/], ['system_too_large', 'invalid_config', /8,000 字/], ['busy', 'rate_limited', /其他工作/], ['session_limit', 'rate_limited', /其他工作/],
    ['plugin_host_unavailable', 'transport', /暫時沒有回應/], ['plugin_host_timeout', 'transport', /暫時沒有回應/], ['backend_stopped', 'transport', /停止/], ['provider_error', 'unknown', /無法完成/], ['something_new', 'unknown', /無法完成/]
  ]
  for (const [code, llm, message] of cases) {
    const error = toProviderError(new AiPortError(code))
    assert.ok(error instanceof LlmProviderError, code)
    assert.equal(error.code, llm, code)
    assert.match(error.userMessage, message, code)
  }
  assert.match(toProviderError(new AiPortError('quota_exhausted', 95_000)).userMessage, /約 95 秒後/)
  // review F9: the sentence names the window that is actually full — minute or hour — and does not claim "minute" when it does not know
  assert.match(toProviderError(new AiPortError('rate_limited', 20_000, 'minute')).userMessage, /每分鐘上限/)
  assert.match(toProviderError(new AiPortError('rate_limited', 1_200_000, 'hour')).userMessage, /每小時上限.*約 1200 秒後/)
  assert.doesNotMatch(toProviderError(new AiPortError('rate_limited', 1_200_000, 'hour')).userMessage, /每分鐘/)
  assert.doesNotMatch(toProviderError(new AiPortError('rate_limited', 20_000)).userMessage, /每分鐘|每小時/, 'a rate_limited from the host does not say which window')
  // 0.1.3 r1: ai:chat off — where to allow it again, word for word, in names both TeamUQ 1.6.8 and 1.7.1 show (was 「請在 TeamUQ 設定中重新允許」)
  for (const code of ['access_revoked', 'not_granted', 'plugin_not_active']) {
    const message = toProviderError(new AiPortError(code)).userMessage
    assert.equal(message, EXPECTED_AI_CHAT_REVOKED_TASK_TEXT, code)
    assert.equal(namesVersionSpecificPlace(message), false, code)
  }
  assert.equal(toProviderError(new Error('boom')).code, 'unknown', 'a non-port error never leaks its message')
  // end to end through complete()
  const call = createPortAiProvider(fakePort(() => new AiPortError('rate_limited', 20_000))).complete({ system: 'S', user: 'U' })
  const error = await rejection(call)
  assert.ok(error instanceof LlmProviderError)
  assert.equal(error.code, 'rate_limited')
  assert.match(error.userMessage, /約 20 秒後/)
  // a payload over the limit never reaches the port
  const port = fakePort()
  const tooBig = await rejection(createPortAiProvider(port).complete({ system: 'S', user: 'x'.repeat(AI_TASK_MAX_USER_CHARS + 1) }))
  assert.equal(tooBig.code, 'invalid_config')
  assert.equal(port.requests.length, 0)
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
  assert.throws(() => fitUserPayload('x'.repeat(8000), 7500), (e) => e instanceof AiPortError && e.code === 'input_too_large')
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

// ───────────── prompt service (settings.prompt.refine) ─────────────

test('prompt refinement goes through the AI port as a user action; a suggestion that is not the agreed shape gets the port\'s repair turn and is never applied; AI errors keep their code', async () => {
  const stored = { pluginPrompt: null }
  const settings = { get: () => stored, update: (patch) => Object.assign(stored, patch) }
  const good = { prompt: '新的提示詞', changes: ['區分寒暄與任務'] }
  const port = fakePort((request) => ({ text: JSON.stringify(good), value: good, model: 'gpt-5-codex' }))
  const prompts = createPromptService(settings, port)
  const suggestion = await prompts.refine({ prompt: prompts.state().activePrompt, goal: '避免把寒暄當成任務' })
  assert.deepEqual(suggestion, { ...good, modelId: 'gpt-5-codex' })
  assert.equal(port.requests[0].priority, 'user')
  assert.equal(port.requests[0].expectJson, true)
  assert.ok(port.requests[0].system.includes('提示詞編輯者') && port.requests[0].system.length <= CONTRACT.limits.systemChars)
  assert.equal(port.requests[0].user, '避免把寒暄當成任務')
  // the port is given a validator that rejects extra fields / bad changes (so its repair turn can fix them)
  assert.equal(port.requests[0].validate(good).ok, true)
  assert.equal(port.requests[0].validate({ ...good, extra: 1 }).ok, false)
  assert.equal(port.requests[0].validate({ prompt: 'x', changes: [] }).ok, false)
  assert.equal(stored.pluginPrompt, null, 'a suggestion is never written to the settings')
  // the port gave up on the format: the settings screen gets the prompt-specific code
  const invalid = createPromptService(settings, fakePort(() => new AiPortError('invalid_result')))
  assert.equal((await rejection(invalid.refine({ prompt: invalid.state().activePrompt, goal: 'g' }))).code, 'prompt_suggestion_invalid')
  // other AI errors keep the port's code (the settings screen maps quota_exhausted / provider_unavailable / busy …)
  const quota = createPromptService(settings, fakePort(() => new AiPortError('quota_exhausted', 1000)))
  assert.equal((await rejection(quota.refine({ prompt: quota.state().activePrompt, goal: 'g' }))).code, 'quota_exhausted')
  // the extraction system the worker sends: the active prompt + the fixed output format
  assert.equal(prompts.extractSystem(), `${prompts.state().activePrompt}\n\n${EXTRACT_OUTPUT_CONTRACT}`)
  settings.update({ pluginPrompt: '自訂規則' })
  assert.equal(prompts.extractSystem(), `自訂規則\n\n${EXTRACT_OUTPUT_CONTRACT}`, 'a saved prompt takes effect at the next item, no restart, no cache')
})

// ───────────── dispatcher ─────────────

function dispatcherWith({ api = {}, ai, review, aiDeadlineMs } = {}) {
  const hub = new EventHub()
  const dispatcher = new Dispatcher({
    getApi: () => api,
    hub,
    queue: { stats: () => ({ pending: 2, leased: 1, awaiting: 0, chatsBackingOff: 0, gen: 1 }) },
    ai,
    review,
    info: () => ({}),
    softDeadlineMs: 30,
    maxJobWaitMs: 50,
    ...(aiDeadlineMs !== undefined ? { aiDeadlineMs } : {})
  })
  return { dispatcher, hub, done: () => { dispatcher.dispose(); hub.dispose() } }
}
const invoke = (d, path, ...args) => d.call(backendMethodFor(path), { path, args })

const BASE_STATUS = { state: 'running', reason: null, resumeAt: null, busy: false, provider: { providerId: 'codex', modelId: 'gpt-5-codex' }, counters: { turns: 0 } }
function aiRuntime(overrides = {}) {
  const calls = []
  return {
    calls,
    ready: async () => { calls.push('ready'); return true },
    status: () => ({ ...BASE_STATUS, ...overrides }),
    options: async () => { calls.push('options'); return { providers: [], defaultProviderId: null } },
    refresh: () => { calls.push('refresh') }
  }
}

test('dispatcher: the three AI features are ordinary backend paths now — draftReply / analyzeNotMine / groupTopics.analyze run the core method with the right arguments inside their AI context', async () => {
  const seen = []
  const port = fakePort(() => ({ text: '草稿', model: 'm' }))
  const provider = createPortAiProvider(port)
  const api = {
    db: { todos: { draftReply: async (id) => { seen.push(['draft', id]); return { draft: (await provider.complete({ system: 'D', user: 'U' })).text } }, analyzeNotMine: async (id) => { await provider.complete({ system: 'A', user: '{}' }); return { ok: true, id } } } },
    groupTopics: { analyze: async (chatId) => { await provider.complete({ system: 'G', user: '{}' }); return { ok: true, chatId } } }
  }
  const { dispatcher, done } = dispatcherWith({ api })
  for (const path of ['db.todos.draftReply', 'db.todos.analyzeNotMine', 'groupTopics.analyze']) {
    assert.ok(SUPPORTED_API_PATHS.includes(path) && !UNSUPPORTED_API_PATHS[path], path)
  }
  assert.deepEqual((await invoke(dispatcher, 'db.todos.draftReply', 'todo-1')).value, { draft: '草稿' })
  assert.deepEqual(seen, [['draft', 'todo-1']])
  assert.deepEqual((await invoke(dispatcher, 'db.todos.analyzeNotMine', 'f1')).value, { ok: true, id: 'f1' })
  assert.deepEqual((await invoke(dispatcher, 'groupTopics.analyze', 'g1')).value, { ok: true, chatId: 'g1' })
  assert.deepEqual(port.requests.map((request) => request.expectJson), [false, true, true], 'the kind decides whether JSON is expected: draft = text, analysis / topics = JSON')
  assert.deepEqual(Object.keys(AI_RUN_PATHS).sort(), ['analyzeNotMine', 'draftReply', 'groupTopics'])
  done()
})

test('dispatcher: the 0.1.x relay is gone — ai.pull / ai.commit / ai.release / ai.run and extract.pull / extract.commit / extract.release / extract.system are not paths any more; extract.stats stays', async () => {
  const { dispatcher, done } = dispatcherWith({ ai: aiRuntime() })
  for (const path of ['ai.pull', 'ai.commit', 'ai.release', 'ai.run', 'extract.pull', 'extract.commit', 'extract.release', 'extract.system']) {
    const result = await invoke(dispatcher, path, { max: 1, results: [{}], itemIds: ['a'], taskIds: ['a'], kind: 'draftReply' })
    assert.deepEqual({ ok: result.ok, code: result.code }, { ok: false, code: 'path_unknown' }, path)
    assert.equal(SUPPORTED_API_PATHS.includes(path), false, path)
  }
  assert.deepEqual((await invoke(dispatcher, 'extract.stats')).value, { pending: 2, leased: 1, awaiting: 0, chatsBackingOff: 0, gen: 1 })
  // nothing in the wire vocabulary lets a view lease or commit extraction work
  assert.ok(BACKEND_METHOD_GROUPS.includes('ai') && BACKEND_METHOD_GROUPS.includes('extract'))
  done()
})

test('dispatcher: ai.status reports the backend\'s AI state (optionally re-probing first) and ai.options passes the host\'s model list; both say so when AI is not wired', async () => {
  const ai = aiRuntime({ state: 'paused', reason: 'rate_limited', resumeAt: 123 })
  const { dispatcher, done } = dispatcherWith({ ai })
  const status = await invoke(dispatcher, 'ai.status', {})
  assert.deepEqual({ ok: status.ok, state: status.value.state, reason: status.value.reason, resumeAt: status.value.resumeAt }, { ok: true, state: 'paused', reason: 'rate_limited', resumeAt: 123 })
  assert.deepEqual(ai.calls, ['ready'])
  await invoke(dispatcher, 'ai.status', { refresh: true })
  assert.deepEqual(ai.calls, ['ready', 'refresh', 'ready'], 'refresh: true forgets the cache first, then re-probes')
  assert.deepEqual((await invoke(dispatcher, 'ai.options')).value, { providers: [], defaultProviderId: null })
  done()

  const failing = aiRuntime()
  failing.options = async () => { throw Object.assign(new Error('host request failed: not_granted'), { code: 'not_granted' }) }
  const second = dispatcherWith({ ai: failing })
  const denied = await invoke(second.dispatcher, 'ai.options')
  assert.deepEqual({ ok: denied.ok, code: denied.code }, { ok: false, code: 'not_granted' }, 'the settings screen decides the sentence from the host\'s code')
  second.done()

  const bare = dispatcherWith({})
  assert.equal((await invoke(bare.dispatcher, 'ai.status')).code, 'ai_unavailable')
  assert.equal((await invoke(bare.dispatcher, 'ai.options')).code, 'ai_unavailable')
  bare.done()
})

test('dispatcher (review F1): ai.status / ai.options never wait for a TeamUQ that does not answer — they give up before the 30 s host call limit (which would get the whole backend isolated), answering with the last known state', async () => {
  const never = new Promise(() => undefined)
  const hung = aiRuntime({ state: 'unavailable', reason: 'host_unavailable' })
  hung.ready = () => { hung.calls.push('ready'); return never }
  hung.options = () => { hung.calls.push('options'); return never }
  const { dispatcher, done } = dispatcherWith({ ai: hung, aiDeadlineMs: 60 })
  const raced = (promise) => Promise.race([promise, sleep(1500).then(() => ({ hung: true }))])
  const t0 = Date.now()
  const status = await raced(invoke(dispatcher, 'ai.status', {}))
  assert.notEqual(status.hung, true, 'ai.status answered although ready() never resolves')
  assert.deepEqual({ ok: status.ok, state: status.value.state, reason: status.value.reason }, { ok: true, state: 'unavailable', reason: 'host_unavailable' }, 'the last known status')
  const options = await raced(invoke(dispatcher, 'ai.options'))
  assert.notEqual(options.hung, true, 'ai.options answered although the host never does')
  assert.deepEqual({ ok: options.ok, code: options.code }, { ok: false, code: 'plugin_host_timeout' })
  assert.ok(Date.now() - t0 < 1200, 'both answered at their own deadline')
  // a ready() that fails late must not become an unhandled rejection
  const late = aiRuntime()
  late.ready = () => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 120))
  const lateDispatcher = dispatcherWith({ ai: late, aiDeadlineMs: 20 })
  assert.equal((await invoke(lateDispatcher.dispatcher, 'ai.status', {})).ok, true)
  await sleep(200)
  lateDispatcher.done()
  done()
})

test('dispatcher: reviewLastDays does not start when the AI cannot work (not logged in, permission off, not wired) — an immediate, explained failure, not a 15-minute wait; a rate limit or quota pause still queues', async () => {
  const ran = []
  const review = { run: async (days, fn) => { ran.push(days); return fn() } }
  const api = { pipeline: { reviewLastDays: async (days) => ({ ok: true, days }) } }
  for (const [overrides, pattern] of [
    [{ state: 'unavailable', reason: 'provider_not_logged_in' }, /尚未登入/],
    [{ state: 'revoked', reason: 'access_revoked' }, /ai:chat/],
    [{ state: 'stopped' }, /尚未啟動/]
  ]) {
    const { dispatcher, done } = dispatcherWith({ api, review, ai: aiRuntime(overrides) })
    const result = (await invoke(dispatcher, 'pipeline.reviewLastDays', 3)).value
    assert.equal(result.ok, false)
    assert.equal(result.days, 3)
    assert.match(result.note, pattern)
    assert.equal(result.chatsSeen, 0)
    done()
  }
  assert.deepEqual(ran, [], 'the review never started')
  for (const overrides of [{ state: 'running' }, { state: 'paused', reason: 'rate_limited', resumeAt: 5 }, { state: 'paused', reason: 'quota_exhausted', resumeAt: 5 }]) {
    const { dispatcher, done } = dispatcherWith({ api, review, ai: aiRuntime(overrides) })
    assert.deepEqual((await invoke(dispatcher, 'pipeline.reviewLastDays', 2)).value, { ok: true, days: 2 })
    done()
  }
  assert.deepEqual(ran, [2, 2, 2])
})

test('dispatcher: AI features that are slower than the soft deadline become jobs (a draft can take as long as the model needs); the result arrives through job.poll', async () => {
  const api = { db: { todos: { draftReply: async () => { await sleep(80); return { draft: '慢慢寫好的草稿' } } } } }
  const { dispatcher, done } = dispatcherWith({ api })
  const first = await invoke(dispatcher, 'db.todos.draftReply', 't1')
  assert.equal(first.pending, true)
  let polled = await invoke(dispatcher, 'job.poll', { jobId: first.jobId, waitMs: 50 })
  for (let i = 0; i < 20 && polled.pending; i += 1) polled = await invoke(dispatcher, 'job.poll', { jobId: first.jobId, waitMs: 50 })
  assert.deepEqual(polled.value, { draft: '慢慢寫好的草稿' })
  done()
})

test('method groups: `ai` and `extract` are still declared (ai.status / ai.options / extract.stats), `driver` is not, and no path of the removed relay maps to a group', () => {
  assert.equal(backendMethodFor('ai.status'), 'ai')
  assert.equal(backendMethodFor('ai.options'), 'ai')
  assert.equal(backendMethodFor('extract.stats'), 'extract')
  assert.equal(backendMethodFor('driver.postDraft'), null)
  assert.ok(BACKEND_METHOD_GROUPS.length <= 32, 'the manifest allows 32 backendMethods')
})
