import { PROMPT_GOAL_MAX_CHARS, PROMPT_MAX_CHARS, validatePromptSuggestion } from '../../../shared/promptSettings'
import type { PromptSuggestion } from '../../../shared/promptSettings'

export const PROMPT_DRAFT_KEY = 'prompt.editor.draft'
export const DEFAULT_PROMPT_GOAL = '請讓待辦分類、指派對象、去重與時間判定更清楚，保留原本有效的規則。'
const suggestionListeners = new Set<() => void>()
export function onPromptSuggestionSaved(listener: () => void): () => void {
  suggestionListeners.add(listener)
  return () => { suggestionListeners.delete(listener) }
}
export function notifyPromptSuggestionSaved(): void {
  for (const listener of suggestionListeners) { try { listener() } catch { } }
}
export interface PromptDraft {
  revision: string
  draft: string
  goal: string
  suggestion: PromptSuggestion | null
  suggestionBase: string
}

export function parsePromptDraft(value: unknown): PromptDraft | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record.revision !== 'string' || !record.revision || record.revision.length > 64) return undefined
  if (typeof record.draft !== 'string' || record.draft.length > PROMPT_MAX_CHARS) return undefined
  if (typeof record.goal !== 'string' || record.goal.length > PROMPT_GOAL_MAX_CHARS) return undefined
  if (typeof record.suggestionBase !== 'string' || record.suggestionBase.length > PROMPT_MAX_CHARS) return undefined
  let suggestion: PromptSuggestion | null = null
  if (record.suggestion !== null) {
    if (!record.suggestion || typeof record.suggestion !== 'object') return undefined
    const proposed = record.suggestion as Record<string, unknown>
    try { suggestion = validatePromptSuggestion({ prompt: proposed.prompt, changes: proposed.changes }, typeof proposed.modelId === 'string' && proposed.modelId.length <= 96 ? proposed.modelId : null) }
    catch { return undefined }
  }
  return { revision: record.revision, draft: record.draft, goal: record.goal, suggestion, suggestionBase: record.suggestionBase }
}
