// Launcher (unpermissioned; plays the TeamUQ host). For each phase it spawns the Electron binary as
// Node (ELECTRON_RUN_AS_NODE=1, 1.6.8 env allowlist) with the verbatim 1.6.8
// buildBackendPermissionFlags output, a host bootstrap OUTSIDE installDir, and the SAME dataDir, so
// every phase is a process restart against the persisted line-todo.db.
//
// Usage: node harness/run.mjs --electron <exe> --label <l> --engine node-sqlite|bsqlite|wasm
//          [--vendor <vendor dir name>] [--wasm-exclusive] [--wasm-sync-skip] [--no-addons] [--no-permission]
//          [--phases create,legacy,import,append-noclose,reopen] [--import-from <dir>] [--export-to <dir>] [--keep]
// Exit code: 0 iff every phase child produced a result file (verdicts are inside result.json).
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildBackendPermissionFlags } from './teamuq-contract.mjs'

const HARNESS = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HARNESS)
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d }
const has = (n) => process.argv.includes(`--${n}`)
const electronExe = arg('electron')
const label = arg('label', 'run')
const engine = arg('engine')
const vendor = arg('vendor', null)
const wasmExclusive = has('wasm-exclusive')
const wasmSyncSkip = has('wasm-sync-skip')
const allowAddons = !has('no-addons')
const permission = !has('no-permission')
const phases = arg('phases', 'create,legacy,import,append-noclose,reopen').split(',')
const importFrom = arg('import-from', null)
const exportTo = arg('export-to', null)
const EVID = join(ROOT, 'evidence', 'runs', label)
rmSync(EVID, { recursive: true, force: true }); mkdirSync(EVID, { recursive: true })

const installDir = ROOT
const runRoot = mkdtempSync(join(tmpdir(), `teamuq-appdb-${label}-`))
const dataDir = join(runRoot, 'data'); mkdirSync(dataDir, { recursive: true })
const hostDir = join(runRoot, 'host'); mkdirSync(hostDir, { recursive: true })
const bootstrapFile = join(hostDir, 'host-bootstrap.mjs')
writeFileSync(bootstrapFile, `await import(${JSON.stringify(pathToFileURL(join(HARNESS, 'child.mjs')).href)})\n`)
const init = { version: 1, pluginId: 'tuqdev.appdb-spike', installDir, dataDir, entry: bootstrapFile, assetPacks: {}, allowAddons, corePackaged: true }
const flags = permission ? buildBackendPermissionFlags({ bootstrapFile, installDir, dataDir, assetDirs: [], allowAddons }) : []
const env = { ELECTRON_RUN_AS_NODE: '1', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, windir: process.env.windir, TEMP: process.env.TEMP, TMP: process.env.TMP }
const listFiles = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => ({ name: e.name, size: statSync(join(d, e.name)).size })) : [])

const out = { label, electronExe, engine, vendor, wasmExclusive, wasmSyncSkip, allowAddons, permission, flags, dirs: { runRoot, installDir, dataDir, bootstrapFile }, phases: [] }
const expect = {}
for (const phase of phases) {
  if (phase === 'import') {
    if (!importFrom) { out.phases.push({ phase, skipped: 'no --import-from' }); continue }
    mkdirSync(join(dataDir, 'imported'), { recursive: true })
    for (const ext of ['', '-wal', '-shm']) { const f = join(importFrom, 'line-todo.db' + ext); if (existsSync(f)) copyFileSync(f, join(dataDir, 'imported', 'line-todo.db' + ext)) }
    expect.expectImport = JSON.parse(readFileSync(join(importFrom, 'expected.json'), 'utf8'))
  }
  const cfg = { label, phase, engine, vendor, wasmExclusive, wasmSyncSkip, ...expect }
  const args = [...flags, bootstrapFile, Buffer.from(JSON.stringify(init)).toString('base64url'), Buffer.from(JSON.stringify(cfg)).toString('base64url')]
  const t0 = Date.now()
  const proc = spawnSync(electronExe, args, { env, cwd: dataDir, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 })
  const durationMs = Date.now() - t0
  const resFile = join(dataDir, `.result-${phase}.json`)
  let result = null
  if (existsSync(resFile)) { result = JSON.parse(readFileSync(resFile, 'utf8')); rmSync(resFile) }
  writeFileSync(join(EVID, `${phase}-command.txt`), `ELECTRON_RUN_AS_NODE=1 "${electronExe}" ${[...flags, bootstrapFile, '<base64url init>', '<base64url cfg>'].join(' ')}\n`)
  writeFileSync(join(EVID, `${phase}-stdout.txt`), proc.stdout || '')
  writeFileSync(join(EVID, `${phase}-stderr.txt`), proc.stderr || '')
  const rec = { phase, exitCode: proc.status, exitCodeHex: proc.status == null ? null : '0x' + (proc.status >>> 0).toString(16), signal: proc.signal, spawnError: proc.error ? String(proc.error) : null, durationMs, resultWritten: !!result, filesAfter: listFiles(dataDir), result }
  out.phases.push(rec)
  if (phase === 'create' && exportTo && result?.phaseResult?.ok) {
    mkdirSync(exportTo, { recursive: true })
    for (const ext of ['', '-wal', '-shm']) { const f = join(dataDir, 'line-todo.db' + ext); if (existsSync(f)) copyFileSync(f, join(exportTo, 'line-todo.db' + ext)) }
    writeFileSync(join(exportTo, 'expected.json'), JSON.stringify({ writer: label, ...result.phaseResult.digest }, null, 2))
    rec.exportedTo = exportTo
  }
  if (phase === 'legacy' && result?.phaseResult?.digest) expect.expectLegacy = result.phaseResult.digest
  if (phase === 'append-noclose' && result?.phaseResult?.digest) expect.expectAppend = result.phaseResult.digest
  if (!result?.engine?.loaded) break // engine unavailable (or process crashed): later phases are meaningless
}

// interop: open a COPY of the final line-todo.db with a different engine (system Node's node:sqlite)
const mainDb = join(dataDir, 'line-todo.db')
if (existsSync(mainDb)) {
  const ic = join(runRoot, 'interop'); mkdirSync(ic, { recursive: true })
  for (const ext of ['', '-wal', '-shm']) if (existsSync(mainDb + ext)) copyFileSync(mainDb + ext, join(ic, 'line-todo.db' + ext))
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const d = new DatabaseSync(join(ic, 'line-todo.db'))
    try { out.interopSystemNodeSqlite = { node: process.versions.node, quickCheck: d.prepare('PRAGMA quick_check').get().quick_check, userVersion: d.prepare('PRAGMA user_version').get().user_version, journalModeOnDisk: d.prepare('PRAGMA journal_mode').get().journal_mode, messages: d.prepare('SELECT count(*) n FROM messages').get().n, todos: d.prepare('SELECT count(*) n FROM todos').get().n } } finally { d.close() }
  } catch (e) { out.interopSystemNodeSqlite = { error: String(e.message).slice(0, 200) } }
}
for (const f of readdirSync(tmpdir()).filter((n) => n.startsWith('appdb-outside-probe-'))) { out.outsideProbeLeftovers = (out.outsideProbeLeftovers ?? []).concat(f); rmSync(join(tmpdir(), f), { force: true }) }
writeFileSync(join(EVID, 'result.json'), JSON.stringify(out, null, 2))
if (!has('keep')) rmSync(runRoot, { recursive: true, force: true })

const P = Object.fromEntries(out.phases.map((p) => [p.phase, p]))
const sc = (p) => (p?.result ? [p.result.selfCheckBoot?.ok, p.result.selfCheckAfterEngine?.ok, p.result.selfCheckEnd?.ok].join('/') : null)
console.log(JSON.stringify({
  label, engineLoaded: P.create?.result?.engine?.loaded, engineError: P.create?.result?.engine?.loaded ? undefined : (P.create?.result?.engine ?? { exit: P.create?.exitCodeHex }),
  selfChecks: Object.fromEntries(out.phases.map((p) => [p.phase, sc(p)])),
  exits: Object.fromEntries(out.phases.map((p) => [p.phase, p.exitCodeHex ?? p.skipped])),
  create: P.create?.result?.phaseResult && { ok: P.create.result.phaseResult.ok, journal: P.create.result.phaseResult.state?.journalMode, uv: P.create.result.phaseResult.state?.userVersion, qc: P.create.result.phaseResult.state?.quickCheck, opsSha: P.create.result.phaseResult.opsSha, err: P.create.result.phaseError },
  legacy: P.legacy?.result?.phaseResult?.ok ?? P.legacy?.result?.phaseError,
  import: P.import?.result?.phaseResult?.ok ?? P.import?.result?.phaseError ?? P.import?.skipped,
  append: P['append-noclose'] && { exit: P['append-noclose'].exitCodeHex, files: P['append-noclose'].filesAfter.filter((f) => f.name.startsWith('line-todo')) },
  reopen: P.reopen?.result?.phaseResult?.ok ?? P.reopen?.result?.phaseError,
  outside: P.create?.result?.outsideDataDirOpen, interop: out.interopSystemNodeSqlite,
}, null, 1))
process.exit(out.phases.every((p) => p.skipped || p.resultWritten) ? 0 : 1)
