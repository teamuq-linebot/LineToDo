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
