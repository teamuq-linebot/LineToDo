// result_expired — 聊天頁「讀取最近訊息失敗；仍可查看即時訊息：result_expired: the result is no longer available」的重現與修正驗證。
//
// 根因（src/plugin/backend/dispatcher.ts）：超過 64 KiB 的回應切成分段存在 backend 記憶體（`results`），view 用 `result.chunk` 一段一段取回。
//   (1) `prune()` 的筆數上限依「建立順序」淘汰最舊的一筆，而且已經整筆讀完的結果在 TTL 到期前仍佔名額；聊天頁一開就取 1000 則訊息（數十段、最舊），
//       這段期間其他呼叫（待辦清單、聊天室清單、訊息推播後的重新整理…）每一個都產生新的分段結果，超過上限就把還在讀的那一筆擠掉 → `result_expired`。
//   (2) backend 重新啟動（host 重啟 backend 行程）後，新的 dispatcher 沒有舊的 `results`，下一段也是 `result_expired`。
//   (3) src/renderer/platform/pluginTransport.ts 的 `readChunks` 遇到 `result_expired` 直接丟給畫面，沒有重取。
// 修正：dispatcher 淘汰時先淘汰已讀完的、再淘汰最久沒被讀的；transport 對唯讀路徑在 `result_expired` 時整個重取（有次數上限），寫入類路徑不重送。
//
// 本檔用真的 Dispatcher ＋ 真的 PluginTransport，host 用忠實的 JSON／64 KiB 模擬。
import assert from 'node:assert/strict'
import test from 'node:test'

import { Dispatcher } from '../../src/plugin/backend/dispatcher.ts'
import { EventHub } from '../../src/plugin/backend/eventHub.ts'
import { PluginApiError, PluginTransport, RESULT_REPLAYS, isReplaySafePath } from '../../src/renderer/platform/pluginTransport.ts'

const LIMIT = 64 * 1024
const clone = (value) => JSON.parse(JSON.stringify(value ?? null))
const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength

/** 約 800 KB 的訊息清單（約 50 段）與約 100 KB 的待辦清單（約 7 段）。 */
const bigMessages = () => Array.from({ length: 400 }, (_, i) => ({ msgId: `m${i}`, chatId: 'c1', text: `第 ${i} 則：${'很長的內容'.repeat(400)}` }))
const midTodos = () => Array.from({ length: 100 }, (_, i) => ({ id: `t${i}`, title: `待辦 ${i}`, detail: '細節'.repeat(500) }))

function fixture({ dispatcherOptions = {}, apiOverrides = {} } = {}) {
  const calls = { messagesList: 0, todosList: 0, todosUpdate: 0 }
  const api = {
    db: {
      messages: { list: async () => { calls.messagesList += 1; return bigMessages() } },
      todos: {
        list: async () => { calls.todosList += 1; return midTodos() },
        update: async () => { calls.todosUpdate += 1; return midTodos() }
      }
    },
    ...apiOverrides
  }
  const hub = new EventHub()
  const make = () => new Dispatcher({ getApi: () => api, hub, queue: { stats: () => ({}) }, ...dispatcherOptions })
  const state = { dispatcher: make(), hold: null, chunkCalls: 0 }
  const host = {
    backend: {
      async call(method, params) {
        if (bytes(params) > LIMIT) throw new Error('backend_invoke_too_large')
        if (state.hold && params.path === 'result.chunk') await state.hold(params.args[0])
        if (params.path === 'result.chunk') state.chunkCalls += 1
        const wire = clone(await state.dispatcher.call(method, clone(params)))
        if (bytes(wire) > LIMIT) throw new Error('backend_invoke_too_large')
        return wire
      }
    }
  }
  const transport = new PluginTransport({ host })
  return {
    api, calls, state, transport,
    restartBackend() { state.dispatcher.dispose(); state.dispatcher = make() },
    dispose() { transport.close(); state.dispatcher.dispose(); hub.dispose() }
  }
}

test('reproduces the screenshot: a 1000-message read is evicted by a burst of other chunked results (default dispatcher limits)', async () => {
  const f = fixture()
  try {
    // 在第 2 段停住：這時整筆結果還有約 48 段沒讀。
    let reached
    const reachedPromise = new Promise((resolve) => { reached = resolve })
    let release
    const gate = new Promise((resolve) => { release = resolve })
    let heldId = null
    f.state.hold = async (arg) => {
      if (arg.index === 1 && heldId === null) { heldId = arg.resultId; reached(); await gate }
    }
    const messages = f.transport.invoke('db.messages.list', [{ limit: 1000 }])
    await reachedPromise
    // 其他呼叫在這段時間各自產生並讀完一筆分段結果（超過預設筆數上限）。
    for (let i = 0; i < 20; i += 1) assert.equal((await f.transport.invoke('db.todos.list', [])).length, 100)
    release()
    const rows = await messages
    assert.equal(rows.length, 400, 'the message list arrives whole')
    assert.equal(rows[399].msgId, 'm399')
    assert.equal(f.calls.messagesList, 1, 'no replay needed: the dispatcher kept the result being read')
  } finally { f.dispose() }
})

test('dispatcher: at the cap it evicts finished results first, then the least recently read — never the one still being read', async () => {
  let clock = 1_000_000
  const g = fixture({ dispatcherOptions: { now: () => clock, resultTtlMs: 60_000, maxResults: 2 } })
  try {
    const chunk = (resultId, index) => g.state.dispatcher.call('result', { path: 'result.chunk', args: [{ resultId, index }] })
    const list = (group, path) => g.state.dispatcher.call(group, { path, args: [] })
    const a = await list('db.messages', 'db.messages.list')
    clock += 10
    assert.equal((await chunk(a.resultId, 0)).ok, true) // a 讀了一段，還沒讀完
    clock += 10
    const b = await list('db.todos', 'db.todos.list')
    for (let i = 0; i < b.chunks; i += 1) assert.equal((await chunk(b.resultId, i)).ok, true) // b 整筆讀完
    clock += 10
    const c = await list('db.todos', 'db.todos.list') // 超過上限 2：要淘汰 b（已讀完），不是比較舊的 a
    assert.equal((await chunk(a.resultId, 1)).ok, true, 'a, still being read, survives')
    assert.equal((await chunk(b.resultId, 0)).code, 'result_expired', 'b, finished, was evicted')
    clock += 10
    assert.equal((await chunk(c.resultId, 0)).ok, true)
    // 都還沒讀完時，淘汰最久沒被讀的：a 在 c 之後又被讀過，所以再多一筆新的時，被淘汰的是 c
    clock += 10
    assert.equal((await chunk(a.resultId, 2)).ok, true)
    clock += 10
    const d = await list('db.todos', 'db.todos.list')
    clock += 10
    assert.equal((await chunk(a.resultId, 3)).ok, true, 'a was read after c: it stays')
    assert.equal((await chunk(c.resultId, 1)).code, 'result_expired', 'c, least recently read, was evicted')
    assert.equal((await chunk(d.resultId, 0)).ok, true)
  } finally { g.dispose() }
})

test('transport: when the result is gone (backend restarted mid-read) a read-only call is re-fetched and the caller never sees result_expired', async () => {
  const f = fixture()
  try {
    let restarted = false
    f.state.hold = async (arg) => {
      if (arg.index === 3 && !restarted) { restarted = true; f.restartBackend() }
    }
    const rows = await f.transport.invoke('db.messages.list', [{ limit: 1000 }])
    assert.equal(rows.length, 400)
    assert.equal(f.calls.messagesList, 2, 'the call was made again after the result expired')
    assert.equal(f.transport.stats().resultReplays, 1)
  } finally { f.dispose() }
})

test('transport: the re-fetch is bounded — a result that keeps expiring ends in result_expired after RESULT_REPLAYS retries', async () => {
  const f = fixture()
  try {
    f.state.hold = async (arg) => { if (arg.index === 1) f.restartBackend() } // 每次讀到第 2 段都重啟
    await assert.rejects(f.transport.invoke('db.messages.list', [{ limit: 1000 }]), (e) => e instanceof PluginApiError && e.code === 'result_expired')
    assert.equal(f.calls.messagesList, RESULT_REPLAYS + 1)
    assert.equal(f.transport.stats().resultReplays, RESULT_REPLAYS)
  } finally { f.dispose() }
})

test('transport: a write call is never sent twice — result_expired on its (big) answer is reported, not replayed', async () => {
  const f = fixture()
  try {
    f.state.hold = async (arg) => { if (arg.index === 1) f.restartBackend() }
    await assert.rejects(f.transport.invoke('db.todos.update', [{ id: 't1' }]), (e) => e instanceof PluginApiError && e.code === 'result_expired')
    assert.equal(f.calls.todosUpdate, 1, 'the update ran exactly once')
    assert.equal(f.transport.stats().resultReplays, 0)
  } finally { f.dispose() }
})

test('transport: only read-only paths are replay-safe', () => {
  for (const path of ['messages.recent', 'db.messages.list', 'db.messages.recentByChat', 'db.chats.list', 'db.todos.list', 'db.todos.openByChat', 'groupTopics.list', 'groupTopics.overview', 'pipeline.status', 'settings.get']) {
    assert.equal(isReplaySafePath(path), true, path)
  }
  for (const path of ['db.todos.update', 'db.todos.updateStatus', 'db.todos.moveColumn', 'db.todos.draftReply', 'db.todos.markNotMine', 'db.chats.setBlocked', 'settings.update', 'pipeline.runOnce', 'pipeline.reviewLastDays', 'groupTopics.analyze', 'db.todos.identity.resolve', 'result.chunk', 'job.poll']) {
    assert.equal(isReplaySafePath(path), false, path)
  }
})
