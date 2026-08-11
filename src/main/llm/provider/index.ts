import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getQwenConfig } from '../../config/qwen'
import { getSettings, type AiProviderId, type CliProviderSettings } from '../../config/settings'
import { makeHttpProvider } from './httpOpenAi'
import { makeClaudeCliProvider } from './claudeCli'
import { makeCodexCliProvider } from './codexCli'
import type { LlmProvider, ProviderHealth } from './types'

/**
 * provider/index.ts — 依設定解析出「當前的 AI provider」（design.md §1.7）。
 *
 * Batch 5：三路分派（http / claudeCli / codexCli）。
 * 這裡是**唯一**把「設定」翻譯成「provider 建構參數」的地方；provider 本身不讀設定，
 * 才能在 electron 之外被腳本獨立測試（Batch 3/4 的 smoke 就是這樣跑的）。
 *
 * `null` 的語意 = 「LLM 階段優雅停用」：維持現有「無金鑰不崩潰、不硬寫」的行為，
 * 呼叫端（makeExtractFn / draftReply handler）據此跳過並在 UI 提示。
 * **CLI provider 永遠不回 null**——偵測要 spawn，太貴且每輪都做會拖垮輪詢；
 * 找不到 CLI 的錯誤在 `complete()` 第一次呼叫時才浮現（design.md §1.7）。
 */

export type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  ProviderHealth,
  LlmProviderId,
  LlmErrorCode
} from './types'
export { LlmProviderError } from './types'
export { makeHttpProvider } from './httpOpenAi'
export { makeClaudeCliProvider } from './claudeCli'
export { makeCodexCliProvider, sweepCodexTmpDirs } from './codexCli'

/** 空的工作目錄名（切斷 project-level 記憶與設定的向上探索，design.md §2.2）。 */
const CLI_WORKDIR = 'ai-cli-workdir'

/** 取 `<userData>/ai-cli-workdir`；非 electron 環境（不會發生於 main，但保險）回 undefined。 */
function cliWorkdir(): string | undefined {
  try {
    return join(app.getPath('userData'), CLI_WORKDIR)
  } catch {
    return undefined
  }
}

/** 空字串＝「用 provider 內建的建議預設」，所以要轉成 undefined 而不是原樣傳空字串。 */
function orUndefined(v: string): string | undefined {
  const s = v.trim()
  return s.length > 0 ? s : undefined
}

function makeClaudeFromSettings(cfg: CliProviderSettings): LlmProvider {
  return makeClaudeCliProvider({
    execPath: cfg.execPath,
    // 空字串 → undefined → provider 用 DEFAULT_CLAUDE_MODEL（'sonnet'）。
    // 模型名的單一真實來源留在 claudeCli.ts，設定層不複製一份。
    model: orUndefined(cfg.model),
    timeoutMs: cfg.timeoutMs,
    workdir: cliWorkdir()
  })
}

function makeCodexFromSettings(cfg: CliProviderSettings): LlmProvider {
  return makeCodexCliProvider({
    execPath: cfg.execPath,
    // 空字串 → undefined → provider 用 DEFAULT_CODEX_MODEL（'gpt-5.6-sol'）。
    // 與 claude 同理，模型名的單一真實來源留在 codexCli.ts；**設定為空時 codex 仍會帶 `-m`**，
    // 絕不退回「沿用使用者本機 CLI 的預設模型」（那條路會在使用者不知情下跑到昂貴模型）。
    model: orUndefined(cfg.model),
    timeoutMs: cfg.timeoutMs
  })
}

/** 解析當前 provider；無法使用（http 無金鑰）回 null。每次呼叫重新建立（金鑰即用即丟）。 */
export function resolveProvider(): LlmProvider | null {
  const s = getSettings()
  switch (s.aiProvider) {
    case 'claudeCli':
      return makeClaudeFromSettings(s.claudeCli)
    case 'codexCli':
      return makeCodexFromSettings(s.codexCli)
    case 'http':
    default: {
      const cfg = getQwenConfig()
      if (!cfg.apiKey) return null
      return makeHttpProvider({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseURL,
        model: cfg.model,
        timeoutMs: cfg.timeoutMs
      })
    }
  }
}

/** 目前選用的 provider 種類（scheduler / UI 顯示用；不建構 provider、不做 I/O）。 */
export function currentProviderId(): AiProviderId {
  return getSettings().aiProvider
}

/**
 * 「AI 引擎已就緒」的**廉價**判定（design.md §4.3）。scheduler.getStatus() 每次狀態變更都會呼叫，
 * 所以這裡**絕不 spawn**：
 *   - http     → 有金鑰即 true（維持原 `hasApiKey` 語意）
 *   - CLI      → true；唯一會回 false 的情況是「使用者手動指定了 execPath 但那個檔不存在」
 *                （existsSync 很便宜，而且這是使用者一定想立刻知道的設定錯誤）
 *
 * 真正的「裝了沒 / 登入了沒」由 `settings:testAiProvider`（health()）回答——那會 spawn，
 * 只在使用者按下按鈕時才做。
 */
export function isProviderConfigured(): boolean {
  const s = getSettings()
  switch (s.aiProvider) {
    case 'claudeCli':
      return !s.claudeCli.execPath || existsSync(s.claudeCli.execPath)
    case 'codexCli':
      return !s.codexCli.execPath || existsSync(s.codexCli.execPath)
    case 'http':
    default:
      return getQwenConfig().apiKey !== null
  }
}

/** 未設定/不可用時給 UI 的健檢結果（provider 為 null 時用；只有 http 會走到）。 */
export function unconfiguredHealth(): ProviderHealth {
  return {
    ok: false,
    code: 'invalid_config',
    summary: '尚未設定 API 金鑰（請在設定頁填入，或設環境變數 QWEN_API_KEY）',
    details: {}
  }
}
