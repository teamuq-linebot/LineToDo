// Launcher (runs WITHOUT the permission model, mirroring the TeamUQ host that spawns the backend).
// 1. Builds an ExternalHostInit (installDir/dataDir/assetPacks/allowAddons).
// 2. Creates dataDir + installDir, and synthetic fixtures OUTSIDE dataDir (in a temp dir).
// 3. Computes the exact launch flags via buildBackendPermissionFlags (teamuq-contract.mjs).
// 4. Spawns the Electron binary as Node (ELECTRON_RUN_AS_NODE=1) with those flags, exactly as
//    spawnRunAsNodeBackend does, running child-experiment.mjs.
// 5. Writes stdout/stderr/exit + the parsed RESULT json into the evidence dir.
//
// Usage: node harness/run-harness.mjs <electronExe> <label> [--no-addons]
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { buildBackendPermissionFlags } from './teamuq-contract.mjs'

const require = createRequire(import.meta.url)
const HARNESS_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HARNESS_DIR)
const EVID = join(ROOT, 'evidence')

const electronExe = process.argv[2]
const label = process.argv[3] || 'run'
const allowAddons = !process.argv.includes('--no-addons')

mkdirSync(EVID, { recursive: true })

// --- 2a. host dirs. installDir = the spike ROOT (the readable "backend stage": it holds the
// child bundle under harness/ and the native addons under node_modules/, mirroring how a real
// backend ships its code + native .node files inside its readable install stage). dataDir = a
// fresh temp dir (the only writable location). ---
const installDir = ROOT
const childScript = join(HARNESS_DIR, 'child-experiment.mjs')
const runRoot = mkdtempSync(join(tmpdir(), `teamuq-spike-run-${label}-`))
const dataDir = join(runRoot, 'data')
mkdirSync(dataDir, { recursive: true })
writeFileSync(join(dataDir, 'inside.txt'), 'inside-datadir-readable')
// Host bootstrap lives OUTSIDE the install stage, mirroring the real Core host bootstrap
// (backendLaunch passes request.entry = bootstrapFile, a Core-resource file separate from the
// plugin's installDir). It simply imports the backend code from the readable install stage.
const hostDir = join(runRoot, 'host')
mkdirSync(hostDir, { recursive: true })
const bootstrapFile = join(hostDir, 'host-bootstrap.mjs')
writeFileSync(bootstrapFile, `await import(${JSON.stringify(pathToFileURL(childScript).href)})\n`)

// --- 2b. fixtures OUTSIDE dataDir/installDir: a separate temp dir ---
const outsideDir = mkdtempSync(join(tmpdir(), `teamuq-spike-outside-${label}-`))
const outsideReadFixture = join(outsideDir, 'secret-read-fixture.txt')
const outsideWriteTarget = join(outsideDir, 'koffi-write-target.txt')
const outsidePlainDb = join(outsideDir, 'synthetic-plain.db')
const outsideCipherDb = join(outsideDir, 'synthetic-cipher.db')
writeFileSync(outsideReadFixture, 'TOP-SECRET-OUTSIDE-DATADIR-' + Date.now())

// pre-create a plain synthetic sqlite DB OUTSIDE dataDir (setup, unpermissioned)
try {
  const Database = require('better-sqlite3-multiple-ciphers')
  const db = new Database(outsidePlainDb)
  db.exec('create table spike(id integer primary key, label text)')
  const ins = db.prepare('insert into spike(id,label) values (?,?)')
  ins.run(1, 'alpha'); ins.run(2, 'beta')
  db.close()
} catch (e) {
  // If the launcher runtime cannot load sqlite (ABI mismatch), the child will report load state.
  writeFileSync(join(EVID, `${label}-launcher-sqlite-setup-error.txt`), String(e.stack || e))
}

const cfg = {
  outsideReadFixture, outsideWriteTarget, outsidePlainDb, outsideCipherDb,
  insideDataFixture: join(dataDir, 'inside.txt'),
  writePayload: 'KOFFI-WROTE-OUTSIDE-DATADIR-' + Date.now(),
  cipherKey: 'spike-cipher-key-123',
}

const init = {
  version: 1, pluginId: 'tuqdev.spike', installDir, dataDir, entry: bootstrapFile,
  assetPacks: {}, allowAddons, corePackaged: true,
}

// --- 3. exact launch flags ---
let flags = buildBackendPermissionFlags({ bootstrapFile, installDir, dataDir, assetDirs: [], allowAddons })
// Node-20 compatibility ONLY: the 1.6.8 contract emits `--permission` (its Core runs on Node 24 /
// Electron 44). Electron 31's bundled Node 20 names the identical feature `--experimental-permission`.
// With --exp-perm we remap ONLY the flag name; every scope (--allow-fs-read/write/--allow-addons)
// is byte-for-byte what buildBackendPermissionFlags produced. Used for the supporting sqlite run,
// since no ABI-149 better-sqlite3 binary exists to test under the real Electron-44 contract.
if (process.argv.includes('--exp-perm')) {
  flags = flags.map((f) => (f === '--permission' ? '--experimental-permission' : f))
}

// --- 4. spawn electron run-as-node with flags, exactly as spawnRunAsNodeBackend ---
const initArg = Buffer.from(JSON.stringify(init)).toString('base64url')
const cfgArg = Buffer.from(JSON.stringify(cfg)).toString('base64url')
const args = [...flags, bootstrapFile, initArg, cfgArg]

const env = { ELECTRON_RUN_AS_NODE: '1', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, windir: process.env.windir, TEMP: process.env.TEMP, TMP: process.env.TMP }

const started = Date.now()
const proc = spawnSync(electronExe, args, { env, cwd: dataDir, encoding: 'utf8', timeout: 60000 })
const durationMs = Date.now() - started

const stdout = proc.stdout || ''
const stderr = proc.stderr || ''
let parsed = null
const m = stdout.split('\n').find((l) => l.startsWith('RESULT:'))
if (m) { try { parsed = JSON.parse(m.slice('RESULT:'.length)) } catch (e) { parsed = { parseError: String(e) } } }

const record = {
  label, electronExe, allowAddons, exitCode: proc.status, signal: proc.signal, durationMs,
  flags, cwd: dataDir, dirs: { runRoot, installDir, dataDir, outsideDir },
  cfg, result: parsed,
}

writeFileSync(join(EVID, `${label}-command.txt`), `ELECTRON_RUN_AS_NODE=1 "${electronExe}" ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}\n`)
writeFileSync(join(EVID, `${label}-stdout.txt`), stdout)
writeFileSync(join(EVID, `${label}-stderr.txt`), stderr)
writeFileSync(join(EVID, `${label}-result.json`), JSON.stringify(record, null, 2))

console.log(JSON.stringify({ label, exitCode: proc.status, selfCheckOk: parsed?.selfCheck?.ok ?? null, abi: parsed?.runtime?.modules_abi ?? null, koffiLoaded: parsed?.experiments?.koffi?.loaded ?? null, bsqliteLoaded: parsed?.experiments?.bsqlite?.loaded ?? null }, null, 2))

// cleanup temp dirs (evidence already captured)
if (!process.argv.includes('--keep')) {
  for (const d of [runRoot, outsideDir]) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
}
