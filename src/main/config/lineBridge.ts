/**
 * LINE 橋接的預設路徑與輪詢參數（IMPLEMENTATION_PLAN.md §3 / §7）。
 *
 * 本輪（即時訊息流）只需要這幾個值即可運作；完整的 settings.json + 設定頁覆寫
 * 屬後續里程碑（M3）。此處先以常數提供，並允許環境變數覆寫，方便開發/測試。
 */
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface LineBridgeConfig {
  python: string
  script: string
  intervalSec: number
  limit: number
  /**
   * 是否啟用 fs.watch 事件驅動即時觸發（預設 true）。
   * 監看 LINE DB 目錄（%LOCALAPPDATA%\LINE\Data\db），當 -wal 寫入時
   * 去抖 ~800ms 後立即觸發一次 poll，不必等滿 intervalSec。
   * 間隔輪詢保留為 fallback 上限（「最久 intervalSec 秒一定檢查一次」）。
   * LINE_DB_WATCH=0 可關閉（退回純間隔）。
   */
  dbWatchEnabled: boolean
  /**
   * LINE DB 目錄路徑（含 qwd*.edb 與 -wal 的目錄）。
   * 預設由 %LOCALAPPDATA%\LINE\Data\db 推導；LINE_DB_DIR 可覆寫。
   */
  dbDir: string
}

/** 推導 LINE DB 目錄路徑（%LOCALAPPDATA%\LINE\Data\db）。 */
function defaultDbDir(): string {
  const localAppData =
    process.env.LOCALAPPDATA ??
    (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\AppData\\Local` : join(homedir(), 'AppData', 'Local'))
  return `${localAppData}\\LINE\\Data\\db`
}

/**
 * py fallback（LINE_ENGINE=py 才用）的 line-cua-win 根目錄。
 * 由 LINE_CUA_WIN_DIR 覆寫；否則以專案根相對定位到 <projectRoot>/line-cua-win
 * （已從獨立 repo 搬進 line-todo 專案內的子目錄）。
 * app.getAppPath 只在 Electron 主程序可用；純 Node 環境惰性 require 失敗時，
 * fallback 到 __dirname（bundle 於 out/main）往上兩層的專案根。
 */
function defaultCuaWinDir(): string {
  const override = process.env.LINE_CUA_WIN_DIR?.trim()
  if (override) return override
  try {
    const electron = require('electron') as { app?: { getAppPath?: () => string } }
    const appRoot = electron?.app?.getAppPath?.()
    if (appRoot) return join(appRoot, 'line-cua-win')
  } catch {
    // 非 Electron 環境 —— 落到下方 __dirname fallback。
  }
  return join(__dirname, '..', '..', 'line-cua-win')
}

const CUA_WIN_DIR = defaultCuaWinDir()

const DEFAULTS: LineBridgeConfig = {
  python: join(CUA_WIN_DIR, '.venv', 'Scripts', 'python.exe'),
  script: join(CUA_WIN_DIR, 'src', 'watch_json.py'),
  intervalSec: 15,
  limit: 500,
  dbWatchEnabled: true,
  dbDir: defaultDbDir()
}

/**
 * 取得訊息引擎開關（預設 ts；py 為緊急 fallback — Batch 5 切換）。
 *   - 未設或空字串 `''` → `'ts'`（in-process TS watchEngine，自包含、不需外部 Python）。
 *   - `LINE_ENGINE=py`（或 `python`）→ `'py'`（spawn 舊路徑，緊急 fallback，保留可回退）。
 *   - 其餘任意值 → `'ts'`。
 * 三個消費點（watcher / watchSource / backfill）統一 import 此 helper，避免各自散讀 env。
 * py spawn 程式碼路徑刻意保留（未硬刪），LINE_ENGINE=py 仍可回退。
 */
export function getLineEngine(): 'ts' | 'py' {
  const v = process.env.LINE_ENGINE?.trim().toLowerCase()
  return v === 'py' || v === 'python' ? 'py' : 'ts'
}

/** 取得 LINE 橋接設定，環境變數可覆寫（LINE_PYTHON / LINE_WATCH_SCRIPT / LINE_POLL_SEC / LINE_DB_WATCH / LINE_DB_DIR）。 */
export function getLineBridgeConfig(): LineBridgeConfig {
  const intervalEnv = Number(process.env.LINE_POLL_SEC)
  const dbWatchEnv = process.env.LINE_DB_WATCH
  return {
    python: process.env.LINE_PYTHON?.trim() || DEFAULTS.python,
    script: process.env.LINE_WATCH_SCRIPT?.trim() || DEFAULTS.script,
    intervalSec: Number.isFinite(intervalEnv) && intervalEnv > 0 ? intervalEnv : DEFAULTS.intervalSec,
    limit: DEFAULTS.limit,
    dbWatchEnabled: dbWatchEnv === '0' ? false : DEFAULTS.dbWatchEnabled,
    dbDir: process.env.LINE_DB_DIR?.trim() || DEFAULTS.dbDir
  }
}
