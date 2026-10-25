import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSettingsStore } from '../../src/main/config/settings.ts'
import { createPromptService } from '../../src/plugin/backend/promptService.ts'
import { createHostAiPort } from '../../src/plugin/backend/hostAi.ts'
import { PROMPT_MAX_CHARS, promptRefinementInput, validatePromptSuggestion } from '../../src/shared/promptSettings.ts'
import { EXTRACT_OUTPUT_CONTRACT } from '../../src/plugin/backend/aiOutputContract.ts'
import { createMockTuqAi } from '../lib/mock-tuq-ai.mjs'

const noSecrets = { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unused') }, decryptString: () => { throw new Error('unused') } }
const selection = { providerId: 'codex', modelId: 'gpt-5-codex', effort: 'high' }
const unusedAi = { complete: async () => { throw new Error('unused') } }

test('initial prompt, edits, conflict prevention, restart and restore all use the persisted extraction configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'line-todo-prompt-'))
  try {
    const store = createSettingsStore({ userDataDir: dir, secrets: noSecrets })
    const service = createPromptService(store, unusedAi)
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
    const restarted = createPromptService(createSettingsStore({ userDataDir: dir, secrets: noSecrets }), unusedAi)
    assert.equal(restarted.state().activePrompt, custom)
    assert.equal(restarted.reset(saved.revision).activePrompt, initial.initialPrompt)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('AI refinement returns a reviewed suggestion with the model and never writes the active prompt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'line-todo-prompt-refine-'))
  try {
    const requests = []
    const service = createPromptService(createSettingsStore({ userDataDir: dir, secrets: noSecrets }), { complete: async (request) => {
      requests.push(request)
      const value = { prompt: '改良後的完整提示詞', changes: ['明確區分任务與行程'] }
      return { text: JSON.stringify(value), value, model: 'gpt-6-luna' }
    } })
    const initial = service.state()
    const proposed = await service.refine({ prompt: initial.activePrompt, goal: '有截止日期的任務不可當成行程' })
    assert.equal(proposed.modelId, 'gpt-6-luna')
    assert.equal(requests[0].priority, 'user', 'a button the user pressed: ahead of background extraction')
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

test('prompt refinement runs in the backend with the selected model and releases its AI Session after success', async () => {
  const mock = createMockTuqAi({ reply: () => JSON.stringify({ prompt: '新的規則', changes: ['減少噪音'] }) })
  const port = createHostAiPort({ ai: mock.ai, selection: () => selection })
  const dir = mkdtempSync(join(tmpdir(), 'line-todo-prompt-model-'))
  try {
    const service = createPromptService(createSettingsStore({ userDataDir: dir, secrets: noSecrets }), port)
    const suggestion = await service.refine({ prompt: 'old rules', goal: '減少噪音' })
    assert.equal(suggestion.prompt, '新的規則')
    assert.equal(suggestion.modelId, 'gpt-5-codex')
    assert.deepEqual({ providerId: 'codex', modelId: mock.stats.turns[0].modelId, effort: mock.stats.turns[0].effort }, selection)
    assert.equal(mock.control.liveSessions(), 0)
    assert.equal(service.state().customized, false, 'a suggestion is never applied by itself')
  } finally { port.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('prompt refinement failures keep their code and leave no Session open: a hung host call ends with turn_timeout, a stopped backend with backend_stopped, an unusable answer with prompt_suggestion_invalid', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'line-todo-prompt-fail-'))
  try {
    const store = createSettingsStore({ userDataDir: dir, secrets: noSecrets })
    // the host never answers: the port's own guard ends the wait
    const hung = createMockTuqAi({ reply: () => ({ hang: true }) })
    const hungPort = createHostAiPort({ ai: hung.ai, selection: () => selection, config: { completeGuardMs: 40 } })
    await assert.rejects(createPromptService(store, hungPort).refine({ prompt: 'old rules', goal: '改善' }), /turn_timeout/)
    hungPort.stop()
    // the backend stops while the request waits behind another one
    const slow = createMockTuqAi({ reply: () => ({ text: '{}', delay: () => new Promise((resolve) => setTimeout(resolve, 30)) }) })
    const stopPort = createHostAiPort({ ai: slow.ai, selection: () => selection })
    const first = stopPort.complete({ system: 'S', user: 'U', expectJson: false, priority: 'user' })
    const queued = createPromptService(store, stopPort).refine({ prompt: 'old rules', goal: '改善' })
    const outcome = assert.rejects(queued, /backend_stopped/)
    await new Promise((resolve) => setTimeout(resolve, 5))
    stopPort.stop()
    await outcome
    await first.catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(slow.control.liveSessions(), 0)
    // an answer that is JSON but not the agreed shape is repaired once, then reported with the prompt-specific code
    const bad = createMockTuqAi({ reply: () => JSON.stringify({ prompt: 'x', changes: [] }) })
    const badPort = createHostAiPort({ ai: bad.ai, selection: () => selection })
    await assert.rejects(createPromptService(store, badPort).refine({ prompt: 'old rules', goal: '改善' }), /prompt_suggestion_invalid/)
    assert.equal(bad.stats.completes, 2, 'one repair turn')
    assert.equal(bad.control.liveSessions(), 0)
    badPort.stop()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
