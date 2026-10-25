/**
 * host.ts — 外掛 view 的啟動共用：取得 `window.tuqPlugin`、建立 `LineTodoApi` adapter、卸載時收尾。
 *
 * `window.tuqPlugin` 由 TeamUQ 的 view preload（`pluginViewBridge.ts:129`）注入；不在 TeamUQ 裡開啟（例如直接用瀏覽器開檔案）時不存在，
 * 這時顯示說明而不是白畫面。這裡**不**碰 `window.api`（standalone 的 preload），也不發任何網路請求。
 *
 * 設定 view 共用 adapter；AI（含 prompt 修正）都在 backend 執行，view 只是呼叫 backend。
 */
import { createPluginLineTodoApi, PLUGIN_CAPABILITIES } from '../../renderer/platform/pluginApi'
import type { PluginLineTodoApi, TuqPluginHost } from '../../renderer/platform/pluginApi'
import { NOT_IN_HOST_TEXT } from '../../shared/teamuqPlaces'

/** `window.tuqPlugin` 中本外掛用到的完整形狀（pluginViewBridge.ts：backend、assets）。0.2.0 起不再用 `ai`／`presentation`：AI 在 backend 執行。 */
export type TuqPluginView = TuqPluginHost

export { PLUGIN_CAPABILITIES }

export interface PluginHostBoot {
  api: PluginLineTodoApi
  host: TuqPluginView
}

export interface BootOptions {
  /**
   * 這個 view 的 host 呼叫預算（含事件長輪詢）。看板 3（預設）、設定 1：manifest 的 `maxSessions` 是 4，兩個 view 同時開著剛好用滿。
   */
  maxConcurrentCalls?: number
  /** false＝這個 view 不開事件長輪詢（設定 view）。 */
  events?: boolean
  /** view 被關閉／重新載入時，在關掉 adapter 之前先做的收尾。 */
  beforeDispose?: () => Promise<void> | void
}

export function bootPluginApi(options: BootOptions = {}): PluginHostBoot | null {
  const host = window.tuqPlugin
  if (!host || !host.backend || typeof host.backend.call !== 'function') return null
  const api = createPluginLineTodoApi({
    host,
    ...(options.maxConcurrentCalls !== undefined ? { maxConcurrentCalls: options.maxConcurrentCalls } : {}),
    ...(options.events === false ? { events: { enabled: false } } : {})
  })
  // view 被關閉／重新載入：先收尾（需要 adapter 還活著的事），再停事件長輪詢並關掉 backend 的 session（backend 也會在閒置後自己回收）。
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
  // 0.1.3 r1：不寫「設定 → 外掛 → line-todo」（1.6.8 才有）；看板與設定 view 的位置見 src/shared/teamuqPlaces.ts。
  root.textContent = NOT_IN_HOST_TEXT
  root.style.padding = '24px'
}
