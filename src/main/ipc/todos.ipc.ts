import { ipcMain } from 'electron'
import {
  listTodos,
  getTodo,
  updateStatus,
  updateTodo,
  getOpenTodosByChat,
  moveTodoToColumn,
  type TodoColumn,
  type ListTodosQuery,
  type UpdateTodoPatch
} from '../db/todos.repo'
import type { TodoDTO } from '../db/dto'

const VALID_BUCKETS = new Set<TodoDTO['bucket']>(['todo', 'waiting', 'schedule'])

/**
 * 看板拖曳搬移的合法目標欄。注意：與 VALID_BUCKETS 不同，這裡**含 `done`**
 * （拖到 done 欄＝標記完成），故不可重用 VALID_BUCKETS。
 */
const VALID_COLUMNS = new Set<TodoColumn>(['todo', 'waiting', 'schedule', 'done'])

/**
 * F9：todos:update 的 IPC 入參防呆（信任邊界）。
 *
 * DB CHECK 只擋 bucket/status，priority 連 CHECK 都沒有；任何繞過正規 UI 直呼
 * window.api.db.todos.update 的路徑都可能寫入非法值（如 priority=0/99/1.5、空 title、
 * 壞 dueAt）污染排序與顯示。這裡在進 repo 前逐欄驗證「有給的」欄位，任一非法 → 回 null
 * （與本檔既有「驗證失敗回 null」一致）。只回傳通過驗證的欄位，未給的維持不動。
 */
function sanitizeUpdatePatch(raw: unknown): UpdateTodoPatch | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const out: UpdateTodoPatch = {}

  if (p.title !== undefined) {
    if (typeof p.title !== 'string' || p.title.trim() === '') return null
    out.title = p.title.trim()
  }
  if (p.detail !== undefined) {
    if (p.detail !== null && typeof p.detail !== 'string') return null
    out.detail = p.detail
  }
  if (p.priority !== undefined) {
    if (p.priority !== 1 && p.priority !== 2 && p.priority !== 3) return null
    out.priority = p.priority
  }
  if (p.dueAt !== undefined) {
    if (p.dueAt === null) {
      out.dueAt = null
    } else if (typeof p.dueAt === 'string' && !Number.isNaN(Date.parse(p.dueAt))) {
      out.dueAt = p.dueAt
    } else {
      return null
    }
  }
  if (p.bucket !== undefined) {
    if (typeof p.bucket !== 'string' || !VALID_BUCKETS.has(p.bucket as TodoDTO['bucket'])) {
      return null
    }
    out.bucket = p.bucket as TodoDTO['bucket']
  }
  if (p.sourceMsgIds !== undefined) {
    if (!Array.isArray(p.sourceMsgIds) || !p.sourceMsgIds.every((s) => typeof s === 'string')) {
      return null
    }
    out.sourceMsgIds = p.sourceMsgIds as string[]
  }
  return out
}

/**
 * todos:* IPC handler。本輪（DB 持久化）提供看板讀取與基本狀態轉移；
 * LLM 抽取產生 todo、draftReply 等在 M2/M3 補上。
 */
export function registerTodosIpc(): void {
  ipcMain.handle('todos:list', (_e, query: ListTodosQuery = {}): TodoDTO[] =>
    listTodos(query)
  )

  ipcMain.handle('todos:get', (_e, args: { id: string }): TodoDTO | null => {
    if (!args || typeof args.id !== 'string') return null
    return getTodo(args.id)
  })

  ipcMain.handle(
    'todos:openByChat',
    (_e, args: { chatId: string }): TodoDTO[] => {
      if (!args || typeof args.chatId !== 'string') return []
      return getOpenTodosByChat(args.chatId)
    }
  )

  ipcMain.handle(
    'todos:updateStatus',
    (_e, args: { id: string; status: TodoDTO['status'] }): TodoDTO | null => {
      if (!args || typeof args.id !== 'string') return null
      return updateStatus(args.id, args.status)
    }
  )

  ipcMain.handle(
    'todos:update',
    (_e, args: { id: string; patch: UpdateTodoPatch }): TodoDTO | null => {
      if (!args || typeof args.id !== 'string' || !args.patch) return null
      const patch = sanitizeUpdatePatch(args.patch)
      if (patch === null) return null
      return updateTodo(args.id, patch)
    }
  )

  ipcMain.handle(
    'todos:moveColumn',
    (_e, args: { id: string; toColumn: TodoColumn }): TodoDTO | null => {
      if (!args || typeof args.id !== 'string') return null
      if (
        typeof args.toColumn !== 'string' ||
        !VALID_COLUMNS.has(args.toColumn as TodoColumn)
      ) {
        return null
      }
      return moveTodoToColumn(args.id, args.toColumn)
    }
  )
}
