import { createContext, useContext, type PropsWithChildren } from 'react'
import type { Api } from '../../shared/api'
import { STANDALONE_CAPABILITIES, type HostCapabilities } from './capabilities'

const LineTodoApiContext = createContext<Api | null>(null)
const HostCapabilitiesContext = createContext<HostCapabilities>(STANDALONE_CAPABILITIES)

export function LineTodoApiProvider({
  api,
  capabilities = STANDALONE_CAPABILITIES,
  children
}: PropsWithChildren<{ api: Api; capabilities?: HostCapabilities }>): JSX.Element {
  return (
    <LineTodoApiContext.Provider value={api}>
      <HostCapabilitiesContext.Provider value={capabilities}>{children}</HostCapabilitiesContext.Provider>
    </LineTodoApiContext.Provider>
  )
}

export function useLineTodoApi(): Api {
  const api = useContext(LineTodoApiContext)
  if (!api) throw new Error('LineTodoApiProvider is missing')
  return api
}

/** 宿主能力（standalone 預設全開；外掛版由 `pluginApi.ts` 的 PLUGIN_CAPABILITIES 關掉做不到的功能）。 */
export function useHostCapabilities(): HostCapabilities {
  return useContext(HostCapabilitiesContext)
}
