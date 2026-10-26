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

test('the copied SDK declarations match their pinned Core 1.7.15 metadata, and declare what the backend AI port uses (host.ai.complete, contentSaved)', async () => {
  const { createHash } = await import('node:crypto')
  const metadata = JSON.parse(readFileSync(new URL('../../src/plugin/sdk/tuq-plugin-sdk.version.json', import.meta.url), 'utf8'))
  const bytes = readFileSync(new URL('../../src/plugin/sdk/tuq-plugin-sdk.d.ts', import.meta.url))
  assert.equal(metadata.coreVersion, '1.7.15')
  assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.sha256)
  const text = bytes.toString('utf8')
  assert.match(text, /complete\(input: PluginBackendAiCompleteInputV1\): Promise<PluginBackendAiCompleteResultV1>/)
  assert.match(text, /kind: 'contentSaved';\s*sequenceNo: number;/)
  assert.match(text, /readonly host: PluginHostApiV1;/)
})

// ───────────── 0.2.1: every AI turn is filed under the plugin's own TeamUQ Task (src/plugin/backend/teamuqTask.ts) ─────────────
// Program and host.ai rules come from the vendored devkit test host (scripts/plugin/vendor/testing), pinned by sha256 below.

const TEST_HOST_SHA256 = '01ba78a1a51b98a9248d8d67e1784f7a8a24ebb4b3b1595896ed6a22f1aed850'
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
