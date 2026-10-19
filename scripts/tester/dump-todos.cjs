// 純讀 App 真實 DB，dump 全部 todos（含 bucket/status/dueAt/title/conf/srcCount），
// 並按 bucket/status 統計。用於重跑後的指標筆查。對齊 App 身份；唯讀。
// 執行：electron scripts/tester/dump-todos.cjs
const { app } = require('electron')
const path = require('node:path')
const Database = require('better-sqlite3')

app.setName('line-todo')
try { app.setPath('userData', path.join(app.getPath('appData'), 'line-todo')) } catch (_) {}

app.whenReady().then(() => {
  try {
    const dbPath = path.join(app.getPath('userData'), 'line-todo.db')
    const db = new Database(dbPath, { readonly: true })
    const rows = db.prepare('SELECT id, chat_id, bucket, status, title, due_at, confidence, source_msg_ids FROM todos ORDER BY bucket, status, created_at').all()
    console.log('[dump] total=' + rows.length)
    const bucket = {}; const status = {}
    let emptyTitle = 0
    for (const r of rows) {
      bucket[r.bucket] = (bucket[r.bucket] || 0) + 1
      status[r.status] = (status[r.status] || 0) + 1
      const t = (r.title || '').trim()
      if (!t || ['title', '代辦', '待辦', '事項'].includes(t)) emptyTitle += 1
    }
    console.log('[dump] bucket=' + JSON.stringify(bucket))
    console.log('[dump] status=' + JSON.stringify(status))
    console.log('[dump] emptyOrPlaceholderTitle=' + emptyTitle)
    for (const r of rows) {
      let n = 0; try { n = JSON.parse(r.source_msg_ids).length } catch (_) {}
      console.log('[dump] ' + JSON.stringify({ bucket: r.bucket, status: r.status, due: r.due_at, conf: r.confidence, src: n, title: r.title }))
    }
    db.close()
    app.exit(0)
  } catch (err) {
    console.error('[dump] FAILED: ' + (err && err.stack ? err.stack : err))
    app.exit(1)
  }
})
