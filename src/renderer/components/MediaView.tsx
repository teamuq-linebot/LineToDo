import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { PurchasePackageId } from './PurchasePage'
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

export type MediaUrlState = { status: 'loading'; url: null } | { status: 'indexing'; url: null } | { status: 'ready'; url: string } | { status: 'missing'; url: null }

/**
 * 索引還在建立時（`api.media.assetLookup` 回 `indexing: true`）的自動重試：同一張圖第一次重試等 `baseMs`（2 s），之後每次加倍、上限 `maxMs`，最多重試 `maxRetries` 次，用完就當「尚未下載」。
 * 索引就緒（回的不再是 indexing）、元件卸載（effect 清理會取消計時器、之後不再發請求）也會停。重試走同一個 `media.prepare`，所以在 transport 的 bulk lane。
 * 是個可變物件只是為了讓測試縮短等待；正式程式不改它。
 */
export const mediaIndexingRetry = { baseMs: 2_000, maxMs: 30_000, maxRetries: 8 }
const retryDelay = (retry: number): number => Math.min(mediaIndexingRetry.maxMs, mediaIndexingRetry.baseMs * 2 ** retry)

/** 向宿主解析圖片網址。 */
export function useMediaUrl(msgId: string): MediaUrlState {
  const api = useLineTodoApi()
  const [state, setState] = useState<MediaUrlState>(() => (api.media.assetLookup || api.media.assetUrl ? { status: 'loading', url: null } : { status: 'missing', url: null }))

  useEffect(() => {
    const lookup = api.media.assetLookup
    const resolve = api.media.assetUrl
    if (!lookup && !resolve) { setState({ status: 'missing', url: null }); return }
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    setState({ status: 'loading', url: null })
    const attempt = (retry: number): void => {
      const asked = lookup
        ? lookup.call(api.media, msgId)
        : resolve!.call(api.media, msgId).then((url) => ({ url, indexing: false }))
      void asked.then(
        ({ url, indexing }) => {
          if (!alive) return
          if (url) { setState({ status: 'ready', url }); return }
          if (indexing && retry < mediaIndexingRetry.maxRetries) {
            setState({ status: 'indexing', url: null })
            timer = setTimeout(() => { timer = null; if (alive) attempt(retry + 1) }, retryDelay(retry))
            return
          }
          setState({ status: 'missing', url: null })
        },
        () => { if (alive) setState({ status: 'missing', url: null }) }
      )
    }
    attempt(0)
    return () => { alive = false; if (timer !== null) { clearTimeout(timer); timer = null } }
  }, [api, msgId])

  return state
}

/** 圖片縮圖（點開 lightbox）；載入失敗／尚未下載 → 「尚未下載」。 */
export function MediaImage({ msgId, as: Tag = 'span', onOpenLightbox, onPurchase }: {
  msgId: string
  as?: 'span' | 'div'
  onOpenLightbox: (url: string) => void
  onPurchase?: (packageId: PurchasePackageId, source: HTMLElement) => void
}): JSX.Element {
  const media = useMediaUrl(msgId)
  const [failed, setFailed] = useState(false)
  if (failed || media.status === 'missing') return <Tag className="sm-media-missing">{onPurchase ? <MissingMediaEntry onPurchase={onPurchase} /> : '尚未下載'}</Tag>
  if (media.status === 'loading') return <Tag className="sm-media-missing">載入中…</Tag>
  if (media.status === 'indexing') return <Tag className="sm-media-missing">索引建立中…</Tag>
  return (
    <Tag className="sm-media">
      <img className="sm-thumb" src={media.url} alt="圖片" onClick={() => onOpenLightbox(media.url)} onError={() => setFailed(true)} />
    </Tag>
  )
}

/** CT=7 local sticker: the plugin backend resolves private metadata to a safe host asset URL. */
export function StickerImage({ msgId, onOpenLightbox }: { msgId: string; onOpenLightbox: (url: string) => void }): JSX.Element {
  const api = useLineTodoApi()
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    setUrl(null)
    setFailed(false)
    const resolve = api.media.stickerAssetUrl
    if (!resolve) { setFailed(true); return () => { alive = false } }
    void resolve.call(api.media, msgId).then((value) => {
      if (alive) {
        if (value) setUrl(value)
        else setFailed(true)
      }
    }, () => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [api, msgId])
  if (!url || failed) return <span className="sm-sticker-missing" role="img" aria-label="貼圖目前無法顯示">貼圖目前無法顯示</span>
  return <img className="sm-sticker-img" src={url} alt="貼圖" loading="lazy" decoding="async" onClick={() => onOpenLightbox(url)} onError={() => setFailed(true)} />
}

function MissingMediaEntry({ onPurchase }: { onPurchase: (packageId: PurchasePackageId, source: HTMLElement) => void }): JSX.Element {
  const tooltipId = useId()
  const rootRef = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 8, top: 8 })
  useLayoutEffect(() => {
    if (!open || !rootRef.current || !tipRef.current) return
    const anchor = rootRef.current.getBoundingClientRect()
    const tip = tipRef.current.getBoundingClientRect()
    const left = Math.max(8, Math.min(anchor.left + anchor.width / 2 - tip.width / 2, window.innerWidth - tip.width - 8))
    const top = anchor.top - tip.height - 8 >= 8 ? anchor.top - tip.height - 8 : Math.min(anchor.bottom + 8, window.innerHeight - tip.height - 8)
    setPosition({ left, top: Math.max(8, top) })
  }, [open])
  return (
    <span className="advanced-entry" ref={rootRef} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" className="advanced-entry-button" aria-label="進階：自動保存圖片" aria-describedby={open ? tooltipId : undefined}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={(event) => { if (event.key === 'Escape') { setOpen(false); event.currentTarget.blur() } }}
        onClick={(event) => onPurchase('line', event.currentTarget)}>進階</button>
      {open && <span id={tooltipId} ref={tipRef} role="tooltip" className="advanced-entry-tooltip" style={{ left: position.left, top: position.top }}>自動保存圖片屬進階功能｜查看方案</span>}
    </span>
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
