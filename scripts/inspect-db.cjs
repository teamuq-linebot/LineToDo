// 用 Electron 內的 better-sqlite3 開一個既有 DB 檔，印表/列數/樣本。
// 用法：npx electron scripts/inspect-db.cjs <dbPath>
const { app } = require('electron')
const dbPath = process.argv[process.argv.length - 1]

app.whenReady().then(() => {
  try {
    const Database = require('better-sqlite3')
    const db = new Database(dbPath, { readonly: true })
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name)
    console.log('[inspect] db=' + dbPath)
    console.log('[inspect] user_version=' + db.pragma('user_version', { simple: true }))
    console.log('[inspect] tables=' + JSON.stringify(tables))
    for (const t of ['chats', 'messages', 'todos']) {
      if (tables.includes(t)) {
        const n = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n
        console.log(`[inspect] count.${t}=` + n)
      }
    }
    if (tables.includes('messages')) {
      const sample = db
        .prepare('SELECT msg_id, chat_id, direction, sender, substr(text,1,20) AS text FROM messages ORDER BY ts DESC LIMIT 5')
        .all()
      console.log('[inspect] messages.sample=' + JSON.stringify(sample))
    }
    if (tables.includes('chats')) {
      const c = db.prepare('SELECT chat_id, name, is_group, blocked FROM chats LIMIT 5').all()
      console.log('[inspect] chats.sample=' + JSON.stringify(c))
    }
    db.close()
    app.exit(0)
  } catch (err) {
    console.error('[inspect] FAILED: ' + (err && err.stack ? err.stack : err))
    app.exit(1)
  }
})
