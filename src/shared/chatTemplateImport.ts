import type { ChatKind, ChatProfileRuleKind } from './chatProfiles'

export const CHAT_TEMPLATE_IMPORT_MAX_CHARS = 12_000

export type ChatTemplateImportErrorCode = 'invalid_source' | 'missing_template' | 'marker_conflict' | 'too_long'

export interface ChatTemplateImportInput {
  draft: string
  template: string
  kind: ChatProfileRuleKind
  chatKind: ChatKind
  natureId: string
}

export type ChatTemplateImportResult =
  | { ok: true; draft: string; changed: boolean }
  | { ok: false; code: ChatTemplateImportErrorCode }

export type CleanChatRuleResult = { ok: true; text: string } | { ok: false; code: 'marker_conflict' }

const START_PREFIX = '【性質規則匯入區：'

function markers(kind: ChatProfileRuleKind, chatKind: ChatKind, natureId: string): { start: string; end: string } {
  return {
    start: `${START_PREFIX}${kind}；${chatKind}/${natureId}；開始】`,
    end: `【性質規則匯入區：${kind}；結束】`
  }
}

function occurrences(value: string, token: string): number[] {
  const result: number[] = []
  let from = 0
  while (true) {
    const index = value.indexOf(token, from)
    if (index < 0) return result
    result.push(index)
    from = index + token.length
  }
}

/** Hide one well formed controlled marker block while preserving all surrounding business text. */
export function cleanChatRuleMarkers(value: string, kind: ChatProfileRuleKind): CleanChatRuleResult {
  if (typeof value !== 'string') return { ok: false, code: 'marker_conflict' }
  const endMarker = `【性質規則匯入區：${kind}；結束】`
  const starts = occurrences(value, `${START_PREFIX}${kind}；`).filter(index => !value.startsWith(endMarker, index))
  const ends = occurrences(value, endMarker)
  const other = kind === 'todo' ? 'topic' : 'todo'
  if (value.includes(`${START_PREFIX}${other}`)) return { ok: false, code: 'marker_conflict' }
  if (starts.length === 0 && ends.length === 0) return value.includes(START_PREFIX) ? { ok: false, code: 'marker_conflict' } : { ok: true, text: value }
  if (starts.length !== 1 || ends.length !== 1) return { ok: false, code: 'marker_conflict' }
  const start = starts[0]
  const startEnd = value.indexOf('】', start) + 1
  const end = ends[0]
  const startMarker = value.slice(start, startEnd)
  if (startEnd <= start || end < startEnd || !startMarker.endsWith('；開始】') || !/^【性質規則匯入區：(?:todo|topic)；(?:group|non_group|unknown)\/[a-z0-9][a-z0-9_-]{0,63}；開始】$/.test(startMarker)) return { ok: false, code: 'marker_conflict' }
  const cleaned = `${value.slice(0, start)}${value.slice(startEnd, end)}${value.slice(end + `【性質規則匯入區：${kind}；結束】`.length)}`
  return { ok: true, text: cleaned.replace(/\n{3,}/g, '\n\n') }
}

/** Merge a nature matrix instruction into its own identifiable section without changing user text. */
export function importChatTemplate(input: ChatTemplateImportInput): ChatTemplateImportResult {
  const { draft, template, kind, chatKind, natureId } = input
  if (typeof draft !== 'string' || typeof template !== 'string' || !['todo', 'topic'].includes(kind) || !['group', 'non_group', 'unknown'].includes(chatKind) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(natureId)) {
    return { ok: false, code: 'invalid_source' }
  }
  if (!template.trim()) return { ok: false, code: 'missing_template' }

  const { start, end } = markers(kind, chatKind, natureId)
  const broadKindPrefix = `${START_PREFIX}${kind}`
  const kindPrefix = `${START_PREFIX}${kind}；`
  // The full namespace is reserved. Reject either kind and malformed prefixes
  // before constructing a controlled block, so one rule can never capture or
  // later be reinterpreted as the other rule's block.
  if (template.includes(START_PREFIX)) return { ok: false, code: 'marker_conflict' }
  const ends = occurrences(draft, end)
  const starts = occurrences(draft, kindPrefix).filter(index => !draft.startsWith(end, index))
  const markerMentions = occurrences(draft, broadKindPrefix)
  if (markerMentions.length !== starts.length + ends.length) return { ok: false, code: 'marker_conflict' }
  let next: string

  if (starts.length === 0 && ends.length === 0) {
    const section = `${start}\n${template}\n${end}`
    next = draft.length === 0 ? section : `${draft}${draft.endsWith('\n') ? '\n' : '\n\n'}${section}`
  } else {
    if (starts.length !== 1 || ends.length !== 1) return { ok: false, code: 'marker_conflict' }
    const startIndex = starts[0]
    const startEnd = draft.indexOf('】', startIndex) + 1
    const endIndex = ends[0]
    if (startEnd <= startIndex || endIndex < startEnd || draft.indexOf('】', startIndex + 1) < 0) return { ok: false, code: 'marker_conflict' }
    const priorStartMarker = draft.slice(startIndex, startEnd)
    if (!priorStartMarker.endsWith('；開始】') || !priorStartMarker.startsWith(kindPrefix)) return { ok: false, code: 'marker_conflict' }
    const replacement = `${start}\n${template}\n${end}`
    next = `${draft.slice(0, startIndex)}${replacement}${draft.slice(endIndex + end.length)}`
  }

  if (next.length > CHAT_TEMPLATE_IMPORT_MAX_CHARS) return { ok: false, code: 'too_long' }
  return { ok: true, draft: next, changed: next !== draft }
}
