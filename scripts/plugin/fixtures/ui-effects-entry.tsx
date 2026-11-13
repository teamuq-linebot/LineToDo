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
import { MessageStream } from '../../../src/renderer/components/MessageStream'
import { MediaImage, mediaIndexingRetry } from '../../../src/renderer/components/MediaView'
import App from '../../../src/renderer/App'
import { useTodos } from '../../../src/renderer/store/useTodos'
import { NotMineReviewPanel } from '../../../src/renderer/components/Board/NotMineReviewPanel'
import { OverviewOps } from '../../../src/renderer/components/Settings/OverviewOps'
import { KanbanBoard } from '../../../src/renderer/components/Board/KanbanBoard'
import { DraftReplyDialog } from '../../../src/renderer/components/DraftReplyDialog'
import { ResidencyNotice, ResidencyStatusBar } from '../../../src/plugin/ui/ResidencyStatus'
import type { ResidencyViewSource } from '../../../src/plugin/ui/ResidencyStatus'
import { PluginRootLayout } from '../../../src/plugin/ui/PluginRootLayout'
import { UiStateProvider, createLocalUiState } from '../../../src/renderer/lib/uiState'
import { createOverviewRefresher } from '../../../src/renderer/features/groupTopics/groupTopicsOverview'
import { GroupTopicsPanel } from '../../../src/renderer/features/groupTopics/GroupTopicsPanel'
import { ChatPromptPanel } from '../../../src/renderer/features/chatPrompt/ChatPromptPanel'
import { ProfileMatrixSettings } from '../../../src/renderer/components/Settings/ProfileMatrixSettings'
import type { ChatPromptControl, ChatPromptState } from '../../../src/shared/promptSettings'
import type { ChatProfilesControl } from '../../../src/shared/hostAi'
import { sharedRead } from '../../../src/renderer/lib/sharedRead'
import { MEDIA_INDEX_BUILDING_TOKEN, createPluginLineTodoApi } from '../../../src/renderer/platform/pluginApi'
import { BACKEND_METHOD_GROUPS } from '../../../src/shared/pluginWire'

export { BACKEND_METHOD_GROUPS, MEDIA_INDEX_BUILDING_TOKEN, createPluginLineTodoApi, createOverviewRefresher, mediaIndexingRetry, sharedRead }

export function groupTopicsScene(api: Api): ReactElement {
  return <Host api={api}><GroupTopicsPanel hideTitle /></Host>
}
export function chatPromptScene(api: Api, chatId: string): ReactElement {
  const control: ChatPromptControl = {
    get: async (): Promise<ChatPromptState> => ({ promptSource: 'default', effectivePrompt: 'legacy default', overridePrompt: null, overrideName: null, defaultName: null, revision: 'legacy-r1', maxChars: 4000, maxNameChars: 80 }),
    save: async () => { throw new Error('unused') }, reset: async () => { throw new Error('unused') }
  }
  return <Host api={api}><ChatPromptPanel chatId={chatId} chatName="合成聊天室" control={control} /></Host>
}
/** The real global profile matrix editor with an isolated synthetic host profile port. */
export function profileMatrixScene(control: ChatProfilesControl): ReactElement {
  return <section className="set-section"><ProfileMatrixSettings control={control} /></section>
}

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
/** one image message as the stream shows it (the real MediaImage with the real retry-while-indexing effect) */
export function mediaImageScene(api: Api, msgId: string): ReactElement {
  return <Host api={api}><MediaImage msgId={msgId} onOpenLightbox={() => undefined} /></Host>
}
export function messageStreamScene(api: Api): ReactElement {
  return <Host api={api}><MessageStream onPurchase={() => undefined} /></Host>
}
/** Actual plugin flow layout with an active residency status row and a synthetic chat stream. */
export function messageWithResidencyScene(api: Api, source: ResidencyViewSource): ReactElement {
  return (
    <PluginRootLayout footer={<ResidencyStatusBar source={source} />}>
      <Host api={api}><MessageStream onPurchase={() => undefined} /></Host>
    </PluginRootLayout>
  )
}
export function settingsDraftScene(api: Api, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): ReactElement {
  return <Host api={api}><UiStateProvider value={createLocalUiState(storage)}><SettingsPanel /></UiStateProvider></Host>
}

/** The real plugin App and shared settings panel, mounted together for tab interaction evidence. */
export function appScene(api: Api): ReactElement {
  return <Host api={api}><App /></Host>
}
export function appSceneWithState(api: Api, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): ReactElement {
  return <Host api={api}><UiStateProvider value={createLocalUiState(storage)}><App /></UiStateProvider></Host>
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

/** the settings tab's 整理 block (Settings/OverviewOps) on its own, with a poll delay the test controls */
export function opsScene(api: Api, props: { pollDelayMs?: (failures: number) => number } = {}): ReactElement {
  return <Host api={api}><OverviewOps pollDelayMs={props.pollDelayMs} /></Host>
}

/** the overview's board on its own (filter row + four columns) */
export function boardScene(api: Api): ReactElement {
  return <Host api={api}><KanbanBoard /></Host>
}

/** the board's one-line background-execution status (src/plugin/ui/ResidencyStatus.tsx) over a source the test controls */
export function residencyBarScene(source: ResidencyViewSource): ReactElement {
  return <ResidencyStatusBar source={source} />
}

/** the settings view's background-execution notice */
export function residencyNoticeScene(source: ResidencyViewSource): ReactElement {
  return <ResidencyNotice source={source} />
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
