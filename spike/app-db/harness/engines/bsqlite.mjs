// better-sqlite3 candidate: zero adapter — the package itself is handed to line-todo's code.
// cfg.vendor selects which staged copy (vendor/<name>/node_modules/better-sqlite3) is loaded.
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export async function loadEngine(cfg) {
  const require = createRequire(import.meta.url)
  const dir = join(ROOT, 'vendor', cfg.vendor, 'node_modules', 'better-sqlite3')
  const Database = require(dir)
  const probe = new Database(':memory:')
  const info = {
    engine: 'better-sqlite3',
    package: require(join(dir, 'package.json')).version,
    sqlite: probe.prepare('select sqlite_version() v').get().v,
    compileOptionsSample: probe.prepare('PRAGMA compile_options').all().map((r) => r.compile_options).filter((o) => /DQS|FOREIGN|THREADSAFE|WAL|DEFAULT_WAL|OMIT/.test(o)),
  }
  probe.close()
  return { info, factory: (filename, options) => new Database(filename, options), adapterFiles: [] }
}
