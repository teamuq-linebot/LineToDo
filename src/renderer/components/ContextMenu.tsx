import type { CSSProperties, KeyboardEvent, ReactNode, RefObject } from 'react'

/**
 * ContextMenu — 看板欄標題與聊天室列表共用的右鍵選單外殼：整頁透明遮罩（點外面或在外面按右鍵就關）＋ role=menu 的選單。
 * 位置由呼叫端決定（欄標題用 CSS 相對定位，聊天室列表用 position:fixed 加 lib/zoom.ts 的 placeFixedMenu）。
 */

interface ContextMenuProps {
  menuRef?: RefObject<HTMLDivElement>
  /** 加在 `menu-pop` 後面的樣式 class。 */
  className?: string
  style?: CSSProperties
  /** 點遮罩、或在遮罩上按右鍵。 */
  onDismiss: () => void
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  children: ReactNode
}

export function ContextMenu({ menuRef, className, style, onDismiss, onKeyDown, children }: ContextMenuProps): JSX.Element {
  return (
    <>
      <div
        className="menu-backdrop"
        onMouseDown={() => onDismiss()}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onDismiss()
        }}
      />
      <div
        ref={menuRef}
        className={className ? `menu-pop ${className}` : 'menu-pop'}
        role="menu"
        style={style}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
      >
        {children}
      </div>
    </>
  )
}

interface ContextMenuItemProps {
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}

export function ContextMenuItem({ disabled, onClick, children }: ContextMenuItemProps): JSX.Element {
  return (
    <button type="button" role="menuitem" className="menu-item" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  )
}
