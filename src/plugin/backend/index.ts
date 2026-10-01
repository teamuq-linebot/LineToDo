/**
 * index.ts — line-todo 外掛 backend 的入口（打包成單檔 ESM：`<installDir>/backend/index.mjs`）。
 *
 * TeamUQ 1.6.8 host 以 `ELECTRON_RUN_AS_NODE`（packaged）加 `--permission --allow-fs-read=<bootstrap,installDir,dataDir>
 * --allow-fs-write=<dataDir> --allow-addons` 啟動、先跑 self-check，再 `import(entry)` 並呼叫 `activate(context)`。
 * `activate` 必須回傳 `{ call(method, params), openSession?(info, channel), dispose?() }`。
 *
 * 這個入口只做「找路徑 + 載入原生元件 + 交給組裝根」：
 *   - installDir 由 bundle 自己的位置推得（context 沒有 installDir）：`<installDir>/backend/index.mjs`。
 *   - koffi：`import koffi from 'koffi'`（bundle 的 external；Phase 5 以 addon shim 固定從 `backend/native/win32-x64/` 載入）。
 *   - WASM SQLite3MC：`<installDir>/vendor/sqlite3mc-wasm/{sqlite3.mjs,sqlite3.wasm}`（kind:'code'，不進 bundle）。
 *   - app DB：better-sqlite3 13.0.2（build 把 `better-sqlite3` 指到它），`.node` 固定在 `<installDir>/backend/native/win32-x64/`。
 *   - LINE DB 目錄：`context.settings` 的 `lineDbDir` 覆寫，否則用 koffi 問 Windows 的 LocalAppData（backend 沒有 LOCALAPPDATA 環境變數）。
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

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}
function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

export async function activate(context: PluginBackendContext): Promise<PluginBackendHandler> {
  const installDir = dirname(dirname(fileURLToPath(import.meta.url)))
  const settings = context.settings

  const lineDbDir = text(settings.get('lineDbDir')) ?? resolveLineDbDir(koffi) ?? ''
  const fs = createWin32LineFsPort({ workspaceRoot: join(context.dataDir, 'line-engine'), loadKoffi: () => koffi })
  const sqlite = await createWasmSqliteCipherEngine({ wasmDir: join(installDir, 'vendor', 'sqlite3mc-wasm'), int64: 'exact' })

  const nativeBinding = join(installDir, 'backend', 'native', 'win32-x64', 'better_sqlite3.node')
  const appDbEngine = createBetterSqlite3AppEngine(existsSync(nativeBinding) ? { nativeBinding } : {})

  return createPluginBackend({
    pluginId: context.pluginId,
    version: PLUGIN_VERSION,
    dataDir: context.dataDir,
    linePorts: { fs, sqlite, dbDir: lineDbDir },
    watcher: { intervalSec: positive(settings.get('linePollSec')) ?? 15, limit: positive(settings.get('lineBatchLimit')) ?? 500, drainBacklog: true },
    appDbEngine
  })
}
