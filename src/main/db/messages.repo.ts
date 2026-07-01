import type { Database } from 'better-sqlite3'
import { getDb } from './database'
import { deriveMsgId, type MessageRow } from './schema'
import type { MessageDTO } from './dto'
import type { RawLineMessage } from '../line/types'
import { upsertChat } from './chats.repo'

/**
 * messages.repo — sidecar(watch_json.py) 進來的訊息落庫 + 查詢。
 *
 * 去重：每則訊息推導穩定 msg_id（schema.deriveMsgId），以 PK + INSERT OR IGNORE 去重。
 *       同一則被重複輪詢只會落庫一次。
 * FK：messages.chat_id → chats.chat_id。為滿足 foreign_keys=ON，insert 前先 upsert chat。
 */

function rowToDTO(r: MessageRow): MessageDTO {
  return {
    msgId: r.msg_id,
    chatId: r.chat_id,
    ts: r.ts,
    timeIso: r.time_iso,
    direction: r.direction,
    sender: r.sender,
    text: r.text,
    contentType: r.content_type,
    processed: r.processed === 1,
    ingestedAt: r.ingested_at,
    // key_material 絕不進 DTO（media_feature_plan §4.4 安全邊界）——只 origFilename/fileSize。
    origFilename: r.orig_filename,
    fileSize: r.file_size,
    unsent: r.unsent === 1
  }
}

export interface InsertMessagesResult {
  /** 嘗試寫入的訊息數（= 傳入 batch 長度，去掉同 batch 內重複的 msg_id 後） */
  attempted: number
  /** 實際新插入（去重後真正落庫）的列數 */
  inserted: number
  /** 對既有列補上媒體欄（key_material/orig_filename/file_size）的列數（UPDATE changes 加總）。不與 inserted 混計。 */
  mediaBackfilled: number
  /** 對既有列補標已收回（unsent 由 0 改 1）的列數（UPDATE changes 加總）。不與 inserted 混計。 */
  unsentMarked: number
  /** 本 batch 觸及的 chatId 集合（已 upsert 進 chats） */
  chatIds: string[]
}

/**
 * 批次寫入 sidecar 訊息。單一 transaction：
 *   1) 先 upsert 每個出現的 chat（滿足 FK + 維護 chats 顯示名/last_seen）。
 *   2) INSERT OR IGNORE 每則訊息（msg_id 去重）。
 * 回傳嘗試/實際插入列數，供 evidence 與 pipeline_runs 統計。
 *
 * ingestedAt 預設 now（ISO8601）；也作為同 batch 內 chats 的 seenAt，保持一致。
 */
export function insertMessages(
  batch: RawLineMessage[],
  db: Database = getDb()
): InsertMessagesResult {
  if (batch.length === 0)
    return { attempted: 0, inserted: 0, mediaBackfilled: 0, unsentMarked: 0, chatIds: [] }

  const now = new Date().toISOString()

  const insertMsg = db.prepare(
    `INSERT OR IGNORE INTO messages
       (msg_id, chat_id, ts, time_iso, direction, sender, text, content_type, processed, ingested_at,
        key_material, orig_filename, file_size, unsent)
     VALUES
       (@msgId, @chatId, @ts, @timeIso, @direction, @sender, @text, @contentType, 0, @ingestedAt,
        @keyMaterial, @origFilename, @fileSize, @unsent)`
  )

  // 既有列補媒體欄（backfill）：INSERT OR IGNORE 會整列略過既有 msg_id，
  // 導致舊媒體列的 key_material/orig_filename/file_size 永遠停在 NULL。
  // 對帶 keyMaterial 的媒體訊息額外跑此守衛式 UPDATE，只補「key_material 仍為 NULL」的列：
  //   - 新插入列：key_material 已由 INSERT 設值 → 不命中 → no-op。
  //   - 既有 NULL 列：命中 → 補上媒體欄。
  const backfillMedia = db.prepare(
    `UPDATE messages
        SET key_material = @keyMaterial, orig_filename = @origFilename, file_size = @fileSize
      WHERE msg_id = @msgId AND key_material IS NULL`
  )

  // 既有列補標「已收回」：收回發生在送出後 → 該 msg_id 多半已存在 →
  // INSERT OR IGNORE 整列略過 → unsent 停在 0。對帶 unsent 的進來列跑此守衛式 UPDATE，
  // 只補「unsent 仍為 0」的列（比照 backfillMedia）：
  //   - 新插入列：unsent 已由 INSERT 設值（1）→ 不命中 → no-op。
  //   - 既有 unsent=0 列：命中 → 標成已收回。只動 unsent，不碰 text（保留收回前原文）。
  const markUnsent = db.prepare(
    `UPDATE messages SET unsent = 1 WHERE msg_id = @msgId AND unsent = 0`
  )

  // 同 batch 內可能含同一 chat 多則 → 先去重 chat upsert，且記錄最新顯示名。
  const chatLatest = new Map<string, { name: string; isGroup: boolean }>()
  for (const m of batch) {
    chatLatest.set(m.chatId, { name: m.chat, isGroup: m.isGroup })
  }

  const run = db.transaction((msgs: RawLineMessage[]) => {
    for (const [chatId, info] of chatLatest) {
      upsertChat(
        { chatId, name: info.name ?? null, isGroup: info.isGroup, seenAt: now },
        db
      )
    }

    let inserted = 0
    let mediaBackfilled = 0
    let unsentMarked = 0
    const seenInBatch = new Set<string>()
    let attempted = 0
    for (const m of msgs) {
      const msgId = deriveMsgId(m)
      // 同 batch 內若推導出相同 msg_id（理論罕見），只算一次 attempt。
      if (seenInBatch.has(msgId)) continue
      seenInBatch.add(msgId)
      attempted += 1
      const keyMaterial = m.keyMaterial ?? null
      const origFilename = m.fileName ?? null
      const fileSize = m.fileSize ?? null
      const info = insertMsg.run({
        msgId,
        chatId: m.chatId,
        ts: m.ts,
        timeIso: m.time,
        direction: m.direction,
        sender: m.sender ?? null,
        text: m.text ?? null,
        contentType: typeof m.contentType === 'number' ? m.contentType : 0,
        ingestedAt: now,
        keyMaterial,
        origFilename,
        fileSize,
        unsent: m.unsent ? 1 : 0
      })
      inserted += info.changes
      // 只對媒體訊息（帶 keyMaterial）跑補欄 UPDATE；非媒體訊息跳過，省去不必要開銷。
      if (keyMaterial !== null) {
        mediaBackfilled += backfillMedia.run({ msgId, keyMaterial, origFilename, fileSize }).changes
      }
      // 只對收回列跑補標 UPDATE；非收回訊息跳過。新插入列已帶 unsent=1 → 不命中 → no-op。
      if (m.unsent === true) {
        unsentMarked += markUnsent.run({ msgId }).changes
      }
    }
    return { attempted, inserted, mediaBackfilled, unsentMarked }
  })

  const { attempted, inserted, mediaBackfilled, unsentMarked } = run(batch)
  return { attempted, inserted, mediaBackfilled, unsentMarked, chatIds: [...chatLatest.keys()] }
}

/** 寫入單則（便利包裝；內部走 insertMessages）。 */
export function insertMessage(
  msg: RawLineMessage,
  db: Database = getDb()
): InsertMessagesResult {
  return insertMessages([msg], db)
}

export interface ListMessagesQuery {
  chatId?: string
  /** 只取 ts < beforeTs 的（分頁/往前捲）。 */
  beforeTs?: number
  /** 預設 100，硬上限 1000。 */
  limit?: number
}

/**
 * 列訊息（看板卡片展開來源用）。預設依 ts 由新到舊。
 * 給 chatId 則限該 chat；給 beforeTs 則只取更早的。
 */
export function listMessages(
  query: ListMessagesQuery = {},
  db: Database = getDb()
): MessageDTO[] {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000)
  const conds: string[] = []
  const params: Record<string, unknown> = { limit }
  if (query.chatId) {
    conds.push('chat_id = @chatId')
    params.chatId = query.chatId
  }
  if (typeof query.beforeTs === 'number') {
    conds.push('ts < @beforeTs')
    params.beforeTs = query.beforeTs
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const rows = db
    .prepare(`SELECT * FROM messages ${where} ORDER BY ts DESC LIMIT @limit`)
    .all(params) as MessageRow[]
  return rows.map(rowToDTO)
}

/**
 * 某 chat 最近 N 則，**依 ts 由舊到新**（適合當 LLM 上下文 / 對話顯示順序）。
 * 內部先取最新 N 筆再反轉，確保拿到的是「最近」而非「最舊」N 筆。
 */
export function getRecentByChat(
  chatId: string,
  limit = 30,
  db: Database = getDb()
): MessageDTO[] {
  const n = Math.min(Math.max(limit, 1), 1000)
  const rows = db
    .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY ts DESC LIMIT ?')
    .all(chatId, n) as MessageRow[]
  return rows.reverse().map(rowToDTO)
}

/**
 * 取某 chat 在「ts >= sinceMs」的全部訊息，依 ts 由舊到新。**無 1000 筆上限**。
 * backfill（回顧過去 N 天）用：getRecentByChat 會被夾成最多 1000 筆，7 天內訊息
 * 超過 1000 則的大群會被截斷只拿最近 1000 筆 → 漏抓。此查詢直接 WHERE 窗口，
 * 把整個窗口完整送進 LLM，確保大群不漏。
 */
export function getByChatSince(
  chatId: string,
  sinceMs: number,
  db: Database = getDb()
): MessageDTO[] {
  const rows = db
    .prepare(
      'SELECT * FROM messages WHERE chat_id = ? AND ts >= ? ORDER BY ts ASC'
    )
    .all(chatId, sinceMs) as MessageRow[]
  return rows.map(rowToDTO)
}

/** 計數（evidence / 測試用）。給 chatId 則限該 chat。 */
export function countMessages(chatId?: string, db: Database = getDb()): number {
  if (chatId) {
    const r = db
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?')
      .get(chatId) as { n: number }
    return r.n
  }
  const r = db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
  return r.n
}

/**
 * 取「未處理（processed=0）且該 chat 未被 blocked」的訊息，依 ts 由舊到新。
 * pipeline runOnce 用：這是本輪要送 LLM 抽取的候選（§8 步驟 4）。
 * 黑名單 chat 的訊息仍鏡像在 messages（可追溯），但這裡 JOIN chats 過濾掉 blocked=1。
 * limit 防單輪暴量（預設 2000）。
 */
export function getUnprocessedForPipeline(
  limit = 2000,
  db: Database = getDb()
): MessageDTO[] {
  const n = Math.min(Math.max(limit, 1), 10000)
  const rows = db
    .prepare(
      `SELECT m.* FROM messages m
       JOIN chats c ON c.chat_id = m.chat_id
       WHERE m.processed = 0 AND c.blocked = 0
       ORDER BY m.ts ASC
       LIMIT ?`
    )
    .all(n) as MessageRow[]
  return rows.map(rowToDTO)
}

/** 標記訊息已被 LLM 抽取（M2 pipeline 用；本輪先提供）。 */
export function markProcessed(msgIds: string[], db: Database = getDb()): number {
  if (msgIds.length === 0) return 0
  const stmt = db.prepare('UPDATE messages SET processed = 1 WHERE msg_id = ?')
  const run = db.transaction((ids: string[]) => {
    let n = 0
    for (const id of ids) n += stmt.run(id).changes
    return n
  })
  return run(msgIds)
}
