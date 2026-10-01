// Unpermissioned quick check (system Node) that the WASM engine opens the WAL + rollback fixtures.
import { loadEngine } from '../harness/engine-wasm.mjs'
import { runSuite } from '../harness/linedb-queries.mjs'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const FIX = process.argv[2]
const exp = JSON.parse(readFileSync(join(FIX, 'expected.json'), 'utf8'))
const eng = await loadEngine()
console.log(JSON.stringify(eng.info))
for (const kind of ['wal', 'rollback']) {
  for (const exclusive of [false, true]) {
    try {
      const s = eng.openSnapshot(join(FIX, kind, 'm.edb'), exp.key, exp.cipher, exp.kdfIter, { exclusive })
      const count = s.adapter.get('SELECT count(*) AS c FROM _message', []).c
      const suite = runSuite(s.adapter, { ...exp[kind], cursorAtWalBoundary: exp.wal.cursorAtWalBoundary })
      console.log(kind, 'exclusive=' + exclusive, JSON.stringify({ count, expected: exp[kind].messageCount, digestOk: suite.messageDigest.value === exp[kind].messageDigest, journal: s.journalMode, checkpoint: s.checkpoint, t: s.timings, memFiles: s.memFiles.length }))
      s.cleanup()
    } catch (e) { console.log(kind, 'exclusive=' + exclusive, 'ERR', e.message, e.inner) }
  }
}
console.log('fixture sidecars untouched:', existsSync(join(FIX, 'wal', 'm.edb-wal')))
