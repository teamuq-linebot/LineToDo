import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../renderer/styles/index.css'
import { LineTodoApiProvider } from '../../renderer/platform/LineTodoApi'
import { SettingsPanel } from '../../renderer/components/Settings/SettingsPanel'
import { PLUGIN_CAPABILITIES, bootPluginApi, renderNotInHost } from './host'
import { BackendStatusBar } from './BackendStatusBar'
import { ResidencyNotice } from './ResidencyStatus'
import { useTheme } from '../../renderer/lib/theme'
import { UiStateProvider, browserUiState } from '../../renderer/lib/uiState'
import { installZoom } from '../../renderer/lib/zoom'
import { LineJsMediaPanel } from './LineJsMediaPanel'

/** 設定 view 跟隨 TeamUQ 宿主外觀（Electron nativeTheme → prefers-color-scheme）。 */
function ThemeFollower(): null {
  useTheme('system')
  return null
}

// 外掛設定 view 的入口（manifest：contributes.views[settings]，presentations:['settings']；TeamUQ 把它嵌在「設定 → 外掛 → line-todo → 設定」）。
// 與看板 view 是不同的 webContents，所以有自己的 adapter（自己的事件 session，需要時才開）。
// 畫面縮放：與看板 view 共用同一個檔位（localStorage lt-zoom）。
installZoom()

const container = document.getElementById('root')
if (!container) throw new Error('#root not found in settings.html')

// 設定 view 沒有任何 AI 邏輯：prompt 修正與模型清單都是 backend 呼叫（AI 在 backend 執行，遵循 Core 的單一 AI session 限制）。
// 預算：manifest 的 maxSessions 是 4，看板 view 最多用 3（含事件長輪詢），設定 view 只用 1 且不開事件輪詢（畫面在每次動作後自己重讀狀態）→ 合計 4。
const boot = bootPluginApi({ maxConcurrentCalls: 1, events: false })
if (!boot) {
  renderNotInHost(container)
} else {
  createRoot(container).render(
    <StrictMode>
      <LineTodoApiProvider api={boot.api} capabilities={PLUGIN_CAPABILITIES}>
        <ThemeFollower />
        <BackendStatusBar source={boot.api.plugin} />
        <ResidencyNotice source={boot.api.plugin} />
        <UiStateProvider value={browserUiState()}>
        <div className="app-shell">
          <main className="app-main">
            <SettingsPanel />
            <LineJsMediaPanel plugin={boot.api.plugin} />
          </main>
        </div>
        </UiStateProvider>
      </LineTodoApiProvider>
    </StrictMode>
  )
}
