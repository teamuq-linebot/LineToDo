// What the plugin says while TeamUQ Core fences its backend calls (review B1, R1-N1; tester-evidence-r1 §3.2), shared by the test files.
//
// The sentences are locked WORD FOR WORD: a blacklist of "will recover" phrasings let a paraphrase such as 「（重新允許後就會恢復）」 through
// (tester mutation T-B1-b), and Core 1.7.1 does not lift the fence when the permission is allowed again. Any edit to the user-facing sentence has
// to be made here too, on purpose.

/**
 * The title of the backend:invoke switch on TeamUQ's plugin management page (the 「外掛」 page → the plugin →「它可以做的事」; same title in 1.6.8 and 1.7.1):
 * teamuq-electron packages/features/settings/src/ui/views/Settings/sections/pluginPage/pluginText.ts:122, PERMISSION_TEXT["backend:invoke"].title
 * (read-only at V1 063d6dcc9; the file is unchanged since bd984f1a1). `npm run check:core-gate-conformance` re-reads it from the Core source.
 */
export const CORE_BACKEND_INVOKE_TITLE = '讓畫面和它的背景程式溝通'

/** lib/backendError.ts FENCED_TEXT (plugin_permission_denied / plugin_disabled) */
export const EXPECTED_FENCED_TEXT = 'TeamUQ 目前不讓這個外掛呼叫後端，所以讀不到 LINE 與待辦資料。可能的原因：「讓畫面和它的背景程式溝通」權限（backend:invoke）被關閉、外掛被停用，或外掛後端太久沒有回應而被 TeamUQ 隔離。請到 TeamUQ 管理外掛的「外掛」頁打開這個外掛，確認「它可以做的事」裡已允許「讓畫面和它的背景程式溝通」，而且外掛是啟用的；如果之後仍沒有恢復，請把外掛停用再啟用，或重新啟動 TeamUQ。'

/** lib/backendError.ts backend_invoke_timeout */
export const EXPECTED_TIMEOUT_TEXT = '外掛後端太久沒有回應，TeamUQ 已把它停止，並暫停這個外掛的後端呼叫；稍後再試也不會恢復。請到 TeamUQ 管理外掛的「外掛」頁打開這個外掛，把它停用再啟用，或重新啟動 TeamUQ。'

/** plugin/ui/aiOrchestrator.ts describeStatus(paused, backend_revoked) */
export const EXPECTED_AI_FENCED_TEXT = 'TeamUQ 目前不讓這個外掛呼叫後端（「讓畫面和它的背景程式溝通」權限被關閉、外掛被停用，或後端太久沒有回應而被隔離），AI 整理暫停；請到 TeamUQ 管理外掛的「外掛」頁打開這個外掛，確認「它可以做的事」裡已允許「讓畫面和它的背景程式溝通」且外掛是啟用的，仍沒有恢復就把外掛停用再啟用，或重新啟動 TeamUQ'

/**
 * A promise that the plugin comes back by itself / after allowing the permission again, in any of the usual phrasings
 * (自動恢復, 就會恢復, 即可恢復, 會恢復, 重新允許後…繼續 …). Negations (不會恢復, 仍沒有恢復) are not promises.
 */
export const RECOVERY_PROMISE = /自動(恢復|繼續)|(就|即|便|才)(會|能|可|可以)?(自動)?(恢復|繼續)|(?<![不沒])(會|能|可以)(自動)?(恢復|繼續)|重新(允許|打開|開啟)[^；。]{0,12}(恢復|繼續|正常)/u

/** The name the switch had in r1's text, which TeamUQ's settings page does not use (R1-N1). */
export const STALE_PERMISSION_NAME = /「後端呼叫」/u

/**
 * Where the three sentences send the user (0.1.3). TeamUQ moved plugin management between versions: 1.6.8 has it under 「設定」 (settings group
 * "plugins", label 「外掛」: settingsGroupConfig.ts @ b8b96cb3), 1.7.1 under 「我的 AI」 (tab "plugins", label 「外掛」: categoryTabs.ts @ 550cdce1f).
 * The sentences name only what BOTH versions show: the page labelled 「外掛」, and on the plugin's 「總覽」 the section 「它可以做的事」 with the switch
 * (OverviewTab.tsx, identical in both). `npm run check:core-gate-conformance` re-reads both names from the Core source it is pointed at.
 */
export const CORE_PLUGIN_PAGE_LABEL = '外掛'
export const CORE_PERMISSIONS_SECTION_TITLE = '它可以做的事'
/** The place phrase every one of the three sentences uses. */
export const PLUGIN_PAGE_PLACE_TEXT = `TeamUQ 管理外掛的「${CORE_PLUGIN_PAGE_LABEL}」頁打開這個外掛`

/**
 * A place that only one TeamUQ version has: 0.1.2 said 「我的 AI › 外掛」 (1.7.1 only); 「設定 › 外掛」 is 1.6.8 only. The three sentences name
 * neither 「我的 AI」 nor 「設定」 at all — those parents differ by version.
 */
export const VERSION_SPECIFIC_PLACE = /我的\s*AI|設定|›/u
