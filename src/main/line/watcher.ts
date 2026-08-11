import { watch as fsWatch, type FSWatcher } from 'node:fs'
import { watchFile as fsWatchFile, type StatWatcher } from 'node:fs'
import { EventEmitter } from 'node:events'
import type { RawLineMessage, LineBridgeStatus, LineBridgeState } from './types'
import { getNewMessagesOnce } from './engine/watchEngine'

/**
 * LineWatcher — 在 main 進程以 in-process TS 引擎（engine/watchEngine）取增量新訊息。
 * 把每則訊息以事件吐出，負責錯誤偵測與狀態回報。
 *
 * 觸發機制（雙驅動，任一先到就啟動一次 poll）：
 *   1. 事件驅動：fs.watch 監看 LINE DB 目錄（dbDir）；偵測到 -wal 等寫入事件後
 *      去抖 ~800ms，立即跑一次 getNewMessagesOnce（不必等 interval）。
 *   2. 間隔輪詢：setInterval(intervalSec) 作為 fallback 上限（「最久 N 秒一定檢查一次」）。
 *
 *   引擎內建 stat-gate（edb/-wal size+mtime_ns 未變就直接回 0 則）讓「沒真的變動」的
 *   多餘觸發幾乎零成本，所以寧可多觸發也不漏。
 *
 * fs.watch 不穩定時（ENOENT / EACCES / Windows 限制）：自動退回 fs.watchFile stat 輪詢，
 * 再退回純 setInterval，任何錯誤均記 log 不崩潰。
 *
 * 事件：
 *   'message' (msg: RawLineMessage)   每收到一則新訊息
 *   'status'  (status: LineBridgeStatus) 橋接狀態變更（啟動/運行/錯誤/停止）
 *   'log'     (line: string)          診斷行（除錯用）
 *
 * 設計重點：
 *   - 引擎丟出的例外 → 標記 'error'（狀態語意與舊 spawn 路徑一致）。
 *   - 一次 poll 結束前不開新一輪（busy guard）。
 */

export interface LineWatcherOptions {
  /** 間隔輪詢秒數（fallback 上限） */
  intervalSec: number
  /** 單輪安全上限 */
  limit?: number
  /** 是否啟用 fs.watch 事件驅動即時觸發（預設 true） */
  dbWatchEnabled?: boolean
  /** LINE DB 目錄（含 qwd*.edb 和 -wal 的目錄） */
  dbDir?: string
}

const DB_WATCH_DEBOUNCE_MS = 800
// watchFile fallback 輪詢 stat 間隔（不需要很短，只是確保 fs.watch 退場後還能追到）
const STAT_WATCHER_INTERVAL_MS = 2000

export class LineWatcher extends EventEmitter {
  private opts: LineWatcherOptions
  private stopped = false
  private busy = false

  // 事件驅動觸發
  private intervalTimer: NodeJS.Timeout | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  private fsWatcher: FSWatcher | null = null
  private statWatcher: StatWatcher | null = null

  private status: LineBridgeStatus = {
    state: 'stopped',
    lastMessageAt: null,
    messageCount: 0,
    lastError: null,
    restarts: 0
  }

  constructor(opts: LineWatcherOptions) {
    super()
    this.opts = opts
  }

  getStatus(): LineBridgeStatus {
    return { ...this.status }
  }

  private setState(state: LineBridgeState, error?: string | null): void {
    this.status.state = state
    if (error !== undefined) this.status.lastError = error
    this.emit('status', this.getStatus())
  }

  /** 啟動（idempotent）。 */
  start(): void {
    if (!this.stopped && this.intervalTimer) return // 已在跑
    this.stopped = false

    this.setState('starting', null)
    this.emit('log', `[watcher] start — interval=${this.opts.intervalSec}s dbWatch=${this.opts.dbWatchEnabled ?? true}`)

    // 立即跑一次，不等第一個間隔
    void this.poll('startup')

    // 間隔 fallback：每 intervalSec 秒一定跑一次
    this.intervalTimer = setInterval(() => {
      void this.poll('interval')
    }, this.opts.intervalSec * 1000)

    // 事件驅動：fs.watch LINE DB 目錄
    if (this.opts.dbWatchEnabled !== false) {
      this.setupDbWatch()
    }
  }

  /** 停止所有計時器與 watcher（進行中的 in-process poll 會自然跑完後不再排下一輪）。 */
  stop(): void {
    this.stopped = true

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer)
      this.intervalTimer = null
    }
    this.teardownDbWatch()
    this.setState('stopped')
  }

  // ─────────────────────────────────────────────
  // fs.watch 事件驅動
  // ─────────────────────────────────────────────

  private setupDbWatch(): void {
    const dbDir = this.opts.dbDir
    if (!dbDir) return

    try {
      const watcher = fsWatch(dbDir, { persistent: false, recursive: false }, (event, filename) => {
        // 優先關注 -wal（資料寫入訊號）；也接受其它檔案改變（edb 本體 rename/write）
        const name = filename ?? ''
        const relevant = name.includes('-wal') || name.includes('.edb') || name === ''
        if (!relevant) return
        this.emit('log', `[watcher] fs.watch hit: event=${event} file=${name} → debounce ${DB_WATCH_DEBOUNCE_MS}ms`)
        this.scheduleDebounce()
      })

      watcher.on('error', (err) => {
        this.emit('log', `[watcher] fs.watch error: ${err.message} — fallback to watchFile`)
        this.teardownFsWatcher()
        this.setupStatWatcherFallback(dbDir)
      })

      this.fsWatcher = watcher
      this.emit('log', `[watcher] fs.watch started on ${dbDir}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.emit('log', `[watcher] fs.watch setup failed (${msg}) — fallback to watchFile`)
      this.setupStatWatcherFallback(dbDir)
    }
  }

  /** fs.watchFile fallback：stat 輪詢偵測 -wal mtime 變化。 */
  private setupStatWatcherFallback(dbDir: string): void {
    if (this.statWatcher) return // 已有
    const walPath = `${dbDir.replace(/[\\/]+$/, '')}\\Line.sqlite-wal`
    try {
      const sw = fsWatchFile(walPath, { persistent: false, interval: STAT_WATCHER_INTERVAL_MS }, (curr, prev) => {
        if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) {
          this.emit('log', `[watcher] watchFile stat changed (${walPath}) → debounce`)
          this.scheduleDebounce()
        }
      })
      this.statWatcher = sw
      this.emit('log', `[watcher] watchFile fallback started on ${walPath}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.emit('log', `[watcher] watchFile fallback also failed (${msg}) — pure interval only`)
    }
  }

  private scheduleDebounce(): void {
    if (this.stopped) return
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.poll('db-watch')
    }, DB_WATCH_DEBOUNCE_MS)
  }

  private teardownFsWatcher(): void {
    if (this.fsWatcher) {
      try { this.fsWatcher.close() } catch { /* ignore */ }
      this.fsWatcher = null
    }
  }

  private teardownDbWatch(): void {
    this.teardownFsWatcher()
    if (this.statWatcher) {
      // fsWatchFile 回傳值是 StatWatcher，用 unwatchFile 解綁
      // statWatcher 物件本身沒有 close，只需停止即可
      try {
        (this.statWatcher as { stop?: () => void }).stop?.()
      } catch { /* ignore */ }
      this.statWatcher = null
    }
  }

  // ─────────────────────────────────────────────
  // 核心：in-process 引擎取一次增量
  // ─────────────────────────────────────────────

  /** 觸發一次 poll。若上一輪仍在跑（busy）則略過（不重入）。 */
  private async poll(trigger: string): Promise<void> {
    if (this.stopped) return
    if (this.busy) {
      this.emit('log', `[watcher] poll(${trigger}) skipped — busy`)
      return
    }
    this.busy = true
    try {
      await this.pollOnceInProcess(trigger)
    } finally {
      this.busy = false
    }
  }

  /**
   * 把一則 RawLineMessage 走統一的下游 emit 路徑：
   * 型別守衛 → 切 running → 累加計數 → emit('message')。
   */
  private emitMessage(msg: RawLineMessage): void {
    if (this.stopped) return
    if (typeof msg.chatId !== 'string' || typeof msg.ts !== 'number') {
      this.emit('log', `[watcher] skip malformed message: ${JSON.stringify(msg).slice(0, 200)}`)
      return
    }
    if (this.status.state !== 'running') this.setState('running', null)
    this.status.messageCount += 1
    this.status.lastMessageAt = msg.time ?? new Date().toISOString()
    this.emit('message', msg)
  }

  /**
   * 取一次增量：呼叫 watchEngine.getNewMessagesOnce（自 checkpoint 取增量），
   * 逐則走 emitMessage 下游路徑；正常完成時若還 starting 就切 running。
   * 任何 throw → setState('error')。
   */
  private async pollOnceInProcess(trigger: string): Promise<void> {
    const { limit = 500 } = this.opts
    if (this.status.state !== 'running' && this.status.state !== 'starting') {
      this.setState('starting', null)
    }
    this.emit('log', `[watcher] engine=ts getNewMessagesOnce(${trigger}) limit=${limit}`)
    try {
      const msgs = await getNewMessagesOnce({ limit })
      if (this.stopped) return // stop() 在 await 期間發生：本輪結果整批丟棄，不 emit、不改狀態
      for (const msg of msgs) this.emitMessage(msg)
      // 正常完成：若還沒切到 running（e.g. 沒有新訊息），至少設 running 消除 starting 狀態。
      if (this.status.state === 'starting') this.setState('running', null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.emit('log', `[watcher] engine=ts error: ${msg}`)
      if (this.stopped) return // 已停止：不得用 'error' 蓋掉 stop() 設下的 'stopped'
      this.setState('error', msg)
    }
  }
}
