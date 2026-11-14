// Test-only entry (bundled by scripts/plugin/test-plugin-ui-effects.mjs): mounts the REAL shared components with the REAL react-dom/client into the
// minimal DOM of ./mini-dom.mjs, so their effects, state updates and catch blocks actually run — unlike ui-render-entry.tsx (a server render runs
// none of them). Covers what the tester found untested in G-02 (the catch wiring of SettingsPanel / useTodos / NotMineReviewPanel) and review N1 / N2.
// The api is the REAL plugin adapter (createPluginLineTodoApi) in front of a host the test provides (the Core 1.7.1 gate stand-in).
import { StrictMode, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Api, RawLineMessage } from '../../../src/shared/api'
import type { TodoDTO } from '../../../src/renderer/types/api'
import type { PurchasePackageId } from '../../../src/renderer/components/PurchasePage'
import { LineTodoApiProvider } from '../../../src/renderer/platform/LineTodoApi'
import { PLUGIN_CAPABILITIES } from '../../../src/renderer/platform/capabilities'
import { SettingsPanel } from '../../../src/renderer/components/Settings/SettingsPanel'
import { MessageContent, MessageStream } from '../../../src/renderer/components/MessageStream'
import { MediaImage, MediaVideo, MissingMediaActionContext, mediaIndexingRetry } from '../../../src/renderer/components/MediaView'
import type { MissingMediaActionProvider, MissingMediaSlotInfo } from '../../../src/renderer/components/MediaView'
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
import { OriginalsProvider, type OriginalsProviderProps } from '../../../src/renderer/features/originalDownload/OriginalAction'
import { ORIGINALS_DOWNLOAD_ENABLED, ORIGINALS_TIMING, OriginalsStore } from '../../../src/renderer/features/originalDownload/useOriginals'
// X67: through the namespace, so the bundle still builds against an older useOriginals.ts (red-before-fix runs per test)
import * as originalsModule from '../../../src/renderer/features/originalDownload/useOriginals'

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
/** one video message (ct=2) as the stream shows it; `onPurchase` only when the host is the free version */
export function mediaVideoScene(api: Api, msgId: string, onPurchase?: (packageId: PurchasePackageId, source: HTMLElement) => void): ReactElement {
  return <Host api={api}><MediaVideo msgId={msgId} onPurchase={onPurchase} /></Host>
}
/** one message as the stream renders its content (image, video or file card), with the advanced entry only when `onPurchase` is given */
export function messageContentScene(api: Api, message: RawLineMessage, onPurchase?: (packageId: PurchasePackageId, source: HTMLElement) => void): ReactElement {
  return <Host api={api}><MessageContent m={message} onOpenLightbox={() => undefined} onPurchase={onPurchase} /></Host>
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

/** M4: the given missing-media slot provider (or none, `null` = the free version) around one scene */
export function missingSlotScene(provider: MissingMediaActionProvider | null, element: ReactElement): ReactElement {
  return <MissingMediaActionContext.Provider value={provider}>{element}</MissingMediaActionContext.Provider>
}
/** M4: a test provider; every render is reported (kind, msgId and the retry the slot gets) and shows one button */
export function slotProvider(onRender: (info: MissingMediaSlotInfo) => void): MissingMediaActionProvider {
  return {
    render: (info) => {
      onRender(info)
      return <button type="button" className="m4-slot" data-kind={info.kind}>M4 插槽</button>
    }
  }
}

/**
 * X7: the REAL Pro provider (OriginalsStore + the M4 slot + the login dialog) around messages as the stream renders their content.
 * `options` are the store's test knobs (timers, intervals); `enabled` is the master switch (default ORIGINALS_DOWNLOAD_ENABLED).
 * Each message sits in its own `data-cell` box so a test can read one cell.
 */
export function originalsMessagesScene(api: Api, messages: RawLineMessage[], options?: OriginalsProviderProps['options'], enabled?: boolean): ReactElement {
  return (
    <Host api={api}>
      <OriginalsProvider control={api.linejsMedia!.original!} login={api.linejsMedia} options={options} enabled={enabled}>
        <div>{messages.map((m) => <div key={m.msgId} data-cell={m.msgId}><MessageContent m={m} onOpenLightbox={() => undefined} /></div>)}</div>
      </OriginalsProvider>
    </Host>
  )
}
/** X7: the Pro chat (MessageStream without purchase entries) under the real provider: the header batch bar and the cells share one store */
export function originalsStreamScene(api: Api, options?: OriginalsProviderProps['options']): ReactElement {
  return (
    <Host api={api}>
      <OriginalsProvider control={api.linejsMedia!.original!} login={api.linejsMedia} options={options}>
        <MessageStream />
      </OriginalsProvider>
    </Host>
  )
}
/**
 * X67 (review-x7 StrictMode): the REAL provider + MediaImage cells inside <StrictMode>. Built in development mode by the test, React mounts,
 * unmounts and mounts every effect again; with a host whose cells are missing in the very first commit the slot registers together with
 * the provider (the case where the second registration used to be never asked about).
 */
export function strictOriginalsImagesScene(api: Api, ids: string[], options?: OriginalsProviderProps['options']): ReactElement {
  return (
    <StrictMode>
      <Host api={api}>
        <OriginalsProvider control={api.linejsMedia!.original!} login={api.linejsMedia} options={options}>
          <div>{ids.map((id) => <div key={id} data-cell={id}><MediaImage msgId={id} onOpenLightbox={() => undefined} /></div>)}</div>
        </OriginalsProvider>
      </Host>
    </StrictMode>
  )
}
export { ORIGINALS_DOWNLOAD_ENABLED, ORIGINALS_TIMING, OriginalsStore }
export const ORIGINALS_STORE_LIMITS: { entriesMax: number; recalledMax: number } | undefined = (originalsModule as { ORIGINALS_STORE_LIMITS?: { entriesMax: number; recalledMax: number } }).ORIGINALS_STORE_LIMITS

export function draftDialogScene(api: Api, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, todo: TodoDTO, onClose: () => void): ReactElement {
  return (
    <Host api={api}>
      <UiStateProvider value={createLocalUiState(storage)}>
        <DraftReplyDialog todo={todo} chatName="測試聊天" onClose={onClose} />
      </UiStateProvider>
    </Host>
  )
}
