// Official better-sqlite3 prebuilt survey (GitHub releases + npm registry). Read-only network queries.
// Writes evidence/prebuild-survey.json. Usage: node scripts/survey-prebuilds.mjs
import { execFileSync, execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const gh = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 }))
const releases = gh('repos/WiseLibs/better-sqlite3/releases?per_page=12')
const out = { queriedAt: new Date().toISOString(), commands: ['gh api repos/WiseLibs/better-sqlite3/releases?per_page=12', 'npm view better-sqlite3@<v> engines dist.tarball dist.integrity --json'], releases: [] }
for (const r of releases) {
  const win = r.assets.map((a) => a.name).filter((n) => n.includes('win32-x64'))
  const abis = win.map((n) => n.match(/-(electron|node)-v(\d+)-/)).filter(Boolean).map((m) => `${m[1]}-v${m[2]}`)
  out.releases.push({ tag: r.tag_name, publishedAt: r.published_at, assetCount: r.assets.length, win32x64Abis: abis, hasElectronV149: abis.includes('electron-v149'), maxElectronAbi: Math.max(0, ...abis.filter((a) => a.startsWith('electron')).map((a) => Number(a.split('-v')[1]))) })
}
out.npm = {}
for (const v of ['11.10.0', '12.11.1', '12.12.0', '13.0.2', '13.0.3']) {
  try { out.npm[v] = JSON.parse(execSync(`npm view better-sqlite3@${v} engines dist.tarball dist.integrity gypfile --json`, { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'] })) }
  catch (e) { out.npm[v] = { error: (() => { try { return JSON.parse(e.stdout).error.summary } catch { return String(e.message).slice(0, 120) } })() } }
}
out.notes = [
  'v13.x GitHub releases carry no binary assets: prebuilds/*.node are inside the npm tarball (N-API, binding.gyp NAPI_VERSION=10).',
  'v12.x (and earlier) ship per-ABI electron/node tarballs on GitHub; electron-v149 (Electron 44) is checked per release below.',
]
writeFileSync(join(ROOT, 'evidence', 'prebuild-survey.json'), JSON.stringify(out, null, 2))
console.log(JSON.stringify(out.releases.map((r) => ({ tag: r.tag, n: r.assetCount, maxElectronAbi: r.maxElectronAbi, v149: r.hasElectronV149 })), null, 0))
console.log(JSON.stringify(Object.fromEntries(Object.entries(out.npm).map(([k, v]) => [k, v.engines]))))
