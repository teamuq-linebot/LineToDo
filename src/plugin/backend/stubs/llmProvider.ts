/**
 * llmProvider.ts — 外掛 backend bundle 專用的 `main/llm/provider/index.ts` 替身（只在 esbuild 的 resolve plugin 生效）。
 *
 * 真正的 provider index 會 import claudeCli／codexCli（子行程）與 httpOpenAi（openai SDK）。外掛 backend 不打 LLM、
 * 不 spawn 任何子行程（1.6.8 的 self-check 會實測 spawn，成功就拒啟），所以 bundle 裡不能出現那些模組。
 * `core/application.ts` 與 `pipeline/runOnce.ts` 只用到下面三個名字；其餘 provider 路徑在 dispatcher 就被擋成
 * `unsupported_in_plugin`。
 */
import type { LlmProvider, ProviderHealth } from '../../../main/llm/provider/types'

export { LlmProviderError } from '../../../main/llm/provider/types'

/** 外掛 backend 沒有 provider（抽取由 UI 端經 ai:chat 完成，結果走 ExtractQueue）。 */
export function resolveProvider(): LlmProvider | null {
  return null
}

export function unconfiguredHealth(): ProviderHealth {
  return {
    ok: false,
    code: 'invalid_config',
    summary: '外掛版的 AI 由 TeamUQ 的 ai:chat 提供，backend 不直接呼叫任何 AI 引擎',
    details: {}
  }
}
