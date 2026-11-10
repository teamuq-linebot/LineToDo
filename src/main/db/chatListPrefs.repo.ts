import type { Database } from 'better-sqlite3'
import { applyTodoExtractEnabled, chatTodoPrefsReady } from './chatTodoPrefs.repo'
import { isEnabled } from '../features/groupTopics/repository'
import { runImmediateTransaction } from './sourceCache'

/**
 * 聊天室列表的「置頂／隱藏」旗標，加上忽略（＝待辦與議題兩個開關）的批次讀取。
 *
 * 這張表只影響列表怎麼排、怎麼顯示，**不是**任何抽取閘門：待辦／議題是否抽取仍只看 chat_todo_preferences 與 group_topic_preferences。
 * 不寫舊的封鎖欄位（只由 migrateIgnoredChats 清掉）。不建 chat_context_cache 觸發器：列表旗標不改變抽取範圍。
 */

const readyDbs = new WeakSet<object>()

export function ensureChatListPrefsSchema(db: Database): void {
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_list_preferences (
        chat_id TEXT PRIMARY KEY,
        pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
        hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1)),
        updated_at TEXT NOT NULL,
        FOREIGN KEY(chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE
      );
    `)
  })
  runImmediateTransaction(tx)
  readyDbs.add(db)
}

function tableExists(db: Database, name: string): boolean {
  try {
    return (db.prepare("SELECT 1 AS yes FROM sqlite_master WHERE type='table' AND name=?").get(name) as { yes: number } | undefined)?.yes === 1
  } catch {
    return false
  }
}

export function chatListPrefsReady(db: Database): boolean {
  if (readyDbs.has(db)) return true
  if (tableExists(db, 'chat_list_preferences')) {
    readyDbs.add(db)
    return true
  }
  return false
}

export interface ChatListPrefsSnapshot {
  /** chat_list_preferences 可用；false 時 pinned／hidden 一律為空，置頂與隱藏不能寫。 */
  prefsReady: boolean
  /** 議題功能可用；false 時 topicsOn 為空，忽略／恢復不碰議題。 */
  topicsAvailable: boolean
  pinned: string[]
  hidden: string[]
  /** 待辦抽取關閉的聊天室（語意同 isTodoExtractEnabled：含舊資料 blocked=1，fail-closed）。 */
  todoOff: string[]
  /** 議題開啟的聊天室（語意同 groupTopics isEnabled：blocked=1 不算）。 */
  topicsOn: string[]
}

export interface ChatListPrefsOptions {
  /** 議題服務是否存在（application 層 groupTopicsService 不是 null）。預設 true。 */
  topics?: boolean
}

function ids(db: Database, sql: string): string[] {
  return (db.prepare(sql).all() as Array<{ chat_id: string }>).map((row) => row.chat_id)
}

/** 議題開啟的聊天室；判斷與 isEnabled 相同（無紀錄的群組依待辦開關），SQL 只做候選預篩。 */
function topicsOnChats(db: Database): string[] {
  return ids(db, 'SELECT c.chat_id FROM chats c LEFT JOIN group_topic_preferences p ON p.chat_id=c.chat_id WHERE c.blocked=0 AND (c.is_group=1 OR p.enabled=1) ORDER BY c.chat_id')
    .filter((chatId) => isEnabled(db, chatId))
}

export function listChatPrefs(db: Database, options: ChatListPrefsOptions = {}): ChatListPrefsSnapshot {
  const prefsReady = chatListPrefsReady(db)
  const topicsAvailable = options.topics !== false && tableExists(db, 'group_topic_preferences')
  const todoPrefs = chatTodoPrefsReady(db)
  const todoOffSql = todoPrefs
    ? "SELECT c.chat_id FROM chats c LEFT JOIN chat_todo_preferences p ON p.chat_id=c.chat_id WHERE c.blocked=1 OR p.extract_enabled=0 ORDER BY c.chat_id"
    : 'SELECT chat_id FROM chats WHERE blocked=1 ORDER BY chat_id'
  return {
    prefsReady,
    topicsAvailable,
    pinned: prefsReady ? ids(db, 'SELECT chat_id FROM chat_list_preferences WHERE pinned=1 ORDER BY chat_id') : [],
    hidden: prefsReady ? ids(db, 'SELECT chat_id FROM chat_list_preferences WHERE hidden=1 ORDER BY chat_id') : [],
    todoOff: ids(db, todoOffSql),
    topicsOn: topicsAvailable
      ? topicsOnChats(db)
      : []
  }
}

function chatExists(db: Database, chatId: string): boolean {
  return db.prepare('SELECT 1 AS x FROM chats WHERE chat_id=?').get(chatId) !== undefined
}

function dropEmptyRow(db: Database, chatId: string): void {
  db.prepare('DELETE FROM chat_list_preferences WHERE chat_id=? AND pinned=0 AND hidden=0').run(chatId)
}

export interface SetPinnedResult { ok: boolean; pinned: boolean }

export function setChatPinned(db: Database, chatId: string, pinned: boolean, nowMs = Date.now()): SetPinnedResult {
  if (!chatListPrefsReady(db)) return { ok: false, pinned: false }
  const tx = db.transaction((): SetPinnedResult => {
    if (!chatExists(db, chatId)) return { ok: false, pinned: false }
    const stamp = new Date(nowMs).toISOString()
    db.prepare(
      'INSERT INTO chat_list_preferences(chat_id,pinned,hidden,updated_at) VALUES (?,?,0,?) ' +
      'ON CONFLICT(chat_id) DO UPDATE SET pinned=excluded.pinned, updated_at=excluded.updated_at'
    ).run(chatId, pinned ? 1 : 0, stamp)
    dropEmptyRow(db, chatId)
    return { ok: true, pinned }
  })
  return runImmediateTransaction(tx)
}

export interface SetIgnoredResult { ok: boolean; ignored: boolean; skippedOlder: number }

export interface ChatIgnoreOptions extends ChatListPrefsOptions {
  nowMs?: number
}

function topicsOff(db: Database, chatId: string, stamp: string): void {
  db.prepare('UPDATE group_topic_preferences SET enabled=0, updated_at=? WHERE chat_id=? AND enabled=1').run(stamp, chatId)
}

function topicsOnFor(db: Database, chatId: string, stamp: string): void {
  db.prepare(
    'INSERT INTO group_topic_preferences(chat_id,enabled,updated_at) VALUES (?,1,?) ' +
    'ON CONFLICT(chat_id) DO UPDATE SET enabled=1, updated_at=excluded.updated_at'
  ).run(chatId, stamp)
}

/**
 * 忽略＝待辦抽取與議題都關；恢復＝兩個都打開（待辦沿用 7 天補抽，議題含一對一）。
 * 單一交易：任一步拋錯整個還原，不會留下只關一半的狀態。
 */
export function setChatIgnored(db: Database, chatId: string, ignored: boolean, options: ChatIgnoreOptions = {}): SetIgnoredResult {
  if (!chatTodoPrefsReady(db)) return { ok: false, ignored: false, skippedOlder: 0 }
  const nowMs = options.nowMs ?? Date.now()
  const topics = options.topics !== false && tableExists(db, 'group_topic_preferences')
  const tx = db.transaction((): SetIgnoredResult => {
    const todo = applyTodoExtractEnabled(db, chatId, !ignored, nowMs)
    if (!todo.ok) return { ok: false, ignored: !todo.enabled, skippedOlder: 0 }
    const stamp = new Date(nowMs).toISOString()
    if (topics) {
      if (ignored) topicsOff(db, chatId, stamp)
      else topicsOnFor(db, chatId, stamp)
    }
    return { ok: true, ignored, skippedOlder: todo.skippedOlder }
  })
  return runImmediateTransaction(tx)
}

export interface SetHiddenResult { ok: boolean; hidden: boolean }

/**
 * 隱藏＝關掉待辦與議題（不再抽取）、標成隱藏、取消置頂；取消隱藏只把隱藏旗標拿掉，不重新打開任何開關（要恢復請用「恢復」）。
 */
export function setChatHidden(db: Database, chatId: string, hidden: boolean, options: ChatIgnoreOptions = {}): SetHiddenResult {
  if (!chatListPrefsReady(db)) return { ok: false, hidden: false }
  if (hidden && !chatTodoPrefsReady(db)) return { ok: false, hidden: false }
  const nowMs = options.nowMs ?? Date.now()
  const topics = options.topics !== false && tableExists(db, 'group_topic_preferences')
  const tx = db.transaction((): SetHiddenResult => {
    if (!chatExists(db, chatId)) return { ok: false, hidden: false }
    const stamp = new Date(nowMs).toISOString()
    if (hidden) {
      const todo = applyTodoExtractEnabled(db, chatId, false, nowMs)
      if (!todo.ok) return { ok: false, hidden: false }
      if (topics) topicsOff(db, chatId, stamp)
      db.prepare(
        'INSERT INTO chat_list_preferences(chat_id,pinned,hidden,updated_at) VALUES (?,0,1,?) ' +
        'ON CONFLICT(chat_id) DO UPDATE SET pinned=0, hidden=1, updated_at=excluded.updated_at'
      ).run(chatId, stamp)
      return { ok: true, hidden: true }
    }
    db.prepare('UPDATE chat_list_preferences SET hidden=0, updated_at=? WHERE chat_id=?').run(stamp, chatId)
    dropEmptyRow(db, chatId)
    return { ok: true, hidden: false }
  })
  return runImmediateTransaction(tx)
}
