// Per-chat prompt / "my name" overrides: the app_settings KV store (chatPromptStore.ts) and its use by the prompt service.
//   A9   overrides survive a restart (new store + same DB file); listing returns only chats that have an override
//   A10  DB not ready -> chat_prompt_unavailable (never a silently wrong prompt); a corrupt row falls back to the default and says so
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSettingsStore } from '../../src/main/config/settings.ts'
import { SCHEMA_VERSION } from '../../src/main/db/schema.ts'
import { openDatabase } from '../../src/main/db/database.ts'
import { CHAT_PROMPT_KEY_PREFIX, createChatPromptStore } from '../../src/plugin/backend/chatPromptStore.ts'
import { createPromptService } from '../../src/plugin/backend/promptService.ts'
import { EXTRACT_SYSTEM_PROMPT } from '../../src/main/llm/extractPrompt.ts'
import { EXTRACT_OUTPUT_CONTRACT } from '../../src/plugin/backend/aiOutputContract.ts'

const noSecrets = { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unused') }, decryptString: () => { throw new Error('unused') } }
const unusedAi = { complete: async () => { throw new Error('unused') } }
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const keyOf = (chatId) => `${CHAT_PROMPT_KEY_PREFIX}${sha256(chatId)}`

function insertChat(db, chatId, name = chatId) {
  db.prepare('INSERT INTO chats(chat_id, name, is_group, blocked, first_seen_at, last_seen_at) VALUES (?, ?, 0, 0, ?, ?)').run(chatId, name, '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z')
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'line-todo-chat-prompt-'))
  const dbPath = join(dir, 'app.db')
  const opened = openDatabase({ dbPath })
  const logs = []
  const make = (db = opened.db) => {
    const settings = createSettingsStore({ userDataDir: dir, secrets: noSecrets })
    const chatStore = createChatPromptStore({ getDatabase: () => db })
    return { settings, chatStore, service: createPromptService(settings, unusedAi, { chatStore, log: (event, detail) => logs.push([event, detail]) }) }
  }
  return { dir, dbPath, db: opened.db, logs, make, cleanup: () => { try { opened.db.close() } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }) } }
}

test('A9 overrides are stored under hashed app_settings keys, survive a restart on the same DB file, and the list shows only chats that have one', async () => {
  const ctx = setup()
  try {
    insertChat(ctx.db, 'u-alice')
    insertChat(ctx.db, 'u-bob')
    insertChat(ctx.db, 'u-carol')
    const first = ctx.make()
    const aliceBase = first.service.chatState('u-alice')
    const saved = first.service.chatSave('u-alice', { prompt: 'ALICE 專屬規則', myName: '小華' }, aliceBase.revision)
    assert.equal(saved.overridePrompt, 'ALICE 專屬規則')
    assert.equal(saved.overrideName, '小華')
    first.service.chatSave('u-bob', { prompt: null, myName: '阿明' }, first.service.chatState('u-bob').revision)

    const row = ctx.db.prepare('SELECT key, value FROM app_settings WHERE key = ?').get(keyOf('u-alice'))
    assert.ok(row, 'stored under line-todo.chat-prompt.v1.<sha256(chatId)>')
    assert.ok(!row.key.includes('u-alice'))
    assert.deepEqual(JSON.parse(row.value), { schemaVersion: 1, chatId: 'u-alice', prompt: 'ALICE 專屬規則', myName: '小華' })
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM app_settings WHERE key LIKE ?').get(`${CHAT_PROMPT_KEY_PREFIX}%`).n, 2)

    ctx.db.close()
    const reopened = openDatabase({ dbPath: ctx.dbPath })
    try {
      const second = ctx.make(reopened.db)
      const alice = second.service.chatState('u-alice')
      assert.equal(alice.overridePrompt, 'ALICE 專屬規則')
      assert.equal(alice.overrideName, '小華')
      assert.equal(alice.promptSource, 'chat')
      assert.equal(alice.nameSource, 'chat')
      assert.equal(second.service.chatState('u-carol').promptSource, 'default')
      assert.match(second.service.extractSystem('u-alice'), /^ALICE 專屬規則\n\n【使用者在這個對話的身分/)
      const list = second.service.chatList()
      assert.deepEqual(list.map((item) => item.chatId).sort(), ['u-alice', 'u-bob'])
      assert.deepEqual(list.find((item) => item.chatId === 'u-bob'), { chatId: 'u-bob', hasPrompt: false, myName: '阿明', revision: second.service.chatState('u-bob').revision })
      assert.ok(list.every((item) => !('prompt' in item)), 'the list is a summary, never the prompt text')
      second.service.chatReset('u-alice', alice.revision)
      assert.deepEqual(second.service.chatList().map((item) => item.chatId), ['u-bob'])
      assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM app_settings WHERE key = ?').get(keyOf('u-alice')).n, 0, 'no empty override row is kept')
    } finally { reopened.db.close() }
  } finally { ctx.cleanup() }
})

test('A21 the override store adds no table and no schema version: SCHEMA_VERSION stays at the current version (10)', () => {
  const ctx = setup()
  try {
    assert.equal(SCHEMA_VERSION, 10)
    const tables = ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name)
    assert.ok(!tables.some((name) => /prompt/i.test(name)), `no prompt table in ${tables.join(',')}`)
    assert.equal(ctx.db.pragma('user_version', { simple: true }), 10)
  } finally { ctx.cleanup() }
})

test('A10 an app DB that is not ready raises chat_prompt_unavailable instead of using a wrong prompt; without a store the default applies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'line-todo-chat-prompt-unavailable-'))
  try {
    const settings = createSettingsStore({ userDataDir: dir, secrets: noSecrets })
    for (const getDatabase of [() => null, () => { throw new Error('closing') }]) {
      const service = createPromptService(settings, unusedAi, { chatStore: createChatPromptStore({ getDatabase }) })
      assert.throws(() => service.extractSystem('u-alice'), /chat_prompt_unavailable/)
      assert.throws(() => service.systemSha256('u-alice'), /chat_prompt_unavailable/)
      assert.throws(() => service.chatState('u-alice'), /chat_prompt_unavailable/)
      assert.throws(() => service.chatSave('u-alice', { prompt: 'x', myName: null }, 'r'), /chat_prompt_unavailable/)
      assert.throws(() => service.chatReset('u-alice', 'r'), /chat_prompt_unavailable/)
      assert.throws(() => service.chatList(), /chat_prompt_unavailable/)
      assert.equal(service.extractSystem(), `${EXTRACT_SYSTEM_PROMPT}\n\n${EXTRACT_OUTPUT_CONTRACT}`, 'the default path never touches the DB')
    }
    const bare = createPromptService(settings, unusedAi)
    assert.throws(() => bare.chatState('u-alice'), /chat_prompt_unavailable/)
    assert.throws(() => bare.chatList(), /chat_prompt_unavailable/)
    assert.equal(bare.extractSystem('u-alice'), `${EXTRACT_SYSTEM_PROMPT}\n\n${EXTRACT_OUTPUT_CONTRACT}`, 'two-argument construction (older callers): per-chat lookup falls back to the default')
    assert.equal(bare.systemSha256('u-alice'), bare.revision())
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('A10 a corrupt row falls back to the default with corrupt:true and one log line; resetting it with the shown revision removes the row', () => {
  const ctx = setup()
  try {
    insertChat(ctx.db, 'u-alice')
    const { service } = ctx.make()
    const clean = service.chatState('u-alice')
    assert.equal(clean.corrupt, false)
    const bad = [
      'not json',
      JSON.stringify({ schemaVersion: 2, chatId: 'u-alice', prompt: 'x', myName: null }),
      JSON.stringify({ schemaVersion: 1, chatId: 'u-bob', prompt: 'x', myName: null }),
      JSON.stringify({ schemaVersion: 1, chatId: 'u-alice', prompt: '', myName: null }),
      JSON.stringify({ schemaVersion: 1, chatId: 'u-alice', prompt: null, myName: 'bad\nname' }),
      JSON.stringify({ schemaVersion: 1, chatId: 'u-alice', prompt: null, myName: null }),
      JSON.stringify({ schemaVersion: 1, chatId: 'u-alice', prompt: 'x', myName: null, extra: true })
    ]
    for (const value of bad) {
      ctx.db.prepare('INSERT INTO app_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(keyOf('u-alice'), value)
      const state = service.chatState('u-alice')
      assert.equal(state.corrupt, true, value)
      assert.equal(state.promptSource, 'default')
      assert.equal(state.overridePrompt, null)
      assert.equal(service.extractSystem('u-alice'), `${EXTRACT_SYSTEM_PROMPT}\n\n${EXTRACT_OUTPUT_CONTRACT}`, 'corrupt: the default prompt is used')
      assert.equal(service.chatList().length, 0, 'a corrupt row is not listed as an override')
    }
    assert.equal(ctx.logs.filter(([event]) => event === 'chat_override_corrupt').length, 1, 'reported once per chat while it stays corrupt, without any content')
    assert.ok(ctx.logs.every(([, detail]) => detail === undefined))
    const after = service.chatReset('u-alice', service.chatState('u-alice').revision)
    assert.equal(after.corrupt, false)
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM app_settings WHERE key = ?').get(keyOf('u-alice')).n, 0)
  } finally { ctx.cleanup() }
})

test('the store rejects an unknown chat for get/save, but reset still clears a leftover row of a chat that is gone', () => {
  const ctx = setup()
  try {
    const { service, chatStore } = ctx.make()
    assert.throws(() => service.chatState('u-ghost'), /chat_unknown/)
    assert.throws(() => service.chatSave('u-ghost', { prompt: 'x', myName: null }, 'r'), /chat_unknown/)
    assert.throws(() => service.chatState(''), /chat_unknown/)
    assert.throws(() => service.chatState(42), /chat_unknown/)
    assert.throws(() => service.chatState('x'.repeat(513)), /chat_unknown/)
    chatStore.put('u-ghost', { prompt: 'left behind', myName: null })
    const revision = service.chatList().find((item) => item.chatId === 'u-ghost').revision
    service.chatReset('u-ghost', revision)
    assert.deepEqual(service.chatList(), [])
  } finally { ctx.cleanup() }
})


test('m3 the extraction path never fails on the shape of a chatId (empty or over 512 characters resolve to the default); the length limit stays on the API surface and on put', () => {
  const ctx = setup()
  try {
    const { service, chatStore } = ctx.make()
    const named = service.saveName('預設名', service.state().nameRevision)
    const customized = service.save('CHANGED DEFAULT M3', service.revision())
    assert.equal(named.myName, '預設名')
    assert.equal(customized.activePrompt, 'CHANGED DEFAULT M3')
    const expectedSystem = `CHANGED DEFAULT M3\n\n${identityBlock('預設名')}\n\n${EXTRACT_OUTPUT_CONTRACT}`
    for (const chatId of ['', 'x'.repeat(513), 'y'.repeat(5000)]) {
      assert.equal(service.extractSystem(chatId), expectedSystem, `extractSystem(${chatId.length} chars)`)
      assert.equal(service.systemSha256(chatId), service.systemSha256(), `systemSha256(${chatId.length} chars)`)
      assert.deepEqual(chatStore.get(chatId), { override: { prompt: null, myName: null }, corrupt: false })
    }
    assert.throws(() => chatStore.put('x'.repeat(513), { prompt: 'x', myName: null }), /chat_unknown/)
    assert.throws(() => chatStore.put('', { prompt: 'x', myName: null }), /chat_unknown/)
    assert.throws(() => service.chatState('x'.repeat(513)), /chat_unknown/)
    assert.throws(() => service.chatReset('x'.repeat(513), 'r'), /chat_unknown/)
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM app_settings WHERE key LIKE ?').get(`${CHAT_PROMPT_KEY_PREFIX}%`).n, 0, 'nothing was stored for the odd chat ids')
  } finally { ctx.cleanup() }
})

function identityBlock(name) {
  return [
    '【使用者在這個對話的身分（由程式加入）】',
    `- 在這個聊天室裡，「我」(me) 被稱為 ${JSON.stringify(name)}。訊息中對 ${JSON.stringify(name)}（含 @${name}、暱稱或相近寫法）的請託、指派與點名，視為對我說的。`,
    '- 這只用來判斷事項是否指派給我；不改變 direction 的定義、輸出欄位或 JSON Schema。'
  ].join('\n')
}
