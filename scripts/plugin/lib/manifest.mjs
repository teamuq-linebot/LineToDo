// The line-todo plugin manifest (TeamUQ Manifest V2, composed full-trust plugin: sandboxed views + its own backend) and the file layout it describes.
// Pure data + one builder, shared by build-plugin.mjs and the packaging tests. The official author tool validates it (`tuq-plugin-tool validate`).
import { BACKEND_METHOD_GROUPS } from '../../../src/shared/pluginWire.ts'

export const PLUGIN_ID = 'tuqdev.line-todo'
export const PLUGIN_NAME = 'LINE 待辦看板'
export const PUBLISHER = 'tuqdev'
export const PLATFORM_ID = 'win32-x64'
export const ICON_PATH = 'ui/icon.png'

/**
 * minCoreVersion `>=1.7.1` (G-08): the package is UNSIGNED (`pack --unsigned`, G-09). TeamUQ 1.6.8 and 1.7.0 refuse a package without
 * signature.json (`signature_missing`, reviewArtifact.ts @ b8b96cb3:156), so `>=1.6.8` would promise an install that cannot happen; 1.7.1 is the
 * Core this package is validated and packed for (the vendored tool is built from teamuq-electron 1.7.1). Nothing else in the plugin needs more than 1.6.8.
 * Caveat (see the evidence): the commit tagged "release v1.7.1" (6f13f5cb7) still predates unsigned install support (68dc064c9); a Core built from
 * that exact commit refuses this package with signature_missing even though its version number satisfies the range.
 */
export const MIN_CORE_VERSION = '>=1.7.1'

/**
 * minCoreVersion of the DEVELOPMENT-KEY-SIGNED variant (build-plugin-devsigned.mjs), the only manifest field it changes: that variant carries
 * signature.json, so TeamUQ 1.6.8 can review it, and it exists for the machines that run 0.1.1 (`>=1.6.8`) on 1.6.8. The plugin uses nothing
 * that 1.6.8 lacks (see the devsigned evidence: same invoke gate, same ai:chat, same view bridge).
 */
export const DEV_SIGNED_MIN_CORE_VERSION = '>=1.6.8'

/** Native files, in the order they are listed in `native.files`. Both live next to the backend bundle (backend/index.mjs finds them by `import.meta.url`). */
export const NATIVE_FILES = Object.freeze([
  { path: `backend/native/${PLATFORM_ID}/koffi.node`, platform: PLATFORM_ID },
  { path: `backend/native/${PLATFORM_ID}/better_sqlite3.node`, platform: PLATFORM_ID },
])

/**
 * Exactly what the plugin uses, nothing else (design v2 §6.1 listed three more: storage:plugin-data, settings:plugin, secrets:plugin; the plugin never calls
 * window.tuqPlugin.storage / settings / secrets, the backend writes its own dataDir through Node fs, the settings VIEW needs only ui:view, and the backend
 * reads nothing from context.settings (G-06); UI state is kept in the view's own localStorage (G-04), which needs no permission):
 *   ui:view            the board view and the settings view (presentations tab / fullpage / settings)
 *   backend:invoke     view -> backend, one method per API namespace (BACKEND_METHODS)
 *   native:addons      koffi.node + better_sqlite3.node (with native.allowAddons)
 *   ai:chat            the UI-side extraction / reply drafting through TeamUQ's built-in Codex (window.tuqPlugin.ai)
 *   assets:plugin-data decrypted media from dataDir/media-cache via window.tuqPlugin.assets.url
 */
export const PERMISSIONS = Object.freeze(['ui:view', 'backend:invoke', 'native:addons', 'ai:chat', 'assets:plugin-data'])

/**
 * The backend method allow-list (G-07): one method per API namespace (src/shared/pluginWire.ts BACKEND_METHOD_GROUPS — db.todos, pipeline, events, …),
 * at most 32. The view calls `backend.call(<group>, { path, args })` and the backend refuses a path sent under another group, so TeamUQ's allow-list
 * really limits what reaches the backend (`driver`, for example, is not declared and is refused by Core with backend_method_not_allowed).
 */
export const BACKEND_METHODS = Object.freeze([...BACKEND_METHOD_GROUPS])

/**
 * resources: memoryMB 1024 and maxSessions 4 are the Core limits (BACKEND_RESOURCE_CORE_LIMITS). 1024 is the WASM LINE-DB peak (design v2 §5.3);
 * maxSessions is the host's in-flight call cap (backendController.ts) and the event long poll holds one of them.
 */
export const RESOURCES = Object.freeze({ memoryMB: 1024, cpuThreads: 2, maxSessions: 4, idleUnloadSec: 300, bootTimeoutSec: 30 })

export const DESCRIPTION =
  '把 LINE 桌面版的新訊息整理成待辦看板。完全信任級外掛：會讀取 LINE 的本機資料與執行中 LINE.exe 的記憶體來取得解密金鑰，並在本機保存解密後的訊息與圖片。' +
  '整理待辦時，訊息內容會交給 TeamUQ 內建的 Codex（看板開著才會整理，每分鐘有輪數限制）。外掛版不提供「填入 LINE」，也不支援 CLI provider 與自訂 AI 端點。'

export function buildManifest({ version }) {
  return {
    schemaVersion: 2,
    kind: 'plugin',
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    version,
    publisher: PUBLISHER,
    description: DESCRIPTION,
    icon: ICON_PATH,
    pluginApi: '^2.0.0',
    minCoreVersion: MIN_CORE_VERSION,
    platforms: [{ id: PLATFORM_ID }],
    trustTier: 'full-trust',
    entry: { ui: 'ui/index.html', backend: 'backend/index.mjs' },
    backendMethods: [...BACKEND_METHODS],
    native: { allowAddons: true, files: NATIVE_FILES.map((file) => ({ ...file })) },
    resources: { ...RESOURCES },
    permissions: [...PERMISSIONS],
    contributes: {
      views: [
        { id: 'board', title: 'LINE 待辦', icon: ICON_PATH, entry: 'ui/index.html', presentations: ['tab', 'fullpage'], defaultPresentation: 'tab' },
        // the settings view (not settingsSchema; the two are mutually exclusive — G-06 keeps the view)
        { id: 'settings', title: 'LINE 待辦設定', entry: 'ui/settings.html', presentations: ['settings'], defaultPresentation: 'settings' },
      ],
    },
    // The decrypted media cache and the plugin's own database live in the plugin's data folder: removing the plugin removes them (design decision).
    data: { uninstall: 'delete' },
  }
}
