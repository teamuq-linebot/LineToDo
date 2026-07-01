import OpenAI from 'openai'

/**
 * qwenClient.ts — qwen（OpenAI 相容 / vLLM）client 工廠（IMPLEMENTATION_PLAN.md §6.1）。
 *
 * - baseURL 預設 https://qwen.tuq.tw/v1、model 預設 qwen36-fp8（呼叫端從設定/env 取）。
 * - apiKey 由呼叫端從 safeStorage 解密 / env 取後「即用即丟」傳入；此處不讀環境、不持久化。
 * - 結構化輸出走 response_format json_schema（vLLM guided_json）；fallback 在 extractor 處理。
 * - 單次 request timeout 由 timeoutMs 控；失敗該 chat 標 partial、不中斷整輪（呼叫端負責）。
 */

export interface MakeQwenOpts {
  apiKey: string
  baseURL: string
  /** 單次 request timeout（毫秒）。 */
  timeoutMs?: number
  /** 失敗自動重試次數（openai SDK 內建）；預設 1，避免拖慢整輪。 */
  maxRetries?: number
}

/** 建立 qwen client。dangerouslyAllowBrowser 不需要（僅 main 進程使用）。 */
export function makeQwen(opts: MakeQwenOpts): OpenAI {
  return new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    timeout: opts.timeoutMs ?? 60_000,
    maxRetries: opts.maxRetries ?? 1
  })
}

/**
 * 連線/金鑰健檢：打 /v1/models。成功回 model id 清單，失敗回 error 字串。
 * 給設定頁 settings:testQwen（M3）與 scripts/smoke-qwen.mjs 共用語意。
 */
export async function listModels(
  client: OpenAI
): Promise<{ ok: boolean; models?: string[]; error?: string }> {
  try {
    const res = await client.models.list()
    const models = res.data.map((m) => m.id)
    return { ok: true, models }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
