/**
 * linejsOutbound.ts — 聊天室手動送出（文字／單張圖片／單一檔案）的 backend 服務。
 *
 * 只經 ports 存取 LINEJS session（LineJsMediaService：同一個 QR 登入的 client）、本機 LINE 帳號（lineAccess snapshot）與 app DB 的聊天室。
 *
 *   - journal（<dataDir>/linejs-outbound/journal.json）是權威：SDK 呼叫前先以 running 寫入；寫不進去＝明確未送出（JOURNAL_IO）。
 *     不存文字、檔名、chatId、帳號 mid 原值、token；chat／owner 只存加鹽雜湊（chatKey／ownerKey）。
 *   - 附件以 begin → stageChunk×N（依序、每塊 sha256）→ send(stageId) 傳到 staging/<stageId>.part；send 前比對大小與整檔 sha256，
 *     圖片以內容嗅探決定格式。staging 只在記憶體登記：init 清空、TTL、session 變更、dispose 都刪除。
 *   - 成功＝SDK 回傳非空字串訊息 ID；可證明未送出的錯誤＝failed；其餘一律 unknown（不自動重送；使用者按「我已確認」才解除該聊天室鎖定）。
 *   - fencing：每次安裝 client 有新 sessionId；begin／stageChunk／send 與 SDK 呼叫前一刻都比對。requestId 冪等；fence 查詢寫 tombstone。
 *   - 對 view 的錯誤只有固定錯誤碼＋固定文案（{__fail}）；SDK 的 error.message 永遠不外傳、不寫 log。
 */
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  OUTBOUND_IMAGE_MIMES, OUTBOUND_LIMITS, isOutboundRequestId, isSha256Hex, isTalkMid, isUnsupportedChatId, outboundErrorText, outboundTextError
} from '../../shared/linejsOutbound'
import type {
  OutboundAckRequest, OutboundBeginRequest, OutboundBeginResult, OutboundChunkRequest, OutboundChunkResult, OutboundDiscardRequest,
  OutboundJobError, OutboundJobRequest, OutboundJobStatus, OutboundJobView, OutboundKind, OutboundPhase, OutboundSendRequest,
  OutboundSessionState, OutboundStatusView
} from '../../shared/linejsOutbound'
import type { LineJsOutboundPeek, LineJsOutboundSession } from './linejsMedia'
import { runInLineJsContext } from './linejsObs'

export interface OutboundFail { __fail: true; code: string; message: string }
type Result<T> = T | OutboundFail

export interface OutboundSessionPort {
  outboundPeek(): Promise<LineJsOutboundPeek>
  outboundSession(): Promise<LineJsOutboundSession | null>
  currentSessionId(): string | null
  isCurrentSession(sessionId: string, client: unknown): boolean
  onSessionChange?(listener: (sessionId: string | null) => void): () => void
}

export interface LineJsOutboundOptions {
  dataDir: string
  session: OutboundSessionPort
  /** 本機 LINE（桌面版 DB）的帳號 mid；讀不到回 null（fail-closed：ACCOUNT_UNVERIFIED）。 */
  localAccountMid(): Promise<string | null>
  /** chatId 是否是 app DB 裡的聊天室。 */
  chatKnown(chatId: string): Promise<boolean>
  /** 圖片內容嗅探（linejsAutoDownload.detectSupportedImageMime）：回 image/* 或 null。 */
  imageSniff(bytes: Uint8Array): string | null
  now?(): number
  watchdogMs?: number
  /** 同一 session 的 stage 多久沒有新塊就視為放棄（新的 begin 可取代）。 */
  stageIdleMs?: number
  log?(line: string): void
  /**
   * X3（implementation-plan.md §4）：照片／檔案送出成功（completed，SDK 回了訊息 id）之後，把還在記憶體裡的位元組交出去保存
   * （assemble 接到 OriginalDownloadService.saveOutbound：共用 sink、origin outbound、ledger v2）。結果是 unknown／failed 時不呼叫。
   * 在 settle 之後呼叫、不等待：它的成敗與錯誤都不影響送出結果（錯誤只記 code）。
   */
  onSent?(sent: OutboundSent): void | Promise<unknown>
  /** 測試用：running 寫入 journal 之後、SDK 呼叫之前。 */
  hooks?: { afterRunningJournal?(requestId: string): Promise<void> | void }
}

/** 送出成功的附件（X3）：`messageId` 是 SDK 回傳的 LINE 訊息 id；`body` 是送出的位元組（圖片的 mime 是嗅探結果）。 */
export interface OutboundSent { messageId: string; kind: 'image' | 'file'; chatId: string; ownerMid: string; body: Buffer; mime: string; filename: string }

interface JobRecord {
  requestId: string
  kind?: OutboundKind
  ownerKey: string
  chatKey: string
  sessionId: string
  status: OutboundJobStatus
  size?: number
  messageId?: string
  error?: OutboundJobError
  createdAt: number
  updatedAt: number
}

interface Stage {
  stageId: string
  requestId: string
  sessionId: string
  chatKey: string
  kind: 'image' | 'file'
  filename: string
  mime: string
  size: number
  sha256: string
  received: number
  lastChunk: { offset: number; length: number; sha256: string } | null
  expiresAt: number
  lastActivity: number
  file: string
  lock: Promise<void>
}

interface Payload { chatId: string; text?: string; body?: Buffer; mime?: string; filename?: string }

const DIR = 'linejs-outbound'
const JOURNAL = 'journal.json'
const KEY_PREFIX = 'linejs-outbound-v1\0'
const TERMINAL: ReadonlySet<OutboundJobStatus> = new Set(['completed', 'failed', 'acknowledged', 'not_received'])
const STATUSES: ReadonlySet<string> = new Set(['running', 'completed', 'failed', 'unknown', 'acknowledged', 'not_received'])
const KINDS: ReadonlySet<string> = new Set(['text', 'image', 'file'])
const PHASES: ReadonlySet<string> = new Set(['validation', 'session_guard', 'sdk_prepare', 'sdk_send', 'sdk_result', 'restart', 'watchdog'])
const IMAGE_MIMES: ReadonlySet<string> = new Set(OUTBOUND_IMAGE_MIMES)
const IMAGE_EXT: Readonly<Record<string, string>> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const KEY = /^[0-9a-f]{32}$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const SAFE_DETAIL = /^[A-Z0-9_]{1,50}$/

const fail = (code: string): OutboundFail => ({ __fail: true, code, message: outboundErrorText(code) })
const isFail = (value: unknown): value is OutboundFail => typeof value === 'object' && value !== null && (value as OutboundFail).__fail === true
const keyOf = (...parts: string[]): string => createHash('sha256').update(KEY_PREFIX + parts.join('\0')).digest('hex').slice(0, 32)
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

function safeName(value: string): string {
  const raw = String(value || '附件').slice(0, 1024).split(/[\\/]/).at(-1)!.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim().replace(/[. ]+$/g, '')
  let name = raw || '附件'
  while (Buffer.byteLength(name, 'utf8') > OUTBOUND_LIMITS.filenameMaxBytes) name = [...name].slice(0, -1).join('')
  return name || '附件'
}

function safeMime(value: string): string {
  const mime = String(value || '').trim().toLowerCase()
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(mime) ? mime : 'application/octet-stream'
}

function imageName(filename: string, mime: string): string {
  const base = safeName(filename).replace(/\.[^.]*$/, '') || 'image'
  return safeName(`${base}.${IMAGE_EXT[mime] ?? 'jpg'}`)
}

/** base64 必須可逆（重新編碼完全相同），避免寬鬆解碼吞掉字元。 */
function decodeBase64(data: string): Buffer | null {
  if (typeof data !== 'string' || data.length % 4 !== 0 || !BASE64.test(data)) return null
  const bytes = Buffer.from(data, 'base64')
  return bytes.toString('base64') === data ? bytes : null
}

/** 被 SDK 拒絕的錯誤裡，只有白名單格式的 code 能當「詳細」。 */
function rejectDetail(error: unknown): string | undefined {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code
  const text = typeof code === 'string' || typeof code === 'number' ? String(code) : ''
  return SAFE_DETAIL.test(text) ? text : undefined
}

function validRecord(item: unknown): item is JobRecord {
  if (typeof item !== 'object' || item === null) return false
  const r = item as Record<string, unknown>
  if (typeof r.requestId !== 'string' || !UUID.test(r.requestId)) return false
  if (typeof r.status !== 'string' || !STATUSES.has(r.status)) return false
  if (typeof r.ownerKey !== 'string' || (r.ownerKey !== '' && !KEY.test(r.ownerKey))) return false
  if (typeof r.chatKey !== 'string' || (r.chatKey !== '' && !KEY.test(r.chatKey))) return false
  if (typeof r.sessionId !== 'string' || r.sessionId.length > 64) return false
  if (!Number.isFinite(r.createdAt) || !Number.isFinite(r.updatedAt)) return false
  if (r.kind !== undefined && (typeof r.kind !== 'string' || !KINDS.has(r.kind))) return false
  if (r.size !== undefined && !Number.isSafeInteger(r.size)) return false
  if (r.messageId !== undefined && (typeof r.messageId !== 'string' || r.messageId.length > 256)) return false
  if (r.error !== undefined) {
    const e = r.error as Record<string, unknown> | null
    if (!e || typeof e.code !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(e.code) || typeof e.phase !== 'string' || !PHASES.has(e.phase)) return false
    if (e.detail !== undefined && (typeof e.detail !== 'string' || !SAFE_DETAIL.test(e.detail))) return false
  }
  return true
}

export class LineJsOutboundService {
  private readonly opts: LineJsOutboundOptions
  private readonly root: string
  private readonly stageRoot: string
  private readonly journalPath: string
  private readonly records = new Map<string, JobRecord>()
  private readonly stages = new Map<string, Stage>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  /** 因 session 變更而丟掉的 stage（最近 32 個）：之後的 stageChunk 回 SESSION_CHANGED，而不是籠統的 STAGE_EXPIRED。 */
  private readonly droppedForSession: string[] = []
  private writeChain: Promise<void> = Promise.resolve()
  private journalBroken = false
  private disposed = false
  private offSession: (() => void) | null = null

  constructor(opts: LineJsOutboundOptions) {
    this.opts = opts
    this.root = path.join(path.resolve(opts.dataDir), DIR)
    this.stageRoot = path.join(this.root, 'staging')
    this.journalPath = path.join(this.root, JOURNAL)
  }

  private now(): number { return this.opts.now ? this.opts.now() : Date.now() }
  private log(line: string): void { try { this.opts.log?.(`[linejs-outbound] ${line}`) } catch { /* logging never breaks a send */ } }

  // ── lifecycle ──

  /** 讀回 journal（running → unknown／SEND_INTERRUPTED）並清空 staging。讀不懂的 journal 不覆寫：送出以 JOURNAL_IO 停用（fail-closed）。不會 throw。 */
  async init(): Promise<void> {
    try {
      await this.ensureDir(path.dirname(this.root), true)
      await this.ensureDir(this.root, true)
      await this.ensureDir(this.stageRoot, true)
      for (const name of await readdir(this.stageRoot)) {
        if (!/^[0-9a-f-]{36}\.part$/.test(name)) continue
        await this.unlinkRegular(path.join(this.stageRoot, name))
      }
      for (const name of await readdir(this.root)) {
        if (/^journal\.json\.[0-9a-f-]{36}\.tmp$/.test(name)) await this.unlinkRegular(path.join(this.root, name))
      }
      const info = await lstat(this.journalPath).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : Promise.reject(error)))
      if (info) {
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('journal is not a regular file')
        const parsed = JSON.parse(await readFile(this.journalPath, 'utf8')) as { version?: unknown; records?: unknown }
        if (parsed?.version !== 1 || !Array.isArray(parsed.records) || !parsed.records.every(validRecord)) throw new Error('journal is not understood')
        let interrupted = 0
        for (const record of parsed.records as JobRecord[]) {
          if (record.status === 'running') {
            record.status = 'unknown'
            record.error = { code: 'SEND_INTERRUPTED', phase: 'restart' }
            record.updatedAt = this.now()
            interrupted++
          }
          this.records.set(record.requestId, record)
        }
        if (interrupted) await this.persist()
      }
    } catch {
      this.journalBroken = true
      this.log('journal_unavailable')
    }
    this.offSession = this.opts.session.onSessionChange?.(() => { void this.dropStaleStages() }) ?? null
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.offSession?.()
    this.offSession = null
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    await Promise.all([...this.stages.values()].map((stage) => this.removeStage(stage)))
  }

  // ── view API ──

  async status(query: { chatId?: string }): Promise<OutboundStatusView> {
    const peek = this.disposed ? { state: 'unavailable' as const, sessionId: null, ownerMid: null } : await this.peek()
    let state: OutboundSessionState = peek.state
    if (state === 'ready') {
      const local = await this.localMid()
      if (!local) state = 'account_unverified'
      else if (local !== peek.ownerMid) state = 'account_mismatch'
    }
    const view: OutboundStatusView = { session: { state, sessionId: state === 'ready' ? peek.sessionId : null } }
    const chatId = query?.chatId
    if (typeof chatId === 'string' && isTalkMid(chatId) && peek.ownerMid) {
      const chatKey = keyOf(peek.ownerMid, chatId)
      let running: OutboundJobView | null = null
      const unresolved: OutboundJobView[] = []
      for (const record of this.records.values()) {
        if (record.chatKey !== chatKey) continue
        if (record.status === 'running') running = this.view(record)
        else if (record.status === 'unknown') unresolved.push(this.view(record))
      }
      view.chat = { running, unresolved }
    }
    return view
  }

  async begin(request: OutboundBeginRequest): Promise<Result<OutboundBeginResult>> {
    const early = this.gate()
    if (early) return early
    const { requestId, chatId, sessionId, kind, size } = request
    if (!isOutboundRequestId(requestId)) return fail('INVALID_REQUEST_ID')
    if (kind !== 'image' && kind !== 'file') return fail('INVALID_KIND')
    const chatError = this.chatError(chatId)
    if (chatError) return fail(chatError)
    if (!Number.isSafeInteger(size) || size < 0 || !isSha256Hex(request.sha256) || typeof sessionId !== 'string') return fail('invalid_args')
    if (size === 0) return fail('EMPTY_FILE')
    if (size > OUTBOUND_LIMITS.attachmentMaxBytes) return fail('ATTACHMENT_TOO_LARGE')
    const mime = safeMime(request.mime)
    if (kind === 'image' && !IMAGE_MIMES.has(mime)) return fail('INVALID_IMAGE_TYPE')
    const prior = this.records.get(requestId)
    if (prior) return fail(prior.status === 'not_received' ? 'REQUEST_FENCED' : 'ALREADY_DISPATCHED')
    await this.sweepStages()
    const same = this.stageFor(requestId)
    if (same) {
      // 傳輸層重送同一個 begin：同樣的宣告回同一個 stage
      if (same.sessionId === sessionId && same.size === size && same.sha256 === request.sha256 && same.kind === kind) return this.beginResult(same)
      return fail('STAGE_BUSY')
    }
    const session = await this.readySession(sessionId)
    if (isFail(session)) return session
    if (!(await this.chatKnown(chatId))) return fail('CHAT_NOT_FOUND')
    const chatKey = keyOf(session.ownerMid, chatId)
    if (this.hasUnresolved(chatKey)) return fail('CHAT_UNRESOLVED_UNKNOWN')
    const now = this.now()
    for (const other of [...this.stages.values()]) {
      if (other.sessionId !== session.sessionId) continue
      if (now - other.lastActivity < (this.opts.stageIdleMs ?? 2 * 60_000)) return fail('STAGE_BUSY')
      await this.removeStage(other)
    }
    // awaits above: re-check everything that another call could have changed, then reserve synchronously
    const raced = this.records.get(requestId)
    if (raced) return fail(raced.status === 'not_received' ? 'REQUEST_FENCED' : 'ALREADY_DISPATCHED')
    if (this.stageFor(requestId)) return fail('STAGE_BUSY')
    if ([...this.stages.values()].some((other) => other.sessionId === session.sessionId)) return fail('STAGE_BUSY')
    if (!this.opts.session.isCurrentSession(session.sessionId, session.client)) return fail('SESSION_CHANGED')
    const stageId = randomUUID()
    const stage: Stage = {
      stageId, requestId, sessionId: session.sessionId, chatKey, kind, filename: safeName(request.filename), mime, size, sha256: request.sha256,
      received: 0, lastChunk: null, expiresAt: now + OUTBOUND_LIMITS.stageTtlMs, lastActivity: now, file: path.join(this.stageRoot, `${stageId}.part`), lock: Promise.resolve()
    }
    this.stages.set(stageId, stage)
    try {
      await this.ensureDir(this.stageRoot, true)
      await writeFile(stage.file, new Uint8Array(0), { flag: 'wx', mode: 0o600 })
    } catch {
      this.stages.delete(stageId)
      return fail('STAGE_IO')
    }
    return this.beginResult(stage)
  }

  async stageChunk(request: OutboundChunkRequest): Promise<Result<OutboundChunkResult>> {
    const early = this.gate()
    if (early) return early
    const stage = typeof request.stageId === 'string' ? this.stages.get(request.stageId) : undefined
    if (!stage) return fail(this.droppedForSession.includes(request.stageId) ? 'SESSION_CHANGED' : 'STAGE_EXPIRED')
    if (stage.requestId !== request.requestId) return fail('STAGE_EXPIRED')
    if (stage.sessionId !== request.sessionId || this.opts.session.currentSessionId() !== stage.sessionId) { await this.removeStage(stage); return fail('SESSION_CHANGED') }
    if (this.now() > stage.expiresAt) { await this.removeStage(stage); return fail('STAGE_EXPIRED') }
    return this.withStage(stage, async () => {
      if (this.stages.get(stage.stageId) !== stage) return fail('STAGE_EXPIRED')
      const bytes = decodeBase64(request.data)
      if (!bytes || bytes.length === 0 || bytes.length > OUTBOUND_LIMITS.chunkBytes) return fail('STAGE_CHUNK_INVALID')
      const digest = sha256(bytes)
      if (!isSha256Hex(request.sha256) || digest !== request.sha256) return fail('STAGE_CHUNK_INVALID')
      if (!Number.isSafeInteger(request.offset) || request.offset < 0) return fail('STAGE_OFFSET_MISMATCH')
      if (request.offset !== stage.received) {
        const last = stage.lastChunk
        // 剛收過的同一塊再送一次（回應在路上遺失）：冪等成功
        if (last && last.offset === request.offset && last.length === bytes.length && last.sha256 === digest && request.offset + bytes.length === stage.received) return { received: stage.received }
        return fail('STAGE_OFFSET_MISMATCH')
      }
      if (stage.received + bytes.length > stage.size) return fail('STAGE_CHUNK_INVALID')
      try {
        const info = await lstat(stage.file)
        if (!info.isFile() || info.isSymbolicLink() || info.size !== stage.received) throw new Error('stage file changed')
        await appendFile(stage.file, bytes)
      } catch {
        await this.removeStage(stage)
        return fail('STAGE_IO')
      }
      stage.received += bytes.length
      stage.lastChunk = { offset: request.offset, length: bytes.length, sha256: digest }
      stage.lastActivity = this.now()
      if (this.opts.session.currentSessionId() !== stage.sessionId) { await this.removeStage(stage); return fail('SESSION_CHANGED') }
      return { received: stage.received }
    })
  }

  async discard(request: OutboundDiscardRequest): Promise<{ discarded: boolean }> {
    const stage = typeof request.stageId === 'string' ? this.stages.get(request.stageId) : undefined
    if (!stage || stage.requestId !== request.requestId) return { discarded: false }
    await this.removeStage(stage)
    return { discarded: true }
  }

  async send(request: OutboundSendRequest): Promise<Result<OutboundJobView>> {
    const early = this.gate()
    if (early) return early
    const { requestId, chatId, sessionId, kind } = request
    if (!isOutboundRequestId(requestId)) return fail('INVALID_REQUEST_ID')
    if (typeof kind !== 'string' || !KINDS.has(kind)) return fail('INVALID_KIND')
    const chatError = this.chatError(chatId)
    if (chatError) return fail(chatError)
    if (typeof sessionId !== 'string') return fail('invalid_args')
    const prior = this.records.get(requestId)
    if (prior) return this.replay(prior, chatId)
    if (kind === 'text') {
      if (request.stageId !== undefined) return fail('invalid_args')
      const textError = outboundTextError(request.text)
      if (textError) return fail(textError)
    } else if (typeof request.stageId !== 'string' || request.text !== undefined) return fail('invalid_args')

    const session = await this.readySession(sessionId)
    if (isFail(session)) return session
    if (!(await this.chatKnown(chatId))) return fail('CHAT_NOT_FOUND')
    const ownerKey = keyOf(session.ownerMid)
    const chatKey = keyOf(session.ownerMid, chatId)
    const payload: Payload = { chatId }
    let stage: Stage | null = null
    if (kind === 'text') payload.text = request.text
    else {
      const found = this.stages.get(request.stageId as string)
      if (!found || found.requestId !== requestId || found.kind !== kind || found.sessionId !== session.sessionId || found.chatKey !== chatKey) return fail('STAGE_EXPIRED')
      if (this.now() > found.expiresAt) { await this.removeStage(found); return fail('STAGE_EXPIRED') }
      stage = found
      const loaded = await this.withStage(found, () => this.loadStage(found))
      if (isFail(loaded)) return loaded
      Object.assign(payload, loaded)
    }

    // ── 同步臨界區：檢查到寫入記憶體之間沒有 await（fence、另一個 send、session 變更都看得到一致的狀態）──
    const again = this.records.get(requestId)
    if (again) return this.replay(again, chatId)
    if (!this.opts.session.isCurrentSession(session.sessionId, session.client)) return fail('SESSION_CHANGED')
    if ([...this.records.values()].some((record) => record.status === 'running')) return fail('OUTBOUND_BUSY')
    if (this.hasUnresolved(chatKey)) return fail('CHAT_UNRESOLVED_UNKNOWN')
    if (stage && this.stages.get(stage.stageId) !== stage) return fail('STAGE_EXPIRED')
    const now = this.now()
    if (!this.trim(now)) return fail('JOURNAL_FULL')
    const record: JobRecord = {
      requestId, kind: kind as OutboundKind, ownerKey, chatKey, sessionId: session.sessionId, status: 'running',
      ...(payload.body ? { size: payload.body.length } : {}), createdAt: now, updatedAt: now
    }
    this.records.set(requestId, record)
    if (stage) this.stages.delete(stage.stageId)
    try {
      await this.persist()
    } catch {
      // 沒寫進 journal＝不呼叫 SDK；記憶體留 not_received，之後同 requestId 的 send 一律被擋（REQUEST_FENCED）
      record.status = 'not_received'
      record.updatedAt = this.now()
      if (stage) await this.unlinkRegular(stage.file)
      this.log(`journal_write_failed kind=${kind}`)
      return fail('JOURNAL_IO')
    }
    if (stage) await this.unlinkRegular(stage.file)
    void this.dispatch(record, session, payload)
    return this.view(record)
  }

  async job(request: OutboundJobRequest): Promise<Result<OutboundJobView>> {
    const { requestId, chatId } = request
    if (!isOutboundRequestId(requestId)) return fail('INVALID_REQUEST_ID')
    if (typeof chatId !== 'string') return fail('invalid_args')
    const peek = await this.peek()
    const record = this.records.get(requestId)
    if (record) return this.boundTo(record, peek.ownerMid, chatId) ? this.view(record) : fail('REQUEST_ID_CONFLICT')
    if (request.fence !== true) return this.notReceived(requestId)
    // fence：查無此送出＝寫 tombstone（與上面的查詢之間沒有 await），之後同 requestId 的 send 一律拒絕，所以 view 可以安全判定「未送出」
    if (!this.trim(this.now())) return fail('JOURNAL_FULL')
    const now = this.now()
    const tombstone: JobRecord = {
      requestId, ownerKey: peek.ownerMid ? keyOf(peek.ownerMid) : '', chatKey: peek.ownerMid && isTalkMid(chatId) ? keyOf(peek.ownerMid, chatId) : '',
      sessionId: '', status: 'not_received', createdAt: now, updatedAt: now
    }
    this.records.set(requestId, tombstone)
    const stage = this.stageFor(requestId)
    if (stage) await this.removeStage(stage)
    // 記憶體裡的 tombstone 就足以擋住本行程內晚到的 send；寫檔失敗只少了跨重啟的紀錄（重啟後原本的請求也不存在了）。
    // journal 讀不懂時 persist 拒寫：tombstone 只留在記憶體，原檔保留，下次啟動仍是 JOURNAL_IO。
    await this.persist().catch(() => this.log('journal_write_failed fence'))
    return this.view(tombstone)
  }

  async acknowledge(request: OutboundAckRequest): Promise<Result<OutboundJobView>> {
    const { requestId, chatId } = request
    if (!isOutboundRequestId(requestId)) return fail('INVALID_REQUEST_ID')
    if (typeof chatId !== 'string') return fail('invalid_args')
    const record = this.records.get(requestId)
    if (!record) return this.notReceived(requestId)
    const peek = await this.peek()
    if (!peek.ownerMid) return fail('SESSION_NOT_READY')
    if (!this.boundTo(record, peek.ownerMid, chatId)) return fail('REQUEST_ID_CONFLICT')
    if (record.status !== 'unknown') return this.view(record)
    const before = { status: record.status, updatedAt: record.updatedAt }
    record.status = 'acknowledged'
    record.updatedAt = this.now()
    try { await this.persist() } catch {
      record.status = before.status
      record.updatedAt = before.updatedAt
      return fail('JOURNAL_IO')
    }
    return this.view(record)
  }

  // ── dispatch ──

  private async dispatch(record: JobRecord, session: LineJsOutboundSession, payload: Payload): Promise<void> {
    const watchdog = setTimeout(() => {
      this.timers.delete(watchdog)
      if (record.status !== 'running') return
      this.settle(record, { status: 'unknown', error: { code: 'SEND_TIMEOUT_UNKNOWN', phase: 'watchdog' } })
    }, this.opts.watchdogMs ?? OUTBOUND_LIMITS.watchdogMs)
    watchdog.unref?.()
    this.timers.add(watchdog)
    let attempted = false
    try {
      await this.opts.hooks?.afterRunningJournal?.(record.requestId)
      // 最後一道 fencing：SDK 呼叫前一刻，session 必須仍是同一個 client
      if (!this.opts.session.isCurrentSession(record.sessionId, session.client)) throw Object.assign(new Error('session changed'), { guard: 'SESSION_CHANGED', phase: 'session_guard' })
      const client = session.client
      let message: unknown
      if (record.kind === 'text') {
        const talk = client?.base?.talk
        if (typeof talk?.sendMessage !== 'function') throw Object.assign(new Error('sdk'), { guard: 'SDK_UNAVAILABLE', phase: 'sdk_prepare' })
        attempted = true
        // the user-initiated send is the only context allowed to register a missing group key (R-07, linejsObs.ts); the context closes when
        // the SDK call settles, so nothing scheduled inside it keeps that permission afterwards
        message = await runInLineJsContext('outbound', () => talk.sendMessage({ to: payload.chatId, text: payload.text, e2ee: true }))
      } else {
        const obs = client?.base?.obs
        if (typeof obs?.uploadMediaByE2EE !== 'function') throw Object.assign(new Error('sdk'), { guard: 'SDK_UNAVAILABLE', phase: 'sdk_prepare' })
        const data = new Blob([payload.body as Buffer], { type: payload.mime })
        attempted = true
        message = await runInLineJsContext('outbound', () => obs.uploadMediaByE2EE({ data, oType: record.kind, to: payload.chatId, filename: payload.filename }))
      }
      const id = (message as { id?: unknown } | null | undefined)?.id
      if (typeof id === 'string' && id.trim()) {
        // X3: only the call that makes the record completed (also a late upgrade after the watchdog) hands the bytes over, once
        if (this.settle(record, { status: 'completed', messageId: id })) this.notifySent(record, session, payload)
      } else this.settle(record, { status: 'unknown', error: { code: 'SDK_RESULT_INVALID', phase: 'sdk_result' } })
    } catch (error) {
      if (!attempted) {
        const guard = (error as { guard?: unknown })?.guard
        const phase = (error as { phase?: unknown })?.phase
        this.settle(record, { status: 'failed', error: { code: typeof guard === 'string' ? guard : 'SEND_PREPARATION_FAILED', phase: typeof phase === 'string' && PHASES.has(phase) ? phase as OutboundPhase : 'sdk_prepare' } })
      } else this.settle(record, this.classify(error))
    } finally {
      clearTimeout(watchdog)
      this.timers.delete(watchdog)
      payload.text = undefined
      payload.body = undefined
    }
  }

  /** SDK 呼叫後的錯誤分類：只有能證明「沒有建立訊息」的才算 failed，其餘一律 unknown。 */
  private classify(error: unknown): { status: 'failed' | 'unknown'; error: OutboundJobError } {
    const e = error as { name?: unknown; type?: unknown; code?: unknown } | null
    if (e?.name === 'RequestError' || e?.type === 'RequestError') {
      const detail = rejectDetail(error)
      return { status: 'failed', error: { code: 'SDK_SEND_REJECTED', phase: 'sdk_send', ...(detail ? { detail } : {}) } }
    }
    if (e?.name === 'ClientClosed' || e?.type === 'ClientClosed') return { status: 'failed', error: { code: 'CLIENT_CLOSED', phase: 'sdk_send' } }
    if (e?.code === 'LINEJS_URL_DENIED') return { status: 'failed', error: { code: 'LINEJS_URL_DENIED', phase: 'sdk_send' } }
    if (e?.code === 'OBS_UPLOAD_REJECTED') return { status: 'failed', error: { code: 'OBS_UPLOAD_REJECTED', phase: 'sdk_send' } }
    return { status: 'unknown', error: { code: 'SEND_RESULT_UNKNOWN', phase: 'sdk_send' } }
  }

  /**
   * X3：把送出成功的照片／檔案交給 onSent（不等待；同步丟錯或非同步失敗都只記 code，送出結果已經定了）。文字不保存。
   * SDK 回的 id 原樣交出（stem 由接收端以 `'i:' + id` 計算，與電腦版落庫後的 msg_id 相同時，X2b 收到那一列會直接短路成 done）。
   */
  private notifySent(record: JobRecord, session: LineJsOutboundSession, payload: Payload): void {
    const onSent = this.opts.onSent
    if (!onSent || (record.kind !== 'image' && record.kind !== 'file') || !payload.body || !record.messageId) return
    const sent: OutboundSent = { messageId: record.messageId, kind: record.kind, chatId: payload.chatId, ownerMid: session.ownerMid, body: payload.body, mime: payload.mime ?? 'application/octet-stream', filename: payload.filename ?? '' }
    const failed = (error: unknown) => this.log(`saved_failed kind=${record.kind} code=${String((error as { code?: unknown } | null)?.code ?? 'ERROR').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'ERROR'}`)
    try { void Promise.resolve(onSent(sent)).catch(failed) } catch (error) { failed(error) }
  }

  /** 結果只升不降：running → 任何結果；unknown／acknowledged（watchdog 之後）只能升級成 completed。回傳這次是否真的改了結果。 */
  private settle(record: JobRecord, next: { status: OutboundJobStatus; messageId?: string; error?: OutboundJobError }): boolean {
    const upgrade = next.status === 'completed' && (record.status === 'unknown' || record.status === 'acknowledged')
    if (record.status !== 'running' && !upgrade) return false
    record.status = next.status
    record.updatedAt = this.now()
    if (next.messageId) record.messageId = next.messageId
    if (next.status === 'completed') delete record.error
    else if (next.error) record.error = next.error
    this.log(`job_${next.status} kind=${record.kind ?? '-'} code=${next.error?.code ?? '-'} bytes=${record.size ?? 0}`)
    if (!this.disposed) void this.persist().catch(() => this.log('journal_write_failed result'))
    return true
  }

  // ── helpers ──

  private gate(): OutboundFail | null {
    if (this.disposed) return fail('linejs_outbound_unavailable')
    if (this.journalBroken) return fail('JOURNAL_IO')
    return null
  }

  private async peek(): Promise<LineJsOutboundPeek> {
    try { return await this.opts.session.outboundPeek() } catch { return { state: 'unavailable', sessionId: null, ownerMid: null } }
  }

  private async localMid(): Promise<string | null> {
    try {
      const mid = await this.opts.localAccountMid()
      return typeof mid === 'string' && mid ? mid : null
    } catch { return null }
  }

  private async chatKnown(chatId: string): Promise<boolean> {
    try { return (await this.opts.chatKnown(chatId)) === true } catch { return false }
  }

  private chatError(chatId: unknown): string | null {
    if (isTalkMid(chatId)) return null
    return isUnsupportedChatId(chatId) ? 'CHAT_UNSUPPORTED' : 'INVALID_CHAT'
  }

  /** session 就緒、與 view 手上的 sessionId 相同、而且登入帳號就是本機 LINE 帳號（fail-closed）。 */
  private async readySession(sessionId: string): Promise<Result<LineJsOutboundSession>> {
    let session: LineJsOutboundSession | null = null
    try { session = await this.opts.session.outboundSession() } catch { session = null }
    if (!session) return fail('SESSION_NOT_READY')
    if (session.sessionId !== sessionId) return fail('SESSION_CHANGED')
    const local = await this.localMid()
    if (!local) return fail('ACCOUNT_UNVERIFIED')
    if (local !== session.ownerMid) return fail('ACCOUNT_MISMATCH')
    if (!this.opts.session.isCurrentSession(session.sessionId, session.client)) return fail('SESSION_CHANGED')
    return session
  }

  private async replay(prior: JobRecord, chatId: string): Promise<Result<OutboundJobView>> {
    if (prior.status === 'not_received') return fail('REQUEST_FENCED')
    const peek = await this.peek()
    return this.boundTo(prior, peek.ownerMid, chatId) ? this.view(prior) : fail('REQUEST_ID_CONFLICT')
  }

  /** 送出紀錄只回給同一個帳號＋聊天室；登入狀態不明時以 requestId（view 產生的隨機值）為準。 */
  private boundTo(record: JobRecord, ownerMid: string | null, chatId: string): boolean {
    if (!ownerMid || !record.chatKey) return true
    return keyOf(ownerMid, chatId) === record.chatKey
  }

  private hasUnresolved(chatKey: string): boolean {
    for (const record of this.records.values()) if (record.chatKey === chatKey && record.status === 'unknown') return true
    return false
  }

  /** 終結的紀錄超過 30 天修剪；滿了先丟最舊的終結紀錄。unknown／running 永遠不丟；沒有可丟的＝滿。 */
  private trim(now: number): boolean {
    for (const [id, record] of this.records) {
      if (TERMINAL.has(record.status) && now - record.updatedAt > OUTBOUND_LIMITS.journalTerminalAgeMs) this.records.delete(id)
    }
    while (this.records.size >= OUTBOUND_LIMITS.journalMax) {
      let oldest: JobRecord | null = null
      for (const record of this.records.values()) if (TERMINAL.has(record.status) && (!oldest || record.updatedAt < oldest.updatedAt)) oldest = record
      if (!oldest) break
      this.records.delete(oldest.requestId)
    }
    return this.records.size < OUTBOUND_LIMITS.journalMax
  }

  private view(record: JobRecord): OutboundJobView {
    return {
      requestId: record.requestId,
      ...(record.kind ? { kind: record.kind } : {}),
      status: record.status,
      ...(record.size !== undefined ? { size: record.size } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.status === 'completed' && record.messageId ? { result: { messageId: record.messageId } } : {}),
      ...(record.error ? { error: { ...record.error } } : {})
    }
  }

  private notReceived(requestId: string): OutboundJobView {
    const now = this.now()
    return { requestId, status: 'not_received', createdAt: now, updatedAt: now }
  }

  private beginResult(stage: Stage): OutboundBeginResult {
    return { stageId: stage.stageId, chunkBytes: OUTBOUND_LIMITS.chunkBytes, expiresAt: stage.expiresAt }
  }

  private stageFor(requestId: string): Stage | undefined {
    for (const stage of this.stages.values()) if (stage.requestId === requestId) return stage
    return undefined
  }

  private withStage<T>(stage: Stage, run: () => Promise<T>): Promise<T> {
    const result = stage.lock.then(run, run)
    stage.lock = result.then(() => undefined, () => undefined)
    return result
  }

  /** 讀出完整 staged 內容並驗證：大小、整檔 sha256、圖片嗅探（以嗅探結果決定 MIME 與副檔名）。 */
  private async loadStage(stage: Stage): Promise<Result<{ body: Buffer; mime: string; filename: string }>> {
    if (this.stages.get(stage.stageId) !== stage) return fail('STAGE_EXPIRED')
    if (stage.received !== stage.size) return fail('STAGE_INCOMPLETE')
    let body: Buffer
    try {
      const info = await lstat(stage.file)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('not a regular file')
      if (info.size !== stage.size) { await this.removeStage(stage); return fail('STAGE_INCOMPLETE') }
      body = await readFile(stage.file)
    } catch {
      await this.removeStage(stage)
      return fail('STAGE_IO')
    }
    if (body.length !== stage.size) { await this.removeStage(stage); return fail('STAGE_INCOMPLETE') }
    if (sha256(body) !== stage.sha256) { await this.removeStage(stage); return fail('STAGE_INTEGRITY_MISMATCH') }
    if (stage.kind === 'image') {
      let sniffed: string | null = null
      try { sniffed = this.opts.imageSniff(body) } catch { sniffed = null }
      if (!sniffed || !IMAGE_MIMES.has(sniffed)) { await this.removeStage(stage); return fail('INVALID_IMAGE_TYPE') }
      return { body, mime: sniffed, filename: imageName(stage.filename, sniffed) }
    }
    return { body, mime: stage.mime, filename: stage.filename }
  }

  private async sweepStages(): Promise<void> {
    const now = this.now()
    for (const stage of [...this.stages.values()]) if (now > stage.expiresAt) await this.removeStage(stage)
  }

  /** session 換了（登出、重新登入、dispose）：舊 session 的附件暫存全部丟掉。 */
  private async dropStaleStages(): Promise<void> {
    const current = this.opts.session.currentSessionId()
    for (const stage of [...this.stages.values()]) {
      if (stage.sessionId === current) continue
      this.droppedForSession.push(stage.stageId)
      if (this.droppedForSession.length > 32) this.droppedForSession.shift()
      await this.removeStage(stage)
    }
  }

  private async removeStage(stage: Stage): Promise<void> {
    if (this.stages.get(stage.stageId) === stage) this.stages.delete(stage.stageId)
    await this.unlinkRegular(stage.file)
  }

  /** 只刪一般檔（不跟隨 symlink／junction）。 */
  private async unlinkRegular(file: string): Promise<void> {
    try {
      const info = await lstat(file)
      if (info.isFile() && !info.isSymbolicLink()) await unlink(file)
    } catch { /* already gone */ }
  }

  private async ensureDir(dir: string, create: boolean): Promise<void> {
    if (create) await mkdir(dir, { recursive: true })
    const info = await lstat(dir)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('not a directory')
  }

  /**
   * temp（wx）＋ rename 的原子寫；依序執行，寫的是當下的完整狀態。dispose 之後不再寫（下一個行程會把 running 讀成 SEND_INTERRUPTED）。
   * journal 讀不懂（journalBroken）時一律拒寫：任何入口（fence、結果、acknowledge）都不得覆寫原檔，否則下次啟動 fail-closed 會被解除。
   */
  private persist(): Promise<void> {
    const run = async (): Promise<void> => {
      if (this.disposed) throw new Error('disposed')
      if (this.journalBroken) throw new Error('journal unavailable')
      const info = await lstat(this.journalPath).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : Promise.reject(error)))
      if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('journal is not a regular file')
      const temp = `${this.journalPath}.${randomUUID()}.tmp`
      await writeFile(temp, JSON.stringify({ version: 1, records: [...this.records.values()] }), { flag: 'wx', mode: 0o600 })
      try { await rename(temp, this.journalPath) } catch (error) { await unlink(temp).catch(() => {}); throw error }
    }
    const next = this.writeChain.then(run, run)
    this.writeChain = next.catch(() => {})
    return next
  }
}
