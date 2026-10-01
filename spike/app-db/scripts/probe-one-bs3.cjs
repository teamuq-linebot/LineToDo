// Load ONE better-sqlite3 copy in this runtime and report (isolates hard crashes per candidate).
// Usage: <runtime> scripts/probe-one-bs3.cjs <vendor-name>
const { join } = require('node:path')
const name = process.argv[2]
process.stdout.write(`BEGIN ${name} node=${process.versions.node} modules=${process.versions.modules} napi=${process.versions.napi}\n`)
try {
  const D = require(join(__dirname, '..', 'vendor', name, 'node_modules', 'better-sqlite3'))
  const db = new D(':memory:')
  process.stdout.write('OK sqlite=' + db.prepare('select sqlite_version() v').get().v + '\n')
  db.close()
} catch (e) { process.stdout.write('ERR ' + (e.code || '') + ' ' + String(e.message).split('\n')[0].slice(0, 220) + '\n') }
