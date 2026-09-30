import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  LineTodoApi, RawLineMessage, LineBridgeStatus, ChatDTO, MessageDTO, TodoDTO,
  TodoSortBy, TodoSortDirection, MessagesPersistedEvent, PipelineStatus,
  PipelineLoadStats, PipelineRunResult, TodosChangedEvent, BackfillProgress,
  ReconcileProgress, ReviewLastDaysResult, QwenTestResult, ProviderHealth,
  SettingsView, SettingsPatch, DraftReplyResult,
  DriverStatus, DriverPostRequest, DriverPostResult, DriverPostProgress, DriverFollowUpResult
} from '../shared/api'
export * from '../shared/api'

/**
 * preload：以 contextBridge 白名單暴露 main 的能力給 renderer。
 * renderer 永遠不直接碰 ipcRenderer；只能用 window.api 上被明確列出的方法。
 *
 * 本里程碑（即時訊息流）新增：
 *   - messages.recent()          拉取最近訊息（renderer 掛載時回放 backlog）
 *   - line.status()              查詢 LINE 橋接狀態
 *   - line.setRunning(running)   暫停/恢復橋接
 *   - line.onMessage(cb)         訂閱每則新訊息（push）
 *   - line.onStatus(cb)          訂閱橋接狀態變更（push）
 * 兩個 on* 皆回傳 unsubscribe 函式，避免 renderer 直接操作 ipcRenderer。
 */

// 允許 renderer 訂閱的 push 通道白名單（拒絕任意 channel）
const MSG_CHANNEL = 'evt:line-message'
const STATUS_CHANNEL = 'evt:line-status'
const PERSISTED_CHANNEL = 'evt:messages-persisted'
const PIPELINE_RUN_CHANNEL = 'evt:pipeline-run'
const PIPELINE_STATUS_CHANNEL = 'evt:pipeline-status'
const TODOS_CHANGED_CHANNEL = 'evt:todos-changed'
const BACKFILL_PROGRESS_CHANNEL = 'evt:backfill-progress'
const RECONCILE_PROGRESS_CHANNEL = 'evt:reconcile-progress'
const DRIVER_PROGRESS_CHANNEL = 'evt:driver-post-progress'


function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  /** 驗證 IPC 三進程橋接是否通。 */
  ping: (): Promise<{ ok: boolean; ts: number; version: string }> =>
    ipcRenderer.invoke('app:ping'),

  groupTopics: {
    setEnabled: (chatId: string, enabled: boolean) => ipcRenderer.invoke('groupTopics:setEnabled', { chatId, enabled }),
    setCrossChatEnabled: (chatId: string, enabled: boolean) => ipcRenderer.invoke('groupTopics:setCrossChatEnabled', { chatId, enabled }),
    crossChatEnabled: (chatId: string) => ipcRenderer.invoke('groupTopics:crossChatEnabled', { chatId }),
    list: (chatId: string) => ipcRenderer.invoke('groupTopics:list', { chatId }),
    linkCandidates: (chatId: string) => ipcRenderer.invoke('groupTopics:linkCandidates', { chatId }),
    analyze: (chatId: string) => ipcRenderer.invoke('groupTopics:analyze', { chatId }),
    todoRefs: (topicId: string) => ipcRenderer.invoke('groupTopics:todoRefs', { topicId })
  },

  messages: {
    /** 最近 N 則訊息（main 端 ring buffer），掛載時用來回放 backlog。 */
    recent: (): Promise<RawLineMessage[]> => ipcRenderer.invoke('messages:recent')
  },

  line: {
    /** 目前 LINE 橋接狀態。 */
    status: (): Promise<LineBridgeStatus> => ipcRenderer.invoke('line:status'),
    /** 暫停/恢復 in-process LINE 輪詢引擎（watcher.ts；無子程序）。 */
    setRunning: (running: boolean): Promise<LineBridgeStatus> =>
      ipcRenderer.invoke('line:setRunning', running),
    /** 訂閱每則新訊息；回傳 unsubscribe。 */
    onMessage: (cb: (msg: RawLineMessage) => void): (() => void) =>
      subscribe<RawLineMessage>(MSG_CHANNEL, cb),
    /** 訂閱橋接狀態變更；回傳 unsubscribe。 */
    onStatus: (cb: (status: LineBridgeStatus) => void): (() => void) =>
      subscribe<LineBridgeStatus>(STATUS_CHANNEL, cb)
  },

  /** DB 持久化查詢層（重啟後仍在，與 line.* 的記憶體 ring buffer 不同）。 */
  db: {
    messages: {
      /** 列訊息鏡像；可限 chatId / beforeTs / limit。預設新到舊。 */
      list: (query?: {
        chatId?: string
        beforeTs?: number
        limit?: number
      }): Promise<MessageDTO[]> => ipcRenderer.invoke('messages:list', query ?? {}),
      /** 某 chat 最近 N 則（舊到新，適合對話視圖 / LLM 上下文）。 */
      recentByChat: (chatId: string, limit?: number): Promise<MessageDTO[]> =>
        ipcRenderer.invoke('messages:recentByChat', { chatId, limit }),
      /** 某 chat 在 ts >= sinceMs 的完整時間窗（來源訊息彈窗「過去 24h」用）。回舊到新、無筆數上限。 */
      byChatSince: (chatId: string, sinceMs: number): Promise<MessageDTO[]> =>
        ipcRenderer.invoke('messages:byChatSince', { chatId, sinceMs }),
      /** 訊息總數（或某 chat 的數量）。 */
      count: (chatId?: string): Promise<number> =>
        ipcRenderer.invoke('messages:count', { chatId })
    },
    chats: {
      /** 聊天室清單（預設不含黑名單）。 */
      list: (includeBlocked?: boolean): Promise<ChatDTO[]> =>
        ipcRenderer.invoke('chats:list', { includeBlocked }),
      /** 取單一聊天室。 */
      get: (chatId: string): Promise<ChatDTO | null> =>
        ipcRenderer.invoke('chats:get', { chatId }),
      /** 切換黑名單。 */
      setBlocked: (
        chatId: string,
        blocked: boolean,
        reason?: string
      ): Promise<ChatDTO | null> =>
        ipcRenderer.invoke('chats:setBlocked', { chatId, blocked, reason }),
      /** 卡片「封鎖這個對話」：手動封鎖 + 清掉該對話未完成代辦。回 dismissed 筆數。 */
      blockAndClear: (chatId: string): Promise<{ ok: boolean; dismissed: number }> =>
        ipcRenderer.invoke('chats:blockAndClear', { chatId }),
      /** 卡片「依關鍵字忽略（此對話）」：加關鍵字 + 立即忽略命中的未完成代辦。 */
      addIgnoreKeyword: (
        chatId: string,
        keyword: string
      ): Promise<{ ok: boolean; dismissed: number; error?: string }> =>
        ipcRenderer.invoke('chats:addIgnoreKeyword', { chatId, keyword }),
      /** 設定頁「解除」某對話的某 ignore 關鍵字。 */
      removeIgnoreKeyword: (
        chatId: string,
        keyword: string
      ): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke('chats:removeIgnoreKeyword', { chatId, keyword }),
      /** 「開原聊天」：盡力喚起 LINE Desktop（無法精準跳到聊天室，LINE 限制）。 */
      openOriginal: (chatId: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('chats:openOriginal', { chatId })
    },
    todos: {
      /** 列代辦（看板）。預設排除 dismissed。 */
      list: (query?: {
        statuses?: TodoDTO['status'][]
        buckets?: TodoDTO['bucket'][]
        chatId?: string
        sortBy?: TodoSortBy
        sortDirection?: TodoSortDirection
      }): Promise<TodoDTO[]> => ipcRenderer.invoke('todos:list', query ?? {}),
      /** 取單筆代辦。 */
      get: (id: string): Promise<TodoDTO | null> =>
        ipcRenderer.invoke('todos:get', { id }),
      /** 某 chat 未完成代辦（去重 / 完成偵測對象）。 */
      openByChat: (chatId: string): Promise<TodoDTO[]> =>
        ipcRenderer.invoke('todos:openByChat', { chatId }),
      /** 狀態轉移（標完成 / 確認 / 忽略）。 */
      updateStatus: (
        id: string,
        status: TodoDTO['status']
      ): Promise<TodoDTO | null> =>
        ipcRenderer.invoke('todos:updateStatus', { id, status }),
      /** 編輯欄位。 */
      update: (
        id: string,
        patch: {
          title?: string
          detail?: string | null
          priority?: number
          dueAt?: string | null
          bucket?: TodoDTO['bucket']
          sourceMsgIds?: string[]
        }
      ): Promise<TodoDTO | null> =>
        ipcRenderer.invoke('todos:update', { id, patch }),
      /** 用 qwen 草擬回覆（MVP：只回字串草稿，不送出）。 */
      draftReply: (id: string): Promise<DraftReplyResult> =>
        ipcRenderer.invoke('todos:draftReply', { id }),
      /** 看板拖曳搬移：原子設 bucket+status+resolved_at；同欄 no-op 防抖。 */
      moveColumn: (
        id: string,
        toColumn: 'todo' | 'waiting' | 'schedule' | 'done'
      ): Promise<TodoDTO | null> =>
        ipcRenderer.invoke('todos:moveColumn', { id, toColumn }),
      markNotMine: (id,reasonCode,note) => ipcRenderer.invoke('todos:markNotMine',{id,reasonCode,note}),
      listNotMine: () => ipcRenderer.invoke('todos:listNotMine'),
      listNotMineCorrections: () => ipcRenderer.invoke('todos:listNotMineCorrections'),
      getNotMineReview: (feedbackId) => ipcRenderer.invoke('todos:getNotMineReview',{feedbackId}),
      analyzeNotMine: (feedbackId) => ipcRenderer.invoke('todos:analyzeNotMine',{feedbackId}),
      reopenNotMine: (feedbackId) => ipcRenderer.invoke('todos:reopenNotMine',{feedbackId}),
      applyNotMineCorrection: (feedbackId,condition,effect) => ipcRenderer.invoke('todos:applyNotMineCorrection',{feedbackId,condition,effect}),
      setNotMineCorrectionEnabled: (correctionId,enabled) => ipcRenderer.invoke('todos:setNotMineCorrectionEnabled',{correctionId,enabled})
    },
    /** 訂閱「DB 有新訊息落庫」事件；回傳 unsubscribe。 */
    onMessagesPersisted: (
      cb: (e: MessagesPersistedEvent) => void
    ): (() => void) => subscribe<MessagesPersistedEvent>(PERSISTED_CHANNEL, cb)
  },

  /** qwen 抽取 pipeline 控制與訂閱。 */
  pipeline: {
    /** 目前 pipeline 狀態（含 hasApiKey / llmStatus，UI 顯示缺金鑰提示）。 */
    status: (): Promise<PipelineStatus> => ipcRenderer.invoke('pipeline:status'),
    /**
     * 歷史負載統計（唯讀）：設定頁延遲試算的預設值來源。
     * 只在開設定頁時拉一次，不放進輪詢——它不是狀態，是統計。
     */
    loadStats: (): Promise<PipelineLoadStats> => ipcRenderer.invoke('pipeline:loadStats'),
    /** 手動立即跑一輪。 */
    runOnce: (): Promise<PipelineRunResult> => ipcRenderer.invoke('pipeline:runOnce'),
    /** 回顧過去 N 天（預設 7）：用既有抽取管線判斷時間窗口、補建 todos。 */
    reviewLastDays: (days?: number): Promise<ReviewLastDaysResult> =>
      ipcRenderer.invoke('pipeline:reviewLastDays', { days }),
    /** 輕量 backfill：重讀近 N 天訊息只補既有列媒體欄（不跑 LLM、不需金鑰）。 */
    backfillMediaKeys: (
      days?: number
    ): Promise<{ ok: boolean; scanned?: number; mediaBackfilled?: number; error?: string }> =>
      ipcRenderer.invoke('pipeline:backfillMediaKeys', { days }),
    /** 暫停/恢復定時輪詢。 */
    setRunning: (running: boolean): Promise<PipelineStatus> =>
      ipcRenderer.invoke('pipeline:setRunning', { running }),
    /** 測試 qwen 金鑰/連線（打 /v1/models）。HTTP 專屬；保留給現行設定頁。 */
    testQwen: (): Promise<QwenTestResult> => ipcRenderer.invoke('settings:testQwen'),
    /**
     * provider-aware 健檢：依 settings.aiProvider 分別檢查 HTTP 端點 / CLI 路徑版本登入。
     * CLI 會 spawn 子程序，耗時可達數秒；只在使用者按下按鈕時呼叫，不要放進輪詢。
     */
    testAiProvider: (): Promise<ProviderHealth> =>
      ipcRenderer.invoke('settings:testAiProvider'),
    /** 訂閱每輪結束；回傳 unsubscribe。 */
    onRun: (cb: (r: PipelineRunResult) => void): (() => void) =>
      subscribe<PipelineRunResult>(PIPELINE_RUN_CHANNEL, cb),
    /** 訂閱狀態變更；回傳 unsubscribe。 */
    onStatus: (cb: (s: PipelineStatus) => void): (() => void) =>
      subscribe<PipelineStatus>(PIPELINE_STATUS_CHANNEL, cb),
    /** 訂閱 todos 異動；回傳 unsubscribe。 */
    onTodosChanged: (cb: (e: TodosChangedEvent) => void): (() => void) =>
      subscribe<TodosChangedEvent>(TODOS_CHANGED_CHANNEL, cb),
    /** 訂閱「回顧過去 N 天」進度；回傳 unsubscribe。 */
    onBackfillProgress: (cb: (p: BackfillProgress) => void): (() => void) =>
      subscribe<BackfillProgress>(BACKFILL_PROGRESS_CHANNEL, cb),
    /** 訂閱開機自我對帳進度（evt:reconcile-progress）；回傳 unsubscribe。 */
    onReconcileProgress: (cb: (p: ReconcileProgress) => void): (() => void) =>
      subscribe<ReconcileProgress>(RECONCILE_PROGRESS_CHANNEL, cb)
  },

  /** App 設定（設定頁）。金鑰永不以明文跨橋；只回 hasApiKey 等狀態。 */
  settings: {
    /** 讀目前設定（不含金鑰明文）。 */
    get: (): Promise<SettingsView> => ipcRenderer.invoke('settings:get'),
    /** 部分更新設定（輪詢頻率 / 並發 / blocklist 規則）。回最新設定。 */
    update: (patch: SettingsPatch): Promise<SettingsView> =>
      ipcRenderer.invoke('settings:update', { patch }),
    /** 寫入 qwen 金鑰（safeStorage 加密落檔）。 */
    setApiKey: (apiKey: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('settings:setApiKey', { apiKey }),
    /** 清除 qwen 金鑰。 */
    clearApiKey: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('settings:clearApiKey'),
    /** safeStorage 是否有已存金鑰（檔在 + 後端可用）。 */
    hasSafeStorageKey: (): Promise<boolean> =>
      ipcRenderer.invoke('settings:hasSafeStorageKey')
  },

  /** App 級雜項。 */
  app: {
    /** 開 userData 資料夾（除錯）。 */
    openDataFolder: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('app:openDataFolder')
  },

  /** 媒體檔案（content_type=14）：bytes 全程只在 main，renderer 只傳 msgId。 */
  media: {
    /** 解密→暫存→以系統預設程式開啟。 */
    open: (msgId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('media:open', { msgId }),
    /** 解密→另存新檔（使用者選路；預設檔名用 orig_filename）。 */
    saveAs: (msgId: string): Promise<{ ok: boolean; canceled?: boolean; error?: string }> =>
      ipcRenderer.invoke('media:saveAs', { msgId })
  },

  /**
   * 草稿填入 LINE（driver_post）。只填入、永遠不送出；每個動作都由使用者在「草擬回覆」對話框觸發。
   * channel 見 src/main/ipc/driver.ipc.ts。
   */
  driver: {
    /** 輕量狀態（不 spawn helper、不碰 LINE）；帶 todoId 時一併回傳前置檢查問題。 */
    status: (query?: { todoId?: string }): Promise<DriverStatus> =>
      ipcRenderer.invoke('driver:status', { todoId: query?.todoId }),
    /** 在 LINE 開啟聊天室並填入草稿（不送出）。整個流程跑完才回。 */
    postDraft: (req: DriverPostRequest): Promise<DriverPostResult> =>
      ipcRenderer.invoke('driver:postDraft', req),
    /** 成功填入後：切到 LINE 並把游標放進輸入框（不注入按鍵）。 */
    focusLine: (attemptId: string): Promise<DriverFollowUpResult> =>
      ipcRenderer.invoke('driver:focusLine', { attemptId }),
    /** 成功填入後：只清除仍等於填入內容的輸入框。 */
    clearFilled: (attemptId: string): Promise<DriverFollowUpResult> =>
      ipcRenderer.invoke('driver:clearFilled', { attemptId }),
    /** 訂閱進度（含 waitingForQuiet）；回傳 unsubscribe。 */
    onProgress: (cb: (p: DriverPostProgress) => void): (() => void) =>
      subscribe<DriverPostProgress>(DRIVER_PROGRESS_CHANNEL, cb)
  }
} satisfies LineTodoApi

export type Api = LineTodoApi

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('[preload] exposeInMainWorld failed:', error)
  }
} else {
  ;(globalThis as unknown as { api: Api }).api = api
}
