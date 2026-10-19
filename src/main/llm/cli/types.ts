import type { ChildProcess, SpawnOptions } from 'node:child_process'

/**
 * cli/types.ts — 本機 CLI provider 共用基礎層的型別（design.md §2.4 / §3.1，Batch 2）。
 *
 * 本層只做「機械操作」：定位執行檔、spawn、餵 stdin、逾時 kill、清 env。
 * **不含任何 claude / codex 專屬的 argv 組裝或輸出解析**（那是 Batch 3 / 4）。
 *
 * 純型別檔，無 I/O、無副作用。
 */

/** 目前支援的兩個本機 CLI。 */
export type CliName = 'claude' | 'codex'

export interface CliLocation {
  /** 可直接 spawn 的絕對路徑。 */
  path: string
  /**
   * true = `.cmd` / `.bat`，必須走 `cmd.exe /c`（Node 18.20+ 在 shell:false 下 spawn
   * `.cmd` 會**同步 throw** EINVAL，見 spike-results.md §9）。
   */
  isBatch: boolean
  /** 命中來源，僅供診斷 log。 */
  source: 'override' | 'path' | 'fallback'
}

export type LocateFailReason =
  /** 使用者明確指定了 execPath，但檔案不存在 → invalid_config（不可偷偷退回自動偵測）。 */
  | 'override_missing'
  /** PATH 與 fallback 清單都找不到 → not_installed。 */
  | 'not_found'

export type LocateOutcome =
  | { ok: true; location: CliLocation }
  | { ok: false; reason: LocateFailReason; searched: string[] }

/** 供單元測試注入假 spawn；預設為 node:child_process 的 spawn。 */
export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess

export interface CliRunOptions {
  /** 執行檔絕對路徑；`.cmd` / `.bat` 由 runCli 自行改走 cmd.exe /c。 */
  exePath: string
  /** 只放短指令與旗標。長輸入一律走 stdin。 */
  args: string[]
  /** 寫入子程序 stdin 的內容；runCli 保證會 `end()`。 */
  stdin: string
  cwd?: string
  /** 建議用 sanitizeEnv() 產生；省略＝繼承 process.env（不建議）。 */
  env?: NodeJS.ProcessEnv
  /** wall-clock 上限（ms）。兩個 CLI 都沒有整體逾時旗標，只能自己算。<= 0 = 不設限。 */
  timeoutMs: number
  /** stdout / stderr 各自的收集上限，超過即截斷。預設 8 MB。 */
  maxOutputBytes?: number
  /**
   * kill 之後等待 `close` 事件的寬限（ms）。到期仍未收到就自行結束 Promise
   * ——spike-results.md §10 實測 `cmd.exe → node → codex` 三層被殺後 close **永不觸發**。
   * 預設 1500。
   */
  killGraceMs?: number
  signal?: AbortSignal
  /** 單元測試注入點。 */
  spawnImpl?: SpawnImpl
}

export interface CliRunResult {
  /**
   * 子程序 exit code。**不可用它判斷逾時**：spike §10 實測被 kill 時原生 exe 回
   * `code=null, signal='SIGTERM'`、taskkill 掉的 cmd 樹回 `code=1`，都不是文件說的 143。
   */
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  /**
   * ⚠ **隱私**：Codex 會把完整 prompt（含 LINE 對話）原樣回顯到 stderr（spike §13-3）。
   * 這個欄位只能在記憶體中用於分類/解析，**不可直接寫進 log 或錯誤訊息**。
   * 需要診斷字串時一律經 redact.ts 的 digestOutput / describeRunFailure。
   */
  stderr: string
  /** 唯一可信的逾時判準。 */
  timedOut: boolean
  aborted: boolean
  /** 我們主動殺的（逾時或 abort）。 */
  killedByUs: boolean
  /** true = kill 後在寬限時間內沒等到 close，結果由我們自行補齊（見 killGraceMs）。 */
  closeTimedOut: boolean
  durationMs: number
  truncated: { stdout: boolean; stderr: boolean }
  /**
   * 進程沒能正常跑完的原因：ENOENT（找不到檔）、EINVAL（.cmd 直接 spawn）、
   * 或本層的前置檢查 ERR_CLI_UNSAFE_ARG。有值時 code / signal 必為 null。
   */
  spawnError?: NodeJS.ErrnoException
}
