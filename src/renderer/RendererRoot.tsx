import type { Api } from '../shared/api'
import App from './App'
import { LineTodoApiProvider } from './platform/LineTodoApi'
import type { HostCapabilities } from './platform/capabilities'

/** Shared renderer root. The host owns API selection and injects its implementation (and, optionally, what it cannot do). */
export function RendererRoot({ api, capabilities }: { api: Api; capabilities?: HostCapabilities }): JSX.Element {
  return (
    <LineTodoApiProvider api={api} capabilities={capabilities}>
      <App />
    </LineTodoApiProvider>
  )
}
