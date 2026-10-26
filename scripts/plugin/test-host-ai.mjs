import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSettingsStore } from '../../src/main/config/settings.ts'
import { DEFAULT_HOST_AI_SELECTION, normalizeHostAiSelection } from '../../src/shared/hostAi.ts'

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

function fakeProgram() {
  const state = { projects: new Set(), tasks: new Map(), next: 100, calls: [], fail: null }
  const ok = (operation, result) => ({ apiVersion: 1, requestId: 'r', operation, ok: true, result })
  const failed = (operation, code) => ({ apiVersion: 1, requestId: 'r', operation, ok: false, error: { code, message: code } })
  const program = {
    call: async (operation, input) => {
      state.calls.push(operation)
      if (state.fail !== null) return failed(operation, state.fail)
      const id = String(state.next++)
      if (operation === 'data.projects.create') { state.projects.add(id); return ok(operation, { id, name: input.name }) }
      if (operation === 'data.tasks.create') {
        if (!state.projects.has(input.projectId)) return failed(operation, 'not_found')
        state.tasks.set(id, input)
        return ok(operation, { id, name: input.name, projectId: input.projectId })
      }
      return failed(operation, 'operation_not_supported')
    }
  }
  return { state, program }
}

test('the TeamUQ Task binding creates the Project「LINE 待辦」and the Task「AI 整理 LINE 訊息」once and keeps them across restarts', async () => {
  const { createTeamuqTaskBinding, TEAMUQ_PROJECT_NAME, TEAMUQ_TASK_NAME } = await import('../../src/plugin/backend/teamuqTask.ts')
  const dir = mkdtempSync(join(tmpdir(), 'line-todo-teamuq-task-'))
  try {
    const { state, program } = fakeProgram()
    const file = join(dir, 'teamuq-task.json')
    const first = createTeamuqTaskBinding({ program, file })
    const [a, b] = await Promise.all([first.resolve(), first.resolve()])
    assert.equal(a, b, 'concurrent turns share one creation')
    assert.deepEqual(state.calls, ['data.projects.create', 'data.tasks.create'])
    assert.equal([...state.tasks.values()][0].name, TEAMUQ_TASK_NAME)
    assert.equal(typeof TEAMUQ_PROJECT_NAME, 'string')
    assert.equal(await createTeamuqTaskBinding({ program, file }).resolve(), a, 'a restarted backend reuses the stored Task')
    assert.equal(state.calls.length, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a deleted Task is recreated under the same Project; a deleted Project is recreated too', async () => {
  const { createTeamuqTaskBinding } = await import('../../src/plugin/backend/teamuqTask.ts')
  const { state, program } = fakeProgram()
  const binding = createTeamuqTaskBinding({ program, file: null })
  const first = await binding.resolve()
  binding.forget('999')
  assert.equal(await binding.resolve(), first, 'forgetting another id changes nothing')
  binding.forget(first)
  const second = await binding.resolve()
  assert.notEqual(second, first)
  assert.deepEqual(state.calls, ['data.projects.create', 'data.tasks.create', 'data.tasks.create'], 'the Project is reused')
  state.projects.clear()
  binding.forget(second)
  const third = await binding.resolve()
  assert.ok(third !== null && third !== second)
  assert.deepEqual(state.calls.slice(3), ['data.tasks.create', 'data.projects.create', 'data.tasks.create'])
})

test('without the Program API or its permissions the turns go out without a taskId, and creation is retried later', async () => {
  const { createTeamuqTaskBinding } = await import('../../src/plugin/backend/teamuqTask.ts')
  assert.equal(await createTeamuqTaskBinding({ file: null }).resolve(), null, 'an older Core without context.host.program')
  const { state, program } = fakeProgram()
  let now = 0
  state.fail = 'forbidden'
  const binding = createTeamuqTaskBinding({ program, file: null, now: () => now, retryMs: 60_000 })
  assert.equal(await binding.resolve(), null)
  assert.equal(await binding.resolve(), null)
  assert.equal(state.calls.length, 1, 'no second try inside the retry window')
  state.fail = null
  now = 60_000
  assert.notEqual(await binding.resolve(), null, 'the permission was allowed later')
})

test('the AI port sends every turn (repair turns too) with the Task, and recreates a Task the user deleted', async () => {
  const { createTeamuqTaskBinding } = await import('../../src/plugin/backend/teamuqTask.ts')
  const { createHostAiPort } = await import('../../src/plugin/backend/hostAi.ts')
  const { createMockTuqAi } = await import('../lib/mock-tuq-ai.mjs')
  const { program } = fakeProgram()
  let turn = 0
  const mock = createMockTuqAi({ reply: () => (turn++ === 0 ? 'not json' : '{"ok":true}') })
  const task = createTeamuqTaskBinding({ program, file: null })
  const port = createHostAiPort({ ai: mock.ai, task })
  const json = await port.complete({ system: 'S', user: 'u', expectJson: true, priority: 'user' })
  assert.deepEqual(json.value, { ok: true })
  const taskId = await task.resolve()
  assert.deepEqual(mock.stats.turns.map((t) => t.taskId), [taskId, taskId], 'the first turn and its repair turn')
  mock.control.deletedTasks.add(taskId)
  const after = await port.complete({ system: 'S', user: 'u', expectJson: false, priority: 'user' })
  assert.equal(after.text, '{"ok":true}')
  const recreated = await task.resolve()
  assert.notEqual(recreated, taskId)
  assert.equal(mock.stats.errors.task_not_found, 1)
  assert.equal(mock.stats.turns.at(-1).taskId, recreated)
  const bare = createMockTuqAi({ reply: () => 'x' })
  await createHostAiPort({ ai: bare.ai }).complete({ system: 'S', user: 'u', expectJson: false, priority: 'user' })
  assert.equal(bare.stats.turns[0].taskId, null, 'no binding: no taskId')
})
