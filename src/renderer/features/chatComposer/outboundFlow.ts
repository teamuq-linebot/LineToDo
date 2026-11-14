/**
 * outboundFlow.ts — 聊天室輸入列的送出流程（不含 React）：一個聊天室一個 flow（ChatComposer 以 key={chatId} 掛載）。
 *
 *   status → idle／需登入／帳號不符／無法使用；按下傳送（只有使用者動作會呼叫 sendText／sendAttachment）：
 *   文字：send → job 輪詢；附件：讀檔 → 整檔 sha256 → begin → stageChunk×N（每塊 sha256，傳輸不確定時重送同一塊＝冪等）→ send → job 輪詢。
 *
 * 送出呼叫失敗時：backend 明確拒絕（in-band 錯誤碼）＝未送出；傳輸層不確定（逾時、host 錯誤）＝以 job({fence:true}) 查詢，
 * 查無即 backend 寫 tombstone，之後同 requestId 不可能再送出，所以可判定未送出；查詢也失敗＝本地「無法確認」。
 * 結果「無法確認」時這個聊天室鎖定，直到使用者按「我已確認」；永遠不自動重送。
 */
import { OUTBOUND_IMAGE_MIMES, OUTBOUND_LIMITS, isTalkMid, outboundTextError } from '../../../shared/linejsOutbound'
import type { LineJsOutboundControl, OutboundAttachmentKind, OutboundJobView, OutboundKind, OutboundStatusView } from '../../../shared/linejsOutbound'
import { Sha256, sha256Hex } from '../../../shared/sha256'

export type ComposerPhase = 'loading' | 'unavailable' | 'needs_login' | 'blocked' | 'idle' | 'sending' | 'sent' | 'failed' | 'unknown'

export interface ComposerState {
  phase: ComposerPhase
  /** needs_login：LINE 連線正在恢復中。 */
  restoring?: boolean
  blockedReason?: 'account_mismatch' | 'account_unverified' | 'chat_unsupported'
  step?: 'reading' | 'staging' | 'sending'
  /** 附件準備進度（0–100）。 */
  progress?: number
  code?: string
  jobPhase?: string
  detail?: string
  kind?: OutboundKind
  size?: number
  messageId?: string
  requestId?: string
  at?: number
  /** 「無法確認」是 view 自己判定的（送出後失聯、查詢也失敗），backend 可能沒有紀錄。 */
  local?: boolean
}

export interface OutboundAttachment { name: string; type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }

export interface OutboundFlowOptions {
  control: LineJsOutboundControl
  chatId: string
  onChange(state: ComposerState): void
  now?(): number
  sleep?(ms: number): Promise<void>
  randomBytes?(length: number): Uint8Array
  /** job 輪詢間隔（ms）。 */
  pollMs?: number
  /** 需登入／帳號不符時重新查 status 的間隔（ms）。 */
  statusPollMs?: number
}

export interface OutboundFlow {
  state(): ComposerState
  /** 掛載時：查 status，續追進行中的送出、顯示未解決的「無法確認」。 */
  refresh(): Promise<void>
  sendText(text: string): Promise<void>
  sendAttachment(file: OutboundAttachment): Promise<void>
  /** 「我已確認」：解除這個聊天室的「無法確認」鎖定。 */
  acknowledge(): Promise<void>
  /** 使用者開始編輯新內容：收起「已送出／傳送失敗」的提示。 */
  dismiss(): void
  dispose(): void
}

/** backend 明確回答（in-band）或請求根本沒有送出的錯誤碼：都代表「沒有送出」。其餘（host 錯誤、逾時、無效回應）一律要 fence 查詢。 */
const NOT_SENT_CODES: ReadonlySet<string> = new Set([
  'INVALID_REQUEST_ID', 'INVALID_KIND', 'INVALID_CHAT', 'CHAT_NOT_FOUND', 'CHAT_UNSUPPORTED', 'ACCOUNT_MISMATCH', 'ACCOUNT_UNVERIFIED', 'SESSION_NOT_READY',
  'SESSION_CHANGED', 'INVALID_TEXT', 'TEXT_TOO_LONG', 'EMPTY_FILE', 'ATTACHMENT_TOO_LARGE', 'INVALID_IMAGE_TYPE', 'STAGE_BUSY', 'STAGE_EXPIRED',
  'STAGE_OFFSET_MISMATCH', 'STAGE_CHUNK_INVALID', 'STAGE_INTEGRITY_MISMATCH', 'STAGE_INCOMPLETE', 'STAGE_IO', 'OUTBOUND_BUSY', 'CHAT_UNRESOLVED_UNKNOWN',
  'JOURNAL_FULL', 'JOURNAL_IO', 'ALREADY_DISPATCHED', 'REQUEST_ID_CONFLICT', 'REQUEST_FENCED', 'SDK_UNAVAILABLE', 'linejs_outbound_unavailable', 'invalid_args',
  'request_too_large', 'backend_stopped', 'cancelled', 'path_unknown', 'method_unknown', 'method_mismatch'
])
/** 這些 status 失敗不會自己好（沒有這個功能）：不再輪詢。 */
const PERMANENT_UNAVAILABLE: ReadonlySet<string> = new Set(['linejs_outbound_unavailable', 'path_unknown', 'method_unknown', 'method_mismatch', 'backend_method_not_allowed'])
const IMAGE_MIMES: ReadonlySet<string> = new Set(OUTBOUND_IMAGE_MIMES)
const TERMINAL = new Set(['completed', 'failed', 'unknown', 'acknowledged', 'not_received'])
/** 送出失敗的原因是 session／帳號：重新查 status（拿新的 sessionId，或改顯示需登入／帳號不符）。 */
const SESSION_CODES: ReadonlySet<string> = new Set(['SESSION_CHANGED', 'SESSION_NOT_READY', 'ACCOUNT_MISMATCH', 'ACCOUNT_UNVERIFIED', 'linejs_outbound_unavailable'])
const MAX_POLL_FAILURES = 20
const CHUNK_ATTEMPTS = 3
const FENCE_ATTEMPTS = 3

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'unknown_error'
}

/** 確定沒有送出？host 層錯誤（PluginBackendError）即使錯誤碼長得像也不算：那次呼叫可能已經在 backend 執行。 */
function definitelyNotSent(error: unknown): boolean {
  if ((error as { name?: unknown } | null)?.name === 'PluginBackendError') return false
  return NOT_SENT_CODES.has(errorCode(error))
}

function uuid4(randomBytes: (length: number) => Uint8Array): string {
  const b = randomBytes(16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = Array.from(b, (value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x2000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x2000))
  return btoa(binary)
}

export function attachmentKind(type: string): OutboundAttachmentKind {
  return IMAGE_MIMES.has(String(type).toLowerCase()) ? 'image' : 'file'
}

/** 選檔當下就能判定的問題（backend 仍會重驗）。 */
export function attachmentError(file: { size: number }): string | null {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) return 'EMPTY_FILE'
  if (file.size > OUTBOUND_LIMITS.attachmentMaxBytes) return 'ATTACHMENT_TOO_LARGE'
  return null
}

export function createOutboundFlow(options: OutboundFlowOptions): OutboundFlow {
  const { control, chatId } = options
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  const randomBytes = options.randomBytes ?? ((length: number) => globalThis.crypto.getRandomValues(new Uint8Array(length)))
  const pollMs = options.pollMs ?? 1000
  const statusPollMs = options.statusPollMs ?? 10_000
  let current: ComposerState = { phase: 'loading' }
  let sessionId: string | null = null
  let busy = false
  let disposed = false
  let refreshing: Promise<void> | null = null
  let statusTimer: ReturnType<typeof setTimeout> | null = null
  /** 同時只追一個 job：新的追蹤會讓舊的停下。 */
  let followToken = 0

  const set = (next: ComposerState): void => {
    if (disposed) return
    current = next
    options.onChange(next)
  }

  const scheduleStatus = (): void => {
    if (disposed || statusTimer) return
    statusTimer = setTimeout(() => { statusTimer = null; void refresh() }, statusPollMs)
  }
  const clearStatusTimer = (): void => { if (statusTimer) { clearTimeout(statusTimer); statusTimer = null } }

  const fromJob = (job: OutboundJobView, local = false): ComposerState => {
    const base = { requestId: job.requestId, kind: job.kind, size: job.size, at: job.updatedAt }
    switch (job.status) {
      case 'completed': return { ...base, phase: 'sent', messageId: job.result?.messageId }
      case 'failed': return { ...base, phase: 'failed', code: job.error?.code ?? 'SEND_PREPARATION_FAILED', jobPhase: job.error?.phase, detail: job.error?.detail }
      case 'not_received': return { ...base, phase: 'failed', code: 'NOT_RECEIVED' }
      case 'unknown': return { ...base, phase: 'unknown', code: job.error?.code ?? 'SEND_RESULT_UNKNOWN', jobPhase: job.error?.phase, local }
      case 'acknowledged': return { phase: 'idle' }
      default: return { ...base, phase: 'sending', step: 'sending' }
    }
  }

  const applyStatus = (view: OutboundStatusView): void => {
    sessionId = view.session.sessionId
    const state = view.session.state
    if (state === 'unavailable') { set({ phase: 'unavailable' }); return }
    if (state === 'not_logged_in' || state === 'restoring') { set({ phase: 'needs_login', restoring: state === 'restoring' }); scheduleStatus(); return }
    if (state === 'account_mismatch' || state === 'account_unverified') { set({ phase: 'blocked', blockedReason: state }); scheduleStatus(); return }
    const running = view.chat?.running ?? null
    const unresolved = view.chat?.unresolved ?? []
    if (running) { void follow(running); return }
    if (unresolved.length > 0) { set(fromJob(unresolved[0])); return }
    // 已送出／傳送失敗的提示留著，直到使用者開始編輯新內容
    if (current.phase !== 'sent' && current.phase !== 'failed') set({ phase: 'idle' })
  }

  /**
   * 畫面端放棄等待（view_call_timeout）之後才到的 status（fix2）：只採用「已有 session」的回覆——沒有 session／恢復中／無法使用可能已經過時，
   * 等下一次輪詢就好；而且只在還沒有更新的查詢在跑、沒有送出進行中、輸入列還停在「讀取中／需登入／無法使用」時。
   * 這讓 host 轉送很慢時，登入完成仍能讓輸入列變成可傳送，登入彈窗也因此收起（REV-CL-001 的 sessionReady）。
   */
  const lateStatus = (view: OutboundStatusView): void => {
    if (disposed || busy || refreshing) return
    const state = view?.session?.state
    if (!state || state === 'not_logged_in' || state === 'restoring' || state === 'unavailable') return
    if (current.phase !== 'loading' && current.phase !== 'needs_login' && current.phase !== 'unavailable') return
    clearStatusTimer()
    applyStatus(view)
  }

  async function refresh(): Promise<void> {
    if (disposed) return
    if (!isTalkMid(chatId)) { set({ phase: 'blocked', blockedReason: 'chat_unsupported' }); return }
    if (busy) return
    if (refreshing) return refreshing
    clearStatusTimer()
    refreshing = (async () => {
      try {
        applyStatus(await control.status({ chatId }, { onLate: lateStatus }))
      } catch (error) {
        set({ phase: 'unavailable', code: errorCode(error) })
        if (!PERMANENT_UNAVAILABLE.has(errorCode(error))) scheduleStatus()
      } finally { refreshing = null }
    })()
    return refreshing
  }

  /** 追一個已在 backend 的送出，直到有結果；輪詢一直失敗＝本地「無法確認」（backend 紀錄仍在，下次 status 會恢復）。 */
  async function follow(job: OutboundJobView): Promise<void> {
    const token = ++followToken
    let view = job
    let failures = 0
    let waited = 0
    while (!disposed && token === followToken && !TERMINAL.has(view.status)) {
      set({ ...fromJob(view), phase: 'sending', step: 'sending' })
      const delay = waited < 10_000 ? pollMs : pollMs * 3
      await sleep(delay)
      waited += delay
      if (disposed || token !== followToken) return
      try {
        view = await control.job({ requestId: job.requestId, chatId })
        failures = 0
      } catch {
        failures++
        if (failures >= MAX_POLL_FAILURES) { set({ requestId: job.requestId, kind: job.kind, size: job.size, phase: 'unknown', code: 'LOCAL_UNKNOWN', local: true, at: now() }); return }
      }
    }
    if (disposed || token !== followToken) return
    // 追的是 backend 已登記（可能已呼叫 SDK）的送出：之後查不到（backend 重啟後 journal 讀不懂或被刪）不代表沒送出 → 本地「無法確認」，不是「傳送失敗」
    if (view.status === 'not_received') { set({ requestId: job.requestId, kind: job.kind, size: job.size, phase: 'unknown', code: 'RECORD_LOST', local: true, at: now() }); return }
    set(fromJob(view))
  }

  /** 送出呼叫的結果不確定：fence 查詢（查無＝backend 寫 tombstone，確定未送出）。 */
  async function fence(requestId: string, kind: OutboundKind, size?: number): Promise<void> {
    for (let attempt = 0; attempt < FENCE_ATTEMPTS && !disposed; attempt++) {
      try {
        const view = await control.job({ requestId, chatId, fence: true })
        if (view.status === 'not_received') { set({ phase: 'failed', code: 'NOT_RECEIVED', requestId, kind, size, at: now() }); return }
        await follow(view)
        return
      } catch {
        await sleep(1000 * 2 ** attempt)
      }
    }
    set({ phase: 'unknown', code: 'LOCAL_UNKNOWN', local: true, requestId, kind, size, at: now() })
  }

  const startSend = (): boolean => {
    if (disposed || busy) return false
    if (current.phase !== 'idle' && current.phase !== 'sent' && current.phase !== 'failed') return false
    if (!sessionId) return false
    busy = true
    followToken++
    clearStatusTimer()
    return true
  }

  async function submit(requestId: string, kind: OutboundKind, extra: { text?: string; stageId?: string }, size?: number): Promise<void> {
    set({ phase: 'sending', step: 'sending', requestId, kind, size })
    let job: OutboundJobView
    try {
      job = await control.send({ requestId, chatId, sessionId: sessionId as string, kind, ...extra })
    } catch (error) {
      if (definitelyNotSent(error)) { set({ phase: 'failed', code: errorCode(error), requestId, kind, size, at: now() }); return }
      await fence(requestId, kind, size)
      return
    }
    await follow(job)
  }

  async function sendText(text: string): Promise<void> {
    const invalid = outboundTextError(text)
    if (invalid) { if (!busy) set({ phase: 'failed', code: invalid, kind: 'text', at: now() }); return }
    if (!startSend()) return
    try {
      await submit(uuid4(randomBytes), 'text', { text })
    } finally { busy = false }
    afterSend()
  }

  function afterSend(): void {
    if (current.phase === 'failed' && current.code && SESSION_CODES.has(current.code)) void refresh()
  }

  async function sendAttachment(file: OutboundAttachment): Promise<void> {
    const kind = attachmentKind(file.type)
    const invalid = attachmentError(file) ?? (kind === 'image' && !IMAGE_MIMES.has(file.type.toLowerCase()) ? 'INVALID_IMAGE_TYPE' : null)
    if (invalid) { if (!busy) set({ phase: 'failed', code: invalid, kind, size: file.size, at: now() }); return }
    if (!startSend()) return
    const requestId = uuid4(randomBytes)
    let stageId: string | null = null
    try {
      set({ phase: 'sending', step: 'reading', progress: 0, requestId, kind, size: file.size })
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (bytes.length !== file.size) { set({ phase: 'failed', code: 'STAGE_INTEGRITY_MISMATCH', requestId, kind, size: file.size, at: now() }); return }
      const hash = new Sha256()
      for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
        hash.update(bytes.subarray(offset, offset + 1024 * 1024))
        if (disposed) return
        await sleep(0) // 讓畫面有機會更新
      }
      const digest = hash.digestHex()
      let begun
      try {
        begun = await control.begin({ requestId, chatId, sessionId: sessionId as string, kind, filename: file.name || '附件', mime: file.type || 'application/octet-stream', size: bytes.length, sha256: digest })
      } catch (error) {
        set({ phase: 'failed', code: definitelyNotSent(error) ? errorCode(error) : 'STAGE_IO', requestId, kind, size: file.size, at: now() })
        return
      }
      stageId = begun.stageId
      const chunkBytes = Math.min(Math.max(1, begun.chunkBytes), OUTBOUND_LIMITS.chunkBytes)
      for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
        if (disposed) return
        const chunk = bytes.subarray(offset, offset + chunkBytes)
        const request = { stageId, requestId, sessionId: sessionId as string, offset, data: toBase64(chunk), sha256: sha256Hex(chunk) }
        let lastError: unknown = null
        let done = false
        for (let attempt = 0; attempt < CHUNK_ATTEMPTS && !done; attempt++) {
          try { await control.stageChunk(request); done = true } catch (error) {
            lastError = error
            if (definitelyNotSent(error)) break // backend 明確拒絕：重送同一塊也不會好
          }
        }
        if (!done) {
          set({ phase: 'failed', code: definitelyNotSent(lastError) ? errorCode(lastError) : 'STAGE_IO', requestId, kind, size: file.size, at: now() })
          return
        }
        set({ phase: 'sending', step: 'staging', progress: Math.floor(((offset + chunk.length) / bytes.length) * 100), requestId, kind, size: file.size })
      }
      const staged = stageId
      stageId = null // 交給 send：backend 讀入後自己刪
      await submit(requestId, kind, { stageId: staged }, file.size)
    } catch {
      set({ phase: 'failed', code: 'STAGE_IO', requestId, kind, size: file.size, at: now() })
    } finally {
      busy = false
      if (stageId) void control.discard({ stageId, requestId }).catch(() => undefined)
      afterSend()
    }
  }

  async function acknowledge(): Promise<void> {
    if (disposed || current.phase !== 'unknown' || busy) return
    const { requestId, local } = current
    busy = true
    try {
      if (!local && requestId) await control.acknowledge({ requestId, chatId })
      current = { phase: 'loading' }
    } catch (error) {
      set({ ...current, detail: errorCode(error) })
      return
    } finally { busy = false }
    await refresh()
  }

  return {
    state: () => current,
    refresh,
    sendText,
    sendAttachment,
    acknowledge,
    dismiss: () => { if (current.phase === 'sent' || current.phase === 'failed') set({ phase: 'idle' }) },
    dispose: () => {
      disposed = true
      followToken++
      clearStatusTimer()
    }
  }
}
