/**
 * cli/env.ts — 傳給 CLI 子程序的環境變數清洗（design.md §2.2「最關鍵的一行」，Batch 2）。
 *
 * ## 為什麼是 denylist 而不是 allowlist
 *
 * CLI 需要一整套系統環境（PATH / SystemRoot / TEMP / APPDATA / 使用者 proxy 設定…）才能跑，
 * allowlist 會不斷漏東西，而且每漏一次的症狀都是「在我機器上好好的」。
 * 真正有害的變數是**可枚舉的少數幾個**：會讓 CLI 改走 API 金鑰或第三方後端的那些。
 *
 * ## 實測佐證（spike-results.md §6）
 *
 * - 清乾淨後 `system/init` 的 `apiKeySource` = `"none"`、`claude auth status` 回
 *   `authMethod: "claude.ai"` / `subscriptionType: "max"` → 確實走訂閱 OAuth。
 * - 故意注入 `ANTHROPIC_API_KEY=sk-ant-bogus` → `-p` 直接 exit 1，
 *   `result: "Invalid API key · Fix external API key"`，且 `email/orgId/subscriptionType` 全變 null。
 *   **環境變數無條件優先於訂閱登入**，所以這一步是必要的，不是保險。
 *
 * ## 刻意保留
 *
 * `CLAUDE_CONFIG_DIR` **不刪**：它決定 CLI 讀哪個設定/憑證目錄，刪掉會讓「使用者把設定放在
 * 非預設位置」的情境直接變成未登入。它不會繞過訂閱驗證。
 */

/**
 * 預設 denylist（大小寫不敏感，Windows 環境變數本來就不分大小寫）。
 * Batch 3 / 4 若有各自要擋的（例如 codex 的 OPENAI_* 相關），用 `extraDeny` 疊加，不要改這裡。
 */
export const CLI_ENV_DENYLIST: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY'
]

/** 明確記錄「刻意保留」的變數，避免日後有人「順手」補進 denylist。 */
export const CLI_ENV_KEEP: readonly string[] = ['CLAUDE_CONFIG_DIR']

export interface SanitizeEnvOptions {
  /** 額外要刪的變數名（provider 專屬）。 */
  extraDeny?: readonly string[]
  /** 額外要注入的變數（例如 CODEX_HOME）。在刪除之後才套用，可覆寫。 */
  extra?: NodeJS.ProcessEnv
  /** 來源環境；預設 process.env。單元測試可注入假的。 */
  base?: NodeJS.ProcessEnv
}

/**
 * 回傳一份**新的**環境物件（不動 process.env）。
 */
export function sanitizeEnv(opts: SanitizeEnvOptions = {}): NodeJS.ProcessEnv {
  const base = opts.base ?? process.env
  const keep = new Set(CLI_ENV_KEEP.map((k) => k.toUpperCase()))
  const deny = new Set(
    [...CLI_ENV_DENYLIST, ...(opts.extraDeny ?? [])]
      .map((k) => k.toUpperCase())
      .filter((k) => !keep.has(k))
  )

  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (deny.has(key.toUpperCase())) continue
    out[key] = value
  }
  for (const [key, value] of Object.entries(opts.extra ?? {})) {
    if (value === undefined) continue
    out[key] = value
  }
  return out
}

/** 診斷用：列出這次會被刪掉、且來源環境**確實有設**的變數名（只回名字，不回值）。 */
export function listStrippedEnvNames(opts: SanitizeEnvOptions = {}): string[] {
  const base = opts.base ?? process.env
  const keep = new Set(CLI_ENV_KEEP.map((k) => k.toUpperCase()))
  const deny = new Set(
    [...CLI_ENV_DENYLIST, ...(opts.extraDeny ?? [])]
      .map((k) => k.toUpperCase())
      .filter((k) => !keep.has(k))
  )
  return Object.keys(base).filter((k) => deny.has(k.toUpperCase()))
}
