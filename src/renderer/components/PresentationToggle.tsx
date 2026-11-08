import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 頂部列的「整頁」小按鈕：在 tab ↔ fullpage 之間切換（`window.tuqPlugin.presentation.request`）。
 * - 只有宿主提供 `presentation` API 時才出現（standalone、直接用瀏覽器開檔都沒有 → 不顯示）。
 * - 圖示＋tooltip（整頁／還原），沒有說明文字；狀態變化（含按 Esc 退回、宿主自己切換）由 `onChange` 跟上。
 * - 被拒絕（沒焦點、太頻繁、沒授權…）→ 旁邊一行短錯誤，幾秒後自己消失；成功就清掉。
 */

export type PresentationMode = 'tab' | 'fullpage'

/** 本元件用到的 `window.tuqPlugin.presentation` 形狀（SDK PluginPresentationApiV1 的子集）。 */
export interface PresentationSource {
  get?(): Promise<{ mode: PresentationMode }>
  request(mode: PresentationMode): Promise<{ ok: true; state: { mode: PresentationMode } } | { ok: false; error: string }>
  onChange?(listener: (event: { phase: 'before' | 'after'; to: PresentationMode }) => void): (() => void) | void
}

export const PRESENTATION_ERROR_TEXT = '現在無法切換'
export const PRESENTATION_ERROR_MS = 4000

export function hostPresentation(): PresentationSource | null {
  try {
    const source = (typeof window !== 'undefined' ? (window as unknown as { tuqPlugin?: { presentation?: PresentationSource } }).tuqPlugin?.presentation : undefined)
    return source && typeof source.request === 'function' ? source : null
  } catch {
    return null
  }
}

function Icon({ mode }: { mode: PresentationMode }): JSX.Element {
  // tab → 往外四角（放到整頁）；fullpage → 往內四角（還原）
  const d = mode === 'tab'
    ? 'M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4'
    : 'M6 2v4H2M10 2v4h4M14 10h-4v4M2 10h4v4'
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

export function PresentationToggle({ source }: { source?: PresentationSource | null }): JSX.Element | null {
  const presentation = source !== undefined ? source : hostPresentation()
  const [mode, setMode] = useState<PresentationMode>('tab')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!presentation) return undefined
    let live = true
    try {
      void presentation.get?.().then((state) => { if (live && (state.mode === 'tab' || state.mode === 'fullpage')) setMode(state.mode) }, () => undefined)
    } catch { /* get 不可用：維持 tab */ }
    let off: (() => void) | void = undefined
    try {
      off = presentation.onChange?.((event) => {
        if (event.phase === 'after' && (event.to === 'tab' || event.to === 'fullpage')) setMode(event.to)
      })
    } catch { /* 沒有 onChange：只靠 request 的回覆更新 */ }
    return () => { live = false; if (typeof off === 'function') off() }
  }, [presentation])

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const fail = useCallback((code: string): void => {
    setError(code)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setError(null), PRESENTATION_ERROR_MS)
  }, [])

  if (!presentation) return null

  const target: PresentationMode = mode === 'tab' ? 'fullpage' : 'tab'
  const label = mode === 'tab' ? '整頁' : '還原'

  async function toggle(): Promise<void> {
    if (busy || !presentation) return
    setBusy(true)
    try {
      const result = await presentation.request(target)
      if (result.ok) {
        setError(null)
        if (result.state.mode === 'tab' || result.state.mode === 'fullpage') setMode(result.state.mode)
      } else fail(result.error)
    } catch {
      fail('request_failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className="theme-toggle presentation-toggle"
        data-mode={mode}
        aria-label={label}
        title={label}
        disabled={busy}
        onClick={() => { void toggle() }}
      >
        <Icon mode={mode} />
      </button>
      {error !== null && <span className="presentation-error" role="status" title={error}>{PRESENTATION_ERROR_TEXT}</span>}
    </>
  )
}
