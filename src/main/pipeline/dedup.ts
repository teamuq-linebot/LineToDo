import type { TodoDTO } from '../db/dto'

/**
 * dedup.ts — App 端近似去重保險（IMPLEMENTATION_PLAN.md §6.5 第 3 點）。
 *
 * LLM 是主判（不重複產生等同既有 todo）；這裡是「最後一道軟性保險」：
 * 把標題正規化（去空白/標點/全半形差異）後比對，命中既有未完成 todo 則視為同一件事，
 * 由 runOnce 改成「更新既有」而非「新增」。
 */

/**
 * 標題正規化：
 *   - 全形 → 半形（ASCII 區）
 *   - 轉小寫
 *   - 去除所有空白與常見標點 / 符號
 * 目的是讓「等Abby回報價單」與「等 Abby 回報價單。」正規化後相等。
 */
export function normalizeTitle(title: string): string {
  if (!title) return ''
  // 全形 ASCII（U+FF01–U+FF5E）轉半形；全形空白（U+3000）轉半形空白。
  let s = title.replace(/[！-～]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  )
  s = s.replace(/　/g, ' ')
  s = s.toLowerCase()
  // 去空白與標點/符號（保留中日韓文字、英數）。
  s = s.replace(/[\s!-/:-@[-`{-~，。、；：「」『』（）！？～·…—－]/g, '')
  return s
}

/**
 * 在既有未完成 todo 中找「正規化標題相等」者。回傳命中的 todo（無則 null）。
 * 僅在同一 chat 範圍內呼叫（呼叫端已限定 chatId）。
 */
export function findDuplicateOpenTodo(
  newTitle: string,
  openTodos: TodoDTO[]
): TodoDTO | null {
  const key = normalizeTitle(newTitle)
  if (!key) return null
  for (const t of openTodos) {
    if (normalizeTitle(t.title) === key) return t
  }
  return null
}
