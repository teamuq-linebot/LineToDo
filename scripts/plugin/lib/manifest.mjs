// The line-todo plugin manifest (TeamUQ Manifest V2, composed full-trust plugin: sandboxed views + its own backend) and the file layout it describes.
// Pure data + one builder, shared by build-plugin.mjs and the packaging tests. The official author tool validates it (`tuq-plugin-tool validate`).
import { BACKEND_METHOD_GROUPS } from '../../../src/shared/pluginWire.ts'

export const PLUGIN_ID = 'tuqdev.line-todo'
export const PLUGIN_NAME = 'LINE 待辦看板'
export const PUBLISHER = 'tuqdev'
export const PLATFORM_ID = 'win32-x64'
export const ICON_PATH = 'ui/icon.png'

/**
 * minCoreVersion `>=1.7.13` (0.2.0): the backend runs the AI itself through `context.host.ai.complete`. `context.host.ai` first appears in Core 1.7.12 and
 * `complete` (one turn, session opened and closed by the host) in 1.7.13 (_devkit docs/plugin-endpoints.md「context.host.ai.complete」; the SDK declarations are
 * pinned to 1.7.15, src/plugin/sdk). A Core older than that has no way to run the AI without the board open, so the install is refused instead of
 * shipping a plugin whose AI silently does nothing. This also covers what `>=1.7.1` was for (G-08): the package is UNSIGNED (`pack --unsigned`, G-09), and
 * TeamUQ 1.6.8 / 1.7.0 refuse a package without signature.json (`signature_missing`, reviewArtifact.ts @ b8b96cb3:156).
 */
export const MIN_CORE_VERSION = '>=1.7.13'

/**
 * minCoreVersion of the DEVELOPMENT-KEY-SIGNED variant (build-plugin-devsigned.mjs), the only manifest field it changes. It used to be `>=1.6.8`
 * (machines that run 0.1.1 on 1.6.8); 0.2.0 needs `host.ai.complete` and so the same Core as the unsigned package. NOTE: that variant's build and verify
 * scripts still review the package with Core 1.6.8's code, which refuses `>=1.7.13` — they are not part of the 0.2.0 gates and would need a 1.7.x review to run again.
 */
export const DEV_SIGNED_MIN_CORE_VERSION = '>=1.7.13'

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
 *   ai:chat            the backend's AI (extraction, reply drafting, analyses, prompt refinement) through TeamUQ's built-in Codex: context.host.ai.complete
 *                      (already declared since 0.1.x for the view-side AI; 0.2.0 adds no permission — the view no longer calls window.tuqPlugin.ai)
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

const DESCRIPTION_HEAD =
  '把 LINE 桌面版的新訊息整理成待辦看板。完全信任級外掛：會讀取 LINE 的本機資料與執行中 LINE.exe 的記憶體來取得解密金鑰，並在本機保存解密後的訊息與圖片。' +
  '整理待辦時，訊息內容會交給 TeamUQ 已登入的 AI；可在設定選擇供應者、模型與推理強度。AI 由外掛背景程式執行，看板不需要開著'
const DESCRIPTION_TAIL =
  '。AI 整理過的對話會記錄在 TeamUQ 的 AI 歷史。外掛版不提供「填入 LINE」，也不直接啟動 CLI provider 或使用自訂 AI 端點。'

export const DESCRIPTION = `${DESCRIPTION_HEAD}（TeamUQ 在外掛閒置一段時間後會停止背景程式，之後開啟看板會補整理；每分鐘與每小時有輪數限制）${DESCRIPTION_TAIL}`

// ── 背景執行（`background:resident`）：預設關閉的建置選項 ──────────────────────────────────────────────────────────────────────────────────────
// TeamUQ Core 還沒發版含此權限的版本，而且 vendored 的 1.7.15 author tool 不認得它（`validate` 會回 `permission_unknown`），所以預設的套件完全不變（權限 5 項、`>=1.7.13`）。
// 開啟選項（`--resident` 加 `--resident-min-core <範圍>`，或環境變數 LINE_TODO_RESIDENT=1 加 LINE_TODO_RESIDENT_MIN_CORE=<範圍>）時，manifest 才多宣告
// `background:resident`、`minCoreVersion` 改成指定的值（含此權限與 `context.residency` 的第一個 Core 版本；沒有預設值，Core 發版後才知道）、描述改成常駐說法。
// 不宣告 `residency` 或 `reason` 欄位（宣告即驗證失敗：Core 設計 D:108、manifestV2.ts:230）；`background:resident` 需要 full-trust 且不能同時有 `provides`（manifestV2.ts:249-252），本外掛兩者皆符合。
export const RESIDENT_PERMISSION = 'background:resident'

/** 範圍格式與 author tool 的 RANGE_PATTERN 相同（`^`／`>=` 加 x.y.z）。 */
const RANGE_PATTERN = /^(?:\^|>=)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/

/** 常駐說法的描述：只換掉「閒置一段時間後會停止」那一段，其餘文字與預設完全相同。 */
export const RESIDENT_DESCRIPTION = `${DESCRIPTION_HEAD}。在 TeamUQ 的「它可以做的事」打開「關閉畫面後繼續在背景執行」後（預設是關閉的），只要 TeamUQ 還開著，背景程式就不會因為閒置而停止，看板沒開也會持續整理新訊息；沒有打開時，TeamUQ 會在外掛閒置一段時間後停止背景程式，之後開啟看板會補整理。每分鐘與每小時有輪數限制${DESCRIPTION_TAIL}`

/**
 * 解析建置選項。`argv` 是 parseArgs 的結果（`resident`、`resident-min-core`），`env` 通常是 process.env。
 * 回 `{ enabled:false }`（預設）或 `{ enabled:true, minCoreVersion }`；開了選項卻沒給（或給了格式不對的）版本範圍就丟錯——不猜 Core 版本。
 */
export function resolveResidentOption({ args = {}, env = {} } = {}) {
  const flag = args.resident
  const fromEnv = env.LINE_TODO_RESIDENT
  const enabled = flag === true || flag === 'true' || flag === '1' || (flag === undefined && (fromEnv === '1' || fromEnv === 'true'))
  if (!enabled) return { enabled: false }
  const minCoreVersion = typeof args['resident-min-core'] === 'string' ? args['resident-min-core'] : env.LINE_TODO_RESIDENT_MIN_CORE
  if (typeof minCoreVersion !== 'string' || !RANGE_PATTERN.test(minCoreVersion)) {
    throw new Error(`the resident build option needs --resident-min-core <range> (or LINE_TODO_RESIDENT_MIN_CORE), e.g. ">=1.8.0": the first TeamUQ Core that has background:resident and context.residency; got ${JSON.stringify(minCoreVersion ?? null)}`)
  }
  return { enabled: true, minCoreVersion }
}

/** The permission list of a build: the five the plugin always uses, plus background:resident only when the resident option is on. */
export function permissionsFor(resident) {
  return resident?.enabled === true ? [...PERMISSIONS, RESIDENT_PERMISSION] : [...PERMISSIONS]
}

export function buildManifest({ version, resident }) {
  const residentOn = resident?.enabled === true
  return {
    schemaVersion: 2,
    kind: 'plugin',
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    version,
    publisher: PUBLISHER,
    description: residentOn ? RESIDENT_DESCRIPTION : DESCRIPTION,
    icon: ICON_PATH,
    pluginApi: '^2.0.0',
    minCoreVersion: residentOn ? resident.minCoreVersion : MIN_CORE_VERSION,
    platforms: [{ id: PLATFORM_ID }],
    trustTier: 'full-trust',
    entry: { ui: 'ui/index.html', backend: 'backend/index.mjs' },
    backendMethods: [...BACKEND_METHODS],
    native: { allowAddons: true, files: NATIVE_FILES.map((file) => ({ ...file })) },
    resources: { ...RESOURCES },
    permissions: permissionsFor(resident),
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
