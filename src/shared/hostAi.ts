import type { PluginBackendAiApiV1, PluginBackendAiCompleteInputV1 } from '@teamuq/plugin-sdk'
import type { ChatPromptControl, PromptControl } from './promptSettings'

/** TeamUQ 的 AI 選項（backend 的 `context.host.ai.getOptions()`；設定頁經 backend 的 `ai.options` 取得）。 */
export type HostAiOptions = Awaited<ReturnType<PluginBackendAiApiV1['getOptions']>>
export type HostAiEffort = NonNullable<PluginBackendAiCompleteInputV1['effort']>

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
  /** 逐對話的 prompt／名字覆寫；舊版 backend 或測試替身沒有時缺席，UI 隱藏對應入口。 */
  chatPrompts?: ChatPromptControl
  getOptions(): Promise<HostAiOptions>
  getSelection(): Promise<HostAiSelection>
  setSelection(selection: HostAiSelection): Promise<HostAiSelection>
}
