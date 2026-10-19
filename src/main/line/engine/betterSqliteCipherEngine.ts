/**
 * betterSqliteCipherEngine.ts — `SqliteEnginePort` 的 standalone 實作。
 *
 * 用 `better-sqlite3-multiple-ciphers`（Electron 31 / ABI 125 binary）開 snapshot。
 * 建構呼叫與 Phase 0 之前 linedb.ts（`new Database(path)`）與 linekey.ts
 * （`new Database(path, { readonly: true, fileMustExist: true })`）逐字相同。
 */
import Database from 'better-sqlite3-multiple-ciphers'

import type { LineDbHandle, LineDbOpenOptions, SqliteEnginePort } from './sqlitePort'

export function createBetterSqliteCipherEngine(): SqliteEnginePort {
  return {
    name: 'better-sqlite3-multiple-ciphers',
    open(path: string, options?: LineDbOpenOptions): LineDbHandle {
      // 無選項時維持原本的單參數呼叫，避免改變 better-sqlite3 的預設值解析。
      return (options ? new Database(path, options) : new Database(path)) as unknown as LineDbHandle
    },
  }
}
