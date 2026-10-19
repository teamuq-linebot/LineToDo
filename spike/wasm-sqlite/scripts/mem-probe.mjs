// Memory/latency probe of the WASM engine's MEMFS approach, step by step, for one fixture.
// Diagnostic only (runs without the permission flags; the permissioned numbers are in the
// harness runs). Run under Electron 44 run-as-node with --expose-gc:
//   ELECTRON_RUN_AS_NODE=1 electron44.exe --expose-gc scripts/mem-probe.mjs <fixturesDir> [exclusive=1]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadEngine } from '../harness/engine-wasm.mjs'
import { watchBatch } from '../harness/linedb-queries.mjs'

const FIX = process.argv[2]
const exp = JSON.parse(readFileSync(join(FIX, 'expected.json'), 'utf8'))
const gc = globalThis.gc ?? (() => {})
const steps = []
const mark = (name, eng) => { gc(); gc(); const m = process.memoryUsage(); steps.push({ step: name, rssMB: Math.round(m.rss / 1048576), externalMB: Math.round(m.external / 1048576), heapUsedMB: Math.round(m.heapUsed / 1048576), wasmMemMB: eng ? Math.round(eng.sqlite3.wasm.memory.buffer.byteLength / 1048576) : null }) }
mark('start')
const eng = await loadEngine()
mark('engineLoaded', eng)
const edb = join(FIX, 'wal', 'm.edb')
const t0 = performance.now()
const o = eng.openSnapshot(edb, exp.key, exp.cipher, exp.kdfIter, { exclusive: true })
const openMs = performance.now() - t0
mark('opened+checkpointed', eng)
const t1 = performance.now()
const wb = watchBatch(o.adapter, exp.wal.cursorAtWalBoundary, 500)
const batchMs = performance.now() - t1
mark('watchBatch', eng)
o.cleanup()
mark('closed+unlinked', eng)
const o2 = eng.openSnapshot(edb, exp.key, exp.cipher, exp.kdfIter, { exclusive: true })
mark('reopened(2nd)', eng)
o2.cleanup()
mark('closed(2nd)', eng)
const files = exp.wal.files
console.log(JSON.stringify({ runtime: process.versions.electron, fixture: { files, messageCount: exp.wal.messageCount }, openMs: Math.round(openMs), timings: o.timings, watchBatchMs: Math.round(batchMs), rows: wb.items.length, steps }, null, 2))
