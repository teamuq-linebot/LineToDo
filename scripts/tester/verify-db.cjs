// 獨立驗證：純讀 App 真實 userData DB（不跑 pipeline、不寫入），
// 用 better-sqlite3（Electron ABI）直接查 todos / messages / chats / pipeline_runs，
// 交叉核對 run-review-real.cjs 的結果。對齊 App 身份（userData=line-todo）。

const { app } = require('electron')
const path = require('node:path')
const Database = require('better-sqlite3')

app.setName('line-todo')
try { app.setPath('userData', path.join(app.getPath('appData'), 'line-todo')) } catch (_) {}

app.whenReady().then(() => {
  try {
    const dbPath = path.join(app.getPath('userData'), 'line-todo.db')
    console.log('[verify] dbPath=' + dbPath)
    const db = new Database(dbPath, { readonly: true })

    const todoCount = db.prepare('SELECT COUNT(*) n FROM todos').get().n
    const msgCount = db.prepare('SELECT COUNT(*) n FROM messages').get().n
    const chatCount = db.prepare('SELECT COUNT(*) n FROM chats').get().n
    const blockedCount = db.prepare('SELECT COUNT(*) n FROM chats WHERE blocked=1').get().n
    console.log('[verify] counts todos=' + todoCount + ' messages=' + msgCount +
      ' chats=' + chatCount + ' blockedChats=' + blockedCount)

    const bucket = db.prepare('SELECT bucket, COUNT(*) n FROM todos GROUP BY bucket ORDER BY n DESC').all()
    console.log('[verify] bucket-dist=' + JSON.stringify(bucket))

    const status = db.prepare('SELECT status, COUNT(*) n FROM todos GROUP BY status ORDER BY n DESC').all()
    console.log('[verify] status-dist=' + JSON.stringify(status))

    // 抽 todos 是否真有來源訊息連結（source_msg_ids 非空），證明可溯源到 messages。
    const withSrc = db.prepare("SELECT COUNT(*) n FROM todos WHERE source_msg_ids IS NOT NULL AND source_msg_ids != '[]' AND source_msg_ids != ''").get().n
    console.log('[verify] todos-with-source=' + withSrc + '/' + todoCount)

    // 驗證一筆 todo 的 source_msg_ids 真的能在 messages 表找到對應列。
    const sampleTodo = db.prepare("SELECT id, title, source_msg_ids FROM todos WHERE source_msg_ids IS NOT NULL AND source_msg_ids != '[]' LIMIT 1").get()
    if (sampleTodo) {
      let ids = []
      try { ids = JSON.parse(sampleTodo.source_msg_ids) } catch (_) {}
      let foundMsg = null
      if (ids.length) {
        foundMsg = db.prepare('SELECT msg_id, chat_id, substr(text,1,40) t FROM messages WHERE msg_id = ?').get(ids[0])
      }
      console.log('[verify] sample-todo title=' + JSON.stringify(sampleTodo.title) +
        ' srcIds=' + JSON.stringify(ids) +
        ' linkedMsg=' + JSON.stringify(foundMsg))
    }

    // 最近 3 筆 pipeline_runs（證明這次 backfill run 真的落庫）。
    const runs = db.prepare('SELECT id, started_at, finished_at, new_msgs, chats_seen, todos_created, todos_resolved, line_bridge, llm_status, note FROM pipeline_runs ORDER BY started_at DESC LIMIT 3').all()
    console.log('[verify] recent-runs=' + JSON.stringify(runs, null, 0))

    // confidence 分佈（qwen 給的信心；證明是模型輸出非硬寫）。
    const conf = db.prepare('SELECT ROUND(confidence,1) c, COUNT(*) n FROM todos GROUP BY ROUND(confidence,1) ORDER BY c DESC').all()
    console.log('[verify] confidence-dist=' + JSON.stringify(conf))

    db.close()
    app.exit(0)
  } catch (err) {
    console.error('[verify] FAILED: ' + (err && err.stack ? err.stack : err))
    app.exit(1)
  }
})
