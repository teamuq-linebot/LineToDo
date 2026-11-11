import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { chatMessageTimeLabel, compareChatMessageTimes } from '../src/renderer/lib/chatList.ts'
import { listChats } from '../src/main/db/chats.repo.ts'
import { insertMessages } from '../src/main/db/messages.repo.ts'
import { upsertChat } from '../src/main/db/chats.repo.ts'
import { openFixture } from './plugin/combined-queue-harness.mjs'

const ts = (value) => Date.parse(value)

test('listChats reports the newest stored message timestamp independently of ingestion time', () => {
  const { db, close } = openFixture()
  try {
    const actualOld = ts('2026-11-09T09:00:00')
    const actualNew = ts('2026-11-10T10:00:00')
    insertMessages([
      { msgId: 'old', chat: '舊對話', chatId: 'old-chat', isGroup: false, ts: actualOld, time: '2026-11-09T09:00:00', direction: 'in', sender: 'A', text: 'old', contentType: 0 },
      { msgId: 'new', chat: '新對話', chatId: 'new-chat', isGroup: false, ts: actualNew, time: '2026-11-10T10:00:00', direction: 'in', sender: 'B', text: 'new', contentType: 0 }
    ], db)
    // A subsequent old-history ingestion updates lastSeenAt to now, but not the latest-message metadata.
    upsertChat({ chatId: 'old-chat', name: '舊對話', isGroup: false, seenAt: '2026-11-11T11:59:00.000Z' }, db)
    const chats = Object.fromEntries(listChats(db).map((chat) => [chat.chatId, chat]))
    assert.equal(chats['old-chat'].lastSeenAt, '2026-11-11T11:59:00.000Z')
    assert.equal(chats['old-chat'].latestMessageTs, actualOld)
    assert.equal(chats['new-chat'].latestMessageTs, actualNew)
    assert.ok(compareChatMessageTimes(chats['new-chat'].latestMessageTs, chats['old-chat'].latestMessageTs) < 0)
    assert.ok(compareChatMessageTimes(chats['old-chat'].latestMessageTs, null) < 0)
    assert.ok(compareChatMessageTimes(null, chats['old-chat'].latestMessageTs) > 0)
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT c.*, (SELECT MAX(m.ts) FROM messages m WHERE m.chat_id = c.chat_id) AS latest_message_ts FROM chats c`).all()
    assert.ok(plan.some((row) => String(row.detail).includes('idx_messages_chat_ts_msg')), JSON.stringify(plan))
  } finally { close() }
})

test('chat labels use HH:mm today, explicit year-bearing dates before today, and preserve unknown time', () => {
  const now = new Date(2026, 10, 11, 12, 0)
  assert.equal(chatMessageTimeLabel(new Date(2026, 10, 11, 9, 7).getTime(), now), '09:07')
  const yesterday = chatMessageTimeLabel(new Date(2026, 10, 10, 9, 7).getTime(), now)
  assert.match(yesterday, /2026/)
  assert.notEqual(yesterday, '09:07')
  const priorYear = chatMessageTimeLabel(new Date(2025, 11, 31, 23, 50).getTime(), now)
  assert.match(priorYear, /2025/)
  assert.equal(chatMessageTimeLabel(null, now), '—')
  assert.equal(chatMessageTimeLabel(Number.NaN, now), '—')
})

test('production conversation ordering and labels no longer use lastSeenAt fallback', async () => {
  const source = await readFile(new URL('../src/renderer/components/MessageStream.tsx', import.meta.url), 'utf8')
  assert.match(source, /compareChatMessageTimes\(a\.latestMessageTs, b\.latestMessageTs\)/)
  assert.match(source, /chatMessageTimeLabel\(chat\.latestMessageTs \?\? null\)/)
  assert.doesNotMatch(source, /Date\.parse\(a\.lastSeenAt\)|lastSeenAt\.slice\(11, 16\)/)
})
