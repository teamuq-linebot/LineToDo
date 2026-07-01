import type OpenAI from 'openai'
import { EXTRACT_SYSTEM_PROMPT, buildUserPayload } from './extractPrompt'
import type { BuildUserPayloadInput } from './extractPrompt'
import { EXTRACT_JSON_SCHEMA, parseExtractResult } from './schema'
import type { ExtractResult } from './schema'

/**
 * extractor.ts — 單一 chat 的抽取核心（IMPLEMENTATION_PLAN.md §6.1）。
 *
 * 呼叫一次 qwen chat.completions，要求 guided_json 約束輸出，回 ExtractResult。
 * 結構化輸出兩種形態（§6.3 備註）：
 *   先試 response_format:{type:'json_schema', json_schema}（OpenAI 風格 / 新版 vLLM）。
 *   若該 vLLM 版本不認 → fallback 用 extra_body:{ guided_json: schema }（vLLM 原生）。
 * 兩者皆要求純 JSON 回應，再以 zod 二次驗證（parseExtractResult）。
 *
 * 失敗（網路 / 逾時 / 解析 / 驗證）一律 throw；pipeline 呼叫端 catch 後把該 chat 標 partial、
 * 不中斷整輪（§6.1 / §8）。本模組不碰 DB、不讀金鑰，純函式好測。
 */

export interface ExtractOptions {
  model: string
  temperature?: number
  /**
   * 結構化輸出模式：
   *   'auto'          先試 response_format，失敗（400/不支援）再 fallback guided_json（預設）
   *   'response_format' 只用 response_format
   *   'guided_json'   只用 vLLM extra_body.guided_json
   */
  structuredMode?: 'auto' | 'response_format' | 'guided_json'
}

/** 從 completion 取出 assistant 文字內容（防呆）。 */
function contentOf(res: OpenAI.Chat.Completions.ChatCompletion): string {
  const c = res.choices?.[0]?.message?.content
  if (typeof c !== 'string' || c.length === 0) {
    throw new Error('qwen 回應沒有可用的 message.content')
  }
  return c
}

async function callResponseFormat(
  qwen: OpenAI,
  model: string,
  temperature: number,
  system: string,
  user: string
): Promise<string> {
  const res = await qwen.chat.completions.create({
    model,
    temperature,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    // OpenAI 型別的 json_schema 形態；vLLM 新版相容。
    response_format: {
      type: 'json_schema',
      json_schema: EXTRACT_JSON_SCHEMA
    }
  })
  return contentOf(res)
}

async function callGuidedJson(
  qwen: OpenAI,
  model: string,
  temperature: number,
  system: string,
  user: string
): Promise<string> {
  // vLLM 原生：guided_json 走 extra body。openai SDK 第二參數可帶 body 合併進 request。
  const res = await qwen.chat.completions.create(
    {
      model,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    },
    {
      body: { guided_json: EXTRACT_JSON_SCHEMA.schema }
    } as unknown as OpenAI.RequestOptions
  )
  return contentOf(res as OpenAI.Chat.Completions.ChatCompletion)
}

/**
 * response_format 不被支援時的典型徵兆：HTTP 400 / 提到 response_format / json_schema 不支援。
 * 這類錯誤才值得 fallback；網路逾時等不該 fallback（直接往上拋）。
 */
function looksLikeUnsupportedSchema(err: unknown): boolean {
  const status = (err as { status?: number })?.status
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  if (status === 400) return true
  return (
    msg.includes('response_format') ||
    msg.includes('json_schema') ||
    msg.includes('not support') ||
    msg.includes('unsupported')
  )
}

/**
 * 對單一 chat 做抽取。input 同 buildUserPayload 的入參。
 * 回傳已驗證的 ExtractResult。任何階段失敗 throw。
 */
export async function extractTodos(
  qwen: OpenAI,
  input: BuildUserPayloadInput,
  opts: ExtractOptions
): Promise<ExtractResult> {
  const temperature = opts.temperature ?? 0.1
  const mode = opts.structuredMode ?? 'auto'
  const user = buildUserPayload(input)

  let raw: string
  if (mode === 'guided_json') {
    raw = await callGuidedJson(qwen, opts.model, temperature, EXTRACT_SYSTEM_PROMPT, user)
  } else if (mode === 'response_format') {
    raw = await callResponseFormat(qwen, opts.model, temperature, EXTRACT_SYSTEM_PROMPT, user)
  } else {
    // auto：先 response_format，遇「不支援」徵兆才 fallback guided_json。
    try {
      raw = await callResponseFormat(qwen, opts.model, temperature, EXTRACT_SYSTEM_PROMPT, user)
    } catch (err) {
      if (!looksLikeUnsupportedSchema(err)) throw err
      raw = await callGuidedJson(qwen, opts.model, temperature, EXTRACT_SYSTEM_PROMPT, user)
    }
  }

  return parseExtractResult(raw)
}
