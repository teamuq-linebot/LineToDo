/**
 * sqlitePort.ts — LINE 訊息 DB（SQLCipher 相容加密）引擎的中立 port。
 *
 * 只描述 linedb / linekey / 其呼叫端（watchEngine、reconcile、driver/lineOrder）實際用到的
 * 連線能力：`prepare(sql).get/all`、`pragma`、`close`。形狀刻意取 better-sqlite3 的子集，
 * 所以 better-sqlite3(-multiple-ciphers) 的 Database 直接結構相容、standalone 零包裝；
 * 外掛（Phase 1）的 WASM SQLite3MultipleCiphers 引擎以薄 wrapper 實作同一形狀。
 *
 * `open` 是同步的：WASM 引擎的非同步初始化（`sqlite3InitModule` + 安裝自訂唯讀
 * node:fs VFS + `sqlite3mc_vfs_create`）在建立引擎實例的 async factory 內完成一次，
 * 之後 `oo1.DB({ filename, flags, vfs })` 本身是同步開檔，可直接滿足這個介面，
 * 不必把 openDb 及其整條呼叫鏈改成 async。
 *
 * 引擎只負責「開檔」：cipher/kdf_iter/key 的 PRAGMA 順序、驗解 SQL、checkpoint 與錯誤包裝
 * 仍由 linedb.ts 擁有（共用邏輯，兩引擎一致）。WASM 引擎的 `pragma()` 須回傳與
 * better-sqlite3 相同語意（`pragma('x=y')` 執行 `PRAGMA x=y`；失敗 throw）。
 */

/** 預備好的唯讀查詢。參數為 positional（linedb 只用 `?` 佔位）。 */
export interface LineDbStatement {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

/** 一條已開啟的 LINE DB 連線（引擎中立）。 */
export interface LineDbHandle {
  prepare(sql: string): LineDbStatement
  /** 執行 `PRAGMA <source>`；錯 key 後的查詢或 PRAGMA 失敗時 throw。 */
  pragma(source: string): unknown
  close(): unknown
}

export interface LineDbOpenOptions {
  /** 唯讀開啟（linekey BatchVerifier 試解候選 key 用）。預設 read-write（讓 WAL merge 進 snapshot）。 */
  readonly?: boolean
  /** 檔案不存在時 throw 而不是建立新檔。 */
  fileMustExist?: boolean
}

/**
 * LINE DB 引擎。`path` 一律是引擎工作區內的**私有 snapshot**（由 `LineFsPort.copyFile`
 * 複製進來），絕不是 LINE 的 live edb。
 */
export interface SqliteEnginePort {
  /** 引擎識別（log / 診斷用，不含路徑或金鑰）。 */
  readonly name: string
  open(path: string, options?: LineDbOpenOptions): LineDbHandle
}
