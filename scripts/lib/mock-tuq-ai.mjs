// A mock `window.tuqPlugin.ai` that reproduces TeamUQ 1.6.8's ai:chat behaviour (read-only reference: teamuq-electron @ b8b96cb3):
//   packages/plugin-sdk/src/aiChatContracts.ts                       limits, strict request schema, error / failure codes, event kinds
//   packages/platform/plugin-runtime/src/adapters/preload/aiViewBridge.ts   view-side session object (send/onEvent/interrupt/close, early + backlog event queues)
//   packages/platform/plugin-runtime/src/main/aiChat/aiChatService.ts       authorization, view_not_visible, session_limit, turn_in_progress, sliding-window
//                                                                    rate limit (20/min, 400/h), quota cooldown, busy, reply_too_long, access revocation
//   apps/desktop/src/main/pluginSurface/aiRelay.ts + capabilityGuard.ts    `visible` = view.canOpen() (placement ready && page visible)
//
// The numeric limits and code lists come from scripts/plugin/fixtures/ai-chat-contract-b8b96cb3.json (generated from the contract file by
// gen-ai-contract-fixture.mjs); test-ai-orchestrator asserts this mock and the orchestrator agree with it.
//
// Not reproduced (and not needed by the orchestrator): images, transcript replay, attachSession, the hidden-input credit exception (an orchestrator view is
// never the input target, so a hidden view always gets view_not_visible).
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CONTRACT = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'fixtures', 'ai-chat-contract-b8b96cb3.json'), 'utf8'))
const L = CONTRACT.limits

const fail = (code) => { throw new Error(code) }
const immediate = () => new Promise((resolve) => setImmediate(resolve))

/**
 * @param {object} [options]
 * @param {() => number} [options.now]            clock for the rate-limit window / quota cooldown (default Date.now)
 * @param {(ctx: {system: string, user: string, turn: number, sessionIndex: number, repair: boolean}) => any} [options.reply]
 *        what the model says. Return a string, or { text?, chunks?, fail?: code, hang?: boolean, empty?: boolean, delay?: () => Promise }.
 */
export function createMockTuqAi(options = {}) {
  const now = options.now ?? Date.now
  const control = {
    /** view.canOpen(): placement ready && page visible. */
    visible: true,
    /** the plugin still holds the ai:chat grant. */
    granted: true,
    /** provider state reported by getOptions. */
    providerState: 'ready',
    quotaUntil: 0,
    /** concurrentTurnsTotal is a Core-wide limit; set to simulate other plugins using the slots. */
    otherActiveTurns: 0,
    /** the next N sends are refused with turn_in_progress (Core is still finishing the previous turn, e.g. after an interrupt). */
    turnInProgressFor: 0
  }
  const stats = {
    getOptions: 0, openSession: 0, sends: 0, sessionsClosed: 0, interrupts: 0,
    errors: Object.fromEntries(CONTRACT.errorCodes.map((code) => [code, 0])),
    maxLiveSessions: 0,
    /** every accepted send: { at, sessionIndex, turnId, text, system } */
    turns: [],
    /** every request that was refused: { op, code, at } */
    refused: []
  }
  const sessions = new Map() // sessionId -> record
  const turnTimes = []
  let sessionCounter = 0
  let turnCounter = 0
  let activeTurns = 0

  const refuse = (op, code) => { stats.errors[code] += 1; stats.refused.push({ op, code, at: now() }); fail(code) }
  const live = () => [...sessions.values()]

  const authorize = (op) => {
    if (!control.granted) refuse(op, 'not_granted')
  }

  const strictKeys = (op, value, allowed) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse(op, 'request_invalid')
    for (const key of Object.keys(value)) if (!allowed.includes(key)) refuse(op, 'request_invalid')
  }

  const emit = (record, turn, event) => {
    const payload = { ...event, turnId: turn.id }
    if (record.listeners.size === 0) { if (record.backlog.length < 512) record.backlog.push(payload); return }
    for (const listener of [...record.listeners]) listener(payload)
  }

  const options_ = () => {
    const exhausted = control.quotaUntil > now()
    return {
      providers: [{
        id: 'codex', label: 'Codex', state: control.providerState,
        models: [{ id: 'gpt-5-codex', label: 'GPT-5 Codex', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', supportsImages: false, isDefault: true }]
      }],
      defaultProviderId: 'codex',
      limits: { systemChars: L.systemChars, transcriptLines: L.transcriptLines, transcriptChars: L.transcriptChars, inputChars: L.inputChars, imageBytes: L.imageBytes, turnsPerMinute: L.turnsPerMinute },
      quota: { state: exhausted ? 'exhausted' : 'ok', retryAfterMs: exhausted ? control.quotaUntil - now() : null }
    }
  }

  const closeRecord = (record) => {
    if (!sessions.delete(record.id)) return
    stats.sessionsClosed += 1
    if (record.running) interruptRecord(record)
  }

  const interruptRecord = (record) => {
    const turn = record.turn
    if (!record.running || !turn || turn.cancelled) return
    stats.interrupts += 1
    turn.cancelled = true
    turn.wake?.()
  }

  // The pump: events are delivered asynchronously (IPC), possibly before `send` resolves in the view.
  const pump = async (record, turn, text) => {
    try {
      await immediate()
      emit(record, turn, { kind: 'started' })
      const scripted = await (options.reply ? options.reply({ system: record.system, user: text, turn: stats.turns.length, sessionIndex: record.index, repair: record.turnCount > 1 }) : '{}')
      const script = typeof scripted === 'string' ? { text: scripted } : scripted ?? {}
      if (script.delay) await script.delay()
      if (script.hang) await new Promise((resolve) => { turn.wake = resolve })
      if (turn.cancelled) { emit(record, turn, { kind: 'interrupted' }); return }
      const chunks = script.chunks ?? (script.text === undefined || script.text === '' ? [] : [script.text])
      let total = ''
      for (const chunk of chunks) {
        await immediate()
        if (turn.cancelled) { emit(record, turn, { kind: 'interrupted' }); return }
        total += chunk
        emit(record, turn, { kind: 'textDelta', text: chunk })
        if (total.length > L.replyChars) { emit(record, turn, { kind: 'failed', code: 'reply_too_long', retryable: true, fallbackUsed: false, partialDelivered: true }); return }
      }
      await immediate()
      if (script.fail) {
        if (script.fail === 'quota_exhausted') control.quotaUntil = now() + L.quotaCooldownMs
        emit(record, turn, { kind: 'failed', code: script.fail, retryable: script.fail !== 'access_revoked', fallbackUsed: false, partialDelivered: total !== '' })
        return
      }
      if (script.empty || total.trim() === '') { emit(record, turn, { kind: 'failed', code: 'empty_reply', retryable: true, fallbackUsed: false, partialDelivered: false }); return }
      emit(record, turn, { kind: 'completed' })
    } finally {
      record.running = false
      activeTurns -= 1
    }
  }

  const makeSession = (record) => Object.freeze({
    sessionId: record.id,
    effective: Object.freeze({ providerId: 'codex', modelId: 'gpt-5-codex', effort: record.effort ?? 'medium' }),
    turn: null,
    send: async (input) => {
      const op = 'send'
      const body = { text: '', ...input }
      strictKeys(op, body, ['text', 'image'])
      if (typeof body.text !== 'string' || body.text.length > L.inputChars || body.text.trim() === '') refuse(op, 'request_invalid')
      authorize(op)
      if (!sessions.has(record.id)) refuse(op, 'session_not_found')
      if (!control.visible) refuse(op, 'view_not_visible')
      if (record.running) refuse(op, 'turn_in_progress')
      if (control.turnInProgressFor > 0) { control.turnInProgressFor -= 1; refuse(op, 'turn_in_progress') }
      if (control.quotaUntil > now()) refuse(op, 'quota_exhausted')
      const at = now()
      while (turnTimes.length > 0 && at - turnTimes[0] > 3_600_000) turnTimes.shift()
      if (turnTimes.length >= L.turnsPerHour || turnTimes.filter((time) => at - time <= 60_000).length >= L.turnsPerMinute) refuse(op, 'rate_limited')
      if (activeTurns + control.otherActiveTurns >= L.concurrentTurnsTotal) refuse(op, 'busy')
      turnTimes.push(at)
      activeTurns += 1
      record.running = true
      record.turnCount += 1
      const turn = { id: randomBytes(8).toString('hex'), cancelled: false, wake: null }
      record.turn = turn
      stats.sends += 1
      stats.turns.push({ at, sessionIndex: record.index, turnId: turn.id, text: body.text, system: record.system })
      void pump(record, turn, body.text)
      return Object.freeze({ turnId: turn.id })
    },
    onEvent: (listener) => {
      if (typeof listener !== 'function') throw new TypeError('onEvent requires a function')
      record.listeners.add(listener)
      setTimeout(() => { const pending = record.backlog; record.backlog = []; for (const event of pending) for (const l of [...record.listeners]) l(event) }, 0)
      return () => { record.listeners.delete(listener) }
    },
    interrupt: async () => { if (!sessions.has(record.id)) refuse('interrupt', 'session_not_found'); interruptRecord(record) },
    close: async () => { if (!sessions.has(record.id)) refuse('close', 'session_not_found'); closeRecord(record) }
  })

  const ai = Object.freeze({
    getOptions: async () => {
      stats.getOptions += 1
      authorize('getOptions')
      return JSON.parse(JSON.stringify(options_()))
    },
    openSession: async (request) => {
      const op = 'openSession'
      strictKeys(op, request, ['providerId', 'modelId', 'effort', 'system', 'transcript'])
      if (typeof request.system !== 'string' || request.system.length < 1 || request.system.length > L.systemChars) refuse(op, 'request_invalid')
      if (request.providerId !== undefined && !/^[a-z][a-z0-9_-]{0,31}$/.test(request.providerId)) refuse(op, 'request_invalid')
      if (request.modelId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/.test(request.modelId)) refuse(op, 'request_invalid')
      if (request.effort !== undefined && !CONTRACT.efforts.includes(request.effort)) refuse(op, 'request_invalid')
      authorize(op)
      if (!control.visible) refuse(op, 'view_not_visible')
      if ((request.providerId ?? 'codex') !== 'codex') refuse(op, 'provider_not_found')
      if (live().length >= L.sessionsPerPlugin) refuse(op, 'session_limit')
      if (control.providerState !== 'ready') refuse(op, 'provider_not_ready')
      if (request.modelId !== undefined && request.modelId !== 'gpt-5-codex') refuse(op, 'model_unavailable')
      if (request.effort !== undefined && !['low', 'medium', 'high'].includes(request.effort)) refuse(op, 'model_unavailable')
      stats.openSession += 1
      sessionCounter += 1
      const record = { id: randomBytes(16).toString('hex'), index: sessionCounter, system: request.system, effort: request.effort, listeners: new Set(), backlog: [], running: false, turn: null, turnCount: 0 }
      sessions.set(record.id, record)
      stats.maxLiveSessions = Math.max(stats.maxLiveSessions, sessions.size)
      return makeSession(record)
    }
  })

  Object.assign(control, {
    set(patch) { Object.assign(control, patch) },
    /** the user turns the ai:chat permission off: a running turn fails with access_revoked, sessions are closed, later calls get not_granted. */
    revoke() {
      control.granted = false
      for (const record of live()) {
        if (record.running && record.turn) emit(record, record.turn, { kind: 'failed', code: 'access_revoked', retryable: false, fallbackUsed: false, partialDelivered: false })
        closeRecord(record)
      }
    },
    exhaustQuota(ms = L.quotaCooldownMs) { control.quotaUntil = now() + ms },
    /** turns spent by someone else in this plugin's rate-limit window (another view, an earlier page load): the orchestrator cannot know about them. */
    consumeTurns(n) { for (let i = 0; i < n; i += 1) turnTimes.push(now()) },
    liveSessions: () => sessions.size,
    turnsInWindow: (windowMs = 60_000) => turnTimes.filter((t) => now() - t <= windowMs).length
  })
  return { ai, control, stats }
}
