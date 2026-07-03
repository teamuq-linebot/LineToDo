import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { DEFAULTS, type BlocklistRules } from './defaults'

/**
 * settings.ts — App 設定持久化（IMPLEMENTATION_PLAN.md §7）。
 *
 * 兩個獨立存放：
 *   1) settings.json（userData/）—— 一般設定（輪詢頻率、並發、blocklist 規則等）。明文 JSON。
 *   2) qwen.key（userData/）—— QWEN_API_KEY，用 Electron safeStorage 加密落檔（DPAPI/keychain）。
 *      ⚠️ 金鑰嚴禁進 settings.json、嚴禁回傳 renderer 明文（§7.2）。
 *
 * 對 renderer 暴露的設定 DTO 只含「可顯示」欄位 + hasApiKey:boolean。
 */

/** 開機自我對帳設定（Batch 5a；reconcileRunner 讀取）。 */
export interface ReconcileSettings {
  /** 是否啟用開機自我對帳。false → 啟動時完全跳過對帳（不掃描、不寫入）。預設 true。 */
  enabled: boolean
  /** 對帳範圍：只看近 N 月。0 = 全部歷史（預設）；合法值 3 / 6 / 12。透傳 detectGaps.scopeMonths。 */
  scopeMonths: number
}

export interface AppSettings {
  pollIntervalSec: number
  concurrency: number
  recentContextLimit: number
  blocklist: BlocklistRules
  /** 逐對話關鍵字忽略：chatId → 小寫關鍵字陣列。抽取後過濾 title/detail 命中者（per-chat 第二層忽略）。 */
  chatIgnoreKeywords: Record<string, string[]>
  /** 開機自動啟動（使用者要求預設開）。啟動時與變更時透過 app.setLoginItemSettings 套用。 */
  openAtLogin: boolean
  /** 開機自我對帳設定（Batch 5a）。 */
  reconcile: ReconcileSettings
}

/** 回傳 renderer 的設定（不含任何金鑰；以 hasApiKey 表達金鑰是否已設定）。 */
export interface SettingsView extends AppSettings {
  hasApiKey: boolean
  /** 金鑰來源（觀測用，UI 可提示「目前使用環境變數金鑰」）。 */
  apiKeySource: 'safeStorage' | 'env' | 'none'
  /** safeStorage 後端是否可用（不可用時 UI 提示僅能用環境變數）。 */
  safeStorageAvailable: boolean
}

export type SettingsPatch = Partial<{
  pollIntervalSec: number
  concurrency: number
  recentContextLimit: number
  blocklist: Partial<BlocklistRules>
  /** 整個替換逐對話關鍵字忽略表（呼叫端先讀現值、改完整表再送）。 */
  chatIgnoreKeywords: Record<string, string[]>
  openAtLogin: boolean
  /** 部分更新對帳設定（enabled / scopeMonths 可各自單獨送）。 */
  reconcile: Partial<ReconcileSettings>
}>

const SETTINGS_FILE = 'settings.json'
const KEY_FILE = 'qwen.key'

function userDataDir(): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return dir
}

function settingsPath(): string {
  return join(userDataDir(), SETTINGS_FILE)
}

function keyPath(): string {
  return join(userDataDir(), KEY_FILE)
}

/** 預設設定（從 defaults.ts 衍生，深拷貝 blocklist 避免共用參考被改）。 */
function defaultSettings(): AppSettings {
  return {
    pollIntervalSec: DEFAULTS.pollIntervalSec,
    concurrency: DEFAULTS.concurrency,
    recentContextLimit: DEFAULTS.recentContextLimit,
    blocklist: {
      nameKeywords: [...DEFAULTS.blocklist.nameKeywords],
      senderKeywords: [...DEFAULTS.blocklist.senderKeywords],
      contentTypeNoiseOnly: [...DEFAULTS.blocklist.contentTypeNoiseOnly],
      minTextLenForLLM: DEFAULTS.blocklist.minTextLenForLLM
    },
    chatIgnoreKeywords: {},
    // 使用者要求：開機自動啟動預設開。
    openAtLogin: true,
    // 對帳預設啟用、全歷史範圍（scopeMonths=0）。
    reconcile: { enabled: true, scopeMonths: 0 }
  }
}

/** 合法的對帳範圍值（月）。0 = 全歷史；其餘為近 N 月。非法值 → 退回 fallback。 */
const RECONCILE_SCOPE_VALUES = [0, 3, 6, 12]

/** 正規化對帳設定：enabled 轉 boolean，scopeMonths 限定合法值集合（非法退回預設）。 */
function normalizeReconcile(input: unknown, d: ReconcileSettings): ReconcileSettings {
  if (!input || typeof input !== 'object') return { ...d }
  const r = input as Partial<ReconcileSettings>
  const scope = Math.floor(Number(r.scopeMonths))
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    scopeMonths: RECONCILE_SCOPE_VALUES.includes(scope) ? scope : d.scopeMonths
  }
}

/** 正規化逐對話關鍵字忽略表：值須為字串陣列，trim + 小寫 + 去重，丟掉空陣列。 */
function normalizeChatIgnore(input: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  if (!input || typeof input !== 'object') return out
  for (const [chatId, arr] of Object.entries(input as Record<string, unknown>)) {
    if (!chatId || !Array.isArray(arr)) continue
    const kws = Array.from(
      new Set(arr.map(String).map((s) => s.trim().toLowerCase()).filter(Boolean))
    )
    if (kws.length) out[chatId] = kws
  }
  return out
}

// 記憶體快取（避免每次都讀檔；setSettings 時同步更新）。
let cached: AppSettings | null = null

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, lo), hi)
}

/** 把任意輸入正規化成合法 AppSettings（防 renderer 送壞值）。 */
function normalize(input: Partial<AppSettings>): AppSettings {
  const d = defaultSettings()
  const bl = input.blocklist ?? d.blocklist
  return {
    pollIntervalSec: clampInt(input.pollIntervalSec, 5, 3600, d.pollIntervalSec),
    concurrency: clampInt(input.concurrency, 1, 4, d.concurrency),
    recentContextLimit: clampInt(input.recentContextLimit, 0, 50, d.recentContextLimit),
    blocklist: {
      nameKeywords: Array.isArray(bl.nameKeywords)
        ? bl.nameKeywords.map(String).map((s) => s.trim()).filter(Boolean)
        : d.blocklist.nameKeywords,
      senderKeywords: Array.isArray(bl.senderKeywords)
        ? bl.senderKeywords.map(String).map((s) => s.trim()).filter(Boolean)
        : d.blocklist.senderKeywords,
      contentTypeNoiseOnly: Array.isArray(bl.contentTypeNoiseOnly)
        ? bl.contentTypeNoiseOnly
            .map((n) => Math.floor(Number(n)))
            .filter((n) => Number.isFinite(n))
        : d.blocklist.contentTypeNoiseOnly,
      minTextLenForLLM: clampInt(bl.minTextLenForLLM, 0, 100, d.blocklist.minTextLenForLLM)
    },
    chatIgnoreKeywords: normalizeChatIgnore(input.chatIgnoreKeywords),
    openAtLogin: typeof input.openAtLogin === 'boolean' ? input.openAtLogin : d.openAtLogin,
    reconcile: normalizeReconcile(input.reconcile, d.reconcile)
  }
}

/** 讀設定（首次讀檔；檔不存在或壞掉就回預設並寫回）。 */
export function getSettings(): AppSettings {
  if (cached) return cached
  const p = settingsPath()
  if (!existsSync(p)) {
    cached = defaultSettings()
    return cached
  }
  try {
    const raw = readFileSync(p, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    cached = normalize(parsed)
    return cached
  } catch (err) {
    console.error('[settings] 讀取失敗，回預設：', err)
    cached = defaultSettings()
    return cached
  }
}

/** 部分更新設定並落檔。回傳合併後的完整設定。 */
export function updateSettings(patch: SettingsPatch): AppSettings {
  const cur = getSettings()
  const merged: AppSettings = normalize({
    pollIntervalSec: patch.pollIntervalSec ?? cur.pollIntervalSec,
    concurrency: patch.concurrency ?? cur.concurrency,
    recentContextLimit: patch.recentContextLimit ?? cur.recentContextLimit,
    blocklist: {
      ...cur.blocklist,
      ...(patch.blocklist ?? {})
    },
    chatIgnoreKeywords: patch.chatIgnoreKeywords ?? cur.chatIgnoreKeywords,
    openAtLogin: patch.openAtLogin ?? cur.openAtLogin,
    // reconcile 部分更新：以「目前值」為 fallback 基準（patch 帶非法 scopeMonths 時保留現值，
    // 而非退回硬預設）。normalizeReconcile 對已合法的結果再跑一次為冪等。
    reconcile: normalizeReconcile(
      { ...cur.reconcile, ...(patch.reconcile ?? {}) },
      cur.reconcile
    )
  })
  cached = merged
  try {
    writeFileSync(settingsPath(), JSON.stringify(merged, null, 2), 'utf-8')
  } catch (err) {
    console.error('[settings] 寫檔失敗：', err)
  }
  return merged
}

// ── QWEN_API_KEY（safeStorage 加密）───────────────────────────────

/** safeStorage 後端是否可用（Windows DPAPI / mac keychain）。§9 未驗證項，runtime 偵測。 */
export function isSafeStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** 寫入金鑰（加密落檔）。safeStorage 不可用時 throw，呼叫端回友善錯誤。 */
export function setApiKey(apiKey: string): void {
  const k = apiKey.trim()
  if (!k) throw new Error('金鑰不可為空')
  if (!isSafeStorageAvailable()) {
    throw new Error('此機器的 safeStorage 加密後端不可用，無法安全儲存金鑰；請改用環境變數 QWEN_API_KEY')
  }
  const enc = safeStorage.encryptString(k)
  writeFileSync(keyPath(), enc)
}

/** 清除金鑰檔。冪等。 */
export function clearApiKey(): void {
  const p = keyPath()
  if (existsSync(p)) {
    try {
      rmSync(p)
    } catch (err) {
      console.error('[settings] 清除金鑰失敗：', err)
    }
  }
}

/**
 * 從 safeStorage 加密檔讀金鑰（即用即丟；qwen.ts 的 SafeStorageReader 用）。
 * 檔不存在 / safeStorage 不可用 / 解密失敗 → 回 null（呼叫端退回環境變數）。
 */
export function readApiKeyFromSafeStorage(): string | null {
  const p = keyPath()
  if (!existsSync(p)) return null
  if (!isSafeStorageAvailable()) return null
  try {
    const buf = readFileSync(p)
    const dec = safeStorage.decryptString(buf)
    return dec && dec.trim() ? dec.trim() : null
  } catch (err) {
    console.error('[settings] 金鑰解密失敗：', err)
    return null
  }
}

/** 是否已設定 safeStorage 金鑰（不解密內容，只看檔在不在 + 後端可用）。 */
export function hasSafeStorageKey(): boolean {
  return existsSync(keyPath()) && isSafeStorageAvailable()
}
