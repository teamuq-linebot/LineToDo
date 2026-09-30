/**
 * types.ts — driver_post 的 IPC 契約（design-v3 §5、§7；types-draft-v3 §B）。
 *
 * renderer 端的鏡像在 src/shared/api.ts（preload 轉匯出、renderer/types/api.d.ts 再轉匯出）。兩邊必須同步。
 *
 * channels（src/main/ipc/driver.ipc.ts 註冊）：
 *   'driver:status'      invoke({ todoId? }) → DriverStatus
 *   'driver:postDraft'   invoke(DriverPostRequest) → DriverPostResult
 *   'driver:focusLine'   invoke({ attemptId }) → DriverFollowUpResult   切到 LINE 並把焦點放進輸入框；不注入按鍵
 *   'driver:clearFilled' invoke({ attemptId }) → DriverFollowUpResult   只清除「仍等於我們填入文字」的輸入框
 *   'evt:driver-post-progress' push → DriverPostProgress
 */
import type { DriverPostMode } from '../config/settings'
import type { OpenEvidence, VisibilityHint } from './locate'

export type { DriverPostMode } from '../config/settings'
export type { OpenEvidence, VisibilityHint } from './locate'

export interface DriverStatus {
  enabled: boolean
  mode: 'fillOnly'
  sendAvailable: false
  busy: boolean
  /** 上一次 helper 健檢的結果（null＝本次開 app 尚未檢查過）。只含使用者可讀訊息。 */
  lastHostProblem: { code: DriverPostErrorCode; message: string } | null
  /**
   * 帶 todoId 查詢時：這筆代辦在不碰 LINE 的前置檢查就會停下的原因（todo_not_found、chat_name_missing、
   * chat_name_unverifiable）；null＝沒有問題或沒有帶 todoId。訊息來自 messages.ts。
   */
  targetProblem: { code: DriverPostErrorCode; message: string } | null
}

export interface DriverPostRequest {
  todoId: string
  /** 對話框 textarea 當下的內容。 */
  text: string
  /** 舊 renderer 若仍帶 'fillAndSend' → send_not_available。 */
  mode?: DriverPostMode
}

export type DriverPostStage =
  | 'preflight'
  | 'host_start'
  | 'locate_line'
  | 'read_order'
  | 'read_list'
  | 'locate_row'
  | 'activate_line'
  | 'open_chat'
  | 'verify_open'
  | 'check_input_empty'
  | 'fill'
  | 'hand_back'
  | 'cleanup'

/** 等安靜期的是哪一個會改變 LINE 狀態的動作（ui-prototype-notes §7-6）。 */
export type DriverQuietAction = 'activate' | 'click' | 'fill'

export interface DriverPostProgress {
  attemptId: string
  stage: DriverPostStage
  /**
   * 正在等安靜期（UI 顯示「請暫時放開滑鼠與鍵盤…」）。helper 發現使用者正在操作、開始等待時送 true；
   * 該動作的指令回來後送 false。一般的階段進度不帶這個欄位。
   */
  waitingForQuiet?: boolean
  /** waitingForQuiet=true 時：正在等待的動作。 */
  quietAction?: DriverQuietAction
  /** waitingForQuiet=true 時：最多再等多久（ms）；等不到就停止（user_busy）。 */
  quietMaxWaitMs?: number
}

export type DriverPostErrorCode =
  // ── 前置（未碰 LINE）
  | 'disabled'
  | 'busy'
  | 'rate_limited'
  | 'invalid_request'
  | 'text_too_long'
  | 'send_not_available'
  | 'todo_not_found'
  | 'chat_name_missing'
  | 'chat_name_unverifiable'
  | 'test_allowlist_blocked'
  // ── helper / 環境
  | 'host_unavailable'
  | 'powershell_restricted'
  | 'ocr_unavailable'
  | 'line_db_unavailable'
  /** 新增（D5）：沒有可用的快取金鑰；使用者觸發的流程不掃描 LINE 記憶體。 */
  | 'line_key_unavailable'
  // ── LINE 視窗
  | 'line_not_running'
  | 'line_no_window'
  | 'line_multiple_windows'
  | 'line_activate_failed'
  | 'line_capture_failed'
  | 'line_ui_unrecognized'
  | 'line_search_active'
  // ── 使用者輸入
  | 'user_busy'
  // ── 列表定位
  | 'target_not_in_line'
  | 'list_changing'
  | 'list_unrecognized'
  | 'list_order_mismatch'
  | 'target_not_visible'
  | 'row_unconfirmed'
  | 'row_identifies_other'
  | 'row_changed'
  | 'occluded'
  // ── 開啟後
  | 'click_missed'
  | 'title_unreadable'
  | 'title_unconfirmed'
  | 'title_identifies_other'
  | 'title_changed'
  | 'opened_other_suspected'
  // ── 寫入
  | 'draft_present'
  | 'fill_readback_mismatch'
  // ── 其他
  | 'timeout'
  | 'internal'

/** 失敗後草稿留在 LINE 的哪裡。 */
export type DraftLeftInLine = 'none' | 'filled_in_identified' | 'unknown'

export interface LineSideEffects {
  /** LINE 是否曾被切到前景（最小化還原、S6 切前景都算）。 */
  activated: boolean
  /** v3 永遠 false（不碰搜尋框、不捲動）。保留欄位給 UI 相容。 */
  searchChanged: false
  searchRestored: false
  /** 是否點開過聊天室（該聊天室可能已變成已讀）。 */
  chatOpened: boolean
  /**
   * 點擊指令已送出、但沒有拿到結果就停止（逾時、helper 結束或例外）：無法確定是否已開啟聊天室（review F3）。
   * 只在 chatOpened=false 時出現（true）；訊息與 UI 以「可能已開啟」呈現，不說「沒有開啟任何聊天室」。
   */
  chatOpenUncertain?: true
}

export interface LocateEvidence {
  /** 目標在 R* 中的名次（0 起算）與是否釘選。 */
  rank: number
  pinned: boolean
  /** 錨點推定的位移：screenRow = rank − offset。 */
  offset: number
  anchors: number
  path: 'T' | 'A' | 'B'
  row: number
}

export type DriverPostResult =
  | {
      ok: true
      outcome: 'filled'
      attemptId: string
      chatName: string
      locate: LocateEvidence
      open: OpenEvidence
      /** 焦點是否成功交還 line-todo（false → 已 flashFrame＋通知）。 */
      handedBack: boolean
      elapsedMs: number
      /** 可展開的「辨識細節」（messages.detailsText）。 */
      details: string
      /** handedBack=false 時的提醒（messages.ts）；否則 null。 */
      handBackNote: string | null
      /** 「切到 LINE」「從 LINE 清除這段草稿」的有效時間（ms）。 */
      followUpTtlMs: number
      /** 超過 followUpTtlMs 後顯示的說明（messages.ts）。 */
      expiredNote: string
    }
  | {
      ok: false
      attemptId: string
      code: DriverPostErrorCode
      /** 完整訊息（body＋tail；本文已說明 LINE 端狀態的碼不重複附 tail）。 */
      message: string
      /** 錯誤碼本身的說明（messages.ts）。 */
      body: string
      /** LINE 端狀態（副作用列，messages.tailSentence）；前置檢查失敗時為 null。 */
      tail: string | null
      stage: DriverPostStage
      draftLeftInLine: DraftLeftInLine
      lineSideEffects: LineSideEffects
      /** row_identifies_other / title_identifies_other / opened_other_suspected：另一個聊天室的名稱（只供顯示，不寫 log）。 */
      otherChatName?: string
      /** title_* 失敗時：標題 OCR 原文（只供顯示）。 */
      seenTitle?: string
      visibility?: VisibilityHint
    }

/** 填入成功後的後續動作。 */
export type DriverFollowUpAction = 'focusLine' | 'clearFilled'

/**
 * driver:focusLine／driver:clearFilled 的結果（design-v2 §9.2；ui-prototype-notes §7-5）。
 * 原型成功後的四種後續，renderer 依「呼叫的是哪一個動作」＋ outcome／code 區分：
 *   4b 清除成功          clearFilled → { ok:true,  outcome:'cleared' }
 *   4c 清除被拒          clearFilled → { ok:false, code:'edit_changed' | 'title_changed' }（內容已變或已切換聊天室）
 *   4d 切到 LINE 時已換   focusLine   → { ok:false, code:'title_changed' }（只切到前景，沒有放游標）
 *   4f 超過 5 分鐘        任一動作    → { ok:false, code:'attempt_expired' }
 * 另外 focusLine 成功為 { ok:true, outcome:'focused' }。所有 message 都來自 messages.ts。
 */
export type DriverFollowUpResult =
  | { ok: true; action: DriverFollowUpAction; outcome: 'focused' | 'cleared'; message: string }
  | {
      ok: false
      action: DriverFollowUpAction
      /** user_busy：focusLine 時使用者還按著鍵或剛操作過（review F1），helper 沒有切到 LINE（activated=false）或沒有放游標。 */
      code: 'attempt_expired' | 'title_changed' | 'edit_changed' | 'line_not_running' | 'user_busy' | 'busy' | 'disabled' | 'invalid_request' | 'internal'
      message: string
      /** 這次呼叫是否把 LINE 切到了前景（focusLine 的 title_changed 會）。 */
      activated: boolean
    }

// ── 鏡像同步檢查（只在型別層；typecheck 會在兩邊不一致時失敗）──────────────────────
import type * as Mirror from '../../shared/api'
import type { DriverPostSettings } from '../config/settings'
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type AssertTrue<T extends true> = T
/** src/shared/api.ts（preload／renderer 鏡像）必須和 main 的定義完全相同。 */
export type DriverMirrorInSync = AssertTrue<
  Same<DriverPostSettings, Mirror.DriverPostSettings> extends true
    ? Same<DriverStatus, Mirror.DriverStatus> extends true
      ? Same<DriverPostRequest, Mirror.DriverPostRequest> extends true
        ? Same<DriverPostStage, Mirror.DriverPostStage> extends true
          ? Same<DriverPostProgress, Mirror.DriverPostProgress> extends true
            ? Same<DriverPostErrorCode, Mirror.DriverPostErrorCode> extends true
              ? Same<DraftLeftInLine, Mirror.DraftLeftInLine> extends true
                ? Same<LineSideEffects, Mirror.LineSideEffects> extends true
                  ? Same<VisibilityHint, Mirror.VisibilityHint> extends true
                    ? Same<LocateEvidence, Mirror.LocateEvidence> extends true
                      ? Same<OpenEvidence, Mirror.OpenEvidence> extends true
                        ? Same<DriverPostResult, Mirror.DriverPostResult> extends true
                          ? Same<DriverQuietAction, Mirror.DriverQuietAction> extends true
                            ? Same<DriverFollowUpResult, Mirror.DriverFollowUpResult>
                            : false
                          : false
                        : false
                      : false
                    : false
                  : false
                : false
              : false
            : false
          : false
        : false
      : false
    : false
>
