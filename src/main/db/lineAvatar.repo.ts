import type { Database } from 'better-sqlite3'
import { deriveMsgId } from './schema'
import type { LineAvatarSource } from '../line/engine/linedb'
import type { LineImportBatch } from '../line/importTypes'
import { readEntities } from './lineEntity.repo'
import type { EntityKind, EntityRecord } from './lineEntity.repo'

/**
 * lineAvatar.repo.ts — 頭像的本地 DB（發話者頭像持久化，設計附錄 D-AV1～D-AV10）。
 *
 * 四個附屬表（不動 core user_version，仿 `ensureLineImportSchema`）：
 *   line_avatar_meta      回填游標等鍵值
 *   line_chat_avatar      聊天室層：source／locator／display_name
 *   line_sender_profile   「聊天室 × 發話者」層：發話者 MID 的**原值只存在這裡的 sender_mid**，而且只存對方（direction=in）；自己的 accountMid 絕不存
 *   line_message_sender   msg_id → sender_id
 * 這兩個欄位名稱只准出現在本檔（靜態測試守住）；所有讀寫都集中在這裡，日後有 host secrets 時可以原地改成 keyed hash。
 */

export const LINE_AVATAR_SCHEMA_VERSION = 1
/** 回填演算法的版本：升版會讓已完成的回填重新開始。2＝補上舊版留下的 name-only 列（發話者靠 fillOnly 補 locator、聊天室靠 chatsWithoutAvatar 重讀）。 */
export const AVATAR_BACKFILL_VERSION = 2
/** 兩個欄位都是空的紀錄（確定沒有頭像）在這段時間內算命中。 */
export const AVATAR_EMPTY_FRESH_MS = 24 * 60 * 60 * 1000
/**
 * 只有名字、沒有照片的紀錄（locator 為空、display_name 有值）在這段時間內算命中；超過就當 miss，重新讀 LINE 來源。
 * 重新讀了還是沒有照片時，refreshed_at 會被更新（見 upsert 的 WHERE），所以「真的沒照片」的人每小時最多重查一次，不是每次 prepareMessages。
 */
export const AVATAR_NAME_ONLY_RETRY_MS = 60 * 60 * 1000
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

/** 聊天室層 upsert：沒有變、而且 6 小時內寫過就不再寫；null 不會蓋掉既有的非 null；聊天室不在 chats 就略過。 */
export function upsertChatAvatar(db: Database, chatId: string, source: LineAvatarSource, nowMs: number): boolean {
  return db.prepare(`INSERT INTO line_chat_avatar(chat_id,source,locator,display_name,refreshed_at)
    SELECT @chatId,@source,@locator,@name,@now WHERE EXISTS (SELECT 1 FROM chats WHERE chat_id=@chatId)
    ON CONFLICT(chat_id) DO UPDATE SET
      source = CASE WHEN excluded.locator IS NOT NULL THEN excluded.source ELSE source END,
      locator = COALESCE(excluded.locator, locator),
      display_name = COALESCE(excluded.display_name, display_name),
      refreshed_at = excluded.refreshed_at
    WHERE (excluded.locator IS NOT NULL AND excluded.locator IS NOT locator)
       OR (excluded.display_name IS NOT NULL AND excluded.display_name IS NOT display_name)
       OR (locator IS NULL AND refreshed_at < excluded.refreshed_at - ${AVATAR_NAME_ONLY_RETRY_MS})
       OR refreshed_at < excluded.refreshed_at - ${REFRESH_WRITE_MS}`)
    .run({ chatId, source: source.source, locator: source.locator, name: source.displayName, now: nowMs }).changes > 0
}

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
  // fillOnly（回填用）：已經有值的欄位一律不動，只補空的。回填讀的是可能落後的 `any` snapshot，匯入與 write-through 寫的資料比較新，不能被它蓋回去。
  const onConflict = options.fillOnly
    ? `DO UPDATE SET
      source = CASE WHEN locator IS NULL AND excluded.locator IS NOT NULL THEN excluded.source ELSE source END,
      locator = COALESCE(locator, excluded.locator),
      display_name = COALESCE(display_name, excluded.display_name),
      refreshed_at = excluded.refreshed_at
    WHERE (locator IS NULL AND excluded.locator IS NOT NULL) OR (display_name IS NULL AND excluded.display_name IS NOT NULL)
       OR (locator IS NULL AND refreshed_at < excluded.refreshed_at - ${AVATAR_NAME_ONLY_RETRY_MS})`
    : `DO UPDATE SET
      source = CASE WHEN excluded.locator IS NOT NULL THEN excluded.source ELSE source END,
      locator = COALESCE(excluded.locator, locator),
      display_name = COALESCE(excluded.display_name, display_name),
      refreshed_at = excluded.refreshed_at
    WHERE (excluded.locator IS NOT NULL AND excluded.locator IS NOT locator)
       OR (excluded.display_name IS NOT NULL AND excluded.display_name IS NOT display_name)
       OR (locator IS NULL AND refreshed_at < excluded.refreshed_at - ${AVATAR_NAME_ONLY_RETRY_MS})
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
 * 聊天室層、發話者層與訊息連結。只收 incoming（direction='in'、senderMid 不是 accountMid）；accountMid 一律不存。
 * accountMid 未知（來源的 _profile 讀不到）時分不出哪些是自己的訊息：只寫聊天室層，發話者層與連結一律不寫，
 * 也不推進 link_watermark——這批要靠缺口偵測交給回填。
 */
export function writeImportAvatarMeta(db: Database, batch: LineImportBatch, nowMs: number, committedAt: string): void {
  const meta = batch.avatarMeta
  if (!meta) return
  const itemChats = new Set(batch.items.map((item) => item.message.chatId))
  for (const entry of meta.chats) {
    if (itemChats.has(entry.chatId)) upsertChatAvatar(db, entry.chatId, entry.source, nowMs)
  }
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

// ── 讀取（layered reader 的第一層）與 write-through ──

export interface LocalAvatarResult {
  chats: Record<string, LineAvatarSource>
  messages: Record<string, LineAvatarSource>
  /** fallback（LINE DB）回報的自己的 MID；只給 write-through 排除用，不離開 main process。沒有或 null＝未知，訊息不寫入。 */
  accountMid?: string | null
  /** 只有名字、已超過重試時間的本地紀錄：這次當 miss 去問 fallback，fallback 也查不到時才退回用它（保住顯示名）。 */
  stale?: { chats: Record<string, LineAvatarSource>; messages: Record<string, LineAvatarSource> }
}

interface AvatarRow { source: 'profile' | 'square' | null; locator: string | null; display_name: string | null; refreshed_at: number }

const hasText = (value: string | null): boolean => typeof value === 'string' && value.trim().length > 0

/**
 * 有 locator 就命中。沒有 locator 時：只有名字的紀錄在 AVATAR_NAME_ONLY_RETRY_MS 內算命中、超過算 miss（LINE 端可能後來才有照片）；
 * 兩者都空的紀錄 24 小時內確認過（確定沒有頭像）算命中；其餘算 miss。
 */
function isHit(row: AvatarRow, nowMs: number): boolean {
  if (hasText(row.locator)) return true
  return nowMs - row.refreshed_at <= (hasText(row.display_name) ? AVATAR_NAME_ONLY_RETRY_MS : AVATAR_EMPTY_FRESH_MS)
}

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(',')

export interface ReadLocalOptions {
  /** 開啟通訊錄層：命中即權威（不套 isHit 的時間規則、不問 fallback）。關閉或讀不到時行為與舊版完全相同。 */
  entity?: boolean
}

/** 聊天室層的查詢順序：群組 → Square 聊天室 → 聯絡人（同 linedb.chatAvatarSource）。 */
const CHAT_ENTITY_ORDER: readonly EntityKind[] = ['group', 'square_chat', 'contact']

const entitySource = (identity: string, record: EntityRecord): LineAvatarSource => ({
  identity, locator: record.locator, displayName: record.displayName, source: hasText(record.locator) ? (record.source ?? 'profile') : null
})
const hasEntityContent = (record: EntityRecord): boolean => hasText(record.locator) || hasText(record.displayName)

export function readLocalAvatars(db: Database, input: { chatIds: readonly string[]; chatId: string | null; msgIds: readonly string[] }, nowMs: number, options: ReadLocalOptions = {}): LocalAvatarResult {
  const result: LocalAvatarResult = { chats: {}, messages: {} }
  const stale: NonNullable<LocalAvatarResult['stale']> = { chats: {}, messages: {} }
  // 通訊錄層：取第一個有 locator 的列，沒有就取第一個有名字的列；兩者都空的列視為沒有（退到舊表）。讀不到（表不見了）就整層略過。
  const answeredByEntity = new Set<string>()
  if (options.entity && input.chatIds.length > 0) {
    try {
      const byKind = CHAT_ENTITY_ORDER.map((kind) => readEntities(db, kind, input.chatIds))
      for (const id of input.chatIds) {
        const records = byKind.map((found) => found.get(id)).filter((record): record is EntityRecord => record !== undefined)
        const pick = records.find((record) => hasText(record.locator)) ?? records.find((record) => hasText(record.displayName))
        if (pick) { result.chats[id] = entitySource(id, pick); answeredByEntity.add(id) }
      }
    } catch { /* 通訊錄層讀不到：照舊走舊表 */ }
  }
  const legacyChatIds = input.chatIds.filter((id) => !answeredByEntity.has(id))
  if (legacyChatIds.length > 0) {
    const rows = db.prepare(`SELECT chat_id,source,locator,display_name,refreshed_at FROM line_chat_avatar WHERE chat_id IN (${placeholders(legacyChatIds.length)})`)
      .all(...legacyChatIds) as Array<AvatarRow & { chat_id: string }>
    for (const row of rows) {
      const source: LineAvatarSource = { identity: row.chat_id, locator: row.locator, displayName: row.display_name, source: row.source }
      if (isHit(row, nowMs)) result.chats[row.chat_id] = source
      else if (hasText(row.display_name)) stale.chats[row.chat_id] = source
    }
  }
  if (input.chatId && input.msgIds.length > 0) {
    const rows = db.prepare(`SELECT ms.msg_id AS msg_id,sp.sender_mid AS sender_mid,sp.source AS source,sp.locator AS locator,sp.display_name AS display_name,sp.refreshed_at AS refreshed_at
      FROM line_message_sender ms JOIN line_sender_profile sp ON sp.sender_id=ms.sender_id
      WHERE ms.msg_id IN (${placeholders(input.msgIds.length)}) AND sp.chat_id=?`)
      .all(...input.msgIds, input.chatId) as Array<AvatarRow & { msg_id: string; sender_mid: string }>
    // 發話者層：Square 來源的列（成員）不被聯絡人覆蓋；其餘的批次查聯絡人，命中就用 entity 的結果。
    let contacts = new Map<string, EntityRecord>()
    if (options.entity) {
      const mids = [...new Set(rows.filter((row) => row.source !== 'square').map((row) => row.sender_mid))]
      if (mids.length > 0) {
        try { contacts = readEntities(db, 'contact', mids) } catch { /* 通訊錄層讀不到：照舊 */ }
      }
    }
    for (const row of rows) {
      const record = row.source !== 'square' ? contacts.get(row.sender_mid) : undefined
      if (record && hasEntityContent(record)) { result.messages[row.msg_id] = entitySource(row.sender_mid, record); continue }
      const source: LineAvatarSource = { identity: row.sender_mid, locator: row.locator, displayName: row.display_name, source: row.source }
      if (isHit(row, nowMs)) result.messages[row.msg_id] = source
      else if (hasText(row.display_name)) stale.messages[row.msg_id] = source
    }
  }
  if (Object.keys(stale.chats).length > 0 || Object.keys(stale.messages).length > 0) result.stale = stale
  return result
}

/** layered reader 的 write-through：fallback（`any` snapshot）查到的結果寫回本地。回傳寫入（或確認）的筆數。 */
export function persistFallbackAvatars(db: Database, fetched: LocalAvatarResult, chatId: string | null, nowMs: number): number {
  let written = 0
  const tx = db.transaction(() => {
    for (const [id, source] of Object.entries(fetched.chats)) {
      if (upsertChatAvatar(db, id, source, nowMs)) written += 1
    }
    const accountMid = fetched.accountMid
    if (!chatId || !accountMid) return
    const linker = createSenderLinker(db)
    for (const [msgId, source] of Object.entries(fetched.messages)) {
      if (!msgId.startsWith('i:') || source.identity === accountMid) continue
      if (linker.linkIncoming(msgId, chatId, source.identity, source, nowMs)) written += 1
    }
  })
  tx()
  return written
}

// ── 回填用 ──

export function knownChatIds(db: Database): Set<string> {
  return new Set((db.prepare('SELECT chat_id FROM chats').all() as Array<{ chat_id: string }>).map((row) => row.chat_id))
}

/** 還沒有頭像紀錄的聊天室，加上紀錄裡沒有 locator 且已超過重試時間的（舊版留下的 name-only 列）；重讀後 refreshed_at 會更新，所以不會重複回來。 */
export function chatsWithoutAvatar(db: Database, limit: number, nowMs: number = Date.now()): string[] {
  return (db.prepare(`SELECT c.chat_id AS chat_id FROM chats c WHERE NOT EXISTS (SELECT 1 FROM line_chat_avatar a WHERE a.chat_id=c.chat_id AND (a.locator IS NOT NULL OR a.refreshed_at >= ? - ${AVATAR_NAME_ONLY_RETRY_MS})) LIMIT ?`).all(nowMs, limit) as Array<{ chat_id: string }>).map((row) => row.chat_id)
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
