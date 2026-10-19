; ============================================================
; build/installer.nsh
; 覆寫 electron-builder 內建的 app-running 檢查：
;   偵測 line-todo 執行中 → 友善 YES/NO 詢問 → 按「是」自動關閉再繼續安裝。
;
; 機制：CHECK_APP_RUNNING（allowOnlyOneInstallerInstance.nsh:32-38）會優先
;       插入本 macro，整段取代內建的 _CHECK_APP_RUNNING（同檔:50-118）。
;
; 本 macro 展開時已可用的資源（皆由模板先行定義）：
;   ${APP_EXECUTABLE_FILENAME}  = "${PRODUCT_FILENAME}.exe"（common.nsh:16，本專案 = line-todo.exe，不硬編）
;   ${nsProcess::FindProcess}   偵測 process（nsProcess.nsh:3-6；plugin 已由模板 include，不受 customCheckAppRunning gate）
;   ${isUpdated}                自動更新時為真（本專案無 auto-updater，通常為假）
;
; 重要坑：一旦定義 customCheckAppRunning，模板就不再 include getProcessInfo.nsh、
;         也不宣告 Var pid（allowOnlyOneInstallerInstance.nsh:5-8）。
;         故本檔一律只用暫存暫存器 $R0，絕不使用 ${GetProcessInfo} / $pid。
; ============================================================

!macro customCheckAppRunning
  ; --- 1) 偵測是否在執行；nsProcess::FindProcess 慣例：$R0 == 0 代表「有找到（正在執行）」，
  ;        非 0（如 603 未找到 / 604 錯誤）代表沒在跑（以 nsProcess.nsh 實際回傳為準；
  ;        模板 allowOnlyOneInstallerInstance.nsh:42/58-59 的 per-all-users 分支亦以 0=found 判斷）。
  ;        改用 nsProcess plugin 直接查 process，取代 per-user FIND_PROCESS 的 tasklist|find 管線
  ;        （安裝環境下 %SYSTEMROOT%/%USERNAME% 不展開 → 指令失敗回非 0 → 誤判「沒在跑」整段 skip）。 ---
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0

  ${if} $R0 == 0

    ; --- 2) 非自動更新才詢問；自動更新沿用不打擾、直接關閉的行為 ---
    ${ifNot} ${isUpdated}
      ; 核可文案（逐字）；/SD IDYES = 靜默安裝時預設當作「是」，於句尾插入換行僅為顯示美觀。
      MessageBox MB_YESNO|MB_ICONQUESTION \
        "line-todo 正在執行，需要先關閉才能繼續安裝。$\r$\n要幫你自動關閉 line-todo 嗎？" \
        /SD IDYES IDNO lt_user_declined
      Goto lt_do_close

      lt_user_declined:
        ; 使用者選「否」→ 不硬逼，維持原本行為：中止安裝。
        Quit
    ${endIf}

    lt_do_close:
      DetailPrint "正在關閉 line-todo..."

      ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0

      ; --- 3) 先溫和關閉（不加 /f），讓 app 有機會走正常關閉、存檔後自行退出 ---
      ;     直接呼叫 $SYSDIR\taskkill.exe（$SYSDIR = system32，NSIS 內建變數、免展開），
      ;     不透過 cmd 包裝、不做使用者名稱過濾（本 app 個人用，砍所有同名 process 即可）。
      ;     零環境變數依賴，避開安裝程式環境下系統路徑/使用者名稱環境變數展開失敗導致 taskkill 沒真的關掉的坑。
      nsExec::Exec '"$SYSDIR\taskkill.exe" /im "${APP_EXECUTABLE_FILENAME}"'
      Pop $R3
      ; 給 app 一點時間收尾（存檔 / WAL checkpoint）再檢查
      Sleep 1500

      ; --- 4) 若仍在執行，才強制＋樹狀關閉：/f 強制、/t 連同整個 process tree
      ;         （Electron 的 GPU / renderer / utility 等 helper 子行程）一起收。 ---
      ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
      ${if} $R0 == 0
        nsExec::Exec '"$SYSDIR\taskkill.exe" /f /t /im "${APP_EXECUTABLE_FILENAME}"'
        Pop $R3
        Sleep 1000
      ${endIf}

      ; --- 5) 輪詢等到 process 真的消失再往下（關鍵）：Electron 有多個同名 helper process
      ;         （GPU / renderer / utility），/f /im 會一起收，但需輪詢確認全部退出。
      ;         這確保之後升級路徑的 uninstallOldVersion（installSection.nsh:52，跑舊解除安裝程式）
      ;         啟動時 app 已徹底不在，才不會撞回舊/內建的「無法關閉」對話框。
      ;         用 $R1 當計數器（$R0 已被 nsProcess::FindProcess 佔用）；上限 10 次 x 500ms ~= 5 秒。 ---
      StrCpy $R1 0
      lt_wait_gone:
        ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
        ${if} $R0 == 0
          IntOp $R1 $R1 + 1
          ${if} $R1 < 10
            DetailPrint "等待 line-todo 完全關閉..."
            Sleep 500
            Goto lt_wait_gone
          ${endIf}
        ${endIf}

      ; --- 6) 兜底：最終確認仍關不掉（多半是 app 以系統管理員身分執行、per-user 無權 kill），
      ;         才退回內建那類「請手動關閉／重試」的清楚提示（$(appCannotBeClosed) 為模板內建繁中訊息）。
      ;         把生硬對話框降到最後一步，而非一開始就丟給使用者。 ---
      ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
      ${if} $R0 == 0
        ; /SD IDCANCEL = 靜默安裝時直接中止（真的關不掉也無法繼續）
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY lt_do_close
        Quit
      ${endIf}

  ${endIf}
!macroend
