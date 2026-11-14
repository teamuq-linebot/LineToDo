/**
 * linejsObs.ts — Pro 與 LINE OBS／LINEJS 之間的邊界（X1）。
 *
 *   1. `MediaLocator` 與下載結果型別（history-download.md §6.1）：與來源無關，歷史下載、即時接收、回填共用。
 *   2. `classifyObsOutcome`：HTTP／網路結果 → 八類（HD §5.1）。HTTP 對應集中在 `OBS_HTTP_CLASS`（待 P0/P0b 校正，只改那一處）。
 *   3. obsRequest adapter：組 OBS 的 URL 與標頭，寫法比照 LINEJS 3.6.4（base.mjs:4276-4290 非 E2EE、:4384-4400＋:4466-4485 E2EE），
 *      一律送 `accept-encoding: identity`。keyMaterial、token、URL 都不進 log。
 *   4. LINEJS 呼叫情境（AsyncLocalStorage）與 R-07 register 守門（HD §5.4）：`tryRegisterE2EEGroupKey`／`registerE2EEGroupKey`
 *      只在「仍在進行中的 outbound 情境」放行；接收、下載情境與沒有情境的呼叫一律丟 `E2EE_GROUP_KEY_NOT_FOUND` 並計數。
 *      每個入口（送出、接收 listen、每個接收下載、每個串流下載）都明確 `run` 自己的情境，覆蓋繼承來的情境；outbound 情境在送出
 *      結束時關閉，所以在送出裡排程、送出結束後才執行的工作不再有 register 權限（review-p0b-r2 N-4）。下載／接收情境的 signal
 *      中止後，該情境裡新的 LINEJS 網路呼叫一律拒絕（`LINEJS_CONTEXT_ABORTED`）。
 *   5. OBS 共用限流：全域並行 2；優先順序 user > receive > batch；batch 最多同時佔 1 格（永遠留 1 格給單格手動與接收）；
 *      `rate_limited` 全域暫停（Retry-After，沒有就 10 分鐘）；`auth` 暫停到 session 改變為止。
 */
import { AsyncLocalStorage } from 'node:async_hooks'

// ───────────────────────── types ─────────────────────────

export type MediaKind = 'IMAGE' | 'VIDEO' | 'FILE'
export type MediaOrigin = 'history' | 'receive' | 'outbound' | 'backfill'
export type ObsPriority = 'user' | 'receive' | 'batch'

/** 下載的輸入（HD §6.1）。keyMaterial 只在記憶體：不寫 ledger、不寫 log。 */
export interface MediaLocator {
  stem: string
  kind: MediaKind
  /** LINE 伺服器的訊息 id（app DB `msg_id` 去掉 `'i:'`），十進位字串。 */
  messageId: string
  chatId: string
  transport: 'e2ee' | 'plain'
  sid?: string
  oid?: string
  /** base64 字串或 32 B Buffer。 */
  keyMaterial?: string | Uint8Array
  /** 明文位元組數（`FILE_SIZE`）；E2EE 物件長度應為它＋32。 */
  declaredBytes?: number
  fileName?: string
  origin: MediaOrigin
}

/** HD §5.1 的八類。 */
export type ObsClass = 'expired' | 'forbidden' | 'undecryptable' | 'unsupported' | 'auth' | 'rate_limited' | 'transient' | 'disk_low'
export const OBS_CLASSES: readonly ObsClass[] = Object.freeze(['expired', 'forbidden', 'undecryptable', 'unsupported', 'auth', 'rate_limited', 'transient', 'disk_low'])

export type Outcome =
  | { status: 'done'; bytes: number; mime: string }
  | { status: 'failed' | 'paused'; class: ObsClass; code: string; retryAfterMs?: number }
export type PausedOutcome = { status: 'paused'; class: ObsClass; code: string; retryAfterMs?: number }

export const coded = (code: string, message = code) => Object.assign(new Error(message), { code })

// ───────────────────────── classification（待 P0/P0b 校正） ─────────────────────────

/**
 * OBS 的 HTTP 狀態 → 分類。**待 P0/P0b 校正**（HD §5.1、§9 U3）：目前的對應是由程式推論，沒有用真 LINE 驗證過；
 * P0b 結果出來後只改這一個常數。校正前 404 在 UI 只代表「已過期或已不存在」（HD H-2）。
 * `5xx`：所有 500–599；`other`：表裡沒有的其他狀態（含未列出的 4xx），當暫時錯誤，有限次重試後轉手動。
 */
export const OBS_HTTP_CLASS: Readonly<Record<'401' | '403' | '404' | '410' | '429' | '5xx' | 'other', ObsClass>> = Object.freeze({
  401: 'auth',
  403: 'forbidden',
  404: 'expired',
  410: 'expired',
  429: 'rate_limited',
  '5xx': 'transient',
  other: 'transient',
})
/** 429 沒有可用的 Retry-After 時的全域暫停時間（HD §5.1）。 */
export const OBS_RATE_LIMIT_DEFAULT_MS = 10 * 60_000
/** Retry-After 的上限（避免伺服器給出離譜的值讓佇列永遠停住）。 */
export const OBS_RATE_LIMIT_MAX_MS = 6 * 60 * 60_000

export interface ObsClassified { class: ObsClass; code: string; retryAfterMs?: number }

function retryAfterMs(headers: Headers | undefined, now: number): number {
  const raw = headers?.get('retry-after')?.trim()
  if (raw) {
    let ms = /^\d{1,9}$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - now
    if (Number.isFinite(ms) && ms > 0) return Math.min(ms, OBS_RATE_LIMIT_MAX_MS)
  }
  return OBS_RATE_LIMIT_DEFAULT_MS
}

/** 一次 OBS 請求的結果 → 分類。`status` 優先；沒有狀態時，逾時與網路錯誤都是 transient。 */
export function classifyObsOutcome(input: { status?: number; headers?: Headers; error?: unknown; timedOut?: boolean; now?: number }): ObsClassified {
  const status = input.status
  if (typeof status === 'number' && Number.isInteger(status)) {
    const key = (String(status) in OBS_HTTP_CLASS ? String(status) : status >= 500 && status <= 599 ? '5xx' : 'other') as keyof typeof OBS_HTTP_CLASS
    const cls = OBS_HTTP_CLASS[key]
    const code = `OBS_HTTP_${status >= 100 && status <= 599 ? status : 'OTHER'}`
    return cls === 'rate_limited' ? { class: cls, code, retryAfterMs: retryAfterMs(input.headers, input.now ?? Date.now()) } : { class: cls, code }
  }
  if (input.timedOut) return { class: 'transient', code: 'OBS_TIMEOUT' }
  const errorCode = String((input.error as { code?: unknown } | null)?.code ?? '')
  if (errorCode === 'LINEJS_URL_DENIED') return { class: 'unsupported', code: 'LINEJS_URL_DENIED' }
  if (errorCode === 'LINEJS_REDIRECT_DENIED') return { class: 'transient', code: 'LINEJS_REDIRECT_DENIED' }
  return { class: 'transient', code: 'OBS_NETWORK' }
}

// ───────────────────────── obsRequest adapter ─────────────────────────

export const OBS_ORIGIN = 'https://obs.line-apps.com'
/** E2EE 媒體的 SID 白名單（emi 照片、emv 影片、emf 檔案）。 */
export const OBS_E2EE_SIDS: ReadonlySet<string> = new Set(['emi', 'emv', 'emf'])
/** OID：與 linejsMedia.ts 允許清單的 GET em[ivf] 規則相同（上傳用的 `reqid-` 名稱不是下載對象）。 */
export const OBS_OID = /^(?!reqid-)[A-Za-z0-9_-]{1,128}$/
const MESSAGE_ID = /^\d{1,32}$/
const CHAT_ID = /^[ucr][A-Za-z0-9]{1,64}$/

/**
 * `X-Talk-Meta`，與 LINEJS 3.6.4 `downloadMediaByE2EE`（base.mjs:4471-4479）逐位元組相同：
 * b64(JSON{message: b64(TBinaryProtocol struct{4: string id, 27: list<struct>[]})})。
 */
export function obsTalkMeta(messageId: string): string {
  const id = Buffer.from(messageId, 'utf8')
  const len = Buffer.alloc(4)
  len.writeInt32BE(id.length)
  const struct = Buffer.concat([Buffer.from([0x0b, 0x00, 0x04]), len, id, Buffer.from([0x0f, 0x00, 0x1b, 0x0c, 0x00, 0x00, 0x00, 0x00]), Buffer.from([0x00])])
  return Buffer.from(JSON.stringify({ message: struct.toString('base64') })).toString('base64')
}

/** keyMaterial（base64 或 bytes）→ 32 B Buffer；不合格回 null。 */
export function keyMaterialBytes(value: MediaLocator['keyMaterial']): Buffer | null {
  if (value == null) return null
  let buf: Buffer
  if (typeof value === 'string') {
    if (!/^[A-Za-z0-9+/]{43}=?$/.test(value.trim())) return null
    buf = Buffer.from(value.trim(), 'base64')
  } else buf = Buffer.from(value)
  return buf.length === 32 ? buf : null
}

/** 本地就能判定、不必連網的問題（HD §3.1 a1、a2、a6；§5.1 unsupported）。 */
export function locatorProblem(locator: MediaLocator): ObsClassified | null {
  if (!locator || !['IMAGE', 'VIDEO', 'FILE'].includes(locator.kind)) return { class: 'unsupported', code: 'LOCATOR_INVALID' }
  if (typeof locator.messageId !== 'string' || !MESSAGE_ID.test(locator.messageId)) return { class: 'unsupported', code: 'LOCATOR_INVALID' }
  if (typeof locator.chatId !== 'string' || !CHAT_ID.test(locator.chatId)) return { class: 'unsupported', code: 'CHAT_UNSUPPORTED' }
  if (locator.declaredBytes !== undefined && (!Number.isSafeInteger(locator.declaredBytes) || locator.declaredBytes < 0)) return { class: 'unsupported', code: 'LOCATOR_INVALID' }
  if (locator.transport === 'e2ee') {
    if (typeof locator.sid !== 'string' || !OBS_E2EE_SIDS.has(locator.sid)) return { class: 'unsupported', code: 'SID_UNSUPPORTED' }
    if (typeof locator.oid !== 'string' || !OBS_OID.test(locator.oid)) return { class: 'unsupported', code: 'LOCATOR_INVALID' }
    if (!keyMaterialBytes(locator.keyMaterial)) return { class: 'undecryptable', code: 'KEY_MATERIAL_MISSING' }
    return null
  }
  if (locator.transport === 'plain') return null
  return { class: 'unsupported', code: 'LOCATOR_INVALID' }
}

/**
 * 組一次 OBS GET。E2EE：`/r/talk/<SID>/<OID>`，標頭 = `client.base.request.getHeader('GET')` ＋ `X-Talk-Meta`；
 * 非 E2EE：`/r/talk/m/<id>`，標頭同 LINEJS `downloadMessageData`。`rangeStart > 0` 時加 `range: bytes=N-`。
 * 呼叫前必須先過 `locatorProblem`。
 */
export function buildObsRequest(client: any, locator: MediaLocator, opts: { rangeStart?: number; signal?: AbortSignal } = {}): Request {
  const base = client?.base
  if (!base) throw coded('SESSION_GONE')
  let url: string
  let headers: Record<string, string>
  if (locator.transport === 'e2ee') {
    url = `${OBS_ORIGIN}/r/talk/${locator.sid}/${locator.oid}`
    headers = { ...(base.request?.getHeader?.('GET') as Record<string, string> ?? {}) }
    headers['X-Talk-Meta'] = obsTalkMeta(locator.messageId)
  } else {
    url = `${OBS_ORIGIN}/r/talk/m/${locator.messageId}`
    headers = { accept: 'application/json, text/plain, */*', 'x-line-application': String(base.request?.systemType ?? ''), 'x-Line-access': String(base.authToken ?? '') }
  }
  // getHeader('GET') carries "accept-encoding": "gzip": replaced, so byte offsets (Range resume) are the object's own bytes (HD a7).
  for (const name of Object.keys(headers)) if (name.toLowerCase() === 'accept-encoding') delete headers[name]
  headers['accept-encoding'] = 'identity'
  if (opts.rangeStart && opts.rangeStart > 0) headers.range = `bytes=${opts.rangeStart}-`
  return new Request(url, { method: 'GET', headers, redirect: 'manual', signal: opts.signal })
}

// ───────────────────────── LINEJS call context and the R-07 register guard ─────────────────────────

export type LineJsMode = 'outbound' | 'receive' | 'download'
interface LineJsContext { mode: LineJsMode; signal?: AbortSignal; open: boolean }
const lineJsAls = new AsyncLocalStorage<LineJsContext>()

/**
 * 以 `mode` 情境執行 `fn`（覆蓋任何繼承來的情境）。`fn` 結束（成功或失敗）時情境關閉：之後才執行、但在情境裡排程的工作
 * 看到的是關閉的情境——outbound 的 register 權限因此不會被延後的工作帶走。
 */
export async function runInLineJsContext<T>(mode: LineJsMode, fn: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
  const context: LineJsContext = { mode, signal, open: true }
  return lineJsAls.run(context, async () => {
    try { return await fn() } finally { context.open = false }
  })
}

/** 目前的情境（沒有就 null）。 */
export function currentLineJsContext(): { mode: LineJsMode; open: boolean; aborted: boolean } | null {
  const context = lineJsAls.getStore()
  return context ? { mode: context.mode, open: context.open, aborted: Boolean(context.signal?.aborted) } : null
}

/** 只有「仍在進行中的 outbound 情境」可以寫入群組金鑰。 */
export function lineJsRegisterAllowed(): boolean {
  const context = lineJsAls.getStore()
  return context?.mode === 'outbound' && context.open === true
}

/** 接收／下載情境的 signal 已中止時，該情境的 signal（給 fetch 合併用）與拒絕用的錯誤。 */
export function lineJsContextSignal(): AbortSignal | undefined {
  const context = lineJsAls.getStore()
  return context && context.mode !== 'outbound' ? context.signal : undefined
}
export function lineJsContextAbortError(): Error | null {
  return lineJsContextSignal()?.aborted ? coded('LINEJS_CONTEXT_ABORTED') : null
}

const guardedObjects = new WeakSet<object>()
const blockedRegisters = new WeakMap<object, number>()

/**
 * 在 LINEJS client 上安裝 register 守門（安裝 client 時呼叫；可重複呼叫）。被擋下時丟 `E2EE_GROUP_KEY_NOT_FOUND`，
 * 呼叫不會到達網路層。outbound 送到沒有群組金鑰的群組時照常 register（這是合理的寫入）。
 */
export function installRegisterGuard(client: any): void {
  const base = client?.base
  if (!base || typeof base !== 'object') return
  const block = () => {
    blockedRegisters.set(client, (blockedRegisters.get(client) ?? 0) + 1)
    return Promise.reject(coded('E2EE_GROUP_KEY_NOT_FOUND'))
  }
  const wrap = (target: any, method: string) => {
    if (!target || typeof target !== 'object' || typeof target[method] !== 'function' || guardedObjects.has(target)) return
    const original = target[method]
    target[method] = function registerGuard(this: unknown, ...args: unknown[]) {
      if (!lineJsRegisterAllowed()) return block()
      return original.apply(this, args)
    }
    guardedObjects.add(target)
  }
  wrap(base.e2ee, 'tryRegisterE2EEGroupKey')
  wrap(base.talk, 'registerE2EEGroupKey')
}

/** 這個 client 被守門擋下的 register 次數。 */
export function registerBlockedCount(client: unknown): number {
  return client && typeof client === 'object' ? blockedRegisters.get(client) ?? 0 : 0
}

// ───────────────────────── OBS shared limiter ─────────────────────────

const PRIORITY_RANK: Record<ObsPriority, number> = { user: 0, receive: 1, batch: 2 }
export const OBS_CONCURRENCY = 2
export const OBS_BATCH_CONCURRENCY = 1
/**
 * 401 暫停的時限（review-x1 L-3）：同一個 session 的 401 暫停最多這麼久，之後放行一次再試（再 401 就再暫停）。session 換了、
 * 或 token 更新（呼叫端在 `update:authtoken` 時呼叫 `resumeAuth`）會更早解除。
 */
export const OBS_AUTH_PAUSE_MAX_MS = 10 * 60_000

type Acquired = { ok: true; release: () => void } | { ok: false; outcome: PausedOutcome }
interface Waiter { priority: ObsPriority; seq: number; resolve: (value: Acquired) => void; signal?: AbortSignal; onAbort?: () => void; sessionId?: string }
const AUTH_PAUSED: PausedOutcome = Object.freeze({ status: 'paused', class: 'auth', code: 'OBS_AUTH_PAUSED' }) as PausedOutcome

export class ObsLimiter {
  private readonly concurrency: number
  private readonly batchConcurrency: number
  private readonly authPauseMs: number
  private readonly now: () => number
  private active: Record<ObsPriority, number> = { user: 0, receive: 0, batch: 0 }
  private waiters: Waiter[] = []
  private seq = 0
  private pausedUntil = 0
  /** 401 暫停（review-x1 L-3）：只對這一個 session 有效，到 `until` 為止。 */
  private authPause: { sessionId: string; until: number } | null = null
  /** 開始順序（測試與 trace 用）：每次發出名額時記下 priority，只留最近 64 筆（共用限流器常駐）。 */
  readonly started: ObsPriority[] = []

  constructor(options: { concurrency?: number; batchConcurrency?: number; authPauseMs?: number; now?: () => number } = {}) {
    this.concurrency = options.concurrency ?? OBS_CONCURRENCY
    this.batchConcurrency = options.batchConcurrency ?? OBS_BATCH_CONCURRENCY
    this.authPauseMs = options.authPauseMs ?? OBS_AUTH_PAUSE_MAX_MS
    this.now = options.now ?? Date.now
  }

  private total() { return this.active.user + this.active.receive + this.active.batch }

  private pausedOutcome(): PausedOutcome | null {
    const left = this.pausedUntil - this.now()
    return left > 0 ? { status: 'paused', class: 'rate_limited', code: 'OBS_PAUSED', retryAfterMs: left } : null
  }

  /** 仍有效的 401 暫停（過了時限就清掉）。 */
  private liveAuthPause(): { sessionId: string; until: number } | null {
    if (this.authPause && this.now() >= this.authPause.until) this.authPause = null
    return this.authPause
  }

  /**
   * 取得一個 OBS 名額。暫停中（429、同一 session 的 401）立刻回 paused，不排隊、不送出；signal 中止時回 ABORTED。
   * 取得後必須呼叫 `release()`（只算一次）。
   *
   * 401 暫停只擋同一個 sessionId（review-x1 L-3）。另一個 sessionId 的呼叫只有在 `isCurrent()` 為真（它就是目前安裝的
   * session，代表 session 真的換了）時才解除暫停；過期 session 的呼叫不會解除別人的暫停。
   */
  acquire(priority: ObsPriority, opts: { signal?: AbortSignal; sessionId?: string; isCurrent?: () => boolean } = {}): Promise<Acquired> {
    if (opts.signal?.aborted) return Promise.resolve({ ok: false, outcome: { status: 'paused', class: 'transient', code: 'ABORTED' } })
    const auth = this.liveAuthPause()
    if (auth) {
      if (opts.sessionId === auth.sessionId) return Promise.resolve({ ok: false, outcome: AUTH_PAUSED })
      if (opts.sessionId && opts.isCurrent?.() === true) this.authPause = null
    }
    const paused = this.pausedOutcome()
    if (paused) return Promise.resolve({ ok: false, outcome: paused })
    return new Promise<Acquired>((resolve) => {
      const waiter: Waiter = { priority, seq: ++this.seq, resolve, signal: opts.signal, sessionId: opts.sessionId }
      if (opts.signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) { this.waiters.splice(index, 1); resolve({ ok: false, outcome: { status: 'paused', class: 'transient', code: 'ABORTED' } }) }
        }
        opts.signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.waiters.push(waiter)
      this.pump()
    })
  }

  private pump() {
    while (this.total() < this.concurrency && this.waiters.length) {
      let best = -1
      for (let i = 0; i < this.waiters.length; i++) {
        const w = this.waiters[i]
        if (w.priority === 'batch' && this.active.batch >= this.batchConcurrency) continue
        if (best < 0 || PRIORITY_RANK[w.priority] < PRIORITY_RANK[this.waiters[best].priority] || (PRIORITY_RANK[w.priority] === PRIORITY_RANK[this.waiters[best].priority] && w.seq < this.waiters[best].seq)) best = i
      }
      if (best < 0) return
      const [waiter] = this.waiters.splice(best, 1)
      if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort)
      this.active[waiter.priority]++
      this.started.push(waiter.priority)
      if (this.started.length > 64) this.started.splice(0, this.started.length - 64)
      let released = false
      waiter.resolve({ ok: true, release: () => { if (released) return; released = true; this.active[waiter.priority]--; this.pump() } })
    }
  }

  /** 429：全域暫停 `ms`；排隊中的工作（不分 session）立刻回 paused（不送出）。 */
  pauseRateLimited(ms: number) {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + Math.max(0, ms))
    const paused = this.pausedOutcome()
    if (paused) this.flushWaiters(() => true, paused)
  }

  /**
   * 401：同一 session 的工作暫停，直到 session 換了（目前 session 的呼叫）、`resumeAuth`／`resume()`，或過了時限（L-3）。
   * 只把同一個 session 的等待者以 paused 送回；其他 session 的等待者留在佇列。
   */
  pauseAuth(sessionId: string, ms = this.authPauseMs) {
    this.authPause = { sessionId, until: this.now() + Math.max(0, ms) }
    this.flushWaiters((waiter) => waiter.sessionId === sessionId, AUTH_PAUSED)
  }

  /** 解除 401 暫停（token 更新時）：給了 sessionId 就只解除那個 session 的暫停。 */
  resumeAuth(sessionId?: string) {
    if (this.authPause && (sessionId === undefined || this.authPause.sessionId === sessionId)) this.authPause = null
    this.pump()
  }

  resume() { this.pausedUntil = 0; this.authPause = null; this.pump() }

  private flushWaiters(match: (waiter: Waiter) => boolean, outcome: PausedOutcome) {
    const keep: Waiter[] = []
    for (const waiter of this.waiters.splice(0)) {
      if (!match(waiter)) { keep.push(waiter); continue }
      if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort)
      waiter.resolve({ ok: false, outcome })
    }
    this.waiters = keep
    this.pump()
  }

  /** 暫停中的 401 session（測試與 trace 用；沒有就是 null）。 */
  authPausedSession(): string | null { return this.liveAuthPause()?.sessionId ?? null }

  state() {
    const left = this.pausedUntil - this.now()
    return { active: { ...this.active }, queued: this.waiters.length, pausedMs: left > 0 ? left : 0, authPaused: this.liveAuthPause() !== null }
  }
}

/** 全 backend 共用的一個限流器：自動接收、歷史下載、批次都經過它。 */
export const sharedObsLimiter = new ObsLimiter()
