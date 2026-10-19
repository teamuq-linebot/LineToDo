// Unpermissioned smoke: can each candidate even load in this runtime? (the permissioned, authoritative
// runs are harness/run.mjs). Prints one JSON line. Usage: <node|electron-as-node> scripts/probe-availability.mjs
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const out = { runtime: { node: process.versions.node, electron: process.versions.electron ?? null, modules: process.versions.modules, napi: process.versions.napi, sqliteBuiltin: process.versions.sqlite ?? null } }
const err = (e) => ({ ok: false, code: e?.code ?? null, message: String(e?.message ?? e).split('\n')[0].slice(0, 200) })

try {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(':memory:')
  out['node-sqlite'] = { ok: true, sqlite: db.prepare('select sqlite_version() v').get().v }
  db.close()
} catch (e) { out['node-sqlite'] = err(e) }

for (const name of ['bs3-13.0.2-teamuq', 'bs3-13.0.2-npm', 'bs3-13.0.3-npm', 'bs3-11.10.0-linetodo']) {
  try {
    const D = require(join(ROOT, 'vendor', name, 'node_modules', 'better-sqlite3'))
    const db = new D(':memory:')
    out[name] = { ok: true, sqlite: db.prepare('select sqlite_version() v').get().v }
    db.close()
  } catch (e) { out[name] = err(e) }
}
process.stdout.write(JSON.stringify(out) + '\n')
