/**
 * betterSqliteCipherEngine.ts — 外掛 backend bundle 專用的 `main/line/engine/betterSqliteCipherEngine.ts` 替身
 * （只在 esbuild 的 resolve plugin 生效）。真正的版本 import `better-sqlite3-multiple-ciphers`，那個原生套件在 Electron 44
 * （ABI 149）沒有 binary、也不能進外掛 bundle；LINE DB 一律由 WASM SQLite3MC 引擎讀。`enginePorts.ts` 只在「沒注入引擎」時
 * 才惰性呼叫它——外掛組裝根一定先注入，所以到這裡就是 bug。
 */
import type { SqliteEnginePort } from '../../../main/line/engine/sqlitePort'

export function createBetterSqliteCipherEngine(): SqliteEnginePort {
  throw new Error('the standalone cipher engine is not available in the plugin backend (inject the WASM engine)')
}
