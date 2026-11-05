# 開發連結：把開發中的看板接進 TeamUQ

這個功能把外掛的內容更新到一個固定資料夾，讓 TeamUQ 直接從那裡載入。資料夾裡的 manifest 與正式打包的內容完全相同，外掛 id 也相同（`tuqdev.line-todo`），所以連結後它會取代已安裝的 LINE 待辦看板。每次重新建置，TeamUQ 就會看到變更。

資料夾位置：`C:\teamuq\teamuq-plugins\line-todo\dist\dev-link\`

## 連結與解除連結

- 連結後，TeamUQ 會用這個資料夾裡的看板，取代原本安裝的 LINE 待辦看板。
- 看板的資料沿用，不會因為連結而清空。
- 要回到原本的安裝版，在 TeamUQ 解除連結即可，安裝版會回來運作。

## 第一次：在 TeamUQ 連結

1. 先執行一次 `npm run dev:plugin`，讓資料夾產生。
2. 在 TeamUQ 選「從資料夾連結」，選上面那個資料夾。
3. 之後不需要再連結，只要重新建置。

## 每次改程式

- 手動建置一次：`npm run dev:plugin`
- 自動建置：`npm run dev:plugin:watch`，開著它，存檔後會自動重建到同一個資料夾。按 Ctrl+C 停止。

watch 會監看這些路徑：`src/plugin/**`、`src/shared/**`、`vendor/sqlite3mc-wasm/**`、`scripts/plugin/lib/**`，以及 `scripts/plugin/` 底下的 `build-ui.mjs`、`build-backend.mjs`、`build-plugin.mjs`。`dist/` 不在監看範圍內。

## 建置會做什麼、不會做什麼

- 資料夾本身不會被刪掉重建，只更新內容有變的檔案。內容相同的檔案不會重寫。
- 只刪除「上一次建置寫出、這次不再產生」的檔案，以及因此變空的資料夾。
- 不會碰 TeamUQ 寫入的 `.teamuq/`、`AGENTS.md`，也不會碰你自己放進去的檔案。
- 不會產生 `integrity.json`、`signature.json`（它不是正式套件）。
- 輸出的檔案清單與寫入數量會印在終端機。

## 後端執行中，建置失敗怎麼辦

外掛後端正在執行時，Windows 會鎖住 `backend/native/win32-x64/*.node`。如果這些檔案的內容真的有變，建置會停下來並顯示：

> 無法更新 backend/native/win32-x64/koffi.node：這個檔案正被使用中（通常是外掛後端還在執行）。請先在 TeamUQ 停用或解除連結這個外掛，然後再重新執行建置。

照指示停用或解除連結後，再執行一次 `npm run dev:plugin`。內容沒變的 `.node` 不會被開啟寫入，所以不會因此失敗。

## 注意

- 建置永遠寫入同一個資料夾，之前的內容會被新內容覆蓋。
