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
export const SCHEMA_VERSION = 11

/**
 * message_participants 的建表 DDL。ensureLineImportSchema 與 migrate v10 的 M-P1（DROP 後重建）共用，
 * 兩處必須是同一份。表不含 idx_message_participants_chat_key（A1 起不再建立）。
 */
export const MESSAGE_PARTICIPANTS_DDL = `CREATE TABLE IF NOT EXISTS message_participants (
        msg_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        participant_key TEXT,
        scope TEXT NOT NULL CHECK(scope IN ('chat','unknown')),
        key_version INTEGER,
        identity_status TEXT NOT NULL CHECK(identity_status IN ('keyed','unknown')),
        identity_reason TEXT CHECK(identity_reason IN ('source_id_missing','account_unknown','safe_storage_unavailable','identity_failure','identity_epoch_changed')),
        is_me INTEGER CHECK(is_me IN (0,1) OR is_me IS NULL),
        FOREIGN KEY(msg_id) REFERENCES messages(msg_id) ON DELETE CASCADE,
        FOREIGN KEY(chat_id) REFERENCES chats(chat_id)
      );`

/**
 * Durable source/cache coordination. This derived window must not block legal
 * message deletion or chat movement; it stores IDs and fingerprints only.
 */
export const SOURCE_CACHE_DDL = [
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_messages_chat_msg ON messages(chat_id,msg_id);',
  'CREATE INDEX IF NOT EXISTS idx_messages_chat_ts_msg ON messages(chat_id,ts,msg_id);',
  'CREATE TABLE IF NOT EXISTS chat_context_cache (',
  '  chat_id TEXT PRIMARY KEY,',
  '  cache_schema_version INTEGER NOT NULL CHECK(cache_schema_version > 0),',
  '  state_version INTEGER NOT NULL DEFAULT 1 CHECK(state_version >= 1),',
  '  source_epoch INTEGER NOT NULL DEFAULT 1 CHECK(source_epoch >= 1),',
  '  append_seq INTEGER NOT NULL DEFAULT 0 CHECK(append_seq >= 0),',
  '  scope_revision INTEGER NOT NULL DEFAULT 1 CHECK(scope_revision >= 1),',
  '  todo_identity_revision INTEGER NOT NULL DEFAULT 0 CHECK(todo_identity_revision >= 0),',
  '  topic_identity_revision INTEGER NOT NULL DEFAULT 0 CHECK(topic_identity_revision >= 0),',
  '  window_complete INTEGER NOT NULL DEFAULT 0 CHECK(window_complete IN (0,1)),',
  '  window_digest TEXT CHECK(window_digest IS NULL OR length(window_digest) = 64),',
  '  active_lease_id TEXT,',
  '  lease_expires_at TEXT,',
  '  session_epoch INTEGER NOT NULL DEFAULT 0 CHECK(session_epoch >= 0),',
  '  session_fingerprint TEXT,',
  '  accepted_turns INTEGER NOT NULL DEFAULT 0 CHECK(accepted_turns BETWEEN 0 AND 64),',
  '  submitted_requests INTEGER NOT NULL DEFAULT 0 CHECK(submitted_requests BETWEEN 0 AND 64),',
  '  submitted_user_utf8_bytes INTEGER NOT NULL DEFAULT 0 CHECK(submitted_user_utf8_bytes BETWEEN 0 AND 131072),',
  '  last_accepted_at TEXT,',
  '  tainted INTEGER NOT NULL DEFAULT 0 CHECK(tainted IN (0,1)),',
  '  updated_at TEXT NOT NULL,',
  '  CHECK((active_lease_id IS NULL AND lease_expires_at IS NULL) OR',
  '        (active_lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)),',
  '  FOREIGN KEY(chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE ON UPDATE RESTRICT',
  ');',
  'CREATE TABLE IF NOT EXISTS chat_context_cache_window (',
  '  chat_id TEXT NOT NULL,',
  '  position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 9),',
  '  msg_id TEXT NOT NULL,',
  '  content_fingerprint TEXT NOT NULL CHECK(length(content_fingerprint) = 64),',
  '  PRIMARY KEY(chat_id,position),',
  '  UNIQUE(chat_id,msg_id),',
  '  FOREIGN KEY(chat_id) REFERENCES chat_context_cache(chat_id) ON DELETE CASCADE ON UPDATE RESTRICT,',
  '  FOREIGN KEY(chat_id,msg_id) REFERENCES messages(chat_id,msg_id) ON DELETE CASCADE ON UPDATE CASCADE',
  ');',
  'INSERT OR IGNORE INTO chat_context_cache(chat_id,cache_schema_version,state_version,source_epoch,append_seq,scope_revision,todo_identity_revision,topic_identity_revision,window_complete,window_digest,active_lease_id,lease_expires_at,session_epoch,session_fingerprint,accepted_turns,submitted_requests,submitted_user_utf8_bytes,last_accepted_at,tainted,updated_at)',
  'SELECT chat_id,1,1,1,0,1,0,0,0,NULL,NULL,NULL,0,NULL,0,0,0,NULL,0,last_seen_at FROM chats;',
  'CREATE TRIGGER IF NOT EXISTS trg_chats_cache_after_insert AFTER INSERT ON chats BEGIN',
  '  INSERT OR IGNORE INTO chat_context_cache(chat_id,cache_schema_version,state_version,source_epoch,append_seq,scope_revision,todo_identity_revision,topic_identity_revision,window_complete,window_digest,active_lease_id,lease_expires_at,session_epoch,session_fingerprint,accepted_turns,submitted_requests,submitted_user_utf8_bytes,last_accepted_at,tainted,updated_at)',
  "  VALUES(NEW.chat_id,1,1,1,0,1,0,0,0,NULL,NULL,NULL,0,NULL,0,0,0,NULL,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'));",
  'END;',
  'CREATE TRIGGER IF NOT EXISTS trg_messages_cache_after_insert AFTER INSERT ON messages BEGIN',
  "  UPDATE chat_context_cache SET append_seq=append_seq+1,state_version=state_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id=NEW.chat_id;",
  'END;',
  'CREATE TRIGGER IF NOT EXISTS trg_messages_cache_after_source_update AFTER UPDATE OF msg_id,chat_id,ts,time_iso,direction,sender,text,content_type,unsent ON messages',
  'WHEN OLD.msg_id IS NOT NEW.msg_id OR OLD.chat_id IS NOT NEW.chat_id OR OLD.ts IS NOT NEW.ts OR OLD.time_iso IS NOT NEW.time_iso OR OLD.direction IS NOT NEW.direction OR OLD.sender IS NOT NEW.sender OR OLD.text IS NOT NEW.text OR OLD.content_type IS NOT NEW.content_type OR OLD.unsent IS NOT NEW.unsent',
  'BEGIN',
  "  UPDATE chat_context_cache SET source_epoch=source_epoch+1,state_version=state_version+1,window_complete=0,window_digest=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id=OLD.chat_id;",
  "  UPDATE chat_context_cache SET source_epoch=source_epoch+1,state_version=state_version+1,window_complete=0,window_digest=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id=NEW.chat_id AND NEW.chat_id IS NOT OLD.chat_id;",
  '  DELETE FROM chat_context_cache_window WHERE chat_id=OLD.chat_id OR chat_id=NEW.chat_id;',
  'END;',
  'CREATE TRIGGER IF NOT EXISTS trg_messages_cache_after_delete AFTER DELETE ON messages BEGIN',
  "  UPDATE chat_context_cache SET source_epoch=source_epoch+1,state_version=state_version+1,window_complete=0,window_digest=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id=OLD.chat_id;",
  '  DELETE FROM chat_context_cache_window WHERE chat_id=OLD.chat_id;',
  'END;',
  'CREATE TRIGGER IF NOT EXISTS trg_chats_cache_after_scope_update AFTER UPDATE OF name,is_group,blocked ON chats',
  'WHEN OLD.name IS NOT NEW.name OR OLD.is_group IS NOT NEW.is_group OR OLD.blocked IS NOT NEW.blocked',
  'BEGIN',
  "  UPDATE chat_context_cache SET scope_revision=scope_revision+1,state_version=state_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id=NEW.chat_id;",
  'END;'
].join('\n')

/** Historical identity storage is additive; canonical Todo IDs and source JSON remain untouched. */
export const IDENTITY_CORE_DDL = [
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_todos_chat_id ON todos(chat_id,id);',
  'CREATE TABLE IF NOT EXISTS identity_index_meta (',
  '  chat_id TEXT NOT NULL, entity_type TEXT NOT NULL CHECK(entity_type IN (\'todo\',\'topic\')),',
  '  tokenizer_version TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN (\'building\',\'ready\',\'stale\',\'failed\')),',
  '  cursor_entity_id TEXT, last_error_code TEXT, updated_at TEXT NOT NULL,',
  '  PRIMARY KEY(chat_id,entity_type), FOREIGN KEY(chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE ON UPDATE RESTRICT',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_identity_index_state ON identity_index_meta(entity_type,state,chat_id);',
  'CREATE TABLE IF NOT EXISTS identity_backfill_issues (',
  '  issue_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, entity_type TEXT NOT NULL CHECK(entity_type IN (\'todo\',\'topic\')),',
  '  entity_id TEXT NOT NULL, issue_kind TEXT NOT NULL CHECK(issue_kind IN (\'malformed_source_json\',\'orphan_source_ref\',\'term_limit_exceeded\')),',
  '  detail_json TEXT NOT NULL CHECK(json_valid(detail_json)), state TEXT NOT NULL CHECK(state IN (\'open\',\'resolved\')),',
  '  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(chat_id,entity_type,entity_id,issue_kind,detail_json),',
  '  FOREIGN KEY(chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE ON UPDATE RESTRICT',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_identity_backfill_issues_inbox ON identity_backfill_issues(chat_id,state,entity_type,updated_at,issue_id);',
  'CREATE TABLE IF NOT EXISTS todo_identity_terms (',
  '  chat_id TEXT NOT NULL, term TEXT NOT NULL CHECK(length(term) BETWEEN 1 AND 128), todo_id TEXT NOT NULL,',
  '  indexed_revision INTEGER NOT NULL CHECK(indexed_revision > 0), term_kind TEXT NOT NULL CHECK(term_kind IN (\'current\',\'historical\')),',
  '  PRIMARY KEY(chat_id,term,todo_id,term_kind),',
  '  FOREIGN KEY(chat_id,todo_id) REFERENCES todos(chat_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_todo_identity_terms_entity ON todo_identity_terms(chat_id,todo_id,term_kind,indexed_revision);',
  'CREATE TABLE IF NOT EXISTS todo_identity_aliases (',
  '  alias_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, todo_id TEXT NOT NULL, title TEXT NOT NULL, detail TEXT,',
  '  source_msg_ids TEXT NOT NULL, entity_revision INTEGER NOT NULL CHECK(entity_revision > 0), created_at TEXT NOT NULL,',
  '  UNIQUE(chat_id,todo_id,entity_revision), FOREIGN KEY(chat_id,todo_id) REFERENCES todos(chat_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT',
  ');',
  'CREATE TABLE IF NOT EXISTS todo_identity_sources (',
  '  chat_id TEXT NOT NULL, todo_id TEXT NOT NULL, msg_id TEXT NOT NULL, source_role TEXT NOT NULL CHECK(source_role IN (\'canonical\',\'historical\',\'decision\')),',
  '  PRIMARY KEY(chat_id,todo_id,msg_id),',
  '  FOREIGN KEY(chat_id,todo_id) REFERENCES todos(chat_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT,',
  '  FOREIGN KEY(chat_id,msg_id) REFERENCES messages(chat_id,msg_id) ON DELETE RESTRICT ON UPDATE RESTRICT',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_todo_identity_sources_source ON todo_identity_sources(chat_id,msg_id,todo_id);',
  'CREATE TABLE IF NOT EXISTS todo_identity_decisions (',
  '  decision_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, source_digest TEXT NOT NULL CHECK(length(source_digest)=64), draft_ref TEXT NOT NULL,',
  '  outcome TEXT NOT NULL CHECK(outcome IN (\'update_existing\',\'new\',\'link\',\'defer\')), state TEXT NOT NULL CHECK(state IN (\'open\',\'resolved\',\'stale\',\'dismissed\')),',
  '  canonical_todo_id TEXT, decision_revision INTEGER NOT NULL CHECK(decision_revision>=1), source_epoch INTEGER NOT NULL CHECK(source_epoch>=1),',
  '  scope_revision INTEGER NOT NULL CHECK(scope_revision>=1), identity_revision INTEGER NOT NULL CHECK(identity_revision>=0), topic_identity_revision INTEGER NOT NULL CHECK(topic_identity_revision>=0), draft_json TEXT NOT NULL CHECK(json_valid(draft_json)),',
  '  candidate_snapshot_json TEXT NOT NULL CHECK(json_valid(candidate_snapshot_json)), reason_codes_json TEXT NOT NULL CHECK(json_valid(reason_codes_json)),',
  '  prompt_version TEXT NOT NULL, schema_version TEXT NOT NULL, query_version TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,',
  '  UNIQUE(chat_id,source_digest,draft_ref,decision_revision), UNIQUE(decision_id,chat_id),',
  '  FOREIGN KEY(chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE ON UPDATE RESTRICT,',
  '  FOREIGN KEY(chat_id,canonical_todo_id) REFERENCES todos(chat_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_todo_identity_decisions_keyset ON todo_identity_decisions(chat_id,state,decision_id);',
  'CREATE TABLE IF NOT EXISTS todo_identity_decision_sources (',
  '  decision_id TEXT NOT NULL, chat_id TEXT NOT NULL, msg_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=0),',
  '  evidence_role TEXT NOT NULL CHECK(evidence_role IN (\'action\',\'date\',\'owner\',\'context\',\'counterevidence\')),',
  '  PRIMARY KEY(decision_id,msg_id), UNIQUE(decision_id,ordinal),',
  '  FOREIGN KEY(decision_id,chat_id) REFERENCES todo_identity_decisions(decision_id,chat_id) ON DELETE CASCADE ON UPDATE RESTRICT,',
  '  FOREIGN KEY(chat_id,msg_id) REFERENCES messages(chat_id,msg_id) ON DELETE RESTRICT ON UPDATE RESTRICT',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_todo_identity_sources_inbox ON todo_identity_decision_sources(chat_id,msg_id,decision_id);',
  'CREATE TABLE IF NOT EXISTS todo_identity_events (',
  '  event_id TEXT PRIMARY KEY, decision_id TEXT NOT NULL, event_revision INTEGER NOT NULL CHECK(event_revision>=1),',
  '  actor TEXT NOT NULL CHECK(actor IN (\'ai\',\'user\',\'system\')),',
  '  action TEXT NOT NULL CHECK(action IN (\'created\',\'deferred\',\'stale\',\'retried\',\'resolved_existing\',\'resolved_new\',\'updated_existing\',\'linked\',\'relation_accepted\',\'relation_rejected\',\'dismissed\')),',
  '  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), created_at TEXT NOT NULL, UNIQUE(decision_id,event_revision),',
  '  FOREIGN KEY(decision_id) REFERENCES todo_identity_decisions(decision_id) ON DELETE RESTRICT ON UPDATE RESTRICT',
  ');',
  'CREATE TABLE IF NOT EXISTS todo_identity_relations (',
  '  relation_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, left_todo_id TEXT NOT NULL, right_todo_id TEXT NOT NULL,',
  '  relation_type TEXT NOT NULL CHECK(relation_type IN (\'recurrence\',\'related_action\',\'follow_up\')),',
  '  status TEXT NOT NULL CHECK(status IN (\'proposed\',\'confirmed\',\'rejected\')), decision_id TEXT NOT NULL, created_at TEXT NOT NULL,',
  '  CHECK(left_todo_id<>right_todo_id), UNIQUE(chat_id,left_todo_id,right_todo_id,relation_type),',
  '  FOREIGN KEY(chat_id,left_todo_id) REFERENCES todos(chat_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT,',
  '  FOREIGN KEY(chat_id,right_todo_id) REFERENCES todos(chat_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT,',
  '  FOREIGN KEY(decision_id) REFERENCES todo_identity_decisions(decision_id) ON DELETE RESTRICT ON UPDATE RESTRICT',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_todo_identity_relations_right ON todo_identity_relations(chat_id,right_todo_id,left_todo_id);',
  'CREATE TABLE IF NOT EXISTS todo_topic_identity_relations (',
  '  relation_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, todo_id TEXT NOT NULL, topic_id TEXT NOT NULL,',
  '  relation_type TEXT NOT NULL CHECK(relation_type IN (\'same_topic\',\'related_action\')),',
  '  status TEXT NOT NULL CHECK(status IN (\'proposed\',\'confirmed\',\'rejected\',\'stale\')), decision_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1), created_at TEXT NOT NULL,',
  '  UNIQUE(chat_id,todo_id,topic_id,relation_type),',
  '  FOREIGN KEY(chat_id,todo_id) REFERENCES todos(chat_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT,',
  '  FOREIGN KEY(chat_id,topic_id) REFERENCES discussion_topics(chat_id,topic_id) ON DELETE RESTRICT ON UPDATE RESTRICT,',
  '  FOREIGN KEY(decision_id) REFERENCES todo_identity_decisions(decision_id) ON DELETE RESTRICT ON UPDATE RESTRICT',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_todo_topic_identity_topic ON todo_topic_identity_relations(chat_id,topic_id,todo_id);',
  "INSERT OR IGNORE INTO identity_index_meta(chat_id,entity_type,tokenizer_version,state,updated_at) SELECT c.chat_id,'todo','identity-query-v2',CASE WHEN EXISTS(SELECT 1 FROM todos t WHERE t.chat_id=c.chat_id) THEN 'building' ELSE 'ready' END,c.last_seen_at FROM chats c;",
  'CREATE TRIGGER IF NOT EXISTS trg_todos_identity_insert AFTER INSERT ON todos BEGIN',
  "  UPDATE chat_context_cache SET todo_identity_revision=todo_identity_revision+1,state_version=state_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id=NEW.chat_id;",
  "  INSERT OR IGNORE INTO identity_index_meta(chat_id,entity_type,tokenizer_version,state,updated_at) VALUES(NEW.chat_id,'todo','identity-query-v2','stale',strftime('%Y-%m-%dT%H:%M:%fZ','now'));",
  "  UPDATE identity_index_meta SET state='stale',cursor_entity_id=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id=NEW.chat_id AND entity_type='todo';",
  'END;',
  'CREATE TRIGGER IF NOT EXISTS trg_todos_identity_update AFTER UPDATE OF chat_id,bucket,status,title,detail,priority,due_at,source_msg_ids,confidence,completion_evidence,resolved_at ON todos',
  'WHEN OLD.chat_id IS NOT NEW.chat_id OR OLD.bucket IS NOT NEW.bucket OR OLD.status IS NOT NEW.status OR OLD.title IS NOT NEW.title OR OLD.detail IS NOT NEW.detail OR OLD.priority IS NOT NEW.priority OR OLD.due_at IS NOT NEW.due_at OR OLD.source_msg_ids IS NOT NEW.source_msg_ids OR OLD.confidence IS NOT NEW.confidence OR OLD.completion_evidence IS NOT NEW.completion_evidence OR OLD.resolved_at IS NOT NEW.resolved_at',
  'BEGIN',
  "  INSERT OR IGNORE INTO todo_identity_aliases(alias_id,chat_id,todo_id,title,detail,source_msg_ids,entity_revision,created_at) VALUES(lower(hex(randomblob(16))),OLD.chat_id,OLD.id,OLD.title,OLD.detail,OLD.source_msg_ids,OLD.entity_revision,strftime('%Y-%m-%dT%H:%M:%fZ','now'));",
  '  UPDATE todos SET entity_revision=entity_revision+1 WHERE id=NEW.id;',
  "  UPDATE chat_context_cache SET todo_identity_revision=todo_identity_revision+1,state_version=state_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id=OLD.chat_id OR chat_id=NEW.chat_id;",
  "  UPDATE identity_index_meta SET state='stale',cursor_entity_id=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE (chat_id=OLD.chat_id OR chat_id=NEW.chat_id) AND entity_type='todo';",
  'END;',
  'CREATE TRIGGER IF NOT EXISTS trg_todos_identity_delete AFTER DELETE ON todos BEGIN',
  "  UPDATE chat_context_cache SET todo_identity_revision=todo_identity_revision+1,state_version=state_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id=OLD.chat_id;",
  "  UPDATE identity_index_meta SET state='stale',cursor_entity_id=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id=OLD.chat_id AND entity_type='todo';",
  'END;'
].join('\n')

/**
 * 建立全部資料表與索引的 DDL。所有語句皆 IF NOT EXISTS，重複執行安全（冪等）。
 * 不含 PRAGMA journal_mode / foreign_keys —— 那些是「連線層」設定，由 database.ts
 * 在開連線時下，不放進可重跑的 schema exec 裡。
 */
const BASE_SCHEMA_DDL = /* sql */ `
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
  media_oid TEXT,
  media_sid TEXT,
  shared_contact_mid TEXT,
  shared_contact_display_name TEXT,
  sticker_id TEXT,
  sticker_package_id TEXT,
  media_backed_up INTEGER NOT NULL DEFAULT 0,
  unsent INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (chat_id) REFERENCES chats(chat_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_pending_ts ON messages(ts) WHERE processed = 0;

CREATE TABLE IF NOT EXISTS todos (
  id                  TEXT PRIMARY KEY,
  chat_id             TEXT NOT NULL,
  entity_revision     INTEGER NOT NULL DEFAULT 1 CHECK(entity_revision >= 1),
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
CREATE UNIQUE INDEX IF NOT EXISTS ux_todos_chat_id ON todos(chat_id,id);

CREATE TABLE IF NOT EXISTS todo_not_mine_events (
  feedback_id TEXT PRIMARY KEY, todo_id TEXT NOT NULL, event_type TEXT NOT NULL,
  previous_status TEXT, reason_code TEXT, note TEXT, source_msg_ids TEXT NOT NULL,
  analysis_json TEXT, correction_id TEXT, correction_revision INTEGER, parent_feedback_id TEXT, created_at TEXT NOT NULL,
  FOREIGN KEY (todo_id) REFERENCES todos(id),
  FOREIGN KEY (parent_feedback_id) REFERENCES todo_not_mine_events(feedback_id)
);
CREATE INDEX IF NOT EXISTS idx_not_mine_events_todo ON todo_not_mine_events(todo_id, created_at);
CREATE INDEX IF NOT EXISTS idx_not_mine_analysis_parent ON todo_not_mine_events(parent_feedback_id, created_at) WHERE parent_feedback_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS todo_classification_corrections (
  id TEXT PRIMARY KEY, feedback_id TEXT NOT NULL, chat_id TEXT NOT NULL,
  revision INTEGER NOT NULL, condition_text TEXT NOT NULL, effect_text TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (feedback_id) REFERENCES todo_not_mine_events(feedback_id),
  FOREIGN KEY (chat_id) REFERENCES chats(chat_id)
);
CREATE TABLE IF NOT EXISTS todo_correction_effects (
  id TEXT PRIMARY KEY, correction_id TEXT NOT NULL, revision INTEGER NOT NULL,
  chat_id TEXT NOT NULL, message_ids TEXT NOT NULL, stage TEXT NOT NULL, created_at TEXT NOT NULL
);

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

export const SCHEMA_DDL = BASE_SCHEMA_DDL + '\n' + SOURCE_CACHE_DDL + '\n' + IDENTITY_CORE_DDL

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
  media_oid: string | null
  media_sid: string | null
  shared_contact_mid: string | null
  shared_contact_display_name: string | null
  sticker_id: string | null
  sticker_package_id: string | null
  media_backed_up: number
  unsent: number
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
  const basis = `${m.chatId}\u0001${m.ts}\u0001${m.direction}\u0001${m.sender}\u0001${m.text}`
  return 'd:' + createHash('sha1').update(basis, 'utf8').digest('hex')
}
