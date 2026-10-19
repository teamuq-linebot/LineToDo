/**
 * llm/cli — 本機 CLI provider（claude / codex）的共用基礎層（Batch 2）。
 *
 * 這一層只有「不含業務語意的機械操作」：定位執行檔、spawn、餵 stdin、逾時 kill、
 * 清 env、把失敗轉成錯誤碼。**沒有任何 claude / codex 專屬的 argv 或輸出解析**，
 * 那些屬於 Batch 3（claudeCli）與 Batch 4（codexCli）。
 *
 * 典型用法（Batch 3 / 4 視角）：
 *
 * ```ts
 * const { location, result } = await runLocatedCli({
 *   name: 'claude',
 *   execPathOverride: cfg.execPath,
 *   args: buildArgs(req),            // ← provider 專屬
 *   stdin: `${req.system}\n\n${req.user}`,
 *   cwd: workdir,
 *   env: sanitizeEnv(),
 *   timeoutMs: cfg.timeoutMs
 * })
 * const failure = classifyRunFailure('claude', result, CLAUDE_SIGNALS)
 * if (failure) throw failure         // not_installed / timeout / transport / invalid_config
 * // 進程正常跑完 → 以下是 provider 專屬的輸出解析與 not_authenticated / bad_output 判定
 * ```
 *
 * 隱私守則（spike-results.md §13-3）：`result.stderr` 可能含**完整 prompt（真實 LINE 對話）**。
 * 要進 log / 錯誤訊息的字串一律經 `describeRunFailure()` / `digestOutput()`，
 * 不要直接把 stdout / stderr 字串傳給 logger 或 `LlmProviderError.detail`。
 */

export * from './types'
export * from './env'
export * from './errors'
export * from './locate'
export * from './redact'
export * from './run'
export * from './version'
