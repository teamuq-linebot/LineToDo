import { join, relative, isAbsolute } from 'node:path'
import type { Database } from 'better-sqlite3'
import { isMediaIndexSchemaReady, openMediaIndexStore } from '../../main/db/mediaIndex.repo'
import type { MediaDirRecord, MediaIndexStore } from '../../main/db/mediaIndex.repo'
import type { LineDirEntry, LineFsPort } from '../../main/line/engine/fsPort'

/**
 * mediaIndex.ts — LINE Cache 圖片索引（設計 §5.4）：把「size → .eimg 路徑」存進 app DB，背景切片掃描，`media.prepare` 只查索引、絕不同步走訪 Cache。
 *
 * 查詢：`candidates(size)` 是一個帶 size 前綴的主鍵查詢（µs 等級）；索引沒有 ready 也照查（掃了一半的結果照樣可用），查不到才由呼叫端回 not_cached，
 * 並用 `isReady()` 區分「LINE 還沒下載」與「索引建立中」。任何失敗（DB 關了、表壞了、Cache 根換了還沒重建）一律回空陣列，不丟例外。
 *
 * 掃描（背景，單一 pass）：
 *   - 目錄佇列（從根開始、先進先出）；每個切片最多 `sliceMaxDirs`（20）個目錄、`sliceMs`（15 ms）或約 `sliceMaxRows`（2,000）列，同一個 transaction，之後讓出事件迴圈。
 *   - `readDir(dir, {stat:true})` 一次帶回 size 與 mtimeNs（Win32 取自 FindData；Node 版退回 stat），不再逐檔 stat；沒帶 size 的檔案才逐檔 stat，stat 失敗就略過該檔。
 *   - delta（平常）：子目錄的 mtime 沒變而且上次列的時候沒有子目錄 → 不列；有子目錄的一律重列（約 1,300 個非葉目錄）。
 *     初次與完整重列（full）：已經在這一輪（gen）列過的葉目錄略過，所以可以跨重啟續跑；非葉目錄照列（要靠它找子目錄）。
 *   - 記錄的 mtime 是「父目錄列舉時看到的值」，早於列自己的時間：列完之後目錄又變了，下一次 delta 一定看得出來。
 *   - 重列後沒再看到的檔案標 stale（不是刪除；LINE 清掉 Cache 後我們也不會再去讀）；stale 超過 30 天分批（每批 ≤500）刪除。整個消失的子目錄連同底下的檔案一併標 stale。
 *   - 24 小時（`fullRelistMs`）做一次完整重列當保險：葉目錄新增檔案時目錄 mtime 會更新是假設，NTFS 的 mtime 可能延遲（設計 R7）。
 * 觸發：`start()` 後延遲 5 s 開始（已完成的只跑 delta）；`noteMiss()` 節流 30 s、同時只跑一個；`onUnreadable` ＝ `markStale` ＋ `noteMiss`。
 *   掃描進行中收到的 miss 不丟：記成「待補一次」（不論來幾次都只有一次），那一輪結束後補排一個 delta，仍然從「上一輪開始」算起受 30 s 節流限制（`noteMiss` 的排程規則不變）。
 * 失敗（根目錄讀不到、DB 例外）退避 30 s 起、上限 10 分鐘；`dispose()` 讓進行中的切片收尾，之後不再碰 DB 或檔案系統。
 * 狀態與日誌都不含檔案路徑、msgId 或任何金鑰。
 */

export interface MediaIndexStatus {
  /** 表可用、連線在（建表失敗或 backend 已停止＝false）。 */
  available: boolean
  /** 初次掃描完成、而且索引是為目前這個 Cache 根建的。 */
  ready: boolean
  rows: number
  scanning: boolean
  lastScanMs: number | null
  lastRefreshAt: number | null
  mode: 'idle' | 'initial' | 'delta' | 'full'
  passes: number
  dirsListed: number
  errors: number
  misses: number
}

export interface MediaIndex {
  /** 絕對路徑，只含 live。 */
  candidates(size: number): string[]
  markStale(absPath: string): void
  /** 讀檔失敗：標 stale、強制該目錄下次重列，並要求一次（節流過的）refresh。 */
  onUnreadable(absPath: string): void
  noteMiss(): void
  start(): void
  dispose(): Promise<void>
  isAvailable(): boolean
  isReady(): boolean
  status(): MediaIndexStatus
}

export interface MediaIndexBudget {
  startDelayMs?: number
  sliceMaxDirs?: number
  sliceMs?: number
  sliceMaxRows?: number
  refreshMinIntervalMs?: number
  fullRelistMs?: number
  staleKeepMs?: number
  purgeBatch?: number
  errorBackoffMs?: number
  errorBackoffMaxMs?: number
}

export interface MediaIndexOptions {
  /** 目前的 app DB（建表失敗或尚未開啟＝null；索引功能因此關閉，不會退回任何同步掃描）。 */
  getDb(): Database | null
  fs: Pick<LineFsPort, 'readDir' | 'stat' | 'exists'>
  cacheDir: string
  /** 時鐘（ms，牆上時間）：24 小時重列、30 天清除、節流都用它。 */
  now?(): number
  /** 單調時鐘（ms）：切片預算用。 */
  clock?(): number
  yieldLoop?(): Promise<void>
  /** 計時器；回傳取消函式。預設 `setTimeout`（unref）。 */
  timer?(fn: () => void, ms: number): () => void
  /** 每個切片結束時呼叫（assemble 轉成 `bg` 事件，trace 自己依門檻過濾）。 */
  trace?(phase: 'media_index', ms: number): void
  log?(line: string): void
  onSlice?(info: { dirs: number; rows: number; ms: number; mode: 'initial' | 'delta' | 'full' }): void
  onPurge?(deleted: number): void
  budget?: MediaIndexBudget
}

const DEFAULTS = {
  startDelayMs: 5_000, sliceMaxDirs: 20, sliceMs: 15, sliceMaxRows: 2_000, refreshMinIntervalMs: 30_000,
  fullRelistMs: 24 * 60 * 60 * 1000, staleKeepMs: 30 * 24 * 60 * 60 * 1000, purgeBatch: 500, errorBackoffMs: 30_000, errorBackoffMaxMs: 10 * 60_000
}
const MAX_TIMER_MS = 2_147_483_647

export const MEDIA_INDEX_OFF_STATUS: MediaIndexStatus = {
  available: false, ready: false, rows: 0, scanning: false, lastScanMs: null, lastRefreshAt: null, mode: 'idle', passes: 0, dirsListed: 0, errors: 0, misses: 0
}

interface QueueItem { path: string; mtime: string }
interface PassState { gen: number; mode: 'initial' | 'delta' | 'full'; dirs: Map<string, MediaDirRecord>; children: Map<string, Set<string>> }

class RootUnreadable extends Error {}

const defaultTimer = (fn: () => void, ms: number): (() => void) => {
  const handle = setTimeout(fn, Math.min(Math.max(0, ms), MAX_TIMER_MS))
  handle.unref?.()
  return () => clearTimeout(handle)
}

const parentOf = (dirPath: string): string => { const i = dirPath.lastIndexOf('/'); return i < 0 ? '' : dirPath.slice(0, i) }
const isEimgName = (name: string): boolean => name.toLowerCase().endsWith('.eimg')
const safeName = (name: string): boolean => name.length > 0 && !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..'

export function createMediaIndex(options: MediaIndexOptions): MediaIndex {
  const budget = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options.budget ?? {}).filter(([, v]) => typeof v === 'number' && Number.isFinite(v))) }
  const wall = options.now ?? (() => Date.now())
  const clock = options.clock ?? (() => performance.now())
  const yieldLoop = options.yieldLoop ?? (() => new Promise<void>((resolve) => { setTimeout(resolve, 0) }))
  const timer = options.timer ?? defaultTimer
  const root = options.cacheDir
  const log = (line: string): void => { try { options.log?.(line) } catch { /* 日誌不能影響索引 */ } }

  let disposed = false
  let started = false
  /** 啟動延遲或失敗退避的計時器還在等：`noteMiss` 不能插隊（延遲是為了不和開機搶資源，退避是為了不要連續重試）。 */
  let hold = false
  let running: Promise<void> | null = null
  /** 掃描進行中收到過 miss：那一輪結束後補排一次 delta（最多一次，受節流限制）。 */
  let pendingMiss = false
  let cancelTimer: (() => void) | null = null
  let lastPassStartedAt = Number.NEGATIVE_INFINITY
  let errorWait: number = budget.errorBackoffMs
  let unavailable = false
  let ready: boolean | null = null
  let rootMatches: boolean | null = null
  /** live 列數：每個切片在同一個 transaction 裡遞增更新並存進 meta `live_rows`（開啟連線時讀回），`status()` 不必整表 count。 */
  let liveRows = 0
  let cached: { db: Database; store: MediaIndexStore } | null = null
  let pass: PassState | null = null
  const stat = { scanning: false, lastScanMs: null as number | null, lastRefreshAt: null as number | null, mode: 'idle' as MediaIndexStatus['mode'], passes: 0, dirsListed: 0, errors: 0, misses: 0 }

  const clearTimer = (): void => { if (cancelTimer) { cancelTimer(); cancelTimer = null } }

  /** 目前連線的語句組；DB 不在、已 dispose、建表失敗（語句準備不起來）都回 null。 */
  const getStore = (): MediaIndexStore | null => {
    if (disposed || unavailable) return null
    let db: Database | null
    try { db = options.getDb() } catch { return null }
    if (!db) return null
    if (cached && cached.db === db) return cached.store
    try {
      if (!isMediaIndexSchemaReady(db)) { unavailable = true; log('[media-index] schema_unavailable'); return null }
      const store = openMediaIndexStore(db)
      cached = { db, store }
      ready = null
      rootMatches = null
      const stored = Number(store.getMeta('live_rows'))
      liveRows = Number.isInteger(stored) && stored >= 0 ? stored : 0
      return store
    } catch {
      unavailable = true
      log('[media-index] schema_unavailable')
      return null
    }
  }

  const loadFlags = (store: MediaIndexStore): void => {
    try {
      rootMatches = store.getMeta('cache_root') === root
      ready = rootMatches && store.getMeta('initial_scan_done') === '1'
    } catch { rootMatches = false; ready = false }
  }

  const absPath = (dirPath: string, name: string): string => join(root, ...dirPath.split('/').filter(Boolean), name)

  const forgetDir = (state: PassState, dirPath: string): void => {
    const prefix = `${dirPath}/`
    for (const key of [...state.dirs.keys()]) if (key === dirPath || key.startsWith(prefix)) { state.dirs.delete(key); state.children.delete(key) }
    state.children.get(parentOf(dirPath))?.delete(dirPath.slice(dirPath.lastIndexOf('/') + 1))
  }

  /** 列一個目錄、更新它的檔案列與子目錄記錄；回傳寫入（含標 stale）的列數與 live 列數的增減。 */
  function listDir(store: MediaIndexStore, state: PassState, item: QueueItem, queue: QueueItem[]): { rows: number; live: number } {
    const abs = item.path === '' ? root : join(root, ...item.path.split('/'))
    let entries: LineDirEntry[]
    try {
      entries = options.fs.readDir(abs, { stat: true })
    } catch {
      if (item.path === '') throw new RootUnreadable('root_unreadable')
      stat.errors += 1
      let gone = false
      try { gone = !options.fs.exists(abs) } catch { gone = false }
      if (gone) {
        const rows = store.markStaleTree(item.path, wall())
        store.deleteDirTree(item.path)
        forgetDir(state, item.path)
        return { rows, live: -rows }
      }
      return { rows: 0, live: 0 }
    }
    stat.dirsListed += 1
    const { gen, mode } = state
    let rows = 0
    let live = 0

    const listed = new Map<string, { size: number; name: string }>()
    for (const entry of entries) {
      if (!entry.isFile || !isEimgName(entry.name) || !safeName(entry.name)) continue
      let size = entry.size
      if (typeof size !== 'number') {
        try { size = options.fs.stat(join(abs, entry.name)).size } catch { continue }
      }
      if (!Number.isSafeInteger(size) || size < 0) continue
      listed.set(`${size}\0${entry.name}`, { size, name: entry.name })
    }
    const existing = new Map<string, 'live' | 'stale'>()
    for (const row of store.dirRows(item.path)) existing.set(`${row.size}\0${row.name}`, row.state)
    for (const [key, file] of listed) {
      if (existing.get(key) === 'live' && mode === 'delta') continue
      store.upsertLive(file.size, item.path, file.name, gen)
      rows += 1
      if (existing.get(key) !== 'live') live += 1
    }
    for (const [key, status] of existing) {
      if (status !== 'live' || listed.has(key)) continue
      const sep = key.indexOf('\0')
      live -= store.markStale(Number(key.slice(0, sep)), item.path, key.slice(sep + 1), wall())
      rows += 1
    }

    const names = new Set<string>()
    for (const entry of entries) {
      if (!entry.isDirectory || !safeName(entry.name)) continue
      names.add(entry.name)
      const childPath = item.path === '' ? entry.name : `${item.path}/${entry.name}`
      const mtime = entry.mtimeNs !== undefined ? entry.mtimeNs.toString() : ''
      const known = state.dirs.get(childPath)
      const skip = known !== undefined && !known.hasSubdirs && (mode === 'delta' ? mtime !== '' && known.mtimeNs === mtime : known.listedGen === gen)
      if (!skip) queue.push({ path: childPath, mtime })
    }
    for (const previous of state.children.get(item.path) ?? []) {
      if (names.has(previous)) continue
      const childPath = item.path === '' ? previous : `${item.path}/${previous}`
      const removed = store.markStaleTree(childPath, wall())
      rows += removed
      live -= removed
      store.deleteDirTree(childPath)
      forgetDir(state, childPath)
    }
    state.children.set(item.path, names)
    store.upsertDir(item.path, item.mtime, names.size > 0, gen)
    state.dirs.set(item.path, { dirPath: item.path, mtimeNs: item.mtime, hasSubdirs: names.size > 0, listedGen: gen })
    return { rows, live }
  }

  async function runPass(): Promise<'done' | 'skipped' | 'aborted'> {
    const store = getStore()
    if (!store) return 'skipped'
    const t0 = clock()
    if (store.getMeta('cache_root') !== root) {
      store.transaction(() => { store.reset(); store.setMeta('cache_root', root) })
      liveRows = 0
    }
    let gen = Number(store.getMeta('gen'))
    if (!Number.isInteger(gen) || gen < 1) { gen = 1; store.setMeta('gen', '1') }
    loadFlags(store)
    const initialDone = store.getMeta('initial_scan_done') === '1'
    const lastFullAt = Number(store.getMeta('last_full_at'))
    const age = wall() - lastFullAt
    let mode: PassState['mode']
    if (!initialDone) mode = 'initial'
    else if (store.getMeta('full_gen_done') !== String(gen)) mode = 'full'
    else if (!Number.isFinite(age) || age < 0 || age >= budget.fullRelistMs) { gen += 1; store.setMeta('gen', String(gen)); mode = 'full' }
    else mode = 'delta'
    stat.mode = mode

    const dirs = new Map<string, MediaDirRecord>()
    const children = new Map<string, Set<string>>()
    for (const record of store.loadDirs()) {
      dirs.set(record.dirPath, record)
      if (record.dirPath === '') continue
      const parent = parentOf(record.dirPath)
      let set = children.get(parent)
      if (!set) { set = new Set(); children.set(parent, set) }
      set.add(record.dirPath.slice(record.dirPath.lastIndexOf('/') + 1))
    }
    const state: PassState = { gen, mode, dirs, children }
    pass = state
    const queue: QueueItem[] = [{ path: '', mtime: '' }]
    let head = 0
    try {
      while (head < queue.length) {
        if (disposed) return 'aborted'
        const sliceStart = clock()
        let dirsDone = 0
        let rowsDone = 0
        let liveDelta = 0
        store.transaction(() => {
          while (head < queue.length) {
            if (dirsDone > 0 && (dirsDone >= budget.sliceMaxDirs || clock() - sliceStart >= budget.sliceMs || rowsDone >= budget.sliceMaxRows)) break
            const listed = listDir(store, state, queue[head++], queue)
            rowsDone += listed.rows
            liveDelta += listed.live
            dirsDone += 1
          }
          if (liveDelta !== 0) store.setMeta('live_rows', String(liveRows + liveDelta))
        })
        liveRows += liveDelta
        const ms = clock() - sliceStart
        try { options.trace?.('media_index', Math.round(ms)) } catch { /* 觀測不能影響索引 */ }
        try { options.onSlice?.({ dirs: dirsDone, rows: rowsDone, ms, mode }) } catch { /* 測試觀察用 */ }
        if (head < queue.length) await yieldLoop()
      }
      if (disposed) return 'aborted'
      if (mode !== 'delta') {
        store.transaction(() => {
          store.setMeta('initial_scan_done', '1')
          store.setMeta('full_gen_done', String(gen))
          store.setMeta('last_full_at', String(wall()))
        })
      }
      for (;;) {
        if (disposed) return 'aborted'
        const deleted = store.purgeStale(wall() - budget.staleKeepMs, budget.purgeBatch)
        try { options.onPurge?.(deleted) } catch { /* 測試觀察用 */ }
        if (deleted < budget.purgeBatch) break
        await yieldLoop()
      }
      loadFlags(store)
      stat.lastScanMs = Math.round(clock() - t0)
      stat.lastRefreshAt = wall()
      stat.passes += 1
      return 'done'
    } finally {
      pass = null
    }
  }

  function arm(): void {
    clearTimer()
    if (disposed || !started) return
    const store = getStore()
    if (!store) return
    if (ready === null) loadFlags(store)
    if (!ready) return
    const lastFullAt = Number(store.getMeta('last_full_at'))
    const delay = Number.isFinite(lastFullAt) ? Math.max(0, lastFullAt + budget.fullRelistMs - wall()) : 0
    cancelTimer = timer(launch, delay)
  }

  function launch(): void {
    if (running || disposed) return
    clearTimer()
    hold = false
    lastPassStartedAt = wall()
    stat.scanning = true
    let outcome: 'done' | 'skipped' | 'aborted' | 'failed' = 'failed'
    running = runPass()
      .then((result) => { outcome = result })
      .catch((error: unknown) => {
        stat.errors += 1
        log(error instanceof RootUnreadable ? '[media-index] root_unreadable' : '[media-index] scan_failed')
      })
      .finally(() => {
        running = null
        stat.scanning = false
        const queuedMiss = pendingMiss
        pendingMiss = false
        if (disposed || outcome === 'aborted') return
        if (outcome === 'failed') {
          hold = true
          cancelTimer = timer(launch, errorWait)
          errorWait = Math.min(budget.errorBackoffMaxMs, errorWait * 2)
          return
        }
        errorWait = budget.errorBackoffMs
        if (outcome === 'done') arm()
        if (queuedMiss) scheduleQueuedRefresh()
      })
  }

  /** 掃描中收到的 miss：上一輪開始後滿 `refreshMinIntervalMs` 才跑（已經滿了就下一個 tick），之間不接受 `noteMiss` 插隊。 */
  function scheduleQueuedRefresh(): void {
    if (disposed || !started || !getStore()) return
    const wait = Math.max(0, lastPassStartedAt + budget.refreshMinIntervalMs - wall())
    clearTimer()
    hold = true
    cancelTimer = timer(launch, wait)
  }

  const markStaleRow = (path: unknown): void => {
    if (typeof path !== 'string' || path.length === 0) return
    const store = getStore()
    if (!store) return
    const rel = relative(root, path)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return
    const parts = rel.split(/[\\/]/).filter(Boolean)
    const name = parts.pop()
    if (!name) return
    const dirPath = parts.join('/')
    try {
      const changed = store.markStaleByName(dirPath, name, wall())
      if (changed > 0) { liveRows -= changed; store.setMeta('live_rows', String(liveRows)) }
      store.forceRelist(dirPath)
      const record = pass?.dirs.get(dirPath)
      if (record) pass!.dirs.set(dirPath, { ...record, mtimeNs: '', listedGen: 0 })
    } catch { /* 連線剛好關了 */ }
  }

  const isAvailable = (): boolean => {
    if (disposed || unavailable) return false
    try { return options.getDb() !== null } catch { return false }
  }
  const isReady = (): boolean => {
    const store = getStore()
    if (!store) return false
    if (ready === null) loadFlags(store)
    return ready === true
  }
  const noteMiss = (): void => {
    stat.misses += 1
    if (disposed || !started || hold) return
    if (running) { pendingMiss = true; return }
    if (wall() - lastPassStartedAt < budget.refreshMinIntervalMs) return
    if (!getStore()) return
    // 呼叫端（media.prepare）是同步的：掃描排到下一個計時器才開始，這個呼叫本身不做任何目錄列舉。
    clearTimer()
    hold = true
    cancelTimer = timer(launch, 0)
  }

  return {
    candidates(size: number): string[] {
      if (!Number.isSafeInteger(size) || size < 0) return []
      const store = getStore()
      if (!store) return []
      try {
        if (rootMatches === null) loadFlags(store)
        if (!rootMatches) return []
        return store.candidates(size).map((row) => absPath(row.dirPath, row.name))
      } catch {
        return []
      }
    },
    markStale: markStaleRow,
    onUnreadable(path: string): void {
      markStaleRow(path)
      noteMiss()
    },
    noteMiss,
    start(): void {
      if (started || disposed) return
      started = true
      hold = true
      cancelTimer = timer(launch, budget.startDelayMs)
    },
    async dispose(): Promise<void> {
      disposed = true
      clearTimer()
      if (running) await running
      cached = null
    },
    isAvailable,
    isReady,
    status(): MediaIndexStatus {
      getStore()
      return {
        available: isAvailable(), ready: isReady(), rows: liveRows, scanning: stat.scanning,
        lastScanMs: stat.lastScanMs, lastRefreshAt: stat.lastRefreshAt, mode: stat.mode, passes: stat.passes,
        dirsListed: stat.dirsListed, errors: stat.errors, misses: stat.misses
      }
    }
  }
}
