// Realistic watch-loop memory probe WITHOUT forced GC: repeat (open snapshot -> one incremental
// watch batch -> close) N times with a short idle gap, sampling RSS. Approximates the backend's
// periodic poll; tells whether working set stays under the 1.6.8 resources.memory limit
// (hostResourceMonitor: workingSet sampled every 30 s, trips after 3 consecutive samples over).
//   ELECTRON_RUN_AS_NODE=1 electron44.exe scripts/mem-loop.mjs <fixturesDir> <N> <idleMs>   (WASM engine only)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { watchBatch } from '../harness/linedb-queries.mjs'

const [FIX, N = '10', IDLE = '500'] = process.argv.slice(2)
const ENGINE = 'wasm'
const exp = JSON.parse(readFileSync(join(FIX, 'expected.json'), 'utf8'))
const { loadEngine } = await import(ENGINE === 'wasm' ? '../harness/engine-wasm.mjs' : '../harness/engine-bsqlite.mjs')
const eng = await loadEngine()
const rss = () => Math.round(process.memoryUsage().rss / 1048576)
const samples = []
let peak = 0
const sampler = setInterval(() => { const r = rss(); peak = Math.max(peak, r) }, 20)
for (let i = 0; i < Number(N); i++) {
  const t = performance.now()
  const o = eng.openSnapshot(join(FIX, 'wal', 'm.edb'), exp.key, exp.cipher, exp.kdfIter, { exclusive: true }) // wasm only: RW on the MEMFS copy, same as linedb openDb (bsqlite would mutate the fixture in place)
  const afterOpen = rss()
  watchBatch(o.adapter, exp.wal.cursorAtWalBoundary, 500)
  o.cleanup()
  const ms = Math.round(performance.now() - t)
  await new Promise((r) => setTimeout(r, Number(IDLE)))
  samples.push({ i, ms, rssAfterOpen: afterOpen, rssAfterIdle: rss() })
  peak = Math.max(peak, afterOpen)
}
clearInterval(sampler)
console.log(JSON.stringify({ engine: ENGINE, runtime: process.versions.electron, dbBytes: exp.wal.files, N: Number(N), idleMs: Number(IDLE), peakRssMB: peak, final: rss(), samples }, null, 2))
