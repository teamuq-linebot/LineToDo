-- schema.sql  (user_version = 3)
-- line-todo App 自有 DB（與 line-cua-win 的 LINE edb 完全分離；本 App 只新增、不寫回 LINE）。
-- 位置：app.getPath('userData')/line-todo.db
-- 此檔為「可讀參考來源」；runtime 實際執行的 DDL 內嵌在 schema.ts（避免 bundler 漏帶 .sql）。
-- 兩者須保持一致：改 DDL 時兩邊一起改。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── 聊天室（含降噪黑名單旗標）──────────────────────────────
CREATE TABLE IF NOT EXISTS chats (
  chat_id        TEXT PRIMARY KEY,          -- LINE _chatId
  name           TEXT,                      -- 顯示名稱（可能隨時間更新）
  is_group       INTEGER NOT NULL DEFAULT 0,-- 0/1
  blocked        INTEGER NOT NULL DEFAULT 0,-- 1 = 黑名單（不進 LLM 管線）
  block_reason   TEXT,                      -- 'auto:official' / 'auto:keyword' / 'manual' ...
  first_seen_at  TEXT NOT NULL,             -- ISO8601 (App 端寫入時間)
  last_seen_at   TEXT NOT NULL
);

-- ── 原始訊息鏡像（去重 + 給 LLM 上下文）────────────────────
CREATE TABLE IF NOT EXISTS messages (
  msg_id         TEXT PRIMARY KEY,          -- 去重鍵（見 schema.ts deriveMsgId 註解）
  chat_id        TEXT NOT NULL,
  ts             INTEGER NOT NULL,          -- epoch 毫秒
  time_iso       TEXT NOT NULL,             -- 本地 ISO8601（顯示用）
  direction      TEXT NOT NULL CHECK(direction IN ('in','out')),
  sender         TEXT,
  text           TEXT,                      -- 文字或 CT label
  content_type   INTEGER NOT NULL DEFAULT 0,
  processed      INTEGER NOT NULL DEFAULT 0,-- 0=未進 LLM / 1=已抽取過
  ingested_at    TEXT NOT NULL,             -- App 端落庫時間 ISO8601
  key_material   TEXT,                      -- 媒體解密金鑰材料（僅媒體訊息；文字訊息為 NULL）
  orig_filename  TEXT,                      -- 媒體原始檔名（可空）
  file_size      INTEGER,                   -- 媒體檔案大小 bytes（可空）
  media_backed_up INTEGER NOT NULL DEFAULT 0,-- 0=未備份 / 1=已備份（媒體自動備份增量追蹤）
  FOREIGN KEY (chat_id) REFERENCES chats(chat_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_ts   ON messages(chat_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_unproc    ON messages(processed, chat_id);

-- ── 代辦（看板核心）────────────────────────────────────────
CREATE TABLE IF NOT EXISTS todos (
  id                  TEXT PRIMARY KEY,     -- App 產生 uuid
  chat_id             TEXT NOT NULL,
  bucket              TEXT NOT NULL CHECK(bucket IN ('todo','waiting','schedule')),
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending','waiting_reply','scheduled',
                                         'done','suggested_done','dismissed')),
  title               TEXT NOT NULL,        -- 一句話代辦摘要（LLM 產）
  detail              TEXT,                 -- 補充內容（LLM 產，可空）
  priority            INTEGER NOT NULL DEFAULT 2,  -- 1=高 2=中 3=低（LLM 建議，可調）
  due_at              TEXT,                 -- 行程/期限 ISO8601；無則 NULL
  source_msg_ids      TEXT NOT NULL,        -- JSON 陣列字串：來源 message msg_id（可多筆）
  confidence          REAL NOT NULL DEFAULT 0.5,   -- 0..1，LLM 抽取信心
  completion_evidence TEXT,                 -- 完成偵測證據（被哪則訊息/理由判定完成）
  created_at          TEXT NOT NULL,        -- ISO8601
  updated_at          TEXT NOT NULL,        -- ISO8601（每次狀態變更更新）
  resolved_at         TEXT,                 -- 進入 done/dismissed 的時間 ISO8601
  FOREIGN KEY (chat_id) REFERENCES chats(chat_id)
);
CREATE INDEX IF NOT EXISTS idx_todos_status    ON todos(status);
CREATE INDEX IF NOT EXISTS idx_todos_chat_open ON todos(chat_id, status);
CREATE INDEX IF NOT EXISTS idx_todos_due       ON todos(due_at);

-- ── App 設定（key-value；QWEN key 不存這裡，存 safeStorage 檔）──
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                       -- JSON 字串
);

-- ── 每輪 pipeline 執行記錄（可觀測 / 除錯）─────────────────
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id             TEXT PRIMARY KEY,          -- uuid
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  new_msgs       INTEGER NOT NULL DEFAULT 0,
  chats_seen     INTEGER NOT NULL DEFAULT 0,
  todos_created  INTEGER NOT NULL DEFAULT 0,
  todos_resolved INTEGER NOT NULL DEFAULT 0,
  line_bridge    TEXT NOT NULL DEFAULT 'ok', -- 'ok' | 'error' | 'skipped'
  llm_status     TEXT NOT NULL DEFAULT 'ok', -- 'ok' | 'partial' | 'error'
  note           TEXT
);
