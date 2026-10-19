// seed-board.cjs — 把示範 chats + todos 灌進指定 userData 的 line-todo.db，
// 讓看板 UI 在沒有真實 LINE/LLM 的情況下也能渲染四欄 + 各種狀態，供截圖驗收。
//
// 用法：node scripts/seed-board.cjs <userDataDir>
// 直接用 app 內附的 better-sqlite3（node_modules），DDL 與 schema.sql 對齊、user_version=1。

const path = require('node:path')
const fs = require('node:fs')

const userDataDir = process.argv[2]
if (!userDataDir) {
  console.error('usage: node scripts/seed-board.cjs <userDataDir>')
  process.exit(2)
}
fs.mkdirSync(userDataDir, { recursive: true })

const Database = require(path.resolve(__dirname, '..', 'node_modules', 'better-sqlite3'))
const dbPath = path.join(userDataDir, 'line-todo.db')
const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS chats (
  chat_id TEXT PRIMARY KEY, name TEXT, is_group INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0, block_reason TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  msg_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, ts INTEGER NOT NULL, time_iso TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('in','out')), sender TEXT, text TEXT,
  content_type INTEGER NOT NULL DEFAULT 0, processed INTEGER NOT NULL DEFAULT 0,
  ingested_at TEXT NOT NULL, FOREIGN KEY (chat_id) REFERENCES chats(chat_id));
CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL,
  bucket TEXT NOT NULL CHECK(bucket IN ('todo','waiting','schedule')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','waiting_reply','scheduled','done','suggested_done','dismissed')),
  title TEXT NOT NULL, detail TEXT, priority INTEGER NOT NULL DEFAULT 2, due_at TEXT,
  source_msg_ids TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.5, completion_evidence TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT,
  FOREIGN KEY (chat_id) REFERENCES chats(chat_id));
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
  new_msgs INTEGER NOT NULL DEFAULT 0, chats_seen INTEGER NOT NULL DEFAULT 0,
  todos_created INTEGER NOT NULL DEFAULT 0, todos_resolved INTEGER NOT NULL DEFAULT 0,
  line_bridge TEXT NOT NULL DEFAULT 'ok', llm_status TEXT NOT NULL DEFAULT 'ok', note TEXT);
`)
db.pragma('user_version = 1') // 與 migrate() 對齊，避免啟動時重建/誤判

const now = new Date()
const iso = (d) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
const plusH = (h) => iso(new Date(now.getTime() + h * 3600 * 1000))
const nowIso = iso(now)

const chats = [
  ['u_abby', 'Abby 王', 0],
  ['c_proj', '專案 A 群組', 1],
  ['u_mom', '媽', 0],
  ['u_vendor', '報價窗口', 0]
]
const upChat = db.prepare(
  `INSERT OR REPLACE INTO chats (chat_id,name,is_group,blocked,block_reason,first_seen_at,last_seen_at)
   VALUES (?,?,?,0,NULL,?,?)`
)
for (const [id, name, g] of chats) upChat.run(id, name, g, nowIso, nowIso)

const upMsg = db.prepare(
  `INSERT OR REPLACE INTO messages (msg_id,chat_id,ts,time_iso,direction,sender,text,content_type,processed,ingested_at)
   VALUES (?,?,?,?,?,?,?,0,1,?)`
)
const msgs = [
  ['m1', 'c_proj', 'in', 'Leo', '明天下午三點開專案會議，記得帶上週的報表'],
  ['m2', 'u_abby', 'in', 'Abby 王', '報價單我這邊還在等主管簽，等等回你'],
  ['m3', 'u_mom', 'in', '媽', '記得幫我繳這個月的水電費喔'],
  ['m4', 'u_vendor', 'out', '我', '價格那邊麻煩您協助確認一下，謝謝'],
  ['m5', 'u_vendor', 'in', '報價窗口', '好的，報價已經寄到您信箱了，請查收'],
  ['m6', 'u_abby', 'in', 'Abby 王', '簽好了！報價單寄給你囉']
]
let t = now.getTime() - 3600 * 1000
for (const [id, chat, dir, sender, text] of msgs) {
  upMsg.run(id, chat, t, iso(new Date(t)), dir, sender, text, nowIso)
  t += 60000
}

const upTodo = db.prepare(
  `INSERT OR REPLACE INTO todos
   (id,chat_id,bucket,status,title,detail,priority,due_at,source_msg_ids,confidence,completion_evidence,created_at,updated_at,resolved_at)
   VALUES (@id,@chat,@bucket,@status,@title,@detail,@priority,@due,@src,@conf,@evi,@created,@updated,@resolved)`
)

const todos = [
  // 待辦欄（pending）
  { id: 't1', chat: 'u_mom', bucket: 'todo', status: 'pending', title: '繳這個月水電費', detail: '媽提醒的，這週內處理', priority: 1, due: plusH(-2), src: ['m3'], conf: 0.86, evi: null, resolved: null },
  { id: 't2', chat: 'c_proj', bucket: 'todo', status: 'pending', title: '準備上週報表帶去會議', detail: null, priority: 2, due: plusH(20), src: ['m1'], conf: 0.74, evi: null, resolved: null },
  // 等回覆欄（waiting_reply + 一個 suggested_done）
  { id: 't3', chat: 'u_abby', bucket: 'waiting', status: 'waiting_reply', title: '等 Abby 回報價單', detail: '她說等主管簽完', priority: 2, due: null, src: ['m2'], conf: 0.8, evi: null, resolved: null },
  { id: 't4', chat: 'u_vendor', bucket: 'waiting', status: 'suggested_done', title: '等報價窗口寄報價', detail: null, priority: 2, due: null, src: ['m4'], conf: 0.7, evi: '對方說「報價已經寄到您信箱」，疑似已完成', resolved: null },
  // 行程欄（scheduled）
  { id: 't5', chat: 'c_proj', bucket: 'schedule', status: 'scheduled', title: '專案 A 會議', detail: '帶上週報表', priority: 1, due: plusH(20), src: ['m1'], conf: 0.92, evi: null, resolved: null },
  // 已完成欄（done）
  { id: 't6', chat: 'u_abby', bucket: 'waiting', status: 'done', title: '等 Abby 簽完報價單', detail: null, priority: 2, due: null, src: ['m6'], conf: 0.78, evi: 'Abby 說「簽好了！報價單寄給你囉」', resolved: nowIso }
]
for (const x of todos) {
  upTodo.run({
    ...x,
    src: JSON.stringify(x.src),
    created: nowIso,
    updated: nowIso
  })
}

const counts = db.prepare('SELECT COUNT(*) n FROM todos').get()
const byStatus = db.prepare('SELECT status, COUNT(*) n FROM todos GROUP BY status').all()
console.log(`[seed] db=${dbPath}`)
console.log(`[seed] chats=${chats.length} messages=${msgs.length} todos=${counts.n}`)
console.log(`[seed] byStatus=${JSON.stringify(byStatus)}`)
db.close()
