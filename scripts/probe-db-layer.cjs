// 在 Electron main 進程內，端到端驗證 line-todo 的 DB 持久化層。
// 由 `npx electron scripts/probe-db-layer.cjs` 執行。
//
// 為何用 out/main 的編譯產物？ 因為 repo 模組是 ESM TS，electron-vite build 後
// 會 inline 進 out/main/index.js（整包打進主 bundle）。本 probe 不重用 bundle，
// 改用「直接 require 編譯後的等價邏輯」會漂移；因此 probe 直接以 better-sqlite3
// 重跑 schema.ts 的 DDL 並比對—— 但這只驗 DDL，不驗 repo 行為。
//
// → 正解：本 probe 用 ts 來源不可行（require 不吃 TS）。改採「黑箱」策略：
//   1) 設 LINE_TODO_DB_PATH 指向 temp DB。
//   2) require('better-sqlite3') 直接套用 schema.sql 的 DDL（讀檔），建表。
//   3) 模擬 watcher 的 insertMessages 去重行為（INSERT OR IGNORE + 推導 msg_id），
//      插同一 batch 兩次，證明第二次 inserted=0。
//   4) 查 chats/messages 列數、PRAGMA user_version、外鍵、索引存在性。
//   印 [probe-db] 開頭的證據行；全綠 exit 0。
//
// 註：repo 真實行為的型別/編譯正確性已由 `npm run typecheck` + `npm run build` 保證；
//     本 probe 補的是「DDL 可建、去重鍵邏輯正確、外鍵/索引到位」的 runtime 證據。

const { app } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const crypto = require('node:crypto')

function deriveMsgId(m) {
  // 與 src/main/db/schema.ts deriveMsgId 完全一致（同一把鍵）。
  const basis = `${m.chatId}${m.ts}${m.direction}${m.sender}${m.text}`
  return 'd:' + crypto.createHash('sha1').update(basis, 'utf8').digest('hex')
}

app.whenReady().then(() => {
  let db
  try {
    const Database = require('better-sqlite3')
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-todo-probe-'))
    const dbPath = path.join(tmpDir, 'line-todo.db')
    console.log('[probe-db] db-path=' + dbPath)

    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')

    // 套用 schema.sql 的 DDL（去掉 PRAGMA 行，那些是連線層）。
    const schemaSql = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'main', 'db', 'schema.sql'),
      'utf8'
    )
    const ddl = schemaSql
      .split('\n')
      .filter((l) => !/^\s*PRAGMA\s/i.test(l))
      .join('\n')
    db.exec(ddl)
    db.pragma('user_version = 1')

    // ── 驗證：表存在 ──
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name)
    console.log('[probe-db] tables=' + JSON.stringify(tables))
    for (const t of ['chats', 'messages', 'todos', 'app_settings', 'pipeline_runs']) {
      if (!tables.includes(t)) throw new Error('missing table: ' + t)
    }

    // ── 驗證：索引存在 ──
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name")
      .all()
      .map((r) => r.name)
    console.log('[probe-db] indexes=' + JSON.stringify(indexes))

    console.log('[probe-db] user_version=' + db.pragma('user_version', { simple: true }))
    console.log('[probe-db] foreign_keys=' + db.pragma('foreign_keys', { simple: true }))

    // ── 模擬一個 watcher batch（含同 chat 多則 + 跨 chat）──
    const now = new Date().toISOString()
    const batch = [
      { chat: 'Abby', chatId: 'u111', isGroup: false, ts: 1719300000000, time: '2026-06-25T14:00:00', direction: 'in', sender: 'Abby', text: '明天三點開會', contentType: 0 },
      { chat: 'Abby', chatId: 'u111', isGroup: false, ts: 1719300100000, time: '2026-06-25T14:01:40', direction: 'out', sender: 'me', text: '好', contentType: 0 },
      { chat: '專案群', chatId: 'c222', isGroup: true, ts: 1719300200000, time: '2026-06-25T14:03:20', direction: 'in', sender: '老王', text: '報價單寄了嗎', contentType: 0 },
      { chat: '專案群', chatId: 'c222', isGroup: true, ts: 1719300300000, time: '2026-06-25T14:05:00', direction: 'in', sender: '老王', text: '[image]', contentType: 1 }
    ]

    const upsertChat = db.prepare(
      `INSERT INTO chats (chat_id, name, is_group, blocked, block_reason, first_seen_at, last_seen_at)
       VALUES (@chatId, @name, @isGroup, 0, NULL, @seenAt, @seenAt)
       ON CONFLICT(chat_id) DO UPDATE SET name = COALESCE(excluded.name, chats.name), last_seen_at = excluded.last_seen_at`
    )
    const insertMsg = db.prepare(
      `INSERT OR IGNORE INTO messages
         (msg_id, chat_id, ts, time_iso, direction, sender, text, content_type, processed, ingested_at)
       VALUES (@msgId, @chatId, @ts, @timeIso, @direction, @sender, @text, @contentType, 0, @ingestedAt)`
    )

    function ingest(b) {
      const chatLatest = new Map()
      for (const m of b) chatLatest.set(m.chatId, { name: m.chat, isGroup: m.isGroup })
      let inserted = 0
      const run = db.transaction(() => {
        for (const [chatId, info] of chatLatest) {
          upsertChat.run({ chatId, name: info.name, isGroup: info.isGroup ? 1 : 0, seenAt: now })
        }
        const seen = new Set()
        for (const m of b) {
          const msgId = deriveMsgId(m)
          if (seen.has(msgId)) continue
          seen.add(msgId)
          inserted += insertMsg.run({
            msgId, chatId: m.chatId, ts: m.ts, timeIso: m.time,
            direction: m.direction, sender: m.sender, text: m.text,
            contentType: m.contentType, ingestedAt: now
          }).changes
        }
      })
      run()
      return inserted
    }

    const ins1 = ingest(batch)
    console.log('[probe-db] first-ingest-inserted=' + ins1) // 期望 4

    const ins2 = ingest(batch) // 同 batch 再來一次 → 去重
    console.log('[probe-db] second-ingest-inserted=' + ins2) // 期望 0（INSERT OR IGNORE 全命中）

    const msgCount = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n
    const chatCount = db.prepare('SELECT COUNT(*) AS n FROM chats').get().n
    console.log('[probe-db] messages-count=' + msgCount) // 期望 4
    console.log('[probe-db] chats-count=' + chatCount)   // 期望 2

    // 每 chat 列數
    const perChat = db
      .prepare('SELECT chat_id, COUNT(*) AS n FROM messages GROUP BY chat_id ORDER BY chat_id')
      .all()
    console.log('[probe-db] per-chat=' + JSON.stringify(perChat))

    // chats 內容（驗 is_group / name 維護）
    const chats = db.prepare('SELECT chat_id, name, is_group, blocked FROM chats ORDER BY chat_id').all()
    console.log('[probe-db] chats=' + JSON.stringify(chats))

    // ── FK 強制：插一筆指向不存在 chat 的訊息應失敗 ──
    let fkEnforced = false
    try {
      db.prepare(
        `INSERT INTO messages (msg_id, chat_id, ts, time_iso, direction, sender, text, content_type, processed, ingested_at)
         VALUES ('x', 'NOPE_chat', 1, 't', 'in', 's', 't', 0, 0, 't')`
      ).run()
    } catch (e) {
      fkEnforced = /FOREIGN KEY/i.test(String(e.message))
    }
    console.log('[probe-db] fk-enforced=' + fkEnforced) // 期望 true

    // ── todos：建一筆 + 查 open-by-chat（驗 source_msg_ids JSON 往返）──
    const tid = crypto.randomUUID()
    db.prepare(
      `INSERT INTO todos (id, chat_id, bucket, status, title, detail, priority, due_at, source_msg_ids, confidence, completion_evidence, created_at, updated_at, resolved_at)
       VALUES (@id, @chatId, 'waiting', 'waiting_reply', @title, NULL, 1, NULL, @src, 0.8, NULL, @now, @now, NULL)`
    ).run({ id: tid, chatId: 'c222', title: '等老王回報價單', src: JSON.stringify([deriveMsgId(batch[2])]), now })
    const openTodos = db
      .prepare(`SELECT id, chat_id, bucket, status, title, source_msg_ids FROM todos WHERE chat_id='c222' AND status IN ('pending','waiting_reply','scheduled','suggested_done')`)
      .all()
    console.log('[probe-db] open-todos=' + JSON.stringify(openTodos))

    // ── 總體斷言 ──
    const ok =
      ins1 === 4 &&
      ins2 === 0 &&
      msgCount === 4 &&
      chatCount === 2 &&
      fkEnforced === true &&
      openTodos.length === 1

    console.log('[probe-db] ALL-ASSERTIONS-PASS=' + ok)
    db.close()
    // 清 temp
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
    app.exit(ok ? 0 : 1)
  } catch (err) {
    console.error('[probe-db] FAILED: ' + (err && err.stack ? err.stack : err))
    try { if (db) db.close() } catch (_) {}
    app.exit(1)
  }
})
