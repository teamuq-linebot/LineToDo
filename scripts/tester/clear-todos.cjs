// 清空 todos 表（保留 messages / chats / pipeline_runs），讓新邏輯重跑能反映真實結果。
// 用 Electron ABI better-sqlite3 直接 DELETE FROM todos。對齊 App 身份；寫真實 userData DB。
// 印 before/after 計數證明只動 todos。執行：electron scripts/tester/clear-todos.cjs
const { app } = require('electron')
const path = require('node:path')
const Database = require('better-sqlite3')

app.setName('line-todo')
try { app.setPath('userData', path.join(app.getPath('appData'), 'line-todo')) } catch (_) {}

app.whenReady().then(() => {
  try {
    const dbPath = path.join(app.getPath('userData'), 'line-todo.db')
    console.log('[clear] dbPath=' + dbPath)
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 5000')

    const cnt = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n
    const before = { todos: cnt('todos'), messages: cnt('messages'), chats: cnt('chats') }
    console.log('[clear] BEFORE todos=' + before.todos + ' messages=' + before.messages + ' chats=' + before.chats)

    const info = db.prepare('DELETE FROM todos').run()
    console.log('[clear] DELETE FROM todos changes=' + info.changes)

    const after = { todos: cnt('todos'), messages: cnt('messages'), chats: cnt('chats') }
    console.log('[clear] AFTER todos=' + after.todos + ' messages=' + after.messages + ' chats=' + after.chats)

    const ok =
      after.todos === 0 &&
      after.messages === before.messages &&
      after.chats === before.chats
    console.log('[clear] VERDICT=' + JSON.stringify({ todosCleared: before.todos - after.todos, messagesPreserved: after.messages === before.messages, chatsPreserved: after.chats === before.chats, ok }))

    db.close()
    app.exit(ok ? 0 : 1)
  } catch (err) {
    console.error('[clear] FAILED: ' + (err && err.stack ? err.stack : err))
    app.exit(1)
  }
})
