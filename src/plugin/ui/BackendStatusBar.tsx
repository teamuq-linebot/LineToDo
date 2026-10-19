import { useEffect, useState } from 'react'
import type { BackendLink } from '../../renderer/platform/pluginApi'
import { describeLink } from './backendLink'

/** 外掛畫面最上方的一行 backend 連線狀態（G-03；內容見 backendLink.ts）。純顯示，不發任何請求。 */
export interface BackendLinkSource {
  backendLink(): BackendLink
  onBackendLink(listener: (link: BackendLink) => void): () => void
}

export function BackendStatusBar({ source }: { source: BackendLinkSource }): JSX.Element | null {
  const [link, setLink] = useState<BackendLink | null>(() => source.backendLink())
  useEffect(() => {
    setLink(source.backendLink())
    return source.onBackendLink(setLink)
  }, [source])
  const shown = describeLink(link)
  if (!shown) return null
  return (
    <div className={`set-notice ${shown.tone}`} role="alert" data-backend-link={link?.state ?? ''} data-backend-code={link?.code ?? ''} style={{ margin: '8px 12px 0' }}>
      <div className="set-notice-body">{shown.text}</div>
    </div>
  )
}
