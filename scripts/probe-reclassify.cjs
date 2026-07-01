// 驗收 probe：事件型代辦時間確定後自動升級為行程（todo-not-converted-20260629）。
//
// 沿用既有 probe 範式（esbuild bundle TS entry → electron main require → temp DB）。
// 三大斷言區：
//   A) reclassifyTodo（src/main/db/todos.repo.ts）DB 原子操作：
//      A1 pending todo + {bucket:'schedule', dueAt} → 回 1、bucket=schedule、status=scheduled、due_at 更新。
//      A2 status='done'  → 回 0、欄位全不變（含 updated_at）。
//      A3 status='dismissed' → 回 0、欄位全不變。
//   B) parseExtractResult（src/main/llm/schema.ts）：
//      B1 舊式 JSON（無 updates）→ 可解析、updates===[]（.default([]) 生效）。
//      B2 含 updates 的 JSON → 正確解析（todoId/bucket/dueAt/evidence）。
//      B3 updates 內 dueAt:null → 正規化保持 null。
//   C) 端到端 runOnce（依賴注入 extractFn / db）：
//      注入回傳 updates 的 ExtractResult，對既有 openTodo 跑一輪 → 該 todo 被 reclassify 成 schedule/scheduled。
//
// 由 `npx electron scripts/probe-reclassify.cjs` 執行。全綠 exit 0。

const { app } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const esbuild = require('esbuild')

const ENTRY = `
export { getDb, closeDb } from './src/main/db/database.ts'
export { upsertChat } from './src/main/db/chats.repo.ts'
export { createTodo, getTodo, reclassifyTodo, listTodos, getOpenTodosByChat, countTodos } from './src/main/db/todos.repo.ts'
export { parseExtractResult } from './src/main/llm/schema.ts'
export { runOnce } from './src/main/pipeline/runOnce.ts'
export { fixedWatchSource } from './src/main/pipeline/scheduler.ts'
export { getPipelineDefaults } from './src/main/config/defaults.ts'
`

const NOW = '2026-06-26T16:00:00'
const FUTURE = '2026-07-01T14:00:00'

// 斷言收集器：每條印 期望 vs 實際 + PASS/FAIL。
const results = []
function assert(name, pass, expected, actual) {
  results.push({ name, pass: !!pass })
  console.log(
    `[probe-rc] ${pass ? 'PASS' : 'FAIL'} ${name}\n         expected=${JSON.stringify(expected)}\n         actual  =${JSON.stringify(actual)}`
  )
}
function eq(name, expected, actual) {
  assert(name, JSON.stringify(expected) === JSON.stringify(actual), expected, actual)
}

app.whenReady().then(async () => {
  const root = path.join(__dirname, '..')
  const entryFile = path.join(root, '__rc_entry.ts')
  const outFile = path.join(root, '__rc.bundle.cjs')
  const cleanup = () => {
    try { fs.rmSync(entryFile, { force: true }) } catch (_) {}
    try { fs.rmSync(outFile, { force: true }) } catch (_) {}
  }
  let tmpDir = null
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-todo-rc-'))
    process.env.LINE_TODO_DB_PATH = path.join(tmpDir, 'line-todo.db')
    delete process.env.QWEN_API_KEY

    fs.writeFileSync(entryFile, ENTRY, 'utf8')
    await esbuild.build({
      entryPoints: [entryFile], bundle: true, platform: 'node', format: 'cjs',
      outfile: outFile, external: ['electron', 'better-sqlite3', 'openai'],
      absWorkingDir: root, logLevel: 'silent'
    })
    const m = require(outFile)
    m.getDb()
    console.log('[probe-rc] db-ready=' + process.env.LINE_TODO_DB_PATH)

    // chats FK：todos.chat_id 參照 chats，先建 chat。
    m.upsertChat({ chatId: 'c-direct', name: '直接測試', isGroup: false, seenAt: NOW })

    // ── A) reclassifyTodo 直接驗證 ───────────────────────────
    // A1：pending todo 升級成 schedule
    const t1 = m.createTodo({ chatId: 'c-direct', bucket: 'todo', status: 'pending', title: '喬會議時間', dueAt: null })
    const a1changes = m.reclassifyTodo(t1.id, { bucket: 'schedule', dueAt: FUTURE })
    const t1after = m.getTodo(t1.id)
    eq('A1.changes (pending→schedule 回傳異動筆數)', 1, a1changes)
    eq('A1.bucket', 'schedule', t1after.bucket)
    eq('A1.status', 'scheduled', t1after.status)
    eq('A1.dueAt', FUTURE, t1after.dueAt)

    // A2：status='done' → 不動作
    const t2 = m.createTodo({ chatId: 'c-direct', bucket: 'todo', status: 'done', title: '已完成事項', dueAt: null })
    const t2before = m.getTodo(t2.id)
    const a2changes = m.reclassifyTodo(t2.id, { bucket: 'schedule', dueAt: FUTURE })
    const t2after = m.getTodo(t2.id)
    eq('A2.changes (done 不動作回 0)', 0, a2changes)
    eq('A2.bucket 不變', t2before.bucket, t2after.bucket)
    eq('A2.status 不變', 'done', t2after.status)
    eq('A2.dueAt 不變(null)', null, t2after.dueAt)
    eq('A2.updatedAt 不變', t2before.updatedAt, t2after.updatedAt)

    // A3：status='dismissed' → 不動作
    const t3 = m.createTodo({ chatId: 'c-direct', bucket: 'waiting', status: 'dismissed', title: '已忽略事項', dueAt: null })
    const t3before = m.getTodo(t3.id)
    const a3changes = m.reclassifyTodo(t3.id, { bucket: 'schedule', dueAt: FUTURE })
    const t3after = m.getTodo(t3.id)
    eq('A3.changes (dismissed 不動作回 0)', 0, a3changes)
    eq('A3.bucket 不變', t3before.bucket, t3after.bucket)
    eq('A3.status 不變', 'dismissed', t3after.status)
    eq('A3.updatedAt 不變', t3before.updatedAt, t3after.updatedAt)

    // ── B) parseExtractResult ────────────────────────────────
    // B1：舊式 JSON（無 updates）→ updates===[]
    const oldJson = '{"importance":"action","newTodos":[],"resolved":[]}'
    const b1 = m.parseExtractResult(oldJson)
    eq('B1.updates (舊式無 updates → 預設 [])', [], b1.updates)
    eq('B1.importance', 'action', b1.importance)

    // B2：含 updates 的 JSON → 正確解析
    const newJson = JSON.stringify({
      importance: 'action',
      newTodos: [],
      resolved: [],
      updates: [{ todoId: 'x1', bucket: 'schedule', dueAt: FUTURE, evidence: '時間確定為 7/1 下午兩點' }]
    })
    const b2 = m.parseExtractResult(newJson)
    eq('B2.updates.length', 1, b2.updates.length)
    eq('B2.updates[0]', { todoId: 'x1', bucket: 'schedule', dueAt: FUTURE, evidence: '時間確定為 7/1 下午兩點' }, b2.updates[0])

    // B3：updates 內 dueAt:null → 正規化保持 null
    const nullDueJson = JSON.stringify({
      importance: 'action', newTodos: [], resolved: [],
      updates: [{ todoId: 'x2', bucket: 'schedule', dueAt: null, evidence: '改期，時間待定' }]
    })
    const b3 = m.parseExtractResult(nullDueJson)
    eq('B3.updates[0].dueAt (null 保持)', null, b3.updates[0].dueAt)

    // ── C) 端到端 runOnce（DI extractFn / db）─────────────────
    const cfg = m.getPipelineDefaults()
    const E2E_CHAT = 'ue2e'
    // round 1：建立一個 bucket='todo' 的 openTodo（時間未定的事件型代辦）。
    const MSGS1 = [
      { chat: '客戶A', chatId: E2E_CHAT, isGroup: false, ts: 1719381600000, time: '2026-06-26T15:40:00', direction: 'in', sender: '客戶A', text: '我們找時間開個會討論需求', contentType: 0 }
    ]
    const extract1 = async () => ({
      importance: 'action',
      newTodos: [{ bucket: 'todo', title: '與客戶A 約開會時間', detail: null, priority: 2, dueAt: null, confidence: 0.8, sourceMsgIds: ['m1'] }],
      resolved: [],
      updates: []
    })
    const r1 = await m.runOnce({
      watchSource: m.fixedWatchSource(MSGS1, 'ok'), extractFn: extract1,
      config: cfg, now: () => NOW
    })
    const openAfter1 = m.getOpenTodosByChat(E2E_CHAT)
    const eventTodo = openAfter1.find((t) => t.bucket === 'todo')
    eq('C.round1 todosCreated', 1, r1.todosCreated)
    assert('C.round1 建立 bucket=todo/status=pending 的 openTodo', !!(eventTodo && eventTodo.status === 'pending'),
      { bucket: 'todo', status: 'pending' }, eventTodo ? { bucket: eventTodo.bucket, status: eventTodo.status } : null)

    // round 2：新訊息「時間敲定」→ 模型回 updates 指向既有 openTodo → 應 reclassify 成 schedule。
    const MSGS2 = [
      { chat: '客戶A', chatId: E2E_CHAT, isGroup: false, ts: 1719385200000, time: '2026-06-26T16:40:00', direction: 'in', sender: '客戶A', text: '就約 7/1 下午兩點吧', contentType: 0 }
    ]
    const extract2 = (round) => async (input) => {
      const open = input.openTodos.find((t) => t.bucket === 'todo')
      return {
        importance: 'action', newTodos: [], resolved: [],
        updates: open ? [{ todoId: open.id, bucket: 'schedule', dueAt: FUTURE, evidence: '時間敲定 7/1 14:00' }] : []
      }
    }
    const r2 = await m.runOnce({
      watchSource: m.fixedWatchSource(MSGS2, 'ok'), extractFn: extract2(2),
      config: cfg, now: () => NOW
    })
    const upgraded = eventTodo ? m.getTodo(eventTodo.id) : null
    assert('C.round2 updatedIds 含被升級的 todo', !!(eventTodo && r2.updatedIds.includes(eventTodo.id)),
      eventTodo && eventTodo.id, r2.updatedIds)
    eq('C.round2 升級後 bucket', 'schedule', upgraded && upgraded.bucket)
    eq('C.round2 升級後 status', 'scheduled', upgraded && upgraded.status)
    eq('C.round2 升級後 dueAt', FUTURE, upgraded && upgraded.dueAt)
    // 確認沒有意外多長 todo（升級是 in-place 改，不是新增）。
    eq('C.round2 todosCreated', 0, r2.todosCreated)

    // ── 收尾 ──
    const failed = results.filter((r) => !r.pass)
    const ok = failed.length === 0
    console.log('[probe-rc] SUMMARY total=' + results.length + ' pass=' + (results.length - failed.length) + ' fail=' + failed.length)
    console.log('[probe-rc] ALL-ASSERTIONS-PASS=' + ok)
    m.closeDb()
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
    cleanup()
    app.exit(ok ? 0 : 1)
  } catch (err) {
    console.error('[probe-rc] FAILED: ' + (err && err.stack ? err.stack : err))
    try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
    cleanup()
    app.exit(1)
  }
})
