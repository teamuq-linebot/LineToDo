import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chatProfileKey, createDefaultChatProfileConfig, BUILTIN_CHAT_NATURES } from '../src/shared/chatProfiles.ts'

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
const referenceHash = (value) => createHash('sha256').update(value, 'utf8').digest('hex')

test('portable SHA-256 matches Node crypto vectors including Unicode and multiple blocks', () => {
  for (const value of ['', 'a', 'abc', '聊天室-😀', 'linejs '.repeat(200)]) {
    assert.equal(chatProfileKey(value), `line-todo.chat-profile.v1.${referenceHash(value)}`)
  }
})

test('default profile revision matches the previous Node SHA-256 contract', () => {
  const config = createDefaultChatProfileConfig()
  const matrix = Object.fromEntries(['group', 'non_group', 'unknown'].map((kind) => [kind, Object.fromEntries(BUILTIN_CHAT_NATURES.map((nature) => [nature.id, { todoInstruction: nature.todo, topicInstruction: nature.topic, edited: false }]))]))
  const expected = referenceHash(canonical({ schemaVersion: 1, customNatures: [], matrix, updatedAt: new Date(0).toISOString() }))
  assert.equal(config.revision, expected)
})
