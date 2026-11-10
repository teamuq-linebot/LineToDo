/** 「重新整理最近 N 天」失敗原因 → 畫面上的一行短字。只看原因碼，不顯示底層錯誤訊息。 */

/** AI 無法使用：host 連不上、供應者未就緒／未登入、逾時、待辦佇列等不到 AI 結果。 */
const AI_UNAVAILABLE: ReadonlySet<string> = new Set([
  'ai_unavailable', 'transport', 'plugin_host_unavailable', 'plugin_host_timeout', 'timeout', 'extract_await_timeout',
  'not_installed', 'not_authenticated', 'invalid_config'
])

/** 限流／額度：稍後再試。 */
const AI_BUSY: ReadonlySet<string> = new Set(['rate_limited', 'quota_exceeded', 'quota_exhausted'])

/** 後端還沒準備好（已停止、執行時未啟動、外掛已卸載）。 */
const BACKEND_NOT_READY: ReadonlySet<string> = new Set(['backend_stopped', 'runtime_not_running', 'disposed'])

/** 單一錯誤碼（呼叫丟出的 error code）→ 一行短字；未知的碼回 undefined，由呼叫端用通用文案。 */
export function refreshCodeText(code: string): string | undefined {
  if (AI_UNAVAILABLE.has(code)) return 'AI 無法使用'
  if (AI_BUSY.has(code)) return 'AI 忙碌中，稍後再試'
  if (code === 'busy') return '另一項工作進行中，請稍後再試'
  if (code === 'view_call_timeout') return '逾時，請稍後再試'
  if (BACKEND_NOT_READY.has(code)) return '後端未就緒，請稍後再試'
  return undefined
}

/** 呼叫丟出的錯誤碼 → 畫面短字；只有未知的碼才用通用文案。 */
export function refreshErrorText(code: string): string {
  return refreshCodeText(code) ?? '重新整理失敗，請稍後再試'
}

export interface RefreshFailureInput {
  reason?: string
  todo: { failed: boolean; reason?: string }
  topics: { failed: boolean; reason?: string }
}

export function refreshFailureText(result: RefreshFailureInput): string {
  if (result.reason === 'disabled') return '待辦與議題都已關閉'
  if (result.reason === 'unsupported_chat') return '找不到這個聊天室'
  const reasons = [result.reason, result.todo.failed ? result.todo.reason : undefined, result.topics.failed ? result.topics.reason : undefined]
  if (reasons.some((reason) => reason !== undefined && AI_UNAVAILABLE.has(reason))) return 'AI 無法使用'
  if (reasons.some((reason) => reason !== undefined && AI_BUSY.has(reason))) return 'AI 忙碌中，稍後再試'
  return result.todo.failed || result.topics.failed ? '部分重新整理失敗，請稍後再試' : '重新整理失敗，請稍後再試'
}
