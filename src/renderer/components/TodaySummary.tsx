import { useEffect, useRef, useState } from 'react'
import type { TodoDTO, PipelineStatus, ReconcileProgress } from '../types/api'
import { isOverdue } from './Board/buckets'

/**
 * TodaySummary — 「今日摘要」面板（IMPLEMENTATION_PLAN.md M3）。
 *
 * 統計：待處理 / 今日到期 / 已逾期 / 待確認完成 / 今日已完成。
 * 並顯示 pipeline 狀態（最後執行、LINE 橋接、LLM 狀態、是否有金鑰）+ 「立即抓取」鈕。
 */

interface Props {
  todos: TodoDTO[]
  loading: boolean
  onRefresh: () => void
}

function todayPrefix(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function isToday(iso: string | null): boolean {
  if (!iso) return false
  return iso.startsWith(todayPrefix())
}

function llmLabel(s: PipelineStatus['llmStatus']): string {
  switch (s) {
    case 'ok':
      return '正常'
    case 'partial':
      return '部分失敗'
    case 'error':
      return '錯誤'
    case 'disabled':
      return '未啟用（缺金鑰）'
    default:
      return '未知'
  }
}

function bridgeLabel(s: PipelineStatus['lineBridge']): string {
  switch (s) {
    case 'ok':
      return '正常'
    case 'error':
      return '錯誤'
    case 'skipped':
      return '略過（無變化）'
    default:
      return '未知'
  }
}

/** 對帳 pill 文案（含具體年月 + 已補筆數）。 */
function reconLabel(p: ReconcileProgress): string {
  if (p.phase === 'done') return '✓ 已是最新'
  if (p.phase === 'scanning') return '偵測缺口月…'
  // backfilling：補齊歷史訊息 第 done+1/total 個月（ym）
  const monthNo = Math.min(p.done + 1, p.total)
  const ymPart = p.ym ? `（${p.ym}）` : ''
  return `補齊歷史訊息 第 ${monthNo}/${p.total} 個月${ymPart}`
}

/** pill 下方 mini 進度條寬度（%）。 */
function reconPct(p: ReconcileProgress): number {
  if (p.phase === 'done') return 100
  if (p.total <= 0) return 0
  return Math.round((p.done / p.total) * 100)
}

export function TodaySummary({ todos, loading, onRefresh }: Props): JSX.Element {
  const [status, setStatus] = useState<PipelineStatus | null>(null)
  const [running, setRunning] = useState(false)

  // 自我對帳進度（方案 A：低調 pill）。backfilling 顯示；done 顯示綠勾後淡出；
  // scanning 顯示「偵測缺口…」；source-unavailable / db-unhealthy / skipped 為終態，直接隱藏。
  const [recon, setRecon] = useState<ReconcileProgress | null>(null)
  const [reconFading, setReconFading] = useState(false)
  const reconTimers = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => {
    void window.api.pipeline.status().then(setStatus)
    const off = window.api.pipeline.onStatus(setStatus)
    return off
  }, [])

  useEffect(() => {
    const timers = reconTimers.current
    const off = window.api.pipeline.onReconcileProgress((p) => {
      timers.forEach(clearTimeout)
      timers.length = 0
      if (p.phase === 'scanning' || p.phase === 'backfilling') {
        setReconFading(false)
        setRecon(p)
      } else if (p.phase === 'done') {
        setReconFading(false)
        setRecon(p)
        // 顯示綠勾約 2.6s 後淡出、再移除。
        timers.push(setTimeout(() => setReconFading(true), 2200))
        timers.push(setTimeout(() => setRecon(null), 2600))
      } else {
        // source-unavailable / db-unhealthy / skipped：終態不打擾，直接隱藏。
        setRecon(null)
      }
    })
    return () => {
      off()
      timers.forEach(clearTimeout)
      timers.length = 0
    }
  }, [])

  const active = todos.filter((t) =>
    ['pending', 'waiting_reply', 'scheduled'].includes(t.status)
  )
  const dueToday = active.filter((t) => isToday(t.dueAt))
  const overdue = active.filter((t) => isOverdue(t.dueAt))
  const suggested = todos.filter((t) => t.status === 'suggested_done')
  const doneToday = todos.filter(
    (t) => t.status === 'done' && isToday(t.resolvedAt)
  )

  async function runNow(): Promise<void> {
    setRunning(true)
    try {
      await window.api.pipeline.runOnce()
      onRefresh()
    } catch (err) {
      console.error('[summary] runOnce 失敗：', err)
    } finally {
      setRunning(false)
    }
  }

  const stats = [
    { label: '待處理', value: active.length, cls: '' },
    { label: '今日到期', value: dueToday.length, cls: 'stat-due' },
    { label: '已逾期', value: overdue.length, cls: 'stat-overdue' },
    { label: '待確認完成', value: suggested.length, cls: 'stat-suggested' },
    { label: '今日已完成', value: doneToday.length, cls: 'stat-done' }
  ]

  return (
    <section className="summary">
      <div className="summary-stats">
        {stats.map((s) => (
          <div key={s.label} className={`stat ${s.cls}`}>
            <div className="stat-num">{loading ? '–' : s.value}</div>
            <div className="stat-label">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="summary-right">
        <div className="summary-status">
          <div>
            <span className="muted">LINE 橋接：</span>
            <span className={status?.lineBridge === 'error' ? 'txt-err' : ''}>
              {status ? bridgeLabel(status.lineBridge) : '…'}
            </span>
          </div>
          {recon && (recon.phase === 'scanning' || recon.phase === 'backfilling' || recon.phase === 'done') && (
            <div className={`recon-pill-wrap${reconFading ? ' fade-out' : ''}`}>
              <span className={`recon-pill${recon.phase === 'done' ? ' done' : ''}`}>
                {recon.phase === 'done' ? (
                  <span className="check">✓</span>
                ) : (
                  <span className="spin"></span>
                )}
                <span>{reconLabel(recon)}</span>
              </span>
              {recon.phase !== 'scanning' && (
                <span className="recon-mini-bar">
                  <i style={{ width: `${reconPct(recon)}%` }}></i>
                </span>
              )}
            </div>
          )}
          <div>
            <span className="muted">抽取引擎：</span>
            <span
              className={
                status?.llmStatus === 'error'
                  ? 'txt-err'
                  : status?.llmStatus === 'disabled'
                    ? 'txt-warn'
                    : ''
              }
            >
              {status ? llmLabel(status.llmStatus) : '…'}
            </span>
          </div>
          {status && !status.hasApiKey && (
            <div className="txt-warn">⚠ 請在設定頁填入 API 金鑰才會抽取代辦</div>
          )}
          {status?.lastRunAt && (
            <div className="muted">
              上次抓取：{status.lastRunAt.slice(0, 19).replace('T', ' ')}
            </div>
          )}
        </div>
        <button onClick={() => void runNow()} disabled={running || status?.busy}>
          {running ? '抓取中…' : '立即抓取'}
        </button>
      </div>
    </section>
  )
}
