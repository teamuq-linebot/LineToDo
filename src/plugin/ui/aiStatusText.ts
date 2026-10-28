/**
 * aiStatusText.ts — 看板狀態列的一句話。backend 回報的狀態用 shared/aiStatus 的 `describeStatus`；
 * 看板連不上 backend（`backend`／`backend_revoked`）是看板自己判斷的，文字在這裡（0.1.3 起逐字鎖定：scripts/plugin/lib/fenced-text.mjs）。
 */
import { PLUGIN_PAGE_PLACE } from '../../renderer/lib/backendError'
import { describeStatus as describeBackendStatus } from '../../shared/aiStatus'
import type { AiStatus } from '../../shared/aiStatus'

type StatusLike = Pick<AiStatus, 'state' | 'reason' | 'resumeAt' | 'busy' | 'turnsPerMinute' | 'turnsPerHour'>

export function describeStatus(status: StatusLike, now = Date.now()): string {
  if (status.state === 'paused') {
    switch (status.reason) {
      case 'backend': return '與外掛後端的連線暫時中斷，稍後重試'
      // review B1：Core 1.7.1 重新允許權限不會解除隔離，這裡不承諾自動繼續，只列出有效的操作。
      case 'backend_revoked': return `TeamUQ 目前不讓這個外掛呼叫後端（可能不是「完全信任級」組合外掛、已停用，或後端逾時被隔離），AI 整理暫停；請到 ${PLUGIN_PAGE_PLACE}打開這個外掛，確認執行範圍是「完全信任級」且外掛已啟用。信任或套件狀態異常時請重新安裝可信任來源的外掛；逾時隔離時請停用再啟用，或重新啟動 TeamUQ`
      default: break
    }
  }
  return describeBackendStatus(status, now)
}
