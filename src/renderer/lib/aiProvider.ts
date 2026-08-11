import type {
  AiProviderId,
  CliProviderSettings,
  ProviderHealth,
  SettingsView
} from '../types/api'

/**
 * aiProvider.ts — 設定頁「AI 判斷引擎」的 renderer 端資料與換算。
 *
 * 文案與數字沿用已核可的方案 A 原型
 * （output/sw/ai-provider-cli-20260811/settings-ui-prototype.html），
 * 延遲數字來自同目錄 spike-results.md §3（Claude p90 20.99 秒、Codex p90 22.76 秒）。
 *
 * 這裡只做「呈現用」的換算：真正的 provider 行為、健檢與 concurrency 壓制都在 main。
 */

export interface ProviderModelOption {
  value: string
  label: string
}

export interface ProviderMeta {
  id: AiProviderId
  kind: 'http' | 'cli'
  name: string
  /** 卡片副標。 */
  sub: string
  /** 常駐速度標籤（選之前就看得到）。 */
  speed: string
  speedClass: 'fast' | 'slow'
  /** 健檢按鈕文案：HTTP＝測試連線；CLI＝檢查 CLI 狀態。 */
  testLabel: string
  /** 健檢按鈕旁的說明。 */
  testHint: string
  /** CLI 專屬。 */
  cliName?: string
  loginCmd?: string
  models: ProviderModelOption[]
  /** 只找到 .cmd 時，提示原生 exe 常見位置（spike §1 的路徑形狀）。 */
  nativeExeHint?: string
}

export const PROVIDERS: readonly ProviderMeta[] = [
  {
    id: 'http',
    kind: 'http',
    name: 'HTTP 端點',
    sub: 'OpenAI 相容 API（現行預設）。需要 Base URL 與 API 金鑰。',
    speed: '每次約 1–3 秒',
    speedClass: 'fast',
    testLabel: '測試連線',
    testHint: '向端點要一次模型清單，確認 Base URL 與金鑰可用。',
    models: []
  },
  {
    id: 'claudeCli',
    kind: 'cli',
    name: 'Claude CLI',
    sub: '呼叫本機已安裝的 Claude Code，用你自己已登入的訂閱帳號，不需要 API 金鑰。',
    speed: '每次約 20 秒',
    speedClass: 'slow',
    testLabel: '檢查 CLI 狀態',
    testHint: '檢查 CLI 是否存在、版本是否夠新、是否已登入。不會真的送出一次抽取，不燒訂閱額度。',
    cliName: 'claude',
    loginCmd: 'claude /login',
    models: [
      { value: 'sonnet', label: 'sonnet — 建議：實測 5/5 成功，p90 約 21 秒' },
      { value: 'haiku', label: 'haiku — 不建議：實測結構化輸出只成功 2/5' },
      { value: 'opus', label: 'opus — 最貴：實測單次抽取最高 $0.149' }
    ],
    nativeExeHint: 'C:\\nvm4w\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
  },
  {
    id: 'codexCli',
    kind: 'cli',
    name: 'Codex CLI',
    sub: '呼叫本機已安裝的 Codex，用你自己已登入的 ChatGPT 訂閱帳號，不需要 API 金鑰。',
    speed: '每次約 20 秒',
    speedClass: 'slow',
    testLabel: '檢查 CLI 狀態',
    testHint: '檢查 CLI 是否存在、版本是否夠新、是否已登入。不會真的送出一次抽取，不燒訂閱額度。',
    cliName: 'codex',
    loginCmd: 'codex login',
    models: [
      { value: 'gpt-5.6-sol', label: 'gpt-5.6-sol — 建議：實測 5/5 成功，p90 約 23 秒' },
      {
        value: 'gpt-5.6-luna',
        label: 'gpt-5.6-luna — 可用：實測 5/5 成功，p50 約 16 秒 / p90 約 19 秒，品質與 sol 相近'
      }
    ],
    nativeExeHint: 'C:\\Users\\你\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe'
  }
] as const

export function providerMeta(id: AiProviderId): ProviderMeta {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]
}

export function isCliProvider(id: AiProviderId): boolean {
  return providerMeta(id).kind === 'cli'
}

/** 取某 CLI provider 的設定；http 回 null。 */
export function cliSettingsOf(
  view: SettingsView,
  id: AiProviderId
): CliProviderSettings | null {
  if (id === 'claudeCli') return view.claudeCli
  if (id === 'codexCli') return view.codexCli
  return null
}

/** 每次抽取的秒數（估算用）；來源 spike-results.md §3。 */
const PER_CALL_SEC: Record<AiProviderId, number> = { http: 2, claudeCli: 21, codexCli: 21 }

/**
 * 輪詢間隔的合法上限，鏡射 main/config/settings.ts `updateSettings()` 的 clamp（5–3600 秒）。
 *
 * ⚠️ 唯讀鏡射，不是另一份真實來源：main 才是 clamp 的權威，這裡只是讓「建議值」算出來
 * 就已經落在合法範圍內，不要給一個按了會被夾掉、變成死路的數字。要調整輪詢策略請改
 * main 的 clamp，這裡要跟著動。
 */
export const POLL_SEC_MAX = 3600

/**
 * 實際生效的併發數：CLI 一律被 main 壓成 1（src/main/index.ts，design.md §7.1），
 * 設定頁只是把這個事實顯示出來，不會自己去改存起來的值。
 */
export function effectiveConcurrency(id: AiProviderId, configured: number): number {
  return isCliProvider(id) ? 1 : configured
}

export function fmtDuration(sec: number): string {
  const s = Math.round(sec)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  const rest = s % 60
  return rest ? `${m} 分 ${rest} 秒` : `${m} 分鐘`
}

export interface LatencyEstimate {
  /** 每室秒數。 */
  perCallSec: number
  /** 實際生效併發。 */
  concurrency: number
  /** 跑完一輪的秒數。 */
  roundSec: number
  /** 一輪比輪詢間隔還久＝追不上。 */
  behind: boolean
  /**
   * 建議的輪詢間隔（秒），至少 300 秒且取整到分鐘，並封頂在 {@link POLL_SEC_MAX}
   * ——跟 `updateSettings()` 的 clamp 對齊，保證「按下去」這個數字真的落得了檔。
   */
  suggestPollSec: number
  /**
   * 連把輪詢間隔拉到上限（{@link POLL_SEC_MAX}）都追不上一輪。
   * 這種規模不是調輪詢間隔能解的問題，UI 不該再給一顆「改成 XX」的按鈕誤導使用者。
   */
  hopeless: boolean
}

export function estimateRound(
  provider: AiProviderId,
  chatCount: number,
  configuredConcurrency: number,
  pollIntervalSec: number
): LatencyEstimate {
  const perCallSec = PER_CALL_SEC[provider]
  const concurrency = effectiveConcurrency(provider, configuredConcurrency)
  const roundSec = Math.ceil((chatCount * perCallSec) / Math.max(1, concurrency))
  const rawSuggestSec = Math.max(300, Math.ceil((roundSec * 1.2) / 60) * 60)
  return {
    perCallSec,
    concurrency,
    roundSec,
    behind: roundSec > pollIntervalSec,
    suggestPollSec: Math.min(POLL_SEC_MAX, rawSuggestSec),
    hopeless: roundSec > POLL_SEC_MAX
  }
}

/** `.cmd` / `.bat` 批次檔（跑結構化抽取會失敗，見 claudeCli.ts §「.cmd 與 --json-schema 的衝突」）。 */
export function isBatchPath(p: string | null | undefined): boolean {
  return typeof p === 'string' && /\.(cmd|bat)$/i.test(p.trim())
}

export type HealthLevel = 'ok' | 'warn' | 'err'

export interface HealthLine {
  k: string
  v: string
  s: '' | 'ok' | 'warn' | 'err'
}

/**
 * 健檢結果的嚴重度。main 只回 ok:boolean，這裡多分出「可用但要注意」：
 *   - 找到的是 .cmd 批次檔（main 不知道這件事會擋抽取，只有 UI 提醒得了）
 *   - 版本低於實測版但仍可用（codex）
 *   - 登入狀態無法確定（codex 常態）
 */
export function healthLevel(h: ProviderHealth): HealthLevel {
  const d = h.details
  if (isBatchPath(d.path)) return 'warn'
  if (h.ok) return d.authenticated === 'unknown' || d.versionOk === false ? 'warn' : 'ok'
  if (d.installed && d.authenticated === 'unknown') return 'warn'
  return 'err'
}

/**
 * UI 只加 main 給不了的那一句（.cmd 批次檔），其餘一律用 main 的 summary
 * ——它是 provider 契約裡「UI 唯一的訊息來源」（provider/types.ts）。
 */
export function healthHeadline(h: ProviderHealth): string | null {
  if (!isBatchPath(h.details.path)) return null
  return '找到的是批次檔（.cmd），不是原生執行檔。用批次檔跑結構化抽取會失敗，請改指定原生 .exe。'
}

/** 健檢結果的三行呈現（CLI：路徑／版本／登入；HTTP：端點／模型）。 */
export function healthLines(
  h: ProviderHealth,
  provider: AiProviderId,
  ctx: { baseUrl: string; execPath: string }
): HealthLine[] {
  const meta = providerMeta(provider)
  const d = h.details

  if (meta.kind === 'http') {
    const lines: HealthLine[] = [
      {
        k: '端點',
        v: ctx.baseUrl.trim() ? ctx.baseUrl.trim() : '（預設端點）',
        s: h.ok ? 'ok' : 'err'
      }
    ]
    if (d.models?.length) {
      lines.push({ k: '模型', v: d.models.slice(0, 8).join(', '), s: 'ok' })
    }
    return lines
  }

  const batch = isBatchPath(d.path)
  const pathLine: HealthLine = d.path
    ? {
        k: '路徑',
        v: `${d.path}${batch ? '（批次檔）' : ''}${ctx.execPath.trim() ? '（你手動指定）' : '（自動偵測）'}`,
        s: batch ? 'warn' : 'ok'
      }
    : {
        k: '路徑',
        v: `找不到 ${meta.cliName} 執行檔（已試過 PATH 與常見安裝位置）`,
        s: 'err'
      }

  const versionLine: HealthLine = d.version
    ? {
        k: '版本',
        v: d.version + (d.versionOk === false ? '（低於建議版本）' : ''),
        s: d.versionOk === false ? (provider === 'claudeCli' ? 'err' : 'warn') : 'ok'
      }
    : { k: '版本', v: '—', s: '' }

  const authLine: HealthLine =
    d.authenticated === true
      ? { k: '登入', v: '已登入', s: 'ok' }
      : d.authenticated === false
        ? { k: '登入', v: '尚未登入', s: 'err' }
        : d.authenticated === 'unknown'
          ? { k: '登入', v: '無法確定（也可能存放在系統金鑰庫，這種情況是正常的）', s: 'warn' }
          : { k: '登入', v: '—', s: '' }

  return [pathLine, versionLine, authLine]
}

/**
 * 引擎未就緒（SettingsView / PipelineStatus 的 hasApiKey=false）時該說什麼。
 * 欄位名沿用歷史叫 hasApiKey，但在 CLI provider 下它代表的是「找不到指定的執行檔」，
 * 寫死「請填入金鑰」會把使用者導到錯的地方（Batch 5 指出）。
 */
export function notReadyText(provider: AiProviderId): string {
  const meta = providerMeta(provider)
  if (meta.kind === 'http') return '請在設定頁填入 API 金鑰才會抽取代辦'
  return `找不到可用的 ${meta.name} 執行檔，請到設定頁檢查 CLI 狀態`
}

/** 同上，但用在按鈕 title / 一行提示（較短）。 */
export function notReadyShortText(provider: AiProviderId): string {
  const meta = providerMeta(provider)
  if (meta.kind === 'http') return '請先到設定頁填金鑰'
  return `請先到設定頁檢查 ${meta.name} 狀態`
}

/**
 * 「模型」欄位下方要求必填的理由，provider-aware。
 *
 * Claude CLI：不帶 `--model` 會繼承使用者 `~/.claude/settings.json` 的預設，
 * 實測有人的預設是 opus，單次抽取燒到 $0.149 且不會被通知（claudeCli.ts 頂部表格）。
 *
 * Codex CLI：跟 Claude CLI 行為不同——main 端的 CodexCliProvider 建構子一律
 * `opts.model?.trim() || DEFAULT_CODEX_MODEL`，空字串不會落到「跑什麼都不知道」，
 * 而是保證退回內建安全預設 `gpt-5.6-sol`（codexCli.ts DEFAULT_CODEX_MODEL）。
 * 這裡仍要求你明確選一個，理由不是怕燒錢，而是讓你在這個下拉選單就看得到
 * 目前實際會跑哪個模型，不用去猜「空白＝哪一個」。
 */
export function modelRationaleText(provider: AiProviderId): string {
  if (provider === 'codexCli') {
    return (
      '留空時 Codex CLI 會自動退回內建安全預設 gpt-5.6-sol（main 端寫死的 ' +
      'DEFAULT_CODEX_MODEL），不會意外燒到高價模型；這裡仍固定要你選一個，' +
      '是為了讓你清楚看到目前實際在跑哪個模型，而不是要你猜。'
    )
  }
  return (
    '不指定模型會沿用你本機 CLI 的預設值（實測有人的預設是 opus，單次抽取 $0.149），' +
    '所以這裡固定寫死一個。'
  )
}
