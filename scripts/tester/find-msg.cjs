// 在 App 真實 messages 表搜尋關鍵字（驗證指標筆訊息是否在 7 天窗口內、屬哪個 chat）。
// 唯讀。執行：electron scripts/tester/find-msg.cjs <keyword> [keyword2 ...]
const { app } = require('electron')
const path = require('node:path')
const Database = require('better-sqlite3')

app.setName('line-todo')
try { app.setPath('userData', path.join(app.getPath('appData'), 'line-todo')) } catch (_) {}

const kws = process.argv.slice(2).filter((a) => a && !a.endsWith('.cjs') && !a.includes('electron'))

app.whenReady().then(() => {
  try {
    const dbPath = path.join(app.getPath('userData'), 'line-todo.db')
    const db = new Database(dbPath, { readonly: true })
    const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000
    console.log('[find] keywords=' + JSON.stringify(kws) + ' sinceIso=' + new Date(sinceMs).toISOString())
    for (const kw of kws) {
      const rows = db.prepare(
        "SELECT msg_id, chat_id, ts, time_iso, direction, sender, substr(text,1,80) t FROM messages WHERE text LIKE ? ORDER BY ts DESC LIMIT 8"
      ).all('%' + kw + '%')
      console.log('[find] kw=' + JSON.stringify(kw) + ' hits=' + rows.length)
      for (const r of rows) {
        const inWin = r.ts >= sinceMs
        console.log('  ' + JSON.stringify({ inWindow: inWin, chat: r.chat_id, time: r.time_iso, dir: r.direction, sender: r.sender, text: r.t }))
      }
    }
    db.close()
    app.exit(0)
  } catch (err) {
    console.error('[find] FAILED: ' + (err && err.stack ? err.stack : err))
    app.exit(1)
  }
})
