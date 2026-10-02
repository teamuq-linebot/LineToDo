/**
 * taskStatus.ts — 長任務的「可查詢、重啟後還查得到」狀態（G-05；外掛開發者指南 §4：
 * 「呼叫 UI bridge 的等待結束不代表任務取消或完成；請提供查詢工作狀態的方法…重新啟動的 backend 應能根據持久資料恢復或查詢工作結果」）。
 *
 * - `LongTaskTracker`：一個長任務（目前是「補媒體金鑰」`pipeline.backfillMediaKeys`）的 single-flight 與狀態；
 *   開始與結束各寫一次 `<dataDir>/<name>-status.json`（先寫暫存檔再改名）。
 * - backend 重新啟動（閒置卸載、當機、被 Core 重啟）後讀回檔案：上次記錄是 `running`＝它沒有做完就被中斷，狀態改成 `interrupted`，
 *   UI 可以據此告訴使用者「上次沒做完，可以再按一次」，而不是只看到 `job_not_found`。
 * - 檔案只有狀態與數字（沒有訊息內容）；讀寫失敗不影響任務本身（頂多查不到上一次的結果）。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { JsonValue } from './types'

export type LongTaskState = 'idle' | 'running' | 'done' | 'failed' | 'interrupted'

export interface LongTaskStatus {
  name: string
  running: boolean
  state: LongTaskState
  startedAt: number | null
  finishedAt: number | null
  /** 給使用者看的一句話。 */
  summary: string
  /** 上一次的結果摘要（數字與 ok；沒有訊息內容）。 */
  result: JsonValue
}

const STATUS_VERSION = 1

interface Persisted {
  version: number
  /** 由各自的使用者解讀（LongTaskTracker：LongTaskState；ReviewCoordinator：ReviewStatus['state']）。 */
  state: string
  startedAt: number | null
  finishedAt: number | null
  summary: string
  result: JsonValue
}

/** 讀狀態檔；不存在、壞掉、版本不符都回 null。 */
export function readStatusFile(file: string | undefined): Persisted | null {
  if (!file || !existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Persisted>
    if (parsed.version !== STATUS_VERSION || typeof parsed.state !== 'string' || typeof parsed.summary !== 'string') return null
    return {
      version: STATUS_VERSION,
      state: parsed.state,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : null,
      finishedAt: typeof parsed.finishedAt === 'number' ? parsed.finishedAt : null,
      summary: parsed.summary,
      result: (parsed.result ?? null) as JsonValue
    }
  } catch {
    return null
  }
}

/** 先寫暫存檔再改名，不會留下半個檔案。失敗回 false（呼叫端不因此失敗）。 */
export function writeStatusFile(file: string | undefined, value: Omit<Persisted, 'version'>): boolean {
  if (!file) return false
  try {
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: STATUS_VERSION, ...value }))
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

export interface LongTaskTrackerOptions {
  name: string
  /** 狀態檔；省略＝只放記憶體（測試）。 */
  file?: string
  now?(): number
  /** 中斷時給使用者看的一句話。 */
  interruptedSummary?: string
}

export interface LongTaskOutcome {
  ok: boolean
  summary: string
  result?: JsonValue
}

export class LongTaskTracker {
  private readonly opts: LongTaskTrackerOptions
  private inflight: Promise<unknown> | null = null
  private state: LongTaskState = 'idle'
  private startedAt: number | null = null
  private finishedAt: number | null = null
  private summary = '尚未執行'
  private result: JsonValue = null

  constructor(opts: LongTaskTrackerOptions) {
    this.opts = opts
    const saved = readStatusFile(opts.file)
    if (saved) {
      this.startedAt = saved.startedAt
      this.finishedAt = saved.finishedAt
      this.result = saved.result
      if (saved.state === 'running') {
        // 上一個 backend 在執行中被結束（閒置卸載／當機／重啟）：沒有做完。
        this.state = 'interrupted'
        this.summary = opts.interruptedSummary ?? '上次執行時外掛後端重新啟動，工作沒有做完；可以再執行一次'
        this.persist()
      } else {
        const known: readonly string[] = ['idle', 'done', 'failed', 'interrupted']
        this.state = known.includes(saved.state) ? (saved.state as LongTaskState) : 'idle'
        this.summary = saved.summary
      }
    }
  }

  private now(): number { return this.opts.now ? this.opts.now() : Date.now() }

  private persist(): void {
    writeStatusFile(this.opts.file, { state: this.state, startedAt: this.startedAt, finishedAt: this.finishedAt, summary: this.summary, result: this.result })
  }

  /** 同時只跑一個；進行中再呼叫＝共用同一個結果。`describe` 把結果整理成狀態（失敗時用 throw 的訊息）。 */
  run<T>(exec: () => Promise<T>, describe: (value: T) => LongTaskOutcome, runningSummary: string): Promise<T> {
    if (this.inflight) return this.inflight as Promise<T>
    this.state = 'running'
    this.startedAt = this.now()
    this.finishedAt = null
    this.summary = runningSummary
    this.result = null
    this.persist()
    const flight = (async (): Promise<T> => {
      try {
        const value = await exec()
        const outcome = describe(value)
        this.state = outcome.ok ? 'done' : 'failed'
        this.summary = outcome.summary
        this.result = outcome.result ?? null
        return value
      } catch (error) {
        this.state = 'failed'
        this.summary = `執行失敗：${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`
        this.result = null
        throw error
      } finally {
        this.finishedAt = this.now()
        this.inflight = null
        this.persist()
      }
    })()
    this.inflight = flight
    return flight
  }

  status(): LongTaskStatus {
    return {
      name: this.opts.name,
      running: this.inflight !== null,
      state: this.state,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      summary: this.summary,
      result: this.result
    }
  }
}
