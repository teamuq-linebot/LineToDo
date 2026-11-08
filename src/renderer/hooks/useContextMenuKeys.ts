import { useCallback, type KeyboardEvent, type RefObject } from 'react'

/** 把焦點移到選單的第一個可用項目（選單剛開時呼叫；等 render 完成再找）。 */
export function focusFirstMenuItem(menuRef: RefObject<HTMLElement>): void {
  setTimeout(() => menuRef.current?.querySelector?.<HTMLElement>('button:not(:disabled)')?.focus?.(), 0)
}

interface Options {
  open: boolean
  menuRef: RefObject<HTMLElement>
  /** ContextMenu 鍵或 Shift+F10；收到的是按鍵發生的那個元素的事件。 */
  onOpen: (event: KeyboardEvent<HTMLElement>) => void
  /** Escape；`refocus` 為 true 時呼叫端把焦點還給觸發的元素。 */
  onClose: (refocus: boolean) => void
}

/** 選單的鍵盤操作：ContextMenu／Shift+F10 開、Escape 關、上下鍵在可用項目之間循環。 */
export function useContextMenuKeys({ open, menuRef, onOpen, onClose }: Options): (event: KeyboardEvent<HTMLElement>) => void {
  return useCallback((event) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      onClose(true)
    } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault()
      onOpen(event)
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && open) {
      event.preventDefault()
      const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])
      if (items.length === 0) return
      const at = items.indexOf(document.activeElement as HTMLElement)
      const step = event.key === 'ArrowDown' ? 1 : -1
      items[(at + step + items.length) % items.length].focus()
    }
  }, [open, menuRef, onOpen, onClose])
}
