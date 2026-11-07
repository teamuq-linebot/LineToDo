import type { Database } from 'better-sqlite3'
import { IDENTITY_CORE_DDL, MESSAGE_PARTICIPANTS_DDL, SCHEMA_DDL, SCHEMA_VERSION, SOURCE_CACHE_DDL } from './schema'

export type StorageMaintenanceStep = 'M-I2' | 'M-I1' | 'M-P1'
export interface StorageMaintenanceStepResult {
  step: StorageMaintenanceStep
  status: 'done' | 'skipped' | 'noop'
  reason?: string
  rows?: number
}
export interface StorageMaintenanceReport {
  steps: StorageMaintenanceStepResult[]
  changed: boolean
}

const PENDING_INDEX = 'idx_messages_pending_ts'
const CHAT_TS_MSG_INDEX = 'idx_messages_chat_ts_msg'

function schemaObjectExists(db: Database, type: 'index' | 'table', name: string): boolean {
  return db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get(type, name) !== undefined
}

/**
 * v10 storage maintenance（WP-M，使用者 2026-11-03 核准的步驟）：M-I2、M-I1、M-P1（含 M-I3）。
 * 不做 VACUUM、不做 M-Q。每一步的前置條件在此檢查；不成立就只略過該步並 console.warn 原因，其餘照常。
 * 全部可重複執行：已完成的步驟再跑只會回報 noop。必須在 migrate 的交易內（或自行開交易）呼叫。
 * M-W（wal_checkpoint）不能在交易內做，由 migrate 在交易提交後執行。
 */
export function runStorageMaintenanceV10(db: Database): StorageMaintenanceReport {
  const steps: StorageMaintenanceStepResult[] = []
  const skip = (step: StorageMaintenanceStep, reason: string): void => {
    console.warn(`[db] migrate v10 ${step} skipped: ${reason}`)
    steps.push({ step, status: 'skipped', reason })
  }

  // M-I2：idx_messages_unproc 只能在 partial pending index 存在之後刪（舊 pending 查詢才有索引可走）。
  if (!schemaObjectExists(db, 'index', 'idx_messages_unproc')) {
    steps.push({ step: 'M-I2', status: 'noop', reason: 'already absent' })
  } else if (!schemaObjectExists(db, 'index', PENDING_INDEX)) {
    skip('M-I2', `${PENDING_INDEX} does not exist`)
  } else {
    db.exec('DROP INDEX idx_messages_unproc;')
    steps.push({ step: 'M-I2', status: 'done' })
  }

  // M-I1：idx_messages_chat_ts 被 idx_messages_chat_ts_msg 涵蓋；後者不在就不刪。
  if (!schemaObjectExists(db, 'index', 'idx_messages_chat_ts')) {
    steps.push({ step: 'M-I1', status: 'noop', reason: 'already absent' })
  } else if (!schemaObjectExists(db, 'index', CHAT_TS_MSG_INDEX)) {
    skip('M-I1', `${CHAT_TS_MSG_INDEX} does not exist`)
  } else {
    db.exec('DROP INDEX idx_messages_chat_ts;')
    steps.push({ step: 'M-I1', status: 'done' })
  }

  // M-P1（含 M-I3）：只清「全是 unknown、沒有任何 keyed」的 message_participants；缺一條件就整步略過。
  if (!schemaObjectExists(db, 'table', 'message_participants')) {
    steps.push({ step: 'M-P1', status: 'noop', reason: 'table does not exist yet' })
  } else if (db.prepare('SELECT 1 FROM message_participants WHERE participant_key IS NOT NULL LIMIT 1').get() !== undefined) {
    skip('M-P1', 'a row with participant_key IS NOT NULL exists')
  } else if (db.prepare("SELECT 1 FROM message_participants WHERE NOT (scope = 'unknown' AND identity_status = 'unknown') LIMIT 1").get() !== undefined) {
    skip('M-P1', 'a row that is not scope=unknown AND identity_status=unknown exists')
  } else {
    const rows = (db.prepare('SELECT COUNT(*) AS n FROM message_participants').get() as { n: number }).n
    const hasIndex = schemaObjectExists(db, 'index', 'idx_message_participants_chat_key')
    if (rows === 0 && !hasIndex) {
      steps.push({ step: 'M-P1', status: 'noop', reason: 'table already empty', rows: 0 })
    } else {
      // DROP TABLE 連同索引一起釋放頁面，WAL 寫入量遠小於逐列 DELETE；重建用與 ensureLineImportSchema 相同的 DDL。
      db.exec('DROP TABLE message_participants;')
      db.exec(MESSAGE_PARTICIPANTS_DDL)
      steps.push({ step: 'M-P1', status: 'done', rows })
    }
  }

  const changed = steps.some((s) => s.status === 'done')
  if (changed) {
    console.info(`[db] migrate v10 storage maintenance: ${steps.map((s) => `${s.step}=${s.status}${s.rows !== undefined ? `(${s.rows} rows)` : ''}`).join(' ')}`)
  }
  return { steps, changed }
}

/** M-W。交易外執行；失敗只記錄，不影響已提交的 migration。 */
function checkpointWal(db: Database): void {
  try {
    const result = db.pragma('wal_checkpoint(TRUNCATE)')
    console.info('[db] migrate v10 M-W wal_checkpoint(TRUNCATE):', JSON.stringify(result))
  } catch (err) {
    console.warn('[db] migrate v10 M-W wal_checkpoint failed:', err instanceof Error ? err.message : String(err))
  }
}

/**
 * migrate.ts — 用 PRAGMA user_version 管理 schema 版本。
 *
 * v0（全新 DB）：套用 SCHEMA_DDL（最新全 schema），user_version 直接設到 SCHEMA_VERSION。
 * 既有舊庫升級：逐版疊加 ALTER/CREATE，最後把 user_version 設到目標版。
 *
 * 全程包在單一 transaction，升級失敗不會留半套 schema。
 */
export function migrate(db: Database): { from: number; to: number } {
  const from = db.pragma('user_version', { simple: true }) as number

  if (from === SCHEMA_VERSION) {
    return { from, to: from }
  }
  if (from > SCHEMA_VERSION) {
    // DB 比程式新（使用者裝過更新版又退回）—— 不破壞，只警告。
    console.warn(
      `[db] user_version=${from} 比程式預期的 ${SCHEMA_VERSION} 新；略過 migration。`
    )
    return { from, to: from }
  }

  let maintenance: StorageMaintenanceReport | null = null
  const runUpgrades = db.transaction((current: number) => {
    let v = current
    // v0（全新 DB）：SCHEMA_DDL 已是最新全 schema（含媒體 3 欄），套用後直接跳到
    // SCHEMA_VERSION，略過所有增量 migration（否則會與下方 ALTER 撞成 duplicate column）。
    if (v < 1) {
      db.exec(SCHEMA_DDL)
      v = SCHEMA_VERSION
    }
    // v1 → v2：messages 表加媒體 3 欄（key_material/orig_filename/file_size，皆 NULLable）。
    // 僅對既有 v1 舊庫執行；fresh 安裝已在上面跳過。
    if (v < 2) {
      db.exec(
        'ALTER TABLE messages ADD COLUMN key_material TEXT; ' +
          'ALTER TABLE messages ADD COLUMN orig_filename TEXT; ' +
          'ALTER TABLE messages ADD COLUMN file_size INTEGER;'
      )
      v = 2
    }
    // v2 → v3：messages 表加 media_backed_up 追蹤欄（0=未備份 / 1=已備份）。
    // SQLite ALTER ADD COLUMN 帶 NOT NULL 需給 DEFAULT，已給 0。僅對既有 v2 舊庫執行。
    if (v < 3) {
      db.exec(
        'ALTER TABLE messages ADD COLUMN media_backed_up INTEGER NOT NULL DEFAULT 0;'
      )
      v = 3
    }
    // v3 → v4：messages 表加 unsent 追蹤欄（0=正常 / 1=已收回，LINE _attribute==1）。
    // SQLite ALTER ADD COLUMN 帶 NOT NULL 需給 DEFAULT，已給 0。僅對既有 v3 舊庫執行。
    if (v < 4) {
      db.exec('ALTER TABLE messages ADD COLUMN unsent INTEGER NOT NULL DEFAULT 0;')
      v = 4
    }
    // v4 → v5: additive not-mine feedback and chat-scoped correction audit.
    if (v < 5) {
      db.exec(`CREATE TABLE IF NOT EXISTS todo_not_mine_events (
        feedback_id TEXT PRIMARY KEY, todo_id TEXT NOT NULL, event_type TEXT NOT NULL,
        previous_status TEXT, reason_code TEXT, note TEXT, source_msg_ids TEXT NOT NULL,
        analysis_json TEXT, correction_id TEXT, correction_revision INTEGER, created_at TEXT NOT NULL,
        FOREIGN KEY (todo_id) REFERENCES todos(id));
        CREATE INDEX IF NOT EXISTS idx_not_mine_events_todo ON todo_not_mine_events(todo_id, created_at);
        CREATE TABLE IF NOT EXISTS todo_classification_corrections (
          id TEXT PRIMARY KEY, feedback_id TEXT NOT NULL, chat_id TEXT NOT NULL,
          revision INTEGER NOT NULL, condition_text TEXT NOT NULL, effect_text TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          FOREIGN KEY (feedback_id) REFERENCES todo_not_mine_events(feedback_id),
          FOREIGN KEY (chat_id) REFERENCES chats(chat_id));
        CREATE TABLE IF NOT EXISTS todo_correction_effects (
          id TEXT PRIMARY KEY, correction_id TEXT NOT NULL, revision INTEGER NOT NULL,
          chat_id TEXT NOT NULL, message_ids TEXT NOT NULL, stage TEXT NOT NULL, created_at TEXT NOT NULL);`)
      v = 5
    }
    // v5 → v6: link append-only analysis_saved events to their marked feedback row.
    if (v < 6) {
      db.exec('ALTER TABLE todo_not_mine_events ADD COLUMN parent_feedback_id TEXT REFERENCES todo_not_mine_events(feedback_id); CREATE INDEX IF NOT EXISTS idx_not_mine_analysis_parent ON todo_not_mine_events(parent_feedback_id, created_at) WHERE parent_feedback_id IS NOT NULL;')
      v = 6
    }
    // v6 → v7: additive raw-source cache coordination. Backfill one cold
    // metadata row per existing chat before source triggers become active.
    if (v < 7) {
      db.exec(SOURCE_CACHE_DDL)
      v = 7
    }
    // v7 -> v8: additive Todo entity history, candidate indexes, decisions and relations.
    // Canonical IDs and legacy source_msg_ids remain unchanged. Topic-specific tables are
    // owned by GroupTopics' independent feature migration.
    if (v < 8) {
      db.exec('ALTER TABLE todos ADD COLUMN entity_revision INTEGER NOT NULL DEFAULT 1 CHECK(entity_revision >= 1);')
      db.exec(IDENTITY_CORE_DDL)
      v = 8
    }
    // v8 -> v9: additive partial index for the pipeline's pending-message selection. Nothing is
    // dropped here; v10 below removes idx_messages_chat_ts and idx_messages_unproc.
    if (v < 9) {
      db.exec('CREATE INDEX IF NOT EXISTS idx_messages_pending_ts ON messages(ts) WHERE processed = 0;')
      v = 9
    }
    // v9 -> v10: user-approved destructive storage maintenance (WP-M): drop idx_messages_unproc and
    // idx_messages_chat_ts, and clear the all-unknown message_participants table. Each step checks its own
    // precondition and is skipped (with a warning) when it does not hold. The whole version step shares the
    // migrate transaction, so a failure anywhere rolls back every step and user_version.
    if (v < 10) {
      maintenance = runStorageMaintenanceV10(db)
      v = 10
    }
    db.pragma(`user_version = ${v}`)
    return v
  })

  const to = runUpgrades(from)
  if ((maintenance as StorageMaintenanceReport | null)?.changed) checkpointWal(db)
  return { from, to }
}
