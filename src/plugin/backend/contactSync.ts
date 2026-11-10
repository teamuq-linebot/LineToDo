import type { Database } from 'better-sqlite3'
import { getAvatarMeta, isLineAvatarSchemaReady, setAvatarMeta } from '../../main/db/lineAvatar.repo'
import { ENTITY_KINDS, isLineEntitySchemaReady, isValidEntityMid, deleteEntities, entityMids, upsertEntity } from '../../main/db/lineEntity.repo'
import type { EntityInput, EntityKind } from '../../main/db/lineEntity.repo'
import { contactLocator, contactName, contactRowsAfter, groupLocator, groupRowsAfter, myMid, squareChatLocator, squareChatRowsAfter } from '../../main/line/engine/linedb'
import type { Db, KeysetCursor, KeysetPage } from '../../main/line/engine/linedb'

/**
 * contactSync.ts — LINE 通訊錄（聯絡人、群組、Square 聊天室）的背景同步到本地的通訊錄實體表（lineEntity.repo.ts）。
 *
 * 骨架照 avatarBackfill：只用 `any` snapshot（呼叫端的 `openSource`＝`openLineDbFor({ policy: 'any' })`），沒有 snapshot 或沒有金鑰就等一下再試，
 * 絕不觸發複製或金鑰掃描，也不多開 snapshot、不放進匯入批次。
 *
 * 觸發：每 `pollMs` 比一次簽章（`currentSig()`，內容與 snapshot 的來源簽章同一種正規化格式，見 normalizeSourceSig）；簽章和上次完成時不同、
 * 而且距上次完成滿 `minIntervalMs` 才掃。`CONTACT_SYNC_VERSION` 不符（含第一次）不受間隔限制。穩態只讀不寫：只有內容變動的列才寫入。
 *
 * 掃描：每個 kind 依序做 keyset 分頁（rowid，WITHOUT ROWID 的表退回主鍵），每個切片一個 transaction（最多 1000 列），切片之間讓出事件迴圈，
 * 一個 burst 最多 burstMs 或 `shouldYield()` 為 true 就結束並釋放 lease，之後睡 max(minSleepMs, sleepFactor × burst)。
 * 進度只放記憶體；任何例外或 dispose 都丟掉進行中的掃描（不刪除、不寫完成的 meta），下一輪重來。
 *
 * 鏡像：只在某個 kind 完整掃完時，把「資料庫裡有、但這輪 LINE 端沒看到」的列直接刪除。缺表的 kind 這輪跳過，掃描中途失敗也不刪。自己的 MID 永不寫入。
 * 日誌與狀態都不含 MID、locator 或顯示名。
 */

export const CONTACT_SYNC_VERSION = 2
export const CONTACT_SYNC_MIN_INTERVAL_MS = 5 * 60_000
export const CONTACT_SYNC_POLL_MS = 15_000

/** snapshot 的 `lease.source`（鍵 `wal`）與 `walSig()`（鍵 `-wal`）的共同形狀。 */
export interface SourceSigLike {
  edb?: readonly [number, number] | null
  wal?: readonly [number, number] | null
  ['-wal']?: readonly [number, number] | null
}

/** 兩種來源簽章走同一個正規化：`edb=<size>:<mtimeNs>;wal=<size>:<mtimeNs>`，缺檔記 `-`。 */
export function normalizeSourceSig(sig: SourceSigLike | null | undefined): string {
  const part = (value: readonly [number, number] | null | undefined): string => (value ? `${value[0]}:${value[1]}` : '-')
  return `edb=${part(sig?.edb)};wal=${part(sig?.wal ?? sig?.['-wal'])}`
}

export interface ContactSyncSource {
  con: Db
  cleanup(): void
  shouldYield(): boolean
  /** 複製「前」量到的來源簽章。 */
  source?: SourceSigLike
}

export type ContactSyncCounts = Record<EntityKind, number>

export interface ContactSyncStatus {
  phase: string
  scans: number
  counts: ContactSyncCounts
  /** 最近一次完整掃描寫入（新增或變動）的列數。 */
  written: number
  deleted: number
  doneAt: string | null
  lastBurstMs: number | null
  errors: number
}

export interface ContactSyncBudget {
  sliceMs?: number
  burstMs?: number
  startDelayMs?: number
  /** 簽章閘的輪詢間隔（預設 15 s）。 */
  pollMs?: number
  /** 兩次掃描之間的最短間隔（預設 5 min）。 */
  minIntervalMs?: number
  sourceRetryMs?: number
  sourceRetryMaxMs?: number
  errorBackoffMs?: number
  errorBackoffMaxMs?: number
  minSleepMs?: number
  sleepFactor?: number
}

export interface ContactSyncOptions {
  getDb(): Database | null
  openSource(): Promise<ContactSyncSource | null>
  /** 目前 LINE 來源的簽章（正規化後的字串）；null＝量不到。 */
  currentSig(): string | null
  now?(): number
  wallClock?(): number
  sleep?(ms: number): Promise<void>
  yieldLoop?(): Promise<void>
  trace?(phase: 'contact_sync', ms: number): void
  log?(line: string): void
  onSlice?(info: { ms: number; rows: number }): void
  budget?: ContactSyncBudget
}

export interface ContactSync {
  start(): void
  dispose(): Promise<void>
  status(): ContactSyncStatus
}

const DEFAULTS = {
  sliceMs: 15, burstMs: 300, startDelayMs: 30_000, pollMs: CONTACT_SYNC_POLL_MS, minIntervalMs: CONTACT_SYNC_MIN_INTERVAL_MS,
  sourceRetryMs: 30_000, sourceRetryMaxMs: 5 * 60_000, errorBackoffMs: 30_000, errorBackoffMaxMs: 10 * 60_000, minSleepMs: 100, sleepFactor: 3
}
const LIMIT_INIT = 200
const LIMIT_MIN = 50
const LIMIT_MAX = 1000
const FAST_QUERY_MS = 5

const emptyCounts = (): ContactSyncCounts => ({ contact: 0, group: 0, square_chat: 0 })

export const CONTACT_SYNC_OFF_STATUS: ContactSyncStatus = { phase: 'off', scans: 0, counts: emptyCounts(), written: 0, deleted: 0, doneAt: null, lastBurstMs: null, errors: 0 }

interface ScanState {
  startSig: string
  kindIndex: number
  cursor: KeysetCursor | null
  seen: Record<EntityKind, Set<string>>
  counts: ContactSyncCounts
  skipped: Set<EntityKind>
  written: number
  deleted: number
}

function parseCounts(text: string | null): Partial<ContactSyncCounts> {
  if (!text) return {}
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const out: Partial<ContactSyncCounts> = {}
    for (const kind of ENTITY_KINDS) if (typeof parsed[kind] === 'number' && Number.isFinite(parsed[kind])) out[kind] = parsed[kind] as number
    return out
  } catch {
    return {}
  }
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null)

function fetchPage(con: Db, kind: EntityKind, cursor: KeysetCursor | null, limit: number): KeysetPage<Record<string, unknown>> | null {
  if (kind === 'contact') return contactRowsAfter(con, cursor, limit) as KeysetPage<Record<string, unknown>> | null
  if (kind === 'group') return groupRowsAfter(con, cursor, limit) as KeysetPage<Record<string, unknown>> | null
  return squareChatRowsAfter(con, cursor, limit) as KeysetPage<Record<string, unknown>> | null
}

/** 一列來源 → 要存的欄位；規則和 production 的 profileSource／chatName／chatAvatarSource 同一份純函式。 */
function toEntity(kind: EntityKind, row: Record<string, unknown>): EntityInput | null {
  if (kind === 'contact') {
    const mid = row._mid
    if (!isValidEntityMid(mid)) return null
    const locator = contactLocator(row)
    return { kind, mid, source: locator ? 'profile' : null, locator, displayName: contactName(row) }
  }
  if (kind === 'group') {
    const mid = row._chatMid
    if (!isValidEntityMid(mid)) return null
    const locator = groupLocator(row)
    return { kind, mid, source: locator ? 'profile' : null, locator, displayName: row._chatName ? (row._chatName as string) : null }
  }
  const mid = row._squareChatMid
  if (!isValidEntityMid(mid)) return null
  const locator = squareChatLocator(row)
  return { kind, mid, source: locator ? 'square' : null, locator, displayName: text(row._name) }
}

export function createContactSync(options: ContactSyncOptions): ContactSync {
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
  const log = (line: string): void => { try { options.log?.(line) } catch { /* 日誌不能影響同步 */ } }

  let disposed = false
  let running: Promise<void> | null = null
  let scan: ScanState | null = null
  let limit = LIMIT_INIT
  const status: ContactSyncStatus = { phase: 'pending', scans: 0, counts: emptyCounts(), written: 0, deleted: 0, doneAt: null, lastBurstMs: null, errors: 0 }

  const readDb = (): Database | null => {
    if (disposed) return null
    const db = options.getDb()
    return db && isLineAvatarSchemaReady(db) && isLineEntitySchemaReady(db) ? db : null
  }

  /** 版本不符（含第一次）立刻掃；否則簽章有變、而且距上次完成滿最短間隔才掃。 */
  function isDue(db: Database): boolean {
    if (getAvatarMeta(db, 'contact_sync_version') !== String(CONTACT_SYNC_VERSION)) return true
    const sig = options.currentSig()
    if (sig === null || sig === getAvatarMeta(db, 'contact_sync_sig')) return false
    const doneAt = Number(getAvatarMeta(db, 'contact_sync_done_at'))
    if (!Number.isFinite(doneAt)) return true
    const elapsed = wall() - doneAt
    return elapsed < 0 || elapsed >= budget.minIntervalMs
  }

  function beginScan(startSig: string): ScanState {
    return {
      startSig, kindIndex: 0, cursor: null, counts: emptyCounts(), skipped: new Set(), written: 0, deleted: 0,
      seen: { contact: new Set(), group: new Set(), square_chat: new Set() }
    }
  }

  /** 某個 kind 完整讀完：資料庫裡有、但這輪沒看到的列刪除（差集在記憶體做）。 */
  function finishKind(db: Database, state: ScanState, kind: EntityKind): void {
    const seen = state.seen[kind]
    const missing = entityMids(db, kind).filter((mid) => !seen.has(mid))
    if (missing.length > 0) state.deleted += deleteEntities(db, kind, missing)
    seen.clear()
  }

  function complete(db: Database, state: ScanState): void {
    const scanned = ENTITY_KINDS.filter((kind) => !state.skipped.has(kind))
    const counts: ContactSyncCounts = { ...emptyCounts(), ...parseCounts(getAvatarMeta(db, 'contact_sync_counts')) }
    for (const kind of scanned) counts[kind] = state.counts[kind]
    const at = wall()
    db.transaction(() => {
      setAvatarMeta(db, 'entity_schema_version', '1')
      setAvatarMeta(db, 'contact_sync_counts', JSON.stringify(counts))
      setAvatarMeta(db, 'contact_sync_sig', state.startSig)
      setAvatarMeta(db, 'contact_sync_done_at', String(at))
      setAvatarMeta(db, 'contact_sync_version', String(CONTACT_SYNC_VERSION))
    })()
    status.scans += 1
    status.counts = counts
    status.written = state.written
    status.deleted = state.deleted
    status.doneAt = new Date(at).toISOString()
    status.phase = 'done'
    scan = null
  }

  /** 一個切片（最多一頁）。回傳 true＝整輪完成。 */
  function step(db: Database, con: Db, accountMid: string, state: ScanState): boolean {
    const sliceStart = clock()
    while (state.kindIndex < ENTITY_KINDS.length) {
      const kind = ENTITY_KINDS[state.kindIndex]
      const queryStart = clock()
      const page = fetchPage(con, kind, state.cursor, limit)
      const queryMs = clock() - queryStart
      if (page === null) {
        state.skipped.add(kind)
        state.kindIndex += 1
        state.cursor = null
        continue
      }
      const entities: EntityInput[] = []
      for (const row of page.rows) {
        const entity = toEntity(kind, row)
        if (entity && entity.mid !== accountMid) entities.push(entity)
      }
      const stamp = wall()
      const tx = db.transaction(() => {
        for (const entity of entities) {
          state.seen[kind].add(entity.mid)
          if (upsertEntity(db, entity, stamp)) state.written += 1
        }
      })
      tx()
      state.counts[kind] += entities.length
      options.onSlice?.({ ms: clock() - sliceStart, rows: page.rows.length })
      if (queryMs > budget.sliceMs) limit = Math.max(LIMIT_MIN, limit >> 1)
      else if (queryMs < FAST_QUERY_MS) limit = Math.min(LIMIT_MAX, limit * 2)
      if (page.next) {
        state.cursor = page.next
        return false
      }
      finishKind(db, state, kind)
      state.kindIndex += 1
      state.cursor = null
      if (state.kindIndex < ENTITY_KINDS.length) return false
    }
    complete(db, state)
    return true
  }

  function load(db: Database): void {
    status.counts = { ...emptyCounts(), ...parseCounts(getAvatarMeta(db, 'contact_sync_counts')) }
    const doneAt = Number(getAvatarMeta(db, 'contact_sync_done_at'))
    status.doneAt = Number.isFinite(doneAt) && doneAt > 0 ? new Date(doneAt).toISOString() : null
  }

  async function run(): Promise<void> {
    await sleep(budget.startDelayMs)
    let sourceWait = budget.sourceRetryMs
    let errorWait = budget.errorBackoffMs
    while (!disposed) {
      const db = readDb()
      if (!db) {
        if (!disposed) status.phase = 'schema_unavailable'
        scan = null
        await sleep(budget.sourceRetryMs)
        continue
      }
      let source: ContactSyncSource | null = null
      try {
        if (!scan) {
          if (status.scans === 0 && status.doneAt === null) load(db)
          if (!isDue(db)) {
            status.phase = status.scans > 0 || status.doneAt ? 'done' : 'idle'
            await sleep(budget.pollMs)
            continue
          }
        }
        source = await options.openSource()
      } catch {
        status.errors += 1
        status.phase = 'error'
        log('[contact-sync] read_failed')
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
        // 認不出自己的 MID 就不能保證不把自己寫進去：整個 burst 不處理，等下一次再試。
        if (!accountMid) accountUnknown = true
        else sourceWait = budget.sourceRetryMs
        while (!disposed && accountMid) {
          const current = readDb()
          if (!current) break
          if (!scan) scan = beginScan(normalizeSourceSig(source.source))
          status.phase = 'scanning'
          finished = step(current, source.con, accountMid, scan)
          if (finished || source.shouldYield() || clock() - burstStart >= budget.burstMs) break
          await yieldLoop()
        }
        errorWait = budget.errorBackoffMs
      } catch {
        failed = true
        scan = null
        const after = disposed ? null : options.getDb()
        if (after && !isLineEntitySchemaReady(after)) {
          status.phase = 'schema_unavailable'
          log('[contact-sync] schema_unavailable')
        } else {
          status.errors += 1
          status.phase = 'error'
          log('[contact-sync] read_failed')
        }
      } finally {
        try { source.cleanup() } catch { /* 已關閉 */ }
      }
      if (accountUnknown) {
        status.phase = 'account_unknown'
        log('[contact-sync] account_unknown')
        await sleep(sourceWait)
        sourceWait = Math.min(budget.sourceRetryMaxMs, sourceWait * 2)
        continue
      }
      const burstMs = clock() - burstStart
      status.lastBurstMs = Math.round(burstMs)
      try { options.trace?.('contact_sync', Math.round(burstMs)) } catch { /* 觀測不能影響同步 */ }
      if (disposed) break
      if (finished) {
        log('[contact-sync] done')
        await sleep(budget.pollMs)
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
      running = run().catch(() => { log('[contact-sync] stopped_unexpectedly') })
    },
    async dispose() {
      disposed = true
      scan = null
      abort.abort()
      if (running) await running
    },
    status: () => ({ ...status, counts: { ...status.counts } })
  }
}
