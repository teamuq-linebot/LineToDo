/**
 * reviewRun.ts — 外掛版「回顧最近 N 天」（`pipeline.reviewLastDays`）的續跑與進度（Phase 4 repair）。
 *
 * 為什麼需要：外掛的 AI 在 UI 端（ai:chat，≤ 18 輪/分、看板要在前景）。回顧幾百個聊天室要跑幾十分鐘，
 * 中間看板被隱藏／關掉、Codex 掉線都可能發生。standalone 的 `reviewLastDays` 是「一次做完、失敗的聊天室下次整批重來」，
 * 照搬到外掛會變成：停了一次就整批失敗，再按一次又從頭把已經完成的聊天室重送一遍（再燒一次配額）。
 *
 * 做法（不動 core 的行為）：
 *   - 包住 core 呼叫的 extractFn（`wrapExtract`）：每個「日片段」成功拿到 AI 結果後，把片段的 msgId 記進帳本（ledger）；
 *     下一次回顧遇到「整片都已完成」的片段，直接回一個空結果（不送 AI、不花輪數），core 照常把該 chat 的訊息標 processed。
 *     已落庫的 todo 本來就在 DB 裡（回顧用 DB 的 openTodos 去重），所以空結果不會重複建立任何東西。
 *   - 佇列回報「UI 不見了」（`extract_ui_offline`／`extract_await_timeout`）＝暫停：之後的片段立刻失敗（不再各自等 15 分鐘），
 *     core 很快收尾，結果標明「已完成 N/M，再按一次接續」。帳本保留 → 下一次回顧從沒做完的地方繼續。
 *   - 全部做完（沒有失敗）→ 帳本清掉；下一次回顧是一次全新的完整回顧（與 standalone 語意一致）。
 *   - 同時只跑一個回顧（single-flight）；重複呼叫共用同一個結果。
 *   - `status()`：進行中／已完成 N/M／可續跑的訊息數，給 UI（`review.status`、`backend.info`）。
 *
 * 帳本存 `<dataDir>/review-ledger.json`（只含 msgId，沒有訊息內容），24 小時過期。
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { MessageDTO } from '../../main/db/dto'
import type { ExtractResult } from '../../main/llm/schema'
import type { ChatExtractInput } from '../../main/pipeline/runOnce'
import type { ReviewLastDaysResult } from '../../main/pipeline/backfill'

const LEDGER_VERSION = 1
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const MAX_LEDGER_IDS = 400_000
const FLUSH_EVERY_MS = 5_000

const EMPTY_RESULT: ExtractResult = Object.freeze({ importance: 'noise', newTodos: [], resolved: [], updates: [] }) as unknown as ExtractResult

/** 這些錯誤代表「UI 不見了」：整個回顧該暫停，而不是這個聊天室壞了。 */
const PAUSE_ERRORS = new Set(['extract_ui_offline', 'extract_await_timeout'])

export interface ReviewLedgerOptions {
  /** 帳本檔；省略＝只放記憶體（測試）。 */
  file?: string
  now?(): number
  ttlMs?: number
}

/** 已完成回顧的訊息 id 集合（跨回顧、跨重開保留）。 */
export class ReviewLedger {
  private readonly ids = new Set<string>()
  private readonly opts: ReviewLedgerOptions
  private updatedAt = 0
  private dirty = false
  private lastFlush = 0
  private loaded = false

  constructor(opts: ReviewLedgerOptions = {}) {
    this.opts = opts
  }

  private now(): number { return this.opts.now ? this.opts.now() : Date.now() }

  /** 回顧開始時呼叫：第一次從檔案載入，過期的丟掉。 */
  load(): void {
    if (!this.loaded) {
      this.loaded = true
      const file = this.opts.file
      if (file && existsSync(file)) {
        try {
          const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: number; updatedAt?: number; done?: unknown }
          if (parsed.version === LEDGER_VERSION && typeof parsed.updatedAt === 'number' && Array.isArray(parsed.done)) {
            this.updatedAt = parsed.updatedAt
            for (const id of parsed.done) if (typeof id === 'string' && this.ids.size < MAX_LEDGER_IDS) this.ids.add(id)
          }
        } catch { /* 壞掉的帳本＝沒有帳本（頂多多送一次） */ }
      }
    }
    if (this.ids.size > 0 && this.now() - this.updatedAt > (this.opts.ttlMs ?? DEFAULT_TTL_MS)) this.clear()
  }

  get size(): number { return this.ids.size }
  has(id: string): boolean { return this.ids.has(id) }

  add(ids: readonly string[]): void {
    for (const id of ids) if (this.ids.size < MAX_LEDGER_IDS) this.ids.add(id)
    this.updatedAt = this.now()
    this.dirty = true
    if (this.now() - this.lastFlush >= FLUSH_EVERY_MS) this.flush()
  }

  clear(): void {
    this.ids.clear()
    this.dirty = false
    const file = this.opts.file
    if (file) { try { rmSync(file, { force: true }) } catch { /* 已不存在 */ } }
  }

  /** 寫檔（先寫暫存檔再改名，不會留下半個檔案）。失敗不影響回顧（頂多下次多送一點）。 */
  flush(): void {
    this.lastFlush = this.now()
    const file = this.opts.file
    if (!file || !this.dirty) return
    try {
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: LEDGER_VERSION, updatedAt: this.updatedAt, done: [...this.ids] }))
      renameSync(tmp, file)
      this.dirty = false
    } catch { /* 下次再試 */ }
  }
}

export interface ReviewStatus {
  /** 現在有沒有回顧在跑。 */
  running: boolean
  /** `idle`＝從沒跑過；`running`；`done`＝上一次全部完成；`paused`＝UI 不見而暫停；`incomplete`＝有聊天室失敗、可再按一次接續。 */
  state: 'idle' | 'running' | 'done' | 'paused' | 'incomplete'
  days: number | null
  startedAt: number | null
  updatedAt: number | null
  finishedAt: number | null
  phase: 'fetching' | 'extracting' | 'done' | null
  /** 進行中：core 回報的「已處理 / 聊天總數」；結束後：已完成（含噪音）/ 看到的聊天數。 */
  chatsDone: number
  chatsTotal: number
  /** 本次回顧：實際送去 AI 的日片段、因帳本而略過的日片段、失敗的日片段。 */
  slicesSent: number
  slicesSkipped: number
  slicesFailed: number
  /** 帳本裡記得的已完成訊息數（>0 且上次沒做完＝再按一次會接續）。 */
  resumableMessages: number
  pausedReason: string | null
  /** 給使用者看的一句話。 */
  summary: string
}

export interface ReviewCoordinatorOptions {
  ledger: ReviewLedger
  now?(): number
}

export class ReviewCoordinator {
  private readonly ledger: ReviewLedger
  private readonly nowFn: () => number
  private inflight: Promise<ReviewLastDaysResult> | null = null
  private state: ReviewStatus['state'] = 'idle'
  private days: number | null = null
  private startedAt: number | null = null
  private updatedAt: number | null = null
  private finishedAt: number | null = null
  private phase: ReviewStatus['phase'] = null
  private chatsDone = 0
  private chatsTotal = 0
  private slicesSent = 0
  private slicesSkipped = 0
  private slicesFailed = 0
  private pausedReason: string | null = null
  private disposed = false

  constructor(opts: ReviewCoordinatorOptions) {
    this.ledger = opts.ledger
    this.nowFn = opts.now ?? (() => Date.now())
  }

  private now(): number { return this.nowFn() }

  /** core 的 `backfill-progress` 事件（processed／total／phase）。 */
  noteProgress(progress: unknown): void {
    if (!this.inflight || typeof progress !== 'object' || progress === null) return
    const p = progress as { processed?: unknown; total?: unknown; phase?: unknown }
    if (typeof p.processed === 'number') this.chatsDone = p.processed
    if (typeof p.total === 'number') this.chatsTotal = p.total
    if (p.phase === 'fetching' || p.phase === 'extracting' || p.phase === 'done') this.phase = p.phase
    this.updatedAt = this.now()
  }

  /** 包住 core 用的 extractFn：帳本略過、記錄、偵測 UI 不見。 */
  wrapExtract(inner: (input: ChatExtractInput) => Promise<ExtractResult>): (input: ChatExtractInput) => Promise<ExtractResult> {
    return async (input) => {
      if (this.pausedReason) throw new Error(this.pausedReason)
      const ids = input.newMessages.map((m: MessageDTO) => m.msgId)
      if (ids.length > 0 && ids.every((id) => this.ledger.has(id))) {
        this.slicesSkipped += 1
        this.updatedAt = this.now()
        return EMPTY_RESULT
      }
      try {
        const result = await inner(input)
        this.ledger.add(ids)
        this.slicesSent += 1
        this.updatedAt = this.now()
        return result
      } catch (error) {
        this.slicesFailed += 1
        this.updatedAt = this.now()
        const message = error instanceof Error ? error.message : String(error)
        if (PAUSE_ERRORS.has(message) && !this.pausedReason) this.pausedReason = message
        throw error
      }
    }
  }

  /** 同時只跑一個回顧；進行中再呼叫＝共用同一個結果。 */
  run(days: unknown, exec: () => Promise<ReviewLastDaysResult>): Promise<ReviewLastDaysResult> {
    if (this.inflight) return this.inflight
    const window = typeof days === 'number' && Number.isFinite(days) && days > 0 ? Math.floor(days) : 7
    this.ledger.load()
    this.state = 'running'
    this.days = window
    this.startedAt = this.updatedAt = this.now()
    this.finishedAt = null
    this.phase = 'fetching'
    this.chatsDone = this.chatsTotal = 0
    this.slicesSent = this.slicesSkipped = this.slicesFailed = 0
    this.pausedReason = null
    const flight = (async (): Promise<ReviewLastDaysResult> => {
      try {
        const result = await exec()
        return this.finish(result)
      } catch (error) {
        this.state = this.pausedReason ? 'paused' : 'incomplete'
        throw error
      } finally {
        this.ledger.flush()
        this.finishedAt = this.updatedAt = this.now()
        this.phase = 'done'
        this.inflight = null
      }
    })()
    this.inflight = flight
    return flight
  }

  private finish(result: ReviewLastDaysResult): ReviewLastDaysResult {
    const done = result.chatsProcessed + result.chatsSkippedNoise
    this.chatsDone = done
    this.chatsTotal = result.chatsSeen
    const paused = this.pausedReason !== null
    const incomplete = paused || result.chatsFailed > 0
    if (!result.ok) {
      this.state = 'incomplete'
      return result
    }
    if (!incomplete) {
      this.state = 'done'
      this.ledger.clear()
      return result
    }
    this.state = paused ? 'paused' : 'incomplete'
    const resume = '已完成的部分已保留，再按一次「回顧」會接續，不會重送已完成的訊息。'
    if (paused) {
      // 暫停＝沒有做完：ok:false 讓 UI 顯示 note（成功分支只顯示「完成：新增…」，看不出沒做完）。
      return {
        ...result,
        ok: false,
        note: `回顧暫停：已完成 ${done}/${result.chatsSeen} 個聊天（新增 ${result.todosCreated}、合併 ${result.todosMerged}）。AI 整理需要看板在前景且 Codex 可用；${resume}`
      }
    }
    return { ...result, note: `尚有 ${result.chatsFailed} 個聊天未完成（已完成 ${done}/${result.chatsSeen}）。${resume}` }
  }

  status(): ReviewStatus {
    const resumable = this.ledger.size
    let summary: string
    switch (this.state) {
      case 'running':
        summary = this.phase === 'fetching' || this.chatsTotal === 0 ? '回顧進行中：撈取訊息…' : `回顧進行中：已處理 ${this.chatsDone}/${this.chatsTotal} 個聊天`
        break
      case 'done': summary = `回顧已完成：${this.chatsDone}/${this.chatsTotal} 個聊天`; break
      case 'paused': summary = `回顧暫停：已完成 ${this.chatsDone}/${this.chatsTotal} 個聊天，看板回到前景後再按一次「回顧」即可接續`; break
      case 'incomplete': summary = `回顧未全部完成：已完成 ${this.chatsDone}/${this.chatsTotal} 個聊天，再按一次「回顧」即可接續`; break
      default: summary = resumable > 0 ? `上次回顧尚未做完（已記住 ${resumable} 則訊息），再按一次「回顧」即可接續` : '尚未回顧'
    }
    return {
      running: this.inflight !== null, state: this.state, days: this.days, startedAt: this.startedAt, updatedAt: this.updatedAt, finishedAt: this.finishedAt,
      phase: this.phase, chatsDone: this.chatsDone, chatsTotal: this.chatsTotal, slicesSent: this.slicesSent, slicesSkipped: this.slicesSkipped,
      slicesFailed: this.slicesFailed, resumableMessages: resumable, pausedReason: this.pausedReason, summary
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.ledger.flush()
  }
}
