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
 *   | AI              | provider（http／CLI）+ extractFn    | AI port → context.host.ai.complete（hostAi.ts）；ExtractQueue 供料 + ExtractWorker 在 backend 領取、呼叫、落庫 |
 *   | secrets         | Electron safeStorage                | 無（backend 不持有任何 AI 金鑰；AI 由 TeamUQ 代送）      |
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
import { createPromptService } from './promptService'
import { createChatPromptStore } from './chatPromptStore'
import type { ChatPromptDatabase } from './chatPromptStore'
import type { SettingsSecretStorage } from '../../main/config/settings'
import type { AppDbEngine } from '../../main/db/appDbEngine'
import { createBetterSqlite3AppEngine } from '../../main/db/appDbEngine'
import { getLastRun } from '../../main/db/pipeline.repo'
import { commitLineImportBatch, isLineImportSchemaReady } from '../../main/db/lineImport.repo'
import { ensureLineAvatarSchema } from '../../main/db/lineAvatar.repo'
import { ensureMediaIndexSchema } from '../../main/db/mediaIndex.repo'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { configureLineEnginePorts, getLineEnginePorts } from '../../main/line/engine/enginePorts'
import type { LineEnginePorts } from '../../main/line/engine/enginePorts'
import { createLineAccess } from '../../main/line/engine/lineAccess'
import { LineSnapshotStore } from '../../main/line/engine/lineSnapshot'
import { RecoverGuard } from '../../main/line/engine/linekey'
import type { GetKeyOptions, RecoverGuardOptions } from '../../main/line/engine/linekey'
import { getAvatarMetadata, getLineImportBatch, getMessagesSince } from '../../main/line/engine/watchEngine'
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
import type { PluginBackendAiApiV1, PluginProgramApiV1 } from '@teamuq/plugin-sdk'
import { createPortAiProvider } from './aiProvider'
import { Dispatcher } from './dispatcher'
import type { AiRuntime, DispatcherOptions } from './dispatcher'
import { EventHub } from './eventHub'
import { InvokeTrace } from './invokeTrace'
import type { InvokeTraceOptions } from './invokeTrace'
import type { EventHubOptions } from './eventHub'
import { ExtractQueue } from './extractQueue'
import type { ExtractQueueOptions } from './extractQueue'
import { createExtractWorker } from './extractWorker'
import type { ExtractWorker, ExtractWorkerConfig } from './extractWorker'
import { AI_CHAT_REFERENCE, createHostAiPort, createNoHostAiPort } from './hostAi'
import { COMBINED_BUNDLE_ENABLED } from '../../main/features/groupTopics/prompts/bundle'
import type { Clock, HostAiConfig, HostAiPort } from './hostAi'
import { createAiSessionMapStore } from './aiSessionMapStore'
import { ROLLING_SOURCE_SESSION_POLICY, configureSourceSessionPolicy } from '../../main/db/sourceCache'
import type { AiSessionMapDatabase } from './aiSessionMapStore'
import type { AiStatus } from '../../shared/aiStatus'
import { createResidencyTracker } from './residency'
import { createTeamuqTaskBinding } from './teamuqTask'
import { createPluginMedia } from './media'
import type { MediaDb } from './media'
import { createMediaIndex } from './mediaIndex'
import type { MediaIndex, MediaIndexBudget } from './mediaIndex'
import { createAvatarCache } from './avatarCache'
import { createPluginAvatars } from './avatar'
import type { AvatarDb, AvatarMetadataReader } from './avatar'
import { createLayeredAvatarReader } from './avatarReader'
import { createAvatarBackfill, OFF_STATUS } from './avatarBackfill'
import type { AvatarBackfillBudget } from './avatarBackfill'
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
  epoch: () => null,
  persistUnknown: false
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
  /**
   * LINE DB 的持久 snapshot（`<dataDir>/line-engine/snapshot`，lineSnapshot.ts）與單一入口（lineAccess.ts）：poll、頭像、reconcile、resetNow 共用同一份副本與同一把金鑰。
   * 只在有 `linePorts` 時啟用；`enabled:false`＝關閉，全部退回舊的「解析金鑰 + 每次整份複製」流程（回退開關）。
   * `walOnly` 預設只在引擎是唯讀的 WASM 時開（副本必須一直和來源 edb 逐位元組相同）；`fullResyncMs`／`now` 供測試。
   */
  snapshot?: { enabled?: boolean; walOnly?: boolean; fullResyncMs?: number; now?(): number }
  /**
   * 發話者頭像存本地 DB（lineAvatar.repo.ts）：匯入時順便寫入、讀取先看本地、背景回填既有訊息。
   * `enabled:false`＝回到「每次從 LINE DB 讀」的舊行為：不建表、不寫入、不回填。
   */
  avatarStore?: { enabled?: boolean; now?(): number; backfill?: { enabled?: boolean } & AvatarBackfillBudget }
  /** app DB 引擎；預設 standalone 的 better-sqlite3（外掛 build 會把它指到 13.0.2）。 */
  appDbEngine?: AppDbEngine
  /**
   * 媒體：LINE Cache 目錄與檔案存取。省略 `cacheDir` 時，若 `linePorts.dbDir` 形如 `...\LINE\Data\db` 就推得 `...\LINE\Cache`；
   * 兩者都沒有＝`media.prepare` 回 media_unavailable（不猜路徑）。`fs` 省略時用 `linePorts.fs`。
   */
  media?: {
    cacheDir?: string; fs?: LineFsPort; maxCacheBytes?: number
    /** 圖片索引的 `noteMiss` 節流（ms，預設 30 s）。`reindexMinIntervalMs` 是舊名，保留一版當別名。 */
    refreshMinIntervalMs?: number; reindexMinIntervalMs?: number
    /** 圖片索引的時鐘（24 小時重列、30 天清除、節流）與掃描預算（啟動延遲、切片大小等，測試用）。 */
    now?(): number
    index?: MediaIndexBudget
  }
  /**
   * 開機自我對帳（`runReconcile`，設定頁的 reconcile.enabled 決定要不要跑）與近期收回掃描。
   * 預設：有 `linePorts`（真引擎）才接；只給 fake `line` 的測試不接（對帳預設會開真 LINE 目錄）。
   * 傳物件＝強制接上並以物件覆寫 `ReconcileDeps`（測試注入假來源）；傳 false＝不接。
   */
  reconcile?: false | Partial<ReconcileDeps>
  extract?: Partial<Omit<ExtractQueueOptions, 'db' | 'getConfig'>>
  /** 回顧的續跑帳本（預設 `<dataDir>/review-ledger.json`、24 小時過期）；`now` 供測試的假時鐘。 */
  review?: { ledgerFile?: string | null; ttlMs?: number; now?(): number }
  /**
   * TeamUQ 的 AI（`context.host.ai`，Core >=1.7.13）。省略＝backend 沒有 AI（只有單元測試）：背景抽取不啟動，AI 功能以 provider_unavailable 失敗。
   * 抽取、草擬回覆、誤判分析、群組議題分析、prompt 修正都經它完成（hostAi.ts 的 AI port），看板不需要開著。
   */
  hostAi?: PluginBackendAiApiV1
  /**
   * TeamUQ 的 Program API（`context.host.program`）。AI 對話掛在外掛自己建的 Project／Task 上（teamuqTask.ts）；省略＝不帶 `taskId`（舊 Core 或測試）。
   */
  hostProgram?: Pick<PluginProgramApiV1, 'call'>
  /**
   * Core 的 `context.residency`（`background:resident`，residency.ts）。省略或形狀不對＝舊 Core：`backend.residency` 回 `supported:false`，不訂閱、不發 `residency` 事件。
   * 只靠 `onChange` 更新，降級時不做任何保活動作。
   */
  residency?: unknown
  /** AI port 與背景 worker 的參數／時鐘（測試用：假時鐘讓一分鐘的配額視窗跑得快）。 */
  ai?: { clock?: Clock; config?: Partial<HostAiConfig>; worker?: Partial<ExtractWorkerConfig> }
  hub?: EventHubOptions
  dispatcher?: Partial<Pick<DispatcherOptions, 'softDeadlineMs' | 'aiDeadlineMs' | 'responseBudgetBytes' | 'resultTtlMs' | 'maxResults' | 'maxResultBytes' | 'jobTtlMs' | 'maxJobs' | 'maxJobWaitMs'>>
  /**
   * 呼叫紀錄（invokeTrace.ts）：預設開啟，寫到 `<dataDir>/logs/invoke-trace.log`（輪替檔 `.1`）。傳 false＝關閉；傳物件＝覆寫門檻／上限／時鐘（測試用）。
   */
  trace?: false | Partial<InvokeTraceOptions>
  /** 啟動後不自動 `runtime.start()`（單元測試要自己控制時序時用）。 */
  autoStart?: boolean
}

/** 呼叫紀錄檔相對於 dataDir 的位置（診斷與文件引用這個路徑）。 */
export const INVOKE_TRACE_RELATIVE_FILE = join('logs', 'invoke-trace.log')

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

  // 觀測：InvokeTrace 在 runtime 初始化之後才建立（下面），但 snapshot 的 span 與背景工作的計時在那之前就註冊好了，所以用可變參考延後取用。
  let trace: InvokeTrace | null = null
  /** 量一件背景工作（同步或回傳 promise 皆可）占了多久，記成 `bg` 事件（≥ eventMinMs 才會寫進 log）。 */
  const bg = <T>(phase: string, run: () => T): T => {
    const t0 = performance.now()
    const done = (): void => { trace?.event('bg', { p: phase, ms: performance.now() - t0 }) }
    let result: T
    try { result = run() } catch (error) { done(); throw error }
    if (result instanceof Promise) return result.finally(done) as T
    done()
    return result
  }

  // ── LINE DB 的持久 snapshot 與單一入口（外掛專用；standalone 不經過這裡）──
  const snapshotStore = options.linePorts && options.snapshot?.enabled !== false
    ? new LineSnapshotStore({
      fs: options.linePorts.fs,
      dir: join(dataDir, 'line-engine', 'snapshot'),
      walOnly: options.snapshot?.walOnly ?? options.linePorts.sqlite.name.startsWith('sqlite3mc-wasm'),
      ...(options.snapshot?.fullResyncMs !== undefined ? { fullResyncMs: options.snapshot.fullResyncMs } : {}),
      ...(options.snapshot?.now ? { now: options.snapshot.now } : {}),
      onSpan: (kind, ms, bytes) => trace?.event('snap', { m: kind, ms, bytes })
    })
    : null
  const lineAccess = snapshotStore ? createLineAccess({ store: snapshotStore }) : null
  if (options.linePorts) configureLineEnginePorts({ ...options.linePorts, access: lineAccess ?? undefined })
  const fsCopyStats = (options.linePorts?.fs as unknown as { copyStats?: { async: number; syncFallback: number } } | undefined)?.copyStats

  // Avatar source reads use the same async key recovery and Win32/WASM ports as LINE imports.
  const keyGuard = new RecoverGuard(options.keyRecovery?.guard)
  const keyOpts: GetKeyOptions = { cacheFile: join(dataDir, '.linekey'), recoverGuard: keyGuard, ...(options.keyRecovery?.scanner ? { scanner: options.keyRecovery.scanner } : {}) }
  const avatarStoreOn = options.avatarStore?.enabled !== false
  let avatarSchemaReady = false
  let avatarDb: BetterSqlite3Database | null = null
  const avatarReads = { local: 0, fallback: 0, miss: 0, write: 0 }
  const engineOptions = { stateFile: join(dataDir, '.watch_json_state'), keyOpts, ...(avatarStoreOn ? { avatarMeta: true } : {}) }

  const hub = new EventHub(options.hub)
  const mediaFs = options.media?.fs ?? options.linePorts?.fs
  const dbDir = options.linePorts?.dbDir
  const cacheDir = options.media?.cacheDir
    ?? (dbDir && basename(dirname(dbDir)).toLowerCase() === 'data' ? join(dirname(dirname(dbDir)), 'Cache') : undefined)
  // 圖片索引（mediaIndex.ts）：LINE Cache 的 size → 路徑存在 app DB，背景切片掃描；`media.prepare` 只查索引。沒有 Cache 目錄＝沒有索引。
  // 建表失敗時 `mediaIndexDb` 維持 null：索引關閉、`media.prepare` 回 media_unavailable，不會退回同步走訪。
  let mediaIndexDb: BetterSqlite3Database | null = null
  const indexFs = mediaFs ?? {
    readDir: (dir: string, readOptions?: { stat?: boolean }) => getLineEnginePorts().fs.readDir(dir, readOptions),
    stat: (path: string) => getLineEnginePorts().fs.stat(path),
    exists: (path: string) => getLineEnginePorts().fs.exists(path)
  }
  const mediaIndex: MediaIndex | null = cacheDir
    ? createMediaIndex({
      getDb: () => mediaIndexDb,
      fs: indexFs,
      cacheDir,
      ...(options.media?.now ? { now: options.media.now } : {}),
      trace: (phase, ms) => trace?.event('bg', { p: phase, ms }),
      log: (line) => log(line),
      budget: {
        ...options.media?.index,
        refreshMinIntervalMs: options.media?.refreshMinIntervalMs ?? options.media?.reindexMinIntervalMs ?? options.media?.index?.refreshMinIntervalMs
      }
    })
    : null
  const decryptor = cacheDir && mediaIndex ? createMediaDecryptor({ ...(mediaFs ? { fs: mediaFs } : {}), cacheDir, index: mediaIndex }) : null
  let appDbForMedia: (MediaDb & AvatarDb) | null = null
  const media = createPluginMedia({
    dataDir,
    getDb: () => appDbForMedia,
    decryptor,
    index: mediaIndex,
    maxCacheBytes: options.media?.maxCacheBytes
  })
  const avatarCache = createAvatarCache({ dataDir })
  // 回填既有訊息的頭像連結：只在有持久 snapshot 時才跑（只用 `any`，絕不複製、不掃金鑰）；啟動與 dispose 見下面。
  const { enabled: backfillEnabled, ...backfillBudget } = options.avatarStore?.backfill ?? {}
  const backfill = avatarStoreOn && backfillEnabled !== false && lineAccess
    ? createAvatarBackfill({
      getDb: () => (avatarSchemaReady ? avatarDb : null),
      openSource: () => lineAccess.open({ dbPath: null, policy: 'any', keyOpts }),
      trace: (phase, ms) => trace?.event('bg', { p: phase, ms }),
      log: (line) => log(line),
      budget: backfillBudget
    })
    : null
  // 頭像：本地 DB → `any` snapshot（結果寫回本地）→ 文字頭像。功能關閉時只走 LINE DB（舊行為）。
  const avatarFallback: AvatarMetadataReader = { read: (input) => getAvatarMetadata(input, engineOptions) }
  const avatarReader: AvatarMetadataReader = avatarStoreOn
    ? createLayeredAvatarReader({
      getDb: () => avatarDb,
      fallback: avatarFallback,
      ...(options.avatarStore?.now ? { now: options.avatarStore.now } : {}),
      onStat: (kind, n) => { avatarReads[kind] += n }
    })
    : avatarFallback
  const avatars = createPluginAvatars({
    cache: avatarCache,
    reader: avatarReader,
    getDb: () => appDbForMedia
  })
  const reconcileWired = options.reconcile !== false && (options.reconcile !== undefined || options.linePorts !== undefined)
  const reconcileOverrides: Partial<ReconcileDeps> = options.reconcile && typeof options.reconcile === 'object' ? options.reconcile : {}
  let reconcileStarted = false
  let lastUnsentScan = 0
  const recentLog: string[] = []
  const log = (line: string): void => { recentLog.push(line.slice(0, 300)); if (recentLog.length > 40) recentLog.shift() }

  // ── 背景執行（context.residency）：啟動時讀一次，之後只靠 onChange；變動時發 `residency` 事件給看板。降級時不做任何保活（residency.ts）。 ──
  const residency = createResidencyTracker(options.residency, (event, detail) => log(`[residency] ${event} ${JSON.stringify(detail ?? {})}`))
  const offResidency = residency.onChange((snapshot) => { hub.publish('residency', snapshot) })

  // ── LINE port ──
  // recoverGuard：金鑰擷取走協作式路徑（掃記憶體時讓出事件迴圈、single-flight、失敗退避、dispose 時取消）。cacheFile 一律明確指到 dataDir
  // （reconcile 的預設路徑也經由 keyOpts 帶進來，不再依賴 host 的 cwd 剛好是 dataDir；review F6）。
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
      setBatchCommitter: (committer: (batch: LineImportBatch) => void | Promise<void>) => w.setBatchCommitter((batch) => bg('poll', () => committer(batch))),
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

  // ── AI port（host.ai.complete）+ 供料佇列 + 背景 worker + scheduler ──
  // HostAiPort 先於 app DB 組裝；session map store 延後讀取，只有 runtime 初始化完成後才碰 app_settings。
  let appDb: (AiSessionMapDatabase & ChatPromptDatabase) | null = null
  const aiSessionMapStore = createAiSessionMapStore({ getDatabase: () => appDb })
  let queue!: ExtractQueue
  let worker = null as ExtractWorker | null
  let workerStartTimer: ReturnType<typeof setTimeout> | null = null
  const aiPort: HostAiPort = options.hostAi
    ? createHostAiPort({
      ai: options.hostAi,
      selection: () => settings.get().pluginAi,
      task: createTeamuqTaskBinding({
        ...(options.hostProgram ? { program: options.hostProgram } : {}),
        file: options.review?.ledgerFile === null ? null : join(dataDir, 'teamuq-task.json'),
        ...(options.ai?.clock ? { now: () => options.ai!.clock!.now() } : {}),
        log: (event, detail) => log(`[teamuq-task] ${event} ${JSON.stringify(detail ?? {})}`)
      }),
      ...(options.ai?.clock ? { clock: options.ai.clock } : {}),
      ...(options.ai?.config ? { config: options.ai.config } : {}),
      sessionMapStore: aiSessionMapStore,
      log: (event, detail) => log(`[ai] ${event} ${JSON.stringify(detail ?? {})}`)
    })
    : createNoHostAiPort()
  // 逐對話的 prompt／名字覆寫放在 app DB 的 app_settings；同樣用 lazy getter，DB 開起來之前讀寫都丟 chat_prompt_unavailable。
  const prompts = createPromptService(settings, aiPort, {
    chatStore: createChatPromptStore({ getDatabase: () => appDb }),
    log: (event) => log(`[prompt] ${event}`)
  })
  // 草擬回覆／誤判分析／群組議題分析：core 照 standalone 的邏輯跑，provider.complete() 直接經 AI port 呼叫 host.ai.complete（使用者動作，排在背景抽取之前）。
  const aiProvider = createPortAiProvider(aiPort, { usable: () => { const state = aiPort.status().state; return state !== 'unavailable' && state !== 'revoked' && state !== 'stopped' } })
  // 議題背景分析：同一個 port，但排在使用者動作之後。
  const aiProviderBackground = createPortAiProvider(aiPort, { priority: 'background', usable: () => { const state = aiPort.status().state; return state !== 'unavailable' && state !== 'revoked' && state !== 'stopped' } })
  // ai-status 事件：最多每秒一則（trailing）。每一輪 AI 呼叫都會讓 busy 翻兩次，不節流會擠掉與 line-message 共用的 512 則事件環。
  let aiStatusTimer: ReturnType<typeof setTimeout> | null = null
  let lastAiStatusAt = 0
  const publishAiStatus = (): void => { aiStatusTimer = null; lastAiStatusAt = Date.now(); hub.publish('ai-status', aiStatus()) }
  const offAiPortStatus = aiPort.onStatus(() => {
    // Auth/provider recovery must wake a leased review queue immediately; its bounded SourceCache
    // lease is renewed per part, and the ReviewCoordinator can otherwise time out while polling sleeps.
    worker?.kick()
    if (aiStatusTimer !== null) return
    const wait = lastAiStatusAt + 1000 - Date.now()
    if (wait <= 0) publishAiStatus()
    else { aiStatusTimer = setTimeout(publishAiStatus, wait); aiStatusTimer.unref?.() }
  })
  const offAiStatus = (): void => { offAiPortStatus(); if (aiStatusTimer !== null) { clearTimeout(aiStatusTimer); aiStatusTimer = null } }
  const aiStatus = (): AiStatus => {
    const stats = queue?.stats()
    const port = aiPort.status()
    // 現在就能領的待抽取項目在等配額視窗（每分鐘保留輪數、每小時保留輪數之後的空檔）：port 本身沒有工作在睡，狀態會是「就緒」，這裡改說已達上限（review F9）。
    const waiting = port.state === 'running' && !port.busy && queue !== undefined && queue.runnable() > 0 ? aiPort.windowWait('background') : null
    return {
      ...port,
      ...(waiting ? { state: 'paused' as const, reason: waiting.scope === 'hour' ? 'rate_limited_hour' : 'rate_limited', resumeAt: waiting.resumeAt } : {}),
      counters: { ...port.counters, ...(worker?.counters() ?? {}) },
      ...(stats ? { queue: { pending: stats.pending, leased: stats.leased, awaiting: stats.awaiting } } : {})
    }
  }
  const aiRuntime: AiRuntime = {
    ready: (force) => aiPort.ready(force),
    status: aiStatus,
    options: () => aiPort.options(),
    refresh: () => { aiPort.refresh(); worker?.kick() }
  }
  let scheduler: PipelineScheduler | null = null
  const unsupported = async (): Promise<{ ok: false; error: string }> => ({ ok: false, error: 'unsupported_in_plugin' })

  const runtime = await createLineTodoRuntime({
    dataDir,
    initialize: (ownerLockProof) => createLineTodoApplication({
      dataDir,
      dbPath: join(dataDir, 'line-todo.db'),
      runtimeOwnerProof: ownerLockProof,
      appDbEngine: options.appDbEngine ?? createBetterSqlite3AppEngine(),
      onDatabase: (db) => {
        // Host Session 的身分與 SourceCache 的上下文 epoch 脫鉤：每聊天室的 Host Session 永遠接續，預算（64 輪／64 請求／128 KiB）用完只歸零計數、閒置 24h 不再進位 epoch（tainted 仍會，由上下文重設標記處理）。
        configureSourceSessionPolicy(db, ROLLING_SOURCE_SESSION_POLICY)
        appDb = db
        appDbForMedia = db
        avatarDb = db
        // 附屬表，不動 user_version；建不起來只是頭像退回舊流程（匯入端用 isLineAvatarSchemaReady 判斷，沒有表就跳過）。
        if (avatarStoreOn) {
          try { ensureLineAvatarSchema(db); avatarSchemaReady = true } catch { log('[avatar-store] schema_unavailable') }
        }
        if (mediaIndex) {
          try { ensureMediaIndexSchema(db); mediaIndexDb = db } catch { log('[media-index] schema_unavailable') }
        }
      },
      participantIdentity: UNKNOWN_IDENTITY,
      settings,
      pipelineConfig: { getDefaults, getQwenConfig, isProviderConfigured: () => true },
      // 舊的「補分析」只處理集合 B（processed=1 且尚無議題決策）：只在合併整理真的會跑的時候（外掛 backend、旗標開、bundle 可用）。
      combinedExtractActive: () => settings.get().pluginCombinedExtract === true && COMBINED_BUNDLE_ENABLED,
      providers: { resolveProvider: () => aiProvider, resolveBackgroundProvider: () => aiProviderBackground },
      topicBackgroundLog: (event, detail) => log(`[topic-bg] ${event} ${JSON.stringify(detail ?? {})}`),
      onSettingsChanged: () => {
        scheduler?.notifySettingsChanged()
        // 選了別的供應者／模型／推理強度：port 下一次呼叫前會發現並重新讀 host 的選項；叫 worker 現在就看一次，不必等退避到期。
        worker?.kick()
      },
      line,
      // 同步呼叫端（reviewLastDays 回顧）也走 ExtractQueue：同一個 pull/commit 通道，結果直接 resolve 給呼叫端。
      // 重新整理（單一聊天室）：直接走 ExtractQueue，不經回顧帳本（帳本會讓同一批訊息第二次整個跳過）。
      // 不信任快取（同回顧開始前）：AI 沒就緒就立刻回 ai_unavailable，不進佇列空等。
      refreshReady: () => aiPort.ready(true),
      makeRefreshExtract: () => {
        const extract = (input: Parameters<ExtractQueue['request']>[0]) => queue.request(input)
        ;(extract as typeof extract & {identityAttemptManagedByQueue?:boolean}).identityAttemptManagedByQueue=true
        return extract
      },
      makeExtract: () => {
        const extract=review.wrapExtract((input) => queue.request(input))
        ;(extract as typeof extract & {identityAttemptManagedByQueue?:boolean}).identityAttemptManagedByQueue=true
        return extract
      },
      schedulerFactory: (db, repos) => {
        queue = new ExtractQueue({
          ...options.extract,
          db,
          getConfig: getDefaults,
          getSystemSha256: (chatId, opts) => opts?.topics ? prompts.systemSha256(chatId, opts) : prompts.systemSha256(chatId),
          // 待辦＋議題合併整理（執行期旗標，設定頁即時生效）。帶議題的 system 超過 host 的 systemChars 時該聊天室退回純待辦。
          combined: {
            enabled: () => settings.get().pluginCombinedExtract === true,
            systemFits: (chatId) => prompts.extractSystem(chatId, { topics: true }).length <= AI_CHAT_REFERENCE.systemChars
          },
          log: (event, detail) => log(`[extract-queue] ${event} ${JSON.stringify(detail ?? {})}`),
          getSessionContext: () => JSON.stringify(settings.get().pluginAi),
          onRun: (result) => scheduler?.recordExternalRun(result),
          onPending: () => worker?.kick(),
          // A review can arrive immediately after activation acknowledges. Treat the scheduled
          // startup interval as available so request() queues the work for the worker instead of
          // recording a false extract_ui_offline pause before start() runs.
          consumerOnline: () => worker?.running() === true || workerStartTimer !== null
        })
        worker = createExtractWorker({
          queue,
          port: aiPort,
          system: (chatId, opts) => opts ? prompts.extractSystem(chatId, opts) : prompts.extractSystem(chatId),
          ...(options.ai?.clock ? { clock: options.ai.clock } : {}),
          ...(options.ai?.worker ? { config: options.ai.worker } : {}),
          log: (event, detail) => log(`[extract] ${event} ${JSON.stringify(detail ?? {})}`)
        })
        scheduler = new PipelineScheduler({
          db,
          getDefaults,
          getLastRun: () => getLastRun(db),
          isProviderConfigured: () => true, // 「AI 引擎已就緒」＝backend 有 host.ai；就緒與否（登入、額度、授權）由 ExtractWorker／HostAiPort 處理並以 ai.status 呈現
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
            getSourceFingerprint: () => bg('reconcile', () => getSourceMonthlyFingerprint({ keyOpts })),
            checkHealth: () => bg('quick_check', () => ({ ok: db.pragma('quick_check', { simple: true }) === 'ok' })),
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
          const scan = await bg('unsent_scan', () => scanRecentUnsent(3, {
            db, signal,
            fetchWindow: async (sinceMs) => ({ messages: await line!.getMessagesSince(sinceMs, { limit: 5000 }) }),
            fetchImportBatch: importReady ? line!.getLineImportBatch : undefined,
            commitImportBatch: importReady ? (batch) => commitLineImportBatch(db, batch, UNKNOWN_IDENTITY) : undefined
          })).catch((error) => {
            log(`[unsent-scan] failed: ${error instanceof Error ? error.name : 'unknown'}`)
            return null
          })
          if (scan && (scan.unsentMarked || scan.unsentInserted)) {
            hub.publish('messages-persisted', {
              chatIds: scan.unsentChatIds,
              inserted: scan.unsentInserted,
              updated: scan.unsentMarked
            })
          }
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
  // 每個 backend 呼叫的開始／結束／耗時／結果碼與事件迴圈卡頓（invokeTrace.ts）。純觀測；寫入失敗只在 recentLog 留一行，不影響呼叫。
  trace = options.trace === false ? null : new InvokeTrace({
    file: join(dataDir, INVOKE_TRACE_RELATIVE_FILE),
    version: options.version,
    onError: (code) => log(`[trace] write_failed ${code}`),
    ...options.trace
  })
  const dispatcher: Dispatcher = new Dispatcher({
    ...options.dispatcher,
    ...(trace ? { trace } : {}),
    getApi: () => {
      if (disposed) throw new Error('Line Todo runtime is disposed')
      return runtime.api
    },
    hub,
    queue,
    ai: aiRuntime,
    residency: () => residency.snapshot(),
    prompts,
    media,
    avatars,
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
      // 持久 snapshot 的計數（reuse／wal／full 次數、複製位元組、最近一次的種類與耗時；沒有 snapshot＝null）與「記憶體裡有沒有已驗證的金鑰」。不含任何路徑或金鑰。
      lineSnapshot: snapshotStore
        ? { ...snapshotStore.stats(), ...(fsCopyStats ? { koffiAsyncCopies: fsCopyStats.async, koffiSyncFallbacks: fsCopyStats.syncFallback } : {}) } as unknown as JsonValue
        : null,
      keyHeld: lineAccess?.keyHeld() ?? false,
      // 頭像本地表的狀態（只有計數與旗標；任何地方都不輸出 MID、locator 或顯示名）。
      avatarStore: {
        enabled: avatarStoreOn, schemaReady: avatarSchemaReady,
        reads: { local: avatarReads.local, fallback: avatarReads.fallback, miss: avatarReads.miss },
        writeThrough: avatarReads.write,
        backfill: backfill ? backfill.status() as unknown as JsonValue : OFF_STATUS as unknown as JsonValue
      },
      appDb: appDbInfo(appDb),
      extract: { ...queue.stats(), combined: queue.combinedStats() },
      review: review.status() as unknown as JsonValue,
      ai: aiStatus() as unknown as JsonValue,
      residency: residency.snapshot() as unknown as JsonValue,
      media: media.stats() as unknown as JsonValue,
      events: hub.stats(),
      dispatcher: dispatcher.stats(),
      recentLog: [...recentLog]
    })
  })

  try {
    if (options.autoStart !== false) {
      await runtime.start()
      backfill?.start()
      mediaIndex?.start()
      // 背景抽取：backend 啟動後就開始（不等看板）。沒有 host.ai（單元測試）就不啟動，項目留在佇列。
      // 真實 LINE 來源時與第一輪 poll 一樣延後到 activate() 回傳之後（boot-ack 先送出，host 才收得到我們對 host.ai 的第一個呼叫）。
      if (options.hostAi) {
        if (startupDelayMs > 0) {
          workerStartTimer = setTimeout(() => { workerStartTimer = null; if (!disposed) worker?.start() }, startupDelayMs)
          workerStartTimer.unref?.()
        } else worker?.start()
      }
    }
  } catch (error) {
    disposed = true
    keyGuard.cancel()
    await backfill?.dispose()
    await mediaIndex?.dispose()
    void snapshotStore?.close(0)
    lineAccess?.forgetKey()
    for (const off of unsubscribers) off()
    offResidency()
    residency.dispose()
    dispatcher.dispose()
    trace?.stop()
    hub.dispose()
    if (workerStartTimer) clearTimeout(workerStartTimer)
    worker?.stop()
    aiPort.stop()
    offAiStatus()
    queue.dispose()
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
      offResidency()
      residency.dispose()
      for (const off of unsubscribers) { try { off() } catch { /* 已解除 */ } }
      // 先停 worker 與 AI port（佇列中的 AI 工作以 backend_stopped 失敗、等待中的睡眠醒來）；已送出的 host.ai.complete 無法中止，回來後結果被丟棄，訊息維持未處理。
      if (workerStartTimer) { clearTimeout(workerStartTimer); workerStartTimer = null }
      worker?.stop()
      aiPort.stop()
      offAiStatus()
      hub.dispose()
      queue.dispose()
      review.dispose()
      try {
        // 回填先停（它用 app DB 與 snapshot）：進行中的切片收尾、放掉 lease，之後不再存取任何 DB。最多等 DISPOSE_IDLE_WAIT_MS（它可能正等 snapshot 更新）。
        // 圖片索引同理：用 app DB 的切片收尾後才關 runtime（dispose 之後不再列任何目錄、不再存取任何 DB）。
        await Promise.race([Promise.all([backfill?.dispose(), mediaIndex?.dispose()]), new Promise<void>((resolve) => { setTimeout(resolve, DISPOSE_IDLE_WAIT_MS).unref?.() })])
        await runtime.dispose()
        // 讓 snapshot store 靜止：不再發 lease、不再換檔、不再寫 meta（進行中的複製無法中止，複製完會發現已關閉而放棄換檔）；記憶體裡的金鑰一併忘掉。
        const closing = snapshotStore?.close(DISPOSE_IDLE_WAIT_MS)
        // 讓進行中的 poll／掃描收尾（刪掉暫存快照、關 handle）；等不到就放手，殘留的快照目錄會在下次啟動時清掉。
        await Promise.race([Promise.all([watcher?.idle(), keyGuard.idle(), closing]), new Promise<void>((resolve) => { setTimeout(resolve, DISPOSE_IDLE_WAIT_MS).unref?.() })])
        lineAccess?.forgetKey()
      } finally {
        // 最後才寫 `stop`：被 dispose 喚醒的長輪詢等呼叫的 `end` 都已落檔，檔尾是 `stop` 就代表正常結束。
        trace?.stop()
      }
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
