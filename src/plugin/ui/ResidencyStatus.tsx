import { useCallback, useEffect, useRef, useState } from 'react'
import type { BackendLink } from '../../renderer/platform/pluginApi'
import { RESIDENCY_UNSUPPORTED, describeResidency } from '../../shared/residency'
import type { ResidencySnapshot } from '../../shared/residency'

/**
 * 背景執行（TeamUQ 的 `background:resident`）在畫面上的呈現：看板的狀態列一行（ResidencyStatusBar），設定頁的一個說明區塊（ResidencyNotice）。
 * 文字由 shared/residency.ts 的 `describeResidency` 決定；狀態來自 backend 的 `backend.residency`（Core 的 `context.residency`）與 `residency` 事件。
 * 舊 Core（`supported:false`）什麼都不顯示。純顯示：只在開啟、事件、重新聚焦或按「重新檢查」時問 backend 一次，不輪詢。
 */
export interface ResidencyViewSource {
  residency(): Promise<ResidencySnapshot>
  /** 事件通知（設定 view 沒有事件輪詢，這個函式不會被呼叫到任何東西）。 */
  onResidency(listener: (snapshot: ResidencySnapshot) => void): () => void
  backendLink(): BackendLink
  onBackendLink(listener: (link: BackendLink) => void): () => void
}

interface UseResidencyOptions {
  /** 視窗重新取得焦點／重新可見時重讀（設定 view：使用者剛在 TeamUQ 的「它可以做的事」切換過開關）。 */
  refreshOnFocus: boolean
}

function useResidency(source: ResidencyViewSource, options: UseResidencyOptions): { snapshot: ResidencySnapshot; link: BackendLink; refresh: () => void } {
  const [snapshot, setSnapshot] = useState<ResidencySnapshot>(RESIDENCY_UNSUPPORTED)
  const [link, setLink] = useState<BackendLink>(() => source.backendLink())
  // 事件比較新：一次重讀在途時又收到事件，重讀的回覆不能蓋掉事件帶來的值。
  const generation = useRef(0)
  const refresh = useCallback((): void => {
    const started = generation.current
    source.residency().then((value) => { if (generation.current === started) setSnapshot(value) }, () => undefined)
  }, [source])
  useEffect(() => {
    setLink(source.backendLink())
    const offLink = source.onBackendLink(setLink)
    const offResidency = source.onResidency((value) => { generation.current += 1; setSnapshot(value) })
    refresh()
    return () => { offLink(); offResidency() }
  }, [source, refresh])
  const refreshOnFocus = options.refreshOnFocus
  useEffect(() => {
    if (!refreshOnFocus || typeof document === 'undefined') return undefined
    const onVisible = (): void => { if (document.visibilityState !== 'hidden') refresh() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', refresh)
    return () => { document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', refresh) }
  }, [refreshOnFocus, refresh])
  return { snapshot, link, refresh }
}

/** backend 連不上時不知道實際狀態（連線問題由 BackendStatusBar 說明），所以不顯示背景執行。 */
const reachable = (link: BackendLink): boolean => link.state !== 'revoked' && link.state !== 'unavailable'

/** 看板左下角、AI 狀態列上面的一行。沒有要求背景執行（沒宣告權限）或舊 Core 時不顯示。 */
export function ResidencyStatusBar({ source }: { source: ResidencyViewSource }): JSX.Element | null {
  const { snapshot, link } = useResidency(source, { refreshOnFocus: true })
  const text = reachable(link) ? describeResidency(snapshot) : null
  if (!text || text.bar === '') return null
  return (
    <div
      role="status"
      data-residency-level={snapshot.level}
      data-residency-reason={snapshot.reason ?? ''}
      style={{
        position: 'fixed', left: 12, bottom: 34, maxWidth: 'calc(100vw - 24px)', padding: '3px 10px', borderRadius: 999, fontSize: 12, lineHeight: '18px',
        background: 'var(--chip-bg, #232c38)', color: text.tone === 'warn' ? 'var(--warn, #d29922)' : 'var(--muted, #8b97a3)', border: '1px solid var(--border, #2a323d)', pointerEvents: 'none', zIndex: 50
      }}
    >
      {text.bar}
    </div>
  )
}

/** 設定頁最上方的說明區塊：目前的狀態、原因，以及要去 TeamUQ 的哪個開關。舊 Core 時不顯示。 */
export function ResidencyNotice({ source }: { source: ResidencyViewSource }): JSX.Element | null {
  const { snapshot, link, refresh } = useResidency(source, { refreshOnFocus: true })
  const text = reachable(link) ? describeResidency(snapshot) : null
  if (!text) return null
  return (
    <div
      className={`set-notice${text.tone === 'warn' ? ' warn' : ''}`}
      role="status"
      data-testid="residency-notice"
      data-residency-requested={String(snapshot.requested)}
      data-residency-level={snapshot.level}
      data-residency-reason={snapshot.reason ?? ''}
      style={{ margin: '8px 12px 0' }}
    >
      <div className="set-notice-body">
        <div>{text.detail}</div>
        <div className="set-notice-acts"><button type="button" onClick={refresh}>重新檢查</button></div>
      </div>
    </div>
  )
}
