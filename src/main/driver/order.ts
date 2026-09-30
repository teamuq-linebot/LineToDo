/**
 * order.ts — LINE 聊天列表的排序規則 R*（design-v3 §1.4）。純函式、沒有 I/O。
 *
 *   可顯示集合 = _chat LEFT JOIN _chatOption，排除 _hidden ≠ 0（【推論】）
 *   釘選       = _pinnedTime > 0（【實測】；−1 與 0 都是未釘選）
 *   R*         = [釘選，依 _lastUpdatedTime DESC] ++ [其餘，依 _lastUpdatedTime DESC]
 *   同時間     = LINE 的順序未定義；本檔以 chatId 字典序排出穩定順序，並用 timeTies() 標記，
 *                讓 locate.ts 只接受 T 或 B 路徑（design-v3 §3.2 L6）。
 */

/** LINE `_chat`／`_chatOption` 一列（只含 design-v3 §8.3 的白名單欄位）。 */
export interface OrderRow {
  chatId: string
  lastUpdated: number
  pinned: boolean
  hidden: boolean
  /** 只用 > 0；負值語意不明，視為 0（design-v3 §1.2）。 */
  unread: number
  midType: number
  status: number
  /** 顯示名稱（正規化前）；解析不到為 null。 */
  name: string | null
}

export interface OrderSnapshot {
  rows: OrderRow[]
  /** 自己的 mid（_profile._mid＝Keep筆記）；讀不到為 null。 */
  selfMid: string | null
  /** Date.now()（讀取完成時）。 */
  takenAt: number
  /** max(_lastUpdatedTime)。 */
  newestUpdate: number
  /** 複製＋解密＋查詢的耗時。 */
  readMs: number
}

/** lineOrder 查詢的原始列（design-v3 §8.3 的 SELECT）。 */
export interface RawOrderRow {
  _id: string
  _lastUpdatedTime: number | null
  _unreadCount: number | null
  _status: number | null
  _midType: number | null
  pin: number | null
  hidden: number | null
}

/** 原始列 → OrderRow。釘選＝pinnedTime > 0（−1 不是釘選）；未讀負值視為 0。 */
export function toOrderRow(raw: RawOrderRow, name: string | null): OrderRow {
  const unread = Number(raw._unreadCount ?? 0)
  return {
    chatId: String(raw._id),
    lastUpdated: Number(raw._lastUpdatedTime ?? 0) || 0,
    pinned: Number(raw.pin ?? 0) > 0,
    hidden: Number(raw.hidden ?? 0) !== 0,
    unread: unread > 0 ? unread : 0,
    midType: Number(raw._midType ?? 0) || 0,
    status: Number(raw._status ?? 0) || 0,
    name: name && name.trim() ? name : null
  }
}

/** 自己的聊天室（_chat._id == _profile._mid）在 LINE 上顯示的名稱【實測】。 */
export const SELF_CHAT_NAME = 'Keep筆記'

/**
 * design-v3 §8.3 的名稱解析順序：
 *   ① chatId == selfMid → Keep筆記 ② linedb.chatName ③ midType 4（社群）→ _squareChat._name ④ null
 */
export function resolveDisplayName(
  chatId: string,
  midType: number,
  selfMid: string | null,
  lookup: { chatName(id: string): string | null; squareChatName(id: string): string | null }
): string | null {
  if (selfMid && chatId === selfMid) return SELF_CHAT_NAME
  const n = lookup.chatName(chatId)
  if (n && n.trim()) return n
  if (midType === 4) {
    const s = lookup.squareChatName(chatId)
    if (s && s.trim()) return s
  }
  return null
}

function cmp(a: OrderRow, b: OrderRow): number {
  if (a.lastUpdated !== b.lastUpdated) return b.lastUpdated - a.lastUpdated
  return a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : 0
}

/** R*：排除 hidden；釘選在前，兩段各依 lastUpdated DESC（同時間依 chatId 以求穩定）。 */
export function orderRStar(rows: readonly OrderRow[]): OrderRow[] {
  const visible = rows.filter((r) => !r.hidden)
  const pinned = visible.filter((r) => r.pinned).sort(cmp)
  const rest = visible.filter((r) => !r.pinned).sort(cmp)
  return [...pinned, ...rest]
}

/**
 * 每個名次是否和相鄰名次同時間（同一段內）。true 表示 LINE 端的相對順序未定義。
 */
export function timeTies(order: readonly OrderRow[]): boolean[] {
  return order.map((r, i) => {
    const same = (j: number): boolean =>
      j >= 0 && j < order.length && order[j].pinned === r.pinned && order[j].lastUpdated === r.lastUpdated
    return same(i - 1) || same(i + 1)
  })
}

/** 兩個名次是否同時間（同一段內）。 */
export function sameTime(order: readonly OrderRow[], i: number, j: number): boolean {
  const a = order[i]
  const b = order[j]
  return !!a && !!b && a.pinned === b.pinned && a.lastUpdated === b.lastUpdated
}
