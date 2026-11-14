import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { LineTodoApiProvider } from '../../../src/renderer/platform/LineTodoApi'
import { PLUGIN_CAPABILITIES } from '../../../src/renderer/platform/capabilities'
import { ChatPromptPanel } from '../../../src/renderer/features/chatPrompt/ChatPromptPanel'
import type { ChatPromptControl, ChatPromptState } from '../../../src/shared/promptSettings'

export function chatPromptScene(api: any, chatId: string): ReactElement {
  const control: ChatPromptControl = {
    get: async (): Promise<ChatPromptState> => ({ promptSource: 'default', effectivePrompt: 'legacy default', overridePrompt: null, overrideName: null, defaultName: null, revision: 'legacy-r1', maxChars: 4000, maxNameChars: 80 }),
    save: async () => { throw new Error('unused') }, reset: async () => { throw new Error('unused') }
  }
  return <LineTodoApiProvider api={api} capabilities={PLUGIN_CAPABILITIES}><ChatPromptPanel chatId={chatId} chatName="合成聊天室" control={control} /></LineTodoApiProvider>
}

export function mount(element: ReactElement): { container: HTMLElement; unmount(): void } {
  const container = document.createElement('div')
  const root = createRoot(container)
  root.render(element)
  return { container, unmount: () => root.unmount() }
}
