// 1. hash the synthetic fixtures (provenance) then delete the temp fixture dirs
// 2. copy spike evidence to the report evidence dir and write a SHA-256 manifest there
// Usage: node scripts/finalize-evidence.mjs <reportEvidenceDir> <fixtureDir>...
import { readdirSync, statSync, readFileSync, writeFileSync, rmSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const [dest, ...fixtureDirs] = process.argv.slice(2)
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex')
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p] })

const fixtures = {}
for (const d of fixtureDirs) {
  if (!existsSync(d)) { fixtures[d] = 'absent'; continue }
  fixtures[d] = walk(d).map((f) => ({ file: relative(d, f).replace(/\\/g, '/'), bytes: statSync(f).size, sha256: sha(f) }))
  rmSync(d, { recursive: true, force: true })
  fixtures[d + ' (deleted)'] = !existsSync(d)
}
writeFileSync(join(ROOT, 'evidence', 'fixtures-sha256.json'), JSON.stringify(fixtures, null, 2))

mkdirSync(dest, { recursive: true })
const manifest = []
for (const f of walk(join(ROOT, 'evidence'))) {
  const rel = relative(join(ROOT, 'evidence'), f)
  mkdirSync(dirname(join(dest, rel)), { recursive: true })
  copyFileSync(f, join(dest, rel))
  manifest.push({ file: rel.replace(/\\/g, '/'), bytes: statSync(f).size, sha256: sha(f) })
}
writeFileSync(join(dest, 'SHA256-MANIFEST.json'), JSON.stringify(manifest, null, 2))
console.log(JSON.stringify({ fixturesDeleted: fixtureDirs.map((d) => !existsSync(d)), copied: manifest.length, dest }, null, 2))
