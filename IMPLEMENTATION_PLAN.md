# line-todo 實作規格（IMPLEMENTATION_PLAN.md）

> 定時監控 LINE 新訊息 → AI 語意抽取代辦 → 看板呈現（待辦 / 等回覆 / 行程 / 已完成）
> Electron + Vite + React + TypeScript 桌面 App。回應語言：繁體中文。

## 0. 本檔性質與閱讀順序

- 本檔描述**程式的實際現況**（以 `src/` 為準）。與程式不符時，以程式為準，並修正本檔。
- 標示「**未實作**」的項目是計畫中尚未寫進程式的功能，保留以供追蹤，不代表已完成。
- 標示「**未確認**」的項目是目前查不到依據的內容，不作推測。
- 基準：分支 `fix/line-todo-extract-guard-20261110`，基底 `86e0d55`，package 版本 0.2.17。
- 主要入口：
  - 外掛（plugin）路徑：`src/plugin/backend/`（`ExtractQueue`、`ExtractWorker`；AI 由 host 提供）。
  - standalone 路徑：`src/main/pipeline/runOnce.ts`、`src/main/pipeline/scheduler.ts`；AI 呼叫經 `src/main/llm/provider/`。
  - 兩條路徑的待辦套用共用同一份邏輯：`applyChatExtract`（`runOnce.ts`）。外掛的 `combinedApply.ts` 與 standalone 行為不分叉。

## 1. LINE 擷取（LINE → app DB）

- **來源**：`src/main/line/watcher.ts` 以 in-process TS 引擎（`src/main/line/engine/watchEngine.ts`）唯讀 LINE 本機資料庫。
  - 不再 spawn Python。`watch_json.py`、venv、NDJSON 契約與 `line-cua-win/` 子目錄已於 2026-08-11 移除，相關段落皆為歷史紀錄。
  - checkpoint 檔名沿用 `.watch_json_state`（`src/plugin/backend/assemble.ts`、`watchEngine.ts`）。
- **觸發**：`fs.watch` 事件（去抖約 800ms）加上間隔輪詢 fallback。預設 `intervalSec` 為 15 秒，可由 `LINE_POLL_SEC` 覆寫（`src/main/config/lineBridge.ts`）。有剩餘訊息時連續 drain。
- **增量**：checkpoint 只在 DB commit 成功後才前進（`commitAndAcknowledge`）。
- **落庫**：`insertMessages` 以 `msg_id` 去重，新列 `processed=0`（`src/main/db/messages.repo.ts`）。
- **單輪上限**：預設 500 則。

## 2. 篩選與 AI 輸入

- **挑選條件**：`processed=0`、聊天室未 `blocked`、聊天室待辦開關開啟。
  - 開關存於 `chat_todo_preferences`（`src/main/db/chatTodoPrefs.repo.ts`）。無列即開啟。
  - `chats.blocked=1` 為 fail-closed 的遺留語意（同檔 `isTodoExtractEnabled`）。
- **噪音規則**（`src/main/pipeline/blocklist.ts`，預設值在 `src/main/config/defaults.ts`）：
  - `contentTypeNoiseOnly: [7]`（貼圖）、`minTextLenForLLM: 2`。
  - 整批皆為噪音的聊天室直接標為 processed，不送 AI。
- **逐聊天室關鍵字忽略**：`chatIgnoreKeywords`。命中的新待辦草稿在套用時略過（`runOnce.ts`，`matchesChatIgnoreKeyword`）。
- **AI 輸入**：本批新訊息、`recentContextLimit`（預設 10）則上下文、該聊天室未完成待辦、身份候選，以及使用者核准的聊天室分類修正（`chatScopedClassificationCorrections`，只適用於該聊天室）。
- **Prompt**：`src/main/llm/extractPrompt.ts`（`EXTRACT_SYSTEM_PROMPT`）。
  - 三種 bucket：`todo`、`waiting`、`schedule`；`importance`：`action` / `fyi` / `noise`。
  - 含低信心召回規則（信心 0.4~0.7 仍可抽出）與 title 強制規則（佔位字需降信心）。
  - 第 38 行仍寫「低信心 … 交使用者裁決」。待確認功能已於 `8025aca` 移除，見 §12。
- **輸出驗證**：`src/shared/extractResult.ts` 的 `validateExtractResult`（zod）。送給模型的 JSON schema 在 `src/main/llm/schema.ts`。

## 3. 套用 AI 結果（`applyChatExtract`，單一交易）

每個聊天室的已驗證結果，在同一個 immediate transaction 內依序套用（`src/main/pipeline/runOnce.ts`）。

### 3.1 新待辦草稿與身份決策

取代舊計畫的「標題正規化近似比對」。現行做法：

- AI 對每個 `newTodo`（以 `draftRef` 對應）回傳 `identityDecisions`，`outcome` 為 `new`、`update_existing` 或 `link`。
- **new**：建立新卡。bucket 對應初始 status：`todo`→`pending`、`waiting`→`waiting_reply`、`schedule`→`scheduled`。
- **update_existing**：併入既有未完成待辦，更新 title/detail/priority/dueAt/bucket，並合併 `source_msg_ids`。
  - 候選若為終態（`done` / `dismissed`），只在 `same_completed_action` 且事件時間可比較時併入；否則降級為新建（程式標記 R1、R6）。
  - 候選 revision 不符時拋錯（`identity_candidate_revision_stale`）。
- **link**：建立新卡，並寫入 `proposed` 關聯（`todo_identity_relations` 或 `todo_topic_identity_relations`）。低於信心門檻時兩者皆不寫（見 §5）。
- **recurrence**：若候選已完成，只有 `fresh_occurrence` 且事件時間晚於完成時間才成立新一次；否則降級為新建（程式標記 R4、R5）。
- 所有會新建卡的草稿（`new`、`link`，以及被降級為新建的 R1、R4、R5、R6）都受 §5（行為 B）的信心門檻約束。只有未降級、真正併入既有待辦的 `update_existing` 不受門檻影響。

### 3.2 完成判定（`resolved`）

- 只接受本聊天室 `openTodos` 內的 `todoId`。`done` 與 `suggested_done` 的待辦略過。
- **無信心門檻。** 完成與否只看證據（見 §4，行為 A）。
- 判定結果：
  - `schedule` 且 `dueAt` 仍在未來 → `suggested_done`（待使用者在看板確認）。
  - 其他情況 → `done`，寫入 `completion_evidence` 與 `resolved_at`，並建立 decision 紀錄。
- 「近似比對 → suggested_done」（舊計畫 §6.6）**未實作**，見 §12。

### 3.3 重新分類（`updates`）

- 只對本聊天室 openTodos 內的待辦重新分類（`reclassifyTodo`）。同一輪已 resolved 的待辦略過。
- `bucket=schedule` 的結果 status 設為 `scheduled`。

### 3.4 收尾

- 本聊天室本批訊息標為 `processed`（`markProcessed`）。被略過的訊息也會標為 processed，不會因單筆失敗而重抽。

## 4. 行為 A：完成判定缺有效來源訊息時，只略過該筆

**規則**：AI 判定某待辦已完成，但完成證據（`evidenceMsgIds`）為空，或含本輪不存在的訊息 ID 時，**只略過該筆 resolved**。待辦維持原狀態、不寫完成紀錄。同一聊天室其他結果照常寫入，**不回滾整個聊天室**。

實作分兩層：

1. **驗證層**（`src/shared/extractResult.ts`，`validateExtractResult`）：
   - `hasValidEvidence` 檢查證據非空，且每個 ID 都在本輪選取的訊息中。
   - 不合格的 `resolved` 直接過濾掉，不拒絕整批。
   - zod schema 的 `evidenceMsgIds` 允許空陣列（`min(1)` 已移除），因此空證據會進到過濾步驟，而不是整批 parse 失敗。
2. **套用層**（`runOnce.ts`，`buildTodoApply` 的 resolved 迴圈）：
   - 若待辦會被標為 `done`，而證據 ID 不在本輪事件時間表（`eventTsById`）中，略過該筆。
   - 會被標為 `suggested_done` 的未來行程，仍依驗證層的過濾結果處理。

**已知的模型端不一致**：送給模型的 JSON schema（`src/main/llm/schema.ts`，`evidenceMsgIds`）仍是 `minItems: 1`。zod 與送模型的 schema 是否要統一，待 Manager 判斷（見 §12）。

## 5. 行為 B：新建待辦卡的信心下限

**規則**：凡是**會新建一張待辦卡**的 AI 草稿，若 `confidence` 低於 `TODO_NEW_MIN_CONFIDENCE`（0.4，`src/main/config/defaults.ts`），就不建卡。這批訊息仍照常標為 processed。

- **適用**：所有會新建卡的草稿，包括 `outcome=new`、`outcome=link`，以及被降級為新建的草稿：`update_existing` 的終態候選不符合併入條件（R1），或非終態候選狀態不符／reason 為 `same_completed_action`（R6）；`new`／`link` 的 recurrence 不成立時降級（R4 為終態候選，R5 為非終態候選）。
- **不適用**：未降級、真正併入既有待辦的 `update_existing`。這種情況不建卡，不受此門檻影響。
- **判定位置**（`runOnce.ts`，`buildTodoApply` 內）：
  - `createNewTodo` 開頭（約第 267 行）：涵蓋 R1、R4、R5、R6。
  - 一般 `new`／`link` 分支，在 `identity_link_target_missing` 檢查之後、`createCanonicalTodo` 之前（約第 325 行）。
- **實作狀態**：所有新建點皆已套用門檻。低於門檻時訊息仍由 `markProcessed` 標為 processed。

## 6. 資料模型

- **SQLite schema 版本**：`SCHEMA_VERSION = 10`（`src/main/db/schema.ts`），由 `migrate.ts` 依 `user_version` 升級。
- **DDL 的權威來源是 `src/main/db/schema.ts`**。`schema.sql` 為可讀參考，兩者須同步。本檔不再重複完整 DDL。
- **主要資料表**：
  - `chats`、`messages`（`processed` 旗標）。
  - `todos`：`bucket ∈ {todo, waiting, schedule}`；`status ∈ {pending, waiting_reply, scheduled, done, suggested_done, dismissed}`（`schema.ts` 約第 248 行）。另有 `chat_id`、`priority`、`due_at`、`source_msg_ids`、`confidence`、`completion_evidence`、`resolved_at`。
  - 身份與去重：`todo_identity_*`、`todo_identity_relations`、`todo_topic_identity_relations`。
  - 不是我的與修正：`todo_not_mine_events`、`todo_classification_corrections`、`todo_correction_effects`。
  - 聊天室待辦開關：`chat_todo_preferences`。
  - 議題（與待辦分開）：`group_topics_meta`、`discussion_topics`、`topic_*`。
  - 執行紀錄：`pipeline_runs`。
- **來源快取**：`chat_context_cache` 與 `ux_messages_chat_msg`（`schema.ts` 的 `SOURCE_CACHE_DDL`）。

## 7. 狀態流轉

| 觸發 | 結果 |
|---|---|
| AI 新建（`new`） | `todo`→`pending`、`waiting`→`waiting_reply`、`schedule`→`scheduled` |
| AI `resolved`，非未來行程 | `done`，寫 `completion_evidence`、`resolved_at` |
| AI `resolved`，未來行程 | `suggested_done` |
| AI `updates` | `bucket=schedule`、`status=scheduled` |
| AI `update_existing` | 非終態：更新內容；狀態不在可併入集合或 reason 為 `same_completed_action` 時降級為新建（R6）。終態：僅 `same_completed_action` 且可比較時併入，否則降級為新建（R1）。降級為新建者同樣受 §5 門檻約束 |
| 看板操作（完成、確認、還沒、忽略、不是我的、延後、拖曳） | 見 `src/renderer/store/useTodos.ts` 與 `src/main/db/todos.repo.ts`。本檔未逐一復驗 |

## 8. IPC 通道（todos）

定義於 `src/main/ipc/todos.ipc.ts` 與 `src/main/ipc/settings.ipc.ts`。

| 通道 | 現況 |
|---|---|
| `todos:list` | 查待辦清單 |
| `todos:get` | 查單筆 |
| `todos:openByChat` | 查某聊天室未完成待辦 |
| `todos:updateStatus` | 改 status。**只檢查 `id` 為字串，不驗證 `status` 值**（見 §12） |
| `todos:update` | 改欄位（經 `sanitizeUpdatePatch`） |
| `todos:moveColumn` | 拖曳換欄，`toColumn` 須在 `VALID_COLUMNS` 內 |
| `todos:draftReply` | 草擬回覆，只回字串，不送出（`settings.ipc.ts`） |
| `todos:bulkUpdateStatus` | **未實作** |

## 9. UI

- 看板欄位：待辦、等回覆、行程、已完成（`src/renderer/components/Board/buckets.ts`）。`dismissed` 不顯示。
- 待辦卡顯示信心百分比（`TodoCard.tsx`，`Math.round(todo.confidence * 100)`）。
- 「待確認」功能已移除（`8025aca`）。卡片不提供「待確認」操作，只顯示信心百分比。
- 聊天頁「我的事項」與議題頁「聊天室近況」分開（議題不建立待辦，只能建立 proposed 關聯）。

## 10. 去重

- **主要機制**：AI 身份決策 + 候選召回（§3.1）。
- **標題正規化近似比對**：`src/main/pipeline/dedup.ts` 的 `normalizeTitle` 存在，但 `src/` 內無任何 import，**目前未接入套用流程**。是否保留、刪除或接入，未確認。
- **訊息層去重**：`messages.msg_id` 為主鍵，`INSERT OR IGNORE`。同一則訊息不會重複抽取。

## 11. 排程與節奏

- **外掛路徑**：LINE watcher 預設 15 秒（`lineBridge.ts`）；`ExtractWorker` 輪詢間隔 15 秒（`extractWorker.ts`，`pollIntervalMs: 15_000`）；租約預設 120 秒（`extractQueue.ts`，`DEFAULT_LEASE_MS`）。
- **standalone 路徑**：`scheduler.ts` 的 `pollIntervalSec` 預設 30 秒（`defaults.ts`，可由 `QWEN_POLL_SEC` 覆寫）。
- **端到端延遲**：未實測，本檔不承諾數字。

## 12. 未實作、待決與待補項目

以下項目保留以供追蹤。

| # | 項目 | 狀態 |
|---|---|---|
| 1 | 自動黑名單（官方帳號等自動 block，`block_reason='auto:*'`） | **未實作**。現況只有手動開關（`chat_todo_preferences`）與 `chats.blocked` 遺留語意 |
| 2 | `todos:bulkUpdateStatus` IPC | **未實作** |
| 3 | `todos:updateStatus` 驗證 `status` 值 | **未實作**（待補） |
| 4 | 標題近似比對保險（`dedup.ts` 接入套用流程） | **未接線**，未確認保留或刪除 |
| 5 | 近似比對 → `suggested_done`（舊計畫 §6.6） | **未實作**。現行 `suggested_done` 只用於未來行程 |
| 6 | Prompt 第 38 行「交使用者裁決」 | 文字與程式不一致。待確認功能已移除，待決：刪除 prompt 文字，或恢復 UI |
| 7 | zod 放寬 `evidenceMsgIds` 與送模型的 JSON schema（`minItems: 1`）不一致 | **待 Manager 判斷** |

## 13. 未驗證項目（原計畫 §9）

- **better-sqlite3 ABI**：現況使用 `better-sqlite3-multiple-ciphers`（`package.json` 的 `rebuild` 腳本已列入）。驗證紀錄**未確認**。
- **safeStorage**：`src/main/index.ts` 使用 Electron `safeStorage`（第 1、98–101 行）。Windows 後端可用性的驗證紀錄**未確認**。
- **LINE `_message._id` 唯一性**：未對大量資料驗證，**未確認**。
- **Qwen `response_format` 與 `guided_json`**：原計畫的 qwen 直連路徑（`src/main/llm/qwenClient.ts`）仍在，現行主要 AI 路徑為 provider 抽象（`src/main/llm/provider/`）。兩者的實機驗證紀錄**未確認**。
- **輪詢節奏端到端**：見 §11，未實測。

## 14. 歷史里程碑（僅供脈絡）

原計畫 M0 至 M3（鷹架、LINE 橋接、抽取、看板）已各自演進，實際結構見上文各節。M4（electron-builder 打包）不在本檔範圍。`package.json` 已有 `dist` 腳本，其驗證狀態**未確認**。
