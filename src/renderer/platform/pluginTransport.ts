/**
 * pluginTransport.ts — 外掛 view 與 backend 之間的請求傳輸（`window.tuqPlugin.backend.call(<方法組>, { path, args })`）。
 *
 * 方法名稱（G-07）：manifest 的 `backendMethods` 是命名空間分組（`src/shared/pluginWire.ts` 的 `BACKEND_METHOD_GROUPS`），
 * 每次呼叫用 `backendMethodFor(path)` 選出所屬的組；不屬於任何一組的路徑在 view 端就以 `path_unknown` 拒絕，不送給 host。
 *
 * 連線狀態（G-03）：每次 host 呼叫的結果決定 `link()`——成功＝`ok`；`plugin_permission_denied`／`plugin_disabled`／`plugin_not_installed`
 * ＝`revoked`（使用者在 TeamUQ 撤銷了 backend:invoke、停用或移除了外掛；Core 會把 backend 停掉，重試沒有用）；backend 沒起來／當掉／逾時
 * ＝`unavailable`。畫面用 `onLink()` 顯示明確的原因，而不是空白看板。
 *
 * 只描述 TeamUQ 1.6.8 view bridge 與 backend dispatcher（`src/plugin/backend/dispatcher.ts`）的線上格式，不碰 React／DOM：
 *   - host：`backend.call(method, params)` 把 params 驗成 JSON（陣列 ≤ 4096、數字必須有限、不能有 undefined），請求／回應各 ≤ 64 KiB，
 *     view 同時進行中 ≤ 8，單次 ≤ 30 s；失敗時 reject `Error(<固定錯誤碼>)`（`pluginViewBridge.ts:89-95`）。
 *   - backend controller：同時處理的呼叫數 ≤ manifest 的 `resources.maxSessions`（本外掛 4；`backendController.ts:395`），超過回 `plugin_backend_busy`，
 *     而 1.6.8 的 invoke gate 會把它對 view 轉成 `plugin_backend_unavailable`（`backendInvokeGate.ts:156-160`），所以 view 分不出「忙」與「真的不可用」。
 *   - backend envelope：`{ok:true,value}`／`{ok:true,pending,jobId}`／`{ok:true,chunked,resultId,chunks}`／`{ok:false,code,message?,route?}`。
 *     pending 用 `job.poll` 收（長時間的 reviewLastDays）；chunked 用 `result.chunk` 逐段取回再 JSON.parse（結果超過 64 KiB）。
 *
 * 併發預算（review F1）：一個 view 的所有 host 呼叫（一般請求、job.poll、result.chunk，以及事件長輪詢 `events.*`）共用同一個上限
 * `maxConcurrentCalls`，預設 3＝長輪詢 1 ＋ 其他 2；設定 view 只用 1（而且不開事件輪詢）。兩個 view 同時開著：3 ＋ 1 ＝ 4 ＝ `maxSessions`。
 * 上限針對「每一次 host 呼叫」而不是整個請求：job.poll 的每一輪等待結束就把名額還給排隊中的其他請求，長時間的回顧不會獨佔名額。
 * 即使如此 TeamUQ 自己的診斷呼叫、或另一個 view 仍可能讓 host 回忙碌：`plugin_backend_busy`／`plugin_backend_unavailable` 會以 100 ms 起的指數退避重試
 * （最多 4 次，名額在等待期間是釋放的），超過才 reject。
 */

import { MAX_REQUEST_BYTES, backendMethodFor } from '../../shared/pluginWire'

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
  /** 使用者撤銷了 backend:invoke、停用或移除了外掛（重試不會好，要使用者在 TeamUQ 處理）。 */
  get accessDenied(): boolean { return ACCESS_HOST_CODES.has(this.code) }
}

/** host 對「這個外掛不能用 backend」的說法：撤銷 backend:invoke（`backendInvokeGate.ts` 的 revoke）、外掛停用、外掛已移除。 */
export const ACCESS_HOST_CODES: ReadonlySet<string> = new Set(['plugin_permission_denied', 'plugin_disabled', 'plugin_not_installed'])
/** host 對「backend 暫時不能用」的說法（沒起來、忙、當掉、逾時被重啟）。 */
export const UNAVAILABLE_HOST_CODES: ReadonlySet<string> = new Set(['plugin_backend_unavailable', 'plugin_backend_busy', 'plugin_backend_crashed', 'backend_invoke_timeout', 'backend_call_failed'])

export type BackendLinkState = 'unknown' | 'ok' | 'revoked' | 'unavailable'
export interface BackendLink {
  state: BackendLinkState
  /** 最近一次失敗的 host 錯誤碼（`ok`／`unknown` 時為 null）。 */
  code: string | null
}

export { MAX_REQUEST_BYTES }
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
  get limit(): number { return this.max }
}

/** host 對「忙」的兩種說法：controller 的 `plugin_backend_busy`，與 1.6.8 invoke gate 轉出來給 view 的 `plugin_backend_unavailable`。 */
export const BUSY_HOST_CODES: ReadonlySet<string> = new Set(['plugin_backend_busy', 'plugin_backend_unavailable'])

export interface BusyRetryOptions {
  /** 最多重試幾次（不含第一次）；0＝不重試。預設 4。 */
  attempts?: number
  /** 第 n 次重試前等 `min(baseMs * 2^n, maxMs)`（再乘 0.75–1.25 的抖動）。預設 100 ms 起、上限 1,000 ms。 */
  baseMs?: number
  maxMs?: number
  sleep?(ms: number): Promise<void>
  random?(): number
}

export interface TransportOptions {
  host: TuqPluginHost
  /** 這個 view 同時進行中的 host 呼叫上限（含事件長輪詢）。預設 3；設定 view 用 1。 */
  maxConcurrentCalls?: number
  /** `job.poll` 每次最久等多久（backend 上限 4 s）。 */
  jobPollWaitMs?: number
  busyRetry?: BusyRetryOptions
}

export const DEFAULT_MAX_CONCURRENT_CALLS = 3

export class PluginTransport {
  private readonly host: TuqPluginHost
  private readonly limiter: Limiter
  private readonly jobWaitMs: number
  private readonly retry: Required<BusyRetryOptions>
  private closed = false
  private busyRetries = 0
  private maxActive = 0
  private linkState: BackendLink = { state: 'unknown', code: null }
  private readonly linkListeners = new Set<(link: BackendLink) => void>()

  constructor(options: TransportOptions) {
    this.host = options.host
    this.limiter = new Limiter(options.maxConcurrentCalls ?? DEFAULT_MAX_CONCURRENT_CALLS)
    this.jobWaitMs = Math.min(4000, Math.max(0, options.jobPollWaitMs ?? 3000))
    const retry = options.busyRetry ?? {}
    this.retry = {
      attempts: Math.max(0, Math.floor(retry.attempts ?? 4)),
      baseMs: retry.baseMs ?? 100,
      maxMs: retry.maxMs ?? 1000,
      sleep: retry.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
      random: retry.random ?? Math.random
    }
  }

  close(): void { this.closed = true; this.linkListeners.clear() }

  /** 目前對 backend 的連線狀態（由最近一次 host 呼叫的結果決定）。 */
  link(): BackendLink { return { ...this.linkState } }
  /** 連線狀態改變時通知（同一狀態＋同一錯誤碼不重複通知）。 */
  onLink(listener: (link: BackendLink) => void): () => void {
    this.linkListeners.add(listener)
    return () => { this.linkListeners.delete(listener) }
  }

  private setLink(state: BackendLinkState, code: string | null): void {
    if (this.linkState.state === state && this.linkState.code === code) return
    this.linkState = { state, code }
    for (const listener of [...this.linkListeners]) { try { listener({ ...this.linkState }) } catch { /* 訂閱者錯誤不影響傳輸 */ } }
  }
  get isClosed(): boolean { return this.closed }
  /** `active`／`waiting`：目前在飛／排隊的 host 呼叫；`maxActive`：歷來同時在飛的最大值；`busyRetries`：因忙碌而重試的次數。 */
  stats(): { active: number; waiting: number; maxActive: number; busyRetries: number; limit: number } {
    return { ...this.limiter.stats(), maxActive: this.maxActive, busyRetries: this.busyRetries, limit: this.limiter.limit }
  }

  /** 一般請求：每一次 host 呼叫（含 job 輪詢、分段取回）各自佔用一個併發名額，名額不跨輪詢持有。 */
  invoke(path: string, args: readonly unknown[] = []): Promise<unknown> {
    if (this.closed) return Promise.reject(new PluginApiError('disposed', path, 'the plugin API was disposed'))
    return this.envelope(path, args).then((env) => this.unwrap(path, env))
  }

  /** 事件長輪詢（`events.*`）：與一般請求共用同一個併發預算（長輪詢佔 1 個名額，每次最久 waitMs）。 */
  invokeEvents(path: string, args: readonly unknown[] = []): Promise<unknown> {
    return this.invoke(path, args)
  }

  /** 一次 host 呼叫：佔用名額；host 說忙就釋放名額、退避、再試（超過次數才 reject）。 */
  private async envelope(path: string, args: readonly unknown[]): Promise<unknown> {
    const method = backendMethodFor(path)
    if (method === null) throw new PluginApiError('path_unknown', path, 'the path is not in any backend method group')
    const wire = toWire(path, args)
    for (let attempt = 0; ; attempt += 1) {
      try {
        const env = await this.limiter.run(() => {
          this.maxActive = Math.max(this.maxActive, this.limiter.stats().active)
          return this.host.backend.call(method, wire)
        })
        this.setLink('ok', null)
        return env
      } catch (error) {
        const code = error instanceof Error && error.message ? error.message.slice(0, 80) : 'backend_call_failed'
        if (ACCESS_HOST_CODES.has(code)) this.setLink('revoked', code)
        if (!BUSY_HOST_CODES.has(code) || attempt >= this.retry.attempts || this.closed) {
          if (UNAVAILABLE_HOST_CODES.has(code)) this.setLink('unavailable', code)
          throw new PluginBackendError(path, code)
        }
        this.busyRetries += 1
        const delay = Math.min(this.retry.baseMs * 2 ** attempt, this.retry.maxMs) * (0.75 + this.retry.random() * 0.5)
        await this.retry.sleep(delay)
        if (this.closed) throw new PluginApiError('disposed', path, 'the plugin API was disposed')
      }
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
