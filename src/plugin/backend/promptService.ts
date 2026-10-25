import { createHash } from 'node:crypto'
import { AiPortError } from '../../core/aiPort'
import type { AiPort } from '../../core/aiPort'
import type { SettingsStore } from '../../main/config/settings'
import { EXTRACT_SYSTEM_PROMPT } from '../../main/llm/extractPrompt'
import { EXTRACT_OUTPUT_CONTRACT } from './aiOutputContract'
import { PROMPT_MAX_CHARS, PromptError, promptRefinementInput, validatePrompt, validatePromptSuggestion } from '../../shared/promptSettings'
import type { PromptRefinementRequest, PromptState, PromptSuggestion } from '../../shared/promptSettings'

export interface PromptService {
  state(): PromptState
  save(prompt: unknown, expectedRevision: unknown): PromptState
  reset(expectedRevision: unknown): PromptState
  refine(request: PromptRefinementRequest): Promise<PromptSuggestion>
  revision(): string
  /** 抽取實際送給 AI 的 system：目前生效的 prompt＋固定輸出格式（ExtractWorker 每次領到項目時讀）。 */
  extractSystem(): string
}

export function createPromptService(settings: SettingsStore, ai: AiPort): PromptService {
  const active = (): string => settings.get().pluginPrompt ?? EXTRACT_SYSTEM_PROMPT
  const revision = (): string => createHash('sha256').update(active()).digest('hex')
  const state = (): PromptState => ({
    initialPrompt: EXTRACT_SYSTEM_PROMPT, activePrompt: active(), customized: active() !== EXTRACT_SYSTEM_PROMPT,
    revision: revision(), maxChars: PROMPT_MAX_CHARS, outputFormat: EXTRACT_OUTPUT_CONTRACT
  })
  const assertRevision = (expected: unknown): void => { if (expected !== revision()) throw new PromptError('prompt_conflict') }
  return {
    state, revision,
    extractSystem: () => `${active()}\n\n${EXTRACT_OUTPUT_CONTRACT}`,
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
      let result: Awaited<ReturnType<AiPort['complete']>>
      try {
        result = await ai.complete({
          ...input,
          expectJson: true,
          priority: 'user',
          // 形狀不對（多餘欄位、changes 不合規）也算「回覆不合格」，由 port 重問一次。
          validate: (value) => {
            try { validatePromptSuggestion(value, null); return { ok: true, value } } catch { return { ok: false, reason: '只能有 prompt（字串）與 changes（1 至 8 項字串）兩個欄位' } }
          }
        })
      } catch (error) {
        if (error instanceof AiPortError && (error.code === 'invalid_json' || error.code === 'invalid_result')) throw new PromptError('prompt_suggestion_invalid')
        throw error
      }
      return validatePromptSuggestion(result.value, result.model)
    }
  }
}
