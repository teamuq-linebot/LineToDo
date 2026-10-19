import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLineTodoRuntime } from '../src/core/runtime'
import { createLineTodoApplication } from '../src/core/application'
import { createSettingsStore } from '../src/main/config/settings'
import { createPipelineConfig } from '../src/main/config/defaults'
import { createQwenConfig } from '../src/main/config/qwen'
import { createRepositories } from '../src/main/db/repositories'
import { PipelineScheduler } from '../src/main/pipeline/scheduler'
import type { RawLineMessage } from '../src/main/line/types'

async function main(): Promise<void> {
const root = mkdtempSync(join(tmpdir(), 'line-todo-core-smoke-'))
const settings = createSettingsStore({
  userDataDir: root,
  secrets: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v), decryptString: (v) => v.toString() }
})
const getDefaults = createPipelineConfig(() => settings.get())
const qwenConfig = createQwenConfig({ readApiKey: () => settings.readApiKey(), readBaseUrl: () => settings.get().aiBaseUrl })
let defaultsReads = 0
const applicationPipelineConfig = { getDefaults() { defaultsReads += 1; return getDefaults() }, getQwenConfig: qwenConfig, isProviderConfigured: () => true }
let providerResolutions = 0
const providers = { resolveProvider() { providerResolutions += 1; return {} as never } }
const message = {
  msgId: 'fixture-message-001', chat: 'Fixture chat', chatId: 'u-fixture', isGroup: false,
  ts: Date.now(), time: new Date().toISOString(), direction: 'in' as const,
  sender: 'Fixture peer', text: 'Please send the fixture report tomorrow', contentType: 0
}
let listeners: Array<(value: typeof message) => void> = []
let lineState: 'stopped' | 'running' = 'stopped'
let emitted = false
let windowMessages: RawLineMessage[] = []
let windowReads = 0
let extractAvailable = true
let backgroundMode: 'off' | 'queued' | 'running' | 'pipeline-queued' = 'off'
let backgroundStarted = 0
let backgroundCompleted = 0
let backgroundWrites = 0
let backgroundSignal: AbortSignal | null = null
let releaseBackground: () => void = () => undefined
let backgroundGate = new Promise<void>((resolve) => { releaseBackground = resolve })
let pipelineStopPromise: Promise<void> | null = null
let runtime!: Awaited<ReturnType<typeof createLineTodoRuntime>>
let runtimeDb: import('better-sqlite3').Database | null = null
const reviewMessage: RawLineMessage = { ...message, msgId: 'fixture-review-001', chat: 'Review fixture', chatId: 'u-review-fixture', text: 'Please review the fixture order tomorrow' }
const line = {
  start() { lineState = 'running'; if (!emitted) { emitted = true; listeners.forEach((cb) => cb(message)) } },
  stop() { lineState = 'stopped' },
  status: () => ({ state: lineState, lastMessageAt: null, messageCount: emitted ? 1 : 0, lastError: null, restarts: 0 }),
  getMessagesSince: async (_sinceMs: number, _opts: { limit: number }) => { windowReads += 1; return windowMessages.slice() },
  onMessage(cb: (value: typeof message) => void) { listeners.push(cb); return () => { listeners = listeners.filter((item) => item !== cb) } },
  onStatus() { return () => undefined }
}

try {
  runtime = await createLineTodoRuntime({
    dataDir: root,
    initialize: async () => createLineTodoApplication({
      dataDir: root, dbPath: join(root, 'line-todo.db'), settings, pipelineConfig: applicationPipelineConfig, providers, line,
      onDatabase: (db) => { runtimeDb = db },
      makeExtract: () => {
        if (!extractAvailable) return null
        const provider = providers.resolveProvider()
        if (!provider) return null
        return async (input) => ({
          importance: 'action',
          newTodos: [{ bucket: 'todo', title: `Manual review ${input.chat.chatId}`, detail: 'Injected provider fixture', priority: 1, confidence: 0.95, sourceMsgIds: input.newMessages.map((item) => item.msgId) }],
          resolved: [], updates: []
        })
      },
      schedulerFactory: (db, repos) => new PipelineScheduler({
        db, getDefaults, getLastRun: () => repos.pipeline.getLastRun(),
        isProviderConfigured: () => true,
        makeExtract: () => async (input) => ({
          importance: 'action',
          newTodos: [{ bucket: 'todo', title: 'Send fixture report', detail: null, priority: 1, confidence: 0.95, sourceMsgIds: input.newMessages.map((item) => item.msgId) }],
          resolved: [], updates: []
        })
      }),
      afterStart: (db, schedule) => {
        if (backgroundMode === 'queued') schedule(() => { backgroundStarted += 1 })
        if (backgroundMode === 'running') schedule(async (signal) => {
          backgroundStarted += 1
          backgroundSignal = signal
          await backgroundGate
          if (!signal.aborted) {
            createRepositories(db).chats.upsert({ chatId: 'late-background-write', name: 'Late write', isGroup: false, seenAt: new Date().toISOString() })
            backgroundWrites += 1
          }
          backgroundCompleted += 1
        })
      },
      afterPipelineRun: (_result, _db, schedule) => {
        if (backgroundMode !== 'pipeline-queued') return
        schedule(() => { backgroundStarted += 1 })
        queueMicrotask(() => { pipelineStopPromise = runtime.stop() })
      },
      media: { open: async () => ({ ok: false }), saveAs: async () => ({ ok: false }) },
      app: { ping: () => ({ ok: true, ts: Date.now(), version: 'fixture' }), openDataFolder: async () => ({ ok: true }), openOriginal: async () => ({ ok: true }) }
    })
  })
  await runtime.start()
  assert.equal((await runtime.api.db.messages.count('u-fixture')), 1)
  console.log('core smoke: fixture message persisted')
  const result = await runtime.api.pipeline.runOnce()
  console.log('core smoke: runOnce result', result.todosCreated)
  assert.equal(result.todosCreated, 1)
  const todos = await runtime.api.db.todos.list({ chatId: 'u-fixture' })
  assert.equal(todos[0]?.title, 'Send fixture report')
  windowMessages = [reviewMessage]
  const reviewResult = await runtime.api.pipeline.reviewLastDays(1)
  assert.equal(reviewResult.newMsgs, 1)
  assert.equal(reviewResult.todosCreated, 1)
  assert.equal((await runtime.api.db.todos.list({ chatId: 'u-review-fixture' }))[0]?.title, 'Manual review u-review-fixture')
  assert.equal(defaultsReads, 1, 'manual review must read this application instance config')
  assert.equal(providerResolutions, 1, 'manual review must use this application instance provider registry')
  const mediaWindowMessage: RawLineMessage = { ...message, keyMaterial: Buffer.alloc(32, 7).toString('base64'), fileSize: 4 }
  windowMessages = [mediaWindowMessage]
  const mediaResult = await runtime.api.pipeline.backfillMediaKeys(1)
  assert.equal(mediaResult.ok, true)
  assert.equal(mediaResult.scanned, 1)
  assert.equal(mediaResult.mediaBackfilled, 1, 'media backfill must merge keys from the injected LINE source')
  const sourceCallsBeforeEmpty = windowReads
  windowMessages = []
  const emptyMediaResult = await runtime.api.pipeline.backfillMediaKeys(1)
  assert.equal(emptyMediaResult.ok, true)
  assert.equal(emptyMediaResult.scanned, 0)
  assert.equal(windowReads, sourceCallsBeforeEmpty + 1, 'empty media windows must still use the injected LINE source')
  extractAvailable = false
  const nullExtractorResult = await runtime.api.pipeline.reviewLastDays(1)
  assert.equal(nullExtractorResult.hasApiKey, false, 'an explicit null extractor must retain the unconfigured result')
  assert.equal(defaultsReads, 2, 'manual review must retain instance config even when extraction is unavailable')
  assert.equal(providerResolutions, 1, 'an explicit null extractor must not fall back to the global provider')
  await runtime.stop()
  backgroundMode = 'queued'
  await runtime.start()
  await runtime.stop()
  assert.equal(backgroundStarted, 0, 'stop must cancel a queued startup job before callback execution')
  backgroundMode = 'pipeline-queued'
  await runtime.start()
  await runtime.api.pipeline.runOnce()
  assert.ok(pipelineStopPromise, 'pipeline callback must initiate the fixture stop')
  await pipelineStopPromise
  assert.equal(backgroundStarted, 0, 'stop must cancel a queued post-pipeline job before callback execution')
  backgroundMode = 'running'
  backgroundGate = new Promise<void>((resolve) => { releaseBackground = resolve })
  await runtime.start()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(backgroundStarted, 1, 'startup background job must begin in the fixture')
  assert.ok(backgroundSignal)
  let disposeDone = false
  const disposing = runtime.dispose().then(() => { disposeDone = true })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(backgroundSignal.aborted, true, 'dispose must cancel an in-flight background job')
  assert.equal(disposeDone, false, 'dispose must await the in-flight background job before closing the database')
  assert.equal(runtimeDb?.open, true, 'database must remain open while an accepted background job is draining')
  releaseBackground()
  await disposing
  assert.equal(backgroundCompleted, 1)
  assert.equal(backgroundWrites, 0, 'aborted background job must not write after disposal begins')
  assert.equal(runtimeDb?.open, false, 'database must close after the background job settles')
  await runtime.dispose()
  assert.equal((await import('node:fs')).existsSync(join(root, '.line-todo-owner.lock')), false)
  console.log('core application smoke: PASS (manual review/media backfill DI, null extractor, queued/running background shutdown, restart/dispose)')
} finally { try { rmSync(root, { recursive: true, force: true }) } catch (error) { console.warn('core smoke fixture cleanup pending:', (error as Error).message) } }
}

export const smoke = main()
