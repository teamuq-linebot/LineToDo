/**
 * foreground.ts — 前景權限（design-v2 §2.2，依 Batch 0-6）。
 *
 * Windows 只允許「目前的前景程序」把前景讓給別的程序。helper 是 main 的子程序、不在前景，
 * 所以每次 helper 要切前景（activateLine、focusEdit）之前，main 先呼叫 AllowSetForegroundWindow(helperPid)。
 * 這個呼叫便宜、失敗也沒有副作用，所以不做條件判斷。只宣告這一個 user32 函式（koffi，已是既有依賴）。
 */
import koffi from 'koffi'

type AllowFn = (pid: number) => boolean
let allowFn: AllowFn | null = null
let loadFailed = false

function load(): AllowFn | null {
  if (allowFn || loadFailed) return allowFn
  try {
    const user32 = koffi.load('user32.dll')
    allowFn = user32.func('bool __stdcall AllowSetForegroundWindow(uint32_t dwProcessId)') as AllowFn
  } catch {
    loadFailed = true
    allowFn = null
  }
  return allowFn
}

/** 允許 pid 切換前景。回傳 Win32 的結果；載入失敗或呼叫失敗都回 false（不拋）。 */
export function allowSetForeground(pid: number): boolean {
  const fn = load()
  if (!fn || !Number.isInteger(pid) || pid <= 0) return false
  try {
    return !!fn(pid)
  } catch {
    return false
  }
}

/** BrowserWindow.getNativeWindowHandle() 的 Buffer → HWND（bigint）。 */
export function hwndFromNativeHandle(buf: Buffer): bigint {
  if (buf.length >= 8) return buf.readBigUInt64LE(0)
  if (buf.length >= 4) return BigInt(buf.readUInt32LE(0))
  return 0n
}
