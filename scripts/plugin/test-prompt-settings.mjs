import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSettingsStore } from '../../src/main/config/settings.ts'
import { createPromptService } from '../../src/plugin/backend/promptService.ts'
import { createPromptRefiner } from '../../src/renderer/platform/promptRefiner.ts'
import { PROMPT_MAX_CHARS, promptRefinementInput, validatePromptSuggestion } from '../../src/shared/promptSettings.ts'
import { EXTRACT_OUTPUT_CONTRACT } from '../../src/plugin/backend/aiOutputContract.ts'
import { createMockTuqAi } from '../lib/mock-tuq-ai.mjs'

const noSecrets = { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unused') }, decryptString: () => { throw new Error('unused') } }
const selection = { providerId: 'codex', modelId: 'gpt-5-codex', effort: 'high' }

test('initial prompt, edits, conflict prevention, restart and restore all use the persisted extraction configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'line-todo-prompt-'))
  try {
    const store = createSettingsStore({ userDataDir: dir, secrets: noSecrets })
    const service = createPromptService(store, { request: async () => { throw new Error('unused') } })
    const initial = service.state()
    assert.equal(initial.customized, false)
    assert.equal(initial.activePrompt, initial.initialPrompt)
    const custom = `${initial.initialPrompt}\nCUSTOM_PROMPT_RULE`
    const saved = service.save(custom, initial.revision)
    assert.equal(saved.activePrompt, custom)
    assert.equal(saved.initialPrompt, initial.initialPrompt)
    assert.notEqual(saved.revision, initial.revision)
    assert.equal(saved.outputFormat, EXTRACT_OUTPUT_CONTRACT)
    assert.throws(() => service.save('stale replacement', initial.revision), /prompt_conflict/)
    assert.throws(() => service.save(' ', saved.revision), /prompt_empty/)
    assert.throws(() => service.save('x'.repeat(PROMPT_MAX_CHARS + 1), saved.revision), /prompt_too_long/)
    const restarted = createPromptService(createSettingsStore({ userDataDir: dir, secrets: noSecrets }), { request: async () => { throw new Error('unused') } })
    assert.equal(restarted.state().activePrompt, custom)
    assert.equal(restarted.reset(saved.revision).activePrompt, initial.initialPrompt)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('AI refinement returns a reviewed suggestion with the model and never writes the active prompt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'line-todo-prompt-refine-'))
  try {
    const requests = []
    const service = createPromptService(createSettingsStore({ userDataDir: dir, secrets: noSecrets }), { request: async (request) => {
      requests.push(request)
      return { text: '```json\n' + JSON.stringify({ prompt: '改良後的完整提示詞', changes: ['明確區分任务與行程'] }) + '\n```', model: 'gpt-6-luna' }
    } })
    const initial = service.state()
    const proposed = await service.refine({ prompt: initial.activePrompt, goal: '有截止日期的任務不可當成行程' })
    assert.equal(proposed.modelId, 'gpt-6-luna')
    assert.equal(requests[0].kind, 'promptRefine')
    assert.equal(requests[0].expectJson, true)
    assert.ok(requests[0].system.includes(initial.activePrompt) && requests[0].system.includes(EXTRACT_OUTPUT_CONTRACT))
    assert.equal(requests[0].user, '有截止日期的任務不可當成行程')
    assert.deepEqual(service.state(), initial)
    assert.equal(service.save(proposed.prompt, initial.revision).activePrompt, proposed.prompt)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('failed settings writes preserve the previous in-memory configuration and propagate the failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'line-todo-prompt-write-'))
  try {
    const store = createSettingsStore({ userDataDir: dir, secrets: noSecrets })
    const previous = store.get()
    mkdirSync(join(dir, 'settings.json'))
    assert.throws(() => store.update({ pluginPrompt: 'must not become active' }))
    assert.equal(store.get(), previous)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('prompt requests and suggestions reject empty, oversized and malformed output', () => {
  assert.throws(() => promptRefinementInput({ prompt: ' ', goal: 'improve' }, 'schema'), /prompt_empty/)
  assert.throws(() => promptRefinementInput({ prompt: 'rules', goal: 'x'.repeat(2001) }, 'schema'), /prompt_goal_too_long/)
  for (const output of [{ prompt: 'rules', changes: [] }, { prompt: 'rules', changes: ['change'], extra: true }, { changes: ['change'] }]) assert.throws(() => validatePromptSuggestion(output, null))
})

test('the dedicated settings view uses the selected model and releases its AI session after success', async () => {
  const mock = createMockTuqAi({ reply: () => JSON.stringify({ prompt: '新的規則', changes: ['減少噪音'] }) })
  const refiner = createPromptRefiner({ ai: mock.ai, state: async () => ({ outputFormat: 'fixed schema' }), selection: async () => selection })
  const suggestion = await refiner.refine({ prompt: 'old rules', goal: '減少噪音' })
  assert.equal(suggestion.prompt, '新的規則')
  assert.deepEqual(mock.stats.openRequests[0], selection)
  assert.equal(mock.control.liveSessions(), 0)
  refiner.dispose()
})

test('dedicated settings refinement timeout and disposal release the owned session', async () => {
  for (const mode of ['timeout', 'dispose']) {
    const mock = createMockTuqAi({ reply: () => ({ hang: true }) })
    const refiner = createPromptRefiner({ ai: mock.ai, state: async () => ({ outputFormat: 'fixed schema' }), selection: async () => selection, timeoutMs: 30 })
    const pending = refiner.refine({ prompt: 'old rules', goal: '改善' })
    const result = assert.rejects(pending, mode === 'timeout' ? /turn_timeout/ : /prompt_cancelled/)
    if (mode === 'dispose') { await new Promise((resolve) => setTimeout(resolve, 10)); refiner.dispose() }
    await result
    assert.equal(mock.control.liveSessions(), 0)
    refiner.dispose()
  }
})
