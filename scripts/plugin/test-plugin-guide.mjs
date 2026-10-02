// TeamUQ plugin developer guide conformance (research-gap-audit G-01…G-07): the view-side modules and the adapter against the real Dispatcher / backend.
//
//   G-07  the backend method allow-list: one method per API namespace; Core's allow-list really limits what reaches the backend
//   G-03  backend:invoke revoked / plugin disabled: a distinct link state and message, no busy retries, the event pump probes instead of backing off forever
//   G-02  every failure becomes a user-facing sentence (lib/backendError.ts) — revoked / unavailable / version mismatch / other
//   G-05  long tasks: after a backend restart the lost job (job_not_found) is explained with the status the new backend reads back
//   G-01  theme: the OS appearance is the default and is followed; a manual choice can be dropped again; theme-boot.js does the same before first paint
//   G-04  UI state: saved on change, restored on start, expiring drafts, never throws; standalone stays unsaved
//   G-06  the backend reads nothing from context.settings (static guard; the runtime proof is in test-backend-contract.mjs)
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import test from 'node:test'

import { createPluginBackend } from '../../src/plugin/backend/assemble.ts'
import { Dispatcher } from '../../src/plugin/backend/dispatcher.ts'
import { EventHub } from '../../src/plugin/backend/eventHub.ts'
import { ReviewCoordinator, ReviewLedger } from '../../src/plugin/backend/reviewRun.ts'
import { describeLink } from '../../src/plugin/ui/backendLink.ts'
import { backendErrorText, describeBackendError, guarded } from '../../src/renderer/lib/backendError.ts'
import { RESUMABLE_REVIEW_STATES, explainInterrupted, longTaskNotes, readLongTasks } from '../../src/renderer/lib/longTasks.ts'
import { THEME_KEY, applyTheme, readStoredTheme, resolveTheme, systemTheme, toggleChoice } from '../../src/renderer/lib/theme.ts'
import { NO_UI_STATE, createLocalUiState, parseOneOf, parseStringSet, serializeStringSet } from '../../src/renderer/lib/uiState.ts'
import { PluginEventPump } from '../../src/renderer/platform/pluginEvents.ts'
import { PluginApiError, PluginBackendError, createPluginLineTodoApi } from '../../src/renderer/platform/pluginApi.ts'
import { BACKEND_METHOD_GROUPS, backendMethodFor } from '../../src/shared/pluginWire.ts'
import { BACKEND_METHODS, buildManifest } from './lib/manifest.mjs'
import { ROOT } from './lib/paths.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(predicate, { timeout = 3000, step = 5, message = 'condition' } = {}) {
  const t0 = Date.now()
  while (!predicate()) {
    if (Date.now() - t0 > timeout) assert.fail(`timed out waiting for ${message}`)
    await sleep(step)
  }
}
const FAST_EVENTS = { waitMs: 50, idleStopMs: 20, backoffBaseMs: 10, backoffMaxMs: 40, minLoopMs: 5 }
const NO_RETRY = { attempts: 0 }

/** A view bridge in front of `target` that, like Core's backendInvokeGate, refuses methods outside the manifest allow-list; `fail` simulates host errors. */
function coreHost(target, { allow = BACKEND_METHODS } = {}) {
  const state = { calls: [], fail: null, refusedMethods: [] }
  return {
    state,
    host: {
      backend: {
        async call(method, params) {
          state.calls.push({ method, path: params?.path })
          if (state.fail) throw new Error(typeof state.fail === 'function' ? state.fail(method, params) : state.fail)
          if (!allow.includes(method)) { state.refusedMethods.push(method); throw new Error('backend_method_not_allowed') }
          return JSON.parse(JSON.stringify(await target.call(method, JSON.parse(JSON.stringify(params)))))
        }
      },
      assets: { url: (p) => `tuqplugin://tuqdev.line-todo/data/${p}` }
    }
  }
}

function fakeLinePort() {
  return {
    start() {}, stop() {},
    status: () => ({ state: 'running', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 }),
    onMessage: () => () => undefined, onStatus: () => () => undefined, getMessagesSince: async () => []
  }
}

async function withRealBackend(body) {
  const dataDir = mkdtempSync(join(tmpdir(), 'plugin-guide-'))
  const backend = await createPluginBackend({ pluginId: 'tuqdev.line-todo', version: '0.1.2-test', dataDir, line: fakeLinePort() })
  try { await body({ backend, dataDir }) } finally {
    await backend.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
}

// ───────────── G-07 ─────────────

test('G-07: the manifest allow-list is the method groups; every adapter call uses the group of its path; Core refusing one group refuses only that namespace', async () => {
  assert.deepEqual(buildManifest({ version: '0.1.2' }).backendMethods, [...BACKEND_METHOD_GROUPS])
  assert.ok(BACKEND_METHODS.length <= 32)
  await withRealBackend(async ({ backend }) => {
    const full = coreHost(backend)
    const api = createPluginLineTodoApi({ host: full.host, events: FAST_EVENTS })
    try {
      // a sample from every namespace the board uses
      assert.equal(typeof (await api.ping()).ts, 'number')
      await api.messages.recent()
      await api.line.status()
      await api.db.messages.count()
      await api.db.chats.list(true)
      await api.db.todos.list({})
      await api.pipeline.status()
      await api.settings.get()
      await api.groupTopics.list('c1').catch(() => undefined)
      await api.plugin.info()
      await api.plugin.reviewStatus()
      await api.pipeline.longTaskStatus()
      await api.plugin.extract.stats()
      await api.plugin.aiTasks.pull({ max: 1 })
      assert.equal((await api.app.openDataFolder()).ok, false)
      const off = api.line.onStatus(() => undefined)
      await until(() => full.state.calls.some((c) => c.path === 'events.pull'), { message: 'the event long poll' })
      off()
      assert.deepEqual(full.state.refusedMethods, [], 'nothing the adapter sends is outside the manifest allow-list')
      for (const call of full.state.calls) {
        assert.equal(call.method, backendMethodFor(call.path), `${call.path} rides on its own group`)
        assert.ok(BACKEND_METHODS.includes(call.method))
      }
      assert.ok(new Set(full.state.calls.map((c) => c.method)).size >= 10, 'many different methods, not one api.invoke')
    } finally { api.dispose() }

    // Core without `settings` in the allow-list: settings.* is refused by Core, everything else still works — the allow-list has an effect
    const partial = coreHost(backend, { allow: BACKEND_METHODS.filter((m) => m !== 'settings') })
    const api2 = createPluginLineTodoApi({ host: partial.host, events: { enabled: false }, busyRetry: NO_RETRY })
    try {
      await assert.rejects(api2.settings.get(), (e) => e instanceof PluginBackendError && e.code === 'backend_method_not_allowed')
      assert.equal(typeof (await api2.ping()).ts, 'number')
      assert.deepEqual(partial.state.refusedMethods, ['settings'])
      // a path that belongs to no group never leaves the view
      await assert.rejects(api2.plugin.invoke('driver.postDraft', []), (e) => e instanceof PluginApiError && e.code === 'path_unknown')
      assert.equal(partial.state.calls.some((c) => c.path === 'driver.postDraft'), false)
    } finally { api2.dispose() }
  })
})

// ───────────── G-03 ─────────────

test('G-03: backend:invoke revoked → the call fails at once with accessDenied (no busy retries), the link turns revoked with the right sentence, and recovers on the next success', async () => {
  await withRealBackend(async ({ backend }) => {
    const core = coreHost(backend)
    const api = createPluginLineTodoApi({ host: core.host, events: { enabled: false } })
    const seen = []
    const off = api.plugin.onBackendLink((link) => seen.push(link))
    try {
      assert.deepEqual(api.plugin.backendLink(), { state: 'unknown', code: null })
      await api.ping()
      assert.deepEqual(api.plugin.backendLink(), { state: 'ok', code: null })
      core.state.fail = 'plugin_permission_denied'
      const before = core.state.calls.length
      const error = await api.db.todos.list({}).then(() => null, (e) => e)
      assert.ok(error instanceof PluginBackendError)
      assert.equal(error.code, 'plugin_permission_denied')
      assert.equal(error.accessDenied, true)
      assert.equal(core.state.calls.length - before, 1, 'not retried like a busy backend')
      assert.deepEqual(api.plugin.backendLink(), { state: 'revoked', code: 'plugin_permission_denied' })
      const shown = describeLink(api.plugin.backendLink())
      assert.equal(shown.tone, 'err')
      assert.match(shown.text, /backend:invoke/)
      assert.match(shown.text, /重新允許/)
      assert.doesNotMatch(shown.text, /暫時/, 'not "temporarily interrupted"')
      // disabled plugin: same family, its own sentence
      core.state.fail = 'plugin_disabled'
      await assert.rejects(api.ping(), (e) => e.accessDenied === true)
      assert.match(describeLink(api.plugin.backendLink()).text, /停用/)
      // crashed backend: unavailable, a different (warning) sentence
      core.state.fail = 'plugin_backend_crashed'
      await assert.rejects(api.ping(), (e) => e instanceof PluginBackendError && e.accessDenied === false)
      assert.equal(api.plugin.backendLink().state, 'unavailable')
      assert.equal(describeLink(api.plugin.backendLink()).tone, 'warn')
      // the user allows it again
      core.state.fail = null
      await api.ping()
      assert.deepEqual(api.plugin.backendLink(), { state: 'ok', code: null })
      assert.equal(describeLink(api.plugin.backendLink()), null)
      assert.deepEqual(seen.map((l) => l.state), ['ok', 'revoked', 'revoked', 'unavailable', 'ok'])
    } finally { off(); api.dispose() }
  })
})

test('G-03: the event pump probes a revoked backend at a fixed interval (no endless exponential backoff), reports it, and resyncs the board once access is back', async () => {
  let revoked = true
  let calls = 0
  const diagnostics = []
  const call = async (path) => {
    calls += 1
    if (revoked) throw new PluginBackendError(path, 'plugin_permission_denied')
    if (path === 'events.open') return { sessionId: 's1', seq: 0 }
    if (path === 'events.pull') { await sleep(10); return { events: [], seq: 0, gap: false, closed: false } }
    return { ok: true }
  }
  const pump = new PluginEventPump({ call, waitMs: 10, idleStopMs: 10, backoffBaseMs: 1, backoffMaxMs: 2, accessProbeMs: 60, minLoopMs: 5, onDiagnostic: (d) => diagnostics.push(d) })
  const changed = []
  const off = pump.subscribe('todos-changed', (p) => changed.push(p))
  try {
    await sleep(200)
    // with backoffMaxMs 2 a failing loop would make ~100 calls in 200 ms; the access probe makes one per 60 ms
    assert.ok(calls >= 2 && calls <= 6, `${calls} probes in 200 ms`)
    assert.ok(diagnostics.length > 0 && diagnostics.every((d) => d.kind === 'access' && d.detail === 'plugin_permission_denied'))
    revoked = false
    await until(() => changed.length > 0, { timeout: 1000, message: 'the resync after access came back' })
    assert.deepEqual(changed[0], { createdIds: [], resolvedIds: [], updatedIds: [] }, 'an empty todos-changed makes the board reload')
  } finally { off(); pump.dispose(); await pump.settled() }
})

// ───────────── G-02 ─────────────

test('G-02: every failure becomes one user-facing sentence: revoked / unavailable / version mismatch from host codes; other errors keep their message; guarded() never rethrows', async () => {
  const revoked = describeBackendError(new PluginBackendError('db.todos.list', 'plugin_permission_denied'))
  assert.equal(revoked.kind, 'revoked')
  assert.match(revoked.text, /TeamUQ「我的 AI › 外掛」重新允許/)
  for (const code of ['plugin_backend_unavailable', 'plugin_backend_crashed', 'backend_invoke_timeout', 'job_not_found']) assert.equal(describeBackendError({ code }).kind, 'unavailable', code)
  for (const code of ['backend_method_not_allowed', 'method_mismatch']) assert.match(describeBackendError({ code }).text, /重新安裝外掛/, code)
  assert.equal(describeBackendError(new Error('找不到此待辦')).text, '找不到此待辦')
  assert.equal(describeBackendError(new Error('')).text, '發生未知錯誤')
  assert.equal(backendErrorText({ code: 'plugin_disabled' }, '讀取設定失敗').startsWith('讀取設定失敗：這個外掛目前在 TeamUQ 中是停用狀態'), true)
  const shown = []
  assert.equal(await guarded(async () => { throw new PluginBackendError('settings.get', 'plugin_backend_unavailable') }, (text) => shown.push(text), '讀取設定失敗'), undefined)
  assert.deepEqual(shown, ['讀取設定失敗：外掛後端暫時無法回應（可能正在啟動或忙碌），稍後再試。'])
  assert.equal(await guarded(async () => 7, () => assert.fail('no error')), 7)
})

test('G-02: through the real adapter, a backend that is down rejects every call with a host code (the panels catch it and show describeBackendError), never a silent empty value', async () => {
  await withRealBackend(async ({ backend }) => {
    const core = coreHost(backend)
    const api = createPluginLineTodoApi({ host: core.host, events: { enabled: false }, busyRetry: { attempts: 2, baseMs: 1, maxMs: 2 } })
    try {
      core.state.fail = 'plugin_backend_unavailable'
      for (const run of [() => api.settings.get(), () => api.db.chats.list(true), () => api.db.todos.list({}), () => api.pipeline.status(), () => api.messages.recent(), () => api.line.status()]) {
        const error = await run().then(() => null, (e) => e)
        assert.ok(error instanceof PluginBackendError, 'rejects (the UI shows the reason)')
        assert.equal(describeBackendError(error).kind, 'unavailable')
      }
    } finally { api.dispose() }
  })
})

// ───────────── G-05 ─────────────

test('G-05: longTaskNotes — running shows progress, paused / incomplete / interrupted explain how to resume, done / idle need no note; no host = nothing', () => {
  assert.deepEqual(RESUMABLE_REVIEW_STATES, ['paused', 'incomplete', 'interrupted'])
  const view = (state, running = false) => ({ review: { running, state, summary: `R:${state}`, chatsDone: 1, chatsTotal: 2, resumableMessages: 3 }, mediaBackfill: { running: false, state: 'interrupted', summary: 'B:interrupted' } })
  assert.deepEqual(longTaskNotes(view('running', true)), { reviewRunning: true, reviewText: 'R:running', backfillRunning: false, backfillText: 'B:interrupted' })
  for (const state of ['paused', 'incomplete', 'interrupted']) assert.equal(longTaskNotes(view(state)).reviewText, `R:${state}`)
  for (const state of ['idle', 'done']) assert.equal(longTaskNotes(view(state)).reviewText, null)
  assert.deepEqual(longTaskNotes(null), { reviewRunning: false, reviewText: null, backfillRunning: false, backfillText: null })
})

test('G-05: a review whose backend restarts mid-run: the waiting call ends in job_not_found, and the board explains it with the status the NEW backend read back (interrupted, N/M)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-guide-review-'))
  const statusFile = join(dir, 'review-status.json')
  const ledgerFile = join(dir, 'review-ledger.json')
  const makeDispatcher = (review, runReview) => {
    const hub = new EventHub()
    const fakeApi = { pipeline: { reviewLastDays: runReview } }
    const d = new Dispatcher({ getApi: () => fakeApi, hub, queue: { stats: () => ({}) }, review, softDeadlineMs: 20, maxJobWaitMs: 20, info: () => ({}) })
    return { d, hub }
  }
  // backend #1: the review runs (and never finishes — the process is about to be restarted)
  let fakeNow = 1_000_000
  const clock = () => fakeNow
  const review1 = new ReviewCoordinator({ ledger: new ReviewLedger({ file: ledgerFile, now: clock }), statusFile, now: clock })
  const one = makeDispatcher(review1, () => new Promise(() => undefined))
  const target = { current: one.d }
  const host = {
    backend: { call: async (method, params) => JSON.parse(JSON.stringify(await target.current.call(method, JSON.parse(JSON.stringify(params))))) },
    assets: { url: (p) => p }
  }
  const api = createPluginLineTodoApi({ host, events: { enabled: false }, jobPollWaitMs: 20, extractionConnected: true })
  let two = null
  try {
    const call = api.pipeline.reviewLastDays(2).then(() => null, (e) => e)
    await until(() => review1.status().running, { message: 'the review to start' })
    fakeNow += 10_000 // past the 5 s status-file throttle
    review1.noteProgress({ processed: 4, total: 10, phase: 'extracting' })
    await sleep(60) // the call is now a job being polled
    // the backend restarts: a new process, a new Dispatcher, the status file read back
    const review2 = new ReviewCoordinator({ ledger: new ReviewLedger({ file: ledgerFile, now: clock }), statusFile, now: clock })
    two = makeDispatcher(review2, async () => ({ ok: true }))
    target.current = two.d
    const error = await call
    assert.ok(error instanceof PluginApiError)
    assert.equal(error.code, 'job_not_found', 'the old job id means nothing to the new backend')
    const tasks = await readLongTasks(api)
    assert.equal(tasks.review.state, 'interrupted')
    assert.equal(tasks.review.running, false)
    const explained = await explainInterrupted(api, error, '回顧失敗', 'review')
    assert.match(explained.text, /^回顧失敗：外掛後端在這段期間重新啟動過/)
    assert.match(explained.text, /目前狀態：上次回顧進行中外掛後端重新啟動，沒有做完（已處理 4\/10 個聊天）/)
    // standalone (no longTaskStatus): just the error sentence
    assert.equal((await explainInterrupted({ pipeline: {} }, error, '回顧失敗', 'review')).text, backendErrorText(error, '回顧失敗'))
  } finally {
    api.dispose()
    one.d.dispose(); one.hub.dispose()
    if (two) { two.d.dispose(); two.hub.dispose() }
    rmSync(dir, { recursive: true, force: true })
  }
})

// ───────────── G-01 ─────────────

function fakeMatchMedia(light) {
  const listeners = new Set()
  const mm = (query) => ({ matches: query === '(prefers-color-scheme: light)' ? mm.light : !mm.light, addEventListener: (_t, l) => listeners.add(l), removeEventListener: (_t, l) => listeners.delete(l) })
  mm.light = light
  mm.flip = (next) => { mm.light = next; for (const l of [...listeners]) l() }
  return mm
}
function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return { data, getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) }
}

test('G-01: the plugin follows the OS appearance when there is no manual choice; standalone keeps dark; toggling back to the OS theme drops the manual choice', () => {
  assert.equal(systemTheme(fakeMatchMedia(true)), 'light')
  assert.equal(systemTheme(fakeMatchMedia(false)), 'dark')
  assert.equal(systemTheme(null), 'dark')
  assert.equal(resolveTheme(null, 'light', 'system'), 'light', 'plugin: no manual choice → the OS')
  assert.equal(resolveTheme(null, 'light', 'dark'), 'dark', 'standalone: unchanged default')
  assert.equal(resolveTheme('dark', 'light', 'system'), 'dark', 'a manual choice wins')
  // plugin, OS light: light → dark is a manual choice; dark → light equals the OS → follow the OS again
  assert.deepEqual(toggleChoice('light', 'light', 'system'), { theme: 'dark', store: 'dark' })
  assert.deepEqual(toggleChoice('dark', 'light', 'system'), { theme: 'light', store: null })
  // standalone always remembers (as before)
  assert.deepEqual(toggleChoice('dark', 'light', 'dark'), { theme: 'light', store: 'light' })
  assert.equal(readStoredTheme(fakeStorage({ [THEME_KEY]: 'light' })), 'light')
  assert.equal(readStoredTheme(fakeStorage({ [THEME_KEY]: 'purple' })), null)
  const root = { dataset: {}, style: { colorScheme: '' } }
  applyTheme(root, 'light')
  assert.deepEqual([root.dataset.theme, root.style.colorScheme], ['light', 'light'], 'color-scheme follows too (native controls, scrollbars)')
})

test('G-01: theme-boot.js (before first paint, no inline script) picks the stored choice, else the OS appearance, and sets color-scheme', () => {
  const code = readFileSync(join(ROOT, 'src', 'plugin', 'ui', 'theme-boot.js'), 'utf8')
  const run = ({ stored, light, noMatchMedia = false }) => {
    const documentElement = { dataset: {}, style: {} }
    const storage = fakeStorage(stored ? { 'lt-theme': stored } : {})
    const window = noMatchMedia ? {} : { matchMedia: fakeMatchMedia(light) }
    vm.runInNewContext(code, { localStorage: storage, window, document: { documentElement } })
    return [documentElement.dataset.theme, documentElement.style.colorScheme]
  }
  assert.deepEqual(run({ light: true }), ['light', 'light'])
  assert.deepEqual(run({ light: false }), ['dark', 'dark'])
  assert.deepEqual(run({ stored: 'dark', light: true }), ['dark', 'dark'])
  assert.deepEqual(run({ stored: 'light', light: false }), ['light', 'light'])
  assert.deepEqual(run({ noMatchMedia: true }), ['dark', 'dark'])
  const css = readFileSync(join(ROOT, 'src', 'renderer', 'styles', 'index.css'), 'utf8')
  assert.match(css, /:root \{[^}]*color-scheme: dark;/)
  assert.match(css, /\[data-theme="light"\] \{\s*color-scheme: light;/)
})

// ───────────── G-04 ─────────────

test('G-04: the UI state store saves on change and restores, rejects wrong shapes and expired drafts, never throws; standalone (NO_UI_STATE) saves nothing', () => {
  let now = 1_000
  const storage = fakeStorage()
  const ui = createLocalUiState(storage, { now: () => now })
  const tab = parseOneOf(['board', 'stream'])
  assert.equal(ui.persistent, true)
  assert.equal(ui.read('app.tab', tab), undefined)
  ui.write('app.tab', 'stream')
  assert.equal(JSON.parse(storage.data.get('lt-ui:app.tab')).v, 'stream')
  assert.equal(ui.read('app.tab', tab), 'stream')
  ui.write('app.tab', 'nonsense')
  assert.equal(ui.read('app.tab', tab), undefined, 'a value of the wrong shape is ignored')
  storage.setItem('lt-ui:broken', '{not json')
  assert.equal(ui.read('broken', (x) => x), undefined)
  // drafts expire
  ui.write('card.edit.t1', { title: 'x' })
  now += 10_000
  assert.deepEqual(ui.read('card.edit.t1', (x) => x, { maxAgeMs: 20_000 }), { title: 'x' })
  now += 20_000
  assert.equal(ui.read('card.edit.t1', (x) => x, { maxAgeMs: 20_000 }), undefined)
  assert.equal(storage.data.has('lt-ui:card.edit.t1'), false, 'an expired draft is deleted')
  // sets (the local "read" marks) round-trip, capped
  const ids = new Set(Array.from({ length: 10 }, (_, i) => `t${i}`))
  ui.write('board.viewedLocalIds', serializeStringSet(5)(ids))
  assert.deepEqual([...ui.read('board.viewedLocalIds', parseStringSet(5))], ['t5', 't6', 't7', 't8', 't9'])
  // too big → not written; storage that throws → no throw
  const small = createLocalUiState(storage, { maxValueBytes: 64 })
  small.write('big', 'x'.repeat(100))
  assert.equal(storage.data.has('lt-ui:big'), false)
  const throwing = createLocalUiState({ getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('quota') }, removeItem: () => { throw new Error('denied') } })
  assert.doesNotThrow(() => { throwing.write('a', 1); throwing.remove('a') })
  assert.equal(throwing.read('a', (x) => x), undefined)
  ui.remove('app.tab')
  assert.equal(ui.read('app.tab', tab), undefined)
  // standalone
  assert.equal(NO_UI_STATE.persistent, false)
  NO_UI_STATE.write('app.tab', 'stream')
  assert.equal(NO_UI_STATE.read('app.tab', tab), undefined)
  assert.equal(createLocalUiState(null), NO_UI_STATE)
})

// ───────────── G-06 ─────────────

test('G-06: no backend module reads context.settings (the plugin has no settingsSchema / settings:plugin, so those values are always empty)', () => {
  const dir = join(ROOT, 'src', 'plugin', 'backend')
  const offenders = []
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const code = readFileSync(join(dir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    // the host context's settings (context.settings.get('key')); the app's own settings store (settings.json in dataDir, settings.get()) is fine
    if (/context\s*\.\s*settings|\bsettings\s*\.\s*(?:get|onChange)\s*\(\s*['"`]/.test(code)) offenders.push(name)
  }
  assert.deepEqual(offenders, [])
  const types = readFileSync(join(dir, 'types.ts'), 'utf8')
  const contextBlock = types.slice(types.indexOf('export interface PluginBackendContext'), types.indexOf('}', types.indexOf('export interface PluginBackendContext')))
  assert.doesNotMatch(contextBlock, /settings/, 'the context type has no settings field: reading it would not type-check')
  const manifest = buildManifest({ version: '0.1.2' })
  assert.equal(manifest.settingsSchema, undefined)
  assert.equal(manifest.permissions.includes('settings:plugin'), false)
  assert.deepEqual(manifest.contributes.views.filter((v) => v.presentations.includes('settings')).map((v) => v.id), ['settings'], 'the settings view stays')
})
