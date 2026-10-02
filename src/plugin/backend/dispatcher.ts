/**
 * dispatcher.ts — backend 的呼叫入口（設計 v2 §4.5；G-07 改為依命名空間分組的方法）。
 *
 * `LineTodoApi` 的路徑數超過 manifest `backendMethods` 的 32 個上限，所以 manifest 宣告的是「命名空間」一組一個方法
 * （`src/shared/pluginWire.ts` 的 `BACKEND_METHOD_GROUPS`：`db.todos`、`pipeline`、`events`…），由這裡依 `{ path, args }` 路由。規則：
 *
 *   - 方法名稱必須是其中一組，而且必須等於 `backendMethodFor(path)`（`backend.call('db.todos', {path:'settings.update'})` 回 `method_mismatch`），
 *     所以 TeamUQ 的方法 allowlist 對每個命名空間都真的有效；`driver` 不在清單內，Core 在進到 backend 前就會擋掉。
 *   - 路徑只能是**明確列出**的允許清單（不做動態屬性走訪；`__proto__`／`constructor` 之類一律 `path_unknown`）。
 *   - CLI provider／media 開檔存檔／AI 呼叫等外掛版不提供的路徑，回 `{ok:false, code:'unsupported_in_plugin', route}`，
 *     `route:'ui_ai_chat'` 表示「這件事由 UI 端經 ai:chat 完成」。
 *   - 結果一律 in-band envelope（不 throw）。host 對回傳有 64 KiB 上限、單次 call 有 30 s 上限，超過 host 會報錯甚至重啟
 *     整個 backend，所以：
 *       * 回傳超過預算 → 切成字串分段存起來，回 `{chunked, resultId, chunks}`，view 用 `result.chunk` 逐段取回再 JSON.parse。
 *       * 執行超過 soft deadline（預設 20 s）→ 回 `{pending, jobId}`，view 用 `job.poll` 取結果（長時間的 reviewLastDays 等）。
 *   - 另外有九組內部路徑：`backend.info`、`review.status`（回顧的進行中／已完成 N/M／可續跑）、`tasks.status`（回顧與補媒體金鑰兩個長任務的狀態，
 *     backend 重新啟動後仍查得到，G-05）、`events.*`（事件長輪詢）、`extract.*`（AI 抽取供料／收料／還租約）、`ai.*`（UI 中轉的單次 AI 呼叫：
 *     `ai.run` 由 UI 發起草擬回覆／誤判分析／群組議題分析，`ai.pull`／`ai.commit`／`ai.release` 是 UI orchestrator 領取並交回 ai:chat 的文字）、
 *     `media.prepare`（解密圖片寫進 dataDir，回相對路徑給 view 的 `assets.url()`）、`result.chunk`、`job.poll`。
 */
import { randomBytes } from 'node:crypto'
import type { LineTodoApi } from '../../shared/api'
import { EXTRACT_SYSTEM_PROMPT } from '../../main/llm/extractPrompt'
import { EXTRACT_OUTPUT_CONTRACT } from './aiOutputContract'
import type { AiTaskKind, AiTaskQueue } from './aiTaskQueue'
import { AI_RUN_PATHS } from './aiTaskQueue'
import type { ExtractQueue } from './extractQueue'
import { DEFAULT_MAX_USER_CHARS, EXTRACT_SYSTEM_SHA256 } from './extractQueue'
import type { EventHub } from './eventHub'
import type { PluginMedia } from './media'
import type { ReviewCoordinator } from './reviewRun'
import type { LongTaskTracker } from './taskStatus'
import type { Envelope, JsonValue } from './types'
import { BACKEND_LIMITS } from './types'
import { BACKEND_METHOD_GROUPS, backendMethodFor } from '../../shared/pluginWire'

/** request/response 型、外掛版支援的 `LineTodoApi` 路徑（`on*` 訂閱走事件通道，不在這裡）。 */
export const SUPPORTED_API_PATHS: readonly string[] = Object.freeze([
  'ping',
  'messages.recent',
  'line.status', 'line.setRunning',
  'db.messages.list', 'db.messages.recentByChat', 'db.messages.byChatSince', 'db.messages.count',
  'db.chats.list', 'db.chats.get', 'db.chats.setBlocked', 'db.chats.blockAndClear', 'db.chats.addIgnoreKeyword', 'db.chats.removeIgnoreKeyword',
  'db.todos.list', 'db.todos.get', 'db.todos.openByChat', 'db.todos.updateStatus', 'db.todos.update', 'db.todos.moveColumn',
  'db.todos.markNotMine', 'db.todos.listNotMine', 'db.todos.listNotMineCorrections', 'db.todos.getNotMineReview',
  'db.todos.reopenNotMine', 'db.todos.applyNotMineCorrection', 'db.todos.setNotMineCorrectionEnabled',
  'groupTopics.setEnabled', 'groupTopics.setCrossChatEnabled', 'groupTopics.crossChatEnabled', 'groupTopics.pendingCount',
  'groupTopics.list', 'groupTopics.linkCandidates', 'groupTopics.todoRefs',
  'pipeline.status', 'pipeline.loadStats', 'pipeline.runOnce', 'pipeline.reviewLastDays', 'pipeline.backfillMediaKeys', 'pipeline.setRunning',
  'settings.get', 'settings.update', 'settings.hasSafeStorageKey'
])

/** 外掛版明確不提供（或改由 UI 端完成）的路徑。 */
export const UNSUPPORTED_API_PATHS: Readonly<Record<string, { route: 'ui_ai_chat' | 'none'; message: string }>> = Object.freeze({
  'db.todos.draftReply': { route: 'ui_ai_chat', message: '草擬回覆由 UI 端經 ai:chat 完成（backend 不打 LLM）' },
  'db.todos.analyzeNotMine': { route: 'ui_ai_chat', message: '誤判分析由 UI 端經 ai:chat 完成（backend 不打 LLM）' },
  'groupTopics.analyze': { route: 'ui_ai_chat', message: '群組話題分析由 UI 端經 ai:chat 完成（backend 不打 LLM）' },
  'db.chats.openOriginal': { route: 'none', message: '外掛版無法開啟 LINE 原始聊天室' },
  'pipeline.testQwen': { route: 'none', message: '外掛版不使用 qwen 端點' },
  'pipeline.testAiProvider': { route: 'none', message: '外掛版的 AI 由 TeamUQ 的 ai:chat 提供' },
  'settings.setApiKey': { route: 'none', message: '外掛版 backend 不持有 AI 金鑰' },
  'settings.clearApiKey': { route: 'none', message: '外掛版 backend 不持有 AI 金鑰' },
  'app.openDataFolder': { route: 'none', message: '外掛版無法開啟資料夾' },
  'media.open': { route: 'none', message: '外掛版以 assets.url 顯示媒體' },
  'media.saveAs': { route: 'none', message: '外掛版以 UI 端下載取代另存新檔' }
})

const METHOD_GROUPS: ReadonlySet<string> = new Set(BACKEND_METHOD_GROUPS)
const PATH_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,31}(\.[A-Za-z][A-Za-z0-9]{0,31}){0,3}$/
const MAX_ARGS = 8
const OWN = Object.prototype.hasOwnProperty

export interface DispatcherOptions {
  /** 目前生效的 api（runtime 的 guarded proxy）；backend 已停止時 throw。 */
  getApi(): LineTodoApi
  hub: EventHub
  queue: ExtractQueue
  /** UI 中轉的單次 AI 呼叫（`ai.*`）；省略＝這些路徑回 ai_bridge_unavailable。 */
  aiTasks?: AiTaskQueue
  /** 媒體服務（`media.prepare`）；省略＝回 media_unavailable。 */
  media?: PluginMedia
  /** 回顧的續跑／single-flight／進度（`pipeline.reviewLastDays`、`review.status`）；省略＝直接呼叫 core（單元測試）。 */
  review?: ReviewCoordinator
  /** 「補媒體金鑰」的 single-flight 與可查詢狀態（`pipeline.backfillMediaKeys`、`tasks.status`）；省略＝直接呼叫 core。 */
  mediaBackfill?: LongTaskTracker
  /** `backend.info` 的內容。 */
  info(): Record<string, JsonValue>
  /** 超過這個時間就把執行中的呼叫轉成 job（必須 < host 的 30 s）。 */
  softDeadlineMs?: number
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
      case 'events.open': return this.finalize(lift(this.opts.hub.open(args[0])))
      case 'events.pull': return this.finalize(lift(await this.opts.hub.pull(args[0])))
      case 'events.close': return this.finalize(lift(this.opts.hub.close(args[0])))
      case 'extract.system':
        // `format`：ai:chat 沒有 structured output，UI 要把它接在 system 後面（EXTRACT_SYSTEM_PROMPT 只描述規則、沒有附 schema）。
        return this.finalize({ system: EXTRACT_SYSTEM_PROMPT, sha256: EXTRACT_SYSTEM_SHA256, chars: EXTRACT_SYSTEM_PROMPT.length, maxUserChars: DEFAULT_MAX_USER_CHARS, format: EXTRACT_OUTPUT_CONTRACT })
      case 'extract.pull':
        this.opts.aiTasks?.touch()
        return this.finalize(lift(this.opts.queue.pull(plain(args[0]) ? { max: numberOr(args[0].max), leaseMs: numberOr(args[0].leaseMs) } : {})))
      case 'extract.release': {
        const body = args[0]
        if (!plain(body) || !Array.isArray(body.itemIds) || body.itemIds.length === 0 || body.itemIds.length > 16 || !body.itemIds.every((id) => typeof id === 'string')) return fail('invalid_args', 'itemIds must be an array of 1..16 strings')
        return this.finalize(lift(this.opts.queue.release({ itemIds: body.itemIds as string[] })))
      }
      case 'ai.pull': return this.aiPull(args[0])
      case 'ai.commit': return this.aiCommit(args[0])
      case 'ai.release': return this.aiRelease(args[0])
      case 'ai.run': return this.aiRun(args[0])
      case 'extract.commit': {
        const body = args[0]
        if (!plain(body) || !Array.isArray(body.results) || body.results.length === 0 || body.results.length > 16) return fail('invalid_args', 'results must be an array of 1..16 items')
        return this.finalize(lift(this.opts.queue.commit({ results: body.results as never })))
      }
      case 'extract.stats': return this.finalize(this.opts.queue.stats())
      case 'review.status': return this.opts.review ? this.finalize(this.opts.review.status()) : fail('review_unavailable', 'review tracking is not available in this build')
      // 長任務的狀態（G-05）：回顧與補媒體金鑰；backend 重新啟動後由狀態檔讀回（taskStatus.ts、reviewRun.ts）。
      case 'tasks.status': return this.finalize({ review: this.opts.review ? this.opts.review.status() : null, mediaBackfill: this.opts.mediaBackfill ? this.opts.mediaBackfill.status() : null })
      case 'media.prepare': return this.mediaPrepare(args[0])
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
      return this.settle(Promise.resolve().then(() => review.run(args[0], () => run(...args) as Promise<never>)))
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
    return this.settle(Promise.resolve().then(() => run(...args)))
  }

  // ── ai.*：UI 中轉的單次 AI 呼叫 ──

  private aiPull(raw: unknown): Envelope {
    const tasks = this.opts.aiTasks
    if (!tasks) return fail('ai_bridge_unavailable', 'the AI bridge is not available in this build')
    return this.finalize(lift(tasks.pull(plain(raw) ? { max: numberOr(raw.max), leaseMs: numberOr(raw.leaseMs) } : {})))
  }

  private aiCommit(raw: unknown): Envelope {
    const tasks = this.opts.aiTasks
    if (!tasks) return fail('ai_bridge_unavailable', 'the AI bridge is not available in this build')
    if (!plain(raw) || !Array.isArray(raw.results) || raw.results.length === 0 || raw.results.length > 4) return fail('invalid_args', 'results must be an array of 1..4 items')
    return this.finalize(lift(tasks.commit({ results: raw.results as never })))
  }

  private aiRelease(raw: unknown): Envelope {
    const tasks = this.opts.aiTasks
    if (!tasks) return fail('ai_bridge_unavailable', 'the AI bridge is not available in this build')
    if (!plain(raw) || !Array.isArray(raw.taskIds) || raw.taskIds.length === 0 || raw.taskIds.length > 4 || !raw.taskIds.every((id) => typeof id === 'string')) return fail('invalid_args', 'taskIds must be an array of 1..4 strings')
    return this.finalize(lift(tasks.release({ taskIds: raw.taskIds as string[] })))
  }

  /**
   * UI 發起「草擬回覆／誤判分析／群組議題分析」：照 standalone 的邏輯在 backend 跑（取證據、驗證、落庫都沿用 core），
   * 只有「模型輸出」那一步經 `AiTaskQueue` 交給 UI 的 ai:chat。耗時久，所以走 settle（超過 soft deadline 轉成 job）。
   */
  private async aiRun(raw: unknown): Promise<Envelope> {
    const tasks = this.opts.aiTasks
    if (!tasks) return fail('ai_bridge_unavailable', 'the AI bridge is not available in this build')
    if (!plain(raw) || typeof raw.kind !== 'string' || !OWN.call(AI_RUN_PATHS, raw.kind)) return fail('invalid_args', 'kind must be draftReply, analyzeNotMine or groupTopics')
    const kind = raw.kind as Exclude<AiTaskKind, 'unknown'>
    const runArgs = raw.args === undefined ? [] : raw.args
    if (!Array.isArray(runArgs) || runArgs.length > 4) return fail('invalid_args', 'args must be an array of at most 4 items')
    let target: ((...a: unknown[]) => unknown) | null
    try { target = resolvePath(this.opts.getApi(), AI_RUN_PATHS[kind]) } catch (error) { return mapError(error) }
    if (!target) return fail('unavailable', `${AI_RUN_PATHS[kind]} is not available in this build`)
    const run = target
    return this.settle(Promise.resolve().then(() => tasks.runAs(kind, () => run(...runArgs))))
  }

  private mediaPrepare(raw: unknown): Envelope {
    if (!this.opts.media) return fail('media_unavailable', 'media is not available in this build')
    const result = this.opts.media.prepare(plain(raw) ? raw.msgId : raw)
    return result.ok ? this.finalize(result) : fail(result.code, result.message)
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
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 300)
  if (/runtime is (stopped|disposed|created)/i.test(message)) return fail('runtime_not_running', message)
  return fail('api_error', message)
}
