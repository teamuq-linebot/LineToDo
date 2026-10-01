/**
 * host.ts — 外掛 view 的啟動共用：取得 `window.tuqPlugin`、建立 `LineTodoApi` adapter、卸載時收尾。
 *
 * `window.tuqPlugin` 由 TeamUQ 的 view preload（`pluginViewBridge.ts:129`）注入；不在 TeamUQ 裡開啟（例如直接用瀏覽器開檔案）時不存在，
 * 這時顯示說明而不是白畫面。這裡**不**碰 `window.api`（standalone 的 preload），也不發任何網路請求。
 *
 * 這個檔案刻意不 import AI orchestrator：設定 view 也用它，而設定 view 不能啟動 AI（見 board.ts）。
 */
import { createPluginLineTodoApi, PLUGIN_CAPABILITIES } from '../../renderer/platform/pluginApi'
import type { PluginAiConnection, PluginLineTodoApi, TuqPluginHost } from '../../renderer/platform/pluginApi'
import type { AiChatApi, VisibilityEnv } from './aiOrchestrator'

/** `window.tuqPlugin` 中本外掛用到的完整形狀（pluginViewBridge.ts：presentation、ai、backend、assets）。 */
export type TuqPluginView = TuqPluginHost & { ai?: AiChatApi; presentation?: VisibilityEnv['presentation'] }

declare global {
  interface Window {
    /** TeamUQ 1.6.8 view bridge（只列本外掛用到的部分）。 */
    tuqPlugin?: TuqPluginView
  }
}

export { PLUGIN_CAPABILITIES }

export interface PluginHostBoot {
  api: PluginLineTodoApi
  host: TuqPluginView
}

export interface BootOptions {
  /** AI 功能的連線狀態（看板 view 由 orchestrator 提供；設定 view 不給＝「尚未接上」）。 */
  aiConnection?: PluginAiConnection
  /** view 被關閉／重新載入時，在關掉 adapter 之前先做的收尾（例如停止 orchestrator 並把租約還給 backend）。 */
  beforeDispose?: () => Promise<void> | void
}

export function bootPluginApi(options: BootOptions = {}): PluginHostBoot | null {
  const host = window.tuqPlugin
  if (!host || !host.backend || typeof host.backend.call !== 'function') return null
  const api = createPluginLineTodoApi({ host, aiConnection: options.aiConnection })
  // view 被關閉／重新載入：先收尾（orchestrator 把租約還回 backend 需要 adapter 還活著），再停事件長輪詢並關掉 backend 的 session（backend 也會在閒置後自己回收）。
  window.addEventListener('pagehide', () => {
    const finish = (): void => api.dispose()
    if (options.beforeDispose) {
      const safety = setTimeout(finish, 1500)
      void Promise.resolve().then(options.beforeDispose).then(() => { clearTimeout(safety); finish() }, () => { clearTimeout(safety); finish() })
    } else finish()
  }, { once: true })
  return { api, host }
}

export function renderNotInHost(root: HTMLElement): void {
  root.textContent = '這個頁面要在 TeamUQ 內開啟（設定 → 外掛 → line-todo）。找不到 TeamUQ 提供的外掛橋接（window.tuqPlugin）。'
  root.style.padding = '24px'
}
