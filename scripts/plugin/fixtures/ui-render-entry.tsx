// Test-only entry (bundled by scripts/plugin/test-plugin-ui.mjs): server-renders the REAL shared components with a given host capability set,
// so the test can assert which controls the plugin build hides. Effects do not run in a server render, so panels get their data through the
// `initialView` seam and an api whose methods never resolve.
import { renderToStaticMarkup } from 'react-dom/server'
import type { Api, SettingsView } from '../../../src/shared/api'
import { LineTodoApiProvider } from '../../../src/renderer/platform/LineTodoApi'
import type { HostCapabilities } from '../../../src/renderer/platform/capabilities'
import { SettingsPanel } from '../../../src/renderer/components/Settings/SettingsPanel'
import { MediaFileActions, MediaImage } from '../../../src/renderer/components/MediaView'
import App from '../../../src/renderer/App'
import { NO_UI_STATE, UiStateProvider, createLocalUiState } from '../../../src/renderer/lib/uiState'
import { BackendStatusBar } from '../../../src/plugin/ui/BackendStatusBar'

const never = (): Promise<never> => new Promise(() => undefined)

function stubApi(overrides: { assetUrl?: boolean; driver?: boolean } = {}): Api {
  const noop = (): (() => void) => () => undefined
  const api = {
    ping: never,
    messages: { recent: never },
    line: { status: never, setRunning: never, onMessage: noop, onStatus: noop },
    db: {
      messages: { list: never, recentByChat: never, byChatSince: never, count: never },
      chats: { list: never, get: never, setBlocked: never, blockAndClear: never, addIgnoreKeyword: never, removeIgnoreKeyword: never, openOriginal: never },
      todos: {},
      onMessagesPersisted: noop
    },
    pipeline: { status: never, loadStats: never, runOnce: never, reviewLastDays: never, backfillMediaKeys: never, setRunning: never, testQwen: never, testAiProvider: never, onRun: noop, onStatus: noop, onTodosChanged: noop, onBackfillProgress: noop, onReconcileProgress: noop },
    settings: { get: never, update: never, setApiKey: never, clearApiKey: never, hasSafeStorageKey: never },
    app: { openDataFolder: never },
    media: { open: never, saveAs: never, ...(overrides.assetUrl ? { assetUrl: never } : {}) },
    ...(overrides.driver ? { driver: {} } : {})
  }
  return api as unknown as Api
}

export function renderSettings(caps: HostCapabilities, view: SettingsView): string {
  return renderToStaticMarkup(
    <LineTodoApiProvider api={stubApi()} capabilities={caps}>
      <SettingsPanel initialView={view} />
    </LineTodoApiProvider>
  )
}

export function renderApp(caps: HostCapabilities): string {
  return renderToStaticMarkup(
    <LineTodoApiProvider api={stubApi()} capabilities={caps}>
      <App />
    </LineTodoApiProvider>
  )
}

export function renderFileActions(caps: HostCapabilities): string {
  return renderToStaticMarkup(
    <LineTodoApiProvider api={stubApi()} capabilities={caps}>
      <MediaFileActions msgId="i:m1" onError={() => undefined} />
    </LineTodoApiProvider>
  )
}

/** Initial render of an image: with an `assetUrl` host it waits for the URL; without one it is "not downloaded" (the component knows no URL scheme). */
export function renderImage(withAssetUrl: boolean, caps: HostCapabilities): string {
  return renderToStaticMarkup(
    <LineTodoApiProvider api={stubApi({ assetUrl: withAssetUrl })} capabilities={caps}>
      <MediaImage msgId="i:m1" onOpenLightbox={() => undefined} />
    </LineTodoApiProvider>
  )
}

// ───────────── plugin developer guide conformance (G-02 / G-03 / G-04) ─────────────

/** G-02: SettingsPanel with a load error (no settings could be read) or an action error (a write failed). */
export function renderSettingsWith(caps: HostCapabilities, view: SettingsView | undefined, extra: { initialLoadError?: string; initialActionError?: string }): string {
  return renderToStaticMarkup(
    <LineTodoApiProvider api={stubApi()} capabilities={caps}>
      <SettingsPanel initialView={view} {...extra} />
    </LineTodoApiProvider>
  )
}

/** G-04: the whole App with a UI state store that already holds saved values (what a re-created view finds in its localStorage). */
export function renderAppWithState(caps: HostCapabilities, saved: Record<string, unknown> | null): string {
  const data = new Map(Object.entries(saved ?? {}).map(([key, value]) => [`lt-ui:${key}`, JSON.stringify({ v: value, at: Date.now() })]))
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) }, removeItem: (k: string) => { data.delete(k) } }
  return renderToStaticMarkup(
    <LineTodoApiProvider api={stubApi()} capabilities={caps}>
      <UiStateProvider value={saved === null ? NO_UI_STATE : createLocalUiState(storage)}>
        <App />
      </UiStateProvider>
    </LineTodoApiProvider>
  )
}

/** G-03: the backend status line for a given link state. */
export function renderBackendBar(link: { state: 'unknown' | 'ok' | 'revoked' | 'unavailable'; code: string | null }): string {
  return renderToStaticMarkup(<BackendStatusBar source={{ backendLink: () => link, onBackendLink: () => () => undefined }} />)
}
