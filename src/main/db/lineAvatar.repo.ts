import type { Database } from 'better-sqlite3'
import { deriveMsgId } from './schema'
import type { LineAvatarSource } from '../line/engine/linedb'
import type { LineImportBatch } from '../line/importTypes'
import { readEntities } from './lineEntity.repo'
import type { EntityKind, EntityRecord } from './lineEntity.repo'

/**
 * lineAvatar.repo.ts — 頭像的本地 DB（發話者連結與 Square 成員頭像；設計附錄 D-AV1～D-AV10）。
 *
 * 頭像只有三條讀取規則（readLocalAvatars）：非 Square 的聊天室與聯絡人只看通訊錄表（lineEntity.repo.ts）；
 * Square 成員（line_sender_profile 的 source='square'）用匯入時寫入的 line_sender_profile；其餘沒有照片，畫面顯示字母。
 *
 * 四個附屬表（不動 core user_version，仿 `ensureLineImportSchema`）：
 *   line_avatar_meta      回填游標等鍵值
 *   line_chat_avatar      舊表，不再讀寫（保留建表，不 DROP）
 *   line_sender_profile   「聊天室 × 發話者」層：發話者 MID 的**原值只存在這裡的 sender_mid**，而且只存對方（direction=in）；自己的 accountMid 絕不存
 *   line_message_sender   msg_id → sender_id
 * 這兩個欄位名稱只准出現在本檔（靜態測試守住）；所有讀寫都集中在這裡，日後有 host secrets 時可以原地改成 keyed hash。
 */

export const LINE_AVATAR_SCHEMA_VERSION = 1
/** 回填演算法的版本：升版會讓已完成的回填重新開始。 */
export const AVATAR_BACKFILL_VERSION = 2
/** 資料沒變時，同一筆紀錄多久之後才再寫一次（只為了更新 refreshed_at）。 */
const REFRESH_WRITE_MS = 6 * 60 * 60 * 1000
const MAX_SENDER_MID = 128
const SENDER_ID_CACHE_MAX = 5000

export type AvatarMetaKey =
  | 'schema_version' | 'backfill_phase' | 'backfill_cursor' | 'backfill_version' | 'backfill_scanned'
  | 'backfill_linked' | 'backfill_started_at' | 'backfill_done_at' | 'backfill_round_at' | 'link_watermark'
  | 'entity_schema_version' | 'contact_sync_version' | 'contact_sync_sig' | 'contact_sync_done_at' | 'contact_sync_counts'

const TABLES = ['line_avatar_meta', 'line_chat_avatar', 'line_sender_profile', 'line_message_sender']
const readyCache = new WeakMap<object, true>()

export function isLineAvatarSchemaReady(db: Database): boolean {
  if (readyCache.has(db)) return true
  try {
    const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('line_avatar_meta','line_chat_avatar','line_sender_profile','line_message_sender')`).all() as Array<{ name: string }>
    if (new Set(rows.map((row) => row.name)).size !== TABLES.length) return false
    readyCache.set(db, true)
    return true
  } catch {
    return false
  }
}

export function ensureLineAvatarSchema(db: Database): void {
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS line_avatar_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS line_chat_avatar (
        chat_id TEXT PRIMARY KEY REFERENCES chats(chat_id) ON DELETE CASCADE,
        source TEXT CHECK(source IN ('profile','square') OR source IS NULL),
        locator TEXT, display_name TEXT, refreshed_at INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS line_sender_profile (
        sender_id INTEGER PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(chat_id) ON DELETE CASCADE,
        sender_mid TEXT NOT NULL CHECK(length(sender_mid) BETWEEN 1 AND ${MAX_SENDER_MID}),
        source TEXT CHECK(source IN ('profile','square') OR source IS NULL),
        locator TEXT, display_name TEXT, refreshed_at INTEGER NOT NULL,
        UNIQUE(chat_id, sender_mid)
      );
      CREATE TABLE IF NOT EXISTS line_message_sender (
        msg_id TEXT PRIMARY KEY REFERENCES messages(msg_id) ON DELETE CASCADE,
        sender_id INTEGER NOT NULL REFERENCES line_sender_profile(sender_id) ON DELETE CASCADE
      ) WITHOUT ROWID;
    `)
    db.prepare(`INSERT OR IGNORE INTO line_avatar_meta(key,value) VALUES ('schema_version',?)`).run(String(LINE_AVATAR_SCHEMA_VERSION))
  })
  tx()
  readyCache.set(db, true)
}

export function getAvatarMeta(db: Database, key: AvatarMetaKey): string | null {
  const row = db.prepare('SELECT value FROM line_avatar_meta WHERE key=?').get(key) as { value: string } | undefined
  return row ? row.value : null
}

export function setAvatarMeta(db: Database, key: AvatarMetaKey, value: string): void {
  db.prepare('INSERT INTO line_avatar_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
}

export function deleteAvatarMeta(db: Database, key: AvatarMetaKey): void {
  db.prepare('DELETE FROM line_avatar_meta WHERE key=?').run(key)
}

// ── 寫入 ──

export interface SenderLinker {
  /** upsert 發話者的 profile 並回傳 sender_id；MID 空白或過長、聊天室不在 chats 時回 null。 */
  upsert(chatId: string, senderMid: string, source: LineAvatarSource, nowMs: number): number | null
  /** 守衛式建立 msg → sender 的連結：訊息必須在 messages、direction='in'、chat_id 相符。回傳是否新增了連結。 */
  link(msgId: string, chatId: string, senderId: number): boolean
  /**
   * 先確認 app DB 裡這則訊息存在、direction='in'、chat_id 相符，才建（或沿用）發話者 profile 並連結。
   * 呼叫端另外負責「accountMid 未知就不呼叫」；這道檢查是第二道防線，擋住 app DB 已經標成 outgoing 的訊息。
   */
  linkIncoming(msgId: string, chatId: string, senderMid: string, source: LineAvatarSource, nowMs: number): boolean
}

/** 一組準備好的敘述句加上 sender_id 的記憶體快取；一次 transaction（或一個回填切片）用一個。 */
export function createSenderLinker(db: Database, options: { fillOnly?: boolean } = {}): SenderLinker {
  // fillOnly（回填用）：已經有值的欄位一律不動，只補空的。回填讀的是可能落後的 `any` snapshot，匯入寫的資料比較新，不能被它蓋回去。
  const onConflict = options.fillOnly
    ? `DO UPDATE SET
      source = CASE WHEN locator IS NULL AND excluded.locator IS NOT NULL THEN excluded.source ELSE source END,
      locator = COALESCE(locator, excluded.locator),
      display_name = COALESCE(display_name, excluded.display_name),
      refreshed_at = excluded.refreshed_at
    WHERE (locator IS NULL AND excluded.locator IS NOT NULL) OR (display_name IS NULL AND excluded.display_name IS NOT NULL)`
    : `DO UPDATE SET
      source = CASE WHEN excluded.locator IS NOT NULL THEN excluded.source ELSE source END,
      locator = COALESCE(excluded.locator, locator),
      display_name = COALESCE(excluded.display_name, display_name),
      refreshed_at = excluded.refreshed_at
    WHERE (excluded.locator IS NOT NULL AND excluded.locator IS NOT locator)
       OR (excluded.display_name IS NOT NULL AND excluded.display_name IS NOT display_name)
       OR refreshed_at < excluded.refreshed_at - ${REFRESH_WRITE_MS}`
  const upsertProfile = db.prepare(`INSERT INTO line_sender_profile(chat_id,sender_mid,source,locator,display_name,refreshed_at)
    SELECT @chatId,@mid,@source,@locator,@name,@now WHERE EXISTS (SELECT 1 FROM chats WHERE chat_id=@chatId)
    ON CONFLICT(chat_id,sender_mid) ${onConflict}`)
  const isIncoming = db.prepare(`SELECT 1 AS ok FROM messages WHERE msg_id=? AND chat_id=? AND direction='in'`)
  const findId = db.prepare('SELECT sender_id FROM line_sender_profile WHERE chat_id=? AND sender_mid=?')
  const linkMessage = db.prepare(`INSERT OR IGNORE INTO line_message_sender(msg_id,sender_id)
    SELECT msg_id,@sid FROM messages WHERE msg_id=@id AND direction='in' AND chat_id=@chatId`)
  const ids = new Map<string, number>()
  const upsert: SenderLinker['upsert'] = (chatId, senderMid, source, nowMs) => {
    if (!senderMid || senderMid.length > MAX_SENDER_MID) return null
    const key = `${chatId}\0${senderMid}`
    const cached = ids.get(key)
    if (cached !== undefined) return cached
    upsertProfile.run({ chatId, mid: senderMid, source: source.source, locator: source.locator, name: source.displayName, now: nowMs })
    const row = findId.get(chatId, senderMid) as { sender_id: number } | undefined
    if (!row) return null
    if (ids.size >= SENDER_ID_CACHE_MAX) ids.clear()
    ids.set(key, row.sender_id)
    return row.sender_id
  }
  const link: SenderLinker['link'] = (msgId, chatId, senderId) => linkMessage.run({ sid: senderId, id: msgId, chatId }).changes > 0
  return {
    upsert,
    link,
    linkIncoming(msgId, chatId, senderMid, source, nowMs) {
      if (!isIncoming.get(msgId, chatId)) return false
      const senderId = upsert(chatId, senderMid, source, nowMs)
      return senderId !== null && link(msgId, chatId, senderId)
    }
  }
}

/**
 * 匯入時寫入（commitLineImportBatch 的同一個 transaction 內、以 savepoint 呼叫）：
 * 發話者層與訊息連結（聊天室層的頭像不在這裡寫，全部來自通訊錄表）。只收 incoming（direction='in'、senderMid 不是 accountMid）；accountMid 一律不存。
 * accountMid 未知（來源的 _profile 讀不到）時分不出哪些是自己的訊息：發話者層與連結一律不寫，
 * 也不推進 link_watermark——這批要靠缺口偵測交給回填。
 */
export function writeImportAvatarMeta(db: Database, batch: LineImportBatch, nowMs: number, committedAt: string): void {
  const meta = batch.avatarMeta
  if (!meta) return
  const sources = new Map<string, LineAvatarSource>()
  for (const entry of meta.senders) sources.set(`${entry.chatId}\0${entry.senderMid}`, entry.source)
  if (batch.items.some((item) => !item.accountMid)) return
  const linker = createSenderLinker(db)
  for (const item of batch.items) {
    const mid = item.senderMid
    if (!mid || mid === item.accountMid || item.message.direction !== 'in') continue
    const msgId = deriveMsgId(item.message)
    if (!msgId.startsWith('i:')) continue
    const source = sources.get(`${item.message.chatId}\0${mid}`)
    if (!source) continue
    linker.linkIncoming(msgId, item.message.chatId, mid, source, nowMs)
  }
  setAvatarMeta(db, 'link_watermark', committedAt)
}

// ── 讀取 ──

export interface LocalAvatarResult {
  chats: Record<string, LineAvatarSource>
  messages: Record<string, LineAvatarSource>
}

const hasText = (value: string | null): boolean => typeof value === 'string' && value.trim().length > 0

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(',')

export interface ReadLocalOptions {
  /** 開啟通訊錄層；關閉或讀不到時，聊天室與非 Square 的發話者都沒有頭像（顯示字母）。 */
  entity?: boolean
}

/** 聊天室層的查詢順序：群組 → Square 聊天室 → 聯絡人（同 linedb.chatAvatarSource）。 */
const CHAT_ENTITY_ORDER: readonly EntityKind[] = ['group', 'square_chat', 'contact']

const entitySource = (identity: string, record: EntityRecord): LineAvatarSource => ({
  identity, locator: record.locator, displayName: record.displayName, source: hasText(record.locator) ? (record.source ?? 'profile') : null
})
const hasEntityContent = (record: EntityRecord): boolean => hasText(record.locator) || hasText(record.displayName)

export function readLocalAvatars(db: Database, input: { chatIds: readonly string[]; chatId: string | null; msgIds: readonly string[] }, options: ReadLocalOptions = {}): LocalAvatarResult {
  const result: LocalAvatarResult = { chats: {}, messages: {} }
  // 規則一（非 Square）：通訊錄表有 locator 就用，沒有就取第一個有名字的列；兩者都空的列視為沒有。讀不到（表不見了）就整層略過。
  if (options.entity && input.chatIds.length > 0) {
    try {
      const byKind = CHAT_ENTITY_ORDER.map((kind) => readEntities(db, kind, input.chatIds))
      for (const id of input.chatIds) {
        const records = byKind.map((found) => found.get(id)).filter((record): record is EntityRecord => record !== undefined)
        const pick = records.find((record) => hasText(record.locator)) ?? records.find((record) => hasText(record.displayName))
        if (pick) result.chats[id] = entitySource(id, pick)
      }
    } catch { /* 通訊錄層讀不到：沒有頭像 */ }
  }
  if (input.chatId && input.msgIds.length > 0) {
    const rows = db.prepare(`SELECT ms.msg_id AS msg_id,sp.sender_mid AS sender_mid,sp.source AS source,sp.locator AS locator,sp.display_name AS display_name
      FROM line_message_sender ms JOIN line_sender_profile sp ON sp.sender_id=ms.sender_id
      WHERE ms.msg_id IN (${placeholders(input.msgIds.length)}) AND sp.chat_id=?`)
      .all(...input.msgIds, input.chatId) as Array<{ msg_id: string; sender_mid: string; source: 'profile' | 'square' | null; locator: string | null; display_name: string | null }>
    let contacts = new Map<string, EntityRecord>()
    if (options.entity) {
      const mids = [...new Set(rows.filter((row) => row.source !== 'square').map((row) => row.sender_mid))]
      if (mids.length > 0) {
        try { contacts = readEntities(db, 'contact', mids) } catch { /* 通訊錄層讀不到：沒有頭像 */ }
      }
    }
    for (const row of rows) {
      // 規則二（Square 成員）：用匯入時寫入的 line_sender_profile。
      if (row.source === 'square') {
        result.messages[row.msg_id] = { identity: row.sender_mid, locator: row.locator, displayName: row.display_name, source: row.source }
        continue
      }
      // 規則一（非 Square）：發話者是聯絡人，只看通訊錄表。規則三：查不到就不回，畫面顯示字母。
      const record = contacts.get(row.sender_mid)
      if (record && hasEntityContent(record)) result.messages[row.msg_id] = entitySource(row.sender_mid, record)
    }
  }
  return result
}

// ── 回填用 ──

export function knownChatIds(db: Database): Set<string> {
  return new Set((db.prepare('SELECT chat_id FROM chats').all() as Array<{ chat_id: string }>).map((row) => row.chat_id))
}

/**
 * 回填完成：link_watermark 推進到「這一輪開始的時間」（不往回退）。這一輪開始之前提交的批次都被這一輪掃過；
 * 一輪進行中才提交、而且沒有寫到連結的批次（例如 accountMid 未知）仍然算缺口，由缺口偵測交給下一輪。
 */
export function advanceLinkWatermark(db: Database, roundStartedAt: string): void {
  const at = Date.parse(roundStartedAt)
  if (!Number.isFinite(at)) return
  const current = Date.parse(getAvatarMeta(db, 'link_watermark') ?? '')
  if (!Number.isFinite(current) || at > current) setAvatarMeta(db, 'link_watermark', roundStartedAt)
}

/** §6.6 缺口偵測：最後一批匯入（committed_at）比 link_watermark 晚超過 gapMs＝有批次沒寫到連結。 */
export function hasLinkGap(db: Database, gapMs: number): boolean {
  let latest: string | null = null
  try {
    latest = (db.prepare('SELECT MAX(committed_at) AS m FROM line_import_batches').get() as { m: string | null } | undefined)?.m ?? null
  } catch {
    return false
  }
  if (!latest) return false
  const committed = Date.parse(latest)
  if (!Number.isFinite(committed)) return false
  const mark = Date.parse(getAvatarMeta(db, 'link_watermark') ?? '')
  return !Number.isFinite(mark) || committed - mark > gapMs
}
