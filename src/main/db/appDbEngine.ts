/**
 * appDbEngine.ts — line-todo 自有 DB（line-todo.db）的開庫 port。
 *
 * Manager 技術裁定（task「使用者決策紀錄」appdb spike 條）：外掛與 standalone 的 app DB
 * 都是 better-sqlite3、API 完全相同，只差 binary 版本（外掛 13.0.2 / N-API、standalone
 * 11.10.0 / Electron 31）。因此這裡**不包 adapter**：引擎直接回 better-sqlite3 的
 * `Database`，repos 的型別不動；可注入的只有「用哪個 better-sqlite3 建構子」與
 * 「載入哪個 native binding」。開哪個路徑由 `openDatabase({ dbPath })` 決定。
 */
import BetterSqlite3 from 'better-sqlite3'
import type { Database } from 'better-sqlite3'

/** better-sqlite3 模組的預設匯出（建構子）。外掛可注入 13.0.2 的模組。 */
export type BetterSqlite3Constructor = typeof BetterSqlite3

export interface AppDbEngine {
  /** 引擎識別（log / 診斷用）。 */
  readonly name: string
  /** 開啟（不存在則建立）app DB；目錄建立、PRAGMA、quick_check、migrate 由 openDatabase 負責。 */
  open(dbPath: string): Database
}

export interface BetterSqlite3AppEngineOptions {
  /** better-sqlite3 建構子；預設為本專案依賴的 better-sqlite3（standalone 11.10.0）。 */
  driver?: BetterSqlite3Constructor
  /**
   * better-sqlite3 的 `nativeBinding` 選項：`.node` 絕對路徑。外掛用來固定從安裝目錄載入
   * binary、不做 `bindings` 路徑探測。省略時由 better-sqlite3 自行解析（standalone 現行行為）。
   */
  nativeBinding?: string
}

export function createBetterSqlite3AppEngine(options: BetterSqlite3AppEngineOptions = {}): AppDbEngine {
  const Driver = options.driver ?? BetterSqlite3
  const nativeBinding = options.nativeBinding
  return {
    name: 'better-sqlite3',
    open(dbPath: string): Database {
      // 未指定 binding 時維持原本 `new Database(path)` 單參數呼叫。
      return nativeBinding ? new Driver(dbPath, { nativeBinding }) : new Driver(dbPath)
    },
  }
}
