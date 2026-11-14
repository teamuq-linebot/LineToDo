/**
 * linejsReceive.ts — X2b 接收端接線（implementation-plan-v2.md §2 X2b，使用者決定 Q3 = 以電腦版訊息為準）。
 *
 * 接收開啟時，app DB 每次落庫（`messages-persisted`）之後，以 ingested 游標查詢新落庫的 ct ∈ {1,2,14} 列，交給 X6 的
 * `OriginalDownloadService.enqueue(msgIds, { origin: 'receive' })`——實際呼叫 `enqueueDetailed`（enqueue 本身就是委派給它，同一條接納路徑，
 * 多回每一格的狀態）。LINEJS 的 'message' 事件不再下載任何東西（linejsMedia.ts）。
 *
 * 游標（`<dataDir>/linejs-downloads/receive-cursor.json`，原子寫入：暫存檔 fsync → rename）：
 *   - `afterRowid`：已經看過的 app DB `messages` rowid（messages 沒有刪除路徑、rowid 只增不減，同一個 transaction 寫入的列也各有
 *     自己的 rowid，所以比 `ingested_at`（同一批共用一個時間字串）更適合當游標）。
 *   - `outstanding`：已經掃到、還沒有結果的 msgId（交給 X6 排隊中，或被守門擋下、稍後再交）。游標前進與加入 outstanding 寫在同一次存檔裡，
 *     所以一列不是「在游標之後」就是「在 outstanding 裡」或「已經有結果」——重啟不漏。重啟後 outstanding 會再交一次：X6 以 sink.existing
 *     與 single-flight 短路（已落地 → done、0 次請求），所以不會重複下載；已經有結果的列在游標之前，不會再交——重啟不重複。
 *   - `sinceTs`（review-x2b F-1）：開啟接收那一刻減 RECEIVE_LIMITS.sinceBufferMs（5 分鐘）。掃描只看 `ts >= sinceTs` 的列，所以 rowid
 *     在游標之後、但訊息時間早於開啟接收的列（首次匯入續跑、補匯入的歷史）一律不交——rowid 只代表「什麼時候落庫」，不代表「新訊息」。
 *     電腦版離線後補同步的新訊息（ts 晚於 sinceTs、落庫較晚）照樣會收。5 分鐘的緩衝：訊息時間是 LINE 伺服器的 createdTime，本機時鐘
 *     可能差幾十秒到幾分鐘，開啟接收前一刻送達、稍後才落庫的訊息也算「開啟之後」；歷史（首次匯入）通常是幾天到幾年前，不受影響。
 *   - `dbId`（F-1）：app DB 的識別（`app_settings` 的 `line-todo.linejs-receive.db-id.v1`，第一次讀時寫入一個隨機 UUID）。與游標檔記的
 *     不同（app DB 被刪除重建、換成另一個檔案）→ 視同重新開始：sinceTs 改為現在、游標設為 MAX(rowid)、outstanding 清空，記 code=DB_CHANGED。
 *     讀不到識別（沒有 app_settings 表、寫入失敗）時不比對，只靠 sinceTs 與 CURSOR_RESET。
 *   - 第一次開啟接收（含關閉後再開、游標檔不存在、壞掉或沒有 sinceTs）時，sinceTs 與游標都取「開關切換那一刻」的值（F-5：在開關的
 *     listener 裡同步讀，不等游標檔載入完；app DB 那時還沒就緒 → 游標從 0 開始掃、由 sinceTs 濾掉歷史，開啟之後落庫的列不會漏）。
 *   - app DB 的 MAX(rowid) 比游標小（資料庫被換掉、識別相同）→ 游標退回 MAX(rowid)，記 code=CURSOR_RESET；sinceTs 保留（同樣不回溯）。
 *
 * 守門（沿用 X6）：沒有安裝的 LINEJS session 時完全不呼叫 enqueue（不會因此觸發 token 登入）；帳號不一致、session 未就緒由 X6 的接納判斷
 * 擋下，這裡把那些列留在 outstanding、RECEIVE_LIMITS.deferMs 後再交，不前進、不丟。X6 回 idle 時（F-2）：
 *   - APP_DB_UNAVAILABLE、LEDGER_UNAVAILABLE、SERVICE_STOPPED（服務還沒準備好、或 status 這一次讀不到 app DB／ledger）不是結果：不論
 *     X6 接納了沒有，都改回未接納、deferMs 後再交（review-fix-final NF-4；X6 還有那個工作時再交只會合併進去，已落地的回 done）。
 *   - 登出：沒有 session 時這裡完全不查 status（見下方守門）。X6 在登出時丟掉所有工作並記住它們；同一個帳號再登入後 status 回
 *     idle／SESSION_ENDED（ORIGINALS_SESSION_ENDED）→ 改回未接納、立刻再交（NF-1；X6 把已落地的直接判為 done，不會重複下載）。
 *     換成別的帳號登入時 X6 回一般的 idle → 結案，不改用新帳號重交（ADJ-X2BF-01）。
 *   - 其他 idle 一律結案、不再重交：接納之後回 idle 是使用者在 X7 取消（使用者取消的工作不會被接收自動排回去）或換了帳號；接納當下的
 *     idle（ABORTED 等）也是。
 *   - unsupported／LOCATOR_INCOMPLETE（F-4：落庫時欄位還沒補齊，watcher 之後以 UPDATE 補上，rowid 不變）：最多 locatorRetries（3）次、
 *     每 locatorRetryMs（60 s）再交一次；X6 的接納只讀本地（app DB、電腦版那一列），不送請求。3 次仍不完整就結案。重試次數只在記憶體
 *     （重啟後重新計數，上限仍是每次執行 3 次）。
 *
 * 節制（RECEIVE_LIMITS；電腦版一次同步上千則時也不會一次全部排入）：
 *   - `window` 10：outstanding 最多 10 則，滿了就不再往後掃。X6 的單格／接收車道一次跑一個、請求至少間隔 1 s，10 則約是 10 s 以上的工作量，
 *     poll 5 s 補一次就不會讓車道空轉；同時 ledger 裡最多只多出 10 筆 queued，使用者按的單格永遠排在接收前面（X6 pick：user > receive）。
 *   - `perHour` 100：每小時最多交出 100 **則**需要連網的列（接納後是 queued／running／paused 才算；本機 LINE Cache 命中、已落地的不算）。
 *     這只限制排進 X6 的列數；**請求數**的上限在 X6（review-x2b F-3）：X6 每小時 200 次（單格、批次、接收共用，review-x1 I-6：同一個
 *     RequestBudget，429 也是同一個全域暫停）裡，接收自動排的工作最多 100 次（ORIGINALS_RECEIVE_REQUESTS_PER_HOUR）——一則失敗的列可以
 *     用到 15 次請求，所以只限列數不夠。接收用完 100 次時只有接收的工作暫停，單格與批次至少還有 100 次。上千則的積壓以每小時 100 則
 *     慢慢消化，積壓的列留在游標之後（不漏）。
 *   - `minTickMs` 1 s：兩次掃描至少間隔（本機 Cache 命中的照片一次 10 張，連續命中時約每秒 10 張，不會佔滿事件迴圈）。
 *   - `pollMs` 5 s：有 outstanding 或還有積壓時多久再看一次（status 只讀本地，不呼叫 LINE）。`deferMs` 30 s：被守門擋下的列多久再交。
 *
 * 自己傳出的列（direction out，ct 1／14）掃到時交給 X6 的 noteOutboundRow（只比對本機記憶體，不送請求）：同一聊天室、時間相近、大小相同的
 * X3 回寫若 stem 不同，X6 記一筆 code=OUTBOUND_ID_MISMATCH（P0 R1 不成立時的偵測）。
 *
 * 接收關閉：不掃、不交；X6 裡接收自動排的工作（不含使用者按過的、批次認領的）全部取消（cancelReceive），outstanding 清空。
 *
 * log 只有事件與計數／代碼，沒有 msgId、聊天室、路徑。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { OriginalItemView, OriginalState } from '../../shared/linejsOriginals'
import { writeFileDurable } from './linejsAutoDownload.mjs'
import { ORIGINALS_SESSION_ENDED } from './linejsOriginals'

export const RECEIVE_CURSOR_NAME = 'receive-cursor.json'
const CURSOR_TEMP_RE = /^receive-cursor\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$/

export const RECEIVE_LIMITS = Object.freeze({
  /** 已掃到、還沒有結果的列最多幾則（滿了就不再往後掃）。 */
  window: 10,
  /** 每小時最多交出幾則需要連網的列（X6 共用上限 200 次的一半）。 */
  perHour: 100,
  hourMs: 60 * 60_000,
  /** 兩次掃描的最短間隔。 */
  minTickMs: 1_000,
  /** 有 outstanding 或積壓時多久再看一次。 */
  pollMs: 5_000,
  /** 被守門擋下（未登入、帳號不一致、app DB 未就緒）的列多久再交。 */
  deferMs: 30_000,
  /** sinceTs = 開啟接收那一刻減這麼多（LINE 伺服器時間與本機時鐘的誤差、開啟前一刻送達稍後才落庫的訊息；見檔頭）。 */
  sinceBufferMs: 5 * 60_000,
  /** LOCATOR_INCOMPLETE 最多再交幾次（F-4）。 */
  locatorRetries: 3,
  /** LOCATOR_INCOMPLETE 多久再交一次（watcher 下一輪同步補上欄位的時間）。 */
  locatorRetryMs: 60_000,
})
export type ReceiveLimits = typeof RECEIVE_LIMITS

/** app_settings 裡 app DB 識別的鍵（F-1）。 */
export const RECEIVE_DB_ID_KEY = 'line-todo.linejs-receive.db-id.v1'

/** app DB（better-sqlite3 的子集）。掃描只讀；`run` 只用來第一次寫入 app_settings 的 DB 識別。 */
export interface ReceiveDb { prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[]; run?(...params: unknown[]): unknown } }

/** X6 的子集。 */
export interface ReceiveOriginalsPort {
  enqueueDetailed(msgIds: string[], options: { origin: 'receive' }): Promise<{ items: OriginalItemView[] }>
  status(msgIds: string[]): Promise<{ items: OriginalItemView[] }>
  cancelReceive(): number
  /** 自己傳出的列（OUTBOUND_ID_MISMATCH 偵測；只比對記憶體）。 */
  noteOutboundRow?(row: { msgId: string; chatId: string; size: number | null; ts: number }): void
}

export interface LineJsReceiveOptions {
  dataDir: string
  getDb(): ReceiveDb | null
  originals: ReceiveOriginalsPort
  /** 目前安裝的 LINEJS session（不連網）；null → 不交任何列。 */
  session: { currentSessionId(): string | null }
  /** 接收開關（LineJsMediaService）。 */
  receiveSwitch: { receiveEnabled(): boolean; onReceiveEnabledChange(listener: (enabled: boolean) => void): () => void }
  limits?: Partial<ReceiveLimits>
  now?: () => number
  log?: (line: string) => void
}

const MAX_SQL = 'SELECT MAX(rowid) AS m FROM messages'
/** F-1：只看開啟接收之後的訊息時間（ts >= sinceTs）；rowid 範圍仍是游標。 */
const SCAN_SQL = 'SELECT rowid AS rid, msg_id, chat_id, ts, direction, content_type, file_size, unsent FROM messages WHERE rowid > ? AND rowid <= ? AND ts >= ? AND content_type IN (1, 2, 14) ORDER BY rowid LIMIT ?'
const DB_ID_SELECT_SQL = 'SELECT value FROM app_settings WHERE key = ?'
const DB_ID_INSERT_SQL = 'INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)'
const MSG_ID = /^i:\d{1,32}$/
const DB_ID = /^[0-9a-f-]{36}$/
/** X6 接納後「交給它了」的狀態。 */
const ACCEPTED: ReadonlySet<OriginalState> = new Set(['queued', 'running', 'paused'])
/** X6 的守門擋下、之後可能會過的狀態：留在 outstanding 稍後再交。其餘（done、終態、failed…）都是「這一列有結果了」。 */
const DEFERRED: ReadonlySet<OriginalState> = new Set(['idle', 'needs_login', 'account_mismatch'])
/**
 * F-2／NF-4：idle 帶這幾個碼（服務還沒準備好、status 讀不到 app DB／ledger）不是結果——不論接納了沒有都延後重交；其他 idle 結案
 * （SESSION_ENDED 另外處理，見 applyView）。
 */
const IDLE_RETRY_CODES: ReadonlySet<string> = new Set(['APP_DB_UNAVAILABLE', 'LEDGER_UNAVAILABLE', 'SERVICE_STOPPED'])

interface Outstanding { id: string; accepted: boolean; nextAt: number; locatorTries: number }
interface CursorDoc { version: 1; enabled: boolean; afterRowid: number | null; sinceTs: number | null; dbId: string | null; outstanding: string[]; handed: number[] }
/** 開關切換那一刻的起點（F-5：在 listener 裡同步取）。max 為 null：app DB 還沒就緒。 */
interface StartPoint { sinceTs: number; max: number | null }

/** 非負安全整數（rowid、ms 時間戳、大小）；其他 → null。 */
const toRowid = (v: unknown): number | null => {
  const n = typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

export class LineJsReceiveService {
  private readonly opts: LineJsReceiveOptions
  private readonly limits: ReceiveLimits
  private readonly now: () => number
  private readonly dir: string
  private readonly file: string
  private enabled = false
  /** null：開啟了但開關切換那一刻 app DB 還沒就緒——第一次能讀時從 0 開始掃（由 sinceTs 濾掉歷史，F-5）。 */
  private afterRowid: number | null = null
  /** 只交 ts >= sinceTs 的列（F-1）；開啟接收時一定有值。 */
  private sinceTs: number | null = null
  /** 游標屬於哪一個 app DB（F-1）；null：還沒讀到（或讀不到）識別。 */
  private dbId: string | null = null
  private readonly outstanding = new Map<string, Outstanding>()
  /** 交出（X6 接納成 queued／running／paused）的時間戳，給每小時上限。 */
  private handed: number[] = []
  private loaded: Promise<void>
  private running: Promise<void> | null = null
  private again = false
  private lastTickAt = Number.NEGATIVE_INFINITY
  private timer: ReturnType<typeof setTimeout> | null = null
  private timerAt = 0
  private saveChain: Promise<unknown> = Promise.resolve()
  private dirty = false
  private disposed = false
  /** 每次開關切換加 1：切換之前開始的一輪不會把結果寫回來。 */
  private generation = 0
  private readonly offSwitch: () => void
  /** 觀測（測試與 backend.info 用）：只有計數。 */
  readonly counters = { ticks: 0, scanned: 0, handedOff: 0, settled: 0, deferred: 0, skippedUnsent: 0, skippedId: 0, saves: 0, resets: 0, closedIdle: 0, locatorDeferred: 0, dbChanged: 0, rehanded: 0 }

  constructor(options: LineJsReceiveOptions) {
    this.opts = options
    this.limits = Object.freeze({ ...RECEIVE_LIMITS, ...options.limits })
    this.now = options.now ?? Date.now
    this.dir = path.join(options.dataDir, 'linejs-downloads')
    this.file = path.join(this.dir, RECEIVE_CURSOR_NAME)
    // the starting point of a fresh cursor is read right now (synchronously), not after the file is loaded: a row the watcher persists
    // in between is after the switch and must be received. load() decides with the switch state of this moment; a change while the file
    // is still loading is applied after it by onSwitch with the starting point of that change (F-5)
    const startOn = options.receiveSwitch.receiveEnabled()
    this.loaded = this.load(startOn, startOn ? this.startPoint() : null)
    this.offSwitch = options.receiveSwitch.onReceiveEnabledChange((on) => {
      // synchronously: a round in progress sees the switch at its next check (generation), and an on reads its starting point now
      this.generation++
      void this.onSwitch(on, on ? this.startPoint() : null)
    })
  }

  /** 開關切換這一刻的 sinceTs 與 MAX(rowid)（同步）。 */
  private startPoint(): StartPoint { return { sinceTs: this.now() - this.limits.sinceBufferMs, max: this.maxRowid() } }

  private log(line: string) { try { this.opts.log?.(`[receive] ${line}`) } catch { /* logging never breaks receiving */ } }

  // ── cursor file ──

  private async load(startOn: boolean, start: StartPoint | null): Promise<void> {
    let doc: Partial<CursorDoc> | null = null
    try { for (const name of await readdir(this.dir)) if (CURSOR_TEMP_RE.test(name)) await unlink(path.join(this.dir, name)).catch(() => {}) } catch { /* no directory yet */ }
    let text: string | null = null
    try { text = await readFile(this.file, 'utf8') } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== 'ENOENT') this.log('code=CURSOR_UNREADABLE')
    }
    if (text !== null) {
      try { const v = JSON.parse(text); doc = v && typeof v === 'object' && !Array.isArray(v) && v.version === 1 ? v : null } catch { doc = null }
      if (!doc) this.log('code=CURSOR_CORRUPT')
    }
    // the switch state of the construction moment (F-5): a change during the load is applied after it by onSwitch, with its own start
    this.enabled = startOn
    if (!startOn || !start) return
    const after = toRowid(doc?.afterRowid)
    const since = toRowid(doc?.sinceTs)
    if (doc?.enabled === true && after !== null && since !== null) {
      // resume: the rows after the cursor and the ones still outstanding (all handed again: X6 short-circuits what has landed)
      this.afterRowid = after
      this.sinceTs = since
      this.dbId = typeof doc.dbId === 'string' && DB_ID.test(doc.dbId) ? doc.dbId : null
      const now = this.now()
      for (const id of Array.isArray(doc.outstanding) ? doc.outstanding : []) {
        if (typeof id === 'string' && MSG_ID.test(id) && this.outstanding.size < this.limits.window) this.outstanding.set(id, { id, accepted: false, nextAt: now, locatorTries: 0 })
      }
      this.handed = (Array.isArray(doc.handed) ? doc.handed : []).filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t > now - this.limits.hourMs && t <= now)
    } else {
      // receive is on but there is no cursor of an enabled receive (first start with this version, a corrupt file, no sinceTs): a fresh start
      this.freshCursor(start)
    }
  }

  /**
   * 第一次開啟（或重新開啟）：sinceTs 與游標取開關切換那一刻的值；那時 app DB 還沒就緒（max null）就等第一次能讀時從 0 開始掃
   * （sinceTs 濾掉歷史，開啟之後落庫的列不會漏；F-5）。DB 識別在第一次能讀時記下。
   */
  private freshCursor(start: StartPoint) {
    this.outstanding.clear()
    this.afterRowid = start.max
    this.sinceTs = start.sinceTs
    this.dbId = null
    this.dirty = true
  }

  /**
   * app DB 的識別（F-1）：app_settings 的 RECEIVE_DB_ID_KEY；第一次讀不到時寫入一個隨機 UUID（INSERT OR IGNORE，再讀一次）。
   * 沒有 app_settings 表、或讀寫失敗 → null（不比對）。
   */
  private dbIdentity(db: ReceiveDb): string | null {
    const read = (): string | null => {
      const row = db.prepare(DB_ID_SELECT_SQL).get(RECEIVE_DB_ID_KEY) as { value?: unknown } | undefined
      return typeof row?.value === 'string' && DB_ID.test(row.value) ? row.value : null
    }
    try {
      const have = read()
      if (have) return have
      const insert = db.prepare(DB_ID_INSERT_SQL)
      if (typeof insert.run !== 'function') return null
      insert.run(RECEIVE_DB_ID_KEY, randomUUID())
      return read()
    } catch { return null }
  }

  private maxRowid(): number | null {
    const db = this.db()
    if (!db) return null
    try { return toRowid((db.prepare(MAX_SQL).get() as { m?: unknown } | undefined)?.m) ?? 0 } catch { return null }
  }

  private db(): ReceiveDb | null { try { return this.opts.getDb() } catch { return null } }

  private save(): Promise<void> {
    this.dirty = false
    const body = JSON.stringify({ version: 1, enabled: this.enabled, afterRowid: this.afterRowid, sinceTs: this.sinceTs, dbId: this.dbId, outstanding: [...this.outstanding.keys()], handed: this.handed } satisfies CursorDoc)
    const run = this.saveChain.then(async () => {
      await mkdir(this.dir, { recursive: true })
      const temp = `${this.file}.${randomUUID()}.part`
      await writeFileDurable(temp, body)
      try { await rename(temp, this.file) } catch (error) { await unlink(temp).catch(() => {}); throw error }
      this.counters.saves++
    })
    this.saveChain = run.catch((error) => { this.dirty = true; this.log(`code=CURSOR_WRITE_FAILED_${String((error as { code?: unknown } | null)?.code ?? 'IO').replace(/[^A-Z0-9_]/gi, '').slice(0, 32)}`) })
    return this.saveChain as Promise<void>
  }

  // ── switch ──

  private async onSwitch(on: boolean, start: StartPoint | null) {
    await this.loaded
    if (this.disposed || on === this.enabled) return
    this.enabled = on
    this.clearTimer()
    if (on) {
      this.freshCursor(start ?? this.startPoint())
      this.log('state=enabled')
      await this.save()
      this.notify()
    } else {
      // nothing is scheduled any more, and what receive itself queued in X6 is cancelled (a user's click or a batch keeps its job)
      this.outstanding.clear()
      this.handed = []
      const cancelled = this.opts.originals.cancelReceive()
      this.log(`state=disabled cancelled=${cancelled}`)
      await this.save()
    }
  }

  // ── scheduling ──

  /** 啟動後第一輪（接續重啟前的游標與 outstanding）；`delayMs`：真實 LINE 來源時等 activate() 回傳之後。 */
  start(delayMs = 0): void { this.schedule(Math.max(0, delayMs)) }

  /** 落庫（messages-persisted）、session 變更或計時器：盡快看一次（合併、最短間隔 minTickMs）。 */
  notify(): void {
    if (this.disposed) return
    if (this.running) { this.again = true; return }
    const wait = this.lastTickAt + this.limits.minTickMs - this.now()
    this.schedule(Math.max(0, wait))
  }

  private schedule(ms: number) {
    if (this.disposed) return
    const at = this.now() + ms
    if (this.timer && this.timerAt <= at) return
    this.clearTimer()
    this.timerAt = at
    this.timer = setTimeout(() => { this.timer = null; void this.tick() }, ms)
    this.timer.unref?.()
  }

  private clearTimer() { if (this.timer) { clearTimeout(this.timer); this.timer = null } }

  /** 一輪（同一時間只有一輪）。測試可以直接 await。 */
  tick(): Promise<void> {
    if (this.running) { this.again = true; return this.running }
    const run = this.tickOnce().catch((error) => { this.log(`code=TICK_FAILED_${String((error as { code?: unknown } | null)?.code ?? 'ERROR').replace(/[^A-Z0-9_]/gi, '').slice(0, 32)}`) }).finally(() => {
      this.running = null
      if (this.again && !this.disposed) { this.again = false; this.notify() }
    })
    this.running = run
    return run
  }

  private async tickOnce(): Promise<void> {
    await this.loaded
    if (this.disposed || !this.enabled || !this.opts.receiveSwitch.receiveEnabled()) return
    const generation = this.generation
    this.lastTickAt = this.now()
    this.counters.ticks++
    const stale = () => this.disposed || !this.enabled || generation !== this.generation || !this.opts.receiveSwitch.receiveEnabled()
    // no installed session: nothing is handed (and no token login is triggered from here); try again later. The accepted rows stay as they
    // are: after the login X6 answers idle / SESSION_ENDED for what the logout dropped (same account → handed again, NF-1)
    if (!this.opts.session.currentSessionId()) { this.schedule(this.limits.deferMs); if (this.dirty) await this.save(); return }
    const db = this.db()
    if (!db) { this.schedule(this.limits.deferMs); return }
    const now = this.now()
    // F-1: the cursor belongs to one app DB. Another DB (deleted and rebuilt, another file) is a fresh start: since now, from its MAX
    const id = this.dbIdentity(db)
    if (id !== null && this.dbId !== id) {
      if (this.dbId !== null) {
        this.outstanding.clear()
        this.sinceTs = now
        this.afterRowid = this.maxRowid()
        this.counters.dbChanged++
        this.log('code=DB_CHANGED')
      }
      this.dbId = id
      this.dirty = true
    }
    // F-5: the app DB was not ready when receive was switched on — scan from the start; sinceTs keeps the history out
    if (this.afterRowid === null) { this.afterRowid = 0; this.dirty = true }
    if (this.sinceTs === null) { this.sinceTs = now - this.limits.sinceBufferMs; this.dirty = true }
    this.handed = this.handed.filter((t) => t > now - this.limits.hourMs)

    // 1. what X6 already holds: still queued / running / paused, or has it ended (cancelled or dropped back to idle: closed, F-2)
    const accepted = [...this.outstanding.values()].filter((o) => o.accepted)
    if (accepted.length) {
      const st = await this.opts.originals.status(accepted.map((o) => o.id))
      if (stale()) return
      for (const v of st.items) this.applyView(v, false)
    }

    // 2. new rows after the cursor (only while the window and the hourly budget have room)
    let backlog = false
    const room = Math.min(this.limits.window - this.outstanding.size, this.limits.perHour - this.handed.length)
    if (room > 0) {
      const hi = this.maxRowid()
      if (hi !== null && this.afterRowid !== null && hi < this.afterRowid) {
        // the app DB was replaced (same identity, or none readable): never backfill its history; sinceTs stays
        this.afterRowid = hi
        this.counters.resets++
        this.dirty = true
        this.log('code=CURSOR_RESET')
      } else if (hi !== null && this.afterRowid !== null && hi > this.afterRowid) {
        let rows: Array<{ rid: unknown; msg_id: unknown; chat_id: unknown; ts: unknown; direction: unknown; content_type: unknown; file_size: unknown; unsent: unknown }> = []
        try { rows = db.prepare(SCAN_SQL).all(this.afterRowid, hi, this.sinceTs, room) as typeof rows } catch { rows = [] }
        for (const r of rows) {
          this.counters.scanned++
          const id = String(r.msg_id ?? '')
          if (Number(r.unsent) === 1) this.counters.skippedUnsent++
          else if (!MSG_ID.test(id)) this.counters.skippedId++
          else {
            if (!this.outstanding.has(id)) this.outstanding.set(id, { id, accepted: false, nextAt: now, locatorTries: 0 })
            if (r.direction === 'out' && (Number(r.content_type) === 1 || Number(r.content_type) === 14)) this.noteOutbound(id, r)
          }
        }
        const last = rows.length ? toRowid(rows[rows.length - 1].rid) : null
        // fewer rows than asked: nothing else up to `hi` is a photo / video / file
        this.afterRowid = rows.length < room || last === null ? hi : last
        backlog = this.afterRowid < hi
        this.dirty = true
      }
    } else {
      const hi = this.maxRowid()
      backlog = hi !== null && this.afterRowid !== null && hi > this.afterRowid
    }

    // 3. hand what is due to X6 (at most the hourly budget left)
    const budget = this.limits.perHour - this.handed.length
    const due = [...this.outstanding.values()].filter((o) => !o.accepted && o.nextAt <= now).slice(0, Math.max(0, budget))
    if (due.length) {
      // the cursor and the outstanding rows are on disk before anything is handed (a crash re-hands them, it never loses them)
      await this.save()
      if (stale()) return
      const res = await this.opts.originals.enqueueDetailed(due.map((o) => o.id), { origin: 'receive' })
      if (stale()) {
        // the switch went off while X6 was admitting these: what it queued for receive is cancelled too
        if (!this.opts.receiveSwitch.receiveEnabled()) this.opts.originals.cancelReceive()
        return
      }
      for (const v of res.items) this.applyView(v, true)
    }
    if (this.dirty) await this.save()
    const delay = this.nextDelay(backlog)
    if (delay !== null) this.schedule(delay)
  }

  /**
   * 下一輪什麼時候：X6 手上有列 → pollMs；只剩被擋下的 → 最早該再交的時間；還有積壓而且 window 有空位 → 每小時額度還有就 minTickMs、
   * 用完了就等最舊的一筆滿一小時。沒有任何事 → null（等下一次落庫）。
   */
  private nextDelay(backlog: boolean): number | null {
    const now = this.now()
    let delay = Number.POSITIVE_INFINITY
    let nextDue = Number.POSITIVE_INFINITY
    for (const o of this.outstanding.values()) {
      if (o.accepted) delay = Math.min(delay, this.limits.pollMs)
      else nextDue = Math.min(nextDue, o.nextAt)
    }
    const budgetLeft = this.limits.perHour - this.handed.length
    const freeAt = budgetLeft > 0 ? now : Math.min(...this.handed) + this.limits.hourMs
    if (Number.isFinite(nextDue)) delay = Math.min(delay, Math.max(nextDue, freeAt) - now)
    if (backlog && this.outstanding.size < this.limits.window) delay = Math.min(delay, freeAt - now)
    return Number.isFinite(delay) ? Math.max(this.limits.minTickMs, delay) : null
  }

  /** X6 回的一格狀態 → outstanding 怎麼變。`fromEnqueue`：這次是剛交出的（接納成功才算每小時一次）。 */
  private applyView(v: OriginalItemView, fromEnqueue: boolean) {
    const o = this.outstanding.get(v.msgId)
    if (!o) return
    if (ACCEPTED.has(v.state)) {
      if (fromEnqueue) { this.handed.push(this.now()); this.counters.handedOff++ }
      if (!o.accepted) { o.accepted = true; this.dirty = true }
      return
    }
    // NF-1: X6 dropped it at a logout and the same account is logged in again — not a result: handed again right away
    // (X6 answers done for what has landed; another account gets a plain idle and is closed below, ADJ-X2BF-01)
    if (v.state === 'idle' && v.code === ORIGINALS_SESSION_ENDED) {
      o.accepted = false
      o.nextAt = this.now()
      this.counters.rehanded++
      this.dirty = true
      return
    }
    // F-2: any other idle is closed — never queued again by receive (after X6 accepted it: the user cancelled it in X7, or the account
    // changed). NF-4: only a service that could not answer (not ready, or this status read failed) is tried again later (DEFERRED below),
    // whether X6 had accepted it or not
    if (v.state === 'idle' && !IDLE_RETRY_CODES.has(v.code ?? '')) {
      this.outstanding.delete(v.msgId)
      this.counters.closedIdle++
      this.counters.settled++
      this.dirty = true
      return
    }
    // F-4: the locator was not complete yet (the watcher fills the columns later by UPDATE): a bounded number of later tries
    if (v.state === 'unsupported' && v.code === 'LOCATOR_INCOMPLETE' && o.locatorTries < this.limits.locatorRetries) {
      o.locatorTries++
      o.accepted = false
      o.nextAt = this.now() + this.limits.locatorRetryMs
      this.counters.locatorDeferred++
      this.dirty = true
      return
    }
    if (DEFERRED.has(v.state)) {
      o.accepted = false
      o.nextAt = this.now() + this.limits.deferMs
      this.counters.deferred++
      this.dirty = true
      return
    }
    // done, expired, undecryptable, unsupported, forbidden, failed, failed_retry_exhausted: this row has its result
    this.outstanding.delete(v.msgId)
    this.counters.settled++
    this.dirty = true
  }

  /** 自己傳出的照片／檔案列 → X6 的 OUTBOUND_ID_MISMATCH 偵測（只比對記憶體；失敗不影響接收）。 */
  private noteOutbound(msgId: string, r: { chat_id: unknown; ts: unknown; file_size: unknown }) {
    const ts = toRowid(r.ts)
    if (typeof r.chat_id !== 'string' || ts === null) return
    try { this.opts.originals.noteOutboundRow?.({ msgId, chatId: r.chat_id, size: toRowid(r.file_size), ts }) } catch { /* detection only */ }
  }

  /** 測試與觀測用（只有計數，沒有 id）。 */
  state() {
    let accepted = 0
    for (const o of this.outstanding.values()) if (o.accepted) accepted++
    return { enabled: this.enabled, afterRowid: this.afterRowid, sinceTs: this.sinceTs, outstanding: this.outstanding.size, accepted, handedLastHour: this.handed.filter((t) => t > this.now() - this.limits.hourMs).length }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.offSwitch()
    this.clearTimer()
    await this.running?.catch(() => {})
    await this.loaded.catch(() => {})
    if (this.enabled && this.dirty) await this.save()
    await this.saveChain
  }
}
