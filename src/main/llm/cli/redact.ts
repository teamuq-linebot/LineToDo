import type { CliName, CliRunResult } from './types'

/**
 * cli/redact.ts — CLI 輸出的「安全診斷」層（隱私關鍵，Batch 2）。
 *
 * ## 為什麼需要這一層
 *
 * design.md §2.3 原本寫「錯誤時 detail 帶 stderr 前 2 KB」。spike-results.md §13-3 實測發現
 * **Codex 會把完整 user prompt（＝真實 LINE 對話內容）原樣回顯到 stderr**。
 * 照原設計做，等於把使用者的聊天記錄寫進 app 的 log 檔。
 *
 * ## 本層的取捨
 *
 * - `CliRunResult.stderr` 仍保留完整原文——provider 需要它做分類（例如 `codex login status`
 *   的訊息只出現在 stderr，spike §2）。原文只活在記憶體裡。
 * - **凡是要進 log / 錯誤訊息 / UI 的字串，一律經過本檔**，預設只輸出**結構化摘要**：
 *   位元組數、行數、命中的訊號關鍵字 key。**不含任何原文**。
 * - 需要逐字診斷時，必須明確打開開關（`setCliDiagnostics(true)` 或環境變數
 *   `LINE_TODO_CLI_DIAGNOSTICS=1`）。開啟後只取**末尾數行**——錯誤訊息都在尾端，
 *   而被回顯的 prompt 在頭端（spike §13-3），取尾比取頭安全得多。
 */

let diagnosticsEnabled = process.env.LINE_TODO_CLI_DIAGNOSTICS === '1'

/** 由設定層（Batch 5）或除錯工具切換。預設關閉。 */
export function setCliDiagnostics(enabled: boolean): void {
  diagnosticsEnabled = enabled
}

export function isCliDiagnosticsEnabled(): boolean {
  return diagnosticsEnabled
}

/**
 * 訊號字典：Batch 3 / 4 各自提供自己的關鍵字（未登入 / 限流 / 金鑰無效…）。
 * 比對結果只回傳 `key`，原文不外流。
 */
export interface SignalPattern {
  key: string
  test: RegExp
}

export function matchSignals(text: string, patterns: readonly SignalPattern[]): string[] {
  const hits: string[] = []
  for (const p of patterns) {
    // /g 的 RegExp 帶 lastIndex 狀態，重複使用同一個字典時會誤判，先歸零。
    p.test.lastIndex = 0
    if (p.test.test(text)) hits.push(p.key)
  }
  return hits
}

export interface OutputDigest {
  bytes: number
  lines: number
  /** 命中的 SignalPattern.key，不含原文。 */
  signals: string[]
  /** 只有診斷模式開啟時才有值：末尾數行。 */
  tail?: string
}

export interface DigestOptions {
  patterns?: readonly SignalPattern[]
  /** 診斷模式下保留的末尾行數。預設 12。 */
  tailLines?: number
  /** 診斷模式下 tail 的字元上限。預設 2000。 */
  tailMaxChars?: number
}

const DEFAULT_TAIL_LINES = 12
const DEFAULT_TAIL_MAX_CHARS = 2000

export function digestOutput(text: string, opts: DigestOptions = {}): OutputDigest {
  const lines = text.length === 0 ? [] : text.split(/\r?\n/)
  const digest: OutputDigest = {
    bytes: Buffer.byteLength(text, 'utf8'),
    lines: lines.length,
    signals: matchSignals(text, opts.patterns ?? [])
  }
  if (diagnosticsEnabled && lines.length > 0) {
    const tailLines = opts.tailLines ?? DEFAULT_TAIL_LINES
    const maxChars = opts.tailMaxChars ?? DEFAULT_TAIL_MAX_CHARS
    const tail = lines
      .slice(-tailLines)
      .join('\n')
      .trim()
    digest.tail = tail.length > maxChars ? tail.slice(-maxChars) : tail
  }
  return digest
}

/** 把 digest 轉成單行、可直接進 log 的字串。 */
export function formatDigest(label: string, digest: OutputDigest): string {
  const parts = [`${digest.lines} 行/${digest.bytes} B`]
  if (digest.signals.length > 0) parts.push(`訊號=${digest.signals.join(',')}`)
  const head = `${label}(${parts.join('; ')})`
  return digest.tail ? `${head} tail<<<${digest.tail}>>>` : head
}

/**
 * 產生「可安全寫進 log 的失敗描述」。這是本層唯一該被用來組 `LlmProviderError.detail` 的函式。
 * 預設不含任何 stdout / stderr 原文。
 */
export function describeRunFailure(
  name: CliName,
  res: CliRunResult,
  stderrSignals: readonly SignalPattern[] = []
): string {
  const parts = [
    `cli=${name}`,
    `exit=${res.code === null ? 'null' : res.code}`,
    `signal=${res.signal ?? 'null'}`,
    `timedOut=${res.timedOut}`,
    `killedByUs=${res.killedByUs}`,
    `closeTimedOut=${res.closeTimedOut}`,
    `durationMs=${res.durationMs}`
  ]
  if (res.spawnError) parts.push(`spawnError=${res.spawnError.code ?? res.spawnError.name}`)
  if (res.truncated.stdout || res.truncated.stderr) {
    parts.push(`truncated=${res.truncated.stdout ? 'stdout' : ''}${res.truncated.stderr ? 'stderr' : ''}`)
  }
  parts.push(formatDigest('stdout', digestOutput(res.stdout)))
  parts.push(formatDigest('stderr', digestOutput(res.stderr, { patterns: stderrSignals })))
  return parts.join(' ')
}
