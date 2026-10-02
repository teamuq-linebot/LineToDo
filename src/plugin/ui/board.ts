/**
 * board.ts — 看板 view 的啟動：adapter（host.ts）＋ AI orchestrator（aiOrchestrator.ts）。
 *
 * AI orchestrator 只在看板 view 啟動：1.6.8 對每個外掛只允許 1 個 ai:chat session，設定 view 是另一個 webContents，不能再開一個去搶；
 * 看板不在前景時 orchestrator 暫停（host 也只在 view 可見時讓 ai:chat 運作）。
 * pluginApi 的 `aiConnection` 指向 orchestrator 的即時狀態：連上時 `reviewLastDays`、草擬回覆、誤判分析、群組議題分析才會送去 backend，
 * 沒連上（Codex 未登入、授權被關、TeamUQ 沒有 ai:chat）就立刻回明確的原因，不空等。
 */
import { createAiOrchestrator, createVisibilitySource } from './aiOrchestrator'
import type { AiOrchestrator } from './aiOrchestrator'
import { bootPluginApi } from './host'
import type { PluginHostBoot } from './host'

export interface BoardBoot extends PluginHostBoot {
  /** TeamUQ 提供 `ai:chat` 時才有。 */
  orchestrator: AiOrchestrator | null
}

const AI_UNSUPPORTED_NOTE = 'unsupported_in_plugin: 這個 TeamUQ 版本沒有提供 ai:chat'

export function bootBoard(): BoardBoot | null {
  let orchestrator: AiOrchestrator | null = null
  let visibility: ReturnType<typeof createVisibilitySource> | null = null
  const hostAi = window.tuqPlugin?.ai
  const boot = bootPluginApi({
    aiConnection: { connected: () => orchestrator?.connected() ?? false, note: () => (hostAi ? orchestrator?.note() : AI_UNSUPPORTED_NOTE) },
    beforeDispose: async () => { try { await orchestrator?.stop() } finally { visibility?.dispose?.() } }
  })
  if (!boot) return null
  if (boot.host.ai) {
    visibility = createVisibilitySource({ document, presentation: boot.host.presentation })
    orchestrator = createAiOrchestrator({ ai: boot.host.ai, extract: boot.api.plugin.extract, tasks: boot.api.plugin.aiTasks, visibility })
    // 排程：backend 依設定的 pollIntervalSec 供料並發 extract-pending 事件，orchestrator 由事件驅動（另有 15 秒的備援輪詢）。
    orchestrator.start()
  }
  return { ...boot, orchestrator }
}
