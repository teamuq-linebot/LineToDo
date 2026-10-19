// Full matrix. Sequential spawnSync (no background processes). Writes evidence/run-all-exitcodes.json.
// 1) E31 standalone (unpermissioned) + better-sqlite3 11.10.0 = the CURRENT line-todo writer; its
//    line-todo.db is exported as the "existing user DB" fixture for every E44 candidate's import phase.
// 2) E44.2.0 + verbatim 1.6.8 flags for every candidate (+ no-addons variants where no .node is used).
// 3) E31 standalone for every candidate (can standalone share the engine?).
// Usage: node scripts/run-all.mjs
import { spawnSync } from 'node:child_process'
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const E44 = 'C:/teamuq/teamuq-electron/node_modules/electron/dist/electron.exe'
const E31 = 'C:/teamuq/line-todo/node_modules/electron/dist/electron.exe'
const FIX = join(tmpdir(), 'teamuq-appdb-fixture-current-writer')
rmSync(FIX, { recursive: true, force: true })
rmSync(join(ROOT, 'evidence', 'runs'), { recursive: true, force: true })
mkdirSync(join(ROOT, 'evidence', 'runs'), { recursive: true })

const runs = [
  ['e31-sa-bs3-11.10.0', E31, ['--engine', 'bsqlite', '--vendor', 'bs3-11.10.0-linetodo', '--no-permission', '--export-to', FIX]],
  ['e44-node-sqlite', E44, ['--engine', 'node-sqlite', '--import-from', FIX]],
  ['e44-node-sqlite-noaddons', E44, ['--engine', 'node-sqlite', '--no-addons', '--import-from', FIX]],
  ['e44-bs3-13.0.2-teamuq', E44, ['--engine', 'bsqlite', '--vendor', 'bs3-13.0.2-teamuq', '--import-from', FIX]],
  ['e44-bs3-13.0.2-npm', E44, ['--engine', 'bsqlite', '--vendor', 'bs3-13.0.2-npm', '--import-from', FIX]],
  ['e44-bs3-13.0.3-npm', E44, ['--engine', 'bsqlite', '--vendor', 'bs3-13.0.3-npm', '--import-from', FIX]],
  ['e44-bs3-13.0.3-npm-noaddons', E44, ['--engine', 'bsqlite', '--vendor', 'bs3-13.0.3-npm', '--no-addons', '--import-from', FIX]],
  ['e44-bs3-11.10.0-linetodo', E44, ['--engine', 'bsqlite', '--vendor', 'bs3-11.10.0-linetodo', '--import-from', FIX]],
  ['e44-wasm-strict', E44, ['--engine', 'wasm', '--import-from', FIX]],
  ['e44-wasm-excl-strict', E44, ['--engine', 'wasm', '--wasm-exclusive', '--import-from', FIX]],
  ['e44-wasm-nosync', E44, ['--engine', 'wasm', '--wasm-sync-skip', '--import-from', FIX]],
  ['e44-wasm-excl-nosync', E44, ['--engine', 'wasm', '--wasm-exclusive', '--wasm-sync-skip', '--import-from', FIX]],
  ['e44-wasm-excl-nosync-noaddons', E44, ['--engine', 'wasm', '--wasm-exclusive', '--wasm-sync-skip', '--no-addons', '--import-from', FIX]],
  ['e31-sa-node-sqlite', E31, ['--engine', 'node-sqlite', '--no-permission', '--import-from', FIX]],
  ['e31-sa-bs3-13.0.3-npm', E31, ['--engine', 'bsqlite', '--vendor', 'bs3-13.0.3-npm', '--no-permission', '--import-from', FIX]],
  ['e31-sa-wasm-excl', E31, ['--engine', 'wasm', '--wasm-exclusive', '--no-permission', '--import-from', FIX]],
]
const record = []
for (const [label, exe, extra] of runs) {
  const args = [join(ROOT, 'harness', 'run.mjs'), '--electron', exe, '--label', label, ...extra]
  const t0 = Date.now()
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 900000, maxBuffer: 64 * 1024 * 1024 })
  record.push({ label, command: `node harness/run.mjs --electron ${exe} --label ${label} ${extra.join(' ').replace(FIX, '<tmp>/teamuq-appdb-fixture-current-writer')}`, exitCode: r.status, durationMs: Date.now() - t0 })
  writeFileSync(join(ROOT, 'evidence', 'runs', `${label}.summary.txt`), (r.stdout || '') + (r.stderr ? '\n[launcher stderr]\n' + r.stderr : ''))
  console.log(`${label}: exit ${r.status} (${Date.now() - t0} ms)`)
}
rmSync(FIX, { recursive: true, force: true })
writeFileSync(join(ROOT, 'evidence', 'run-all-exitcodes.json'), JSON.stringify({ note: 'launcher exit 0 = every phase child wrote a result file; pass/fail verdicts are in evidence/runs/<label>/result.json', fixtureDirRemoved: FIX, runs: record }, null, 2))
