import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { dirname } from 'node:path'
import { watch as fsWatch, type FSWatcher } from 'node:fs'
import { watchFile as fsWatchFile, type StatWatcher } from 'node:fs'
import { EventEmitter } from 'node:events'
import type { RawLineMessage, LineBridgeStatus, LineBridgeState } from './types'
import { getLineEngine } from '../config/lineBridge'
import { getNewMessagesOnce } from './engine/watchEngine'

/**
 * LineWatcher — 在 main 進程觸發 line-cua-win 的 watch_json.py --once（NDJSON）。
 * 把每則訊息以事件吐出，負責子程序的錯誤偵測與自動重啟。
 *
 * 觸發機制（雙驅動，任一先到就啟動一次 poll）：
 *   1. 事件驅動：fs.watch 監看 LINE DB 目錄（dbDir）；偵測到 -wal 等寫入事件後
 *      去抖 ~800ms，立即 spawn 一次 --once（不必等 interval）。
 *   2. 間隔輪詢：setInterval(intervalSec) 作為 fallback 上限（「最久 N 秒一定檢查一次」）。
 *
 *   watch_json.py 的 stat-gate（edb/-wal size+mtime_ns 未變就 exit 0 輸出 0 行）
 *   讓「沒真的變動」的多餘觸發幾乎零成本，所以寧可多觸發也不漏。
 *
 * fs.watch 不穩定時（ENOENT / EACCES / Windows 限制）：自動退回 fs.watchFile stat 輪詢，
 * 再退回純 setInterval，任何錯誤均記 log 不崩潰。
 *
 * 事件：
 *   'message' (msg: RawLineMessage)   每收到一則新訊息
 *   'status'  (status: LineBridgeStatus) 橋接狀態變更（啟動/運行/錯誤/停止）
 *   'log'     (line: string)          子程序原始 stderr / 診斷行（除錯用）
 *
 * 設計重點：
 *   - watch_json.py stdout 為純 NDJSON；stderr 為狀態/錯誤（含 {"error":...}）。
 *   - 子程序 exit code 2 或 stderr 出現 {"error":...} → 標記 'error'。
 *   - 一次 poll 結束前不開新一輪（busy guard）。
 */

export interface LineWatcherOptions {
  /** venv python 絕對路徑 */
  python: string
  /** watch_json.py 絕對路徑 */
  script: string
  /** 間隔輪詢秒數（fallback 上限） */
  intervalSec: number
  /** 單輪安全上限（傳給 --limit） */
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
  private child: ChildProcessWithoutNullStreams | null = null
  private rl: Interface | null = null
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

  /** 停止所有計時器與 watcher，取消進行中的 poll（等待子程序自然結束）。 */
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
    this.teardownChild()
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
  // 核心：spawn --once，解析 NDJSON
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
      await this.spawnOnce(trigger)
    } finally {
      this.busy = false
    }
  }

  /**
   * 把一則 RawLineMessage 走「與 NDJSON parse 後相同的下游 emit 路徑」：
   * 型別守衛 → 切 running → 累加計數 → emit('message')。ts 引擎與舊 spawn 共用此路徑，
   * 只換「訊息從哪來」，不換「拿到訊息後怎麼處理」。
   */
  private emitMessage(msg: RawLineMessage): void {
    if (typeof msg.chatId !== 'string' || typeof msg.ts !== 'number') {
      this.emit('log', `[watcher] skip malformed message: ${JSON.stringify(msg).slice(0, 200)}`)
      return
    }
    if (this.status.state !== 'running') this.setState('running', null)
    this.status.messageCount += 1
    this.status.lastMessageAt = msg.time ?? new Date().toISOString()
    this.emit('message', msg)
  }

  /** Spawn watch_json.py --once，解析 NDJSON stdout，等子程序結束。 */
  private spawnOnce(trigger: string): Promise<void> {
    // Batch 4b：LINE_ENGINE=ts 走 in-process watchEngine.getNewMessagesOnce（自 checkpoint
    // 取增量，對應舊 spawn --once）；每則訊息走與 NDJSON parse 後相同的 emitMessage 下游路徑。
    // ts 路徑的錯誤以 throw 表達 → catch 後 setState('error')，與舊 spawn（exit 2 / stderr
    // error → 'error'）語意一致，不吞掉錯誤。未設 / 非 ts → 落到下方原 spawn 路徑不變。
    if (getLineEngine() === 'ts') {
      return this.pollOnceInProcess(trigger)
    }
    return new Promise((resolve) => {
      const { python, script, limit = 500 } = this.opts
      const args = [script, '--once', '--json', '--limit', String(limit)]

      if (this.status.state !== 'running' && this.status.state !== 'starting') {
        this.setState('starting', null)
      }
      this.emit('log', `[watcher] spawn(${trigger}): ${python} ${args.join(' ')}`)

      let child: ChildProcessWithoutNullStreams
      try {
        child = spawn(python, args, {
          cwd: dirname(script),
          env: {
            ...process.env,
            PYTHONUTF8: '1',
            PYTHONIOENCODING: 'utf-8'
          }
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.emit('log', `[watcher] spawn failed: ${msg}`)
        this.setState('error', msg)
        resolve()
        return
      }

      this.child = child
      let sawError = false

      // ── stdout：純 NDJSON，逐行解析 ──
      const rl = createInterface({ input: child.stdout })
      this.rl = rl
      rl.on('line', (line: string) => {
        const trimmed = line.trim()
        if (!trimmed) return
        let msg: RawLineMessage
        try {
          msg = JSON.parse(trimmed) as RawLineMessage
        } catch {
          this.emit('log', `[watcher] skip non-JSON stdout line: ${trimmed.slice(0, 200)}`)
          return
        }
        this.emitMessage(msg)
      })

      // ── stderr：狀態/錯誤行 ──
      const errRl = createInterface({ input: child.stderr })
      errRl.on('line', (line: string) => {
        const trimmed = line.trim()
        if (!trimmed) return
        this.emit('log', `[watch_json.py] ${trimmed}`)
        try {
          const obj = JSON.parse(trimmed) as { error?: string }
          if (obj && typeof obj.error === 'string') {
            sawError = true
            this.setState('error', obj.error)
          }
        } catch { /* 非 JSON stderr — 視為 log */ }
      })

      child.on('error', (err) => {
        this.emit('log', `[watcher] child error: ${err.message}`)
        this.setState('error', err.message)
        rl.close()
        errRl.close()
        this.child = null
        resolve()
      })

      child.on('exit', (code, signal) => {
        this.emit('log', `[watcher] child exit code=${code} signal=${signal} trigger=${trigger}`)
        rl.close()
        errRl.close()
        this.rl = null
        this.child = null

        if (code === 2 || sawError) {
          if (this.status.state !== 'error') {
            this.setState('error', this.status.lastError ?? 'watch_json.py exited with error')
          }
        } else if (code === 0) {
          // 正常完成：若還沒切到 running（e.g. 沒有新訊息），至少設 running 消除 starting 狀態
          if (this.status.state === 'starting') this.setState('running', null)
        } else {
          this.emit('log', `[watcher] non-zero exit ${code}`)
          this.setState('error', `watch_json.py exit ${code}`)
        }
        resolve()
      })
    })
  }

  /**
   * in-process 版 --once（LINE_ENGINE=ts）：呼叫 watchEngine.getNewMessagesOnce，
   * 逐則走 emitMessage 下游路徑；正常完成沿用舊 spawn code===0 的收尾（若還 starting
   * 就切 running）。任何 throw → setState('error')，對齊舊 spawn 的 code===2 分支。
   */
  private async pollOnceInProcess(trigger: string): Promise<void> {
    const { limit = 500 } = this.opts
    if (this.status.state !== 'running' && this.status.state !== 'starting') {
      this.setState('starting', null)
    }
    this.emit('log', `[watcher] engine=ts getNewMessagesOnce(${trigger}) limit=${limit}`)
    try {
      const msgs = await getNewMessagesOnce({ limit })
      for (const msg of msgs) this.emitMessage(msg)
      // 正常完成：若還沒切到 running（e.g. 沒有新訊息），至少設 running 消除 starting 狀態。
      if (this.status.state === 'starting') this.setState('running', null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.emit('log', `[watcher] engine=ts error: ${msg}`)
      this.setState('error', msg)
    }
  }

  private teardownChild(): void {
    if (this.rl) {
      this.rl.close()
      this.rl = null
    }
    if (this.child) {
      const c = this.child
      this.child = null
      c.removeAllListeners()
      try { c.kill() } catch { /* already dead */ }
    }
  }
}
