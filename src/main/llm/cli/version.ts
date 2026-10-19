/**
 * cli/version.ts — 版本字串解析與比較（design.md §2.4 / §3.3，Batch 2）。
 *
 * 抽在共用層的理由：Batch 3 要比 `MIN_CLAUDE_VERSION = '2.1.211'`（低於此版在 Windows 有
 * stdin bug，而我們**所有** prompt 都走 stdin），Batch 4 要比 `TESTED_CODEX_VERSION = '0.147.0'`。
 * 兩份各自實作的 semver 比較必然漂移。
 *
 * 這裡**只做字串處理**，不 spawn 任何東西——真正去問 CLI 版本是 health() 的事（Batch 3 / 4）。
 */

/**
 * 從 CLI 的 `--version` 輸出抓第一個 `x.y.z`。
 * 實測樣本（spike-results.md §1）：
 *   claude → `2.1.227 (Claude Code)`
 *   codex  → `codex-cli 0.147.0`
 * 兩種形狀都命中，所以不需要 per-provider 的解析器。
 */
export function extractSemver(text: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null
}

/** a < b → -1；a === b → 0；a > b → 1。無法解析的段視為 0。 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.').map((s) => Number.parseInt(s, 10))
  const pb = b.split('.').map((s) => Number.parseInt(s, 10))
  for (let i = 0; i < 3; i += 1) {
    const va = Number.isNaN(pa[i]) || pa[i] === undefined ? 0 : pa[i]
    const vb = Number.isNaN(pb[i]) || pb[i] === undefined ? 0 : pb[i]
    if (va < vb) return -1
    if (va > vb) return 1
  }
  return 0
}

/** `version` 是否 >= `minimum`。version 為 null（問不到版本）時回 true——不因為問不到就擋人。 */
export function meetsMinimumVersion(version: string | null, minimum: string): boolean {
  if (!version) return true
  return compareSemver(version, minimum) >= 0
}
