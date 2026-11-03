/**
 * invokeTrace.ts — backend 呼叫的行程外紀錄（診斷用，只觀測，不改變任何呼叫的行為）。
 *
 * 為什麼有它：TeamUQ 對一次 backend 呼叫只給 30 秒；超過就把整個外掛隔離（`timeoutPlugin`），而 Core 的 log 不記是哪個 method。
 * 事件迴圈被同步工作卡死時，backend 自己也來不及寫任何東西，所以「開始」一定要在進入 handler 之前就寫進檔案。
 *
 *   - 每筆紀錄是一行 JSON，用 `writeSync` 寫進**常駐開著的檔案描述子**（append 模式）：函式回傳時資料已交給作業系統（行程被卡死、被強殺都還在；
 *     只有整台機器當機才可能遺失）。不用每次 open／close：那是每個呼叫兩次的主要開銷（Windows 上還會被防毒掃描拖慢），而同步 `writeSync` 的落盤保證和 `appendFileSync` 相同。
 *   - 檔案有上限：超過 `maxBytes` 就把目前的檔案改名為 `<file>.1`（rename 本身會取代舊的，**rename 成功前不刪舊檔**）再從頭寫，總量最多約 2 × `maxBytes`。
 *     rename 失敗（`.1` 被占用、不是檔案、權限）就降級成截斷目前的檔案，舊的 `.1` 原樣保留；連截斷都失敗就繼續追加（有硬上限 `2 × maxBytes`，超過才丟棄）；期間每多寫 64 KiB 再試一次，到了硬上限則每一筆都再試，障礙排除後下一筆就恢復寫入。
 *     輪替時還在進行中的呼叫會補寫一行 `carry`，所以「已開始、未結束」的呼叫不會因輪替而從磁碟上消失。
 *   - 觀測事件（`event()`）：`snap`＝持久 snapshot 的一次取得（`m`＝reuse／wal／full，`ms`、`bytes`、`from`）；`bg`＝背景工作花了多久（`p`＝poll／reconcile／quick_check／unsent_scan／media_index／avatar_backfill）。
 *     `bg` 與 `snap` 的 `reuse` 只記 `eventMinMs`（預設 50 ms）以上的；`wal`／`full` 一律記。欄位全是既有白名單的 m／p／ms／bytes／from，用來把 `loop_stall` 歸因到背景工作。
 *   - 事件迴圈卡頓：一個 `unref` 的計時器每 `tickMs` 量一次遲到時間，遲到超過 `stallMs` 就寫 `loop_stall`（卡了多久、從何時開始、期間重疊的呼叫）。
 *     計時器本身在迴圈被卡住時跑不動，所以永久卡死不會有 `loop_stall`；那種情況看最後一筆沒有 `end` 的 `start`，以及它之後有沒有 `inflight` 心跳
 *     （有心跳＝迴圈還活著、呼叫在等非同步的東西；心跳在某個時間點之後消失＝迴圈在那之後被卡死）。
 *
 * 紀錄內容只有中性資料：method／path 名稱、序號、時間、耗時、結果碼、參數個數與大小。**絕不**放參數值、回傳值、錯誤訊息、聊天室或聯絡人名稱。
 * 所有欄位都經過白名單（見 `ALLOWED_FIELDS`）；寫入失敗一律吞掉（只通知 `onError`），不影響呼叫。
 */
import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

export const TRACE_DEFAULTS = Object.freeze({
  /** 單一檔案上限（位元組）。目前檔案＋`.1` 合計約 2 MiB（一筆平均約 130 位元組，約可留 1.6 萬筆、約 8,000 次呼叫；實測見 docs/invoke-trace.md）。 */
  maxBytes: 1024 * 1024,
  /**
   * 慢呼叫門檻：2 秒。一般本機呼叫（SQLite 查詢、記憶體狀態）在毫秒等級；2 秒已是平常的百倍以上，
   * 同時遠低於外掛自己的 20 秒軟期限與 TeamUQ 的 30 秒上限，所以在變成逾時隔離之前就會先留下「慢」的標記。
   * 長輪詢（`events.pull`、`job.poll`）本來就會等，不標慢。
   */
  slowMs: 2000,
  /** 事件迴圈卡頓門檻：1 秒（取樣間隔 0.5 秒的兩倍）。使用者看得到的卡頓從這裡開始；金鑰掃描的讓出時間片是 20 ms，遠低於它。 */
  stallMs: 1000,
  /** `bg` 事件（與 `snap` 的 reuse）低於這麼久不記：背景工作大多是毫秒級，只留會被看見的。 */
  eventMinMs: 50,
  tickMs: 500,
  /** 有慢呼叫（或背景 job）還在進行時，最多每這麼久寫一筆 `inflight` 心跳。 */
  heartbeatMs: 5000
})

/** 本來就會等的呼叫：不標慢、不觸發心跳。 */
const WAIT_BY_DESIGN: ReadonlySet<string> = new Set(['events.pull', 'job.poll'])
const MAX_LISTED_CALLS = 8
const MAX_CARRIED_CALLS = 16
const RECENT_SPANS = 32
/** 輪替失敗（rename 與截斷都不行）後，每多寫這麼多位元組才再試一次。 */
const ROTATE_RETRY_BYTES = 64 * 1024
/** 輪替連續失敗時檔案的硬上限＝`HARD_CAP_FACTOR × maxBytes`；超過就丟棄新紀錄（不讓失敗的輪替把磁碟寫滿）。 */
const HARD_CAP_FACTOR = 2

/** 寫進檔案的欄位白名單。測試用它證明紀錄沒有任何額外欄位。 */
export const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  't', 'ev', 'pid', 'ver', 'slowMs', 'stallMs', 'seq', 'm', 'p', 'argc', 'argB', 'fl', 'ms', 'res', 'slow', 'err', 'bytes',
  'from', 'lagMs', 'calls', 'age', 'job', 'wait', 'open', 'since'
])

/** `event()` 接受的事件名稱。 */
export type TraceEventName = 'snap' | 'bg'
/** `snap` 事件的 `m`：持久 snapshot 這次是 reuse（零複製）、wal（只複製 -wal）還是 full（整份複製）。 */
export const SNAP_KINDS: ReadonlySet<string> = new Set(['reuse', 'wal', 'full'])
/** `bg` 事件的 `p`：占用事件迴圈的背景工作種類。 */
export const BG_PHASES: ReadonlySet<string> = new Set(['poll', 'reconcile', 'quick_check', 'unsent_scan', 'media_index', 'avatar_backfill'])

export interface TraceInfo {
  /** method 組名（已驗證在 `BACKEND_METHOD_GROUPS` 內，否則 `?`）。 */
  method: string
  /** 路徑（已驗證屬於 dispatcher 認得的路徑集合，否則 `?`）。 */
  path: string
  /** 參數個數；無法判斷＝-1。 */
  argc: number
  /** 參數序列化後的位元組數；無法判斷＝-1。只記大小，不記內容。 */
  argBytes: number
}

export interface TraceCall {
  readonly seq: number
  /** 呼叫結束（回傳 envelope）。`res`＝已整理好的結果碼。 */
  end(res: string, extra?: { bytes?: number }): void
  /** 呼叫以例外結束（dispatcher 本來不該 throw）。只記錯誤的名稱。 */
  fail(error: unknown): void
  /** 這個呼叫轉成背景 job（`pending`）：`end` 之後仍算進行中，直到回傳的函式被呼叫。 */
  background(): (res: string) => void
}

export interface InvokeTraceOptions {
  /** 目前的 log 檔絕對路徑；輪替檔為 `<file>.1`。 */
  file: string
  pid?: number
  version?: string
  maxBytes?: number
  slowMs?: number
  stallMs?: number
  eventMinMs?: number
  tickMs?: number
  heartbeatMs?: number
  /** 牆上時鐘（毫秒，供時間戳記）；測試可注入。 */
  wallClock?(): number
  /** 單調時鐘（毫秒，供耗時）；測試可注入。 */
  monoClock?(): number
  /** false＝不啟動取樣計時器（測試手動呼叫 `sample()`）。 */
  timer?: boolean
  /** 寫入失敗時通知一次（同一種錯誤碼只通知一次）。 */
  onError?(code: string): void
}

interface Active { seq: number; m: string; p: string; startMono: number; startWall: number; job: boolean }
interface Span { seq: number; p: string; startMono: number; endMono: number }

const NOOP_CALL: TraceCall = Object.freeze({ seq: 0, end() {}, fail() {}, background: () => () => {} })

/** 結果碼只允許小寫英數與底線（例如 `api_error`、`plugin_host_timeout`）；其他一律 `other`。 */
export function safeCode(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : 'other'
}

export class InvokeTrace {
  private readonly o: Required<Pick<InvokeTraceOptions, 'file' | 'maxBytes' | 'slowMs' | 'stallMs' | 'eventMinMs' | 'tickMs' | 'heartbeatMs'>> & InvokeTraceOptions
  private readonly rotated: string
  private readonly active = new Map<number, Active>()
  private readonly spans: Span[] = []
  private readonly reported = new Set<string>()
  private readonly wall: () => number
  private readonly mono: () => number
  private timer: NodeJS.Timeout | null = null
  private seq = 0
  private size = 0
  /** 常駐的 append 模式檔案描述子；null＝尚未開啟（或剛因輪替／錯誤關掉，下次寫入時重開）。 */
  private fd: number | null = null
  /** 輪替失敗後，`size` 到這個值之前不再嘗試輪替。 */
  private retryRotateAt = 0
  private lastTick: number
  private lastHeartbeat: number
  private stopped = false
  /** 寫入失敗的筆數（診斷用）。 */
  dropped = 0

  constructor(options: InvokeTraceOptions) {
    this.o = {
      ...options,
      maxBytes: options.maxBytes ?? TRACE_DEFAULTS.maxBytes,
      slowMs: options.slowMs ?? TRACE_DEFAULTS.slowMs,
      stallMs: options.stallMs ?? TRACE_DEFAULTS.stallMs,
      eventMinMs: options.eventMinMs ?? TRACE_DEFAULTS.eventMinMs,
      tickMs: options.tickMs ?? TRACE_DEFAULTS.tickMs,
      heartbeatMs: options.heartbeatMs ?? TRACE_DEFAULTS.heartbeatMs
    }
    this.rotated = `${options.file}.1`
    this.wall = options.wallClock ?? Date.now
    this.mono = options.monoClock ?? (() => performance.now())
    this.lastTick = this.mono()
    this.lastHeartbeat = this.lastTick
    try { mkdirSync(dirname(options.file), { recursive: true }) } catch (error) { this.noteError(error) }
    try { this.size = statSync(options.file).size } catch { this.size = 0 }
    this.write({ ev: 'boot', pid: this.pid(), ...(options.version ? { ver: safeVersion(options.version) } : {}), slowMs: this.o.slowMs, stallMs: this.o.stallMs })
    if (options.timer !== false) {
      this.timer = setInterval(() => this.sample(), this.o.tickMs)
      this.timer.unref?.()
    }
  }

  get file(): string { return this.o.file }

  /** 在進入 handler 之前呼叫：同步把 `start` 寫進檔案。絕不 throw。 */
  begin(info: TraceInfo): TraceCall {
    if (this.stopped) return NOOP_CALL
    try {
      const seq = ++this.seq
      const startMono = this.mono()
      const entry: Active = { seq, m: info.method, p: info.path, startMono, startWall: this.wall(), job: false }
      const fl = this.active.size
      this.active.set(seq, entry)
      this.write({ ev: 'start', pid: this.pid(), seq, m: info.method, p: info.path, argc: info.argc, argB: info.argBytes, fl })
      return this.handle(entry)
    } catch (error) {
      this.noteError(error)
      return NOOP_CALL
    }
  }

  private handle(entry: Active): TraceCall {
    let finished = false
    const finish = (res: string, extra: { bytes?: number; err?: string } = {}): void => {
      if (finished) return
      finished = true
      try {
        const endMono = this.mono()
        const ms = Math.max(0, Math.round(endMono - entry.startMono))
        const slow = ms >= this.o.slowMs && !WAIT_BY_DESIGN.has(entry.p)
        this.write({
          ev: 'end', pid: this.pid(), seq: entry.seq, m: entry.m, p: entry.p, ms, res,
          ...(slow ? { slow: true } : {}),
          ...(extra.err ? { err: extra.err } : {}),
          ...(typeof extra.bytes === 'number' ? { bytes: extra.bytes } : {})
        })
        this.spans.push({ seq: entry.seq, p: entry.p, startMono: entry.startMono, endMono })
        if (this.spans.length > RECENT_SPANS) this.spans.shift()
        if (!entry.job) this.active.delete(entry.seq)
      } catch (error) { this.noteError(error) }
    }
    return {
      seq: entry.seq,
      end: (res, extra) => finish(safeCode(res) === res ? res : 'other', extra),
      fail: (error) => finish('threw', { err: safeName(error) }),
      background: () => {
        entry.job = true
        return (res) => {
          if (!entry.job) return
          entry.job = false
          this.active.delete(entry.seq)
          try {
            this.write({ ev: 'job_end', pid: this.pid(), seq: entry.seq, m: entry.m, p: entry.p, ms: Math.max(0, Math.round(this.mono() - entry.startMono)), res: safeCode(res) })
          } catch (error) { this.noteError(error) }
        }
      }
    }
  }

  /**
   * 記一筆觀測事件（絕不 throw）：`snap`（`m`：reuse／wal／full）或 `bg`（`p`：見 BG_PHASES）。`ms` 是這件事花的時間，`from` 由結束時間往回推，
   * 方便和 `loop_stall` 的 `from`／`lagMs` 對時間。名稱或種類不在白名單內、或 `bg`／`snap(reuse)` 低於 `eventMinMs` 一律不記。
   */
  event(ev: TraceEventName, fields: { m?: string; p?: string; ms: number; bytes?: number }): void {
    if (this.stopped) return
    try {
      const ms = Number.isFinite(fields.ms) ? Math.max(0, Math.round(fields.ms)) : 0
      const from = isoOf(this.wall() - ms)
      if (ev === 'snap') {
        if (typeof fields.m !== 'string' || !SNAP_KINDS.has(fields.m)) return
        if (fields.m === 'reuse' && ms < this.o.eventMinMs) return
        const bytes = typeof fields.bytes === 'number' && Number.isFinite(fields.bytes) && fields.bytes > 0 ? Math.round(fields.bytes) : null
        this.write({ ev, pid: this.pid(), m: fields.m, ms, ...(bytes !== null ? { bytes } : {}), from })
      } else if (ev === 'bg') {
        if (typeof fields.p !== 'string' || !BG_PHASES.has(fields.p) || ms < this.o.eventMinMs) return
        this.write({ ev, pid: this.pid(), p: fields.p, ms, from })
      }
    } catch (error) { this.noteError(error) }
  }

  /** 取樣一次：量事件迴圈遲到多久，必要時寫 `loop_stall`；有慢呼叫還在進行就（限速）寫 `inflight`。計時器每 `tickMs` 呼叫一次。 */
  sample(): void {
    if (this.stopped) return
    try {
      const now = this.mono()
      const lag = Math.round(now - this.lastTick - this.o.tickMs)
      const windowStart = this.lastTick + this.o.tickMs
      this.lastTick = now
      // 檔案被外部刪掉時（常駐的描述子會繼續寫進已脫離目錄的檔案），關掉描述子，下一筆寫入會重新建立檔案。
      if (this.fd !== null && !existsSync(this.o.file)) { this.closeFd(); this.size = 0 }
      if (lag >= this.o.stallMs) {
        const calls = this.overlapping(windowStart, now)
        this.write({ ev: 'loop_stall', pid: this.pid(), from: isoOf(this.wall() - lag), lagMs: lag, calls })
      }
      if (now - this.lastHeartbeat >= this.o.heartbeatMs && this.hasSlowOpen(now)) {
        this.lastHeartbeat = now
        this.write({ ev: 'inflight', pid: this.pid(), calls: this.listActive(now) })
      }
    } catch (error) { this.noteError(error) }
  }

  /** 正常結束（dispose）：寫一筆 `stop`、關掉描述子並停掉計時器。`stop` 之後不再寫任何紀錄（晚到的 `end`／`job_end` 略過），所以檔尾是 `stop`；沒有 `stop` 的 log 結尾＝行程不是正常結束的。 */
  stop(): void {
    if (this.stopped) return
    try { this.write({ ev: 'stop', pid: this.pid(), calls: this.listActive(this.mono()) }) } catch (error) { this.noteError(error) }
    this.stopped = true
    this.closeFd()
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  // ── 內部 ──

  private pid(): number { return this.o.pid ?? process.pid }

  private hasSlowOpen(now: number): boolean {
    for (const a of this.active.values()) if (!WAIT_BY_DESIGN.has(a.p) && now - a.startMono >= this.o.slowMs) return true
    return false
  }

  private listActive(now: number): Array<Record<string, unknown>> {
    return [...this.active.values()]
      .sort((a, b) => a.startMono - b.startMono)
      .slice(0, MAX_LISTED_CALLS)
      .map((a) => ({ seq: a.seq, p: a.p, age: Math.max(0, Math.round(now - a.startMono)), ...(a.job ? { job: true } : {}), ...(WAIT_BY_DESIGN.has(a.p) ? { wait: true } : {}) }))
  }

  /** 與 [from, to] 這段時間重疊的呼叫（仍在進行的、剛結束的）；取最久的前幾個。 */
  private overlapping(from: number, to: number): Array<Record<string, unknown>> {
    const found: Array<{ seq: number; p: string; start: number; end: number | null; job: boolean }> = []
    for (const a of this.active.values()) found.push({ seq: a.seq, p: a.p, start: a.startMono, end: null, job: a.job })
    for (const s of this.spans) if (s.startMono < to && s.endMono > from) found.push({ seq: s.seq, p: s.p, start: s.startMono, end: s.endMono, job: false })
    return found
      .filter((c) => c.start < to && (c.end === null || c.end > from))
      .sort((a, b) => (b.end ?? to) - b.start - ((a.end ?? to) - a.start))
      .slice(0, MAX_LISTED_CALLS)
      .map((c) => ({ seq: c.seq, p: c.p, age: Math.max(0, Math.round((c.end ?? to) - c.start)), open: c.end === null, ...(c.job ? { job: true } : {}), ...(WAIT_BY_DESIGN.has(c.p) ? { wait: true } : {}) }))
  }

  private write(fields: Record<string, unknown>): void {
    // `stop()` 之後不再追加任何紀錄：檔尾維持 `stop`，也不會為了晚到的 `end`／`job_end` 重新開檔（描述子無人會再關）。`stop()` 自己在設 `stopped` 之前寫。
    if (this.stopped) return
    const line = `${JSON.stringify({ t: isoOf(this.wall()), ...fields })}
`
    const bytes = Buffer.byteLength(line)
    try {
      if (this.size > 0 && this.size + bytes > this.o.maxBytes) {
        // 平常輪替失敗後每多寫 `ROTATE_RETRY_BYTES` 才再試；但到了硬上限，新紀錄一律被丟棄，`size` 不會再長，
        // 「再多寫多少」永遠不會到——所以硬上限時每一筆都再試（成本只有兩個會失敗的系統呼叫，且只在輪替與截斷都壞掉時才發生），障礙排除後下一筆就恢復。
        if (this.size + bytes > this.o.maxBytes * HARD_CAP_FACTOR || this.size >= this.retryRotateAt) this.rotate()
      }
      // 輪替一直失敗時檔案會超過 maxBytes 繼續長；到硬上限就丟棄新紀錄。
      if (this.size + bytes > this.o.maxBytes * HARD_CAP_FACTOR) { this.dropped += 1; return }
      this.append(line)
      this.size += bytes
    } catch (error) {
      this.dropped += 1
      this.noteError(error)
    }
  }

  /** 同步寫一行到常駐描述子（資料交給作業系統才回傳）。描述子壞了就重開一次再寫。 */
  private append(line: string): void {
    const data = Buffer.from(line)
    try {
      this.writeAll(data)
    } catch (error) {
      this.closeFd()
      this.noteError(error)
      this.writeAll(data)
    }
  }

  private writeAll(data: Buffer): void {
    if (this.fd === null) {
      try { mkdirSync(dirname(this.o.file), { recursive: true }) } catch { /* openSync 會回報真正的錯誤 */ }
      this.fd = openSync(this.o.file, 'a')
    }
    let done = 0
    while (done < data.length) done += writeSync(this.fd, data, done, data.length - done)
  }

  private closeFd(): void {
    const fd = this.fd
    this.fd = null
    if (fd !== null) { try { closeSync(fd) } catch { /* 已關閉或失效 */ } }
  }

  /**
   * 目前的檔案滿了：改名成 `.1`（取代舊的；rename 成功前不刪舊檔）。rename 失敗就降級成截斷目前的檔案（舊的 `.1` 原樣保留）；
   * 連截斷都失敗就留著不動、隔 `ROTATE_RETRY_BYTES` 再試。無論哪一種，寫入都會繼續，不會因為輪替失敗而整個失效。
   */
  private rotate(): void {
    this.closeFd() // Windows 上不要對自己開著的檔案 rename
    try {
      renameSync(this.o.file, this.rotated)
    } catch (error) {
      this.noteError(error)
      try { writeFileSync(this.o.file, '') } catch (truncateError) {
        this.noteError(truncateError)
        this.retryRotateAt = this.size + ROTATE_RETRY_BYTES
        return
      }
    }
    this.size = 0
    this.retryRotateAt = 0
    if (this.active.size === 0) return
    // 還在進行中的呼叫：把它們的「開始」補寫到新檔，輪替不會讓「已開始、未結束」從磁碟上消失。補寫失敗不影響這一筆紀錄本身。
    try {
      const now = this.mono()
      const carried = [...this.active.values()].sort((a, b) => a.startMono - b.startMono).slice(0, MAX_CARRIED_CALLS)
        .map((a) => ({ seq: a.seq, m: a.m, p: a.p, since: isoOf(a.startWall), age: Math.max(0, Math.round(now - a.startMono)), ...(a.job ? { job: true } : {}) }))
      const line = `${JSON.stringify({ t: isoOf(this.wall()), ev: 'carry', pid: this.pid(), calls: carried })}
`
      this.append(line)
      this.size += Buffer.byteLength(line)
    } catch (error) {
      this.dropped += 1
      this.noteError(error)
    }
  }

  private noteError(error: unknown): void {
    const code = safeCode((error as { code?: unknown } | null)?.code ?? 'write_failed')
    if (this.reported.has(code)) return
    this.reported.add(code)
    try { this.o.onError?.(code) } catch { /* 通知失敗不處理 */ }
  }
}

function isoOf(ms: number): string {
  const d = new Date(ms)
  return Number.isFinite(d.getTime()) ? d.toISOString() : ''
}

function safeName(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error
  return /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(name) ? name : 'Error'
}

function safeVersion(value: string): string {
  return /^[0-9A-Za-z.+-]{1,32}$/.test(value) ? value : '?'
}
