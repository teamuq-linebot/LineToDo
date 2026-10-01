// 外掛 UI 的替身（build-ui.mjs 在 resolve 階段取代 src/renderer/lib/defaultEndpoint.ts）：外掛版沒有自訂 AI 端點，bundle 不放任何遠端 URL。
export const AI_ENDPOINT_PLACEHOLDER = ''
