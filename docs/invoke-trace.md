# Backend 呼叫紀錄（invoke trace）

目的：TeamUQ 對一次 backend 呼叫只給 30 秒，超過就把整個外掛隔離（Core 的 `timeoutPlugin`），Core 的 log 又不記是哪個 method。
這份紀錄讓外掛自己留下「每個呼叫的開始、結束、耗時、結果碼」與「事件迴圈被卡住多久」，就算 backend 之後卡死或被強殺，最後一筆「已開始、未結束」的呼叫仍在磁碟上。

只觀測，不改行為：逾時、20 秒軟期限、job 轉換、錯誤碼、回應內容都和沒有紀錄時完全一樣；寫檔失敗會被吞掉。

## 位置與大小

| 項目 | 值 |
|---|---|
| 檔案 | `<dataDir>\logs\invoke-trace.log`（本機：`C:\Users\<使用者>\.teamuq\plugins\data\tuqdev.line-todo.pro\logs\invoke-trace.log`） |
| 輪替檔 | `invoke-trace.log.1`（只留一代） |
| 上限 | 每個檔 1 MiB（`TRACE_DEFAULTS.maxBytes`），合計最多約 2 MiB |
| 容量（實測） | 一筆約 130 位元組（73 條已知路徑 × 3 種參數大小的平均 131.5，單筆最大 160；`test-invoke-trace.mjs` 的「record sizes match…」測試守住這個範圍）；2 MiB 約 1.6 萬筆，一次呼叫寫 `start`＋`end` 兩筆，約 8,000 次呼叫。`inflight`、`carry`、`loop_stall` 較長（數百位元組），但只在有慢呼叫或輪替時才寫。 |
| 格式 | 一行一筆 JSON（UTF-8） |

輪替時還在進行中的呼叫會在新檔補寫一行 `carry`，所以「已開始、未結束」不會因輪替而消失。

**輪替失敗不會讓紀錄中斷**：輪替只用 rename 取代 `.1`（rename 成功前**不刪**舊的 `.1`）。rename 失敗（`.1` 被占用、不是檔案、權限、目前的檔案被外部移走）就降級成截斷目前的檔案，舊的 `.1` 原樣保留，
進行中的呼叫照樣補寫 `carry`；連截斷都失敗就繼續追加，檔案長到 2 × `maxBytes` 的硬上限才丟棄新紀錄；期間每多寫 64 KiB 再試一次輪替，到了硬上限（新紀錄都被丟棄、檔案不再變大）則每一筆都再試，所以障礙一排除，下一筆呼叫的 `start` 就會寫進檔內（測試用注入失敗的副本守住）。失敗原因只在 `recentLog` 留一行 `[trace] write_failed <code>`（同一種只留一次）。
`createPluginBackend({ trace: false })` 關閉；`trace: {...}` 可覆寫門檻（測試用）。

## 為什麼卡死也留得住

`start` 在進入 handler 之前、用同步的 `writeSync` 寫進**常駐開著的 append 模式檔案描述子**（`dispatcher.ts` 的 `call`）。`writeSync` 回傳時資料已交給作業系統，
之後 backend 同步卡死、被 TeamUQ 強殺都不會遺失（測試用真的子行程 SIGKILL 驗證）；只有整台機器當機（作業系統快取還沒寫出）才可能少最後幾筆。沒有做 fsync（每次呼叫都 fsync 會拖慢正常路徑）。

為什麼改成常駐描述子：原本每筆都 `appendFileSync`（open＋write＋close），每個呼叫兩次。一次性實測（本機 Windows，1.5 萬組 `begin`＋`end`，不是測試）：

| | 中位數 | 平均 | p99 | 最大 |
|---|---|---|---|---|
| 每次 open／close（改前） | 559–592 µs | 1.7–2.2 ms | 18–25 ms | 86–318 ms |
| 常駐描述子（改後） | 16 µs | 31 µs | 0.13 ms | 19–28 ms |

落盤保證不變（兩者都是同步系統呼叫，回傳時已交給作業系統）。代價與處理：
- 檔案被外部刪掉時，常駐描述子會繼續寫進已脫離目錄的檔案。`unref` 計時器每 500 ms 檢查一次檔案還在不在，不在就關掉描述子，下一筆重新建立；所以刪檔後最多約 0.5 秒的紀錄會落在已刪除的檔案裡。
- 輪替前先關描述子再 rename，新檔在下一筆寫入時重開。
- 寫入出錯（描述子失效）會關掉重開再試一次，仍失敗才算丟棄一筆。

## 記錄的欄位（白名單，沒有任何內容）

只有 method／path 名稱、序號、時間、耗時、結果碼、參數個數與位元組數。**沒有**參數值、回傳值、錯誤訊息、聊天室與聯絡人名稱、金鑰。

- `m`：method 組名（`db.todos`…），不在 `BACKEND_METHOD_GROUPS` 內記 `?`；`snap` 事件的 `m` 是 `reuse`／`wal`／`full`
- `p`：path（`db.messages.list`…）；**只記 dispatcher 認得的路徑**（`SUPPORTED_API_PATHS`、`UNSUPPORTED_API_PATHS` 的鍵、內部路徑 `INTERNAL_API_PATHS`），其他一律記 `?`。通過格式檢查、組名前綴也對的字串（例如 `db.chats.<任意文字>`）也記 `?`，因為那段文字是呼叫端給的，可能夾帶不該寫進檔案的內容。想知道被拒絕的路徑是什麼，看呼叫端的回應（`path_unknown`），不在這份紀錄裡
- `argc`／`argB`：參數個數／序列化後位元組數（只有大小）
- `bytes`：分段回應的總位元組；`snap` 事件則是這次複製的位元組數
- `res`：結果碼。`ok`、`pending`（超過軟期限，轉成 job）、`chunked`（回應分段）、envelope 的錯誤碼（`api_error`、`path_unknown`…）、`threw`（dispatcher 丟出例外，另有 `err`＝錯誤類別名）；不是純英數底線的碼一律記 `other`
- `seq`：呼叫序號（每個 backend 行程從 1 開始；`pid` 區分行程）

| `ev` | 何時寫 | 重點欄位 |
|---|---|---|
| `boot` | 外掛 backend 啟動 | `pid`、`ver`、`slowMs`、`stallMs` |
| `start` | 進入 handler 之前 | `seq`、`m`、`p`、`argc`、`argB`、`fl`（開始時已在進行的呼叫數） |
| `end` | 呼叫回傳 | `seq`、`p`、`ms`（耗時）、`res`、`slow:true`（慢呼叫）、`bytes`（分段回應的總位元組） |
| `job_end` | 轉成 job 的呼叫做完 | `seq`、`ms`（從開始算的總時間）、`res` |
| `snap` | LINE DB 的持久 snapshot 這次怎麼取得 | `m`（`reuse`＝簽章沒變零複製、`wal`＝只複製 -wal、`full`＝整份複製）、`ms`、`bytes`、`from`（開始時間）；`wal`／`full` 一律記，`reuse` 只記 ≥50 ms 的 |
| `bg` | 背景工作花的時間（只記 ≥50 ms） | `p`（`poll`＝匯入批次落庫、`reconcile`＝開機對帳讀來源、`quick_check`＝app DB 健檢、`unsent_scan`＝收回掃描、`media_index`＝圖片索引背景掃描的一個切片（≤20 個目錄或 15 ms，所以正常不會出現；出現就代表某個切片超過 50 ms，是歸因卡頓用的）、`avatar_backfill`＝頭像回填的一個 burst，最多約 300 ms）、`ms`、`from` |
| `loop_stall` | 事件迴圈卡頓結束後 | `from`（卡頓開始）、`lagMs`（卡了多久）、`calls`（期間重疊的呼叫：`seq`、`p`、`age`、`open`） |
| `inflight` | 有慢呼叫還沒結束時的心跳 | `calls`（`seq`、`p`、`age`） |
| `carry` | 輪替後補寫的進行中呼叫 | `calls`（`seq`、`m`、`p`、`since`、`age`） |
| `stop` | 正常 dispose | `calls`（結束時還在進行的） |

## 門檻與理由

- **慢呼叫 `slowMs = 2000`**：一般本機呼叫（SQLite 查詢、記憶體狀態）在毫秒等級，2 秒已是平常的百倍以上；
  同時遠低於外掛自己的 20 秒軟期限與 TeamUQ 的 30 秒上限，所以在變成逾時隔離之前就會先留下 `slow:true`。
  長輪詢（`events.pull`、`job.poll`）本來就會等，不標慢、不觸發心跳。
- **事件迴圈卡頓 `stallMs = 1000`**：一個 `unref` 的計時器每 500 ms 量一次遲到時間，遲到 ≥ 1 秒（取樣間隔的兩倍）才記。金鑰掃描主動讓出的時間片是 20 ms，遠低於它。
- **心跳 `heartbeatMs = 5000`**：只有「非長輪詢、已開超過 `slowMs`」的呼叫（或背景 job）還在進行時才寫，且最多每 5 秒一筆；沒有慢呼叫時不寫。

## 怎麼讀（判斷是哪個 method 造成 30 秒逾時）

1. 找沒有對應 `end` 的 `start`（同一個 `pid`、`seq`）；若輪替過，也看 `carry`。**未結束的可能不只一個**（背景 job、長輪詢、同時進行的呼叫都算）：
   - 看最後一筆 `inflight`（或 `stop`、`loop_stall`）的 `calls`：每項有 `seq`、`p`、`age`（到那一筆為止已經過多少毫秒），`age` 最大的、而且不是 `wait:true`（長輪詢本來就會等）也不是 `job:true`（背景 job 本來就會跑很久）的那個，最像造成逾時的 method；
   - `calls` 最多列 8 個（最久的先）。沒有 `inflight` 時，用 `start` 的時間戳比較：最早開始、仍沒有 `end` 的先懷疑。
   - 逾時隔離是「某一次呼叫超過 30 秒」，所以嫌疑呼叫的 `age`（或 `start` 到外掛被強殺／隔離的時間）要接近或超過 30 秒；只開了幾秒的未結束呼叫多半只是被一起殺掉的無辜者。
2. 看它之後有沒有 `inflight` 心跳：
   - 心跳持續到被強殺為止 → 事件迴圈還活著，呼叫在等某個永遠不回來的非同步工作（例如 `host.ai`）。
   - 心跳在某個時間點之後消失（且沒有 `stop`）→ 事件迴圈在那之後被同步工作卡死；`start` 的 `p` 就是進去之後卡住的路徑。
3. 卡頓後恢復的情況看 `loop_stall`（`lagMs`、`calls`）與 `end` 的 `ms`、`slow:true`。
4. 檔尾沒有 `stop`＝backend 不是正常結束（被隔離後強殺、當機）。`stop` 之後不再追加任何紀錄：`dispose` 之後才結束的呼叫（`end`／`fail`／`job_end`）會被略過、也不會重新開檔，所以「檔尾是 `stop`」與「已正常結束」一致；代價是這類晚到呼叫沒有 `end`（它們在 `stop` 的 `calls` 裡仍列為進行中）。
5. `res:"pending"` 的呼叫看之後的 `job_end`，才知道背景工作總共做了多久。
6. **歸因卡頓**：`loop_stall` 的 `from`／`lagMs` 對上同一段時間的 `bg`（`from`、`ms`）或 `snap`（`wal`／`full` 的複製是非同步的，不應該造成卡頓；若同時段有大的 `lagMs`，問題在複製之外）就知道是哪個背景工作。`backend.info` 的 `lineSnapshot`（reuse／walCopies／fullCopies／copiedBytes／lastKind／lastMs）給累計值；`backend.info.media.index`（available／ready／rows／scanning／lastScanMs／lastRefreshAt／mode／passes／dirsListed／errors／misses）是圖片索引的狀態，`ready:false` 時 `media.prepare` 的 `not_cached` 訊息會寫「索引建立中」。
7. **完全沉默**（時間範圍內沒有任何 `start`，或最後一筆 `start` 都有 `end`，但 TeamUQ 仍逾時隔離了外掛）：呼叫根本沒進到 `Dispatcher.call`——事件迴圈被背景工作（watcher、ExtractWorker）卡死，或呼叫卡在 Core／傳輸層。
   這時要看 Core 的 main log（`[plugin-runtime]` 前綴）中的 `plugin-backend-invoke-timeout`：有 `pluginId`、`method`（組名，不含 path）、`elapsedMs`、`phase`（`policy_check`／`backend_call`）；用時間戳和這份紀錄對齊（兩邊只能以時間對齊，沒有共用序號）。
   `loop_stall` 在迴圈恢復後才會寫；永久卡死則是 `inflight` 心跳停止、`stop` 也沒有。這個 Core log 需要有該紀錄的 Core 版本，舊版 Core 不會寫。

## 限制

- 事件迴圈永久卡死時，計時器也跑不動，所以不會有 `loop_stall`；依上面第 2 點用 `start` 與心跳判斷。
- 結果碼反映的是 dispatcher 的 envelope：`ok` 不代表業務結果成功（例如 API 回 `{ok:false}` 仍是 `ok`）。
- 呼叫紀錄只涵蓋經過 `Dispatcher.call` 的呼叫；背景工作（watcher、ExtractWorker）只有上面 `bg`／`snap` 列出的幾個點會留下耗時（≥50 ms），其餘造成的卡頓只會以 `loop_stall` 出現。
