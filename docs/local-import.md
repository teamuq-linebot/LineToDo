# LineTodo 本機套件與匯入

## 本次版本與工具

目前 package.json / package-lock.json 版號為 0.2.14。每次更新都使用嚴格三段數字版號；若指定目前安裝 manifest，會要求新版本嚴格較高。

目標 Core 是 1.8.10。外掛 repo 內 vendored author CLI 已同步為 1.8.10；helper 仍要求傳入已核對 SHA-256 的 CLI 絕對路徑，並另行使用相容目標 --core-version 1.8.10 --platform win32-x64。工具版號與封裝 target 會分開記錄；任一版號或 hash 不符時會停止。

## 一般使用

npm 目前會將額外的 --tool 等旗標解析成 npm config。用環境變數傳入路徑，再使用 npm scripts：

~~~~powershell
$env:TUQ_PLUGIN_TOOL_184 = "C:\Users\david\AppData\Local\Programs\TeamUQ\resources\plugin-authoring\kit\bin\tuq-plugin-tool.mjs"
# 若已安裝 Line Todo，指定其 manifest；first-install 時省略此行且官方 installed plugin-id 目錄必須不存在。
$env:LINE_TODO_INSTALLED_MANIFEST = "$env:USERPROFILE\.teamuq\plugins\installed\tuqdev.line-todo\0.2.13\manifest.json"
npm run import:local:dry-run
~~~~

dry-run 只讀 Core、author tool metadata 與安裝狀態，不寫檔、不做私有動作。若 installed plugin-id 目錄不存在，記為 first-install；若目錄存在但 manifest 缺失或不能唯一判定版本，會停止，不把舊版或假版號當成安裝基準。

建立新 run 時，LINE_TODO_LOCAL_IMPORT_OUT 必須是不存在的 task-owned 絕對目錄；script 不會清理或覆寫既有輸出：

~~~~powershell
$out = "C:\teamuq\teamuq-plugins\output\linetodo-commit-package-20261101\developer\packages\run-0.2.14-01"
$env:LINE_TODO_LOCAL_IMPORT_OUT = $out
npm run import:local
~~~~

import:local 僅接受乾淨的 committed worktree，會把 HEAD 與 tree SHA 寫入 source identity，並於打包前後重查來源一致。它會建 UI/backend 與完整 stage，保留 build metafiles、payload/stage SHA-256、來源 identity、命令與 exit code，然後用 Core 1.8.10 CLI 執行 validate → pack --unsigned → verify。它會輸出 unsigned package、preflight、stage index、review request 和精確 pre-sign-bindings.json。Unsigned 檔已驗證但仍未簽章，不能匯入。

只想建 stage 並跑 Core validation 時使用：

~~~~powershell
npm run import:local:validate
~~~~

--validate-only 不 pack、不簽章。聚焦測試：

~~~~powershell
npm run test:local-import
~~~~

也可直接執行 script 並以旗標指定路徑，例如 node scripts/plugin/build-local-import.mjs --dry-run --tool <CLI> --installed-manifest <manifest>。

## Reviewer 與受保護簽章

每一個 unsigned run 都有自己的 request/bindings。把 run 目錄中的 pre-sign-review-request.json、pre-sign-preflight.json、stage-index.json、source-identity.json、pre-sign-bindings.json 和 unsigned archive 交給獨立 Reviewer。舊版 receipt 不可沿用。Reviewer 核准後應交回新 receipt，且 bindings 必須逐欄完全等於該 run 的 pre-sign-bindings.json。

正式簽章入口明確要求 approval receipt：

~~~~powershell
$env:LINE_TODO_LOCAL_IMPORT_RUN_DIR = $out
$env:LINE_TODO_LOCAL_IMPORT_APPROVAL = "C:\path\to\reviewer-approval.json"
npm run import:local:approved-sign
~~~~

sign script 的 --check 只重驗 bindings/unsigned package；--guard-probe 用記憶體中的 stale fixture 證明拒絕點在 DPAPI/private action 之前。簽章模式固定沿用 teamuq-root-2026a 與既有 DPAPI unlock 路徑；不接受自訂 key/unlock，也不覆寫既有 signed output。

## 最後匯入

Core 1.8.10 沒有受支援的 scriptable install CLI。簽章完成後，依 sign-result.json 所列 signed artifact path/hash，在 Core 開啟 **我的 AI > 外掛 > 更多與進階 > 從檔案安裝**，由使用者選取已簽且已驗證的 .tuqplugin。Script 不呼叫內部 IPC、不寫 installed store，也不回報安裝成功。
