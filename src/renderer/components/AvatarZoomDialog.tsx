import { useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'

/**
 * 頭像放大視窗：只有大頭貼與名字。Esc、點背景、右上角關閉鈕都會關閉；開啟時焦點進入視窗。
 * 關閉後焦點回到原頭像由呼叫端處理（它握有觸發的按鈕）。
 */
export function AvatarZoomDialog({ src, name, onClose }: { src: string; name: string; onClose: () => void }): JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === 'Tab') {
      // 視窗內只有關閉鈕：焦點留在視窗裡。
      e.preventDefault()
      closeRef.current?.focus()
    }
  }

  function onBackdropClick(e: ReactMouseEvent<HTMLDivElement>): void {
    if (e.target === e.currentTarget) onClose()
  }

  return createPortal(
    <div
      className="avatar-zoom-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={name}
      tabIndex={-1}
      onClick={onBackdropClick}
      onKeyDown={onKeyDown}
    >
      <button ref={closeRef} type="button" className="avatar-zoom-close" aria-label="關閉" onClick={onClose}>×</button>
      <div className="avatar-zoom-card">
        <img className="avatar-zoom-photo" src={src} alt="" draggable={false} />
        <div className="avatar-zoom-name">{name}</div>
      </div>
    </div>,
    document.body
  )
}
