import { useEffect, useState } from 'react'
import type { BackendLink, BackendPhase } from '../../renderer/platform/pluginApi'
import { describeLink } from './backendLink'

/** 外掛畫面最上方的一行 backend 連線狀態（G-03；內容見 backendLink.ts）。純顯示，不發任何請求。`backendPhase` 是可選的：有的話，啟動中／連線中不顯示橫幅。 */
export interface BackendLinkSource {
  backendLink(): BackendLink
  onBackendLink(listener: (link: BackendLink) => void): () => void
  backendPhase?(): BackendPhase
  onBackendPhase?(listener: (phase: BackendPhase) => void): () => void
}

export function BackendStatusBar({ source }: { source: BackendLinkSource }): JSX.Element | null {
  const [link, setLink] = useState<BackendLink | null>(() => source.backendLink())
  const [phase, setPhase] = useState<BackendPhase | null>(() => source.backendPhase?.() ?? null)
  useEffect(() => {
    setLink(source.backendLink())
    setPhase(source.backendPhase?.() ?? null)
    const offLink = source.onBackendLink(setLink)
    const offPhase = source.onBackendPhase?.(setPhase)
    return () => { offLink(); offPhase?.() }
  }, [source])
  const shown = describeLink(link, phase)
  if (!shown) return null
  return (
    <div className={`set-notice ${shown.tone}`} role="alert" data-backend-link={link?.state ?? ''} data-backend-code={link?.code ?? ''} style={{ margin: '8px 12px 0' }}>
      <div className="set-notice-body">{shown.text}</div>
    </div>
  )
}
