import { useEffect, useState } from 'react'
import type { BackendLink } from '../../renderer/platform/pluginApi'
import type { AiStatus } from '../../shared/aiStatus'
import { describeStatus } from './aiStatusText'

/** AI 整理的狀態來源：backend 的 `ai.status`＋事件 `ai-status`，以及看板與 backend 的連線狀態（連不上時 backend 無法回報）。 */
export interface AiStatusSource {
  /** 已知的最新狀態（同步；第一次繪製就用，不必等 backend 回覆）。 */
  snapshot?(): AiStatus | null
  aiStatus(): Promise<AiStatus>
  onAiStatus(listener: (status: AiStatus) => void): () => void
  backendLink(): BackendLink
  onBackendLink(listener: (link: BackendLink) => void): () => void
}

/** 看板連不上 backend 時的狀態（AI 在 backend，所以整理也停了）。 */
function linkStatus(link: BackendLink): AiStatus | null {
  if (link.state !== 'revoked' && link.state !== 'unavailable') return null
  return { state: 'paused', reason: link.state === 'revoked' ? 'backend_revoked' : 'backend', resumeAt: null, busy: false, provider: null, counters: { turns: 0, repairs: 0, extracted: 0, rejected: 0, failed: 0, released: 0, tasksDone: 0, tasksFailed: 0, rateLimited: 0 } }
}

/**
 * 看板左下角的一行 AI 狀態：AI 由外掛背景程式執行，看板不需要開著（0.2.0）；這裡顯示暫停原因（被限流、額度用完）與
 * 不可用原因（Codex 未登入、授權被關閉）。純文字；狀態來自 backend，不發任何 AI 請求。
 */
export function AiStatusBar({ source }: { source: AiStatusSource }): JSX.Element | null {
  const [backendStatus, setBackendStatus] = useState<AiStatus | null>(() => source.snapshot?.() ?? null)
  const [link, setLink] = useState<BackendLink>(() => source.backendLink())
  const [, tick] = useState(0)
  useEffect(() => {
    let alive = true
    setLink(source.backendLink())
    const offLink = source.onBackendLink(setLink)
    const offStatus = source.onAiStatus((status) => { if (alive) setBackendStatus(status) })
    source.aiStatus().then((status) => { if (alive) setBackendStatus((current) => current ?? status) }, () => undefined)
    return () => { alive = false; offLink(); offStatus() }
  }, [source])
  const status = linkStatus(link) ?? backendStatus
  // 看板重新可見（切回分頁、從背景回來）時重查一次：隱藏期間的 `ai-status` 事件可能漏掉了，狀態會停在過期的樣子（review F10）。
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    let alive = true
    const requery = (): void => {
      if (document.visibilityState === 'hidden') return
      source.aiStatus().then((status) => { if (alive) setBackendStatus(status) }, () => undefined)
    }
    document.addEventListener('visibilitychange', requery)
    return () => { alive = false; document.removeEventListener('visibilitychange', requery) }
  }, [source])
  // 倒數文字（還有幾秒恢復）每 5 秒重算一次，只在有 resumeAt 時
  useEffect(() => {
    if (status?.resumeAt == null) return undefined
    const timer = setInterval(() => tick((n) => n + 1), 5000)
    return () => clearInterval(timer)
  }, [status?.resumeAt])
  if (!status) return null
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
      {describeStatus(status)}{status.provider?.modelId ? ` · ${status.provider.modelId}` : ''}
    </div>
  )
}
