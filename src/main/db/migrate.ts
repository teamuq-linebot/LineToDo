import type { Database } from 'better-sqlite3'
import { SCHEMA_DDL, SCHEMA_VERSION } from './schema'

/**
 * migrate.ts — 用 PRAGMA user_version 管理 schema 版本。
 *
 * v0 → v1：建立全部資料表/索引（SCHEMA_DDL）。
 * 未來升級：在 switch 加 case，逐版疊加 ALTER/CREATE，最後把 user_version 設到目標版。
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
    // v0（全新 DB）→ v1
    if (v < 1) {
      db.exec(SCHEMA_DDL)
      v = 1
    }
    // 之後版本：
    // if (v < 2) { db.exec(...); v = 2 }
    db.pragma(`user_version = ${v}`)
    return v
  })

  const to = runUpgrades(from)
  return { from, to }
}
