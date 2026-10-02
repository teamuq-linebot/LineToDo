/**
 * teamuqPlaces.ts — 外掛文字裡指名的 TeamUQ 畫面位置與名稱（0.1.3）。看板 view、設定 view 與外掛 backend 共用（純資料，不 import 任何東西）。
 *
 * 只寫 TeamUQ 1.6.8 與 1.7.1 **都有、而且同名**的東西；兩版不同的父層（1.6.8 的「設定」、1.7.1 的「我的 AI」）一律不寫：
 *   - 外掛管理頁：兩版都叫「外掛」。1.6.8 是「設定」裡的分類（`settingsGroupConfig.ts` @ b8b96cb3），1.7.1 是「我的 AI」的分頁（`categoryTabs.ts` @ 550cdce1f）。
 *   - 打開外掛後的分頁：兩版都是「總覽／設定／技術資訊」（`PluginDrawerHost.tsx` TABS）。「設定」分頁顯示本外掛的設定 view（`TechSettingsTabs.tsx` SettingsTab）。
 *   - 「總覽」裡列出權限開關的區塊：兩版都叫「它可以做的事」（`OverviewTab.tsx` AllowSection）；開關標題照 `pluginText.ts` PERMISSION_TEXT。
 *   - 側邊欄的外掛入口：兩版都用 view 的 title 當標籤（`packages/features/plugins/src/ui/pluginTabs.ts` `label: view.title`）。
 * 這些名稱由 `npm run check:core-gate-conformance` 對 teamuq-electron 原始碼核對；句子本身由測試逐字鎖住（scripts/plugin/lib/fenced-text.mjs）。
 */

/** 外掛管理頁（兩版都叫「外掛」，父層不同所以不寫）。 */
export const PLUGIN_PAGE_PLACE = 'TeamUQ 管理外掛的「外掛」頁'
/** 外掛「總覽」裡列出權限開關的區塊標題。 */
export const PERMISSIONS_SECTION_TITLE = '它可以做的事'
/** `ai:chat` 權限開關在 TeamUQ 上的標題（`pluginText.ts` PERMISSION_TEXT["ai:chat"].title，1.6.8 `:112`、1.7.1 `:118`）。 */
export const AI_CHAT_TOGGLE_TITLE = '用你的 AI 對話額度回答你'
/** 打開外掛後顯示本外掛設定 view 的分頁名稱。 */
export const PLUGIN_SETTINGS_TAB_LABEL = '設定'
/** 看板 view 在 TeamUQ 側邊欄的標籤＝manifest `contributes.views[board].title`（scripts/plugin/lib/manifest.mjs；測試核對兩者相同）。 */
export const BOARD_VIEW_TITLE = 'LINE 待辦'

/** 本外掛的設定 view 在 TeamUQ 裡的位置（外掛版的看板沒有「設定」分頁）。 */
export const PLUGIN_SETTINGS_PLACE = `${PLUGIN_PAGE_PLACE}打開這個外掛後的「${PLUGIN_SETTINGS_TAB_LABEL}」分頁`

/** 要使用者重新允許 `ai:chat` 時的做法（看板狀態列與 backend 的錯誤訊息共用）。 */
export const AI_CHAT_ALLOW_STEPS = `請到 ${PLUGIN_PAGE_PLACE}打開這個外掛，在「${PERMISSIONS_SECTION_TITLE}」裡允許「${AI_CHAT_TOGGLE_TITLE}」`

/** 不在 TeamUQ 裡開啟（找不到 `window.tuqPlugin`）時顯示的說明。看板與設定兩個 view 共用。 */
export const NOT_IN_HOST_TEXT = `這個頁面要在 TeamUQ 裡開啟：看板在 TeamUQ 側邊欄的「${BOARD_VIEW_TITLE}」；外掛的選項在 ${PLUGIN_SETTINGS_PLACE}。找不到 TeamUQ 提供的外掛橋接（window.tuqPlugin）。`

/**
 * 「之後可以到設定解除」這句的地點括號。standalone 的看板有「設定」分頁（`settingsTab`），照舊寫「設定頁」；外掛版的設定在 TeamUQ 裡，
 * 寫出兩版都找得到的位置。
 */
export function undoInSettingsHint(boardHasSettingsTab: boolean): string {
  return boardHasSettingsTab ? '（可到設定頁解除）' : `（可到 ${PLUGIN_SETTINGS_PLACE}解除）`
}
