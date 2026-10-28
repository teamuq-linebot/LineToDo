// What the plugin says while TeamUQ Core rejects/fences its backend calls, shared by the test files.
//
// The sentences are locked WORD FOR WORD: a blacklist of "will recover" phrasings let a paraphrase such as 「（重新允許後就會恢復）」 through
// (tester mutation T-B1-b), and Core 1.7.1 does not lift the fence when the permission is allowed again. Any edit to the user-facing sentence has
// to be made here too, on purpose. Current Core treats backend:invoke as a non-revocable legacy manifest field.

/** Current Core label for the legacy manifest field; it is not an actionable authorization switch. */
export const CORE_BACKEND_INVOKE_TITLE = '舊版 manifest 欄位（不需另行授權）'
export const BACKEND_TRUST_REQUIREMENT = '完全信任級'

/** lib/backendError.ts FENCED_TEXT (plugin_permission_denied / plugin_disabled) */
export const EXPECTED_FENCED_TEXT = 'TeamUQ 目前不讓這個外掛呼叫後端，所以讀不到 LINE 與待辦資料。可能的原因：外掛不是「完全信任級」組合外掛、外掛已停用，或後端太久沒有回應而被 TeamUQ 隔離。請到 TeamUQ 管理外掛的「外掛」頁打開這個外掛，確認執行範圍是「完全信任級」且外掛已啟用；若套件來源或信任狀態有問題，請重新安裝可信任來源的外掛；若後端逾時被隔離，請把外掛停用再啟用，或重新啟動 TeamUQ。'

/** lib/backendError.ts backend_invoke_timeout */
export const EXPECTED_TIMEOUT_TEXT = '外掛後端太久沒有回應，TeamUQ 已把它停止，並暫停這個外掛的後端呼叫；稍後再試也不會恢復。請到 TeamUQ 管理外掛的「外掛」頁打開這個外掛，把它停用再啟用，或重新啟動 TeamUQ。'

/** plugin/ui/aiStatusText.ts describeStatus(paused, backend_revoked) */
export const EXPECTED_AI_FENCED_TEXT = 'TeamUQ 目前不讓這個外掛呼叫後端（可能不是「完全信任級」組合外掛、已停用，或後端逾時被隔離），AI 整理暫停；請到 TeamUQ 管理外掛的「外掛」頁打開這個外掛，確認執行範圍是「完全信任級」且外掛已啟用。信任或套件狀態異常時請重新安裝可信任來源的外掛；逾時隔離時請停用再啟用，或重新啟動 TeamUQ'

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

// ── 0.1.3 r1: every other sentence that names a place in TeamUQ (src/shared/teamuqPlaces.ts) ──
// developer-evidence-r1 §1 lists them; before r1 they said 「TeamUQ 設定 → 外掛」 / 「TeamUQ 設定中」 / 「設定 → 外掛 → line-todo」 (1.6.8 only) or
// 「設定頁」 for the plugin's settings, which in the plugin lives inside TeamUQ, not on a board tab.

/** PERMISSION_TEXT["ai:chat"].title in pluginText.ts (1.6.8 :112, 1.7.1 :118); `check:core-gate-conformance` re-reads it. */
export const CORE_AI_CHAT_TITLE = '用你的 AI 對話額度回答你'
/** The tab that shows the plugin's settings view once the plugin is opened (PluginDrawerHost.tsx TABS, both versions). */
export const CORE_PLUGIN_SETTINGS_TAB_LABEL = '設定'
/** The sidebar label of the board view = the manifest's views[board].title (Core labels plugin tabs with view.title: pluginTabs.ts). */
export const BOARD_VIEW_TITLE = 'LINE 待辦'

/** shared/aiStatus.ts describeStatus('revoked') — ai:chat switched off */
export const EXPECTED_AI_CHAT_REVOKED_TEXT = '已關閉此外掛的 AI 權限（ai:chat）；請到 TeamUQ 管理外掛的「外掛」頁打開這個外掛，在「它可以做的事」裡允許「用你的 AI 對話額度回答你」後，重新開啟看板'
/** plugin/backend/aiProvider.ts toProviderError(access_revoked / not_granted / plugin_not_active).userMessage */
export const EXPECTED_AI_CHAT_REVOKED_TASK_TEXT = '此外掛的 AI 權限（ai:chat）已被關閉，請到 TeamUQ 管理外掛的「外掛」頁打開這個外掛，在「它可以做的事」裡允許「用你的 AI 對話額度回答你」'
/** plugin/ui/host.ts renderNotInHost (board and settings views opened outside TeamUQ) */
export const EXPECTED_NOT_IN_HOST_TEXT = '這個頁面要在 TeamUQ 裡開啟：看板在 TeamUQ 側邊欄的「LINE 待辦」；外掛的選項在 TeamUQ 管理外掛的「外掛」頁打開這個外掛後的「設定」分頁。找不到 TeamUQ 提供的外掛橋接（window.tuqPlugin）。'
/** renderer/components/Board/TodoCard.tsx (block chat / ignore by keyword): where to undo it — plugin host, then standalone (unchanged) */
export const EXPECTED_UNDO_HINT_PLUGIN = '（可到 TeamUQ 管理外掛的「外掛」頁打開這個外掛後的「設定」分頁解除）'
export const EXPECTED_UNDO_HINT_STANDALONE = '（可到設定頁解除）'

// ── background execution (background:resident, 0.2.0+): src/shared/residency.ts + src/shared/teamuqPlaces.ts ──
// Locked word for word like the sentences above. The switch title is Core's own (teamuq-electron pluginText.ts PERMISSION_TEXT[BACKGROUND_RESIDENT_PERMISSION].title,
// read at Core HEAD 0e46b155a); `check:core-gate-conformance` does not re-read it yet (it needs a released Core that has the switch: remaining step after the Core release).

/** The title of the background-execution switch in the plugin's 「總覽」 → 「它可以做的事」. */
export const CORE_RESIDENT_TOGGLE_TITLE = '關閉畫面後繼續在背景執行'
const PLACE = 'TeamUQ 管理外掛的「外掛」頁'
const TO_THE_SWITCH = `${PLACE}打開這個外掛，在「${CORE_PERMISSIONS_SECTION_TITLE}」裡`
export const EXPECTED_RESIDENCY_ALLOW_STEPS = `請到 ${TO_THE_SWITCH}打開「${CORE_RESIDENT_TOGGLE_TITLE}」`
export const EXPECTED_RESIDENCY_STOP_STEPS = `想停止時，請到 ${TO_THE_SWITCH}關閉「${CORE_RESIDENT_TOGGLE_TITLE}」`
export const EXPECTED_RESIDENCY_RETRY_STEPS = `請到 ${PLACE}把這個外掛停用再啟用，TeamUQ 就會再試`

/** What each state says: `bar` is the board's status line ('' = not shown), `detail` the settings page's paragraph. */
export const EXPECTED_RESIDENCY_TEXT = Object.freeze({
  notRequested: { bar: '', detail: '背景執行：這個版本沒有要求在背景持續執行。TeamUQ 會在外掛閒置一段時間後停止背景程式，之後開啟看板會補整理新訊息' },
  resident: {
    bar: '背景執行中：關閉看板後，LINE 待辦仍會在背景整理新訊息（只要 TeamUQ 還開著）',
    detail: `背景執行中：關閉看板後，LINE 待辦仍會在背景整理新訊息（只要 TeamUQ 還開著）。${EXPECTED_RESIDENCY_STOP_STEPS}`,
  },
  resident_not_granted: {
    bar: '背景執行尚未開啟：關閉看板一段時間後，TeamUQ 會停止背景程式，下次開啟看板時才會補整理新訊息',
    detail: `背景執行尚未開啟：關閉看板一段時間後，TeamUQ 會停止背景程式，下次開啟看板時才會補整理新訊息。${EXPECTED_RESIDENCY_ALLOW_STEPS}`,
  },
  resident_inactive: { bar: '沒有在背景執行：這個外掛目前沒有啟用', detail: `沒有在背景執行：這個外掛目前沒有啟用。請到 ${PLACE}把這個外掛啟用` },
  resident_budget_exceeded: {
    bar: '沒有在背景執行：TeamUQ 同時能在背景執行的外掛已達上限，名額先到先得',
    detail: `沒有在背景執行：TeamUQ 同時能在背景執行的外掛已達上限，名額先到先得。可以到 ${PLACE}關閉其他外掛的「${CORE_RESIDENT_TOGGLE_TITLE}」，空出名額後 TeamUQ 會再試`,
  },
  resident_crash_budget_exhausted: { bar: '背景執行已停止：背景程式連續當掉', detail: `背景執行已停止：背景程式連續當掉。${EXPECTED_RESIDENCY_RETRY_STEPS}` },
  resident_boot_failed: { bar: '背景執行已停止：背景程式連續啟動失敗', detail: `背景執行已停止：背景程式連續啟動失敗。${EXPECTED_RESIDENCY_RETRY_STEPS}` },
  resident_artifact_revoked: { bar: '背景執行已停止：這個版本的外掛已被外掛商店撤銷', detail: `背景執行已停止：這個版本的外掛已被外掛商店撤銷。請到 ${PLACE}更新這個外掛` },
  resident_revalidation_failed: { bar: '背景執行已停止：TeamUQ 重新檢查外掛檔案沒有通過', detail: `背景執行已停止：TeamUQ 重新檢查外掛檔案沒有通過。請到 ${PLACE}更新或重新安裝這個外掛` },
  resident_policy_error: { bar: '沒有在背景執行：TeamUQ 暫時無法決定背景執行，稍後會再試', detail: '沒有在背景執行：TeamUQ 暫時無法決定背景執行，稍後會再試。不需要做任何事；如果一直沒有恢復，請重新啟動 TeamUQ' },
})
/** A reason code Core may add later, and the generic sentences it gets (the code is printed so it can be reported). */
export const FUTURE_REASON_CODE = 'resident_future_new_reason'
export const EXPECTED_RESIDENCY_UNKNOWN_REASON = Object.freeze({
  bar: `沒有在背景執行（TeamUQ 回報的原因代碼：${FUTURE_REASON_CODE}）`,
  detail: `沒有在背景執行（TeamUQ 回報的原因代碼：${FUTURE_REASON_CODE}）。請到 ${PLACE}打開這個外掛，查看「${CORE_RESIDENT_TOGGLE_TITLE}」的狀態`,
})

/** The r1 sentences, by where they live. */
export const R1_PLACE_SENTENCES = Object.freeze({
  EXPECTED_AI_CHAT_REVOKED_TEXT, EXPECTED_AI_CHAT_REVOKED_TASK_TEXT, EXPECTED_NOT_IN_HOST_TEXT, EXPECTED_UNDO_HINT_PLUGIN
})

/**
 * Does a sentence name a place only one TeamUQ version has? Same rule as VERSION_SPECIFIC_PLACE, except that the plugin's own 「設定」 TAB
 * (after 「打開這個外掛」, present in both versions) is allowed; 「設定 → …」, 「TeamUQ 設定」, 「設定頁」 and a bare 「設定」 are not. Arrows too.
 */
export function namesVersionSpecificPlace(text) {
  const tab = `打開這個外掛後的「${CORE_PLUGIN_SETTINGS_TAB_LABEL}」分頁`
  return VERSION_SPECIFIC_PLACE.test(text.split(tab).join('')) || /[→>]/u.test(text)
}

/**
 * The 1.6.8-only / 1.7.1-only places the plugin used to print, as they could appear in the SHIPPED bundles (after \uXXXX decoding):
 * 「我的 AI › 外掛」 (0.1.2), 「TeamUQ 設定 → 外掛」 / 「TeamUQ 設定中」 / 「設定 → 外掛 → line-todo」 (before r1).
 */
export const SHIPPED_VERSION_SPECIFIC_PLACE = /我的\s*AI\s*[›>→]|TeamUQ\s*設定|設定\s*[›>→]\s*外掛/u
