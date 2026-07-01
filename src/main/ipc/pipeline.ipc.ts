import { ipcMain } from 'electron'
import type { PipelineScheduler, PipelineStatus } from '../pipeline/scheduler'
import type { RunOnceResult } from '../pipeline/runOnce'
import { reviewLastDays, backfillMediaKeys } from '../pipeline/backfill'
import type { BackfillProgress, ReviewLastDaysResult } from '../pipeline/backfill'
import { listModels, makeQwen } from '../llm/qwenClient'
import { getQwenConfig } from '../config/qwen'

/**
 * pipeline:* IPC handler（IMPLEMENTATION_PLAN.md §5）。
 *
 * - pipeline:status         → 目前狀態（含 hasApiKey / llmStatus，UI 顯示「缺金鑰」提示）
 * - pipeline:runOnce        → 手動立即跑一輪
 * - pipeline:setRunning     → 暫停/恢復定時輪詢
 * - pipeline:reviewLastDays → 回顧過去 N 天（預設 7），用既有抽取管線補建 todos
 * - settings:testQwen       → 打 /v1/models 驗證金鑰/連線（無金鑰回友善錯誤，不崩潰）
 *
 * scheduler 由 main/index.ts 建立後注入，避免模組層各自持有單例。
 * pushProgress 由 main/index.ts 注入，把 backfill 進度推給 renderer。
 */
export interface PipelineIpcDeps {
  pushProgress: (p: BackfillProgress) => void
}

export function registerPipelineIpc(
  scheduler: PipelineScheduler,
  deps: PipelineIpcDeps
): void {
  ipcMain.handle('pipeline:status', (): PipelineStatus => scheduler.getStatus())

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
        return { ok: false, error: '尚未設定 qwen 金鑰（請在設定頁填入，或設環境變數 QWEN_API_KEY）' }
      }
      const client = makeQwen({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseURL,
        timeoutMs: cfg.timeoutMs
      })
      return listModels(client)
    }
  )
}
