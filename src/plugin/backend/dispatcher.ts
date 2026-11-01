/**
 * dispatcher.ts — backend 的呼叫入口（設計 v2 §4.5；G-07 改為依命名空間分組的方法）。
 *
 * `LineTodoApi` 的路徑數超過 manifest `backendMethods` 的 32 個上限，所以 manifest 宣告的是「命名空間」一組一個方法
 * （`src/shared/pluginWire.ts` 的 `BACKEND_METHOD_GROUPS`：`db.todos`、`pipeline`、`events`…），由這裡依 `{ path, args }` 路由。規則：
 *
 *   - 方法名稱必須是其中一組，而且必須等於 `backendMethodFor(path)`（`backend.call('db.todos', {path:'settings.update'})` 回 `method_mismatch`），
 *     所以 TeamUQ 的方法 allowlist 對每個命名空間都真的有效；`driver` 不在清單內，Core 在進到 backend 前就會擋掉。
 *   - 路徑只能是**明確列出**的允許清單（不做動態屬性走訪；`__proto__`／`constructor` 之類一律 `path_unknown`）。
 *   - CLI provider／media 開檔存檔等外掛版不提供的路徑，回 `{ok:false, code:'unsupported_in_plugin', route}`。
 *   - 結果一律 in-band envelope（不 throw）。host 對回傳有 64 KiB 上限、單次 call 有 30 s 上限，超過 host 會報錯甚至重啟
 *     整個 backend，所以：
 *       * 回傳超過預算 → 切成字串分段存起來，回 `{chunked, resultId, chunks}`，view 用 `result.chunk` 逐段取回再 JSON.parse。
 *       * 執行超過 soft deadline（預設 20 s）→ 回 `{pending, jobId}`，view 用 `job.poll` 取結果（長時間的 reviewLastDays 等）。
 *   - 另外有幾組內部路徑：`backend.info`、`backend.residency`（背景執行的狀態：Core 的 `context.residency`，畫面端沒有這個 API，所以由 backend 中繼；變動時另發 `residency` 事件）、`review.status`（回顧的進行中／已完成 N/M／可續跑）、`tasks.status`（回顧與補媒體金鑰兩個長任務的狀態，
 *     backend 重新啟動後仍查得到，G-05）、`events.*`（事件長輪詢）、`extract.stats`（待抽取佇列的觀測）、`ai.status`／`ai.options`（AI 整理的狀態與 TeamUQ 的模型清單；
 *     AI 本身在 backend 經 `context.host.ai.complete` 執行，0.2.0 起 view 完全不碰 TeamUQ 的 view 端 AI 橋接，也沒有領取／交回租約的 RPC）、
 *     `media.prepare`（解密圖片寫進 dataDir，回相對路徑給 view 的 `assets.url()`）、`result.chunk`、`job.poll`。
 *     草擬回覆／誤判分析／群組議題分析就是一般的 `db.todos.draftReply`／`db.todos.analyzeNotMine`／`groupTopics.analyze` 路徑，耗時久所以走 settle（超過 soft deadline 轉成 job）。
 */
import { randomBytes } from 'node:crypto'
import type { LineTodoApi } from '../../shared/api'
import { AI_RUN_PATHS, runAs } from './aiProvider'
import type { AiTaskKind } from './aiProvider'
import type { PromptService } from './promptService'
import { PromptError } from '../../shared/promptSettings'
import type { PromptRefinementRequest } from '../../shared/promptSettings'
import type { ExtractQueue } from './extractQueue'
import type { EventHub } from './eventHub'
import type { PluginMedia } from './media'
import type { PluginAvatars } from './avatar'
import type { ReviewCoordinator } from './reviewRun'
import type { LongTaskTracker } from './taskStatus'
import type { Envelope, JsonValue } from './types'
import { BACKEND_LIMITS } from './types'
import { BACKEND_METHOD_GROUPS, backendMethodFor } from '../../shared/pluginWire'
import { describeStatus } from '../../shared/aiStatus'
import type { AiStatus } from '../../shared/aiStatus'
import { RESIDENCY_UNSUPPORTED } from '../../shared/residency'
import type { ResidencySnapshot } from '../../shared/residency'
import type { ReviewLastDaysResult } from '../../shared/api'

/** request/response 型、外掛版支援的 `LineTodoApi` 路徑（`on*` 訂閱走事件通道，不在這裡）。 */
export const SUPPORTED_API_PATHS: readonly string[] = Object.freeze([
  'ping',
  'messages.recent',
  'line.status', 'line.setRunning',
  'db.messages.list', 'db.messages.recentByChat', 'db.messages.byChatSince', 'db.messages.count',
  'db.chats.list', 'db.chats.get', 'db.chats.setBlocked', 'db.chats.blockAndClear', 'db.chats.addIgnoreKeyword', 'db.chats.removeIgnoreKeyword',
  'db.todos.list', 'db.todos.get', 'db.todos.openByChat', 'db.todos.updateStatus', 'db.todos.update', 'db.todos.moveColumn',
  'db.todos.draftReply', 'db.todos.analyzeNotMine', 'groupTopics.analyze',
  'db.todos.identity.listPending', 'db.todos.identity.inspect', 'db.todos.identity.retry', 'db.todos.identity.resolve', 'db.todos.identity.todoTopicRelations', 'db.todos.identity.resolveTodoTopicRelation',
  'db.todos.markNotMine', 'db.todos.listNotMine', 'db.todos.listNotMineCorrections', 'db.todos.getNotMineReview',
  'db.todos.reopenNotMine', 'db.todos.applyNotMineCorrection', 'db.todos.setNotMineCorrectionEnabled',
  'groupTopics.setEnabled', 'groupTopics.setCrossChatEnabled', 'groupTopics.crossChatEnabled', 'groupTopics.pendingCount',
  'groupTopics.list', 'groupTopics.linkCandidates', 'groupTopics.todoRefs', 'groupTopics.linkProposals', 'groupTopics.resolveLinkProposal',
  'pipeline.status', 'pipeline.loadStats', 'pipeline.runOnce', 'pipeline.reviewLastDays', 'pipeline.backfillMediaKeys', 'pipeline.setRunning',
  'settings.get', 'settings.update', 'settings.hasSafeStorageKey'
])

/** 外掛版明確不提供的路徑。 */
export const UNSUPPORTED_API_PATHS: Readonly<Record<string, { route: 'none'; message: string }>> = Object.freeze({
  'db.chats.openOriginal': { route: 'none', message: '外掛版無法開啟 LINE 原始聊天室' },
  'pipeline.testQwen': { route: 'none', message: '外掛版不使用 qwen 端點' },
  'pipeline.testAiProvider': { route: 'none', message: '外掛版的 AI 由 TeamUQ 的 ai:chat 提供（backend 經 host.ai.complete 呼叫）' },
  'settings.setApiKey': { route: 'none', message: '外掛版 backend 不持有 AI 金鑰' },
  'settings.clearApiKey': { route: 'none', message: '外掛版 backend 不持有 AI 金鑰' },
  'app.openDataFolder': { route: 'none', message: '外掛版無法開啟資料夾' },
  'media.open': { route: 'none', message: '外掛版以 assets.url 顯示媒體' },
  'media.saveAs': { route: 'none', message: '外掛版以 UI 端下載取代另存新檔' }
})

const METHOD_GROUPS: ReadonlySet<string> = new Set(BACKEND_METHOD_GROUPS)
const AI_KIND_BY_PATH: ReadonlyMap<string, AiTaskKind> = new Map((Object.entries(AI_RUN_PATHS) as Array<[AiTaskKind, string]>).map(([kind, path]) => [path, kind]))
const PATH_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,31}(\.[A-Za-z][A-Za-z0-9]{0,31}){0,3}$/
const MAX_ARGS = 8
const OWN = Object.prototype.hasOwnProperty

/** dispatcher 看到的 AI 整理：assemble 把 HostAiPort、ExtractWorker 與 ExtractQueue 合成這個形狀。 */
export interface AiRuntime {
  /** 讀好 host 的模型清單並選好供應者（不會 throw）；`force`＝不用快取。回顧開始前用它判斷 AI 能不能用。 */
  ready(force?: boolean): Promise<boolean>
  status(): AiStatus
  /** TeamUQ 的模型清單（設定頁）；失敗時 throw（Error 帶 host 的 `.code`）。 */
  options(): Promise<unknown>
  /** 忘掉快取、重新探測，並叫 worker 看一下有沒有工作（使用者重新開啟看板、授權可能恢復）。 */
  refresh(): void
}

export interface DispatcherOptions {
  /** 目前生效的 api（runtime 的 guarded proxy）；backend 已停止時 throw。 */
  getApi(): LineTodoApi
  hub: EventHub
  queue: ExtractQueue
  /** AI 整理（HostAiPort＋ExtractWorker）的狀態與模型清單（`ai.*`）；省略＝這些路徑回 ai_unavailable，回顧不檢查 AI 狀態（單元測試）。 */
  ai?: AiRuntime
  /** 背景執行的目前狀態（`backend.residency`；residency.ts）。同步讀已知的值，不會去問宿主；省略＝`supported:false`（舊 Core、單元測試）。 */
  residency?: () => ResidencySnapshot
  prompts?: PromptService
  /** 媒體服務（`media.prepare`）；省略＝回 media_unavailable。 */
  media?: PluginMedia
  /** LINE profile/Square avatars; all locators remain backend-only. */
  avatars?: PluginAvatars
  /** 回顧的續跑／single-flight／進度（`pipeline.reviewLastDays`、`review.status`）；省略＝直接呼叫 core（單元測試）。 */
  review?: ReviewCoordinator
  /** 「補媒體金鑰」的 single-flight 與可查詢狀態（`pipeline.backfillMediaKeys`、`tasks.status`）；省略＝直接呼叫 core。 */
  mediaBackfill?: LongTaskTracker
  /** `backend.info` 的內容。 */
  info(): Record<string, JsonValue>
  /** 超過這個時間就把執行中的呼叫轉成 job（必須 < host 的 30 s）。 */
  softDeadlineMs?: number
  /** `ai.status`／`ai.options` 最多等 TeamUQ 的 AI 多久（必須遠小於 host 的 30 s；預設 15 s）。 */
  aiDeadlineMs?: number
  /** 回應 JSON 位元組預算（host 上限 64 KiB，留餘裕）。 */
  responseBudgetBytes?: number
  resultTtlMs?: number
  maxResults?: number
  maxResultBytes?: number
  jobTtlMs?: number
  maxJobs?: number
  maxJobWaitMs?: number
  now?(): number
}

const DEADLINE = Symbol('deadline')
const fail = (code: string, message?: string, route?: string): Envelope => ({ ok: false, code, ...(message ? { message } : {}), ...(route ? { route } : {}) })
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

interface Job {
  id: string
  startedAt: number
  state: 'running' | 'done'
  outcome: { ok: true; value: unknown } | { ok: false; error: unknown } | null
  expiresAt: number
  wake: (() => void) | null
}

interface StoredResult {
  chunks: string[]
  expiresAt: number
  bytes: number
}

export class Dispatcher {
  private readonly opts: DispatcherOptions
  private readonly results = new Map<string, StoredResult>()
  private readonly jobs = new Map<string, Job>()
  private readonly allowed: Set<string>
  private disposed = false

  constructor(opts: DispatcherOptions) {
    this.opts = opts
    this.allowed = new Set(SUPPORTED_API_PATHS)
  }

  private now(): number { return this.opts.now ? this.opts.now() : Date.now() }
  private get softDeadline(): number { return this.opts.softDeadlineMs ?? Math.min(20_000, BACKEND_LIMITS.invokeTimeoutMs - 8_000) }
  /** `ai.status`／`ai.options` 的期限：host 對一次 backend 呼叫的上限是 30 s，同時到期會讓 Core 把整個 backend 隔離（review F1），所以先放棄、回上次已知的狀態。 */
  private get aiDeadline(): number { return this.opts.aiDeadlineMs ?? Math.min(15_000, BACKEND_LIMITS.invokeTimeoutMs - 15_000) }
  private get budget(): number { return this.opts.responseBudgetBytes ?? BACKEND_LIMITS.invokeBytes - 8 * 1024 }

  async call(method: string, params: unknown): Promise<Envelope> {
    if (this.disposed) return fail('backend_stopped', 'backend is stopped')
    if (typeof method !== 'string' || !METHOD_GROUPS.has(method)) return fail('method_unknown', String(method).slice(0, 64))
    if (!plain(params) || typeof params.path !== 'string') return fail('invalid_args', 'params.path is required')
    const path = params.path
    const args = params.args === undefined ? [] : params.args
    if (!Array.isArray(args) || args.length > MAX_ARGS) return fail('invalid_args', `args must be an array of at most ${MAX_ARGS} items`)
    if (!PATH_PATTERN.test(path)) return fail('path_unknown', 'malformed path')
    const group = backendMethodFor(path)
    if (group === null) return fail('path_unknown', path)
    if (group !== method) return fail('method_mismatch', `${path} belongs to ${group}, not ${method}`)

    // 內部路徑
    switch (path) {
      case 'backend.info': return this.finalize(this.opts.info())
      case 'backend.residency': return this.finalize(this.opts.residency ? this.opts.residency() : RESIDENCY_UNSUPPORTED)
      case 'events.open': return this.finalize(lift(this.opts.hub.open(args[0])))
      case 'events.pull': return this.finalize(lift(await this.opts.hub.pull(args[0])))
      case 'events.close': return this.finalize(lift(this.opts.hub.close(args[0])))
      case 'settings.prompt.get': return this.opts.prompts ? this.finalize(this.opts.prompts.state()) : fail('prompt_unavailable')
      case 'settings.prompt.save':
        if (!this.opts.prompts || !plain(args[0])) return fail('invalid_args')
        try { return this.finalize(this.opts.prompts.save(args[0].prompt, args[0].expectedRevision)) } catch (error) { return mapError(error) }
      case 'settings.prompt.reset':
        if (!this.opts.prompts || !plain(args[0])) return fail('invalid_args')
        try { return this.finalize(this.opts.prompts.reset(args[0].expectedRevision)) } catch (error) { return mapError(error) }
      case 'settings.prompt.refine':
        if (!this.opts.prompts || !plain(args[0])) return fail('invalid_args')
        return this.settle(this.opts.prompts.refine(args[0] as unknown as PromptRefinementRequest))
      case 'ai.status': return this.aiStatus(args[0])
      case 'ai.options': return this.aiOptions()
      case 'extract.stats': return this.finalize(this.opts.queue.stats())
      case 'review.status': return this.opts.review ? this.finalize(this.opts.review.status()) : fail('review_unavailable', 'review tracking is not available in this build')
      // 長任務的狀態（G-05）：回顧與補媒體金鑰；backend 重新啟動後由狀態檔讀回（taskStatus.ts、reviewRun.ts）。
      case 'tasks.status': return this.finalize({ review: this.opts.review ? this.opts.review.status() : null, mediaBackfill: this.opts.mediaBackfill ? this.opts.mediaBackfill.status() : null })
      case 'media.prepare': return this.mediaPrepare(args[0])
      case 'media.avatar.prepareChats': return this.opts.avatars ? this.settle(this.opts.avatars.prepareChats(args[0])) : fail('avatar_unavailable')
      case 'media.avatar.prepareMessages': return this.opts.avatars ? this.settle(this.opts.avatars.prepareMessages(args[0], args[1])) : fail('avatar_unavailable')
      case 'result.chunk': return this.chunk(args[0])
      case 'job.poll': return this.pollJob(args[0])
      default: break
    }

    const unsupported = OWN.call(UNSUPPORTED_API_PATHS, path) ? UNSUPPORTED_API_PATHS[path] : null
    if (unsupported) return fail('unsupported_in_plugin', unsupported.message, unsupported.route)
    if (!this.allowed.has(path)) return fail('path_unknown', path)

    let target: ((...a: unknown[]) => unknown) | null
    try { target = resolvePath(this.opts.getApi(), path) } catch (error) { return mapError(error) }
    if (!target) return fail('unavailable', `${path} is not available in this build`)

    const run = target as (...a: unknown[]) => unknown
    // 回顧：同時只跑一個、可續跑、有進度（reviewRun.ts）。
    if (path === 'pipeline.reviewLastDays' && this.opts.review) {
      const review = this.opts.review
      return this.settle(Promise.resolve().then(async () => (await this.reviewGate(args[0])) ?? review.run(args[0], () => run(...args) as Promise<never>)))
    }
    // 補媒體金鑰：同時只跑一個，開始／結束寫狀態檔，UI 重新載入或 backend 重啟後仍可用 `tasks.status` 查到結果。
    if (path === 'pipeline.backfillMediaKeys' && this.opts.mediaBackfill) {
      const tracker = this.opts.mediaBackfill
      return this.settle(Promise.resolve().then(() => tracker.run(
        () => run(...args) as Promise<{ ok?: unknown; scanned?: unknown; mediaBackfilled?: unknown; error?: unknown }>,
        (value) => {
          const scanned = typeof value?.scanned === 'number' ? value.scanned : 0
          const filled = typeof value?.mediaBackfilled === 'number' ? value.mediaBackfilled : 0
          return value?.ok === true
            ? { ok: true, summary: `補媒體金鑰完成：補了 ${filled} 筆（掃描 ${scanned} 則）`, result: { scanned, mediaBackfilled: filled } }
            : { ok: false, summary: `補媒體金鑰失敗：${typeof value?.error === 'string' ? value.error.slice(0, 200) : '未知錯誤'}`, result: { scanned, mediaBackfilled: filled } }
        },
        '補媒體金鑰進行中…'
      )))
    }
    // 草擬回覆／誤判分析／群組議題分析：標上 kind，provider 才知道要不要要求 JSON。
    const kind = AI_KIND_BY_PATH.get(path)
    return this.settle(Promise.resolve().then(() => (kind ? runAs(kind, () => run(...args)) : run(...args))))
  }

  // ── ai.*：AI 整理的狀態與模型清單 ──

  private async aiStatus(raw: unknown): Promise<Envelope> {
    const ai = this.opts.ai
    if (!ai) return fail('ai_unavailable', 'AI is not available in this build')
    // `refresh: true`：看板剛開啟／使用者剛處理完 TeamUQ 那邊的授權或登入，重新探測一次（探測本身有快取，不會洗版）。
    if (plain(raw) && raw.refresh === true) ai.refresh()
    // `ready()` 向 host 問模型清單，host 沒回應時不能陪它等：期限到就回上次已知的狀態（`status()` 是同步的）。
    await this.within(ai.ready(), this.aiDeadline)
    return this.finalize(ai.status())
  }

  private async aiOptions(): Promise<Envelope> {
    const ai = this.opts.ai
    if (!ai) return fail('ai_unavailable', 'AI is not available in this build')
    try {
      const options = await this.within(ai.options(), this.aiDeadline)
      if (options === DEADLINE) return fail('plugin_host_timeout', 'TeamUQ 的 AI 沒有在期限內回應模型清單')
      return this.finalize(options)
    } catch (error) {
      // 失敗碼就是 host 的固定錯誤碼（`not_granted`、`provider_not_ready`…），設定頁依它顯示說明。
      const code = (error as { code?: unknown } | null)?.code
      return fail(typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : 'unavailable')
    }
  }

  /** 回顧開始前：AI 不可用（沒登入、授權被關…）就立刻說明原因，不要排進佇列等 15 分鐘。額度／限流只是暫停，照常排隊。 */
  private async reviewGate(days: unknown): Promise<ReviewLastDaysResult | null> {
    const ai = this.opts.ai
    if (!ai) return null
    await ai.ready(true) // 不信任快取：使用者剛登出 Codex 或關掉授權時，回顧不該先排進佇列再空等
    const status = ai.status()
    if (status.state !== 'unavailable' && status.state !== 'revoked' && status.state !== 'stopped') return null
    return reviewNotConnected(typeof days === 'number' ? days : undefined, describeStatus(status, this.now()))
  }

  private mediaPrepare(raw: unknown): Envelope {
    if (!this.opts.media) return fail('media_unavailable', 'media is not available in this build')
    const result = this.opts.media.prepare(plain(raw) ? raw.msgId : raw)
    return result.ok ? this.finalize(result) : fail(result.code, result.message)
  }

  /** 等 `work` 最多 `ms`：逾時回 DEADLINE（`work` 繼續在背景跑完，結果丟掉）；`work` 失敗照常 throw。 */
  private async within<T>(work: Promise<T>, ms: number): Promise<T | typeof DEADLINE> {
    let timer: NodeJS.Timeout | null = null
    const deadline = new Promise<typeof DEADLINE>((resolve) => { timer = setTimeout(() => resolve(DEADLINE), ms); timer.unref?.() })
    work.catch(() => undefined) // 逾時之後才失敗的工作不能變成 unhandled rejection
    try { return await Promise.race([work, deadline]) } finally { if (timer) clearTimeout(timer) }
  }

  // ── 回應整理 ──

  private async settle(execution: Promise<unknown>): Promise<Envelope> {
    let timer: NodeJS.Timeout | null = null
    const deadline = new Promise<'deadline'>((resolve) => {
      timer = setTimeout(() => resolve('deadline'), this.softDeadline)
      timer.unref?.()
    })
    const outcome = execution.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }))
    try {
      const first = await Promise.race([outcome, deadline])
      if (first !== 'deadline') return first.ok ? this.finalize(first.value) : mapError(first.error)
      return this.startJob(outcome)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private startJob(outcome: Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }>): Envelope {
    this.prune()
    if (this.jobs.size >= (this.opts.maxJobs ?? 32)) return fail('too_many_jobs', 'too many long-running calls')
    const job: Job = { id: randomBytes(12).toString('hex'), startedAt: this.now(), state: 'running', outcome: null, expiresAt: Number.POSITIVE_INFINITY, wake: null }
    this.jobs.set(job.id, job)
    void outcome.then((result) => {
      job.outcome = result
      job.state = 'done'
      job.expiresAt = this.now() + (this.opts.jobTtlMs ?? 10 * 60_000)
      job.wake?.()
    })
    return { ok: true, pending: true, jobId: job.id, ageMs: 0 }
  }

  private async pollJob(raw: unknown): Promise<Envelope> {
    if (!plain(raw) || typeof raw.jobId !== 'string') return fail('invalid_args', 'jobId is required')
    this.prune()
    const found = this.jobs.get(raw.jobId)
    if (!found) return fail('job_not_found', 'the job does not exist or has expired')
    const job: Job = found
    const wait = Math.min(Math.max(0, numberOr(raw.waitMs) ?? 0), this.opts.maxJobWaitMs ?? 4000)
    if (job.state === 'running' && wait > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, wait)
        timer.unref?.()
        function done(): void { clearTimeout(timer); if (job.wake === done) job.wake = null; resolve() }
        job.wake = done
      })
    }
    if (this.disposed) return fail('backend_stopped')
    if (job.state === 'running' || !job.outcome) return { ok: true, pending: true, jobId: job.id, ageMs: this.now() - job.startedAt }
    return job.outcome.ok ? this.finalize(job.outcome.value) : mapError(job.outcome.error)
  }

  private finalize(value: unknown): Envelope {
    if (plain(value) && value.__fail === true) return fail(typeof value.code === 'string' ? value.code : 'api_error', typeof value.message === 'string' ? value.message : undefined)
    let text: string | undefined
    try { text = JSON.stringify(value ?? null) } catch { return fail('not_serializable', 'the result is not JSON-serializable') }
    if (text === undefined) text = 'null'
    const overhead = 24
    if (Buffer.byteLength(text) + overhead <= this.budget) return { ok: true, value: JSON.parse(text) as JsonValue }
    const maxBytes = this.opts.maxResultBytes ?? 8 * 1024 * 1024
    if (Buffer.byteLength(text) > maxBytes) return fail('result_too_large', `result exceeds ${maxBytes} bytes`)
    return this.storeChunks(text)
  }

  private storeChunks(text: string): Envelope {
    const chunks: string[] = []
    let size = 16_000
    for (let i = 0; i < text.length;) {
      let n = size
      let piece = text.slice(i, i + n)
      while (n > 256 && Buffer.byteLength(JSON.stringify({ ok: true, index: 0, last: false, data: piece })) > this.budget) {
        n = Math.floor(n / 2)
        piece = text.slice(i, i + n)
      }
      chunks.push(piece)
      i += piece.length
      size = Math.max(n, 2048) // 下一段從剛剛成功的大小開始，避免每段都重新縮
    }
    this.prune()
    const resultId = randomBytes(12).toString('hex')
    this.results.set(resultId, { chunks, expiresAt: this.now() + (this.opts.resultTtlMs ?? 60_000), bytes: Buffer.byteLength(text) })
    return { ok: true, chunked: true, resultId, chunks: chunks.length, bytes: Buffer.byteLength(text) }
  }

  private chunk(raw: unknown): Envelope {
    if (!plain(raw) || typeof raw.resultId !== 'string' || typeof raw.index !== 'number') return fail('invalid_args', 'resultId and index are required')
    this.prune()
    const stored = this.results.get(raw.resultId)
    if (!stored) return fail('result_expired', 'the result is no longer available')
    const index = Math.floor(raw.index)
    if (!(index >= 0 && index < stored.chunks.length)) return fail('invalid_args', 'chunk index out of range')
    stored.expiresAt = this.now() + (this.opts.resultTtlMs ?? 60_000)
    return { ok: true, value: { index, last: index === stored.chunks.length - 1, data: stored.chunks[index] } }
  }

  /** 惰性清理（不用 timer，deactivate 後不留 handle）。 */
  private prune(): void {
    const now = this.now()
    for (const [id, r] of this.results) if (r.expiresAt <= now) this.results.delete(id)
    const cap = this.opts.maxResults ?? 16
    while (this.results.size > cap) this.results.delete(this.results.keys().next().value as string)
    for (const [id, j] of this.jobs) if (j.state === 'done' && j.expiresAt <= now) this.jobs.delete(id)
  }

  stats(): { jobs: number; results: number } {
    this.prune()
    return { jobs: this.jobs.size, results: this.results.size }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const job of this.jobs.values()) job.wake?.()
    this.jobs.clear()
    this.results.clear()
  }
}

/** 內部元件（hub／queue）回 `{ok:true,...}`／`{ok:false,code}`：失敗直接當 envelope，成功拿掉冗餘的 ok 當 value。 */
function lift(result: unknown): unknown {
  if (plain(result) && typeof result.ok === 'boolean') {
    const { ok, ...rest } = result
    if (!ok) return { __fail: true, ...rest }
    return rest
  }
  return result
}

/** AI 不可用時 `pipeline.reviewLastDays` 的失敗結果（與 0.1.x 在 view 端組的形狀相同）。 */
function reviewNotConnected(days: number | undefined, note: string): ReviewLastDaysResult {
  const window = typeof days === 'number' && days > 0 ? Math.floor(days) : 7
  return {
    ok: false, hasApiKey: true, days: window, sinceMs: Date.now() - window * 86_400_000, newMsgs: 0, chatsSeen: 0, chatsProcessed: 0, chatsSkippedNoise: 0,
    chatsFailed: 0, todosCreated: 0, todosMerged: 0, todosResolvedDone: 0, todosSuggestedDone: 0, createdIds: [], resolvedIds: [], updatedIds: [], note
  }
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function resolvePath(api: LineTodoApi, path: string): ((...args: unknown[]) => unknown) | null {
  let node: unknown = api
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object' || !OWN.call(node, key)) return null
    node = (node as Record<string, unknown>)[key]
  }
  return typeof node === 'function' ? (node as (...args: unknown[]) => unknown) : null
}

function mapError(error: unknown): Envelope {
  if (error instanceof PromptError) return fail(error.code, error.message)
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 300)
  if (/runtime is (stopped|disposed|created)/i.test(message)) return fail('runtime_not_running', message)
  return fail('api_error', message)
}
