import type { Api } from '../shared/api'
import App from './App'
import { LineTodoApiProvider } from './platform/LineTodoApi'
import type { HostCapabilities } from './platform/capabilities'
import { NO_UI_STATE, UiStateProvider, type UiStateStore } from './lib/uiState'

/**
 * Shared renderer root. The host owns API selection and injects its implementation (and, optionally, what it cannot do).
 * `uiState`: where UI state is saved and restored (G-04). The plugin view passes its localStorage store; standalone passes nothing (not saved, as before).
 */
export function RendererRoot({ api, capabilities, uiState }: { api: Api; capabilities?: HostCapabilities; uiState?: UiStateStore }): JSX.Element {
  return (
    <LineTodoApiProvider api={api} capabilities={capabilities}>
      <UiStateProvider value={uiState ?? NO_UI_STATE}>
        <App />
      </UiStateProvider>
    </LineTodoApiProvider>
  )
}
