import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import Database from 'better-sqlite3'
import type { Database as Db } from 'better-sqlite3'
import { migrate } from './migrate'

/**
 * database.ts — better-sqlite3 連線單例。
 *
 * - DB 檔位於 app.getPath('userData')/line-todo.db（與 LINE edb 完全分離；本 App 只新增）。
 * - 開連線即下 WAL + foreign_keys=ON + busy_timeout，再跑 migrate()。
 * - 對外只給 getDb()（lazy 初始化）與 closeDb()（app 結束時呼叫）。
 *
 * 測試/腳本可用環境變數 LINE_TODO_DB_PATH 指定其他路徑（含 :memory:）以免污染真實 userData。
 */

let db: Db | null = null

/** 最近一次開連線的健康結果（供啟動流程 / 未來對帳查詢；未開庫前為 unknown）。 */
let health: DbHealth = { ok: false, reason: 'db-not-opened' }

/** DB 健康查詢結果。ok=true 代表 quick_check 與 migrate 皆通過。 */
export interface DbHealth {
  ok: boolean
  /** 不健康時的可讀原因（ok=true 時省略）。 */
  reason?: string
}

/**
 * 可辨識的 DB 完整性錯誤：quick_check 非 ok，或 migrate 失敗時拋出。
 * 呼叫端（index.ts 啟動流程）可用 `err instanceof DbIntegrityError` 分級處理，
 * 例如標記 DB 不健康、阻止對帳在壞庫上大量寫入。
 */
export class DbIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DbIntegrityError'
  }
}

function resolveDbPath(): string {
  const override = process.env.LINE_TODO_DB_PATH?.trim()
  if (override) return override
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'line-todo.db')
}

/** 取得已初始化的 DB 單例（首次呼叫時開連線、設 PRAGMA、跑 migration）。 */
export function getDb(): Db {
  if (db) return db

  const path = resolveDbPath()
  const conn = new Database(path)

  // 連線層 PRAGMA（每次開連線都要下；非 schema 的一部分）。
  conn.pragma('journal_mode = WAL')
  conn.pragma('foreign_keys = ON')
  conn.pragma('busy_timeout = 5000') // 與 watcher 同進程，理論無競爭，仍給緩衝

  // 完整性防護（Batch 1）：回傳前先驗證 DB 健康，避免帶著壞庫繼續
  // （呼應先前「過期損壞 WAL 覆蓋 app DB → silent degradation」事件）。
  // quick_check 只在開連線時跑一次（getDb 之後走單例快取，不重跑），
  // 故不影響後續每次 getDb() 的效能。
  const t0 = Date.now()
  const result = conn.pragma('quick_check', { simple: true }) as string
  const quickCheckMs = Date.now() - t0
  console.log(`[db] quick_check=${result} (${quickCheckMs}ms) ${path}`)
  if (result !== 'ok') {
    try {
      conn.close()
    } catch {
      /* 壞庫關閉失敗無關緊要，錯誤已記錄 */
    }
    const reason = `quick_check failed: ${result}`
    health = { ok: false, reason }
    console.error(`[db] INTEGRITY FAILURE ${path}: ${result}`)
    throw new DbIntegrityError(`DB integrity check failed for ${path}: ${result}`)
  }

  // migrate 防護（Batch 1）：明確告警而非 silent 吞掉。migrate 內部已包 transaction
  // （失敗自動 rollback、不留半套 schema），此處補上呼叫端分級告警 + 可辨識錯誤。
  let from: number
  let to: number
  try {
    ;({ from, to } = migrate(conn))
  } catch (err) {
    try {
      conn.close()
    } catch {
      /* 已進入錯誤路徑，關閉失敗無關緊要 */
    }
    const reason = `migrate failed: ${err instanceof Error ? err.message : String(err)}`
    health = { ok: false, reason }
    console.error(`[db] migrate failed for ${path}:`, err)
    throw new DbIntegrityError(`DB migration failed for ${path}: ${reason}`)
  }
  console.log(`[db] opened ${path} (schema ${from} -> ${to})`)

  health = { ok: true }
  db = conn
  return db
}

/**
 * 查詢 DB 健康狀態，供啟動流程 / 未來對帳（Batch 4）判斷是否啟動。
 * 尚未開庫時會先觸發一次 getDb()（含 quick_check + migrate）；
 * 若開庫過程拋出 DbIntegrityError，回傳 {ok:false, reason}（不 rethrow），
 * 讓呼叫端能「DB 不健康就不啟動對帳」而不必自行包 try/catch。
 */
export function checkDbHealth(): DbHealth {
  if (db) return { ok: true }
  try {
    getDb()
    return health
  } catch (err) {
    if (err instanceof DbIntegrityError) return health
    // 非完整性錯誤（如檔案系統問題）也視為不健康，統一回報。
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** 關閉連線（app before-quit 呼叫）。冪等。 */
export function closeDb(): void {
  if (db) {
    try {
      db.close()
    } catch (err) {
      console.error('[db] close failed:', err)
    }
    db = null
    health = { ok: false, reason: 'db-not-opened' }
  }
}
