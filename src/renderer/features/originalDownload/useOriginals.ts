/**
 * useOriginals.ts — Pro「舊訊息下載原檔」的畫面狀態（X7；history-download.md §7、implementation-plan-v2.md X7）。
 *
 * 一個 `OriginalsStore`（App 掛 provider 時建立）記住每一格的狀態，`OriginalAction`（M4 插槽的內容）與 `ChatOriginalsBar`（批次列）都讀它：
 * - 格子掛上插槽就登記（msgId、種類、retry）；第一次看到的格子以 `original.status` 查一次目前狀態（只讀本地；查到之前不顯示按鈕，免得閃一下
 *   「下載原檔」又變成「已過期」）。
 * - 輪詢：只要畫面上有 queued／running／paused 的格子（或批次列看得到的批次還有進行中的格子）就每 `pollMs`（1.5 s）查一次，一次最多
 *   `ORIGINALS_LIMITS.statusMax`（200）個 msgId；沒有就清掉計時器、不再查。格子卸載（切換聊天室、捲走）就不再算它；provider 卸載清掉所有計時器。
 * - 完成（done）：先 `api.media.forget(msgId)` 再呼叫這一格的 retry（M4 契約，MediaView.tsx 的 MissingMediaActionContext 說明）。
 *   done 之後不再被任何較晚到的 status 回覆改掉；重新查詢後格子若仍顯示「尚未下載」（索引還沒看到新檔），插槽顯示「已下載，正在顯示…」，
 *   每 `recheckMs` 再 forget + retry 一次，最多 `recheckMax` 次，之後給「重新顯示」按鈕——格子不會退回可下載的狀態。
 * - 競態：每格有 epoch，使用者動作（下載、取消、批次）開始與結束都會推進；status 回覆只套用在「送出時的 epoch 仍相同、且沒有動作進行中」的格子。
 *   所以點擊之前送出的查詢、或比動作回覆晚到的查詢，都不會把格子改回去。
 * - 批次：一次最多 `ORIGINALS_LIMITS.batchMax`（50）格（照片、影片、檔案都可以；Manager 裁決）；單格手動下載的優先權由 backend 處理，畫面不另外排隊。
 * - 已收回的訊息不給按鈕（批次列把目前聊天室裡已收回的 msgId 告訴 store；backend 對已收回的回 unsupported，也不給按鈕）。
 */
import { createContext, useContext, useSyncExternalStore } from 'react'
import type { LineJsOriginalsControl, RawLineMessage } from '../../../shared/api'
import { ORIGINALS_LIMITS, type OriginalItemView, type OriginalState, type OriginalStatusView } from '../../../shared/linejsOriginals'
import type { MissingMediaKind } from '../../components/MediaView'

/**
 * 「下載原檔」總開關（單格按鈕與批次列一起）。**待 P0b 結果決定預設**：目前預設開啟；若 P0b 顯示加密的舊訊息抓不到，
 * 只改這一處為 false（App 就不掛 provider，畫面沒有任何下載原檔的按鈕與批次列）。
 */
export const ORIGINALS_DOWNLOAD_ENABLED = true

/** 時間設定（ms）。正式程式不改；測試以 provider 的 options 覆寫。 */
export const ORIGINALS_TIMING = Object.freeze({
  /** 有進行中的格子時，查 status 的間隔。 */
  pollMs: 1500,
  /** 完成後格子仍顯示「尚未下載」時，再 forget + retry 的間隔與次數上限。 */
  recheckMs: 1500,
  recheckMax: 3,
  /** 批次結束後摘要留在標題列的時間。 */
  summaryMs: 5000
})

/**
 * store 的軟上限（review-x7 F-4）。entries 以 Map 的插入順序當 LRU（格子重新掛上就移到最後）；超過時從最舊的淘汰，但跳過
 * 插槽掛著、動作進行中、queued／running／paused、在進行中批次裡、有 recheck 計時器的格子（所以實際可能暫時超過）。
 * recalled 超過時丟掉最早記下的（那些訊息早已不在畫面上；再看到時批次列會重新告訴 store）。
 */
export const ORIGINALS_STORE_LIMITS = Object.freeze({ entriesMax: 2000, recalledMax: 5000 })

/**
 * review-x5 F-1：backend 暫時讀不到電腦版 LINE 的帳號（帳號暫停期間、電腦版沒登入）時回的 account_mismatch 碼。這不是「帳號不同」：
 * 格子顯示 ACCOUNT_UNVERIFIED_TEXT 與「重試」，也可以再進批次；批次一格都沒排進去時，批次列說明原因（不是「補抓完成」）。
 */
export const ACCOUNT_UNVERIFIED = 'ACCOUNT_UNVERIFIED'
export const ACCOUNT_UNVERIFIED_TEXT = '暫時讀不到電腦版 LINE 的帳號，請確認電腦版已登入後再試'
const unverified = (entry: Pick<OriginalCell, 'state' | 'code'>): boolean => entry.state === 'account_mismatch' && entry.code === ACCOUNT_UNVERIFIED

/** 畫面會繼續輪詢的狀態（HD §7.3）。 */
const ACTIVE: ReadonlySet<string> = new Set<OriginalState>(['queued', 'running', 'paused'])
/** 批次摘要裡算「已過期」的狀態。 */
const EXPIRED: ReadonlySet<string> = new Set<OriginalState>(['expired'])
/** 可以下載原檔的訊息種類（ct 1 照片、2 影片、14 檔案）；只有 LINE 訊息（'i:' id）才有原檔。 */
const MEDIA_CONTENT_TYPES: ReadonlySet<number> = new Set([1, 2, 14])

/** 一格在畫面上的狀態：backend 的 OriginalState，加上「還不知道」（查詢中）與「功能不可用」（backend 沒有下載服務）。兩者都不顯示任何東西。 */
export type CellState = OriginalState | 'unknown' | 'unavailable'

export interface OriginalCell {
  msgId: string
  state: CellState
  code?: string
  bytesDone?: number
  declaredBytes?: number
  retryAt?: number
  /** 使用者的動作（下載、取消、重試）已送出、還沒回覆：按鈕暫時停用。 */
  busy: boolean
  /** 完成後畫面仍顯示「尚未下載」時，已自動 forget + retry 的次數。 */
  rechecks: number
}

interface Entry extends OriginalCell { epoch: number }
interface Slot { kind: MissingMediaKind; retry: { current: () => void } }

export type OriginalsBatchPhase = 'starting' | 'running' | 'finished' | 'cancelled' | 'error'
export interface OriginalsBatch {
  chatId: string
  batchId: string | null
  /** backend 接受、這次批次負責的 msgId。 */
  ids: string[]
  phase: OriginalsBatchPhase
  /** phase=error 的原因：另一個批次進行中、暫時讀不到電腦版的帳號（一格都沒排進去，review-x5 F-1），或沒有開始成功。 */
  error?: 'batch_active' | 'account_unverified' | 'failed'
  /** 取消請求失敗（批次仍在進行）。 */
  cancelFailed?: boolean
  cancelling?: boolean
  /** starting 階段按了取消：batchStart 一回來（有 batchId）就立刻呼叫 batchCancel（review-x7 F-3）。 */
  cancelRequested?: boolean
}
export interface OriginalsBatchProgress {
  total: number
  /** 已不在進行中的格子數（完成、過期、失敗…）。 */
  finished: number
  done: number
  expired: number
  /** 其他沒有下載成功的格子（失敗、沒有權限、無法解密、需登入…）。 */
  failed: number
}

export interface OriginalsTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}
const DEFAULT_TIMERS: OriginalsTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) }

export interface OriginalsStoreOptions {
  control: LineJsOriginalsControl
  /** `api.media.forget`（M4）：清掉這則訊息的媒體快取，之後的查詢會再問 backend。 */
  forget: (msgId: string) => void
  timers?: OriginalsTimers
  pollMs?: number
  recheckMs?: number
  recheckMax?: number
  summaryMs?: number
  now?: () => number
}

const errorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'error'
}

export class OriginalsStore {
  private readonly control: LineJsOriginalsControl
  private readonly forgetMedia: (msgId: string) => void
  private readonly timers: OriginalsTimers
  readonly pollMs: number
  readonly recheckMs: number
  readonly recheckMax: number
  readonly summaryMs: number
  readonly now: () => number

  private readonly entries = new Map<string, Entry>()
  /** state ∈ ACTIVE 的 msgId（輪詢用的索引，不必每次掃整張表；review-x7 F-4）。entry.state 只經由 setState 改。 */
  private readonly active = new Set<string>()
  private readonly slots = new Map<string, Set<Slot>>()
  private readonly recalled = new Set<string>()
  /** chatId → 目前掛著的批次列數。 */
  private readonly watchers = new Map<string, number>()
  private readonly batches = new Map<string, OriginalsBatch>()
  private readonly listeners = new Set<() => void>()
  private readonly recheckTimers = new Map<string, unknown>()
  private readonly summaryTimers = new Map<string, unknown>()
  private readonly hydrateQueue = new Set<string>()
  private hydrateTimer: unknown = null
  private pollTimer: unknown = null
  private polling = false
  private pollCursor = 0
  private disposed = false
  private version = 0
  /** 「登入 LINE」對話框開著（provider 渲染既有的 LineLoginDialog）。 */
  loginOpen = false

  constructor(options: OriginalsStoreOptions) {
    this.control = options.control
    this.forgetMedia = options.forget
    this.timers = options.timers ?? DEFAULT_TIMERS
    this.pollMs = options.pollMs ?? ORIGINALS_TIMING.pollMs
    this.recheckMs = options.recheckMs ?? ORIGINALS_TIMING.recheckMs
    this.recheckMax = options.recheckMax ?? ORIGINALS_TIMING.recheckMax
    this.summaryMs = options.summaryMs ?? ORIGINALS_TIMING.summaryMs
    this.now = options.now ?? Date.now
  }

  // ── 訂閱（useSyncExternalStore） ──

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  getVersion = (): number => this.version
  private notify(): void {
    this.version += 1
    for (const listener of [...this.listeners]) listener()
  }

  /**
   * provider 掛上（React 開發模式會卸載再掛一次：重新允許計時器）。StrictMode 的順序是「格子登記 → 格子卸載 → provider dispose →
   * 格子再登記（entry 已存在，不會再排查詢）→ provider start」，所以這裡把插槽還掛著、狀態仍未知的格子重新排查詢，並重新排輪詢。
   */
  start(): void {
    this.disposed = false
    for (const id of this.slots.keys()) if (this.entries.get(id)?.state === 'unknown') this.queueHydrate(id)
    this.schedulePoll()
  }

  /** provider 卸載：清掉所有計時器，之後才到的回覆一律丟掉。 */
  dispose(): void {
    this.disposed = true
    if (this.pollTimer !== null) { this.timers.clear(this.pollTimer); this.pollTimer = null }
    if (this.hydrateTimer !== null) { this.timers.clear(this.hydrateTimer); this.hydrateTimer = null }
    for (const handle of this.recheckTimers.values()) this.timers.clear(handle)
    this.recheckTimers.clear()
    for (const handle of this.summaryTimers.values()) this.timers.clear(handle)
    this.summaryTimers.clear()
    this.hydrateQueue.clear()
  }

  // ── 讀取 ──

  /** 這一格目前的狀態；已收回的訊息一律 null（不給按鈕）。 */
  cell(msgId: string): OriginalCell | null {
    if (this.recalled.has(msgId)) return null
    return this.entries.get(msgId) ?? null
  }

  batchFor(chatId: string): OriginalsBatch | null { return this.batches.get(chatId) ?? null }

  /** 只有計數（測試與觀測用）：entries、recalled、輪詢索引（active）、插槽掛著的格子數。 */
  sizes(): { entries: number; recalled: number; active: number; slots: number } {
    return { entries: this.entries.size, recalled: this.recalled.size, active: this.active.size, slots: this.slots.size }
  }

  batchProgress(chatId: string): OriginalsBatchProgress | null {
    const batch = this.batches.get(chatId)
    if (!batch) return null
    let finished = 0
    let done = 0
    let expired = 0
    for (const id of batch.ids) {
      const state = this.entries.get(id)?.state ?? 'unknown'
      if (ACTIVE.has(state)) continue
      finished += 1
      if (state === 'done') done += 1
      else if (EXPIRED.has(state)) expired += 1
    }
    return { total: batch.ids.length, finished, done, expired, failed: finished - done - expired }
  }

  /**
   * 這個聊天室目前畫面上可以補抓的格子（照片、影片、檔案；未收回；插槽掛著；狀態已知為「尚未下載」），依訊息順序。
   * 批次取最新的 `ORIGINALS_LIMITS.batchMax` 個。
   */
  eligible(messages: readonly RawLineMessage[]): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const m of messages) {
      const id = m.msgId
      if (!id || seen.has(id) || !id.startsWith('i:') || m.unsent || !MEDIA_CONTENT_TYPES.has(m.contentType)) continue
      seen.add(id)
      if (this.recalled.has(id) || !this.slots.has(id)) continue
      const entry = this.entries.get(id)
      // review-x5 F-1：暫時讀不到帳號的格子也可以再補抓（與格子上的「重試」相同）
      if (entry && (entry.state === 'idle' || unverified(entry)) && !entry.busy) out.push(id)
    }
    return out
  }

  // ── 格子登記（OriginalAction 掛上／卸載） ──

  register(msgId: string, kind: MissingMediaKind, retry: { current: () => void }): () => void {
    const slot: Slot = { kind, retry }
    let set = this.slots.get(msgId)
    if (!set) { set = new Set(); this.slots.set(msgId, set) }
    set.add(slot)
    const entry = this.entries.get(msgId)
    if (!entry) {
      // 只有 LINE 訊息（'i:' id）有原檔；'d:' 等其他 id 不給按鈕，也不問 backend（HD §7.1）
      const lineMessage = msgId.startsWith('i:')
      this.entries.set(msgId, { msgId, state: lineMessage ? 'unknown' : 'unsupported', busy: false, rechecks: 0, epoch: 0 })
      if (lineMessage) this.queueHydrate(msgId)
      this.evictEntries()
    } else {
      // LRU（F-4）：重新掛上的格子移到最後
      this.entries.delete(msgId)
      this.entries.set(msgId, entry)
      // 上次排的第一次查詢因為格子先卸載而被略過（hydrate 不查沒有插槽的格子）：重新掛上時再排一次
      if (entry.state === 'unknown') this.queueHydrate(msgId)
    }
    if (entry && entry.state === 'done') {
      // 完成之後格子又顯示「尚未下載」（重新查詢時索引還沒看到新檔）：稍後再 forget + retry
      this.scheduleRecheck(msgId)
    }
    this.schedulePoll()
    return () => {
      const current = this.slots.get(msgId)
      current?.delete(slot)
      if (current && current.size === 0) {
        this.slots.delete(msgId)
        this.clearRecheck(msgId)
      }
      this.schedulePoll()
    }
  }

  /** 批次列告訴 store 目前聊天室裡已收回的訊息（這些格子不給按鈕、不進批次）。 */
  noteMessages(messages: readonly RawLineMessage[]): void {
    let changed = false
    for (const m of messages) {
      if (m.unsent && m.msgId && !this.recalled.has(m.msgId)) { this.recalled.add(m.msgId); changed = true }
    }
    // F-4：只留最近記下的 recalledMax 個（Set 依插入順序）
    let over = this.recalled.size - ORIGINALS_STORE_LIMITS.recalledMax
    for (const id of this.recalled) { if (over <= 0) break; this.recalled.delete(id); over -= 1 }
    if (changed) this.notify()
  }

  /** 批次列掛上：這個聊天室的批次要繼續輪詢、結束後的摘要開始倒數。回傳卸載用的函式。 */
  watchBatch(chatId: string): () => void {
    this.watchers.set(chatId, (this.watchers.get(chatId) ?? 0) + 1)
    this.scheduleSummaryDismiss(chatId)
    this.schedulePoll()
    return () => {
      const left = (this.watchers.get(chatId) ?? 1) - 1
      if (left > 0) this.watchers.set(chatId, left)
      else {
        this.watchers.delete(chatId)
        const handle = this.summaryTimers.get(chatId)
        if (handle !== undefined) { this.timers.clear(handle); this.summaryTimers.delete(chatId) }
      }
      this.schedulePoll()
    }
  }

  // ── 使用者動作 ──

  request(msgId: string): void {
    const entry = this.entries.get(msgId)
    if (!entry || entry.busy || this.disposed) return
    this.begin(entry, 'queued')
    void this.control.request(msgId).then(
      (view) => this.finishAction(entry, view),
      (error) => this.failAction(entry, error)
    )
  }

  cancel(msgId: string): void {
    const entry = this.entries.get(msgId)
    if (!entry || entry.busy || this.disposed) return
    this.begin(entry, null)
    void this.control.cancel(msgId).then(
      (view) => this.finishAction(entry, view),
      (error) => this.failAction(entry, error)
    )
  }

  /** 完成後仍顯示不出來：使用者按「重新顯示」，再 forget + retry 一次。 */
  reshow(msgId: string): void {
    const entry = this.entries.get(msgId)
    if (!entry || entry.state !== 'done') return
    this.forgetAndRetry(msgId)
  }

  openLogin(): void { if (!this.loginOpen) { this.loginOpen = true; this.notify() } }
  closeLogin(): void { if (this.loginOpen) { this.loginOpen = false; this.notify() } }

  /** 登入完成後：畫面上所有格子重新查一次狀態（需要登入的格子變成可下載）。 */
  refreshAll(): void {
    for (const id of this.slots.keys()) {
      const entry = this.entries.get(id)
      if (entry && !entry.busy && entry.state !== 'done') this.queueHydrate(id)
    }
  }

  startBatch(chatId: string, msgIds: readonly string[]): void {
    const current = this.batches.get(chatId)
    if (this.disposed || (current && (current.phase === 'starting' || current.phase === 'running'))) return
    const ids = [...new Set(msgIds)].slice(0, ORIGINALS_LIMITS.batchMax)
    if (ids.length === 0) return
    const batch: OriginalsBatch = { chatId, batchId: null, ids: [], phase: 'starting' }
    this.batches.set(chatId, batch)
    this.clearSummaryTimer(chatId)
    const touched: Entry[] = []
    for (const id of ids) {
      const entry = this.entries.get(id)
      if (!entry || entry.busy) continue
      this.begin(entry, 'queued', false)
      touched.push(entry)
    }
    this.notify()
    void this.control.batchStart(chatId, touched.map((e) => e.msgId)).then(
      (result) => {
        if (this.disposed) return
        const accepted = new Set(result.accepted)
        const skipped = new Map(result.skipped.map((s) => [s.msgId, s]))
        for (const entry of touched) {
          entry.busy = false
          entry.epoch += 1
          if (accepted.has(entry.msgId)) continue // 排隊中；之後由輪詢更新
          const skip = skipped.get(entry.msgId)
          if (skip) this.applyFields(entry, { msgId: entry.msgId, state: skip.state, ...(skip.code ? { code: skip.code } : {}) })
          else this.applyFields(entry, { msgId: entry.msgId, state: 'idle' })
        }
        batch.batchId = result.batchId
        batch.ids = touched.map((e) => e.msgId).filter((id) => accepted.has(id))
        batch.phase = 'running'
        // F-3: 取消是在 starting 階段按的 → 現在有 batchId 了，立刻送出 batchCancel
        const cancelNow = batch.cancelRequested === true
        if (cancelNow) { batch.cancelRequested = false; batch.cancelling = false }
        // X5（review-x67 Info）：接納途中被別處（另一個視窗）取消了——backend 把剩下的格子回成 BATCH_CANCELLED。這個批次已經結束，
        // 顯示「已取消」（不是「補抓完成」），也不必再送 batchCancel
        if (result.skipped.some((s) => s.code === 'BATCH_CANCELLED')) { this.markCancelled(batch); this.notify(); this.schedulePoll(); return }
        // review-x5 F-1：backend 暫時讀不到電腦版的帳號（帳號暫停期間的接納不讀帳號），一格都沒排進去——不是「補抓完成（0 個）」：
        // 批次列說明原因；backend 的批次已以 0 格結束，不必再送 batchCancel。格子顯示同一個原因與「重試」
        if (batch.ids.length === 0 && result.skipped.some((s) => s.code === ACCOUNT_UNVERIFIED)) {
          batch.phase = 'error'
          batch.error = 'account_unverified'
          this.scheduleSummaryDismiss(chatId)
          this.notify()
          this.schedulePoll()
          return
        }
        this.checkBatches()
        this.notify()
        this.schedulePoll()
        if (cancelNow && batch.phase === 'running') this.cancelBatch(chatId)
      },
      (error) => {
        if (this.disposed) return
        for (const entry of touched) {
          entry.busy = false
          entry.epoch += 1
          if (entry.state === 'queued') this.applyFields(entry, { msgId: entry.msgId, state: 'idle' })
        }
        batch.cancelRequested = false
        batch.cancelling = false
        batch.phase = 'error'
        batch.error = errorCode(error) === 'batch_active' ? 'batch_active' : 'failed'
        this.scheduleSummaryDismiss(chatId)
        this.notify()
        this.schedulePoll()
      }
    )
  }

  cancelBatch(chatId: string): void {
    const batch = this.batches.get(chatId)
    if (!batch || batch.cancelling || this.disposed) return
    if (batch.phase === 'starting') {
      // F-3: 還沒有 batchId（backend 正在接納）：先記下，batchStart 一回來就取消
      batch.cancelRequested = true
      batch.cancelling = true
      batch.cancelFailed = false
      this.notify()
      return
    }
    if (batch.phase !== 'running' || !batch.batchId) return
    batch.cancelling = true
    batch.cancelFailed = false
    this.notify()
    void this.control.batchCancel(batch.batchId).then(
      () => {
        if (this.disposed) return
        batch.cancelling = false
        if (batch.phase !== 'running') { this.notify(); return }
        // 排隊中、進行中的格子回到「尚未下載」（backend：排隊的移除，進行中的中止、part 保留）；再查一次確認實際狀態
        for (const id of batch.ids) {
          const entry = this.entries.get(id)
          if (!entry || entry.busy || !ACTIVE.has(entry.state)) continue
          entry.epoch += 1
          this.applyFields(entry, { msgId: id, state: 'idle' })
          this.queueHydrate(id)
        }
        batch.phase = 'cancelled'
        this.scheduleSummaryDismiss(chatId)
        this.notify()
        this.schedulePoll()
      },
      () => {
        if (this.disposed) return
        batch.cancelling = false
        batch.cancelFailed = true
        this.notify()
      }
    )
  }

  // ── 內部：動作 ──

  private begin(entry: Entry, optimistic: CellState | null, notify = true): void {
    entry.busy = true
    entry.epoch += 1
    if (optimistic) { this.setState(entry, optimistic); delete entry.code; delete entry.bytesDone; delete entry.retryAt }
    if (notify) { this.notify(); this.schedulePoll() }
  }

  private finishAction(entry: Entry, view: OriginalItemView): void {
    if (this.disposed) return
    entry.busy = false
    entry.epoch += 1
    this.applyFields(entry, view)
    this.checkBatches()
    this.notify()
    this.schedulePoll()
  }

  private failAction(entry: Entry, error: unknown): void {
    if (this.disposed) return
    entry.busy = false
    entry.epoch += 1
    if (errorCode(error) === 'linejs_originals_unavailable') this.applyFields(entry, { msgId: entry.msgId, state: 'unavailable' as OriginalState })
    else {
      // 送出失敗（逾時、連線中斷…）：先顯示可重試的失敗，再查一次 backend 的實際狀態（工作可能已經排進去）
      this.applyFields(entry, { msgId: entry.msgId, state: 'failed', code: 'REQUEST_FAILED' })
      this.queueHydrate(entry.msgId)
    }
    this.notify()
    this.schedulePoll()
  }

  /** 把 backend 的一格狀態寫進 entry；變成 done 就 forget + retry。done 只有使用者重新動作才會離開（目前沒有這種動作）。 */
  private applyFields(entry: Entry, view: Pick<OriginalItemView, 'msgId' | 'state'> & Partial<OriginalItemView>): void {
    const wasDone = entry.state === 'done'
    if (wasDone) return
    this.setState(entry, view.state)
    if (view.code !== undefined) entry.code = view.code; else delete entry.code
    if (view.bytesDone !== undefined) entry.bytesDone = view.bytesDone; else delete entry.bytesDone
    if (view.declaredBytes !== undefined) entry.declaredBytes = view.declaredBytes
    if (view.retryAt !== undefined) entry.retryAt = view.retryAt; else delete entry.retryAt
    if (view.state === 'done') { entry.rechecks = 0; this.forgetAndRetry(entry.msgId) }
  }

  /** entry.state 唯一的寫入點：同時維護輪詢索引（F-4）。 */
  private setState(entry: Entry, state: CellState): void {
    entry.state = state
    if (ACTIVE.has(state)) this.active.add(entry.msgId)
    else this.active.delete(entry.msgId)
  }

  /** F-4：超過 entriesMax 時從最舊的淘汰；還有用途的格子（見 ORIGINALS_STORE_LIMITS）一律留下。 */
  private evictEntries(): void {
    let over = this.entries.size - ORIGINALS_STORE_LIMITS.entriesMax
    if (over <= 0) return
    const inBatch = new Set<string>()
    for (const batch of this.batches.values()) if (batch.phase === 'starting' || batch.phase === 'running') for (const id of batch.ids) inBatch.add(id)
    for (const [id, entry] of this.entries) {
      if (over <= 0) break
      if (this.slots.has(id) || entry.busy || ACTIVE.has(entry.state) || inBatch.has(id) || this.recheckTimers.has(id)) continue
      this.entries.delete(id)
      this.active.delete(id)
      this.hydrateQueue.delete(id)
      over -= 1
    }
  }

  /** M4 契約：先 forget（清掉 URL 與 60 s 負面快取、推進世代號），再讓每個掛著的格子重新查詢。 */
  private forgetAndRetry(msgId: string): void {
    this.clearRecheck(msgId)
    this.forgetMedia(msgId)
    for (const slot of [...(this.slots.get(msgId) ?? [])]) slot.retry.current()
  }

  private scheduleRecheck(msgId: string): void {
    const entry = this.entries.get(msgId)
    if (!entry || entry.state !== 'done' || entry.rechecks >= this.recheckMax || this.recheckTimers.has(msgId) || this.disposed) return
    const handle = this.timers.set(() => {
      this.recheckTimers.delete(msgId)
      if (this.disposed || !this.slots.has(msgId) || entry.state !== 'done') return
      entry.rechecks += 1
      this.notify()
      this.forgetAndRetry(msgId)
    }, this.recheckMs)
    this.recheckTimers.set(msgId, handle)
  }

  private clearRecheck(msgId: string): void {
    const handle = this.recheckTimers.get(msgId)
    if (handle !== undefined) { this.timers.clear(handle); this.recheckTimers.delete(msgId) }
  }

  /**
   * X5（review-x67 Info）：批次在別處（另一個視窗）被取消了（status 的 batch 是同一個 batchId、state cancelled，或 batchStart 回 BATCH_CANCELLED）。
   * 批次列顯示「已取消」而不是「補抓完成」；還顯示進行中的格子與自己取消時一樣先回到「尚未下載」，再查一次實際狀態。
   * 自己的取消正在送出時不處理（那條路徑自己會收尾）。
   */
  private markCancelled(batch: OriginalsBatch): void {
    batch.phase = 'cancelled'
    for (const id of batch.ids) {
      const entry = this.entries.get(id)
      if (!entry || entry.busy || !ACTIVE.has(entry.state)) continue
      entry.epoch += 1
      this.applyFields(entry, { msgId: id, state: 'idle' })
      this.queueHydrate(id)
    }
    this.scheduleSummaryDismiss(batch.chatId)
  }

  private noteServiceBatch(view: OriginalStatusView['batch'] | undefined): void {
    if (!view || view.state !== 'cancelled') return
    for (const batch of this.batches.values()) {
      if (batch.phase !== 'running' || batch.cancelling || batch.batchId !== view.batchId) continue
      this.markCancelled(batch)
    }
  }

  private checkBatches(): void {
    for (const batch of this.batches.values()) {
      if (batch.phase !== 'running') continue
      const busy = batch.ids.some((id) => { const e = this.entries.get(id); return !e || e.busy || ACTIVE.has(e.state) })
      if (!busy) { batch.phase = 'finished'; this.scheduleSummaryDismiss(batch.chatId) }
    }
  }

  private clearSummaryTimer(chatId: string): void {
    const handle = this.summaryTimers.get(chatId)
    if (handle !== undefined) { this.timers.clear(handle); this.summaryTimers.delete(chatId) }
  }

  /** 批次結束（完成、取消、沒有開始）且批次列看得到：摘要留 `summaryMs` 後收起。 */
  private scheduleSummaryDismiss(chatId: string): void {
    const batch = this.batches.get(chatId)
    if (!batch || this.disposed || this.summaryTimers.has(chatId) || !this.watchers.has(chatId)) return
    if (batch.phase !== 'finished' && batch.phase !== 'cancelled' && batch.phase !== 'error') return
    const handle = this.timers.set(() => {
      this.summaryTimers.delete(chatId)
      if (this.batches.get(chatId) === batch) { this.batches.delete(chatId); this.notify() }
    }, this.summaryMs)
    this.summaryTimers.set(chatId, handle)
  }

  // ── 內部：查詢 ──

  private queueHydrate(msgId: string): void {
    this.hydrateQueue.add(msgId)
    if (this.hydrateTimer !== null || this.disposed) return
    this.hydrateTimer = this.timers.set(() => { this.hydrateTimer = null; void this.hydrate() }, 0)
  }

  /** 第一次看到的格子（或登入後、取消後）查一次狀態；不是輪詢，查完不留計時器。 */
  private async hydrate(): Promise<void> {
    if (this.disposed) return
    // F-4: 排隊之後就卸載的格子（捲走、切換聊天室）不查
    const ids = [...this.hydrateQueue].filter((id) => this.slots.has(id))
    this.hydrateQueue.clear()
    for (let i = 0; i < ids.length; i += ORIGINALS_LIMITS.statusMax) {
      await this.query(ids.slice(i, i + ORIGINALS_LIMITS.statusMax), true)
      if (this.disposed) return
    }
    // 查到進行中的格子（例如重新整理畫面前就在下載）：開始輪詢
    this.schedulePoll()
  }

  /** 這次輪詢要查的格子：進行中，而且畫面上看得到（插槽掛著，或批次列看得到的批次）。 */
  private activeIds(): string[] {
    const out = new Set<string>()
    // F-4: 只看索引裡進行中的格子，不掃整張表
    for (const id of this.active) if (this.slots.has(id)) out.add(id)
    for (const batch of this.batches.values()) {
      if (batch.phase !== 'running' || !this.watchers.has(batch.chatId)) continue
      for (const id of batch.ids) { const entry = this.entries.get(id); if (entry && ACTIVE.has(entry.state)) out.add(id) }
    }
    return [...out]
  }

  /** 有進行中的格子才留一個計時器；沒有就清掉（停止輪詢）。同時只有一個 status 在路上。 */
  private schedulePoll(): void {
    if (this.disposed) return
    if (this.activeIds().length === 0) {
      if (this.pollTimer !== null) { this.timers.clear(this.pollTimer); this.pollTimer = null }
      return
    }
    if (this.pollTimer !== null || this.polling) return
    this.pollTimer = this.timers.set(() => { this.pollTimer = null; void this.poll() }, this.pollMs)
  }

  private async poll(): Promise<void> {
    if (this.disposed) return
    const ids = this.activeIds()
    if (ids.length === 0) return
    // 超過上限時輪流查（每次最多 statusMax 個）
    const max = ORIGINALS_LIMITS.statusMax
    const start = ids.length > max ? this.pollCursor % ids.length : 0
    const chunk = ids.length > max ? [...ids.slice(start), ...ids.slice(0, start)].slice(0, max) : ids
    this.pollCursor = start + chunk.length
    this.polling = true
    try { await this.query(chunk, false) } finally {
      this.polling = false
      this.schedulePoll()
    }
  }

  private async query(ids: string[], hydrating: boolean): Promise<void> {
    const sent = new Map(ids.map((id) => [id, this.entries.get(id)?.epoch ?? -1]))
    let result: OriginalStatusView
    try {
      result = await this.control.status(ids)
    } catch (error) {
      if (this.disposed) return
      const unavailable = errorCode(error) === 'linejs_originals_unavailable'
      for (const id of ids) {
        const entry = this.entries.get(id)
        if (!entry || entry.busy || entry.epoch !== sent.get(id)) continue
        // backend 沒有下載服務：不給按鈕。其他失敗：查詢中的格子先給「下載原檔」（按下去會帶出實際的錯誤），進行中的格子維持原狀、下次再查
        if (unavailable) { this.setState(entry, 'unavailable'); delete entry.code }
        else if (hydrating && entry.state === 'unknown') this.setState(entry, 'idle')
      }
      this.notify()
      return
    }
    if (this.disposed) return
    for (const view of result.items ?? []) {
      const entry = this.entries.get(view.msgId)
      if (!entry || !sent.has(view.msgId)) continue
      // 送出之後有使用者動作（或動作還沒回覆）：這個回覆已經過時，不套用
      if (entry.busy || entry.epoch !== sent.get(view.msgId)) continue
      this.applyFields(entry, view)
    }
    // before checkBatches: a batch cancelled elsewhere ends as 已取消, not as 補抓完成
    this.noteServiceBatch(result.batch)
    this.checkBatches()
    this.notify()
  }
}

export const OriginalsContext = createContext<OriginalsStore | null>(null)

/** provider 沒有掛（免費版、backend 沒有 `linejsMedia.original`、開關關閉）＝ null。 */
export function useOriginalsStore(): OriginalsStore | null {
  return useContext(OriginalsContext)
}

const noSubscribe = (): (() => void) => () => undefined
const zero = (): number => 0
/** store 有變化就重新渲染（回傳值只是版本號）。 */
export function useOriginalsVersion(store: OriginalsStore | null): number {
  return useSyncExternalStore(store ? store.subscribe : noSubscribe, store ? store.getVersion : zero, store ? store.getVersion : zero)
}

/** 暫停的原因 → 文字（HD §7.3：條件解除後自動恢復，沒有按鈕）。 */
export function pausedText(code: string | undefined): string {
  switch (code) {
    case 'rate_limited': return '已暫停（LINE 限流），稍後自動繼續'
    case 'hourly_limit': return '已暫停（已達每小時上限），稍後自動繼續'
    case 'disk_low': return '已暫停（磁碟空間不足），空出空間後自動繼續'
    case 'auth': return '已暫停（需重新登入 LINE）'
    default: return '已暫停（連線中斷），稍後自動繼續'
  }
}

/** 下載中的百分比（只有影片、檔案有位元組進度）。 */
export function progressPercent(cell: Pick<OriginalCell, 'bytesDone' | 'declaredBytes'>): number | null {
  if (cell.bytesDone === undefined || !cell.declaredBytes || cell.declaredBytes <= 0) return null
  return Math.max(0, Math.min(99, Math.floor((cell.bytesDone / cell.declaredBytes) * 100)))
}
