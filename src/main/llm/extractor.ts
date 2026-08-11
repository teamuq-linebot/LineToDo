import { EXTRACT_SYSTEM_PROMPT, buildUserPayload } from './extractPrompt'
import type { BuildUserPayloadInput } from './extractPrompt'
import { EXTRACT_JSON_SCHEMA, validateExtractResult } from './schema'
import type { ExtractResult } from './schema'
import type { LlmProvider } from './provider/types'

/**
 * extractor.ts — 單一 chat 的抽取核心（IMPLEMENTATION_PLAN.md §6.1）。
 *
 * 職責只剩兩件事：組 request（system prompt + user payload + json schema）、驗證輸出。
 * 「怎麼把 schema 送給端點」（response_format ⇄ guided_json fallback）屬傳輸細節，
 * 已搬進 provider/httpOpenAi.ts（design.md §1.5）。
 *
 * 失敗（網路 / 逾時 / 解析 / 驗證）一律 throw；pipeline 呼叫端 catch 後把該 chat 標 partial、
 * 不中斷整輪（§6.1 / §8）。本模組不碰 DB、不讀金鑰，純函式好測。
 */

export interface ExtractOptions {
  temperature?: number
  /** 單次呼叫 wall-clock 上限（ms）。HTTP provider 忽略（以建構時設定為準）。 */
  timeoutMs?: number
}

/**
 * 對單一 chat 做抽取。input 同 buildUserPayload 的入參。
 * 回傳已驗證的 ExtractResult。任何階段失敗 throw。
 */
export async function extractTodos(
  provider: LlmProvider,
  input: BuildUserPayloadInput,
  opts: ExtractOptions
): Promise<ExtractResult> {
  const res = await provider.complete({
    system: EXTRACT_SYSTEM_PROMPT,
    user: buildUserPayload(input),
    temperature: opts.temperature ?? 0.1,
    jsonSchema: EXTRACT_JSON_SCHEMA,
    timeoutMs: opts.timeoutMs
  })

  // provider 原生回物件時直接用（省一次 stringify→parse 往返）；否則 parse 文字。
  const value = res.structured !== undefined ? res.structured : (JSON.parse(res.text) as unknown)
  return validateExtractResult(value)
}
