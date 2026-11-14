import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { byAttr, byText, install, reactProps, walk } from './fixtures/mini-dom.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')
const dom = install()
const work = mkdtempSync(join(tmpdir(), 'profile-matrix-ui-'))
test.after(() => { rmSync(work, { recursive: true, force: true }); dom.restore() })
const outfile = join(work, 'ui.mjs')
await build({ entryPoints: [resolve(ROOT, 'scripts/plugin/fixtures/ui-effects-entry.tsx')], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node24', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty' }, logLevel: 'error', absWorkingDir: ROOT, banner: { js: "import { createRequire as __r } from 'node:module'; const require = __r(import.meta.url);" } })
const ui = await import(pathToFileURL(outfile).href)
const wait = (ms = 20) => new Promise(r => setTimeout(r, ms))
const builtins = ['work_project', 'time_schedule', 'announcement_event', 'social_life', 'mixed_unclassified']
const freshConfig = () => {
  const matrix = { group: {}, non_group: {}, unknown: {} }
  for (const kind of Object.keys(matrix)) for (const id of builtins) matrix[kind][id] = { todoInstruction: `${kind}:${id}:todo0`, topicInstruction: `${kind}:${id}:topic0` }
  return { schemaVersion: 1, revision: 'cfg-1', customNatures: [], matrix, updatedAt: 'epoch' }
}
function profilePort({ conflictAt = 0 } = {}) {
  let config = freshConfig()
  let saves = 0
  const writes = []
  const control = {
    getConfig: async () => config,
    saveConfig: async (next, expectedRevision) => {
      writes.push({ config: structuredClone(next), expectedRevision })
      saves++
      if (saves === conflictAt || expectedRevision !== config.revision) throw new Error('revision_conflict raw-config-secret')
      config = { ...structuredClone(next), revision: `cfg-${saves + 1}` }
      return config
    },
    getChat: async () => null,
    saveChat: async () => { throw new Error('unused') },
    resolve: async () => { throw new Error('unused') }
  }
  return { control, writes, current: () => config }
}
const attr = (root, name, value) => byAttr(root, name, value)
const select = (root, id, value) => { const el = attr(root, 'id', id); reactProps(el).onChange({ target: { value } }) }
const edit = (root, id, value) => { const el = attr(root, 'id', id); reactProps(el).onChange({ target: { value } }) }
const click = async (root, label) => { const button = byText(root, label, 'button'); assert.ok(button, `button ${label}`); reactProps(button).onClick({ target: button }); await wait(60) }
const openMatrix = root => { const details = attr(root, 'data-testid', 'profile-matrix-settings'); reactProps(details).onToggle({ currentTarget: { open: true } }) }
const text = root => walk(root).map(el => el.textContent).join(' ')

test('全域矩陣依類型、性質與待辦／議題格分開讀寫，CAS 衝突訊息固定', async () => {
  const port = profilePort()
  const view = ui.mount(ui.profileMatrixScene(port.control))
  try {
    await wait(30)
    openMatrix(view.container)
    for (let i = 0; i < 50 && !attr(view.container, 'data-testid', 'profile-matrix-instruction'); i++) await wait()
    assert.ok(attr(view.container, 'data-testid', 'profile-matrix-instruction'))
    await wait(50)
    assert.equal(port.writes.length, 0)

    edit(view.container, 'profile-matrix-instruction', '群組待辦新規則')
    await wait(20)
    await click(view.container, '儲存此規則')
    assert.equal(port.writes[0].expectedRevision, 'cfg-1')
    assert.equal(port.writes[0].config.matrix.group.work_project.todoInstruction, '群組待辦新規則')
    assert.equal(port.writes[0].config.matrix.group.work_project.topicInstruction, 'group:work_project:topic0')
    assert.equal(port.writes[0].config.matrix.non_group.work_project.todoInstruction, 'non_group:work_project:todo0')

    const topicButton = byText(view.container, '議題規則', 'button')
    reactProps(topicButton).onClick({ target: topicButton }); await wait()
    edit(view.container, 'profile-matrix-instruction', '群組議題新規則')
    await wait(20)
    await click(view.container, '儲存此規則')
    assert.equal(port.writes[1].config.matrix.group.work_project.todoInstruction, '群組待辦新規則')
    assert.equal(port.writes[1].config.matrix.group.work_project.topicInstruction, '群組議題新規則')

    select(view.container, 'profile-matrix-kind', 'non_group'); await wait()
    assert.equal(attr(view.container, 'data-testid', 'profile-matrix-instruction').value, 'non_group:work_project:topic0')

    edit(view.container, 'profile-custom-nature-name', '旅行規劃')
    await wait(20)
    await click(view.container, '新增性質')
    const added = port.writes[2].config.customNatures.at(-1)
    assert.match(added.id, /^custom_custom_nature(?:_\d+)?$/)
    assert.equal(port.writes[2].config.matrix.group[added.id].todoInstruction, '')
    assert.equal(port.writes[2].config.matrix.group[added.id].topicInstruction, '')
    assert.equal(port.writes[2].config.matrix.non_group[added.id].todoInstruction, '')

    await wait(30)
    edit(view.container, 'profile-matrix-instruction', '自訂性質的待辦規則')
    await wait(20)
    await click(view.container, '儲存此規則')
    assert.equal(port.writes[3].config.matrix.non_group[added.id].todoInstruction, '自訂性質的待辦規則')
    assert.equal(port.writes[3].config.matrix.non_group[added.id].topicInstruction, '')

    const customTopicButton = byText(view.container, '議題規則', 'button')
    reactProps(customTopicButton).onClick({ target: customTopicButton }); await wait(20)
    edit(view.container, 'profile-matrix-instruction', '自訂性質的議題規則')
    await wait(20)
    await click(view.container, '儲存此規則')
    assert.equal(port.writes[4].config.matrix.non_group[added.id].todoInstruction, '自訂性質的待辦規則')
    assert.equal(port.writes[4].config.matrix.non_group[added.id].topicInstruction, '自訂性質的議題規則')

    edit(view.container, 'profile-custom-nature-name', '個人旅行規劃')
    await wait(20)
    await click(view.container, '改名並儲存')
    assert.equal(port.writes[5].config.customNatures.at(-1).id, added.id)
    assert.equal(port.writes[5].config.customNatures.at(-1).label, '個人旅行規劃')
    assert.equal(port.writes[5].config.matrix.non_group[added.id].todoInstruction, '自訂性質的待辦規則')
    assert.equal(port.writes[5].config.matrix.non_group[added.id].topicInstruction, '自訂性質的議題規則')
  } finally { view.unmount() }

  const conflicted = profilePort({ conflictAt: 1 })
  const second = ui.mount(ui.profileMatrixScene(conflicted.control))
  try {
    await wait(30)
    openMatrix(second.container)
    for (let i = 0; i < 50 && !attr(second.container, 'data-testid', 'profile-matrix-instruction'); i++) await wait()
    await wait(50)
    edit(second.container, 'profile-matrix-instruction', '不應保存')
    await wait(20)
    await click(second.container, '儲存此規則')
    assert.match(text(second.container), /設定已在其他畫面更新/)
    assert.doesNotMatch(text(second.container), /raw-config-secret/)
    assert.equal(conflicted.current().matrix.group.work_project.todoInstruction, 'group:work_project:todo0')
  } finally { second.unmount() }
})
