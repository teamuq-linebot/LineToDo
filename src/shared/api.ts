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

export type NotMineReasonCode = 'other_person_assigned' | 'general_announcement' | 'delegated_or_third_party' | 'unclear_context' | 'other'
export interface NotMineAnalysisDTO { analysisVersion: string; inferredCauseCode: string; summary: string; providerId: AiProviderId | null; modelId: string | null; analyzedAt: string; suggestedCondition?: string; suggestedEffect?: string }
export interface NotMineFeedbackDTO { feedbackId: string; todo: TodoDTO; reasonCode: NotMineReasonCode; note: string | null; markedAt: string; analysis: NotMineAnalysisDTO | null; analysisHistory?: NotMineAnalysisDTO[]; correction: { id: string; revision: number; condition: string; effect: string; enabled: boolean } | null }
export interface NotMineReviewDTO extends NotMineFeedbackDTO { evidence: MessageDTO[]; missingSourceMsgIds: string[] }
export interface NotMineCorrectionDTO { id: string; feedbackId: string; todoId: string; chatId: string; revision: number; condition: string; effect: string; enabled: boolean; updatedAt: string }
export interface NotMineAnalysisResult { ok: boolean; reason?: string; inferredCauseCode?: string; summary?: string; suggestedCondition?: string; suggestedEffect?: string; providerId?: AiProviderId; modelId?: string | null }

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

/**
 * 歷史負載統計（與 main/ipc/pipeline.ipc.ts PipelineLoadStats 對齊）。
 * 設定頁延遲試算用；全部是整數，不含聊天室名稱或訊息內容。
 */
export interface PipelineLoadStats {
  /** 納入分位數的輪數；< 20 代表歷史不足，UI 應退回保守預設。 */
  sampleRuns: number
  chatsSeenP50: number
  chatsSeenP90: number
  /** 歷來單輪最多處理過的聊天室數（多半來自開機自我對帳的一次性回補）。 */
  chatsSeenMax: number
  recentDays: number
  /** 近 recentDays 天有過新訊息、且未被封鎖的聊天室數。 */
  chatsWithRecentMessages: number
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
  /**
   * 因 AI 引擎熔斷冷卻 / per-chat 退避而整個被跳過的 chat 數（Batch 7 新增，**純加欄位**：
   * 既有 UI 不讀它也完全正常，訊息維持未處理、解除後下一輪重抽）。
   */
  chatsSkipped: number
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

/** AI provider 種類（與 main/config/settings.ts AiProviderId 對齊）。 */
export type AiProviderId = 'http' | 'claudeCli' | 'codexCli'

/** provider 錯誤碼（與 main/llm/provider/types.ts LlmErrorCode 對齊）。 */
export type LlmErrorCode =
  | 'not_installed'
  | 'not_authenticated'
  | 'timeout'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'bad_output'
  | 'invalid_config'
  | 'transport'
  | 'unknown'

/**
 * settings:testAiProvider 結果（與 main/llm/provider/types.ts ProviderHealth 對齊）。
 * `summary` 是 UI 唯一的訊息來源；技術細節（stderr / 路徑）只留在 main 的 log。
 */
export interface ProviderHealth {
  ok: boolean
  summary: string
  code?: LlmErrorCode
  details: {
    installed?: boolean
    path?: string | null
    version?: string | null
    versionOk?: boolean
    authenticated?: boolean | 'unknown'
    /** 只有 http provider 有。 */
    models?: string[]
  }
}

/** CLI provider 設定（與 main/config/settings.ts CliProviderSettings 對齊）。 */
export interface CliProviderSettings {
  /** 執行檔絕對路徑；空字串＝自動偵測。 */
  execPath: string
  /** 空字串＝用 provider 內建建議預設。 */
  model: string
  /** 單次呼叫逾時（ms），15000–600000。 */
  timeoutMs: number
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
  /** AI 判斷引擎種類；預設 'http'＝現行行為（Batch 5）。 */
  aiProvider: AiProviderId
  /** Claude CLI provider 設定（aiProvider='claudeCli' 時生效）。 */
  claudeCli: CliProviderSettings
  /** Codex CLI provider 設定（aiProvider='codexCli' 時生效）。 */
  codexCli: CliProviderSettings
  /** 草稿填入 LINE 設定。 */
  driverPost: DriverPostSettings
  /** AI 引擎是否已就緒（http=有金鑰；CLI=設定無誤）。欄位名沿用歷史，語意見 main scheduler。 */
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
  /** AI 判斷引擎種類。 */
  aiProvider: AiProviderId
  /** 部分更新 Claude CLI 設定。 */
  claudeCli: Partial<CliProviderSettings>
  /** 部分更新 Codex CLI 設定。 */
  codexCli: Partial<CliProviderSettings>
  /** 部分更新草稿填入 LINE 設定（mode 一律正規化成 fillOnly）。 */
  driverPost: Partial<DriverPostSettings>
}>

// ── 草稿填入 LINE（driver_post）：與 main/config/settings.ts、main/driver/{types,locate}.ts 對齊 ──

/** 型別保留 'fillAndSend' 作為擴充點；目前一律正規化成 'fillOnly'。 */
export type DriverPostMode = 'fillOnly' | 'fillAndSend'

export interface DriverPostSettings {
  enabled: boolean
  mode: DriverPostMode
  /** 開啟聊天室後用 LINE 本機 DB 檢查是否有其他聊天室被標成已讀（預設開啟）。 */
  verifyReadByDb: boolean
}

export interface DriverStatus {
  enabled: boolean
  mode: 'fillOnly'
  sendAvailable: false
  busy: boolean
  lastHostProblem: { code: DriverPostErrorCode; message: string } | null
  /** 帶 todoId 查詢時：不碰 LINE 的前置檢查就會停下的原因；null＝沒有問題或沒有帶 todoId。 */
  targetProblem: { code: DriverPostErrorCode; message: string } | null
}

export interface DriverPostRequest {
  todoId: string
  text: string
  mode?: DriverPostMode
}

export type DriverPostStage =
  | 'preflight'
  | 'host_start'
  | 'locate_line'
  | 'read_order'
  | 'read_list'
  | 'locate_row'
  | 'activate_line'
  | 'open_chat'
  | 'verify_open'
  | 'check_input_empty'
  | 'fill'
  | 'hand_back'
  | 'cleanup'

/** 等安靜期的是哪一個會改變 LINE 狀態的動作。 */
export type DriverQuietAction = 'activate' | 'click' | 'fill'

export interface DriverPostProgress {
  attemptId: string
  stage: DriverPostStage
  /** 正在等安靜期：開始等待時 true，該動作回來後 false；一般階段進度不帶。 */
  waitingForQuiet?: boolean
  quietAction?: DriverQuietAction
  quietMaxWaitMs?: number
}

export type DriverPostErrorCode =
  | 'disabled'
  | 'busy'
  | 'rate_limited'
  | 'invalid_request'
  | 'text_too_long'
  | 'send_not_available'
  | 'todo_not_found'
  | 'chat_name_missing'
  | 'chat_name_unverifiable'
  | 'test_allowlist_blocked'
  | 'host_unavailable'
  | 'powershell_restricted'
  | 'ocr_unavailable'
  | 'line_db_unavailable'
  | 'line_key_unavailable'
  | 'line_not_running'
  | 'line_no_window'
  | 'line_multiple_windows'
  | 'line_activate_failed'
  | 'line_capture_failed'
  | 'line_ui_unrecognized'
  | 'line_search_active'
  | 'user_busy'
  | 'target_not_in_line'
  | 'list_changing'
  | 'list_unrecognized'
  | 'list_order_mismatch'
  | 'target_not_visible'
  | 'row_unconfirmed'
  | 'row_identifies_other'
  | 'row_changed'
  | 'occluded'
  | 'click_missed'
  | 'title_unreadable'
  | 'title_unconfirmed'
  | 'title_identifies_other'
  | 'title_changed'
  | 'opened_other_suspected'
  | 'draft_present'
  | 'fill_readback_mismatch'
  | 'timeout'
  | 'internal'

export type DraftLeftInLine = 'none' | 'filled_in_identified' | 'unknown'

export interface LineSideEffects {
  /** LINE 是否曾被切到前景（最小化還原、切前景都算）。 */
  activated: boolean
  searchChanged: false
  searchRestored: false
  /** 是否點開過聊天室（可能已變成已讀）。 */
  chatOpened: boolean
  /** 點擊已送出但沒有拿到結果就停止：無法確定是否已開啟（只在 chatOpened=false 時為 true）。 */
  chatOpenUncertain?: true
}

export interface VisibilityHint {
  direction: 'above' | 'below' | 'edge'
  rows: number
  /** direction='edge' 時：目標在可見範圍的上緣或下緣。 */
  edgeSide?: 'top' | 'bottom'
}

export interface LocateEvidence {
  rank: number
  pinned: boolean
  offset: number
  anchors: number
  path: 'T' | 'A' | 'B'
  row: number
}

export interface OpenEvidence {
  selectionMatched: boolean
  titleSim: number
  titleGap: number
  titlePass: number
  dbAck: 'target_cleared' | 'no_change' | 'na' | 'skipped'
  seenTitle: string
}

export type DriverPostResult =
  | {
      ok: true
      outcome: 'filled'
      attemptId: string
      chatName: string
      locate: LocateEvidence
      open: OpenEvidence
      handedBack: boolean
      elapsedMs: number
      /** 可展開的「辨識細節」。 */
      details: string
      /** handedBack=false 時的提醒；否則 null。 */
      handBackNote: string | null
      /** 「切到 LINE」「從 LINE 清除這段草稿」的有效時間（ms）。 */
      followUpTtlMs: number
      /** 超過 followUpTtlMs 後顯示的說明。 */
      expiredNote: string
    }
  | {
      ok: false
      attemptId: string
      code: DriverPostErrorCode
      /** 完整訊息（body＋tail；本文已說明 LINE 端狀態的碼不重複附 tail）。 */
      message: string
      body: string
      /** LINE 端狀態（副作用列）；前置檢查失敗時為 null。 */
      tail: string | null
      stage: DriverPostStage
      draftLeftInLine: DraftLeftInLine
      lineSideEffects: LineSideEffects
      otherChatName?: string
      seenTitle?: string
      visibility?: VisibilityHint
    }

export type DriverFollowUpAction = 'focusLine' | 'clearFilled'

/**
 * driver:focusLine／driver:clearFilled 的結果。成功後的四種後續：
 *   清除成功 clearFilled→ok cleared；清除被拒 clearFilled→edit_changed|title_changed；
 *   切到 LINE 時已換 focusLine→title_changed；超過 5 分鐘 → attempt_expired。
 */
export type DriverFollowUpResult =
  | { ok: true; action: DriverFollowUpAction; outcome: 'focused' | 'cleared'; message: string }
  | {
      ok: false
      action: DriverFollowUpAction
      code: 'attempt_expired' | 'title_changed' | 'edit_changed' | 'line_not_running' | 'user_busy' | 'busy' | 'disabled' | 'invalid_request' | 'internal'
      message: string
      activated: boolean
    }

/**
 * 草稿填入 LINE（window.api.driver）。由 Electron 主機（preload）提供；core application 不實作，
 * 沒有這個能力的主機省略它，renderer 就只提供「複製」。
 */
export interface DriverApi {
  status(query?: { todoId?: string }): Promise<DriverStatus>
  postDraft(req: DriverPostRequest): Promise<DriverPostResult>
  focusLine(attemptId: string): Promise<DriverFollowUpResult>
  clearFilled(attemptId: string): Promise<DriverFollowUpResult>
  onProgress(cb: (p: DriverPostProgress) => void): () => void
}

/** todos:draftReply 結果（只草擬不送出）。 */
export interface DraftReplyResult {
  draft?: string
  error?: string
}

export interface LineTodoApi {
  ping(): Promise<{ ok: boolean; ts: number; version: string }>
  messages: { recent(): Promise<RawLineMessage[]> }
  line: {
    status(): Promise<LineBridgeStatus>; setRunning(running: boolean): Promise<LineBridgeStatus>
    onMessage(cb: (msg: RawLineMessage) => void): () => void
    onStatus(cb: (status: LineBridgeStatus) => void): () => void
  }
  db: {
    messages: {
      list(query?: { chatId?: string; beforeTs?: number; limit?: number }): Promise<MessageDTO[]>
      recentByChat(chatId: string, limit?: number): Promise<MessageDTO[]>
      byChatSince(chatId: string, sinceMs: number): Promise<MessageDTO[]>
      count(chatId?: string): Promise<number>
    }
    chats: {
      list(includeBlocked?: boolean): Promise<ChatDTO[]>; get(chatId: string): Promise<ChatDTO | null>
      setBlocked(chatId: string, blocked: boolean, reason?: string): Promise<ChatDTO | null>
      blockAndClear(chatId: string): Promise<{ ok: boolean; dismissed: number }>
      addIgnoreKeyword(chatId: string, keyword: string): Promise<{ ok: boolean; dismissed: number; error?: string }>
      removeIgnoreKeyword(chatId: string, keyword: string): Promise<{ ok: boolean }>
      openOriginal(chatId: string): Promise<{ ok: boolean; error?: string }>
    }
    todos: {
      list(query?: { statuses?: TodoDTO['status'][]; buckets?: TodoDTO['bucket'][]; chatId?: string; sortBy?: TodoSortBy; sortDirection?: TodoSortDirection }): Promise<TodoDTO[]>
      get(id: string): Promise<TodoDTO | null>; openByChat(chatId: string): Promise<TodoDTO[]>
      updateStatus(id: string, status: TodoDTO['status']): Promise<TodoDTO | null>
      update(id: string, patch: { title?: string; detail?: string | null; priority?: number; dueAt?: string | null; bucket?: TodoDTO['bucket']; sourceMsgIds?: string[] }): Promise<TodoDTO | null>
      draftReply(id: string): Promise<DraftReplyResult>
      moveColumn(id: string, toColumn: 'todo' | 'waiting' | 'schedule' | 'done'): Promise<TodoDTO | null>
      markNotMine(id: string, reasonCode: NotMineReasonCode, note?: string): Promise<{ ok: boolean; feedbackId?: string; error?: string }>
      listNotMine(): Promise<NotMineFeedbackDTO[]>
      listNotMineCorrections(): Promise<NotMineCorrectionDTO[]>
      getNotMineReview(feedbackId: string): Promise<NotMineReviewDTO | null>
      analyzeNotMine(feedbackId: string): Promise<NotMineAnalysisResult>
      reopenNotMine(feedbackId: string): Promise<{ ok: boolean; error?: string }>
      applyNotMineCorrection(feedbackId: string, condition: string, effect: string): Promise<{ ok: boolean; error?: string }>
      setNotMineCorrectionEnabled(correctionId: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>
    }
    onMessagesPersisted(cb: (e: MessagesPersistedEvent) => void): () => void
  }
  pipeline: {
    status(): Promise<PipelineStatus>; loadStats(): Promise<PipelineLoadStats>
    runOnce(): Promise<PipelineRunResult>; reviewLastDays(days?: number): Promise<ReviewLastDaysResult>
    backfillMediaKeys(days?: number): Promise<{ ok: boolean; scanned?: number; mediaBackfilled?: number; error?: string }>
    setRunning(running: boolean): Promise<PipelineStatus>; testQwen(): Promise<QwenTestResult>; testAiProvider(): Promise<ProviderHealth>
    onRun(cb: (r: PipelineRunResult) => void): () => void; onStatus(cb: (s: PipelineStatus) => void): () => void
    onTodosChanged(cb: (e: TodosChangedEvent) => void): () => void
    onBackfillProgress(cb: (p: BackfillProgress) => void): () => void
    onReconcileProgress(cb: (p: ReconcileProgress) => void): () => void
  }
  settings: {
    get(): Promise<SettingsView>; update(patch: SettingsPatch): Promise<SettingsView>
    setApiKey(apiKey: string): Promise<{ ok: boolean; error?: string }>
    clearApiKey(): Promise<{ ok: boolean }>; hasSafeStorageKey(): Promise<boolean>
  }
  app: { openDataFolder(): Promise<{ ok: boolean }> }
  media: {
    open(msgId: string): Promise<{ ok: boolean; error?: string }>
    saveAs(msgId: string): Promise<{ ok: boolean; canceled?: boolean; error?: string }>
  }
  /** 主機能力（選填）：Electron preload 提供；core application 不實作。 */
  driver?: DriverApi
}
export type Api = LineTodoApi
