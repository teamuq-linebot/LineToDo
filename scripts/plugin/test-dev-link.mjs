// Tests for the development link folder (build-dev-link.mjs + lib/devLink.mjs). Everything runs in a temp folder; nothing under dist/ or the user's TeamUQ home is touched.
//   npm run test:dev-link
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DevLinkLockedError, devLinkFiles, syncDevLink } from './lib/devLink.mjs'
import { NATIVE_FILES, PLUGIN_ID, buildManifest } from './lib/manifest.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'line-todo-dev-link-'))
const OLD = new Date('2001-01-01T00:00:00Z')

function fixtureFiles(extra = {}) {
  const base = {
    'ui/index.html': '<!doctype html><title>board</title>',
    'ui/main.js': 'console.log("board")',
    'ui/icon.png': 'PNGDATA',
    'backend/index.mjs': 'export const backend = 1',
    [NATIVE_FILES[0].path]: 'KOFFI-NATIVE-v1',
    [NATIVE_FILES[1].path]: 'SQLITE-NATIVE-v1',
    'vendor/sqlite3mc-wasm/sqlite3.wasm': 'WASM',
    'LICENSES/zod-LICENSE.txt': 'MIT',
    ...extra,
  }
  return Object.entries(base).map(([p, data]) => ({ path: p, data: Buffer.from(data) }))
}

function manifestFor(version = '0.2.13') {
  return buildManifest({ version, resident: { enabled: false } })
}

function outputsFor(files, version) {
  return devLinkFiles({ manifest: manifestFor(version), files })
}

function sync(dir, files, extra = {}) {
  return syncDevLink({ dir, stateFile: path.join(dir, '..', `${path.basename(dir)}.state.json`), files, ...extra })
}

test('the dev output has no integrity.json or signature.json, and refuses to carry them', () => {
  const outputs = outputsFor(fixtureFiles(), '0.2.13')
  const names = outputs.map((f) => f.path)
  assert.equal(names.includes('integrity.json'), false)
  assert.equal(names.includes('signature.json'), false)
  assert.throws(() => outputsFor(fixtureFiles({ 'signature.json': '{}' }), '0.2.13'), /must not be part of a dev link/)
  assert.throws(() => outputsFor(fixtureFiles({ '../escape.txt': 'x' }), '0.2.13'), /unsafe path/)
})

test('first build creates the folder and writes every file; the second build writes nothing', () => {
  const dir = path.join(tmp(), 'dev-link')
  const first = sync(dir, outputsFor(fixtureFiles(), '0.2.13'))
  assert.equal(first.written.length, outputsFor(fixtureFiles(), '0.2.13').length)
  assert.deepEqual(first.unchanged, [])
  for (const native of NATIVE_FILES) assert.ok(fs.existsSync(path.join(dir, ...native.path.split('/'))), native.path)
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.id, PLUGIN_ID)

  const second = sync(dir, outputsFor(fixtureFiles(), '0.2.13'))
  assert.deepEqual(second.written, [])
  assert.equal(second.unchanged.length, first.written.length)
  assert.deepEqual(second.removed, [])
})

test('in place: the folder is not recreated, only changed files are rewritten, unchanged files keep their mtime', () => {
  const root = tmp()
  const dir = path.join(root, 'dev-link')
  sync(dir, outputsFor(fixtureFiles(), '0.2.13'))
  const before = fs.statSync(dir)
  for (const rel of ['ui/main.js', 'backend/index.mjs', NATIVE_FILES[0].path]) fs.utimesSync(path.join(dir, ...rel.split('/')), OLD, OLD)

  const changed = fixtureFiles({ 'ui/main.js': 'console.log("board v2")' })
  const report = sync(dir, outputsFor(changed, '0.2.13'))
  const after = fs.statSync(dir)
  assert.equal(after.ino, before.ino, 'the folder object is the same')
  assert.equal(after.birthtimeMs, before.birthtimeMs, 'the folder was not recreated')
  assert.deepEqual(report.written.filter((rel) => rel !== 'manifest.json'), ['ui/main.js'])
  assert.equal(fs.readFileSync(path.join(dir, 'ui', 'main.js'), 'utf8'), 'console.log("board v2")')
  assert.equal(fs.statSync(path.join(dir, 'backend', 'index.mjs')).mtime.getTime(), OLD.getTime(), 'unchanged file was not rewritten')
  assert.equal(fs.statSync(path.join(dir, ...NATIVE_FILES[0].path.split('/'))).mtime.getTime(), OLD.getTime(), 'unchanged .node was not rewritten')
})

test('a file the build did not write is never touched (TeamUQ files, AGENTS.md, user files, neighbours of the folder)', () => {
  const root = tmp()
  const dir = path.join(root, 'dev-link')
  sync(dir, outputsFor(fixtureFiles(), '0.2.13'))
  fs.mkdirSync(path.join(dir, '.teamuq', 'state'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.teamuq', 'state', 'link.json'), 'teamuq-owned')
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'agent notes')
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine')
  fs.mkdirSync(path.join(dir, 'ui', 'my-folder'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'ui', 'my-folder', 'keep.txt'), 'keep')
  fs.writeFileSync(path.join(root, 'sibling.txt'), 'outside')

  const dropped = fixtureFiles().filter((f) => f.path !== 'ui/main.js')
  const report = sync(dir, outputsFor(dropped, '0.2.13'))

  assert.deepEqual(report.removed, ['ui/main.js'])
  assert.equal(fs.readFileSync(path.join(dir, '.teamuq', 'state', 'link.json'), 'utf8'), 'teamuq-owned')
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), 'agent notes')
  assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'mine')
  assert.equal(fs.readFileSync(path.join(dir, 'ui', 'my-folder', 'keep.txt'), 'utf8'), 'keep')
  assert.equal(fs.readFileSync(path.join(root, 'sibling.txt'), 'utf8'), 'outside')
})

test('a file that is locked (.node in use) with new content stops the build with a plain message, and nothing else changes', () => {
  const dir = path.join(tmp(), 'dev-link')
  sync(dir, outputsFor(fixtureFiles(), '0.2.13'))
  const nativeTarget = path.join(dir, ...NATIVE_FILES[0].path.split('/'))
  const changed = fixtureFiles({ [NATIVE_FILES[0].path]: 'KOFFI-NATIVE-v2', 'ui/main.js': 'console.log("v2")' })
  const locking = (target, data) => {
    if (target === nativeTarget) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    fs.writeFileSync(target, data)
  }
  assert.throws(
    () => sync(dir, outputsFor(changed, '0.2.13'), { write: locking }),
    (error) => {
      assert.ok(error instanceof DevLinkLockedError)
      assert.match(error.message, /請先在 TeamUQ 停用或解除連結/)
      assert.match(error.message, /koffi\.node/)
      return true
    },
  )
  assert.equal(fs.readFileSync(path.join(dir, 'ui', 'main.js'), 'utf8'), 'console.log("board")', 'natives are written first, so nothing else was written')
  assert.equal(fs.readFileSync(nativeTarget, 'utf8'), 'KOFFI-NATIVE-v1')
})

test('an unchanged locked .node is not opened for writing, so the build succeeds', () => {
  const dir = path.join(tmp(), 'dev-link')
  sync(dir, outputsFor(fixtureFiles(), '0.2.13'))
  const refuse = () => {
    throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
  }
  const report = sync(dir, outputsFor(fixtureFiles(), '0.2.13'), { write: refuse })
  assert.deepEqual(report.written, [])
})

test('a file no longer produced is removed (with its empty folders) only when the previous build wrote it', () => {
  const root = tmp()
  const dir = path.join(root, 'dev-link')
  const stateFile = path.join(root, 'dev-link.state.json')
  const withExtra = fixtureFiles({ 'ui/extra/old.js': 'old' })
  syncDevLink({ dir, stateFile, files: outputsFor(withExtra, '0.2.13') })
  fs.writeFileSync(path.join(dir, 'ui', 'extra', 'user.txt'), 'not ours')
  const removed = syncDevLink({ dir, stateFile, files: outputsFor(fixtureFiles(), '0.2.13') })
  assert.deepEqual(removed.removed, ['ui/extra/old.js'])
  assert.equal(fs.existsSync(path.join(dir, 'ui', 'extra', 'old.js')), false)
  assert.equal(fs.readFileSync(path.join(dir, 'ui', 'extra', 'user.txt'), 'utf8'), 'not ours', 'a folder with a foreign file stays')
})

test('a removed file that was never written by a build is not deleted (no state, or state from another folder)', () => {
  const root = tmp()
  const dir = path.join(root, 'dev-link')
  const stateFile = path.join(root, 'dev-link.state.json')
  syncDevLink({ dir, stateFile, files: outputsFor(fixtureFiles({ 'ui/x.js': 'x' }), '0.2.13') })
  fs.rmSync(stateFile)
  const noState = syncDevLink({ dir, stateFile, files: outputsFor(fixtureFiles(), '0.2.13') })
  assert.deepEqual(noState.removed, [])
  assert.equal(fs.existsSync(path.join(dir, 'ui', 'x.js')), true)

  const otherDir = path.join(root, 'other')
  fs.writeFileSync(stateFile, JSON.stringify({ schema: 1, dir: otherDir, files: ['ui/x.js'] }))
  const otherState = syncDevLink({ dir, stateFile, files: outputsFor(fixtureFiles(), '0.2.13') })
  assert.deepEqual(otherState.removed, [])
  assert.equal(fs.existsSync(path.join(dir, 'ui', 'x.js')), true)
})

test('state entries that try to leave the folder are ignored', () => {
  const root = tmp()
  const dir = path.join(root, 'dev-link')
  const stateFile = path.join(root, 'dev-link.state.json')
  fs.writeFileSync(path.join(root, 'outside.txt'), 'safe')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(stateFile, JSON.stringify({ schema: 1, dir: path.resolve(dir), files: ['../outside.txt', '/abs.txt', 'a\\b.txt'] }))
  const report = syncDevLink({ dir, stateFile, files: outputsFor(fixtureFiles(), '0.2.13') })
  assert.deepEqual(report.removed, [])
  assert.equal(fs.readFileSync(path.join(root, 'outside.txt'), 'utf8'), 'safe')
})
