/**
 * lineAccess.ts — 開 LINE DB 的單一入口（外掛 backend）：持久 snapshot + 共用金鑰。
 *
 * 呼叫端（poll 匯入、reconcile、resetNow、頭像）都經 `openLineDbFor({ policy })`：
 *   - `fresh`：要「這一刻」的資料。解析金鑰（記憶體 → env／.linekey／掃描，順序與退避照原本）、`acquire(src, 'fresh')`（簽章沒變＝零複製）、
 *     用 `openSnapshotDb` 開。金鑰的驗證就是這一次開檔，不另外複製整份 DB（`GetKeyOptions.skipValidate`）。
 *   - `any`：容許過期（頭像）。只用記憶體裡已經驗證過的金鑰與現成的 snapshot；沒有金鑰或沒有 snapshot 就回 null。
 *     這條路徑絕不解析金鑰、不掃描 LINE 記憶體、不觸發任何複製。
 *
 * `fresh` 開不起來時（錯 key 與損壞的副本在加密 DB 上長得一樣：都是 `file is not a database`）各重試一次：
 *   1. 這次沒有整份複製過的副本（reuse／wal-only）→ `invalidate()` 讓它失效、重新整份複製、同一把金鑰再開一次（損壞自癒）。
 *   2. 仍然不行 → 作廢記憶體金鑰、重新解析（這次要驗證）、再開一次。再失敗就丟出和現況相同的錯誤。
 *   查詢時才出現 corrupt／malformed／not a database 的錯誤（`fresh` 的連線）：連線外包一層，發現就 `invalidate()`，下一次 `fresh` 會整份重複製。
 *
 * 沒有注入 access（standalone、舊測試、`snapshot.enabled:false`）：`openLineDbFor` 退回「解析金鑰 + `openDb`」的舊流程，行為逐字不變
 * （`any` 的舊流程維持頭像原本的金鑰政策：不讀 env 與 .linekey、金鑰不落地）。
 */
import { getLineEnginePorts } from './enginePorts'
import { findDbPath } from './fsPort'
import { openDb, openSnapshotDb, type Db } from './linedb'
import { getKey, getKeyAsync, type GetKeyOptions } from './linekey'
import type { LineSnapshotStore, SnapshotLease, SnapshotPolicy } from './lineSnapshot'

/** 開好的 LINE DB：`cleanup()` 關連線並釋放 lease（不刪 snapshot）。 */
export interface OpenedLineDb {
  con: Db
  cleanup(): void
  /** 複製「前」量到的來源簽章（舊流程沒有持久 snapshot，兩邊都是 null）。 */
  source: SnapshotLease['source']
  /** 有更新在等這份 snapshot 的 lease 釋放：長時間持有者應該盡快 `cleanup()`。 */
  shouldYield(): boolean
}

export interface OpenLineDbOptions {
  /** LINE 的 edb 路徑；null＝找 `dbDir` 底下最大的 `qw*.edb`。 */
  dbPath: string | null
  policy: SnapshotPolicy
  keyOpts?: GetKeyOptions
  /** 三段金鑰（記憶體／env／cache／掃描）都沒有時丟的錯誤；各呼叫端沿用自己原本的錯誤型別。 */
  keyMissing?: () => Error
}

export interface LineAccess {
  open(options: OpenLineDbOptions & { policy: 'fresh' }): Promise<OpenedLineDb>
  open(options: OpenLineDbOptions & { policy: 'any' }): Promise<OpenedLineDb | null>
  /** 記憶體裡有沒有已驗證的金鑰（診斷用，不含金鑰本身）。 */
  keyHeld(): boolean
  /** 作廢記憶體金鑰（下一次 `fresh` 重新解析）。 */
  forgetKey(): void
}

const NOT_A_DATABASE = /malformed|corrupt|not a database|notadb/i

function defaultKeyMissing(): Error {
  return new Error('LINE DB key unavailable (env/cache/recover all miss)')
}

/** 查詢時發現副本損壞就讓 snapshot 失效（下一次 `fresh` 整份重複製）；錯誤照原樣往上丟。 */
function guardConnection(con: Db, onCorrupt: () => void): Db {
  const guard = <T>(run: () => T): T => {
    try {
      return run()
    } catch (error) {
      if (NOT_A_DATABASE.test(String((error as { message?: unknown } | null)?.message ?? ''))) onCorrupt()
      throw error
    }
  }
  return {
    prepare: (sql) => {
      const statement = guard(() => con.prepare(sql))
      return {
        get: (...params) => guard(() => statement.get(...params)),
        all: (...params) => guard(() => statement.all(...params))
      }
    },
    pragma: (source) => con.pragma(source),
    close: () => con.close()
  }
}

export function createLineAccess(options: { store: LineSnapshotStore }): LineAccess {
  const { store } = options
  let heldKey: string | null = null

  const resolveKey = (dbPath: string, keyOpts: GetKeyOptions, validate: boolean): Promise<string | null> =>
    getKeyAsync({ ...keyOpts, dbPath, skipValidate: !validate })

  const tryOpen = (lease: SnapshotLease, key: string): { con: Db } | { error: unknown } => {
    try {
      return { con: openSnapshotDb(lease.path, key, { checkpoint: false }) }
    } catch (error) {
      return { error }
    }
  }

  const wrap = (con: Db, lease: SnapshotLease, guarded: boolean): OpenedLineDb => {
    let closed = false
    return {
      con: guarded ? guardConnection(con, () => store.invalidate()) : con,
      cleanup: () => {
        if (closed) return
        closed = true
        try { con.close() } catch { /* 已關閉 */ }
        lease.release()
      },
      source: lease.source,
      shouldYield: () => lease.shouldYield()
    }
  }

  async function openFresh(o: OpenLineDbOptions): Promise<OpenedLineDb> {
    const { fs, dbDir } = getLineEnginePorts()
    const src = o.dbPath ?? findDbPath(fs, dbDir)
    if (!src) throw new Error(JSON.stringify({ error: 'LINE message DB not found', dir: dbDir }))
    const keyOpts = o.keyOpts ?? {}
    const missing = o.keyMissing ?? defaultKeyMissing

    let key = heldKey ?? (await resolveKey(src, keyOpts, false))
    if (!key) throw missing()

    const fullBefore = store.stats().fullCopies
    let lease = await store.acquire(src, 'fresh')
    let justCopied = store.stats().fullCopies !== fullBefore
    let attempt = tryOpen(lease, key)

    if ('error' in attempt && !justCopied) {
      lease.release()
      store.invalidate()
      lease = await store.acquire(src, 'fresh')
      justCopied = true
      attempt = tryOpen(lease, key)
    }
    if ('error' in attempt) {
      lease.release()
      heldKey = null
      const renewed = await resolveKey(src, keyOpts, true)
      if (!renewed) throw missing()
      key = renewed
      lease = await store.acquire(src, 'fresh')
      attempt = tryOpen(lease, key)
      if ('error' in attempt) {
        lease.release()
        throw attempt.error
      }
    }
    heldKey = key
    return wrap(attempt.con, lease, true)
  }

  async function openAny(o: OpenLineDbOptions): Promise<OpenedLineDb | null> {
    const key = heldKey
    if (!key) return null
    const lease = await store.acquire(o.dbPath, 'any')
    if (!lease) return null
    const attempt = tryOpen(lease, key)
    if ('error' in attempt) {
      lease.release()
      return null
    }
    return wrap(attempt.con, lease, false)
  }

  const open = (o: OpenLineDbOptions): Promise<OpenedLineDb | null> => (o.policy === 'any' ? openAny(o) : openFresh(o))
  return {
    open: open as LineAccess['open'],
    keyHeld: () => heldKey !== null,
    forgetKey: () => { heldKey = null }
  }
}

async function openLegacy(o: OpenLineDbOptions): Promise<OpenedLineDb> {
  const missing = o.keyMissing ?? defaultKeyMissing
  // 頭像的舊流程：不讀 env 與 .linekey、金鑰只放行程記憶體（沒有持久 snapshot 時維持這個政策）。
  const keyOpts: GetKeyOptions = o.policy === 'any' ? { ...o.keyOpts, skipEnv: true, skipCache: true, cache: false } : { ...o.keyOpts }
  const key = keyOpts.recoverGuard ? await getKeyAsync({ ...keyOpts, dbPath: o.dbPath }) : getKey({ ...keyOpts, dbPath: o.dbPath })
  if (!key) throw missing()
  const { con, cleanup } = openDb(key, o.dbPath)
  return { con, cleanup, source: { edb: null, wal: null }, shouldYield: () => false }
}

/**
 * 開 LINE DB 的單一入口。有注入 `access`（外掛 backend）走持久 snapshot；否則走舊流程（逐字不變）。
 * `fresh` 失敗一律丟錯（沒有金鑰丟 `keyMissing()`）；`any` 沒有金鑰或沒有 snapshot 回 null（舊流程則和先前一樣丟錯）。
 */
export function openLineDbFor(options: OpenLineDbOptions & { policy: 'fresh' }): Promise<OpenedLineDb>
export function openLineDbFor(options: OpenLineDbOptions & { policy: 'any' }): Promise<OpenedLineDb | null>
export function openLineDbFor(options: OpenLineDbOptions): Promise<OpenedLineDb | null> {
  const access = getLineEnginePorts().access
  if (access) return options.policy === 'any' ? access.open({ ...options, policy: 'any' }) : access.open({ ...options, policy: 'fresh' })
  return openLegacy(options)
}
