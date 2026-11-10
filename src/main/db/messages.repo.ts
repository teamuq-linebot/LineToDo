import type { Database } from 'better-sqlite3'
import { getDb } from './database'
import { deriveMsgId, type MessageRow } from './schema'
import type { MessageDTO } from './dto'
import type { RawLineMessage } from '../line/types'
import { upsertChat } from './chats.repo'
import { readChatSourceState, sharedSourceRows, type AppendBatch } from './sourceCache'
import { chatTodoPrefsReady } from './chatTodoPrefs.repo'
import { TODO_EXTRACT_WINDOW_DAYS } from '../config/defaults'

/**
 * messages.repo — LINE 引擎（in-process TS watchEngine，經 watcher.ts emit）進來的訊息落庫 + 查詢。
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
  /**
   * 本次真正新插入（`INSERT OR IGNORE` 命中、`changes>0`）的 msg_id 清單。
   * 長度恆等於 `inserted`；被去重略過的既有列不列入。
   * 對帳/回填用：只對「本次新插入」的列 `markProcessed`，不誤標既有 pending 列。
   */
  insertedMsgIds: string[]
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
    return {
      attempted: 0,
      inserted: 0,
      insertedMsgIds: [],
      mediaBackfilled: 0,
      unsentMarked: 0,
      chatIds: []
    }

  const now = new Date().toISOString()
  const calledWithinOuterTransaction = db.inTransaction

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

    const appendBefore = new Map<string, { sourceEpoch: number; appendSeq: number }>()
    for (const chatId of chatLatest.keys()) {
      const state = readChatSourceState(db, chatId)
      if (state) appendBefore.set(chatId, { sourceEpoch: state.sourceEpoch, appendSeq: state.appendSeq })
    }

    let inserted = 0
    const insertedMsgIds: string[] = []
    let mediaBackfilled = 0
    let unsentMarked = 0
    const insertedRowsByChat = new Map<string, MessageDTO[]>()
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
      // changes>0 代表此列非既有 msg_id（未被 INSERT OR IGNORE 略過）→ 記為本次新插入。
      if (info.changes > 0) {
        insertedMsgIds.push(msgId)
        const rows = insertedRowsByChat.get(m.chatId) ?? []
        rows.push({
          msgId,
          chatId: m.chatId,
          ts: m.ts,
          timeIso: m.time,
          direction: m.direction,
          sender: m.sender ?? null,
          text: m.text ?? null,
          contentType: typeof m.contentType === 'number' ? m.contentType : 0,
          processed: false,
          ingestedAt: now,
          origFilename: m.fileName ?? null,
          fileSize: m.fileSize ?? null,
          unsent: m.unsent === true
        })
        insertedRowsByChat.set(m.chatId, rows)
      }
      // 只對媒體訊息（帶 keyMaterial）跑補欄 UPDATE；非媒體訊息跳過，省去不必要開銷。
      if (keyMaterial !== null) {
        mediaBackfilled += backfillMedia.run({ msgId, keyMaterial, origFilename, fileSize }).changes
      }
      // 只對收回列跑補標 UPDATE；非收回訊息跳過。新插入列已帶 unsent=1 → 不命中 → no-op。
      if (m.unsent === true) {
        unsentMarked += markUnsent.run({ msgId }).changes
      }
    }
    const appendBatches: Array<{ chatId: string; batch: AppendBatch }> = []
    for (const chatId of chatLatest.keys()) {
      const before = appendBefore.get(chatId)
      const after = readChatSourceState(db, chatId)
      if (before && after) {
        appendBatches.push({
          chatId,
          batch: {
            sourceEpochBefore: before.sourceEpoch,
            sourceEpochAfter: after.sourceEpoch,
            appendSeqBefore: before.appendSeq,
            appendSeqAfter: after.appendSeq,
            rows: insertedRowsByChat.get(chatId) ?? []
          }
        })
      }
    }
    return { attempted, inserted, insertedMsgIds, mediaBackfilled, unsentMarked, appendBatches }
  })

  const { attempted, inserted, insertedMsgIds, mediaBackfilled, unsentMarked, appendBatches } = run(batch)
  // A caller may wrap an import batch in a larger transaction. A nested
  // savepoint can return before that owner commits, so do not publish phantom
  // rows/events to process memory; the next selector will hydrate from SQLite.
  if (!calledWithinOuterTransaction) {
    for (const { chatId, batch: appendBatch } of appendBatches) {
      if (appendBatch.rows.length > 0) sharedSourceRows(db).recordInsertedRows(chatId, appendBatch)
    }
  }
  return {
    attempted,
    inserted,
    insertedMsgIds,
    mediaBackfilled,
    unsentMarked,
    chatIds: [...chatLatest.keys()]
  }
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

/** 依明確 msg IDs 回查有限來源證據；DTO 仍排除 key_material。 */
export function getMessagesByIds(ids: string[], db: Database = getDb()): MessageDTO[] {
  const unique = Array.from(new Set(ids))
  if (!unique.length) return []
  const rows: MessageRow[] = []
  for (let i=0;i<unique.length;i+=900) {
    const part=unique.slice(i,i+900), query=db.prepare(`SELECT * FROM messages WHERE msg_id IN (${part.map(()=>'?').join(',')}) ORDER BY ts ASC, msg_id ASC`)
    rows.push(...query.all(...part) as MessageRow[])
  }
  return rows.sort((a,b)=>a.ts-b.ts||a.msg_id.localeCompare(b.msg_id)).map(rowToDTO)
}

/**
 * Hydrate selector-chosen IDs through the shared exact (chatId,msgId) source
 * seam. Membership remains owned by each caller's selector.
 */
export function getMessagesByChatAndIds(
  chatId: string,
  ids: string[],
  db: Database = getDb()
): MessageDTO[] {
  return sharedSourceRows(db).loadExactRows(chatId, ids)
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
  const selected = db
    .prepare('SELECT msg_id FROM messages WHERE chat_id = ? ORDER BY ts DESC,msg_id DESC LIMIT ?')
    .all(chatId, n) as Array<{ msg_id: string }>
  const rows = getMessagesByChatAndIds(chatId, selected.reverse().map((row) => row.msg_id), db)
  sharedSourceRows(db).rememberTodoContext(chatId, rows)
  return rows
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
 * 近 N 天內有過新訊息的聊天室數（設定頁延遲試算的說明文字用）。
 *
 * 這是「會落進 pipeline 候選集合的聊天室」的上界；聊天室總數不是——絕大多數聊天室
 * 長期沒有新訊息，永遠不會被抽取。只回一個整數，不回任何聊天室名稱或訊息內容。
 */
export function countChatsWithRecentMessages(
  days = TODO_EXTRACT_WINDOW_DAYS,
  db: Database = getDb()
): number {
  const d = Math.min(Math.max(Math.floor(days), 1), 365)
  const sinceMs = Date.now() - d * 24 * 60 * 60 * 1000
  const r = db
    .prepare(
      `SELECT COUNT(DISTINCT m.chat_id) AS n FROM messages m
       JOIN chats c ON c.chat_id = m.chat_id
       WHERE m.ts >= ?`
    )
    .get(sinceMs) as { n: number }
  return r.n
}

/**
 * 取「未處理（processed=0）、訊息時間在近 TODO_EXTRACT_WINDOW_DAYS 天內、且該 chat 待辦開關開啟」的訊息。
 * pipeline runOnce 用：這是本輪要送 LLM 抽取的候選（§8 步驟 4）。
 *
 * 排序與取樣：先依 chat 編號（每個 chat 內由舊到新），再依 ts。每個 chat 的最舊待抽取訊息
 * 先佔名額，之後才輪到每個 chat 的第二則……。因此即使某些 chat 在 offer 後一直 deferred
 * 或失敗（列維持 processed=0），只要同時待抽取的 chat 數不超過 limit，其他 chat 的新訊息每輪都能入選，
 * 不會被整個視窗卡死。超過 7 天的列不進來，所以舊列也不會擋住新列。
 *
 * 待辦開關關閉的 chat 訊息仍鏡像在 messages（可追溯），但這裡過濾掉。
 * 另保留 blocked=0：一次性遷移尚未完成（或失敗）時，舊的忽略聊天室不得被送 AI；遷移成功後 blocked 全為 0，無害。
 * limit 防單輪暴量（預設 2000）。nowMs 為視窗的基準時間（測試注入用，預設現在）。
 */
export function getUnprocessedForPipeline(
  limit = 2000,
  db: Database = getDb(),
  nowMs: number = Date.now()
): MessageDTO[] {
  const n = Math.min(Math.max(limit, 1), 10000)
  const base = Number.isFinite(nowMs) ? nowMs : Date.now()
  const sinceMs = base - TODO_EXTRACT_WINDOW_DAYS * 24 * 60 * 60 * 1000
  const todoGate = chatTodoPrefsReady(db)
  const selected = db
    .prepare(
      'SELECT chat_id, msg_id FROM (' +
      'SELECT m.chat_id, m.msg_id, m.ts, ' +
      'ROW_NUMBER() OVER (PARTITION BY m.chat_id ORDER BY m.ts ASC, m.msg_id ASC) AS rn ' +
      'FROM messages m ' +
      'JOIN chats c ON c.chat_id = m.chat_id ' +
      (todoGate ? 'LEFT JOIN chat_todo_preferences tp ON tp.chat_id = m.chat_id ' : '') +
      'WHERE m.processed = 0 AND c.blocked = 0 AND m.ts >= ? ' +
      (todoGate ? 'AND COALESCE(tp.extract_enabled,1) = 1 ' : '') +
      ') ORDER BY rn ASC, ts ASC, msg_id ASC LIMIT ?'
    )
    .all(sinceMs, n) as Array<{ chat_id: string; msg_id: string }>
  const idsByChat = new Map<string, string[]>()
  for (const row of selected) {
    const ids = idsByChat.get(row.chat_id) ?? []
    ids.push(row.msg_id)
    idsByChat.set(row.chat_id, ids)
  }
  const hydrated = new Map<string, MessageDTO>()
  for (const [chatId, ids] of idsByChat) {
    for (const row of getMessagesByChatAndIds(chatId, ids, db)) {
      hydrated.set(JSON.stringify([chatId, row.msgId]), row)
    }
  }
  // processed=0 came from the authoritative selector. It is progress metadata,
  // so the raw-row cache cannot suppress a pending ID or report it as processed.
  return selected.flatMap(({ chat_id, msg_id }) => {
    const row = hydrated.get(JSON.stringify([chat_id, msg_id]))
    return row ? [{ ...row, processed: false }] : []
  })
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
