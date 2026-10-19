/**
 * index.ts — line-todo 外掛 backend 的入口（打包成單檔 ESM：`<installDir>/backend/index.mjs`）。
 *
 * TeamUQ host 以 `ELECTRON_RUN_AS_NODE`（packaged）加 `--permission --allow-fs-read=<bootstrap,installDir,dataDir>
 * --allow-fs-write=<dataDir> --allow-addons` 啟動、先跑 self-check，再 `import(entry)` 並呼叫 `activate(context)`。
 * `activate` 必須回傳 `{ call(method, params), openSession?(info, channel), dispose?() }`。
 *
 * 這個入口只做「找路徑 + 載入原生元件 + 交給組裝根」：
 *   - installDir 由 bundle 自己的位置推得（context 沒有 installDir）：`<installDir>/backend/index.mjs`。
 *   - koffi：`import koffi from 'koffi'`（bundle 的 external；Phase 5 以 addon shim 固定從 `backend/native/win32-x64/` 載入）。
 *   - WASM SQLite3MC：`<installDir>/vendor/sqlite3mc-wasm/{sqlite3.mjs,sqlite3.wasm}`（不進 bundle）。
 *   - app DB：better-sqlite3 13.0.2（build 把 `better-sqlite3` 指到它），`.node` 固定在 `<installDir>/backend/native/win32-x64/`。
 *   - LINE DB 目錄：一律用 koffi 問 Windows 的 LocalAppData 推得（backend 沒有 LOCALAPPDATA 環境變數）；LINE Cache 目錄（媒體 .eimg）由 DB 目錄推得（assemble.ts）。
 *
 * 不讀 `context.settings`（G-06）：manifest 沒有 `settingsSchema`、沒有 `settings:plugin`，TeamUQ 對這種外掛的 backend 設定一律是空的
 * （`backendRuntime.ts` 的 `effectiveBackendSettings`）。設定在外掛自己的設定 view 裡改，存在 dataDir 的 settings.json（core 的設定服務）。
 * 所以 `PluginBackendContext`（types.ts）也不宣告 `settings`，任何讀取都會在型別檢查失敗。
 *
 * `activateAt(context, location)` 是測試入口：契約測試以假 LINE 資料夾執行「打包後的 backend」時用它指定位置，TeamUQ 只會呼叫 `activate`。
 * 它和 `activate` 走同一條組裝路徑，只差 LINE 位置與輪詢參數不是由本機推得。
 *
 * 不 import electron、不 import child_process／worker_threads、不做網路 I/O、不呼叫 LLM。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import koffi from 'koffi'
import { createBetterSqlite3AppEngine } from '../../main/db/appDbEngine'
import { createWasmSqliteCipherEngine } from '../../main/line/engine/wasmSqliteCipherEngine'
import { createWin32LineFsPort } from '../../main/line/engine/native/win32fs'
import { resolveLineDbDir } from '../../main/line/engine/native/knownFolders'
import { createPluginBackend } from './assemble'
import type { PluginBackendContext, PluginBackendHandler } from './types'

// 由 build 以 esbuild `define` 注入 package.json 的版本。
declare const __LINE_TODO_PLUGIN_VERSION__: string | undefined
const PLUGIN_VERSION = typeof __LINE_TODO_PLUGIN_VERSION__ === 'string' ? __LINE_TODO_PLUGIN_VERSION__ : '0.0.0'

/** LINE 讀取的位置與輪詢參數。正式環境由 `activate` 推得；契約測試經 `activateAt` 指定。 */
export interface LineLocation {
  /** LINE 的 DB 目錄（`...\LINE\Data\db`）；空字串＝找不到（line.status 會明確報錯）。 */
  lineDbDir: string
  /** LINE 的 Cache 目錄；省略＝由 DB 目錄推得。 */
  lineCacheDir?: string
  /** watcher 輪詢間隔（秒）與每批上限；省略＝15 秒、500 則。 */
  watcher?: { intervalSec?: number; limit?: number }
}

export const DEFAULT_WATCHER = Object.freeze({ intervalSec: 15, limit: 500 })

export async function activate(context: PluginBackendContext): Promise<PluginBackendHandler> {
  return activateAt(context, { lineDbDir: resolveLineDbDir(koffi) ?? '' })
}

export async function activateAt(context: PluginBackendContext, location: LineLocation): Promise<PluginBackendHandler> {
  const installDir = dirname(dirname(fileURLToPath(import.meta.url)))

  const fs = createWin32LineFsPort({ workspaceRoot: join(context.dataDir, 'line-engine'), loadKoffi: () => koffi })
  const sqlite = await createWasmSqliteCipherEngine({ wasmDir: join(installDir, 'vendor', 'sqlite3mc-wasm'), int64: 'exact' })

  const nativeBinding = join(installDir, 'backend', 'native', 'win32-x64', 'better_sqlite3.node')
  const appDbEngine = createBetterSqlite3AppEngine(existsSync(nativeBinding) ? { nativeBinding } : {})

  return createPluginBackend({
    pluginId: context.pluginId,
    version: PLUGIN_VERSION,
    dataDir: context.dataDir,
    linePorts: { fs, sqlite, dbDir: location.lineDbDir },
    media: { cacheDir: location.lineCacheDir },
    watcher: {
      intervalSec: location.watcher?.intervalSec ?? DEFAULT_WATCHER.intervalSec,
      limit: location.watcher?.limit ?? DEFAULT_WATCHER.limit,
      drainBacklog: true
    },
    appDbEngine
  })
}
