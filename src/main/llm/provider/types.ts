/**
 * provider/types.ts — AI provider 抽象層的型別「單一真實來源」
 * （見 output/sw/ai-provider-cli-20260811/design.md §1）。
 *
 * 設計要點：
 * - 單一 `complete()`：兩個呼叫點（extract / draftReply）形狀相同，
 *   差別只在「輸出要不要被 schema 約束」→ 用 optional `req.jsonSchema` 分支，
 *   不拆成 completeText/completeJson（否則每個 provider 都要寫兩份幾乎一樣的程式碼）。
 * - **分工線**：provider 的責任到「拿到輸出」為止；JSON.parse 與 zod 驗證永遠在
 *   provider 之外（schema.ts / extractor.ts）。三個 provider 各自驗證＝三份漂移風險。
 *
 * 本檔只有型別與錯誤類別，不含任何 I/O，可被 main 與腳本自由 import。
 */

export type LlmProviderId = 'http' | 'claudeCli' | 'codexCli'

/** provider 的執行形態；上層據此調整併發與逾時策略（CLI 進程昂貴）。 */
export type LlmProviderKind = 'http' | 'cli'

export interface LlmRequest {
  /** system 角色內容。CLI provider 會與 user 併成單一 stdin payload。 */
  system: string
  /** user 角色內容（本專案一律是一段 JSON 字串）。 */
  user: string
  temperature?: number
  /**
   * 有值＝要求結構化 JSON 輸出。provider 應「盡力」在解碼層約束，
   * 但**不保證**輸出合法 —— 驗證一律由呼叫端做。
   * 形狀刻意與 EXTRACT_JSON_SCHEMA 對齊（{ name, schema, ... }），可直接整包傳入；
   * provider 應原封不動轉送（例如 HTTP 的 json_schema 需要其中的 `strict` 欄位）。
   */
  jsonSchema?: { name: string; schema: unknown }
  /** 單次呼叫 wall-clock 上限（ms）。CLI provider 必須自行實施；HTTP provider 以建構時設定為準。 */
  timeoutMs?: number
  /** 供上層取消（目前無呼叫端使用，但 CLI kill 需要它，先留）。 */
  signal?: AbortSignal
}

export interface LlmResponse {
  /** 一律有值：純文字模式＝模型輸出；結構化模式＝該結構的 JSON 文字表示。 */
  text: string
  /**
   * provider 原生就回「已解析物件」時填這裡（Claude 的 structured_output、Codex 的 out.json）。
   * 呼叫端優先用它，可省一次 JSON.parse。HTTP provider 永遠 undefined。
   */
  structured?: unknown
  meta: {
    provider: LlmProviderId
    model: string | null
    durationMs: number
    /** HTTP：是否退到 guided_json。CLI：是否用了 bad_output 重試。觀測用。 */
    usedFallback?: boolean
    /** Claude CLI 的 total_cost_usd 等；只進 log，不進 UI。 */
    costUsd?: number | null
  }
}

export type LlmErrorCode =
  | 'not_installed' // CLI 找不到執行檔
  | 'not_authenticated' // 未登入 / 金鑰無效
  | 'timeout' // 超過 timeoutMs，已 kill
  | 'rate_limited' // 429 / 短期限流，可重試
  | 'quota_exceeded' // 訂閱用量上限，短期內重試無意義
  | 'bad_output' // 拿到輸出但不是合法 JSON / 不符 zod
  | 'invalid_config' // 缺金鑰、baseUrl 亂填、execPath 指到不存在的檔
  | 'transport' // 網路 / spawn 失敗 / 進程異常退出
  | 'unknown'

export class LlmProviderError extends Error {
  readonly code: LlmErrorCode
  readonly userMessage: string
  readonly detail?: string
  override readonly cause?: unknown
  constructor(
    code: LlmErrorCode,
    /** 給使用者看的繁中訊息（會直接進 UI，不可含路徑以外的技術細節）。 */
    userMessage: string,
    /** 只進 log 的細節（stderr 摘要、exit code、原始 error）。 */
    detail?: string,
    cause?: unknown
  ) {
    super(userMessage)
    this.code = code
    this.userMessage = userMessage
    this.detail = detail
    this.cause = cause
    this.name = 'LlmProviderError'
  }

  /** 「同一輪再試一次可能會好」= true；「先去修設定/登入」= false。 */
  get retryable(): boolean {
    return this.code === 'rate_limited' || this.code === 'transport' || this.code === 'bad_output'
  }
}

/** 設定頁「檢查/測試」的回傳形狀（取代 HTTP 專屬的 listModels 結果）。 */
export interface ProviderHealth {
  ok: boolean
  /** UI 主訊息（繁中，單行）。 */
  summary: string
  code?: LlmErrorCode
  details: {
    installed?: boolean
    path?: string | null
    version?: string | null
    /** 低於版本下限時 false，但仍可能 ok:true（僅警告）。 */
    versionOk?: boolean
    /** CLI 無法確定時用 'unknown'（Codex 常態）。 */
    authenticated?: boolean | 'unknown'
    /** 只有 http provider 有。 */
    models?: string[]
  }
}

export interface LlmProvider {
  readonly id: LlmProviderId
  readonly kind: LlmProviderKind
  complete(req: LlmRequest): Promise<LlmResponse>
  /** 設定頁「檢查/測試」用。不得快取結果（登入狀態隨時會變）。 */
  health(): Promise<ProviderHealth>
}
