/**
 * enginePorts.ts — LINE 引擎 port 的組裝根注入點。
 *
 * linedb / linekey / watchEngine 是模組函式，呼叫端（watcher、reconcile、backfill、
 * driver/lineOrder、index.ts）遍佈多處；為了不把 port 參數穿過每一層，宿主在組裝根
 * 呼叫一次 `configureLineEnginePorts()`，引擎每次用到時才讀 `getLineEnginePorts()`。
 *
 * - standalone：`src/main/index.ts` 啟動時注入 Node 實作（與未設定時的預設相同）。
 * - plugin（Phase 2）：backend `activate()` 注入 koffi `LineFsPort` + WASM 引擎 + dataDir 衍生的 dbDir。
 * - 未呼叫 configure 的情境（純 Node 測試、probe 腳本、legacy 呼叫端）：惰性建立 Node 預設，
 *   行為與 Phase 0 之前完全相同。
 */
import { join } from 'node:path'

import type { LineFsPort } from './fsPort'
import type { SqliteEnginePort } from './sqlitePort'
import { createNodeLineFsPort } from './nodeLineFsPort'
import { createBetterSqliteCipherEngine } from './betterSqliteCipherEngine'

/** %LOCALAPPDATA%\LINE\Data\db —— 對齊 linekey.py:19（standalone 預設 dbDir）。 */
export const DEFAULT_LINE_DB_DIR = join(process.env.LOCALAPPDATA || '', 'LINE', 'Data', 'db')

export interface LineEnginePorts {
  /** LINE 目錄 / 引擎工作區 / 行程列舉。 */
  fs: LineFsPort
  /** LINE 訊息 DB 引擎。 */
  sqlite: SqliteEnginePort
  /** `findDb()` 搜尋 `qw*.edb` 的目錄。 */
  dbDir: string
}

let configured: Partial<LineEnginePorts> = {}
let defaults: Pick<LineEnginePorts, 'fs' | 'sqlite'> | null = null

function nodeDefaults(): Pick<LineEnginePorts, 'fs' | 'sqlite'> {
  if (!defaults) defaults = { fs: createNodeLineFsPort(), sqlite: createBetterSqliteCipherEngine() }
  return defaults
}

/** 組裝根注入；可分次呼叫，只覆寫提供的欄位。 */
export function configureLineEnginePorts(ports: Partial<LineEnginePorts>): void {
  configured = { ...configured, ...ports }
}

/** 目前生效的 ports（未注入的欄位落回 Node 預設）。 */
export function getLineEnginePorts(): LineEnginePorts {
  return {
    fs: configured.fs ?? nodeDefaults().fs,
    sqlite: configured.sqlite ?? nodeDefaults().sqlite,
    dbDir: configured.dbDir ?? DEFAULT_LINE_DB_DIR,
  }
}

/** 清除注入，回到 Node 預設（測試用）。 */
export function resetLineEnginePorts(): void {
  configured = {}
}
