import { createContext, useContext, type PropsWithChildren } from 'react'
import type { Api } from '../../shared/api'

const LineTodoApiContext = createContext<Api | null>(null)

export function LineTodoApiProvider({
  api,
  children
}: PropsWithChildren<{ api: Api }>): JSX.Element {
  return <LineTodoApiContext.Provider value={api}>{children}</LineTodoApiContext.Provider>
}

export function useLineTodoApi(): Api {
  const api = useContext(LineTodoApiContext)
  if (!api) throw new Error('LineTodoApiProvider is missing')
  return api
}
