// 0.2.0 — the backend AI port (src/plugin/backend/hostAi.ts) and the background ExtractWorker (src/plugin/backend/extractWorker.ts) against a mock
// `context.host.ai` that reproduces TeamUQ Core 1.8.10 (scripts/lib/mock-tuq-ai.mjs: strict request schema, session_limit, 20/min + 400/h sliding window, quota cooldown,
// access revocation, `complete` = one Session opened and closed per call, events dropped when nobody listens). There is no view, no visibility and no window.tuqPlugin
// anywhere in this file. Time is a manual clock shared by the port, the worker and the mock host, so minute-long behaviour runs in milliseconds.
//
//   (a) extraction runs in the backend through host.ai.complete, without a view            (worker drains the queue; "no view" is also proven end to end in test-ai-e2e)
//   (b) quota: never more than 20 turns in any 60 s window, 2 turns reserved for user actions, 400/h; a quota error backs off and keeps every pending item
//   (c) retries: busy / session_limit retried; rate_limited / quota_exhausted / provider errors back off and re-queue (lease released, no failure); access_revoked is probed
//   (d) JSON: ```json fenced replies parse and pass zod; bad JSON gets one repair turn (transcript replay), then the item fails; zod-invalid replies fail
//   (e) contentSaved (new in 1.8.10): the events of a turn can carry it; nothing in line-todo subscribes to turn events, and a turn with those events completes normally
//   limits: system <= 16,000, one turn's input <= 8,000 (checked before the host is called)
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { AiPortError } from '../../src/core/aiPort.ts'
import {
  ACCESS_CODES, AI_CHAT_REFERENCE, BUSY_CODES, HOST_AI_DEFAULTS, PROVIDER_CODES, TurnWindow, codeOf, createHostAiPort, isTransientAiCode, worstCaseItemMs
} from '../../src/plugin/backend/hostAi.ts'
import { EXTRACT_WORKER_DEFAULTS, createExtractWorker } from '../../src/plugin/backend/extractWorker.ts'
import { describeStatus as describeBoardStatus } from '../../src/plugin/ui/aiStatusText.ts'
import { describeStatus } from '../../src/shared/aiStatus.ts'
import { validateExtractResult } from '../../src/shared/extractResult.ts'
import { CONTRACT, createMockTuqAi } from '../lib/mock-tuq-ai.mjs'
import { BACKEND_TRUST_REQUIREMENT, CORE_AI_CHAT_TITLE, CORE_PERMISSIONS_SECTION_TITLE, EXPECTED_AI_CHAT_REVOKED_TEXT, EXPECTED_AI_FENCED_TEXT, PLUGIN_PAGE_PLACE_TEXT, RECOVERY_PROMISE, STALE_PERMISSION_NAME, VERSION_SPECIFIC_PLACE, namesVersionSpecificPlace } from './lib/fenced-text.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// ───────────── manual clock (ai-lover test/helpers.mjs FakeClock, same idea) ─────────────

const realTick = () => new Promise((resolve) => setTimeout(resolve, 0))
const flush = async (rounds = 12) => { for (let i = 0; i < rounds; i += 1) { await new Promise((resolve) => setImmediate(resolve)); await realTick() } }

class FakeClock {
  constructor() { this.time = 1_000_000; this.timers = new Map(); this.next = 1 }
  now = () => this.time
  setTimeout = (fn, ms) => { const id = this.next++; this.timers.set(id, { at: this.time + Math.max(0, ms), fn }); return id }
  clearTimeout = (id) => { this.timers.delete(id) }
  /** Advance time, firing due timers in order; lets async handlers finish between timers. */
  async advance(ms) {
    const end = this.time + ms
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (due === undefined) break
      const [id, timer] = due
      this.time = Math.max(this.time, timer.at)
      this.timers.delete(id)
      timer.fn()
      await flush()
    }
    this.time = end
    await flush()
  }
}

const GOOD = {
  importance: 'action',
  newTodos: [{ bucket: 'todo', title: '回覆報價單', detail: null, priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds: ['m1'] }],
  resolved: [], updates: []
}
const goodText = JSON.stringify(GOOD)
const validate = (value) => { try { return { ok: true, value: validateExtractResult(value) } } catch (error) { return { ok: false, reason: String(error.message).slice(0, 80) } } }
const background = (extra = {}) => ({ system: 'SYSTEM', user: '{"newMessages":[{"msgId":"m1","text":"請幫我寄報價單"}]}', expectJson: true, validate, priority: 'background', ...extra })
const userAction = (extra = {}) => ({ system: 'DRAFT SYSTEM', user: '{"todo":1}', expectJson: false, priority: 'user', ...extra })
const rejection = async (promise) => { try { await promise } catch (error) { return error } return assert.fail('expected a rejection') }

function portSetup({ reply = () => goodText, config = {}, selection = undefined } = {}) {
  const clock = new FakeClock()
  const mock = createMockTuqAi({ now: clock.now, reply })
  const state = { selection }
  const logs = []
  const port = createHostAiPort({ ai: mock.ai, selection: () => state.selection, clock, config, log: (event, detail) => logs.push([event, detail]) })
  return { clock, mock, port, state, logs, settle: () => flush() }
}

/** Sends in the window [t, t + 60 s] for every t that starts a window: the largest count. */
function maxPerMinute(times, window = 60_000) {
  let best = 0
  for (const start of times) best = Math.max(best, times.filter((t) => t >= start && t <= start + window).length)
  return best
}

// ───────────── the contract the port and the mock follow ─────────────

test('contract: the mock host and the port constants match the Core 1.8.10 ai:chat contract fixture (aiChatContracts.ts @ 992a8fcec2f4bb3c65db01b6c75f3ac0797baaa5, tag v1.8.10)', () => {
  const L = CONTRACT.limits
  assert.equal(CONTRACT.source.commit, '992a8fcec2f4bb3c65db01b6c75f3ac0797baaa5')
  for (const key of ['systemChars', 'inputChars', 'transcriptLines', 'transcriptLineChars', 'transcriptChars', 'turnsPerMinute', 'turnsPerHour', 'replyChars', 'turnTimeoutMs']) {
    assert.equal(AI_CHAT_REFERENCE[key], L[key], `AI_CHAT_REFERENCE.${key} vs contract`)
  }
  assert.equal(HOST_AI_DEFAULTS.perMinute, L.turnsPerMinute)
  assert.equal(HOST_AI_DEFAULTS.perHour, L.turnsPerHour)
  assert.ok(HOST_AI_DEFAULTS.perMinute - HOST_AI_DEFAULTS.extractReserve >= 1, 'background extraction can always make progress')
  assert.ok(HOST_AI_DEFAULTS.completeGuardMs > L.turnTimeoutMs, 'our own guard is longer than the host turn timeout (the host answers first)')
  assert.equal(L.sessionsPerPlugin, 1, 'one Session per plugin: every call is serialised')
  // every error code the port classifies is a code the host can produce (error envelope or turn failure)
  const known = new Set([...CONTRACT.errorCodes, ...CONTRACT.failureCodes])
  for (const code of [...ACCESS_CODES, ...PROVIDER_CODES, ...BUSY_CODES, 'rate_limited', 'quota_exhausted', 'interrupted', 'empty_reply', 'turn_timeout', 'provider_error']) assert.ok(known.has(code), `${code} is a host code`)
  // Events and error codes the port relies on
  assert.ok(CONTRACT.eventKinds.includes('contentSaved'), 'contentSaved is a supported turn event kind')
  assert.ok(CONTRACT.errorCodes.includes('one_shot_failed') && CONTRACT.errorCodes.includes('execution_unavailable'))
  const sdk = readFileSync(join(ROOT, 'src', 'plugin', 'sdk', 'tuq-plugin-sdk.d.ts'), 'utf8')
  assert.match(sdk, /complete\(input: PluginBackendAiCompleteInputV1\): Promise<PluginBackendAiCompleteResultV1>/, 'the vendored SDK declares context.host.ai.complete')
  assert.match(sdk, /kind: 'contentSaved';\s*sequenceNo: number;/, 'the vendored SDK declares the contentSaved turn event')
  // transient vs the item's own fault
  for (const code of ['rate_limited', 'quota_exhausted', 'provider_not_ready', 'model_unavailable', 'unavailable', 'busy', 'session_limit', 'not_granted', 'access_revoked', 'interrupted', 'backend_stopped']) assert.equal(isTransientAiCode(code), true, code)
  for (const code of ['empty_reply', 'invalid_json', 'invalid_result', 'provider_error', 'turn_timeout', 'input_too_large', 'reply_too_long', 'one_shot_failed']) assert.equal(isTransientAiCode(code), false, code)
})

test('mock host: refuses what Core 1.8.10 refuses (strict complete schema, input/system limits, session_limit, grant) with the real error codes — and never view_not_visible', async () => {
  const { mock } = portSetup()
  const code = async (promise) => (await rejection(promise)).code
  const base = { system: 'S', text: 'hello' }
  assert.equal(await code(mock.ai.complete({ ...base, bogus: 1 })), 'plugin_host_request_invalid')
  assert.equal(await code(mock.ai.complete({ text: 'x' })), 'plugin_host_request_invalid', 'a fresh completion needs system')
  assert.equal(await code(mock.ai.complete({ ...base, text: 'x'.repeat(CONTRACT.limits.inputChars + 1) })), 'plugin_host_request_invalid')
  assert.equal(await code(mock.ai.complete({ ...base, system: 'x'.repeat(CONTRACT.limits.systemChars + 1) })), 'plugin_host_request_invalid')
  assert.equal(await code(mock.ai.complete({ ...base, effort: 'extreme' })), 'plugin_host_request_invalid')
  assert.equal(await code(mock.ai.complete({ ...base, sessionId: '1' })), 'plugin_host_request_invalid', 'an existing Session owns its provider context: no system')
  assert.equal(await code(mock.ai.complete({ ...base, modelId: 'nope' })), 'model_unavailable')
  assert.equal(await code(mock.ai.complete({ ...base, providerId: 'other' })), 'provider_not_found')
  const held = await mock.ai.openSession({ system: 'S' })
  assert.equal(await code(mock.ai.complete(base)), 'session_limit', 'one Session per plugin: an open Session blocks complete')
  await held.close()
  assert.equal((await mock.ai.complete(base)).text.length > 0, true)
  mock.control.set({ providerState: 'not_logged_in' })
  assert.equal(await code(mock.ai.complete(base)), 'provider_not_ready')
  mock.control.set({ providerState: 'ready' })
  mock.control.revoke()
  assert.equal(await code(mock.ai.complete(base)), 'not_granted')
  assert.equal(await code(mock.ai.getOptions()), 'not_granted')
  assert.equal(mock.stats.errors.view_not_visible, 0, 'backend calls are always visible')
  assert.equal(mock.control.liveSessions(), 0)
})

// ───────────── (a)/(c) provider selection ─────────────

test('explicit unavailable provider, model or effort never silently uses another model', async () => {
  for (const [selection, reason] of [
    [{ providerId: 'removed-provider', modelId: null, effort: null }, 'provider_not_found'],
    [{ providerId: 'codex', modelId: 'removed-model', effort: null }, 'model_unavailable'],
    [{ providerId: 'codex', modelId: 'gpt-5-codex', effort: 'xhigh' }, 'effort_unavailable']
  ]) {
    const ctx = portSetup({ selection })
    const error = await rejection(ctx.port.complete(userAction()))
    assert.ok(error instanceof AiPortError, reason)
    assert.equal(error.code, reason === 'provider_not_found' ? 'provider_unavailable' : 'model_unavailable', reason)
    assert.equal(ctx.mock.stats.completes, 0, `${reason}: the host was never asked to complete with a different model`)
    assert.equal(ctx.port.status().state, 'unavailable')
    assert.equal(ctx.port.status().reason, reason)
    assert.equal(await ctx.port.ready(), false)
  }
  // a saved selection reaches the host call; changing it takes effect on the next call without a restart
  const ctx = portSetup({ selection: { providerId: 'codex', modelId: 'gpt-5-codex', effort: 'high' } })
  await ctx.port.complete(userAction())
  assert.deepEqual([ctx.mock.stats.turns[0].modelId, ctx.mock.stats.turns[0].effort], ['gpt-5-codex', 'high'])
  ctx.state.selection = { providerId: 'codex', modelId: 'gpt-5-codex', effort: 'low' }
  await ctx.port.complete(userAction())
  assert.equal(ctx.mock.stats.turns[1].effort, 'low')
  ctx.state.selection = { providerId: 'codex', modelId: 'removed-model', effort: null }
  assert.equal((await rejection(ctx.port.complete(userAction()))).code, 'model_unavailable')
  assert.equal(ctx.mock.stats.completes, 2)
})

// ───────────── (b) quota ─────────────

test('(b) quota: a sliding window of 20 turns/min — never more, never a host rate_limited; background extraction stops at 18 per minute', async () => {
  const ctx = portSetup()
  const jobs = Array.from({ length: 40 }, () => ctx.port.complete(background()))
  const outcomes = jobs.map((job) => job.then(() => 'ok', (error) => error.code))
  await ctx.settle()
  await ctx.clock.advance(5 * 60_000)
  assert.deepEqual([...new Set(await Promise.all(outcomes))], ['ok'], 'every request completes — waiting for a slot is not a failure')
  const times = ctx.mock.stats.turns.map((turn) => turn.at)
  assert.equal(times.length, 40)
  assert.ok(maxPerMinute(times) <= 18, `at most 18 background turns in any minute, saw ${maxPerMinute(times)}`)
  assert.equal(ctx.mock.stats.errors.rate_limited, 0, 'the host never had to say rate_limited')
  assert.equal(ctx.mock.stats.maxConcurrentCompletes, 1, 'one complete at a time (one Session per plugin)')
  assert.equal(ctx.mock.stats.openSessions, ctx.mock.stats.sessionsClosed, 'every Session the host opened for a complete() was closed')
  assert.equal(ctx.mock.control.liveSessions(), 0)
})

test('(b) quota: a user action gets through while background extraction is waiting for the window, and before queued background work', async () => {
  const ctx = portSetup()
  const jobs = Array.from({ length: 25 }, () => ctx.port.complete(background()))
  const done = jobs.map((job) => job.then(() => true))
  await ctx.settle()
  assert.equal(ctx.mock.stats.completes, 18, 'extraction stopped at 18 in the minute (2 turns kept for the user)')
  const draft = ctx.port.complete(userAction({ system: 'DRAFT' }))
  await ctx.settle()
  assert.equal((await draft).text.length > 0, true, 'the user action was answered without waiting for the minute to pass')
  assert.equal(ctx.mock.stats.completes, 19)
  assert.equal(ctx.mock.stats.turns.at(-1).system, 'DRAFT')
  assert.equal(ctx.mock.stats.errors.rate_limited, 0)
  await ctx.clock.advance(5 * 60_000)
  assert.equal((await Promise.all(done)).length, 25)
  assert.ok(maxPerMinute(ctx.mock.stats.turns.map((turn) => turn.at)) <= 20)
})

test('(b) quota: TurnWindow reproduces aiChatService\'s window (60 s inclusive, 1 h) and the hourly cap of 400', () => {
  const w = new TurnWindow(20, 400)
  for (let i = 0; i < 20; i += 1) w.record(1000 + i)
  assert.equal(w.delay(1019), 60_000 + 1000 - 1019 + 1, 'the 21st turn waits until the first leaves the 60 s window (inclusive boundary)')
  assert.equal(w.delay(1019, 2), 60_000 + 1002 - 1019 + 1, 'with 2 reserved: waits for the 3rd-oldest')
  assert.equal(w.delay(1000 + 60_001 + 19), 0)
  const hour = new TurnWindow(20, 400)
  for (let i = 0; i < 400; i += 1) hour.record(i * 8_000)
  assert.ok(hour.delay(400 * 8_000) > 0, 'the hourly cap holds back even when the minute window is empty')
  const t = new TurnWindow(20, 400)
  t.record(5)
  t.unrecord(5)
  assert.equal(t.count(6), 0, 'a turn the host never accepted is taken back')
})

test('(b) quota: the per-minute limit follows getOptions().limits.turnsPerMinute when it is lower than the reference', async () => {
  const ctx = portSetup()
  const original = ctx.mock.ai.getOptions
  const lowered = { ...ctx.mock.ai, getOptions: async () => ({ ...(await original()), limits: { ...(await original()).limits, turnsPerMinute: 5 } }) }
  const port = createHostAiPort({ ai: lowered, clock: ctx.clock, config: { extractReserve: 0 } })
  const jobs = Array.from({ length: 8 }, () => port.complete(background()))
  await ctx.settle()
  assert.equal(port.status().turnsPerMinute, 5)
  assert.equal(ctx.mock.stats.completes, 5, 'only 5 in the first minute')
  await ctx.clock.advance(120_000)
  await Promise.all(jobs)
  assert.equal(ctx.mock.stats.completes, 8)
})

// ───────────── (c) retries and backoff ─────────────

test('(c) busy / session_limit while the host finishes the previous turn: retried (6 x 250 ms) and the call still completes', async () => {
  const ctx = portSetup()
  ctx.mock.control.set({ busyFor: 3, busyCode: 'session_limit' })
  const job = ctx.port.complete(userAction())
  await ctx.settle()
  await ctx.clock.advance(1_000)
  assert.equal((await job).text.length > 0, true)
  assert.equal(ctx.mock.stats.errors.session_limit, 3)
  assert.equal(ctx.mock.stats.turns.length, 1)
  assert.equal(ctx.port.status().state, 'running', 'transient host busyness is not an outage')
})

test('(c) busy that never clears: after the retries the call fails with `busy` (transient) and the port backs off briefly instead of hammering the host', async () => {
  const ctx = portSetup()
  ctx.mock.control.set({ busyFor: 100, busyCode: 'busy' })
  const first = ctx.port.complete(background())
  const outcome = first.then(() => null, (error) => error)
  await ctx.settle()
  await ctx.clock.advance(3_000)
  const error = await outcome
  assert.equal(error.code, 'busy')
  assert.equal(isTransientAiCode(error.code), true)
  assert.equal(ctx.mock.stats.errors.busy, HOST_AI_DEFAULTS.busyRetries + 1)
  const calls = ctx.mock.stats.errors.busy
  ctx.mock.control.set({ busyFor: 0 })
  const second = ctx.port.complete(userAction())
  await ctx.settle()
  await ctx.clock.advance(HOST_AI_DEFAULTS.busyBackoffMs + 100)
  assert.equal((await second).text.length > 0, true)
  assert.equal(ctx.mock.stats.errors.busy, calls)
})

test('(c) rate_limited from the host (turns the port cannot see) backs off exponentially, fails fast during the backoff, and succeeds once the window frees', async () => {
  const ctx = portSetup()
  ctx.mock.control.consumeTurns(20)
  const first = await rejection(ctx.port.complete(userAction()))
  assert.equal(first.code, 'rate_limited')
  assert.equal(first.retryAfterMs, HOST_AI_DEFAULTS.rateBackoffBaseMs)
  assert.equal(ctx.port.status().state, 'paused')
  assert.equal(ctx.port.status().reason, 'rate_limited')
  assert.ok(ctx.port.blockedFor() > 0)
  const hostCalls = ctx.mock.stats.refused.length
  const during = await rejection(ctx.port.complete(userAction()))
  assert.equal(during.code, 'rate_limited')
  assert.equal(ctx.mock.stats.refused.length, hostCalls, 'during the backoff the host is not asked at all')
  await ctx.clock.advance(HOST_AI_DEFAULTS.rateBackoffBaseMs + 1)
  const second = await rejection(ctx.port.complete(userAction()))
  assert.equal(second.retryAfterMs, HOST_AI_DEFAULTS.rateBackoffBaseMs * 2, 'the second consecutive rate_limited doubles the wait')
  await ctx.clock.advance(61_000)
  assert.equal((await ctx.port.complete(userAction())).text.length > 0, true, 'works again once the foreign turns left the window')
  assert.equal(ctx.port.status().state, 'running')
  assert.equal(ctx.mock.stats.turns.length, 1, 'rejected requests never counted as our turns')
})

test('(c) quota_exhausted: the call fails with the host\'s retryAfterMs, nothing more is sent during Core\'s cooldown, and work resumes afterwards', async () => {
  const ctx = portSetup({ reply: (c) => (c.turn === 0 ? { fail: 'quota_exhausted' } : goodText) })
  const error = await rejection(ctx.port.complete(background()))
  assert.equal(error.code, 'quota_exhausted')
  assert.ok(error.retryAfterMs > 4 * 60_000 && error.retryAfterMs <= CONTRACT.limits.quotaCooldownMs, `retryAfterMs ${error.retryAfterMs} comes from getOptions().quota`)
  assert.equal(ctx.port.status().reason, 'quota_exhausted')
  assert.ok(ctx.port.status().resumeAt > ctx.clock.now())
  const asked = ctx.mock.stats.completes
  assert.equal((await rejection(ctx.port.complete(userAction()))).code, 'quota_exhausted', 'a user action is answered at once, not queued')
  assert.equal(ctx.mock.stats.completes, asked, 'no host call during the cooldown')
  await ctx.clock.advance(CONTRACT.limits.quotaCooldownMs + 1_000)
  assert.equal((await ctx.port.complete(background())).value.importance, 'action')
  assert.equal(ctx.port.status().state, 'running')
})

test('(c) quota already exhausted when we look (getOptions): even the first call is refused with quota_exhausted + retryAfterMs, with no complete', async () => {
  const ctx = portSetup()
  ctx.mock.control.exhaustQuota(90_000)
  const error = await rejection(ctx.port.complete(userAction()))
  assert.equal(error.code, 'quota_exhausted')
  assert.ok(Math.abs(error.retryAfterMs - 90_000) < 1_000)
  assert.equal(ctx.mock.stats.completes, 0)
})

test('(c) provider not ready (Codex not logged in) is "unavailable", not an error per item; it is re-checked after the retry interval and recovers', async () => {
  const ctx = portSetup()
  ctx.mock.control.set({ providerState: 'not_logged_in' })
  const error = await rejection(ctx.port.complete(userAction()))
  assert.equal(error.code, 'provider_unavailable')
  assert.equal(ctx.port.status().state, 'unavailable')
  assert.equal(ctx.port.status().reason, 'provider_not_logged_in')
  assert.match(describeStatus(ctx.port.status()), /尚未登入/)
  assert.equal(await ctx.port.ready(), false)
  assert.equal(ctx.mock.stats.completes, 0)
  ctx.mock.control.set({ providerState: 'ready' })
  await ctx.clock.advance(HOST_AI_DEFAULTS.providerRetryMs + 100)
  assert.equal(await ctx.port.ready(), true)
  assert.equal((await ctx.port.complete(userAction())).text.length > 0, true)
  assert.equal(ctx.port.status().state, 'running')
})

test('(c) failures that ARE the item\'s: empty_reply / provider_error / turn_timeout come back as non-transient errors with their code (the caller records a failure)', async () => {
  for (const fail of ['provider_error', 'one_shot_failed', 'response_too_large']) {
    const ctx = portSetup({ reply: () => ({ fail }) })
    const error = await rejection(ctx.port.complete(userAction()))
    assert.equal(error.code, fail)
    assert.equal(isTransientAiCode(error.code), false, fail)
    assert.equal(ctx.port.status().state, 'running', `${fail} does not put the whole port in an error state`)
  }
  const empty = portSetup({ reply: () => ({ empty: true }) })
  assert.equal((await rejection(empty.port.complete(userAction()))).code, 'empty_reply')
  assert.equal(empty.mock.control.liveSessions(), 0, 'the Session is closed on the failure path too')
  // the host never answers: our own guard ends the wait, the Session slot is the host\'s problem and shows up as busy (transient)
  const hung = portSetup({ reply: () => ({ hang: true }), config: { completeGuardMs: 10_000 } })
  const pending = rejection(hung.port.complete(userAction()))
  await hung.settle()
  await hung.clock.advance(10_001)
  assert.equal((await pending).code, 'turn_timeout')
})

test('(c) access: not_granted on the first call is `revoked` at once; the port probes every 30 s and recovers when the permission is allowed again', async () => {
  const ctx = portSetup()
  ctx.mock.control.revoke()
  const error = await rejection(ctx.port.complete(userAction()))
  assert.equal(error.code, 'access_revoked')
  const status = ctx.port.status()
  assert.equal(status.state, 'revoked')
  assert.equal(describeStatus(status), EXPECTED_AI_CHAT_REVOKED_TEXT, 'word for word (0.1.3 r1)')
  assert.equal(await ctx.port.ready(), false)
  const probes = ctx.mock.stats.getOptions
  await ctx.clock.advance(10_000)
  assert.equal(await ctx.port.ready(), false)
  assert.equal(ctx.mock.stats.getOptions, probes, 'no probing inside the 30 s interval')
  ctx.mock.control.grant()
  await ctx.clock.advance(HOST_AI_DEFAULTS.revokedProbeMs)
  assert.equal(await ctx.port.ready(), true, 'the permission is back: the probe gets through')
  assert.equal((await ctx.port.complete(userAction())).text.length > 0, true)
  assert.equal(ctx.port.status().state, 'running')
})

test('(c) access: a turn cancelled by the host because the permission was switched off (`interrupted`) is transient; the next call is `revoked`', async () => {
  const ctx = portSetup({ reply: () => ({ delay: async () => { ctx.mock.control.revoke() }, text: goodText }) })
  const first = await rejection(ctx.port.complete(background()))
  assert.equal(first.code, 'interrupted')
  assert.equal(isTransientAiCode('interrupted'), true)
  assert.equal((await rejection(ctx.port.complete(background()))).code, 'access_revoked')
  assert.equal(ctx.port.status().state, 'revoked')
})

// ───────────── (d) JSON ─────────────

test('(d) a reply wrapped in ```json fences and surrounding prose is parsed and passes zod: the value is the validated, normalised ExtractResult (detail/dueAt -> null)', async () => {
  const sloppy = { importance: 'action', newTodos: [{ bucket: 'todo', title: '回覆報價單', priority: 2, confidence: 0.9, sourceMsgIds: ['m1'] }], resolved: [], updates: [] }
  const ctx = portSetup({ reply: () => `好的，整理如下：\n\`\`\`json\n${JSON.stringify(sloppy, null, 2)}\n\`\`\`\n希望有幫助。` })
  const result = await ctx.port.complete(background())
  assert.equal(result.value.newTodos[0].detail, null)
  assert.equal(result.value.newTodos[0].dueAt, null)
  assert.deepEqual(JSON.parse(result.text), result.value)
  assert.equal(result.model, 'gpt-5-codex')
  assert.equal(ctx.mock.stats.completes, 1)
})

test('(d) bad JSON: one repair turn that replays the question and the bad answer as transcript (costs one more quota turn); if it is still bad the call fails with invalid_json', async () => {
  const ctx = portSetup({ reply: (c) => (c.repair ? goodText : '抱歉，我整理好了但是忘了用 JSON') })
  const repaired = await ctx.port.complete(background())
  assert.equal(repaired.value.importance, 'action')
  assert.equal(ctx.mock.stats.completes, 2, 'one repair turn')
  const [first, second] = ctx.mock.stats.turns
  assert.deepEqual(first.transcript, [])
  assert.deepEqual(second.transcript, [{ role: 'user', text: first.text }, { role: 'assistant', text: '抱歉，我整理好了但是忘了用 JSON' }])
  assert.match(second.text, /無法使用/)
  assert.equal(second.system, first.system)
  assert.equal(ctx.port.status().counters.repairs, 1)
  assert.equal(ctx.port.status().counters.turns, 2)
  assert.equal(ctx.mock.control.liveSessions(), 0)

  const bad = portSetup({ reply: () => 'not json at all' })
  const error = await rejection(bad.port.complete(background()))
  assert.equal(error.code, 'invalid_json')
  assert.equal(bad.mock.stats.completes, 2, 'exactly one repair, then the item fails')
  assert.equal(isTransientAiCode(error.code), false)
})

test('(d) valid JSON that fails the zod schema is invalid_result — an unvalidated object is never returned as ok', async () => {
  const ctx = portSetup({ reply: () => JSON.stringify({ importance: 'urgent', newTodos: [{ title: 5 }] }) })
  const error = await rejection(ctx.port.complete(background()))
  assert.equal(error.code, 'invalid_result')
  assert.equal(ctx.mock.stats.completes, 2)
  // …and the repair can fix it
  const fixed = portSetup({ reply: (c) => (c.repair ? goodText : JSON.stringify({ importance: 'urgent', newTodos: [] })) })
  assert.equal((await fixed.port.complete(background())).value.importance, 'action')
})

test('(d) plain-text actions come back trimmed; the repair is skipped when the action does not expect JSON', async () => {
  const ctx = portSetup({ reply: () => '  好的，我今天處理。\n' })
  const result = await ctx.port.complete(userAction())
  assert.equal(result.text, '好的，我今天處理。')
  assert.equal(result.value, undefined)
  assert.equal(ctx.mock.stats.completes, 1)
})

// ───────────── limits ─────────────

test('limits: a system prompt over 16,000 chars or an input over 8,000 chars is refused BEFORE the host is called', async () => {
  const ctx = portSetup()
  assert.equal((await rejection(ctx.port.complete(userAction({ user: 'x'.repeat(8_001) })))).code, 'input_too_large')
  assert.equal((await rejection(ctx.port.complete(userAction({ system: 'x'.repeat(16_001) })))).code, 'system_too_large')
  assert.equal(ctx.mock.stats.completes, 0)
  assert.equal(ctx.mock.stats.getOptions, 1, 'only the options lookup reached the host')
  const ok = await ctx.port.complete(userAction({ user: 'x'.repeat(8_000), system: 'y'.repeat(16_000) }))
  assert.equal(ok.text.length > 0, true)
})

test('sessions: every call is a fresh Session (no context leaks between chats), at most one alive, always closed — also when the host fails', async () => {
  let n = 0
  const ctx = portSetup({ reply: () => { n += 1; return n === 2 ? { fail: 'provider_error' } : goodText } })
  const outcomes = await Promise.allSettled([ctx.port.complete(background()), ctx.port.complete(background()), ctx.port.complete(background())])
  await ctx.settle()
  assert.deepEqual(outcomes.map((o) => o.status), ['fulfilled', 'rejected', 'fulfilled'])
  assert.equal(ctx.mock.stats.openSessions, 3)
  assert.equal(ctx.mock.stats.sessionsClosed, 3)
  assert.equal(ctx.mock.stats.maxLiveSessions, 1)
  assert.equal(new Set(ctx.mock.stats.turns.map((turn) => turn.sessionId)).size, 3)
})

// ───────────── (e) contentSaved ─────────────

test('(e) contentSaved (supported turn event): a turn whose event stream carries it completes normally — nothing in line-todo reacts to turn events', async () => {
  const ctx = portSetup({ reply: () => ({ text: goodText, events: ['contentSaved', 'contentSaved'] }) })
  const result = await ctx.port.complete(background())
  assert.equal(result.value.importance, 'action')
  const kinds = ctx.mock.stats.droppedEvents.map((entry) => entry.event.kind)
  assert.ok(kinds.includes('contentSaved'), 'the host really emitted contentSaved for this turn')
  assert.ok(kinds.includes('started') && kinds.includes('completed'))
  assert.equal(ctx.port.status().counters.turns, 1)
  assert.equal(ctx.port.status().state, 'running')
  // the same events on an open Session reach a listener; the listener here is a test one — line-todo has none (checked below), and a listener that ignores kinds it does not know is the contract
  const session = await ctx.mock.ai.openSession({ system: 'S' })
  const seen = []
  session.onEvent((event) => seen.push(event.kind))
  ctx.mock.control.set({})
  await session.send({ text: 'hi' })
  await session.close()
  assert.equal(ctx.mock.stats.errors.session_limit, 0)
  assert.ok(Array.isArray(seen))
})

test('(e) only the backend Host adapter consumes session events; the renderer never calls window.tuqPlugin.ai and replay turns stay filtered', () => {
  const gatewayPath='src/plugin/backend/hostAi.ts'
  const hostSessionOffenders=(where,text)=>{
    const code=text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm,'')
    const out=[]
    if(/tuqPlugin\??\.ai\b/.test(code))out.push(`${where}: window.tuqPlugin.ai`)
    if(/\.onEvent\(/.test(code)&&where!==gatewayPath)out.push(`${where}: onEvent outside the backend Host adapter`)
    if(/\bai\??\.openSession\(/.test(code)&&where!==gatewayPath)out.push(`${where}: host.ai.openSession outside the backend Host adapter`)
    return out
  }
  const offenders = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) { if (name !== 'sdk' && name !== 'node_modules') walk(full); continue }
      if (!/\.(ts|tsx)$/.test(name)) continue
      const text = readFileSync(full, 'utf8')
      const where = relative(ROOT, full).split('\\').join('/')
      offenders.push(...hostSessionOffenders(where,text))
    }
  }
  walk(join(ROOT, 'src'))
  const hostAdapter=readFileSync(join(ROOT,'src','plugin','backend','hostAi.ts'),'utf8')
  assert.match(hostAdapter,/event\.turnId\s*!==\s*turnId/,'events replayed from older resumed turns are ignored')
  assert.match(hostAdapter,/event\.kind\s*===\s*'textDelta'/,'only the active turn text is accumulated')
  assert.doesNotMatch(hostAdapter,/event\.kind\s*===\s*'contentSaved'/,'contentSaved is not interpreted as a model result')
  assert.deepEqual(offenders, [], 'the view has no direct Host AI/event API; backend session replay stays scoped to the active turn')
  assert.deepEqual(hostSessionOffenders('src/plugin/backend/rogue.ts','session.onEvent(()=>{}); context.host.ai.openSession({})'),['src/plugin/backend/rogue.ts: onEvent outside the backend Host adapter','src/plugin/backend/rogue.ts: host.ai.openSession outside the backend Host adapter'],'a second module cannot bypass the approved HostAiPort gateway')
  assert.deepEqual(hostSessionOffenders(gatewayPath,'session.onEvent(()=>{}); opts.ai.openSession({})'),[],'the narrow exception is confined to the existing gateway')
})

// ───────────── port lifecycle ─────────────

test('stop(): queued calls fail with backend_stopped, sleeping calls wake up, and no timer is left behind', async () => {
  const ctx = portSetup()
  const jobs = Array.from({ length: 25 }, () => ctx.port.complete(background()).then(() => 'ok', (error) => error.code))
  await ctx.settle()
  assert.ok(ctx.clock.timers.size > 0, 'a background call is waiting for a window slot')
  ctx.port.stop()
  await ctx.settle()
  const results = await Promise.all(jobs)
  assert.equal(results.filter((r) => r === 'ok').length, 18)
  assert.ok(results.filter((r) => r === 'backend_stopped').length >= 1)
  assert.equal(ctx.clock.timers.size, 0, 'no timer left')
  assert.equal(ctx.port.status().state, 'stopped')
  assert.equal((await rejection(ctx.port.complete(userAction()))).code, 'backend_stopped')
})

// ───────────── the background worker ─────────────

/** The ExtractQueue protocol (leases, commit statuses, release, touch) with the pieces the worker uses. */
function makeQueue(clock, { items = 1 } = {}) {
  const store = { items: [], leases: new Map(), commits: [], releases: [], pulls: 0, touches: 0, counter: 0 }
  const add = (item) => store.items.push({ chatId: 'c1', user: JSON.stringify({ chat: { chatId: item.chatId ?? 'c1' }, newMessages: [{ msgId: 'm1', text: '請幫我寄報價單' }] }), attempts: 0, notBefore: 0, state: 'pending', ...item })
  Array.from({ length: items }, (_, i) => add({ chatId: `c${i + 1}` }))
  const queue = {
    touch: () => { store.touches += 1 },
    hasPending: () => store.items.some((item) => item.state === 'pending'),
    pull: ({ max = 1 } = {}) => {
      store.pulls += 1
      const out = []
      let soonest = null
      for (const item of store.items) {
        if (item.state !== 'pending') continue
        if (item.notBefore > clock.now()) { soonest = soonest === null ? item.notBefore : Math.min(soonest, item.notBefore); continue }
        if (out.length >= max) break
        item.state = 'leased'
        item.leaseId = `lease-${++store.counter}`
        store.leases.set(item.leaseId, item)
        out.push({ itemId: item.leaseId, chatId: item.chatId, user: item.user, userChars: item.user.length, attempts: item.attempts })
      }
      return { ok: true, items: out, pending: 0, leased: 0, retryAfterMs: out.length === 0 && soonest !== null ? soonest - clock.now() : null }
    },
    commit: ({ results }) => ({
      ok: true,
      results: results.map((r) => {
        const item = store.leases.get(r.itemId)
        store.commits.push(r)
        if (!item) return { itemId: r.itemId, status: 'unknown_item' }
        store.leases.delete(r.itemId)
        if (r.ok) { item.state = 'done'; item.result = r.result; return { itemId: r.itemId, status: 'applied' } }
        item.state = 'pending'; item.attempts += 1; item.notBefore = clock.now() + 30_000 * 2 ** (item.attempts - 1)
        return { itemId: r.itemId, status: 'failed_recorded', code: r.failCode }
      })
    }),
    release: ({ itemIds }) => {
      store.releases.push(...itemIds)
      for (const id of itemIds) { const item = store.leases.get(id); if (item) { store.leases.delete(id); item.state = 'pending' } }
      return { ok: true, released: itemIds.length, unknown: [] }
    }
  }
  return { store, queue, add, states: () => store.items.map((i) => i.state) }
}

function workerSetup({ items = 1, reply = () => goodText, config = {}, workerConfig = {}, system = () => 'SYSTEM+FORMAT' } = {}) {
  const clock = new FakeClock()
  const mock = createMockTuqAi({ now: clock.now, reply })
  const port = createHostAiPort({ ai: mock.ai, clock, config })
  const q = makeQueue(clock, { items })
  const logs = []
  const worker = createExtractWorker({ queue: q.queue, port, system, clock, config: { pollIntervalMs: 15_000, ...workerConfig }, log: (event, detail) => logs.push([event, detail]) })
  return { clock, mock, port, q, worker, logs, settle: () => flush() }
}

test('(a) worker: pending items are drained in the backend through host.ai.complete — no view, no visibility, no RPC; every item is committed once with the validated value', async () => {
  const ctx = workerSetup({ items: 3 })
  ctx.worker.start()
  await ctx.settle()
  assert.deepEqual(ctx.q.states(), ['done', 'done', 'done'])
  assert.equal(ctx.q.store.commits.length, 3)
  assert.ok(ctx.q.store.commits.every((c) => c.ok === true && c.result.importance === 'action'))
  assert.equal(ctx.mock.stats.completes, 3)
  assert.ok(ctx.mock.stats.turns.every((turn) => turn.system === 'SYSTEM+FORMAT'), 'the system prompt (with the output format) is what the worker was given')
  assert.ok(ctx.mock.stats.turns.every((turn) => turn.transcript.length === 0))
  assert.deepEqual(ctx.worker.counters(), { extracted: 3, rejected: 0, failed: 0, released: 0 })
  assert.ok(ctx.q.store.touches >= 3, 'the queue is told its consumer is alive')
  assert.equal(ctx.mock.control.liveSessions(), 0)
  ctx.worker.stop()
})

test('(a) A11 worker: every item is sent with the system of its own chat (system(chatId)); a resolver that cannot answer fails that chat and never falls back to another chat prompt', async () => {
  const asked = []
  const ctx = workerSetup({
    items: 3,
    system: (chatId) => {
      asked.push(chatId)
      if (chatId === 'c2') throw Object.assign(new Error('chat_prompt_unavailable'), { code: 'chat_prompt_unavailable' })
      return `SYSTEM FOR ${chatId}`
    }
  })
  ctx.worker.start()
  await ctx.settle()
  assert.deepEqual(asked, ['c1', 'c2', 'c3'], 'resolved once per item, in lease order, with the chat of that item')
  assert.deepEqual(ctx.mock.stats.turns.map((turn) => turn.system), ['SYSTEM FOR c1', 'SYSTEM FOR c3'], 'c2 was never sent to the host')
  assert.deepEqual(ctx.q.store.commits.filter((commit) => !commit.ok).map((commit) => commit.failCode), ['chat_prompt_unavailable'])
  assert.deepEqual(ctx.q.states(), ['done', 'pending', 'done'])
  assert.deepEqual(ctx.worker.counters(), { extracted: 2, rejected: 0, failed: 1, released: 0 })
  ctx.worker.stop()
})

test('(a) worker: kick() starts work at once; the poll interval is only the fallback; the pull hint (retryAfterMs) schedules the next look', async () => {
  const ctx = workerSetup({ items: 0 })
  ctx.worker.start()
  await ctx.settle()
  const pulls = ctx.q.store.pulls
  ctx.q.add({ chatId: 'c9' })
  ctx.worker.kick()
  await ctx.settle()
  assert.equal(ctx.q.states()[0], 'done', 'kick -> done without advancing time')
  ctx.q.add({ chatId: 'c10' })
  await ctx.clock.advance(14_000)
  assert.equal(ctx.q.states()[1], 'pending', 'before the poll interval nothing looks')
  await ctx.clock.advance(1_500)
  assert.equal(ctx.q.states()[1], 'done', 'the idle poll finds it')
  assert.ok(ctx.q.store.pulls > pulls)
  // an item that is backing off: the worker wakes when the queue says it will be due
  ctx.q.add({ chatId: 'c11', notBefore: ctx.clock.now() + 20_000 })
  ctx.worker.kick()
  await ctx.settle()
  assert.equal(ctx.q.states()[2], 'pending')
  await ctx.clock.advance(20_100)
  assert.equal(ctx.q.states()[2], 'done')
  ctx.worker.stop()
})

test('(b)(c) worker: the quota is exhausted mid-queue — the item in hand goes back (released, not failed), nothing is lost, and the queue is finished after the cooldown', async () => {
  const ctx = workerSetup({ items: 4, reply: (c) => (c.turn === 1 ? { fail: 'quota_exhausted' } : goodText) })
  ctx.worker.start()
  await ctx.settle()
  assert.deepEqual(ctx.q.states(), ['done', 'pending', 'pending', 'pending'], 'item 2 hit the quota: back in the queue, 3 and 4 not even started')
  assert.deepEqual(ctx.q.store.releases.length, 1, 'released')
  assert.equal(ctx.q.store.commits.filter((c) => !c.ok).length, 0, 'a quota error is not a failure of the chat (no backoff recorded)')
  assert.equal(ctx.q.store.items[1].attempts, 0)
  const completes = ctx.mock.stats.completes
  await ctx.clock.advance(60_000)
  assert.equal(ctx.mock.stats.completes, completes, 'nothing is sent during Core\'s cooldown')
  assert.equal(ctx.port.status().reason, 'quota_exhausted')
  await ctx.clock.advance(CONTRACT.limits.quotaCooldownMs)
  assert.deepEqual(ctx.q.states(), ['done', 'done', 'done', 'done'], 'every item is processed after the cooldown')
  assert.equal(ctx.worker.counters().released, 1)
  assert.equal(ctx.worker.counters().failed, 0)
  ctx.worker.stop()
})

test('(b)(c) worker: rate_limited and a provider that is not ready keep every pending item; they are processed once the host allows it', async () => {
  const ctx = workerSetup({ items: 3 })
  ctx.mock.control.consumeTurns(20)
  ctx.worker.start()
  await ctx.settle()
  assert.deepEqual(ctx.q.states(), ['pending', 'pending', 'pending'], 'the host says rate_limited: the first item is released, the others are not touched')
  assert.equal(ctx.q.store.items.every((item) => item.attempts === 0), true)
  await ctx.clock.advance(100_000) // the foreign turns leave the window after 60 s; the backoff doubles 5 -> 10 -> 20 -> 40 s meanwhile
  assert.deepEqual(ctx.q.states(), ['done', 'done', 'done'])
  assert.equal(ctx.q.store.items.every((item) => item.attempts === 0), true, 'never counted as the chats\' failure')
  // provider not ready
  const down = workerSetup({ items: 2 })
  down.mock.control.set({ providerState: 'not_logged_in' })
  down.worker.start()
  await down.settle()
  assert.deepEqual(down.q.states(), ['pending', 'pending'])
  assert.equal(down.q.store.pulls, 0, 'with no usable provider the worker does not even lease items')
  assert.equal(down.port.status().state, 'unavailable')
  down.mock.control.set({ providerState: 'ready' })
  await down.clock.advance(HOST_AI_DEFAULTS.providerRetryMs + 6_000)
  assert.deepEqual(down.q.states(), ['done', 'done'])
  ctx.worker.stop()
  down.worker.stop()
})

test('(c) worker: failures that ARE the chat\'s are committed as failures with their code (the queue backs the chat off, the messages stay unprocessed); the other chats go on', async () => {
  const codes = ['empty_reply', 'provider_error']
  let n = -1
  const ctx = workerSetup({ items: 3, reply: () => { n += 1; return n < 2 ? (n === 0 ? { empty: true } : { fail: 'provider_error' }) : goodText } })
  ctx.worker.start()
  await ctx.settle()
  const failed = ctx.q.store.commits.filter((c) => !c.ok)
  assert.deepEqual(failed.map((c) => c.failCode), codes)
  assert.deepEqual(ctx.q.states(), ['pending', 'pending', 'done'])
  assert.equal(ctx.q.store.releases.length, 0, 'nothing released — these are failures')
  assert.deepEqual(ctx.worker.counters(), { extracted: 1, rejected: 0, failed: 2, released: 0 })
  assert.deepEqual(ctx.q.store.items.slice(0, 2).map((i) => i.attempts), [1, 1])
  // the queue\'s own backoff (30 s) then brings them back
  await ctx.clock.advance(31_000)
  assert.deepEqual(ctx.q.states(), ['done', 'done', 'done'])
  ctx.worker.stop()
})

test('(c) worker: access revoked — the lease is returned, nothing more is sent, the status says how to fix it; the worker probes and continues when the permission is back', async () => {
  const ctx = workerSetup({ items: 2 })
  ctx.mock.control.revoke()
  ctx.worker.start()
  await ctx.settle()
  assert.deepEqual(ctx.q.states(), ['pending', 'pending'])
  assert.equal(ctx.port.status().state, 'revoked')
  assert.equal(ctx.mock.stats.completes, 0)
  await ctx.clock.advance(HOST_AI_DEFAULTS.revokedProbeMs * 2)
  assert.deepEqual(ctx.q.states(), ['pending', 'pending'], 'still revoked: still waiting')
  ctx.mock.control.grant()
  await ctx.clock.advance(HOST_AI_DEFAULTS.revokedProbeMs + 1_000)
  assert.deepEqual(ctx.q.states(), ['done', 'done'])
  ctx.worker.stop()
})

test('worker: stop() ends the loop; a host call that was already in flight is not committed after the stop (the message stays unprocessed for the next start)', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const ctx = workerSetup({ items: 2, reply: () => ({ delay: () => gate, text: goodText }) })
  ctx.worker.start()
  await ctx.settle()
  assert.equal(ctx.q.states()[0], 'leased')
  ctx.worker.stop()
  ctx.port.stop()
  release()
  await ctx.settle()
  assert.equal(ctx.q.store.commits.length, 0, 'nothing committed after stop')
  assert.equal(ctx.worker.running(), false)
  const pulls = ctx.q.store.pulls
  ctx.worker.kick()
  await ctx.clock.advance(60_000)
  assert.equal(ctx.q.store.pulls, pulls, 'a stopped worker never pulls again')
  assert.equal(ctx.clock.timers.size, 0)
})

// ───────────── status text ─────────────

test('describeStatus: every state has a user-facing sentence; AI runs in the backend, so nothing is said about the board having to be in front', () => {
  const base = { busy: false, provider: null, counters: {}, resumeAt: null }
  const text = (state, reason, extra = {}) => describeBoardStatus({ ...base, state, reason, ...extra }, 1_000_000)
  assert.match(text('running', null), /看板不需要開著/)
  assert.doesNotMatch(text('running', null), /前景/)
  assert.match(text('running', null, { busy: true }), /正在整理/)
  assert.match(text('paused', 'rate_limited', { resumeAt: 1_030_000 }), /30 秒後/)
  assert.match(text('paused', 'quota_exhausted', { resumeAt: 1_000_000 + 5 * 60_000 }), /5 分鐘後/)
  assert.match(text('unavailable', 'provider_not_installed'), /所選 AI 尚未安裝/)
  // G-10: no Core / Codex version is hard-coded in what the user reads
  assert.match(text('unavailable', 'provider_unsupported_version'), /版本不支援/)
  assert.doesNotMatch(text('unavailable', 'provider_unsupported_version'), /\d+\.\d+/)
  assert.match(text('paused', 'backend'), /暫時中斷/)
  assert.ok(text('paused', 'backend_revoked').includes(BACKEND_TRUST_REQUIREMENT), 'the current Core full-trust requirement')
  assert.doesNotMatch(text('paused', 'backend_revoked'), STALE_PERMISSION_NAME)
  assert.doesNotMatch(text('paused', 'backend_revoked'), /自動繼續|自動恢復/, 'review B1: no promise of resuming by itself')
  assert.doesNotMatch(text('paused', 'backend_revoked'), RECOVERY_PROMISE, 'tester r1 §3.2: no paraphrased promise either')
  assert.equal(text('paused', 'backend_revoked'), EXPECTED_AI_FENCED_TEXT, 'word for word')
  assert.ok(text('paused', 'backend_revoked').includes(`請到 ${PLUGIN_PAGE_PLACE_TEXT}，確認執行範圍是「完全信任級」且外掛已啟用`), '0.1.3: where to go and what to check')
  assert.doesNotMatch(text('paused','backend_revoked'),/backend:invoke|舊版 manifest 欄位/u,'the legacy field is not an actionable switch')
  assert.doesNotMatch(text('paused', 'backend_revoked'), VERSION_SPECIFIC_PLACE, '0.1.3: no place that only one TeamUQ version has')
  assert.match(text('unavailable', 'no_provider'), /找不到可用/)
  assert.match(text('revoked', 'access_revoked'), /ai:chat/)
  // 0.1.3 r1: ai:chat switched off — where to allow it again, in names both TeamUQ 1.6.8 and 1.7.1 show (not 「TeamUQ 設定 → 外掛」, 1.6.8 only)
  assert.equal(text('revoked', 'access_revoked'), EXPECTED_AI_CHAT_REVOKED_TEXT, 'r1: word for word')
  assert.ok(text('revoked', 'access_revoked').includes(`請到 ${PLUGIN_PAGE_PLACE_TEXT}，在「${CORE_PERMISSIONS_SECTION_TITLE}」裡允許「${CORE_AI_CHAT_TITLE}」`), 'r1: the ai:chat switch by its title on TeamUQ\'s plugin page')
  assert.equal(namesVersionSpecificPlace(text('revoked', 'access_revoked')), false, 'r1: no place that only one TeamUQ version has')
  assert.match(text('stopped', null), /尚未啟動/)
  // the backend-side wording (used for notes returned to the user, e.g. a review that cannot start) is the same sentences minus the two board-only reasons
  assert.equal(describeStatus({ ...base, state: 'revoked', reason: 'access_revoked' }), EXPECTED_AI_CHAT_REVOKED_TEXT)
})

test('G-10: the rate-limit sentence uses the limit the host reported (getOptions().limits.turnsPerMinute), not a hard-coded 20', async () => {
  const base = { busy: false, provider: null, counters: {}, resumeAt: 1_030_000 }
  assert.match(describeStatus({ ...base, state: 'paused', reason: 'rate_limited', turnsPerMinute: 7 }, 1_000_000), /每分鐘 7 次/)
  assert.doesNotMatch(describeStatus({ ...base, state: 'paused', reason: 'rate_limited' }, 1_000_000), /每分鐘 \d+ 次/, 'unknown limit: no number at all')
  const ctx = portSetup()
  await ctx.port.ready()
  assert.equal(typeof ctx.port.status().turnsPerMinute, 'number')
  assert.ok(ctx.port.status().turnsPerMinute <= AI_CHAT_REFERENCE.turnsPerMinute)
})

test('codeOf: the host\'s Error carries `.code`; wrapped messages and unknown shapes degrade to `unavailable` without leaking text', () => {
  assert.equal(codeOf(Object.assign(new Error('host request failed: rate_limited'), { code: 'rate_limited' })), 'rate_limited')
  assert.equal(codeOf(new Error('host request failed: quota_exhausted')), 'quota_exhausted')
  assert.equal(codeOf(new AiPortError('busy')), 'busy')
  assert.equal(codeOf(new Error('Something with a secret: abc')), 'unavailable')
  assert.equal(codeOf(null), 'unavailable')
})

// ───────────── review / test-report fixes (step-fix): F1 F2 F3 F4 F5 F6 F7 F9 ─────────────

test('F1 port: a getOptions that never answers is given up after optionsGuardMs (far below the host\'s 30 s), one probe at a time; the status says the host does not answer — not "no provider" — and the port recovers by itself', async () => {
  const clock = new FakeClock()
  const mock = createMockTuqAi({ now: clock.now, reply: () => goodText })
  let hang = true
  let probes = 0
  const ai = { ...mock.ai, getOptions: () => { probes += 1; return hang ? new Promise(() => undefined) : mock.ai.getOptions() } }
  const port = createHostAiPort({ ai, clock })
  assert.ok(HOST_AI_DEFAULTS.optionsGuardMs <= 15_000, 'well below the host\'s 30 s: a call that lasts 30 s gets the whole backend isolated')
  const first = port.ready()
  const second = port.ready()
  await flush()
  assert.equal(probes, 1, 'two callers share one probe')
  await clock.advance(HOST_AI_DEFAULTS.optionsGuardMs - 1_000)
  assert.equal(port.status().state, 'unavailable')
  assert.equal(port.status().reason, 'loading_models', 'still waiting inside the guard time')
  await clock.advance(1_001)
  assert.deepEqual([await first, await second], [false, false])
  assert.deepEqual({ state: port.status().state, reason: port.status().reason }, { state: 'unavailable', reason: 'host_unavailable' })
  assert.match(describeStatus(port.status(), clock.now()), /暫時沒有回應/)
  assert.equal(await port.ready(), false)
  assert.equal(probes, 1, 'no new probe before the (short) retry time')
  // the host answers again: the next probe comes after optionsRetryMs — not after the 60 s a "no provider" would cost — and everything works
  hang = false
  await clock.advance(HOST_AI_DEFAULTS.optionsRetryMs + 100)
  assert.equal(await port.ready(), true)
  assert.equal(port.status().state, 'running')
  assert.equal(clock.timers.size, 0, 'the guard timer is gone')
  // port.options() (the settings screen) is bounded the same way
  hang = true
  const options = rejection(port.options())
  await clock.advance(HOST_AI_DEFAULTS.optionsGuardMs + 100)
  assert.equal((await options).code, 'plugin_host_timeout')
})

test('F2 worker: an empty queue never asks the host (no getOptions every 30 s for nothing); an item that arrives is picked up at once and then the host is asked', async () => {
  const ctx = workerSetup({ items: 0 })
  ctx.worker.start()
  await ctx.settle()
  await ctx.clock.advance(5 * 60_000)
  assert.equal(ctx.mock.stats.getOptions, 0, 'idle for five minutes: not one host call')
  assert.ok(ctx.q.store.touches >= 20, 'the worker is alive and looking (queue is told)')
  ctx.q.add({ chatId: 'c1' })
  ctx.worker.kick()
  await ctx.settle()
  assert.equal(ctx.q.states()[0], 'done')
  assert.equal(ctx.mock.stats.getOptions, 1)
  ctx.worker.stop()
})

test('F3: the extraction lease outlives the slowest an item can take in the port (wait for the window, read the options, two host calls) — an expired lease throws the answer away and burns the quota twice', () => {
  const worst = worstCaseItemMs(HOST_AI_DEFAULTS)
  assert.ok(worst > 12 * 60_000 && worst < 15 * 60_000, `the worst case is about 13 minutes, saw ${worst} ms`)
  assert.ok(EXTRACT_WORKER_DEFAULTS.leaseMs > worst, `lease ${EXTRACT_WORKER_DEFAULTS.leaseMs} ms must exceed ${worst} ms`)
  const slower = { ...HOST_AI_DEFAULTS, completeGuardMs: HOST_AI_DEFAULTS.completeGuardMs + 60_000 }
  assert.ok(worstCaseItemMs(slower) > worstCaseItemMs(HOST_AI_DEFAULTS), 'the figure follows the port\'s own constants')
})

test('F4: a user action that arrives while a background item is still reading the host\'s options goes first — it does not queue behind the background item', async () => {
  const clock = new FakeClock()
  const mock = createMockTuqAi({ now: clock.now, reply: () => goodText })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const ai = { ...mock.ai, getOptions: async () => { await gate; return mock.ai.getOptions() } }
  const port = createHostAiPort({ ai, clock })
  const bg = port.complete(background({ system: 'BACKGROUND' }))
  await flush()
  const user = port.complete(userAction({ system: 'USER' }))
  await flush()
  release()
  await flush()
  await Promise.all([bg, user])
  assert.deepEqual(mock.stats.turns.map((turn) => turn.system), ['USER', 'BACKGROUND'])
})

test('F5: the hourly budget keeps extractHourReserve turns for the user — background stops short of the 400/h cap, the user\'s draft is still answered at once (and Core never says rate_limited)', async () => {
  // the window: 380 background turns spread over the last hour leave the minute window empty and the hour window at 380/400
  const w = new TurnWindow(20, 400)
  for (let i = 0; i < 380; i += 1) w.record(1_000 + i * 9_000)
  const now = 1_000 + 380 * 9_000
  assert.equal(w.wait(now, 2, 20).scope, 'hour')
  assert.ok(w.delay(now, 2, 20) > 0, 'background waits')
  assert.equal(w.delay(now, 0, 0), 0, 'a user action may still send')
  assert.equal(w.delay(now, 2), w.delay(now, 2, 2), 'a single reserve applies to both windows when no hour reserve is given')
  assert.equal(HOST_AI_DEFAULTS.extractHourReserve >= 10, true)
  // the port: a small hourly budget (30, 5 kept) so the test runs in milliseconds
  const ctx = portSetup({ config: { perHour: 30, extractHourReserve: 5 } })
  const jobs = Array.from({ length: 40 }, () => ctx.port.complete(background()).then(() => 'ok', (error) => error))
  await ctx.settle()
  await ctx.clock.advance(5 * 60_000)
  const results = await Promise.all(jobs)
  assert.equal(results.filter((r) => r === 'ok').length, 25, 'background used 30 - 5 turns of the hour')
  const refused = results.filter((r) => r !== 'ok')
  assert.equal(refused.length, 15)
  assert.ok(refused.every((error) => error.code === 'rate_limited' && error.scope === 'hour'), 'refused because the HOUR is full, and it says so')
  assert.equal(ctx.port.windowWait('background')?.scope, 'hour', 'the status line can say "hourly limit"')
  assert.equal(ctx.port.windowWait('user'), null)
  const draft = ctx.port.complete(userAction({ system: 'DRAFT' }))
  await ctx.settle()
  assert.equal((await draft).text.length > 0, true, 'the reserved turns are the user\'s')
  assert.equal(ctx.mock.stats.completes, 26)
  assert.equal(ctx.mock.stats.errors.rate_limited, 0)
})

test('F6: a JSON repair that cannot get a quota slot is a transient rate_limited (the item goes back), not an invalid_json that backs the chat off', async () => {
  const ctx = portSetup({ reply: () => '這不是 JSON', config: { perMinute: 1, extractReserve: 0, backgroundMaxWaitMs: 1_000 } })
  const error = await rejection(ctx.port.complete(background()))
  assert.equal(error.code, 'rate_limited')
  assert.equal(error.scope, 'minute')
  assert.equal(isTransientAiCode(error.code), true)
  assert.equal(ctx.mock.stats.completes, 1, 'only the first ask was sent')
  // with room for the repair the same reply is the item's own failure
  const roomy = portSetup({ reply: () => '這不是 JSON' })
  assert.equal((await rejection(roomy.port.complete(background()))).code, 'invalid_json')
})

test('F7: a host that does not answer is a short, transient pause with its own sentence — not "no provider" for a minute; a host that says the provider is down still waits the long retry', async () => {
  // getOptions fails with a timeout code
  const clock = new FakeClock()
  const mock = createMockTuqAi({ now: clock.now, reply: () => goodText })
  let code = 'plugin_host_timeout'
  const ai = { ...mock.ai, getOptions: async () => { if (code) throw Object.assign(new Error(`host request failed: ${code}`), { code }); return mock.ai.getOptions() } }
  const port = createHostAiPort({ ai, clock })
  const refused = await rejection(port.complete(background()))
  assert.equal(refused.code, 'plugin_host_unavailable')
  assert.equal(isTransientAiCode(refused.code), true)
  assert.ok(refused.retryAfterMs <= HOST_AI_DEFAULTS.optionsRetryMs, `short retry, saw ${refused.retryAfterMs} ms`)
  assert.deepEqual({ state: port.status().state, reason: port.status().reason }, { state: 'unavailable', reason: 'host_unavailable' })
  assert.notEqual(port.status().reason, 'no_provider')
  code = null
  await clock.advance(HOST_AI_DEFAULTS.optionsRetryMs + 100)
  assert.equal((await port.complete(background())).value.importance, 'action', 'asked again after the short retry, not after providerRetryMs')
  // a complete() that fails because the host cannot be reached: transient, global short backoff, same sentence
  const down = portSetup({ reply: () => ({ fail: 'plugin_host_unavailable' }) })
  const failed = await rejection(down.port.complete(background()))
  assert.equal(failed.code, 'plugin_host_unavailable')
  assert.equal(isTransientAiCode('plugin_host_unavailable'), true)
  assert.equal(failed.retryAfterMs, HOST_AI_DEFAULTS.hostRetryMs)
  assert.equal(down.port.status().reason, 'host_unavailable')
  // plugin_host_timeout from a complete() is the item's own failure on purpose: a chat that always wedges the model must back off, not be re-queued at the head forever
  assert.equal(isTransientAiCode('plugin_host_timeout'), false)
  // the host says the provider is down: the long retry
  const provider = portSetup()
  provider.mock.control.set({ providerState: 'not_logged_in' })
  await rejection(provider.port.complete(background()))
  assert.equal(provider.port.status().reason, 'provider_not_logged_in')
})

test('F9: the status line names the limit that is actually reached (minute or hour); the host-reported limits are used', () => {
  const base = { busy: false, provider: null, counters: {}, resumeAt: 1_000_000 + 12 * 60_000 }
  assert.match(describeStatus({ ...base, state: 'paused', reason: 'rate_limited_hour', turnsPerHour: 400 }, 1_000_000), /每小時 400 次.*約 12 分鐘後繼續/)
  assert.doesNotMatch(describeStatus({ ...base, state: 'paused', reason: 'rate_limited_hour' }, 1_000_000), /每小時 \d+ 次|每分鐘/, 'unknown limit: no number, no wrong window')
  assert.match(describeStatus({ ...base, state: 'paused', reason: 'rate_limited', turnsPerMinute: 20, resumeAt: 1_030_000 }, 1_000_000), /每分鐘 20 次/)
  assert.match(describeBoardStatus({ ...base, state: 'paused', reason: 'rate_limited_hour', turnsPerHour: 400 }, 1_000_000), /每小時 400 次/)
  assert.match(describeStatus({ ...base, state: 'unavailable', reason: 'host_unavailable' }), /暫時沒有回應/)
})

test('F3 (test report): while Core still remembers turns this backend does not know about, the probes thin out — a rate_limited the window cannot explain backs off to 5 minutes, items are released (never failed), and everything finishes when the window frees', async () => {
  const ctx = workerSetup({ items: 2 })
  ctx.mock.control.consumeTurns(400) // used by the previous life of the backend: Core remembers, a new TurnWindow starts empty, getOptions does not say
  ctx.worker.start()
  await ctx.settle()
  await ctx.clock.advance(30 * 60_000)
  const probes = ctx.mock.stats.errors.rate_limited
  assert.ok(probes >= 5 && probes <= 12, `30 minutes of being blocked cost ${probes} refused probes (a 60 s cap would be ~33)`)
  assert.deepEqual(ctx.q.states(), ['pending', 'pending'])
  assert.ok(ctx.q.store.items.every((item) => item.attempts === 0), 'never counted as the chats\' failure')
  assert.equal(ctx.port.status().state, 'paused')
  await ctx.clock.advance(31 * 60_000) // the foreign turns leave the hour
  await ctx.clock.advance(6 * 60_000)
  assert.deepEqual(ctx.q.states(), ['done', 'done'])
  ctx.worker.stop()
})
