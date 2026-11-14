import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createLineJsFetch, linejsUrlAllowed, LineJsMediaService } from '../../src/plugin/backend/linejsMedia.ts'
import { AutoDownloadStore } from '../../src/plugin/backend/linejsAutoDownload.mjs'
import { Dispatcher } from '../../src/plugin/backend/dispatcher.ts'
import { EventHub } from '../../src/plugin/backend/eventHub.ts'

const temp = async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'line-todo-linejs-media-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('有限 HTTPS host/path allowlist rejects unknown destinations, ports and userinfo', () => {
  assert.equal(linejsUrlAllowed('https://legy.line-apps.com/api/v4p/rs'), true)
  assert.equal(linejsUrlAllowed('https://legy.line-apps.com/acct/lp/lgn/sq/v1'), true)
  assert.equal(linejsUrlAllowed('https://obs.line-apps.com/r/talk/m/msg-1'), true)
  assert.equal(linejsUrlAllowed('https://obs.line-apps.com/r/talk/m/msg-1/object_info.obs'), true)
  assert.equal(linejsUrlAllowed('https://attacker.example/r/talk/m/msg-1'), false)
  assert.equal(linejsUrlAllowed('http://legy.line-apps.com/api/v4p/rs'), false)
  assert.equal(linejsUrlAllowed('https://legy.line-apps.com:8443/api/v4p/rs'), false)
  assert.equal(linejsUrlAllowed('https://user:pass@legy.line-apps.com/api/v4p/rs'), false)
  assert.equal(linejsUrlAllowed('https://legy.line-apps.com/api/v4p/rs/extra'), false)
  assert.equal(linejsUrlAllowed('https://legy.line-apps.com/acct/lp/other/sq/v1'), false)
  assert.equal(linejsUrlAllowed('https://obs.line-apps.com/r/talk/m/id/../../other'), false)
})

test('custom fetch passes allowed request, uses manual redirects, and rejects a redirect without a second hop', async () => {
  const seen = []
  const fetch = createLineJsFetch(async (request) => { seen.push(request); return new Response('ok') })
  assert.equal(await (await fetch('https://legy.line-apps.com/api/v4p/rs')).text(), 'ok')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].redirect, 'manual')
  const redirectFetch = createLineJsFetch(async (request) => { seen.push(request); return new Response(null, { status: 302, headers: { location: 'https://attacker.example/steal' } }) })
  await assert.rejects(() => redirectFetch('https://obs.line-apps.com/r/talk/m/known-id'), { code: 'LINEJS_REDIRECT_DENIED' })
  assert.equal(seen.length, 2)
})

test('response streaming cap cancels oversized response without Content-Length', async () => {
  let cancelled = false
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(25 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true }
  })
  const fetch = createLineJsFetch(async () => new Response(body))
  const response = await fetch('https://obs.line-apps.com/r/talk/m/large-id')
  await assert.rejects(() => response.arrayBuffer())
  assert.equal(cancelled, true)
})

// X2b（Q3 = 以電腦版訊息為準）：LINEJS 'message' 事件不再下載（接收改由 linejsReceive.ts 依電腦版訊息列交給下載原檔服務）。
// 原本「synthetic receiver filters and persists exact IMAGE/FILE identities」驗的是 v1 下載路徑；改成驗：接收開啟後 listen 迴圈照常（帳號與
// session 狀態），任何 message 都不下載、不寫 v1 ledger；X2b 之前 v1 已完成的檔案仍可由 exportChunk 匯出（規則與上限不變）。
test('production service login is explicit; receive on keeps the listen loop but no LINEJS message is downloaded (X2b); v1 files completed before X2b still export', async (t) => {
  const root = await temp(t)
  const events = new EventEmitter()
  const baseEvents = new EventEmitter()
  const imageBytes = Buffer.from(Array.from({ length: 70_001 }, (_, index) => (index * 17 + 3) & 0xff))
  const fileBytes = Buffer.from(Array.from({ length: 81_237 }, (_, index) => (index * 29 + 11) & 0xff))
  let listenCount = 0
  const sdk = { getData: 0, downloadMessageData: 0, getMessageObsMetadata: 0 }
  const fakeClient = {
    authToken: 'synthetic-token', on: events.on.bind(events), off: events.off.bind(events),
    listen() { listenCount++ },
    base: {
      profile: { mid: 'synthetic-account' }, on: baseEvents.on.bind(baseEvents),
      obs: { async getMessageObsMetadata() { sdk.getMessageObsMetadata++; return { name: 'report.pdf', type: 'application/pdf', size: fileBytes.length } }, async downloadMessageData() { sdk.downloadMessageData++; return new Blob([fileBytes], { type: 'application/pdf' }) } }
    }
  }
  // what the v1 path completed before X2b (written by a non-frozen store, as the old version did)
  const legacy = new AutoDownloadStore(path.join(root, 'plugin-data', 'linejs-downloads'))
  await legacy.init()
  legacy.setOwner('synthetic-account')
  for (const [id, kind, name, bytes] of [['img-1', 'IMAGE', 'img-1.jpg', imageBytes], ['file-1', 'FILE', '../report.pdf', fileBytes]]) {
    await legacy.enqueue({ chatId: 'chat-A', chatName: 'chat-A', message: { raw: { id } }, kind, metadata: { name } })
    await legacy.saveFile(legacy.keyFor('chat-A', id, kind), bytes)
  }
  await legacy.close()
  const service = await LineJsMediaService.create(path.join(root, 'plugin-data'), {
    encodeQr: async () => 'data:image/png;base64,c3ludGhldGlj',
    loginWithQR: async (callbacks, init) => {
      await callbacks.onReceiveQRUrl('https://line.example/qr-fixture')
      await init.storage.set('linejs-auth-token', 'synthetic-token')
      return fakeClient
    }
  })
  t.after(() => service.dispose())
  const hub = new EventHub()
  const dispatcher = new Dispatcher({ getApi: () => ({}), hub, queue: {}, info: () => ({}), linejsMedia: service })
  t.after(() => { dispatcher.dispose(); hub.dispose() })

  assert.equal((await dispatcher.call('linejsMedia', { path: 'linejsMedia.status', args: [] })).value.login.status, 'idle')
  await dispatcher.call('linejsMedia', { path: 'linejsMedia.startLogin', args: [] })
  let state
  for (let i = 0; i < 100; i++) { state = await service.status(); if (state.login.status === 'authenticated') break; await new Promise((resolve) => setTimeout(resolve, 5)) }
  assert.equal(state.login.status, 'authenticated')
  assert.equal(listenCount, 0, 'receiving remains off until the user enables it')
  await dispatcher.call('linejsMedia', { path: 'linejsMedia.setReceiveEnabled', args: [true] })
  assert.equal(listenCount, 1)

  const message = (id, kind, { self = false, hasContent = true, data = imageBytes } = {}) => ({
    isMyMessage: self, to: { type: 'GROUP', id: 'chat-A' }, from: { id: 'peer-A' },
    raw: { id, contentType: kind, hasContent, contentMetadata: { FILE_NAME: '../report.pdf' } },
    async getData() { sdk.getData++; return new Blob([data], { type: 'image/png' }) }
  })
  events.emit('message', message('self-1', 'IMAGE', { self: true }))
  events.emit('message', message('empty-1', 'FILE', { hasContent: false }))
  events.emit('message', message('video-1', 'VIDEO'))
  events.emit('message', message('img-9', 'IMAGE'))
  events.emit('message', message('file-9', 'FILE', { data: fileBytes }))
  events.emit('message', message('img-10', 'IMAGE'))
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(sdk, { getData: 0, downloadMessageData: 0, getMessageObsMetadata: 0 }, 'no LINEJS message is downloaded')
  state = await service.status()
  assert.equal(state.receiver, 'active')
  assert.equal(state.downloads.completed, 2, 'only the two v1 items completed before X2b')
  assert.equal(state.downloads.pending, 0)
  const items = state.downloads.recent
  assert.deepEqual(new Set(items.map((item) => item.messageId)), new Set(['img-1', 'file-1']))
  assert.ok(items.every((item) => !item.name.includes('..') && !item.name.includes('/')))
  const fileItem = items.find((item) => item.messageId === 'file-1')
  const imageItem = items.find((item) => item.messageId === 'img-1')
  const exportRpc = async (key, offset, length) => dispatcher.call('linejsMedia', { path: 'linejsMedia.exportChunk', args: [key, offset, length] })
  const exportAll = async (item) => {
    const chunks = []
    for (let offset = 0; offset < item.bytes; offset += 32 * 1024) {
      const length = Math.min(32 * 1024, item.bytes - offset)
      const response = await exportRpc(item.key, offset, length)
      assert.equal(response.ok, true)
      assert.equal(response.value.name, item.name)
      assert.equal(response.value.size, item.bytes)
      assert.equal(response.value.offset, offset)
      const chunk = Buffer.from(response.value.data, 'base64')
      assert.equal(chunk.length, length)
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }
  assert.deepEqual(await exportAll(fileItem), fileBytes)
  assert.deepEqual(await exportAll(imageItem), imageBytes)
  assert.equal((await exportRpc('unknown-id', 0, 1)).code, 'SAVED_FILE_UNAVAILABLE')
  assert.equal((await exportRpc(fileItem.key, 0, 25 * 1024 * 1024)).code, 'INVALID_FILE_RANGE')
  assert.equal((await exportRpc(fileItem.key, fileBytes.length, 1)).code, 'INVALID_FILE_RANGE')
  const savedItem = service['store'].jobs.get(fileItem.key)
  const originalRoot = savedItem.savedRoot
  const originalStatus = savedItem.status
  savedItem.status = 'failed'
  assert.equal((await exportRpc(fileItem.key, 0, 1)).code, 'SAVED_FILE_UNAVAILABLE')
  savedItem.status = originalStatus
  savedItem.savedRoot = root
  assert.equal((await exportRpc(fileItem.key, 0, 1)).code, 'UNSAFE_PATH')
  savedItem.savedRoot = originalRoot
  service['store'].setOwner('other-account')
  assert.equal((await exportRpc(fileItem.key, 0, 1)).code, 'SAVED_FILE_UNAVAILABLE')
  service['store'].setOwner('synthetic-account')
  await rm(path.join(originalRoot, savedItem.chatFolder, savedItem.savedName))
  assert.equal((await exportRpc(fileItem.key, 0, 1)).code, 'SAVED_FILE_UNAVAILABLE')
  assert.equal((await dispatcher.call('linejsMedia', { path: 'linejsMedia.exportChunk', args: [fileItem.key, -1, 1] })).code, 'INVALID_FILE_RANGE')
  assert.equal((await dispatcher.call('linejsMedia', { path: 'linejsMedia.exportChunk', args: [fileItem.key, 0, 1, 'extra'] })).code, 'invalid_args')
  assert.equal(listenCount, 1)
})

test('saved-file export rejects non-completed entries and changed or escaped files', async (t) => {
  const root = await temp(t)
  const store = new AutoDownloadStore(path.join(root, 'plugin-data', 'linejs-downloads'))
  await store.init()
  store.setOwner('owner-a')
  const pendingKey = store.keyFor('chat', 'pending', 'FILE')
  await store.enqueue({ chatId: 'chat', message: { raw: { id: 'pending' } }, kind: 'FILE', metadata: { name: 'pending.txt' } })
  assert.equal(await store.readSavedChunk(pendingKey, 0, 1), null)
  const key = store.keyFor('chat', 'good', 'FILE')
  await store.enqueue({ chatId: 'chat', message: { raw: { id: 'good' } }, kind: 'FILE', metadata: { name: 'good.txt' } })
  await store.saveFile(key, Buffer.from('safe bytes'))
  store.setOwner('owner-b')
  assert.equal(await store.readSavedChunk(key, 0, 1), null)
  store.setOwner('owner-a')
  const item = store.jobs.get(key)
  const validRoot = item.savedRoot
  const validName = item.savedName
  item.savedRoot = path.join(root, 'outside')
  await assert.rejects(() => store.readSavedChunk(key, 0, 1))
  item.savedRoot = validRoot
  const saved = await store.readSavedChunk(key, 0, 4)
  assert.equal(Buffer.from(saved.data, 'base64').toString(), 'safe')
  item.savedName = '..\\outside.txt'
  await assert.rejects(() => store.readSavedChunk(key, 0, 1), { code: 'UNSAFE_PATH' })
  item.savedName = validName
  await rm(path.join(validRoot, item.chatFolder, item.savedName))
  await assert.rejects(() => store.readSavedChunk(key, 0, 1), { code: 'ENOENT' })
})

test('logout cancels active receiver and erases only the LINEJS session file', async (t) => {
  const root = await temp(t)
  const events = new EventEmitter()
  const client = { authToken: 'fixture', on: events.on.bind(events), off: events.off.bind(events), listen() {}, base: { profile: { mid: 'logout-account' }, on() {}, obs: { async downloadMessageData() { return new Blob(['x']) } } } }
  const service = await LineJsMediaService.create(path.join(root, 'plugin'), { loginWithQR: async (_cb, init) => { await init.storage.set('linejs-auth-token', 'fixture'); return client } })
  t.after(() => service.dispose())
  await service.startLogin()
  for (let i = 0; i < 100 && (await service.status()).login.status !== 'authenticated'; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  await service.setReceiveEnabled(true)
  await service.logout()
  assert.equal((await service.status()).login.status, 'idle')
  await assert.rejects(() => readFile(path.join(root, 'plugin', 'linejs-session.json')), { code: 'ENOENT' })
})

// X2b：原本驗「登出時進行中的 v1 附件下載被中止、晚到的位元組不會寫入」。v1 下載路徑已停用，'message' 不再開始任何下載，
// 所以改成驗：接收開啟、收到附件訊息 → 不呼叫 LINEJS 下載、v1 store 沒有新項目；登出中止 listen 迴圈（signal）並只刪 session 檔。
// 登出對「下載中」工作的中止由 X6（linejsOriginals：onSessionChange → 取消，part 保留）負責，見 test-linejs-originals.mjs。
test('logout with receive on: a LINEJS attachment message starts no download (X2b), the listen loop is aborted and only the session file is erased', async (t) => {
  const root = await temp(t)
  const events = new EventEmitter()
  const sdk = { getData: 0, downloadMessageData: 0 }
  let listenSignal = null
  const client = {
    authToken: 'fixture-session', on: events.on.bind(events), off: events.off.bind(events), listen(options) { listenSignal = options.signal },
    base: { profile: { mid: 'logout-race-account' }, on() {}, obs: { async downloadMessageData() { sdk.downloadMessageData++; return new Blob([Buffer.from('x')]) } } }
  }
  const service = await LineJsMediaService.create(path.join(root, 'plugin'), {
    loginWithQR: async (_callbacks, init) => { await init.storage.set('linejs-auth-token', 'fixture-session'); return client }
  })
  await service.startLogin()
  for (let i = 0; i < 100 && (await service.status()).login.status !== 'authenticated'; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  await service.setReceiveEnabled(true)
  const message = {
    isMyMessage: false, to: { type: 'GROUP', id: 'logout-chat' }, from: { id: 'peer' },
    raw: { id: 'slow-file', contentType: 'FILE', hasContent: true, contentMetadata: { FILE_NAME: 'slow.pdf' } },
    async getData() { sdk.getData++; return new Blob([Buffer.from('late bytes')]) }
  }
  events.emit('message', message)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(sdk, { getData: 0, downloadMessageData: 0 })
  assert.equal(listenSignal?.aborted, false)
  await service.logout()
  assert.equal(listenSignal.aborted, true, 'logout stops the listen loop')
  const state = await service.status()
  assert.equal(state.downloads.completed + state.downloads.pending + state.downloads.failed, 0)
  assert.equal(service['store'].jobs.size, 0)
  await assert.rejects(() => readFile(path.join(root, 'plugin', 'linejs-session.json')), { code: 'ENOENT' })
  await service.dispose()
})
