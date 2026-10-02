/**
 * backendLink.ts — 外掛畫面上方「backend 連線狀態」那一行要顯示什麼（G-03）。純函式（BackendStatusBar.tsx 與測試共用）。
 *   - `revoked`：使用者在 TeamUQ 撤銷了「後端呼叫」（backend:invoke）、停用或移除了外掛。Core 會停掉 backend，LINE 讀取、解密、落庫全部停止；
 *     明講原因與在哪裡重新允許，而不是讓看板安靜地變空白或顯示「暫時中斷」。重新允許後事件輪詢會自動恢復並重讀畫面。
 *   - `unavailable`：backend 沒起來、當掉或逾時（TeamUQ 會重新啟動它）。
 *   - 其他狀態不顯示。文字來自 `lib/backendError.ts`（與各元件的錯誤訊息一致）。
 */
import { describeBackendError } from '../../renderer/lib/backendError'
import type { BackendLink } from '../../renderer/platform/pluginTransport'

export function describeLink(link: BackendLink | null): { tone: 'err' | 'warn'; text: string } | null {
  if (!link || (link.state !== 'revoked' && link.state !== 'unavailable')) return null
  const described = describeBackendError({ code: link.code ?? (link.state === 'revoked' ? 'plugin_permission_denied' : 'plugin_backend_unavailable') })
  return { tone: link.state === 'revoked' ? 'err' : 'warn', text: described.text }
}
