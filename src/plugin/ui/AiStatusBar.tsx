import { useEffect, useState } from 'react'
import { describeStatus } from './aiOrchestrator'
import type { AiOrchestrator, OrchestratorStatus } from './aiOrchestrator'

/**
 * 看板左下角的一行 AI 狀態：明示「看板在前景時才會整理新訊息」（設計 v2 §4.3 第 3 點，使用者決策），
 * 以及暫停原因（背景、被限流、額度用完）與不可用原因（Codex 未登入、授權被關閉）。純文字，不發任何請求。
 */
export function AiStatusBar({ orchestrator }: { orchestrator: AiOrchestrator | null }): JSX.Element | null {
  const [status, setStatus] = useState<OrchestratorStatus | null>(() => orchestrator?.status() ?? null)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!orchestrator) return undefined
    setStatus(orchestrator.status())
    return orchestrator.onStatus(setStatus)
  }, [orchestrator])
  // 倒數文字（還有幾秒恢復）每 5 秒重算一次，只在有 resumeAt 時
  useEffect(() => {
    if (status?.resumeAt == null) return undefined
    const timer = setInterval(() => tick((n) => n + 1), 5000)
    return () => clearInterval(timer)
  }, [status?.resumeAt])
  if (!orchestrator || !status) return null
  const attention = status.state === 'unavailable' || status.state === 'revoked'
  return (
    <div
      role="status"
      data-ai-state={status.state}
      data-ai-reason={status.reason ?? ''}
      style={{
        position: 'fixed', left: 12, bottom: 8, maxWidth: 'calc(100vw - 24px)', padding: '3px 10px', borderRadius: 999, fontSize: 12, lineHeight: '18px',
        background: 'var(--chip-bg, #232c38)', color: attention ? 'var(--warn, #d29922)' : 'var(--muted, #8b97a3)', border: '1px solid var(--border, #2a323d)', pointerEvents: 'none', zIndex: 50
      }}
    >
      {describeStatus(status)}
    </div>
  )
}
