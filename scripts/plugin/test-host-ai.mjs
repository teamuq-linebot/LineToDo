import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSettingsStore } from '../../src/main/config/settings.ts'
import { DEFAULT_HOST_AI_SELECTION, normalizeHostAiSelection } from '../../src/shared/hostAi.ts'
import { buildManifest } from './lib/manifest.mjs'
import { createTestHost } from './vendor/testing/tuq-plugin-test-host.mjs'

const noSecrets = { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unused') }, decryptString: () => { throw new Error('unused') } }

test('AI selection survives unrelated settings updates and a settings-store restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'line-todo-ai-settings-'))
  try {
    const first = createSettingsStore({ userDataDir: dir, secrets: noSecrets })
    const selection = { providerId: 'codex', modelId: 'gpt-6-luna', effort: 'high' }
    first.update({ pluginAi: selection })
    first.update({ pollIntervalSec: 45 })
    const second = createSettingsStore({ userDataDir: dir, secrets: noSecrets })
    assert.deepEqual(second.get().pluginAi, selection)
    assert.equal(second.get().pollIntervalSec, 45)
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).pluginAi, selection)
    second.update({ pluginAi: DEFAULT_HOST_AI_SELECTION })
    assert.deepEqual(second.get().pluginAi, DEFAULT_HOST_AI_SELECTION)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('legacy settings use TeamUQ defaults; malformed selection is bounded and contains only model preferences', () => {
  assert.deepEqual(normalizeHostAiSelection(undefined), DEFAULT_HOST_AI_SELECTION)
  assert.deepEqual(normalizeHostAiSelection({ providerId: '../../other', modelId: 'x'.repeat(97), effort: 'unlimited', apiKey: 'not-persisted' }), DEFAULT_HOST_AI_SELECTION)
  assert.deepEqual(normalizeHostAiSelection({ providerId: 'codex', modelId: ' gpt-6-luna ', effort: 'low', apiKey: 'not-persisted' }), { providerId: 'codex', modelId: 'gpt-6-luna', effort: 'low' })
})

test('the vendor pathname patch preserves relative, absolute, Unicode, percent-encoded and Windows pathnames', () => {
  for (const input of ['db.sqlite', '../db.sqlite', '/data/test.sqlite', '資料/LINE 空白.sqlite', 'data/a%20b.sqlite', 'file:///C:/LINE/db.sqlite', 'file://server/share/db.sqlite', 'C:/LINE/db.sqlite']) {
    assert.equal(new URL(input, 'file:///').pathname, new URL(input, 'file://localhost/').pathname, input)
  }
})

test('the copied SDK declarations match their pinned Core 1.8.10 metadata, and declare what the backend AI port uses (host.ai.complete, contentSaved)', async () => {
  const { createHash } = await import('node:crypto')
  const metadata = JSON.parse(readFileSync(new URL('../../src/plugin/sdk/tuq-plugin-sdk.version.json', import.meta.url), 'utf8'))
  const bytes = readFileSync(new URL('../../src/plugin/sdk/tuq-plugin-sdk.d.ts', import.meta.url))
  assert.equal(metadata.coreVersion, '1.8.10')
  assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.sha256)
  const text = bytes.toString('utf8')
  assert.match(text, /complete\(input: PluginBackendAiCompleteInputV1\): Promise<PluginBackendAiCompleteResultV1>/)
  assert.match(text, /kind: 'contentSaved';\s*sequenceNo: number;/)
  assert.match(text, /readonly host: PluginHostApiV1;/)
})

// ───────────── 0.2.1: every AI turn is filed under the plugin's own TeamUQ Task (src/plugin/backend/teamuqTask.ts) ─────────────
// Program and host.ai rules come from the vendored devkit test host (scripts/plugin/vendor/testing), pinned by sha256 below.

const TEST_HOST_SHA256 = 'ba24f3410e0c6bfb90c1304338341253fdb5236066082f58a536ba22f5fcce72'
const PLUGIN_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version

const newHost = () => createTestHost({ manifest: buildManifest({ version: PLUGIN_VERSION }) })
const aiTaskIds = (host) => host.calls('backend:ai.complete').map((call) => call.args.taskId ?? null)
const taskRevision = (host, taskId) => host.calls('program.call:data.tasks.create').map((call) => call.reply.value?.result).find((task) => task?.id === taskId).authoredRevision
const deleteTask = async (host, taskId) => {
  const reply = await host.backend.host.program.call('data.tasks.delete', { taskId, expectedAuthoredRevision: taskRevision(host, taskId) })
  assert.equal(reply.ok, true, JSON.stringify(reply))
}

test('the vendored devkit test host is the pinned artifact and matches the kit version.json', () => {
  const bytes = readFileSync(new URL('./vendor/testing/tuq-plugin-test-host.mjs', import.meta.url))
  const meta = JSON.parse(readFileSync(new URL('./vendor/testing/tuq-plugin-test-host.version.json', import.meta.url), 'utf8'))
  const kit = JSON.parse(readFileSync(new URL('./vendor/kit.version.json', import.meta.url), 'utf8'))
  assert.equal(kit.coreVersion, '1.8.10')
  assert.equal(meta.coreVersion, kit.coreVersion)
  assert.equal(kit.files.find((entry) => entry.path === 'testing/tuq-plugin-test-host.mjs').sha256, meta.sha256)
  assert.equal(meta.file, 'tuq-plugin-test-host.mjs')
  assert.equal(createHash('sha256').update(bytes).digest('hex'), TEST_HOST_SHA256)
  assert.equal(meta.sha256, TEST_HOST_SHA256)
})

test('the TeamUQ Task binding creates the Project and the Task once and keeps them across restarts', async () => {
  const { createTeamuqTaskBinding, TEAMUQ_PROJECT_NAME, TEAMUQ_TASK_NAME } = await import('../../src/plugin/backend/teamuqTask.ts')
  const dir = mkdtempSync(join(tmpdir(), 'line-todo-teamuq-task-'))
  const host = newHost()
  try {
    const { program } = host.backend.host
    const file = join(dir, 'teamuq-task.json')
    const first = createTeamuqTaskBinding({ program, file })
    const [a, b] = await Promise.all([first.resolve(), first.resolve()])
    assert.ok(a !== null)
    assert.equal(a, b, 'concurrent turns share one creation')
    assert.deepEqual(host.calls().map((call) => call.id), ['program.call:data.projects.create', 'program.call:data.tasks.create'])
    const [projectCall, taskCall] = host.calls()
    assert.equal(projectCall.args.input.name, TEAMUQ_PROJECT_NAME)
    assert.equal(projectCall.args.input.name, 'LINE 待辦 Pro', 'pro creates its own TeamUQ project, separate from the free edition')
    assert.equal(taskCall.args.input.name, TEAMUQ_TASK_NAME)
    assert.equal(taskCall.args.input.projectId, projectCall.reply.value.result.id)
    assert.equal(await createTeamuqTaskBinding({ program, file }).resolve(), a, 'a restarted backend reuses the stored Task')
    assert.equal(host.calls().length, 2)
  } finally {
    host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a Task deleted in the host is recreated under the same Project; forgetting another id changes nothing', async () => {
  const { createTeamuqTaskBinding } = await import('../../src/plugin/backend/teamuqTask.ts')
  const host = newHost()
  try {
    const { program } = host.backend.host
    const binding = createTeamuqTaskBinding({ program, file: null })
    const first = await binding.resolve()
    binding.forget('999')
    assert.equal(await binding.resolve(), first, 'forgetting another id changes nothing')
    await deleteTask(host, first)
    binding.forget(first)
    const second = await binding.resolve()
    assert.notEqual(second, first)
    assert.deepEqual(host.calls().map((call) => call.id), ['program.call:data.projects.create', 'program.call:data.tasks.create', 'program.call:data.tasks.delete', 'program.call:data.tasks.create'], 'the Project is reused')
    assert.equal(host.calls().at(-1).args.input.projectId, host.calls()[0].reply.value.result.id)
  } finally { host.close() }
})

test('a deleted Project is recreated too (the devkit host does not model Core not_found yet, so only this branch uses a stub)', async () => {
  const { createTeamuqTaskBinding } = await import('../../src/plugin/backend/teamuqTask.ts')
  const dir = mkdtempSync(join(tmpdir(), 'line-todo-teamuq-project-'))
  try {
    const file = join(dir, 'teamuq-task.json')
    writeFileSync(file, JSON.stringify({ projectId: '101', taskId: null }))
    const operations = []
    const program = {
      call: async (operation, input) => {
        operations.push(operation)
        if (operation === 'data.tasks.create' && input.projectId === '101') return { apiVersion: 1, requestId: 'r', operation, ok: false, error: { code: 'not_found', message: 'not_found' } }
        return { apiVersion: 1, requestId: 'r', operation, ok: true, result: { id: operation === 'data.projects.create' ? '102' : '200' } }
      }
    }
    assert.equal(await createTeamuqTaskBinding({ program, file }).resolve(), '200')
    assert.deepEqual(operations, ['data.tasks.create', 'data.projects.create', 'data.tasks.create'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('without the Program API or its permissions the turns go out without a taskId, and creation is retried later', async () => {
  const { createTeamuqTaskBinding } = await import('../../src/plugin/backend/teamuqTask.ts')
  assert.equal(await createTeamuqTaskBinding({ file: null }).resolve(), null, 'an older Core without context.host.program')
  const host = newHost()
  try {
    const { program } = host.backend.host
    let now = 0
    await host.revoke('program:data:tasks:write')
    const binding = createTeamuqTaskBinding({ program, file: null, now: () => now, retryMs: 60_000 })
    assert.equal(await binding.resolve(), null)
    assert.equal(await binding.resolve(), null)
    assert.deepEqual(host.calls().map((call) => call.id), ['program.call:data.projects.create', 'program.call:data.tasks.create'], 'no second try inside the retry window')
    assert.equal(host.calls()[1].reply.value.error.code, 'forbidden')
    await host.grant('program:data:tasks:write')
    now = 60_000
    assert.notEqual(await binding.resolve(), null, 'the permission was allowed later')
    assert.equal(host.calls().at(-1).id, 'program.call:data.tasks.create')
  } finally { host.close() }
})

test('the AI port sends every turn (repair turns too) with the Task, and recreates a Task the user deleted', async () => {
  const { createTeamuqTaskBinding } = await import('../../src/plugin/backend/teamuqTask.ts')
  const { createHostAiPort } = await import('../../src/plugin/backend/hostAi.ts')
  const host = newHost()
  try {
    host.ai.next({ events: [{ textDelta: 'not json' }, 'completed'] })
    host.ai.next({ events: [{ textDelta: '{"ok":true}' }, 'completed'] })
    const task = createTeamuqTaskBinding({ program: host.backend.host.program, file: null })
    const port = createHostAiPort({ ai: host.backend.host.ai, task })
    const json = await port.complete({ system: 'S', user: 'u', expectJson: true, priority: 'user' })
    assert.deepEqual(json.value, { ok: true })
    const taskId = await task.resolve()
    assert.deepEqual(aiTaskIds(host), [taskId, taskId], 'the first turn and its repair turn')
    await deleteTask(host, taskId)
    host.ai.next({ events: [{ textDelta: '{"ok":true}' }, 'completed'] })
    const after = await port.complete({ system: 'S', user: 'u', expectJson: false, priority: 'user' })
    assert.equal(after.text, '{"ok":true}')
    const recreated = await task.resolve()
    assert.notEqual(recreated, taskId)
    assert.ok(host.calls('backend:ai.complete').some((call) => call.reply.ok === false && call.reply.error === 'task_not_found'))
    assert.deepEqual(aiTaskIds(host).slice(2), [taskId, recreated], 'the turn that hit task_not_found, then the retry on the new Task')
    const bare = newHost()
    try {
      bare.ai.next({ events: [{ textDelta: 'x' }, 'completed'] })
      await createHostAiPort({ ai: bare.backend.host.ai }).complete({ system: 'S', user: 'u', expectJson: false, priority: 'user' })
      assert.deepEqual(aiTaskIds(bare), [null], 'no binding: no taskId')
    } finally { bare.close() }
  } finally { host.close() }
})

test('host repair turn, callback and fixed error code never expose synthetic credential canaries', async () => {
  const { createHostAiPort } = await import('../../src/plugin/backend/hostAi.ts')
  const { AiPortError } = await import('../../src/core/aiPort.ts')
  const host = newHost()
  try {
    host.ai.next({ events: [{ textDelta: 'password=synthetic-provider-error-canary is not json' }, 'completed'] })
    host.ai.next({ events: [{ textDelta: 'password=synthetic-provider-error-canary is still not json' }, 'completed'] })
    const callbacks = []
    const port = createHostAiPort({ ai: host.backend.host.ai })
    const error = await port.complete({
      system: 'API-key=synthetic-host-system-canary. Output JSON.',
      user: JSON.stringify({ text: 'password=synthetic-host-user-canary; Project Orion' }),
      expectJson: true,
      priority: 'user',
      onAdditionalUserPayload: (payload) => { callbacks.push(payload); return true }
    }).then(() => null, (failure) => failure)
    assert.ok(error instanceof AiPortError)
    assert.ok(['invalid_json', 'invalid_result'].includes(error.code))
    assert.equal(error.message.includes('synthetic-provider-error-canary'), false)
    const calls = host.calls('backend:ai.complete').map((call) => JSON.stringify(call.args))
    const sent = JSON.stringify(calls)
    assert.equal(sent.includes('synthetic-host-system-canary'), false)
    assert.equal(sent.includes('synthetic-host-user-canary'), false)
    assert.equal(callbacks.length, 1, 'one repair request is reported through the callback')
    assert.equal(callbacks[0].includes('synthetic-host-user-canary'), false)
    assert.equal(callbacks[0].includes('synthetic-provider-error-canary'), false)
    assert.match(callbacks[0], /\[REDACTED:CREDENTIAL\]/)
  } finally { host.close() }
})

// ───────────── per-chat system (A13): a changed system for one chat sends one new rule document to the SAME Host session ─────────────

function sessionAwareHost(options = {}) {
  const completes = []
  const sessions = new Map()
  const operations = []
  let nextId = 0
  const active = () => [...sessions.values()].filter((session) => session.active).length
  const failure = (code) => Object.assign(new Error(code), { code })
  const sessionFor = (row) => {
    const listeners = new Set()
    const publish = (event) => { for (const listener of [...listeners]) listener(event) }
    return {
      sessionId: row.id,
      effective: row.effective,
      turn: null,
      async send({ text }) {
        if (!row.active) throw failure('session_closed')
        const turnId = (++row.turns).toString(16).padStart(16, '0')
        const output = JSON.stringify({ importance: 'noise', newTodos: [], identityDecisions: [], resolved: [], updates: [] })
        row.sends.push(text)
        if (row.lastTurnId !== null) {
          publish({ turnId: row.lastTurnId, kind: 'textDelta', text: row.lastOutput })
          publish({ turnId: row.lastTurnId, kind: 'completed' })
        }
        publish({ turnId, kind: 'textDelta', text: output })
        publish({ turnId, kind: 'completed' })
        row.lastTurnId = turnId
        row.lastOutput = output
        return { turnId }
      },
      onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) },
      async interrupt() { return undefined },
      async close() { row.active = false }
    }
  }
  const api = {
    async getOptions() {
      return {
        providers: [{ id: 'codex', label: 'Mock Codex', state: 'ready', models: [{ id: 'model-a', label: 'Model A', efforts: ['low', 'medium'], defaultEffort: 'medium', supportsImages: false, isDefault: true }] }],
        defaultProviderId: 'codex',
        limits: { systemChars: 16_000, transcriptLines: 40, transcriptChars: 60_000, inputChars: 8_000, imageBytes: 2 * 1024 * 1024, turnsPerMinute: 20 },
        quota: { state: 'ok', retryAfterMs: null },
        ...(options.closedSessionResume === false ? {} : { capabilities: { closedSessionResume: true } })
      }
    },
    async complete(input) {
      if (options.closedSessionResume !== false) throw new Error('the extraction path must use sessions')
      completes.push(structuredClone(input))
      return { sessionId: '900', requestId: `plugin:900:complete-${completes.length}`, providerTurnId: null, text: JSON.stringify({ importance: 'noise', newTodos: [], identityDecisions: [], resolved: [], updates: [] }), historySaved: 'saved' }
    },
    async openSession(input) {
      if ('resume' in input) {
        operations.push({ op: 'resume', id: input.resume })
        const existing = sessions.get(input.resume)
        if (existing === undefined) throw failure('session_not_found')
        if (existing.active || active() > 0) throw failure('session_limit')
        existing.active = true
        return sessionFor(existing)
      }
      if (active() > 0) throw failure('session_limit')
      const id = String(++nextId)
      const row = { id, effective: { providerId: 'codex', modelId: 'model-a', effort: 'medium' }, system: input.system, active: true, turns: 0, sends: [], lastTurnId: null, lastOutput: null }
      sessions.set(id, row)
      operations.push({ op: 'fresh', id, system: input.system })
      return sessionFor(row)
    }
  }
  return { api, sessions, operations, completes }
}

test('A13 a changed effective system of a chat sends ONE new rule document to the SAME Host session; no chat gets a new session', async () => {
  const { createChatPromptStore } = await import('../../src/plugin/backend/chatPromptStore.ts')
  const { createPromptService } = await import('../../src/plugin/backend/promptService.ts')
  const { createHostAiPort } = await import('../../src/plugin/backend/hostAi.ts')
  const { CHAT_SESSION_SYSTEM_V1 } = await import('../../src/plugin/backend/chatSessionProtocol.ts')
  const { openDatabase } = await import('../../src/main/db/database.ts')
  const dir = mkdtempSync(join(tmpdir(), 'line-todo-host-ai-chat-prompt-'))
  const opened = openDatabase({ dbPath: ':memory:' })
  for (const chatId of ['u-alice', 'u-bob']) opened.db.prepare('INSERT INTO chats(chat_id, name, is_group, blocked, first_seen_at, last_seen_at) VALUES (?, ?, 0, 0, ?, ?)').run(chatId, chatId, '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z')
  const records = new Map()
  const sessionMapStore = {
    async get(scopeKey) { return structuredClone(records.get(scopeKey) ?? null) },
    async put(record) { records.set(record.scopeKey, structuredClone(record)) },
    async remove(scopeKey) { records.delete(scopeKey) }
  }
  const host = sessionAwareHost()
  const prompts = createPromptService(createSettingsStore({ userDataDir: dir, secrets: noSecrets }), { complete: async () => { throw new Error('unused') } }, { chatStore: createChatPromptStore({ getDatabase: () => opened.db }) })
  const port = createHostAiPort({ ai: host.api, selection: () => ({ providerId: 'codex', modelId: 'model-a', effort: 'medium' }), sessionMapStore })
  const extract = (chatId) => port.complete({ system: prompts.extractSystem(chatId), user: JSON.stringify({ chatId, newMessages: [] }), expectJson: true, validate: (value) => ({ ok: true, value }), priority: 'background', conversationScope: { kind: 'line-chat', chatId, taskKind: 'extract' } })
  const history = () => host.operations.map(({ op, id }) => `${op}:${id}`)
  const ruleDocs = (id) => host.sessions.get(id).sends.filter((text) => text.startsWith('【規則文件 extract r'))
  const tasks = (id) => host.sessions.get(id).sends.filter((text) => text.startsWith('【任務 extract r'))
  try {
    await extract('u-alice')
    const aliceRulesBefore = ruleDocs('1').length
    assert.ok(aliceRulesBefore >= 1, 'the first use of a session sends the rule document')
    await extract('u-bob')
    await extract('u-alice')
    assert.deepEqual(history(), ['fresh:1', 'fresh:2', 'resume:1'], 'same system: the chat\'s session is resumed')
    const bobSession = records.get('chat:u-bob').hostSessionId
    assert.equal(ruleDocs('1').length, aliceRulesBefore, 'resuming with an unchanged system does not resend the rule document')
    assert.equal(host.sessions.get('1').system, CHAT_SESSION_SYSTEM_V1, 'the session system is frozen and purpose independent')

    prompts.chatSave('u-alice', { prompt: null, myName: '阿華' }, prompts.chatState('u-alice').revision)
    await extract('u-alice')
    assert.equal(history().filter((entry) => entry.startsWith('fresh')).length, 2, 'a new name for alice does NOT open a new Host session')
    assert.equal(host.operations.filter((entry) => entry.op === 'resume').at(-1).id, '1', 'alice\'s same session is resumed')
    assert.equal(records.get('chat:u-alice').hostSessionId, '1')
    assert.equal(ruleDocs('1').length, aliceRulesBefore * 2, 'one new rule document (same number of segments) was sent')
    assert.ok(ruleDocs('1').some((text) => text.includes('"阿華"')), 'and it carries alice\'s new own system')
    assert.equal(tasks('1').length, 3)
    await extract('u-bob')
    assert.equal(host.operations.filter((entry) => entry.op === 'resume').at(-1).id, bobSession)
    assert.equal(records.get('chat:u-bob').hostSessionId, bobSession)
    assert.equal(ruleDocs('2').length, aliceRulesBefore, 'bob: only the first use sent the rule document')
    assert.equal(tasks('2').length, 2)
  } finally { port.stop(); opened.db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('A11 a Core without closedSessionResume falls back to the one-shot complete (no crash, no session map access) and records a diagnostic', async () => {
  const { createHostAiPort } = await import('../../src/plugin/backend/hostAi.ts')
  const host = sessionAwareHost({ closedSessionResume: false })
  const events = []
  let mapTouched = 0
  const touch = async () => { mapTouched += 1; return null }
  const port = createHostAiPort({ ai: host.api, selection: () => ({ providerId: 'codex', modelId: 'model-a', effort: 'medium' }), sessionMapStore: { get: touch, put: touch, remove: touch }, log: (event) => events.push(event) })
  try {
    const result = await port.complete({ system: 'RULES', user: '{}', expectJson: true, validate: (value) => ({ ok: true, value }), priority: 'user', dynamicContract: 'CONTRACT', conversationScope: { kind: 'line-chat', chatId: 'u-alice', taskKind: 'draftReply' } })
    assert.equal(result.value.importance, 'noise')
    assert.equal(host.completes.length, 1)
    assert.equal(host.completes[0].system, 'RULES\n\nCONTRACT')
    assert.deepEqual(host.operations, [])
    assert.equal(mapTouched, 0)
    assert.ok(events.includes('no_resume_capability'))
  } finally { port.stop() }
})
