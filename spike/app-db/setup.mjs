// Stage every candidate engine into ./vendor (gitignored) and record provenance + sha256.
//   bs3-13.0.2-teamuq   : byte copy of C:/teamuq/teamuq-electron/node_modules/better-sqlite3 (source untouched)
//   bs3-13.0.2-npm      : `npm pack better-sqlite3@13.0.2` (registry tarball, no install scripts run)
//   bs3-13.0.3-npm      : `npm pack better-sqlite3@13.0.3`
//   bs3-11.10.0-linetodo: byte copy of line-todo main tree node_modules/better-sqlite3 (+bindings,
//                         file-uri-to-path); the ABI-125 build line-todo ships today (negative control on E44)
//   wasm                : reuses ../wasm-sqlite/vendor (fetched + SHA-256 verified by the previous spike)
// Writes evidence/engines-manifest.json. Usage: node setup.mjs
import { cpSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execSync, execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const VENDOR = join(ROOT, 'vendor')
const EVID = join(ROOT, 'evidence')
mkdirSync(VENDOR, { recursive: true }); mkdirSync(EVID, { recursive: true })
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex')
const TEAMUQ_BS3 = 'C:/teamuq/teamuq-electron/node_modules/better-sqlite3'
const LINETODO_NM = 'C:/teamuq/line-todo/node_modules'
const WASM_JS = join(ROOT, '..', 'wasm-sqlite', 'vendor', 'sqlite3mc-2.5.1-sqlite-3.53.4-wasm', 'sqlite3mc-wasm-3530400', 'jswasm')

const manifest = { generatedAt: new Date().toISOString(), engines: {} }

function stageCopy(name, pairs) {
  const base = join(VENDOR, name, 'node_modules')
  rmSync(join(VENDOR, name), { recursive: true, force: true })
  for (const [from, pkg] of pairs) {
    if (!existsSync(from)) throw new Error('missing ' + from)
    mkdirSync(dirname(join(base, pkg)), { recursive: true })
    cpSync(from, join(base, pkg), { recursive: true, dereference: true })
  }
  return join(base, 'better-sqlite3')
}

function describeBs3(name, dir, extra) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const nodes = []
  for (const sub of ['prebuilds', 'build/Release']) {
    const d = join(dir, sub)
    if (!existsSync(d)) continue
    for (const f of readdirSync(d)) if (f.endsWith('.node')) nodes.push({ file: `${sub}/${f}`, sha256: sha(join(d, f)) })
  }
  let napi = null
  const gyp = join(dir, 'binding.gyp')
  if (existsSync(gyp)) { const m = readFileSync(gyp, 'utf8').match(/NAPI_VERSION=(\d+)/); napi = m ? Number(m[1]) : null }
  manifest.engines[name] = { dir, version: pkg.version, enginesField: pkg.engines ?? null, dependencies: pkg.dependencies ?? null, bindingGypNapiVersion: napi, nativeFiles: nodes, ...extra }
}

// 1. teamuq-electron copy (read-only source)
describeBs3('bs3-13.0.2-teamuq', stageCopy('bs3-13.0.2-teamuq', [[TEAMUQ_BS3, 'better-sqlite3']]), { source: TEAMUQ_BS3 })

// 2./3. official registry tarballs
const tgzDir = join(VENDOR, 'npm-tgz')
mkdirSync(tgzDir, { recursive: true })
for (const v of ['13.0.2', '13.0.3']) {
  const out = execSync(`npm pack better-sqlite3@${v} --pack-destination "${tgzDir}" --json`, { encoding: 'utf8', timeout: 180000 })
  const info = JSON.parse(out)[0]
  const tgz = join(tgzDir, info.filename)
  const name = `bs3-${v}-npm`
  const dest = join(VENDOR, name, 'node_modules')
  rmSync(join(VENDOR, name), { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  // Windows bsdtar (GNU tar from Git-Bash would parse "C:" as a remote host); creates ./package
  const TAR = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe') : 'tar'
  execFileSync(TAR, ['-xzf', tgz], { cwd: dest, timeout: 120000 })
  cpSync(join(dest, 'package'), join(dest, 'better-sqlite3'), { recursive: true })
  rmSync(join(dest, 'package'), { recursive: true, force: true })
  describeBs3(name, join(dest, 'better-sqlite3'), { source: `npm registry better-sqlite3@${v}`, tarball: info.filename, tarballSha256: sha(tgz), npmIntegrity: info.integrity, npmShasum: info.shasum })
}

// 4. line-todo's shipped ABI-125 build (negative control / standalone baseline)
describeBs3('bs3-11.10.0-linetodo', stageCopy('bs3-11.10.0-linetodo', [
  [join(LINETODO_NM, 'better-sqlite3'), 'better-sqlite3'],
  [join(LINETODO_NM, 'bindings'), 'bindings'],
  [join(LINETODO_NM, 'file-uri-to-path'), 'file-uri-to-path'],
]), { source: join(LINETODO_NM, 'better-sqlite3') })

// 5. wasm (reuse previous spike's verified vendor tree). Copied INTO this installDir: under the 1.6.8
//    flags only installDir/dataDir are readable, ../wasm-sqlite is outside the read scope.
if (existsSync(join(WASM_JS, 'sqlite3.wasm'))) {
  rmSync(join(VENDOR, 'wasm'), { recursive: true, force: true })
  mkdirSync(join(VENDOR, 'wasm'), { recursive: true })
  for (const f of ['sqlite3.mjs', 'sqlite3.wasm']) cpSync(join(WASM_JS, f), join(VENDOR, 'wasm', f))
}
manifest.engines['wasm'] = existsSync(join(WASM_JS, 'sqlite3.wasm'))
  ? { dir: join(VENDOR, 'wasm'), copiedFrom: WASM_JS, source: 'https://github.com/utelle/SQLite3MultipleCiphers/releases/tag/v2.5.1 (sqlite3mc-2.5.1-sqlite-3.53.4-wasm.zip, verified by ../wasm-sqlite/scripts/fetch-sqlite3mc-wasm.mjs)', files: [{ file: 'sqlite3.mjs', sha256: sha(join(WASM_JS, 'sqlite3.mjs')) }, { file: 'sqlite3.wasm', sha256: sha(join(WASM_JS, 'sqlite3.wasm')) }] }
  : { missing: true, hint: 'run: node ../wasm-sqlite/scripts/fetch-sqlite3mc-wasm.mjs v2.5.1' }

// cross-check: is the teamuq copy byte-identical to the official 13.0.2 tarball?
const a = manifest.engines['bs3-13.0.2-teamuq'].nativeFiles, b = manifest.engines['bs3-13.0.2-npm'].nativeFiles
const bmap = new Map(b.map((x) => [x.file, x.sha256]))
manifest.teamuqVsOfficial_13_0_2 = a.map((x) => ({ file: x.file, teamuq: x.sha256, official: bmap.get(x.file) ?? null, identical: bmap.get(x.file) === x.sha256 }))
writeFileSync(join(EVID, 'engines-manifest.json'), JSON.stringify(manifest, null, 2))
console.log(JSON.stringify({ staged: Object.keys(manifest.engines), teamuqWin32x64IdenticalToOfficial: manifest.teamuqVsOfficial_13_0_2.find((x) => x.file === 'prebuilds/win32-x64.node')?.identical }, null, 2))
