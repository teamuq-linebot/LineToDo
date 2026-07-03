/**
 * reconcile.ts — 開機自我對帳「偵測」純模組（Batch 3，設計文件 §決策 B）。
 *
 * 職責：便宜偵測「來源 LINE DB 與 App DB 各月訊息筆數」的落差，找出缺口月。
 * 本批**只偵測、不寫入、不回填、不動 checkpoint**（回填/編排是 Batch 4）。
 *
 * 兩層分離（易測）：
 *   1. DB 聚合（碰 DB）：
 *      - getSourceMonthlyFingerprint(opts) → 開來源加密 DB 一次（複用 linekey.getKey +
 *        linedb.openDb 的 snapshot+WAL-merge 開檔路徑，與 getMessagesSince 一致；只讀），
 *        跑 `GROUP BY 月份` 得各月 { count, lo, hi }。
 *      - getAppMonthlyCounts(db) → App 明文 DB 跑 `GROUP BY 月份` 得各月 count。
 *   2. 純比對（不碰 DB、可獨立單元測）：
 *      - detectGaps(source, app, opts) → 依設計演算法算缺口月清單，含 scopeMonths 裁切、
 *        MIN_DEFICIT 門檻、ym 降冪排序。
 *
 * ★ 時區一致鐵律（沿用 linedb.iso() 教訓）★
 *   月份鍵一律以**本地時區**分月。兩側 SQL 都用 `strftime('%Y-%m', ts/1000,'unixepoch','localtime')`
 *   （同一 modifier → 同一分月邊界），避免月界訊息被歸到不同月造成假缺口。絕不可一側 UTC、
 *   一側 local。（決策 B「注意時區」+ §5 邊界「時區月界」。）
 *
 * ★ 唯讀鐵律 ★：來源側只讀（openDb 開的是 snapshot copy，不動 live edb）；App 側只跑
 *   SELECT。本模組不含任何寫入語句。
 */
import type { Database as Db } from 'better-sqlite3'

import { findDb, openDb } from '../line/engine/linedb'
import { getKey, type GetKeyOptions } from '../line/engine/linekey'

/** 月份鍵，格式 `YYYY-MM`（本地時區分月）。 */
export type YearMonth = string

/**
 * 來源側各月指紋：count 供偵測缺口；lo/hi（該月最小/最大 `_createdTime`，epoch ms）
 * 留作佐證 / 未來優化，本版偵測只用 count（決策 B「為何用 count 而非 min/max」）。
 */
export interface MonthFingerprint {
  count: number
  /** 該月最小 `_createdTime`（epoch ms）。 */
  lo: number
  /** 該月最大 `_createdTime`（epoch ms）。 */
  hi: number
}

/** 一個偵測到的缺口月。 */
export interface Gap {
  /** 缺口月（`YYYY-MM`，本地時區）。 */
  ym: YearMonth
  /** 缺多少筆（來源 count - App count；恆 ≥ MIN_DEFICIT）。 */
  deficit: number
  /** 該月本地時區起點（epoch ms，含）——供 Batch 4 `getMessagesSince` 的 cursor。 */
  monthStartMs: number
  /** 該月本地時區終點（epoch ms，不含；= 次月起點）——供 Batch 4 界定該月範圍。 */
  monthEndMs: number
}

/** detectGaps 門檻 / 範圍選項（純函式；預設對齊設計文件決策 B/D/F）。 */
export interface DetectGapsOptions {
  /**
   * 差多少筆才算缺（決策 B/D）。預設 1：來源比 App 多 ≥1 筆即列入 gap。
   * 調高可容忍即時流時間差 / 月界誤差的小差異（決策 D「避免即時流時間差的小差異誤判」）。
   */
  minDeficit?: number
  /**
   * 對帳範圍（決策 F）：只看「近 N 月」。
   *   - 0（預設）= 全歷史，不裁切。
   *   - > 0 = 只保留最近 N 個「來源有出現的月份」（含缺月）。
   * 以來源月份清單（降冪）取前 N 個為 scope，scope 外的缺月不報。
   */
  scopeMonths?: number
}

/** getSourceMonthlyFingerprint 選項。 */
export interface SourceFingerprintOptions {
  /** LINE DB 路徑；省略則 findDb()。 */
  dbPath?: string | null
  /** getKey 選項透傳（測試冷啟/自訂快取用）。 */
  keyOpts?: GetKeyOptions
}

/** key 三段皆 miss 時拋此錯，讓 Batch 4 編排辨識為「來源不可得」而不動 App DB。 */
export class ReconcileKeyUnavailableError extends Error {
  constructor(message = 'LINE DB key unavailable (env/cache/recover all miss)') {
    super(message)
    this.name = 'ReconcileKeyUnavailableError'
  }
}

/**
 * 來源側月份聚合 SQL（決策 B）。`_createdTime` 為 epoch ms → `/1000` 轉秒給 unixepoch。
 * 用 `'localtime'` 本地時區分月（★時區一致鐵律）。lo/hi 保留原始 epoch ms（非 /1000）。
 */
const SOURCE_MONTHLY_SQL =
  "SELECT strftime('%Y-%m', _createdTime/1000, 'unixepoch', 'localtime') AS ym, " +
  'COUNT(*) AS c, MIN(_createdTime) AS lo, MAX(_createdTime) AS hi ' +
  'FROM _message ' +
  'WHERE _createdTime IS NOT NULL ' +
  'GROUP BY ym'

/**
 * App 側月份聚合 SQL（決策 B）。`ts` 為 epoch ms（messages.ts）。同用 `'localtime'`
 * 與來源側保持一致分月邊界（★時區一致鐵律）。
 */
const APP_MONTHLY_SQL =
  "SELECT strftime('%Y-%m', ts/1000, 'unixepoch', 'localtime') AS ym, " +
  'COUNT(*) AS c ' +
  'FROM messages ' +
  'GROUP BY ym'

/**
 * getSourceMonthlyFingerprint(opts?) — 開來源加密 DB 一次，回各月指紋。
 *
 * 開檔方式比照 watchEngine.getMessagesSince：findDb → getKey → openDb（snapshot 複製
 * edb+wal → RW 開 COPY 讓 WAL merge → 解密驗證 → wal_checkpoint）。**只讀一支聚合查詢**。
 * key 三段皆 miss → 拋 ReconcileKeyUnavailableError；DB 找不到 / 解密失敗 → openDb 拋
 * （訊息為 py 風格 JSON 字串）。呼叫端（Batch 4）catch 後不動 App DB、不前移 checkpoint。
 *
 * 回傳 Map<ym, {count,lo,hi}>；`GROUP BY` 已去重、每月一列。
 */
export async function getSourceMonthlyFingerprint(
  opts: SourceFingerprintOptions = {}
): Promise<Map<YearMonth, MonthFingerprint>> {
  const dbPath = opts.dbPath ?? findDb()
  const key = getKey({ ...opts.keyOpts, dbPath })
  if (!key) throw new ReconcileKeyUnavailableError()

  const { con, cleanup } = openDb(key, dbPath)
  try {
    const rows = con.prepare(SOURCE_MONTHLY_SQL).all() as Array<{
      ym: string
      c: number
      lo: number
      hi: number
    }>
    const out = new Map<YearMonth, MonthFingerprint>()
    for (const r of rows) {
      // ym 理論上恆非 null（WHERE 已排除 NULL _createdTime）；防禦性略過空鍵。
      if (!r.ym) continue
      out.set(r.ym, { count: r.c, lo: r.lo, hi: r.hi })
    }
    return out
  } finally {
    cleanup()
  }
}

/**
 * getAppMonthlyCounts(db?) — App 明文 DB 各月 count（決策 B）。
 *
 * 17 萬列 `GROUP BY` 走 `idx_messages_chat_ts` 或全表，本地明文 SQLite 極快（< 100ms）。
 * **只讀一支聚合查詢**。回傳 Map<ym, count>。
 */
export function getAppMonthlyCounts(db: Db): Map<YearMonth, number> {
  const rows = db.prepare(APP_MONTHLY_SQL).all() as Array<{ ym: string; c: number }>
  const out = new Map<YearMonth, number>()
  for (const r of rows) {
    if (!r.ym) continue
    out.set(r.ym, r.c)
  }
  return out
}

/**
 * ymBounds(ym) — 由 `YYYY-MM` 算該月**本地時區**的 [起點, 終點) epoch ms。
 *
 * monthStartMs = 該月 1 日 00:00:00 本地時間；monthEndMs = 次月 1 日 00:00:00 本地時間
 * （不含）。以 `new Date(year, monthIndex, 1)` 建構——JS Date 建構子的多參數形式採
 * **本地時區**，與 SQLite `'localtime'` 分月邊界一致（★時區一致鐵律）。供 Batch 4 當
 * `getMessagesSince` 的 cursor（`_createdTime > monthStartMs` 升冪取該月）。
 */
export function ymBounds(ym: YearMonth): { monthStartMs: number; monthEndMs: number } {
  const [ys, ms] = ym.split('-')
  const year = Number(ys)
  const monthIndex = Number(ms) - 1 // JS Date 月份 0-based
  const start = new Date(year, monthIndex, 1, 0, 0, 0, 0)
  const end = new Date(year, monthIndex + 1, 1, 0, 0, 0, 0) // 次月 1 日（跨年由 Date 自動進位）
  return { monthStartMs: start.getTime(), monthEndMs: end.getTime() }
}

/**
 * detectGaps(source, app, opts?) — **純函式**：算缺口月清單（決策 B 演算法）。
 *
 * 演算法（設計文件 §決策 B）：
 *   1. 以「來源 GROUP BY 出的月份」為權威月清單（App 缺該月鍵 = 該月 count 0）。
 *   2. scopeMonths > 0：只保留最近 N 個來源月份（含缺月）；scope 外不報（決策 F）。
 *   3. 每月 deficit = 來源 count − (App count ?? 0)；deficit ≥ minDeficit 才列入。
 *   4. gaps 依 ym **降冪**排序（先補最近的月，使用者最快看到近期資料）。
 *
 * 不碰 DB、無副作用；given fixture 即可獨立單元測。
 */
export function detectGaps(
  source: Map<YearMonth, MonthFingerprint>,
  app: Map<YearMonth, number>,
  opts: DetectGapsOptions = {}
): Gap[] {
  const minDeficit = opts.minDeficit ?? 1
  const scopeMonths = opts.scopeMonths ?? 0

  // 權威月清單 = 來源出現過的月份，降冪（最近月在前）。
  let months = [...source.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))

  // scopeMonths 裁切：只看最近 N 個來源月份（含缺月）。0 = 全歷史不裁。
  if (scopeMonths > 0) {
    months = months.slice(0, scopeMonths)
  }

  const gaps: Gap[] = []
  for (const ym of months) {
    const srcCount = source.get(ym)!.count
    const appCount = app.get(ym) ?? 0
    const deficit = srcCount - appCount
    if (deficit >= minDeficit) {
      const { monthStartMs, monthEndMs } = ymBounds(ym)
      gaps.push({ ym, deficit, monthStartMs, monthEndMs })
    }
  }
  // months 已降冪 → gaps 天然降冪；明確再排一次保證契約（供 Batch 4 依序補最近月）。
  gaps.sort((a, b) => (a.ym < b.ym ? 1 : a.ym > b.ym ? -1 : 0))
  return gaps
}
