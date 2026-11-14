/**
 * linejsOriginals.ts — Pro「舊訊息下載原檔」的共用契約（X6；history-download.md §6–§7、implementation-plan-v2.md X6）：
 * backend（dispatcher、OriginalDownloadService）與之後的 Pro UI（X7）都 import。純型別與常數，不依賴 DOM／Node。
 *
 * 路徑都在既有的 `linejsMedia` 方法組底下（pluginWire.ts），manifest 的 backendMethods 與權限不變。
 * `status` 只讀本地（ledger、檔案系統、app DB），永遠不呼叫 LINE：畫面可以每 1.5 s 輪詢它。
 */

export const LINEJS_ORIGINALS_PATHS = Object.freeze([
  'linejsMedia.original.request',
  'linejsMedia.original.status',
  'linejsMedia.original.cancel',
  'linejsMedia.original.batchStart',
  'linejsMedia.original.batchCancel'
] as const)

/**
 * 上限與節制（集中在這一個常數）。**待 P0b 校正**：間隔、每小時上限、401 暫停時限都是保守值，沒有用真 LINE 量過
 * （history-download.md §5.3、§9 U9）；P0b 結果出來後只改這裡。
 */
export const ORIGINALS_LIMITS = Object.freeze({
  /** 兩次 OBS 請求之間至少間隔（ms）。待 P0b 校正。 */
  requestIntervalMs: 1000,
  /** 每個帳號每小時最多幾次 OBS 請求（單格、批次、之後的接收共用）。待 P0b 校正。 */
  requestsPerHour: 200,
  /** 每小時上限的視窗（ms）。 */
  requestWindowMs: 60 * 60_000,
  /** 一次批次最多幾格（Manager 裁決：ct 1／2／14 都可以進批次）。 */
  batchMax: 50,
  /** 一次 status 最多查幾個 msgId。 */
  statusMax: 200,
  /** transient 失敗的自動重試次數上限（每次是一個 streamDownload 呼叫，裡面還有 X1 自己的 5 次）；達到就轉成 failed_retry_exhausted，只能手動重試。 */
  maxAttempts: 3,
  /** 手動重試的冷卻時間（ms，HD §5.1）。 */
  retryCooldownMs: 30_000,
  /** 自動重試前的等待（ms）。 */
  autoRetryDelayMs: 30_000,
  /** ledger 總筆數上限：超過時先淘汰 done（media-saved 才是事實來源）。 */
  ledgerTotalMax: 50_000,
  /** ledger 寫檔的最短間隔（ms）：每次 flush 重寫整份 JSON，所以合併成最多每這麼久一次（見 linejsOriginals.ts 檔頭的量測說明）。 */
  ledgerFlushMinIntervalMs: 2000,
  /** 磁碟空間不足後多久再試（ms）。 */
  diskRetryMs: 60_000
})

/** 一格的狀態（HD §7.3；failed_retry_exhausted 是 Manager 裁決的終態；unsupported 不給按鈕）。 */
export type OriginalState =
  | 'idle' | 'needs_login' | 'account_mismatch' | 'queued' | 'running' | 'paused'
  | 'failed' | 'failed_retry_exhausted' | 'expired' | 'forbidden' | 'undecryptable' | 'unsupported' | 'done'

export interface OriginalItemView {
  msgId: string
  state: OriginalState
  /** 只有分類碼（HD §5.1 的類別與固定碼），沒有路徑、檔名、聊天室名或 id 以外的資料。 */
  code?: string
  /** 影片、檔案下載中的進度（part 已寫入的位元組數）與宣告大小。 */
  bytesDone?: number
  declaredBytes?: number
  /** 可以再手動重試的時間（ms epoch；failed／failed_retry_exhausted 的冷卻）。 */
  retryAt?: number
  batchId?: string
}

export interface OriginalBatchView {
  batchId: string
  chatId: string
  total: number
  done: number
  failed: number
  expired: number
  remaining: number
  state: 'running' | 'finished' | 'cancelled'
}

export interface OriginalStatusView {
  items: OriginalItemView[]
  batch: OriginalBatchView | null
  /** 全域暫停（LINE 限流、每小時上限、磁碟空間不足、需要登入）。 */
  paused: { reason: 'rate_limited' | 'hourly_limit' | 'auth' | 'disk_low'; untilMs?: number } | null
}

export interface OriginalBatchStartView {
  batchId: string
  accepted: string[]
  /** 不進批次的格子與原因（已完成、不支援、終態…）。 */
  skipped: Array<{ msgId: string; state: OriginalState; code?: string }>
  /** 超過上限而沒有被看的 msgId 數。 */
  truncated: number
}
