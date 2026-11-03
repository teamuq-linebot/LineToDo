import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSettingsStore } from '../../src/main/config/settings.ts'
import { createPromptService, identitySection } from '../../src/plugin/backend/promptService.ts'
import { AI_CHAT_REFERENCE } from '../../src/plugin/backend/hostAi.ts'
import { COMBINED_OUTPUT_CONTRACT, EXTRACT_OUTPUT_CONTRACT, outputContractFor } from '../../src/plugin/backend/aiOutputContract.ts'
import { EXTRACT_SYSTEM_PROMPT } from '../../src/main/llm/extractPrompt.ts'
import { EXTRACT_JSON_SCHEMA } from '../../src/main/llm/schema.ts'
import { MY_NAME_MAX_CHARS, PROMPT_MAX_CHARS } from '../../src/shared/promptSettings.ts'
import {
  COMBINED_BUNDLE_ENABLED, COMBINED_JSON_SCHEMA, COMBINED_PROMPT_HASH, COMBINED_PROMPT_VERSION, COMBINED_SCHEMA_HASH, COMBINED_SCHEMA_VERSION, COMBINED_TOPIC_SECTION,
  GROUP_TOPICS_JSON_SCHEMA
} from '../../src/main/features/groupTopics/prompts/bundle.ts'
import { splitCombined, topicCandidatesOnly, validateCombinedEnvelope } from '../../src/main/features/groupTopics/combined.ts'

const noSecrets = { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unused') }, decryptString: () => { throw new Error('unused') } }
const unusedAi = { complete: async () => { throw new Error('unused') } }
const sha256 = (text) => createHash('sha256').update(text).digest('hex')

function promptFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'line-todo-combined-'))
  const service = createPromptService(createSettingsStore({ userDataDir: dir, secrets: noSecrets }), unusedAi)
  return { dir, service, settings: createSettingsStore({ userDataDir: dir, secrets: noSecrets }), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const todoDraft = (msgId, ref = 'd1') => ({ draftRef: ref, bucket: 'todo', title: '準備簡報', detail: null, priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds: [msgId] })
const todoDecision = (msgId, ref = 'd1') => ({ draftRef: ref, outcome: 'new', candidateType: null, candidateId: null, relationKind: null, reasonCode: 'insufficient_evidence', confidenceBand: 'high', evidenceMsgIds: [msgId] })
const validTodo = (msgId = 'm1') => ({ importance: 'action', newTodos: [todoDraft(msgId)], identityDecisions: [todoDecision(msgId)], resolved: [], updates: [] })
const todoCtx = (ids = ['m1']) => ({ candidates: [], candidatesTruncated: false, selectedMessageIds: ids, targetType: 'todo', allowedTodoIds: [] })
const targets = [{ msgId: 'm1', ts: 1, direction: 'in', text: 'Project Orion launch' }, { msgId: 'm2', ts: 2, direction: 'out', text: 'I will prepare the deck' }]
const validTopic = () => ({
  topics: [{ ref: 'orion', title: 'Project Orion', summary: 'Launch planning.' }],
  identityDecisions: [{ draftRef: 'orion', outcome: 'new', candidateType: null, candidateId: null, relationKind: null, reasonCode: 'insufficient_evidence', confidenceBand: 'high', evidenceMsgIds: ['m1'] }],
  assignments: [
    { msgId: 'm1', topicRef: 'orion', relation: 'about', confidence: 0.8, relevance: 'unknown', relevanceEvidenceMsgIds: [] },
    { msgId: 'm2', topicRef: null, relation: 'uncertain', confidence: 0.2, relevance: 'unknown', relevanceEvidenceMsgIds: [] }
  ]
})
const topicCtx = (extra = {}) => ({ targets, candidates: [], candidatesTruncated: false, ...extra })

test('envelope: a well-formed { todo, topic } and { todo, topic: null } are accepted', () => {
  const both = validateCombinedEnvelope({ todo: validTodo(), topic: validTopic() })
  assert.equal(both.ok, true)
  assert.deepEqual(both.value.topic, validTopic())
  const todoOnly = validateCombinedEnvelope({ todo: validTodo(), topic: null })
  assert.equal(todoOnly.ok, true)
  assert.equal(todoOnly.value.topic, null)
  const omitted = validateCombinedEnvelope({ todo: validTodo() })
  assert.equal(omitted.ok, true)
  assert.equal(omitted.value.topic, null)
})

test('envelope: a flat ExtractResult without the wrapper is tolerated as { todo: whole, topic: null }', () => {
  const result = validateCombinedEnvelope(validTodo())
  assert.equal(result.ok, true)
  assert.equal(result.value.topic, null)
  assert.equal(result.value.todo.importance, 'action')
  assert.equal(result.value.todo.newTodos[0].title, '準備簡報')
})

test('envelope: wrong wrapper shapes are rejected', () => {
  for (const bad of [null, [], 'text', 3, {}, { topic: validTopic() }, { importance: 'action' }]) assert.equal(validateCombinedEnvelope(bad).ok, false, JSON.stringify(bad))
  const extra = validateCombinedEnvelope({ todo: validTodo(), topic: null, note: 'x' })
  assert.equal(extra.ok, false)
  assert.match(extra.reason, /todo、topic 以外/)
})

test('at least one side usable: bad todo + usable topic passes, usable todo + garbage topic passes, both bad fails', () => {
  const badTodoGoodTopic = validateCombinedEnvelope({ todo: { importance: 'nope' }, topic: validTopic() })
  assert.equal(badTodoGoodTopic.ok, true)
  assert.deepEqual(badTodoGoodTopic.value.todo, { importance: 'nope' }, 'the bad todo is passed through for the strict commit-level rejection')
  const goodTodoBadTopic = validateCombinedEnvelope({ todo: validTodo(), topic: { topics: 'x' } })
  assert.equal(goodTodoBadTopic.ok, true)
  assert.deepEqual(goodTodoBadTopic.value.topic, { topics: 'x' })
  const goodTodoStringTopic = validateCombinedEnvelope({ todo: validTodo(), topic: 'oops' })
  assert.equal(goodTodoStringTopic.ok, true)
  const bothBad = validateCombinedEnvelope({ todo: { importance: 'nope' }, topic: { topics: 'x' } })
  assert.equal(bothBad.ok, false)
  assert.match(bothBad.reason, /^todo: /)
  assert.equal(validateCombinedEnvelope({ todo: 5, topic: null }).ok, false)
  assert.equal(validateCombinedEnvelope({ todo: { importance: 'nope' }, topic: null }).ok, false)
})

test('splitCombined: both sides valid are validated with their strict contexts', () => {
  const split = splitCombined({ todo: validTodo(), topic: validTopic() }, { todo: todoCtx(['m1', 'm2']), topic: topicCtx() })
  assert.equal(split.todo.ok, true)
  assert.equal(split.todo.value.newTodos.length, 1)
  assert.equal(split.topic.state, 'ok')
  assert.deepEqual(split.topic.value.assignments.map((a) => a.msgId), ['m1', 'm2'])
  assert.equal(split.topic.value.identityDecisions.length, 1)
})

test('splitCombined: the two sides fail independently', () => {
  const badTopic = validTopic(); badTopic.assignments.pop()
  const a = splitCombined({ todo: validTodo(), topic: badTopic }, { todo: todoCtx(['m1', 'm2']), topic: topicCtx() })
  assert.equal(a.todo.ok, true)
  assert.equal(a.topic.state, 'fail')
  assert.equal(a.topic.error.reason, 'missing_assignment')
  const b = splitCombined({ todo: validTodo('unselected'), topic: validTopic() }, { todo: todoCtx(['m1', 'm2']), topic: topicCtx() })
  assert.equal(b.todo.ok, false)
  assert.ok(b.todo.error instanceof Error, 'the strict todo context rejects evidence outside the selected messages')
  assert.equal(b.topic.state, 'ok')
})

test('splitCombined: topic is absent when null, when no topic was sent, or when the targets are empty', () => {
  assert.equal(splitCombined({ todo: validTodo(), topic: null }, { todo: todoCtx(), topic: topicCtx() }).topic.state, 'absent')
  assert.equal(splitCombined({ todo: validTodo(), topic: validTopic() }, { todo: todoCtx(['m1', 'm2']) }).topic.state, 'absent')
  assert.equal(splitCombined({ todo: validTodo(), topic: validTopic() }, { todo: todoCtx(['m1', 'm2']), topic: topicCtx({ targets: [] }) }).topic.state, 'absent')
})

test('splitCombined: a flat reply is tolerated and yields an absent topic; a hopeless reply fails the todo side', () => {
  const flat = splitCombined(validTodo(), { todo: todoCtx(), topic: topicCtx() })
  assert.equal(flat.todo.ok, true)
  assert.equal(flat.topic.state, 'absent')
  const hopeless = splitCombined({ nope: 1 }, { todo: todoCtx(), topic: topicCtx() })
  assert.equal(hopeless.todo.ok, false)
  assert.equal(hopeless.topic.state, 'absent')
})

test('candidate filter: only topic candidates reach the topic validator', () => {
  const todoCandidate = { entityType: 'todo', entityId: 'todo-1', title: 'T', summary: null, status: 'pending', bucket: 'todo', dueAt: null, sourceMsgIds: [], recallReasons: ['exact_title'], completionEventTs: null }
  const topicCandidate = { ...todoCandidate, entityType: 'topic', entityId: 'topic-1', status: null, bucket: null }
  assert.deepEqual(topicCandidatesOnly([todoCandidate, topicCandidate]).map((c) => c.entityId), ['topic-1'])
  const updateTopic = (candidateType, candidateId) => {
    const topic = validTopic()
    topic.identityDecisions[0] = { ...topic.identityDecisions[0], outcome: 'update_existing', candidateType, candidateId, reasonCode: 'same_active_action' }
    return topic
  }
  const mixed = [todoCandidate, topicCandidate]
  assert.equal(splitCombined({ todo: validTodo(), topic: updateTopic('topic', 'topic-1') }, { todo: todoCtx(['m1', 'm2']), topic: topicCtx({ candidates: mixed }) }).topic.state, 'ok')
  assert.equal(splitCombined({ todo: validTodo(), topic: updateTopic('topic', 'todo-1') }, { todo: todoCtx(['m1', 'm2']), topic: topicCtx({ candidates: mixed }) }).topic.state, 'fail')
  assert.equal(splitCombined({ todo: validTodo(), topic: updateTopic('todo', 'todo-1') }, { todo: todoCtx(['m1', 'm2']), topic: topicCtx({ candidates: mixed }) }).topic.state, 'fail')
})

test('combined schema is composed from the two existing sources, not hand-written', () => {
  assert.equal(COMBINED_BUNDLE_ENABLED, true)
  assert.deepEqual(COMBINED_JSON_SCHEMA.properties.todo, EXTRACT_JSON_SCHEMA.schema)
  assert.deepEqual({ ...COMBINED_JSON_SCHEMA.properties.topic, type: 'object' }, GROUP_TOPICS_JSON_SCHEMA)
  assert.deepEqual(COMBINED_JSON_SCHEMA.properties.topic.type, ['object', 'null'])
  assert.deepEqual(COMBINED_JSON_SCHEMA.required, ['todo', 'topic'])
  assert.equal(COMBINED_JSON_SCHEMA.additionalProperties, false)
  assert.deepEqual(Object.keys(COMBINED_JSON_SCHEMA.properties), ['todo', 'topic'])
})

test('combined bundle versions and hashes are present; the contract wraps the combined schema', () => {
  assert.equal(COMBINED_PROMPT_VERSION, 'extract-combined-v1')
  assert.equal(COMBINED_SCHEMA_VERSION, 'extract-combined-schema-v1')
  assert.match(COMBINED_PROMPT_HASH, /^[a-f0-9]{64}$/)
  assert.match(COMBINED_SCHEMA_HASH, /^[a-f0-9]{64}$/)
  assert.notEqual(COMBINED_PROMPT_HASH, COMBINED_SCHEMA_HASH)
  assert.equal(COMBINED_OUTPUT_CONTRACT, outputContractFor(COMBINED_JSON_SCHEMA))
  assert.ok(COMBINED_OUTPUT_CONTRACT.includes(JSON.stringify(COMBINED_JSON_SCHEMA)))
  assert.equal(EXTRACT_OUTPUT_CONTRACT, outputContractFor(EXTRACT_JSON_SCHEMA.schema), 'the plain contract is untouched')
})

test('topic section declares the wrapper and the per-field scope', () => {
  assert.ok(COMBINED_TOPIC_SECTION.includes('{ "todo": ..., "topic": ... }'))
  assert.ok(COMBINED_TOPIC_SECTION.includes('todo 欄位的值'))
  assert.ok(COMBINED_TOPIC_SECTION.includes('topic.targetMsgIds'))
  assert.ok(COMBINED_TOPIC_SECTION.includes('Topic 與 Todo 永不合併'))
  assert.ok(!COMBINED_TOPIC_SECTION.startsWith('<!--'))
})

test('promptService without opts is byte-identical to the previous release; opts.topics appends the section and the combined contract', () => {
  const f = promptFixture()
  try {
    const legacy = `${EXTRACT_SYSTEM_PROMPT}\n\n${EXTRACT_OUTPUT_CONTRACT}`
    assert.equal(f.service.extractSystem(), legacy)
    assert.equal(f.service.extractSystem('chat-1'), legacy)
    assert.equal(f.service.extractSystem('chat-1', {}), legacy)
    assert.equal(f.service.extractSystem('chat-1', { topics: false }), legacy)
    assert.equal(f.service.systemSha256('chat-1'), sha256(EXTRACT_SYSTEM_PROMPT))
    assert.equal(f.service.systemSha256('chat-1', { topics: false }), sha256(EXTRACT_SYSTEM_PROMPT))
    const combined = f.service.extractSystem('chat-1', { topics: true })
    assert.equal(combined, `${EXTRACT_SYSTEM_PROMPT}\n\n${COMBINED_TOPIC_SECTION}\n\n${COMBINED_OUTPUT_CONTRACT}`)
    assert.equal(f.service.systemSha256('chat-1', { topics: true }), sha256(`${EXTRACT_SYSTEM_PROMPT}\n\n${COMBINED_TOPIC_SECTION}`))
    assert.notEqual(f.service.systemSha256('chat-1', { topics: true }), f.service.systemSha256('chat-1'))
    assert.equal(f.service.revision(), sha256(EXTRACT_SYSTEM_PROMPT), 'revision() only hashes the user prompt')
  } finally { f.cleanup() }
})

test('identity section stays between the user prompt and the topic section', () => {
  const dir = mkdtempSync(join(tmpdir(), 'line-todo-combined-name-'))
  try {
    const settings = createSettingsStore({ userDataDir: dir, secrets: noSecrets })
    const service = createPromptService(settings, unusedAi)
    service.saveName('小明', service.state().nameRevision)
    const text = `${EXTRACT_SYSTEM_PROMPT}\n\n${identitySection('小明')}`
    assert.equal(service.extractSystem('c'), `${text}\n\n${EXTRACT_OUTPUT_CONTRACT}`)
    assert.equal(service.extractSystem('c', { topics: true }), `${text}\n\n${COMBINED_TOPIC_SECTION}\n\n${COMBINED_OUTPUT_CONTRACT}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('measured length: the default topics system fits the host systemChars default', () => {
  const f = promptFixture()
  try {
    const plain = f.service.extractSystem('chat-1')
    const withTopics = f.service.extractSystem('chat-1', { topics: true })
    assert.equal(plain.length, 8344, 'plain system length is unchanged from the 0.2.10 baseline')
    assert.equal(withTopics.length, 11662, 'measured default length of extractSystem(chatId,{topics:true})')
    assert.ok(withTopics.length <= AI_CHAT_REFERENCE.systemChars, `${withTopics.length} must be <= ${AI_CHAT_REFERENCE.systemChars}`)
    assert.equal(AI_CHAT_REFERENCE.systemChars, 16000)
    const overhead = withTopics.length - plain.length
    const worstIdentity = identitySection('"'.repeat(MY_NAME_MAX_CHARS)).length + 2
    const worstCase = PROMPT_MAX_CHARS + worstIdentity + overhead
    assert.equal(overhead, 3318)
    assert.ok(worstCase <= AI_CHAT_REFERENCE.systemChars, `worst case ${worstCase} (max custom prompt + worst identity section + topic overhead) must still fit ${AI_CHAT_REFERENCE.systemChars}`)
  } finally { f.cleanup() }
})
