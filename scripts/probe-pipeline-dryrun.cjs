// 端到端 dry-run：用「真正的」runOnce + repos（非重寫），注入 MOCK extractFn 證明
// 在無真金鑰下，pipeline 能把 LLM 回應 upsert 進 todos 表，並做去重 / 完成偵測。
//
// 流程：
//   1) esbuild 把 entry（re-export runOnce + repos + scheduler + extractor + schema）打成 CJS，
//      external electron / better-sqlite3 / openai（runtime 提供）。
//   2) Electron main require 該 bundle，LINE_TODO_DB_PATH 指向 temp DB。
//   3) 第一輪：固定 watchSource 餵 4 chat 的訊息 + mock extractFn 回 newTodos/resolved。
//      斷言 todos 真的進 DB、bucket→status 正確、schedule 未來 → suggested_done。
//   4) 第二輪：同樣訊息再餵一次（msg 去重）+ mock 回「標題等同既有」→ 斷言走「merge 既有」非新增。
//   5) resolved：mock 回某 openTodo 已完成 → 斷言 status=done + completion_evidence。
//   6) 印 [probe-pipe] 證據；全綠 exit 0。
// 由 `npx electron scripts/probe-pipeline-dryrun.cjs` 執行。

const { app } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const esbuild = require('esbuild')

const ENTRY = `
export { runOnce } from './src/main/pipeline/runOnce.ts'
export { fixedWatchSource } from './src/main/pipeline/scheduler.ts'
export { getDb, closeDb } from './src/main/db/database.ts'
export { listTodos, getOpenTodosByChat, countTodos } from './src/main/db/todos.repo.ts'
export { listChats } from './src/main/db/chats.repo.ts'
export { countMessages } from './src/main/db/messages.repo.ts'
export { getLastRun } from './src/main/db/pipeline.repo.ts'
export { parseExtractResult, EXTRACT_JSON_SCHEMA } from './src/main/llm/schema.ts'
export { buildUserPayload, EXTRACT_SYSTEM_PROMPT } from './src/main/llm/extractPrompt.ts'
export { getPipelineDefaults } from './src/main/config/defaults.ts'
`

// 固定「本輪 LINE 新訊息」（4 chats：1:1 待辦、群組等回覆、行程、官方帳號噪音）。
const NOW = '2026-06-26T16:00:00'
const MSGS = [
  // u-abby：別人請我做事 → todo
  { chat: 'Abby', chatId: 'uabby', isGroup: false, ts: 1719381600000, time: '2026-06-26T15:40:00', direction: 'in', sender: 'Abby', text: '幫我把報價單下午寄出', contentType: 0 },
  // c-proj：我問了問題在等回覆 → waiting
  { chat: '專案群', chatId: 'cproj', isGroup: true, ts: 1719381660000, time: '2026-06-26T15:41:00', direction: 'out', sender: 'me', text: '老王報價單好了嗎', contentType: 0 },
  // u-mom：明確時間 → schedule（未來）
  { chat: '媽', chatId: 'umom', isGroup: false, ts: 1719381720000, time: '2026-06-26T15:42:00', direction: 'in', sender: '媽', text: '明天晚上七點回家吃飯', contentType: 0 },
  // 官方帳號：名稱含「官方」→ 自動黑名單，不進 LLM
  { chat: 'LINE 官方帳號', chatId: 'uofficial', isGroup: false, ts: 1719381780000, time: '2026-06-26T15:43:00', direction: 'in', sender: 'LINE', text: '限時優惠快來看', contentType: 0 }
]

// round 2 的「新訊息」批次：故意觸發 (a) App 端近似去重 merge、(b) 完成偵測 resolved。
//   - uabby：同一件事再被提一次（不同 ts/字句）→ mock 回「標題等同既有」→ 應 merge 非新增。
//   - cproj：老王回覆了 → mock 回 resolved（用 openTodos 真 id）→ 既有 waiting 應變 done。
const MSGS_R2 = [
  { chat: 'Abby', chatId: 'uabby', isGroup: false, ts: 1719385200000, time: '2026-06-26T16:40:00', direction: 'in', sender: 'Abby', text: '記得報價單喔', contentType: 0 },
  { chat: '專案群', chatId: 'cproj', isGroup: true, ts: 1719385260000, time: '2026-06-26T16:41:00', direction: 'in', sender: '老王', text: '報價單寄了，你收一下', contentType: 0 }
]

// mock extractFn：依 chatId 回不同抽取結果（模擬 qwen guided_json 輸出 → 已 zod 驗證的 ExtractResult）。
function makeMockExtract(round) {
  return async (input) => {
    const cid = input.chat.chatId
    const msgId = input.newMessages[0] && input.newMessages[0].msgId
    if (cid === 'uabby') {
      if (round === 1) {
        return {
          importance: 'action',
          newTodos: [
            { bucket: 'todo', title: '寄出報價單給 Abby', detail: '下午寄', priority: 1, dueAt: null, confidence: 0.9, sourceMsgIds: [msgId] }
          ],
          resolved: []
        }
      }
      // round2：模型「沒注意到」是同一件事，仍回近似標題（全形/標點/空白差異）；
      // 靠 App 端 normalizeTitle 近似去重攔下 → 應 merge 既有，非新增。
      return {
        importance: 'action',
        newTodos: [
          { bucket: 'todo', title: '寄出報價單給 Abby。', detail: '催一次', priority: 1, dueAt: null, confidence: 0.8, sourceMsgIds: [msgId] }
        ],
        resolved: []
      }
    }
    if (cid === 'cproj') {
      if (round === 1) {
        return {
          importance: 'action',
          newTodos: [
            { bucket: 'waiting', title: '等老王回報價單進度', detail: null, priority: 2, dueAt: null, confidence: 0.7, sourceMsgIds: [msgId] }
          ],
          resolved: []
        }
      }
      // round2：偵測到既有 waiting todo 已被回覆 → resolved（用 openTodos 的真 id）
      const open = input.openTodos.find((t) => t.bucket === 'waiting')
      return {
        importance: 'action',
        newTodos: [],
        resolved: open ? [{ todoId: open.id, evidence: '老王已回「報價單寄了」(msg ' + msgId + ')' }] : []
      }
    }
    if (cid === 'umom') {
      return {
        importance: 'action',
        newTodos: [
          { bucket: 'schedule', title: '回家吃飯', detail: null, priority: 2, dueAt: '2026-06-27T19:00:00', confidence: 0.85, sourceMsgIds: [msgId] }
        ],
        resolved: []
      }
    }
    // 不該被呼叫（官方帳號已黑名單）
    return { importance: 'noise', newTodos: [], resolved: [] }
  }
}

app.whenReady().then(async () => {
  const root = path.join(__dirname, '..')
  const entryFile = path.join(root, '__pipe_entry.ts')
  const outFile = path.join(root, '__pipe.bundle.cjs')
  const cleanup = () => {
    try { fs.rmSync(entryFile, { force: true }) } catch (_) {}
    try { fs.rmSync(outFile, { force: true }) } catch (_) {}
  }
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-todo-pipe-'))
    process.env.LINE_TODO_DB_PATH = path.join(tmpDir, 'line-todo.db')
    // 確保無金鑰路徑也能跑（dry-run 注入 extractFn，不碰真金鑰）
    delete process.env.QWEN_API_KEY

    fs.writeFileSync(entryFile, ENTRY, 'utf8')
    await esbuild.build({
      entryPoints: [entryFile], bundle: true, platform: 'node', format: 'cjs',
      outfile: outFile, external: ['electron', 'better-sqlite3', 'openai'],
      absWorkingDir: root, logLevel: 'silent'
    })
    const m = require(outFile)
    m.getDb()
    console.log('[probe-pipe] db-ready=' + process.env.LINE_TODO_DB_PATH)

    // ── 印 prompt / schema 最終版（evidence 要求）──
    console.log('[probe-pipe] SYSTEM_PROMPT_LEN=' + m.EXTRACT_SYSTEM_PROMPT.length)
    console.log('[probe-pipe] SCHEMA_NAME=' + m.EXTRACT_JSON_SCHEMA.name + ' strict=' + m.EXTRACT_JSON_SCHEMA.strict)
    // 示範 buildUserPayload 形狀
    const samplePayload = m.buildUserPayload({
      now: NOW,
      chat: { chatId: 'uabby', name: 'Abby', isGroup: false },
      newMessages: [{ msgId: 'mid1', chatId: 'uabby', ts: MSGS[0].ts, timeIso: MSGS[0].time, direction: 'in', sender: 'Abby', text: '幫我把報價單下午寄出', contentType: 0, processed: false, ingestedAt: NOW }],
      recentContext: [],
      openTodos: [{ id: 'old1', chatId: 'uabby', bucket: 'waiting', status: 'waiting_reply', title: '等 Abby 回價', detail: null, priority: 2, dueAt: null, sourceMsgIds: [], confidence: 0.5, completionEvidence: null, createdAt: NOW, updatedAt: NOW, resolvedAt: null }]
    })
    console.log('[probe-pipe] USER_PAYLOAD_SAMPLE=' + samplePayload)

    // ── round 1 ──
    const cfg = m.getPipelineDefaults()
    const r1 = await m.runOnce({
      watchSource: m.fixedWatchSource(MSGS, 'ok'),
      extractFn: makeMockExtract(1),
      config: { ...cfg, concurrency: 2 },
      now: () => NOW
    })
    console.log('[probe-pipe] round1=' + JSON.stringify({
      newMsgs: r1.newMsgs, chatsSeen: r1.chatsSeen, processed: r1.chatsProcessed,
      noise: r1.chatsSkippedNoise, failed: r1.chatsFailed, created: r1.todosCreated,
      merged: r1.todosMerged, done: r1.todosResolvedDone, suggested: r1.todosSuggestedDone,
      llm: r1.llmStatus, bridge: r1.lineBridge
    }))

    const chats = m.listChats({ includeBlocked: true })
    const official = chats.find((c) => c.chatId === 'uofficial')
    console.log('[probe-pipe] official-blocked=' + (official && official.blocked) + ' reason=' + (official && official.blockReason))

    const todos1 = m.listTodos({})
    console.log('[probe-pipe] todos-after-r1=' + JSON.stringify(todos1.map((t) => ({ chat: t.chatId, bucket: t.bucket, status: t.status, title: t.title, due: t.dueAt }))))

    const sched = todos1.find((t) => t.bucket === 'schedule')
    const waiting = todos1.find((t) => t.bucket === 'waiting')
    const todoItem = todos1.find((t) => t.bucket === 'todo')

    // ── round 2（新訊息批：uabby 近似標題 → merge、cproj 老王回覆 → resolved done）──
    const r2 = await m.runOnce({
      watchSource: m.fixedWatchSource(MSGS_R2, 'ok'),
      extractFn: makeMockExtract(2),
      config: { ...cfg, concurrency: 2 },
      now: () => NOW
    })
    console.log('[probe-pipe] round2=' + JSON.stringify({
      newMsgs: r2.newMsgs, chatsSeen: r2.chatsSeen, processed: r2.chatsProcessed,
      created: r2.todosCreated, merged: r2.todosMerged, done: r2.todosResolvedDone,
      suggested: r2.todosSuggestedDone, llm: r2.llmStatus
    }))

    const todos2 = m.listTodos({ statuses: ['pending', 'waiting_reply', 'scheduled', 'done', 'suggested_done'] })
    const waitingAfter = todos2.find((t) => waiting && t.id === waiting.id)
    console.log('[probe-pipe] waiting-after-r2 status=' + (waitingAfter && waitingAfter.status) + ' evidence=' + (waitingAfter && waitingAfter.completionEvidence))
    console.log('[probe-pipe] countMessages=' + m.countMessages() + ' countTodos=' + m.countTodos())
    const lastRun = m.getLastRun()
    console.log('[probe-pipe] lastRun=' + JSON.stringify({ newMsgs: lastRun.newMsgs, chatsSeen: lastRun.chatsSeen, todosCreated: lastRun.todosCreated, todosResolved: lastRun.todosResolved, llm: lastRun.llmStatus }))

    // ── 斷言 ──
    const ok =
      r1.newMsgs === 4 &&                    // 4 則全落庫
      r1.chatsSeen === 3 &&                  // 官方帳號被黑名單排除（3 chat 進管線）
      r1.chatsProcessed === 3 &&
      r1.todosCreated === 3 &&               // todo + waiting + schedule
      official && official.blocked === true &&
      todoItem && todoItem.status === 'pending' &&
      waiting && waiting.status === 'waiting_reply' &&
      sched && sched.status === 'scheduled' && sched.dueAt === '2026-06-27T19:00:00' &&
      r2.newMsgs === 2 &&                    // round2 兩則新訊息落庫
      r2.chatsSeen === 2 &&                  // uabby + cproj 進管線
      r2.todosCreated === 0 &&               // uabby 近似標題 → 不新增
      r2.todosMerged === 1 &&                // 走 merge 既有
      r2.todosResolvedDone === 1 &&          // cproj waiting → done
      waitingAfter && waitingAfter.status === 'done' && !!waitingAfter.completionEvidence &&
      m.countMessages() === 6 &&             // 4 + 2，無重複
      m.countTodos() === 3                   // 沒長出多餘 todo

    console.log('[probe-pipe] ALL-ASSERTIONS-PASS=' + ok)
    m.closeDb()
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
    cleanup()
    app.exit(ok ? 0 : 1)
  } catch (err) {
    console.error('[probe-pipe] FAILED: ' + (err && err.stack ? err.stack : err))
    cleanup()
    app.exit(1)
  }
})
