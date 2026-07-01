import { useEffect, useState } from 'react'
import type { TodoDTO, PipelineStatus } from '../types/api'
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

export function TodaySummary({ todos, loading, onRefresh }: Props): JSX.Element {
  const [status, setStatus] = useState<PipelineStatus | null>(null)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    void window.api.pipeline.status().then(setStatus)
    const off = window.api.pipeline.onStatus(setStatus)
    return off
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
            <div className="txt-warn">⚠ 請在設定頁填入 qwen 金鑰才會抽取代辦</div>
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
