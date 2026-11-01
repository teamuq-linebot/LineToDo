/**
 * 外掛目前的版本號（顯示在頂部標題列）。
 *
 * 來源是 `package.json` 的 `version`——跟 manifest 的 `version`、backend 的 `backend.info` 是同一個值：
 *   - 外掛 UI：`scripts/plugin/build-ui.mjs` 在 esbuild 的 `define` 注入；
 *   - standalone（electron-vite）：`electron.vite.config.ts` 的 renderer `define` 注入。
 * 沒注入（單元測試直接載入原始碼）時回空字串，標題列就不顯示版本；不在程式裡寫死版本字串。
 */
declare const __LINE_TODO_PLUGIN_VERSION__: string | undefined

export const APP_VERSION: string = typeof __LINE_TODO_PLUGIN_VERSION__ === 'string' ? __LINE_TODO_PLUGIN_VERSION__ : ''
