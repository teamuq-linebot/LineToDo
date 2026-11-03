/**
 * board.ts — 看板 view 的啟動：只有 adapter（host.ts）。
 *
 * 0.2.0：AI 整理在 backend 經 `context.host.ai.complete` 執行（backend/hostAi.ts、extractWorker.ts），看板不再啟動任何 AI 編排，
 * 也不再使用 TeamUQ 的 view 端 AI 橋接；看板沒開、不可見時照樣整理已收進來的訊息。看板開啟時做兩件事：
 *   1. 先送 `ping`：transport 靠它分辨「後端啟動中」（ping 還沒回）與「連線中」（ping 已回、狀態與清單還沒到）。
 *   2. 請 backend 重新探測 TeamUQ 的 AI（授權或登入可能剛在 TeamUQ 那邊處理好）。這個探測會讓 backend 去問 host，可能很慢，所以延後到
 *      第一批 core 資料（`line.status`、`db.chats.list`）載入完成（phase `ready`）或 3 s 後，取先到者；而且走 bulk 通道，不會佔掉 core 的名額。
 */
import { bootPluginApi } from './host'
import type { PluginHostBoot } from './host'

export type BoardBoot = PluginHostBoot

export const AI_STATUS_DEFER_MS = 3000

export interface BootBoardOptions {
  /** AI 狀態重新探測最晚等多久（預設 3 s）。 */
  aiStatusDeferMs?: number
}

export function bootBoard(options: BootBoardOptions = {}): BoardBoot | null {
  const boot = bootPluginApi()
  if (!boot) return null
  const { api } = boot
  void api.ping().catch(() => undefined)
  let fired = false
  let off: () => void = () => undefined
  const timer = setTimeout(() => fire(), options.aiStatusDeferMs ?? AI_STATUS_DEFER_MS)
  function fire(): void {
    if (fired) return
    fired = true
    clearTimeout(timer)
    off()
    void api.plugin.aiStatus({ refresh: true }).catch(() => undefined)
  }
  off = api.plugin.onBackendPhase((phase) => { if (phase === 'ready') fire() })
  if (api.plugin.backendPhase() === 'ready') fire()
  return boot
}
