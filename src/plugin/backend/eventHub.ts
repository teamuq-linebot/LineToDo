/**
 * eventHub.ts — 事件推送 session 的 backend 端（設計 v2 §4.6）。
 *
 * `LineTodoApi` 有 8 個 `on*` 訂閱（line.onMessage/onStatus、db.onMessagesPersisted、pipeline.onRun/onStatus/onTodosChanged/
 * onBackfillProgress/onReconcileProgress），sandbox view 沒有 IPC push，且 1.6.8 的 view 對自己的 backend 只有 `backend.call`
 * （request/response，≤ 64 KiB，單次 ≤ 30 s；ai-lover 0.3.0 `voice.pull` 同樣的限制）。所以：
 *
 *   - 所有事件進同一個有界 ring（單調遞增 seq）。
 *   - 主傳輸：長輪詢 `events.open` / `events.pull {afterSeq, waitMs}` / `events.close`（走 `api.invoke`）。
 *     以 `afterSeq` 取代 server 端游標，所以回應掉了可以原樣重問、不遺失也不重複；ring 已滾掉的部分用 `gap:true` 告知，
 *     view 端應重新拉一次狀態（pipeline.status／todos.list）。
 *   - 副傳輸（**目前未啟用**，review F9）：host 的 capability session `openSession({capability:'linetodo.events'})`，事件經 `channel.send` 推送
 *     （單則 ≤ 16 KiB、合併成 `{type:'events'}` 批次、節流避免超過 host 的每秒訊息數）。manifest 沒有宣告任何 provided capability，所以 1.6.8 的 host
 *     永遠不會對這個外掛呼叫 `ext-session-open`；實際的事件傳輸只有上面的長輪詢。程式與測試保留，是為了日後 manifest 宣告
 *     `linetodo.events` 時不必再動 backend；在那之前它是沒有呼叫端的備援，不要把它當成第二條會被用到的傳輸。
 *
 * 全部 timer 都 unref 並在 close／dispose 清掉（deactivate 後不留 handle）。
 */
import { randomBytes } from 'node:crypto'
import type { JsonValue, SessionChannel, SessionHandler, SessionInfo } from './types'
import { BACKEND_LIMITS } from './types'

export const EVENTS_CAPABILITY = 'linetodo.events'

export interface HubEvent {
  seq: number
  type: string
  /** 毫秒 epoch。 */
  t: number
  payload: JsonValue
}

export interface EventHubOptions {
  maxEvents?: number
  maxBytes?: number
  maxSessions?: number
  idleMs?: number
  maxWaitMs?: number
  pullBudgetBytes?: number
  /** 單一事件 payload 的上限（超過先壓縮、仍超過就換成 `{overflow:true}`）。 */
  maxEventBytes?: number
  /** capability 傳輸：批次合併的等待時間。 */
  flushMs?: number
  now?(): number
}

const DEFAULTS = Object.freeze({
  maxEvents: 512,
  maxBytes: 1024 * 1024,
  maxSessions: 4,
  idleMs: 120_000,
  maxWaitMs: 4000,
  pullBudgetBytes: 48 * 1024,
  maxEventBytes: 12 * 1024,
  flushMs: 50
})

const fail = (code: string, message?: string): { ok: false; code: string; message?: string } => ({ ok: false, code, ...(message ? { message } : {}) })
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 轉成純 JSON 值；過大時截短字串／陣列，仍過大就只留 overflow 標記（view 端應重新拉狀態）。 */
export function compactPayload(payload: unknown, maxBytes: number): JsonValue {
  let value: JsonValue
  try {
    const text = JSON.stringify(payload ?? null)
    if (text === undefined) return null
    if (Buffer.byteLength(text) <= maxBytes) return JSON.parse(text) as JsonValue
    value = JSON.parse(text) as JsonValue
  } catch {
    return { overflow: true, reason: 'not_serializable' }
  }
  let changed = false
  const slim = (node: JsonValue): JsonValue => {
    if (typeof node === 'string') {
      if (node.length > 600) { changed = true; return `${node.slice(0, 600)}…` }
      return node
    }
    if (Array.isArray(node)) {
      const head = node.length > 50 ? (changed = true, node.slice(0, 50)) : node
      return head.map(slim)
    }
    if (node !== null && typeof node === 'object') {
      const out: { [key: string]: JsonValue } = {}
      for (const [k, v] of Object.entries(node)) out[k] = slim(v)
      return out
    }
    return node
  }
  const slimmed = slim(value)
  const final = changed && plain(slimmed) ? { ...(slimmed as { [key: string]: JsonValue }), truncated: true } : slimmed
  const bytes = Buffer.byteLength(JSON.stringify(final))
  return bytes <= maxBytes ? final : { overflow: true, bytes }
}

interface PollSession {
  id: string
  kind: 'poll'
  seen: number
  idle: NodeJS.Timeout | null
  wake: (() => void) | null
  closed: boolean
}

interface ChannelSession {
  id: string
  kind: 'channel'
  channel: SessionChannel
  queue: HubEvent[]
  flush: NodeJS.Timeout | null
  closed: boolean
}

export class EventHub {
  private readonly o: Required<Omit<EventHubOptions, 'now'>> & { now(): number }
  private ring: Array<{ event: HubEvent; bytes: number }> = []
  private ringBytes = 0
  private seq = 0
  private readonly sessions = new Map<string, PollSession | ChannelSession>()
  private disposed = false

  constructor(options: EventHubOptions = {}) {
    this.o = { ...DEFAULTS, ...options, now: options.now ?? (() => Date.now()) } as EventHub['o']
  }

  /** 目前最新的 seq（0＝還沒有事件）。 */
  get head(): number { return this.seq }

  private get oldest(): number { return this.ring.length > 0 ? this.ring[0].event.seq : this.seq + 1 }

  publish(type: string, payload: unknown): number {
    if (this.disposed) return this.seq
    const compact = compactPayload(payload, this.o.maxEventBytes)
    const event: HubEvent = { seq: ++this.seq, type, t: this.o.now(), payload: compact }
    const bytes = Buffer.byteLength(JSON.stringify(event))
    this.ring.push({ event, bytes })
    this.ringBytes += bytes
    while (this.ring.length > this.o.maxEvents || (this.ringBytes > this.o.maxBytes && this.ring.length > 1)) this.ringBytes -= this.ring.shift()!.bytes
    for (const session of this.sessions.values()) {
      if (session.kind === 'poll') session.wake?.()
      else this.enqueue(session, event)
    }
    return event.seq
  }

  // ── 長輪詢傳輸 ──

  open(params: unknown): { ok: true; sessionId: string; seq: number; oldestSeq: number } | { ok: false; code: string; message?: string } {
    if (this.disposed) return fail('backend_stopped')
    const options = plain(params) ? params : {}
    if (this.sessions.size >= this.o.maxSessions) this.evictIdlest()
    const record: PollSession = { id: randomBytes(16).toString('hex'), kind: 'poll', seen: this.o.now(), idle: null, wake: null, closed: false }
    this.sessions.set(record.id, record)
    this.touch(record)
    // sinceSeq 給了就從那裡回放；沒給＝只收開啟之後的新事件（呼叫端拿 seq 當 afterSeq）。
    const since = typeof options.sinceSeq === 'number' && Number.isFinite(options.sinceSeq) ? Math.max(0, Math.floor(options.sinceSeq)) : this.seq
    return { ok: true, sessionId: record.id, seq: since, oldestSeq: this.oldest }
  }

  async pull(params: unknown): Promise<
    | { ok: true; events: HubEvent[]; seq: number; head: number; gap: boolean; closed: boolean }
    | { ok: false; code: string; message?: string }
  > {
    if (this.disposed) return fail('backend_stopped')
    const found = plain(params) && typeof params.sessionId === 'string' ? this.sessions.get(params.sessionId) : undefined
    if (!found || found.kind !== 'poll') return fail('session_not_found')
    const record: PollSession = found
    const p = params as Record<string, unknown>
    const afterSeq = typeof p.afterSeq === 'number' && Number.isFinite(p.afterSeq) ? Math.max(0, Math.floor(p.afterSeq)) : this.seq
    const wait = typeof p.waitMs === 'number' && Number.isFinite(p.waitMs) ? Math.min(Math.max(0, p.waitMs), this.o.maxWaitMs) : 0
    this.touch(record)
    record.wake?.() // 較新的 pull 取代還在等的舊 pull
    if (afterSeq >= this.seq && !record.closed && wait > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, wait)
        timer.unref?.()
        function done(): void {
          clearTimeout(timer)
          if (record.wake === done) record.wake = null
          resolve()
        }
        record.wake = done
      })
    }
    if (this.disposed || record.closed) return { ok: true, events: [], seq: afterSeq, head: this.seq, gap: false, closed: true }
    const gap = afterSeq + 1 < this.oldest && this.seq > afterSeq
    const events: HubEvent[] = []
    let bytes = 0
    for (const { event, bytes: size } of this.ring) {
      if (event.seq <= afterSeq) continue
      if (events.length > 0 && bytes + size > this.o.pullBudgetBytes) break
      events.push(event)
      bytes += size
    }
    return { ok: true, events, seq: events.length > 0 ? events[events.length - 1].seq : afterSeq, head: this.seq, gap, closed: false }
  }

  close(params: unknown): { ok: true } {
    const id = plain(params) && typeof params.sessionId === 'string' ? params.sessionId : ''
    const record = this.sessions.get(id)
    if (record) this.drop(record, 'closed_by_view')
    return { ok: true }
  }

  // ── capability session 傳輸（host 的 openSession）──

  attachChannel(info: SessionInfo, channel: SessionChannel): SessionHandler {
    if (info.capability !== EVENTS_CAPABILITY) throw Object.assign(new Error('capability not supported'), { code: 'session_unsupported' })
    if (this.disposed) throw Object.assign(new Error('backend stopped'), { code: 'plugin_backend_not_ready' })
    if (this.sessions.size >= this.o.maxSessions) this.evictIdlest()
    const record: ChannelSession = { id: info.sessionId, kind: 'channel', channel, queue: [], flush: null, closed: false }
    this.sessions.set(record.id, record)
    const since = info.options.sinceSeq
    if (typeof since === 'number' && Number.isFinite(since)) this.replayTo(record, Math.max(0, Math.floor(since)))
    return {
      message: (message) => {
        if (record.closed) return
        if (message.type === 'resume' && typeof message.sinceSeq === 'number') this.replayTo(record, Math.max(0, Math.floor(message.sinceSeq)))
        else if (message.type === 'ping') this.sendNow(record, { type: 'pong', head: this.seq, oldestSeq: this.oldest })
      },
      close: () => this.drop(record, 'provider_gone')
    }
  }

  private replayTo(record: ChannelSession, afterSeq: number): void {
    const gap = afterSeq + 1 < this.oldest && this.seq > afterSeq
    if (gap) this.sendNow(record, { type: 'gap', oldestSeq: this.oldest, head: this.seq })
    for (const { event } of this.ring) if (event.seq > afterSeq) this.enqueue(record, event)
  }

  private enqueue(record: ChannelSession, event: HubEvent): void {
    if (record.closed) return
    record.queue.push(event)
    if (record.flush === null) {
      record.flush = setTimeout(() => this.flushChannel(record), this.o.flushMs)
      record.flush.unref?.()
    }
  }

  private flushChannel(record: ChannelSession): void {
    record.flush = null
    if (record.closed || record.queue.length === 0) return
    // 合併成 ≤ sessionMessageBytes 的批次。
    let batch: HubEvent[] = []
    let size = 64
    const sendBatch = (): void => {
      if (batch.length > 0) this.sendNow(record, { type: 'events', head: this.seq, events: batch as unknown as Record<string, unknown>[] })
      batch = []
      size = 64
    }
    for (const event of record.queue.splice(0)) {
      const bytes = Buffer.byteLength(JSON.stringify(event)) + 1
      if (batch.length > 0 && size + bytes > BACKEND_LIMITS.sessionMessageBytes) sendBatch()
      batch.push(event)
      size += bytes
    }
    sendBatch()
  }

  private sendNow(record: ChannelSession, message: Record<string, unknown>): void {
    try {
      record.channel.send(message)
    } catch {
      this.drop(record, 'send_failed') // host 已關掉這個 session
    }
  }

  // ── 共用 ──

  private touch(record: PollSession): void {
    record.seen = this.o.now()
    if (record.idle) clearTimeout(record.idle)
    record.idle = setTimeout(() => this.drop(record, 'idle'), this.o.idleMs)
    record.idle.unref?.()
  }

  private evictIdlest(): void {
    let victim: PollSession | ChannelSession | null = null
    let oldest = Infinity
    for (const session of this.sessions.values()) {
      const seen = session.kind === 'poll' ? session.seen : 0
      if (seen < oldest) { oldest = seen; victim = session }
    }
    if (victim) this.drop(victim, 'evicted')
  }

  private drop(record: PollSession | ChannelSession, reason: string): void {
    if (record.closed) return
    record.closed = true
    this.sessions.delete(record.id)
    if (record.kind === 'poll') {
      if (record.idle) clearTimeout(record.idle)
      record.idle = null
      record.wake?.()
    } else {
      if (record.flush) clearTimeout(record.flush)
      record.flush = null
      record.queue.length = 0
      if (reason !== 'provider_gone') {
        try { record.channel.close(/^[a-z0-9_]{3,48}$/.test(reason) ? reason : 'provider_closed') } catch { /* 已關閉 */ }
      }
    }
  }

  stats(): { head: number; oldest: number; buffered: number; bufferedBytes: number; sessions: number } {
    return { head: this.seq, oldest: this.oldest, buffered: this.ring.length, bufferedBytes: this.ringBytes, sessions: this.sessions.size }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const record of [...this.sessions.values()]) this.drop(record, 'provider_gone')
    this.sessions.clear()
    this.ring = []
    this.ringBytes = 0
  }
}
