import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../renderer/styles/index.css'
import { LineTodoApiProvider } from '../../renderer/platform/LineTodoApi'
import { SettingsPanel } from '../../renderer/components/Settings/SettingsPanel'
import { PLUGIN_CAPABILITIES, bootPluginApi, renderNotInHost } from './host'

// 外掛設定 view 的入口（manifest：contributes.views[settings]，presentations:['settings']；TeamUQ 把它嵌在「設定 → 外掛 → line-todo → 設定」）。
// 與看板 view 是不同的 webContents，所以有自己的 adapter（自己的事件 session，需要時才開）。
const container = document.getElementById('root')
if (!container) throw new Error('#root not found in settings.html')

// 設定 view 不啟動 AI orchestrator（1.6.8 每個外掛只有 1 個 ai:chat session，由看板 view 使用；這個檔案也不 import orchestrator，bundle 不含它）。
const boot = bootPluginApi()
if (!boot) {
  renderNotInHost(container)
} else {
  createRoot(container).render(
    <StrictMode>
      <LineTodoApiProvider api={boot.api} capabilities={PLUGIN_CAPABILITIES}>
        <div className="app-shell">
          <main className="app-main">
            <SettingsPanel />
          </main>
        </div>
      </LineTodoApiProvider>
    </StrictMode>
  )
}
