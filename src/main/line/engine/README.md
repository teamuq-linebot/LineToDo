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
- `nodeLineFsPort.ts`、`betterSqliteCipherEngine.ts` — standalone 實作。
- `native/win32fs.ts` — 外掛（Phase 1）的 `LineFsPort`：koffi 包 Win32（FindFirstFileW／CopyFileW／CreateFileW+ReadFile／Toolhelp32），
  不經 Node fs 權限層；引擎工作區（snapshot 暫存、`.linekey`、checkpoint）仍用 node:fs，但只限 dataDir 底下。
- `wasmSqliteCipherEngine.ts` — 外掛（Phase 1）的 `SqliteEnginePort`：SQLite3MultipleCiphers 2.5.1 WASM（`vendor/sqlite3mc-wasm/`）
  + 唯讀 node:fs VFS（`wasm/nodeFsReadOnlyVfs.ts`，`sqlite3mc_vfs_create` 包 cipher 層）。**只讀、無 fsync、無跨程序鎖、不用 MEMFS**；
  只開 dataDir 內由 koffi 複製進來的私有 snapshot。int64 規則見 `wasm/int64.ts`（預設 `exact`；`legacy-number` 與 standalone 逐位元相同）。

守門：`grep -rn "from 'node:fs'" src/main/line/engine` 只應命中 port／VFS 實作檔：`nodeLineFsPort.ts`、`native/win32fs.ts`（工作區）、
`wasm/nodeFsReadOnlyVfs.ts`、`wasmSqliteCipherEngine.ts`（讀 wasm 檔）。單元測試：`npm run test:line-fs-port`（Phase 0）、
`npm run test:wasm-vfs`／`test:wasm-linedb`／`test:wasm-contract`（Phase 1，合稱 `npm run test:wasm-engine`）。
