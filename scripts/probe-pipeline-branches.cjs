// 補強 dry-run：驗證 dryrun 主流程沒走到的兩個分支：
//   (A) schedule 且 dueAt 仍在未來、被 LLM 列為 resolved → 不自動 done，改 suggested_done（§6.6）。
//   (B) 整批只有貼圖(contentType 7) → isBatchNoise → 跳過 LLM、不產 todo，但訊息仍標 processed。
//       （證明：extractFn 對該 chat 不被呼叫。）
// 由 `npx electron scripts/probe-pipeline-branches.cjs` 執行。

const { app } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const esbuild = require('esbuild')

const ENTRY = `
export { runOnce } from './src/main/pipeline/runOnce.ts'
export { fixedWatchSource } from './src/main/pipeline/scheduler.ts'
export { getDb, closeDb } from './src/main/db/database.ts'
export { listTodos, countTodos } from './src/main/db/todos.repo.ts'
export { getPipelineDefaults } from './src/main/config/defaults.ts'
`

const NOW = '2026-06-26T16:00:00'

app.whenReady().then(async () => {
  const root = path.join(__dirname, '..')
  const entryFile = path.join(root, '__pipe_br_entry.ts')
  const outFile = path.join(root, '__pipe_br.bundle.cjs')
  const cleanup = () => {
    try { fs.rmSync(entryFile, { force: true }) } catch (_) {}
    try { fs.rmSync(outFile, { force: true }) } catch (_) {}
  }
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-todo-br-'))
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
    const cfg = m.getPipelineDefaults()

    // (A) schedule + 未來 dueAt + resolved → suggested_done
    //   先建立一個 schedule todo（round1），再 round2 把它列 resolved。
    const SCHED_MSGS = [
      { chat: '牙醫', chatId: 'udentist', isGroup: false, ts: 1719381600000, time: '2026-06-26T15:40:00', direction: 'in', sender: '牙醫', text: '下週三下午兩點回診', contentType: 0 }
    ]
    const SCHED_MSGS_R2 = [
      { chat: '牙醫', chatId: 'udentist', isGroup: false, ts: 1719385200000, time: '2026-06-26T16:40:00', direction: 'in', sender: '牙醫', text: '記得回診', contentType: 0 }
    ]
    const calledFor = []
    const extractA = (round) => async (input) => {
      calledFor.push(input.chat.chatId)
      if (round === 1) {
        return { importance: 'action', newTodos: [
          { bucket: 'schedule', title: '牙醫回診', detail: null, priority: 2, dueAt: '2026-07-01T14:00:00', confidence: 0.8, sourceMsgIds: [input.newMessages[0].msgId] }
        ], resolved: [] }
      }
      const open = input.openTodos.find((t) => t.bucket === 'schedule')
      return { importance: 'action', newTodos: [], resolved: open ? [{ todoId: open.id, evidence: '模型誤判已完成（其實未來行程）' }] : [] }
    }

    await m.runOnce({ watchSource: m.fixedWatchSource(SCHED_MSGS, 'ok'), extractFn: extractA(1), config: cfg, now: () => NOW })
    const rA2 = await m.runOnce({ watchSource: m.fixedWatchSource(SCHED_MSGS_R2, 'ok'), extractFn: extractA(2), config: cfg, now: () => NOW })
    const schedTodos = m.listTodos({ statuses: ['scheduled', 'suggested_done', 'done'] }).filter((t) => t.chatId === 'udentist')
    const schedTodo = schedTodos[0]
    console.log('[probe-br] A schedule-future-resolved status=' + (schedTodo && schedTodo.status) + ' (期望 suggested_done)' + ' resolvedDone=' + rA2.todosResolvedDone + ' suggested=' + rA2.todosSuggestedDone)

    // (B) 整批貼圖 → noise skip，extractFn 不被呼叫
    const STICKER_MSGS = [
      { chat: '閒聊群', chatId: 'cchat', isGroup: true, ts: 1719388800000, time: '2026-06-26T17:40:00', direction: 'in', sender: '阿明', text: '[sticker]', contentType: 7 },
      { chat: '閒聊群', chatId: 'cchat', isGroup: true, ts: 1719388860000, time: '2026-06-26T17:41:00', direction: 'in', sender: '阿華', text: '[sticker]', contentType: 7 }
    ]
    const calledB = []
    const extractB = async (input) => { calledB.push(input.chat.chatId); return { importance: 'fyi', newTodos: [], resolved: [] } }
    const rB = await m.runOnce({ watchSource: m.fixedWatchSource(STICKER_MSGS, 'ok'), extractFn: extractB, config: cfg, now: () => NOW })
    console.log('[probe-br] B sticker-batch chatsSeen=' + rB.chatsSeen + ' noiseSkipped=' + rB.chatsSkippedNoise + ' processed=' + rB.chatsProcessed + ' extractCalledForCchat=' + calledB.includes('cchat'))

    const totalTodos = m.countTodos()
    const ok =
      schedTodo && schedTodo.status === 'suggested_done' &&   // (A) 未來行程不自動 done
      rA2.todosSuggestedDone === 1 && rA2.todosResolvedDone === 0 &&
      rB.chatsSkippedNoise === 1 && rB.chatsProcessed === 0 &&  // (B) noise skip
      calledB.includes('cchat') === false &&                   // extractFn 沒被該 chat 呼叫
      totalTodos === 1                                          // 只有 schedule 那筆

    console.log('[probe-br] ALL-ASSERTIONS-PASS=' + ok)
    m.closeDb()
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
    cleanup()
    app.exit(ok ? 0 : 1)
  } catch (err) {
    console.error('[probe-br] FAILED: ' + (err && err.stack ? err.stack : err))
    cleanup()
    app.exit(1)
  }
})
