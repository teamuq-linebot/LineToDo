import type { Api } from '../shared/api'
import App from './App'
import { LineTodoApiProvider } from './platform/LineTodoApi'

/** Shared renderer root. The host owns API selection and injects its implementation. */
export function RendererRoot({ api }: { api: Api }): JSX.Element {
  return (
    <LineTodoApiProvider api={api}>
      <App />
    </LineTodoApiProvider>
  )
}
