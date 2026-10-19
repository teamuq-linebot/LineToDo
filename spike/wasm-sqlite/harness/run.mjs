// Launcher (unpermissioned, plays the TeamUQ host). Mirrors spike/native-permission/harness/
// run-harness.mjs: build ExternalHostInit, compute flags with the verbatim 1.6.8
// buildBackendPermissionFlags, spawn the Electron binary as Node (ELECTRON_RUN_AS_NODE=1, 1.6.8
// env allowlist) running a host bootstrap that lives OUTSIDE installDir and imports child.mjs.
//
// Usage: node harness/run.mjs --electron <exe> --label <l> --engine wasm|bsqlite --fixtures <dir>
//          [--no-addons] [--exp-perm] [--iters 5] [--scan 200] [--keep]
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildBackendPermissionFlags } from './teamuq-contract.mjs'

const HARNESS = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HARNESS)
const EVID = join(ROOT, 'evidence')
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d }
const has = (n) => process.argv.includes(`--${n}`)

const electronExe = arg('electron')
const label = arg('label', 'run')
const engine = arg('engine', 'wasm')
const fixtures = arg('fixtures')
const allowAddons = !has('no-addons')
const iters = Number(arg('iters', '5'))
const scanCandidates = Number(arg('scan', '200'))
mkdirSync(EVID, { recursive: true })

const expected = JSON.parse(readFileSync(join(fixtures, 'expected.json'), 'utf8'))
const installDir = ROOT
const runRoot = mkdtempSync(join(tmpdir(), `teamuq-wasm-run-${label}-`))
const dataDir = join(runRoot, 'data')
mkdirSync(dataDir, { recursive: true })
const hostDir = join(runRoot, 'host')
mkdirSync(hostDir, { recursive: true })
const bootstrapFile = join(hostDir, 'host-bootstrap.mjs')
writeFileSync(bootstrapFile, `await import(${JSON.stringify(pathToFileURL(join(HARNESS, 'child.mjs')).href)})\n`)

const copyVia = allowAddons ? 'koffi' : 'preplaced'
if (copyVia === 'preplaced') {
  // No addon allowed => no koffi. The launcher (host side) pre-places the snapshot in dataDir so
  // the WASM engine can be tested with ZERO native code in the backend process.
  for (const kind of ['wal', 'rollback']) {
    mkdirSync(join(dataDir, 'preplaced', kind), { recursive: true })
    for (const ext of ['', '-wal', '-shm']) { const f = join(fixtures, kind, 'm.edb' + ext); if (existsSync(f)) copyFileSync(f, join(dataDir, 'preplaced', kind, 'm.edb' + ext)) }
  }
}

const cfg = {
  engine, copyVia, iters, scanCandidates,
  outside: { walEdb: join(fixtures, 'wal', 'm.edb'), rollbackEdb: join(fixtures, 'rollback', 'm.edb') },
  expected: { key: expected.key, cipher: expected.cipher, kdfIter: expected.kdfIter, wal: expected.wal, rollback: expected.rollback },
}
const init = { version: 1, pluginId: 'tuqdev.wasm-spike', installDir, dataDir, entry: bootstrapFile, assetPacks: {}, allowAddons, corePackaged: true }

let flags = buildBackendPermissionFlags({ bootstrapFile, installDir, dataDir, assetDirs: [], allowAddons })
// Node-20 (Electron 31) names the same feature --experimental-permission; scopes unchanged.
if (has('exp-perm')) flags = flags.map((f) => (f === '--permission' ? '--experimental-permission' : f))

const initArg = Buffer.from(JSON.stringify(init)).toString('base64url')
const cfgArg = Buffer.from(JSON.stringify(cfg)).toString('base64url')
const args = [...flags, bootstrapFile, initArg, cfgArg]
const env = { ELECTRON_RUN_AS_NODE: '1', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, windir: process.env.windir, TEMP: process.env.TEMP, TMP: process.env.TMP }

const started = Date.now()
const proc = spawnSync(electronExe, args, { env, cwd: dataDir, encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024 })
const durationMs = Date.now() - started
const stdout = proc.stdout || ''
const stderr = proc.stderr || ''
let result = null
const line = stdout.split('\n').find((l) => l.startsWith('RESULT:'))
if (line) { try { result = JSON.parse(line.slice(7)) } catch (e) { result = { parseError: String(e) } } }

// redact the base64 init/cfg blobs in the command record (cfg contains the synthetic key; it is a
// synthetic constant, but we keep the command file readable)
writeFileSync(join(EVID, `${label}-command.txt`), `ELECTRON_RUN_AS_NODE=1 "${electronExe}" ${[...flags, bootstrapFile, '<base64url init>', '<base64url cfg>'].join(' ')}\n`)
writeFileSync(join(EVID, `${label}-stdout.txt`), stdout)
writeFileSync(join(EVID, `${label}-stderr.txt`), stderr)
writeFileSync(join(EVID, `${label}-result.json`), JSON.stringify({ label, electronExe, engine, allowAddons, copyVia, exitCode: proc.status, signal: proc.signal, spawnError: proc.error ? String(proc.error) : null, durationMs, flags, dirs: { runRoot, installDir, dataDir }, init: { ...init }, result }, null, 2))

const c = result?.correctness
console.log(JSON.stringify({
  label, exitCode: proc.status, abi: result?.runtime?.modules_abi, selfCheckBoot: result?.selfCheckBoot?.ok, selfCheckAfterEngine: result?.selfCheckAfterEngine?.ok, selfCheckEnd: result?.selfCheckEnd?.ok,
  engine: result?.engine?.loaded, engineInfo: result?.engine?.info?.mc, controlDenied: result?.controlNodeFsOutside?.denied,
  walDefaultLocking: result?.walDefaultLocking, wal: c?.wal && { ok: c.wal.ok, count: c.wal.countMatches, digest: c.wal.digestMatches, maxRow: c.wal.maxRowMatches, err: c.wal.error },
  rollback: c?.rollback && { ok: c.rollback.ok, count: c.rollback.countMatches, digest: c.rollback.digestMatches, err: c.rollback.error },
  wrongKey: result?.wrongKey?.rejected, bench: result?.bench?.median, keyScan: result?.keyScan,
}, null, 2))
if (stderr.trim()) console.log('STDERR(head):', stderr.split('\n').slice(0, 6).join('\n'))
if (!has('keep')) { try { rmSync(runRoot, { recursive: true, force: true }) } catch {} }
process.exit(proc.status === 0 && result ? 0 : 1)
