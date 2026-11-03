/**
 * lineSnapshot.ts — LINE 訊息 DB 的持久 snapshot（外掛 backend 專用）。
 *
 * 為什麼：外掛的 WASM 引擎永遠唯讀開啟 `LineFsPort.copyFile` 複製進 dataDir 的私有副本，而 LINE 主要一直在寫 `-wal`（edb 很少動）。
 * 舊流程每次 `openDb` 都把 edb + -wal + -shm（約 270 MB）整份複製一次，poll、頭像、金鑰驗證、reconcile 各複製各的。
 * 這裡改成一份持久副本，所有讀取共用：只有來源 edb／-wal 的簽章變了才更新，而且更新是非同步的。
 *
 * 目錄結構（`dir` = `<dataDir>/line-engine/snapshot`）：
 *   cur/m.edb、cur/m.edb-wal   目前的 snapshot（讀取者開的就是它）
 *   next/                      更新用的暫存區（啟動時清掉；換檔前不碰 cur）
 *   meta.json                  cur 對應的來源簽章（複製「前」量到的 edb／-wal 的 size+mtime、-wal 檔頭、整份複製的時間）
 *
 * 更新規則（`acquire(src, 'fresh')`）：
 *   - 簽章完全相同：reuse，零複製。
 *   - edb 相同、-wal 不同：只複製 -wal（edb 與 cur 逐位元組相同；-shm 從不複製——唯讀 VFS 的 wal-index 在 heap 內由 -wal 重建）。
 *     守衛：複製完後再量一次 edb、並比對 -wal 前 32 bytes（salt／checkpoint seq）與 meta 記的是否相同，任一不符就作廢、改整份複製。
 *   - 其他：整份複製到 next/，複製完再量一次 edb，和複製前不同就重做（最多 2 次重做），仍不同就接受但 meta 記複製前的簽章
 *     （下一次 acquire 會發現簽章不符而再複製一次，不會把不一致的副本當成最新）。
 *   - single-flight：同時只有一個更新在進行；其他 acquire 等它結束後重新判斷。
 *   - 換檔（rename）要等所有 lease 釋放；等待期間 `shouldYield()` 為 true，讓長時間持有 lease 的背景工作自己放手。
 *   - 複製失敗：cur 與 meta 原封不動，錯誤往上丟。
 *   - 換檔失敗（rename 被外部程式擋住等，不是行程死亡）：把 cur 換回原位、meta 還原，最後一份好的 snapshot 仍可讀（`any` 照樣有副本）；行程死在換檔中途則沒有 meta，重啟後整份複製。
 *   - `close()`：dispose 用。之後 acquire('fresh') 拒絕、'any' 回 null、進行中的更新不再換檔也不寫 meta。
 *   - 啟動時清掉殘留的 next/；meta 有效（版本、來源路徑記錄、cur/m.edb 大小吻合）就沿用，所以重啟後的第一次 poll 通常只需要 wal-only。
 *
 * `acquire(src, 'any')`：容許過期。不量來源簽章、絕不觸發複製；meta 有效就直接給 lease，更新進行中就等它（最多 `anyWaitMs`），沒有可用的副本回 null。
 *
 * 只適用唯讀引擎（WASM）：本地 snapshot 必須一直和來源 edb 逐位元組相同。讀寫引擎（better-sqlite3）在關閉時會 checkpoint 而改動副本，
 * 所以組裝根只在引擎是唯讀時預設開 wal-only；standalone 不使用這個檔案。
 */
import { join } from 'node:path'

import type { LineFsPort } from './fsPort'

export type SnapshotPolicy = 'fresh' | 'any'
export type SnapshotKind = 'reuse' | 'wal' | 'full'

/** 簽章 [size, mtimeNs 的十進位字串]。mtimeNs 保持 bigint 精度（轉成 number 會在 ~1.7e18 失去 256 ns 以下的差異）。 */
type Sig = readonly [number, string]
interface Sigs { edb: Sig | null; wal: Sig | null }

export interface SnapshotLease {
  /** 本地 m.edb；m.edb-wal 在同一個目錄。 */
  readonly path: string
  /** 複製「前」量到的來源簽章（和 `.watch_json_state` 的 `walSig` 同一種 [size, mtimeNs] 形狀）。 */
  readonly source: { edb: [number, number] | null; wal: [number, number] | null }
  release(): void
  /** 有更新正在等這份 snapshot 的 lease 釋放（或排在更新後面）：持有者應該盡快 `release()`。 */
  shouldYield(): boolean
}

export interface LineSnapshotStoreOptions {
  fs: LineFsPort
  dir: string
  /** 預設 true。false＝-wal 變了也整份複製。需要 `fs.readHead`，沒有就等同 false。 */
  walOnly?: boolean
  /** wal-only 距離上次整份複製超過這麼久就改整份複製（預設 6 小時）。簽章完全相同的 reuse 不受影響。 */
  fullResyncMs?: number
  now?(): number
  onSpan?(kind: SnapshotKind, ms: number, bytes: number): void
  /** `any` 最多等進行中的更新多久（預設 10 s）。 */
  anyWaitMs?: number
  /** 換檔前最多等 lease 釋放多久（預設 30 s）；逾時更新失敗（cur 與 meta 不動）。 */
  leaseWaitMs?: number
}

export interface LineSnapshotStats {
  reuse: number
  walCopies: number
  fullCopies: number
  invalidations: number
  copiedBytes: number
  /** 沒有 `copyFileAsync` 的 port 退回同步 `copyFile` 的次數。 */
  syncCopies: number
  lastKind: SnapshotKind | null
  lastMs: number | null
}

interface Meta {
  v: 1
  /** 複製時的來源 edb 路徑。 */
  src: string
  edb: Sig | null
  wal: Sig | null
  /** cur/m.edb-wal 前 32 bytes 的 hex；沒有 -wal 或讀不到＝null。 */
  walHead: string | null
  /** 最近一次整份複製完成的時間（epoch ms）。 */
  fullAt: number
}

const META_VERSION = 1
const WAL_HEAD_BYTES = 32
const DEFAULT_FULL_RESYNC_MS = 6 * 60 * 60 * 1000
const DEFAULT_ANY_WAIT_MS = 10_000
const DEFAULT_LEASE_WAIT_MS = 30_000
const DEFAULT_CLOSE_WAIT_MS = 2_000
/** 整份複製：第一次加最多 2 次重做。 */
const MAX_FULL_ATTEMPTS = 3

function closedError(): Error {
  return new Error('snapshot_closed: the snapshot store was closed')
}

function sigEq(a: Sig | null, b: Sig | null): boolean {
  if (a === null || b === null) return a === b
  return a[0] === b[0] && a[1] === b[1]
}

function toSource(sigs: Sigs): SnapshotLease['source'] {
  const num = (s: Sig | null): [number, number] | null => (s ? [s[0], Number(s[1])] : null)
  return { edb: num(sigs.edb), wal: num(sigs.wal) }
}

function parseSig(value: unknown): Sig | null | undefined {
  if (value === null) return null
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'string') return [value[0], value[1]]
  return undefined
}

function parseMeta(raw: string): Meta | null {
  try {
    const m = JSON.parse(raw) as Record<string, unknown>
    if (m.v !== META_VERSION || typeof m.src !== 'string' || typeof m.fullAt !== 'number') return null
    const edb = parseSig(m.edb)
    const wal = parseSig(m.wal)
    if (edb === undefined || wal === undefined) return null
    if (m.walHead !== null && typeof m.walHead !== 'string') return null
    return { v: META_VERSION, src: m.src, edb, wal, walHead: m.walHead as string | null, fullAt: m.fullAt }
  } catch {
    return null
  }
}

export class LineSnapshotStore {
  private readonly fs: LineFsPort
  private readonly dir: string
  private readonly curDir: string
  private readonly nextDir: string
  private readonly oldDir: string
  private readonly metaFile: string
  private readonly curEdb: string
  private readonly curWal: string
  private readonly nextEdb: string
  private readonly nextWal: string
  private readonly walOnly: boolean
  private readonly fullResyncMs: number
  private readonly now: () => number
  private readonly onSpan: ((kind: SnapshotKind, ms: number, bytes: number) => void) | undefined
  private readonly anyWaitMs: number
  private readonly leaseWaitMs: number

  private loaded = false
  private closed = false
  private meta: Meta | null = null
  /** invalidate() 每呼叫一次加一：進行中的 wal-only 更新看到它變了就放棄（不把根據舊狀態的結果換進去）。 */
  private gen = 0
  private leases = 0
  private flight: Promise<SnapshotLease> | null = null
  private drainWaiters: Array<{ resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }> = []
  private readonly counters: LineSnapshotStats = {
    reuse: 0, walCopies: 0, fullCopies: 0, invalidations: 0, copiedBytes: 0, syncCopies: 0, lastKind: null, lastMs: null
  }

  constructor(options: LineSnapshotStoreOptions) {
    this.fs = options.fs
    this.dir = options.dir
    this.curDir = join(options.dir, 'cur')
    this.nextDir = join(options.dir, 'next')
    this.oldDir = join(options.dir, 'cur.old')
    this.metaFile = join(options.dir, 'meta.json')
    this.curEdb = join(this.curDir, 'm.edb')
    this.curWal = join(this.curDir, 'm.edb-wal')
    this.nextEdb = join(this.nextDir, 'm.edb')
    this.nextWal = join(this.nextDir, 'm.edb-wal')
    this.walOnly = (options.walOnly ?? true) && typeof options.fs.readHead === 'function'
    this.fullResyncMs = options.fullResyncMs ?? DEFAULT_FULL_RESYNC_MS
    this.now = options.now ?? Date.now
    this.onSpan = options.onSpan
    this.anyWaitMs = options.anyWaitMs ?? DEFAULT_ANY_WAIT_MS
    this.leaseWaitMs = options.leaseWaitMs ?? DEFAULT_LEASE_WAIT_MS
  }

  acquire(src: string, policy: 'fresh'): Promise<SnapshotLease>
  acquire(src: string | null, policy: 'any'): Promise<SnapshotLease | null>
  acquire(src: string | null, policy: SnapshotPolicy): Promise<SnapshotLease | null>
  async acquire(src: string | null, policy: SnapshotPolicy): Promise<SnapshotLease | null> {
    if (policy === 'any' && this.closed) return null
    if (this.closed) throw closedError()
    this.load()
    if (policy === 'any') return this.acquireAny(src)
    if (src === null) throw new Error('LINE snapshot: a fresh acquire needs the source path')
    while (this.flight) {
      try { await this.flight } catch { /* 那個更新是別人發起的；失敗由發起者處理，這裡重新判斷 */ }
    }
    if (this.closed) throw closedError()
    // 從這裡到發起更新之間沒有 await：判斷與「占住 flight」是同一個同步區段，不會有兩個更新同時開始。
    const t0 = performance.now()
    const s1 = this.measure(src)
    const kind = this.plan(src, s1)
    if (kind === 'reuse') {
      this.counters.reuse += 1
      this.span('reuse', performance.now() - t0, 0)
      return this.makeLease(s1)
    }
    const flight: Promise<SnapshotLease> = this.update(src, kind, s1, this.gen).finally(() => { if (this.flight === flight) this.flight = null })
    this.flight = flight
    return flight
  }

  /** 讓目前的副本失效（查詢時發現損壞）：meta 清掉，下一次 `fresh` 一定整份複製。已發出的 lease 不受影響（它們開著的檔案不動）。 */
  invalidate(): void {
    if (this.closed) return
    this.load()
    this.gen += 1
    this.meta = null
    this.counters.invalidations += 1
    try { this.fs.removeDir(this.metaFile) } catch { /* 沒有 meta 或刪不掉：記憶體裡已經作廢 */ }
  }

  stats(): LineSnapshotStats {
    return { ...this.counters }
  }

  /**
   * dispose 用：之後不再發出新的 lease、不再換檔、不再寫 meta。等待 lease 的更新立刻失敗；已經在複製的更新無法中止，
   * 最多等它 `waitMs`——它複製完會發現已關閉，只清掉 next/ 就結束（cur 與 meta 原封不動）。
   */
  async close(waitMs = DEFAULT_CLOSE_WAIT_MS): Promise<void> {
    if (!this.closed) {
      this.closed = true
      const waiters = this.drainWaiters
      this.drainWaiters = []
      for (const w of waiters) { clearTimeout(w.timer); w.reject(closedError()) }
    }
    const flight = this.flight
    if (!flight) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const limit = new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); timer.unref?.() })
    try { await Promise.race([flight.then(() => undefined, () => undefined), limit]) } finally { if (timer) clearTimeout(timer) }
  }

  // ── 載入與判斷 ──

  /** 第一次使用時（lazy：沒有用到 snapshot 的 backend 不會在 dataDir 留下任何東西）清掉殘留的 next/、讀 meta。 */
  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      if (!this.fs.exists(this.dir)) return
      try { this.fs.removeDir(this.nextDir) } catch { /* 清不掉就留著，下次更新前會再清 */ }
      try { this.fs.removeDir(this.oldDir) } catch { /* 同上 */ }
      if (!this.fs.exists(this.metaFile)) return
      const meta = parseMeta(this.fs.readTextFile(this.metaFile))
      if (!meta || !meta.edb || !this.fs.exists(this.curEdb)) return
      if (this.fs.stat(this.curEdb).size !== meta.edb[0]) return
      this.meta = meta
    } catch {
      this.meta = null
    }
  }

  private sigOf(path: string): Sig | null {
    try {
      const st = this.fs.stat(path)
      return [st.size, st.mtimeNs.toString()]
    } catch {
      return null
    }
  }

  private measure(src: string): Sigs {
    return { edb: this.sigOf(src), wal: this.sigOf(`${src}-wal`) }
  }

  private plan(src: string, s1: Sigs): SnapshotKind {
    const m = this.meta
    if (!m || m.src !== src || m.edb === null || !this.fs.exists(this.curEdb) || (m.wal !== null && !this.fs.exists(this.curWal))) return 'full'
    if (s1.edb !== null && sigEq(m.edb, s1.edb) && sigEq(m.wal, s1.wal)) return 'reuse'
    if (this.walOnly && s1.edb !== null && sigEq(m.edb, s1.edb) && s1.wal !== null && m.walHead !== null && this.now() - m.fullAt <= this.fullResyncMs) return 'wal'
    return 'full'
  }

  private async acquireAny(src: string | null): Promise<SnapshotLease | null> {
    if (this.flight && !this.closed) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const limit = new Promise<void>((resolve) => { timer = setTimeout(resolve, this.anyWaitMs); timer.unref?.() })
      try { await Promise.race([this.flight.then(() => undefined, () => undefined), limit]) } finally { if (timer) clearTimeout(timer) }
    }
    const m = this.meta
    if (this.closed || !m || m.edb === null || (src !== null && m.src !== src) || !this.fs.exists(this.curEdb)) return null
    return this.makeLease({ edb: m.edb, wal: m.wal })
  }

  // ── lease ──

  private makeLease(sigs: Sigs): SnapshotLease {
    this.leases += 1
    let released = false
    return {
      path: this.curEdb,
      source: toSource(sigs),
      release: () => {
        if (released) return
        released = true
        this.leases -= 1
        if (this.leases === 0) this.flushDrainWaiters()
      },
      shouldYield: () => this.flight !== null
    }
  }

  private flushDrainWaiters(): void {
    const waiters = this.drainWaiters
    this.drainWaiters = []
    for (const w of waiters) { clearTimeout(w.timer); w.resolve() }
  }

  /** 換檔前等所有 lease 釋放；逾時 reject（更新失敗，cur 與 meta 原封不動）。 */
  private waitForLeases(): Promise<void> {
    if (this.closed) return Promise.reject(closedError())
    if (this.leases === 0) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve, reject,
        timer: setTimeout(() => {
          this.drainWaiters = this.drainWaiters.filter((w) => w !== waiter)
          reject(new Error('snapshot_busy: leases were not released in time'))
        }, this.leaseWaitMs)
      }
      waiter.timer.unref?.()
      this.drainWaiters.push(waiter)
    })
  }

  // ── 更新 ──

  private async copy(src: string, dst: string): Promise<void> {
    if (this.fs.copyFileAsync) {
      await this.fs.copyFileAsync(src, dst)
      return
    }
    this.fs.copyFile(src, dst)
    this.counters.syncCopies += 1
  }

  private span(kind: SnapshotKind, ms: number, bytes: number): void {
    this.counters.lastKind = kind
    this.counters.lastMs = Math.round(ms)
    if (!this.onSpan) return
    try { this.onSpan(kind, Math.max(0, Math.round(ms)), bytes) } catch { /* 觀測不能影響讀取 */ }
  }

  private cleanNext(): void {
    try { this.fs.removeDir(this.nextDir) } catch { /* 下次更新前會再清 */ }
  }

  private writeMeta(meta: Meta): void {
    this.meta = meta
    try {
      const tmp = `${this.metaFile}.tmp`
      this.fs.writeTextFile(tmp, JSON.stringify(meta))
      this.fs.renameFile(tmp, this.metaFile)
    } catch {
      // meta 寫不出去：記憶體裡仍然有效；重啟後沒有 meta 就整份複製（保守）。
    }
  }

  private readHeadHex(path: string): string | null {
    try {
      const head = this.fs.readHead!(path, WAL_HEAD_BYTES)
      return head.length === WAL_HEAD_BYTES ? head.toString('hex') : null
    } catch {
      return null
    }
  }

  private async update(src: string, planned: 'wal' | 'full', s1: Sigs, gen: number): Promise<SnapshotLease> {
    const t0 = performance.now()
    let kind: 'wal' | 'full' = planned
    let bytes = 0
    try {
      this.fs.ensureDir(this.dir)
      this.cleanNext()
      this.fs.ensureDir(this.nextDir)
      if (kind === 'wal') {
        const copied = await this.updateWalOnly(src, s1, gen)
        if (copied === null) kind = 'full'
        else bytes = copied
      }
      if (kind === 'full') bytes = await this.updateFull(src, s1)
    } finally {
      this.cleanNext()
    }
    if (kind === 'wal') this.counters.walCopies += 1
    else this.counters.fullCopies += 1
    this.counters.copiedBytes += bytes
    this.span(kind, performance.now() - t0, bytes)
    return this.makeLease(s1)
  }

  /** 只複製 -wal。回傳複製的位元組數；守衛不通過（或 -wal 讀不到）回 null，呼叫端改整份複製。 */
  private async updateWalOnly(src: string, s1: Sigs, gen: number): Promise<number | null> {
    const meta = this.meta
    if (!meta) return null
    try {
      await this.copy(`${src}-wal`, this.nextWal)
    } catch {
      return null
    }
    const edbAfter = this.sigOf(src)
    const head = this.readHeadHex(this.nextWal)
    if (this.gen !== gen || this.meta !== meta || !sigEq(edbAfter, meta.edb) || head === null || head !== meta.walHead) return null
    await this.waitForLeases()
    if (this.closed) throw closedError()
    if (this.gen !== gen || this.meta !== meta) return null
    this.fs.renameFile(this.nextWal, this.curWal)
    this.writeMeta({ ...meta, wal: s1.wal })
    return s1.wal ? s1.wal[0] : 0
  }

  /** 整份複製到 next/，換檔後寫 meta。回傳複製的位元組數。 */
  private async updateFull(src: string, s1: Sigs): Promise<number> {
    let pre = s1
    let walCopied = false
    for (let attempt = 1; ; attempt += 1) {
      await this.copy(src, this.nextEdb)
      walCopied = this.fs.exists(`${src}-wal`)
      if (walCopied) await this.copy(`${src}-wal`, this.nextWal)
      else this.fs.removeDir(this.nextWal)
      const edbAfter = this.sigOf(src)
      if (sigEq(edbAfter, pre.edb) || attempt >= MAX_FULL_ATTEMPTS) break
      pre = this.measure(src)
    }
    const head = walCopied && this.walOnly ? this.readHeadHex(this.nextWal) : null
    await this.waitForLeases()
    if (this.closed) throw closedError()
    this.swapIn()
    this.writeMeta({ v: META_VERSION, src, edb: pre.edb, wal: pre.wal, walHead: head, fullAt: this.now() })
    return (pre.edb ? pre.edb[0] : 0) + (walCopied && pre.wal ? pre.wal[0] : 0)
  }

  /**
   * 把 next/ 換成 cur/。meta 先刪（行程死在換檔中途，下次啟動沒有 meta＝整份複製），舊 cur 先移到 cur.old 而不是直接刪：
   * 任何一步失敗（外部程式握著檔案、rename 被拒）就把 cur.old 換回去、還原 meta，最後一份好的 snapshot 照樣可讀（`any` 不會變成 null），錯誤再往上丟。
   * 換回去也失敗時只能放棄：沒有 meta，下一次 `fresh` 整份複製。
   */
  private swapIn(): void {
    const previous = this.meta
    this.meta = null
    try { this.fs.removeDir(this.metaFile) } catch { /* 沒有 meta */ }
    let moved = false
    try {
      this.fs.removeDir(this.oldDir)
      if (this.fs.exists(this.curDir)) { this.fs.renameFile(this.curDir, this.oldDir); moved = true }
      this.fs.renameFile(this.nextDir, this.curDir)
    } catch (error) {
      let restored = !moved
      if (moved) {
        try { this.fs.removeDir(this.curDir); this.fs.renameFile(this.oldDir, this.curDir); restored = true } catch { /* 換不回去：沒有 meta，下次整份複製 */ }
      }
      if (restored && previous) this.writeMeta(previous)
      throw error
    }
    try { this.fs.removeDir(this.oldDir) } catch { /* load() 與下一次換檔會再清 */ }
  }
}
