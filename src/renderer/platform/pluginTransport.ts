/**
 * pluginTransport.ts — 外掛 view 與 backend 之間的請求傳輸（`window.tuqPlugin.backend.call(<方法組>, { path, args })`）。
 *
 * 方法名稱（G-07）：manifest 的 `backendMethods` 是命名空間分組（`src/shared/pluginWire.ts` 的 `BACKEND_METHOD_GROUPS`），
 * 每次呼叫用 `backendMethodFor(path)` 選出所屬的組；不屬於任何一組的路徑在 view 端就以 `path_unknown` 拒絕，不送給 host。
 *
 * 連線狀態（G-03）：每次 host 呼叫的結果決定 `link()`——成功＝`ok`；`ACCESS_HOST_CODES`（`plugin_permission_denied`／`plugin_disabled`／
 * `backend_invoke_timeout`／`plugin_not_installed`）＝`revoked`（TeamUQ 已隔離這個外掛的後端呼叫：權限被關閉、外掛被停用或後端逾時，或外掛已移除；
 * Core 會把 backend 停掉，重試沒有用）；backend 沒起來／忙／當掉＝`unavailable`。畫面用 `onLink()` 顯示明確的原因，而不是空白看板。
 *
 * 只描述 TeamUQ 1.6.8 view bridge 與 backend dispatcher（`src/plugin/backend/dispatcher.ts`）的線上格式，不碰 React／DOM：
 *   - host：`backend.call(method, params)` 把 params 驗成 JSON（陣列 ≤ 4096、數字必須有限、不能有 undefined），請求／回應各 ≤ 64 KiB，
 *     view 同時進行中 ≤ 8，單次 ≤ 30 s；失敗時 reject `Error(<固定錯誤碼>)`（`pluginViewBridge.ts:89-95`）。
 *   - backend controller：同時處理的呼叫數 ≤ manifest 的 `resources.maxSessions`（本外掛 4；`backendController.ts:395`），超過回 `plugin_backend_busy`，
 *     而 1.6.8 的 invoke gate 會把它對 view 轉成 `plugin_backend_unavailable`（`backendInvokeGate.ts:156-160`），所以 view 分不出「忙」與「真的不可用」。
 *   - backend envelope：`{ok:true,value}`／`{ok:true,pending,jobId}`／`{ok:true,chunked,resultId,chunks}`／`{ok:false,code,message?,route?}`。
 *     pending 用 `job.poll` 收（長時間的 reviewLastDays）；chunked 用 `result.chunk` 逐段取回再 JSON.parse（結果超過 64 KiB）。
 *
 * 併發預算（review F1）：一個 view 的所有 host 呼叫（一般請求、job.poll、result.chunk，以及事件長輪詢 `events.*`）共用同一個上限
 * `maxConcurrentCalls`，預設 3＝長輪詢 1 ＋ 其他 2；設定 view 只用 1（而且不開事件輪詢）。兩個 view 同時開著：3 ＋ 1 ＝ 4 ＝ `maxSessions`。
 * 上限針對「每一次 host 呼叫」而不是整個請求：job.poll 的每一輪等待結束就把名額還給排隊中的其他請求，長時間的回顧不會獨佔名額。
 * 即使如此 TeamUQ 自己的診斷呼叫、或另一個 view 仍可能讓 host 回忙碌：`plugin_backend_busy`／`plugin_backend_unavailable` 會以 100 ms 起的指數退避重試
 * （最多 4 次，名額在等待期間是釋放的），超過才 reject。
 *
 * 通道（lane）與等待上限（0.2.9）：總名額仍是 3，但分三條通道，讓聊天室清單與連線狀態不會被輔助呼叫佔滿名額而排不到——
 *   - `core`：其餘所有路徑（ping、line.status、db.*、messages.recent、settings.get、pipeline.status、groupTopics.*、result.chunk、job.poll…），優先出隊；
 *   - `bulk`（同時 ≤ `max(1, 預算 - 2)`，預算 3 格時 1 格）：`media.prepare`、`media.avatar.*`、`ai.status`、`ai.options`（可以慢、可以放棄的輔助資料）。
 *     一個 bulk 呼叫從開始到結束（含它的 `job.poll`／`result.chunk`）都佔著同一個 bulk 名額，超過上限的排在 bulk 佇列（不佔 core 名額）；
 *     `invoke(path, args, { signal })` 在還沒拿到名額前 abort 會把它丟掉（`cancelled`，不送給 backend），已經送出的不收回；
 *   - `events`（同時 ≤1）：`events.*` 長輪詢（`events.close` 例外走 core，維持關閉時立刻送出）。
 *   總名額 3 ＝ core 至少永遠有 1 個。`maxConcurrentCalls` < 3（設定 view 用 1）時不分通道，維持單一 FIFO。
 *   每個佔用名額的 host 呼叫都有等待上限，逾時就釋放名額並 reject `view_call_timeout`（host 那一端的呼叫取消不了，晚到的結果丟掉）。逾時**不**改變連線狀態
 *   （不會變成 `revoked`；那是 host 自己的隔離）。上限：core 10 s、ping 35 s（比 host 的 30 s 長，所以 ping 的結果以 host 為準）、bulk 15 s（靜默降級：
 *   呼叫端本來就把失敗當成「沒有圖片／狀態」處理，不影響 phase）、events 不設上限。AI 草擬／分析、回顧、補金鑰這類「backend 本來就要跑 20 s 才轉成 job」的路徑
 *   （`LONG_CALL_PATHS`）走 core 但上限 35 s，否則第一次呼叫會在 backend 還在工作時被畫面端放棄。上限可用 `TransportOptions.timeouts` 覆寫。
 *
 * phase（畫面的「後端啟動中」與「連線中」要能分得出來）：`starting`＝第一個 ping 已送出、還沒有任何成功回應、且已過 `startingAfterMs`（1.2 s）；
 * `connecting`＝尚未 ready（`line.status` 或 `db.chats.list` 還沒回，包含 ping 已回的情況）；`ready`＝兩者都回過；`timeout`＝狀態列顯示的路徑逾時了、而且還沒有恢復——只看「橋接狀態路徑」`STATUS_TIMEOUT_PATHS`（`line.status`、`messages.recent`、`db.chats.list`；`job.poll`／`result.chunk` 逾時算在發出它的路徑上），
 * 逾時只由「同一個 path」的成功清除（無關的 core 呼叫成功不會清掉它）；`ping` 逾時由任一 core 呼叫成功清除（後端已經活著）；其他 core 路徑（`db.messages.list` 等）逾時不進 `timeout`，各元件在自己的畫面顯示錯誤與恢復方式（逾時仍計入 `diagnostics()`）；
 * `error`＝連線狀態是 `revoked`／`unavailable`（ping 還在等的 starting 階段除外，因為那時 host 還沒起來是預期的）。`phase()`／`onPhase()`／`diagnostics()` 提供給畫面。
 */

import { MAX_REQUEST_BYTES, backendMethodFor } from '../../shared/pluginWire'

/** `window.tuqPlugin` 中本外掛用到的部分。0.2.0 起 view 不再使用 view 端的 AI 橋接：AI 在 backend 經 `context.host.ai` 執行。 */
export interface TuqPluginHost {
  backend: { call(method: string, params: unknown): Promise<unknown> }
  assets?: { url(path: string): string }
}

export class PluginApiError extends Error {
  readonly code: string
  readonly path: string
  readonly route: string | undefined
  constructor(code: string, path: string, message?: string, route?: string) {
    super(message ? `${code}: ${message}` : code)
    this.name = 'PluginApiError'
    this.code = code
    this.path = path
    this.route = route
  }
}

/** backend 明確表示「外掛版不提供這個功能」（`unsupported_in_plugin`）。 */
export class PluginUnsupportedError extends PluginApiError {
  readonly detail: string
  constructor(path: string, detail: string, route?: string) {
    super('unsupported_in_plugin', path, detail, route)
    this.name = 'PluginUnsupportedError'
    this.detail = detail
  }
}

/** host 層級的失敗（backend 沒起來／當掉／逾時／權限…）：訊息就是 host 的固定錯誤碼。 */
export class PluginBackendError extends PluginApiError {
  constructor(path: string, hostCode: string) {
    super(hostCode, path)
    this.name = 'PluginBackendError'
  }
  /** TeamUQ 已隔離這個外掛的後端呼叫（權限關閉、停用、逾時）或外掛已移除：重試不會好，要使用者在 TeamUQ 處理。 */
  get accessDenied(): boolean { return ACCESS_HOST_CODES.has(this.code) }
}

/**
 * host 對「這個外掛不能用 backend」的說法（Core 1.7.1 `backendInvokeGate.ts`；review B1）：
 *   - `plugin_permission_denied`：隔離當下進行中的呼叫（revoke：關閉 backend:invoke 或停用外掛），或權限仍是關閉的；
 *   - `backend_invoke_timeout`：單次呼叫逾時，Core 隔離整個外掛（timeoutPlugin）；
 *   - `plugin_disabled`：隔離之後的每一個新呼叫（不論隔離原因），或外掛真的是停用的；
 *   - `plugin_not_installed`：外掛已移除。
 * 隔離只在外掛停用再啟用（activate）或 TeamUQ 重新啟動後解除；重新允許權限不會解除。
 */
export const ACCESS_HOST_CODES: ReadonlySet<string> = new Set(['plugin_permission_denied', 'plugin_disabled', 'backend_invoke_timeout', 'plugin_not_installed'])
/** host 對「backend 暫時不能用」的說法（沒起來、忙、當掉；沒有隔離）。 */
export const UNAVAILABLE_HOST_CODES: ReadonlySet<string> = new Set(['plugin_backend_unavailable', 'plugin_backend_busy', 'plugin_backend_crashed', 'backend_call_failed'])

export type BackendLinkState = 'unknown' | 'ok' | 'revoked' | 'unavailable'
export interface BackendLink {
  state: BackendLinkState
  /** 最近一次失敗的 host 錯誤碼（`ok`／`unknown` 時為 null）。 */
  code: string | null
}

export { MAX_REQUEST_BYTES }
const MAX_ARGS = 8

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 轉成 host 接受的純 JSON：尾端的 undefined 參數拿掉（`recentByChat(id, undefined)` 不能變成 null），其餘經 JSON 往返。 */
export function toWire(path: string, args: readonly unknown[]): { path: string; args: unknown[] } {
  const list = [...args]
  while (list.length > 0 && list[list.length - 1] === undefined) list.pop()
  if (list.length > MAX_ARGS) throw new PluginApiError('invalid_args', path, `at most ${MAX_ARGS} arguments`)
  let text: string | undefined
  try { text = JSON.stringify({ path, args: list }) } catch { text = undefined }
  if (text === undefined) throw new PluginApiError('invalid_args', path, 'arguments are not JSON-serializable')
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) throw new PluginApiError('request_too_large', path, `request exceeds ${MAX_REQUEST_BYTES} bytes`)
  return JSON.parse(text) as { path: string; args: unknown[] }
}

/** 排隊中（尚未開始執行）的呼叫被呼叫端取消。已開始執行的呼叫不會收到這個錯誤。 */
export class CallCancelledError extends Error {
  constructor() {
    super('call_cancelled')
    this.name = 'CallCancelledError'
  }
}

export interface LimiterRunOptions {
  /** 在任務「開始執行之前」abort＝把排隊中的任務丟掉（reject `CallCancelledError`）；任務一旦開始執行，abort 不影響它。 */
  signal?: AbortSignal
}

interface LaneWaiter { resume(): void; cancel(): void }

export type CallLane = 'core' | 'bulk' | 'events'
const LANE_ORDER: readonly CallLane[] = ['core', 'bulk', 'events']

/**
 * 總名額 `max`、每條通道各有自己的上限與 FIFO 佇列。名額釋放時依 core → bulk → events 的順序接棒，所以 core 排隊者永遠先拿到名額；
 * 輔助通道各自的上限（bulk／events 各 1）則保證總名額 3 時 core 永遠至少有 1 個。
 */
export class LaneLimiter {
  private readonly active: Record<CallLane, number> = { core: 0, bulk: 0, events: 0 }
  private readonly waiting: Record<CallLane, LaneWaiter[]> = { core: [], bulk: [], events: [] }
  private total = 0
  private readonly max: number
  private readonly caps: Record<CallLane, number>
  constructor(max: number, caps: Record<CallLane, number>) {
    this.max = Math.max(1, Math.floor(max))
    this.caps = caps
  }

  private canStart(lane: CallLane): boolean { return this.total < this.max && this.active[lane] < this.caps[lane] }
  private start(lane: CallLane): void { this.active[lane] += 1; this.total += 1 }

  async run<T>(lane: CallLane, task: () => Promise<T>, options?: LimiterRunOptions): Promise<T> {
    const signal = options?.signal
    if (signal?.aborted) throw new CallCancelledError()
    // 排隊者由 pump 在釋放名額的同一刻接棒（先 start 再喚醒），所以名額數字在喚醒的空檔也是對的；排隊中 abort 就離開佇列（還沒拿到名額，不影響名額數字）
    if (this.waiting[lane].length > 0 || !this.canStart(lane)) {
      await new Promise<void>((resolve, reject) => {
        const waiter: LaneWaiter = {
          resume: () => { signal?.removeEventListener('abort', waiter.cancel); resolve() },
          cancel: () => {
            const index = this.waiting[lane].indexOf(waiter)
            if (index < 0) return
            this.waiting[lane].splice(index, 1)
            reject(new CallCancelledError())
          }
        }
        this.waiting[lane].push(waiter)
        signal?.addEventListener('abort', waiter.cancel, { once: true })
      })
    } else this.start(lane)
    try {
      return await task()
    } finally {
      this.active[lane] -= 1
      this.total -= 1
      this.pump()
    }
  }

  private pump(): void {
    for (const lane of LANE_ORDER) {
      while (this.waiting[lane].length > 0 && this.canStart(lane)) {
        this.start(lane)
        const next = this.waiting[lane].shift()
        if (next) next.resume()
      }
    }
  }

  stats(): { active: number; waiting: number; lanes: Record<CallLane, { active: number; waiting: number }> } {
    const lane = (name: CallLane): { active: number; waiting: number } => ({ active: this.active[name], waiting: this.waiting[name].length })
    return { active: this.total, waiting: LANE_ORDER.reduce((sum, name) => sum + this.waiting[name].length, 0), lanes: { core: lane('core'), bulk: lane('bulk'), events: lane('events') } }
  }
  get limit(): number { return this.max }
}

/** 先進先出的併發上限（單一通道；設定 view 與 `maxConcurrentCalls` < 3 的傳輸用同一套邏輯）。 */
export class Limiter {
  private readonly inner: LaneLimiter
  constructor(max: number) {
    const cap = Math.max(1, Math.floor(max))
    this.inner = new LaneLimiter(cap, { core: cap, bulk: cap, events: cap })
  }
  run<T>(task: () => Promise<T>, options?: LimiterRunOptions): Promise<T> { return this.inner.run('core', task, options) }
  stats(): { active: number; waiting: number } { const { active, waiting } = this.inner.stats(); return { active, waiting } }
  get limit(): number { return this.inner.limit }
}

/** host 對「忙」的兩種說法：controller 的 `plugin_backend_busy`，與 1.6.8 invoke gate 轉出來給 view 的 `plugin_backend_unavailable`。 */
export const BUSY_HOST_CODES: ReadonlySet<string> = new Set(['plugin_backend_busy', 'plugin_backend_unavailable'])

export interface BusyRetryOptions {
  /** 最多重試幾次（不含第一次）；0＝不重試。預設 4。 */
  attempts?: number
  /** 第 n 次重試前等 `min(baseMs * 2^n, maxMs)`（再乘 0.75–1.25 的抖動）。預設 100 ms 起、上限 1,000 ms。 */
  baseMs?: number
  maxMs?: number
  sleep?(ms: number): Promise<void>
  random?(): number
}

/** 畫面端等 host 回覆的上限（ms）。`ping` 比 host 的 30 s 長；`longMs` 給 backend 本來就會跑到 soft deadline（20 s）才轉成 job 的路徑。 */
export interface TransportTimeouts {
  coreMs?: number
  pingMs?: number
  longMs?: number
  bulkMs?: number
}
export const DEFAULT_TIMEOUTS: Readonly<Required<TransportTimeouts>> = Object.freeze({ coreMs: 10_000, pingMs: 35_000, longMs: 35_000, bulkMs: 15_000 })
export const DEFAULT_STARTING_AFTER_MS = 1_200
/** 畫面端放棄等待時 reject 的錯誤碼（host 的呼叫取消不了；這不是 host 的隔離，不會讓連線狀態變成 `revoked`）。 */
export const VIEW_CALL_TIMEOUT = 'view_call_timeout'

export type BackendPhase = 'starting' | 'connecting' | 'ready' | 'timeout' | 'error'

export interface BackendDiagnostics {
  phase: BackendPhase
  /** 還沒結束的呼叫（不含 events 長輪詢）：`waitedMs` 從進入佇列起算，`running`＝已佔到名額、host 還沒回。 */
  calls: Array<{ path: string; lane: CallLane; waitedMs: number; running: boolean }>
  /** 最近一次失敗（host 錯誤碼或 `view_call_timeout`；bulk 的逾時靜默降級，不列入）。 */
  lastError: { code: string; path: string } | null
  timeouts: number
}

export interface TransportOptions {
  host: TuqPluginHost
  /** 這個 view 同時進行中的 host 呼叫上限（含事件長輪詢）。預設 3；設定 view 用 1。 */
  maxConcurrentCalls?: number
  /** `job.poll` 每次最久等多久（backend 上限 4 s）。 */
  jobPollWaitMs?: number
  busyRetry?: BusyRetryOptions
  timeouts?: TransportTimeouts
  /** ping 送出多久之後還沒有任何成功回應，phase 才從 `connecting` 變成 `starting`。預設 1,200 ms。 */
  startingAfterMs?: number
}

export const DEFAULT_MAX_CONCURRENT_CALLS = 3

export interface InvokeOptions {
  /**
   * 在這次呼叫「第一個 host 呼叫開始執行之前」abort＝丟掉排隊中的呼叫（reject `PluginApiError('cancelled')`，不送給 backend）。
   * 已經開始執行的呼叫不受影響；`job.poll`／`result.chunk` 這類後續呼叫與事件長輪詢都不吃這個 signal。
   */
  signal?: AbortSignal
  /** 這次呼叫的 host 呼叫真正開始執行（拿到名額）時通知；用來分辨「還在排隊」與「已送出」。 */
  onStart?(): void
}
/** 只有總名額至少是這個數字才分通道（bulk／events 各佔 1，core 至少還有 1）；更小的預算（設定 view 的 1）維持單一 FIFO。 */
export const MIN_LANES_BUDGET = 3
/** bulk 通道永遠不碰的名額：事件長輪詢 1 ＋ 一般（core）請求 1。bulk 同時上限 = `max(1, 預算 - 2)`：預算 3 格時 1 格，預算 5 格時 3 格。 */
export const RESERVED_FOREGROUND_CALLS = 2

const BULK_PATHS: ReadonlySet<string> = new Set(['media.prepare', 'ai.status', 'ai.options'])
/** 狀態列只呈現 LINE 橋接與聊天室清單的狀態：只有這三條 path 的逾時會讓 phase 變成 `timeout`；狀態列的「重試」會重讀這三條。 */
export const STATUS_TIMEOUT_PATHS: ReadonlySet<string> = new Set(['line.status', 'messages.recent', 'db.chats.list'])
/** backend 本來就會執行到 soft deadline（20 s）才回 `pending` 的路徑（AI 草擬／分析、回顧、補金鑰…）：走 core，但等待上限用 `longMs`。 */
export const LONG_CALL_PATHS: ReadonlySet<string> = new Set([
  'db.todos.draftReply', 'db.todos.analyzeNotMine', 'groupTopics.analyze', 'settings.prompt.refine',
  'pipeline.runOnce', 'pipeline.reviewLastDays', 'pipeline.backfillMediaKeys'
])

/** 路徑所屬的通道。`events.close` 走 core：它很短，不該排在還沒回來的長輪詢後面。 */
export function laneFor(path: string): CallLane {
  if (path === 'events.close') return 'core'
  if (path.startsWith('events.')) return 'events'
  if (BULK_PATHS.has(path) || path.startsWith('media.avatar.')) return 'bulk'
  return 'core'
}

/** `job.poll`／`result.chunk` 替 bulk 路徑（頭像、media.prepare…）做事時留在 bulk 通道：輔助資料的後續呼叫不能跑到 core 通道去擠聊天室清單與連線狀態。 */
function laneOf(path: string, owner: string): CallLane {
  const own = laneFor(path)
  return own === 'core' && owner !== path && (path === 'job.poll' || path === 'result.chunk') && laneFor(owner) === 'bulk' ? 'bulk' : own
}

/**
 * 分段結果在 backend 已經不在了（`result_expired`：被擠掉、TTL 到期，或 backend 重新啟動後換了一個新的 dispatcher）時，
 * 唯讀路徑整個重取的最多次數（不含第一次）。寫入類路徑不重送：結果過期不代表那次呼叫沒生效。
 */
export const RESULT_REPLAYS = 2

/** 重送沒有副作用的路徑：清單／單筆讀取、狀態查詢。其餘（update／move／draft／mark／resolve／run／analyze／setXxx…）一律不是。 */
const REPLAY_SAFE_PATHS: ReadonlySet<string> = new Set([
  'messages.recent', 'line.status', 'settings.get',
  'db.messages.list', 'db.messages.recentByChat', 'db.messages.byChatSince', 'db.messages.count',
  'db.chats.list', 'db.chats.get', 'db.chats.todoExtractEnabled',
  'db.todos.list', 'db.todos.get', 'db.todos.openByChat', 'db.todos.listNotMine', 'db.todos.listNotMineCorrections', 'db.todos.getNotMineReview',
  'groupTopics.list', 'groupTopics.overview', 'groupTopics.todoRefs', 'groupTopics.pendingCount',
  'pipeline.status', 'pipeline.loadStats',
  'settings.chatPrompt.get', 'settings.chatPrompt.list'
])
export function isReplaySafePath(path: string): boolean { return REPLAY_SAFE_PATHS.has(path) }

interface PendingCall {
  path: string
  lane: CallLane
  queuedAt: number
  startedAt: number | null
}

export class PluginTransport {
  private readonly host: TuqPluginHost
  private readonly limiter: LaneLimiter
  private readonly lanesEnabled: boolean
  private readonly timeouts: Required<TransportTimeouts>
  private readonly startingAfterMs: number
  private readonly jobWaitMs: number
  private readonly retry: Required<BusyRetryOptions>
  private closed = false
  private busyRetries = 0
  private resultReplays = 0
  private maxActive = 0
  private timeoutCount = 0
  private linkState: BackendLink = { state: 'unknown', code: null }
  private readonly linkListeners = new Set<(link: BackendLink) => void>()
  private readonly pending = new Set<PendingCall>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private lastError: { code: string; path: string } | null = null
  private pingState: 'none' | 'pending' | 'ok' | 'failed' = 'none'
  private pingSentAt = 0
  private responded = false
  private statusAnswered = false
  private chatsAnswered = false
  /** 逾時還沒被「同一個 path」的成功清掉的橋接狀態路徑（`STATUS_TIMEOUT_PATHS`）。無關的 core 呼叫成功不能把它清掉（那會讓「讀取逾時」與「重試」自己消失）。 */
  private readonly timedOutPaths = new Set<string>()
  /** ping 逾時了、之後還沒有任何 core 呼叫成功。 */
  private pingTimedOut = false
  private lastPhase: BackendPhase = 'connecting'
  private readonly phaseListeners = new Set<(phase: BackendPhase) => void>()

  constructor(options: TransportOptions) {
    this.host = options.host
    const budget = Math.max(1, Math.floor(options.maxConcurrentCalls ?? DEFAULT_MAX_CONCURRENT_CALLS))
    this.lanesEnabled = budget >= MIN_LANES_BUDGET
    this.limiter = new LaneLimiter(budget, this.lanesEnabled ? { core: budget, bulk: Math.max(1, budget - RESERVED_FOREGROUND_CALLS), events: 1 } : { core: budget, bulk: budget, events: budget })
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts }
    this.startingAfterMs = options.startingAfterMs ?? DEFAULT_STARTING_AFTER_MS
    this.jobWaitMs = Math.min(4000, Math.max(0, options.jobPollWaitMs ?? 3000))
    const retry = options.busyRetry ?? {}
    this.retry = {
      attempts: Math.max(0, Math.floor(retry.attempts ?? 4)),
      baseMs: retry.baseMs ?? 100,
      maxMs: retry.maxMs ?? 1000,
      sleep: retry.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
      random: retry.random ?? Math.random
    }
  }

  close(): void {
    this.closed = true
    this.linkListeners.clear()
    this.phaseListeners.clear()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }

  /** 目前對 backend 的連線狀態（由最近一次 host 呼叫的結果決定）。 */
  link(): BackendLink { return { ...this.linkState } }
  /** 連線狀態改變時通知（同一狀態＋同一錯誤碼不重複通知）。 */
  onLink(listener: (link: BackendLink) => void): () => void {
    this.linkListeners.add(listener)
    return () => { this.linkListeners.delete(listener) }
  }

  /** `publish=false`：呼叫端緊接著會自己更新 phase 旗標再發布（避免中間狀態被當成 phase 通知出去）。 */
  private setLink(state: BackendLinkState, code: string | null, publish = true): void {
    if (this.linkState.state === state && this.linkState.code === code) return
    this.linkState = { state, code }
    for (const listener of [...this.linkListeners]) { try { listener({ ...this.linkState }) } catch { /* 訂閱者錯誤不影響傳輸 */ } }
    if (publish) this.publishPhase()
  }
  get isClosed(): boolean { return this.closed }
  /**
   * `active`／`waiting`：目前在飛／排隊的 host 呼叫；`maxActive`：歷來同時在飛的最大值；`busyRetries`：因忙碌而重試的次數；
   * `lanes`：各通道的在飛／排隊；`timeouts`：畫面端等待逾時的次數。
   */
  stats(): { active: number; waiting: number; maxActive: number; busyRetries: number; resultReplays: number; limit: number; timeouts: number; lanes: Record<CallLane, { active: number; waiting: number }> } {
    return { ...this.limiter.stats(), maxActive: this.maxActive, busyRetries: this.busyRetries, resultReplays: this.resultReplays, limit: this.limiter.limit, timeouts: this.timeoutCount }
  }

  // ── phase ──

  /** 畫面看到的後端階段（規則見檔頭）。 */
  phase(): BackendPhase {
    if (this.linkState.state === 'revoked') return 'error'
    if (this.pingState === 'pending' && !this.responded) return Date.now() - this.pingSentAt >= this.startingAfterMs ? 'starting' : 'connecting'
    if (this.linkState.state === 'unavailable') return 'error'
    if (this.timedOutPaths.size > 0 || this.pingTimedOut) return 'timeout'
    return this.statusAnswered && this.chatsAnswered ? 'ready' : 'connecting'
  }
  /** phase 改變時通知（同一個 phase 不重複通知）。 */
  onPhase(listener: (phase: BackendPhase) => void): () => void {
    this.phaseListeners.add(listener)
    return () => { this.phaseListeners.delete(listener) }
  }
  private publishPhase(): void {
    const next = this.phase()
    if (next === this.lastPhase) return
    this.lastPhase = next
    for (const listener of [...this.phaseListeners]) { try { listener(next) } catch { /* 訂閱者錯誤不影響傳輸 */ } }
  }
  /** 診斷用快照：phase、還沒結束的呼叫已等待多久、最近一次失敗。 */
  diagnostics(): BackendDiagnostics {
    const now = Date.now()
    const calls = [...this.pending]
      .filter((call) => call.lane !== 'events')
      .map((call) => ({ path: call.path, lane: call.lane, waitedMs: Math.max(0, now - call.queuedAt), running: call.startedAt !== null }))
    return { phase: this.phase(), calls, lastError: this.lastError ? { ...this.lastError } : null, timeouts: this.timeoutCount }
  }
  private noteResponse(path: string, lane: CallLane): void {
    this.responded = true
    if (path === 'ping' && this.pingState !== 'ok') this.pingState = 'ok'
    if (path === 'line.status') this.statusAnswered = true
    if (path === 'db.chats.list') this.chatsAnswered = true
    if (lane === 'core') {
      this.timedOutPaths.delete(path)
      this.pingTimedOut = false
    }
    this.publishPhase()
  }
  /** `owner`：這次呼叫是替哪個 path 做的（`job.poll`／`result.chunk` 替發出請求的 path 做事）；逾時算在 owner 上。 */
  private noteFailure(path: string, lane: CallLane, code: string, owner: string = path): void {
    // bulk 的逾時是靜默降級（頭像、圖片、AI 狀態沒回來不影響看板），不當成「讀取逾時」
    if (!(lane === 'bulk' && code === VIEW_CALL_TIMEOUT)) this.lastError = { code, path }
    if (code === VIEW_CALL_TIMEOUT) {
      this.timeoutCount += 1
      if (lane === 'core') {
        if (STATUS_TIMEOUT_PATHS.has(owner)) this.timedOutPaths.add(owner)
        else if (owner === 'ping') this.pingTimedOut = true
      }
    }
    if (path === 'ping' && this.pingState === 'pending') this.pingState = 'failed'
    this.publishPhase()
  }
  private startPingWatch(): void {
    this.pingState = 'pending'
    this.pingSentAt = Date.now()
    // setTimeout 偶爾比 Date.now() 早一毫秒醒來（Windows 約百分之一）；那時 phase() 還說 connecting，如果不再排一次，「後端啟動中」就永遠不會通知畫面。
    const arm = (ms: number): void => {
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        if (this.closed) return
        const rest = this.startingAfterMs - (Date.now() - this.pingSentAt)
        if (rest > 0 && this.pingState === 'pending' && !this.responded) { arm(Math.max(1, rest)); return }
        this.publishPhase()
      }, ms)
      this.timers.add(timer)
    }
    arm(this.startingAfterMs)
    this.publishPhase()
  }

  /**
   * 一般請求：每一次 host 呼叫（含 job 輪詢、分段取回）各自佔用一個併發名額，名額不跨輪詢持有。
   * 唯讀路徑的分段結果中途過期（`result_expired`）時整個重取，最多 `RESULT_REPLAYS` 次；其他錯誤與寫入類路徑照常往外丟。
   */
  async invoke(path: string, args: readonly unknown[] = [], options?: InvokeOptions): Promise<unknown> {
    if (this.closed) throw new PluginApiError('disposed', path, 'the plugin API was disposed')
    if (this.lanesEnabled && laneFor(path) === 'bulk') return this.invokeBulk(path, args, options)
    return this.invokeNow(path, args, options, null)
  }

  /**
   * bulk 路徑（頭像、media.prepare、ai.status…）：整個 `invoke`（含後續的 `job.poll`／`result.chunk`）佔用 bulk 通道的一個名額直到結束，
   * 所以下一個 bulk 呼叫不會插在分段取回之間，慢的輔助呼叫也永遠不會超過 bulk 上限；超過上限的在 bulk 佇列等（不佔 core 名額），
   * `signal` 在等名額時也有效（丟掉尚未送出的呼叫）。拿到名額後，每一次 host 呼叫仍計入同一個總預算。
   */
  private async invokeBulk(path: string, args: readonly unknown[], options?: InvokeOptions): Promise<unknown> {
    const call: PendingCall = { path, lane: 'bulk', queuedAt: Date.now(), startedAt: null }
    this.pending.add(call)
    try {
      return await this.limiter.run('bulk', () => {
        options?.onStart?.()
        return this.invokeNow(path, args, options, call)
      }, options?.signal ? { signal: options.signal } : undefined)
    } catch (error) {
      if (error instanceof CallCancelledError) throw new PluginApiError('cancelled', path, 'the call was cancelled before it started')
      throw error
    } finally {
      this.pending.delete(call)
    }
  }

  private async invokeNow(path: string, args: readonly unknown[], options: InvokeOptions | undefined, held: PendingCall | null): Promise<unknown> {
    for (let replay = 0; ; replay += 1) {
      try {
        return await this.unwrap(path, await this.envelope(path, args, path, options, held), held)
      } catch (error) {
        const expired = error instanceof PluginApiError && error.code === 'result_expired'
        if (!expired || replay >= RESULT_REPLAYS || this.closed || !isReplaySafePath(path)) throw error
        this.resultReplays += 1
      }
    }
  }

  /** 事件長輪詢（`events.*`）：與一般請求共用同一個併發預算（長輪詢佔 1 個名額，每次最久 waitMs）。 */
  invokeEvents(path: string, args: readonly unknown[] = []): Promise<unknown> {
    return this.invoke(path, args)
  }

  /** 這個路徑的 host 呼叫最久等多久（ms）；`null`＝不設上限（events 長輪詢）。 */
  private timeoutFor(path: string, lane: CallLane): number | null {
    if (path === 'ping') return this.timeouts.pingMs
    if (lane === 'events') return null
    if (lane === 'bulk') return this.timeouts.bulkMs
    return LONG_CALL_PATHS.has(path) ? this.timeouts.longMs : this.timeouts.coreMs
  }

  /** 對 host 發一次呼叫；超過 `limitMs` 就放棄等待（host 的呼叫取消不了，晚到的結果或錯誤丟掉）。 */
  private hostCall(path: string, method: string, wire: unknown, limitMs: number | null): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (action: () => void): void => {
        if (settled) return
        settled = true
        if (timer !== null) { clearTimeout(timer); this.timers.delete(timer) }
        action()
      }
      if (limitMs !== null) {
        timer = setTimeout(() => finish(() => reject(new PluginApiError(VIEW_CALL_TIMEOUT, path, `no answer within ${Math.round(limitMs / 100) / 10} s`))), limitMs)
        this.timers.add(timer)
      }
      let call: Promise<unknown>
      try { call = Promise.resolve(this.host.backend.call(method, wire)) } catch (error) { call = Promise.reject(error) }
      call.then((value) => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)))
    })
  }

  /** 一次 host 呼叫：佔用名額；host 說忙就釋放名額、退避、再試（超過次數才 reject）。 */
  private async envelope(path: string, args: readonly unknown[], owner: string = path, options?: InvokeOptions, held: PendingCall | null = null): Promise<unknown> {
    const method = backendMethodFor(path)
    if (method === null) throw new PluginApiError('path_unknown', path, 'the path is not in any backend method group')
    const wire = toWire(path, args)
    const lane = laneOf(path, owner)
    const scheduled: CallLane = this.lanesEnabled ? lane : 'core'
    const limitMs = this.timeoutFor(path, lane)
    const cancelled = (): PluginApiError => new PluginApiError('cancelled', path, 'the call was cancelled before it started')
    const call: PendingCall = held ?? { path, lane, queuedAt: Date.now(), startedAt: null }
    if (!held) this.pending.add(call)
    if (path === 'ping' && this.pingState === 'none') this.startPingWatch()
    try {
      for (let attempt = 0; ; attempt += 1) {
        if (!held && options?.signal?.aborted) throw cancelled()
        try {
          const send = (): Promise<unknown> => {
            call.startedAt = Date.now()
            this.maxActive = Math.max(this.maxActive, this.limiter.stats().active)
            return this.hostCall(path, method, wire, limitMs)
          }
          const env = held ? await send() : await this.limiter.run(scheduled, () => { options?.onStart?.(); return send() }, options?.signal ? { signal: options.signal } : undefined)
          this.setLink('ok', null, false)
          this.noteResponse(path, lane)
          return env
        } catch (error) {
          if (error instanceof CallCancelledError) throw cancelled()
          call.startedAt = null
          if (error instanceof PluginApiError && error.code === VIEW_CALL_TIMEOUT) {
            this.noteFailure(path, lane, VIEW_CALL_TIMEOUT, owner)
            throw error
          }
          const code = error instanceof Error && error.message ? error.message.slice(0, 80) : 'backend_call_failed'
          if (ACCESS_HOST_CODES.has(code)) this.setLink('revoked', code, false)
          if (!BUSY_HOST_CODES.has(code) || attempt >= this.retry.attempts || this.closed) {
            if (UNAVAILABLE_HOST_CODES.has(code)) this.setLink('unavailable', code, false)
            this.noteFailure(path, lane, code)
            throw new PluginBackendError(path, code)
          }
          this.busyRetries += 1
          const delay = Math.min(this.retry.baseMs * 2 ** attempt, this.retry.maxMs) * (0.75 + this.retry.random() * 0.5)
          await this.retry.sleep(delay)
          if (this.closed) throw new PluginApiError('disposed', path, 'the plugin API was disposed')
        }
      }
    } finally {
      if (!held) this.pending.delete(call)
    }
  }

  private failure(path: string, env: Record<string, unknown>): PluginApiError {
    const code = typeof env.code === 'string' ? env.code : 'api_error'
    const message = typeof env.message === 'string' ? env.message : undefined
    const route = typeof env.route === 'string' ? env.route : undefined
    return code === 'unsupported_in_plugin' ? new PluginUnsupportedError(path, message ?? '', route) : new PluginApiError(code, path, message, route)
  }

  private async unwrap(path: string, first: unknown, held: PendingCall | null = null): Promise<unknown> {
    let env = first
    for (;;) {
      if (!isRecord(env) || typeof env.ok !== 'boolean') throw new PluginApiError('bad_response', path, 'the backend answered with something that is not an envelope')
      if (env.ok === false) throw this.failure(path, env)
      if (env.pending === true && typeof env.jobId === 'string') {
        if (this.closed) throw new PluginApiError('disposed', path, 'the plugin API was disposed')
        env = await this.envelope('job.poll', [{ jobId: env.jobId, waitMs: this.jobWaitMs }], path, undefined, held)
        continue
      }
      if (env.chunked === true && typeof env.resultId === 'string' && typeof env.chunks === 'number') return this.readChunks(path, env.resultId, env.chunks, held)
      return env.value
    }
  }

  private async readChunks(path: string, resultId: string, count: number, held: PendingCall | null = null): Promise<unknown> {
    const parts: string[] = []
    for (let index = 0; index < count; index += 1) {
      if (this.closed) throw new PluginApiError('disposed', path, 'the plugin API was disposed')
      const env = await this.envelope('result.chunk', [{ resultId, index }], path, undefined, held)
      if (!isRecord(env) || env.ok !== true || !isRecord(env.value) || typeof env.value.data !== 'string') {
        throw isRecord(env) && env.ok === false ? this.failure(path, env) : new PluginApiError('bad_response', path, 'malformed result chunk')
      }
      parts.push(env.value.data)
    }
    try { return JSON.parse(parts.join('')) } catch { throw new PluginApiError('bad_response', path, 'the reassembled result is not valid JSON') }
  }
}
