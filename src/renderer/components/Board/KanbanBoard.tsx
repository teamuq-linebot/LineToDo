import { useEffect, useMemo, useState } from 'react'
import type {
  TodoDTO,
  BackfillProgress,
  TodoSortBy,
  TodoSortDirection
} from '../../types/api'
import { COLUMNS, columnOf, type ColumnId } from './buckets'
import { Column } from './Column'
import { useTodos } from '../../store/useTodos'
import { TodaySummary } from '../TodaySummary'
import { DraftReplyDialog } from '../DraftReplyDialog'
import type { TodoCardActions } from './TodoCard'

/**
 * KanbanBoard — 四欄看板容器（IMPLEMENTATION_PLAN.md M3）。
 *
 * 上方「今日摘要」面板 + 「回顧最近 2 天」按鈕；下方四欄（待辦 / 等回覆 / 行程 / 已完成）。
 * 資料與動作來自 useTodos；草擬回覆以 DraftReplyDialog modal 呈現。
 */

const REVIEW_DAYS = 2

type ChatKindFilter = 'all' | 'group' | 'direct'
type LocalViewedFilter = 'all' | 'unviewed' | 'viewed'

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

export function KanbanBoard(): JSX.Element {
  const [sortBy, setSortBy] = useState<TodoSortBy>('updatedAt')
  const [sortDirection, setSortDirection] = useState<TodoSortDirection>('desc')
  const [chatFilter, setChatFilter] = useState('')
  const [chatKindFilter, setChatKindFilter] = useState<ChatKindFilter>('all')
  const [groupByChat, setGroupByChat] = useState(false)
  const [localViewedFilter, setLocalViewedFilter] = useState<LocalViewedFilter>('all')
  const [viewedLocalIds, setViewedLocalIds] = useState<Set<string>>(() => new Set())
  const t = useTodos({
    sortBy,
    sortDirection,
    chatId: chatFilter || undefined
  })
  const [draftTodo, setDraftTodo] = useState<TodoDTO | null>(null)

  // 看板拖曳搬移狀態（§3.2）：拖曳中卡片 id、目前 dragover 的目標欄。
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverCol, setDragOverCol] = useState<ColumnId | null>(null)

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
        if (todo) void t.moveToColumn(todo, col)
        setDraggingId(null)
        setDragOverCol(null)
      }
    }),
    [draggingId, dragOverCol, t.todos, t.moveToColumn]
  )

  // 「回顧最近 2 天」狀態。
  const [reviewing, setReviewing] = useState(false)
  const [progress, setProgress] = useState<BackfillProgress | null>(null)
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null)
  const [reviewNote, setReviewNote] = useState<string | null>(null)

  // 「補媒體金鑰（近 7 天）」狀態（輕量 backfill：不跑 LLM、不需金鑰）。
  const [backfilling, setBackfilling] = useState(false)
  const [backfillNote, setBackfillNote] = useState<string | null>(null)

  // 初次掛載：查 pipeline 狀態取得 hasApiKey（決定按鈕是否提示填金鑰）。
  useEffect(() => {
    let alive = true
    void window.api.pipeline
      .status()
      .then((s) => {
        if (alive) setHasApiKey(s.hasApiKey)
      })
      .catch(() => {
        if (alive) setHasApiKey(null)
      })
    // 訂閱 backfill 進度推播。
    const off = window.api.pipeline.onBackfillProgress((p) => {
      setProgress(p)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  async function onReviewRecentDays(): Promise<void> {
    if (reviewing) return
    setReviewing(true)
    setReviewNote(null)
    setProgress({ processed: 0, total: 0, phase: 'fetching' })
    try {
      const res = await window.api.pipeline.reviewLastDays(REVIEW_DAYS)
      setHasApiKey(res.hasApiKey)
      if (!res.ok && !res.hasApiKey) {
        setReviewNote('請先到設定頁填金鑰')
      } else if (!res.ok) {
        setReviewNote(res.note ?? '回顧失敗')
      } else {
        setReviewNote(
          `完成：新增 ${res.todosCreated}、合併 ${res.todosMerged}、` +
            `完成 ${res.todosResolvedDone}（處理 ${res.chatsProcessed}/${res.chatsSeen} 聊天）`
        )
      }
      await t.refresh()
    } catch (err) {
      setReviewNote(`回顧失敗：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setReviewing(false)
      setProgress(null)
    }
  }

  async function onBackfillMediaKeys(): Promise<void> {
    if (backfilling) return
    setBackfilling(true)
    setBackfillNote(null)
    try {
      const res = await window.api.pipeline.backfillMediaKeys(7)
      if (res.ok) {
        setBackfillNote(
          `已補 ${res.mediaBackfilled ?? 0} 筆媒體金鑰（掃描 ${res.scanned ?? 0} 則）；` +
            '可重開來源訊息彈窗查看歷史媒體。'
        )
      } else {
        setBackfillNote(`補金鑰失敗：${res.error ?? '未知錯誤'}`)
      }
    } catch (err) {
      setBackfillNote(`補金鑰失敗：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBackfilling(false)
    }
  }

  const reviewLabel = reviewing
    ? progress && progress.phase === 'extracting' && progress.total > 0
      ? `處理中 ${progress.processed}/${progress.total} 聊天…`
      : progress?.phase === 'fetching'
        ? '撈取訊息中…'
        : '回顧中…'
    : `🔄 回顧最近 ${REVIEW_DAYS} 天`

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

  function setViewedLocal(id: string, viewed: boolean): void {
    setViewedLocalIds((current) => {
      const next = new Set(current)
      if (viewed) next.add(id)
      else next.delete(id)
      return next
    })
  }

  async function openChat(chatId: string): Promise<void> {
    const res = await window.api.db.chats.openOriginal(chatId)
    if (!res.ok) {
      // LINE Desktop 無精準 deep-link；失敗只記錄，不打斷使用者。
      console.warn('[board] 開原聊天失敗：', res.error)
    }
  }

  const actions: TodoCardActions = {
    onComplete: (id) => void t.complete(id),
    onConfirmDone: (id) => void t.confirmDone(id),
    onRejectSuggested: (todo) => void t.rejectSuggested(todo),
    onIgnore: (id) => void t.ignore(id),
    onIgnoreByKeyword: (chatId, keyword) => void t.ignoreByKeyword(chatId, keyword),
    onBlockChat: (chatId) => void t.blockChat(chatId),
    onSnooze: (todo, hours) => void t.snooze(todo, hours),
    onReopen: (todo) => void t.rejectSuggested(todo),
    onOpenChat: (chatId) => void openChat(chatId),
    onDraftReply: (todo) => setDraftTodo(todo),
    onEdit: (id, patch) => void t.update(id, patch),
    onSetViewedLocal: setViewedLocal
  }

  return (
    <div className="board-wrap">
      <div className="board-toolbar">
        <button
          className="btn-review-week"
          disabled={reviewing}
          onClick={() => void onReviewRecentDays()}
          title={
            hasApiKey === false
              ? '請先到設定頁填金鑰'
              : `用 AI 判斷最近 ${REVIEW_DAYS} 天訊息、補建代辦`
          }
        >
          {reviewLabel}
        </button>
        {hasApiKey === false && !reviewing && (
          <span className="review-hint">請先到設定頁填金鑰</span>
        )}
        {reviewNote && <span className="review-note">{reviewNote}</span>}
        <button
          className="btn-review-week"
          disabled={backfilling}
          onClick={() => void onBackfillMediaKeys()}
          title="重讀近 7 天訊息、補既有媒體卡片的金鑰（不需金鑰、不跑 AI）"
        >
          {backfilling ? '補金鑰中…' : '🖼️ 補媒體金鑰(近7天)'}
        </button>
        {backfillNote && <span className="review-note">{backfillNote}</span>}
      </div>

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

      <TodaySummary todos={visibleTodos} loading={t.loading} onRefresh={() => void t.refresh()} />

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
          />
        ))}
      </div>

      {draftTodo && (
        <DraftReplyDialog
          todo={draftTodo}
          chatName={t.chatMap[draftTodo.chatId]?.name ?? null}
          onClose={() => setDraftTodo(null)}
        />
      )}
    </div>
  )
}
