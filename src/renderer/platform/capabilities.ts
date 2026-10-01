/**
 * capabilities.ts — 「這個宿主能做什麼」的描述（純資料，無 React、無 DOM；adapter 與元件共用）。
 *
 * standalone（Electron）全部為 true；TeamUQ 1.6.8 外掛版（見 `pluginApi.ts`）把宿主做不到的功能關掉，UI 隱藏對應入口。
 * 每個 `false` 都對應 backend dispatcher 的 `unsupported_in_plugin` 路徑（`src/plugin/backend/dispatcher.ts` 的 UNSUPPORTED_API_PATHS）
 * 或 `driver` 省略，所以「UI 隱藏」與「API 明確回 unsupported」是同一份事實的兩面（`CAPABILITY_API_PATHS` 列出對應）。
 */
export interface HostCapabilities {
  host: 'standalone' | 'plugin'
  /** 設定頁「AI 判斷引擎」的 provider 卡片（http／Claude CLI／Codex CLI）與其健檢。外掛版 AI 由 TeamUQ 的 ai:chat 提供。 */
  aiProviderSelection: boolean
  /** 自訂 AI 端點（Base URL）。 */
  customAiEndpoint: boolean
  /** API 金鑰欄位（safeStorage）。 */
  apiKey: boolean
  /** 「填入 LINE」（driver_post）設定與按鈕。 */
  driverPost: boolean
  /** 檔案訊息的「開啟／另存」（Electron shell／dialog）。 */
  mediaFileActions: boolean
  /** 設定頁的「開啟資料夾」。 */
  openDataFolder: boolean
  /** 卡片選單的「開原聊天」（LINE deep link）。 */
  openOriginalChat: boolean
  /** 「開機時自動啟動」（Electron login item）。 */
  openAtLogin: boolean
  /** 看板內的「設定」分頁（外掛版設定是另一個 view）。 */
  settingsTab: boolean
  /** 「抽取並發數」：只對 http provider 有意義（外掛版的抽取由 UI 端的 ai:chat 編排）。 */
  extractConcurrency: boolean
}

export const STANDALONE_CAPABILITIES: HostCapabilities = Object.freeze({
  host: 'standalone',
  aiProviderSelection: true,
  customAiEndpoint: true,
  apiKey: true,
  driverPost: true,
  mediaFileActions: true,
  openDataFolder: true,
  openOriginalChat: true,
  openAtLogin: true,
  settingsTab: true,
  extractConcurrency: true
})

export const PLUGIN_CAPABILITIES: HostCapabilities = Object.freeze({
  host: 'plugin',
  aiProviderSelection: false,
  customAiEndpoint: false,
  apiKey: false,
  driverPost: false,
  mediaFileActions: false,
  openDataFolder: false,
  openOriginalChat: false,
  openAtLogin: false,
  settingsTab: false,
  extractConcurrency: false
})

/** 每個外掛版關閉的能力 → 對應的 `LineTodoApi` 路徑（backend 一律回 `unsupported_in_plugin`；`driver` 在外掛版 API 上不存在）。 */
export const CAPABILITY_API_PATHS: Readonly<Partial<Record<keyof HostCapabilities, readonly string[]>>> = Object.freeze({
  aiProviderSelection: ['pipeline.testAiProvider'],
  customAiEndpoint: ['pipeline.testQwen'],
  apiKey: ['settings.setApiKey', 'settings.clearApiKey'],
  driverPost: ['driver'],
  mediaFileActions: ['media.open', 'media.saveAs'],
  openDataFolder: ['app.openDataFolder'],
  openOriginalChat: ['db.chats.openOriginal']
})
