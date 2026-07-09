import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

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

export interface RawLineMessage {
  /** DB 主鍵（main 端由 deriveMsgId 衍生，含 'i:'/'d:' 前綴）；供 linemedia://media/<msgId> 顯圖與 media.open/saveAs。keyMaterial 絕不跨橋。 */
  msgId?: string
  chat: string
  chatId: string
  isGroup: boolean
  ts: number
  time: string
  direction: 'in' | 'out'
  sender: string
  text: string
  contentType: number
  /** 檔案原名（檔案訊息）；圖片/非媒體為 null。keyMaterial 絕不跨橋。 */
  origFilename?: string | null
  /** 明文位元組數（媒體）；非媒體為 null。 */
  fileSize?: number | null
  /** 該列是否為已收回訊息（LINE 收回旗標）；由橋接即時 push 帶入。舊列/非收回為 undefined。 */
  unsent?: boolean
}

export interface LineBridgeStatus {
  state: 'starting' | 'running' | 'error' | 'stopped'
  lastMessageAt: string | null
  messageCount: number
  lastError: string | null
  restarts: number
}

// ── DB 持久化層的 DTO（與 main/db/dto.ts 對齊；preload 為 renderer 的型別來源）──

export interface ChatDTO {
  chatId: string
  name: string | null
  isGroup: boolean
  blocked: boolean
  blockReason: string | null
  firstSeenAt: string
  lastSeenAt: string
}

export interface MessageDTO {
  msgId: string
  chatId: string
  ts: number
  timeIso: string
  direction: 'in' | 'out'
  sender: string | null
  text: string | null
  contentType: number
  processed: boolean
  ingestedAt: string
  /** 檔案原名（檔案訊息）；圖片/非媒體為 null。key_material 絕不進 DTO。 */
  origFilename: string | null
  /** 明文位元組數（媒體）；非媒體為 null。 */
  fileSize: number | null
  /** 是否已收回（LINE 收回旗標）。true 時 UI 加刪除線 + 已收回 badge。 */
  unsent: boolean
}

export interface TodoDTO {
  id: string
  chatId: string
  bucket: 'todo' | 'waiting' | 'schedule'
  status:
    | 'pending'
    | 'waiting_reply'
    | 'scheduled'
    | 'done'
    | 'suggested_done'
    | 'dismissed'
  title: string
  detail: string | null
  priority: number
  dueAt: string | null
  sourceMsgIds: string[]
  confidence: number
  completionEvidence: string | null
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
}

export type TodoSortBy = 'updatedAt' | 'createdAt' | 'dueAt' | 'priority'
export type TodoSortDirection = 'asc' | 'desc'

/** evt:messages-persisted push payload（DB 有新訊息落庫時）。 */
export interface MessagesPersistedEvent {
  chatIds: string[]
  inserted: number
}

/** qwen 抽取 pipeline 狀態（與 main/pipeline/scheduler.ts PipelineStatus 對齊）。 */
export interface PipelineStatus {
  running: boolean
  busy: boolean
  intervalSec: number
  lastRunAt: string | null
  lineBridge: 'ok' | 'error' | 'skipped' | 'unknown'
  llmStatus: 'ok' | 'partial' | 'error' | 'disabled' | 'unknown'
  hasApiKey: boolean
  lastError: string | null
}

/** 一輪 pipeline 結果（與 main/pipeline/runOnce.ts RunOnceResult 對齊）。 */
export interface PipelineRunResult {
  runId: string
  lineBridge: 'ok' | 'error' | 'skipped'
  llmStatus: 'ok' | 'partial' | 'error'
  newMsgs: number
  chatsSeen: number
  chatsProcessed: number
  chatsSkippedNoise: number
  chatsFailed: number
  todosCreated: number
  todosMerged: number
  todosResolvedDone: number
  todosSuggestedDone: number
  createdIds: string[]
  resolvedIds: string[]
  updatedIds: string[]
  note: string | null
}

/** evt:todos-changed push payload。 */
export interface TodosChangedEvent {
  createdIds: string[]
  resolvedIds: string[]
  updatedIds: string[]
}

/** evt:backfill-progress push payload（回顧過去 N 天進度，與 main/pipeline/backfill.ts 對齊）。 */
export interface BackfillProgress {
  processed: number
  total: number
  phase: 'fetching' | 'extracting' | 'done'
}

/** pipeline:reviewLastDays 結果（與 main/pipeline/backfill.ts ReviewLastDaysResult 對齊）。 */
export interface ReviewLastDaysResult {
  ok: boolean
  hasApiKey: boolean
  days: number
  sinceMs: number
  newMsgs: number
  chatsSeen: number
  chatsProcessed: number
  chatsSkippedNoise: number
  chatsFailed: number
  todosCreated: number
  todosMerged: number
  todosResolvedDone: number
  todosSuggestedDone: number
  createdIds: string[]
  resolvedIds: string[]
  updatedIds: string[]
  note: string | null
}

/**
 * evt:reconcile-progress push payload（開機自我對帳進度，與
 * main/pipeline/reconcileRunner.ts ReconcileProgress 對齊；Batch 4 emit）。
 */
export interface ReconcileProgress {
  phase: 'scanning' | 'backfilling' | 'done' | 'source-unavailable' | 'db-unhealthy' | 'skipped'
  /** 當前處理中的缺月（`YYYY-MM`）；scanning/done/gate 階段為 null。 */
  ym: string | null
  /** 已補完的缺月數。 */
  done: number
  /** 本次開機要補的缺月總數。 */
  total: number
}

/** settings:testQwen 結果。 */
export interface QwenTestResult {
  ok: boolean
  models?: string[]
  error?: string
}

/** 降噪黑名單規則（與 main/config/defaults.ts BlocklistRules 對齊）。 */
export interface BlocklistRules {
  nameKeywords: string[]
  senderKeywords: string[]
  contentTypeNoiseOnly: number[]
  minTextLenForLLM: number
}

/**
 * 設定頁可讀寫的設定（與 main/config/settings.ts SettingsView 對齊）。
 * ⚠️ 永不含金鑰明文；hasApiKey/apiKeySource 表達金鑰狀態。
 */
export interface SettingsView {
  pollIntervalSec: number
  concurrency: number
  recentContextLimit: number
  blocklist: BlocklistRules
  /** 逐對話關鍵字忽略：chatId → 小寫關鍵字陣列（設定頁可檢視 / 移除）。 */
  chatIgnoreKeywords: Record<string, string[]>
  /** 開機時自動啟動（Batch 5a 提供）。 */
  openAtLogin: boolean
  /** 開機自我對帳設定（Batch 5a 提供）。 */
  reconcile: {
    /** 是否啟用自我對帳。 */
    enabled: boolean
    /** 對帳範圍：0=全部歷史，3/6/12=近 N 個月。 */
    scopeMonths: number
  }
  /** AI 判斷引擎端點 Base URL；空字串＝用預設端點（見 qwen.ts 的 baseURL 解析優先序）。 */
  aiBaseUrl: string
  hasApiKey: boolean
  apiKeySource: 'safeStorage' | 'env' | 'none'
  safeStorageAvailable: boolean
}

/** settings:update 的 patch 形態。 */
export type SettingsPatch = Partial<{
  pollIntervalSec: number
  concurrency: number
  recentContextLimit: number
  blocklist: Partial<BlocklistRules>
  chatIgnoreKeywords: Record<string, string[]>
  openAtLogin: boolean
  reconcile: Partial<{ enabled: boolean; scopeMonths: number }>
  /** AI 判斷引擎端點 Base URL；空字串＝用預設端點。 */
  aiBaseUrl: string
}>

/** todos:draftReply 結果（只草擬不送出）。 */
export interface DraftReplyResult {
  draft?: string
  error?: string
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  /** 驗證 IPC 三進程橋接是否通。 */
  ping: (): Promise<{ ok: boolean; ts: number; version: string }> =>
    ipcRenderer.invoke('app:ping'),

  messages: {
    /** 最近 N 則訊息（main 端 ring buffer），掛載時用來回放 backlog。 */
    recent: (): Promise<RawLineMessage[]> => ipcRenderer.invoke('messages:recent')
  },

  line: {
    /** 目前 LINE 橋接狀態。 */
    status: (): Promise<LineBridgeStatus> => ipcRenderer.invoke('line:status'),
    /** 暫停/恢復 watch_json.py 子程序。 */
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
        ipcRenderer.invoke('todos:moveColumn', { id, toColumn })
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
    /** 測試 qwen 金鑰/連線（打 /v1/models）。 */
    testQwen: (): Promise<QwenTestResult> => ipcRenderer.invoke('settings:testQwen'),
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
  }
}

export type Api = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('[preload] exposeInMainWorld failed:', error)
  }
} else {
  ;(globalThis as unknown as { api: Api }).api = api
}
