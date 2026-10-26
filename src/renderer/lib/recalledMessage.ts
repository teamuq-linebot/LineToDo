import type { RawLineMessage } from '../../shared/api'

export const UNSAVED_RECALLED_CONTENT_TEXT = '未保存收回前內容'
export const UNKNOWN_RECALLED_CONTENT_NOTICE = '原文無法判定：舊紀錄中的這段文字可能是系統佔位內容，也可能是實際文字。'
export const WHITESPACE_RECALLED_CONTENT_NOTICE = '原文已保存，但內容只有空白字元。'

const LEGACY_TYPE_PLACEHOLDER = /^\[type=(?:\d+|None)\]$/

/** A non-empty saved value must survive merging, including whitespace and ambiguous legacy placeholders. */
export function hasSavedMessageText(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.length > 0
}

/**
 * Merge a database copy with an in-memory/live copy of the same message.
 * Persisted content wins when it exists; a stale copy may add missing fields,
 * but cannot clear content or the monotonic recalled flag.
 */
export function mergeMessageCopies(
  preferred: RawLineMessage,
  incoming: RawLineMessage
): RawLineMessage {
  const text = hasSavedMessageText(preferred.text)
    ? preferred.text
    : hasSavedMessageText(incoming.text)
      ? incoming.text
      : preferred.text || incoming.text || ''

  return {
    ...preferred,
    ...incoming,
    chat: incoming.chat || preferred.chat,
    isGroup: incoming.isGroup || preferred.isGroup,
    text,
    contentType: preferred.contentType !== 0 || incoming.contentType === 0
      ? preferred.contentType
      : incoming.contentType,
    origFilename: preferred.origFilename || incoming.origFilename || null,
    fileSize: preferred.fileSize ?? incoming.fileSize ?? null,
    unsent: preferred.unsent === true || incoming.unsent === true
  }
}

/** Replace a recalled empty-text placeholder with a truthful, readable notice. */
export function recalledMessageText(message: RawLineMessage): string {
  if (message.unsent && !hasSavedMessageText(message.text)) {
    return UNSAVED_RECALLED_CONTENT_TEXT
  }
  return message.text
}

/** Explain ambiguous legacy rows without claiming the content was or was not saved. */
export function recalledMessageNotice(message: RawLineMessage): string | null {
  if (!message.unsent) return null
  if (LEGACY_TYPE_PLACEHOLDER.test(message.text)) return UNKNOWN_RECALLED_CONTENT_NOTICE
  if (message.text.length > 0 && message.text.trim().length === 0) {
    return WHITESPACE_RECALLED_CONTENT_NOTICE
  }
  return null
}
