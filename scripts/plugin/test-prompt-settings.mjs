import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSettingsStore } from '../../src/main/config/settings.ts'
import { createPromptService, identitySection } from '../../src/plugin/backend/promptService.ts'
import { createHostAiPort } from '../../src/plugin/backend/hostAi.ts'
import { EXTRACT_SYSTEM_PROMPT } from '../../src/main/llm/extractPrompt.ts'
import { openDatabase } from '../../src/main/db/database.ts'
import { SCHEMA_VERSION } from '../../src/main/db/schema.ts'
import { createChatPromptStore } from '../../src/plugin/backend/chatPromptStore.ts'
import { MY_NAME_MAX_CHARS, PROMPT_MAX_CHARS, normalizeMyName, promptRefinementInput, validateMyName, validatePromptSuggestion } from '../../src/shared/promptSettings.ts'
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

// ───────────── per-chat overrides and the default "my name" (design §3–§7) ─────────────

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

function chatFixture(chats = ['u-alice', 'u-bob', 'u-carol']) {
  const dir = mkdtempSync(join(tmpdir(), 'line-todo-chat-prompt-svc-'))
  const opened = openDatabase({ dbPath: ':memory:' })
  for (const chatId of chats) opened.db.prepare('INSERT INTO chats(chat_id, name, is_group, blocked, first_seen_at, last_seen_at) VALUES (?, ?, 0, 0, ?, ?)').run(chatId, chatId, '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z')
  const settings = createSettingsStore({ userDataDir: dir, secrets: noSecrets })
  const service = createPromptService(settings, unusedAi, { chatStore: createChatPromptStore({ getDatabase: () => opened.db }) })
  return { dir, db: opened.db, settings, service, cleanup: () => { opened.db.close(); rmSync(dir, { recursive: true, force: true }) } }
}
const rev = (service, chatId) => service.chatState(chatId).revision

test('A1/A2 with no override and no name the system is byte-identical to the previous release and the session hash does not change', () => {
  const f = chatFixture()
  try {
    const legacy = `${EXTRACT_SYSTEM_PROMPT}\n\n${EXTRACT_OUTPUT_CONTRACT}`
    assert.equal(f.service.extractSystem(), legacy)
    assert.equal(f.service.extractSystem('u-alice'), legacy)
    assert.equal(f.service.systemSha256('u-alice'), sha256(EXTRACT_SYSTEM_PROMPT))
    assert.equal(f.service.systemSha256('u-alice'), f.service.revision(), 'upgrade does not reset existing sessions')
    f.service.save(`${EXTRACT_SYSTEM_PROMPT}\nCUSTOM`, f.service.revision())
    assert.equal(f.service.extractSystem('u-bob'), `${EXTRACT_SYSTEM_PROMPT}\nCUSTOM\n\n${EXTRACT_OUTPUT_CONTRACT}`)
    assert.equal(f.service.systemSha256('u-bob'), f.service.revision())
  } finally { f.cleanup() }
})

test('A3 a default name is appended between the prompt and the output contract, which stays last', () => {
  const f = chatFixture()
  try {
    f.service.saveName('王小明', f.service.state().nameRevision)
    const system = f.service.extractSystem('u-alice')
    const promptAt = system.indexOf(EXTRACT_SYSTEM_PROMPT)
    const identityAt = system.indexOf('【使用者在這個對話的身分（由程式加入）】')
    const contractAt = system.indexOf(EXTRACT_OUTPUT_CONTRACT)
    assert.equal(promptAt, 0)
    assert.ok(promptAt < identityAt && identityAt < contractAt)
    assert.ok(system.endsWith(EXTRACT_OUTPUT_CONTRACT))
    assert.ok(system.includes(JSON.stringify('王小明')))
    assert.equal(system, `${EXTRACT_SYSTEM_PROMPT}\n\n${system.slice(identityAt, contractAt)}${EXTRACT_OUTPUT_CONTRACT}`)
    assert.equal(f.service.systemSha256('u-alice'), sha256(system.slice(0, contractAt - 2)), 'the hash covers the prompt and the identity section, not the fixed contract')
    assert.notEqual(f.service.systemSha256('u-alice'), f.service.revision())
    assert.equal(f.service.state().myName, '王小明')
    f.service.saveName('', f.service.state().nameRevision)
    assert.equal(f.service.extractSystem('u-alice'), `${EXTRACT_SYSTEM_PROMPT}\n\n${EXTRACT_OUTPUT_CONTRACT}`, 'clearing the name restores the legacy bytes')
  } finally { f.cleanup() }
})

test('A4 a chat name overrides the default for that chat only', () => {
  const f = chatFixture()
  try {
    f.service.saveName('預設名', f.service.state().nameRevision)
    f.service.chatSave('u-alice', { prompt: null, myName: '阿華' }, rev(f.service, 'u-alice'))
    assert.ok(f.service.extractSystem('u-alice').includes(JSON.stringify('阿華')))
    assert.ok(!f.service.extractSystem('u-alice').includes(JSON.stringify('預設名')))
    assert.ok(f.service.extractSystem('u-bob').includes(JSON.stringify('預設名')))
    const state = f.service.chatState('u-alice')
    assert.deepEqual([state.nameSource, state.effectiveName, state.defaultName], ['chat', '阿華', '預設名'])
    assert.deepEqual([f.service.chatState('u-bob').nameSource, f.service.chatState('u-bob').effectiveName], ['default', '預設名'])
  } finally { f.cleanup() }
})

test('A5 a chat prompt replaces the default completely; changing the default moves un-overridden chats only', () => {
  const f = chatFixture()
  try {
    f.service.chatSave('u-alice', { prompt: 'ALICE ONLY', myName: null }, rev(f.service, 'u-alice'))
    assert.equal(f.service.extractSystem('u-alice'), `ALICE ONLY\n\n${EXTRACT_OUTPUT_CONTRACT}`)
    assert.equal(f.service.systemSha256('u-alice'), sha256('ALICE ONLY'))
    f.service.save('NEW DEFAULT', f.service.revision())
    assert.equal(f.service.extractSystem('u-alice'), `ALICE ONLY\n\n${EXTRACT_OUTPUT_CONTRACT}`, 'overridden chat unchanged')
    assert.equal(f.service.extractSystem('u-bob'), `NEW DEFAULT\n\n${EXTRACT_OUTPUT_CONTRACT}`, 'other chat follows the new default')
    assert.equal(f.service.chatState('u-alice').promptSource, 'chat')
    assert.equal(f.service.chatState('u-bob').promptSource, 'default')
    assert.equal(f.service.chatState('u-bob').effectivePrompt, 'NEW DEFAULT')
  } finally { f.cleanup() }
})

test('A6 a prompt or name equal to the current default is stored as null, so the chat keeps following the default', () => {
  const f = chatFixture()
  try {
    f.service.saveName('同名', f.service.state().nameRevision)
    const saved = f.service.chatSave('u-alice', { prompt: EXTRACT_SYSTEM_PROMPT, myName: '同名' }, rev(f.service, 'u-alice'))
    assert.equal(saved.overridePrompt, null)
    assert.equal(saved.overrideName, null)
    assert.deepEqual(f.service.chatList(), [], 'no empty override row')
    f.service.save('CHANGED DEFAULT', f.service.revision())
    assert.equal(f.service.extractSystem('u-alice'), `CHANGED DEFAULT\n\n${identityBlock('同名')}\n\n${EXTRACT_OUTPUT_CONTRACT}`)
  } finally { f.cleanup() }
})

function identityBlock(name) {
  return [
    '【使用者在這個對話的身分（由程式加入）】',
    `- 在這個聊天室裡，「我」(me) 被稱為 ${JSON.stringify(name)}。訊息中對 ${JSON.stringify(name)}（含 @${name}、暱稱或相近寫法）的請託、指派與點名，視為對我說的。`,
    '- 這只用來判斷事項是否指派給我；不改變 direction 的定義、輸出欄位或 JSON Schema。'
  ].join('\n')
}

test('A7 a stale expected revision is refused by saveName, chatSave and chatReset; a second save with the same revision fails', () => {
  const f = chatFixture()
  try {
    const name0 = f.service.state().nameRevision
    f.service.saveName('一號', name0)
    assert.throws(() => f.service.saveName('二號', name0), /prompt_conflict/)
    assert.equal(f.service.state().myName, '一號')
    assert.throws(() => f.service.saveName('二號', undefined), /prompt_conflict/)

    const r0 = rev(f.service, 'u-alice')
    const first = f.service.chatSave('u-alice', { prompt: 'P1', myName: null }, r0)
    assert.notEqual(first.revision, r0)
    assert.throws(() => f.service.chatSave('u-alice', { prompt: 'P2', myName: null }, r0), /prompt_conflict/)
    assert.equal(f.service.chatState('u-alice').overridePrompt, 'P1')
    assert.throws(() => f.service.chatReset('u-alice', r0), /prompt_conflict/)
    assert.equal(f.service.chatState('u-alice').overridePrompt, 'P1', 'a refused reset changes nothing')
    assert.equal(f.service.chatReset('u-alice', first.revision).overridePrompt, null)
    assert.throws(() => f.service.chatReset('u-alice', first.revision), /prompt_conflict/, 'the reset consumed that revision')
    assert.equal(rev(f.service, 'u-alice'), r0, 'no override: the revision is the hash of the two nulls')
    assert.equal(r0, sha256(JSON.stringify({ v: 1, prompt: null, myName: null })))
    assert.equal(f.service.state().nameRevision, sha256(JSON.stringify({ myName: '一號' })))
    assert.throws(() => f.service.save('x', 'stale'), /prompt_conflict/, 'the default prompt revision keeps working')
  } finally { f.cleanup() }
})

test('A8 validation: name length and characters, empty clears, prompt empty or too long, unknown chat', () => {
  const f = chatFixture()
  try {
    const name = () => f.service.state().nameRevision
    assert.throws(() => f.service.saveName('x'.repeat(MY_NAME_MAX_CHARS + 1), name()), /my_name_too_long/)
    assert.throws(() => f.service.saveName('王\n小明', name()), /my_name_invalid/)
    assert.throws(() => f.service.saveName('王\u0000小明', name()), /my_name_invalid/)
    assert.throws(() => f.service.saveName(42, name()), /my_name_invalid/)
    assert.equal(f.service.saveName('王'.repeat(MY_NAME_MAX_CHARS), name()).myName, '王'.repeat(MY_NAME_MAX_CHARS), 'exactly 40 code points is accepted')
    assert.equal(f.service.saveName('😀'.repeat(MY_NAME_MAX_CHARS), name()).myName, '😀'.repeat(MY_NAME_MAX_CHARS), 'length counts code points')
    assert.equal(f.service.saveName('  王   小  明 ', name()).myName, '王 小 明', 'trimmed and inner runs of spaces collapsed')
    assert.equal(f.service.saveName('   ', name()).myName, null, 'blank clears')
    assert.equal(f.service.saveName(null, name()).myName, null)
    assert.equal(validateMyName(undefined), null)
    assert.equal(normalizeMyName('bad\nname'), null)
    assert.equal(normalizeMyName('  ok  '), 'ok')

    const r = () => rev(f.service, 'u-alice')
    assert.throws(() => f.service.chatSave('u-alice', { prompt: '   ', myName: null }, r()), /prompt_empty/)
    assert.throws(() => f.service.chatSave('u-alice', { prompt: 'x'.repeat(PROMPT_MAX_CHARS + 1), myName: null }, r()), /prompt_too_long/)
    assert.throws(() => f.service.chatSave('u-alice', { prompt: 'ok', myName: 'a\tb' }, r()), /my_name_invalid/)
    assert.throws(() => f.service.chatSave('u-alice', { prompt: 'ok', myName: 'y'.repeat(41) }, r()), /my_name_too_long/)
    assert.deepEqual(f.service.chatList(), [], 'a refused save writes nothing')
    assert.throws(() => f.service.chatSave('u-unknown', { prompt: 'ok', myName: null }, r()), /chat_unknown/)
    assert.throws(() => f.service.chatState('u-unknown'), /chat_unknown/)
  } finally { f.cleanup() }
})

test('A19 the largest allowed prompt, a 40 character name and the fixed contract still fit the Host system limit', () => {
  const f = chatFixture()
  try {
    f.service.saveName('😀'.repeat(MY_NAME_MAX_CHARS), f.service.state().nameRevision)
    f.service.chatSave('u-alice', { prompt: 'p'.repeat(PROMPT_MAX_CHARS), myName: '字'.repeat(MY_NAME_MAX_CHARS) }, rev(f.service, 'u-alice'))
    const system = f.service.extractSystem('u-alice')
    assert.ok(system.length <= 16_000, `system is ${system.length} chars`)
    assert.ok(system.length > PROMPT_MAX_CHARS + EXTRACT_OUTPUT_CONTRACT.length)
    f.service.chatReset('u-alice', rev(f.service, 'u-alice'))
    f.service.save('q'.repeat(PROMPT_MAX_CHARS), f.service.revision())
    assert.ok(f.service.extractSystem('u-bob').length <= 16_000)
  } finally { f.cleanup() }
})

test('A21 settings.json written by the previous release (no pluginMyName) loads, and a name survives a settings-store restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'line-todo-myname-'))
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ pollIntervalSec: 45, pluginPrompt: '舊版自訂規則' }))
    const first = createSettingsStore({ userDataDir: dir, secrets: noSecrets })
    assert.equal(first.get().pluginMyName ?? null, null)
    assert.equal(first.get().pluginPrompt, '舊版自訂規則')
    const service = createPromptService(first, unusedAi)
    assert.equal(service.state().myName, null)
    service.saveName('小明', service.state().nameRevision)
    const restarted = createSettingsStore({ userDataDir: dir, secrets: noSecrets })
    assert.equal(restarted.get().pluginMyName, '小明')
    assert.equal(restarted.get().pluginPrompt, '舊版自訂規則')
    first.update({ pollIntervalSec: 50 })
    assert.equal(createSettingsStore({ userDataDir: dir, secrets: noSecrets }).get().pluginMyName, '小明', 'unrelated updates keep the name')
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ pluginMyName: 'a\nb' }))
    assert.equal(createSettingsStore({ userDataDir: dir, secrets: noSecrets }).get().pluginMyName, null, 'an invalid stored name is dropped by normalize')
    assert.equal(SCHEMA_VERSION, 8)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


test('n1 the identity section escapes the name the same way in every place it appears, including the @ form; a plain name is unchanged', () => {
  const tricky = '阿"華\Q'
  const quoted = JSON.stringify(tricky)
  const lines = identitySection(tricky).split('\n')
  assert.equal(lines[1], `- 在這個聊天室裡，「我」(me) 被稱為 ${quoted}。訊息中對 ${quoted}（含 @${quoted.slice(1, -1)}、暱稱或相近寫法）的請託、指派與點名，視為對我說的。`)
  assert.ok(!lines[1].includes(`@${tricky}`), 'the raw name never appears unescaped')
  assert.equal(identitySection('王小明'), identityBlock('王小明'), 'a name with nothing to escape keeps the designed text')
})
