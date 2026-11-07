import type { Database } from 'better-sqlite3'
import type { LlmProvider } from '../../llm/provider/types'
import { chatTodoPrefsReady } from '../../db/chatTodoPrefs.repo'

export interface TopicBackgroundConfig {
  startDelayMs: number
  debounceMs: number
  minIntervalMs: number
  smallBatch: number
  flushMs: number
  maxChatsPerTick: number
  backoffBaseMs: number
  backoffMaxMs: number
  idleRecheckMs: number
  softRetryMs: number
}

export const TOPIC_BACKGROUND_DEFAULTS: TopicBackgroundConfig = {
  startDelayMs: 30_000,
  debounceMs: 10_000,
  minIntervalMs: 120_000,
  smallBatch: 5,
  flushMs: 1_800_000,
  maxChatsPerTick: 2,
  backoffBaseMs: 60_000,
  backoffMaxMs: 1_800_000,
  idleRecheckMs: 300_000,
  softRetryMs: 30_000
}

export interface TopicBackgroundService {
  analyze(chatId: string, resolveProvider: () => LlmProvider | null): Promise<{ ok: boolean; reason?: string; analyzedCount?: number }>
  pendingCount(chatId: string): number
}

export interface TopicBackgroundOptions {
  db: Database
  service: TopicBackgroundService
  resolveProvider: () => LlmProvider | null
  active: () => boolean
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => () => void
  log?: (event: string, detail?: Record<string, unknown>) => void
  config?: Partial<TopicBackgroundConfig>
}

export interface TopicBackground {
  start(): void
  stop(): void
  kick(): void
  stats(): { started: boolean; ticks: number; analyses: number; failures: number; skippedInactive: number; trackedChats: number }
}

const NOT_FAILURES = new Set(['disabled', 'unsupported_chat', 'unavailable'])

const defaultSetTimer = (fn: () => void, ms: number): (() => void) => {
  const handle = setTimeout(fn, ms)
  if (typeof handle === 'object' && handle && typeof (handle as { unref?: () => void }).unref === 'function') (handle as { unref: () => void }).unref()
  return () => clearTimeout(handle)
}

interface ChatState {
  lastAnalyzedAt: number | null
  firstSeenAt: number | null
  failures: number
  notBefore: number
}

export function createTopicBackground(opts: TopicBackgroundOptions): TopicBackground {
  const cfg: TopicBackgroundConfig = { ...TOPIC_BACKGROUND_DEFAULTS, ...(opts.config ?? {}) }
  const now = opts.now ?? Date.now
  const setTimer = opts.setTimer ?? defaultSetTimer
  const log = (event: string, detail?: Record<string, unknown>): void => { try { opts.log?.(event, detail) } catch { /* diagnostics only */ } }
  const states = new Map<string, ChatState>()
  let started = false
  let running = false
  let rerun = false
  let cancel: (() => void) | null = null
  let providerBackoffUntil = 0
  const counters = { ticks: 0, analyses: 0, failures: 0, skippedInactive: 0 }

  const stateOf = (chatId: string): ChatState => {
    let s = states.get(chatId)
    if (!s) { s = { lastAnalyzedAt: null, firstSeenAt: null, failures: 0, notBefore: 0 }; states.set(chatId, s) }
    return s
  }

  const candidates = (): string[] => {
    try {
      if (!chatTodoPrefsReady(opts.db)) return []
      const rows = opts.db.prepare(
        `SELECT c.chat_id AS chatId FROM chats c
           JOIN group_topic_preferences g ON g.chat_id=c.chat_id AND g.enabled=1
           JOIN chat_todo_preferences t ON t.chat_id=c.chat_id AND t.extract_enabled=0
          WHERE c.blocked=0 ORDER BY c.last_seen_at DESC LIMIT 200`
      ).all() as Array<{ chatId: string }>
      return rows.map((r) => r.chatId)
    } catch {
      return []
    }
  }

  const clearTimer = (): void => { if (cancel) { cancel(); cancel = null } }
  const schedule = (ms: number): void => {
    if (!started) return
    clearTimer()
    cancel = setTimer(() => { cancel = null; void tick() }, Math.max(0, ms))
  }

  /** 0＝現在可跑；正數＝還要等多久；null＝目前沒有待分析訊息。 */
  const waitFor = (chatId: string, pending: number, at: number): number | null => {
    if (pending <= 0) return null
    const s = stateOf(chatId)
    if (s.firstSeenAt === null) s.firstSeenAt = at
    let ready = at
    if (pending >= cfg.smallBatch) {
      if (s.lastAnalyzedAt !== null) ready = s.lastAnalyzedAt + cfg.minIntervalMs
    } else {
      ready = (s.lastAnalyzedAt ?? s.firstSeenAt) + cfg.flushMs
    }
    ready = Math.max(ready, s.notBefore)
    return Math.max(0, ready - at)
  }

  async function tick(): Promise<void> {
    if (!started) return
    if (running) { rerun = true; return }
    running = true
    counters.ticks += 1
    let nextDelay = cfg.idleRecheckMs
    try {
      if (!opts.active()) {
        counters.skippedInactive += 1
        return
      }
      const ids = candidates()
      const live = new Set(ids)
      for (const id of [...states.keys()]) if (!live.has(id)) states.delete(id)
      if (ids.length === 0) return
      if (now() < providerBackoffUntil) {
        nextDelay = providerBackoffUntil - now()
        return
      }
      const due: string[] = []
      let soonest: number | null = null
      for (const id of ids) {
        let pending = 0
        try { pending = opts.service.pendingCount(id) } catch { pending = 0 }
        const wait = waitFor(id, pending, now())
        if (wait === null) { const s = stateOf(id); s.firstSeenAt = null; continue }
        if (wait === 0) due.push(id)
        else soonest = soonest === null ? wait : Math.min(soonest, wait)
      }
      if (soonest !== null) nextDelay = Math.min(nextDelay, soonest)
      if (due.length === 0) return
      let provider: LlmProvider | null = null
      try { provider = opts.resolveProvider() } catch { provider = null }
      let healthy = false
      if (provider) { try { healthy = (await provider.health()).ok === true } catch { healthy = false } }
      if (!healthy) {
        providerBackoffUntil = now() + cfg.backoffBaseMs
        nextDelay = cfg.backoffBaseMs
        log('provider_unhealthy', { retryInMs: cfg.backoffBaseMs })
        return
      }
      const batch = due.slice(0, Math.max(1, cfg.maxChatsPerTick))
      for (const chatId of batch) {
        if (!started) return
        const s = stateOf(chatId)
        let result: { ok: boolean; reason?: string; analyzedCount?: number }
        try {
          result = await opts.service.analyze(chatId, () => provider)
        } catch {
          result = { ok: false, reason: 'analysis_failed' }
        }
        const at = now()
        if (result.ok) {
          s.lastAnalyzedAt = at
          s.firstSeenAt = null
          s.failures = 0
          s.notBefore = 0
          counters.analyses += 1
          log('analyzed', { analyzedCount: result.analyzedCount ?? 0 })
        } else if (result.reason && (result.reason.startsWith('identity_') || result.reason === 'source_changed')) {
          s.notBefore = at + cfg.softRetryMs
          log('deferred', { reason: result.reason })
        } else if (result.reason && NOT_FAILURES.has(result.reason)) {
          s.notBefore = at + cfg.idleRecheckMs
          log('skipped', { reason: result.reason })
        } else {
          s.failures += 1
          counters.failures += 1
          const delay = Math.min(cfg.backoffMaxMs, cfg.backoffBaseMs * 2 ** (s.failures - 1))
          s.notBefore = at + delay
          log('failed', { reason: result.reason ?? 'unknown', failures: s.failures, retryInMs: delay })
        }
      }
      if (due.length > batch.length) nextDelay = Math.min(nextDelay, cfg.debounceMs)
      for (const id of batch) {
        let remaining = 0
        try { remaining = opts.service.pendingCount(id) } catch { remaining = 0 }
        const wait = waitFor(id, remaining, now())
        if (wait === null) { stateOf(id).firstSeenAt = null; continue }
        nextDelay = Math.min(nextDelay, Math.max(cfg.debounceMs, wait))
      }
    } finally {
      running = false
      if (started) {
        if (rerun) { rerun = false; schedule(cfg.debounceMs) }
        else schedule(Math.max(1000, nextDelay))
      }
    }
  }

  return {
    start() {
      if (started) return
      started = true
      schedule(cfg.startDelayMs)
    },
    stop() {
      started = false
      rerun = false
      clearTimer()
    },
    kick() {
      if (!started) return
      schedule(cfg.debounceMs)
    },
    stats() {
      return { started, ...counters, trackedChats: states.size }
    }
  }
}
