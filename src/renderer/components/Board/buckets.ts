import type { TodoDTO } from '../../types/api'

/**
 * buckets.ts — 看板「欄位」定義與 todo → 欄位的路由（IMPLEMENTATION_PLAN.md §4 / M3）。
 *
 * 四欄看板：待辦 / 等回覆 / 行程 / 已完成。
 *   - 前三欄依 bucket（todo / waiting / schedule）落位，顯示「進行中」的 todo。
 *   - suggested_done（建議完成、待確認）也落在「原 bucket」對應的欄位，但用特殊樣式標示。
 *   - 「已完成」欄只收 status='done'（不論原 bucket）。
 *   - dismissed 不顯示在看板（已忽略）。
 */

export type ColumnId = 'todo' | 'waiting' | 'schedule' | 'done'

export interface ColumnDef {
  id: ColumnId
  title: string
  /** 欄位左側強調色（CSS 變數名）。 */
  accentVar: string
  /** 空欄提示。 */
  emptyHint: string
}

export const COLUMNS: ColumnDef[] = [
  { id: 'todo', title: '待辦', accentVar: '--col-todo', emptyHint: '目前沒有待辦事項' },
  { id: 'waiting', title: '等回覆', accentVar: '--col-waiting', emptyHint: '沒有在等的回覆' },
  { id: 'schedule', title: '行程', accentVar: '--col-schedule', emptyHint: '沒有排定的行程' },
  { id: 'done', title: '已完成', accentVar: '--col-done', emptyHint: '尚無已完成項目' }
]

/** 看板要拉哪些 status（排除 dismissed）。 */
export const BOARD_STATUSES: TodoDTO['status'][] = [
  'pending',
  'waiting_reply',
  'scheduled',
  'suggested_done',
  'done'
]

/** 該 todo 落在哪一欄。done → 已完成欄；其餘依 bucket。 */
export function columnOf(todo: TodoDTO): ColumnId {
  if (todo.status === 'done') return 'done'
  switch (todo.bucket) {
    case 'waiting':
      return 'waiting'
    case 'schedule':
      return 'schedule'
    case 'todo':
    default:
      return 'todo'
  }
}

/** 是否為「建議完成、待使用者確認」。 */
export function isSuggestedDone(todo: TodoDTO): boolean {
  return todo.status === 'suggested_done'
}

/** 優先級顯示。 */
export function priorityLabel(p: number): { text: string; cls: string } {
  switch (p) {
    case 1:
      return { text: '高', cls: 'prio-high' }
    case 3:
      return { text: '低', cls: 'prio-low' }
    case 2:
    default:
      return { text: '中', cls: 'prio-mid' }
  }
}

/** 把 ISO 字串（可能含/不含 tz）轉成精簡顯示。null → ''。 */
export function fmtDue(due: string | null): string {
  if (!due) return ''
  // 後端多為本地秒精度、無 tz；直接切字串比 new Date 更不會被時區搬移。
  const m = due.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/)
  if (m) {
    const [, , mo, d, hh, mm] = m
    return `${mo}/${d} ${hh}:${mm}`
  }
  // 只有日期
  const dOnly = due.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (dOnly) return `${dOnly[2]}/${dOnly[3]}`
  return due
}

/** 判斷 dueAt 是否已過期（給遲到樣式）。解析不出來就當未過期。 */
export function isOverdue(due: string | null): boolean {
  if (!due) return false
  const t = Date.parse(due)
  if (Number.isNaN(t)) return false
  return t < Date.now()
}
