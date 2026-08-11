import { LlmProviderError } from '../provider/types'
import type { LlmErrorCode } from '../provider/types'
import { describeRunFailure } from './redact'
import type { SignalPattern } from './redact'
import type { CliName, CliRunResult, LocateOutcome } from './types'

/**
 * cli/errors.ts — CLI 層的錯誤分類共用型別與「機械可判定」的分類器（Batch 2）。
 *
 * 刻意**不另立一套 CliError 類別**：design.md §1.4 的 `LlmProviderError` / `LlmErrorCode`
 * 已是單一真實來源，再開一份只會讓 Batch 3 / 4 每次都要翻譯一遍、並在兩邊漂移。
 * 本檔只補「CLI 專屬的判定入口」。
 *
 * 分工線：**本層只判定 provider 無關的失敗**（找不到執行檔、spawn 失敗、逾時、被取消）。
 * 「未登入 / 限流 / 額度用盡 / 輸出不符預期」需要讀懂各自 CLI 的輸出格式，
 * 由 Batch 3（claude）/ Batch 4（codex）用 `SignalPattern` 字典 + `cliError()` 自行填。
 */

/** 與 design.md §1.4 一致；此處只是給 CLI 層一個語意化別名。 */
export type CliErrorCode = LlmErrorCode

/** runCli 前置檢查擋下來時，塞進 `spawnError.code` 的自訂碼。 */
export const ERR_CLI_UNSAFE_ARG = 'ERR_CLI_UNSAFE_ARG'

/** 建立錯誤。userMessage 會直接進 UI（繁中、單行、不含 stderr 原文）。 */
export function cliError(
  code: CliErrorCode,
  userMessage: string,
  detail?: string,
  cause?: unknown
): LlmProviderError {
  return new LlmProviderError(code, userMessage, detail, cause)
}

const CLI_LABEL: Record<CliName, string> = {
  claude: 'Claude CLI',
  codex: 'Codex CLI'
}

export function cliLabel(name: CliName): string {
  return CLI_LABEL[name]
}

/** 定位失敗 → 錯誤。`override_missing` 與 `not_found` 的處置完全不同，不可合併。 */
export function locateFailureToError(name: CliName, outcome: LocateOutcome): LlmProviderError | null {
  if (outcome.ok) return null
  const label = cliLabel(name)
  if (outcome.reason === 'override_missing') {
    return cliError(
      'invalid_config',
      `設定中指定的 ${label} 執行檔不存在：${outcome.searched[0] ?? ''}`,
      `locate=override_missing searched=${outcome.searched.length}`
    )
  }
  return cliError(
    'not_installed',
    `找不到 ${label}。請先安裝並確認可在終端機執行，或在設定中指定執行檔的完整路徑。`,
    `locate=not_found searched=${outcome.searched.length}`
  )
}

/**
 * 執行結果 → 錯誤（provider 無關的部分）。回 `null` 代表「進程正常跑完了」，
 * 後續要不要算失敗（exit code ≠ 0、輸出不合格）由 Batch 3 / 4 自行判斷。
 *
 * 判定順序刻意固定：spawn 失敗 → 逾時 → 取消。
 * **絕不用 exit code 判逾時**（spike §10：kill 後是 `code=null/SIGTERM` 或 `code=1`，不是 143）。
 */
export function classifyRunFailure(
  name: CliName,
  res: CliRunResult,
  stderrSignals: readonly SignalPattern[] = []
): LlmProviderError | null {
  const label = cliLabel(name)
  const detail = describeRunFailure(name, res, stderrSignals)

  if (res.spawnError) {
    const code = res.spawnError.code
    if (code === 'ENOENT') {
      return cliError(
        'not_installed',
        `找不到 ${label} 執行檔。請確認安裝狀態，或在設定中指定完整路徑。`,
        detail,
        res.spawnError
      )
    }
    if (code === ERR_CLI_UNSAFE_ARG) {
      return cliError(
        'invalid_config',
        `${label} 的執行路徑或參數含有 cmd.exe 無法安全傳遞的字元（& ^ | < > " %）。請改用不含這些字元的路徑。`,
        detail,
        res.spawnError
      )
    }
    if (code === 'EINVAL') {
      return cliError(
        'transport',
        `${label} 無法啟動（批次檔呼叫方式被系統拒絕）。`,
        detail,
        res.spawnError
      )
    }
    return cliError('transport', `${label} 啟動失敗。`, detail, res.spawnError)
  }

  if (res.timedOut) {
    return cliError(
      'timeout',
      `${label} 超過 ${Math.round(res.durationMs / 1000)} 秒沒有回應，已強制結束。`,
      detail
    )
  }

  if (res.aborted) {
    return cliError('transport', `${label} 的呼叫已被取消。`, detail)
  }

  return null
}
