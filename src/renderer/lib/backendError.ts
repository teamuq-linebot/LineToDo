/**
 * backendError.ts — 把 API 呼叫失敗變成使用者看得懂的一句話（G-02／G-03）。
 *
 * 外掛開發者指南 §2：「呼叫可能因權限、方法不在 allowlist、逾時或 backend 無法使用而失敗。請以 try/catch 顯示錯誤，勿假設呼叫一定成功。」
 * standalone 與外掛共用的元件都用它：外掛版的錯誤帶 TeamUQ host 的固定錯誤碼（`pluginTransport.ts` 的 `PluginBackendError.code`），
 * standalone 的 IPC 錯誤沒有這些碼，就照原本的訊息顯示。這個檔案不 import 外掛傳輸層（standalone bundle 不需要它），只看 `code`。
 */

/** `revoked`＝TeamUQ 已隔離這個外掛的後端呼叫（權限關閉／停用／逾時，見下方 FENCED_TEXT）或外掛已移除；`unavailable`＝暫時的，稍後再試。 */
export type BackendErrorKind = 'revoked' | 'unavailable' | 'invalid' | 'other'

/**
 * TeamUQ 已「隔離」這個外掛的後端呼叫（review B1：照 Core 1.7.1 `backendInvokeGate.ts` 的實際行為寫）。重試不會好，要使用者到 TeamUQ 處理。
 *   - Core 有三種隔離來源：關閉「後端呼叫」權限（refreshGrants → revoke）、停用外掛（beforeDisable → revoke）、單次呼叫逾時（timeoutPlugin）。
 *   - 隔離當下正在進行的呼叫拿到原因碼（`plugin_permission_denied`／`backend_invoke_timeout`）；之後每個新呼叫一律是 `plugin_disabled`，
 *     Core 不再告訴外掛是哪一種原因（`:74`）。所以 `plugin_disabled` 不能斷定是「停用」，`plugin_permission_denied` 也可能是停用造成的。
 *   - 解除隔離只有 `activate()`（外掛停用再啟用的 afterEnable）或重新啟動 TeamUQ。在「我的 AI › 外掛」重新允許權限**不會**解除（refreshGrants
 *     不呼叫 activate），所以這裡不承諾「重新允許後會自動恢復」，而是列出使用者實際能做、而且有效的操作。
 */
const FENCED_TEXT = 'TeamUQ 目前不讓這個外掛呼叫後端，所以讀不到 LINE 與待辦資料。可能的原因：「後端呼叫」權限（backend:invoke）被關閉、外掛被停用，或外掛後端太久沒有回應而被 TeamUQ 隔離。請到 TeamUQ「我的 AI › 外掛」確認這個外掛已允許「後端呼叫」而且是啟用的；如果之後仍沒有恢復，請把外掛停用再啟用，或重新啟動 TeamUQ。'

const REVOKED_TEXT: Record<string, string> = {
  plugin_permission_denied: FENCED_TEXT,
  plugin_disabled: FENCED_TEXT,
  // 逾時也會隔離（Core `timeoutPlugin`）：之後所有呼叫都是 plugin_disabled，「稍後再試」不會成功。
  backend_invoke_timeout: '外掛後端太久沒有回應，TeamUQ 已把它停止，並暫停這個外掛的後端呼叫；稍後再試也不會恢復。請到 TeamUQ「我的 AI › 外掛」把這個外掛停用再啟用，或重新啟動 TeamUQ。',
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
  if (code !== null && UNAVAILABLE_TEXT[code]) return { kind: 'unavailable', code, text: UNAVAILABLE_TEXT[code] }
  if (code !== null && INVALID_TEXT[code]) return { kind: 'invalid', code, text: INVALID_TEXT[code] }
  const message = messageOf(error).trim()
  return { kind: 'other', code, text: message === '' ? '發生未知錯誤' : message.slice(0, 300) }
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
