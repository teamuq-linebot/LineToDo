/**
 * aiTaskQueue.ts — 外掛版「單次 AI 呼叫」的橋接（設計 v2 §4.3 附帶：draftReply／analyzeNotMine／groupTopics.analyze）。
 *
 * 1.6.8 的 backend 沒有 AI（`ai:chat` 只在 view 端），而且 backend 不得呼叫 LLM。草擬回覆、誤判分析、群組議題分析三項在
 * standalone 都是 `provider.complete(system, user)` 的單次呼叫，之後的 parse／驗證／落庫都在 core（application／groupTopics service）。
 * 為了不複製那三份邏輯，外掛 backend 注入一個「UI 中轉 provider」：
 *
 *   core 呼叫 provider.complete() ──► AiTaskQueue.request()（只是排隊，不打任何 LLM）
 *        UI orchestrator 經 `ai.pull` 領走 ──► 用 ai:chat 完成（可見性／配額／重試都在 UI）──► `ai.commit` 把文字交回
 *   request() resolve ──► core 照原本的流程驗證與落庫
 *
 * 所以 backend 一個 byte 的 LLM 流量都沒有；它只是把 `complete()` 變成「排隊 + 等 UI 回文字」。
 *
 * 與 ExtractQueue 的差異：這些是使用者按按鈕觸發的前景工作，不重試、不退避；失敗就把原因（`failCode`）回給呼叫端，
 * 由 UI 顯示給使用者。UI 端沒有在領取（看板不在前景、沒連上 ai:chat）時，request() 立刻失敗（`ui_not_connected`），不空等。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { LlmProviderError } from '../../main/llm/provider/types'
import type { LlmErrorCode, LlmProvider, LlmRequest, LlmResponse } from '../../main/llm/provider/types'
import { AI_COMMIT_TEXT_MAX_BYTES, utf8Bytes } from '../../shared/pluginWire'
import { outputContractFor } from './aiOutputContract'

export type AiTaskKind = 'draftReply' | 'analyzeNotMine' | 'groupTopics' | 'unknown'

/** `ai.run` 允許的呼叫：kind → application 的 api 路徑（dispatcher 用）。 */
export const AI_RUN_PATHS: Readonly<Record<Exclude<AiTaskKind, 'unknown'>, string>> = Object.freeze({
  draftReply: 'db.todos.draftReply',
  analyzeNotMine: 'db.todos.analyzeNotMine',
  groupTopics: 'groupTopics.analyze'
})

/** `AI_CHAT_LIMITS.inputChars` 是 8000；留餘裕。 */
export const AI_TASK_MAX_USER_CHARS = 7500
/** `AI_CHAT_LIMITS.systemChars`。 */
export const AI_TASK_MAX_SYSTEM_CHARS = 16_000

const DEFAULT_TIMEOUT_MS = 6 * 60_000
const DEFAULT_LEASE_MS = 5 * 60_000
const DEFAULT_CONSUMER_FRESH_MS = 45_000
const DEFAULT_MAX_QUEUED = 8

export class AiTaskError extends Error {
  readonly code: string
  readonly retryAfterMs: number | null
  constructor(code: string, retryAfterMs: number | null = null) {
    super(code)
    this.name = 'AiTaskError'
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

export interface AiTaskRequest {
  kind: AiTaskKind
  system: string
  user: string
  /** 呼叫端會 `JSON.parse` 結果：UI 要先確認是合法 JSON（並在需要時重問一次）。 */
  expectJson: boolean
}

export interface AiTaskPullItem {
  /** 本次租約的 id；commit 必須帶回。 */
  taskId: string
  kind: AiTaskKind
  system: string
  user: string
  expectJson: boolean
  systemChars: number
  userChars: number
  /** 離呼叫端放棄還有多久。 */
  expiresInMs: number
}

export interface AiTaskCommitItem {
  taskId: string
  ok: boolean
  text?: string
  /** UI 實際用的模型（寫進 meta，誤判分析會存成 modelId）。 */
  model?: string
  failCode?: string
  retryAfterMs?: number
}

export type AiTaskCommitStatus = 'accepted' | 'failed_recorded' | 'unknown_task' | 'bad_request'
export interface AiTaskCommitResult { taskId: string; status: AiTaskCommitStatus; code?: string }

export interface AiTaskQueueOptions {
  now?(): number
  /** 呼叫端最久等多久（含排隊）。預設 6 分鐘（UI 單輪逾時 150 s、含一次 JSON 重問）。 */
  timeoutMs?: number
  leaseMs?: number
  /** 多久內有 UI 來領過才算「UI 在線」。預設 45 s（UI 閒置輪詢 15 s）。 */
  consumerFreshMs?: number
  maxQueued?: number
  /** 有可領項目時通知（外掛接到事件通道）。 */
  onPending?(info: { pending: number; tasks: true }): void
}

interface Task {
  id: string
  req: AiTaskRequest
  state: 'pending' | 'leased'
  leaseId: string | null
  leaseUntil: number
  expiresAt: number
  resolve(value: { text: string; model: string | null }): void
  reject(error: Error): void
  timer: NodeJS.Timeout | null
  settled: boolean
}

const kindStore = new AsyncLocalStorage<AiTaskKind>()

export class AiTaskQueue {
  private readonly opts: AiTaskQueueOptions
  private readonly tasks = new Map<string, Task>()
  private lastTouch: number | null = null
  private disposed = false

  constructor(opts: AiTaskQueueOptions = {}) {
    this.opts = opts
  }

  private now(): number { return this.opts.now ? this.opts.now() : Date.now() }

  /** 在這個 callback 內發出的 `provider.complete()` 會被標上 kind（UI 據此判斷要不要驗 JSON）。 */
  runAs<T>(kind: AiTaskKind, run: () => T): T { return kindStore.run(kind, run) }

  /** UI 來領過（`ai.pull`／`extract.pull`）：記下「UI 在線」。 */
  touch(): void { this.lastTouch = this.now() }

  consumerActive(): boolean {
    return this.lastTouch !== null && this.now() - this.lastTouch <= (this.opts.consumerFreshMs ?? DEFAULT_CONSUMER_FRESH_MS)
  }

  /** 排隊等 UI 用 ai:chat 完成；resolve 模型文字，失敗 reject `AiTaskError(code)`。 */
  request(req: AiTaskRequest): Promise<{ text: string; model: string | null }> {
    if (this.disposed) return Promise.reject(new AiTaskError('backend_stopped'))
    if (!this.consumerActive()) return Promise.reject(new AiTaskError('ui_not_connected'))
    if (req.system.length > AI_TASK_MAX_SYSTEM_CHARS) return Promise.reject(new AiTaskError('system_too_large'))
    if (req.user.length > AI_TASK_MAX_USER_CHARS) return Promise.reject(new AiTaskError('input_too_large'))
    if (this.tasks.size >= (this.opts.maxQueued ?? DEFAULT_MAX_QUEUED)) return Promise.reject(new AiTaskError('ai_queue_full'))
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const task: Task = {
        id, req, state: 'pending', leaseId: null, leaseUntil: 0, expiresAt: this.now() + timeoutMs, resolve, reject, timer: null, settled: false
      }
      task.timer = setTimeout(() => this.fail(task, new AiTaskError('ai_task_timeout')), timeoutMs)
      task.timer.unref?.()
      this.tasks.set(id, task)
      this.announce()
    })
  }

  pull(params: { max?: number; leaseMs?: number } = {}): { ok: true; tasks: AiTaskPullItem[]; pending: number; leased: number } {
    this.touch()
    this.reap()
    const now = this.now()
    const max = Math.min(Math.max(1, Math.floor(params.max ?? 1)), 4)
    const leaseMs = Math.min(Math.max(1000, params.leaseMs ?? this.opts.leaseMs ?? DEFAULT_LEASE_MS), 10 * 60_000)
    const items: AiTaskPullItem[] = []
    for (const task of this.tasks.values()) {
      if (task.state !== 'pending') continue
      task.state = 'leased'
      task.leaseId = randomUUID()
      task.leaseUntil = now + leaseMs
      items.push({
        taskId: task.leaseId, kind: task.req.kind, system: task.req.system, user: task.req.user, expectJson: task.req.expectJson,
        systemChars: task.req.system.length, userChars: task.req.user.length, expiresInMs: Math.max(0, task.expiresAt - now)
      })
      if (items.length >= max) break
    }
    return { ok: true, tasks: items, pending: this.count('pending'), leased: this.count('leased') }
  }

  commit(params: { results: AiTaskCommitItem[] }): { ok: true; results: AiTaskCommitResult[] } {
    this.reap()
    const leased = new Map<string, Task>()
    for (const task of this.tasks.values()) if (task.state === 'leased' && task.leaseId) leased.set(task.leaseId, task)
    const out: AiTaskCommitResult[] = []
    for (const item of params.results) {
      const taskId = typeof item?.taskId === 'string' ? item.taskId : ''
      if (!taskId || typeof item.ok !== 'boolean') { out.push({ taskId, status: 'bad_request', code: 'invalid_commit_item' }); continue }
      const task = leased.get(taskId)
      if (!task) { out.push({ taskId, status: 'unknown_task', code: 'lease_expired_or_unknown' }); continue }
      leased.delete(taskId)
      if (!item.ok) {
        const code = typeof item.failCode === 'string' && /^[a-z0-9_]{1,48}$/.test(item.failCode) ? item.failCode : 'ai_failed'
        const retry = typeof item.retryAfterMs === 'number' && Number.isFinite(item.retryAfterMs) && item.retryAfterMs >= 0 ? Math.floor(item.retryAfterMs) : null
        this.fail(task, new AiTaskError(code, retry))
        out.push({ taskId, status: 'failed_recorded', code })
        continue
      }
      if (typeof item.text !== 'string' || item.text.length === 0) { out.push({ taskId, status: 'bad_request', code: 'invalid_text' }); this.fail(task, new AiTaskError('empty_reply')); continue }
      // 上限用 UTF-8 位元組（與 view 端 60 KiB 的請求上限同一個單位）：字元數會讓中文回覆在 view 的 toWire 先被擋掉（review F8）。view 送出前以 fitReplyText() 保證不超過。
      if (utf8Bytes(item.text) > AI_COMMIT_TEXT_MAX_BYTES) { out.push({ taskId, status: 'bad_request', code: 'text_too_large' }); this.fail(task, new AiTaskError('reply_too_long')); continue }
      this.settle(task, { text: item.text, model: typeof item.model === 'string' && item.model.length > 0 ? item.model.slice(0, 96) : null })
      out.push({ taskId, status: 'accepted' })
    }
    return { ok: true, results: out }
  }

  /** UI 停止前把還沒做的工作還回去（不算失敗）。 */
  release(params: { taskIds: string[] }): { ok: true; released: number } {
    let released = 0
    for (const task of this.tasks.values()) {
      if (task.state === 'leased' && task.leaseId && params.taskIds.includes(task.leaseId)) {
        task.state = 'pending'
        task.leaseId = null
        task.leaseUntil = 0
        released += 1
      }
    }
    if (released > 0) this.announce()
    return { ok: true, released }
  }

  stats(): { pending: number; leased: number; consumerActive: boolean } {
    return { pending: this.count('pending'), leased: this.count('leased'), consumerActive: this.consumerActive() }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const task of [...this.tasks.values()]) this.fail(task, new AiTaskError('backend_stopped'))
    this.tasks.clear()
  }

  private count(state: Task['state']): number {
    let n = 0
    for (const task of this.tasks.values()) if (task.state === state) n += 1
    return n
  }

  private reap(): void {
    const now = this.now()
    for (const task of this.tasks.values()) {
      if (task.state === 'leased' && task.leaseUntil <= now) { task.state = 'pending'; task.leaseId = null; task.leaseUntil = 0 }
    }
  }

  private settle(task: Task, value: { text: string; model: string | null }): void {
    if (task.settled) return
    task.settled = true
    if (task.timer) clearTimeout(task.timer)
    this.tasks.delete(task.id)
    task.resolve(value)
  }

  private fail(task: Task, error: Error): void {
    if (task.settled) return
    task.settled = true
    if (task.timer) clearTimeout(task.timer)
    this.tasks.delete(task.id)
    task.reject(error)
  }

  private announce(): void {
    if (this.disposed) return
    const pending = this.count('pending')
    if (pending > 0) { try { this.opts.onPending?.({ pending, tasks: true }) } catch { /* 通知失敗不影響佇列 */ } }
  }
}

// ───────────────────────── UI 中轉 provider ─────────────────────────

/** ai:chat／UI 的失敗代碼 → core 看得懂的 `LlmProviderError`（userMessage 會直接顯示給使用者）。 */
export function toProviderError(error: unknown): LlmProviderError {
  const code = error instanceof AiTaskError ? error.code : 'provider_error'
  const retry = error instanceof AiTaskError ? error.retryAfterMs : null
  const wait = retry !== null && retry > 0 ? `（約 ${Math.max(1, Math.ceil(retry / 1000))} 秒後可再試）` : ''
  const make = (llm: LlmErrorCode, message: string): LlmProviderError => new LlmProviderError(llm, message, `ai:chat/${code}`)
  switch (code) {
    case 'ui_not_connected': return make('invalid_config', '看板不在前景，AI 暫時無法處理；請回到 LINE 待辦看板再試一次')
    case 'view_not_visible': return make('transport', '看板不在前景，AI 暫時無法處理；請回到 LINE 待辦看板再試一次')
    case 'ai_task_timeout': return make('timeout', 'AI 回覆逾時，請稍後再試')
    case 'turn_timeout':
    case 'stalled': return make('timeout', 'AI 回覆逾時，請稍後再試')
    case 'rate_limited': return make('rate_limited', `AI 呼叫太頻繁（已達 TeamUQ 的每分鐘上限）${wait}`)
    case 'quota_exhausted': return make('quota_exceeded', `AI 額度已用完${wait}`)
    case 'provider_unavailable':
    case 'provider_not_ready':
    case 'unsupported_version':
    case 'model_unavailable':
    case 'unavailable': return make('invalid_config', 'TeamUQ 的 Codex 目前無法使用（請確認已安裝、已登入、版本符合）')
    case 'not_granted':
    case 'plugin_not_active':
    case 'access_revoked': return make('invalid_config', '此外掛的 AI 權限（ai:chat）已被關閉，請在 TeamUQ 設定中重新允許')
    case 'invalid_json':
    case 'invalid_result': return make('bad_output', 'AI 回覆的格式不正確')
    case 'empty_reply': return make('bad_output', 'AI 沒有回覆內容')
    case 'reply_too_long': return make('bad_output', 'AI 回覆過長')
    case 'input_too_large':
    case 'system_too_large': return make('invalid_config', '送給 AI 的內容超過單輪上限（8,000 字），請縮小範圍後再試')
    case 'ai_queue_full': return make('rate_limited', 'AI 工作排隊中的項目太多，請稍後再試')
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
  try { parsed = JSON.parse(user) } catch { throw new AiTaskError('input_too_large') }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AiTaskError('input_too_large')
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
  if (text.length > maxChars) throw new AiTaskError('input_too_large')
  return text
}

export interface UiAiProviderOptions {
  /** meta.provider 與 provider.id：ai:chat 目前只有 Codex（aiChatComposition.ts:19,28）。 */
  id?: 'codexCli'
}

/** core 的 `providers.resolveProvider()` 回傳這個：complete() 排隊給 UI，不碰任何網路或行程。 */
export function createUiAiProvider(queue: AiTaskQueue, options: UiAiProviderOptions = {}): LlmProvider {
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
        const result = await queue.request({ kind, system, user, expectJson })
        return { text: result.text, meta: { provider: id, model: result.model, durationMs: Date.now() - started } }
      } catch (error) {
        throw toProviderError(error)
      }
    },
    async health() {
      return queue.consumerActive()
        ? { ok: true, summary: 'AI 由 TeamUQ 的 ai:chat 提供（看板在前景時可用）', details: {} }
        : { ok: false, code: 'invalid_config', summary: '看板不在前景，AI 暫時無法處理', details: {} }
    }
  }
}
