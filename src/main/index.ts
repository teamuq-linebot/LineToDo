import { app, BrowserWindow, ipcMain } from 'electron'
import { createWindow } from './window'
import { LineWatcher } from './line/watcher'
import { getLineBridgeConfig } from './config/lineBridge'
import type { RawLineMessage, LineBridgeStatus } from './line/types'
import { getDb, closeDb, DbIntegrityError } from './db/database'
import { insertMessage } from './db/messages.repo'
import { deriveMsgId } from './db/schema'
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
import { backupNewMedia } from './media/backup'
import { scanRecentUnsent } from './pipeline/backfill'
import { runReconcile } from './pipeline/reconcileRunner'
import type { ReconcileProgress } from './pipeline/reconcileRunner'

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

// DB 完整性 gate（Batch 1/4）：getDb() 在壞庫/migrate 失敗時拋 DbIntegrityError。
// 啟動路徑捕捉後標 dbHealthy=false → 對帳不啟動（絕不在壞庫上大量寫入），
// 並優雅告知使用者、不讓 app 未捕捉例外硬崩。
let dbHealthy = false

// 收回時序缺口掃描節流：scanRecentUnsent 會 spawn watch_json（~200MB 解密），不可每輪跑。
let lastUnsentScan = 0

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

/**
 * 依 openAtLogin 設定套用「開機自動啟動」（Batch 5a）。
 * 啟動時套一次、設定變更時（onSettingsChanged）重套一次。
 *
 * dev / packaged 差異：
 *  - packaged（app.isPackaged=true）：實際呼叫 app.setLoginItemSettings，路徑用 process.execPath
 *    （已封裝的 .exe），Windows 於登入時自動啟動本 App。
 *  - dev（未封裝）：process.execPath 指向 electron.exe，若照套會把「electron.exe + 專案路徑」
 *    註冊進登入項，污染使用者登入啟動清單、且封裝後無意義。故 dev 下不實際註冊，只 log
 *    預期參數（openAtLogin），方便驗證接線正確。
 */
function applyLoginItemSettings(): void {
  const openAtLogin = getSettings().openAtLogin
  if (!app.isPackaged) {
    console.log(
      `[login-item] dev mode: skip setLoginItemSettings (would set openAtLogin=${openAtLogin})`
    )
    return
  }
  try {
    app.setLoginItemSettings({
      openAtLogin,
      path: process.execPath,
      args: []
    })
    console.log(`[login-item] applied openAtLogin=${openAtLogin}`)
  } catch (err) {
    console.error('[login-item] setLoginItemSettings failed:', err)
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
    // 補齊 renderer 顯圖/檔案卡所需欄位（此 safe 同源供 messages:recent 回放與 evt:line-message push）：
    //  - msgId 必用 deriveMsgId（含 'i:' 前綴），才對得上 DB PK 與 linemedia://media/<msgId>；
    //    不可用 LINE 原生未前綴的 raw msgId（會 404）。
    //  - fileName→origFilename：對齊 renderer RawLineMessage 命名（落庫路徑本就做此對映）。
    safe.msgId = deriveMsgId(msg)
    ;(safe as { origFilename?: string | null }).origFilename = msg.fileName ?? null
    delete safe.fileName
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

    // 這輪 ingest 落庫後，增量備份「可解密且未備份」的媒體（MB-3）。
    // 非阻塞：setImmediate 讓同步解密/寫檔不擋輪詢主流程；只 log 計數、不 log 敏感值。
    setImmediate(() => {
      try {
        const r = backupNewMedia()
        if (r.backedUp > 0) {
          console.log(
            `[media-backup] backedUp=${r.backedUp} skipped=${r.skipped} failed=${r.failed}`
          )
        }
      } catch (e) {
        console.warn('[media-backup] run failed:', (e as Error).name)
      }
    })

    // 收回時序缺口補抓（決策 4）：LINE 收回只抬 _rev、不動 _createdTime → 即時輪詢（吃
    // checkpoint）結構性漏抓「send-後-recall」。scanRecentUnsent 走 --since 窗口重讀（不吃
    // checkpoint），必然重新命中被收回列並守衛式標 unsent=1。因會 spawn watch_json（~200MB
    // 解密），不可每輪跑 → 5 分鐘節流；與 media backup（本機解密、每輪）分開、非阻塞。
    setImmediate(() => {
      if (Date.now() - lastUnsentScan > 5 * 60 * 1000) {
        lastUnsentScan = Date.now()
        void scanRecentUnsent(3)
          .then((r) => {
            if (r.unsentMarked > 0) {
              console.log(`[unsent-scan] marked=${r.unsentMarked} scanned=${r.scanned}`)
            }
          })
          .catch((e) => console.warn('[unsent-scan] failed:', (e as Error).name))
      }
    })
  })

  scheduler.on('status', (status: PipelineStatus) => {
    pushToRenderer('evt:pipeline-status', status)
  })

  registerPipelineIpc(scheduler, {
    // backfill（回顧過去 N 天）進度推給 renderer，讓按鈕顯示「處理中 X/Y 聊天」。
    pushProgress: (p) => pushToRenderer('evt:backfill-progress', p)
  })

  // settings:* / todos:draftReply / app:openDataFolder。設定變更時讓 scheduler 重排輪詢頻率，
  // 並重新套用「開機自動啟動」設定（openAtLogin 變更即時生效）。
  registerSettingsIpc({
    onSettingsChanged: () => {
      scheduler?.reschedule()
      applyLoginItemSettings()
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

  // 開機自動啟動（Batch 5a）：啟動時依 openAtLogin 設定套用一次（設定變更時於 onSettingsChanged 重套）。
  applyLoginItemSettings()

  // DB 持久化：開連線（建表/migration 在此發生）+ 註冊 DB 查詢 IPC。
  // 放在最前，確保任何 IPC / watcher 落庫前 DB 已就緒。
  try {
    getDb()
    registerDbIpc()
    dbHealthy = true
  } catch (err) {
    // DbIntegrityError（Batch 1）：quick_check 非 ok 或 migrate 失敗。標 DB 不健康、
    // 告知 renderer 提示使用者，**不 rethrow**（避免未捕捉例外硬崩）；對帳也不會啟動。
    dbHealthy = false
    if (err instanceof DbIntegrityError) {
      console.error('[db] integrity failure, DB unhealthy:', err.message)
    } else {
      console.error('[db] init failed:', err)
    }
    pushToRenderer('evt:db-unhealthy', {
      reason: err instanceof Error ? err.message : String(err)
    })
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

    // 開機自我對帳（Batch 4，決策 A）：視窗開啟、watcher/scheduler 啟動之後，用
    // setImmediate 背景觸發、**不 await**、不阻塞啟動/UI。健康 gate 不 ok 或設定關閉 →
    // 直接不跑。runReconcile 內部不 throw；仍 .catch 兜底避免未捕捉 rejection。
    setImmediate(() => {
      if (!dbHealthy) return
      // reconcile 設定（Batch 5a 已併入 AppSettings）：enabled=false → 完全跳過對帳。
      const rc = getSettings().reconcile
      if (!rc.enabled) return
      void runReconcile(
        { scopeMonths: rc.scopeMonths },
        {
          onProgress: (p: ReconcileProgress) => pushToRenderer('evt:reconcile-progress', p)
        }
      ).catch((err) => console.error('[reconcile] run failed:', err))
    })
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
