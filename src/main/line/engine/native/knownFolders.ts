/**
 * knownFolders.ts — 外掛 backend 找 `%LOCALAPPDATA%`（也就是 LINE 資料目錄的上層）。
 *
 * 1.6.8 的 run-as-node backend 只繼承 `{PATH, SystemRoot, windir, TEMP, TMP}` 這幾個環境變數，沒有 `LOCALAPPDATA`，
 * 所以不能像 standalone 那樣靠 `process.env.LOCALAPPDATA` 推導 `...\LINE\Data\db`。這裡用 koffi 問 Windows
 * （`SHGetKnownFolderPath(FOLDERID_LocalAppData)`，純查詢、不碰任何檔案），查不到才退回環境變數與 TEMP 推導。
 */
import { win32 } from 'node:path'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KoffiApi = any

/** FOLDERID_LocalAppData = {F1B32785-6FBA-4FCF-9D55-7B8E7F157091} */
const FOLDERID_LOCAL_APP_DATA = { Data1: 0xf1b32785, Data2: 0x6fba, Data3: 0x4fcf, Data4: [0x9d, 0x55, 0x7b, 0x8e, 0x7f, 0x15, 0x70, 0x91] }

interface KnownFolderApi {
  SHGetKnownFolderPath: (rfid: typeof FOLDERID_LOCAL_APP_DATA, flags: number, token: null, out: unknown[]) => number
  CoTaskMemFree: (ptr: unknown) => void
}
const apiCache = new WeakMap<object, KnownFolderApi>()

function bind(koffi: KoffiApi): KnownFolderApi {
  const cached = apiCache.get(koffi)
  if (cached) return cached
  const shell32 = koffi.load('shell32.dll')
  const ole32 = koffi.load('ole32.dll')
  koffi.struct('LT_GUID', { Data1: 'uint32_t', Data2: 'uint16_t', Data3: 'uint16_t', Data4: koffi.array('uint8_t', 8) })
  const api: KnownFolderApi = {
    SHGetKnownFolderPath: shell32.func('int32 __stdcall SHGetKnownFolderPath(LT_GUID* rfid, uint32 dwFlags, void* hToken, _Out_ void** ppszPath)'),
    CoTaskMemFree: ole32.func('void __stdcall CoTaskMemFree(void* pv)')
  }
  apiCache.set(koffi, api)
  return api
}

/** koffi 取 LocalAppData；失敗回 null。 */
export function knownLocalAppData(koffi: KoffiApi): string | null {
  try {
    const api = bind(koffi)
    const out: unknown[] = [null]
    const hr = api.SHGetKnownFolderPath(FOLDERID_LOCAL_APP_DATA, 0, null, out)
    if (hr !== 0 || out[0] === null || out[0] === undefined) return null
    try {
      const path = koffi.decode(out[0], 'char16_t', -1) as string
      return typeof path === 'string' && path.length > 0 ? path : null
    } finally {
      api.CoTaskMemFree(out[0])
    }
  } catch {
    return null
  }
}

/**
 * LocalAppData 解析順序：koffi 問 Windows → `LOCALAPPDATA` → 由 `TEMP` 往上推（`...\AppData\Local\Temp` → `...\AppData\Local`）。
 * 都失敗回 null（呼叫端要明確報錯，不能猜）。
 */
export function resolveLocalAppData(koffi: KoffiApi, env: Record<string, string | undefined> = process.env): string | null {
  const known = knownLocalAppData(koffi)
  if (known) return known
  const fromEnv = env.LOCALAPPDATA?.trim()
  if (fromEnv) return fromEnv
  const temp = (env.TEMP ?? env.TMP)?.trim()
  if (temp) {
    const parts = temp.split(/[\\/]+/)
    const at = parts.findIndex((p, i) => p.toLowerCase() === 'appdata' && (parts[i + 1] ?? '').toLowerCase() === 'local')
    if (at >= 0) return parts.slice(0, at + 2).join('\\')
  }
  return null
}

/** `%LOCALAPPDATA%\LINE\Data\db`（對齊 standalone 的 `DEFAULT_LINE_DB_DIR`）。 */
export function resolveLineDbDir(koffi: KoffiApi, env?: Record<string, string | undefined>): string | null {
  const base = resolveLocalAppData(koffi, env)
  return base ? win32.join(base, 'LINE', 'Data', 'db') : null
}
