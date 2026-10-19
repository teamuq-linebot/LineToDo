import type { PluginAiApiV1 } from '@teamuq/plugin-sdk'
import type { PromptControl } from './promptSettings'

export type HostAiOptions = Awaited<ReturnType<PluginAiApiV1['getOptions']>>
export type HostAiEffort = NonNullable<Parameters<PluginAiApiV1['openSession']>[0]['effort']>

export interface HostAiSelection {
  providerId: string | null
  modelId: string | null
  effort: HostAiEffort | null
}

export const DEFAULT_HOST_AI_SELECTION: Readonly<HostAiSelection> = Object.freeze({ providerId: null, modelId: null, effort: null })
export const HOST_AI_EFFORTS: readonly HostAiEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh']

export function normalizeHostAiSelection(input: unknown): HostAiSelection {
  const value = input && typeof input === 'object' ? input as Partial<HostAiSelection> : {}
  return {
    providerId: typeof value.providerId === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value.providerId) ? value.providerId : null,
    modelId: typeof value.modelId === 'string' && value.modelId.trim().length > 0 && value.modelId.trim().length <= 96 ? value.modelId.trim() : null,
    effort: HOST_AI_EFFORTS.includes(value.effort as HostAiEffort) ? value.effort as HostAiEffort : null
  }
}

export interface HostAiControl {
  prompts: PromptControl
  getOptions(): Promise<HostAiOptions>
  getSelection(): Promise<HostAiSelection>
  setSelection(selection: HostAiSelection): Promise<HostAiSelection>
  onSelectionChanged(listener: (selection: HostAiSelection) => void): () => void
}
