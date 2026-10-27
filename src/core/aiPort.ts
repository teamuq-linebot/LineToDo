/**
 * aiPort.ts — core 的 AI port（0.2.0）。
 *
 * 外掛 backend 的 AI 介面：給 system＋user，等一個完整的文字回覆（需要時是驗證過的 JSON）。core 本身仍然只認 `LlmProvider`
 * （`src/main/llm/provider/types.ts`），這個 port 不是 core 的依賴：
 *   - 背景抽取：`ExtractWorker`（`src/plugin/backend/extractWorker.ts`）直接呼叫 port；
 *   - 草擬回覆／誤判分析／群組議題分析：`aiProvider.ts` 把 port 包成 `LlmProvider`，由組裝根注入 core；
 *   - 實作：`src/plugin/backend/hostAi.ts` 接 TeamUQ 的 `context.host.ai.complete`（Core >=1.7.13），配額、退避、重問都在那裡。
 * standalone 版維持原本的 `LlmProvider`（http／CLI），不經過這個 port。
 *
 * 純型別＋一個錯誤類別；不 import 任何東西（不依賴 Node／DOM）。
 */

/** `user`＝使用者按按鈕觸發（草擬回覆、誤判分析…），排在背景抽取之前，並使用保留給它的輪數；`background`＝背景抽取。 */
export type AiPriority = 'user' | 'background'

export type AiJsonCheck = (value: unknown) => { ok: true; value: unknown } | { ok: false; reason: string }

export interface AiPortRequest {
  system: string
  user: string
  /** 外掛內部的對話連續性提示；只供 LINE Todo 抽取使用，不會送給 Host AI API。 */
  conversationScope?: { kind: 'line-chat-extract'; chatId: string }
  /** 回覆必須是一個 JSON 物件：port 取出 JSON、用 `validate` 驗證，不合格時最多重問一次。 */
  expectJson: boolean
  validate?: AiJsonCheck
  priority: AiPriority
}

export interface AiPortResult {
  /** 回覆文字；`expectJson` 時是驗證過的 JSON 重新序列化的字串。 */
  text: string
  /** `expectJson` 時解析並驗證過的值。 */
  value?: unknown
  /** 實際使用的模型 id（未知＝null）。 */
  model: string | null
}

/**
 * port 的失敗。`code` 是固定小寫代碼：
 *   - 「不是這一項的錯」：`rate_limited`、`quota_exhausted`、`provider_*`／`model_unavailable`／`unsupported_version`、`busy`／`session_limit`…，
 *     呼叫端應稍後重試（`retryAfterMs` 是建議的等待）；
 *   - `access_revoked`／`not_granted`／`plugin_not_active`：使用者關掉了 `ai:chat`；
 *   - 其餘（`empty_reply`、`invalid_json`、`invalid_result`、`input_too_large`、`turn_timeout`…）：這一項本輪失敗。
 */
export class AiPortError extends Error {
  readonly code: string
  readonly retryAfterMs: number | null
  /** `rate_limited` 是我們自己的滑動視窗擋下來時，是哪個視窗滿了（錯誤文字依它說每分鐘或每小時）；host 回的 rate_limited 看不出來＝undefined。 */
  readonly scope: 'minute' | 'hour' | undefined
  constructor(code: string, retryAfterMs: number | null = null, scope?: 'minute' | 'hour') {
    super(code)
    this.name = 'AiPortError'
    this.code = code
    this.retryAfterMs = retryAfterMs
    this.scope = scope
  }
}

export interface AiPort {
  complete(request: AiPortRequest): Promise<AiPortResult>
}
