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
 *   | AI              | provider（http／CLI）+ extractFn    | 無 provider；ExtractQueue 供料/收料（UI 經 ai:chat 抽取）|
 *   | secrets         | Electron safeStorage                | 無（backend 不持有任何 AI 金鑰）                        |
 *   | media/app/driver| Electron shell／dialog／UIA         | unsupported_in_plugin                                 |
 *   | 事件            | webContents.send                    | EventHub（長輪詢 + capability session）                |
 *
 * 本檔不 import electron、不 import child_process／worker_threads、不做網路 I/O。
 */
import { join } from 'node:path'
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
import { configureLineEnginePorts } from '../../main/line/engine/enginePorts'
import type { LineEnginePorts } from '../../main/line/engine/enginePorts'
import { getLineImportBatch, getMessagesSince } from '../../main/line/engine/watchEngine'
import type { LineImportBatch } from '../../main/line/importTypes'
import { LineWatcher } from '../../main/line/watcher'
import { PipelineScheduler } from '../../main/pipeline/scheduler'
import type { LineTodoApi } from '../../shared/api'
import { Dispatcher } from './dispatcher'
import type { DispatcherOptions } from './dispatcher'
import { EventHub } from './eventHub'
import type { EventHubOptions } from './eventHub'
import { ExtractQueue } from './extractQueue'
import type { ExtractQueueOptions } from './extractQueue'
import type { BackendDiagnostics, JsonValue, PluginBackendHandler, SessionChannel, SessionInfo } from './types'

/** backend 不持有任何 AI 金鑰；settings store 只需要這個「不可用」的 secrets。 */
const NO_SECRETS: SettingsSecretStorage = {
  isEncryptionAvailable: () => false,
  encryptString: () => { throw new Error('secrets are not available in the plugin backend') },
  decryptString: () => { throw new Error('secrets are not available in the plugin backend') }
}

export interface PluginBackendOptions {
  pluginId: string
  version: string
  dataDir: string
  /** LINE 引擎 ports（koffi fs + WASM 引擎 + dbDir）。省略＝不改動目前的引擎注入（測試／fake line 用）。 */
  linePorts?: LineEnginePorts
  /** 直接指定 LINE port（fake LINE source）。省略＝用 `LineWatcher` 讀 `linePorts` 指向的 LINE 資料。 */
  line?: LineTodoApplicationPorts['line']
  /** `LineWatcher` 參數（只在沒給 `line` 時使用）。 */
  watcher?: { intervalSec?: number; limit?: number; drainBacklog?: boolean }
  /** app DB 引擎；預設 standalone 的 better-sqlite3（外掛 build 會把它指到 13.0.2）。 */
  appDbEngine?: AppDbEngine
  extract?: Partial<Omit<ExtractQueueOptions, 'db' | 'getConfig'>>
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
  const recentLog: string[] = []
  const log = (line: string): void => { recentLog.push(line.slice(0, 300)); if (recentLog.length > 40) recentLog.shift() }

  // ── LINE port ──
  const engineOptions = { stateFile: join(dataDir, '.watch_json_state'), keyOpts: { cacheFile: join(dataDir, '.linekey') } }
  let watcher: LineWatcher | null = null
  let line = options.line
  if (!line) {
    const w = new LineWatcher({
      intervalSec: options.watcher?.intervalSec ?? 15,
      limit: options.watcher?.limit ?? 500,
      dbWatchEnabled: false, // fs.watch 對 LINE 目錄在權限模型下沒意義：只用間隔輪詢（設計 v2 §4.1.2）
      drainBacklog: options.watcher?.drainBacklog ?? true,
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

  // ── AI 供料/收料 + scheduler ──
  let queue!: ExtractQueue
  let scheduler: PipelineScheduler | null = null
  let appDb: { prepare(sql: string): { get(): unknown } } | null = null
  const unsupported = async (): Promise<{ ok: false; error: string }> => ({ ok: false, error: 'unsupported_in_plugin' })

  const runtime = await createLineTodoRuntime({
    dataDir,
    initialize: () => createLineTodoApplication({
      dataDir,
      dbPath: join(dataDir, 'line-todo.db'),
      appDbEngine: options.appDbEngine ?? createBetterSqlite3AppEngine(),
      onDatabase: (db) => { appDb = db },
      settings,
      pipelineConfig: { getDefaults, getQwenConfig, isProviderConfigured: () => true },
      providers: { resolveProvider: () => null },
      onSettingsChanged: () => { scheduler?.notifySettingsChanged() },
      line,
      // 同步呼叫端（reviewLastDays 回顧）也走 ExtractQueue：同一個 pull/commit 通道，結果直接 resolve 給呼叫端。
      makeExtract: () => (input) => queue.request(input),
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
      app: {
        ping: () => ({ ok: true, ts: Date.now(), version: options.version }),
        openDataFolder: async () => ({ ok: false }),
        openOriginal: unsupported
      }
    })
  })

  // ── 事件橋接 ──
  const unsubscribers = EVENT_BRIDGE.map(([type, subscribe]) => subscribe(runtime.api, (payload) => hub.publish(type, payload)))

  let disposed = false
  const dispatcher: Dispatcher = new Dispatcher({
    ...options.dispatcher,
    getApi: () => {
      if (disposed) throw new Error('Line Todo runtime is disposed')
      return runtime.api
    },
    hub,
    queue,
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
      appDb: appDbInfo(appDb),
      extract: queue.stats(),
      events: hub.stats(),
      dispatcher: dispatcher.stats(),
      recentLog: [...recentLog]
    })
  })

  try {
    if (options.autoStart !== false) await runtime.start()
  } catch (error) {
    disposed = true
    for (const off of unsubscribers) off()
    dispatcher.dispose()
    hub.dispose()
    queue.dispose()
    await runtime.dispose().catch(() => undefined)
    throw error
  }

  const engine = options.linePorts?.sqlite as unknown as { openConnections?: () => number; vfs?: { openFiles(): number; shmNodes(): number } } | undefined

  return {
    call: (method, params) => dispatcher.call(method, params),
    openSession: async (info: SessionInfo, channel: SessionChannel) => hub.attachChannel(info, channel),
    dispose: async () => {
      if (disposed) return
      disposed = true
      // 順序：先關入口（新的 call 拿到 backend_stopped）、解除等待中的長輪詢／同步抽取，再停 runtime（waitForCalls 才不會卡住）。
      dispatcher.dispose()
      for (const off of unsubscribers) { try { off() } catch { /* 已解除 */ } }
      hub.dispose()
      queue.dispose()
      await runtime.dispose()
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
