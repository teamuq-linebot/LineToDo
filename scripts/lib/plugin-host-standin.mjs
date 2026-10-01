// Stand-in for the TeamUQ 1.6.8 plugin host + the plugin's view, used by test-backend-contract.mjs.
//
// It is the *bootstrap file* of the backend process (the single file outside installDir that the 1.6.8 permission flags let the process
// read). Bundled by esbuild into one file, it behaves like apps/plugin-host/src/external/index.ts @ b8b96cb3:
//   1. runs runPermissionSelfCheck (verbatim copy, ./teamuq-contract.mjs) at boot;
//   2. import()s the plugin's backend entry (<installDir>/backend/index.mjs, the production bundle) and calls activate(context) with
//      the same frozen context the host builds ({pluginId, dataDir, assetPacks, allowAddons, settings:{all,get,onChange}});
//   3. serves handler.call(method, params) with the host's wire semantics (params/result are JSON, <= 64 KiB each way, 30 s limit),
//      handler.openSession(info, channel), handler.dispose().
// On top of that it plays the plugin's view: a scripted scenario that talks to the backend ONLY through backend.call('api.invoke').
// It prints observations as `RESULT:<json>`; the parent test asserts on them.
//
// argv[2] = base64url JSON ExternalHostInit, argv[3] = base64url JSON scenario config.
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { runPermissionSelfCheck } from './teamuq-contract.mjs'

const init = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'))
const cfg = JSON.parse(Buffer.from(process.argv[3], 'base64url').toString('utf8'))

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
  const settingsValues = Object.freeze({ ...(init.settings ?? {}) })
  const context = Object.freeze({
    pluginId: init.pluginId,
    dataDir: init.dataDir,
    assetPacks: Object.freeze({ ...init.assetPacks }),
    allowAddons: init.allowAddons,
    settings: Object.freeze({ all: () => settingsValues, get: (key) => settingsValues[key], onChange: () => () => undefined }),
  })
  const t0 = performance.now()
  const imported = await import(pathToFileURL(init.entry).href)
  const activate = imported.activate ?? imported.default?.activate
  if (typeof activate !== 'function') throw new Error('no activate export')
  const handler = await activate(context)
  if (!handler || typeof handler.call !== 'function') throw new Error('activate must return an object with call()')
  out.activateMs = Math.round(performance.now() - t0)
  out.handlerKeys = Object.keys(handler).sort()
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

  // ── the view side: api.invoke + chunk reassembly + job polling ──
  async function resolveEnvelope(envelope) {
    for (let guard = 0; guard < 100; guard += 1) {
      if (!envelope.ok) return envelope
      if (envelope.chunked) {
        let text = ''
        for (let i = 0; i < envelope.chunks; i += 1) {
          const part = await hostCall('api.invoke', { path: 'result.chunk', args: [{ resultId: envelope.resultId, index: i }] })
          if (!part.ok) return part
          text += part.value.data
        }
        return { ok: true, value: JSON.parse(text), viaChunks: envelope.chunks, bytes: envelope.bytes }
      }
      if (envelope.pending) {
        envelope = await hostCall('api.invoke', { path: 'job.poll', args: [{ jobId: envelope.jobId, waitMs: 1000 }] })
        continue
      }
      return envelope
    }
    throw new Error('envelope did not settle')
  }
  const invoke = async (path, ...args) => resolveEnvelope(await hostCall('api.invoke', { path, args }))
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

  // ── scenario ──
  out.info = await must('backend.info')

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
  const session = await must('events.open', {})
  const seen = []
  let after = session.seq
  async function drainEvents(waitMs = 500) {
    const pulled = await must('events.pull', { sessionId: session.sessionId, afterSeq: after, waitMs })
    for (const event of pulled.events) seen.push(event)
    after = pulled.seq
    return pulled
  }
  const capSent = []
  const capClosed = []
  const capHandler = await handler.openSession(
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
  const koffi = createRequire(join(init.installDir, 'package.json'))('koffi')
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

  // 4. supply / receive
  const system = await must('extract.system')
  const run = await must('pipeline.runOnce')
  const pulledItems = []
  for (let i = 0; i < 6 && pulledItems.length < 6; i += 1) {
    const pulled = await must('extract.pull', { max: 2 })
    if (pulled.items.length === 0) break
    pulledItems.push(...pulled.items)
  }
  const stats0 = await must('extract.stats')
  const firstMsgId = (item) => JSON.parse(item.user).newMessages[0].msgId
  const valid = pulledItems.slice(0, 3)
  const [malformed, failed] = [pulledItems[3], pulledItems[4]]
  const goodResults = valid.map((item) => ({
    itemId: item.itemId, ok: true,
    result: { importance: 'action', newTodos: [{ bucket: 'todo', title: `跟進 ${item.chatName ?? item.chatId}`, detail: null, priority: 2, dueAt: null, confidence: 0.8, sourceMsgIds: [firstMsgId(item)] }], resolved: [], updates: [] },
  }))
  const commitGood = await must('extract.commit', { results: goodResults })
  const commitBad = await must('extract.commit', { results: [{ itemId: malformed.itemId, ok: true, result: { importance: 'urgent', newTodos: [{ title: 5 }] } }] })
  const commitFail = await must('extract.commit', { results: [{ itemId: failed.itemId, ok: false, failCode: 'rate_limited', retryAfterMs: 60000 }] })
  const commitUnknown = await must('extract.commit', { results: [{ itemId: 'does-not-exist', ok: true, result: {} }] })
  await drainEvents(300)
  const todos = await must('db.todos.list')
  const processedOf = async (item) => (await must('db.messages.list', { chatId: item.chatId, limit: 5 })).map((m) => m.processed)
  step('extract', {
    systemSha: system.sha256, systemChars: system.chars, run: { chatsSeen: run.chatsSeen, chatsSkipped: run.chatsSkipped, todosCreated: run.todosCreated, llmStatus: run.llmStatus },
    pulled: pulledItems.length, itemChars: pulledItems.map((i) => i.userChars), stats0, validChatIds: valid.map((i) => i.chatId),
    commitGood: commitGood.results.map((r) => r.status), commitGoodRun: commitGood.run, commitBad: commitBad.results[0], commitFail: commitFail.results[0], commitUnknown: commitUnknown.results[0],
    todos: todos.map((t) => ({ id: t.id, chatId: t.chatId, title: t.title, status: t.status, sourceMsgIds: t.sourceMsgIds })),
    processed: { valid: await Promise.all(valid.map(processedOf)), malformed: await processedOf(malformed), failed: await processedOf(failed) },
    todosChanged: seen.filter((e) => e.type === 'todos-changed').map((e) => e.payload), statsAfter: await must('extract.stats'),
    sourceIdsOfValid: valid.map(firstMsgId),
  })
  step('eventsAfterExtract', { types: [...new Set(seen.map((e) => e.type))].sort(), pipelineRun: seen.filter((e) => e.type === 'pipeline-run').length, extractPending: seen.filter((e) => e.type === 'extract-pending').length })

  // 5. refusals
  step('refusals', {
    driver: await invoke('driver.postDraft', {}), draft: await invoke('db.todos.draftReply', 'x'), proto: await invoke('__proto__'),
    ctor: await invoke('constructor'), unknown: await invoke('db.nope.list'), badMethod: await hostCall('shell.exec', { cmd: 'whoami' }),
  })

  // 6. info + diagnostics before dispose, then dispose and prove nothing is left
  out.infoLate = await must('backend.info')
  out.diagnosticsBeforeDispose = handler.diagnostics()
  await sleep(50)
  const closingPoll = hostCall('api.invoke', { path: 'events.pull', args: [{ sessionId: session.sessionId, afterSeq: after, waitMs: 4000 }] })
  const tDispose = performance.now()
  await handler.dispose()
  out.disposeMs = Math.round(performance.now() - tDispose)
  out.closingPoll = await closingPoll
  capHandler.close?.('provider_gone')
  out.afterDispose = {
    call: await hostCall('api.invoke', { path: 'ping', args: [] }),
    diagnostics: handler.diagnostics(),
    dataDir: fs.readdirSync(init.dataDir).sort(),
    lineEngineDir: fs.existsSync(join(init.dataDir, 'line-engine')) ? fs.readdirSync(join(init.dataDir, 'line-engine')) : null,
    ownerLock: fs.existsSync(join(init.dataDir, '.line-todo-owner.lock')),
  }
  await sleep(100)
  await new Promise((resolve) => setImmediate(resolve))
  out.resourcesEnd = resourceCounts()
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
