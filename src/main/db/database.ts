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

  const { from, to } = migrate(conn)
  console.log(`[db] opened ${path} (schema ${from} -> ${to})`)

  db = conn
  return db
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
  }
}
