import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createDefaultChatProfileConfig } from '../../src/shared/chatProfiles.ts'
import { build } from 'esbuild'
import { byAttr, byText, install, reactProps, walk } from './fixtures/mini-dom.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')
const dom = install()
const work = mkdtempSync(join(tmpdir(), 'chat-profile-ui-'))
test.after(() => { rmSync(work, { recursive: true, force: true }); dom.restore() })
const outfile = join(work, 'ui.mjs')
await build({ entryPoints: [resolve(ROOT, 'scripts/plugin/fixtures/chat-prompt-entry.tsx')], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node24', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty' }, logLevel: 'error', absWorkingDir: ROOT, banner: { js: "import { createRequire as __r } from 'node:module'; const require = __r(import.meta.url);" } })
const ui = await import(pathToFileURL(outfile).href)
const wait = (ms = 20) => new Promise(r => setTimeout(r, ms))
const nature = 'mixed_unclassified'
function snapshot(chatId, n = nature) { return { chatId, chatKind: 'group', natureId: n, natureLabel: '混合／未分類', todo: { instruction: '合成待辦規則', source: 'matrix' }, topic: { instruction: '合成議題規則', source: 'matrix' }, myName: { value: null, source: 'none' }, revision: 'snapshot-r1', archivedNature: false } }
function fixtureApi({ stale = false, legacy = false } = {}) {
  let rev = stale ? 'chat-r2' : 'chat-r1'
  let chat = legacy ? null : { natureId: nature, todoOverride: stale ? 'R2 專用待辦' : null, topicOverride: null, revision: rev, resetLegacyTodo: false }
  let current = { ...snapshot('chat-a'), revision: stale ? 'snapshot-r2' : 'snapshot-r1', todo: stale ? { instruction: 'R2 專用待辦', source: 'chat' } : legacy ? { instruction: '既有 legacy chat 規則', source: 'legacy' } : snapshot('chat-a').todo }
  const config = createDefaultChatProfileConfig()
  config.matrix.group.work_project = { todoInstruction: '工作待辦模板', topicInstruction: '工作議題模板' }
  const calls = []; let suggestionResolve
  const profiles = {
    resolve: async id => ({ ...current, chatId: id }), getChat: async () => chat,
    getConfig: async () => config,
    suggestRule: async (id, kind, goal, expectedProfileRevision, options) => { calls.push({ suggest: true, id, kind, goal, expectedProfileRevision, options }); return new Promise(resolve => { suggestionResolve = () => resolve({ kind, chatKind: 'group', natureId: options.natureId, baseRule: options.draftRule, baseProfileRevision: expectedProfileRevision, draftRule: 'AI 建議規則', changes: ['保留責任資訊'], modelId: 'synthetic' }) }) },
    saveChat: async (id, value, expected) => { calls.push({ id, value, expected }); if (expected !== rev) throw new Error('revision_conflict'); rev = 'chat-r2'; chat = { ...value, revision: rev }; current = { ...snapshot(id, value.natureId), revision: 'snapshot-r2', todo: { instruction: value.todoOverride ?? '工作待辦模板', source: value.todoOverride ? 'chat' : 'matrix' }, topic: { instruction: value.topicOverride ?? '工作議題模板', source: value.topicOverride ? 'chat' : 'matrix' } }; return chat }
  }
  return { api: { hostAi: { profiles } }, calls, config, resolveSuggestion: () => suggestionResolve?.() }
}
const body = root => walk(root).map(el => el.textContent).join(' ')
const getEditor = root => walk(root).find(el => el.getAttribute('aria-label') === 'Prompt 編輯器')
const getNature = root => walk(root).find(el => el.getAttribute('aria-label') === '性質')

test('單編輯區預設議題；待辦／議題草稿分頁隔離，marker 僅顯示乾淨內文', async () => {
  const { api } = fixtureApi()
  const view = ui.mount(ui.chatPromptScene(api, 'chat-single'))
  try {
    for (let i = 0; i < 100 && !getEditor(view.container); i++) await wait()
    assert.ok(getEditor(view.container))
    assert.equal(walk(view.container).filter(el => el.getAttribute('aria-label') === 'Prompt 編輯器').length, 1)
    assert.equal(reactProps(getEditor(view.container)).value, '合成議題規則')
    assert.equal(byText(view.container, '帶入規則類型'), null)
    assert.equal(byText(view.container, '原規則'), null)
    assert.equal(byText(view.container, '議題', 'button') != null, true)
    const topic = getEditor(view.container)
    reactProps(topic).onChange({ target: { value: '未儲存議題草稿' } }); await wait()
    reactProps(byText(view.container, '待辦', 'button')).onClick({ target: getEditor(view.container) }); await wait()
    assert.equal(reactProps(getEditor(view.container)).value, '合成待辦規則')
    reactProps(byText(view.container, '議題', 'button')).onClick({ target: getEditor(view.container) }); await wait()
    assert.equal(reactProps(getEditor(view.container)).value, '未儲存議題草稿')
  } finally { view.unmount() }
})

test('性質專用內容只確認一次；取消回復，保留與換模板都作用於聊天室兩 kind', async () => {
  const fixture = fixtureApi(); fixture.api.hostAi.profiles.resolve = async id => ({ ...snapshot(id), todo: { instruction: '專用待辦', source: 'chat' } }); fixture.api.hostAi.profiles.getChat = async () => ({ natureId: nature, todoOverride: '專用待辦', topicOverride: null, revision: 'chat-r1' })
  const view = ui.mount(ui.chatPromptScene(fixture.api, 'nature-choice'))
  try {
    for (let i = 0; i < 100 && !getEditor(view.container); i++) await wait()
    reactProps(getNature(view.container)).onChange({ target: { value: 'work_project' } }); await wait()
    assert.ok(byAttr(view.container, 'data-testid', 'chat-nature-confirm'))
    reactProps(byText(view.container, '取消', 'button')).onClick({ target: getNature(view.container) }); await wait()
    assert.equal(reactProps(getNature(view.container)).value, nature)
    reactProps(getNature(view.container)).onChange({ target: { value: 'work_project' } }); await wait()
    reactProps(byText(view.container, '保留目前內容', 'button')).onClick({ target: getNature(view.container) }); await wait()
    assert.equal(reactProps(getNature(view.container)).value, 'work_project')
    reactProps(byText(view.container, '待辦', 'button')).onClick({ target: getEditor(view.container) }); await wait()
    assert.equal(reactProps(getEditor(view.container)).value, '專用待辦')
    reactProps(byText(view.container, '議題', 'button')).onClick({ target: getEditor(view.container) }); await wait()
    reactProps(getNature(view.container)).onChange({ target: { value: 'social_life' } }); await wait()
    reactProps(byText(view.container, '換成新模板', 'button')).onClick({ target: getNature(view.container) }); await wait()
    assert.equal(reactProps(getEditor(view.container)).value, fixture.config.matrix.group.social_life.topicInstruction)
    reactProps(byText(view.container, '儲存', 'button')).onClick({ target: getEditor(view.container) }); await wait(50)
    assert.equal(fixture.calls.filter(c => !c.suggest).length, 1)
    assert.equal(fixture.calls.find(c => !c.suggest).value.todoOverride, fixture.config.matrix.group.social_life.todoInstruction)
    assert.equal(fixture.calls.find(c => !c.suggest).value.topicOverride, null)
  } finally { view.unmount() }
})

test('legacy chat-only 規則取消與保留不丟資料，只有換模板可明確替換', async () => {
  const fixture = fixtureApi({ legacy: true })
  const view = ui.mount(ui.chatPromptScene(fixture.api, 'legacy-nature'))
  try {
    for (let i = 0; i < 100 && !getEditor(view.container); i++) await wait()
    reactProps(getNature(view.container)).onChange({ target: { value: 'work_project' } }); await wait()
    assert.ok(byAttr(view.container, 'data-testid', 'chat-nature-confirm'))
    reactProps(byText(view.container, '取消', 'button')).onClick({ target: getNature(view.container) }); await wait()
    assert.equal(reactProps(getNature(view.container)).value, nature)
    reactProps(byText(view.container, '待辦', 'button')).onClick({ target: getEditor(view.container) }); await wait()
    assert.equal(reactProps(getEditor(view.container)).value, '既有 legacy chat 規則')
    reactProps(getNature(view.container)).onChange({ target: { value: 'work_project' } }); await wait()
    reactProps(byText(view.container, '保留目前內容', 'button')).onClick({ target: getNature(view.container) }); await wait()
    assert.equal(reactProps(getEditor(view.container)).value, '既有 legacy chat 規則')
    reactProps(byText(view.container, '儲存', 'button')).onClick({ target: getEditor(view.container) }); await wait(60)
    const saved = fixture.calls.find(call => !call.suggest)
    assert.equal(fixture.calls.filter(call => !call.suggest).length, 1)
    assert.equal(saved.value.natureId, 'work_project')
    assert.equal(saved.value.todoOverride, '既有 legacy chat 規則')
  } finally { view.unmount() }
})

test('legacy chat-only 明確換模板後改用新 nature 的兩份 fallback', async () => {
  const fixture = fixtureApi({ legacy: true })
  const view = ui.mount(ui.chatPromptScene(fixture.api, 'legacy-replace'))
  try {
    for (let i = 0; i < 100 && !getEditor(view.container); i++) await wait()
    reactProps(getNature(view.container)).onChange({ target: { value: 'work_project' } }); await wait()
    reactProps(byText(view.container, '換成新模板', 'button')).onClick({ target: getNature(view.container) }); await wait()
    reactProps(byText(view.container, '儲存', 'button')).onClick({ target: getEditor(view.container) }); await wait(60)
    const saved = fixture.calls.find(call => !call.suggest)
    assert.equal(fixture.calls.filter(call => !call.suggest).length, 1)
    assert.equal(saved.value.natureId, 'work_project')
    assert.equal(saved.value.todoOverride, null)
    assert.equal(saved.value.topicOverride, null)
  } finally { view.unmount() }
})

test('AI 使用目前可見 draft／nature options；建議可取消或套用，只有儲存執行一次 CAS', async () => {
  const fixture = fixtureApi()
  const view = ui.mount(ui.chatPromptScene(fixture.api, 'chat-ai'))
  try {
    for (let i = 0; i < 100 && !getEditor(view.container); i++) await wait()
    reactProps(getNature(view.container)).onChange({ target: { value: 'work_project' } }); await wait()
    reactProps(getEditor(view.container)).onChange({ target: { value: '手改中的 B 議題草稿' } }); await wait()
    const goal = walk(view.container).find(el => el.getAttribute('aria-label') === '改善需求')
    reactProps(goal).onChange({ target: { value: '保留責任' } }); await wait()
    const ai = byText(view.container, 'AI 幫改', 'button')
    reactProps(ai).onClick({ target: ai }); await wait()
    assert.deepEqual(fixture.calls.find(c => c.suggest).options, { draftRule: '手改中的 B 議題草稿', natureId: 'work_project' })
    fixture.resolveSuggestion(); await wait(60)
    assert.equal(reactProps(getEditor(view.container)).value, 'AI 建議規則')
    assert.equal(reactProps(getEditor(view.container)).readOnly, true)
    assert.equal(fixture.calls.filter(c => !c.suggest).length, 0)
    reactProps(byText(view.container, '套用建議', 'button')).onClick({ target: getEditor(view.container) }); await wait()
    assert.equal(reactProps(getEditor(view.container)).value, 'AI 建議規則')
    reactProps(ai).onClick({ target: ai }); await wait()
    fixture.resolveSuggestion(); await wait(60)
    reactProps(byText(view.container, '取消', 'button')).onClick({ target: getEditor(view.container) }); await wait()
    assert.equal(reactProps(getEditor(view.container)).value, 'AI 建議規則')
    reactProps(byText(view.container, '儲存', 'button')).onClick({ target: getEditor(view.container) }); await wait(60)
    assert.equal(fixture.calls.filter(c => !c.suggest).length, 1)
    assert.equal(fixture.calls.find(c => !c.suggest).value.natureId, 'work_project')
    assert.equal(fixture.calls.find(c => !c.suggest).value.todoOverride, null)
    assert.equal(fixture.calls.find(c => !c.suggest).value.topicOverride, 'AI 建議規則')
    assert.equal(fixture.calls.find(c => !c.suggest).expected, 'chat-r1')
  } finally { view.unmount() }
})

test('取消中的 AI request 不接收延遲回覆，也不改寫編輯器', async () => {
  const fixture = fixtureApi()
  const view = ui.mount(ui.chatPromptScene(fixture.api, 'chat-ai-cancel'))
  try {
    for (let i = 0; i < 100 && !getEditor(view.container); i++) await wait()
    const before = reactProps(getEditor(view.container)).value
    reactProps(walk(view.container).find(el => el.getAttribute('aria-label') === '改善需求')).onChange({ target: { value: '合成取消' } }); await wait()
    const ai = byText(view.container, 'AI 幫改', 'button')
    reactProps(ai).onClick({ target: ai }); await wait()
    const cancel = byText(view.container, '取消', 'button')
    reactProps(cancel).onClick({ target: cancel }); await wait()
    fixture.resolveSuggestion(); await wait(40)
    assert.equal(reactProps(getEditor(view.container)).value, before)
    assert.equal(byAttr(view.container, 'data-testid', 'chat-profile-suggestion'), null)
    assert.equal(fixture.calls.filter(c => !c.suggest).length, 0)
  } finally { view.unmount() }
})

test('stale draft discard 等待最新 snapshot 時保持鎖定，完成後跨 remount 不回復舊稿', async () => {
  const fixture = fixtureApi()
  const view = ui.mount(ui.chatPromptScene(fixture.api, 'chat-f1'))
  try {
    for (let i = 0; i < 100 && !getEditor(view.container); i++) await wait()
    reactProps(getEditor(view.container)).onChange({ target: { value: 'local draft' } }); await wait()
  } finally { view.unmount() }
  const stale = fixtureApi({ stale: true })
  const profiles = stale.api.hostAi.profiles; const resolve = profiles.resolve; const getChat = profiles.getChat; let release; let gate
  profiles.resolve = async (...args) => { if (gate) await gate; return resolve(...args) }
  profiles.getChat = async (...args) => { if (gate) await gate; return getChat(...args) }
  const staleView = ui.mount(ui.chatPromptScene(stale.api, 'chat-f1'))
  try {
    for (let i = 0; i < 100 && !byAttr(staleView.container, 'data-testid', 'chat-profile-stale-draft'); i++) await wait()
    assert.ok(byAttr(staleView.container, 'data-testid', 'chat-profile-stale-draft'))
    gate = new Promise(r => { release = r })
    const discard = byText(staleView.container, '丟棄舊草稿並採用目前設定', 'button')
    reactProps(discard).onClick({ target: discard }); await wait(40)
    assert.ok(byAttr(staleView.container, 'data-testid', 'chat-profile-stale-draft'))
    assert.equal(reactProps(byText(staleView.container, '儲存', 'button')).disabled, true)
    release(); gate = null; await wait(80)
    assert.equal(byAttr(staleView.container, 'data-testid', 'chat-profile-unsaved'), null)
  } finally { staleView.unmount() }
  const remount = ui.mount(ui.chatPromptScene(stale.api, 'chat-f1'))
  try {
    for (let i = 0; i < 100 && !getEditor(remount.container); i++) await wait()
    assert.equal(byAttr(remount.container, 'data-testid', 'chat-profile-unsaved'), null)
    assert.equal(byAttr(remount.container, 'data-testid', 'chat-profile-stale-draft'), null)
    assert.equal(stale.calls.filter(c => !c.suggest).length, 0, 'discard only rebases local draft and never writes')
  } finally { remount.unmount() }
})
