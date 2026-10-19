// Shared helpers for the Phase 1 engine tests: runtime discovery (Electron 31 writer/reference, Electron 44
// backend), esbuild bundling, fixture generation, and the standalone (better-sqlite3-multiple-ciphers)
// reference run. Nothing here touches a real LINE install, DB or key.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const WASM_DIR = join(ROOT, 'vendor', 'sqlite3mc-wasm')

function gitMainTree() {
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' })
  if (r.status !== 0) return null
  const common = resolve(ROOT, r.stdout.trim())
  return dirname(common) // <main>/.git -> <main>
}

function firstExisting(label, candidates) {
  for (const c of candidates) if (c && existsSync(c)) return c
  throw new Error(
    `${label} not found. Tried:\n  ${candidates.filter(Boolean).join('\n  ')}\n` +
      'Set the matching environment variable (see scripts/lib/runtimes.mjs) or install the runtime.',
  )
}

/**
 * Electron 31 = the standalone line-todo runtime (ABI 125). Used as (a) the "LINE.exe" writer that creates the
 * synthetic encrypted DBs and (b) the better-sqlite3-multiple-ciphers reference engine.
 */
export function findElectron31() {
  const main = gitMainTree()
  return firstExisting('Electron 31 (standalone runtime)', [
    process.env.LINE_TODO_ELECTRON31_EXE,
    join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    main && join(main, 'node_modules', 'electron', 'dist', 'electron.exe'),
  ])
}

/** Directory of a better-sqlite3-multiple-ciphers package whose native binary matches Electron 31. */
export function findBsqliteMcDir() {
  const main = gitMainTree()
  const has = (d) => d && existsSync(join(d, 'build', 'Release', 'better_sqlite3.node'))
  const cands = [
    process.env.LINE_TODO_BSQLITE3MC_DIR,
    join(ROOT, 'node_modules', 'better-sqlite3-multiple-ciphers'),
    main && join(main, 'node_modules', 'better-sqlite3-multiple-ciphers'),
  ].filter(has)
  return firstExisting('better-sqlite3-multiple-ciphers (built for Electron 31)', cands)
}

/** Electron 44.2.0 = the TeamUQ 1.6.8 backend runtime (ABI 149, run-as-node). */
export function findElectron44() {
  return firstExisting('Electron 44 (TeamUQ 1.6.8 backend runtime)', [
    process.env.TEAMUQ_ELECTRON44_EXE,
    'C:/teamuq/teamuq-electron/node_modules/electron/dist/electron.exe',
  ])
}

export function makeTempRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function rmQuiet(p) {
  try {
    rmSync(p, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

export function electronRunAsNode(exe, args, { env = {}, cwd = ROOT, timeout = 180000, flags = [] } = {}) {
  return spawnSync(exe, [...flags, ...args], {
    cwd,
    env: { ELECTRON_RUN_AS_NODE: '1', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, windir: process.env.windir, TEMP: process.env.TEMP, TMP: process.env.TMP, ...env },
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  })
}

/** Generate the synthetic encrypted fixtures (wal / rollback / int64 + expected.json) with the Electron 31 writer. */
export function generateFixtures(outDir, { baseN = 3000, walN = 300 } = {}) {
  mkdirSync(outDir, { recursive: true })
  const exe = findElectron31()
  const r = electronRunAsNode(exe, [join(ROOT, 'scripts', 'lib', 'gen-line-fixture.cjs'), outDir, String(baseN), String(walN)], {
    env: { BSQLITE3MC_DIR: findBsqliteMcDir() },
  })
  if (r.status !== 0) throw new Error(`fixture generator failed (exit ${r.status}):\n${r.stderr}\n${(r.stdout || '').slice(-1500)}`)
  return JSON.parse(readFileSync(join(outDir, 'expected.json'), 'utf8'))
}

/** esbuild a script into a single file. */
export async function bundle({ entry, outfile, format, target, external = [], alias = {} }) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format,
    target,
    external,
    alias,
    logLevel: 'error',
    legalComments: 'none',
  })
  return outfile
}

/**
 * Run the linedb suite through the STANDALONE engine (real better-sqlite3-multiple-ciphers, Node fs port) in
 * Electron 31. Returns the suite's JSON result — the reference every other engine is compared with.
 */
export async function runStandaloneReference({ fixtureDir, expected, workDir }) {
  const exe = findElectron31()
  const out = await bundle({
    entry: join(ROOT, 'scripts', 'lib', 'ref-standalone-entry.mjs'),
    outfile: join(workDir, 'ref-standalone.cjs'),
    format: 'cjs',
    target: 'node20',
    external: ['better-sqlite3-multiple-ciphers'],
  })
  const nodeModules = dirname(findBsqliteMcDir())
  const r = electronRunAsNode(exe, [out, Buffer.from(JSON.stringify({ fixtureDir, expected })).toString('base64url')], {
    env: { NODE_PATH: nodeModules },
    cwd: workDir,
  })
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT:'))
  if (r.status !== 0 || !line) throw new Error(`standalone reference run failed (exit ${r.status}):\n${r.stderr}\n${(r.stdout || '').slice(-1500)}`)
  return JSON.parse(line.slice('RESULT:'.length))
}
