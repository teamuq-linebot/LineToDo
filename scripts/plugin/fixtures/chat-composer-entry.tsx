// Test-only entry (bundled by scripts/plugin/test-chat-composer-ui.mjs): the REAL production MessageStream (and so the real ChatComposer)
// mounted with the REAL react-dom/client into ./mini-dom.mjs, behind the REAL plugin adapter (createPluginLineTodoApi). The host is whatever the
// test passes in (the Core gate stand-in in front of a backend). Kept separate from ui-effects-entry.tsx so that file is not touched.
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Api } from '../../../src/shared/api'
import { LineTodoApiProvider } from '../../../src/renderer/platform/LineTodoApi'
import { PLUGIN_CAPABILITIES } from '../../../src/renderer/platform/capabilities'
import { MessageStream } from '../../../src/renderer/components/MessageStream'
import App from '../../../src/renderer/App'
import { UiStateProvider, createLocalUiState } from '../../../src/renderer/lib/uiState'
import { createPluginLineTodoApi } from '../../../src/renderer/platform/pluginApi'
import { BACKEND_METHOD_GROUPS } from '../../../src/shared/pluginWire'
import { LineJsMediaPanel } from '../../../src/plugin/ui/LineJsMediaPanel'

export { BACKEND_METHOD_GROUPS, createPluginLineTodoApi }

/** The REAL settings-page LINE panel (settings.tsx mounts it with `boot.api.plugin`): the same linejsMedia.status the chat dialog reads. */
export function linejsMediaPanelScene(plugin: { invoke(path: string, args?: readonly unknown[]): Promise<unknown> }): ReactElement {
  return <LineJsMediaPanel plugin={plugin} />
}

export function mount(element: ReactElement): { container: HTMLElement; unmount(): void } {
  const container = document.createElement('div')
  const root = createRoot(container)
  root.render(element)
  return { container, unmount: () => root.unmount() }
}

/** MessageStream wired the way the Pro App wires it: no onPurchase (Pro shows no purchase prompts). */
export function messageStreamScene(api: Api): ReactElement {
  return <LineTodoApiProvider api={api} capabilities={PLUGIN_CAPABILITIES}><MessageStream /></LineTodoApiProvider>
}

/** The REAL Pro App (tabs, chat, settings) — used to check that no purchase tab or purchase prompt is reachable. */
export function appScene(api: Api, storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): ReactElement {
  const app = <App />
  return (
    <LineTodoApiProvider api={api} capabilities={PLUGIN_CAPABILITIES}>
      {storage ? <UiStateProvider value={createLocalUiState(storage)}>{app}</UiStateProvider> : app}
    </LineTodoApiProvider>
  )
}
