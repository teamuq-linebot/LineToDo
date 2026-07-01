import { createHash } from 'node:crypto'

/**
 * schema.ts — runtime DDL（單一真實來源）+ 資料列型別 + 去重鍵推導。
 *
 * 為何 DDL 內嵌成字串而非讀 schema.sql？
 *   main 進程經 electron-vite(rollup) 打包，非程式檔（.sql）預設不會被帶進 out/。
 *   讀磁碟 .sql 在打包後常見 ENOENT。內嵌字串最穩。schema.sql 仍保留作可讀參考，
 *   兩者須一致（改其一就改另一）。
 *
 * SCHEMA_VERSION 對應 PRAGMA user_version；migrate.ts 以此決定要不要建表/升級。
 */
export const SCHEMA_VERSION = 3

/**
 * 建立全部資料表與索引的 DDL。所有語句皆 IF NOT EXISTS，重複執行安全（冪等）。
 * 不含 PRAGMA journal_mode / foreign_keys —— 那些是「連線層」設定，由 database.ts
 * 在開連線時下，不放進可重跑的 schema exec 裡。
 */
export const SCHEMA_DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS chats (
  chat_id        TEXT PRIMARY KEY,
  name           TEXT,
  is_group       INTEGER NOT NULL DEFAULT 0,
  blocked        INTEGER NOT NULL DEFAULT 0,
  block_reason   TEXT,
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  msg_id         TEXT PRIMARY KEY,
  chat_id        TEXT NOT NULL,
  ts             INTEGER NOT NULL,
  time_iso       TEXT NOT NULL,
  direction      TEXT NOT NULL CHECK(direction IN ('in','out')),
  sender         TEXT,
  text           TEXT,
  content_type   INTEGER NOT NULL DEFAULT 0,
  processed      INTEGER NOT NULL DEFAULT 0,
  ingested_at    TEXT NOT NULL,
  key_material   TEXT,
  orig_filename  TEXT,
  file_size      INTEGER,
  media_backed_up INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (chat_id) REFERENCES chats(chat_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_unproc  ON messages(processed, chat_id);

CREATE TABLE IF NOT EXISTS todos (
  id                  TEXT PRIMARY KEY,
  chat_id             TEXT NOT NULL,
  bucket              TEXT NOT NULL CHECK(bucket IN ('todo','waiting','schedule')),
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending','waiting_reply','scheduled',
                                         'done','suggested_done','dismissed')),
  title               TEXT NOT NULL,
  detail              TEXT,
  priority            INTEGER NOT NULL DEFAULT 2,
  due_at              TEXT,
  source_msg_ids      TEXT NOT NULL,
  confidence          REAL NOT NULL DEFAULT 0.5,
  completion_evidence TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  resolved_at         TEXT,
  FOREIGN KEY (chat_id) REFERENCES chats(chat_id)
);
CREATE INDEX IF NOT EXISTS idx_todos_status    ON todos(status);
CREATE INDEX IF NOT EXISTS idx_todos_chat_open ON todos(chat_id, status);
CREATE INDEX IF NOT EXISTS idx_todos_due       ON todos(due_at);

CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id             TEXT PRIMARY KEY,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  new_msgs       INTEGER NOT NULL DEFAULT 0,
  chats_seen     INTEGER NOT NULL DEFAULT 0,
  todos_created  INTEGER NOT NULL DEFAULT 0,
  todos_resolved INTEGER NOT NULL DEFAULT 0,
  line_bridge    TEXT NOT NULL DEFAULT 'ok',
  llm_status     TEXT NOT NULL DEFAULT 'ok',
  note           TEXT
);
`

// ── 資料列型別（snake_case，對齊 DDL 欄位；repo 對外回傳前轉 camelCase DTO）──

export interface ChatRow {
  chat_id: string
  name: string | null
  is_group: number
  blocked: number
  block_reason: string | null
  first_seen_at: string
  last_seen_at: string
}

export interface MessageRow {
  msg_id: string
  chat_id: string
  ts: number
  time_iso: string
  direction: 'in' | 'out'
  sender: string | null
  text: string | null
  content_type: number
  processed: number
  ingested_at: string
  key_material: string | null
  orig_filename: string | null
  file_size: number | null
  media_backed_up: number
}

/**
 * 去重鍵推導 —— prefer-real-_id, fallback-hash。
 *
 * watch_json.py 的 NDJSON 契約已補上 LINE 原生 `_message._id`（欄位 `msgId`，
 * IMPLEMENTATION_PLAN.md §3）。此值跨 chat 全域唯一，是去重的真鍵：
 *   - **有 msgId**（幾乎所有列）：直接用它（前綴 `i:`）。LINE 原生 id 保證同一則
 *     訊息恆同、不同訊息恆異，徹底避免 hash 撞鍵把不同訊息吃掉的問題
 *     （例如同一秒貼多張圖，text 全被 CT 替換成 `[image]`、ts/sender/direction
 *     又相同 → 舊 hash 會把它們壓成一筆）。
 *   - **無 msgId**（罕見：某些列無 _id）：fallback 用「同一則訊息必然相同」的欄位
 *     組合 hash（前綴 `d:`，與舊鍵相容）：chatId | ts(ms) | direction | sender | text。
 *
 * 兩種鍵前綴不同（`i:` vs `d:`），不會互撞。messages.msg_id 為 PK，
 * INSERT OR IGNORE 以此去重；同一列被重複輪詢 → 同鍵 → 不重複落庫。
 */
export function deriveMsgId(m: {
  msgId?: string | null
  chatId: string
  ts: number
  direction: string
  sender: string
  text: string
}): string {
  // prefer real LINE _message._id when present
  if (m.msgId != null && m.msgId !== '') return 'i:' + m.msgId
  // fallback: stable hash over fields identical for the same message
  const basis = `${m.chatId}${m.ts}${m.direction}${m.sender}${m.text}`
  return 'd:' + createHash('sha1').update(basis, 'utf8').digest('hex')
}
