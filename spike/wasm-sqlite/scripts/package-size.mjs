// Size of what would ship inside a .tuqplugin for each SQLite engine: raw bytes and
// zip-deflate (level 9) estimate, plus SHA-256 for provenance.
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const W = join(ROOT, 'vendor', 'sqlite3mc-2.5.1-sqlite-3.53.4-wasm', 'sqlite3mc-wasm-3530400', 'jswasm')
const B = join(ROOT, 'node_modules', 'better-sqlite3-multiple-ciphers')
const sets = {
  'sqlite3mc-wasm 2.5.1 (needed: sqlite3.mjs + sqlite3.wasm)': [join(W, 'sqlite3.mjs'), join(W, 'sqlite3.wasm')],
  'better-sqlite3-multiple-ciphers 11.10.0 (native .node + JS lib)': [join(B, 'build', 'Release', 'better_sqlite3.node'), join(B, 'lib', 'index.js'), join(B, 'lib', 'database.js'), join(B, 'lib', 'util.js'), join(B, 'lib', 'sqlite-error.js'), ...['aggregate', 'backup', 'function', 'inspect', 'pragma', 'serialize', 'table', 'transaction', 'wrappers'].map((m) => join(B, 'lib', 'methods', `${m}.js`))],
}
const out = {}
for (const [name, files] of Object.entries(sets)) {
  const rows = files.map((f) => { const b = readFileSync(f); return { file: f.slice(ROOT.length + 1).replace(/\\/g, '/'), bytes: statSync(f).size, deflate9: deflateRawSync(b, { level: 9 }).length, sha256: createHash('sha256').update(b).digest('hex') } })
  out[name] = { files: rows, totalBytes: rows.reduce((a, r) => a + r.bytes, 0), totalDeflate9: rows.reduce((a, r) => a + r.deflate9, 0) }
}
writeFileSync(join(ROOT, 'evidence', 'package-size.json'), JSON.stringify(out, null, 2))
for (const [k, v] of Object.entries(out)) console.log(k, '| raw', v.totalBytes, '| deflate9', v.totalDeflate9)
