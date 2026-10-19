# line/native — 原生能力（金鑰 recover 用）

此目錄承載 Batch 2 金鑰萃取的原生層。LINE DB passphrase（32-hex）需從
LINE.exe 記憶體掃描取得（`OpenProcess`/`VirtualQueryEx`/`ReadProcessMemory`），
Node 無 stdlib 對等能力。移植計畫見
`output/sw/line-todo-bridge-ts-port-20260703/port-plan.md` §4。

規劃方案（依 port-plan §4.2，尚未實作）：

- 方案 B（主線）：N-API C++ addon 包 Win32 memory-scan，回傳 32-hex 候選給 TS 試解。
- 方案 D（保底）：保留一支極小 `linekey.exe`（PyInstaller 打包，僅印 32-hex），
  TS 於 env/cache 皆 miss 時 spawn 一次取 key 並快取。

> Batch 0（本批）僅建立此骨架，未放任何原生程式碼。
