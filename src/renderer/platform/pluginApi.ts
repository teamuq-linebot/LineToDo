/**
 * pluginApi.ts — `createPluginLineTodoApi()`：把 `LineTodoApi` 轉成 TeamUQ 1.6.8 外掛 view 的
 * `window.tuqPlugin.backend.call('api.invoke', { path, args })`（設計 v2 §4.5、§4.6、§7 Phase 3）。
 *
 * - request/response 方法：一律 `api.invoke`（backend dispatcher 的允許清單；`pluginTransport.ts` 處理 64 KiB 分段、長時間 job、併發上限）。
 * - `on*` 訂閱：`pluginEvents.ts` 的事件長輪詢（Phase 2 的主傳輸；view 對自己的 backend 只有 `backend.call`）。
 * - 外掛版不提供的功能（設計 v2 §7.4 與使用者決策）：
 *     driver_post（填入 LINE）  → `api.driver` 不存在（UI 本來就只在 `api.driver` 存在時提供）
 *     CLI／自訂 AI 端點／API 金鑰 → backend 回 `unsupported_in_plugin`，這裡轉成該方法型別允許的失敗結果 `{ok:false, error:'unsupported_in_plugin: …'}`
 *     saveAs／open／openDataFolder／openOriginal → 同上
 *   `PLUGIN_CAPABILITIES`（capabilities.ts）告訴 UI 隱藏這些入口；`api.plugin.invoke()` 是原始通道，遇到 unsupported 會 throw `PluginUnsupportedError`。
 * - AI（草擬回覆、誤判分析、群組議題分析）：backend 不打 LLM（`route:'ui_ai_chat'`），由 UI 端經 `window.tuqPlugin.ai` 完成。
 *   Phase 4 的 orchestrator 以 `options.ai`（`PluginAiPort`）接上；沒接時回「尚未接上」的明確失敗，不會假裝成功。
 * - 媒體：`media.assetUrl(msgId)` → `media.prepare`（backend 解密寫進 dataDir）→ `window.tuqPlugin.assets.url(path)`。
 *
 * 不依賴 React／DOM（node:test 以 mock `window.tuqPlugin` 驗證）。
 */
import type {
  DraftReplyResult, LineTodoApi, NotMineAnalysisResult, PipelineStatus, ProviderHealth, QwenTestResult, ReviewLastDaysResult
} from '../../shared/api'
import { PLUGIN_CAPABILITIES, type HostCapabilities } from './capabilities'
import { PluginEventPump, type PluginEventPumpOptions, type PluginEventType } from './pluginEvents'
import { PluginTransport, PluginUnsupportedError, type TuqPluginHost } from './pluginTransport'

export { PluginApiError, PluginBackendError, PluginUnsupportedError } from './pluginTransport'
export type { TuqPluginHost } from './pluginTransport'
export { PLUGIN_CAPABILITIES } from './capabilities'

type GroupTopicsApi = NonNullable<LineTodoApi['groupTopics']>

/** Phase 4 的接點：UI 端經 `window.tuqPlugin.ai`（ai:chat）完成 backend 不做的 AI 呼叫。任何一項缺省＝回明確的「尚未接上」。 */
export interface PluginAiPort {
  draftReply?(todoId: string): Promise<DraftReplyResult>
  analyzeNotMine?(feedbackId: string): Promise<NotMineAnalysisResult>
  analyzeGroupTopics?(chatId: string): ReturnType<GroupTopicsApi['analyze']>
}

export interface PluginApiOptions {
  /** `window.tuqPlugin`（或測試用的 mock）。 */
  host: TuqPluginHost
  ai?: PluginAiPort
  /**
   * UI 端的抽取 orchestrator（Phase 4）是否在運作。`pipeline.reviewLastDays` 要等 UI 經 `extract.pull／commit` 把 AI 結果送回 backend 才會完成；
   * 沒有 orchestrator 時它會一直等（backend 15 分鐘逾時），所以沒接上就立刻回「尚未接上」的失敗結果，不呼叫 backend。預設 false。
   */
  extractionConnected?: boolean
  /** 同時進行中的一般請求上限（host 上限 8）。預設 6。 */
  maxConcurrentCalls?: number
  jobPollWaitMs?: number
  events?: Pick<PluginEventPumpOptions, 'waitMs' | 'idleStopMs' | 'backoffBaseMs' | 'backoffMaxMs' | 'minLoopMs' | 'onDiagnostic'>
}

/** Phase 4 orchestrator 用的 AI 抽取通道（backend `ExtractQueue` 的供料／收料）。 */
export interface PluginExtractApi {
  /** system prompt（不隨每個項目重送）與 sha256、單項 user payload 的字數上限。 */
  system(): Promise<{ system: string; sha256: string; chars: number; maxUserChars: number }>
  pull(options?: { max?: number; leaseMs?: number }): Promise<{ items: Array<Record<string, unknown>>; [key: string]: unknown }>
  commit(results: Array<{ itemId: string; ok: boolean; result?: unknown; failCode?: string; retryAfterMs?: number }>): Promise<{ results: Array<Record<string, unknown>> }>
  stats(): Promise<Record<string, unknown>>
  /** 有新的待抽取項目時通知（事件 `extract-pending`）。 */
  onPending(cb: (info: { pending: number }) => void): () => void
}

export interface PluginExtras {
  readonly host: 'plugin'
  readonly capabilities: HostCapabilities
  /** 原始通道：unsupported 時 throw `PluginUnsupportedError`；成功回 backend 的 `value`。 */
  invoke(path: string, args?: readonly unknown[]): Promise<unknown>
  extract: PluginExtractApi
  /** backend 診斷資訊（`backend.info`）。 */
  info(): Promise<Record<string, unknown>>
  /** 事件輪詢的狀態（測試／診斷）。 */
  eventsStats(): ReturnType<PluginEventPump['stats']>
}

export interface PluginLineTodoApi extends LineTodoApi {
  /** 外掛版沒有 driver_post。 */
  driver: undefined
  plugin: PluginExtras
  /** 卸載：停止事件輪詢（並關閉 session），之後的請求一律 reject `disposed`。 */
  dispose(): void
}

/** 沒接 ai:chat 時的明確失敗訊息（UI 直接顯示）。 */
export const PLUGIN_AI_NOT_CONNECTED = 'unsupported_in_plugin: 這項 AI 功能由 TeamUQ 的 ai:chat 提供，外掛尚未接上（Phase 4）'

function reviewNotConnected(days: number | undefined): ReviewLastDaysResult {
  const window = typeof days === 'number' && days > 0 ? Math.floor(days) : 7
  return {
    ok: false, hasApiKey: true, days: window, sinceMs: Date.now() - window * 86_400_000, newMsgs: 0, chatsSeen: 0, chatsProcessed: 0, chatsSkippedNoise: 0,
    chatsFailed: 0, todosCreated: 0, todosMerged: 0, todosResolvedDone: 0, todosSuggestedDone: 0, createdIds: [], resolvedIds: [], updatedIds: [], note: PLUGIN_AI_NOT_CONNECTED
  }
}

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
  const transport = new PluginTransport({ host, maxConcurrentCalls: options.maxConcurrentCalls, jobPollWaitMs: options.jobPollWaitMs })
  const ai = options.ai ?? {}

  const call = <T>(path: string, ...args: unknown[]): Promise<T> => transport.invoke(path, args) as Promise<T>

  // ── 事件 ──
  const pump = new PluginEventPump({
    ...options.events,
    call: (path, args) => transport.invokeUnlimited(path, args),
    // 重新同步（gap／backend 重啟／payload 溢出）：重拉兩個「狀態」事件；todos／messages 由 pump 發空事件讓看板整個重載。
    resync: async () => {
      const out: Array<[PluginEventType, unknown]> = []
      const [pipeline, line] = await Promise.allSettled([call<PipelineStatus>('pipeline.status'), call('line.status')])
      if (pipeline.status === 'fulfilled') out.push(['pipeline-status', pipeline.value])
      if (line.status === 'fulfilled') out.push(['line-status', line.value])
      return out
    }
  })
  const on = <T>(type: PluginEventType) => (cb: (payload: T) => void): (() => void) => pump.subscribe(type, (payload) => cb(payload as T))

  // ── 媒體 URL（成功的才快取；not_cached 之類之後可能成功）──
  const assetUrls = new Map<string, string>()
  const assetUrl = async (msgId: string): Promise<string | null> => {
    const known = assetUrls.get(msgId)
    if (known) return known
    try {
      const prepared = (await call<{ path?: unknown }>('media.prepare', msgId))
      if (!prepared || typeof prepared.path !== 'string') return null
      const url = host.assets.url(prepared.path)
      assetUrls.set(msgId, url)
      return url
    } catch {
      return null
    }
  }

  const extract: PluginExtractApi = {
    system: () => call('extract.system'),
    pull: (opts) => call('extract.pull', opts ?? {}),
    commit: (results) => call('extract.commit', { results }),
    stats: () => call('extract.stats'),
    onPending: on<{ pending: number }>('extract-pending')
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
        list: (includeBlocked) => call('db.chats.list', includeBlocked),
        get: (chatId) => call('db.chats.get', chatId),
        setBlocked: (chatId, blocked, reason) => call('db.chats.setBlocked', chatId, blocked, reason),
        blockAndClear: (chatId) => call('db.chats.blockAndClear', chatId),
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
        draftReply: (id) => (ai.draftReply ? ai.draftReply(id) : Promise.resolve({ error: PLUGIN_AI_NOT_CONNECTED })),
        moveColumn: (id, toColumn) => call('db.todos.moveColumn', id, toColumn),
        markNotMine: (id, reasonCode, note) => call('db.todos.markNotMine', id, reasonCode, note),
        listNotMine: () => call('db.todos.listNotMine'),
        listNotMineCorrections: () => call('db.todos.listNotMineCorrections'),
        getNotMineReview: (feedbackId) => call('db.todos.getNotMineReview', feedbackId),
        analyzeNotMine: (feedbackId) => (ai.analyzeNotMine ? ai.analyzeNotMine(feedbackId) : Promise.resolve({ ok: false, reason: PLUGIN_AI_NOT_CONNECTED })),
        reopenNotMine: (feedbackId) => call('db.todos.reopenNotMine', feedbackId),
        applyNotMineCorrection: (feedbackId, condition, effect) => call('db.todos.applyNotMineCorrection', feedbackId, condition, effect),
        setNotMineCorrectionEnabled: (correctionId, enabled) => call('db.todos.setNotMineCorrectionEnabled', correctionId, enabled)
      },
      onMessagesPersisted: on('messages-persisted')
    },
    pipeline: {
      status: () => call('pipeline.status'),
      loadStats: () => call('pipeline.loadStats'),
      runOnce: () => call('pipeline.runOnce'),
      reviewLastDays: (days) => (options.extractionConnected ? call('pipeline.reviewLastDays', days) : Promise.resolve(reviewNotConnected(days))),
      backfillMediaKeys: (days) => call('pipeline.backfillMediaKeys', days),
      setRunning: (running) => call('pipeline.setRunning', running),
      testQwen: () => orUnsupported<QwenTestResult>(() => call('pipeline.testQwen'), (e) => ({ ok: false, error: unsupportedText(e) })),
      testAiProvider: () => orUnsupported<ProviderHealth>(() => call('pipeline.testAiProvider'), (e) => ({ ok: false, summary: unsupportedText(e), code: 'invalid_config', details: {} })),
      onRun: on('pipeline-run'),
      onStatus: on('pipeline-status'),
      onTodosChanged: on('todos-changed'),
      onBackfillProgress: on('backfill-progress'),
      onReconcileProgress: on('reconcile-progress')
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
      assetUrl
    },
    groupTopics: {
      setEnabled: (chatId, enabled) => call('groupTopics.setEnabled', chatId, enabled),
      setCrossChatEnabled: (chatId, enabled) => call('groupTopics.setCrossChatEnabled', chatId, enabled),
      crossChatEnabled: (chatId) => call('groupTopics.crossChatEnabled', chatId),
      pendingCount: (chatId) => call('groupTopics.pendingCount', chatId),
      list: (chatId) => call('groupTopics.list', chatId),
      linkCandidates: (chatId) => call('groupTopics.linkCandidates', chatId),
      analyze: (chatId) => (ai.analyzeGroupTopics ? ai.analyzeGroupTopics(chatId) : Promise.resolve({ ok: false, reason: 'unsupported_in_plugin' })),
      todoRefs: (topicId) => call('groupTopics.todoRefs', topicId)
    },
    driver: undefined,
    plugin: {
      host: 'plugin',
      capabilities: PLUGIN_CAPABILITIES,
      invoke: (path, args = []) => transport.invoke(path, args),
      extract,
      info: () => call('backend.info'),
      eventsStats: () => pump.stats()
    },
    dispose: () => {
      pump.dispose() // 先停輪詢（同步送出 events.close），再關傳輸
      transport.close()
    }
  }
  return api
}
