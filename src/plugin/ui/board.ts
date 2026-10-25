/**
 * board.ts — 看板 view 的啟動：只有 adapter（host.ts）。
 *
 * 0.2.0：AI 整理在 backend 經 `context.host.ai.complete` 執行（backend/hostAi.ts、extractWorker.ts），看板不再啟動任何 AI 編排，
 * 也不再使用 TeamUQ 的 view 端 AI 橋接；看板沒開、不可見時照樣整理已收進來的訊息。看板開啟時只做一件事：請 backend 重新探測 TeamUQ 的 AI
 * （授權或登入可能剛在 TeamUQ 那邊處理好），狀態列（AiStatusBar）顯示 backend 回報的 `ai.status`。
 */
import { bootPluginApi } from './host'
import type { PluginHostBoot } from './host'

export type BoardBoot = PluginHostBoot

export function bootBoard(): BoardBoot | null {
  const boot = bootPluginApi()
  if (!boot) return null
  void boot.api.plugin.aiStatus({ refresh: true }).catch(() => undefined)
  return boot
}
