import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import { RendererRoot } from './RendererRoot'

const container = document.getElementById('root')
if (!container) {
  throw new Error('#root not found in index.html')
}

createRoot(container).render(
  <StrictMode>
    <RendererRoot api={window.api} />
  </StrictMode>
)
