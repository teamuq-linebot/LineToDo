import type { Database } from 'better-sqlite3'
import {
  AVATAR_BACKFILL_VERSION, advanceLinkWatermark, createSenderLinker, deleteAvatarMeta, getAvatarMeta, hasLinkGap, isLineAvatarSchemaReady,
  knownChatIds, setAvatarMeta
} from '../../main/db/lineAvatar.repo'
import type { AvatarMetaKey } from '../../main/db/lineAvatar.repo'
import { maxMessageRowId, myMid, olderSenderRows, senderAvatarSource } from '../../main/line/engine/linedb'
import type { Db, LineAvatarSource } from '../../main/line/engine/linedb'

/**
 * avatarBackfill.ts — 既有訊息的頭像連結背景回填（設計附錄 §6）。
 *
 * 只用 `any` snapshot（呼叫端的 `openSource`＝`openLineDbFor({ policy: 'any' })`）：沒有 snapshot 或沒有金鑰就回 null，這裡等一下再試，
 * 絕不觸發複製或金鑰掃描。只有一個階段：從最新的 LINE rowid 往回，替「app DB 已經有、direction='in'」的訊息建立 msg → 發話者連結。
 * 游標、掃描與連結計數、階段都存在 `line_avatar_meta`，所以可以中斷、續做；重複跑是冪等的。
 *
 * 不卡事件迴圈：每個切片 ≤ sliceMs（預設 15 ms；LIMIT 自適應 50–1000），切片之間讓出事件迴圈；一個 burst 最多 burstMs（預設 300 ms）
 * 或 `shouldYield()`（有 \`fresh\` 更新在等 snapshot）為 true 就結束並釋放 lease，之後睡 max(100 ms, 3 × burst)，占空比約 25%。
 * 讀取錯誤退避（30 秒起、上限 10 分鐘），不呼叫 invalidate()。dispose 會讓進行中的切片收尾、釋放 lease，之後不再存取任何 DB。
 * 日誌與狀態都不含 MID、locator 或顯示名。
 */

export interface AvatarBackfillSource {
  con: Db
  cleanup(): void
  shouldYield(): boolean
}

export interface AvatarBackfillStatus {
  phase: string
  scanned: number
  linked: number
  cursor: string | null
  startedAt: string | null
  doneAt: string | null
  lastBurstMs: number | null
  errors: number
}

export interface AvatarBackfillBudget {
  sliceMs?: number
  burstMs?: number
  startDelayMs?: number
  /** 沒有 snapshot／金鑰時的重試起點與上限（預設 30 s／5 min）。 */
  sourceRetryMs?: number
  sourceRetryMaxMs?: number
  /** 讀取錯誤的退避起點與上限（預設 30 s／10 min）。 */
  errorBackoffMs?: number
  errorBackoffMaxMs?: number
  /** 完成後多久檢查一次缺口（預設 10 min）。 */
  recheckMs?: number
  /** burst 之間的最短睡眠與倍數（預設 100 ms、3 倍）。 */
  minSleepMs?: number
  sleepFactor?: number
}

export interface AvatarBackfillOptions {
  getDb(): Database | null
  openSource(): Promise<AvatarBackfillSource | null>
  /** 單調時鐘（ms）；預設 performance.now。 */
  now?(): number
  wallClock?(): number
  sleep?(ms: number): Promise<void>
  yieldLoop?(): Promise<void>
  /** 每個 burst 結束時呼叫（assemble 轉成 `bg` 事件，trace 自己依門檻過濾）。 */
  trace?(phase: 'avatar_backfill', ms: number): void
  log?(line: string): void
  /** 每個切片結束時呼叫（測試觀察用）。 */
  onSlice?(info: { ms: number; rows: number }): void
  budget?: AvatarBackfillBudget
}

export interface AvatarBackfill {
  start(): void
  dispose(): Promise<void>
  status(): AvatarBackfillStatus
}

const DEFAULTS = {
  sliceMs: 15, burstMs: 300, startDelayMs: 30_000, sourceRetryMs: 30_000, sourceRetryMaxMs: 5 * 60_000,
  errorBackoffMs: 30_000, errorBackoffMaxMs: 10 * 60_000, recheckMs: 10 * 60_000, minSleepMs: 100, sleepFactor: 3
}
const LIMIT_INIT = 200
const LIMIT_MIN = 50
const LIMIT_MAX = 1000
const FAST_QUERY_MS = 5
const SOURCE_CACHE_MAX = 5000
/** 缺口偵測：最後一批匯入比 link_watermark 晚超過這麼久才重開回填。 */
const LINK_GAP_MS = 60_000

export const OFF_STATUS: AvatarBackfillStatus = { phase: 'off', scanned: 0, linked: 0, cursor: null, startedAt: null, doneAt: null, lastBurstMs: null, errors: 0 }

export function createAvatarBackfill(options: AvatarBackfillOptions): AvatarBackfill {
  const budget = { ...DEFAULTS, ...options.budget }
  const clock = options.now ?? (() => performance.now())
  const wall = options.wallClock ?? Date.now
  const yieldLoop = options.yieldLoop ?? (() => new Promise<void>((resolve) => { setImmediate(resolve) }))
  const abort = new AbortController()
  const sleep = (ms: number): Promise<void> => {
    if (options.sleep) return options.sleep(ms)
    return new Promise<void>((resolve) => {
      if (abort.signal.aborted) { resolve(); return }
      const timer = setTimeout(done, ms)
      timer.unref?.()
      function done(): void { clearTimeout(timer); abort.signal.removeEventListener('abort', done); resolve() }
      abort.signal.addEventListener('abort', done, { once: true })
    })
  }
  const log = (line: string): void => { try { options.log?.(line) } catch { /* 日誌不能影響回填 */ } }

  let disposed = false
  let running: Promise<void> | null = null
  const status: AvatarBackfillStatus = { phase: 'pending', scanned: 0, linked: 0, cursor: null, startedAt: null, doneAt: null, lastBurstMs: null, errors: 0 }
  let limit = LIMIT_INIT
  let sourceCache = new Map<string, LineAvatarSource>()

  const readDb = (): Database | null => {
    if (disposed) return null
    const db = options.getDb()
    return db && isLineAvatarSchemaReady(db) ? db : null
  }
  const meta = (db: Database, key: AvatarMetaKey): string | null => getAvatarMeta(db, key)
  const put = (db: Database, key: AvatarMetaKey, value: string): void => setAvatarMeta(db, key, value)

  /** 載入持久狀態；版本升了或偵測到缺口就重新開始（冪等）。 */
  function load(db: Database): void {
    const version = meta(db, 'backfill_version')
    let phase = meta(db, 'backfill_phase') ?? 'pending'
    if (phase === 'chats') phase = 'messages' // 舊版的聊天室階段已移除
    const reopen = (phase === 'done' && hasLinkGap(db, LINK_GAP_MS)) || (version !== null && version !== String(AVATAR_BACKFILL_VERSION))
    if (reopen) {
      phase = 'pending'
      put(db, 'backfill_phase', phase)
      deleteAvatarMeta(db, 'backfill_cursor')
      deleteAvatarMeta(db, 'backfill_done_at')
      put(db, 'backfill_scanned', '0')
      put(db, 'backfill_linked', '0')
    }
    put(db, 'backfill_version', String(AVATAR_BACKFILL_VERSION))
    status.phase = phase
    status.scanned = Number(meta(db, 'backfill_scanned') ?? 0) || 0
    status.linked = Number(meta(db, 'backfill_linked') ?? 0) || 0
    status.cursor = meta(db, 'backfill_cursor')
    status.startedAt = meta(db, 'backfill_started_at')
    status.doneAt = meta(db, 'backfill_done_at')
  }

  const setPhase = (db: Database, phase: string): void => {
    put(db, 'backfill_phase', phase)
    status.phase = phase
    if (phase === 'messages' && !meta(db, 'backfill_started_at')) {
      const at = new Date(wall()).toISOString()
      put(db, 'backfill_started_at', at)
      status.startedAt = at
    }
    if (phase === 'done') {
      const at = new Date(wall()).toISOString()
      put(db, 'backfill_done_at', at)
      status.doneAt = at
      advanceLinkWatermark(db, meta(db, 'backfill_round_at') ?? meta(db, 'backfill_started_at') ?? at)
    }
  }

  /** 一個切片。回傳 true＝全部完成。 */
  function step(db: Database, con: Db, accountMid: string): boolean {
    const sliceStart = clock()
    if (status.phase === 'pending') {
      // 一輪的起點要持久化：完成時 link_watermark 推進到這個時間（不是完成時的最新批次），一輪進行中才提交、沒寫到連結的批次才不會被吞掉。
      put(db, 'backfill_round_at', new Date(wall()).toISOString())
      setPhase(db, 'messages')
    }

    // messages：游標＝最後一筆完整處理完的 rowid；沒有游標就從目前最大的 rowid 開始（往回掃）。
    let cursor = Number(status.cursor)
    if (status.cursor === null || !Number.isFinite(cursor)) {
      cursor = maxMessageRowId(con) + 1
    }
    const queryStart = clock()
    const rows = olderSenderRows(con, cursor, accountMid, limit)
    const queryMs = clock() - queryStart
    if (rows.length === 0) { setPhase(db, 'done'); return true }
    const chats = knownChatIds(db)
    const linker = createSenderLinker(db, { fillOnly: true })
    let processed = 0
    let linked = 0
    let lastRowMs = 0
    let last = cursor
    const tx = db.transaction(() => {
      for (const row of rows) {
        const rowStart = clock()
        if (processed > 0 && rowStart - sliceStart + lastRowMs * 2 >= budget.sliceMs) break
        processed += 1
        last = row.rowId
        if (chats.has(row.chatId)) {
          const key = `${row.chatId}\0${row.from}`
          let source = sourceCache.get(key)
          if (!source) {
            try { source = senderAvatarSource(con, row.chatId, row.from) } catch { source = undefined }
            if (source) {
              if (sourceCache.size >= SOURCE_CACHE_MAX) sourceCache = new Map()
              sourceCache.set(key, source)
            }
          }
          if (source && linker.linkIncoming(`i:${row.msgId}`, row.chatId, row.from, source, wall())) linked += 1
        }
        lastRowMs = clock() - rowStart
      }
      put(db, 'backfill_cursor', String(last))
      put(db, 'backfill_scanned', String(status.scanned + processed))
      put(db, 'backfill_linked', String(status.linked + linked))
    })
    tx()
    status.scanned += processed
    status.linked += linked
    status.cursor = String(last)
    options.onSlice?.({ ms: clock() - sliceStart, rows: processed })
    // LIMIT 自適應：查詢超過一個切片就減半、太快就加倍；一個切片沒處理完就把 LIMIT 收到實際處理量的 1.5 倍（不白抓用不到的列）。
    if (queryMs > budget.sliceMs) limit = Math.max(LIMIT_MIN, limit >> 1)
    else if (queryMs < FAST_QUERY_MS) limit = Math.min(LIMIT_MAX, limit * 2)
    if (processed < rows.length) limit = Math.max(LIMIT_MIN, Math.min(limit, Math.ceil(processed * 1.5)))
    return false
  }

  async function run(): Promise<void> {
    await sleep(budget.startDelayMs)
    let sourceWait = budget.sourceRetryMs
    let errorWait = budget.errorBackoffMs
    while (!disposed) {
      const db = readDb()
      if (!db) { await sleep(budget.sourceRetryMs); continue }
      let source: AvatarBackfillSource | null = null
      try {
        load(db)
        if (status.phase === 'done') { await sleep(budget.recheckMs); continue }
        source = await options.openSource()
      } catch {
        status.errors += 1
        status.phase = 'error'
        log('[avatar-backfill] read_failed')
        await sleep(errorWait)
        errorWait = Math.min(budget.errorBackoffMaxMs, errorWait * 2)
        continue
      }
      if (!source) {
        await sleep(sourceWait)
        sourceWait = Math.min(budget.sourceRetryMaxMs, sourceWait * 2)
        continue
      }
      const burstStart = clock()
      let finished = false
      let failed = false
      let accountUnknown = false
      try {
        let accountMid: string | null = null
        try { accountMid = myMid(source.con) } catch { accountMid = null }
        // 來源認不出自己的 MID（_profile 還沒有資料、讀取失敗）就分不出哪些是自己的訊息：整個 burst 不處理，等下一次再試。
        if (!accountMid) accountUnknown = true
        else sourceWait = budget.sourceRetryMs
        // 快取只在一個 burst 內有效：下一個 burst 會開一份新的 snapshot，發話者的頭像可能已經變了。
        sourceCache = new Map()
        while (!disposed && accountMid) {
          const current = readDb()
          if (!current) break
          status.phase = status.phase === 'error' ? (meta(current, 'backfill_phase') ?? 'pending') : status.phase
          finished = step(current, source.con, accountMid)
          if (finished || source.shouldYield() || clock() - burstStart >= budget.burstMs) break
          await yieldLoop()
        }
        errorWait = budget.errorBackoffMs
      } catch {
        failed = true
        status.errors += 1
        status.phase = 'error'
        log('[avatar-backfill] read_failed')
      } finally {
        try { source.cleanup() } catch { /* 已關閉 */ }
      }
      if (accountUnknown) {
        log('[avatar-backfill] account_unknown')
        await sleep(sourceWait)
        sourceWait = Math.min(budget.sourceRetryMaxMs, sourceWait * 2)
        continue
      }
      const burstMs = clock() - burstStart
      status.lastBurstMs = Math.round(burstMs)
      try { options.trace?.('avatar_backfill', Math.round(burstMs)) } catch { /* 觀測不能影響回填 */ }
      if (disposed) break
      if (finished) {
        log('[avatar-backfill] done')
        await sleep(budget.recheckMs)
        continue
      }
      if (failed) {
        await sleep(errorWait)
        errorWait = Math.min(budget.errorBackoffMaxMs, errorWait * 2)
        continue
      }
      await sleep(Math.max(budget.minSleepMs, budget.sleepFactor * burstMs))
    }
  }

  return {
    start() {
      if (running || disposed) return
      running = run().catch(() => { log('[avatar-backfill] stopped_unexpectedly') })
    },
    async dispose() {
      disposed = true
      abort.abort()
      if (running) await running
    },
    status: () => ({ ...status })
  }
}
