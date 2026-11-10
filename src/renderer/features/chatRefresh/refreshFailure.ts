/** 「重新整理最近 N 天」失敗原因 → 畫面上的一行短字。只看原因碼，不顯示底層錯誤訊息。 */

/** AI 無法使用：host 連不上、供應者未就緒／未登入、逾時、待辦佇列等不到 AI 結果。 */
const AI_UNAVAILABLE: ReadonlySet<string> = new Set([
  'ai_unavailable', 'transport', 'plugin_host_unavailable', 'plugin_host_timeout', 'timeout', 'extract_await_timeout',
  'not_installed', 'not_authenticated', 'invalid_config'
])

/** 限流／額度：稍後再試。 */
const AI_BUSY: ReadonlySet<string> = new Set(['rate_limited', 'quota_exceeded', 'quota_exhausted'])

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
