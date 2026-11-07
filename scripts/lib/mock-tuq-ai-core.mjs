// A mock `context.host.ai` (the BACKEND side of TeamUQ's ai:chat) that reproduces Core 1.7.15's behaviour. Read-only references (teamuq-electron @ v1.7.15, bf4801ecc):
//   packages/plugin-sdk/src/aiChatContracts.ts                           limits, strict request schemas (complete: fresh | existing Session), error / failure codes, event kinds (incl. contentSaved)
//   apps/plugin-host/src/external/hostServices.ts                        the backend client: input validation (plugin_host_request_invalid), `complete` = one call
//                                                                        (310 s host timeout), failures are Errors with `.code` = the envelope's error, events reach only OPEN sessions' listeners
//   packages/platform/plugin-runtime/src/main/aiChat/aiChatOneShot.ts    complete: reserveSessionSlot (session_limit | busy), checkTurn (rate_limited | quota_exhausted),
//                                                                        provider_not_ready / model_unavailable, the new Session is closed on every result path
//   packages/platform/plugin-runtime/src/main/externalBackend/backendHostServices.ts   backend calls always count as visible (no view_not_visible), same rate-limit window as a view
//
// The numeric limits and code lists come from scripts/plugin/fixtures/ai-chat-contract-1.8.10.json (generated from the contract file by
// gen-ai-contract-fixture.mjs); test-ai-orchestrator asserts this mock and the backend AI port (src/plugin/backend/hostAi.ts) agree with it.
//
// Not reproduced (and not needed by the port): images, attachSession / resume, the hidden-input credit exception (backend calls are never hidden).
// This file is the mock itself and reads nothing from disk (the permission-model stand-in runs it inside the backend process); mock-tuq-ai.mjs loads the contract fixture and wraps it.

/** hostServices.ts `failure(code)`: what a rejected envelope looks like to the plugin. */
const hostFailure = (code) => Object.assign(new Error(`host request failed: ${code}`), { code })
const invalidRequest = () => Object.assign(new Error('host request invalid'), { code: 'plugin_host_request_invalid' })
const immediate = () => new Promise((resolve) => setImmediate(resolve))
const MODEL = 'gpt-5-codex'
const EFFORTS_OF_MODEL = ['low', 'medium', 'high']

/**
 * @param {object} [options]
 * @param {() => number} [options.now]            clock for the rate-limit window / quota cooldown (default Date.now)
 * @param {(ctx: {system: string, user: string, transcript: any[], turn: number, sessionIndex: number, repair: boolean, modelId: string, effort: string|null}) => any} [options.reply]
 *        what the model says. Return a string, or { text?, chunks?, fail?: code, hang?: boolean, empty?: boolean, delay?: () => Promise, events?: string[] }.
 *        `fail` is a turn failure code (aiChatContracts failureCodes) or a one-shot error code (errorCodes); `events: ['contentSaved']` adds those events to the turn.
 */
export function createMockTuqAiFor(CONTRACT, options = {}) {
  const L = CONTRACT.limits
  const now = options.now ?? Date.now
  const control = {
    /** the plugin still holds the ai:chat grant. */
    granted: true,
    /** provider state reported by getOptions. */
    providerState: 'ready',
    quotaUntil: 0,
    /** concurrentTurnsTotal is a Core-wide limit; set to simulate other plugins using the slots. */
    otherActiveTurns: 0,
    /** the next N calls that need a Session slot are refused with `busy` / `session_limit` (Core is still finishing the previous turn). */
    busyFor: 0,
    busyCode: 'busy',
    /** how long (in real ms) a completed request takes to be answered — 0 = next tick. */
    latencyMs: 0,
    /** Task ids the user deleted in TeamUQ: a turn sent with one of them is refused with task_not_found (createConversationExecution.ts task lookup). */
    deletedTasks: new Set()
  }
  const stats = {
    getOptions: 0, completes: 0, openSessions: 0, sessionsClosed: 0,
    errors: Object.fromEntries(CONTRACT.errorCodes.map((code) => [code, 0])),
    /** hostServices.ts `receiveAiEvent`: events for a Session nobody listens to (every complete() Session) are dropped, returning true. */
    droppedEvents: [],
    /** every accepted request: { at, kind: 'complete'|'send', system, text, transcript, modelId, effort, sessionId, requestId, taskId } */
    turns: [],
    /** every request that was refused: { op, code, at } */
    refused: [],
    maxLiveSessions: 0,
    maxConcurrentCompletes: 0
  }
  const sessions = new Map() // sessionId -> record (open sessions AND the Session of a running complete())
  const turnTimes = []
  let sessionCounter = 0
  let requestCounter = 0
  let activeTurns = 0
  let runningCompletes = 0

  const refuse = (op, code) => { stats.errors[code] = (stats.errors[code] ?? 0) + 1; stats.refused.push({ op, code, at: now() }); throw hostFailure(code) }
  const live = () => [...sessions.values()]

  const strictKeys = (value, allowed) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidRequest()
    for (const key of Object.keys(value)) if (!allowed.includes(key)) throw invalidRequest()
  }

  const providerOptions = () => {
    const exhausted = control.quotaUntil > now()
    return {
      providers: [{
        id: 'codex', label: 'Codex', state: control.providerState,
        models: [{ id: MODEL, label: 'GPT-5 Codex', efforts: [...EFFORTS_OF_MODEL], defaultEffort: 'medium', supportsImages: false, isDefault: true }]
      }],
      defaultProviderId: 'codex',
      limits: { systemChars: L.systemChars, transcriptLines: L.transcriptLines, transcriptChars: L.transcriptChars, inputChars: L.inputChars, imageBytes: L.imageBytes, turnsPerMinute: L.turnsPerMinute },
      quota: { state: exhausted ? 'exhausted' : 'ok', retryAfterMs: exhausted ? control.quotaUntil - now() : null }
    }
  }

  // aiChatService authorize(): plugin_not_active | not_granted
  const authorize = (op) => { if (!control.granted) refuse(op, 'not_granted') }

  /** aiChatOneShot.ts, in order: provider/model checks → session slot → rate limit / quota → concurrency → run → close. */
  const checkTurnAllowed = (op) => {
    if (control.quotaUntil > now()) refuse(op, 'quota_exhausted')
    const at = now()
    while (turnTimes.length > 0 && at - turnTimes[0] > 3_600_000) turnTimes.shift()
    if (turnTimes.length >= L.turnsPerHour || turnTimes.filter((time) => at - time <= 60_000).length >= L.turnsPerMinute) refuse(op, 'rate_limited')
  }

  const validateComplete = (input) => {
    if (typeof input !== 'object' || input === null) throw invalidRequest()
    const fresh = input.sessionId === undefined
    strictKeys(input, fresh ? ['taskId', 'providerId', 'modelId', 'effort', 'system', 'transcript', 'text', 'image'] : ['taskId', 'sessionId', 'modelId', 'effort', 'text', 'image'])
    if (typeof input.text !== 'string' || input.text.length > L.inputChars || input.text.trim() === '') throw invalidRequest()
    if (fresh) {
      if (typeof input.system !== 'string' || input.system.length < 1 || input.system.length > L.systemChars) throw invalidRequest()
      if (input.transcript !== undefined) {
        if (!Array.isArray(input.transcript) || input.transcript.length > L.transcriptLines) throw invalidRequest()
        for (const line of input.transcript) {
          strictKeys(line, ['role', 'text'])
          if (!['user', 'assistant'].includes(line.role) || typeof line.text !== 'string' || line.text.length > L.transcriptLineChars) throw invalidRequest()
        }
      }
      if (input.providerId !== undefined && !/^[a-z][a-z0-9_-]{0,31}$/.test(input.providerId)) throw invalidRequest()
    }
    if (input.modelId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/.test(input.modelId)) throw invalidRequest()
    if (input.effort !== undefined && !CONTRACT.efforts.includes(input.effort)) throw invalidRequest()
    if (input.image !== undefined) throw invalidRequest() // images are not reproduced
  }

  const script = async (record, text, effort) => {
    const context = {
      system: record.system, user: text, transcript: record.transcript, turn: stats.turns.length - 1, sessionIndex: record.index,
      repair: record.transcript.length > 0, modelId: record.modelId, effort: effort ?? record.effort ?? null
    }
    const scripted = await (options.reply ? options.reply(context) : '{}')
    return typeof scripted === 'string' ? { text: scripted } : scripted ?? {}
  }

  /** The Session lifecycle of one complete(): opened, one turn, closed on every result path (aiChatOneShot.ts finally blocks). */
  const complete = async (input) => {
    const op = 'complete'
    validateComplete(input)
    authorize(op)
    const fresh = input.sessionId === undefined
    if (!fresh) refuse(op, 'session_not_found') // a complete() Session is closed when it ends; no open Session exists in the line-todo flows
    if (input.taskId !== undefined && control.deletedTasks.has(input.taskId)) refuse(op, 'task_not_found')
    if ((input.providerId ?? 'codex') !== 'codex') refuse(op, 'provider_not_found')
    if (control.providerState !== 'ready') refuse(op, 'provider_not_ready')
    if (input.modelId !== undefined && input.modelId !== MODEL) refuse(op, 'model_unavailable')
    if (input.effort !== undefined && !EFFORTS_OF_MODEL.includes(input.effort)) refuse(op, 'model_unavailable')
    // reserveSessionSlot: sessionsPerPlugin = 1 (an open Session or a running complete holds it); 'busy' when Core is saturated
    if (control.busyFor > 0) { control.busyFor -= 1; refuse(op, control.busyCode) }
    if (live().length >= L.sessionsPerPlugin) refuse(op, 'session_limit')
    checkTurnAllowed(op)
    if (activeTurns + control.otherActiveTurns >= L.concurrentTurnsTotal) refuse(op, 'busy')

    sessionCounter += 1
    requestCounter += 1
    const record = {
      id: String(1000 + sessionCounter), index: sessionCounter, system: input.system, transcript: input.transcript ?? [], modelId: input.modelId ?? MODEL,
      effort: input.effort ?? null, listeners: new Set(), running: true
    }
    sessions.set(record.id, record)
    stats.maxLiveSessions = Math.max(stats.maxLiveSessions, sessions.size)
    stats.openSessions += 1
    activeTurns += 1
    runningCompletes += 1
    stats.maxConcurrentCompletes = Math.max(stats.maxConcurrentCompletes, runningCompletes)
    stats.completes += 1
    const at = now()
    turnTimes.push(at) // acceptedTurn
    const requestId = `req-${requestCounter}`
    stats.turns.push({ at, kind: 'complete', system: record.system, text: input.text, transcript: record.transcript, modelId: record.modelId, effort: input.effort ?? null, sessionId: record.id, requestId, taskId: input.taskId ?? null })
    const drop = (event) => stats.droppedEvents.push({ sessionId: record.id, event })
    try {
      await immediate()
      if (control.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, control.latencyMs))
      drop({ kind: 'started' })
      const scripted = await script(record, input.text, input.effort)
      if (scripted.delay) await scripted.delay()
      if (scripted.hang) await new Promise(() => undefined) // never answers (the port's own guard has to end it)
      if (!control.granted) refuse(op, 'interrupted') // aiChatService.denyAndClose → abortPluginAndWait: the one-shot is cancelled
      const chunks = scripted.chunks ?? (scripted.text === undefined || scripted.text === '' ? [] : [scripted.text])
      let total = ''
      for (const chunk of chunks) {
        await immediate()
        total += chunk
        drop({ kind: 'textDelta', text: chunk })
        for (const kind of scripted.events ?? []) drop(kind === 'contentSaved' ? { kind, sequenceNo: 1 } : { kind })
        if (total.length > L.replyChars) refuse(op, 'response_too_large')
      }
      if (scripted.fail) {
        if (scripted.fail === 'quota_exhausted') control.quotaUntil = now() + L.quotaCooldownMs
        refuse(op, scripted.fail)
      }
      if (scripted.empty || total.trim() === '') refuse(op, 'empty_reply')
      drop({ kind: 'completed' })
      return { sessionId: record.id, requestId, text: total, providerTurnId: `turn-${requestCounter}`, historySaved: 'pending' }
    } finally {
      record.running = false
      activeTurns -= 1
      runningCompletes -= 1
      if (sessions.delete(record.id)) stats.sessionsClosed += 1
    }
  }

  const openSession = async (request) => {
    const op = 'openSession'
    if (typeof request !== 'object' || request === null) throw invalidRequest()
    strictKeys(request, ['taskId', 'providerId', 'modelId', 'effort', 'system', 'transcript', 'resume'])
    if (typeof request.system !== 'string' || request.system.length < 1 || request.system.length > L.systemChars) throw invalidRequest()
    authorize(op)
    if ((request.providerId ?? 'codex') !== 'codex') refuse(op, 'provider_not_found')
    if (live().length >= L.sessionsPerPlugin) refuse(op, 'session_limit')
    if (control.providerState !== 'ready') refuse(op, 'provider_not_ready')
    sessionCounter += 1
    const record = { id: String(1000 + sessionCounter), index: sessionCounter, system: request.system, transcript: [], modelId: MODEL, effort: request.effort ?? null, listeners: new Set(), running: false }
    sessions.set(record.id, record)
    stats.maxLiveSessions = Math.max(stats.maxLiveSessions, sessions.size)
    stats.openSessions += 1
    const emit = (event) => { const payload = { ...event, turnId: '0123456789abcdef' }; if (record.listeners.size === 0) stats.droppedEvents.push({ sessionId: record.id, event: payload }); else for (const l of [...record.listeners]) l(payload) }
    return Object.freeze({
      sessionId: record.id,
      effective: Object.freeze({ providerId: 'codex', modelId: MODEL, effort: record.effort ?? 'medium' }),
      turn: null,
      send: async (input) => {
        authorize('send')
        checkTurnAllowed('send')
        turnTimes.push(now())
        stats.turns.push({ at: now(), kind: 'send', system: record.system, text: input.text, transcript: [], modelId: MODEL, effort: record.effort, sessionId: record.id, requestId: null })
        const scripted = await script(record, input.text, null)
        emit({ kind: 'started' })
        for (const kind of scripted.events ?? []) emit(kind === 'contentSaved' ? { kind, sequenceNo: 1 } : { kind })
        emit({ kind: 'textDelta', text: scripted.text ?? '' })
        emit({ kind: 'completed' })
        return Object.freeze({ turnId: '0123456789abcdef' })
      },
      onEvent: (listener) => { record.listeners.add(listener); return () => { record.listeners.delete(listener) } },
      interrupt: async () => undefined,
      close: async () => { if (sessions.delete(record.id)) stats.sessionsClosed += 1 }
    })
  }

  const ai = Object.freeze({
    getOptions: async () => {
      stats.getOptions += 1
      authorize('getOptions')
      return JSON.parse(JSON.stringify(providerOptions()))
    },
    complete,
    openSession
  })

  Object.assign(control, {
    set(patch) { Object.assign(control, patch) },
    /** the user turns the ai:chat permission off: later calls get not_granted; a running complete() is cancelled (`interrupted`). */
    revoke() { control.granted = false },
    grant() { control.granted = true },
    exhaustQuota(ms = L.quotaCooldownMs) { control.quotaUntil = now() + ms },
    /** turns spent by someone else in this plugin's rate-limit window: the port cannot know about them. */
    consumeTurns(n) { for (let i = 0; i < n; i += 1) turnTimes.push(now()) },
    liveSessions: () => sessions.size,
    turnsInWindow: (windowMs = 60_000) => turnTimes.filter((t) => now() - t <= windowMs).length
  })
  return { ai, control, stats }
}
