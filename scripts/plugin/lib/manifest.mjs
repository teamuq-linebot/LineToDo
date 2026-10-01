// The line-todo plugin manifest (TeamUQ 1.6.8 Manifest V2, composed full-trust plugin: sandboxed view + its own backend) and the file layout it describes.
// Pure data + one builder, shared by build-plugin.mjs and the packaging tests.
export const PLUGIN_ID = 'tuqdev.line-todo'
export const PLUGIN_NAME = 'LINE 待辦看板'
export const PUBLISHER = 'tuqdev'
export const PLATFORM_ID = 'win32-x64'
export const ICON_PATH = 'ui/icon.png'

/** Native files, in the order they are listed in `native.files`. Both live next to the backend bundle (backend/index.mjs finds them by `import.meta.url`). */
export const NATIVE_FILES = Object.freeze([
  { path: `backend/native/${PLATFORM_ID}/koffi.node`, platform: PLATFORM_ID },
  { path: `backend/native/${PLATFORM_ID}/better_sqlite3.node`, platform: PLATFORM_ID },
])

/**
 * Exactly what the plugin uses, nothing else (design v2 §6.1 listed three more: storage:plugin-data, settings:plugin, secrets:plugin; Phase 2-4 never call
 * window.tuqPlugin.storage / settings / secrets, the backend writes its own dataDir through Node fs, and the settings VIEW needs only ui:view):
 *   ui:view            the board view and the settings view (presentations tab / fullpage / settings)
 *   backend:invoke     view -> backend `api.invoke`
 *   native:addons      koffi.node + better_sqlite3.node (with native.allowAddons)
 *   ai:chat            the UI-side extraction / reply drafting through TeamUQ's built-in Codex (window.tuqPlugin.ai)
 *   assets:plugin-data decrypted media from dataDir/media-cache via window.tuqPlugin.assets.url
 */
export const PERMISSIONS = Object.freeze(['ui:view', 'backend:invoke', 'native:addons', 'ai:chat', 'assets:plugin-data'])

/** The one dispatcher method (LineTodoApi has far more than the 32 backendMethods allowed; the backend routes `{ path, args }` itself). */
export const BACKEND_METHODS = Object.freeze(['api.invoke'])

/**
 * resources: memoryMB 1024 and maxSessions 4 are the 1.6.8 Core limits (BACKEND_RESOURCE_CORE_LIMITS). 1024 is the WASM LINE-DB peak (design v2 §5.3);
 * maxSessions is the host's in-flight call cap (backendController.ts:395) and the event long poll holds one of them.
 */
export const RESOURCES = Object.freeze({ memoryMB: 1024, cpuThreads: 2, maxSessions: 4, idleUnloadSec: 300, bootTimeoutSec: 30 })

export const DESCRIPTION =
  '把 LINE 桌面版的新訊息整理成待辦看板。完全信任級外掛：會讀取 LINE 的本機資料與執行中 LINE.exe 的記憶體來取得解密金鑰，並在本機保存解密後的訊息與圖片。' +
  '整理待辦時，訊息內容會交給 TeamUQ 內建的 Codex（看板開著才會整理，每分鐘有輪數限制）。外掛版不提供「填入 LINE」，也不支援 CLI provider 與自訂 AI 端點。'

export function buildManifest({ baseManifest, version }) {
  return baseManifest({
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    version,
    publisher: PUBLISHER,
    description: DESCRIPTION,
    icon: ICON_PATH,
    minCoreVersion: '>=1.6.8',
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
        { id: 'settings', title: 'LINE 待辦設定', entry: 'ui/settings.html', presentations: ['settings'], defaultPresentation: 'settings' },
      ],
    },
    // The decrypted media cache and the plugin's own database live in the plugin's data folder: removing the plugin removes them (design decision; 1.6.8 supports 'delete').
    data: { uninstall: 'delete' },
  })
}
