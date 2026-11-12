# LINEJS 出站功能移植交接（pro）

更新日期：2026-11-12  
版本／分支與 repo 絕對路徑：`main`（免費版）— `C:/teamuq/teamuq-plugins/line-todo`；`pro`（進階開發線／本次目標）— `C:/teamuq/teamuq-plugins/line-todo-pro`；`feature/linejs-validation-lab`（能力來源與離線驗證台）— `C:/teamuq/teamuq-plugins/linejs-lab`。本文件寫作時三者分支名稱均已核對。  
接手前基準：請先重新確認目前 HEAD、branch 與工作樹；本文件寫作時觀察到 HEAD `5c8e1c56684eb41c5eb50c248e755cb57deb7733`，但此分支有大量併行 dirty/untracked 變更。此值不是完整內容 hash 基線。

## 真正需求與交付邊界

使用者要求把 `linejs-lab` 已完成的手動發送能力整合到 `line-todo-pro`，讓 pro 真實聊天介面能經正式 plugin host/backend 呼叫 LINEJS SDK，支援文字、單張圖片、單檔案。需求不是只做狀態查核或改購買文案。此文件交付本身不代表已開始或完成功能移植：目前尚無出站發送 caller 實作、候選實作、獨立驗證或套回 pro。

- `line-todo` 的 `main` 是免費版；維持免費版現況與既有工作，不把新出站功能帶入 main。
- `line-todo-pro` 的 `pro` 是進階功能開發線，是本次最後整合目標。
- `linejs-lab`（`feature/linejs-validation-lab`）是能力來源與離線驗證台，不是可直接宣稱已交付的產品分支。
- 範圍限手動文字、單張圖片、單檔案。排除語音、Flex/貼圖等 complex message、排程發送及支付/授權後端。保留 pro 現有自動下載/接收及所有併行修改。不得使用真 LINE 發送、讀取憑證或 session 秘密。

## 已確認事實及證據層級

### Lab 已有的流程與測試

既有研究記錄的 lab 流程是 UI `ui/index.html` / `ui/app.js` → host outbound API → `backend/outbound.mjs` → SDK：文字呼叫 `client.base.talk.sendMessage({to,text,e2ee:true})`；圖片/檔案呼叫 `client.base.obs.uploadMediaByE2EE({data,oType,to,filename})`。附件先以分塊方式 staging 到 plugin storage，再送出。成功需非空 SDK message ID；未知結果不得自動重送，應保留 unknown 狀態供人工判斷。lab 研究記錄的單附件設計上限為 25 MiB，需接手時再從當前實作與測試確認。

`linejs-lab` 的離線執行證據為 `node --test tests/outbound.test.mjs tests/ui-entry.test.mjs`，Node `v24.2.0`，32 pass、0 fail、0 skipped、exit 0。測試使用 synthetic/stub SDK client 與 mock host，覆蓋文字/單圖/單檔、部分 staging/參數/成功 ID/明確拒絕/unknown 防重送與狀態恢復案例。這不是 pro 測試、Electron 真 host 驗證、live LINE 發送或送達證明。Node `v24.2.0` 低於 package engines 宣告 `^24.11.0`，接手驗證應使用符合宣告的版本並記錄實際版本。

### Pro 已定位的正式接線入口（research partial，接手需查當前 source）

- 聊天 UI 入口：`src/renderer/components/MessageStream.tsx`。lab 的聊天 composer 應接在實際聊天訊息介面，不是獨立設定頁。
- Renderer API/host transport：`src/renderer/platform/pluginApi.ts` 與 `src/renderer/platform/pluginTransport.ts`。既有 transport 將 API path/args 序列化為 host backend call。
- 共用 API 與 wire allowlist：`src/shared/api.ts`、`src/shared/pluginWire.ts`。研究指出 request wire budget 為 60 KiB；大附件 bytes 不應直接塞進單次 wire request。
- Backend 分派與組裝：`src/plugin/backend/dispatcher.ts`、`src/plugin/backend/assemble.ts`、`src/plugin/backend/index.ts`。研究指出 dispatcher 只接受明確登記的 `SUPPORTED_API_PATHS`，新增 API 需沿 shared path/group、transport 與 handler 登記，不可依賴任意動態屬性路由。
- pro LINEJS media/session 現況與 manifest/build：`src/plugin/backend/linejsMedia.ts`、`src/plugin/backend/linejsAutoDownload.mjs`、`src/plugin/ui/settings.tsx`、`src/plugin/backend/` 相關組裝，以及 `scripts/plugin/lib/manifest.mjs`、`scripts/plugin/build-backend.mjs`、`scripts/plugin/build-plugin.mjs`。目前已知 pro dirty/untracked media 變更是登入/接收/自動下載，不是出站發送 caller；必須保留並從接手當下 source 核實。

以上入口和 transport 描述來自部分研究，不等於完整架構設計或穩定契約。`research/research.json` 明確為 `partial`，行號/完整 dirty hash manifest 尚未完整收齊；本輪 Architect 未完成，`design.json` 尚未產生。不可把 research 中標為 inference 的閉包建議寫成已確認契約，也不可假設任何未查證的 client/storage/gate API。

## 必須先查證的設計問題

1. **Client/session 綁定與隔離：** pro 當前 LINEJS client 的建立、取得、替換、logout/login、generation/epoch 生命週期在哪裡？送出開始到 SDK 結果返回間如何確認仍是同一 client/session？成功或 unknown 狀態如何避免串到另一帳號或另一聊天室？
2. **Chat target 正確性：** 從目前選中的聊天取得 `to` 的正式來源與型別是什麼？發送前需驗證聊天/profile/client 關聯，禁止接受 renderer 任意提供或過期的 target。所有 UI 與 backend 結果需綁回正確 chat。
3. **Storage 與附件分塊：** pro plugin storage 的可用介面、quota、原子性、清理策略、生命週期和打包可見性為何？如何分塊寫入/讀取及驗證總長度、chunk 順序、完整性、MIME/副檔名、空檔、大小？lab 25 MiB 限制需依 SDK、storage 與產品限制核實。60 KiB wire budget 意味著附件不能隨一般 API 一次傳輸。
4. **Feature gate 與版本能力：** 現有 pro capability/feature-pack manifest 如何控制 UI 與 backend？核對真正閘門與免費版隱藏行為，不新造假的購買、授權或解鎖紀錄，也不能只靠 renderer 隱藏就保護 backend。
5. **未知結果、防重送與恢復：** SDK 呼叫中斷或 host 回覆失聯時，可能已送達但拿不到 ID。此狀態要持久化/恢復，鎖住自動重送，讓使用者清楚知道無法確認；不得把 timeout 當明確失敗，也不能把 SDK message ID 說成收件方已讀/送達。
6. **錯誤與日誌：** 對使用者回報脫敏錯誤；不記錄 token、聊天敏感資料或憑證。送出必須由使用者明確操作。
7. **歷史 QR finding：** 舊 review 的 `REVIEW-LOGIN-CANCEL-COMMIT-001` 涉及 QR login cancel/timeout 與 `attemptGuard.drain` session commit，另有廣泛 UI timeout 未知項。這是舊 media 任務的 blocker 歷史，不能宣稱已解，也不能直接等同出站 client race。先查目前共用 session/client lifecycle，判斷本次是否受影響；若受影響，將必要修正納入出站閉包並獨立驗證。舊 media 3/3 checkpoint/恢復次數不可重設或挪用。

## 最小可執行接手順序

1. **重建基線：** 確認 `line-todo-pro` branch/HEAD/hash 與 dirty/untracked 清單；比對現況和 `research/before_manifest.json`。該 manifest 明示未對全部路徑計算 hash，不能當完整 hash 基線。保存所有併行修改，包括 `0`、`1` 兩個未追蹤項目；不要覆寫或清理。
2. **完成研究與設計：** 從目前 pro source、lab source/測試及既有 session/storage/capability 契約核實上述問題。Architect 產出完整設計 artifact（目前沒有 `design.json`），清楚列出最小依賴閉包、狀態模型、session/chat 綁定、storage/限制、閘門、錯誤與測試矩陣。標清事實、推論與未決事項。
3. **候選實作：** 依授權的隔離 candidate/流程完成 pro renderer composer → typed API/host transport → 明確 dispatcher/manifest allowlist → backend LINEJS caller；支援文字/單圖/單檔，附件分塊 staging/完整性/限制，正確 chat target、client/session fencing、unknown 防重送/恢復與脫敏狀態。保留現有 receive/autodownload，並確認 feature gate 同時覆蓋 UI/backend。
4. **獨立測試與 review：** 由獨立 Tester 驗 backend/contract；以 mock host 驗 production renderer 的聊天輸入、附件選取/驗證、明確送出及成功/失敗/unknown 呈現；覆蓋 session/client 變動、chat 錯綁、附件 chunk/size/integrity、重啟恢復與防重送、free/pro gating。完成 production wiring source review。使用符合 Node engines 的環境。不得把 mock/stub 當 live LINE 證據。
5. **有界套回 pro：** 僅候選經獨立驗證及 review 通過後，重新核對當時 pro HEAD/hash、檔案碰撞及併行 dirty/untracked；用最小有界 delta/三方比對保留外部變更，將核准實作實際套回目標 pro，並在最終 target 重驗必要驗收。只留 candidate 或報告不算完成。遵守原任務禁止 commit/stage/merge/push/deploy/cleanup。

## 完成驗收

- pro 真實聊天介面明確支援文字、單張圖片、單檔案，完整 production UI → host → backend → LINEJS SDK wiring；不是 fixture 或假成功。
- 成功只在 SDK 回傳有效非空訊息 ID 時成立；附件驗證、分塊、wire 限制、target/session 安全、unknown 狀態、防自動重送、恢復與脫敏行為有獨立測試證據。
- free/main 仍維持免費版狀態，pro 使用既有能力/功能包機制；沒有假購買/授權/解鎖紀錄，沒有擴入語音/complex/排程。
- Tester 的獨立 backend/contract 與 production renderer mock-host 互動驗證、Reviewer 的完整 wiring source review 都完成；明確註記未做真 LINE 或已安裝 host 驗證。
- 已將驗收通過的有界變更實際套回 pro 並在最終 target 檢查；併行 dirty/untracked、接手前 HEAD/hash 與改動證據均可追溯。

## 證據索引

外部證據用於核對，不取代本文件中的必要接手摘要：

- 本輪授權/接受條件：`C:/Users/david/.teamuq/sw-runs/line-todo-pro-outbound-20261112/handoff/request.json`、`C:/Users/david/.teamuq/sw-runs/line-todo-pro-outbound-20261112/task.json`、`C:/Users/david/.teamuq/sw-runs/line-todo-pro-outbound-20261112/checkpoint.json`。
- 部分研究及不完整基線：`C:/Users/david/.teamuq/sw-runs/line-todo-pro-outbound-20261112/research/research.json`、`C:/Users/david/.teamuq/sw-runs/line-todo-pro-outbound-20261112/research/before_manifest.json`（`hash_status=not_computed_for_all_paths`）。
- Lab 離線測試與 reviewer：`C:/Users/david/AppData/Local/Temp/line-todo-send-status-20261112/send-test/tester.json`、`C:/Users/david/AppData/Local/Temp/line-todo-send-status-20261112/review/review.json`、`C:/Users/david/AppData/Local/Temp/line-todo-send-status-20261112/research.json`。
- 舊 QR finding 與 recovery 歷史：`C:/Users/david/AppData/Local/Temp/teamuq-linejs-integration-20261112/review/review.json`、`checkpoint.json`。
- 本文件不聲稱以上研究預測已成為 pro API 契約；每位接手者仍須核對當前 HEAD/hash 和 source。
