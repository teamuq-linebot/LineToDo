// H1 抖動修正實機複驗（Tester harness，不改 App 原始碼）。
//
// 驗的是 runOnce.ts 的 idempotent guard（src/main/pipeline/runOnce.ts:309）：
//   if (target.status === 'suggested_done' || target.status === 'done') continue
// 配合 index.ts 的 emit 規則（src/main/index.ts:94-104）：
//   只有 createdIds||resolvedIds||updatedIds 非空才 pushToRenderer('evt:todos-changed')。
//
// 場景（同一 chat umom、同一個 schedule todo、due 在未來）：
//   R1：mock 產生一筆 schedule todo（dueAt 未來）。
//   R2：mock 把該 openTodo 列入 resolved → schedule 且 due 未來 → 降 suggested_done（第一次降，合理 emit）。
//   R3：mock「又」把同一 todoId 列入 resolved（模擬模型每輪重列入 → 抖動來源）。
//       期望：guard 擋下 → resolvedIds=[] → 不 emit todos-changed、不重呼 resolveTodo、updated_at 不變。
//
// 直接驅動「真正的」runOnce + repos（非重寫），注入 mock extractFn；
// 用與 index.ts 完全相同的判定式當 oracle，模擬 scheduler.on('run') 是否會 emit todos-changed。
// 由 `npx electron scripts/tester/h1-jitter-dryrun.cjs` 執行。

const { app } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const esbuild = require('esbuild')

const ENTRY = `
export { runOnce } from './src/main/pipeline/runOnce.ts'
export { fixedWatchSource } from './src/main/pipeline/scheduler.ts'
export { getDb, closeDb } from './src/main/db/database.ts'
export { getOpenTodosByChat, getTodo } from './src/main/db/todos.repo.ts'
`

const NOW = '2026-06-26T16:00:00' // due 設 2026-06-27，相對 now 仍在未來

const MSGS_R1 = [
  { msgId: 'm-r1', chat: '媽', chatId: 'umom', isGroup: false, ts: 1719381720000, time: '2026-06-26T15:42:00', direction: 'in', sender: '媽', text: '明天晚上七點回家吃飯', contentType: 0 }
]
const MSGS_R2 = [
  { msgId: 'm-r2', chat: '媽', chatId: 'umom', isGroup: false, ts: 1719385200000, time: '2026-06-26T16:40:00', direction: 'in', sender: '媽', text: '今天不回來了喔', contentType: 0 }
]
const MSGS_R3 = [
  { msgId: 'm-r3', chat: '媽', chatId: 'umom', isGroup: false, ts: 1719388800000, time: '2026-06-26T17:40:00', direction: 'in', sender: '媽', text: '嗯嗯', contentType: 0 }
]

// index.ts:94-104 emit 判定式的原樣副本（oracle）：模擬 scheduler.on('run') → 是否 push evt:todos-changed。
function wouldEmitTodosChanged(result) {
  return Boolean(result.createdIds.length || result.resolvedIds.length || result.updatedIds.length)
}

function makeExtract(round, getOpenTodosByChat, db) {
  return async (input) => {
    if (input.chat.chatId !== 'umom') return { importance: 'noise', newTodos: [], resolved: [] }
    if (round === 1) {
      return {
        importance: 'action',
        newTodos: [
          { bucket: 'schedule', title: '回家吃飯', detail: null, priority: 2, dueAt: '2026-06-27T19:00:00', confidence: 0.85, sourceMsgIds: ['m-r1'] }
        ],
        resolved: []
      }
    }
    // round 2 / 3：把該 chat 唯一的 schedule openTodo 列入 resolved（模型每輪重列入）。
    const sched = getOpenTodosByChat('umom', db).find((t) => t.bucket === 'schedule')
    return {
      importance: 'action',
      newTodos: [],
      resolved: sched ? [{ todoId: sched.id, evidence: 'round' + round + ' 模型重列入 resolved（抖動測試）' }] : []
    }
  }
}

app.whenReady().then(async () => {
  const root = path.join(__dirname, '..', '..')
  const entryFile = path.join(root, '__h1_entry.ts')
  const outFile = path.join(root, '__h1.bundle.cjs')
  const cleanup = () => {
    try { fs.rmSync(entryFile, { force: true }) } catch (_) {}
    try { fs.rmSync(outFile, { force: true }) } catch (_) {}
  }
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-todo-h1-'))
    process.env.LINE_TODO_DB_PATH = path.join(tmpDir, 'line-todo.db')
    delete process.env.QWEN_API_KEY

    fs.writeFileSync(entryFile, ENTRY, 'utf8')
    await esbuild.build({
      entryPoints: [entryFile], bundle: true, platform: 'node', format: 'cjs',
      outfile: outFile, external: ['electron', 'better-sqlite3', 'openai'],
      absWorkingDir: root, logLevel: 'silent'
    })
    const m = require(outFile)
    const db = m.getDb()
    console.log('[h1] db-ready=' + process.env.LINE_TODO_DB_PATH)

    const emitLog = []
    const record = (round, result) =>
      emitLog.push({
        round,
        emit: wouldEmitTodosChanged(result),
        resolvedIds: result.resolvedIds.slice(),
        createdIds: result.createdIds.slice(),
        updatedIds: result.updatedIds.slice(),
        suggested: result.todosSuggestedDone,
        done: result.todosResolvedDone
      })

    // R1：建 schedule todo
    const r1 = await m.runOnce({ watchSource: m.fixedWatchSource(MSGS_R1, 'ok'), extractFn: makeExtract(1, m.getOpenTodosByChat, db), now: () => NOW })
    record(1, r1)
    const todoSched = m.getOpenTodosByChat('umom', db).find((t) => t.bucket === 'schedule')
    console.log('[h1] R1 schedule todo id=' + (todoSched && todoSched.id) + ' status=' + (todoSched && todoSched.status) + ' due=' + (todoSched && todoSched.dueAt))

    // R2：列入 resolved → schedule 未來 due → 降 suggested_done（第一次降，合理 emit）
    const r2 = await m.runOnce({ watchSource: m.fixedWatchSource(MSGS_R2, 'ok'), extractFn: makeExtract(2, m.getOpenTodosByChat, db), now: () => NOW })
    record(2, r2)
    const afterR2 = m.getTodo(todoSched.id, db)
    console.log('[h1] R2 status=' + afterR2.status + ' updatedAt=' + afterR2.updatedAt + ' resolvedIds=' + JSON.stringify(r2.resolvedIds))

    // R3：模型又列入同一 resolved（抖動）。guard 應擋下。
    const r3 = await m.runOnce({ watchSource: m.fixedWatchSource(MSGS_R3, 'ok'), extractFn: makeExtract(3, m.getOpenTodosByChat, db), now: () => NOW })
    record(3, r3)
    const afterR3 = m.getTodo(todoSched.id, db)
    console.log('[h1] R3 status=' + afterR3.status + ' updatedAt=' + afterR3.updatedAt + ' resolvedIds=' + JSON.stringify(r3.resolvedIds))

    console.log('[h1] emitLog=' + JSON.stringify(emitLog))

    const emitOf = (round) => (emitLog.find((x) => x.round === round) || {}).emit

    // ── 斷言 ──
    const checks = {
      r2EmittedOnce: emitOf(2) === true,                                  // 第一次降 suggested_done → 應 emit
      r2BecameSuggested: afterR2.status === 'suggested_done',             // schedule 未來 due → suggested_done（非 done）
      r3NoEmit: emitOf(3) === false,                                      // 抖動輪 → 不 emit todos-changed
      r3ResolvedIdsEmpty: r3.resolvedIds.length === 0,                    // guard 擋下，沒 push resolvedIds
      r3NoReResolve: r3.todosResolvedDone === 0 && r3.todosSuggestedDone === 0, // 沒再呼 resolveTodo
      r3UpdatedAtUnchanged: afterR2.updatedAt === afterR3.updatedAt,      // updated_at 不變 → resolveTodo 確未被呼叫
      r3StatusStable: afterR3.status === 'suggested_done',               // 狀態維持
      r3EvidenceNotRewritten: afterR3.completionEvidence === afterR2.completionEvidence // evidence 未被 R3 重寫
    }
    const ok = Object.values(checks).every(Boolean)
    console.log('[h1] checks=' + JSON.stringify(checks))
    console.log('[h1] ALL-ASSERTIONS-PASS=' + ok)

    m.closeDb()
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
    cleanup()
    app.exit(ok ? 0 : 1)
  } catch (err) {
    console.error('[h1] FAILED: ' + (err && err.stack ? err.stack : err))
    cleanup()
    app.exit(1)
  }
})
