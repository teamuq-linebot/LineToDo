// 0.2.0 — restart, quota and timeout behaviour of the whole backend (real createPluginBackend + the Core 1.7.15 host.ai mock, scripts/lib/mock-tuq-ai.mjs).
// R1-R4 were the Tester's scratch scenarios (output/integration/evidence/step-test/scratch-backend.test.mjs); they are permanent tests now, R4 asserts instead of probing.
//
//   R1  idle-unload / restart: no runOnce, no view call after the restart — the scheduler re-supplies the unprocessed message and the new backend extracts it; a reply that
//       was in flight when the old backend was disposed is NOT committed late (no duplicate todo).
//   R2  hourly cap in ONE backend: 410 chats, the real limits, fake clock. The host never accepts more than 400 in any rolling hour (background stays at 400 - extractHourReserve),
//       never says rate_limited, nothing is marked failed, every chat ends up as exactly one todo.
//   R3  restart while Core still remembers the window (Core keeps the turn times per plugin in ITS memory, our TurnWindow is per backend process and starts empty): the host never
//       accepts more than 400 / hour, items are kept (released, not failed, no chat backoff), the refused probes thin out, and everything finishes once the window frees.
//   R4  a user action (草擬回覆) while a big background backlog has used all of its share of the hour: the draft is answered at once, the status line says "hourly limit", not "ready".
//   F1  ai.status / ai.options while TeamUQ's getOptions never answers: they answer before the host's 30 s call limit (otherwise Core isolates the whole backend), and recover.
//   F3  the lease: an answer that arrives after its lease expired is dropped (never a second todo) and the item is asked again; with the default lease a slow answer is committed once.
//
//   node --experimental-strip-types --experimental-loader=./scripts/ts-test-loader.mjs --test --test-timeout=120000 scripts/plugin/test-ai-resilience.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createPluginBackend } from '../../src/plugin/backend/assemble.ts'
import { backendMethodFor } from '../../src/shared/pluginWire.ts'
import { createPluginLineTodoApi } from '../../src/renderer/platform/pluginApi.ts'
import { createMockTuqAi } from '../lib/mock-tuq-ai.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(predicate, { timeout = 8000, step = 15, message = 'condition' } = {}) {
  const t0 = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - t0 > timeout) assert.fail(`timed out waiting for ${message}`)
    await sleep(step)
  }
}
function fakeLine() {
  const listeners = new Set(); let running = false
  const port = {
    start() { running = true }, stop() { running = false },
    status: () => ({ state: running ? 'running' : 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 }),
    onMessage(cb) { listeners.add(cb); return () => listeners.delete(cb) }, onStatus() { return () => {} }, getMessagesSince: async () => []
  }
  return { port, emit: (m) => listeners.forEach((cb) => cb(m)) }
}
const raw = (i, { chatId = `u-${i}`, chat = `客戶${i}`, text } = {}) => {
  const t = 1_700_000_000_000 + i * 1000
  return { msgId: `m${i}`, chat, chatId, isGroup: false, ts: t, time: new Date(t).toISOString(), direction: 'in', sender: chat, text: text ?? `請幫我處理第 ${i} 件事情，明天要交`, contentType: 0 }
}
const todoFor = (user, title) => {
  const payload = JSON.parse(user); const first = payload.newMessages[0]
  return { importance: 'action', newTodos: [{ bucket: 'todo', title: title ?? `處理 ${payload.chat.name}`, detail: `來自：${first.text.slice(0, 20)}`, priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds: [first.msgId] }], resolved: [], updates: [] }
}
const fenced = (value) => '好的，整理如下：\n```json\n' + JSON.stringify(value) + '\n```\n'

function makeClock(start) {
  let time = start
  const clock = { now: () => time, timers: new Map(), next: 1, setTimeout(fn, ms) { const id = this.next++; this.timers.set(id, { at: time + ms, fn }); return id }, clearTimeout(id) { this.timers.delete(id) } }
  clock.advance = async (ms, settleMs = 25) => {
    const end = time + ms
    for (;;) {
      const due = [...clock.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      time = Math.max(time, due[1].at); clock.timers.delete(due[0]); due[1].fn(); await sleep(settleMs)
    }
    time = end
    await sleep(settleMs)
  }
  return clock
}

const callOf = (backend) => async (path, ...args) => {
  const r = await backend.call(backendMethodFor(path), { path, args })
  if (!r.ok) throw Object.assign(new Error(r.message ?? r.code), { code: r.code })
  return r.value
}
/** the raw envelope (ok or not), for the paths whose failure code is the point */
const envelopeOf = (backend) => (path, ...args) => backend.call(backendMethodFor(path), { path, args })
/** the real view adapter (handles chunked results) over the backend: for reading big lists only */
const listTodos = async (backend) => {
  const api = createPluginLineTodoApi({ host: { backend: { call: async (m, p) => JSON.parse(JSON.stringify(await backend.call(m, JSON.parse(JSON.stringify(p))))) }, assets: { url: (p) => p } }, events: { enabled: false }, busyRetry: { attempts: 0 } })
  try { return await api.db.todos.list() } finally { api.dispose() }
}
const extracted = async (call) => (await call('ai.status', {})).counters.extracted
const boot = (opts) => createPluginBackend({ pluginId: 'tuqdev.line-todo', version: '4.0.0', ...opts })
const FAST_AI = { busyRetryMs: 10, busyBackoffMs: 50, providerRetryMs: 150, rateBackoffBaseMs: 40, rateBackoffMaxMs: 160, quotaDefaultMs: 300, revokedProbeMs: 120, optionsTtlMs: 20 }

/** max number of host-accepted turns inside any rolling window of `windowMs` (inclusive, like Core's `at - time <= window`). */
const maxInWindow = (turns, windowMs) => {
  const at = turns.map((t) => t.at).sort((a, b) => a - b)
  let best = 0
  for (let i = 0, j = 0; i < at.length; i += 1) { while (at[i] - at[j] > windowMs) j += 1; best = Math.max(best, i - j + 1) }
  return best
}

test('R1 restart after an idle unload: the new backend re-supplies and extracts the unprocessed message on its own (no runOnce, no view); a late reply from the disposed backend is not committed', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'resilience-r1-'))
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ pollIntervalSec: 5 }))
  try {
    // first life: the model is slow (900 ms); the backend is disposed while the host call is in flight
    const line1 = fakeLine()
    const ai1 = createMockTuqAi({ reply: (ctx) => ({ text: fenced(todoFor(ctx.user, '寄報價單給客戶')), delay: () => sleep(900) }) })
    const b1 = await boot({ dataDir, line: line1.port, hostAi: ai1.ai, ai: { config: FAST_AI } })
    const call1 = callOf(b1)
    line1.emit(raw(1, { text: '請幫我寄報價單給客戶' }))
    await call1('pipeline.runOnce')
    await until(() => ai1.stats.completes >= 1, { message: 'the turn is in flight' })
    await b1.dispose() // "TeamUQ unloads the idle backend" (or crashes) with the reply still pending
    await sleep(1200) // the late reply arrives at the disposed backend
    // second life: same data dir, a fresh mock, NOTHING calls the backend
    const line2 = fakeLine()
    const ai2 = createMockTuqAi({ reply: (ctx) => fenced(todoFor(ctx.user, '寄報價單給客戶')) })
    const b2 = await boot({ dataDir, line: line2.port, hostAi: ai2.ai, ai: { config: FAST_AI } })
    try {
      await until(() => ai2.stats.completes >= 1, { timeout: 15000, step: 50, message: 'the new backend asks the AI by itself' })
      const call2 = callOf(b2)
      const list = await until(async () => { const l = await call2('db.todos.list'); return l.length >= 1 ? l : null }, { message: 'the todo' })
      await sleep(500)
      assert.equal((await call2('db.todos.list')).length, 1, 'exactly one todo: the first life\'s late reply did not add a second one')
      assert.equal(list[0].title, '寄報價單給客戶')
      assert.equal(ai2.stats.completes, 1)
      const stats = await call2('extract.stats')
      assert.equal(stats.pending + stats.leased, 0)
    } finally { await b2.dispose() }
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})

test('R2 hourly cap in one backend: 410 chats, real limits (20/min, 400/h, reserve 2 + 20) — the host never accepts more than 400 in any rolling hour (background stays at 380) and never says rate_limited; everything finishes exactly once', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'resilience-r2-'))
  const clock = makeClock(50_000_000)
  const line = fakeLine()
  const ai = createMockTuqAi({ now: clock.now, reply: (ctx) => fenced(todoFor(ctx.user)) })
  const b = await boot({ dataDir, line: line.port, hostAi: ai.ai, ai: { clock, config: {}, worker: { pollIntervalMs: 15_000 } } })
  const call = callOf(b)
  try {
    const N = 410
    for (let i = 1; i <= N; i += 1) line.emit(raw(i))
    await call('pipeline.runOnce')
    let steps = 0
    let sawHourlyStatus = false
    for (; steps < 400; steps += 1) {
      await clock.advance(20_000, 30)
      if (steps % 20 === 0) await call('pipeline.runOnce')
      if (!sawHourlyStatus && ai.stats.completes >= 380) {
        const status = await call('ai.status', {})
        if (status.state === 'paused' && status.reason === 'rate_limited_hour') { sawHourlyStatus = true; assert.equal(status.turnsPerHour, 400); assert.ok(status.resumeAt > clock.now()) }
      }
      if ((await extracted(call)) >= N) break
    }
    const todos = await listTodos(b)
    const status = await call('ai.status', {})
    const turns = ai.stats.turns
    assert.equal(todos.length, N)
    assert.equal(new Set(todos.map((t) => t.chatId)).size, N, 'one todo per chat')
    assert.equal(ai.stats.completes, N, 'each chat extracted exactly once (no re-asks, no repairs)')
    assert.ok(maxInWindow(turns, 3_600_000) <= 380, `rolling hour max ${maxInWindow(turns, 3_600_000)}: 20 turns of every hour stay free for the user`)
    assert.ok(maxInWindow(turns, 60_000) <= 18, `rolling minute max ${maxInWindow(turns, 60_000)}`)
    assert.equal(ai.stats.errors.rate_limited, 0, 'the port\'s own window kept it below the host limit — Core never had to refuse')
    assert.equal(status.counters.failed, 0)
    assert.equal(sawHourlyStatus, true, 'while the last chats waited for the hour, the status said so (review F9) instead of "ready"')
    assert.equal(ai.control.liveSessions(), 0)
  } finally { await b.dispose(); rmSync(dataDir, { recursive: true, force: true }) }
})

test('R3 restart while Core remembers the window: 395 turns already used in the hour, backend restarts mid-backlog — the host never exceeds 400/h, nothing is failed or lost, the refused probes thin out, everything finishes after the window frees', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'resilience-r3-'))
  const clock = makeClock(80_000_000)
  const ai = createMockTuqAi({ now: clock.now, reply: (ctx) => fenced(todoFor(ctx.user)) })
  // used earlier by the previous life of the backend, spread over ~26 fake minutes so the per-minute limit is not what refuses (Core keeps them; a new backend process starts with an empty TurnWindow)
  for (let used = 0; used < 395; used += 15) { ai.control.consumeTurns(Math.min(15, 395 - used)); await clock.advance(61_000, 1) }
  let peakHour = ai.control.turnsInWindow(3_600_000)
  const N = 20
  const mk = async () => { const line = fakeLine(); const b = await boot({ dataDir, line: line.port, hostAi: ai.ai, ai: { clock, config: {}, worker: { pollIntervalMs: 15_000 } } }); return { line, b, call: callOf(b) } }
  let life = null
  try {
    life = await mk()
    for (let i = 1; i <= N; i += 1) life.line.emit(raw(i))
    await life.call('pipeline.runOnce')
    await clock.advance(30_000, 40)
    await until(() => ai.stats.errors.rate_limited >= 1, { message: 'the host refuses with rate_limited (our window did not know about the 395)' })
    const mid = await life.call('extract.stats')
    const st1 = await life.call('ai.status', {})
    assert.equal(ai.stats.completes, 5, 'only the 5 turns that were still free were accepted')
    assert.equal(mid.chatsBackingOff, 0, 'rate_limited is not the chat\'s failure')
    assert.equal(st1.counters.failed, 0)
    assert.equal(st1.state, 'paused')
    assert.equal(st1.reason, 'rate_limited')
    await life.b.dispose() // idle unload
    const probesLife1 = ai.stats.errors.rate_limited
    life = await mk()
    await life.call('pipeline.runOnce')
    for (let k = 0; k < 20; k += 1) await clock.advance(30_000, 30) // 10 more fake minutes, still inside the hour
    assert.equal(ai.stats.completes, 5, 'no further turn accepted while Core\'s window is full')
    const probesAfter10Min = ai.stats.errors.rate_limited - probesLife1
    assert.ok(probesAfter10Min <= 8, `10 minutes of being blocked cost ${probesAfter10Min} refused probes (it was 16 with a 60 s cap)`)
    // the hour passes: the 395 old turns leave the window
    for (let k = 0; k < 70; k += 1) { await clock.advance(60_000, 30); peakHour = Math.max(peakHour, ai.control.turnsInWindow(3_600_000)); if ((await extracted(life.call)) >= N) break }
    const todos = await listTodos(life.b)
    assert.equal(todos.length, N)
    assert.equal(new Set(todos.map((t) => t.chatId)).size, N)
    assert.equal(ai.stats.completes, N)
    assert.ok(peakHour <= 400, `host-side hour count peaked at ${peakHour}`)
    assert.ok(ai.stats.errors.rate_limited <= 24, `the whole recovery cost ${ai.stats.errors.rate_limited} refused probes (it was 38 with a 60 s cap)`)
    assert.equal((await life.call('ai.status', {})).counters.failed, 0)
    await life.b.dispose()
  } finally { await life?.b.dispose(); rmSync(dataDir, { recursive: true, force: true }) }
})

test('R4 a user action (草擬回覆) while a big background backlog has used all of its share of the hour: the draft is answered at once, and the status line says the hourly limit is reached (not "ready")', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'resilience-r4-'))
  const clock = makeClock(120_000_000)
  const ai = createMockTuqAi({ now: clock.now, reply: (ctx) => (/草擬|回覆/.test(ctx.system) && !ctx.user.includes('newMessages') ? '好的，我明天下午三點前回覆您。' : fenced(todoFor(ctx.user))) })
  const line = fakeLine()
  const b = await boot({ dataDir, line: line.port, hostAi: ai.ai, ai: { clock, config: {}, worker: { pollIntervalMs: 15_000 } } })
  const call = callOf(b)
  try {
    for (let i = 1; i <= 420; i += 1) line.emit(raw(i))
    await call('pipeline.runOnce')
    for (let s = 0; s < 120 && ai.stats.completes < 380; s += 1) { await clock.advance(20_000, 30); if (s % 20 === 0) await call('pipeline.runOnce') }
    assert.equal(ai.stats.completes, 380, 'background used its share of the hour (400 - 20 kept for the user)')
    await clock.advance(20_000, 30)
    assert.equal(ai.stats.completes, 380, 'and went no further')
    const status = await call('ai.status', {})
    assert.deepEqual({ state: status.state, reason: status.reason, turnsPerHour: status.turnsPerHour }, { state: 'paused', reason: 'rate_limited_hour', turnsPerHour: 400 })
    assert.ok(status.resumeAt > clock.now())
    const todos = await listTodos(b)
    assert.ok(todos.length >= 1)
    const before = ai.stats.completes
    const pending = call('db.todos.draftReply', todos[0].id).then((v) => ({ ok: true, v }), (e) => ({ ok: false, code: e.code, message: e.message }))
    for (let k = 0; k < 8; k += 1) await clock.advance(5_000, 30)
    const outcome = await Promise.race([pending, sleep(3000).then(() => ({ pendingStill: true }))])
    assert.deepEqual(outcome, { ok: true, v: { draft: '好的，我明天下午三點前回覆您。' } })
    assert.equal(ai.stats.completes - before, 1, 'one more turn: the user\'s')
    assert.equal(ai.stats.errors.rate_limited, 0)
  } finally { await b.dispose(); rmSync(dataDir, { recursive: true, force: true }) }
})

test('F1 (backend): TeamUQ\'s getOptions never answers — ai.status and ai.options answer at their own deadline, far below the host\'s 30 s call limit (a call that lasts 30 s gets the whole backend isolated), and the backend recovers when TeamUQ answers again', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'resilience-f1-'))
  const line = fakeLine()
  const ai = createMockTuqAi({ reply: (ctx) => fenced(todoFor(ctx.user)) })
  let hang = true
  const parked = []
  const hostAi = { ...ai.ai, getOptions: () => (hang ? new Promise((resolve) => { parked.push(resolve) }) : ai.ai.getOptions()) }
  // the port's own guard is set long on purpose: this test is about the dispatcher's deadline (the port's guard has its own test in test-ai-orchestrator.mjs)
  const b = await boot({ dataDir, line: line.port, hostAi, ai: { config: { ...FAST_AI, optionsGuardMs: 60_000, optionsRetryMs: 100 } }, dispatcher: { aiDeadlineMs: 150 } })
  const envelope = envelopeOf(b)
  try {
    const t0 = Date.now()
    const raced = (promise) => Promise.race([promise, sleep(3000).then(() => ({ hung: true }))])
    const status = await raced(envelope('ai.status', { refresh: true }))
    assert.notEqual(status.hung, true, 'ai.status answered although getOptions never does')
    assert.equal(status.ok, true)
    assert.equal(status.value.state, 'unavailable', 'the last known state: not connected yet')
    const options = await raced(envelope('ai.options'))
    assert.notEqual(options.hung, true, 'ai.options answered although getOptions never does')
    assert.deepEqual({ ok: options.ok, code: options.code }, { ok: false, code: 'plugin_host_timeout' })
    assert.ok(Date.now() - t0 < 2500, `both answered within ${Date.now() - t0} ms`)
    // the backend is not wedged: other paths answer, and once TeamUQ answers the AI works
    assert.equal((await envelope('extract.stats')).ok, true)
    hang = false
    for (const answer of parked.splice(0)) answer(await ai.ai.getOptions()) // TeamUQ finally answers the parked question
    await sleep(200)
    const again = await raced(envelope('ai.status', { refresh: true }))
    assert.equal(again.ok, true)
    assert.equal(again.value.state, 'running')
    assert.equal((await raced(envelope('ai.options'))).ok, true)
  } finally { await b.dispose(); rmSync(dataDir, { recursive: true, force: true }) }
})

test('F3 (lease): an answer that arrives after its lease expired is dropped — never a second todo — and the item is asked again; with the normal lease a slow answer is committed once', async () => {
  for (const [name, workerConfig, expectedTurns, expectedRejected] of [['lease 1 s, answer after 1.5 s', { leaseMs: 1000, pollIntervalMs: 100 }, 2, 1], ['default lease, answer after 1.5 s', { pollIntervalMs: 100 }, 1, 0]]) {
    const dataDir = mkdtempSync(join(tmpdir(), 'resilience-f3-'))
    const line = fakeLine()
    const ai = createMockTuqAi({ reply: (ctx) => ({ text: fenced(todoFor(ctx.user, '寄報價單給客戶')), ...(ctx.turn === 0 ? { delay: () => sleep(1500) } : {}) }) })
    const b = await boot({ dataDir, line: line.port, hostAi: ai.ai, ai: { config: FAST_AI, worker: workerConfig } })
    const call = callOf(b)
    try {
      line.emit(raw(1, { text: '請幫我寄報價單給客戶' }))
      await call('pipeline.runOnce')
      await until(async () => (await call('db.todos.list')).length >= 1, { timeout: 15000, step: 50, message: `${name}: the todo` })
      await sleep(600)
      assert.equal((await call('db.todos.list')).length, 1, `${name}: exactly one todo`)
      assert.equal(ai.stats.completes, expectedTurns, `${name}: host turns`)
      const status = await call('ai.status', {})
      assert.equal(status.counters.rejected, expectedRejected, `${name}: answers dropped because the lease was gone`)
      assert.equal(status.counters.failed, 0)
      const stats = await call('extract.stats')
      assert.equal(stats.pending + stats.leased, 0)
    } finally { await b.dispose(); rmSync(dataDir, { recursive: true, force: true }) }
  }
})
