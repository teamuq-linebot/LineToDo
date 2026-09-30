/**
 * messages.ts — 錯誤碼對應的繁中使用者訊息（design-v1 §5.2、design-v2 §8、design-v3 §7）。
 *
 * {X}＝目標聊天室名稱；{Y}＝另一個聊天室名稱。每則失敗訊息依 lineSideEffects／draftLeftInLine 加上尾句
 * （UX 原型發現 #4：尾句要同時看 activated 與 chatOpened）。訊息只回 renderer 顯示，不寫 log。
 */
import type {
  DraftLeftInLine,
  DriverFollowUpAction,
  DriverFollowUpResult,
  DriverPostErrorCode,
  DriverPostStage,
  LineSideEffects,
  LocateEvidence,
  OpenEvidence,
  VisibilityHint
} from './types'

export interface MessageContext {
  chatName?: string
  otherChatName?: string
  seenTitle?: string
  visibility?: VisibilityHint
  stage?: DriverPostStage
  draftLeftInLine?: DraftLeftInLine
  lineSideEffects?: LineSideEffects
}

const q = (s: string | undefined): string => `「${s ?? '這個聊天室'}」`

const BODY: Record<DriverPostErrorCode, (c: MessageContext) => string> = {
  disabled: () => '「填入 LINE」功能已在設定中關閉。',
  busy: () => '已經有一筆正在填入 LINE，請等它完成。',
  rate_limited: () => '操作太頻繁，請稍候幾秒再試。',
  invalid_request: () => '草稿是空的，沒有可以填入的內容。',
  text_too_long: () => '草稿超過 5000 字，請縮短後再試。',
  send_not_available: () => '自動送出目前還沒開放。請使用「填入 LINE」，再自己在 LINE 按 Enter。',
  todo_not_found: () => '找不到這筆代辦（可能已被刪除）。',
  chat_name_missing: () => '這個聊天室沒有名稱，無法自動確認是哪個聊天室。請按「複製」後自行貼上。',
  chat_name_unverifiable: () => '這個聊天室的名稱無法用文字辨識（例如全是表情符號）。請按「複製」後自行貼上。',
  test_allowlist_blocked: () => '測試模式只允許填入指定的聊天室，已停止。',
  host_unavailable: () => '無法啟動 LINE 控制元件。請稍後再試，或按「複製」。',
  powershell_restricted: () => '這台電腦的 PowerShell 受到管理政策限制，無法使用「填入 LINE」。請按「複製」。',
  ocr_unavailable: () => '這台電腦沒有安裝繁體中文的文字辨識（OCR）元件。請到 Windows「設定 › 時間與語言 › 語言」新增「中文(繁體，台灣)」後再試。',
  line_db_unavailable: (c) => `無法讀取 LINE 的本機資料（可能是 LINE 剛重新登入），無法確定${q(c.chatName)}在列表中的位置，已停止。請稍後再試，或按「複製」後自行貼上。`,
  line_key_unavailable: (c) =>
    `目前沒有可用的 LINE 本機資料金鑰（「填入 LINE」不會為此去掃描 LINE 的記憶體），無法確定${q(c.chatName)}在列表中的位置，已停止。請等 line-todo 的 LINE 同步正常執行一次後再試，或按「複製」後自行貼上。`,
  line_not_running: () => 'LINE 沒有在執行。請先開啟 LINE 並登入後再試。',
  line_no_window: () => 'LINE 目前縮在系統匣。請先把 LINE 視窗打開後再試。',
  line_multiple_windows: () => 'LINE 目前開了不只一個視窗（例如另外彈出的聊天視窗），無法確定要操作哪一個，已停止。請關閉其他 LINE 視窗後再試。',
  line_activate_failed: () => '無法把 LINE 切到前景，已停止。請手動點一下 LINE 視窗後再試。',
  line_capture_failed: () => '無法擷取 LINE 畫面來確認聊天室，已停止。',
  line_ui_unrecognized: () => 'LINE 目前不在「聊天」頁，或 LINE 已改版、介面和預期不同，已停止。請切到聊天頁再試，或按「複製」。',
  line_search_active: () => 'LINE 的搜尋框目前有內容，畫面不是一般的聊天列表。請先清空 LINE 的搜尋框再按一次。',
  user_busy: () => '偵測到你正在操作滑鼠或鍵盤，等了 3 秒仍沒有停下。為了避免點錯或把字打進 LINE，已停止。請放開滑鼠與鍵盤後再按一次。',
  target_not_in_line: (c) => `在 LINE 的聊天列表中找不到${q(c.chatName)}（可能已刪除、隱藏或退出）。請按「複製」。`,
  list_changing: () => 'LINE 的聊天列表剛有新訊息、正在變動，為了避免點錯已停止。請等幾秒再按一次。',
  list_unrecognized: () => '無法確認 LINE 聊天列表目前顯示的是哪些聊天室（能辨識的名稱太少），已停止。請把 LINE 視窗放大一點，或稍微捲動列表後再試。',
  list_order_mismatch: () =>
    'LINE 聊天列表的順序和本機資料對不上（可能剛有新訊息，或列表使用了資料夾、篩選或其他排序方式），已停止。請切回顯示全部聊天室、依時間排序的列表，稍等幾秒再試。',
  target_not_visible: (c) => {
    const v = c.visibility
    if (v && (v.direction === 'above' || v.direction === 'below')) {
      return `${q(c.chatName)}目前不在 LINE 聊天列表的可見範圍，在畫面的${v.direction === 'above' ? '上方' : '下方'}約 ${v.rows} 列。請在 LINE 把列表捲到看得到${q(c.chatName)}，再按一次「填入 LINE」。`
    }
    const edge = v?.edgeSide === 'top' ? '上緣' : v?.edgeSide === 'bottom' ? '下緣' : '邊緣'
    return `${q(c.chatName)}在 LINE 聊天列表的最${edge}，無法確認它上下的聊天室。請把列表稍微捲動，讓${q(c.chatName)}離開邊緣後再按一次「填入 LINE」。`
  },
  row_unconfirmed: (c) => `LINE 列表上應該是${q(c.chatName)}的那一列，無法確認就是它，已停止。請按「複製」後自行貼上。`,
  row_identifies_other: (c) =>
    c.otherChatName
      ? `LINE 列表上應該是${q(c.chatName)}的那一列看起來是${q(c.otherChatName)}，已停止。`
      : `LINE 列表上應該是${q(c.chatName)}的那一列看起來不是${q(c.chatName)}，已停止。`,
  row_changed: () => 'LINE 的聊天列表在操作過程中有變動（新訊息或捲動），為了安全已停止。請再試一次。',
  occluded: () => 'LINE 視窗被其他視窗擋住，已停止。請把擋住的視窗移開後再試。',
  // ui-prototype-notes §5 #4（已核可）：「已開啟一個聊天室（可能已變成已讀）」改由尾句／副作用列表達。
  click_missed: () => '點擊後 LINE 選取的不是預期的聊天室，所以沒有填入。請到 LINE 確認目前開啟的聊天室。',
  title_unreadable: (c) => `已開啟聊天室，但無法辨識視窗上方的聊天室名稱，無法確認是${q(c.chatName)}，所以沒有填入。請到 LINE 確認目前開啟的聊天室。`,
  title_unconfirmed: (c) => `已開啟聊天室，但無法確定它就是${q(c.chatName)}（標題辨識不夠清楚），所以沒有填入。`,
  title_identifies_other: (c) =>
    c.otherChatName
      ? `開啟的聊天室看起來是${q(c.otherChatName)}，不是${q(c.chatName)}，所以沒有填入。`
      : `開啟的聊天室看起來不是${q(c.chatName)}，所以沒有填入。`,
  title_changed: () => 'LINE 的聊天室在操作過程中被切換了，為了安全沒有填入。',
  opened_other_suspected: (c) =>
    `開啟後偵測到${c.otherChatName ? q(c.otherChatName) : '另一個聊天室'}被標為已讀，可能開錯了聊天室，所以沒有填入。請到 LINE 確認目前開啟的聊天室。`,
  draft_present: (c) => `${q(c.chatName)}的輸入框裡已經有未送出的文字。為了不覆蓋它，已停止。請先處理那段文字後再試。`,
  fill_readback_mismatch: () => '填入後讀回的內容和草稿不同，已停止。',
  timeout: () => '操作逾時，已停止。',
  internal: () => '發生未預期的錯誤，已停止。請按「複製」。'
}

/**
 * 本身已說明 LINE 端狀態的訊息，不再加通用尾句。
 * click_missed 不在此列：ui-prototype-notes §5 #4 把「已開啟一個聊天室（可能已變成已讀）」從本文移到尾句／副作用列。
 */
const SELF_DESCRIBED = new Set<DriverPostErrorCode>([
  'title_unreadable',
  'title_unconfirmed',
  'title_identifies_other',
  'title_changed',
  'opened_other_suspected'
])

/** 點擊已送出、但無法確定是否已開啟聊天室時的尾句（review F3）。第一個「，」之前是 UI 強調的部分。 */
export const CHAT_OPEN_UNCERTAIN_TAIL =
  '可能已開啟一個聊天室，但沒有填入草稿（如果已開啟，該聊天室可能已變成已讀）。請到 LINE 確認目前開啟的聊天室。'

/**
 * 尾句：依 draftLeftInLine 與 lineSideEffects（activated、chatOpened、chatOpenUncertain）。
 * 文案依 ui-prototype-notes §5 #5、#6（使用者核可，ui-decisions.md 第 5 點）。
 */
export function tailSentence(c: MessageContext): string {
  const fx = c.lineSideEffects
  if (c.draftLeftInLine === 'filled_in_identified') return `草稿已填入${q(c.chatName)}的輸入框，沒有送出。`
  if (c.draftLeftInLine === 'unknown') return `無法確認草稿是否已填入。請到 LINE 檢查${q(c.chatName)}的輸入框，確認內容後再決定要不要送出。`
  if (fx?.chatOpened) return '已開啟一個聊天室（可能已變成已讀），但沒有填入草稿。'
  // review F3：點擊已送出但沒有拿到結果（逾時等）——不能說「沒有開啟任何聊天室」。
  if (fx?.chatOpenUncertain) return CHAT_OPEN_UNCERTAIN_TAIL
  if (fx?.activated) return '沒有開啟任何聊天室（LINE 已被切到前景）。'
  return '沒有開啟任何聊天室，LINE 也沒有被切到前景。'
}

/**
 * 訊息拆成本文與尾句。UI 把尾句放在獨立的「副作用列」（ui-prototype-notes §2 失敗區塊的共同規則），
 * 依 lineSideEffects／draftLeftInLine 決定樣式；已核可的原型在 title_* 等「本文已說明」的碼也顯示副作用列（原型狀態 6），
 * 所以 tail 只在前置檢查（preflight）失敗時為 null。inMessage＝串進完整 message 時是否附上尾句
 * （SELF_DESCRIBED 不附，避免 message 逐字重複）。
 */
export function messageParts(code: DriverPostErrorCode, c: MessageContext = {}): { body: string; tail: string | null; inMessage: boolean } {
  const body = BODY[code](c)
  if (c.stage === undefined || c.stage === 'preflight') return { body, tail: null, inMessage: false }
  return { body, tail: tailSentence(c), inMessage: !SELF_DESCRIBED.has(code) }
}

/** 前置檢查（preflight）失敗不加尾句（ui-prototype-notes §5 #7）。 */
export function messageFor(code: DriverPostErrorCode, c: MessageContext = {}): string {
  const p = messageParts(code, c)
  return p.tail && p.inMessage ? `${p.body}${p.tail}` : p.body
}

/** 成功（ui-prototype-notes §5 #11、#12）。 */
export function successMessage(chatName: string): string {
  return `已填入：${chatName}。請到 LINE 確認視窗上方的聊天室名稱是${q(chatName)}，再自己按 Enter 送出。`
}

/** 辨識細節句尾的已讀檢查結果（ui-prototype-notes §5 #13）。 */
const DB_ACK_TEXT: Record<OpenEvidence['dbAck'], string> = {
  target_cleared: '已讀檢查：沒有發現其他聊天室被標成已讀。',
  no_change: '已讀檢查：沒有發現其他聊天室被標成已讀。',
  na: '已讀檢查：開啟後讀取本機資料失敗，沒有完成檢查。',
  skipped: '已讀檢查：已在設定中關閉。'
}

/** 交還焦點失敗時的系統通知本文（design-v2 §9.3-6；不含草稿）。 */
export function handBackNotice(chatName: string): string {
  return `已填入到${q(chatName)}，請確認後再送出。`
}

/** 成功但 handedBack=false 時，結果區塊的提醒（ui-prototype 4e）。 */
export const HAND_BACK_FAILED_NOTE =
  '無法自動切回 line-todo，已改用工作列閃爍和系統通知提醒你。LINE 輸入框可能仍有游標，按 Enter 會直接送出，請先確認聊天室名稱。'

/** 成功後超過有效時間（ui-prototype 4f）。 */
export const FOLLOW_UP_EXPIRED_NOTE = '已超過 5 分鐘，「切到 LINE」和「從 LINE 清除這段草稿」已失效。請直接到 LINE 處理。'

/**
 * focusLine 守門不通過（review F1）：使用者還按著鍵（例如按住 Enter）或剛操作過。
 * 這時切到 LINE，按鍵會落進 LINE 的輸入框而送出草稿，所以不切換（或切換後沒有放游標）。
 */
export const FOCUS_USER_BUSY_NOTE =
  '偵測到你還按著鍵盤或剛操作過滑鼠，為了避免按鍵落進 LINE 把草稿送出，沒有把游標放進 LINE 的輸入框。請放開鍵盤與滑鼠，再按一次「切到 LINE」。'

type FollowUpCode = Extract<DriverFollowUpResult, { ok: false }>['code']

/**
 * driver:focusLine／driver:clearFilled 的訊息（ui-prototype 4b–4f；design-v2 §9.2）。
 * 清除被拒不分 edit_changed／title_changed：兩者對使用者都是「內容已變或已切到別的聊天室，請手動處理」。
 */
export function followUpMessage(action: DriverFollowUpAction, r: { outcome: 'focused' | 'cleared' } | { code: FollowUpCode }, chatName?: string): string {
  if ('outcome' in r) {
    return r.outcome === 'cleared'
      ? `已從 LINE 的${q(chatName)}輸入框清除這段草稿。`
      : `已切到 LINE，游標在${q(chatName)}的輸入框。請確認視窗上方的聊天室名稱後，再自己按 Enter 送出。`
  }
  switch (r.code) {
    case 'attempt_expired':
      return FOLLOW_UP_EXPIRED_NOTE
    case 'title_changed':
      return action === 'focusLine'
        ? `LINE 目前開著的聊天室已經不是${q(chatName)}，所以只把 LINE 切到前景，沒有把游標放進輸入框。請先確認聊天室名稱。`
        : 'LINE 輸入框的內容已經和填入的草稿不同（或已切到別的聊天室），為了不刪到你的文字，沒有清除。請到 LINE 手動處理。'
    case 'edit_changed':
      return 'LINE 輸入框的內容已經和填入的草稿不同（或已切到別的聊天室），為了不刪到你的文字，沒有清除。請到 LINE 手動處理。'
    case 'line_not_running':
      return action === 'focusLine' ? 'LINE 沒有在執行，無法切到 LINE。' : 'LINE 沒有在執行，無法清除草稿。請到 LINE 確認。'
    case 'user_busy':
      return FOCUS_USER_BUSY_NOTE
    case 'busy':
      return '已經有一筆正在填入 LINE，請等它完成。'
    case 'disabled':
      return '「填入 LINE」功能已在設定中關閉。請直接到 LINE 處理。'
    case 'invalid_request':
      return '這個操作的參數不正確，已忽略。'
    case 'internal':
    default:
      return action === 'focusLine' ? '無法切到 LINE（發生未預期的錯誤）。請直接到 LINE 處理。' : '無法清除草稿（發生未預期的錯誤）。請到 LINE 手動處理。'
  }
}

/** 成功時可展開的「辨識細節」（design-v3 §7.3；不顯示錨點聊天室的名稱）。 */
export function detailsText(loc: LocateEvidence, open: OpenEvidence): string {
  return (
    `位置：本機資料中的第 ${loc.rank + 1} 名（${loc.pinned ? '釘選' : '未釘選'}），畫面第 ${loc.row + 1} 列；` +
    `${loc.anchors} 個已辨識的聊天室確認了列表位置。` +
    `開啟後：選取列${open.selectionMatched ? '相符' : '不符'}；標題辨識為「${open.seenTitle}」（相似度 ${Math.round(open.titleSim * 100)}%）。` +
    DB_ACK_TEXT[open.dbAck]
  )
}
