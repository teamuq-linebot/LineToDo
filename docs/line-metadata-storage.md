# LINE 訊息識別 metadata 保存

主資料庫 schema v11 在 `messages` 保存六個 nullable TEXT 欄位：`media_oid`、`media_sid`、`shared_contact_mid`、`shared_contact_display_name`、`sticker_id`、`sticker_package_id`。`_contentMetadata` 只讀取需求指定欄位；名片對象鍵是 LINE 原始小寫 `mid`，與發話者 MID 分開。OID/SID 的既有 RawLineMessage `oid`/`sid` 不變。

轉換只接受 JSON 字串或 JSON 數字 token。數字 token 以來源的十進位文字儲存，不經 JavaScript Number；缺值、錯誤 JSON、錯型別為 null。欄位僅由 main-process repository 的 `getMessageLineMetadata(msgId)` 讀回，不加入 MessageDTO、IPC、renderer、LLM payload 或 log。

新訊息沿既有 normal watch/import 落庫。歷史訊息可從既有「補媒體金鑰」入口重讀：`pipeline.backfillMediaKeys(days)` 仍保留 `days` 窗口語意，同時把六欄寫入；重跑只填 DB 既有 NULL 欄位，不覆蓋已有值，也不更動訊息身份、正文、processed 或 todo 關聯。standalone 與 plugin 正式入口都經 `createLineTodoApplication` 的 pipeline API，使用 durable `getLineImportBatch`/`commitLineImportBatch` composite-cursor 分頁並逐頁提交，直到含尾頁的最後一頁；不推進 live watch cursor。若 import source/schema 不可用，才回退到 legacy `getMessagesSince` 窗口。

預設近幾天補存不代表完整歷史。要覆蓋全部歷史，需在載入含此變更的 runtime 後，透過現有入口傳入足以涵蓋最早訊息的天數，從最早訊息時間之前重讀。若 durable import source/schema 不可用而退回 standalone `getMessagesSince`，來源受 20,000 筆上限影響，不能據此聲稱全歷史完成。每次回補的 `scanned` 與 `metadataBackfilled` 是實際處理計數，不構成全歷史完整性證明。執行中的舊版 plugin 必須載入新版後才能使用回補行為；本次程式候選未對 live DB 執行回填。
