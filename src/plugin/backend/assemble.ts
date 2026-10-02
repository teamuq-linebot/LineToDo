/**
 * assemble.ts — 外掛 backend 的組裝根（設計 v2 §2.1：第二個組裝根，共用 core）。
 *
 * 與 standalone 的 `src/main/index.ts` 對照：同樣是「`createLineTodoRuntime` + `createLineTodoApplication` + 注入 ports」，
 * 差別全部在 ports：
 *
 *   | port            | standalone                          | 外掛 backend                                          |
 *   |-----------------|-------------------------------------|-------------------------------------------------------|
 *   | dataDir         | app.getPath('userData')             | context.dataDir                                       |
 *   | LINE fs / 引擎  | Node fs + better-sqlite3-mc         | koffi Win32LineFsPort + WASM SQLite3MC（Phase 1）      |
 *   | LINE 輪詢       | LineWatcher（fs.watch + interval）  | LineWatcher（只用 interval + drainBacklog，路徑在 dataDir）|
 *   | app DB          | better-sqlite3 11.10.0              | better-sqlite3 13.0.2（nativeBinding 固定在 installDir）|
 *   | AI              | provider（http／CLI）+ extractFn    | 無真 provider；ExtractQueue 供料/收料 + AiTaskQueue 中轉（UI 經 ai:chat）|
 *   | secrets         | Electron safeStorage                | 無（backend 不持有任何 AI 金鑰）                        |
 *   | media           | linemedia:// + shell／dialog        | media.prepare：解密寫進 dataDir/media-cache，UI 用 assets.url |
 *   | app/driver      | Electron shell／dialog／UIA         | unsupported_in_plugin                                 |
 *   | 開機對帳／收回掃描| runReconcile／scanRecentUnsent（hook）| 同一份程式，進度改進 EventHub；snapshot 在 dataDir      |
 *   | participantIdentity | safeStorage 加密的 install secret | unknownIdentity（設計 v2 §5.2 首版降級）              |
 *   | 事件            | webContents.send                    | EventHub（長輪詢 + capability session）                |
 *
 * 本檔不 import electron、不 import child_process／worker_threads、不做網路 I/O。
 */
import { basename, dirname, join } from 'node:path'
import { createLineTodoApplication } from '../../core/application'
import type { LineTodoApplicationPorts } from '../../core/application'
import { createLineTodoRuntime } from '../../core/runtime'
import { createPipelineConfig } from '../../main/config/defaults'
import { createQwenConfig } from '../../main/config/qwen'
import { createSettingsStore } from '../../main/config/settings'
import type { SettingsSecretStorage } from '../../main/config/settings'
import type { AppDbEngine } from '../../main/db/appDbEngine'
import { createBetterSqlite3AppEngine } from '../../main/db/appDbEngine'
import { getLastRun } from '../../main/db/pipeline.repo'
import { commitLineImportBatch, isLineImportSchemaReady } from '../../main/db/lineImport.repo'
import { configureLineEnginePorts } from '../../main/line/engine/enginePorts'
import type { LineEnginePorts } from '../../main/line/engine/enginePorts'
import { RecoverGuard } from '../../main/line/engine/linekey'
import type { GetKeyOptions, RecoverGuardOptions } from '../../main/line/engine/linekey'
import { getLineImportBatch, getMessagesSince } from '../../main/line/engine/watchEngine'
import type { LineImportBatch } from '../../main/line/importTypes'
import type { ParticipantIdentityProvider } from '../../main/line/identity'
import type { LineFsPort } from '../../main/line/engine/fsPort'
import { createMediaDecryptor } from '../../main/media/decrypt'
import { scanRecentUnsent } from '../../main/pipeline/backfill'
import { getSourceMonthlyFingerprint } from '../../main/pipeline/reconcile'
import { runReconcile } from '../../main/pipeline/reconcileRunner'
import type { ReconcileDeps } from '../../main/pipeline/reconcileRunner'
import { LineWatcher } from '../../main/line/watcher'
import { PipelineScheduler } from '../../main/pipeline/scheduler'
import type { LineTodoApi } from '../../shared/api'
import { AiTaskQueue, createUiAiProvider } from './aiTaskQueue'
import type { AiTaskQueueOptions } from './aiTaskQueue'
import { Dispatcher } from './dispatcher'
import type { DispatcherOptions } from './dispatcher'
import { EventHub } from './eventHub'
import type { EventHubOptions } from './eventHub'
import { ExtractQueue } from './extractQueue'
import type { ExtractQueueOptions } from './extractQueue'
import { createPluginMedia } from './media'
import type { MediaDb } from './media'
import { ReviewCoordinator, ReviewLedger } from './reviewRun'
import { LongTaskTracker } from './taskStatus'
import type { BackendDiagnostics, JsonValue, PluginBackendHandler, SessionChannel, SessionInfo } from './types'

/** backend 不持有任何 AI 金鑰；settings store 只需要這個「不可用」的 secrets。 */
const NO_SECRETS: SettingsSecretStorage = {
  isEncryptionAvailable: () => false,
  encryptString: () => { throw new Error('secrets are not available in the plugin backend') },
  decryptString: () => { throw new Error('secrets are not available in the plugin backend') }
}

/** 首版降級（設計 v2 §5.2）：沒有 safeStorage 的 install secret，participant 一律 unknown（與 application 內建的 fallback 相同）。 */
const UNKNOWN_IDENTITY: ParticipantIdentityProvider = {
  resolve: () => ({ participantKey: null, scope: 'unknown', keyVersion: null, status: 'unknown', reason: 'safe_storage_unavailable' }),
  epoch: () => null
}

/** 近期收回掃描的最短間隔（對齊 standalone 的 5 分鐘）。 */
const UNSENT_SCAN_MIN_INTERVAL_MS = 5 * 60 * 1000

/**
 * 真實 LINE 來源（有 linePorts）時，第一輪 poll（金鑰擷取＋首批匯入）與開機對帳延後多久才開始：
 * `activate()` 要先回傳，host 才收得到 boot-ack（manifest `bootTimeoutSec: 30`）；金鑰擷取與匯入再久都不能算在 boot 時間裡（review F2）。
 */
const DEFAULT_STARTUP_DELAY_MS = 250
/** dispose 最多等進行中的 poll／金鑰掃描收尾多久（刪暫存快照、關 handle）；超過就放手（下次啟動會清掃殘留，見 win32fs）。 */
const DISPOSE_IDLE_WAIT_MS = 2000

export interface PluginBackendOptions {
  pluginId: string
  version: string
  dataDir: string
  /** LINE 引擎 ports（koffi fs + WASM 引擎 + dbDir）。省略＝不改動目前的引擎注入（測試／fake line 用）。 */
  linePorts?: LineEnginePorts
  /** 直接指定 LINE port（fake LINE source）。省略＝用 `LineWatcher` 讀 `linePorts` 指向的 LINE 資料。 */
  line?: LineTodoApplicationPorts['line']
  /** `LineWatcher` 參數（只在沒給 `line` 時使用）。 */
  watcher?: { intervalSec?: number; limit?: number; drainBacklog?: boolean; startupDelayMs?: number }
  /**
   * 金鑰擷取（review F2）：`RecoverGuard`（失敗退避、讓出事件迴圈的時間片）的參數；`scanner` 供測試取代真的記憶體掃描。
   * 預設：掃不到時 30 s → 5 分鐘指數退避，連續占用事件迴圈超過 20 ms 就讓出。
   */
  keyRecovery?: { guard?: RecoverGuardOptions; scanner?: GetKeyOptions['scanner'] }
  /** app DB 引擎；預設 standalone 的 better-sqlite3（外掛 build 會把它指到 13.0.2）。 */
  appDbEngine?: AppDbEngine
  /**
   * 媒體：LINE Cache 目錄與檔案存取。省略 `cacheDir` 時，若 `linePorts.dbDir` 形如 `...\LINE\Data\db` 就推得 `...\LINE\Cache`；
   * 兩者都沒有＝`media.prepare` 回 media_unavailable（不猜路徑）。`fs` 省略時用 `linePorts.fs`。
   */
  media?: { cacheDir?: string; fs?: LineFsPort; maxCacheBytes?: number; reindexMinIntervalMs?: number; now?(): number }
  /**
   * 開機自我對帳（`runReconcile`，設定頁的 reconcile.enabled 決定要不要跑）與近期收回掃描。
   * 預設：有 `linePorts`（真引擎）才接；只給 fake `line` 的測試不接（對帳預設會開真 LINE 目錄）。
   * 傳物件＝強制接上並以物件覆寫 `ReconcileDeps`（測試注入假來源）；傳 false＝不接。
   */
  reconcile?: false | Partial<ReconcileDeps>
  extract?: Partial<Omit<ExtractQueueOptions, 'db' | 'getConfig'>>
  /** 回顧的續跑帳本（預設 `<dataDir>/review-ledger.json`、24 小時過期）；`now` 供測試的假時鐘。 */
  review?: { ledgerFile?: string | null; ttlMs?: number; now?(): number }
  /** UI 中轉的單次 AI 呼叫（草擬回覆／誤判分析／群組議題分析）。 */
  aiTasks?: Omit<AiTaskQueueOptions, 'onPending'>
  hub?: EventHubOptions
  dispatcher?: Partial<Pick<DispatcherOptions, 'softDeadlineMs' | 'responseBudgetBytes' | 'resultTtlMs' | 'maxResults' | 'maxResultBytes' | 'jobTtlMs' | 'maxJobs' | 'maxJobWaitMs'>>
  /** 啟動後不自動 `runtime.start()`（單元測試要自己控制時序時用）。 */
  autoStart?: boolean
}

const EVENT_BRIDGE: Array<[string, (api: LineTodoApi, emit: (payload: unknown) => void) => () => void]> = [
  ['line-message', (api, emit) => api.line.onMessage(emit)],
  ['line-status', (api, emit) => api.line.onStatus(emit)],
  ['messages-persisted', (api, emit) => api.db.onMessagesPersisted(emit)],
  ['pipeline-run', (api, emit) => api.pipeline.onRun(emit)],
  ['pipeline-status', (api, emit) => api.pipeline.onStatus(emit)],
  ['todos-changed', (api, emit) => api.pipeline.onTodosChanged(emit)],
  ['backfill-progress', (api, emit) => api.pipeline.onBackfillProgress(emit)],
  ['reconcile-progress', (api, emit) => api.pipeline.onReconcileProgress(emit)]
]

/** 可被 AbortSignal 提前喚醒的 sleep（timer 不阻止行程結束）。 */
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return }
    const timer = setTimeout(done, ms)
    timer.unref?.()
    function done(): void { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    signal.addEventListener('abort', done, { once: true })
  })
}

/** 連線是否還能用（better-sqlite3 close 之後 prepare 會 throw）。 */
function isOpen(db: { prepare(sql: string): { get(): unknown } }): boolean {
  try { db.prepare('SELECT 1').get(); return true } catch { return false }
}

/** app DB 引擎的 SQLite 版本（better-sqlite3 13.0.2＝3.53.4；standalone 11.10.0＝3.49.2），診斷用。 */
function appDbInfo(db: { prepare(sql: string): { get(): unknown } } | null): JsonValue {
  if (!db) return null
  try { return { sqlite: (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v } } catch { return { closed: true } }
}

export async function createPluginBackend(options: PluginBackendOptions): Promise<PluginBackendHandler> {
  const startedAt = Date.now()
  const { dataDir } = options
  const settings = createSettingsStore({ userDataDir: dataDir, secrets: NO_SECRETS })
  // env 傳 {}：backend 的行為不受環境變數影響（QWEN_*、LINE_* 都不讀）。
  const getDefaults = createPipelineConfig(() => settings.get(), {})
  const getQwenConfig = createQwenConfig({ readApiKey: () => null, readBaseUrl: () => null }, {})
  if (options.linePorts) configureLineEnginePorts(options.linePorts)

  const hub = new EventHub(options.hub)
  const mediaFs = options.media?.fs ?? options.linePorts?.fs
  const dbDir = options.linePorts?.dbDir
  const cacheDir = options.media?.cacheDir
    ?? (dbDir && basename(dirname(dbDir)).toLowerCase() === 'data' ? join(dirname(dirname(dbDir)), 'Cache') : undefined)
  const decryptor = cacheDir ? createMediaDecryptor({ ...(mediaFs ? { fs: mediaFs } : {}), cacheDir }) : null
  let appDbForMedia: MediaDb | null = null
  const media = createPluginMedia({
    dataDir,
    getDb: () => appDbForMedia,
    decryptor,
    maxCacheBytes: options.media?.maxCacheBytes,
    reindexMinIntervalMs: options.media?.reindexMinIntervalMs,
    now: options.media?.now
  })
  const reconcileWired = options.reconcile !== false && (options.reconcile !== undefined || options.linePorts !== undefined)
  const reconcileOverrides: Partial<ReconcileDeps> = options.reconcile && typeof options.reconcile === 'object' ? options.reconcile : {}
  let reconcileStarted = false
  let lastUnsentScan = 0
  const recentLog: string[] = []
  const log = (line: string): void => { recentLog.push(line.slice(0, 300)); if (recentLog.length > 40) recentLog.shift() }

  // ── LINE port ──
  // recoverGuard：金鑰擷取走協作式路徑（掃記憶體時讓出事件迴圈、single-flight、失敗退避、dispose 時取消）。cacheFile 一律明確指到 dataDir
  // （reconcile 的預設路徑也經由 keyOpts 帶進來，不再依賴 host 的 cwd 剛好是 dataDir；review F6）。
  const keyGuard = new RecoverGuard(options.keyRecovery?.guard)
  const keyOpts: GetKeyOptions = { cacheFile: join(dataDir, '.linekey'), recoverGuard: keyGuard, ...(options.keyRecovery?.scanner ? { scanner: options.keyRecovery.scanner } : {}) }
  const engineOptions = { stateFile: join(dataDir, '.watch_json_state'), keyOpts }
  const startupDelayMs = options.watcher?.startupDelayMs ?? (options.linePorts ? DEFAULT_STARTUP_DELAY_MS : 0)
  let watcher: LineWatcher | null = null
  let line = options.line
  if (!line) {
    const w = new LineWatcher({
      intervalSec: options.watcher?.intervalSec ?? 15,
      limit: options.watcher?.limit ?? 500,
      dbWatchEnabled: false, // fs.watch 對 LINE 目錄在權限模型下沒意義：只用間隔輪詢（設計 v2 §4.1.2）
      drainBacklog: options.watcher?.drainBacklog ?? true,
      // 第一輪 poll 延後到 activate() 回傳之後（real LINE）；fake／測試（沒有 linePorts）維持立即開始。
      ...(options.linePorts || options.watcher?.startupDelayMs !== undefined ? { startupDelayMs } : {}),
      engine: engineOptions
    })
    w.on('log', log)
    watcher = w
    line = {
      start: () => w.start(),
      stop: () => w.stop(),
      status: () => w.getStatus(),
      onMessage: (listener) => { w.on('message', listener); return () => { w.off('message', listener) } },
      onStatus: (listener) => { w.on('status', listener); return () => { w.off('status', listener) } },
      setBatchCommitter: (committer: (batch: LineImportBatch) => void | Promise<void>) => w.setBatchCommitter(committer),
      getLineImportBatch: (cursor, opts) => getLineImportBatch({ ...opts, cursor, source: opts.source ?? 'line-backfill', ...engineOptions }),
      getMessagesSince: (sinceMs, opts) => getMessagesSince(sinceMs, { ...opts, ...engineOptions })
    }
  }

  // ── 回顧（reviewLastDays）：續跑帳本＋進度 ──
  const review = new ReviewCoordinator({
    ledger: new ReviewLedger({
      ...(options.review?.ledgerFile === null ? {} : { file: options.review?.ledgerFile ?? join(dataDir, 'review-ledger.json') }),
      ttlMs: options.review?.ttlMs,
      now: options.review?.now
    }),
    // 回顧與補媒體金鑰的狀態檔（G-05）：backend 重新啟動後讀回，UI 用 `tasks.status` 查詢。ledgerFile:null（純記憶體測試）時也不寫狀態檔。
    ...(options.review?.ledgerFile === null ? {} : { statusFile: join(dataDir, 'review-status.json') }),
    now: options.review?.now
  })
  const mediaBackfill = new LongTaskTracker({
    name: 'mediaBackfill',
    ...(options.review?.ledgerFile === null ? {} : { file: join(dataDir, 'media-backfill-status.json') }),
    now: options.review?.now,
    interruptedSummary: '上次「補媒體金鑰」進行中外掛後端重新啟動，沒有做完；可以再按一次'
  })

  // ── AI 供料/收料 + scheduler ──
  let queue!: ExtractQueue
  // 草擬回覆／誤判分析／群組議題分析：core 照 standalone 的邏輯跑，只有 provider.complete() 變成「排隊等 UI 用 ai:chat 完成」。
  const aiTasks = new AiTaskQueue({ ...options.aiTasks, onPending: (info) => hub.publish('extract-pending', info) })
  const uiProvider = createUiAiProvider(aiTasks)
  let scheduler: PipelineScheduler | null = null
  let appDb: { prepare(sql: string): { get(): unknown } } | null = null
  const unsupported = async (): Promise<{ ok: false; error: string }> => ({ ok: false, error: 'unsupported_in_plugin' })

  const runtime = await createLineTodoRuntime({
    dataDir,
    initialize: () => createLineTodoApplication({
      dataDir,
      dbPath: join(dataDir, 'line-todo.db'),
      appDbEngine: options.appDbEngine ?? createBetterSqlite3AppEngine(),
      onDatabase: (db) => { appDb = db; appDbForMedia = db },
      participantIdentity: UNKNOWN_IDENTITY,
      settings,
      pipelineConfig: { getDefaults, getQwenConfig, isProviderConfigured: () => true },
      providers: { resolveProvider: () => uiProvider },
      onSettingsChanged: () => { scheduler?.notifySettingsChanged() },
      line,
      // 同步呼叫端（reviewLastDays 回顧）也走 ExtractQueue：同一個 pull/commit 通道，結果直接 resolve 給呼叫端。
      makeExtract: () => review.wrapExtract((input) => queue.request(input)),
      schedulerFactory: (db, repos) => {
        queue = new ExtractQueue({
          ...options.extract,
          db,
          getConfig: getDefaults,
          onRun: (result) => scheduler?.recordExternalRun(result),
          onPending: (info) => hub.publish('extract-pending', info)
        })
        scheduler = new PipelineScheduler({
          db,
          getDefaults,
          getLastRun: () => getLastRun(db),
          isProviderConfigured: () => true, // 「AI 引擎已就緒」＝UI 端有 ai:chat；就緒與否由 UI 的 orchestrator 負責呈現
          makeExtract: () => null,
          correctionsForChat: (chatId) => repos.notMine.corrections(chatId),
          onCorrectionsPayloadBuilt: (chatId, messageIds, rules) => rules.forEach((rule) => repos.notMine.effect(rule, chatId, messageIds, 'runOnce')),
          extractSink: queue
        })
        return scheduler
      },
      media: { open: unsupported, saveAs: unsupported },
      // 設計 v2 §7 Phase 3：開機自我對帳與近期收回掃描（standalone 的 index.ts 同名 hook，逐字對應；進度改進 EventHub）。
      afterStart: (db, schedule) => {
        if (!reconcileWired || reconcileStarted) return
        reconcileStarted = true
        const reconcile = settings.get().reconcile
        if (!reconcile.enabled) return
        schedule(async (signal) => {
          // 與第一輪 poll 一樣等 activate() 回傳之後才開始（它也會用到金鑰；single-flight，不會重複掃描）。
          if (startupDelayMs > 0) await sleepUnlessAborted(startupDelayMs, signal)
          if (signal.aborted) return
          const importReady = isLineImportSchemaReady(db)
          await runReconcile({ scopeMonths: reconcile.scopeMonths }, {
            db,
            getSourceFingerprint: () => getSourceMonthlyFingerprint({ keyOpts }),
            checkHealth: () => ({ ok: db.pragma('quick_check', { simple: true }) === 'ok' }),
            stateFile: join(dataDir, 'reconcile-state.json'),
            lockFile: join(dataDir, '.reconcile_lock'),
            signal,
            getMessagesSince: async (sinceMs, opts) => line!.getMessagesSince(sinceMs, opts),
            getImportBatch: importReady ? line!.getLineImportBatch : undefined,
            commitImportBatch: importReady ? (batch, opts) => commitLineImportBatch(db, batch, UNKNOWN_IDENTITY, opts) : undefined,
            onProgress: (progress) => { if (!signal.aborted) hub.publish('reconcile-progress', progress) },
            ...reconcileOverrides
          }).catch((error) => log(`[reconcile] failed: ${error instanceof Error ? error.name : 'unknown'}`))
        })
      },
      afterPipelineRun: (_result, db, schedule) => {
        if (!reconcileWired) return
        schedule(async (signal) => {
          if (signal.aborted || Date.now() - lastUnsentScan < UNSENT_SCAN_MIN_INTERVAL_MS) return
          lastUnsentScan = Date.now()
          const importReady = isLineImportSchemaReady(db)
          await scanRecentUnsent(3, {
            db, signal,
            fetchWindow: async (sinceMs) => ({ messages: await line!.getMessagesSince(sinceMs, { limit: 5000 }) }),
            fetchImportBatch: importReady ? line!.getLineImportBatch : undefined,
            commitImportBatch: importReady ? (batch) => commitLineImportBatch(db, batch, UNKNOWN_IDENTITY) : undefined
          }).catch((error) => log(`[unsent-scan] failed: ${error instanceof Error ? error.name : 'unknown'}`))
        })
      },
      app: {
        ping: () => ({ ok: true, ts: Date.now(), version: options.version }),
        openDataFolder: async () => ({ ok: false }),
        openOriginal: unsupported
      }
    })
  })

  // ── 事件橋接 ──
  const unsubscribers = EVENT_BRIDGE.map(([type, subscribe]) => subscribe(runtime.api, (payload) => {
    if (type === 'backfill-progress') review.noteProgress(payload)
    hub.publish(type, payload)
  }))

  let disposed = false
  const dispatcher: Dispatcher = new Dispatcher({
    ...options.dispatcher,
    getApi: () => {
      if (disposed) throw new Error('Line Todo runtime is disposed')
      return runtime.api
    },
    hub,
    queue,
    aiTasks,
    media,
    review,
    mediaBackfill,
    info: (): Record<string, JsonValue> => ({
      plugin: options.pluginId,
      version: options.version,
      pid: process.pid,
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      uptimeMs: Date.now() - startedAt,
      rssMB: Math.round((process.memoryUsage.rss() / 1048576) * 10) / 10,
      line: line!.status() as unknown as JsonValue,
      watcher: watcher !== null,
      keyRecovery: { scans: keyGuard.scans, blocked: keyGuard.blocked(), retryInMs: keyGuard.retryInMs() },
      appDb: appDbInfo(appDb),
      extract: queue.stats(),
      review: review.status() as unknown as JsonValue,
      aiTasks: aiTasks.stats(),
      media: media.stats() as unknown as JsonValue,
      events: hub.stats(),
      dispatcher: dispatcher.stats(),
      recentLog: [...recentLog]
    })
  })

  try {
    if (options.autoStart !== false) await runtime.start()
  } catch (error) {
    disposed = true
    keyGuard.cancel()
    for (const off of unsubscribers) off()
    dispatcher.dispose()
    hub.dispose()
    queue.dispose()
    aiTasks.dispose()
    review.dispose()
    await runtime.dispose().catch(() => undefined)
    throw error
  }

  const engine = options.linePorts?.sqlite as unknown as { openConnections?: () => number; vfs?: { openFiles(): number; shmNodes(): number } } | undefined

  return {
    call: (method, params) => dispatcher.call(method, params),
    // 目前未啟用（review F9）：manifest 沒有宣告 provided capability，host 不會呼叫 openSession；事件走 events.* 方法組的長輪詢（見 eventHub.ts 檔頭）。
    openSession: async (info: SessionInfo, channel: SessionChannel) => hub.attachChannel(info, channel),
    dispose: async () => {
      if (disposed) return
      disposed = true
      // 進行中的金鑰掃描在下一個讓出點結束（之後的金鑰解析一律回 null），不會在 dispose 之後還掃著 LINE 記憶體。
      keyGuard.cancel()
      // 順序：先關入口（新的 call 拿到 backend_stopped）、解除等待中的長輪詢／同步抽取，再停 runtime（waitForCalls 才不會卡住）。
      dispatcher.dispose()
      for (const off of unsubscribers) { try { off() } catch { /* 已解除 */ } }
      hub.dispose()
      queue.dispose()
      aiTasks.dispose()
      review.dispose()
      await runtime.dispose()
      // 讓進行中的 poll／掃描收尾（刪掉暫存快照、關 handle）；等不到就放手，殘留的快照目錄會在下次啟動時清掉。
      await Promise.race([Promise.all([watcher?.idle(), keyGuard.idle()]), new Promise<void>((resolve) => { setTimeout(resolve, DISPOSE_IDLE_WAIT_MS).unref?.() })])
    },
    diagnostics: (): BackendDiagnostics => ({
      appDbOpen: appDb ? isOpen(appDb) : false,
      lineEngine: engine?.openConnections ? { openConnections: engine.openConnections(), vfsOpenFiles: engine.vfs?.openFiles() ?? 0, vfsShmNodes: engine.vfs?.shmNodes() ?? 0 } : null,
      eventSessions: hub.stats().sessions,
      extract: { pending: queue.stats().pending, leased: queue.stats().leased, awaiting: queue.stats().awaiting },
      jobs: dispatcher.stats().jobs,
      results: dispatcher.stats().results,
      disposed
    })
  }
}
