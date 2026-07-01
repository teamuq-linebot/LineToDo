import { useCallback, useEffect, useState } from 'react'
import type {
  TodoDTO,
  ChatDTO,
  TodoSortBy,
  TodoSortDirection
} from '../types/api'
import { BOARD_STATUSES, type ColumnId } from '../components/Board/buckets'

/**
 * useTodos — 看板資料來源。
 *
 * 職責：
 *   - 載入看板要顯示的 todos（BOARD_STATUSES，排除 dismissed）。
 *   - 載入 chats 對照表（chatId → 顯示名稱）。
 *   - 訂閱 pipeline 推播（onRun / onTodosChanged / onMessagesPersisted）自動刷新。
 *   - 提供動作：完成 / 確認建議完成 / 退回 / 延後 / 忽略 / 改 bucket。
 *
 * 所有 I/O 走 window.api（preload contextBridge），renderer 不直接碰 ipcRenderer。
 */

export interface ChatNameMap {
  [chatId: string]: { name: string | null; isGroup: boolean }
}

/** 手動編輯可改的欄位（對齊 window.api.db.todos.update 的 patch 形態）。 */
export interface TodoUpdatePatch {
  title?: string
  detail?: string | null
  priority?: number
  dueAt?: string | null
  bucket?: TodoDTO['bucket']
}

export interface TodoListOptions {
  sortBy?: TodoSortBy
  sortDirection?: TodoSortDirection
  chatId?: string
}

export interface UseTodos {
  todos: TodoDTO[]
  chatMap: ChatNameMap
  loading: boolean
  /** 重新拉一次（手動刷新）。 */
  refresh: () => Promise<void>
  /** 標完成（done）。 */
  complete: (id: string) => Promise<void>
  /** 確認「建議完成」→ done。 */
  confirmDone: (id: string) => Promise<void>
  /** 「還沒」：suggested_done 退回原 bucket 對應的 active 狀態。 */
  rejectSuggested: (todo: TodoDTO) => Promise<void>
  /** 忽略這一筆（dismissed）。 */
  ignore: (id: string) => Promise<void>
  /** 依關鍵字忽略（此對話）：加關鍵字 + 立即忽略命中的未完成代辦。回 dismissed 筆數。 */
  ignoreByKeyword: (chatId: string, keyword: string) => Promise<number>
  /** 封鎖這個對話：不再抽代辦 + 清掉該對話現有未完成代辦。回 dismissed 筆數。 */
  blockChat: (chatId: string) => Promise<number>
  /** 延後：把 dueAt 往後推 N 小時（無 dueAt 則設為 now+N）。 */
  snooze: (todo: TodoDTO, hours: number) => Promise<void>
  /** 手動編輯欄位（標題/備註/bucket/優先級/到期）。 */
  update: (id: string, patch: TodoUpdatePatch) => Promise<void>
  /** 看板拖曳搬移到目標欄（含同欄 no-op 防抖）。 */
  moveToColumn: (todo: TodoDTO, toColumn: ColumnId) => Promise<void>
}

/** bucket → 對應的 active 狀態（suggested_done 退回時用）。 */
function activeStatusForBucket(bucket: TodoDTO['bucket']): TodoDTO['status'] {
  switch (bucket) {
    case 'waiting':
      return 'waiting_reply'
    case 'schedule':
      return 'scheduled'
    case 'todo':
    default:
      return 'pending'
  }
}

/** 前端 no-op 防呆（鏡像 repo guard）：目標三元組已等於現值 → 不打 IPC、不 refresh。 */
function isNoopMove(todo: TodoDTO, toColumn: ColumnId): boolean {
  if (toColumn === 'done') return todo.status === 'done'
  // 早退已排除 'done'，toColumn 在此窄化為 TodoDTO['bucket']。
  return (
    todo.bucket === toColumn &&
    todo.status === activeStatusForBucket(toColumn) &&
    todo.resolvedAt === null
  )
}

export function useTodos(options: TodoListOptions = {}): UseTodos {
  const [todos, setTodos] = useState<TodoDTO[]>([])
  const [chatMap, setChatMap] = useState<ChatNameMap>({})
  const [loading, setLoading] = useState(true)
  const sortBy = options.sortBy
  const sortDirection = options.sortDirection
  const chatId = options.chatId

  const loadChats = useCallback(async (): Promise<void> => {
    try {
      // 含黑名單一起拉，確保黑名單 chat 產生的歷史 todo 也能顯示正確名稱。
      const chats: ChatDTO[] = await window.api.db.chats.list(true)
      const map: ChatNameMap = {}
      for (const c of chats) map[c.chatId] = { name: c.name, isGroup: c.isGroup }
      setChatMap(map)
    } catch (err) {
      console.error('[useTodos] loadChats 失敗：', err)
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await window.api.db.todos.list({
        statuses: BOARD_STATUSES,
        sortBy,
        sortDirection,
        chatId
      })
      setTodos(list)
    } catch (err) {
      console.error('[useTodos] refresh 失敗：', err)
    } finally {
      setLoading(false)
    }
  }, [chatId, sortBy, sortDirection])

  useEffect(() => {
    void loadChats()
    void refresh()

    // 推播自動刷新：每輪結束、todos 異動、有新訊息落庫（名稱可能更新）皆重拉。
    const offRun = window.api.pipeline.onRun(() => {
      void refresh()
    })
    const offTodos = window.api.pipeline.onTodosChanged(() => {
      void refresh()
    })
    const offPersisted = window.api.db.onMessagesPersisted(() => {
      void loadChats()
    })

    return () => {
      offRun()
      offTodos()
      offPersisted()
    }
  }, [loadChats, refresh])

  const complete = useCallback(
    async (id: string): Promise<void> => {
      await window.api.db.todos.updateStatus(id, 'done')
      await refresh()
    },
    [refresh]
  )

  const confirmDone = useCallback(
    async (id: string): Promise<void> => {
      await window.api.db.todos.updateStatus(id, 'done')
      await refresh()
    },
    [refresh]
  )

  const rejectSuggested = useCallback(
    async (todo: TodoDTO): Promise<void> => {
      await window.api.db.todos.updateStatus(todo.id, activeStatusForBucket(todo.bucket))
      await refresh()
    },
    [refresh]
  )

  const ignore = useCallback(
    async (id: string): Promise<void> => {
      await window.api.db.todos.updateStatus(id, 'dismissed')
      await refresh()
    },
    [refresh]
  )

  const ignoreByKeyword = useCallback(
    async (chatId: string, keyword: string): Promise<number> => {
      const res = await window.api.db.chats.addIgnoreKeyword(chatId, keyword)
      await refresh()
      return res.dismissed
    },
    [refresh]
  )

  const blockChat = useCallback(
    async (chatId: string): Promise<number> => {
      const res = await window.api.db.chats.blockAndClear(chatId)
      await refresh()
      return res.dismissed
    },
    [refresh]
  )

  const snooze = useCallback(
    async (todo: TodoDTO, hours: number): Promise<void> => {
      const base = todo.dueAt ? Date.parse(todo.dueAt) : Date.now()
      const from = Number.isNaN(base) ? Date.now() : base
      const next = new Date(from + hours * 3600 * 1000)
      // 存本地秒精度、無 tz（與後端 time_iso 風格一致）。
      const iso = toLocalIso(next)
      await window.api.db.todos.update(todo.id, { dueAt: iso })
      await refresh()
    },
    [refresh]
  )

  const update = useCallback(
    async (id: string, patch: TodoUpdatePatch): Promise<void> => {
      await window.api.db.todos.update(id, patch)
      await refresh()
    },
    [refresh]
  )

  const moveToColumn = useCallback(
    async (todo: TodoDTO, toColumn: ColumnId): Promise<void> => {
      if (isNoopMove(todo, toColumn)) return
      await window.api.db.todos.moveColumn(todo.id, toColumn)
      await refresh()
    },
    [refresh]
  )

  return {
    todos,
    chatMap,
    loading,
    refresh,
    complete,
    confirmDone,
    rejectSuggested,
    ignore,
    ignoreByKeyword,
    blockChat,
    snooze,
    update,
    moveToColumn
  }
}

/** Date → 本地秒精度 ISO（無 tz 後綴），對齊後端 time_iso 風格。 */
function toLocalIso(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}
