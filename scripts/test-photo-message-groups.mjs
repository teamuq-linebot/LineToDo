import assert from 'node:assert/strict'
import test from 'node:test'
import { groupConsecutivePhotoMessages } from '../src/renderer/lib/photoMessageGroups.ts'

const photo = (overrides = {}) => ({
  msgId: 'm1', chatId: 'chat-a', time: '2026-11-11T12:00:00.123Z',
  direction: 'in', sender: 'alice', contentType: 1, ...overrides
})

test('groups adjacent photos with identical chat, sender, direction and exact epoch ms', () => {
  const first = photo({ msgId: 'a' })
  const second = photo({ msgId: 'b', time: '2026-11-11T20:00:00.123+08:00' })
  const third = photo({ msgId: 'c' })
  assert.deepEqual(groupConsecutivePhotoMessages([first, second, third]), [[first, second, third]])
})

test('does not group across timestamp, chat, sender, direction or an intervening message', () => {
  const first = photo({ msgId: 'a' })
  const cases = [
    photo({ msgId: 'b', time: '2026-11-11T12:00:00.124Z' }),
    photo({ msgId: 'b', chatId: 'chat-b' }),
    photo({ msgId: 'b', sender: 'bob' }),
    photo({ msgId: 'b', direction: 'out' }),
  ]
  for (const second of cases) assert.deepEqual(groupConsecutivePhotoMessages([first, second]), [[first], [second]])
  const text = photo({ msgId: 'text', contentType: 0 })
  const afterText = photo({ msgId: 'b' })
  assert.deepEqual(groupConsecutivePhotoMessages([first, text, afterText]), [[first], [text], [afterText]])
})

test('keeps ambiguous or non-displayable rows separate', () => {
  const valid = photo({ msgId: 'a' })
  const invalid = [
    photo({ msgId: undefined }),
    photo({ sender: '' }),
    photo({ time: '12:00' }),
    photo({ time: '2026-11-11T12:00:00.123456Z' }),
    photo({ unsent: true }),
  ]
  for (const row of invalid) assert.deepEqual(groupConsecutivePhotoMessages([valid, row]), [[valid], [row]])
  assert.deepEqual(groupConsecutivePhotoMessages([valid]), [[valid]])
})

test('rejects normalized invalid calendar times while accepting real leap days', () => {
  const first = photo({ msgId: 'leap-a', time: '2024-02-29T12:00:00Z' })
  const sameInstant = photo({ msgId: 'leap-b', time: '2024-02-29T20:00:00+08:00' })
  assert.deepEqual(groupConsecutivePhotoMessages([first, sameInstant]), [[first, sameInstant]])

  const invalidTimes = [
    '2026-02-30T12:00:00Z',
    '2025-02-29T12:00:00Z',
    '2024-04-31T12:00:00Z',
    '2024-13-01T12:00:00Z',
    '2024-02-29T24:00:00Z',
    '2024-02-29T12:00:00+24:00',
    '2024-02-29T12:00:00+08:60',
  ]
  for (const [index, time] of invalidTimes.entries()) {
    const invalid = photo({ msgId: `invalid-${index}`, time })
    assert.deepEqual(groupConsecutivePhotoMessages([first, invalid]), [[first], [invalid]], time)
  }
})
