// 「用 Chrome 發送」（chromeLine）的單元測試：流程（chromeLine.ts）以假頁面驗證，不連真的瀏覽器。
//   * 只送到「名稱完全相同且唯一」的聊天室；開啟後 data-mid 與標頭名稱都要對上才填入
//   * 輸入框已有文字不覆蓋；填入後內容不一致就清掉、不按 Enter
//   * 以 sendMessage 的回應（200 且 to＝聊天室 mid）確認送出；看不到回應時區分「確定沒送」與「無法確認」
//   * dispatcher 的 chromeLine 方法組路由
import assert from 'node:assert/strict'
import test from 'node:test'

import { ChromeLineError, createChromeLineSender, exactMatches, normalizeText, sendOnPage } from '../../src/plugin/backend/chromeLine.ts'
import { routingTo } from '../../src/plugin/backend/chromeLineCdp.ts'
import { Dispatcher } from '../../src/plugin/backend/dispatcher.ts'
import { backendMethodFor } from '../../src/shared/pluginWire.ts'

/** 假的 LINE 外掛分頁：依設定回應，並記錄被呼叫的動作。 */
function fakePage(over = {}) {
  const calls = []
  let draft = over.initialDraft ?? ''
  const page = {
    calls,
    async ready() { calls.push('ready'); return over.ready ?? true },
    async searchChats(name) { calls.push(`search:${name}`); return over.hits ?? [{ mid: 'C-target', title: 'Team A' }, { mid: 'C-other', title: 'Team A 2' }] },
    async clearSearch() { calls.push('clearSearch') },
    async openChat(mid) { calls.push(`open:${mid}`); return over.room ?? { roomMid: mid, header: 'Team A' } },
    async readDraft() { calls.push('readDraft'); return over.noEditor ? null : draft },
    async fillDraft(text) { calls.push('fill'); draft = over.fillResult ?? text; return draft },
    async clearDraft() { calls.push('clearDraft'); draft = '' },
    async pressEnterAndWatch() {
      calls.push('enter')
      if (over.enterThrows) throw new Error('socket closed')
      if (over.enterKeepsDraft === false) draft = ''
      return over.observed ?? [{ status: 200, to: 'C-target' }]
    },
    close() { calls.push('close') }
  }
  return page
}

test('exactMatches: exact, trimmed, NFC-normalized names; one entry per mid', () => {
  const hits = [
    { mid: 'C1', title: ' Team A ' },
    { mid: 'C1', title: 'Team A' },
    { mid: 'C2', title: 'Team A 2' },
    { mid: 'C3', title: 'Café' }
  ]
  assert.deepEqual(exactMatches(hits, 'Team A').map((h) => h.mid), ['C1'])
  assert.deepEqual(exactMatches(hits, 'Café').map((h) => h.mid), ['C3'])
  assert.deepEqual(exactMatches(hits, 'Team'), [])
})

test('normalizeText: CRLF / CR become LF', () => {
  assert.equal(normalizeText('a\r\nb\rc\nd'), 'a\nb\nc\nd')
})

test('routingTo: reads `to` from the sendMessage body [seq, message]', () => {
  assert.equal(routingTo(JSON.stringify([12, { from: 'Ume', to: 'Cabc', toType: 2, chunks: ['x'] }])), 'Cabc')
  assert.equal(routingTo(JSON.stringify({ to: 'Uxyz' })), 'Uxyz')
  assert.equal(routingTo('not json'), null)
  assert.equal(routingTo(null), null)
})

test('sendOnPage: happy path — search, clear search, open + verify, fill, Enter, confirmed by sendMessage 200 to the chat mid', async () => {
  const page = fakePage()
  const r = await sendOnPage(page, 'Team A', '你好\r\n明天見', 1000)
  assert.deepEqual(r, { ok: true, chatName: 'Team A', chatMid: 'C-target' })
  assert.deepEqual(page.calls, ['ready', 'search:Team A', 'clearSearch', 'open:C-target', 'readDraft', 'fill', 'enter'])
})

test('sendOnPage: not logged in → line_not_ready, nothing touched', async () => {
  const page = fakePage({ ready: false })
  const r = await sendOnPage(page, 'Team A', 'hi', 1000)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'line_not_ready')
  assert.deepEqual(page.calls, ['ready'])
})

test('sendOnPage: no exact match → chat_not_found; two chats with the same name → chat_ambiguous; neither opens a chat', async () => {
  const none = fakePage({ hits: [{ mid: 'C2', title: 'Team A 2' }] })
  const r1 = await sendOnPage(none, 'Team A', 'hi', 1000)
  assert.equal(r1.code, 'chat_not_found')
  assert.equal(r1.sent, 'no')
  assert.ok(!none.calls.some((c) => c.startsWith('open:')))
  assert.ok(none.calls.includes('clearSearch'))

  const two = fakePage({ hits: [{ mid: 'C1', title: 'Team A' }, { mid: 'C9', title: 'Team A' }] })
  const r2 = await sendOnPage(two, 'Team A', 'hi', 1000)
  assert.equal(r2.code, 'chat_ambiguous')
  assert.ok(!two.calls.some((c) => c.startsWith('open:')))
})

test('sendOnPage: opened room is another chat, or its header differs → open_failed, no fill', async () => {
  const wrongMid = fakePage({ room: { roomMid: 'C-other', header: 'Team A' } })
  assert.equal((await sendOnPage(wrongMid, 'Team A', 'hi', 1000)).code, 'open_failed')
  assert.ok(!wrongMid.calls.includes('fill'))

  const wrongName = fakePage({ room: { roomMid: 'C-target', header: 'Team B' } })
  const r = await sendOnPage(wrongName, 'Team A', 'hi', 1000)
  assert.equal(r.code, 'open_failed')
  assert.match(r.message, /Team B/)
  assert.ok(!wrongName.calls.includes('fill'))
})

test('sendOnPage: an existing draft in LINE is never overwritten (draft_present); no editor → fill_failed', async () => {
  const busy = fakePage({ initialDraft: '使用者自己打到一半' })
  assert.equal((await sendOnPage(busy, 'Team A', 'hi', 1000)).code, 'draft_present')
  assert.ok(!busy.calls.includes('fill'))
  assert.ok(!busy.calls.includes('clearDraft'))

  const noEditor = fakePage({ noEditor: true })
  assert.equal((await sendOnPage(noEditor, 'Team A', 'hi', 1000)).code, 'fill_failed')
})

test('sendOnPage: filled text differs → cleared, fill_failed, Enter never pressed', async () => {
  const page = fakePage({ fillResult: 'h' })
  const r = await sendOnPage(page, 'Team A', 'hi', 1000)
  assert.equal(r.code, 'fill_failed')
  assert.equal(r.sent, 'no')
  assert.ok(page.calls.includes('clearDraft'))
  assert.ok(!page.calls.includes('enter'))
})

test('sendOnPage: no sendMessage seen — text still in the editor → cleared, sent "no"; editor emptied → sent "unknown"', async () => {
  const stuck = fakePage({ observed: [] })
  const r1 = await sendOnPage(stuck, 'Team A', 'hi', 1000)
  assert.equal(r1.code, 'send_unconfirmed')
  assert.equal(r1.sent, 'no')
  assert.ok(stuck.calls.includes('clearDraft'))

  const vanished = fakePage({ observed: [], enterKeepsDraft: false })
  const r2 = await sendOnPage(vanished, 'Team A', 'hi', 1000)
  assert.equal(r2.code, 'send_unconfirmed')
  assert.equal(r2.sent, 'unknown')
  assert.ok(!vanished.calls.includes('clearDraft'))
})

test('sendOnPage: sendMessage not 200, or to another chat → send_failed, sent "unknown"', async () => {
  const r1 = await sendOnPage(fakePage({ observed: [{ status: 500, to: 'C-target' }] }), 'Team A', 'hi', 1000)
  assert.equal(r1.code, 'send_failed')
  assert.equal(r1.sent, 'unknown')
  assert.match(r1.message, /500/)
  const r2 = await sendOnPage(fakePage({ observed: [{ status: 200, to: 'C-other' }] }), 'Team A', 'hi', 1000)
  assert.equal(r2.code, 'send_failed')
})

test('createChromeLineSender: request validation, todo / chat name lookup, opener errors', async () => {
  const opened = []
  const sender = createChromeLineSender({
    opener: { open: async () => { const p = fakePage(); opened.push(p); return p } },
    resolveChatName: async (todoId) => ({ t1: '  Team A ', t2: null })[todoId]
  })
  assert.equal((await sender.send({ todoId: '', text: 'hi' })).code, 'invalid_request')
  assert.equal((await sender.send({ todoId: 't1', text: '   ' })).code, 'invalid_request')
  assert.equal((await sender.send({ todoId: 't1', text: 'x'.repeat(5001) })).code, 'invalid_request')
  assert.equal((await sender.send(null)).code, 'invalid_request')
  assert.equal((await sender.send({ todoId: 'nope', text: 'hi' })).code, 'todo_not_found')
  assert.equal((await sender.send({ todoId: 't2', text: 'hi' })).code, 'chat_name_missing')
  assert.equal(opened.length, 0, 'nothing connects before the request and chat name check out')

  const ok = await sender.send({ todoId: 't1', text: 'hi' })
  assert.deepEqual(ok, { ok: true, chatName: 'Team A', chatMid: 'C-target' })
  assert.equal(opened.length, 1)
  assert.equal(opened[0].calls.at(-1), 'close', 'the page connection is closed afterwards')

  const down = createChromeLineSender({
    opener: { open: async () => { throw new ChromeLineError('browser_unreachable', '連不上 LINE 背景 Chrome') } },
    resolveChatName: async () => 'Team A'
  })
  const r = await down.send({ todoId: 't1', text: 'hi' })
  assert.equal(r.code, 'browser_unreachable')
  assert.equal(r.stage, 'connect')
  assert.equal(r.sent, 'no')
  const st = await down.status()
  assert.deepEqual(st, { ready: false, code: 'browser_unreachable', message: '連不上 LINE 背景 Chrome' })
})

test('createChromeLineSender: an exception after Enter is reported as "unknown", one send at a time', async () => {
  const crashing = createChromeLineSender({ opener: { open: async () => fakePage({ enterThrows: true }) }, resolveChatName: async () => 'Team A' })
  const r = await crashing.send({ todoId: 't1', text: 'hi' })
  assert.equal(r.code, 'internal')
  assert.equal(r.stage, 'send')
  assert.equal(r.sent, 'unknown')

  let release
  const gate = new Promise((resolve) => { release = resolve })
  const slow = createChromeLineSender({ opener: { open: async () => { await gate; return fakePage() } }, resolveChatName: async () => 'Team A' })
  const first = slow.send({ todoId: 't1', text: 'hi' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal((await slow.send({ todoId: 't1', text: 'again' })).code, 'busy')
  release()
  assert.equal((await first).ok, true)
})

test('dispatcher: the chromeLine group routes to the sender; without one the paths answer chrome_line_unavailable', async () => {
  assert.equal(backendMethodFor('chromeLine.send'), 'chromeLine')
  assert.equal(backendMethodFor('chromeLine.status'), 'chromeLine')
  const base = { getApi: () => ({}), hub: {}, queue: {}, info: () => ({}) }
  const seen = []
  const withSender = new Dispatcher({
    ...base,
    chromeLine: {
      status: async () => ({ ready: true, code: null, message: null }),
      send: async (req) => { seen.push(req); return { ok: true, chatName: 'Team A', chatMid: 'C-target' } }
    }
  })
  const sent = await withSender.call('chromeLine', { path: 'chromeLine.send', args: [{ todoId: 't1', text: 'hi' }] })
  assert.equal(sent.ok, true)
  assert.deepEqual(sent.value, { ok: true, chatName: 'Team A', chatMid: 'C-target' })
  assert.deepEqual(seen, [{ todoId: 't1', text: 'hi' }])
  assert.equal((await withSender.call('db.todos', { path: 'chromeLine.send', args: [] })).code, 'method_mismatch')

  const without = new Dispatcher(base)
  assert.equal((await without.call('chromeLine', { path: 'chromeLine.status' })).code, 'chrome_line_unavailable')
  withSender.dispose()
  without.dispose()
})
