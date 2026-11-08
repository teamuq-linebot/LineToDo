import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * HeaderStatusSlot — 讓聊天頁把「LINE 橋接」狀態列畫在最上面的標題列。
 *
 * 狀態與重試都在 MessageStream 裡，所以不搬狀態，只把畫面透過 portal 送到標題列的插槽：
 *   - 沒有 Provider（單獨掛 MessageStream 的測試、其他宿主）：原位渲染，行為與以前完全相同。
 *   - 有 Provider 但插槽還沒掛好：先不渲染（避免先在內容區閃一下再跳走）。
 *   - 插槽掛好：portal 到插槽。只有聊天分頁會渲染插槽，其他分頁沒有狀態列。
 */

interface SlotState {
  node: HTMLElement | null
  setNode: (node: HTMLElement | null) => void
}

const SlotContext = createContext<SlotState | null>(null)

export function HeaderStatusProvider({ children }: { children: ReactNode }): JSX.Element {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const value = useMemo(() => ({ node, setNode }), [node])
  return <SlotContext.Provider value={value}>{children}</SlotContext.Provider>
}

/** 標題列裡放狀態列的位置。 */
export function HeaderStatusSlot(): JSX.Element {
  const slot = useContext(SlotContext)
  return <div className="app-header-status" data-testid="header-status-slot" ref={slot?.setNode} />
}

export function HeaderStatus({ children }: { children: ReactNode }): JSX.Element | null {
  const slot = useContext(SlotContext)
  if (!slot) return <>{children}</>
  if (!slot.node) return null
  return createPortal(children, slot.node)
}
