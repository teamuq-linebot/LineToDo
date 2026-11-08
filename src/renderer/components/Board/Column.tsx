import { memo, useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { TodoDTO } from '../../types/api'
import { COLUMNS, type ColumnDef, type ColumnId } from './buckets'
import { TodoCard, type TodoCardActions } from './TodoCard'
import type { ChatNameMap } from '../../store/useTodos'
import type { BoardDnd } from './KanbanBoard'
import { ContextMenu, ContextMenuItem } from '../ContextMenu'
import { focusFirstMenuItem, useContextMenuKeys } from '../../hooks/useContextMenuKeys'

/**
 * Column — 看板單欄（待辦 / 等回覆 / 行程 / 已完成）。
 * 頂部標題 + 計數；下方垂直排列該欄的卡片。
 * 卡片分批渲染：一開始只畫前 COLUMN_PAGE_SIZE 張，捲到欄底（哨兵進入視野）再補一批，直到全部；
 * 資料、標題計數、「全部移到」都仍是該欄全部卡片。resetKey（排序／篩選／grouping）改變時回到第一批並捲回頂端。
 */

export const COLUMN_PAGE_SIZE = 30

interface Props {
  def: ColumnDef
  todos: TodoDTO[]
  chatMap: ChatNameMap
  actions: TodoCardActions
  groupByChat: boolean
  viewedLocalIds: Set<string>
  dnd: BoardDnd
  /** 欄標題選單選了「全部移到 X」：由看板先跳確認。 */
  onBulkMove: (from: ColumnId, to: ColumnId) => void
  /** 看板用來在確認框關閉後把焦點還給欄標題。 */
  headRefs: MutableRefObject<Partial<Record<ColumnId, HTMLElement | null>>>
  /** 排序／篩選／grouping 的組合；改變時已展開的張數回到第一批。 */
  resetKey: string
}

interface TodoChatGroup {
  chatId: string
  todos: TodoDTO[]
}

function groupTodosByChat(todos: TodoDTO[]): TodoChatGroup[] {
  const groups: TodoChatGroup[] = []
  const seen = new Map<string, TodoChatGroup>()
  for (const todo of todos) {
    const existing = seen.get(todo.chatId)
    if (existing) {
      existing.todos.push(todo)
      continue
    }
    const group = { chatId: todo.chatId, todos: [todo] }
    seen.set(todo.chatId, group)
    groups.push(group)
  }
  return groups
}

function ColumnView({
  def,
  todos,
  chatMap,
  actions,
  groupByChat,
  viewedLocalIds,
  dnd,
  onBulkMove,
  headRefs,
  resetKey
}: Props): JSX.Element {
  const [batch, setBatch] = useState({ key: resetKey, shown: COLUMN_PAGE_SIZE })
  let shown = batch.shown
  if (batch.key !== resetKey) {
    shown = COLUMN_PAGE_SIZE
    setBatch({ key: resetKey, shown })
  }
  const hasMore = todos.length > shown
  const rendered = hasMore ? todos.slice(0, shown) : todos
  const groups = groupByChat ? groupTodosByChat(rendered) : []
  const chatTotals = new Map<string, number>()
  if (groupByChat) for (const todo of todos) chatTotals.set(todo.chatId, (chatTotals.get(todo.chatId) ?? 0) + 1)
  const bodyRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const loadMore = useCallback((all = false) => {
    setBatch((cur) => ({ key: resetKey, shown: all ? Number.MAX_SAFE_INTEGER : (cur.key === resetKey ? cur.shown : COLUMN_PAGE_SIZE) + COLUMN_PAGE_SIZE }))
  }, [resetKey])

  useEffect(() => {
    const body = bodyRef.current
    if (body && body.scrollTop !== 0) body.scrollTop = 0
  }, [resetKey])

  // 哨兵（欄底的 1px 空元素）進入欄的捲動容器視野就補一批；每補一批重新觀察，所以批次仍填不滿欄高時會接著補。
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!hasMore || !sentinel) return
    if (typeof IntersectionObserver === 'undefined') {
      loadMore(true)
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore()
    }, { root: bodyRef.current, rootMargin: '0px 0px 160px 0px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, shown, loadMore])
  const [menuOpen, setMenuOpen] = useState(false)
  const headRef = useRef<HTMLElement | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  function openMenu(): void {
    setMenuOpen(true)
    focusFirstMenuItem(menuRef)
  }

  function closeMenu(refocus: boolean): void {
    setMenuOpen(false)
    if (refocus) headRef.current?.focus?.()
  }

  const onHeadKeyDown = useContextMenuKeys({ open: menuOpen, menuRef, onOpen: openMenu, onClose: closeMenu })

  function renderCard(todo: TodoDTO): JSX.Element {
    return (
      <TodoCard
        key={todo.id}
        todo={todo}
        chatName={chatMap[todo.chatId]?.name ?? null}
        isGroup={chatMap[todo.chatId]?.isGroup ?? false}
        viewedLocally={viewedLocalIds.has(todo.id)}
        showLocalViewed={def.id === 'done'}
        actions={actions}
        dnd={{
          dragging: dnd.draggingId === todo.id,
          onDragStart: dnd.onCardDragStart,
          onDragEnd: dnd.onCardDragEnd
        }}
      />
    )
  }

  return (
    <section
      className={`kb-column col-${def.id}${dnd.dragOverCol === def.id ? ' drop-active' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        dnd.onColumnDragOver(def.id)
      }}
      onDrop={(e) => {
        e.preventDefault()
        const id = e.dataTransfer.getData('text/plain') || dnd.draggingId || ''
        if (id) dnd.onColumnDrop(def.id, id)
      }}
    >
      <header
        ref={(el) => {
          headRef.current = el
          headRefs.current[def.id] = el
        }}
        className="kb-col-head"
        tabIndex={0}
        role="button"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onContextMenu={(e) => {
          e.preventDefault()
          openMenu()
        }}
        onKeyDown={onHeadKeyDown}
        onBlur={(e) => {
          if (menuOpen && !e.currentTarget.contains(e.relatedTarget as Node | null)) setMenuOpen(false)
        }}
      >
        <span className="kb-col-title">{def.title}</span>
        <span className="kb-col-count">{todos.length}</span>
        {menuOpen && (
          <ContextMenu menuRef={menuRef} className="kb-col-menu" onDismiss={() => closeMenu(false)}>
            {COLUMNS.filter((other) => other.id !== def.id).map((other) => (
              <ContextMenuItem
                key={other.id}
                disabled={todos.length === 0}
                onClick={() => {
                  closeMenu(true)
                  onBulkMove(def.id, other.id)
                }}
              >
                {`全部移到${other.title}`}
              </ContextMenuItem>
            ))}
          </ContextMenu>
        )}
      </header>
      <div className="kb-col-body" ref={bodyRef}>
        {todos.length === 0 ? (
          <div className="kb-col-empty muted">{def.emptyHint}</div>
        ) : groupByChat ? (
          groups.map((group) => {
            const info = chatMap[group.chatId]
            return (
              <div key={group.chatId} className="todo-chat-group">
                <div className="todo-chat-group-head">
                  <span className="todo-chat-group-name" title={group.chatId}>
                    {info?.isGroup ? '👥 ' : '💬 '}
                    {info?.name ?? group.chatId}
                  </span>
                  <span className="todo-chat-group-count">{chatTotals.get(group.chatId) ?? group.todos.length} 件</span>
                </div>
                <div className="todo-chat-group-items">{group.todos.map(renderCard)}</div>
              </div>
            )
          })
        ) : (
          rendered.map(renderCard)
        )}
        {hasMore && <div ref={sentinelRef} className="kb-col-sentinel" data-testid="kb-col-sentinel" aria-hidden="true" />}
      </div>
    </section>
  )
}

export const Column = memo(ColumnView)
