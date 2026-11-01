import assert from 'node:assert/strict'
import test from 'node:test'

import { chatName, senderName } from '../src/main/line/engine/linedb.ts'

function makeDb({ chat = null, member = null } = {}) {
  return {
    prepare(sql) {
      return {
        get(...args) {
          if (sql.includes('FROM _groupChat')) return undefined
          if (sql.includes('FROM _squareChat WHERE _squareChatMid=?')) return args[0] === 'square-chat' ? chat : undefined
          if (sql.includes('JOIN _squareMember')) return args[0] === 'square-chat' && args[1] === 'p-member' ? member : undefined
          if (sql.includes('FROM _square WHERE')) return undefined
          if (sql.includes('FROM _contact')) return undefined
          throw new Error(`unexpected query: ${sql}`)
        },
      }
    },
  }
}

test('resolves Square chat display name from _squareChat using canonical chat MID', () => {
  const db = makeDb({ chat: { _name: '可讀的社群聊天室' } })
  assert.equal(chatName(db, 'square-chat'), '可讀的社群聊天室')
})

test('resolves sender display name from membership in the active Square chat', () => {
  const db = makeDb({ chat: { _name: '可讀的社群聊天室' }, member: { _displayName: '成員名稱' } })
  assert.equal(senderName(db, 'square-chat', 'p-member'), '成員名稱')
})

test('returns null when Square metadata has no name instead of inventing one', () => {
  const db = makeDb()
  assert.equal(chatName(db, 'square-chat'), null)
  assert.equal(senderName(db, 'square-chat', 'p-missing'), null)
})
