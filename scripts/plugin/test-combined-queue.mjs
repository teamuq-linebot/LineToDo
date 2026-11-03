// Phase 3 — 待辦＋議題合併整理的佇列接線（設計 §4、§5.4、§6.2）。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createTodo, getOpenTodosByChat, updateTodo } from '../../src/main/db/todos.repo.ts'
import { getPipelineDefaults } from '../../src/main/config/defaults.ts'
import { DEFAULT_COMBINED_EXTRACT, createSettingsStore } from '../../src/main/config/settings.ts'
import { buildUserPayload } from '../../src/main/llm/extractPrompt.ts'
import { createGroupTopicsService, GROUP_TOPICS_BATCH_SIZE } from '../../src/main/features/groupTopics/service.ts'
import { ensureGroupTopicsSchema, loadPendingMessages, setEnabled } from '../../src/main/features/groupTopics/repository.ts'
import { COMBINED_BUNDLE_ENABLED, COMBINED_PROMPT_HASH, COMBINED_PROMPT_VERSION, COMBINED_SCHEMA_VERSION } from '../../src/main/features/groupTopics/prompts/bundle.ts'
import { createPromptService } from '../../src/plugin/backend/promptService.ts'
import { createExtractWorker } from '../../src/plugin/backend/extractWorker.ts'
import { AI_CHAT_REFERENCE } from '../../src/plugin/backend/hostAi.ts'
import { MY_NAME_MAX_CHARS, PROMPT_MAX_CHARS } from '../../src/shared/promptSettings.ts'
import { COMBINED_DEGRADE_FAILS, COMBINED_DEGRADE_MS, COMBINED_LOCAL_TOPICS_RATIO, COMBINED_TARGETS_PER_PART, DEFAULT_MAX_USER_CHARS, ExtractQueue, partitionExtractInput } from '../../src/plugin/backend/extractQueue.ts'
import { NOW_MS, addMessages, captureOffBaseline, drainIndexes, feedQueue, openFixture, stored } from './combined-queue-harness.mjs'
import { readFileSync } from 'node:fs'

const noSecrets = { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unused') }, decryptString: () => { throw new Error('unused') } }
const MIN = 60_000

// ───────────────────────── fixture ─────────────────────────

function scenario({ chatId = 'g1', count = 6, text = (i) => `事項${i}：專案 Orion 需要準備簡報並確認時程`, flag = true, fits = true, topicsEnabled = true, queueOptions = {}, schema = true } = {}) {
  const opened = openFixture()
  const db = opened.db
  const state = { flag, fits, ms: NOW_MS }
  const logs = []
  const runs = []
  const ids = count > 0 ? addMessages(db, chatId, Array.from({ length: count }, (_, i) => [`m${i + 1}`, 10_000 + (i + 1) * 10, text(i + 1), i % 5 === 4 ? 'out' : 'in'])) : []
  if (schema) {
    ensureGroupTopicsSchema(db)
    if (topicsEnabled) setEnabled(db, chatId, true)
  }
  drainIndexes(db, chatId)
  const queue = new ExtractQueue({
    db, getConfig: getPipelineDefaults, now: () => state.ms,
    combined: { enabled: () => state.flag, systemFits: () => state.fits },
    log: (event, detail) => logs.push([event, detail]),
    onRun: (result) => runs.push(result),
    ...queueOptions
  })
  const api = {
    db, chatId, queue, state, logs, runs, ids,
    feed: () => feedQueue(db, queue),
    pull() {
      const item = queue.pull({ max: 1 }).items[0]
      return item ? { item, payload: JSON.parse(item.user) } : null
    },
    close() { queue.dispose(); opened.close() }
  }
  return api
}

const decisionNew = (ref, evidence) => ({ draftRef: ref, outcome: 'new', candidateType: null, candidateId: null, relationKind: null, reasonCode: 'insufficient_evidence', confidenceBand: 'high', evidenceMsgIds: [evidence] })
const todoPart = (payload, extra = {}) => {
  const first = payload.newMessages[0].msgId
  return { importance: 'action', newTodos: [{ draftRef: 'd1', bucket: 'todo', title: '準備簡報', detail: null, priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds: [first] }], identityDecisions: [decisionNew('d1', first)], resolved: [], updates: [], ...extra }
}
const topicPart = (payload, { ref = 'orion', drop = 0 } = {}) => {
  const targets = payload.topic.targetMsgIds
  const assignments = targets.map((msgId, index) => index === 0
    ? { msgId, topicRef: ref, relation: 'about', confidence: 0.8, relevance: 'unknown', relevanceEvidenceMsgIds: [] }
    : { msgId, topicRef: null, relation: 'uncertain', confidence: 0.2, relevance: 'unknown', relevanceEvidenceMsgIds: [] })
  return { topics: [{ ref, title: 'Project Orion', summary: '簡報與時程' }], identityDecisions: [decisionNew(ref, targets[0])], assignments: assignments.slice(0, assignments.length - drop) }
}
const bothOk = (payload) => ({ todo: todoPart(payload), topic: topicPart(payload) })
const commitOne = (s, item, result) => s.queue.commit({ results: [{ itemId: item.itemId, ok: true, result }] })
const count = (db, sql, ...params) => db.prepare(sql).get(...params).n
const processedCount = (db) => count(db, 'SELECT COUNT(*) AS n FROM messages WHERE processed=1')
const topicRows = (db) => ({
  topics: count(db, 'SELECT COUNT(*) AS n FROM discussion_topics'),
  decisions: count(db, 'SELECT COUNT(*) AS n FROM topic_message_decisions'),
  evidence: count(db, 'SELECT COUNT(*) AS n FROM topic_evidence')
})

// ───────────────────────── constants ─────────────────────────

test('constants: the per-part target cap equals GROUP_TOPICS_BATCH_SIZE and the degrade rule is 2 failures / 30 minutes', () => {
  assert.equal(COMBINED_TARGETS_PER_PART, GROUP_TOPICS_BATCH_SIZE)
  assert.equal(COMBINED_TARGETS_PER_PART, 20)
  assert.equal(COMBINED_LOCAL_TOPICS_RATIO, 0.15)
  assert.equal(COMBINED_DEGRADE_FAILS, 2)
  assert.equal(COMBINED_DEGRADE_MS, 30 * MIN)
  assert.equal(COMBINED_BUNDLE_ENABLED, true)
})

// ───────────────────────── flag OFF == baseline ─────────────────────────

test('flag OFF: payload, system, pull items and session fingerprint are byte-identical to the 0.2.10 baseline (topics enabled in the group)', async () => {
  const baseline = JSON.parse(readFileSync(new URL('./fixtures/combined-off-baseline.json', import.meta.url), 'utf8'))
  assert.ok(baseline.parts.length >= 2, 'the baseline covers several parts')
  for (const part of baseline.parts) {
    assert.ok(!JSON.parse(part.item.user).topic, 'the 0.2.10 payload has no topic key')
    assert.ok(!('topics' in part.item))
  }
  const withFlagOff = await captureOffBaseline({ combined: { enabled: () => false, systemFits: () => true } })
  assert.deepEqual(withFlagOff, baseline)
  const standalone = await captureOffBaseline()
  assert.deepEqual(standalone, baseline, 'no combined option at all (standalone) is the baseline too')
})

test('flag OFF at pull time: a part offered while the flag was on is pulled as a plain todo part once the flag is off', async () => {
  const s = scenario()
  try {
    await s.feed()
    s.state.flag = false
    const pulled = s.pull()
    assert.ok(pulled)
    assert.equal(pulled.payload.topic, undefined)
    assert.equal('topics' in pulled.item, false)
    assert.deepEqual(Object.keys(pulled.payload).sort(), ['chat', 'historicalCandidates', 'historicalCandidatesTruncated', 'newMessages', 'now', 'openTodos', 'recentContext'])
  } finally { s.close() }
})

// ───────────────────────── when the combined path applies ─────────────────────────

test('flag ON: only groups with topics enabled get a topic key; 1:1 chats, groups without topics, and DBs without the topic tables stay todo-only', async () => {
  const on = scenario()
  try {
    await on.feed()
    const pulled = on.pull()
    assert.equal(pulled.item.topics, true)
    assert.deepEqual(pulled.payload.topic.targetMsgIds, on.ids)
    assert.deepEqual(pulled.payload.topic.existingLocalTopics, [])
  } finally { on.close() }

  const disabled = scenario({ topicsEnabled: false })
  try {
    await disabled.feed()
    const pulled = disabled.pull()
    assert.equal(pulled.payload.topic, undefined)
    assert.equal('topics' in pulled.item, false)
  } finally { disabled.close() }

  const noSchema = scenario({ schema: false })
  try {
    await noSchema.feed()
    const pulled = noSchema.pull()
    assert.equal(pulled.payload.topic, undefined)
  } finally { noSchema.close() }

  const oneToOne = scenario()
  try {
    oneToOne.db.prepare('UPDATE chats SET is_group=0 WHERE chat_id=?').run(oneToOne.chatId)
    await oneToOne.feed()
    assert.equal(oneToOne.pull().payload.topic, undefined)
  } finally { oneToOne.close() }
})

test('system: a topics part is answered with the combined system; the session fingerprint differs from a todo-only part', async () => {
  const s = scenario()
  const fingerprints = []
  const calls = []
  s.queue.opts.getSystemSha256 = (chatId, opts) => { if (chatId !== undefined) calls.push(opts?.topics === true); return opts?.topics ? 'sha-with-topics' : 'sha-plain' }
  try {
    await s.feed()
    const withTopic = s.pull()
    fingerprints.push(s.db.prepare('SELECT session_fingerprint AS fp FROM chat_context_cache WHERE chat_id=?').get(s.chatId).fp)
    s.queue.release({ itemIds: [withTopic.item.itemId] })
    s.state.flag = false
    const plain = s.pull()
    fingerprints.push(s.db.prepare('SELECT session_fingerprint AS fp FROM chat_context_cache WHERE chat_id=?').get(s.chatId).fp)
    assert.deepEqual(calls, [true, false])
    assert.notEqual(fingerprints[0], fingerprints[1])
    assert.ok(plain)
  } finally { s.close() }
})

// ───────────────────────── slicing and budget ─────────────────────────

test('slicing: a part carries at most 20 topic targets, every target in some part, targets are a subset of the part messages', async () => {
  const s = scenario({ count: 30, text: (i) => `事項${i}：Orion 簡報` })
  try {
    await s.feed()
    const seen = []
    const sizes = []
    for (let guard = 0; guard < 6; guard += 1) {
      const pulled = s.pull()
      if (!pulled) break
      const targets = pulled.payload.topic?.targetMsgIds ?? []
      const msgIds = pulled.payload.newMessages.map((m) => m.msgId)
      assert.ok(targets.length > 0 && targets.length <= COMBINED_TARGETS_PER_PART, `targets ${targets.length}`)
      assert.ok(targets.every((id) => msgIds.includes(id)), 'targets are a subset of newMessages')
      assert.ok(pulled.item.userChars <= DEFAULT_MAX_USER_CHARS)
      sizes.push(targets.length)
      seen.push(...targets)
      const result = commitOne(s, pulled.item, bothOk(pulled.payload))
      assert.equal(result.results[0].status, 'applied')
    }
    assert.deepEqual(sizes, [20, 10])
    assert.deepEqual([...seen].sort(), [...s.ids].sort())
    assert.equal(processedCount(s.db), 30)
    assert.equal(topicRows(s.db).decisions, 30)
  } finally { s.close() }
})

const dto = (i, text) => ({ msgId: `x${i}`, chatId: 'g', ts: 1_700_000_000_000 + i * 1000, timeIso: new Date(1_700_000_000_000 + i * 1000).toISOString(), direction: 'in', sender: 'Alice', text, contentType: 0, processed: false, ingestedAt: '', origFilename: null, fileSize: null, unsent: false })
const baseInput = (messages, topic) => ({ now: '2026-11-03T08:00:00.000', chat: { chatId: 'g', name: '群組', isGroup: true }, newMessages: messages, recentContext: [], openTodos: [], ...(topic ? { topic } : {}) })
const bigTopics = (n, summaryChars) => Array.from({ length: n }, (_, i) => ({ ref: `t${i}`, title: `既有議題 ${i}`, summary: '摘'.repeat(summaryChars) }))

test('7,500-char budget: existingLocalTopics is capped at 15% of a turn; the whole part never exceeds 7,500', () => {
  const messages = Array.from({ length: 12 }, (_, i) => dto(i + 1, `第${i + 1}則：` + '請確認專案進度與簡報內容。'.repeat(8)))
  const topic = { targetMsgIds: messages.map((m) => m.msgId), existingLocalTopics: bigTopics(100, 300) }
  const parts = partitionExtractInput(baseInput(messages, topic), { maxChars: DEFAULT_MAX_USER_CHARS, contextLimit: 0 })
  assert.deepEqual(parts.flatMap((p) => p.msgIds), messages.map((m) => m.msgId))
  const budget = Math.floor(DEFAULT_MAX_USER_CHARS * COMBINED_LOCAL_TOPICS_RATIO)
  for (const part of parts) {
    assert.ok(part.user.length <= DEFAULT_MAX_USER_CHARS)
    const parsed = JSON.parse(part.user)
    assert.ok(parsed.topic)
    assert.ok(JSON.stringify(parsed.topic.existingLocalTopics).length <= budget, 'locals stay inside 15%')
    assert.ok(parsed.topic.existingLocalTopics.length > 0 && parsed.topic.existingLocalTopics.length < 100)
    assert.deepEqual(parsed.topic, part.input.topic, 'the part input and its payload describe the same topic')
  }
})

test('7,500-char budget: when a lone message only fits without existingLocalTopics, the locals are dropped first (targets stay)', () => {
  const topic = (id) => ({ targetMsgIds: [id], existingLocalTopics: bigTopics(40, 300) })
  const sizeWith = (len, withLocals, withTopic = true) => buildUserPayload({ ...baseInput([dto(1, 'a'.repeat(len))]), topic: withTopic ? { targetMsgIds: ['x1'], existingLocalTopics: withLocals ? partitionExtractInput(baseInput([dto(2, 'z')], topic('x2')), { maxChars: DEFAULT_MAX_USER_CHARS, contextLimit: 0 })[0].input.topic.existingLocalTopics : [] } : undefined }).length
  let len = 6000
  while (sizeWith(len, true) <= DEFAULT_MAX_USER_CHARS) len += 25
  assert.ok(sizeWith(len, false) <= DEFAULT_MAX_USER_CHARS, 'precondition: it fits once the locals are gone')
  const parts = partitionExtractInput(baseInput([dto(1, 'a'.repeat(len))], topic('x1')), { maxChars: DEFAULT_MAX_USER_CHARS, contextLimit: 0 })
  assert.equal(parts.length, 1)
  assert.ok(parts[0].user.length <= DEFAULT_MAX_USER_CHARS)
  assert.equal(parts[0].truncated, 0)
  assert.deepEqual(parts[0].input.topic, { targetMsgIds: ['x1'], existingLocalTopics: [] })
  assert.deepEqual(JSON.parse(parts[0].user).topic, parts[0].input.topic)
})

test('7,500-char budget: when even the lean topic does not fit, the part becomes todo-only (the todo part never fails because of the topic)', () => {
  const todoOnly = (len) => buildUserPayload(baseInput([dto(1, 'a'.repeat(len))])).length
  const lean = (len) => buildUserPayload({ ...baseInput([dto(1, 'a'.repeat(len))]), topic: { targetMsgIds: ['x1'], existingLocalTopics: [] } }).length
  let len = 6500
  while (lean(len) <= DEFAULT_MAX_USER_CHARS) len += 1
  assert.ok(todoOnly(len) <= DEFAULT_MAX_USER_CHARS, 'precondition: the todo-only payload still fits')
  const parts = partitionExtractInput(baseInput([dto(1, 'a'.repeat(len))], { targetMsgIds: ['x1'], existingLocalTopics: bigTopics(5, 100) }), { maxChars: DEFAULT_MAX_USER_CHARS, contextLimit: 0 })
  assert.equal(parts.length, 1)
  assert.equal(parts[0].input.topic, undefined)
  assert.equal(JSON.parse(parts[0].user).topic, undefined)
  assert.ok(parts[0].user.length <= DEFAULT_MAX_USER_CHARS)
  assert.equal(parts[0].truncated, 0, 'no text was cut: the topic gave way instead')
  const huge = partitionExtractInput(baseInput([dto(1, 'b'.repeat(20_000)), dto(2, '第二則')], { targetMsgIds: ['x1', 'x2'], existingLocalTopics: [] }), { maxChars: DEFAULT_MAX_USER_CHARS, contextLimit: 0 })
  assert.deepEqual(huge.flatMap((p) => p.msgIds), ['x1', 'x2'])
  for (const part of huge) assert.ok(part.user.length <= DEFAULT_MAX_USER_CHARS)
  assert.equal(huge[0].input.topic, undefined, 'a truncated message is never a topic target')
})

test('partition without input.topic is unchanged: no topic key in input or payload', () => {
  const messages = Array.from({ length: 5 }, (_, i) => dto(i + 1, `訊息 ${i + 1} 需要處理`))
  const parts = partitionExtractInput(baseInput(messages), { maxChars: DEFAULT_MAX_USER_CHARS, contextLimit: 0 })
  assert.equal(parts.length, 1)
  assert.equal('topic' in parts[0].input, false)
  assert.equal(JSON.parse(parts[0].user).topic, undefined)
})

// ───────────────────────── pull-time refresh ─────────────────────────

test('pull refreshes the topic context: decided targets drop out and topics created after offer appear in existingLocalTopics', async () => {
  const s = scenario({ count: 5 })
  try {
    await s.feed()
    s.db.prepare("INSERT INTO topic_analysis_runs(run_id,chat_id,input_digest,prompt_version,prompt_hash,schema_version,schema_hash,state,created_at) VALUES('r-old',?,'digest-old','v','h','s','sh','complete','2026-11-03')").run(s.chatId)
    s.db.prepare("INSERT INTO topic_message_decisions(chat_id,msg_id,run_id,disposition) VALUES(?,?,'r-old','not_topic')").run(s.chatId, s.ids[0])
    s.db.prepare("INSERT INTO discussion_topics(topic_id,chat_id,local_ref,title,summary,created_at,last_source_ts,revision) VALUES('t-late',?,'late','後來才出現的議題','摘要','2026-11-03',99999,1)").run(s.chatId)
    const pulled = s.pull()
    assert.deepEqual(pulled.payload.topic.targetMsgIds, s.ids.slice(1), 'the already-decided message is no longer a target')
    assert.deepEqual(pulled.payload.topic.existingLocalTopics.map((t) => t.ref), ['late'])
    assert.deepEqual(pulled.payload.newMessages.map((m) => m.msgId), s.ids, 'it is still a todo message')
  } finally { s.close() }
})

test('pull falls back to todo-only when every target has meanwhile been decided', async () => {
  const s = scenario({ count: 1 })
  try {
    await s.feed()
    s.db.prepare("INSERT INTO topic_analysis_runs(run_id,chat_id,input_digest,prompt_version,prompt_hash,schema_version,schema_hash,state,created_at) VALUES('r-old',?,'digest-old','v','h','s','sh','complete','2026-11-03')").run(s.chatId)
    s.db.prepare("INSERT INTO topic_message_decisions(chat_id,msg_id,run_id,disposition) VALUES(?,?,'r-old','not_topic')").run(s.chatId, s.ids[0])
    const pulled = s.pull()
    assert.equal(pulled.payload.topic, undefined)
    assert.equal('topics' in pulled.item, false)
  } finally { s.close() }
})

// ───────────────────────── commit: success and half-success ─────────────────────────

test('both sides valid: one commit writes todo + topic, marks processed, records COMBINED versions, and reports topicChatIds', async () => {
  const s = scenario({ count: 4 })
  try {
    await s.feed()
    const pulled = s.pull()
    const result = commitOne(s, pulled.item, bothOk(pulled.payload))
    assert.equal(result.results[0].status, 'applied')
    assert.equal(count(s.db, 'SELECT COUNT(*) AS n FROM todos'), 1)
    assert.equal(processedCount(s.db), 4)
    assert.deepEqual(topicRows(s.db), { topics: 1, decisions: 4, evidence: 1 })
    const todoDecision = s.db.prepare('SELECT prompt_version,schema_version FROM todo_identity_decisions').get()
    assert.deepEqual(todoDecision, { prompt_version: COMBINED_PROMPT_VERSION, schema_version: COMBINED_SCHEMA_VERSION })
    const run = s.db.prepare('SELECT prompt_version,prompt_hash,schema_version,state FROM topic_analysis_runs').get()
    assert.deepEqual(run, { prompt_version: COMBINED_PROMPT_VERSION, prompt_hash: COMBINED_PROMPT_HASH, schema_version: COMBINED_SCHEMA_VERSION, state: 'complete' })
    assert.equal(s.runs.length, 1)
    assert.deepEqual(s.runs[0].topicChatIds, [s.chatId])
    assert.equal(s.db.prepare('SELECT active_lease_id FROM chat_context_cache WHERE chat_id=?').get(s.chatId).active_lease_id, null)
    assert.equal(s.queue.combinedStats().topicApplied, 1)
  } finally { s.close() }
})

test('a todo-only commit never reports topicChatIds', async () => {
  const s = scenario({ flag: false, count: 3 })
  try {
    await s.feed()
    const pulled = s.pull()
    const result = commitOne(s, pulled.item, todoPart(pulled.payload))
    assert.equal(result.results[0].status, 'applied')
    assert.equal(s.runs.length, 1)
    assert.equal('topicChatIds' in s.runs[0], false)
  } finally { s.close() }
})

test('todo ok + topic invalid: only the todo is applied (processed=1), the topic failure is recorded, the messages fall into set B and the failure counts toward degrade', async () => {
  const s = scenario({ count: 4 })
  try {
    await s.feed()
    const pulled = s.pull()
    const result = commitOne(s, pulled.item, { todo: todoPart(pulled.payload), topic: topicPart(pulled.payload, { drop: 1 }) })
    assert.equal(result.results[0].status, 'applied')
    assert.equal(count(s.db, 'SELECT COUNT(*) AS n FROM todos'), 1)
    assert.equal(processedCount(s.db), 4)
    assert.deepEqual(topicRows(s.db), { topics: 0, decisions: 0, evidence: 0 })
    const failed = s.db.prepare("SELECT state,failure_stage,failure_reason FROM topic_analysis_runs").get()
    assert.deepEqual(failed, { state: 'failed', failure_stage: 'domain_validate', failure_reason: 'missing_assignment' })
    assert.equal(loadPendingMessages(s.db, s.chatId, 20, 100, { processedFilter: 'processed' }).length, 4, 'now set B')
    assert.equal(loadPendingMessages(s.db, s.chatId, 20, 100, { processedFilter: 'unprocessed' }).length, 0, 'and no longer set A')
    assert.equal(s.runs[0].topicChatIds, undefined)
    assert.equal(s.queue.combinedStats().topicFailed, 1)
  } finally { s.close() }
})

test('todo invalid + topic ok: the topic is written, processed stays 0, the todo goes down the existing failure path (backoff), the next pull is todo-only', async () => {
  const s = scenario({ count: 3 })
  try {
    await s.feed()
    const pulled = s.pull()
    const result = commitOne(s, pulled.item, { todo: { importance: 'nope' }, topic: topicPart(pulled.payload) })
    assert.equal(result.results[0].status, 'rejected')
    assert.equal(result.results[0].code, 'invalid_result')
    assert.ok(result.results[0].retryInMs > 0)
    assert.equal(count(s.db, 'SELECT COUNT(*) AS n FROM todos'), 0)
    assert.equal(processedCount(s.db), 0)
    assert.deepEqual(topicRows(s.db), { topics: 1, decisions: 3, evidence: 1 })
    assert.deepEqual(s.runs[0].topicChatIds, [s.chatId])
    assert.equal(s.queue.stats().pending, 1, 'the part waits for its backoff')
    assert.equal(s.pull(), null, 'backing off')
    s.state.ms += result.results[0].retryInMs + 1
    const retry = s.pull()
    assert.ok(retry)
    assert.equal(retry.payload.topic, undefined, 'the decided messages are no longer targets: plain todo part')
    assert.equal('topics' in retry.item, false)
    const second = commitOne(s, retry.item, todoPart(retry.payload))
    assert.equal(second.results[0].status, 'applied')
    assert.equal(processedCount(s.db), 3)
    assert.equal(s.queue.combinedStats().todoFailedTopicApplied, 1)
  } finally { s.close() }
})

test('both sides invalid: nothing is written and the chat backs off', async () => {
  const s = scenario({ count: 3 })
  try {
    await s.feed()
    const pulled = s.pull()
    const result = commitOne(s, pulled.item, { todo: { importance: 'nope' }, topic: { topics: 'x' } })
    assert.equal(result.results[0].status, 'rejected')
    assert.equal(count(s.db, 'SELECT COUNT(*) AS n FROM todos'), 0)
    assert.equal(processedCount(s.db), 0)
    assert.deepEqual(topicRows(s.db), { topics: 0, decisions: 0, evidence: 0 })
    assert.ok(result.results[0].retryInMs > 0)
    assert.equal(s.queue.stats().chatsBackingOff, 1)
  } finally { s.close() }
})

test('the model drops the wrapper (flat todo): the todo is applied, the topic counts as absent and as a failure; the messages fall into set B', async () => {
  const s = scenario({ count: 3 })
  try {
    await s.feed()
    const pulled = s.pull()
    const result = commitOne(s, pulled.item, todoPart(pulled.payload))
    assert.equal(result.results[0].status, 'applied')
    assert.equal(processedCount(s.db), 3)
    assert.deepEqual(topicRows(s.db), { topics: 0, decisions: 0, evidence: 0 })
    assert.equal(s.queue.combinedStats().topicAbsent, 1)
    assert.equal(s.queue.combinedStats().topicFailed, 1)
  } finally { s.close() }
})

test('a changed source row rejects the whole package: neither side is written and processed stays 0', async () => {
  const s = scenario({ count: 3 })
  try {
    await s.feed()
    const pulled = s.pull()
    s.db.prepare('UPDATE messages SET text=? WHERE msg_id=?').run('同一則訊息被改寫成別的內容了', s.ids[1])
    const result = commitOne(s, pulled.item, bothOk(pulled.payload))
    assert.equal(result.results[0].status, 'apply_failed')
    assert.equal(count(s.db, 'SELECT COUNT(*) AS n FROM todos'), 0)
    assert.equal(processedCount(s.db), 0)
    assert.deepEqual(topicRows(s.db), { topics: 0, decisions: 0, evidence: 0 })
  } finally { s.close() }
})

test('a topic body that throws is discarded in its savepoint: the todo is kept and processed=1, no half-written topic rows remain', async () => {
  const s = scenario({ count: 3 })
  try {
    await s.feed()
    const pulled = s.pull()
    s.db.exec("CREATE TRIGGER fail_topic_decision BEFORE INSERT ON topic_message_decisions BEGIN SELECT RAISE(ABORT,'fixture_topic_failure'); END;")
    const result = commitOne(s, pulled.item, bothOk(pulled.payload))
    assert.equal(result.results[0].status, 'applied')
    assert.equal(count(s.db, 'SELECT COUNT(*) AS n FROM todos'), 1)
    assert.equal(processedCount(s.db), 3)
    assert.deepEqual(topicRows(s.db), { topics: 0, decisions: 0, evidence: 0 }, 'the savepoint rolled back the topic and its run row')
    assert.equal(count(s.db, "SELECT COUNT(*) AS n FROM topic_analysis_runs WHERE state='complete'"), 0)
    assert.equal(count(s.db, "SELECT COUNT(*) AS n FROM topic_analysis_runs WHERE state='failed' AND failure_stage='persist'"), 1)
    assert.equal(s.queue.combinedStats().topicDiscarded, 1)
    assert.equal(s.runs[0].topicChatIds, undefined)
  } finally { s.close() }
})

test('a todo body that throws rejects the whole package: the topic is not written either', async () => {
  const s = scenario({ count: 3 })
  try {
    await s.feed()
    const pulled = s.pull()
    s.db.exec("CREATE TRIGGER fail_todo_decision BEFORE INSERT ON todo_identity_decisions BEGIN SELECT RAISE(ABORT,'fixture_todo_failure'); END;")
    const result = commitOne(s, pulled.item, bothOk(pulled.payload))
    assert.equal(result.results[0].status, 'apply_failed')
    assert.equal(count(s.db, 'SELECT COUNT(*) AS n FROM todos'), 0)
    assert.equal(processedCount(s.db), 0)
    assert.deepEqual(topicRows(s.db), { topics: 0, decisions: 0, evidence: 0 })
  } finally { s.close() }
})

// ───────────────────────── identity assertions up front ─────────────────────────

test('both sides update_existing in one commit succeeds (the snapshot assertions run before either body bumps a candidate revision)', async () => {
  const s = scenario({ count: 2, text: (i) => `alpha beta project kickoff schedule ${i}` })
  try {
    const todo = createTodo({ chatId: s.chatId, bucket: 'todo', status: 'pending', title: 'alpha beta project kickoff schedule task', detail: null, priority: 2, dueAt: null, confidence: 0.8, sourceMsgIds: [] }, s.db)
    s.db.prepare("INSERT INTO discussion_topics(topic_id,chat_id,local_ref,title,summary,created_at,last_source_ts,revision) VALUES('topic-existing',?,'kickoff','alpha beta project kickoff','kickoff discussion','2026-11-03',5000,1)").run(s.chatId)
    drainIndexes(s.db, s.chatId)
    await s.feed()
    const pulled = s.pull()
    const kinds = new Set(pulled.payload.historicalCandidates.map((c) => c.entityType))
    assert.deepEqual([...kinds].sort(), ['todo', 'topic'], 'precondition: both a todo and a topic candidate were recalled')
    const first = pulled.payload.newMessages[0].msgId
    const reply = {
      todo: {
        importance: 'action',
        newTodos: [{ draftRef: 'd1', bucket: 'todo', title: 'alpha beta project kickoff schedule task (updated)', detail: null, priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds: [first] }],
        identityDecisions: [{ draftRef: 'd1', outcome: 'update_existing', candidateType: 'todo', candidateId: todo.id, relationKind: null, reasonCode: 'same_active_action', confidenceBand: 'high', evidenceMsgIds: [first] }],
        resolved: [], updates: []
      },
      topic: {
        topics: [{ ref: 'kickoff', title: 'alpha beta project kickoff (updated)', summary: 'kickoff discussion continues' }],
        identityDecisions: [{ draftRef: 'kickoff', outcome: 'update_existing', candidateType: 'topic', candidateId: 'topic-existing', relationKind: null, reasonCode: 'same_active_action', confidenceBand: 'high', evidenceMsgIds: [first] }],
        assignments: pulled.payload.topic.targetMsgIds.map((msgId, index) => ({ msgId, topicRef: index === 0 ? 'kickoff' : null, relation: index === 0 ? 'about' : 'uncertain', confidence: 0.7, relevance: 'unknown', relevanceEvidenceMsgIds: [] }))
      }
    }
    const result = commitOne(s, pulled.item, reply)
    assert.equal(result.results[0].status, 'applied', JSON.stringify(result.results[0]))
    assert.equal(getOpenTodosByChat(s.chatId, s.db).length, 1)
    assert.equal(getOpenTodosByChat(s.chatId, s.db)[0].title, 'alpha beta project kickoff schedule task (updated)')
    assert.ok(s.db.prepare('SELECT revision FROM discussion_topics WHERE topic_id=?').get('topic-existing').revision > 1, 'the topic revision moved')
    assert.equal(s.db.prepare("SELECT title FROM discussion_topics WHERE topic_id='topic-existing'").get().title, 'alpha beta project kickoff (updated)')
    assert.equal(processedCount(s.db), 2)
    assert.equal(count(s.db, 'SELECT COUNT(*) AS n FROM discussion_topics'), 1, 'no new topic was created')
  } finally { s.close() }
})

test('a candidate revision that moved after the pull (todo changed by the user) rejects the whole package', async () => {
  const s = scenario({ count: 2, text: (i) => `alpha beta project kickoff schedule ${i}` })
  try {
    const todo = createTodo({ chatId: s.chatId, bucket: 'todo', status: 'pending', title: 'alpha beta project kickoff schedule task', detail: null, priority: 2, dueAt: null, confidence: 0.8, sourceMsgIds: [] }, s.db)
    drainIndexes(s.db, s.chatId)
    await s.feed()
    const pulled = s.pull()
    updateTodo(todo.id, { title: 'alpha beta project kickoff schedule task renamed by user' }, s.db)
    const result = commitOne(s, pulled.item, bothOk(pulled.payload))
    assert.notEqual(result.results[0].status, 'applied')
    assert.equal(count(s.db, 'SELECT COUNT(*) AS n FROM todo_identity_decisions'), 0)
    assert.deepEqual(topicRows(s.db), { topics: 0, decisions: 0, evidence: 0 })
    assert.equal(processedCount(s.db), 0)
  } finally { s.close() }
})

// ───────────────────────── degrade ─────────────────────────

function addRound(s, round) {
  addMessages(s.db, s.chatId, [[`r${round}a`, 50_000 + round * 100, `第 ${round} 輪：Orion 簡報進度確認`, 'in'], [`r${round}b`, 50_000 + round * 100 + 10, `第 ${round} 輪：時程也要一起看`, 'in']])
  drainIndexes(s.db, s.chatId)
}
async function roundWith(s, round, reply) {
  addRound(s, round)
  await s.feed()
  const pulled = s.pull()
  assert.ok(pulled, `round ${round} has a part`)
  return { pulled, result: commitOne(s, pulled.item, reply(pulled.payload)) }
}

test('auto-degrade: two consecutive topic failures switch the chat to todo-only for 30 minutes, then topics come back; one success resets the count', async () => {
  const s = scenario({ count: 1 })
  try {
    s.db.prepare('UPDATE messages SET processed=1').run()
    const bad = (payload) => ({ todo: todoPart(payload), topic: topicPart(payload, { drop: 1 }) })
    const good = (payload) => bothOk(payload)
    const r1 = await roundWith(s, 1, bad)
    assert.equal(r1.pulled.item.topics, true)
    assert.equal(s.queue.combinedStats().degradedChats, 0, 'one failure does not degrade')
    const r2 = await roundWith(s, 2, bad)
    assert.equal(r2.pulled.item.topics, true, 'the second attempt still carries a topic')
    assert.equal(s.queue.combinedStats().degradedChats, 1)
    assert.ok(s.logs.some(([event]) => event === 'combined_topic_degraded'))
    addRound(s, 3)
    await s.feed()
    const degraded = s.pull()
    assert.equal(degraded.payload.topic, undefined, 'degraded: todo-only')
    assert.equal('topics' in degraded.item, false)
    assert.ok(s.logs.some(([event, detail]) => event === 'combined_fallback_todo_only' && detail.reason === 'degraded'))
    commitOne(s, degraded.item, todoPart(degraded.payload))
    s.state.ms += COMBINED_DEGRADE_MS + 1
    const r4 = await roundWith(s, 4, good)
    assert.equal(r4.pulled.item.topics, true, 'after 30 minutes the topic is sent again')
    assert.equal(r4.result.results[0].status, 'applied')
    assert.equal(s.queue.combinedStats().degradedChats, 0)
    await roundWith(s, 5, bad)
    assert.equal(s.queue.combinedStats().degradedChats, 0, 'a success in between reset the consecutive count')
  } finally { s.close() }
})

test('a system_too_large failure on a topics part degrades the chat immediately (the host limit is lower than assumed)', async () => {
  const s = scenario({ count: 3 })
  try {
    await s.feed()
    const pulled = s.pull()
    const failed = s.queue.commit({ results: [{ itemId: pulled.item.itemId, ok: false, failCode: 'system_too_large' }] })
    assert.equal(failed.results[0].status, 'failed_recorded')
    assert.equal(s.queue.combinedStats().degradedChats, 1)
    s.state.ms += failed.results[0].retryInMs + 1
    const retry = s.pull()
    assert.equal(retry.payload.topic, undefined)
    assert.equal('topics' in retry.item, false)
  } finally { s.close() }
})

test('systemFits guard: when the topics system would not fit the host limit the chat stays todo-only and one diagnostic is logged', async () => {
  const s = scenario({ count: 3, fits: false })
  try {
    await s.feed()
    const pulled = s.pull()
    assert.equal(pulled.payload.topic, undefined)
    assert.equal('topics' in pulled.item, false)
    const events = s.logs.filter(([event]) => event === 'combined_fallback_todo_only')
    assert.equal(events.length, 1)
    assert.deepEqual(events[0][1], { chatId: s.chatId, reason: 'system_too_large' })
    assert.ok(s.queue.combinedStats().fallbackSystemTooLarge >= 1)
  } finally { s.close() }
})

test('systemFits formula: the default fits; a max-length prompt with the worst name does not (the exact check assemble.ts wires)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'line-todo-fits-'))
  try {
    const prompts = createPromptService(createSettingsStore({ userDataDir: dir, secrets: noSecrets }), { complete: async () => { throw new Error('unused') } })
    const fits = (chatId) => prompts.extractSystem(chatId, { topics: true }).length <= AI_CHAT_REFERENCE.systemChars
    assert.equal(fits('c'), true)
    prompts.save('x'.repeat(PROMPT_MAX_CHARS), prompts.state().revision)
    prompts.saveName('"'.repeat(MY_NAME_MAX_CHARS), prompts.state().nameRevision)
    assert.equal(fits('c'), false)
    assert.ok(prompts.extractSystem('c').length <= AI_CHAT_REFERENCE.systemChars, 'the plain system still fits, so the fallback is always sendable')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ───────────────────────── set A / set B ─────────────────────────

function fakeProvider(seen) {
  return {
    id: 'http', kind: 'http', health: async () => ({ ok: true, summary: 'x', details: {} }),
    complete: async (request) => {
      const payload = JSON.parse(request.user)
      seen.push(payload.messages.map((m) => m.msgId))
      return {
        text: '', structured: { topics: [], identityDecisions: [], assignments: payload.messages.map((m) => ({ msgId: m.msgId, topicRef: null, relation: 'uncertain', confidence: 0.2, relevance: 'unknown', relevanceEvidenceMsgIds: [] })) },
        meta: { provider: 'http', model: 'fixture', durationMs: 0 }
      }
    }
  }
}

test('set A and set B are disjoint: with the flag ON, analyze only takes processed=1 messages, backlogCount is the real set-B size, and the combined targets are all processed=0', async () => {
  const s = scenario({ count: 8, text: (i) => `A組訊息${i} 還沒整理` })
  try {
    const b = addMessages(s.db, s.chatId, Array.from({ length: 30 }, (_, i) => [`b${i + 1}`, 1_000 + i * 10, `B組舊訊息${i + 1} 已整理過`, 'in']))
    s.db.prepare(`UPDATE messages SET processed=1 WHERE msg_id IN (${b.map(() => '?').join(',')})`).run(...b)
    drainIndexes(s.db, s.chatId)
    const on = createGroupTopicsService(s.db, { isCombinedActive: () => true })
    const off = createGroupTopicsService(s.db)
    const row = (service) => service.overview().find((entry) => entry.chatId === s.chatId)
    assert.equal(row(on).backlogCount, 30, 'real set-B count, not capped at the 20-message batch')
    assert.equal(row(off).backlogCount, row(off).pendingCount, 'flag OFF keeps backlogCount == pendingCount')
    assert.equal(on.pendingCount(s.chatId), 30, 'the per-chat pending count reads set B too')
    await s.feed()
    const pulled = s.pull()
    assert.ok(pulled.payload.topic.targetMsgIds.every((id) => s.ids.includes(id)), 'combined targets come from set A only')
    assert.ok(!pulled.payload.topic.targetMsgIds.some((id) => b.includes(id)))
    const seenOn = []
    s.queue.release({ itemIds: [pulled.item.itemId] })
    const analyzed = await on.analyze(s.chatId, () => fakeProvider(seenOn))
    assert.equal(analyzed.ok, true, JSON.stringify(analyzed))
    assert.deepEqual(seenOn.length, 1)
    assert.equal(seenOn[0].length, GROUP_TOPICS_BATCH_SIZE)
    assert.ok(seenOn[0].every((id) => b.includes(id)), 'analyze only sent set B')
    assert.ok(!seenOn[0].some((id) => s.ids.includes(id)))
    assert.equal(row(on).backlogCount, 10, 'ten set-B messages are left')
    assert.deepEqual(pulled.payload.topic.targetMsgIds.filter((id) => seenOn[0].includes(id)), [], 'A and B never overlap')
  } finally { s.close() }
})

test('flag OFF analyze still takes the legacy pending set (processed or not)', async () => {
  const s = scenario({ count: 3 })
  try {
    const seen = []
    const off = createGroupTopicsService(s.db, { isCombinedActive: () => false })
    await off.analyze(s.chatId, () => fakeProvider(seen))
    assert.deepEqual(seen[0].sort(), [...s.ids].sort())
  } finally { s.close() }
})

// ───────────────────────── worker wiring ─────────────────────────

function fakePort(replyFor) {
  const calls = []
  return {
    calls,
    ready: async () => true,
    blockedFor: () => 0,
    complete: async (request) => {
      calls.push(request)
      const checked = request.validate(replyFor(JSON.parse(request.user), request))
      if (!checked.ok) { const { AiPortError } = await import('../../src/core/aiPort.ts'); throw new AiPortError('invalid_result') }
      return { text: JSON.stringify(checked.value), value: checked.value, model: 'fixture' }
    }
  }
}

test('worker: a topics item is answered with system(chatId,{topics:true}) and validated as an envelope; a plain item uses system(chatId) with exactly one argument', async () => {
  const s = scenario({ count: 3 })
  try {
    const systemCalls = []
    const port = fakePort((payload) => payload.topic ? bothOk(payload) : todoPart(payload))
    const worker = createExtractWorker({ queue: s.queue, port, system: (...args) => { systemCalls.push(args); return 'SYSTEM ' + JSON.stringify(args.slice(1)) }, config: { pollIntervalMs: 60_000 } })
    await s.feed()
    worker.start()
    await worker.idle()
    worker.stop()
    assert.equal(worker.counters().extracted, 1)
    assert.deepEqual(systemCalls, [[s.chatId, { topics: true }]])
    assert.equal(port.calls[0].system, 'SYSTEM [{"topics":true}]')
    assert.equal(processedCount(s.db), 3)
    assert.equal(topicRows(s.db).decisions, 3)
    assert.equal(port.calls[0].validate({}).ok, false, 'an empty object is neither envelope nor todo')
    assert.equal(port.calls[0].validate({ todo: { importance: 'noise', newTodos: [], identityDecisions: [], resolved: [], updates: [] }, topic: null }).ok, true)

    systemCalls.length = 0
    s.state.flag = false
    addMessages(s.db, s.chatId, [['plain1', 90_000, '之後的訊息 Orion 簡報確認', 'in']])
    drainIndexes(s.db, s.chatId)
    await s.feed()
    const worker2 = createExtractWorker({ queue: s.queue, port, system: (...args) => { systemCalls.push(args); return 'PLAIN' }, config: { pollIntervalMs: 60_000 } })
    worker2.start()
    await worker2.idle()
    worker2.stop()
    assert.deepEqual(systemCalls, [[s.chatId]], 'a plain item calls system with the chat id only')
    assert.equal(port.calls.at(-1).validate({}).ok, false)
  } finally { s.close() }
})

// ───────────────────────── settings ─────────────────────────

test('settings: pluginCombinedExtract defaults to ON, persists a boolean, and an old settings.json without the field (an upgrade) is ON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'line-todo-settings-'))
  try {
    const fresh = createSettingsStore({ userDataDir: dir, secrets: noSecrets })
    const initial = fresh.get().pluginCombinedExtract
    assert.equal(DEFAULT_COMBINED_EXTRACT, true)
    assert.equal(initial, true, 'a fresh install is ON')
    fresh.update({ pluginCombinedExtract: !initial })
    assert.equal(fresh.get().pluginCombinedExtract, !initial)
    const reread = createSettingsStore({ userDataDir: dir, secrets: noSecrets })
    assert.equal(reread.get().pluginCombinedExtract, !initial, 'persisted')
    fresh.update({ pollIntervalSec: 30 })
    assert.equal(fresh.get().pluginCombinedExtract, !initial, 'an unrelated patch does not wash the flag back to the default')
    const oldDir = mkdtempSync(join(tmpdir(), 'line-todo-settings-old-'))
    try {
      writeFileSync(join(oldDir, 'settings.json'), JSON.stringify({ pollIntervalSec: 45, aiProvider: 'http' }))
      const old = createSettingsStore({ userDataDir: oldDir, secrets: noSecrets })
      assert.equal(old.get().pluginCombinedExtract, true, 'missing field -> ON (an upgraded install)')
      writeFileSync(join(oldDir, 'settings.json'), JSON.stringify({ pluginCombinedExtract: 'yes' }))
      assert.equal(createSettingsStore({ userDataDir: oldDir, secrets: noSecrets }).get().pluginCombinedExtract, true, 'a non-boolean is ignored')
      writeFileSync(join(oldDir, 'settings.json'), JSON.stringify({ pluginCombinedExtract: false }))
      assert.equal(createSettingsStore({ userDataDir: oldDir, secrets: noSecrets }).get().pluginCombinedExtract, false, 'an explicit OFF survives')
    } finally { rmSync(oldDir, { recursive: true, force: true }) }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ───────────────────────── measurements ─────────────────────────

test('measurement: size of a realistic maximal combined reply (20 targets) and the diagnostic counters it feeds', async () => {
  const s = scenario({ count: 20, text: (i) => `事項${i}：Orion 簡報與時程的討論內容，需要大家確認` })
  try {
    await s.feed()
    const pulled = s.pull()
    assert.equal(pulled.payload.topic.targetMsgIds.length, 20)
    const targets = pulled.payload.topic.targetMsgIds
    const topics = Array.from({ length: 6 }, (_, i) => ({ ref: `topic-${i}`, title: `議題 ${i}：專案進度追蹤與時程確認`, summary: '這個議題討論專案的進度、簡報內容與時程安排，目前尚未有結論，需要後續追蹤。' }))
    const reply = {
      todo: todoPart(pulled.payload),
      topic: {
        topics,
        identityDecisions: topics.map((topic, i) => ({ ...decisionNew(topic.ref, targets[i]) })),
        assignments: targets.map((msgId, i) => ({ msgId, topicRef: topics[i % topics.length].ref, relation: 'about', confidence: 0.75, relevance: 'unknown', relevanceEvidenceMsgIds: [] }))
      }
    }
    const result = commitOne(s, pulled.item, reply)
    assert.equal(result.results[0].status, 'applied', JSON.stringify(result.results[0]))
    const stats = s.queue.combinedStats()
    console.log('COMBINED_REPLY_CHARS ' + JSON.stringify({ replyChars: stats.replyChars, targets: 20, topics: 6, userChars: pulled.item.userChars }))
    assert.ok(stats.replyChars > 0 && stats.replyChars === stats.replyCharsMax)
    assert.equal(stats.decisions, 6)
    assert.equal(stats.deferDecisions, 0)
    const logged = s.logs.filter(([event]) => event === 'combined_commit')
    assert.equal(logged.length, 1)
    assert.deepEqual({ topic: logged[0][1].topic, todo: logged[0][1].todo, targets: logged[0][1].targets, decisions: logged[0][1].decisions, deferDecisions: logged[0][1].deferDecisions }, { topic: 'applied', todo: true, targets: 20, decisions: 6, deferDecisions: 0 })
    assert.equal(JSON.stringify(logged[0][1]).includes('Orion'), false, 'the diagnostic carries counters only, never message text')
  } finally { s.close() }
})

test('measurement: defer decisions are counted per topic identity decision (the diagnostic for R5)', async () => {
  const s = scenario({ count: 4 })
  try {
    await s.feed()
    const pulled = s.pull()
    const targets = pulled.payload.topic.targetMsgIds
    const topic = topicPart(pulled.payload)
    topic.identityDecisions = [{ ...decisionNew('orion', targets[0]), outcome: 'defer', reasonCode: 'ambiguous_candidates' }]
    commitOne(s, pulled.item, { todo: todoPart(pulled.payload), topic })
    const stats = s.queue.combinedStats()
    assert.equal(stats.decisions, 1)
    assert.equal(stats.deferDecisions, 1)
  } finally { s.close() }
})

test('front-loaded assertions: a todo or topic candidate whose revision moved (identity counters untouched) rejects the whole package even when the reply does not reference it', async () => {
  for (const moved of ['todo', 'topic']) {
    const s = scenario({ count: 2, text: (i) => `alpha beta project kickoff schedule ${i}` })
    try {
      const todo = createTodo({ chatId: s.chatId, bucket: 'todo', status: 'pending', title: 'alpha beta project kickoff schedule task', detail: null, priority: 2, dueAt: null, confidence: 0.8, sourceMsgIds: [] }, s.db)
      s.db.prepare("INSERT INTO discussion_topics(topic_id,chat_id,local_ref,title,summary,created_at,last_source_ts,revision) VALUES('topic-existing',?,'kickoff','alpha beta project kickoff','kickoff discussion','2026-11-03',5000,1)").run(s.chatId)
      drainIndexes(s.db, s.chatId)
      await s.feed()
      const pulled = s.pull()
      assert.deepEqual([...new Set(pulled.payload.historicalCandidates.map((c) => c.entityType))].sort(), ['todo', 'topic'])
      if (moved === 'todo') s.db.prepare('UPDATE todos SET entity_revision=entity_revision+1 WHERE id=?').run(todo.id)
      else s.db.prepare("UPDATE discussion_topics SET revision=revision+1 WHERE topic_id='topic-existing'").run()
      const result = commitOne(s, pulled.item, bothOk(pulled.payload))
      assert.equal(result.results[0].status, 'apply_failed', `${moved}: ${JSON.stringify(result.results[0])}`)
      assert.match(result.results[0].issues[0], /identity_candidate_revision_stale/)
      assert.equal(count(s.db, 'SELECT COUNT(*) AS n FROM todo_identity_decisions'), 0)
      assert.deepEqual(topicRows(s.db), { topics: 1, decisions: 0, evidence: 0 }, 'only the pre-existing topic row')
      assert.equal(processedCount(s.db), 0)
    } finally { s.close() }
  }
})
