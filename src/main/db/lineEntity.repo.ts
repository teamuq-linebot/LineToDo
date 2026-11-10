import type { Database } from 'better-sqlite3'

/**
 * lineEntity.repo.ts — LINE 通訊錄的本地表 `line_entity`（聯絡人、群組、Square 聊天室，每個實體一筆）。
 *
 * 這張表不併入 `ensureLineAvatarSchema`：`isLineAvatarSchemaReady` 是頭像功能的總開關，新表建不起來不能把整個頭像功能關掉。
 * 實體的 MID 欄位名稱只准出現在本檔（靜態測試守住）；`lineAvatar.repo.ts` 只透過 `readEntities` 取用，不直接寫這個欄位名。
 * 只存萃取後的欄位（locator、顯示名），不存 `_targetProfileDetail` 原文；自己的 MID 由呼叫端排除，永不寫入。
 *
 * 語意：
 *   - 鏡像 LINE：upsert 只有內容真的變動才寫入；locator 與名字用 COALESCE，來源的 NULL 不覆蓋既有值。
 *   - 某個 kind 完整掃描後，LINE 端已不存在的列直接刪除（deleteEntities）；缺表或掃描失敗的 kind 不動。
 */

export const LINE_ENTITY_SCHEMA_VERSION = 1
export type EntityKind = 'contact' | 'group' | 'square_chat'
export const ENTITY_KINDS: readonly EntityKind[] = ['contact', 'group', 'square_chat']
const MAX_ENTITY_MID = 128
const READ_CHUNK = 400
const WRITE_CHUNK = 1000

export interface EntityInput {
  kind: EntityKind
  mid: string
  source: 'profile' | 'square' | null
  locator: string | null
  displayName: string | null
}

export interface EntityRecord {
  kind: EntityKind
  mid: string
  source: 'profile' | 'square' | null
  locator: string | null
  displayName: string | null
  syncedAt: number
}

/** 不快取：執行中表被刪掉時，狀態要能立刻反映。 */
export function isLineEntitySchemaReady(db: Database): boolean {
  try {
    return db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='line_entity'`).get() !== undefined
  } catch {
    return false
  }
}

export function ensureLineEntitySchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS line_entity (
      kind TEXT NOT NULL CHECK(kind IN ('contact','group','square_chat')),
      entity_mid TEXT NOT NULL CHECK(length(entity_mid) BETWEEN 1 AND ${MAX_ENTITY_MID}),
      source TEXT CHECK(source IN ('profile','square') OR source IS NULL),
      locator TEXT,
      display_name TEXT,
      synced_at INTEGER NOT NULL,
      PRIMARY KEY (kind, entity_mid)
    ) WITHOUT ROWID;
  `)
}

export const isValidEntityMid = (mid: unknown): mid is string => typeof mid === 'string' && mid.length >= 1 && mid.length <= MAX_ENTITY_MID

const UPSERT_SQL = `INSERT INTO line_entity(kind,entity_mid,source,locator,display_name,synced_at)
  VALUES (@kind,@mid,@source,@locator,@name,@now)
  ON CONFLICT(kind,entity_mid) DO UPDATE SET
    source = CASE WHEN excluded.locator IS NOT NULL THEN excluded.source ELSE source END,
    locator = COALESCE(excluded.locator, locator),
    display_name = COALESCE(excluded.display_name, display_name),
    synced_at = excluded.synced_at
  WHERE (excluded.locator IS NOT NULL AND excluded.locator IS NOT locator)
     OR (excluded.display_name IS NOT NULL AND excluded.display_name IS NOT display_name)`

/** 回傳是否真的寫入了這一列（新增或內容變動）。MID 空白或過長回 false。 */
export function upsertEntity(db: Database, entity: EntityInput, nowMs: number): boolean {
  if (!isValidEntityMid(entity.mid)) return false
  return db.prepare(UPSERT_SQL)
    .run({ kind: entity.kind, mid: entity.mid, source: entity.source, locator: entity.locator, name: entity.displayName, now: nowMs }).changes > 0
}

/** 該 kind 目前所有的 MID（刪除判定用，差集在記憶體做）。 */
export function entityMids(db: Database, kind: EntityKind): string[] {
  return (db.prepare('SELECT entity_mid AS mid FROM line_entity WHERE kind=?').all(kind) as Array<{ mid: string }>).map((row) => row.mid)
}

/** 刪除指定的列（LINE 端已不存在）。回傳實際刪除的筆數；每 1000 列一個 transaction。 */
export function deleteEntities(db: Database, kind: EntityKind, mids: readonly string[]): number {
  let deleted = 0
  const remove = db.prepare('DELETE FROM line_entity WHERE kind=? AND entity_mid=?')
  for (let i = 0; i < mids.length; i += WRITE_CHUNK) {
    const slice = mids.slice(i, i + WRITE_CHUNK)
    db.transaction(() => { for (const mid of slice) deleted += remove.run(kind, mid).changes })()
  }
  return deleted
}

export function countEntities(db: Database, kind: EntityKind): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM line_entity WHERE kind=?').get(kind) as { n: number }).n
}

/** 批次讀取。查不到的 MID 不在結果裡。 */
export function readEntities(db: Database, kind: EntityKind, mids: readonly string[]): Map<string, EntityRecord> {
  const found = new Map<string, EntityRecord>()
  for (let i = 0; i < mids.length; i += READ_CHUNK) {
    const slice = mids.slice(i, i + READ_CHUNK)
    if (slice.length === 0) continue
    const marks = slice.map(() => '?').join(',')
    const rows = db.prepare(`SELECT entity_mid,source,locator,display_name,synced_at FROM line_entity WHERE kind=? AND entity_mid IN (${marks})`)
      .all(kind, ...slice) as Array<{ entity_mid: string; source: 'profile' | 'square' | null; locator: string | null; display_name: string | null; synced_at: number }>
    for (const row of rows) {
      found.set(row.entity_mid, { kind, mid: row.entity_mid, source: row.source, locator: row.locator, displayName: row.display_name, syncedAt: row.synced_at })
    }
  }
  return found
}
