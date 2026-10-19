/**
 * 設定頁「AI 端點」欄位的 placeholder（standalone 的預設 qwen 端點，僅顯示用）。
 * 獨立成一個模組，是因為外掛 UI 沒有自訂端點（backend 不打 LLM），build 時把它換成空字串（scripts/plugin/build-ui.mjs），
 * 讓外掛 bundle 裡不出現任何遠端 URL。
 */
export const AI_ENDPOINT_PLACEHOLDER = 'https://qwen.tuq.tw/v1'
