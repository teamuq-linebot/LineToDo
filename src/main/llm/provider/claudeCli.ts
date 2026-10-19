import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  classifyRunFailure,
  cliError,
  describeRunFailure,
  digestOutput,
  extractSemver,
  findCmdUnsafeIndexes,
  formatDigest,
  locateCli,
  locateCliOrThrow,
  locateFailureToError,
  matchSignals,
  meetsMinimumVersion,
  runLocatedCli,
  sanitizeEnv
} from '../cli'
import type { CliLocation, CliRunResult, SignalPattern } from '../cli'
import { LlmProviderError } from './types'
import type {
  LlmProvider,
  LlmProviderId,
  LlmProviderKind,
  LlmRequest,
  LlmResponse,
  ProviderHealth
} from './types'

/**
 * claudeCli.ts — 以本機 Claude Code CLI（訂閱額度）作為 LlmProvider（design.md §2.2，Batch 3）。
 *
 * 本檔只做 claude 專屬的三件事：**組 argv**、**寫 stdin payload**、**解析 stdout 信封**。
 * spawn / 定位 / 逾時 kill / env 清洗 / 隱私摘要全部委給 `../cli`（Batch 2），不重寫。
 *
 * ## 與 design.md 不同之處（一律以 spike-results.md 實測為準）
 *
 * | 項目 | design.md | 實測結論 |
 * |---|---|---|
 * | `--max-turns` | `1` | **`2`**。結構化輸出靠一次額外 tool call 交付，成功路徑 `num_turns` 恆為 2；`1` 會有 33% 機率回 `error_max_turns`（spike §5）。完全不給則會跑到逾時，所以不能拿掉。 |
 * | 禁用工具 | 只靠 `--max-turns 1` | 改用 **`--tools ''`**（`--help` 正式文件：`Use "" to disable all tools`）。預設會載入 31 個工具含 Bash/Write/WebFetch（spike §13-4）。 |
 * | `--setting-sources` | 「空字串或 none」 | **空字串**。`none` 非法會 exit 1（spike §7）。 |
 * | `--model` | 選填 | **必填**。不給就繼承使用者 settings 的 `"model": "opus[1m]"`，實測單次 extract 燒到 $0.149（spike §13-2）。 |
 * | stdout 形狀 | 單一 JSON 物件 | 使用者 settings 的 `"verbose": true` 會讓它變成**事件陣列**。`--setting-sources ''` 擋得掉，但**解析端仍一律防禦式處理**——旗標會漂移，防禦式解析不會（spike §13-1）。 |
 * | 成功判定 | — | 未登入時 `subtype` 仍是 `"success"`，**只有 `is_error` 可信**（spike §8）。 |
 * | 未登入訊息 | 關鍵字含 `login` | 還要加 `invalid api key`：注入 `ANTHROPIC_API_KEY` 時訊息是 `Invalid API key · Fix external API key`，不含任何 login 字樣（spike §6）。 |
 *
 * ## `.cmd` 與 `--json-schema` 的衝突（本批次實測）
 *
 * 這台機器 PATH 上的 claude **只有 `.cmd`**（spike §1）；`locateCli` 會由它反推
 * `<npm bin>\node_modules\@anthropic-ai\claude-code\bin\claude.exe`（實測存在且可用）。
 * 反推失敗時只剩 `.cmd`，而 `.cmd` 必須走 `cmd.exe /c`，Batch 2 的前置檢查會擋下含
 * `& ^ | < > " %` 的參數——`--json-schema` 的 inline JSON **必然含雙引號**。
 *
 * 實測補充：`--json-schema` **只吃 inline JSON**，檔案路徑與 `@檔案` 都會被當成 JSON 直接 parse 失敗
 * （`Error: --json-schema is not valid JSON`，約 570 ms 就 exit 1）。所以「寫暫存檔」這條退路不存在。
 *
 * → 因此本 provider 在送出前用 Batch 2 自己的 `findCmdUnsafeIndexes()` 做**同一套判定**，
 * 命中就丟一個**講得出解法**的 `invalid_config`，而不是讓通用錯誤訊息（「請改用不含這些字元的路徑」）
 * 誤導使用者去改路徑。**刻意不做「改用 prompt 要求 JSON」的靜默降級**：那會讓 schema 沒生效
 * 這件事被吞掉，而 CLI provider 本來就缺 guided decoding，再拿掉 schema 只剩祈禱。
 */

export const CLAUDE_PROVIDER_ID: LlmProviderId = 'claudeCli'

/** 低於此版在 Windows 有 stdin 截斷 bug，而我們**所有** prompt 都走 stdin（design.md §3.3）。 */
export const MIN_CLAUDE_VERSION = '2.1.211'

/** design.md §5.1：CLI 預設逾時 120s（含冷啟動）。spike 實測 p90 ≈ 21s，長尾留餘裕。 */
export const DEFAULT_CLAUDE_TIMEOUT_MS = 120_000

/** spike §5：`1` 必敗、不給會逾時。 */
export const DEFAULT_CLAUDE_MAX_TURNS = 2

/** spike §3：sonnet + effort low + max-turns 2 是唯一 5/5 成功且 p90 最低的組態。 */
export const DEFAULT_CLAUDE_MODEL = 'sonnet'
export const DEFAULT_CLAUDE_EFFORT = 'low'

/** design.md §2.2：Claude 上限 10MB，留安全邊際。 */
const MAX_STDIN_BYTES = 8 * 1024 * 1024

const VERSION_TIMEOUT_MS = 10_000
const AUTH_TIMEOUT_MS = 20_000

/**
 * env 清洗的**追加**清單。Batch 2 的 `CLI_ENV_DENYLIST` 已含 `ANTHROPIC_API_KEY` /
 * `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_USE_*`；這裡補上 design.md §2.2 列出、
 * 但屬 claude 專屬的其餘幾個（改後端 / 改模型 / Bedrock 憑證）。
 */
const CLAUDE_EXTRA_ENV_DENY: readonly string[] = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'AWS_BEARER_TOKEN_BEDROCK'
]

/**
 * stderr 訊號字典。**只回傳 key，原文不外流**（redact.ts 的隱私守則）。
 * 這些訊號都出現在「stdout 連信封都沒有」的情況，用來把「旗標打錯 / schema 打錯」
 * 從通用的 `transport` 裡撈出來——那是設定問題，重試一百次也不會好。
 */
export const CLAUDE_STDERR_SIGNALS: readonly SignalPattern[] = [
  { key: 'unknown_option', test: /unknown option/i },
  // 實測兩種措辭：`--json-schema is not valid JSON: …` 與 `--json-schema must be a JSON object`。
  // 比對整個旗標名而非特定句子，措辭改版時不會靜默失效。
  { key: 'bad_json_schema_arg', test: /--json-schema/i },
  { key: 'bad_setting_sources', test: /invalid setting source/i },
  { key: 'flag_error', test: /error processing --|invalid (option|argument|value) for/i },
  { key: 'missing_stdin', test: /input must be provided either through stdin/i },
  { key: 'env_api_key_override', test: /connectors are disabled because anthropic_api_key/i }
]

/** 上列訊號中，屬於「使用者/我們的設定壞了」而非「這次剛好失敗」的。 */
const CONFIG_SIGNAL_KEYS: ReadonlySet<string> = new Set([
  'unknown_option',
  'bad_json_schema_arg',
  'bad_setting_sources',
  'flag_error',
  'missing_stdin'
])

/**
 * `is_error: true` 時，由 `result` / `errors` 文字判定錯誤碼。**順序即優先級**。
 * 先判「明確指名 API key / login」的，再判用量，最後才是短期限流——
 * 因為 `api key` 這個詞太泛，放後面會把 `Invalid API key` 誤收進其他桶。
 */
const ENVELOPE_ERROR_RULES: readonly {
  code: 'not_authenticated' | 'quota_exceeded' | 'rate_limited'
  test: RegExp
}[] = [
  { code: 'not_authenticated', test: /not logged in|please run \/login|invalid api key|api key|unauthorized|\b401\b|authenticat|credential|oauth/i },
  { code: 'quota_exceeded', test: /usage limit|quota|credit balance|insufficient credit|plan limit/i },
  { code: 'rate_limited', test: /rate limit|too many requests|\b429\b|overloaded|\b529\b/i }
]

const USER_MESSAGE: Record<string, string> = {
  not_authenticated: 'Claude CLI 尚未登入（或環境中的 API 金鑰無效）。請在終端機執行 claude 並完成登入後再試。',
  quota_exceeded: 'Claude 訂閱用量已達上限，請稍後再試或改用 API 端點。',
  rate_limited: 'Claude 服務暫時限流，稍後會自動再試。'
}

export interface ClaudeCliProviderOptions {
  /**
   * **必填**（spike §13-2）。省略會繼承使用者 `~/.claude/settings.json` 的 model，
   * 成本與延遲完全失控。預設 `'sonnet'`。
   */
  model?: string
  /** `--effort`。`null` / `''` = 不帶這個旗標。預設 `'low'`。 */
  effort?: string | null
  /** 設定頁手動指定的執行檔路徑；空字串 = 自動偵測。 */
  execPath?: string
  /** 單次呼叫 wall-clock 上限；`req.timeoutMs` 優先。預設 120000。 */
  timeoutMs?: number
  /**
   * 空的工作目錄（切斷 project-level 記憶與設定的向上探索，design.md §2.2）。
   * Batch 5 應傳 `join(app.getPath('userData'), 'ai-cli-workdir')`；
   * 這裡刻意不 import electron，provider 才能在 electron 之外被獨立測試。
   */
  workdir?: string
  /** 覆寫 `--max-turns`。**不要設 1**（spike §5）。預設 2。 */
  maxTurns?: number
}

/** stdout 信封中我們會用到的欄位；其餘（usage / session_id / ttft…）刻意不宣告。 */
interface ClaudeEnvelope {
  type?: string
  is_error?: boolean
  subtype?: string
  terminal_reason?: string
  result?: unknown
  structured_output?: unknown
  total_cost_usd?: number
  errors?: unknown
  num_turns?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 解析 `--output-format json` 的 stdout。**防禦式**：
 * 使用者 settings 的 `"verbose": true` 會讓輸出從單一物件變成 stream 事件**陣列**（spike §13-1）。
 * 我們雖然帶了 `--setting-sources ''`，但旗標會隨版本漂移，解析端不能只靠旗標。
 *
 * 回 `null` = 完全找不到可用的信封（呼叫端據此走 transport / invalid_config）。
 */
export function parseClaudeEnvelope(stdout: string): ClaudeEnvelope | null {
  const text = stdout.trim()
  if (text.length === 0) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }

  if (Array.isArray(parsed)) {
    // stream 事件陣列：只有 type === 'result' 那一筆帶 is_error / structured_output。
    for (let i = parsed.length - 1; i >= 0; i -= 1) {
      const item: unknown = parsed[i]
      if (isRecord(item) && item.type === 'result') return item as ClaudeEnvelope
    }
    return null
  }

  return isRecord(parsed) ? (parsed as ClaudeEnvelope) : null
}

/** 把信封裡可能散在 `result` / `errors` 的文字併成一段，供關鍵字比對。 */
function envelopeErrorText(env: ClaudeEnvelope): string {
  const parts: string[] = []
  if (typeof env.result === 'string') parts.push(env.result)
  if (Array.isArray(env.errors)) parts.push(env.errors.map((e) => String(e)).join(' '))
  if (typeof env.subtype === 'string') parts.push(env.subtype)
  if (typeof env.terminal_reason === 'string') parts.push(env.terminal_reason)
  return parts.join(' \n ')
}

/** 組 argv。抽成獨立函式是為了讓「實際送出什麼」可被測試與 log，不必真的 spawn。 */
export function buildClaudeArgs(
  req: Pick<LlmRequest, 'jsonSchema'>,
  cfg: { model: string; effort: string | null; maxTurns: number }
): string[] {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--permission-mode',
    'dontAsk',
    '--max-turns',
    String(cfg.maxTurns),
    // spike §13-4：有 --help 正式文件背書的「禁用全部工具」，比隱藏旗標 --max-turns 可靠。
    '--tools',
    '',
    '--disable-slash-commands',
    // 刻意「不」給 --mcp-config → 等於零 MCP server。
    '--strict-mcp-config',
    '--no-session-persistence',
    // spike §7：空字串合法且確實擋掉 ~/.claude 的 CLAUDE.md 與 settings.json；'none' 非法。
    '--setting-sources',
    '',
    '--model',
    cfg.model
  ]
  if (cfg.effort) args.push('--effort', cfg.effort)
  // §2.2：傳的是 schema 內層，不是 { name, schema } 外殼。
  if (req.jsonSchema) args.push('--json-schema', JSON.stringify(req.jsonSchema.schema))
  return args
}

/**
 * system 與 user 併成單一 stdin payload（design.md §2.2）。
 * 刻意不用 `--append-system-prompt`：那是「附加在 Claude Code 自身 agent prompt 之後」，
 * 與「這就是全部的指令」語意不同，也會讓兩個 CLI provider 行為不對稱。
 */
export function buildClaudePayload(req: Pick<LlmRequest, 'system' | 'user'>): string {
  return `${req.system}\n\n===== 以下是要處理的資料（JSON）=====\n\n${req.user}`
}

class ClaudeCliProvider implements LlmProvider {
  readonly id: LlmProviderId = CLAUDE_PROVIDER_ID
  readonly kind: LlmProviderKind = 'cli'

  private readonly model: string
  private readonly effort: string | null
  private readonly execPath: string
  private readonly timeoutMs: number
  private readonly workdir: string
  private readonly maxTurns: number

  constructor(opts: ClaudeCliProviderOptions = {}) {
    this.model = opts.model && opts.model.trim().length > 0 ? opts.model.trim() : DEFAULT_CLAUDE_MODEL
    this.effort = opts.effort === undefined ? DEFAULT_CLAUDE_EFFORT : opts.effort || null
    this.execPath = opts.execPath ?? ''
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_CLAUDE_TIMEOUT_MS
    this.workdir = opts.workdir ?? join(tmpdir(), 'line-todo-ai-cli-workdir')
    this.maxTurns = opts.maxTurns ?? DEFAULT_CLAUDE_MAX_TURNS
  }

  private env(): NodeJS.ProcessEnv {
    return sanitizeEnv({ extraDeny: CLAUDE_EXTRA_ENV_DENY })
  }

  /** 空目錄即可；不存在就建。失敗不致命（cwd 只是隔離手段），退回 process.cwd 反而更危險，所以照拋。 */
  private ensureWorkdir(): string {
    mkdirSync(this.workdir, { recursive: true })
    return this.workdir
  }

  /**
   * 送出前確認「這組 argv 真的能經由這個執行檔傳過去」。
   * 原生 `.exe` 一律沒問題；`.cmd` 要走 `cmd.exe /c`，Batch 2 會擋含 `& ^ | < > " %` 的參數，
   * 而 `--json-schema` 的 inline JSON 必然含雙引號。
   */
  private assertArgvDeliverable(location: CliLocation, args: string[]): void {
    if (!location.isBatch) return
    const bad = findCmdUnsafeIndexes([location.path, ...args])
    if (bad.length === 0) return
    throw cliError(
      'invalid_config',
      `找到的 Claude CLI 是批次檔（${location.path}），無法傳遞結構化輸出所需的 JSON Schema 參數。` +
        '請在設定中指定原生執行檔的完整路徑（通常是 <npm 全域 bin>\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe）。',
      `claude batch-path unsafe argv indexes=${bad.join(',')} path=${location.path}`
    )
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const startedAt = Date.now()

    const stdin = buildClaudePayload(req)
    const bytes = Buffer.byteLength(stdin, 'utf8')
    if (bytes > MAX_STDIN_BYTES) {
      throw cliError(
        'invalid_config',
        `送給 Claude CLI 的內容過大（${Math.round(bytes / 1024 / 1024)} MB），請調低單次處理的訊息則數。`,
        `claude stdin ${bytes} B > ${MAX_STDIN_BYTES} B`
      )
    }

    const args = buildClaudeArgs(req, {
      model: this.model,
      effort: this.effort,
      maxTurns: this.maxTurns
    })

    // 先定位（結果有快取，等下 runLocatedCli 會直接命中），才能在花錢之前做 .cmd 前置判定。
    const located = await locateCliOrThrow('claude', this.execPath)
    this.assertArgvDeliverable(located, args)

    const { result } = await runLocatedCli({
      name: 'claude',
      execPathOverride: this.execPath,
      args,
      stdin,
      cwd: this.ensureWorkdir(),
      env: this.env(),
      timeoutMs: req.timeoutMs ?? this.timeoutMs,
      signal: req.signal
    })

    // provider 無關的失敗（spawn / 逾時 / 取消）先由 Batch 2 統一分類。
    const failure = classifyRunFailure('claude', result, CLAUDE_STDERR_SIGNALS)
    if (failure) throw failure

    return this.interpret(req, result, startedAt)
  }

  /**
   * 輸出判定。**順序不可顛倒**，而且**先信 stdout 信封再看 exit code**——
   * `exit 0 + is_error: true` 與 `exit 1 + 完整合法信封` 兩種組合都實際存在（spike §5 / §8）。
   */
  private interpret(req: LlmRequest, res: CliRunResult, startedAt: number): LlmResponse {
    const envelope = parseClaudeEnvelope(res.stdout)

    if (!envelope) {
      const detail = describeRunFailure('claude', res, CLAUDE_STDERR_SIGNALS)
      const hits = matchSignals(res.stderr, CLAUDE_STDERR_SIGNALS)
      if (hits.some((k) => CONFIG_SIGNAL_KEYS.has(k))) {
        throw cliError(
          'invalid_config',
          'Claude CLI 不接受本程式送出的參數（可能是 CLI 版本變更）。請更新 Claude Code，或在設定中改用其他 AI 引擎。',
          detail
        )
      }
      throw cliError('transport', 'Claude CLI 沒有回傳可解析的結果。', detail)
    }

    if (envelope.is_error === true) throw this.envelopeError(envelope, res)

    const costUsd = typeof envelope.total_cost_usd === 'number' ? envelope.total_cost_usd : null
    const meta: LlmResponse['meta'] = {
      provider: this.id,
      model: this.model,
      durationMs: Date.now() - startedAt,
      costUsd
    }

    if (req.jsonSchema) {
      // §2.2 步驟 5：缺席即 bad_output，**不退回去 parse `result` 文字**——
      // 那會讓「schema 根本沒生效」被靜默吞掉，而這正是 CLI provider 最需要被看見的失敗。
      const structured = envelope.structured_output
      if (structured === undefined || structured === null) {
        throw cliError(
          'bad_output',
          'Claude CLI 沒有回傳結構化結果。',
          `claude missing structured_output ${this.envelopeDetail(envelope, res)}`
        )
      }
      return { text: JSON.stringify(structured), structured, meta }
    }

    const text = typeof envelope.result === 'string' ? envelope.result : ''
    if (text.length === 0) {
      throw cliError(
        'bad_output',
        'Claude CLI 回傳了空的結果。',
        `claude empty result ${this.envelopeDetail(envelope, res)}`
      )
    }
    return { text, structured: undefined, meta }
  }

  /** 只放結構化欄位與摘要，**不含 result / stderr 原文**（可能含 LINE 對話）。 */
  private envelopeDetail(env: ClaudeEnvelope, res: CliRunResult): string {
    const parts = [
      `exit=${res.code === null ? 'null' : res.code}`,
      `durationMs=${res.durationMs}`,
      `subtype=${env.subtype ?? 'none'}`,
      `terminal=${env.terminal_reason ?? 'none'}`,
      `numTurns=${env.num_turns ?? 'none'}`,
      formatDigest('result', digestOutput(typeof env.result === 'string' ? env.result : ''))
    ]
    return parts.join(' ')
  }

  private envelopeError(env: ClaudeEnvelope, res: CliRunResult): LlmProviderError {
    const detail = `claude is_error=true ${this.envelopeDetail(env, res)}`

    // turn 用完：spike §5 的 error_max_turns。與「模型亂輸出」是兩回事，分開講才查得下去。
    if (env.subtype === 'error_max_turns' || env.terminal_reason === 'max_turns') {
      return cliError(
        'bad_output',
        'Claude CLI 在允許的步數內沒有交出結果。',
        `${detail} (maxTurns=${this.maxTurns})`
      )
    }

    const text = envelopeErrorText(env)
    for (const rule of ENVELOPE_ERROR_RULES) {
      rule.test.lastIndex = 0
      if (rule.test.test(text)) return cliError(rule.code, USER_MESSAGE[rule.code], detail)
    }
    return cliError('unknown', 'Claude CLI 執行失敗。', detail)
  }

  /**
   * 健檢：定位 → `--version` → `auth status`。**不跑真 prompt**（design.md §3.3）：
   * 一次真呼叫要數十秒又會燒訂閱額度，而使用者按下按鈕時期待的是即時回饋。
   * 登入狀態**絕不快取**——它隨時會變，快取只會給出騙人的綠燈。
   */
  async health(): Promise<ProviderHealth> {
    const outcome = await locateCli('claude', this.execPath)
    if (!outcome.ok) {
      const err = locateFailureToError('claude', outcome)
      return {
        ok: false,
        summary: err?.userMessage ?? '找不到 Claude CLI。',
        code: err?.code ?? 'not_installed',
        details: { installed: false, path: null }
      }
    }
    const location = outcome.location
    const details: ProviderHealth['details'] = { installed: true, path: location.path }

    const versionRes = await this.runAux(['--version'], VERSION_TIMEOUT_MS)
    if (versionRes instanceof LlmProviderError) {
      return { ok: false, summary: versionRes.userMessage, code: versionRes.code, details }
    }
    const version = extractSemver(versionRes.stdout) ?? extractSemver(versionRes.stderr)
    details.version = version
    details.versionOk = meetsMinimumVersion(version, MIN_CLAUDE_VERSION)
    if (!details.versionOk) {
      return {
        ok: false,
        summary: `Claude Code 版本 ${version} 過舊（需 ${MIN_CLAUDE_VERSION} 以上），Windows 上會有輸入截斷問題，請升級。`,
        code: 'invalid_config',
        details
      }
    }

    const authRes = await this.runAux(['auth', 'status'], AUTH_TIMEOUT_MS)
    if (authRes instanceof LlmProviderError) {
      return { ok: false, summary: authRes.userMessage, code: authRes.code, details }
    }
    // spike §2：stdout 是純 JSON；未登入時 exit 1 但 stdout 仍是合法 JSON，所以不看 exit code。
    const auth = this.parseAuthStatus(authRes.stdout)
    if (auth === null) {
      details.authenticated = 'unknown'
      return {
        ok: false,
        summary: '無法判讀 Claude CLI 的登入狀態，請在終端機執行 claude auth status 確認。',
        code: 'unknown',
        details
      }
    }
    details.authenticated = auth.loggedIn
    if (!auth.loggedIn) {
      return {
        ok: false,
        summary: USER_MESSAGE.not_authenticated,
        code: 'not_authenticated',
        details
      }
    }

    const plan = auth.subscriptionType ? `，方案 ${auth.subscriptionType}` : ''
    return {
      ok: true,
      summary: `Claude CLI ${version ?? '(版本不明)'} 已登入${plan}`,
      details
    }
  }

  /** health() 專用的短指令執行；失敗直接轉成 LlmProviderError 回傳（不 throw，讓 health 統一組裝）。 */
  private async runAux(
    args: string[],
    timeoutMs: number
  ): Promise<CliRunResult | LlmProviderError> {
    const { result } = await runLocatedCli({
      name: 'claude',
      execPathOverride: this.execPath,
      args,
      stdin: '',
      cwd: this.ensureWorkdir(),
      env: this.env(),
      timeoutMs
    })
    return classifyRunFailure('claude', result, CLAUDE_STDERR_SIGNALS) ?? result
  }

  private parseAuthStatus(
    stdout: string
  ): { loggedIn: boolean; subscriptionType: string | null } | null {
    const text = stdout.trim()
    if (text.length === 0) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return null
    }
    if (!isRecord(parsed) || typeof parsed.loggedIn !== 'boolean') return null
    return {
      loggedIn: parsed.loggedIn,
      subscriptionType:
        typeof parsed.subscriptionType === 'string' ? parsed.subscriptionType : null
    }
  }
}

/** 建立 Claude CLI provider。Batch 5 的設定層會負責把 settings 對應成這裡的 options。 */
export function makeClaudeCliProvider(opts: ClaudeCliProviderOptions = {}): LlmProvider {
  return new ClaudeCliProvider(opts)
}
