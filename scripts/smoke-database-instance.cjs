const { app } = require('electron')
const esbuild = require('esbuild')
const Module = require('node:module')
const path = require('node:path')

const source = `
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from './src/main/db/database.ts'
import { createRepositories } from './src/main/db/repositories.ts'
const root = mkdtempSync(join(tmpdir(), 'line-todo-runtime-db-smoke-'))
try {
  const first = openDatabase({ dbPath: join(root, 'one', 'line-todo.db') })
  const second = openDatabase({ dbPath: join(root, 'two', 'line-todo.db') })
  const a = createRepositories(first.db)
  const b = createRepositories(second.db)
  const seenAt = new Date().toISOString()
  a.chats.upsert({ chatId: 'fixture-a', name: 'Fixture A', isGroup: true, seenAt })
  a.todos.create({ chatId: 'fixture-a', bucket: 'todo', title: 'Persist me', sourceMsgIds: [] })
  assert.equal(a.chats.list().length, 1)
  assert.equal(b.chats.list().length, 0, 'different dataDir must remain isolated')
  first.close()
  const reopened = openDatabase({ dbPath: join(root, 'one', 'line-todo.db') })
  const persisted = createRepositories(reopened.db)
  assert.equal(persisted.chats.get('fixture-a')?.name, 'Fixture A')
  assert.equal(persisted.todos.list({}).some((todo) => todo.title === 'Persist me'), true)
  assert.equal(reopened.db.pragma('quick_check', { simple: true }), 'ok')
  assert.equal(reopened.db.pragma('user_version', { simple: true }), 4)
  reopened.close()
  second.close()
  console.log('database instance smoke: PASS (schema v4, persistence, quick_check, independent dataDirs)')
} finally { rmSync(root, { recursive: true, force: true }) }
`

app.whenReady().then(async () => {
  try {
    const result = await esbuild.build({
      stdin: { contents: source, sourcefile: 'smoke-database-instance.ts', resolveDir: process.cwd(), loader: 'ts' },
      bundle: true, platform: 'node', format: 'cjs', write: false,
      external: ['electron', 'better-sqlite3']
    })
    const filename = path.join(process.cwd(), 'scripts', '.smoke-database-instance.bundle.cjs')
    const compiled = new Module(filename, module)
    compiled.filename = filename
    compiled.paths = Module._nodeModulePaths(process.cwd())
    compiled._compile(result.outputFiles[0].text, filename)
    app.quit()
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
