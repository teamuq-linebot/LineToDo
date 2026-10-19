import type { ChatDTO, MessageDTO } from '../db/dto'
import type { BlocklistRules } from '../config/defaults'

/**
 * blocklist.ts — 降噪黑名單判定（IMPLEMENTATION_PLAN.md §7.1）。
 *
 * 兩個層次：
 *   1) evaluateChatAutoBlock：對「新偵測到的 chat」依名稱關鍵字判是否自動 block。
 *      命中回 reason（'auto:keyword' / 'auto:sender'），由 runOnce 寫進 chats.blocked。
 *   2) isBatchNoise：對「該 chat 這輪的訊息」判是否整批噪音（只貼圖 / 全過短）→ 不送 LLM，省 token。
 *
 * 純函式、不碰 DB，方便測試。
 */

export interface AutoBlockResult {
  block: boolean
  reason: string | null
}

/** 名稱 / 既有黑名單關鍵字判定（對單一 chat）。 */
export function evaluateChatAutoBlock(
  chat: Pick<ChatDTO, 'name' | 'isGroup'>,
  rules: BlocklistRules
): AutoBlockResult {
  const name = (chat.name ?? '').trim()
  if (!name) return { block: false, reason: null }

  for (const kw of rules.nameKeywords) {
    if (kw && name.includes(kw)) {
      return { block: true, reason: `auto:keyword:${kw}` }
    }
  }
  return { block: false, reason: null }
}

/**
 * 該 chat 本輪訊息是否整批視為 noise（不值得送 LLM）：
 *   - 全部都是 contentTypeNoiseOnly（如貼圖 7）→ noise。
 *   - 或：所有「文字方向 in」訊息去空白後皆短於 minTextLenForLLM → noise。
 * out（自己發的）不單獨構成有意義抽取觸發，但若該輪含足夠長的 in 文字則不算 noise。
 */
export function isBatchNoise(messages: MessageDTO[], rules: BlocklistRules): boolean {
  if (messages.length === 0) return true

  const noiseTypes = new Set(rules.contentTypeNoiseOnly)
  const allNoiseType = messages.every((m) => noiseTypes.has(m.contentType))
  if (allNoiseType) return true

  // 是否存在「足夠長」的文字訊息（任一方向皆計入內容性）。
  const hasMeaningfulText = messages.some((m) => {
    if (m.contentType !== 0) return false // 非文字（含 CT label）不算實質文字
    const t = (m.text ?? '').replace(/\s+/g, '')
    return t.length >= rules.minTextLenForLLM
  })
  return !hasMeaningfulText
}

/**
 * 逐對話關鍵字忽略：該 chat 的 ignore 關鍵字（已小寫）若命中此 newTodo 的
 * title + detail（小寫子字串比對）→ 回 true（呼叫端跳過、不建立此代辦）。
 * 第二層 per-chat 忽略，與全域 blocklist（擋整個 chat 不送 LLM）互補。
 */
export function matchesChatIgnoreKeyword(
  todo: { title: string; detail?: string | null },
  keywords: string[]
): boolean {
  if (!keywords || keywords.length === 0) return false
  const hay = `${todo.title} ${todo.detail ?? ''}`.toLowerCase()
  return keywords.some((kw) => kw.length > 0 && hay.includes(kw))
}
