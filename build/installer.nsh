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
;   !insertmacro FIND_PROCESS   偵測 process（allowOnlyOneInstallerInstance.nsh:40-48）
;   ${isUpdated}                自動更新時為真（本專案無 auto-updater，通常為假）
;
; 重要坑：一旦定義 customCheckAppRunning，模板就不再 include getProcessInfo.nsh、
;         也不宣告 Var pid（allowOnlyOneInstallerInstance.nsh:5-8）。
;         故本檔一律只用暫存暫存器 $R0，絕不使用 ${GetProcessInfo} / $pid。
; ============================================================

!macro customCheckAppRunning
  ; --- 1) 偵測是否在執行；FIND_PROCESS 慣例：$R0 == 0 代表「有找到（正在執行）」 ---
  !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
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

      ; --- 3) 先溫和關閉（不加 /f），讓 app 有機會走正常關閉、存檔後自行退出 ---
      !ifdef INSTALL_MODE_PER_ALL_USERS
        nsExec::Exec 'taskkill /im "${APP_EXECUTABLE_FILENAME}"'
      !else
        ; per-user：用 cmd.exe 包一層才能展開 %USERNAME% 並套 /fi 過濾器（沿用模板 per-user 做法）
        nsExec::Exec '%SYSTEMROOT%\System32\cmd.exe /c taskkill /im "${APP_EXECUTABLE_FILENAME}" /fi "USERNAME eq %USERNAME%"'
      !endif
      ; 給 app 一點時間收尾（存檔 / WAL checkpoint）再檢查
      Sleep 1500

      ; --- 4) 若仍在執行，才強制關閉（/f） ---
      !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
      ${if} $R0 == 0
        !ifdef INSTALL_MODE_PER_ALL_USERS
          nsExec::Exec 'taskkill /f /im "${APP_EXECUTABLE_FILENAME}"'
        !else
          nsExec::Exec '%SYSTEMROOT%\System32\cmd.exe /c taskkill /f /im "${APP_EXECUTABLE_FILENAME}" /fi "USERNAME eq %USERNAME%"'
        !endif
        Sleep 1000
      ${endIf}

      ; --- 5) 兜底：最終確認仍關不掉（多半是 app 以系統管理員身分執行、per-user 無權 kill），
      ;         才退回內建那類「請手動關閉／重試」的清楚提示（$(appCannotBeClosed) 為模板內建繁中訊息）。
      ;         把生硬對話框降到最後一步，而非一開始就丟給使用者。 ---
      !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
      ${if} $R0 == 0
        ; /SD IDCANCEL = 靜默安裝時直接中止（真的關不掉也無法繼續）
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY lt_do_close
        Quit
      ${endIf}

  ${endIf}
!macroend
