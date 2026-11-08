import { useEffect, useState } from 'react'
import { useHostCapabilities, useLineTodoApi } from '../../platform/LineTodoApi'
import type { AiProviderId, BackfillProgress, PipelineRunResult, PipelineStatus } from '../../types/api'
import { notReadyShortText } from '../../lib/aiProvider'
import { backendErrorText } from '../../lib/backendError'
import { sharedRead } from '../../lib/sharedRead'
import { LONG_TASK_STATUS_UNKNOWN_TEXT, explainInterrupted, longTaskNotes, longTaskPollDelayMs, readLongTasks } from '../../lib/longTasks'
import type { LongTaskStatusView } from '../../../shared/api'
import { createProgressFrameCoalescer } from '../Board/progressFrame'
import { NotMineReviewPanel } from '../Board/NotMineReviewPanel'

/**
 * OverviewOps — 設定分頁的「整理」區塊：不是我的回查、回顧最近 N 天、補媒體金鑰、立即整理／立即抓取。
 * 原本在總覽頁上方（工具列與今日摘要），總覽只留篩選列與四欄。
 *
 * G-05：回顧與補媒體金鑰的狀態向 backend 查詢（lib/longTasks.ts），不只靠按鈕的 Promise：重新開啟畫面時看得到進行中的進度與上次沒做完的原因。
 * `pollDelayMs`：測試用（預設 `longTaskPollDelayMs`）。
 */

const REVIEW_DAYS = 2

function runResultText(res: PipelineRunResult): string {
  if (res.note?.startsWith('busy:')) return '上一輪還沒結束'
  return res.note ?? (res.llmStatus === 'error' ? '整理失敗' : '部分聊天整理失敗')
}

export function OverviewOps({ pollDelayMs = longTaskPollDelayMs }: { pollDelayMs?: (failures: number) => number } = {}): JSX.Element {
  const api = useLineTodoApi()
  const caps = useHostCapabilities()
  const [showNotMine, setShowNotMine] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [progress, setProgress] = useState<BackfillProgress | null>(null)
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null)
  const [aiProvider, setAiProvider] = useState<AiProviderId>('http')
  /** 待辦與議題合併整理開啟：回顧最近幾天仍只產出待辦（兩者的訊息窗口規則互相牽制），tooltip 說明。 */
  const [combined, setCombined] = useState(false)
  const [reviewNote, setReviewNote] = useState<string | null>(null)
  const [backfilling, setBackfilling] = useState(false)
  const [backfillNote, setBackfillNote] = useState<string | null>(null)
  const [status, setStatus] = useState<PipelineStatus | null>(null)
  const [running, setRunning] = useState(false)
  const [runNote, setRunNote] = useState<string | null>(null)
  /** backend 回報的長任務狀態（外掛版；standalone 為 null）。 */
  const [tasks, setTasks] = useState<LongTaskStatusView | null>(null)
  /** 長任務狀態連續查詢失敗的次數（review N2）：> 0 時 `tasks` 是舊的，按鈕不再因它停用，查詢以退避繼續。 */
  const [pollFailures, setPollFailures] = useState(0)
  const notes = longTaskNotes(tasks)
  const statusUnknown = pollFailures > 0
  /** 回顧／補金鑰在 backend 跑、但不是這個畫面按下去的（畫面重新開啟、或等待中的呼叫斷掉之後）。 */
  const remoteRunning = (notes.reviewRunning && !reviewing) || (notes.backfillRunning && !backfilling)

  // G-05：開啟畫面時查一次；backend 還在跑就每 3 秒再查，跑完顯示結果。
  useEffect(() => {
    if (!api.pipeline.longTaskStatus) return undefined
    let alive = true
    void readLongTasks(api).then((view) => {
      if (!alive || !view) return
      setTasks(view)
      const first = longTaskNotes(view)
      if (!first.reviewRunning && first.reviewText) setReviewNote(first.reviewText)
      if (!first.backfillRunning && first.backfillText) setBackfillNote(first.backfillText)
    })
    return () => { alive = false }
  }, [api])

  // 查詢失敗（review N2）：不停止，以退避再查（失敗次數變了，effect 會重排下一次）；在查到之前按鈕不因舊狀態停用。
  useEffect(() => {
    if (!remoteRunning || !api.pipeline.longTaskStatus) return undefined
    let alive = true
    const timer = setTimeout(() => {
      void readLongTasks(api).then((view) => {
        if (!alive) return
        if (!view) { setPollFailures((n) => n + 1); return }
        setPollFailures(0)
        const before = longTaskNotes(tasks)
        const after = longTaskNotes(view)
        setTasks(view)
        if (before.reviewRunning && !after.reviewRunning) setReviewNote(view.review?.summary ?? null)
        if (before.backfillRunning && !after.backfillRunning) setBackfillNote(view.mediaBackfill?.summary ?? null)
      })
    }, pollDelayMs(pollFailures))
    return () => { alive = false; clearTimeout(timer) }
  }, [api, remoteRunning, tasks, pollFailures, pollDelayMs])

  useEffect(() => {
    let alive = true
    void sharedRead(api, 'pipeline.status', () => api.pipeline.status()).then((s) => {
      if (!alive) return
      setHasApiKey(s.hasApiKey)
      setStatus(s)
    }).catch(() => {
      if (alive) setHasApiKey(null)
    })
    void sharedRead(api, 'settings.get', () => api.settings.get()).then((v) => { if (alive) { setAiProvider(v.aiProvider); setCombined(caps.host === 'plugin' && v.pluginCombinedExtract === true) } }).catch(() => undefined)
    const offStatus = api.pipeline.onStatus((s) => { if (alive) setStatus(s) })
    const coalescer = createProgressFrameCoalescer(
      (callback) => window.requestAnimationFrame(callback),
      (id) => window.cancelAnimationFrame(id),
      (next) => { if (alive) setProgress(next) }
    )
    const off = api.pipeline.onBackfillProgress(coalescer.push)
    return () => {
      alive = false
      offStatus()
      off()
      coalescer.dispose()
    }
  }, [api])

  async function onReviewRecentDays(): Promise<void> {
    if (reviewing) return
    setReviewing(true)
    setReviewNote(null)
    setProgress({ processed: 0, total: 0, phase: 'fetching' })
    try {
      const res = await api.pipeline.reviewLastDays(REVIEW_DAYS)
      setHasApiKey(res.hasApiKey)
      if (!res.ok && !res.hasApiKey) setReviewNote(notReadyShortText(aiProvider))
      else if (!res.ok) setReviewNote(res.note ?? '回顧失敗')
      else setReviewNote(`完成：新增 ${res.todosCreated}、合併 ${res.todosMerged}、完成 ${res.todosResolvedDone}（處理 ${res.chatsProcessed}/${res.chatsSeen} 聊天）`)
    } catch (err) {
      // 等待中的呼叫斷掉（backend 重新啟動 → job_not_found、逾時、權限被撤銷…）不代表回顧結束：一併顯示 backend 回報的目前狀態（G-05）。
      const explained = await explainInterrupted(api, err, '回顧失敗', 'review')
      setReviewNote(explained.text)
      if (explained.view) setTasks(explained.view)
    } finally {
      setReviewing(false)
      setProgress(null)
    }
  }

  async function onBackfillMediaKeys(): Promise<void> {
    if (backfilling) return
    setBackfilling(true)
    setBackfillNote(null)
    try {
      const res = await api.pipeline.backfillMediaKeys(7)
      setBackfillNote(res.ok
        ? `已補 ${res.mediaBackfilled ?? 0} 筆媒體金鑰（掃描 ${res.scanned ?? 0} 則）；可重開來源訊息彈窗查看歷史媒體。`
        : `補金鑰失敗：${res.error ?? '未知錯誤'}`)
    } catch (err) {
      const explained = await explainInterrupted(api, err, '補金鑰失敗', 'mediaBackfill')
      setBackfillNote(explained.text)
      if (explained.view) setTasks(explained.view)
    } finally { setBackfilling(false) }
  }

  async function runNow(): Promise<void> {
    if (running) return
    setRunning(true)
    setRunNote(null)
    try {
      const res = await api.pipeline.runOnce()
      if (res.llmStatus === 'error' || res.chatsFailed > 0 || res.note?.startsWith('busy:')) setRunNote(runResultText(res))
    } catch (err) {
      setRunNote(backendErrorText(err, '整理失敗'))
    } finally { setRunning(false) }
  }

  const reviewBusy = reviewing || (notes.reviewRunning && !statusUnknown)
  const backfillBusy = backfilling || (notes.backfillRunning && !statusUnknown)
  const reviewLabel = reviewing
    ? progress?.phase === 'extracting' && progress.total > 0
      ? `處理中 ${progress.processed}/${progress.total} 聊天…`
      : progress?.phase === 'fetching' ? '撈取訊息中…' : '回顧中…'
    : notes.reviewRunning && !statusUnknown
      ? (notes.reviewText ?? '回顧中…')
      : `🔄 回顧最近 ${REVIEW_DAYS} 天`
  const engineLine = status?.llmStatus === 'error' || status?.llmStatus === 'partial'
    ? (status.lastError ?? (status.llmStatus === 'error' ? '整理失敗' : '部分聊天整理失敗'))
    : null
  const failureLine = runNote ?? engineLine

  return (
    <div className="set-section" data-testid="overview-ops">
      <div className="set-section-title">整理</div>
      <div className="ops-row">
        <button className="btn-review-week" data-testid="ops-notmine" onClick={() => setShowNotMine((v) => !v)}>不是我的回查</button>
        <button className="btn-review-week" data-testid="ops-review" disabled={reviewBusy} onClick={() => void onReviewRecentDays()}
          title={hasApiKey === false ? notReadyShortText(aiProvider) : combined ? `用 AI 判斷最近 ${REVIEW_DAYS} 天訊息、補建代辦（只產出待辦，不會產生群組議題）` : `用 AI 判斷最近 ${REVIEW_DAYS} 天訊息、補建代辦`}>
          {reviewLabel}
        </button>
        <button className="btn-review-week" data-testid="ops-backfill" disabled={backfillBusy} onClick={() => void onBackfillMediaKeys()}
          title="重讀近 7 天訊息、補既有媒體卡片的金鑰（不需金鑰、不跑 AI）">
          {backfillBusy ? '補金鑰中…' : '🖼️ 補媒體金鑰(近7天)'}
        </button>
        <button className="btn-review-week" data-testid="ops-run" disabled={running || status?.busy === true} onClick={() => void runNow()}>
          {combined ? (running ? '整理中…' : '立即整理') : (running ? '抓取中…' : '立即抓取')}
        </button>
      </div>
      {hasApiKey === false && !reviewBusy && <div className="review-hint" data-testid="ops-hint">{notReadyShortText(aiProvider)}</div>}
      {reviewNote && <div className="review-note" data-testid="ops-review-note">{reviewNote}</div>}
      {backfillNote && <div className="review-note" data-testid="ops-backfill-note">{backfillNote}</div>}
      {statusUnknown && remoteRunning && <div className="review-note" data-testid="long-task-status-unknown">{LONG_TASK_STATUS_UNKNOWN_TEXT}</div>}
      {failureLine && <div className="txt-err" role="status" data-testid="ops-failure">{failureLine}</div>}
      {showNotMine && <NotMineReviewPanel api={api} onClose={() => setShowNotMine(false)} onChanged={() => undefined} />}
    </div>
  )
}
