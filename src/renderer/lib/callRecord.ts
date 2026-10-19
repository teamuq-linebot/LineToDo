/**
 * callRecord.ts — 通話訊息「顯示層」格式化。
 *
 * 舊列（無 metadata）的通話 text 是 LINE 原生生硬字串：
 *   "Call History : {DURATION_ms} millisecs, Result: {CAUSE}"
 * 舊列分不出語音/視訊（無 TYPE），故一律轉成「通用」通話 label。
 * 新通話由橋接已處理成漂亮 label、不符此 pattern，會原樣回傳、直接顯示。
 * 純顯示層轉換，不改動任何資料。
 */

/** LINE 原生通話字串 pattern；容許前後與各分隔符旁的空白。捕捉 N(ms)、X(cause)。 */
const CALL_HISTORY_RE = /^\s*Call History\s*:\s*(\d+)\s*millisecs,\s*Result:\s*(\d+)\s*$/

/** 毫秒 → 「N 秒」(<60000ms) 或「M 分 S 秒」(≥60000ms)。 */
function fmtDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  if (ms < 60000) return `${totalSec} 秒`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min} 分 ${sec} 秒`
}

/**
 * 把（可能是）LINE 原生通話字串轉成通用 label。
 * - 符合 CALL_HISTORY_RE → 依 cause 回傳通用通話 label（不分語音/視訊，舊列無 TYPE）：
 *     16 且 N>0 → 「📞 通話・{時長}」；16 但 N==0 → 「📞 通話」
 *     17 → 「📞 忙線未接」；18 → 「📞 未接來電」；21 → 「📞 已拒接」
 *     77 → 「📞 已取消通話」；127 → 「📞 通話失敗」；其他 cause → 「📞 通話」
 * - text === '[call]'（舊群組通話 CT 佔位）→ 「📞 通話」。
 * - 不符任何 pattern → 原樣回傳（新橋接 label 已是漂亮字）。
 * - null/空 → 原樣回傳。
 */
export function formatCallRecord(text: string | null): string | null {
  if (text == null || text === '') return text

  const m = CALL_HISTORY_RE.exec(text)
  if (m) {
    const ms = Number(m[1])
    const cause = Number(m[2])
    switch (cause) {
      case 16:
        return ms > 0 ? `📞 通話・${fmtDuration(ms)}` : '📞 通話'
      case 17:
        return '📞 忙線未接'
      case 18:
        return '📞 未接來電'
      case 21:
        return '📞 已拒接'
      case 77:
        return '📞 已取消通話'
      case 127:
        return '📞 通話失敗'
      default:
        return '📞 通話'
    }
  }

  if (text.trim() === '[call]') return '📞 通話'

  return text
}
