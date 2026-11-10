// Extract selection window: only messages from the last TODO_EXTRACT_WINDOW_DAYS days are picked,
// and a few chats that stay deferred inside that window cannot hold every slot of the pick window.
// All times are controlled through an explicit NOW; no test depends on the wall clock.
import assert from 'node:assert/strict'
import test from 'node:test'

import * as defaults from '../../src/main/config/defaults.ts'
import { DEFAULTS } from '../../src/main/config/defaults.ts'
import { openDatabase } from '../../src/main/db/database.ts'
import { getUnprocessedForPipeline, insertMessages, markProcessed } from '../../src/main/db/messages.repo.ts'
import { runOnce } from '../../src/main/pipeline/runOnce.ts'
import { fixedWatchSource } from '../../src/main/pipeline/scheduler.ts'

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 10, 3, 0, 0)

function raw(msgId, chatId, ts) {
  return { msgId, chat: chatId, chatId, isGroup: false, ts, time: new Date(ts).toISOString(), direction: 'in', sender: chatId, text: `請幫我處理 ${msgId}`, contentType: 0 }
}

// Stored msg_id is 'i:' + the LINE message id (schema.ts normalizer); tests compare raw ids.
const rawId = (m) => m.msgId.replace(/^i:/, '')

function freshDb() {
  return openDatabase({ dbPath: ':memory:' }).db
}

const config = { ...DEFAULTS, concurrency: 2 }

/** A sink that records offers. Stuck chats are never marked processed (they stay deferred). */
function recordingSink() {
  const offeredChats = []
  return {
    offeredChats,
    sink: {
      beginCycle() { offeredChats.push([]) },
      offer(input) { offeredChats[offeredChats.length - 1].push(input.chat.chatId) },
      endCycle() {}
    }
  }
}

async function sinkRound(db, sink, messages) {
  return runOnce({
    db,
    config,
    now: () => new Date(NOW).toISOString(),
    watchSource: fixedWatchSource(messages),
    extractFn: async () => { throw new Error('extractFn must not be called in sink mode') },
    extractSink: sink
  })
}

test('window constant is a named 7-day setting in defaults.ts', () => {
  assert.equal(defaults.TODO_EXTRACT_WINDOW_DAYS, 7)
})

test('a message 8 days old is not selected; a message 6 days old is', () => {
  const db = freshDb()
  insertMessages([raw('old8', 'u-a', NOW - 8 * DAY), raw('ok6', 'u-a', NOW - 6 * DAY)], db)
  const picked = getUnprocessedForPipeline(100, db, NOW).map(rawId)
  assert.deepEqual(picked, ['ok6'])
})

test('a large old backlog outside the window does not push new messages out of the pick', () => {
  const db = freshDb()
  const old = []
  for (let c = 0; c < 30; c++) {
    for (let i = 0; i < 80; i++) old.push(raw(`old-${c}-${i}`, `u-old-${c}`, NOW - 30 * DAY + c * HOUR + i * 1000))
  }
  insertMessages(old, db)
  insertMessages([raw('new-1', 'u-new-1', NOW - HOUR), raw('new-2', 'u-new-2', NOW - 2 * HOUR)], db)
  const picked = getUnprocessedForPipeline(2000, db, NOW).map(rawId).sort()
  assert.deepEqual(picked, ['new-1', 'new-2'])
})

test('the pick gives every chat its oldest pending message first, so one chat cannot fill the limit', () => {
  const db = freshDb()
  const rows = []
  for (let c = 0; c < 30; c++) {
    for (let i = 0; i < 80; i++) rows.push(raw(`s-${c}-${i}`, `u-stuck-${c}`, NOW - 2 * DAY + i * 1000))
  }
  rows.push(raw('fresh', 'u-fresh', NOW - HOUR))
  insertMessages(rows, db)
  const picked = getUnprocessedForPipeline(31, db, NOW)
  const chats = new Set(picked.map((m) => m.chatId))
  assert.equal(chats.size, 31, 'all 31 chats appear in a 31-slot pick')
  assert.ok(picked.some((m) => rawId(m) === 'fresh'))
})

test('chats that stay deferred inside the window do not block new messages of other chats within a few rounds', async () => {
  const db = freshDb()
  const stuck = []
  for (let c = 0; c < 30; c++) {
    for (let i = 0; i < 80; i++) stuck.push(raw(`stuck-${c}-${i}`, `u-stuck-${c}`, NOW - 2 * DAY + i * 1000))
  }
  insertMessages(stuck, db)
  const stuckChats = new Set(stuck.map((m) => m.chatId))

  const { offeredChats, sink } = recordingSink()
  const roundsToSee = []
  for (let round = 1; round <= 3; round++) {
    const chat = `u-new-${round}`
    const newMsg = raw(`new-${round}`, chat, NOW - (60 - round) * 60 * 1000)
    await sinkRound(db, sink, [newMsg])
    const offered = offeredChats[offeredChats.length - 1]
    if (offered.includes(chat)) roundsToSee.push(round)
    // Simulate the inbox committing the other (non-stuck) chats, so only the stuck set persists.
    for (const c of offered) {
      if (!stuckChats.has(c)) {
        const ids = getUnprocessedForPipeline(5000, db, NOW).filter((m) => m.chatId === c).map((m) => m.msgId)
        markProcessed(ids, db)
      }
    }
  }
  assert.deepEqual(roundsToSee, [1, 2, 3], 'each new chat is offered in the round it arrives, despite 30 stuck chats')
})

test('after a round the stuck chats keep their pending rows (no bulk UPDATE of old data)', async () => {
  const db = freshDb()
  insertMessages([raw('s-1', 'u-stuck', NOW - 2 * DAY), raw('o-1', 'u-old', NOW - 9 * DAY)], db)
  const { sink } = recordingSink()
  await sinkRound(db, sink, [])
  const row = db.prepare("SELECT processed FROM messages ORDER BY msg_id").all()
  assert.deepEqual(row.map((r) => r.processed), [0, 0], 'deferred and out-of-window rows are left as they are')
})
