import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse as parsePath } from 'node:path'

import {
  cliError,
  classifyRunFailure,
  describeRunFailure,
  extractSemver,
  findCmdUnsafeIndexes,
  locateCli,
  locateFailureToError,
  matchSignals,
  meetsMinimumVersion,
  runCli,
  runLocatedCli,
  sanitizeEnv
} from '../cli'
import type { SignalPattern } from '../cli'
import type {
  LlmProvider,
  LlmProviderId,
  LlmProviderKind,
  LlmRequest,
  LlmResponse,
  ProviderHealth
} from './types'

/**
 * codexCli.ts — 第三個 LlmProvider 實作：本機 `codex exec`（design.md §2.3，Batch 4）。
 *
 * 本檔的每一個決策都來自 Batch 0 spike 與本批次的實測，**與設計文件衝突處一律以實測為準**。
 * spawn / kill / 逾時 / env 清洗 / 診斷字串全部委給 Batch 2 的 `../cli`，本檔只負責
 * 「codex 專屬的 argv、暫存檔、輸出解析與錯誤分類」。
 *
 * ## 三個推翻設計的實測結論
 *
 * 1. **`--json` 讓 stderr 變成 0 bytes**（本批次實測）。spike §13-3 記錄「codex 把完整 prompt
 *    原樣印到 stderr」是**不加 `--json` 時**的行為；加上 `--json` 後 stderr 全空，
 *    進度與錯誤都改走 stdout 的 JSONL 事件流。這同時解決了隱私問題與
 *    「exit code 語意粗略（只有 0/非 0）」的分類難題 —— 錯誤以
 *    `{"type":"error","message":…}` + `{"type":"turn.failed","error":{…}}` 結構化送出。
 *    代價：stdout 不再等於 out.json，退路要改從 `item.completed` 的 `agent_message` 取。
 *
 * 2. **Codex 走 OpenAI strict 模式，拒絕本專案現有的 `EXTRACT_JSON_SCHEMA`**（spike §4c，本批次覆現）：
 *    `properties` 的每個 key 都必須列進 `required`，缺 `detail` → HTTP 400 `invalid_json_schema`。
 *    → 本檔用 `toStrictJsonSchema()` 在**送出前**轉換，**不改 `schema.ts`**（HTTP provider 還在用）。
 *
 * 3. **out.json 是裸物件、無信封**（spike §4b）；無 schema 時是**純文字**（本批次覆現：
 *    87 bytes 的一句中文，非 JSON）。→ 直接讀檔，不做信封剝離。
 *
 * ## 隱私守則
 *
 * `result.stdout` 含模型輸出（＝從 LINE 對話抽出的內容）、`result.stderr` 在未加 `--json` 的
 * 舊版行為下含完整 prompt。**兩者都不得原文進 log**：所有 `detail` 一律經
 * `describeRunFailure()`（只出位元組數／行數／命中的訊號 key），錯誤分類也只吃
 * 「事件的 error.message + stderr」而不是整份 stdout。
 */

// ── 常數 ──────────────────────────────────────────────────

/** spike §1 實測的版本；低於此只警告不擋（design §3.3）。 */
export const CODEX_TESTED_VERSION = '0.147.0'

/** design §5.1：codex 無 `--max-turns`，逾時是唯一的煞車。 */
export const CODEX_DEFAULT_TIMEOUT_MS = 120_000

/**
 * 未指定模型時使用的預設模型。**`-m` 永遠會被帶上**，不存在「不帶 `-m`」這條路徑。
 *
 * 理由與 claudeCli 的 `--model` 必填完全相同（spike §13-2）：不帶模型旗標＝把「跑哪個模型」
 * 交給使用者本機 CLI 的設定，而那是 app 看不到也控制不了的東西 —— 有人的本機預設是 opus，
 * 實測單次抽取就燒掉 $0.149，而且這件事不會有任何提示。設定檔可被手動編輯（繞過設定頁的
 * 「模型必填」驗證），所以這道防線必須落在**組 argv 的地方**，不能只放在 UI。
 *
 * 選 `gpt-5.6-sol` 的依據：spike-results.md §3 實測 5/5 成功、p90 約 23 秒，
 * 也是設定頁模型下拉唯一的建議選項。
 */
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol'

const TMP_ROOT_DIR = 'ai-cli-tmp'
const TMP_DIR_PREFIX = 'codex-'
const OUT_FILE = 'out.json'
const SCHEMA_FILE = 'schema.json'
const WORK_DIR = 'work'

/** 崩潰殘留清掃的年齡門檻（design §2.3）。 */
const TMP_STALE_MS = 60 * 60 * 1000

const VERSION_TIMEOUT_MS = 5_000
/** `codex login status` 實測 69 ms（已登入）/ 46 ms（未登入），10 秒綽綽有餘。 */
const LOGIN_TIMEOUT_MS = 10_000

/**
 * 額外要從子程序 env 移除的變數。理由同 design §2.2「最關鍵的一行」：
 * 環境變數層的金鑰**無條件優先**於訂閱登入，留著會讓 app 在使用者不知情下改走 API 計費。
 * `CODEX_HOME` 刻意保留（等同 env.ts 保留 `CLAUDE_CONFIG_DIR` 的理由：它只決定讀哪個
 * 設定/憑證目錄，刪掉會把「設定放在非預設位置」的使用者直接變成未登入）。
 */
export const CODEX_ENV_DENYLIST: readonly string[] = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORGANIZATION'
]

/**
 * 錯誤訊號字典。**只比對「事件的 error.message + stderr」**，不比對整份 stdout ——
 * stdout 含模型輸出，拿 `401` / `quota` 這種字去比對整份輸出會誤判（對話裡本來就可能出現這些字）。
 */
export const CODEX_SIGNALS: readonly SignalPattern[] = [
  { key: 'invalid_schema', test: /invalid_json_schema|invalid schema for response_format/i },
  { key: 'not_logged_in', test: /not logged in|codex login|missing bearer|not authenticated/i },
  { key: 'unauthorized', test: /\b401\b|unauthorized|invalid[_ ]?api[_ ]?key|authentication/i },
  { key: 'quota', test: /quota|usage limit|insufficient_quota|billing|out of credit/i },
  { key: 'rate_limited', test: /\b429\b|rate[ _-]?limit|too many requests/i },
  { key: 'server_error', test: /unexpected status 5\d\d|internal server error|service unavailable/i }
]

// ── strict-safe JSON Schema 轉換（實測問題 1）────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把「原本選填」的欄位放寬成可為 null —— strict 模式強迫它進 `required`，
 * 若不同時允許 null，模型就被迫替沒有的欄位編一個值。
 */
function widenNullable(node: unknown): unknown {
  if (!isPlainObject(node)) return node
  const out: Record<string, unknown> = { ...node }
  if (typeof out.type === 'string') {
    if (out.type !== 'null') out.type = [out.type, 'null']
  } else if (Array.isArray(out.type) && !out.type.includes('null')) {
    out.type = [...out.type, 'null']
  }
  if (Array.isArray(out.enum) && !out.enum.includes(null)) {
    out.enum = [...out.enum, null]
  }
  return out
}

/**
 * 產生 codex（OpenAI strict structured output）能接受的 schema 變體。
 *
 * 轉換規則（遞迴套用到每一層 object）：
 *   1. 有 `properties` 的節點 → `required` 改成**列出全部** property key。
 *   2. 有 `properties` 的節點 → 強制 `additionalProperties: false`。
 *   3. 原本**不在** `required` 內的欄位 → 型別放寬成可為 null（規則 1 的必要補償）。
 *
 * 其餘關鍵字（`minLength` / `minimum` / `maximum` / `minItems` / `enum` / `description`）
 * 原樣保留 —— 本批次實測 codex 接受它們（帶著這些關鍵字 exit 0、輸出通過驗證）。
 *
 * 對本專案 `EXTRACT_JSON_SCHEMA` 的實際效果：`newTodos.items.required` 補上
 * `detail` / `dueAt`（兩者型別本來就已是 `["string","null"]`，所以規則 3 是 no-op），
 * 產物仍能通過 `validateExtractResult()`（`detail` / `dueAt` 是 `.nullable().optional()`）。
 *
 * **刻意不改 `schema.ts`**：`EXTRACT_JSON_SCHEMA` 是 HTTP provider 的既有契約，
 * 改它等於改 vLLM 那條路的行為，要重跑 eval 基準才敢動（spike §4c）。
 */
export function toStrictJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toStrictJsonSchema)
  if (!isPlainObject(node)) return node

  const originallyRequired = new Set(
    Array.isArray(node.required) ? node.required.filter((k): k is string => typeof k === 'string') : []
  )
  const out: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' && isPlainObject(value)) {
      const props: Record<string, unknown> = {}
      for (const [propKey, propValue] of Object.entries(value)) {
        const child = toStrictJsonSchema(propValue)
        props[propKey] = originallyRequired.has(propKey) ? child : widenNullable(child)
      }
      out.properties = props
    } else {
      out[key] = toStrictJsonSchema(value)
    }
  }

  if (isPlainObject(out.properties)) {
    out.required = Object.keys(out.properties)
    out.additionalProperties = false
  }
  return out
}

// ── 暫存檔生命週期 ─────────────────────────────────────────

/**
 * `app.getPath('userData')`，取不到就回 null。
 *
 * 刻意用**動態 import + `process.versions.electron` 前置判斷**，不用頂層 `import { app }`：
 * 這個檔案必須能在純 Node（單元測試、拋棄式驗證腳本）下被 import，
 * 頂層靜態相依 electron 會讓整個模組在測試環境直接載入失敗。
 */
async function electronUserDataDir(): Promise<string | null> {
  if (!process.versions.electron) return null
  try {
    const { app } = await import('electron')
    return app.getPath('userData')
  } catch {
    return null
  }
}

/**
 * 解析暫存根目錄。優先序：明確指定 > `<userData>/ai-cli-tmp` > `<os.tmpdir()>/line-todo/ai-cli-tmp`。
 *
 * 放 userData 不放 `os.tmpdir()` 的理由（design §2.3）：開機清掃只會刪到自己的東西、
 * 隨 app 解除安裝一起消失、路徑可預期。
 *
 * 最後一道防線是 `cmd.exe` 的字元陷阱（spike §9 G/H/I）：userData 含使用者名稱，
 * 而 Windows 允許使用者名稱含 `&`。若路徑命中危險字元，就退到磁碟根目錄下的短路徑 ——
 * 退到 `os.tmpdir()` 沒有意義，那條路徑同樣含使用者名稱。
 */
export async function resolveCodexTmpRoot(explicit?: string): Promise<string> {
  if (explicit && explicit.length > 0) return explicit
  const userData = await electronUserDataDir()
  const preferred = userData
    ? join(userData, TMP_ROOT_DIR)
    : join(tmpdir(), 'line-todo', TMP_ROOT_DIR)
  if (findCmdUnsafeIndexes([preferred]).length === 0) return preferred
  return join(parsePath(tmpdir()).root, 'line-todo-ai-cli')
}

export interface SweepCodexTmpOptions {
  /** 省略＝用 resolveCodexTmpRoot()。 */
  tmpRoot?: string
  /** 超過這個年齡的殘留目錄才刪。預設 1 小時。 */
  maxAgeMs?: number
  /** 測試注入用的「現在」。 */
  now?: number
}

/**
 * 崩潰殘留清掃（design §2.3）：刪掉 `ai-cli-tmp/` 下 mtime 超過門檻的 `codex-*` 目錄。
 * 供開機時呼叫（Batch 5 接上）。回傳實際刪除的目錄數。
 *
 * 正常路徑的清除靠 `complete()` 的 `finally`；這支只處理「app 被強制結束來不及清」的殘留，
 * 所以**年齡門檻不可太短** —— 否則會刪掉另一個正在跑的呼叫的暫存目錄。
 */
export async function sweepCodexTmpDirs(opts: SweepCodexTmpOptions = {}): Promise<number> {
  const root = await resolveCodexTmpRoot(opts.tmpRoot)
  const maxAgeMs = opts.maxAgeMs ?? TMP_STALE_MS
  const now = opts.now ?? Date.now()

  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return 0 // 根目錄還不存在＝沒有殘留可清
  }

  const stale = entries.filter((name) => name.startsWith(TMP_DIR_PREFIX))
  const results = await Promise.all(
    stale.map(async (name) => {
      const dir = join(root, name)
      try {
        const info = await stat(dir)
        if (!info.isDirectory() || now - info.mtimeMs < maxAgeMs) return 0
        await rm(dir, { recursive: true, force: true })
        return 1
      } catch {
        return 0 // 被別的呼叫清掉了 / 正被佔用；下一輪再說
      }
    })
  )
  return results.reduce<number>((sum, n) => sum + n, 0)
}

// ── stdout JSONL 事件解析（--json）────────────────────────

interface CodexEvent {
  type: string
  message?: unknown
  error?: unknown
  item?: { type?: unknown; text?: unknown }
}

/** 容錯解析：非 JSON 的行直接略過（CLI 偶爾夾雜非事件輸出）。 */
function parseJsonlEvents(stdout: string): CodexEvent[] {
  const events: CodexEvent[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || !trimmed.startsWith('{')) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (isPlainObject(parsed) && typeof parsed.type === 'string') {
        events.push(parsed as unknown as CodexEvent)
      }
    } catch {
      /* 不是事件行，略過 */
    }
  }
  return events
}

/**
 * 取第一個失敗事件的訊息。實測形狀：
 *   `{"type":"error","message":"<JSON 字串>"}`
 *   `{"type":"turn.failed","error":{"message":"<JSON 字串>"}}`
 */
function firstEventError(events: readonly CodexEvent[]): string | null {
  for (const ev of events) {
    if (ev.type === 'error' && typeof ev.message === 'string') return ev.message
    if (ev.type === 'turn.failed' && isPlainObject(ev.error) && typeof ev.error.message === 'string') {
      return ev.error.message
    }
  }
  return null
}

/** out.json 缺席時的退路：最後一則 agent_message 的文字。 */
function lastAgentMessage(events: readonly CodexEvent[]): string | null {
  let text: string | null = null
  for (const ev of events) {
    if (ev.type !== 'item.completed') continue
    const item = ev.item
    if (item && item.type === 'agent_message' && typeof item.text === 'string') text = item.text
  }
  return text
}

// ── 錯誤分類 ───────────────────────────────────────────────

function codexFailure(
  result: Parameters<typeof describeRunFailure>[1],
  eventError: string | null
): ReturnType<typeof cliError> {
  // 只餵「事件錯誤訊息 + stderr」，不餵整份 stdout（見 CODEX_SIGNALS 的說明）。
  const signalText = `${eventError ?? ''}\n${result.stderr}`
  const hits = matchSignals(signalText, CODEX_SIGNALS)
  const detail = `${describeRunFailure('codex', result, CODEX_SIGNALS)} eventSignals=${
    hits.length > 0 ? hits.join(',') : 'none'
  }`
  const has = (key: string): boolean => hits.includes(key)

  if (has('invalid_schema')) {
    return cliError(
      'invalid_config',
      'Codex 不接受本次的輸出結構定義（JSON Schema 不合法），請回報此問題。',
      detail
    )
  }
  if (has('not_logged_in') || has('unauthorized')) {
    return cliError(
      'not_authenticated',
      'Codex CLI 尚未登入。請在終端機執行 `codex login` 完成登入後再試。',
      detail
    )
  }
  if (has('quota')) {
    return cliError('quota_exceeded', 'Codex 的訂閱用量已達上限，請稍後再試或改用 API 端點。', detail)
  }
  if (has('rate_limited')) {
    return cliError('rate_limited', 'Codex 服務暫時限流，請稍後再試。', detail)
  }
  return cliError(
    'transport',
    `Codex CLI 執行失敗（結束代碼 ${result.code === null ? '未知' : result.code}）。`,
    detail
  )
}

// ── Provider ──────────────────────────────────────────────

export interface CodexCliProviderOptions {
  /** 使用者手動指定的執行檔絕對路徑；空字串＝自動偵測。 */
  execPath?: string
  /** 省略／空字串＝`DEFAULT_CODEX_MODEL`。**不會**變成「不帶 `-m`」（見該常數的說明）。 */
  model?: string
  /** 單次呼叫 wall-clock 上限；`req.timeoutMs` 優先。預設 120s。 */
  timeoutMs?: number
  /**
   * 暫存根目錄。省略＝`<userData>/ai-cli-tmp`（純 Node 環境自動降級到 os.tmpdir()）。
   * 單元測試用它把整個暫存生命週期關進一個可檢查的目錄。
   */
  tmpRoot?: string
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

class CodexCliProvider implements LlmProvider {
  readonly id: LlmProviderId = 'codexCli'
  readonly kind: LlmProviderKind = 'cli'

  private readonly execPath: string
  private readonly model: string
  private readonly timeoutMs: number
  private readonly tmpRoot?: string

  constructor(opts: CodexCliProviderOptions = {}) {
    this.execPath = opts.execPath ?? ''
    // 空字串／只有空白 → 退回安全預設，而不是「不帶 -m」（見 DEFAULT_CODEX_MODEL）。
    this.model = opts.model?.trim() || DEFAULT_CODEX_MODEL
    this.timeoutMs = opts.timeoutMs ?? CODEX_DEFAULT_TIMEOUT_MS
    this.tmpRoot = opts.tmpRoot
  }

  /**
   * argv 以 spike §14 的「實測 5/5 成功」組態為基礎，本批次再驗一次並加上兩個旗標：
   * - `--json`：把進度與錯誤從 stderr 移到 stdout 的結構化事件（見檔頭實測結論 1）。
   * - `--color never`：避免 ANSI 控制碼混進輸出。
   *
   * `--cd` 指到**每次呼叫自己的空 work 子目錄**，而不是共用的固定 workdir ——
   * 空目錄本來就是設計意圖（design §13-5），做成 per-call 就順便免掉「共用目錄要不要清」的問題。
   * schema.json / out.json 刻意放在 work 的**外面**，避免出現在模型看得到的工作區裡。
   */
  private buildArgs(workdir: string, outPath: string, schemaPath: string | null): string[] {
    const args = [
      'exec',
      '--skip-git-repo-check', // 必須：codex 預設要求在 git repo 內執行
      '--cd',
      workdir,
      '--sandbox',
      'read-only', // `codex exec` 預設就是 read-only，仍顯式宣告
      '--ignore-user-config',
      '--ignore-rules',
      '--ephemeral',
      '--color',
      'never',
      '--json'
    ]
    // `this.model` 在建構子已保證非空 → `-m` 無條件帶上（design：不沿用本機 CLI 預設模型）。
    args.push('-m', this.model)
    if (schemaPath !== null) args.push('--output-schema', schemaPath)
    args.push('-o', outPath, '-') // 結尾的 `-`＝整個 prompt 從 stdin 讀
    return args
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const startedAt = Date.now()
    const root = await resolveCodexTmpRoot(this.tmpRoot)
    await mkdir(root, { recursive: true })
    // 每次呼叫一個獨立目錄：concurrency 下共用檔名會有寫入競態（design §2.3）。
    const dir = await mkdtemp(join(root, TMP_DIR_PREFIX))

    try {
      const workdir = join(dir, WORK_DIR)
      await mkdir(workdir)
      const outPath = join(dir, OUT_FILE)

      let schemaPath: string | null = null
      if (req.jsonSchema) {
        schemaPath = join(dir, SCHEMA_FILE)
        // --output-schema 吃的是「檔案路徑」，不吃 inline；且必須是 strict-safe 變體。
        await writeFile(schemaPath, JSON.stringify(toStrictJsonSchema(req.jsonSchema.schema)), 'utf8')
      }

      const { result } = await runLocatedCli({
        name: 'codex',
        execPathOverride: this.execPath,
        args: this.buildArgs(workdir, outPath, schemaPath),
        stdin: `${req.system}\n\n${req.user}`,
        cwd: workdir,
        env: sanitizeEnv({ extraDeny: CODEX_ENV_DENYLIST }),
        timeoutMs: req.timeoutMs ?? this.timeoutMs,
        signal: req.signal
      })

      // 第一關：provider 無關的失敗（spawn / 逾時 / 取消）。
      const failure = classifyRunFailure('codex', result, CODEX_SIGNALS)
      if (failure) throw failure

      const events = parseJsonlEvents(result.stdout)
      const eventError = firstEventError(events)
      // 第二關：codex 自己回報的失敗。exit code 語意粗略（只有 0/非 0），
      // 所以「有 error / turn.failed 事件」與「exit ≠ 0」任一成立就算失敗。
      if (eventError !== null || result.code !== 0) {
        throw codexFailure(result, eventError)
      }

      // 第三關：取結果。先讀 out.json（明確契約），缺了才退到事件流的 agent_message。
      let content = await readIfExists(outPath)
      let usedFallback = false
      if (content === null || content.trim().length === 0) {
        const fromEvents = lastAgentMessage(events)
        if (fromEvents !== null && fromEvents.trim().length > 0) {
          content = fromEvents
          usedFallback = true
        }
      }
      if (content === null || content.trim().length === 0) {
        throw cliError(
          'bad_output',
          'Codex 沒有產生任何輸出內容。',
          describeRunFailure('codex', result, CODEX_SIGNALS)
        )
      }

      const meta = {
        provider: this.id,
        model: this.model,
        durationMs: Date.now() - startedAt,
        usedFallback
      }

      if (!req.jsonSchema) {
        // 無 schema 時 out.json 是純文字（實測 87 bytes 的一句中文，非 JSON）。
        return { text: content.trim(), structured: undefined, meta }
      }

      // 有 schema 時 out.json 是**裸的結果物件、無信封**（spike §4b，本批次覆現）。
      let structured: unknown
      try {
        structured = JSON.parse(content) as unknown
      } catch (err) {
        throw cliError(
          'bad_output',
          'Codex 的輸出不是合法的 JSON。',
          describeRunFailure('codex', result, CODEX_SIGNALS),
          err
        )
      }
      // zod 驗證永遠在 provider 之外做（design §1.3）；這裡只保證「拿到了東西」。
      return { text: JSON.stringify(structured), structured, meta }
    } finally {
      try {
        await rm(dir, { recursive: true, force: true })
      } catch {
        /* 逾時被 kill 的路徑下檔案可能仍被佔用；交給開機清掃收尾 */
      }
    }
  }

  /**
   * 健檢：定位 → `--version` → `login status`。**不跑真 prompt**（design §3.3）：
   * 一次真呼叫要 20 秒且會燒訂閱額度，使用者按「檢查」時期待的是即時回饋。
   *
   * `codex login status` 的訊息在 **stderr**（spike §2，本批次覆現：exit 0 +
   * stderr `Logged in using ChatGPT`，69 ms），只讀 stdout 會誤判成「無回應」。
   */
  async health(): Promise<ProviderHealth> {
    const located = await locateCli('codex', this.execPath)
    if (!located.ok) {
      const err = locateFailureToError('codex', located)
      return {
        ok: false,
        summary: err?.userMessage ?? '找不到 Codex CLI。',
        code: err?.code ?? 'not_installed',
        details: { installed: false, path: null }
      }
    }
    const path = located.location.path
    const env = sanitizeEnv({ extraDeny: CODEX_ENV_DENYLIST })

    const versionRun = await runCli({
      exePath: path,
      args: ['--version'],
      stdin: '',
      env,
      timeoutMs: VERSION_TIMEOUT_MS
    })
    const versionFailure = classifyRunFailure('codex', versionRun, CODEX_SIGNALS)
    if (versionFailure) {
      return {
        ok: false,
        summary: versionFailure.userMessage,
        code: versionFailure.code,
        details: { installed: true, path }
      }
    }
    const version = extractSemver(versionRun.stdout)
    const versionOk = meetsMinimumVersion(version, CODEX_TESTED_VERSION)

    const loginRun = await runCli({
      exePath: path,
      args: ['login', 'status'],
      stdin: '',
      env,
      timeoutMs: LOGIN_TIMEOUT_MS
    })
    // 訊息可能落在 stdout 或 stderr，兩邊都看。
    const loginText = `${loginRun.stdout}\n${loginRun.stderr}`
    const notLoggedIn = /not logged in/i.test(loginText)
    const loggedIn = !notLoggedIn && /logged in/i.test(loginText) && loginRun.code === 0
    const authenticated: boolean | 'unknown' = loggedIn
      ? true
      : notLoggedIn || loginRun.code !== 0
        ? false
        : 'unknown'

    if (authenticated === false) {
      return {
        ok: false,
        summary: 'Codex CLI 尚未登入。請在終端機執行 `codex login` 完成登入後再試。',
        code: 'not_authenticated',
        details: { installed: true, path, version, versionOk, authenticated }
      }
    }

    // 版本低於實測版只警告不擋（design §3.3：codex 沒有已知的功能下限）。
    const versionNote = versionOk ? '' : `（版本 ${version ?? '未知'} 低於實測版 ${CODEX_TESTED_VERSION}）`
    const authNote = authenticated === true ? '已登入' : '登入狀態無法確認'
    return {
      ok: true,
      summary: `Codex CLI ${version ?? '版本未知'}，${authNote}${versionNote}`,
      details: { installed: true, path, version, versionOk, authenticated }
    }
  }
}

/** 建立 Codex CLI provider。每次呼叫重新建立（與 http provider 一致，不在模組層長存）。 */
export function makeCodexCliProvider(opts: CodexCliProviderOptions = {}): LlmProvider {
  return new CodexCliProvider(opts)
}
