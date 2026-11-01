import assert from 'node:assert/strict'
import { test } from 'node:test'
import { displayChatName } from '../src/renderer/lib/displayChatName.ts'

test('preserves a real source name', () => {
  assert.equal(displayChatName('熟悉的群組', 'm123', true), '熟悉的群組')
})

test('hides a raw canonical room id behind a truthful fallback', () => {
  assert.equal(displayChatName('m123', 'm123', true), '未命名群組')
})

test('handles a missing direct chat label without exposing its id', () => {
  assert.equal(displayChatName(null, 'u123', false), 'LINE 聯絡人')
})

test('trims whitespace and uses fallback for empty metadata', () => {
  assert.equal(displayChatName('  ', 'c123', true), '未命名群組')
})
