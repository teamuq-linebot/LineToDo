// The line-todo plugin manifest (TeamUQ Manifest V2, composed full-trust plugin: sandboxed views + its own backend) and the file layout it describes.
// Pure data + one builder, shared by build-plugin.mjs and the packaging tests. The official author tool validates it (`tuq-plugin-tool validate`).
import { BACKEND_METHOD_GROUPS } from '../../../src/shared/pluginWire.ts'

// pro 版的獨立身分（與免費版 tuqdev.line-todo 並存；資料夾、localStorage 分區、tuqplugin:// 都由 host 依此 id 決定）。
export const PLUGIN_ID = 'tuqdev.line-todo.pro'
export const PLUGIN_NAME = 'LINE 待辦 Pro'
export const PUBLISHER = 'tuqdev'
export const PLATFORM_ID = 'win32-x64'
export const ICON_PATH = 'ui/icon.png'

/** 0.2.14 targets the verified TeamUQ 1.8.10 SDK, author tool, session resume and background residency contracts. */
export const MIN_CORE_VERSION = '>=1.8.10'

/**
 * minCoreVersion of the DEVELOPMENT-KEY-SIGNED variant (build-plugin-devsigned.mjs), the only manifest field it changes. It used to be `>=1.6.8`
 * (machines that run 0.1.1 on 1.6.8); 0.2.0 needs `host.ai.complete` and so the same Core as the unsigned package. NOTE: that variant's build and verify
 * scripts still review the package with Core 1.6.8's code, which refuses `>=1.7.13` — they are not part of the 0.2.0 gates and would need a 1.7.x review to run again.
 */
export const DEV_SIGNED_MIN_CORE_VERSION = MIN_CORE_VERSION

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
 *   program:data:projects:write, program:data:tasks:write
 *                      (0.2.1) the backend creates its own Project「LINE 待辦 Pro」(pro edition; the free edition uses「LINE 待辦」) and Task「AI 整理 LINE 訊息」through context.host.program and sends every
 *                      AI turn with that taskId, so TeamUQ files the conversations under a normal Task instead of a throwaway「系統對話」Task (teamuqTask.ts)
 */
export const PERMISSIONS = Object.freeze(['ui:view', 'backend:invoke', 'native:addons', 'ai:chat', 'assets:plugin-data', 'program:data:projects:write', 'program:data:tasks:write'])

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

// X5（implementation-plan-v2.md §2 X5）：媒體保存的說法——需另行 QR 登入；以 LINE 電腦版收到的訊息為準，自動保存新收到與自己傳出的照片、影片、檔案
// （X2b、X3）；依使用者的操作下載舊訊息的原檔（X6、X7）；全部存在本外掛資料夾（data.uninstall: 'delete'）；每小時上限與 LINE 限流自動暫停
// （ORIGINALS_LIMITS）；只讀不改 LINE 本機資料（review-x5 F-5：出站傳送與 QR 新增裝置會改 LINE 帳號端的資料）。兩種說法（預設、常駐）都要 ≤512 字元（test-plugin-package）。
const DESCRIPTION_HEAD =
  '把 LINE 桌面版的新訊息整理成待辦看板。完全信任級外掛：讀取 LINE 的本機資料與執行中 LINE.exe 的記憶體取得解密金鑰（只讀不改 LINE 本機資料），在本機保存解密後的訊息與圖片。' +
  '媒體保存需另行 QR 登入並開啟接收：依 LINE 電腦版收到的訊息，自動保存新收到與自己傳出的照片、影片、檔案，也可依你的操作下載舊訊息的原檔；每小時有上限，遇到 LINE 限流會自動暫停。' +
  '全部存在本外掛資料夾，解除安裝時一併刪除。' +
  '同一連線也可在聊天室手動傳送文字、單張圖片或單一檔案，只在按下傳送時送出。' +
  '整理待辦時，訊息內容會交給 TeamUQ 已登入的 AI；可在設定選擇供應者、模型與推理強度。AI 由外掛背景程式執行，看板不需要開著'
const DESCRIPTION_TAIL =
  '。AI 整理過的對話會記錄在 TeamUQ 的 AI 歷史。不提供「填入 LINE」，也不直接啟動 CLI provider 或使用自訂 AI 端點。'

export const DESCRIPTION = `${DESCRIPTION_HEAD}（TeamUQ 在外掛閒置一段時間後會停止背景程式，之後開啟看板會補整理；每分鐘與每小時有輪數限制）${DESCRIPTION_TAIL}`

// 正式套件與開發連結預設宣告背景執行能力。這不是授權：使用者仍須在 TeamUQ 開啟對應開關，Core 才會給 resident。
// `--resident=false` 或 LINE_TODO_RESIDENT=0 可建置不宣告此能力的套件。manifest 不放 residency / reason；實際狀態由 context.residency 回報。
export const RESIDENT_PERMISSION = 'background:resident'

/** 範圍格式與 author tool 的 RANGE_PATTERN 相同（`^`／`>=` 加 x.y.z）。 */
const RANGE_PATTERN = /^(?:\^|>=)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/

/** 常駐說法的描述：只換掉「閒置一段時間後會停止」那一段，其餘文字與預設完全相同。 */
export const RESIDENT_DESCRIPTION = `${DESCRIPTION_HEAD}。在 TeamUQ 的「它可以做的事」打開「關閉畫面後繼續在背景執行」後（預設是關閉的），TeamUQ 開著時背景程式不因閒置停止，看板沒開也會整理；沒打開時，閒置一段時間後會停止，之後開啟看板會補整理。每分鐘與每小時有輪數限制${DESCRIPTION_TAIL}`

/**
 * 解析建置選項；預設使用已驗證的 1.8.10。保留明確停用與自訂版本範圍，命令列優先於環境變數。
 */
export function resolveResidentOption({ args = {}, env = {} } = {}) {
  const flag = args.resident ?? env.LINE_TODO_RESIDENT ?? true
  if (![true, false, 'true', 'false', '1', '0'].includes(flag)) throw new Error(`invalid resident option: ${JSON.stringify(flag)}`)
  const enabled = flag === true || flag === 'true' || flag === '1'
  if (!enabled) return { enabled: false }
  const minCoreVersion = args['resident-min-core'] ?? env.LINE_TODO_RESIDENT_MIN_CORE ?? MIN_CORE_VERSION
  if (typeof minCoreVersion !== 'string' || !RANGE_PATTERN.test(minCoreVersion)) {
    throw new Error(`invalid --resident-min-core (or LINE_TODO_RESIDENT_MIN_CORE): expected a version range such as ">=1.8.10", got ${JSON.stringify(minCoreVersion)}`)
  }
  return { enabled: true, minCoreVersion }
}

/** The base permissions plus background:resident unless the build explicitly opts out. */
export function permissionsFor(resident = resolveResidentOption({})) {
  return resident?.enabled === true ? [...PERMISSIONS, RESIDENT_PERMISSION] : [...PERMISSIONS]
}

export function buildManifest({ version, resident = resolveResidentOption({}) }) {
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
        { id: 'board', title: 'LINE 待辦 Pro', icon: ICON_PATH, entry: 'ui/index.html', presentations: ['tab', 'fullpage'], defaultPresentation: 'tab', remote: true },
        // the settings view (not settingsSchema; the two are mutually exclusive — G-06 keeps the view)
        { id: 'settings', title: 'LINE 待辦 Pro 設定', entry: 'ui/settings.html', presentations: ['settings'], defaultPresentation: 'settings' },
      ],
    },
    // The decrypted media cache and the plugin's own database live in the plugin's data folder: removing the plugin removes them (design decision).
    data: { uninstall: 'delete' },
  }
}
