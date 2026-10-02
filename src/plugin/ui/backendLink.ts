/**
 * backendLink.ts — 外掛畫面上方「backend 連線狀態」那一行要顯示什麼（G-03）。純函式（BackendStatusBar.tsx 與測試共用）。
 *   - `revoked`：TeamUQ 隔離了這個外掛的後端呼叫（關閉「後端呼叫」權限 backend:invoke、停用外掛，或後端逾時）或外掛已移除。Core 會停掉 backend，
 *     LINE 讀取、解密、落庫全部停止；明講可能的原因與實際有效的操作（確認權限與啟用狀態；仍沒恢復就停用再啟用外掛或重新啟動 TeamUQ），
 *     而不是讓看板安靜地變空白或顯示「暫時中斷」。Core 1.7.1 重新允許權限不會解除隔離（review B1），所以這裡不承諾會自動恢復。
 *   - `unavailable`：backend 沒起來、忙或當掉（沒有被隔離，TeamUQ 會重新啟動它）。
 *   - 其他狀態不顯示。文字來自 `lib/backendError.ts`（與各元件的錯誤訊息一致）。
 */
import { describeBackendError } from '../../renderer/lib/backendError'
import type { BackendLink } from '../../renderer/platform/pluginTransport'

export function describeLink(link: BackendLink | null): { tone: 'err' | 'warn'; text: string } | null {
  if (!link || (link.state !== 'revoked' && link.state !== 'unavailable')) return null
  const described = describeBackendError({ code: link.code ?? (link.state === 'revoked' ? 'plugin_permission_denied' : 'plugin_backend_unavailable') })
  return { tone: link.state === 'revoked' ? 'err' : 'warn', text: described.text }
}
