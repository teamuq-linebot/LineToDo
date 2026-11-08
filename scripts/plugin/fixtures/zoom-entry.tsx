// Test-only entry (bundled by scripts/plugin/test-plugin-zoom.mjs): the REAL PresentationToggle mounted with react-dom/client into mini-dom, and the REAL App header
// server-rendered (no effects) with / without a host `presentation` API.
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import App from '../../../src/renderer/App'
import { LineTodoApiProvider } from '../../../src/renderer/platform/LineTodoApi'
import { PLUGIN_CAPABILITIES, STANDALONE_CAPABILITIES } from '../../../src/renderer/platform/capabilities'
import type { Api } from '../../../src/shared/api'
import { PresentationToggle, PRESENTATION_ERROR_TEXT } from '../../../src/renderer/components/PresentationToggle'
import { OverflowMenu } from '../../../src/renderer/components/Board/TodoCard'

export { PRESENTATION_ERROR_TEXT }

export function mount(element: ReactElement): { container: HTMLElement; unmount(): void } {
  const container = document.createElement('div')
  const root = createRoot(container)
  root.render(element)
  return { container, unmount: () => root.unmount() }
}

export const toggleScene = (): ReactElement => <PresentationToggle />

export const overflowMenuScene = (): ReactElement => <OverflowMenu><button type="button">x</button></OverflowMenu>

export function renderHeader(plugin: boolean): string {
  const never = (): Promise<never> => new Promise(() => undefined)
  const noop = (): (() => void) => () => undefined
  const api = { ping: never, db: { chats: { list: never }, todos: {}, onMessagesPersisted: noop }, pipeline: { onRun: noop, onTodosChanged: noop } } as unknown as Api
  return renderToStaticMarkup(<LineTodoApiProvider api={api} capabilities={plugin ? PLUGIN_CAPABILITIES : STANDALONE_CAPABILITIES}><App /></LineTodoApiProvider>)
}
