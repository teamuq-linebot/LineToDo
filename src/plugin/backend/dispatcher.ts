/**
 * dispatcher.ts — `api.invoke` 單一入口（設計 v2 §4.5）。
 *
 * `LineTodoApi` 的方法數超過 manifest `backendMethods` 的 32 個上限，所以 manifest 只宣告 `api.invoke`，
 * 由這裡依 `{ path, args }` 路由。規則：
 *
 *   - 路徑只能是**明確列出**的允許清單（不做動態屬性走訪；`__proto__`／`constructor` 之類一律 `path_unknown`）。
 *   - driver／CLI provider／media 開檔存檔／AI 呼叫等外掛版不提供的路徑，回 `{ok:false, code:'unsupported_in_plugin', route}`，
 *     `route:'ui_ai_chat'` 表示「這件事由 UI 端經 ai:chat 完成」。
 *   - 結果一律 in-band envelope（不 throw）。host 對回傳有 64 KiB 上限、單次 call 有 30 s 上限，超過 host 會報錯甚至重啟
 *     整個 backend，所以：
 *       * 回傳超過預算 → 切成字串分段存起來，回 `{chunked, resultId, chunks}`，view 用 `result.chunk` 逐段取回再 JSON.parse。
 *       * 執行超過 soft deadline（預設 20 s）→ 回 `{pending, jobId}`，view 用 `job.poll` 取結果（長時間的 reviewLastDays 等）。
 *   - 另外有五組內部路徑：`backend.info`、`events.*`（事件長輪詢）、`extract.*`（AI 抽取供料／收料）、`result.chunk`、`job.poll`。
 */
import { randomBytes } from 'node:crypto'
import type { LineTodoApi } from '../../shared/api'
import { EXTRACT_SYSTEM_PROMPT } from '../../main/llm/extractPrompt'
import type { ExtractQueue } from './extractQueue'
import { DEFAULT_MAX_USER_CHARS, EXTRACT_SYSTEM_SHA256 } from './extractQueue'
import type { EventHub } from './eventHub'
import type { Envelope, JsonValue } from './types'
import { BACKEND_LIMITS } from './types'

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

const PATH_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,31}(\.[A-Za-z][A-Za-z0-9]{0,31}){0,3}$/
const MAX_ARGS = 8
const OWN = Object.prototype.hasOwnProperty

export interface DispatcherOptions {
  /** 目前生效的 api（runtime 的 guarded proxy）；backend 已停止時 throw。 */
  getApi(): LineTodoApi
  hub: EventHub
  queue: ExtractQueue
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
    if (method !== 'api.invoke') return fail('method_unknown', String(method).slice(0, 64))
    if (!plain(params) || typeof params.path !== 'string') return fail('invalid_args', 'params.path is required')
    const path = params.path
    const args = params.args === undefined ? [] : params.args
    if (!Array.isArray(args) || args.length > MAX_ARGS) return fail('invalid_args', `args must be an array of at most ${MAX_ARGS} items`)
    if (!PATH_PATTERN.test(path)) return fail('path_unknown', 'malformed path')

    // 內部路徑
    switch (path) {
      case 'backend.info': return this.finalize(this.opts.info())
      case 'events.open': return this.finalize(lift(this.opts.hub.open(args[0])))
      case 'events.pull': return this.finalize(lift(await this.opts.hub.pull(args[0])))
      case 'events.close': return this.finalize(lift(this.opts.hub.close(args[0])))
      case 'extract.system': return this.finalize({ system: EXTRACT_SYSTEM_PROMPT, sha256: EXTRACT_SYSTEM_SHA256, chars: EXTRACT_SYSTEM_PROMPT.length, maxUserChars: DEFAULT_MAX_USER_CHARS })
      case 'extract.pull': return this.finalize(lift(this.opts.queue.pull(plain(args[0]) ? { max: numberOr(args[0].max), leaseMs: numberOr(args[0].leaseMs) } : {})))
      case 'extract.commit': {
        const body = args[0]
        if (!plain(body) || !Array.isArray(body.results) || body.results.length === 0 || body.results.length > 16) return fail('invalid_args', 'results must be an array of 1..16 items')
        return this.finalize(lift(this.opts.queue.commit({ results: body.results as never })))
      }
      case 'extract.stats': return this.finalize(this.opts.queue.stats())
      case 'result.chunk': return this.chunk(args[0])
      case 'job.poll': return this.pollJob(args[0])
      default: break
    }

    const unsupported = (OWN.call(UNSUPPORTED_API_PATHS, path) ? UNSUPPORTED_API_PATHS[path] : null) ?? (path.startsWith('driver.') ? { route: 'none' as const, message: '外掛版不提供「填入 LINE」（driver_post）' } : null)
    if (unsupported) return fail('unsupported_in_plugin', unsupported.message, unsupported.route)
    if (!this.allowed.has(path)) return fail('path_unknown', path)

    let target: ((...a: unknown[]) => unknown) | null
    try { target = resolvePath(this.opts.getApi(), path) } catch (error) { return mapError(error) }
    if (!target) return fail('unavailable', `${path} is not available in this build`)

    return this.settle(Promise.resolve().then(() => (target as (...a: unknown[]) => unknown)(...args)))
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
