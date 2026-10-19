// Copy evidence/** (+ the harness sources that produced it) to a report evidence directory and write
// SHA256-MANIFEST.json there. Usage: node scripts/copy-evidence.mjs <destDir>
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const dest = process.argv[2]
if (!dest) { console.error('usage: copy-evidence.mjs <destDir>'); process.exit(2) }
rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })
cpSync(join(ROOT, 'evidence'), dest, { recursive: true })
for (const d of ['harness', 'scripts']) cpSync(join(ROOT, d), join(dest, '_source', d), { recursive: true })
for (const f of ['setup.mjs', 'build.mjs', 'package.json', '.gitignore']) cpSync(join(ROOT, f), join(dest, '_source', f))
const files = []
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else files.push(p) } }
walk(dest)
const manifest = files.filter((p) => !p.endsWith('SHA256-MANIFEST.json')).map((p) => ({ file: relative(dest, p).replaceAll('\\', '/'), bytes: statSync(p).size, sha256: createHash('sha256').update(readFileSync(p)).digest('hex') })).sort((a, b) => a.file.localeCompare(b.file))
writeFileSync(join(dest, 'SHA256-MANIFEST.json'), JSON.stringify({ generatedAt: new Date().toISOString(), sourceDir: ROOT, count: manifest.length, files: manifest }, null, 2))
console.log(JSON.stringify({ dest, files: manifest.length }))
