import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import { RendererRoot } from './RendererRoot'

const container = document.getElementById('root')
if (!container) {
  throw new Error('#root not found in index.html')
}

// Standalone entry：唯一直接讀 window.api（preload 暴露）的地方；其餘 renderer 一律經 useLineTodoApi()。
createRoot(container).render(
  <StrictMode>
    <RendererRoot api={window.api} />
  </StrictMode>
)
