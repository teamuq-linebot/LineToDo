import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../renderer/styles/index.css'
import { RendererRoot } from '../../renderer/RendererRoot'
import { AiStatusBar } from './AiStatusBar'
import { bootBoard } from './board'
import { PLUGIN_CAPABILITIES, renderNotInHost } from './host'

// 外掛看板 view 的入口（manifest：contributes.views[board].entry）。與 standalone 的 src/renderer/main.tsx 共用同一個 RendererRoot；
// 差別只有「API 從哪來」（這裡是 adapter → window.tuqPlugin.backend）與「宿主能做什麼」（PLUGIN_CAPABILITIES：隱藏 driver_post、CLI、自訂端點、saveAs…）。
// 看板 view 也是唯一啟動 AI orchestrator 的地方（ai:chat 只在 view 端可用，且每個外掛同時只能有 1 個 session）。
const container = document.getElementById('root')
if (!container) throw new Error('#root not found in index.html')

const boot = bootBoard()
if (!boot) {
  renderNotInHost(container)
} else {
  createRoot(container).render(
    <StrictMode>
      <RendererRoot api={boot.api} capabilities={PLUGIN_CAPABILITIES} />
      <AiStatusBar orchestrator={boot.orchestrator} />
    </StrictMode>
  )
}
