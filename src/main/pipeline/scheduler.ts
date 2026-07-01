import { EventEmitter } from 'node:events'
import { getPipelineDefaults } from '../config/defaults'
import { getQwenConfig } from '../config/qwen'
import { getLastRun } from '../db/pipeline.repo'
import { runOnce, makeQwenExtractFn } from './runOnce'
import type { RunOnceResult } from './runOnce'
import type { WatchSourceResult } from './watchSource'
import { dbDrainSource } from './watchSource'
import type { RawLineMessage } from '../line/types'

/**
 * scheduler.ts — 定時跑 pipeline runOnce（IMPLEMENTATION_PLAN.md §8 步驟 8）。
 *
 * - setInterval 依 pollIntervalSec 重排；可暫停/恢復（setRunning）、手動立即跑（triggerNow）。
 * - 不重入：上一輪未結束時不開新一輪（避免 qwen 並發爆掉 / DB 競爭）。
 * - 無金鑰 → LLM 階段優雅停用：仍跑一輪（落庫/黑名單/噪音過濾照常），但不抽 todo，
 *   llmStatus 標 'error'、UI 提示「請在設定頁填入 qwen 金鑰」。不崩潰、不硬寫。
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
  /** 取本輪新訊息的來源。預設 dbDrainSource（live watcher 已餵 DB）。 */
  watchSource?: () => Promise<WatchSourceResult>
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

  constructor(opts: SchedulerOptions = {}) {
    super()
    this.intervalSec = getPipelineDefaults().pollIntervalSec
    this.watchSource = opts.watchSource ?? dbDrainSource
  }

  getStatus(): PipelineStatus {
    const cfg = getQwenConfig()
    const hasApiKey = cfg.apiKey !== null
    let llmStatus: PipelineStatus['llmStatus'] = 'unknown'
    if (!hasApiKey) llmStatus = 'disabled'
    else if (this.lastResult) llmStatus = this.lastResult.llmStatus
    return {
      running: this.running,
      busy: this.busy,
      intervalSec: this.intervalSec,
      lastRunAt: this.lastRunAt ?? getLastRun()?.startedAt ?? null,
      lineBridge: this.lastResult?.lineBridge ?? 'unknown',
      llmStatus,
      hasApiKey,
      lastError: this.lastError
    }
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus())
  }

  /** 啟動定時輪詢（idempotent）。 */
  start(): void {
    if (this.running) return
    this.running = true
    this.intervalSec = getPipelineDefaults().pollIntervalSec
    this.scheduleNext()
    this.emitStatus()
  }

  /** 暫停定時輪詢（進行中的一輪會跑完）。 */
  stop(): void {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.emitStatus()
  }

  setRunning(running: boolean): PipelineStatus {
    if (running) this.start()
    else this.stop()
    return this.getStatus()
  }

  /**
   * 重新讀取 pollIntervalSec 並重排下一輪（設定頁改了輪詢頻率後呼叫，讓變更即時生效）。
   * 若目前未在運行則只更新數值、不開排程。
   */
  reschedule(): PipelineStatus {
    this.intervalSec = getPipelineDefaults().pollIntervalSec
    if (this.running) this.scheduleNext()
    this.emitStatus()
    return this.getStatus()
  }

  private scheduleNext(): void {
    if (!this.running) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.tick()
    }, this.intervalSec * 1000)
  }

  /** 手動立即跑一輪（不影響定時排程）。回傳該輪結果。 */
  async triggerNow(): Promise<RunOnceResult> {
    return this.runGuarded()
  }

  private async tick(): Promise<void> {
    await this.runGuarded()
    this.scheduleNext()
  }

  /** 跑一輪，含不重入保護。 */
  private async runGuarded(): Promise<RunOnceResult> {
    if (this.busy) {
      // 上一輪未結束：回上次結果，不重入。
      return (
        this.lastResult ?? {
          runId: '',
          lineBridge: 'skipped',
          llmStatus: 'ok',
          newMsgs: 0,
          chatsSeen: 0,
          chatsProcessed: 0,
          chatsSkippedNoise: 0,
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
    try {
      // 每輪即時組 extractFn（金鑰即用即丟）。無金鑰 → noopExtract（不產 todo）。
      const qwenExtract = makeQwenExtractFn()
      const extractFn =
        qwenExtract ??
        (async () => ({ importance: 'fyi' as const, newTodos: [], resolved: [], updates: [] }))

      const result = await runOnce({
        watchSource: this.watchSource,
        extractFn
      })

      // 無金鑰時把 llmStatus 在狀態層覆寫為 disabled（result 本身仍是 ok）。
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
