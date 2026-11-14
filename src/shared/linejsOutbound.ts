/**
 * linejsOutbound.ts — 聊天室手動送出（文字／單張圖片／單一檔案）的共用契約：view（pluginApi、ChatComposer）與 backend（dispatcher、
 * LineJsOutboundService）都 import。純型別與常數，不依賴 DOM／Node。
 *
 * 送出只在使用者按「傳送」（或 Ctrl/⌘+Enter）時發生。附件以 `linejsOutbound.stageChunk` 分塊（每塊 ≤ 32 KiB 原始位元組，base64）
 * 送到 backend 的 dataDir，最後 `send` 只帶 stageId：附件位元組永遠不經過 `send`，所有請求仍在 pluginWire 的 60 KiB 之內。
 * 結果判定：SDK 回傳非空字串訊息 ID 才是「LINE 已接受」；可證明未送出的錯誤才是失敗；其餘一律「無法確認」，不自動重送。
 */

export const LINEJS_OUTBOUND_PATHS = Object.freeze([
  'linejsOutbound.status',
  'linejsOutbound.begin',
  'linejsOutbound.stageChunk',
  'linejsOutbound.send',
  'linejsOutbound.job',
  'linejsOutbound.discard',
  'linejsOutbound.acknowledge'
] as const)

export const OUTBOUND_LIMITS = Object.freeze({
  /** 單一附件上限（與 LINEJS 回應上限、自動下載上限相同）。 */
  attachmentMaxBytes: 25 * 1024 * 1024,
  /** 每塊原始位元組（base64 後 43,692 B，請求仍遠低於 60 KiB）。 */
  chunkBytes: 32 * 1024,
  textMaxCodePoints: 10_000,
  textMaxBytes: 24_576,
  filenameMaxBytes: 255,
  stageTtlMs: 30 * 60_000,
  journalMax: 100,
  journalTerminalAgeMs: 30 * 24 * 60 * 60_000,
  watchdogMs: 10 * 60_000
})

export const OUTBOUND_IMAGE_MIMES: readonly string[] = Object.freeze(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

export type OutboundKind = 'text' | 'image' | 'file'
export type OutboundAttachmentKind = 'image' | 'file'
export type OutboundJobStatus = 'running' | 'completed' | 'failed' | 'unknown' | 'acknowledged' | 'not_received'
export type OutboundSessionState = 'unavailable' | 'not_logged_in' | 'restoring' | 'ready' | 'account_mismatch' | 'account_unverified'
export type OutboundPhase = 'validation' | 'session_guard' | 'sdk_prepare' | 'sdk_send' | 'sdk_result' | 'restart' | 'watchdog'

export interface OutboundSessionView {
  state: OutboundSessionState
  /** 目前 LINEJS session 的 fencing token（`ready` 時才有）；begin／stageChunk／send 都要帶回來。 */
  sessionId: string | null
}

export interface OutboundJobError {
  code: string
  phase: OutboundPhase
  /** 只有白名單格式（例如 LINE 的 TalkException code）才放；永遠不是 SDK 的錯誤訊息。 */
  detail?: string
}

export interface OutboundJobView {
  requestId: string
  kind?: OutboundKind
  status: OutboundJobStatus
  size?: number
  createdAt: number
  updatedAt: number
  result?: { messageId: string }
  error?: OutboundJobError
}

export interface OutboundChatView {
  running: OutboundJobView | null
  unresolved: OutboundJobView[]
}

export interface OutboundStatusView {
  session: OutboundSessionView
  chat?: OutboundChatView
}

export interface OutboundBeginRequest {
  requestId: string
  chatId: string
  sessionId: string
  kind: OutboundAttachmentKind
  filename: string
  mime: string
  size: number
  /** 整檔 SHA-256（小寫 hex）。 */
  sha256: string
}
export interface OutboundBeginResult { stageId: string; chunkBytes: number; expiresAt: number }

export interface OutboundChunkRequest {
  stageId: string
  requestId: string
  sessionId: string
  offset: number
  /** base64（≤ chunkBytes 原始位元組）。 */
  data: string
  /** 這一塊的 SHA-256（小寫 hex）。 */
  sha256: string
}
export interface OutboundChunkResult { received: number }

export interface OutboundSendRequest {
  requestId: string
  chatId: string
  sessionId: string
  kind: OutboundKind
  text?: string
  stageId?: string
}
export interface OutboundJobRequest { requestId: string; chatId: string; fence?: boolean }
export interface OutboundDiscardRequest { stageId: string; requestId: string }
export interface OutboundAckRequest { requestId: string; chatId: string }

/**
 * 狀態查詢的選項（fix2）：`onLate` 收到「畫面端已放棄等待（view_call_timeout）之後」host 才送到的成功回覆。
 * backend 其實回答了、只是轉送太慢：呼叫端自己決定要不要採用（可能已過時）。
 */
export interface LateAnswerOptions<T> {
  onLate?(value: T): void
}

/** view 端的控制物件（只有 pro 外掛版的 pluginApi 提供；沒有＝聊天室輸入列維持停用佔位）。 */
export interface LineJsOutboundControl {
  status(query: { chatId?: string }, options?: LateAnswerOptions<OutboundStatusView>): Promise<OutboundStatusView>
  begin(request: OutboundBeginRequest): Promise<OutboundBeginResult>
  stageChunk(request: OutboundChunkRequest): Promise<OutboundChunkResult>
  send(request: OutboundSendRequest): Promise<OutboundJobView>
  job(request: OutboundJobRequest): Promise<OutboundJobView>
  discard(request: OutboundDiscardRequest): Promise<{ discarded: boolean }>
  acknowledge(request: OutboundAckRequest): Promise<OutboundJobView>
}

/** 登入中的 LINE 連線（linejsMedia.status 的 login 欄位；設定頁與聊天室「登入 LINE」彈窗共用同一個後端狀態）。 */
export interface LineJsLoginView {
  status: string
  qr?: string
  pin?: string
  error?: { code: string; message: string }
}

/** view 端的登入控制物件（只有 pro 外掛版的 pluginApi 提供；沒有＝聊天室輸入列維持文字提示）。 */
export interface LineJsLoginControl {
  status(options?: LateAnswerOptions<{ available: boolean; login: LineJsLoginView }>): Promise<{ available: boolean; login: LineJsLoginView }>
  /** `joined`＝已有別處（設定頁）開始的登入：只顯示，不由這裡取消。 */
  startLogin(): Promise<{ status: string; joined?: boolean }>
  cancelLogin(): Promise<unknown>
  /** 清除登入資料（失效的已存 session）；與設定頁「清除登入資料」同一個 backend 方法。 */
  logout(): Promise<unknown>
}

/** LINE Talk 目標（u＝一對一、c＝群組）。room（r…/m…）與 Square（t…）不支援。 */
export function isTalkMid(value: unknown): value is string {
  return typeof value === 'string' && /^[uc][A-Za-z0-9._-]{1,127}$/.test(value)
}

/** 看得出是 LINE 的聊天室 ID、但不是 Talk 目標（room／Square）。 */
export function isUnsupportedChatId(value: unknown): boolean {
  return typeof value === 'string' && /^[rmt][A-Za-z0-9._-]{1,127}$/.test(value)
}

/** 請求識別碼：UUID v4（view 端以 crypto.getRandomValues 產生）。 */
export function isOutboundRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

/** 文字檢查（view 與 backend 共用）：null＝可送；否則是錯誤碼。 */
export function outboundTextError(text: unknown): 'INVALID_TEXT' | 'TEXT_TOO_LONG' | null {
  if (typeof text !== 'string' || !text.trim()) return 'INVALID_TEXT'
  // \n、\t 以外的 C0 控制字元一律拒絕：JSON 跳脫最多兩倍，最壞的請求仍在 60 KiB 之內
  if (/[\u0000-\u0008\u000b-\u001f]/.test(text)) return 'INVALID_TEXT'
  if ([...text].length > OUTBOUND_LIMITS.textMaxCodePoints) return 'TEXT_TOO_LONG'
  if (new TextEncoder().encode(text).byteLength > OUTBOUND_LIMITS.textMaxBytes) return 'TEXT_TOO_LONG'
  return null
}

/** 錯誤碼 → 給使用者看的短原因（不含任何 SDK 訊息、聊天內容或識別碼）。 */
const OUTBOUND_ERROR_TEXT: Readonly<Record<string, string>> = Object.freeze({
  INVALID_REQUEST_ID: '送出識別碼無效',
  INVALID_KIND: '送出類型無效',
  INVALID_CHAT: '此聊天室不支援傳送',
  CHAT_UNSUPPORTED: '此聊天室不支援傳送',
  CHAT_NOT_FOUND: '找不到這個聊天室',
  ACCOUNT_MISMATCH: '登入的 LINE 帳號與目前讀取的 LINE 不同',
  ACCOUNT_UNVERIFIED: '無法確認登入的 LINE 帳號',
  SESSION_NOT_READY: '尚未登入 LINE',
  SESSION_CHANGED: 'LINE 登入狀態已變更',
  INVALID_TEXT: '訊息不可空白或含不支援的字元',
  TEXT_TOO_LONG: '訊息太長',
  EMPTY_FILE: '檔案是空的',
  ATTACHMENT_TOO_LARGE: '檔案超過 25 MB',
  INVALID_IMAGE_TYPE: '圖片須為 JPEG、PNG、GIF 或 WebP',
  STAGE_BUSY: '已有附件準備中',
  STAGE_EXPIRED: '附件準備逾時',
  STAGE_OFFSET_MISMATCH: '附件上傳順序錯誤',
  STAGE_CHUNK_INVALID: '附件資料損毀',
  STAGE_INTEGRITY_MISMATCH: '附件內容與選取的檔案不符',
  STAGE_INCOMPLETE: '附件尚未上傳完整',
  STAGE_IO: '附件暫存失敗',
  OUTBOUND_BUSY: '另一則訊息正在傳送',
  CHAT_UNRESOLVED_UNKNOWN: '此聊天室有一則無法確認的訊息',
  JOURNAL_FULL: '待確認的傳送紀錄已滿',
  JOURNAL_IO: '無法記錄傳送狀態',
  ALREADY_DISPATCHED: '這次傳送已處理過',
  REQUEST_ID_CONFLICT: '送出識別碼已用於其他聊天室',
  REQUEST_FENCED: '這次傳送已確認未送出',
  SDK_UNAVAILABLE: '目前的 LINE 連線不支援此傳送',
  SEND_PREPARATION_FAILED: '傳送準備失敗',
  SDK_SEND_REJECTED: 'LINE 拒絕了這則訊息',
  OBS_UPLOAD_REJECTED: 'LINE 未接受附件上傳',
  LINEJS_URL_DENIED: '連線位址不在允許清單',
  CLIENT_CLOSED: 'LINE 連線已關閉',
  NOT_RECEIVED: '傳送請求沒有送達',
  linejs_outbound_unavailable: '傳送功能目前無法使用',
  invalid_args: '請求格式無效',
  request_too_large: '訊息太長'
})

export function outboundErrorText(code: string): string {
  return Object.prototype.hasOwnProperty.call(OUTBOUND_ERROR_TEXT, code) ? OUTBOUND_ERROR_TEXT[code] : '傳送失敗'
}

/** 「無法確認」的原因（按需展開的「詳細」用）。 */
const UNKNOWN_REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  SEND_RESULT_UNKNOWN: '送出時連線中斷或逾時，LINE 可能已收到這則訊息。',
  SDK_RESULT_INVALID: 'LINE 有回應，但沒有回傳訊息識別碼。',
  SEND_INTERRUPTED: '傳送進行中時外掛重新啟動。',
  SEND_TIMEOUT_UNKNOWN: '傳送超過 10 分鐘仍沒有結果。',
  LOCAL_UNKNOWN: '送出後失去與外掛的連線，也無法查詢結果。'
})

export function outboundUnknownReason(code: string): string {
  return Object.prototype.hasOwnProperty.call(UNKNOWN_REASON_TEXT, code) ? UNKNOWN_REASON_TEXT[code] : 'LINE 可能已收到這則訊息。'
}
