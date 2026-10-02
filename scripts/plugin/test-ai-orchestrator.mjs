// Phase 4 — the UI-side AI orchestrator (src/plugin/ui/aiOrchestrator.ts) against a mock `window.tuqPlugin.ai` that reproduces TeamUQ 1.6.8's ai:chat
// (scripts/lib/mock-tuq-ai.mjs: strict request schema, session_limit, turn_in_progress, 20/min + 400/h sliding window, quota cooldown, view_not_visible,
// access revocation, event stream). Time is a manual clock shared by the orchestrator and the mock host, so minute-long behaviour runs in milliseconds.
//
//   (a) quota      — never more than 20 sends in any 60 s window, no host rate_limited; 2 turns reserved for user actions; 400/h
//   (b) visibility — hidden view: nothing is pulled, nothing is opened; visible again: work resumes; host `view_not_visible` releases the lease (not a failure)
//   (c) retries    — turn_in_progress retried; rate_limited / quota_exhausted / provider_unavailable back off and re-queue; access_revoked stops
//   (d) JSON       — ```json fenced replies parse and pass zod; bad JSON gets one repair turn, then the chat fails; zod-invalid replies fail
//   limits         — system <= 16,000, one turn's input <= 8,000 (checked before a session is opened)
import assert from 'node:assert/strict'
import test from 'node:test'

import { EXTRACT_SYSTEM_PROMPT } from '../../src/main/llm/extractPrompt.ts'
import {
  AI_CHAT_REFERENCE, ORCHESTRATOR_DEFAULTS, TurnWindow, createAiOrchestrator, createVisibilitySource, describeStatus, parseModelJson
} from '../../src/plugin/ui/aiOrchestrator.ts'
import { CONTRACT, createMockTuqAi } from '../lib/mock-tuq-ai.mjs'

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

// ───────────── fake backend channels (same protocol as ExtractQueue / AiTaskQueue: leases, commit statuses, release) ─────────────

function makeChannels(clock, { items = [], tasks = [], system = 'SYSTEM_PROMPT_TEXT', format = 'OUTPUT_FORMAT_TEXT' } = {}) {
  const store = { items: [], tasks: [], leases: new Map(), commits: [], releases: [], taskCommits: [], taskReleases: [], pulls: 0, taskPulls: 0, systemCalls: 0, listeners: new Set(), counter: 0, failAfter: new Map() }
  const addItem = (item) => store.items.push({ chatId: 'c1', user: JSON.stringify({ chat: { chatId: item.chatId ?? 'c1' }, newMessages: [{ msgId: 'm1', text: '請幫我寄報價單' }] }), attempts: 0, notBefore: 0, state: 'pending', ...item })
  const addTask = (task) => store.tasks.push({ kind: 'draftReply', system: 'TASK_SYSTEM', user: '{"x":1}', expectJson: false, state: 'pending', ...task })
  items.forEach(addItem)
  tasks.forEach(addTask)
  const extract = {
    system: async () => { store.systemCalls += 1; return { system, sha256: 'sha-1', chars: system.length, maxUserChars: 7500, format } },
    pull: async ({ max = 1 } = {}) => {
      store.pulls += 1
      const out = []
      for (const item of store.items) {
        if (item.state !== 'pending' || item.notBefore > clock.now() || out.length >= max) continue
        item.state = 'leased'
        item.leaseId = `lease-${++store.counter}`
        store.leases.set(item.leaseId, item)
        out.push({ itemId: item.leaseId, chatId: item.chatId, user: item.user, userChars: item.user.length, attempts: item.attempts })
      }
      return { items: out, systemSha256: 'sha-1', retryAfterMs: null }
    },
    commit: async (results) => ({
      results: results.map((r) => {
        const item = store.leases.get(r.itemId)
        store.commits.push(r)
        if (!item) return { itemId: r.itemId, status: 'unknown_item' }
        store.leases.delete(r.itemId)
        if (r.ok) { item.state = 'done'; return { itemId: r.itemId, status: 'applied' } }
        item.state = 'pending'; item.attempts += 1; item.notBefore = clock.now() + 30_000 * 2 ** (item.attempts - 1)
        return { itemId: r.itemId, status: 'failed_recorded', code: r.failCode }
      })
    }),
    release: async (ids) => {
      store.releases.push(...ids)
      for (const id of ids) { const item = store.leases.get(id); if (item) { store.leases.delete(id); item.state = 'pending' } }
      return { released: ids.length, unknown: [] }
    },
    onPending: (cb) => { store.listeners.add(cb); return () => store.listeners.delete(cb) }
  }
  const taskChannel = {
    pull: async ({ max = 1 } = {}) => {
      store.taskPulls += 1
      const out = []
      for (const task of store.tasks) {
        if (task.state !== 'pending' || out.length >= max) continue
        task.state = 'leased'
        task.leaseId = `task-lease-${++store.counter}`
        store.leases.set(task.leaseId, task)
        out.push({ taskId: task.leaseId, kind: task.kind, system: task.system, user: task.user, expectJson: task.expectJson })
      }
      return { tasks: out }
    },
    commit: async (results) => ({
      results: results.map((r) => {
        const task = store.leases.get(r.taskId)
        store.taskCommits.push(r)
        if (!task) return { taskId: r.taskId, status: 'unknown_task' }
        store.leases.delete(r.taskId)
        task.state = 'done'
        return { taskId: r.taskId, status: r.ok ? 'accepted' : 'failed_recorded' }
      })
    }),
    release: async (ids) => { store.taskReleases.push(...ids); return { released: ids.length } }
  }
  return {
    store, extract, tasks: taskChannel, addItem, addTask,
    /** the backend's `extract-pending` event */
    announce: () => { for (const cb of [...store.listeners]) cb({ pending: store.items.filter((i) => i.state === 'pending').length }) },
    itemStates: () => store.items.map((i) => i.state)
  }
}

function makeVisibility(initial = true) {
  const listeners = new Set()
  const v = {
    visible: initial,
    isVisible: () => v.visible,
    subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
    set(next) { v.visible = next; for (const cb of [...listeners]) cb(next) }
  }
  return v
}

const GOOD = {
  importance: 'action',
  newTodos: [{ bucket: 'todo', title: '回覆報價單', detail: null, priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds: ['m1'] }],
  resolved: [], updates: []
}
const goodText = JSON.stringify(GOOD)

function setup({ items = 1, tasks = [], reply = () => goodText, config = {}, visible = true, channels = {} } = {}) {
  const clock = new FakeClock()
  const mock = createMockTuqAi({ now: clock.now, reply })
  const chans = makeChannels(clock, { items: Array.from({ length: items }, (_, i) => ({ chatId: `c${i + 1}` })), tasks, ...channels })
  const visibility = makeVisibility(visible)
  const logs = []
  const orch = createAiOrchestrator({ ai: mock.ai, extract: chans.extract, tasks: chans.tasks, visibility, clock, config, log: (event, detail) => logs.push([event, detail]) })
  return { clock, mock, chans, visibility, orch, logs, settle: () => flush(), at: () => clock.now() - 1_000_000 }
}

// ───────────── contract drift guard ─────────────

test('contract: the mock host and the orchestrator constants match the 1.6.8 ai:chat contract fixture (aiChatContracts.ts @ b8b96cb3)', () => {
  assert.equal(CONTRACT.source.commit, 'b8b96cb3')
  const L = CONTRACT.limits
  assert.deepEqual(
    { systemChars: AI_CHAT_REFERENCE.systemChars, inputChars: AI_CHAT_REFERENCE.inputChars, turnsPerMinute: AI_CHAT_REFERENCE.turnsPerMinute, turnsPerHour: AI_CHAT_REFERENCE.turnsPerHour, replyChars: AI_CHAT_REFERENCE.replyChars, turnTimeoutMs: AI_CHAT_REFERENCE.turnTimeoutMs },
    { systemChars: L.systemChars, inputChars: L.inputChars, turnsPerMinute: L.turnsPerMinute, turnsPerHour: L.turnsPerHour, replyChars: L.replyChars, turnTimeoutMs: L.turnTimeoutMs },
    'orchestrator reference limits = contract limits'
  )
  assert.equal(ORCHESTRATOR_DEFAULTS.perMinute, L.turnsPerMinute)
  assert.equal(ORCHESTRATOR_DEFAULTS.perHour, L.turnsPerHour)
  assert.ok(ORCHESTRATOR_DEFAULTS.turnTimeoutMs < L.turnTimeoutMs, 'we give up before Core does, so we can interrupt the turn ourselves')
  assert.equal(L.sessionsPerPlugin, 1, 'one session per plugin: the orchestrator serialises all AI work')
  assert.ok(ORCHESTRATOR_DEFAULTS.extractReserve < L.turnsPerMinute)
  // every error code the mock can throw is a real 1.6.8 code; failure events use the real failure codes
  assert.deepEqual(CONTRACT.errorCodes.length, 16)
  assert.ok(CONTRACT.errorCodes.includes('view_not_visible') && CONTRACT.errorCodes.includes('turn_in_progress') && CONTRACT.errorCodes.includes('rate_limited'))
  assert.ok(CONTRACT.failureCodes.includes('access_revoked') && CONTRACT.failureCodes.includes('empty_reply') && CONTRACT.failureCodes.includes('reply_too_long'))
  assert.deepEqual([...CONTRACT.eventKinds].sort(), ['completed', 'failed', 'interrupted', 'started', 'textDelta'])
  // the extraction system prompt fits (design v2 §7 Phase 4: 4,759 chars <= 16,000)
  assert.ok(EXTRACT_SYSTEM_PROMPT.length <= L.systemChars, `system prompt ${EXTRACT_SYSTEM_PROMPT.length} chars`)
})

test('mock host: refuses what 1.6.8 refuses (strict request schema, input/system limits, session_limit, view_not_visible, grant) with the real error codes', async () => {
  const { ai, control, stats } = createMockTuqAi({ reply: () => '{}' })
  const session = await ai.openSession({ system: 'S' })
  await assert.rejects(ai.openSession({ system: 'S' }), /^Error: session_limit$/)
  await assert.rejects(session.send({ text: 'x'.repeat(8001) }), /^Error: request_invalid$/, 'inputChars 8000 is part of the strict schema')
  await assert.rejects(session.send({ text: '   ' }), /^Error: request_invalid$/)
  await assert.rejects(session.send({ text: 'x', extra: 1 }), /^Error: request_invalid$/)
  await session.close()
  await assert.rejects(ai.openSession({ system: 'x'.repeat(16_001) }), /^Error: request_invalid$/)
  await assert.rejects(ai.openSession({ system: 'S', providerId: 'nope' }), /^Error: provider_not_found$/)
  await assert.rejects(ai.openSession({ system: 'S', modelId: 'other' }), /^Error: model_unavailable$/)
  await assert.rejects(ai.openSession({ system: 'S', cwd: '/' }), /^Error: request_invalid$/, 'no path / sandbox / tool fields can be smuggled in')
  control.visible = false
  await assert.rejects(ai.openSession({ system: 'S' }), /^Error: view_not_visible$/)
  assert.equal((await ai.getOptions()).limits.turnsPerMinute, 20, 'getOptions works while hidden (aiChatService only gates open/send)')
  control.visible = true
  control.providerState = 'not_logged_in'
  await assert.rejects(ai.openSession({ system: 'S' }), /^Error: provider_not_ready$/)
  control.granted = false
  await assert.rejects(ai.getOptions(), /^Error: not_granted$/)
  assert.ok(stats.errors.session_limit >= 1 && stats.errors.view_not_visible === 1)
  for (const code of Object.keys(stats.errors)) assert.ok(CONTRACT.errorCodes.includes(code))
})

// ───────────── (a) quota ─────────────

test('(a) quota: a sliding window of 20 turns/min — never more, never a host rate_limited, the 21st waits for the first to leave the window', async () => {
  const ctx = setup({ items: 45, config: { extractReserve: 0 } })
  ctx.orch.start()
  await ctx.settle()
  assert.equal(ctx.mock.stats.sends, 20, '20 turns go out at once')
  await ctx.clock.advance(60_200)
  assert.equal(ctx.mock.stats.sends, 20, 'the window (60 s + margin) has not slid yet')
  await ctx.clock.advance(100)
  assert.equal(ctx.mock.stats.sends, 40)
  await ctx.clock.advance(60_300)
  assert.equal(ctx.mock.stats.sends, 45, 'all items done')
  assert.equal(ctx.mock.stats.errors.rate_limited, 0, 'the host never had to refuse')
  const times = ctx.mock.stats.turns.map((t) => t.at)
  for (let i = 0; i < times.length; i += 1) {
    const inWindow = times.filter((t, j) => j <= i && times[i] - t <= 60_000).length
    assert.ok(inWindow <= 20, `turn ${i}: ${inWindow} sends within 60 s`)
  }
  assert.equal(ctx.chans.itemStates().filter((s) => s === 'done').length, 45)
  assert.equal(ctx.mock.control.liveSessions(), 0)
  await ctx.orch.stop()
})

test('(a) quota: background extraction keeps 2 turns/min for user actions — extraction stops at 18, a user action still gets through', async () => {
  const ctx = setup({ items: 30 })
  ctx.orch.start()
  await ctx.settle()
  assert.equal(ctx.mock.stats.sends, 18, 'extraction is capped at 20 - 2')
  ctx.chans.addTask({ kind: 'draftReply', system: 'DRAFT_SYSTEM', user: '{"todo":1}' })
  ctx.chans.announce()
  await ctx.settle()
  assert.equal(ctx.mock.stats.sends, 19, 'the user action used a reserved slot')
  assert.equal(ctx.chans.store.taskCommits.length, 1)
  assert.equal(ctx.chans.store.taskCommits[0].ok, true)
  assert.equal(ctx.mock.stats.errors.rate_limited, 0)
  await ctx.orch.stop()
})

test('(a) quota: TurnWindow reproduces aiChatService\'s window (60 s inclusive, 1 h) and the hourly cap of 400', () => {
  const w = new TurnWindow(20, 400, 0)
  for (let i = 0; i < 20; i += 1) w.record(1000)
  assert.equal(w.delay(1000), 60_001, 'host: count of turns with (now - t) <= 60000 is >= 20 -> refused; allowed from t + 60001')
  assert.equal(w.delay(61_000), 1, 'exactly 60 s later the host still refuses (<= 60000)')
  assert.equal(w.delay(61_001), 0)
  assert.equal(w.delay(1000, 2), 60_001, 'a reserve of 2 leaves 18')
  const h = new TurnWindow(20, 400, 0)
  for (let k = 0; k < 400; k += 1) h.record(k * 8000) // 400 turns, 8 s apart (<= 20 per minute, so only the hourly cap bites)
  const last = 399 * 8000
  assert.equal(h.delay(last), 0 + 3_600_001 - last, 'the 400th turn in the hour: wait until the first one is > 1 h old')
  assert.equal(h.delay(3_600_001), 0, 'once the first turn is older than 1 h there is room again')
  const partial = new TurnWindow(20, 400, 0)
  for (let i = 0; i < 399; i += 1) partial.record(i * 5000)
  assert.equal(partial.delay(399 * 5000), 0, '399 turns in the hour: one more is fine')
})

test('(a) quota: the per-minute limit follows getOptions().limits.turnsPerMinute when it is lower', async () => {
  const ctx = setup({ items: 10, config: { extractReserve: 0, perMinute: 2 } })
  ctx.orch.start()
  await ctx.settle()
  assert.equal(ctx.mock.stats.sends, 2)
  await ctx.orch.stop()
})

// ───────────── (b) visibility ─────────────

test('(b) visibility: a hidden view pauses extraction (nothing pulled, nothing opened, no ai:chat call at all); visible again resumes — not a failure', async () => {
  const ctx = setup({ items: 2, visible: false })
  ctx.orch.start()
  await ctx.settle()
  assert.equal(ctx.chans.store.pulls, 0)
  assert.equal(ctx.mock.stats.getOptions + ctx.mock.stats.openSession + ctx.mock.stats.sends, 0)
  assert.equal(ctx.orch.status().state, 'paused')
  assert.equal(ctx.orch.status().reason, 'view_hidden')
  assert.match(describeStatus(ctx.orch.status()), /看板在背景/)
  assert.equal(ctx.orch.connected(), true, 'paused is not disconnected: AI features stay available when the board comes back')
  ctx.chans.announce() // a pending event while hidden changes nothing
  await ctx.settle()
  assert.equal(ctx.chans.store.pulls, 0)
  ctx.visibility.set(true)
  await ctx.settle()
  assert.equal(ctx.orch.status().state, 'running')
  assert.deepEqual(ctx.chans.itemStates(), ['done', 'done'])
  assert.equal(ctx.mock.stats.sends, 2)
  assert.equal(ctx.chans.store.commits.every((c) => c.ok), true)
  await ctx.orch.stop()
})

test('(b) visibility: hidden in the middle of the queue — the turn in flight finishes and is committed; nothing new starts until visible', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const ctx = setup({ items: 3, reply: ({ sessionIndex }) => (sessionIndex === 1 ? { text: goodText, delay: () => gate } : goodText) })
  ctx.orch.start()
  await ctx.settle()
  assert.equal(ctx.mock.stats.sends, 1)
  ctx.visibility.set(false)
  release()
  await ctx.settle()
  assert.deepEqual(ctx.chans.itemStates(), ['done', 'pending', 'pending'], 'item 1 committed, the rest wait')
  assert.equal(ctx.mock.stats.sends, 1)
  ctx.visibility.set(true)
  await ctx.settle()
  assert.deepEqual(ctx.chans.itemStates(), ['done', 'done', 'done'])
  await ctx.orch.stop()
})

test('(b) visibility: the host says view_not_visible although the page looks visible (placement hidden / occluded) — the lease is released (no failure, no per-chat backoff), then it probes and continues', async () => {
  const ctx = setup({ items: 1 })
  ctx.mock.control.visible = false
  ctx.orch.start()
  await ctx.settle()
  assert.equal(ctx.mock.stats.errors.view_not_visible, 1)
  assert.equal(ctx.chans.store.releases.length, 1, 'released')
  assert.equal(ctx.chans.store.commits.length, 0, 'not committed as a failure')
  assert.equal(ctx.chans.store.items[0].attempts, 0, 'the chat is not penalised')
  assert.equal(ctx.chans.store.items[0].notBefore, 0)
  assert.equal(ctx.orch.status().reason, 'view_not_visible')
  assert.equal(ctx.orch.status().state, 'paused')
  assert.equal(ctx.mock.control.liveSessions(), 0)
  ctx.mock.control.visible = true
  await ctx.clock.advance(ORCHESTRATOR_DEFAULTS.hiddenProbeMs + 50)
  assert.deepEqual(ctx.chans.itemStates(), ['done'])
  assert.equal(ctx.orch.status().state, 'running')
  await ctx.orch.stop()
})

test('(b) visibility: createVisibilitySource combines page visibility with TeamUQ presentation.visible (the "after" phase) and unsubscribes cleanly', async () => {
  const doc = { visibilityState: 'visible', handlers: new Set(), addEventListener(type, cb) { assert.equal(type, 'visibilitychange'); this.handlers.add(cb) }, removeEventListener(type, cb) { this.handlers.delete(cb) }, fire() { for (const cb of [...this.handlers]) cb() } }
  const presentation = { listeners: new Set(), get: async () => ({ visible: true }), onChange(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb) } }
  const source = createVisibilitySource({ document: doc, presentation })
  const seen = []
  source.subscribe((v) => seen.push(v))
  await flush(2)
  assert.equal(source.isVisible(), true)
  doc.visibilityState = 'hidden'; doc.fire()
  assert.deepEqual(seen, [false])
  doc.visibilityState = 'visible'; doc.fire()
  assert.deepEqual(seen, [false, true])
  for (const cb of presentation.listeners) cb({ phase: 'before', visible: false })
  assert.equal(source.isVisible(), true, 'the "before" phase of a presentation change is ignored')
  for (const cb of presentation.listeners) cb({ phase: 'after', visible: false })
  assert.equal(source.isVisible(), false)
  assert.deepEqual(seen, [false, true, false])
  source.dispose()
  assert.equal(doc.handlers.size, 0)
  assert.equal(presentation.listeners.size, 0)
  const initiallyHidden = createVisibilitySource({ document: doc, presentation: { get: async () => ({ visible: false }), onChange: () => () => {} } })
  await flush(2)
  assert.equal(initiallyHidden.isVisible(), false)
  initiallyHidden.dispose()
})

// ───────────── (c) retries and backoff ─────────────

test('(c) turn_in_progress: send is retried (6 x 250 ms, like ai-lover ai-port.js); the item still completes', async () => {
  const ctx = setup({ items: 1 })
  ctx.mock.control.turnInProgressFor = 3
  ctx.orch.start()
  await ctx.settle()
  assert.equal(ctx.mock.stats.sends, 0)
  await ctx.clock.advance(250 * 3)
  assert.equal(ctx.mock.stats.errors.turn_in_progress, 3)
  assert.equal(ctx.mock.stats.sends, 1)
  assert.deepEqual(ctx.chans.itemStates(), ['done'])
  assert.equal(ctx.chans.store.releases.length, 0)
  await ctx.orch.stop()
})

test('(c) turn_in_progress that never clears: after 6 retries the item is released (not failed) and the orchestrator backs off briefly', async () => {
  const ctx = setup({ items: 1 })
  ctx.mock.control.turnInProgressFor = 100
  ctx.orch.start()
  await ctx.settle()
  await ctx.clock.advance(250 * 6)
  assert.equal(ctx.mock.stats.errors.turn_in_progress, 7, 'first attempt + 6 retries')
  assert.equal(ctx.chans.store.releases.length, 1)
  assert.equal(ctx.chans.store.commits.length, 0)
  assert.equal(ctx.mock.control.liveSessions(), 0, 'the session is closed even though nothing was sent')
  assert.equal(ctx.orch.status().state, 'paused')
  await ctx.orch.stop()
})

test('(c) rate_limited from the host (turns the orchestrator cannot see) backs off exponentially, re-queues without failing the chat, and succeeds once the window frees', async () => {
  const ctx = setup({ items: 1 })
  ctx.mock.control.consumeTurns(20) // someone else filled this plugin\'s window at t0
  const t0 = ctx.clock.now()
  ctx.orch.start()
  await ctx.settle()
  assert.equal(ctx.mock.stats.errors.rate_limited, 1)
  assert.equal(ctx.orch.status().reason, 'rate_limited')
  assert.match(describeStatus(ctx.orch.status(), ctx.clock.now()), /每分鐘 20 次/)
  await ctx.clock.advance(5000)
  assert.equal(ctx.mock.stats.errors.rate_limited, 2)
  await ctx.clock.advance(10_000)
  assert.equal(ctx.mock.stats.errors.rate_limited, 3)
  await ctx.clock.advance(20_000)
  assert.equal(ctx.mock.stats.errors.rate_limited, 4)
  await ctx.clock.advance(40_000) // t0 + 75 s: the consumed turns left the window at t0 + 60.001 s
  assert.deepEqual(ctx.mock.stats.refused.filter((r) => r.code === 'rate_limited').map((r) => r.at - t0), [0, 5000, 15_000, 35_000], 'backoff 5 s, 10 s, 20 s')
  assert.deepEqual(ctx.chans.itemStates(), ['done'])
  assert.equal(ctx.chans.store.commits.every((c) => c.ok), true, 'never committed as a failure')
  assert.equal(ctx.chans.store.items[0].attempts, 0)
  await ctx.orch.stop()
})

test('(c) quota_exhausted (failed event): the item is re-queued, nothing more is sent during Core\'s cooldown, and work resumes afterwards', async () => {
  let first = true
  const ctx = setup({ items: 2, reply: () => { if (first) { first = false; return { fail: 'quota_exhausted' } } return goodText } })
  ctx.orch.start()
  await ctx.settle()
  assert.equal(ctx.mock.stats.sends, 1)
  assert.equal(ctx.chans.store.releases.length, 1, 'released, not failed')
  assert.equal(ctx.chans.store.commits.length, 0)
  assert.equal(ctx.orch.status().state, 'paused')
  assert.equal(ctx.orch.status().reason, 'quota_exhausted')
  assert.ok(ctx.orch.status().resumeAt > ctx.clock.now() + 4 * 60_000, 'waits for the cooldown reported by getOptions().quota.retryAfterMs')
  assert.match(describeStatus(ctx.orch.status(), ctx.clock.now()), /額度已用完/)
  ctx.chans.announce(); ctx.orch.kick()
  await ctx.settle()
  assert.equal(ctx.mock.stats.sends, 1, 'a kick during the cooldown sends nothing')
  await ctx.clock.advance(5 * 60_000 + 500)
  assert.deepEqual(ctx.chans.itemStates(), ['done', 'done'])
  assert.equal(ctx.mock.stats.errors.quota_exhausted, 0, 'the orchestrator never hit the host\'s quota refusal itself')
  await ctx.orch.stop()
})

test('(c) quota already exhausted when we look (getOptions): extraction does not even pull; a user action is answered at once with quota_exhausted + retryAfterMs instead of waiting', async () => {
  const ctx = setup({ items: 1, tasks: [{ kind: 'draftReply' }] })
  ctx.mock.control.exhaustQuota(120_000)
  ctx.orch.start()
  await ctx.settle()
  assert.equal(ctx.chans.store.pulls, 0, 'no extraction lease while blocked')
  assert.equal(ctx.mock.stats.openSession, 0)
  assert.equal(ctx.chans.store.taskCommits.length, 1)
  assert.equal(ctx.chans.store.taskCommits[0].ok, false)
  assert.equal(ctx.chans.store.taskCommits[0].failCode, 'quota_exhausted')
  assert.ok(ctx.chans.store.taskCommits[0].retryAfterMs > 100_000)
  ctx.mock.control.quotaUntil = 0
  await ctx.clock.advance(121_000)
  assert.deepEqual(ctx.chans.itemStates(), ['done'])
  await ctx.orch.stop()
})

test('(c) provider_unavailable (failed event) re-queues and waits for the provider; a Codex that is not logged in is "unavailable" (not an error per chat) and queued user actions are answered at once', async () => {
  let first = true
  const a = setup({ items: 1, reply: () => { if (first) { first = false; return { fail: 'provider_unavailable' } } return goodText } })
  a.orch.start()
  await a.settle()
  assert.equal(a.chans.store.releases.length, 1)
  assert.equal(a.chans.store.commits.length, 0)
  assert.equal(a.orch.status().reason, 'provider_unavailable')
  await a.clock.advance(ORCHESTRATOR_DEFAULTS.providerRetryMs + 500)
  assert.deepEqual(a.chans.itemStates(), ['done'])
  await a.orch.stop()

  const b = setup({ items: 1, tasks: [{ kind: 'draftReply' }] })
  b.mock.control.providerState = 'not_logged_in'
  b.orch.start()
  await b.settle()
  assert.equal(b.orch.status().state, 'unavailable')
  assert.equal(b.orch.status().reason, 'provider_not_logged_in')
  assert.equal(b.orch.connected(), false)
  assert.match(b.orch.note(), /Codex 尚未登入/)
  assert.equal(b.chans.store.pulls, 0)
  assert.equal(b.chans.store.taskCommits[0].failCode, 'provider_unavailable', 'the user is told at once')
  b.mock.control.providerState = 'ready'
  await b.clock.advance(ORCHESTRATOR_DEFAULTS.providerRetryMs + 1000)
  assert.equal(b.orch.status().state, 'running')
  assert.equal(b.orch.connected(), true)
  assert.deepEqual(b.chans.itemStates(), ['done'])
  await b.orch.stop()
})

test('(c) failures that ARE the chat\'s: empty_reply / reply_too_long / provider_error / turn_timeout are committed as failures (messages stay unprocessed, the queue backs the chat off), nothing is released', async () => {
  for (const [name, script, code] of [
    ['empty_reply', { empty: true }, 'empty_reply'],
    ['reply_too_long', { chunks: ['x'.repeat(20_000), 'y'.repeat(20_000)] }, 'reply_too_long'],
    ['provider_error', { fail: 'provider_error' }, 'provider_error'],
    ['stalled', { fail: 'stalled' }, 'stalled']
  ]) {
    const ctx = setup({ items: 1, reply: () => script })
    ctx.orch.start()
    await ctx.settle()
    assert.equal(ctx.chans.store.commits.length, 1, name)
    assert.deepEqual({ ok: ctx.chans.store.commits[0].ok, failCode: ctx.chans.store.commits[0].failCode }, { ok: false, failCode: code }, name)
    assert.equal(ctx.chans.store.releases.length, 0, name)
    assert.equal(ctx.orch.status().counters.failed, 1)
    assert.equal(ctx.mock.control.liveSessions(), 0)
    await ctx.orch.stop()
  }
  // a turn that hangs: the orchestrator gives up before Core's 300 s, interrupts it, and reports turn_timeout
  const hung = setup({ items: 1, reply: () => ({ hang: true }) })
  hung.orch.start()
  await hung.settle()
  assert.equal(hung.chans.store.commits.length, 0)
  await hung.clock.advance(ORCHESTRATOR_DEFAULTS.turnTimeoutMs + 100)
  assert.equal(hung.mock.stats.interrupts, 1)
  assert.equal(hung.chans.store.commits[0].failCode, 'turn_timeout')
  assert.equal(hung.mock.control.liveSessions(), 0)
  await hung.orch.stop()
})

test('(c) access_revoked: a running turn that fails with access_revoked stops the orchestrator — the lease is returned, nothing more is sent, the user is told how to fix it', async () => {
  const ctx = setup({ items: 3, tasks: [], reply: () => ({ hang: true }) })
  ctx.orch.start()
  await ctx.settle()
  assert.equal(ctx.mock.stats.sends, 1)
  ctx.mock.control.revoke()
  await ctx.settle()
  assert.equal(ctx.orch.status().state, 'revoked')
  assert.equal(ctx.orch.connected(), false)
  assert.match(ctx.orch.note(), /ai:chat/)
  assert.equal(ctx.chans.store.releases.length, 1, 'released, not failed')
  assert.equal(ctx.chans.store.commits.length, 0)
  const sends = ctx.mock.stats.sends
  ctx.chans.announce(); ctx.orch.kick(); ctx.visibility.set(false); ctx.visibility.set(true)
  await ctx.clock.advance(120_000)
  assert.equal(ctx.mock.stats.sends, sends, 'stopped for good')
  assert.equal(ctx.mock.control.liveSessions(), 0)
  await ctx.orch.stop()
})

test('(c) access_revoked before the first call (getOptions -> not_granted): revoked at once, queued user actions fail with access_revoked', async () => {
  const ctx = setup({ items: 2, tasks: [{ kind: 'draftReply' }] })
  ctx.mock.control.granted = false
  ctx.orch.start()
  await ctx.settle()
  assert.equal(ctx.orch.status().state, 'revoked')
  assert.equal(ctx.chans.store.pulls, 0)
  assert.equal(ctx.chans.store.taskCommits[0].failCode, 'access_revoked')
  await ctx.orch.stop()
})

test('(c) session_limit / busy / session_not_found are transient: released, brief backoff, no failure', async () => {
  const ctx = setup({ items: 1 })
  ctx.mock.control.otherActiveTurns = 4 // Core-wide concurrentTurnsTotal = 4 used by other plugins -> send is refused with `busy`
  ctx.orch.start()
  await ctx.settle()
  assert.equal(ctx.mock.stats.errors.busy, 1)
  assert.equal(ctx.chans.store.releases.length, 1)
  assert.equal(ctx.chans.store.commits.length, 0)
  ctx.mock.control.otherActiveTurns = 0
  await ctx.clock.advance(ORCHESTRATOR_DEFAULTS.busyBackoffMs + 100)
  assert.deepEqual(ctx.chans.itemStates(), ['done'])
  await ctx.orch.stop()
})

// ───────────── (d) JSON ─────────────

test('(d) parseModelJson: plain, ```json fenced, bare fence, prose around the object, BOM, braces inside strings — and the failures', () => {
  const value = { a: 1, s: '含有 } 與 { 的字串' }
  const json = JSON.stringify(value)
  for (const [name, raw] of [
    ['plain', json], ['padded', `\n  ${json}\n`], ['fenced json', '```json\n' + json + '\n```'], ['fenced JSON caps', '```JSON\n' + json + '\n```'],
    ['bare fence', '```\n' + json + '\n```'], ['prose before and after', `好的，結果如下：\n${json}\n希望有幫助`], ['fence with prose', '以下是結果：\n```json\n' + json + '\n```\n以上'],
    ['BOM', '﻿' + json]
  ]) {
    const parsed = parseModelJson(raw)
    assert.equal(parsed.ok, true, name)
    assert.deepEqual(parsed.value, value, name)
  }
  for (const bad of ['', '   ', '沒有 JSON', '{"a": 1,}', '{"a": ', '```json\n{bad\n```', 'null?']) assert.equal(parseModelJson(bad).ok, false, JSON.stringify(bad))
  assert.equal(parseModelJson('[1,2]').ok, true, 'any JSON value parses; the schema check decides')
})

test('(d) a reply wrapped in ```json fences is parsed and passes zod: the committed result is the validated, normalised ExtractResult (detail/dueAt -> null)', async () => {
  const sloppy = { importance: 'action', newTodos: [{ bucket: 'waiting', title: '等客戶回覆', priority: 1, confidence: 0.8, sourceMsgIds: ['m1'] }], resolved: [] }
  const ctx = setup({ items: 1, reply: () => ({ chunks: ['好的，以下是結果：\n```js', 'on\n', JSON.stringify(sloppy), '\n```'] }) })
  ctx.orch.start()
  await ctx.settle()
  assert.equal(ctx.chans.store.commits.length, 1)
  const committed = ctx.chans.store.commits[0]
  assert.equal(committed.ok, true)
  assert.deepEqual(committed.result, { importance: 'action', newTodos: [{ bucket: 'waiting', title: '等客戶回覆', detail: null, priority: 1, dueAt: null, confidence: 0.8, sourceMsgIds: ['m1'] }], resolved: [], updates: [] })
  assert.equal(ctx.mock.stats.sends, 1, 'no repair turn needed')
  await ctx.orch.stop()
})

test('(d) bad JSON: one repair turn in the SAME session (costs one more quota turn); if it is still bad the chat fails with invalid_json and its messages stay unprocessed', async () => {
  const ok = setup({ items: 1, reply: ({ repair }) => (repair ? '```json\n' + goodText + '\n```' : '當然！我會整理成 JSON：{"importance": "action", ') })
  ok.orch.start()
  await ok.settle()
  assert.equal(ok.mock.stats.sends, 2)
  assert.equal(ok.mock.stats.turns[0].sessionIndex, ok.mock.stats.turns[1].sessionIndex, 'repair happens in the same session')
  assert.match(ok.mock.stats.turns[1].text, /不是合法的 JSON/)
  assert.deepEqual(ok.chans.store.commits[0].result.newTodos[0].title, '回覆報價單')
  assert.equal(ok.orch.status().counters.repairs, 1)
  await ok.orch.stop()

  const bad = setup({ items: 1, reply: () => '我不太確定，請問你要整理哪一段？' })
  bad.orch.start()
  await bad.settle()
  assert.equal(bad.mock.stats.sends, 2, 'one repair attempt at most — no quota burning')
  assert.deepEqual({ ok: bad.chans.store.commits[0].ok, failCode: bad.chans.store.commits[0].failCode }, { ok: false, failCode: 'invalid_json' })
  assert.equal(bad.chans.store.items[0].state, 'pending', 'unprocessed: it will be extracted again after the queue\'s backoff')
  assert.equal(bad.mock.control.liveSessions(), 0)
  await bad.orch.stop()

  const noRepair = setup({ items: 1, config: { maxRepairs: 0 }, reply: () => 'nope' })
  noRepair.orch.start()
  await noRepair.settle()
  assert.equal(noRepair.mock.stats.sends, 1)
  await noRepair.orch.stop()
})

test('(d) valid JSON that fails the zod schema is a failed chat (invalid_result) — an unvalidated object is never committed as ok', async () => {
  for (const wrong of [
    { importance: 'urgent', newTodos: [], resolved: [], updates: [] },
    { importance: 'action', newTodos: [{ bucket: 'todo', title: 123, priority: 2, confidence: 0.5, sourceMsgIds: ['m1'] }], resolved: [], updates: [] },
    { importance: 'action', newTodos: [{ bucket: 'todo', title: 'x', priority: 9, confidence: 0.5, sourceMsgIds: [] }], resolved: [], updates: [] },
    { newTodos: [] },
    []
  ]) {
    const ctx = setup({ items: 1, reply: () => JSON.stringify(wrong) })
    ctx.orch.start()
    await ctx.settle()
    assert.equal(ctx.mock.stats.sends, 2, 'a repair turn that names the problem')
    assert.match(ctx.mock.stats.turns[1].text, /importance|newTodos|Required|Expected|Invalid|invalid/)
    assert.deepEqual({ ok: ctx.chans.store.commits[0].ok, failCode: ctx.chans.store.commits[0].failCode }, { ok: false, failCode: 'invalid_result' }, JSON.stringify(wrong))
    assert.equal(ctx.chans.store.commits.filter((c) => c.ok).length, 0)
    await ctx.orch.stop()
  }
})

// ───────────── limits ─────────────

test('limits: the system prompt goes out as system + output format, within 16,000; an input over 8,000 chars is failed BEFORE a session is opened', async () => {
  const ctx = setup({ items: 1 })
  ctx.orch.start()
  await ctx.settle()
  assert.equal(ctx.mock.stats.turns[0].system, 'SYSTEM_PROMPT_TEXT\n\nOUTPUT_FORMAT_TEXT', 'extract.system() + format, nothing else')
  assert.ok(ctx.mock.stats.turns[0].text.length <= CONTRACT.limits.inputChars)
  await ctx.orch.stop()

  const big = setup({ items: 0 })
  big.chans.addItem({ chatId: 'huge', user: 'x'.repeat(8001) })
  big.orch.start()
  await big.settle()
  assert.equal(big.mock.stats.openSession, 0)
  assert.equal(big.chans.store.commits[0].failCode, 'input_too_large')
  await big.orch.stop()

  const longSystem = setup({ items: 1, channels: { system: 'S'.repeat(16_001), format: '' } })
  longSystem.orch.start()
  await longSystem.settle()
  assert.equal(longSystem.mock.stats.openSession, 0)
  assert.equal(longSystem.chans.store.commits[0].failCode, 'system_too_large')
  await longSystem.orch.stop()
})

// ───────────── sessions, shutdown ─────────────

test('sessions: one fresh session per item (no context leaks between chats), at most one alive, always closed — also when send fails', async () => {
  const ctx = setup({ items: 4 })
  ctx.orch.start()
  await ctx.settle()
  assert.equal(ctx.mock.stats.openSession, 4)
  assert.equal(ctx.mock.stats.sessionsClosed, 4)
  assert.equal(ctx.mock.stats.maxLiveSessions, 1, 'sessionsPerPlugin = 1')
  assert.equal(ctx.mock.stats.errors.session_limit, 0)
  assert.equal(new Set(ctx.mock.stats.turns.map((t) => t.sessionIndex)).size, 4)
  await ctx.orch.stop()
})

test('stop(): interrupts the turn in flight, returns the lease, closes the session, and leaves no timer or subscription behind', async () => {
  const ctx = setup({ items: 2, reply: () => ({ hang: true }) })
  ctx.orch.start()
  await ctx.settle()
  assert.equal(ctx.mock.stats.sends, 1)
  assert.equal(ctx.mock.control.liveSessions(), 1)
  await ctx.orch.stop()
  assert.equal(ctx.mock.stats.interrupts, 1)
  assert.equal(ctx.mock.control.liveSessions(), 0)
  assert.equal(ctx.chans.store.releases.length, 1)
  assert.equal(ctx.chans.store.commits.length, 0)
  assert.equal(ctx.clock.timers.size, 0, 'no timers left')
  assert.equal(ctx.chans.store.listeners.size, 0, 'unsubscribed from extract-pending')
  assert.equal(ctx.orch.status().state, 'stopped')
  assert.equal(ctx.orch.connected(), false)
  ctx.chans.announce(); ctx.orch.kick()
  await ctx.settle()
  assert.equal(ctx.mock.stats.sends, 1, 'nothing happens after stop')
})

test('scheduling: an extract-pending event starts work at once; idle polling is the fallback; the pull hint (retryAfterMs) schedules the next look', async () => {
  const ctx = setup({ items: 0 })
  ctx.orch.start()
  await ctx.settle()
  assert.equal(ctx.chans.store.pulls, 1, 'looked once, found nothing')
  ctx.chans.addItem({ chatId: 'late' })
  ctx.chans.announce()
  await ctx.settle()
  assert.deepEqual(ctx.chans.itemStates(), ['done'], 'the event woke it up')
  ctx.chans.addItem({ chatId: 'quiet' }) // no event: only the idle poll can find it
  await ctx.clock.advance(ORCHESTRATOR_DEFAULTS.pollIntervalMs + 100)
  assert.deepEqual(ctx.chans.itemStates(), ['done', 'done'])
  await ctx.orch.stop()
})

// ───────────── user actions (draftReply / analyzeNotMine / groupTopics) ─────────────

test('user actions: served before background extraction; plain text comes back trimmed with the model that answered; JSON actions are validated and normalised', async () => {
  const ctx = setup({
    items: 2,
    tasks: [{ kind: 'draftReply', system: 'DRAFT_SYSTEM', user: '{"todo":"x"}' }, { kind: 'analyzeNotMine', system: 'ANALYZE_SYSTEM', user: '{"evidence":[]}', expectJson: true }],
    reply: ({ system }) => (system === 'DRAFT_SYSTEM' ? '  好的，我明天下午回覆您。\n' : system === 'ANALYZE_SYSTEM' ? '```json\n{"summary": "只是公告", "inferredCauseCode": "general_announcement"}\n```' : goodText)
  })
  ctx.orch.start()
  await ctx.settle()
  assert.deepEqual(ctx.mock.stats.turns.map((t) => t.system), ['DRAFT_SYSTEM', 'ANALYZE_SYSTEM', 'SYSTEM_PROMPT_TEXT\n\nOUTPUT_FORMAT_TEXT', 'SYSTEM_PROMPT_TEXT\n\nOUTPUT_FORMAT_TEXT'])
  const [draft, analyze] = ctx.chans.store.taskCommits
  assert.deepEqual({ ok: draft.ok, text: draft.text, model: draft.model }, { ok: true, text: '好的，我明天下午回覆您。', model: 'gpt-5-codex' })
  assert.equal(analyze.ok, true)
  assert.deepEqual(JSON.parse(analyze.text), { summary: '只是公告', inferredCauseCode: 'general_announcement' }, 'fences stripped; the backend gets plain JSON text')
  await ctx.orch.stop()
})

test('user actions: JSON that cannot be repaired fails with invalid_json; an empty draft fails with empty_reply; a window wait over 30 s is refused at once, a shorter one is waited out', async () => {
  const badJson = setup({ items: 0, tasks: [{ kind: 'groupTopics', expectJson: true }], reply: () => '不是 JSON' })
  badJson.orch.start()
  await badJson.settle()
  assert.equal(badJson.chans.store.taskCommits[0].failCode, 'invalid_json')
  assert.equal(badJson.mock.stats.sends, 2)
  await badJson.orch.stop()

  const empty = setup({ items: 0, tasks: [{ kind: 'draftReply' }], reply: () => ({ empty: true }) })
  empty.orch.start()
  await empty.settle()
  assert.equal(empty.chans.store.taskCommits[0].failCode, 'empty_reply')
  await empty.orch.stop()

  // 2 turns per minute: two user actions fill the window, the third must wait for the first to leave it
  const rate = setup({ items: 0, tasks: [{ kind: 'draftReply' }, { kind: 'draftReply' }], config: { perMinute: 2 }, reply: () => '草稿' })
  rate.orch.start()
  await rate.settle()
  assert.equal(rate.chans.store.taskCommits.length, 2)
  await rate.clock.advance(40_000)
  rate.chans.addTask({ kind: 'draftReply' }); rate.chans.announce()
  await rate.settle()
  assert.equal(rate.chans.store.taskCommits.length, 2, 'waiting for a slot (about 20 s)')
  await rate.clock.advance(20_400)
  assert.equal(rate.chans.store.taskCommits.length, 3)
  assert.equal(rate.chans.store.taskCommits[2].ok, true)
  assert.equal(rate.mock.stats.errors.rate_limited, 0)
  rate.chans.addTask({ kind: 'draftReply' }); rate.chans.addTask({ kind: 'draftReply' }); rate.chans.announce()
  await rate.settle()
  const refused = rate.chans.store.taskCommits.slice(3).filter((c) => !c.ok)
  assert.ok(refused.length >= 1, 'the window is full again and the next slot is more than 30 s away: answer rate_limited now')
  assert.equal(refused[0].failCode, 'rate_limited')
  assert.ok(refused[0].retryAfterMs > 30_000)
  await rate.orch.stop()
})

// ───────────── status text ─────────────

test('describeStatus: every state has a user-facing sentence; the "foreground only" rule is stated', () => {
  const base = { busy: false, provider: null, counters: {}, resumeAt: null }
  const text = (state, reason, extra = {}) => describeStatus({ ...base, state, reason, ...extra }, 1_000_000)
  assert.match(text('running', null), /看板在前景時才會整理新訊息/)
  assert.match(text('running', null, { busy: true }), /正在整理/)
  assert.match(text('paused', 'view_hidden'), /前景/)
  assert.match(text('paused', 'rate_limited', { resumeAt: 1_030_000 }), /30 秒後/)
  assert.match(text('paused', 'quota_exhausted', { resumeAt: 1_000_000 + 5 * 60_000 }), /5 分鐘後/)
  assert.match(text('unavailable', 'provider_not_installed'), /尚未安裝 Codex/)
  // G-10: no Core / Codex version is hard-coded in what the user reads
  assert.match(text('unavailable', 'provider_unsupported_version'), /版本不支援/)
  assert.doesNotMatch(text('unavailable', 'provider_unsupported_version'), /\d+\.\d+/)
  assert.match(text('paused', 'backend'), /暫時中斷/)
  assert.match(text('paused', 'backend_revoked'), /後端呼叫/)
  assert.doesNotMatch(text('paused', 'backend_revoked'), /自動繼續|自動恢復/, 'review B1: no promise of resuming by itself')
  assert.match(text('unavailable', 'no_provider'), /找不到可用/)
  assert.match(text('revoked', 'access_revoked'), /ai:chat/)
  assert.match(text('stopped', null), /尚未啟動/)
})

test('G-10: the rate-limit sentence uses the limit the host reported (getOptions().limits.turnsPerMinute), not a hard-coded 20', async () => {
  const base = { busy: false, provider: null, counters: {}, resumeAt: 1_030_000 }
  assert.match(describeStatus({ ...base, state: 'paused', reason: 'rate_limited', turnsPerMinute: 7 }, 1_000_000), /每分鐘 7 次/)
  assert.doesNotMatch(describeStatus({ ...base, state: 'paused', reason: 'rate_limited' }, 1_000_000), /每分鐘 \d+ 次/, 'unknown limit: no number at all')
  // the orchestrator's status carries the live per-minute limit (the window follows getOptions().limits — see the "(a) quota" test above)
  const ctx = setup({ items: 0 })
  ctx.orch.start()
  await ctx.settle()
  assert.equal(typeof ctx.orch.status().turnsPerMinute, 'number')
  assert.ok(ctx.orch.status().turnsPerMinute <= AI_CHAT_REFERENCE.turnsPerMinute)
  await ctx.orch.stop()
})

test('G-03 / B1: Core fencing backend:invoke (plugin_permission_denied, then plugin_disabled for every probe — also after the permission is allowed again) is its own paused reason — not "暫時中斷", no promise of resuming by itself — probed every 30 s; work resumes only once Core lets calls through again (activate)', async () => {
  const ctx = setup({ items: 1 })
  // Core 1.7.1 (backendInvokeGate.ts): the call at the fence gets the reason, every later call plugin_disabled until activate()
  let fence = 'plugin_permission_denied'
  const realPull = ctx.chans.extract.pull
  let pulls = 0
  const codes = []
  ctx.chans.extract.pull = async (options) => {
    pulls += 1
    if (fence) {
      const code = fence
      fence = 'plugin_disabled'
      codes.push(code)
      throw Object.assign(new Error(code), { code })
    }
    return realPull(options)
  }
  ctx.orch.start()
  await ctx.settle()
  const status = ctx.orch.status()
  assert.equal(status.state, 'paused')
  assert.equal(status.reason, 'backend_revoked')
  const sentence = describeStatus(status, ctx.clock.now())
  assert.match(sentence, /TeamUQ 目前不讓這個外掛呼叫後端/)
  assert.match(sentence, /「後端呼叫」權限被關閉、外掛被停用，或後端太久沒有回應而被隔離/)
  assert.match(sentence, /停用再啟用，或重新啟動 TeamUQ/)
  assert.doesNotMatch(sentence, /自動繼續|自動恢復/, 'Core 1.7.1 does not lift the fence when the permission is allowed again')
  const afterFirst = pulls
  await ctx.clock.advance(20_000)
  assert.equal(pulls, afterFirst, 'no hammering: nothing within the 30 s probe interval')
  // the user allows the permission again: Core still fences → the 30 s probe gets plugin_disabled and the reason stays
  await ctx.clock.advance(15_000)
  await ctx.settle()
  assert.ok(pulls > afterFirst, 'probed again after 30 s')
  assert.deepEqual(codes.slice(0, 2), ['plugin_permission_denied', 'plugin_disabled'])
  assert.equal(ctx.orch.status().reason, 'backend_revoked', 'plugin_disabled keeps the same reason')
  assert.equal(ctx.chans.itemStates()[0] === 'done', false)
  // disable → enable the plugin (activate): the next probe gets through
  fence = null
  await ctx.clock.advance(31_000)
  await ctx.settle()
  assert.equal(ctx.chans.itemStates()[0], 'done', 'the item is processed once Core lets calls through again')
  assert.notEqual(ctx.orch.status().reason, 'backend_revoked')
  // a timeout fences too (timeoutPlugin): same paused reason, not the short "暫時中斷" backoff
  const realPull3 = ctx.chans.extract.pull
  ctx.chans.extract.pull = async () => { throw Object.assign(new Error('backend_invoke_timeout'), { code: 'backend_invoke_timeout' }) }
  ctx.chans.addItem({ chatId: 'c8' })
  ctx.chans.announce()
  await ctx.settle()
  assert.equal(ctx.orch.status().reason, 'backend_revoked')
  ctx.chans.extract.pull = realPull3
  // an ordinary backend failure (not fenced) keeps the short backoff and the old wording
  const realPull2 = ctx.chans.extract.pull
  ctx.chans.extract.pull = async () => { throw Object.assign(new Error('plugin_backend_unavailable'), { code: 'plugin_backend_unavailable' }) }
  ctx.chans.addItem({ chatId: 'c9' })
  ctx.chans.announce()
  await ctx.clock.advance(31_000) // the next 30 s probe
  await ctx.settle()
  assert.equal(ctx.orch.status().reason, 'backend')
  ctx.chans.extract.pull = realPull2
  await ctx.orch.stop()
})

// ───────────── the status line the board shows ─────────────

test('AiStatusBar: the board shows one plain-text line with the AI state (foreground-only rule, pause reason, unavailable / revoked) and nothing at all without an orchestrator', async () => {
  const { build } = await import('esbuild')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join, resolve, dirname } = await import('node:path')
  const { fileURLToPath, pathToFileURL } = await import('node:url')
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const work = mkdtempSync(join(tmpdir(), 'ai-status-bar-'))
  try {
    const outfile = join(work, 'bar.mjs')
    await build({
      stdin: { contents: "import { renderToStaticMarkup } from 'react-dom/server'\nimport { AiStatusBar } from './src/plugin/ui/AiStatusBar'\nexport const render = (orchestrator) => renderToStaticMarkup(<AiStatusBar orchestrator={orchestrator} />)\n", resolveDir: root, loader: 'tsx', sourcefile: 'bar-entry.tsx' },
      outfile, bundle: true, format: 'esm', platform: 'node', target: 'node24', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'error', absWorkingDir: root,
      banner: { js: "import { createRequire as __r } from 'node:module'; const require = __r(import.meta.url);" }
    })
    const { render } = await import(pathToFileURL(outfile).href)
    const html = (status) => render({ status: () => status, onStatus: () => () => {} })
    const base = { busy: false, provider: null, counters: {}, resumeAt: null }
    assert.equal(render(null), '', 'no orchestrator (TeamUQ without ai:chat): nothing is drawn')
    const running = html({ ...base, state: 'running', reason: null })
    assert.match(running, /role="status"/)
    assert.match(running, /data-ai-state="running"/)
    assert.match(running, /看板在前景時才會整理新訊息/)
    assert.match(html({ ...base, state: 'running', reason: null, busy: true }), /正在整理新訊息/)
    assert.match(html({ ...base, state: 'paused', reason: 'view_hidden' }), /data-ai-reason="view_hidden"[^>]*>[^<]*看板在背景/)
    assert.match(html({ ...base, state: 'unavailable', reason: 'provider_not_logged_in' }), /Codex 尚未登入/)
    assert.match(html({ ...base, state: 'revoked', reason: 'access_revoked' }), /ai:chat/)
    assert.doesNotMatch(running, /<(?:script|iframe|img|a)\b|on[a-z]+=/i, 'text only: nothing that could load or run anything')
  } finally { rmSync(work, { recursive: true, force: true }) }
})
