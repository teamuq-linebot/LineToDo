/**
 * qwen.ts — qwen（OpenAI 相容）連線設定解析（IMPLEMENTATION_PLAN.md §6 / §7.2）。
 *
 * 金鑰供應優先序（§7.2）：
 *   1) safeStorage 加密檔（設定頁輸入；主要來源）—— 屬 M3 設定頁，本輪先預留掛勾。
 *   2) 環境變數 QWEN_API_KEY（後備 / 開發 / smoke 腳本）。
 *   解析優先序：safeStorage 檔 > 環境變數。兩者皆無 → LLM 階段優雅停用（不崩潰、不硬寫）。
 *
 * 本輪（M2 抽取管線）：safeStorage 讀取以 getApiKeyFromSafeStorage 抽象出來，
 * 預設回 null（M3 接設定頁時實作），所以目前實質走環境變數。baseURL/model 可被 env 覆寫。
 *
 * ⚠️ 金鑰嚴禁硬寫進原始碼、嚴禁存進 sqlite 明文、嚴禁回傳 renderer 明文。
 */

export interface QwenConfig {
  /** 解析後的金鑰；無任何來源時為 null（呼叫端據此優雅停用 LLM）。 */
  apiKey: string | null
  baseURL: string
  model: string
  /** 單次 request timeout（毫秒）。 */
  timeoutMs: number
  /** 金鑰來源（觀測用，不含金鑰本身）。 */
  source: 'safeStorage' | 'env' | 'none'
}

const DEFAULT_BASE_URL = 'https://qwen.tuq.tw/v1'
const DEFAULT_MODEL = 'qwen36-fp8'
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * 從 safeStorage 加密檔讀金鑰。本輪先回 null（佔位）；M3 設定頁會以
 * Electron safeStorage.decryptString 即用即丟讀取，並在此回傳。
 *
 * 抽成可注入 hook，讓測試/腳本能在無 Electron 環境下不被 safeStorage 牽連。
 */
export type SafeStorageReader = () => string | null

let safeStorageReader: SafeStorageReader = () => null

/** M3 設定頁啟用後注入真正的 safeStorage 讀取器。 */
export function setSafeStorageReader(reader: SafeStorageReader): void {
  safeStorageReader = reader
}

function readEnvKey(): string | null {
  const k = process.env.QWEN_API_KEY?.trim()
  return k ? k : null
}

/**
 * 解析當前 qwen 設定。每次呼叫即時解析（金鑰即用即丟，不在模組層長存）。
 */
export function getQwenConfig(): QwenConfig {
  const baseURL = process.env.QWEN_BASE_URL?.trim() || DEFAULT_BASE_URL
  const model = process.env.QWEN_MODEL?.trim() || DEFAULT_MODEL
  const timeoutEnv = Number(process.env.QWEN_TIMEOUT_MS)
  const timeoutMs =
    Number.isFinite(timeoutEnv) && timeoutEnv > 0 ? timeoutEnv : DEFAULT_TIMEOUT_MS

  // 優先序：safeStorage 檔 > 環境變數。
  let apiKey: string | null = null
  let source: QwenConfig['source'] = 'none'
  try {
    const fromSafe = safeStorageReader()
    if (fromSafe && fromSafe.trim()) {
      apiKey = fromSafe.trim()
      source = 'safeStorage'
    }
  } catch {
    /* safeStorage 後端不可用（§9 未驗證項）—— 退回環境變數，不崩潰。 */
  }
  if (!apiKey) {
    const fromEnv = readEnvKey()
    if (fromEnv) {
      apiKey = fromEnv
      source = 'env'
    }
  }

  return { apiKey, baseURL, model, timeoutMs, source }
}

/** 是否具備可用金鑰（UI 提示 / pipeline 是否啟用 LLM 用）。 */
export function hasQwenKey(): boolean {
  return getQwenConfig().apiKey !== null
}
