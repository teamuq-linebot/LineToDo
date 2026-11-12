import test from 'node:test'
import assert from 'node:assert/strict'
import { importChatTemplate, CHAT_TEMPLATE_IMPORT_MAX_CHARS, cleanChatRuleMarkers } from '../../src/shared/chatTemplateImport.ts'

const run = (draft, template = '性質模板', kind = 'todo', natureId = 'work_project') => importChatTemplate({ draft, template, kind, chatKind: 'group', natureId })

test('空草稿會建立受控區塊且重複匯入冪等', () => {
  const first = run('')
  assert.equal(first.ok, true)
  if (!first.ok) return
  assert.match(first.draft, /【性質規則匯入區：todo；group\/work_project；開始】/)
  assert.equal(first.draft.includes('性質模板'), true)
  const second = run(first.draft)
  assert.deepEqual(second, { ok: true, draft: first.draft, changed: false })
})

test('保留專用人工前後文並只更新同一 kind 區塊', () => {
  const initial = run('前方人工文字')
  assert.equal(initial.ok, true)
  if (!initial.ok) return
  assert.match(initial.draft, /^前方人工文字\n\n/)
  const withTrailingHuman = `${initial.draft}\n\n後方人工文字`
  const changed = run(withTrailingHuman, '新模板', 'todo', 'social_life')
  assert.equal(changed.ok, true)
  if (!changed.ok) return
  assert.match(changed.draft, /前方人工文字/)
  assert.match(changed.draft, /後方人工文字/)
  assert.match(changed.draft, /group\/social_life/)
  assert.match(changed.draft, /新模板/)
  assert.doesNotMatch(changed.draft, /group\/work_project/)
})

test('todo 與 topic 區塊互相保留', () => {
  const todo = run('todo human')
  assert.equal(todo.ok, true)
  if (!todo.ok) return
  const topic = run(todo.draft, 'topic template', 'topic')
  assert.equal(topic.ok, true)
  if (!topic.ok) return
  assert.match(topic.draft, /todo human/)
  assert.match(topic.draft, /性質規則匯入區：todo/)
  assert.match(topic.draft, /性質規則匯入區：topic/)
  const topicSection = topic.draft.slice(topic.draft.indexOf('【性質規則匯入區：topic'))
  const updatedTodo = run(topic.draft, 'updated todo template', 'todo', 'social_life')
  assert.equal(updatedTodo.ok, true)
  if (!updatedTodo.ok) return
  assert.ok(updatedTodo.draft.endsWith(topicSection), 'replacing todo keeps the topic block byte-for-byte')
  const updatedTopic = run(updatedTodo.draft, 'updated topic template', 'topic', 'social_life')
  assert.equal(updatedTopic.ok, true)
  if (!updatedTopic.ok) return
  assert.match(updatedTopic.draft, /updated todo template/)
  assert.match(updatedTopic.draft, /updated topic template/)
})

test('marker 衝突、空模板、無效來源與長度超限均拒絕', () => {
  const conflict = run('人工【性質規則匯入區：todo；手動偽造】文字')
  assert.deepEqual(conflict, { ok: false, code: 'marker_conflict' })
  assert.deepEqual(run('', '   '), { ok: false, code: 'missing_template' })
  assert.deepEqual(run('', '模板【性質規則匯入區：todo；偽造】'), { ok: false, code: 'marker_conflict' })
  const originalDraft = '原始草稿'
  assert.deepEqual(run(originalDraft, 'topic 模板【性質規則匯入區：topic；group/work_project；開始】內容【性質規則匯入區：topic；結束】'), { ok: false, code: 'marker_conflict' })
  assert.equal(originalDraft, '原始草稿', 'rejecting a template never changes its input draft')
  assert.deepEqual(run(originalDraft, 'todo 模板【性質規則匯入區：todo；group/work_project；開始】內容【性質規則匯入區：todo；結束】', 'topic'), { ok: false, code: 'marker_conflict' })
  assert.deepEqual(run(originalDraft, '不完整前綴【性質規則匯入區：'), { ok: false, code: 'marker_conflict' })
  assert.deepEqual(run(originalDraft, 'topic 不完整前綴【性質規則匯入區：topic；'), { ok: false, code: 'marker_conflict' })
  assert.deepEqual(importChatTemplate({ draft: '', template: 'x', kind: 'todo', chatKind: 'group', natureId: '../bad' }), { ok: false, code: 'invalid_source' })
  const tooLong = run('a'.repeat(CHAT_TEMPLATE_IMPORT_MAX_CHARS - 5))
  assert.deepEqual(tooLong, { ok: false, code: 'too_long' })
})

test('舊 controlled markers 隱藏但完整保留業務文字；不能安全解析時回報衝突', () => {
  const imported = run('前方文字')
  assert.equal(imported.ok, true)
  if (!imported.ok) return
  const cleaned = cleanChatRuleMarkers(imported.draft, 'todo')
  assert.deepEqual(cleaned, { ok: true, text: '前方文字\n\n性質模板\n' })
  assert.deepEqual(cleanChatRuleMarkers('開頭【性質規則匯入區：todo；壞標記】內文', 'todo'), { ok: false, code: 'marker_conflict' })
  assert.deepEqual(cleanChatRuleMarkers(imported.draft, 'topic'), { ok: false, code: 'marker_conflict' })
})
