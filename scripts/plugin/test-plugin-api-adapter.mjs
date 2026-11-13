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
  PluginApiError, PluginBackendError, PluginUnsupportedError, createPluginLineTodoApi
} from '../../src/renderer/platform/pluginApi.ts'
import { createMockTuqAi } from '../lib/mock-tuq-ai.mjs'
import { CallCancelledError, Limiter, laneFor, toWire } from '../../src/renderer/platform/pluginTransport.ts'
import { describeLink } from '../../src/plugin/ui/backendLink.ts'
import { bootBoard } from '../../src/plugin/ui/board.ts'
import { describeBackendError } from '../../src/renderer/lib/backendError.ts'
import { RESOURCES } from './lib/manifest.mjs'
import { backendMethodFor } from '../../src/shared/pluginWire.ts'

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

test('adapter forwards optional visible draft and nature while preserving the legacy four argument wire shape', async () => {
  const calls = []
  const api = createPluginLineTodoApi({ host: { backend: { call: async (_method, params) => { calls.push(params); return { ok: true, value: { kind: 'todo' } } } }, assets: { url: String } }, events: { enabled: false }, busyRetry: { attempts: 0 } })
  try {
    await api.hostAi.profiles.suggestRule('synthetic-chat', 'todo', 'goal', 'revision', { draftRule: 'visible draft', natureId: 'time_schedule' })
    await api.hostAi.profiles.suggestRule('synthetic-chat', 'topic', 'goal', 'revision')
    assert.deepEqual(calls.map(call => call.args[0]), [
      { chatId: 'synthetic-chat', kind: 'todo', goal: 'goal', expectedProfileRevision: 'revision', draftRule: 'visible draft', natureId: 'time_schedule' },
      { chatId: 'synthetic-chat', kind: 'topic', goal: 'goal', expectedProfileRevision: 'revision' }
    ])
  } finally { api.dispose() }
})

/**
 * `backend`: anything with `call(method, params)`; swap it with `.target` to simulate a restart.
 *
 * Busy semantics are the real 1.6.8 ones (review F1): the backend controller refuses a call when the calls already being handled reach the manifest's
 * `resources.maxSessions` (backendController.ts:395, `BackendError('plugin_backend_busy')`); `maxSessions` defaults to the value in the plugin manifest
 * (scripts/plugin/lib/manifest.mjs), not to a made-up number. `busyCode` is what the VIEW sees: the invoke gate turns the controller's busy error into
 * `plugin_backend_unavailable` (backendInvokeGate.ts:156-160), so tests run both spellings. `state.busyRejections` counts the refusals.
 */
function makeHost({ target, assetsOrigin = 'tuqplugin://tuqdev.line-todo', maxSessions = RESOURCES.maxSessions, busyCode = 'plugin_backend_busy' }) {
  const state = {
    target, calls: [], inFlight: 0, maxInFlight: 0, busyRejections: 0, maxSessions, failNext: null, hold: null,
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
        if (state.inFlight >= state.maxSessions) { state.busyRejections += 1; throw new Error(busyCode) }
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
  // Default times sit a few days before the wall clock so the 7-day extract window (measured from the live clock) includes them.
  const t = ts ?? Date.now() - 3 * 86_400_000 + i * 1000
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
  newTodos: [{ draftRef:`draft_${String(msgIds[0]??'none').replace(/[^a-z0-9_-]/giu,'_')}`, bucket: 'todo', title, detail: null, priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds: msgIds.slice(0, 1) }],
  identityDecisions: msgIds.length ? [{draftRef:`draft_${String(msgIds[0]).replace(/[^a-z0-9_-]/giu,'_')}`,outcome:'new',candidateType:null,candidateId:null,relationKind:null,reasonCode:'insufficient_evidence',confidenceBand:'high',evidenceMsgIds:msgIds.slice(0,1)}] : [],
  resolved: [], updates: []
})

const fenced = (value) => '```json\n' + JSON.stringify(value) + '\n```'
/** The model: an extraction prompt gets one todo citing the first message of the payload; a draft prompt gets a draft. */
const defaultReply = (ctx) => (ctx.system.includes('草擬') ? '好的，我明天回覆您' : fenced(okResult([JSON.parse(ctx.user).newMessages[0].msgId])))
const asyncUntil = async (probe, { timeout = 4000, step = 10, message = 'condition' } = {}) => {
  const t0 = Date.now()
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() - t0 > timeout) assert.fail(`timed out waiting for ${message}`)
    await sleep(step)
  }
}

/** Real backend (with a mock `context.host.ai` — the backend answers its own extraction since 0.2.0) + adapter. */
async function withBackend(options, body) {
  const dataDir = mkdtempSync(join(tmpdir(), 'plugin-adapter-'))
  const line = fakeLine()
  const ai = createMockTuqAi({ reply: options.reply ?? defaultReply })
  options.setup?.(ai)
  const backend = await createPluginBackend({
    pluginId: 'tuqdev.line-todo', version: '7.7.7', dataDir, line: line.port, extract: { retryBaseMs: 20 },
    hostAi: ai.ai, ai: { config: { optionsTtlMs: 20, providerRetryMs: 100 }, worker: { pollIntervalMs: 40, unavailableRetryMs: 30 } }, ...options.backend
  })
  const mock = makeHost({ target: backend, ...options.host })
  const api = createPluginLineTodoApi({ host: mock.host, events: FAST_EVENTS, ...options.api })
  try { await body({ api, backend, line, mock, dataDir, ai }) } finally {
    api.dispose()
    await backend.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
}

// ───────────── adapter returns correct values ─────────────

test('adapter: request/response methods reach the backend and return its values (messages, chats, todos, settings, pipeline, ping)', async () => {
  await withBackend({}, async ({ api, line, mock }) => {
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

    // the AI extraction loop: the pipeline supplies, the backend's own worker answers through host.ai.complete (the view only reads)
    const status = await api.pipeline.runOnce()
    assert.equal(status.todosCreated, 0)
    const todos = await asyncUntil(async () => { const list = await api.db.todos.list(); return list.length === 1 ? list : null }, { message: 'the worker to create the todo' })
    assert.equal((await api.plugin.extract.stats()).pending, 0)
    assert.equal((await api.plugin.aiStatus()).counters.extracted, 1)
    assert.equal(mock.count('extract.pull') + mock.count('extract.commit') + mock.count('extract.system'), 0, 'no extraction RPC from the view')
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

test('A16 adapter: the chat-list methods map to the db.chats paths with exact args; only listPrefs is replay-safe', async () => {
  const calls = []
  const prefs = { prefsReady: true, topicsAvailable: true, pinned: ['u-alice'], hidden: [], todoOff: [], topicsOn: [] }
  const target = { async call(method, request) {
    calls.push({ method, path: request.path, args: request.args })
    const values = {
      'db.chats.listPrefs': prefs,
      'db.chats.setPinned': { ok: true, pinned: true },
      'db.chats.setIgnored': { ok: true, ignored: true, skippedOlder: 0 },
      'db.chats.setHidden': { ok: true, hidden: false }
    }
    return { ok: true, value: values[request.path] }
  } }
  const mock = makeHost({ target })
  const api = createPluginLineTodoApi({ host: mock.host, events: { enabled: false } })
  try {
    assert.deepEqual(await api.db.chats.listPrefs(), prefs)
    assert.deepEqual(await api.db.chats.setPinned('u-alice', true), { ok: true, pinned: true })
    assert.deepEqual(await api.db.chats.setIgnored('u-alice', true), { ok: true, ignored: true, skippedOlder: 0 })
    assert.deepEqual(await api.db.chats.setHidden('u-alice', false), { ok: true, hidden: false })
    assert.deepEqual(calls.map((c) => [c.path, c.args]), [
      ['db.chats.listPrefs', []],
      ['db.chats.setPinned', ['u-alice', true]],
      ['db.chats.setIgnored', ['u-alice', true]],
      ['db.chats.setHidden', ['u-alice', false]]
    ])
    const transport = await import('../../src/renderer/platform/pluginTransport.ts')
    assert.equal(transport.isReplaySafePath('db.chats.listPrefs'), true)
    for (const path of ['db.chats.setPinned', 'db.chats.setIgnored', 'db.chats.setHidden']) assert.equal(transport.isReplaySafePath(path), false, path)
  } finally { api.dispose() }
})

test('A15 adapter: hostAi.chatPrompts and prompts.saveName map to the settings method group with the exact paths and args; the read paths are replay-safe, the write paths are not',async()=>{
  const calls=[]
  const summary={chatId:'u-alice',hasPrompt:true,myName:'阿華',revision:'r1'}
  const target={async call(method,request){
    calls.push({method,path:request.path,args:request.args})
    const values={
      'settings.prompt.saveName':{myName:'王小明',nameRevision:'n2'},
      'settings.chatPrompt.get':{chatId:'u-alice',revision:'r0'},
      'settings.chatPrompt.save':{chatId:'u-alice',revision:'r1'},
      'settings.chatPrompt.reset':{chatId:'u-alice',revision:'r0'},
      'settings.chatPrompt.list':{items:[summary]}
    }
    return {ok:true,value:values[request.path]}
  }}
  const mock=makeHost({target})
  const api=createPluginLineTodoApi({host:mock.host,events:{enabled:false}})
  try{
    assert.equal((await api.hostAi.prompts.saveName('王小明','n1')).nameRevision,'n2')
    assert.equal((await api.hostAi.chatPrompts.get('u-alice')).revision,'r0')
    assert.equal((await api.hostAi.chatPrompts.save('u-alice',{prompt:'P',myName:null},'r0')).revision,'r1')
    assert.equal((await api.hostAi.chatPrompts.reset('u-alice','r1')).revision,'r0')
    assert.deepEqual(await api.hostAi.chatPrompts.list(),[summary],'list unwraps { items }')
    assert.deepEqual(calls,[
      {method:'settings',path:'settings.prompt.saveName',args:[{myName:'王小明',expectedNameRevision:'n1'}]},
      {method:'settings',path:'settings.chatPrompt.get',args:[{chatId:'u-alice'}]},
      {method:'settings',path:'settings.chatPrompt.save',args:[{chatId:'u-alice',prompt:'P',myName:null,expectedRevision:'r0'}]},
      {method:'settings',path:'settings.chatPrompt.reset',args:[{chatId:'u-alice',expectedRevision:'r1'}]},
      {method:'settings',path:'settings.chatPrompt.list',args:[]}
    ])
    const transport=await import('../../src/renderer/platform/pluginTransport.ts')
    for(const path of ['settings.chatPrompt.get','settings.chatPrompt.list'])assert.equal(transport.isReplaySafePath(path),true,path)
    for(const path of ['settings.chatPrompt.save','settings.chatPrompt.reset','settings.prompt.saveName'])assert.equal(transport.isReplaySafePath(path),false,path)
  }finally{api.dispose()}
})

test('adapter: failures are typed — in-band backend errors, host errors, malformed envelopes, bad arguments', async () => {
  await withBackend({}, async ({ api, mock }) => {
    await assert.rejects(api.plugin.invoke('no.such.path'), (e) => e instanceof PluginApiError && e.code === 'path_unknown' && e.path === 'no.such.path')
    await assert.rejects(api.plugin.invoke('__proto__'), (e) => e instanceof PluginApiError && e.code === 'path_unknown')
    mock.state.failNext = 'plugin_backend_crashed'
    await assert.rejects(api.db.chats.list(), (e) => e instanceof PluginBackendError && e.code === 'plugin_backend_crashed')
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
  // many simultaneous calls from the UI never exceed the cap (an explicit maxConcurrentCalls is honoured)
  await withBackend({ api: { maxConcurrentCalls: 2 } }, async ({ api, mock }) => {
    await Promise.all(Array.from({ length: 30 }, () => api.db.chats.list()))
    assert.ok(mock.state.maxInFlight <= 2, `max in flight ${mock.state.maxInFlight}`)
  })
})

// ───────────── review F1: the UI never exceeds the manifest's maxSessions; a busy answer is retried with backoff ─────────────

/** What a board view does when it opens (status, settings, lists, AI status) plus 10 images — all at once, with the event long poll running. */
async function loadBoardLikeBurst(api) {
  const media = Array.from({ length: 10 }, (_, i) => api.media.assetUrl(`i:m${i}`))
  return Promise.all([
    api.pipeline.status(), api.settings.get(), api.db.todos.list(), api.db.chats.list(), api.line.status(), api.pipeline.loadStats(),
    api.plugin.extract.stats(), api.plugin.aiStatus({ refresh: true }), api.plugin.reviewStatus(), api.plugin.info(),
    ...media
  ])
}

for (const busyCode of ['plugin_backend_busy', 'plugin_backend_unavailable']) {
  test(`F1 (${busyCode}): the fake host judges busy by the manifest maxSessions (${RESOURCES.maxSessions}); a board-like burst with the long poll running never exceeds it and is never refused`, async () => {
    assert.equal(RESOURCES.maxSessions, 4, 'the manifest says 4 (1.6.8 Core limit)')
    await withBackend({ host: { busyCode } }, async ({ api, line, mock }) => {
      assert.equal(mock.state.maxSessions, RESOURCES.maxSessions, 'the fake host takes its limit from the manifest, not from a constant of its own')
      const events = []
      const off = api.line.onMessage((m) => events.push(m.msgId)) // starts the event long poll (it holds one slot of the view's budget)
      await until(() => mock.count('events.pull') >= 1, { message: 'the long poll to start' })
      for (let round = 0; round < 3; round += 1) {
        await loadBoardLikeBurst(api)
        line.emit(raw(round + 1))
      }
      await until(() => events.length === 3, { message: 'events still arrive through the long poll during the bursts' })
      assert.equal(mock.state.busyRejections, 0, 'the host never had to refuse a call')
      assert.ok(mock.state.maxInFlight <= RESOURCES.maxSessions, `max in flight ${mock.state.maxInFlight} <= maxSessions ${RESOURCES.maxSessions}`)
      const transport = api.plugin.transportStats()
      assert.ok(transport.maxActive <= 3, `the board's own budget is 3 (long poll + 2); saw ${transport.maxActive}`)
      assert.equal(transport.busyRetries, 0)
      assert.ok(mock.state.maxInFlight >= 2, 'the burst really ran concurrently (the test is not vacuous)')
      off()
    })
  })
}

test('F1: board view (budget 3, long poll) and settings view (budget 1, no poll) open at the same time against one host: the sum stays within maxSessions', async () => {
  await withBackend({}, async ({ api: board, line, mock }) => {
    const settings = createPluginLineTodoApi({ host: mock.host, maxConcurrentCalls: 1, events: { ...FAST_EVENTS, enabled: false } })
    try {
      const got = []
      board.line.onMessage((m) => got.push(m.msgId))
      settings.pipeline.onStatus(() => got.push('never')) // the settings view subscribes too, but opens no poll
      await until(() => mock.count('events.pull') >= 1, { message: 'the board long poll' })
      for (let round = 0; round < 4; round += 1) {
        await Promise.all([loadBoardLikeBurst(board), Promise.all(Array.from({ length: 8 }, () => settings.settings.get()))])
      }
      line.emit(raw(1))
      await until(() => got.includes('i:m1'), { message: 'the board still gets its events' })
      assert.equal(mock.count('events.open'), 1, 'only the board opened an event session')
      assert.equal(mock.state.busyRejections, 0)
      assert.ok(mock.state.maxInFlight <= RESOURCES.maxSessions, `both views together: max in flight ${mock.state.maxInFlight}`)
      assert.ok(settings.plugin.transportStats().maxActive <= 1)
      assert.deepEqual(got.filter((x) => x === 'never'), [])
    } finally { settings.dispose() }
  })
})

test('F1: the fake host is not vacuous — the old shape (6 concurrent calls, no retry) is refused by a host that applies maxSessions', async () => {
  await withBackend({ api: { maxConcurrentCalls: 6, busyRetry: { attempts: 0 } } }, async ({ api, mock }) => {
    const settled = await Promise.allSettled(Array.from({ length: 10 }, () => api.db.chats.list()))
    assert.ok(mock.state.busyRejections > 0, 'the host refused calls above maxSessions')
    assert.ok(settled.some((r) => r.status === 'rejected' && r.reason instanceof PluginBackendError && r.reason.code === 'plugin_backend_busy'))
  })
})

test('F1: a busy host answer is retried with exponential backoff (the slot is released while waiting); both spellings; bounded; a closed transport stops retrying', async () => {
  for (const busyCode of ['plugin_backend_busy', 'plugin_backend_unavailable']) {
    const delays = []
    const calls = []
    let busyFor = 3
    const host = {
      backend: { call: async (method, params) => { calls.push(params.path); if (busyFor > 0) { busyFor -= 1; throw new Error(busyCode) } return { ok: true, value: params.path } } },
      assets: { url: String }
    }
    const api = createPluginLineTodoApi({ host, events: { ...FAST_EVENTS, enabled: false }, busyRetry: { baseMs: 100, maxMs: 1000, random: () => 0.5, sleep: async (ms) => { delays.push(ms) } } })
    assert.equal(await api.plugin.invoke('ping'), 'ping', `succeeds after the host stops being busy (${busyCode})`)
    assert.deepEqual(delays, [100, 200, 400], 'exponential backoff from 100 ms')
    assert.equal(calls.length, 4)
    assert.equal(api.plugin.transportStats().busyRetries, 3)
    assert.equal(api.plugin.transportStats().active, 0, 'no slot is held after the call')

    // a permanently busy host: bounded retries (4) and then the host code reaches the caller
    delays.length = 0
    busyFor = Infinity
    await assert.rejects(api.plugin.invoke('ping'), (e) => e instanceof PluginBackendError && e.code === busyCode)
    assert.equal(delays.length, 4)
    api.dispose()
  }
  // other host failures are not retried; backoff is capped; closing the transport during a backoff ends the call with 'disposed'
  let n = 0
  const crashed = createPluginLineTodoApi({ host: { backend: { call: async () => { n += 1; throw new Error('plugin_backend_crashed') } }, assets: { url: String } }, events: { enabled: false } })
  await assert.rejects(crashed.plugin.invoke('ping'), (e) => e.code === 'plugin_backend_crashed')
  assert.equal(n, 1, 'a crash is not a busy answer: no retry')
  crashed.dispose()
  const capped = []
  const never = createPluginLineTodoApi({ host: { backend: { call: async () => { throw new Error('plugin_backend_busy') } }, assets: { url: String } }, events: { enabled: false }, busyRetry: { attempts: 6, baseMs: 400, maxMs: 1000, random: () => 0.5, sleep: async (ms) => { capped.push(ms) } } })
  await assert.rejects(never.plugin.invoke('ping'))
  assert.deepEqual(capped, [400, 800, 1000, 1000, 1000, 1000])
  never.dispose()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const closing = createPluginLineTodoApi({ host: { backend: { call: async () => { throw new Error('plugin_backend_busy') } }, assets: { url: String } }, events: { enabled: false }, busyRetry: { sleep: () => gate } })
  const pending = closing.plugin.invoke('ping')
  await sleep(20)
  closing.dispose()
  release()
  await assert.rejects(pending, (e) => e instanceof PluginApiError && e.code === 'disposed')
})

test('F1: a long job (reviewLastDays) does not hold a slot between polls — other requests keep flowing with a budget of 3, long poll included', async () => {
  const hub = new EventHub()
  let finish
  const fakeApi = { pipeline: { runOnce: () => new Promise((resolve) => { finish = resolve }) }, ping: async () => ({ ok: true }) }
  const dispatcher = new Dispatcher({ getApi: () => fakeApi, hub, queue: { stats: () => ({}) }, softDeadlineMs: 20, maxJobWaitMs: 60 })
  const mock = makeHost({ target: { call: (m, p) => dispatcher.call(m, p) } })
  const api = createPluginLineTodoApi({ host: mock.host, jobPollWaitMs: 40, events: FAST_EVENTS })
  try {
    api.line.onMessage(() => undefined) // long poll running
    await until(() => mock.count('events.pull') >= 1, { message: 'the long poll' })
    const job = api.pipeline.runOnce()
    await until(() => mock.count('job.poll') >= 2, { message: 'the job to be polled' })
    for (let i = 0; i < 5; i += 1) assert.equal((await api.ping()).ok, true)
    finish({ runId: 'r', todosCreated: 1 })
    assert.deepEqual(await job, { runId: 'r', todosCreated: 1 })
    assert.equal(mock.state.busyRejections, 0)
    assert.ok(mock.state.maxInFlight <= 3)
  } finally { api.dispose(); dispatcher.dispose(); hub.dispose() }
})

test('adapter: a result above the 64 KiB response limit comes back in chunks and is reassembled exactly; a long call becomes a job that is polled to completion', async () => {
  await withBackend({ backend: { dispatcher: { responseBudgetBytes: 3000 } } }, async ({ api, line, mock }) => {
    for (let i = 1; i <= 40; i += 1) line.emit(raw(i, { text: `第 ${i} 則：${'很長的內容'.repeat(30)}` }))
    const all = await api.db.messages.list({ chatId: 'u-alice', limit: 100 })
    assert.equal(all.length, 40)
    assert.ok(all.every((m) => m.text.includes('很長的內容')))
    assert.ok(mock.count('result.chunk') > 3, 'delivered through result.chunk')
    assert.ok(mock.state.calls.every((c) => c.method === backendMethodFor(c.path)))
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
  await withBackend({}, async ({ api, line, mock, ai }) => {
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

    // a run (the backend's worker answers the supply) produces pipeline-run and todos-changed
    await api.pipeline.runOnce()
    await until(() => seen.todos.some((e) => e.createdIds.length === 1) && seen.run.length >= 2, { message: 'todos-changed and pipeline-run' })
    const created = (await api.db.todos.list()).map((t) => t.id)
    assert.deepEqual(seen.todos.find((e) => e.createdIds.length === 1).createdIds, created)
    // the AI status is an event too (the board's status line)
    const aiEvents = []
    const offAi = api.plugin.onAiStatus((status) => aiEvents.push(status.state))
    ai.control.set({ providerState: 'not_logged_in' })
    await api.plugin.aiStatus({ refresh: true })
    await until(() => aiEvents.includes('unavailable'), { message: 'ai-status event' })
    offAi()

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

    // the raw channel throws a typed error
    // G-07: driver is not a backend method group: the view refuses the path itself (it never reaches the host; Core would refuse it as backend_method_not_allowed)
    await assert.rejects(api.plugin.invoke('driver.postDraft', [{ todoId: 'x', text: 'y' }]), (e) => e instanceof PluginApiError && !(e instanceof PluginUnsupportedError) && e.code === 'path_unknown')
    // the AI features are NOT unsupported any more: they run in the backend (host.ai.complete)
    await assert.doesNotReject(api.plugin.invoke('db.todos.draftReply', ['t1']))
    await assert.doesNotReject(api.plugin.invoke('groupTopics.analyze', ['c1']))

    // every capability that the plugin turns off maps to API paths the backend refuses (or to `driver`, which the adapter omits)
    const off = Object.entries(PLUGIN_CAPABILITIES).filter(([key, value]) => key !== 'host' && value === false).map(([key]) => key)
    assert.deepEqual(off.sort(), ['aiProviderSelection', 'apiKey', 'customAiEndpoint', 'driverPost', 'extractConcurrency', 'mediaFileActions', 'openAtLogin', 'openDataFolder', 'openOriginalChat'])
    for (const [capability, paths] of Object.entries(CAPABILITY_API_PATHS)) {
      assert.equal(PLUGIN_CAPABILITIES[capability], false, `${capability} is off in the plugin`)
      assert.equal(STANDALONE_CAPABILITIES[capability], true, `${capability} stays on in standalone`)
      for (const path of paths) {
        if (path === 'driver') { assert.equal(api.driver, undefined); continue }
        await assert.rejects(api.plugin.invoke(path, ['x']), (e) => e instanceof PluginUnsupportedError, `${capability}: ${path}`)
      }
    }
    assert.ok(Object.values(STANDALONE_CAPABILITIES).every((v) => v === true || v === 'standalone'), 'standalone keeps everything on')
    assert.equal(mock.count('driver.postDraft'), 0, 'driver.* never leaves the view')
  })
})

test('AI seam: draftReply / analyzeNotMine / group analysis are plain backend calls; when the AI cannot work they fail explicitly in the shape of their own result type (never fake success)', async () => {
  await withBackend({ setup: (ai) => ai.control.set({ providerState: 'not_logged_in' }) }, async ({ api, mock, ai }) => {
    // a todo that does not exist: the backend says so before any AI is needed
    assert.deepEqual(await api.db.todos.draftReply('t1'), { error: '找不到該代辦' })
    assert.equal((await api.db.todos.analyzeNotMine('f1')).ok, false)
    assert.equal((await api.groupTopics.analyze('c1')).ok, false)
    assert.equal(mock.count('db.todos.draftReply'), 1, 'the call really went to the backend: the view has no AI of its own')
    assert.equal(ai.stats.completes, 0)
    assert.equal(ai.control.liveSessions(), 0)
  })
  await withBackend({}, async ({ api, line, ai }) => {
    line.emit(raw(1, { text: '請幫我寄報價單給客戶' }))
    await api.pipeline.runOnce()
    const todo = (await asyncUntil(async () => { const list = await api.db.todos.list(); return list.length === 1 ? list : null }, { message: 'a todo' }))[0]
    assert.equal((await api.db.todos.draftReply(todo.id)).draft, '好的，我明天回覆您')
    ai.control.set({ providerState: 'not_logged_in' })
    await api.plugin.aiStatus({ refresh: true })
    const failed = await api.db.todos.draftReply(todo.id)
    assert.equal(failed.draft, undefined)
    assert.match(failed.error, /Codex 目前無法使用/)
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
    await withBackend({ backend: { media: { fs: createNodeLineFsPort(), cacheDir, index: { startDelayMs: 0 } } } }, async ({ api, line, mock, dataDir }) => {
      // media.prepare only queries the local image index: wait until its first scan of the (fake) LINE Cache has finished
      await asyncUntil(async () => (await api.plugin.info()).media.index.ready, { timeout: 10_000, message: 'the media index to be ready' })
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

test('sticker: optional asset URL uses the private backend route and host assets.url; failure remains a readable UI fallback', async () => {
  const fake = scriptedHost({
    'media.prepareSticker': (args, n) => {
      if (n === 1) {
        assert.deepEqual(args, ['i:639965811251347972'])
        return { value: { path: `sticker-cache/${'b'.repeat(64)}.png` } }
      }
      return { value: null }
    }
  })
  const api = apiFor(fake)
  try {
    const url = await api.media.stickerAssetUrl('i:639965811251347972')
    assert.equal(url, `tuqplugin://tuqdev.line-todo/data/sticker-cache/${'b'.repeat(64)}.png`)
    assert.equal(await api.media.stickerAssetUrl('i:639965811251347972'), url)
    assert.equal(fake.count('media.prepareSticker'), 1, 'successful opaque URL is cached by message ID in the plugin adapter')
    assert.equal(await api.media.stickerAssetUrl('i:missing'), null)
    assert.deepEqual(fake.state.calls.find((call) => call.path === 'media.prepareSticker'), { path: 'media.prepareSticker', at: fake.state.calls[0].at })
  } finally { api.dispose() }
})

test('review: when the AI cannot work reviewLastDays answers "not connected" at once with the reason (it would otherwise wait 15 minutes for results nobody delivers); otherwise it rides the job channel while the backend worker answers', async () => {
  await withBackend({ setup: (ai) => ai.control.set({ providerState: 'not_logged_in' }) }, async ({ api, mock }) => {
    const t0 = Date.now()
    const review = await api.pipeline.reviewLastDays(3)
    assert.ok(Date.now() - t0 < 500)
    assert.equal(review.ok, false)
    assert.equal(review.hasApiKey, true, 'the UI must not tell the user to enter an API key')
    assert.equal(review.days, 3)
    assert.match(review.note, /尚未登入/)
    assert.equal(mock.count('pipeline.reviewLastDays'), 1, 'the backend was asked and refused')
  })
  const dataDir = mkdtempSync(join(tmpdir(), 'plugin-adapter-review-'))
  const line = fakeLine()
  line.port.getMessagesSince = async () => [raw(1, { text: '提醒我週五前交付報告', ts: Date.now() - 1000 }), raw(2, { text: '另外發票也要開', ts: Date.now() - 500 })]
  // the model takes ~100 ms, slower than the backend's 30 ms soft deadline, so the call turns into a job
  const ai = createMockTuqAi({ reply: (ctx) => ({ text: fenced(okResult([JSON.parse(ctx.user).newMessages[0].msgId], '交付週五報告')), delay: () => sleep(100) }) })
  const backend = await createPluginBackend({ pluginId: 'p', version: '1', dataDir, line: line.port, dispatcher: { softDeadlineMs: 30, maxJobWaitMs: 200 }, hostAi: ai.ai, ai: { config: { optionsTtlMs: 20 }, worker: { pollIntervalMs: 40 } } })
  const mock = makeHost({ target: backend })
  const api = createPluginLineTodoApi({ host: mock.host, jobPollWaitMs: 100, events: FAST_EVENTS })
  try {
    const result = await api.pipeline.reviewLastDays(7)
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

// ───────────── WP-C: lanes, wait limits, phases (pluginTransport.ts) ─────────────
// All of these go through createPluginLineTodoApi (the production wiring of PluginTransport) in front of a scripted host; none of them builds a Limiter by hand.

/**
 * A scripted host. `script[path]` = `{ value, delayMs, hold }`; `hold: true` answers only when `release()` is called (or throws `{ throws }`).
 * It records, per lane, how many calls were in flight at the same time, so the lane caps are measured at the host and not only inside the transport.
 */
function scriptedHost(script = {}) {
  const state = { calls: [], inFlight: { core: 0, bulk: 0, events: 0 }, peak: { core: 0, bulk: 0, events: 0 }, peakTotal: 0, held: [] }
  const total = () => state.inFlight.core + state.inFlight.bulk + state.inFlight.events
  const host = {
    backend: {
      async call(_method, params) {
        const path = params.path
        const lane = laneFor(path)
        state.calls.push({ path, at: Date.now() })
        state.inFlight[lane] += 1
        state.peak[lane] = Math.max(state.peak[lane], state.inFlight[lane])
        state.peakTotal = Math.max(state.peakTotal, total())
        try {
          const rule = typeof script[path] === 'function' ? script[path](params.args ?? [], state.calls.filter((c) => c.path === path).length) : script[path] ?? {}
          if (rule.hold) await new Promise((resolve) => state.held.push(resolve))
          if (rule.delayMs) await sleep(rule.delayMs)
          if (rule.throws) throw new Error(rule.throws)
          return { ok: true, value: rule.value ?? null }
        } finally { state.inFlight[lane] -= 1 }
      }
    },
    assets: { url: (path) => `tuqplugin://tuqdev.line-todo/data/${path}` }
  }
  return { host, state, count: (path) => state.calls.filter((c) => c.path === path).length, release: () => { for (const resolve of state.held.splice(0)) resolve() } }
}

const TIGHT = { coreMs: 60, pingMs: 200, bulkMs: 80, longMs: 400 }
const apiFor = (fake, options = {}) => createPluginLineTodoApi({ host: fake.host, events: { ...FAST_EVENTS, enabled: false }, busyRetry: { attempts: 0 }, ...options })

test('WP-C lanes: ping / status / db / messages / settings / pipeline / groupTopics / job / result are core; media.prepare, media.prepareSticker, media.avatar.*, ai.status, ai.options are bulk; events.* are events (events.close stays core)', () => {
  for (const path of ['ping', 'line.status', 'db.chats.list', 'db.messages.list', 'db.todos.list', 'messages.recent', 'settings.get', 'pipeline.status', 'groupTopics.list', 'result.chunk', 'job.poll', 'backend.info', 'events.close']) assert.equal(laneFor(path), 'core', path)
  for (const path of ['media.prepare', 'media.prepareSticker', 'media.avatar.prepareChats', 'media.avatar.prepareMessages', 'ai.status', 'ai.options']) assert.equal(laneFor(path), 'bulk', path)
  for (const path of ['events.open', 'events.pull']) assert.equal(laneFor(path), 'events', path)
})

test('WP-C lanes: with the bulk lane and the events lane full, a core call still runs at once; bulk never exceeds 1, events never exceeds 1, the total never exceeds 3', async () => {
  const fake = scriptedHost({
    'media.avatar.prepareChats': { hold: true }, 'media.avatar.prepareMessages': { hold: true }, 'media.prepare': { hold: true }, 'ai.status': { hold: true }, 'events.pull': { hold: true },
    'line.status': { value: { state: 'running' } }, 'db.chats.list': { value: [] }
  })
  const api = apiFor(fake, { timeouts: { coreMs: 5000, pingMs: 5000, longMs: 5000, bulkMs: 5000 } })
  try {
    const bulk = [
      api.media.avatarUrls(['a']), api.media.avatarUrls(['b']), api.media.messageAvatarUrls('a', ['i:1']), api.media.assetUrl('i:1'), api.media.assetUrl('i:2'), api.plugin.aiStatus({ refresh: true })
    ]
    const events = [api.plugin.invoke('events.pull', [{ sessionId: 's', afterSeq: 0, waitMs: 0 }]), api.plugin.invoke('events.pull', [{ sessionId: 's', afterSeq: 0, waitMs: 0 }])]
    await until(() => fake.state.peak.bulk === 1 && fake.state.peak.events === 1, { message: 'the bulk and the events lane are each occupied by exactly one call' })
    const t0 = Date.now()
    assert.deepEqual(await api.line.status(), { state: 'running' })
    assert.deepEqual(await api.db.chats.list(), [])
    assert.ok(Date.now() - t0 < 1_000, `core calls ran at once (${Date.now() - t0} ms) although bulk and events were saturated (catastrophe ceiling 1,000 ms; behind the held bulk calls they would never answer at all)`)
    const lanes = api.plugin.transportStats().lanes
    assert.equal(lanes.bulk.active, 1)
    assert.equal(lanes.bulk.waiting, 5, 'the other five bulk calls queue behind the one that runs')
    assert.equal(lanes.events.active, 1)
    assert.equal(lanes.events.waiting, 1)
    assert.equal(fake.count('line.status') + fake.count('db.chats.list'), 2)
    // let everything finish: the queued bulk / events calls start one at a time as the running ones answer
    const settled = Promise.allSettled([...bulk, ...events]).then(() => true)
    for (let i = 0; i < 40; i += 1) { fake.release(); if (await Promise.race([settled, sleep(15).then(() => false)])) break }
    assert.ok(await Promise.race([settled, sleep(1).then(() => false)]), 'every queued call finished')
    assert.ok(fake.state.peak.bulk <= 1 && fake.state.peak.events <= 1, `peak bulk ${fake.state.peak.bulk}, events ${fake.state.peak.events}`)
    assert.ok(fake.state.peakTotal <= 3, `peak total ${fake.state.peakTotal}`)
  } finally { fake.release(); api.dispose() }
})

test('WP-C lanes: five simultaneous core calls use all three slots (the budget is unchanged), and a budget below 3 keeps one FIFO for everything', async () => {
  const fake = scriptedHost({ 'db.chats.list': { delayMs: 30, value: [] } })
  const api = apiFor(fake)
  try {
    await Promise.all(Array.from({ length: 9 }, () => api.db.chats.list()))
    assert.equal(fake.state.peak.core, 3)
  } finally { api.dispose() }

  const single = scriptedHost({ 'media.prepare': { hold: true }, 'line.status': { value: 1 } })
  const settings = apiFor(single, { maxConcurrentCalls: 1, timeouts: { ...TIGHT, bulkMs: 5000 } })
  try {
    void settings.media.assetUrl('i:1')
    await until(() => single.count('media.prepare') === 1)
    let answered = false
    const status = settings.line.status().then(() => { answered = true })
    await sleep(50)
    assert.equal(answered, false, 'budget 1: one FIFO — the core call waits for the media call (the settings view has no bulk traffic of its own)')
    single.release()
    await status
    assert.equal(settings.plugin.transportStats().maxActive, 1)
  } finally { single.release(); settings.dispose() }
})

test('WP-C timeout: a core call that gets no answer is released with view_call_timeout, frees its slot, never marks the link revoked, and the late answer is dropped', async () => {
  const unhandled = []
  const onRejection = (reason) => { unhandled.push(reason) }
  process.on('unhandledRejection', onRejection)
  const fake = scriptedHost({ 'db.chats.list': (_args, n) => (n === 1 ? { hold: true } : { value: [{ chatId: 'c' }] }), 'line.status': { value: { state: 'running' } } })
  const api = apiFor(fake, { timeouts: TIGHT })
  const phases = []
  api.plugin.onBackendPhase((p) => phases.push(p))
  try {
    const t0 = Date.now()
    await assert.rejects(api.db.chats.list(), (e) => e instanceof PluginApiError && e.code === 'view_call_timeout' && e.path === 'db.chats.list')
    const waited = Date.now() - t0
    assert.ok(waited >= 50 && waited < 1_000, `gave up after ${waited} ms (coreMs 60; catastrophe ceiling 1,000 ms)`)
    assert.equal(api.plugin.transportStats().active, 0, 'the slot came back')
    assert.equal(api.plugin.transportStats().timeouts, 1)
    assert.notEqual(api.plugin.backendLink().state, 'revoked', 'a view-side wait limit is not a host fence')
    assert.deepEqual(api.plugin.backendLink(), { state: 'unknown', code: null })
    assert.equal(api.plugin.backendPhase(), 'timeout')
    assert.deepEqual(phases, ['timeout'])
    assert.deepEqual(api.plugin.backendDiagnostics().lastError, { code: 'view_call_timeout', path: 'db.chats.list' })
    // the next call is not held up by the abandoned one; the timeout is cleared only by a success of the SAME path (F1), not by an unrelated core call
    await api.line.status()
    assert.equal(api.plugin.backendPhase(), 'timeout', 'an unrelated core call succeeded: db.chats.list still has not answered, so the timeout stays')
    assert.deepEqual(await api.db.chats.list(), [{ chatId: 'c' }])
    assert.equal(api.plugin.backendPhase(), 'ready')
    assert.deepEqual(phases, ['timeout', 'ready'])
    fake.release() // the host answers the abandoned call late
    await sleep(30)
    assert.deepEqual(unhandled, [])
  } finally { process.off('unhandledRejection', onRejection); fake.release(); api.dispose() }
})

test('WP-C timeout (F1): a line.status / messages.recent timeout stays until that same path answers; an unrelated core success neither clears it nor announces another phase', async () => {
  const fake = scriptedHost({
    'line.status': (_args, n) => (n === 1 ? { hold: true } : { value: { state: 'running' } }),
    'messages.recent': (_args, n) => (n === 1 ? { hold: true } : { value: [] }),
    'db.chats.list': { value: [] }, 'db.messages.list': { value: [] }, 'settings.get': { value: {} }
  })
  const api = apiFor(fake, { timeouts: TIGHT })
  const phases = []
  api.plugin.onBackendPhase((p) => phases.push(p))
  try {
    await api.db.chats.list()
    await assert.rejects(api.line.status(), (e) => e instanceof PluginApiError && e.code === 'view_call_timeout' && e.path === 'line.status')
    await assert.rejects(api.messages.recent(), (e) => e instanceof PluginApiError && e.code === 'view_call_timeout' && e.path === 'messages.recent')
    assert.equal(api.plugin.backendPhase(), 'timeout')
    assert.deepEqual(phases, ['timeout'])

    await api.plugin.invoke('db.messages.list', [{ limit: 5 }])
    await api.settings.get()
    await api.db.chats.list()
    assert.equal(api.plugin.backendPhase(), 'timeout', 'unrelated core calls succeeded: the timeout of line.status / messages.recent is still on')
    assert.deepEqual(phases, ['timeout'], 'no other phase was announced in between')

    assert.deepEqual(await api.line.status(), { state: 'running' })
    assert.equal(api.plugin.backendPhase(), 'timeout', 'line.status answered but messages.recent has not: still a timeout')
    assert.deepEqual(await api.messages.recent(), [])
    assert.equal(api.plugin.backendPhase(), 'ready')
    assert.deepEqual(phases, ['timeout', 'ready'])
  } finally { fake.release(); api.dispose() }
})

test('WP-C timeout (F2): only line.status / messages.recent / db.chats.list can put the status line into timeout; a db.messages.list (or any other core path) timeout does not, but is still counted and kept as the last error', async () => {
  const fake = scriptedHost({
    'line.status': { value: { state: 'running' } }, 'db.chats.list': { value: [] },
    'db.messages.list': { hold: true }, 'db.todos.list': { hold: true }, 'settings.get': { hold: true }
  })
  const api = apiFor(fake, { timeouts: TIGHT })
  const phases = []
  api.plugin.onBackendPhase((p) => phases.push(p))
  const timedOut = (path) => (e) => e instanceof PluginApiError && e.code === 'view_call_timeout' && e.path === path
  try {
    await assert.rejects(api.plugin.invoke('db.messages.list', [{ limit: 5 }]), timedOut('db.messages.list'))
    assert.equal(api.plugin.backendPhase(), 'connecting', 'db.messages.list timed out before the bridge answered: not a timeout')
    assert.deepEqual(phases, [])
    await api.line.status()
    await api.db.chats.list()
    assert.equal(api.plugin.backendPhase(), 'ready')
    await assert.rejects(api.plugin.invoke('db.messages.list', [{ limit: 5 }]), timedOut('db.messages.list'))
    await assert.rejects(api.plugin.invoke('db.todos.list', []), timedOut('db.todos.list'))
    await assert.rejects(api.plugin.invoke('settings.get', []), timedOut('settings.get'))
    assert.equal(api.plugin.backendPhase(), 'ready', 'timeouts of paths outside the bridge never reach the status line')
    assert.deepEqual(phases, ['ready'], 'and no phase change was announced for them')
    assert.equal(api.plugin.transportStats().timeouts, 4, 'they are still counted')
    assert.deepEqual(api.plugin.backendDiagnostics().lastError, { code: 'view_call_timeout', path: 'settings.get' }, 'and still visible in the diagnostics')
    assert.notEqual(api.plugin.backendLink().state, 'revoked')
  } finally { fake.release(); api.dispose() }
})

test('WP-C timeout (F2): a ping timeout is cleared by ANY successful core call (the backend is alive), but that call never clears a bridge path that is still timed out', async () => {
  const onlyFirstHangs = (value) => (_args, n) => (n === 1 ? { hold: true } : { value })
  const alone = scriptedHost({ ping: onlyFirstHangs({ version: 'x' }), 'db.messages.list': { value: [] }, 'line.status': { value: { state: 'running' } }, 'db.chats.list': { value: [] } })
  const a = apiFor(alone, { timeouts: TIGHT })
  const seenA = []
  a.plugin.onBackendPhase((p) => seenA.push(p))
  try {
    await assert.rejects(a.ping(), (e) => e.code === 'view_call_timeout' && e.path === 'ping')
    assert.equal(a.plugin.backendPhase(), 'timeout')
    await a.plugin.invoke('db.messages.list', [{ limit: 5 }])
    assert.equal(a.plugin.backendPhase(), 'connecting', 'any core call that answers shows the backend is alive: the ping timeout is gone')
    assert.deepEqual(seenA, ['timeout', 'connecting'])
    await a.line.status()
    await a.db.chats.list()
    assert.equal(a.plugin.backendPhase(), 'ready')
  } finally { alone.release(); a.dispose() }

  const both = scriptedHost({ ping: onlyFirstHangs({ version: 'x' }), 'line.status': onlyFirstHangs({ state: 'running' }), 'db.messages.list': { value: [] }, 'db.chats.list': { value: [] } })
  const b = apiFor(both, { timeouts: TIGHT })
  const seenB = []
  b.plugin.onBackendPhase((p) => seenB.push(p))
  try {
    await assert.rejects(b.ping(), (e) => e.code === 'view_call_timeout')
    await assert.rejects(b.line.status(), (e) => e.code === 'view_call_timeout')
    assert.equal(b.plugin.backendPhase(), 'timeout')
    await b.plugin.invoke('db.messages.list', [{ limit: 5 }])
    assert.equal(b.plugin.backendPhase(), 'timeout', 'the ping timeout is cleared, line.status has still not answered: still a timeout')
    assert.deepEqual(seenB, ['timeout'])
    await b.line.status()
    assert.equal(b.plugin.backendPhase(), 'connecting', 'line.status answered: nothing is left')
    assert.deepEqual(seenB, ['timeout', 'connecting'])
  } finally { both.release(); b.dispose() }
})

test('WP-C timeout (F2): a job.poll / result.chunk that times out is charged to the path that asked for it (a bridge path shows, any other does not), and the path answering again clears it', async () => {
  let healed = false
  const host = {
    backend: {
      async call(_method, params) {
        const path = params.path
        if (path === 'line.status') return healed ? { ok: true, value: { state: 'running' } } : { ok: true, chunked: true, resultId: 'r1', chunks: 1 }
        if (path === 'db.messages.list') return { ok: true, pending: true, jobId: 'j1' }
        return new Promise(() => undefined)
      }
    },
    assets: { url: (path) => path }
  }
  const api = createPluginLineTodoApi({ host, events: { ...FAST_EVENTS, enabled: false }, busyRetry: { attempts: 0 }, timeouts: TIGHT })
  try {
    await assert.rejects(api.plugin.invoke('db.messages.list', [{ limit: 5 }]), (e) => e.code === 'view_call_timeout' && e.path === 'job.poll')
    assert.equal(api.plugin.backendPhase(), 'connecting', 'a job.poll of db.messages.list is not a bridge path')
    await assert.rejects(api.plugin.invoke('line.status', []), (e) => e.code === 'view_call_timeout' && e.path === 'result.chunk')
    assert.equal(api.plugin.backendPhase(), 'timeout', 'the chunk of line.status is a line.status timeout')
    healed = true
    assert.deepEqual(await api.plugin.invoke('line.status', []), { state: 'running' })
    assert.equal(api.plugin.backendPhase(), 'connecting', 'line.status answered: the timeout is gone')
  } finally { api.dispose() }
})

test('WP-C phase: the starting announcement does not depend on setTimeout firing a millisecond late — a timer that fires early (setTimeout vs Date.now skew, about 1 in 100 on Windows) still announces starting', async () => {
  const realNow = Date.now
  const fake = scriptedHost({ ping: { hold: true } })
  const api = apiFor(fake, { startingAfterMs: 60, timeouts: { ...TIGHT, pingMs: 5000 } })
  const phases = []
  api.plugin.onBackendPhase((p) => phases.push(p))
  try {
    const ping = api.ping().catch(() => undefined)
    Date.now = () => realNow() - 40 // as if the 60 ms timer fired 40 ms early: the margin is large so that ordinary timer lateness cannot hide a missing re-arm
    await sleep(250)
    assert.deepEqual(phases, ['starting'], 'the screen was told: without the re-arm the one timer saw "too early", published nothing and never tried again')
    assert.equal(api.plugin.backendPhase(), 'starting')
    Date.now = realNow
    fake.release()
    await ping
  } finally { Date.now = realNow; fake.release(); api.dispose() }
})

test('WP-C timeout: bulk degrades silently (null / empty, no timeout phase, no last error); AI paths that the backend itself lets run for 20 s are not abandoned at the core limit; events are never limited', async () => {
  const fake = scriptedHost({
    'media.prepare': { hold: true }, 'media.avatar.prepareChats': { hold: true },
    'db.todos.draftReply': { delayMs: 150, value: 'draft' }, 'db.todos.list': { delayMs: 150, value: [] },
    'events.pull': { delayMs: 150, value: { events: [] } }
  })
  const api = apiFor(fake, { timeouts: TIGHT })
  try {
    assert.equal(await api.media.assetUrl('i:1'), null, 'a timed-out media.prepare answers null like any failure')
    assert.deepEqual(await api.media.avatarUrls(['a']), { urls: {}, names: {} })
    assert.equal(api.plugin.transportStats().timeouts, 2)
    assert.equal(api.plugin.backendPhase(), 'connecting', 'bulk timeouts do not turn the phase into a timeout')
    assert.equal(api.plugin.backendDiagnostics().lastError, null)
    assert.equal(await api.plugin.invoke('db.todos.draftReply', ['t1']), 'draft', 'draftReply (150 ms) is a long call: it is judged against longMs 400, not coreMs 60')
    await assert.rejects(api.db.todos.list(), (e) => e.code === 'view_call_timeout', 'an ordinary read taking the same 150 ms is abandoned at coreMs 60')
    assert.deepEqual(await api.plugin.invoke('events.pull', [{ sessionId: 's', afterSeq: 0, waitMs: 0 }]), { events: [] }, 'events have no limit')
  } finally { fake.release(); api.dispose() }
})

test('WP-C phase: ping unanswered = connecting, then starting after startingAfterMs; once ping answers it is connecting until line.status AND db.chats.list have answered, then ready; every change is announced once', async () => {
  const fake = scriptedHost({ ping: { hold: true }, 'line.status': { value: { state: 'running' } }, 'db.chats.list': { value: [] } })
  const api = apiFor(fake, { startingAfterMs: 60, timeouts: { ...TIGHT, pingMs: 5000 } })
  const phases = []
  api.plugin.onBackendPhase((p) => phases.push(p))
  try {
    assert.equal(api.plugin.backendPhase(), 'connecting', 'before anything is sent')
    const ping = api.ping()
    assert.equal(api.plugin.backendPhase(), 'connecting', 'ping just sent: not starting yet')
    await sleep(100)
    assert.equal(api.plugin.backendPhase(), 'starting')
    assert.deepEqual(phases, ['starting'])
    fake.release()
    await ping
    assert.equal(api.plugin.backendPhase(), 'connecting', 'ping answered, status and list not yet')
    await api.line.status()
    assert.equal(api.plugin.backendPhase(), 'connecting', 'line.status alone is not enough')
    await api.db.chats.list()
    assert.equal(api.plugin.backendPhase(), 'ready')
    assert.deepEqual(phases, ['starting', 'connecting', 'ready'])
  } finally { fake.release(); api.dispose() }
})

test('WP-C phase: a ping that never answers is a timeout at pingMs (35 s in production, longer than the host 30 s); a refusing host is error; unavailable during the wait for ping is still starting, after ping gave up it is error', async () => {
  const hung = scriptedHost({ ping: { hold: true } })
  const a = apiFor(hung, { startingAfterMs: 30, timeouts: { ...TIGHT, pingMs: 120 } })
  try {
    const result = await a.ping().then(() => 'answered', (e) => e.code)
    assert.equal(result, 'view_call_timeout')
    assert.equal(a.plugin.backendPhase(), 'timeout')
  } finally { hung.release(); a.dispose() }

  const fenced = scriptedHost({ 'line.status': { throws: 'plugin_disabled' } })
  const b = apiFor(fenced, { timeouts: TIGHT })
  try {
    await assert.rejects(b.line.status(), (e) => e instanceof PluginBackendError && e.code === 'plugin_disabled')
    assert.equal(b.plugin.backendLink().state, 'revoked')
    assert.equal(b.plugin.backendPhase(), 'error')
  } finally { b.dispose() }

  let pingTries = 0
  const booting = scriptedHost({ ping: () => { pingTries += 1; return { delayMs: 40, throws: 'plugin_backend_unavailable' } } })
  const c = apiFor(booting, { startingAfterMs: 20, busyRetry: { attempts: 2, baseMs: 10, maxMs: 10, random: () => 0.5 }, timeouts: { ...TIGHT, pingMs: 5000 } })
  const seen = []
  c.plugin.onBackendPhase((p) => seen.push(p))
  try {
    await assert.rejects(c.ping(), (e) => e.code === 'plugin_backend_unavailable')
    assert.equal(pingTries, 3, 'retried with backoff, as before')
    assert.equal(c.plugin.backendLink().state, 'unavailable')
    assert.equal(c.plugin.backendPhase(), 'error', 'ping gave up: the unavailable banner is allowed to show')
    assert.ok(seen.includes('starting'), `while ping was still being retried the phase was starting: ${seen.join(',')}`)
    assert.equal(seen.at(-1), 'error')
  } finally { c.dispose() }
})

test('WP-C diagnostics: pending core calls report how long they have waited and whether they hold a slot; and nothing is left pending once they finish', async () => {
  const fake = scriptedHost({ 'line.status': { hold: true }, 'db.chats.list': { hold: true }, 'settings.get': { hold: true }, 'db.todos.list': { hold: true } })
  const api = apiFor(fake, { timeouts: { coreMs: 5000, pingMs: 5000, longMs: 5000, bulkMs: 5000 } })
  try {
    const pending = [api.line.status(), api.db.chats.list(), api.settings.get(), api.db.todos.list()].map((p) => p.catch(() => undefined))
    await until(() => fake.state.calls.length === 3)
    await sleep(40)
    const diag = api.plugin.backendDiagnostics()
    assert.equal(diag.calls.length, 4)
    assert.deepEqual(diag.calls.map((c) => [c.path, c.lane, c.running]), [['line.status', 'core', true], ['db.chats.list', 'core', true], ['settings.get', 'core', true], ['db.todos.list', 'core', false]])
    assert.ok(diag.calls.every((c) => c.waitedMs >= 30), JSON.stringify(diag.calls))
    assert.equal(diag.lastError, null)
    fake.release()
    await sleep(20)
    fake.release()
    await Promise.all(pending)
    await sleep(10)
    assert.equal(api.plugin.backendDiagnostics().calls.length, 0)
  } finally { fake.release(); api.dispose() }
})

test('WP-C banner: the unavailable banner stays hidden while the phase is starting or connecting, and shows again for error / timeout / ready; revoked is never hidden', async () => {
  const unavailable = { state: 'unavailable', code: 'plugin_backend_unavailable' }
  const revoked = { state: 'revoked', code: 'plugin_disabled' }
  assert.ok(describeLink(unavailable))
  assert.ok(describeLink(unavailable, null))
  assert.equal(describeLink(unavailable, 'starting'), null)
  assert.equal(describeLink(unavailable, 'connecting'), null)
  for (const phase of ['error', 'timeout', 'ready']) assert.equal(describeLink(unavailable, phase)?.tone, 'warn', phase)
  for (const phase of ['starting', 'connecting', 'error', 'timeout', 'ready', null]) assert.equal(describeLink(revoked, phase)?.tone, 'err', String(phase))
  assert.equal(describeLink({ state: 'ok', code: null }, 'error'), null)
  assert.equal(describeBackendError({ code: 'view_call_timeout' }).kind, 'timeout')
  assert.match(describeBackendError({ code: 'view_call_timeout' }).text, /讀取逾時.*重試/)
})

test('WP-C board: bootBoard sends ping first and defers ai.status until the first core data (line.status + db.chats.list) is in, or the defer limit, whichever comes first', async () => {
  const previous = globalThis.window
  try {
    // 1) core data arrives quickly: ai.status follows it at once (well before the limit)
    const quick = scriptedHost({ ping: { value: { ok: 1 } }, 'line.status': { value: { state: 'running' } }, 'db.chats.list': { value: [] }, 'ai.status': { value: { state: 'ready' } } })
    globalThis.window = { tuqPlugin: quick.host, addEventListener() {} }
    const boot = bootBoard({ aiStatusDeferMs: 1500 })
    try {
      assert.ok(boot)
      await until(() => quick.count('ping') === 1)
      await sleep(40)
      assert.equal(quick.count('ai.status'), 0, 'not before the first core data')
      await boot.api.line.status()
      assert.equal(quick.count('ai.status'), 0, 'line.status alone is not the first batch')
      await boot.api.db.chats.list()
      await until(() => quick.count('ai.status') === 1, { message: 'ai.status after ready' })
      assert.deepEqual(quick.state.calls.map((c) => c.path), ['ping', 'line.status', 'db.chats.list', 'ai.status'])
      assert.equal(laneFor('ai.status'), 'bulk')
    } finally { boot?.api.dispose() }

    // 2) core data never arrives: ai.status goes out at the defer limit, not earlier
    const slow = scriptedHost({ ping: { value: { ok: 1 } }, 'line.status': { hold: true }, 'ai.status': { value: { state: 'ready' } } })
    globalThis.window = { tuqPlugin: slow.host, addEventListener() {} }
    const t0 = Date.now()
    const boot2 = bootBoard({ aiStatusDeferMs: 200 })
    try {
      void boot2.api.line.status().catch(() => undefined)
      await sleep(120)
      assert.equal(slow.count('ai.status'), 0, 'still deferred at 120 ms')
      await until(() => slow.count('ai.status') === 1, { message: 'ai.status at the limit' })
      const at = slow.state.calls.find((c) => c.path === 'ai.status').at - t0
      assert.ok(at >= 180 && at < 1_000, `ai.status sent after ${at} ms (limit 200; catastrophe ceiling 1,000 ms)`)
      assert.equal(slow.state.calls[0].path, 'ping')
    } finally { slow.release(); boot2?.api.dispose() }
  } finally {
    if (previous === undefined) delete globalThis.window; else globalThis.window = previous
  }
})


// ───────────── chat tab remount: queued avatar calls can be dropped, avatar requests are de-duplicated and remembered ─────────────

test('Limiter: a queued task can be cancelled before it starts; a running task and the queue behind it are unaffected', async () => {
  const limiter = new Limiter(1)
  let releaseRunning
  const ran = []
  const running = limiter.run(async () => { ran.push('running'); await new Promise((resolve) => { releaseRunning = resolve }); return 'done' })
  const early = new AbortController()
  const late = new AbortController()
  const cancelled = limiter.run(async () => { ran.push('cancelled'); return 'no' }, { signal: early.signal })
  const kept = limiter.run(async () => { ran.push('kept'); return 'kept' }, { signal: late.signal })
  assert.deepEqual(limiter.stats(), { active: 1, waiting: 2 })
  early.abort()
  await assert.rejects(cancelled, (e) => e instanceof CallCancelledError)
  assert.deepEqual(limiter.stats(), { active: 1, waiting: 1 }, 'the cancelled task left the queue at once')
  const alreadyAborted = new AbortController()
  alreadyAborted.abort()
  await assert.rejects(limiter.run(async () => 'x', { signal: alreadyAborted.signal }), (e) => e instanceof CallCancelledError)
  assert.deepEqual(limiter.stats(), { active: 1, waiting: 1 }, 'an already aborted signal never enters the queue')
  releaseRunning()
  assert.equal(await running, 'done')
  assert.equal(await kept, 'kept')
  assert.deepEqual(ran, ['running', 'kept'])
  assert.deepEqual(limiter.stats(), { active: 0, waiting: 0 })
  // aborting after the task started does nothing to it
  const started = new AbortController()
  let finish
  const inFlight = limiter.run(() => new Promise((resolve) => { finish = resolve }), { signal: started.signal })
  started.abort()
  finish('still ran')
  assert.equal(await inFlight, 'still ran')
  assert.deepEqual(limiter.stats(), { active: 0, waiting: 0 })
})

/** a host with gates: `hold(path)` makes the next calls of that path wait for `release(path)`; every call is logged in order */
function gatedHost({ fail = new Set() } = {}) {
  const log = []
  const held = new Map()
  const holding = new Set()
  const hold = (path) => { holding.add(path) }
  const release = (path) => { holding.delete(path); for (const open of held.get(path) ?? []) open(); held.set(path, []) }
  const pathsFor = (ids) => Object.fromEntries(ids.map((id) => [id, `avatar-cache/${id}.jpg`]))
  const namesFor = (ids) => Object.fromEntries(ids.map((id) => [id, `N ${id}`]))
  const host = {
    assets: { url: (p) => `asset://${p}` },
    backend: {
      async call(_method, params) {
        const { path, args = [] } = params
        log.push({ path, args })
        if (holding.has(path)) await new Promise((resolve) => { held.set(path, [...(held.get(path) ?? []), resolve]) })
        if (path === 'media.avatar.prepareMessages') {
          const ids = args[1]
          if (ids.some((id) => fail.has(id))) throw new Error('plugin_backend_crashed')
          if (ids.includes('i:chunked')) return { ok: true, chunked: true, resultId: 'r1', chunks: 2 }
          return { ok: true, value: { paths: pathsFor(ids), names: namesFor(ids) } }
        }
        if (path === 'media.avatar.prepareChats') return { ok: true, value: { paths: pathsFor(args[0]), names: namesFor(args[0]) } }
        if (path === 'result.chunk') {
          const text = JSON.stringify({ paths: pathsFor(['i:chunked']), names: namesFor(['i:chunked']) })
          const half = Math.ceil(text.length / 2)
          return { ok: true, value: { data: args[0].index === 0 ? text.slice(0, half) : text.slice(half) } }
        }
        return { ok: true, value: path }
      }
    }
  }
  const avatarFlight = { now: 0, peak: 0 }
  const inner = host.backend.call
  host.backend.call = async (method, params) => {
    const isAvatar = String(params.path).startsWith('media.avatar.')
    if (isAvatar) { avatarFlight.now += 1; avatarFlight.peak = Math.max(avatarFlight.peak, avatarFlight.now) }
    try { return await inner(method, params) } finally { if (isAvatar) avatarFlight.now -= 1 }
  }
  const avatarCalls = (path = 'media.avatar.prepareMessages') => log.filter((entry) => entry.path === path)
  return { host, log, hold, release, avatarCalls, avatarFlight }
}

test('avatar requests: duplicates are sent once, known results are remembered, identical in-flight requests are merged, chat scope is separate', async () => {
  const g = gatedHost()
  const api = createPluginLineTodoApi({ host: g.host, maxConcurrentCalls: 1, events: { enabled: false } })
  try {
    g.hold('ping')
    const blocker = api.plugin.invoke('ping') // fills the only slot, so the avatar calls below queue behind it
    await until(() => g.log.length === 1, { message: 'the blocker to start' })
    const first = api.media.messageAvatarUrls('c1', ['i:1', 'i:2', 'i:1'])
    const second = api.media.messageAvatarUrls('c1', ['i:2', 'i:1'])
    await sleep(10)
    assert.equal(api.plugin.transportStats().waiting, 1, 'the two identical requests share one queued call')
    g.release('ping')
    await blocker
    const [a, b] = await Promise.all([first, second])
    assert.deepEqual(a, { urls: { 'i:1': 'asset://avatar-cache/i:1.jpg', 'i:2': 'asset://avatar-cache/i:2.jpg' }, names: { 'i:1': 'N i:1', 'i:2': 'N i:2' } })
    assert.deepEqual(b, a)
    assert.deepEqual(g.avatarCalls().map((c) => c.args), [['c1', ['i:1', 'i:2']]])

    const partial = await api.media.messageAvatarUrls('c1', ['i:2', 'i:3'])
    assert.deepEqual(Object.keys(partial.urls).sort(), ['i:2', 'i:3'])
    assert.deepEqual(g.avatarCalls().map((c) => c.args[1]), [['i:1', 'i:2'], ['i:3']], 'only the unknown id was sent')
    await api.media.messageAvatarUrls('c1', ['i:3', 'i:1'])
    assert.equal(g.avatarCalls().length, 2, 'a fully known request sends nothing')

    await api.media.messageAvatarUrls('c2', ['i:1'])
    assert.deepEqual(g.avatarCalls().map((c) => c.args), [['c1', ['i:1', 'i:2']], ['c1', ['i:3']], ['c2', ['i:1']]], 'the same msgId in another chat is a different avatar')

    await api.media.avatarUrls(['c1', 'c2', 'c1'])
    await api.media.avatarUrls(['c2', 'c1'])
    assert.deepEqual(g.avatarCalls('media.avatar.prepareChats').map((c) => c.args), [[['c1', 'c2']]])
  } finally { api.dispose() }
})

test('avatar requests: a failed answer is not remembered; an empty id list sends nothing', async () => {
  const g = gatedHost({ fail: new Set(['i:bad']) })
  const api = createPluginLineTodoApi({ host: g.host, events: { enabled: false }, busyRetry: { attempts: 0 } })
  try {
    assert.deepEqual(await api.media.messageAvatarUrls('c1', ['i:bad']), { urls: {}, names: {} })
    assert.deepEqual(await api.media.messageAvatarUrls('c1', ['i:bad']), { urls: {}, names: {} })
    assert.equal(g.avatarCalls().length, 2, 'a failure is retried')
    assert.deepEqual(await api.media.messageAvatarUrls('c1', []), { urls: {}, names: {} })
    assert.equal(g.avatarCalls().length, 2, 'an empty id list sends nothing')
  } finally { api.dispose() }
})

test('avatar requests: abort drops a queued request (the backend never sees it); a request someone else still waits for survives; a started call finishes and is remembered', async () => {
  const g = gatedHost()
  const api = createPluginLineTodoApi({ host: g.host, maxConcurrentCalls: 1, events: { enabled: false } })
  try {
    g.hold('ping')
    const blocker = api.plugin.invoke('ping')
    await until(() => g.log.length === 1, { message: 'the blocker to start' })

    const lone = new AbortController()
    const dropped = api.media.messageAvatarUrls('c1', ['i:9'], { signal: lone.signal })
    await sleep(5)
    assert.equal(api.plugin.transportStats().waiting, 1)
    lone.abort()
    assert.deepEqual(await dropped, { urls: {}, names: {} }, 'an aborted request resolves empty')
    assert.equal(api.plugin.transportStats().waiting, 0, 'its queued backend call left the queue')

    const sharedA = new AbortController()
    const leaving = api.media.messageAvatarUrls('c1', ['i:20'], { signal: sharedA.signal })
    const staying = api.media.messageAvatarUrls('c1', ['i:20'])
    await sleep(5)
    assert.equal(api.plugin.transportStats().waiting, 1, 'merged into one queued call')
    sharedA.abort()
    assert.deepEqual(await leaving, { urls: {}, names: {} })
    assert.equal(api.plugin.transportStats().waiting, 1, 'another caller still needs it: not dropped')

    g.release('ping')
    await blocker
    assert.deepEqual((await staying).urls, { 'i:20': 'asset://avatar-cache/i:20.jpg' })
    assert.deepEqual(g.avatarCalls().map((c) => c.args[1]), [['i:20']], 'i:9 was never sent; i:20 was sent once')

    const retry = await api.media.messageAvatarUrls('c1', ['i:9'])
    assert.deepEqual(Object.keys(retry.urls), ['i:9'], 'a dropped request does not poison later requests for the same id')

    g.hold('media.avatar.prepareMessages')
    const startedAbort = new AbortController()
    const started = api.media.messageAvatarUrls('c1', ['i:30'], { signal: startedAbort.signal })
    await until(() => g.avatarCalls().some((c) => c.args[1].includes('i:30')), { message: 'the call to start' })
    startedAbort.abort()
    assert.deepEqual(await started, { urls: {}, names: {} })
    const merged = api.media.messageAvatarUrls('c1', ['i:30', 'i:31'])
    await sleep(10)
    g.release('media.avatar.prepareMessages')
    assert.deepEqual(Object.keys((await merged).urls).sort(), ['i:30', 'i:31'])
    assert.deepEqual(g.avatarCalls().map((c) => c.args[1]).slice(-2), [['i:30'], ['i:31']], 'a new request merges into the call that already started and only sends the rest')
    const before = g.avatarCalls().length
    await api.media.messageAvatarUrls('c1', ['i:30'])
    assert.equal(g.avatarCalls().length, before, 'the aborted-but-started call was kept')
  } finally { api.dispose() }
})

test('avatar requests: aborting after the call started does not cancel its result.chunk reads', async () => {
  const g = gatedHost()
  const api = createPluginLineTodoApi({ host: g.host, events: { enabled: false } })
  try {
    g.hold('result.chunk')
    const abort = new AbortController()
    const pending = api.media.messageAvatarUrls('c1', ['i:chunked'], { signal: abort.signal })
    await until(() => g.log.some((entry) => entry.path === 'result.chunk'), { message: 'the first chunk read' })
    abort.abort()
    assert.deepEqual(await pending, { urls: {}, names: {} })
    g.release('result.chunk')
    await until(() => g.log.filter((entry) => entry.path === 'result.chunk').length === 2, { message: 'both chunks to be read after the abort' })
    await sleep(10)
    const calls = g.log.length
    const again = await api.media.messageAvatarUrls('c1', ['i:chunked'])
    assert.deepEqual(Object.keys(again.urls), ['i:chunked'], 'the reassembled answer was remembered')
    assert.equal(g.log.length, calls)
  } finally { api.dispose() }
})

// ───────────── in-flight slow avatar calls must not hold the whole host call budget ─────────────

test('avatar calls: at most one is in flight at the default budget of 3, so two other host calls can always be sent; every avatar still loads', async () => {
  const g = gatedHost()
  const api = createPluginLineTodoApi({ host: g.host, events: { enabled: false } })
  try {
    assert.equal(api.plugin.transportStats().limit, 3)
    g.hold('media.avatar.prepareMessages')
    const ids = Array.from({ length: 6 }, (_, index) => `i:${index + 1}`)
    const loads = ids.map((id) => api.media.messageAvatarUrls('c1', [id]))
    await sleep(20)
    assert.equal(g.avatarCalls().length, 1, 'only one avatar call has been sent; the rest wait outside the host call queue')
    assert.equal(api.plugin.transportStats().active, 1)
    assert.equal(api.plugin.transportStats().lanes.core.waiting, 0, 'nothing waits in the core lane')
    assert.equal(api.plugin.transportStats().lanes.bulk.waiting, ids.length - 1, 'the other avatar batches wait in the bulk lane, behind the one in flight')

    g.hold('ping')
    g.hold('line.status')
    const ping = api.plugin.invoke('ping')
    const status = api.plugin.invoke('line.status')
    await until(() => g.log.some((e) => e.path === 'ping') && g.log.some((e) => e.path === 'line.status'), { message: 'two non-avatar calls reach the host while an avatar call is in flight' })
    assert.equal(api.plugin.transportStats().active, 3)
    g.release('ping')
    g.release('line.status')
    assert.equal(await ping, 'ping')
    assert.equal(await status, 'line.status')
    assert.equal(g.avatarCalls().length, 1, 'the avatar call is still the only one sent')

    for (let round = 0; round < ids.length; round += 1) {
      await until(() => g.avatarCalls().length === round + 1, { message: `avatar call ${round + 1} to be sent` })
      g.release('media.avatar.prepareMessages')
      g.hold('media.avatar.prepareMessages')
    }
    g.release('media.avatar.prepareMessages')
    const results = await Promise.all(loads)
    assert.equal(g.avatarFlight.peak, 1, 'never more than one avatar call at the host')
    results.forEach((result, index) => assert.deepEqual(result.urls, { [ids[index]]: `asset://avatar-cache/${ids[index]}.jpg` }, `avatar ${ids[index]} loaded`))
    assert.deepEqual(g.avatarCalls().map((c) => c.args[1][0]), ids, 'every avatar was requested exactly once, in order')
    assert.equal(api.plugin.transportStats().active, 0)
  } finally { api.dispose() }
})

test('avatar calls: the budget scales (limit 5 -> 3 avatar calls, 2 always free); a budget of 1 still lets avatars through one at a time', async () => {
  const wide = gatedHost()
  const five = createPluginLineTodoApi({ host: wide.host, maxConcurrentCalls: 5, events: { enabled: false } })
  try {
    wide.hold('media.avatar.prepareMessages')
    const loads = Array.from({ length: 6 }, (_, index) => five.media.messageAvatarUrls('c1', [`i:${index + 1}`]))
    await until(() => wide.avatarCalls().length === 3, { message: 'three avatar calls in flight' })
    await sleep(20)
    assert.equal(wide.avatarCalls().length, 3)
    wide.release('media.avatar.prepareMessages')
    await Promise.all(loads)
    assert.equal(wide.avatarFlight.peak, 3)
  } finally { five.dispose() }
  const narrow = gatedHost()
  const one = createPluginLineTodoApi({ host: narrow.host, maxConcurrentCalls: 1, events: { enabled: false } })
  try {
    const results = await Promise.all([one.media.messageAvatarUrls('c1', ['i:1']), one.media.messageAvatarUrls('c1', ['i:2'])])
    assert.deepEqual(results.map((r) => Object.keys(r.urls)), [['i:1'], ['i:2']])
  } finally { one.dispose() }
})

test('avatar calls: the background slot is held for the whole call (chunked answer), so the next avatar call cannot slip in between the chunks', async () => {
  const g = gatedHost()
  const api = createPluginLineTodoApi({ host: g.host, events: { enabled: false } })
  try {
    const [chunked, plain] = await Promise.all([api.media.messageAvatarUrls('c1', ['i:chunked']), api.media.messageAvatarUrls('c1', ['i:2'])])
    assert.deepEqual(Object.keys(chunked.urls), ['i:chunked'])
    assert.deepEqual(Object.keys(plain.urls), ['i:2'])
    assert.deepEqual(g.log.map((e) => (e.path === 'media.avatar.prepareMessages' ? `prepare:${e.args[1][0]}` : e.path)), ['prepare:i:chunked', 'result.chunk', 'result.chunk', 'prepare:i:2'])
  } finally { api.dispose() }
})

test('avatar calls: abort drops a batch that waits for a background slot (never sent); the call in flight finishes', async () => {
  const g = gatedHost()
  const api = createPluginLineTodoApi({ host: g.host, events: { enabled: false } })
  try {
    g.hold('media.avatar.prepareMessages')
    const running = api.media.messageAvatarUrls('c1', ['i:1'])
    await until(() => g.avatarCalls().length === 1, { message: 'the first avatar call to be in flight' })
    const lone = new AbortController()
    const waiting = api.media.messageAvatarUrls('c1', ['i:2'], { signal: lone.signal })
    const kept = api.media.messageAvatarUrls('c1', ['i:3'])
    await sleep(10)
    assert.equal(api.plugin.transportStats().lanes.bulk.waiting, 2)
    lone.abort()
    assert.deepEqual(await waiting, { urls: {}, names: {} })
    assert.equal(api.plugin.transportStats().lanes.bulk.waiting, 1, 'the aborted batch left the wait at once')
    g.release('media.avatar.prepareMessages')
    assert.deepEqual(Object.keys((await running).urls), ['i:1'])
    assert.deepEqual(Object.keys((await kept).urls), ['i:3'])
    assert.deepEqual(g.avatarCalls().map((c) => c.args[1]), [['i:1'], ['i:3']], 'i:2 never reached the host')
    assert.deepEqual(Object.keys((await api.media.messageAvatarUrls('c1', ['i:2'])).urls), ['i:2'], 'an aborted id is requested again later')
  } finally { api.dispose() }
})
