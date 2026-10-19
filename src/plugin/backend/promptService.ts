import { createHash } from 'node:crypto'
import type { SettingsStore } from '../../main/config/settings'
import { EXTRACT_SYSTEM_PROMPT } from '../../main/llm/extractPrompt'
import { EXTRACT_OUTPUT_CONTRACT } from './aiOutputContract'
import type { AiTaskQueue } from './aiTaskQueue'
import { parseModelJson } from '../../shared/jsonReply'
import { PROMPT_MAX_CHARS, PromptError, promptRefinementInput, validatePrompt, validatePromptSuggestion } from '../../shared/promptSettings'
import type { PromptRefinementRequest, PromptState, PromptSuggestion } from '../../shared/promptSettings'

export interface PromptService {
  state(): PromptState
  save(prompt: unknown, expectedRevision: unknown): PromptState
  reset(expectedRevision: unknown): PromptState
  refine(request: PromptRefinementRequest): Promise<PromptSuggestion>
  revision(): string
}

export function createPromptService(settings: SettingsStore, tasks: Pick<AiTaskQueue, 'request'>): PromptService {
  const active = (): string => settings.get().pluginPrompt ?? EXTRACT_SYSTEM_PROMPT
  const revision = (): string => createHash('sha256').update(active()).digest('hex')
  const state = (): PromptState => ({
    initialPrompt: EXTRACT_SYSTEM_PROMPT, activePrompt: active(), customized: active() !== EXTRACT_SYSTEM_PROMPT,
    revision: revision(), maxChars: PROMPT_MAX_CHARS, outputFormat: EXTRACT_OUTPUT_CONTRACT
  })
  const assertRevision = (expected: unknown): void => { if (expected !== revision()) throw new PromptError('prompt_conflict') }
  return {
    state, revision,
    save(prompt, expectedRevision) {
      assertRevision(expectedRevision)
      const text = validatePrompt(prompt)
      settings.update({ pluginPrompt: text === EXTRACT_SYSTEM_PROMPT ? null : text })
      return state()
    },
    reset(expectedRevision) {
      assertRevision(expectedRevision)
      settings.update({ pluginPrompt: null })
      return state()
    },
    async refine(request) {
      const input = promptRefinementInput(request, EXTRACT_OUTPUT_CONTRACT)
      const result = await tasks.request({ kind: 'promptRefine', ...input, expectJson: true })
      const parsed = parseModelJson(result.text)
      if (!parsed.ok) throw new PromptError('prompt_suggestion_invalid')
      return validatePromptSuggestion(parsed.value, result.model)
    }
  }
}
