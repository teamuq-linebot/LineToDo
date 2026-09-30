import OpenAI from 'openai'
import { makeQwen, listModels } from '../qwenClient'
import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  ProviderHealth,
  LlmProviderKind,
  LlmProviderId
} from './types'
import { LlmProviderError } from './types'

/**
 * httpOpenAi.ts — 第一個 LlmProvider 實作：OpenAI 相容 HTTP 端點（vLLM / qwen）。
 *
 * 這個檔案吸收了原本散在 extractor.ts 的**傳輸細節**（design.md §1.5 / §2.1）：
 *   response_format:{type:'json_schema'} ⇄ extra_body.guided_json 的 auto fallback、
 *   以及 message.content 的防呆取值。那些是「怎麼把 schema 送給這個端點」的問題，
 *   不是抽取語意，所以搬進 provider；extractor 只剩「組 request → 驗證輸出」。
 *
 * **行為與重構前完全相同**：送出的 request payload（model / temperature / messages /
 * response_format / guided_json）逐欄位一致，fallback 判定條件一字不改。
 * 逾時與重試沿用 OpenAI SDK 的 timeout + maxRetries（req.timeoutMs 對本 provider 忽略，
 * 以建構時的 timeoutMs 為準，避免同一件事兩層計時）。
 */

export interface HttpOpenAiProviderOptions {
  apiKey: string
  baseURL: string
  model: string
  /** 單次 request timeout（毫秒）；預設沿用 qwenClient 的 60s。 */
  timeoutMs?: number
  /** 失敗自動重試次數（SDK 內建）；預設沿用 qwenClient 的 1。 */
  maxRetries?: number
  /** Mocked transport for provider contract tests; production registry leaves this unset. */
  fetch?: typeof fetch
}

/** 從 completion 取出 assistant 文字內容（防呆）。原 extractor.contentOf。 */
function contentOf(res: OpenAI.Chat.Completions.ChatCompletion): string {
  const c = res.choices?.[0]?.message?.content
  if (typeof c !== 'string' || c.length === 0) {
    // 訊息文字刻意與重構前逐字相同（零行為改變）；型別升級為 LlmProviderError 以便日後分類。
    throw new LlmProviderError('bad_output', 'qwen 回應沒有可用的 message.content')
  }
  return c
}

/**
 * response_format 不被支援時的典型徵兆：HTTP 400 / 提到 response_format / json_schema 不支援。
 * 這類錯誤才值得 fallback；網路逾時等不該 fallback（直接往上拋）。
 * 原 extractor.looksLikeUnsupportedSchema，判定條件一字不改。
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

/** 原始訊息進 UI 前的截斷長度（SDK 有時會把整包 response body 塞進 message）。 */
const RAW_MESSAGE_MAX = 200

function rawMessage(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err)
  const s = m.trim().replace(/\s+/g, ' ')
  return s.length > RAW_MESSAGE_MAX ? `${s.slice(0, RAW_MESSAGE_MAX)}…` : s
}

/**
 * 把 OpenAI SDK 的錯誤分類成 LlmErrorCode（Batch 7）。
 *
 * **Batch 1 為什麼沒做**：當時 `LlmErrorCode` 沒有任何消費者，把 SDK 錯誤包成籠統中文
 * 只會讓診斷訊息變差。Batch 7 的熔斷器就是那個消費者——它要靠 code 分辨
 * 「401 金鑰錯了（重試沒用，立刻熔斷）」和「503 端點抖一下（下輪再試）」。
 *
 * **Batch 1 的顧慮怎麼處理**：只加分類、不取代訊息。userMessage = 分類前綴 + 原始 SDK
 * 訊息（截斷 200 字），資訊只增不減；完整原文另存 `detail`（只進 log）與 `cause`。
 * **認不出來的錯誤原樣往上拋**（不包成 `unknown`），維持 Batch 1 的行為與訊息。
 */
function classifyHttpError(err: unknown): LlmProviderError | null {
  // contentOf 等自家錯誤已經分類過，原樣放行（零行為改變）。
  if (err instanceof LlmProviderError) return err

  const e = err as { status?: number; code?: unknown }
  const status = typeof e?.status === 'number' ? e.status : undefined
  const sdkCode = typeof e?.code === 'string' ? e.code : ''
  const raw = rawMessage(err)

  // 連線類錯誤沒有 status，只能靠型別分辨。用 SDK 匯出的 class 做 instanceof
  // （而不是比對 err.name / constructor.name —— SDK 沒設 name，且打包後類名可能被壓縮）。
  // TimeoutError 繼承 ConnectionError，所以要先判 timeout。
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return new LlmProviderError('timeout', `AI 端點逾時未回應：${raw}`, raw, err)
  }
  // 額度用盡與短期限流都可能回 429，但語意天差地遠（前者重試無意義 → 熔斷；後者下輪再試）。
  if (sdkCode === 'insufficient_quota' || status === 402) {
    return new LlmProviderError('quota_exceeded', `AI 端點額度已用盡：${raw}`, raw, err)
  }
  if (status === 401 || status === 403) {
    return new LlmProviderError(
      'not_authenticated',
      `AI 端點驗證失敗（金鑰無效或無權限）：${raw}`,
      raw,
      err
    )
  }
  if (status === 429) {
    return new LlmProviderError('rate_limited', `AI 端點暫時限流：${raw}`, raw, err)
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new LlmProviderError('transport', `無法連線到 AI 端點：${raw}`, raw, err)
  }
  return null
}

class HttpOpenAiProvider implements LlmProvider {
  readonly id: LlmProviderId = 'http'
  readonly kind: LlmProviderKind = 'http'

  private readonly client: OpenAI
  private readonly model: string

  constructor(opts: HttpOpenAiProviderOptions) {
    this.model = opts.model
    this.client = makeQwen({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      timeoutMs: opts.timeoutMs,
      maxRetries: opts.maxRetries,
      fetch: opts.fetch
    })
  }

  /** OpenAI 風格：response_format:{type:'json_schema', json_schema}（新版 vLLM 相容）。 */
  private async callResponseFormat(req: LlmRequest, jsonSchema: NonNullable<LlmRequest['jsonSchema']>): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      temperature: req.temperature,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user }
      ],
      // jsonSchema 整包原封不動轉送（含 EXTRACT_JSON_SCHEMA 的 strict 欄位）。
      response_format: {
        type: 'json_schema',
        json_schema: jsonSchema as unknown as OpenAI.ResponseFormatJSONSchema['json_schema']
      }
    })
    return contentOf(res)
  }

  /** vLLM 原生：guided_json 走 extra body。SDK 第二參數可帶 body 合併進 request。 */
  private async callGuidedJson(req: LlmRequest, jsonSchema: NonNullable<LlmRequest['jsonSchema']>): Promise<string> {
    const res = await this.client.chat.completions.create(
      {
        model: this.model,
        temperature: req.temperature,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user }
        ]
      },
      {
        body: { guided_json: jsonSchema.schema }
      } as unknown as OpenAI.RequestOptions
    )
    return contentOf(res as OpenAI.Chat.Completions.ChatCompletion)
  }

  /** 純文字（無 schema 約束）。 */
  private async callPlain(req: LlmRequest): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      temperature: req.temperature,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user }
      ]
    })
    return contentOf(res)
  }

  /**
   * 錯誤分類只包在最外層：內層的 response_format ⇄ guided_json fallback 判定
   * （looksLikeUnsupportedSchema）看的仍是原始 SDK 錯誤，行為一字不改。
   */
  async complete(req: LlmRequest): Promise<LlmResponse> {
    try {
      return await this.doComplete(req)
    } catch (err) {
      const mapped = classifyHttpError(err)
      if (mapped) throw mapped
      throw err
    }
  }

  private async doComplete(req: LlmRequest): Promise<LlmResponse> {
    const startedAt = Date.now()
    let usedFallback = false
    let text: string

    if (req.jsonSchema) {
      const jsonSchema = req.jsonSchema
      // auto：先 response_format，遇「不支援」徵兆才 fallback guided_json。
      try {
        text = await this.callResponseFormat(req, jsonSchema)
      } catch (err) {
        if (!looksLikeUnsupportedSchema(err)) throw err
        usedFallback = true
        text = await this.callGuidedJson(req, jsonSchema)
      }
    } else {
      text = await this.callPlain(req)
    }

    return {
      text,
      // HTTP 回的就是字串，沒有原生結構化物件。
      structured: undefined,
      meta: {
        provider: this.id,
        model: this.model,
        durationMs: Date.now() - startedAt,
        usedFallback
      }
    }
  }

  /** 健檢：打 /v1/models。語意與現有 settings:testQwen 完全相同。 */
  async health(): Promise<ProviderHealth> {
    const res = await listModels(this.client)
    if (res.ok) {
      return {
        ok: true,
        summary: `連線正常，可用模型 ${res.models?.length ?? 0} 個`,
        details: { models: res.models }
      }
    }
    return {
      ok: false,
      summary: res.error ?? '連線失敗',
      code: 'transport',
      details: {}
    }
  }
}

/** 建立 HTTP provider。金鑰即用即丟：每次呼叫重新建立，不在模組層長存。 */
export function makeHttpProvider(opts: HttpOpenAiProviderOptions): LlmProvider {
  return new HttpOpenAiProvider(opts)
}
