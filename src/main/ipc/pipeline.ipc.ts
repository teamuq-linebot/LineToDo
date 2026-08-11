import { ipcMain } from 'electron'
import type { PipelineScheduler, PipelineStatus } from '../pipeline/scheduler'
import type { RunOnceResult } from '../pipeline/runOnce'
import { reviewLastDays, backfillMediaKeys } from '../pipeline/backfill'
import type { BackfillProgress, ReviewLastDaysResult } from '../pipeline/backfill'
import { getChatsSeenStats } from '../db/pipeline.repo'
import { countChatsWithRecentMessages } from '../db/messages.repo'
import { listModels, makeQwen } from '../llm/qwenClient'
import { getQwenConfig } from '../config/qwen'
import { resolveProvider, unconfiguredHealth, LlmProviderError } from '../llm/provider'
import type { ProviderHealth } from '../llm/provider'

/**
 * pipeline:* IPC handler（IMPLEMENTATION_PLAN.md §5）。
 *
 * - pipeline:status         → 目前狀態（含 hasApiKey / llmStatus，UI 顯示「缺金鑰」提示）
 * - pipeline:loadStats      → 唯讀的歷史負載統計（設定頁延遲試算的預設值；只回整數）
 * - pipeline:runOnce        → 手動立即跑一輪
 * - pipeline:setRunning     → 暫停/恢復定時輪詢
 * - pipeline:reviewLastDays → 回顧過去 N 天（預設 7），用既有抽取管線補建 todos
 * - settings:testQwen       → 打 /v1/models 驗證金鑰/連線（無金鑰回友善錯誤，不崩潰）
 * - settings:testAiProvider → provider-aware 健檢（http 打 /v1/models；CLI 查路徑/版本/登入）
 *
 * ⚠️ `settings:testQwen` **刻意保留不刪**（design.md §3.4）：它是 HTTP 專屬語意，
 * 留著讓現有 UI 在 Batch 6（設定頁改版）核可前完全不受影響。UI 改版時才把按鈕改指
 * `settings:testAiProvider`，屆時 testQwen 才有資格被移除。
 *
 * scheduler 由 main/index.ts 建立後注入，避免模組層各自持有單例。
 * pushProgress 由 main/index.ts 注入，把 backfill 進度推給 renderer。
 */
export interface PipelineIpcDeps {
  pushProgress: (p: BackfillProgress) => void
}

/** 近 N 天的視窗大小（`chatsWithRecentMessages` 的定義）。 */
const RECENT_DAYS = 7

/**
 * 設定頁延遲試算要用的歷史事實（全部是整數，不含任何聊天室名稱或訊息內容）。
 *
 * 為什麼是獨立的 IPC，而不是塞進 `pipeline:status`：
 *   - `pipeline:status` 每輪（預設 30 秒）都會 emit 給 renderer，多掛兩支 SQL 就是
 *     每 30 秒多兩次查詢，只為了餵一個「開設定頁才看得到」的欄位。
 *   - scheduler.getStatus() 的註解已明文「刻意不新增 PipelineStatus 欄位」（Batch 5
 *     確立的形狀），改它等於動到看板/狀態列共用的契約。
 *   這裡改成「開設定頁時拉一次」的唯讀查詢，既不動既有契約，也不進輪詢熱路徑。
 */
export interface PipelineLoadStats {
  /** 納入分位數的輪數；< 20 代表歷史不足，呼叫端應退回保守預設。 */
  sampleRuns: number
  chatsSeenP50: number
  chatsSeenP90: number
  /** 歷來單輪最多處理過的聊天室數（多半來自開機自我對帳的一次性回補）。 */
  chatsSeenMax: number
  /** `chatsWithRecentMessages` 的視窗天數。 */
  recentDays: number
  /** 近 recentDays 天有過新訊息、且未被封鎖的聊天室數。 */
  chatsWithRecentMessages: number
}

export function registerPipelineIpc(
  scheduler: PipelineScheduler,
  deps: PipelineIpcDeps
): void {
  ipcMain.handle('pipeline:status', (): PipelineStatus => scheduler.getStatus())

  ipcMain.handle('pipeline:loadStats', (): PipelineLoadStats => {
    return {
      ...getChatsSeenStats(),
      recentDays: RECENT_DAYS,
      chatsWithRecentMessages: countChatsWithRecentMessages(RECENT_DAYS)
    }
  })

  ipcMain.handle('pipeline:runOnce', async (): Promise<RunOnceResult> => {
    return scheduler.triggerNow()
  })

  ipcMain.handle(
    'pipeline:reviewLastDays',
    async (_e, args?: { days?: number }): Promise<ReviewLastDaysResult> => {
      const days =
        typeof args?.days === 'number' && args.days > 0 ? Math.floor(args.days) : 7
      return reviewLastDays(days, { onProgress: deps.pushProgress })
    }
  )

  ipcMain.handle(
    'pipeline:backfillMediaKeys',
    async (
      _e,
      args?: { days?: number }
    ): Promise<{ ok: boolean; scanned?: number; mediaBackfilled?: number; error?: string }> => {
      const days =
        typeof args?.days === 'number' && args.days > 0 ? Math.floor(args.days) : 7
      try {
        const r = await backfillMediaKeys(days)
        return { ok: true, scanned: r.scanned, mediaBackfilled: r.mediaBackfilled }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'pipeline:setRunning',
    (_e, args: { running: boolean }): PipelineStatus => {
      const running = !!args?.running
      return scheduler.setRunning(running)
    }
  )

  ipcMain.handle(
    'settings:testQwen',
    async (): Promise<{ ok: boolean; models?: string[]; error?: string }> => {
      const cfg = getQwenConfig()
      if (!cfg.apiKey) {
        return { ok: false, error: '尚未設定 API 金鑰（請在設定頁填入，或設環境變數 QWEN_API_KEY）' }
      }
      const client = makeQwen({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseURL,
        timeoutMs: cfg.timeoutMs
      })
      return listModels(client)
    }
  )

  /**
   * settings:testAiProvider —— 依目前 settings.aiProvider 做健檢（design.md §3.3 / §3.4）。
   *
   * - http      → listModels()（與 settings:testQwen 同行為）
   * - claudeCli → 定位執行檔 + `--version` + 登入狀態
   * - codexCli  → 定位執行檔 + `--version` + `codex login status`
   *
   * **不跑真 prompt**：一次真呼叫要數秒到數十秒、會燒訂閱額度，而使用者按「測試」時
   * 期待的是即時回饋。health() 內部已自帶 timeout，這裡不再加一層。
   * 任何例外都轉成 ok:false 的 ProviderHealth（IPC 不 reject，UI 不必寫 try/catch）；
   * `detail`（可能含使用者路徑/對話片段）只留在 main 的 log，永不跨橋。
   */
  ipcMain.handle('settings:testAiProvider', async (): Promise<ProviderHealth> => {
    const provider = resolveProvider()
    if (!provider) return unconfiguredHealth()
    try {
      return await provider.health()
    } catch (err) {
      if (err instanceof LlmProviderError) {
        console.error(`[health] ${provider.id} 失敗（${err.code}）：`, err.detail ?? '')
        return { ok: false, code: err.code, summary: err.userMessage, details: {} }
      }
      console.error(`[health] ${provider.id} 失敗：`, err)
      return {
        ok: false,
        code: 'unknown',
        summary: 'AI 引擎健檢失敗（詳細原因請見 log）',
        details: {}
      }
    }
  })
}
