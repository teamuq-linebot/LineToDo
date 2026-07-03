# line-todo 實作規格（IMPLEMENTATION_PLAN.md）

> 定時監控 LINE 新訊息 → 自架 qwen LLM 語意抽取代辦 → 看板呈現（待辦 / 等回覆 / 行程 / 已完成）
> Electron + Vite + React + TypeScript 桌面 App。回應語言：繁體中文。
> 本檔為可直接施工的規格。M4 打包（electron-builder）不在本輪範圍。

> **引擎現況（2026-07-03 Batch 5 更新）**：訊息讀取／解媒體／backfill 已純 TS 化（in-process watchEngine + koffi + better-sqlite3-multiple-ciphers），**預設引擎為 `ts`，不再需要外部 Python**。本檔以下大量描述的 venv python / `watch_json.py` spawn 路徑已降級為**緊急 fallback**：設 `LINE_ENGINE=py`（或 `python`）才會回退舊路徑，未設或空字串一律走 `ts`。詳見 `src/main/config/lineBridge.ts` 的 `getLineEngine()`。

---

## 0. 既有資產的「實際」函式簽名（已讀原始碼確認，非假設）

來源：`C:/Users/david/line-cua-win/src/linedb.py`、`C:/Users/david/line-cua-win/src/watch.py`（2026-06-26 實讀）。

### linedb.py（純讀、離線、解密 LINE Desktop edb）
| 函式 | 簽名 | 回傳 |
|---|---|---|
| `open_db()` | `open_db()` | `apsw.Connection`；內部 snapshot edb(+wal/shm) 到 temp、`PRAGMA cipher='aes128cbc'`、`kdf_iter=1`、`key=<32hex>`，並 `wal_checkpoint(TRUNCATE)`。失敗時 `raise SystemExit(json...)` |
| `my_mid(con)` | `my_mid(con)` | 自己的 `_mid`（字串）或 `None` |
| `chat_name(con, chat_id)` | `chat_name(con, chat_id)` | 顯示名稱字串或 `None`（依序查 `_groupChat` → `_square` → `_contact`） |
| `list_chats(con, limit=50)` | `list_chats(con, limit=50)` | `list[{chatId, name, lastUpdated(iso), isGroup}]`；**`isGroup = chatId[:1] != "u"`**（1:1 為 "u" 開頭，其餘 c/m/t/未知一律當 group，send guard fail-closed） |
| `resolve_chat(con, name)` | `resolve_chat(con, name)` | chatId；接受 raw chatId / 完全相符名稱 / 唯一子字串；歧義或查無 `raise SystemExit(json)` |
| `read_history(con, chat_id, limit=0)` | `read_history(con, chat_id, limit=0)` | `list[{id, time(iso), ts(ms int), direction("in"/"out"), sender, text}]`；`limit>0` 取最後 N 筆 |
| `chat_coverage(con, chat_id)` | `chat_coverage(con, chat_id)` | 覆蓋率 dict（count / oldest / newest …） |
| `iso(ms)` | `iso(ms)` | `ms`(epoch 毫秒) → 本地時間 ISO8601（`timespec="seconds"`，**無時區後綴**）；`ms` falsy 回 `None` |
| `CT` | `dict` | `_contentType` → label：`{0:None,1:"[image]",2:"[video]",3:"[audio]",7:"[sticker]",6:"[call]",13:"[contact]",14:"[file]",16:"[album]"}`；未知用 `f"[type={ct}]"` |

關鍵欄位語意（給 LLM/DB 用）：
- `ts` = epoch **毫秒**（int）；`time` = 本地 ISO8601 字串（秒精度、無 tz）。
- `direction`：`"out"` = 自己發的（`_from == my_mid`），`"in"` = 別人發的。
- `text` 對非文字訊息會是 `CT` 的 label（例如 `[image]`），而非原文。

### watch.py（stat-gate 輪詢，目前輸出人類可讀文字）
| 函式 | 簽名 | 回傳 / 行為 |
|---|---|---|
| `wal_sig()` | `wal_sig()` | `{edb:(size,mtime_ns)|None, -wal:(...)|None}`；stat gate 用 |
| `load_state()` / `save_state(s)` | — | 讀寫 `STATE = <REPO_ROOT>/.watch_state`（JSON：`{last_ts, sig}`） |
| `new_messages(con, since_ts, name=None)` | `new_messages(con, since_ts, name=None)` | `list[{chat, time, ts, direction, sender, text}]`；`_createdTime > since_ts`；`name` 給定則只取該 chat |
| `poll(name=None, verbose=True)` | `poll(name=None, verbose=True)` | 回新訊息 list 並**更新 checkpoint**；sig 未變則回 `[]`（跳過 ~200MB copy）；首次無 last_ts 時把 checkpoint 設為 `MAX(_createdTime)` |
| CLI | `--demo / --reset-now / --once / --follow --interval N [--name X]` | 目前印 `fmt(m)` 人類可讀字串 |

> **⚠️ 重要落差（施工必看）**：`watch.new_messages()` 目前輸出**只有** `{chat, time, ts, direction, sender, text}`，
> **缺** `chatId`、`isGroup`、`contentType` 三個本 App NDJSON 契約需要的欄位。
> 因此本輪需在 line-cua-win 新增一支 **`watch_json.py`**（不改動現有 watch.py，純加法），
> 重用 `linedb.open_db / my_mid / chat_name / CT / iso`、`linekey.find_db / REPO_ROOT`，
> 輸出補齊欄位的 NDJSON。詳見 §3。`_contentType` 需在該 SQL 一併 SELECT（`new_messages` 原本已 select 了 `_contentType`，只是沒放進 dict）。

---

## 1. 完整檔案樹

electron-vite 標準三進程結構（main / preload / renderer）。

```
C:/Users/david/line-todo/
├─ IMPLEMENTATION_PLAN.md          # 本檔
├─ package.json
├─ tsconfig.json                   # base（references 指向三個子 tsconfig）
├─ tsconfig.node.json              # main + preload（node 環境）
├─ tsconfig.web.json               # renderer（DOM 環境）
├─ electron.vite.config.ts         # electron-vite 設定（main/preload/renderer 三段）
├─ .env.example                    # QWEN_API_KEY=、QWEN_BASE_URL=、QWEN_MODEL= 範例（不進版控真值）
├─ .gitignore                      # node_modules / out / dist / *.local / .env
├─ electron-builder.yml            # 預留（M4 才用，本輪不執行）
│
├─ resources/                      # 打包時隨附的非程式資源（icon 等，M4）
│
├─ src/
│  ├─ main/                        # ── Electron main 進程（Node）──
│  │  ├─ index.ts                  # app 入口：建 BrowserWindow、註冊 IPC、啟動排程器
│  │  ├─ window.ts                 # createWindow()（contextIsolation:true, sandbox, preload 路徑）
│  │  ├─ ipc/
│  │  │  ├─ index.ts               # registerIpc(ipcMain)：集中註冊所有 handler
│  │  │  ├─ messages.ipc.ts        # messages:* 通道
│  │  │  ├─ todos.ipc.ts           # todos:* 通道
│  │  │  ├─ settings.ipc.ts        # settings:* 通道（含 safeStorage 金鑰）
│  │  │  └─ pipeline.ipc.ts        # pipeline:*（手動觸發一輪、查狀態）
│  │  ├─ db/
│  │  │  ├─ database.ts            # better-sqlite3 連線單例（app.getPath('userData')/line-todo.db）
│  │  │  ├─ schema.sql             # DDL（見 §4，啟動時 exec）
│  │  │  ├─ migrate.ts             # user_version pragma 版本遷移
│  │  │  ├─ chats.repo.ts          # upsertChat / listChats / setBlocklist
│  │  │  ├─ messages.repo.ts       # insertMessages(batch) / listMessages / getRecentByChat
│  │  │  └─ todos.repo.ts          # CRUD + 狀態轉移 + 取某 chat 未完成 todo（餵 LLM 去重）
│  │  ├─ line/
│  │  │  ├─ watcher.ts             # spawn venv python watch_json.py --once，解析 NDJSON → Message[]
│  │  │  └─ types.ts               # RawLineMessage（對齊 §3 NDJSON 契約）
│  │  ├─ llm/
│  │  │  ├─ qwenClient.ts          # openai SDK，baseURL=qwen.tuq.tw/v1，guided_json
│  │  │  ├─ extractPrompt.ts       # system prompt 全文（§6）+ buildUserPayload()
│  │  │  ├─ schema.ts              # zod schema + 對應 json_schema（guided_json）
│  │  │  └─ extractor.ts           # extractTodos(chat, recentMsgs, openTodos) → ExtractResult
│  │  ├─ pipeline/
│  │  │  ├─ scheduler.ts           # setInterval 輪詢（預設 30s），可暫停/手動觸發，並發節流(1-2)
│  │  │  ├─ runOnce.ts             # 一輪：watcher→filter(blocklist)→group by chat→qwen→落 todos
│  │  │  └─ concurrency.ts         # 簡易 p-limit（不引外部相依）
│  │  ├─ config/
│  │  │  ├─ settings.ts            # 讀寫 settings.json（userData），safeStorage 加密 QWEN key
│  │  │  └─ defaults.ts            # 預設值：pollIntervalSec=30, concurrency=2, blocklist 預設規則(§7)
│  │  └─ util/
│  │     ├─ logger.ts              # 檔案 + console log（userData/logs）
│  │     └─ paths.ts               # venv python / watch_json.py 絕對路徑解析（§3）
│  │
│  ├─ preload/                     # ── preload（contextBridge 橋接）──
│  │  └─ index.ts                  # exposeInMainWorld('api', {...})：白名單 invoke/on 封裝
│  │
│  └─ renderer/                    # ── renderer（React）──
│     ├─ index.html
│     ├─ main.tsx                  # React 掛載
│     ├─ App.tsx                   # 版面：看板 + 設定頁切換
│     ├─ vite-env.d.ts
│     ├─ types/
│     │  └─ api.d.ts               # window.api 型別（與 preload 對齊）
│     ├─ store/
│     │  └─ useTodos.ts            # 狀態管理（可用 zustand 或 useReducer；MVP 用 React state hook）
│     ├─ hooks/
│     │  ├─ useIpc.ts              # 包 window.api.invoke / 訂閱 push event
│     │  └─ usePipelineStatus.ts
│     ├─ components/
│     │  ├─ Board/
│     │  │  ├─ KanbanBoard.tsx     # 四欄看板容器
│     │  │  ├─ Column.tsx          # 單欄（待辦/等回覆/行程/已完成）
│     │  │  ├─ TodoCard.tsx        # 單張代辦卡（含來源訊息、信心、操作鈕）
│     │  │  └─ buckets.ts          # bucket/status → 欄位映射、顏色、標題
│     │  ├─ Settings/
│     │  │  ├─ SettingsPanel.tsx   # 輪詢頻率 / 並發 / QWEN key / 黑名單編輯
│     │  │  ├─ BlocklistEditor.tsx
│     │  │  └─ ApiKeyField.tsx     # 寫入 safeStorage（不顯示明文）
│     │  ├─ DraftReplyDialog.tsx   # 「等回覆」草擬回覆（MVP 只草擬不送出）
│     │  └─ common/                # Badge / Button / Spinner …
│     └─ styles/
│        └─ index.css
│
└─ scripts/                        # 開發輔助腳本（依環境守則：複雜邏輯包成檔案）
   ├─ check-line-bridge.mjs        # 跑一次 watch_json.py 驗證 NDJSON 可解析
   └─ smoke-qwen.mjs               # 用 QWEN_API_KEY 打一次 /v1/models 驗證連線
```

新增到 **line-cua-win**（純加法、不改現有檔）：
```
C:/Users/david/line-cua-win/src/
└─ watch_json.py                   # NDJSON 版 watch（§3）
```

---

## 2. package.json 依賴清單

> 版本標主版本（major），施工時 `npm i` 取該 major 最新穩定。better-sqlite3 為 native module，需與 Electron ABI 對齊（用 electron-rebuild / @electron/rebuild）。

```jsonc
{
  "name": "line-todo",
  "version": "0.1.0",
  "description": "LINE 新訊息語意抽取代辦看板（Electron + qwen）",
  "main": "out/main/index.js",
  "author": "",
  "license": "UNLICENSED",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "start": "electron-vite preview",
    "typecheck:node": "tsc -p tsconfig.node.json --noEmit",
    "typecheck:web": "tsc -p tsconfig.web.json --noEmit",
    "typecheck": "npm run typecheck:node && npm run typecheck:web",
    "rebuild": "electron-rebuild -f -w better-sqlite3",
    "postinstall": "electron-rebuild -f -w better-sqlite3",
    "smoke:line": "node scripts/check-line-bridge.mjs",
    "smoke:qwen": "node scripts/smoke-qwen.mjs"
  },
  "dependencies": {
    "better-sqlite3": "^11",        // main 進程 SQLite（同步、快）；native，需 rebuild
    "openai": "^4",                 // qwen OpenAI 相容 client（baseURL 指向 qwen.tuq.tw/v1）
    "zod": "^3"                     // LLM 輸出驗證 + 由 zod 衍生 json_schema
  },
  "devDependencies": {
    "electron": "^31",              // 桌面 runtime
    "electron-vite": "^2",          // 三進程 Vite 鷹架（dev/build）
    "vite": "^5",                   // 由 electron-vite 帶；顯式列以鎖 major
    "@vitejs/plugin-react": "^4",   // renderer React 轉譯
    "react": "^18",
    "react-dom": "^18",
    "@types/react": "^18",
    "@types/react-dom": "^18",
    "@types/better-sqlite3": "^7",
    "@types/node": "^20",
    "typescript": "^5",
    "@electron/rebuild": "^3",      // better-sqlite3 對 Electron ABI rebuild（提供 electron-rebuild bin）
    "electron-builder": "^24"       // 預留 M4 打包，本輪不執行
  }
}
```

備註：
- **不**引入 drag-and-drop 套件；MVP 看板用按鈕做狀態轉移即可，降低相依。
- zod → json_schema 可用 `zod-to-json-schema`（可選 `^3`）；若不想多裝相依，§6 直接手寫 json_schema 常數（規格已提供完整 schema），zod 只在 runtime parse 用。施工二擇一，預設**手寫 json_schema 常數 + zod runtime 驗證**，避免兩者漂移。
- electron-vite `^2` 內含 vite，`vite` 列出僅為鎖版本，安裝衝突時可移除顯式 vite 項。

---

## 3. line-cua-win 的 `watch_json.py` NDJSON 輸出契約

新增 `C:/Users/david/line-cua-win/src/watch_json.py`，**純加法**、重用既有模組，輸出 NDJSON（每則訊息一行 JSON）。

### CLI（據實列出 watch_json.py 實作的旗標，2026-06-26 對齊原始碼）
```
python watch_json.py --once            # 預設：從 checkpoint 起的新訊息，逐行 JSON 印到 stdout
python watch_json.py --follow --interval <N>  # 常駐輪詢，每 N 秒一輪（預設 15），逐行 NDJSON
python watch_json.py --reset-now       # checkpoint = 最新一則訊息（與 watch.py 同語意，重新起算）
python watch_json.py --since <ms>      # 忽略 checkpoint，取 _createdTime > ms（除錯/補抓；不動 state）
python watch_json.py --limit <N>       # 單輪安全上限，避免暴量（預設 500）
python watch_json.py --name "<chat>"   # 只取單一聊天室（依名稱 resolve）
python watch_json.py --json            # no-op，僅為與 watch.py CLI 對稱（NDJSON 本就是唯一輸出）
```
- 預設（無旗標）等同 `--once`。
- **App 實際 spawn 方式**：watcher.ts 用 `--follow --json --interval <pollIntervalSec> --limit <limit>` 常駐子程序，逐行讀 stdout NDJSON；`--once` 供 `scripts/check-line-bridge.mjs` 等一次性驗證用。
- **checkpoint 獨立**：用自己的 state 檔 `<REPO_ROOT>/.watch_json_state`，**不共用** watch.py 的 `.watch_state`，避免兩個消費者互相吃掉對方的 checkpoint。
- stat-gate 沿用 `wal_sig()` 邏輯（edb/-wal 的 size+mtime_ns 未變則輸出 0 行、exit 0，跳過 ~200MB 解密複製）。
- 解密/金鑰錯誤：印**一行** `{"error": "..."}` 到 **stderr**，exit code `2`；stdout 不混入錯誤。
- 全程 `ensure_ascii=False`，UTF-8。Windows 下 Python 需 `PYTHONUTF8=1` 或 `reconfigure(encoding="utf-8")`（watcher.ts spawn 時設 env，見下）。

### 每行 JSON 欄位契約（嚴格）
```jsonc
{
  "msgId":       "abc123...",     // LINE _message._id 原生全域唯一訊息 id（去重真鍵）；無 _id 的罕見列為 null
  "chat":        "string",        // 顯示名稱；linedb.chat_name(con, chatId) 或回退 chatId
  "chatId":      "string",        // _chatId 原值（唯一鍵，給 DB / 去重用）
  "isGroup":     true,            // chatId[:1] != "u"（與 list_chats 同規則，fail-closed）
  "ts":          1719300000000,   // epoch 毫秒 int（= _createdTime）
  "time":        "2026-06-25T14:00:00",  // linedb.iso(ts)，本地、秒精度、無 tz
  "direction":   "in",            // "in"=別人 / "out"=自己（_from == my_mid → out）
  "sender":      "Abby",          // "me"（out 時）或 chat_name(_from) 或 _from
  "text":        "明天三點開會",   // 文字；非文字訊息為 CT label（如 "[image]"）
  "contentType": 0                // _contentType 原始 int（0=文字，其餘見 linedb.CT）
}
```
欄位順序不保證；消費端以 key 取值。`null` 可能出現在 `chat`/`sender` 退化情境（已用 `or chatId` / `or _from` 回退，理論上非 null），以及 `msgId`（罕見無 `_id` 的列）。

**去重鍵（msg_id）推導：prefer-real-_id, fallback-hash**（`schema.ts deriveMsgId`）：
- 有 `msgId` → `msg_id = "i:" + msgId`。LINE 原生 id 跨 chat 全域唯一，保證同一則訊息恆同、不同訊息恆異。
- 無 `msgId`（null/空）→ fallback `msg_id = "d:" + sha1(chatId \x01 ts \x01 direction \x01 sender \x01 text)`。
- 為何需要真 id：舊版只用 fallback hash，但 `text` 對非文字訊息已被替換成 CT label（如 `[image]`），同一秒多張圖會讓 `(chatId,ts,direction,sender,text)` 完全相同 → hash 撞鍵 → `INSERT OR IGNORE` 把不同訊息壓成一筆（H2）。改用真 `_id` 後消除此漏吃。

### 實作要點（給寫 watch_json.py 的人）
```python
# 重用：linedb.open_db / my_mid / chat_name / CT / iso；linekey.find_db / REPO_ROOT
# SQL（對齊 watch.new_messages，但 dict 補欄位）：
#   SELECT _chatId,_createdTime,_from,_text,_contentType,_id FROM _message
#   WHERE _createdTime > ? ORDER BY _createdTime LIMIT ?
# 對每列（_chatId,_createdTime,_from,_text,_contentType,_id 解構為 c,t,frm,text,ct,mid）：
#   msgId = str(mid) if mid is not None else None   # ← LINE _message._id，去重真鍵
#   chatId = c
#   isGroup = chatId[:1] != "u"
#   body = text if text else (linedb.CT.get(ct) or f"[type={ct}]")
#   direction = "out" if frm == me else "in"
#   sender = "me" if direction=="out" else (linedb.chat_name(con,frm) or frm)
#   chat = linedb.chat_name(con, chatId) or chatId
#   印 json.dumps({msgId,chat,chatId,isGroup,ts:t,time:linedb.iso(t),
#                  direction,sender,text:body,contentType:ct}, ensure_ascii=False)
# checkpoint：成功輸出後 last_ts = max(ts)；若無新訊息且首次，last_ts = MAX(_createdTime)
```

### main 進程如何叫它（watcher.ts）
- venv python 絕對路徑：`C:/Users/david/line-cua-win/.venv/Scripts/python.exe`
- 腳本絕對路徑：`C:/Users/david/line-cua-win/src/watch_json.py`
- 這兩個路徑放在 `settings.json`（可在設定頁覆寫），預設值寫死在 `defaults.ts`。
- `spawn(python, ['watch_json.py','--once','--limit','500'], { cwd: 'C:/Users/david/line-cua-win/src', env: { ...process.env, PYTHONUTF8:'1', PYTHONIOENCODING:'utf-8' } })`
- 逐行讀 stdout（`readline`），每行 `JSON.parse` → `RawLineMessage`；解析失敗的行記 log 跳過、不中斷整輪。
- exit code `2` 或 stderr 有 `{"error":...}` → 該輪標記為「LINE 橋接失敗」，pipeline status 設 `lineBridge:'error'`，UI 顯示提示（常見：LINE 未開啟、金鑰過期）。

---

## 4. SQLite DDL（better-sqlite3，App 自己的 DB）

位置：`app.getPath('userData')/line-todo.db`（與 line-cua-win 的 edb 完全分離；本 App 只新增、不寫回 LINE）。
`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`，並用 `PRAGMA user_version` 管遷移。

```sql
-- schema.sql  (user_version = 1)
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── 聊天室（含降噪黑名單旗標）──────────────────────────────
CREATE TABLE IF NOT EXISTS chats (
  chat_id        TEXT PRIMARY KEY,          -- LINE _chatId
  name           TEXT,                      -- 顯示名稱（可能隨時間更新）
  is_group       INTEGER NOT NULL DEFAULT 0,-- 0/1
  blocked        INTEGER NOT NULL DEFAULT 0,-- 1 = 黑名單（不進 LLM 管線）
  block_reason   TEXT,                      -- 'auto:official' / 'auto:keyword' / 'manual' ...
  first_seen_at  TEXT NOT NULL,             -- ISO8601 (App 端寫入時間)
  last_seen_at   TEXT NOT NULL
);

-- ── 原始訊息鏡像（去重 + 給 LLM 上下文）────────────────────
CREATE TABLE IF NOT EXISTS messages (
  msg_id         TEXT PRIMARY KEY,          -- LINE _message._id（跨 chat 唯一）
  chat_id        TEXT NOT NULL,
  ts             INTEGER NOT NULL,          -- epoch 毫秒
  time_iso       TEXT NOT NULL,             -- 本地 ISO8601（顯示用）
  direction      TEXT NOT NULL CHECK(direction IN ('in','out')),
  sender         TEXT,
  text           TEXT,                      -- 文字或 CT label
  content_type   INTEGER NOT NULL DEFAULT 0,
  processed      INTEGER NOT NULL DEFAULT 0,-- 0=未進 LLM / 1=已抽取過
  ingested_at    TEXT NOT NULL,             -- App 端落庫時間 ISO8601
  FOREIGN KEY (chat_id) REFERENCES chats(chat_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_ts   ON messages(chat_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_unproc    ON messages(processed, chat_id);

-- ── 代辦（看板核心）────────────────────────────────────────
-- status：pending=待辦 | waiting_reply=等回覆 | scheduled=行程 |
--         done=已完成 | suggested_done=建議完成(待確認) | dismissed=已忽略
-- bucket：三分類落點 'todo' | 'waiting' | 'schedule'
--         （done/suggested_done/dismissed 沿用其原 bucket，看板「已完成」欄以 status 過濾）
CREATE TABLE IF NOT EXISTS todos (
  id                  TEXT PRIMARY KEY,     -- App 產生 uuid
  chat_id             TEXT NOT NULL,
  bucket              TEXT NOT NULL CHECK(bucket IN ('todo','waiting','schedule')),
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending','waiting_reply','scheduled',
                                         'done','suggested_done','dismissed')),
  title               TEXT NOT NULL,        -- 一句話代辦摘要（LLM 產）
  detail              TEXT,                 -- 補充內容（LLM 產，可空）
  priority            INTEGER NOT NULL DEFAULT 2,  -- 1=高 2=中 3=低（LLM 建議，可調）
  due_at              TEXT,                 -- 行程/期限 ISO8601；無則 NULL
  source_msg_ids      TEXT NOT NULL,        -- JSON 陣列字串：來源 message msg_id（可多筆）
  confidence          REAL NOT NULL DEFAULT 0.5,   -- 0..1，LLM 抽取信心
  completion_evidence TEXT,                 -- 完成偵測證據（被哪則訊息/理由判定完成）
  created_at          TEXT NOT NULL,        -- ISO8601
  updated_at          TEXT NOT NULL,        -- ISO8601（每次狀態變更更新）
  resolved_at         TEXT,                 -- 進入 done/dismissed 的時間 ISO8601
  FOREIGN KEY (chat_id) REFERENCES chats(chat_id)
);
CREATE INDEX IF NOT EXISTS idx_todos_status   ON todos(status);
CREATE INDEX IF NOT EXISTS idx_todos_chat_open ON todos(chat_id, status);
CREATE INDEX IF NOT EXISTS idx_todos_due      ON todos(due_at);

-- ── App 設定（key-value；QWEN key 不存這裡，存 safeStorage 檔，見 §7）──
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                       -- JSON 字串
);

-- ── 每輪 pipeline 執行記錄（可觀測 / 除錯）─────────────────
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id            TEXT PRIMARY KEY,           -- uuid
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  new_msgs      INTEGER NOT NULL DEFAULT 0,
  chats_seen    INTEGER NOT NULL DEFAULT 0,
  todos_created INTEGER NOT NULL DEFAULT 0,
  todos_resolved INTEGER NOT NULL DEFAULT 0,
  line_bridge   TEXT NOT NULL DEFAULT 'ok', -- 'ok' | 'error' | 'skipped'
  llm_status    TEXT NOT NULL DEFAULT 'ok', -- 'ok' | 'partial' | 'error'
  note          TEXT
);
```

去重鍵：
- 訊息：`messages.msg_id`（LINE `_message._id`）為 PK，重複 insert 用 `INSERT OR IGNORE`。
- 代辦：靠把「該 chat 現有未完成 todo」餵回 LLM（§6），LLM 在 `resolved` 回報已解決、或不重複產生新 todo；App 端再以 `(chat_id, title 正規化)` 做最後一道近似去重保險（軟性）。

---

## 5. Electron main ↔ renderer IPC 通道清單

全部走 `ipcMain.handle` / `ipcRenderer.invoke`（request-response），加上少數 main→renderer 推播事件。
preload 以 `contextBridge.exposeInMainWorld('api', …)` 白名單暴露，renderer **不**直接碰 `ipcRenderer`。

### Request / Response（invoke）
| 通道 | 入參 | 回傳 | 說明 |
|---|---|---|---|
| `messages:list` | `{chatId?, limit?, beforeTs?}` | `Message[]` | 拉訊息鏡像（看板卡片展開來源用） |
| `messages:recentByChat` | `{chatId, limit=30}` | `Message[]` | 某 chat 最近 N 則（也是 LLM 上下文來源） |
| `chats:list` | `{includeBlocked?:boolean}` | `Chat[]` | 聊天室清單（設定頁黑名單管理） |
| `chats:setBlocked` | `{chatId, blocked, reason?}` | `Chat` | 切黑名單 |
| `todos:list` | `{statuses?, buckets?, chatId?}` | `Todo[]` | 看板拉代辦（預設拉全部非 dismissed） |
| `todos:get` | `{id}` | `Todo` | 單筆 |
| `todos:updateStatus` | `{id, status}` | `Todo` | 標完成 / 確認建議完成 / 忽略等狀態轉移 |
| `todos:update` | `{id, patch:{title?,detail?,priority?,dueAt?,bucket?}}` | `Todo` | 編輯欄位（含手動改 bucket） |
| `todos:bulkUpdateStatus` | `{ids[], status}` | `Todo[]` | 批次（如一次清空「建議完成」） |
| `todos:draftReply` | `{id}` | `{draft:string}` | 「等回覆」用 qwen 草擬回覆（**只回字串，不送出**） |
| `settings:get` | `—` | `Settings`（**不含**金鑰明文，只回 `hasApiKey:boolean`） | 讀設定 |
| `settings:update` | `{patch:Partial<Settings>}` | `Settings` | 改輪詢頻率 / 並發 / blocklist 規則等 |
| `settings:setApiKey` | `{apiKey:string}` | `{ok:true}` | 寫入 safeStorage（加密落檔），記憶體不長存 |
| `settings:clearApiKey` | `—` | `{ok:true}` | 清除金鑰 |
| `settings:testQwen` | `—` | `{ok:boolean, models?:string[], error?:string}` | 打 `/v1/models` 驗證金鑰/連線 |
| `pipeline:status` | `—` | `PipelineStatus` | `{running, lastRunAt, intervalSec, lineBridge, llmStatus, lastError?}` |
| `pipeline:runOnce` | `—` | `PipelineRunResult` | 手動立即跑一輪 |
| `pipeline:setRunning` | `{running:boolean}` | `PipelineStatus` | 暫停/恢復定時輪詢 |
| `app:openDataFolder` | `—` | `{ok:true}` | 開 userData 資料夾（除錯） |

### Push（main → renderer，`webContents.send`，preload 以 `api.on(channel, cb)` 暴露白名單）
| 事件 | payload | 何時 |
|---|---|---|
| `evt:pipeline-run` | `PipelineRunResult` | 每輪結束（讓看板自動刷新） |
| `evt:todos-changed` | `{createdIds[], resolvedIds[], updatedIds[]}` | todos 有異動 |
| `evt:pipeline-status` | `PipelineStatus` | 狀態變更（開始/暫停/橋接錯誤） |

preload 型別（renderer `window.api`）對齊上表；所有 channel 名稱在 preload 以常數白名單，拒絕任意 channel。

---

## 6. qwen client 介面 + 抽取 prompt + guided_json schema + 去重 + 完成偵測

### 6.1 qwen client 介面（qwenClient.ts）
```ts
import OpenAI from 'openai';
// baseURL 與 model 從 settings/env 取；apiKey 從 safeStorage 解密後「即用即丟」傳入
export function makeQwen(opts: { apiKey: string; baseURL: string }) {
  return new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL }); // baseURL = https://qwen.tuq.tw/v1
}
// 預設：model = "qwen36-fp8"；baseURL = "https://qwen.tuq.tw/v1"
// 結構化輸出走 response_format json_schema（vLLM guided_json）。
// 並發節流由 pipeline/concurrency.ts 控（1–2）；單次 request timeout 預設 60s，失敗該 chat 標 partial、不中斷整輪。
```
呼叫（extractor.ts）：
```ts
const res = await qwen.chat.completions.create({
  model,
  temperature: 0.1,
  messages: [
    { role: 'system', content: EXTRACT_SYSTEM_PROMPT },     // §6.2 全文
    { role: 'user',   content: buildUserPayload(input) },   // §6.4
  ],
  response_format: { type: 'json_schema', json_schema: EXTRACT_JSON_SCHEMA }, // §6.3
});
// JSON.parse(res.choices[0].message.content) → zod parse → ExtractResult
```

### 6.2 抽取用 system prompt（全文，繁體中文）

```
你是一個 LINE 訊息代辦抽取引擎。輸入是「某一個聊天室」的最近訊息，以及這個聊天室目前「尚未完成」的代辦清單。你的工作：判斷這批新訊息整體的重要性、抽出需要使用者採取行動的代辦事項、並偵測既有代辦是否已被完成。只輸出符合給定 JSON Schema 的物件，不要輸出任何多餘文字、不要加解釋、不要用 Markdown 包裹。

【角色定義】
- 「我」(me) = 使用者本人，direction 為 "out" 的訊息是我說的。
- direction 為 "in" 的訊息是別人對我說的。

【三種代辦分類 bucket】
1. "todo"（我的待辦）：需要「我」主動去做的事。例如：別人請我處理、我答應要做、要去買/去交/去確認的事。
2. "waiting"（等回覆）：球在對方那邊，我在等別人回覆或交付。通常是我問了問題、提了請求、丟了東西出去還沒得到回應。
3. "schedule"（行程）：有明確或可推算時間點的安排。例如會議、約見面、截止日、預約。能解析出時間就填 dueAt。

【重要性 importance（針對這整批新訊息）】
- "action"：包含需要我採取行動或追蹤的內容（會產生 todo / waiting / schedule）。
- "fyi"：只是知會、閒聊但無害、不需行動。
- "noise"：純推播、廣告、系統訊息、貼圖洗版、無意義灌水。

【抽取規則】
- 只抽「需要被追蹤」的事項；一般寒暄、確認收到、單純情緒回應不要變成代辦。
- 一則代辦盡量對應一句可執行的 title（動詞開頭、具體），detail 放補充。
- priority：1=高（有明確時限或對方在催/重要對象），2=中（一般），3=低（可有可無）。
- dueAt：只有當訊息能明確或合理推算出時間點才填，格式 ISO8601（盡量帶日期；相對時間如「明天下午三點」請依提供的 now 推算成絕對時間）。無法判斷就不要填（給 null）。
- confidence：0~1，代表你對「這是一個真代辦且分類正確」的把握。模糊就給低分（≤0.5）。
- source：每個新代辦要標出是根據哪些訊息產生的（用訊息的 msgId 陣列）。

【去重（極重要）】
- 我會把這個聊天室目前「未完成的既有代辦」一起給你（openTodos，含其 id 與 title）。
- 如果新訊息表達的事項和某個既有代辦其實是同一件事，不要重複產生新的 newTodo。
- 如果新訊息顯示某個既有代辦「已經完成 / 已被回覆 / 已被取消」，把它放進 resolved，附上判定依據 evidence（引用是哪則訊息或理由），並用其既有 id（todoId）。
- 只有確實是新的、且不等同任何既有代辦的事項，才放進 newTodos。

【完成偵測（針對 openTodos）】
- "todo"：若有訊息顯示這件事已做完／已交付／對方說不用了 → resolved。
- "waiting"：若對方已經回覆了我等待的內容 → resolved。
- "schedule"：若該行程已過去且有結束跡象，或被取消 → resolved；若只是時間調整，不要 resolved，留待使用者調整。
- 沒有足夠證據就「不要」放進 resolved；寧可漏判，不要誤判完成。
- evidence 要具體（引用觸發判定的訊息片段或 msgId），這會被當作「完成證據」存檔。

【輸出】
嚴格符合 JSON Schema：{ newTodos: [...], resolved: [...], importance: "action"|"fyi"|"noise" }。
沒有任何新代辦時 newTodos 為空陣列；沒有任何完成時 resolved 為空陣列。不要輸出 schema 以外的欄位。
```

### 6.3 guided_json schema（EXTRACT_JSON_SCHEMA，傳給 response_format.json_schema）

```jsonc
{
  "name": "line_todo_extraction",
  "strict": true,
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["newTodos", "resolved", "importance"],
    "properties": {
      "importance": { "type": "string", "enum": ["action", "fyi", "noise"] },
      "newTodos": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["bucket", "title", "priority", "confidence", "sourceMsgIds"],
          "properties": {
            "bucket":      { "type": "string", "enum": ["todo", "waiting", "schedule"] },
            "title":       { "type": "string", "minLength": 1 },
            "detail":      { "type": ["string", "null"] },
            "priority":    { "type": "integer", "enum": [1, 2, 3] },
            "dueAt":       { "type": ["string", "null"], "description": "ISO8601 或 null" },
            "confidence":  { "type": "number", "minimum": 0, "maximum": 1 },
            "sourceMsgIds":{ "type": "array", "items": { "type": "string" }, "minItems": 1 }
          }
        }
      },
      "resolved": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["todoId", "evidence"],
          "properties": {
            "todoId":   { "type": "string" },
            "evidence": { "type": "string", "minLength": 1 }
          }
        }
      }
    }
  }
}
```
> vLLM `response_format` 形態：`{ type:"json_schema", json_schema: EXTRACT_JSON_SCHEMA }`。
> 若該 vLLM 版本只認 `guided_json`（extra body），備援以 `body:{ guided_json: EXTRACT_JSON_SCHEMA.schema }` 透過 `client.chat.completions.create({...}, { /* extra */ })`。施工先試 `response_format`，失敗再切 `guided_json`。
> 對應 zod（runtime 二次驗證，避免模型越界）：`z.object({ importance: z.enum([...]), newTodos: z.array(...), resolved: z.array(...) })`。

### 6.4 餵給 LLM 的 user payload（buildUserPayload）
逐 chat 組裝，**把該 chat 現有未完成 todo 一起餵進去**（去重核心）：
```jsonc
{
  "now": "2026-06-26T16:00:00",            // 本地時間，給相對時間推算
  "chat": { "chatId": "...", "name": "...", "isGroup": false },
  "newMessages": [                          // 本輪該 chat 的新訊息（已過黑名單）
    { "msgId": "...", "ts": 1719300000000, "time": "...",
      "direction": "in", "sender": "Abby", "text": "明天三點開會", "contentType": 0 }
  ],
  "recentContext": [                        // 選填：最近數則歷史，補上下文（不會被當新訊息抽取）
    { "msgId": "...", "direction": "out", "sender": "me", "text": "好" }
  ],
  "openTodos": [                            // 該 chat 目前未完成代辦（去重 + 完成偵測對象）
    { "todoId": "...", "bucket": "waiting", "title": "等 Abby 回報價單", "dueAt": null }
  ]
}
```
（payload 以 JSON 字串放進 user message；system prompt 已說明各欄位語意。）

### 6.5 去重策略（落地）
1. **同 chat 才比對**：openTodos 只取該 chatId、status ∈ {pending,waiting_reply,scheduled,suggested_done}。
2. **LLM 主判**：newTodos 不得等同任何 openTodo；同一件事的「完成」走 resolved。
3. **App 端保險**：寫入 newTodo 前，對該 chat 既有未完成 todo 做標題正規化（去空白/標點/全半形）近似比對，命中則**更新**既有 todo（更新 source_msg_ids、updated_at）而非新增。
4. **訊息層去重**：`messages.msg_id` PK + `INSERT OR IGNORE`，同一則訊息不會被重複抽取（抽取後 `processed=1`）。

### 6.6 完成偵測策略（落地）
- LLM 回 `resolved[]` → 對每個 `todoId`：
  - `confidence` 概念由 evidence 充分度決定；App 套門檻：
    - **高信心自動完成**：LLM 放進 resolved 即視為高信心 → `status='done'`、`completion_evidence=evidence`、`resolved_at=now`。
    - 但若該 todo 是 `schedule` 且 `due_at` 仍在未來 → 不自動 done，改 `suggested_done`（避免把還沒發生的行程判完成）。
  - **建議完成**：若 App 端近似比對「疑似完成」但 LLM 未列入 resolved，或 evidence 過弱（如僅貼圖）→ `status='suggested_done'`，等使用者在看板確認。
- 使用者在看板對 `suggested_done` 按「確認完成」→ `done`；按「還沒」→ 退回原 bucket 對應的 active 狀態。
- 完成偵測**只降不升**：不會把 done 自動改回 active（避免抖動）；要復活由使用者手動。

---

## 7. 降噪黑名單預設規則 + QWEN_API_KEY 供應方式

### 7.1 降噪黑名單（defaults.ts，可在設定頁調整）
分兩層：**自動規則**（每輪對新 chat 評估，命中則建議 block）+ **使用者手動**（chats.blocked）。

預設自動規則（命中即 `block_reason='auto:*'`，預設**直接 block**，使用者可在設定頁解除）：
```jsonc
{
  "blocklist": {
    "officialAccountPrefixes": ["@"],          // LINE 官方帳號 mid 常見特徵（可調）
    "nameKeywords": [                          // chat 名稱含這些字 → 視為推播/官方/噪音
      "官方", "公告", "通知", "推播", "客服", "小幫手", "Bot", "機器人",
      "新聞", "快訊", "優惠", "促銷", "折扣", "活動", "中獎", "投資", "股票",
      "貸款", "博弈", "娛樂城", "點數", "回饋", "DM"
    ],
    "senderKeywords": ["官方帳號", "LINE 官方"],
    "contentTypeNoiseOnly": [7],               // 整輪只有貼圖(7) → 該輪該 chat 視為 noise，不浪費 LLM
    "minTextLenForLLM": 2,                     // 過短純符號訊息略過
    "treatNonUserChatTypesAsLowPriority": true // isGroup 且名稱命中關鍵字時更傾向 block
  },
  "pollIntervalSec": 30,
  "concurrency": 2,
  "llm": { "baseURL": "https://qwen.tuq.tw/v1", "model": "qwen36-fp8", "timeoutMs": 60000 },
  "linePython": "C:/Users/david/line-cua-win/.venv/Scripts/python.exe",
  "lineWatchScript": "C:/Users/david/line-cua-win/src/watch_json.py"
}
```
運作：
- 新偵測到的 chat 先 upsert 進 `chats`；若名稱/特徵命中自動規則 → `blocked=1, block_reason='auto:...'`。
- 黑名單 chat 的訊息**仍鏡像進 messages**（保留可追溯），但**不送 LLM**。
- 設定頁可逐 chat toggle、可增刪 `nameKeywords`。LLM 另有 `importance:"noise"` 作為第二道（即使過了黑名單，LLM 判 noise 的批次不產 todo）。

### 7.2 QWEN_API_KEY 供應方式（雙來源，優先序明確）
金鑰**永不**硬寫進原始碼、**不**存進 sqlite 明文。

1. **設定頁輸入（主要）**：`settings:setApiKey` → main 用 Electron `safeStorage.encryptString(apiKey)` 加密成 buffer，寫到 `app.getPath('userData')/qwen.key`（DPAPI/OS keychain 後端）。讀取時 `safeStorage.decryptString` 即用即丟，不長存記憶體、不回傳給 renderer 明文。`settings:get` 只回 `hasApiKey:boolean`。
2. **環境變數（後備 / 開發）**：啟動時若存在 `process.env.QWEN_API_KEY` 且尚未設定過 safeStorage 金鑰，則以 env 值為當輪金鑰來源（方便 `npm run dev` 與 `scripts/smoke-qwen.mjs`）。env 不寫入磁碟。
3. 解析優先序：**safeStorage 檔 > 環境變數 QWEN_API_KEY**。兩者皆無 → pipeline 的 LLM 階段標 `llm_status='error'`，UI 提示「請在設定頁填入 qwen 金鑰」。
4. baseURL/model 同樣可被 env 覆寫（`QWEN_BASE_URL` / `QWEN_MODEL`），預設 `https://qwen.tuq.tw/v1` / `qwen36-fp8`。
5. `.env.example` 提供範例；`.gitignore` 排除 `.env`、`*.key`、`out/`、`dist/`、`node_modules/`。

---

## 8. 一輪 pipeline 流程（runOnce.ts，串起所有元件）

1. `pipeline_runs` 開一筆（started_at）。
2. `watcher.ts` spawn `watch_json.py --once --limit 500` → NDJSON → `RawLineMessage[]`。橋接失敗 → `line_bridge='error'`，結束本輪。
3. upsert chats（套自動黑名單規則）；`INSERT OR IGNORE` messages（去重）。
4. 取「未處理且 chat 未 blocked」的訊息，**按 chatId 分組**。
5. 每個 chat：撈 `recentContext`（messages.repo）+ `openTodos`（todos.repo）→ `buildUserPayload` → qwen（concurrency≤2）。
6. 解析結果：寫 newTodos（套 §6.5 近似去重）、套用 resolved（§6.6 完成偵測門檻）。標來源訊息 `processed=1`。
7. `pipeline_runs` 收尾（counts、llm_status）；`webContents.send` 推 `evt:pipeline-run` / `evt:todos-changed`。
8. scheduler 依 `pollIntervalSec` 重排下一輪；可被 `pipeline:setRunning(false)` 暫停。

---

## 9. 本輪「未驗證」誠實標註（給後續開發/測試）

以下為**設計層假設**，本規格階段**尚未實機驗證**，施工時須各跑一次證實：
- `watch_json.py` 尚未撰寫；NDJSON 契約是依 linedb/watch 既有欄位**設計**的，需用 `scripts/check-line-bridge.mjs` 實跑驗證欄位與編碼（特別是 Windows 中文 UTF-8）。
- qwen 端 `response_format: json_schema` 與 `guided_json` 何者被該 vLLM 版本接受 **未驗證**；需 `scripts/smoke-qwen.mjs` + 一次真抽取確認。
- `better-sqlite3` 對 Electron 31 的 ABI rebuild **未驗證**（native module，常見痛點）；首次 `npm i` 後須跑 `npm run rebuild` 並啟動確認不報 NODE_MODULE_VERSION 錯。
- LINE `_message._id` 是否全域唯一、可否安全當 PK，**未對大量資料驗證**；若發現跨 chat 衝突，PK 改 `(chat_id, msg_id)` 複合鍵。
- safeStorage 在此機是否有可用後端（Windows DPAPI）**未驗證**；若不可用需 fallback 提示僅用 env 金鑰。

---

## 10. 施工順序建議（里程碑）

- **M0 鷹架**：electron-vite 初始化 + 三進程跑起空視窗 + better-sqlite3 rebuild 通過。
- **M1 LINE 橋接**：寫 `watch_json.py` + `watcher.ts` + DB 落 messages/chats；`smoke:line` 綠。
- **M2 抽取**：qwenClient/extractor + guided_json；`smoke:qwen` 綠 + 單 chat 真抽取出 todo。
- **M3 看板**：四欄看板 + 狀態轉移 + 設定頁（黑名單/頻率/金鑰）+ 完成偵測 UI。
- **M4（不在本輪）**：electron-builder 打包。
