import type { loginWithQR, loginWithAuthToken } from '@evex-dev/linejs'
import { FileStorage } from '@evex-dev/linejs/storage'
import QRCode from 'qrcode'
import { access, mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { AutoDownloadStore, MAX_AUTO_DOWNLOAD_BYTES, MAX_SAVED_FILE_CHUNK_BYTES } from './linejsAutoDownload.mjs'
import { installRegisterGuard, lineJsContextAbortError, lineJsContextSignal, runInLineJsContext } from './linejsObs'

const MAX_BYTES = MAX_AUTO_DOWNLOAD_BYTES
const TOKEN_KEY = 'linejs-auth-token'
/** After a failed restore of the saved session, polled callers (status, outboundPeek) wait this long before the next token login. */
const RESTORE_RETRY_MS = 30_000
/**
 * status() waits at most this long for a restore of the saved session (a network token login). The view gives a status call 10 s
 * (pluginTransport core lane) and polls it every 1–2 s, so status never waits for LINE: a slower restore keeps running in the
 * background and status answers `restoring` meanwhile.
 */
const STATUS_RESTORE_WAIT_MS = 2_000
/** A QR login that is not confirmed within this time fails (LOGIN_TIMEOUT); the window restarts when LINE asks for the PIN. */
const LOGIN_TIMEOUT_MS = 120_000
/** LINE's PIN is digits only; anything else is reduced to its digits (at most 12) before it is shown. Never logged or written. */
const SAFE_PIN = (value: unknown) => String(value ?? '').replace(/\D/g, '').slice(0, 12)
/** Resolves when `promise` settles or after `ms`, whichever comes first (never rejects; the timer does not outlive the race). */
const settledWithin = (promise: Promise<unknown>, ms: number) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms)
  const done = () => { clearTimeout(timer); resolve() }
  promise.then(done, done)
})
const HOSTS = new Set(['legy.line-apps.com', 'gf.line.naver.jp', 'obs.line-apps.com', 'access.line.me'])
const API_PATH = /^\/(?:api\/v[34]p\/rs|api\/v3\/TalkService\.do|acct\/(?:lgn|lp\/lgn)\/sq\/v[12]|(?:Q|LF1|S4|P4|SYNC3))$/
const OBS_PATH = /^\/r\/talk\/m\/[A-Za-z0-9_-]+(?:\/preview|\/object_info\.obs)?$/
/**
 * E2EE media download (GET only; X1 streaming downloader, LINEJS downloadMediaByE2EE): /r/talk/<SID>/<OID> with SID emi/emv/emf.
 * An upload-shaped name (reqid-…) is never a download target, so a GET to an upload path stays denied.
 */
const OBS_DOWNLOAD_PATH = /^\/r\/talk\/em[ivf]\/(?!reqid-)[A-Za-z0-9_-]{1,128}$/
/**
 * Outbound media upload (user-initiated send only): LINEJS 3.6.4 uploadMediaByE2EE POSTs the encrypted body to
 * /r/talk/em{i,f}/reqid-<uuid> and, for images, the preview to /r/talk/emi/<oid>__ud-preview, before talk.sendMessage.
 */
const OBS_UPLOAD_PATH = /^\/r\/talk\/em[if]\/(?:reqid-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{1,128}__ud-preview)$/
const ACCESS_PATHS = new Set(['/oauth2/v2.1/authorize/consent', '/dialog/api/permissions'])
const SAFE_ERROR = (error: unknown) => {
  const code = String((error as { code?: unknown })?.code ?? 'LINEJS_ERROR').replace(/[^A-Z0-9_]/gi, '').slice(0, 40)
  return { code: code || 'LINEJS_ERROR', message: `LINE 連線失敗（${code || 'UNKNOWN'}）` }
}

function guardedStorage(disk: SessionStorage) {
  let active = true
  let writes = 0
  let drained: (() => void) | null = null
  const write = async (fn: () => Promise<unknown>) => {
    if (!active) return
    writes++
    try { await fn() } finally { writes--; if (!writes && drained) { drained(); drained = null } }
  }
  return {
    storage: {
      get: (key: string) => disk.get(key),
      getAll: () => disk.getAll(),
      set: (key: string, value: unknown) => write(() => disk.set(key, value as any)),
      delete: (key: string) => write(() => disk.delete(key)),
      clear: () => write(() => disk.clear()),
      migrate: async (target: any) => {
        const values = await disk.getAll()
        for (const [key, value] of Object.entries(values)) await write(() => target.set(key, value))
      },
    },
    deactivate() { active = false },
    drain() { return writes ? new Promise<void>((resolve) => { drained = resolve }) : Promise.resolve() },
  }
}

function isObsUpload(url: URL, method: string): boolean {
  return url.hostname === 'obs.line-apps.com' && method.toUpperCase() === 'POST' && OBS_UPLOAD_PATH.test(url.pathname)
}

export function linejsUrlAllowed(input: string | URL, method = 'GET'): boolean {
  try {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : (input as Request).url)
    if (url.protocol !== 'https:' || url.port || url.username || url.password || !HOSTS.has(url.hostname)) return false
    if (url.hostname === 'legy.line-apps.com' || url.hostname === 'gf.line.naver.jp') return API_PATH.test(url.pathname) || (url.hostname === 'gf.line.naver.jp' && url.pathname === '/enc')
    if (url.hostname === 'obs.line-apps.com') return OBS_PATH.test(url.pathname) || (method.toUpperCase() === 'GET' && OBS_DOWNLOAD_PATH.test(url.pathname)) || isObsUpload(url, method)
    return ACCESS_PATHS.has(url.pathname)
  } catch { return false }
}

/**
 * A Request built from another Request follows the parent's signal only through a WeakRef to the parent's AbortController (undici),
 * and that controller lives only as long as the parent Request. Once the caller's Request and the copies made here are garbage
 * collected, an abort or a timeout of the caller's signal no longer reaches the network call (measured: 0/20 after a forced GC).
 * The chain is therefore kept alive by the Response the caller holds while it reads the body.
 */
const signalChain = new WeakMap<object, unknown[]>()

export function createLineJsFetch(baseFetch: typeof fetch, capBytes = MAX_BYTES) {
  return async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    if (!linejsUrlAllowed(request.url, request.method)) throw Object.assign(new Error('LINEJS URL 不在允許清單'), { code: 'LINEJS_URL_DENIED' })
    const forwarded = new Request(request, { redirect: 'manual' })
    const chain = [forwarded, request, input]
    const response = await baseFetch(forwarded)
    signalChain.set(response, chain)
    // LINEJS does not check the OBS upload status and would send a message pointing at an empty object id: an upload that LINE did not
    // accept (non-2xx, including redirects, or no x-obs-oid) stops here, before talk.sendMessage, so the send is known not to have happened.
    if (isObsUpload(new URL(request.url), request.method) && (response.status < 200 || response.status >= 300 || !response.headers.get('x-obs-oid'))) {
      await response.body?.cancel().catch(() => {})
      throw Object.assign(new Error('LINE 未接受附件上傳'), { code: 'OBS_UPLOAD_REJECTED' })
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {})
      throw Object.assign(new Error('LINEJS redirect 已拒絕'), { code: 'LINEJS_REDIRECT_DENIED' })
    }
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > capBytes) {
      await response.body?.cancel().catch(() => {})
      throw Object.assign(new Error('LINE 附件超過 25 MiB'), { code: 'ATTACHMENT_TOO_LARGE' })
    }
    // media streaming (createLineJsMediaFetch) has no total cap: the body is handed over as is (the downloader checks sizes itself)
    if (!response.body || capBytes === Infinity) return response
    const reader = response.body.getReader()
    let total = 0
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) { controller.close(); return }
          total += value.byteLength
          if (total > capBytes) {
            await reader.cancel('attachment_limit_exceeded')
            controller.error(Object.assign(new Error('LINE 回應超過 25 MiB'), { code: 'ATTACHMENT_TOO_LARGE' }))
            return
          }
          controller.enqueue(value)
        } catch (error) { controller.error(error) }
      },
      cancel(reason) { return reader.cancel(reason) }
    })
    const capped = new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers })
    signalChain.set(capped, [response, ...chain])
    return capped
  }
}

/**
 * The streaming downloader's fetch (X1): same allowlist and redirect refusal as createLineJsFetch, without the 25 MiB total cap
 * (the 25 MiB cap stays on the API / upload fetch of the LINEJS client). The request's own signal is kept.
 */
export function createLineJsMediaFetch(baseFetch: typeof fetch = (input, init) => globalThis.fetch(input, init)) {
  return createLineJsFetch(baseFetch, Infinity)
}

/**
 * The LINEJS session fetch (installed on client.base.fetch). Every abort source is merged into the one signal the network call gets:
 * the request's own signal (LINEJS passes AbortSignal.timeout(config.timeout); R-05: it used to be dropped, so a timeout never
 * aborted the fetch), init.signal, the session's controller (logout / dispose) and the signal of the receive / download context the
 * call runs in. Once that context is aborted, a new LINEJS call from it is refused before it reaches the network.
 */
export function createLineJsSessionFetch(baseFetch: typeof fetch, sessionSignal?: AbortSignal, capBytes = MAX_BYTES) {
  return createLineJsFetch(async (input, init = {}) => {
    const refused = lineJsContextAbortError()
    if (refused) throw refused
    const requestSignal = input instanceof Request ? input.signal : undefined
    const signals = [requestSignal, init.signal, sessionSignal, lineJsContextSignal()].filter((item): item is AbortSignal => Boolean(item))
    return baseFetch(input, { ...init, signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] })
  }, capBytes)
}

/**
 * `pin`: the PIN LINE asks the user to type on the phone after the QR scan (onPincodeRequest). Memory only: it lives in this object,
 * is returned by status() to the views, and is dropped by every transition (authenticated, failed, cancelled, a new login, dispose).
 * `restoring` is a view of status() only (a saved session is being restored in the background), never stored here.
 */
type LoginState = { status: 'idle' | 'pending' | 'authenticated' | 'failed' | 'cancelled'; qr?: string; pin?: string; error?: ReturnType<typeof SAFE_ERROR> }
/** The LINEJS storage shape the service uses (FileStorage in production; tests inject a controllable one). */
type SessionStorage = Pick<FileStorage, 'get' | 'getAll' | 'set' | 'delete' | 'clear' | 'migrate'>
/** `loginTimeoutMs`: tests shorten LOGIN_TIMEOUT_MS (production always uses the default). */
type LineJsMediaAdapters = { loginWithQR?: typeof loginWithQR; loginWithAuthToken?: typeof loginWithAuthToken; encodeQr?: (value: string) => Promise<string>; storage?: (file: string) => SessionStorage; loginTimeoutMs?: number }

/** What the outbound sender may see of the session: the live client, the per-install session id (fencing token) and the account mid. */
export interface LineJsOutboundSession { client: any; sessionId: string; ownerMid: string }
export interface LineJsOutboundPeek { state: 'unavailable' | 'not_logged_in' | 'restoring' | 'ready'; sessionId: string | null; ownerMid: string | null }

export class LineJsMediaService {
  private store: InstanceType<typeof AutoDownloadStore>
  private client: any = null
  /** Random id of the currently installed client (new on every install, null when none): outbound sends are fenced on it. */
  private sessionId: string | null = null
  private sessionListeners = new Set<(sessionId: string | null) => void>()
  private restorePromise: Promise<any> | null = null
  private restoreFailedAt = 0
  /** A QR login is committing its session file (rename → re-check → install or discard). */
  private loginCommitting = false
  private loginState: LoginState = { status: 'idle' }
  private loginController: AbortController | null = null
  private loginStorageGuard: ReturnType<typeof guardedStorage> | null = null
  private loginTimer: ReturnType<typeof setTimeout> | null = null
  private restoreController: AbortController | null = null
  /** The restore (by its controller) that is at the network stage — token login of a saved session: the only time the views read `restoring`. */
  private restoringSaved: AbortController | null = null
  private clientController: AbortController | null = null
  private loginGeneration = 0
  private sessionEpoch = 0
  private enabled = false
  private disposed = false
  private receiver: { handler: (message: any) => void; controller: AbortController } | null = null
  private receiverError: string | null = null
  /** Observers of the receive switch (linejsReceive.ts: X2b receives from the desktop LINE rows, not from these LINEJS events). */
  private receiveListeners = new Set<(enabled: boolean) => void>()
  private unavailableReason: string | null = null
  private file: string
  private readonly dataDir: string
  private readonly qrLogin: typeof loginWithQR
  private readonly tokenLogin: typeof loginWithAuthToken
  private readonly encodeQr: (value: string) => Promise<string>
  private readonly storageFor: (file: string) => SessionStorage
  private readonly loginTimeoutMs: number

  // Plain field, not a TypeScript parameter property: the tests load this file with node --experimental-strip-types.
  private constructor(dataDir: string, adapters: LineJsMediaAdapters = {}) {
    this.dataDir = dataDir
    this.storageFor = adapters.storage ?? ((file) => new FileStorage(file))
    this.file = path.join(dataDir, 'linejs-session.json')
    // X2b: the v1 download path is off — the v1 ledger is a read-only record (export of old files, X4 backfill, the one-time v2 import)
    this.store = new AutoDownloadStore(path.join(dataDir, 'linejs-downloads'), { frozen: true })
    this.qrLogin = adapters.loginWithQR ?? (async (...args: Parameters<typeof loginWithQR>) => (await import('@evex-dev/linejs')).loginWithQR(...args))
    this.tokenLogin = adapters.loginWithAuthToken ?? (async (...args: Parameters<typeof loginWithAuthToken>) => (await import('@evex-dev/linejs')).loginWithAuthToken(...args))
    this.encodeQr = adapters.encodeQr ?? ((value) => QRCode.toDataURL(value, { width: 240, margin: 1 }))
    this.loginTimeoutMs = adapters.loginTimeoutMs ?? LOGIN_TIMEOUT_MS
  }

  static async create(dataDir: string, adapters: LineJsMediaAdapters = {}) {
    const service = new LineJsMediaService(dataDir, adapters)
    try {
      await mkdir(dataDir, { recursive: true })
      await service.store.init()
      const settings = JSON.parse(await readFile(path.join(dataDir, 'linejs-settings.json'), 'utf8'))
      service.enabled = settings.receiveEnabled === true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') service.unavailableReason = SAFE_ERROR(error).message
    }
    return service
  }

  private storage(file = this.file) { return this.storageFor(file) }

  /** The single place a client becomes the live session: every install gets a fresh session id. */
  private installClient(client: any, controller: AbortController) {
    this.clientController = controller
    ;(client.base as any).fetch = this.fetch(controller.signal)
    // R-07: group-key registration only from a user-initiated send (linejsObs.ts); receive / download contexts are refused.
    installRegisterGuard(client)
    this.client = client
    this.sessionId = randomUUID()
    this.notifySession()
  }

  private clearClient() {
    this.client = null
    this.sessionId = null
    this.notifySession()
  }

  private notifySession() {
    for (const listener of [...this.sessionListeners]) { try { listener(this.sessionId) } catch { /* observers never break the session */ } }
  }

  /** Observe session installs/clears (outbound staging is dropped when the session changes). */
  onSessionChange(listener: (sessionId: string | null) => void): () => void {
    this.sessionListeners.add(listener)
    return () => { this.sessionListeners.delete(listener) }
  }

  /** The live session id, or null (none, or the service stopped). */
  currentSessionId(): string | null { return this.disposed ? null : this.sessionId }

  /** True only while `client` is still the installed client of session `sessionId`. */
  isCurrentSession(sessionId: string, client: unknown): boolean {
    return !this.disposed && this.sessionId !== null && this.sessionId === sessionId && this.client === client
  }

  /** The session for a user-initiated send: waits for a restore in progress (does not answer a premature null). */
  async outboundSession(): Promise<LineJsOutboundSession | null> {
    if (this.disposed || this.unavailableReason) return null
    if (!this.client) {
      try { await (this.restorePromise ?? this.restore()) } catch { /* no session */ }
    }
    const client = this.client
    const sessionId = this.sessionId
    const ownerMid = String(client?.base?.profile?.mid || '')
    if (this.disposed || !client || !sessionId || !ownerMid) return null
    return { client, sessionId, ownerMid }
  }

  /** Session state without waiting for the network: a saved session that is not restored yet starts restoring in the background. */
  async outboundPeek(): Promise<LineJsOutboundPeek> {
    if (this.disposed || this.unavailableReason) return { state: 'unavailable', sessionId: null, ownerMid: null }
    if (this.client && this.sessionId) return { state: 'ready', sessionId: this.sessionId, ownerMid: String(this.client.base?.profile?.mid || '') || null }
    if (this.restoreController || this.restorePromise || this.loginCommitting) return { state: 'restoring', sessionId: null, ownerMid: null }
    // A QR login is in progress: the saved token is being replaced, so it is not restored meanwhile (REV-CL-002).
    if (this.loginController) return { state: 'not_logged_in', sessionId: null, ownerMid: null }
    const saved = await access(this.file).then(() => true, () => false)
    if (!saved || Date.now() - this.restoreFailedAt < RESTORE_RETRY_MS) return { state: 'not_logged_in', sessionId: null, ownerMid: null }
    void this.restore().then((client) => { if (!client) this.restoreFailedAt = Date.now() }, () => { this.restoreFailedAt = Date.now() })
    return { state: 'restoring', sessionId: null, ownerMid: null }
  }
  private fetch(signal?: AbortSignal) {
    const base = globalThis.fetch
    return createLineJsSessionFetch((input, init) => base(input, init), signal)
  }

  /** Same contract as before (a concurrent caller still gets null at once); the running restore is kept so outboundSession can wait for it. */
  private restore(): Promise<any> {
    if (this.client || this.disposed) return Promise.resolve(this.client)
    // A QR login in progress (pending, QR shown or committing) owns the session: no token login of the saved session meanwhile (REV-CL-002).
    if (this.restoreController || this.loginCommitting || this.loginController) return Promise.resolve(null)
    const running = this.restoreOnce()
    this.restorePromise = running
    const settle = () => { if (this.restorePromise === running) this.restorePromise = null }
    running.then(settle, settle)
    return running
  }

  private async restoreOnce() {
    const epoch = this.sessionEpoch
    const controller = new AbortController()
    this.restoreController = controller
    try {
      let session: Record<string, unknown>
      try { session = JSON.parse(await readFile(this.file, 'utf8')) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
      const token = session[TOKEN_KEY]
      if (!token) return null
      const storage = this.storage()
      this.restoringSaved = controller
      const client = await this.tokenLogin(String(token), { device: 'ANDROIDSECONDARY', storage, fetch: this.fetch(controller.signal) })
      if (controller.signal.aborted || epoch !== this.sessionEpoch || this.disposed) return null
      this.installClient(client, controller)
      client.base.on?.('update:authtoken', (next: string) => void storage.set(TOKEN_KEY, next))
      this.store.setOwner(client.base?.profile?.mid || 'unknown-account')
      if (this.enabled) this.startReceiver(client)
      return client
    } finally { if (this.restoreController === controller) this.restoreController = null; if (this.restoringSaved === controller) this.restoringSaved = null; if (this.clientController !== controller) controller.abort() }
  }

  async status() {
    if (this.disposed || this.unavailableReason) return { available: false, login: { status: 'failed', error: { code: this.disposed ? 'SERVICE_STOPPED' : 'SERVICE_UNAVAILABLE', message: this.disposed ? '下載服務已停止' : this.unavailableReason } }, receiver: 'unavailable', downloads: this.store.snapshot() }
    // status() is polled (settings every 2 s, chat login dialog every 1 s): a failed restore is not retried on every poll (same 30 s as
    // outboundPeek), and its failure never replaces a QR login that is in progress (pending/QR/committing) — REV-CL-002.
    // It never waits for LINE longer than STATUS_RESTORE_WAIT_MS: the restore (a network token login) goes on in the background and its
    // outcome is recorded by itself, so a later poll sees it (AC3: the view's 10 s status call is never spent on the network).
    if (!this.loginController && !this.loginCommitting && Date.now() - this.restoreFailedAt >= RESTORE_RETRY_MS) {
      const running = this.restore()
      if (running === this.restorePromise) {
        running.catch((error: unknown) => {
          this.restoreFailedAt = Date.now()
          if (!this.loginController && !this.loginCommitting) this.loginState = { status: 'failed', error: SAFE_ERROR(error) }
        })
      }
      await settledWithin(running, STATUS_RESTORE_WAIT_MS)
    }
    return { available: true, login: this.loginView(), receiver: !this.enabled ? 'disabled' : this.receiver && !this.receiverError ? 'active' : this.receiverError || (this.client ? 'failed' : 'waiting_for_login'), downloads: this.store.snapshot() }
  }

  /**
   * The login as the views see it: a restore that is token-logging a saved session (no QR login in progress) reads `restoring`.
   * A restore that only finds no saved session (no file, no token) never reads `restoring`: the views would show "正在恢復已儲存的
   * LINE 登入…" and hide 登入 LINE when there is nothing to restore, and a concurrent poll would mask the real state (e.g. LOGIN_TIMEOUT).
   */
  private loginView(): LoginState | { status: 'authenticated' } | { status: 'restoring' } {
    if (this.client) return { status: 'authenticated' }
    if (this.restoringSaved !== null && !this.loginController && !this.loginCommitting) return { status: 'restoring' }
    return this.loginState
  }

  /** A QR login is in progress (pending, QR or PIN shown, or committing its session). Background import defers its backlog drain meanwhile. */
  loginActive(): boolean { return !this.disposed && (this.loginController !== null || this.loginCommitting) }

  /**
   * Ends login `generation` (if it is still the current one). Called in the same synchronous step that publishes the login's outcome, so
   * no caller ever sees `authenticated` / `failed` while loginActive() (the watcher's deferDrain) still answers true or startLogin() would
   * answer `joined` to a login that is already over.
   */
  private endLogin(generation: number) {
    if (generation !== this.loginGeneration) return
    this.loginController = null
    if (this.loginTimer) clearTimeout(this.loginTimer)
    this.loginTimer = null
  }

  async startLogin() {
    if (this.disposed) throw new Error('service disposed')
    if (this.client) return { status: 'authenticated' }
    // joined: another view (settings / chat dialog) started this login; the caller shows it but must not cancel it (REV-CL-003).
    if (this.loginController) return { status: 'pending', joined: true }
    const generation = ++this.loginGeneration
    const controller = new AbortController()
    this.loginController = controller
    this.loginState = { status: 'pending' }
    const storagePath = path.join(this.dataDir, 'linejs-login-attempt.json')
    const attemptGuard = guardedStorage(this.storage(storagePath))
    this.loginStorageGuard = attemptGuard
    const current = () => generation === this.loginGeneration && !controller.signal.aborted && !this.disposed
    const armTimeout = () => {
      if (this.loginTimer) clearTimeout(this.loginTimer)
      this.loginTimer = setTimeout(() => { if (generation === this.loginGeneration) void this.cancelLogin('LOGIN_TIMEOUT') }, this.loginTimeoutMs)
    }
    armTimeout()
    void this.qrLogin({
      onReceiveQRUrl: async (url: string) => {
        if (!current()) return
        const qr = await this.encodeQr(url)
        // a PIN that arrived while the QR was being encoded wins: the QR was already scanned
        if (current() && !this.loginState.pin) this.loginState = { status: 'pending', qr }
      },
      // After the scan LINE may ask for a PIN typed on the phone (LINEJS requestSQR2: verifyCertificate failed → createPinCode → "pincall";
      // it then long-polls checkPinCodeVerified). The PIN replaces the QR in the login state (memory only, never logged or written) and the
      // login gets a fresh LOGIN_TIMEOUT_MS window to type it.
      onPincodeRequest: (value: string) => {
        const pin = SAFE_PIN(value)
        if (!current() || !pin) return
        this.loginState = { status: 'pending', pin }
        armTimeout()
      }
    }, { device: 'ANDROIDSECONDARY', storage: attemptGuard.storage, fetch: this.fetch(controller.signal) })
      .then(async (client: any) => {
        // A cancel (user, 120 s timeout, logout) or dispose can complete during any await below: re-check after each one, otherwise a
        // cancelled login would still become the live session (and the identity outbound sends use). REVIEW-LOGIN-CANCEL-COMMIT-001.
        const cancelled = () => generation !== this.loginGeneration || controller.signal.aborted || this.disposed
        if (cancelled()) return
        attemptGuard.deactivate()
        await attemptGuard.drain()
        if (cancelled()) return
        if (!client.authToken) throw Object.assign(new Error('LINE 登入沒有回傳 session'), { code: 'LOGIN_RESULT_MISSING' })
        // While the session file is being committed no restore may read it (a cancel's own status() would otherwise restore the cancelled token).
        this.loginCommitting = true
        try {
          await rename(storagePath, this.file)
          if (cancelled()) {
            // The rename won the race against the cancel's cleanup: fence any restore already in flight, then drop the committed session,
            // so the cancelled account never becomes a client.
            this.sessionEpoch++
            this.restoreController?.abort()
            await unlink(this.file).catch(() => {})
            return
          }
          const sessionStorage = this.storage()
          ;(client.base as any).storage = sessionStorage
          client.base.on?.('update:authtoken', (token: string) => void sessionStorage.set(TOKEN_KEY, token))
          this.installClient(client, new AbortController())
        } finally { this.loginCommitting = false }
        this.store.setOwner(client.base?.profile?.mid || 'unknown-account')
        // installClient above already made the views read `authenticated` (loginView): the login ends in this same synchronous step.
        this.loginState = { status: 'authenticated' }
        this.endLogin(generation)
        await this.removeLoginAttempt()
        if (this.enabled) this.startReceiver(client)
      })
      .catch(async (error: unknown) => {
        // Clean up first, then publish: `failed` becomes visible only once the attempt is gone and the login has ended, so a 重試 right
        // after it starts a fresh login instead of joining this dead one (and the backlog drain is no longer deferred by it).
        attemptGuard.deactivate()
        await attemptGuard.drain()
        await this.removeLoginAttempt()
        if (generation === this.loginGeneration) { this.loginState = { status: 'failed', error: SAFE_ERROR(error) }; this.endLogin(generation) }
      })
      .finally(async () => { attemptGuard.deactivate(); await attemptGuard.drain(); if (this.loginStorageGuard === attemptGuard) this.loginStorageGuard = null; this.endLogin(generation) })
    return { status: 'pending' }
  }

  private async removeLoginAttempt() { await unlink(path.join(this.dataDir, 'linejs-login-attempt.json')).catch(() => {}) }
  async cancelLogin(reason = 'LOGIN_CANCELLED') {
    this.loginGeneration++
    this.loginController?.abort()
    this.loginController = null
    if (this.loginTimer) clearTimeout(this.loginTimer)
    this.loginTimer = null
    this.loginStorageGuard?.deactivate()
    await this.loginStorageGuard?.drain()
    this.loginStorageGuard = null
    this.loginState = reason === 'LOGIN_TIMEOUT' ? { status: 'failed', error: { code: reason, message: 'LINE 登入逾時，請重新開始。' } } : { status: 'cancelled' }
    await this.removeLoginAttempt()
    return this.status()
  }

  /**
   * The LINEJS listen loop, kept only for the account and session state (X2b, Q3 = 以電腦版訊息為準): it keeps the session in use, LINEJS
   * refreshes the token from it (update:authtoken), and a failing loop shows as the receiver's error in status(). Media are no longer
   * downloaded from these events: new photos, videos and files come from the desktop LINE rows the app DB persists (linejsReceive.ts →
   * OriginalDownloadService.enqueue, origin receive), so the 'message' handler does nothing with a message.
   */
  private startReceiver(client: any) {
    if (!this.enabled || this.receiver || this.disposed) return
    const controller = new AbortController()
    const handler = (_message: unknown) => { /* account / session state only: no download, no store write (X2b) */ }
    this.receiver = { handler, controller }
    this.receiverError = null
    client.on('message', handler)
    try {
      // The listen loop (and every 'message' it emits) runs in a receive context of its own, also when startReceiver is reached from an
      // outbound send's restore: LINEJS decryption from here can never register a group key (R-07), and stops calling LINE once stopped.
      runInLineJsContext('receive', () => client.listen({ talk: true, square: false, signal: controller.signal }), controller.signal).catch((error: unknown) => { if (this.receiver?.controller === controller) { this.receiverError = SAFE_ERROR(error).message } })
    } catch (error) { this.receiverError = SAFE_ERROR(error).message }
  }

  /** The receive switch (persisted in linejs-settings.json). */
  receiveEnabled(): boolean { return !this.disposed && !this.unavailableReason && this.enabled }

  /** Observe the receive switch: the listener gets the new value only when it actually changes (an off → on is a fresh start, X2b). */
  onReceiveEnabledChange(listener: (enabled: boolean) => void): () => void {
    this.receiveListeners.add(listener)
    return () => { this.receiveListeners.delete(listener) }
  }

  async setReceiveEnabled(enabled: boolean) {
    const before = this.enabled
    this.enabled = Boolean(enabled)
    const target = path.join(this.dataDir, 'linejs-settings.json')
    const temp = `${target}.${randomUUID()}.part`
    await writeFile(temp, JSON.stringify({ receiveEnabled: this.enabled }), { flag: 'wx', mode: 0o600 })
    try { await rename(temp, target) } catch (error) { await unlink(temp).catch(() => {}); throw error }
    if (before !== this.enabled) for (const listener of [...this.receiveListeners]) { try { listener(this.enabled) } catch { /* observers never break the switch */ } }
    if (!this.enabled) { this.detachReceiver(); this.receiver = null }
    else { const client = await this.restore(); if (client) this.startReceiver(client) }
    return this.status()
  }

  /**
   * Stops the receive loop and removes its 'message' listener — only when a receiver exists: off('message', undefined) is never called
   * (an emitter that rejects an undefined listener would otherwise throw and skip the rest of dispose / logout, e.g. store.close).
   */
  private detachReceiver() {
    const receiver = this.receiver
    if (!receiver) return
    receiver.controller.abort()
    this.client?.off?.('message', receiver.handler)
  }

  /** v1 retry: the v1 download path is off (X2b), so this answers `disabled` and schedules nothing; the item can be downloaded via 下載原檔. */
  async retry(key: string) {
    return this.store.retry(key)
  }

  async exportChunk(key: string, offset: number, length: number) {
    if (this.disposed || this.unavailableReason) throw Object.assign(new Error('下載服務目前無法使用'), { code: 'LINEJS_MEDIA_UNAVAILABLE' })
    if (typeof key !== 'string' || key.length > 1024 || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length < 1 || length > MAX_SAVED_FILE_CHUNK_BYTES) throw Object.assign(new Error('附件讀取範圍無效'), { code: 'INVALID_FILE_RANGE' })
    const result = await this.store.readSavedChunk(key, offset, length)
    if (!result) throw Object.assign(new Error('找不到可匯出的已完成附件'), { code: 'SAVED_FILE_UNAVAILABLE' })
    return result
  }

  async logout() {
    await this.cancelLogin()
    this.sessionEpoch++
    this.restoreController?.abort()
    this.restoreController = null
    this.clientController?.abort()
    this.clientController = null
    this.detachReceiver()
    this.receiver = null
    this.clearClient()
    await unlink(this.file).catch(() => {})
    this.loginState = { status: 'idle' }
    return this.status()
  }

  async dispose() {
    this.disposed = true
    // The client reference stays (receive/download behaviour unchanged); only the outbound fencing token is withdrawn.
    this.sessionId = null
    this.notifySession()
    this.sessionListeners.clear()
    this.receiveListeners.clear()
    this.loginGeneration++
    this.loginController?.abort()
    if (this.loginTimer) clearTimeout(this.loginTimer)
    // the QR / PIN of an unfinished login do not outlive the service (memory only, nothing to erase on disk)
    if (this.loginState.status === 'pending') this.loginState = { status: 'cancelled' }
    this.loginStorageGuard?.deactivate()
    await this.loginStorageGuard?.drain()
    this.restoreController?.abort()
    this.clientController?.abort()
    this.clientController = null
    this.detachReceiver()
    await this.store.close()
  }
}
