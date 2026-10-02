// Test-only entry (bundled by scripts/plugin/test-plugin-ui-effects.mjs): mounts the REAL shared components with the REAL react-dom/client into the
// minimal DOM of ./mini-dom.mjs, so their effects, state updates and catch blocks actually run — unlike ui-render-entry.tsx (a server render runs
// none of them). Covers what the tester found untested in G-02 (the catch wiring of SettingsPanel / useTodos / NotMineReviewPanel) and review N1 / N2.
// The api is the REAL plugin adapter (createPluginLineTodoApi) in front of a host the test provides (the Core 1.7.1 gate stand-in).
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Api } from '../../../src/shared/api'
import type { TodoDTO } from '../../../src/renderer/types/api'
import { LineTodoApiProvider } from '../../../src/renderer/platform/LineTodoApi'
import { PLUGIN_CAPABILITIES } from '../../../src/renderer/platform/capabilities'
import { SettingsPanel } from '../../../src/renderer/components/Settings/SettingsPanel'
import { useTodos } from '../../../src/renderer/store/useTodos'
import { NotMineReviewPanel } from '../../../src/renderer/components/Board/NotMineReviewPanel'
import { ReviewControls } from '../../../src/renderer/components/Board/KanbanBoard'
import { DraftReplyDialog } from '../../../src/renderer/components/DraftReplyDialog'
import { UiStateProvider, createLocalUiState } from '../../../src/renderer/lib/uiState'
import { createPluginLineTodoApi } from '../../../src/renderer/platform/pluginApi'
import { BACKEND_METHOD_GROUPS } from '../../../src/shared/pluginWire'

export { BACKEND_METHOD_GROUPS, createPluginLineTodoApi }

export function mount(element: ReactElement): { container: HTMLElement; unmount(): void } {
  const container = document.createElement('div')
  const root = createRoot(container)
  root.render(element)
  return { container, unmount: () => root.unmount() }
}

function Host({ api, children }: { api: Api; children: ReactElement }): JSX.Element {
  return <LineTodoApiProvider api={api} capabilities={PLUGIN_CAPABILITIES}>{children}</LineTodoApiProvider>
}

/** the plugin's settings view (src/plugin/ui/settings.tsx without the status bar / theme follower) */
export function settingsScene(api: Api): ReactElement {
  return <Host api={api}><SettingsPanel /></Host>
}

/** what the board reads from useTodos: the error line, the number of todos and the 重試 of the error row */
function TodosProbe(): JSX.Element {
  const t = useTodos()
  return (
    <div>
      <div data-testid="todos-error">{t.error ?? ''}</div>
      <div data-testid="todos-count">{String(t.todos.length)}</div>
      <button type="button" data-testid="todos-retry" onClick={() => void t.retry()}>重試</button>
    </div>
  )
}

export function todosScene(api: Api): ReactElement {
  return <Host api={api}><TodosProbe /></Host>
}

export function notMineScene(api: Api): ReactElement {
  return <NotMineReviewPanel api={api} onClose={() => undefined} onChanged={() => undefined} />
}

export function reviewControlsScene(api: Api, props: { onRefresh: () => Promise<boolean>; pollDelayMs: (failures: number) => number }): ReactElement {
  return <Host api={api}><ReviewControls api={api} onRefresh={props.onRefresh} onShowNotMine={() => undefined} pollDelayMs={props.pollDelayMs} /></Host>
}

export function draftDialogScene(api: Api, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, todo: TodoDTO, onClose: () => void): ReactElement {
  return (
    <Host api={api}>
      <UiStateProvider value={createLocalUiState(storage)}>
        <DraftReplyDialog todo={todo} chatName="測試聊天" onClose={onClose} />
      </UiStateProvider>
    </Host>
  )
}
