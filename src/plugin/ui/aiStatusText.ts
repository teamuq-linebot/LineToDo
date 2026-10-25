/**
 * aiStatusText.ts — 看板狀態列的一句話。backend 回報的狀態用 shared/aiStatus 的 `describeStatus`；
 * 看板連不上 backend（`backend`／`backend_revoked`）是看板自己判斷的，文字在這裡（0.1.3 起逐字鎖定：scripts/plugin/lib/fenced-text.mjs）。
 */
import { BACKEND_INVOKE_TOGGLE_TITLE, PERMISSIONS_SECTION_TITLE, PLUGIN_PAGE_PLACE } from '../../renderer/lib/backendError'
import { describeStatus as describeBackendStatus } from '../../shared/aiStatus'
import type { AiStatus } from '../../shared/aiStatus'

type StatusLike = Pick<AiStatus, 'state' | 'reason' | 'resumeAt' | 'busy' | 'turnsPerMinute' | 'turnsPerHour'>

export function describeStatus(status: StatusLike, now = Date.now()): string {
  if (status.state === 'paused') {
    switch (status.reason) {
      case 'backend': return '與外掛後端的連線暫時中斷，稍後重試'
      // review B1：Core 1.7.1 重新允許權限不會解除隔離，這裡不承諾自動繼續，只列出有效的操作。
      // R1-N1：權限名稱用 TeamUQ 設定頁上開關的實際標題（BACKEND_INVOKE_TOGGLE_TITLE）。
      case 'backend_revoked': return `TeamUQ 目前不讓這個外掛呼叫後端（「${BACKEND_INVOKE_TOGGLE_TITLE}」權限被關閉、外掛被停用，或後端太久沒有回應而被隔離），AI 整理暫停；請到 ${PLUGIN_PAGE_PLACE}打開這個外掛，確認「${PERMISSIONS_SECTION_TITLE}」裡已允許「${BACKEND_INVOKE_TOGGLE_TITLE}」且外掛是啟用的，仍沒有恢復就把外掛停用再啟用，或重新啟動 TeamUQ`
      default: break
    }
  }
  return describeBackendStatus(status, now)
}
