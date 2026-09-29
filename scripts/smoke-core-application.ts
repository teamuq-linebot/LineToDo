import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLineTodoRuntime } from '../src/core/runtime'
import { createLineTodoApplication } from '../src/core/application'
import { createSettingsStore } from '../src/main/config/settings'
import { createPipelineConfig } from '../src/main/config/defaults'
import { createQwenConfig } from '../src/main/config/qwen'
import { createProviderRegistry } from '../src/main/llm/provider'
import { createRepositories } from '../src/main/db/repositories'
import { PipelineScheduler } from '../src/main/pipeline/scheduler'

async function main(): Promise<void> {
const root = mkdtempSync(join(tmpdir(), 'line-todo-core-smoke-'))
const settings = createSettingsStore({
  userDataDir: root,
  secrets: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v), decryptString: (v) => v.toString() }
})
const pipelineConfig = createPipelineConfig(() => settings.get())
const qwen = createQwenConfig({ readApiKey: () => settings.readApiKey(), readBaseUrl: () => settings.get().aiBaseUrl })
const providers = createProviderRegistry({ getSettings: settings.get, getQwenConfig: qwen, userDataDir: root })
const message = {
  msgId: 'fixture-message-001', chat: 'Fixture chat', chatId: 'u-fixture', isGroup: false,
  ts: Date.now(), time: new Date().toISOString(), direction: 'in' as const,
  sender: 'Fixture peer', text: 'Please send the fixture report tomorrow', contentType: 0
}
let listeners: Array<(value: typeof message) => void> = []
let lineState: 'stopped' | 'running' = 'stopped'
let emitted = false
const line = {
  start() { lineState = 'running'; if (!emitted) { emitted = true; listeners.forEach((cb) => cb(message)) } },
  stop() { lineState = 'stopped' },
  status: () => ({ state: lineState, lastMessageAt: null, messageCount: emitted ? 1 : 0, lastError: null, restarts: 0 }),
  onMessage(cb: (value: typeof message) => void) { listeners.push(cb); return () => { listeners = listeners.filter((item) => item !== cb) } },
  onStatus() { return () => undefined }
}

try {
  const runtime = await createLineTodoRuntime({
    dataDir: root,
    initialize: async () => createLineTodoApplication({
      dataDir: root, dbPath: join(root, 'line-todo.db'), settings, pipelineConfig, providers, line,
      schedulerFactory: (db, repos) => new PipelineScheduler({
        db, getDefaults: pipelineConfig, getLastRun: () => repos.pipeline.getLastRun(),
        isProviderConfigured: () => true,
        makeExtract: () => async (input) => ({
          importance: 'action',
          newTodos: [{ bucket: 'todo', title: 'Send fixture report', detail: null, priority: 1, confidence: 0.95, sourceMsgIds: input.newMessages.map((item) => item.msgId) }],
          resolved: [], updates: []
        })
      }),
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
  await runtime.stop()
  await runtime.start()
  await runtime.dispose()
  await runtime.dispose()
  assert.equal((await import('node:fs')).existsSync(join(root, '.line-todo-owner.lock')), false)
  console.log('core application smoke: PASS (Node assembly, injected fake line/extractor, message-to-todo API, restart/dispose)')
} finally { try { rmSync(root, { recursive: true, force: true }) } catch (error) { console.warn('core smoke fixture cleanup pending:', (error as Error).message) } }
}

export const smoke = main()
