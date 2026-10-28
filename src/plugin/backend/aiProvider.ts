/**
 * aiProvider.ts — 把 core 的 `LlmProvider.complete()` 接到 AI port（0.2.0）。
 *
 * 草擬回覆／誤判分析／群組議題分析三項在 standalone 都是 `provider.complete(system, user)` 的單次呼叫，之後的 parse／驗證／落庫都在 core
 * （application／groupTopics service）。為了不複製那三份邏輯，外掛 backend 注入這個 provider：`complete()` 直接 `await port.complete()`，
 * port 在 backend 經 TeamUQ 的 `context.host.ai.complete` 完成（`hostAi.ts`；配額、退避、JSON 重問都在那裡）。看板不需要開著。
 *
 *   core 呼叫 provider.complete() ──► AiPort.complete({ priority: 'user' }) ──► context.host.ai.complete ──► 文字回來 ──► core 照原本的流程驗證與落庫
 *
 * 這些是使用者按按鈕觸發的前景工作，不重試、不退避；失敗就把原因（`AiPortError.code`）轉成 `LlmProviderError`，由 UI 顯示給使用者。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { AiPortError } from '../../core/aiPort'
import type { AiPort } from '../../core/aiPort'
import { LlmProviderError } from '../../main/llm/provider/types'
import type { LlmErrorCode, LlmProvider, LlmRequest, LlmResponse } from '../../main/llm/provider/types'
import { AI_CHAT_ALLOW_STEPS } from '../../shared/teamuqPlaces'
import { outputContractFor } from './aiOutputContract'

export type AiTaskKind = 'draftReply' | 'analyzeNotMine' | 'groupTopics' | 'promptRefine' | 'unknown'

/** 使用者可以從畫面觸發的 AI 功能：kind → application 的 api 路徑（dispatcher 用）。 */
export const AI_RUN_PATHS: Readonly<Record<'draftReply' | 'analyzeNotMine' | 'groupTopics', string>> = Object.freeze({
  draftReply: 'db.todos.draftReply',
  analyzeNotMine: 'db.todos.analyzeNotMine',
  groupTopics: 'groupTopics.analyze'
})

/** `AI_CHAT_LIMITS.inputChars` 是 8000；留餘裕。 */
export const AI_TASK_MAX_USER_CHARS = 7500

const kindStore = new AsyncLocalStorage<AiTaskKind>()

/** 在這個 callback 內發出的 `provider.complete()` 會被標上 kind（決定要不要要求 JSON）。 */
export function runAs<T>(kind: AiTaskKind, run: () => T): T { return kindStore.run(kind, run) }

/** ai:chat／port 的失敗代碼 → core 看得懂的 `LlmProviderError`（userMessage 會直接顯示給使用者）。 */
export function toProviderError(error: unknown): LlmProviderError {
  const code = error instanceof AiPortError ? error.code : 'provider_error'
  const retry = error instanceof AiPortError ? error.retryAfterMs : null
  const scope = error instanceof AiPortError ? error.scope : undefined
  const wait = retry !== null && retry > 0 ? `（約 ${Math.max(1, Math.ceil(retry / 1000))} 秒後可再試）` : ''
  const make = (llm: LlmErrorCode, message: string): LlmProviderError => new LlmProviderError(llm, message, `ai:chat/${code}`)
  switch (code) {
    case 'ai_task_timeout': return make('timeout', 'AI 回覆逾時，請稍後再試')
    case 'turn_timeout':
    case 'stalled': return make('timeout', 'AI 回覆逾時，請稍後再試')
    // 哪個視窗滿了就說哪個（review F9）；host 回的 rate_limited 看不出是分鐘還是小時，就只說「呼叫上限」。
    case 'rate_limited': return make('rate_limited', `AI 呼叫太頻繁（已達 TeamUQ 的${scope === 'minute' ? '每分鐘' : scope === 'hour' ? '每小時' : ' AI 呼叫'}上限）${wait}`)
    case 'quota_exhausted': return make('quota_exceeded', `AI 額度已用完${wait}`)
    case 'provider_unavailable':
    case 'provider_not_ready':
    case 'provider_not_found':
    case 'unsupported_version':
    case 'model_unavailable':
    case 'unavailable': return make('invalid_config', 'TeamUQ 的 Codex 目前無法使用（請確認已安裝、已登入、版本符合）')
    case 'plugin_host_timeout':
    case 'plugin_host_unavailable': return make('transport', `TeamUQ 的 AI 暫時沒有回應，請稍後再試${wait}`)
    case 'not_granted':
    case 'plugin_not_active':
    // 0.1.3 r1：不寫「TeamUQ 設定」（1.7.1 的外掛管理不在「設定」裡）；位置與開關標題見 src/shared/teamuqPlaces.ts。
    case 'access_revoked': return make('invalid_config', `此外掛的 AI 權限（ai:chat）已被關閉，${AI_CHAT_ALLOW_STEPS}`)
    case 'invalid_json':
    case 'invalid_result': return make('bad_output', 'AI 回覆的格式不正確')
    case 'empty_reply': return make('bad_output', 'AI 沒有回覆內容')
    case 'reply_too_long': return make('bad_output', 'AI 回覆過長')
    case 'input_too_large':
    case 'system_too_large': return make('invalid_config', '送給 AI 的內容超過單輪上限（8,000 字），請縮小範圍後再試')
    case 'busy':
    case 'session_limit':
    case 'turn_in_progress': return make('rate_limited', 'AI 正在處理其他工作，請稍後再試')
    case 'backend_stopped': return make('transport', '外掛正在停止')
    case 'interrupted': return make('transport', 'AI 回覆被中斷')
    default: return make('unknown', 'AI 暫時無法完成這個動作')
  }
}

/**
 * groupTopics 的 user payload（`{existingLocalTopics, messages}`）可能超過 ai:chat 的單輪 8,000 字：
 * 先丟最舊的既有議題，再把過長的訊息文字縮短（assignments 必須涵蓋每則訊息，所以不能丟訊息）。其他形狀的 payload 原樣檢查長度。
 */
export function fitUserPayload(user: string, maxChars: number): string {
  if (user.length <= maxChars) return user
  let parsed: unknown
  try { parsed = JSON.parse(user) } catch { throw new AiPortError('input_too_large') }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AiPortError('input_too_large')
  const root = parsed as { existingLocalTopics?: unknown[]; messages?: Array<{ text?: unknown }> }
  const render = (): string => JSON.stringify(root)
  if (Array.isArray(root.existingLocalTopics)) {
    while (root.existingLocalTopics.length > 0 && render().length > maxChars) root.existingLocalTopics.pop()
  }
  if (Array.isArray(root.messages)) {
    let cap = 400
    while (render().length > maxChars && cap >= 20) {
      for (const message of root.messages) if (typeof message.text === 'string' && message.text.length > cap) message.text = `${message.text.slice(0, cap)}…`
      cap = Math.floor(cap / 2)
    }
  }
  const text = render()
  if (text.length > maxChars) throw new AiPortError('input_too_large')
  return text
}

export interface PortAiProviderOptions {
  /** meta.provider 與 provider.id：ai:chat 目前只有 Codex（aiChatComposition.ts:19,28）。 */
  id?: 'codexCli'
  /** 為 true＝port 現在不會馬上拒絕（`health()` 用）。 */
  usable?(): boolean
}

/** core 的 `providers.resolveProvider()` 回傳這個：complete() 交給 AI port，不碰任何網路或行程。 */
export function createPortAiProvider(port: AiPort, options: PortAiProviderOptions = {}): LlmProvider {
  const id = options.id ?? 'codexCli'
  return {
    id,
    kind: 'cli',
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const started = Date.now()
      const kind = kindStore.getStore() ?? 'unknown'
      const expectJson = req.jsonSchema !== undefined || kind === 'analyzeNotMine' || kind === 'groupTopics'
      try {
        const system = req.jsonSchema ? `${req.system}\n\n${outputContractFor(req.jsonSchema.schema)}` : req.system
        const user = fitUserPayload(req.user, AI_TASK_MAX_USER_CHARS)
        const result = await port.complete({ system, user, expectJson, priority: 'user', ...(req.onAdditionalUserPayload ? { onAdditionalUserPayload: req.onAdditionalUserPayload } : {}) })
        return { text: result.text, meta: { provider: id, model: result.model, durationMs: Date.now() - started } }
      } catch (error) {
        throw toProviderError(error)
      }
    },
    async health() {
      return options.usable?.() === false
        ? { ok: false, code: 'invalid_config', summary: 'TeamUQ 的 AI 目前無法使用', details: {} }
        : { ok: true, summary: 'AI 由 TeamUQ 的 ai:chat 提供（外掛背景程式經 host.ai.complete 執行）', details: {} }
    },
    async runtimeFingerprint() {
      const selection = await port.effectiveSelection?.()
      return selection ? createHash('sha256').update(JSON.stringify(selection), 'utf8').digest('hex') : null
    }
  }
}
