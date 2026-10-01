// Phase 3 — createPluginLineTodoApi() (src/renderer/platform/pluginApi.ts) against a mock `window.tuqPlugin`.
//
// The mock host is faithful to the 1.6.8 view bridge (pluginViewBridge.ts:88-95 + backendInvokeContracts.ts): `backend.call(method, params)` validates
// that params are pure JSON (no undefined, finite numbers, arrays <= 4096), request and response are each <= 64 KiB, and rejects with Error(<code>) on host
// failures. Behind it sits the REAL backend (createPluginBackend on a fake LINE port, node:sqlite test adapter) or the real Dispatcher with a fake api,
// so the adapter <-> dispatcher wire format (envelopes, chunks, jobs, event long-poll, unsupported paths) is exercised end to end.
//
// Proves: adapter returns correct values; on* subscriptions receive long-poll events; polling stops after unsubscribe and after dispose;
// unsupported APIs answer an explicit `unsupported_in_plugin` (and the capability flags that hide them in the UI line up with them); media goes through assets.url.
import assert from 'node:assert/strict'
import { createCipheriv, createHmac, hkdfSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createNodeLineFsPort } from '../../src/main/line/engine/nodeLineFsPort.ts'
import { createPluginBackend } from '../../src/plugin/backend/assemble.ts'
import { Dispatcher } from '../../src/plugin/backend/dispatcher.ts'
import { EventHub } from '../../src/plugin/backend/eventHub.ts'
import { CAPABILITY_API_PATHS, PLUGIN_CAPABILITIES, STANDALONE_CAPABILITIES } from '../../src/renderer/platform/capabilities.ts'
import {
  PLUGIN_AI_NOT_CONNECTED, PluginApiError, PluginBackendError, PluginUnsupportedError, createPluginLineTodoApi
} from '../../src/renderer/platform/pluginApi.ts'
import { Limiter, toWire } from '../../src/renderer/platform/pluginTransport.ts'

// ───────────── the mock host ─────────────

const LIMIT = 64 * 1024
const isJson = (value, depth = 0) => {
  if (depth > 40) return false
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 4096 && value.every((v) => isJson(v, depth + 1))
  if (typeof value === 'object') return Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every((v) => isJson(v, depth + 1))
  return false // undefined, function, bigint, symbol
}
const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength

/** `backend`: anything with `call(method, params)`; swap it with `.target` to simulate a restart. */
function makeHost({ target, assetsOrigin = 'tuqplugin://tuqdev.line-todo' }) {
  const state = {
    target, calls: [], inFlight: 0, maxInFlight: 0, failNext: null, hold: null,
    // 'events.pull' can be held to simulate a slow or stalled backend
  }
  const host = {
    backend: {
      async call(method, params) {
        // the view bridge's schema: method regex, JSON params, size limit
        if (!/^[A-Za-z0-9._@-]{1,64}$/.test(method)) throw new Error('backend_invoke_invalid')
        if (!isJson(params)) throw new Error('backend_invoke_invalid')
        if (bytes(params) > LIMIT) throw new Error('backend_invoke_too_large')
        const record = { method, path: params.path, args: params.args }
        state.calls.push(record)
        state.inFlight += 1
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
        try {
          if (state.failNext) { const error = state.failNext; state.failNext = null; throw new Error(error) }
          if (state.hold && params.path === 'events.pull') await state.hold.promise
          const result = await state.target.call(method, JSON.parse(JSON.stringify(params)))
          const wire = JSON.parse(JSON.stringify(result ?? null))
          if (bytes(wire) > LIMIT) throw new Error('backend_invoke_too_large')
          return wire
        } finally { state.inFlight -= 1 }
      }
    },
    assets: { url: (path) => `${assetsOrigin}/data/${String(path).split('/').map(encodeURIComponent).join('/')}` }
  }
  return { host, state, count: (path) => state.calls.filter((c) => c.path === path).length }
}

const FAST_EVENTS = { waitMs: 150, idleStopMs: 30, backoffBaseMs: 10, backoffMaxMs: 40, minLoopMs: 5 }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(predicate, { timeout = 3000, step = 10, message = 'condition' } = {}) {
  const t0 = Date.now()
  while (!predicate()) {
    if (Date.now() - t0 > timeout) assert.fail(`timed out waiting for ${message}`)
    await sleep(step)
  }
}

function raw(i, { chatId = 'u-alice', chat = 'Alice', text, ts } = {}) {
  const t = ts ?? 1_700_000_000_000 + i * 1000
  return { msgId: `m${i}`, chat, chatId, isGroup: false, ts: t, time: new Date(t).toISOString(), direction: 'in', sender: chat, text: text ?? `請幫我處理第 ${i} 件事情，明天要交`, contentType: 0 }
}

function fakeLine() {
  const messageListeners = new Set()
  const statusListeners = new Set()
  let running = false
  const port = {
    start() { running = true }, stop() { running = false },
    status: () => ({ state: running ? 'running' : 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 }),
    onMessage(cb) { messageListeners.add(cb); return () => messageListeners.delete(cb) },
    onStatus(cb) { statusListeners.add(cb); return () => statusListeners.delete(cb) },
    getMessagesSince: async () => []
  }
  return { port, emit: (m) => messageListeners.forEach((cb) => cb(m)) }
}

const okResult = (msgIds, title = '回覆報價單') => ({
  importance: 'action',
  newTodos: [{ bucket: 'todo', title, detail: null, priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds: msgIds.slice(0, 1) }],
  resolved: [], updates: []
})

/** Real backend + adapter. */
async function withBackend(options, body) {
  const dataDir = mkdtempSync(join(tmpdir(), 'plugin-adapter-'))
  const line = fakeLine()
  const backend = await createPluginBackend({ pluginId: 'tuqdev.line-todo', version: '7.7.7', dataDir, line: line.port, extract: { retryBaseMs: 20 }, ...options.backend })
  const mock = makeHost({ target: backend })
  const api = createPluginLineTodoApi({ host: mock.host, events: FAST_EVENTS, ...options.api })
  try { await body({ api, backend, line, mock, dataDir }) } finally {
    api.dispose()
    await backend.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
}

// ───────────── adapter returns correct values ─────────────

test('adapter: request/response methods reach the backend and return its values (messages, chats, todos, settings, pipeline, ping)', async () => {
  await withBackend({}, async ({ api, line }) => {
    assert.equal((await api.ping()).version, '7.7.7')
    assert.equal((await api.line.status()).state, 'running')
    line.emit(raw(1, { text: '請幫我寄報價單給客戶' }))
    line.emit(raw(2, { text: '下午三點開會，記得帶合約' }))
    assert.equal((await api.messages.recent()).length, 2)

    const chats = await api.db.chats.list()
    assert.deepEqual(chats.map((c) => c.chatId), ['u-alice'])
    assert.equal((await api.db.chats.get('u-alice')).name, 'Alice')
    assert.equal(await api.db.chats.get('nobody'), null)
    const messages = await api.db.messages.list({ chatId: 'u-alice' })
    assert.equal(messages.length, 2)
    assert.equal(await api.db.messages.count('u-alice'), 2)
    // trailing undefined arguments are dropped, not turned into null (recentByChat(chatId, limit = 30))
    assert.equal((await api.db.messages.recentByChat('u-alice')).length, 2)
    assert.equal((await api.db.messages.recentByChat('u-alice', 1)).length, 1)
    assert.deepEqual(await api.db.todos.list(), [])

    // the AI-extraction loop through the adapter's extract channel (what the Phase 4 orchestrator will drive)
    const status = await api.pipeline.runOnce()
    assert.equal(status.todosCreated, 0)
    const system = await api.plugin.extract.system()
    assert.ok(system.chars > 1000 && /^[0-9a-f]{64}$/.test(system.sha256))
    const pulled = await api.plugin.extract.pull({ max: 3 })
    assert.equal(pulled.items.length, 1)
    const committed = await api.plugin.extract.commit([{ itemId: pulled.items[0].itemId, ok: true, result: okResult(['m1']) }])
    assert.equal(committed.results[0].status, 'applied')
    const todos = await api.db.todos.list()
    assert.equal(todos.length, 1)
    assert.equal(todos[0].title, '回覆報價單')
    assert.equal((await api.db.todos.updateStatus(todos[0].id, 'done')).status, 'done')
    assert.equal((await api.db.todos.moveColumn(todos[0].id, 'todo')).status, 'pending')
    assert.equal((await api.plugin.info()).plugin, 'tuqdev.line-todo')

    // settings round trip; the plugin build never exposes a key
    const settings = await api.settings.get()
    assert.equal(settings.hasApiKey, true)
    assert.equal(settings.safeStorageAvailable, false)
    assert.equal((await api.settings.update({ pollIntervalSec: 45 })).pollIntervalSec, 45)
    assert.equal(await api.settings.hasSafeStorageKey(), false)
    assert.equal((await api.pipeline.status()).running, true)
    assert.equal(api.driver, undefined, 'no driver_post in the plugin build')
  })
})

test('adapter: failures are typed — in-band backend errors, host errors, malformed envelopes, bad arguments', async () => {
  await withBackend({}, async ({ api, mock }) => {
    await assert.rejects(api.plugin.invoke('no.such.path'), (e) => e instanceof PluginApiError && e.code === 'path_unknown' && e.path === 'no.such.path')
    await assert.rejects(api.plugin.invoke('__proto__'), (e) => e instanceof PluginApiError && e.code === 'path_unknown')
    mock.state.failNext = 'plugin_backend_unavailable'
    await assert.rejects(api.db.chats.list(), (e) => e instanceof PluginBackendError && e.code === 'plugin_backend_unavailable')
    mock.state.failNext = 'backend_invoke_timeout'
    await assert.rejects(api.ping(), (e) => e instanceof PluginBackendError && /timeout/.test(e.message))
    assert.equal((await api.ping()).ok, true, 'the adapter keeps working after a host failure')
    // arguments the host would refuse never leave the view
    const before = mock.state.calls.length
    await assert.rejects(api.plugin.invoke('ping', [10n]), (e) => e.code === 'invalid_args')
    await assert.rejects(api.plugin.invoke('ping', [{ nested: { n: 5n } }]), (e) => e.code === 'invalid_args')
    await assert.rejects(api.plugin.invoke('ping', ['x'.repeat(70_000)]), (e) => e.code === 'request_too_large')
    await assert.rejects(api.plugin.invoke('ping', [1, 2, 3, 4, 5, 6, 7, 8, 9]), (e) => e.code === 'invalid_args')
    assert.equal(mock.state.calls.length, before, 'none of them reached the host')
  })
  // a host that answers with something that is not an envelope
  for (const bad of [null, 'text', 42, [], { value: 1 }, { ok: 'yes' }]) {
    const api = createPluginLineTodoApi({ host: { backend: { call: async () => bad }, assets: { url: String } }, events: FAST_EVENTS })
    await assert.rejects(api.ping(), (e) => e instanceof PluginApiError && e.code === 'bad_response', JSON.stringify(bad))
    api.dispose()
  }
  assert.throws(() => createPluginLineTodoApi({ host: {} }), TypeError)
})

test('adapter: wire format — trailing undefined dropped, JSON round trip, size and count limits, concurrency limiter', async () => {
  assert.deepEqual(toWire('a.b', [1, undefined, undefined]), { path: 'a.b', args: [1] })
  assert.deepEqual(toWire('a.b', [{ x: 1, y: undefined }, undefined]), { path: 'a.b', args: [{ x: 1 }] })
  assert.deepEqual(toWire('a.b', [undefined, 2]), { path: 'a.b', args: [null, 2] })
  const limiter = new Limiter(3)
  let active = 0
  let peak = 0
  await Promise.all(Array.from({ length: 12 }, () => limiter.run(async () => { active += 1; peak = Math.max(peak, active); await sleep(5); active -= 1 })))
  assert.equal(peak, 3)
  assert.deepEqual(limiter.stats(), { active: 0, waiting: 0 })
  // many simultaneous calls from the UI never exceed the cap against a real host (the host rejects more than 8 in flight)
  await withBackend({ api: { maxConcurrentCalls: 4 } }, async ({ api, mock }) => {
    await Promise.all(Array.from({ length: 30 }, () => api.db.chats.list()))
    assert.ok(mock.state.maxInFlight <= 4, `max in flight ${mock.state.maxInFlight}`)
  })
})

test('adapter: a result above the 64 KiB response limit comes back in chunks and is reassembled exactly; a long call becomes a job that is polled to completion', async () => {
  await withBackend({ backend: { dispatcher: { responseBudgetBytes: 3000 } } }, async ({ api, line, mock }) => {
    for (let i = 1; i <= 40; i += 1) line.emit(raw(i, { text: `第 ${i} 則：${'很長的內容'.repeat(30)}` }))
    const all = await api.db.messages.list({ chatId: 'u-alice', limit: 100 })
    assert.equal(all.length, 40)
    assert.ok(all.every((m) => m.text.includes('很長的內容')))
    assert.ok(mock.count('result.chunk') > 3, 'delivered through result.chunk')
    assert.ok(mock.state.calls.every((c) => c.method === 'api.invoke'))
  })
  // a call slower than the soft deadline: the real Dispatcher turns it into a job; the adapter polls job.poll until it is done
  const hub = new EventHub()
  const fakeApi = { pipeline: { runOnce: async () => { await sleep(120); return { runId: 'r1', todosCreated: 2 } } } }
  const dispatcher = new Dispatcher({ getApi: () => fakeApi, hub, queue: { stats: () => ({}) }, softDeadlineMs: 20, maxJobWaitMs: 40 })
  const mock = makeHost({ target: { call: (m, p) => dispatcher.call(m, p) } })
  const api = createPluginLineTodoApi({ host: mock.host, jobPollWaitMs: 30, events: FAST_EVENTS })
  assert.deepEqual(await api.pipeline.runOnce(), { runId: 'r1', todosCreated: 2 })
  assert.ok(mock.count('job.poll') >= 1, 'polled the job')
  // a job that outlives the view is abandoned cleanly on dispose
  fakeApi.pipeline.runOnce = async () => { await sleep(400); return {} }
  const pending = api.pipeline.runOnce()
  await sleep(60)
  api.dispose()
  await assert.rejects(pending, (e) => e instanceof PluginApiError && e.code === 'disposed')
  dispatcher.dispose()
  hub.dispose()
})

// ───────────── on* subscriptions receive long-poll events ─────────────

test('events: on* subscriptions receive the backend events through the long poll (in order, once, no key material); one session serves every subscriber', async () => {
  await withBackend({}, async ({ api, line, mock }) => {
    const seen = { message: [], persisted: [], run: [], todos: [], status: [], pipelineStatus: [] }
    const offs = [
      api.line.onMessage((m) => seen.message.push(m)),
      api.line.onMessage((m) => seen.message.push({ second: m.msgId })),
      api.db.onMessagesPersisted((e) => seen.persisted.push(e)),
      api.pipeline.onRun((r) => seen.run.push(r)),
      api.pipeline.onTodosChanged((e) => seen.todos.push(e)),
      api.line.onStatus((s) => seen.status.push(s)),
      api.pipeline.onStatus((s) => seen.pipelineStatus.push(s))
    ]
    await until(() => api.plugin.eventsStats().sessionId !== null && mock.count('events.pull') >= 1, { message: 'the poll to start' })
    line.emit(raw(1, { text: '請幫我寄報價單給客戶' }))
    line.emit(raw(2, { text: '下午三點開會，記得帶合約' }))
    await until(() => seen.message.filter((m) => m.msgId).length === 2 && seen.persisted.length >= 1, { message: 'line-message + messages-persisted events' })
    assert.deepEqual(seen.message.filter((m) => m.msgId).map((m) => m.msgId), ['i:m1', 'i:m2'], 'ordered, each once')
    assert.deepEqual(seen.message.filter((m) => m.second).map((m) => m.second), ['i:m1', 'i:m2'], 'a second subscriber to the same event also receives them')
    assert.ok(seen.message.every((m) => !('keyMaterial' in m)))
    assert.equal(seen.persisted.reduce((n, e) => n + e.inserted, 0), 2)

    // a run + an inbox commit produce pipeline-run and todos-changed
    await api.pipeline.runOnce()
    const pulled = await api.plugin.extract.pull({})
    await api.plugin.extract.commit([{ itemId: pulled.items[0].itemId, ok: true, result: okResult(['m1']) }])
    await until(() => seen.todos.some((e) => e.createdIds.length === 1) && seen.run.length >= 2, { message: 'todos-changed and pipeline-run' })
    const created = (await api.db.todos.list()).map((t) => t.id)
    assert.deepEqual(seen.todos.find((e) => e.createdIds.length === 1).createdIds, created)
    // the extract-pending event reaches the orchestrator hook as well
    const pending = []
    const offPending = api.plugin.extract.onPending((info) => pending.push(info))
    line.emit(raw(3, { chatId: 'u-bob', chat: 'Bob', text: '週五前交付設計稿' }))
    await api.pipeline.runOnce()
    await until(() => pending.length >= 1, { message: 'extract-pending' })
    offPending()

    assert.equal(mock.count('events.open'), 1, 'one long-poll session for all subscribers')
    assert.equal(api.plugin.eventsStats().listeners, 7, 'listener bookkeeping')
    for (const off of offs) off()
  })
})

test('events: after the last unsubscribe the poll stops and the session is closed; a new subscriber starts it again', async () => {
  await withBackend({}, async ({ api, line, mock }) => {
    const got = []
    const off = api.line.onMessage((m) => got.push(m.msgId))
    await until(() => mock.count('events.pull') >= 1, { message: 'the first pull' })
    line.emit(raw(1))
    await until(() => got.length === 1, { message: 'the first event' })
    const sessionA = api.plugin.eventsStats().sessionId
    off()
    await until(() => mock.count('events.close') === 1, { message: 'events.close after unsubscribe' })
    assert.equal(mock.state.calls.find((c) => c.path === 'events.close').args[0].sessionId, sessionA)
    await sleep(60)
    const pullsAfterStop = mock.count('events.pull')
    await sleep(250)
    assert.equal(mock.count('events.pull'), pullsAfterStop, 'no more pulls once everyone unsubscribed')
    assert.equal(api.plugin.eventsStats().running, false)
    line.emit(raw(2))
    await sleep(80)
    assert.deepEqual(got, ['i:m1'], 'nothing is delivered to an unsubscribed listener')

    // re-subscribing inside the grace period does not churn the session (React StrictMode mount/unmount/mount)
    const offB = api.line.onMessage((m) => got.push(m.msgId))
    offB()
    const offC = api.line.onMessage((m) => got.push(m.msgId))
    await sleep(120)
    assert.equal(mock.count('events.open'), 2, 'one new session for the new subscription, not one per mount')
    assert.equal(api.plugin.eventsStats().running, true)
    line.emit(raw(3))
    await until(() => got.includes('i:m3'), { message: 'an event on the restarted poll' })
    offC()
  })
})

test('events: dispose stops the polling for good — the session is closed once, no pull is sent afterwards, nothing is delivered, later requests reject', async () => {
  await withBackend({ api: { events: { ...FAST_EVENTS, waitMs: 400, idleStopMs: 1000 } } }, async ({ api, backend, line, mock }) => {
    const got = []
    api.line.onMessage((m) => got.push(m.msgId))
    api.pipeline.onTodosChanged(() => got.push('todos'))
    await until(() => mock.count('events.pull') >= 1, { message: 'a long poll in flight' })
    const t0 = Date.now()
    api.dispose()
    // the backend releases the waiting long poll because the session was closed, not after its 400 ms timeout
    await until(() => backend.diagnostics().eventSessions === 0, { timeout: 300, message: 'the backend session to be closed' })
    assert.ok(Date.now() - t0 < 300)
    assert.equal(mock.count('events.close'), 1)
    const pulls = mock.count('events.pull')
    line.emit(raw(1))
    await sleep(500)
    assert.equal(mock.count('events.pull'), pulls, 'no pull after dispose')
    assert.equal(mock.count('events.open'), 1)
    assert.deepEqual(got, [])
    await assert.rejects(api.ping(), (e) => e instanceof PluginApiError && e.code === 'disposed')
    assert.equal(api.line.onMessage(() => undefined)(), undefined, 'subscribing after dispose is a harmless no-op')
    assert.equal(api.plugin.eventsStats().running, false)
    api.dispose() // idempotent
  })
})

test('events: a ring overflow (gap) or a lost session triggers a resync — empty todos-changed / messages-persisted plus fresh status events — and the stream continues', async () => {
  await withBackend({ backend: { hub: { maxEvents: 4 } } }, async ({ api, line, mock }) => {
    const log = []
    api.db.onMessagesPersisted((e) => log.push(['persisted', e.inserted]))
    api.pipeline.onTodosChanged((e) => log.push(['todos', e.createdIds.length]))
    api.pipeline.onStatus((s) => log.push(['pipeline-status', s.running]))
    api.line.onStatus((s) => log.push(['line-status', s.state]))
    const live = []
    api.line.onMessage((m) => live.push(m.msgId))
    await until(() => mock.count('events.pull') >= 1, { message: 'the poll' })
    // stall the poll while a burst rolls the 4-event ring over
    let release
    mock.state.hold = { promise: new Promise((resolve) => { release = resolve }) }
    await sleep(200) // the in-flight pull (waitMs 150) returns; the next one is held
    for (let i = 1; i <= 12; i += 1) line.emit(raw(i))
    log.length = 0
    mock.state.hold = null
    release()
    await until(() => log.some(([k]) => k === 'todos') && log.some(([k]) => k === 'persisted'), { message: 'the resync events' })
    await until(() => log.some(([k]) => k === 'pipeline-status') && log.some(([k]) => k === 'line-status'), { message: 'status re-pulled after the gap' })
    assert.deepEqual(log.find(([k]) => k === 'todos'), ['todos', 0], 'resync todos-changed carries no ids: the board reloads')
    // and later events keep flowing on the same session
    line.emit(raw(99))
    await until(() => live.includes('i:m99'), { message: 'a live event after the resync' })
    assert.equal(mock.count('events.open'), 1, 'a gap does not need a new session')
  })
})

test('events: the backend restarting (session_not_found) reopens the session and resyncs; temporary host failures back off and recover', async () => {
  const dirs = [mkdtempSync(join(tmpdir(), 'plugin-adapter-a-')), mkdtempSync(join(tmpdir(), 'plugin-adapter-b-'))]
  const lineA = fakeLine()
  const lineB = fakeLine()
  const backendA = await createPluginBackend({ pluginId: 'p', version: '1', dataDir: dirs[0], line: lineA.port })
  const mock = makeHost({ target: backendA })
  const diagnostics = []
  const api = createPluginLineTodoApi({ host: mock.host, events: { ...FAST_EVENTS, onDiagnostic: (d) => diagnostics.push(d) } })
  let backendB = null
  try {
    const got = []
    const resyncs = []
    api.line.onMessage((m) => got.push(m.msgId))
    api.pipeline.onTodosChanged((e) => resyncs.push(e.createdIds.length))
    await until(() => mock.count('events.pull') >= 1, { message: 'the poll' })
    lineA.emit(raw(1))
    await until(() => got.length === 1, { message: 'event from backend A' })

    // a host-level outage: calls reject with the host's error code; the pump backs off and retries
    mock.state.failNext = 'plugin_backend_crashed'
    await until(() => diagnostics.some((d) => d.kind === 'error'), { message: 'the outage to be noticed' })

    // the backend is replaced (crash + restart): the old session id is unknown to the new instance
    backendB = await createPluginBackend({ pluginId: 'p', version: '2', dataDir: dirs[1], line: lineB.port })
    mock.state.target = backendB
    await backendA.dispose()
    await until(() => diagnostics.some((d) => d.kind === 'reopen'), { message: 'the session to be reopened' })
    await until(() => mock.count('events.open') >= 2, { message: 'a new session' })
    await until(() => resyncs.length >= 1, { message: 'the resync after the restart' })
    lineB.emit(raw(2))
    await until(() => got.includes('i:m2'), { message: 'an event from backend B' })
    assert.equal((await api.ping()).version, '2', 'requests go to the new backend')
  } finally {
    api.dispose()
    await backendA.dispose().catch(() => undefined)
    await backendB?.dispose()
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  }
})

// ───────────── unsupported in the plugin build ─────────────

test('unsupported: driver is absent; CLI / endpoint / key / saveAs / open / data folder / original chat answer an explicit unsupported_in_plugin, and the UI capability flags that hide them line up', async () => {
  await withBackend({}, async ({ api, mock }) => {
    assert.equal(api.driver, undefined)
    const explicit = (r) => {
      assert.equal(r.ok ?? false, false)
      assert.match(String(r.error ?? r.summary), /^unsupported_in_plugin/)
    }
    explicit(await api.media.open('i:m1'))
    explicit(await api.media.saveAs('i:m1'))
    explicit(await api.db.chats.openOriginal('u-alice'))
    explicit(await api.pipeline.testQwen())
    explicit(await api.pipeline.testAiProvider())
    explicit(await api.settings.setApiKey('sk-secret'))
    assert.deepEqual(await api.settings.clearApiKey(), { ok: false })
    assert.deepEqual(await api.app.openDataFolder(), { ok: false })
    // the secret key never reached the backend as anything but a refused call (the backend ignores it)
    assert.equal((await api.settings.get()).apiKeySource, 'none')

    // the raw channel throws a typed error; AI paths say that ui_ai_chat takes over
    await assert.rejects(api.plugin.invoke('driver.postDraft', [{ todoId: 'x', text: 'y' }]), (e) => e instanceof PluginUnsupportedError && e.code === 'unsupported_in_plugin' && /driver_post|填入 LINE/.test(e.detail))
    await assert.rejects(api.plugin.invoke('db.todos.draftReply', ['t1']), (e) => e instanceof PluginUnsupportedError && e.route === 'ui_ai_chat')
    await assert.rejects(api.plugin.invoke('groupTopics.analyze', ['c1']), (e) => e instanceof PluginUnsupportedError && e.route === 'ui_ai_chat')

    // every capability that the plugin turns off maps to API paths the backend refuses (or to `driver`, which the adapter omits)
    const off = Object.entries(PLUGIN_CAPABILITIES).filter(([key, value]) => key !== 'host' && value === false).map(([key]) => key)
    assert.deepEqual(off.sort(), ['aiProviderSelection', 'apiKey', 'customAiEndpoint', 'driverPost', 'extractConcurrency', 'mediaFileActions', 'openAtLogin', 'openDataFolder', 'openOriginalChat', 'settingsTab'])
    for (const [capability, paths] of Object.entries(CAPABILITY_API_PATHS)) {
      assert.equal(PLUGIN_CAPABILITIES[capability], false, `${capability} is off in the plugin`)
      assert.equal(STANDALONE_CAPABILITIES[capability], true, `${capability} stays on in standalone`)
      for (const path of paths) {
        if (path === 'driver') { assert.equal(api.driver, undefined); continue }
        await assert.rejects(api.plugin.invoke(path, ['x']), (e) => e instanceof PluginUnsupportedError, `${capability}: ${path}`)
      }
    }
    assert.ok(Object.values(STANDALONE_CAPABILITIES).every((v) => v === true || v === 'standalone'), 'standalone keeps everything on')
    assert.equal(mock.count('driver.postDraft'), 1)
  })
})

test('AI seam: without an ai:chat port draftReply / analyzeNotMine / group analysis fail explicitly (never fake success); a Phase 4 port plugs in', async () => {
  await withBackend({}, async ({ api, mock }) => {
    assert.deepEqual(await api.db.todos.draftReply('t1'), { error: PLUGIN_AI_NOT_CONNECTED })
    assert.equal((await api.db.todos.analyzeNotMine('f1')).ok, false)
    assert.equal((await api.groupTopics.analyze('c1')).ok, false)
    assert.equal(mock.count('db.todos.draftReply'), 0, 'AI work is not sent to a backend that has no LLM')
  })
  const calls = []
  const ai = {
    draftReply: async (id) => { calls.push(['draft', id]); return { draft: '好的，我明天回覆您' } },
    analyzeNotMine: async (id) => { calls.push(['not-mine', id]); return { ok: true, summary: 's' } },
    analyzeGroupTopics: async (id) => { calls.push(['topics', id]); return { ok: true, count: 1, analyzedCount: 1 } }
  }
  await withBackend({ api: { ai } }, async ({ api }) => {
    assert.equal((await api.db.todos.draftReply('t1')).draft, '好的，我明天回覆您')
    assert.equal((await api.db.todos.analyzeNotMine('f1')).ok, true)
    assert.equal((await api.groupTopics.analyze('c1')).count, 1)
    assert.deepEqual(calls, [['draft', 't1'], ['not-mine', 'f1'], ['topics', 'c1']])
  })
})

// ───────────── media through assets.url ─────────────

const IKM_B64 = Buffer.alloc(32, 7).toString('base64')
function makeEimg(plain) {
  const derived = Buffer.from(hkdfSync('sha256', Buffer.from(IKM_B64, 'base64'), Buffer.alloc(32, 0), Buffer.from('FileEncryption'), 76))
  const nonce = Buffer.concat([derived.subarray(64, 76), Buffer.alloc(4, 0)])
  const cipher = createCipheriv('aes-256-ctr', derived.subarray(0, 32), nonce)
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([ciphertext, createHmac('sha256', derived.subarray(32, 64)).update(ciphertext).digest()])
}

test('media: assetUrl() asks the backend to decrypt into dataDir and returns the host assets.url for the cached file; failures are null; a hit is not asked twice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-adapter-media-'))
  const cacheDir = join(root, 'LINE', 'Cache')
  mkdirSync(cacheDir, { recursive: true })
  const plain = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1200, 0x41)])
  writeFileSync(join(cacheDir, 'x.eimg'), makeEimg(plain))
  try {
    await withBackend({ backend: { media: { fs: createNodeLineFsPort(), cacheDir } } }, async ({ api, line, mock, dataDir }) => {
      line.emit({ ...raw(1, { text: '[image]' }), contentType: 1, keyMaterial: IKM_B64, fileSize: plain.length, fileName: null })
      line.emit({ ...raw(2, { text: '[image]' }), contentType: 1, keyMaterial: IKM_B64, fileSize: 77, fileName: null }) // never downloaded
      const url = await api.media.assetUrl('i:m1')
      assert.match(url, /^tuqplugin:\/\/tuqdev\.line-todo\/data\/media-cache\/[0-9a-f]{32}\.png$/)
      assert.ok(existsSync(join(dataDir, 'media-cache', url.split('/').pop())), 'the file the URL points at is in dataDir')
      assert.equal(await api.media.assetUrl('i:m1'), url)
      assert.equal(mock.count('media.prepare'), 1, 'the second lookup is served from the adapter cache')
      assert.equal(await api.media.assetUrl('i:m2'), null, 'not downloaded in LINE yet -> null (the UI shows 尚未下載)')
      assert.equal(await api.media.assetUrl('i:nope'), null)
    })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('review: without a UI extraction orchestrator reviewLastDays answers "not connected" at once (it would otherwise wait 15 minutes for results nobody sends); with one it rides the job + extract channel to the end', async () => {
  await withBackend({}, async ({ api, mock }) => {
    const t0 = Date.now()
    const review = await api.pipeline.reviewLastDays(3)
    assert.ok(Date.now() - t0 < 200)
    assert.equal(review.ok, false)
    assert.equal(review.hasApiKey, true, 'the UI must not tell the user to enter an API key')
    assert.equal(review.days, 3)
    assert.equal(review.note, PLUGIN_AI_NOT_CONNECTED)
    assert.equal(mock.count('pipeline.reviewLastDays'), 0, 'the backend was not asked')
  })
  const dataDir = mkdtempSync(join(tmpdir(), 'plugin-adapter-review-'))
  const line = fakeLine()
  line.port.getMessagesSince = async () => [raw(1, { text: '提醒我週五前交付報告', ts: Date.now() - 1000 }), raw(2, { text: '另外發票也要開', ts: Date.now() - 500 })]
  const backend = await createPluginBackend({ pluginId: 'p', version: '1', dataDir, line: line.port, dispatcher: { softDeadlineMs: 30, maxJobWaitMs: 200 } })
  const mock = makeHost({ target: backend })
  const api = createPluginLineTodoApi({ host: mock.host, extractionConnected: true, jobPollWaitMs: 100, events: FAST_EVENTS })
  try {
    let result = null
    const review = api.pipeline.reviewLastDays(7).then((r) => { result = r })
    // what the Phase 4 orchestrator will do: pull work, answer with validated JSON, until the review is done
    await sleep(90) // the UI is slower than the backend's 30 ms soft deadline, so the call turns into a job
    for (let i = 0; i < 100 && !result; i += 1) {
      const pulled = await api.plugin.extract.pull({})
      for (const item of pulled.items) await api.plugin.extract.commit([{ itemId: item.itemId, ok: true, result: okResult(['m1'], '交付週五報告') }])
      await sleep(20)
    }
    await review
    assert.equal(result.ok, true)
    assert.equal(result.todosCreated, 1)
    assert.ok(mock.count('job.poll') >= 1, 'the long review became a job')
    assert.deepEqual((await api.db.todos.list()).map((t) => t.title), ['交付週五報告'])
  } finally {
    api.dispose()
    await backend.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
