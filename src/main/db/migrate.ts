import type { Database } from 'better-sqlite3'
import { SCHEMA_DDL, SCHEMA_VERSION } from './schema'

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
    db.pragma(`user_version = ${v}`)
    return v
  })

  const to = runUpgrades(from)
  return { from, to }
}
