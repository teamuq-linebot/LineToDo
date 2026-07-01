/**
 * defaults.ts — pipeline / 降噪黑名單預設值（IMPLEMENTATION_PLAN.md §7.1）。
 *
 * 本輪（M2 抽取管線）需要：blocklist 規則（自動 block 判定）+ pollIntervalSec + concurrency
 * + 去抖動參數。完整 settings.json 持久化 / 設定頁覆寫屬 M3；此處先以常數提供，
 * 並允許部分用環境變數覆寫，方便開發/測試。
 */

export interface BlocklistRules {
  /** chat 名稱含這些關鍵字 → 視為推播/官方/噪音，自動 block。 */
  nameKeywords: string[]
  /** sender 含這些字 → 噪音來源。 */
  senderKeywords: string[]
  /** 整輪該 chat 只有這些 contentType（如貼圖 7）→ 該輪視為 noise，不送 LLM。 */
  contentTypeNoiseOnly: number[]
  /** 純符號 / 過短文字略過（長度 < 此值且非可解析內容）。 */
  minTextLenForLLM: number
}

export interface PipelineDefaults {
  pollIntervalSec: number
  concurrency: number
  /** 去抖動：安靜 N 秒沒新訊息才觸發該 chat 抽取。 */
  debounceQuietSec: number
  /** 去抖動：單 chat 累積 M 則立即觸發（不等安靜）。 */
  debounceMaxBatch: number
  /** 每個 chat 餵 LLM 的 recentContext 則數上限。 */
  recentContextLimit: number
  blocklist: BlocklistRules
  /** 逐對話關鍵字忽略：chatId → 小寫關鍵字陣列。抽取後過濾命中的 newTodo（per-chat 第二層忽略）。 */
  chatIgnoreKeywords: Record<string, string[]>
}

export const DEFAULT_BLOCKLIST: BlocklistRules = {
  nameKeywords: [
    '官方',
    '公告',
    '通知',
    '推播',
    '客服',
    '小幫手',
    'Bot',
    '機器人',
    '新聞',
    '快訊',
    '優惠',
    '促銷',
    '折扣',
    '活動',
    '中獎',
    '投資',
    '股票',
    '貸款',
    '博弈',
    '娛樂城',
    '點數',
    '回饋',
    'DM',
    // 行政通知降噪（學校 / 社區家長群等）— 對應 extractPrompt 降噪規則，2026-06-27
    '家長群',
    '家長會',
    '班級群',
    '社區公告',
    '管委會'
  ],
  senderKeywords: ['官方帳號', 'LINE 官方'],
  contentTypeNoiseOnly: [7],
  minTextLenForLLM: 2
}

export const DEFAULTS: PipelineDefaults = {
  pollIntervalSec: 30,
  concurrency: 2,
  debounceQuietSec: 8,
  debounceMaxBatch: 20,
  recentContextLimit: 10,
  blocklist: DEFAULT_BLOCKLIST,
  chatIgnoreKeywords: {}
}

/**
 * 持久化設定覆寫 hook（IMPLEMENTATION_PLAN.md §7）。
 *
 * 設定頁存的設定（settings.ts → settings.json）要能蓋過內建常數，但 settings.ts 依賴 Electron，
 * 不能在非 Electron 環境（probe 腳本 / 測試）被強制載入。故用注入式 hook：
 * main 啟動時呼叫 setSettingsOverlayProvider(getSettings)，腳本/測試不注入即走純常數。
 */
export type SettingsOverlay = Partial<
  Pick<
    PipelineDefaults,
    'pollIntervalSec' | 'concurrency' | 'recentContextLimit' | 'blocklist' | 'chatIgnoreKeywords'
  >
>
let settingsOverlayProvider: (() => SettingsOverlay) | null = null

/** main 啟動時注入：把使用者持久化設定併入 getPipelineDefaults()。 */
export function setSettingsOverlayProvider(provider: () => SettingsOverlay): void {
  settingsOverlayProvider = provider
}

/**
 * 取 pipeline 設定。優先序（高→低）：
 *   環境變數（poll / 並發，開發用）> 使用者持久化設定（設定頁）> 內建常數 DEFAULTS。
 */
export function getPipelineDefaults(): PipelineDefaults {
  const pollEnv = Number(process.env.QWEN_POLL_SEC)
  const concEnv = Number(process.env.QWEN_CONCURRENCY)

  let overlay: SettingsOverlay = {}
  if (settingsOverlayProvider) {
    try {
      overlay = settingsOverlayProvider() ?? {}
    } catch {
      /* 設定讀取失敗就退回常數，不讓 pipeline 整個炸掉 */
    }
  }

  const base: PipelineDefaults = {
    ...DEFAULTS,
    ...overlay,
    blocklist: overlay.blocklist ?? DEFAULTS.blocklist,
    chatIgnoreKeywords: overlay.chatIgnoreKeywords ?? DEFAULTS.chatIgnoreKeywords
  }

  return {
    ...base,
    pollIntervalSec:
      Number.isFinite(pollEnv) && pollEnv > 0 ? pollEnv : base.pollIntervalSec,
    concurrency:
      Number.isFinite(concEnv) && concEnv > 0
        ? Math.min(Math.max(Math.floor(concEnv), 1), 4)
        : base.concurrency
  }
}
