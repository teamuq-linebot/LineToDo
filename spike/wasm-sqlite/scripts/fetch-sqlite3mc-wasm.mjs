// Fetch the official SQLite3MultipleCiphers WASM build from the utelle/SQLite3MultipleCiphers
// GitHub release, verify its SHA-256 against the release's SHA256SUMS, and extract it into
// ../vendor/. Uses `gh` (authenticated GitHub CLI) for download and PowerShell Expand-Archive for
// extraction (no system-level installs).
//
// Usage: node scripts/fetch-sqlite3mc-wasm.mjs [tag]   (default v2.5.1)
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const VENDOR = join(ROOT, 'vendor')
const tag = process.argv[2] || 'v2.5.1'
const ver = tag.replace(/^v/, '')
mkdirSync(VENDOR, { recursive: true })

const sumsName = `sqlite3mc-${ver}-SHA256SUMS`
execFileSync('gh', ['release', 'download', tag, '-R', 'utelle/SQLite3MultipleCiphers', '-p', sumsName, '-p', `sqlite3mc-${ver}-sqlite-*-wasm.zip`, '-D', VENDOR, '--clobber'], { stdio: 'inherit', timeout: 120000 })

const sums = readFileSync(join(VENDOR, sumsName), 'utf8')
const line = sums.split(/\r?\n/).find((l) => /-wasm\.zip$/.test(l.trim()))
if (!line) throw new Error('no wasm zip line in SHA256SUMS')
const [expected, rawName] = line.trim().split(/\s+/)
const zipName = rawName.replace(/^\*/, '')
const zipPath = join(VENDOR, zipName)
const actual = createHash('sha256').update(readFileSync(zipPath)).digest('hex')
const ok = actual.toLowerCase() === expected.toLowerCase()
const record = { tag, zipName, expected, actual, ok, bytes: readFileSync(zipPath).length }
writeFileSync(join(VENDOR, 'FETCH-RECORD.json'), JSON.stringify(record, null, 2))
console.log(JSON.stringify(record, null, 2))
if (!ok) { console.error('SHA256 MISMATCH'); process.exit(2) }

const outDir = join(VENDOR, zipName.replace(/\.zip$/, ''))
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`], { stdio: 'inherit', timeout: 120000 })
console.log('extracted to', outDir)
