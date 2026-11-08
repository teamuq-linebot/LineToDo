import { useLineTodoApi } from '../../platform/LineTodoApi'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  TodoDTO,
  TodoSortBy,
  TodoSortDirection
} from '../../types/api'
import { COLUMNS, columnOf, type ColumnId } from './buckets'
import { Column } from './Column'
import { useTodos } from '../../store/useTodos'
import { DraftReplyDialog } from '../DraftReplyDialog'
import type { TodoCardActions } from './TodoCard'
import { backendErrorText } from '../../lib/backendError'
import {
  parseBoolean, parseOneOf, parseShortString, parseStringSet, serializeStringSet, usePersistentState
} from '../../lib/uiState'

/**
 * KanbanBoard — 四欄看板容器（IMPLEMENTATION_PLAN.md M3）。
 *
 * 上方篩選列；下方四欄（待辦 / 等回覆 / 行程 / 已完成）。回顧、補媒體金鑰、不是我的回查與立即整理在設定分頁的「整理」區塊（Settings/OverviewOps）。
 * 資料與動作來自 useTodos；草擬回覆以 DraftReplyDialog modal 呈現。
 *
 * 外掛開發者指南對應：
 *   - G-02：讀取失敗（useTodos.error）顯示原因與「重試」；拖曳搬移、開原聊天失敗也顯示，不會安靜變成空白看板。
 *   - G-04：排序、篩選、分組、本機「已讀」標記與開著的草擬回覆對話框存進 UI 狀態（lib/uiState.ts），view 重新建立後還原（standalone 不保存）。
 */

type ChatKindFilter = 'all' | 'group' | 'direct'
type LocalViewedFilter = 'all' | 'unviewed' | 'viewed'

const parseSortBy = parseOneOf<TodoSortBy>(['updatedAt', 'createdAt', 'dueAt', 'priority'])
const parseSortDirection = parseOneOf<TodoSortDirection>(['desc', 'asc'])
const parseChatKind = parseOneOf<ChatKindFilter>(['all', 'group', 'direct'])
const parseLocalViewed = parseOneOf<LocalViewedFilter>(['all', 'unviewed', 'viewed'])
const parseChatId = parseShortString(200)
const parseViewedIds = parseStringSet(5000)
const serializeViewedIds = serializeStringSet(5000)
const parseDraftTodoId = (raw: unknown): string | null | undefined => (raw === null ? null : parseChatId(raw))
/** 欄級 DnD 契約：KanbanBoard → Column。 */
export interface BoardDnd {
  draggingId: string | null
  dragOverCol: ColumnId | null
  onCardDragStart: (id: string) => void
  onCardDragEnd: () => void
  onColumnDragOver: (col: ColumnId) => void
  onColumnDrop: (col: ColumnId, id: string) => void
}

/** 卡級 DnD 契約：Column → TodoCard。 */
export interface CardDnd {
  dragging: boolean
  onDragStart: (id: string) => void
  onDragEnd: () => void
}

export function KanbanBoard({ onFirstLoaded }: { onFirstLoaded?: () => void } = {}): JSX.Element {
  const api = useLineTodoApi()
  const [sortBy, setSortBy] = usePersistentState<TodoSortBy>('board.sortBy', 'updatedAt', parseSortBy)
  const [sortDirection, setSortDirection] = usePersistentState<TodoSortDirection>('board.sortDirection', 'desc', parseSortDirection)
  const [chatFilter, setChatFilter] = usePersistentState<string>('board.chatFilter', '', parseChatId)
  const [chatKindFilter, setChatKindFilter] = usePersistentState<ChatKindFilter>('board.chatKindFilter', 'all', parseChatKind)
  const [groupByChat, setGroupByChat] = usePersistentState<boolean>('board.groupByChat', false, parseBoolean)
  const [localViewedFilter, setLocalViewedFilter] = usePersistentState<LocalViewedFilter>('board.localViewedFilter', 'all', parseLocalViewed)
  const [viewedLocalIds, setViewedLocalIds] = usePersistentState<Set<string>>('board.viewedLocalIds', () => new Set(), parseViewedIds, serializeViewedIds)
  const t = useTodos({
    sortBy,
    sortDirection,
    chatId: chatFilter || undefined
  })
  // 第一次載入待辦（成功或失敗）完成後通知外層（總覽頁據此才掛載議題區）。
  useEffect(() => {
    if (!t.loading) onFirstLoaded?.()
  }, [t.loading, onFirstLoaded])
  // 開著的草擬回覆對話框記 todo id（重新開啟畫面後，待辦載入完就回到同一個對話框；草稿內容由對話框自己保存）。
  const [draftTodoId, setDraftTodoId] = usePersistentState<string | null>('board.draftTodoId', null, parseDraftTodoId)
  const draftTodo = useMemo(() => (draftTodoId ? t.todos.find((x) => x.id === draftTodoId) ?? null : null), [draftTodoId, t.todos])
  /** 看板層級的動作失敗（拖曳搬移等）。 */
  const [boardNote, setBoardNote] = useState<string | null>(null)

  // 看板拖曳搬移狀態（§3.2）：拖曳中卡片 id、目前 dragover 的目標欄。
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverCol, setDragOverCol] = useState<ColumnId | null>(null)
  // 欄標題選單「全部移到 X」：先記下當下（篩選後）該欄的 id，確認後才搬。
  const [pendingMove, setPendingMove] = useState<{ from: ColumnId; to: ColumnId; ids: string[] } | null>(null)
  const [bulkMoving, setBulkMoving] = useState(false)

  const dnd: BoardDnd = useMemo(
    () => ({
      draggingId,
      dragOverCol,
      onCardDragStart: (id: string) => setDraggingId(id),
      onCardDragEnd: () => {
        setDraggingId(null)
        setDragOverCol(null)
      },
      onColumnDragOver: (col: ColumnId) => setDragOverCol(col),
      onColumnDrop: (col: ColumnId, id: string) => {
        const todo = t.todos.find((x) => x.id === id)
        if (todo) {
          void t.moveToColumn(todo, col).then(
            () => setBoardNote(null),
            (error: unknown) => setBoardNote(backendErrorText(error, '搬移失敗'))
          )
        }
        setDraggingId(null)
        setDragOverCol(null)
      }
    }),
    [draggingId, dragOverCol, t.todos, t.moveToColumn]
  )

  const chatOptions = useMemo(
    () =>
      Object.entries(t.chatMap)
        .map(([chatId, info]) => ({
          chatId,
          label: info.name?.trim() || chatId,
          isGroup: info.isGroup
        }))
        .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hant')),
    [t.chatMap]
  )

  const visibleTodos = useMemo(() => {
    return t.todos.filter((todo) => {
      const chatInfo = t.chatMap[todo.chatId]
      if (chatKindFilter === 'group' && !chatInfo?.isGroup) return false
      if (chatKindFilter === 'direct' && chatInfo?.isGroup) return false

      // 「本機檢視」篩選只對已完成欄有意義（其餘三欄無 viewed pill、無法標記）。
      if (columnOf(todo) === 'done') {
        const viewed = viewedLocalIds.has(todo.id)
        if (localViewedFilter === 'viewed') return viewed
        if (localViewedFilter === 'unviewed') return !viewed
      }
      return true
    })
  }, [chatKindFilter, localViewedFilter, t.chatMap, t.todos, viewedLocalIds])

  // 依欄位分組（done 一欄；其餘依 bucket）。
  const grouped = useMemo(() => {
    const g: Record<ColumnId, TodoDTO[]> = {
      todo: [],
      waiting: [],
      schedule: [],
      done: []
    }
    for (const todo of visibleTodos) g[columnOf(todo)].push(todo)
    return g
  }, [visibleTodos])

  const requestBulkMove = useCallback((from: ColumnId, to: ColumnId): void => {
    const ids = grouped[from].map((todo) => todo.id)
    if (ids.length > 0) setPendingMove({ from, to, ids })
  }, [grouped])

  const confirmBulkMove = async (): Promise<void> => {
    if (!pendingMove || bulkMoving) return
    const { to, ids } = pendingMove
    setBulkMoving(true)
    try {
      const byId = new Map(t.todos.map((x) => [x.id, x]))
      const items = ids.flatMap((id) => byId.get(id) ?? [])
      const { failed } = await t.moveManyToColumn(items, to)
      setBoardNote(failed > 0 ? `${failed} 張沒移成功` : null)
    } catch (error) {
      setBoardNote(backendErrorText(error, '搬移失敗'))
    } finally {
      setBulkMoving(false)
      setPendingMove(null)
    }
  }

  const setViewedLocal = useCallback((id: string, viewed: boolean): void => {
    setViewedLocalIds((current) => {
      const next = new Set(current)
      if (viewed) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const openChat = useCallback(async (chatId: string): Promise<{ ok: boolean; error?: string }> => {
    let res: { ok: boolean; error?: string }
    try {
      res = await api.db.chats.openOriginal(chatId)
    } catch (error) {
      res = { ok: false, error: backendErrorText(error) }
    }
    if (!res.ok) {
      // LINE Desktop 無精準 deep-link；失敗只記錄，不打斷使用者。
      console.warn('[board] 開原聊天失敗：', res.error)
    }
    return res
  }, [api])

  const actions: TodoCardActions = useMemo(() => ({
    onComplete: t.complete,
    completion: t.completion,
    onRefresh: t.refresh,
    onConfirmDone: t.confirmDone,
    onRejectSuggested: t.rejectSuggested,
    onIgnore: t.ignore,
    onMarkNotMine: async (todo) => {
      const result = await api.db.todos.markNotMine(todo.id, 'unclear_context')
      if (!result.ok) throw new Error(result.error ?? '標記失敗')
      if (!await t.refresh()) throw new Error('標記已寫入，但看板更新失敗')
      return result
    },
    onIgnoreByKeyword: t.ignoreByKeyword,
    onSnooze: t.snooze,
    onReopen: t.rejectSuggested,
    onOpenChat: openChat,
    onDraftReply: (todo) => setDraftTodoId(todo.id),
    onEdit: t.update,
    onSetViewedLocal: setViewedLocal
  }), [api, openChat, setDraftTodoId, setViewedLocal, t.complete, t.completion, t.confirmDone, t.ignore, t.ignoreByKeyword, t.moveToColumn, t.refresh, t.rejectSuggested, t.snooze, t.update])

  return (
    <div className="board-wrap">
      {t.error && (
        <div className="set-notice err" role="alert" data-testid="board-error">
          <div className="set-notice-body">
            <div className="set-notice-title">{t.error}</div>
            <div className="set-notice-acts">
              <button type="button" onClick={() => void t.retry()}>重試</button>
            </div>
          </div>
        </div>
      )}
      {boardNote && <div className="set-notice err" role="alert">{boardNote}</div>}

      <div className="board-filters" aria-label="看板排序與篩選">
        <label className="filter-field">
          <span>排序</span>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as TodoSortBy)}>
            <option value="updatedAt">更新時間</option>
            <option value="createdAt">建立時間</option>
            <option value="dueAt">到期時間</option>
            <option value="priority">優先度</option>
          </select>
        </label>
        <label className="filter-field">
          <span>方向</span>
          <select
            value={sortDirection}
            onChange={(e) => setSortDirection(e.target.value as TodoSortDirection)}
          >
            <option value="desc">由新到舊 / 高到低</option>
            <option value="asc">由舊到新 / 低到高</option>
          </select>
        </label>
        <label className="filter-field filter-chat">
          <span>對話</span>
          <select value={chatFilter} onChange={(e) => setChatFilter(e.target.value)}>
            <option value="">全部對話</option>
            {chatOptions.map((chat) => (
              <option key={chat.chatId} value={chat.chatId}>
                {chat.isGroup ? '群組：' : '1:1：'}
                {chat.label}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          <span>類型</span>
          <select
            value={chatKindFilter}
            onChange={(e) => setChatKindFilter(e.target.value as ChatKindFilter)}
          >
            <option value="all">全部</option>
            <option value="group">只看群組</option>
            <option value="direct">只看 1:1</option>
          </select>
        </label>
        <label className="filter-field">
          <span>本機檢視</span>
          <select
            value={localViewedFilter}
            onChange={(e) => setLocalViewedFilter(e.target.value as LocalViewedFilter)}
          >
            <option value="all">全部</option>
            <option value="unviewed">未讀</option>
            <option value="viewed">已讀</option>
          </select>
        </label>
        <label className="filter-toggle">
          <input
            type="checkbox"
            checked={groupByChat}
            onChange={(e) => setGroupByChat(e.target.checked)}
          />
          <span>同一對話 grouping</span>
        </label>
      </div>

      <div className="kb-board">
        {COLUMNS.map((def) => (
          <Column
            key={def.id}
            def={def}
            todos={grouped[def.id]}
            chatMap={t.chatMap}
            actions={actions}
            groupByChat={groupByChat}
            viewedLocalIds={viewedLocalIds}
            dnd={dnd}
            onBulkMove={requestBulkMove}
          />
        ))}
      </div>

      {pendingMove && (
        <div className="modal-backdrop" onClick={() => { if (!bulkMoving) setPendingMove(null) }}>
          <div
            className="modal bulk-move-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-label="全部移動"
            data-testid="bulk-move-confirm"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && !bulkMoving) setPendingMove(null)
            }}
          >
            <div>{`要把 ${pendingMove.ids.length} 張移到${COLUMNS.find((c) => c.id === pendingMove.to)?.title ?? ''}嗎？`}</div>
            <div className="modal-actions">
              <button type="button" data-testid="bulk-move-ok" disabled={bulkMoving} onClick={() => void confirmBulkMove()}>確定</button>
              <button type="button" data-testid="bulk-move-cancel" autoFocus disabled={bulkMoving} onClick={() => setPendingMove(null)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {draftTodo && (
        <DraftReplyDialog
          todo={draftTodo}
          chatName={t.chatMap[draftTodo.chatId]?.name ?? null}
          onClose={() => setDraftTodoId(null)}
        />
      )}
    </div>
  )
}
