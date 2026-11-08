/**
 * pluginApi.ts — `createPluginLineTodoApi()`：把 `LineTodoApi` 轉成 TeamUQ 外掛 view 的
 * `window.tuqPlugin.backend.call(<方法組>, { path, args })`（設計 v2 §4.5、§4.6、§7 Phase 3；G-07 依命名空間分組）。
 *
 * - request/response 方法：方法名稱是路徑所屬的命名空間（`src/shared/pluginWire.ts` 的 `BACKEND_METHOD_GROUPS`，也是 manifest 的
 *   `backendMethods`），backend dispatcher 再檢查一次路徑允許清單；`pluginTransport.ts` 處理 64 KiB 分段、長時間 job、併發上限與連線狀態。
 * - `on*` 訂閱：`pluginEvents.ts` 的事件長輪詢（Phase 2 的主傳輸；view 對自己的 backend 只有 `backend.call`）。
 * - 外掛版不提供的功能（設計 v2 §7.4 與使用者決策）：
 *     driver_post（填入 LINE）  → `api.driver` 不存在（UI 本來就只在 `api.driver` 存在時提供）
 *     CLI／自訂 AI 端點／API 金鑰 → backend 回 `unsupported_in_plugin`，這裡轉成該方法型別允許的失敗結果 `{ok:false, error:'unsupported_in_plugin: …'}`
 *     saveAs／open／openDataFolder／openOriginal → 同上
 *   `PLUGIN_CAPABILITIES`（capabilities.ts）告訴 UI 隱藏這些入口；`api.plugin.invoke()` 是原始通道，遇到 unsupported 會 throw `PluginUnsupportedError`。
 * - AI（抽取、草擬回覆、誤判分析、群組議題分析、prompt 修正）：0.2.0 起全部在 backend 經 TeamUQ 的 `context.host.ai.complete` 完成，
 *   view 不再使用 TeamUQ 的 view 端 AI 橋接（看板沒開也會整理）。這三項 AI 功能就是一般的 backend 呼叫（`db.todos.draftReply` 等）；AI 不可用
 *   （沒登入、授權被關…）時 backend 回明確的失敗原因，這裡轉成該方法型別允許的失敗結果，不會假裝成功。`ai.status` 是狀態列的資料來源。
 * - 媒體：`media.assetUrl(msgId)` → `media.prepare`（backend 解密寫進 dataDir）→ `window.tuqPlugin.assets.url(path)`。
 *
 * 不依賴 React／DOM（node:test 以 mock `window.tuqPlugin` 驗證）。
 */
import type {
  AvatarRequestOptions, AvatarUrlBatchDTO, DraftReplyResult, LineTodoApi, LongTaskStatusView, NotMineAnalysisResult, PipelineStatus, ProviderHealth, QwenTestResult
} from '../../shared/api'
import { PLUGIN_CAPABILITIES, type HostCapabilities } from './capabilities'
import { normalizeHostAiSelection, type HostAiSelection } from '../../shared/hostAi'
import type { AiStatus } from '../../shared/aiStatus'
import { parseResidencyView } from '../../shared/residency'
import type { ResidencySnapshot } from '../../shared/residency'
import type { ChatPromptSummary, PromptSuggestion } from '../../shared/promptSettings'
import { PluginEventPump, type PluginEventPumpOptions, type PluginEventType } from './pluginEvents'
import { PluginApiError, PluginTransport, PluginUnsupportedError, type BackendDiagnostics, type BackendLink, type BackendPhase, type BusyRetryOptions, type InvokeOptions, type TransportTimeouts, type TuqPluginHost } from './pluginTransport'

/** 已知頭像／名稱的保留時間（過了才會再問 backend 一次，讓換頭像最終會更新）；沒有頭像的結果只保留較短時間，避免對同一批 id 反覆查。 */
const AVATAR_KNOWN_TTL_MS = 5 * 60_000
const AVATAR_UNKNOWN_TTL_MS = 60_000
const AVATAR_CACHE_MAX = 4000

export { ACCESS_HOST_CODES, PluginApiError, PluginBackendError, PluginUnsupportedError } from './pluginTransport'
export type { BackendDiagnostics, BackendLink, BackendLinkState, BackendPhase, CallLane, TransportTimeouts, TuqPluginHost } from './pluginTransport'
export { PLUGIN_CAPABILITIES } from './capabilities'

type GroupTopicsApi = NonNullable<LineTodoApi['groupTopics']>

export interface PluginApiOptions {
  /** `window.tuqPlugin`（或測試用的 mock）。 */
  host: TuqPluginHost
  /**
   * 這個 view 同時進行中的 host 呼叫上限，**含事件長輪詢**（manifest 的 `maxSessions` 是 4）。預設 3（長輪詢 1 ＋ 其他 2）；設定 view 用 1 並關掉事件輪詢，
   * 所以兩個 view 同時開著也只有 4。見 pluginTransport.ts 檔頭。
   */
  maxConcurrentCalls?: number
  jobPollWaitMs?: number
  /** host 回忙碌（`plugin_backend_busy`／`plugin_backend_unavailable`）時的退避重試；預設最多 4 次、100 ms 起。 */
  busyRetry?: BusyRetryOptions
  /** 畫面端等 host 回覆的上限（core 10 s、ping 35 s、bulk 15 s…，見 pluginTransport.ts 檔頭）；測試用較小的值覆寫。 */
  timeouts?: TransportTimeouts
  /** ping 送出多久還沒有任何成功回應就判定為「後端啟動中」（預設 1,200 ms）。 */
  startingAfterMs?: number
  events?: Pick<PluginEventPumpOptions, 'waitMs' | 'idleStopMs' | 'backoffBaseMs' | 'backoffMaxMs' | 'accessProbeMs' | 'minLoopMs' | 'onDiagnostic'> & {
    /** false＝不開事件長輪詢（`on*` 訂閱不會收到任何事件）。設定 view 用：它的畫面不依賴即時事件，每次動作後會自己重讀狀態。 */
    enabled?: boolean
  }
}

/** 待抽取佇列的觀測（backend `ExtractQueue`；抽取本身由 backend 的 ExtractWorker 完成，view 只看狀態）。 */
export interface PluginExtractApi {
  stats(): Promise<Record<string, unknown>>
}

export interface PluginExtras {
  readonly host: 'plugin'
  readonly capabilities: HostCapabilities
  /** 原始通道：unsupported 時 throw `PluginUnsupportedError`；成功回 backend 的 `value`。 */
  invoke(path: string, args?: readonly unknown[]): Promise<unknown>
  extract: PluginExtractApi
  /** AI 整理的狀態（backend 的 `ai.status`）。`refresh: true`＝看板剛開啟：忘掉快取、重新探測 TeamUQ 的 AI（授權或登入可能剛處理好）。 */
  aiStatus(options?: { refresh?: boolean }): Promise<AiStatus>
  /** AI 整理的狀態改變時通知（事件 `ai-status`）。 */
  onAiStatus(cb: (status: AiStatus) => void): () => void
  /**
   * 背景執行（`background:resident`）的狀態（backend 的 `backend.residency`，來源是 Core 的 `context.residency`）。`supported:false`＝舊 Core，畫面不顯示背景執行。
   * 畫面端沒有 Core 的 residency API，所以一律經 backend 中繼；backend 回不認得的形狀也當成不支援。
   */
  residency(): Promise<ResidencySnapshot>
  /** 背景執行的狀態改變時通知（事件 `residency`；只有開了事件輪詢的 view 會收到——設定 view 沒有，改在重新聚焦時重讀）。 */
  onResidency(cb: (snapshot: ResidencySnapshot) => void): () => void
  /** backend 診斷資訊（`backend.info`）。 */
  info(): Promise<Record<string, unknown>>
  /** 「回顧最近 N 天」的狀態：進行中／已完成 N/M／可續跑（`review.status`；`summary` 是給使用者看的一句話）。 */
  reviewStatus(): Promise<{ running: boolean; state: 'idle' | 'running' | 'done' | 'paused' | 'incomplete' | 'interrupted'; chatsDone: number; chatsTotal: number; resumableMessages: number; summary: string; [key: string]: unknown }>
  /** 對 backend 的連線狀態（G-03）：`revoked`＝使用者撤銷了 backend:invoke／停用／移除外掛；`unavailable`＝backend 沒起來或當掉。 */
  backendLink(): BackendLink
  /** 連線狀態改變時通知（外掛畫面的狀態列用）。 */
  onBackendLink(listener: (link: BackendLink) => void): () => void
  /**
   * 後端階段：`starting`（後端啟動中）／`connecting`（連線中）／`ready`／`timeout`（有讀取逾時）／`error`（revoked 或 unavailable）。
   * 畫面據此顯示一行狀態，不必猜 host 的內部狀態；規則見 pluginTransport.ts 檔頭。
   */
  backendPhase(): BackendPhase
  /** 階段改變時通知。 */
  onBackendPhase(listener: (phase: BackendPhase) => void): () => void
  /** 診斷快照（按需展開的「診斷」用）：還沒結束的呼叫已等待多久、最近一次失敗。 */
  backendDiagnostics(): BackendDiagnostics
  /** 事件輪詢的狀態（測試／診斷）。 */
  eventsStats(): ReturnType<PluginEventPump['stats']>
  /** 傳輸層的併發統計（測試／診斷）：目前在飛／排隊、歷來最大同時在飛、忙碌重試次數。 */
  transportStats(): ReturnType<PluginTransport['stats']>
}

export interface PluginLineTodoApi extends LineTodoApi {
  /** 外掛版沒有 driver_post。 */
  driver: undefined
  plugin: PluginExtras
  /** 卸載：停止事件輪詢（並關閉 session），之後的請求一律 reject `disposed`。 */
  dispose(): void
}

/** backend `media.ts` 的 `MEDIA_INDEX_BUILDING_TOKEN`（兩邊以測試對齊）：`not_cached` 的訊息含它＝LINE Cache 索引還在建立。 */
export const MEDIA_INDEX_BUILDING_TOKEN = 'index_building'

const unsupportedText = (error: PluginUnsupportedError): string => `unsupported_in_plugin: ${error.detail || error.path}`

/** unsupported → 該方法型別允許的失敗結果；其他錯誤照常 reject。 */
async function orUnsupported<T>(run: () => Promise<unknown>, fallback: (error: PluginUnsupportedError) => T): Promise<T> {
  try {
    return (await run()) as T
  } catch (error) {
    if (error instanceof PluginUnsupportedError) return fallback(error)
    throw error
  }
}

export function createPluginLineTodoApi(options: PluginApiOptions): PluginLineTodoApi {
  const { host } = options
  if (!host || !host.backend || typeof host.backend.call !== 'function') throw new TypeError('createPluginLineTodoApi needs window.tuqPlugin.backend.call')
  const transport = new PluginTransport({ host, maxConcurrentCalls: options.maxConcurrentCalls, jobPollWaitMs: options.jobPollWaitMs, busyRetry: options.busyRetry, timeouts: options.timeouts, startingAfterMs: options.startingAfterMs })
  /** AI 功能的 backend 呼叫；失敗（AI 不可用、逾時、被拒）轉成該方法型別允許的失敗結果。 */
  const runAi = async <T>(path: string, args: unknown[], failed: (message: string) => T): Promise<T> => {
    try {
      return (await transport.invoke(path, args)) as T
    } catch (error) {
      if (error instanceof PluginApiError) return failed(error.message)
      throw error
    }
  }

  const call = <T>(path: string, ...args: unknown[]): Promise<T> => transport.invoke(path, args) as Promise<T>

  // ── 事件 ──
  const { enabled: eventsEnabled = true, ...pumpOptions } = options.events ?? {}
  const pump = new PluginEventPump({
    ...pumpOptions,
    call: (path, args) => transport.invokeEvents(path, args),
    // 重新同步（gap／backend 重啟／payload 溢出）：重拉兩個「狀態」事件；todos／messages 由 pump 發空事件讓看板整個重載。
    resync: async () => {
      const out: Array<[PluginEventType, unknown]> = []
      const [pipeline, line, residency] = await Promise.allSettled([call<PipelineStatus>('pipeline.status'), call('line.status'), call('backend.residency')])
      if (pipeline.status === 'fulfilled') out.push(['pipeline-status', pipeline.value])
      if (line.status === 'fulfilled') out.push(['line-status', line.value])
      if (residency.status === 'fulfilled') out.push(['residency', residency.value])
      return out
    }
  })
  const on = <T>(type: PluginEventType) => (cb: (payload: T) => void): (() => void) => (eventsEnabled ? pump.subscribe(type, (payload) => cb(payload as T)) : () => undefined)
  let refiningPrompt = false

  // ── 媒體 URL（成功的才快取；not_cached 之類之後可能成功）──
  // backend 的 not_cached 訊息帶 MEDIA_INDEX_BUILDING_TOKEN＝LINE Cache 索引還在建立（圖片可能已經在 Cache 裡，只是索引還沒看到）；沒帶＝LINE 還沒下載。
  const assetUrls = new Map<string, string>()
  const assetLookup = async (msgId: string): Promise<{ url: string | null; indexing: boolean }> => {
    const known = assetUrls.get(msgId)
    if (known) return { url: known, indexing: false }
    try {
      const prepared = (await call<{ path?: unknown }>('media.prepare', msgId))
      if (!prepared || typeof prepared.path !== 'string') return { url: null, indexing: false }
      const url = host.assets?.url(prepared.path)
      if (!url) return { url: null, indexing: false }
      assetUrls.set(msgId, url)
      return { url, indexing: false }
    } catch (error) {
      return { url: null, indexing: error instanceof PluginApiError && error.code === 'not_cached' && error.message.includes(MEDIA_INDEX_BUILDING_TOKEN) }
    }
  }
  const assetUrl = async (msgId: string): Promise<string | null> => (await assetLookup(msgId)).url

  // ── 頭像（view 端把關：去重、已知結果快取、合併進行中的相同請求、不再需要時丟掉尚未送出的請求）──
  // 頭像在 backend 很貴（每次讀來源資料庫；實測 media.avatar.prepare* 平均 2.5 s），而 view 的 host 呼叫預算只有 3 格、先進先出：
  // 重複或過期的頭像請求不能再擠在使用者真正要等的 db.chats.list／line.status／messages.recent 前面。
  // 已送出、執行中的慢頭像呼叫收不回來，所以頭像走 pluginTransport 的 bulk 通道（同時送出的上限見該檔檔頭：預算 3 格時 1 格，其餘名額永遠留給 core／events），
  // 超過上限的頭像批次在 bulk 佇列等（不佔 core 名額，abort 也收得回來）。backend 端先查 app DB 的本地頭像（很快），所以這裡的快取只擋「重複的相同請求」，
  // 不能擋住持久化頭像的更新：成功的結果 5 分鐘、沒有結果的 1 分鐘後就會再問 backend 一次。
  const rawAvatarBatch = async (
    path: 'media.avatar.prepareChats' | 'media.avatar.prepareMessages',
    args: unknown[],
    invokeOptions?: InvokeOptions
  ): Promise<AvatarUrlBatchDTO & { ok: boolean }> => {
    try {
      const prepared = (await transport.invoke(path, args, invokeOptions)) as { paths?: unknown; names?: unknown } | null | undefined
      const urls: Record<string, string> = {}
      if (prepared?.paths && typeof prepared.paths === 'object') {
        for (const [key, value] of Object.entries(prepared.paths as Record<string, unknown>)) {
          if (typeof value !== 'string') continue
          const url = host.assets?.url(value)
          if (url) urls[key] = url
        }
      }
      const names: Record<string, string> = {}
      if (prepared?.names && typeof prepared.names === 'object') {
        for (const [key, value] of Object.entries(prepared.names as Record<string, unknown>)) {
          if (typeof value === 'string' && value.trim()) names[key] = value
        }
      }
      return { ok: true, urls, names }
    } catch {
      return { ok: false, urls: {}, names: {} }
    }
  }

  interface AvatarEntry { url: string | null; name: string | null; expiresAt: number }
  interface AvatarBatch {
    readonly controller: AbortController
    readonly keys: readonly string[]
    started: boolean
    refs: number
    result: Promise<AvatarUrlBatchDTO | null>
  }
  const avatarCache = new Map<string, AvatarEntry>()
  const avatarInflight = new Map<string, AvatarBatch>()

  const startAvatarBatch = (path: 'media.avatar.prepareChats' | 'media.avatar.prepareMessages', lead: unknown[], scope: string, ids: string[]): AvatarBatch => {
    const keys = ids.map((id) => `${scope}\u0000${id}`)
    const controller = new AbortController()
    const batch: AvatarBatch = { controller, keys, started: false, refs: 0, result: Promise.resolve(null) }
    batch.result = rawAvatarBatch(path, [...lead, ids], { signal: controller.signal, onStart: () => { batch.started = true } }).then((outcome) => {
      for (const key of keys) if (avatarInflight.get(key) === batch) avatarInflight.delete(key)
      if (!outcome.ok) return null // 失敗與取消都不記：之後仍可重試
      const now = Date.now()
      ids.forEach((id, index) => {
        const url = outcome.urls[id] ?? null
        const name = outcome.names[id] ?? null
        avatarCache.set(keys[index], { url, name, expiresAt: now + (url || name ? AVATAR_KNOWN_TTL_MS : AVATAR_UNKNOWN_TTL_MS) })
      })
      while (avatarCache.size > AVATAR_CACHE_MAX) avatarCache.delete(avatarCache.keys().next().value as string)
      return { urls: outcome.urls, names: outcome.names }
    })
    for (const key of keys) avatarInflight.set(key, batch)
    return batch
  }

  /** 沒有任何等待者、也還沒送出的批次：中止並從進行中表移除（新請求不會再合併進一個已經死掉的批次）。 */
  const releaseAvatarBatch = (batch: AvatarBatch): void => {
    batch.refs -= 1
    if (batch.refs > 0 || batch.started) return
    batch.controller.abort()
    for (const key of batch.keys) if (avatarInflight.get(key) === batch) avatarInflight.delete(key)
  }

  const avatarUrlBatch = async (
    path: 'media.avatar.prepareChats' | 'media.avatar.prepareMessages',
    lead: unknown[],
    scope: string,
    ids: readonly string[],
    options?: AvatarRequestOptions
  ): Promise<AvatarUrlBatchDTO> => {
    const empty = (): AvatarUrlBatchDTO => ({ urls: {}, names: {} })
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      const { urls, names } = await rawAvatarBatch(path, [...lead, ids])
      return { urls, names }
    }
    const signal = options?.signal
    if (signal?.aborted) return empty()
    const wanted = [...new Set(ids)]
    const out = empty()
    const batches = new Set<AvatarBatch>()
    const missing: string[] = []
    const now = Date.now()
    for (const id of wanted) {
      const key = `${scope}\u0000${id}`
      const known = avatarCache.get(key)
      if (known && known.expiresAt > now) {
        if (known.url) out.urls[id] = known.url
        if (known.name) out.names[id] = known.name
        continue
      }
      const flying = avatarInflight.get(key)
      if (flying) batches.add(flying)
      else missing.push(id)
    }
    if (missing.length > 0) batches.add(startAvatarBatch(path, lead, scope, missing))
    for (const batch of batches) batch.refs += 1
    const settled = Promise.all([...batches].map((batch) => batch.result))
    let results: Array<AvatarUrlBatchDTO | null>
    if (signal) {
      let onAbort = (): void => undefined
      const aborted = new Promise<null>((resolve) => { onAbort = () => resolve(null); signal.addEventListener('abort', onAbort, { once: true }) })
      const raced = await Promise.race([settled, aborted])
      signal.removeEventListener('abort', onAbort)
      if (raced === null) {
        for (const batch of batches) releaseAvatarBatch(batch)
        return empty()
      }
      results = raced
    } else results = await settled
    const wantedSet = new Set(wanted)
    for (const result of results) {
      if (!result) continue
      for (const [key, value] of Object.entries(result.urls)) if (wantedSet.has(key)) out.urls[key] = value
      for (const [key, value] of Object.entries(result.names)) if (wantedSet.has(key)) out.names[key] = value
    }
    return out
  }

  const extract: PluginExtractApi = {
    stats: () => call('extract.stats')
  }

  const api: PluginLineTodoApi = {
    ping: () => call('ping'),
    messages: { recent: () => call('messages.recent') },
    line: {
      status: () => call('line.status'),
      setRunning: (running) => call('line.setRunning', running),
      onMessage: on('line-message'),
      onStatus: on('line-status')
    },
    db: {
      messages: {
        list: (query) => call('db.messages.list', query),
        recentByChat: (chatId, limit) => call('db.messages.recentByChat', chatId, limit),
        byChatSince: (chatId, sinceMs) => call('db.messages.byChatSince', chatId, sinceMs),
        count: (chatId) => call('db.messages.count', chatId)
      },
      chats: {
        list: () => call('db.chats.list'),
        get: (chatId) => call('db.chats.get', chatId),
        todoExtractEnabled: (chatId) => call('db.chats.todoExtractEnabled', chatId),
        setTodoExtractEnabled: (chatId, enabled) => call('db.chats.setTodoExtractEnabled', chatId, enabled),
        listPrefs: () => call('db.chats.listPrefs'),
        setPinned: (chatId, pinned) => call('db.chats.setPinned', chatId, pinned),
        setIgnored: (chatId, ignored) => call('db.chats.setIgnored', chatId, ignored),
        setHidden: (chatId, hidden) => call('db.chats.setHidden', chatId, hidden),
        addIgnoreKeyword: (chatId, keyword) => call('db.chats.addIgnoreKeyword', chatId, keyword),
        removeIgnoreKeyword: (chatId, keyword) => call('db.chats.removeIgnoreKeyword', chatId, keyword),
        openOriginal: (chatId) => orUnsupported(() => call('db.chats.openOriginal', chatId), (e) => ({ ok: false, error: unsupportedText(e) }))
      },
      todos: {
        list: (query) => call('db.todos.list', query),
        get: (id) => call('db.todos.get', id),
        openByChat: (chatId) => call('db.todos.openByChat', chatId),
        updateStatus: (id, status) => call('db.todos.updateStatus', id, status),
        update: (id, patch) => call('db.todos.update', id, patch),
        draftReply: (id) => runAi<DraftReplyResult>('db.todos.draftReply', [id], (message) => ({ error: message })),
        moveColumn: (id, toColumn) => call('db.todos.moveColumn', id, toColumn),
        markNotMine: (id, reasonCode, note) => call('db.todos.markNotMine', id, reasonCode, note),
        listNotMine: () => call('db.todos.listNotMine'),
        listNotMineCorrections: () => call('db.todos.listNotMineCorrections'),
        getNotMineReview: (feedbackId) => call('db.todos.getNotMineReview', feedbackId),
        analyzeNotMine: (feedbackId) => runAi<NotMineAnalysisResult>('db.todos.analyzeNotMine', [feedbackId], (message) => ({ ok: false, reason: message })),
        reopenNotMine: (feedbackId) => call('db.todos.reopenNotMine', feedbackId),
        applyNotMineCorrection: (feedbackId, condition, effect) => call('db.todos.applyNotMineCorrection', feedbackId, condition, effect),
        setNotMineCorrectionEnabled: (correctionId, enabled) => call('db.todos.setNotMineCorrectionEnabled', correctionId, enabled),
      },
      onMessagesPersisted: on('messages-persisted')
    },
    pipeline: {
      status: () => call('pipeline.status'),
      loadStats: () => call('pipeline.loadStats'),
      runOnce: () => call('pipeline.runOnce'),
      reviewLastDays: (days) => call('pipeline.reviewLastDays', days),
      backfillMediaKeys: (days) => call('pipeline.backfillMediaKeys', days),
      // G-05：回顧與補媒體金鑰由 backend 管理；畫面重新載入、Promise 斷掉（job_not_found）或 backend 重啟後用它查目前的狀態。
      longTaskStatus: () => call<LongTaskStatusView>('tasks.status'),
      setRunning: (running) => call('pipeline.setRunning', running),
      testQwen: () => orUnsupported<QwenTestResult>(() => call('pipeline.testQwen'), (e) => ({ ok: false, error: unsupportedText(e) })),
      testAiProvider: () => orUnsupported<ProviderHealth>(() => call('pipeline.testAiProvider'), (e) => ({ ok: false, summary: unsupportedText(e), code: 'invalid_config', details: {} })),
      onRun: on('pipeline-run'),
      onStatus: on('pipeline-status'),
      onTodosChanged: on('todos-changed'),
      onBackfillProgress: on('backfill-progress'),
      onReconcileProgress: on('reconcile-progress')
    },
    hostAi: {
      prompts: {
        get: () => call('settings.prompt.get'),
        save: (prompt, expectedRevision) => call('settings.prompt.save', { prompt, expectedRevision }),
        reset: (expectedRevision) => call('settings.prompt.reset', { expectedRevision }),
        saveName: (myName, expectedNameRevision) => call('settings.prompt.saveName', { myName, expectedNameRevision }),
        refine: async (request) => {
          if (refiningPrompt) throw new Error('prompt_busy')
          refiningPrompt = true
          try {
            return await call<PromptSuggestion>('settings.prompt.refine', request)
          } finally { refiningPrompt = false }
        }
      },
      chatPrompts: {
        get: (chatId) => call('settings.chatPrompt.get', { chatId }),
        save: (chatId, input, expectedRevision) => call('settings.chatPrompt.save', { chatId, prompt: input.prompt, myName: input.myName, expectedRevision }),
        reset: (chatId, expectedRevision) => call('settings.chatPrompt.reset', { chatId, expectedRevision }),
        list: async () => (await call<{ items: ChatPromptSummary[] }>('settings.chatPrompt.list')).items
      },
      getOptions: () => call('ai.options'),
      getSelection: async () => normalizeHostAiSelection((await call<{ pluginAi?: HostAiSelection }>('settings.get')).pluginAi),
      setSelection: async (selection) => normalizeHostAiSelection((await call<{ pluginAi?: HostAiSelection }>('settings.update', { pluginAi: normalizeHostAiSelection(selection) })).pluginAi)
    },
    settings: {
      get: () => call('settings.get'),
      update: (patch) => call('settings.update', patch),
      setApiKey: (apiKey) => orUnsupported(() => call('settings.setApiKey', apiKey), (e) => ({ ok: false, error: unsupportedText(e) })),
      clearApiKey: () => orUnsupported(() => call('settings.clearApiKey'), () => ({ ok: false })),
      hasSafeStorageKey: () => call('settings.hasSafeStorageKey')
    },
    app: { openDataFolder: () => orUnsupported(() => call('app.openDataFolder'), () => ({ ok: false })) },
    media: {
      open: (msgId) => orUnsupported(() => call('media.open', msgId), (e) => ({ ok: false, error: unsupportedText(e) })),
      saveAs: (msgId) => orUnsupported(() => call('media.saveAs', msgId), (e) => ({ ok: false, error: unsupportedText(e) })),
      assetUrl,
      assetLookup,
      avatarUrls: (chatIds, options) => avatarUrlBatch('media.avatar.prepareChats', [], 'chat', chatIds, options),
      messageAvatarUrls: (chatId, msgIds, options) => avatarUrlBatch('media.avatar.prepareMessages', [chatId], `message:${chatId}`, msgIds, options)
    },
    groupTopics: {
      setEnabled: (chatId, enabled) => call('groupTopics.setEnabled', chatId, enabled),
      pendingCount: (chatId) => call('groupTopics.pendingCount', chatId),
      list: (chatId) => call('groupTopics.list', chatId),
      overview: () => call('groupTopics.overview'),
      analyze: (chatId) => runAi<Awaited<ReturnType<GroupTopicsApi['analyze']>>>('groupTopics.analyze', [chatId], () => ({ ok: false, reason: 'analysis_failed' })),
      todoRefs: (topicId) => call('groupTopics.todoRefs', topicId),
    },
    driver: undefined,
    plugin: {
      host: 'plugin',
      capabilities: PLUGIN_CAPABILITIES,
      invoke: (path, args = []) => transport.invoke(path, args),
      extract,
      aiStatus: (statusOptions) => call<AiStatus>('ai.status', statusOptions?.refresh === true ? { refresh: true } : {}),
      onAiStatus: on<AiStatus>('ai-status'),
      residency: async () => parseResidencyView(await call('backend.residency')),
      onResidency: (cb) => on<unknown>('residency')((payload) => cb(parseResidencyView(payload))),
      info: () => call('backend.info'),
      reviewStatus: () => call('review.status'),
      backendLink: () => transport.link(),
      onBackendLink: (listener) => transport.onLink(listener),
      backendPhase: () => transport.phase(),
      onBackendPhase: (listener) => transport.onPhase(listener),
      backendDiagnostics: () => transport.diagnostics(),
      eventsStats: () => pump.stats(),
      transportStats: () => transport.stats()
    },
    dispose: () => {
      pump.dispose() // 先停輪詢（同步送出 events.close），再關傳輸
      transport.close()
    }
  }
  return api
}
