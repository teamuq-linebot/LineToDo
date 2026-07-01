// 最終回歸驗收 probe：reviewer 修復 F1/F3/F4/F5/F6（todo-not-converted-20260629）。
//
// 沿用既有 probe 範式（esbuild bundle TS entry → electron main require → temp DB，自動清理）。
// 涵蓋（每條斷言印 期望 vs 實際 + PASS/FAIL）：
//   F1  reclassifyTodo idempotent：對同卡連呼兩次相同目標 → 第 2 次回 0 且 updated_at 不變。
//   F1e 端到端 runOnce：round2 升級 schedule（updatedIds 含該卡），round3 再注入相同 updates
//       → result.updatedIds 應為空、該卡 updated_at 不變（不抖動）。
//   F3  同輪 resolved + updates 指向同一 id → 走 resolved（status→done），updates 被跳過、bucket 不被覆寫。
//   F4  已是 schedule 且具體 dueAt 的卡，送 dueAt=null → DB dueAt 不被抹。
//   F5b bucket=schedule/status=scheduled 送 bucket=todo → status 全向同步成 pending（且 dueAt 保留）。
//   F5s status='suggested_done' 升級 → desiredStatus 保留 suggested_done（不被覆成 active）。
//   F6  backfill reviewLastDays（DI）含 updates 情境 → 既有 openTodo 被 reclassify 成 schedule。
//
// 由 `npx electron scripts/probe-reclassify-regression.cjs` 執行。全綠 exit 0。

const { app } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const esbuild = require('esbuild')

const ENTRY = `
export { getDb, closeDb } from './src/main/db/database.ts'
export { upsertChat } from './src/main/db/chats.repo.ts'
export { createTodo, getTodo, reclassifyTodo, getOpenTodosByChat, listTodos, countTodos } from './src/main/db/todos.repo.ts'
export { runOnce } from './src/main/pipeline/runOnce.ts'
export { fixedWatchSource } from './src/main/pipeline/scheduler.ts'
export { reviewLastDays } from './src/main/pipeline/backfill.ts'
export { getPipelineDefaults } from './src/main/config/defaults.ts'
`

const NOW_ISO = '2026-06-26T16:00:00'
const FUTURE = '2026-07-01T14:00:00'

const results = []
function assert(name, pass, expected, actual) {
  results.push({ name, pass: !!pass })
  console.log(
    `[probe-rcr] ${pass ? 'PASS' : 'FAIL'} ${name}\n          expected=${JSON.stringify(expected)}\n          actual  =${JSON.stringify(actual)}`
  )
}
function eq(name, expected, actual) {
  assert(name, JSON.stringify(expected) === JSON.stringify(actual), expected, actual)
}

// 建一則 RawLineMessage（與既有 probe 形狀一致，供 insertMessages 使用）。
function msg(chatId, name, ts, text) {
  return { chat: name, chatId, isGroup: false, ts, time: new Date(ts).toISOString(), direction: 'in', sender: name, text, contentType: 0 }
}

app.whenReady().then(async () => {
  const root = path.join(__dirname, '..')
  const entryFile = path.join(root, '__rcr_entry.ts')
  const outFile = path.join(root, '__rcr.bundle.cjs')
  const cleanup = () => {
    try { fs.rmSync(entryFile, { force: true }) } catch (_) {}
    try { fs.rmSync(outFile, { force: true }) } catch (_) {}
  }
  let tmpDir = null
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-todo-rcr-'))
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
    console.log('[probe-rcr] db-ready=' + process.env.LINE_TODO_DB_PATH)
    const cfg = m.getPipelineDefaults()

    // ── F1：reclassifyTodo idempotent（直接）──────────────────
    m.upsertChat({ chatId: 'c-f1', name: 'F1', isGroup: false, seenAt: NOW_ISO })
    const f1 = m.createTodo({ chatId: 'c-f1', bucket: 'todo', status: 'pending', title: 'F1 卡', dueAt: null })
    const f1c1 = m.reclassifyTodo(f1.id, { bucket: 'schedule', dueAt: FUTURE })
    const f1a1 = m.getTodo(f1.id)
    eq('F1.第1次 changes', 1, f1c1)
    eq('F1.第1次 bucket/status/dueAt', { b: 'schedule', s: 'scheduled', d: FUTURE }, { b: f1a1.bucket, s: f1a1.status, d: f1a1.dueAt })
    const updatedAtAfter1 = f1a1.updatedAt
    const f1c2 = m.reclassifyTodo(f1.id, { bucket: 'schedule', dueAt: FUTURE })
    const f1a2 = m.getTodo(f1.id)
    eq('F1.第2次相同目標 changes (idempotent 回 0)', 0, f1c2)
    eq('F1.第2次 updated_at 不變', updatedAtAfter1, f1a2.updatedAt)

    // ── F1e：端到端 runOnce 不抖動 ───────────────────────────
    const C = 'ue2e-f1'
    // round1：建立 bucket=todo openTodo
    await m.runOnce({
      watchSource: m.fixedWatchSource([msg(C, '客戶F1', 1719381600000, '找時間開會')], 'ok'),
      extractFn: async () => ({ importance: 'action', newTodos: [{ bucket: 'todo', title: 'F1e 約開會', detail: null, priority: 2, dueAt: null, confidence: 0.8, sourceMsgIds: ['x'] }], resolved: [], updates: [] }),
      config: cfg, now: () => NOW_ISO
    })
    const open1 = m.getOpenTodosByChat(C).find((t) => t.bucket === 'todo')
    // round2：升級成 schedule
    const r2 = await m.runOnce({
      watchSource: m.fixedWatchSource([msg(C, '客戶F1', 1719385200000, '約 7/1 兩點')], 'ok'),
      extractFn: async (input) => {
        const o = input.openTodos.find((t) => t.bucket === 'todo')
        return { importance: 'action', newTodos: [], resolved: [], updates: o ? [{ todoId: o.id, bucket: 'schedule', dueAt: FUTURE, evidence: '敲定' }] : [] }
      },
      config: cfg, now: () => NOW_ISO
    })
    const afterR2 = m.getTodo(open1.id)
    assert('F1e.round2 updatedIds 含該卡', r2.updatedIds.includes(open1.id), open1.id, r2.updatedIds)
    eq('F1e.round2 升級為 schedule/scheduled/FUTURE', { b: 'schedule', s: 'scheduled', d: FUTURE }, { b: afterR2.bucket, s: afterR2.status, d: afterR2.dueAt })
    const updatedAtR2 = afterR2.updatedAt
    // round3：再注入相同 updates（卡已是 schedule）→ 應 no-op、不抖動
    const r3 = await m.runOnce({
      watchSource: m.fixedWatchSource([msg(C, '客戶F1', 1719388800000, '再提一次')], 'ok'),
      extractFn: async (input) => {
        const o = input.openTodos.find((t) => t.bucket === 'schedule')
        return { importance: 'action', newTodos: [], resolved: [], updates: o ? [{ todoId: o.id, bucket: 'schedule', dueAt: FUTURE, evidence: '重提' }] : [] }
      },
      config: cfg, now: () => NOW_ISO
    })
    const afterR3 = m.getTodo(open1.id)
    eq('F1e.round3 updatedIds 為空 (不抖動)', [], r3.updatedIds)
    eq('F1e.round3 updated_at 不變', updatedAtR2, afterR3.updatedAt)

    // ── F3：同輪 resolved + updates 同 id → resolved 勝、updates 跳過 ──
    const CF3 = 'ue2e-f3'
    await m.runOnce({
      watchSource: m.fixedWatchSource([msg(CF3, '客戶F3', 1719381600000, '幫我處理 X')], 'ok'),
      extractFn: async () => ({ importance: 'action', newTodos: [{ bucket: 'todo', title: 'F3 待辦', detail: null, priority: 2, dueAt: null, confidence: 0.8, sourceMsgIds: ['x'] }], resolved: [], updates: [] }),
      config: cfg, now: () => NOW_ISO
    })
    const f3open = m.getOpenTodosByChat(CF3).find((t) => t.bucket === 'todo')
    const rF3 = await m.runOnce({
      watchSource: m.fixedWatchSource([msg(CF3, '客戶F3', 1719385200000, 'X 做好了，順便排程')], 'ok'),
      extractFn: async (input) => {
        const o = input.openTodos.find((t) => t.bucket === 'todo')
        return {
          importance: 'action', newTodos: [],
          resolved: o ? [{ todoId: o.id, evidence: 'X 已完成' }] : [],
          updates: o ? [{ todoId: o.id, bucket: 'schedule', dueAt: FUTURE, evidence: '又想升級' }] : []
        }
      },
      config: cfg, now: () => NOW_ISO
    })
    const f3after = m.getTodo(f3open.id)
    eq('F3.status 走 resolved → done', 'done', f3after.status)
    eq('F3.bucket 未被 updates 覆寫 (維持 todo)', 'todo', f3after.bucket)
    assert('F3.updatedIds 不含該卡 (updates 被跳過)', !rF3.updatedIds.includes(f3open.id), 'not include ' + f3open.id, rF3.updatedIds)
    assert('F3.resolvedIds 含該卡', rF3.resolvedIds.includes(f3open.id), f3open.id, rF3.resolvedIds)
    eq('F3.todosResolvedDone', 1, rF3.todosResolvedDone)

    // ── F4：dueAt=null 不抹既有 due_at（直接）──────────────────
    m.upsertChat({ chatId: 'c-f4', name: 'F4', isGroup: false, seenAt: NOW_ISO })
    const f4 = m.createTodo({ chatId: 'c-f4', bucket: 'schedule', status: 'scheduled', title: 'F4 行程', dueAt: FUTURE })
    const f4c = m.reclassifyTodo(f4.id, { bucket: 'schedule', dueAt: null })
    const f4a = m.getTodo(f4.id)
    eq('F4.changes (全相同→no-op 0)', 0, f4c)
    eq('F4.dueAt 不被 null 抹掉', FUTURE, f4a.dueAt)

    // ── F5b：schedule→todo 全向同步 status=pending，且 dueAt 保留 ──
    const f5 = m.createTodo({ chatId: 'c-f4', bucket: 'schedule', status: 'scheduled', title: 'F5b 卡', dueAt: FUTURE })
    const f5c = m.reclassifyTodo(f5.id, { bucket: 'todo', dueAt: null })
    const f5a = m.getTodo(f5.id)
    eq('F5b.changes', 1, f5c)
    eq('F5b.bucket→todo / status→pending（全向同步）', { b: 'todo', s: 'pending' }, { b: f5a.bucket, s: f5a.status })
    eq('F5b.dueAt 仍保留 (dueAt=null 不抹)', FUTURE, f5a.dueAt)

    // ── F5s：suggested_done 升級時保留 suggested_done ──────────
    const f5s = m.createTodo({ chatId: 'c-f4', bucket: 'todo', status: 'suggested_done', title: 'F5s 卡', dueAt: null })
    const f5sc = m.reclassifyTodo(f5s.id, { bucket: 'schedule', dueAt: FUTURE })
    const f5sa = m.getTodo(f5s.id)
    eq('F5s.changes', 1, f5sc)
    eq('F5s.bucket→schedule 但 status 保留 suggested_done', { b: 'schedule', s: 'suggested_done', d: FUTURE }, { b: f5sa.bucket, s: f5sa.status, d: f5sa.dueAt })

    // ── F6：backfill reviewLastDays（DI）updates 路徑 ──────────
    const nowMs = Date.parse('2026-06-29T08:00:00Z')
    const DAY = 24 * 60 * 60 * 1000
    const sinceMs = nowMs - 7 * DAY
    const CF6 = 'ue2e-f6'
    // 兩則訊息跨兩個日切片（day0 / day1），觸發 day1 對 day0 所建 todo 的 updates。
    const winMsgs = [
      msg(CF6, '客戶F6', sinceMs + 3600 * 1000, '我們找時間開會'),
      msg(CF6, '客戶F6', sinceMs + DAY + 3600 * 1000, '就約 7/1 下午兩點')
    ]
    const extractF6 = async (input) => {
      const o = input.openTodos.find((t) => t.bucket === 'todo')
      if (o) {
        return { importance: 'action', newTodos: [], resolved: [], updates: [{ todoId: o.id, bucket: 'schedule', dueAt: FUTURE, evidence: '時間敲定' }] }
      }
      return { importance: 'action', newTodos: [{ bucket: 'todo', title: 'F6 約開會', detail: null, priority: 2, dueAt: null, confidence: 0.8, sourceMsgIds: [input.newMessages[0].msgId] }], resolved: [], updates: [] }
    }
    const rF6 = await m.reviewLastDays(7, {
      fetchWindow: async () => ({ messages: winMsgs }),
      extractFn: extractF6,
      db: m.getDb(),
      now: () => nowMs,
      config: cfg
    })
    eq('F6.todosCreated', 1, rF6.todosCreated)
    const f6id = rF6.createdIds[0]
    const f6card = f6id ? m.getTodo(f6id) : null
    assert('F6.updatedIds 含被升級的 todo', !!(f6id && rF6.updatedIds.includes(f6id)), f6id, rF6.updatedIds)
    eq('F6.既有 openTodo 被 reclassify 成 schedule/scheduled/FUTURE', { b: 'schedule', s: 'scheduled', d: FUTURE }, f6card ? { b: f6card.bucket, s: f6card.status, d: f6card.dueAt } : null)

    // ── 收尾 ──
    const failed = results.filter((r) => !r.pass)
    const ok = failed.length === 0
    console.log('[probe-rcr] SUMMARY total=' + results.length + ' pass=' + (results.length - failed.length) + ' fail=' + failed.length)
    if (failed.length) console.log('[probe-rcr] FAILED: ' + failed.map((f) => f.name).join(' | '))
    console.log('[probe-rcr] ALL-ASSERTIONS-PASS=' + ok)
    m.closeDb()
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
    cleanup()
    app.exit(ok ? 0 : 1)
  } catch (err) {
    console.error('[probe-rcr] FAILED: ' + (err && err.stack ? err.stack : err))
    try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
    cleanup()
    app.exit(1)
  }
})
