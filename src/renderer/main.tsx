import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import { RendererRoot } from './RendererRoot'

const container = document.getElementById('root')
if (!container) {
  throw new Error('#root not found in index.html')
}

// Standalone entry：唯一直接讀 window.api（preload 暴露）的地方；其餘 renderer 一律經 useLineTodoApi()。
// 圖片網址由宿主提供（元件不知道 URL scheme）：standalone 走 main 的 linemedia:// 特權協定（main/media/protocol.ts，bytes 只在 main）。
const api = {
  ...window.api,
  media: {
    ...window.api.media,
    assetUrl: async (msgId: string): Promise<string | null> => `linemedia://media/${encodeURIComponent(msgId)}`
  }
}
createRoot(container).render(
  <StrictMode>
    <RendererRoot api={api} />
  </StrictMode>
)
