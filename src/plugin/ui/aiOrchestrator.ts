/**
 * aiOrchestrator.ts — 外掛 UI 端的 AI 編排（設計 v2 §4.3、§7 Phase 4）。
 *
 * TeamUQ 1.6.8 的 `ai:chat`（`window.tuqPlugin.ai`，Codex）只在 view 端可用、純文字、沒有 structured output，而且 view 必須可見。
 * backend 不得呼叫 LLM，所以 backend 只「供料」（`extract.pull`、`ai.pull`）與「收料」（`extract.commit`、`ai.commit`）；
 * 真正跟 ai:chat 對話的是這個模組。五項責任（對應 §4.3）：
 *
 *   1. 排程   事件（`extract-pending`）＋閒置輪詢＋可見性變化＋退避到期，驅動同一個「一次只做一件事」的迴圈
 *            （1.6.8 每個外掛同時只能有 1 個 session，所以全部工作序列化；使用者按鈕觸發的工作〔草擬回覆等〕優先於背景抽取）。
 *   2. 配額   滑動視窗 20 輪/分、400 輪/時（`AI_CHAT_LIMITS`，與 aiChatService 的判斷式相同）；背景抽取保留 2 輪給使用者動作；
 *            單輪輸入 ≤ 8,000 字、system ≤ 16,000 字（送出前檢查）。
 *   3. 可見性 view 不可見時暫停（不是失敗）：不領取、不開 session；host 說 `view_not_visible` 時把已領的項目還回去，等可見再繼續。
 *   4. 重試   `turn_in_progress` 重試（ai-lover `ai-port.js:112-118` 的 6 次 × 250 ms）；`rate_limited`／`quota_exhausted`／`provider_unavailable` 等
 *            「不是這個聊天室的錯」退避後重排（把租約還回去，不算失敗）；`empty_reply`／`reply_too_long`／`provider_error`／JSON 無效
 *            才標該聊天室本輪失敗（訊息不標已處理，下輪重抽）；`access_revoked`／`not_granted` 停止並提示。
 *   5. JSON   回覆可能含 ```json 圍欄或前後說明：取出 JSON → `JSON.parse` → `validateExtractResult`（zod）。壞了最多重問 1 次（耗 1 輪配額）。
 *
 * 一個項目 = 一個全新的 session（system＋一則 user）：不同聊天室的內容不會互相滲入上下文；session 在項目結束時一定 close
 * （host 限制每外掛 1 個 session，`session_limit`）。開 session 本身不耗輪數（只有 `send` 計入）。
 *
 * 不依賴 DOM／React；時間與可見性都是注入的（測試用手動時鐘與假的 ai:chat）。
 */
import { validateExtractResult } from '../../shared/extractResult'
import { fitReplyText } from '../../shared/pluginWire'
import { ACCESS_HOST_CODES } from '../../renderer/platform/pluginTransport'
import { BACKEND_INVOKE_TOGGLE_TITLE, PERMISSIONS_SECTION_TITLE, PLUGIN_PAGE_PLACE } from '../../renderer/lib/backendError'

// ───────────────────────── 1.6.8 ai:chat 的型別（只列用到的）─────────────────────────

export interface AiChatEffective { providerId: string; modelId: string; effort: string | null }
export type AiTurnEvent = { turnId: string } & (
  | { kind: 'started' }
  | { kind: 'textDelta'; text: string }
  | { kind: 'completed' }
  | { kind: 'interrupted' }
  | { kind: 'failed'; code: string; retryable?: boolean; fallbackUsed?: boolean; partialDelivered?: boolean }
)
export interface AiChatSession {
  readonly sessionId: string
  readonly effective: AiChatEffective
  send(input: { text?: string }): Promise<{ turnId: string }>
  onEvent(listener: (event: AiTurnEvent) => void): () => void
  interrupt(): Promise<void>
  close(): Promise<void>
}
export interface AiChatModel { id: string; label?: string; efforts: string[]; defaultEffort: string | null; supportsImages?: boolean; isDefault: boolean }
export interface AiChatProvider { id: string; label?: string; state: string; models: AiChatModel[] }
export interface AiChatOptions {
  providers: AiChatProvider[]
  defaultProviderId: string | null
  limits: { systemChars: number; transcriptLines?: number; transcriptChars?: number; inputChars: number; imageBytes?: number; turnsPerMinute: number }
  quota: { state: 'ok' | 'exhausted'; retryAfterMs: number | null }
}
/** `window.tuqPlugin.ai`。 */
export interface AiChatApi {
  getOptions(): Promise<AiChatOptions>
  openSession(options: { providerId?: string; modelId?: string; effort?: string; system: string; transcript?: Array<{ role: 'user' | 'assistant'; text: string }> }): Promise<AiChatSession>
}

// ───────────────────────── backend 通道（pluginApi 的 `plugin.extract`／`plugin.aiTasks`）─────────────────────────

export interface ExtractItem { itemId: string; chatId: string; user: string; userChars?: number; attempts?: number; [key: string]: unknown }
export interface ExtractChannel {
  system(): Promise<{ system: string; sha256: string; chars?: number; maxUserChars?: number; format?: string }>
  pull(options?: { max?: number; leaseMs?: number }): Promise<{ items: Array<Record<string, unknown>>; systemSha256?: unknown; retryAfterMs?: unknown; [key: string]: unknown }>
  commit(results: Array<{ itemId: string; ok: boolean; result?: unknown; failCode?: string; retryAfterMs?: number }>): Promise<{ results: Array<Record<string, unknown>> }>
  release(itemIds: string[]): Promise<unknown>
  onPending(cb: (info: { pending: number }) => void): () => void
}
export interface TaskItem { taskId: string; kind: string; system: string; user: string; expectJson: boolean; [key: string]: unknown }
export interface TaskChannel {
  pull(options?: { max?: number; leaseMs?: number }): Promise<{ tasks: Array<Record<string, unknown>>; [key: string]: unknown }>
  commit(results: Array<{ taskId: string; ok: boolean; text?: string; model?: string; failCode?: string; retryAfterMs?: number }>): Promise<{ results: Array<Record<string, unknown>> }>
  release(taskIds: string[]): Promise<unknown>
}

// ───────────────────────── 注入點 ─────────────────────────

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
}
export const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>)
}

export interface VisibilitySource {
  isVisible(): boolean
  /** 可見性變化時呼叫（含 presentation 的 visible）。 */
  subscribe(listener: (visible: boolean) => void): () => void
  /** 取消對 document／presentation 的監聽。 */
  dispose?(): void
}

/** `document` 與 `window.tuqPlugin.presentation` 的最小形狀。 */
export interface VisibilityEnv {
  document?: { visibilityState: string; addEventListener(type: string, listener: () => void): void; removeEventListener(type: string, listener: () => void): void }
  presentation?: {
    get?(): Promise<{ visible: boolean }>
    onChange?(listener: (change: { visible: boolean; phase?: string }) => void): () => void
  }
}

/** 可見＝頁面 visibilityState 為 visible，且 TeamUQ 的 presentation 沒說被隱藏（host 的 `canOpen` 還看 placement，最終以 host 回的 `view_not_visible` 為準）。 */
export function createVisibilitySource(env: VisibilityEnv): VisibilitySource {
  const listeners = new Set<(visible: boolean) => void>()
  let presentationVisible = true
  const pageVisible = (): boolean => env.document === undefined || env.document.visibilityState === 'visible'
  const current = (): boolean => pageVisible() && presentationVisible
  let last = current()
  const check = (): void => {
    const now = current()
    if (now === last) return
    last = now
    for (const listener of [...listeners]) listener(now)
  }
  env.document?.addEventListener('visibilitychange', check)
  let offPresentation: (() => void) | null = null
  try {
    offPresentation = env.presentation?.onChange?.((change) => {
      if (change.phase === 'before') return
      presentationVisible = change.visible !== false
      check()
    }) ?? null
    void env.presentation?.get?.().then((state) => { presentationVisible = state.visible !== false; check() }, () => undefined)
  } catch { /* 沒有 presentation 時只看頁面可見性 */ }
  return {
    isVisible: current,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      listeners.clear()
      env.document?.removeEventListener('visibilitychange', check)
      try { offPresentation?.() } catch { /* 已取消 */ }
      offPresentation = null
    }
  }
}

// ───────────────────────── 設定 ─────────────────────────

/**
 * 1.6.8 `AI_CHAT_LIMITS`（`aiChatContracts.ts:10-29`）中與 orchestrator 有關的值；test 用 drift guard 對照 contract。
 * 只是 `getOptions()` 回來之前的起始值：之後以 host 回報的 `limits` 為準，給使用者看的文字也用 host 的值（G-10），不寫死數字。
 */
export const AI_CHAT_REFERENCE = Object.freeze({ systemChars: 16_000, inputChars: 8_000, turnsPerMinute: 20, turnsPerHour: 400, replyChars: 32_000, turnTimeoutMs: 300_000 })

export interface OrchestratorConfig {
  /** 閒置時檢查待處理項目的間隔（備援；平常靠事件）。 */
  pollIntervalMs: number
  /** 單輪逾時（host 是 300 s；這裡更短，才有機會在 host 之前主動 interrupt）。 */
  turnTimeoutMs: number
  sendRetries: number
  sendRetryMs: number
  /** 背景抽取保留給使用者動作的輪數（20/分 → 抽取最多 18/分）。 */
  extractReserve: number
  /** JSON 無效時最多重問幾次。 */
  maxRepairs: number
  leaseMs: number
  optionsTtlMs: number
  providerRetryMs: number
  hiddenProbeMs: number
  rateBackoffBaseMs: number
  rateBackoffMaxMs: number
  quotaDefaultMs: number
  busyBackoffMs: number
  backendBackoffMs: number
  /** host 回「後端呼叫被隔離／外掛已移除」（backend:invoke 不能用）時，多久再探一次（G-03）。 */
  backendRevokedProbeMs: number
  /** 使用者動作最多願意等多久的配額空檔，超過就直接回 rate_limited。 */
  taskMaxWaitMs: number
  /** 滑動視窗的安全邊際（我們記錄的時間比 host 晚一個往返）。 */
  windowMarginMs: number
  perMinute: number
  perHour: number
  providerId?: string
  modelId?: string
  effort?: string
}

export const ORCHESTRATOR_DEFAULTS: OrchestratorConfig = Object.freeze({
  pollIntervalMs: 15_000,
  turnTimeoutMs: 150_000,
  sendRetries: 6,
  sendRetryMs: 250,
  extractReserve: 2,
  maxRepairs: 1,
  leaseMs: 5 * 60_000,
  optionsTtlMs: 30_000,
  providerRetryMs: 60_000,
  hiddenProbeMs: 3_000,
  rateBackoffBaseMs: 5_000,
  rateBackoffMaxMs: 60_000,
  quotaDefaultMs: 5 * 60_000,
  busyBackoffMs: 3_000,
  backendBackoffMs: 10_000,
  backendRevokedProbeMs: 30_000,
  taskMaxWaitMs: 30_000,
  windowMarginMs: 250,
  perMinute: AI_CHAT_REFERENCE.turnsPerMinute,
  perHour: AI_CHAT_REFERENCE.turnsPerHour
})

// ───────────────────────── 配額視窗 ─────────────────────────

/** aiChatService.send 的判斷式：近 60 s（含）內的輪數 ≥ 每分鐘上限、或近 1 h 的輪數 ≥ 每小時上限 → rate_limited。 */
export class TurnWindow {
  private readonly times: number[] = []
  perMinute: number
  perHour: number
  private readonly margin: number

  constructor(perMinute: number, perHour: number, margin = 0) {
    this.perMinute = perMinute
    this.perHour = perHour
    this.margin = margin
  }

  record(at: number): void { this.times.push(at) }

  private prune(now: number): void {
    while (this.times.length > 0 && now - this.times[0] > 3_600_000 + this.margin) this.times.shift()
  }

  count(now: number, windowMs = 60_000): number {
    this.prune(now)
    let n = 0
    for (const t of this.times) if (now - t <= windowMs + this.margin) n += 1
    return n
  }

  /** 現在送出一輪（保留 `reserve` 輪給別人）要等多久；0＝可以馬上送。 */
  delay(now: number, reserve = 0): number {
    this.prune(now)
    const minuteLimit = Math.max(1, this.perMinute - reserve)
    let wait = 0
    const need = (limit: number, windowMs: number): number => {
      const inside = this.times.filter((t) => now - t <= windowMs + this.margin)
      if (inside.length < limit) return 0
      // 最舊的 (inside.length - limit + 1) 輪都要滑出視窗
      const pivot = inside[inside.length - limit]
      return Math.max(0, pivot + windowMs + this.margin + 1 - now)
    }
    wait = Math.max(wait, need(minuteLimit, 60_000))
    wait = Math.max(wait, need(this.perHour, 3_600_000))
    return wait
  }
}

// ───────────────────────── JSON 解析 ─────────────────────────

export type JsonParse = { ok: true; value: unknown } | { ok: false; reason: string }

/** 取出模型回覆裡的 JSON：整段、```json 圍欄、或第一個 `{` 到最後一個 `}`。 */
export function parseModelJson(raw: string): JsonParse {
  const text = raw.replace(/^﻿/, '').trim()
  if (text === '') return { ok: false, reason: 'empty' }
  const candidates: string[] = [text]
  const fence = /```(?:json|JSON)?[ \t]*\r?\n?([\s\S]*?)```/.exec(text)
  if (fence && fence[1].trim() !== '') candidates.push(fence[1].trim())
  const open = text.indexOf('{')
  const close = text.lastIndexOf('}')
  if (open >= 0 && close > open) candidates.push(text.slice(open, close + 1))
  let lastError = 'not_json'
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) as unknown }
    } catch (error) {
      lastError = error instanceof Error ? error.message.slice(0, 120) : 'not_json'
    }
  }
  return { ok: false, reason: lastError }
}

function zodIssues(error: unknown): string {
  const issues = (error as { issues?: Array<{ path?: unknown[]; message?: string }> } | null)?.issues
  if (Array.isArray(issues)) return issues.slice(0, 4).map((i) => `${(i.path ?? []).join('.') || '(root)'}: ${i.message ?? 'invalid'}`).join('；')
  return error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)
}

const repairPrompt = (reason: string): string =>
  `你上一則回覆無法使用（${reason.slice(0, 300)}）。請只輸出一個符合先前格式要求的 JSON 物件：不要任何說明、不要用 Markdown 或程式碼圍欄包起來。`

// ───────────────────────── 狀態 ─────────────────────────

export type OrchestratorState = 'stopped' | 'running' | 'paused' | 'unavailable' | 'revoked'
export interface OrchestratorStatus {
  state: OrchestratorState
  /**
   * 暫停／不可用的原因：`view_hidden`、`view_not_visible`、`rate_limited`、`quota_exhausted`、`busy`、`backend`、
   * `backend_revoked`（TeamUQ 隔離了這個外掛的後端呼叫：權限關閉、停用或逾時，或外掛已移除；G-03／review B1）、`provider_<state>`、`no_provider`…
   */
  reason: string | null
  /** 預計何時恢復（毫秒 epoch；未知＝null）。 */
  resumeAt: number | null
  /** 正在跟 ai:chat 對話。 */
  busy: boolean
  provider: { providerId: string; modelId: string | null } | null
  counters: Counters
  /** host 目前的每分鐘輪數上限（`getOptions().limits.turnsPerMinute`；取得之前是起始值）。G-10：文字用它，不寫死。 */
  turnsPerMinute?: number
}
export interface Counters {
  turns: number
  repairs: number
  extracted: number
  rejected: number
  failed: number
  released: number
  tasksDone: number
  tasksFailed: number
  rateLimited: number
  viewNotVisible: number
}

const PROVIDER_STATE_TEXT: Record<string, string> = {
  not_installed: '尚未安裝 Codex（請在 TeamUQ 安裝並登入 Codex CLI）',
  not_logged_in: 'Codex 尚未登入（請在終端機登入 Codex CLI）',
  unsupported_version: 'Codex 版本不支援目前的 TeamUQ（請依 TeamUQ 的提示更新 Codex CLI）',
  unavailable: 'Codex 目前無法使用',
  not_supported_yet: '這個 AI 供應者尚未支援'
}

/** 給使用者看的一句話（UI 狀態列與「尚未接上」訊息共用）。 */
export function describeStatus(status: OrchestratorStatus, now = Date.now()): string {
  const secs = status.resumeAt === null ? null : Math.max(1, Math.ceil((status.resumeAt - now) / 1000))
  switch (status.state) {
    case 'stopped': return 'AI 整理尚未啟動'
    case 'revoked': return '已關閉此外掛的 AI 權限（ai:chat）；到 TeamUQ 設定 → 外掛重新允許後，重新開啟看板'
    case 'unavailable': return status.reason?.startsWith('provider_') ? (PROVIDER_STATE_TEXT[status.reason.slice('provider_'.length)] ?? 'AI 目前無法使用') : 'AI 目前無法使用（找不到可用的 AI 供應者）'
    case 'paused':
      switch (status.reason) {
        case 'view_hidden':
        case 'view_not_visible': return '看板在背景，已暫停整理新訊息；回到前景會自動繼續'
        case 'rate_limited': return `已達 TeamUQ 的 AI 呼叫上限${typeof status.turnsPerMinute === 'number' ? `（每分鐘 ${status.turnsPerMinute} 次）` : ''}，${secs ?? '稍後'}${secs === null ? '' : ' 秒後'}繼續`
        case 'quota_exhausted': return `Codex 額度已用完，${secs === null ? '稍後' : `約 ${Math.ceil(secs / 60)} 分鐘後`}繼續`
        case 'backend': return '與外掛後端的連線暫時中斷，稍後重試'
        // review B1：Core 1.7.1 重新允許權限不會解除隔離，這裡不承諾自動繼續，只列出有效的操作。
        // R1-N1：權限名稱用 TeamUQ 設定頁上開關的實際標題（BACKEND_INVOKE_TOGGLE_TITLE）。
        case 'backend_revoked': return `TeamUQ 目前不讓這個外掛呼叫後端（「${BACKEND_INVOKE_TOGGLE_TITLE}」權限被關閉、外掛被停用，或後端太久沒有回應而被隔離），AI 整理暫停；請到 ${PLUGIN_PAGE_PLACE}打開這個外掛，確認「${PERMISSIONS_SECTION_TITLE}」裡已允許「${BACKEND_INVOKE_TOGGLE_TITLE}」且外掛是啟用的，仍沒有恢復就把外掛停用再啟用，或重新啟動 TeamUQ`
        default: return 'AI 整理暫停中，稍後繼續'
      }
    default: return status.busy ? 'AI 正在整理新訊息…' : 'AI 整理已就緒（看板在前景時才會整理新訊息）'
  }
}

// ───────────────────────── orchestrator ─────────────────────────

export interface OrchestratorDeps {
  ai: AiChatApi
  extract: ExtractChannel
  tasks: TaskChannel
  visibility: VisibilitySource
  clock?: Clock
  config?: Partial<OrchestratorConfig>
  /** 診斷輸出（測試／除錯）；不含訊息內容。 */
  log?: (event: string, detail?: Record<string, unknown>) => void
}

export interface AiOrchestrator {
  start(): void
  /** 停止：中斷進行中的輪次、關 session、把還沒做完的租約還回去。 */
  stop(): Promise<void>
  /** 立刻檢查有沒有工作（事件驅動時呼叫）。 */
  kick(): void
  /** AI 功能是否可用（pluginApi 在呼叫 reviewLastDays／草擬回覆／誤判分析／群組議題前問）。 */
  connected(): boolean
  /** 沒連上時的原因（給使用者看）。 */
  note(): string | undefined
  status(): OrchestratorStatus
  onStatus(listener: (status: OrchestratorStatus) => void): () => void
  /** 目前這輪迴圈結束（沒有進行中的工作）時 resolve；測試用。 */
  idle(): Promise<void>
}

type Action = 'release' | 'fail' | 'stop'
type FlowResult =
  | { ok: true; text: string; value?: unknown; model: string | null }
  | { ok: false; code: string; action: Action; retryAfterMs?: number }

interface Flow {
  kind: 'extract' | 'task'
  system: string
  user: string
  expectJson: boolean
  validate?: (value: unknown) => { ok: true; value: unknown } | { ok: false; reason: string }
}

interface Turn {
  text: string
  terminal: { kind: 'completed' } | { kind: 'interrupted' } | { kind: 'failed'; code: string } | null
  done: Promise<void>
  finish(): void
}

const codeOf = (error: unknown): string => {
  const e = error as { code?: unknown; message?: unknown } | null
  if (e && typeof e.code === 'string' && /^[a-z_]+$/.test(e.code)) return e.code
  const message = typeof e?.message === 'string' ? e.message : ''
  const cleaned = message.replace(/^Error:\s*/, '').trim()
  return /^[a-z_]{2,40}$/.test(cleaned) ? cleaned : 'unavailable'
}

const GATE_REASON: Record<string, string> = { hidden: 'view_not_visible', rate: 'rate_limited', quota: 'quota_exhausted', provider: 'provider_unavailable' }
const ACCESS_CODES = new Set(['not_granted', 'plugin_not_active', 'access_revoked'])
const PROVIDER_CODES = new Set(['provider_unavailable', 'provider_not_ready', 'unsupported_version', 'model_unavailable', 'unavailable', 'provider_not_found', 'not_supported_yet'])
const BUSY_CODES = new Set(['busy', 'session_limit', 'session_not_found', 'turn_in_progress', 'session_closed'])
/** host 對 backend:invoke 的「不能用」：Core 隔離了後端呼叫（權限關閉、停用、逾時）或外掛已移除——就是 pluginTransport.ts 的 ACCESS_HOST_CODES。 */
const BACKEND_ACCESS_CODES: ReadonlySet<string> = ACCESS_HOST_CODES

export function createAiOrchestrator(deps: OrchestratorDeps): AiOrchestrator {
  const clock = deps.clock ?? SYSTEM_CLOCK
  const cfg: OrchestratorConfig = { ...ORCHESTRATOR_DEFAULTS, ...deps.config }
  const log = (event: string, detail?: Record<string, unknown>): void => { try { deps.log?.(event, detail) } catch { /* 診斷失敗不影響流程 */ } }
  const turnWindow = new TurnWindow(cfg.perMinute, cfg.perHour, cfg.windowMarginMs)
  const counters: Counters = { turns: 0, repairs: 0, extracted: 0, rejected: 0, failed: 0, released: 0, tasksDone: 0, tasksFailed: 0, rateLimited: 0, viewNotVisible: 0 }
  const statusListeners = new Set<(status: OrchestratorStatus) => void>()
  const sleepers = new Set<() => void>()

  let stopped = true
  let revoked = false
  let draining = false
  let again = false
  let busy = false
  let idleWaiters: Array<() => void> = []
  let wakeTimer: unknown = null
  let wakeAt: number | null = null
  let unsubscribers: Array<() => void> = []
  let current: { interrupt(): void } | null = null

  let optionsAt = -Infinity
  let choice: { providerId: string; modelId: string | null; effort: string | null; provider: AiChatProvider } | null = null
  let providerReason: string | null = null
  let limits: AiChatOptions['limits'] = { systemChars: AI_CHAT_REFERENCE.systemChars, inputChars: AI_CHAT_REFERENCE.inputChars, turnsPerMinute: cfg.perMinute }
  let systemCache: { sha: string; text: string } | null = null

  // 全域退避（不是哪個聊天室的錯）：每項是「到何時為止」
  const blockers: { rate: number; quota: number; provider: number; busy: number; hidden: number; backend: number } = { rate: 0, quota: 0, provider: 0, busy: 0, hidden: 0, backend: 0 }
  let rateAttempts = 0
  let lastStatusKey = ''
  /** 最近一次 backend 失敗是「撤銷／停用／移除」（G-03）。下一次 backend 呼叫成功就清掉。 */
  let backendRevoked = false

  const now = (): number => clock.now()

  // ── 狀態 ──
  const gate = (at: number): { until: number; reason: string } | null => {
    let best: { until: number; reason: string } | null = null
    for (const [reason, until] of Object.entries(blockers)) {
      if (until > at && (best === null || until > best.until)) best = { until, reason: reason === 'backend' && backendRevoked ? 'backend_revoked' : GATE_REASON[reason] ?? reason }
    }
    return best
  }

  const computeStatus = (): OrchestratorStatus => {
    const at = now()
    const provider = choice ? { providerId: choice.providerId, modelId: choice.modelId } : null
    const base = { busy, provider, counters: { ...counters }, turnsPerMinute: turnWindow.perMinute }
    if (stopped) return { state: 'stopped', reason: null, resumeAt: null, ...base }
    if (revoked) return { state: 'revoked', reason: 'access_revoked', resumeAt: null, ...base }
    if (providerReason !== null) return { state: 'unavailable', reason: providerReason, resumeAt: blockers.provider > at ? blockers.provider : null, ...base }
    if (!deps.visibility.isVisible()) return { state: 'paused', reason: 'view_hidden', resumeAt: null, ...base }
    const blocked = gate(at)
    if (blocked) return { state: 'paused', reason: blocked.reason, resumeAt: blocked.until, ...base }
    return { state: 'running', reason: null, resumeAt: null, ...base }
  }

  const emitStatus = (): void => {
    const status = computeStatus()
    const key = JSON.stringify([status.state, status.reason, status.resumeAt, status.busy, status.provider])
    if (key === lastStatusKey) return
    lastStatusKey = key
    for (const listener of [...statusListeners]) { try { listener(status) } catch { /* 訂閱者錯誤不影響流程 */ } }
  }

  // ── 計時 ──
  const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => {
    let timer: unknown = null
    const done = (): void => { if (timer !== null) clock.clearTimeout(timer); timer = null; sleepers.delete(done); resolve() }
    sleepers.add(done)
    timer = clock.setTimeout(done, Math.max(0, ms))
  })

  const scheduleWake = (delayMs: number): void => {
    if (stopped) return
    const at = now() + Math.max(0, delayMs)
    if (wakeTimer !== null && wakeAt !== null && wakeAt <= at) return
    if (wakeTimer !== null) clock.clearTimeout(wakeTimer)
    wakeAt = at
    wakeTimer = clock.setTimeout(() => { wakeTimer = null; wakeAt = null; kick() }, Math.max(0, delayMs))
  }

  // ── 失敗分類 ──
  const refreshOptionsSoon = (): void => { optionsAt = -Infinity }

  const applyBlocker = (code: string, retryAfterMs?: number): void => {
    const at = now()
    if (code === 'rate_limited') {
      rateAttempts += 1
      counters.rateLimited += 1
      blockers.rate = at + Math.min(cfg.rateBackoffBaseMs * 2 ** (rateAttempts - 1), cfg.rateBackoffMaxMs)
    } else if (code === 'quota_exhausted') {
      blockers.quota = at + (retryAfterMs && retryAfterMs > 0 ? retryAfterMs : cfg.quotaDefaultMs)
    } else if (PROVIDER_CODES.has(code)) {
      blockers.provider = at + cfg.providerRetryMs
      refreshOptionsSoon()
    } else if (code === 'view_not_visible') {
      counters.viewNotVisible += 1
      blockers.hidden = at + cfg.hiddenProbeMs
    } else if (BUSY_CODES.has(code)) {
      blockers.busy = at + cfg.busyBackoffMs
    }
  }

  /** 把 ai:chat／host 的錯誤代碼分類成動作（見檔頭第 4 點）。 */
  const classify = (code: string, retryAfterMs?: number): FlowResult & { ok: false } => {
    if (ACCESS_CODES.has(code)) { revoked = true; return { ok: false, code, action: 'stop' } }
    if (code === 'rate_limited' || code === 'quota_exhausted' || PROVIDER_CODES.has(code) || code === 'view_not_visible' || BUSY_CODES.has(code)) {
      applyBlocker(code, retryAfterMs)
      return { ok: false, code, action: 'release', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }
    }
    // empty_reply／reply_too_long／provider_error／stalled／turn_timeout／invalid_json／invalid_result／input_too_large／request_invalid…：這一項本輪失敗
    return { ok: false, code, action: 'fail' }
  }

  // ── ai:chat 選項 ──
  const ensureOptions = async (force = false): Promise<boolean> => {
    if (!force && now() - optionsAt < cfg.optionsTtlMs && (choice !== null || providerReason !== null)) return choice !== null
    let options: AiChatOptions
    try {
      options = await deps.ai.getOptions()
    } catch (error) {
      const code = codeOf(error)
      if (ACCESS_CODES.has(code)) { revoked = true; return false }
      applyBlocker(PROVIDER_CODES.has(code) ? code : 'unavailable')
      providerReason = 'no_provider'
      return false
    }
    optionsAt = now()
    limits = options.limits
    turnWindow.perMinute = Math.min(cfg.perMinute, options.limits.turnsPerMinute)
    if (options.quota.state === 'exhausted') applyBlocker('quota_exhausted', options.quota.retryAfterMs ?? undefined)
    const wanted = cfg.providerId ?? options.defaultProviderId
    const provider = options.providers.find((p) => p.id === wanted && p.state === 'ready') ?? options.providers.find((p) => p.state === 'ready') ?? null
    if (provider === null) {
      choice = null
      const sample = options.providers.find((p) => p.id === wanted) ?? options.providers[0]
      providerReason = sample ? `provider_${sample.state}` : 'no_provider'
      blockers.provider = now() + cfg.providerRetryMs
      return false
    }
    const model = provider.models.find((m) => m.id === cfg.modelId) ?? provider.models.find((m) => m.isDefault) ?? provider.models[0] ?? null
    const effort = cfg.effort !== undefined && (model?.efforts ?? []).includes(cfg.effort) ? cfg.effort : null
    choice = { providerId: provider.id, modelId: model?.id ?? null, effort, provider }
    providerReason = null
    return true
  }

  // ── 一個輪次 ──
  const newTurn = (): Turn => {
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    return { text: '', terminal: null, done, finish }
  }

  const waitForSlot = async (reserve: number, maxWaitMs: number): Promise<number> => {
    const wait = turnWindow.delay(now(), reserve)
    if (wait <= 0) return 0
    if (wait > maxWaitMs) return wait
    await sleep(wait)
    return 0
  }

  /** 送一則 user 訊息並等這一輪結束。 */
  const sendAndWait = async (session: AiChatSession, turns: Map<string, Turn>, text: string): Promise<{ ok: true; text: string } | { ok: false; code: string }> => {
    let sent: { turnId: string } | null = null
    for (let attempt = 0; attempt <= cfg.sendRetries && sent === null; attempt += 1) {
      if (stopped) return { ok: false, code: 'interrupted' }
      try {
        sent = await session.send({ text })
      } catch (error) {
        const code = codeOf(error)
        if (code === 'turn_in_progress' && attempt < cfg.sendRetries) { await sleep(cfg.sendRetryMs); continue }
        return { ok: false, code }
      }
    }
    if (sent === null) return { ok: false, code: 'turn_in_progress' }
    turnWindow.record(now())
    counters.turns += 1
    rateAttempts = 0
    let turn = turns.get(sent.turnId)
    if (!turn) { turn = newTurn(); turns.set(sent.turnId, turn) }
    const active = turn
    const timer = clock.setTimeout(() => {
      if (active.terminal === null) {
        active.terminal = { kind: 'failed', code: 'turn_timeout' }
        active.finish()
        void session.interrupt().catch(() => undefined)
      }
    }, cfg.turnTimeoutMs)
    try { await active.done } finally { clock.clearTimeout(timer) }
    const terminal = active.terminal
    if (terminal === null || terminal.kind === 'interrupted') return { ok: false, code: 'interrupted' }
    if (terminal.kind === 'failed') return { ok: false, code: terminal.code }
    if (active.text.trim() === '') return { ok: false, code: 'empty_reply' }
    return { ok: true, text: active.text }
  }

  const runFlow = async (flow: Flow): Promise<FlowResult> => {
    if (!(await ensureOptions())) return revoked ? { ok: false, code: 'access_revoked', action: 'stop' } : { ok: false, code: 'provider_unavailable', action: 'release' }
    const picked = choice!
    if (flow.system.length > limits.systemChars) return { ok: false, code: 'system_too_large', action: 'fail' }
    if (flow.user.length > limits.inputChars) return { ok: false, code: 'input_too_large', action: 'fail' }
    const reserve = flow.kind === 'extract' ? cfg.extractReserve : 0
    const blockedFor = await waitForSlot(reserve, flow.kind === 'task' ? cfg.taskMaxWaitMs : cfg.windowMarginMs + 61_000)
    if (blockedFor > 0) return { ok: false, code: 'rate_limited', action: 'release', retryAfterMs: blockedFor }
    if (stopped) return { ok: false, code: 'interrupted', action: 'release' }
    if (!deps.visibility.isVisible()) return classify('view_not_visible')

    let session: AiChatSession
    try {
      session = await deps.ai.openSession({
        providerId: picked.providerId,
        ...(picked.modelId !== null ? { modelId: picked.modelId } : {}),
        ...(picked.effort !== null ? { effort: picked.effort } : {}),
        system: flow.system
      })
    } catch (error) {
      return classify(codeOf(error))
    }
    const turns = new Map<string, Turn>()
    const unsubscribe = session.onEvent((event) => {
      let turn = turns.get(event.turnId)
      if (!turn) { turn = newTurn(); turns.set(event.turnId, turn) }
      if (turn.terminal !== null) return
      if (event.kind === 'textDelta') turn.text += event.text
      else if (event.kind === 'completed') { turn.terminal = { kind: 'completed' }; turn.finish() }
      else if (event.kind === 'interrupted') { turn.terminal = { kind: 'interrupted' }; turn.finish() }
      else if (event.kind === 'failed') { turn.terminal = { kind: 'failed', code: event.code }; turn.finish() }
    })
    current = {
      interrupt: () => {
        void session.interrupt().catch(() => undefined)
        for (const turn of turns.values()) if (turn.terminal === null) { turn.terminal = { kind: 'interrupted' }; turn.finish() }
      }
    }
    try {
      let message = flow.user
      for (let repair = 0; ; repair += 1) {
        const reply = await sendAndWait(session, turns, message)
        if (!reply.ok) {
          if (stopped || reply.code === 'interrupted') return { ok: false, code: 'interrupted', action: 'release' }
          if (reply.code === 'quota_exhausted') {
            await ensureOptions(true).catch(() => false)
            return classify('quota_exhausted', blockers.quota > now() ? blockers.quota - now() : undefined)
          }
          return classify(reply.code)
        }
        const model = session.effective?.modelId ?? picked.modelId
        if (!flow.expectJson) return { ok: true, text: reply.text.trim(), model }
        const parsed = parseModelJson(reply.text)
        let reason: string
        let failure: 'invalid_json' | 'invalid_result'
        if (parsed.ok) {
          const checked = flow.validate ? flow.validate(parsed.value) : { ok: true as const, value: parsed.value }
          if (checked.ok) return { ok: true, text: JSON.stringify(checked.value), value: checked.value, model }
          reason = checked.reason
          failure = 'invalid_result'
        } else {
          reason = `不是合法的 JSON（${parsed.reason}）`
          failure = 'invalid_json'
        }
        if (repair >= cfg.maxRepairs) return { ok: false, code: failure, action: 'fail' }
        counters.repairs += 1
        message = repairPrompt(reason)
        const wait = await waitForSlot(reserve, flow.kind === 'task' ? cfg.taskMaxWaitMs : 61_000)
        if (wait > 0) return { ok: false, code: failure, action: 'fail' }
      }
    } finally {
      unsubscribe()
      current = null
      try { await session.close() } catch { /* 已經不在了 */ }
    }
  }

  // ── 從 backend 領工作 ──
  const extractSystem = async (sha?: string): Promise<string> => {
    if (systemCache !== null && (sha === undefined || systemCache.sha === sha)) return systemCache.text
    const info = await deps.extract.system()
    const text = info.format ? `${info.system}\n\n${info.format}` : info.system
    systemCache = { sha: info.sha256, text }
    return text
  }

  const validateExtract = (value: unknown): { ok: true; value: unknown } | { ok: false; reason: string } => {
    try { return { ok: true, value: validateExtractResult(value) } } catch (error) { return { ok: false, reason: zodIssues(error) } }
  }

  const gateFailCode = (reason: string): string => (reason === 'backend' || reason === 'backend_revoked' ? 'unavailable' : reason)

  /** 沒有可用的 AI（沒有 provider／授權被撤銷）：把已排隊的使用者動作立刻回覆失敗原因，不讓它們空等到逾時。 */
  const failQueuedTasks = async (code: string): Promise<void> => {
    for (let i = 0; i < 8; i += 1) {
      let pulled: Awaited<ReturnType<TaskChannel['pull']>>
      try { pulled = await deps.tasks.pull({ max: 4, leaseMs: 30_000 }) } catch { return }
      if (pulled.tasks.length === 0) return
      try {
        await deps.tasks.commit((pulled.tasks as TaskItem[]).map((task) => ({ taskId: task.taskId, ok: false, failCode: code })))
        counters.tasksFailed += pulled.tasks.length
      } catch { return }
    }
  }

  /** 一個使用者動作（草擬回覆等）。回傳 true＝做了事（再檢查有沒有下一個）。 */
  const runTask = async (): Promise<boolean> => {
    let pulled: Awaited<ReturnType<TaskChannel['pull']>>
    try {
      pulled = await deps.tasks.pull({ max: 1, leaseMs: cfg.leaseMs })
    } catch (error) {
      log('tasks.pull failed', { code: codeOf(error) })
      applyBackendFailure(error)
      return false
    }
    backendRevoked = false
    const task = pulled.tasks[0] as TaskItem | undefined
    if (!task) return false
    const blocked = gate(now())
    let result: FlowResult
    if (blocked && blocked.reason !== 'busy') {
      result = { ok: false, code: gateFailCode(blocked.reason), action: 'release', retryAfterMs: Math.max(0, blocked.until - now()) }
    } else {
      busy = true
      emitStatus()
      try {
        result = await runFlow({ kind: 'task', system: String(task.system), user: String(task.user), expectJson: task.expectJson === true })
      } finally {
        busy = false
      }
    }
    try {
      // 回覆文字要放得進一個 ai.commit 請求（UTF-8 位元組，與 backend 的上限同一個常數）：純文字草稿過長就截斷並註記；JSON 輸出截斷會壞掉，改回報 reply_too_long。
      const fitted = result.ok ? fitReplyText(result.text, task.expectJson !== true) : null
      if (result.ok && fitted?.ok) {
        counters.tasksDone += 1
        await deps.tasks.commit([{ taskId: task.taskId, ok: true, text: fitted.text, ...(result.model ? { model: result.model } : {}) }])
      } else if (result.ok) {
        counters.tasksFailed += 1
        await deps.tasks.commit([{ taskId: task.taskId, ok: false, failCode: 'reply_too_long' }])
      } else {
        counters.tasksFailed += 1
        // 使用者動作不重排：把原因交給呼叫端顯示（rate_limited／quota_exhausted／view_not_visible…都是明確訊息）
        await deps.tasks.commit([{ taskId: task.taskId, ok: false, failCode: result.code, ...(result.retryAfterMs !== undefined ? { retryAfterMs: Math.round(result.retryAfterMs) } : {}) }])
      }
    } catch (error) {
      log('tasks.commit failed', { code: codeOf(error) })
    }
    return true
  }

  /** backend 呼叫失敗：一般失敗短暫退避；被隔離／已移除（G-03）改成較長的探測間隔，狀態列顯示原因（不是「暫時中斷」）。 */
  const applyBackendFailure = (error?: unknown): void => {
    backendRevoked = error !== undefined && BACKEND_ACCESS_CODES.has(codeOf(error))
    blockers.backend = now() + (backendRevoked ? cfg.backendRevokedProbeMs : cfg.backendBackoffMs)
  }

  /** 一個背景抽取項目。回傳 true＝領到並處理了。 */
  const runExtract = async (): Promise<boolean> => {
    let pulled: Awaited<ReturnType<ExtractChannel['pull']>>
    try {
      pulled = await deps.extract.pull({ max: 1, leaseMs: cfg.leaseMs })
    } catch (error) {
      log('extract.pull failed', { code: codeOf(error) })
      applyBackendFailure(error)
      return false
    }
    backendRevoked = false
    const item = pulled.items[0] as ExtractItem | undefined
    if (!item) {
      const hint = pulled.retryAfterMs
      if (typeof hint === 'number' && hint >= 0) scheduleWake(hint + 50)
      return false
    }
    let result: FlowResult
    busy = true
    emitStatus()
    try {
      const sha = typeof pulled.systemSha256 === 'string' ? pulled.systemSha256 : undefined
      const system = await extractSystem(sha).catch(() => null)
      result = system === null
        ? { ok: false, code: 'unavailable', action: 'release' }
        : await runFlow({ kind: 'extract', system, user: item.user, expectJson: true, validate: validateExtract })
    } finally {
      busy = false
    }
    try {
      if (result.ok) {
        const committed = await deps.extract.commit([{ itemId: item.itemId, ok: true, result: result.value }])
        const status = committed.results[0]?.status
        if (status === 'applied' || status === 'accepted') counters.extracted += 1
        else { counters.rejected += 1; log('extract commit not applied', { status }) }
      } else if (result.action === 'fail') {
        counters.failed += 1
        await deps.extract.commit([{ itemId: item.itemId, ok: false, failCode: result.code, ...(result.retryAfterMs !== undefined ? { retryAfterMs: Math.round(result.retryAfterMs) } : {}) }])
      } else {
        // release／stop：不是這個聊天室的錯（或 UI 停止），租約還回去
        counters.released += 1
        await deps.extract.release([item.itemId])
      }
    } catch (error) {
      log('extract.commit/release failed', { code: codeOf(error) })
      applyBackendFailure(error)
    }
    return true
  }

  // ── 迴圈 ──
  const cycle = async (): Promise<void> => {
    for (;;) {
      if (stopped) return
      if (revoked) { await failQueuedTasks('access_revoked'); emitStatus(); return }
      if (!deps.visibility.isVisible()) { emitStatus(); return }
      if (!(await ensureOptions())) {
        emitStatus()
        if (revoked) await failQueuedTasks('access_revoked')
        else { await failQueuedTasks('provider_unavailable'); scheduleWake(Math.max(1000, blockers.provider - now())) }
        return
      }
      emitStatus()
      const at = now()
      const blocked = gate(at)
      // 1) 使用者動作優先；被擋時也要領（才能立刻回覆失敗原因，不讓使用者空等）。
      if (blocked?.reason === 'backend' || blocked?.reason === 'backend_revoked') { scheduleWake(blocked.until - at); return }
      if (await runTask()) continue
      if (stopped || revoked) return
      // 2) 背景抽取：被全域退避擋住、或沒有配額空檔就先不領（領了租約會白佔）。
      const again2 = gate(now())
      if (again2) { scheduleWake(again2.until - now()); emitStatus(); return }
      const wait = turnWindow.delay(now(), cfg.extractReserve)
      if (wait > 0) { scheduleWake(wait); return }
      if (!(await runExtract())) { scheduleWake(cfg.pollIntervalMs); return }
    }
  }

  const drain = async (): Promise<void> => {
    if (draining) { again = true; return }
    draining = true
    try {
      do {
        again = false
        try { await cycle() } catch (error) { log('cycle failed', { code: codeOf(error) }); applyBackendFailure(error); scheduleWake(backendRevoked ? cfg.backendRevokedProbeMs : cfg.backendBackoffMs) }
      } while (again && !stopped)
    } finally {
      draining = false
      emitStatus()
      const waiters = idleWaiters
      idleWaiters = []
      for (const resolve of waiters) resolve()
    }
  }

  const kick = (): void => {
    if (stopped) return
    void drain()
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      revoked = false
      unsubscribers = [
        deps.visibility.subscribe((visible) => {
          if (visible) { blockers.hidden = 0; kick() }
          emitStatus()
        }),
        deps.extract.onPending(() => kick())
      ]
      emitStatus()
      kick()
    },
    async stop() {
      if (stopped) return
      stopped = true
      for (const off of unsubscribers) { try { off() } catch { /* 已取消 */ } }
      unsubscribers = []
      if (wakeTimer !== null) { clock.clearTimeout(wakeTimer); wakeTimer = null; wakeAt = null }
      current?.interrupt()
      for (const wake of [...sleepers]) wake()
      await new Promise<void>((resolve) => { if (draining) idleWaiters.push(resolve); else resolve() })
      emitStatus()
    },
    kick,
    connected: () => !stopped && !revoked && providerReason === null,
    note: () => (stopped || revoked || providerReason !== null ? describeStatus(computeStatus(), now()) : undefined),
    status: computeStatus,
    onStatus(listener) {
      statusListeners.add(listener)
      return () => { statusListeners.delete(listener) }
    },
    idle: () => new Promise<void>((resolve) => { if (!draining) resolve(); else idleWaiters.push(resolve) })
  }
}
