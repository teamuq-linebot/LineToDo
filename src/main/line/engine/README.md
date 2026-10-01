# line/engine — 純 TS 橋接引擎（移植目標）

此目錄承載外部 Python 橋接（`line-cua-win/src/`）改寫成純 TS/Node 的引擎模組。
移植計畫見 `output/sw/line-todo-bridge-ts-port-20260703/port-plan.md`。

規劃檔案（尚未實作，依 port-plan §5 分批交付）：

- `linedb.ts`（Batch 1）— 開/查加密 LINE DB。用 `better-sqlite3-multiple-ciphers`
  以 `PRAGMA cipher='aes128cbc'; kdf_iter=1; key=<32-hex>` 開啟（對齊 Python
  `apsw-sqlite3mc`）。snapshot edb/-wal/-shm → 開 RW COPY → `wal_checkpoint(TRUNCATE)`。
- `linekey.ts`（Batch 2）— 金鑰萃取三段式（env → cache → recover）。recover 段需
  `native/` 的 process-memory 掃描能力或 fallback。
- `rowToObj.ts`（Batch 3）— `_message` row → NDJSON 契約物件的純轉換函式
  （媒體 gate / call label / 時區）。
- `watchEngine.ts`（Batch 4）— 編排 + checkpoint + stat-gate，對下游提供 in-process API。

> Batch 0（本批）僅建立此骨架與驗證依賴，未放任何 production 程式碼。

## I/O ports（fulltrust-plugin Phase 0）

引擎模組不直接 import `node:fs`／`node:child_process`／SQLite binding，一律經 port：

- `fsPort.ts` — `LineFsPort` 介面 + 共用純邏輯 `findDbPath`／`copySnapshot`。
- `sqlitePort.ts` — `SqliteEnginePort`／`LineDbHandle`（better-sqlite3 子集，同步 `open`）。
- `enginePorts.ts` — 組裝根注入點 `configureLineEnginePorts({ fs, sqlite, dbDir })`；未注入時惰性用 Node 預設。
- `nodeLineFsPort.ts`、`betterSqliteCipherEngine.ts` — standalone 實作（唯一允許 import `node:fs` 的檔）。

守門：`grep -rn "from 'node:fs'" src/main/line/engine` 只應命中 `nodeLineFsPort.ts`；單元測試 `npm run test:line-fs-port`。
