/**
 * qwenClient.ts — 外掛 backend bundle 專用的 `main/llm/qwenClient.ts` 替身（只在 esbuild 的 resolve plugin 生效）。
 * 真正的版本 import `openai` SDK；外掛 backend 不打 LLM，bundle 不收它。`pipeline.testQwen` 在 dispatcher 就被擋掉，
 * 這兩個函式理論上不會被呼叫；被呼叫就是 bug，所以明確失敗。
 */
export function makeQwen(): never {
  throw new Error('qwen client is not available in the plugin backend')
}

export async function listModels(): Promise<{ ok: boolean; models?: string[]; error?: string }> {
  return { ok: false, error: 'unsupported_in_plugin' }
}
