# LINE 待辦 Pro（line-todo-pro）

本專案的工作規則寫在 @AGENTS.md，所有 agent 都要遵守。

最重要的一條：**Pro 每次改動完成並通過檢查後，都要同步到 `release/stage`。**
- 升版
- `npm run dev:plugin`
- 備份到 `release/rollback-stage-<舊版本>-<日期>`
- 複製內容檔，`manifest.json` 最後寫
- 逐檔核對 sha256

每次push前，需要先將main merge到pro
絕對不要按 TeamUQ 的「移除」。
# LINE 待辦 Pro（line-todo-pro）工作規則

## 每次改動都要同步 `release/stage`（強制）

TeamUQ 的開發連結固定指向 `release/stage`，使用者一律用這個資料夾試用 Pro。

**只要 Pro 的程式有任何改動完成並通過檢查，就必須同步到 `release/stage`。**只改工作區、不同步，等於使用者看不到改動。

### 外掛身分（不得更動）

- 外掛 ID：`tuqdev.line-todo.pro`，顯示名稱：「LINE 待辦 Pro」
- 免費版是另一個外掛，ID 為 `tuqdev.line-todo-free`，兩者不得共用 ID 或連結。

### 同步步驟

1. **升版**：改 `package.json` 的 `version`，`package-lock.json` 的根版本也要一起改。manifest 版本由 package.json 產生。
2. **建置與檢查**：
   - 跑 `npm run dev:plugin`，產生 `dist/dev-link`。
   - 至少跑過 typecheck、`build:plugin`、`check:plugin-manifest`，以及與改動相關的測試。失敗名單不得比上一版多。
3. **備份**：先把現有的 `release/stage` 完整複製到 `release/rollback-stage-<舊版本>-<YYYYMMDD>`。
   - 同名資料夾已存在時，加尾碼，不得覆寫。
4. **寫入**：從 `dist/dev-link` 寫入 `release/stage`。
   - 先複製內容檔，**`manifest.json` 最後寫**。TeamUQ 會監看這個資料夾，manifest 寫入後就會重新載入。
   - 內容相同的檔案跳過不寫。TeamUQ 執行中，`.node` 原生檔會被鎖住（EBUSY）。
   - `release/stage` 中 dev-link 沒有的多餘檔案，預設保留；要刪除須先確認。
5. **驗證**：
   - `dist/dev-link` 的每個檔案，在 `release/stage` 中的 sha256 都必須一致。
   - `release/stage/manifest.json` 的 id 與 version 必須正確。
   - 任一步失敗，就從備份還原 `release/stage`。

可沿用的同步腳本：`C:/Users/david/.teamuq/sw-runs/line-todo-pro-media-download-20261113/stage-sync-0.2.22/scripts/stage-sync.mjs`。這是不刪多餘檔的版本，使用前先讀它的用法說明。

### 禁止事項

- **絕對不要按 TeamUQ 的「移除」**。Pro 設定為移除時刪除資料，按下去會刪掉看板資料與已保存的附件。要換版本，請用「解除連結」。
- 不要修改 TeamUQ 的 `links.json`；同步 `release/stage` 不需要重新連結。
- 若必須改連結，順序是先解除舊連結，再連結新路徑；否則 TeamUQ 可能以舊 ID 套用新的 backend。
- 同步前後都要確認 `git status`。如果工作區在同步過程中被別人改動，就停止同步，先確認狀況。

## 其他

- 使用者沒有要求時，不 commit、不 push。
- 不要讀取 LINE 登入憑證（`linejs-session.json` 的內容）。開發測試不得連到真的 LINE。
