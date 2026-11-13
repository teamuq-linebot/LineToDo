// The REAL shared components mounted with the REAL react-dom/client (fixtures/mini-dom.mjs), so effects, state updates and catch blocks run.
// The api is the real plugin adapter behind the Core 1.7.1 gate stand-in (scripts/lib/core-invoke-gate-standin.mjs) and a scripted backend.
//
//   G-02  the catch wiring the tester found untested (tester-evidence §3.2 G02-e…h): SettingsPanel read + write, useTodos.refresh,
//         NotMineReviewPanel.load — each failure must reach the screen, none may become an unhandled rejection
//   N2    a failed long-task status query must not leave the review / backfill buttons disabled forever; a later successful query that still
//         says running makes the state known again (tester r1 §3.1)
//   N1    closing the draft-reply dialog deletes the saved reply draft (LINE-derived text)
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

import { byAttr, byText, install, reactProps, walk } from './fixtures/mini-dom.mjs'
import { createCoreGateStandin } from '../lib/core-invoke-gate-standin.mjs'
import { createMockTuqAi } from '../lib/mock-tuq-ai.mjs'
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
// a polling wait only: it returns as soon as the condition holds, the ceiling just has to survive a starved shared machine (it was 3,000 ms; every test that WAITS for something would be red on a loaded machine)
async function until(predicate, { timeout = 30_000, message = 'condition' } = {}) {
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

const switchByLabel = (view, label) => walk(view.container).find((element) => element.localName === 'input' && element.getAttribute('role') === 'switch' && element.getAttribute('aria-label') === label)
const hasSwitch = (view, label) => switchByLabel(view, label) !== undefined

function plugin(handlers, apiOptions = {}) {
  const backend = scriptedBackend(handlers)
  const core = createCoreGateStandin(backend, { methods: [...ui.BACKEND_METHOD_GROUPS] })
  // 0.2.0: the view has no window.tuqPlugin.ai at all; AI features are backend calls (here: scripted handlers that talk to a mock context.host.ai)
  const api = ui.createPluginLineTodoApi({ host: { ...core.host }, events: { enabled: false }, busyRetry: { attempts: 0 }, ...apiOptions })
  return { backend, core, api }
}

/** What the backend's prompt service does for settings.prompt.refine, against a mock context.host.ai: one complete(), the model's JSON becomes the suggestion. */
const refineThrough = (mock) => async (request) => {
  const reply = await mock.ai.complete({ system: '你是提示詞編輯者。', text: request.goal })
  return { ...JSON.parse(reply.text), modelId: 'gpt-5-codex' }
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
  blocklist: { contentTypeNoiseOnly: [], minTextLenForLLM: 2 },
  chatIgnoreKeywords: {}, openAtLogin: false, reconcile: { enabled: true, scopeMonths: 0 },
  aiBaseUrl: '', aiProvider: 'http',
  claudeCli: { execPath: '', model: '', timeoutMs: 120000 }, codexCli: { execPath: '', model: '', timeoutMs: 120000 },
  driverPost: { enabled: false, mode: 'fillOnly', verifyReadByDb: true },
  hasApiKey: true, apiKeySource: 'none', safeStorageAvailable: false,
}

test('free chat omits its disabled composer while the message reader and active residency status stay in flow', async () => {
  const chat = { chatId: 'composer-synthetic', name: '合成長訊息聊天室', isGroup: false, firstSeenAt: '2026-11-06T02:00:00.000Z', lastSeenAt: '2026-11-06T03:11:00.000Z' }
  const rows = Array.from({ length: 72 }, (_, index) => {
    const ts = Date.UTC(2026, 10, 6, 2, 0) + index * 60_000
    return {
      msgId: `composer-${index}`, chatId: chat.chatId, ts, timeIso: new Date(ts).toISOString(),
      direction: index % 2 === 0 ? 'in' : 'out', sender: chat.name,
      text: index === 71 ? 'synthetic last row 71' : `synthetic row ${index}`,
      contentType: 0, processed: true, ingestedAt: new Date(ts).toISOString(), origFilename: null, fileSize: null, unsent: false
    }
  })
  const { backend, api } = plugin({
    'db.chats.list': () => [chat],
    'db.messages.list': () => [],
    'db.messages.recentByChat': (chatId) => { assert.equal(chatId, chat.chatId); return rows },
    'messages.recent': () => [],
    'line.status': () => ({ state: 'stopped', lastMessageAt: null, messageCount: rows.length, lastError: null, restarts: 0 }),
    'media.avatar.prepareChats': () => ({ paths: {}, names: {} }),
    'settings.chatPrompt.list': () => ({ items: [] }),
    'groupTopics.list': () => ({ ok: true, topics: [] }),
    'groupTopics.pendingCount': () => 0,
    'db.chats.listPrefs': () => ({ prefsReady: true, topicsAvailable: true, pinned: [], hidden: [], todoOff: [], topicsOn: [] }),
    'db.chats.todoExtractEnabled': () => true, 'db.chats.setTodoExtractEnabled': (chatId, enabled) => ({ ok: true, enabled, skippedOlder: 0 }), 'db.todos.openByChat': () => []
  })
  let snapshot = { supported: true, requested: true, level: 'resident', reason: null }
  let onResidency = () => undefined
  const source = {
    residency: async () => snapshot,
    onResidency: (listener) => { onResidency = listener; return () => { onResidency = () => undefined } },
    backendLink: () => ({ state: 'connected', code: null }),
    onBackendLink: () => () => undefined
  }
  const scene = ui.mount(ui.messageWithResidencyScene(api, source))
  const hasClass = (element, name) => (element.getAttribute('class') ?? '').split(/\s+/).includes(name)
  const find = (name) => walk(scene.container).find((element) => hasClass(element, name))
  const paneButton = (label) => walk(scene.container).find((element) => element.localName === 'button' && element.textContent.trim() === label && element.hasAttribute('aria-pressed'))
  try {
    await until(() => find('chat-message-view') && find('residency-status-bar')?.textContent.includes('背景執行中') && scene.container.textContent.includes('synthetic last row 71'), { message: 'the active residency footer, message reader and final synthetic message render together' })
    const layout = find('plugin-root-layout')
    const rendererSlot = find('plugin-renderer-slot')
    const footer = find('residency-status-bar')
    const messageView = find('chat-message-view')
    const messageLog = find('chat-message-log')
    const sendingEntry = walk(scene.container).find((element) => element.localName === 'button' && element.textContent.trim() === '發送・進階')
    const latest = walk(scene.container).find((element) => hasClass(element, 'chat-message') && element.textContent.includes('synthetic last row 71'))
    assert.ok(layout && footer.parentNode === layout, 'the active footer is a direct row in the plugin root layout')
    assert.ok(rendererSlot && rendererSlot.parentNode === layout, 'the renderer has its own flex row above the footer')
    assert.equal(footer.getAttribute('data-residency-level'), 'resident', 'the active background state remains visible')
    assert.ok(messageView && messageLog, 'the chat reader and its internal scroll area remain mounted')
    assert.equal(find('chat-message-composer'), undefined, 'the disabled composer is absent instead of reserving a footer row')
    assert.ok(sendingEntry && typeof reactProps(sendingEntry).onClick === 'function', 'the compact sending entry is an actionable caller')
    assert.ok(scene.container.textContent.includes('發送・進階'), 'sending capability remains discoverable in the pane header')
    assert.ok(walk(latest).some((element) => element.localName === 'time' && element.textContent.trim()), 'the final synthetic message keeps its timestamp in the rendered row')

    assert.deepEqual(backend.unknown, [], 'the synthetic UI made no unmocked backend call')

    snapshot = { supported: true, requested: true, level: 'on-demand', reason: 'resident_not_granted' }
    onResidency(snapshot)
    await until(() => footer.textContent.includes('背景執行尚未開啟'), { message: 'a necessary permission state remains visible in the footer' })
    assert.equal(footer.getAttribute('data-residency-reason'), 'resident_not_granted')

    reactProps(paneButton('議題與待辦')).onClick()
    await until(() => paneButton('議題與待辦')?.getAttribute('aria-pressed') === 'true', { message: 'the selected chat switches to its combined non-message pane' })
    assert.equal(find('chat-message-composer'), undefined, 'the message composer stays absent from the selected chat topics-and-todos pane')
    assert.ok(find('residency-status-bar')?.textContent.includes('背景執行尚未開啟'), 'the warning footer remains visible in other chat panes')
    reactProps(paneButton('訊息')).onClick()
    await until(() => paneButton('訊息')?.getAttribute('aria-pressed') === 'true' && find('chat-message-log'), { message: 'the readable message view returns without a composer' })

    const css = readFileSync(resolve(ROOT, 'src', 'renderer', 'styles', 'index.css'), 'utf8')
    const residency = readFileSync(resolve(ROOT, 'src', 'plugin', 'ui', 'ResidencyStatus.tsx'), 'utf8')
    assert.match(css, /\.plugin-root-layout\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*height:\s*100%/s, 'the plugin root reserves separate vertical rows')
    assert.match(css, /\.plugin-renderer-slot\s*\{[^}]*flex:\s*1 1 auto[^}]*min-height:\s*0/s, 'the renderer uses only the space above the footer')
    assert.match(css, /\.residency-status-bar\s*\{[^}]*flex:\s*0 0 auto[^}]*width:\s*100%/s, 'the residency message retains its own in-flow row')
    assert.match(css, /\.chat-message-view\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*min-height:\s*0/s, 'the message view remains a bounded flex reader')
    assert.match(css, /\.chat-message-log\s*\{[^}]*flex:\s*1[^}]*overflow-y:\s*auto/s, 'the message list keeps its own vertical viewport')
    assert.doesNotMatch(css, /\.chat-message-composer\s*\{/, 'there is no composer footer style reserving blank chat height')
    assert.doesNotMatch(residency, /position:\s*['"]fixed['"]/, 'the status is no longer fixed over message content')
  } finally { scene.unmount(); api.dispose() }
})

const settingsHandlers = (extra = {}) => ({
  'settings.prompt.get': () => ({ initialPrompt: '初始：只抽出明確的待辦。', activePrompt: '初始：只抽出明確的待辦。', customized: false, revision: 'initial', maxChars: 12000, outputFormat: '只輸出固定 JSON 欄位。' }),
  'settings.get': () => VIEW,
  'settings.update': (patch) => ({ ...VIEW, ...patch }),
  'db.chats.list': () => [],
  'pipeline.status': () => ({ hasApiKey: true, running: true, busy: false, intervalSec: 30, lastRunAt: null, lineBridge: 'ok' }),
  ...extra
})

test('chat search finds senders and older messages that are loaded in the selected conversation without searching unloaded history', async () => {
  const bni = { chatId: 'bni', name: 'BNI 商會', isGroup: true, firstSeenAt: new Date(1700000000000).toISOString(), lastSeenAt: new Date(1700000003000).toISOString() }
  const family = { chatId: 'family', name: '家庭群', isGroup: true, firstSeenAt: new Date(1699999000000).toISOString(), lastSeenAt: new Date(1699999000000).toISOString() }
  const message = (chatId, ts, sender, text) => ({
    msgId: `i:${chatId}:${ts}`, chatId, ts, timeIso: new Date(ts).toISOString(), direction: 'in', sender, text,
    contentType: 0, processed: false, ingestedAt: new Date(ts).toISOString(), origFilename: null, fileSize: null, unsent: false
  })
  const older = message('bni', 1700000001000, '王志明', '明天中午前請大家回覆是否出席，也記得帶名片。')
  const latest = message('bni', 1700000003000, '李麗華', '收到，謝謝提醒。')
  const listQueries = []
  const historyQueries = []
  const { api } = plugin({
    'db.chats.list': () => [bni, family],
    'db.messages.list': (query) => { listQueries.push(query); return [] },
    'db.messages.recentByChat': (chatId, limit) => {
      historyQueries.push({ chatId, limit })
      return chatId === 'bni' ? [latest, older] : []
    },
    'messages.recent': () => [],
    'line.status': () => ({ state: 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 })
  })
  let scene
  try {
    scene = ui.mount(ui.messageStreamScene(api))
    const hasClass = (element, name) => (element.getAttribute('class') ?? '').split(/\s+/).includes(name)
    const chatButton = (name) => walk(scene.container).find((element) => hasClass(element, 'chat-list-item') && element.textContent.includes(name))
    const searchInput = () => walk(scene.container).find((element) => element.localName === 'input' && element.getAttribute('type') === 'search')
    await until(() => chatButton('BNI 商會') && scene.container.textContent.includes(older.text), { message: 'BNI history loaded and displayed' })
    assert.ok(scene.container.textContent.includes('搜尋範圍：目前已載入的聊天室名稱、訊息與發話者，不含完整歷史。'))
    assert.equal(chatButton('BNI 商會').getAttribute('aria-pressed'), 'true')
    const marker = walk(scene.container).find((element) => hasClass(element, 'chat-selection-marker'))
    assert.equal(marker?.textContent, '✓', 'selected chat has a visible non-color check marker')
    assert.equal(marker?.getAttribute('aria-hidden'), 'true')

    const search = searchInput()
    assert.ok(search)
    reactProps(search).onChange({ target: { value: '王志明' } })
    await until(() => search.value === '王志明' && chatButton('BNI 商會') && !chatButton('家庭群'), { message: 'sender search returns the loaded BNI conversation' })
    reactProps(search).onChange({ target: { value: '回覆是否出席' } })
    await until(() => search.value === '回覆是否出席' && chatButton('BNI 商會') && !chatButton('家庭群'), { message: 'older loaded message search returns the BNI conversation' })
    reactProps(search).onChange({ target: { value: '尚未載入的完整歷史內容' } })
    await until(() => search.value === '尚未載入的完整歷史內容' && !chatButton('BNI 商會') && !chatButton('家庭群') && scene.container.textContent.includes('找不到符合的聊天室'), { message: 'unloaded history is not searched' })
    assert.deepEqual(listQueries, [{ limit: 1000 }], 'search does not add a backend or full-history query')
    assert.deepEqual(historyQueries, [{ chatId: 'bni', limit: 100 }], 'only the visible selected chat history is loaded')

    const css = readFileSync(resolve(ROOT, 'src', 'renderer', 'styles', 'index.css'), 'utf8')
    assert.match(css, /\.chat-selection-marker\s*\{[^}]*border:\s*1px solid var\(--accent\)[^}]*color:\s*var\(--accent\)/s)
    assert.match(css, /\.chat-list-item:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/s, 'keyboard focus-visible outline remains available')
    assert.match(css, /\[data-theme="light"\][\s\S]*?--accent:\s*#[\da-f]{6}/i, 'the selection marker follows the light theme accent')
  } finally {
    scene?.unmount()
    api.dispose()
  }
})

test('avatar renderer fixture shows the same chat image in list/header and a sender image beside the message', async () => {
  const chatId = 'm-square-fixture'
  const ts = Date.UTC(2026, 9, 30, 3, 0, 0)
  const chat = { chatId, name: chatId, isGroup: true, firstSeenAt: new Date(ts).toISOString(), lastSeenAt: new Date(ts).toISOString() }
  const offscreenChatId = 'm-square-offscreen-fixture'
  const offscreenChat = { ...chat, chatId: offscreenChatId, name: offscreenChatId, firstSeenAt: new Date(ts - 86400000).toISOString(), lastSeenAt: new Date(ts - 86400000).toISOString() }
  const message = { msgId: 'i:42', chatId, ts, timeIso: new Date(ts).toISOString(), direction: 'in', sender: '未知發話者', text: 'fixture message', contentType: 0, processed: true, ingestedAt: new Date(ts).toISOString(), origFilename: null, fileSize: null, unsent: false }
  const called = []
  const { backend, api } = plugin({
    ...settingsHandlers(),
    'db.chats.list': () => [chat, offscreenChat],
    'db.messages.list': () => [],
    'db.messages.recentByChat': () => [message],
    'media.avatar.prepareChats': (ids) => { called.push(['chat', ids]); return { paths: { [chatId]: 'avatar-cache/chat.jpg' }, names: { [chatId]: 'Square 聊天室' } } },
    'media.avatar.prepareMessages': (requestedChatId, ids) => { called.push(['messages', requestedChatId, ids]); return { paths: { 'i:42': 'avatar-cache/member.jpg' }, names: { 'i:42': 'Square 成員' } } },
    'line.status': () => ({ state: 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 })
  })
  let scene
  try {
    scene = ui.mount(ui.messageStreamScene(api))
    await until(() => {
      const imgs = walk(scene.container).filter((el) => el.localName === 'img')
      return imgs.length === 3 && scene.container.textContent.includes('Square 聊天室') && scene.container.textContent.includes('Square 成員')
    }, { message: 'chat/list/header/sender avatar fixture rendered' })
    const imageSources = walk(scene.container).filter((el) => el.localName === 'img').map((el) => el.getAttribute('src'))
    assert.deepEqual(imageSources, [
      'tuqplugin://tuqdev.line-todo/data/avatar-cache/chat.jpg',
      'tuqplugin://tuqdev.line-todo/data/avatar-cache/chat.jpg',
      'tuqplugin://tuqdev.line-todo/data/avatar-cache/member.jpg'
    ])
    const requestedChatIds = called.filter(([kind]) => kind === 'chat').flatMap(([, ids]) => ids)
    assert.ok(requestedChatIds.includes(chatId), 'the active/visible chat avatar is prepared')
    assert.equal(requestedChatIds.includes(offscreenChatId), false, 'initialization does not prepare an offscreen chat avatar')
    assert.equal(called.some(([kind, id]) => kind === 'messages' && id === chatId), true)
    assert.equal(called.some(([kind]) => kind.startsWith('pipeline')), false, 'avatar metadata refresh does not call the AI/pipeline API')
    assert.equal(backend.unknown.includes('media.avatar.prepareChats') || backend.unknown.includes('media.avatar.prepareMessages'), false)
  } finally {
    scene?.unmount()
    api.dispose()
  }
})

test('real img error switches to text fallback and failed source is not retried after remount', async () => {
  const chatId = 'm-image-error-fixture'
  const ts = Date.UTC(2026, 9, 30, 3, 30, 0)
  const chat = { chatId, name: '404 測試群組', isGroup: true, firstSeenAt: new Date(ts).toISOString(), lastSeenAt: new Date(ts).toISOString() }
  const message = { msgId: 'i:404', chatId, ts, timeIso: new Date(ts).toISOString(), direction: 'in', sender: '404 成員', text: 'image error fixture', contentType: 0, processed: true, ingestedAt: new Date(ts).toISOString(), origFilename: null, fileSize: null, unsent: false }
  const calls = { chats: 0, messages: 0 }
  const { api } = plugin({
    ...settingsHandlers(),
    'db.chats.list': () => [chat],
    'db.messages.list': () => [],
    'db.messages.recentByChat': () => [message],
    'media.avatar.prepareChats': () => { calls.chats++; return { paths: { [chatId]: 'avatar-cache/404.jpg' }, names: { [chatId]: chat.name } } },
    'media.avatar.prepareMessages': () => { calls.messages++; return { paths: { [message.msgId]: 'avatar-cache/404.jpg' }, names: { [message.msgId]: message.sender } } },
    'line.status': () => ({ state: 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 })
  })
  let scene
  try {
    scene = ui.mount(ui.messageStreamScene(api))
    await until(() => walk(scene.container).filter((el) => el.localName === 'img').length === 3, { message: 'actual img nodes mounted' })
    const brokenImage = walk(scene.container).find((el) => el.localName === 'img' && el.getAttribute('src').endsWith('/avatar-cache/404.jpg'))
    assert.ok(brokenImage)
    const callsBeforeError = { ...calls }
    const props = reactProps(brokenImage)
    assert.equal(typeof props.onError, 'function')
    props.onError({ currentTarget: brokenImage })
    assert.deepEqual(calls, callsBeforeError, 'the img error handler itself does not call the avatar backend')
    await until(() => !walk(scene.container).includes(brokenImage), { message: 'img error replaces failed node with text fallback' })
    assert.equal(scene.container.textContent.includes('404 測試群組'), true)
    scene.unmount()
    scene = ui.mount(ui.messageStreamScene(api))
    await until(() => scene.container.textContent.includes('404 測試群組'), { message: 'fallback survives renderer remount' })
    assert.equal(walk(scene.container).some((el) => el.localName === 'img' && el.getAttribute('src').endsWith('/avatar-cache/404.jpg')), false)
    assert.equal(walk(scene.container).some((el) => el.localName === 'img' && el.getAttribute('src').endsWith('/avatar-cache/404.jpg')), false)
  } finally {
    scene?.unmount()
    api.dispose()
  }
})

test('avatar zoom: a photo avatar (message sender, chat header) opens a big photo with the name; Esc, backdrop and the close button close it and focus returns; letter avatars and the chat list stay inert', async () => {
  const chatId = 'm-zoom-fixture'
  const letterChatId = 'm-zoom-letter-fixture'
  const ts = Date.UTC(2026, 9, 30, 4, 0, 0)
  const chat = { chatId, name: '放大測試群', isGroup: true, firstSeenAt: new Date(ts).toISOString(), lastSeenAt: new Date(ts).toISOString() }
  const letterChat = { chatId: letterChatId, name: '字母群', isGroup: true, firstSeenAt: new Date(ts - 1000).toISOString(), lastSeenAt: new Date(ts - 1000).toISOString() }
  const row = (msgId, sender) => ({ msgId, chatId, ts, timeIso: new Date(ts).toISOString(), direction: 'in', sender, text: `zoom ${msgId}`, contentType: 0, processed: true, ingestedAt: new Date(ts).toISOString(), origFilename: null, fileSize: null, unsent: false })
  const photoMessage = row('i:z1', '有照片的成員')
  const letterMessage = row('i:z2', '無照片成員')
  const { api } = plugin({
    ...settingsHandlers(),
    'db.chats.list': () => [chat, letterChat],
    'db.messages.list': () => [],
    'db.messages.recentByChat': (id) => id === chatId ? [photoMessage, letterMessage] : [],
    'media.avatar.prepareChats': () => ({ paths: { [chatId]: 'avatar-cache/zoom-chat.jpg' }, names: { [chatId]: chat.name } }),
    'media.avatar.prepareMessages': () => ({ paths: { 'i:z1': 'avatar-cache/zoom-member.jpg' }, names: { 'i:z1': photoMessage.sender, 'i:z2': letterMessage.sender } }),
    'line.status': () => ({ state: 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 })
  })
  const hasClass = (element, name) => (element.getAttribute('class') ?? '').split(/\s+/).includes(name)
  const triggers = (scene) => walk(scene.container).filter((el) => el.localName === 'button' && hasClass(el, 'avatar-zoom-trigger'))
  const dialog = () => walk(dom.document.body).find((el) => el.getAttribute('role') === 'dialog' && hasClass(el, 'avatar-zoom-backdrop')) ?? null
  const keyEvent = (key) => ({ key, preventDefault() {}, stopPropagation() {} })
  const clickEvent = (target, currentTarget = target) => ({ target, currentTarget, preventDefault() {}, stopPropagation() {} })
  let scene
  try {
    scene = ui.mount(ui.messageStreamScene(api))
    await until(() => triggers(scene).length === 2, { message: 'header and sender photo avatars are buttons' })
    const [headerTrigger, senderTrigger] = triggers(scene)
    assert.equal(headerTrigger.getAttribute('aria-label'), chat.name)
    assert.equal(senderTrigger.getAttribute('aria-label'), photoMessage.sender)
    assert.equal(dialog(), null, 'nothing is open before a click')

    // the chat list avatar is not a button: clicking a list row only selects the chat
    const listItem = walk(scene.container).find((el) => hasClass(el, 'chat-list-item') && el.textContent.includes(chat.name))
    assert.ok(listItem)
    assert.equal(walk(listItem).some((el) => el.localName === 'button' && hasClass(el, 'avatar-zoom-trigger')), false)
    assert.equal(walk(listItem).filter((el) => el.localName === 'img').length, 1, 'the list still shows its photo')

    // the sender without a photo stays a letter: no button, no click handler, no pointer-cursor class
    const letterRow = walk(scene.container).find((el) => hasClass(el, 'chat-message') && el.textContent.includes(letterMessage.text))
    const letterAvatar = walk(letterRow).find((el) => hasClass(el, 'chat-message-avatar'))
    assert.ok(letterAvatar)
    assert.equal(letterAvatar.localName, 'span')
    assert.equal(hasClass(letterAvatar, 'avatar-zoom-trigger'), false)
    assert.equal(reactProps(letterAvatar).onClick, undefined)
    assert.equal(letterAvatar.textContent, '無')

    // 1. sender photo: big photo (same file) + name; focus moves in
    reactProps(senderTrigger).onClick()
    await until(() => dialog() !== null, { message: 'sender zoom opened' })
    let box = dialog()
    const photo = walk(box).find((el) => el.localName === 'img')
    assert.equal(photo.getAttribute('src'), 'tuqplugin://tuqdev.line-todo/data/avatar-cache/zoom-member.jpg')
    assert.ok(hasClass(photo, 'avatar-zoom-photo'))
    assert.equal(walk(box).find((el) => hasClass(el, 'avatar-zoom-name')).textContent, photoMessage.sender)
    const closeButton = walk(box).find((el) => el.localName === 'button')
    assert.equal(closeButton.getAttribute('aria-label'), '關閉')
    assert.equal(box.textContent.replace(photoMessage.sender, '').replace('×', ''), '', 'the dialog carries no other text')
    await until(() => dom.document.activeElement === closeButton, { message: 'focus moved into the dialog' })

    // 2a. Esc closes and returns focus to the avatar
    reactProps(box).onKeyDown(keyEvent('Escape'))
    await until(() => dialog() === null, { message: 'Esc closes' })
    assert.equal(dom.document.activeElement, senderTrigger)

    // 2b. backdrop click closes; a click that lands on the photo does not
    reactProps(senderTrigger).onClick()
    await until(() => dialog() !== null, { message: 'reopened' })
    box = dialog()
    reactProps(box).onClick(clickEvent(walk(box).find((el) => el.localName === 'img'), box))
    assert.notEqual(dialog(), null, 'a click on the photo keeps it open')
    reactProps(box).onClick(clickEvent(box))
    await until(() => dialog() === null, { message: 'backdrop click closes' })
    assert.equal(dom.document.activeElement, senderTrigger)

    // 2c. the close button closes; header avatar shows the chat name and its own photo
    reactProps(headerTrigger).onClick()
    await until(() => dialog() !== null, { message: 'header zoom opened' })
    box = dialog()
    assert.equal(walk(box).find((el) => el.localName === 'img').getAttribute('src'), 'tuqplugin://tuqdev.line-todo/data/avatar-cache/zoom-chat.jpg')
    assert.equal(walk(box).find((el) => hasClass(el, 'avatar-zoom-name')).textContent, chat.name)
    reactProps(walk(box).find((el) => el.localName === 'button')).onClick()
    await until(() => dialog() === null, { message: 'close button closes' })
    assert.equal(dom.document.activeElement, headerTrigger)
  } finally {
    scene?.unmount()
    api.dispose()
  }
})

test('avatar fixture keeps readable fallback labels when source images are unavailable', async () => {
  const chatId = 'm-no-avatar-fixture'
  const ts = Date.UTC(2026, 9, 30, 4, 0, 0)
  const chat = { chatId, name: chatId, isGroup: true, firstSeenAt: new Date(ts).toISOString(), lastSeenAt: new Date(ts).toISOString() }
  const message = { msgId: 'i:43', chatId, ts, timeIso: new Date(ts).toISOString(), direction: 'in', sender: '未知發話者', text: 'fallback message', contentType: 0, processed: true, ingestedAt: new Date(ts).toISOString(), origFilename: null, fileSize: null, unsent: false }
  const { api } = plugin({
    ...settingsHandlers(),
    'db.chats.list': () => [chat],
    'db.messages.list': () => [],
    'db.messages.recentByChat': () => [message],
    'media.avatar.prepareChats': () => ({ paths: {}, names: {} }),
    'media.avatar.prepareMessages': () => ({ paths: {}, names: {} }),
    'line.status': () => ({ state: 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 })
  })
  let scene
  try {
    scene = ui.mount(ui.messageStreamScene(api))
    await until(() => scene.container.textContent.includes('未命名群組') && scene.container.textContent.includes('未知發話者'), { message: 'avatar fallback labels rendered' })
    assert.equal(walk(scene.container).some((el) => el.localName === 'img'), false)
    assert.equal(scene.container.textContent.includes(chatId), false, 'opaque room id stays hidden')
  } finally {
    scene?.unmount()
    api.dispose()
  }
})

test('recalled persistence refresh covers all 1001 loaded rows with bounded pages and keeps late updates inside their chat', async () => {
  const ts0 = Date.UTC(2026, 9, 26, 3, 0, 0)
  const chatId = 'c-f1-history-fixture'
  const chat = { chatId, name: 'F1 歷史測試群組', isGroup: true, firstSeenAt: new Date(ts0).toISOString(), lastSeenAt: new Date(ts0 + 1_000_000).toISOString() }
  const rows = Array.from({ length: 1001 }, (_, index) => ({
    msgId: `i:history-${String(index + 1).padStart(4, '0')}`,
    chatId,
    ts: ts0 + index * 1000,
    timeIso: new Date(ts0 + index * 1000).toISOString(),
    direction: 'in',
    sender: '舊歷史測試成員',
    text: index === 0 ? '第 1001 筆已保存原文' : `訊息 ${index + 1}`,
    contentType: 0,
    processed: false,
    ingestedAt: new Date(ts0 + index * 1000).toISOString(),
    origFilename: null,
    fileSize: null,
    unsent: false
  }))
  const cloneRows = (items) => items.map((row) => ({ ...row }))
  const persisted = new Set()
  const refreshQueries = []
  let recentByChatCalls = 0
  const api = {
    db: {
      chats: { list: async () => [chat] },
      messages: {
        list: async (query = {}) => {
          if (query.chatId) refreshQueries.push({ ...query })
          const selected = query.beforeTs == null
            ? rows.slice(-Math.min(query.limit ?? 1000, 1000))
            : rows.filter((row) => row.ts < query.beforeTs).slice(-Math.min(query.limit ?? 100, 1000))
          return cloneRows(selected)
        },
        recentByChat: async (_chatId, limit) => {
          recentByChatCalls += 1
          return cloneRows(rows.slice(-limit))
        }
      },
      onMessagesPersisted: (callback) => { persisted.add(callback); return () => persisted.delete(callback) }
    },
    messages: { recent: async () => [] },
    line: {
      status: async () => ({ state: 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 }),
      onMessage: () => () => undefined,
      onStatus: () => () => undefined
    }
  }
  let scene
  try {
    scene = ui.mount(ui.messageStreamScene(api))
    const hasClass = (element, name) => (element.getAttribute('class') ?? '').split(/\s+/).includes(name)
    const target = rows[0]
    const rowForTarget = () => walk(scene.container).find((element) => hasClass(element, 'chat-message') && element.textContent.includes(target.text))
    const hasRecalledBadge = (row) => walk(row).some((element) => hasClass(element, 'unsent-badge'))
    await until(() => recentByChatCalls >= 1 && persisted.size > 0 && walk(scene.container).some((element) => element.localName === 'button' && element.textContent === '載入較早訊息'), { message: 'initial history and persistence listener are ready' })
    reactProps(walk(scene.container).find((element) => element.localName === 'button' && element.textContent === '載入較早訊息')).onClick()
    await until(() => rowForTarget(), { message: 'the 1001st already-loaded row is rendered' })
    assert.equal(walk(scene.container).filter((element) => hasClass(element, 'chat-message')).length, 1001)
    assert.equal(hasRecalledBadge(rowForTarget()), false)

    const queriesBeforePersistedEvent = refreshQueries.length
    target.unsent = true
    for (const listener of persisted) listener({ chatIds: [chatId], inserted: 0, updated: 1 })
    await until(() => hasRecalledBadge(rowForTarget()), { timeout: 7000, message: 'persisted event refreshes the oldest loaded row' })

    assert.equal(rowForTarget().textContent.includes(target.text), true, 'the saved original text remains rendered')
    assert.equal(recentByChatCalls, 1, 'event refresh does not requery only the latest history page')
    const eventQueries = refreshQueries.slice(queriesBeforePersistedEvent)
    assert.equal(eventQueries.length, 11, '1001 loaded rows were refreshed as 10 full pages and one final row')
    assert.ok(eventQueries.every((query) => query.limit > 0 && query.limit <= 100), 'every event query stays within the existing 100-row UI page size')

    // A delayed response for chat A must update only A's cache after the user switches to B.
    const chatA = { ...chat, chatId: 'c-late-a', name: '延遲更新 A', firstSeenAt: new Date(ts0).toISOString(), lastSeenAt: new Date(ts0 + 5000).toISOString() }
    const chatB = { ...chat, chatId: 'c-late-b', name: '目前聊天室 B', firstSeenAt: new Date(ts0).toISOString(), lastSeenAt: new Date(ts0 + 4000).toISOString() }
    const msgA = { ...rows[0], msgId: 'i:late-a', chatId: chatA.chatId, ts: ts0 + 5000, timeIso: new Date(ts0 + 5000).toISOString(), text: 'A 的已載入原文', unsent: false }
    const msgB = { ...rows[1], msgId: 'i:late-b', chatId: chatB.chatId, ts: ts0 + 4000, timeIso: new Date(ts0 + 4000).toISOString(), text: 'B 的訊息', unsent: false }
    const lateListeners = new Set()
    let lateRefreshQueries = 0
    let releaseLate
    let holdLateA = false
    const lateApi = {
      ...api,
      db: {
        ...api.db,
        chats: { ...api.db.chats, list: async () => [chatA, chatB] },
        messages: {
          ...api.db.messages,
          list: async (query = {}) => {
            if (query.chatId) lateRefreshQueries += 1
            if (query.chatId === chatA.chatId && holdLateA) {
              holdLateA = false
              return await new Promise((resolve) => { releaseLate = () => resolve([{ ...msgA }]) })
            }
            if (query.chatId) return [query.chatId === chatA.chatId ? { ...msgA } : { ...msgB }]
            return [msgA, msgB]
          },
          recentByChat: async (id) => [id === chatA.chatId ? { ...msgA } : { ...msgB }]
        },
        onMessagesPersisted: (callback) => { lateListeners.add(callback); return () => lateListeners.delete(callback) }
      }
    }
    scene.unmount()
    scene = ui.mount(ui.messageStreamScene(lateApi))
    await until(() => scene.container.textContent.includes('A 的已載入原文') && lateListeners.size > 0, { message: 'controlled event listener and A history are ready' })
    holdLateA = true
    msgA.unsent = true
    for (const listener of lateListeners) listener({ chatIds: [chatA.chatId], inserted: 0, updated: 1 })
    await until(() => typeof releaseLate === 'function', { message: 'A refresh query is pending' })
    const buttonB = walk(scene.container).find((element) => hasClass(element, 'chat-list-item') && element.textContent.includes(chatB.name))
    assert.ok(buttonB)
    reactProps(buttonB).onClick()
    await until(() => scene.container.textContent.includes('B 的訊息') && !scene.container.textContent.includes('A 的已載入原文'), { message: 'switch to chat B while A refresh is pending' })
    releaseLate()
    await until(() => scene.container.textContent.includes('B 的訊息'), { message: 'late A response completes without changing B view' })
    assert.equal(walk(scene.container).some((element) => hasClass(element, 'unsent-badge')), false, 'A recalled badge does not leak into B')
    for (const listener of lateListeners) listener({ chatIds: [chatA.chatId], inserted: 0, updated: 1 })
    await until(() => lateRefreshQueries === 2, { message: 'a background-loaded A page still refreshes while B is selected' })
    assert.equal(walk(scene.container).some((element) => hasClass(element, 'unsent-badge')), false, 'refreshing inactive A still leaves B untouched')
    const buttonA = walk(scene.container).find((element) => hasClass(element, 'chat-list-item') && element.textContent.includes(chatA.name))
    assert.ok(buttonA)
    reactProps(buttonA).onClick()
    await until(() => scene.container.textContent.includes('A 的已載入原文') && walk(scene.container).some((element) => hasClass(element, 'unsent-badge')), { message: 'A cache receives its own late recalled update' })
  } finally {
    scene?.unmount()
  }
})

test('MessageStream renders definite missing, ambiguous legacy, and saved whitespace states separately', async () => {
  const ts = Date.UTC(2026, 9, 26, 5, 0, 0)
  const chat = { chatId: 'c-f2-ui', name: 'F2 來源測試群組', isGroup: true, firstSeenAt: new Date(ts).toISOString(), lastSeenAt: new Date(ts + 2000).toISOString() }
  const rows = [
    { msgId: 'i:empty', chatId: chat.chatId, ts, timeIso: new Date(ts).toISOString(), direction: 'in', sender: 'A', text: '', contentType: 0, processed: false, ingestedAt: new Date(ts).toISOString(), origFilename: null, fileSize: null, unsent: true },
    { msgId: 'i:literal', chatId: chat.chatId, ts: ts + 1000, timeIso: new Date(ts + 1000).toISOString(), direction: 'in', sender: 'A', text: '[type=0]', contentType: 0, processed: false, ingestedAt: new Date(ts + 1000).toISOString(), origFilename: null, fileSize: null, unsent: true },
    { msgId: 'i:whitespace', chatId: chat.chatId, ts: ts + 2000, timeIso: new Date(ts + 2000).toISOString(), direction: 'in', sender: 'A', text: '   \t', contentType: 0, processed: false, ingestedAt: new Date(ts + 2000).toISOString(), origFilename: null, fileSize: null, unsent: true }
  ]
  const api = {
    db: {
      chats: { list: async () => [chat] },
      messages: { list: async () => rows, recentByChat: async () => rows },
      onMessagesPersisted: () => () => undefined
    },
    messages: { recent: async () => [] },
    line: {
      status: async () => ({ state: 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 }),
      onMessage: () => () => undefined,
      onStatus: () => () => undefined
    }
  }
  let scene
  try {
    scene = ui.mount(ui.messageStreamScene(api))
    await until(() => scene.container.textContent.includes('未保存收回前內容') && scene.container.textContent.includes('[type=0]') && scene.container.textContent.includes('原文已保存，但內容只有空白字元。'), { message: 'three provenance states render in the conversation' })

    const hasClass = (element, name) => (element.getAttribute('class') ?? '').split(/\s+/).includes(name)
    const literalRow = walk(scene.container).find((element) => hasClass(element, 'chat-message') && element.textContent.includes('[type=0]'))
    const whitespaceRow = walk(scene.container).find((element) => hasClass(element, 'chat-message') && element.textContent.includes('原文已保存，但內容只有空白字元。'))
    assert.ok(literalRow?.textContent.includes('原文無法判定'), 'a preserved literal-looking legacy value carries an uncertainty label')
    assert.ok(!literalRow?.textContent.includes('未保存收回前內容'), 'the ambiguous legacy value is not labeled definitely missing')
    assert.ok(whitespaceRow?.textContent.includes('   \t'), 'the actual whitespace value remains in the rendered text node')
    assert.ok(whitespaceRow?.textContent.includes('原文已保存，但內容只有空白字元。'))
  } finally {
    scene?.unmount()
  }
})

test('prompt settings show the initial prompt, restore drafts, generate a proposal and save it only after adoption', async () => {
  let promptState = { initialPrompt: '初始待辦判斷規則', activePrompt: '初始待辦判斷規則', customized: false, revision: 'initial', maxChars: 12000, outputFormat: '只輸出固定 JSON 欄位。' }
  let saves = 0
  const mock = createMockTuqAi({ reply: () => JSON.stringify({ prompt: 'AI 修正：只將有明確行動與證據的事項當成待辦。', changes: ['排除一般寒暄'] }) })
  const { api } = plugin(settingsHandlers({
    'settings.prompt.get': () => promptState,
    'settings.prompt.refine': refineThrough(mock),
    'settings.prompt.save': ({ prompt, expectedRevision }) => {
      assert.equal(expectedRevision, promptState.revision)
      saves += 1
      promptState = { ...promptState, activePrompt: prompt, customized: true, revision: `saved-${saves}` }
      return promptState
    },
    'settings.prompt.reset': ({ expectedRevision }) => {
      assert.equal(expectedRevision, promptState.revision)
      promptState = { ...promptState, activePrompt: promptState.initialPrompt, customized: false, revision: 'initial' }
      return promptState
    }
  }))
  const data = new Map()
  const storage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) }
  let scene = ui.mount(ui.settingsDraftScene(api, storage))
  const field = (name) => byAttr(scene.container, 'data-testid', name)
  try {
    await until(() => field('active-extract-prompt') && !reactProps(field('active-extract-prompt')).disabled, { message: 'initial prompt loaded' })
    assert.ok(field('initial-prompt').textContent.includes('查看初始 Prompt'))
    reactProps(field('active-extract-prompt')).onChange({ target: { value: '尚未儲存的使用者 prompt' } })
    await until(() => data.has('lt-ui:prompt.editor.draft'), { message: 'prompt draft persisted on change' })
    scene.unmount()
    scene = ui.mount(ui.settingsDraftScene(api, storage))
    await until(() => field('active-extract-prompt') && reactProps(field('active-extract-prompt')).value === '尚未儲存的使用者 prompt', { message: 'draft restored after reopening' })
    assert.equal(saves, 0)
    reactProps(field('refine-prompt')).onClick()
    await until(() => field('prompt-suggestion'), { message: 'AI proposal rendered' })
    assert.equal(saves, 0, 'generating a proposal does not save')
    assert.ok(field('prompt-suggestion').textContent.includes('排除一般寒暄'))
    assert.equal(mock.control.liveSessions(), 0, 'the AI Session was closed')
    scene.unmount()
    scene = ui.mount(ui.settingsDraftScene(api, storage))
    await until(() => field('prompt-suggestion') && field('apply-prompt-suggestion'), { message: 'AI proposal restored' })
    assert.equal(mock.stats.completes, 1, 'restoring a proposal does not invoke AI again')
    reactProps(field('apply-prompt-suggestion')).onClick()
    await until(() => saves === 1 && promptState.activePrompt.startsWith('AI 修正'), { message: 'proposal explicitly adopted' })
    await until(() => field('reset-prompt') && !reactProps(field('reset-prompt')).disabled, { message: 'save finished' })
    reactProps(field('reset-prompt')).onClick()
    await until(() => promptState.activePrompt === promptState.initialPrompt, { message: 'initial prompt restored' })
  } finally { scene.unmount(); api.dispose() }
})

test('editing the prompt while AI is replying makes the old proposal ineligible for adoption', async () => {
  let release
  const hold = new Promise((resolve) => { release = resolve })
  const mock = createMockTuqAi({ reply: () => ({ text: JSON.stringify({ prompt: 'AI 提出的新規則', changes: ['分類更清楚'] }), delay: () => hold }) })
  const { api } = plugin(settingsHandlers({ 'settings.prompt.refine': refineThrough(mock) }))
  const scene = ui.mount(ui.settingsScene(api))
  const field = (name) => byAttr(scene.container, 'data-testid', name)
  try {
    await until(() => field('refine-prompt') && !reactProps(field('refine-prompt')).disabled, { message: 'prompt loaded' })
    reactProps(field('refine-prompt')).onClick()
    await until(() => mock.stats.completes === 1, { message: 'AI request started' })
    reactProps(field('active-extract-prompt')).onChange({ target: { value: '使用者後來改成的內容' } })
    release()
    await until(() => field('apply-prompt-suggestion'), { message: 'proposal arrived' })
    assert.equal(reactProps(field('apply-prompt-suggestion')).disabled, true)
    assert.ok(scene.container.textContent.includes('這份建議以舊內容產生'))
  } finally { release(); scene.unmount(); api.dispose() }
})

test('an AI proposal arriving after leaving the settings tab is restored into the reopened editor', async () => {
  let release
  const hold = new Promise((resolve) => { release = resolve })
  const mock = createMockTuqAi({ reply: () => ({ text: JSON.stringify({ prompt: '離開設定期間產生的建議', changes: ['保留使用者要求的判斷規則'] }), delay: () => hold }) })
  const { api } = plugin(settingsHandlers({ 'settings.prompt.refine': refineThrough(mock) }))
  const data = new Map()
  const storage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) }
  let scene = ui.mount(ui.settingsDraftScene(api, storage))
  const field = (name) => byAttr(scene.container, 'data-testid', name)
  try {
    await until(() => field('refine-prompt') && !reactProps(field('refine-prompt')).disabled, { message: 'editor loaded' })
    reactProps(field('refine-prompt')).onClick()
    await until(() => mock.stats.completes === 1, { message: 'AI request in progress' })
    scene.unmount()
    scene = ui.mount(ui.settingsDraftScene(api, storage))
    await until(() => field('active-extract-prompt'), { message: 'editor reopened during AI work' })
    release()
    await until(() => field('prompt-suggestion'), { message: 'late AI proposal restored' })
    assert.ok(field('prompt-suggestion').textContent.includes('離開設定期間') || walk(field('prompt-suggestion')).some((element) => reactProps(element)?.value === '離開設定期間產生的建議'))
    assert.equal(mock.stats.completes, 1)
    assert.equal(mock.control.liveSessions(), 0)
  } finally { release(); scene.unmount(); api.dispose() }
})

test('TeamUQ AI controls load models, save provider/model/effort and restore them when settings reopen', async () => {
  let savedView = { ...VIEW }
  const patches = []
  const options = async () => ({
    providers: [{ id: 'codex', label: 'Codex', state: 'ready', models: [
      { id: 'default-model', label: '預設模型', efforts: ['low', 'medium'], defaultEffort: 'medium', supportsImages: false, isDefault: true },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna', efforts: ['low', 'high'], defaultEffort: 'low', supportsImages: false, isDefault: false }
    ] }], defaultProviderId: 'codex', limits: { systemChars: 16000, transcriptLines: 40, transcriptChars: 60000, inputChars: 8000, imageBytes: 2097152, turnsPerMinute: 20 }, quota: { state: 'ok', retryAfterMs: null }
  })
  const { api } = plugin({ ...settingsHandlers(),
    'ai.options': options, // the backend's context.host.ai.getOptions()
    'settings.get': () => savedView,
    'settings.update': (patch) => { patches.push(patch); savedView = { ...savedView, ...patch }; return savedView }
  })
  let scene = ui.mount(ui.settingsScene(api))
  const field = (id) => byAttr(scene.container, 'data-testid', id)
  const change = async (id, value, expected) => {
    const element = field(id)
    reactProps(element).onChange({ target: { value } })
    await until(() => JSON.stringify(savedView.pluginAi) === JSON.stringify(expected) && !reactProps(field(id)).disabled, { message: `${id} saved` })
  }
  try {
    await until(() => field('host-ai-model') && !reactProps(field('host-ai-model')).disabled, { message: 'host model list' })
    await change('host-ai-provider', 'codex', { providerId: 'codex', modelId: null, effort: null })
    await change('host-ai-model', 'gpt-6-luna', { providerId: 'codex', modelId: 'gpt-6-luna', effort: null })
    await change('host-ai-effort', 'high', { providerId: 'codex', modelId: 'gpt-6-luna', effort: 'high' })
    assert.equal(patches.length, 3)
    assert.ok(scene.container.textContent.includes('下一項 AI 工作會使用新設定'))
    scene.unmount()
    scene = ui.mount(ui.settingsScene(api))
    await until(() => field('host-ai-model') && reactProps(field('host-ai-model')).value === 'gpt-6-luna', { message: 'model restored' })
    assert.equal(reactProps(field('host-ai-provider')).value, 'codex')
    assert.equal(reactProps(field('host-ai-effort')).value, 'high')
  } finally { scene.unmount(); api.dispose() }
})

test('denied TeamUQ AI access is explained in settings without an unhandled rejection', async () => {
  // the backend answers ai.options with the host's code (no message): the settings screen decides the sentence
  const { api } = plugin(settingsHandlers({ 'ai.options': () => { throw Object.assign(new Error(''), { code: 'not_granted' }) } }))
  let scene
  const errors = await collectingUnhandled(async () => {
    scene = ui.mount(ui.settingsScene(api))
    await until(() => scene.container.textContent.includes('目前無法使用 TeamUQ 的 AI'), { message: 'AI grant explanation' })
    assert.ok(scene.container.textContent.includes('用你的 AI 對話額度回答你'))
    assert.ok(scene.container.textContent.includes('更新可用模型'))
  })
  scene?.unmount()
  api.dispose()
  assert.deepEqual(errors, [])
})

test('settings entry interaction: plugin App opens the shared settings panel, reads and saves settings, reads the saved value again, and returns to the board', async () => {
  let savedView = { ...VIEW }
  const settingsCalls = []
  const { api } = plugin({
    ...settingsHandlers(),
    'settings.get': () => { settingsCalls.push('get'); return savedView },
    'settings.update': (patch) => { settingsCalls.push(['update', patch]); savedView = { ...savedView, ...patch }; return savedView },
    'db.todos.list': () => [],
    'groupTopics.overview': () => [],
  })
  // The mini DOM intentionally models only needed APIs; the real App applies the host theme to this root.
  dom.document.documentElement.dataset ??= {}
  const view = ui.mount(ui.appScene(api))
  const buttons = () => walk(view.container).filter((el) => el.localName === 'button')
  const tab = (label) => buttons().find((el) => el.textContent === label)
  try {
    await until(() => tab('設定'), { message: 'plugin settings tab' })
    reactProps(tab('設定')).onClick()
    await until(() => view.container.textContent.includes('輪詢頻率（秒）'), { message: 'settings panel and settings.get load' })
    assert.ok(settingsCalls.includes('get'), 'opening the panel calls settings.get')

    const pollInput = () => walk(view.container).find((el) => el.localName === 'input' && reactProps(el).min === 5 && reactProps(el).max === 3600)
    await until(() => pollInput(), { message: 'poll interval input' })
    pollInput().value = '45'
    reactProps(pollInput()).onChange({ target: pollInput(), currentTarget: pollInput() })
    await until(() => reactProps(pollInput()).value === 45, { message: 'edited polling interval' })
    reactProps(pollInput()).onBlur({ target: pollInput(), currentTarget: pollInput() })
    await until(() => savedView.pollIntervalSec === 45, { message: 'settings.update persisted the edit' })
    assert.ok(settingsCalls.some((entry) => Array.isArray(entry) && entry[0] === 'update' && entry[1].pollIntervalSec === 45), 'the existing settings.update API receives the patch')

    reactProps(tab('總覽')).onClick()
    await until(() => !view.container.textContent.includes('輪詢頻率（秒）') && tab('總覽'), { message: 'return to board' })
    reactProps(tab('設定')).onClick()
    await until(() => view.container.textContent.includes('輪詢頻率（秒）') && pollInput() && reactProps(pollInput()).value === 45, { message: 'saved settings read back after reopening' })
    assert.ok(settingsCalls.filter((entry) => entry === 'get').length >= 2, 'reopening reads settings.get again')
  } finally {
    view.unmount()
    api.dispose()
    // SettingsPanel's success flash schedules a 1.2s state reset; let that callback finish before this suite restores window/document.
    await sleep(1250)
  }
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
  const unhandled = await collectingUnhandled(async () => {
    const view = ui.mount(ui.opsScene(api, { pollDelayMs }))
    const reviewButton = () => byAttr(view.container, 'data-testid', 'ops-review')
    const backfillButton = () => byAttr(view.container, 'data-testid', 'ops-backfill')
    try {
      await until(() => reviewButton() && reactProps(reviewButton()).disabled === true, { message: 'the review button disabled while the backend runs it' })
      assert.equal(reviewButton().textContent, 'R:running')
      assert.equal(reactProps(backfillButton()).disabled, true)
      // the next status query fails: the buttons are released, the user is told the state is unknown
      await until(() => statusCalls >= 3 && reactProps(reviewButton()).disabled === false, { message: 'the buttons released after a failed query' })
      assert.equal(reactProps(backfillButton()).disabled, false)
      assert.equal(byAttr(view.container, 'data-testid', 'long-task-status-unknown')?.textContent, '暫時查不到進度', 'the short "status unknown" note')
      // polling did not stop: it backs off (failures 1, 2) and reads the real state again
      await until(() => statusCalls >= 5, { message: 'polling to continue after failures' })
      assert.ok(delays.includes(1) && delays.includes(2), `backoff by consecutive failures: ${delays.join(',')}`)
      await until(() => view.container.textContent.includes('R:done'), { message: 'the finished review picked up' })
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
    const view = ui.mount(ui.opsScene(api, { pollDelayMs }))
    const reviewButton = () => byAttr(view.container, 'data-testid', 'ops-review')
    const backfillButton = () => byAttr(view.container, 'data-testid', 'ops-backfill')
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

test('chat todos (effects): direct and group panes stay scoped; loading, failure, retry, empty and late-response states render correctly', async () => {
  const direct = { chatId: 'synthetic-direct', name: '合成單人聊天室', isGroup: false, firstSeenAt: '2026-10-29T00:00:00.000Z', lastSeenAt: '2026-10-30T01:00:00.000Z' }
  const group = { chatId: 'synthetic-group', name: '合成群組聊天室', isGroup: true, firstSeenAt: '2026-10-29T00:00:00.000Z', lastSeenAt: '2026-10-30T00:00:00.000Z' }
  const directTopic = { topicId: 'direct-topic', chatId: direct.chatId, title: '單人聊天室的既有議題', summary: '只屬於單人聊天室的摘要。', evidenceCount: 1, evidenceMsgIds: ['synthetic-direct-source'], userParticipation: 'unknown', relevance: 'unknown', relevanceEvidence: [], participantLowerBound: null, observation: 'unknown', heat: 'unvalidated', trend: 'unknown' }
  const groupTopic = { topicId: 'group-topic', chatId: group.chatId, title: '群組聊天室的既有議題', summary: '只屬於群組聊天室的摘要。', evidenceCount: 1, evidenceMsgIds: ['synthetic-group-source'], userParticipation: 'unknown', relevance: 'unknown', relevanceEvidence: [], participantLowerBound: null, observation: 'unknown', heat: 'unvalidated', trend: 'unknown' }
  let directTopicsEnabled = false
  let deferGroupTopics = false
  let resolveGroupTopicRequest
  const pendingGroupTopicRequest = new Promise((resolve) => { resolveGroupTopicRequest = resolve })
  const topicListQueries = []
  const topicEnableQueries = []
  const topicAnalyzeQueries = []
  const crossTopicQueries = []
  const todo = (id, chatId, title, status = 'pending') => ({
    id, chatId, bucket: status === 'waiting_reply' ? 'waiting' : 'todo', status, title,
    detail: `合成細節：${title}`, priority: 1, dueAt: null, sourceMsgIds: [`synthetic-source-${id}`],
    confidence: 0.9, completionEvidence: status === 'suggested_done' ? '合成完成線索' : null,
    createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z', resolvedAt: null
  })
  const directTodo = todo('direct-1', direct.chatId, '單人聊天室的既有待辦')
  const staleDirectTodo = todo('direct-late', direct.chatId, '延遲的單人聊天室舊回應')
  const groupTodo = todo('group-1', group.chatId, '群組聊天室的既有待辦', 'waiting_reply')
  let resolveDirectRefresh
  let directCalls = 0
  let groupCalls = 0
  const todoQueries = []
  const pendingDirectRefresh = new Promise((resolve) => { resolveDirectRefresh = resolve })
  const { api } = plugin({
    'db.chats.list': () => [direct, group],
    'db.messages.list': () => [],
    'db.messages.recentByChat': () => [],
    'groupTopics.list': (chatId) => {
      topicListQueries.push(chatId)
      if (chatId === direct.chatId) return { ok: directTopicsEnabled, topics: directTopicsEnabled ? [directTopic] : [] }
      if (deferGroupTopics && chatId === group.chatId) return pendingGroupTopicRequest
      return { ok: true, topics: [groupTopic] }
    },
    'groupTopics.setEnabled': (chatId, enabled) => {
      topicEnableQueries.push({ chatId, enabled })
      if (chatId === direct.chatId) directTopicsEnabled = enabled
      return { ok: true }
    },
    'groupTopics.analyze': (chatId) => { topicAnalyzeQueries.push(chatId); return { ok: true, count: 1, analyzedCount: 1 } },
    'groupTopics.pendingCount': (chatId) => { crossTopicQueries.push(`pending:${chatId}`); return chatId === direct.chatId && !directTopicsEnabled ? 1 : 0 },
    'messages.recent': () => [],
    'line.status': () => ({ state: 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 }),
    'db.chats.todoExtractEnabled': () => true, 'db.chats.setTodoExtractEnabled': (chatId, enabled) => ({ ok: true, enabled, skippedOlder: 0 }), 'db.todos.openByChat': (chatId) => {
      todoQueries.push(chatId)
      if (chatId === direct.chatId) {
        directCalls += 1
        if (directCalls === 1) return [directTodo]
        if (directCalls === 2) return pendingDirectRefresh
        return []
      }
      groupCalls += 1
      if (groupCalls === 1) throw Object.assign(new Error('synthetic group todo failure'), { code: 'internal' })
      return [groupTodo]
    }
  })
  const unhandled = await collectingUnhandled(async () => {
    const view = ui.mount(ui.messageStreamScene(api))
    const hasClass = (element, name) => (element.getAttribute('class') ?? '').split(/\s+/).includes(name)
    const paneButton = (label) => walk(view.container).find((element) => element.localName === 'button' && element.textContent.trim() === label && element.hasAttribute('aria-pressed'))
    const chatButton = (name) => walk(view.container).find((element) => hasClass(element, 'chat-list-item') && element.textContent.includes(name))
    const click = (button) => reactProps(button).onClick({ currentTarget: button })
    try {
      await until(() => chatButton(direct.name) && chatButton(group.name), { message: 'both synthetic chats are listed' })
      assert.ok(paneButton('議題與待辦'), 'the chat header has one combined topics-and-todos pane')
      assert.equal(paneButton('議題'), undefined, 'the old separate topics tab is removed')
      assert.equal(paneButton('待辦'), undefined, 'the old separate todos tab is removed')
      assert.equal(paneButton('訊息').getAttribute('aria-pressed'), 'true')

      click(paneButton('議題與待辦'))
      await until(() => topicListQueries.includes(direct.chatId) && hasSwitch(view, '此聊天室的議題開關') && view.container.textContent.includes(directTodo.title), { message: 'the combined pane independently loads direct topics and todos from the selected chat' })
      assert.ok(view.container.textContent.includes('討論紀錄') && view.container.textContent.includes('我的事項'), 'the combined pane names its two areas in plain words')
      assert.equal(view.container.textContent.includes('跨群語意候選'), false, 'direct topics do not expose cross-group controls')
      assert.ok(view.container.textContent.includes(directTodo.title), 'the todo remains visible beside the topic controls')
      assert.deepEqual(topicAnalyzeQueries, [], 'opening the topic pane does not auto-analyze')
      assert.deepEqual(topicEnableQueries, [], 'opening the topic pane does not auto-enable')
      const directEnable = switchByLabel(view, '此聊天室的議題開關')
      assert.ok(directEnable, 'the direct topic enable control renders')
      reactProps(directEnable).onChange({ target: { checked: true } })
      await until(() => topicEnableQueries.some((entry) => entry.chatId === direct.chatId && entry.enabled) && view.container.textContent.includes(directTopic.title), { message: 'enabling direct topics reads existing results for that chat' })
      const directAnalyzeButton = walk(view.container).find((element) => element.localName === 'button' && element.textContent.trim() === '分析最近聊天室訊息')
      // F3：embedded 一律不顯示舊的分析按鈕（直接聊天室也一樣）；手動整理改由「重新整理」控制項負責。
      assert.equal(directAnalyzeButton, undefined, 'the embedded direct chat shows no legacy analyse button')
      assert.deepEqual(topicAnalyzeQueries, [], 'no analysis runs without the removed button')
      assert.ok(view.container.textContent.includes(directTopic.title))
      assert.ok(view.container.textContent.includes(directTodo.title), 'the todo content remains visible while using topic actions')
      assert.ok(crossTopicQueries.every((value) => value.startsWith('pending:')), 'chats never query cross-group authorization or candidates')

      assert.equal(paneButton('議題與待辦').getAttribute('aria-pressed'), 'true')
      assert.ok(view.container.textContent.includes('待辦'))
      assert.ok(view.container.textContent.includes('來源訊息 1 則'))
      assert.ok(view.container.textContent.includes(directTodo.detail), 'complete detail is available on demand')

      click(paneButton('訊息'))
      await until(() => paneButton('訊息')?.getAttribute('aria-pressed') === 'true', { message: 'message pane is selected before reopening todos' })
      click(paneButton('議題與待辦'))
      await until(() => directCalls === 2 && view.container.textContent.includes('正在載入「合成單人聊天室」的待辦'), { message: 'direct refresh enters loading before its delayed reply' })
      click(chatButton(group.name))
      await until(() => groupCalls === 1 && view.container.textContent.includes('讀取此聊天室待辦失敗') && view.container.textContent.includes(groupTopic.title), { message: 'the group todo error is shown independently while its topic loads' })
      assert.ok(view.container.textContent.includes('synthetic group todo failure'), 'the backend failure reason remains visible')
      assert.equal(view.container.textContent.includes(directTodo.title), false, 'the previous chat data is cleared on chat switch')
      assert.equal(view.container.textContent.includes(directTopic.title), false, 'the previous chat topics are cleared on chat switch')
      assert.equal(paneButton('議題與待辦').getAttribute('aria-pressed'), 'true', 'the combined pane follows the selected chat')

      click(walk(view.container).find((element) => element.localName === 'button' && element.textContent.trim() === '重試'))
      await until(() => groupCalls === 2 && view.container.textContent.includes(groupTodo.title), { message: 'retry loads the selected group todos' })
      assert.ok(view.container.textContent.includes('等回覆'), 'existing status semantics remain visible')
      resolveDirectRefresh([staleDirectTodo])
      await sleep(20)
      assert.ok(view.container.textContent.includes(groupTodo.title), 'the current chat remains displayed after the old response arrives')
      assert.equal(view.container.textContent.includes(staleDirectTodo.title), false, 'a late response cannot replace the selected chat data')

      click(chatButton(direct.name))
      await until(() => directCalls === 3 && view.container.textContent.includes('此聊天室目前沒有未完成待辦。'), { message: 'a successful empty result has its own state' })
      assert.equal(view.container.textContent.includes(groupTodo.title), false, 'the group todos do not remain after switching back')

      click(chatButton(group.name))
      deferGroupTopics = true
      await until(() => groupCalls === 3 && view.container.textContent.includes(groupTodo.title) && view.container.textContent.includes('正在載入「合成群組聊天室」的議題'), { message: 'switching back loads group todos while its topic request is pending' })
      assert.equal(view.container.textContent.includes(groupTopic.title), false, 'the delayed group topic result has not appeared early')
      click(chatButton(direct.name))
      await until(() => directCalls === 4 && topicListQueries.filter((chatId) => chatId === direct.chatId).length >= 3 && view.container.textContent.includes(directTopic.title), { message: 'switching back loads the direct chat content for its own chat id' })
      resolveGroupTopicRequest({ ok: true, topics: [groupTopic] })
      await sleep(20)
      assert.ok(view.container.textContent.includes(directTopic.title), 'the current direct chat topic remains visible after a late group response')
      assert.equal(view.container.textContent.includes(groupTopic.title), false, 'a late group response cannot replace direct chat topics')
      assert.ok(topicListQueries.includes(group.chatId) && topicListQueries.includes(direct.chatId), 'both requests use their chat-scoped ids')
      click(paneButton('訊息'))
      await until(() => walk(view.container).some((element) => hasClass(element, 'chat-message-log')), { message: 'the existing message pane still opens' })
      assert.deepEqual(todoQueries, [direct.chatId, direct.chatId, group.chatId, group.chatId, direct.chatId, group.chatId, direct.chatId], 'every read is scoped to the selected chat id')
      assert.ok(crossTopicQueries.every((value) => value.startsWith('pending:')), 'no chat ever makes a cross-group query')

      const css = readFileSync(resolve(ROOT, 'src', 'renderer', 'styles', 'index.css'), 'utf8')
      assert.match(css, /\.chat-topics-todos-content\s*\{[^}]*overflow:\s*auto/s, 'the combined pane scrolls within the chat area')
      assert.match(css, /\.chat-topics-todos-content\s*\{[^}]*padding:\s*16px clamp\(14px, 3cqw, 34px\)/s, 'the combined content padding adapts to the app width (container units: stable under CSS zoom)')
      assert.match(css, /\.chat-topics-todos-content\s*>\s*\.chat-todos-content\s*\{[^}]*border-top:\s*1px solid var\(--border\)/s, 'the two data types remain visually distinct in one scroll area')
      assert.match(css, /@container lt-app \(max-width:\s*420px\)[\s\S]*?\.chat-pane-view-toggle button\s*\{[^}]*white-space:\s*nowrap/s, 'the combined tab label stays on one line on narrow screens')
      assert.match(css, /\.chat-todo-card\s*\{[^}]*cursor:\s*default[^}]*user-select:\s*text/s, 'read-only todo cards do not advertise drag actions')
    } finally { view.unmount(); api.dispose() }
  })
  assert.deepEqual(unhandled, [], 'no unhandled rejection from chat todo loading or the late response')
})

test('chat topics and todos (effects): a topic read failure does not hide selected-chat todos, and both recover independently', async () => {
  const chat = { chatId: 'synthetic-independent', name: '合成隔離聊天室', isGroup: false, firstSeenAt: '2026-10-29T00:00:00.000Z', lastSeenAt: '2026-10-30T00:00:00.000Z' }
  const topic = { topicId: 'independent-topic', chatId: chat.chatId, title: '合成議題', summary: '只屬於目前聊天室的議題。', lastSourceTs: new Date(2026, 9, 30, 8, 5).getTime(), evidenceCount: 1, evidenceMsgIds: ['synthetic-independent-source'], userParticipation: 'unknown', relevance: 'unknown', relevanceEvidence: [], participantLowerBound: null, observation: 'unknown', heat: 'unvalidated', trend: 'unknown' }
  const todo = { id: 'independent-todo', chatId: chat.chatId, bucket: 'todo', status: 'pending', title: '合成待辦', detail: null, priority: 1, dueAt: null, sourceMsgIds: ['synthetic-independent-source'], confidence: 0.9, completionEvidence: null, createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z', resolvedAt: null }
  let failTopics = true
  let topicReads = 0
  let todoReads = 0
  const { api } = plugin({
    'db.chats.list': () => [chat],
    'db.messages.list': () => [],
    'db.messages.recentByChat': () => [],
    'messages.recent': () => [],
    'line.status': () => ({ state: 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 }),
    'groupTopics.list': () => {
      topicReads += 1
      if (failTopics) throw Object.assign(new Error('synthetic topic read failure'), { code: 'internal' })
      return { ok: true, topics: [topic] }
    },
    'groupTopics.pendingCount': () => 0,
    'db.chats.todoExtractEnabled': () => true, 'db.chats.setTodoExtractEnabled': (chatId, enabled) => ({ ok: true, enabled, skippedOlder: 0 }), 'db.todos.openByChat': (chatId) => { assert.equal(chatId, chat.chatId); todoReads += 1; return [todo] }
  })
  const view = ui.mount(ui.messageStreamScene(api))
  const paneButton = (label) => walk(view.container).find((element) => element.localName === 'button' && element.textContent.trim() === label && element.hasAttribute('aria-pressed'))
  const click = (button) => reactProps(button).onClick({ currentTarget: button })
  try {
    await until(() => paneButton('議題與待辦'), { message: 'the selected-chat combined pane is available' })
    click(paneButton('議題與待辦'))
    await until(() => view.container.textContent.includes('synthetic topic read failure') && view.container.textContent.includes(todo.title), { message: 'topic error and todo content render independently' })
    assert.equal(view.container.textContent.includes(topic.title), false, 'a failed topic read does not invent topic data')
    assert.equal(todoReads, 1, 'the healthy todos are read once before retrying topics')
    const retry = walk(view.container).find((element) => element.localName === 'button' && element.textContent.trim() === '重試議題')
    assert.ok(retry, 'the topic load error exposes its own in-place retry button')

    failTopics = false
    click(retry)
    await until(() => topicReads === 2 && view.container.textContent.includes(topic.title) && view.container.textContent.includes(todo.title), { timeout: 5000, message: 'the topic panel recovers in place while the todo remains visible' })
    assert.equal(view.container.textContent.includes('synthetic topic read failure'), false, 'the old topic error clears after a successful read')
    assert.equal(todoReads, 1, 'topic retry does not issue another db.todos.openByChat call')
    assert.equal(view.container.textContent.includes('正在載入「合成隔離聊天室」的待辦'), false, 'topic retry does not put the healthy todo panel into loading')

    const topicCard = walk(view.container).find((element) => element.localName === 'article' && element.textContent.includes(topic.title))
    assert.ok(!byAttr(topicCard, 'data-testid', 'group-topic-status'), 'the old participation / relevance / heat / trend status line is gone')
    const detailNodes = new Set(walk(byAttr(topicCard, 'data-testid', 'group-topic-details')))
    const visibleSmall = walk(topicCard).filter((element) => element.localName === 'small' && !detailNodes.has(element)).map((element) => element.textContent).join(' ')
    for (const old of ['參與不確定', '參與已確認', '關聯未驗證', '熱度未校準', '趨勢不確定']) assert.equal(visibleSmall.includes(old), false, `the topic card face no longer says ${old}`)
    const meta = byAttr(topicCard, 'data-testid', 'group-topic-meta')
    assert.ok(meta, 'the topic card shows its last-update time and message count instead')
    assert.equal(meta.textContent, '最後更新 10/30 08:05 · 1 則訊息')
    assert.equal(meta.textContent.includes('已知參與者下界'), false, 'the detailed participant metric is on demand')
    assert.equal(hasClassName(topicCard, 'todo-card'), false, 'a topic card is not styled as a todo card')
    const pane = walk(view.container).find((element) => hasClassName(element, 'chat-topics-todos-content'))
    const headings = walk(pane).filter((element) => element.localName === 'h3').map((element) => element.textContent.trim())
    assert.deepEqual(headings, ['討論紀錄', '我的事項'], 'the two areas carry the plain-language headings and nothing else')
    assert.equal(walk(pane).some((element) => element.localName === 'details' && hasClassName(element, 'group-topics-help')), false, 'the combined pane adds no explanatory block')
    assert.equal(walk(pane).filter((element) => element.localName === 'section' && (hasClassName(element, 'group-topics-panel') || hasClassName(element, 'chat-todos-content'))).length, 2, 'the pane holds exactly the two areas')
    assert.ok(walk(pane).some((element) => hasClassName(element, 'todo-card')), 'the todo area keeps task-style cards')
    assert.equal(walk(topicCard).some((element) => element.localName === 'input'), false, 'a topic card has no checkbox or task control')
    assert.equal(byAttr(topicCard, 'data-testid', 'group-topic-details'), undefined, 'quality and source details are not rendered in the discussion list')
    assert.equal(topicCard.textContent.includes('品質與來源細節'), false)
    assert.equal(topicCard.textContent.includes('檢查既有待辦關聯'), false)
  } finally { view.unmount(); api.dispose() }
})

// ───────────── WP-C: the chat list does not wait for auxiliary calls; phase wording; timeout + retry; diagnostics (all non-device: mini-dom + scripted host) ─────────────

const hasClassName = (element, name) => (element.getAttribute('class') ?? '').split(/\s+/).includes(name)
const streamStatusText = (scene) => walk(scene.container).find((element) => hasClassName(element, 'stream-status'))?.textContent ?? ''
const retryButtons = (scene) => walk(scene.container).filter((element) => element.localName === 'button' && element.textContent.trim() === '重試')
const chatItem = (scene, name) => walk(scene.container).find((element) => hasClassName(element, 'chat-list-item') && element.textContent.includes(name))
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const wpChat = (chatId, name) => ({ chatId, name, isGroup: true, firstSeenAt: new Date(1700000000000).toISOString(), lastSeenAt: new Date(1700000003000).toISOString() })
const STOPPED = { state: 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 }

test('WP-C acceptance 5 (non-device): with ai.status, 100 avatar batches and a long poll holding the auxiliary lanes, the chat list appears in < 1 s', async () => {
  const release = deferred()
  const calls = []
  const { api } = plugin({
    'db.chats.list': async () => { calls.push('db.chats.list'); await sleep(5); return [wpChat('bni', 'BNI 商會'), wpChat('family', '家庭群')] },
    'db.messages.list': async () => { await sleep(5); return [] },
    'db.messages.recentByChat': async () => [],
    'messages.recent': async () => [],
    'line.status': async () => { await sleep(5); return STOPPED },
    'ai.status': async () => { await sleep(2500); await release.promise; return { state: 'ready' } },
    'media.avatar.prepareChats': async () => { await release.promise; return { paths: {}, names: {} } },
    'media.avatar.prepareMessages': async () => { await release.promise; return { paths: {}, names: {} } },
    'events.pull': async () => { await release.promise; return { events: [] } }
  })
  const pending = []
  let scene
  try {
    pending.push(api.plugin.aiStatus({ refresh: true }))
    for (let i = 0; i < 100; i += 1) pending.push(api.media.avatarUrls([`avatar-${i}`]))
    pending.push(api.plugin.invoke('events.pull', [{ sessionId: 's', afterSeq: 0, waitMs: 0 }]))
    await until(() => api.plugin.transportStats().lanes.bulk.active === 1 && api.plugin.transportStats().lanes.events.active === 1, { message: 'bulk and events lanes saturated' })
    assert.ok(api.plugin.transportStats().lanes.bulk.waiting >= 100, 'the avatar batches are queued behind each other, not in front of the chat list')
    const t0 = Date.now()
    scene = ui.mount(ui.messageStreamScene(api))
    await until(() => chatItem(scene, 'BNI 商會') && chatItem(scene, '家庭群'), { timeout: 1000, message: 'the chat list' })
    const shownAfter = Date.now() - t0
    assert.ok(shownAfter < 1000, `the chat list appeared after ${shownAfter} ms (harness threshold 1000 ms; not measured on the device)`)
    await until(() => streamStatusText(scene).includes('已停止'), { timeout: 1000, message: 'line.status answered' })
    assert.deepEqual(retryButtons(scene), [], 'nothing failed: no retry')
    assert.ok(calls.length >= 1)
  } finally {
    release.resolve()
    scene?.unmount()
    api.dispose()
    for (const p of pending) p.catch(() => undefined)
  }
})

test('WP-C acceptance 5 (non-device): cold start — ping unanswered for 6 s shows 連線中 then 後端啟動中 (no retry, no error), and the list appears right after the backend is up', async () => {
  const started = deferred()
  let releasedAt = 0
  const timer = setTimeout(() => { releasedAt = Date.now(); started.resolve() }, 6000)
  const afterStart = (value) => async () => { await started.promise; return value }
  const chat = wpChat('bni', 'BNI 商會')
  const { api } = plugin({
    ping: afterStart({ version: 'cold' }), 'line.status': afterStart(STOPPED), 'db.chats.list': afterStart([chat]), 'db.messages.list': afterStart([]),
    'db.messages.recentByChat': async () => [], 'messages.recent': afterStart([])
  })
  let scene
  try {
    const t0 = Date.now()
    void api.ping().catch(() => undefined) // bootBoard sends ping first
    scene = ui.mount(ui.messageStreamScene(api))
    await sleep(300)
    assert.ok(streamStatusText(scene).includes('連線中…'), `first second: ${streamStatusText(scene)}`)
    assert.equal(streamStatusText(scene).includes('後端啟動中'), false, 'not starting yet (ping was sent less than 1.2 s ago)')
    await until(() => streamStatusText(scene).includes('後端啟動中…（首次開啟需要數秒）'), { timeout: 3000, message: 'starting wording after 1.2 s' })
    assert.ok(Date.now() - t0 >= 1100, 'the starting wording needs ping to be unanswered for 1.2 s')
    assert.ok(scene.container.textContent.includes('後端啟動中…（首次開啟需要數秒）'))
    assert.deepEqual(retryButtons(scene), [], 'starting is not an error: no retry button')
    assert.equal(walk(scene.container).some((element) => hasClassName(element, 'dot') && hasClassName(element, 'err')), false, 'no red dot while starting')
    assert.equal(walk(scene.container).some((element) => hasClassName(element, 'stream-count')), false, 'an unknown message count is not shown as 0')
    assert.equal(chatItem(scene, 'BNI 商會'), undefined, 'the list is not there before the backend is up')
    await until(() => chatItem(scene, 'BNI 商會'), { timeout: 9000, message: 'the chat list after the backend is up' })
    const lag = Date.now() - releasedAt
    assert.ok(releasedAt > 0 && Date.now() - t0 >= 5900, 'the list did not appear before the 6 s start')
    assert.ok(lag < 1_000, `the list appeared ${lag} ms after the backend answered (catastrophe ceiling 1,000 ms)`)
    await until(() => streamStatusText(scene).includes('已停止'), { message: 'the bridge status replaces the phase wording' })
  } finally {
    clearTimeout(timer)
    started.resolve()
    scene?.unmount()
    api.dispose()
  }
})

test('WP-C phase wording: ping answered but line.status not yet = 連線中… (not 後端啟動中); the answer replaces it', async () => {
  const gate = deferred()
  const { api } = plugin({
    ping: async () => ({ version: 'warm' }), 'line.status': async () => { await gate.promise; return STOPPED }, 'db.chats.list': async () => [wpChat('bni', 'BNI 商會')],
    'db.messages.list': async () => [], 'db.messages.recentByChat': async () => [], 'messages.recent': async () => []
  }, { startingAfterMs: 50 })
  let scene
  try {
    await api.ping()
    scene = ui.mount(ui.messageStreamScene(api))
    await until(() => chatItem(scene, 'BNI 商會'), { message: 'the list does not wait for line.status' })
    await sleep(150)
    assert.equal(api.plugin.backendPhase(), 'connecting')
    assert.ok(streamStatusText(scene).includes('連線中…'), streamStatusText(scene))
    assert.equal(streamStatusText(scene).includes('後端啟動中'), false)
    gate.resolve()
    await until(() => streamStatusText(scene).includes('已停止'), { message: 'line.status answered' })
    assert.equal(api.plugin.backendPhase(), 'ready')
  } finally { gate.resolve(); scene?.unmount(); api.dispose() }
})

test('WP-C timeout (non-device): a core call with no answer shows 讀取逾時 with 重試 in the status line and above the list; retry resends and the list recovers; nothing is revoked and nothing is left unhandled', async () => {
  const unhandled = await collectingUnhandled(async () => {
    const hang = deferred()
    let listCalls = 0
    const { api, backend } = plugin({
      'db.chats.list': async () => { listCalls += 1; if (listCalls === 1) await hang.promise; return [wpChat('bni', 'BNI 商會')] },
      'db.messages.list': async () => [], 'db.messages.recentByChat': async () => [], 'messages.recent': async () => [], 'line.status': async () => STOPPED,
      'settings.chatPrompt.list': async () => ({ items: [] }), 'db.chats.listPrefs': async () => ({ prefsReady: true, topicsAvailable: true, pinned: [], hidden: [], todoOff: [], topicsOn: [] })
    }, { timeouts: { coreMs: 150, pingMs: 5000, longMs: 5000, bulkMs: 5000 } })
    let scene
    try {
      scene = ui.mount(ui.messageStreamScene(api))
      await until(() => streamStatusText(scene).includes('讀取逾時'), { timeout: 2000, message: 'the timeout wording in the status line' })
      const bar = walk(scene.container).find((element) => hasClassName(element, 'stream-bar'))
      assert.ok(walk(bar).some((element) => hasClassName(element, 'dot') && hasClassName(element, 'err')), 'the dot is red: a timeout cannot be hidden')
      assert.equal(retryButtons(scene).length, 2, 'one 重試 in the status line, one above the (empty) chat list')
      assert.ok(scene.container.textContent.includes('讀取聊天室清單失敗：讀取逾時'), 'the list area says what failed')
      assert.equal(scene.container.textContent.includes('目前尚無聊天資料'), false, 'a failed load is not reported as "no chats"')
      assert.equal(chatItem(scene, 'BNI 商會'), undefined)
      assert.equal(api.plugin.backendLink().state, 'ok', 'line.status etc. answered, so the link is ok')
      assert.notEqual(api.plugin.backendLink().state, 'revoked')
      assert.equal(walk(scene.container).filter((element) => hasClassName(element, 'stream-error')).length, 0, 'the timeout is not stacked as a second red notice')

      reactProps(retryButtons(scene)[0]).onClick()
      await until(() => chatItem(scene, 'BNI 商會'), { timeout: 2000, message: 'the list after retry' })
      assert.equal(listCalls, 2, 'retry resent db.chats.list')
      await until(() => streamStatusText(scene).includes('已停止') && retryButtons(scene).length === 0, { message: 'the status line is back to the bridge state without 重試' })
      assert.equal(api.plugin.backendPhase(), 'ready')
      hang.resolve() // the abandoned first call is answered late
      await sleep(30)
      assert.ok(backend.unknown.every((path) => path.startsWith('media.avatar.')), `only the avatar batches have no handler here: ${backend.unknown}`)
    } finally { hang.resolve(); scene?.unmount(); api.dispose() }
  })
  assert.deepEqual(unhandled, [])
})

test('WP-C timeout (non-device): a line.status that never answers is a 讀取逾時 + 重試 in the status line, with no extra red notice; retry asks again', async () => {
  let statusCalls = 0
  const gate = deferred()
  const { api } = plugin({
    'db.chats.list': async () => [], 'db.messages.list': async () => [], 'db.messages.recentByChat': async () => [], 'messages.recent': async () => [],
    'line.status': async () => { statusCalls += 1; if (statusCalls === 1) await gate.promise; return { ...STOPPED, state: 'running', messageCount: 7 } }
  }, { timeouts: { coreMs: 120, pingMs: 5000, longMs: 5000, bulkMs: 5000 } })
  let scene
  try {
    scene = ui.mount(ui.messageStreamScene(api))
    await until(() => streamStatusText(scene).includes('讀取逾時'), { timeout: 2000, message: 'timeout wording' })
    assert.equal(walk(scene.container).filter((element) => hasClassName(element, 'stream-error')).length, 0)
    assert.equal(retryButtons(scene).length, 1)
    reactProps(retryButtons(scene)[0]).onClick()
    await until(() => streamStatusText(scene).includes('運行中 · 已收 7 則'), { timeout: 2000, message: 'status after retry' })
    assert.equal(statusCalls, 2)
    assert.equal(retryButtons(scene).length, 0)
  } finally { gate.resolve(); scene?.unmount(); api.dispose() }
})

test('WP-C timeout (F1, non-device): after line.status times out, an unrelated core call that succeeds keeps 讀取逾時 and 重試 on the screen; only a successful line.status takes them away', async () => {
  let statusCalls = 0
  const gate = deferred()
  const { api } = plugin({
    'db.chats.list': async () => [], 'db.messages.list': async () => [], 'db.messages.recentByChat': async () => [], 'messages.recent': async () => [],
    'line.status': async () => { statusCalls += 1; if (statusCalls === 1) await gate.promise; return { ...STOPPED, state: 'running', messageCount: 7 } }
  }, { timeouts: { coreMs: 120, pingMs: 5000, longMs: 5000, bulkMs: 5000 } })
  let scene
  try {
    scene = ui.mount(ui.messageStreamScene(api))
    await until(() => streamStatusText(scene).includes('讀取逾時'), { timeout: 2000, message: 'timeout wording' })
    assert.equal(retryButtons(scene).length, 1)
    assert.equal(api.plugin.backendPhase(), 'timeout')

    await api.plugin.invoke('db.messages.list', [{ limit: 5 }])
    await api.plugin.invoke('db.chats.list', [])
    await sleep(60)
    assert.equal(api.plugin.backendPhase(), 'timeout', 'unrelated core calls succeeded')
    assert.ok(streamStatusText(scene).includes('讀取逾時'), `still 讀取逾時: ${streamStatusText(scene)}`)
    assert.equal(streamStatusText(scene).includes('連線中'), false, 'not back to 連線中…')
    assert.equal(retryButtons(scene).length, 1, '重試 is still there')
    assert.equal(statusCalls, 1, 'nothing re-asked line.status yet')

    reactProps(retryButtons(scene)[0]).onClick()
    await until(() => streamStatusText(scene).includes('運行中 · 已收 7 則'), { timeout: 2000, message: 'status after retry' })
    assert.equal(statusCalls, 2)
    await until(() => retryButtons(scene).length === 0, { message: '重試 gone once line.status answered' })
    assert.equal(api.plugin.backendPhase(), 'ready')
  } finally { gate.resolve(); scene?.unmount(); api.dispose() }
})

test('WP-C timeout (F2, non-device): a db.messages.list that never answers is not a 讀取逾時 in the status line; the history area shows the error with its own 重試, and that 重試 reads again', async () => {
  let listCalls = 0
  const gate = deferred()
  const { api } = plugin({
    'db.chats.list': async () => [wpChat('bni', 'BNI 商會')],
    'db.messages.list': async () => { listCalls += 1; if (listCalls === 1) await gate.promise; return [] },
    'db.messages.recentByChat': async () => [], 'messages.recent': async () => [], 'line.status': async () => ({ ...STOPPED, state: 'running', messageCount: 7 })
  }, { timeouts: { coreMs: 120, pingMs: 5000, longMs: 5000, bulkMs: 5000 } })
  let scene
  try {
    scene = ui.mount(ui.messageStreamScene(api))
    const note = () => walk(scene.container).find((element) => hasClassName(element, 'stream-load-note'))
    await until(() => note(), { timeout: 2000, message: 'the history error' })
    assert.ok(note().textContent.includes('讀取最近訊息失敗') && note().textContent.includes('讀取逾時'), note().textContent)
    await until(() => streamStatusText(scene).includes('運行中 · 已收 7 則'), { message: 'the bridge state in the status line' })
    assert.equal(streamStatusText(scene).includes('讀取逾時'), false, 'db.messages.list is not a bridge path: the status line does not say 讀取逾時')
    assert.equal(api.plugin.backendPhase(), 'ready')
    assert.equal(walk(scene.container).some((element) => hasClassName(element, 'dot') && hasClassName(element, 'err')), false, 'no red dot')
    assert.ok(chatItem(scene, 'BNI 商會'), 'the chat list is there')
    assert.equal(retryButtons(scene).length, 1, 'exactly one 重試: the one that belongs to the history error')
    assert.ok(walk(note()).includes(retryButtons(scene)[0]), 'and it sits inside the history error')

    reactProps(retryButtons(scene)[0]).onClick()
    await until(() => !note() && listCalls === 2, { timeout: 2000, message: 'the history error is gone after the retry read it again' })
    assert.equal(retryButtons(scene).length, 0)
    assert.ok(streamStatusText(scene).includes('運行中 · 已收 7 則'))
  } finally { gate.resolve(); scene?.unmount(); api.dispose() }
})

test('WP-C timeout (F2, non-device): a ping that times out shows 讀取逾時 with 重試; any successful core call afterwards takes both away', async () => {
  let pings = 0
  const gate = deferred()
  const { api } = plugin({
    ping: async () => { pings += 1; if (pings === 1) await gate.promise; return { version: 'x' } },
    'db.chats.list': async () => [wpChat('bni', 'BNI 商會')], 'db.messages.list': async () => [], 'db.messages.recentByChat': async () => [], 'messages.recent': async () => [],
    'line.status': async () => ({ ...STOPPED, state: 'running', messageCount: 7 })
  }, { timeouts: { coreMs: 5000, pingMs: 150, longMs: 5000, bulkMs: 5000 } })
  let scene
  try {
    void api.ping().catch(() => undefined)
    scene = ui.mount(ui.messageStreamScene(api))
    await until(() => streamStatusText(scene).includes('讀取逾時'), { timeout: 2000, message: 'the timeout wording after ping gave up' })
    assert.ok(retryButtons(scene).length >= 1)
    await api.line.status()
    await until(() => !streamStatusText(scene).includes('讀取逾時') && retryButtons(scene).length === 0, { message: 'a core call answered: the timeout is gone' })
    assert.ok(streamStatusText(scene).includes('運行中 · 已收 7 則'), streamStatusText(scene))
    assert.equal(api.plugin.backendPhase(), 'ready')
  } finally { gate.resolve(); scene?.unmount(); api.dispose() }
})

for (const target of ['line.status', 'messages.recent', 'db.chats.list']) {
  test('WP-C timeout (F2, non-device): ' + target + ' and ping both time out; 重試 in the status line and ' + target + ' answers: 讀取逾時 and 重試 are gone', async () => {
    const gate = deferred()
    const counts = {}
    const answer = (name, value) => async () => {
      counts[name] = (counts[name] ?? 0) + 1
      if ((name === target || name === 'ping') && counts[name] === 1) await gate.promise
      return value
    }
    const { api } = plugin({
      ping: answer('ping', { version: 'x' }), 'line.status': answer('line.status', { ...STOPPED, state: 'running', messageCount: 7 }), 'messages.recent': answer('messages.recent', []),
      'db.chats.list': answer('db.chats.list', [wpChat('bni', 'BNI 商會')]), 'db.messages.list': answer('db.messages.list', []), 'db.messages.recentByChat': async () => []
    }, { timeouts: { coreMs: 150, pingMs: 150, longMs: 5000, bulkMs: 5000 } })
    let scene
    try {
      void api.ping().catch(() => undefined)
      scene = ui.mount(ui.messageStreamScene(api))
      await until(() => api.plugin.transportStats().timeouts >= 2, { timeout: 2000, message: 'both ' + target + ' and ping timed out' })
      await until(() => streamStatusText(scene).includes('讀取逾時'), { message: 'the timeout wording' })
      assert.ok(retryButtons(scene).length >= 1)
      reactProps(retryButtons(scene)[0]).onClick()
      await until(() => !streamStatusText(scene).includes('讀取逾時') && retryButtons(scene).length === 0, { timeout: 2000, message: 'the retry cleared every timeout it showed' })
      assert.equal(counts[target], 2, target + ' was asked again by the retry')
      assert.equal(api.plugin.backendPhase(), 'ready')
      await until(() => streamStatusText(scene).includes('運行中 · 已收 7 則'), { message: 'the bridge state is back' })
    } finally { gate.resolve(); scene?.unmount(); api.dispose() }
  })
}

test('WP-C error (non-device): a refusing host (revoked) is shown at once in the status line as 無法連線 with 重試; it is not hidden behind 連線中…', async () => {
  const fenced = ui.createPluginLineTodoApi({ host: { backend: { call: async () => { throw new Error('plugin_disabled') } }, assets: { url: String } }, events: { enabled: false }, busyRetry: { attempts: 0 } })
  let scene
  try {
    scene = ui.mount(ui.messageStreamScene(fenced))
    await until(() => streamStatusText(scene).includes('無法連線'), { message: 'error wording' })
    assert.equal(fenced.plugin.backendLink().state, 'revoked')
    assert.equal(fenced.plugin.backendPhase(), 'error')
    assert.ok(retryButtons(scene).length >= 1)
    assert.equal(streamStatusText(scene).includes('連線中'), false)
  } finally { scene?.unmount(); fenced.dispose() }
})

test('WP-C diagnostics (non-device): 診斷 is a collapsed <details>; opened it shows phase, how long each core call has waited, the last error code and the backend pid / uptime; unknown values say 未知, never 0', async () => {
  const gate = deferred()
  let infoOk = true
  const { api } = plugin({
    'db.chats.list': async () => [], 'db.messages.list': async () => [], 'db.messages.recentByChat': async () => [], 'messages.recent': async () => [],
    'line.status': async () => { await gate.promise; return STOPPED },
    'backend.info': async () => { if (!infoOk) throw Object.assign(new Error('info unavailable'), { code: 'internal' }); return { pid: 4242, uptimeMs: 125_000 } }
  }, { timeouts: { coreMs: 5000, pingMs: 5000, longMs: 5000, bulkMs: 5000 } })
  let scene
  try {
    scene = ui.mount(ui.messageStreamScene(api))
    const details = () => walk(scene.container).find((element) => element.localName === 'details' && element.getAttribute('data-testid') === 'backend-diagnostics')
    await until(() => details(), { message: 'the 診斷 details' })
    assert.equal(details().hasAttribute('open'), false, 'collapsed by default: the default screen is one status line')
    assert.ok(byText(details(), '診斷', 'summary'))
    const field = (name) => walk(details()).find((element) => element.getAttribute('data-diag') === name)?.textContent ?? ''
    assert.equal(field('calls'), '…', 'nothing is read while it is collapsed')

    reactProps(details()).onToggle({ currentTarget: { open: true } })
    await until(() => field('backend').includes('pid 4242'), { message: 'backend.info shown' })
    assert.equal(field('backend'), 'pid 4242 · 已執行 2 分鐘')
    assert.equal(field('phase'), '連線中…')
    assert.match(field('calls'), /line\.status \d+\.\d 秒/, 'the pending core call and how long it has waited')
    assert.equal(field('error'), '無')
    gate.resolve()
    await until(() => field('calls') === '無', { timeout: 2500, message: 'the diagnostics refresh while open' })
    assert.equal(field('phase'), '正常')

    reactProps(details()).onToggle({ currentTarget: { open: false } })
    await sleep(30)
    infoOk = false
    reactProps(details()).onToggle({ currentTarget: { open: true } })
    await until(() => field('backend') === '未知', { message: 'a failed backend.info is 未知, not 0' })
    assert.equal(/\b0\b/.test(field('backend')), false)
  } finally { gate.resolve(); scene?.unmount(); api.dispose() }
})

test('WP-C standalone (non-device): without a phase source the shared stream keeps its old wording and shows no 診斷', async () => {
  const gate = deferred()
  const standalone = {
    messages: { recent: async () => [] },
    line: { status: async () => { await gate.promise; return STOPPED }, onMessage: () => () => undefined, onStatus: () => () => undefined },
    db: { chats: { list: async () => [] }, messages: { list: async () => [] }, onMessagesPersisted: () => () => undefined }
  }
  let scene
  try {
    scene = ui.mount(ui.messageStreamScene(standalone))
    await sleep(80)
    assert.ok(streamStatusText(scene).includes('連線中…'))
    assert.equal(walk(scene.container).some((element) => element.localName === 'details'), false)
    gate.resolve()
    await until(() => streamStatusText(scene).includes('已停止'), { message: 'status shown' })
  } finally { gate.resolve(); scene?.unmount() }
})

// ───────────── N1 (review r1): the picture says 索引建立中 and asks again by itself while the backend's LINE Cache index is still being built ─────────────

const INDEXING = () => Object.assign(new Error('the LINE cache index is still being built (索引建立中; index_building), try again shortly'), { code: 'not_cached' })
const NOT_DOWNLOADED = () => Object.assign(new Error('not downloaded in LINE yet'), { code: 'not_cached' })
const imageSrcs = (container) => walk(container).filter((el) => el.localName === 'img').map((el) => el.getAttribute('src'))

/** a fast retry policy for the tests that are not about the delays themselves; restored afterwards */
async function withFastRetry(policy, body) {
  const saved = { ...ui.mediaIndexingRetry }
  Object.assign(ui.mediaIndexingRetry, { baseMs: 15, maxMs: 40, maxRetries: 8 }, policy)
  try { await body() } finally { Object.assign(ui.mediaIndexingRetry, saved) }
}

test('N1: the adapter looks for the token index_building (test-media-index.mjs checks that the backend message carries the same token)', () => {
  assert.equal(ui.MEDIA_INDEX_BUILDING_TOKEN, 'index_building')
})

test('N1 (effects): while the index is being built the image shows 索引建立中, asks again by itself, and shows the picture once the backend finds it', async () => {
  await withFastRetry({}, async () => {
    const calls = []
    const { api } = plugin({
      'media.prepare': (msgId) => {
        calls.push(msgId)
        if (calls.length <= 2) throw INDEXING()
        return { path: 'media-cache/found.png', mime: 'image/png', size: 10, cached: false }
      }
    })
    let scene
    try {
      scene = ui.mount(ui.mediaImageScene(api, 'i:m1'))
      await until(() => scene.container.textContent.includes('索引建立中'), { message: '索引建立中 on screen' })
      assert.equal(scene.container.textContent.includes('尚未下載'), false, 'not "not downloaded": the image may be in the Cache already')
      await until(() => imageSrcs(scene.container).length === 1, { message: 'the picture' })
      assert.deepEqual(imageSrcs(scene.container), ['tuqplugin://tuqdev.line-todo/data/media-cache/found.png'])
      assert.equal(scene.container.textContent.includes('索引建立中'), false)
      assert.deepEqual(calls, ['i:m1', 'i:m1', 'i:m1'], 'two retries, then it was there')
      await sleep(120)
      assert.equal(calls.length, 3, 'nothing is asked again once the picture is shown')
    } finally { scene?.unmount(); api.dispose() }
  })
})

test('N1 (effects): with the default policy the retries of one image wait 2 s, then longer (2, 4, 8, 16 s), each at least 2 s', async () => {
  const realSetTimeout = globalThis.setTimeout
  // 30000 is left alone on purpose: the transport arms a timer of that length for every call
  const ladder = new Set([2000, 4000, 8000, 16000])
  const waits = []
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ladder.has(ms)) { waits.push(ms); return realSetTimeout(fn, 5, ...rest) }
    return realSetTimeout(fn, ms, ...rest)
  }
  let calls = 0
  const { api } = plugin({ 'media.prepare': () => { calls += 1; if (calls <= 4) throw INDEXING(); return { path: 'media-cache/late.png' } } })
  let scene
  try {
    scene = ui.mount(ui.mediaImageScene(api, 'i:slow'))
    await until(() => imageSrcs(scene.container).length === 1, { message: 'the picture after four retries' })
    assert.deepEqual(waits, [2000, 4000, 8000, 16000])
    assert.ok(waits.every((ms, i) => ms >= 2000 && (i === 0 || ms > waits[i - 1])), 'at least 2 s and growing')
  } finally { globalThis.setTimeout = realSetTimeout; scene?.unmount(); api.dispose() }
})

test('N1 (effects): not_cached because LINE has not downloaded the picture yet is not retried: 尚未下載 stays', async () => {
  await withFastRetry({}, async () => {
    let calls = 0
    const { api } = plugin({ 'media.prepare': () => { calls += 1; throw NOT_DOWNLOADED() } })
    let scene
    try {
      scene = ui.mount(ui.mediaImageScene(api, 'i:m2'))
      await until(() => scene.container.textContent.includes('尚未下載'), { message: '尚未下載' })
      await sleep(200)
      assert.equal(calls, 1, 'asked once, never again')
      assert.equal(scene.container.textContent.includes('索引建立中'), false)
      assert.deepEqual(imageSrcs(scene.container), [])
    } finally { scene?.unmount(); api.dispose() }
  })
})

test('N1 (effects): any other failure (decrypt, key, unavailable) is not retried either', async () => {
  await withFastRetry({}, async () => {
    for (const code of ['hmac_miss', 'media_unavailable', 'no_key', 'internal']) {
      let calls = 0
      const { api } = plugin({ 'media.prepare': () => { calls += 1; throw Object.assign(new Error(`index_building ${code}`), { code }) } })
      let scene
      try {
        scene = ui.mount(ui.mediaImageScene(api, 'i:m3'))
        await until(() => scene.container.textContent.includes('尚未下載'), { message: `尚未下載 for ${code}` })
        await sleep(100)
        assert.equal(calls, 1, `${code}: asked once`)
      } finally { scene?.unmount(); api.dispose() }
    }
  })
})

test('N1 (effects): after the component is unmounted no further request is sent and the pending retry is gone', async () => {
  await withFastRetry({ baseMs: 30, maxMs: 30 }, async () => {
    let calls = 0
    const { api } = plugin({ 'media.prepare': () => { calls += 1; throw INDEXING() } })
    let scene
    try {
      scene = ui.mount(ui.mediaImageScene(api, 'i:gone'))
      await until(() => calls >= 2, { message: 'a first retry' })
      assert.ok(scene.container.textContent.includes('索引建立中'))
      scene.unmount()
      scene = null
      const atUnmount = calls
      await sleep(250)
      assert.equal(calls, atUnmount, `no request after unmount (${atUnmount} before, ${calls} after)`)
    } finally { scene?.unmount(); api.dispose() }
  })
})

test('N1 (effects): the retries are bounded: after maxRetries the image is 尚未下載 and nothing more is asked', async () => {
  await withFastRetry({ maxRetries: 3, baseMs: 10, maxMs: 10 }, async () => {
    let calls = 0
    const { api } = plugin({ 'media.prepare': () => { calls += 1; throw INDEXING() } })
    let scene
    try {
      scene = ui.mount(ui.mediaImageScene(api, 'i:never'))
      await until(() => scene.container.textContent.includes('尚未下載'), { message: 'giving up' })
      await sleep(150)
      assert.equal(calls, 4, 'the first ask plus three retries, no more')
    } finally { scene?.unmount(); api.dispose() }
  })
})

test('N1 (effects): a host without assetLookup (standalone) keeps the old behaviour: one assetUrl call, a null is 尚未下載, no retry', async () => {
  const { api } = plugin({})
  let calls = 0
  const standalone = { ...api, media: { ...api.media, assetLookup: undefined, assetUrl: async () => { calls += 1; return null } } }
  let scene
  try {
    scene = ui.mount(ui.mediaImageScene(standalone, 'i:old'))
    await until(() => scene.container.textContent.includes('尚未下載'), { message: '尚未下載' })
    await sleep(100)
    assert.equal(calls, 1)
  } finally { scene?.unmount(); api.dispose() }
})

test('N1 (effects): the retry of an image goes through the bulk lane of the transport (the core lane stays free)', async () => {
  await withFastRetry({}, async () => {
    let calls = 0
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const { api } = plugin({
      'media.prepare': async () => {
        calls += 1
        if (calls === 1) throw INDEXING()
        await gate
        return { path: 'media-cache/bulk.png' }
      }
    })
    let scene
    try {
      scene = ui.mount(ui.mediaImageScene(api, 'i:lane'))
      await until(() => calls === 2, { message: 'the retry reached the backend' })
      const stats = api.plugin.transportStats()
      assert.equal(stats.lanes.bulk.active, 1, 'the retry holds the bulk lane')
      assert.equal(stats.lanes.core.active, 0, 'nothing is on the core lane')
      release()
      await until(() => imageSrcs(scene.container).length === 1, { message: 'the picture' })
    } finally { release?.(); scene?.unmount(); api.dispose() }
  })
})

test('N1 (effects): the waits grow by doubling up to maxMs and stay there', async () => {
  const realSetTimeout = globalThis.setTimeout
  const ladder = new Set([2000, 3000])
  const waits = []
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ladder.has(ms)) { waits.push(ms); return realSetTimeout(fn, 5, ...rest) }
    return realSetTimeout(fn, ms, ...rest)
  }
  const saved = { ...ui.mediaIndexingRetry }
  Object.assign(ui.mediaIndexingRetry, { baseMs: 2000, maxMs: 3000, maxRetries: 8 })
  let calls = 0
  const { api } = plugin({ 'media.prepare': () => { calls += 1; if (calls <= 4) throw INDEXING(); return { path: 'media-cache/cap.png' } } })
  let scene
  try {
    scene = ui.mount(ui.mediaImageScene(api, 'i:cap'))
    await until(() => imageSrcs(scene.container).length === 1, { message: 'the picture after four retries' })
    assert.deepEqual(waits, [2000, 3000, 3000, 3000], 'doubling (2 s, 4 s ...) is cut off at maxMs')
  } finally { globalThis.setTimeout = realSetTimeout; Object.assign(ui.mediaIndexingRetry, saved); scene?.unmount(); api.dispose() }
})


// ───────────── per-chat prompt / my name (A16, A17, A18) ─────────────

test('A16 settings: the default name field is always there and saves through saveName without touching an unsaved prompt draft; "各對話的個別設定" is collapsed and does not call list before it is opened', async () => {
  const chatAlice = { chatId: 'u-alice', name: 'Alice', isGroup: false, firstSeenAt: '2026-11-01T00:00:00.000Z', lastSeenAt: '2026-11-01T00:00:00.000Z' }
  let promptState = { initialPrompt: '初始待辦判斷規則', activePrompt: '初始待辦判斷規則', customized: false, revision: 'initial', maxChars: 12000, outputFormat: '固定格式', myName: '舊名字', nameRevision: 'n1', maxNameChars: 40 }
  const nameSaves = []
  const listCalls = []
  const resets = []
  let items = [
    { chatId: 'u-alice', hasPrompt: true, myName: null, revision: 'ra' },
    { chatId: 'u-gone', hasPrompt: false, myName: '阿華', revision: 'rg' }
  ]
  const { backend, api } = plugin(settingsHandlers({
    'settings.prompt.get': () => promptState,
    'settings.prompt.saveName': ({ myName, expectedNameRevision }) => {
      nameSaves.push({ myName, expectedNameRevision })
      promptState = { ...promptState, myName, nameRevision: 'n2' }
      return promptState
    },
    'db.chats.list': () => [chatAlice],
    'settings.chatPrompt.list': () => { listCalls.push(1); return { items } },
    'settings.chatPrompt.reset': ({ chatId, expectedRevision }) => {
      resets.push({ chatId, expectedRevision })
      items = items.filter((item) => item.chatId !== chatId)
      return { chatId, revision: 'r0' }
    }
  }))
  const data = new Map()
  const storage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) }
  const scene = ui.mount(ui.settingsDraftScene(api, storage))
  const field = (name) => byAttr(scene.container, 'data-testid', name)
  try {
    await until(() => field('default-my-name') && !reactProps(field('default-my-name')).disabled, { message: 'name field loaded' })
    assert.equal(reactProps(field('default-my-name')).value, '舊名字')
    assert.equal(reactProps(field('save-my-name')).disabled, true, 'unchanged name: nothing to save')
    assert.equal(reactProps(field('default-my-name')).maxLength, 40)
    assert.ok(scene.container.textContent.includes('各對話可以個別改'))

    reactProps(field('active-extract-prompt')).onChange({ target: { value: '尚未儲存的 prompt' } })
    await until(() => data.has('lt-ui:prompt.editor.draft'), { message: 'prompt draft persisted' })
    reactProps(field('default-my-name')).onChange({ target: { value: '  新   名字 ' } })
    await until(() => reactProps(field('save-my-name')).disabled === false, { message: 'changed name can be saved' })
    reactProps(field('save-my-name')).onClick()
    await until(() => nameSaves.length === 1 && scene.container.textContent.includes('已儲存名字'), { message: 'name saved' })
    assert.deepEqual(nameSaves, [{ myName: '新 名字', expectedNameRevision: 'n1' }], 'trimmed, runs of spaces collapsed, with the name revision')
    assert.equal(reactProps(field('default-my-name')).value, '新 名字')
    assert.equal(reactProps(field('active-extract-prompt')).value, '尚未儲存的 prompt', 'the unsaved prompt draft survives a name save')
    assert.ok(data.has('lt-ui:prompt.editor.draft'))
    assert.equal(reactProps(field('save-my-name')).disabled, true)

    reactProps(field('default-my-name')).onChange({ target: { value: '   ' } })
    await until(() => reactProps(field('default-my-name')).value === '   ' && reactProps(field('save-my-name')).disabled === false, { message: 'blank name can be saved' })
    reactProps(field('save-my-name')).onClick()
    await until(() => nameSaves.length === 2, { message: 'blank clears the name' })
    assert.deepEqual(nameSaves[1], { myName: null, expectedNameRevision: 'n2' })

    const details = field('chat-overrides')
    assert.ok(details, 'the section is present')
    assert.equal(details.getAttribute('open'), null, 'collapsed by default')
    await sleep(60)
    assert.equal(listCalls.length, 0, 'list is not called before the section is opened')
    assert.equal(field('chat-overrides-list'), null)
    reactProps(details).onToggle({ currentTarget: { open: true } })
    await until(() => field('chat-overrides-list'), { message: 'list rendered after opening' })
    assert.equal(listCalls.length, 1)
    reactProps(details).onToggle({ currentTarget: { open: true } })
    await sleep(30)
    assert.equal(listCalls.length, 1, 'opening again does not reload')
    const rows = field('chat-overrides-list').textContent
    assert.ok(rows.includes('Alice') && rows.includes('專屬 Prompt'))
    assert.ok(rows.includes('（已不在清單）') && rows.includes('名字：阿華'))
    reactProps(field('reset-chat-override-u-alice')).onClick()
    await until(() => resets.length === 1 && !field('chat-override-u-alice'), { message: 'one override reset' })
    assert.deepEqual(resets, [{ chatId: 'u-alice', expectedRevision: 'ra' }], 'resets with the revision shown in the list')
    reactProps(field('reset-chat-override-u-gone')).onClick()
    await until(() => field('chat-overrides-empty'), { message: 'empty state' })
    assert.ok(field('chat-overrides-empty').textContent.includes('AI 設定'))
    assert.deepEqual(backend.unknown.filter((path) => path.startsWith('settings.')), [])
  } finally { scene.unmount(); api.dispose() }
})

test('A16 settings: an older backend (no myName / nameRevision in the state) still renders, the name cannot be saved, and without chatPrompts the per-chat section is not rendered', async () => {
  const { api } = plugin(settingsHandlers())
  const withoutChatPrompts = { ...api, hostAi: { ...api.hostAi, chatPrompts: undefined } }
  const scene = ui.mount(ui.settingsScene(withoutChatPrompts))
  const field = (name) => byAttr(scene.container, 'data-testid', name)
  try {
    await until(() => field('active-extract-prompt') && !reactProps(field('active-extract-prompt')).disabled, { message: 'legacy prompt state rendered' })
    assert.equal(reactProps(field('default-my-name')).value, '')
    assert.equal(reactProps(field('default-my-name')).disabled, true)
    assert.equal(reactProps(field('save-my-name')).disabled, true)
    assert.equal(field('chat-overrides'), null, 'no chatPrompts: no per-chat section')
  } finally { scene.unmount(); api.dispose() }
})

function boardChat(chatId, name) {
  return { chatId, name, isGroup: false, firstSeenAt: new Date(1700000000000).toISOString(), lastSeenAt: new Date(1700000003000).toISOString() }
}
const noOverride = (extra = {}) => ({
  chatId: 'bni', revision: 'r0', overridePrompt: null, overrideName: null, effectivePrompt: '預設的抽取規則', effectiveName: '預設名', promptSource: 'default', nameSource: 'default',
  defaultName: '預設名', maxChars: 12000, maxNameChars: 40, corrupt: false, ...extra
})

test('A17/A18 board: the chat pane keeps a third "AI 設定" tab after the combined content tab, marked only when the chat has an override; the editor stays closed until asked for; save sends the whole pair; conflicts and validation errors read in Chinese; reset returns to "沿用預設"', async () => {
  let state = noOverride()
  let listItems = []
  const saves = []
  const resets = []
  let nextSaveError = null
  const { backend, api } = plugin({
    'db.chats.list': () => [boardChat('bni', 'BNI 商會')],
    'db.messages.list': () => [],
    'db.messages.recentByChat': () => [],
    'messages.recent': () => [],
    'line.status': () => ({ state: 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 }),
    'settings.chatPrompt.list': () => ({ items: listItems }),
    'settings.chatPrompt.get': ({ chatId }) => { assert.equal(chatId, 'bni'); return state },
    'settings.chatPrompt.save': (input) => {
      if (nextSaveError) { const error = nextSaveError; nextSaveError = null; throw error }
      saves.push(input)
      state = noOverride({ revision: 'r1', overridePrompt: input.prompt, overrideName: input.myName, effectivePrompt: input.prompt ?? '預設的抽取規則', effectiveName: input.myName ?? '預設名', promptSource: input.prompt === null ? 'default' : 'chat', nameSource: input.myName === null ? 'default' : 'chat' })
      return state
    },
    'settings.chatPrompt.reset': (input) => { resets.push(input); state = noOverride({ revision: 'r0' }); return state }
  })
  const scene = ui.mount(ui.messageStreamScene(api))
  const field = (name) => byAttr(scene.container, 'data-testid', name)
  const toggleButtons = () => walk(scene.container).filter((element) => element.localName === 'button' && element.parentNode && hasClassName(element.parentNode, 'chat-pane-view-toggle'))
  const aiTab = () => toggleButtons().find((button) => button.textContent.includes('AI 設定'))
  try {
    await until(() => aiTab(), { message: 'chat pane header with the AI settings tab' })
    assert.deepEqual(toggleButtons().map((button) => button.textContent.trim()), ['訊息', '議題與待辦', 'AI 設定'], 'AI settings follow the combined content tab')
    await sleep(30)
    assert.equal(field('ai-settings-customized'), null, 'no override: no mark')
    assert.equal(field('chat-prompt-panel'), null, 'the message view stays the default')

    reactProps(aiTab()).onClick()
    await until(() => field('chat-prompt-panel') && field('chat-prompt-source'), { message: 'panel loaded' })
    assert.equal(field('chat-prompt-text'), null, 'the prompt editor is not rendered while the chat follows the default')
    assert.equal(field('chat-prompt-source').textContent, '沿用預設')
    assert.equal(reactProps(field('chat-prompt-name')).placeholder, '預設名')
    assert.ok(field('chat-prompt-name-source').textContent.includes('沿用預設：預設名'))
    assert.equal(reactProps(field('save-chat-prompt')).disabled, true, 'nothing changed')
    assert.equal(reactProps(field('reset-chat-prompt')).disabled, true, 'nothing to reset')
    assert.equal(field('chat-prompt-defaults-hint').textContent, '預設值可到看板的「設定」分頁修改。', 'tells where the defaults live: the board has its own 設定 tab')

    reactProps(field('customize-chat-prompt')).onClick()
    await until(() => field('chat-prompt-text'), { message: 'editor opened on request' })
    assert.equal(reactProps(field('chat-prompt-text')).value, '預設的抽取規則', 'pre-filled with the effective prompt')
    assert.ok(field('chat-prompt-panel').textContent.includes('此對話使用專屬 Prompt，不受預設變更影響'))
    assert.equal(reactProps(field('save-chat-prompt')).disabled, true, 'opening the editor without a change is not a change')

    reactProps(field('chat-prompt-text')).onChange({ target: { value: '   ' } })
    nextSaveError = Object.assign(new Error('prompt_empty'), { code: 'prompt_empty' })
    reactProps(field('save-chat-prompt')).onClick()
    await until(() => field('chat-prompt-error'), { message: 'validation error shown' })
    assert.equal(field('chat-prompt-error').textContent, 'Prompt 不可留空。')

    reactProps(field('chat-prompt-text')).onChange({ target: { value: '這個對話專屬的規則' } })
    reactProps(field('chat-prompt-name')).onChange({ target: { value: ' 阿華 ' } })
    nextSaveError = Object.assign(new Error('prompt_conflict'), { code: 'prompt_conflict' })
    reactProps(field('save-chat-prompt')).onClick()
    await until(() => field('chat-prompt-error') && field('chat-prompt-error').textContent.includes('已在另一個畫面變更'), { message: 'conflict shown in Chinese' })
    assert.equal(saves.length, 0)

    reactProps(field('save-chat-prompt')).onClick()
    await until(() => saves.length === 1 && field('chat-prompt-message'), { message: 'saved' })
    assert.deepEqual(saves, [{ chatId: 'bni', prompt: '這個對話專屬的規則', myName: '阿華', expectedRevision: 'r0' }], 'the whole pair in one call, with the revision that was read')
    assert.ok(field('chat-prompt-message').textContent.includes('這個對話的下一項抽取工作會使用新設定'))
    assert.equal(field('chat-prompt-error'), null)
    await until(() => field('ai-settings-customized'), { message: 'tab marked once the chat has an override' })
    assert.equal(field('ai-settings-customized').getAttribute('aria-label'), '已自訂')
    assert.ok(field('chat-prompt-text'), 'a chat with its own prompt shows the editor')
    assert.ok(field('chat-prompt-name-source').textContent.includes('此對話自訂'))

    reactProps(field('reset-chat-prompt')).onClick()
    await until(() => resets.length === 1 && !field('chat-prompt-text') && field('chat-prompt-source'), { message: 'reset returns to the default view' })
    assert.deepEqual(resets, [{ chatId: 'bni', expectedRevision: 'r1' }])
    assert.equal(field('chat-prompt-source').textContent, '沿用預設')
    assert.equal(field('ai-settings-customized'), null, 'the mark is gone after the reset')
    assert.deepEqual(backend.unknown.filter((path) => path.startsWith('settings.')), [])
  } finally { scene.unmount(); api.dispose() }
})

test('A18 board: the mark shows for a chat whose override already exists when the board opens; a backend without chatPrompts hides the tab', async () => {
  const { api } = plugin({
    'db.chats.list': () => [boardChat('bni', 'BNI 商會')],
    'db.messages.list': () => [], 'db.messages.recentByChat': () => [], 'messages.recent': () => [],
    'line.status': () => ({ state: 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 }),
    'settings.chatPrompt.list': () => ({ items: [{ chatId: 'bni', hasPrompt: false, myName: '阿華', revision: 'rx' }] })
  })
  const toggleLabels = (scene) => walk(scene.container).filter((element) => element.localName === 'button' && element.parentNode && hasClassName(element.parentNode, 'chat-pane-view-toggle')).map((button) => button.textContent.trim())
  let scene = ui.mount(ui.messageStreamScene(api))
  try {
    await until(() => byAttr(scene.container, 'data-testid', 'ai-settings-customized'), { message: 'mark for the chat that already has an override' })
    assert.deepEqual(toggleLabels(scene), ['訊息', '議題與待辦', 'AI 設定'])
  } finally { scene.unmount() }
  scene = ui.mount(ui.messageStreamScene({ ...api, hostAi: { ...api.hostAi, chatPrompts: undefined } }))
  try {
    await until(() => toggleLabels(scene).length > 0, { message: 'pane header without chatPrompts' })
    assert.deepEqual(toggleLabels(scene), ['訊息', '議題與待辦'])
  } finally { scene.unmount(); api.dispose() }
})


test('m1/n4 board: the AI settings panel names the board "設定" tab as the place for the defaults (the plugin board has one), and "恢復沿用預設 Prompt" says it takes effect after saving', async () => {
  const state = noOverride({ revision: 'r1', overridePrompt: '這個對話專屬的規則', effectivePrompt: '這個對話專屬的規則', promptSource: 'chat' })
  const saves = []
  const { api } = plugin({
    'db.chats.list': () => [boardChat('bni', 'BNI 商會')],
    'db.messages.list': () => [], 'db.messages.recentByChat': () => [], 'messages.recent': () => [],
    'line.status': () => ({ state: 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 }),
    'settings.chatPrompt.list': () => ({ items: [{ chatId: 'bni', hasPrompt: true, myName: null, revision: 'r1' }] }),
    'settings.chatPrompt.get': () => state,
    'settings.chatPrompt.save': (input) => { saves.push(input); return noOverride({ revision: 'r2' }) }
  })
  const scene = ui.mount(ui.messageStreamScene(api))
  const field = (name) => byAttr(scene.container, 'data-testid', name)
  const aiTab = () => walk(scene.container).filter((element) => element.localName === 'button' && element.parentNode && hasClassName(element.parentNode, 'chat-pane-view-toggle')).find((button) => button.textContent.includes('AI 設定'))
  try {
    await until(() => aiTab(), { message: 'chat pane header with the AI settings tab' })
    reactProps(aiTab()).onClick()
    await until(() => field('chat-prompt-text') && field('chat-prompt-defaults-hint'), { message: 'panel with the editor open' })
    assert.equal(field('chat-prompt-defaults-hint').textContent, '預設值可到看板的「設定」分頁修改。', 'the plugin board has its own 設定 tab, so the hint points there')
    assert.ok(!field('chat-prompt-panel').textContent.includes('打開這個外掛後'), 'it no longer sends the user to the TeamUQ plugin page')
    assert.equal(field('chat-prompt-message'), null, 'no message before anything is clicked')

    reactProps(field('restore-default-chat-prompt')).onClick()
    await until(() => field('chat-prompt-message'), { message: 'restore message' })
    assert.equal(field('chat-prompt-message').textContent, '已改回沿用預設 Prompt，按「儲存」後生效。')
    assert.equal(field('chat-prompt-text'), null, 'the editor closes')
    assert.equal(saves.length, 0, 'restoring in the form alone saves nothing')
    assert.equal(reactProps(field('save-chat-prompt')).disabled, false, 'the pending change can be saved')
    reactProps(field('save-chat-prompt')).onClick()
    await until(() => saves.length === 1, { message: 'saved' })
    assert.deepEqual(saves, [{ chatId: 'bni', prompt: null, myName: null, expectedRevision: 'r1' }])
  } finally { scene.unmount(); api.dispose() }
})

// ───────────── chat tab remount: avatar requests must not pile up in front of the chat list ─────────────

/**
 * An IntersectionObserver stand-in the test drives by hand: `setVisible(ids)` is "the user scrolled", every live observer is told which of its
 * targets (data-avatar-chat-id / data-avatar-message-id) are on screen; a newly observed target reports its current state, like the real one.
 * mini-dom has no querySelectorAll on the document, so the stand-in also answers the effect's lookup from the mounted container.
 */
function installVisibility() {
  const live = new Set()
  let visible = new Set()
  const state = { container: null }
  const previous = { observer: globalThis.IntersectionObserver, query: dom.document.querySelectorAll }
  const idOf = (node) => node.getAttribute('data-avatar-message-id') ?? node.getAttribute('data-avatar-chat-id')
  const entryFor = (target) => {
    const on = visible.has(idOf(target))
    return { target, isIntersecting: on, intersectionRatio: on ? 1 : 0 }
  }
  globalThis.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); live.add(this) }
    observe(target) {
      this.targets.add(target)
      queueMicrotask(() => { if (live.has(this) && this.targets.has(target)) this.callback([entryFor(target)]) })
    }
    unobserve(target) { this.targets.delete(target) }
    disconnect() { live.delete(this); this.targets.clear() }
  }
  dom.document.querySelectorAll = () => (state.container
    ? walk(state.container).filter((el) => el.hasAttribute('data-avatar-chat-id') || el.hasAttribute('data-avatar-message-id'))
    : [])
  return {
    attach(container) { state.container = container },
    setVisible(ids) {
      visible = new Set(ids)
      for (const observer of [...live]) if (observer.targets.size > 0) observer.callback([...observer.targets].map(entryFor))
    },
    restore() {
      if (previous.observer === undefined) delete globalThis.IntersectionObserver; else globalThis.IntersectionObserver = previous.observer
      if (previous.query === undefined) delete dom.document.querySelectorAll; else dom.document.querySelectorAll = previous.query
    }
  }
}

function avatarScrollFixture(count) {
  const ts0 = Date.UTC(2026, 10, 3, 1, 0, 0)
  const iso = (ts) => new Date(ts).toISOString()
  const chat = (chatId, name, ts) => ({ chatId, name, isGroup: true, firstSeenAt: iso(ts0), lastSeenAt: iso(ts) })
  const messages = Array.from({ length: count }, (_, index) => {
    const n = index + 1
    return { msgId: `i:${n}`, chatId: 'c1', ts: ts0 + n * 1000, timeIso: iso(ts0 + n * 1000), direction: 'in', sender: `成員${n}`, text: `訊息 ${n}`, contentType: 0, processed: true, ingestedAt: iso(ts0 + n * 1000), origFilename: null, fileSize: null, unsent: false }
  })
  const chats = [chat('c1', '主要群組', ts0 + count * 1000), chat('c2', '第二群組', ts0)]
  const pathFor = (id) => `avatar-cache/${id.replace(':', '_')}.jpg`
  const answer = (ids) => ({ paths: Object.fromEntries(ids.map((id) => [id, pathFor(id)])), names: Object.fromEntries(ids.map((id) => [id, `名稱 ${id}`])) })
  const ids = (from, to) => Array.from({ length: to - from }, (_, index) => `i:${from + index + 1}`)
  return { chats, messages, answer, ids }
}

test('avatar requests while scrolling the chat: no id is sent to the backend twice and the call count stays bounded (IntersectionObserver stand-in)', async (t) => {
  const f = avatarScrollFixture(40)
  const sent = { chats: [], messages: [] }
  const { api } = plugin({
    ...settingsHandlers(),
    'db.chats.list': () => f.chats,
    'db.messages.list': () => f.messages,
    'db.messages.recentByChat': () => f.messages,
    'messages.recent': () => [],
    'line.status': () => ({ state: 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 }),
    'media.avatar.prepareChats': async (ids) => { sent.chats.push(ids); await sleep(8); return f.answer(ids) },
    'media.avatar.prepareMessages': async (_chatId, ids) => { sent.messages.push(ids); await sleep(8); return f.answer(ids) }
  })
  const vis = installVisibility()
  let scene
  try {
    scene = ui.mount(ui.messageStreamScene(api))
    vis.attach(scene.container)
    await until(() => walk(scene.container).filter((el) => el.hasAttribute('data-avatar-message-id')).length === 40, { message: 'all 40 messages rendered' })
    const steps = 8
    for (let step = 0; step < steps; step += 1) {
      // the window slides by 3 ids and the second chat row flips in and out of view: the id lists change every step but mostly repeat
      vis.setVisible(['c1', ...(step % 2 === 0 ? ['c2'] : []), ...f.ids(step * 3, step * 3 + 12)])
      await sleep(30)
    }
    await sleep(60)
    const messageIds = sent.messages.flat()
    const chatIds = sent.chats.flat()
    t.diagnostic(`prepareMessages calls=${sent.messages.length} ids sent=${messageIds.length} unique=${new Set(messageIds).size}; prepareChats calls=${sent.chats.length} ids sent=${chatIds.length} unique=${new Set(chatIds).size}`)
    assert.equal(new Set(messageIds).size, messageIds.length, `a message avatar id was sent more than once: ${JSON.stringify(sent.messages)}`)
    assert.equal(new Set(chatIds).size, chatIds.length, `a chat avatar id was sent more than once: ${JSON.stringify(sent.chats)}`)
    assert.ok(sent.messages.length <= steps + 1, `prepareMessages calls ${sent.messages.length} <= ${steps + 1}`)
    assert.ok(sent.chats.length <= 2, `prepareChats calls ${sent.chats.length} <= 2`)
    assert.deepEqual([...new Set(messageIds)].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2))), f.ids(0, 33), 'every id that was ever on screen was asked for once')
    const sources = walk(scene.container).filter((el) => el.localName === 'img').map((el) => el.getAttribute('src'))
    assert.ok(sources.some((src) => src.endsWith('/avatar-cache/i_33.jpg')), 'the newest window still shows its sender images')
  } finally {
    scene?.unmount()
    vis.restore()
    api.dispose()
  }
})

test('chat tab remount: avatar calls queued by the previous mount are dropped, and a slow avatar call already in flight does not hold up the chat list, LINE status and recent messages', async () => {
  const f = avatarScrollFixture(40)
  const order = []
  const gates = []
  let slow = true
  const { api } = plugin({
    ...settingsHandlers(),
    'db.chats.list': () => { order.push('db.chats.list'); return f.chats },
    'db.messages.list': () => { order.push('db.messages.list'); return f.messages },
    'db.messages.recentByChat': () => f.messages,
    'messages.recent': () => { order.push('messages.recent'); return [] },
    'line.status': () => { order.push('line.status'); return { state: 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 } },
    'media.avatar.prepareChats': (ids) => f.answer(ids),
    'media.avatar.prepareMessages': async (_chatId, ids) => {
      order.push('avatar')
      if (slow) await new Promise((resolve) => { gates.push(resolve) })
      return f.answer(ids)
    }
  })
  const vis = installVisibility()
  let first
  let second
  try {
    first = ui.mount(ui.messageStreamScene(api))
    vis.attach(first.container)
    await until(() => walk(first.container).filter((el) => el.hasAttribute('data-avatar-message-id')).length === 40, { message: 'all 40 messages rendered' })
    // the user scrolls on while the backend is slow: each step asks for new ids (no overlap); the slow calls that were already sent never come back until the gate opens
    for (let step = 0; step < 8; step += 1) {
      vis.setVisible(['c1', ...f.ids(step * 4, step * 4 + 4)])
      await sleep(20)
    }
    await until(() => gates.length >= 1, { message: 'a slow avatar call is in flight' })
    await sleep(30)
    const inFlight = gates.length

    first.unmount() // the user switches to the todo tab
    await sleep(10)
    assert.equal(api.plugin.transportStats().waiting, 0, 'no avatar call of the unmounted chat page is left waiting for a host call slot')
    assert.equal(gates.length, inFlight, 'unmounting sent nothing more')
    const mark = order.length
    vis.setVisible([])
    second = ui.mount(ui.messageStreamScene(api)) // and back to the chat tab, with the slow call(s) still running
    vis.attach(second.container)
    await until(() => ['db.chats.list', 'line.status', 'messages.recent', 'db.messages.list'].every((path) => order.slice(mark).includes(path)),
      { message: `the remount's chat list, LINE status and recent messages reach the backend while ${inFlight} slow avatar call(s) are still running (sent after the mark: ${order.slice(mark).join(',')})` })
    assert.equal(gates.length, inFlight, 'the slow avatar call(s) are still running: nothing waited for them')
    const after = order.slice(mark)
    for (const path of ['db.chats.list', 'line.status', 'messages.recent', 'db.messages.list']) {
      const avatarsFirst = after.slice(0, after.indexOf(path)).filter((entry) => entry === 'avatar').length
      assert.equal(avatarsFirst, 0, `${path} was sent after ${avatarsFirst} stale avatar call(s): ${after.join(',')}`)
    }
    await until(() => walk(second.container).some((el) => el.getAttribute('data-avatar-chat-id') === 'c1'), { message: 'the chat list shows its rows while the avatar call is still running' })
    assert.equal(gates.length, inFlight, 'the rows were shown before the slow avatar call finished')
    assert.ok(api.plugin.transportStats().lanes.bulk.active <= 1, 'avatar calls hold at most one host call slot')
    assert.equal(api.plugin.transportStats().lanes.bulk.waiting, 0, 'nothing of the unmounted page waits for an avatar slot')
    slow = false
    for (const open of gates) open()
    await until(() => api.plugin.transportStats().active === 0, { message: 'the slow call to finish' })
  } finally {
    slow = false
    for (const open of gates) open()
    first?.unmount()
    second?.unmount()
    vis.restore()
    api.dispose()
  }
})

// ───────────── overview tab: the todo board remains; chat topics live with chat todos ─────────────

function recordingHandlers(handlers, log) {
  return new Proxy(handlers, {
    get(target, path) {
      if (typeof path !== 'string') return undefined
      return (...args) => {
        log.push({ path, args })
        const handler = target[path]
        if (!handler) throw Object.assign(new Error(path), { code: 'path_unknown' })
        return handler(...args)
      }
    }
  })
}

const OVERVIEW_GROUPS = Array.from({ length: 8 }, (_, index) => ({ chatId: `ov-group-${index}`, name: `總覽群組${index}` }))
function overviewRows() {
  return OVERVIEW_GROUPS.map((group, index) => ({
    chatId: group.chatId, name: group.name, enabled: index < 3, pendingCount: 0, backlogCount: 0,
    topics: index < 3 ? [{ topicId: `ov-topic-${index}`, chatId: group.chatId, title: `總覽議題${index}`, summary: '摘要。', lastSourceTs: 1, evidenceCount: 1, evidenceMsgIds: [`m${index}`], participantLowerBound: null, userParticipation: 'unknown', relevance: 'unknown', relevanceEvidenceMsgIds: [], relevanceEvidence: [], observation: 'unknown', heat: 'unvalidated', trend: 'unknown' }] : []
  }))
}
function overviewHandlers(log, extra = {}) {
  return recordingHandlers({
    ...settingsHandlers(),
    'db.chats.list': () => OVERVIEW_GROUPS.map((group) => ({ ...group, isGroup: true, firstSeenAt: '2026-10-29T00:00:00.000Z', lastSeenAt: '2026-10-30T00:00:00.000Z' })),
    'db.todos.list': () => [],
    'groupTopics.overview': () => overviewRows(),
    'groupTopics.list': (chatId) => { const row = overviewRows().find((entry) => entry.chatId === chatId); return { ok: !!row?.enabled, topics: row?.topics ?? [] } },
    ...extra
  }, log)
}
test('overview tab: the todo board loads and does not mount the group-topics overview', async () => {
  const log = []
  const { api } = plugin(overviewHandlers(log))
  dom.document.documentElement.dataset ??= {}
  const view = ui.mount(ui.appScene(api))
  try {
    await until(() => log.some((entry) => entry.path === 'db.todos.list') && walk(view.container).some((element) => hasClassName(element, 'board-wrap')), { message: 'the overview board loads' })
    await sleep(60)
    const paths = log.map((entry) => entry.path)
    for (const gone of ['summary', 'summary-stats', 'board-toolbar']) assert.equal(walk(view.container).some((element) => hasClassName(element, gone)), false, `the overview has no ${gone}`)
    for (const gone of ['不是我的回查', '回顧最近', '補媒體金鑰', '立即抓取', '立即整理', 'LINE 橋接', '抽取引擎', '上次抓取', '待確認完成']) assert.equal(view.container.textContent.includes(gone), false, `the overview no longer shows ${gone}`)
    assert.ok(walk(view.container).some((element) => hasClassName(element, 'board-filters')), 'the filter row stays')
    for (const column of ['待辦', '等回覆', '行程', '已完成']) assert.ok(view.container.textContent.includes(column), `the ${column} board column remains`)
    assert.equal(walk(view.container).some((element) => hasClassName(element, 'overview-topics-toggle')), false, 'the group topics section toggle is absent')
    assert.equal(paths.some((path) => path.startsWith('groupTopics.')), false, 'the overview does not load group topics')
    assert.equal(paths.includes('db.todos.list'), true, 'the board continues loading todos')
  } finally { view.unmount(); api.dispose() }
})

test('board loading: while the first todo read is pending the board shows 載入中…, never zero counts or empty-column hints; then the columns appear', async () => {
  const log = []
  let release = () => {}
  const { api } = plugin(overviewHandlers(log, {
    'db.todos.list': () => new Promise((resolve) => { release = () => resolve([]) })
  }))
  dom.document.documentElement.dataset ??= {}
  const view = ui.mount(ui.appScene(api))
  try {
    await until(() => log.some((entry) => entry.path === 'db.todos.list') && view.container.textContent.includes('載入中…'), { message: 'the pending board shows loading' })
    await sleep(40)
    assert.equal(walk(view.container).some((element) => hasClassName(element, 'kb-column')), false, 'no columns while loading')
    assert.equal(walk(view.container).some((element) => hasClassName(element, 'kb-col-count')), false, 'no zero counts while loading')
    for (const hint of ['目前沒有待辦事項', '沒有在等的回覆', '沒有排定的行程', '尚無已完成項目']) assert.equal(view.container.textContent.includes(hint), false, `no empty hint "${hint}" while loading`)
    release()
    await until(() => walk(view.container).filter((element) => hasClassName(element, 'kb-column')).length === 4, { message: 'the four columns appear after the first load' })
    assert.equal(view.container.textContent.includes('載入中…'), false, 'loading line is gone after the first load')
  } finally { view.unmount(); api.dispose() }
})

test('group-topics root tab: an old saved topics value opens the all-groups overview directly and remains selectable', async () => {
  const log = []
  const saved = { 'lt-ui:app.tab': JSON.stringify({ v: 'topics', at: Date.now() }) }
  const writes = []
  const storage = {
    getItem: (key) => saved[key] ?? null,
    setItem: (key, value) => { saved[key] = value; writes.push([key, value]) },
    removeItem: (key) => { delete saved[key] }
  }
  const { api } = plugin(overviewHandlers(log, {
    'groupTopics.pendingCount': () => 0
  }))
  dom.document.documentElement.dataset ??= {}
  const view = ui.mount(ui.appSceneWithState(api, storage))
  const tab = (label) => walk(view.container).find((element) => element.localName === 'button' && element.textContent.trim() === label && hasClassName(element.parentNode, 'app-tabs'))
  try {
    await until(() => tab('群組議題') && log.some((entry) => entry.path === 'groupTopics.overview') && view.container.textContent.includes('總覽議題0'), { message: 'the saved group-topics tab opens its all-groups results' })
    assert.equal(hasClassName(tab('群組議題'), 'active'), true, 'the old persisted topics tab is restored as the new root tab')
    assert.ok(walk(view.container).some((element) => element.localName === 'input' && element.getAttribute('aria-label') === '搜尋議題'), 'the initial view is the topic list with its search box')
    assert.ok(walk(view.container).some((element) => hasClassName(element, 'group-topics-list')), 'the topic list is mounted')
    assert.equal(log.some((entry) => entry.path === 'db.todos.list'), false, 'opening the topic tab did not depend on overview-board loading')
    assert.equal(log.some((entry) => entry.path.startsWith('messages.')), false, 'opening the topic tab did not depend on selecting a chat')

    const groupSelect = walk(view.container).find((element) => element.localName === 'select' && hasClassName(element.parentNode, 'group-topics-group-select'))
    assert.ok(groupSelect, 'the chat filter stays available')
    reactProps(groupSelect).onChange({ target: { value: 'ov-group-1' } })
    await until(() => log.some((entry) => entry.path === 'groupTopics.list' && entry.args[0] === 'ov-group-1') && view.container.textContent.includes('討論紀錄'), { message: 'choosing a group opens its existing topic controls' })
    const groupSwitch = switchByLabel(view, '此群組的議題開關')
    assert.ok(groupSwitch, 'the per-group start/stop switch renders next to the heading')
    assert.ok(view.container.textContent.includes('討論紀錄'), 'the heading is the plain-language discussion heading')
    reactProps(tab('總覽')).onClick()
    await until(() => walk(view.container).some((element) => hasClassName(element, 'board-wrap')), { message: 'the existing overview board opens' })
    reactProps(tab('群組議題')).onClick()
    await until(() => log.filter((entry) => entry.path === 'groupTopics.overview').length >= 2 && view.container.textContent.includes('總覽議題0'), { message: 'the saved root tab can be reopened' })
    assert.equal(JSON.parse(saved['lt-ui:app.tab']).v, 'topics', 'the group-topics selection is persisted with the existing app.tab key')
    assert.ok(writes.some(([key]) => key === 'lt-ui:app.tab'), 'tab changes use the existing persistent UI state store')
  } finally { view.unmount(); api.dispose() }
})

test('overview refresher: bursts of requests collapse into one load, loads are at least minInterval apart, and dispose stops everything', async () => {
  let now = 0
  const timers = []
  const fake = { now: () => now, set: (callback, ms) => { const timer = { callback, at: now + ms, cleared: false }; timers.push(timer); return timer }, clear: (timer) => { timer.cleared = true } }
  const loads = []
  let finish
  const refresher = ui.createOverviewRefresher(() => { loads.push(now); return new Promise((resolve) => { finish = resolve }) }, 2000, fake)
  const fire = () => { const due = timers.filter((timer) => !timer.cleared && timer.at <= now); for (const timer of due) { timer.cleared = true; timer.callback() } }
  refresher.request(); refresher.request(); refresher.request()
  fire()
  assert.deepEqual(loads, [0], 'three requests, one load')
  refresher.request(); refresher.request()
  assert.deepEqual(loads, [0], 'a request while loading waits')
  finish(); await sleep(0)
  now = 500; fire()
  assert.deepEqual(loads, [0], 'the follow-up load waits for the 2s spacing')
  now = 2000; fire()
  assert.deepEqual(loads, [0, 2000])
  refresher.dispose()
  finish(); await sleep(0)
  refresher.request(); now = 9000; fire()
  assert.deepEqual(loads, [0, 2000], 'nothing runs after dispose')
})

test('M2 sharedRead: a failed read does not stick, the next read issues a new call', async () => {
  const owner = {}
  let calls = 0
  const read = () => { calls += 1; return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('v' + calls) }
  await assert.rejects(ui.sharedRead(owner, 'k', read), /boom/)
  assert.equal(calls, 1)
  assert.equal(await ui.sharedRead(owner, 'k', read), 'v2')
  assert.equal(calls, 2, 'the read after the failure went out again')
})

test('M2 sharedRead: after a successful read completes, the next read issues a new call (no stale cache)', async () => {
  const owner = {}
  let calls = 0
  const read = () => { calls += 1; return Promise.resolve('v' + calls) }
  assert.equal(await ui.sharedRead(owner, 'k', read), 'v1')
  await sleep(0)
  assert.equal(await ui.sharedRead(owner, 'k', read), 'v2')
  assert.equal(calls, 2)
})

test('M2 sharedRead: concurrent reads of the same key share one call and one promise; other keys and other owners do not share', async () => {
  const owner = {}
  let calls = 0
  const finishers = []
  const read = () => { calls += 1; return new Promise((resolve) => { finishers.push(resolve) }) }
  const a = ui.sharedRead(owner, 'k', read)
  const b = ui.sharedRead(owner, 'k', read)
  assert.equal(a, b, 'same promise while in flight')
  assert.equal(calls, 1)
  const otherKey = ui.sharedRead(owner, 'other', read)
  const otherOwner = ui.sharedRead({}, 'k', read)
  assert.equal(calls, 3, 'a different key and a different owner each get their own call')
  for (const finish of finishers) finish('x')
  await Promise.all([a, b, otherKey, otherOwner])
})

function groupTopicsApi(log, extra = {}, { onRun } = {}) {
  const { api } = plugin(overviewHandlers(log, extra))
  if (!onRun) return api
  return { ...api, pipeline: { ...api.pipeline, onRun: (callback) => { onRun(callback); return () => undefined } } }
}

test('L1 overview: the first load goes through the refresher, so a pipeline-run right after it still waits for the 2 s spacing', async () => {
  const log = []
  let fireRun
  const api = groupTopicsApi(log, {}, { onRun: (callback) => { fireRun = callback } })
  dom.document.documentElement.dataset ??= {}
  const view = ui.mount(ui.groupTopicsScene(api))
  try {
    await until(() => log.some((entry) => entry.path === 'groupTopics.overview') && fireRun, { message: 'first overview read' })
    const first = Date.now()
    fireRun({ topicChatIds: ['ov-group-1'] })
    fireRun({ topicChatIds: ['ov-group-1'] })
    await sleep(600)
    assert.equal(log.filter((entry) => entry.path === 'groupTopics.overview').length, 1, 'no second read inside the 2 s window')
    await until(() => log.filter((entry) => entry.path === 'groupTopics.overview').length === 2, { timeout: 4000, message: 'the follow-up read after the spacing' })
    const gap = Date.now() - first
    assert.ok(gap >= 1500, 'second read came ' + gap + ' ms after the first')
    await sleep(80)
    assert.equal(log.filter((entry) => entry.path === 'groupTopics.overview').length, 2, 'the two run events coalesced into one read')
  } finally { view.unmount(); api.dispose() }
})

test('L3 overview: a pipeline-run without topicChatIds (todo-only round) does not re-read the overview; one with topicChatIds does', async () => {
  const log = []
  let fireRun
  const api = groupTopicsApi(log, {}, { onRun: (callback) => { fireRun = callback } })
  dom.document.documentElement.dataset ??= {}
  const view = ui.mount(ui.groupTopicsScene(api))
  try {
    await until(() => log.some((entry) => entry.path === 'groupTopics.overview') && fireRun, { message: 'first overview read' })
    const reads = () => log.filter((entry) => entry.path === 'groupTopics.overview').length
    assert.equal(reads(), 1)
    fireRun({})
    fireRun({ topicChatIds: [] })
    fireRun({ createdIds: ['t1'] })
    await sleep(2600)
    assert.equal(reads(), 1, 'todo-only runs never re-read the overview')
    fireRun({ topicChatIds: ['ov-group-1'] })
    await until(() => reads() === 2, { timeout: 4000, message: 'a run that wrote topics re-reads the overview' })
  } finally { view.unmount(); api.dispose() }
})

test('L2 overview: a first load that fails shows only the error, not the empty-group sentence', async () => {
  const log = []
  const api = groupTopicsApi(log, { 'groupTopics.overview': () => { throw new Error('synthetic overview failure') } })
  dom.document.documentElement.dataset ??= {}
  const view = ui.mount(ui.groupTopicsScene(api))
  try {
    await until(() => view.container.textContent.includes('群組議題總覽載入失敗'), { message: 'the error is shown' })
    assert.equal(view.container.textContent.includes('尚無議題'), false, 'error and empty sentence never together')
    assert.equal(view.container.textContent.includes('載入中…'), false, 'not stuck on loading')
  } finally { view.unmount(); api.dispose() }
})

test('overview list: choosing a chat filter does not re-read the overview; an analysis run re-reads it so the list shows the result', async () => {
  const log = []
  let calls = 0
  const api = groupTopicsApi(log, {
    'groupTopics.overview': () => { calls += 1; return overviewRows() },
    'groupTopics.list': (chatId) => ({ ok: chatId === 'ov-group-1', topics: [] }),
    'groupTopics.pendingCount': () => 0,
    'groupTopics.analyze': () => ({ ok: true, count: 1, analyzedCount: 1 })
  })
  dom.document.documentElement.dataset ??= {}
  const view = ui.mount(ui.groupTopicsScene(api))
  const select = () => walk(view.container).find((element) => element.localName === 'select' && hasClassName(element.parentNode, 'group-topics-group-select'))
  try {
    await until(() => view.container.textContent.includes('總覽議題0'), { message: 'first read shown' })
    reactProps(select()).onChange({ target: { value: 'ov-group-1' } })
    await until(() => hasSwitch(view, '此群組的議題開關') && buttonTexts(view).includes('分析最近群組訊息'), { message: 'the chat filter shows its switch and the analyze button' })
    assert.deepEqual(walk(view.container).filter((element) => hasClassName(element, 'topics-row')).map((row) => walk(row).find((element) => element.localName === 'strong').textContent), ['總覽議題1'], 'the list narrows to the chosen chat')
    assert.equal(calls, 1, 'choosing a filter does not re-read the overview')
    reactProps(walk(view.container).find((element) => element.localName === 'button' && element.textContent.trim() === '分析最近群組訊息')).onClick()
    await until(() => calls === 2, { timeout: 5000, message: 'the analysis run re-reads the overview' })
    await until(() => view.container.textContent.includes('總覽議題1'), { message: 'the list is still shown after the re-read' })
  } finally { view.unmount(); api.dispose() }
})

test('M1 overview UI: a trimmed or compacted group adds no note above the list (the 群組議題 page has no explanatory line)', async () => {
  const log = []
  const rows = overviewRows()
  rows[0] = { ...rows[0], topicCount: 31, compacted: true }
  const api = groupTopicsApi(log, { 'groupTopics.overview': () => rows })
  dom.document.documentElement.dataset ??= {}
  const view = ui.mount(ui.groupTopicsScene(api))
  try {
    await until(() => view.container.textContent.includes('總覽議題0'), { message: 'overview shown' })
    const text = view.container.textContent
    assert.equal(text.includes('部分議題已縮短或未列出'), false, 'the explanatory line is gone')
    assert.equal(text.includes('只顯示最近'), false, 'no per-group hint any more')
  } finally { view.unmount(); api.dispose() }
})

// ───────────── 群組議題列表：一列一則議題（聊天室／議題／最後更新），可排序、搜尋、依聊天室篩選 ─────────────

const listTopicRow = (topicId, chatId, title, lastSourceTs, summary = '摘要。') => ({
  topicId, chatId, title, summary, lastSourceTs, evidenceCount: 1, evidenceMsgIds: [`${topicId}-m`], participantLowerBound: null,
  userParticipation: 'unknown', relevance: 'unknown', relevanceEvidence: [], observation: 'unknown', heat: 'unvalidated', trend: 'unknown'
})
// 列表甲 2 則、列表丁 1 則、列表乙 已啟用但沒有議題、列表丙 未啟用：列表只該有三列。
const LIST_ROWS = () => [
  { chatId: 'list-a', name: '列表甲', enabled: true, pendingCount: 0, backlogCount: 0, topics: [listTopicRow('t-a1', 'list-a', '甲一', Date.UTC(2026, 10, 1)), listTopicRow('t-a2', 'list-a', '甲二', Date.UTC(2026, 10, 3))] },
  { chatId: 'list-b', name: '列表乙', enabled: true, pendingCount: 0, backlogCount: 0, topics: [] },
  { chatId: 'list-c', name: '列表丙', enabled: false, pendingCount: 0, backlogCount: 0, topics: [] },
  { chatId: 'list-d', name: '列表丁', enabled: true, pendingCount: 0, backlogCount: 0, topics: [listTopicRow('t-d1', 'list-d', '丁一', Date.UTC(2026, 10, 2))] }
]
const listApi = (log, extra = {}) => groupTopicsApi(log, { 'groupTopics.overview': () => LIST_ROWS(), 'groupTopics.pendingCount': () => 0, ...extra })
const topicRowEls = (view) => walk(view.container).filter((element) => hasClassName(element, 'topics-row'))
const rowTitles = (view) => topicRowEls(view).map((row) => walk(row).find((element) => element.localName === 'strong').textContent)
const headerTh = (view, label) => walk(view.container).find((element) => element.localName === 'th' && element.textContent.trim().startsWith(label))
const headerButton = (view, label) => walk(headerTh(view, label)).find((element) => element.localName === 'button')
const searchInput = (view) => walk(view.container).find((element) => element.localName === 'input' && element.getAttribute('aria-label') === '搜尋議題')
const chatFilter = (view) => walk(view.container).find((element) => element.localName === 'select' && hasClassName(element.parentNode, 'group-topics-group-select'))

test('topic list: one row per topic with its chat name, newest first; columns 聊天室 / 議題 / 最後更新; groups without topics add no row and no sentence', async () => {
  const log = []
  const api = listApi(log)
  dom.document.documentElement.dataset ??= {}
  const view = ui.mount(ui.groupTopicsScene(api))
  try {
    await until(() => topicRowEls(view).length === 3, { message: 'three topic rows' })
    assert.deepEqual(rowTitles(view), ['甲二', '丁一', '甲一'], 'newest first by default')
    assert.deepEqual(topicRowEls(view).map((row) => walk(row).find((element) => hasClassName(element, 'topics-col-chat')).textContent), ['列表甲', '列表丁', '列表甲'])
    assert.deepEqual(['聊天室', '議題', '最後更新'].map((label) => headerTh(view, label) !== undefined), [true, true, true], 'the three columns')
    assert.equal(headerTh(view, '最後更新').getAttribute('aria-sort'), 'descending')
    assert.match(walk(topicRowEls(view)[0]).find((element) => hasClassName(element, 'topics-col-time')).textContent, /^\d\d\/\d\d \d\d:\d\d$/)
    assert.equal(topicRowEls(view).some((row) => row.textContent.includes('列表乙')), false, 'a group with no topics has no row')
    assert.equal(view.container.textContent.includes('此群已啟用'), false, 'no per-group sentence')
    assert.equal(view.container.textContent.includes('尚無討論紀錄'), false, 'no per-group empty result line')
    assert.ok(chatFilter(view).textContent.includes('列表丙'), 'the chat dropdown still offers every group')
  } finally { view.unmount(); api.dispose() }
})

test('topic list sort: a header click sorts, the next click on the same header reverses, and aria-sort follows', async () => {
  const log = []
  const api = listApi(log)
  dom.document.documentElement.dataset ??= {}
  const view = ui.mount(ui.groupTopicsScene(api))
  try {
    await until(() => topicRowEls(view).length === 3, { message: 'three topic rows' })
    const newestFirst = rowTitles(view)
    const sortedBy = (label) => headerTh(view, label).getAttribute('aria-sort')
    reactProps(headerButton(view, '議題')).onClick()
    await until(() => sortedBy('議題') === 'ascending', { message: 'first click on a text column is ascending' })
    const ascending = rowTitles(view)
    reactProps(headerButton(view, '議題')).onClick()
    await until(() => sortedBy('議題') === 'descending', { message: 'second click reverses' })
    await until(() => rowTitles(view).join() === [...ascending].reverse().join(), { message: 'descending is the reverse of ascending' })
    assert.equal(sortedBy('最後更新'), 'none', 'the other columns are not sorted')
    reactProps(headerButton(view, '最後更新')).onClick()
    await until(() => sortedBy('最後更新') === 'descending', { message: 'a time column starts newest first' })
    await until(() => rowTitles(view).join() === newestFirst.join(), { message: 'back to newest first' })
  } finally { view.unmount(); api.dispose() }
})

test('topic list search: a keyword narrows the rows by title or chat name; no match shows one line; an empty box shows everything', async () => {
  const log = []
  const api = listApi(log)
  dom.document.documentElement.dataset ??= {}
  const view = ui.mount(ui.groupTopicsScene(api))
  try {
    await until(() => topicRowEls(view).length === 3, { message: 'three topic rows' })
    reactProps(searchInput(view)).onChange({ target: { value: '丁' } })
    await until(() => rowTitles(view).join() === '丁一', { message: 'chat name keyword' })
    reactProps(searchInput(view)).onChange({ target: { value: '甲' } })
    await until(() => rowTitles(view).join() === '甲二,甲一', { message: 'title and chat name keyword' })
    reactProps(searchInput(view)).onChange({ target: { value: '不存在的字' } })
    await until(() => topicRowEls(view).length === 0 && view.container.textContent.includes('沒有符合的議題'), { message: 'no-match line' })
    reactProps(searchInput(view)).onChange({ target: { value: '' } })
    await until(() => topicRowEls(view).length === 3, { message: 'empty box shows everything' })
  } finally { view.unmount(); api.dispose() }
})

test('topic list filter: the chat dropdown narrows the rows and shows that chat’s switch; 全部 brings every row back', async () => {
  const log = []
  const api = listApi(log)
  dom.document.documentElement.dataset ??= {}
  const view = ui.mount(ui.groupTopicsScene(api))
  try {
    await until(() => topicRowEls(view).length === 3, { message: 'three topic rows' })
    assert.equal(hasSwitch(view, '此群組的議題開關'), false, 'no chat switch while every chat is listed')
    reactProps(chatFilter(view)).onChange({ target: { value: 'list-d' } })
    await until(() => rowTitles(view).join() === '丁一' && hasSwitch(view, '此群組的議題開關'), { message: 'one chat filtered, its switch shown' })
    reactProps(chatFilter(view)).onChange({ target: { value: '__all_groups__' } })
    await until(() => topicRowEls(view).length === 3 && !hasSwitch(view, '此群組的議題開關'), { message: 'all chats again' })
    assert.equal(log.filter((entry) => entry.path === 'groupTopics.overview').length, 1, 'filtering never re-reads the overview')
  } finally { view.unmount(); api.dispose() }
})

test('topic list empty: with no topics at all there is one short line and no table, search box or chat dropdown', async () => {
  const log = []
  const api = listApi(log, { 'groupTopics.overview': () => LIST_ROWS().map((row) => ({ ...row, topics: [] })) })
  dom.document.documentElement.dataset ??= {}
  const view = ui.mount(ui.groupTopicsScene(api))
  try {
    await until(() => view.container.textContent.includes('尚無議題'), { message: 'the empty line' })
    assert.equal(walk(view.container).some((element) => element.localName === 'table'), false, 'no table')
    assert.equal(searchInput(view), undefined, 'no search box')
    assert.equal(chatFilter(view), undefined, 'no chat dropdown')
    assert.equal(view.container.textContent.includes('此群已啟用'), false)
  } finally { view.unmount(); api.dispose() }
})

/** An IntersectionObserver stand-in for the list's sentinel: `reach()` is "the user scrolled to the bottom". */
function installSentinelStandIn() {
  const observers = []
  const previous = globalThis.IntersectionObserver
  globalThis.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this) }
    observe(target) { this.targets.add(target) }
    unobserve(target) { this.targets.delete(target) }
    disconnect() { this.targets.clear() }
  }
  return {
    reach() {
      for (const observer of observers) {
        if (observer.targets.size > 0) observer.callback([...observer.targets].map((target) => ({ target, isIntersecting: true })))
      }
    },
    restore() { if (previous === undefined) delete globalThis.IntersectionObserver; else globalThis.IntersectionObserver = previous }
  }
}

test('topic list batching: 30 rows first, the next 30 when the sentinel is reached, and a sort change starts over at 30', async () => {
  const many = Array.from({ length: 65 }, (_, index) => listTopicRow(`b-${index}`, 'list-a', `批次${String(index).padStart(2, '0')}`, Date.UTC(2026, 10, 1) + index * 1000))
  const log = []
  const sentinel = installSentinelStandIn()
  const api = listApi(log, { 'groupTopics.overview': () => [{ ...LIST_ROWS()[0], topics: many }] })
  dom.document.documentElement.dataset ??= {}
  const view = ui.mount(ui.groupTopicsScene(api))
  try {
    await until(() => topicRowEls(view).length === 30, { message: 'the first batch of 30 rows' })
    assert.ok(byAttr(view.container, 'data-testid', 'topics-sentinel'), 'the sentinel waits below the first batch')
    sentinel.reach()
    await until(() => topicRowEls(view).length === 60, { message: 'the second batch' })
    sentinel.reach()
    await until(() => topicRowEls(view).length === 65, { message: 'the last rows' })
    assert.equal(byAttr(view.container, 'data-testid', 'topics-sentinel'), null, 'no sentinel once everything is drawn')
    reactProps(headerButton(view, '議題')).onClick()
    await until(() => topicRowEls(view).length === 30, { message: 'a sort change starts over at 30' })
    assert.equal(rowTitles(view)[0], '批次00', 'the sorted list starts from the first row of the new order')
  } finally { sentinel.restore(); view.unmount(); api.dispose() }
})

// ───────────── Phase 4: combined todo+topic wording and switch ─────────────

const buttonTexts = (view) => walk(view.container).filter((element) => element.localName === 'button').map((element) => element.textContent.trim())

test('Phase 4 wording: 立即整理 when the combined switch is on (plugin host); 立即抓取 when it is off or absent', async () => {
  for (const [flag, expected, unexpected] of [[true, '立即整理', '立即抓取'], [false, '立即抓取', '立即整理'], [undefined, '立即抓取', '立即整理']]) {
    const { api } = plugin(settingsHandlers({ 'settings.get': () => ({ ...VIEW, ...(flag === undefined ? {} : { pluginCombinedExtract: flag }) }) }))
    const view = ui.mount(ui.opsScene(api))
    try {
      await until(() => byAttr(view.container, 'data-testid', 'ops-run')?.textContent.trim() === expected, { message: `the ${expected} button (flag ${flag})` })
      assert.ok(!buttonTexts(view).includes(unexpected))
    } finally { view.unmount(); api.dispose() }
  }
})

test('Phase 4 wording: the review button says it only produces todos when the combined switch is on', async () => {
  for (const flag of [true, false]) {
    const { api } = plugin(settingsHandlers({ 'settings.get': () => ({ ...VIEW, pluginCombinedExtract: flag }), 'pipeline.status': () => ({ hasApiKey: true }) }))
    const view = ui.mount(ui.opsScene(api, { pollDelayMs: () => 60_000 }))
    try {
      const review = () => byAttr(view.container, 'data-testid', 'ops-review')
      await until(() => review() && (flag ? String(reactProps(review()).title).includes('只產出待辦') : !String(reactProps(review()).title).includes('只產出待辦') && String(reactProps(review()).title).includes('補建代辦')), { message: `review tooltip (flag ${flag})` })
    } finally { view.unmount(); api.dispose() }
  }
})

test('Phase 4 settings: the combined switch shows the stored value and writes pluginCombinedExtract through settings.update; the prompt section explains the fixed topic appendix', async () => {
  const updates = []
  const view0 = { ...VIEW, pluginCombinedExtract: true }
  const { api } = plugin(settingsHandlers({
    'settings.get': () => view0,
    'settings.update': (patch) => { updates.push(patch); return { ...view0, ...patch } },
    'settings.prompt.get': () => ({ initialPrompt: '初始', activePrompt: '初始', customized: false, revision: 'initial', maxChars: 12000, outputFormat: '固定', topicAppendix: '已啟用議題的群組會另外附加固定段落（測試文案）。' })
  }))
  const view = ui.mount(ui.settingsScene(api))
  try {
    await until(() => byAttr(view.container, 'data-testid', 'combined-extract-toggle') && byAttr(view.container, 'data-testid', 'topic-appendix'), { message: 'the switch and the appendix note' })
    const toggle = () => byAttr(view.container, 'data-testid', 'combined-extract-toggle')
    assert.equal(reactProps(toggle()).checked, true)
    assert.ok(byAttr(view.container, 'data-testid', 'topic-appendix').textContent.includes('固定段落'))
    reactProps(toggle()).onChange({ target: { checked: false } })
    await until(() => updates.length === 1, { message: 'settings.update' })
    assert.deepEqual(updates[0], { pluginCombinedExtract: false })
    await until(() => reactProps(toggle()).checked === false, { message: 'the switch follows the saved value' })
    await sleep(1400) // SettingsPanel's success flash schedules a 1.2s state reset; let it finish before the suite restores window/document
  } finally { view.unmount(); api.dispose() }
})

test('Phase 4 groupTopics panel: while the combined path is active the button is 補分析舊訊息 and only appears when there are old messages to analyze; otherwise the legacy button', async () => {
  const enabled = new Set(['ov-group-0'])
  const state = { combined: true, pending: 3 }
  const log = []
  const { api } = plugin(overviewHandlers(log, {
    'groupTopics.list': (chatId) => ({ ok: enabled.has(chatId), topics: [], ...(state.combined ? { combined: true } : {}) }),
    'groupTopics.pendingCount': () => state.pending,
    'groupTopics.analyze': () => ({ ok: true, count: 0, analyzedCount: 3 })
  }))
  dom.document.documentElement.dataset ??= {}
  const view = ui.mount(ui.groupTopicsScene(api))
  try {
    await until(() => view.container.textContent.includes('總覽議題0'), { message: 'overview shown' })
    const select = walk(view.container).find((element) => element.localName === 'select' && hasClassName(element.parentNode, 'group-topics-group-select'))
    reactProps(select).onChange({ target: { value: 'ov-group-0' } })
    await until(() => buttonTexts(view).includes('補分析舊訊息'), { message: 'combined mode: backfill button with 3 old messages' })
    assert.ok(!buttonTexts(view).includes('分析最近群組訊息'))
    assert.equal(view.container.textContent.includes('每批最多'), false, 'the 20-per-batch line is gone')
    assert.equal(walk(view.container).some((element) => hasClassName(element, 'group-topics-pending')), false, 'no pending explanation paragraph')
    const backfill = () => walk(view.container).find((element) => element.localName === 'button' && element.textContent.trim() === '補分析舊訊息')
    reactProps(backfill()).onClick()
    await until(() => log.some((entry) => entry.path === 'groupTopics.analyze'), { message: 'the backfill calls groupTopics.analyze' })
  } finally { view.unmount(); api.dispose() }

  state.pending = 0
  const quiet = plugin(overviewHandlers([], {
    'groupTopics.list': (chatId) => ({ ok: enabled.has(chatId), topics: [], combined: true }),
    'groupTopics.pendingCount': () => 0
  }))
  const view2 = ui.mount(ui.groupTopicsScene(quiet.api))
  try {
    await until(() => view2.container.textContent.includes('總覽議題0'), { message: 'overview shown (second mount)' })
    const select = walk(view2.container).find((element) => element.localName === 'select' && hasClassName(element.parentNode, 'group-topics-group-select'))
    reactProps(select).onChange({ target: { value: 'ov-group-0' } })
    await until(() => hasSwitch(view2, '此群組的議題開關') && !walk(view2.container).some((element) => hasClassName(element, 'group-topics-pending')), { message: 'nothing to backfill: no button and no pending paragraph' })
    assert.ok(!buttonTexts(view2).includes('補分析舊訊息'), 'no old messages: the backfill button is hidden')
    assert.ok(!buttonTexts(view2).includes('分析最近群組訊息'), 'and the legacy button does not come back')
  } finally { view2.unmount(); quiet.api.dispose() }
})

// ───────────── 聊天室「議題」「待辦」兩個獨立開關（U1–U8） ─────────────

function toggleChat(chatId, name, isGroup) {
  return { chatId, name, isGroup, firstSeenAt: '2026-10-29T00:00:00.000Z', lastSeenAt: '2026-10-30T00:00:00.000Z' }
}

function toggleTodo(id, chatId, title) {
  return { id, chatId, bucket: 'todo', status: 'pending', title, detail: null, priority: 1, dueAt: null, sourceMsgIds: [`${id}-src`], confidence: 0.9, completionEvidence: null, createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z', resolvedAt: null }
}

function toggleScene(chats, handlers = {}) {
  const calls = []
  const rec = (path, fn) => (...args) => { calls.push({ path, args }); return fn(...args) }
  const wrapped = Object.fromEntries(Object.entries(handlers).map(([path, fn]) => [path, rec(path, fn)]))
  const { api } = plugin({
    'db.chats.list': () => chats,
    'db.messages.list': () => [],
    'db.messages.recentByChat': () => [],
    'messages.recent': () => [],
    'line.status': () => ({ state: 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 }),
    'groupTopics.pendingCount': () => 0,
    'groupTopics.list': () => ({ ok: false, topics: [] }),
    'db.todos.openByChat': () => [],
    'db.chats.todoExtractEnabled': () => true,
    ...wrapped
  })
  const view = ui.mount(ui.messageStreamScene(api))
  const paneButton = (label) => walk(view.container).find((element) => element.localName === 'button' && element.textContent.trim() === label && element.hasAttribute('aria-pressed'))
  const chatButton = (name) => walk(view.container).find((element) => hasClassName(element, 'chat-list-item') && element.textContent.includes(name))
  const click = (button) => reactProps(button).onClick({ currentTarget: button })
  const todoSwitch = () => switchByLabel(view, '此聊天室待辦開關')
  const topicSwitch = (label) => switchByLabel(view, label)
  const change = (input, checked) => reactProps(input).onChange({ target: { checked } })
  const callsTo = (path) => calls.filter((entry) => entry.path === path)
  return { api, view, calls, callsTo, paneButton, chatButton, click, todoSwitch, topicSwitch, change, dispose() { view.unmount(); api.dispose() } }
}

async function openCombinedPane(scene) {
  await until(() => scene.paneButton('議題與待辦'), { message: 'combined pane button' })
  scene.click(scene.paneButton('議題與待辦'))
}

test('U1 the todo switch starts on, turning it off calls only db.chats.setTodoExtractEnabled, and a failure or ok:false rolls back with an error', async () => {
  const chat = toggleChat('toggle-u1', '合成群組U1', true)
  let mode = 'ok'
  const s = toggleScene([chat], {
    'db.todos.openByChat': () => [toggleTodo('u1-todo', chat.chatId, 'U1 既有待辦')],
    'db.chats.setTodoExtractEnabled': (chatId, enabled) => {
      if (mode === 'throw') throw Object.assign(new Error('synthetic switch failure'), { code: 'internal' })
      if (mode === 'refuse') return { ok: false, enabled: true, skippedOlder: 0 }
      return { ok: true, enabled, skippedOlder: 0 }
    }
  })
  try {
    await openCombinedPane(s)
    await until(() => s.todoSwitch(), { message: 'the todo switch renders once the preference is read' })
    assert.equal(reactProps(s.todoSwitch()).checked, true, 'default is on')
    s.change(s.todoSwitch(), false)
    await until(() => s.callsTo('db.chats.setTodoExtractEnabled').length === 1 && reactProps(s.todoSwitch()).checked === false, { message: 'turned off' })
    assert.equal(s.view.container.textContent.includes('已關閉'), false, 'no success or explanation text')
    assert.deepEqual(s.callsTo('db.chats.setTodoExtractEnabled')[0].args, [chat.chatId, false])
    assert.equal(s.callsTo('groupTopics.setEnabled').length, 0, 'the todo switch never touches the topic preference')
    mode = 'throw'
    s.change(s.todoSwitch(), true)
    await until(() => s.view.container.textContent.includes('切換失敗，請再試一次') && reactProps(s.todoSwitch()).checked === false, { message: 'failure rolls the switch back and shows the error' })
    mode = 'refuse'
    s.change(s.todoSwitch(), true)
    await until(() => s.callsTo('db.chats.setTodoExtractEnabled').length === 3 && reactProps(s.todoSwitch()).checked === false, { message: 'ok:false rolls the switch back' })
    assert.ok(s.view.container.textContent.includes('切換失敗，請再試一次'))
  } finally { s.dispose() }
})

test('U2 the topic switch calls only groupTopics.setEnabled and rolls back on failure or ok:false', async () => {
  const chat = toggleChat('toggle-u2', '合成群組U2', true)
  let mode = 'ok'
  let enabled = false
  const s = toggleScene([chat], {
    'groupTopics.list': () => ({ ok: enabled, topics: [] }),
    'groupTopics.setEnabled': (chatId, value) => {
      if (mode === 'throw') throw Object.assign(new Error('synthetic topic switch failure'), { code: 'internal' })
      if (mode === 'refuse') return { ok: false }
      enabled = value
      return { ok: true }
    },
    'db.chats.setTodoExtractEnabled': (chatId, value) => ({ ok: true, enabled: value, skippedOlder: 0 })
  })
  try {
    await openCombinedPane(s)
    await until(() => s.topicSwitch('此群組的議題開關'), { message: 'the topic switch renders' })
    assert.equal(reactProps(s.topicSwitch('此群組的議題開關')).checked, false, 'topics default to off')
    s.change(s.topicSwitch('此群組的議題開關'), true)
    await until(() => s.callsTo('groupTopics.setEnabled').length === 1 && reactProps(s.topicSwitch('此群組的議題開關')).checked === true, { message: 'turned on' })
    assert.equal(s.view.container.textContent.includes('已啟動'), false, 'no success text')
    assert.equal(s.callsTo('db.chats.setTodoExtractEnabled').length, 0, 'the topic switch never touches the todo preference')
    mode = 'throw'
    s.change(s.topicSwitch('此群組的議題開關'), false)
    await until(() => s.view.container.textContent.includes('切換失敗，請再試一次') && reactProps(s.topicSwitch('此群組的議題開關')).checked === true, { message: 'failure rolls back' })
    mode = 'refuse'
    s.change(s.topicSwitch('此群組的議題開關'), false)
    await until(() => s.view.container.textContent.includes('切換失敗，請再試一次') && reactProps(s.topicSwitch('此群組的議題開關')).checked === true, { message: 'ok:false rolls back' })
  } finally { s.dispose() }
})

test('F3a the topic switch fails only when setEnabled itself fails: a refresh failure afterwards shows the panel load error, never the switch failure text', async () => {
  const chat = toggleChat('toggle-f3a', '合成群組F3a', true)
  let enabled = false
  let breakList = false
  const s = toggleScene([chat], {
    'groupTopics.list': () => {
      if (breakList) throw Object.assign(new Error('synthetic refresh failure'), { code: 'internal' })
      return { ok: enabled, topics: [] }
    },
    'groupTopics.setEnabled': (chatId, value) => { enabled = value; breakList = true; return { ok: true } }
  })
  try {
    await openCombinedPane(s)
    await until(() => s.topicSwitch('此群組的議題開關'), { message: 'the topic switch renders' })
    s.change(s.topicSwitch('此群組的議題開關'), true)
    await until(() => s.callsTo('groupTopics.setEnabled').length === 1 && s.view.container.textContent.includes('議題資料載入失敗'), { message: 'the existing load error is shown' })
    assert.ok(!s.view.container.textContent.includes('切換失敗，請再試一次'), 'a refresh failure is not a switch failure')
    breakList = false
    const retry = walk(s.view.container).find((element) => element.localName === 'button' && element.textContent.includes('重試'))
    assert.ok(retry, 'the load error offers its retry')
    reactProps(retry).onClick({ currentTarget: retry })
    await until(() => s.topicSwitch('此群組的議題開關') && reactProps(s.topicSwitch('此群組的議題開關')).checked === true, { message: 'the switch keeps the new value' })
    assert.equal(s.callsTo('groupTopics.setEnabled').length, 1, 'no rollback call')
  } finally { s.dispose() }
})

test('F3b turning topics on never flashes the empty result text or the analyse button before the refresh completes', async () => {
  const chat = toggleChat('toggle-f3b', '合成群組F3b', true)
  let enabled = false
  let releaseList
  let hold = false
  const s = toggleScene([chat], {
    'groupTopics.list': () => (hold ? new Promise((resolve) => { releaseList = () => resolve({ ok: true, topics: [] }) }) : { ok: enabled, topics: [] }),
    'groupTopics.setEnabled': (chatId, value) => { enabled = value; hold = true; return { ok: true } }
  })
  try {
    await openCombinedPane(s)
    await until(() => s.topicSwitch('此群組的議題開關'), { message: 'the topic switch renders' })
    s.change(s.topicSwitch('此群組的議題開關'), true)
    await until(() => s.callsTo('groupTopics.setEnabled').length === 1 && typeof releaseList === 'function', { message: 'the refresh is pending' })
    assert.ok(!s.view.container.textContent.includes('尚無討論紀錄'), 'no empty-result flash')
    assert.ok(!s.view.container.textContent.includes('分析最近'), 'no analyse button flash')
    releaseList()
    await until(() => s.view.container.textContent.includes('尚無討論紀錄'), { message: 'the result area appears after the refresh' })
  } finally { s.dispose() }
})

test('F3 embedded 議題與待辦頁籤：不論 combined 與待辦開關為何，都不顯示舊的「補分析舊訊息」與「分析最近群組訊息」', async () => {
  for (const combined of [true, false]) {
    for (const todoOn of [true, false]) {
      const chat = toggleChat(`toggle-f3-${combined}-${todoOn}`, '合成群組F3', true)
      const s = toggleScene([chat], {
        'db.chats.todoExtractEnabled': () => todoOn,
        'groupTopics.list': () => ({ ok: true, topics: [], ...(combined ? { combined: true } : {}) }),
        'groupTopics.pendingCount': () => 3
      })
      const label = `combined=${combined} 待辦=${todoOn ? '開' : '關'}`
      try {
        await openCombinedPane(s)
        await until(() => hasSwitch(s.view, '此群組的議題開關') && s.view.container.textContent.includes('尚無討論紀錄'), { message: `${label}: the topics panel is rendered` })
        assert.ok(!buttonTexts(s.view).includes('補分析舊訊息'), `${label}: no backfill button in the embedded panel`)
        assert.ok(!buttonTexts(s.view).includes('分析最近群組訊息'), `${label}: no legacy analyse button in the embedded panel`)
      } finally { s.dispose() }
    }
  }
})

test('U3 switches are absent while loading, disabled and aria-busy while saving, and a late reply from another chat cannot overwrite the current one', async () => {
  const one = { ...toggleChat('toggle-u3a', '合成甲', false), lastSeenAt: '2026-10-31T00:00:00.000Z' }
  const two = toggleChat('toggle-u3b', '合成乙', false)
  const lateRead = new Promise((resolve) => { setTimeout(() => resolve(false), 400) })
  let releaseSave
  const pendingSave = new Promise((resolve) => { releaseSave = resolve })
  const s = toggleScene([one, two], {
    'db.chats.todoExtractEnabled': (chatId) => (chatId === one.chatId ? lateRead : true),
    'db.chats.setTodoExtractEnabled': (chatId, enabled) => pendingSave.then(() => ({ ok: true, enabled, skippedOlder: 0 }))
  })
  try {
    await openCombinedPane(s)
    await sleep(30)
    assert.ok(!s.todoSwitch(), 'no todo switch while the preference is loading')
    s.click(s.chatButton(two.name))
    await until(() => s.todoSwitch(), { message: 'the second chat shows its switch' })
    await sleep(500)
    assert.equal(reactProps(s.todoSwitch()).checked, true, 'the late reply of the first chat did not overwrite the second chat')
    s.change(s.todoSwitch(), false)
    await until(() => reactProps(s.todoSwitch()).disabled === true && reactProps(s.todoSwitch())['aria-busy'] === true, { message: 'busy while saving' })
    releaseSave()
    await until(() => reactProps(s.todoSwitch()).disabled === false && reactProps(s.todoSwitch()).checked === false, { message: 'idle after saving' })
  } finally { releaseSave(); s.dispose() }
})

test('U4 re-enabling the todo switch shows no explanation text (no 7-day or skipped-count wording)', async () => {
  const chat = toggleChat('toggle-u4', '合成U4', false)
  let skipped = 3
  const s = toggleScene([chat], {
    'db.chats.todoExtractEnabled': () => false,
    'db.chats.setTodoExtractEnabled': (chatId, enabled) => ({ ok: true, enabled, skippedOlder: skipped })
  })
  try {
    await openCombinedPane(s)
    await until(() => s.todoSwitch() && reactProps(s.todoSwitch()).checked === false, { message: 'starts off' })
    s.change(s.todoSwitch(), true)
    await until(() => s.callsTo('db.chats.setTodoExtractEnabled').length === 1 && reactProps(s.todoSwitch()).checked === true, { message: 'turned on' })
    for (const gone of ['最近 7 天', '更早的', '不補', '已啟動', '已關閉']) assert.equal(s.view.container.textContent.includes(gone), false, gone)
    s.change(s.todoSwitch(), false)
    await until(() => s.callsTo('db.chats.setTodoExtractEnabled').length === 2 && reactProps(s.todoSwitch()).checked === false, { message: 'off again' })
    for (const gone of ['最近 7 天', '更早的', '不補', '已啟動', '已關閉']) assert.equal(s.view.container.textContent.includes(gone), false, gone)
  } finally { s.dispose() }
})

test('U5 with the todo switch off the existing todos are still listed', async () => {
  const chat = toggleChat('toggle-u5', '合成U5', true)
  const todo = toggleTodo('u5-todo', chat.chatId, 'U5 保留的待辦')
  const s = toggleScene([chat], { 'db.chats.todoExtractEnabled': () => false, 'db.todos.openByChat': () => [todo] })
  try {
    await openCombinedPane(s)
    await until(() => s.view.container.textContent.includes(todo.title), { message: 'todo still listed' })
    assert.equal(reactProps(s.todoSwitch()).checked, false)
  } finally { s.dispose() }
})

test('U6 the topic switch label says group or chat according to the chat type, under one plain heading', async () => {
  const group = toggleChat('toggle-u6g', '合成群組U6', true)
  const direct = toggleChat('toggle-u6d', '合成單人U6', false)
  const s = toggleScene([group, direct], {})
  try {
    await openCombinedPane(s)
    s.click(s.chatButton(group.name))
    await until(() => s.topicSwitch('此群組的議題開關'), { message: 'group switch label' })
    assert.ok(s.view.container.textContent.includes('討論紀錄'))
    s.click(s.chatButton(direct.name))
    await until(() => s.topicSwitch('此聊天室的議題開關'), { message: 'direct switch label' })
    assert.ok(s.view.container.textContent.includes('討論紀錄'))
    assert.equal(s.topicSwitch('此群組的議題開關'), undefined)
  } finally { s.dispose() }
})

test('U7 the cross-group controls, the 20-per-batch lines and the pending paragraph are gone; the combined pane has exactly two switches', async () => {
  const chat = toggleChat('toggle-u7', '合成U7', true)
  const s = toggleScene([chat], { 'groupTopics.list': () => ({ ok: true, topics: [] }), 'groupTopics.pendingCount': () => 7 })
  try {
    await openCombinedPane(s)
    await until(() => s.topicSwitch('此群組的議題開關') && s.todoSwitch(), { message: 'both switches' })
    const text = s.view.container.textContent
    for (const gone of ['顯示跨群', '跨群候選', '跨群語意候選', '每批最多']) assert.equal(text.includes(gone), false, gone)
    assert.equal(walk(s.view.container).some((element) => hasClassName(element, 'group-topics-pending')), false)
    const pane = byAttr(s.view.container, 'data-testid', 'chat-topics-todos-content')
    assert.ok(pane)
    const switches = walk(pane).filter((element) => element.localName === 'input' && element.getAttribute('role') === 'switch')
    assert.equal(switches.length, 2)
    assert.equal(walk(pane).some((element) => element.localName === 'input' && element.getAttribute('type') === 'checkbox' && element.getAttribute('role') !== 'switch'), false, 'no leftover checkboxes')
  } finally { s.dispose() }
})

test('U8 the stylesheet defines the shared switch wrapper', () => {
  const css = readFileSync(resolve(ROOT, 'src', 'renderer', 'styles', 'index.css'), 'utf8')
  assert.match(css, /\.chat-switch-wrap\s*\{/)
  assert.equal(css.includes('.group-topic-cross-chat'), false)
})

const legacyBlocked = (chat) => ({ ...chat, blocked: true, blockReason: 'manual' })
const paneFor = (s, name) => walk(s.view.container).find((element) => element.localName === 'section' && hasClassName(element, 'chat-pane') && element.getAttribute('aria-label') === name)

test('I3 the chat list has no ignore filter, no 更多操作 button, no open menu and no ignore wording until a menu is opened, even for a chat a legacy backend still marks blocked', async () => {
  const chat = legacyBlocked(toggleChat('ignore-i3', '合成群組I3', true))
  const s = toggleScene([chat])
  try {
    await until(() => s.chatButton(chat.name), { message: 'the chat is listed without any filter' })
    await until(() => paneFor(s, chat.name), { message: 'the chat is selected' })
    const all = walk(s.view.container)
    assert.equal(all.some((element) => element.localName === 'button' && element.hasAttribute('aria-pressed') && /^(已忽略|聊天s*d)/.test(element.textContent.trim())), false, 'no filter buttons')
    assert.equal(all.some((element) => (element.getAttribute('aria-label') ?? '').startsWith('更多操作：')), false, 'no per-chat more button')
    assert.equal(all.some((element) => element.getAttribute('role') === 'menuitem' || element.getAttribute('role') === 'menu'), false, 'no menu until one is opened')
    const text = s.view.container.textContent
    for (const gone of ['已忽略', '忽略對話', '恢復對話']) assert.equal(text.includes(gone), false, gone)
  } finally { s.dispose() }
})

test('I4 both switches stay usable for a chat a legacy backend still marks blocked, and each click calls its own set API once', async () => {
  const chat = legacyBlocked(toggleChat('ignore-i4', '合成群組I4', true))
  const s = toggleScene([chat], {
    'db.chats.setTodoExtractEnabled': (chatId, value) => ({ ok: true, enabled: value, skippedOlder: 0 }),
    'groupTopics.list': () => ({ ok: true, topics: [] }),
    'groupTopics.setEnabled': () => ({ ok: true })
  })
  try {
    await until(() => paneFor(s, chat.name), { message: 'the chat is selected' })
    await openCombinedPane(s)
    await until(() => s.todoSwitch() && s.topicSwitch('此群組的議題開關'), { message: 'both switches render' })
    for (const input of [s.todoSwitch(), s.topicSwitch('此群組的議題開關')]) assert.equal(Boolean(reactProps(input).disabled), false, 'not disabled')
    assert.equal(reactProps(s.todoSwitch()).checked, true)
    s.change(s.todoSwitch(), false)
    await until(() => s.callsTo('db.chats.setTodoExtractEnabled').length === 1 && reactProps(s.todoSwitch()).checked === false, { message: 'todo switched' })
    assert.deepEqual(s.callsTo('db.chats.setTodoExtractEnabled')[0].args, [chat.chatId, false])
    assert.equal(s.callsTo('groupTopics.setEnabled').length, 0)
    s.change(s.topicSwitch('此群組的議題開關'), false)
    await until(() => s.callsTo('groupTopics.setEnabled').length === 1, { message: 'topics switched' })
    assert.equal(s.callsTo('db.chats.setTodoExtractEnabled').length, 1)
  } finally { s.dispose() }
})

// ───────────── overview cleanup: 整理 block in the settings tab ─────────────

const opsButtons = (view) => ['ops-notmine', 'ops-review', 'ops-backfill', 'ops-run'].map((id) => byAttr(view.container, 'data-testid', id))
const memoryStorage = (saved) => ({ getItem: (key) => saved[key] ?? null, setItem: (key, value) => { saved[key] = value }, removeItem: (key) => { delete saved[key] } })
const notMineHandlers = { 'db.todos.listNotMine': () => [], 'db.todos.listNotMineCorrections': () => [], 'tasks.status': () => ({ review: null, mediaBackfill: null }) }

test('overview cleanup: the board settings tab has a 整理 block with the four buttons and no explanatory paragraph; 不是我的回查 opens the panel only when pressed', async () => {
  const saved = { 'lt-ui:app.tab': JSON.stringify({ v: 'settings', at: Date.now() }) }
  const { api } = plugin(settingsHandlers({ ...notMineHandlers, 'db.todos.list': () => [] }))
  dom.document.documentElement.dataset ??= {}
  const view = ui.mount(ui.appSceneWithState(api, memoryStorage(saved)))
  try {
    await until(() => byAttr(view.container, 'data-testid', 'overview-ops') && view.container.textContent.includes('輪詢頻率'), { message: 'the settings tab with the 整理 block' })
    const ops = byAttr(view.container, 'data-testid', 'overview-ops')
    const buttons = opsButtons(view)
    assert.deepEqual(buttons.map((button) => button.textContent.trim()), ['不是我的回查', '🔄 回顧最近 2 天', '🖼️ 補媒體金鑰(近7天)', '立即抓取'])
    assert.equal(ops.textContent, `整理${buttons.map((button) => button.textContent).join('')}`, 'only the title and the buttons: no explanation text, no status line while nothing is wrong')
    assert.equal(walk(ops).filter((element) => element.localName === 'p').length, 0)
    assert.equal(walk(ops).some((element) => hasClassName(element, 'set-msg') || hasClassName(element, 'set-hint')), false)
    assert.equal(byAttr(view.container, 'aria-label', '不是我的待辦回查'), null, 'the recheck panel is closed until the button is pressed')
    reactProps(buttons[0]).onClick()
    await until(() => byAttr(view.container, 'aria-label', '不是我的待辦回查'), { message: 'the 不是我的回查 panel opens inside the block' })
    assert.ok(view.container.textContent.includes('不是我的（0）'), 'the panel lists its (empty) recheck list')
  } finally { view.unmount(); api.dispose() }
})

test('overview cleanup: the overview tab has no toolbar / summary / engine status; the filter row (6 controls) and the four columns stay', async () => {
  const { api } = plugin(settingsHandlers({ 'db.todos.list': () => [] }))
  const view = ui.mount(ui.boardScene(api))
  try {
    await until(() => walk(view.container).some((element) => hasClassName(element, 'kb-board')), { message: 'the board' })
    const filters = walk(view.container).find((element) => hasClassName(element, 'board-filters'))
    assert.ok(filters)
    assert.equal(walk(filters).filter((element) => element.localName === 'select' || element.localName === 'input').length, 6, 'five selects and the grouping checkbox')
    for (const column of ['待辦', '等回覆', '行程', '已完成']) assert.ok(view.container.textContent.includes(column), column)
    assert.equal(walk(view.container).filter((element) => element.localName === 'button').length, 0, 'no button above the columns')
    for (const gone of ['LINE 橋接', '抽取引擎', '上次抓取', '待處理', '今日到期', '已逾期']) assert.equal(view.container.textContent.includes(gone), false, gone)
  } finally { view.unmount(); api.dispose() }
})

test('overview cleanup: the plugin standalone settings view does not mount the 整理 block', async () => {
  const { api } = plugin(settingsHandlers())
  const view = ui.mount(ui.settingsScene(api))
  try {
    await until(() => view.container.textContent.includes('輪詢頻率'), { message: 'settings' })
    assert.equal(byAttr(view.container, 'data-testid', 'overview-ops'), null)
    for (const gone of ['不是我的回查', '回顧最近', '補媒體金鑰', '立即抓取']) assert.equal(view.container.textContent.includes(gone), false, gone)
  } finally { view.unmount(); api.dispose() }
  const source = readFileSync(resolve(ROOT, 'src', 'plugin', 'ui', 'settings.tsx'), 'utf8')
  assert.equal(/operations/.test(source), false, 'src/plugin/ui/settings.tsx does not pass `operations`')
})

test('overview cleanup: a failing 立即抓取 shows one short failure line, re-enables the button and leaves no unhandled rejection', async () => {
  let calls = 0
  const { api } = plugin(settingsHandlers({ ...notMineHandlers, 'pipeline.runOnce': () => { calls += 1; throw Object.assign(new Error('boom'), { code: 'internal' }) } }))
  const unhandled = await collectingUnhandled(async () => {
    const view = ui.mount(ui.opsScene(api))
    try {
      await until(() => byAttr(view.container, 'data-testid', 'ops-run'), { message: 'the run button' })
      reactProps(byAttr(view.container, 'data-testid', 'ops-run')).onClick()
      await until(() => byAttr(view.container, 'data-testid', 'ops-failure'), { message: 'the failure line' })
      assert.match(byAttr(view.container, 'data-testid', 'ops-failure').textContent, /^整理失敗/)
      assert.equal(calls, 1)
      await until(() => reactProps(byAttr(view.container, 'data-testid', 'ops-run')).disabled === false, { message: 'the button usable again' })
    } finally { view.unmount(); api.dispose() }
  })
  assert.deepEqual(unhandled, [])
})

test('overview cleanup: a run that comes back failed or busy shows its note; a clean run shows nothing', async () => {
  for (const [result, expected] of [
    [{ llmStatus: 'error', chatsFailed: 0, note: 'AI 逾時' }, 'AI 逾時'],
    [{ llmStatus: 'partial', chatsFailed: 2, note: null }, '部分聊天整理失敗'],
    [{ llmStatus: 'ok', chatsFailed: 0, note: 'busy: previous run still going' }, '上一輪還沒結束'],
    [{ llmStatus: 'ok', chatsFailed: 0, note: null }, null]
  ]) {
    const { api } = plugin(settingsHandlers({ ...notMineHandlers, 'pipeline.runOnce': () => result }))
    const view = ui.mount(ui.opsScene(api))
    try {
      await until(() => byAttr(view.container, 'data-testid', 'ops-run'), { message: 'the run button' })
      reactProps(byAttr(view.container, 'data-testid', 'ops-run')).onClick()
      if (expected) await until(() => byAttr(view.container, 'data-testid', 'ops-failure')?.textContent === expected, { message: `the line ${expected}` })
      else {
        await until(() => reactProps(byAttr(view.container, 'data-testid', 'ops-run')).disabled === false && !view.container.textContent.includes('抓取中'), { message: 'the run done' })
        await sleep(30)
        assert.equal(byAttr(view.container, 'data-testid', 'ops-failure'), null)
      }
    } finally { view.unmount(); api.dispose() }
  }
})

test('overview cleanup: the engine failure line shows only for llmStatus error / partial (lastError when there is one, a fixed short sentence otherwise)', async () => {
  for (const [llmStatus, lastError, expected] of [
    ['error', 'AI 掛了', 'AI 掛了'], ['error', null, '整理失敗'], ['partial', null, '部分聊天整理失敗'], ['partial', '有一個聊天室逾時', '有一個聊天室逾時'],
    ['ok', 'old', null], ['unknown', null, null], ['disabled', null, null]
  ]) {
    const { api } = plugin(settingsHandlers({ ...notMineHandlers, 'pipeline.status': () => ({ hasApiKey: true, busy: false, running: true, llmStatus, lastError, lineBridge: 'ok' }) }))
    const view = ui.mount(ui.opsScene(api))
    try {
      if (expected) await until(() => byAttr(view.container, 'data-testid', 'ops-failure')?.textContent === expected, { message: `${llmStatus}/${lastError}` })
      else {
        await until(() => byAttr(view.container, 'data-testid', 'ops-run'), { message: 'rendered' })
        await sleep(40)
        assert.equal(byAttr(view.container, 'data-testid', 'ops-failure'), null, `${llmStatus} shows no failure line`)
      }
    } finally { view.unmount(); api.dispose() }
  }
})

test('overview cleanup: reopening the settings tab while a review runs shows it in progress and keeps polling; a stopped review leaves its reason after reopening', async () => {
  let state = { review: { running: true, state: 'running', summary: 'R:running', chatsDone: 1, chatsTotal: 4, resumableMessages: 0 }, mediaBackfill: null }
  const { api } = plugin(settingsHandlers({ 'tasks.status': () => state }))
  const first = ui.mount(ui.opsScene(api, { pollDelayMs: () => 15 }))
  try {
    const review = () => byAttr(first.container, 'data-testid', 'ops-review')
    await until(() => review() && reactProps(review()).disabled === true && review().textContent === 'R:running', { message: 'in progress after (re)opening' })
    state = { review: { running: false, state: 'paused', summary: 'R:paused', chatsDone: 2, chatsTotal: 4, resumableMessages: 3 }, mediaBackfill: null }
    await until(() => reactProps(review()).disabled === false && byAttr(first.container, 'data-testid', 'ops-review-note')?.textContent === 'R:paused', { message: 'polling saw the stop' })
  } finally { first.unmount() }
  const second = ui.mount(ui.opsScene(api, { pollDelayMs: () => 15 }))
  try {
    await until(() => byAttr(second.container, 'data-testid', 'ops-review-note')?.textContent === 'R:paused', { message: 'the reason is shown again after reopening' })
    assert.equal(reactProps(byAttr(second.container, 'data-testid', 'ops-review')).disabled, false)
  } finally { second.unmount(); api.dispose() }
})

// ── column bulk move (right-click / ContextMenu on a column title) ──
const BULK_NOW = '2026-11-08T00:00:00.000Z'
const BULK_CANON = { todo: 'pending', waiting: 'waiting_reply', schedule: 'scheduled' }
function bulkRow(id, chatId, bucket, status, extra = {}) {
  return { id, chatId, bucket, status, title: `標題${id}`, detail: null, priority: 2, dueAt: null, sourceMsgIds: [`${id}-src`], confidence: 0.9, completionEvidence: null, createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z', resolvedAt: status === 'done' ? '2026-11-01T00:00:00.000Z' : null, ...extra }
}
/** a stateful backend whose db.todos.moveColumn mirrors todos.repo moveTodoToColumn (including the no-op guard) */
function bulkScene(rows, { fail = new Set(), nullIds = new Set() } = {}) {
  const state = rows.map((row) => ({ ...row }))
  const calls = []
  const hold = new Map()
  const control = { listFails: false }
  const { api } = plugin(settingsHandlers({
    'db.chats.list': () => [toggleChat('g1', '群組一', true), toggleChat('d1', '私訊一', false)],
    'db.todos.list': (query) => { calls.push({ path: 'list', args: [query] }); if (control.listFails) throw Object.assign(new Error('boom'), { code: 'internal' }); return state.filter((row) => query.statuses.includes(row.status)).map((row) => ({ ...row })) },
    'db.todos.moveColumn': (id, column) => {
      calls.push({ path: 'move', args: [id, column] })
      const apply = () => {
        if (fail.has(id)) throw Object.assign(new Error('boom'), { code: 'internal' })
        const cur = state.find((row) => row.id === id)
        if (!cur || nullIds.has(id)) return null
        if (column === 'done') { const wasDone = cur.status === 'done'; cur.status = 'done'; cur.resolvedAt = wasDone ? cur.resolvedAt : BULK_NOW } else { cur.bucket = column; cur.status = BULK_CANON[column]; cur.resolvedAt = null }
        return { ...cur }
      }
      return hold.has(id) ? hold.get(id).then(apply) : apply()
    }
  }))
  const view = ui.mount(ui.boardScene(api))
  const heads = () => walk(view.container).filter((element) => hasClassName(element, 'kb-col-head'))
  const head = (title) => heads().find((element) => element.textContent.startsWith(title))
  const items = () => walk(view.container).filter((element) => element.getAttribute('role') === 'menuitem')
  const dialog = () => byAttr(view.container, 'data-testid', 'bulk-move-confirm')
  const moves = () => calls.filter((entry) => entry.path === 'move').map((entry) => entry.args)
  const lists = () => calls.filter((entry) => entry.path === 'list').length
  const press = (key, options = {}) => ({ key, shiftKey: false, preventDefault() {}, stopPropagation() {}, ...options })
  const rightClick = (title) => reactProps(head(title)).onContextMenu({ preventDefault() {}, stopPropagation() {} })
  const key = (title, k, options) => reactProps(head(title)).onKeyDown(press(k, options))
  const click = (element) => reactProps(element).onClick({ currentTarget: element, stopPropagation() {} })
  const item = (label) => items().find((element) => element.textContent === label)
  const drop = (column, id) => reactProps(walk(view.container).find((element) => hasClassName(element, `col-${column}`))).onDrop({ preventDefault() {}, dataTransfer: { getData: () => id } })
  const setKind = (value) => reactProps(walk(view.container).find((element) => element.localName === 'select' && element.textContent.includes('只看群組'))).onChange({ target: { value } })
  const note = () => walk(view.container).filter((element) => element.getAttribute('role') === 'alert')
  const active = () => globalThis.document.activeElement
  const confirmOpen = async (title, label) => {
    rightClick(title)
    await until(() => item(label), { message: 'the menu' })
    click(item(label))
    await until(() => dialog(), { message: 'the confirm' })
  }
  const okBtn = () => byAttr(view.container, 'data-testid', 'bulk-move-ok')
  const cancelBtn = () => byAttr(view.container, 'data-testid', 'bulk-move-cancel')
  return { api, view, state, calls, hold, control, active, confirmOpen, okBtn, cancelBtn, heads, head, items, dialog, moves, lists, rightClick, key, click, item, drop, setKind, note, dispose() { view.unmount(); api.dispose() } }
}
const BULK_ROWS = () => [
  bulkRow('t1', 'g1', 'todo', 'pending'), bulkRow('t2', 'd1', 'todo', 'pending'), bulkRow('t3', 'd1', 'todo', 'suggested_done'),
  bulkRow('w1', 'g1', 'waiting', 'waiting_reply'),
  bulkRow('d1', 'd1', 'todo', 'done'), bulkRow('d2', 'g1', 'schedule', 'done')
]

test('column bulk move: right-clicking a column title lists the other three columns, and nothing else', async () => {
  const s = bulkScene(BULK_ROWS())
  try {
    await until(() => s.head('待辦')?.textContent === '待辦3', { message: 'the board' })
    assert.equal(s.items().length, 0, 'no menu before the click')
    s.rightClick('待辦')
    await until(() => s.items().length > 0, { message: 'the menu' })
    assert.deepEqual(s.items().map((element) => element.textContent), ['全部移到等回覆', '全部移到行程', '全部移到已完成'])
    assert.equal(s.items().every((element) => reactProps(element).disabled === false), true)
    s.key('待辦', 'Escape')
    await until(() => s.items().length === 0, { message: 'closed' })
    s.rightClick('已完成')
    await until(() => s.items().some((element) => element.textContent === '全部移到待辦'), { message: 'the menu of another column' })
    assert.deepEqual(s.items().map((element) => element.textContent), ['全部移到待辦', '全部移到等回覆', '全部移到行程'])
    assert.deepEqual(s.moves(), [])
  } finally { s.dispose() }
})

test('column bulk move: the confirm names the real count and 取消 moves nothing', async () => {
  const s = bulkScene(BULK_ROWS())
  try {
    await until(() => s.head('待辦')?.textContent === '待辦3', { message: 'the board' })
    s.rightClick('待辦')
    await until(() => s.item('全部移到已完成'), { message: 'the menu' })
    s.click(s.item('全部移到已完成'))
    await until(() => s.dialog(), { message: 'the confirm' })
    assert.equal(s.items().length, 0, 'the menu closes once an item is chosen')
    assert.match(s.dialog().textContent, /^要把 3 張移到已完成嗎？/)
    assert.deepEqual(walk(s.dialog()).filter((element) => element.localName === 'button').map((element) => element.textContent), ['確定', '取消'])
    assert.deepEqual(s.moves(), [], 'nothing moves before 確定')
    s.click(byAttr(s.view.container, 'data-testid', 'bulk-move-cancel'))
    await until(() => !s.dialog(), { message: 'the confirm closes' })
    await sleep(40)
    assert.deepEqual(s.moves(), [])
    assert.equal(s.head('待辦').textContent, '待辦3')
  } finally { s.dispose() }
})

test('column bulk move: 確定 moves only the cards the filters leave in that column; the same column outside the filter stays put', async () => {
  const s = bulkScene(BULK_ROWS())
  try {
    await until(() => s.head('待辦')?.textContent === '待辦3', { message: 'the board' })
    s.setKind('direct')
    await until(() => s.head('待辦').textContent === '待辦2', { message: 'the direct-only filter' })
    s.rightClick('待辦')
    await until(() => s.item('全部移到已完成'), { message: 'the menu' })
    s.click(s.item('全部移到已完成'))
    await until(() => s.dialog(), { message: 'the confirm' })
    assert.match(s.dialog().textContent, /^要把 2 張移到已完成嗎？/, 'the count is the filtered column, not the whole column')
    const listsBefore = s.lists()
    s.click(byAttr(s.view.container, 'data-testid', 'bulk-move-ok'))
    await until(() => !s.dialog() && s.lists() > listsBefore, { message: 'moved and re-read' })
    assert.deepEqual(s.moves(), [['t2', 'done'], ['t3', 'done']])
    assert.equal(s.state.find((row) => row.id === 't1').status, 'pending', 'the group card filtered out is untouched')
    assert.equal(s.lists(), listsBefore + 1, 'one re-read after the whole batch')
    assert.equal(s.note().length, 0)
  } finally { s.dispose() }
})

for (const [from, to, label] of [['todo', 'done', '待辦'], ['done', 'waiting', '已完成'], ['waiting', 'schedule', '等回覆'], ['todo', 'waiting', '待辦']]) {
  test(`column bulk move: ${label} → ${to} leaves every card exactly as dragging it alone would`, async () => {
    const toTitle = { todo: '待辦', waiting: '等回覆', schedule: '行程', done: '已完成' }[to]
    const bulk = bulkScene(BULK_ROWS())
    const dragged = bulkScene(BULK_ROWS())
    try {
      await until(() => bulk.head(label)?.textContent.length > label.length && dragged.head(label)?.textContent.length > label.length, { message: 'both boards' })
      const ids = bulk.state.filter((row) => (from === 'done' ? row.status === 'done' : row.status !== 'done' && row.bucket === from)).map((row) => row.id)
      assert.ok(ids.length > 0)
      for (const id of ids) {
        const before = dragged.lists()
        // the drop handler can still be the one from before the first load commit; drop again until the backend has seen this card
        for (let attempt = 0; attempt < 50 && !dragged.moves().some(([moved]) => moved === id); attempt += 1) {
          dragged.drop(to, id)
          await sleep(100)
        }
        await until(() => dragged.lists() > before, { message: `drag ${id}` })
      }
      bulk.rightClick(label)
      await until(() => bulk.item(`全部移到${toTitle}`), { message: 'the menu' })
      bulk.click(bulk.item(`全部移到${toTitle}`))
      await until(() => bulk.dialog(), { message: 'the confirm' })
      const before = bulk.lists()
      bulk.click(byAttr(bulk.view.container, 'data-testid', 'bulk-move-ok'))
      await until(() => !bulk.dialog() && bulk.lists() > before, { message: 'the batch' })
      assert.deepEqual(bulk.moves(), dragged.moves(), 'the same moveColumn calls as the drag path')
      assert.deepEqual(bulk.state, dragged.state, 'the same resulting rows')
    } finally { bulk.dispose(); dragged.dispose() }
  })
}

test('column bulk move: a partial failure keeps the rest and shows one short line after re-reading', async () => {
  const s = bulkScene(BULK_ROWS(), { fail: new Set(['t2']) })
  const unhandled = await collectingUnhandled(async () => {
    try {
      await until(() => s.head('待辦')?.textContent === '待辦3', { message: 'the board' })
      s.rightClick('待辦')
      await until(() => s.item('全部移到已完成'), { message: 'the menu' })
      s.click(s.item('全部移到已完成'))
      await until(() => s.dialog(), { message: 'the confirm' })
      const before = s.lists()
      s.click(byAttr(s.view.container, 'data-testid', 'bulk-move-ok'))
      await until(() => !s.dialog() && s.lists() > before, { message: 'the batch' })
      assert.deepEqual(s.moves(), [['t1', 'done'], ['t2', 'done'], ['t3', 'done']], 'a failure does not stop the later cards')
      assert.equal(s.lists(), before + 1)
      await until(() => s.note().length === 1, { message: 'the failure line' })
      assert.equal(s.note()[0].textContent, '1 張沒移成功')
      assert.equal(s.head('待辦').textContent, '待辦1', 'the card that failed stays where it was; the others moved')
      assert.equal(s.head('已完成').textContent, '已完成4')
    } finally { s.dispose() }
  })
  assert.deepEqual(unhandled, [])
})

test('column bulk move: an empty column opens a menu whose items are disabled and open no confirm', async () => {
  const s = bulkScene(BULK_ROWS())
  try {
    await until(() => s.head('待辦')?.textContent === '待辦3', { message: 'the board' })
    assert.equal(s.head('行程').textContent, '行程0')
    s.rightClick('行程')
    await until(() => s.items().length === 3, { message: 'the menu' })
    assert.equal(s.items().every((element) => reactProps(element).disabled === true), true)
    s.click(s.items()[0])
    await sleep(40)
    assert.equal(s.dialog(), null)
    assert.deepEqual(s.moves(), [])
  } finally { s.dispose() }
})

test('column bulk move: a column title takes focus and opens the menu from the ContextMenu key or Shift+F10; Esc closes it', async () => {
  const s = bulkScene(BULK_ROWS())
  try {
    await until(() => s.head('待辦')?.textContent === '待辦3', { message: 'the board' })
    for (const title of ['待辦', '等回覆', '行程', '已完成']) assert.equal(s.head(title).getAttribute('tabindex'), '0', `${title} title can take focus`)
    s.key('等回覆', 'ContextMenu')
    await until(() => s.items().length === 3, { message: 'the ContextMenu key opens it' })
    s.key('等回覆', 'Escape')
    await until(() => s.items().length === 0, { message: 'Esc closes it' })
    s.key('等回覆', 'F10')
    await sleep(40)
    assert.equal(s.items().length, 0, 'F10 alone does nothing')
    s.key('等回覆', 'F10', { shiftKey: true })
    await until(() => s.items().length === 3, { message: 'Shift+F10 opens it' })
    s.key('等回覆', 'Escape')
    await until(() => s.items().length === 0, { message: 'Esc closes it again' })
    s.rightClick('待辦')
    await until(() => s.item('全部移到已完成'), { message: 'the menu' })
    s.click(s.item('全部移到已完成'))
    await until(() => s.dialog(), { message: 'the confirm' })
    reactProps(s.dialog()).onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} })
    await until(() => !s.dialog(), { message: 'Esc closes the confirm' })
    assert.deepEqual(s.moves(), [])
  } finally { s.dispose() }
})

test('column bulk move: data that changes while the confirm is open never moves a card that left the column; the confirm is asked again with the new count', async () => {
  const s = bulkScene(BULK_ROWS())
  try {
    await until(() => s.head('待辦')?.textContent === '待辦3', { message: 'the board' })
    await s.confirmOpen('待辦', '全部移到等回覆')
    assert.match(s.dialog().textContent, /^要把 3 張移到等回覆嗎？/)
    s.state.find((row) => row.id === 't1').status = 'done'
    s.state.find((row) => row.id === 't1').resolvedAt = BULK_NOW
    s.state.splice(s.state.findIndex((row) => row.id === 't2'), 1)
    const before = s.lists()
    for (let attempt = 0; attempt < 50 && s.lists() === before; attempt += 1) { s.drop('schedule', 'w1'); await sleep(100) }
    await until(() => s.head('待辦').textContent === '待辦1', { message: 'the board re-read behind the open confirm' })
    const movesBefore = s.moves().length
    s.click(s.okBtn())
    await until(() => /^要把 1 張移到等回覆嗎？/.test(s.dialog()?.textContent ?? ''), { message: 'asked again with the new count' })
    assert.equal(s.moves().length, movesBefore, 'nothing moved on the mismatched confirm')
    assert.equal(s.state.find((row) => row.id === 't1').status, 'done', 'the finished card is not reopened')
    s.click(s.okBtn())
    await until(() => !s.dialog(), { message: 'the second confirm runs' })
    assert.deepEqual(s.moves().slice(movesBefore), [['t3', 'waiting']])
  } finally { s.dispose() }
})

test('column bulk move: when every card has left the column the confirm closes with one short line and moves nothing', async () => {
  const s = bulkScene(BULK_ROWS())
  try {
    await until(() => s.head('待辦')?.textContent === '待辦3', { message: 'the board' })
    await s.confirmOpen('待辦', '全部移到等回覆')
    s.state.splice(0, 3)
    const before = s.lists()
    for (let attempt = 0; attempt < 50 && s.lists() === before; attempt += 1) { s.drop('schedule', 'w1'); await sleep(100) }
    await until(() => s.head('待辦').textContent === '待辦0', { message: 'the board re-read' })
    const movesBefore = s.moves().length
    s.click(s.okBtn())
    await until(() => !s.dialog(), { message: 'the confirm closes' })
    assert.equal(s.moves().length, movesBefore)
    assert.deepEqual(s.note().map((element) => element.textContent), ['沒有可移的卡片'])
  } finally { s.dispose() }
})

test('column bulk move: a moveColumn that answers null counts as not moved', async () => {
  const s = bulkScene(BULK_ROWS(), { nullIds: new Set(['t3']) })
  try {
    await until(() => s.head('待辦')?.textContent === '待辦3', { message: 'the board' })
    await s.confirmOpen('待辦', '全部移到已完成')
    s.click(s.okBtn())
    await until(() => !s.dialog(), { message: 'the batch' })
    await until(() => s.note().length === 1, { message: 'the line' })
    assert.equal(s.note()[0].textContent, '1 張沒移成功')
    assert.equal(s.head('待辦').textContent, '待辦1')
  } finally { s.dispose() }
})

test('column bulk move: when the re-read after the batch fails, one short line says it was written but the board did not update', async () => {
  const s = bulkScene(BULK_ROWS())
  try {
    await until(() => s.head('待辦')?.textContent === '待辦3', { message: 'the board' })
    await s.confirmOpen('待辦', '全部移到已完成')
    s.control.listFails = true
    s.click(s.okBtn())
    await until(() => !s.dialog(), { message: 'the batch' })
    assert.equal(s.moves().length, 3)
    await until(() => s.note().some((element) => element.textContent === '已寫入，但看板更新失敗'), { message: 'the written-but-not-updated line' })
  } finally { s.dispose() }
})

test('column bulk move: clicking the backdrop or blurring the title closes the menu without moving anything', async () => {
  const s = bulkScene(BULK_ROWS())
  try {
    await until(() => s.head('待辦')?.textContent === '待辦3', { message: 'the board' })
    s.rightClick('待辦')
    await until(() => s.items().length === 3, { message: 'the menu' })
    const backdrop = walk(s.view.container).find((element) => hasClassName(element, 'menu-backdrop'))
    reactProps(backdrop).onMouseDown({})
    await until(() => s.items().length === 0, { message: 'the backdrop closes it' })
    s.rightClick('待辦')
    await until(() => s.items().length === 3, { message: 'the menu again' })
    reactProps(s.head('待辦')).onBlur({ currentTarget: s.head('待辦'), relatedTarget: null })
    await until(() => s.items().length === 0, { message: 'losing focus closes it' })
    assert.deepEqual(s.moves(), [])
  } finally { s.dispose() }
})

test('column bulk move: the title is a button that reports whether its menu is expanded', async () => {
  const s = bulkScene(BULK_ROWS())
  try {
    await until(() => s.head('待辦')?.textContent === '待辦3', { message: 'the board' })
    assert.equal(s.head('待辦').getAttribute('role'), 'button')
    assert.equal(s.head('待辦').getAttribute('aria-haspopup'), 'menu')
    assert.equal(s.head('待辦').getAttribute('aria-expanded'), 'false')
    s.rightClick('待辦')
    await until(() => s.head('待辦').getAttribute('aria-expanded') === 'true', { message: 'expanded' })
    s.key('待辦', 'Escape')
    await until(() => s.head('待辦').getAttribute('aria-expanded') === 'false', { message: 'collapsed' })
  } finally { s.dispose() }
})

test('column bulk move: Tab stays inside the confirm, and focus goes back to the column title once it closes', async () => {
  const s = bulkScene(BULK_ROWS())
  try {
    await until(() => s.head('待辦')?.textContent === '待辦3', { message: 'the board' })
    await s.confirmOpen('待辦', '全部移到已完成')
    assert.equal(s.active(), s.cancelBtn(), '取消 has the focus')
    const tab = (shiftKey) => { let prevented = false; reactProps(s.dialog()).onKeyDown({ key: 'Tab', shiftKey, preventDefault() { prevented = true }, stopPropagation() {} }); return prevented }
    assert.equal(tab(false), true, 'Tab on the last button does not leave the dialog')
    assert.equal(s.active(), s.okBtn(), 'it wraps to 確定')
    assert.equal(tab(true), true, 'Shift+Tab on the first button does not leave the dialog')
    assert.equal(s.active(), s.cancelBtn(), 'it wraps back to 取消')
    s.click(s.cancelBtn())
    await until(() => !s.dialog(), { message: 'closed' })
    await until(() => s.active() === s.head('待辦'), { message: 'the focus is back on the column title' })
    await s.confirmOpen('待辦', '全部移到等回覆')
    s.click(s.okBtn())
    await until(() => !s.dialog(), { message: 'the batch' })
    await until(() => s.active() === s.head('待辦'), { message: 'the focus is back on the column title after a move too' })
  } finally { s.dispose() }
})

test('column bulk move: the confirm shows 移動中 done/total while the batch runs, and Tab cannot leave it then', async () => {
  const s = bulkScene(BULK_ROWS())
  try {
    await until(() => s.head('待辦')?.textContent === '待辦3', { message: 'the board' })
    let release
    s.hold.set('t2', new Promise((resolve) => { release = resolve }))
    await s.confirmOpen('待辦', '全部移到已完成')
    s.click(s.okBtn())
    await until(() => s.dialog()?.textContent.startsWith('移動中 1/3'), { message: 'one card done, two to go' })
    assert.equal(reactProps(s.okBtn()).disabled, true)
    assert.equal(reactProps(s.cancelBtn()).disabled, true)
    let prevented = false
    reactProps(s.dialog()).onKeyDown({ key: 'Tab', shiftKey: false, preventDefault() { prevented = true }, stopPropagation() {} })
    assert.equal(prevented, true)
    release()
    await until(() => !s.dialog(), { message: 'the batch ends' })
    assert.deepEqual(s.moves(), [['t1', 'done'], ['t2', 'done'], ['t3', 'done']])
  } finally { s.dispose() }
})

// ───────────── 聊天室列表右鍵選單（M1–M10）與標題列狀態列（H1–H7） ─────────────

dom.window.innerWidth = 1280
dom.window.innerHeight = 800

const PREFS = (over = {}) => ({ prefsReady: true, topicsAvailable: true, pinned: [], hidden: [], todoOff: [], topicsOn: [], ...over })
const noop = () => undefined
const fakeEvent = (over = {}) => ({ preventDefault: noop, stopPropagation: noop, ...over })

function listScene(chats, { prefs = PREFS(), handlers = {} } = {}) {
  const s = toggleScene(chats, { 'db.chats.listPrefs': () => prefs, ...handlers })
  const rowEls = () => walk(s.view.container).filter((element) => hasClassName(element, 'chat-list-row'))
  const rowNames = () => rowEls().map((row) => walk(row).find((element) => hasClassName(element, 'chat-list-name'))?.textContent ?? '')
  const rowOf = (name) => rowEls().find((row) => walk(row).some((element) => hasClassName(element, 'chat-list-name') && element.textContent === name))
  const menu = () => walk(s.view.container).find((element) => element.getAttribute('role') === 'menu')
  const menuLabels = () => (menu() ? walk(menu()).filter((element) => element.getAttribute('role') === 'menuitem').map((element) => element.textContent.trim()) : null)
  const openMenu = (name, point = { clientX: 60, clientY: 120 }) => reactProps(rowOf(name)).onContextMenu(fakeEvent(point))
  const pick = (label) => reactProps(walk(menu()).find((element) => element.getAttribute('role') === 'menuitem' && element.textContent.trim() === label)).onClick({})
  const rowButton = (name) => walk(rowOf(name)).find((element) => hasClassName(element, 'chat-list-item'))
  const searchInput = () => walk(s.view.container).find((element) => element.localName === 'input' && element.getAttribute('type') === 'search')
  const type = (text) => reactProps(searchInput()).onChange({ target: { value: text } })
  const alertText = () => walk(s.view.container).filter((element) => element.getAttribute('role') === 'alert' && hasClassName(element, 'chat-action-error')).map((element) => element.textContent)
  return { ...s, rowEls, rowNames, rowOf, menu, menuLabels, openMenu, pick, rowButton, searchInput, type, alertText }
}

const three = () => [toggleChat('m-a', '聊天甲', false), toggleChat('m-b', '聊天乙', true), toggleChat('m-c', '聊天丙', false)]

test('M1 right-clicking a chat row opens a menu: 置頂／忽略／隱藏, or 取消置頂／恢復／隱藏 for a pinned, ignored chat; nothing is open before', async () => {
  const s = listScene(three(), { prefs: PREFS({ pinned: ['m-b'], todoOff: ['m-b'] }) })
  try {
    await until(() => s.rowNames().length === 3, { message: 'three rows' })
    assert.equal(s.menu(), undefined, 'no menu until one is opened')
    s.openMenu('聊天甲')
    await until(() => s.menu(), { message: 'menu opens' })
    assert.deepEqual(s.menuLabels(), ['置頂', '忽略', '隱藏'])
    assert.equal(walk(s.view.container).filter((element) => element.getAttribute('role') === 'menu').length, 1)
    s.openMenu('聊天乙')
    await until(() => s.menuLabels()?.[0] === '取消置頂', { message: 'menu for the pinned, ignored chat' })
    assert.deepEqual(s.menuLabels(), ['取消置頂', '恢復', '隱藏'])
    assert.equal(walk(s.view.container).filter((element) => element.getAttribute('role') === 'menu').length, 1, 'a single menu state')
    const style = reactProps(s.menu()).style
    assert.ok(Number.isFinite(style.left) && (Number.isFinite(style.top) || Number.isFinite(style.bottom)), 'placed by placeFixedMenu with finite numbers')
  } finally { s.dispose() }
})

test('M1b todo off but topics on is not "ignored": the menu offers 忽略 and the row is not faded; todo off alone is ignored (menu offers 恢復)', async () => {
  const s = listScene(three(), { prefs: PREFS({ todoOff: ['m-a', 'm-b'], topicsOn: ['m-a'] }) })
  try {
    await until(() => s.rowNames().length === 3, { message: 'three rows' })
    assert.equal(hasClassName(s.rowOf('聊天甲'), 'ignored'), false, 'topics still on: not faded')
    assert.equal(s.rowOf('聊天甲').textContent.includes('已忽略'), false)
    assert.equal(hasClassName(s.rowOf('聊天乙'), 'ignored'), true, 'todo off and topics off: faded')
    s.openMenu('聊天甲')
    await until(() => s.menu(), { message: 'menu on the todo-off, topics-on chat' })
    assert.deepEqual(s.menuLabels(), ['置頂', '忽略', '隱藏'])
    s.openMenu('聊天乙')
    await until(() => s.menuLabels()?.[1] === '恢復', { message: 'menu on the fully ignored chat' })
    assert.deepEqual(s.menuLabels(), ['置頂', '恢復', '隱藏'])
  } finally { s.dispose() }
})

test('M2 each menu item calls exactly one set API with its arguments (never the two old switches), then the row shows the result', async () => {
  const s = listScene(three(), {
    handlers: {
      'db.chats.setPinned': (chatId, pinned) => ({ ok: true, pinned }),
      'db.chats.setIgnored': (chatId, ignored) => ({ ok: true, ignored, skippedOlder: 0 }),
      'db.chats.setHidden': (chatId, hidden) => ({ ok: true, hidden }),
      'db.chats.setTodoExtractEnabled': () => ({ ok: true, enabled: true, skippedOlder: 0 }),
      'groupTopics.setEnabled': () => ({ ok: true })
    }
  })
  try {
    await until(() => s.rowNames().length === 3, { message: 'rows' })
    s.openMenu('聊天乙')
    await until(() => s.menu(), { message: 'menu' })
    s.pick('置頂')
    await until(() => s.callsTo('db.chats.setPinned').length === 1, { message: 'pin call' })
    assert.deepEqual(s.callsTo('db.chats.setPinned')[0].args, ['m-b', true])
    await until(() => s.rowNames()[0] === '聊天乙', { message: 'pinned row first' })
    assert.equal(s.menu(), undefined, 'the menu closed')
    assert.ok(s.rowOf('聊天乙').textContent.includes('已置頂'), 'sr-only pin text')

    s.openMenu('聊天丙')
    await until(() => s.menu(), { message: 'menu 2' })
    s.pick('忽略')
    await until(() => s.callsTo('db.chats.setIgnored').length === 1, { message: 'ignore call' })
    assert.deepEqual(s.callsTo('db.chats.setIgnored')[0].args, ['m-c', true])
    await until(() => hasClassName(s.rowOf('聊天丙'), 'ignored'), { message: 'ignored row faded' })
    assert.ok(s.rowOf('聊天丙').textContent.includes('已忽略'))
    assert.equal(s.rowOf('聊天丙').textContent.includes('已隱藏'), false)
    s.openMenu('聊天丙')
    await until(() => s.menuLabels()?.[1] === '恢復', { message: 'now offers 恢復' })
    s.pick('恢復')
    await until(() => s.callsTo('db.chats.setIgnored').length === 2, { message: 'restore call' })
    assert.deepEqual(s.callsTo('db.chats.setIgnored')[1].args, ['m-c', false])
    await until(() => !hasClassName(s.rowOf('聊天丙'), 'ignored'), { message: 'row back to normal' })

    s.openMenu('聊天甲')
    await until(() => s.menu(), { message: 'menu 3' })
    s.pick('隱藏')
    await until(() => s.callsTo('db.chats.setHidden').length === 1, { message: 'hide call' })
    assert.deepEqual(s.callsTo('db.chats.setHidden')[0].args, ['m-a', true])
    await until(() => s.rowOf('聊天甲') === undefined, { message: 'hidden row leaves the list' })
    assert.equal(s.callsTo('db.chats.setTodoExtractEnabled').length, 0)
    assert.equal(s.callsTo('groupTopics.setEnabled').length, 0)
  } finally { s.dispose() }
})

test('M3 hidden chats are not listed; searching lists them with 已隱藏 and a menu that only offers 取消隱藏; unhiding keeps them listed', async () => {
  const s = listScene(three(), {
    prefs: PREFS({ hidden: ['m-b'], todoOff: ['m-b'] }),
    handlers: { 'db.chats.setHidden': (chatId, hidden) => ({ ok: true, hidden }) }
  })
  try {
    await until(() => s.rowNames().length === 2, { message: 'two visible rows' })
    assert.equal(s.rowOf('聊天乙'), undefined)
    s.type('聊天')
    await until(() => s.rowNames().length === 3, { message: 'search lists the hidden chat too' })
    assert.ok(s.rowOf('聊天乙').textContent.includes('已隱藏'))
    assert.equal(s.rowOf('聊天甲').textContent.includes('已隱藏'), false)
    s.openMenu('聊天乙')
    await until(() => s.menu(), { message: 'menu on the hidden row' })
    assert.deepEqual(s.menuLabels(), ['取消隱藏'])
    s.pick('取消隱藏')
    await until(() => s.callsTo('db.chats.setHidden').length === 1, { message: 'unhide call' })
    assert.deepEqual(s.callsTo('db.chats.setHidden')[0].args, ['m-b', false])
    await until(() => !s.rowOf('聊天乙').textContent.includes('已隱藏'), { message: 'flag gone' })
    s.type('')
    await until(() => s.rowNames().length === 3, { message: 'unhidden chat stays in the normal list' })
    assert.ok(hasClassName(s.rowOf('聊天乙'), 'ignored'), 'still ignored: unhide does not restore')
  } finally { s.dispose() }
})

test('M4 pinned chats come first (in the original order among themselves) and fall back when unpinned', async () => {
  const s = listScene(three(), {
    prefs: PREFS({ pinned: ['m-c'] }),
    handlers: { 'db.chats.setPinned': (chatId, pinned) => ({ ok: true, pinned }) }
  })
  try {
    await until(() => s.rowNames().length === 3, { message: 'rows' })
    const original = ['聊天甲', '聊天乙', '聊天丙']
    assert.equal(s.rowNames()[0], '聊天丙')
    assert.deepEqual(s.rowNames().slice(1), original.filter((name) => name !== '聊天丙').sort((a, b) => s.rowNames().indexOf(a) - s.rowNames().indexOf(b)))
    s.openMenu('聊天丙')
    await until(() => s.menu(), { message: 'menu' })
    s.pick('取消置頂')
    await until(() => s.callsTo('db.chats.setPinned').length === 1 && s.rowNames()[0] !== '聊天丙', { message: 'unpinned row goes back' })
    assert.deepEqual(s.callsTo('db.chats.setPinned')[0].args, ['m-c', false])
  } finally { s.dispose() }
})

test('M5 keyboard: the ContextMenu key and Shift+F10 on a row open the menu, Escape closes it and the focus is back on that row; the backdrop closes it without a call', async () => {
  const s = listScene(three())
  try {
    await until(() => s.rowNames().length === 3, { message: 'rows' })
    const button = s.rowButton('聊天乙')
    const hook = () => reactProps(button).onKeyDown
    hook()(fakeEvent({ key: 'ContextMenu', currentTarget: button }))
    await until(() => s.menu(), { message: 'ContextMenu key opens' })
    assert.deepEqual(s.menuLabels(), ['置頂', '忽略', '隱藏'])
    const items = walk(s.menu()).filter((element) => element.getAttribute('role') === 'menuitem')
    s.menu().querySelectorAll = () => items
    dom.document.activeElement = items[0]
    reactProps(s.menu()).onKeyDown(fakeEvent({ key: 'ArrowDown' }))
    assert.equal(dom.document.activeElement, items[1], 'ArrowDown moves to the next item')
    reactProps(s.menu()).onKeyDown(fakeEvent({ key: 'ArrowUp' }))
    reactProps(s.menu()).onKeyDown(fakeEvent({ key: 'ArrowUp' }))
    assert.equal(dom.document.activeElement, items[2], 'ArrowUp wraps around')
    reactProps(s.menu()).onKeyDown(fakeEvent({ key: 'Escape' }))
    await until(() => s.menu() === undefined, { message: 'Escape closes' })
    await until(() => dom.document.activeElement === button, { message: 'focus returns to the row' })

    hook()(fakeEvent({ key: 'F10', shiftKey: true, currentTarget: button }))
    await until(() => s.menu(), { message: 'Shift+F10 opens' })
    const backdrop = walk(s.view.container).find((element) => hasClassName(element, 'menu-backdrop'))
    reactProps(backdrop).onMouseDown({})
    await until(() => s.menu() === undefined, { message: 'backdrop closes' })
    for (const path of ['db.chats.setPinned', 'db.chats.setIgnored', 'db.chats.setHidden']) assert.equal(s.callsTo(path).length, 0, path)
  } finally { s.dispose() }
})

test('M6 hiding the selected chat selects the next visible chat; the default selection skips hidden chats from the start', async () => {
  const s = listScene(three(), {
    prefs: PREFS({ hidden: ['m-a'] }),
    handlers: { 'db.chats.setHidden': (chatId, hidden) => ({ ok: true, hidden }) }
  })
  try {
    await until(() => s.rowNames().length === 2, { message: 'rows' })
    const first = s.rowNames()[0]
    await until(() => paneFor(s, first), { message: 'the first visible chat is selected, not the hidden one' })
    assert.equal(paneFor(s, '聊天甲'), undefined)
    s.openMenu(first)
    await until(() => s.menu(), { message: 'menu' })
    s.pick('隱藏')
    const second = s.rowNames().find((name) => name !== first)
    await until(() => paneFor(s, second), { message: 'the next visible chat is selected' })
    assert.equal(s.rowOf(first), undefined)
  } finally { s.dispose() }
})

test('M7 if db.chats.listPrefs fails the list still renders normally, shows no error, and the menu still opens', async () => {
  const s = listScene(three(), { handlers: { 'db.chats.listPrefs': () => { throw Object.assign(new Error('boom'), { code: 'internal' }) } } })
  try {
    await until(() => s.rowNames().length === 3, { message: 'rows without prefs' })
    assert.deepEqual(s.alertText(), [])
    assert.equal(s.view.container.textContent.includes('boom'), false)
    s.openMenu('聊天甲')
    await until(() => s.menu(), { message: 'menu' })
    assert.deepEqual(s.menuLabels(), ['置頂', '忽略', '隱藏'])
  } finally { s.dispose() }
})

test('M8 a failing set call (rejection or ok:false) shows one error line, changes nothing on screen, and a later success clears it', async () => {
  let mode = 'throw'
  const s = listScene(three(), {
    handlers: {
      'db.chats.setPinned': (chatId, pinned) => {
        if (mode === 'throw') throw Object.assign(new Error('寫入失敗'), { code: 'internal' })
        if (mode === 'refuse') return { ok: false, pinned: false }
        return { ok: true, pinned }
      }
    }
  })
  try {
    await until(() => s.rowNames().length === 3, { message: 'rows' })
    const before = s.rowNames()
    s.openMenu('聊天乙'); await until(() => s.menu(), { message: 'menu' }); s.pick('置頂')
    await until(() => s.alertText().length === 1, { message: 'one error line' })
    assert.deepEqual(s.rowNames(), before, 'the order did not change')
    assert.equal(s.rowOf('聊天乙').textContent.includes('已置頂'), false)
    mode = 'refuse'
    s.openMenu('聊天乙'); await until(() => s.menu(), { message: 'menu again' })
    assert.equal(s.alertText().length, 0, 'opening a menu clears the old line')
    s.pick('置頂')
    await until(() => s.alertText().length === 1, { message: 'error line for ok:false' })
    mode = 'ok'
    s.openMenu('聊天乙'); await until(() => s.menu(), { message: 'menu third time' }); s.pick('置頂')
    await until(() => s.rowNames()[0] === '聊天乙' && s.alertText().length === 0, { message: 'success clears the line' })
  } finally { s.dispose() }
})

test('M8b restoring an ignored chat: db.chats.setIgnored answering ok:false (or rejecting) shows the one error line and the row stays ignored; a later success restores it and clears the line', async () => {
  let mode = 'refuse'
  const s = listScene(three(), {
    prefs: PREFS({ todoOff: ['m-b'] }),
    handlers: {
      'db.chats.setIgnored': (chatId, ignored) => {
        if (mode === 'throw') throw Object.assign(new Error('寫入失敗'), { code: 'internal' })
        if (mode === 'refuse') return { ok: false, ignored: true, skippedOlder: 0 }
        return { ok: true, ignored, skippedOlder: 0 }
      }
    }
  })
  try {
    await until(() => s.rowNames().length === 3 && hasClassName(s.rowOf('聊天乙'), 'ignored'), { message: 'rows, the middle one ignored' })
    s.openMenu('聊天乙'); await until(() => s.menuLabels()?.[1] === '恢復', { message: 'menu with 恢復' }); s.pick('恢復')
    await until(() => s.alertText().length === 1, { message: 'one error line for ok:false' })
    assert.equal(s.alertText()[0], '操作失敗，請再試一次')
    assert.deepEqual(s.callsTo('db.chats.setIgnored').map((call) => call.args), [['m-b', false]])
    assert.equal(hasClassName(s.rowOf('聊天乙'), 'ignored'), true, 'the row did not change to "restored"')
    mode = 'throw'
    s.openMenu('聊天乙'); await until(() => s.menuLabels()?.[1] === '恢復', { message: 'menu again' })
    assert.equal(s.alertText().length, 0, 'opening a menu clears the old line')
    s.pick('恢復')
    await until(() => s.alertText().length === 1, { message: 'error line for a rejection' })
    assert.equal(hasClassName(s.rowOf('聊天乙'), 'ignored'), true)
    mode = 'ok'
    s.openMenu('聊天乙'); await until(() => s.menuLabels()?.[1] === '恢復', { message: 'menu third time' }); s.pick('恢復')
    await until(() => !hasClassName(s.rowOf('聊天乙'), 'ignored') && s.alertText().length === 0, { message: 'success restores the row and clears the line' })
  } finally { s.dispose() }
})

test('M9 returning from the 議題與待辦 view re-reads the list state (the switches there can ignore a chat too)', async () => {
  let prefs = PREFS()
  const s = listScene(three(), { handlers: { 'db.chats.listPrefs': () => prefs } })
  try {
    await until(() => s.rowNames().length === 3, { message: 'rows' })
    await until(() => paneFor(s, s.rowNames()[0]), { message: 'a chat is selected' })
    s.click(s.paneButton('議題與待辦'))
    await until(() => byAttr(s.view.container, 'data-testid', 'chat-topics-todos-content'), { message: 'the combined view is showing' })
    await until(() => s.callsTo('db.chats.listPrefs').length >= 1, { message: 'initial read counted' })
    const reads = s.callsTo('db.chats.listPrefs').length
    prefs = PREFS({ todoOff: ['m-a', 'm-b', 'm-c'] })
    s.click(s.paneButton('訊息'))
    await until(() => s.callsTo('db.chats.listPrefs').length === reads + 1, { message: 'one more read' })
    await until(() => s.rowEls().every((row) => hasClassName(row, 'ignored')), { message: 'rows show the new state' })
  } finally { s.dispose() }
})

test('M10 the menu uses the shared ContextMenu and the board column header still uses it too (same markup: backdrop + menu-pop role=menu)', () => {
  const read = (...parts) => readFileSync(resolve(ROOT, 'src', 'renderer', ...parts), 'utf8')
  assert.match(read('components', 'MessageStream.tsx'), /<ContextMenu\b/)
  assert.match(read('components', 'Board', 'Column.tsx'), /<ContextMenu\b/)
  assert.match(read('components', 'Board', 'Column.tsx'), /useContextMenuKeys/)
  const shell = read('components', 'ContextMenu.tsx')
  assert.ok(shell.includes('menu-backdrop') && shell.includes('menu-pop') && shell.includes('role="menu"'))
  assert.equal(/menu-backdrop/.test(read('components', 'Board', 'Column.tsx')), false, 'the backdrop markup lives only in the shared component')
})

const STREAM_TAB = () => ({ 'lt-ui:app.tab': JSON.stringify({ v: 'stream', at: Date.now() }) })
const ancestors = (element) => { const out = []; for (let n = element.parentNode; n; n = n.parentNode) out.push(n); return out }
const inHeader = (element) => ancestors(element).some((node) => node.nodeType === 1 && hasClassName(node, 'app-header'))
const headerOf = (view) => walk(view.container).find((element) => element.localName === 'header' && hasClassName(element, 'app-header'))
const appStreamScene = (handlers, apiOptions, tab = STREAM_TAB()) => {
  const { api } = plugin({
    'db.chats.list': () => [], 'db.messages.list': () => [], 'db.messages.recentByChat': () => [], 'messages.recent': () => [],
    'db.chats.listPrefs': () => PREFS(), 'settings.chatPrompt.list': () => ({ items: [] }),
    'line.status': () => ({ state: 'running', lastMessageAt: null, messageCount: 2, lastError: null, restarts: 0 }),
    ...handlers
  }, apiOptions)
  const view = ui.mount(ui.appSceneWithState(api, memoryStorage(tab)))
  return { api, view, dispose() { view.unmount(); api.dispose() } }
}

test('H1 on the chat tab the 「LINE 橋接」 status bar is inside the top header, not in the page body', async () => {
  const s = appStreamScene({})
  try {
    await until(() => walk(s.view.container).some((element) => hasClassName(element, 'stream-status') && element.textContent.includes('運行中')), { message: 'status text' })
    const bar = walk(s.view.container).find((element) => hasClassName(element, 'stream-bar'))
    assert.ok(bar && inHeader(bar), 'the bar is a descendant of header.app-header')
    const main = walk(s.view.container).find((element) => element.localName === 'main')
    assert.equal(walk(main).some((element) => hasClassName(element, 'stream-bar') || hasClassName(element, 'stream-status')), false, 'nothing of it is left in the page body')
    const slot = byAttr(s.view.container, 'data-testid', 'header-status-slot')
    assert.ok(slot && slot.contains(bar) && inHeader(slot))
    const kids = headerOf(s.view).childNodes.filter((node) => node.nodeType === 1)
    const at = (predicate) => kids.findIndex(predicate)
    assert.ok(at((node) => node === slot) > at((node) => node.localName === 'h1') && at((node) => node === slot) < at((node) => node.localName === 'nav'), 'between the title and the tabs')
  } finally { s.dispose() }
})

test('H2 the duplicate 「N 則」 counter is gone; the count appears once, inside the status sentence', async () => {
  const s = appStreamScene({})
  try {
    await until(() => streamStatusText(s.view).includes('已收 2 則'), { message: 'status with the count' })
    assert.equal(walk(s.view.container).some((element) => hasClassName(element, 'stream-count')), false)
    assert.equal((s.view.container.textContent.match(/2 則/g) ?? []).length, 1)
  } finally { s.dispose() }
})

test('H3 a read timeout shows the red dot, the alert wording and 重試 in the header; the retry (called through the portal) resends and recovers', async () => {
  const hang = deferred()
  let listCalls = 0
  const s = appStreamScene({
    'db.chats.list': async () => { listCalls += 1; if (listCalls === 1) await hang.promise; return [wpChat('bni', 'BNI 商會')] },
    'line.status': async () => STOPPED
  }, { timeouts: { coreMs: 150, pingMs: 5000, longMs: 5000, bulkMs: 5000 } })
  try {
    await until(() => streamStatusText(s.view).includes('讀取逾時'), { timeout: 3000, message: 'timeout wording' })
    const status = walk(s.view.container).find((element) => hasClassName(element, 'stream-status'))
    assert.equal(status.getAttribute('role'), 'alert')
    assert.ok(inHeader(status))
    const bar = walk(s.view.container).find((element) => hasClassName(element, 'stream-bar'))
    assert.ok(walk(bar).some((element) => hasClassName(element, 'dot') && hasClassName(element, 'err')), 'red dot')
    const retry = walk(bar).find((element) => element.localName === 'button' && element.textContent.trim() === '重試')
    assert.ok(retry, 'retry button in the header')
    hang.resolve()
    reactProps(retry).onClick({})
    await until(() => walk(s.view.container).some((element) => hasClassName(element, 'chat-list-item') && element.textContent.includes('BNI 商會')), { message: 'list recovers' })
    await until(() => !streamStatusText(s.view).includes('讀取逾時'), { message: 'timeout wording clears' })
  } finally { hang.resolve(); s.dispose() }
})

test('H4 診斷 stays a collapsed <details> inside the header and still opens with the diagnostic fields', async () => {
  const s = appStreamScene({ 'backend.info': async () => ({ pid: 4242, uptimeMs: 125_000 }) })
  try {
    const details = () => walk(s.view.container).find((element) => element.localName === 'details' && element.getAttribute('data-testid') === 'backend-diagnostics')
    await until(() => details(), { message: 'details' })
    assert.ok(inHeader(details()))
    assert.equal(details().hasAttribute('open'), false)
    reactProps(details()).onToggle({ currentTarget: { open: true } })
    const field = (name) => walk(details()).find((element) => element.getAttribute('data-diag') === name)?.textContent ?? ''
    await until(() => field('backend').includes('pid 4242'), { message: 'diagnostic fields' })
    assert.equal(field('error'), '無')
  } finally { s.dispose() }
})

test('H5 other tabs render no status slot and no status bar; coming back to the chat tab puts it back in the header', async () => {
  const s = appStreamScene({ 'db.todos.list': () => [], 'groupTopics.overview': () => [] })
  try {
    await until(() => byAttr(s.view.container, 'data-testid', 'header-status-slot'), { message: 'slot on the chat tab' })
    const tab = (label) => walk(s.view.container).find((element) => element.localName === 'button' && hasClassName(element, 'tab') && element.textContent.trim() === label)
    for (const label of ['總覽', '群組議題']) {
      reactProps(tab(label)).onClick({})
      await until(() => byAttr(s.view.container, 'data-testid', 'header-status-slot') === null, { message: `no slot on ${label}` })
      assert.equal(walk(s.view.container).some((element) => hasClassName(element, 'stream-bar')), false, `no status bar on ${label}`)
    }
    reactProps(tab('聊天')).onClick({})
    await until(() => walk(s.view.container).some((element) => hasClassName(element, 'stream-bar') && inHeader(element)), { message: 'bar back in the header' })
  } finally { s.dispose() }
})

test('H6 without an App header (MessageStream mounted alone) the status bar stays in place, exactly as before', async () => {
  const { api } = plugin({
    'db.chats.list': () => [], 'db.messages.list': () => [], 'db.messages.recentByChat': () => [], 'messages.recent': () => [],
    'db.chats.listPrefs': () => PREFS(), 'line.status': () => ({ state: 'running', lastMessageAt: null, messageCount: 2, lastError: null, restarts: 0 })
  })
  const scene = ui.mount(ui.messageStreamScene(api))
  try {
    await until(() => streamStatusText(scene).includes('運行中'), { message: 'status' })
    const bar = walk(scene.container).find((element) => hasClassName(element, 'stream-bar'))
    assert.ok(bar)
    assert.ok(ancestors(bar).some((node) => node.nodeType === 1 && hasClassName(node, 'stream')), 'inside the stream section')
  } finally { scene.unmount(); api.dispose() }
})

test('H7 the stylesheet puts the slot and the bar into the header without boxes, wraps the header, lets 診斷 take its own row, and no longer has .stream-count', () => {
  const css = readFileSync(resolve(ROOT, 'src', 'renderer', 'styles', 'index.css'), 'utf8')
  assert.match(css, /\.app-header-status\s*\{\s*display:\s*contents;\s*\}/)
  assert.match(css, /\.app-header \.stream-bar\s*\{\s*display:\s*contents;\s*\}/)
  assert.match(css, /\.app-header\s*\{[^}]*flex-wrap:\s*wrap;/)
  assert.match(css, /\.stream-diag\[open\]\s*\{[^}]*flex:\s*1 0 100%/)
  assert.equal(css.includes('.stream-count'), false)
  assert.match(css, /\.chat-list-row\.ignored/)
})

// ── board lazy render: each column draws 30 cards first and 30 more whenever its bottom sentinel scrolls into view ──
const LAZY_PAGE = 30
/** rows: 70 pending (todo), 5 waiting, 100 done; chats alternate g1 / d1 so the 只看 1:1 filter keeps half of every column */
function lazyRows() {
  const chat = (i) => (i % 2 === 0 ? 'g1' : 'd1')
  return [
    ...Array.from({ length: 70 }, (_, i) => bulkRow(`t${i}`, chat(i), 'todo', 'pending')),
    ...Array.from({ length: 5 }, (_, i) => bulkRow(`w${i}`, chat(i), 'waiting', 'waiting_reply')),
    ...Array.from({ length: 100 }, (_, i) => bulkRow(`d${i}`, chat(i), 'todo', 'done'))
  ]
}
/**
 * a hand-driven IntersectionObserver: `reach(section)` is "that column's sentinel scrolled into its body"; a fresh observer reports nothing until then (the sentinel starts below the fold).
 * `visibleWhile = (target) => boolean` makes it behave like a real one for a viewport taller than the drawn cards: observe() of a target for which it holds is answered (asynchronously, like the real
 * first callback) with isIntersecting:true, so a component that does not observe again after a batch is left stranded exactly as it would be in a browser.
 */
function installSentinelObserver() {
  const live = new Set()
  const previous = globalThis.IntersectionObserver
  const stand = { visibleWhile: null }
  globalThis.IntersectionObserver = class {
    constructor(callback, options) { this.callback = callback; this.options = options; this.targets = new Set(); live.add(this) }
    observe(target) {
      this.targets.add(target)
      if (stand.visibleWhile) queueMicrotask(() => { if (live.has(this) && this.targets.has(target) && stand.visibleWhile(target)) this.callback([{ target, isIntersecting: true, intersectionRatio: 1 }]) })
    }
    unobserve(target) { this.targets.delete(target) }
    disconnect() { live.delete(this); this.targets.clear() }
  }
  return {
    live,
    set visibleWhile(fn) { stand.visibleWhile = fn },
    reach(section) {
      const hits = [...live].filter((observer) => [...observer.targets].some((target) => section.contains(target)))
      for (const observer of hits) observer.callback([...observer.targets].map((target) => ({ target, isIntersecting: true, intersectionRatio: 1 })))
      return hits.length
    },
    restore() { if (previous === undefined) delete globalThis.IntersectionObserver; else globalThis.IntersectionObserver = previous }
  }
}
function lazyScene(rows = lazyRows(), { visibleWhile = null } = {}) {
  const observer = installSentinelObserver()
  observer.visibleWhile = visibleWhile
  const s = bulkScene(rows)
  const section = (col) => walk(s.view.container).find((element) => hasClassName(element, 'kb-column') && hasClassName(element, `col-${col}`))
  const cards = (col) => walk(section(col)).filter((element) => hasClassName(element, 'todo-card')).length
  const sentinel = (col) => walk(section(col)).find((element) => element.getAttribute('data-testid') === 'kb-col-sentinel') ?? null
  const body = (col) => walk(section(col)).find((element) => hasClassName(element, 'kb-col-body'))
  const reach = async (col, expected) => {
    await until(() => [...observer.live].filter((o) => [...o.targets].some((target) => section(col).contains(target))).length === 1, { message: `one live observer watches the ${col} sentinel` })
    assert.equal(observer.reach(section(col)), 1, `exactly one live observer watches the ${col} sentinel`)
    await until(() => cards(col) === expected, { message: `${col} grows to ${expected} cards` })
  }
  const setGroup = (checked) => reactProps(walk(s.view.container).find((element) => element.localName === 'input' && element.getAttribute('type') === 'checkbox')).onChange({ target: { checked } })
  const setSort = (value) => reactProps(walk(s.view.container).find((element) => element.localName === 'select' && element.textContent.includes('建立時間'))).onChange({ target: { value } })
  return { ...s, observer, section, cards, sentinel, body, reach, setGroup, setSort, dispose() { s.dispose(); observer.restore() } }
}

test('board lazy render: every column starts with at most 30 cards, the title counts stay the full totals, only a column with more has a sentinel', async () => {
  const s = lazyScene()
  try {
    await until(() => s.head('已完成')?.textContent === '已完成100', { message: 'the board' })
    assert.equal(s.head('待辦').textContent, '待辦70')
    assert.equal(s.head('等回覆').textContent, '等回覆5')
    assert.equal(s.cards('todo'), LAZY_PAGE)
    assert.equal(s.cards('waiting'), 5)
    assert.equal(s.cards('schedule'), 0)
    assert.equal(s.cards('done'), LAZY_PAGE)
    assert.ok(s.sentinel('todo') && s.sentinel('done'))
    assert.equal(s.sentinel('waiting'), null, 'a column that fits has no sentinel')
    assert.equal(s.sentinel('done').getAttribute('aria-hidden'), 'true')
    assert.equal(s.sentinel('done').textContent, '', 'no text in the sentinel')
    for (const observer of s.observer.live) assert.equal(hasClassName(observer.options.root, 'kb-col-body'), true, 'the observer root is the column scroll container')
    const drawn = walk(s.section('done')).filter((element) => hasClassName(element, 'todo-card')).map((element) => element.textContent)
    assert.equal(drawn.some((text) => text.includes('標題d0')), true, 'the first cards in order are the ones drawn')
    assert.equal(drawn.some((text) => text.includes('標題d29')), true)
    assert.equal(drawn.some((text) => text.includes('標題d30')), false, 'card 31 is not drawn yet')
  } finally { s.dispose() }
})

test('board lazy render: reaching the bottom adds 30 at a time until everything is drawn, then nothing more is watched or added', async () => {
  const s = lazyScene()
  try {
    await until(() => s.head('已完成')?.textContent === '已完成100', { message: 'the board' })
    await s.reach('done', 60)
    assert.equal(s.cards('todo'), LAZY_PAGE, 'another column is not touched')
    await s.reach('done', 90)
    await s.reach('done', 100)
    assert.equal(s.sentinel('done'), null, 'everything drawn: the sentinel is gone')
    assert.equal(s.observer.reach(s.section('done')), 0, 'and nothing watches the column any more')
    await sleep(30)
    assert.equal(s.cards('done'), 100)
    assert.equal(s.head('已完成').textContent, '已完成100')
    await s.reach('todo', 60)
    await s.reach('todo', 70)
    assert.equal(s.sentinel('todo'), null)
  } finally { s.dispose() }
})

test('board lazy render: after each batch the sentinel is watched again, so a column taller than the drawn cards fills up without any scrolling, and it stops as soon as the sentinel is out of view', async () => {
  // the column is "tall enough for 85 cards": a sentinel reports itself in view the moment it is observed, for as long as fewer than 85 cards are drawn (a real observer's first callback after observe())
  let s = null
  s = lazyScene(undefined, { visibleWhile: (target) => { const section = s?.section('done'); return !!section && section.contains(target) && s.cards('done') < 85 } })
  try {
    await until(() => s.head('已完成')?.textContent === '已完成100', { message: 'the board' })
    await until(() => s.cards('done') === 90, { message: '30 -> 60 -> 90 with no reach() call at all' })
    await sleep(60)
    assert.equal(s.cards('done'), 90, '90 fills the column, so the sentinel is out of view and nothing more is added')
    assert.notEqual(s.sentinel('done'), null, 'the rest (10) is still behind the sentinel')
    assert.equal(s.cards('todo'), LAZY_PAGE, 'the todo column has no reason to grow: its sentinel never came into view')
    await s.reach('done', 100)
  } finally { s.dispose() }
})

test('board lazy render: every observer is rooted at its own column body and looks a little way below it (rootMargin: bottom only)', async () => {
  const s = lazyScene()
  try {
    await until(() => s.head('已完成')?.textContent === '已完成100', { message: 'the board' })
    for (const col of ['todo', 'done']) {
      const mine = [...s.observer.live].filter((observer) => [...observer.targets].some((target) => s.section(col).contains(target)))
      assert.equal(mine.length, 1, 'one observer for the ' + col + ' column')
      assert.equal(mine[0].options.root, s.body(col), 'rooted at the column scroll container, not the page (root: null would look at the window)')
      const margin = /^0px 0px (\d+)px 0px$/.exec(mine[0].options.rootMargin ?? '')
      assert.ok(margin, 'rootMargin looks only below the column: ' + mine[0].options.rootMargin)
      assert.ok(Number(margin[1]) >= 1 && Number(margin[1]) <= 400, 'a head start of a few cards, not zero and not the whole column: ' + margin[1] + 'px')
    }
  } finally { s.dispose() }
})

test('board lazy render: changing the filter or the sort or the grouping puts every column back to 30 and scrolls it to the top', async () => {
  const s = lazyScene()
  try {
    await until(() => s.head('已完成')?.textContent === '已完成100', { message: 'the board' })
    await s.reach('done', 60)
    await s.reach('todo', 60)
    s.body('done').scrollTop = 900
    s.setKind('direct')
    await until(() => s.head('已完成').textContent === '已完成50', { message: 'the 1:1 filter' })
    assert.equal(s.cards('done'), LAZY_PAGE, 'filter: back to the first 30')
    assert.equal(s.cards('todo'), LAZY_PAGE)
    await until(() => s.body('done').scrollTop === 0, { message: 'and scrolled to the top (a passive effect, it lands a moment after the new cards)' })
    await s.reach('done', 50)
    s.body('done').scrollTop = 400
    s.setKind('all')
    await until(() => s.head('已完成').textContent === '已完成100', { message: 'all again' })
    assert.equal(s.cards('done'), LAZY_PAGE)
    await s.reach('done', 60)
    s.body('done').scrollTop = 400
    s.setGroup(true)
    await until(() => walk(s.section('done')).some((element) => hasClassName(element, 'todo-chat-group')), { message: 'grouping' })
    assert.equal(s.cards('done'), LAZY_PAGE, 'grouping: back to the first 30')
    await until(() => s.body('done').scrollTop === 0, { message: 'grouping: scrolled back to the top (a passive effect, it lands a moment after the new cards)' })
    const counts = walk(s.section('done')).filter((element) => hasClassName(element, 'todo-chat-group-count')).map((element) => element.textContent)
    assert.deepEqual(counts, ['50 件', '50 件'], 'a group head shows the chat total, not just the drawn part')
    await s.reach('done', 60)
    s.body('done').scrollTop = 400
    s.setGroup(false)
    await until(() => !walk(s.section('done')).some((element) => hasClassName(element, 'todo-chat-group')), { message: 'grouping off' })
    assert.equal(s.cards('done'), LAZY_PAGE)
    await s.reach('done', 60)
    s.body('done').scrollTop = 400
    s.setSort('createdAt')
    await until(() => s.cards('done') === LAZY_PAGE && s.body('done').scrollTop === 0, { message: 'sort resets' })
    assert.equal(s.head('已完成').textContent, '已完成100')
  } finally { s.dispose() }
})

test('board lazy render: dragging cards in or out leaves the drawn count alone, and the totals follow the data', async () => {
  const s = lazyScene()
  try {
    await until(() => s.head('已完成')?.textContent === '已完成100', { message: 'the board' })
    await s.reach('done', 60)
    const listsBefore = s.lists()
    s.drop('done', 't0')
    await until(() => s.head('已完成').textContent === '已完成101' && s.lists() > listsBefore, { message: 'a card dragged in' })
    assert.equal(s.cards('done'), 60, 'dragged in: the expansion stays')
    assert.equal(s.head('待辦').textContent, '待辦69')
    const listsMid = s.lists()
    s.drop('waiting', 'd5')
    await until(() => s.head('已完成').textContent === '已完成100' && s.lists() > listsMid, { message: 'a card dragged out' })
    assert.equal(s.cards('done'), 60, 'dragged out: the expansion stays')
    assert.equal(s.head('等回覆').textContent, '等回覆6')
    await s.reach('done', 90)
  } finally { s.dispose() }
})

test('board lazy render: 全部移到 counts and moves every card of the column, drawn or not', async () => {
  const s = lazyScene()
  try {
    await until(() => s.head('已完成')?.textContent === '已完成100', { message: 'the board' })
    assert.equal(s.cards('done'), LAZY_PAGE)
    await s.confirmOpen('已完成', '全部移到待辦')
    assert.match(s.dialog().textContent, /^要把 100 張移到待辦嗎？/, 'the count is the whole column (only 30 are drawn)')
    const listsBefore = s.lists()
    s.click(s.okBtn())
    await until(() => !s.dialog() && s.lists() > listsBefore, { message: 'moved and re-read' })
    assert.equal(s.moves().length, 100)
    assert.deepEqual(new Set(s.moves().map(([, column]) => column)), new Set(['todo']))
    assert.equal(new Set(s.moves().map(([id]) => id)).size, 100, 'each of the 100 once')
    assert.ok(s.moves().some(([id]) => id === 'd99'), 'including a card that was never drawn')
    await until(() => s.head('待辦').textContent === '待辦170' && s.head('已完成').textContent === '已完成0', { message: 'the board after the move' })
  } finally { s.dispose() }
})

test('board lazy render: without an IntersectionObserver the column draws everything (nothing is stranded behind a sentinel nobody watches)', async () => {
  const previous = globalThis.IntersectionObserver
  delete globalThis.IntersectionObserver
  const s = bulkScene(lazyRows())
  try {
    const cards = (col) => walk(s.view.container).filter((element) => hasClassName(element, 'todo-card') && ancestors(element).some((node) => node.nodeType === 1 && hasClassName(node, `col-${col}`))).length
    await until(() => cards('done') === 100 && cards('todo') === 70, { message: 'all cards drawn' })
  } finally { s.dispose(); if (previous !== undefined) globalThis.IntersectionObserver = previous }
})
