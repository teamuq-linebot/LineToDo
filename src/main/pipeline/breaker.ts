import { LlmProviderError } from '../llm/provider/types'
import type { LlmErrorCode } from '../llm/provider/types'

/**
 * breaker.ts — provider 級熔斷器 + per-chat 指數退避（design.md §5.5，Batch 7）。
 *
 * 為什麼需要：現行實作對失敗的 chat 是「不標 processed、下輪重試、無 backoff、無上限」。
 * HTTP provider 下這只是多打幾次 API；**CLI provider 下是質變**——每次失敗都是一次完整
 * 進程冷啟動（未登入的 codex 實測要燒 19.5 秒才失敗）。10 chat × 每 30 秒一輪
 * ＝ 每分鐘 20 次冷啟動且永不停止，會把使用者的桌機吃掉。
 *
 * 本檔**不 import electron、不碰 DB、不做 I/O**（時鐘可注入），所以能被 probe 腳本
 * 用假時鐘直接驅動驗證，不必真的等 15 分鐘。
 */

/** 熔斷冷卻時長（design.md §5.5 建議值）。 */
export const BREAKER_COOLDOWN_MS = 15 * 60 * 1000

/**
 * 「可重試錯誤造成的全滅」要連續幾輪才熔斷。
 *
 * 刻意不是 1：單輪全滅可能只是一次網路抖動 / 一次逾時，立刻鎖 15 分鐘太粗暴。
 * 不可重試錯誤（見 FATAL_CODES）不受此限制，第一輪就熔斷——那類錯誤重試必然再失敗。
 */
export const BREAKER_WIPEOUT_ROUNDS = 2

/** per-chat 退避上限（design.md §5.5 (b)）。 */
export const BACKOFF_MAX_MS = 30 * 60 * 1000

/**
 * 前幾次失敗不退避（下一輪照常重試）。
 *
 * 為什麼不是 0：退避若第一次失敗就生效，會**把熔斷器餓死**——全滅那一輪之後所有 chat
 * 都被退避跳過，下一輪 chatsProcessed + chatsFailed = 0，熔斷器（正確地）不計數，
 * 於是「連續 N 輪全滅」永遠湊不齊，使用者也就永遠看不到「為什麼停了」。
 * 給 1 次寬限：一次性抖動下一輪就自癒；真的壞掉時第二輪失敗才開始退避，
 * 同時剛好讓熔斷器收滿它要的第二輪證據。
 */
export const BACKOFF_GRACE_FAILURES = 1

/**
 * 「重試沒有意義、必須人類先去修設定/登入」的錯誤碼（design.md §5.5 (a) 明列）。
 *
 * ⚠️ 刻意**不**用 `LlmProviderError.retryable` 的反面：那個 getter 把 `timeout` 與
 * `unknown` 也算成不可重試，但這兩者在實務上常常只是一次性抖動（payload 特別大、
 * 機器剛好在忙），拿它們立刻鎖 15 分鐘會誤傷正常路徑。它們改走「連續全滅」那條路，
 * 需要 BREAKER_WIPEOUT_ROUNDS 輪才熔斷。
 */
const FATAL_CODES: ReadonlySet<LlmErrorCode> = new Set<LlmErrorCode>([
  'not_installed', // CLI 沒裝 —— 下一輪還是沒裝
  'not_authenticated', // 未登入 / 金鑰無效 —— 要人去終端機登入
  'invalid_config', // execPath 指到不存在的檔、baseUrl 亂填 —— 要人去設定頁改
  'quota_exceeded' // 訂閱用量上限 —— 短期內重試必然再失敗
])

/** 本輪錯誤中第一個「不可重試」的 provider 錯誤；沒有則 null。 */
export function findFatalError(errors: readonly unknown[]): LlmProviderError | null {
  for (const e of errors) {
    if (e instanceof LlmProviderError && FATAL_CODES.has(e.code)) return e
  }
  return null
}

/** 本輪錯誤的代表訊息（給 UI 看；取第一個有訊息的）。 */
function firstMessage(errors: readonly unknown[]): string | null {
  for (const e of errors) {
    if (e instanceof LlmProviderError) return e.userMessage
    if (e instanceof Error && e.message) return e.message
  }
  return null
}

export interface ProviderBreakerOptions {
  /** 冷卻時長（ms）。預設 BREAKER_COOLDOWN_MS。 */
  cooldownMs?: number
  /** 可重試錯誤要連續幾輪全滅才熔斷。預設 BREAKER_WIPEOUT_ROUNDS。 */
  wipeoutRoundsToOpen?: number
  /** 時鐘（測試注入假時鐘用）。預設 Date.now。 */
  now?: () => number
}

/** 一輪跑完後餵給熔斷器的摘要。 */
export interface BreakerRoundInput {
  chatsProcessed: number
  chatsFailed: number
  /** 該輪各 chat 拋出的原始錯誤（要保留物件本身，否則 code 分類會遺失）。 */
  errors: readonly unknown[]
}

export interface BreakerSnapshot {
  open: boolean
  /** 冷卻結束的 epoch ms；未熔斷為 null。 */
  until: number | null
  remainingMs: number
  /** 觸發原因（provider 的 userMessage）；未熔斷為 null。 */
  reason: string | null
  code: LlmErrorCode | null
  /** 目前累積的連續全滅輪數（未達門檻前的計數）。 */
  consecutiveWipeouts: number
}

/**
 * provider 級熔斷器。狀態機只有兩態：
 *
 *   closed ──(本輪出現不可重試錯誤)──────────────► open
 *   closed ──(連續 N 輪全滅，N=wipeoutRoundsToOpen)─► open
 *   open   ──(冷卻到期，isOpen() 惰性檢查)────────► closed
 *   open   ──(reset()：使用者按「立即執行」/ 設定變更)► closed
 *
 * closed 狀態下「本輪有任一 chat 成功」會把連續全滅計數歸零 → 正常路徑不會累積出莫名熔斷。
 */
export class ProviderBreaker {
  private until = 0
  private reason: string | null = null
  private code: LlmErrorCode | null = null
  private wipeouts = 0
  private readonly cooldownMs: number
  private readonly wipeoutRoundsToOpen: number
  private readonly now: () => number

  constructor(opts: ProviderBreakerOptions = {}) {
    this.cooldownMs = opts.cooldownMs ?? BREAKER_COOLDOWN_MS
    this.wipeoutRoundsToOpen = opts.wipeoutRoundsToOpen ?? BREAKER_WIPEOUT_ROUNDS
    this.now = opts.now ?? Date.now
  }

  /** 是否冷卻中（到期會就地自動解除，不需要外部計時器）。 */
  isOpen(): boolean {
    if (this.until === 0) return false
    if (this.now() >= this.until) {
      this.clearCooldown()
      return false
    }
    return true
  }

  /**
   * 一輪跑完後回報結果。回傳 true 表示「這一輪剛把熔斷打開」（呼叫端可據此 log 一次）。
   *
   * 不計入的情況（避免誤傷）：
   *   - 已在冷卻中（那一輪根本沒跑 LLM）
   *   - 該輪完全沒有 chat 進到 LLM 階段（沒新訊息 / 全是噪音 / 全被退避跳過）
   */
  recordRound(r: BreakerRoundInput): boolean {
    if (this.isOpen()) return false
    if (r.chatsProcessed + r.chatsFailed === 0) return false

    // 有任何一個 chat 成功 → provider 本身是活的，清掉連續全滅計數。
    if (r.chatsProcessed > 0) this.wipeouts = 0

    // (1) 不可重試錯誤：即使該輪有其他 chat 成功也要熔斷
    //     （quota_exceeded 常態就是「跑到一半被打斷」，design.md §5.5）。
    const fatal = findFatalError(r.errors)
    if (fatal) {
      this.open(fatal.userMessage, fatal.code)
      return true
    }

    // (2) 全滅：連續達門檻才熔斷。
    if (r.chatsFailed > 0 && r.chatsProcessed === 0) {
      this.wipeouts += 1
      if (this.wipeouts >= this.wipeoutRoundsToOpen) {
        this.open(
          firstMessage(r.errors) ?? 'AI 引擎連續無法完成抽取',
          this.codeOf(r.errors)
        )
        return true
      }
    }
    return false
  }

  /** 手動解除（使用者按「立即執行」、或設定被修改）。連續全滅計數一併歸零。 */
  reset(): void {
    this.clearCooldown()
    this.wipeouts = 0
  }

  snapshot(): BreakerSnapshot {
    const open = this.isOpen()
    return {
      open,
      until: open ? this.until : null,
      remainingMs: open ? Math.max(0, this.until - this.now()) : 0,
      reason: open ? this.reason : null,
      code: open ? this.code : null,
      consecutiveWipeouts: this.wipeouts
    }
  }

  /**
   * 給 UI 看的單行繁中訊息，同時回答「為什麼停了 / 還要多久 / 怎麼解除」。
   * 未熔斷回 null。**這是熔斷狀態進 UI 的唯一通道**（塞進既有的 PipelineStatus.lastError，
   * 不新增 IPC 欄位）。
   */
  statusMessage(): string | null {
    if (!this.isOpen()) return null
    const mins = Math.max(1, Math.ceil((this.until - this.now()) / 60000))
    const why = this.reason ?? 'AI 引擎連續失敗'
    return `AI 引擎已暫停：${why}（約 ${mins} 分鐘後自動重試；修好設定或按「立即執行」可立刻重試）`
  }

  private open(reason: string, code: LlmErrorCode | null): void {
    this.until = this.now() + this.cooldownMs
    this.reason = reason
    this.code = code
    this.wipeouts = 0
  }

  private clearCooldown(): void {
    this.until = 0
    this.reason = null
    this.code = null
  }

  private codeOf(errors: readonly unknown[]): LlmErrorCode | null {
    for (const e of errors) {
      if (e instanceof LlmProviderError) return e.code
    }
    return null
  }
}

export interface ChatBackoffOptions {
  /** 退避上限（ms）。預設 BACKOFF_MAX_MS。 */
  maxDelayMs?: number
  /** 前幾次失敗不退避。預設 BACKOFF_GRACE_FAILURES。 */
  graceFailures?: number
  now?: () => number
}

export interface ChatBackoffEntry {
  chatId: string
  fails: number
  remainingMs: number
}

/**
 * per-chat 指數退避（design.md §5.5 (b)）。
 *
 * 熔斷器覆蓋不到的缺口：「10 個 chat 裡只有 1 個一直失敗」。此時 llmStatus 是 partial 不是
 * error，熔斷器（正確地）不動作，但那個 chat 的訊息永遠不會被標 processed → 每一輪都
 * 再燒一次 spawn（CLI 下最壞是一整個 120 秒 timeout），而且是無限期的。
 *
 * 退避表**只在記憶體**（重啟即清空＝「重啟後給它一次機會」，正是期望行為），
 * delay = min(2^fails × 輪詢間隔, 30 分鐘)，成功即刪除該項。
 */
export class ChatBackoff {
  private readonly entries = new Map<string, { fails: number; nextAt: number }>()
  private readonly maxDelayMs: number
  private readonly graceFailures: number
  private readonly now: () => number

  constructor(opts: ChatBackoffOptions = {}) {
    this.maxDelayMs = opts.maxDelayMs ?? BACKOFF_MAX_MS
    this.graceFailures = opts.graceFailures ?? BACKOFF_GRACE_FAILURES
    this.now = opts.now ?? Date.now
  }

  /** 本輪是否該跳過這個 chat（既不算 processed 也不算 failed）。 */
  shouldSkip(chatId: string): boolean {
    const e = this.entries.get(chatId)
    if (!e) return false
    return this.now() < e.nextAt
  }

  /** baseDelayMs 一般傳輪詢間隔（ms）——退避以「幾輪」為單位才直觀。 */
  recordFailure(chatId: string, baseDelayMs: number): void {
    const prev = this.entries.get(chatId)
    const fails = (prev?.fails ?? 0) + 1
    const base = Math.max(1000, baseDelayMs)
    // 寬限次數內：記次數但不延後（下一輪照常重試，也讓熔斷器收得到第二輪證據）。
    // 之後 2^(fails-1) 輪：第 2 次失敗＝等 2 輪、第 3 次＝4 輪…上限 maxDelayMs。
    // 指數先用 Math.min 夾住，避免 fails 很大時 2**fails 溢位成 Infinity。
    const delay =
      fails <= this.graceFailures
        ? 0
        : Math.min(2 ** Math.min(fails - 1, 20) * base, this.maxDelayMs)
    this.entries.set(chatId, { fails, nextAt: this.now() + delay })
  }

  recordSuccess(chatId: string): void {
    this.entries.delete(chatId)
  }

  /** 全部清空（設定變更 / 使用者按「立即執行」）。 */
  reset(): void {
    this.entries.clear()
  }

  snapshot(): ChatBackoffEntry[] {
    const now = this.now()
    return [...this.entries.entries()].map(([chatId, e]) => ({
      chatId,
      fails: e.fails,
      remainingMs: Math.max(0, e.nextAt - now)
    }))
  }
}
