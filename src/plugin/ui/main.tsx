import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../renderer/styles/index.css'
import { RendererRoot } from '../../renderer/RendererRoot'
import { BackendStatusBar } from './BackendStatusBar'
import { ResidencyStatusBar } from './ResidencyStatus'
import { browserUiState } from '../../renderer/lib/uiState'
import { bootBoard } from './board'
import { PLUGIN_CAPABILITIES, renderNotInHost } from './host'

// 外掛看板 view 的入口（manifest：contributes.views[board].entry）。與 standalone 的 src/renderer/main.tsx 共用同一個 RendererRoot；
// 差別只有「API 從哪來」（這裡是 adapter → window.tuqPlugin.backend）與「宿主能做什麼」（PLUGIN_CAPABILITIES：隱藏 driver_post、CLI、自訂端點、saveAs…）。
// AI 整理在 backend（host.ai.complete），看板沒開時照樣整理。
const container = document.getElementById('root')
if (!container) throw new Error('#root not found in index.html')

const boot = bootBoard()
if (!boot) {
  renderNotInHost(container)
} else {
  createRoot(container).render(
    <StrictMode>
      <BackendStatusBar source={boot.api.plugin} />
      <RendererRoot api={boot.api} capabilities={PLUGIN_CAPABILITIES} uiState={browserUiState()} />
      <ResidencyStatusBar source={boot.api.plugin} />
    </StrictMode>
  )
}
