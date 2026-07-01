import type { Database } from 'better-sqlite3'
import { getDb } from './database'
import type { ChatRow } from './schema'
import type { ChatDTO } from './dto'

/**
 * chats.repo — 聊天室 upsert / 查詢 / 黑名單切換。
 *
 * upsert 語意：第一次見到某 chat 就插入（記 first_seen_at）；之後同 chatId 進來只
 * 更新 name（顯示名可能變）與 last_seen_at，**不**動 blocked/block_reason/first_seen_at
 * （那是使用者或自動規則的決定，訊息流不該覆寫）。
 */

function rowToDTO(r: ChatRow): ChatDTO {
  return {
    chatId: r.chat_id,
    name: r.name,
    isGroup: r.is_group === 1,
    blocked: r.blocked === 1,
    blockReason: r.block_reason,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at
  }
}

export interface UpsertChatInput {
  chatId: string
  name: string | null
  isGroup: boolean
  /** App 端落庫時間（ISO8601）；由呼叫端統一傳入，確保同一輪 batch 時間一致。 */
  seenAt: string
}

/**
 * upsert 單一 chat。回傳 upsert 後的完整列。
 * ON CONFLICT 只更新 name（非 null 時）與 last_seen_at。
 */
export function upsertChat(input: UpsertChatInput, db: Database = getDb()): ChatDTO {
  db.prepare(
    `INSERT INTO chats (chat_id, name, is_group, blocked, block_reason, first_seen_at, last_seen_at)
     VALUES (@chatId, @name, @isGroup, 0, NULL, @seenAt, @seenAt)
     ON CONFLICT(chat_id) DO UPDATE SET
       name         = COALESCE(excluded.name, chats.name),
       last_seen_at = excluded.last_seen_at`
  ).run({
    chatId: input.chatId,
    name: input.name,
    isGroup: input.isGroup ? 1 : 0,
    seenAt: input.seenAt
  })

  return getChat(input.chatId, db) as ChatDTO
}

/** 取單一 chat（查無回 null）。 */
export function getChat(chatId: string, db: Database = getDb()): ChatDTO | null {
  const row = db.prepare('SELECT * FROM chats WHERE chat_id = ?').get(chatId) as
    | ChatRow
    | undefined
  return row ? rowToDTO(row) : null
}

/** 列出聊天室；預設不含黑名單。依 last_seen_at 由新到舊。 */
export function listChats(
  opts: { includeBlocked?: boolean } = {},
  db: Database = getDb()
): ChatDTO[] {
  const where = opts.includeBlocked ? '' : 'WHERE blocked = 0'
  const rows = db
    .prepare(`SELECT * FROM chats ${where} ORDER BY last_seen_at DESC`)
    .all() as ChatRow[]
  return rows.map(rowToDTO)
}

/** 切換黑名單旗標。回傳更新後的列（查無回 null）。 */
export function setBlocked(
  chatId: string,
  blocked: boolean,
  reason: string | null = null,
  db: Database = getDb()
): ChatDTO | null {
  const info = db
    .prepare('UPDATE chats SET blocked = ?, block_reason = ? WHERE chat_id = ?')
    .run(blocked ? 1 : 0, blocked ? reason : null, chatId)
  if (info.changes === 0) return null
  return getChat(chatId, db)
}
