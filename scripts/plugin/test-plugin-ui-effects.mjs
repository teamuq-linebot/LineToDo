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
  blocklist: { nameKeywords: [], senderKeywords: [], contentTypeNoiseOnly: [], minTextLenForLLM: 2 },
  chatIgnoreKeywords: {}, openAtLogin: false, reconcile: { enabled: true, scopeMonths: 0 },
  aiBaseUrl: '', aiProvider: 'http',
  claudeCli: { execPath: '', model: '', timeoutMs: 120000 }, codexCli: { execPath: '', model: '', timeoutMs: 120000 },
  driverPost: { enabled: false, mode: 'fillOnly', verifyReadByDb: true },
  hasApiKey: true, apiKeySource: 'none', safeStorageAvailable: false,
}
const settingsHandlers = (extra = {}) => ({
  'settings.prompt.get': () => ({ initialPrompt: '初始：只抽出明確的待辦。', activePrompt: '初始：只抽出明確的待辦。', customized: false, revision: 'initial', maxChars: 12000, outputFormat: '只輸出固定 JSON 欄位。' }),
  'settings.get': () => VIEW,
  'settings.update': (patch) => ({ ...VIEW, ...patch }),
  'db.chats.list': () => [],
  'pipeline.status': () => ({ hasApiKey: true, running: true, busy: false, intervalSec: 30, lastRunAt: null, lineBridge: 'ok' }),
  ...extra
})

test('chat search finds senders and older messages that are loaded in the selected conversation without searching unloaded history', async () => {
  const bni = { chatId: 'bni', name: 'BNI 商會', isGroup: true, blocked: false, blockReason: null, firstSeenAt: new Date(1700000000000).toISOString(), lastSeenAt: new Date(1700000003000).toISOString() }
  const family = { chatId: 'family', name: '家庭群', isGroup: true, blocked: false, blockReason: null, firstSeenAt: new Date(1699999000000).toISOString(), lastSeenAt: new Date(1699999000000).toISOString() }
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
  const chat = { chatId, name: chatId, isGroup: true, blocked: false, blockReason: null, firstSeenAt: new Date(ts).toISOString(), lastSeenAt: new Date(ts).toISOString() }
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
  const chat = { chatId, name: '404 測試群組', isGroup: true, blocked: false, blockReason: null, firstSeenAt: new Date(ts).toISOString(), lastSeenAt: new Date(ts).toISOString() }
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

test('avatar fixture keeps readable fallback labels when source images are unavailable', async () => {
  const chatId = 'm-no-avatar-fixture'
  const ts = Date.UTC(2026, 9, 30, 4, 0, 0)
  const chat = { chatId, name: chatId, isGroup: true, blocked: false, blockReason: null, firstSeenAt: new Date(ts).toISOString(), lastSeenAt: new Date(ts).toISOString() }
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
  const chat = { chatId, name: 'F1 歷史測試群組', isGroup: true, blocked: false, blockReason: null, firstSeenAt: new Date(ts0).toISOString(), lastSeenAt: new Date(ts0 + 1_000_000).toISOString() }
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
      chats: { list: async () => [chat], setBlocked: async () => chat },
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
  const chat = { chatId: 'c-f2-ui', name: 'F2 來源測試群組', isGroup: true, blocked: false, blockReason: null, firstSeenAt: new Date(ts).toISOString(), lastSeenAt: new Date(ts + 2000).toISOString() }
  const rows = [
    { msgId: 'i:empty', chatId: chat.chatId, ts, timeIso: new Date(ts).toISOString(), direction: 'in', sender: 'A', text: '', contentType: 0, processed: false, ingestedAt: new Date(ts).toISOString(), origFilename: null, fileSize: null, unsent: true },
    { msgId: 'i:literal', chatId: chat.chatId, ts: ts + 1000, timeIso: new Date(ts + 1000).toISOString(), direction: 'in', sender: 'A', text: '[type=0]', contentType: 0, processed: false, ingestedAt: new Date(ts + 1000).toISOString(), origFilename: null, fileSize: null, unsent: true },
    { msgId: 'i:whitespace', chatId: chat.chatId, ts: ts + 2000, timeIso: new Date(ts + 2000).toISOString(), direction: 'in', sender: 'A', text: '   \t', contentType: 0, processed: false, ingestedAt: new Date(ts + 2000).toISOString(), origFilename: null, fileSize: null, unsent: true }
  ]
  const api = {
    db: {
      chats: { list: async () => [chat], setBlocked: async () => chat },
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

test('identity inbox (effects): synthetic source, failed CAS retention, explicit re-evaluation and relation rejection stay visible',async()=>{
  const sourceId='synthetic-source-1'
  const item={entityType:'todo',decisionId:'synthetic-decision-1',chatId:'synthetic-group',sourceDigest:'digest',draftRef:'draft_one',outcome:'defer',state:'open',canonicalId:null,decisionRevision:1,sourceEpoch:2,scopeRevision:1,identityRevision:2,topicIdentityRevision:1,draft:{draftRef:'draft_one',title:'預約合成會議室',detail:'週五前確認時段',sourceMsgIds:[sourceId]},reasonCodes:['insufficient_evidence'],candidates:[{entityType:'todo',entityId:'todo-old',title:'過往會議室預約',summary:'舊任務',status:'done',bucket:'todo',dueAt:null,sourceMsgIds:[],recallReasons:['exact_title'],completionEventTs:10}],candidateRevisions:[{entityType:'todo',entityId:'todo-old',revision:3}],sourceMsgIds:[sourceId],updatedAt:'2026-10-28T05:00:00.000Z'}
  const modelSuggestion={draftRef:'draft_one',outcome:'new',candidateType:null,candidateId:null,relationKind:null,reasonCode:'fresh_occurrence',confidenceBand:'medium',evidenceMsgIds:[sourceId]}
  const relation={relationId:'synthetic-relation',chatId:'synthetic-group',todoId:'todo-old',todoTitle:'過往會議室預約',todoStatus:'done',todoRevision:3,topicId:'topic-current',topicTitle:'群組會議',topicRevision:2,relationType:'same_topic',status:'proposed',revision:1,decisionId:'synthetic-decision-1',sourceMsgIds:[sourceId]}
  const link={linkId:'synthetic-link',leftTopicId:'topic-a',leftChatId:'synthetic-group',leftChatName:'合成群組',leftTitle:'群組會議',leftRevision:2,rightTopicId:'topic-b',rightChatId:'synthetic-group-b',rightChatName:'另一合成群組',rightTitle:'週會安排',rightRevision:4,relation:'related',identityEvidence:'unknown',status:'proposed',stale:false,eventEvidenceMsgIds:[],linkRevision:1,permissionAllowed:true}
  const state={item:{...item},resolved:0,topicRelation:'proposed',topicLink:'proposed',failNextResolve:true}
  const api={
    db:{
      chats:{list:async()=>[{chatId:'synthetic-group',name:'合成群組',isGroup:true,blocked:false},{chatId:'synthetic-group-b',name:'另一合成群組',isGroup:true,blocked:false}]},
      todos:{identity:{
        listPending:async()=>({items:state.resolved?[]:[state.item]}),
        inspect:async()=>({item:state.item,sourceEvidence:[{msgId:sourceId,ts:100,timeIso:'2026-10-28T05:00:00.000Z',direction:'in',sender:'合成成員',text:'請協助預約合成會議室'}]}),
        retry:async()=>{state.item={...state.item,decisionRevision:2,suggestedDecision:modelSuggestion};return{ok:true,item:state.item}},
        resolve:async(input)=>{if(state.failNextResolve){state.failNextResolve=false;return{ok:false,reason:'revision_conflict'}}state.resolved+=1;return{ok:true,canonicalId:'todo-new',state:'resolved',decisionRevision:input.expectedDecisionRevision+1}},
        todoTopicRelations:async()=>state.topicRelation==='proposed'?[relation]:[],
        resolveTodoTopicRelation:async(input)=>{state.topicRelation=input.choice==='reject'?'rejected':'confirmed';return{ok:true,status:state.topicRelation,revision:2}}
      }}
    },
    groupTopics:{linkProposals:async()=>state.topicLink==='proposed'?[link]:[],resolveLinkProposal:async(input)=>{state.topicLink=input.choice==='reject'?'rejected':'accepted';return{ok:true,status:state.topicLink,linkRevision:2}}}
  }
  const view=ui.mount(ui.identityInboxScene(api))
  try{
    await until(()=>view.container.textContent.includes('請協助預約合成會議室')&&view.container.textContent.includes('過往會議室預約'),{message:'source evidence and history candidate rendered'})
    const button=(label)=>walk(view.container).find((el)=>el.localName==='button'&&el.textContent.trim()===label)
    reactProps(button('重新判斷')).onClick()
    await until(()=>view.container.textContent.includes('重新判斷完成')&&view.container.textContent.includes('可能是新一輪工作'),{message:'explicit retry suggestion rendered'})
    reactProps(button('採用建議')).onClick()
    await until(()=>view.container.textContent.includes('這項工作已被更新')&&view.container.textContent.includes('請協助預約合成會議室'),{message:'failed CAS keeps source and work visible'})
    reactProps(button('採用建議')).onClick()
    await until(()=>state.resolved===1&&view.container.textContent.includes('已處理延期身份'),{message:'user-confirmed resolution refreshes the inbox'})
    assert.equal(state.topicRelation,'proposed','resolving a Todo does not implicitly confirm a separate relation')
    assert.equal(state.topicLink,'proposed','resolving a Todo does not implicitly accept a cross-chat Topic link')
    reactProps(button('拒絕關聯')).onClick()
    await until(()=>state.topicRelation==='rejected',{message:'Todo–Topic relation rejection sent'})
    assert.equal(state.resolved,1,'relation rejection leaves the canonical Todo untouched')
    reactProps(button('拒絕跨群關聯')).onClick()
    await until(()=>state.topicLink==='rejected',{message:'cross-chat relation rejection sent'})
    assert.equal(state.resolved,1,'cross-chat relation rejection leaves both Topics untouched')
  }finally{view.unmount()}
})

test('chat todos (effects): direct and group panes stay scoped; loading, failure, retry, empty and late-response states render correctly', async () => {
  const direct = { chatId: 'synthetic-direct', name: '合成單人聊天室', isGroup: false, blocked: false, blockReason: null, firstSeenAt: '2026-10-29T00:00:00.000Z', lastSeenAt: '2026-10-30T01:00:00.000Z' }
  const group = { chatId: 'synthetic-group', name: '合成群組聊天室', isGroup: true, blocked: false, blockReason: null, firstSeenAt: '2026-10-29T00:00:00.000Z', lastSeenAt: '2026-10-30T00:00:00.000Z' }
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
  const topicLinkQueries = []
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
    'groupTopics.crossChatEnabled': (chatId) => { crossTopicQueries.push(`cross:${chatId}`); return false },
    'groupTopics.linkCandidates': (chatId) => { topicLinkQueries.push(chatId); return [] },
    'groupTopics.pendingCount': (chatId) => { crossTopicQueries.push(`pending:${chatId}`); return chatId === direct.chatId && !directTopicsEnabled ? 1 : 0 },
    'messages.recent': () => [],
    'line.status': () => ({ state: 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 }),
    'db.todos.openByChat': (chatId) => {
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
      assert.ok(paneButton('待辦'), 'the chat header has a todo pane')
      assert.ok(paneButton('議題'), 'a direct chat has its own topics pane')
      assert.equal(paneButton('訊息').getAttribute('aria-pressed'), 'true')

      click(paneButton('議題'))
      await until(() => topicListQueries.includes(direct.chatId) && view.container.textContent.includes('啟用此聊天室議題分析'), { message: 'direct topics load from the selected chat and offer opt-in enable' })
      assert.ok(view.container.textContent.includes('此聊天室的議題'))
      assert.equal(view.container.textContent.includes('跨群語意候選'), false, 'direct topics do not expose cross-group controls')
      assert.deepEqual(topicAnalyzeQueries, [], 'opening the topic pane does not auto-analyze')
      assert.deepEqual(topicEnableQueries, [], 'opening the topic pane does not auto-enable')
      const directEnable = walk(view.container).find((element) => element.localName === 'input' && element.getAttribute('type') === 'checkbox')
      assert.ok(directEnable, 'the direct topic enable control renders')
      reactProps(directEnable).onChange({ target: { checked: true } })
      await until(() => topicEnableQueries.some((entry) => entry.chatId === direct.chatId && entry.enabled) && view.container.textContent.includes(directTopic.title), { message: 'enabling direct topics reads existing results for that chat' })
      const directAnalyzeButton = walk(view.container).find((element) => element.localName === 'button' && element.textContent.trim() === '分析最近聊天室訊息')
      assert.ok(directAnalyzeButton, 'manual analysis is available for a direct chat')
      click(directAnalyzeButton)
      await until(() => topicAnalyzeQueries.includes(direct.chatId) && view.container.textContent.includes('已整理 1 則新訊息'), { message: 'manual direct chat analysis calls the topic API for the selected chat' })
      assert.deepEqual(topicAnalyzeQueries, [direct.chatId])
      assert.ok(view.container.textContent.includes(directTopic.title))
      assert.deepEqual(crossTopicQueries.filter((value) => value.startsWith('cross:')), [], 'direct chats never query cross-group authorization')

      click(paneButton('待辦'))
      await until(() => view.container.textContent.includes(directTodo.title), { message: 'direct chat todos render' })
      assert.equal(paneButton('待辦').getAttribute('aria-pressed'), 'true')
      assert.ok(view.container.textContent.includes('待辦'))
      assert.ok(view.container.textContent.includes('來源訊息 1 則'))
      assert.ok(view.container.textContent.includes(directTodo.detail), 'complete detail is available on demand')
      assert.ok(paneButton('議題'), 'the direct chat keeps its topics pane while viewing todos')

      click(paneButton('訊息'))
      await until(() => paneButton('訊息')?.getAttribute('aria-pressed') === 'true', { message: 'message pane is selected before reopening todos' })
      click(paneButton('待辦'))
      await until(() => directCalls === 2 && view.container.textContent.includes('正在載入「合成單人聊天室」的待辦'), { message: 'direct refresh enters loading before its delayed reply' })
      click(chatButton(group.name))
      await until(() => groupCalls === 1 && view.container.textContent.includes('讀取此聊天室待辦失敗'), { message: 'group-scoped request failure is shown as an error' })
      assert.ok(view.container.textContent.includes('synthetic group todo failure'), 'the backend failure reason remains visible')
      assert.equal(view.container.textContent.includes(directTodo.title), false, 'the previous chat data is cleared on chat switch')
      assert.equal(paneButton('待辦').getAttribute('aria-pressed'), 'true', 'todo pane follows the selected chat')
      assert.ok(paneButton('議題'), 'group chat keeps its topics pane')

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
      await until(() => groupCalls === 3 && view.container.textContent.includes(groupTodo.title), { message: 'switching back to the group refreshes its todos' })
      deferGroupTopics = true
      click(paneButton('議題'))
      await until(() => topicListQueries.includes(group.chatId) && view.container.textContent.includes('正在載入「合成群組聊天室」的議題'), { message: 'the group topic request is pending for the selected group' })
      assert.ok(view.container.textContent.includes(groupTopic.title) === false, 'the delayed group result has not appeared early')
      click(chatButton(direct.name))
      await until(() => topicListQueries.filter((chatId) => chatId === direct.chatId).length >= 3 && view.container.textContent.includes(directTopic.title), { message: 'switching back opens the direct chat topics for its own chat id' })
      resolveGroupTopicRequest({ ok: true, topics: [groupTopic] })
      await sleep(20)
      assert.ok(view.container.textContent.includes(directTopic.title), 'the current direct chat topic remains visible after a late group response')
      assert.equal(view.container.textContent.includes(groupTopic.title), false, 'a late group response cannot replace direct chat topics')
      assert.ok(topicListQueries.includes(group.chatId) && topicListQueries.includes(direct.chatId), 'both requests use their chat-scoped ids')
      assert.equal(crossTopicQueries.filter((value) => value.startsWith('cross:')).includes(`cross:${direct.chatId}`), false)
      assert.equal(topicLinkQueries.includes(direct.chatId), false, 'direct chat topics never request cross-group candidates')
      click(paneButton('訊息'))
      await until(() => walk(view.container).some((element) => hasClass(element, 'chat-message-log')), { message: 'the existing message pane still opens' })
      assert.deepEqual(todoQueries, [direct.chatId, direct.chatId, group.chatId, group.chatId, direct.chatId, group.chatId], 'every read is scoped to the selected chat id')
      assert.ok(crossTopicQueries.filter((value) => value.startsWith('cross:')).every((value) => value === `cross:${group.chatId}`), 'group cross-chat checks remain group-only')
      assert.ok(topicLinkQueries.every((chatId) => chatId === group.chatId), 'group cross-chat candidate reads remain group-only')

      const css = readFileSync(resolve(ROOT, 'src', 'renderer', 'styles', 'index.css'), 'utf8')
      assert.match(css, /\.chat-todos-content\s*\{[^}]*overflow:\s*auto/s, 'the todo pane scrolls within the chat area')
      assert.match(css, /\.chat-todos-content\s*\{[^}]*padding:\s*16px clamp\(14px, 3vw, 34px\)/s, 'the content padding adapts to viewport width')
      assert.match(css, /\.chat-todo-card\s*\{[^}]*cursor:\s*default[^}]*user-select:\s*text/s, 'read-only todo cards do not advertise drag actions')
    } finally { view.unmount(); api.dispose() }
  })
  assert.deepEqual(unhandled, [], 'no unhandled rejection from chat todo loading or the late response')
})

// ───────────── WP-C: the chat list does not wait for auxiliary calls; phase wording; timeout + retry; diagnostics (all non-device: mini-dom + scripted host) ─────────────

const hasClassName = (element, name) => (element.getAttribute('class') ?? '').split(/\s+/).includes(name)
const streamStatusText = (scene) => walk(scene.container).find((element) => hasClassName(element, 'stream-status'))?.textContent ?? ''
const retryButtons = (scene) => walk(scene.container).filter((element) => element.localName === 'button' && element.textContent.trim() === '重試')
const chatItem = (scene, name) => walk(scene.container).find((element) => hasClassName(element, 'chat-list-item') && element.textContent.includes(name))
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const wpChat = (chatId, name) => ({ chatId, name, isGroup: true, blocked: false, blockReason: null, firstSeenAt: new Date(1700000000000).toISOString(), lastSeenAt: new Date(1700000003000).toISOString() })
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
      'settings.chatPrompt.list': async () => ({ items: [] })
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
  const chatAlice = { chatId: 'u-alice', name: 'Alice', isGroup: false, blocked: false, blockReason: null, firstSeenAt: '2026-11-01T00:00:00.000Z', lastSeenAt: '2026-11-01T00:00:00.000Z' }
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
  return { chatId, name, isGroup: false, blocked: false, blockReason: null, firstSeenAt: new Date(1700000000000).toISOString(), lastSeenAt: new Date(1700000003000).toISOString() }
}
const noOverride = (extra = {}) => ({
  chatId: 'bni', revision: 'r0', overridePrompt: null, overrideName: null, effectivePrompt: '預設的抽取規則', effectiveName: '預設名', promptSource: 'default', nameSource: 'default',
  defaultName: '預設名', maxChars: 12000, maxNameChars: 40, corrupt: false, ...extra
})

test('A17/A18 board: the chat pane has a fourth "AI 設定" tab, marked only when the chat has an override; the editor stays closed until asked for; save sends the whole pair; conflicts and validation errors read in Chinese; reset returns to "沿用預設"', async () => {
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
    assert.deepEqual(toggleButtons().map((button) => button.textContent.trim()), ['訊息', '議題', '待辦', 'AI 設定'], 'fourth tab after 待辦')
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
    assert.deepEqual(toggleLabels(scene), ['訊息', '議題', '待辦', 'AI 設定'])
  } finally { scene.unmount() }
  scene = ui.mount(ui.messageStreamScene({ ...api, hostAi: { ...api.hostAi, chatPrompts: undefined } }))
  try {
    await until(() => toggleLabels(scene).length > 0, { message: 'pane header without chatPrompts' })
    assert.deepEqual(toggleLabels(scene), ['訊息', '議題', '待辦'])
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
  const chat = (chatId, name, ts) => ({ chatId, name, isGroup: true, blocked: false, blockReason: null, firstSeenAt: iso(ts0), lastSeenAt: iso(ts) })
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

// ───────────── overview tab: board on top, collapsible group topics below ─────────────

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
    'db.chats.list': () => OVERVIEW_GROUPS.map((group) => ({ ...group, isGroup: true, blocked: false, blockReason: null, firstSeenAt: '2026-10-29T00:00:00.000Z', lastSeenAt: '2026-10-30T00:00:00.000Z' })),
    'db.todos.list': () => [],
    'groupTopics.overview': () => overviewRows(),
    'groupTopics.list': (chatId) => { const row = overviewRows().find((entry) => entry.chatId === chatId); return { ok: !!row?.enabled, topics: row?.topics ?? [] } },
    ...extra
  }, log)
}
const memoryStorage = (seed = {}) => {
  const data = new Map(Object.entries(seed).map(([key, value]) => [`lt-ui:${key}`, JSON.stringify({ v: value, at: Date.now() })]))
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) }
}
const topicsToggle = (view) => walk(view.container).find((element) => hasClassName(element, 'overview-topics-toggle'))

test('overview tab: mounting the board and the group topics section stays within 6 host calls and asks the aggregate once instead of listing every group', async () => {
  const log = []
  const { api } = plugin(overviewHandlers(log))
  dom.document.documentElement.dataset ??= {}
  const view = ui.mount(ui.appScene(api))
  try {
    await until(() => view.container.textContent.includes('總覽議題0') && view.container.textContent.includes('總覽議題2'), { message: 'the topics section shows the aggregate result' })
    await sleep(60)
    const paths = log.map((entry) => entry.path)
    // 6 is the deliberate ceiling from design R10 (host call queue), not a measured value: a new mount-phase call must be justified, not just allowed here.
    assert.ok(log.length <= 6, `mount-phase host calls: ${log.length} (${paths.join(', ')})`)
    assert.equal(paths.filter((path) => path === 'groupTopics.overview').length, 1, 'one aggregate read')
    assert.equal(paths.filter((path) => path === 'groupTopics.list').length, 0, 'no per-group list')
    assert.deepEqual(log.filter((entry) => entry.path === 'db.chats.list').map((entry) => entry.args), [[true]], 'only the board reads the chat list; the topics section does not')
    assert.ok(view.container.textContent.includes('總覽群組5'), 'disabled groups are still listed in the overview')
  } finally { view.unmount(); api.dispose() }
})

test('overview tab: the topics section sends nothing until the board has finished its first todo load', async () => {
  const log = []
  let releaseTodos
  const todosGate = new Promise((resolve) => { releaseTodos = resolve })
  const { api } = plugin(overviewHandlers(log, { 'db.todos.list': () => todosGate.then(() => []) }))
  dom.document.documentElement.dataset ??= {}
  const view = ui.mount(ui.appScene(api))
  try {
    await until(() => log.some((entry) => entry.path === 'db.todos.list'), { message: 'the board asks for its todos' })
    await sleep(80)
    assert.deepEqual(log.filter((entry) => entry.path.startsWith('groupTopics.')), [], 'no topics request while the board is still loading')
    assert.equal(log.filter((entry) => entry.path === 'db.chats.list' && entry.args[0] === false).length, 0, 'no second chat list either')
    releaseTodos()
    await until(() => log.some((entry) => entry.path === 'groupTopics.overview'), { message: 'the topics section loads once the todos are in' })
    assert.ok(log.findIndex((entry) => entry.path === 'groupTopics.overview') > log.findIndex((entry) => entry.path === 'db.todos.list'))
  } finally { releaseTodos(); view.unmount(); api.dispose() }
})

test('overview tab: a collapsed topics section makes no request at all, the collapsed state is saved, and expanding loads it', async () => {
  const log = []
  const storage = memoryStorage({ 'overview.topicsOpen': false })
  const { api } = plugin(overviewHandlers(log))
  dom.document.documentElement.dataset ??= {}
  const view = ui.mount(ui.appSceneWithState(api, storage))
  try {
    await until(() => log.some((entry) => entry.path === 'db.todos.list') && topicsToggle(view), { message: 'the board loaded and the toggle exists' })
    await sleep(80)
    assert.deepEqual(log.filter((entry) => entry.path.startsWith('groupTopics.')), [], 'collapsed: no groupTopics request')
    assert.equal(log.filter((entry) => entry.path === 'db.chats.list' && entry.args[0] === false).length, 0, 'collapsed: no topics chat list')
    assert.equal(topicsToggle(view).getAttribute('aria-expanded'), 'false')
    assert.equal(view.container.textContent.includes('總覽議題0'), false)

    reactProps(topicsToggle(view)).onClick()
    await until(() => view.container.textContent.includes('總覽議題0'), { message: 'expanding loads the topics' })
    assert.equal(JSON.parse(storage.data.get('lt-ui:overview.topicsOpen')).v, true, 'the open state is saved')
    assert.equal(log.filter((entry) => entry.path === 'groupTopics.overview').length, 1)

    reactProps(topicsToggle(view)).onClick()
    await until(() => !view.container.textContent.includes('總覽議題0'), { message: 'collapsing unmounts the section' })
    assert.equal(JSON.parse(storage.data.get('lt-ui:overview.topicsOpen')).v, false, 'the collapsed state is saved')
    const mark = log.length
    await sleep(80)
    assert.equal(log.length, mark, 'collapsed again: nothing more is requested')
  } finally { view.unmount(); api.dispose() }
})

test('overview tab: a group opened from the overview keeps the single-group detail (enable switch, analyze) and returning re-reads the aggregate', async () => {
  const log = []
  const enabled = new Set(['ov-group-0'])
  const { api } = plugin(overviewHandlers(log, {
    'groupTopics.list': (chatId) => ({ ok: enabled.has(chatId), topics: [] }),
    'groupTopics.crossChatEnabled': () => false,
    'groupTopics.linkCandidates': () => [],
    'groupTopics.pendingCount': () => 0,
    'groupTopics.setEnabled': (chatId, value) => { if (value) enabled.add(chatId); else enabled.delete(chatId); return { ok: true } },
    'groupTopics.analyze': () => ({ ok: true, count: 0, analyzedCount: 0 })
  }))
  dom.document.documentElement.dataset ??= {}
  const view = ui.mount(ui.appScene(api))
  try {
    await until(() => view.container.textContent.includes('總覽議題0'), { message: 'overview shown' })
    const select = walk(view.container).find((element) => element.localName === 'select' && hasClassName(element.parentNode, 'group-topics-group-select'))
    assert.ok(select, 'the group picker is there')
    reactProps(select).onChange({ target: { value: 'ov-group-1' } })
    await until(() => log.some((entry) => entry.path === 'groupTopics.list' && entry.args[0] === 'ov-group-1') && view.container.textContent.includes('啟用此群組議題分析'), { message: 'single-group detail loads with the per-group requests' })
    const enable = walk(view.container).find((element) => element.localName === 'input' && element.getAttribute('type') === 'checkbox' && hasClassName(element.parentNode.parentNode, 'group-topics-controls'))
    reactProps(enable).onChange({ target: { checked: true } })
    await until(() => log.some((entry) => entry.path === 'groupTopics.setEnabled' && entry.args[1] === true), { message: 'enable switch calls setEnabled' })
    const analyze = () => walk(view.container).find((element) => element.localName === 'button' && element.textContent.trim() === '分析最近群組訊息')
    await until(() => analyze() && !analyze().hasAttribute('disabled'), { message: 'analyze button is available once enabled' })
    reactProps(analyze()).onClick()
    await until(() => log.some((entry) => entry.path === 'groupTopics.analyze'), { message: 'analyze runs' })
    const before = log.filter((entry) => entry.path === 'groupTopics.overview').length
    reactProps(select).onChange({ target: { value: '__all_groups__' } })
    await until(() => log.filter((entry) => entry.path === 'groupTopics.overview').length === before + 1, { message: 'back to all groups re-reads the aggregate' })
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
    assert.equal(view.container.textContent.includes('目前沒有可用群組'), false, 'error and empty sentence never together')
    assert.equal(view.container.textContent.includes('正在彙整'), false, 'not stuck on loading')
  } finally { view.unmount(); api.dispose() }
})

test('L2/I2 overview: back from a single group the overview shows loading (not the previous error or stale groups) until the new read lands', async () => {
  const log = []
  let calls = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const api = groupTopicsApi(log, {
    'groupTopics.overview': () => { calls += 1; if (calls === 1) return overviewRows(); if (calls === 2) return Promise.reject(new Error('second read failed')); return gate.then(() => overviewRows()) },
    'groupTopics.list': () => ({ ok: false, topics: [] }),
    'groupTopics.crossChatEnabled': () => false,
    'groupTopics.linkCandidates': () => [],
    'groupTopics.pendingCount': () => 0
  }, { onRun: () => undefined })
  dom.document.documentElement.dataset ??= {}
  const view = ui.mount(ui.groupTopicsScene(api))
  const select = () => walk(view.container).find((element) => element.localName === 'select' && hasClassName(element.parentNode, 'group-topics-group-select'))
  try {
    await until(() => view.container.textContent.includes('總覽議題0'), { message: 'first read shown' })
    reactProps(select()).onChange({ target: { value: 'ov-group-1' } })
    await until(() => view.container.textContent.includes('啟用此群組議題分析'), { message: 'single-group detail' })
    reactProps(select()).onChange({ target: { value: '__all_groups__' } })
    await until(() => view.container.textContent.includes('second read failed'), { message: 'second read fails and the error is shown' })
    reactProps(select()).onChange({ target: { value: 'ov-group-1' } })
    await until(() => view.container.textContent.includes('啟用此群組議題分析'), { message: 'single-group detail again' })
    reactProps(select()).onChange({ target: { value: '__all_groups__' } })
    await until(() => calls === 3, { timeout: 5000, message: 'third read pending behind the 2 s spacing' })
    const text = view.container.textContent
    assert.ok(text.includes('正在彙整'), 'loading shown while the new read is pending')
    assert.equal(text.includes('second read failed'), false, 'old error cleared on return')
    assert.equal(text.includes('總覽議題0'), false, 'stale groups hidden while loading')
    release()
    await until(() => view.container.textContent.includes('總覽議題0'), { message: 'new read lands' })
  } finally { release(); view.unmount(); api.dispose() }
})

test('M1 overview UI: trimmed rows say so, how many topics are shown out of the total and that text was shortened', async () => {
  const log = []
  const rows = overviewRows()
  rows[0] = { ...rows[0], topicCount: 31, compacted: true }
  const api = groupTopicsApi(log, { 'groupTopics.overview': () => rows })
  dom.document.documentElement.dataset ??= {}
  const view = ui.mount(ui.groupTopicsScene(api))
  try {
    await until(() => view.container.textContent.includes('總覽議題0'), { message: 'overview shown' })
    const text = view.container.textContent
    assert.ok(text.includes('只顯示最近 1 項（共 31 項）'), 'shown / total hint')
    assert.ok(text.includes('已縮短'), 'compaction hint')
    assert.equal(text.split('只顯示最近').length - 1, 1, 'only the trimmed group carries the hint')
  } finally { view.unmount(); api.dispose() }
})

// ───────────── Phase 4: combined todo+topic wording and switch ─────────────

const buttonTexts = (view) => walk(view.container).filter((element) => element.localName === 'button').map((element) => element.textContent.trim())

test('Phase 4 wording: 立即整理 when the combined switch is on (plugin host); 立即抓取 when it is off or absent', async () => {
  for (const [flag, expected, unexpected] of [[true, '立即整理', '立即抓取'], [false, '立即抓取', '立即整理'], [undefined, '立即抓取', '立即整理']]) {
    const { api } = plugin(settingsHandlers({ 'settings.get': () => ({ ...VIEW, ...(flag === undefined ? {} : { pluginCombinedExtract: flag }) }) }))
    const view = ui.mount(ui.todaySummaryScene(api))
    try {
      await until(() => buttonTexts(view).includes(expected), { message: `the ${expected} button (flag ${flag})` })
      assert.ok(!buttonTexts(view).includes(unexpected))
    } finally { view.unmount(); api.dispose() }
  }
})

test('Phase 4 wording: the review button says it only produces todos when the combined switch is on', async () => {
  for (const flag of [true, false]) {
    const { api } = plugin(settingsHandlers({ 'settings.get': () => ({ ...VIEW, pluginCombinedExtract: flag }), 'pipeline.status': () => ({ hasApiKey: true }) }))
    const view = ui.mount(ui.reviewControlsScene(api, { onRefresh: async () => true, pollDelayMs: () => 60_000 }))
    try {
      const review = () => walk(view.container).find((element) => element.localName === 'button' && element.textContent.includes('回顧最近'))
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
    'groupTopics.crossChatEnabled': () => false,
    'groupTopics.linkCandidates': () => [],
    'groupTopics.pendingCount': () => state.pending,
    'groupTopics.analyze': () => ({ ok: true, count: 0, analyzedCount: 3 })
  }))
  dom.document.documentElement.dataset ??= {}
  const view = ui.mount(ui.appScene(api))
  try {
    await until(() => view.container.textContent.includes('總覽議題0'), { message: 'overview shown' })
    const select = walk(view.container).find((element) => element.localName === 'select' && hasClassName(element.parentNode, 'group-topics-group-select'))
    reactProps(select).onChange({ target: { value: 'ov-group-0' } })
    await until(() => buttonTexts(view).includes('補分析舊訊息'), { message: 'combined mode: backfill button with 3 old messages' })
    assert.ok(!buttonTexts(view).includes('分析最近群組訊息'))
    assert.ok(view.container.textContent.includes('有 3 則舊訊息尚未分析議題'))
    const backfill = () => walk(view.container).find((element) => element.localName === 'button' && element.textContent.trim() === '補分析舊訊息')
    reactProps(backfill()).onClick()
    await until(() => log.some((entry) => entry.path === 'groupTopics.analyze'), { message: 'the backfill calls groupTopics.analyze' })
  } finally { view.unmount(); api.dispose() }

  state.pending = 0
  const quiet = plugin(overviewHandlers([], {
    'groupTopics.list': (chatId) => ({ ok: enabled.has(chatId), topics: [], combined: true }),
    'groupTopics.crossChatEnabled': () => false,
    'groupTopics.linkCandidates': () => [],
    'groupTopics.pendingCount': () => 0
  }))
  const view2 = ui.mount(ui.appScene(quiet.api))
  try {
    await until(() => view2.container.textContent.includes('總覽議題0'), { message: 'overview shown (second mount)' })
    const select = walk(view2.container).find((element) => element.localName === 'select' && hasClassName(element.parentNode, 'group-topics-group-select'))
    reactProps(select).onChange({ target: { value: 'ov-group-0' } })
    await until(() => view2.container.textContent.includes('沒有需要補分析的舊訊息'), { message: 'nothing to backfill' })
    assert.ok(!buttonTexts(view2).includes('補分析舊訊息'), 'no old messages: the backfill button is hidden')
    assert.ok(!buttonTexts(view2).includes('分析最近群組訊息'), 'and the legacy button does not come back')
  } finally { view2.unmount(); quiet.api.dispose() }
})
