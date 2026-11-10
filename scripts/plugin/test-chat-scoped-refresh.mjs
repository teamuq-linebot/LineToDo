// 「重新整理最近 N 天」（只針對一個聊天室）：範圍、開關、N 邊界、done／dismissed 不重建、重複執行不重複。
// 時間全部由 NOW 固定，不依賴牆鐘。AI 一律用假函式。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { openDatabase } from '../../src/main/db/database.ts'
import { getMessagesByChatAndIds, insertMessages, markProcessed } from '../../src/main/db/messages.repo.ts'
import { getOpenTodosByChat, updateStatus } from '../../src/main/db/todos.repo.ts'
import { ensureChatTodoPrefsSchema, setTodoExtractEnabled } from '../../src/main/db/chatTodoPrefs.repo.ts'
import { advanceIdentityIndex, beginIdentitySourceAttempt, captureIdentitySnapshot, recallTodoIdentityCandidates } from '../../src/main/db/identity.repo.ts'
import { ensureGroupTopicsSchema, setEnabled } from '../../src/main/features/groupTopics/repository.ts'
import { createGroupTopicsService } from '../../src/main/features/groupTopics/service.ts'
import { getPipelineDefaults } from '../../src/main/config/defaults.ts'
import { applyChatExtract } from '../../src/main/pipeline/runOnce.ts'
import { parseChatRefreshDays, refreshChatLastDays, topicRefreshOutcome } from '../../src/main/pipeline/chatRefresh.ts'
import { refreshFailureText } from '../../src/renderer/features/chatRefresh/refreshFailure.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 10, 3, 0, 0)

function open() {
  const db = openDatabase({ dbPath: ':memory:' }).db
  ensureChatTodoPrefsSchema(db)
  return db
}
const stored = (id) => `i:${id}`

function raw(id, chatId, ts, text = '請準備簡報', isGroup = true) {
  return { msgId: id, chat: `Chat ${chatId}`, chatId, isGroup, ts, time: new Date(ts).toISOString(), direction: 'in', sender: 'Alice', text, contentType: 0 }
}

const NOOP_RESULT = { importance: 'noise', newTodos: [], identityDecisions: [], resolved: [], updates: [] }

function recorder(result = async () => NOOP_RESULT) {
  const calls = []
  return { calls, fn: async (input) => { calls.push(input.newMessages.map((m) => m.msgId)); return result(input) } }
}

const draft = (src) => ({ draftRef: 'd1', bucket: 'todo', title: '準備簡報', detail: null, priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds: [src] })
const decision = (src) => ({ draftRef: 'd1', outcome: 'new', candidateType: null, candidateId: null, relationKind: null, reasonCode: 'insufficient_evidence', confidenceBand: 'high', evidenceMsgIds: [src] })
const aiCreates = (src) => async () => ({ importance: 'action', newTodos: [draft(src)], identityDecisions: [decision(src)], resolved: [], updates: [] })

const todoRows = (db, chatId) => db.prepare('SELECT id,status FROM todos WHERE chat_id=? ORDER BY id').all(chatId).map((row) => ({ id: row.id, status: row.status }))

test('N 只接受 1–365 的整數', () => {
  for (const bad of [0, -1, 366, 1.5, Number.NaN, '7', null, undefined]) assert.equal(parseChatRefreshDays(bad), null, String(bad))
  assert.equal(parseChatRefreshDays(1), 1)
  assert.equal(parseChatRefreshDays(7), 7)
  assert.equal(parseChatRefreshDays(365), 365)
})

test('invalid N 不碰 AI，直接回 invalid_days', async () => {
  const db = open()
  insertMessages([raw('a1', 'A', NOW - DAY)], db)
  setTodoExtractEnabled(db, 'A', true)
  const rec = recorder()
  for (const days of [0, 366, 2.5]) {
    const result = await refreshChatLastDays('A', days, { db, nowFn: () => NOW, extractFn: rec.fn })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'invalid_days')
  }
  assert.equal(rec.calls.length, 0)
})

test('只送出這個聊天室 N 天內的訊息（含已處理過的），其他聊天室與 N 天外的不送', async () => {
  const db = open()
  insertMessages([
    raw('a-processed', 'A', NOW - 2 * DAY),
    raw('a-new', 'A', NOW - 1 * DAY),
    raw('a-too-old', 'A', NOW - 10 * DAY),
    raw('b-new', 'B', NOW - 1 * DAY)
  ], db)
  markProcessed([stored('a-processed'), stored('b-new')], db)
  setTodoExtractEnabled(db, 'A', true)
  setTodoExtractEnabled(db, 'B', true)
  const rec = recorder()
  const result = await refreshChatLastDays('A', 7, { db, nowFn: () => NOW, extractFn: rec.fn })
  assert.equal(result.ok, true)
  assert.deepEqual(rec.calls.flat().sort(), [stored('a-new'), stored('a-processed')].sort())
  assert.equal(result.todo.messages, 2)
})

test('N 的邊界：1 天只含最近一天，365 天涵蓋 10 天前的訊息', async () => {
  const db = open()
  insertMessages([raw('a-2d', 'A', NOW - 2 * DAY), raw('a-10d', 'A', NOW - 10 * DAY)], db)
  setTodoExtractEnabled(db, 'A', true)
  const one = recorder()
  await refreshChatLastDays('A', 1, { db, nowFn: () => NOW, extractFn: one.fn })
  assert.deepEqual(one.calls.flat(), [])
  const all = recorder()
  await refreshChatLastDays('A', 365, { db, nowFn: () => NOW, extractFn: all.fn })
  assert.deepEqual(all.calls.flat().sort(), [stored('a-10d'), stored('a-2d')].sort())
})

test('開關：兩個都關回 disabled 且不送；只開議題不跑待辦；只開待辦不跑議題', async () => {
  const db = open()
  insertMessages([raw('a1', 'A', NOW - DAY)], db)
  ensureGroupTopicsSchema(db)
  setTodoExtractEnabled(db, 'A', false)
  setEnabled(db, 'A', false)
  const rec = recorder()
  const topicCalls = []
  const topicRefresh = async (chatId, sinceMs) => { topicCalls.push({ chatId, sinceMs }); return { ok: true, analyzedCount: 1, batches: 1 } }

  const off = await refreshChatLastDays('A', 7, { db, nowFn: () => NOW, extractFn: rec.fn, topicRefresh })
  assert.equal(off.reason, 'disabled')
  assert.equal(rec.calls.length, 0)
  assert.equal(topicCalls.length, 0)

  setEnabled(db, 'A', true)
  const topicsOnly = await refreshChatLastDays('A', 7, { db, nowFn: () => NOW, extractFn: rec.fn, topicRefresh })
  assert.equal(topicsOnly.todo.ran, false)
  assert.equal(topicsOnly.topics.ran, true)
  assert.equal(rec.calls.length, 0)
  assert.deepEqual(topicCalls, [{ chatId: 'A', sinceMs: NOW - 7 * DAY }])

  setTodoExtractEnabled(db, 'A', true)
  setEnabled(db, 'A', false)
  const todoOnly = await refreshChatLastDays('A', 7, { db, nowFn: () => NOW, extractFn: rec.fn, topicRefresh })
  assert.equal(todoOnly.todo.ran, true)
  assert.equal(todoOnly.topics.ran, false)
  assert.equal(rec.calls.length, 1)
  assert.equal(topicCalls.length, 1)
})

test('done／dismissed 的待辦不會被重建，也不會被改回未完成；重新整理兩次不重複', async () => {
  const db = open()
  insertMessages([raw('m1', 'A', NOW - DAY)], db)
  setTodoExtractEnabled(db, 'A', true)
  const run = () => refreshChatLastDays('A', 7, { db, nowFn: () => NOW, extractFn: aiCreates(stored('m1')) })

  const first = await run()
  assert.equal(first.ok, true)
  const [created] = todoRows(db, 'A')
  assert.equal(todoRows(db, 'A').length, 1)
  assert.equal(created.status, 'pending')

  const second = await run()
  assert.equal(second.ok, true)
  assert.equal(todoRows(db, 'A').length, 1, '同一段訊息第二次重新整理不產生重複未完成待辦')

  updateStatus(created.id, 'done', db)
  const third = await run()
  assert.equal(third.ok, true)
  assert.deepEqual(todoRows(db, 'A'), [{ id: created.id, status: 'done' }], '已完成的待辦不重建、不改回')

  updateStatus(created.id, 'dismissed', db)
  const fourth = await run()
  assert.equal(fourth.ok, true)
  assert.deepEqual(todoRows(db, 'A'), [{ id: created.id, status: 'dismissed' }], '已忽略的待辦不重建、不改回')
})

test('chatRefresh 不會因為 ledger 而跳過已送過的訊息（每次重新整理都送）', async () => {
  const db = open()
  insertMessages([raw('a1', 'A', NOW - DAY)], db)
  setTodoExtractEnabled(db, 'A', true)
  const rec = recorder()
  await refreshChatLastDays('A', 7, { db, nowFn: () => NOW, extractFn: rec.fn })
  await refreshChatLastDays('A', 7, { db, nowFn: () => NOW, extractFn: rec.fn })
  assert.equal(rec.calls.length, 2)
})

test('議題：送出的第一批是視窗內最舊的 20 則（含已處理過的），視窗外與其他聊天室不送；失敗就停', async () => {
  const db = open()
  ensureGroupTopicsSchema(db)
  const rows = []
  for (let i = 0; i < 25; i += 1) rows.push(raw(`w${String(i).padStart(2, '0')}`, 'A', NOW - DAY + i * 1000, `議題訊息 ${i}`))
  rows.push(raw('a-old', 'A', NOW - 10 * DAY, '太舊'))
  rows.push(raw('b-1', 'B', NOW - DAY, '其他聊天室'))
  insertMessages(rows, db)
  markProcessed([stored('w00'), stored('w01')], db)
  setEnabled(db, 'A', true)
  for (let i = 0; i < 100; i += 1) if (advanceIdentityIndex(db, 'A', 'topic', 30)) break

  const userPayloads = []
  const provider = {
    id: 'fake', kind: 'http',
    async complete(request) {
      userPayloads.push(JSON.parse(request.user))
      return { text: '{}', structured: {}, meta: { provider: 'fake', model: 'fake', durationMs: 0 } }
    }
  }
  const service = createGroupTopicsService(db)
  const result = await service.refreshWindow('A', NOW - 7 * DAY, () => provider)
  assert.equal(result.ok, false, '假 provider 回空輸出會被驗證擋下')
  assert.equal(userPayloads.length, 1, '第一批失敗後不再送下一批')
  const sent = userPayloads[0].messages.map((m) => m.msgId)
  assert.equal(sent.length, 20)
  assert.deepEqual(sent, rows.slice(0, 20).map((m) => stored(m.msgId)))
  assert.ok(sent.includes(stored('w00')), '已處理過的訊息也會送')
  assert.ok(!sent.includes(stored('a-old')))
  assert.ok(!sent.includes(stored('b-1')))
})

// ───────── 重新整理的待辦套用規則（F1、F2、P1）與一般路徑守護 ─────────

const SESSION = createHash('sha256').update('chat-refresh-guard-session-v1').digest('hex')

/** 一般抽取路徑（不設 refreshOnly）的單一切片落庫；前置步驟與 test-identity.mjs 的 runTodoApply 相同。 */
function applyNormalPath(db, chatId, msgIds, extract) {
  for (let i = 0; i < 100; i += 1) if (advanceIdentityIndex(db, chatId, 'todo', 30)) break
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='discussion_topics'").get()) {
    for (let i = 0; i < 100; i += 1) if (advanceIdentityIndex(db, chatId, 'topic', 30)) break
  }
  const rows = getMessagesByChatAndIds(chatId, msgIds, db)
  const recalled = recallTodoIdentityCandidates(db, chatId, rows.map((row) => row.text ?? ''), msgIds)
  assert.equal(recalled.ready, true)
  const snapshot = captureIdentitySnapshot(db, chatId, rows, recalled.truncated, recalled.candidateRevisions)
  assert.ok(snapshot)
  // lease 的到期與提交檢查用牆鐘（與 chatRefresh 的 refreshTodos 相同）；固定的 NOW 會讓 lease 立刻過期。
  const started = beginIdentitySourceAttempt(db, chatId, snapshot, JSON.stringify({ source: msgIds }), SESSION, new Date())
  assert.ok(started.lease, started.reason)
  snapshot.sourceLease = started.lease
  const tally = { todosCreated: 0, todosMerged: 0, todosResolvedDone: 0, todosSuggestedDone: 0, createdIds: [], resolvedIds: [], updatedIds: [] }
  applyChatExtract({ db, cfg: getPipelineDefaults(), now: new Date(NOW).toISOString(), identity: {
    snapshot, sourceLease: started.lease, candidates: recalled.candidates, candidatesTruncated: recalled.truncated,
    selectedMessageIds: msgIds, targetType: 'todo', allowedTodoIds: getOpenTodosByChat(chatId, db).map((todo) => todo.id)
  } }, chatId, msgIds, extract, tally)
  return tally
}

const fullRows = (db, chatId) => db.prepare('SELECT id,title,detail,priority,bucket,due_at,status,source_msg_ids FROM todos WHERE chat_id=? ORDER BY id').all(chatId).map((row) => ({ ...row }))

test('F1：草稿的任一來源屬於已完成待辦時，整張草稿跳過；不相干的新訊息仍照常建卡', async () => {
  const db = open()
  insertMessages([raw('m1', 'A', NOW - DAY)], db)
  setTodoExtractEnabled(db, 'A', true)
  await refreshChatLastDays('A', 7, { db, nowFn: () => NOW, extractFn: aiCreates(stored('m1')) })
  const [done] = todoRows(db, 'A')
  updateStatus(done.id, 'done', db)
  insertMessages([raw('m2', 'A', NOW - 0.5 * DAY, '簡報要改成十頁'), raw('m3', 'A', NOW - 0.25 * DAY, '另外約明天吃飯')], db)
  const res = await refreshChatLastDays('A', 7, { db, nowFn: () => NOW, extractFn: async () => ({
    importance: 'action',
    newTodos: [
      { draftRef: 'd1', bucket: 'todo', title: '簡報改十頁', detail: null, priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds: [stored('m1'), stored('m2')] },
      { draftRef: 'd2', bucket: 'todo', title: '明天吃飯', detail: null, priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds: [stored('m3')] }
    ],
    identityDecisions: [
      { draftRef: 'd1', outcome: 'new', candidateType: null, candidateId: null, relationKind: null, reasonCode: 'insufficient_evidence', confidenceBand: 'high', evidenceMsgIds: [stored('m2')] },
      { draftRef: 'd2', outcome: 'new', candidateType: null, candidateId: null, relationKind: null, reasonCode: 'insufficient_evidence', confidenceBand: 'high', evidenceMsgIds: [stored('m3')] }
    ],
    resolved: [], updates: []
  }) })
  assert.equal(res.ok, true)
  assert.deepEqual(rowsOpen(db, 'A').map((row) => row.title), ['明天吃飯'], '含已完成來源的草稿不建卡；不相干的草稿照常建卡')
  assert.deepEqual(todoRows(db, 'A').filter((row) => row.id === done.id), [{ id: done.id, status: 'done' }])
})

test('F2：重新整理時 update_existing 命中未完成待辦，只合併來源訊息，不覆寫標題、內容、優先級或其他欄位', async () => {
  const db = open()
  insertMessages([raw('m1', 'A', NOW - DAY)], db)
  setTodoExtractEnabled(db, 'A', true)
  await refreshChatLastDays('A', 7, { db, nowFn: () => NOW, extractFn: aiCreates(stored('m1')) })
  const [before] = fullRows(db, 'A')
  insertMessages([raw('m2', 'A', NOW - 0.5 * DAY, '簡報改成十頁')], db)
  const res = await refreshChatLastDays('A', 7, { db, nowFn: () => NOW, extractFn: async () => ({
    importance: 'action',
    newTodos: [{ draftRef: 'd1', bucket: 'schedule', title: '完全不同的標題', detail: '新內容', priority: 3, dueAt: '2026-11-20T00:00:00.000Z', confidence: 0.9, sourceMsgIds: [stored('m2')] }],
    identityDecisions: [{ draftRef: 'd1', outcome: 'update_existing', candidateType: 'todo', candidateId: before.id, relationKind: null, reasonCode: 'same_active_action', confidenceBand: 'high', evidenceMsgIds: [stored('m2')] }],
    resolved: [], updates: []
  }) })
  assert.equal(res.ok, true)
  assert.equal(res.todo.todosMerged, 1, '命中既有待辦，走合併而非新建')
  const [after] = fullRows(db, 'A')
  assert.equal(after.id, before.id)
  assert.deepEqual({ ...after, source_msg_ids: null }, { ...before, source_msg_ids: null }, '標題、內容、優先級、bucket、due、狀態都不變')
  assert.deepEqual(JSON.parse(after.source_msg_ids).sort(), [stored('m1'), stored('m2')].sort(), '來源訊息有合併進來')
})

test('P1：resolved 指向非 open 的待辦時只過濾該筆；同一切片的其他草稿照常套用，整批不失敗', async () => {
  const db = open()
  insertMessages([raw('m1', 'A', NOW - DAY)], db)
  setTodoExtractEnabled(db, 'A', true)
  await refreshChatLastDays('A', 7, { db, nowFn: () => NOW, extractFn: aiCreates(stored('m1')) })
  const [done] = todoRows(db, 'A')
  updateStatus(done.id, 'done', db)
  insertMessages([raw('m2', 'A', NOW - 0.5 * DAY, '另一件新事')], db)
  const res = await refreshChatLastDays('A', 7, { db, nowFn: () => NOW, extractFn: async () => ({
    importance: 'action',
    newTodos: [{ draftRef: 'd1', bucket: 'todo', title: '另一件新事', detail: null, priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds: [stored('m2')] }],
    identityDecisions: [{ draftRef: 'd1', outcome: 'new', candidateType: null, candidateId: null, relationKind: null, reasonCode: 'insufficient_evidence', confidenceBand: 'high', evidenceMsgIds: [stored('m2')] }],
    resolved: [{ todoId: done.id, evidence: '已完成', evidenceMsgIds: [stored('m2')] }],
    updates: []
  }) })
  assert.equal(res.ok, true, '非 open 的 resolved 不應讓切片失敗')
  assert.deepEqual(rowsOpen(db, 'A').map((row) => row.title), ['另一件新事'], '其他草稿照常建卡')
  assert.deepEqual(todoRows(db, 'A').filter((row) => row.id === done.id), [{ id: done.id, status: 'done' }])
})

test('守護：一般抽取路徑（refreshOnly 未設）時，update_existing 仍會覆寫未完成待辦的標題與優先級', async () => {
  const db = open()
  insertMessages([raw('g1', 'A', NOW - DAY, '準備簡報')], db)
  setTodoExtractEnabled(db, 'A', true)
  await refreshChatLastDays('A', 7, { db, nowFn: () => NOW, extractFn: aiCreates(stored('g1')) })
  const [before] = fullRows(db, 'A')
  insertMessages([raw('g2', 'A', NOW - 0.5 * DAY, '準備簡報改成十頁')], db)
  const tally = applyNormalPath(db, 'A', [stored('g2')], {
    importance: 'action',
    newTodos: [{ draftRef: 'd1', bucket: 'todo', title: '一般路徑新標題', detail: null, priority: 3, dueAt: null, confidence: 0.9, sourceMsgIds: [stored('g2')] }],
    identityDecisions: [{ draftRef: 'd1', outcome: 'update_existing', candidateType: 'todo', candidateId: before.id, relationKind: null, reasonCode: 'same_active_action', confidenceBand: 'high', evidenceMsgIds: [stored('g2')] }],
    resolved: [], updates: []
  })
  assert.equal(tally.todosMerged, 1)
  const [after] = fullRows(db, 'A')
  assert.equal(after.id, before.id)
  assert.equal(after.title, '一般路徑新標題', '一般路徑仍覆寫標題')
  assert.equal(after.priority, 3, '一般路徑仍覆寫優先級')
  assert.equal(after.status, 'pending')
})

// ───────── 失敗原因保留（AI 未就緒、佇列逾時、議題 transport）─────────

test('AI 尚未就緒：立刻回 ai_unavailable，不送任何抽取請求、也不跑議題', async () => {
  const db = open()
  insertMessages([raw('a1', 'A', NOW - DAY)], db)
  setTodoExtractEnabled(db, 'A', true)
  ensureGroupTopicsSchema(db)
  setEnabled(db, 'A', true)
  const rec = recorder()
  const topicCalls = []
  const topicRefresh = async (chatId, sinceMs) => { topicCalls.push({ chatId, sinceMs }); return { ok: true, analyzedCount: 1, batches: 1 } }
  const result = await refreshChatLastDays('A', 7, { db, nowFn: () => NOW, extractFn: rec.fn, topicRefresh, aiReady: async () => false })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'ai_unavailable')
  assert.equal(rec.calls.length, 0, '沒有任何佇列 request（不進入佇列等待）')
  assert.equal(topicCalls.length, 0)
  assert.equal(result.todo.ran, false)
  assert.equal(result.topics.ran, false)
})

test('待辦段在佇列等待逾時：extract_await_timeout 保留在結果裡，不被吞掉', async () => {
  const db = open()
  insertMessages([raw('a1', 'A', NOW - DAY)], db)
  setTodoExtractEnabled(db, 'A', true)
  const result = await refreshChatLastDays('A', 7, { db, nowFn: () => NOW, aiReady: async () => true, extractFn: async () => { throw new Error('extract_await_timeout') } })
  assert.equal(result.ok, false)
  assert.equal(result.todo.failed, true)
  assert.equal(result.todo.reason, 'extract_await_timeout')
})

test('議題段第一批 transport 失敗：原因保留在 topics.reason，且只呼叫一次（第一批失敗就停）', async () => {
  const db = open()
  ensureGroupTopicsSchema(db)
  insertMessages([raw('t1', 'A', NOW - DAY, '議題訊息')], db)
  setEnabled(db, 'A', true)
  const topicCalls = []
  const topicRefresh = async (chatId) => { topicCalls.push(chatId); return { ok: false, reason: 'transport', analyzedCount: 0, batches: 1 } }
  const result = await refreshChatLastDays('A', 7, { db, nowFn: () => NOW, extractFn: recorder().fn, topicRefresh, aiReady: async () => true })
  assert.equal(result.ok, false)
  assert.equal(result.topics.failed, true)
  assert.equal(result.topics.reason, 'transport')
  assert.equal(topicCalls.length, 1)
})

test('議題第一批失敗：外層 reason 是 analysis_failed，底層 failure.code（transport）優先保留', () => {
  const failed = { ok: false, reason: 'analysis_failed', failure: { stage: 'provider_complete', path: null, code: 'transport' }, analyzedCount: 0, batches: 1 }
  assert.deepEqual(topicRefreshOutcome(failed), { ok: false, reason: 'transport', analyzedCount: 0, batches: 1 })
  assert.deepEqual(topicRefreshOutcome({ ok: false, reason: 'disabled', analyzedCount: 0, batches: 0 }), { ok: false, reason: 'disabled', analyzedCount: 0, batches: 0 })
  assert.deepEqual(topicRefreshOutcome({ ok: true, count: 3, analyzedCount: 20, batches: 1 }), { ok: true, reason: undefined, analyzedCount: 20, batches: 1 })
})

test('畫面短字：AI 無法使用類 → 「AI 無法使用」；限流 → 「AI 忙碌中，稍後再試」；其他沿用現有短字', () => {
  const todoFail = (reason) => ({ reason: undefined, todo: { failed: true, reason }, topics: { failed: false } })
  const topicFail = (reason) => ({ reason: undefined, todo: { failed: false }, topics: { failed: true, reason } })
  for (const reason of ['transport', 'plugin_host_unavailable', 'timeout', 'extract_await_timeout']) {
    assert.equal(refreshFailureText(todoFail(reason)), 'AI 無法使用', `todo ${reason}`)
    assert.equal(refreshFailureText(topicFail(reason)), 'AI 無法使用', `topics ${reason}`)
  }
  assert.equal(refreshFailureText({ reason: 'ai_unavailable', todo: { failed: false }, topics: { failed: false } }), 'AI 無法使用')
  assert.equal(refreshFailureText(todoFail('rate_limited')), 'AI 忙碌中，稍後再試')
  assert.equal(refreshFailureText(topicFail('rate_limited')), 'AI 忙碌中，稍後再試')
  assert.equal(refreshFailureText(todoFail('todo_identity_index_building')), '部分重新整理失敗，請稍後再試')
  assert.equal(refreshFailureText({ reason: 'invalid_days', todo: { failed: false }, topics: { failed: false } }), '重新整理失敗，請稍後再試')
  assert.equal(refreshFailureText({ reason: 'disabled', todo: { failed: false }, topics: { failed: false } }), '待辦與議題都已關閉')
  assert.equal(refreshFailureText({ reason: 'unsupported_chat', todo: { failed: false }, topics: { failed: false } }), '找不到這個聊天室')
})

test('端到端：AI 就緒但議題 transport 失敗，UI 短字是「AI 無法使用」（經 topicRefreshOutcome 與 refreshChatLastDays）', async () => {
  const db = open()
  ensureGroupTopicsSchema(db)
  insertMessages([raw('t1', 'A', NOW - DAY, '議題訊息')], db)
  setEnabled(db, 'A', true)
  const failed = { ok: false, reason: 'analysis_failed', failure: { stage: 'provider_complete', path: null, code: 'transport' }, analyzedCount: 0, batches: 1 }
  const result = await refreshChatLastDays('A', 7, { db, nowFn: () => NOW, extractFn: recorder().fn, aiReady: async () => true, topicRefresh: async () => topicRefreshOutcome(failed) })
  assert.equal(refreshFailureText(result), 'AI 無法使用')
})

function rowsOpen(db, chatId) {
  return db.prepare("SELECT id,title,status FROM todos WHERE chat_id=? AND status NOT IN ('done','dismissed') ORDER BY id").all(chatId).map((row) => ({ ...row }))
}
