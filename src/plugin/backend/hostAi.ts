/**
 * hostAi.ts — 外掛 backend 的 AI port 實作：接 TeamUQ 的 `context.host.ai.complete`（Core >=1.7.13）。
 *
 * 0.2.0 起 AI 不再經 view：抽取（ExtractWorker）、草擬回覆、誤判分析、群組議題分析、prompt 修正都在 backend 呼叫這個 port，
 * 所以看板沒開、不可見時也照常整理已收進來的訊息。宿主對每個外掛的限制（`aiChatContracts.ts` AI_CHAT_LIMITS，本檔逐項遵守）：
 *   - 同時只能有 1 個 session：`complete` 每次開新 session、回覆後一定關掉（所有結果路徑），我們也把所有呼叫序列化（一次一個），
 *     使用者按鈕觸發的工作（priority `user`）排在背景抽取之前；
 *   - 20 輪/分、400 輪/時（`rate_limited`）：自己維護滑動視窗（與 aiChatService 相同的判斷式），背景抽取保留 `extractReserve` 輪/分與 `extractHourReserve` 輪/時
 *     給使用者動作（每分鐘、每小時都保留，否則大量背景整理會把整個小時的額度用光，使用者按「草擬回覆」只拿到 rate_limited）；
 *     視窗滿了就等（背景最多等 ~61 s，使用者動作最多等 30 s），等不到就以 `rate_limited`＋retryAfterMs（＋是哪個視窗滿了）失敗，由呼叫端退避；
 *   - 單輪輸入 ≤ 8,000 字、system ≤ 16,000 字：送出前檢查（`input_too_large`／`system_too_large`），數字以 `getOptions().limits` 為準；
 *   - 額度用完（`quota_exhausted`）／供應者不可用／授權被關（`access_revoked`）：記成全域退避，期間不打 host，呼叫端拿到帶 retryAfterMs 的錯誤。
 * `complete` 沒有 structured output：需要 JSON 時，取出 JSON → `validate`（zod）→ 不合格就帶著前一輪對話重問一次（耗 1 輪）。
 *
 * 不依賴 DOM／Electron；時間是注入的（測試用手動時鐘與假的 `host.ai`）。
 */
import type { PluginBackendAiApiV1, PluginBackendAiOptionsV1 } from '@teamuq/plugin-sdk'
import { AiPortError } from '../../core/aiPort'
import type { AiPort, AiPortRequest, AiPortResult, AiPriority } from '../../core/aiPort'
import { EMPTY_AI_COUNTERS } from '../../shared/aiStatus'
import type { AiCounters, AiStatus } from '../../shared/aiStatus'
import { normalizeHostAiSelection } from '../../shared/hostAi'
import type { HostAiEffort } from '../../shared/hostAi'
import { parseModelJson } from '../../shared/jsonReply'

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
}
export const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer },
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>)
}

/**
 * `AI_CHAT_LIMITS`（teamuq-electron `aiChatContracts.ts`）中與 port 有關的值；test 用 drift guard 對照 contract 的 fixture。
 * 只是 `getOptions()` 回來之前的起始值：之後以 host 回報的 `limits` 為準，給使用者看的文字也用 host 的值，不寫死數字。
 */
export const AI_CHAT_REFERENCE = Object.freeze({
  systemChars: 16_000, inputChars: 8_000, transcriptLines: 40, transcriptLineChars: 8_000, transcriptChars: 60_000,
  turnsPerMinute: 20, turnsPerHour: 400, replyChars: 32_000, turnTimeoutMs: 300_000
})

export interface HostAiConfig {
  /** 背景抽取保留給使用者動作的輪數（20/分 → 抽取最多 18/分）。 */
  extractReserve: number
  /** 背景抽取每小時保留給使用者動作的輪數（400/時 → 抽取最多 380/時）；使用者動作（草擬回覆、誤判分析、prompt 修正…）一小時內很少超過這個數。 */
  extractHourReserve: number
  /** JSON 無效時最多重問幾次。 */
  maxRepairs: number
  /** `busy`／`session_limit`／`turn_in_progress` 這類「host 還在收尾上一輪」的立即重試次數與間隔。 */
  busyRetries: number
  busyRetryMs: number
  busyBackoffMs: number
  optionsTtlMs: number
  providerRetryMs: number
  rateBackoffBaseMs: number
  rateBackoffMaxMs: number
  quotaDefaultMs: number
  /** `access_revoked` 之後多久再探一次授權是否恢復（`getOptions`）。 */
  revokedProbeMs: number
  /** 使用者動作最多願意等的配額空檔，超過就直接回 rate_limited。 */
  userMaxWaitMs: number
  /** 背景抽取願意等的配額空檔（一個視窗多一點）。 */
  backgroundMaxWaitMs: number
  /** 滑動視窗的安全邊際（我們記錄的時間比 host 晚一個往返）。 */
  windowMarginMs: number
  /** `getOptions` 的保險逾時（host 自己的逾時是 30 s，與 backend 單次呼叫上限同時到期會被 Core 隔離；這裡先放棄，必須遠小於 30 s）。 */
  optionsGuardMs: number
  /** `getOptions` 暫時失敗（逾時、host 不通）後多久再問一次。 */
  optionsRetryMs: number
  /** `plugin_host_unavailable`（host 連不上）之後多久再試。 */
  hostRetryMs: number
  /** 單次 `complete` 的保險逾時（host 自己的逾時是 turnTimeout 300 s＋收尾；這裡再多一點，避免永遠卡住）。 */
  completeGuardMs: number
  perMinute: number
  perHour: number
}

export const HOST_AI_DEFAULTS: Readonly<HostAiConfig> = Object.freeze({
  extractReserve: 2,
  extractHourReserve: 20,
  maxRepairs: 1,
  busyRetries: 6,
  busyRetryMs: 250,
  busyBackoffMs: 3_000,
  optionsTtlMs: 30_000,
  providerRetryMs: 60_000,
  rateBackoffBaseMs: 5_000,
  // host 說 rate_limited 但我們的視窗還有空（重啟前的輪數 Core 還記得，host 不告訴我們用了多少）：上限 5 分鐘，連續被拒就少探測
  rateBackoffMaxMs: 300_000,
  quotaDefaultMs: 5 * 60_000,
  revokedProbeMs: 30_000,
  userMaxWaitMs: 30_000,
  backgroundMaxWaitMs: 61_000,
  windowMarginMs: 250,
  optionsGuardMs: 15_000,
  optionsRetryMs: 10_000,
  hostRetryMs: 10_000,
  completeGuardMs: 330_000,
  perMinute: AI_CHAT_REFERENCE.turnsPerMinute,
  perHour: AI_CHAT_REFERENCE.turnsPerHour
})

/**
 * 一個背景項目在 port 裡最壞要花多久（毫秒）：讀 host 選項 → [等配額 → 一次 host 呼叫（含 busy 重試）] × (1 次＋JSON 重問 `maxRepairs` 次)。
 * ExtractWorker 的租約要比它長，否則項目還在處理中租約就過期，結果被丟掉、配額白花（review F3）。
 */
export const worstCaseItemMs = (cfg: Pick<HostAiConfig, 'optionsGuardMs' | 'backgroundMaxWaitMs' | 'busyRetries' | 'busyRetryMs' | 'completeGuardMs' | 'maxRepairs'> = HOST_AI_DEFAULTS): number =>
  cfg.optionsGuardMs + (1 + cfg.maxRepairs) * (cfg.backgroundMaxWaitMs + cfg.busyRetries * cfg.busyRetryMs + cfg.completeGuardMs)

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

  /** 這一輪其實沒被 host 受理（被擋在檢查階段）：從視窗拿掉。 */
  unrecord(at: number): void {
    const index = this.times.lastIndexOf(at)
    if (index >= 0) this.times.splice(index, 1)
  }

  private prune(now: number): void {
    while (this.times.length > 0 && now - this.times[0] > 3_600_000 + this.margin) this.times.shift()
  }

  count(now: number, windowMs = 60_000): number {
    this.prune(now)
    let n = 0
    for (const t of this.times) if (now - t <= windowMs + this.margin) n += 1
    return n
  }

  /**
   * 現在送出一輪（每分鐘保留 `reserve` 輪、每小時保留 `hourReserve` 輪給別人）要等多久，以及是哪個視窗擋著（`scope`）；`ms`＝0 可以馬上送。
   * `hourReserve` 省略＝同 `reserve`。
   */
  wait(now: number, reserve = 0, hourReserve = reserve): { ms: number; scope: 'minute' | 'hour' | null } {
    this.prune(now)
    const minuteLimit = Math.max(1, this.perMinute - reserve)
    const hourLimit = Math.max(1, this.perHour - hourReserve)
    const need = (limit: number, windowMs: number): number => {
      const inside = this.times.filter((t) => now - t <= windowMs + this.margin)
      if (inside.length < limit) return 0
      // 最舊的 (inside.length - limit + 1) 輪都要滑出視窗
      const pivot = inside[inside.length - limit]
      return Math.max(0, pivot + windowMs + this.margin + 1 - now)
    }
    const minute = need(minuteLimit, 60_000)
    const hour = need(hourLimit, 3_600_000)
    if (minute <= 0 && hour <= 0) return { ms: 0, scope: null }
    return hour > minute ? { ms: hour, scope: 'hour' } : { ms: minute, scope: 'minute' }
  }

  /** 現在送出一輪要等多久；0＝可以馬上送（`wait` 只取毫秒）。 */
  delay(now: number, reserve = 0, hourReserve = reserve): number { return this.wait(now, reserve, hourReserve).ms }
}

// ───────────────────────── 錯誤代碼分類 ─────────────────────────

/** host 對 backend 的 AI 呼叫失敗時 throw 的 Error 帶 `.code`（`hostServices.ts` 的 `failure(code)`）；訊息是 `host request failed: <code>`。 */
export const codeOf = (error: unknown): string => {
  if (error instanceof AiPortError) return error.code
  const e = error as { code?: unknown; message?: unknown } | null
  if (e && typeof e.code === 'string' && /^[a-z0-9_]+$/.test(e.code)) return e.code
  const message = typeof e?.message === 'string' ? e.message : ''
  const cleaned = message.replace(/^Error:\s*/, '').replace(/^host request failed:\s*/, '').trim()
  return /^[a-z_]{2,40}$/.test(cleaned) ? cleaned : 'unavailable'
}

export const ACCESS_CODES: ReadonlySet<string> = new Set(['not_granted', 'plugin_not_active', 'access_revoked'])
export const PROVIDER_CODES: ReadonlySet<string> = new Set(['provider_unavailable', 'provider_not_ready', 'unsupported_version', 'model_unavailable', 'unavailable', 'provider_not_found', 'execution_unavailable'])
export const BUSY_CODES: ReadonlySet<string> = new Set(['busy', 'session_limit', 'session_not_found', 'turn_in_progress', 'session_closed'])
/** host 在受理一輪之前就拒絕的代碼：這一輪不算進我們的視窗。 */
const NOT_ACCEPTED: ReadonlySet<string> = new Set([
  ...ACCESS_CODES, ...PROVIDER_CODES, ...BUSY_CODES, 'plugin_host_unavailable', 'rate_limited', 'quota_exhausted', 'request_invalid', 'input_too_large', 'unsupported_image', 'task_not_found',
  'plugin_host_request_invalid', 'plugin_host_response_invalid'
])

/**
 * 「不是這一項的錯」：稍後重試就會好（或使用者處理後會好），呼叫端不該把項目記成失敗。
 * 其餘（`empty_reply`、`invalid_json`、`invalid_result`、`reply_too_long`、`provider_error`、`turn_timeout`、`input_too_large`…）才是該項本輪失敗。
 */
export const isTransientAiCode = (code: string): boolean =>
  code === 'rate_limited' || code === 'quota_exhausted' || code === 'interrupted' || code === 'backend_stopped' || code === 'plugin_host_unavailable'
  || ACCESS_CODES.has(code) || PROVIDER_CODES.has(code) || BUSY_CODES.has(code)
// 注意 `plugin_host_timeout`（一次 complete 等了 310 s host 都沒回）不列在這裡：它是「這一輪」的失敗。列為暫時性的話，一個每次都讓模型卡死的聊天室會一直被放回佇列、
// 每次再占 5 分鐘，後面的聊天室永遠輪不到；當成該項失敗才會套用聊天室的指數退避（30 秒 → 30 分鐘）。`getOptions` 的逾時另外處理（見 ensureOptions）。

const repairPrompt = (reason: string): string =>
  `你上一則回覆無法使用（${reason.slice(0, 300)}）。請只輸出一個符合先前格式要求的 JSON 物件：不要任何說明、不要用 Markdown 或程式碼圍欄包起來。`

// ───────────────────────── port ─────────────────────────

export interface HostAiPortOptions {
  /** `context.host.ai`。 */
  ai: PluginBackendAiApiV1
  /** 目前存的 AI 選擇（設定的 `pluginAi`）；每次呼叫前讀，所以設定一改就生效。 */
  selection?: () => unknown
  clock?: Clock
  config?: Partial<HostAiConfig>
  /** 診斷輸出（測試／除錯）；不含訊息內容。 */
  log?: (event: string, detail?: Record<string, unknown>) => void
}

export interface HostAiPort extends AiPort {
  /** 讀好 host 的模型清單與額度並選好供應者／模型；回 true＝可以送。不會 throw（原因在 `status()`）。`force`＝不用快取，向 host 重新確認（回顧開始前）。 */
  ready(force?: boolean): Promise<boolean>
  /** 背景工作現在是不是在等配額視窗（保留輪數之後）：null＝不用等；否則何時有空、哪個視窗滿了。狀態列用它說「已達上限」而不是「已就緒」。 */
  windowWait(priority?: AiPriority): { resumeAt: number; scope: 'minute' | 'hour' } | null
  /** 還要多久 port 才預期能接新工作（配額退避、額度、供應者重試、授權探測；背景工作另加保留輪數後的視窗空檔）；0＝現在就行。 */
  blockedFor(priority?: AiPriority): number
  status(): AiStatus
  onStatus(listener: (status: AiStatus) => void): () => void
  /** host 的模型清單（設定頁用）；失敗時 throw（Error 帶 host 的 `.code`）。 */
  options(): Promise<PluginBackendAiOptionsV1>
  /** 忘掉快取的選項與退避（設定改了、使用者重新開啟看板、授權可能恢復）。 */
  refresh(): void
  /** 停止：佇列中的工作以 `backend_stopped` 失敗，等待中的睡眠立刻醒來。 */
  stop(): void
}

interface Job {
  req: AiPortRequest
  resolve(value: AiPortResult): void
  reject(error: unknown): void
  seq: number
}

type Choice = { providerId: string; modelId: string | null; effort: HostAiEffort | null }
/** 背景工作等配額時被使用者工作插隊：放回佇列最前面，讓使用者工作先走。 */
const PREEMPTED = Symbol('preempted')

export function createHostAiPort(opts: HostAiPortOptions): HostAiPort {
  const clock = opts.clock ?? SYSTEM_CLOCK
  const cfg: HostAiConfig = { ...HOST_AI_DEFAULTS, ...opts.config }
  const log = (event: string, detail?: Record<string, unknown>): void => { try { opts.log?.(event, detail) } catch { /* 診斷失敗不影響流程 */ } }
  const turnWindow = new TurnWindow(cfg.perMinute, cfg.perHour, cfg.windowMarginMs)
  const counters: AiCounters = { ...EMPTY_AI_COUNTERS }
  const statusListeners = new Set<(status: AiStatus) => void>()
  const sleepers = new Set<() => void>()
  const now = (): number => clock.now()

  let stopped = false
  let running = false
  let inFlight = false
  let seq = 0
  const queue: Job[] = []
  let userArrived: (() => void) | null = null

  let sel = normalizeHostAiSelection(undefined)
  let selInit = false
  let optionsAt = -Infinity
  let choice: Choice | null = null
  let providerReason: string | null = 'loading_models'
  let limits: PluginBackendAiOptionsV1['limits'] = { systemChars: AI_CHAT_REFERENCE.systemChars, transcriptLines: AI_CHAT_REFERENCE.transcriptLines, transcriptChars: AI_CHAT_REFERENCE.transcriptChars, inputChars: AI_CHAT_REFERENCE.inputChars, imageBytes: 0, turnsPerMinute: cfg.perMinute }
  let revoked = false
  let revokedUntil = 0
  let optionsInFlight: Promise<PluginBackendAiOptionsV1> | null = null
  const blockers = { rate: 0, quota: 0, provider: 0, busy: 0 }
  let rateAttempts = 0
  let lastStatusKey = ''

  // ── 狀態 ──
  const gate = (at: number): { reason: 'rate_limited' | 'quota_exhausted' | 'provider' | 'busy'; until: number } | null => {
    let best: { reason: 'rate_limited' | 'quota_exhausted' | 'provider' | 'busy'; until: number } | null = null
    const consider = (reason: 'rate_limited' | 'quota_exhausted' | 'provider' | 'busy', until: number): void => { if (until > at && (best === null || until > best.until)) best = { reason, until } }
    consider('rate_limited', blockers.rate)
    consider('quota_exhausted', blockers.quota)
    consider('provider', blockers.provider)
    consider('busy', blockers.busy)
    return best
  }

  const computeStatus = (): AiStatus => {
    const at = now()
    const base = { busy: inFlight, provider: choice ? { providerId: choice.providerId, modelId: choice.modelId } : null, counters: { ...counters }, turnsPerMinute: turnWindow.perMinute, turnsPerHour: turnWindow.perHour }
    if (stopped) return { state: 'stopped', reason: null, resumeAt: null, ...base }
    if (revoked) return { state: 'revoked', reason: 'access_revoked', resumeAt: revokedUntil > at ? revokedUntil : null, ...base }
    if (providerReason !== null) return { state: 'unavailable', reason: providerReason, resumeAt: blockers.provider > at ? blockers.provider : null, ...base }
    const blocked = gate(at)
    if (blocked) return { state: 'paused', reason: blocked.reason === 'provider' ? 'provider_unavailable' : blocked.reason, resumeAt: blocked.until, ...base }
    return { state: 'running', reason: null, resumeAt: null, ...base }
  }

  const emitStatus = (): void => {
    const status = computeStatus()
    const key = JSON.stringify([status.state, status.reason, status.resumeAt, status.busy, status.provider, status.turnsPerMinute])
    if (key === lastStatusKey) return
    lastStatusKey = key
    for (const listener of [...statusListeners]) { try { listener(status) } catch { /* 訂閱者錯誤不影響流程 */ } }
  }

  // ── 計時 ──
  /** 睡 ms；`interruptible` 時使用者工作到達會提前醒來（回 true）。 */
  const sleep = (ms: number, interruptible = false): Promise<boolean> => new Promise<boolean>((resolve) => {
    let timer: unknown = null
    const finish = (early: boolean): void => {
      if (timer !== null) clock.clearTimeout(timer)
      timer = null
      sleepers.delete(wake)
      if (userArrived === wakeEarly) userArrived = null
      resolve(early)
    }
    const wake = (): void => finish(false)
    const wakeEarly = (): void => finish(true)
    sleepers.add(wake)
    if (interruptible) userArrived = wakeEarly
    timer = clock.setTimeout(() => finish(false), Math.max(0, ms))
  })

  // ── host 選項與供應者選擇 ──
  const markRevoked = (): void => {
    revoked = true
    revokedUntil = now() + cfg.revokedProbeMs
    choice = null
  }

  const providerError = (): AiPortError => {
    const code = providerReason === 'model_unavailable' || providerReason === 'effort_unavailable' ? 'model_unavailable'
      : providerReason === 'host_unavailable' ? 'plugin_host_unavailable' : 'provider_unavailable'
    return new AiPortError(code, Math.max(0, blockers.provider - now()) || (code === 'plugin_host_unavailable' ? cfg.optionsRetryMs : cfg.providerRetryMs))
  }

  /**
   * `host.ai.getOptions()`，同時只問一次、最多等 `optionsGuardMs`。host 對一次呼叫的逾時是 30 s，和 backend 單次呼叫的 30 s 上限同時到期時 Core 會把整個 backend 隔離
   * （review F1），所以這裡自己先放棄；放棄後 host 那邊的呼叫自己會結束，我們不等它。
   */
  const fetchOptions = (): Promise<PluginBackendAiOptionsV1> => {
    if (optionsInFlight) return optionsInFlight
    const request = new Promise<PluginBackendAiOptionsV1>((resolve, reject) => {
      const timer = clock.setTimeout(() => reject(new AiPortError('plugin_host_timeout', cfg.optionsRetryMs)), cfg.optionsGuardMs)
      Promise.resolve().then(() => opts.ai.getOptions()).then(
        (value) => { clock.clearTimeout(timer); resolve(value) },
        (error: unknown) => { clock.clearTimeout(timer); reject(error) }
      )
    })
    optionsInFlight = request
    const done = (): void => { if (optionsInFlight === request) optionsInFlight = null }
    request.then(done, done)
    return request
  }

  const ensureOptions = async (force = false): Promise<void> => {
    const selection = normalizeHostAiSelection(opts.selection?.())
    if (!selInit || selection.providerId !== sel.providerId || selection.modelId !== sel.modelId || selection.effort !== sel.effort) {
      sel = selection
      selInit = true
      optionsAt = -Infinity
      choice = null
      providerReason = 'loading_models'
      blockers.provider = 0
    }
    const at = now()
    if (revoked) {
      if (!force && at < revokedUntil) throw new AiPortError('access_revoked', revokedUntil - at)
      optionsAt = -Infinity // 探測：授權可能已恢復
    }
    if (!force && at - optionsAt < cfg.optionsTtlMs && (choice !== null || providerReason !== null)) {
      if (choice !== null) return
      throw providerError()
    }
    let options: PluginBackendAiOptionsV1
    try {
      options = await fetchOptions()
    } catch (error) {
      const code = codeOf(error)
      if (ACCESS_CODES.has(code)) { markRevoked(); emitStatus(); throw new AiPortError('access_revoked', cfg.revokedProbeMs) }
      choice = null
      // 供應者本身有問題（host 明說）→ 慢慢再看；逾時、host 不通這類「暫時沒回應」→ 用暫時性的原因文字、較短的間隔再問（review F7）。
      const providerDown = PROVIDER_CODES.has(code) && code !== 'unavailable'
      providerReason = providerDown ? 'provider_unavailable' : 'host_unavailable'
      const retryMs = providerDown ? cfg.providerRetryMs : cfg.optionsRetryMs
      blockers.provider = now() + retryMs
      // 快取只管 `optionsTtlMs`；暫時失敗要在 retryMs 之後就重問，所以把「上次問的時間」往前挪。
      optionsAt = now() - Math.max(0, cfg.optionsTtlMs - retryMs)
      emitStatus()
      throw providerError()
    }
    revoked = false
    optionsAt = now()
    limits = options.limits
    turnWindow.perMinute = Math.min(cfg.perMinute, options.limits.turnsPerMinute)
    blockers.quota = options.quota.state === 'exhausted' ? now() + (options.quota.retryAfterMs && options.quota.retryAfterMs > 0 ? options.quota.retryAfterMs : cfg.quotaDefaultMs) : 0
    const wanted = sel.providerId ?? options.defaultProviderId
    const provider = sel.providerId !== null
      ? options.providers.find((p) => p.id === sel.providerId && p.state === 'ready') ?? null
      : options.providers.find((p) => p.id === wanted && p.state === 'ready') ?? options.providers.find((p) => p.state === 'ready') ?? null
    if (provider === null) {
      choice = null
      const sample = options.providers.find((p) => p.id === wanted) ?? (sel.providerId === null ? options.providers[0] : undefined)
      providerReason = sample ? `provider_${sample.state}` : sel.providerId === null ? 'no_provider' : 'provider_not_found'
      blockers.provider = now() + cfg.providerRetryMs
      emitStatus()
      throw providerError()
    }
    const model = sel.modelId !== null
      ? provider.models.find((m) => m.id === sel.modelId) ?? null
      : provider.models.find((m) => m.isDefault) ?? provider.models[0] ?? null
    if (!model || (sel.effort !== null && !model.efforts.includes(sel.effort))) {
      choice = null
      providerReason = !model ? 'model_unavailable' : 'effort_unavailable'
      blockers.provider = now() + cfg.providerRetryMs
      emitStatus()
      throw providerError()
    }
    choice = { providerId: provider.id, modelId: model.id, effort: sel.effort }
    providerReason = null
    blockers.provider = 0
    emitStatus()
  }

  // ── 一次 host 呼叫 ──
  const waitForSlot = async (reserve: number, hourReserve: number, maxWaitMs: number, preemptible: boolean): Promise<void> => {
    for (;;) {
      if (stopped) throw new AiPortError('backend_stopped')
      const { ms, scope } = turnWindow.wait(now(), reserve, hourReserve)
      if (ms <= 0) return
      if (ms > maxWaitMs) { counters.rateLimited += 1; throw new AiPortError('rate_limited', ms, scope ?? undefined) }
      if (await sleep(ms, preemptible)) throw PREEMPTED
    }
  }

  const withGuard = <T>(work: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    const timer = clock.setTimeout(() => reject(new AiPortError('turn_timeout')), cfg.completeGuardMs)
    work.then((value) => { clock.clearTimeout(timer); resolve(value) }, (error: unknown) => { clock.clearTimeout(timer); reject(error) })
  })

  /** 把 host 的失敗代碼分類成全域退避＋要 throw 的錯誤。 */
  const classify = async (code: string): Promise<AiPortError> => {
    const at = now()
    if (ACCESS_CODES.has(code)) { markRevoked(); return new AiPortError('access_revoked', cfg.revokedProbeMs) }
    if (code === 'rate_limited') {
      rateAttempts += 1
      counters.rateLimited += 1
      const delay = Math.min(cfg.rateBackoffBaseMs * 2 ** (rateAttempts - 1), cfg.rateBackoffMaxMs)
      blockers.rate = at + delay
      return new AiPortError('rate_limited', delay)
    }
    if (code === 'quota_exhausted') {
      // 向 host 問還要多久（`quota.retryAfterMs`）；問不到就用預設冷卻。
      await ensureOptions(true).catch(() => undefined)
      if (blockers.quota <= now()) blockers.quota = now() + cfg.quotaDefaultMs
      return new AiPortError('quota_exhausted', Math.max(0, blockers.quota - now()))
    }
    if (PROVIDER_CODES.has(code)) {
      blockers.provider = at + cfg.providerRetryMs
      optionsAt = -Infinity
      choice = null
      providerReason = code === 'model_unavailable' ? 'model_unavailable' : 'provider_unavailable'
      return new AiPortError(code, cfg.providerRetryMs)
    }
    if (code === 'plugin_host_unavailable') {
      blockers.provider = at + cfg.hostRetryMs
      optionsAt = -Infinity
      choice = null
      providerReason = 'host_unavailable'
      return new AiPortError(code, cfg.hostRetryMs)
    }
    if (BUSY_CODES.has(code)) {
      blockers.busy = at + cfg.busyBackoffMs
      return new AiPortError('busy', cfg.busyBackoffMs)
    }
    return new AiPortError(code)
  }

  const callHost = async (input: Parameters<PluginBackendAiApiV1['complete']>[0]): Promise<string> => {
    for (let attempt = 0; ; attempt += 1) {
      if (stopped) throw new AiPortError('interrupted')
      const at = now()
      turnWindow.record(at)
      inFlight = true
      emitStatus()
      try {
        const reply = await withGuard(opts.ai.complete(input))
        counters.turns += 1
        rateAttempts = 0
        return reply.text
      } catch (error) {
        const code = codeOf(error)
        // not a host failure (no `.code`): something in our own call path broke. Only the error class goes to the diagnostics — a message could quote LINE text.
        if (typeof (error as { code?: unknown } | null)?.code !== 'string') log('host call threw', { code, error: typeof (error as { name?: unknown } | null)?.name === 'string' ? String((error as { name: string }).name).slice(0, 40) : typeof error })
        if (NOT_ACCEPTED.has(code)) turnWindow.unrecord(at)
        else counters.turns += 1
        if (BUSY_CODES.has(code) && attempt < cfg.busyRetries) { inFlight = false; await sleep(cfg.busyRetryMs); continue }
        throw await classify(code)
      } finally {
        inFlight = false
        emitStatus()
      }
    }
  }

  // ── 一個工作 ──
  const run = async (job: Job): Promise<AiPortResult> => {
    const req = job.req
    await ensureOptions()
    if (req.system.length > limits.systemChars) throw new AiPortError('system_too_large')
    if (req.user.length > limits.inputChars) throw new AiPortError('input_too_large')
    const picked = choice!
    const reserve = req.priority === 'background' ? cfg.extractReserve : 0
    const hourReserve = req.priority === 'background' ? cfg.extractHourReserve : 0
    const maxWait = req.priority === 'user' ? cfg.userMaxWaitMs : cfg.backgroundMaxWaitMs
    const preemptible = req.priority === 'background'
    // 背景工作在讀 host 選項的期間，使用者工作可能已經到了：讓它先走，不要等背景工作睡完配額空檔才輪到（review F4）。
    if (preemptible && queue.some((queued) => queued.req.priority === 'user')) throw PREEMPTED
    // 全域退避中：不打 host，直接把「還要等多久」交給呼叫端（busy 只是 host 還在收尾，睡一下再走）。
    const blocked = gate(now())
    if (blocked && blocked.reason !== 'busy') {
      throw new AiPortError(blocked.reason === 'provider' ? 'provider_unavailable' : blocked.reason, Math.max(0, blocked.until - now()))
    }
    if (blocked) await sleep(blocked.until - now(), preemptible).then((early) => { if (early) throw PREEMPTED })
    await waitForSlot(reserve, hourReserve, maxWait, preemptible)

    const base = { system: req.system, providerId: picked.providerId, ...(picked.modelId !== null ? { modelId: picked.modelId } : {}), ...(picked.effort !== null ? { effort: picked.effort } : {}) }
    const model = picked.modelId
    const first = await callHost({ ...base, text: req.user })
    if (!req.expectJson) return { text: first.trim(), model }

    let reply = first
    for (let repair = 0; ; repair += 1) {
      const parsed = parseModelJson(reply)
      let reason: string
      let failure: 'invalid_json' | 'invalid_result'
      if (parsed.ok) {
        const checked = req.validate ? req.validate(parsed.value) : { ok: true as const, value: parsed.value }
        if (checked.ok) return { text: JSON.stringify(checked.value), value: checked.value, model }
        reason = checked.reason
        failure = 'invalid_result'
      } else {
        reason = `不是合法的 JSON（${parsed.reason}）`
        failure = 'invalid_json'
      }
      if (repair >= cfg.maxRepairs) throw new AiPortError(failure)
      counters.repairs += 1
      // `complete` 回覆後 session 就關了：重問時把前一輪的問與答當 transcript 帶過去（每行 ≤ 8,000 字）。
      // 等不到配額就把 rate_limited 原樣交出去：那是暫時的（呼叫端放回租約、稍後整個項目重來），不是這一項的 invalid_json（review F6）。
      await waitForSlot(reserve, hourReserve, maxWait, false)
      const lineMax = AI_CHAT_REFERENCE.transcriptLineChars
      reply = await callHost({
        ...base,
        transcript: [{ role: 'user', text: req.user.slice(0, lineMax) }, { role: 'assistant', text: reply.slice(0, lineMax) }],
        text: repairPrompt(reason)
      })
    }
  }

  const pick = (): Job | undefined => {
    const index = queue.findIndex((job) => job.req.priority === 'user')
    return queue.splice(index >= 0 ? index : 0, 1)[0]
  }

  const pump = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      for (let job = pick(); job !== undefined; job = pick()) {
        try {
          const result = await run(job)
          if (job.req.priority === 'user') counters.tasksDone += 1
          job.resolve(result)
        } catch (error) {
          if (error === PREEMPTED) { queue.unshift(job); continue }
          if (job.req.priority === 'user') counters.tasksFailed += 1
          log('complete failed', { code: codeOf(error), priority: job.req.priority })
          job.reject(error instanceof AiPortError ? error : new AiPortError(codeOf(error)))
        }
        emitStatus()
      }
    } finally {
      running = false
      emitStatus()
    }
  }

  return {
    complete(req) {
      if (stopped) return Promise.reject(new AiPortError('backend_stopped'))
      return new Promise<AiPortResult>((resolve, reject) => {
        queue.push({ req, resolve, reject, seq: (seq += 1) })
        if (req.priority === 'user') userArrived?.()
        void pump()
      })
    },
    async ready(force = false) {
      try { await ensureOptions(force); return true } catch { return false }
    },
    blockedFor(priority = 'user') {
      const at = now()
      let until = 0
      if (priority === 'background') until = at + turnWindow.delay(at, cfg.extractReserve, cfg.extractHourReserve)
      if (revoked) until = Math.max(until, revokedUntil)
      if (providerReason !== null) until = Math.max(until, blockers.provider)
      const blocked = gate(at)
      if (blocked) until = Math.max(until, blocked.until)
      return Math.max(0, until - at)
    },
    status: computeStatus,
    onStatus(listener) {
      statusListeners.add(listener)
      return () => { statusListeners.delete(listener) }
    },
    windowWait(priority = 'background') {
      const at = now()
      const { ms, scope } = priority === 'background' ? turnWindow.wait(at, cfg.extractReserve, cfg.extractHourReserve) : turnWindow.wait(at)
      return ms > 0 && scope !== null ? { resumeAt: at + ms, scope } : null
    },
    options: () => fetchOptions(),
    refresh() {
      optionsAt = -Infinity
      revokedUntil = 0
      blockers.provider = 0
      blockers.busy = 0
      if (!revoked) { choice = null; providerReason = 'loading_models' }
      emitStatus()
    },
    stop() {
      if (stopped) return
      stopped = true
      for (const job of queue.splice(0)) job.reject(new AiPortError('backend_stopped'))
      for (const wake of [...sleepers]) wake()
      emitStatus()
    }
  }
}

/**
 * 沒有 `context.host.ai`（單元測試；正式環境 Core >=1.7.13 一定有）：一個永遠「尚未啟動」的 port。
 * 背景抽取不啟動，AI 功能一律以 `provider_unavailable` 失敗，不會假裝成功。
 */
export function createNoHostAiPort(): HostAiPort {
  const status = (): AiStatus => ({ state: 'stopped', reason: null, resumeAt: null, busy: false, provider: null, counters: { ...EMPTY_AI_COUNTERS } })
  return {
    complete: () => Promise.reject(new AiPortError('provider_unavailable')),
    ready: () => Promise.resolve(false),
    blockedFor: () => 0,
    windowWait: () => null,
    status,
    onStatus: () => () => undefined,
    options: () => Promise.reject(Object.assign(new Error('host request failed: unavailable'), { code: 'unavailable' })),
    refresh: () => undefined,
    stop: () => undefined
  }
}
