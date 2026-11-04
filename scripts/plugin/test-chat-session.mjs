// Every LINE chat keeps ONE dedicated Host session for all AI purposes (extract, draft reply, not-mine analysis, group topics, identity retry);
// prompt refinement uses one global session. Acceptance matrix A1-A10 of output/line-todo-chat-session-20261104/design.md (A11 lives in test-host-ai.mjs,
// A7 in test-backend-units.mjs, A12 is a manual dogfood).
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openDatabase } from '../../src/main/db/database.ts'
import { draftReply } from '../../src/main/llm/draftReply.ts'
import { AiPortError } from '../../src/core/aiPort.ts'
import { AI_SESSION_ACTIVE_KEY, AI_SESSION_MAP_KEY_PREFIX, AI_SESSION_MAP_V1_KEY_PREFIX, GLOBAL_SCOPE_KEY, chatScopeKey, createAiSessionMapStore } from '../../src/plugin/backend/aiSessionMapStore.ts'
import { createPortAiProvider, fitUserPayload, maxUserCharsFor } from '../../src/plugin/backend/aiProvider.ts'
import { GROUP_TOPICS_BATCH_SIZE, fitTopicRequestPayload, requestSchemaForBatch } from '../../src/main/features/groupTopics/service.ts'
import { identitySchema } from '../../src/main/identity/retryService.ts'
import { CHAT_SESSION_SYSTEM_V1, RULE_DOC_SEGMENT_MAX_CHARS, TASK_TURN_OVERHEAD_CHARS, buildRuleDoc, buildTaskTurn } from '../../src/plugin/backend/chatSessionProtocol.ts'
import { createHostAiPort } from '../../src/plugin/backend/hostAi.ts'
import { createPromptService } from '../../src/plugin/backend/promptService.ts'
import { createChatPromptStore } from '../../src/plugin/backend/chatPromptStore.ts'
import { createSettingsStore } from '../../src/main/config/settings.ts'
import { outputContractFor } from '../../src/plugin/backend/aiOutputContract.ts'

const noSecrets = { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unused') }, decryptString: () => { throw new Error('unused') } }
const failure = (code) => Object.assign(new Error(code), { code })
const NOISE = JSON.stringify({ importance: 'noise', newTodos: [], identityDecisions: [], resolved: [], updates: [] })
const kindOf = (text) => /^【任務 (\w+) r[0-9a-f]{16}】/u.exec(text)?.[1] ?? null

/** A Core-like host: one active session per plugin (`session_limit`), 8,000-char turns, durable closed sessions that can be resumed, deletable sessions. */
function chatHost(options = {}) {
  const sessions = new Map()
  const operations = []
  let nextId = options.firstId ?? 100
  let maxActive = 0
  const active = () => [...sessions.values()].filter((row) => row.active).length
  const sessionFor = (row) => {
    const listeners = new Set()
    const publish = (event) => { for (const listener of [...listeners]) listener(event) }
    return {
      sessionId: row.id,
      effective: row.effective,
      turn: null,
      async send({ text }) {
        if (!row.active) throw failure('session_closed')
        if (text.length > 8_000) throw failure('input_too_large')
        const turnId = (++row.turns).toString(16).padStart(16, '0')
        row.sends.push(text)
        const kind = kindOf(text)
        const output = options.reply?.({ row, text, kind }) ?? (text.startsWith('【規則文件') ? 'OK' : kind === 'extract' || kind === 'extractTopics' ? NOISE : kind === 'draftReply' ? '好的，我會處理。' : kind === 'promptRefine' ? JSON.stringify({ prompt: '新的提示詞', changes: ['更明確'] }) : kind === 'analyzeNotMine' ? JSON.stringify({ inferredCauseCode: 'x', summary: 's' }) : JSON.stringify({ ok: true }))
        publish({ turnId, kind: 'textDelta', text: output })
        publish({ turnId, kind: 'completed' })
        return { turnId }
      },
      onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) },
      async interrupt() { return undefined },
      async close() { row.active = false; operations.push({ op: 'close', id: row.id }) }
    }
  }
  const api = {
    async getOptions() {
      return {
        providers: [{ id: 'codex', label: 'Mock Codex', state: 'ready', models: [
          { id: 'model-a', label: 'A', efforts: ['low', 'medium'], defaultEffort: 'medium', supportsImages: false, isDefault: true },
          { id: 'model-b', label: 'B', efforts: ['low', 'medium'], defaultEffort: 'medium', supportsImages: false, isDefault: false }
        ] }],
        defaultProviderId: 'codex',
        limits: { systemChars: 16_000, transcriptLines: 40, transcriptChars: 60_000, inputChars: 8_000, imageBytes: 0, turnsPerMinute: 1_000_000 },
        quota: { state: 'ok', retryAfterMs: null },
        capabilities: { closedSessionResume: true }
      }
    },
    async complete() { throw new Error('a scoped request must never use one-shot complete') },
    async openSession(input) {
      if ('resume' in input) {
        operations.push({ op: 'resume', id: input.resume })
        const existing = sessions.get(input.resume)
        if (existing === undefined) throw failure('session_not_found')
        if (existing.orphan) { existing.orphan = false; return sessionFor(existing) } // re-attaching a session the crashed process left open
        if (existing.active || active() > 0) throw failure('session_limit')
        existing.active = true
        maxActive = Math.max(maxActive, active())
        return sessionFor(existing)
      }
      if (active() > 0) throw failure('session_limit')
      const id = String(nextId++)
      const row = { id, effective: { providerId: 'codex', modelId: input.modelId ?? 'model-a', effort: input.effort ?? 'medium' }, system: input.system, taskId: input.taskId ?? null, active: true, turns: 0, sends: [] }
      sessions.set(id, row)
      operations.push({ op: 'fresh', id, system: input.system })
      maxActive = Math.max(maxActive, active())
      return sessionFor(row)
    }
  }
  return { api, sessions, operations, deleteSession: (id) => sessions.delete(id), get maxActive() { return maxActive } }
}

function memoryStore() {
  const records = new Map()
  const state = { active: null }
  return {
    records, state,
    async get(scopeKey) { return structuredClone(records.get(scopeKey) ?? null) },
    async put(record) { records.set(record.scopeKey, structuredClone(record)) },
    async remove(scopeKey) { records.delete(scopeKey) },
    async getActive() { return state.active },
    async putActive(record) { state.active = structuredClone(record) },
    async clearActive() { state.active = null }
  }
}

const makePort = (host, store, extra = {}) => createHostAiPort({
  ai: host.api,
  selection: () => ({ providerId: 'codex', modelId: 'model-a', effort: 'medium' }),
  sessionMapStore: store,
  config: { perMinute: 1_000_000, perHour: 1_000_000, extractReserve: 0, extractHourReserve: 0 },
  ...extra
})

const chatScope = (chatId, taskKind, epoch) => ({ kind: 'line-chat', chatId, taskKind, ...(epoch !== undefined ? { epoch } : {}) })
const RULES = {
  extract: 'EXTRACT RULES', extractTopics: 'EXTRACT+TOPICS RULES', draftReply: 'DRAFT RULES', analyzeNotMine: 'NOTMINE RULES', groupTopics: 'GROUPTOPICS RULES', identityRetry: 'IDENTITY RULES'
}
const request = (chatId, taskKind, extra = {}) => ({
  system: RULES[taskKind], user: JSON.stringify({ chatId, taskKind }), expectJson: taskKind !== 'draftReply', validate: (value) => ({ ok: true, value }),
  priority: taskKind === 'extract' || taskKind === 'extractTopics' ? 'background' : 'user', conversationScope: chatScope(chatId, taskKind), ...extra
})
const KINDS = ['extract', 'draftReply', 'analyzeNotMine', 'groupTopics', 'identityRetry', 'extractTopics']
const freshCount = (host) => host.operations.filter((entry) => entry.op === 'fresh').length
const resumeCount = (host) => host.operations.filter((entry) => entry.op === 'resume').length

test('A1 200 mixed AI calls (extract, draft, not-mine, group topics, identity retry, topics extract) of one chat open exactly ONE session and resume it every other time', async () => {
  const host = chatHost()
  const store = memoryStore()
  const port = makePort(host, store)
  try {
    for (let i = 0; i < 200; i += 1) await port.complete(request('u-alice', KINDS[i % KINDS.length]))
    assert.equal(freshCount(host), 1)
    assert.equal(resumeCount(host), 199)
    assert.equal(host.sessions.size, 1)
    assert.equal(host.maxActive, 1)
    assert.equal(host.operations.filter((entry) => entry.op === 'close').length, 200, 'every job closes its session')
    assert.equal(host.sessions.get('100').active, false)
    const record = store.records.get(chatScopeKey('u-alice'))
    assert.deepEqual(Object.keys(record.docs).sort(), [...KINDS].sort(), 'one rule document per purpose, each sent once')
    const ruleDocs = host.sessions.get('100').sends.filter((text) => text.startsWith('【規則文件'))
    assert.equal(ruleDocs.length, KINDS.length, 'no rule document is ever resent for an unchanged rule')
    assert.equal(host.sessions.get('100').sends.length, 200 + KINDS.length)
    assert.equal(host.sessions.get('100').system, CHAT_SESSION_SYSTEM_V1)
  } finally { port.stop() }
})

test('A2 two chats interleaved: one session each, never mixed, the single-active-session limit is respected and every session is closed', async () => {
  const host = chatHost()
  const port = makePort(host, memoryStore())
  try {
    for (let i = 0; i < 60; i += 1) await port.complete(request(i % 2 === 0 ? 'u-alice' : 'u-bob', KINDS[i % KINDS.length]))
    assert.equal(freshCount(host), 2)
    assert.equal(host.sessions.size, 2)
    assert.equal(host.maxActive, 1)
    assert.equal([...host.sessions.values()].filter((row) => row.active).length, 0)
    for (const row of host.sessions.values()) {
      const payloads = row.sends.filter((text) => text.startsWith('【任務')).map((text) => JSON.parse(text.split('\n').slice(1, -1).join('\n')).chatId)
      assert.equal(new Set(payloads).size, 1, `session ${row.id} only ever saw one chat`)
    }
  } finally { port.stop() }
})

test('A3 a changed rule (prompt, name, topics switch) sends a new rev rule document segmented to <= 7,000 chars to the SAME session; an unchanged rule is never resent', async () => {
  const host = chatHost()
  const store = memoryStore()
  const port = makePort(host, store)
  const longRule = (tag) => `${tag}\n${'規則內容。'.repeat(3_000)}`
  try {
    await port.complete({ ...request('u-alice', 'extract'), system: longRule('V1') })
    const row = host.sessions.get('100')
    const docs = () => row.sends.filter((text) => text.startsWith('【規則文件'))
    assert.equal(docs().length, 3, '15,000 chars of rules => 3 segments')
    docs().forEach((text, index) => {
      assert.ok(text.length <= RULE_DOC_SEGMENT_MAX_CHARS, `segment ${index + 1} is ${text.length} chars`)
      assert.ok(text.startsWith(`【規則文件 extract r${buildRuleDoc('extract', longRule('V1')).rev} 第 ${index + 1}/3 段】`))
    })
    assert.equal(docs().map((text) => text.split('\n').slice(1).join('\n')).join(''), longRule('V1'), 'the segments reassemble to the exact rule text')
    await port.complete({ ...request('u-alice', 'extract'), system: longRule('V1') })
    assert.equal(docs().length, 3)
    await port.complete({ ...request('u-alice', 'extract'), system: longRule('V2') })
    assert.equal(docs().length, 6, 'a changed rule sends one complete new rule document')
    assert.notEqual(docs()[0].split('\n')[0], docs()[3].split('\n')[0])
    assert.equal(freshCount(host), 1, 'and still only one session')
    assert.equal(store.records.get(chatScopeKey('u-alice')).docs.extract.rev, buildRuleDoc('extract', longRule('V2')).rev)
    const surrogate = buildRuleDoc('extract', '😀'.repeat(5_000), 1_000)
    assert.ok(surrogate.segments.every((segment) => segment.length <= 1_000))
    assert.equal(surrogate.segments.map((segment) => segment.split('\n').slice(1).join('\n')).join(''), '😀'.repeat(5_000), 'no surrogate pair is split')
  } finally { port.stop() }
})

test('A4 SourceCache epoch changes never open a new session; the first task turn of a new epoch carries the context-reset marker', async () => {
  const host = chatHost()
  const store = memoryStore()
  const port = makePort(host, store)
  const extract = (epoch) => port.complete({ ...request('u-alice', 'extract'), conversationScope: chatScope('u-alice', 'extract', epoch) })
  try {
    for (const epoch of [1, 1, 2, 2, 3, 9, 9]) await extract(epoch)
    assert.equal(freshCount(host), 1)
    const tasks = host.sessions.get('100').sends.filter((text) => text.startsWith('【任務'))
    assert.deepEqual(tasks.map((text) => /【上下文重設 第 (\d+) 版】/u.exec(text)?.[1] ?? null), [null, null, '2', null, '3', '9', null])
    assert.equal(store.records.get(chatScopeKey('u-alice')).epoch, 9)
  } finally { port.stop() }
})

test('A5 after a restart (a new port over the same durable store) the first call of every chat resumes, it does not open a session', async () => {
  const host = chatHost()
  const store = memoryStore()
  const first = makePort(host, store)
  await first.complete(request('u-alice', 'extract'))
  await first.complete(request('u-bob', 'draftReply'))
  first.stop()
  const second = makePort(host, store)
  try {
    await second.complete(request('u-bob', 'extract'))
    await second.complete(request('u-alice', 'analyzeNotMine'))
    assert.deepEqual(host.operations.filter((entry) => entry.op !== 'close').map(({ op, id }) => `${op}:${id}`), ['fresh:100', 'fresh:101', 'resume:101', 'resume:100'])
  } finally { second.stop() }
})

test('A6 a deleted or unresumable session is rebuilt inside the same job for every purpose (buttons succeed on the first press), the old id is never touched again', async () => {
  for (const kind of ['draftReply', 'analyzeNotMine', 'groupTopics', 'identityRetry', 'extract']) {
    const host = chatHost()
    const store = memoryStore()
    const port = makePort(host, store)
    try {
      await port.complete(request('u-alice', kind))
      host.deleteSession('100')
      const closesBefore = host.operations.filter((entry) => entry.op === 'close').length
      const result = await port.complete(request('u-alice', kind))
      assert.ok(result.text.length > 0, kind)
      assert.equal(result.contextLost, true, kind)
      assert.equal(store.records.get(chatScopeKey('u-alice')).hostSessionId, '101', `${kind}: the mapping points at the new session`)
      assert.deepEqual(host.operations.filter((entry) => entry.op !== 'close').map(({ op, id }) => `${op}:${id}`), ['fresh:100', 'resume:100', 'fresh:101'], kind)
      assert.deepEqual(host.operations.filter((entry) => entry.op === 'close').map((entry) => entry.id).slice(closesBefore), ['101'], `${kind}: only the new session is closed`)
    } finally { port.stop() }
  }
})

test('A6b a turn that fails with session_closed in the middle of a job is re-sent as a whole on a new session; a second identity failure is continuity_lost', async () => {
  let killed = false
  const host = chatHost({ reply: ({ row, text }) => {
    if (!killed && text.startsWith('【任務') && row.id === '100') { killed = true; host.deleteSession('100'); throw failure('session_closed') }
    return undefined
  } })
  const port = makePort(host, memoryStore())
  try {
    const result = await port.complete(request('u-alice', 'extract'))
    assert.equal(result.contextLost, true)
    assert.equal(freshCount(host), 2)
    assert.ok(host.sessions.get('101').sends.some((text) => text.startsWith('【規則文件 extract')) && host.sessions.get('101').sends.some((text) => text.startsWith('【任務 extract')))
  } finally { port.stop() }
  const stubborn = chatHost({ reply: () => { throw failure('session_closed') } })
  const port2 = makePort(stubborn, memoryStore())
  try {
    await assert.rejects(port2.complete(request('u-alice', 'extract')), (error) => error instanceof AiPortError && error.code === 'continuity_lost')
  } finally { port2.stop() }
})

test('A6c the user switching model replaces the chat session (the only deliberate replacement); busy and session_limit keep the mapping', async () => {
  const host = chatHost()
  const store = memoryStore()
  let model = 'model-a'
  const port = createHostAiPort({ ai: host.api, selection: () => ({ providerId: 'codex', modelId: model, effort: 'medium' }), sessionMapStore: store, config: { perMinute: 1_000_000, perHour: 1_000_000, extractReserve: 0, extractHourReserve: 0, optionsTtlMs: 0 } })
  try {
    await port.complete(request('u-alice', 'extract'))
    await port.complete(request('u-alice', 'draftReply'))
    assert.equal(freshCount(host), 1)
    model = 'model-b'
    const swapped = await port.complete(request('u-alice', 'extract'))
    assert.equal(swapped.contextLost, true)
    assert.equal(freshCount(host), 2)
    assert.equal(store.records.get(chatScopeKey('u-alice')).effective.modelId, 'model-b')
    host.sessions.get('101').active = true
    await assert.rejects(port.complete(request('u-alice', 'extract')), (error) => error.code === 'busy')
    assert.equal(store.records.get(chatScopeKey('u-alice')).hostSessionId, '101', 'session_limit does not drop the mapping')
  } finally { port.stop() }
})

test('A8 v1 rows and old sessions are never read, written, deleted or closed; the v2 key space does not collide with them', async () => {
  const opened = openDatabase({ dbPath: ':memory:' })
  const host = chatHost({ firstId: 500 })
  const v1Rows = [['u-alice', '7'], ['u-bob', '8']].map(([chatId, hostSessionId]) => [
    `${AI_SESSION_MAP_V1_KEY_PREFIX}${chatId.length}-${chatId}`,
    JSON.stringify({ schemaVersion: 1, chatId, hostSessionId, effective: { providerId: 'codex', modelId: 'model-a', effort: 'medium' }, continuityFingerprint: 'c'.repeat(64) })
  ])
  for (const [key, value] of v1Rows) opened.db.prepare('INSERT INTO app_settings(key, value) VALUES (?, ?)').run(key, value)
  // the old sessions exist in the host (closed): any call touching them would show up in the operations log
  for (const id of ['7', '8']) host.sessions.set(id, { id, effective: { providerId: 'codex', modelId: 'model-a', effort: 'medium' }, active: false, turns: 0, sends: [] })
  const port = makePort(host, createAiSessionMapStore({ getDatabase: () => opened.db }))
  const snapshot = () => opened.db.prepare('SELECT key, value FROM app_settings WHERE key LIKE ? ORDER BY key').all(`${AI_SESSION_MAP_V1_KEY_PREFIX}%`)
  const before = snapshot()
  try {
    for (let i = 0; i < 30; i += 1) await port.complete(request(i % 2 === 0 ? 'u-alice' : 'u-bob', KINDS[i % KINDS.length]))
    assert.deepEqual(snapshot(), before, 'v1 rows are byte-identical')
    assert.deepEqual(before.map((row) => row.value).sort(), v1Rows.map(([, value]) => value).sort())
    assert.equal(host.operations.filter((entry) => entry.id === '7' || entry.id === '8').length, 0, 'no call ever targets an old session')
    assert.equal(host.sessions.get('7').turns + host.sessions.get('8').turns, 0)
    const v2 = opened.db.prepare('SELECT key FROM app_settings WHERE key LIKE ?').all(`${AI_SESSION_MAP_KEY_PREFIX}%`).map((row) => row.key)
    assert.equal(v2.length, 2, 'one v2 row per chat, the active marker is cleared after every close')
    assert.ok(!v2.includes(AI_SESSION_ACTIVE_KEY))
  } finally { port.stop(); opened.db.close() }
})

test('A8b a v2 row left from a crashed run (active marker) is resumed and closed once before the first job, so the single-session slot is free', async () => {
  const host = chatHost()
  const store = memoryStore()
  const first = makePort(host, store)
  await first.complete(request('u-alice', 'extract'))
  first.stop()
  host.sessions.get('100').active = true // the crashed process never closed it: a fresh session would now hit session_limit
  host.sessions.get('100').orphan = true
  store.state.active = { scopeKey: chatScopeKey('u-alice'), hostSessionId: '100' }
  const second = makePort(host, store)
  try {
    await second.complete(request('u-bob', 'extract'))
    assert.deepEqual(host.operations.map(({ op, id }) => `${op}:${id}`), ['fresh:100', 'close:100', 'resume:100', 'close:100', 'fresh:101', 'close:101'], 'the leftover session was resumed and closed before the new chat opened')
    assert.equal(store.state.active, null)
  } finally { second.stop() }
})

test('A9 every turn fits the 8,000-char host limit: rule segments <= 7,000, task turn = label + dynamic contract + payload + reminder; oversize requests fail before any session is opened', async () => {
  const host = chatHost()
  const port = makePort(host, memoryStore())
  const contract = outputContractFor({ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false })
  try {
    const user = 'x'.repeat(maxUserCharsFor(true, contract))
    await port.complete({ ...request('u-alice', 'groupTopics'), user, dynamicContract: contract })
    for (const text of host.sessions.get('100').sends) assert.ok(text.length <= 8_000, `${text.length}`)
    assert.ok(host.sessions.get('100').sends.some((text) => text.includes(contract) && text.includes(user)))
    assert.equal(maxUserCharsFor(false, contract), 7_500, 'a one-shot call keeps the old cap')
    assert.equal(maxUserCharsFor(true, undefined), 7_500)
    assert.ok(8_000 - TASK_TURN_OVERHEAD_CHARS - contract.length >= user.length)
    const operationsBefore = host.operations.length
    await assert.rejects(port.complete({ ...request('u-alice', 'groupTopics'), user: 'y'.repeat(7_900), dynamicContract: contract }), (error) => error.code === 'input_too_large')
    assert.equal(host.operations.length, operationsBefore, 'nothing was sent or opened')
    assert.ok(buildTaskTurn({ kind: 'extract', rev: 'a'.repeat(16), resetEpoch: 12, payload: 'P' }).length < TASK_TURN_OVERHEAD_CHARS)
  } finally { port.stop() }
})

test('A9b the real dynamic schemas of group topics (full 20-message batch, 30 candidates) and identity retry leave room for the payload: the group-topics payload is fitted without dropping a message', () => {
  const uuid = (i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`
  const ids = Array.from({ length: GROUP_TOPICS_BATCH_SIZE }, (_, i) => ({ msgId: `i:${1_000_000_000_000_000 + i}` }))
  const candidates = Array.from({ length: 30 }, (_, i) => ({ entityId: uuid(i) }))
  const contract = outputContractFor(requestSchemaForBatch(ids, candidates))
  assert.ok(contract.length > 3_500 && contract.length < 5_000, `measured group-topics contract: ${contract.length}`)
  const cap = maxUserCharsFor(true, contract)
  assert.ok(cap >= 2_500, `payload room left for the worst case: ${cap}`)
  const payload = JSON.stringify({
    existingLocalTopics: Array.from({ length: 12 }, (_, i) => ({ ref: `t${i}`, title: '議題'.repeat(20), summary: '摘要'.repeat(60) })),
    historicalCandidates: candidates.map((candidate, i) => ({ entityType: 'topic', entityId: candidate.entityId, title: '歷史議題'.repeat(15), summary: '歷史摘要'.repeat(30), recallReasons: ['lexical'] })),
    historicalCandidatesTruncated: false,
    messages: ids.map((message, i) => ({ msgId: message.msgId, ts: 1_700_000_000_000 + i, direction: 'in', text: `第 ${i} 則訊息 ${'內容'.repeat(150)}` }))
  })
  assert.ok(payload.length > 7_000)
  const input = JSON.parse(payload)
  const service = fitTopicRequestPayload(input.existingLocalTopics, candidates.map((candidate, i) => ({ entityType: 'topic', entityId: candidate.entityId, title: '歷史議題'.repeat(15), summary: '歷史摘要'.repeat(30), recallReasons: ['lexical'] })), input.messages, false, cap)
  const fitted = JSON.parse(service.user)
  assert.equal(fitted.messages.length, GROUP_TOPICS_BATCH_SIZE, 'assignments must cover every message: none is dropped')
  assert.equal(fitted.historicalCandidatesTruncated, true, 'the service itself reports the dropped candidates')
  assert.equal(service.candidateTruncated, true)
  assert.deepEqual(service.candidates.map((candidate) => candidate.entityId), fitted.historicalCandidates.map((candidate) => candidate.entityId), 'what the service records is what the model is shown')
  assert.ok(service.candidates.length < candidates.length)
  assert.ok(service.user.length <= cap)
  assert.equal(fitUserPayload(service.user, cap), service.user, 'the provider layer no longer changes (or silently drops from) an already fitted group-topics payload')
  assert.throws(() => fitUserPayload(payload, cap), (error) => error.code === 'input_too_large', 'the provider never drops candidates on its own')
  const context = { draftRef: 'draft_1', messages: ids.slice(0, 8), candidates: candidates.slice(0, 20) }
  const identityContract = outputContractFor(identitySchema(context))
  assert.ok(identityContract.length < 3_000, `identity retry contract: ${identityContract.length}`)
  assert.ok(maxUserCharsFor(true, identityContract) >= 4_500, 'the 7.5k identity-retry payload cap is cut by at most ~3k')
})

test('A10 prompt refinement uses the single global session (global:main), distinct from every chat session', async () => {
  const host = chatHost()
  const store = memoryStore()
  const port = makePort(host, store)
  const dir = mkdtempSync(join(tmpdir(), 'line-todo-chat-session-'))
  const opened = openDatabase({ dbPath: ':memory:' })
  const prompts = createPromptService(createSettingsStore({ userDataDir: dir, secrets: noSecrets }), port, { chatStore: createChatPromptStore({ getDatabase: () => opened.db }) })
  try {
    await port.complete(request('u-alice', 'extract'))
    const first = await prompts.refine({ prompt: '舊的提示詞', goal: '更精準' })
    const second = await prompts.refine({ prompt: '舊的提示詞二', goal: '更精準' })
    assert.equal(first.prompt, '新的提示詞')
    assert.equal(second.prompt, '新的提示詞')
    const global = store.records.get(GLOBAL_SCOPE_KEY)
    assert.ok(global)
    assert.notEqual(global.hostSessionId, store.records.get(chatScopeKey('u-alice')).hostSessionId)
    assert.equal(freshCount(host), 2, 'one chat session + one global session, however many refinements')
    assert.ok(host.sessions.get(global.hostSessionId).sends.every((text) => !text.includes('u-alice')), 'the global session never sees chat content')
  } finally { port.stop(); opened.db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('C2-C5 through the real LlmProvider: a `conversation` on the request becomes the chat session and the dynamic schema travels in the task turn; without it the contract stays in system', async () => {
  const host = chatHost()
  const port = makePort(host, memoryStore())
  const provider = createPortAiProvider(port)
  const schema = { type: 'object', properties: { assignments: { type: 'array' } }, additionalProperties: false }
  try {
    const draft = await draftReply(provider, { todo: { bucket: 'todo', title: 't', detail: null }, chatName: 'Alice', isGroup: false, recentMessages: [] }, { chatId: 'u-alice' })
    assert.equal(draft, '好的，我會處理。')
    await provider.complete({ system: 'NOTMINE RULES', user: '{}', conversation: { chatId: 'u-alice', kind: 'analyzeNotMine' } })
    await provider.complete({ system: 'GROUPTOPICS RULES', user: '{"messages":[]}', jsonSchema: { name: 'group_topics', schema }, conversation: { chatId: 'u-alice', kind: 'groupTopics' } })
    await provider.complete({ system: 'IDENTITY RULES', user: '{"draft":1}', jsonSchema: { name: 'identity_retry', schema }, conversation: { chatId: 'u-alice', kind: 'identityRetry' } })
    assert.equal(freshCount(host), 1, 'all four purposes of one chat share one session')
    const sends = host.sessions.get('100').sends
    const groupTurn = sends.find((text) => text.startsWith('【任務 groupTopics'))
    assert.ok(groupTurn.includes(outputContractFor(schema)), 'the dynamic schema is in the task turn')
    assert.ok(sends.filter((text) => text.startsWith('【規則文件')).every((text) => !text.includes('JSON Schema')), 'rule documents never contain a dynamic schema')
    await assert.rejects(provider.complete({ system: 'S', user: 'u' }), () => true, 'a request without conversation is not scoped: it takes the one-shot path (this host forbids it)')
  } finally { port.stop() }
})

test('wiring: all six production callers pass their chat (or the global scope) to the AI port', () => {
  const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  assert.match(read('src/plugin/backend/extractWorker.ts'), /conversationScope: \{ kind: 'line-chat', chatId: item\.chatId, taskKind: item\.topics \? 'extractTopics' : 'extract'/u)
  assert.match(read('src/core/application.ts'), /\}, \{ chatId: todo\.chatId \}\)/u)
  assert.match(read('src/main/llm/draftReply.ts'), /conversation: \{ chatId: opts\.chatId, kind: 'draftReply'/u)
  assert.match(read('src/core/application.ts'), /conversation:\{chatId:review\.todo\.chatId,kind:'analyzeNotMine'\}/u)
  assert.match(read('src/main/features/groupTopics/service.ts'), /conversation: \{ chatId, kind: 'groupTopics' \}/u)
  assert.match(read('src/main/identity/retryService.ts'), /conversation: \{ chatId: item\.chatId, kind: 'identityRetry' \}/u)
  assert.match(read('src/plugin/backend/promptService.ts'), /conversationScope: \{ kind: 'line-global', taskKind: 'promptRefine' \}/u)
  assert.match(read('src/plugin/backend/aiProvider.ts'), /conversationScope: scope/u)
})
