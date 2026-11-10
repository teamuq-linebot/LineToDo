// 「重新整理最近 N 天」排隊：不同聊天室 FIFO 依序跑、同一聊天室不重複加入、狀態查詢、守門在排隊前完成、畫面錯誤碼映射。
// 時間固定（NOW），AI 一律用假函式；排隊本身以 Promise 閘門控制，不依賴牆鐘。
import assert from 'node:assert/strict'
import test from 'node:test'

import { openDatabase } from '../../src/main/db/database.ts'
import { insertMessages } from '../../src/main/db/messages.repo.ts'
import { ensureChatTodoPrefsSchema, setTodoExtractEnabled } from '../../src/main/db/chatTodoPrefs.repo.ts'
import { precheckChatRefresh, refreshChatLastDays } from '../../src/main/pipeline/chatRefresh.ts'
import { ChatRefreshQueue } from '../../src/core/chatRefreshQueue.ts'
import { refreshCodeText, refreshErrorText, refreshFailureText } from '../../src/renderer/features/chatRefresh/refreshFailure.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 10, 3, 0, 0)
const flush = () => new Promise((resolve) => setTimeout(resolve, 15))
const NOOP_RESULT = { importance: 'noise', newTodos: [], identityDecisions: [], resolved: [], updates: [] }

function open() {
  const db = openDatabase({ dbPath: ':memory:' }).db
  ensureChatTodoPrefsSchema(db)
  return db
}

function raw(id, chatId, ts, text = '請準備簡報') {
  return { msgId: id, chat: `Chat ${chatId}`, chatId, isGroup: true, ts, time: new Date(ts).toISOString(), direction: 'in', sender: 'Alice', text, contentType: 0 }
}

function gate() {
  let open = null
  const promise = new Promise((resolve) => { open = resolve })
  return { promise, open }
}

test('不同聊天室依 FIFO 排隊：第二個等第一個跑完才開始，狀態為 queued(前面 1 個)', async () => {
  const queue = new ChatRefreshQueue()
  const log = []
  const first = gate()
  const a = queue.enqueue('A', async () => { log.push('A start'); await first.promise; log.push('A end'); return 'a' })
  const b = queue.enqueue('B', async () => { log.push('B start'); log.push('B end'); return 'b' })
  assert.deepEqual(queue.status('A'), { state: 'running', ahead: 0 })
  assert.deepEqual(queue.status('B'), { state: 'queued', ahead: 1 })
  assert.deepEqual(log, ['A start'])
  first.open()
  assert.equal(await a, 'a')
  assert.equal(await b, 'b')
  assert.deepEqual(log, ['A start', 'A end', 'B start', 'B end'])
  assert.deepEqual(queue.status('A'), { state: 'idle', ahead: 0 })
  assert.deepEqual(queue.status('B'), { state: 'idle', ahead: 0 })
})

test('同一聊天室已在排隊或執行中：再次加入回 null，不重複執行', async () => {
  const queue = new ChatRefreshQueue()
  const runs = { A: 0, B: 0 }
  const hold = gate()
  const a = queue.enqueue('A', async () => { runs.A += 1; await hold.promise; return 'a' })
  assert.equal(queue.enqueue('A', async () => { runs.A += 1; return 'again' }), null, '執行中的聊天室不重複加入')
  const b = queue.enqueue('B', async () => { runs.B += 1; return 'b' })
  assert.notEqual(b, null)
  assert.equal(queue.enqueue('B', async () => { runs.B += 1; return 'b2' }), null, '排隊中的聊天室不重複加入')
  assert.deepEqual(queue.status('B'), { state: 'queued', ahead: 1 })
  hold.open()
  await Promise.all([a, b])
  assert.deepEqual(runs, { A: 1, B: 1 })
  assert.notEqual(queue.enqueue('A', async () => 'again-after-done'), null, '結束後可以再加入')
})

test('回顧進行中（isBlocked）：重新整理先排隊等，回顧結束後才開始', async () => {
  let blocked = true
  const queue = new ChatRefreshQueue({ isBlocked: () => blocked, pollMs: 5 })
  const started = []
  const p = queue.enqueue('A', async () => { started.push('A'); return 'ok' })
  await flush()
  assert.deepEqual(started, [], '回顧還在跑，不開始')
  assert.deepEqual(queue.status('A'), { state: 'queued', ahead: 0 })
  blocked = false
  assert.equal(await p, 'ok')
  assert.deepEqual(started, ['A'])
})

test('工作丟錯誤：該筆 reject，後面的仍會依序執行', async () => {
  const queue = new ChatRefreshQueue()
  const bad = queue.enqueue('A', async () => { throw new Error('extract_await_timeout') })
  const good = queue.enqueue('B', async () => 'b')
  await assert.rejects(bad, /extract_await_timeout/)
  assert.equal(await good, 'b')
  assert.deepEqual(queue.status('A'), { state: 'idle', ahead: 0 })
})

test('狀態查詢：從未加入的聊天室是 idle；多個排隊時 ahead 依序增加（含執行中的一個）', () => {
  const queue = new ChatRefreshQueue()
  const hold = gate()
  queue.enqueue('A', () => hold.promise)
  queue.enqueue('B', () => hold.promise)
  queue.enqueue('C', () => hold.promise)
  assert.deepEqual(queue.status('Z'), { state: 'idle', ahead: 0 })
  assert.deepEqual(queue.status('A'), { state: 'running', ahead: 0 })
  assert.deepEqual(queue.status('B'), { state: 'queued', ahead: 1 })
  assert.deepEqual(queue.status('C'), { state: 'queued', ahead: 2 })
  hold.open()
})

test('守門在排隊前完成：AI 未就緒 → 立即 ai_unavailable，不送任何請求；就緒 → null（可排隊）', async () => {
  const db = open()
  insertMessages([raw('a1', 'A', NOW - DAY)], db)
  setTodoExtractEnabled(db, 'A', true)
  const calls = []
  const extractFn = async (input) => { calls.push(input.newMessages.map((m) => m.msgId)); return NOOP_RESULT }
  const early = await precheckChatRefresh('A', 7, { db, nowFn: () => NOW, extractFn, aiReady: async () => false })
  assert.equal(early.ok, false)
  assert.equal(early.reason, 'ai_unavailable')
  assert.equal(calls.length, 0)
  assert.equal(await precheckChatRefresh('A', 7, { db, nowFn: () => NOW, extractFn, aiReady: async () => true }), null)
  assert.equal((await precheckChatRefresh('A', 0, { db, nowFn: () => NOW, extractFn })).reason, 'invalid_days')
  assert.equal((await precheckChatRefresh('Nope', 7, { db, nowFn: () => NOW, extractFn })).reason, 'unsupported_chat')
  setTodoExtractEnabled(db, 'A', false)
  assert.equal((await precheckChatRefresh('A', 7, { db, nowFn: () => NOW, extractFn })).reason, 'disabled')
})

test('兩個聊天室連續觸發：第二個排隊，依序完成，兩個結果都正確（經 refreshChatLastDays）', async () => {
  const db = open()
  insertMessages([raw('a1', 'A', NOW - DAY), raw('b1', 'B', NOW - DAY)], db)
  setTodoExtractEnabled(db, 'A', true)
  setTodoExtractEnabled(db, 'B', true)
  const order = []
  const hold = gate()
  const extractFn = async (input) => {
    const chatId = input.chat.chatId
    order.push(`${chatId} start`)
    if (chatId === 'A') await hold.promise
    order.push(`${chatId} end`)
    return NOOP_RESULT
  }
  const deps = { db, nowFn: () => NOW, extractFn, aiReady: async () => true }
  const queue = new ChatRefreshQueue()
  const pa = queue.enqueue('A', () => refreshChatLastDays('A', 7, deps))
  const pb = queue.enqueue('B', () => refreshChatLastDays('B', 7, deps))
  await flush()
  assert.deepEqual(queue.status('B'), { state: 'queued', ahead: 1 })
  assert.deepEqual(order, ['A start'])
  hold.open()
  const [ra, rb] = await Promise.all([pa, pb])
  assert.equal(ra.ok, true)
  assert.equal(rb.ok, true)
  assert.equal(ra.todo.failed, false)
  assert.equal(rb.todo.failed, false)
  assert.deepEqual(order, ['A start', 'A end', 'B start', 'B end'])
})

test('畫面錯誤碼映射：AI 無法使用、AI 忙碌、逾時、後端未就緒、busy 各有短字', () => {
  for (const code of ['ai_unavailable', 'transport', 'plugin_host_unavailable', 'plugin_host_timeout', 'timeout', 'extract_await_timeout', 'not_authenticated']) {
    assert.equal(refreshCodeText(code), 'AI 無法使用', code)
  }
  for (const code of ['rate_limited', 'quota_exceeded', 'quota_exhausted']) assert.equal(refreshCodeText(code), 'AI 忙碌中，稍後再試', code)
  assert.equal(refreshCodeText('busy'), '另一項工作進行中，請稍後再試')
  assert.equal(refreshCodeText('view_call_timeout'), '逾時，請稍後再試')
  for (const code of ['backend_stopped', 'runtime_not_running', 'disposed']) assert.equal(refreshCodeText(code), '後端未就緒，請稍後再試', code)
})

test('畫面錯誤碼映射：未知 code 才是通用文案', () => {
  for (const code of ['api_error', 'some_future_code', 'job_not_found', '']) {
    assert.equal(refreshCodeText(code), undefined, `${code} 沒有專屬短字`)
    assert.equal(refreshErrorText(code), '重新整理失敗，請稍後再試', code)
  }
  assert.equal(refreshErrorText('busy'), '另一項工作進行中，請稍後再試', '已知 code 不會被通用文案蓋掉')
})

test('結果映射沿用：部分失敗與原因短字不變', () => {
  assert.equal(refreshFailureText({ reason: undefined, todo: { failed: true, reason: 'todo_identity_index_building' }, topics: { failed: false } }), '部分重新整理失敗，請稍後再試')
  assert.equal(refreshFailureText({ reason: 'already_queued', todo: { failed: false }, topics: { failed: false } }), '重新整理失敗，請稍後再試')
})
