// Phase 4 repair — extraction throughput: a long chat must be cut into turns that are (nearly) as full as the budget allows,
// not "one message per turn" because recentContext ate the budget.
//   * turns ~= new-message chars / per-turn budget (a lower bound), with recentContext present
//   * recentContext has its own budget cap (default 20% of a turn)
//   * every turn stays <= 7,500 chars (and the 8,000 check before sending still holds: ExtractQueue / orchestrator tests)
import assert from 'node:assert/strict'
import test from 'node:test'

import { buildUserPayload } from '../../src/main/llm/extractPrompt.ts'
import { CONTEXT_BUDGET_RATIO, DEFAULT_MAX_USER_CHARS, partitionExtractInput } from '../../src/plugin/backend/extractQueue.ts'

const MAX = DEFAULT_MAX_USER_CHARS

const dto = (i, text, ts = 1_700_000_000_000 + i * 1000) => ({
  msgId: `m${i}`, chatId: 'u-big', ts, timeIso: new Date(ts).toISOString(), direction: i % 3 === 0 ? 'out' : 'in', sender: i % 3 === 0 ? 'me' : 'Alice',
  text, contentType: 0, processed: false, ingestedAt: '', origFilename: null, fileSize: null, unsent: false
})
const inputOf = (messages, recentContext = [], extra = {}) => ({
  now: '2026-10-01T10:00:00.000', chat: { chatId: 'u-big', name: '大群組', isGroup: true }, newMessages: messages, recentContext, openTodos: [], ...extra
})
/** ~100 Chinese characters, slightly different per message so the lengths are not all identical. */
const hundred = (i) => `第${i}則：` + '請幫我確認一下這件事情的進度，並且在明天中午之前回覆給客戶，謝謝'.repeat(3).slice(0, 94 + (i % 7))

/** The serialized size of one message inside a payload (what a message costs the turn budget). */
function messageCost(message) {
  const base = buildUserPayload(inputOf([], [])).length
  return buildUserPayload(inputOf([message], [])).length - base
}
const baseOverhead = buildUserPayload(inputOf([], [])).length

function lowerBound(messages) {
  const total = messages.reduce((sum, m) => sum + messageCost(m), 0)
  return { total, turns: Math.ceil(total / (MAX - baseOverhead)) }
}

function contextCost(context) {
  return buildUserPayload(inputOf([], context)).length - baseOverhead
}

function scenario(label, { count, contextCount, contextLimit }) {
  test(`throughput: ${label} — turns stay close to the lower bound (new-message chars / per-turn budget), every turn <= 7,500, no message lost or repeated`, () => {
    const messages = Array.from({ length: count }, (_, i) => dto(i + 1, hundred(i + 1)))
    const context = Array.from({ length: contextCount }, (_, i) => dto(900 + i, hundred(900 + i), 1_699_000_000_000 + i * 1000))
    const parts = partitionExtractInput(inputOf(messages, context), { maxChars: MAX, contextLimit })

    const bound = lowerBound(messages)
    // 20% of every turn is reserved for recentContext, so the best possible is bound / 0.8; allow a little slack for the ragged end of each turn
    const ceiling = Math.ceil((bound.turns / (1 - CONTEXT_BUDGET_RATIO)) * 1.1) + 1
    assert.ok(parts.length >= bound.turns, `${parts.length} turns can never beat the lower bound ${bound.turns}`)
    assert.ok(parts.length <= ceiling, `${count} messages x ~100 chars (${bound.total} chars): ${parts.length} turns, lower bound ${bound.turns}, ceiling ${ceiling}`)
    assert.ok(parts.length < count / 4, `nowhere near one turn per message (${parts.length} turns for ${count} messages)`)

    assert.deepEqual(parts.flatMap((p) => p.msgIds), messages.map((m) => m.msgId), 'every message exactly once, in order')
    for (const part of parts) {
      assert.ok(part.user.length <= MAX, `turn payload ${part.user.length} <= ${MAX}`)
      assert.equal(part.truncated, 0, 'normal-sized messages are never cut')
      const parsed = JSON.parse(part.user)
      assert.ok(parsed.recentContext.length <= contextLimit)
    }
  })
}

scenario('200 messages, 10 context messages (the default recentContextLimit)', { count: 200, contextCount: 10, contextLimit: 10 })
scenario('200 messages, 50 context messages (the largest recentContextLimit a user can set)', { count: 200, contextCount: 50, contextLimit: 50 })
scenario('1,000 messages, 30 context messages', { count: 1000, contextCount: 30, contextLimit: 30 })

test('throughput: recentContext has its own budget (default 20% of a turn) — it never crowds the new messages out, on the first turn or any later one', () => {
  const messages = Array.from({ length: 120 }, (_, i) => dto(i + 1, hundred(i + 1)))
  const context = Array.from({ length: 50 }, (_, i) => dto(900 + i, hundred(900 + i)))
  const parts = partitionExtractInput(inputOf(messages, context), { maxChars: MAX, contextLimit: 50 })
  const budget = Math.floor(MAX * CONTEXT_BUDGET_RATIO)
  assert.equal(CONTEXT_BUDGET_RATIO, 0.2)
  for (const [index, part] of parts.entries()) {
    const used = JSON.parse(part.user).recentContext
    assert.ok(used.length > 0, `turn ${index + 1} still carries some context`)
    assert.ok(contextCost(used) <= budget, `turn ${index + 1}: context ${contextCost(used)} chars <= budget ${budget}`)
    // context is the most recent messages (the tail), not an arbitrary subset
    if (index > 0) assert.equal(used.at(-1).msgId, parts[index - 1].msgIds.at(-1))
  }
  // an explicit, smaller cap is honoured too
  const tight = partitionExtractInput(inputOf(messages, context), { maxChars: MAX, contextLimit: 50, contextBudgetChars: 600 })
  for (const part of tight) assert.ok(contextCost(JSON.parse(part.user).recentContext) <= 600)
  assert.ok(tight.length <= parts.length, 'a smaller context budget never makes the turn count worse')
  // and context off means context off
  for (const part of partitionExtractInput(inputOf(messages, context), { maxChars: MAX, contextLimit: 0 })) assert.deepEqual(JSON.parse(part.user).recentContext, [])
})

test('throughput: a single huge context message is cut to the context budget instead of being dropped or crowding out new messages', () => {
  const messages = Array.from({ length: 40 }, (_, i) => dto(i + 1, hundred(i + 1)))
  const context = [dto(900, '先前的長篇說明。'.repeat(2000))]
  const parts = partitionExtractInput(inputOf(messages, context), { maxChars: MAX, contextLimit: 10 })
  const used = JSON.parse(parts[0].user).recentContext
  assert.equal(used.length, 1)
  assert.ok(used[0].text.length > 0 && used[0].text.length < 1500)
  assert.ok(contextCost(used) <= Math.floor(MAX * CONTEXT_BUDGET_RATIO))
  assert.ok(parts[0].msgIds.length >= 15, `the first turn still carries ${parts[0].msgIds.length} new messages`)
})

test('throughput: open todos still cap at half a turn; with them present the new messages still get the rest and turns stay bounded', () => {
  const openTodos = Array.from({ length: 80 }, (_, i) => ({ id: `t${i}`, chatId: 'u-big', bucket: 'todo', status: 'pending', title: `待辦事項 ${i} 的標題`, detail: null, priority: 2, dueAt: null, sourceMsgIds: [], confidence: 1, completionEvidence: null, createdAt: '', updatedAt: '', resolvedAt: null }))
  const messages = Array.from({ length: 200 }, (_, i) => dto(i + 1, hundred(i + 1)))
  const context = Array.from({ length: 10 }, (_, i) => dto(900 + i, hundred(900 + i)))
  const parts = partitionExtractInput(inputOf(messages, context, { openTodos }), { maxChars: MAX, contextLimit: 10 })
  assert.deepEqual(parts.flatMap((p) => p.msgIds), messages.map((m) => m.msgId))
  for (const part of parts) assert.ok(part.user.length <= MAX)
  // every turn repeats the (capped) open todos and carries <= 20% context; the rest is for new messages
  const openCost = buildUserPayload(inputOf([], [], { openTodos: JSON.parse(parts[0].user).openTodos.map((t) => openTodos.find((o) => o.id === t.todoId)) })).length - baseOverhead
  assert.ok(openCost <= MAX / 2, `open todos cost ${openCost} chars per turn (cap: half a turn)`)
  const room = MAX - baseOverhead - openCost - Math.floor(MAX * CONTEXT_BUDGET_RATIO)
  const ceiling = Math.ceil((lowerBound(messages).total / room) * 1.15) + 1
  assert.ok(parts.length <= ceiling, `${parts.length} turns for 200 messages with open todos present (room per turn ${room}, ceiling ${ceiling})`)
})

test('throughput: the old failure shape — big messages + a full context — no longer degrades to one message per turn', () => {
  // ~680 chars per message: with the old rule, 10 context messages (~6,800 chars) left room for exactly 1 new message every turn
  const messages = Array.from({ length: 24 }, (_, i) => dto(i + 1, `第 ${i + 1} 則：` + '很長的需求描述，'.repeat(60)))
  const context = Array.from({ length: 10 }, (_, i) => dto(900 + i, '先前的需求描述，'.repeat(60)))
  const parts = partitionExtractInput(inputOf(messages, context), { maxChars: MAX, contextLimit: 10 })
  const sizes = parts.map((p) => p.msgIds.length)
  assert.ok(parts.length <= 8, `${parts.length} turns (${sizes.join(',')}) for 24 x ~680 chars`)
  assert.ok(sizes.slice(0, -1).every((n) => n >= 5), `every full turn carries >= 5 messages: ${sizes.join(',')}`)
  assert.deepEqual(parts.flatMap((p) => p.msgIds), messages.map((m) => m.msgId))
})

test('throughput: one message larger than a whole turn is still cut to fit (the 8,000-char limit can never be hit by a payload we build)', () => {
  const parts = partitionExtractInput(inputOf([dto(1, '字'.repeat(40_000))], [dto(900, hundred(900))]), { maxChars: MAX, contextLimit: 10 })
  assert.equal(parts.length, 1)
  assert.ok(parts[0].user.length <= MAX)
  assert.equal(parts[0].truncated, 1)
})
