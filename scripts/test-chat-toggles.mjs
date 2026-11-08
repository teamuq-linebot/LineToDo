// 聊天室「待辦／議題」兩個獨立開關（2026-11-07）：待辦開關資料層、閘門、佇列、議題背景驅動器、一對一議題、跨群停用。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { SCHEMA_VERSION } from '../src/main/db/schema.ts'
import { getUnprocessedForPipeline, insertMessages } from '../src/main/db/messages.repo.ts'
import { readChatSourceState } from '../src/main/db/sourceCache.ts'
import { createTodo } from '../src/main/db/todos.repo.ts'
import { listChats } from '../src/main/db/chats.repo.ts'
import { TODO_BACKFILL_DAYS, chatTodoPrefsReady, ensureChatTodoPrefsSchema, isTodoExtractEnabled, migrateIgnoredChats, setTodoExtractEnabled } from '../src/main/db/chatTodoPrefs.repo.ts'
import { applyChatExtract, runOnce } from '../src/main/pipeline/runOnce.ts'
import { reviewLastDays } from '../src/main/pipeline/backfill.ts'
import { getPipelineDefaults } from '../src/main/config/defaults.ts'
import { ensureGroupTopicsSchema, loadPendingMessages, setEnabled } from '../src/main/features/groupTopics/repository.ts'
import { createGroupTopicsService } from '../src/main/features/groupTopics/service.ts'
import { createTopicBackground } from '../src/main/features/groupTopics/background.ts'
import { GROUP_TOPICS_PROMPT } from '../src/main/features/groupTopics/prompts/bundle.ts'
import { ExtractQueue } from '../src/plugin/backend/extractQueue.ts'
import { createPortAiProvider } from '../src/plugin/backend/aiProvider.ts'
import { SUPPORTED_API_PATHS } from '../src/plugin/backend/dispatcher.ts'
import { isReplaySafePath } from '../src/renderer/platform/pluginTransport.ts'
import { NOW_MS, captureOffBaseline, drainIndexes, feedQueue, openFixture, stored } from './plugin/combined-queue-harness.mjs'

const DAY = 86_400_000
const NOISE = { importance: 'noise', newTodos: [], identityDecisions: [], resolved: [], updates: [] }

function raw(id, chatId, ts, text, isGroup = true, direction = 'in') {
  return { msgId: id, chat: `Chat ${chatId}`, chatId, isGroup, ts, time: new Date(ts).toISOString().slice(0, 19), direction, sender: 'Alice', text, contentType: 0 }
}

function addMsgs(db, chatId, items, isGroup = true) {
  insertMessages(items.map(([id, ts, text, direction]) => raw(id, chatId, ts, text, isGroup, direction)), db)
  return items.map(([id]) => stored(id))
}

function fixture({ prefs = true } = {}) {
  const opened = openFixture()
  if (prefs) ensureChatTodoPrefsSchema(opened.db)
  return opened
}

const n = (db, sql, ...params) => db.prepare(sql).get(...params).n
const processedOf = (db, id) => db.prepare('SELECT processed FROM messages WHERE msg_id=?').get(id).processed
const scopeOf = (db, chatId) => readChatSourceState(db, chatId).scopeRevision
const pipelineIds = (db, limit = 100) => getUnprocessedForPipeline(limit, db).map((row) => row.msgId).sort()

// ───────────────────────── 資料層 ─────────────────────────

test('T1 ensureChatTodoPrefsSchema is repeatable, a chat without a row is enabled, user_version stays at the current version (10)', () => {
  const { db, close } = fixture({ prefs: false })
  try {
    addMsgs(db, 'g1', [['m1', NOW_MS - 1000, 'hello']])
    assert.equal(chatTodoPrefsReady(db), false)
    assert.equal(isTodoExtractEnabled(db, 'g1'), true, 'table missing counts as enabled')
    ensureChatTodoPrefsSchema(db)
    ensureChatTodoPrefsSchema(db)
    assert.equal(chatTodoPrefsReady(db), true)
    assert.equal(isTodoExtractEnabled(db, 'g1'), true)
    assert.equal(isTodoExtractEnabled(db, 'never-seen'), true)
    assert.equal(db.pragma('user_version', { simple: true }), 10)
    assert.equal(SCHEMA_VERSION, 10)
    assert.equal(n(db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name='chat_todo_preferences'"), 1)
    assert.equal(TODO_BACKFILL_DAYS, 7)
  } finally { close() }
})

test('T2 an existing v8-shaped database without the table keeps its rows; ensure adds the table without touching them', () => {
  const { db, close } = fixture({ prefs: false })
  try {
    addMsgs(db, 'g1', [['m1', NOW_MS - 1000, 'alpha'], ['m2', NOW_MS - 2000, 'beta']])
    createTodo({ chatId: 'g1', bucket: 'todo', status: 'pending', title: '既有待辦', detail: null, priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds: [stored('m1')] }, db)
    assert.deepEqual(pipelineIds(db), [stored('m1'), stored('m2')], 'without the table the pipeline is ungated')
    const before = { chats: n(db, 'SELECT COUNT(*) AS n FROM chats'), messages: n(db, 'SELECT COUNT(*) AS n FROM messages'), todos: n(db, 'SELECT COUNT(*) AS n FROM todos') }
    assert.deepEqual(setTodoExtractEnabled(db, 'g1', false), { ok: false, enabled: true, skippedOlder: 0 }, 'no table: the setter refuses')
    ensureChatTodoPrefsSchema(db)
    assert.deepEqual({ chats: n(db, 'SELECT COUNT(*) AS n FROM chats'), messages: n(db, 'SELECT COUNT(*) AS n FROM messages'), todos: n(db, 'SELECT COUNT(*) AS n FROM todos') }, before)
    assert.equal(n(db, 'SELECT COUNT(*) AS n FROM chat_todo_preferences'), 0)
    assert.equal(db.pragma('user_version', { simple: true }), 10)
  } finally { close() }
})

test('T3 getUnprocessedForPipeline filters disabled chats in SQL so a large disabled chat cannot starve the limit', () => {
  const { db, close } = fixture()
  try {
    addMsgs(db, 'off', Array.from({ length: 10 }, (_, i) => [`o${i}`, NOW_MS - 100_000 + i, `off ${i}`]))
    addMsgs(db, 'on', [['n1', NOW_MS - 10, 'on 1'], ['n2', NOW_MS - 5, 'on 2']])
    assert.equal(setTodoExtractEnabled(db, 'off', false, NOW_MS).ok, true)
    assert.deepEqual(pipelineIds(db, 5), [stored('n1'), stored('n2')])
  } finally { close() }
})

test('T4 messages that arrive while a chat is disabled stay processed=0', () => {
  const { db, close } = fixture()
  try {
    addMsgs(db, 'off', [['o1', NOW_MS - 1000, 'before']])
    setTodoExtractEnabled(db, 'off', false, NOW_MS)
    addMsgs(db, 'off', [['o2', NOW_MS - 500, 'while disabled']])
    assert.equal(processedOf(db, stored('o2')), 0)
    assert.equal(processedOf(db, stored('o1')), 0)
    assert.deepEqual(pipelineIds(db), [])
  } finally { close() }
})

test('T5 re-enabling backfills the last 7 days only; older messages become processed=1 and are counted', () => {
  const { db, close } = fixture()
  try {
    addMsgs(db, 'off', [['m8', NOW_MS - 8 * DAY, '8d'], ['m7', NOW_MS - 7 * DAY, '7d boundary'], ['m6', NOW_MS - 6 * DAY, '6d'], ['m1', NOW_MS - 1 * DAY, '1d']])
    setTodoExtractEnabled(db, 'off', false, NOW_MS)
    const result = setTodoExtractEnabled(db, 'off', true, NOW_MS)
    assert.deepEqual(result, { ok: true, enabled: true, skippedOlder: 1 })
    assert.equal(processedOf(db, stored('m8')), 1)
    for (const id of ['m7', 'm6', 'm1']) assert.equal(processedOf(db, stored(id)), 0, id)
    assert.deepEqual(pipelineIds(db), [stored('m1'), stored('m6'), stored('m7')])
  } finally { close() }
})

test('T6 enabling a chat without a row is a no-op (no scope change); real changes bump the scope revision once', () => {
  const { db, close } = fixture()
  try {
    addMsgs(db, 'g1', [['m1', NOW_MS - 1000, 'hello']])
    const base = scopeOf(db, 'g1')
    assert.deepEqual(setTodoExtractEnabled(db, 'g1', true, NOW_MS), { ok: true, enabled: true, skippedOlder: 0 })
    assert.equal(n(db, 'SELECT COUNT(*) AS n FROM chat_todo_preferences'), 0, 'no row is written')
    assert.equal(scopeOf(db, 'g1'), base)
    assert.equal(setTodoExtractEnabled(db, 'g1', false, NOW_MS).enabled, false)
    assert.equal(scopeOf(db, 'g1'), base + 1)
    setTodoExtractEnabled(db, 'g1', false, NOW_MS)
    assert.equal(scopeOf(db, 'g1'), base + 1, 'disabling twice changes nothing')
    assert.equal(setTodoExtractEnabled(db, 'g1', true, NOW_MS).enabled, true)
    assert.equal(scopeOf(db, 'g1'), base + 2)
    assert.equal(isTodoExtractEnabled(db, 'g1'), true)
  } finally { close() }
})

test('T7 an unknown chat cannot be switched', () => {
  const { db, close } = fixture()
  try {
    addMsgs(db, 'g1', [['m1', NOW_MS - 1000, 'hello']])
    assert.deepEqual(setTodoExtractEnabled(db, 'missing', false, NOW_MS), { ok: false, enabled: true, skippedOlder: 0 })
    assert.equal(n(db, 'SELECT COUNT(*) AS n FROM chat_todo_preferences'), 0)
  } finally { close() }
})

const analysisFor = (ids) => ({
  topics: [{ ref: 'launch', title: 'Project Orion launch meeting', summary: 'Project Orion launch planning.' }],
  assignments: ids.map((msgId, i) => ({ msgId, topicRef: i === 0 ? 'launch' : null, relation: i === 0 ? 'about' : 'uncertain', confidence: i === 0 ? 0.8 : 0.2, relevance: 'unknown', relevanceEvidenceMsgIds: [] }))
})

function topicProvider(resultFor, capture = () => {}) {
  return {
    id: 'codexCli', kind: 'cli', health: async () => ({ ok: true, summary: 'fixture', details: {} }),
    complete: async (req) => {
      capture(req)
      const payload = JSON.parse(req.user)
      const messages = payload.messages ?? []
      const result = resultFor(payload)
      const withDecisions = {
        ...result,
        identityDecisions: result.identityDecisions ?? result.topics.map((topic) => ({
          draftRef: topic.ref, outcome: 'new', candidateType: null, candidateId: null, relationKind: null, reasonCode: 'insufficient_evidence', confidenceBand: 'high',
          evidenceMsgIds: [(result.assignments.find((a) => a.topicRef === topic.ref) ?? { msgId: messages[0]?.msgId }).msgId]
        }))
      }
      return { text: JSON.stringify(withDecisions), meta: { provider: 'codexCli', model: 'fixture', durationMs: 0 } }
    }
  }
}

const topicCounts = (db) => ({
  topics: n(db, 'SELECT COUNT(*) AS n FROM discussion_topics'),
  decisions: n(db, 'SELECT COUNT(*) AS n FROM topic_message_decisions'),
  evidence: n(db, 'SELECT COUNT(*) AS n FROM topic_evidence'),
  todos: n(db, 'SELECT COUNT(*) AS n FROM todos')
})

test('T8 toggling the todo switch never changes topics, decisions, evidence or todos', async () => {
  const { db, close } = fixture()
  try {
    ensureGroupTopicsSchema(db)
    const ids = addMsgs(db, 'g1', [['m1', NOW_MS - 2000, 'Project Orion launch meeting'], ['m2', NOW_MS - 1000, 'I will prepare the Orion launch deck']])
    createTodo({ chatId: 'g1', bucket: 'todo', status: 'pending', title: '既有待辦', detail: null, priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds: [ids[0]] }, db)
    setEnabled(db, 'g1', true)
    const service = createGroupTopicsService(db)
    const analysed = await service.analyze('g1', () => topicProvider(() => analysisFor(ids)))
    assert.equal(analysed.ok, true)
    const before = topicCounts(db)
    assert.ok(before.topics >= 1 && before.decisions >= 1 && before.todos === 1)
    setTodoExtractEnabled(db, 'g1', false, NOW_MS)
    assert.deepEqual(topicCounts(db), before)
    setTodoExtractEnabled(db, 'g1', true, NOW_MS)
    assert.deepEqual(topicCounts(db), before)
  } finally { close() }
})

test('T9 applyChatExtract refuses a disabled chat: no todo is created and nothing is marked processed', () => {
  const { db, close } = fixture()
  try {
    const ids = addMsgs(db, 'g1', [['m1', NOW_MS - 1000, '請準備簡報']])
    setTodoExtractEnabled(db, 'g1', false, NOW_MS)
    const tally = { todosCreated: 0, todosMerged: 0, todosResolvedDone: 0, todosSuggestedDone: 0, createdIds: [], resolvedIds: [], updatedIds: [] }
    assert.throws(() => applyChatExtract({ db, cfg: getPipelineDefaults(), now: new Date(NOW_MS).toISOString() }, 'g1', ids, NOISE, tally), /todo_extract_disabled/)
    assert.equal(processedOf(db, ids[0]), 0)
    assert.equal(n(db, 'SELECT COUNT(*) AS n FROM todos'), 0)
    setTodoExtractEnabled(db, 'g1', true, NOW_MS)
    applyChatExtract({ db, cfg: getPipelineDefaults(), now: new Date(NOW_MS).toISOString() }, 'g1', ids, NOISE, tally)
    assert.equal(processedOf(db, ids[0]), 1, 'the same call succeeds once the chat is enabled again')
  } finally { close() }
})

const markIgnored = (db, chatId, reason = 'manual') => db.prepare('UPDATE chats SET blocked=1, block_reason=? WHERE chat_id=?').run(reason, chatId)
const prefRow = (db, chatId) => db.prepare('SELECT extract_enabled AS e, updated_at AS u FROM chat_todo_preferences WHERE chat_id=?').get(chatId)
const chatRow = (db, chatId) => db.prepare('SELECT blocked, block_reason FROM chats WHERE chat_id=?').get(chatId)

test('T10 the one-time migration puts every previously ignored chat back in the list with both switches off, and leaves other chats alone', () => {
  const { db, close } = fixture()
  try {
    ensureGroupTopicsSchema(db)
    addMsgs(db, 'ign-manual', [['a1', NOW_MS - 1000, 'a']])
    addMsgs(db, 'ign-auto', [['b1', NOW_MS - 900, 'b']])
    addMsgs(db, 'normal', [['c1', NOW_MS - 800, 'c']])
    for (const id of ['ign-manual', 'ign-auto', 'normal']) setEnabled(db, id, true)
    markIgnored(db, 'ign-manual')
    markIgnored(db, 'ign-auto', 'auto:keyword:公告')
    assert.deepEqual(pipelineIds(db), [stored('a1'), stored('b1'), stored('c1')].sort(), 'before the migration the todo gate does not look at the ignore flag')
    assert.deepEqual(migrateIgnoredChats(db, NOW_MS), { migrated: 2 })
    for (const id of ['ign-manual', 'ign-auto']) {
      assert.deepEqual({ ...chatRow(db, id) }, { blocked: 0, block_reason: null }, id)
      assert.equal(prefRow(db, id).e, 0, id + ' todo switch off')
      assert.equal(isTodoExtractEnabled(db, id), false)
      assert.equal(n(db, 'SELECT enabled AS n FROM group_topic_preferences WHERE chat_id=?', id), 0, id + ' topics switch off')
    }
    assert.equal(prefRow(db, 'normal'), undefined, 'a chat that was never ignored gets no row')
    assert.equal(n(db, 'SELECT enabled AS n FROM group_topic_preferences WHERE chat_id=?', 'normal'), 1, 'its topics switch is untouched')
    assert.deepEqual(listChats(db).map((chat) => chat.chatId).sort(), ['ign-auto', 'ign-manual', 'normal'])
    assert.deepEqual(pipelineIds(db), [stored('c1')], 'only the never-ignored chat is still extracted')
  } finally { close() }
})

test('T10b the migration is one transaction: a failure while clearing the flag leaves no switch written and the flag intact', () => {
  const { db, close } = fixture()
  try {
    addMsgs(db, 'g1', [['m1', NOW_MS - 1000, 'hello']])
    markIgnored(db, 'g1')
    db.exec("CREATE TRIGGER t_abort BEFORE UPDATE OF blocked ON chats BEGIN SELECT RAISE(ABORT, 'synthetic'); END")
    assert.throws(() => migrateIgnoredChats(db, NOW_MS), /synthetic/)
    assert.equal(n(db, 'SELECT COUNT(*) AS n FROM chat_todo_preferences'), 0, 'the switch write was rolled back')
    assert.equal(chatRow(db, 'g1').blocked, 1)
    db.exec('DROP TRIGGER t_abort')
    assert.deepEqual(migrateIgnoredChats(db, NOW_MS), { migrated: 1 }, 'a retry after the failure completes')
    assert.equal(prefRow(db, 'g1').e, 0)
  } finally { close() }
})

test('T11 the migration is idempotent and never overrides a switch the user changes afterwards', () => {
  const { db, close } = fixture()
  try {
    ensureGroupTopicsSchema(db)
    addMsgs(db, 'g1', [['m1', NOW_MS - 1000, 'hello']])
    setEnabled(db, 'g1', true)
    markIgnored(db, 'g1')
    assert.deepEqual(migrateIgnoredChats(db, NOW_MS), { migrated: 1 })
    const first = { ...prefRow(db, 'g1') }
    assert.deepEqual(migrateIgnoredChats(db, NOW_MS + 5000), { migrated: 0 })
    assert.deepEqual({ ...prefRow(db, 'g1') }, first, 'a second run changes nothing, not even updated_at')
    assert.equal(setTodoExtractEnabled(db, 'g1', true, NOW_MS + 6000).ok, true, 'the chat is switchable like any other')
    setEnabled(db, 'g1', true)
    assert.deepEqual(migrateIgnoredChats(db, NOW_MS + 7000), { migrated: 0 })
    assert.equal(isTodoExtractEnabled(db, 'g1'), true, 'the user choice survives another run')
    assert.equal(n(db, 'SELECT enabled AS n FROM group_topic_preferences WHERE chat_id=?', 'g1'), 1)
  } finally { close() }
})

test('T12 without the todo preference table the migration does nothing at all: the flag stays, no table is created', () => {
  const { db, close } = fixture({ prefs: false })
  try {
    addMsgs(db, 'g1', [['m1', NOW_MS - 1000, 'hello']])
    markIgnored(db, 'g1')
    assert.deepEqual(migrateIgnoredChats(db, NOW_MS), { migrated: 0, skipped: 'prefs_unavailable' })
    assert.equal(chatRow(db, 'g1').blocked, 1)
    assert.equal(chatTodoPrefsReady(db), false)
    assert.equal(n(db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name='chat_todo_preferences'"), 0)
    ensureChatTodoPrefsSchema(db)
    assert.deepEqual(migrateIgnoredChats(db, NOW_MS), { migrated: 1 }, 'a later start with a ready table migrates')
  } finally { close() }
})

test('T13 after the migration nothing is extracted for the chat, old and new messages stay unprocessed, and switching on backfills only the last 7 days', async () => {
  const { db, close } = fixture()
  try {
    addMsgs(db, 'ign', [['old', NOW_MS - 8 * DAY, '8d'], ['mid', NOW_MS - 3 * DAY, '3d']])
    addMsgs(db, 'ok', [['k1', NOW_MS - 1000, 'ok chat']])
    markIgnored(db, 'ign')
    migrateIgnoredChats(db, NOW_MS)
    const calls = []
    const watch = { messages: [raw('fresh', 'ign', NOW_MS - 500, '遷移後的新訊息')], bridge: 'ok' }
    await runOnce({ db, now: () => new Date(NOW_MS).toISOString(), watchSource: async () => watch, extractFn: async (input) => { calls.push(input.chat.chatId); return NOISE } })
    assert.deepEqual(calls, ['ok'])
    for (const id of ['old', 'mid', 'fresh']) assert.equal(processedOf(db, stored(id)), 0, id)
    assert.deepEqual(setTodoExtractEnabled(db, 'ign', true, NOW_MS), { ok: true, enabled: true, skippedOlder: 1 })
    assert.equal(processedOf(db, stored('old')), 1)
    assert.equal(processedOf(db, stored('mid')), 0)
    assert.deepEqual(pipelineIds(db), [stored('fresh'), stored('mid')].sort())
  } finally { close() }
})

test('T14 a database without the topic preference table migrates the todo switch and does not fail', () => {
  const { db, close } = fixture()
  try {
    addMsgs(db, 'g1', [['m1', NOW_MS - 1000, 'hello']])
    markIgnored(db, 'g1')
    assert.equal(n(db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name='group_topic_preferences'"), 0)
    assert.deepEqual(migrateIgnoredChats(db, NOW_MS), { migrated: 1 })
    assert.equal(prefRow(db, 'g1').e, 0)
    assert.equal(chatRow(db, 'g1').blocked, 0)
  } finally { close() }
})

test('runOnce no longer blocks a chat by its name: a 公告 chat stays in the list and is extracted', async () => {
  const { db, close } = fixture()
  try {
    const calls = []
    const message = { ...raw('ann1', 'announce', NOW_MS - 1000, '本週六社區大會，請準時出席'), chat: '社區公告群' }
    await runOnce({ db, now: () => new Date(NOW_MS).toISOString(), watchSource: async () => ({ messages: [message], bridge: 'ok' }), extractFn: async (input) => { calls.push(input.chat.chatId); return NOISE } })
    assert.deepEqual({ ...chatRow(db, 'announce') }, { blocked: 0, block_reason: null })
    assert.deepEqual(calls, ['announce'])
    assert.equal(processedOf(db, stored('ann1')), 1)
  } finally { close() }
})

test('runOnce never calls the extractor for a disabled chat but still serves enabled ones', async () => {
  const { db, close } = fixture()
  try {
    addMsgs(db, 'off', [['o1', NOW_MS - 1000, '關閉的聊天室訊息']])
    addMsgs(db, 'on', [['n1', NOW_MS - 900, '開啟的聊天室訊息']])
    setTodoExtractEnabled(db, 'off', false, NOW_MS)
    const calls = []
    const result = await runOnce({ db, now: () => new Date(NOW_MS).toISOString(), watchSource: async () => ({ messages: [], bridge: 'ok' }), extractFn: async (input) => { calls.push(input.chat.chatId); return NOISE } })
    assert.deepEqual(calls, ['on'])
    assert.ok(result.chatsProcessed >= 1)
    assert.equal(processedOf(db, stored('o1')), 0)
    assert.equal(processedOf(db, stored('n1')), 1)
  } finally { close() }
})

test('backfill (reviewLastDays) never calls the extractor for a disabled chat', async () => {
  const { db, close } = fixture()
  try {
    addMsgs(db, 'off', [['seed', NOW_MS - 3 * DAY, 'seed']])
    addMsgs(db, 'on', [['seed2', NOW_MS - 3 * DAY, 'seed2']])
    setTodoExtractEnabled(db, 'off', false, NOW_MS)
    const calls = []
    const window = [raw('b-off', 'off', NOW_MS - 1000, '關閉的聊天室'), raw('b-on', 'on', NOW_MS - 900, '開啟的聊天室')]
    await reviewLastDays(1, { db, now: () => NOW_MS, fetchWindow: async () => ({ messages: window }), extractFn: async (input) => { calls.push(input.chat.chatId); return NOISE } })
    assert.deepEqual(calls, ['on'])
    assert.equal(processedOf(db, stored('b-off')), 0)
  } finally { close() }
})

// ───────────────────────── 佇列 ─────────────────────────

function queueScenario({ combined = false, chatId = 'g1', isGroup = true, count = 4 } = {}) {
  const opened = fixture()
  const { db } = opened
  const state = { ms: NOW_MS, flag: combined }
  const ids = addMsgs(db, chatId, Array.from({ length: count }, (_, i) => [`m${i + 1}`, NOW_MS - 10_000 + i * 10, `事項${i + 1}：專案 Orion 需要準備簡報並確認時程`, i % 5 === 4 ? 'out' : 'in']), isGroup)
  ensureGroupTopicsSchema(db)
  if (combined) setEnabled(db, chatId, true)
  drainIndexes(db, chatId)
  const queue = new ExtractQueue({
    db, getConfig: getPipelineDefaults, now: () => state.ms,
    ...(combined ? { combined: { enabled: () => state.flag, systemFits: () => true } } : {})
  })
  return {
    db, chatId, ids, queue, state,
    feed: () => feedQueue(db, queue),
    pull: () => { const item = queue.pull({ max: 1 }).items[0]; return item ? { item, payload: JSON.parse(item.user) } : null },
    close() { queue.dispose(); opened.close() }
  }
}

const decisionNew = (ref, evidence) => ({ draftRef: ref, outcome: 'new', candidateType: null, candidateId: null, relationKind: null, reasonCode: 'insufficient_evidence', confidenceBand: 'high', evidenceMsgIds: [evidence] })
const todoPart = (payload) => {
  const first = payload.newMessages[0].msgId
  return { importance: 'action', newTodos: [{ draftRef: 'd1', bucket: 'todo', title: '準備簡報', detail: null, priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds: [first] }], identityDecisions: [decisionNew('d1', first)], resolved: [], updates: [] }
}
const topicPart = (payload) => {
  const targets = payload.topic.targetMsgIds
  return {
    topics: [{ ref: 'orion', title: 'Project Orion', summary: '簡報與時程' }], identityDecisions: [decisionNew('orion', targets[0])],
    assignments: targets.map((msgId, index) => index === 0
      ? { msgId, topicRef: 'orion', relation: 'about', confidence: 0.8, relevance: 'unknown', relevanceEvidenceMsgIds: [] }
      : { msgId, topicRef: null, relation: 'uncertain', confidence: 0.2, relevance: 'unknown', relevanceEvidenceMsgIds: [] })
  }
}

for (const combined of [false, true]) {
  test(`Q1 (${combined ? 'combined' : 'plain'}) offer() of a disabled chat queues nothing and an already queued apply item is dropped at the next pull`, async () => {
    const t = queueScenario({ combined })
    try {
      await t.feed()
      setTodoExtractEnabled(t.db, t.chatId, false, NOW_MS)
      assert.equal(t.queue.pull({ max: 4 }).items.length, 0, 'the queued apply items are cleared by the next pull')
      assert.equal(n(t.db, 'SELECT COUNT(*) AS n FROM messages WHERE processed=1'), 0)

      const rows = t.db.prepare('SELECT msg_id FROM messages WHERE chat_id=?').all(t.chatId).map((row) => row.msg_id)
      const input = { chat: { chatId: t.chatId, name: 'Chat', isGroup: true }, newMessages: [], recentContext: [], openTodos: [], now: new Date(NOW_MS).toISOString() }
      t.queue.offer(input, rows)
      assert.equal(t.queue.pull({ max: 4 }).items.length, 0, 'offer() of a disabled chat adds nothing')
    } finally { t.close() }
  })
}

test('Q2 an item leased before the switch was turned off is rejected with todo_disabled: no todo, no backoff, processed stays 0', async () => {
  const s = queueScenario({ combined: true })
  try {
    await s.feed()
    const pulled = s.pull()
    assert.ok(pulled)
    assert.equal(pulled.item.topics, true)
    setTodoExtractEnabled(s.db, s.chatId, false, NOW_MS)
    const committed = s.queue.commit({ results: [{ itemId: pulled.item.itemId, ok: true, result: { todo: todoPart(pulled.payload), topic: topicPart(pulled.payload) } }] })
    assert.equal(committed.results[0].status, 'rejected')
    assert.equal(committed.results[0].code, 'todo_disabled')
    assert.equal(committed.results[0].retryInMs, undefined)
    assert.equal(n(s.db, 'SELECT COUNT(*) AS n FROM todos'), 0)
    assert.equal(n(s.db, 'SELECT COUNT(*) AS n FROM messages WHERE processed=1'), 0)
    assert.equal(n(s.db, 'SELECT COUNT(*) AS n FROM discussion_topics'), 0, 'the combined topic part is not applied either')
    assert.equal(n(s.db, 'SELECT COUNT(*) AS n FROM chat_context_cache WHERE active_lease_id IS NOT NULL'), 0, 'the source lease is released')
    setTodoExtractEnabled(s.db, s.chatId, true, NOW_MS)
    await s.feed()
    assert.ok(s.pull(), 'no backoff was recorded for the chat')
  } finally { s.close() }
})

test('Q3 with the preferences table present and nothing switched, the queue output is byte-identical to the 0.2.10 baseline', async () => {
  const baseline = JSON.parse(readFileSync(new URL('./plugin/fixtures/combined-off-baseline.json', import.meta.url), 'utf8'))
  const withTable = await captureOffBaseline({}, (db) => ensureChatTodoPrefsSchema(db))
  assert.deepEqual(withTable, baseline)
})

test('adapter: the new chat paths are served by the backend; only the read path is replay safe; the retired paths are gone', () => {
  for (const path of ['db.chats.todoExtractEnabled', 'db.chats.setTodoExtractEnabled']) assert.ok(SUPPORTED_API_PATHS.includes(path), path)
  assert.equal(isReplaySafePath('db.chats.todoExtractEnabled'), true)
  assert.equal(isReplaySafePath('db.chats.setTodoExtractEnabled'), false)
  for (const path of ['groupTopics.setCrossChatEnabled', 'groupTopics.crossChatEnabled', 'groupTopics.linkCandidates']) {
    assert.equal(SUPPORTED_API_PATHS.includes(path), false, path)
    assert.equal(isReplaySafePath(path), false, path)
  }
})

// ───────────────────────── 議題（待辦關閉時） ─────────────────────────

function topicOnlyChat({ isGroup = true, combinedActive = true } = {}) {
  const opened = fixture()
  const { db } = opened
  ensureGroupTopicsSchema(db)
  const ids = addMsgs(db, 'c1', [['m1', NOW_MS - 3000, 'Project Orion launch meeting'], ['m2', NOW_MS - 2000, 'I will prepare the Orion launch deck'], ['m3', NOW_MS - 1000, 'Orion deck review tomorrow']], isGroup)
  setEnabled(db, 'c1', true)
  const service = createGroupTopicsService(db, { isCombinedActive: () => combinedActive })
  return { ...opened, ids, service }
}

test('S1 with the todo switch off, analyze does not filter by processed and pendingCount counts processed=0 messages', async () => {
  const s = topicOnlyChat()
  try {
    setTodoExtractEnabled(s.db, 'c1', false, NOW_MS)
    assert.equal(s.service.pendingCount('c1'), 3)
    assert.equal(s.service.list('c1').combined, undefined)
    const seen = []
    const result = await s.service.analyze('c1', () => topicProvider(() => analysisFor(s.ids), (req) => seen.push(JSON.parse(req.user).messages.map((m) => m.msgId))))
    assert.equal(result.ok, true)
    assert.deepEqual(seen[0], s.ids, 'unprocessed messages are analysed')
  } finally { s.close() }
})

test('S2 with the todo switch on the combined set B semantics are unchanged: only processed=1 messages are pending', () => {
  const s = topicOnlyChat()
  try {
    assert.equal(s.service.pendingCount('c1'), 0, 'processed=0 messages belong to the combined queue')
    assert.equal(s.service.list('c1').combined, true)
    s.db.prepare("UPDATE messages SET processed=1 WHERE msg_id=?").run(s.ids[0])
    assert.equal(s.service.pendingCount('c1'), 1)
  } finally { s.close() }
})

test('S3 writing topics for a todo-off chat leaves messages processed=0 and creates no todos', async () => {
  const s = topicOnlyChat()
  try {
    setTodoExtractEnabled(s.db, 'c1', false, NOW_MS)
    const result = await s.service.analyze('c1', () => topicProvider(() => analysisFor(s.ids)))
    assert.equal(result.ok, true)
    assert.ok(n(s.db, 'SELECT COUNT(*) AS n FROM topic_message_decisions') >= 1)
    assert.equal(n(s.db, 'SELECT COUNT(*) AS n FROM messages WHERE processed=1'), 0)
    assert.equal(n(s.db, 'SELECT COUNT(*) AS n FROM todos'), 0)
  } finally { s.close() }
})

// ───────────────────────── 背景驅動器 ─────────────────────────

const flush = async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve)) }

function fakeClock(start = 1_000_000) {
  let now = start
  const timers = []
  return {
    now: () => now,
    setTimer: (fn, ms) => { const t = { at: now + ms, fn, cancelled: false }; timers.push(t); return () => { t.cancelled = true } },
    live: () => timers.filter((t) => !t.cancelled).length,
    async advance(ms) {
      const target = now + ms
      for (;;) {
        const next = timers.filter((t) => !t.cancelled && t.at <= target).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        now = Math.max(now, next.at)
        next.cancelled = true
        next.fn()
        await flush()
      }
      now = target
      await flush()
    }
  }
}

function bgScenario({ isGroup = true, chats = [{ id: 'c1', pending: 6 }], analyzeResult = () => ({ ok: true, analyzedCount: 1 }), health = async () => ({ ok: true }), active = () => true, config } = {}) {
  const opened = fixture()
  const { db } = opened
  ensureGroupTopicsSchema(db)
  chats.forEach((chat, index) => {
    addMsgs(db, chat.id, [[`seed-${chat.id}`, NOW_MS - 1000, 'seed']], chat.isGroup ?? isGroup)
    db.prepare('UPDATE chats SET last_seen_at=? WHERE chat_id=?').run(`2026-11-0${9 - index}T00:00:00.000Z`, chat.id)
    if (chat.topics !== false) setEnabled(db, chat.id, true)
    if (chat.todoOff !== false) setTodoExtractEnabled(db, chat.id, false, NOW_MS)
  })
  const clock = fakeClock()
  const pendings = new Map(chats.map((chat) => [chat.id, chat.pending]))
  const analyzed = []
  let inflight = 0
  let maxInflight = 0
  let resolves = 0
  const provider = { id: 'bg', kind: 'cli', health, complete: async () => ({ text: '' }) }
  const bg = createTopicBackground({
    db,
    service: {
      pendingCount: (id) => pendings.get(id) ?? 0,
      analyze: async (id, resolveProvider) => {
        inflight += 1; maxInflight = Math.max(maxInflight, inflight)
        analyzed.push({ id, at: clock.now(), provider: resolveProvider() })
        await new Promise((resolve) => setImmediate(resolve))
        inflight -= 1
        return analyzeResult(id, analyzed.filter((entry) => entry.id === id).length)
      }
    },
    resolveProvider: () => { resolves += 1; return provider },
    active, now: clock.now, setTimer: clock.setTimer, config
  })
  return { ...opened, clock, bg, analyzed, pendings, provider, stats: () => ({ maxInflight, resolves }) }
}

for (const isGroup of [true, false]) {
  test(`${isGroup ? 'BG1' : 'O3'} a ${isGroup ? 'group' : 'one-to-one'} chat with topics on and todo off is analysed once per tick when the background flag is active`, async () => {
    const s = bgScenario({ isGroup })
    try {
      s.bg.start()
      await s.clock.advance(29_000)
      assert.equal(s.analyzed.length, 0, 'the first round waits for startDelay')
      await s.clock.advance(2_000)
      assert.deepEqual(s.analyzed.map((entry) => entry.id), ['c1'])
      assert.equal(s.analyzed[0].provider, s.provider)
    } finally { s.bg.stop(); s.close() }
  })
}

test('BG2 todo on and topics off chats are never driven', async () => {
  const s = bgScenario({ chats: [
    { id: 'drive', pending: 6 },
    { id: 'todo-on', pending: 6, todoOff: false },
    { id: 'topics-off', pending: 6, topics: false }
  ] })
  try {
    s.bg.start()
    await s.clock.advance(60_000)
    assert.deepEqual([...new Set(s.analyzed.map((entry) => entry.id))], ['drive'])
  } finally { s.bg.stop(); s.close() }
})

test('BG3 when the background flag is off nothing is analysed and no provider is resolved', async () => {
  const s = bgScenario({ active: () => false })
  try {
    s.bg.start()
    await s.clock.advance(3_600_000)
    s.bg.kick()
    await s.clock.advance(60_000)
    assert.equal(s.analyzed.length, 0)
    assert.equal(s.stats().resolves, 0)
    assert.ok(s.bg.stats().skippedInactive > 0)
  } finally { s.bg.stop(); s.close() }
})

test('BG4 1-4 pending messages wait 30 minutes; 5 or more are spaced at least 2 minutes apart', async () => {
  const small = bgScenario({ chats: [{ id: 'c1', pending: 3 }] })
  try {
    small.bg.start()
    await small.clock.advance(31_000)
    await small.clock.advance(29 * 60_000 - 60_000)
    assert.equal(small.analyzed.length, 0, 'not yet 30 minutes')
    await small.clock.advance(3 * 60_000)
    assert.equal(small.analyzed.length, 1, 'fast-forwarded past the flush window')
  } finally { small.bg.stop(); small.close() }

  const large = bgScenario({ chats: [{ id: 'c1', pending: 6 }] })
  try {
    large.bg.start()
    await large.clock.advance(31_000)
    assert.equal(large.analyzed.length, 1)
    await large.clock.advance(60_000)
    assert.equal(large.analyzed.length, 1, 'less than 2 minutes since the last run')
    await large.clock.advance(70_000)
    assert.equal(large.analyzed.length, 2)
  } finally { large.bg.stop(); large.close() }
})

test('BG5 failures back off 60 s, 120 s, ... capped at 30 minutes; identity_* deferrals wait 30 s without accumulating', async () => {
  const failing = bgScenario({ analyzeResult: () => ({ ok: false, reason: 'analysis_failed' }), config: { minIntervalMs: 1000 } })
  try {
    failing.bg.start()
    await failing.clock.advance(31_000)
    await failing.clock.advance(7 * 3_600_000)
    const gaps = failing.analyzed.slice(1).map((entry, i) => entry.at - failing.analyzed[i].at)
    const expected = [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000]
    assert.ok(gaps.length >= expected.length, `enough attempts: ${gaps.length}`)
    expected.forEach((min, i) => assert.ok(gaps[i] >= min && gaps[i] <= min + 300_000, `gap ${i}: ${gaps[i]} vs ${min}`))
    assert.equal(gaps[0], 60_000)
    assert.equal(gaps[1], 120_000)
    gaps.slice(6).forEach((gap) => assert.ok(gap <= 1_800_000 + 300_000, 'capped'))
  } finally { failing.bg.stop(); failing.close() }

  const deferred = bgScenario({ analyzeResult: () => ({ ok: false, reason: 'identity_indexing' }), config: { minIntervalMs: 1000 } })
  try {
    deferred.bg.start()
    await deferred.clock.advance(31_000)
    await deferred.clock.advance(600_000)
    const gaps = deferred.analyzed.slice(1).map((entry, i) => entry.at - deferred.analyzed[i].at)
    assert.ok(gaps.length >= 6)
    gaps.forEach((gap) => assert.equal(gap, 30_000))
    assert.equal(deferred.bg.stats().failures, 0)
  } finally { deferred.bg.stop(); deferred.close() }
})

test('BG6 each tick drives at most two chats, strictly one after the other', async () => {
  const s = bgScenario({ chats: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, pending: 6 })) })
  try {
    s.bg.start()
    await s.clock.advance(31_000)
    assert.deepEqual(s.analyzed.map((entry) => entry.id), ['a', 'b'])
    await s.clock.advance(11_000)
    assert.deepEqual(s.analyzed.map((entry) => entry.id), ['a', 'b', 'c', 'd'])
    assert.equal(s.stats().maxInflight, 1)
  } finally { s.bg.stop(); s.close() }
})

test('BG7 stop() leaves no timer behind and nothing runs afterwards', async () => {
  const s = bgScenario()
  try {
    s.bg.start()
    s.bg.kick()
    assert.ok(s.clock.live() >= 1)
    s.bg.stop()
    assert.equal(s.clock.live(), 0)
    await s.clock.advance(3_600_000)
    s.bg.kick()
    assert.equal(s.clock.live(), 0, 'kick() after stop() schedules nothing')
    assert.equal(s.analyzed.length, 0)
  } finally { s.bg.stop(); s.close() }
})

test('BG8 an unhealthy provider means zero analyze calls and a 60 s retry', async () => {
  let ok = false
  const s = bgScenario({ health: async () => ({ ok }) })
  try {
    s.bg.start()
    await s.clock.advance(31_000)
    assert.equal(s.analyzed.length, 0)
    await s.clock.advance(50_000)
    assert.equal(s.analyzed.length, 0, 'still backing off')
    ok = true
    await s.clock.advance(30_000)
    assert.equal(s.analyzed.length, 1)
  } finally { s.bg.stop(); s.close() }
})

test('BG9 the background provider sends priority "background" to the AI port; the default stays "user"', async () => {
  const requests = []
  const port = { status: () => ({ state: 'ready' }), complete: async (request) => { requests.push(request); return { text: '{}', model: 'm' } } }
  await createPortAiProvider(port, { priority: 'background' }).complete({ system: 's', user: 'u' })
  await createPortAiProvider(port).complete({ system: 's', user: 'u' })
  assert.deepEqual(requests.map((request) => request.priority), ['background', 'user'])
})

// ───────────────────────── 跨群停用 ─────────────────────────

test('X3 an AI link decision still writes a same-chat topic_links row with identity_evidence unknown', async () => {
  const { db, close } = fixture()
  try {
    ensureGroupTopicsSchema(db)
    const first = addMsgs(db, 'g1', [['m1', NOW_MS - 5000, 'alpha beta project kickoff meeting']])
    setEnabled(db, 'g1', true)
    const service = createGroupTopicsService(db)
    const one = await service.analyze('g1', () => topicProvider(() => ({
      topics: [{ ref: 'alpha', title: 'Alpha beta project', summary: 'alpha beta project kickoff' }],
      assignments: [{ msgId: first[0], topicRef: 'alpha', relation: 'about', confidence: 0.9, relevance: 'unknown', relevanceEvidenceMsgIds: [] }]
    })))
    assert.equal(one.ok, true)
    const second = addMsgs(db, 'g1', [['m2', NOW_MS - 1000, 'alpha beta project follow up meeting notes']])
    const two = await service.analyze('g1', () => topicProvider((payload) => {
      const target = payload.historicalCandidates.find((candidate) => candidate.entityType === 'topic')
      assert.ok(target, 'the earlier topic is recalled')
      return {
        topics: [{ ref: 'follow', title: 'Alpha beta follow-up', summary: 'follow up notes' }],
        identityDecisions: [{ draftRef: 'follow', outcome: 'link', candidateType: 'topic', candidateId: target.entityId, relationKind: 'follow_up', reasonCode: 'related_topic', confidenceBand: 'high', evidenceMsgIds: [second[0]] }],
        assignments: [{ msgId: second[0], topicRef: 'follow', relation: 'about', confidence: 0.9, relevance: 'unknown', relevanceEvidenceMsgIds: [] }]
      }
    }))
    assert.equal(two.ok, true)
    const link = db.prepare('SELECT l.identity_evidence AS evidence, l.status AS status, a.chat_id AS left_chat, b.chat_id AS right_chat FROM topic_links l JOIN discussion_topics a ON a.topic_id=l.left_topic_id JOIN discussion_topics b ON b.topic_id=l.right_topic_id').get()
    assert.deepEqual({ ...link }, { evidence: 'unknown', status: 'proposed', left_chat: 'g1', right_chat: 'g1' })
  } finally { close() }
})

test('X4 the service and the backend path list no longer expose any cross-group entry point', () => {
  const { db, close } = fixture()
  try {
    ensureGroupTopicsSchema(db)
    const service = createGroupTopicsService(db)
    for (const key of ['enableCrossChat', 'crossChatEnabled', 'listLinkCandidates']) assert.equal(service[key], undefined, key)
    for (const path of SUPPORTED_API_PATHS) assert.equal(/crossChat|linkCandidates/i.test(path), false, path)
  } finally { close() }
})

// ───────────────────────── 一對一議題 ─────────────────────────

test('O1 a one-to-one chat with topics and todo on gets a combined payload and commit writes both topic and todo', async () => {
  const s = queueScenario({ combined: true, isGroup: false })
  try {
    await s.feed()
    const pulled = s.pull()
    assert.ok(pulled)
    assert.equal(pulled.item.topics, true)
    assert.deepEqual(pulled.payload.topic.targetMsgIds, s.ids)
    const committed = s.queue.commit({ results: [{ itemId: pulled.item.itemId, ok: true, result: { todo: todoPart(pulled.payload), topic: topicPart(pulled.payload) } }] })
    assert.equal(committed.results[0].status, 'applied')
    assert.ok(n(s.db, 'SELECT COUNT(*) AS n FROM discussion_topics WHERE chat_id=?', s.chatId) >= 1)
    assert.equal(n(s.db, 'SELECT COUNT(*) AS n FROM todos WHERE chat_id=?', s.chatId), 1)
  } finally { s.close() }
})

test('O4 the topic prompt names ONE chat (group or one-to-one) and no longer says ONE group chat', () => {
  assert.ok(GROUP_TOPICS_PROMPT.includes('ONE chat only'))
  assert.equal(GROUP_TOPICS_PROMPT.includes('ONE group chat'), false)
})

test('a one-to-one chat can run a manual topic analysis and loadPendingMessages sees its messages', async () => {
  const s = topicOnlyChat({ isGroup: false, combinedActive: false })
  try {
    assert.equal(loadPendingMessages(s.db, 'c1').length, 3)
    const result = await s.service.analyze('c1', () => topicProvider(() => analysisFor(s.ids)))
    assert.equal(result.ok, true)
  } finally { s.close() }
})

// ───────────────────────── 審查修正（2026-11-07 fix） ─────────────────────────

// 關閉待辦但不讓 scope 快照過期（模擬 commit 當下才發現已關閉的競態），好讓 commit 走到「待辦已關閉」的檢查而不是 scope_stale。
function disableKeepingSnapshot(db, chatId) {
  const before = db.prepare('SELECT scope_revision AS s, state_version AS v FROM chat_context_cache WHERE chat_id=?').get(chatId)
  setTodoExtractEnabled(db, chatId, false, NOW_MS)
  db.prepare('UPDATE chat_context_cache SET scope_revision=?, state_version=? WHERE chat_id=?').run(before.s, before.v, chatId)
}

test('F1a a todo switched off between lease and commit: an invalid todo part with a good topic part leaves no chatFail and no backoff', async () => {
  const s = queueScenario({ combined: true })
  try {
    await s.feed()
    const pulled = s.pull()
    assert.ok(pulled)
    assert.equal(pulled.item.topics, true)
    disableKeepingSnapshot(s.db, s.chatId)
    const committed = s.queue.commit({ results: [{ itemId: pulled.item.itemId, ok: true, result: { todo: { importance: 'nope' }, topic: topicPart(pulled.payload) } }] })
    assert.equal(committed.results[0].status, 'rejected')
    assert.equal(committed.results[0].code, 'todo_disabled')
    assert.equal(committed.results[0].retryInMs, undefined)
    assert.equal(s.queue.stats().chatsBackingOff, 0, 'no chatFail entry is left')
    assert.equal(n(s.db, 'SELECT COUNT(*) AS n FROM chat_context_cache WHERE active_lease_id IS NOT NULL'), 0, 'the source lease is released')
    setTodoExtractEnabled(s.db, s.chatId, true, NOW_MS)
    await s.feed()
    assert.ok(s.pull(), 'no backoff survives the re-enable')
  } finally { s.close() }
})

test('F1b a todo switched off between lease and commit: an ai failure or an unusable reply leaves no chatFail and no backoff', async () => {
  for (const kind of ['ai_failed', 'invalid']) {
    const s = queueScenario({ combined: false })
    try {
      await s.feed()
      const pulled = s.pull()
      assert.ok(pulled)
      setTodoExtractEnabled(s.db, s.chatId, false, NOW_MS)
      const entry = kind === 'ai_failed' ? { itemId: pulled.item.itemId, ok: false, failCode: 'ai_failed' } : { itemId: pulled.item.itemId, ok: true, result: { importance: 'nope' } }
      const committed = s.queue.commit({ results: [entry] })
      assert.equal(committed.results[0].retryInMs ?? 0, 0, kind)
      assert.equal(s.queue.stats().chatsBackingOff, 0, `${kind}: no chatFail entry is left`)
      setTodoExtractEnabled(s.db, s.chatId, true, NOW_MS)
      await s.feed()
      assert.ok(s.pull(), `${kind}: the chat is not backed off after re-enabling`)
    } finally { s.close() }
  }
})

for (const keepSnapshot of [true, false]) test(`F2 runOnce (${keepSnapshot ? 'todo_extract_disabled' : 'scope_stale'}): a todo switched off while the extractor runs is neither a failed chat nor a failed round`, async () => {
  const { db, close } = fixture()
  try {
    addMsgs(db, 'race', [['r1', NOW_MS - 1000, '請準備簡報']])
    const result = await runOnce({
      db, now: () => new Date(NOW_MS).toISOString(), watchSource: async () => ({ messages: [], bridge: 'ok' }),
      extractFn: async () => { if (keepSnapshot) disableKeepingSnapshot(db, 'race'); else setTodoExtractEnabled(db, 'race', false, NOW_MS); return { importance: 'action', newTodos: [{ draftRef: 'd1', bucket: 'todo', title: '準備簡報', detail: null, priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds: [stored('r1')] }], identityDecisions: [{ draftRef: 'd1', outcome: 'new', candidateType: null, candidateId: null, relationKind: null, reasonCode: 'insufficient_evidence', confidenceBand: 'high', evidenceMsgIds: [stored('r1')] }], resolved: [], updates: [] } }
    })
    assert.equal(result.chatsFailed, 0, 'not counted as a failed chat')
    assert.equal(result.llmStatus, 'ok', 'the round is not an error round, so the provider breaker has nothing to count')
    assert.equal(n(db, 'SELECT COUNT(*) AS n FROM todos'), 0)
    assert.equal(processedOf(db, stored('r1')), 0)
  } finally { close() }
})

function directLinkScenario() {
  const s = queueScenario({ combined: false, isGroup: false })
  setEnabled(s.db, s.chatId, true)
  s.db.prepare('INSERT INTO discussion_topics(topic_id,chat_id,local_ref,title,summary,created_at,last_source_ts,revision) VALUES(?,?,?,?,?,?,?,1)')
    .run('o2-topic', s.chatId, 'orion', '專案 Orion 簡報', '專案 Orion 需要準備簡報並確認時程', new Date(NOW_MS - 20_000).toISOString(), NOW_MS - 20_000)
  drainIndexes(s.db, s.chatId)
  return s
}
const linkReply = (payload) => {
  const first = payload.newMessages[0].msgId
  return { importance: 'action', newTodos: [{ draftRef: 'd1', bucket: 'todo', title: '準備簡報', detail: null, priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds: [first] }],
    identityDecisions: [{ draftRef: 'd1', outcome: 'link', candidateType: 'topic', candidateId: 'o2-topic', relationKind: 'same_topic', reasonCode: 'related_topic', confidenceBand: 'high', evidenceMsgIds: [first] }], resolved: [], updates: [] }
}

test('F5a O2 one-to-one chat: a queue commit linking a todo to a topic with same_topic is applied while topics are on', async () => {
  const s = directLinkScenario()
  try {
    await s.feed()
    const pulled = s.pull()
    assert.ok(pulled)
    const committed = s.queue.commit({ results: [{ itemId: pulled.item.itemId, ok: true, result: linkReply(pulled.payload) }] })
    assert.equal(committed.results[0].status, 'applied')
    assert.equal(n(s.db, 'SELECT COUNT(*) AS n FROM todos WHERE chat_id=?', s.chatId), 1)
    assert.equal(n(s.db, "SELECT COUNT(*) AS n FROM todo_topic_identity_relations WHERE topic_id='o2-topic' AND relation_type='same_topic'"), 1)
  } finally { s.close() }
})

test('F5b O2 one-to-one chat: the same queue commit is refused once topics are switched off, and nothing is written', async () => {
  const s = directLinkScenario()
  try {
    await s.feed()
    const pulled = s.pull()
    assert.ok(pulled)
    setEnabled(s.db, s.chatId, false)
    const committed = s.queue.commit({ results: [{ itemId: pulled.item.itemId, ok: true, result: linkReply(pulled.payload) }] })
    assert.notEqual(committed.results[0].status, 'applied')
    assert.equal(n(s.db, 'SELECT COUNT(*) AS n FROM todos WHERE chat_id=?', s.chatId), 0)
    assert.equal(n(s.db, 'SELECT COUNT(*) AS n FROM todo_topic_identity_relations'), 0)
    assert.equal(n(s.db, 'SELECT COUNT(*) AS n FROM messages WHERE processed=1'), 0)
  } finally { s.close() }
})
