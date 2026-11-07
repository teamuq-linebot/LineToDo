# TeamUQ 相容性

LINE 待辦 0.2.14 的 SDK、作者 CLI、離線測試宿主與預設打包驗證目標固定為 TeamUQ 1.8.10，最低宿主版本為 `>=1.8.10`。

來源為本機安裝的 TeamUQ 1.8.10 `resources/plugin-authoring/kit`。複製時已逐檔核對工具包的 SHA-256，來源清單保留於 `scripts/plugin/vendor/kit.version.json`；CLI 與 SDK、測試宿主各有版本與雜湊紀錄。AI 合約 fixture 由 TeamUQ `v1.8.10` 標籤產生，更新指令為 `node scripts/plugin/gen-ai-contract-fixture.mjs <TeamUQ 原始碼路徑>`。

## 背景執行

正式套件與 `dist/dev-link` 預設都宣告 `background:resident`。這只讓 TeamUQ 顯示授權開關，不會代替使用者授權。

要讓看板關閉後繼續整理訊息，請在 TeamUQ 的「外掛」頁打開 LINE 待辦，在「它可以做的事」開啟「關閉畫面後繼續在背景執行」。未授權、超出宿主資源額度或宿主停止背景執行時，外掛依 `context.residency` 回報狀態；不會自行保活或繞過限制。

建置不宣告背景常駐能力的套件可使用 `npm run build:plugin -- --resident=false`，開發連結則使用 `npm run dev:plugin -- --resident=false`。也支援 `LINE_TODO_RESIDENT=0`。最低宿主版本仍為 1.8.10。

## 驗證

- `npm run typecheck`
- `npm run test:plugin`
- `npm run build:plugin`
- `npm run check:plugin-manifest`
- `npm run verify:plugin-artifact`

`test:plugin` 包含對目前 TeamUQ 原始碼的呼叫隔離、權限、背景常駐開關與畫面指引檢查。原始碼位置可用 `TEAMUQ_CORE_DIR` 指定，或單獨執行 `npm run check:core-gate-conformance -- --core <路徑>`。

原生後端與封裝契約測試還需要 Electron 31 產生合成 LINE 資料庫，以及 Electron 44 執行後端。若執行檔不在預設位置，可用 `LINE_TODO_ELECTRON31_EXE`、`LINE_TODO_BSQLITE3MC_DIR`、`TEAMUQ_ELECTRON44_EXE` 指定相符的執行檔與原生資料庫模組；搜尋規則見 `scripts/lib/runtimes.mjs`。測試使用合成資料，不需要真實 LINE 資料。

## 載入更新

開發中使用 `npm run dev:plugin` 更新固定資料夾，再由 TeamUQ 的「從資料夾連結」載入。已經連結的宿主會依自身檔案監看機制重新載入。

正式套件位於 `dist/plugin-package/tuqdev.line-todo-0.2.14-win.tuqplugin`。建置與驗證不代表已安裝；請使用 TeamUQ 的正常外掛安裝流程。
