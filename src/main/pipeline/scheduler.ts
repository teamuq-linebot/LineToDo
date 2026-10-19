import { EventEmitter } from 'node:events'
import { runOnce } from './runOnce'
import type { RunOnceResult, ChatExtractInput, ExtractSink } from './runOnce'
import type { ExtractResult } from '../llm/schema'
import { ProviderBreaker, ChatBackoff } from './breaker'
import type { BreakerSnapshot, ChatBackoffEntry } from './breaker'
import type { WatchSourceResult } from './watchSource'
import { dbDrainSource } from './watchSource'
import type { RawLineMessage } from '../line/types'
import type { Database } from 'better-sqlite3'
import type { PipelineDefaults } from '../config/defaults'
import type { PipelineRunDTO } from '../db/pipeline.repo'

/**
 * scheduler.ts — 定時跑 pipeline runOnce（IMPLEMENTATION_PLAN.md §8 步驟 8）。
 *
 * - setInterval 依 pollIntervalSec 重排；可暫停/恢復（setRunning）、手動立即跑（triggerNow）。
 * - 不重入：上一輪未結束時不開新一輪（避免 qwen 並發爆掉 / DB 競爭）。
 * - AI 引擎未就緒（http 無金鑰）→ LLM 階段優雅停用：仍跑一輪（落庫/黑名單/噪音過濾照常），
 *   但不抽 todo，llmStatus 標 'disabled'、UI 提示去設定頁。不崩潰、不硬寫。
 *   「就緒」的判定是 provider-aware 的（isProviderConfigured）—— CLI provider 沒有 qwen 金鑰
 *   也算就緒，見 getStatus() 的註解與 design.md §4.3。
 *
 * - **provider 級熔斷（Batch 7 / design.md §5.5）**：一輪內出現不可重試錯誤（未登入、
 *   execPath 不存在、額度用盡…）或連續全滅 → 進入 15 分鐘冷卻，期間**完全不呼叫 provider**
 *   （CLI 下＝零進程 spawn）。冷卻中 llmStatus 報 'disabled'、lastError 帶「原因 + 還要多久 +
 *   怎麼解除」的繁中單行訊息（**不新增 IPC 欄位**）。解除：時間到 / 設定變更 / 按「立即執行」。
 * - **per-chat 指數退避**：熔斷器管不到「10 個裡只有 1 個一直失敗」，那個 chat 由 ChatBackoff
 *   以 2^fails x 輪詢間隔（上限 30 分鐘）節流。
 *
 * 事件：
 *   'run'    (RunOnceResult) 每輪結束
 *   'status' (PipelineStatus) 狀態變更
 */

export interface PipelineStatus {
  running: boolean
  busy: boolean
  intervalSec: number
  lastRunAt: string | null
  lineBridge: WatchSourceResult['bridge'] | 'unknown'
  llmStatus: 'ok' | 'partial' | 'error' | 'disabled' | 'unknown'
  hasApiKey: boolean
  lastError: string | null
}

export interface SchedulerOptions {
  db: Database
  getDefaults: () => PipelineDefaults
  getLastRun: () => PipelineRunDTO | null
  isProviderConfigured: () => boolean
  makeExtract: () => ((input: ChatExtractInput) => Promise<ExtractResult>) | null
  correctionsForChat?: (chatId:string) => ChatExtractInput['classificationCorrections']
  onCorrectionsPayloadBuilt?: (chatId:string,messageIds:string[],rules:NonNullable<ChatExtractInput['classificationCorrections']>) => void
  /** 取本輪新訊息的來源。預設 dbDrainSource（live watcher 已餵 DB）。 */
  watchSource?: () => Promise<WatchSourceResult>
  /** 注入自訂熔斷器（probe 用假時鐘 + 短冷卻，免得驗證要真的等 15 分鐘）。 */
  breaker?: ProviderBreaker
  /** 注入自訂 per-chat 退避表（同上）。 */
  backoff?: ChatBackoff
  /**
   * 供料/收料模式（外掛 backend）：給了，每一輪只做落庫/黑名單/噪音過濾並把待抽取輸入交給 sink，
   * 不組 provider、不呼叫 extractFn、不碰熔斷器。抽取結果之後由 sink 的 inbox 落庫，
   * 並以 recordExternalRun() 回報給 scheduler（沿用 'run' / 'status' 事件）。
   */
  extractSink?: ExtractSink
}

export class PipelineScheduler extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private busy = false
  private intervalSec: number
  private lastRunAt: string | null = null
  private lastResult: RunOnceResult | null = null
  private lastError: string | null = null
  private watchSource: () => Promise<WatchSourceResult>
  private makeExtract: SchedulerOptions['makeExtract']
  private readonly breaker: ProviderBreaker
  private readonly backoff: ChatBackoff
  private readonly options: SchedulerOptions
  private inFlight: Promise<RunOnceResult> | null = null

  constructor(opts: SchedulerOptions) {
    super()
    this.options = opts
    this.intervalSec = this.getDefaults().pollIntervalSec
    this.watchSource = opts.watchSource ?? dbDrainSource
    this.makeExtract = opts.makeExtract
    this.breaker = opts.breaker ?? new ProviderBreaker()
    this.backoff = opts.backoff ?? new ChatBackoff()
  }

  private getDefaults(): PipelineDefaults {
    return this.options.getDefaults()
  }

  private providerIsConfigured(): boolean {
    return this.options.isProviderConfigured()
  }

  /** 熔斷器現況（觀測 / probe 用；不進 IPC）。 */
  breakerSnapshot(): BreakerSnapshot {
    return this.breaker.snapshot()
  }

  /** per-chat 退避現況（觀測 / probe 用；不進 IPC）。 */
  backoffSnapshot(): ChatBackoffEntry[] {
    return this.backoff.snapshot()
  }

  getStatus(): PipelineStatus {
    // ⚠️ design.md §4.3：這裡原本是 `getQwenConfig().apiKey !== null`，在 CLI provider 下
    // 會永遠誤報「缺金鑰 → disabled」（用 claude/codex 訂閱時本來就沒有 qwen 金鑰）。
    // 改為 provider-aware 的「AI 引擎已就緒」判定：
    //   http → 有金鑰；CLI → 就緒（除非使用者指定的 execPath 不存在）。
    // **IPC 契約形狀不變**：欄位仍叫 hasApiKey、仍是 boolean，UI 不必同步改動；
    // 只有語意從「有 qwen 金鑰」放寬為「AI 引擎已就緒」（欄位改名屬 UI 變動，另走核可）。
    const hasApiKey = this.providerIsConfigured()
    // 熔斷冷卻中：沿用「無金鑰」那條既有路徑的表達方式 —— llmStatus='disabled'
    // ＋ lastError 帶原因/剩餘時間/解除方式。**刻意不新增 PipelineStatus 欄位**，
    // 因為 Batch 5 已確立這個形狀，多一個欄位就多一項 UI 相依（design.md §5.5：
    // 「llmStatus 回報 'disabled'、lastError = aiCooldownReason → UI 直接看到原因」）。
    // statusMessage() 每次呼叫重算剩餘分鐘，所以不快取、也不需要額外計時器。
    const cooldownMessage = this.breaker.statusMessage()
    let llmStatus: PipelineStatus['llmStatus'] = 'unknown'
    if (!hasApiKey) llmStatus = 'disabled'
    else if (cooldownMessage) llmStatus = 'disabled'
    else if (this.lastResult) llmStatus = this.lastResult.llmStatus
    return {
      running: this.running,
      busy: this.busy,
      intervalSec: this.intervalSec,
      lastRunAt: this.lastRunAt ?? this.options.getLastRun()?.startedAt ?? null,
      lineBridge: this.lastResult?.lineBridge ?? 'unknown',
      llmStatus,
      hasApiKey,
      lastError: cooldownMessage ?? this.lastError
    }
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus())
  }

  /**
   * 外部（外掛 ExtractQueue 的 commit）完成了一批抽取：記成最近一輪並送出 'run'／'status'，
   * 讓 application 照常推 pipeline-run / todos-changed。不影響定時排程與 busy 狀態。
   */
  recordExternalRun(result: RunOnceResult): void {
    this.lastResult = result
    this.lastRunAt = new Date().toISOString()
    this.lastError = result.note
    this.emit('run', result)
    this.emitStatus()
  }

  /** 啟動定時輪詢（idempotent）。 */
  start(): void {
    if (this.running) return
    this.running = true
    this.intervalSec = this.getDefaults().pollIntervalSec
    this.scheduleNext()
    this.emitStatus()
  }

  /** 暫停定時輪詢（進行中的一輪會跑完）。 */
  async stop(): Promise<void> {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.emitStatus()
    if (this.inFlight) await this.inFlight.catch(() => undefined)
  }

  setRunning(running: boolean): PipelineStatus {
    if (running) this.start()
    else void this.stop()
    return this.getStatus()
  }

  /**
   * 重新讀取 pollIntervalSec 並重排下一輪（設定頁改了輪詢頻率後呼叫，讓變更即時生效）。
   * 若目前未在運行則只更新數值、不開排程。
   */
  reschedule(): PipelineStatus {
    this.intervalSec = this.getDefaults().pollIntervalSec
    if (this.running) this.scheduleNext()
    this.emitStatus()
    return this.getStatus()
  }

  /**
   * 設定被修改（切換 provider、改 execPath、填金鑰…）後呼叫。
   * 除了重排輪詢頻率，還會**解除熔斷與 per-chat 退避**：熔斷記的是「用舊設定會失敗」，
   * 設定既然換了，拿新設定重試一次才是合理行為（design.md §5.5 解除條件之一）。
   */
  notifySettingsChanged(): PipelineStatus {
    this.breaker.reset()
    this.backoff.reset()
    return this.reschedule()
  }

  private scheduleNext(): void {
    if (!this.running) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.tick()
    }, this.intervalSec * 1000)
  }

  /**
   * 手動立即跑一輪（不影響定時排程）。回傳該輪結果。
   *
   * `userInitiated`（預設 true）＝ 使用者按了「立即執行」：那是明確的人為意圖，
   * 先解除熔斷與退避再跑（design.md §5.5 解除條件之一）。
   * 只有內部/測試需要「觀察熔斷當下的行為」時才傳 false。
   */
  async triggerNow(opts: { userInitiated?: boolean } = {}): Promise<RunOnceResult> {
    if (opts.userInitiated !== false) {
      this.breaker.reset()
      this.backoff.reset()
      this.emitStatus()
    }
    return this.runGuarded()
  }

  private async tick(): Promise<void> {
    await this.runGuarded()
    if (this.running) this.scheduleNext()
  }

  /** 跑一輪，含不重入保護。 */
  private runGuarded(): Promise<RunOnceResult> {
    if (this.inFlight) return this.inFlight
    if (this.busy) {
      // 上一輪未結束：回上次結果，不重入。
      return Promise.resolve(
        this.lastResult ?? {
          runId: '',
          lineBridge: 'skipped',
          llmStatus: 'ok',
          newMsgs: 0,
          chatsSeen: 0,
          chatsProcessed: 0,
          chatsSkippedNoise: 0,
          chatsSkipped: 0,
          chatsFailed: 0,
          todosCreated: 0,
          todosMerged: 0,
          todosResolvedDone: 0,
          todosSuggestedDone: 0,
          createdIds: [],
          resolvedIds: [],
          updatedIds: [],
          note: 'busy: 上一輪未結束，略過'
        }
      )
    }
    this.busy = true
    this.emitStatus()
    let tracked: Promise<RunOnceResult>
    tracked = Promise.resolve().then(() => this.runCycle()).finally(() => {
      if (this.inFlight === tracked) this.inFlight = null
    })
    this.inFlight = tracked
    return tracked
  }

  private async runCycle(): Promise<RunOnceResult> {
    try {
      // 熔斷冷卻中 → 這一輪的每個 chat 都被 shouldSkipChat 擋下（連 provider 都不建構）。
      // 落庫 / 黑名單 / 噪音判定照常，只是完全不進 LLM 階段。
      const sink = this.options.extractSink
      const cooling = sink ? false : this.breaker.isOpen()

      // 每輪即時組 extractFn（金鑰即用即丟、每輪依設定重新解析 provider）。
      // provider 不可用（http 無金鑰）→ noopExtract（不產 todo）。
      const providerExtract = cooling || sink ? null : this.makeExtract()
      const noopExtract = async (): Promise<ExtractResult> => ({
        importance: 'fyi',
        newTodos: [],
        resolved: [],
        updates: []
      })
      // 冷卻中刻意給「會拋錯」而非 noop：若 shouldSkipChat 哪天有 bug 漏掉某個 chat，
      // 結果會是該 chat 失敗（看得見），而不是靜默把訊息標成已處理（代辦永久遺失）。
      const extractFn = sink
        ? async (): Promise<ExtractResult> => {
            throw new Error('extractSink 模式不應呼叫 extractFn')
          }
        : cooling
        ? async (): Promise<ExtractResult> => {
            throw new Error('AI 引擎冷卻中，本輪不應呼叫 extract')
          }
        : (providerExtract ?? noopExtract)

      const roundErrors: unknown[] = []
      const result = await runOnce({
        db: this.options.db,
        config: this.getDefaults(),
        watchSource: this.watchSource,
        extractFn,
        extractSink: sink,
        correctionsForChat: this.options.correctionsForChat,
        onCorrectionsPayloadBuilt: this.options.onCorrectionsPayloadBuilt,
        shouldSkipChat: (chatId) => cooling || this.backoff.shouldSkip(chatId),
        onChatFailed: (chatId, err) => {
          roundErrors.push(err)
          this.backoff.recordFailure(chatId, this.intervalSec * 1000)
        },
        onChatSucceeded: (chatId) => this.backoff.recordSuccess(chatId)
      })

      // 熔斷判定（冷卻中的那一輪不計，否則永遠續命）。
      if (!cooling && !sink) {
        const opened = this.breaker.recordRound({
          chatsProcessed: result.chatsProcessed,
          chatsFailed: result.chatsFailed,
          errors: roundErrors
        })
        if (opened) {
          const snap = this.breaker.snapshot()
          console.warn(
            '[breaker] AI provider 熔斷 ' +
              Math.round(snap.remainingMs / 60000) +
              ' 分鐘（code=' +
              (snap.code ?? 'n/a') +
              '）：' +
              (snap.reason ?? '')
          )
        }
      }

      // 引擎未就緒時把 llmStatus 在狀態層覆寫為 disabled（result 本身仍是 ok）。
      this.lastResult = result
      this.lastRunAt = new Date().toISOString()
      this.lastError = result.note
      this.emit('run', result)
      this.emitStatus()
      return result
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.emitStatus()
      throw err
    } finally {
      this.busy = false
      this.emitStatus()
    }
  }
}

/** 便利：把 RawLineMessage[] 包成固定 watchSource（測試/手動補抓用）。 */
export function fixedWatchSource(
  messages: RawLineMessage[],
  bridge: WatchSourceResult['bridge'] = 'ok'
): () => Promise<WatchSourceResult> {
  return async () => ({ messages, bridge })
}
