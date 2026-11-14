/**
 * linejsOriginals.ts — Pro「舊訊息下載原檔」backend 服務（X6；history-download.md §5–§6、implementation-plan-v2.md X6）。
 *
 * `OriginalDownloadService`：
 *   request(msgId) ／ status(msgIds ≤200) ／ cancel(msgId) ／ batchStart(chatId, msgIds ≤50) ／ batchCancel(batchId) ／
 *   enqueue(msgIds, {origin:'receive'})（X2b 之後以電腦版訊息為準時呼叫；介面先留好）。
 *
 * 每一格依序把關（由便宜到貴，HD §5.3）：
 *   1. single-flight：同一個 stem 已有工作、或另一條車道正在接納它 → 等那次接納結束，再回那個工作的狀態（review-x6 F-1：接納一開始
 *      就同步佔位，所以不論從哪條車道、什麼時序進來，同一個 stem 都只有一個 Job、一個請求）。單格會把排隊中的批次工作升成單格優先，
 *      並標成使用者的工作（batchCancel 不取消它）；批次合併到使用者按下的單格時不替它帶上 batchId（review-x6 I-5）。
 *   2. 本地判斷（不連網）：`'i:'` id、app DB 有這一列、未收回、ct ∈ {1,2,14}、chatId 開頭 u／c／r、聊天室已知。
 *   3. 已落地（sink.existing）→ done。
 *   4. 帳號一致（fail-closed）：先讀電腦版 myMid（接納用 60 s 快取），已安裝的 session 是別的帳號就直接拒絕；之後才呼叫
 *      outboundSession()（review-x6 I-2：電腦版帳號讀不到、或已知帳號不一致時不碰 session，不會觸發 tokenLogin）。
 *      真正送出前（run）一律重讀電腦版帳號，不用快取（review-x6 F-4）；那時讀不到就回到排隊、稍後再讀（log ACCOUNT_UNVERIFIED），
 *      只有確定是別的帳號才丟掉工作（review-x6-r2 N-3）。讀不到時是服務層級的暫停（review-x67 L-1）：整個服務每 ACCOUNT_RETRY_MS
 *      只讀一次帳號（同時要讀的共用同一次），排隊中的工作（單格、批次、接收）一起等，一段暫停只寫一行 log。那一次讀取最多等
 *      ACCOUNT_READ_TIMEOUT_MS（30 s，review-x5 Info），逾時視同讀不到；登出或換 session 時暫停一併解除（review-x5 F-3）。
 *   5. resolveLocator：app DB 那一列不足（影片、缺 OID／SID）時讀電腦版那一列（HD §6.2），耗時寫進 trace。
 *   6. ledger 終態（expired、undecryptable、同一 session 的 forbidden、unsupported、RETRY_EXHAUSTED）→ 回終態，0 次請求。
 *   7. 照片先試本機（LINE Cache 已有 .eimg）→ 寫進 media-saved，0 次 OBS 請求。
 *   8. 排隊：兩條車道——單格／接收一條（單格優先）、批次一條，各同時 1 個（共 ≤2，等於 X1 共用限流的並行上限，批次 ≤1）。
 *      所以單格手動下載不必等批次排完。
 *      車道搶先（review-x2b 車道佔用）：單格車道正在跑接收自動排的影片／檔案（或宣告大小超過 PREEMPT_MIN_BYTES）而有使用者的單格在等
 *      （可以開始、沒有被暫停擋住）→ 中止那個接收工作：part 與 ledger 的 partName 保留、記 paused／PREEMPTED（不算 attempts），以原本的
 *      receive 優先序回到排隊；車道空出後 pick 先拿使用者的單格，接收之後以 Range 續傳。照片不搶先（幾秒內就完成）。同一個接收工作最多
 *      被搶先 PREEMPT_MAX_PER_JOB 次（使用者反覆按、或使用者的工作反覆進出時不會變成迴圈；超過就讓它跑完）。
 *
 * 節制（ORIGINALS_LIMITS，待 P0b 校正）：兩次 OBS 請求至少間隔 1 s、每小時 200 次（所有車道共用；在 fetch 這一層計數，X1 內部的重試也算）、
 * 429 讓 X1 共用限流全域暫停、401 只暫停同一個 session（session 換了、token 更新、或 10 分鐘後解除）。可取消（AbortController；part 保留）。
 *   - 200 次之中，接收（X2b）自動排的工作最多 100 次（ORIGINALS_RECEIVE_REQUESTS_PER_HOUR，review-x2b F-3；計請求數）：用完時只有那些
 *     工作暫停（holdOf），單格與批次照常。
 *   - 401 暫停依 sessionId 分開記錄（review-x6 F-3：單一個槽被舊 session 的工作覆寫會變成忙迴圈）。
 *   - session 換成另一個帳號、或登出：其他帳號排隊中的工作回到 idle，進行中的被中止（part 保留）；同一個帳號換 session 時工作跟著新 session
 *     （review-x6 F-3、F-5）。登出丟掉的工作記在記憶體：同一個帳號再登入後 status 回 idle／SESSION_ENDED，接收端據此重交（review-fix-final
 *     NF-1）；使用者取消的、或換成別的帳號時仍是一般的 idle。
 *   - 每小時請求的時間戳與 429 全域暫停的結束時間存在 `<dataDir>/linejs-downloads/originals-throttle.json`（ADJ-X6-02 改規格：持久化，
 *     保護使用者的 LINE 帳號不因重啟而超量）：原子寫入（暫存檔 fsync → rename）、損毀時以空狀態開始並記一筆只含 code 的 log；
 *     載入時也依 ledger 裡 rate_limited 的 nextAt 推回全域暫停（review-x6 F-6）。
 *
 * 讀電腦版那一列（createDesktopRowReader，review-x6 F-8）：重用同一個 snapshot 連線（閒置 idleMs、最長 maxAgeMs、snapshot 要求讓出時
 * 立刻放掉），參數化查詢；在重用的連線上查不到時換一個新連線再查一次。每次查詢的耗時記在 stats().lastQueryMs，並照舊寫進 trace。
 *
 * ledger 收斂（Manager 裁決）：
 *   - transient 失敗每次記一次 attempts；達到 maxAttempts 就把 code 改成 RETRY_EXHAUSTED（狀態 failed_retry_exhausted），
 *     不再自動重試（批次、接收都跳過它），只能由使用者手動重試（冷卻 30 s，重試時 attempts 歸零）。
 *   - 總筆數上限 ledgerTotalMax（50 000）：超過時先淘汰最舊的 done（media-saved 才是事實來源），再淘汰最舊的非終態、非進行中紀錄；
 *     終態負面紀錄另有 X2a 的 20 000 上限。
 *   - 寫檔節流：MediaLedger.flush 每次都重寫整份 JSON。量測（test-linejs-originals.mjs [M4]，2026-11-14 本機 SSD）：每筆約 364 B，
 *     50 000 筆約 18 MB、一次 flush 約 85 ms（JSON.stringify＋寫入＋fsync；較慢的磁碟或防毒掃描可到數百 ms，而且整段在主執行緒）。
 *     一次下載會改 ledger 3 次（begin、running、結果），批次 50 格就是 150 次，不節流等於重寫 2.7 GB。所以只在有變動時排一次
 *     trailing flush，兩次 flush 至少間隔 ledgerFlushMinIntervalMs（2 s）；running 不必立刻落檔（載入時本來就轉回 queued；
 *     崩潰最多丟掉 2 s 內的狀態，part 名稱遺失只會讓那一格從頭下載），dispose 時再 flush 一次。
 *
 * 單一 sink（review-x2a I-1）：sink 的鎖只在同一個實例裡有效，所以全系統經由 `sharedMediaSink(dataDir)` 共用同一個
 * LineJsMediaSink（每個 dataDir 一個；src 裡只有這裡會 new 它，測試會掃描原始碼確認）。ledger 同理（sharedMediaLedger）。
 *
 * status 只讀本地：記憶體裡的工作、ledger、檔案系統（sink.existing、part 大小）與 app DB；永遠不呼叫 LINE（不呼叫
 * outboundSession／outboundPeek、不讀電腦版 LINE DB、不送任何請求）。
 *
 * log 只記代碼（review-x2a I-2）：事件、kind、origin、狀態、分類碼與耗時；不記路徑、聊天室名、檔名、任何 id 或 sessionId。
 */
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { normalizeMsgId } from '../../main/line/engine/wasm/int64'
import { ORIGINALS_LIMITS } from '../../shared/linejsOriginals'
import type { OriginalBatchStartView, OriginalBatchView, OriginalItemView, OriginalState, OriginalStatusView } from '../../shared/linejsOriginals'
import { MediaLedger, isTerminalNegative, ledgerBlocks, ledgerFingerprint, ledgerOwner, writeFileDurable } from './linejsAutoDownload.mjs'
import type { MediaLedgerEntry } from './linejsAutoDownload.mjs'
import { createLineJsMediaFetch } from './linejsMedia'
import type { LineJsOutboundSession } from './linejsMedia'
import { LineJsMediaSink } from './linejsMediaSink'
import type { LineJsSinkTarget, SinkResult, SinkSpec } from './linejsMediaSink'
import { streamDownload } from './linejsMediaStream'
import type { StreamOptions } from './linejsMediaStream'
import { OBS_AUTH_PAUSE_MAX_MS, OBS_RATE_LIMIT_MAX_MS, locatorProblem, sharedObsLimiter } from './linejsObs'
import type { MediaKind, MediaLocator, MediaOrigin, ObsLimiter, ObsPriority, Outcome } from './linejsObs'
import { mediaCacheStem } from './media'
import type { MediaDb } from './media'

/**
 * 接收（X2b）自動排的工作每小時最多用幾次 OBS 請求（review-x2b F-3）：requestsPerHour（200）的子上限，計的是請求數，不是列數
 * （一則失敗的列可以用到 X1 的 5 次 × X6 的 3 次＝15 次）。用完時只有接收自動排的工作暫停，單格與批次至少還有 100 次。
 * 放在 backend（不改 shared 的 ORIGINALS_LIMITS 型別）。
 */
export const ORIGINALS_RECEIVE_REQUESTS_PER_HOUR = 100
export type OriginalsLimits = typeof ORIGINALS_LIMITS & { receiveRequestsPerHour: number }
/** OUTBOUND_ID_MISMATCH 偵測：X3 回寫與電腦版那一列的時間差在這之內才比對（LINE 伺服器時間與本機時鐘的誤差、watcher 落庫延遲）。 */
const OUTBOUND_MATCH_WINDOW_MS = 10 * 60_000
/** 記住最近幾筆 X3 回寫（只有聊天室、大小、stem、時間；在記憶體）。 */
const OUTBOUND_RECENT_MAX = 50
/**
 * 車道搶先的大小門檻（照片以外，影片、檔案一律可被搶先）：8 MiB。保守的 1 MiB/s 下約 8 秒——比這久，使用者按下「下載原檔」後等待
 * 就明顯；LINE 的照片通常 < 2 MiB，幾秒內就完成，搶先只會多一次續傳請求。
 */
export const PREEMPT_MIN_BYTES = 8 * 1024 * 1024
/** 同一個接收工作最多被搶先幾次（防止使用者工作反覆進出造成搶先迴圈；每次搶先多一次續傳請求）。 */
export const PREEMPT_MAX_PER_JOB = 3
/**
 * review-fix-final NF-1（backend 內部的碼，不在 shared 型別裡；UI 對 idle 不看 code）：登出時被丟掉的工作，同一個帳號再登入後 status 回
 * `idle`＋這個碼，讓接收端（linejsReceive）分得出「登出丟掉的」與「使用者取消的」——前者重交，後者結案。換成別的帳號登入時不回這個碼
 * （ADJ-X2BF-01：不改用新帳號重交）。
 */
export const ORIGINALS_SESSION_ENDED = 'SESSION_ENDED'
/** 登出時記住幾個被丟掉的工作（只在記憶體；超過就丟最舊的）。 */
const SESSION_ENDED_MAX = 500

// ───────────────────────── 單一 sink／ledger（I-1） ─────────────────────────

const SINKS = new Map<string, LineJsMediaSink>()
const LEDGERS = new Map<string, { ledger: MediaLedger; loaded: Promise<unknown> }>()
const storeKey = (dataDir: string) => path.resolve(dataDir).toLowerCase()

/** 全系統共用的 sink（每個 dataDir 一個）。X2b／X3／X4 也要經由這裡拿，不要自己 new。 */
export function sharedMediaSink(dataDir: string): LineJsMediaSink {
  const key = storeKey(dataDir)
  let sink = SINKS.get(key)
  if (!sink) { sink = new LineJsMediaSink({ dataDir }); SINKS.set(key, sink) }
  return sink
}

/** 全系統共用的 ledger v2（每個 dataDir 一個；檔案在 `<dataDir>/linejs-downloads/media-ledger.json`，v1 在同一個目錄）。 */
export function sharedMediaLedger(dataDir: string, options: { now?: () => number; log?: (line: string) => void } = {}): { ledger: MediaLedger; loaded: Promise<unknown> } {
  const key = storeKey(dataDir)
  let entry = LEDGERS.get(key)
  if (!entry) {
    const ledger = new MediaLedger(path.join(dataDir, 'linejs-downloads'), { ...(options.now ? { now: options.now } : {}), ...(options.log ? { log: options.log } : {}) })
    entry = { ledger, loaded: ledger.load() }
    entry.loaded.catch(() => {})
    LEDGERS.set(key, entry)
  }
  return entry
}

/**
 * 放掉某個 dataDir 的共用 ledger（只給測試模擬「行程重新啟動」：下一個服務會從磁碟重新載入 ledger）。
 * sink 不放：它沒有要重新載入的狀態，同一個行程裡永遠只有一個。正式執行不呼叫這個函式。
 */
export function releaseSharedLedger(dataDir: string): void {
  LEDGERS.delete(storeKey(dataDir))
}

// ───────────────────────── 讀電腦版那一列（review-x6 F-8） ─────────────────────────

/** HD §6.2 的查詢：參數化，每個連線只 prepare 一次。 */
export const DESKTOP_ROW_SQL = 'SELECT _id,_contentType,_contentMetadata,_contentInfo FROM _message WHERE _chatId=? AND _createdTime=?'
/** 連線閒置這麼久就放掉（snapshot 的 lease 不要一直佔著）。 */
export const DESKTOP_READER_IDLE_MS = 5_000
/** 同一個連線最多用這麼久（之後換一個，讓較新的 snapshot 有機會被看到）。 */
export const DESKTOP_READER_MAX_AGE_MS = 30_000

/** `lineAccess.open({ policy: 'any' })` 回傳值的子集（OpenedLineDb 結構相容）。 */
export interface DesktopRowSource {
  con: { prepare(sql: string): { all(...params: unknown[]): unknown[] } }
  cleanup(): void
  /** snapshot 有更新在等這個 lease：盡快放掉。 */
  shouldYield?(): boolean
}

export interface DesktopRowReader {
  rows(chatId: string, createdTime: number): Promise<OriginalsDesktopRow[] | null>
  close(): void
  /** 只有計數與最後一次查詢的耗時（ms，不含開檔）。 */
  stats(): { opens: number; queries: number; lastQueryMs: number | null }
}

/**
 * 讀電腦版那一列，重用同一個連線（review-x6 F-8：原本每次都重新開 snapshot）。
 *   - 開檔與 prepare 一次，之後的查詢都用同一個 statement；同時進來的讀取共用同一次開檔。
 *   - 閒置 idleMs、用了 maxAgeMs、或 snapshot 要求讓出（shouldYield）時放掉；close() 立刻放掉。
 *   - 在重用的連線上查不到（那個 snapshot 可能比這一列舊）→ 換一個新連線再查一次。
 *   - 查詢出錯時放掉連線並往上丟（呼叫端當成讀不到）。
 *   - 「放掉」只是不再給新的讀取用；正在用它的讀取都結束了才真的關（參照計數，review-x6-r2 N-2：並行的讀取不會用到
 *     另一個讀取剛關掉的連線而出現 SQLITE_MISUSE）。
 */
export function createDesktopRowReader(open: () => Promise<DesktopRowSource | null>, options: { idleMs?: number; maxAgeMs?: number; now?: () => number } = {}): DesktopRowReader {
  const idleMs = options.idleMs ?? DESKTOP_READER_IDLE_MS
  const maxAgeMs = options.maxAgeMs ?? DESKTOP_READER_MAX_AGE_MS
  const now = options.now ?? Date.now
  // refs: reads holding this connection right now; retired: no new read takes it, it is closed when the last read lets go (review N-2)
  interface Held { source: DesktopRowSource; statement: { all(...params: unknown[]): unknown[] }; openedAt: number; uses: number; refs: number; retired: boolean }
  let held: Held | null = null
  let opening: Promise<Held | null> | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let closed = false
  const counts: { opens: number; queries: number; lastQueryMs: number | null } = { opens: 0, queries: 0, lastQueryMs: null }

  const yields = (h: Held) => { try { return h.source.shouldYield?.() === true } catch { return true } }
  const closeIfUnused = (h: Held) => { if (h.retired && h.refs === 0) { h.refs = -1; try { h.source.cleanup() } catch { /* already closed */ } } }
  /** this connection takes no new read; a read still using it finishes first (N-2: never closed under another read) */
  const retire = (h: Held) => {
    if (held === h) { held = null; if (idleTimer) { clearTimeout(idleTimer); idleTimer = null } }
    h.retired = true
    closeIfUnused(h)
  }
  const release = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    const h = held
    if (h) retire(h)
  }
  const arm = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { idleTimer = null; release() }, idleMs)
    idleTimer.unref?.()
  }
  const acquire = (): Promise<Held | null> => {
    if (held && (yields(held) || now() - held.openedAt >= maxAgeMs)) release()
    if (held) return Promise.resolve(held)
    if (!opening) {
      opening = (async () => {
        const source = await open()
        if (!source) return null
        counts.opens++
        if (closed) { try { source.cleanup() } catch { /* closing */ } return null }
        let statement: Held['statement']
        try { statement = source.con.prepare(DESKTOP_ROW_SQL) } catch (error) { try { source.cleanup() } catch { /* closing */ } throw error }
        held = { source, statement, openedAt: now(), uses: 0, refs: 0, retired: false }
        return held
      })().finally(() => { opening = null })
    }
    return opening
  }
  /** a connection this read holds (refs + 1) until `let go`; one another read retired in between is never taken (N-2) */
  const lease = async (): Promise<Held | null> => {
    for (let tries = 0; tries < 4; tries++) {
      const h = await acquire()
      if (!h) return null
      if (!h.retired) { h.refs++; return h }
    }
    return null
  }
  const letGo = (h: Held) => { h.refs--; closeIfUnused(h) }
  const query = (h: Held, chatId: string, createdTime: number): OriginalsDesktopRow[] => {
    const t0 = performance.now()
    try {
      const rows = h.statement.all(chatId, createdTime) as OriginalsDesktopRow[]
      h.uses++
      return rows
    } catch (error) {
      retire(h)
      throw error
    } finally {
      counts.queries++
      counts.lastQueryMs = Number((performance.now() - t0).toFixed(3))
    }
  }
  return {
    async rows(chatId, createdTime) {
      if (closed) return null
      let h = await lease()
      if (!h) return null
      let rows: OriginalsDesktopRow[]
      try {
        const reused = h.uses > 0
        rows = query(h, chatId, createdTime)
        if (!rows.length && reused) {
          const stale = h
          h = null
          retire(stale)
          letGo(stale)
          h = await lease()
          if (!h) return null
          rows = query(h, chatId, createdTime)
        }
        if (held === h) { if (yields(h)) retire(h); else arm() }
      } finally {
        if (h) letGo(h)
      }
      return rows
    },
    close() { closed = true; release() },
    stats() { return { ...counts } },
  }
}

// ───────────────────────── 節制狀態的持久化（review-x6 F-6，ADJ-X6-02） ─────────────────────────

/** `<dataDir>/linejs-downloads/` 底下（與 ledger 同一個目錄）。 */
export const ORIGINALS_THROTTLE_NAME = 'originals-throttle.json'
const THROTTLE_TEMP_RE = /^originals-throttle\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$/
/** 載入時接受的暫停結束時間上限：與 X1 共用限流的 429 暫停上限相同（6 小時；review-x6-r2 N-4，原本 24 小時比 X1 自己的上限長）。 */
const THROTTLE_PAUSE_MAX_MS = OBS_RATE_LIMIT_MAX_MS

interface ThrottleState { times: number[]; receiveTimes: number[]; rateLimitedUntil: number }

/**
 * 每小時請求的時間戳與 429 全域暫停的結束時間：`{ version: 1, times: number[], receiveTimes?: number[], rateLimitedUntil: number | null }`。
 * receiveTimes（F-3）：其中由接收自動排的工作送出的那些（子上限用；舊檔沒有這個欄位 → 空）。
 * 寫入：暫存檔（wx、0600、fsync）→ rename，串行化。讀不到、解析不了或格式不對 → 以空狀態開始，log 一行只有 code。
 */
class ThrottleStore {
  readonly dir: string
  readonly file: string
  private chain: Promise<unknown> = Promise.resolve()
  private readonly log: (line: string) => void

  constructor(dataDir: string, log: (line: string) => void) {
    this.dir = path.join(dataDir, 'linejs-downloads')
    this.file = path.join(this.dir, ORIGINALS_THROTTLE_NAME)
    this.log = log
  }

  async load(now: number, windowMs: number): Promise<ThrottleState> {
    const empty: ThrottleState = { times: [], receiveTimes: [], rateLimitedUntil: 0 }
    try { for (const name of await readdir(this.dir)) if (THROTTLE_TEMP_RE.test(name)) await unlink(path.join(this.dir, name)).catch(() => {}) } catch { /* no directory yet */ }
    let text: string
    try { text = await readFile(this.file, 'utf8') } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== 'ENOENT') this.log('code=THROTTLE_UNREADABLE')
      return empty
    }
    let doc: { version?: unknown; times?: unknown; receiveTimes?: unknown; rateLimitedUntil?: unknown } | null = null
    try { const v = JSON.parse(text); doc = v && typeof v === 'object' && !Array.isArray(v) ? v : null } catch { doc = null }
    if (!doc || doc.version !== 1 || !Array.isArray(doc.times)) { this.log('code=THROTTLE_CORRUPT'); return empty }
    const inWindow = (list: unknown[]) => list.filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x > now - windowMs && x <= now + windowMs).sort((a, b) => a - b)
    const times = inWindow(doc.times)
    const receiveTimes = Array.isArray(doc.receiveTimes) ? inWindow(doc.receiveTimes) : []
    const until = typeof doc.rateLimitedUntil === 'number' && Number.isFinite(doc.rateLimitedUntil) && doc.rateLimitedUntil > now ? Math.min(doc.rateLimitedUntil, now + THROTTLE_PAUSE_MAX_MS) : 0
    return { times, receiveTimes, rateLimitedUntil: until }
  }

  save(state: ThrottleState): Promise<void> {
    const body = JSON.stringify({ version: 1, times: state.times, receiveTimes: state.receiveTimes, rateLimitedUntil: state.rateLimitedUntil > 0 ? state.rateLimitedUntil : null })
    const run = this.chain.then(async () => {
      await mkdir(this.dir, { recursive: true })
      const temp = `${this.file}.${randomUUID()}.part`
      await writeFileDurable(temp, body)
      try { await rename(temp, this.file) } catch (error) { await unlink(temp).catch(() => {}); throw error }
    })
    this.chain = run.catch(() => {})
    return run
  }

  idle(): Promise<unknown> { return this.chain }
}

// ───────────────────────── ports ─────────────────────────

/** LINEJS session（LineJsMediaService 的子集）。 */
export interface OriginalsSessionPort {
  /** 使用者動作（request、批次）時取得 session；沒有安裝的 client 時會恢復已儲存的登入。status 不呼叫它。 */
  outboundSession(): Promise<LineJsOutboundSession | null>
  isCurrentSession(sessionId: string, client: unknown): boolean
  onSessionChange(listener: (sessionId: string | null) => void): () => void
}

/** app DB 的 messages 一列（只取需要的欄位）。 */
export interface OriginalsAppRow {
  msg_id: string
  chat_id: string
  ts: number
  content_type: number
  key_material: string | null
  file_size: number | null
  media_oid: string | null
  media_sid: string | null
  orig_filename: string | null
  unsent: number | null
}

/** 電腦版 LINE DB `_message` 的一列（只取需要的欄位）。 */
export interface OriginalsDesktopRow { _id: unknown; _contentType?: unknown; _contentMetadata: string | null; _contentInfo: string | null }

export interface OriginalDownloadOptions {
  dataDir: string
  session: OriginalsSessionPort
  /** 電腦版 LINE 的帳號 mid（本機 snapshot；讀不到回 null → fail-closed）。 */
  localAccountMid(): Promise<string | null>
  /** app DB（backend 停止前回 null）。 */
  getDb(): MediaDb | null
  /** 電腦版 LINE DB 裡同一聊天室、同一時間的列（HD §6.2）；沒有 LINE snapshot 就省略。 */
  desktopRows?(chatId: string, createdTime: number): Promise<OriginalsDesktopRow[] | null>
  /** 照片先試本機：LINE Cache 的 .eimg 解密（不連網）；沒命中回 null。 */
  localImage?(input: { keyMaterial: string; fileSize: number }): { bytes: Uint8Array; mime: string } | null
  /** 以下都是測試注入。 */
  limiter?: ObsLimiter
  fetch?: (request: Request) => Promise<Response>
  stream?: Partial<Pick<StreamOptions, 'statfs' | 'backoffMs' | 'maxAttempts' | 'headersTimeoutMs' | 'idleTimeoutMs' | 'reserveBytes'>>
  limits?: Partial<OriginalsLimits>
  /** 讀電腦版帳號的逾時（預設 ACCOUNT_READ_TIMEOUT_MS）。 */
  accountReadTimeoutMs?: number
  now?: () => number
  log?: (line: string) => void
  trace?: (phase: string, ms: number) => void
}

// ───────────────────────── helpers ─────────────────────────

const MSG_ID = /^i:(\d{1,32})$/
const CHAT_ID = /^[ucr][A-Za-z0-9]{1,64}$/
const KIND_BY_CT: Readonly<Record<number, MediaKind>> = Object.freeze({ 1: 'IMAGE', 2: 'VIDEO', 14: 'FILE' })
const APP_ROW_SQL = 'SELECT msg_id, chat_id, ts, content_type, key_material, file_size, media_oid, media_sid, orig_filename, unsent FROM messages WHERE msg_id = ?'
const CHAT_SQL = 'SELECT chat_id, name FROM chats WHERE chat_id = ?'
const RETRY_EXHAUSTED = 'RETRY_EXHAUSTED'
const LOCATOR_SLOW_MS = 200
const ACCOUNT_CHECK_TTL_MS = 60_000
/** 送出前讀不到電腦版帳號時，多久後再試（review-x6-r2 N-3）。 */
const ACCOUNT_RETRY_MS = 5_000
/**
 * 讀電腦版帳號的逾時（review-x5 Info）：共用的那一次讀取卡住（snapshot 被鎖住、LINE 正在寫 DB）超過這麼久就當作讀不到（null，
 * fail-closed），共用這次讀取的接納與送出都不會一直等下去。
 */
export const ACCOUNT_READ_TIMEOUT_MS = 30_000
/** ledger 寫失敗後重試的最長間隔（I-6）。 */
const FLUSH_RETRY_MAX_MS = 60_000
const defaultBackoff = (attempt: number) => Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1))
const coded = (code: string) => Object.assign(new Error(code), { code })
const safeCode = (value: unknown) => String(value ?? '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 64) || 'UNKNOWN'

function parseObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !raw) return null
  try { const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null } catch { return null }
}
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
function toSize(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : NaN
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

/** 一格本地判斷的結果。 */
type Gate =
  | { ok: true; msgId: string; messageId: string; stem: string; kind: MediaKind; row: OriginalsAppRow }
  | { ok: false; view: OriginalItemView }

interface LiveSession extends LineJsOutboundSession { owner: string }

/** 一次接納的來源：單格（manual、user）、批次（batch）、接收（receive）。 */
interface AdmitHow { origin: MediaOrigin; priority: ObsPriority; batchId: string | null; manual: boolean; quiet?: boolean }

interface Job {
  stem: string
  msgId: string
  kind: MediaKind
  origin: MediaOrigin
  priority: ObsPriority
  batchId: string | null
  state: 'queued' | 'running'
  readyAt: number
  session: LiveSession
  locator: MediaLocator
  spec: SinkSpec
  fingerprint: string
  controller: AbortController | null
  partPath: string | null
  /** 這次執行時每小時上限擋下了請求（transient 不算 attempts，改成暫停）：'total' 全部共用的上限、'receive' 接收的子上限（F-3）。 */
  hourly: false | 'total' | 'receive'
  cancelled: boolean
  /** 使用者按下的單格（或使用者按過的批次工作）：批次不會替它帶上 batchId，batchCancel 不取消它（review-x6 I-5）。 */
  manual: boolean
  /** 這次執行被車道搶先中止（不是取消：回到排隊、part 保留、不算 attempts）。 */
  preempted: boolean
  /** 已經被搶先幾次（上限 PREEMPT_MAX_PER_JOB）。 */
  preemptions: number
}

/**
 * 一次批次。`open`：接納了、還沒有結果的 stem（以 stem 計數，所以合併到使用者單格的那一格也算進批次的進度）。
 * `admitting`：接納期間不會被判定結束（review-x6 F-2）。
 */
interface Batch { id: string; chatId: string; open: Set<string>; admitting: boolean; total: number; done: number; failed: number; expired: number; state: 'running' | 'finished' | 'cancelled' }

/**
 * 兩次請求的間隔與每小時上限（在 fetch 這一層，所以 X1 內部的重試也算進去）。take 串行化，間隔不會被兩條車道同時穿過。
 * 每次放行都先把時間戳寫進節制檔（onTaken）再送出（review-x6 F-6）。
 * 接收自動排的工作另有子上限 receiveRequestsPerHour（review-x2b F-3）：take(signal, true) 在子上限用完時回 'receive'（不送出）。
 */
class RequestBudget {
  private times: number[] = []
  private receiveTimes: number[] = []
  private lastAt = Number.NEGATIVE_INFINITY
  private chain: Promise<unknown> = Promise.resolve()
  sent = 0
  private readonly limits: OriginalsLimits
  private readonly now: () => number
  private readonly onTaken: () => Promise<void>

  constructor(limits: OriginalsLimits, now: () => number, onTaken: () => Promise<void>) { this.limits = limits; this.now = now; this.onTaken = onTaken }

  /** 重啟後放回持久化的時間戳。 */
  restore(times: number[], receiveTimes: number[] = []) {
    this.times = [...times].sort((a, b) => a - b)
    this.receiveTimes = [...receiveTimes].sort((a, b) => a - b)
    this.prune()
    if (this.times.length) this.lastAt = Math.max(this.lastAt, this.times[this.times.length - 1])
  }
  snapshot(): { times: number[]; receiveTimes: number[] } { this.prune(); return { times: [...this.times], receiveTimes: [...this.receiveTimes] } }

  private prune() {
    const floor = this.now() - this.limits.requestWindowMs
    while (this.times.length && this.times[0] <= floor) this.times.shift()
    while (this.receiveTimes.length && this.receiveTimes[0] <= floor) this.receiveTimes.shift()
  }
  exhausted(): boolean { this.prune(); return this.times.length >= this.limits.requestsPerHour }
  /** 接收自動排的工作的子上限用完了沒（F-3）。 */
  receiveExhausted(): boolean { this.prune(); return this.receiveTimes.length >= this.limits.receiveRequestsPerHour }
  /** 下一個名額空出的時間（ms epoch；現在就有 → now）。 */
  nextFreeAt(): number { this.prune(); return this.times.length < this.limits.requestsPerHour ? this.now() : this.times[0] + this.limits.requestWindowMs }
  /** 接收子上限的下一個名額空出的時間。 */
  receiveNextFreeAt(): number { this.prune(); return this.receiveTimes.length < this.limits.receiveRequestsPerHour ? this.now() : this.receiveTimes[0] + this.limits.requestWindowMs }

  /** 'ok'：放行（已計數）；'total'：每小時上限用完；'receive'：接收自動排的工作的子上限用完（其他車道照常）。 */
  take(signal: AbortSignal, receive = false): Promise<'ok' | 'total' | 'receive'> {
    const run = this.chain.then(async (): Promise<'ok' | 'total' | 'receive'> => {
      if (this.exhausted()) return 'total'
      if (receive && this.receiveExhausted()) return 'receive'
      const wait = this.lastAt + this.limits.requestIntervalMs - this.now()
      if (wait > 0) await sleep(wait, signal)
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      if (this.exhausted()) return 'total'
      if (receive && this.receiveExhausted()) return 'receive'
      const at = this.now()
      this.times.push(at)
      if (receive) this.receiveTimes.push(at)
      this.lastAt = at
      this.sent++
      await this.onTaken().catch(() => {})
      return 'ok'
    })
    this.chain = run.catch(() => {})
    return run
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) { resolve(); return }
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

// ───────────────────────── service ─────────────────────────

export class OriginalDownloadService {
  readonly sink: LineJsMediaSink
  readonly ledger: MediaLedger
  private readonly ledgerLoaded: Promise<unknown>
  private readonly opts: OriginalDownloadOptions
  private readonly limits: OriginalsLimits
  private readonly limiter: ObsLimiter
  private readonly budget: RequestBudget
  private readonly baseFetch: (request: Request) => Promise<Response>
  private readonly now: () => number
  private readonly jobs = new Map<string, Job>()
  /** 正在接納（還沒有 Job）的 stem：同一個 stem 的下一次接納等它結束（review-x6 F-1）。 */
  private readonly admitting = new Map<string, Promise<OriginalItemView>>()
  /** cancel() 遇到正在接納的 stem：記下來，接納建立 Job 之前看到就不排（review-x6-r2 N-1）；接納結束時清掉。 */
  private readonly cancelMarks = new Set<string>()
  /**
   * NF-1：登出時被丟掉的工作 stem → 它所屬帳號的 ledger owner（只在記憶體）。之後同一個帳號登入時 status 回 idle／SESSION_ENDED；
   * 這個 stem 再排成工作、或使用者取消時清掉（已落地的 status 先回 done，不看這裡）。
   */
  private readonly sessionEnded = new Map<string, string>()
  private readonly lanes: { interactive: Job | null; batch: Job | null } = { interactive: null, batch: null }
  private readonly running = new Set<Promise<void>>()
  private live: LiveSession | null = null
  /** 電腦版 myMid 的快取（只給接納用，ACCOUNT_CHECK_TTL_MS；送出前一律重讀，review-x6 F-4）。讀不到不快取。 */
  private localMid: { mid: string; at: number } | null = null
  /**
   * 服務層級的帳號暫停（review-x67 L-1）：送出前讀不到電腦版帳號 → 整個服務到 until 之前都不再讀帳號（接納也一樣，直接當作讀不到），
   * 排隊中的工作（單格、批次、接收）在 holdOf 一起等；until 到了只由下一個要送出的工作讀一次。讀到帳號才解除。
   */
  private accountHold: { until: number } | null = null
  /** 這段帳號暫停已經寫過 ACCOUNT_UNVERIFIED（一段暫停只寫一行；讀到帳號後歸零）。 */
  private accountHoldLogged = false
  /** 正在讀的電腦版帳號（同時要讀的呼叫共用這一次，不會兩條車道各開一次 snapshot）。 */
  private accountRead: Promise<string | null> | null = null
  /** 401 暫停：sessionId → 結束時間（review-x6 F-3：每個 session 各一筆，不會互相覆寫）。 */
  private readonly authPauses = new Map<string, number>()
  private globalPause: { reason: 'rate_limited' | 'hourly_limit' | 'disk_low'; until: number } | null = null
  /** 429 全域暫停的結束時間（寫進節制檔；globalPause 被更長的 hourly／disk 暫停蓋過時也不會遺失）。 */
  private rateLimitedUntil = 0
  private readonly throttle: ThrottleStore
  private readonly throttleLoaded: Promise<void>
  private batch: Batch | null = null
  private pumpTimer: ReturnType<typeof setTimeout> | null = null
  private pumpAt = 0
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private lastFlushAt = 0
  private flushFailures = 0
  private dirty = false
  private disposed = false
  private readonly offSession: () => void
  private readonly hooked = new WeakSet<object>()
  private idleWaiters: Array<() => void> = []
  /** 最近的 X3 回寫（OUTBOUND_ID_MISMATCH 偵測；只在記憶體，最多 OUTBOUND_RECENT_MAX 筆）。 */
  private recentOutbound: Array<{ chatId: string; bytes: number; stem: string; at: number }> = []
  /** 觀測（測試與 backend.info 用）：只有計數。 */
  readonly counters = { requests: 0, flushes: 0, locatorDesktopReads: 0, localImageHits: 0, evicted: 0, runs: 0, outboundMismatch: 0, preemptions: 0 }

  constructor(options: OriginalDownloadOptions) {
    this.opts = options
    this.limits = Object.freeze({ ...ORIGINALS_LIMITS, receiveRequestsPerHour: ORIGINALS_RECEIVE_REQUESTS_PER_HOUR, ...options.limits })
    this.now = options.now ?? Date.now
    this.sink = sharedMediaSink(options.dataDir)
    const shared = sharedMediaLedger(options.dataDir, { now: this.now, log: (line) => this.log(`originals_ledger ${line}`) })
    this.ledger = shared.ledger
    this.ledgerLoaded = shared.loaded
    this.limiter = options.limiter ?? sharedObsLimiter
    this.throttle = new ThrottleStore(options.dataDir, (line) => this.log(`originals_throttle ${line}`))
    this.budget = new RequestBudget(this.limits, this.now, () => this.saveThrottle())
    this.baseFetch = options.fetch ?? createLineJsMediaFetch()
    this.throttleLoaded = this.loadThrottle()
    this.offSession = options.session.onSessionChange((sessionId) => this.onSessionChange(sessionId))
  }

  private log(line: string) { try { this.opts.log?.(line) } catch { /* logging never breaks a download */ } }

  // ── throttle state（F-6） ──

  /** 重啟後放回每小時的時間戳與 429 暫停；ledger 裡 rate_limited 的 nextAt 也推回全域暫停（就算節制檔不見了）。 */
  private async loadThrottle(): Promise<void> {
    try {
      const state = await this.throttle.load(this.now(), this.limits.requestWindowMs)
      this.budget.restore(state.times, state.receiveTimes)
      if (state.rateLimitedUntil > this.now()) this.restoreRatePause(state.rateLimitedUntil)
    } catch { /* starts empty */ }
    if (await this.ledgerUsable()) {
      let ledgerUntil = 0
      for (const e of this.ledger.entries.values()) if (e.state === 'paused' && e.class === 'rate_limited' && typeof e.nextAt === 'number' && e.nextAt > ledgerUntil) ledgerUntil = e.nextAt
      if (ledgerUntil > this.now()) this.restoreRatePause(ledgerUntil)
    }
    if (this.budget.exhausted()) this.extendPause('hourly_limit', this.budget.nextFreeAt())
  }

  private saveThrottle(): Promise<void> {
    const now = this.now()
    return this.throttle.save({ ...this.budget.snapshot(), rateLimitedUntil: this.rateLimitedUntil > now ? this.rateLimitedUntil : 0 })
      .catch((error) => { this.log(`originals_throttle code=THROTTLE_WRITE_FAILED_${safeCode((error as { code?: unknown } | null)?.code)}`) })
  }

  /** 全域暫停延長到 until（較短的不會蓋掉較長的）。回傳是否有延長。 */
  private extendPause(reason: 'rate_limited' | 'hourly_limit' | 'disk_low', until: number): boolean {
    if (this.globalPause && this.globalPause.until >= until) return false
    this.globalPause = { reason, until }
    this.schedulePump(until - this.now())
    return true
  }

  /** 從持久化狀態（節制檔、ledger 的 nextAt）推回 429 暫停：本服務與 X1 共用限流都暫停到那時候。 */
  private restoreRatePause(until: number) {
    const now = this.now()
    const capped = Math.min(until, now + THROTTLE_PAUSE_MAX_MS)
    if (capped <= now) return
    if (capped > this.rateLimitedUntil) this.rateLimitedUntil = capped
    this.extendPause('rate_limited', capped)
    this.limiter.pauseRateLimited(capped - now)
  }

  // ── session ──

  private onSessionChange(sessionId: string | null) {
    if (this.disposed) return
    if (!sessionId) {
      // logout (F-3／F-5): no account is current any more — queued work goes back to idle, running work is aborted (its part is kept)
      this.live = null
      this.authPauses.clear()
      // review-x5 F-3: the account hold belonged to the session that is gone — the next login reads the desktop account at once
      this.accountHold = null
      this.accountHoldLogged = false
      for (const job of [...this.jobs.values()]) {
        // NF-1: remembered so that receive hands it again once the same account is back (a user's cancel is not a logout;
        // RF2-1: a job the user already cancelled stays cancelled even if it is still unwinding when the logout comes)
        if (!job.cancelled) this.noteSessionEnded(job.stem, job.session.owner)
        this.cancelJob(job)
      }
      return
    }
    // the client is installed when this fires, so outboundSession() answers from memory (no restore, no network)
    void this.opts.session.outboundSession().then((s) => { if (s && s.sessionId === sessionId) this.noteLive(s) }, () => {})
  }

  private noteLive(s: LineJsOutboundSession): LiveSession {
    const live: LiveSession = { ...s, owner: ledgerOwner(s.ownerMid) }
    const changed = this.live?.sessionId !== live.sessionId
    this.live = live
    // token refresh (LINEJS emits update:authtoken): lift the 401 pause of this session (L-3)
    const base = s.client?.base
    if (base && typeof base === 'object' && typeof base.on === 'function' && !this.hooked.has(base)) {
      this.hooked.add(base)
      try { base.on('update:authtoken', () => this.resumeAuth(live.sessionId)) } catch { /* an emitter that refuses the listener only loses the early resume */ }
    }
    if (changed) {
      // a new session is exactly when the accounts must be compared again: the admission cache of the desktop account is dropped
      this.localMid = null
      // review-x5 F-3: so is the account hold of the previous session (its next hold writes its own ACCOUNT_UNVERIFIED line)
      this.accountHold = null
      this.accountHoldLogged = false
      // the pauses of sessions that are gone hold nothing any more: their work follows this session or is cancelled below
      for (const sid of [...this.authPauses.keys()]) if (sid !== live.sessionId) this.authPauses.delete(sid)
      for (const job of [...this.jobs.values()]) {
        // another account's work (F-3): back to idle; a running one is aborted and keeps its part
        if (job.session.owner !== live.owner) this.cancelJob(job)
        // parked work of the same account follows the new session (its account check runs again before it is sent)
        else if (job.state === 'queued' && job.session.sessionId !== live.sessionId) job.session = live
      }
      this.schedulePump(0)
    }
    return live
  }

  /** NF-1：記下登出時被丟掉的工作（最多 SESSION_ENDED_MAX 個，超過丟最舊的）。 */
  private noteSessionEnded(stem: string, owner: string) {
    this.sessionEnded.delete(stem)
    this.sessionEnded.set(stem, owner)
    while (this.sessionEnded.size > SESSION_ENDED_MAX) {
      const oldest = this.sessionEnded.keys().next().value
      if (oldest === undefined) break
      this.sessionEnded.delete(oldest)
    }
  }

  private resumeAuth(sessionId: string) {
    this.limiter.resumeAuth(sessionId)
    this.authPauses.delete(sessionId)
    this.schedulePump(0)
  }

  /**
   * 電腦版 myMid。接納（fresh=false）用 ACCOUNT_CHECK_TTL_MS 的快取（批次 50 格不必開 50 次電腦版 snapshot）；
   * 送出前（fresh=true）一律重讀（review-x6 F-4）。讀不到 → null，而且清掉快取（fail-closed）。
   * L-1：帳號暫停期間不讀（回 null）；同時要讀的呼叫共用同一次讀取。讀到帳號就解除帳號暫停。
   * review-x5 Info：共用的讀取最多等 ACCOUNT_READ_TIMEOUT_MS，逾時當作讀不到（null）。
   */
  private async desktopMid(fresh: boolean): Promise<string | null> {
    if (!fresh && this.localMid && this.now() - this.localMid.at < ACCOUNT_CHECK_TTL_MS) return this.localMid.mid
    if (this.accountHold && this.now() < this.accountHold.until) return null
    if (!this.accountRead) {
      const read = (async () => {
        let value: unknown = null
        let timer: ReturnType<typeof setTimeout> | null = null
        const timeout = new Promise<null>((resolve) => {
          timer = setTimeout(() => { this.log('originals_account code=ACCOUNT_READ_TIMEOUT'); resolve(null) }, this.opts.accountReadTimeoutMs ?? ACCOUNT_READ_TIMEOUT_MS)
          timer.unref?.()
        })
        try { value = await Promise.race([this.opts.localAccountMid(), timeout]) } catch { value = null } finally { if (timer) clearTimeout(timer) }
        return typeof value === 'string' && value ? value : null
      })()
      this.accountRead = read
      void read.then(() => { if (this.accountRead === read) this.accountRead = null })
    }
    const mid = await this.accountRead
    if (!mid) { this.localMid = null; return null }
    this.localMid = { mid, at: this.now() }
    if (this.accountHold || this.accountHoldLogged) {
      this.accountHold = null
      this.accountHoldLogged = false
      this.schedulePump(0)
    }
    return mid
  }

  /** 帳號一致（fail-closed）：電腦版 myMid 必須等於 LINEJS profile.mid。 */
  private async accountOk(s: LiveSession, fresh: boolean): Promise<'ok' | 'mismatch' | 'unverified'> {
    const local = await this.desktopMid(fresh)
    if (!local) return 'unverified'
    return local === s.ownerMid ? 'ok' : 'mismatch'
  }

  // ── local gates ──

  private db(): MediaDb | null { try { return this.opts.getDb() } catch { return null } }

  private appRow(msgId: string): OriginalsAppRow | null | 'unavailable' {
    const db = this.db()
    if (!db) return 'unavailable'
    try { return (db.prepare(APP_ROW_SQL).get(msgId) as OriginalsAppRow | undefined) ?? null } catch { return 'unavailable' }
  }

  private chat(chatId: string): { name: string | null } | null {
    const db = this.db()
    if (!db) return null
    try { const r = db.prepare(CHAT_SQL).get(chatId) as { name?: unknown } | undefined; return r ? { name: typeof r.name === 'string' ? r.name : null } : null } catch { return null }
  }

  /** 不連網就能判斷的守門（msgId 格式、app DB 那一列、未收回、ct、chatId）。 */
  private gate(msgId: unknown): Gate {
    const id = String(msgId ?? '')
    const view = (state: OriginalState, code: string): Gate => ({ ok: false, view: { msgId: id, state, code } })
    if (id.startsWith('d:')) return view('unsupported', 'MESSAGE_ID_UNSUPPORTED')
    const m = MSG_ID.exec(id)
    if (!m) return view('unsupported', 'MESSAGE_ID_INVALID')
    const row = this.appRow(id)
    if (row === 'unavailable') return view('idle', 'APP_DB_UNAVAILABLE')
    if (!row) return view('unsupported', 'NOT_FOUND')
    if (row.unsent) return view('unsupported', 'UNSENT')
    const kind = KIND_BY_CT[Number(row.content_type)]
    if (!kind) return view('unsupported', 'CONTENT_TYPE_UNSUPPORTED')
    if (typeof row.chat_id !== 'string' || !CHAT_ID.test(row.chat_id)) return view('unsupported', 'CHAT_UNSUPPORTED')
    return { ok: true, msgId: id, messageId: m[1], stem: mediaCacheStem(id), kind, row }
  }

  // ── resolveLocator（HD §6.2） ──

  /**
   * app DB 那一列 → locator；影片（app DB 不存任何媒體欄位）或缺 OID／SID 時讀電腦版那一列（同聊天室、同時間，再以 _id 比對）。
   * 電腦版讀到的 keyMaterial 只在記憶體，不回寫 app DB。讀取耗時寫進 trace（`originals_locator`），超過 200 ms 記 LOCATOR_SLOW。
   */
  private async resolveLocator(g: Extract<Gate, { ok: true }>, origin: MediaOrigin): Promise<{ locator: MediaLocator; fingerprint: string } | { problem: { state: OriginalState; code: string } }> {
    const row = g.row
    let key = nonEmpty(row.key_material)
    let size = toSize(row.file_size)
    let oid = nonEmpty(row.media_oid)
    let sid = nonEmpty(row.media_sid)
    let fileName = nonEmpty(row.orig_filename)
    const needDesktop = g.kind === 'VIDEO' || !sid || (key !== null && !oid)
    if (needDesktop) {
      if (!this.opts.desktopRows) return { problem: { state: 'unsupported', code: 'LOCATOR_INCOMPLETE' } }
      const t0 = performance.now()
      let rows: OriginalsDesktopRow[] | null = null
      try { rows = await this.opts.desktopRows(row.chat_id, Number(row.ts)) } catch { rows = null }
      const ms = Math.round(performance.now() - t0)
      this.counters.locatorDesktopReads++
      try { this.opts.trace?.('originals_locator', ms) } catch { /* trace never breaks a download */ }
      this.log(`originals_locator source=desktop ms=${ms}${ms > LOCATOR_SLOW_MS ? ' code=LOCATOR_SLOW' : ''}`)
      const hit = (rows ?? []).find((r) => String(normalizeMsgId(r?._id)) === g.messageId)
      if (!hit) return { problem: { state: 'unsupported', code: 'LOCATOR_INCOMPLETE' } }
      const meta = parseObject(hit._contentMetadata)
      const info = parseObject(hit._contentInfo)
      oid = nonEmpty(meta?.OID) ?? oid
      sid = nonEmpty(meta?.SID) ?? sid
      key = nonEmpty(info?.keyMaterial) ?? key
      size = toSize(meta?.FILE_SIZE) ?? size
      if (g.kind === 'FILE') fileName = nonEmpty(info?.fileName) ?? fileName
    }
    const fingerprint = ledgerFingerprint(oid ?? '', sid ?? '')
    const e2eeSid = sid !== null && /^em[ivf]$/.test(sid)
    let transport: MediaLocator['transport']
    if (e2eeSid) transport = 'e2ee'
    else if (key !== null) return { problem: { state: 'unsupported', code: sid ? 'SID_UNSUPPORTED' : 'LOCATOR_INCOMPLETE' } }
    else transport = 'plain'
    const locator: MediaLocator = {
      stem: g.stem, kind: g.kind, messageId: g.messageId, chatId: row.chat_id, transport, origin,
      ...(transport === 'e2ee' ? { sid: sid as string, oid: oid ?? undefined, keyMaterial: key ?? undefined } : {}),
      ...(size !== null ? { declaredBytes: size } : {}),
      ...(fileName ? { fileName } : {}),
    }
    const problem = locatorProblem(locator)
    if (problem) return { problem: { state: problem.class === 'undecryptable' ? 'undecryptable' : 'unsupported', code: problem.code } }
    return { locator, fingerprint }
  }

  // ── public API ──

  /** 單格「下載原檔」（使用者動作，優先順序 user）。回這一格目前的狀態；畫面之後以 status 輪詢。 */
  async request(msgId: unknown): Promise<OriginalItemView> {
    return this.admit(msgId, { origin: 'history', priority: 'user', batchId: null, manual: true })
  }

  /** 接收端（X2b）呼叫：自動來源，不處理已用完重試次數或失敗的格子；沒有 session 就不排（見 enqueueDetailed）。 */
  async enqueue(msgIds: unknown[], options: { origin: 'receive' }): Promise<{ queued: number; skipped: number }> {
    const { queued, skipped } = await this.enqueueDetailed(msgIds, options)
    return { queued, skipped }
  }

  /**
   * enqueue 的同一條路徑，多回每一格接納後的狀態：接收端（X2b，linejsReceive.ts：電腦版訊息落庫後）依它決定這一列「已交出」「已有結果」
   * 或「稍後再交」。優先順序 receive；守門、每小時上限、429 暫停、共用限流都和單格、批次相同（review-x1 I-6）。
   */
  async enqueueDetailed(msgIds: unknown[], options: { origin: 'receive' }): Promise<{ queued: number; skipped: number; items: OriginalItemView[] }> {
    if (options?.origin !== 'receive' || !Array.isArray(msgIds)) throw coded('INVALID_ARGS')
    let queued = 0
    let skipped = 0
    const items: OriginalItemView[] = []
    for (const id of msgIds.slice(0, this.limits.statusMax)) {
      const v = await this.admit(id, { origin: 'receive', priority: 'receive', batchId: null, manual: false, quiet: true })
      items.push(v)
      if (v.state === 'queued' || v.state === 'running') queued++; else skipped++
    }
    return { queued, skipped, items }
  }

  /**
   * X3（implementation-plan.md §4）：Pro 輸入列送出成功的照片／檔案，位元組還在記憶體 → 共用的 sink（origin outbound；不重新下載）＋ ledger v2。
   *   - stem = mediaCacheStem('i:' + SDK 回的訊息 id)：與電腦版落庫後那一列的 msg_id 相同（P0 R1 的前提），X2b 收到那一列時 X6 的
   *     sink.existing 短路成 done（0 次請求）；兩邊同時進行時由 sink 的 stem 鎖＋不覆寫的 link 落地保證只落地一次。
   *   - 訊息 id 不是數字（不是 LINE 的訊息 id）→ 不寫，記 code=OUTBOUND_ID_INVALID。錯誤只記 code，永遠不 throw（送出結果早已定了）。
   */
  async saveOutbound(sent: { messageId: string; kind: 'image' | 'file'; chatId: string; ownerMid: string; body: Uint8Array; mime: string; filename: string }): Promise<SinkResult | null> {
    const kind: MediaKind | null = sent?.kind === 'image' ? 'IMAGE' : sent?.kind === 'file' ? 'FILE' : null
    try {
      if (this.disposed || !kind) return null
      const id = String(sent.messageId ?? '')
      if (!/^\d{1,32}$/.test(id)) { this.log(`originals_outbound kind=${kind} code=OUTBOUND_ID_INVALID`); return null }
      if (typeof sent.chatId !== 'string' || !CHAT_ID.test(sent.chatId) || typeof sent.ownerMid !== 'string' || !sent.ownerMid) { this.log(`originals_outbound kind=${kind} code=OUTBOUND_TARGET_INVALID`); return null }
      const stem = mediaCacheStem(`i:${id}`)
      const chat = this.chat(sent.chatId)
      const spec: SinkSpec = { stem, kind, origin: 'outbound', chatId: sent.chatId, ...(chat?.name ? { chatName: chat.name } : {}), ...(kind === 'FILE' && sent.filename ? { fileName: sent.filename } : {}), sentAt: this.now() }
      const saved = await this.sink.saveBytes(spec, sent.body, sent.mime)
      await this.recordExternal(ledgerOwner(sent.ownerMid), stem, kind, 'outbound', { status: 'done', bytes: saved.bytes, mime: saved.mime })
      this.rememberOutbound(sent.chatId, sent.body.length, stem)
      this.log(`originals_outbound kind=${kind} state=${saved.status}`)
      return saved
    } catch (error) {
      this.log(`originals_outbound kind=${kind ?? '-'} code=${safeCode((error as { code?: unknown } | null)?.code)}`)
      return null
    }
  }

  private rememberOutbound(chatId: string, bytes: number, stem: string) {
    const now = this.now()
    this.recentOutbound = this.recentOutbound.filter((e) => now - e.at <= OUTBOUND_MATCH_WINDOW_MS)
    this.recentOutbound.push({ chatId, bytes, stem, at: now })
    if (this.recentOutbound.length > OUTBOUND_RECENT_MAX) this.recentOutbound.splice(0, this.recentOutbound.length - OUTBOUND_RECENT_MAX)
  }

  /**
   * OUTBOUND_ID_MISMATCH 偵測（review-x2b；P0 R1 的前提是「SDK 回的 id ＝ 電腦版落庫後那一列的 msg_id」）：接收端掃到自己傳出的照片／檔案列時
   * 呼叫。同一聊天室、大小相同、訊息時間與 X3 回寫相差 OUTBOUND_MATCH_WINDOW_MS 之內的回寫：stem 相同 → 一致（忘掉那一筆）；只有 stem
   * 不同的 → 記一筆只含 code 的 log（同一筆回寫只記一次）。只比對記憶體，不送請求、不動 ledger 或檔案；永遠不 throw。
   */
  noteOutboundRow(row: { msgId: string; chatId: string; size: number | null; ts: number }): void {
    try {
      if (!this.recentOutbound.length || typeof row?.size !== 'number' || row.size <= 0 || !MSG_ID.test(String(row.msgId ?? ''))) return
      const now = this.now()
      this.recentOutbound = this.recentOutbound.filter((e) => now - e.at <= OUTBOUND_MATCH_WINDOW_MS)
      const near = this.recentOutbound.filter((e) => e.chatId === row.chatId && e.bytes === row.size && Math.abs(e.at - row.ts) <= OUTBOUND_MATCH_WINDOW_MS)
      if (!near.length) return
      const stem = mediaCacheStem(row.msgId)
      const same = near.find((e) => e.stem === stem)
      this.recentOutbound = this.recentOutbound.filter((e) => e !== (same ?? near[0]))
      if (same) return
      this.counters.outboundMismatch++
      this.log('originals_outbound code=OUTBOUND_ID_MISMATCH')
    } catch { /* detection only */ }
  }

  /**
   * X3／X4：sink 之外的寫入者（outbound 回寫、回填）把結果記進共用的 ledger v2（與下載同一個 MediaLedger、同一個節流 flush）。
   *   - ledger 載入失敗（較新的格式、I/O 錯誤）→ 不寫，回 false（永遠不蓋掉它）。
   *   - 冪等：已經是同樣的結果（done，或同一個失敗碼）→ 不動、不排 flush，回 false。
   *   - v1 匯入的標記（state done、code V1_COMPLETED：舊的 `.teamuq` 檔還沒進 media-saved）不是真的 v2 寫入：回填（backfill）接手時
   *     origin 改成 backfill；其餘情況第一個 origin 留在紀錄上（MediaLedger.begin 的規則）。
   */
  async recordExternal(owner: string, stem: string, kind: MediaKind, origin: 'outbound' | 'backfill', outcome: { status: 'done'; bytes: number; mime: string } | { status: 'failed'; class: string; code: string }): Promise<boolean> {
    if (!(await this.ledgerUsable())) return false
    const entry = this.ledger.get(owner, stem)
    const v1Marker = entry?.state === 'done' && entry.code === 'V1_COMPLETED'
    if (entry && !v1Marker && (outcome.status === 'done' ? entry.state === 'done' : entry.state === 'failed' && entry.code === outcome.code)) return false
    if (entry && v1Marker && origin === 'backfill') this.ledger.put({ ...entry, origin: 'backfill' })
    this.ledger.begin(owner, stem, { origin, kind })
    this.ledger.record(owner, stem, outcome)
    this.enforceTotalCap()
    this.afterLedgerChange()
    return true
  }

  /**
   * 接收關閉（X2b）：只取消接收自動排的工作——使用者按過的（manual）與批次認領的（batchId）不動。排隊中的回到 idle，進行中的被中止（part 保留）。
   */
  cancelReceive(): number {
    let cancelled = 0
    for (const job of [...this.jobs.values()]) if (job.origin === 'receive' && !job.manual && !job.batchId) { this.cancelJob(job); cancelled++ }
    if (cancelled) this.log(`originals_receive state=cancelled count=${cancelled}`)
    return cancelled
  }

  /** 批次（Manager 裁決：照片、影片、檔案都可以）：最多 batchMax 格，全域同時只有一個批次。 */
  async batchStart(chatId: unknown, msgIds: unknown): Promise<OriginalBatchStartView | { error: 'BATCH_ACTIVE'; batchId: string } | { error: 'INVALID_ARGS' }> {
    if (typeof chatId !== 'string' || !CHAT_ID.test(chatId) || !Array.isArray(msgIds)) return { error: 'INVALID_ARGS' }
    if (this.batch?.state === 'running') return { error: 'BATCH_ACTIVE', batchId: this.batch.id }
    const unique = [...new Set(msgIds.filter((x): x is string => typeof x === 'string'))]
    const taken = unique.slice(0, this.limits.batchMax)
    // the batch exists (and is running) from here on: a second batchStart is refused, and it is not finished before the admission ends (F-2)
    const batch: Batch = { id: randomUUID(), chatId, open: new Set(), admitting: true, total: 0, done: 0, failed: 0, expired: 0, state: 'running' }
    this.batch = batch
    const accepted: string[] = []
    const skipped: OriginalBatchStartView['skipped'] = []
    for (const id of taken) {
      if (batch.state !== 'running') { skipped.push({ msgId: id, state: 'idle', code: 'BATCH_CANCELLED' }); continue }
      const g = this.gate(id)
      if (g.ok && g.row.chat_id !== chatId) { skipped.push({ msgId: id, state: 'unsupported', code: 'CHAT_MISMATCH' }); continue }
      const v = await this.admit(id, { origin: 'history', priority: 'batch', batchId: batch.id, manual: false })
      if (batch.state !== 'running') {
        // batchCancel arrived while this one was being admitted: what it queued for the batch is cancelled too (a user's own click stays)
        const job = g.ok ? this.jobs.get(g.stem) : undefined
        if (job && job.batchId === batch.id && !job.manual) this.cancelJob(job)
        skipped.push({ msgId: id, state: 'idle', code: 'BATCH_CANCELLED' })
        continue
      }
      if (v.state === 'queued' || v.state === 'running' || v.state === 'paused') { accepted.push(id); batch.open.add(mediaCacheStem(id)) }
      else skipped.push({ msgId: id, state: v.state, ...(v.code ? { code: v.code } : {}) })
    }
    batch.admitting = false
    batch.total = accepted.length
    this.log(`originals_batch state=started total=${batch.total} skipped=${skipped.length} truncated=${unique.length - taken.length}`)
    this.finishBatchIfDone()
    return { batchId: batch.id, accepted, skipped, truncated: unique.length - taken.length }
  }

  /** 取消批次：排隊中的回到 idle；進行中的被中止（part 保留給續傳）。使用者自己按下的單格不取消（I-5）。接納途中也可以取消（F-2）。 */
  async batchCancel(batchId: unknown): Promise<{ cancelled: number }> {
    const batch = this.batch
    if (!batch || typeof batchId !== 'string' || batch.id !== batchId || batch.state !== 'running') return { cancelled: 0 }
    let cancelled = 0
    for (const job of [...this.jobs.values()]) if (job.batchId === batchId && !job.manual) { this.cancelJob(job); cancelled++ }
    batch.state = 'cancelled'
    this.log(`originals_batch state=cancelled cancelled=${cancelled}`)
    return { cancelled }
  }

  /** 取消一格：排隊中的回到 idle；進行中的被中止（part 保留）；還在接納中的不會被排進去（N-1）。 */
  async cancel(msgId: unknown): Promise<OriginalItemView> {
    const id = String(msgId ?? '')
    if (!MSG_ID.test(id)) return { msgId: id, state: 'unsupported', code: 'MESSAGE_ID_INVALID' }
    const stem = mediaCacheStem(id)
    // NF-1: the user's cancel closes it for receive too (also one that a logout had dropped)
    this.sessionEnded.delete(stem)
    const job = this.jobs.get(stem)
    if (job) this.cancelJob(job)
    else if (this.admitting.has(stem)) this.cancelMarks.add(stem)
    return (await this.statusOne(id))
  }

  /** 只讀本地（ledger、檔案系統、app DB、記憶體）；永遠不呼叫 LINE。 */
  async status(msgIds: unknown): Promise<OriginalStatusView> {
    if (!Array.isArray(msgIds) || msgIds.length > this.limits.statusMax) throw coded('INVALID_ARGS')
    await this.ledgerLoaded.catch(() => {})
    await this.throttleLoaded
    const items: OriginalItemView[] = []
    for (const id of msgIds) items.push(await this.statusOne(String(id ?? '')))
    return { items, batch: this.batchView(), paused: this.pausedView() }
  }

  // ── admission ──

  private async admit(msgId: unknown, how: AdmitHow): Promise<OriginalItemView> {
    const id = String(msgId ?? '')
    if (this.disposed) return { msgId: id, state: 'idle', code: 'SERVICE_STOPPED' }
    if (!MSG_ID.test(id)) return this.admitFresh(id, how)
    // 1. single-flight (F-1): a job of this stem, or an admission of it in progress on either lane, is joined — never a second Job.
    //    The placeholder is set synchronously (no await between the lookup and the set), so no interleaving can slip past it.
    const stem = mediaCacheStem(id)
    for (;;) {
      const job = this.jobs.get(stem)
      if (job) return this.joinJob(job, how)
      const pending = this.admitting.get(stem)
      if (!pending) break
      await pending.catch(() => null)
      if (this.disposed) return { msgId: id, state: 'idle', code: 'SERVICE_STOPPED' }
    }
    const admission = this.admitFresh(id, how)
    this.admitting.set(stem, admission)
    try { return await admission } finally {
      if (this.admitting.get(stem) === admission) { this.admitting.delete(stem); this.cancelMarks.delete(stem) }
    }
  }

  /** 合併到既有的工作：單格把它升成單格優先並標成使用者的工作；批次只認領不是使用者按下的工作（I-5）。 */
  private joinJob(job: Job, how: AdmitHow): OriginalItemView {
    if (how.priority === 'user') {
      if (job.priority !== 'user' && job.state === 'queued') job.priority = 'user'
      job.manual = true
    }
    if (how.batchId && !job.batchId && !job.manual) job.batchId = how.batchId
    this.schedulePump(0)
    return this.jobView(job)
  }

  private async admitFresh(id: string, how: AdmitHow): Promise<OriginalItemView> {
    // a ledger that could not be loaded (a newer format, an I/O error) is never written over: no downloads meanwhile
    if (!(await this.ledgerUsable())) return { msgId: id, state: 'idle', code: 'LEDGER_UNAVAILABLE' }
    await this.throttleLoaded
    // 2. local gates
    const g = this.gate(id)
    if (!g.ok) return g.view
    if (!this.chat(g.row.chat_id)) return { msgId: id, state: 'unsupported', code: 'CHAT_UNKNOWN' }
    // 3. already landed
    if (await this.sink.existing(g.stem, g.kind).catch(() => null)) return { msgId: id, state: 'done' }
    // 4. the accounts first (I-2): an unreadable desktop account, or an installed session of another account, never touches the
    //    session port (no restore, no token login); only then the session, compared once more
    const local = await this.desktopMid(false)
    if (!local) return { msgId: id, state: 'account_mismatch', code: 'ACCOUNT_UNVERIFIED' }
    const known = this.live
    if (known && known.ownerMid !== local && this.opts.session.isCurrentSession(known.sessionId, known.client)) return { msgId: id, state: 'account_mismatch', code: 'ACCOUNT_MISMATCH' }
    let s: LineJsOutboundSession | null = null
    try { s = await this.opts.session.outboundSession() } catch { s = null }
    if (!s) return { msgId: id, state: 'needs_login', code: 'SESSION_NOT_READY' }
    const live = this.noteLive(s)
    // a session that has just changed dropped the cache: the desktop account is read again before a mismatch is decided
    const confirmed = live.ownerMid === local ? local : await this.desktopMid(false)
    if (!confirmed) return { msgId: id, state: 'account_mismatch', code: 'ACCOUNT_UNVERIFIED' }
    if (live.ownerMid !== confirmed) return { msgId: id, state: 'account_mismatch', code: 'ACCOUNT_MISMATCH' }
    // 5. locator
    const resolved = await this.resolveLocator(g, how.origin)
    // 6. ledger terminals (fingerprint from the message's OID／SID: a changed object lifts expired / undecryptable)
    const fingerprint = 'fingerprint' in resolved ? resolved.fingerprint : undefined
    const entry = this.ledger.get(live.owner, g.stem, fingerprint !== undefined ? { fingerprint } : {})
    const blocked = this.blockedView(id, entry, live, how.manual)
    if (blocked) return blocked
    if ('problem' in resolved) {
      // undecryptable from local facts (an em* SID without keyMaterial) is a terminal worth remembering; unsupported is decided again each time
      if (resolved.problem.state === 'undecryptable') {
        this.ledger.begin(live.owner, g.stem, { origin: how.origin, kind: g.kind, fingerprint: fingerprint ?? ledgerFingerprint('', ''), sessionId: live.sessionId })
        this.ledger.record(live.owner, g.stem, { status: 'failed', class: 'undecryptable', code: resolved.problem.code }, { sessionId: live.sessionId })
        this.afterLedgerChange()
      }
      return { msgId: id, state: resolved.problem.state, code: resolved.problem.code }
    }
    const { locator } = resolved
    if (how.manual && entry && entry.state === 'failed' && (entry.attempts ?? 0) > 0) {
      // manual retry: the attempts start over (the cooldown was checked in blockedView)
      this.patchEntry(live.owner, g.stem, { attempts: 0, code: entry.code === RETRY_EXHAUSTED ? 'MANUAL_RETRY' : entry.code })
    }
    const chat = this.chat(g.row.chat_id)
    const spec: SinkSpec = { stem: g.stem, kind: g.kind, origin: how.origin, chatId: g.row.chat_id, ...(chat?.name ? { chatName: chat.name } : {}), ...(locator.fileName ? { fileName: locator.fileName } : {}), sentAt: Number(g.row.ts) }
    // I-4: begin always carries the fingerprint
    this.ledger.begin(live.owner, g.stem, { origin: how.origin, kind: g.kind, declaredBytes: locator.declaredBytes ?? null, fingerprint, sessionId: live.sessionId })
    this.enforceTotalCap()
    this.afterLedgerChange()
    // 7. a photo LINE has already cached: decrypt it locally, no OBS request
    if (g.kind === 'IMAGE' && locator.transport === 'e2ee' && typeof locator.keyMaterial === 'string' && locator.declaredBytes !== undefined && this.opts.localImage) {
      let local: { bytes: Uint8Array; mime: string } | null = null
      try { local = this.opts.localImage({ keyMaterial: locator.keyMaterial, fileSize: locator.declaredBytes }) } catch { local = null }
      if (local) {
        try {
          const saved = await this.sink.saveBytes(spec, local.bytes, local.mime)
          this.counters.localImageHits++
          this.ledger.record(live.owner, g.stem, { status: 'done', bytes: saved.bytes, mime: saved.mime })
          this.afterLedgerChange()
          this.log(`originals_job kind=${g.kind} origin=${how.origin} state=done code=LOCAL_CACHE`)
          return { msgId: id, state: 'done' }
        } catch (error) { this.log(`originals_local code=${safeCode((error as { code?: unknown })?.code)}`) }
      }
    }
    // 8. queue — only with the session that is still installed (a logout or an account switch may have happened during the awaits above)
    if (this.disposed) return { msgId: id, state: 'idle', code: 'SERVICE_STOPPED' }
    if (!this.opts.session.isCurrentSession(live.sessionId, live.client)) return { msgId: id, state: 'needs_login', code: 'SESSION_GONE' }
    // N-1: cancel() arrived while this stem was being admitted — it wins: no job, no request; the entry begun above is undone
    if (this.cancelMarks.delete(g.stem)) {
      this.forgetUnstarted(live.owner, g.stem)
      this.log(`originals_job kind=${g.kind} origin=${how.origin} state=idle code=ABORTED`)
      return { msgId: id, state: 'idle', code: 'ABORTED' }
    }
    const job: Job = {
      stem: g.stem, msgId: id, kind: g.kind, origin: how.origin, priority: how.priority, batchId: how.batchId, state: 'queued', readyAt: this.now(),
      session: live, locator, spec, fingerprint: fingerprint as string, controller: null, partPath: null, hourly: false, cancelled: false, manual: how.manual,
      preempted: false, preemptions: 0,
    }
    this.jobs.set(g.stem, job)
    this.sessionEnded.delete(g.stem)
    this.schedulePump(0)
    return this.jobView(job)
  }

  /** ledger 的本地短路（HD §5.3）：終態、同一 session 的 forbidden、unsupported、用完重試次數（只有手動、冷卻過後才放行）。 */
  private blockedView(msgId: string, entry: MediaLedgerEntry | null, live: LiveSession, manual: boolean): OriginalItemView | null {
    if (!entry) return null
    // F-6: a 429 the ledger remembers (nextAt still ahead, e.g. from before a restart) holds every request until then; the work is queued behind it
    if (entry.state === 'paused' && entry.class === 'rate_limited' && typeof entry.nextAt === 'number' && entry.nextAt > this.now()) { this.restoreRatePause(entry.nextAt); return null }
    if (ledgerBlocks(entry, { sessionId: live.sessionId })) return this.entryView(msgId, entry, live)
    if (entry.state !== 'failed') return null
    if (entry.class === 'unsupported') return { msgId, state: 'unsupported', code: entry.code ?? 'UNSUPPORTED' }
    if (entry.class === 'forbidden') return null // another session: allowed again
    // transient / SIZE_MISMATCH / other retryable failures
    const retryAt = (entry.updatedAt ?? 0) + this.limits.retryCooldownMs
    if (!manual) return entry.code === RETRY_EXHAUSTED || this.now() < retryAt ? this.entryView(msgId, entry, live) : null
    if (this.now() < retryAt) return this.entryView(msgId, entry, live)
    return null
  }

  // ── queue and runner ──

  private laneOf(job: Job): 'interactive' | 'batch' { return job.priority === 'batch' ? 'batch' : 'interactive' }

  /** 接收自動排、使用者沒有按過的工作（F-3 的子上限只算它們）。 */
  private autoReceive(job: Job): boolean { return job.priority === 'receive' && !job.manual }

  /** 這個工作現在被什麼擋住（全域暫停、同一 session 的 401 暫停、自動重試的等待）；可以開始回 null。 */
  private holdOf(job: Job): { reason: string; until: number } | null {
    const now = this.now()
    if (this.globalPause && now < this.globalPause.until) return { reason: this.globalPause.reason, until: this.globalPause.until }
    if (this.globalPause && now >= this.globalPause.until) this.globalPause = null
    // F-3: receive's own share of the hourly requests is used up — only receive's automatic jobs wait (a click or a batch goes on)
    if (this.autoReceive(job) && this.budget.receiveExhausted()) return { reason: 'hourly_limit', until: this.budget.receiveNextFreeAt() }
    const sid = job.session.sessionId
    const authUntil = this.authPauses.get(sid)
    if (authUntil !== undefined) {
      if (now < authUntil) return { reason: 'auth', until: authUntil }
      this.authPauses.delete(sid)
    }
    // L-1: the desktop account could not be read right before a send — every queued job waits for the service's next read
    // (shown like a retry wait: the cell stays queued, not account_mismatch)
    if (this.accountHold && now < this.accountHold.until) return { reason: 'retry_wait', until: Math.max(this.accountHold.until, job.readyAt) }
    if (job.readyAt > now) return { reason: 'retry_wait', until: job.readyAt }
    return null
  }

  private pick(lane: 'interactive' | 'batch'): Job | null {
    const rank = (p: ObsPriority) => (p === 'user' ? 0 : p === 'receive' ? 1 : 2)
    let best: Job | null = null
    for (const job of this.jobs.values()) {
      if (job.state !== 'queued' || this.laneOf(job) !== lane || this.holdOf(job)) continue
      if (!best || rank(job.priority) < rank(best.priority)) best = job
    }
    return best
  }

  private schedulePump(delay: number) {
    if (this.disposed) return
    const at = this.now() + Math.max(0, delay)
    if (this.pumpTimer && this.pumpAt <= at) return
    if (this.pumpTimer) clearTimeout(this.pumpTimer)
    this.pumpAt = at
    this.pumpTimer = setTimeout(() => { this.pumpTimer = null; this.pump() }, Math.max(0, delay))
    this.pumpTimer.unref?.()
  }

  /** 測試與計時器用：立刻看一次佇列。 */
  kick() { this.pump() }

  /** 接收自動排的影片／檔案（或宣告大小超過 PREEMPT_MIN_BYTES），而且還沒被搶先到上限：可以讓位給使用者的單格。 */
  private preemptible(job: Job): boolean {
    if (!this.autoReceive(job) || job.preemptions >= PREEMPT_MAX_PER_JOB) return false
    return job.kind === 'VIDEO' || job.kind === 'FILE' || (job.locator.declaredBytes ?? 0) > PREEMPT_MIN_BYTES
  }

  /**
   * 車道搶先：單格車道正在跑可讓位的接收工作，而且有一個現在就能開始的使用者單格在等 → 中止它（part 保留；run() 看到 preempted
   * 就把它放回排隊、不算 attempts）。車道空出後 pick 先拿使用者的單格。
   */
  private maybePreempt() {
    const cur = this.lanes.interactive
    if (!cur || cur.state !== 'running' || cur.cancelled || cur.preempted || !cur.controller || !this.preemptible(cur)) return
    let waiting = false
    for (const job of this.jobs.values()) {
      if (job.state === 'queued' && job.priority === 'user' && this.laneOf(job) === 'interactive' && !this.holdOf(job)) { waiting = true; break }
    }
    if (!waiting) return
    cur.preempted = true
    cur.preemptions++
    this.counters.preemptions++
    this.log(`originals_job kind=${cur.kind} origin=${cur.origin} state=preempted count=${cur.preemptions}`)
    cur.controller.abort()
  }

  /** 被搶先的工作回到排隊（原本的優先序；part 與 ledger 的 partName 保留給續傳）。 */
  private requeuePreempted(job: Job) {
    job.controller = null
    job.preempted = false
    job.state = 'queued'
    job.readyAt = this.now()
  }

  private pump() {
    if (this.disposed) return
    this.maybePreempt()
    for (const lane of ['interactive', 'batch'] as const) {
      if (this.lanes[lane]) continue
      const job = this.pick(lane)
      if (!job) continue
      this.lanes[lane] = job
      job.state = 'running'
      const run = this.run(job).catch((error) => { this.log(`originals_job state=error code=${safeCode((error as { code?: unknown })?.code)}`) }).finally(() => {
        this.lanes[lane] = null
        this.running.delete(run)
        this.pump()
      })
      this.running.add(run)
    }
    // the next time something held becomes runnable
    let next = Number.POSITIVE_INFINITY
    for (const job of this.jobs.values()) if (job.state === 'queued') { const hold = this.holdOf(job); if (hold && Number.isFinite(hold.until)) next = Math.min(next, hold.until) }
    if (Number.isFinite(next)) this.schedulePump(next - this.now())
    if (!this.jobs.size && !this.running.size) { const waiters = this.idleWaiters; this.idleWaiters = []; for (const w of waiters) w() }
  }

  /** 測試用：等到沒有排隊或進行中的工作（被暫停擋住的仍算排隊中，所以有暫停時不會 resolve）。 */
  whenIdle(): Promise<void> {
    if (!this.jobs.size && !this.running.size) return Promise.resolve()
    return new Promise((resolve) => { this.idleWaiters.push(resolve) })
  }

  /** 測試與觀測用的佇列快照（只有計數）。 */
  queueState() {
    let queued = 0, running = 0
    for (const job of this.jobs.values()) { if (job.state === 'running') running++; else queued++ }
    const now = this.now()
    return { queued, running, jobs: this.jobs.size, sent: this.budget.sent, authPaused: [...this.authPauses.values()].some((until) => until > now), globalPause: this.globalPause?.reason ?? null, receiveHourly: this.budget.receiveExhausted() }
  }

  private async run(job: Job): Promise<void> {
    const t0 = performance.now()
    const s = job.session
    const owner = s.owner
    const finish = (state: string, code?: string) => this.log(`originals_job kind=${job.kind} origin=${job.origin} state=${state}${code ? ` code=${code}` : ''} ms=${Math.round(performance.now() - t0)}`)
    // the controller exists from the start, so a cancel that arrives during the checks below aborts the stream before any request
    job.preempted = false
    job.controller = new AbortController()
    job.hourly = false
    this.counters.runs++
    if (job.cancelled) { this.dropJob(job); return }
    // the session the work was admitted with must still be the installed one, and its account still the desktop's
    if (!this.opts.session.isCurrentSession(s.sessionId, s.client)) { this.park(job, 'auth', 'SESSION_GONE'); finish('paused', 'SESSION_GONE'); return }
    // F-4: right before anything is sent the desktop account is read again (never the admission cache).
    // N-3: only a proven mismatch drops the work; an account that cannot be read right now (the snapshot is being replaced, LINE is
    // writing its DB) holds it and tries again later — nothing is sent meanwhile (still fail-closed)
    const account = await this.accountOk(s, true)
    if (job.cancelled) { this.dropJob(job); finish('idle', 'ABORTED'); return }
    // preempted before anything was sent: straight back to the queue (the account is read again at its next run)
    if (job.preempted) { this.requeuePreempted(job); finish('queued', 'PREEMPTED'); return }
    if (account === 'mismatch') { this.dropJob(job); finish('idle', 'ACCOUNT_MISMATCH'); return }
    // L-1: the hold is the service's (one log line per hold, written by holdUnverified), not this job's
    if (account !== 'ok') { this.holdUnverified(job); return }
    // N-1 (coordination): before a resume, a stem that has already landed is simply done
    const landed = await this.sink.existing(job.stem, job.kind).catch(() => null)
    if (landed) {
      this.ledger.record(owner, job.stem, { status: 'done', bytes: landed.bytes, mime: landed.mime })
      this.afterLedgerChange(); this.countBatch(job, 'done'); this.dropJob(job); finish('done', 'ALREADY_LANDED'); return
    }
    const entry = this.ledger.get(owner, job.stem)
    let target: LineJsSinkTarget
    try { target = await this.sink.targetFor(job.spec, entry?.partName ? { partName: entry.partName } : {}) } catch (error) {
      const e = error as { code?: unknown; class?: unknown } | null
      const code = safeCode(e?.code)
      if (e?.class === 'unsupported') {
        this.ledger.record(owner, job.stem, { status: 'failed', class: 'unsupported', code }, { sessionId: s.sessionId })
        this.afterLedgerChange(); this.countBatch(job, 'failed'); this.dropJob(job); finish('failed', code); return
      }
      this.ledger.record(owner, job.stem, { status: 'failed', class: 'transient', code }, { sessionId: s.sessionId })
      this.afterTransient(job, owner); finish('failed', code); return
    }
    job.partPath = target.partPath
    this.ledger.running(owner, job.stem, { partName: target.partName, sessionId: s.sessionId })
    this.afterLedgerChange()
    const fetch = async (request: Request) => {
      const taken = await this.budget.take(request.signal, this.autoReceive(job))
      if (taken !== 'ok') { job.hourly = taken; throw coded('ORIGINALS_HOURLY_LIMIT') }
      this.counters.requests++
      return this.baseFetch(request)
    }
    const backoff = this.opts.stream?.backoffMs ?? defaultBackoff
    const outcome: Outcome = await streamDownload(job.locator, { client: s.client, sessionId: s.sessionId, isCurrent: () => this.opts.session.isCurrentSession(s.sessionId, s.client) }, target, {
      ...this.opts.stream,
      signal: job.controller.signal,
      priority: job.priority,
      limiter: this.limiter,
      fetch,
      backoffMs: (attempt) => (job.hourly ? 0 : backoff(attempt)),
      log: (line) => this.log(line),
    })
    job.controller = null
    if (outcome.status === 'done') {
      this.ledger.record(owner, job.stem, outcome)
      this.afterLedgerChange(); this.countBatch(job, 'done'); this.dropJob(job); finish('done'); return
    }
    if (outcome.status === 'paused') {
      if (outcome.code === 'ABORTED' || job.cancelled) {
        if (job.preempted && !job.cancelled) {
          // preempted by a user click: back to the queue with its own priority; paused does not count an attempt; part and partName stay
          this.ledger.record(owner, job.stem, { status: 'paused', class: 'transient', code: 'PREEMPTED' })
          this.afterLedgerChange(); this.requeuePreempted(job); finish('queued', 'PREEMPTED'); return
        }
        // cancelled: back to idle; the part (and its name in the ledger) stays for a later resume
        this.ledger.record(owner, job.stem, { status: 'paused', class: 'transient', code: 'ABORTED' })
        this.afterLedgerChange(); this.dropJob(job); finish('idle', 'ABORTED'); return
      }
      this.ledger.record(owner, job.stem, outcome)
      this.afterLedgerChange()
      if (outcome.class === 'rate_limited') this.pauseAll('rate_limited', outcome.retryAfterMs ?? Math.max(this.limiter.state().pausedMs, 1000))
      else if (outcome.class === 'auth') this.park(job, 'auth', outcome.code)
      else if (outcome.class === 'disk_low') this.pauseAll('disk_low', this.limits.diskRetryMs)
      else this.park(job, 'retry', outcome.code)
      job.state = 'queued'
      finish('paused', outcome.code); return
    }
    // failed
    if (outcome.class === 'transient' && job.hourly) {
      // the hourly cap refused the request(s) locally: nothing reached LINE, so it is a pause, not an attempt
      this.ledger.record(owner, job.stem, { status: 'paused', class: 'rate_limited', code: 'HOURLY_LIMIT' })
      this.afterLedgerChange()
      if (job.hourly === 'receive' && !this.budget.exhausted()) {
        // F-3: only receive's share is used up — receive's jobs wait in holdOf; clicks and batches are not paused
        const ms = Math.max(0, this.budget.receiveNextFreeAt() - this.now())
        job.state = 'queued'
        this.log(`originals_pause reason=receive_hourly_limit ms=${Math.round(ms)}`)
        this.schedulePump(ms)
        finish('paused', 'RECEIVE_HOURLY_LIMIT'); return
      }
      this.pauseAll('hourly_limit', Math.max(0, this.budget.nextFreeAt() - this.now()))
      job.state = 'queued'
      finish('paused', 'HOURLY_LIMIT'); return
    }
    this.ledger.record(owner, job.stem, outcome, { sessionId: s.sessionId })
    if (outcome.class === 'transient') { this.afterTransient(job, owner); finish('failed', outcome.code); return }
    this.afterLedgerChange()
    this.countBatch(job, outcome.class === 'expired' ? 'expired' : 'failed')
    this.dropJob(job)
    finish('failed', outcome.code)
  }

  /**
   * 改一筆非終態紀錄的 attempts／code（MediaLedger 沒有公開的 put；這兩個欄位不影響「終態負面紀錄」的判定與計數，
   * 所以直接換掉 Map 裡的那一筆）。
   */
  private patchEntry(owner: string, stem: string, patch: { attempts?: number; code?: string | null; nextAt?: number | null }) {
    const key = this.ledger.key(owner, stem)
    const entry = this.ledger.entries.get(key)
    if (!entry || isTerminalNegative(entry)) return null
    const next: MediaLedgerEntry = { ...entry, ...patch, updatedAt: this.now() }
    this.ledger.entries.set(key, next)
    return next
  }

  /** transient 失敗之後：達到 attempts 上限 → RETRY_EXHAUSTED（不再自動重試）；否則等 autoRetryDelayMs 再排。 */
  private afterTransient(job: Job, owner: string) {
    if (job.cancelled) { this.afterLedgerChange(); this.dropJob(job); return }
    const entry = this.ledger.get(owner, job.stem)
    if (entry && (entry.attempts ?? 0) >= this.limits.maxAttempts) {
      this.patchEntry(owner, job.stem, { code: RETRY_EXHAUSTED, nextAt: null })
      this.afterLedgerChange()
      this.countBatch(job, 'failed')
      this.dropJob(job)
      return
    }
    this.afterLedgerChange()
    job.state = 'queued'
    job.readyAt = this.now() + this.limits.autoRetryDelayMs
    this.schedulePump(this.limits.autoRetryDelayMs)
  }

  private park(job: Job, reason: 'auth' | 'retry', _code: string) {
    if (job.cancelled) { this.dropJob(job); return }
    job.state = 'queued'
    if (reason === 'auth') {
      // F-3: one pause per session (never overwritten by another session's work); same time limit as the shared limiter's 401 pause
      // (L-3): one more try after it, or earlier on a session change / token refresh
      const sid = job.session.sessionId
      const until = this.authPauses.get(sid)
      if (until === undefined || until <= this.now()) this.authPauses.set(sid, this.now() + OBS_AUTH_PAUSE_MAX_MS)
      // the live session already moved on: the parked work follows it at once (same account; checked again before sending)
      if (this.live && this.live.sessionId !== sid && this.live.owner === job.session.owner) { job.session = this.live; this.schedulePump(0) }
      else this.schedulePump((this.authPauses.get(sid) ?? this.now()) - this.now())
    } else {
      job.readyAt = this.now() + this.limits.autoRetryDelayMs
      this.schedulePump(this.limits.autoRetryDelayMs)
    }
  }

  /**
   * N-3：送出前讀不到電腦版帳號 → 回到排隊（不算 attempts；讀到之前不送出）。
   * L-1：暫停是服務層級的——整個服務 ACCOUNT_RETRY_MS 之後才再讀一次帳號，其他排隊中的工作在 holdOf 一起等；
   * 一段暫停（直到讀到帳號）只寫一行 ACCOUNT_UNVERIFIED。
   */
  private holdUnverified(job: Job) {
    job.controller = null
    job.state = 'queued'
    const now = this.now()
    // a hold that ended long ago (nothing was waiting on it since) is over: this is a new hold, with its own log line
    if (this.accountHold && now - this.accountHold.until > ACCOUNT_RETRY_MS) this.accountHoldLogged = false
    if (!this.accountHold || this.accountHold.until <= now) this.accountHold = { until: now + ACCOUNT_RETRY_MS }
    if (!this.accountHoldLogged) {
      this.accountHoldLogged = true
      this.log(`originals_pause reason=account_unverified code=ACCOUNT_UNVERIFIED ms=${ACCOUNT_RETRY_MS}`)
    }
    this.schedulePump(this.accountHold.until - now)
  }

  private pauseAll(reason: 'rate_limited' | 'hourly_limit' | 'disk_low', ms: number) {
    const until = this.now() + Math.max(0, ms)
    this.extendPause(reason, until)
    // F-6: the end of a 429 pause is written to the throttle file (a restart does not lift it)
    if (reason === 'rate_limited' && until > this.rateLimitedUntil) { this.rateLimitedUntil = until; void this.saveThrottle() }
    this.log(`originals_pause reason=${reason} ms=${Math.round(ms)}`)
    this.schedulePump(ms)
  }

  private cancelJob(job: Job) {
    job.cancelled = true
    if (job.state === 'running') { job.controller?.abort(); return }
    this.forgetUnstarted(job.session.owner, job.stem)
    this.dropJob(job)
  }

  /** 排隊中（還沒開始）的工作回到 idle：從沒開始過的紀錄刪掉，有 part 的保留給之後續傳。 */
  private forgetUnstarted(owner: string, stem: string) {
    const entry = this.ledger.get(owner, stem)
    if (entry && entry.state === 'queued' && !entry.partName && (entry.attempts ?? 0) === 0) this.ledger.remove(owner, stem)
    else if (entry && entry.state !== 'failed') this.ledger.record(owner, stem, { status: 'paused', class: 'transient', code: 'ABORTED' })
    this.afterLedgerChange()
  }

  private dropJob(job: Job) {
    if (this.jobs.get(job.stem) === job) this.jobs.delete(job.stem)
    this.finishBatchIfDone()
    if (!this.jobs.size && !this.running.size) queueMicrotask(() => this.pump())
  }

  /** 批次的進度以 stem 計（每個 stem 只算一次），所以批次合併到的使用者單格也算進去（I-5）。 */
  private countBatch(job: Job, how: 'done' | 'failed' | 'expired') {
    const batch = this.batch
    if (!batch || !batch.open.delete(job.stem)) return
    batch[how]++
  }

  /** 接納結束、而且批次接納的 stem 都沒有工作了才算結束（F-2：接納途中先完成的格子不會讓它提早結束）。 */
  private finishBatchIfDone() {
    const batch = this.batch
    if (!batch || batch.state !== 'running' || batch.admitting) return
    for (const job of this.jobs.values()) if (batch.open.has(job.stem)) return
    batch.state = 'finished'
    this.log(`originals_batch state=finished total=${batch.total} done=${batch.done} failed=${batch.failed} expired=${batch.expired}`)
  }

  // ── ledger housekeeping ──

  /**
   * 總筆數上限（Manager 裁決）：先淘汰最舊的 done，再淘汰最舊的非終態、非進行中紀錄。回傳淘汰筆數。
   * 第二輪不淘汰帶 partName 的紀錄（它是續傳 part 的唯一指標）與 RETRY_EXHAUSTED（刪掉會讓「只能手動重試」失效，批次與接收會再自動抓），
   * review-x6 I-4。只剩這些時寧可超過上限（記一筆 code=CAP_EXCEEDED），也不改變它們的語意。
   */
  enforceTotalCap(): number {
    let over = this.ledger.entries.size - this.limits.ledgerTotalMax
    if (over <= 0) return 0
    let evicted = 0
    const active = new Set(this.jobs.keys())
    const keepsMeaning = (entry: MediaLedgerEntry) => Boolean(entry.partName) || entry.code === RETRY_EXHAUSTED
    for (const pass of ['done', 'other'] as const) {
      for (const entry of [...this.ledger.entries.values()]) {
        if (over <= 0) break
        if (active.has(entry.stem)) continue
        if (pass === 'done' ? entry.state !== 'done' : entry.state === 'done' || isTerminalNegative(entry) || keepsMeaning(entry)) continue
        this.ledger.remove(entry.owner, entry.stem)
        over--
        evicted++
      }
    }
    this.counters.evicted += evicted
    if (evicted) this.log(`originals_ledger code=EVICTED count=${evicted}`)
    if (over > 0) this.log(`originals_ledger code=CAP_EXCEEDED count=${over}`)
    return evicted
  }

  /** 寫檔節流：有變動才寫，最多每 ledgerFlushMinIntervalMs 一次（trailing）。 */
  private afterLedgerChange() {
    this.dirty = true
    if (this.disposed || this.flushTimer) return
    const wait = Math.max(0, this.lastFlushAt + this.limits.ledgerFlushMinIntervalMs - this.now())
    this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flushNow() }, wait)
    this.flushTimer.unref?.()
  }

  /**
   * 有變動就立刻寫一次 ledger（dispose 與測試用）。ledger 載入失敗（例如較新的版本）時永遠不寫，避免蓋掉它。
   * 寫失敗時以退避重新排一次（ledgerFlushMinIntervalMs × 2^失敗次數，上限 FLUSH_RETRY_MAX_MS；review-x6 I-6），不必等下一次變動。
   */
  async flushNow(): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null }
    if (!this.dirty || !(await this.ledgerUsable())) return
    this.dirty = false
    this.lastFlushAt = this.now()
    this.counters.flushes++
    try {
      await this.ledger.flush()
      this.flushFailures = 0
    } catch (error) {
      this.dirty = true
      this.flushFailures++
      this.log(`originals_ledger code=FLUSH_FAILED_${safeCode((error as { code?: unknown } | null)?.code)}`)
      if (!this.disposed && !this.flushTimer) {
        const wait = Math.min(FLUSH_RETRY_MAX_MS, Math.max(1, this.limits.ledgerFlushMinIntervalMs) * 2 ** Math.min(this.flushFailures, 16))
        this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flushNow() }, wait)
        this.flushTimer.unref?.()
      }
    }
  }

  private ledgerUsable(): Promise<boolean> { return this.ledgerLoaded.then(() => true, () => false) }

  /** 共用的 ledger 載入成功了沒（X4 回填：讀不到就不連、不清任何東西）。 */
  ledgerReady(): Promise<boolean> { return this.ledgerUsable() }

  // ── views ──

  private jobView(job: Job): OriginalItemView {
    const hold = job.state === 'queued' ? this.holdOf(job) : null
    const base: OriginalItemView = { msgId: job.msgId, state: job.state, ...(job.batchId ? { batchId: job.batchId } : {}), ...(job.locator.declaredBytes !== undefined ? { declaredBytes: job.locator.declaredBytes } : {}) }
    if (hold && hold.reason !== 'retry_wait') return { ...base, state: 'paused', code: hold.reason }
    if (hold) return { ...base, retryAt: hold.until }
    return base
  }

  private entryView(msgId: string, entry: MediaLedgerEntry, live: LiveSession | null): OriginalItemView {
    const code = entry.code ?? undefined
    if (entry.state === 'failed') {
      if (entry.class === 'expired') return { msgId, state: 'expired', ...(code ? { code } : {}) }
      if (isTerminalNegative(entry)) return { msgId, state: 'undecryptable', ...(code ? { code } : {}) }
      if (entry.class === 'forbidden') return live && entry.sessionId === live.sessionId ? { msgId, state: 'forbidden', ...(code ? { code } : {}) } : { msgId, state: 'idle' }
      if (entry.class === 'unsupported') return { msgId, state: 'unsupported', ...(code ? { code } : {}) }
      const retryAt = (entry.updatedAt ?? 0) + this.limits.retryCooldownMs
      return { msgId, state: entry.code === RETRY_EXHAUSTED ? 'failed_retry_exhausted' : 'failed', ...(code ? { code } : {}), retryAt }
    }
    return { msgId, state: 'idle' }
  }

  private async statusOne(id: string): Promise<OriginalItemView> {
    const g = this.gate(id)
    if (!g.ok) return g.view
    const job = this.jobs.get(g.stem)
    if (job) {
      const view = this.jobView(job)
      // progress of a video / file: the bytes the part already holds (a local stat)
      if (job.state === 'running' && job.partPath && job.kind !== 'IMAGE') {
        try { return { ...view, bytesDone: (await stat(job.partPath)).size } } catch { return view }
      }
      return view
    }
    if (await this.sink.existing(g.stem, g.kind).catch(() => null)) return { msgId: id, state: 'done' }
    const live = this.live
    if (!live) return { msgId: id, state: 'needs_login', code: 'SESSION_NOT_READY' }
    if (this.localMid && this.localMid.mid !== live.ownerMid) return { msgId: id, state: 'account_mismatch', code: 'ACCOUNT_MISMATCH' }
    // NF-1: dropped at a logout and the SAME account is logged in again → receive hands it again; another account → plain idle
    // (ADJ-X2BF-01: receive closes it, never re-hands it under the new account)
    if (this.sessionEnded.get(g.stem) === live.owner) return { msgId: id, state: 'idle', code: ORIGINALS_SESSION_ENDED }
    const oid = nonEmpty(g.row.media_oid)
    const sid = nonEmpty(g.row.media_sid)
    const entry = this.ledger.get(live.owner, g.stem, oid && sid && g.kind !== 'VIDEO' ? { fingerprint: ledgerFingerprint(oid, sid) } : {})
    return entry ? this.entryView(id, entry, live) : { msgId: id, state: 'idle' }
  }

  private batchView(): OriginalBatchView | null {
    const b = this.batch
    if (!b) return null
    let remaining = 0
    for (const job of this.jobs.values()) if (b.open.has(job.stem)) remaining++
    return { batchId: b.id, chatId: b.chatId, total: b.total, done: b.done, failed: b.failed, expired: b.expired, remaining, state: b.state }
  }

  private pausedView(): OriginalStatusView['paused'] {
    const now = this.now()
    if (this.globalPause && now < this.globalPause.until) return { reason: this.globalPause.reason, untilMs: this.globalPause.until }
    const authUntil = this.live ? this.authPauses.get(this.live.sessionId) : undefined
    if (authUntil !== undefined && now < authUntil) return { reason: 'auth', untilMs: authUntil }
    return null
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    for (const job of this.jobs.values()) { job.cancelled = true; job.controller?.abort() }
    await Promise.allSettled([...this.running])
    this.disposed = true
    this.offSession()
    if (this.pumpTimer) clearTimeout(this.pumpTimer)
    this.pumpTimer = null
    this.jobs.clear()
    await this.flushNow()
    await this.throttleLoaded
    await this.throttle.idle()
  }
}
