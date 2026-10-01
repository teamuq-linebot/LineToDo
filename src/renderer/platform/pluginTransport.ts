/**
 * pluginTransport.ts — 外掛 view 與 backend 之間的請求傳輸（`window.tuqPlugin.backend.call('api.invoke', ...)`）。
 *
 * 只描述 TeamUQ 1.6.8 view bridge 與 backend dispatcher（`src/plugin/backend/dispatcher.ts`）的線上格式，不碰 React／DOM：
 *   - host：`backend.call(method, params)` 把 params 驗成 JSON（陣列 ≤ 4096、數字必須有限、不能有 undefined），請求／回應各 ≤ 64 KiB，
 *     同時進行中 ≤ 8，單次 ≤ 30 s；失敗時 reject `Error(<固定錯誤碼>)`（`pluginViewBridge.ts:89-95`）。
 *   - backend envelope：`{ok:true,value}`／`{ok:true,pending,jobId}`／`{ok:true,chunked,resultId,chunks}`／`{ok:false,code,message?,route?}`。
 *     pending 用 `job.poll` 收（長時間的 reviewLastDays）；chunked 用 `result.chunk` 逐段取回再 JSON.parse（結果超過 64 KiB）。
 *
 * 同時進行的一般請求上限預設 6（host 上限 8，留 1 給事件長輪詢、1 給餘裕），超過的排隊，不會被 host 以 in-flight 超限拒絕。
 */

/** `window.tuqPlugin` 中本外掛用到的部分（其餘能力，例如 ai／presentation，由 Phase 4 的 orchestrator 自己取用）。 */
export interface TuqPluginHost {
  backend: { call(method: string, params: unknown): Promise<unknown> }
  assets: { url(path: string): string }
}

export class PluginApiError extends Error {
  readonly code: string
  readonly path: string
  readonly route: string | undefined
  constructor(code: string, path: string, message?: string, route?: string) {
    super(message ? `${code}: ${message}` : code)
    this.name = 'PluginApiError'
    this.code = code
    this.path = path
    this.route = route
  }
}

/** backend 明確表示「外掛版不提供這個功能」（`unsupported_in_plugin`）。`route:'ui_ai_chat'` 表示改由 UI 端的 ai:chat 完成。 */
export class PluginUnsupportedError extends PluginApiError {
  readonly detail: string
  constructor(path: string, detail: string, route?: string) {
    super('unsupported_in_plugin', path, detail, route)
    this.name = 'PluginUnsupportedError'
    this.detail = detail
  }
}

/** host 層級的失敗（backend 沒起來／當掉／逾時／權限…）：訊息就是 host 的固定錯誤碼。 */
export class PluginBackendError extends PluginApiError {
  constructor(path: string, hostCode: string) {
    super(hostCode, path)
    this.name = 'PluginBackendError'
  }
}

/** host 對單一請求的位元組上限是 64 KiB；留一點餘裕給 envelope。 */
export const MAX_REQUEST_BYTES = 60 * 1024
const MAX_ARGS = 8

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 轉成 host 接受的純 JSON：尾端的 undefined 參數拿掉（`recentByChat(id, undefined)` 不能變成 null），其餘經 JSON 往返。 */
export function toWire(path: string, args: readonly unknown[]): { path: string; args: unknown[] } {
  const list = [...args]
  while (list.length > 0 && list[list.length - 1] === undefined) list.pop()
  if (list.length > MAX_ARGS) throw new PluginApiError('invalid_args', path, `at most ${MAX_ARGS} arguments`)
  let text: string | undefined
  try { text = JSON.stringify({ path, args: list }) } catch { text = undefined }
  if (text === undefined) throw new PluginApiError('invalid_args', path, 'arguments are not JSON-serializable')
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) throw new PluginApiError('request_too_large', path, `request exceeds ${MAX_REQUEST_BYTES} bytes`)
  return JSON.parse(text) as { path: string; args: unknown[] }
}

/** 先進先出的併發上限。 */
export class Limiter {
  private active = 0
  private readonly waiting: Array<() => void> = []
  private readonly max: number
  constructor(max: number) { this.max = Math.max(1, Math.floor(max)) }
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve))
    else this.active += 1 // 排隊者由前一個結束者「接棒」（active 不變），所以只有直接進場的人要自己加
    try {
      return await task()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.active -= 1
    }
  }
  stats(): { active: number; waiting: number } { return { active: this.active, waiting: this.waiting.length } }
}

export interface TransportOptions {
  host: TuqPluginHost
  maxConcurrentCalls?: number
  /** `job.poll` 每次最久等多久（backend 上限 4 s）。 */
  jobPollWaitMs?: number
}

export class PluginTransport {
  private readonly host: TuqPluginHost
  private readonly limiter: Limiter
  private readonly jobWaitMs: number
  private closed = false

  constructor(options: TransportOptions) {
    this.host = options.host
    this.limiter = new Limiter(options.maxConcurrentCalls ?? 6)
    this.jobWaitMs = Math.min(4000, Math.max(0, options.jobPollWaitMs ?? 3000))
  }

  close(): void { this.closed = true }
  get isClosed(): boolean { return this.closed }
  stats(): { active: number; waiting: number } { return this.limiter.stats() }

  /** 一般請求：佔用一個併發名額，直到結果（含 job 輪詢、分段取回）完整為止。 */
  invoke(path: string, args: readonly unknown[] = []): Promise<unknown> {
    if (this.closed) return Promise.reject(new PluginApiError('disposed', path, 'the plugin API was disposed'))
    return this.limiter.run(async () => this.unwrap(path, await this.envelope(path, args)))
  }

  /** 不經併發限制的請求（事件長輪詢自己是一條獨立的迴圈）。 */
  invokeUnlimited(path: string, args: readonly unknown[] = []): Promise<unknown> {
    if (this.closed) return Promise.reject(new PluginApiError('disposed', path, 'the plugin API was disposed'))
    return this.envelope(path, args).then((env) => this.unwrap(path, env))
  }

  private async envelope(path: string, args: readonly unknown[]): Promise<unknown> {
    const wire = toWire(path, args)
    try {
      return await this.host.backend.call('api.invoke', wire)
    } catch (error) {
      throw new PluginBackendError(path, error instanceof Error && error.message ? error.message.slice(0, 80) : 'backend_call_failed')
    }
  }

  private failure(path: string, env: Record<string, unknown>): PluginApiError {
    const code = typeof env.code === 'string' ? env.code : 'api_error'
    const message = typeof env.message === 'string' ? env.message : undefined
    const route = typeof env.route === 'string' ? env.route : undefined
    return code === 'unsupported_in_plugin' ? new PluginUnsupportedError(path, message ?? '', route) : new PluginApiError(code, path, message, route)
  }

  private async unwrap(path: string, first: unknown): Promise<unknown> {
    let env = first
    for (;;) {
      if (!isRecord(env) || typeof env.ok !== 'boolean') throw new PluginApiError('bad_response', path, 'the backend answered with something that is not an envelope')
      if (env.ok === false) throw this.failure(path, env)
      if (env.pending === true && typeof env.jobId === 'string') {
        if (this.closed) throw new PluginApiError('disposed', path, 'the plugin API was disposed')
        env = await this.envelope('job.poll', [{ jobId: env.jobId, waitMs: this.jobWaitMs }])
        continue
      }
      if (env.chunked === true && typeof env.resultId === 'string' && typeof env.chunks === 'number') return this.readChunks(path, env.resultId, env.chunks)
      return env.value
    }
  }

  private async readChunks(path: string, resultId: string, count: number): Promise<unknown> {
    const parts: string[] = []
    for (let index = 0; index < count; index += 1) {
      if (this.closed) throw new PluginApiError('disposed', path, 'the plugin API was disposed')
      const env = await this.envelope('result.chunk', [{ resultId, index }])
      if (!isRecord(env) || env.ok !== true || !isRecord(env.value) || typeof env.value.data !== 'string') {
        throw isRecord(env) && env.ok === false ? this.failure(path, env) : new PluginApiError('bad_response', path, 'malformed result chunk')
      }
      parts.push(env.value.data)
    }
    try { return JSON.parse(parts.join('')) } catch { throw new PluginApiError('bad_response', path, 'the reassembled result is not valid JSON') }
  }
}
