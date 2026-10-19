/**
 * wasmSqliteCipherEngine.ts — `SqliteEnginePort` 的外掛實作（SQLite3MultipleCiphers 2.5.1 WASM）。
 *
 * 組成：
 *   sqlite3.mjs / sqlite3.wasm（vendor/sqlite3mc-wasm，installDir 內）
 *     └─ 自訂**唯讀** node:fs VFS（`wasm/nodeFsReadOnlyVfs.ts`）
 *          └─ `sqlite3mc_vfs_create` 包 cipher 層 → `multipleciphers-nodefs-ro`
 *
 * 用途：開 dataDir 內的**私有 snapshot**（由 `LineFsPort.copyFile`／koffi 從 LINE 目錄複製進來）。
 * 不用 MEMFS、不整檔載入；唯讀、無 fsync、無跨程序鎖（理由見 VFS 檔頭）。
 *
 * 與 standalone 引擎（better-sqlite3-multiple-ciphers）的契約一致：
 *   - `open(path)` 同步回傳 `LineDbHandle`；非同步的 WASM 初始化在 `createWasmSqliteCipherEngine()` 做一次。
 *   - cipher／kdf_iter／key 的 PRAGMA、驗解 SQL、錯誤包裝仍由 linedb.ts 擁有（兩引擎共用）。
 *   - 一律唯讀開啟；LINE snapshot 的 `-wal` 由 SQLite 在唯讀連線內合併讀出，不需要 checkpoint
 *     （linedb 的 `wal_checkpoint(TRUNCATE)` 在唯讀連線上是 no-op／被吞掉的非致命錯誤）。
 *
 * int64：見 `wasm/int64.ts`。預設 `'exact'`（BigInt 保精度），可選 `'legacy-number'`（與 standalone 逐位元相同）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { LineDbHandle, LineDbOpenOptions, LineDbStatement, SqliteEnginePort } from './sqlitePort'
import { applyInt64Mode, type Int64Mode } from './wasm/int64'
import {
  installReadOnlyNodeFsVfs,
  type InstalledReadOnlyVfs,
  type VfsFs,
} from './wasm/nodeFsReadOnlyVfs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sqlite3Api = any

export interface WasmSqliteCipherEngineOptions {
  /** 放 `sqlite3.mjs` 與 `sqlite3.wasm` 的目錄（plugin：`<installDir>/vendor/sqlite3mc-wasm` 或 bundle 旁）。 */
  wasmDir: string
  /** int64 處理模式，預設 `'exact'`。 */
  int64?: Int64Mode
  /** 注入 VFS 用的 fs（測試用 spy／fake）。預設 node:fs。 */
  vfsFs?: VfsFs
  /** VFS 名稱；省略時自動取 `nodefs-ro`、`nodefs-ro-2`…（同一個 WASM 實例內不可重複註冊同名 VFS）。 */
  vfsName?: string
}

export interface WasmSqliteCipherEngine extends SqliteEnginePort {
  readonly sqlite3: Sqlite3Api
  readonly vfs: InstalledReadOnlyVfs
  readonly int64: Int64Mode
  /** 版本資訊（診斷用，不含路徑或金鑰）。 */
  readonly info: { sqlite: string; sqlite3mc: string; vfs: string }
  /** 初始化期間 sqlite3.mjs 印出的警告（OPFS 不可用等，已被攔下不外洩到 stdout/stderr）。 */
  readonly initWarnings: readonly string[]
  /** 初始化後 sqlite3 輸出的最近訊息（有上限，診斷用）。 */
  readonly runtimeLog: readonly string[]
  /** 目前存活（未 close）的連線數（洩漏檢查）。 */
  openConnections(): number
  /** WASM heap 大小（MB，診斷用）。 */
  wasmHeapMB(): number
}

interface LoadedModule {
  sqlite3: Sqlite3Api
  /** 初始化期間（OPFS 不可用等）印出的警告。 */
  initWarnings: string[]
  /** 初始化之後 sqlite3 自己印到 printErr 的訊息（例如失敗的 step）；只保留最近 {@link RUNTIME_LOG_MAX} 行，避免長時間輪詢無限成長。 */
  runtimeLog: string[]
}

const RUNTIME_LOG_MAX = 50

/**
 * sqlite3.mjs 的 `sqlite3InitModule` 在同一次模組評估內只能初始化一次（它靠 `globalThis.sqlite3InitModuleState`
 * 傳遞 instantiateWasm，第一次呼叫就會刪掉）。所以同一個 wasmDir 在行程內共用一個 WASM 實例；
 * 之後的引擎只是在同一個實例上多註冊一個唯讀 VFS（名稱自動遞增）。外掛 backend 正常只會建立一次引擎，
 * 這個快取主要讓測試能在同一行程建立多個設定不同的引擎（不同 int64 模式、注入 spy fs）。
 */
const loadedModules = new Map<string, Promise<LoadedModule>>()

function loadModule(wasmDir: string): Promise<LoadedModule> {
  let loaded = loadedModules.get(wasmDir)
  if (!loaded) {
    loaded = initModule(wasmDir)
    loadedModules.set(wasmDir, loaded)
    loaded.catch(() => loadedModules.delete(wasmDir))
  }
  return loaded
}

async function initModule(wasmDir: string): Promise<LoadedModule> {
  // tsconfig 的 lib 只有 ES2022（無 DOM），WebAssembly 全域在此以最小形狀取用。
  const wasmApi = (globalThis as unknown as { WebAssembly: { instantiate(b: Uint8Array, i: object): Promise<{ instance: unknown; module: unknown }> } }).WebAssembly
  const wasmBytes = readFileSync(join(wasmDir, 'sqlite3.wasm'))
  // 動態 import：sqlite3.mjs 以檔案形式隨外掛一起放在 installDir（kind:'code'），不進 backend bundle。
  const mod = (await import(pathToFileURL(join(wasmDir, 'sqlite3.mjs')).href)) as {
    default: (config: Record<string, unknown>) => Promise<Sqlite3Api>
  }
  const initWarnings: string[] = []
  const runtimeLog: string[] = []
  let initializing = true
  const origWarn = console.warn
  const origErr = console.error
  const record = (line: string): void => {
    if (initializing) {
      initWarnings.push(line)
      return
    }
    runtimeLog.push(line)
    if (runtimeLog.length > RUNTIME_LOG_MAX) runtimeLog.shift()
  }
  // sqlite3.mjs 在初始化時把 console.warn/error 綁進 sqlite3.config，之後的 log 也走這條路，
  // 所以攔截函式必須在初始化結束後仍然有效，並且有上限。
  const capture = (...a: unknown[]): void => record(a.map(String).join(' ').split('\n')[0])
  console.warn = capture
  console.error = capture
  try {
    const sqlite3 = await mod.default({
      print: () => {},
      printErr: (s: unknown) => record(String(s)),
      // 從 installDir 讀好的 bytes 直接實例化（不經 fetch／URL 解析，bundle 後也不依賴 import.meta.url）。
      instantiateWasm: (
        imports: object,
        onSuccess: (instance: unknown, module: unknown) => void,
      ) => {
        void wasmApi
          .instantiate(wasmBytes, imports)
          .then((r: { instance: unknown; module: unknown }) => onSuccess(r.instance, r.module))
        return {}
      },
    })
    return { sqlite3, initWarnings, runtimeLog }
  } finally {
    initializing = false
    console.warn = origWarn
    console.error = origErr
  }
}

/** 載入 WASM 模組並安裝唯讀 VFS，回傳引擎。啟動時呼叫一次（async）。 */
export async function createWasmSqliteCipherEngine(
  options: WasmSqliteCipherEngineOptions,
): Promise<WasmSqliteCipherEngine> {
  const int64: Int64Mode = options.int64 ?? 'exact'
  const { sqlite3, initWarnings, runtimeLog } = await loadModule(options.wasmDir)

  let vfsName = options.vfsName
  if (!vfsName) {
    vfsName = 'nodefs-ro'
    for (let n = 2; sqlite3.capi.sqlite3_vfs_find(vfsName); n++) vfsName = `nodefs-ro-${n}`
  }
  const vfs = installReadOnlyNodeFsVfs(sqlite3, { name: vfsName, fs: options.vfsFs })
  const probe = new sqlite3.oo1.DB(':memory:')
  const info = {
    sqlite: String(probe.selectValue('select sqlite_version()')),
    sqlite3mc: String(probe.selectValue('select sqlite3mc_version()')),
    vfs: vfs.vfsName,
  }
  probe.close()

  const live = new Set<WasmLineDbHandle>()

  class WasmLineDbHandle implements LineDbHandle {
    private db: Sqlite3Api | null
    private readonly pending = new Set<Sqlite3Api>()

    constructor(db: Sqlite3Api) {
      this.db = db
    }

    private open(): Sqlite3Api {
      if (!this.db) throw new Error('database connection is closed')
      return this.db
    }

    private row(row: Record<string, unknown> | undefined): unknown {
      if (!row) return undefined
      if (int64 === 'exact') return row
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(row)) out[k] = applyInt64Mode(row[k], int64)
      return out
    }

    prepare(sql: string): LineDbStatement {
      const db = this.open()
      // 和 better-sqlite3 一樣：prepare 時就檢查 SQL（錯 key 後的 SQL 會在第一次讀頁時失敗）。
      let stmt: Sqlite3Api | null = db.prepare(sql)
      this.pending.add(stmt)
      const take = (): Sqlite3Api => {
        if (stmt) return stmt
        stmt = this.open().prepare(sql)
        this.pending.add(stmt)
        return stmt
      }
      const release = (): void => {
        if (!stmt) return
        this.pending.delete(stmt)
        try {
          stmt.finalize()
        } finally {
          stmt = null
        }
      }
      const run = <T>(params: unknown[], fn: (s: Sqlite3Api) => T): T => {
        const s = take()
        try {
          if (params.length > 0) s.bind(params)
          return fn(s)
        } finally {
          // 單次使用語意：用完就 finalize，避免 chatName() 之類逐列呼叫累積 prepared statement。
          release()
        }
      }
      return {
        get: (...params: unknown[]): unknown =>
          run(params, (s) => (s.step() ? this.row(s.get({})) : undefined)),
        all: (...params: unknown[]): unknown[] =>
          run(params, (s) => {
            const rows: unknown[] = []
            while (s.step()) rows.push(this.row(s.get({})))
            return rows
          }),
      }
    }

    pragma(source: string): unknown {
      // 唯讀連線：checkpoint 既不被允許（會 SQLITE_READONLY 並寫一行 log）也不需要——唯讀連線本來就會把
      // -wal 的 frame 合併進讀取結果（見檔頭）。linedb.openDb 本就把它當非致命步驟，這裡直接 no-op。
      if (/^\s*wal_checkpoint\b/i.test(source)) return []
      return (this.open().selectObjects(`PRAGMA ${source}`) as Array<Record<string, unknown>>).map((r) =>
        this.row(r),
      )
    }

    close(): void {
      const db = this.db
      if (!db) return
      this.db = null
      live.delete(this)
      for (const s of this.pending) {
        try {
          s.finalize()
        } catch {
          // 已 finalize 或連線已壞：忽略
        }
      }
      this.pending.clear()
      db.close()
    }
  }

  return {
    name: 'sqlite3mc-wasm+nodefs-ro-vfs',
    sqlite3,
    vfs,
    int64,
    info,
    initWarnings,
    runtimeLog,
    openConnections: () => live.size,
    wasmHeapMB: () => Math.round(sqlite3.wasm.memory.buffer.byteLength / 1048576),
    open(path: string, _options?: LineDbOpenOptions): LineDbHandle {
      // 引擎永遠唯讀（VFS 也只提供 O_RDONLY）；`readonly`／`fileMustExist` 選項因此都已滿足：
      // 檔案不存在 → CANTOPEN（throw），不會建立新檔。
      const db = new sqlite3.oo1.DB({ filename: path, flags: 'r', vfs: vfs.vfsName })
      const handle = new WasmLineDbHandle(db)
      live.add(handle)
      return handle
    },
  }
}
