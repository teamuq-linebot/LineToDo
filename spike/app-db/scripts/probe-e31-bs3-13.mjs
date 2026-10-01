// Spawn Electron 31 (run-as-node, unpermissioned = standalone runtime) loading better-sqlite3 13.x and
// record the raw exit status (bash truncates Windows NTSTATUS codes). Writes evidence/e31-bs3-13-crash.json
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const E31 = 'C:/teamuq/line-todo/node_modules/electron/dist/electron.exe'
const out = []
for (const name of ['bs3-13.0.2-teamuq', 'bs3-13.0.2-npm', 'bs3-13.0.3-npm', 'bs3-11.10.0-linetodo']) {
  const r = spawnSync(E31, [join(ROOT, 'scripts', 'probe-one-bs3.cjs'), name], { env: { ELECTRON_RUN_AS_NODE: '1', SystemRoot: process.env.SystemRoot, PATH: process.env.PATH }, encoding: 'utf8', timeout: 60000 })
  out.push({ name, status: r.status, statusHex: r.status == null ? null : '0x' + (r.status >>> 0).toString(16), signal: r.signal, stdout: r.stdout.trim(), stderr: r.stderr.trim().split('\n').filter((l) => !l.includes('crashpad')).slice(0, 5) })
}
writeFileSync(join(ROOT, 'evidence', 'e31-bs3-load.json'), JSON.stringify({ electron: E31, mode: 'ELECTRON_RUN_AS_NODE=1, no permission flags (standalone runtime)', results: out }, null, 2))
console.log(JSON.stringify(out, null, 1))
