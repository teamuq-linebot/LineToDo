// Run the full matrix sequentially (spawnSync => no lingering processes) and record exit codes.
// Usage: node scripts/run-all.mjs <fixturesDir>
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const FIX = process.argv[2]
const E44 = 'C:/teamuq/teamuq-electron/node_modules/electron/dist/electron.exe'
const E31 = 'C:/teamuq/line-todo/node_modules/electron/dist/electron.exe'
const runs = [
  { label: 'e44-wasm-addons', exe: E44, engine: 'wasm', extra: [] },
  { label: 'e44-wasm-noaddons', exe: E44, engine: 'wasm', extra: ['--no-addons'] },
  { label: 'e31-wasm-addons', exe: E31, engine: 'wasm', extra: ['--exp-perm'] },
  { label: 'e31-bsqlite-addons', exe: E31, engine: 'bsqlite', extra: ['--exp-perm'] },
  { label: 'e44-bsqlite-addons', exe: E44, engine: 'bsqlite', extra: [] },
]
const summary = []
for (const r of runs) {
  const args = ['harness/run.mjs', '--electron', r.exe, '--label', r.label, '--engine', r.engine, '--fixtures', FIX, '--iters', '7', '--scan', '500', ...r.extra]
  const p = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 900000 })
  console.log(`=== ${r.label} exit=${p.status}`)
  console.log(p.stdout)
  if (p.stderr) console.log('launcher stderr:', p.stderr.slice(0, 2000))
  summary.push({ label: r.label, command: `node ${args.join(' ')}`, exit: p.status })
}
writeFileSync(join(ROOT, 'evidence', 'run-all-exitcodes.json'), JSON.stringify(summary, null, 2))
