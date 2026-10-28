import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { Database } from 'better-sqlite3'
import type { MessageDTO } from './dto'
import { claimRuntimeOwnerProof } from '../../shared/runtimeOwnerProof'
import type { RuntimeOwnerProof } from '../../shared/runtimeOwnerProof'
import { databasePathFor } from './databaseScope'

/**
 * Shared source-row L1 and durable per-chat lease/checkpoint primitives.
 *
 * SQLite messages remain the only raw-source authority. The L1 stores only
 * exact message DTOs for one open DB connection; durable tables store IDs,
 * fingerprints and coordination counters, never message text.
 */

export const SOURCE_CACHE_SCHEMA_VERSION = 1
export const SOURCE_WINDOW_LIMIT = 10
export const SOURCE_ROWS_PER_CHAT_LIMIT = 128
export const SOURCE_TEXT_BYTES_PER_CHAT_LIMIT = 1024 * 1024
export const SOURCE_ROWS_GLOBAL_LIMIT = 4096
export const SOURCE_TEXT_BYTES_GLOBAL_LIMIT = 16 * 1024 * 1024
export const SOURCE_CACHED_CHATS_LIMIT = 64
export const SOURCE_APPEND_EVENTS_PER_CHAT_LIMIT = 256
export const SOURCE_APPEND_EVENTS_GLOBAL_LIMIT = 4096
export const SOURCE_SESSION_TURNS_LIMIT = 64
export const SOURCE_SESSION_REQUESTS_LIMIT = 64
export const SOURCE_SESSION_USER_BYTES_LIMIT = 131072

interface SourceDbRow {
  msg_id: string
  chat_id: string
  ts: number
  time_iso: string
  direction: 'in' | 'out'
  sender: string | null
  text: string | null
  content_type: number
  processed: number
  ingested_at: string
  orig_filename: string | null
  file_size: number | null
  unsent: number
}

interface CacheDbRow {
  chat_id: string
  cache_schema_version: number
  state_version: number
  source_epoch: number
  append_seq: number
  scope_revision: number
  todo_identity_revision: number
  topic_identity_revision: number
  window_complete: number
  window_digest: string | null
  active_lease_id: string | null
  lease_expires_at: string | null
  session_epoch: number
  session_fingerprint: string | null
  accepted_turns: number
  submitted_requests: number
  submitted_user_utf8_bytes: number
  last_accepted_at: string | null
  tainted: number
  updated_at: string
}

export interface ChatSourceState {
  chatId: string
  cacheSchemaVersion: number
  stateVersion: number
  sourceEpoch: number
  appendSeq: number
  scopeRevision: number
  todoIdentityRevision: number
  topicIdentityRevision: number
  windowComplete: boolean
  windowDigest: string | null
  activeLeaseId: string | null
  leaseExpiresAt: string | null
  sessionEpoch: number
  sessionFingerprint: string | null
  acceptedTurns: number
  submittedRequests: number
  submittedUserUtf8Bytes: number
  lastAcceptedAt: string | null
  tainted: boolean
  updatedAt: string
}

export interface SourceWindowRef {
  position: number
  msgId: string
  contentFingerprint: string
}

export interface ChatSourceLease {
  chatId: string
  leaseId: string
  expiresAt: string
  sourceEpoch: number
  appendSeq: number
  scopeRevision: number
  todoIdentityRevision: number
  topicIdentityRevision: number
  stateVersion: number
  windowComplete: boolean
  window: SourceWindowRef[]
  sessionEpoch: number
  sessionFingerprint: string | null
  acceptedTurns: number
  submittedRequests: number
  submittedUserUtf8Bytes: number
  tainted: boolean
}

export type AcquireSourceLeaseResult =
  | { ok: true; lease: ChatSourceLease }
  | { ok: false; reason: 'chat_missing' | 'lease_busy' | 'window_corrupt' | 'invalid_expiry' }

export type BeginSourceAttemptResult =
  | { ok: true; attempt: number; userUtf8Bytes: number; state: ChatSourceState }
  | { ok: false; reason: 'lease_stale' | 'source_stale' | 'scope_stale' | 'session_stale' | 'session_unset' | 'tainted' | 'turn_limit' | 'request_limit' | 'byte_limit' | 'chat_missing' }

export type CommitSourceLeaseResult =
  | { ok: true; window: SourceWindowRef[]; usedAppendRebase: boolean; usedFallback: boolean; appendCount: number; state: ChatSourceState }
  | { ok: false; reason: 'chat_missing' | 'lease_stale' | 'source_stale' | 'scope_stale' | 'identity_stale' | 'selected_row_stale' | 'window_corrupt' | 'append_gap' | 'turn_limit' | 'session_stale' | 'session_unset' | 'attempt_missing' | 'tainted' }

export interface SourceFingerprintRef {
  msgId: string
  contentFingerprint: string
}

export interface AppendBatch {
  sourceEpochBefore: number
  sourceEpochAfter: number
  appendSeqBefore: number
  appendSeqAfter: number
  rows: MessageDTO[]
}

interface CachedRow {
  row: MessageDTO
  contentFingerprint: string
  textBytes: number
}

interface AppendEvent {
  seq: number
  msgId: string
  ts: number
  contentFingerprint: string
}

interface ContextWindow {
  sourceEpoch: number
  appendSeq: number
  rows: SourceFingerprintRef[]
}

interface ChatL1 {
  sourceEpoch: number
  rows: Map<string, CachedRow>
  textBytes: number
  contextWindow: ContextWindow | null
  appendEvents: Map<number, AppendEvent>
}

export interface SourceCacheStats {
  hits: number
  misses: number
  rawQueries: number
  rowsRead: number
  rowsReturned: number
  rowsRetained: number
  evictions: number
  sourceEpochInvalidations: number
  appendFallbacks: number
}

export interface SourceCacheDiagnostics extends SourceCacheStats {
  cachedChats: number
  cachedRows: number
  cachedTextBytes: number
  cachedAppendEvents: number
}

export interface PerChatSourceCacheDiagnostics {
  cachedRows: number
  cachedTextBytes: number
  cachedAppendEvents: number
  contextWindowRows: number
}

const SOURCE_COLUMNS =
  'msg_id,chat_id,ts,time_iso,direction,sender,text,content_type,processed,ingested_at,orig_filename,file_size,unsent'

function mapDbRow(row: SourceDbRow): MessageDTO {
  return {
    msgId: row.msg_id,
    chatId: row.chat_id,
    ts: row.ts,
    timeIso: row.time_iso,
    direction: row.direction,
    sender: row.sender,
    text: row.text,
    contentType: row.content_type,
    processed: row.processed === 1,
    ingestedAt: row.ingested_at,
    origFilename: row.orig_filename,
    fileSize: row.file_size,
    unsent: row.unsent === 1
  }
}

function mapState(row: CacheDbRow): ChatSourceState {
  return {
    chatId: row.chat_id,
    cacheSchemaVersion: row.cache_schema_version,
    stateVersion: row.state_version,
    sourceEpoch: row.source_epoch,
    appendSeq: row.append_seq,
    scopeRevision: row.scope_revision,
    todoIdentityRevision: row.todo_identity_revision,
    topicIdentityRevision: row.topic_identity_revision,
    windowComplete: row.window_complete === 1,
    windowDigest: row.window_digest,
    activeLeaseId: row.active_lease_id,
    leaseExpiresAt: row.lease_expires_at,
    sessionEpoch: row.session_epoch,
    sessionFingerprint: row.session_fingerprint,
    acceptedTurns: row.accepted_turns,
    submittedRequests: row.submitted_requests,
    submittedUserUtf8Bytes: row.submitted_user_utf8_bytes,
    lastAcceptedAt: row.last_accepted_at,
    tainted: row.tainted === 1,
    updatedAt: row.updated_at
  }
}

export function readChatSourceState(db: Database, chatId: string): ChatSourceState | null {
  const row = db
    .prepare('SELECT * FROM chat_context_cache WHERE chat_id = ?')
    .get(chatId) as CacheDbRow | undefined
  return row ? mapState(row) : null
}

export function fingerprintSourceMessage(row: Pick<MessageDTO,
  'chatId' | 'msgId' | 'ts' | 'timeIso' | 'direction' | 'sender' | 'text' | 'contentType' | 'unsent'
>): string {
  const basis = JSON.stringify([
    row.chatId,
    row.msgId,
    row.ts,
    row.timeIso,
    row.direction,
    row.sender,
    row.text,
    row.contentType,
    row.unsent
  ])
  return createHash('sha256').update(basis, 'utf8').digest('hex')
}

export function fingerprintSourceWindow(rows: readonly SourceFingerprintRef[]): string {
  return createHash('sha256')
    .update(JSON.stringify(rows.map((row, position) => [position, row.msgId, row.contentFingerprint])), 'utf8')
    .digest('hex')
}

function rowKey(chatId: string, msgId: string): string {
  return JSON.stringify([chatId, msgId])
}

function isExpired(expiresAt: string | null, now: string): boolean {
  return expiresAt === null || expiresAt <= now
}

function selectRows(db: Database, chatId: string, ids: readonly string[]): MessageDTO[] {
  const rows: MessageDTO[] = []
  for (let offset = 0; offset < ids.length; offset += 900) {
    const part = ids.slice(offset, offset + 900)
    if (part.length === 0) continue
    const sql = 'SELECT ' + SOURCE_COLUMNS + ' FROM messages WHERE chat_id = ? AND msg_id IN (' +
      part.map(() => '?').join(',') + ')'
    const selected = db.prepare(sql).all(chatId, ...part) as SourceDbRow[]
    rows.push(...selected.map(mapDbRow))
  }
  return rows
}

function leaseFromState(state: ChatSourceState, leaseId: string, expiresAt: string, window: SourceWindowRef[]): ChatSourceLease {
  return {
    chatId: state.chatId,
    leaseId,
    expiresAt,
    sourceEpoch: state.sourceEpoch,
    appendSeq: state.appendSeq,
    scopeRevision: state.scopeRevision,
    todoIdentityRevision: state.todoIdentityRevision,
    topicIdentityRevision: state.topicIdentityRevision,
    stateVersion: state.stateVersion,
    windowComplete: state.windowComplete,
    window,
    sessionEpoch: state.sessionEpoch,
    sessionFingerprint: state.sessionFingerprint,
    acceptedTurns: state.acceptedTurns,
    submittedRequests: state.submittedRequests,
    submittedUserUtf8Bytes: state.submittedUserUtf8Bytes,
    tainted: state.tainted
  }
}

/**
 * Per-open-connection cache so two isolated DBs in the same test process can
 * never share rows just because their chat/message IDs happen to match.
 */
export class SharedSourceRows {
  private readonly db: Database
  private readonly chats = new Map<string, ChatL1>()
  private readonly globalRows = new Map<string, { chatId: string; msgId: string }>()
  private totalTextBytes = 0
  private totalAppendEvents = 0
  private readonly stats: SourceCacheStats = {
    hits: 0,
    misses: 0,
    rawQueries: 0,
    rowsRead: 0,
    rowsReturned: 0,
    rowsRetained: 0,
    evictions: 0,
    sourceEpochInvalidations: 0,
    appendFallbacks: 0
  }

  constructor(db: Database) {
    this.db = db
  }

  diagnostics(): Readonly<SourceCacheDiagnostics> {
    return {
      ...this.stats,
      cachedChats: this.chats.size,
      cachedRows: this.globalRows.size,
      cachedTextBytes: this.totalTextBytes,
      cachedAppendEvents: this.totalAppendEvents
    }
  }

  chatDiagnostics(chatId: string): Readonly<PerChatSourceCacheDiagnostics> {
    const chat = this.chats.get(chatId)
    return {
      cachedRows: chat?.rows.size ?? 0,
      cachedTextBytes: chat?.textBytes ?? 0,
      cachedAppendEvents: chat?.appendEvents.size ?? 0,
      contextWindowRows: chat?.contextWindow?.rows.length ?? 0
    }
  }

  loadExactRows(chatId: string, requestedIds: readonly string[]): MessageDTO[] {
    const ids = [...new Set(requestedIds)]
    if (ids.length === 0) return []

    const state = readChatSourceState(this.db, chatId)
    if (!state) {
      this.stats.misses += ids.length
      this.stats.rawQueries += 1
      const rows = selectRows(this.db, chatId, ids)
      this.stats.rowsRead += rows.length
      this.stats.rowsReturned += rows.length
      return this.orderRows(ids, rows)
    }

    const chat = this.getChat(chatId, state.sourceEpoch)
    const found = new Map<string, MessageDTO>()
    const missing: string[] = []

    for (const msgId of ids) {
      const cached = chat.rows.get(msgId)
      if (cached && cached.contentFingerprint === fingerprintSourceMessage(cached.row)) {
        this.touchRow(chatId, msgId, chat, cached)
        this.stats.hits += 1
        found.set(msgId, cached.row)
      } else {
        if (cached) this.removeRow(chatId, msgId, chat)
        this.stats.misses += 1
        missing.push(msgId)
      }
    }

    if (missing.length > 0) {
      this.stats.rawQueries += 1
      const loaded = selectRows(this.db, chatId, missing)
      this.stats.rowsRead += loaded.length
      for (const row of loaded) {
        found.set(row.msgId, row)
        this.retainRow(chatId, row, state.sourceEpoch)
      }
    }

    // A concurrent writer in another process can commit between SELECTs.
    // Do not keep rows obtained across a source epoch change.
    const after = readChatSourceState(this.db, chatId)
    if (!after || after.sourceEpoch !== state.sourceEpoch) {
      this.dropChat(chatId)
      this.stats.sourceEpochInvalidations += 1
    }

    const ordered = ids.flatMap((id) => {
      const row = found.get(id)
      return row ? [row] : []
    })
    this.stats.rowsReturned += ordered.length
    return ordered
  }

  rememberTodoContext(chatId: string, rows: readonly MessageDTO[]): void {
    const state = readChatSourceState(this.db, chatId)
    if (!state) return
    const chat = this.getChat(chatId, state.sourceEpoch)
    const selected = rows.slice(-SOURCE_WINDOW_LIMIT)
    for (const row of selected) this.retainRow(chatId, row, state.sourceEpoch)
    chat.contextWindow = {
      sourceEpoch: state.sourceEpoch,
      appendSeq: state.appendSeq,
      rows: selected.map((row) => ({
        msgId: row.msgId,
        contentFingerprint: fingerprintSourceMessage(row)
      }))
    }
  }

  recordInsertedRows(chatId: string, batch: AppendBatch): void {
    const state = readChatSourceState(this.db, chatId)
    if (!state) return

    let chat = this.chats.get(chatId)
    if (chat && chat.sourceEpoch !== batch.sourceEpochAfter) {
      this.dropChat(chatId)
      this.stats.sourceEpochInvalidations += 1
      chat = undefined
    }
    chat = chat ?? this.getChat(chatId, batch.sourceEpochAfter)

    const seqDelta = batch.appendSeqAfter - batch.appendSeqBefore
    const appendOnly = batch.sourceEpochBefore === batch.sourceEpochAfter &&
      seqDelta === batch.rows.length &&
      state.sourceEpoch === batch.sourceEpochAfter &&
      state.appendSeq === batch.appendSeqAfter

    if (!appendOnly) {
      this.clearAppendEvents(chat)
      chat.contextWindow = null
    } else {
      for (let index = 0; index < batch.rows.length; index += 1) {
        const row = batch.rows[index]
        const seq = batch.appendSeqBefore + index + 1
        const event: AppendEvent = {
          seq,
          msgId: row.msgId,
          ts: row.ts,
          contentFingerprint: fingerprintSourceMessage(row)
        }
        if (!chat.appendEvents.has(seq)) this.totalAppendEvents += 1
        chat.appendEvents.set(seq, event)
      }
      this.trimAppendEvents(chat)
      if (chat.contextWindow && chat.contextWindow.sourceEpoch === state.sourceEpoch &&
          chat.contextWindow.appendSeq === batch.appendSeqBefore) {
        const byId = new Map<string, { ts: number; ref: SourceFingerprintRef }>()
        for (const ref of chat.contextWindow.rows) {
          const cached = chat.rows.get(ref.msgId)
          if (!cached || cached.contentFingerprint !== ref.contentFingerprint) {
            byId.clear()
            break
          }
          byId.set(ref.msgId, { ts: cached.row.ts, ref })
        }
        if (byId.size === chat.contextWindow.rows.length) {
          for (const event of [...chat.appendEvents.values()].filter((item) => item.seq > batch.appendSeqBefore)) {
            const row = batch.rows.find((candidate) => candidate.msgId === event.msgId)
            if (row) byId.set(row.msgId, { ts: row.ts, ref: { msgId: row.msgId, contentFingerprint: event.contentFingerprint } })
          }
          const next = [...byId.values()].sort((a, b) => a.ts - b.ts || a.ref.msgId.localeCompare(b.ref.msgId)).slice(-SOURCE_WINDOW_LIMIT)
          chat.contextWindow = { sourceEpoch: state.sourceEpoch, appendSeq: batch.appendSeqAfter, rows: next.map((item) => item.ref) }
        } else {
          chat.contextWindow = null
        }
      } else {
        chat.contextWindow = null
      }
    }

    for (const row of batch.rows) this.retainRow(chatId, row, state.sourceEpoch)
  }

  private orderRows(ids: readonly string[], rows: readonly MessageDTO[]): MessageDTO[] {
    const byId = new Map(rows.map((row) => [row.msgId, row]))
    return ids.flatMap((id) => {
      const row = byId.get(id)
      return row ? [row] : []
    })
  }

  private getChat(chatId: string, sourceEpoch: number): ChatL1 {
    let chat = this.chats.get(chatId)
    if (chat && chat.sourceEpoch !== sourceEpoch) {
      this.dropChat(chatId)
      this.stats.sourceEpochInvalidations += 1
      chat = undefined
    }
    if (!chat) {
      chat = { sourceEpoch, rows: new Map(), textBytes: 0, contextWindow: null, appendEvents: new Map() }
      this.chats.set(chatId, chat)
    } else {
      this.chats.delete(chatId)
      this.chats.set(chatId, chat)
    }
    while (this.chats.size > SOURCE_CACHED_CHATS_LIMIT) {
      const oldestChatId = this.chats.keys().next().value as string | undefined
      if (oldestChatId === undefined) break
      this.dropChat(oldestChatId)
    }
    return chat
  }

  private retainRow(chatId: string, row: MessageDTO, sourceEpoch: number): void {
    const textBytes = Buffer.byteLength(row.text ?? '', 'utf8')
    if (textBytes > SOURCE_TEXT_BYTES_PER_CHAT_LIMIT) return
    const chat = this.getChat(chatId, sourceEpoch)
    const prior = chat.rows.get(row.msgId)
    if (prior) this.removeRow(chatId, row.msgId, chat)
    const cached: CachedRow = {
      row: Object.freeze({ ...row }),
      contentFingerprint: fingerprintSourceMessage(row),
      textBytes
    }
    chat.rows.set(row.msgId, cached)
    chat.textBytes += textBytes
    this.totalTextBytes += textBytes
    this.globalRows.set(rowKey(chatId, row.msgId), { chatId, msgId: row.msgId })
    this.stats.rowsRetained += 1

    while (chat.rows.size > SOURCE_ROWS_PER_CHAT_LIMIT || chat.textBytes > SOURCE_TEXT_BYTES_PER_CHAT_LIMIT) {
      const oldest = chat.rows.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.removeRow(chatId, oldest, chat)
      this.stats.evictions += 1
    }
    while (this.globalRows.size > SOURCE_ROWS_GLOBAL_LIMIT || this.totalTextBytes > SOURCE_TEXT_BYTES_GLOBAL_LIMIT) {
      const oldestKey = this.globalRows.keys().next().value as string | undefined
      if (oldestKey === undefined) break
      const oldest = this.globalRows.get(oldestKey)
      this.globalRows.delete(oldestKey)
      if (oldest) {
        const owner = this.chats.get(oldest.chatId)
        if (owner) this.removeRow(oldest.chatId, oldest.msgId, owner)
      }
      this.stats.evictions += 1
    }
  }

  private touchRow(chatId: string, msgId: string, chat: ChatL1, cached: CachedRow): void {
    chat.rows.delete(msgId)
    chat.rows.set(msgId, cached)
    const key = rowKey(chatId, msgId)
    const global = this.globalRows.get(key)
    if (global) {
      this.globalRows.delete(key)
      this.globalRows.set(key, global)
    }
  }

  private removeRow(chatId: string, msgId: string, chat: ChatL1): void {
    const row = chat.rows.get(msgId)
    if (!row) return
    chat.rows.delete(msgId)
    chat.textBytes -= row.textBytes
    this.totalTextBytes -= row.textBytes
    this.globalRows.delete(rowKey(chatId, msgId))
  }

  private clearAppendEvents(chat: ChatL1): void {
    this.totalAppendEvents -= chat.appendEvents.size
    chat.appendEvents.clear()
  }

  private trimAppendEvents(chat: ChatL1): void {
    while (chat.appendEvents.size > SOURCE_APPEND_EVENTS_PER_CHAT_LIMIT) {
      const first = chat.appendEvents.keys().next().value as number | undefined
      if (first === undefined) break
      chat.appendEvents.delete(first)
      this.totalAppendEvents -= 1
    }
    while (this.totalAppendEvents > SOURCE_APPEND_EVENTS_GLOBAL_LIMIT) {
      const oldestChat = [...this.chats.values()].find((candidate) => candidate.appendEvents.size > 0)
      if (!oldestChat) break
      const first = oldestChat.appendEvents.keys().next().value as number | undefined
      if (first === undefined) break
      oldestChat.appendEvents.delete(first)
      this.totalAppendEvents -= 1
    }
  }

  private dropChat(chatId: string): void {
    const chat = this.chats.get(chatId)
    if (!chat) return
    for (const msgId of [...chat.rows.keys()]) this.removeRow(chatId, msgId, chat)
    this.clearAppendEvents(chat)
    this.chats.delete(chatId)
  }

  private appendEventsAfter(chat: ChatL1, fromSeq: number, toSeq: number): AppendEvent[] | null {
    if (toSeq < fromSeq || toSeq - fromSeq > SOURCE_APPEND_EVENTS_PER_CHAT_LIMIT) return null
    const events: AppendEvent[] = []
    for (let seq = fromSeq + 1; seq <= toSeq; seq += 1) {
      const event = chat.appendEvents.get(seq)
      if (!event) return null
      events.push(event)
    }
    return events
  }

  private currentContext(chat: ChatL1, sourceEpoch: number, appendSeq: number): SourceFingerprintRef[] | null {
    const current = chat.contextWindow
    if (!current || current.sourceEpoch !== sourceEpoch || current.appendSeq !== appendSeq) return null
    for (const ref of current.rows) {
      const cached = chat.rows.get(ref.msgId)
      if (!cached || cached.contentFingerprint !== ref.contentFingerprint ||
        cached.contentFingerprint !== fingerprintSourceMessage(cached.row)) return null
    }
    return current.rows
  }

  acquireLease(chatId: string, leaseId: string, expiresAt: string, now = new Date().toISOString()): AcquireSourceLeaseResult {
    if (Date.parse(expiresAt) <= Date.parse(now)) return { ok: false, reason: 'invalid_expiry' }
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT * FROM chat_context_cache WHERE chat_id = ?')
        .get(chatId) as CacheDbRow | undefined
      if (!row) return { ok: false, reason: 'chat_missing' } as const
      const state = mapState(row)
      if (state.activeLeaseId && state.activeLeaseId !== leaseId && !isExpired(state.leaseExpiresAt, now)) {
        return { ok: false, reason: 'lease_busy' } as const
      }
      const windowRows = this.db
        .prepare('SELECT position,msg_id AS msgId,content_fingerprint AS contentFingerprint FROM chat_context_cache_window WHERE chat_id = ? ORDER BY position')
        .all(chatId) as SourceWindowRef[]
      const validWindow = windowRows.length <= SOURCE_WINDOW_LIMIT &&
        windowRows.every((item, index) => item.position === index) &&
        (state.windowComplete
          ? state.windowDigest === fingerprintSourceWindow(windowRows)
          : windowRows.length === 0)
      if (!validWindow) return { ok: false, reason: 'window_corrupt' } as const

      const result = this.db.prepare(
        'UPDATE chat_context_cache SET active_lease_id = ?, lease_expires_at = ?, state_version = state_version + 1, updated_at = ? ' +
        'WHERE chat_id = ? AND source_epoch = ? AND state_version = ? AND ' +
        '(active_lease_id IS NULL OR active_lease_id = ? OR lease_expires_at <= ?)'
      ).run(leaseId, expiresAt, now, chatId, state.sourceEpoch, state.stateVersion, leaseId, now)
      if (result.changes !== 1) return { ok: false, reason: 'lease_busy' } as const
      const nextRow = this.db.prepare('SELECT * FROM chat_context_cache WHERE chat_id = ?').get(chatId) as CacheDbRow
      return { ok: true, lease: leaseFromState(mapState(nextRow), leaseId, expiresAt, windowRows) } as const
    })
    return runImmediateTransaction(tx)
  }

  /** Extend an active owner lease before another bounded request part begins. */
  renewLease(lease:ChatSourceLease,expiresAt:string,now=new Date().toISOString()):ChatSourceLease|null {
    if(isExpired(expiresAt,now)) return null
    const tx=this.db.transaction(()=>{
      const changed=this.db.prepare(`UPDATE chat_context_cache SET lease_expires_at=?,state_version=state_version+1,updated_at=?
        WHERE chat_id=? AND active_lease_id=? AND source_epoch=? AND scope_revision=? AND lease_expires_at>?`)
        .run(expiresAt,now,lease.chatId,lease.leaseId,lease.sourceEpoch,lease.scopeRevision,now)
      if(changed.changes!==1) return null
      const state=readChatSourceState(this.db,lease.chatId)
      if(!state) return null
      return leaseFromState(state,lease.leaseId,expiresAt,lease.window)
    })
    return runImmediateTransaction(tx)
  }

  setSessionFingerprint(lease: ChatSourceLease, fingerprint: string, now = new Date().toISOString(), forceRotate = false): ChatSourceLease | null {
    if (!fingerprint) return null
    const tx = this.db.transaction(() => {
      const state = readChatSourceState(this.db, lease.chatId)
      if (!state || state.activeLeaseId !== lease.leaseId ||
        isExpired(state.leaseExpiresAt, now) || state.sourceEpoch !== lease.sourceEpoch ||
        state.scopeRevision !== lease.scopeRevision) return null
      // A failed/invalid uncommitted input taints this epoch. Rotate even when the selected
      // prompt/model/schema fingerprint is unchanged so stale partial context cannot resume.
      if (state.sessionFingerprint !== fingerprint || state.tainted || forceRotate) {
        this.db.prepare(
          'UPDATE chat_context_cache SET session_epoch = session_epoch + 1, session_fingerprint = ?, ' +
          'accepted_turns = 0, submitted_requests = 0, submitted_user_utf8_bytes = 0, ' +
          'last_accepted_at = NULL, tainted = 0, state_version = state_version + 1, updated_at = ? ' +
          'WHERE chat_id = ? AND active_lease_id = ? AND source_epoch = ?'
        ).run(fingerprint, now, lease.chatId, lease.leaseId, lease.sourceEpoch)
      }
      return readChatSourceState(this.db, lease.chatId)
    })
    const state = runImmediateTransaction(tx)
    return state ? leaseFromState(state, lease.leaseId, lease.expiresAt, lease.window) : null
  }

  beginAttempt(lease: ChatSourceLease, serializedUserPayload: string, now = new Date().toISOString()): BeginSourceAttemptResult {
    const bytes = Buffer.byteLength(serializedUserPayload, 'utf8')
    const tx = this.db.transaction(() => {
      const state = readChatSourceState(this.db, lease.chatId)
      if (!state) return { ok: false, reason: 'chat_missing' } as const
      if (state.activeLeaseId !== lease.leaseId || isExpired(state.leaseExpiresAt, now)) return { ok: false, reason: 'lease_stale' } as const
      if (state.sourceEpoch !== lease.sourceEpoch) return { ok: false, reason: 'source_stale' } as const
      if (state.scopeRevision !== lease.scopeRevision) return { ok: false, reason: 'scope_stale' } as const
      if (state.sessionEpoch !== lease.sessionEpoch || state.sessionFingerprint !== lease.sessionFingerprint) return { ok: false, reason: 'session_stale' } as const
      if (!state.sessionFingerprint) return { ok: false, reason: 'session_unset' } as const
      if (state.tainted) return { ok: false, reason: 'tainted' } as const
      if (state.acceptedTurns >= SOURCE_SESSION_TURNS_LIMIT) return { ok: false, reason: 'turn_limit' } as const
      if (state.submittedRequests >= SOURCE_SESSION_REQUESTS_LIMIT) return { ok: false, reason: 'request_limit' } as const
      if (state.submittedUserUtf8Bytes + bytes > SOURCE_SESSION_USER_BYTES_LIMIT) return { ok: false, reason: 'byte_limit' } as const

      const result = this.db.prepare(
        'UPDATE chat_context_cache SET submitted_requests = submitted_requests + 1, ' +
        'submitted_user_utf8_bytes = submitted_user_utf8_bytes + ?, state_version = state_version + 1, updated_at = ? ' +
        'WHERE chat_id = ? AND active_lease_id = ? AND source_epoch = ? AND scope_revision = ? ' +
        'AND submitted_requests = ? AND submitted_user_utf8_bytes = ? AND accepted_turns = ? AND tainted = 0'
      ).run(bytes, now, lease.chatId, lease.leaseId, lease.sourceEpoch, lease.scopeRevision,
        state.submittedRequests, state.submittedUserUtf8Bytes, state.acceptedTurns)
      if (result.changes !== 1) return { ok: false, reason: 'lease_stale' } as const
      const updated = readChatSourceState(this.db, lease.chatId) as ChatSourceState
      return { ok: true, attempt: updated.submittedRequests, userUtf8Bytes: bytes, state: updated } as const
    })
    return runImmediateTransaction(tx)
  }

  releaseLease(lease: ChatSourceLease, taint = false, now = new Date().toISOString()): boolean {
    const result = this.db.prepare(
      'UPDATE chat_context_cache SET active_lease_id = NULL, lease_expires_at = NULL, ' +
      'tainted = CASE WHEN ? = 1 THEN 1 ELSE tainted END, state_version = state_version + 1, updated_at = ? ' +
      'WHERE chat_id = ? AND active_lease_id = ?'
    ).run(taint ? 1 : 0, now, lease.chatId, lease.leaseId)
    return result.changes === 1
  }

  commitLease(input: {
    lease: ChatSourceLease
    selectedRows: readonly SourceFingerprintRef[]
    fallbackRecent: () => MessageDTO[]
    apply?: () => void
    acceptedAt?: string
  }): CommitSourceLeaseResult {
    const now = input.acceptedAt ?? new Date().toISOString()
    let usedFallback = false
    let usedAppendRebase = false
    let appendCount = 0
    let committedWindow: SourceWindowRef[] = []

    const tx = this.db.transaction(() => {
      const state = readChatSourceState(this.db, input.lease.chatId)
      if (!state) return { ok: false, reason: 'chat_missing' } as const
      if (state.activeLeaseId !== input.lease.leaseId || isExpired(state.leaseExpiresAt, now)) return { ok: false, reason: 'lease_stale' } as const
      if (state.sourceEpoch !== input.lease.sourceEpoch) {
        this.releaseLease(input.lease, true, now)
        return { ok: false, reason: 'source_stale' } as const
      }
      if (state.scopeRevision !== input.lease.scopeRevision) {
        this.releaseLease(input.lease, true, now)
        return { ok: false, reason: 'scope_stale' } as const
      }
      if (state.sessionEpoch !== input.lease.sessionEpoch || state.sessionFingerprint !== input.lease.sessionFingerprint) {
        this.releaseLease(input.lease, true, now)
        return { ok: false, reason: 'session_stale' } as const
      }
      if (state.todoIdentityRevision !== input.lease.todoIdentityRevision ||
        state.topicIdentityRevision !== input.lease.topicIdentityRevision) {
        this.releaseLease(input.lease, true, now)
        return { ok: false, reason: 'identity_stale' } as const
      }
      if (state.acceptedTurns >= SOURCE_SESSION_TURNS_LIMIT) return { ok: false, reason: 'turn_limit' } as const
      if (!state.sessionFingerprint) return { ok: false, reason: 'session_unset' } as const
      if (state.submittedRequests === 0) return { ok: false, reason: 'attempt_missing' } as const
      if (state.tainted) return { ok: false, reason: 'tainted' } as const

      const selectedRows = selectRows(this.db, input.lease.chatId, input.selectedRows.map((row) => row.msgId))
      const selectedById = new Map(selectedRows.map((row) => [row.msgId, row]))
      if (input.selectedRows.some((ref) => {
        const row = selectedById.get(ref.msgId)
        return !row || fingerprintSourceMessage(row) !== ref.contentFingerprint
      })) {
        this.releaseLease(input.lease, true, now)
        return { ok: false, reason: 'selected_row_stale' } as const
      }

      appendCount = state.appendSeq - input.lease.appendSeq
      if (appendCount < 0) return { ok: false, reason: 'append_gap' } as const
      const chat = this.getChat(input.lease.chatId, state.sourceEpoch)
      const currentContext = this.currentContext(chat, state.sourceEpoch, state.appendSeq)
      let nextRows: MessageDTO[] | null = null

      if (currentContext) {
        const current = selectRows(this.db, input.lease.chatId, currentContext.map((row) => row.msgId))
        const byId = new Map(current.map((row) => [row.msgId, row]))
        if (currentContext.every((ref) => {
          const row = byId.get(ref.msgId)
          return !!row && fingerprintSourceMessage(row) === ref.contentFingerprint
        })) {
          nextRows = current
          usedAppendRebase = appendCount > 0
        }
      }

      if (!nextRows && input.lease.windowComplete) {
        const appendEvents = this.appendEventsAfter(chat, input.lease.appendSeq, state.appendSeq)
        if (appendEvents && appendEvents.length === appendCount) {
          const mergedIds = [...input.lease.window.map((row) => row.msgId), ...appendEvents.map((row) => row.msgId)]
          const merged = selectRows(this.db, input.lease.chatId, [...new Set(mergedIds)])
          const byId = new Map(merged.map((row) => [row.msgId, row]))
          const baseValid = input.lease.window.every((ref) => {
            const row = byId.get(ref.msgId)
            return !!row && fingerprintSourceMessage(row) === ref.contentFingerprint
          })
          const appendValid = appendEvents.every((event) => {
            const row = byId.get(event.msgId)
            return !!row && row.ts === event.ts && fingerprintSourceMessage(row) === event.contentFingerprint
          })
          if (baseValid && appendValid) {
            nextRows = merged.sort((a, b) => a.ts - b.ts || a.msgId.localeCompare(b.msgId)).slice(-SOURCE_WINDOW_LIMIT)
            usedAppendRebase = appendCount > 0
          }
        }
      }

      if (!nextRows) {
        usedFallback = true
        this.stats.appendFallbacks += 1
        const fallback = input.fallbackRecent()
        if (fallback.some((row) => row.chatId !== input.lease.chatId)) {
          return { ok: false, reason: 'window_corrupt' } as const
        }
        nextRows = fallback.slice(-SOURCE_WINDOW_LIMIT)
      }

      if (nextRows.length > SOURCE_WINDOW_LIMIT) return { ok: false, reason: 'window_corrupt' } as const
      committedWindow = nextRows.map((row, position) => ({
        position,
        msgId: row.msgId,
        contentFingerprint: fingerprintSourceMessage(row)
      }))

      const update = this.db.prepare(
        'UPDATE chat_context_cache SET window_complete = 1, window_digest = ?, ' +
        'accepted_turns = accepted_turns + 1, last_accepted_at = ?, active_lease_id = NULL, lease_expires_at = NULL, ' +
        'tainted = 0, state_version = state_version + 1, updated_at = ? ' +
        'WHERE chat_id = ? AND source_epoch = ? AND scope_revision = ? AND active_lease_id = ? ' +
        'AND lease_expires_at > ? AND accepted_turns < ?'
      ).run(fingerprintSourceWindow(committedWindow), now, now, input.lease.chatId,
        input.lease.sourceEpoch, input.lease.scopeRevision, input.lease.leaseId, now, SOURCE_SESSION_TURNS_LIMIT)
      if (update.changes !== 1) return { ok: false, reason: 'lease_stale' } as const
      if (input.apply) input.apply()
      this.db.prepare('DELETE FROM chat_context_cache_window WHERE chat_id = ?').run(input.lease.chatId)
      const insertWindow = this.db.prepare(
        'INSERT INTO chat_context_cache_window(chat_id,position,msg_id,content_fingerprint) VALUES(?,?,?,?)'
      )
      for (const row of committedWindow) {
        insertWindow.run(input.lease.chatId, row.position, row.msgId, row.contentFingerprint)
      }
      const updated = readChatSourceState(this.db, input.lease.chatId) as ChatSourceState
      return { ok: true, window: committedWindow, usedAppendRebase, usedFallback, appendCount, state: updated } as const
    })

    const result = runImmediateTransaction(tx)
    if (result.ok) {
      const chat = this.getChat(input.lease.chatId, result.state.sourceEpoch)
      chat.contextWindow = {
        sourceEpoch: result.state.sourceEpoch,
        appendSeq: result.state.appendSeq,
        rows: result.window.map((row) => ({ msgId: row.msgId, contentFingerprint: row.contentFingerprint }))
      }
      const rows = selectRows(this.db, input.lease.chatId, result.window.map((row) => row.msgId))
      for (const row of rows) this.retainRow(input.lease.chatId, row, result.state.sourceEpoch)
    }
    return result
  }
}

const perConnection = new WeakMap<Database, SharedSourceRows>()

/** Use the driver's immediate transaction mode when exposed; fallback remains atomic on compatible wrappers. */
export function runImmediateTransaction<T>(tx: (() => T) & { immediate?: () => T }): T {
  return typeof tx.immediate === 'function' ? tx.immediate() : tx()
}

/**
 * Called only after the runtime-owned process lock has been acquired. Any durable active lease then
 * belongs to an exited owner: release its coordination lock and taint the session so the next
 * request rotates to a fresh Host epoch. Raw messages, acknowledgements, and accepted window refs
 * remain untouched.
 */
export function recoverAbandonedSourceLeases(db:Database,ownerLockProof:RuntimeOwnerProof,ownerDir:string,dbPath:string,now=new Date().toISOString()):number {
  const actualDbPath=databasePathFor(db)
  if(typeof actualDbPath!=='string'||actualDbPath===':memory:'||actualDbPath!==resolve(dbPath))return 0
  if(!claimRuntimeOwnerProof(ownerLockProof,ownerDir,dbPath))return 0
  const tx=db.transaction(()=>db.prepare(`UPDATE chat_context_cache SET active_lease_id=NULL,lease_expires_at=NULL,tainted=1,state_version=state_version+1,updated_at=? WHERE active_lease_id IS NOT NULL`).run(now).changes)
  return runImmediateTransaction(tx)
}

export function sharedSourceRows(db: Database): SharedSourceRows {
  let cache = perConnection.get(db)
  if (!cache) {
    cache = new SharedSourceRows(db)
    perConnection.set(db, cache)
  }
  return cache
}

