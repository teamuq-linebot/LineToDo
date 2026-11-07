// Stand-in for the TeamUQ plugin host (1.6.8 permission model; since 0.2.0 also Core 1.7.15's `context.host.ai`) + the plugin's view, used by test-backend-contract.mjs.
//
// It is the *bootstrap file* of the backend process (the single file outside installDir that the 1.6.8 permission flags let the process
// read). Bundled by esbuild into one file, it behaves like apps/plugin-host/src/external/index.ts @ b8b96cb3:
//   1. runs runPermissionSelfCheck (verbatim copy, ./teamuq-contract.mjs) at boot;
//   2. import()s the plugin's backend entry (<installDir>/backend/index.mjs, the production bundle) and calls activate with
//      the same frozen context the host builds ({pluginId, dataDir, assetPacks, allowAddons, host:{ai}, settings:{all,get,onChange}}). `host.ai` is the mock of
//      Core 1.7.15's backend ai:chat (scripts/lib/mock-tuq-ai-core.mjs, contract fixture bundled in): the backend calls `host.ai.complete` itself. The settings are
//      always EMPTY, as the host gives a plugin without settingsSchema / settings:plugin (G-06): nothing is injected through them.
//      `residency` (background:resident, Core HEAD 0e46b155a) is simulated by ./residency-standin.mjs: absent for an old Core (every scenario except 'residency', so they
//      all prove the backend behaves as before without it), or present with `cfg.residency` (initial value; scenario 'residency' drives it step by step).
//      The fake LINE folder is passed to the bundle's test entry `activateAt(context, lineLocation)` (init.lineLocation) — the one difference
//      from the host, which calls `activate(context)` and lets the backend find LINE by itself; without init.lineLocation `activate` is called;
//   3. serves handler.call(method, params) with the host's wire semantics (params/result are JSON, <= 64 KiB each way, 30 s limit),
//      handler.openSession(info, channel), handler.dispose().
// On top of that it plays the plugin's view: a scripted scenario that talks to the backend ONLY through backend.call(<method group>, { path, args })
// (the method group of each path, src/shared/pluginWire.ts — the manifest's backendMethods).
// It prints observations as `RESULT:<json>`; the parent test asserts on them.
//
// argv[2] = base64url JSON ExternalHostInit, argv[3] = base64url JSON scenario config.
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { runPermissionSelfCheck } from './teamuq-contract.mjs'
import { createMockTuqAiFor } from './mock-tuq-ai-core.mjs'
import { createResidencyStandin } from './residency-standin.mjs'
import CONTRACT from '../plugin/fixtures/ai-chat-contract-1.8.10.json'
import { backendMethodFor } from '../../src/shared/pluginWire.ts'

/** the view's wire (pluginTransport.ts): backend.call(<method group of the path>, { path, args }) */
const viewCall = (call, path, args) => call(backendMethodFor(path), { path, args })

const init = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'))
const cfg = JSON.parse(Buffer.from(process.argv[3], 'base64url').toString('utf8'))

/** Summary of the backend's invoke trace (dataDir/logs/invoke-trace.log): proves the log was written under the real permission model, without shipping the whole file. */
function summarizeInvokeTrace(file) {
  if (!fs.existsSync(file)) return null
  const TOKEN = /^[A-Za-z0-9_.:+\-?]*$/
  const keys = new Set()
  const events = {}
  const results = new Set()
  const starts = new Set()
  const ended = new Set()
  let badValues = 0
  let badLines = 0
  let last = null
  const walk = (value) => {
    if (Array.isArray(value)) { value.forEach(walk); return }
    if (value !== null && typeof value === 'object') { for (const [k, v] of Object.entries(value)) { keys.add(k); walk(v) } return }
    if (typeof value === 'string' && !TOKEN.test(value)) badValues += 1
  }
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    let record
    try { record = JSON.parse(line) } catch { badLines += 1; continue }
    walk(record)
    events[record.ev] = (events[record.ev] ?? 0) + 1
    last = record.ev
    if (record.ev === 'start') starts.add(record.seq)
    if (record.ev === 'end') { ended.add(record.seq); results.add(record.res) }
  }
  return { size: fs.statSync(file).size, keys: [...keys], events, results: [...results], last, badValues, badLines, unfinished: [...starts].filter((s) => !ended.has(s)).length }
}

const out = { runtime: { electron: process.versions.electron, node: process.version, abi: process.versions.modules }, argvFlags: process.execArgv, steps: [] }
const logs = []
for (const level of ['log', 'info', 'warn', 'error']) console[level] = (...args) => logs.push(`${level}: ${args.map(String).join(' ')}`.slice(0, 300))
const step = (name, value) => out.steps.push(name) && (out[name] = value)

const HOST_LIMITS = { bytes: 64 * 1024, timeoutMs: 30_000 }
let maxRequestBytes = 0
let maxResponseBytes = 0
let calls = 0

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const resourceCounts = () => {
  const counts = {}
  for (const name of process.getActiveResourcesInfo()) counts[name] = (counts[name] ?? 0) + 1
  return counts
}

try {
  out.selfCheckBoot = runPermissionSelfCheck(init)
  const baseline = resourceCounts()
  out.resourcesBaseline = baseline

  // ── activate exactly like the host ──
  // the host's context for a plugin without settingsSchema / settings:plugin: the settings are empty (backendRuntime.ts effectiveBackendSettings)
  const settingsValues = Object.freeze({})
  const settingsReads = []
  // Core 1.7.15's context.host.ai (backend side of ai:chat). The "model": the first 3 chats it is asked about get a todo, the 4th an answer that can never pass the schema
  // (also not after the one repair turn), the 5th a provider failure, every other chat a "noise" answer; a draft prompt gets a draft.
  const chatsAsked = []
  const aiHost = createMockTuqAiFor(CONTRACT, {
    reply: (ctx) => {
      if (ctx.system.includes('草擬')) return '好的，我今天處理。'
      const payload = JSON.parse(ctx.repair ? ctx.transcript[0].text : ctx.user) // a repair turn replays the first question as transcript[0]
      const chatId = payload.chat.chatId
      if (!chatsAsked.includes(chatId)) chatsAsked.push(chatId)
      const rank = chatsAsked.indexOf(chatId)
      const first = payload.newMessages[0]
      if (rank < 3) {
        const draftRef=`contract_${String(first.msgId).replace(/[^a-z0-9_-]/giu,'_')}`
        return JSON.stringify({ importance: 'action', newTodos: [{ draftRef,bucket: 'todo', title: `跟進 ${payload.chat.name ?? chatId}`, detail: null, priority: 2, dueAt: null, confidence: 0.8, sourceMsgIds: [first.msgId] }], identityDecisions:[{draftRef,outcome:'new',candidateType:null,candidateId:null,relationKind:null,reasonCode:'insufficient_evidence',confidenceBand:'high',evidenceMsgIds:[first.msgId]}], resolved: [], updates: [] })
      }
      if (rank === 3) return JSON.stringify({ importance: 'urgent', newTodos: [{ title: 5 }] })
      if (rank === 4) return { fail: 'provider_error' }
      return JSON.stringify({ importance: 'noise', newTodos: [], identityDecisions:[], resolved: [], updates: [] })
    }
  })
  // an old Core has no context.residency; cfg.residency makes it a Core that has the feature (scenario 'residency' below)
  const residencyStandin = createResidencyStandin({ mode: cfg.residency ? 'present' : 'absent', initial: cfg.residency?.initial })
  const context = Object.freeze({
    ...residencyStandin.contextPart(),
    pluginId: init.pluginId,
    dataDir: init.dataDir,
    assetPacks: Object.freeze({ ...init.assetPacks }),
    allowAddons: init.allowAddons,
    host: Object.freeze({ ai: aiHost.ai }),
    settings: Object.freeze({ all: () => { settingsReads.push('*'); return settingsValues }, get: (key) => { settingsReads.push(String(key)); return settingsValues[key] }, onChange: () => () => undefined }),
  })
  const t0 = performance.now()
  const imported = await import(pathToFileURL(init.entry).href)
  const activate = imported.activate ?? imported.default?.activate
  if (typeof activate !== 'function') throw new Error('no activate export')
  out.entryExports = Object.keys(imported).sort()
  let handler
  if (init.lineLocation) {
    if (typeof imported.activateAt !== 'function') throw new Error('no activateAt export (the test entry for a fake LINE folder)')
    out.activatedWith = 'activateAt'
    handler = await imported.activateAt(context, init.lineLocation)
  } else {
    out.activatedWith = 'activate'
    handler = await activate(context)
  }
  out.settingsReadsDuringActivate = [...settingsReads]
  if (!handler || typeof handler.call !== 'function') throw new Error('activate must return an object with call()')
  out.activateMs = Math.round(performance.now() - t0)
  out.handlerKeys = Object.keys(handler).sort()
  // review F2: activate() must return before the first key extraction / import begin (the host sends boot-ack right after it); the watcher is up but has not polled yet
  out.lineStatusRightAfterActivate = (await viewCall((m, p) => handler.call(m, p), 'line.status', []))?.value?.state ?? null
  out.selfCheckAfterActivate = runPermissionSelfCheck(init)

  // ── the host's call wire (JSON in/out, size + time limits) ──
  async function hostCall(method, params) {
    const request = JSON.stringify({ method, params })
    const requestBytes = Buffer.byteLength(request)
    maxRequestBytes = Math.max(maxRequestBytes, requestBytes)
    if (requestBytes > HOST_LIMITS.bytes) throw Object.assign(new Error('request too large'), { code: 'backend_invoke_too_large' })
    calls += 1
    let timer
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'backend_invoke_timeout' })), HOST_LIMITS.timeoutMs) })
    try {
      const value = await Promise.race([Promise.resolve().then(() => handler.call(method, JSON.parse(request).params)), timeout])
      const serialized = JSON.stringify(value ?? null)
      const bytes = Buffer.byteLength(serialized)
      maxResponseBytes = Math.max(maxResponseBytes, bytes)
      if (bytes > HOST_LIMITS.bytes) throw Object.assign(new Error('result too large'), { code: 'plugin_backend_result_too_large' })
      return JSON.parse(serialized)
    } finally {
      clearTimeout(timer)
    }
  }

  // ── the view side: method groups + chunk reassembly + job polling ──
  async function resolveEnvelope(envelope) {
    for (let guard = 0; guard < 100; guard += 1) {
      if (!envelope.ok) return envelope
      if (envelope.chunked) {
        let text = ''
        for (let i = 0; i < envelope.chunks; i += 1) {
          const part = await viewCall(hostCall, 'result.chunk', [{ resultId: envelope.resultId, index: i }])
          if (!part.ok) return part
          text += part.value.data
        }
        return { ok: true, value: JSON.parse(text), viaChunks: envelope.chunks, bytes: envelope.bytes }
      }
      if (envelope.pending) {
        envelope = await viewCall(hostCall, 'job.poll', [{ jobId: envelope.jobId, waitMs: 1000 }])
        continue
      }
      return envelope
    }
    throw new Error('envelope did not settle')
  }
  const invoke = async (path, ...args) => resolveEnvelope(await viewCall(hostCall, path, args))
  const must = async (path, ...args) => {
    const r = await invoke(path, ...args)
    if (!r.ok) throw new Error(`${path} failed: ${JSON.stringify(r)}`)
    return r.value
  }
  async function waitFor(label, probe, timeoutMs = cfg.waitMs ?? 90_000) {
    const start = Date.now()
    for (;;) {
      const value = await probe()
      if (value) return { value, waitedMs: Date.now() - start }
      if (Date.now() - start > timeoutMs) {
        const info = await must('backend.info').catch((e) => String(e))
        throw new Error(`timeout waiting for ${label}: ${JSON.stringify({ line: info.line, recentLog: info.recentLog, count: await must('db.messages.count').catch(() => null) })}`)
      }
      await sleep(250)
    }
  }

  // ── media scenario (cfg.mode === 'media'): the Phase 3 media path under the real permission model ──
  // The LINE Cache lives OUTSIDE dataDir, so Node fs cannot see it; only the backend's koffi fs port can. The view asks `media.prepare`, the backend
  // writes the plaintext into dataDir/media-cache, and the host's `/data/<path>` file service (pluginDataFiles.ts rules, re-implemented here) serves it.
  const DATA_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
  function serveData(relative) {
    // pluginDataFiles.ts segmentsOf() + entryNames.ts auditEntryName()
    if (relative === '' || relative.endsWith('/') || /[\\:<>"|?*\u0000-\u001f]/.test(relative) || relative.startsWith('/') || relative.length > 200) return { status: 403, code: 'storage_path_invalid' }
    const segments = relative.split('/')
    if (segments.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.') || s.length > 100 || s.endsWith('.') || s.endsWith(' '))) return { status: 403, code: 'storage_path_invalid' }
    const absolute = join(init.dataDir, ...segments)
    let stat
    try { stat = fs.lstatSync(absolute) } catch { return { status: 404, code: 'storage_not_found' } }
    if (stat.isSymbolicLink() || !stat.isFile()) return { status: 403, code: 'storage_path_escapes' }
    const bytes = fs.readFileSync(absolute)
    const ext = absolute.slice(absolute.lastIndexOf('.')).toLowerCase()
    return { status: 200, type: DATA_MIME[ext] ?? 'application/octet-stream', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }
  async function mediaScenario() {
    // media.prepare only queries the local image index: wait until the backend's background scan of the (fake) LINE Cache has finished
    await waitFor('media index ready', async () => { const index = (await must('backend.info')).media?.index; return index && index.ready && !index.scanning ? true : 0 })
    const base = await waitFor('media base import', async () => ((await must('db.messages.count')) >= cfg.expected.messageCount ? await must('db.messages.count') : 0))
    const denied = (() => { try { fs.readdirSync(cfg.cacheDir); return null } catch (error) { return error.code ?? String(error) } })()
    const results = {}
    for (const [name, entry] of Object.entries(cfg.expected.messages)) {
      const first = await invoke('media.prepare', entry.msgId)
      const second = first.ok ? await invoke('media.prepare', { msgId: entry.msgId }) : null
      results[name] = {
        kind: entry.kind, first, second,
        served: first.ok ? serveData(first.value.path) : null,
        servedUrl: first.ok ? `tuqplugin://${init.pluginId}/data/${first.value.path.split('/').map(encodeURIComponent).join('/')}` : null,
      }
    }
    step('media', {
      importedCount: base.value, nodeFsOnLineCache: denied, results,
      cacheDirListing: fs.existsSync(join(init.dataDir, 'media-cache')) ? fs.readdirSync(join(init.dataDir, 'media-cache')).sort() : null,
      info: (await must('backend.info')).media,
      unsupported: { open: await invoke('media.open', 'x'), saveAs: await invoke('media.saveAs', 'x') },
      traversal: ['../line-todo.db', '.linekey', 'media-cache/../line-todo.db', 'media-cache/.hidden.png', 'media-cache/', 'a\\b.png', 'C:/x.png', 'media-cache/i:m1.png'].map((p) => ({ path: p, ...serveData(p) })),
    })
  }

  // ── reconcile scenario (cfg.mode === 'reconcile'): the boot self-reconcile under the real permission model, real WASM engine, real koffi fs ──
  async function reconcileScenario() {
    // the run is complete when its log line says so and the single-flight lock is gone
    const finished = await waitFor('reconcile finished', async () => (logs.some((l) => /\[reconcile\] (?:checkpoint advanced|checkpoint NOT advanced|no gaps|source unavailable|DB unhealthy)/.test(l)) && !fs.existsSync(join(init.dataDir, '.reconcile_lock')) ? true : 0))
    // progress events are best effort here: the first import emits one line-message event per row (904 > the 512-event ring), so the early
    // reconcile-progress events may already have rolled out (the ring reports gap:true; the unit test asserts the exact phase sequence)
    const probe = await must('events.open', { sinceSeq: 0 })
    const phases = []
    const pulled = await must('events.pull', { sessionId: probe.sessionId, afterSeq: 0, waitMs: 0 })
    for (const event of pulled.events) if (event.type === 'reconcile-progress') phases.push(event.payload)
    const done = finished
    const finalCount = await waitFor('full import', async () => ((await must('db.messages.count')) >= cfg.expected.baseCount ? await must('db.messages.count') : 0))
    const all = await must('db.messages.list', { limit: 5000 })
    step('reconcile', {
      phases, ringGap: pulled.gap, waitedMs: done.waitedMs, finalCount: finalCount.value, listed: all.length, distinctMsgIds: new Set(all.map((m) => m.msgId)).size,
      dataDir: fs.readdirSync(init.dataDir).sort(), lockPresent: fs.existsSync(join(init.dataDir, '.reconcile_lock')),
      state: fs.existsSync(join(init.dataDir, 'reconcile-state.json')) ? JSON.parse(fs.readFileSync(join(init.dataDir, 'reconcile-state.json'), 'utf8')) : null,
      log: logs.filter((l) => /\[reconcile\]/.test(l)), status: await must('line.status'),
    })
    await must('events.close', { sessionId: probe.sessionId })
  }

  // ── residency scenario (cfg.mode === 'residency'): Core's context.residency, driven step by step through apply() (Core's ext-residency) and push() (a later Core's new reason code) ──
  // Every step is observed the way the board does: the `residency` event on the long poll, and the `backend.residency` / `backend.info` answers. `hostCalls` counts what the
  // backend asked of the host (context.host.ai: complete / getOptions / sessions) and of context.residency.current(): after a downgrade nothing may grow, since Core only restarts its
  // idle timer and a backend must not keep itself alive by calling the host.
  async function residencyScenario() {
    const hostCalls = () => ({ aiCompletes: aiHost.stats.completes, aiOptions: aiHost.stats.getOptions, aiSessions: aiHost.stats.openSessions, residencyCurrent: residencyStandin.stats.currentCalls })
    const events = await must('events.open', {})
    let after = events.seq
    const collect = async (waitMs) => {
      const pulled = await must('events.pull', { sessionId: events.sessionId, afterSeq: after, waitMs })
      after = pulled.seq
      return pulled.events.filter((e) => e.type === 'residency').map((e) => e.payload)
    }
    const initial = await must('backend.residency')
    const results = []
    for (const stepSpec of cfg.residency.steps) {
      const changed = stepSpec.push !== undefined ? residencyStandin.push(stepSpec.push) : residencyStandin.apply(stepSpec.apply)
      const eventPayloads = await collect(stepSpec.waitMs ?? 700)
      results.push({ label: stepSpec.label, changed, events: eventPayloads, answer: await must('backend.residency'), info: (await must('backend.info')).residency, hostCalls: hostCalls() })
    }
    const beforeQuiet = hostCalls()
    const resourcesBeforeQuiet = resourceCounts()
    await sleep(cfg.residency.quietMs ?? 1500)
    const lateEvents = await collect(0)
    step('residency', {
      initial, results, quiet: { ms: cfg.residency.quietMs ?? 1500, before: beforeQuiet, after: hostCalls(), events: lateEvents, resourcesBefore: resourcesBeforeQuiet, resourcesAfter: resourceCounts() },
      standin: { ...residencyStandin.stats, listeners: residencyStandin.listeners() }, ai: await must('ai.status'),
    })
    await must('events.close', { sessionId: events.sessionId })
  }

  // ── scenario ──
  out.info = await must('backend.info')
  let session = null
  let after = 0
  let capHandler = null

  if (cfg.mode === 'media') {
    await mediaScenario()
  } else if (cfg.mode === 'reconcile') {
    await reconcileScenario()
  } else if (cfg.mode === 'residency') {
    await residencyScenario()
  } else {
  // 1. fake LINE (fixture DB outside dataDir, read through koffi copy + WASM) -> app DB
  const base = await waitFor('base import', async () => ((await must('db.messages.count')) >= cfg.expected.baseCount ? await must('db.messages.count') : 0))
  step('baseImport', { count: base.value, waitedMs: base.waitedMs, status: await must('line.status'), pipelineStatus: await must('pipeline.status') })
  const chats = await invoke('db.chats.list')
  const page = await invoke('db.messages.list', { limit: 60 })
  const everything = await invoke('db.messages.list', { limit: 5000 })
  step('reads', {
    chats: { ok: chats.ok, count: chats.value?.length, viaChunks: chats.viaChunks ?? 0, sample: chats.value?.[0] },
    messagesPage: { ok: page.ok, count: page.value?.length, first: page.value?.[0] },
    messagesAll: { ok: everything.ok, count: everything.value?.length, viaChunks: everything.viaChunks ?? 0, bytes: everything.bytes ?? null },
    todos: await must('db.todos.list'),
    ping: await must('ping'),
  })

  // 2. event session (long poll) + capability session, opened before new data arrives
  session = await must('events.open', {})
  const seen = []
  after = session.seq
  async function drainEvents(waitMs = 500) {
    const pulled = await must('events.pull', { sessionId: session.sessionId, afterSeq: after, waitMs })
    for (const event of pulled.events) seen.push(event)
    after = pulled.seq
    return pulled
  }
  const capSent = []
  const capClosed = []
  capHandler = await handler.openSession(
    { sessionId: 'cap-1', capability: 'linetodo.events', callerPluginId: init.pluginId, options: { sinceSeq: session.seq } },
    {
      send: (message) => {
        if (JSON.stringify(message).length > 16 * 1024) throw Object.assign(new Error('session message too large'), { code: 'message_too_large' })
        capSent.push(message)
      },
      close: (reason) => capClosed.push(reason),
    },
  )

  // 3. LINE writes: the -wal / -shm of the fixture appear next to the main file (like a live LINE DB growing)
  // ("LINE writes its WAL": the harness is outside the sandbox of the plugin's Node fs, so it uses koffi CopyFileW like the plugin does)
  // (test stage: the staged node_modules/koffi package; the SIGNED PACKAGE has no node_modules, only backend/native/win32-x64/koffi.node, which the backend's own shim loads too)
  const packagedKoffi = join(init.installDir, 'backend', 'native', 'win32-x64', 'koffi.node')
  const koffi = fs.existsSync(packagedKoffi) ? createRequire(import.meta.url)(packagedKoffi) : createRequire(join(init.installDir, 'package.json'))('koffi')
  const CopyFileW = koffi.load('kernel32.dll').func('bool __stdcall CopyFileW(str16 lpExistingFileName, str16 lpNewFileName, bool bFailIfExists)')
  for (const ext of ['-wal', '-shm']) if (!CopyFileW(join(cfg.walSourceDir, 'm.edb' + ext), join(cfg.linedir, 'qw0f0f.edb' + ext), false)) throw new Error('CopyFileW failed for ' + ext)
  const grown = await waitFor('wal import', async () => { await drainEvents(300); const n = await must('db.messages.count'); return n >= cfg.expected.fullCount ? n : 0 })
  await drainEvents(300)
  const byType = {}
  for (const event of seen) byType[event.type] = (byType[event.type] ?? 0) + 1
  step('newMessages', {
    count: grown.value, waitedMs: grown.waitedMs, byType,
    seqs: { first: seen[0]?.seq, last: seen.at(-1)?.seq, strictlyIncreasing: seen.every((e, i) => i === 0 || e.seq > seen[i - 1].seq) },
    firstLineMessage: seen.find((e) => e.type === 'line-message')?.payload ?? null,
    persisted: seen.filter((e) => e.type === 'messages-persisted').map((e) => e.payload).slice(0, 3),
  })
  await sleep(150)
  const capEvents = capSent.filter((m) => m.type === 'events').flatMap((m) => m.events)
  step('capabilitySession', { messages: capSent.length, events: capEvents.length, types: [...new Set(capEvents.map((e) => e.type))].sort(), maxMessageBytes: Math.max(0, ...capSent.map((m) => JSON.stringify(m).length)) })

  // 4. AI in the backend (0.2.0): supply -> ExtractWorker -> context.host.ai.complete -> receive. Nothing is pulled or committed over the view wire.
  const run = await must('pipeline.runOnce')
  const settled = await waitFor('the worker to settle every offered chat', async () => {
    const st = await must('extract.stats')
    const ai = await must('ai.status')
    // 3 todos + 2 failed chats backing off; everything else answered with "noise"
    return st.leased === 0 && st.chatsBackingOff === 2 && st.pending >= 2 && ai.counters.failed === 2 && ai.counters.extracted >= 4 && !ai.busy ? { st, ai } : 0
  })
  await sleep(300)
  await drainEvents(300)
  const aiStatusAfter = await must('ai.status')
  const todos = await must('db.todos.list')
  const processedOf = async (chatId) => (await must('db.messages.list', { chatId, limit: 5 })).map((m) => m.processed)
  const [validChatIds, malformedChatId, failedChatId] = [chatsAsked.slice(0, 3), chatsAsked[3], chatsAsked[4]]
  step('extract', {
    run: { chatsSeen: run.chatsSeen, chatsSkipped: run.chatsSkipped, todosCreated: run.todosCreated, llmStatus: run.llmStatus },
    hostTurns: aiHost.stats.turns.length, hostCompletes: aiHost.stats.completes, userChars: aiHost.stats.turns.map((t) => t.text.length), systemChars: aiHost.stats.turns.map((t) => t.system.length),
    liveSessions: aiHost.control.liveSessions(), openedSessions: aiHost.stats.openSessions, closedSessions: aiHost.stats.sessionsClosed, maxLiveSessions: aiHost.stats.maxLiveSessions,
    hostErrors: Object.fromEntries(Object.entries(aiHost.stats.errors).filter(([, n]) => n > 0)),
    repairTurns: aiHost.stats.turns.filter((t) => t.transcript.length > 0).length,
    settledStats: settled.value.st, aiStatus: { state: aiStatusAfter.state, reason: aiStatusAfter.reason, resumeAt: aiStatusAfter.resumeAt, counters: aiStatusAfter.counters, provider: aiStatusAfter.provider, queue: aiStatusAfter.queue },
    validChatIds, malformedChatId, failedChatId,
    todos: todos.map((t) => ({ id: t.id, chatId: t.chatId, title: t.title, status: t.status, sourceMsgIds: t.sourceMsgIds })),
    processed: { valid: await Promise.all(validChatIds.map(processedOf)), malformed: await processedOf(malformedChatId), failed: await processedOf(failedChatId) },
    todosChanged: seen.filter((e) => e.type === 'todos-changed').map((e) => e.payload), statsAfter: await must('extract.stats'),
    removedPaths: { pull: await invoke('extract.pull', {}), commit: await invoke('extract.commit', { results: [] }), system: await invoke('extract.system') },
  })
  step('eventsAfterExtract', { types: [...new Set(seen.map((e) => e.type))].sort(), pipelineRun: seen.filter((e) => e.type === 'pipeline-run').length, extractPending: seen.filter((e) => e.type === 'extract-pending').length, aiStatus: seen.filter((e) => e.type === 'ai-status').length })

  // 4b. The user actions are ordinary backend calls (0.2.0): core's draftReply -> AI port provider -> context.host.ai.complete. No relay, no ai.pull / ai.commit / ai.run.
  const draftTodo = todos[0]
  const turnsBeforeDraft = aiHost.stats.turns.length
  const draftResult = await invoke('db.todos.draftReply', draftTodo.id)
  const draftTurn = aiHost.stats.turns[turnsBeforeDraft]
  const relayGone = {}
  for (const path of ['ai.run', 'ai.pull', 'ai.commit', 'ai.release']) { const r = await invoke(path, { kind: 'draftReply', args: [draftTodo.id] }); relayGone[path] = { ok: r.ok, code: r.code } }
  const aiOptions = await invoke('ai.options')
  step('aiDirect', {
    draft: { kind: 'draftReply', draftPrompt: draftTurn?.system.includes('草擬') === true, userChars: draftTurn?.text.length ?? 0, userMentionsTodo: draftTurn?.text.includes(draftTodo.title) === true, modelId: draftTurn?.modelId ?? null },
    result: draftResult, relayGone,
    options: { ok: aiOptions.ok, providers: aiOptions.value?.providers?.map((p) => ({ id: p.id, state: p.state })), turnsPerMinute: aiOptions.value?.limits?.turnsPerMinute },
    status: (await must('ai.status')).state, hostLive: aiHost.control.liveSessions(), info: (await must('backend.info')).ai?.counters ?? null,
  })

  // 4c. review tracking (Phase 4 repair): the status route and backend.info.review exist in the production bundle; an empty window review (no messages that recent) completes at once
  const reviewIdle = await must('review.status')
  const reviewEmpty = await invoke('pipeline.reviewLastDays', 1)
  const reviewAfter = await must('review.status')
  step('reviewStatus', { idle: { state: reviewIdle.state, running: reviewIdle.running, resumable: reviewIdle.resumableMessages }, empty: { ok: reviewEmpty.ok, resultOk: reviewEmpty.value?.ok, chatsSeen: reviewEmpty.value?.chatsSeen }, after: { state: reviewAfter.state, running: reviewAfter.running }, info: (await must('backend.info')).review?.state })

  // 5. refusals
  step('refusals', {
    // G-07: 'driver' is not a method group (Core's allowlist never lets it through; the backend refuses it too); a path sent under another group is refused
    driver: await hostCall('driver', { path: 'driver.postDraft', args: [{}] }), openOriginal: await invoke('db.chats.openOriginal', 'x'),
    proto: await hostCall('db.todos', { path: '__proto__', args: [] }), ctor: await hostCall('ping', { path: 'constructor', args: [] }),
    unknown: await hostCall('db.todos', { path: 'db.nope.list', args: [] }), badMethod: await hostCall('shell.exec', { cmd: 'whoami' }),
    mismatch: await hostCall('db.todos', { path: 'settings.update', args: [{}] }), legacyMethod: await hostCall('api.invoke', { path: 'ping', args: [] }),
  })

  } // end of the main (non-media) scenario

  // 6. info + diagnostics before dispose, then dispose and prove nothing is left
  out.infoLate = await must('backend.info')
  out.diagnosticsBeforeDispose = handler.diagnostics()
  await sleep(50)
  const closingPoll = session ? viewCall(hostCall, 'events.pull', [{ sessionId: session.sessionId, afterSeq: after, waitMs: 4000 }]) : Promise.resolve(null)
  const tDispose = performance.now()
  await handler.dispose()
  out.disposeMs = Math.round(performance.now() - tDispose)
  out.closingPoll = await closingPoll
  capHandler?.close?.('provider_gone')
  out.afterDispose = {
    call: await viewCall(hostCall, 'ping', []),
    diagnostics: handler.diagnostics(),
    dataDir: fs.readdirSync(init.dataDir).sort(),
    lineEngineDir: fs.existsSync(join(init.dataDir, 'line-engine')) ? fs.readdirSync(join(init.dataDir, 'line-engine')) : null,
    ownerLock: fs.existsSync(join(init.dataDir, '.line-todo-owner.lock')),
    invokeTrace: summarizeInvokeTrace(join(init.dataDir, 'logs', 'invoke-trace.log')),
    residencyListeners: residencyStandin.listeners(),
    residencyStats: { ...residencyStandin.stats },
  }
  await sleep(100)
  await new Promise((resolve) => setImmediate(resolve))
  out.resourcesEnd = resourceCounts()
  out.settingsReadsTotal = [...settingsReads]
  out.selfCheckEnd = runPermissionSelfCheck(init)
  out.wire = { calls, maxRequestBytes, maxResponseBytes, limit: HOST_LIMITS.bytes }
} catch (error) {
  out.fatal = String(error?.stack ?? error).slice(0, 3000)
}
out.logs = logs.slice(-60)
process.stdout.write('RESULT:' + JSON.stringify(out) + '\n')
// A well-behaved backend leaves nothing that keeps the process alive; if something does (leaked timer / watcher / socket), force the
// exit with a distinct code so the parent test fails fast instead of waiting for its timeout.
setTimeout(() => process.exit(3), 1500).unref()
