// Chat composer (pro): the REAL production MessageStream → ChatComposer, mounted with the REAL react-dom/client (fixtures/mini-dom.mjs), calling the
// REAL plugin adapter (createPluginLineTodoApi → PluginTransport) through the Core gate stand-in into the REAL Dispatcher and LineJsOutboundService.
// Only the LINEJS client (SDK), the session port and the local LINE account are stand-ins: this is a mock host, not an installed TeamUQ host,
// and nothing is sent to LINE.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import zlib from 'node:zlib'
import test from 'node:test'
import { build } from 'esbuild'

import { byAttr, install, reactProps, walk } from './fixtures/mini-dom.mjs'
import { createCoreGateStandin } from '../lib/core-invoke-gate-standin.mjs'
import { ROOT } from './build-ui.mjs'
import { LineJsOutboundService } from '../../src/plugin/backend/linejsOutbound.ts'
import { LineJsMediaService } from '../../src/plugin/backend/linejsMedia.ts'
import { Dispatcher } from '../../src/plugin/backend/dispatcher.ts'
import { EventHub } from '../../src/plugin/backend/eventHub.ts'
import { detectSupportedImageMime } from '../../src/plugin/backend/linejsAutoDownload.mjs'

const dom = install() // before react-dom loads
const work = mkdtempSync(join(tmpdir(), 'chat-composer-ui-'))
test.after(() => { rmSync(work, { recursive: true, force: true }); dom.restore() })
const outfile = join(work, 'chat-composer.mjs')
await build({
  entryPoints: [resolve(ROOT, 'scripts', 'plugin', 'fixtures', 'chat-composer-entry.tsx')],
  outfile, bundle: true, format: 'esm', platform: 'node', target: 'node24', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty' }, logLevel: 'error', absWorkingDir: ROOT,
  banner: { js: "import { createRequire as __r } from 'node:module'; const require = __r(import.meta.url);" }
})
const ui = await import(pathToFileURL(outfile).href)

const OWNER = 'uOWNERMID0001'
const PEER = 'uPEERMID00001'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(predicate, { timeout = 30_000, message = 'condition' } = {}) {
  const t0 = Date.now()
  while (!predicate()) {
    if (Date.now() - t0 > timeout) assert.fail(`timed out waiting for ${message}`)
    await sleep(5)
  }
}

function png(width = 160, height = 140) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii')
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0, 0)
    return Buffer.concat([head, data, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let i = 0; i < rows.length; i++) rows[i] = (i * 7 + (i >> 7)) & 0xff
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows, { level: 0 })), chunk('IEND', Buffer.alloc(0))])
}

function sessionStub() {
  const listeners = new Set()
  const s = {
    client: null, sessionId: null,
    install(client) { s.client = client; s.sessionId = randomUUID(); for (const l of listeners) l(s.sessionId) },
    clear() { s.client = null; s.sessionId = null; for (const l of listeners) l(null) },
    restoring: false,
    async outboundPeek() {
      if (s.restoring && !s.client) return { state: 'restoring', sessionId: null, ownerMid: null }
      return s.client ? { state: 'ready', sessionId: s.sessionId, ownerMid: OWNER } : { state: 'not_logged_in', sessionId: null, ownerMid: null }
    },
    async outboundSession() { return s.client ? { client: s.client, sessionId: s.sessionId, ownerMid: OWNER } : null },
    currentSessionId() { return s.sessionId },
    isCurrentSession(id, client) { return s.sessionId !== null && s.sessionId === id && s.client === client },
    onSessionChange(listener) { listeners.add(listener); return () => listeners.delete(listener) }
  }
  return s
}

function sdkClient(behave = {}) {
  const calls = []
  let n = 0
  return {
    calls,
    base: {
      profile: { mid: OWNER },
      talk: { async sendMessage(options) { calls.push({ method: 'sendMessage', options }); return behave.text ? behave.text(options) : { id: `line-msg-${++n}` } } },
      obs: { async uploadMediaByE2EE(options) { calls.push({ method: 'uploadMediaByE2EE', options, bytes: Buffer.from(await options.data.arrayBuffer()), type: options.data.type }); return { id: `line-msg-${++n}` } } }
    }
  }
}

/**
 * stand-in for the real LineJsMediaService login surface (linejsMedia.status / startLogin / cancelLogin) that the Dispatcher forwards to.
 * Semantics kept from the real service: startLogin while a login is pending answers pending (no second login); cancel leaves nothing pending;
 * a finished login installs the session (the same session the outbound service reads). The QR is a stand-in data URL.
 */
const QR = 'data:image/png;base64,UVI='
function loginStub(session, client) {
  const media = { calls: [], pending: false, view: { status: 'idle' } }
  const current = () => (session.client ? { status: 'authenticated' } : media.view)
  const snapshot = () => ({ available: true, login: current(), receiver: 'disabled', downloads: { pending: 0, active: 0, completed: 0, failed: 0, recent: [] } })
  media.status = async () => { media.calls.push('linejsMedia.status'); return snapshot() }
  media.startLogin = async () => {
    media.calls.push('linejsMedia.startLogin')
    if (session.client) return { status: 'authenticated' }
    if (media.refuseStart) return { status: 'idle' }
    if (media.pending) return { status: 'pending', joined: true }
    media.pending = true
    media.view = { status: 'pending', qr: QR }
    return { status: 'pending' }
  }
  media.cancelLogin = async () => {
    media.calls.push('linejsMedia.cancelLogin')
    if (media.committing) media.cancelledDuringCommit = true
    media.pending = false
    media.view = { status: 'cancelled' }
    return snapshot()
  }
  media.logout = async () => {
    media.calls.push('linejsMedia.logout')
    media.pending = false
    media.view = { status: 'idle' }
    session.clear()
    return snapshot()
  }
  /** the user scanned the QR: the login commits (session installed), nothing pending */
  media.succeed = () => { media.pending = false; session.install(client) }
  media.fail = (message) => { media.pending = false; media.view = { status: 'failed', error: { code: 'LOGIN_FAILED', message } } }
  /** the phone confirmed and the backend is committing the session file: outboundPeek answers restoring, the login is still pending */
  media.beginCommit = () => { media.committing = true; session.restoring = true }
  /** the commit finished: like the real fencing, a cancel that landed during the commit discards the session */
  media.finishCommit = () => {
    media.committing = false
    session.restoring = false
    if (media.cancelledDuringCommit) return
    media.succeed()
  }
  /** the settings page started this login (the chat dialog may only join it) */
  media.startedElsewhere = () => { media.calls.push('settings.startLogin'); media.pending = true; media.view = { status: 'pending', qr: QR } }
  return media
}

/** the real outbound backend (Dispatcher + LineJsOutboundService, temp dataDir) behind scripted handlers for everything else the chat page reads */
async function scene(t, { chat = { chatId: PEER, name: '王小明', isGroup: false }, behave, login = true, intercept, withControl = true, withLogin = true, restoring = false, realLogin, app, imageRow = false, timeouts } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'chat-composer-backend-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const client = sdkClient(behave)
  let session
  let media
  if (realLogin) {
    // the REAL LineJsMediaService is both the login surface and the outbound session; only its LINEJS adapters are stand-ins
    if (realLogin.staleToken) { await mkdir(dataDir, { recursive: true }); await writeFile(join(dataDir, 'linejs-session.json'), JSON.stringify({ 'linejs-auth-token': realLogin.staleToken })) }
    const real = await LineJsMediaService.create(dataDir, realLogin.adapters)
    const calls = []
    media = new Proxy(real, { get(target, prop) { const v = target[prop]; if (typeof v !== 'function') return v; return (...a) => { if (['status', 'startLogin', 'cancelLogin', 'logout'].includes(prop)) calls.push(`linejsMedia.${String(prop)}`); return v.apply(target, a) } } })
    media.calls = calls
    session = real
    t.after(() => real.dispose())
  } else {
    session = sessionStub()
    session.restoring = restoring
    if (login) session.install(client)
    media = loginStub(session, client)
  }
  const env = { localMid: OWNER }
  const service = new LineJsOutboundService({
    dataDir, session, localAccountMid: async () => env.localMid, chatKnown: async (id) => id === chat.chatId, imageSniff: (bytes) => detectSupportedImageMime(bytes)
  })
  await service.init()
  const hub = new EventHub()
  const dispatcher = new Dispatcher({ getApi: () => ({}), hub, queue: {}, info: () => ({}), linejsOutbound: service, linejsMedia: media })
  const dto = { ...chat, firstSeenAt: '2026-11-12T01:00:00.000Z', lastSeenAt: '2026-11-12T02:00:00.000Z' }
  const rows = [0, 1].map((i) => ({
    msgId: `m-${i}`, chatId: chat.chatId, ts: Date.UTC(2026, 10, 12, 1, i), timeIso: new Date(Date.UTC(2026, 10, 12, 1, i)).toISOString(), direction: i ? 'out' : 'in', sender: chat.name,
    text: `既有訊息 ${i}`, contentType: 0, processed: true, ingestedAt: '2026-11-12T01:00:00.000Z', origFilename: null, fileSize: null, unsent: false
  }))
  // an incoming photo whose media is not on this machine (media.prepare has no handler → the image is "not downloaded")
  if (imageRow) rows.push({ msgId: 'i:photo-missing', chatId: chat.chatId, ts: Date.UTC(2026, 10, 12, 1, 5), timeIso: new Date(Date.UTC(2026, 10, 12, 1, 5)).toISOString(), direction: 'in', sender: chat.name, text: '[photo]', contentType: 1, processed: true, ingestedAt: '2026-11-12T01:05:00.000Z', origFilename: null, fileSize: null, unsent: false })
  const handlers = {
    'db.chats.list': () => [dto], 'db.messages.list': () => [], 'db.messages.recentByChat': () => rows, 'messages.recent': () => [],
    'line.status': () => ({ state: 'stopped', lastMessageAt: null, messageCount: rows.length, lastError: null, restarts: 0 }),
    'media.avatar.prepareChats': () => ({ paths: {}, names: {} }), 'media.avatar.prepareMessages': () => ({ paths: {}, names: {} }),
    'settings.chatPrompt.list': () => ({ items: [] }), 'groupTopics.list': () => ({ ok: true, topics: [] }), 'groupTopics.pendingCount': () => 0,
    'db.chats.listPrefs': () => ({ prefsReady: true, topicsAvailable: true, pinned: [], hidden: [], todoOff: [], topicsOn: [] }),
    'db.chats.todoExtractEnabled': () => true, 'db.todos.openByChat': () => []
  }
  const outboundCalls = []
  const backend = {
    async call(method, params) {
      if (String(params?.path).startsWith('linejsOutbound.')) { outboundCalls.push(params.path); return dispatcher.call(method, params) }
      if (String(params?.path).startsWith('linejsMedia.')) return dispatcher.call(method, params)
      const handler = handlers[params?.path]
      if (!handler) return { ok: false, code: 'path_unknown', message: params?.path }
      return { ok: true, value: await handler(...(params.args ?? [])) }
    }
  }
  const core = createCoreGateStandin(backend, { methods: [...ui.BACKEND_METHOD_GROUPS] })
  const forward = (method, params) => core.host.backend.call(method, params)
  const host = { ...core.host, backend: { call: (method, params) => (intercept ? intercept(method, params, () => forward(method, params)) : forward(method, params)) } }
  const api = ui.createPluginLineTodoApi({ host, events: { enabled: false }, busyRetry: { attempts: 0 }, ...(timeouts ? { timeouts } : {}) })
  const sceneApi = withControl ? { ...api, linejsMedia: withLogin ? api.linejsMedia : undefined } : { ...api, linejsOutbound: undefined }
  if (app) dom.document.documentElement.dataset ??= {} // the App applies its theme to <html data-theme> (same set-up as test-plugin-ui-effects.mjs)
  const view = ui.mount(app ? ui.appScene(sceneApi, app.storage) : ui.messageStreamScene(sceneApi))
  t.after(async () => { view.unmount(); api.dispose(); dispatcher.dispose(); hub.dispose(); await service.dispose() })
  const el = (id) => byAttr(view.container, 'data-testid', id)
  const props = (id) => reactProps(el(id))
  const text = () => el('chat-composer-status')?.textContent ?? ''
  /** status answered: the composer is idle (ready to send) */
  const ready = () => el('chat-composer')?.getAttribute('data-phase') === 'idle' && reactProps(el('chat-composer-input')).disabled === false
  /** type, then wait until React has committed the controlled value (handlers read the draft from the committed render) */
  const type = async (value) => {
    props('chat-composer-input').onChange({ target: { value } })
    await until(() => props('chat-composer-input').value === value, { message: `draft "${value}" committed` })
  }
  const ctrlEnter = (extra = {}) => props('chat-composer-input').onKeyDown({ key: 'Enter', ctrlKey: true, metaKey: false, keyCode: 13, nativeEvent: { isComposing: false }, preventDefault() {}, ...extra })
  const pick = (file) => props('chat-composer-file').onChange({ target: { files: [file], value: 'C:\\fakepath\\x' } })
  return { view, api, client, session, env, service, el, props, text, ready, type, ctrlEnter, pick, outboundCalls, core, forward, media, dataDir }
}

test('text: typing then Ctrl+Enter sends exactly once through UI → pluginApi → gate → Dispatcher → service → SDK; the status says LINE accepted it and the draft clears', async (t) => {
  const s = await scene(t)
  await until(s.ready, { message: 'the live composer is ready' })
  assert.equal(s.el('chat-composer-status'), null, 'idle shows no status line')
  assert.equal(s.props('chat-composer-send').disabled, true, 'nothing to send yet')
  await s.type('明天下午三點見')
  await until(() => s.props('chat-composer-send').disabled === false, { message: 'send enabled after typing' })
  s.props('chat-composer-input').onKeyDown({ key: 'Enter', ctrlKey: false, metaKey: false, keyCode: 13, nativeEvent: { isComposing: false }, preventDefault() {} })
  s.ctrlEnter({ nativeEvent: { isComposing: true } })
  s.ctrlEnter({ keyCode: 229 })
  await sleep(50)
  assert.equal(s.client.calls.length, 0, 'plain Enter is a newline; Ctrl+Enter while composing (IME) does nothing')
  // a burst: Ctrl+Enter, then two clicks in the same tick
  s.ctrlEnter()
  s.props('chat-composer-send').onClick()
  s.props('chat-composer-send').onClick()
  await until(() => s.text().includes('已送出'), { message: 'sent' })
  assert.equal(s.text(), '已送出（LINE 已接受；不代表對方已讀）')
  assert.equal(s.client.calls.length, 1, 'one SDK call for the burst')
  assert.deepEqual(s.client.calls[0].options, { to: PEER, text: '明天下午三點見', e2ee: true })
  await until(() => s.props('chat-composer-input').value === '', { message: 'the draft is cleared after a send' })
  assert.equal(s.outboundCalls.filter((p) => p === 'linejsOutbound.send').length, 1)
  assert.ok(s.el('chat-composer-details'), 'details are available on demand')
  assert.ok(s.el('chat-composer-details').textContent.includes('line-msg-1'), 'the SDK message id is behind 詳細')
  await s.type('下一則')
  await until(() => s.el('chat-composer-status') === null, { message: 'editing again hides the sent notice' })
})

test('image: picking a PNG shows a chip, disables the text box (attachments carry no text), stages it in chunks and sends the exact bytes as an image', async (t) => {
  const s = await scene(t)
  await until(s.ready, { message: 'ready' })
  const image = png()
  await s.type('這段文字不會跟圖片一起送')
  s.pick(new File([image], '照片.png', { type: 'image/png' }))
  await until(() => s.el('chat-composer-chip'), { message: 'chip' })
  assert.ok(s.el('chat-composer-chip').textContent.includes('照片.png'))
  assert.equal(s.props('chat-composer-input').disabled, true)
  assert.equal(s.props('chat-composer-input').placeholder, '附件不附帶文字')
  s.props('chat-composer-send').onClick()
  await until(() => s.text().includes('已送出'), { message: 'image sent' })
  assert.equal(s.client.calls.length, 1)
  const call = s.client.calls[0]
  assert.equal(call.method, 'uploadMediaByE2EE')
  assert.equal(call.options.oType, 'image')
  assert.equal(call.options.to, PEER)
  assert.equal(call.type, 'image/png')
  assert.ok(call.bytes.equals(image), 'the staged bytes are the picked file')
  assert.ok(s.outboundCalls.filter((p) => p === 'linejsOutbound.stageChunk').length >= 3, 'staged in ≥3 chunks of 32 KiB')
  await until(() => s.el('chat-composer-chip') === null, { message: 'chip removed after the send' })
  assert.equal(s.props('chat-composer-input').value, '這段文字不會跟圖片一起送', 'the separate text draft is kept')
})

test('file: a PDF goes out as a file with its name; an empty file is refused at pick time without any backend call', async (t) => {
  const s = await scene(t)
  await until(s.ready, { message: 'ready' })
  s.pick(new File([], 'empty.txt', { type: 'text/plain' }))
  await until(() => s.text().includes('無法附加'), { message: 'empty file notice' })
  assert.equal(s.text(), '無法附加：檔案是空的')
  const pdf = Buffer.from('%PDF-1.4\n' + 'x'.repeat(5000))
  s.pick(new File([pdf], 'report.pdf', { type: 'application/pdf' }))
  await until(() => s.el('chat-composer-chip'), { message: 'chip' })
  s.props('chat-composer-send').onClick()
  await until(() => s.text().includes('已送出'), { message: 'file sent' })
  const call = s.client.calls[0]
  assert.equal(call.options.oType, 'file')
  assert.equal(call.options.filename, 'report.pdf')
  assert.ok(call.bytes.equals(pdf))
})

test('unknown result: a role=alert warning, the chat is locked (no input, attach or send), never re-sent; "我已確認" unlocks it', async (t) => {
  let throwIt = true
  const s = await scene(t, { behave: { text: () => { if (throwIt) throw new TypeError('fetch failed'); return { id: 'later' } } } })
  await until(s.ready, { message: 'ready' })
  await s.type('可能已送出')
  s.props('chat-composer-send').onClick()
  await until(() => s.el('chat-composer-unknown'), { message: 'unknown alert' })
  const alert = s.el('chat-composer-unknown')
  assert.equal(alert.getAttribute('role'), 'alert')
  assert.ok(alert.textContent.includes('無法確認是否已送出'))
  assert.ok(alert.textContent.includes('確認前不會自動重送，也無法在此聊天室再次傳送'))
  assert.equal(s.props('chat-composer-input').disabled, true)
  assert.equal(s.props('chat-composer-send').disabled, true)
  assert.equal(s.props('chat-composer-attach').disabled, true)
  const composerText = s.el('chat-composer').textContent
  assert.ok(!composerText.includes('傳送失敗') && !composerText.includes('LINE 已接受'), 'unknown is shown as neither failure nor success')
  throwIt = false
  await sleep(1200)
  assert.equal(s.client.calls.length, 1, 'no automatic re-send')
  s.props('chat-composer-ack').onClick()
  await until(() => s.el('chat-composer-unknown') === null && s.props('chat-composer-input').disabled === false, { message: 'unlocked after 我已確認' })
  assert.equal(s.props('chat-composer-input').value, '可能已送出', 'the draft is still there to decide on')
  assert.equal(s.outboundCalls.filter((p) => p === 'linejsOutbound.acknowledge').length, 1)
})

test('states: not logged in, LINEJS account ≠ local LINE account, and room/Square chats are explained and cannot send', async (t) => {
  const loggedOut = await scene(t, { login: false })
  await until(() => loggedOut.el('chat-composer-login') !== null, { message: 'needs login: 登入 LINE button' })
  assert.equal(loggedOut.el('chat-composer-status'), null, 'the text hint is replaced by the button')
  await loggedOut.type('先打草稿')
  await sleep(20)
  assert.equal(loggedOut.props('chat-composer-send').disabled, true, 'drafting is allowed, sending is not')

  const mismatch = await scene(t)
  mismatch.env.localMid = 'uSOMEONEELSE1'
  await until(() => mismatch.text().includes('帳號'), { message: 'account mismatch' })
  assert.equal(mismatch.text(), '登入的 LINE 帳號與目前讀取的 LINE 不同，無法傳送')
  assert.equal(mismatch.props('chat-composer-input').disabled, true)

  const room = await scene(t, { chat: { chatId: 'rROOMMID0001', name: '多人聊天', isGroup: true } })
  await until(() => room.text().includes('不支援'), { message: 'unsupported chat' })
  assert.equal(room.text(), '此聊天室不支援傳送')
  assert.equal(room.outboundCalls.length, 0, 'an unsupported chat makes no outbound call')
})

test('a send rejected on the backend (account changed after the chat opened) reads as failed with the draft kept, then the composer shows why', async (t) => {
  const s = await scene(t)
  await until(s.ready, { message: 'ready' })
  await s.type('保留我')
  s.env.localMid = 'uSOMEONEELSE1'
  s.props('chat-composer-send').onClick()
  await until(() => s.text().includes('無法傳送') || s.text().includes('傳送失敗'), { message: 'rejected' })
  await until(() => s.text() === '登入的 LINE 帳號與目前讀取的 LINE 不同，無法傳送', { message: 'status refreshed after the session/account rejection' })
  assert.equal(s.props('chat-composer-input').value, '保留我')
  assert.equal(s.client.calls.length, 0)
})

test('transport uncertainty: a send whose answer is lost is resolved by the fence query — processed → follows to 已送出; never arrived → 未送出, and a late copy is refused', async (t) => {
  let mode = 'crash-after'
  let lost = null
  const intercept = async (method, params, forward) => {
    if (params?.path !== 'linejsOutbound.send') return forward()
    if (mode === 'crash-after') { await forward(); throw new Error('plugin_backend_crashed') }
    lost = params
    throw new Error('plugin_backend_crashed')
  }
  const s = await scene(t, { intercept })
  await until(s.ready, { message: 'ready' })
  await s.type('第一則')
  s.props('chat-composer-send').onClick()
  await until(() => s.text().includes('已送出'), { message: 'processed send found by the fence query' })
  assert.equal(s.client.calls.length, 1)

  mode = 'drop'
  await s.type('第二則')
  s.props('chat-composer-send').onClick()
  await until(() => s.text().includes('傳送失敗'), { message: 'never-arrived send' })
  assert.equal(s.text(), '傳送失敗：傳送請求沒有送達（草稿已保留）')
  assert.equal(s.props('chat-composer-input').value, '第二則')
  const late = await s.forward('linejsOutbound', lost)
  assert.equal(late.code, 'REQUEST_FENCED', 'the lost request can never be sent afterwards')
  assert.equal(s.client.calls.length, 1)
})

test('a send the backend already took (running) whose record is later lost reads as 無法確認 (locked), never as 傳送失敗', async (t) => {
  const s = await scene(t, { behave: { text: () => new Promise(() => {}) } }) // the SDK call is in flight and never answers
  await until(s.ready, { message: 'ready' })
  await s.type('可能已送出的文字')
  s.props('chat-composer-send').onClick()
  await until(() => s.client.calls.length === 1, { message: 'the SDK was called (job running)' })
  // backend restart with an unreadable / deleted journal: the running record is gone, a plain job query answers not_received
  s.service.records.clear()
  await until(() => ['unknown', 'failed', 'sent'].includes(s.el('chat-composer')?.getAttribute('data-phase')), { message: 'the followed send settles' })
  assert.equal(s.el('chat-composer').getAttribute('data-phase'), 'unknown', 'lost record → unknown')
  assert.ok(s.el('chat-composer-unknown'), 'role=alert warning shown')
  const composerText = s.el('chat-composer').textContent
  assert.ok(!composerText.includes('傳送失敗'), 'a lost record is not a send failure (LINE may have the message)')
  assert.ok(s.el('chat-composer-details').textContent.includes('RECORD_LOST'))
  assert.equal(s.props('chat-composer-send').disabled, true, 'the chat is locked until 我已確認')
  assert.equal(s.outboundCalls.filter((p) => p === 'linejsOutbound.send').length, 1, 'never re-sent')
  s.props('chat-composer-ack').onClick()
  await until(() => s.el('chat-composer-unknown') === null && s.props('chat-composer-input').disabled === false, { message: 'unlocked after 我已確認' })
  assert.equal(s.props('chat-composer-input').value, '可能已送出的文字', 'the draft is still there to decide on')
})

test('a refused pick does not hide the result of a later text send: 已送出 and 傳送失敗 replace the 無法附加 notice', async (t) => {
  const ok = await scene(t)
  await until(ok.ready, { message: 'ready' })
  ok.pick(new File([], 'empty.txt', { type: 'text/plain' }))
  await until(() => ok.text() === '無法附加：檔案是空的', { message: 'pick error shown' })
  await ok.type('一般文字')
  ok.ctrlEnter()
  await until(() => ok.el('chat-composer')?.getAttribute('data-phase') === 'sent', { message: 'sent' })
  assert.equal(ok.text(), '已送出（LINE 已接受；不代表對方已讀）', 'status shows 已送出, not the stale pick error')

  const rejected = await scene(t, { behave: { text: () => { const e = new Error('x'); e.name = 'RequestError'; throw e } } })
  await until(rejected.ready, { message: 'ready' })
  rejected.pick(new File([], 'empty.txt', { type: 'text/plain' }))
  await until(() => rejected.text() === '無法附加：檔案是空的', { message: 'pick error shown' })
  await rejected.type('會失敗的文字')
  rejected.props('chat-composer-send').onClick()
  await until(() => rejected.el('chat-composer')?.getAttribute('data-phase') === 'failed', { message: 'failed' })
  assert.ok(rejected.text().startsWith('傳送失敗'), `status shows 傳送失敗, not the stale pick error: ${rejected.text()}`)
  assert.equal(rejected.props('chat-composer-input').value, '會失敗的文字', 'the draft is kept')
})

test('without the outbound control (standalone / gate off) there is no composer and, in Pro, no 發送・進階 purchase prompt; no outbound call is made', async (t) => {
  // main 55756d6 removed the disabled placeholder composer; with the outbound control the pro chat shows the live ChatComposer instead.
  const s = await scene(t, { withControl: false })
  const find = () => walk(s.view.container).find((e) => (e.getAttribute('class') ?? '').split(/\s+/).includes('chat-message-composer'))
  await until(() => s.view.container.textContent.includes('既有訊息 1'), { message: 'chat shown' })
  await sleep(50)
  assert.equal(find(), undefined, 'no composer row without the outbound control')
  assert.equal(s.el('chat-composer'), null)
  assert.equal(walk(s.view.container).some((e) => e.localName === 'button' && e.textContent.trim() === '發送・進階'), false, 'Pro shows no purchase prompt')
  assert.deepEqual(s.outboundCalls, [])
})

// ── D7: Pro shows no purchase prompts (the free edition's 購買 tab, image 進階 prompt, 發送・進階) ──

const appTabs = (s) => walk(s.view.container).filter((e) => e.localName === 'button' && (e.getAttribute('class') ?? '').split(/\s+/).includes('tab') && (e.parentNode?.getAttribute?.('class') ?? '').split(/\s+/).includes('app-tabs')).map((e) => e.textContent.trim())
function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed))
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)) }, removeItem: (k) => { map.delete(k) } }
}

test('D7: the Pro app has no 購買 tab, and a saved 購買 tab opens the 總覽 board instead of a purchase page', async (t) => {
  const storage = memoryStorage({ 'lt-ui:app.tab': JSON.stringify({ v: 'purchase', at: Date.now() }) })
  const s = await scene(t, { app: { storage } })
  await until(() => appTabs(s).length > 0, { message: 'app tabs' })
  assert.deepEqual(appTabs(s), ['總覽', '聊天', '群組議題', '設定'], 'no 購買 tab in Pro')
  const active = walk(s.view.container).find((e) => e.localName === 'button' && (e.getAttribute('class') ?? '').split(/\s+/).includes('active') && (e.parentNode?.getAttribute?.('class') ?? '').includes('app-tabs'))
  assert.equal(active?.textContent.trim(), '總覽', 'a saved 購買 tab falls back to the board')
  await sleep(100)
  assert.equal(walk(s.view.container).some((e) => (e.getAttribute('class') ?? '').split(/\s+/).includes('purchase-page')), false, 'no purchase page')
  assert.doesNotMatch(s.view.container.textContent, /購買方案|查看方案|目前尚未開放購買/)
})

test('D7: in the Pro app chat, a photo that is not on this machine reads 尚未下載 with no 進階 / 查看方案 purchase prompt', async (t) => {
  const s = await scene(t, { app: {}, imageRow: true })
  await until(() => appTabs(s).includes('聊天'), { message: 'app tabs' })
  const chatTab = walk(s.view.container).find((e) => e.localName === 'button' && e.textContent.trim() === '聊天' && (e.parentNode?.getAttribute?.('class') ?? '').includes('app-tabs'))
  reactProps(chatTab).onClick()
  await until(() => walk(s.view.container).some((e) => (e.getAttribute('class') ?? '').split(/\s+/).includes('sm-media-missing')), { message: 'the missing photo is rendered' })
  await sleep(100)
  const missing = walk(s.view.container).find((e) => (e.getAttribute('class') ?? '').split(/\s+/).includes('sm-media-missing'))
  assert.equal(missing.textContent, '尚未下載')
  assert.equal(walk(s.view.container).some((e) => (e.getAttribute('class') ?? '').split(/\s+/).some((c) => c === 'advanced-entry' || c === 'advanced-entry-button')), false, 'no 進階 purchase prompt anywhere in the chat')
  assert.doesNotMatch(s.view.container.textContent, /查看方案|發送・進階/)
})

test('with the outbound control the 發送・進階 upsell is not shown: the pro chat already has the live composer', async (t) => {
  const s = await scene(t)
  await until(s.ready, { message: 'the live composer is ready' })
  assert.equal(walk(s.view.container).some((e) => e.localName === 'button' && e.textContent.trim() === '發送・進階'), false)
})

test('needs login shows a 登入 LINE button in place of the text hint; restoring still says 正在連線 LINE… with no button; without the login control the text hint stays', async (t) => {
  const loggedOut = await scene(t, { login: false })
  await until(() => loggedOut.el('chat-composer-login') !== null, { message: 'login button' })
  assert.equal(loggedOut.el('chat-composer-status'), null)
  assert.equal(loggedOut.el('chat-login-dialog'), null, 'the dialog stays closed until the button is pressed')
  assert.deepEqual(loggedOut.media.calls, [], 'showing the button starts no login')

  const restoring = await scene(t, { login: false, restoring: true })
  await until(() => restoring.text() === '正在連線 LINE…', { message: 'restoring status' })
  assert.equal(restoring.el('chat-composer-login'), null, 'no login button while LINE is restoring')

  const bare = await scene(t, { login: false, withLogin: false })
  await until(() => bare.text() === '需先到「設定 › LINE 附件下載」登入 LINE 才能傳送', { message: 'text hint without the login control' })
  assert.equal(bare.el('chat-composer-login'), null)
})

test('the 登入 LINE button opens a dialog that starts the existing login, shows the QR while waiting, and 取消 cancels it with nothing left pending', async (t) => {
  const s = await scene(t, { login: false })
  await until(() => s.el('chat-composer-login') !== null, { message: 'login button' })
  s.props('chat-composer-login').onClick()
  await until(() => s.el('chat-login-qr') !== null, { message: 'QR shown' })
  assert.equal(reactProps(s.el('chat-login-qr')).src, QR)
  assert.ok(s.el('chat-login-waiting'), 'waiting text shown')
  assert.ok(s.media.calls.includes('linejsMedia.startLogin'), 'opening starts the existing linejsMedia login')
  assert.equal(s.media.pending, true)

  s.props('chat-login-cancel').onClick()
  await until(() => s.el('chat-login-dialog') === null, { message: 'dialog closed by 取消' })
  await until(() => s.media.calls.includes('linejsMedia.cancelLogin'), { message: 'cancelLogin called' })
  assert.equal(s.media.pending, false, 'no login left pending')
  assert.equal(s.session.client, null, 'a cancelled login never becomes the session')
  assert.ok(s.el('chat-composer-login'), 'still logged out: the button is back')
})

test('Esc and a click outside close the login dialog the same way (cancel, nothing pending); a click inside or another key keeps it open', async (t) => {
  const s = await scene(t, { login: false })
  await until(() => s.el('chat-composer-login') !== null, { message: 'login button' })
  s.props('chat-composer-login').onClick()
  await until(() => s.el('chat-login-dialog') !== null, { message: 'dialog open' })
  s.props('chat-login-dialog').onClick({ stopPropagation() {} })
  s.props('chat-login-dialog').onKeyDown({ key: 'Enter', preventDefault() {} })
  await sleep(20)
  assert.ok(s.el('chat-login-dialog'), 'a click inside and Enter keep the dialog open')
  assert.equal(s.media.calls.filter((c) => c === 'linejsMedia.cancelLogin').length, 0)

  s.props('chat-login-dialog').onKeyDown({ key: 'Escape', preventDefault() {} })
  await until(() => s.el('chat-login-dialog') === null, { message: 'Esc closes' })
  await until(() => s.media.calls.filter((c) => c === 'linejsMedia.cancelLogin').length === 1, { message: 'Esc cancels once' })
  assert.equal(s.media.pending, false)

  s.props('chat-composer-login').onClick()
  await until(() => s.el('chat-login-dialog') !== null, { message: 'dialog reopened' })
  await until(() => s.el('chat-login-qr') !== null, { message: 'QR shown again' })
  s.props('chat-login-backdrop').onClick()
  await until(() => s.el('chat-login-dialog') === null, { message: 'backdrop click closes' })
  await until(() => s.media.calls.filter((c) => c === 'linejsMedia.cancelLogin').length === 2, { message: 'backdrop cancels once' })
  assert.equal(s.media.pending, false)
  assert.equal(s.session.client, null)
})

test('a failed login shows its message and the dialog stays open; 重試 starts the login again and shows a new QR', async (t) => {
  const s = await scene(t, { login: false })
  await until(() => s.el('chat-composer-login') !== null, { message: 'login button' })
  s.props('chat-composer-login').onClick()
  await until(() => s.el('chat-login-qr') !== null, { message: 'QR shown' })
  s.media.fail('LINE 登入逾時，請重新開始。')
  await until(() => s.el('chat-login-error') !== null, { message: 'failure shown' })
  assert.equal(s.el('chat-login-error').textContent, 'LINE 登入逾時，請重新開始。')
  assert.ok(s.el('chat-login-dialog'), 'the dialog stays open on failure')

  s.props('chat-login-retry').onClick()
  await until(() => s.el('chat-login-qr') !== null, { message: 'retry shows a QR' })
  assert.equal(s.media.calls.filter((c) => c === 'linejsMedia.startLogin').length, 2, 'retry starts the login again')
  assert.equal(s.el('chat-login-error'), null)
})

test('a successful login closes the dialog by itself and the composer becomes sendable without a remount (the draft survives, the send goes out)', async (t) => {
  const s = await scene(t, { login: false })
  await until(() => s.el('chat-composer-login') !== null, { message: 'login button' })
  s.props('chat-composer-login').onClick()
  await until(() => s.el('chat-login-qr') !== null, { message: 'QR shown' })
  await s.type('登入前寫的草稿')
  s.media.succeed()
  await until(() => s.el('chat-login-dialog') === null, { message: 'dialog closes on success' })
  await until(() => s.ready(), { message: 'composer ready (idle)' })
  assert.equal(s.el('chat-composer-login'), null, 'the login button is gone')
  assert.equal(s.props('chat-composer-input').value, '登入前寫的草稿', 'the draft survived the login (no remount)')
  assert.equal(s.media.pending, false)

  await s.type('登入後送出')
  s.ctrlEnter()
  await until(() => s.el('chat-composer')?.getAttribute('data-phase') === 'sent', { message: 'sent after login' })
  assert.equal(s.client.calls.length, 1, 'exactly one send went to LINE')
  assert.equal(s.client.calls[0].options.text, '登入後送出')
})

test('leaving the chat while a login is pending (unmount) cancels it: nothing stays pending and nothing is committed', async (t) => {
  const s = await scene(t, { login: false })
  await until(() => s.el('chat-composer-login') !== null, { message: 'login button' })
  s.props('chat-composer-login').onClick()
  await until(() => s.el('chat-login-qr') !== null, { message: 'QR shown' })
  s.view.unmount()
  await until(() => s.media.calls.includes('linejsMedia.cancelLogin'), { message: 'unmount cancels the pending login' })
  assert.equal(s.media.pending, false, 'no login left pending')
  assert.equal(s.session.client, null, 'a login abandoned by leaving the chat never becomes the session')
})

// ── D5: login dialog lifetime, ownership and recovery (REV-CL-001…003, P7) ──

const cancelCount = (s) => s.media.calls.filter((c) => c === 'linejsMedia.cancelLogin').length
const phaseOf = (s) => s.el('chat-composer')?.getAttribute('data-phase')

async function openDialog(s) {
  await until(() => s.el('chat-composer-login') !== null, { timeout: 30_000, message: 'login button' })
  s.props('chat-composer-login').onClick()
  await until(() => s.el('chat-login-dialog') !== null, { message: 'dialog open' })
}

test('REV-CL-001: while the dialog is open, the composer polling restoring or failing transiently, and a failed dialog status call, keep the dialog open and never cancel the login', async (t) => {
  let failOutbound = false
  let failMediaStatus = 0
  const intercept = async (method, params, forward) => {
    if (failOutbound && params?.path === 'linejsOutbound.status') throw new Error('plugin_backend_crashed')
    if (failMediaStatus > 0 && params?.path === 'linejsMedia.status') { failMediaStatus--; throw new Error('plugin_backend_crashed') }
    return forward()
  }
  const s = await scene(t, { login: false, intercept })
  await openDialog(s)
  await until(() => s.el('chat-login-qr') !== null, { message: 'QR shown' })

  s.session.restoring = true
  await until(() => s.text() === '正在連線 LINE…', { timeout: 25_000, message: "the composer's poll answers restoring" })
  await sleep(1200)
  assert.ok(s.el('chat-login-dialog'), 'restoring does not close the dialog')
  assert.ok(s.el('chat-login-qr'), 'the QR stays on screen')
  assert.equal(cancelCount(s), 0, 'restoring never cancels the login')

  s.session.restoring = false
  failOutbound = true
  await until(() => phaseOf(s) === 'unavailable', { timeout: 25_000, message: "the composer's poll fails transiently" })
  await sleep(1200)
  assert.ok(s.el('chat-login-dialog'), 'a transient composer error does not close the dialog')
  assert.equal(cancelCount(s), 0)

  failMediaStatus = 2
  await until(() => s.el('chat-login-poll-error') !== null, { timeout: 5_000, message: 'the dialog shows its own status failure' })
  assert.ok(s.el('chat-login-dialog'), 'a failed dialog status call keeps it open')
  await until(() => s.el('chat-login-poll-error') === null, { timeout: 5_000, message: 'the notice clears on the next good status' })
  assert.equal(cancelCount(s), 0)
  assert.equal(s.media.pending, true, 'the login is still pending')

  failOutbound = false
  s.media.succeed()
  await until(() => s.el('chat-login-dialog') === null, { message: 'dialog closes on success' })
  await until(s.ready, { timeout: 25_000, message: 'composer ready' })
  assert.equal(cancelCount(s), 0)
})

test('REV-CL-001: the composer polling while the confirmed login is committing (restoring) does not cancel it; the session is installed and the composer becomes sendable', async (t) => {
  const s = await scene(t, { login: false })
  await openDialog(s)
  await until(() => s.el('chat-login-qr') !== null, { message: 'QR shown' })
  s.media.beginCommit()
  await until(() => s.text() === '正在連線 LINE…', { timeout: 25_000, message: "the composer's poll lands inside the commit window" })
  await sleep(1200)
  s.media.finishCommit()
  await until(() => s.el('chat-login-dialog') === null, { message: 'dialog closes once committed' })
  await until(s.ready, { timeout: 25_000, message: 'composer ready (idle)' })
  assert.equal(cancelCount(s), 0, 'no cancel during or after the commit')
  assert.equal(s.media.cancelledDuringCommit, undefined, 'nothing cancelled the committing login')
  assert.ok(s.session.client, 'the confirmed session is installed')
})

test('P7a: a successful login closes the dialog from its own authenticated status, before the composer has learned of the session', async (t) => {
  let holdOutbound = false
  let release
  const held = new Promise((resolve) => { release = resolve })
  const intercept = async (method, params, forward) => {
    if (holdOutbound && params?.path === 'linejsOutbound.status') await held
    return forward()
  }
  const s = await scene(t, { login: false, intercept })
  await openDialog(s)
  await until(() => s.el('chat-login-qr') !== null, { message: 'QR shown' })
  holdOutbound = true
  s.media.succeed()
  await until(() => s.el('chat-login-dialog') === null, { timeout: 4_000, message: 'the dialog closes on its own authenticated status (composer status held)' })
  assert.equal(phaseOf(s), 'needs_login', 'closed before the composer saw the session')
  holdOutbound = false
  release()
  await until(s.ready, { timeout: 25_000, message: 'composer ready once its status answers' })
  assert.equal(cancelCount(s), 0)
})

test('P7b: when the composer finds the session while the dialog never saw authenticated, the dialog closes without cancelling', async (t) => {
  let holdMedia = false
  const intercept = async (method, params, forward) => {
    if (holdMedia && params?.path === 'linejsMedia.status') return new Promise(() => {}) // the dialog's status calls never answer
    return forward()
  }
  const s = await scene(t, { login: false, intercept })
  await openDialog(s)
  await until(() => s.el('chat-login-qr') !== null, { message: 'QR shown' })
  holdMedia = true
  await sleep(1100)
  s.media.succeed()
  await until(() => s.el('chat-login-dialog') === null, { timeout: 25_000, message: "the composer's poll closes the dialog" })
  await sleep(50)
  assert.equal(cancelCount(s), 0, 'closing because a session exists is not a cancel')
  assert.ok(s.session.client)
  await until(s.ready, { message: 'composer ready' })
})

test('REV-CL-003: the dialog only cancels a login it started; a login started on the settings page is shown, and ✕ or leaving the chat leaves it running', async (t) => {
  const s = await scene(t, { login: false })
  await until(() => s.el('chat-composer-login') !== null, { message: 'login button' })
  s.media.startedElsewhere()
  await openDialog(s)
  await until(() => s.el('chat-login-qr') !== null, { message: 'the settings login QR is shown' })
  s.props('chat-login-close').onClick()
  await until(() => s.el('chat-login-dialog') === null, { message: '✕ closes' })
  await sleep(50)
  assert.equal(cancelCount(s), 0, 'a joined login is not cancelled')
  assert.equal(s.media.pending, true, 'the settings page login keeps going')

  s.media.fail('LINE 登入逾時，請重新開始。')
  await openDialog(s)
  await until(() => s.el('chat-login-qr') !== null, { message: 'the dialog started its own login' })
  s.props('chat-login-close').onClick()
  await until(() => cancelCount(s) === 1, { message: 'its own login is cancelled' })
  assert.equal(s.media.pending, false)

  s.media.startedElsewhere()
  await openDialog(s)
  await until(() => s.el('chat-login-qr') !== null, { message: 'joined again' })
  s.view.unmount()
  await sleep(50)
  assert.equal(cancelCount(s), 1, 'leaving the chat does not cancel a joined login')
  assert.equal(s.media.pending, true)
})

test('REV-CL-003: with no login in progress (idle) the dialog uses a neutral text, not 登入已取消', async (t) => {
  const s = await scene(t, { login: false })
  s.media.refuseStart = true
  await openDialog(s)
  await until(() => s.el('chat-login-idle') !== null, { message: 'neutral idle text' })
  assert.equal(s.el('chat-login-idle').textContent, '目前沒有進行中的登入')
  assert.equal(s.el('chat-login-cancelled'), null)
})

test('REV-CL-002 (real LineJsMediaService): from a saved session LINE no longer accepts, the dialog shows a QR, no token login runs while it is open, and after a failed QR login 清除登入資料並重新登入 clears the stale session and logs in', async (t) => {
  const tokenCalls = []
  const attempts = []
  const qrClient = { authToken: 'token-new', on() {}, off() {}, listen() {}, base: { profile: { mid: OWNER }, on() {} } }
  const qrOf = (n) => `data:image/png;base64,${Buffer.from(`line://au/q/attempt-${n}`).toString('base64')}`
  const adapters = {
    encodeQr: async (value) => `data:image/png;base64,${Buffer.from(value).toString('base64')}`,
    loginWithAuthToken: async () => { tokenCalls.push(Date.now()); await sleep(20); throw Object.assign(new Error('LINE token rejected (synthetic)'), { code: 'TOKEN_REJECTED' }) },
    loginWithQR: async (callbacks, init) => {
      const n = attempts.length + 1
      let settle
      const done = new Promise((resolve, reject) => { settle = { resolve, reject } })
      attempts.push(settle)
      await callbacks.onReceiveQRUrl(`line://au/q/attempt-${n}`)
      await done
      await init.storage.set('linejs-auth-token', qrClient.authToken)
      return qrClient
    }
  }
  const s = await scene(t, { realLogin: { staleToken: 'synthetic-expired', adapters } })
  await until(() => s.el('chat-composer-login') !== null, { timeout: 30_000, message: 'login button after the stale restore failed' })
  assert.equal(tokenCalls.length, 1, 'the composer tried the saved session once')
  s.props('chat-composer-login').onClick()
  await until(() => s.el('chat-login-qr') !== null, { timeout: 5_000, message: 'a QR despite the stale saved session' })
  assert.equal(reactProps(s.el('chat-login-qr')).src, qrOf(1))
  await sleep(3_000)
  assert.ok(s.el('chat-login-qr'), 'the QR stays (no restore failure replaces it)')
  assert.equal(tokenCalls.length, 1, 'no token login of the stale session while the QR login is pending')

  attempts[0].reject(Object.assign(new Error('QR code expired (synthetic)'), { code: 'QR_EXPIRED' }))
  await until(() => s.el('chat-login-clear') !== null, { timeout: 5_000, message: 'failure offers 清除登入資料並重新登入' })
  await sleep(2_500)
  assert.equal(tokenCalls.length, 1, 'the dialog polling a failed state does not retry the token every second')
  s.props('chat-login-clear').onClick()
  await until(() => attempts.length === 2 && s.el('chat-login-qr') !== null, { timeout: 5_000, message: 'a new QR after clearing' })
  assert.equal(reactProps(s.el('chat-login-qr')).src, qrOf(2))
  assert.ok(s.media.calls.includes('linejsMedia.logout'), 'clearing uses the same linejsMedia.logout as the settings page')
  assert.equal(await access(join(s.dataDir, 'linejs-session.json')).then(() => true, () => false), false, 'the stale session file is gone')

  attempts[1].resolve()
  await until(() => s.el('chat-login-dialog') === null, { timeout: 10_000, message: 'dialog closes after the new login' })
  await until(s.ready, { timeout: 25_000, message: 'composer ready with the new session' })
  assert.equal(cancelCount(s), 0)
  assert.equal(tokenCalls.length, 1)
})

// ── 2026-11-13 login PIN (AC1/AC2) and QR progress (AC4), with the REAL LineJsMediaService behind both the chat dialog and the settings panel ──

/** LINEJS stand-ins: the QR login waits for `scan(pin?)` (a pin = LINE asks for one, LINEJS "pincall"), then `confirm()` / `reject(error)`. */
function pinAdapters({ holdQr = false } = {}) {
  const attempts = []
  const qrClient = { authToken: 'token-pin', on() {}, off() {}, listen() {}, base: { profile: { mid: OWNER }, on() {} } }
  let releaseQr = () => {}
  const qrGate = holdQr ? new Promise((resolve) => { releaseQr = resolve }) : Promise.resolve()
  const adapters = {
    encodeQr: async (value) => `data:image/png;base64,${Buffer.from(value).toString('base64')}`,
    loginWithAuthToken: async () => { throw Object.assign(new Error('no saved session (synthetic)'), { code: 'NO_SESSION' }) },
    loginWithQR: async (callbacks, init) => {
      const attempt = {}
      attempt.scanned = new Promise((resolve) => { attempt.scan = resolve })
      attempt.done = new Promise((resolve, reject) => { attempt.confirm = resolve; attempt.reject = reject })
      attempts.push(attempt)
      await qrGate // LINE has not answered createSession / createQrCodeForSecure yet
      await callbacks.onReceiveQRUrl(`line://au/q/ui-${attempts.length}`)
      const pin = await attempt.scanned
      if (pin) callbacks.onPincodeRequest(pin)
      await attempt.done
      await init.storage.set('linejs-auth-token', qrClient.authToken)
      return qrClient
    }
  }
  return { attempts, adapters, releaseQr: () => releaseQr() }
}

/** the REAL settings-page panel on the same backend (settings.tsx mounts it with api.plugin) */
function mountPanel(t, s) {
  const panel = ui.mount(ui.linejsMediaPanelScene(s.api.plugin))
  t.after(() => panel.unmount())
  return { container: panel.container, el: (id) => byAttr(panel.container, 'data-testid', id) }
}

test('PIN (AC1/AC2): after the scan the chat dialog and the settings panel both show 請在手機 LINE 輸入 PIN：xxxxxx instead of the QR; typing it logs in, the dialog closes, the composer becomes sendable and the PIN disappears', async (t) => {
  const { attempts, adapters } = pinAdapters()
  const s = await scene(t, { realLogin: { adapters } })
  const panel = mountPanel(t, s)
  await openDialog(s)
  await until(() => s.el('chat-login-qr') !== null, { timeout: 5_000, message: 'QR in the dialog' })
  await until(() => panel.el('linejs-login-qr') !== null, { timeout: 5_000, message: 'QR on the settings panel' })
  attempts[0].scan('482913')
  await until(() => s.el('chat-login-pin') !== null, { timeout: 5_000, message: 'PIN in the dialog' })
  assert.equal(s.el('chat-login-pin').textContent, '請在手機 LINE 輸入 PIN：482913')
  assert.equal(s.el('chat-login-qr'), null, 'the scanned QR is no longer shown')
  await until(() => panel.el('linejs-login-pin') !== null, { timeout: 5_000, message: 'PIN on the settings panel' })
  assert.equal(panel.el('linejs-login-pin').textContent, '請在手機 LINE 輸入 PIN：482913')
  assert.equal(panel.el('linejs-login-qr'), null)
  await sleep(1_200)
  assert.ok(s.el('chat-login-dialog') && s.el('chat-login-pin'), 'the dialog keeps the PIN while LINE waits for it')
  attempts[0].confirm()
  await until(() => s.el('chat-login-dialog') === null, { timeout: 10_000, message: 'dialog closes after the PIN login' })
  await until(s.ready, { timeout: 25_000, message: 'composer ready with the new session' })
  await until(() => panel.el('linejs-login-pin') === null && panel.container.textContent.includes('LINE 已登入'), { timeout: 5_000, message: 'panel: logged in, PIN gone' })
  assert.equal(cancelCount(s), 0)
})

test('PIN rejected (AC2): the dialog shows the failure with 重試 and no PIN; the retry shows a new QR and a login without a PIN completes', async (t) => {
  const { attempts, adapters } = pinAdapters()
  const s = await scene(t, { realLogin: { adapters } })
  await openDialog(s)
  await until(() => s.el('chat-login-qr') !== null, { timeout: 5_000, message: 'QR' })
  attempts[0].scan('482913')
  await until(() => s.el('chat-login-pin') !== null, { timeout: 5_000, message: 'PIN' })
  attempts[0].reject(Object.assign(new Error('checkPinCodeVerified timed out (synthetic)'), { code: 'PIN_TIMEOUT' }))
  await until(() => s.el('chat-login-error') !== null, { timeout: 5_000, message: 'failure shown' })
  assert.equal(s.el('chat-login-error').textContent, 'LINE 連線失敗（PIN_TIMEOUT）')
  assert.equal(s.el('chat-login-pin'), null, 'no stale PIN next to the error')
  s.props('chat-login-retry').onClick()
  await until(() => attempts.length === 2 && s.el('chat-login-qr') !== null, { timeout: 5_000, message: 'retry shows a new QR' })
  assert.equal(s.el('chat-login-pin'), null)
  attempts[1].scan()
  attempts[1].confirm()
  await until(() => s.el('chat-login-dialog') === null, { timeout: 10_000, message: 'dialog closes after the retried login' })
  assert.equal(cancelCount(s), 0)
})

test('QR progress (AC4): while LINE has not produced the QR the dialog says so with the seconds waited and the settings panel says the same; a status call the view gives up on reads as a background-busy note, not a raw error; the QR then appears', async (t) => {
  let holdStatus = false
  const intercept = async (method, params, forward) => {
    if (holdStatus && params?.path === 'linejsMedia.status') return new Promise(() => {}) // the backend does not answer in time
    return forward()
  }
  const { attempts, adapters, releaseQr } = pinAdapters({ holdQr: true })
  const s = await scene(t, { realLogin: { adapters }, intercept, timeouts: { coreMs: 600 } })
  const panel = mountPanel(t, s)
  await openDialog(s)
  await until(() => s.el('chat-login-waiting')?.textContent.startsWith('正在向 LINE 取得 QR code…'), { timeout: 5_000, message: 'waiting for LINE' })
  await until(() => /（已等待 \d+ 秒）$/.test(s.el('chat-login-waiting')?.textContent ?? ''), { timeout: 8_000, message: 'seconds waited' })
  await until(() => panel.el('linejs-login-waiting') !== null, { timeout: 5_000, message: 'the settings panel shows the same wait' })
  assert.equal(panel.el('linejs-login-qr'), null)

  holdStatus = true
  await until(() => s.el('chat-login-poll-error') !== null, { timeout: 5_000, message: 'a status call timed out in the view' })
  assert.equal(s.el('chat-login-poll-error').textContent, '外掛正在處理背景工作，登入狀態稍後更新（畫面上的 QR code／PIN 仍有效）')
  assert.ok(s.el('chat-login-dialog'), 'the dialog stays open')
  holdStatus = false
  await until(() => s.el('chat-login-poll-error') === null, { timeout: 5_000, message: 'the note clears on the next answer' })

  releaseQr()
  await until(() => s.el('chat-login-qr') !== null, { timeout: 5_000, message: 'the QR appears once LINE answered' })
  assert.equal(attempts.length, 1)
  assert.equal(cancelCount(s), 0)
})

// ── fix2 (2026-11-13): the PIN was typed and the backend logged in, but the host relayed the answers later than the view waits ──

/** the backend answers at once; the host hands the answer to the view `ms` later (longer than the view's coreMs) */
const relayLate = (ms) => async (forward) => { const answer = await forward(); await sleep(ms); return answer }

test('fix2 T2: after a status call the view gave up on (view_call_timeout), the late authenticated answer closes the PIN dialog; the composer never answers; no cancel', async (t) => {
  let slowStatus = false
  let holdOutbound = false
  const late = relayLate(900)
  const intercept = async (method, params, forward) => {
    if (holdOutbound && params?.path === 'linejsOutbound.status') return new Promise(() => {}) // the composer never learns of the session
    if (slowStatus && params?.path === 'linejsMedia.status') return late(forward)
    return forward()
  }
  const { attempts, adapters } = pinAdapters()
  const s = await scene(t, { realLogin: { adapters }, intercept, timeouts: { coreMs: 600 } })
  await openDialog(s)
  await until(() => s.el('chat-login-qr') !== null, { timeout: 5_000, message: 'QR' })
  attempts[0].scan('482913')
  await until(() => s.el('chat-login-pin') !== null, { timeout: 5_000, message: 'PIN shown' })
  holdOutbound = true
  slowStatus = true
  attempts[0].confirm() // the PIN was typed on the phone: the backend logs in
  let sawTimeoutNote = false
  await until(() => {
    if (s.el('chat-login-poll-error')) sawTimeoutNote = true
    return s.el('chat-login-dialog') === null
  }, { timeout: 8_000, message: 'the dialog closes on the late authenticated answer' })
  assert.ok(sawTimeoutNote, 'a status call timed out in the view first (the busy note was shown)')
  assert.ok(s.api.plugin.transportStats().timeouts >= 1)
  assert.notEqual(phaseOf(s), 'idle', 'closed by its own (late) status: the composer never answered')
  assert.equal(cancelCount(s), 0)
  assert.ok(s.session.client, 'the session is installed')
})

test('fix2 T3: when the dialog status never answers, the composer status answered late (after the view gave up) that a session exists closes the dialog without cancelling', async (t) => {
  let holdMedia = false
  let slowOutbound = false
  const late = relayLate(900)
  const intercept = async (method, params, forward) => {
    if (holdMedia && params?.path === 'linejsMedia.status') return new Promise(() => {}) // the dialog never sees authenticated
    if (slowOutbound && params?.path === 'linejsOutbound.status') return late(forward)
    return forward()
  }
  const { attempts, adapters } = pinAdapters()
  const s = await scene(t, { realLogin: { adapters }, intercept, timeouts: { coreMs: 600 } })
  await openDialog(s)
  await until(() => s.el('chat-login-qr') !== null, { timeout: 5_000, message: 'QR' })
  attempts[0].scan('482913')
  await until(() => s.el('chat-login-pin') !== null, { timeout: 5_000, message: 'PIN shown' })
  holdMedia = true
  slowOutbound = true
  attempts[0].confirm()
  await until(() => s.el('chat-login-dialog') === null, { timeout: 25_000, message: "the composer's late answer closes the dialog" })
  await sleep(50)
  assert.equal(cancelCount(s), 0, 'closing because a session exists is not a cancel')
  await until(s.ready, { timeout: 5_000, message: 'composer ready from the late answer' })
})

test('fix2 T4: while the PIN is shown and status keeps failing, the dialog says what to do; 關閉視窗 closes it without cancelling, the login finishes and the composer becomes sendable', async (t) => {
  let holdMedia = false
  const intercept = async (method, params, forward) => {
    if (holdMedia && params?.path === 'linejsMedia.status') return new Promise(() => {})
    return forward()
  }
  const { attempts, adapters } = pinAdapters()
  const s = await scene(t, { realLogin: { adapters }, intercept, timeouts: { coreMs: 600 } })
  await openDialog(s)
  await until(() => s.el('chat-login-qr') !== null, { timeout: 5_000, message: 'QR' })
  attempts[0].scan('482913')
  await until(() => s.el('chat-login-pin') !== null, { timeout: 5_000, message: 'PIN shown' })
  holdMedia = true
  await until(() => s.el('chat-login-stuck') !== null, { timeout: 8_000, message: 'the stuck note after repeated status failures' })
  assert.equal(s.el('chat-login-stuck').textContent, '若已在手機輸入 PIN，登入可能已經完成：請稍候，畫面會自動更新；或按「關閉視窗」，不會取消登入，完成後輸入列會自動可以傳送。')
  assert.ok(s.el('chat-login-pin'), 'the PIN stays on screen next to the note')
  assert.ok(s.el('chat-login-cancel'), '取消登入 is still offered')
  s.props('chat-login-dismiss').onClick()
  await until(() => s.el('chat-login-dialog') === null, { message: '關閉視窗 closes the dialog' })
  await sleep(50)
  assert.equal(cancelCount(s), 0, '關閉視窗 is not a cancel (the PIN may already have been typed)')
  holdMedia = false
  attempts[0].confirm()
  await until(s.ready, { timeout: 25_000, message: 'the login finished in the background and the composer became sendable' })
  assert.equal(cancelCount(s), 0)
})

test('fix2 T4b: a single failed status call shows only the busy note, not the stuck note; the stuck note clears on the next good answer', async (t) => {
  let failMedia = 0
  const intercept = async (method, params, forward) => {
    if (failMedia > 0 && params?.path === 'linejsMedia.status') { failMedia--; throw new Error('plugin_backend_crashed') }
    return forward()
  }
  const { attempts, adapters } = pinAdapters()
  const s = await scene(t, { realLogin: { adapters }, intercept })
  await openDialog(s)
  await until(() => s.el('chat-login-qr') !== null, { timeout: 5_000, message: 'QR' })
  attempts[0].scan('482913')
  await until(() => s.el('chat-login-pin') !== null, { timeout: 5_000, message: 'PIN shown' })
  failMedia = 1
  await until(() => s.el('chat-login-poll-error') !== null, { timeout: 5_000, message: 'one failure' })
  assert.equal(s.el('chat-login-stuck'), null, 'one failure is not stuck')
  await until(() => s.el('chat-login-poll-error') === null, { timeout: 5_000, message: 'next good answer' })
  failMedia = 3
  await until(() => s.el('chat-login-stuck') !== null, { timeout: 8_000, message: 'stuck after repeated failures' })
  await until(() => s.el('chat-login-stuck') === null && s.el('chat-login-poll-error') === null, { timeout: 8_000, message: 'cleared on the next good answer' })
  assert.ok(s.el('chat-login-pin'))
  assert.equal(cancelCount(s), 0)
})
