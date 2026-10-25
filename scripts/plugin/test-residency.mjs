// Background execution (TeamUQ's `background:resident`, Core's `context.residency`) on the plugin side, 0.2.0.
//   tracker         the backend reads context.residency once and then only follows onChange; an old Core (no residency) and unreadable values change nothing
//   texts           every state has its sentence (locked word for word, scripts/plugin/lib/fenced-text.mjs); an unknown reason code gets the generic sentence
//   absent          a backend whose context has no `residency` behaves as before: same todos, same AI calls, same events, `backend.residency` says supported:false
//   onChange        a change reaches the board: Core -> context.residency.onChange -> `residency` event -> long poll -> adapter -> the status line on screen (real backend, real adapter, real components)
//   no keep-alive   a downgrade (resident -> on-demand, the process keeps running) makes the backend do nothing: no timer, no poll of current(), no host.ai call
//   restart         Core's 24 hour re-fork (clean stop) and its crash restart (SIGKILL with an AI call outstanding) resume idempotently: nothing lost, nothing duplicated, nothing re-sent
//   node --experimental-strip-types --experimental-loader=./scripts/ts-test-loader.mjs --test --test-timeout=120000 scripts/plugin/test-residency.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

import { byAttr, byText, install, reactProps, walk } from './fixtures/mini-dom.mjs'
import { createCoreGateStandin } from '../lib/core-invoke-gate-standin.mjs'
import { createMockTuqAi } from '../lib/mock-tuq-ai.mjs'
import { DOWNGRADED_BUDGET, DOWNGRADED_FUTURE_REASON, DOWNGRADED_NOT_GRANTED, RESIDENT, UNREQUESTED, createResidencyStandin } from '../lib/residency-standin.mjs'
import { createPluginBackend } from '../../src/plugin/backend/assemble.ts'
import { createResidencyTracker } from '../../src/plugin/backend/residency.ts'
import { KNOWN_RESIDENCY_REASONS, RESIDENCY_UNSUPPORTED, describeResidency, normalizeResidency, parseResidencyView } from '../../src/shared/residency.ts'
import { backendMethodFor } from '../../src/shared/pluginWire.ts'
import {
  CORE_PERMISSIONS_SECTION_TITLE, CORE_RESIDENT_TOGGLE_TITLE, EXPECTED_RESIDENCY_TEXT, EXPECTED_RESIDENCY_UNKNOWN_REASON, FUTURE_REASON_CODE,
  RECOVERY_PROMISE, VERSION_SPECIFIC_PLACE, namesVersionSpecificPlace,
} from './lib/fenced-text.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')
const dom = install()
const work = mkdtempSync(join(tmpdir(), 'residency-test-'))
test.after(() => { rmSync(work, { recursive: true, force: true }); dom.restore() })

const outfile = join(work, 'ui-effects.mjs')
await build({
  entryPoints: [resolve(ROOT, 'scripts', 'plugin', 'fixtures', 'ui-effects-entry.tsx')], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node24', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty' }, logLevel: 'error', absWorkingDir: ROOT,
  banner: { js: "import { createRequire as __r } from 'node:module'; const require = __r(import.meta.url);" },
})
const ui = await import(pathToFileURL(outfile).href)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(predicate, { timeout = 8000, message = 'condition' } = {}) {
  const t0 = Date.now()
  while (!(await predicate())) { if (Date.now() - t0 > timeout) assert.fail(`timed out waiting for ${message}`); await sleep(10) }
}
const textOf = (container) => walk(container).map((e) => e.textContent).join(' ')
const barOf = (container) => walk(container).find((el) => el.getAttribute('data-residency-level') !== null && el.getAttribute('data-testid') === null) ?? null

// ───────────── fake LINE, the AI model, the backend under test ─────────────

function fakeLine() {
  const listeners = new Set()
  let running = false
  const port = {
    start() { running = true }, stop() { running = false },
    status: () => ({ state: running ? 'running' : 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 }),
    onMessage(cb) { listeners.add(cb); return () => listeners.delete(cb) }, onStatus() { return () => {} }, getMessagesSince: async () => [],
  }
  return { port, emit: (m) => listeners.forEach((cb) => cb(m)), listeners: () => listeners.size }
}
const raw = (i, text, { chatId = 'u-alice', chat = 'Alice' } = {}) => { const t = 1_700_000_000_000 + i * 1000; return { msgId: `m${i}`, chat, chatId, isGroup: false, ts: t, time: new Date(t).toISOString(), direction: 'in', sender: chat, text, contentType: 0 } }
const fenced = (v) => '```json\n' + JSON.stringify(v) + '\n```'
/** the model: a todo titled after the first message of the offered chat */
const answer = (user) => { const p = JSON.parse(user); const first = p.newMessages[0]; return { importance: 'action', newTodos: [{ bucket: 'todo', title: `跟進 ${first.msgId}`, detail: 'x', priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds: [first.msgId] }], resolved: [], updates: [] } }
const FAST = { ai: { config: { busyRetryMs: 10, providerRetryMs: 150, optionsTtlMs: 20 }, worker: { pollIntervalMs: 40, unavailableRetryMs: 40 } } }

async function startBackend({ dataDir, line, ai, residency, extra = {} }) {
  const backend = await createPluginBackend({ pluginId: 'tuqdev.line-todo', version: '4.0.0', dataDir, line: line.port, hostAi: ai.ai, ...(residency ? { residency } : {}), ...FAST, ...extra })
  const call = async (path, ...args) => backend.call(backendMethodFor(path), { path, args })
  const must = async (path, ...args) => { const r = await call(path, ...args); assert.equal(r.ok, true, `${path}: ${JSON.stringify(r)}`); return r.value }
  return { backend, call, must }
}
const tempData = (label) => mkdtempSync(join(tmpdir(), `residency-${label}-`))

/** everything observable about a backend that is told to process two messages, for the absent-vs-present comparison */
async function observableRun(residencyApi) {
  const dataDir = tempData('parity')
  const line = fakeLine()
  const ai = createMockTuqAi({ reply: (ctx) => (ctx.system.includes('草擬') ? '好的。' : fenced(answer(ctx.user))) })
  const { backend, call, must } = await startBackend({ dataDir, line, ai, residency: residencyApi })
  try {
    const session = await must('events.open', {})
    line.emit(raw(1, '請幫我寄報價單給客戶'))
    line.emit(raw(2, '下午三點開會，記得帶合約'))
    await call('pipeline.runOnce')
    await until(async () => (await must('db.todos.list')).length === 1, { message: 'the todo' })
    await until(async () => (await must('ai.status')).counters.extracted === 1, { message: 'extracted counter' })
    const pulled = await must('events.pull', { sessionId: session.sessionId, afterSeq: session.seq, waitMs: 0 })
    const todos = (await must('db.todos.list')).map((t) => ({ title: t.title, status: t.status, chatId: t.chatId }))
    const counters = (await must('ai.status')).counters
    return {
      todos, counters, hasResidencyEvent: pulled.events.some((e) => e.type === 'residency'), eventTypes: [...new Set(pulled.events.map((e) => e.type))].sort(), aiTurns: ai.stats.turns.length, aiCompletes: ai.stats.completes,
      residency: await must('backend.residency'), infoResidency: (await must('backend.info')).residency, messages: (await must('db.messages.list', { chatId: 'u-alice' })).map((m) => m.processed),
    }
  } finally { await backend.dispose(); rmSync(dataDir, { recursive: true, force: true }) }
}

// ───────────── the tracker ─────────────

test('tracker: a context without residency (old Core), a non-object and a source of the wrong shape are all "unsupported" — nothing is subscribed, nothing is ever reported', () => {
  for (const source of [undefined, null, 'residency', 42, {}, { current: () => ({}) }, { onChange: () => () => undefined }, { current: 1, onChange: 2 }]) {
    const tracker = createResidencyTracker(source)
    assert.deepEqual(tracker.snapshot(), RESIDENCY_UNSUPPORTED, JSON.stringify(source))
    let notified = 0
    tracker.onChange(() => { notified += 1 })
    tracker.dispose()
    assert.equal(notified, 0)
  }
  const throwing = createResidencyStandin({ mode: 'present' })
  const source = { current: () => { throw new Error('boom') }, onChange: throwing.api.onChange }
  assert.deepEqual(createResidencyTracker(source).snapshot(), RESIDENCY_UNSUPPORTED, 'a current() that throws is unsupported, not a crash')
  assert.equal(throwing.stats.subscribes, 0, 'and it is not subscribed to')
})

test('tracker: reads current() once, follows onChange, reports only real changes, ignores unreadable values, isolates listener errors, and dispose unsubscribes', () => {
  const core = createResidencyStandin({ mode: 'present', initial: RESIDENT })
  const logs = []
  const tracker = createResidencyTracker(core.api, (event) => logs.push(event))
  assert.deepEqual(tracker.snapshot(), { supported: true, requested: true, level: 'resident', reason: null })
  assert.equal(core.stats.currentCalls, 1, 'one read at start')
  assert.equal(core.listeners(), 1)
  const seen = []
  tracker.onChange((snapshot) => seen.push(snapshot))
  tracker.onChange(() => { throw new Error('a broken listener') })
  tracker.onChange((snapshot) => seen.push({ second: snapshot.reason }))
  assert.equal(core.apply(DOWNGRADED_NOT_GRANTED), true)
  assert.deepEqual(seen, [{ supported: true, requested: true, level: 'on-demand', reason: 'resident_not_granted' }, { second: 'resident_not_granted' }], 'the broken listener did not stop the others')
  assert.equal(core.apply(DOWNGRADED_NOT_GRANTED), false, 'Core itself drops an identical value')
  core.push(DOWNGRADED_FUTURE_REASON)
  assert.equal(tracker.snapshot().reason, FUTURE_REASON_CODE, 'an unknown reason code is kept as it is (open set)')
  assert.equal(core.apply({ requested: true, level: 'on-demand', reason: 'resident_future_new_reason' }), false, 'Core\'s own parser would have ignored a code its schema does not list — which is why push() exists')
  assert.equal(seen.length, 4)
  assert.ok(logs.includes('residency changed') && logs.includes('residency listener failed'))
  tracker.dispose()
  assert.equal(core.listeners(), 0, 'dispose unsubscribes from Core')
  core.apply(RESIDENT)
  assert.equal(seen.length, 4, 'nothing after dispose')
  tracker.dispose()
})

test('tracker: values that are not a residency record are ignored and the last good value stays; a value Core repeats is reported once', () => {
  let deliver = null
  const source = { current: () => ({ requested: true, level: 'resident', reason: null }), onChange: (listener) => { deliver = listener; return () => { deliver = null } } }
  const tracker = createResidencyTracker(source)
  const seen = []
  tracker.onChange((snapshot) => seen.push(snapshot.level))
  const before = tracker.snapshot()
  for (const junk of [null, undefined, 'x', 7, [], {}, { requested: 'yes', level: 'resident', reason: null }, { level: 'on-demand', reason: null }]) deliver(junk)
  assert.deepEqual(tracker.snapshot(), before)
  assert.deepEqual(seen, [])
  deliver({ requested: true, level: 'resident', reason: null })
  assert.deepEqual(seen, [], 'the same value again is not a change')
  deliver({ requested: true, level: 'on-demand', reason: 'resident_inactive' })
  deliver({ requested: true, level: 'on-demand', reason: 'resident_inactive' })
  assert.deepEqual(seen, ['on-demand'])
  tracker.dispose()
  assert.equal(deliver, null)
})

test('normalizeResidency / parseResidencyView: level other than "resident" is on-demand, a reason must be a short plain code, a view value that is not "supported" is unsupported', () => {
  assert.deepEqual(normalizeResidency({ requested: true, level: 'turbo', reason: 'x'.repeat(65) }), { supported: true, requested: true, level: 'on-demand', reason: null })
  assert.deepEqual(normalizeResidency({ requested: true, level: 'on-demand', reason: 'resident_new-code.2' }), { supported: true, requested: true, level: 'on-demand', reason: 'resident_new-code.2' })
  assert.equal(normalizeResidency({ level: 'resident' }), null)
  assert.deepEqual(parseResidencyView(undefined), RESIDENCY_UNSUPPORTED)
  assert.deepEqual(parseResidencyView({ supported: false, requested: true, level: 'resident', reason: null }), RESIDENCY_UNSUPPORTED)
  assert.deepEqual(parseResidencyView({ supported: true, requested: 'x' }), RESIDENCY_UNSUPPORTED)
  assert.equal(parseResidencyView({ supported: true, requested: false, level: 'on-demand', reason: null }).supported, true)
})

// ───────────── what the screen says ─────────────

test('texts: every state has its sentence, locked word for word; none names a place only one TeamUQ version has, none promises a recovery that is not guaranteed', () => {
  const states = [
    ['notRequested', UNREQUESTED], ['resident', RESIDENT],
    ...KNOWN_RESIDENCY_REASONS.map((reason) => [reason, { requested: true, level: 'on-demand', reason }]),
  ]
  assert.equal(states.length, 10)
  assert.deepEqual(Object.keys(EXPECTED_RESIDENCY_TEXT).sort(), states.map(([name]) => name).sort(), 'the locked list covers exactly the states')
  for (const [name, state] of states) {
    const text = describeResidency({ supported: true, ...state })
    assert.ok(text, name)
    assert.equal(text.bar, EXPECTED_RESIDENCY_TEXT[name].bar, `${name}: bar`)
    assert.equal(text.detail, EXPECTED_RESIDENCY_TEXT[name].detail, `${name}: detail`)
    assert.equal(namesVersionSpecificPlace(text.detail), false, `${name}: no version-specific place`)
    assert.doesNotMatch(text.detail, VERSION_SPECIFIC_PLACE, name)
    assert.doesNotMatch(text.detail, RECOVERY_PROMISE, `${name}: no promise of automatic recovery`)
  }
  // where the user is sent: the switch has Core's own title, in the section that has it
  for (const name of ['resident', 'resident_not_granted']) assert.ok(EXPECTED_RESIDENCY_TEXT[name].detail.includes(`「${CORE_PERMISSIONS_SECTION_TITLE}」裡`) && EXPECTED_RESIDENCY_TEXT[name].detail.includes(`「${CORE_RESIDENT_TOGGLE_TITLE}」`), name)
  const tones = Object.fromEntries(states.map(([name, state]) => [name, describeResidency({ supported: true, ...state }).tone]))
  assert.deepEqual(tones, {
    notRequested: 'info', resident: 'ok', resident_not_granted: 'info', resident_inactive: 'warn', resident_budget_exceeded: 'warn', resident_crash_budget_exhausted: 'warn',
    resident_boot_failed: 'warn', resident_artifact_revoked: 'warn', resident_revalidation_failed: 'warn', resident_policy_error: 'warn',
  }, 'only "the user has not switched it on" and "not asked for" are plain; a stop or a refusal Core decided is a warning')
  assert.equal(describeResidency(RESIDENCY_UNSUPPORTED), null, 'an old Core: nothing at all')
})

test('texts: a reason code Core adds later (open set) gets the generic sentence with the code printed, whatever else is true; the constructor-like codes are not "known" either', () => {
  const unknown = describeResidency({ supported: true, requested: true, level: 'on-demand', reason: FUTURE_REASON_CODE })
  assert.equal(unknown.bar, EXPECTED_RESIDENCY_UNKNOWN_REASON.bar)
  assert.equal(unknown.detail, EXPECTED_RESIDENCY_UNKNOWN_REASON.detail)
  assert.equal(unknown.tone, 'warn')
  for (const reason of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const text = describeResidency({ supported: true, requested: true, level: 'on-demand', reason })
    assert.ok(text.bar.includes(`原因代碼：${reason}`), reason)
  }
  const noReason = describeResidency({ supported: true, requested: true, level: 'on-demand', reason: null })
  assert.equal(noReason.bar, '沒有在背景執行')
  assert.ok(noReason.detail.includes(`「${CORE_RESIDENT_TOGGLE_TITLE}」`))
  // a resident level with a (contradictory) reason is still resident: the level decides
  assert.equal(describeResidency({ supported: true, requested: true, level: 'resident', reason: FUTURE_REASON_CODE }).tone, 'ok')
})

// ───────────── the backend ─────────────

test('absent (old Core): the same work gives the same todos, AI calls, counters and events with or without context.residency; backend.residency says supported:false and no residency event is ever published', async () => {
  const absent = await observableRun(undefined)
  const unrequested = await observableRun(createResidencyStandin({ mode: 'present' }).api)
  assert.deepEqual(absent.residency, RESIDENCY_UNSUPPORTED)
  assert.deepEqual(absent.infoResidency, RESIDENCY_UNSUPPORTED)
  assert.deepEqual(unrequested.residency, { supported: true, requested: false, level: 'on-demand', reason: null })
  assert.equal(absent.todos.length, 1)
  assert.equal(absent.aiCompletes, 1)
  assert.equal(absent.hasResidencyEvent, false, `events: ${absent.eventTypes}`)
  assert.equal(unrequested.hasResidencyEvent, false, 'the start-up value is not an event either: the board reads it with backend.residency')
  // the throttled ai-status event may or may not have arrived yet; everything else is deterministic
  const { residency: _a, infoResidency: _ai, eventTypes: _ea, ...restAbsent } = absent
  const { residency: _u, infoResidency: _ui, eventTypes: _eu, ...restUnrequested } = unrequested
  assert.deepEqual(restUnrequested, restAbsent, 'everything else is identical')
})

test('onChange: backend.residency and backend.info follow Core, each real change is published once as a `residency` event, a repeated value is not, dispose stops following', async () => {
  const dataDir = tempData('change')
  const line = fakeLine()
  const ai = createMockTuqAi({ reply: () => fenced({ importance: 'noise', newTodos: [], resolved: [], updates: [] }) })
  const core = createResidencyStandin({ mode: 'present', initial: RESIDENT })
  const { backend, must } = await startBackend({ dataDir, line, ai, residency: core.api })
  try {
    assert.deepEqual(await must('backend.residency'), { supported: true, requested: true, level: 'resident', reason: null })
    const session = await must('events.open', {})
    let after = session.seq
    const residencyEvents = async (waitMs = 100) => { const p = await must('events.pull', { sessionId: session.sessionId, afterSeq: after, waitMs }); after = p.seq; return p.events.filter((e) => e.type === 'residency').map((e) => e.payload) }
    core.apply(DOWNGRADED_NOT_GRANTED)
    assert.deepEqual(await residencyEvents(), [{ supported: true, requested: true, level: 'on-demand', reason: 'resident_not_granted' }])
    assert.equal((await must('backend.residency')).reason, 'resident_not_granted')
    assert.equal((await must('backend.info')).residency.reason, 'resident_not_granted')
    core.apply(DOWNGRADED_NOT_GRANTED)
    core.apply(DOWNGRADED_BUDGET)
    core.push(DOWNGRADED_FUTURE_REASON)
    core.apply(RESIDENT)
    assert.deepEqual((await residencyEvents()).map((p) => `${p.level}/${p.reason}`), ['on-demand/resident_budget_exceeded', `on-demand/${FUTURE_REASON_CODE}`, 'resident/null'])
  } finally { await backend.dispose() }
  assert.equal(core.listeners(), 0, 'dispose unsubscribed from context.residency')
  rmSync(dataDir, { recursive: true, force: true })
})

test('no keep-alive: after a downgrade the backend makes no host call, does not read current() again and starts no timer — Core only restarts its idle timer, the process just goes on', async () => {
  const dataDir = tempData('keepalive')
  const line = fakeLine()
  const ai = createMockTuqAi({ reply: (ctx) => fenced(answer(ctx.user)) })
  const core = createResidencyStandin({ mode: 'present', initial: RESIDENT })
  const { backend, call, must } = await startBackend({ dataDir, line, ai, residency: core.api })
  const hostCalls = () => ({ completes: ai.stats.completes, options: ai.stats.getOptions, sessions: ai.stats.openSessions, current: core.stats.currentCalls, subscribes: core.stats.subscribes })
  try {
    line.emit(raw(1, '請幫我寄報價單給客戶'))
    await call('pipeline.runOnce')
    await until(async () => (await must('ai.status')).counters.extracted === 1, { message: 'one extraction before the downgrade' })
    const session = await must('events.open', {})
    core.apply(DOWNGRADED_NOT_GRANTED)
    await must('events.pull', { sessionId: session.sessionId, afterSeq: session.seq, waitMs: 200 })
    const timersBefore = (process.getActiveResourcesInfo().filter((n) => n === 'Timeout')).length
    const before = hostCalls()
    await sleep(900) // the worker's backup poll is 40 ms here: it ran ~20 times in this window
    assert.deepEqual(hostCalls(), before, 'nothing was asked of the host (or of context.residency) after the downgrade')
    assert.equal(before.current, 1, 'current() was read exactly once, at start')
    assert.equal(before.subscribes, 1)
    assert.ok(process.getActiveResourcesInfo().filter((n) => n === 'Timeout').length <= timersBefore, 'no timer was started by the downgrade')
    assert.equal((await must('backend.residency')).level, 'on-demand')
    // and the plugin still works: a downgrade is not an error and not a stop
    line.emit(raw(3, '請明天提醒我繳費', { chatId: 'u-bob', chat: 'Bob' }))
    await call('pipeline.runOnce')
    await until(async () => (await must('ai.status')).counters.extracted === 2, { message: 'work continues after the downgrade' })
  } finally { await backend.dispose() }
  rmSync(dataDir, { recursive: true, force: true })
})

test('re-fork (Core stops the backend after 24 hours and starts it again on the same data): processed work is not redone, unprocessed work is done once, replayed LINE messages are not duplicated', async () => {
  const dataDir = tempData('refork')
  try {
    // first life: m1+m2 extracted; then a message arrives whose AI call is never answered before the stop
    const lineA = fakeLine()
    const aiA = createMockTuqAi({ reply: (ctx) => (JSON.parse(ctx.user).newMessages[0].msgId === 'i:m3' ? new Promise(() => undefined) : fenced(answer(ctx.user))) })
    const coreA = createResidencyStandin({ mode: 'present', initial: RESIDENT })
    const a = await startBackend({ dataDir, line: lineA, ai: aiA, residency: coreA.api })
    lineA.emit(raw(1, '請幫我寄報價單給客戶'))
    lineA.emit(raw(2, '下午三點開會，記得帶合約'))
    await a.call('pipeline.runOnce')
    await until(async () => (await a.must('db.todos.list')).length === 1, { message: 'first life: the todo' })
    lineA.emit(raw(3, '另外幫我訂會議室', { chatId: 'u-bob', chat: 'Bob' }))
    await a.call('pipeline.runOnce')
    await until(() => aiA.stats.completes === 2, { message: 'first life: the AI call for m3 is outstanding' })
    const first = { todos: await a.must('db.todos.list'), messages: await a.must('db.messages.list', { limit: 100 }) }
    assert.equal(first.messages.length, 3)
    assert.deepEqual(first.messages.map((m) => [m.msgId, m.processed]).sort(), [['i:m1', true], ['i:m2', true], ['i:m3', false]])
    await a.backend.dispose()
    assert.equal(existsSync(join(dataDir, '.line-todo-owner.lock')), false, 'a clean stop releases the owner lock')

    // second life: LINE replays everything it still has (the watcher re-reads its window), plus one new message
    const lineB = fakeLine()
    const aiB = createMockTuqAi({ reply: (ctx) => fenced(answer(ctx.user)) })
    const coreB = createResidencyStandin({ mode: 'present', initial: RESIDENT })
    const b = await startBackend({ dataDir, line: lineB, ai: aiB, residency: coreB.api })
    try {
      assert.deepEqual((await b.must('backend.residency')).level, 'resident', 'Core hands the new life its current residency')
      assert.equal((await b.must('db.todos.list')).length, 1, 'the earlier todo is still there')
      for (const message of [raw(1, '請幫我寄報價單給客戶'), raw(2, '下午三點開會，記得帶合約'), raw(3, '另外幫我訂會議室', { chatId: 'u-bob', chat: 'Bob' }), raw(4, '還有，週五要交報告', { chatId: 'u-bob', chat: 'Bob' })]) lineB.emit(message)
      await b.call('pipeline.runOnce')
      await until(async () => (await b.must('db.todos.list')).length === 2, { message: 'second life: the unprocessed chat is done' })
      await sleep(200)
      const messages = await b.must('db.messages.list', { limit: 100 })
      assert.deepEqual(messages.map((m) => m.msgId).sort(), ['i:m1', 'i:m2', 'i:m3', 'i:m4'], 'replayed messages did not create duplicates')
      assert.ok(messages.every((m) => m.processed))
      const turns = aiB.stats.turns.map((t) => JSON.parse(t.text).newMessages.map((m) => m.msgId))
      assert.deepEqual(turns, [['i:m3', 'i:m4']], 'only the work that was not done is sent to the AI — once')
      assert.equal((await b.must('db.todos.list')).filter((t) => t.title === first.todos[0].title).length, 1, 'the first life\'s todo is not duplicated')
    } finally { await b.backend.dispose() }
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})

test('crash restart (SIGKILL with an AI call outstanding, no dispose): the stale owner lock is taken over, nothing already stored is lost, and the unfinished work is done exactly once', async () => {
  const dataDir = tempData('crash')
  const child = spawn(process.execPath, ['--experimental-strip-types', '--experimental-loader=./scripts/ts-test-loader.mjs', join('scripts', 'plugin', 'fixtures', 'residency-crash-child.mjs'), dataDir], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })
  const exited = new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })))
  try {
    await until(() => /READY /.test(stdout) || child.exitCode !== null, { timeout: 60_000, message: `the child to be ready (stderr: ${stderr.slice(0, 500)})` })
    const ready = JSON.parse(stdout.split('\n').find((l) => l.startsWith('READY ')).slice('READY '.length))
    assert.equal(ready.leased, true, 'the child had an AI call outstanding')
    assert.equal(ready.messages, 2)
    assert.equal(ready.processed, 0)
    assert.equal(ready.extract.leased, 1, 'a lease was out (lives in memory only)')
    child.kill('SIGKILL')
    const end = await exited
    assert.equal(end.signal, 'SIGKILL', 'killed, not stopped')
    const lock = join(dataDir, '.line-todo-owner.lock')
    assert.equal(existsSync(lock), true, 'a killed backend leaves its owner lock behind')
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, ready.pid)

    // Core restarts the backend (crash restart, D:445)
    const line = fakeLine()
    const ai = createMockTuqAi({ reply: (ctx) => fenced(answer(ctx.user)) })
    const core = createResidencyStandin({ mode: 'present', initial: DOWNGRADED_BUDGET })
    const { backend, call, must } = await startBackend({ dataDir, line, ai, residency: core.api })
    try {
      assert.equal((await must('backend.residency')).reason, 'resident_budget_exceeded', 'the restarted backend starts from whatever Core says now')
      assert.equal((await must('db.messages.list', { limit: 100 })).length, 2, 'what the dead backend stored is still there')
      assert.equal((await must('db.todos.list')).length, 0)
      await call('pipeline.runOnce')
      await until(async () => (await must('db.todos.list')).length === 1, { message: 'the unfinished work is done' })
      await sleep(250)
      assert.equal((await must('db.todos.list')).length, 1, 'exactly one todo')
      assert.deepEqual(ai.stats.turns.map((t) => JSON.parse(t.text).newMessages.map((m) => m.msgId)), [['i:m1', 'i:m2']], 'one AI turn with both messages: the dead lease did not block them and was not counted twice')
      assert.ok((await must('db.messages.list', { limit: 100 })).every((m) => m.processed))
    } finally { await backend.dispose() }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ───────────── the screen ─────────────

/** the real backend behind the Core 1.7.1 invoke gate, the real adapter with its event long poll, and a Core residency we drive */
async function withBoard(initial, body) {
  const dataDir = tempData('board')
  const line = fakeLine()
  const ai = createMockTuqAi({ reply: () => fenced({ importance: 'noise', newTodos: [], resolved: [], updates: [] }) })
  const core = createResidencyStandin({ mode: initial === undefined ? 'absent' : 'present', initial })
  const { backend } = await startBackend({ dataDir, line, ai, residency: initial === undefined ? undefined : core.api })
  const gate = createCoreGateStandin(backend, { methods: [...ui.BACKEND_METHOD_GROUPS] })
  // the board's adapter has the event long poll; the settings view's adapter does not (src/plugin/ui/settings.tsx: one call at a time, no events)
  const api = ui.createPluginLineTodoApi({ host: { ...gate.host }, events: { waitMs: 80, minLoopMs: 5, idleStopMs: 20 }, busyRetry: { attempts: 0 } })
  const settingsApi = ui.createPluginLineTodoApi({ host: { ...gate.host }, maxConcurrentCalls: 1, events: { enabled: false }, busyRetry: { attempts: 0 } })
  try { await body({ api, settingsApi, core, gate, backend }) } finally { api.dispose(); settingsApi.dispose(); await backend.dispose(); rmSync(dataDir, { recursive: true, force: true }) }
}
const sourceOf = (api) => api.plugin

test('onChange reaches the screen: Core downgrades -> the board\'s status line changes from "背景執行中" to the reason; a second downgrade code, an unknown code and the switch being turned on again follow; the settings notice shows the same facts', async () => {
  await withBoard(RESIDENT, async ({ api, settingsApi, core }) => {
    const bar = ui.mount(ui.residencyBarScene(sourceOf(api)))
    const notice = ui.mount(ui.residencyNoticeScene(sourceOf(settingsApi)))
    try {
      await until(() => textOf(bar.container).includes(EXPECTED_RESIDENCY_TEXT.resident.bar), { message: 'the resident line' })
      assert.equal(barOf(bar.container).getAttribute('data-residency-level'), 'resident')
      await until(() => textOf(notice.container).includes(EXPECTED_RESIDENCY_TEXT.resident.detail), { message: 'the resident notice' })

      core.apply(DOWNGRADED_NOT_GRANTED)
      await until(() => textOf(bar.container).includes(EXPECTED_RESIDENCY_TEXT.resident_not_granted.bar), { message: 'the not-granted line (no polling: the event brought it)' })
      assert.ok(!textOf(bar.container).includes('背景執行中'))
      assert.equal(barOf(bar.container).getAttribute('data-residency-reason'), 'resident_not_granted')

      core.apply(DOWNGRADED_BUDGET)
      await until(() => textOf(bar.container).includes(EXPECTED_RESIDENCY_TEXT.resident_budget_exceeded.bar), { message: 'a second reason code' })

      core.push(DOWNGRADED_FUTURE_REASON)
      await until(() => textOf(bar.container).includes(EXPECTED_RESIDENCY_UNKNOWN_REASON.bar), { message: 'an unknown reason code gets the generic sentence' })

      core.apply(RESIDENT)
      await until(() => textOf(bar.container).includes(EXPECTED_RESIDENCY_TEXT.resident.bar), { message: 'back to resident' })

      // the settings view has no event long poll (its call budget is 1): it reads again on focus / visible / the button
      core.apply(DOWNGRADED_NOT_GRANTED)
      assert.ok(textOf(notice.container).includes(EXPECTED_RESIDENCY_TEXT.resident.detail), 'no event in this view: unchanged until it reads again')
      const button = byText(notice.container, '重新檢查', 'button')
      assert.ok(button, 'the notice has a 重新檢查 button')
      reactProps(button).onClick({ target: button })
      await until(() => textOf(notice.container).includes(EXPECTED_RESIDENCY_TEXT.resident_not_granted.detail), { message: 'the notice after 重新檢查' })
      const root = byAttr(notice.container, 'data-testid', 'residency-notice')
      assert.equal(root.getAttribute('data-residency-reason'), 'resident_not_granted')
      assert.equal(root.getAttribute('class'), 'set-notice', 'the switch simply being off is a plain notice, not a warning')
    } finally { bar.unmount(); notice.unmount() }
  })
})

test('screen: an old Core shows nothing anywhere; a Core that has the feature but no request shows nothing on the board and one explaining sentence on the settings page', async () => {
  await withBoard(undefined, async ({ api, settingsApi }) => {
    const bar = ui.mount(ui.residencyBarScene(sourceOf(api)))
    const notice = ui.mount(ui.residencyNoticeScene(sourceOf(settingsApi)))
    try {
      assert.deepEqual(await api.plugin.residency(), RESIDENCY_UNSUPPORTED)
      await sleep(150)
      assert.equal(textOf(bar.container), '')
      assert.equal(textOf(notice.container), '')
    } finally { bar.unmount(); notice.unmount() }
  })
  await withBoard(UNREQUESTED, async ({ api, settingsApi }) => {
    const bar = ui.mount(ui.residencyBarScene(sourceOf(api)))
    const notice = ui.mount(ui.residencyNoticeScene(sourceOf(settingsApi)))
    try {
      await until(() => textOf(notice.container).includes(EXPECTED_RESIDENCY_TEXT.notRequested.detail), { message: 'the settings sentence' })
      assert.equal(textOf(bar.container), '', 'the board shows nothing for a plugin that did not ask')
    } finally { bar.unmount(); notice.unmount() }
  })
})

test('screen: while the backend cannot be reached the residency lines are hidden (the connection bars explain that), and the settings view re-reads on focus and when it becomes visible, but never while hidden', async () => {
  const snapshots = [{ supported: true, requested: true, level: 'resident', reason: null }, { supported: true, requested: true, level: 'on-demand', reason: 'resident_not_granted' }]
  let asked = 0
  let link = { state: 'ok', code: null }
  const linkListeners = new Set()
  const source = {
    residency: async () => snapshots[Math.min(asked++, snapshots.length - 1)],
    onResidency: () => () => undefined,
    backendLink: () => link,
    onBackendLink: (l) => { linkListeners.add(l); return () => linkListeners.delete(l) },
  }
  const focusListeners = new Set()
  const realAdd = dom.window.addEventListener
  const realRemove = dom.window.removeEventListener
  dom.window.addEventListener = (type, l) => { if (type === 'focus') focusListeners.add(l) }
  dom.window.removeEventListener = (type, l) => { if (type === 'focus') focusListeners.delete(l) }
  const notice = ui.mount(ui.residencyNoticeScene(source))
  try {
    await until(() => textOf(notice.container).includes(EXPECTED_RESIDENCY_TEXT.resident.bar), { message: 'first read' })
    assert.equal(asked, 1)
    assert.equal(focusListeners.size, 1, 'listens for window focus')
    dom.document.visibilityState = 'hidden'
    for (const l of [...(dom.document.listeners.get('visibilitychange') ?? [])]) l({ type: 'visibilitychange' })
    await sleep(40)
    assert.equal(asked, 1, 'hidden: no read')
    dom.document.visibilityState = 'visible'
    for (const l of [...focusListeners]) l({ type: 'focus' })
    await until(() => textOf(notice.container).includes(EXPECTED_RESIDENCY_TEXT.resident_not_granted.bar), { message: 'read again on focus' })
    assert.equal(asked, 2)
    link = { state: 'revoked', code: 'plugin_permission_denied' }
    for (const l of [...linkListeners]) l(link)
    await until(() => textOf(notice.container) === '', { message: 'hidden while the backend is fenced' })
  } finally { notice.unmount(); dom.window.addEventListener = realAdd; dom.window.removeEventListener = realRemove; delete dom.document.visibilityState }
  assert.equal(focusListeners.size, 0, 'unmount removes the focus listener')
  assert.equal(linkListeners.size, 0)
})

test('screen: a slow read that was started before an event cannot overwrite the newer value the event brought', async () => {
  let release
  const slow = new Promise((resolveSlow) => { release = resolveSlow })
  let emit
  const source = {
    residency: () => slow,
    onResidency: (l) => { emit = l; return () => undefined },
    backendLink: () => ({ state: 'ok', code: null }),
    onBackendLink: () => () => undefined,
  }
  const bar = ui.mount(ui.residencyBarScene(source))
  try {
    await until(() => typeof emit === 'function', { message: 'subscribed' })
    emit({ supported: true, requested: true, level: 'on-demand', reason: 'resident_crash_budget_exhausted' })
    await until(() => textOf(bar.container).includes(EXPECTED_RESIDENCY_TEXT.resident_crash_budget_exhausted.bar), { message: 'the event\'s value' })
    release({ supported: true, requested: true, level: 'resident', reason: null })
    await sleep(60)
    assert.ok(textOf(bar.container).includes(EXPECTED_RESIDENCY_TEXT.resident_crash_budget_exhausted.bar), 'the stale read did not win')
  } finally { bar.unmount() }
})
