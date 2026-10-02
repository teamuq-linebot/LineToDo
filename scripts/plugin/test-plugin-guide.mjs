// TeamUQ plugin developer guide conformance (research-gap-audit G-01…G-07): the view-side modules and the adapter against the real Dispatcher / backend.
//
//   G-07  the backend method allow-list: one method per API namespace; Core's allow-list really limits what reaches the backend
//   G-03  backend:invoke revoked / plugin disabled / call timed out — Core 1.7.1 FENCES the plugin (review B1; Core is played by
//         scripts/lib/core-invoke-gate-standin.mjs, checked against Core's real gate): a distinct link state and message that names the three
//         causes and the actions that work, no promise of automatic recovery, no busy retries, the event pump probes instead of backing off forever
//   G-02  every failure becomes a user-facing sentence (lib/backendError.ts) — revoked / unavailable / version mismatch / other
//   G-05  long tasks: after a backend restart the lost job (job_not_found) is explained with the status the new backend reads back
//   G-01  theme: the OS appearance is the default and is followed; a manual choice can be dropped again; theme-boot.js does the same before first paint
//   G-04  UI state: saved on change, restored on start, expiring drafts, never throws; standalone stays unsaved
//   N1    drafts with LINE-derived text: one retention table, read-time expiry + an active sweep at start and every hour
//   N2    the long-task poll backs off on failure instead of stopping
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
import { BACKEND_INVOKE_TOGGLE_TITLE, backendErrorText, describeBackendError, guarded } from '../../src/renderer/lib/backendError.ts'
import { RESUMABLE_REVIEW_STATES, explainInterrupted, longTaskNotes, longTaskPollDelayMs, readLongTasks } from '../../src/renderer/lib/longTasks.ts'
import { THEME_KEY, applyTheme, readStoredTheme, resolveTheme, systemTheme, toggleChoice } from '../../src/renderer/lib/theme.ts'
import {
  CARD_DRAFT_MAX_AGE_MS, NO_UI_STATE, REPLY_DRAFT_MAX_AGE_MS, UI_DRAFT_RETENTION, UI_DRAFT_SWEEP_INTERVAL_MS,
  browserUiState, createLocalUiState, parseOneOf, parseStringSet, serializeStringSet
} from '../../src/renderer/lib/uiState.ts'
import { PluginEventPump } from '../../src/renderer/platform/pluginEvents.ts'
import { PluginApiError, PluginBackendError, createPluginLineTodoApi } from '../../src/renderer/platform/pluginApi.ts'
import { BACKEND_METHOD_GROUPS, backendMethodFor } from '../../src/shared/pluginWire.ts'
import { BACKEND_METHODS, buildManifest } from './lib/manifest.mjs'
import { ROOT } from './lib/paths.mjs'
import { CORE_INVOKE_LIMITS, createCoreGateStandin } from '../lib/core-invoke-gate-standin.mjs'
import { CORE_BACKEND_INVOKE_TITLE, CORE_PERMISSIONS_SECTION_TITLE, EXPECTED_FENCED_TEXT, EXPECTED_TIMEOUT_TEXT, PLUGIN_PAGE_PLACE_TEXT, RECOVERY_PROMISE, STALE_PERMISSION_NAME, VERSION_SPECIFIC_PLACE } from './lib/fenced-text.mjs'

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

/** Core 1.7.1's invoke gate + view bridge in front of `target` (scripts/lib/core-invoke-gate-standin.mjs: fences like Core, allow-list = the manifest). */
function coreHost(target, { allow = BACKEND_METHODS, timeoutMs } = {}) {
  return createCoreGateStandin(target, { methods: allow, ...(timeoutMs ? { timeoutMs } : {}) })
}

/**
 * Review B1: what the status line / panels say while Core fences the plugin. It must cover all three of Core's fence sources, give the actions that
 * actually work, never promise that allowing the permission again brings it back, and never claim plugin_disabled means "disabled".
 * Tester r1 §3.2: the sentence is compared WORD FOR WORD (a paraphrased promise slipped past the old blacklist); only an "<action>失敗：" prefix may
 * precede it. R1-N1: the switch is named the way TeamUQ's settings page names it.
 */
function assertFencedSentence(text, label) {
  assert.ok(text.endsWith(EXPECTED_FENCED_TEXT), `${label}: the fenced sentence, word for word — got: ${text}`)
  assert.match(text.slice(0, text.length - EXPECTED_FENCED_TEXT.length), /^([^：。]{1,24}：)?$/u, `${label}: nothing but an "<action>失敗：" prefix before it`)
  assert.doesNotMatch(text, RECOVERY_PROMISE, `${label}: no promise of recovery (Core 1.7.1 keeps the fence when the permission is allowed again)`)
  assert.doesNotMatch(text, STALE_PERMISSION_NAME, `${label}: no switch name that TeamUQ's settings page does not show`)
  assert.doesNotMatch(text, /目前在 TeamUQ 中是停用狀態/, `${label}: plugin_disabled is not asserted to mean "disabled"`)
  for (const cause of [`「${CORE_BACKEND_INVOKE_TITLE}」權限（backend:invoke）被關閉`, '外掛被停用', '太久沒有回應而被 TeamUQ 隔離']) assert.ok(text.includes(cause), `${label}: names the fence source ${cause}`)
  assert.ok(text.includes(`請到 ${PLUGIN_PAGE_PLACE_TEXT}，確認「${CORE_PERMISSIONS_SECTION_TITLE}」裡已允許「${CORE_BACKEND_INVOKE_TITLE}」，而且外掛是啟用的`), `${label}: where to go and what to check, with the names TeamUQ 1.6.8 and 1.7.1 both show`)
  // the sentence itself, not the "<action>失敗：" prefix (「讀取設定失敗：」 is about the plugin's own settings)
  assert.doesNotMatch(text.slice(text.length - EXPECTED_FENCED_TEXT.length), VERSION_SPECIFIC_PLACE, `${label}: 0.1.3 — no place that only one TeamUQ version has (「我的 AI › 外掛」 is 1.7.1 only, 「設定 › 外掛」 1.6.8 only)`)
  assert.match(text, /停用再啟用，或重新啟動 TeamUQ/, `${label}: what actually lifts the fence`)
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

// ───────────── G-03 (review B1: Core 1.7.1 fences the plugin) ─────────────

test('G-03 / B1: Core fences on revoke — the call in flight ends plugin_permission_denied, every later call plugin_disabled (no busy retries); allowing the permission again does NOT recover, only activate (disable → enable) does; the status line never promises automatic recovery', async () => {
  await withRealBackend(async ({ backend }) => {
    const held = []
    let hold = false
    // the runtime holds db.todos.list while `hold` is set, so a call is really in flight when the fence comes down
    const runtime = { call: async (method, params) => { if (hold && params?.path === 'db.todos.list') await new Promise((resolve) => held.push(resolve)); return backend.call(method, params) } }
    const core = coreHost(runtime)
    const api = createPluginLineTodoApi({ host: core.host, events: { enabled: false } })
    const seen = []
    const off = api.plugin.onBackendLink((link) => seen.push(`${link.state}:${link.code ?? ''}`))
    const release = () => { hold = false; for (const resolve of held.splice(0)) resolve() }
    try {
      assert.deepEqual(api.plugin.backendLink(), { state: 'unknown', code: null })
      await api.ping()
      assert.deepEqual(api.plugin.backendLink(), { state: 'ok', code: null })

      // 1. the user turns backend:invoke off in 我的 AI › 外掛 while a call is in flight
      hold = true
      const inFlight = api.db.todos.list({}).then(() => null, (e) => e)
      await until(() => core.inFlight === 1, { message: 'db.todos.list in flight' })
      core.setBackendInvokeRevoked(true)
      const error = await inFlight
      assert.ok(error instanceof PluginBackendError)
      assert.equal(error.code, 'plugin_permission_denied')
      assert.equal(error.accessDenied, true)
      assert.deepEqual(api.plugin.backendLink(), { state: 'revoked', code: 'plugin_permission_denied' })
      let shown = describeLink(api.plugin.backendLink())
      assert.equal(shown.tone, 'err')
      assertFencedSentence(shown.text, 'in flight at revoke')

      // 2. every later call: plugin_disabled — Core does not repeat the reason; not retried like a busy backend
      const before = core.state.calls.length
      await assert.rejects(api.ping(), (e) => e instanceof PluginBackendError && e.code === 'plugin_disabled' && e.accessDenied === true)
      assert.equal(core.state.calls.length - before, 1, 'one host call, no busy retries')
      assert.deepEqual(api.plugin.backendLink(), { state: 'revoked', code: 'plugin_disabled' })
      shown = describeLink(api.plugin.backendLink())
      assertFencedSentence(shown.text, 'plugin_disabled after a revoke')

      // 3. the user allows it again: refreshGrants does not activate → still plugin_disabled, the line does not change
      core.setBackendInvokeRevoked(false)
      for (let i = 0; i < 3; i += 1) await assert.rejects(api.ping(), (e) => e.code === 'plugin_disabled')
      assert.deepEqual(api.plugin.backendLink(), { state: 'revoked', code: 'plugin_disabled' })
      assert.equal(describeLink(api.plugin.backendLink()).text, shown.text)

      // 4. disable → enable the plugin (afterEnable → activate): only now does it work again
      core.disable()
      await assert.rejects(api.ping(), (e) => e.code === 'plugin_disabled')
      core.enable()
      release()
      await api.ping()
      assert.deepEqual(api.plugin.backendLink(), { state: 'ok', code: null })
      assert.equal(describeLink(api.plugin.backendLink()), null)

      // 5. one call past Core's deadline: the call ends backend_invoke_timeout and the whole plugin is fenced (not "restarted, try again later")
      hold = true
      const slow = api.db.todos.list({}).then(() => null, (e) => e)
      await until(() => core.inFlight === 1, { message: 'db.todos.list in flight' })
      core.timeoutNow()
      const timedOut = await slow
      assert.equal(timedOut.code, 'backend_invoke_timeout')
      assert.equal(timedOut.accessDenied, true, 'a timeout fences: retrying does not help')
      assert.deepEqual(api.plugin.backendLink(), { state: 'revoked', code: 'backend_invoke_timeout' })
      const timeoutText = describeLink(api.plugin.backendLink()).text
      assert.doesNotMatch(timeoutText, /已重新啟動它|稍後再試。?$/, 'no "restarted, try again later"')
      assert.match(timeoutText, /稍後再試也不會恢復/)
      assert.match(timeoutText, /停用再啟用，或重新啟動 TeamUQ/)
      assert.equal(timeoutText, EXPECTED_TIMEOUT_TEXT, 'the timeout sentence, word for word')
      assert.ok(timeoutText.includes(`請到 ${PLUGIN_PAGE_PLACE_TEXT}，把它停用再啟用`), 'where to go (0.1.3)')
      assert.doesNotMatch(timeoutText, VERSION_SPECIFIC_PLACE, '0.1.3: no place that only one TeamUQ version has')
      assert.doesNotMatch(timeoutText, RECOVERY_PROMISE)
      await assert.rejects(api.ping(), (e) => e.code === 'plugin_disabled')
      assertFencedSentence(describeLink(api.plugin.backendLink()).text, 'plugin_disabled after a timeout')
      core.setBackendInvokeRevoked(false)
      await assert.rejects(api.ping(), (e) => e.code === 'plugin_disabled', 'allowing again does not lift a timeout fence either')
      core.disable(); core.enable()
      release()
      await api.ping()
      assert.equal(api.plugin.backendLink().state, 'ok')

      // 6. a crashed backend is not fenced: unavailable (warning), and the next success clears it
      core.setRuntime({ call: async () => { throw Object.assign(new Error('exited'), { code: 'plugin_backend_exited' }) } })
      await assert.rejects(api.ping(), (e) => e instanceof PluginBackendError && e.code === 'plugin_backend_crashed' && e.accessDenied === false)
      assert.equal(api.plugin.backendLink().state, 'unavailable')
      assert.equal(describeLink(api.plugin.backendLink()).tone, 'warn')
      core.setRuntime(runtime)
      await api.ping()

      assert.deepEqual(seen, [
        'ok:', 'revoked:plugin_permission_denied', 'revoked:plugin_disabled', 'ok:',
        'revoked:backend_invoke_timeout', 'revoked:plugin_disabled', 'ok:', 'unavailable:plugin_backend_crashed', 'ok:'
      ])
      assert.deepEqual(core.state.stops, ['disabled', 'disabled', 'hung', 'disabled'], 'Core stopped the backend on each fence')
    } finally {
      release()
      off(); api.dispose()
    }
  })
})

test('G-03 / B1: the event pump under Core fencing — fixed-interval probes (no endless backoff) that keep getting plugin_disabled after the permission is allowed again (no resync, the line stays); the board resyncs only after activate', async () => {
  await withRealBackend(async ({ backend }) => {
    const core = coreHost(backend)
    const diagnostics = []
    // Tester r1 §3.3: the two regimes must be told apart. The fixed probe (accessProbeMs 60) and the ordinary failure backoff (1000 ms here) are
    // far apart, so a pump that backs off while fenced makes no probe at all in the 300 ms window, and one that loops faster than the probe
    // interval shows up in the gaps between probes.
    const PROBE_MS = 60
    const api = createPluginLineTodoApi({ host: core.host, events: { ...FAST_EVENTS, backoffBaseMs: 1000, backoffMaxMs: 1000, accessProbeMs: PROBE_MS, onDiagnostic: (d) => diagnostics.push({ ...d, at: Date.now() }) } })
    const changed = []
    const off = api.pipeline.onTodosChanged((payload) => changed.push(payload))
    const eventCalls = () => core.state.results.filter((r) => r.path?.startsWith('events.'))
    try {
      await until(() => core.state.results.some((r) => r.path === 'events.pull' && r.ok), { message: 'the event long poll' })
      core.setBackendInvokeRevoked(true)
      await until(() => diagnostics.some((d) => d.kind === 'access'), { message: 'the pump noticing the fence' })
      const atFence = eventCalls().length
      const accessAtFence = diagnostics.filter((d) => d.kind === 'access').length
      await sleep(300)
      const probes = eventCalls().length - atFence
      // fixed 60 ms probe: ~5 calls in 300 ms; the 1000 ms failure backoff: none; a busy loop: dozens
      assert.ok(probes >= 3 && probes <= 7, `fixed-interval probes, not the failure backoff: ${probes} probes in 300 ms`)
      const accessTimes = diagnostics.filter((d) => d.kind === 'access').slice(accessAtFence - 1).map((d) => d.at)
      const gaps = accessTimes.slice(1).map((t, i) => t - accessTimes[i])
      assert.ok(gaps.length >= 3 && gaps.every((gap) => gap >= PROBE_MS - 15), `one probe per accessProbeMs (${PROBE_MS} ms), gaps: ${gaps.join(',')}`)
      assert.equal(diagnostics.filter((d) => d.kind === 'error').length, 0, 'a fence is not handled as an ordinary failure')
      assert.ok(eventCalls().slice(atFence).every((r) => !r.ok && r.error === 'plugin_disabled'), 'after the fence every probe is plugin_disabled')
      assert.ok(diagnostics.filter((d) => d.kind === 'access').every((d) => ['plugin_permission_denied', 'plugin_disabled'].includes(d.detail)))
      assert.equal(api.plugin.backendLink().state, 'revoked')

      // allowed again in 我的 AI › 外掛: Core keeps the fence → still plugin_disabled, no resync, the status line stays
      core.setBackendInvokeRevoked(false)
      const changedBefore = changed.length
      const atAllow = eventCalls().length
      await sleep(300)
      assert.ok(eventCalls().length - atAllow >= 2, 'still probing')
      assert.ok(eventCalls().slice(atAllow).every((r) => !r.ok && r.error === 'plugin_disabled'), 'allowing the permission again does not lift the fence')
      assert.equal(changed.length, changedBefore, 'no resync while Core still fences')
      assert.deepEqual(api.plugin.backendLink(), { state: 'revoked', code: 'plugin_disabled' })

      // disable → enable (activate): the next probe gets through, the session is reopened and the board reloads
      core.disable(); core.enable()
      await until(() => changed.length > changedBefore, { timeout: 2000, message: 'the resync after activate' })
      assert.deepEqual(changed.at(-1), { createdIds: [], resolvedIds: [], updatedIds: [] }, 'an empty todos-changed makes the board reload')
      await until(() => api.plugin.backendLink().state === 'ok', { message: 'the link back to ok' })
    } finally { off(); api.dispose() }
  })
})

test('G-03 / B1 (tester r1 §3.4): the stand-in\'s OWN 30 s deadline — the timer inside the gate, not timeoutNow() — fences the whole plugin like Core\'s timeoutPlugin: every call in flight ends backend_invoke_timeout, the backend is stopped (hung), every later call is plugin_disabled, also after the permission is allowed again, until activate', async (t) => {
  assert.equal(CORE_INVOKE_LIMITS.timeoutMs, 30_000, 'Core 1.7.1 PLUGIN_BACKEND_INVOKE_LIMITS: 30 s per call')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const held = []
  const core = createCoreGateStandin({ call: async (method) => (method === 'hang' ? new Promise((resolve) => held.push(resolve)) : { pong: true }) }, { methods: ['ping', 'hang'] })
  const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)) }
  try {
    const first = core.invokeView('hang', {})
    await flush()
    t.mock.timers.tick(10_000)
    const second = core.invokeView('hang', {}) // admitted 10 s later: its own deadline would be at 40 s
    await flush()
    assert.equal(core.inFlight, 2)
    t.mock.timers.tick(19_999) // 29.999 s after the first call
    await flush()
    assert.equal(core.fenced, false, 'nothing happens before the 30 s deadline')
    assert.equal(core.inFlight, 2)
    t.mock.timers.tick(1) // 30 s: the first call's deadline
    await flush()
    assert.equal(core.fenced, true, 'a call past its deadline fences the plugin (not only that call fails)')
    assert.equal(core.inFlight, 0, 'every call in flight is ended')
    assert.deepEqual(await first, { ok: false, error: 'backend_invoke_timeout' })
    assert.deepEqual(await second, { ok: false, error: 'backend_invoke_timeout' }, 'the other call in flight ends with the timeout too')
    assert.deepEqual(core.state.stops, ['hung'], 'Core stops the hung backend')
    assert.deepEqual(await core.invokeView('ping', {}), { ok: false, error: 'plugin_disabled' })
    for (const resolve of held.splice(0)) resolve({ late: true }) // the backend answering late changes nothing
    await flush()
    core.setBackendInvokeRevoked(false)
    assert.deepEqual(await core.invokeView('ping', {}), { ok: false, error: 'plugin_disabled' }, 'allowing the permission again does not lift a timeout fence')
    core.disable(); core.enable()
    assert.deepEqual(await core.invokeView('ping', {}), { ok: true, value: { pong: true } }, 'disable → enable (activate) does')
    assert.deepEqual(core.state.stops, ['hung', 'disabled'])
  } finally {
    for (const resolve of held.splice(0)) resolve({ late: true })
  }
})

// ───────────── G-02 ─────────────

test('G-02: every failure becomes one user-facing sentence: revoked / unavailable / version mismatch from host codes; other errors keep their message; guarded() never rethrows', async () => {
  const revoked = describeBackendError(new PluginBackendError('db.todos.list', 'plugin_permission_denied'))
  assert.equal(revoked.kind, 'revoked')
  assertFencedSentence(revoked.text, 'plugin_permission_denied')
  // Core 1.7.1 fences on revoke, disable and timeout; after that every call is plugin_disabled (review B1)
  for (const code of ['plugin_permission_denied', 'plugin_disabled', 'backend_invoke_timeout', 'plugin_not_installed']) assert.equal(describeBackendError({ code }).kind, 'revoked', code)
  for (const code of ['plugin_backend_unavailable', 'plugin_backend_crashed', 'job_not_found']) assert.equal(describeBackendError({ code }).kind, 'unavailable', code)
  for (const code of ['backend_method_not_allowed', 'method_mismatch']) assert.match(describeBackendError({ code }).text, /重新安裝外掛/, code)
  assert.equal(describeBackendError(new Error('找不到此待辦')).text, '找不到此待辦')
  assert.equal(describeBackendError(new Error('')).text, '發生未知錯誤')
  const disabled = backendErrorText({ code: 'plugin_disabled' }, '讀取設定失敗')
  assert.ok(disabled.startsWith('讀取設定失敗：TeamUQ 目前不讓這個外掛呼叫後端'), disabled)
  assertFencedSentence(disabled, 'plugin_disabled')
  const shown = []
  assert.equal(await guarded(async () => { throw new PluginBackendError('settings.get', 'plugin_backend_unavailable') }, (text) => shown.push(text), '讀取設定失敗'), undefined)
  assert.deepEqual(shown, ['讀取設定失敗：外掛後端暫時無法回應（可能正在啟動或忙碌），稍後再試。'])
  assert.equal(await guarded(async () => 7, () => assert.fail('no error')), 7)
})

test('R1-N1: the plugin names the backend:invoke switch the way TeamUQ\'s settings page does (「讓畫面和它的背景程式溝通」), nowhere 「後端呼叫」', () => {
  assert.equal(BACKEND_INVOKE_TOGGLE_TITLE, CORE_BACKEND_INVOKE_TITLE, 'Core pluginText.ts PERMISSION_TEXT["backend:invoke"].title')
  assert.equal(describeBackendError({ code: 'plugin_disabled' }).text, EXPECTED_FENCED_TEXT)
  // static: no user-facing string in the plugin sources still calls the switch 「後端呼叫」
  const offenders = []
  const scan = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) scan(full)
      else if (/\.(ts|tsx)$/.test(entry.name) && STALE_PERMISSION_NAME.test(readFileSync(full, 'utf8'))) offenders.push(full)
    }
  }
  scan(join(ROOT, 'src'))
  assert.deepEqual(offenders, [])
})

test('G-02: through the real adapter, a backend that is down rejects every call with a host code (the panels catch it and show describeBackendError), never a silent empty value', async () => {
  // a backend that throws: Core answers plugin_backend_unavailable (backendInvokeGate.ts:159)
  const core = coreHost({ call: async () => { throw new Error('backend down') } })
  const api = createPluginLineTodoApi({ host: core.host, events: { enabled: false }, busyRetry: { attempts: 2, baseMs: 1, maxMs: 2 } })
  try {
    for (const run of [() => api.settings.get(), () => api.db.chats.list(true), () => api.db.todos.list({}), () => api.pipeline.status(), () => api.messages.recent(), () => api.line.status()]) {
      const error = await run().then(() => null, (e) => e)
      assert.ok(error instanceof PluginBackendError, 'rejects (the UI shows the reason)')
      assert.equal(error.code, 'plugin_backend_unavailable')
      assert.equal(describeBackendError(error).kind, 'unavailable')
    }
    assert.ok(core.state.results.every((r) => r.error === 'plugin_backend_unavailable'))
  } finally { api.dispose() }
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

test('N2: the long-task poll never stops — 3 s while queries succeed, doubling per consecutive failure up to 30 s (the board component is exercised in test-plugin-ui-effects.mjs)', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 50].map(longTaskPollDelayMs), [3000, 6000, 12000, 24000, 30000, 30000])
  assert.equal(longTaskPollDelayMs(-1), 3000)
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

// ───────────── review N1: retention of drafts with LINE-derived text ─────────────

/** a localStorage-like store that can be enumerated (key / length), like the real one */
function enumerableStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return { data, getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k), key: (i) => [...data.keys()][i] ?? null, get length() { return data.size } }
}

test('N1: drafts holding LINE-derived text have ONE retention table (cards 7 d, reply 24 h) used both when reading and by an active sweep that also removes drafts nobody will read again; browserUiState sweeps at start and every hour', () => {
  const DAY = 24 * 60 * 60 * 1000
  assert.deepEqual(UI_DRAFT_RETENTION.map((r) => [r.prefix, r.maxAgeMs]), [['card.edit.', 7 * DAY], ['card.kw.', 7 * DAY], ['reply.draft.', DAY]])
  assert.deepEqual([CARD_DRAFT_MAX_AGE_MS, REPLY_DRAFT_MAX_AGE_MS, UI_DRAFT_SWEEP_INTERVAL_MS], [7 * DAY, DAY, 60 * 60 * 1000])
  // the components read with the same numbers, not with private copies
  for (const [file, name] of [['src/renderer/components/Board/TodoCard.tsx', 'CARD_DRAFT_MAX_AGE_MS'], ['src/renderer/components/DraftReplyDialog.tsx', 'REPLY_DRAFT_MAX_AGE_MS']]) {
    const code = readFileSync(join(ROOT, file), 'utf8')
    assert.match(code, new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '[^']*lib/uiState'`), `${file} imports ${name}`)
    assert.doesNotMatch(code, new RegExp(`const ${name}\\s*=`), `${file} has no private ${name}`)
    assert.match(code, new RegExp(`maxAgeMs: ${name}`), `${file} reads with ${name}`)
  }

  // sweep: removes expired / broken drafts of every rule, keeps fresh drafts and everything that is not a draft
  let now = 100 * DAY
  const storage = enumerableStorage()
  const ui = createLocalUiState(storage, { now: () => now })
  const writeAt = (key, value, at) => { const keep = now; now = at; ui.write(key, value); now = keep }
  writeAt('card.edit.done-long-ago', { title: '客戶要的報價單' }, now - 8 * DAY)
  writeAt('card.edit.fresh', { title: '回覆王小姐' }, now - 6 * DAY)
  writeAt('card.kw.old', '報價', now - 8 * DAY)
  writeAt('reply.draft.old', '好的，明天回覆您', now - 25 * 60 * 60 * 1000)
  writeAt('reply.draft.fresh', '收到', now - 23 * 60 * 60 * 1000)
  writeAt('app.tab', 'stream', now - 300 * DAY)
  storage.setItem('lt-ui:reply.draft.broken', '{not json')
  storage.setItem('lt-theme', 'light')
  assert.equal(ui.sweep(UI_DRAFT_RETENTION), 4)
  assert.deepEqual([...storage.data.keys()].sort(), ['lt-theme', 'lt-ui:app.tab', 'lt-ui:card.edit.fresh', 'lt-ui:reply.draft.fresh'])
  assert.equal(NO_UI_STATE.sweep(UI_DRAFT_RETENTION), 0)
  assert.equal(createLocalUiState(fakeStorage()).sweep(UI_DRAFT_RETENTION), 0, 'a storage that cannot be enumerated: nothing to do, no throw')

  // browserUiState (the board view's store): sweeps right away and then every UI_DRAFT_SWEEP_INTERVAL_MS
  const local = enumerableStorage({
    'lt-ui:reply.draft.a': JSON.stringify({ v: 'old reply', at: 0 }),
    'lt-ui:reply.draft.b': JSON.stringify({ v: 'new reply', at: Date.now() })
  })
  const timers = []
  const store = browserUiState({ localStorage: local, setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length } })
  assert.equal(store.persistent, true)
  assert.deepEqual([...local.data.keys()], ['lt-ui:reply.draft.b'], 'swept at start')
  assert.deepEqual(timers.map((t) => t.ms), [UI_DRAFT_SWEEP_INTERVAL_MS])
  local.setItem('lt-ui:card.kw.z', JSON.stringify({ v: 'kw', at: 0 }))
  timers[0].fn()
  assert.deepEqual([...local.data.keys()], ['lt-ui:reply.draft.b'], 'swept again by the hourly timer')
  assert.equal(browserUiState({ get localStorage() { throw new Error('blocked') }, setInterval: () => 0 }), NO_UI_STATE)
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
