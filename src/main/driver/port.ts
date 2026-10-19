/**
 * port.ts — driver 的 port（design-v3 §8、types-draft-v3 §C／§D／§H）。
 *
 * 狀態機（postDraft.ts）只依賴這裡的介面；psHost.ts 實作 LineUiPortV3，lineOrder.ts 實作 LineOrderPort。
 * v3 的 UI port 只能「讀」搜尋框（I12）：沒有任何寫入搜尋框的指令，也沒有任何鍵盤注入（I2）。
 */
import type { OrderSnapshot } from './order'

export interface ScreenRect {
  x: number
  y: number
  w: number
  h: number
}
export interface OcrWordDTO {
  text: string
  rect: ScreenRect
}
export interface OcrLineDTO {
  text: string
  rect: ScreenRect
  words: OcrWordDTO[]
}

/** helper 自己判定的守門拒絕原因。 */
export type HostRefusal =
  | 'user_busy'
  | 'occluded'
  | 'row_changed'
  | 'title_changed'
  | 'title_not_approved'
  | 'edit_not_empty'
  | 'edit_mismatch'
  | 'capture_blank'
  | 'anchor_missing'
  | 'selection_unreadable'
  | 'line_not_running'
  | 'not_foreground'

export type PortResult<T> = { ok: true; value: T } | { ok: false; refusal: HostRefusal; detail?: string }

/** 預先登記的前處理參數組（design-v2 §4.4）。helper 端內建對應參數。 */
export type RowOcrConfig = 'R1' | 'R2' | 'R3'
export type TitleOcrConfig = 'T1' | 'T2' | 'T3'
export const ROW_CONFIGS: readonly RowOcrConfig[] = ['R1', 'R2', 'R3']
export const TITLE_CONFIGS: readonly TitleOcrConfig[] = ['T1', 'T2', 'T3']

export interface QuietSpec {
  minIdleMs: number
  maxWaitMs: number
  /** true：另外要求沒有任何按鍵按著（Q_fill）。滑鼠按鍵一律檢查。 */
  requireNoKeysDown?: boolean
}

/**
 * design-v2 §6.2：會改變 LINE 狀態的動作前的安靜期。只准收緊 Q。
 * review F1：凡是會把 LINE 切到前景的動作（activate、focus）都要求沒有任何按鍵按著——按住 Enter 的自動重複、
 * 連按的第二下，會送到當下的前景視窗；LINE 在前景時按 Enter 就是送出。helper 端另外強制同樣的條件與下限。
 */
export const QUIET = {
  activate: { minIdleMs: 300, maxWaitMs: 3000, requireNoKeysDown: true },
  click: { minIdleMs: 500, maxWaitMs: 3000 },
  fill: { minIdleMs: 500, maxWaitMs: 3000, requireNoKeysDown: true },
  /** 成功後的「切到 LINE」（focusEdit）：LINE 輸入框裡有草稿，和 Q_fill 同級。 */
  focus: { minIdleMs: 500, maxWaitMs: 3000, requireNoKeysDown: true }
} as const satisfies Record<string, QuietSpec>

/** 每個 helper 指令的 TS 端逾時（ms）。逾時 → kill helper。types-draft-v3 §D。 */
export const HOST_TIMEOUTS_MS = {
  spawnAndHello: 8000,
  default: 3000,
  /** 11–13 列 × 3 config，實測約 3.3 s（v3-06）。 */
  readList: 8000,
  readListGeometry: 3000,
  readTitle: 3000,
  /** 含安靜期最長等待。 */
  guarded: 3000 + 3000,
  waitTitleStable: 3000,
  wholeOperation: 30000
} as const

export interface TitleReadings {
  byConfig: Partial<Record<TitleOcrConfig, OcrLineDTO[]>>
  stripRect: ScreenRect
  /** 標題列像素 SHA-256（記憶體內算）。helper 會把它登記為本 session 可核准的 hash。 */
  stripHash: string
  blank: boolean
}

export interface EditState {
  value: string
  hasFocus: boolean
}

export interface HostHello {
  protocol: number
  psVersion: string
  languageMode: 'FullLanguage' | 'ConstrainedLanguage' | 'RestrictedLanguage' | 'NoLanguage' | string
  ocrLanguages: string[]
  dpiAwareness: 'per_monitor_v2' | 'system' | 'unaware' | string
  pid: number
}

export interface AnchorReport {
  ok: boolean
  missing: string[]
}

export type LineLocateV3 =
  | { status: 'not_running' }
  | { status: 'no_window'; pid: number }
  | { status: 'multiple_windows'; pid: number; count: number }
  /** otherTopLevel：同 PID 的其他頂層視窗 ClassName（例如彈出的聊天視窗）；非空 → line_multiple_windows。 */
  | { status: 'ok'; pid: number; iconic: boolean; exeVersion: string | null; otherTopLevel: string[] }

export interface ListRowV3 {
  /** UIA ListItem 的索引（LcListView 子節點順序）。 */
  index: number
  rect: ScreenRect
  visibleH: number
  hash: string
  /** UIA SelectionItemPattern.IsSelected；讀不到為 null。 */
  selected: boolean | null
  /** 只有完整可見（visibleH ≥ 0.95h）的列才有：同一次擷取、各 config 的 OCR 行。 */
  ocr?: Partial<Record<RowOcrConfig, OcrLineDTO[]>>
}

export interface ListSnapshot {
  rows: ListRowV3[]
  listRect: ScreenRect
  /** helper 內兩次連續擷取的列簽章相同。 */
  stable: boolean
  /** 同一 helper session 內單調遞增的編號。 */
  snapshotId: number
}

export interface GuardedRow {
  index: number
  rect: ScreenRect
  hash: string
}

export interface LineUiPortV3 {
  hello(): Promise<HostHello>
  beginSession(): Promise<void>
  endSession(): Promise<void>
  locateLine(): Promise<LineLocateV3>
  probeAnchors(): Promise<AnchorReport>
  /** 只讀搜尋框（I12）。 */
  readSearch(): Promise<string>
  /** 不切前景（PrintWindow）。等穩定後擷取一次，對完整可見列各跑 R1–R3 OCR；同時讀 selection。 */
  readList(opts: { configs: readonly RowOcrConfig[] }): Promise<PortResult<ListSnapshot>>
  /** 只讀幾何＋hash＋selection，不 OCR（S6 之後的再確認用）。 */
  readListGeometry(): Promise<PortResult<ListSnapshot>>
  readTitle(opts: { configs: readonly TitleOcrConfig[] }): Promise<PortResult<TitleReadings>>
  activateLine(opts: { restore: boolean; quiet: QuietSpec }): Promise<PortResult<{ foreground: boolean }>>
  /**
   * 唯一會點擊的指令。helper 端原子檢查：
   *  ① windowRows 每一列（所有完整可見列）的 index→rect、hash 都和當下相同
   *  ② 目標列在 windowRows 內 ③ WindowFromPoint 根視窗是 LINE 主視窗 ④ 安靜期 Q_click＋滑鼠按鍵未按
   * 全過才點擊列中心並把游標移回；之後等 300 ms 讀 selection 回傳。dryRun 時只評估守門、不點擊。
   */
  guardedClick(args: {
    row: GuardedRow
    windowRows: GuardedRow[]
    quiet: QuietSpec
    dryRun?: boolean
  }): Promise<PortResult<{ clicked: boolean; selectedIndexAfter: number | null }>>
  waitTitleStable(): Promise<PortResult<{ stripHash: string }>>
  readEdit(): Promise<PortResult<EditState>>
  /** 唯一寫入指令。守門：approvedTitleHash 是本 session readTitle 產生且等於當下；輸入框空；安靜期（含無按鍵按著）。 */
  setEdit(text: string, approvedTitleHash: string, quiet: QuietSpec): Promise<PortResult<{ readback: string }>>
  clearEditIfEquals(expectCurrent: string, approvedTitleHash: string): Promise<PortResult<{ cleared: true }>>
  /**
   * 切到 LINE；只有標題 hash 等於 approved 時才把焦點放進輸入框（否則 title_changed）。不注入任何按鍵。
   * 切前景之前先守門（review F1）：安靜期 ≥ quiet.minIdleMs、沒有任何按鍵或滑鼠按鍵按著，最多等 quiet.maxWaitMs；
   * 不通過 → refusal 'user_busy'（detail ''：LINE 沒有被切換）。切換後、放游標前又有輸入 → 'user_busy'（detail 'late'：
   * LINE 已在前景，但沒有放游標）。
   */
  focusEdit(approvedTitleHash: string, quiet: QuietSpec): Promise<PortResult<{ focused: true }>>
  /** 只在 LINE 仍為前景時，把前景交還 hwnd。 */
  handBackFocus(hwnd: bigint): Promise<PortResult<{ handedBack: boolean }>>
  /** 稽核 log 用；可省略。 */
  telemetry?(): PortTelemetry
  /**
   * 安靜期等待通知（DriverPostProgress.waitingForQuiet）。helper 在守門指令（activateLine、guardedClick、setEdit）
   * 發現使用者正在操作、開始等待時送出一個事件；listener 在該指令回應之前被呼叫。null＝取消訂閱。可省略（沒有通知）。
   */
  onQuietWait?(listener: QuietWaitListener | null): void
  dispose(): Promise<void>
}

export type QuietGuardedCommand = 'activateLine' | 'guardedClick' | 'setEdit'
export type QuietWaitListener = (e: { command: QuietGuardedCommand; maxWaitMs: number }) => void

/** port 呼叫逾時（helper 已被終止）。狀態機對應 timeout。 */
export class PortTimeoutError extends Error {
  constructor(public readonly command: string) {
    super(`port_timeout:${command}`)
    this.name = 'PortTimeoutError'
  }
}

/** helper 無法啟動或已結束。狀態機對應 host_unavailable。 */
export class PortUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PortUnavailableError'
  }
}

/** helper 回報的例外（例如 line_not_running、ocr_unavailable、UIA 例外）。message 是 helper 的錯誤字串。 */
export class PortCommandError extends Error {
  constructor(public readonly command: string, message: string) {
    super(message)
    this.name = 'PortCommandError'
  }
}

/** 稽核 log 用的 helper 觀測值（不含任何名稱或 OCR 原文）。 */
export interface PortTelemetry {
  /** beginSession 後是否有使用者輸入（只記錄，不中止）。 */
  activity: boolean
  /** 各守門指令最近一次等待安靜期的時間（ms）。 */
  quietWaitMs: Partial<Record<'activateLine' | 'guardedClick' | 'setEdit', number>>
}

/** helper 協定指令（v3）。沒有任何寫入搜尋框或鍵盤注入的指令（M6b、M6c）。 */
export type HostCommandV3 =
  | 'hello'
  | 'beginSession'
  | 'endSession'
  | 'locateLine'
  | 'probeAnchors'
  | 'readSearch'
  | 'readList'
  | 'readListGeometry'
  | 'readTitle'
  | 'activateLine'
  | 'guardedClick'
  | 'waitTitleStable'
  | 'readEdit'
  | 'setEdit'
  | 'clearEditIfEquals'
  | 'focusEdit'
  | 'handBackFocus'
  | 'shutdown'

/** helper → main 的回應。activity：beginSession 後是否有任何輸入（只寫 log，不因此中止）。 */
export type HostResponse =
  | { id: number; ok: true; result: unknown; activity: boolean; quietWaitMs?: number }
  | { id: number; ok: false; refusal: HostRefusal; detail?: string; activity: boolean; quietWaitMs?: number }
  | { id: number; ok: false; error: string; activity: boolean }

/** helper → main 的中途事件（不是回應；同一個 id 之後仍會有一個回應）。 */
export interface HostEvent {
  id: number
  event: 'waitingForQuiet'
  maxWaitMs?: number
}

// ── LINE 本機 DB（design-v3 §8.3）───────────────────────────────────────

export type LineOrderFailCode = 'line_db_unavailable' | 'line_key_unavailable'

export interface LineOrderPort {
  /**
   * 讀一次 LINE 本機 DB 的排序欄位（唯讀複本，用完即刪）。
   * 金鑰只用快取（不掃描 LINE 記憶體，design-v3 D5）；快取不到 → line_key_unavailable。
   */
  snapshot(): Promise<{ ok: true; value: OrderSnapshot } | { ok: false; code: LineOrderFailCode }>
}
