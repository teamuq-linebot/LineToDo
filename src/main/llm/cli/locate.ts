import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'

import { locateFailureToError } from './errors'
import type { CliLocation, CliName, LocateOutcome } from './types'
import type { LlmProviderError } from '../provider/types'

/**
 * cli/locate.ts — CLI 執行檔定位與快取（design.md §3.1 / §3.2，Batch 2）。
 *
 * ## 偏好序不能寫死「哪個 CLI 是 exe」
 *
 * design.md 假設「`.cmd` 陷阱只發生在 codex」。spike-results.md §1 實測**完全相反**：
 * 這台機器上 `where.exe codex` 找得到原生 `codex.exe`，而 `claude` 在 PATH 上**只有 `.cmd`**
 * （`C:\nvm4w\nodejs\claude.cmd`，內部再去呼叫 npm 套件內的 `claude.exe`）。
 *
 * 所以這裡的作法是**對兩個 CLI 用同一套規則**、以副檔名排序，而不是對某個 CLI 假設結果：
 *   1. 收集所有候選（PATH → 由 `.cmd` 所在目錄推導的 npm 原生 exe → fallback 清單）
 *   2. 過濾掉不能直接 spawn 的（`.ps1`、無副檔名的 shell script）
 *   3. 依 `.exe` > `.com` > `.cmd` > `.bat` 取最優
 *
 * 第 2 步的「由 `.cmd` 推導原生 exe」是 spike §1 的直接產物：
 * `<npm bin>\claude.cmd` 旁邊就有 `<npm bin>\node_modules\@anthropic-ai\claude-code\bin\claude.exe`，
 * 找得到就能整個避開 cmd.exe 這條路（連帶避開 §9 的 `&` / 引號問題）。
 *
 * ## 快取（design.md §3.2）
 *
 * 模組層 Map、**無 TTL**，三個明確失效時機：
 *   1. app 重啟（自然失效）
 *   2. 使用者改設定 → Batch 5 在 updateSettings 後呼叫 `invalidateCliCache()`
 *      （另外本檔會記住當時的 override 字串，override 變了也會自動略過快取，屬雙保險）
 *   3. spawn 拿到 ENOENT → 呼叫端 `invalidateCliCache(name)` 後重新定位一次（見 run.ts 的 runLocatedCli）
 *
 * **只快取成功結果**：快取「找不到」會讓「使用者在 app 執行中才安裝 CLI」永遠好不了，
 * 而失敗路徑本來就有熔斷（design §5.5）在擋頻率。
 * **絕不快取登入狀態**——那隨時會變，快取只會給出騙人的綠燈。
 */

const WHERE_TIMEOUT_MS = 2000

/** 可直接 spawn 的副檔名與偏好序（數字越小越優先）。 */
const EXT_RANK: Readonly<Record<string, number>> = {
  '.exe': 0,
  '.com': 1,
  '.cmd': 2,
  '.bat': 3
}

/**
 * npm 全域安裝時，`<bin>\xxx.cmd` 旁邊可能存在的原生 exe 相對路徑。
 * claude 那條是 spike §1 實測確認存在的；codex 那條是同慣例的推測，找不到就自動略過。
 */
const NATIVE_SIBLINGS: Readonly<Record<CliName, readonly string[]>> = {
  claude: [join('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')],
  codex: [join('node_modules', '@openai', 'codex', 'bin', 'codex.exe')]
}

export interface LocateDeps {
  platform?: NodeJS.Platform
  fileExists?: (path: string) => boolean
  /** 預設用 `where.exe`（Windows）/ `which -a`。單元測試可注入固定清單。 */
  listFromSystemPath?: (name: CliName) => Promise<string[]>
  fallbackPaths?: (name: CliName) => string[]
}

interface Candidate {
  path: string
  source: CliLocation['source']
}

interface CacheEntry {
  /** 產生這筆快取時的 override 字串；不同就重新定位。 */
  override: string
  location: CliLocation
}

const cache = new Map<CliName, CacheEntry>()

/** 省略 name = 全清（設定變更時用）。 */
export function invalidateCliCache(name?: CliName): void {
  if (name) cache.delete(name)
  else cache.clear()
}

/** 純字串判定，不碰檔案系統；run.ts 也用同一個規則。 */
export function isBatchPath(path: string): boolean {
  return /\.(cmd|bat)$/i.test(path.trim())
}

function envJoin(key: string, ...parts: string[]): string | null {
  const base = process.env[key]
  if (!base) return null
  return join(base, ...parts)
}

/**
 * `where.exe` 找不到時的備援。理由（design §3.1）：Electron app 從開始選單或開機自動啟動時
 * 繼承的 PATH 可能與使用者終端機不同（npm 全域 bin 是安裝時才寫進 user PATH 的），
 * `where.exe` 會找不到但檔案確實存在。
 */
export function defaultFallbackPaths(name: CliName): string[] {
  const raw =
    name === 'claude'
      ? [
          envJoin('USERPROFILE', '.local', 'bin', 'claude.exe'),
          envJoin('LOCALAPPDATA', 'Programs', 'claude', 'claude.exe'),
          envJoin('APPDATA', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
          envJoin('APPDATA', 'npm', 'claude.cmd')
        ]
      : [
          // spike §1 實測本機命中這一條。
          envJoin('LOCALAPPDATA', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
          envJoin('USERPROFILE', '.codex', 'bin', 'codex.exe'),
          envJoin('APPDATA', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.exe'),
          envJoin('APPDATA', 'npm', 'codex.cmd'),
          envJoin('LOCALAPPDATA', 'Programs', 'codex', 'codex.exe')
        ]
  return raw.filter((p): p is string => p !== null)
}

function listFromSystemPathDefault(name: CliName): Promise<string[]> {
  const win = process.platform === 'win32'
  const finder = win ? 'where.exe' : 'which'
  const args = win ? [name] : ['-a', name]
  return new Promise((resolve) => {
    execFile(
      finder,
      args,
      { windowsHide: true, timeout: WHERE_TIMEOUT_MS, encoding: 'utf8' },
      (err, stdout) => {
        if (err) {
          resolve([])
          return
        }
        resolve(
          stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
        )
      }
    )
  })
}

function rankOf(path: string, platform: NodeJS.Platform): number | null {
  const ext = extname(path).toLowerCase()
  if (platform !== 'win32') {
    // 非 Windows：沒有副檔名慣例，除了 .ps1 一律視為可執行。
    return ext === '.ps1' ? null : 0
  }
  const rank = EXT_RANK[ext]
  // 無副檔名（npm 產的 sh script）與 .ps1 在 Windows 上都不能直接 spawn。
  return rank === undefined ? null : rank
}

/** 去掉前後空白與使用者可能貼上的成對引號。 */
function normalizeOverride(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

/**
 * 定位 CLI。`userOverride` 為設定頁的手動指定路徑（Batch 5 接上；空字串＝自動偵測）。
 *
 * 手動指定但檔案不存在時**不會偷偷退回自動偵測**——使用者明確指定卻被忽略，
 * 是最難查的一種 bug（design §3.1）。
 */
export async function locateCli(
  name: CliName,
  userOverride = '',
  deps: LocateDeps = {}
): Promise<LocateOutcome> {
  const platform = deps.platform ?? process.platform
  const exists = deps.fileExists ?? existsSync
  const override = normalizeOverride(userOverride)

  const cached = cache.get(name)
  if (cached && cached.override === override) {
    return { ok: true, location: cached.location }
  }

  if (override.length > 0) {
    if (!exists(override)) {
      return { ok: false, reason: 'override_missing', searched: [override] }
    }
    const location: CliLocation = {
      path: override,
      isBatch: isBatchPath(override),
      source: 'override'
    }
    cache.set(name, { override, location })
    return { ok: true, location }
  }

  const searched: string[] = []
  const candidates: Candidate[] = []

  const fromPath = await (deps.listFromSystemPath ?? listFromSystemPathDefault)(name)
  for (const path of fromPath) {
    searched.push(path)
    candidates.push({ path, source: 'path' })
  }
  // 由 PATH 上的 .cmd 反推 npm 套件內的原生 exe（spike §1）。
  for (const path of fromPath) {
    if (!isBatchPath(path)) continue
    for (const rel of NATIVE_SIBLINGS[name]) {
      const guess = join(dirname(path), rel)
      searched.push(guess)
      candidates.push({ path: guess, source: 'path' })
    }
  }
  for (const path of (deps.fallbackPaths ?? defaultFallbackPaths)(name)) {
    searched.push(path)
    candidates.push({ path, source: 'fallback' })
  }

  let best: { candidate: Candidate; rank: number } | null = null
  for (const candidate of candidates) {
    const rank = rankOf(candidate.path, platform)
    if (rank === null) continue
    if (best !== null && rank >= best.rank) continue
    if (!exists(candidate.path)) continue
    best = { candidate, rank }
    if (rank === 0) break
  }

  if (best === null) {
    return { ok: false, reason: 'not_found', searched }
  }

  const location: CliLocation = {
    path: best.candidate.path,
    isBatch: isBatchPath(best.candidate.path),
    source: best.candidate.source
  }
  cache.set(name, { override, location })
  return { ok: true, location }
}

/** locateCli 的 throw 版：失敗直接拋 invalid_config / not_installed。 */
export async function locateCliOrThrow(
  name: CliName,
  userOverride = '',
  deps: LocateDeps = {}
): Promise<CliLocation> {
  const outcome = await locateCli(name, userOverride, deps)
  if (outcome.ok) return outcome.location
  const error: LlmProviderError | null = locateFailureToError(name, outcome)
  throw error ?? new Error(`locateCli(${name}) failed`)
}
