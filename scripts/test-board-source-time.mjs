import assert from 'node:assert/strict'
import test from 'node:test'

import { openDatabase } from '../src/main/db/database.ts'
import { insertMessages } from '../src/main/db/messages.repo.ts'
import { deriveMsgId } from '../src/main/db/schema.ts'
import { createRepositories } from '../src/main/db/repositories.ts'
import { createTodo } from '../src/main/db/todos.repo.ts'
import { todoTriggerLabel } from '../src/renderer/components/Board/sourceTime.ts'

function message(index, chatId, ts) {
  const time = new Date(ts).toISOString()
  return { msgId: `fixture-${index}`, chat: chatId, chatId, isGroup: false, ts, time, direction: 'in', sender: chatId, text: 'source', contentType: 0 }
}

function labelTime(value) {
  const date = new Date(value)
  const pad = (part) => String(part).padStart(2, '0')
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

test('production todo list maps bounded explicit source timestamps and labels source/missing cases honestly', (t) => {
  const opened = openDatabase({ dbPath: ':memory:' })
  t.after(() => opened.close())
  const { db } = opened
  const repositories = createRepositories(db)
  const base = Date.UTC(2026, 10, 11, 2, 0)
  const later = message(1, 'chat-a', base + 60_000)
  const earlier = message(2, 'chat-a', base)
  const otherChat = message(3, 'chat-b', base - 60_000)
  insertMessages([later, earlier, otherChat], db)

  const multi = createTodo({
    chatId: 'chat-a', bucket: 'todo', title: '多來源',
    sourceMsgIds: [deriveMsgId(later), 'missing-source', deriveMsgId(earlier), deriveMsgId(otherChat)]
  }, db)
  const missing = createTodo({ chatId: 'chat-a', bucket: 'todo', title: '來源已缺失', sourceMsgIds: ['missing-source'] }, db)
  const none = createTodo({ chatId: 'chat-a', bucket: 'todo', title: '無來源', sourceMsgIds: [] }, db)
  const capped = createTodo({
    chatId: 'chat-a', bucket: 'todo', title: '來源上限',
    sourceMsgIds: [...Array.from({ length: 100 }, (_, index) => `missing-${index}`), deriveMsgId(earlier)]
  }, db)

  const listed = repositories.todos.list({ statuses: ['pending'] })
  const byId = new Map(listed.map((todo) => [todo.id, todo]))
  assert.equal(byId.get(multi.id).sourceTriggeredAt, base, 'multi-source uses the earliest available same-chat timestamp')
  assert.equal(byId.get(missing.id).sourceTriggeredAt, null, 'missing source row has no timestamp')
  assert.equal(byId.get(none.id).sourceTriggeredAt, null, 'an empty source list has no timestamp')
  assert.equal(byId.get(capped.id).sourceTriggeredAt, null, 'only the first 100 explicit source IDs are queried')
  assert.equal(todoTriggerLabel(byId.get(multi.id)), `觸發 ${labelTime(base)}`)
  assert.match(todoTriggerLabel(byId.get(missing.id)), /^建立 /)
  assert.match(todoTriggerLabel(byId.get(none.id)), /^建立 /)
})
