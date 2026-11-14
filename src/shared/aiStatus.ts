/**
 * aiStatus.ts — AI 整理的狀態（backend 的 HostAiPort／ExtractWorker 產生，看板狀態列與錯誤訊息顯示）。純資料＋一個純函式。
 *
 * 0.2.0：AI 在 backend 經 TeamUQ 的 `context.host.ai.complete` 執行（Core >=1.7.13），看板不需要開著，也沒有「可見性」暫停。
 * `backend`／`backend_revoked` 兩個 reason 由看板自己判斷（它連不上 backend 時 backend 當然無法回報狀態），文字在 src/plugin/ui/aiStatusText.ts（照 0.1.3 逐字鎖定，scripts/plugin/lib/fenced-text.mjs）。
 */
import { AI_CHAT_ALLOW_STEPS } from './teamuqPlaces'

export type AiStatusState = 'stopped' | 'running' | 'paused' | 'unavailable' | 'revoked'

export interface AiCounters {
  /** 實際送出的 `host.ai.complete` 輪數（含 JSON 重問）。 */
  turns: number
  repairs: number
  extracted: number
  rejected: number
  failed: number
  released: number
  tasksDone: number
  tasksFailed: number
  rateLimited: number
}

export const EMPTY_AI_COUNTERS: Readonly<AiCounters> = Object.freeze({ turns: 0, repairs: 0, extracted: 0, rejected: 0, failed: 0, released: 0, tasksDone: 0, tasksFailed: 0, rateLimited: 0 })

export interface AiStatus {
  state: AiStatusState
  /**
   * 暫停／不可用的原因：`rate_limited`（每分鐘上限）、`rate_limited_hour`（每小時上限）、`quota_exhausted`、`busy`、`backend`、`backend_revoked`（看板自己判斷）、
   * `provider_<state>`、`no_provider`、`loading_models`、`model_unavailable`、`effort_unavailable`、`provider_not_found`…
   */
  reason: string | null
  /** 預計何時恢復（毫秒 epoch；未知＝null）。 */
  resumeAt: number | null
  /** 正在跟 TeamUQ 的 AI 對話。 */
  busy: boolean
  provider: { providerId: string; modelId: string | null } | null
  counters: AiCounters
  /** host 目前的每分鐘輪數上限（`getOptions().limits.turnsPerMinute`；取得之前是起始值）。文字用它，不寫死。 */
  turnsPerMinute?: number
  /** host 目前的每小時輪數上限（取得之前是起始值）。「已達每小時上限」的文字用它。 */
  turnsPerHour?: number
  /** 待抽取佇列（只在 `ai.status` 的回覆裡有）。 */
  queue?: { pending: number; leased: number; awaiting: number }
}

const PROVIDER_STATE_TEXT: Record<string, string> = {
  not_installed: '所選 AI 尚未安裝（請在 TeamUQ 加入並登入 AI）',
  not_logged_in: '所選 AI 尚未登入（請依 TeamUQ 的提示登入）',
  unsupported_version: '所選 AI 版本不支援目前的 TeamUQ（請依 TeamUQ 的提示更新）',
  unavailable: '所選 AI 目前無法使用',
  not_supported_yet: '這個 AI 供應者尚未支援'
}

/** 給使用者看的一句話（看板狀態列、「AI 尚未接上」訊息、回顧不能開始時的說明共用）。 */
export function describeStatus(status: Pick<AiStatus, 'state' | 'reason' | 'resumeAt' | 'busy' | 'turnsPerMinute' | 'turnsPerHour'>, now = Date.now()): string {
  const secs = status.resumeAt === null ? null : Math.max(1, Math.ceil((status.resumeAt - now) / 1000))
  switch (status.state) {
    case 'stopped': return 'AI 整理尚未啟動'
    // 0.1.3 r1：不寫「設定 → 外掛」（1.6.8 才有）；位置與開關標題只用兩版都有的名稱（src/shared/teamuqPlaces.ts）。
    case 'revoked': return `已關閉此外掛的 AI 權限（ai:chat）；${AI_CHAT_ALLOW_STEPS}後，重新開啟看板`
    case 'unavailable':
      if (status.reason === 'loading_models') return '正在連接 TeamUQ 的 AI 模型…'
      if (status.reason === 'model_unavailable') return '所選 AI 模型目前不可用，請到 LINE 待辦 Pro 的設定重新選擇模型'
      if (status.reason === 'effort_unavailable') return '所選推理強度不受這個模型支援，請到 LINE 待辦 Pro 的設定重新選擇'
      if (status.reason === 'provider_not_found') return '所選 AI 供應者目前不可用，請到 LINE 待辦 Pro 的設定重新選擇'
      if (status.reason === 'host_unavailable') return 'TeamUQ 的 AI 暫時沒有回應，稍後會自動重試'
      return status.reason?.startsWith('provider_') ? (PROVIDER_STATE_TEXT[status.reason.slice('provider_'.length)] ?? 'AI 目前無法使用') : 'AI 目前無法使用（找不到可用的 AI 供應者）'
    case 'paused':
      switch (status.reason) {
        case 'rate_limited': return `已達 TeamUQ 的 AI 呼叫上限${typeof status.turnsPerMinute === 'number' ? `（每分鐘 ${status.turnsPerMinute} 次）` : ''}，${secs ?? '稍後'}${secs === null ? '' : ' 秒後'}繼續`
        case 'rate_limited_hour': return `已達 TeamUQ 的 AI 呼叫上限${typeof status.turnsPerHour === 'number' ? `（每小時 ${status.turnsPerHour} 次）` : ''}，${secs === null ? '稍後' : `約 ${Math.ceil(secs / 60)} 分鐘後`}繼續`
        case 'quota_exhausted': return `AI 額度已用完，${secs === null ? '稍後' : `約 ${Math.ceil(secs / 60)} 分鐘後`}繼續`
        default: return 'AI 整理暫停中，稍後繼續'
      }
    default: return status.busy ? 'AI 正在整理新訊息…' : 'AI 整理已就緒（由外掛背景程式執行，看板不需要開著）'
  }
}
