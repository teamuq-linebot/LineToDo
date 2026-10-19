import type { PluginAiApiV1, PluginAiSessionV1 } from '@teamuq/plugin-sdk'
import type { HostAiSelection } from '../../shared/hostAi'
import { parseModelJson } from '../../shared/jsonReply'
import { PromptError, promptRefinementInput, validatePromptSuggestion } from '../../shared/promptSettings'
import type { PromptRefinementRequest, PromptState, PromptSuggestion } from '../../shared/promptSettings'

export function createPromptRefiner(ports: {
  ai: PluginAiApiV1
  state(): Promise<PromptState>
  selection(): Promise<HostAiSelection>
  timeoutMs?: number
}) {
  let active = false
  let disposed = false
  let session: PluginAiSessionV1 | null = null
  let cancel: (() => void) | null = null
  return {
    async refine(request: PromptRefinementRequest): Promise<PromptSuggestion> {
      if (disposed) throw new PromptError('prompt_cancelled')
      if (active) throw new PromptError('prompt_busy')
      active = true
      let off: (() => void) | null = null
      let timer: ReturnType<typeof setTimeout> | null = null
      try {
        const state = await ports.state()
        const input = promptRefinementInput(request, state.outputFormat)
        const selection = await ports.selection()
        const options = await ports.ai.getOptions()
        if (disposed) throw new PromptError('prompt_cancelled')
        if (options.quota.state === 'exhausted') throw new PromptError('quota_exhausted')
        const provider = selection.providerId !== null
          ? options.providers.find((item) => item.id === selection.providerId && item.state === 'ready')
          : options.providers.find((item) => item.id === options.defaultProviderId && item.state === 'ready') ?? options.providers.find((item) => item.state === 'ready')
        if (!provider) throw new PromptError('provider_not_ready')
        const model = selection.modelId !== null ? provider.models.find((item) => item.id === selection.modelId) : provider.models.find((item) => item.isDefault) ?? provider.models[0]
        if (!model || (selection.effort !== null && !model.efforts.includes(selection.effort))) throw new PromptError('model_unavailable')
        if (input.system.length > options.limits.systemChars || input.user.length > options.limits.inputChars) throw new PromptError('prompt_too_long')
        session = await ports.ai.openSession({ providerId: provider.id, modelId: model.id, ...(selection.effort === null ? {} : { effort: selection.effort }), system: input.system })
        if (disposed) throw new PromptError('prompt_cancelled')
        const opened = session
        let text = ''
        let resolve!: (value: string) => void
        let reject!: (error: Error) => void
        let done = false
        const reply = new Promise<string>((yes, no) => { resolve = yes; reject = no })
        const fail = (code: string): void => { if (!done) { done = true; reject(new PromptError(code)) } }
        cancel = () => fail('prompt_cancelled')
        off = opened.onEvent((event) => {
          if (done) return
          if (event.kind === 'textDelta') {
            text += event.text
            if (text.length > 32_000) fail('reply_too_long')
          } else if (event.kind === 'completed') { done = true; resolve(text) }
          else if (event.kind === 'failed') fail(event.code)
          else if (event.kind === 'interrupted') fail('prompt_cancelled')
        })
        timer = setTimeout(() => fail('turn_timeout'), ports.timeoutMs ?? 150_000)
        void opened.send({ text: input.user }).catch((error: unknown) => fail(error instanceof Error ? error.message.replace(/^Error:\s*/, '') : 'provider_error'))
        const raw = await reply
        const parsed = parseModelJson(raw)
        if (!parsed.ok) throw new PromptError('prompt_suggestion_invalid')
        return validatePromptSuggestion(parsed.value, opened.effective.modelId)
      } finally {
        if (timer !== null) clearTimeout(timer)
        off?.()
        cancel = null
        const opened = session
        session = null
        if (opened) await opened.close().catch(() => undefined)
        active = false
      }
    },
    dispose() {
      disposed = true
      cancel?.()
      if (session) void session.interrupt().catch(() => undefined)
    }
  }
}
