import test from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultChatProfileConfig, chatProfileKey, resolveChatProfile } from '../../src/shared/chatProfiles.ts'
import { projectAiInputSafely } from '../../src/shared/aiInputSafety.ts'
import { createChatProfileService, createChatProfileStore } from '../../src/plugin/backend/chatProfileStore.ts'
import { Dispatcher } from '../../src/plugin/backend/dispatcher.ts'
import { EventHub } from '../../src/plugin/backend/eventHub.ts'
import { backendMethodFor } from '../../src/shared/pluginWire.ts'

function memoryDb() {
  const values = new Map()
  return { values, prepare(sql) { return { get(key) { if (sql.includes('SELECT value')) return values.has(key) ? { value: values.get(key) } : undefined; if (sql.includes('SELECT is_group')) return key === 'a' ? { is_group: 1 } : key === 'b' ? { is_group: 0 } : undefined }, run(key, value) { values.set(key, value) } } } }
}

test('dispatcher exposes callable profile config/chat/resolve with CAS, isolation, legacy retention and reset', async () => {
  const db = memoryDb()
  const store = createChatProfileStore(() => db)
  const service = createChatProfileService({ store, legacy: (chatId) => ({ chatPrompt: chatId === 'a' ? 'legacy A' : null, chatName: chatId === 'a' ? 'Alice' : null }), global: () => ({ prompt: 'global todo', myName: null }) })
  const hub = new EventHub()
  const dispatcher = new Dispatcher({ getApi: () => ({}), hub, queue: { stats: () => ({}) }, profiles: service, info: () => ({}) })
  const invoke = (path, ...args) => dispatcher.call(backendMethodFor(path), { path, args })
  try {
    const initial = await invoke('settings.profiles.getConfig')
    assert.equal(initial.ok, true)
    const config = structuredClone(initial.value)
    config.customNatures.push({ id: 'custom_demo', label: '自訂' })
    for (const kind of ['group', 'non_group', 'unknown']) config.matrix[kind].custom_demo = { todoInstruction: 'custom todo', topicInstruction: 'custom topic' }
    const savedConfig = await invoke('settings.profiles.saveConfig', { config, expectedRevision: initial.value.revision })
    assert.equal(savedConfig.ok, true)
    assert.equal((await invoke('settings.profiles.saveConfig', { config, expectedRevision: initial.value.revision })).code, 'revision_conflict')
    const legacy = await invoke('settings.profiles.resolve', { chatId: 'a' })
    assert.deepEqual([legacy.value.chatKind, legacy.value.todo.instruction, legacy.value.todo.source, legacy.value.myName.value], ['group', 'legacy A', 'chat', 'Alice'])
    const chat = await invoke('settings.profiles.getChat', { chatId: 'a' })
    const savedChat = await invoke('settings.profiles.saveChat', { chatId: 'a', value: { natureId: 'custom_demo', todoOverride: null, topicOverride: null }, expectedRevision: 'new' })
    assert.equal(savedChat.ok, true)
    assert.equal((await invoke('settings.profiles.saveChat', { chatId: 'a', value: { natureId: 'mixed_unclassified', todoOverride: null, topicOverride: null }, expectedRevision: 'new' })).code, 'revision_conflict')
    const resolvedA = await invoke('settings.profiles.resolve', { chatId: 'a' })
    const resolvedB = await invoke('settings.profiles.resolve', { chatId: 'b' })
    assert.deepEqual([resolvedA.value.natureId, resolvedA.value.chatKind, resolvedB.value.natureId, resolvedB.value.chatKind], ['custom_demo', 'group', 'mixed_unclassified', 'non_group'])
    assert.deepEqual([resolvedB.value.todo.instruction, resolvedB.value.todo.source], ['global todo', 'legacy'])
    const reset = await invoke('settings.profiles.saveChat', { chatId: 'a', value: { natureId: 'custom_demo', todoOverride: null, topicOverride: null, resetLegacyTodo: true }, expectedRevision: savedChat.value.revision })
    assert.equal(reset.ok, true)
    assert.deepEqual([(await invoke('settings.profiles.resolve', { chatId: 'a' })).value.todo.instruction, (await invoke('settings.profiles.resolve', { chatId: 'a' })).value.todo.source], ['custom todo', 'matrix'])
    assert.equal((await invoke('settings.profiles.getChat', { chatId: 'b' })).value, null)
  } finally { dispatcher.dispose(); hub.dispose() }
})

test('default profile contains five natures for three metadata states and defaults to mixed', () => {
  const config = createDefaultChatProfileConfig()
  assert.equal(Object.keys(config.matrix.group).length, 5)
  assert.equal(resolveChatProfile({ chatId: 'synthetic', chatKind: 'unknown', config }).natureId, 'mixed_unclassified')
})

test('legacy chat todo prompt wins until reset and resets to built-in matrix', () => {
  const config = createDefaultChatProfileConfig()
  const legacy = resolveChatProfile({ chatId: 'synthetic', chatKind: 'group', config, legacyChatPrompt: 'legacy prompt' })
  assert.equal(legacy.todo.instruction, 'legacy prompt')
  assert.equal(legacy.todo.source, 'chat')
  const reset = resolveChatProfile({ chatId: 'synthetic', chatKind: 'group', config, legacyChatPrompt: 'legacy prompt', override: { natureId: 'mixed_unclassified', todoOverride: null, topicOverride: null, revision: 'r', resetLegacyTodo: true } })
  assert.notEqual(reset.todo.instruction, 'legacy prompt')
})

test('selected nature uses matrix, mixed retains global legacy and explicit legacy chat remains a chat override', () => {
  const config = createDefaultChatProfileConfig()
  const chosen = resolveChatProfile({ chatId: 'x', chatKind: 'group', natureId: 'announcement_event', config, legacyGlobalPrompt: 'legacy global' })
  assert.equal(chosen.todo.source, 'matrix')
  assert.match(chosen.todo.instruction, /公告或活動/)
  const mixed = resolveChatProfile({ chatId: 'x', chatKind: 'group', natureId: 'mixed_unclassified', config, legacyGlobalPrompt: 'legacy global' })
  assert.deepEqual([mixed.todo.instruction, mixed.todo.source], ['legacy global', 'legacy'])
  const oldChatOverride = resolveChatProfile({ chatId: 'x', chatKind: 'group', natureId: 'announcement_event', config, legacyChatPrompt: 'legacy chat' })
  assert.deepEqual([oldChatOverride.todo.instruction, oldChatOverride.todo.source], ['legacy chat', 'chat'])
})

test('invalid profile rows are excluded and recoverable, saves validate shape and revisions never reuse in same millisecond', () => {
  const db = memoryDb(); const store = createChatProfileStore(() => db)
  const bad = { schemaVersion: 1, chatId: 'a', natureId: 'mixed_unclassified', todoOverride: { marker: 'bad' }, topicOverride: null, revision: 'bad-r', resetLegacyTodo: false }
  db.values.set(chatProfileKey('a'), JSON.stringify(bad))
  assert.equal(store.getChat('a'), null)
  assert.equal(store.hasInvalidChat('a'), true)
  const service = createChatProfileService({ store, legacy: () => ({ chatPrompt: null, chatName: null }), global: () => ({ prompt: null, myName: null }) })
  assert.equal(service.resolve('a').warning, 'profile_invalid')
  assert.equal(db.values.get(chatProfileKey('a')), JSON.stringify(bad), 'invalid row is preserved until an explicit save')
  const repaired = store.saveChat('a', { natureId: 'mixed_unclassified', todoOverride: null, topicOverride: null }, 'new')
  assert.equal(store.hasInvalidChat('a'), false)
  assert.notEqual(repaired.revision, 'bad-r')
  assert.throws(() => store.saveChat('b', { natureId: 'missing', todoOverride: null, topicOverride: null }, 'new'), /invalid_input/)
  assert.throws(() => store.saveChat('b', { natureId: 'mixed_unclassified', todoOverride: null, topicOverride: null, extra: true }, 'new'), /invalid_input/)
  const now = Date.now; Date.now = () => 1700000000000
  try {
    const r0 = store.saveChat('b', { natureId: 'mixed_unclassified', todoOverride: null, topicOverride: null }, 'new').revision
    const r1 = store.saveChat('b', { natureId: 'work_project', todoOverride: null, topicOverride: null }, r0).revision
    const r2 = store.saveChat('b', { natureId: 'mixed_unclassified', todoOverride: null, topicOverride: null }, r1).revision
    assert.notEqual(r0, r2)
    assert.throws(() => store.saveChat('b', { natureId: 'announcement_event', todoOverride: null, topicOverride: null }, r0), /revision_conflict/)
  } finally { Date.now = now }
})

test('sensitive synthetic canary is redacted and normal work language remains', () => {
  const result = projectAiInputSafely('Project Atlas delivery status: Authorization: Bearer synthetic-secret-token-12345')
  assert.equal(result.status, 'redacted')
  assert.match(result.payload, /Project Atlas delivery status/)
  assert.doesNotMatch(result.payload, /synthetic-secret-token/)
})
