import { useLineTodoApi } from '../../platform/LineTodoApi'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AiProviderId,
  BackfillProgress,
  TodoDTO,
  TodoSortBy,
  TodoSortDirection
} from '../../types/api'
import { notReadyShortText } from '../../lib/aiProvider'
import { COLUMNS, columnOf, type ColumnId } from './buckets'
import { Column } from './Column'
import { createProgressFrameCoalescer } from './progressFrame'
import { useTodos } from '../../store/useTodos'
import { TodaySummary } from '../TodaySummary'
import { DraftReplyDialog } from '../DraftReplyDialog'
import type { TodoCardActions } from './TodoCard'
import { NotMineReviewPanel } from './NotMineReviewPanel'
import { backendErrorText } from '../../lib/backendError'
import { LONG_TASK_STATUS_UNKNOWN_TEXT, explainInterrupted, longTaskNotes, longTaskPollDelayMs, readLongTasks } from '../../lib/longTasks'
import type { LongTaskStatusView } from '../../../shared/api'
import {
  parseBoolean, parseOneOf, parseShortString, parseStringSet, serializeStringSet, usePersistentState
} from '../../lib/uiState'

/**
 * KanbanBoard — 四欄看板容器（IMPLEMENTATION_PLAN.md M3）。
 *
 * 上方「今日摘要」面板 + 「回顧最近 2 天」按鈕；下方四欄（待辦 / 等回覆 / 行程 / 已完成）。
 * 資料與動作來自 useTodos；草擬回覆以 DraftReplyDialog modal 呈現。
 *
 * 外掛開發者指南對應：
 *   - G-02：讀取失敗（useTodos.error）顯示原因與「重試」；拖曳搬移、開原聊天失敗也顯示，不會安靜變成空白看板。
 *   - G-04：排序、篩選、分組、本機「已讀」標記與開著的草擬回覆對話框存進 UI 狀態（lib/uiState.ts），view 重新建立後還原（standalone 不保存）。
 *   - G-05：回顧與補媒體金鑰的狀態向 backend 查詢（lib/longTasks.ts），不只靠按鈕的 Promise：重新開啟畫面時看得到進行中的進度與上次沒做完的原因。
 */

const REVIEW_DAYS = 2

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

export function KanbanBoard(): JSX.Element {
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
  // 開著的草擬回覆對話框記 todo id（重新開啟畫面後，待辦載入完就回到同一個對話框；草稿內容由對話框自己保存）。
  const [draftTodoId, setDraftTodoId] = usePersistentState<string | null>('board.draftTodoId', null, parseDraftTodoId)
  const draftTodo = useMemo(() => (draftTodoId ? t.todos.find((x) => x.id === draftTodoId) ?? null : null), [draftTodoId, t.todos])
  const [showNotMine,setShowNotMine]=useState(false)
  /** 看板層級的動作失敗（拖曳搬移等）。 */
  const [boardNote, setBoardNote] = useState<string | null>(null)

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

  // 「回顧最近 2 天」狀態。
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
    onBlockChat: t.blockChat,
    onSnooze: t.snooze,
    onReopen: t.rejectSuggested,
    onOpenChat: openChat,
    onDraftReply: (todo) => setDraftTodoId(todo.id),
    onEdit: t.update,
    onSetViewedLocal: setViewedLocal
  }), [api, openChat, setDraftTodoId, setViewedLocal, t.blockChat, t.complete, t.completion, t.confirmDone, t.ignore, t.ignoreByKeyword, t.moveToColumn, t.refresh, t.rejectSuggested, t.snooze, t.update])

  return (
    <div className="board-wrap">
      <ReviewControls api={api} onRefresh={t.refresh} onShowNotMine={() => setShowNotMine((v) => !v)} />

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

      {showNotMine&&<NotMineReviewPanel api={api} onClose={()=>setShowNotMine(false)} onChanged={()=>void t.refresh()}/>}

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
          onClose={() => setDraftTodoId(null)}
        />
      )}
    </div>
  )
}

/** 看板工具列：回顧最近 N 天、補媒體金鑰、長任務狀態（G-05／review N2）。`pollDelayMs`：測試用（預設 `longTaskPollDelayMs`）。 */
export function ReviewControls({
  api,
  onRefresh,
  onShowNotMine,
  pollDelayMs = longTaskPollDelayMs
}: {
  api: ReturnType<typeof useLineTodoApi>
  onRefresh: () => Promise<boolean>
  onShowNotMine: () => void
  pollDelayMs?: (failures: number) => number
}): JSX.Element {
  const [reviewing, setReviewing] = useState(false)
  const [progress, setProgress] = useState<BackfillProgress | null>(null)
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null)
  const [aiProvider, setAiProvider] = useState<AiProviderId>('http')
  const [reviewNote, setReviewNote] = useState<string | null>(null)
  const [backfilling, setBackfilling] = useState(false)
  const [backfillNote, setBackfillNote] = useState<string | null>(null)
  /** backend 回報的長任務狀態（外掛版；standalone 為 null）。 */
  const [tasks, setTasks] = useState<LongTaskStatusView | null>(null)
  /** 長任務狀態連續查詢失敗的次數（review N2）：> 0 時 `tasks` 是舊的，按鈕不再因它停用，查詢以退避繼續。 */
  const [pollFailures, setPollFailures] = useState(0)
  const notes = longTaskNotes(tasks)
  const statusUnknown = pollFailures > 0
  /** 回顧／補金鑰在 backend 跑、但不是這個畫面按下去的（畫面重新開啟、或等待中的呼叫斷掉之後）。 */
  const remoteRunning = (notes.reviewRunning && !reviewing) || (notes.backfillRunning && !backfilling)

  // G-05：開啟畫面時查一次；backend 還在跑就每 3 秒再查，跑完重讀看板並顯示結果。
  useEffect(() => {
    if (!api.pipeline.longTaskStatus) return undefined
    let alive = true
    void readLongTasks(api).then((view) => {
      if (!alive || !view) return
      setTasks(view)
      const first = longTaskNotes(view)
      if (!first.reviewRunning && first.reviewText) setReviewNote(first.reviewText)
      if (!first.backfillRunning && first.backfillText) setBackfillNote(first.backfillText)
    })
    return () => { alive = false }
  }, [api])

  // 查詢失敗（review N2）：不停止，以退避再查（失敗次數變了，effect 會重排下一次）；在查到之前按鈕不因舊狀態停用。
  useEffect(() => {
    if (!remoteRunning || !api.pipeline.longTaskStatus) return undefined
    let alive = true
    const timer = setTimeout(() => {
      void readLongTasks(api).then((view) => {
        if (!alive) return
        if (!view) { setPollFailures((n) => n + 1); return }
        setPollFailures(0)
        const before = longTaskNotes(tasks)
        const after = longTaskNotes(view)
        setTasks(view)
        if (before.reviewRunning && !after.reviewRunning) { setReviewNote(view.review?.summary ?? null); void onRefresh() }
        if (before.backfillRunning && !after.backfillRunning) setBackfillNote(view.mediaBackfill?.summary ?? null)
      })
    }, pollDelayMs(pollFailures))
    return () => { alive = false; clearTimeout(timer) }
  }, [api, onRefresh, remoteRunning, tasks, pollFailures, pollDelayMs])

  useEffect(() => {
    let alive = true
    void api.pipeline.status().then((s) => { if (alive) setHasApiKey(s.hasApiKey) }).catch(() => {
      if (alive) setHasApiKey(null)
    })
    void api.settings.get().then((v) => { if (alive) setAiProvider(v.aiProvider) }).catch(() => undefined)
    const coalescer = createProgressFrameCoalescer(
      (callback) => window.requestAnimationFrame(callback),
      (id) => window.cancelAnimationFrame(id),
      (progress) => { if (alive) setProgress(progress) }
    )
    const off = api.pipeline.onBackfillProgress(coalescer.push)
    return () => {
      alive = false
      off()
      coalescer.dispose()
    }
  }, [api])

  async function onReviewRecentDays(): Promise<void> {
    if (reviewing) return
    setReviewing(true)
    setReviewNote(null)
    setProgress({ processed: 0, total: 0, phase: 'fetching' })
    try {
      const res = await api.pipeline.reviewLastDays(REVIEW_DAYS)
      setHasApiKey(res.hasApiKey)
      if (!res.ok && !res.hasApiKey) setReviewNote(notReadyShortText(aiProvider))
      else if (!res.ok) setReviewNote(res.note ?? '回顧失敗')
      else setReviewNote(`完成：新增 ${res.todosCreated}、合併 ${res.todosMerged}、完成 ${res.todosResolvedDone}（處理 ${res.chatsProcessed}/${res.chatsSeen} 聊天）`)
      if (!await onRefresh()) setReviewNote((note) => `${note ?? '回顧完成'}；看板更新失敗`)
    } catch (err) {
      // 等待中的呼叫斷掉（backend 重新啟動 → job_not_found、逾時、權限被撤銷…）不代表回顧結束：一併顯示 backend 回報的目前狀態（G-05）。
      const explained = await explainInterrupted(api, err, '回顧失敗', 'review')
      setReviewNote(explained.text)
      if (explained.view) setTasks(explained.view)
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
      const res = await api.pipeline.backfillMediaKeys(7)
      setBackfillNote(res.ok
        ? `已補 ${res.mediaBackfilled ?? 0} 筆媒體金鑰（掃描 ${res.scanned ?? 0} 則）；可重開來源訊息彈窗查看歷史媒體。`
        : `補金鑰失敗：${res.error ?? '未知錯誤'}`)
    } catch (err) {
      const explained = await explainInterrupted(api, err, '補金鑰失敗', 'mediaBackfill')
      setBackfillNote(explained.text)
      if (explained.view) setTasks(explained.view)
    } finally { setBackfilling(false) }
  }

  const reviewBusy = reviewing || (notes.reviewRunning && !statusUnknown)
  const backfillBusy = backfilling || (notes.backfillRunning && !statusUnknown)
  const reviewLabel = reviewing
    ? progress?.phase === 'extracting' && progress.total > 0
      ? `處理中 ${progress.processed}/${progress.total} 聊天…`
      : progress?.phase === 'fetching' ? '撈取訊息中…' : '回顧中…'
    : notes.reviewRunning && !statusUnknown
      ? (notes.reviewText ?? '回顧中…')
      : `🔄 回顧最近 ${REVIEW_DAYS} 天`

  return (
    <div className="board-toolbar">
      <button className="btn-review-week" onClick={onShowNotMine}>不是我的回查</button>
      <button className="btn-review-week" disabled={reviewBusy} onClick={() => void onReviewRecentDays()}
        title={hasApiKey === false ? notReadyShortText(aiProvider) : `用 AI 判斷最近 ${REVIEW_DAYS} 天訊息、補建代辦`}>
        {reviewLabel}
      </button>
      {hasApiKey === false && !reviewBusy && <span className="review-hint">{notReadyShortText(aiProvider)}</span>}
      {reviewNote && <span className="review-note">{reviewNote}</span>}
      {statusUnknown && remoteRunning && <span className="review-note" data-testid="long-task-status-unknown">{LONG_TASK_STATUS_UNKNOWN_TEXT}</span>}
      <button className="btn-review-week" disabled={backfillBusy} onClick={() => void onBackfillMediaKeys()}
        title="重讀近 7 天訊息、補既有媒體卡片的金鑰（不需金鑰、不跑 AI）">
        {backfillBusy ? '補金鑰中…' : '🖼️ 補媒體金鑰(近7天)'}
      </button>
      {backfillNote && <span className="review-note">{backfillNote}</span>}
    </div>
  )
}
