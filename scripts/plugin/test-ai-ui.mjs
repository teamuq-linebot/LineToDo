// 0.2.0 — the AI as the board and the dialogs see it, through the REAL components (real react-dom + the mini DOM), the REAL view adapter, the Core 1.7.1 invoke-gate stand-in,
// the REAL backend and the Core 1.7.15 host.ai mock. Ported from the Tester's scratch (output/integration/evidence/step-test/scratch-draft-ui.test.mjs).
//   草擬回覆 (success)   the draft is produced by the backend, shown, 複製 puts it on the clipboard; there is no Chrome-send UI left in the dialog; the view never touches host.ai
//   草擬回覆 (refused)   the AI refuses: a message, no fake draft, the dialog still closes
//   status bar (F10)    the one-line AI status is asked again when the board becomes visible again (the events of the hidden time may have been missed)
//   settings (F8)       the settings page says the conversations the AI organises are recorded in TeamUQ's AI history
//   node --experimental-strip-types --experimental-loader=./scripts/ts-test-loader.mjs --test --test-timeout=120000 scripts/plugin/test-ai-ui.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

import { byAttr, byText, install, reactProps, walk } from './fixtures/mini-dom.mjs'
import { createCoreGateStandin } from '../lib/core-invoke-gate-standin.mjs'
import { createMockTuqAi } from '../lib/mock-tuq-ai.mjs'
import { createPluginBackend } from '../../src/plugin/backend/assemble.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
const dom = install()
const work = mkdtempSync(join(tmpdir(), 'ai-ui-'))
test.after(async () => { await new Promise((r) => setTimeout(r, 1800)); rmSync(work, { recursive: true, force: true }); dom.restore() }) // the dialog's 1.5 s copied-label timer must fire before window goes away
const outfile = join(work, 'ui-effects.mjs')
await build({
  entryPoints: [resolve(ROOT, 'scripts', 'plugin', 'fixtures', 'ui-effects-entry.tsx')], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node24', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty' }, logLevel: 'error', absWorkingDir: ROOT,
  banner: { js: "import { createRequire as __r } from 'node:module'; const require = __r(import.meta.url);" }
})
const ui = await import(pathToFileURL(outfile).href)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(predicate, { timeout = 8000, message = 'condition' } = {}) {
  const t0 = Date.now()
  while (!(await predicate())) { if (Date.now() - t0 > timeout) assert.fail(`timed out waiting for ${message}`); await sleep(10) }
}
function fakeLine() {
  const listeners = new Set(); let running = false
  const port = { start() { running = true }, stop() { running = false }, status: () => ({ state: running ? 'running' : 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 }), onMessage(cb) { listeners.add(cb); return () => listeners.delete(cb) }, onStatus() { return () => {} }, getMessagesSince: async () => [] }
  return { port, emit: (m) => listeners.forEach((cb) => cb(m)) }
}
const raw = (i, text) => { const t = 1_700_000_000_000 + i * 1000; return { msgId: `m${i}`, chat: 'Alice', chatId: 'u-alice', isGroup: false, ts: t, time: new Date(t).toISOString(), direction: 'in', sender: 'Alice', text, contentType: 0 } }
const fenced = (v) => '```json\n' + JSON.stringify(v) + '\n```'
const todoFor = (user) => { const p = JSON.parse(user); const f = p.newMessages[0]; const draftRef=`ai_ui_${String(f.msgId).replace(/[^a-z0-9_-]/giu,'_')}`; return { importance: 'action', newTodos: [{ draftRef,bucket: 'todo', title: '寄報價單給客戶', detail: 'x', priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds: [f.msgId] }], identityDecisions:[{draftRef,outcome:'new',candidateType:null,candidateId:null,relationKind:null,reasonCode:'insufficient_evidence',confidenceBand:'high',evidenceMsgIds:[f.msgId]}], resolved: [], updates: [] } }
const textOf = (container) => walk(container).map((e) => e.textContent).join(' ')

async function withDialog(draftReply, body) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ai-ui-data-'))
  const line = fakeLine()
  const ai = createMockTuqAi({ reply: (ctx) => (ctx.system.includes('草擬') ? draftReply(ctx) : fenced(todoFor(ctx.user))) })
  const backend = await createPluginBackend({ pluginId: 'tuqdev.line-todo', version: '4.0.0', dataDir, line: line.port, hostAi: ai.ai, ai: { config: { busyRetryMs: 10, providerRetryMs: 150, optionsTtlMs: 20 }, worker: { pollIntervalMs: 60, unavailableRetryMs: 40 } } })
  const core = createCoreGateStandin(backend, { methods: [...ui.BACKEND_METHOD_GROUPS] })
  const api = ui.createPluginLineTodoApi({ host: { ...core.host }, events: { enabled: false }, busyRetry: { attempts: 0 } })
  const clip = []
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => { clip.push(t) } } }, configurable: true, writable: true })
  try {
    line.emit(raw(1, '請幫我寄報價單給客戶'))
    await api.pipeline.runOnce()
    await until(async () => (await api.db.todos.list()).length === 1, { message: 'a seeded todo' })
    const [todo] = await api.db.todos.list()
    const data = new Map()
    const storage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, String(v)) }, removeItem: (k) => { data.delete(k) } }
    await body({ api, todo, storage, ai, clip })
  } finally { api.dispose(); await backend.dispose(); rmSync(dataDir, { recursive: true, force: true }) }
}

test('草擬回覆 (success): the dialog asks the BACKEND, shows the draft, 複製 writes it to the clipboard; the dialog has no Chrome-send controls; the view never touched host.ai', async () => {
  await withDialog(() => '好的，報價單我今天下午寄出，再請您確認。', async ({ api, todo, storage, ai, clip }) => {
    const view = ui.mount(ui.draftDialogScene(api, storage, todo, () => undefined))
    try {
      await until(() => walk(view.container).some((el) => el.localName === 'textarea'), { message: 'draft textarea' })
      const area = walk(view.container).find((el) => el.localName === 'textarea')
      assert.equal(reactProps(area).value, '好的，報價單我今天下午寄出，再請您確認。')
      assert.equal(ai.stats.turns.filter((t) => t.system.includes('草擬')).length, 1, 'exactly one AI turn made by the backend for the draft')
      const copyBtn = byText(view.container, '複製', 'button')
      assert.ok(copyBtn, 'a 複製 button exists')
      await reactProps(copyBtn).onClick({ target: copyBtn })
      await until(() => clip.length === 1, { message: 'clipboard write' })
      assert.equal(clip[0], '好的，報價單我今天下午寄出，再請您確認。')
      await until(() => byText(view.container, /已複製/, 'button'), { message: '已複製 label' })
      const text = textOf(view.container)
      assert.ok(!/Chrome/.test(text) && !/用 Chrome 發送/.test(text) && !/直接送出/.test(text), 'no Chrome-send wording in the dialog')
      assert.equal(ai.stats.errors.session_limit, 0)
      assert.equal(ai.control.liveSessions(), 0)
    } finally { view.unmount() }
  })
})

test('草擬回覆 (AI refuses): a message is shown, no fake draft, and the dialog can still be closed', async () => {
  await withDialog(() => ({ empty: true }), async ({ api, todo, storage }) => {
    let closed = 0
    const view = ui.mount(ui.draftDialogScene(api, storage, todo, () => { closed += 1 }))
    try {
      await until(() => !/草擬中|產生中|載入/.test(textOf(view.container)) && walk(view.container).length > 5, { message: 'the dialog settled' })
      await sleep(200)
      const area = walk(view.container).find((el) => el.localName === 'textarea')
      assert.ok(!area || reactProps(area).value === '', 'no fabricated draft text')
      assert.match(textOf(view.container), /AI 沒有回覆內容|沒有回覆/, 'the user is told what happened')
      const close = byAttr(view.container, 'aria-label', '關閉對話框')
      reactProps(close).onClick({ target: close })
      assert.equal(closed, 1)
    } finally { view.unmount() }
  })
})

test('F8 settings: the page says the conversations the AI organises are recorded in TeamUQ\'s AI history', async () => {
  await withDialog(() => 'x', async ({ api }) => {
    const view = ui.mount(ui.settingsScene(api))
    try {
      await until(() => byAttr(view.container, 'data-testid', 'ai-by-host'), { message: 'the AI section' })
      assert.match(byAttr(view.container, 'data-testid', 'ai-by-host').textContent, /AI 整理過的對話會記錄在 TeamUQ 的 AI 歷史/)
    } finally { view.unmount() }
  })
})
