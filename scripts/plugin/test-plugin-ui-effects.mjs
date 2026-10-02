// The REAL shared components mounted with the REAL react-dom/client (fixtures/mini-dom.mjs), so effects, state updates and catch blocks run.
// The api is the real plugin adapter behind the Core 1.7.1 gate stand-in (scripts/lib/core-invoke-gate-standin.mjs) and a scripted backend.
//
//   G-02  the catch wiring the tester found untested (tester-evidence §3.2 G02-e…h): SettingsPanel read + write, useTodos.refresh,
//         NotMineReviewPanel.load — each failure must reach the screen, none may become an unhandled rejection
//   N2    a failed long-task status query must not leave the review / backfill buttons disabled forever; a later successful query that still
//         says running makes the state known again (tester r1 §3.1)
//   N1    closing the draft-reply dialog deletes the saved reply draft (LINE-derived text)
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

import { byAttr, byText, install, reactProps, walk } from './fixtures/mini-dom.mjs'
import { createCoreGateStandin } from '../lib/core-invoke-gate-standin.mjs'
import { ROOT } from './build-ui.mjs'

const dom = install() // before react-dom loads
const work = mkdtempSync(join(tmpdir(), 'plugin-ui-effects-'))
test.after(() => { rmSync(work, { recursive: true, force: true }); dom.restore() })

const outfile = join(work, 'ui-effects.mjs')
await build({
  entryPoints: [resolve(ROOT, 'scripts', 'plugin', 'fixtures', 'ui-effects-entry.tsx')],
  outfile, bundle: true, format: 'esm', platform: 'node', target: 'node24', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty' }, logLevel: 'error', absWorkingDir: ROOT,
  banner: { js: "import { createRequire as __r } from 'node:module'; const require = __r(import.meta.url);" },
})
const ui = await import(pathToFileURL(outfile).href)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(predicate, { timeout = 3000, message = 'condition' } = {}) {
  const t0 = Date.now()
  while (!predicate()) {
    if (Date.now() - t0 > timeout) assert.fail(`timed out waiting for ${message}`)
    await sleep(5)
  }
}

/** a scripted plugin backend: `handlers[path](...args)` → the Dispatcher envelope; a thrown `{code,message}` → { ok:false, code, message } */
function scriptedBackend(handlers) {
  const unknown = []
  return {
    unknown,
    async call(_method, params) {
      const handler = handlers[params?.path]
      if (!handler) { unknown.push(params?.path); return { ok: false, code: 'path_unknown', message: params?.path } }
      try { return { ok: true, value: await handler(...(params.args ?? [])) } } catch (error) { return { ok: false, code: error.code ?? 'internal', message: error.message } }
    }
  }
}

function plugin(handlers) {
  const backend = scriptedBackend(handlers)
  const core = createCoreGateStandin(backend, { methods: [...ui.BACKEND_METHOD_GROUPS] })
  const api = ui.createPluginLineTodoApi({ host: core.host, events: { enabled: false }, busyRetry: { attempts: 0 } })
  return { backend, core, api }
}

/** unhandled rejections while `body` runs (a catch that rethrows from an effect ends up here) */
async function collectingUnhandled(body) {
  const seen = []
  const onRejection = (reason) => { seen.push(reason) }
  process.on('unhandledRejection', onRejection)
  try { await body(seen) } finally { await sleep(20); process.off('unhandledRejection', onRejection) }
  return seen
}

const VIEW = {
  pollIntervalSec: 30, concurrency: 2, recentContextLimit: 10,
  blocklist: { nameKeywords: [], senderKeywords: [], contentTypeNoiseOnly: [], minTextLenForLLM: 2 },
  chatIgnoreKeywords: {}, openAtLogin: false, reconcile: { enabled: true, scopeMonths: 0 },
  aiBaseUrl: '', aiProvider: 'http',
  claudeCli: { execPath: '', model: '', timeoutMs: 120000 }, codexCli: { execPath: '', model: '', timeoutMs: 120000 },
  driverPost: { enabled: false, mode: 'fillOnly', verifyReadByDb: true },
  hasApiKey: true, apiKeySource: 'none', safeStorageAvailable: false,
}
const settingsHandlers = (extra = {}) => ({
  'settings.get': () => VIEW,
  'settings.update': (patch) => ({ ...VIEW, ...patch }),
  'db.chats.list': () => [],
  'pipeline.status': () => ({ hasApiKey: true, running: true, busy: false, intervalSec: 30, lastRunAt: null, lineBridge: 'ok' }),
  ...extra
})

// ───────────── G-02: SettingsPanel ─────────────

test('G-02 (effects): SettingsPanel — when Core fences the plugin the read fails, the panel shows 讀取設定失敗：<reason> and 重試 (not 載入設定中… forever); 重試 after Core lets calls through again shows the form', async () => {
  const { core, api } = plugin(settingsHandlers())
  core.setBackendInvokeRevoked(true) // the view opens while backend:invoke is off
  const unhandled = await collectingUnhandled(async () => {
    const view = ui.mount(ui.settingsScene(api))
    try {
      await until(() => byAttr(view.container, 'data-testid', 'settings-load-error'), { message: 'the load-error block' })
      const text = view.container.textContent
      assert.match(text, /讀取設定失敗：TeamUQ 目前不讓這個外掛呼叫後端/)
      assert.doesNotMatch(text, /載入設定中/)
      const retry = byText(view.container, '重試', 'button')
      assert.ok(retry, 'a retry button')
      // allowed again AND the plugin disabled → enabled (the fence only lifts on activate)
      core.setBackendInvokeRevoked(false)
      core.disable(); core.enable()
      reactProps(retry).onClick()
      await until(() => view.container.textContent.includes('輪詢頻率（秒）'), { message: 'the settings form after retry' })
      assert.equal(byAttr(view.container, 'data-testid', 'settings-load-error'), null)
    } finally { view.unmount(); api.dispose() }
  })
  assert.deepEqual(unhandled, [])
})

test('G-02 (effects): SettingsPanel — a write that fails shows 設定沒有儲存：<reason> under the title and keeps the form', async () => {
  const { core, api } = plugin(settingsHandlers())
  const unhandled = await collectingUnhandled(async () => {
    const view = ui.mount(ui.settingsScene(api))
    try {
      await until(() => view.container.textContent.includes('輪詢頻率（秒）'), { message: 'the settings form' })
      const pollInput = () => walk(view.container).find((el) => el.localName === 'input' && reactProps(el).min === 5 && reactProps(el).max === 3600)
      assert.ok(pollInput(), 'the polling interval input')
      core.setBackendInvokeRevoked(true) // the write will be refused by Core
      pollInput().value = '45'
      reactProps(pollInput()).onChange({ target: pollInput(), currentTarget: pollInput() })
      await until(() => reactProps(pollInput()).value === 45, { message: 'the edited value' })
      reactProps(pollInput()).onBlur({ target: pollInput() })
      await until(() => byAttr(view.container, 'data-testid', 'settings-action-error'), { message: 'the write-error block' })
      const shown = byAttr(view.container, 'data-testid', 'settings-action-error').textContent
      assert.match(shown, /^設定沒有儲存：TeamUQ 目前不讓這個外掛呼叫後端/)
      assert.ok(view.container.textContent.includes('輪詢頻率（秒）'), 'the form is still there')
    } finally { view.unmount(); api.dispose() }
  })
  assert.deepEqual(unhandled, [])
})

// ───────────── G-02: useTodos.refresh ─────────────

test('G-02 (effects): useTodos — a board read that fails sets error 讀取待辦失敗：<reason> (the board shows it with 重試); a later successful read clears it', async () => {
  let fail = true
  const todo = { id: 't1', chatId: 'c1', bucket: 'todo', status: 'pending', title: '回覆報價', detail: null, priority: 2, dueAt: null, sourceMsgIds: [], confidence: 0.9, completionEvidence: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', resolvedAt: null }
  const { api } = plugin({
    'db.chats.list': () => [],
    'db.todos.list': () => { if (fail) throw Object.assign(new Error('database is locked'), { code: 'db_busy' }); return [todo] }
  })
  const unhandled = await collectingUnhandled(async () => {
    const view = ui.mount(ui.todosScene(api))
    const errorText = () => byAttr(view.container, 'data-testid', 'todos-error').textContent
    try {
      await until(() => byAttr(view.container, 'data-testid', 'todos-error') && errorText() !== '', { message: 'the board error' })
      assert.match(errorText(), /^讀取待辦失敗：db_busy: database is locked/)
      fail = false
      reactProps(byAttr(view.container, 'data-testid', 'todos-retry')).onClick()
      await until(() => errorText() === '', { message: 'the error cleared by a successful read' })
      assert.equal(byAttr(view.container, 'data-testid', 'todos-count').textContent, '1')
    } finally { view.unmount(); api.dispose() }
  })
  assert.deepEqual(unhandled, [])
})

// ───────────── G-02: NotMineReviewPanel.load ─────────────

test('G-02 (effects): NotMineReviewPanel — a list that cannot be loaded shows 讀取回查清單失敗：<reason>, and nothing becomes an unhandled rejection', async () => {
  const { core, api } = plugin({
    'db.todos.listNotMine': () => [],
    'db.todos.listNotMineCorrections': () => []
  })
  core.setBackendInvokeRevoked(true)
  const unhandled = await collectingUnhandled(async () => {
    const view = ui.mount(ui.notMineScene(api))
    try {
      await until(() => byAttr(view.container, 'role', 'status'), { message: 'the status message', timeout: 1500 })
      assert.match(byAttr(view.container, 'role', 'status').textContent, /^讀取回查清單失敗：TeamUQ 目前不讓這個外掛呼叫後端/)
    } finally { view.unmount(); api.dispose() }
  })
  assert.deepEqual(unhandled.map(String), [], 'no unhandled rejection')
})

// ───────────── review N2: long-task status polling ─────────────

test('N2 (effects): a long-task status query that fails once does not leave the buttons disabled; polling continues with backoff and picks up the real state again', async () => {
  const running = { review: { running: true, state: 'running', summary: 'R:running', chatsDone: 1, chatsTotal: 4, resumableMessages: 0 }, mediaBackfill: { running: true, state: 'running', summary: 'B:running' } }
  const done = { review: { running: false, state: 'done', summary: 'R:done', chatsDone: 4, chatsTotal: 4, resumableMessages: 0 }, mediaBackfill: { running: false, state: 'done', summary: 'B:done' } }
  const answers = ['running', 'running', 'fail', 'fail', 'done']
  let statusCalls = 0
  const { api } = plugin({
    'tasks.status': () => {
      const next = answers[Math.min(statusCalls, answers.length - 1)]
      statusCalls += 1
      if (next === 'fail') throw Object.assign(new Error('status file unreadable'), { code: 'internal' })
      return next === 'running' ? running : done
    },
    'pipeline.status': () => ({ hasApiKey: true }),
    'settings.get': () => VIEW
  })
  const delays = []
  const pollDelayMs = (failures) => { delays.push(failures); return 15 * 2 ** failures }
  let refreshed = 0
  const onRefresh = async () => { refreshed += 1; return true }
  const unhandled = await collectingUnhandled(async () => {
    const view = ui.mount(ui.reviewControlsScene(api, { onRefresh, pollDelayMs }))
    const buttons = () => walk(view.container).filter((el) => el.localName === 'button')
    const reviewButton = () => buttons()[1]
    const backfillButton = () => buttons()[2]
    try {
      await until(() => reviewButton() && reactProps(reviewButton()).disabled === true, { message: 'the review button disabled while the backend runs it' })
      assert.equal(reviewButton().textContent, 'R:running')
      assert.equal(reactProps(backfillButton()).disabled, true)
      // the next status query fails: the buttons are released, the user is told the state is unknown
      await until(() => statusCalls >= 3 && reactProps(reviewButton()).disabled === false, { message: 'the buttons released after a failed query' })
      assert.equal(reactProps(backfillButton()).disabled, false)
      assert.ok(byAttr(view.container, 'data-testid', 'long-task-status-unknown'), 'the "status unknown" note')
      // polling did not stop: it backs off (failures 1, 2) and reads the real state again
      await until(() => statusCalls >= 5, { message: 'polling to continue after failures' })
      assert.ok(delays.includes(1) && delays.includes(2), `backoff by consecutive failures: ${delays.join(',')}`)
      await until(() => view.container.textContent.includes('R:done'), { message: 'the finished review picked up' })
      assert.equal(refreshed, 1, 'the board is reloaded once the review is seen finished')
      assert.equal(byAttr(view.container, 'data-testid', 'long-task-status-unknown'), null)
      assert.equal(reactProps(reviewButton()).disabled, false)
    } finally { view.unmount(); api.dispose() }
  })
  assert.deepEqual(unhandled, [])
})

// Tester r1 §3.1 (mutation T-N2-b; the test is the tester's tester-logs/r1/make-n2-recovery.mjs, plus the backoff-reset check its title names):
// the sequence above ends with `done`, so a success that does not reset the failure count went unnoticed. Here the poll after the failure
// still says running.
test('N2 (effects): after a failed query, a poll that succeeds and still says running makes the state known again — the buttons are disabled again, the "status unknown" note goes away and the backoff starts over', async () => {
  const running = { review: { running: true, state: 'running', summary: 'R:running', chatsDone: 1, chatsTotal: 4, resumableMessages: 0 }, mediaBackfill: { running: true, state: 'running', summary: 'B:running' } }
  const done = { review: { running: false, state: 'done', summary: 'R:done', chatsDone: 4, chatsTotal: 4, resumableMessages: 0 }, mediaBackfill: { running: false, state: 'done', summary: 'B:done' } }
  const answers = ['running', 'fail', 'running', 'running', 'running', 'running', 'running', 'running', 'done']
  let statusCalls = 0
  const { api } = plugin({
    'tasks.status': () => {
      const next = answers[Math.min(statusCalls, answers.length - 1)]
      statusCalls += 1
      if (next === 'fail') throw Object.assign(new Error('status file unreadable'), { code: 'internal' })
      return next === 'running' ? running : done
    },
    'pipeline.status': () => ({ hasApiKey: true }),
    'settings.get': () => VIEW
  })
  const delays = []
  const pollDelayMs = (failures) => { delays.push(failures); return 60 * 2 ** failures }
  const unhandled = await collectingUnhandled(async () => {
    const view = ui.mount(ui.reviewControlsScene(api, { onRefresh: async () => true, pollDelayMs }))
    const buttons = () => walk(view.container).filter((el) => el.localName === 'button')
    const reviewButton = () => buttons()[1]
    const backfillButton = () => buttons()[2]
    try {
      await until(() => reviewButton() && reactProps(reviewButton()).disabled === true, { message: 'disabled while running' })
      await until(() => statusCalls >= 2 && reactProps(reviewButton()).disabled === false && byAttr(view.container, 'data-testid', 'long-task-status-unknown'), { message: 'released + note after the failed query' })
      // the next poll succeeds and the task is STILL running: the state is known again
      await until(() => statusCalls >= 3 && reactProps(reviewButton()).disabled === true && byAttr(view.container, 'data-testid', 'long-task-status-unknown') === null, { message: 'disabled again, note gone, after a successful poll that still says running' })
      assert.equal(reactProps(backfillButton()).disabled, true, 'the backfill button too')
      assert.ok(delays.includes(1), `the failure was counted: ${delays.join(',')}`)
      await until(() => delays.slice(delays.indexOf(1)).includes(0), { message: 'the backoff to start over (failures 0) after the successful poll', timeout: 1500 })
      await until(() => view.container.textContent.includes('R:done'), { message: 'done' })
    } finally { view.unmount(); api.dispose() }
  })
  assert.deepEqual(unhandled, [])
})

// ───────────── review N1: the reply draft is deleted when the dialog is closed ─────────────

test('N1 (effects): the draft-reply dialog restores a saved draft without an AI call, and closing it deletes the saved draft (LINE-derived text)', async () => {
  let drafted = 0
  const { api } = plugin({
    'settings.get': () => VIEW,
    'db.todos.draftReply': () => { drafted += 1; return { draft: 'new' } }
  })
  const data = new Map([['lt-ui:reply.draft.t1', JSON.stringify({ v: '好的，明天下午三點前回覆您。', at: Date.now() })]])
  const storage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, String(v)) }, removeItem: (k) => { data.delete(k) } }
  const todo = { id: 't1', chatId: 'c1', bucket: 'todo', status: 'pending', title: '回覆報價', detail: null, priority: 2, dueAt: null, sourceMsgIds: [], confidence: 0.9, completionEvidence: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', resolvedAt: null }
  let closed = 0
  const unhandled = await collectingUnhandled(async () => {
    const view = ui.mount(ui.draftDialogScene(api, storage, todo, () => { closed += 1 }))
    try {
      await until(() => walk(view.container).some((el) => el.localName === 'textarea'), { message: 'the draft textarea' })
      const area = walk(view.container).find((el) => el.localName === 'textarea')
      assert.equal(reactProps(area).value, '好的，明天下午三點前回覆您。', 'restored from the UI state')
      assert.equal(drafted, 0, 'no AI call for a restored draft')
      assert.ok(data.has('lt-ui:reply.draft.t1'))
      const close = byAttr(view.container, 'aria-label', '關閉對話框')
      reactProps(close).onClick({ target: close })
      assert.equal(closed, 1)
      assert.equal(data.has('lt-ui:reply.draft.t1'), false, 'closing the dialog deletes the saved draft')
    } finally { view.unmount(); api.dispose() }
  })
  assert.deepEqual(unhandled, [])
})
