import { useEffect, useState } from 'react'
import { useHostCapabilities, useLineTodoApi } from '../platform/LineTodoApi'

/**
 * MediaView — 訊息裡的圖片與檔案，兩個宿主共用的呈現（MessageStream 與來源訊息彈窗共用）。
 *
 * 圖片網址一律由宿主的 `api.media.assetUrl(msgId)` 提供，元件不知道有哪些 URL scheme：
 *   - standalone：入口（src/renderer/main.tsx）補上 `linemedia://media/<msgId>`（main 的特權協定，解密後串流；見 main/media/protocol.ts）。
 *   - 外掛：1.6.8 view 的 CSP（pluginCsp.ts:15-26）`img-src` 沒有 `linemedia:`，所以 adapter 請 backend 解密寫進 dataDir，回
 *     `window.tuqPlugin.assets.url()` 的網址（`tuqplugin://<id>/data/media-cache/...`）。
 *   宿主沒有提供 `assetUrl` 時，圖片一律視為「尚未下載」。
 * 檔案的「開啟／另存」靠 Electron 的 shell／dialog，外掛版沒有（`mediaFileActions:false`）→ 只顯示檔案卡。
 */

export type MediaUrlState = { status: 'loading'; url: null } | { status: 'ready'; url: string } | { status: 'missing'; url: null }

/** 向宿主解析圖片網址。 */
export function useMediaUrl(msgId: string): MediaUrlState {
  const api = useLineTodoApi()
  const [state, setState] = useState<MediaUrlState>(() => (api.media.assetUrl ? { status: 'loading', url: null } : { status: 'missing', url: null }))

  useEffect(() => {
    const resolve = api.media.assetUrl
    if (!resolve) { setState({ status: 'missing', url: null }); return }
    let alive = true
    setState({ status: 'loading', url: null })
    void resolve.call(api.media, msgId).then(
      (url) => { if (alive) setState(url ? { status: 'ready', url } : { status: 'missing', url: null }) },
      () => { if (alive) setState({ status: 'missing', url: null }) }
    )
    return () => { alive = false }
  }, [api, msgId])

  return state
}

/** 圖片縮圖（點開 lightbox）；載入失敗／尚未下載 → 「尚未下載」。 */
export function MediaImage({ msgId, as: Tag = 'span', onOpenLightbox }: {
  msgId: string
  as?: 'span' | 'div'
  onOpenLightbox: (url: string) => void
}): JSX.Element {
  const media = useMediaUrl(msgId)
  const [failed, setFailed] = useState(false)
  if (failed || media.status === 'missing') return <Tag className="sm-media-missing">尚未下載</Tag>
  if (media.status === 'loading') return <Tag className="sm-media-missing">載入中…</Tag>
  return (
    <Tag className="sm-media">
      <img className="sm-thumb" src={media.url} alt="圖片" onClick={() => onOpenLightbox(media.url)} onError={() => setFailed(true)} />
    </Tag>
  )
}

/** 檔案卡的「開啟／另存」；宿主沒有這個能力時什麼都不渲染。 */
export function MediaFileActions({ msgId, onError }: { msgId: string; onError: (message: string) => void }): JSX.Element | null {
  const api = useLineTodoApi()
  const caps = useHostCapabilities()
  if (!caps.mediaFileActions) return null
  return (
    <span className="sm-file-actions">
      <button type="button" onClick={() => void api.media.open(msgId).then((r) => onError(r.ok ? '' : '無法開啟檔案'))}>
        開啟
      </button>
      <button type="button" onClick={() => void api.media.saveAs(msgId).then((r) => onError(r.ok || r.canceled ? '' : '無法另存檔案'))}>
        另存
      </button>
    </span>
  )
}
