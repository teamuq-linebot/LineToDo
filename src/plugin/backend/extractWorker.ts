/**
 * extractWorker.ts — backend 內的背景抽取（0.2.0）：取代 0.1.x 在看板 view 裡跑的 aiOrchestrator。
 *
 * 流程（全部在 backend 行程內，看板不需要開著）：
 *   ExtractQueue（供料：落庫、過濾、依單輪上限切片、租約）
 *     ──► 本 worker 一次領一個項目 ──► AI port（`host.ai.complete`，配額／退避／JSON 重問都在 port）
 *     ──► `queue.commit`（zod 重新驗證 → `applyChatExtract` 落庫、標 processed）或 `queue.release`（還租約）。
 *
 * 失敗語意（不丟失待抽取項目）：
 *   - 訊息只有在 commit 成功落庫後才標 processed；租約只存在記憶體，行程被 TeamUQ 閒置卸載或當掉時租約消失，
 *     訊息仍是未處理，下次啟動由 scheduler 重新供料。
 *   - 「不是這一項的錯」（`rate_limited`、`quota_exhausted`、供應者不可用、授權被關、host 忙碌…，見 `isTransientAiCode`）：租約還回去，
 *     不增加失敗次數，worker 依 port 回報的 retryAfterMs 等到可以再試；授權被關時每 30 秒探測一次，恢復後自動繼續。
 *   - 這一項本輪失敗（`empty_reply`、`invalid_json`、`invalid_result`、`provider_error`、`turn_timeout`…）：`commit(ok:false)`，
 *     ExtractQueue 對該聊天室做指數退避（30 s → 30 min），訊息維持未處理，退避到期後重抽。
 * 時間是注入的；不依賴 DOM／Electron。
 */
import { AiPortError } from '../../core/aiPort'
import type { AiPort } from '../../core/aiPort'
import { validateExtractResult } from '../../shared/extractResult'
import type { Clock } from './hostAi'
import { SYSTEM_CLOCK, codeOf, isTransientAiCode, worstCaseItemMs } from './hostAi'
import type { ExtractQueue } from './extractQueue'

export interface ExtractWorkerPort extends AiPort {
  ready(): Promise<boolean>
  blockedFor(priority?: 'user' | 'background'): number
}

export interface ExtractWorkerConfig {
  /** 閒置時檢查待處理項目的間隔（備援；平常靠 `onPending` 事件）。 */
  pollIntervalMs: number
  leaseMs: number
  /** port 暫時不能用（供應者、授權）時至少等多久再看。 */
  unavailableRetryMs: number
}

/**
 * 租約比一個項目在 port 裡最壞要花的時間（等配額＋讀選項＋兩次 host 呼叫，約 13 分鐘）多一分鐘：租約過期時結果會被丟掉、配額白花（review F3）。
 * 租約只存在記憶體，行程當掉時一起消失，所以長租約不會讓項目卡住。
 */
export const EXTRACT_WORKER_DEFAULTS: Readonly<ExtractWorkerConfig> = Object.freeze({ pollIntervalMs: 15_000, leaseMs: worstCaseItemMs() + 60_000, unavailableRetryMs: 5_000 })

export interface ExtractWorkerCounters { extracted: number; rejected: number; failed: number; released: number }

export interface ExtractWorker {
  start(): void
  /** 停止：不再領新項目；進行中的 host 呼叫無法中止，回來後結果不再落庫（訊息維持未處理）。 */
  stop(): void
  /** 立刻檢查有沒有工作（`extract-pending` 事件時呼叫）。 */
  kick(): void
  running(): boolean
  counters(): ExtractWorkerCounters
  /** 目前這輪迴圈結束（沒有進行中的工作）時 resolve；測試用。 */
  idle(): Promise<void>
}

export interface ExtractWorkerDeps {
  queue: ExtractQueue
  port: ExtractWorkerPort
  /** 抽取的 system prompt（含固定輸出格式）。每次領到項目時才讀，所以設定頁改 prompt 馬上生效。 */
  system(): string
  clock?: Clock
  config?: Partial<ExtractWorkerConfig>
  log?: (event: string, detail?: Record<string, unknown>) => void
}

export function createExtractWorker(deps: ExtractWorkerDeps): ExtractWorker {
  const clock = deps.clock ?? SYSTEM_CLOCK
  const cfg: ExtractWorkerConfig = { ...EXTRACT_WORKER_DEFAULTS, ...deps.config }
  const log = (event: string, detail?: Record<string, unknown>): void => { try { deps.log?.(event, detail) } catch { /* 診斷失敗不影響流程 */ } }
  const counters: ExtractWorkerCounters = { extracted: 0, rejected: 0, failed: 0, released: 0 }
  let stopped = true
  let draining = false
  let again = false
  let wakeTimer: unknown = null
  let wakeAt: number | null = null
  let idleWaiters: Array<() => void> = []

  const validate = (value: unknown): { ok: true; value: unknown } | { ok: false; reason: string } => {
    try { return { ok: true, value: validateExtractResult(value) } } catch (error) {
      const issues = (error as { issues?: Array<{ path?: unknown[]; message?: string }> } | null)?.issues
      const reason = Array.isArray(issues) ? issues.slice(0, 4).map((i) => `${(i.path ?? []).join('.') || '(root)'}: ${i.message ?? 'invalid'}`).join('；') : String(error instanceof Error ? error.message : error).slice(0, 160)
      return { ok: false, reason }
    }
  }

  const scheduleWake = (delayMs: number): void => {
    if (stopped) return
    const at = clock.now() + Math.max(0, delayMs)
    if (wakeTimer !== null && wakeAt !== null && wakeAt <= at) return
    if (wakeTimer !== null) clock.clearTimeout(wakeTimer)
    wakeAt = at
    wakeTimer = clock.setTimeout(() => { wakeTimer = null; wakeAt = null; kick() }, Math.max(1, delayMs))
  }

  /** 處理一個領到的項目。回傳：要等多久再看（null＝可以馬上領下一個）。 */
  const runItem = async (item: { itemId: string; chatId: string; user: string }): Promise<number | null> => {
    try {
      const result = await deps.port.complete({ system: deps.system(), user: item.user, conversationScope: { kind: 'line-chat-extract', chatId: item.chatId }, expectJson: true, validate, priority: 'background' })
      if (stopped) return null
      const committed = deps.queue.commit({ results: [{ itemId: item.itemId, ok: true, result: result.value }] })
      const status = committed.results[0]?.status
      if (status === 'applied' || status === 'accepted') counters.extracted += 1
      else { counters.rejected += 1; log('extract commit not applied', { status }) }
      return null
    } catch (error) {
      const code = codeOf(error)
      const retryAfter = error instanceof AiPortError ? error.retryAfterMs : null
      if (stopped) return null
      try {
        if (isTransientAiCode(code)) {
          // 不是這個聊天室的錯：租約還回去，等 port 說可以再試。
          counters.released += 1
          deps.queue.release({ itemIds: [item.itemId] })
          return Math.max(retryAfter ?? 0, deps.port.blockedFor('background'), 1_000)
        }
        counters.failed += 1
        deps.queue.commit({ results: [{ itemId: item.itemId, ok: false, failCode: code, ...(retryAfter !== null ? { retryAfterMs: Math.round(retryAfter) } : {}) }] })
        return null
      } catch (inner) {
        log('extract commit/release failed', { code: codeOf(inner) })
        return cfg.unavailableRetryMs
      }
    }
  }

  const cycle = async (): Promise<void> => {
    for (;;) {
      if (stopped) return
      deps.queue.touch()
      // 佇列是空的就不要去問 host（`getOptions` 會被當成一次呼叫）：新項目進來時 `onPending` 會 kick，這裡只是備援輪詢（review F2）。
      if (!deps.queue.hasPending()) { scheduleWake(cfg.pollIntervalMs); return }
      if (!(await deps.port.ready())) {
        scheduleWake(Math.max(cfg.unavailableRetryMs, deps.port.blockedFor('background')))
        return
      }
      const blockedFor = deps.port.blockedFor('background')
      if (blockedFor > 0) { scheduleWake(blockedFor); return }
      const pulled = deps.queue.pull({ max: 1, leaseMs: cfg.leaseMs })
      const item = pulled.items[0]
      if (!item) {
        scheduleWake(pulled.retryAfterMs !== null ? pulled.retryAfterMs + 50 : cfg.pollIntervalMs)
        return
      }
      const wait = await runItem(item)
      if (wait !== null) { scheduleWake(wait); return }
    }
  }

  const drain = async (): Promise<void> => {
    if (draining) { again = true; return }
    draining = true
    try {
      do {
        again = false
        try { await cycle() } catch (error) { log('cycle failed', { code: codeOf(error) }); scheduleWake(cfg.unavailableRetryMs) }
      } while (again && !stopped)
    } finally {
      draining = false
      const waiters = idleWaiters
      idleWaiters = []
      for (const resolve of waiters) resolve()
    }
  }

  const kick = (): void => {
    if (stopped) return
    void drain()
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      kick()
    },
    stop() {
      if (stopped) return
      stopped = true
      if (wakeTimer !== null) { clock.clearTimeout(wakeTimer); wakeTimer = null; wakeAt = null }
    },
    kick,
    running: () => !stopped,
    counters: () => ({ ...counters }),
    idle: () => new Promise<void>((resolve) => { if (!draining) resolve(); else idleWaiters.push(resolve) })
  }
}
