/**
 * host.ts — 外掛 view 的啟動共用：取得 `window.tuqPlugin`、建立 `LineTodoApi` adapter、卸載時停止事件輪詢。
 *
 * `window.tuqPlugin` 由 TeamUQ 的 view preload（`pluginViewBridge.ts:129`）注入；不在 TeamUQ 裡開啟（例如直接用瀏覽器開檔案）時不存在，
 * 這時顯示說明而不是白畫面。這裡**不**碰 `window.api`（standalone 的 preload），也不發任何網路請求。
 */
import { createPluginLineTodoApi, PLUGIN_CAPABILITIES } from '../../renderer/platform/pluginApi'
import type { PluginLineTodoApi, TuqPluginHost } from '../../renderer/platform/pluginApi'

declare global {
  interface Window {
    /** TeamUQ 1.6.8 view bridge（只列本外掛用到的部分）。 */
    tuqPlugin?: TuqPluginHost
  }
}

export { PLUGIN_CAPABILITIES }

export function bootPluginApi(): PluginLineTodoApi | null {
  const host = window.tuqPlugin
  if (!host || !host.backend || typeof host.backend.call !== 'function') return null
  const api = createPluginLineTodoApi({ host })
  // view 被關閉／重新載入：停止事件長輪詢並關掉 backend 的 session（backend 也會在閒置後自己回收）。
  window.addEventListener('pagehide', () => api.dispose(), { once: true })
  return api
}

export function renderNotInHost(root: HTMLElement): void {
  root.textContent = '這個頁面要在 TeamUQ 內開啟（設定 → 外掛 → line-todo）。找不到 TeamUQ 提供的外掛橋接（window.tuqPlugin）。'
  root.style.padding = '24px'
}
