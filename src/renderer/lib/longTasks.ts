/**
 * longTasks.ts — 看板上「回顧最近 N 天」「補媒體金鑰」兩個長任務的狀態判讀（G-05；外掛開發者指南 §4：
 * 「呼叫 UI bridge 的等待結束不代表任務取消或完成…不要只用 UI 是否收到 Promise 結果判斷工作狀態」）。
 *
 * 長任務由外掛 backend 管理並寫進 dataDir（`src/plugin/backend/taskStatus.ts`、`reviewRun.ts`）；畫面用 `pipeline.longTaskStatus()` 查：
 *   - 畫面重新開啟時：任務還在跑就顯示進度並持續查詢，跑完自動重讀看板；上次沒做完（暫停／未完成／backend 重啟中斷）就顯示原因與「再按一次接續」。
 *   - 等待中的 Promise 斷掉（backend 重新啟動 → `job_not_found`、逾時…）時：不只顯示錯誤碼，改查目前狀態並一起顯示。
 * standalone 沒有 `longTaskStatus`，這些函式回 null／原本的錯誤文字，行為不變。純函式，不碰 React／DOM（node:test 直接測）。
 */
import type { LongTaskStatusView } from '../../shared/api'
import { backendErrorText } from './backendError'

/** 上次沒做完、再按一次可以接續的回顧狀態。 */
export const RESUMABLE_REVIEW_STATES: readonly string[] = Object.freeze(['paused', 'incomplete', 'interrupted'])

export interface LongTaskNotes {
  reviewRunning: boolean
  /** 回顧的狀態說明：進行中＝進度；上次沒做完＝原因與接續方式；其他＝null（不需要提示）。 */
  reviewText: string | null
  backfillRunning: boolean
  backfillText: string | null
}

export function longTaskNotes(view: LongTaskStatusView | null | undefined): LongTaskNotes {
  const review = view?.review ?? null
  const backfill = view?.mediaBackfill ?? null
  const reviewRunning = review?.running === true
  const backfillRunning = backfill?.running === true
  return {
    reviewRunning,
    reviewText: review && (reviewRunning || RESUMABLE_REVIEW_STATES.includes(review.state)) ? review.summary : null,
    backfillRunning,
    backfillText: backfill && (backfillRunning || backfill.state === 'interrupted') ? backfill.summary : null
  }
}

/** backend 還在跑長任務時，畫面多久查一次狀態。 */
export const LONG_TASK_POLL_MS = 3000
/** 查詢連續失敗時的最長間隔。 */
export const LONG_TASK_POLL_MAX_MS = 30_000

/**
 * 下一次查詢前要等多久（review N2）：成功時固定 `LONG_TASK_POLL_MS`；連續失敗 n 次就退避成 `LONG_TASK_POLL_MS * 2^n`（上限 30 s），
 * 但不會停止查詢——之前只要失敗一次就不再排下一次，看板會一直以為任務還在跑。
 */
export function longTaskPollDelayMs(failures: number): number {
  const n = Math.max(0, Math.min(10, Math.floor(failures)))
  return Math.min(LONG_TASK_POLL_MS * 2 ** n, LONG_TASK_POLL_MAX_MS)
}

/** 查不到狀態時（`pollFailures > 0`）按鈕不再因為「上次看到的還在跑」而停用；看板上顯示的說明。 */
export const LONG_TASK_STATUS_UNKNOWN_TEXT = '暫時查不到長任務的進度（稍後會再查）；按鈕已先開放，需要時可以直接再按一次。'

type StatusSource = { pipeline: { longTaskStatus?: () => Promise<LongTaskStatusView> } }

/** 查目前的長任務狀態；宿主不提供或查詢失敗都回 null（呼叫端照原本的方式顯示）。 */
export async function readLongTasks(api: StatusSource): Promise<LongTaskStatusView | null> {
  const query = api.pipeline.longTaskStatus
  if (!query) return null
  try {
    return await query()
  } catch {
    return null
  }
}

/**
 * 等待中的長任務呼叫失敗時給使用者看的一句話：錯誤原因 ＋（宿主可查時）任務目前的狀態。
 * 例：backend 重啟後 `job_not_found` →「回顧失敗：外掛後端在這段期間重新啟動過…；目前狀態：上次回顧進行中外掛後端重新啟動，沒有做完…」。
 */
export async function explainInterrupted(api: StatusSource, error: unknown, prefix: string, task: 'review' | 'mediaBackfill'): Promise<{ text: string; view: LongTaskStatusView | null }> {
  const base = backendErrorText(error, prefix)
  const view = await readLongTasks(api)
  const summary = task === 'review' ? view?.review?.summary : view?.mediaBackfill?.summary
  return { text: summary ? `${base}；目前狀態：${summary}` : base, view }
}
