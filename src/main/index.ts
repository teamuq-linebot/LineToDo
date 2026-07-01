import { app, BrowserWindow, ipcMain } from 'electron'
import { createWindow } from './window'
import { LineWatcher } from './line/watcher'
import { getLineBridgeConfig } from './config/lineBridge'
import type { RawLineMessage, LineBridgeStatus } from './line/types'
import { getDb, closeDb } from './db/database'
import { insertMessage } from './db/messages.repo'
import { registerDbIpc } from './ipc'
import { PipelineScheduler } from './pipeline/scheduler'
import type { PipelineStatus } from './pipeline/scheduler'
import type { RunOnceResult } from './pipeline/runOnce'
import { registerPipelineIpc } from './ipc/pipeline.ipc'
import { registerSettingsIpc } from './ipc/settings.ipc'
import { setSafeStorageReader } from './config/qwen'
import { readApiKeyFromSafeStorage, getSettings } from './config/settings'
import { setSettingsOverlayProvider } from './config/defaults'
import {
  registerLinemediaScheme,
  registerLinemediaHandler,
  registerMediaIpc
} from './media/protocol'

/**
 * Electron main 進程入口。
 * 本里程碑（M1 即時訊息流）：spawn watch_json.py --follow --json，逐行解析 NDJSON，
 * 透過 IPC push 把每則 LINE 新訊息送到 renderer 顯示成「即時訊息流」。
 * 後續里程碑會在此加上 DB 落庫、qwen 抽取、看板。
 */

// Windows 第二實例聚焦既有視窗
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null
let watcher: LineWatcher | null = null
let scheduler: PipelineScheduler | null = null

// linemedia:// 特權 scheme 必須在 app ready 前、module 頂層宣告（media_feature_plan §4.5）。
registerLinemediaScheme()

// renderer 掛載前/重整時可能漏接 push 事件；保留最近 N 則供 messages:recent 回放。
const RECENT_CAP = 300
const recent: RawLineMessage[] = []

function pushToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function startWatcher(): void {
  const cfg = getLineBridgeConfig()
  watcher = new LineWatcher({
    python: cfg.python,
    script: cfg.script,
    intervalSec: cfg.intervalSec,
    limit: cfg.limit,
    dbWatchEnabled: cfg.dbWatchEnabled,
    dbDir: cfg.dbDir
  })

  watcher.on('message', (msg: RawLineMessage) => {
    // 安全邊界（media_feature_plan §1-E / §4.4）：keyMaterial/oid/sid 只留 main/DB，
    // 永不跨橋到 renderer。push 與 recent 回放（messages:recent）皆用剝除後的 sanitized copy；
    // DB 落庫仍用完整 msg（含 keyMaterial），供 linemedia:// 解密。
    const safe: RawLineMessage = { ...msg }
    delete safe.keyMaterial
    delete safe.oid
    delete safe.sid
    recent.push(safe)
    if (recent.length > RECENT_CAP) recent.splice(0, recent.length - RECENT_CAP)
    pushToRenderer('evt:line-message', safe)

    // 持久化：upsert chat + INSERT OR IGNORE message（msg_id 去重）。
    // DB 失敗不可拖垮即時訊息流 —— catch 後記 log 繼續。
    try {
      const res = insertMessage(msg)
      if (res.inserted > 0) {
        // 通知 renderer：DB 有新訊息落庫（看板/列表可據此重查）。
        pushToRenderer('evt:messages-persisted', {
          chatIds: res.chatIds,
          inserted: res.inserted
        })
      }
    } catch (err) {
      console.error('[db] insertMessage failed:', err)
    }
  })

  watcher.on('status', (status: LineBridgeStatus) => {
    pushToRenderer('evt:line-status', status)
  })

  watcher.on('log', (line: string) => {
    // main 進程 log（dev 時可見於終端），方便對照子程序行為
    console.log(line)
  })

  watcher.start()
}

/**
 * 啟動 qwen 抽取 pipeline 排程器。
 * watchSource 用預設 dbDrainSource —— live watcher 已把訊息鏡像進 DB，
 * pipeline 只需處理「未處理且未黑名單」的 DB 列，不另 spawn watch_json.py（避免雙消費者搶 checkpoint）。
 * 無 QWEN_API_KEY 時 scheduler 仍跑（落庫/降噪照常），但 LLM 階段優雅停用、不產 todo，
 * 並把 llmStatus 標 'disabled'，由 UI 提示使用者填金鑰。
 */
function startScheduler(): void {
  scheduler = new PipelineScheduler()

  scheduler.on('run', (result: RunOnceResult) => {
    pushToRenderer('evt:pipeline-run', result)
    if (
      result.createdIds.length ||
      result.resolvedIds.length ||
      result.updatedIds.length
    ) {
      pushToRenderer('evt:todos-changed', {
        createdIds: result.createdIds,
        resolvedIds: result.resolvedIds,
        updatedIds: result.updatedIds
      })
    }
  })

  scheduler.on('status', (status: PipelineStatus) => {
    pushToRenderer('evt:pipeline-status', status)
  })

  registerPipelineIpc(scheduler, {
    // backfill（回顧過去 N 天）進度推給 renderer，讓按鈕顯示「處理中 X/Y 聊天」。
    pushProgress: (p) => pushToRenderer('evt:backfill-progress', p)
  })

  // settings:* / todos:draftReply / app:openDataFolder。設定變更時讓 scheduler 重排輪詢頻率。
  registerSettingsIpc({
    onSettingsChanged: () => {
      scheduler?.reschedule()
    }
  })

  scheduler.start()
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(() => {
  // qwen 金鑰：注入 safeStorage 讀取器（§7.2 優先序 safeStorage > env）。
  // 必須在 scheduler / 任何讀 getQwenConfig 之前注入，否則設定頁存的金鑰不會被採用。
  setSafeStorageReader(readApiKeyFromSafeStorage)

  // pipeline 設定：注入持久化設定覆寫器（設定頁的 poll/並發/blocklist 要能蓋過內建常數）。
  setSettingsOverlayProvider(getSettings)

  // DB 持久化：開連線（建表/migration 在此發生）+ 註冊 DB 查詢 IPC。
  // 放在最前，確保任何 IPC / watcher 落庫前 DB 已就緒。
  try {
    getDb()
    registerDbIpc()
  } catch (err) {
    console.error('[db] init failed:', err)
  }

  // 媒體：linemedia:// protocol handler（圖片串流解密）+ media:open/saveAs IPC（檔案）。
  // 明文/檔案 bytes 只在 main 記憶體處理，永不進 renderer（media_feature_plan §4.5/§4.6）。
  registerLinemediaHandler()
  registerMediaIpc()

  // health-check（保留）
  ipcMain.handle('app:ping', () => {
    return { ok: true, ts: Date.now(), version: app.getVersion() }
  })

  // 即時訊息流相關 IPC
  ipcMain.handle('messages:recent', (): RawLineMessage[] => recent.slice())
  ipcMain.handle('line:status', (): LineBridgeStatus => {
    return (
      watcher?.getStatus() ?? {
        state: 'stopped',
        lastMessageAt: null,
        messageCount: 0,
        lastError: null,
        restarts: 0
      }
    )
  })
  ipcMain.handle('line:setRunning', (_e, running: boolean): LineBridgeStatus => {
    if (running) watcher?.start()
    else watcher?.stop()
    return watcher?.getStatus() ?? {
      state: 'stopped',
      lastMessageAt: null,
      messageCount: 0,
      lastError: null,
      restarts: 0
    }
  })

  mainWindow = createWindow()
  console.log('[smoke] window-created')

  // 測試輔助：LINE_TODO_DEBUG=1 時把 renderer 的 console 轉到 main stdout，
  // 讓自動化測試能在 main log 觀察到 renderer 確實收到訊息。正式執行不開。
  if (process.env.LINE_TODO_DEBUG === '1') {
    mainWindow.webContents.on('console-message', (_e, _level, message) => {
      console.log(`[renderer] ${message}`)
    })
  }

  // 視窗 web 內容載入完成後才啟動 watcher + pipeline 排程器，確保早期 push 事件不被丟失
  mainWindow.webContents.on('did-finish-load', () => {
    if (!watcher) startWatcher()
    if (!scheduler) startScheduler()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  watcher?.stop()
  scheduler?.stop()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  watcher?.stop()
  scheduler?.stop()
  closeDb()
})
