/**
 * backendError.ts — 把 API 呼叫失敗變成使用者看得懂的一句話（G-02／G-03）。
 *
 * 外掛開發者指南 §2：「呼叫可能因權限、方法不在 allowlist、逾時或 backend 無法使用而失敗。請以 try/catch 顯示錯誤，勿假設呼叫一定成功。」
 * standalone 與外掛共用的元件都用它：外掛版的錯誤帶 TeamUQ host 的固定錯誤碼（`pluginTransport.ts` 的 `PluginBackendError.code`），
 * standalone 的 IPC 錯誤沒有這些碼，就照原本的訊息顯示。這個檔案不 import 外掛傳輸層（standalone bundle 不需要它），只看 `code`。
 */
import { PERMISSIONS_SECTION_TITLE, PLUGIN_PAGE_PLACE } from '../../shared/teamuqPlaces'
import type { BackendPhase } from '../platform/pluginTransport'

/** `revoked`＝TeamUQ 已隔離這個外掛的後端呼叫（停用／逾時）或外掛已移除；`unavailable`＝暫時的，稍後再試；`timeout`＝畫面端等不到回覆而放棄（後端可能仍在忙，可以重試）。 */
export type BackendErrorKind = 'revoked' | 'unavailable' | 'timeout' | 'invalid' | 'other'

/**
 * 被隔離時要使用者去的地方（0.1.3）。不寫完整路徑，因為外掛管理頁在不同版本的 TeamUQ 放在不同地方：1.6.8 是「設定」裡的「外掛」分類
 * （`settingsGroupConfig.ts` @ b8b96cb3），1.7.1 搬到「我的 AI」的「外掛」分頁（`categoryTabs.ts` @ 550cdce1f）。兩版的那一頁都叫「外掛」，
 * 打開外掛後的「總覽」都有「它可以做的事」與同名的權限開關、「暫停使用／恢復使用／重新啟動」（`OverviewTab.tsx`）。
 * 這兩個名稱由 `npm run check:core-gate-conformance` 對 Core 原始碼核對。定義在 `src/shared/teamuqPlaces.ts`（外掛 backend 的訊息也用同一組名稱）。
 * `PERMISSIONS_SECTION_TITLE`＝外掛頁「總覽」裡列出權限開關的區塊標題（Core `OverviewTab.tsx` AllowSection）。
 */
export { PERMISSIONS_SECTION_TITLE, PLUGIN_PAGE_PLACE }

/**
 * TeamUQ 已拒絕這個外掛的後端呼叫。`backend:invoke` 在目前 Core 是舊 manifest 相容欄位，不是使用者可關閉的授權；被拒絕可能來自非完全信任級套件、外掛停用，或逾時隔離。
 * 重試不會解除停用或逾時隔離，要使用者到 TeamUQ 處理。
 *   - Core 的 `backendInvokeGate.ts` 以 installed / enabled / trusted / manifest method allowlist 驗證每次呼叫；外掛停用（beforeDisable → revoke）與單次呼叫逾時（timeoutPlugin）會隔離。
 *   - 隔離當下正在進行的呼叫拿到原因碼（`plugin_permission_denied`／`backend_invoke_timeout`）；之後每個新呼叫一律是 `plugin_disabled`，
 *     Core 不再告訴外掛是哪一種原因（`:74`）。所以 `plugin_disabled` 不能斷定是「停用」，`plugin_permission_denied` 也可能是停用造成的。
 *   - `backend:invoke` 舊欄位不另行授權；若套件信任狀態恢復，下一次呼叫會重新檢查政策。解除停用／逾時隔離則需 `activate()`（外掛停用再啟用的 afterEnable）或重新啟動 TeamUQ。
 */
const FENCED_TEXT = `TeamUQ 目前不讓這個外掛呼叫後端，所以讀不到 LINE 與待辦資料。可能的原因：外掛不是「完全信任級」組合外掛、外掛已停用，或後端太久沒有回應而被 TeamUQ 隔離。請到 ${PLUGIN_PAGE_PLACE}打開這個外掛，確認執行範圍是「完全信任級」且外掛已啟用；若套件來源或信任狀態有問題，請重新安裝可信任來源的外掛；若後端逾時被隔離，請把外掛停用再啟用，或重新啟動 TeamUQ。`

const REVOKED_TEXT: Record<string, string> = {
  plugin_permission_denied: FENCED_TEXT,
  plugin_disabled: FENCED_TEXT,
  // 逾時也會隔離（Core `timeoutPlugin`）：之後所有呼叫都是 plugin_disabled，「稍後再試」不會成功。
  backend_invoke_timeout: `外掛後端太久沒有回應，TeamUQ 已把它停止，並暫停這個外掛的後端呼叫；稍後再試也不會恢復。請到 ${PLUGIN_PAGE_PLACE}打開這個外掛，把它停用再啟用，或重新啟動 TeamUQ。`,
  plugin_not_installed: '這個外掛已從 TeamUQ 移除，請重新安裝。'
}

/** backend 暫時不能用（沒起來、忙、當掉）：沒有被隔離，稍後再試。 */
const UNAVAILABLE_TEXT: Record<string, string> = {
  plugin_backend_unavailable: '外掛後端暫時無法回應（可能正在啟動或忙碌），稍後再試。',
  plugin_backend_busy: '外掛後端暫時無法回應（可能正在啟動或忙碌），稍後再試。',
  plugin_backend_crashed: '外掛後端意外結束，TeamUQ 會重新啟動它；稍後再試。',
  backend_call_failed: '無法連到外掛後端，稍後再試。',
  backend_stopped: '外掛後端正在關閉或重新啟動，稍後再試。',
  runtime_not_running: '外掛後端還在啟動中，稍後再試。',
  job_not_found: '外掛後端在這段期間重新啟動過，這次操作的結果已無法取回；請確認目前狀態後再試一次。',
  disposed: '畫面正在關閉。'
}

/** 畫面端等待逾時（`pluginTransport.ts` 的 `view_call_timeout`）：不是 TeamUQ 的隔離，後端多半只是忙或剛啟動；重試是有用的。 */
export const VIEW_CALL_TIMEOUT_TEXT = '讀取逾時：後端太久沒有回應，可以按「重試」。'
const TIMEOUT_TEXT: Record<string, string> = {
  view_call_timeout: VIEW_CALL_TIMEOUT_TEXT
}

/** 呼叫格式或版本不一致（不應該發生；多半是外掛 UI 與 backend 版本不同）。 */
const INVALID_TEXT: Record<string, string> = {
  backend_method_not_allowed: '這個操作不在外掛宣告的方法清單內（外掛畫面與後端的版本可能不一致），請重新安裝外掛。',
  method_mismatch: '外掛畫面與後端的版本不一致，請重新安裝外掛。',
  method_unknown: '外掛畫面與後端的版本不一致，請重新安裝外掛。',
  path_unknown: '外掛畫面與後端的版本不一致，請重新安裝外掛。',
  backend_invoke_invalid: '送給外掛後端的資料格式不正確。',
  backend_invoke_too_large: '送給外掛後端的資料太大。',
  request_too_large: '送給外掛後端的資料太大。'
}

function codeOf(error: unknown): string | null {
  if (error !== null && typeof error === 'object') {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && /^[a-z_]{2,64}$/.test(code)) return code
  }
  return null
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try { return JSON.stringify(error) } catch { return String(error) }
}

export interface DescribedError {
  kind: BackendErrorKind
  /** host／backend 的錯誤碼（沒有＝null）。 */
  code: string | null
  /** 給使用者看的一句話。 */
  text: string
}

export function describeBackendError(error: unknown): DescribedError {
  const code = codeOf(error)
  if (code !== null && REVOKED_TEXT[code]) return { kind: 'revoked', code, text: REVOKED_TEXT[code] }
  if (code !== null && TIMEOUT_TEXT[code]) return { kind: 'timeout', code, text: TIMEOUT_TEXT[code] }
  if (code !== null && UNAVAILABLE_TEXT[code]) return { kind: 'unavailable', code, text: UNAVAILABLE_TEXT[code] }
  if (code !== null && INVALID_TEXT[code]) return { kind: 'invalid', code, text: INVALID_TEXT[code] }
  const message = messageOf(error).trim()
  return { kind: 'other', code, text: message === '' ? '發生未知錯誤' : message.slice(0, 300) }
}

/** 這個錯誤是畫面端的等待逾時嗎（畫面用來決定要不要多給一個「重試」，而不是再疊一則紅色錯誤）。 */
export function isViewCallTimeout(error: unknown): boolean {
  return codeOf(error) === 'view_call_timeout'
}

/**
 * 後端階段 → 狀態列的一句話（外掛版 `pluginTransport.ts` 的 phase；standalone 沒有 phase，傳 null）。`ready` 不顯示任何階段文字（回 null，由橋接狀態接手）。
 * `retry`＝這個階段要多給一個「重試」；`tone: 'err'`＝異常，必須在預設畫面就看得出來（不可隱藏）。
 */
export function describePhase(phase: BackendPhase | null): { text: string; tone: 'err' | ''; retry: boolean } | null {
  switch (phase) {
    case 'starting': return { text: '後端啟動中…（首次開啟需要數秒）', tone: '', retry: false }
    case 'connecting': return { text: '連線中…', tone: '', retry: false }
    case 'timeout': return { text: '讀取逾時', tone: 'err', retry: true }
    case 'error': return { text: '無法連線', tone: 'err', retry: true }
    default: return null
  }
}

/** `前綴：說明`。 */
export function backendErrorText(error: unknown, prefix?: string): string {
  const { text } = describeBackendError(error)
  return prefix ? `${prefix}：${text}` : text
}

/** 包住一個非同步動作：失敗時把說明交給 `onError`（畫面顯示），回傳 undefined；不讓錯誤變成未處理的 rejection。 */
export async function guarded<T>(run: () => Promise<T>, onError: (text: string, error: unknown) => void, prefix?: string): Promise<T | undefined> {
  try {
    return await run()
  } catch (error) {
    onError(backendErrorText(error, prefix), error)
    return undefined
  }
}
