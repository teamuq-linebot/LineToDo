/**
 * reconcileRunner.ts — 開機自我對帳「編排」模組（Batch 4，設計文件 §決策 C/D/E/H）。
 *
 * 職責：把 Batch 1（健康 gate）+ Batch 2（insertedMsgIds）+ Batch 3（偵測）+ engine
 * （getMessagesSince / checkpoint）串成一支背景、不阻塞的開機對帳流程：
 *
 *   健康 gate（checkDbHealth）→ 單飛鎖 → 偵測缺月（detectGaps）→ 逐月大批回填
 *   （getMessagesSince → insertMessages → 依 ts 分流 markProcessed）→
 *   全 scope 補完才把 checkpoint 前移到來源最新（saveState，非 resetNow）→ 釋鎖。
 *
 * ★ 不燒 LLM 政策（決策 C，2026-07 修正）★
 *   回填只對「本次真正新插入」的列（insertMessages 回傳的 insertedMsgIds）處理，且依 ts 分流：
 *     - ts 在近 7 天內（RECONCILE_LLM_SKIP_OLDER_THAN_DAYS）→ **不標**（保持 processed=0），
 *       讓排程器 getUnprocessedForPipeline 照常抽去 LLM——近期訊息才是有價值的待辦來源。
 *     - ts 在 7 天以上（舊歷史）→ markProcessed=1，跳過 LLM，零 API 成本。
 *   絕不整批標（避免把使用者尚未抽取的既有 pending 列誤標已處理）。
 *
 * ★ checkpoint 時序鐵律（決策 E）★
 *   只在「所有 scope 內缺月都補完（且無因 maxMonthsPerBoot 未補完的剩餘）」時，才
 *   saveState(last_ts=來源最新 MAX ts, sig=walSig) 前移 checkpoint。若因上限未補完 →
 *   **不動 checkpoint**，下次開機續補（靠 INSERT OR IGNORE 冪等 + watermark，不漏訊）。
 *
 * ★ 唯讀鐵律 ★：來源側只讀（getSourceMonthlyFingerprint / getMessagesSince 開 snapshot）；
 *   App 側只 insertMessages（INSERT OR IGNORE 去重）+ markProcessed。健康 gate 不 ok →
 *   絕不在壞庫上寫。
 *
 * ★ 並發安全（決策 H）★
 *   不暫停排程器。better-sqlite3 同步交易 + INSERT OR IGNORE 去重 + processed 欄隔離
 *   （對帳只標自己本次 inserted 的列）→ 對帳與排程器/即時流同時跑不互相污染。
 */
import { existsSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Database as Db } from 'better-sqlite3'

import { checkDbHealth, getDb } from '../db/database'
import { insertMessages, markProcessed } from '../db/messages.repo'
import { deriveMsgId } from '../db/schema'
import type { RawLineMessage } from '../line/types'
import {
  getMessagesSince as engineGetMessagesSince,
  saveState as engineSaveState,
  walSig,
  defaultStateFile
} from '../line/engine/watchEngine'
import type { WatchState } from '../line/engine/watchEngine'
import { findDb } from '../line/engine/linedb'
import {
  detectGaps,
  getAppMonthlyCounts,
  getSourceMonthlyFingerprint,
  ReconcileKeyUnavailableError,
  type Gap,
  type MonthFingerprint,
  type YearMonth
} from './reconcile'

/**
 * 進度事件契約（給 Batch 5 UI 訂閱）。channel = `evt:reconcile-progress`。
 *
 * phase 生命週期：
 *   - `scanning`      掃描來源/App 各月指紋、算缺月（done/total 未定，皆 0）。
 *   - `backfilling`   逐缺月回填中；`ym` = 當前補的月，`done`/`total` = 已補/待補月數。
 *   - `done`          正常結束（含 no-op 無缺口）；`done===total`。
 *   - `source-unavailable`  來源 DB 不可得（key miss / 找不到 / 解密失敗）→ 未動 App DB。
 *   - `db-unhealthy`  健康 gate 不 ok → 未啟動對帳、未寫入。
 *   - `skipped`       單飛鎖被佔用（已有一份在跑）→ 本次不重入。
 */
export interface ReconcileProgress {
  phase: 'scanning' | 'backfilling' | 'done' | 'source-unavailable' | 'db-unhealthy' | 'skipped'
  /** 當前處理中的缺月（`YYYY-MM`）；scanning/done/gate 階段為 null。 */
  ym: YearMonth | null
  /** 已補完的缺月數。 */
  done: number
  /** 本次開機要補的缺月總數（受 maxMonthsPerBoot 上限裁切後的值）。 */
  total: number
}

/** runReconcile 選項（皆有預設；預設對齊設計文件決策 D/F）。 */
export interface ReconcileOptions {
  /**
   * 差多少筆才算缺（決策 B/D）。透傳 detectGaps.minDeficit。預設 1。
   */
  minDeficit?: number
  /**
   * 對帳範圍（決策 F）：只看近 N 月。0 = 全歷史。透傳 detectGaps.scopeMonths。預設 0。
   */
  scopeMonths?: number
  /**
   * 單次開機最多補幾個 gap 月（決策 F，冷啟大洞防過久）。預設 6。
   * 超過的缺月留待下次開機續補（此時**不前移 checkpoint**）。
   */
  maxMonthsPerBoot?: number
  /** 單月回填每批上限（透傳 getMessagesSince.limit）。預設 20000。 */
  monthBatchLimit?: number
  /** 單月子窗切分迴圈上限（防失控；預設 20 → 最多 20*limit 筆/月）。 */
  maxSubWindowsPerMonth?: number
}

/** runReconcile 可注入依賴（測試用；預設接真實模組）。 */
export interface ReconcileDeps {
  /** App DB 連線；省略則各 repo 內部走 getDb()。健康 gate 已保證健康才會用到。 */
  db?: Db
  /** 進度事件回呼（index.ts 注入 → pushToRenderer('evt:reconcile-progress')）。 */
  onProgress?: (p: ReconcileProgress) => void
  /** 來源各月指紋。預設 getSourceMonthlyFingerprint（開來源 DB 一次）。 */
  getSourceFingerprint?: () => Promise<Map<YearMonth, MonthFingerprint>>
  /** App 各月 count。預設 getAppMonthlyCounts。 */
  getAppCounts?: (db?: Db) => Map<YearMonth, number>
  /** 取某 cursor 之後的來源訊息。預設 engine getMessagesSince。 */
  getMessagesSince?: (ms: number, opts: { limit: number }) => Promise<RawLineMessage[]>
  /** 健康檢查。預設 checkDbHealth。 */
  checkHealth?: () => { ok: boolean; reason?: string }
  /** checkpoint 檔路徑；省略則 defaultStateFile()。 */
  stateFile?: string
  /** LINE DB 路徑（供 walSig 算 sig）；省略則 findDb()。 */
  sourceDbPath?: string | null
  /** 單飛鎖檔路徑；省略則 <userData>/.reconcile_lock。 */
  lockFile?: string
}

/** runReconcile 執行結果（供啟動 log / 測試 assertion；非 UI 契約）。 */
export interface ReconcileResult {
  /** 是否有實際跑對帳（false = 被 gate/鎖/來源不可得擋下）。 */
  ran: boolean
  /** 結束時的 phase（對齊最後一次 emit）。 */
  phase: ReconcileProgress['phase']
  /** 偵測到的（scope 內）缺月總數。 */
  gapsDetected: number
  /** 本次實際補完的缺月數。 */
  monthsBackfilled: number
  /** 本次新插入的總列數（跨所有補回月）。 */
  totalInserted: number
  /** checkpoint 是否前移（僅全補完時才前移）。 */
  checkpointAdvanced: boolean
  /** 不健康 / 來源不可得等原因（ran=false 時填）。 */
  reason?: string
}

/** in-process 單飛旗標：避免同進程重入（手動觸發 + 開機觸發撞在一起）。 */
let running = false

/** 預設單飛鎖檔：<userData>/.reconcile_lock（跨程序層防護；in-proc flag 為主）。 */
function defaultLockFile(): string {
  // 與 watchEngine.defaultStateFile 同款惰性載入：Electron 主程序用 userData，
  // 純 Node 測試環境 fallback 到 env / cwd。
  try {
    const electron = require('electron') as { app?: { getPath?: (n: string) => string } }
    const userData = electron?.app?.getPath?.('userData')
    if (userData) return join(userData, '.reconcile_lock')
  } catch {
    /* 非 Electron 環境 → fallback */
  }
  const base =
    process.env.LINE_TODO_USERDATA?.trim() ||
    (process.env.APPDATA ? join(process.env.APPDATA, 'line-todo') : process.cwd())
  return join(base, '.reconcile_lock')
}

/** 鎖檔視為過期的存活上限（10 分鐘）。上次崩潰留下的殘鎖不會永久卡死對帳。 */
const LOCK_STALE_MS = 10 * 60 * 1000

/**
 * 回填訊息「跳過 LLM」的年齡門檻（天）。
 *
 * 政策（修正自「全標 processed=1」）：
 *   - 回填列 ts 在 **7 天內**（`ts >= now - 7天`）→ **不標 processed**（保持 0），
 *     讓排程器 getUnprocessedForPipeline 照常抽去 LLM 抽待辦——近期訊息才是有價值的待辦來源。
 *   - 回填列 ts **7 天以上**（`ts < now - 7天`）→ **標 processed=1**，跳過 LLM——
 *     海量舊歷史只需省 API 成本，不進 LLM。
 */
const RECONCILE_LLM_SKIP_OLDER_THAN_DAYS = 7

/** 取得單飛鎖（in-proc flag + 鎖檔）。已被佔用回 false。 */
function acquireLock(lockFile: string): boolean {
  if (running) return false
  // 鎖檔存在且未過期 → 視為另一份在跑；過期殘鎖（崩潰遺留）則接管。
  if (existsSync(lockFile)) {
    try {
      const raw = readFileSync(lockFile, 'utf8')
      const ts = Number(raw)
      if (Number.isFinite(ts) && Date.now() - ts < LOCK_STALE_MS) return false
    } catch {
      /* 讀不到 → 當殘鎖接管 */
    }
  }
  running = true
  try {
    writeFileSync(lockFile, String(Date.now()), 'utf8')
  } catch {
    /* 鎖檔寫失敗非致命：in-proc flag 仍擋同進程重入 */
  }
  return true
}

/** 釋放單飛鎖。冪等。 */
function releaseLock(lockFile: string): void {
  running = false
  try {
    if (existsSync(lockFile)) unlinkSync(lockFile)
  } catch {
    /* 刪鎖失敗非致命；過期後會被接管 */
  }
}

/**
 * 由來源各月指紋取「來源最新 MAX ts」（決策 E：checkpoint 前移目標）。
 * 各月指紋的 hi 即該月最大 `_createdTime`；全域 max = 各月 hi 的最大值。
 * 避免為讀 MAX 再開一次 200MB 來源 DB（沿用決策 E「省一次開啟」）。
 */
function sourceMaxTs(source: Map<YearMonth, MonthFingerprint>): number {
  let max = 0
  for (const fp of source.values()) {
    if (fp.hi > max) max = fp.hi
  }
  return max
}

/**
 * reconcileMonth — 回填單一缺月（決策 C/D）。
 *
 * getMessagesSince(cursor,{limit}) 大批取該月 → 只留落在 [monthStartMs, monthEndMs) 的列
 * → insertMessages → 依 ts 分流標記（processed）：
 *   - 本次新插入且 **ts < llmSkipCutoffMs**（7 天以上舊歷史）→ markProcessed=1（跳過 LLM）。
 *   - 本次新插入且 **ts >= llmSkipCutoffMs**（近 7 天）→ 不標，保持 processed=0，
 *     留給排程器抽去 LLM 抽待辦。
 *
 * 單月 > limit（極活躍月）→ 子窗切分：cursor=本批 max ts 續補該月，直到「該批已無落在
 * 月內的列」或「本批未達 limit（來源已到底）」或觸迴圈上限。
 *
 * engine getMessagesSince 語意為 `_createdTime > cursor`（嚴格大於）：
 *   - 首批 cursor 用 monthStartMs - 1，使 monthStartMs 當刻的列也被含入（邊界包含）。
 *   - 子窗 cursor 用「本批已見的 max ts」，天然不重取同列。
 *
 * 回傳本月新插入列數（跨子窗加總）。任何一月失敗由呼叫端（runReconcile）catch 隔離。
 */
async function reconcileMonth(
  gap: Gap,
  deps: Required<Pick<ReconcileDeps, 'getMessagesSince'>> & { db?: Db },
  opts: { limit: number; maxSubWindows: number; llmSkipCutoffMs: number }
): Promise<number> {
  let inserted = 0
  // 首批 cursor = monthStartMs - 1（含月起點當刻的列，因 engine 為嚴格 >）。
  let cursor = gap.monthStartMs - 1
  for (let round = 0; round < opts.maxSubWindows; round++) {
    const batch = await deps.getMessagesSince(cursor, { limit: opts.limit })
    if (batch.length === 0) break

    // 只落「落在本月窗口 [monthStartMs, monthEndMs)」的列；超出月尾的列屬其他（已對齊）
    // 月份，不在本月缺口責任內，丟棄（其所屬月若也缺，會由自己的 reconcileMonth 補）。
    const inMonth: RawLineMessage[] = []
    let batchMaxTs = cursor
    for (const m of batch) {
      if (m.ts > batchMaxTs) batchMaxTs = m.ts
      if (m.ts >= gap.monthStartMs && m.ts < gap.monthEndMs) inMonth.push(m)
    }

    if (inMonth.length > 0) {
      // 建 msgId → ts 對照（用 insertMessages 內部同款 deriveMsgId 推導，鍵一致）。
      const tsByMsgId = new Map<string, number>()
      for (const m of inMonth) tsByMsgId.set(deriveMsgId(m), m.ts)

      const res = insertMessages(inMonth, deps.db)
      // ★不燒 LLM 政策（修正）★：只對本次真正新插入且「ts 早於 cutoff（7 天以上舊歷史）」
      // 的列標 processed=1；ts 在 7 天內的近期回填列不標（保持 processed=0），留給排程器抽 LLM。
      const oldMsgIds = res.insertedMsgIds.filter((id) => {
        const ts = tsByMsgId.get(id)
        return ts !== undefined && ts < opts.llmSkipCutoffMs
      })
      if (oldMsgIds.length > 0) markProcessed(oldMsgIds, deps.db)
      inserted += res.inserted
    }

    // 續補判斷：
    //  - 本批未達 limit → 來源已到 cursor 之後的底，無更多可取 → 停。
    //  - 本批已無任何落在月內的列（batchMaxTs 已越過 monthEndMs）→ 該月已掃完 → 停。
    //  - cursor 未前進（batchMaxTs 未變）→ 防呆停（避免死迴圈）。
    if (batch.length < opts.limit) break
    if (batchMaxTs >= gap.monthEndMs) break
    if (batchMaxTs <= cursor) break
    cursor = batchMaxTs
  }
  return inserted
}

/**
 * runReconcile(opts?, deps?) — 開機自我對帳主編排（背景、不阻塞由呼叫端負責）。
 *
 * 流程（設計文件 §3 啟動流程圖）：
 *   1. 健康 gate：checkDbHealth() 不 ok → emit db-unhealthy + return（絕不在壞庫寫）。
 *   2. 單飛鎖：被佔用 → emit skipped + return。
 *   3. 掃描：來源各月指紋 vs App 各月 count → detectGaps → gaps[]（依 scopeMonths 裁切）。
 *      來源不可得（ReconcileKeyUnavailableError / openDb 拋）→ emit source-unavailable +
 *      釋鎖 return（不動 App DB、不前移 checkpoint）。
 *   4. 無缺口 → emit done（no-op）+ 釋鎖 return（快速結束、不寫入）。
 *   5. 逐缺月（≤ maxMonthsPerBoot）reconcileMonth；per-month 失敗隔離、不中斷其他月。
 *   6. 全 scope 缺月補完（無因上限剩餘、無失敗月）→ saveState 前移 checkpoint；否則不前移。
 *   7. emit done + 釋鎖。
 *
 * 絕不 throw：所有錯誤內部 catch → 反映在 result / progress，讓呼叫端（index.ts）
 * `void runReconcile().catch(log)` 即使漏接也不硬崩。
 */
export async function runReconcile(
  opts: ReconcileOptions = {},
  deps: ReconcileDeps = {}
): Promise<ReconcileResult> {
  const minDeficit = opts.minDeficit ?? 1
  const scopeMonths = opts.scopeMonths ?? 0
  const maxMonthsPerBoot = opts.maxMonthsPerBoot ?? 6
  const monthBatchLimit = opts.monthBatchLimit ?? 20000
  const maxSubWindows = opts.maxSubWindowsPerMonth ?? 20
  // LLM 跳過門檻：ts < cutoff（now − 7 天）的回填列標 processed=1（跳過 LLM）；
  // ts >= cutoff（近 7 天）的回填列不標，留給排程器抽。本次執行內一致（各月/子窗共用）。
  const llmSkipCutoffMs = Date.now() - RECONCILE_LLM_SKIP_OLDER_THAN_DAYS * 86_400_000

  const emit = deps.onProgress ?? ((): void => {})
  const checkHealth = deps.checkHealth ?? checkDbHealth
  const getSourceFingerprint =
    deps.getSourceFingerprint ?? (() => getSourceMonthlyFingerprint())
  // getAppMonthlyCounts 需要明確 db；deps.db 省略時走 getDb()（健康 gate 已保證健康）。
  const getAppCounts =
    deps.getAppCounts ?? ((db?: Db) => getAppMonthlyCounts(db ?? getDb()))
  const getMessagesSince =
    deps.getMessagesSince ??
    ((ms: number, o: { limit: number }) => engineGetMessagesSince(ms, o))
  const stateFile = deps.stateFile ?? defaultStateFile()
  const sourceDbPath = deps.sourceDbPath ?? findDb()
  const lockFile = deps.lockFile ?? defaultLockFile()

  const result: ReconcileResult = {
    ran: false,
    phase: 'done',
    gapsDetected: 0,
    monthsBackfilled: 0,
    totalInserted: 0,
    checkpointAdvanced: false
  }

  // ── 1. 健康 gate（決策 G/H；絕不在壞庫上寫）──────────────────
  const health = checkHealth()
  if (!health.ok) {
    result.phase = 'db-unhealthy'
    result.reason = health.reason ?? 'db-unhealthy'
    console.warn(`[reconcile] DB unhealthy, skip reconcile: ${result.reason}`)
    emit({ phase: 'db-unhealthy', ym: null, done: 0, total: 0 })
    return result
  }

  // ── 2. 單飛鎖（避免重入 / 兩份同時跑）─────────────────────────
  if (!acquireLock(lockFile)) {
    result.phase = 'skipped'
    result.reason = 'already-running'
    console.log('[reconcile] another run in progress, skip')
    emit({ phase: 'skipped', ym: null, done: 0, total: 0 })
    return result
  }

  try {
    // ── 3. 掃描：來源/App 各月指紋 → 偵測缺月 ────────────────────
    emit({ phase: 'scanning', ym: null, done: 0, total: 0 })

    let source: Map<YearMonth, MonthFingerprint>
    try {
      source = await getSourceFingerprint()
    } catch (err) {
      // 來源不可得（key miss / 找不到 DB / 解密失敗）→ 不動 App DB、不前移 checkpoint。
      result.phase = 'source-unavailable'
      result.reason =
        err instanceof ReconcileKeyUnavailableError
          ? 'source-key-unavailable'
          : err instanceof Error
            ? err.message
            : String(err)
      console.warn(`[reconcile] source unavailable, skip: ${result.reason}`)
      emit({ phase: 'source-unavailable', ym: null, done: 0, total: 0 })
      return result
    }

    const app = getAppCounts(deps.db)
    const allGaps = detectGaps(source, app, { minDeficit, scopeMonths })
    result.gapsDetected = allGaps.length

    // ── 4. no-op：無缺口 → 快速結束、不寫入 ────────────────────
    if (allGaps.length === 0) {
      result.ran = true
      result.phase = 'done'
      console.log('[reconcile] no gaps, up to date')
      emit({ phase: 'done', ym: null, done: 0, total: 0 })
      return result
    }

    // 本次開機只補前 maxMonthsPerBoot 個（gaps 已依 ym 降冪 → 先補最近月）。
    const toBackfill = allGaps.slice(0, maxMonthsPerBoot)
    const total = toBackfill.length
    const hasRemainder = allGaps.length > toBackfill.length
    console.log(
      `[reconcile] gaps=${allGaps.length} backfilling=${total} remainder=${hasRemainder}`
    )

    result.ran = true

    // ── 5. 逐缺月大批回填（per-month 失敗隔離）───────────────────
    let done = 0
    let anyMonthFailed = false
    for (const gap of toBackfill) {
      emit({ phase: 'backfilling', ym: gap.ym, done, total })
      try {
        const insertedThisMonth = await reconcileMonth(
          gap,
          { getMessagesSince, db: deps.db },
          { limit: monthBatchLimit, maxSubWindows, llmSkipCutoffMs }
        )
        result.totalInserted += insertedThisMonth
        result.monthsBackfilled += 1
        console.log(
          `[reconcile] month ${gap.ym} backfilled inserted=${insertedThisMonth} (deficit=${gap.deficit})`
        )
      } catch (err) {
        // 單月失敗：log、標記、不中斷其他月（比照 backfill per-chat fail 隔離）。
        anyMonthFailed = true
        console.warn(
          `[reconcile] month ${gap.ym} failed:`,
          err instanceof Error ? err.message : String(err)
        )
      }
      done += 1
    }

    // ── 6. checkpoint 前移（決策 E：只在全 scope 補完才前移）──────
    // 前移條件：無因 maxMonthsPerBoot 未補的剩餘月 且 本次無任何月失敗。
    // 否則保持舊 checkpoint，下次開機續補（INSERT OR IGNORE 冪等，不漏訊、不重燒）。
    if (!hasRemainder && !anyMonthFailed) {
      const maxTs = sourceMaxTs(source)
      if (maxTs > 0) {
        const state: WatchState = { last_ts: maxTs, sig: walSig(sourceDbPath) }
        engineSaveState(stateFile, state)
        result.checkpointAdvanced = true
        console.log(`[reconcile] checkpoint advanced last_ts=${maxTs}`)
      }
    } else {
      console.log(
        `[reconcile] checkpoint NOT advanced (remainder=${hasRemainder} failed=${anyMonthFailed})`
      )
    }

    // ── 7. 完成 ────────────────────────────────────────────────
    result.phase = 'done'
    emit({ phase: 'done', ym: null, done, total })
    return result
  } catch (err) {
    // 掃描/偵測階段未預期錯誤：不 throw，反映在 result 供呼叫端 log。
    result.reason = err instanceof Error ? err.message : String(err)
    console.error('[reconcile] unexpected failure:', err)
    emit({ phase: 'done', ym: null, done: result.monthsBackfilled, total: result.gapsDetected })
    return result
  } finally {
    releaseLock(lockFile)
  }
}
