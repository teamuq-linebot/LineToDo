import type { Database } from 'better-sqlite3'
import { runImmediateTransaction } from './sourceCache'

export const TODO_BACKFILL_DAYS = 7
const DAY_MS = 86_400_000

const readyDbs = new WeakSet<object>()

export function ensureChatTodoPrefsSchema(db: Database): void {
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_todo_preferences (
        chat_id TEXT PRIMARY KEY,
        extract_enabled INTEGER NOT NULL DEFAULT 1 CHECK(extract_enabled IN (0,1)),
        updated_at TEXT NOT NULL,
        FOREIGN KEY(chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE
      );
    `)
    const hasCache = (db.prepare("SELECT 1 AS yes FROM sqlite_master WHERE type='table' AND name='chat_context_cache'").get() as { yes: number } | undefined)?.yes === 1
    if (hasCache) {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_chat_todo_preferences_cache_after_insert
        AFTER INSERT ON chat_todo_preferences
        BEGIN
          UPDATE chat_context_cache SET scope_revision=scope_revision+1,state_version=state_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id=NEW.chat_id;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_chat_todo_preferences_cache_after_update
        AFTER UPDATE OF extract_enabled ON chat_todo_preferences
        WHEN OLD.extract_enabled IS NOT NEW.extract_enabled
        BEGIN
          UPDATE chat_context_cache SET scope_revision=scope_revision+1,state_version=state_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id=NEW.chat_id;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_chat_todo_preferences_cache_after_delete
        AFTER DELETE ON chat_todo_preferences
        BEGIN
          UPDATE chat_context_cache SET scope_revision=scope_revision+1,state_version=state_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id=OLD.chat_id;
        END;
      `)
    }
  })
  runImmediateTransaction(tx)
  readyDbs.add(db)
}

export function chatTodoPrefsReady(db: Database): boolean {
  if (readyDbs.has(db)) return true
  try {
    const row = db.prepare("SELECT 1 AS yes FROM sqlite_master WHERE type='table' AND name='chat_todo_preferences'").get() as { yes: number } | undefined
    if (row?.yes === 1) {
      readyDbs.add(db)
      return true
    }
  } catch {
    return false
  }
  return false
}

export function isTodoExtractEnabled(db: Database, chatId: string): boolean {
  // fail-closed：遷移尚未完成（開關表缺、或遷移拋錯）時，blocked=1 的聊天室視為關閉；遷移成功後 blocked 全為 0，此檢查無害。
  try {
    if (db.prepare('SELECT 1 AS x FROM chats WHERE chat_id=? AND blocked=1').get(chatId)) return false
  } catch {
    return false
  }
  if (!chatTodoPrefsReady(db)) return true
  try {
    const row = db.prepare('SELECT extract_enabled FROM chat_todo_preferences WHERE chat_id=?').get(chatId) as { extract_enabled: number } | undefined
    return row === undefined ? true : row.extract_enabled !== 0
  } catch {
    return true
  }
}

export interface MigrateIgnoredChatsResult {
  migrated: number
  skipped?: 'prefs_unavailable'
}

export function migrateIgnoredChats(db: Database, nowMs = Date.now()): MigrateIgnoredChatsResult {
  if (!chatTodoPrefsReady(db)) return { migrated: 0, skipped: 'prefs_unavailable' }
  const stamp = new Date(nowMs).toISOString()
  const tx = db.transaction((): MigrateIgnoredChatsResult => {
    const count = (db.prepare('SELECT COUNT(*) AS n FROM chats WHERE blocked=1').get() as { n: number }).n
    if (count === 0) return { migrated: 0 }
    db.prepare(
      'INSERT INTO chat_todo_preferences(chat_id,extract_enabled,updated_at) SELECT chat_id,0,? FROM chats WHERE blocked=1 ' +
      'ON CONFLICT(chat_id) DO UPDATE SET extract_enabled=0, updated_at=excluded.updated_at'
    ).run(stamp)
    const hasTopicPrefs = (db.prepare("SELECT 1 AS yes FROM sqlite_master WHERE type='table' AND name='group_topic_preferences'").get() as { yes: number } | undefined)?.yes === 1
    if (hasTopicPrefs) {
      db.prepare(
        'UPDATE group_topic_preferences SET enabled=0, updated_at=? WHERE enabled=1 AND chat_id IN (SELECT chat_id FROM chats WHERE blocked=1)'
      ).run(stamp)
    }
    db.prepare('UPDATE chats SET blocked=0, block_reason=NULL WHERE blocked=1').run()
    return { migrated: count }
  })
  return runImmediateTransaction(tx)
}

export interface SetTodoExtractResult {
  ok: boolean
  enabled: boolean
  skippedOlder: number
}

export function setTodoExtractEnabled(db: Database, chatId: string, enabled: boolean, nowMs = Date.now()): SetTodoExtractResult {
  if (!chatTodoPrefsReady(db)) return { ok: false, enabled: true, skippedOlder: 0 }
  const tx = db.transaction((): SetTodoExtractResult => {
    const chat = db.prepare('SELECT 1 AS x FROM chats WHERE chat_id=?').get(chatId)
    const current = isTodoExtractEnabled(db, chatId)
    if (!chat) return { ok: false, enabled: current, skippedOlder: 0 }
    const stamp = new Date(nowMs).toISOString()
    if (!enabled) {
      db.prepare(
        'INSERT INTO chat_todo_preferences(chat_id,extract_enabled,updated_at) VALUES (?,0,?) ' +
        'ON CONFLICT(chat_id) DO UPDATE SET extract_enabled=0, updated_at=excluded.updated_at'
      ).run(chatId, stamp)
      return { ok: true, enabled: false, skippedOlder: 0 }
    }
    if (current) return { ok: true, enabled: true, skippedOlder: 0 }
    db.prepare('UPDATE chat_todo_preferences SET extract_enabled=1, updated_at=? WHERE chat_id=?').run(stamp, chatId)
    const cutoff = nowMs - TODO_BACKFILL_DAYS * DAY_MS
    const changes = db.prepare('UPDATE messages SET processed=1 WHERE chat_id=? AND processed=0 AND ts < ?').run(chatId, cutoff).changes
    return { ok: true, enabled: true, skippedOlder: changes }
  })
  return runImmediateTransaction(tx)
}
