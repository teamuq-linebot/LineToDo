// 端到端驗證「真正的」repo 模組（messages.repo.ts / chats.repo.ts / todos.repo.ts），
// 而非重寫邏輯。流程：
//   1) 用 esbuild 把一個 entry（re-export 三個 repo + database/migrate）打成 CJS，
//      external: electron / better-sqlite3（runtime 由 Electron 提供）。
//   2) 在 Electron main 進程 require 該 bundle，設 LINE_TODO_DB_PATH 指向 temp DB。
//   3) 呼叫真 insertMessages（兩次，證明去重）、listChats、listMessages、getRecentByChat、
//      createTodo、getOpenTodosByChat。
//   4) 印 [probe-repo] 證據；全綠 exit 0。
// 由 `npx electron scripts/probe-repo-real.cjs` 執行。

const { app } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const esbuild = require('esbuild')

const ENTRY = `
export { insertMessages, listMessages, getRecentByChat, countMessages } from './src/main/db/messages.repo.ts'
export { listChats, getChat, setBlocked } from './src/main/db/chats.repo.ts'
export { createTodo, listTodos, getOpenTodosByChat, updateStatus } from './src/main/db/todos.repo.ts'
export { getDb, closeDb } from './src/main/db/database.ts'
`

app.whenReady().then(async () => {
  try {
    const root = path.join(__dirname, '..')
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-todo-repo-'))
    const dbPath = path.join(tmpDir, 'line-todo.db')
    // entry + bundle 都放 project root：relative './src/...' import 才解析得到，
    // 且 require(bundle) 時 external 的 better-sqlite3 也對得到 root 的 node_modules。
    const entryFile = path.join(root, '__probe_entry.ts')
    const outFile = path.join(root, '__probe_repo.bundle.cjs')
    fs.writeFileSync(entryFile, ENTRY, 'utf8')

    // 設 DB 路徑 override（database.ts 讀 LINE_TODO_DB_PATH）。
    process.env.LINE_TODO_DB_PATH = dbPath

    await esbuild.build({
      entryPoints: [entryFile],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: outFile,
      external: ['electron', 'better-sqlite3'],
      absWorkingDir: root,
      logLevel: 'silent'
    })

    const repo = require(outFile)
    console.log('[probe-repo] bundle-loaded exports=' + JSON.stringify(Object.keys(repo)))

    // 觸發 getDb → migrate 建表。
    repo.getDb()
    console.log('[probe-repo] db-ready path=' + dbPath)

    const batch = [
      { chat: 'Abby', chatId: 'u111', isGroup: false, ts: 1719300000000, time: '2026-06-25T14:00:00', direction: 'in', sender: 'Abby', text: '明天三點開會', contentType: 0 },
      { chat: 'Abby', chatId: 'u111', isGroup: false, ts: 1719300100000, time: '2026-06-25T14:01:40', direction: 'out', sender: 'me', text: '好', contentType: 0 },
      { chat: '專案群', chatId: 'c222', isGroup: true, ts: 1719300200000, time: '2026-06-25T14:03:20', direction: 'in', sender: '老王', text: '報價單寄了嗎', contentType: 0 },
      { chat: '專案群', chatId: 'c222', isGroup: true, ts: 1719300300000, time: '2026-06-25T14:05:00', direction: 'in', sender: '老王', text: '[image]', contentType: 1 }
    ]

    const r1 = repo.insertMessages(batch)
    console.log('[probe-repo] insert#1=' + JSON.stringify(r1)) // inserted 4, chatIds 2

    const r2 = repo.insertMessages(batch) // 去重
    console.log('[probe-repo] insert#2=' + JSON.stringify(r2)) // inserted 0

    console.log('[probe-repo] countMessages=' + repo.countMessages())
    console.log('[probe-repo] countMessages(u111)=' + repo.countMessages('u111'))

    const chats = repo.listChats()
    console.log('[probe-repo] listChats=' + JSON.stringify(chats.map((c) => ({ chatId: c.chatId, name: c.name, isGroup: c.isGroup, blocked: c.blocked }))))

    const recent = repo.getRecentByChat('u111', 10)
    console.log('[probe-repo] recentByChat(u111) order=' + JSON.stringify(recent.map((m) => m.ts)))
    console.log('[probe-repo] recentByChat(u111) sample=' + JSON.stringify(recent.map((m) => ({ direction: m.direction, sender: m.sender, text: m.text }))))

    const listed = repo.listMessages({ limit: 100 })
    console.log('[probe-repo] listMessages-count=' + listed.length + ' newestTs=' + listed[0].ts)

    // 黑名單切換
    const blocked = repo.setBlocked('c222', true, 'manual')
    console.log('[probe-repo] setBlocked(c222)=' + JSON.stringify({ blocked: blocked.blocked, reason: blocked.blockReason }))
    const visibleChats = repo.listChats() // 預設不含黑名單
    console.log('[probe-repo] listChats(after-block)=' + JSON.stringify(visibleChats.map((c) => c.chatId)))
    const allChats = repo.listChats({ includeBlocked: true })
    console.log('[probe-repo] listChats(includeBlocked)=' + JSON.stringify(allChats.map((c) => c.chatId)))

    // todo 建立 + open-by-chat（含 source_msg_ids round-trip）
    const t = repo.createTodo({ chatId: 'c222', bucket: 'waiting', status: 'waiting_reply', title: '等老王回報價單', priority: 1, confidence: 0.8, sourceMsgIds: ['fake-msg-1'] })
    console.log('[probe-repo] createTodo=' + JSON.stringify({ id: t.id.slice(0, 8), bucket: t.bucket, status: t.status, src: t.sourceMsgIds }))
    const open = repo.getOpenTodosByChat('c222')
    console.log('[probe-repo] openTodos(c222)=' + open.length + ' title=' + (open[0] && open[0].title))
    const doneT = repo.updateStatus(t.id, 'done')
    console.log('[probe-repo] updateStatus->done resolvedAt=' + (doneT.resolvedAt ? 'set' : 'null'))
    const openAfter = repo.getOpenTodosByChat('c222')
    console.log('[probe-repo] openTodos(after-done)=' + openAfter.length)

    const ok =
      r1.inserted === 4 && r1.chatIds.length === 2 &&
      r2.inserted === 0 &&
      repo.countMessages() === 4 &&
      repo.countMessages('u111') === 2 &&
      chats.length === 2 &&
      recent.length === 2 && recent[0].ts < recent[1].ts && // 舊到新
      blocked.blocked === true &&
      visibleChats.length === 1 && allChats.length === 2 &&
      t.sourceMsgIds.length === 1 &&
      open.length === 1 &&
      doneT.resolvedAt !== null &&
      openAfter.length === 0

    console.log('[probe-repo] ALL-ASSERTIONS-PASS=' + ok)
    repo.closeDb()
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
    try { fs.rmSync(entryFile, { force: true }) } catch (_) {}
    try { fs.rmSync(outFile, { force: true }) } catch (_) {}
    app.exit(ok ? 0 : 1)
  } catch (err) {
    console.error('[probe-repo] FAILED: ' + (err && err.stack ? err.stack : err))
    const r = path.join(__dirname, '..')
    try { fs.rmSync(path.join(r, '__probe_entry.ts'), { force: true }) } catch (_) {}
    try { fs.rmSync(path.join(r, '__probe_repo.bundle.cjs'), { force: true }) } catch (_) {}
    app.exit(1)
  }
})
