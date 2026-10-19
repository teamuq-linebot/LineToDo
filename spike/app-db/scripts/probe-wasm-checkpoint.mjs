// Diagnose: does the WASM + nodefs VFS (EXCLUSIVE WAL) ever checkpoint? Unpermissioned system Node.
// Usage: node scripts/probe-wasm-checkpoint.mjs   (writes evidence/wasm-checkpoint-probe.json)
import { mkdtempSync, statSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEngine } from '../harness/engines/wasm-nodefs.mjs'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(tmpdir(), 'teamuq-appdb-ckpt-'))
const eng = await loadEngine({ wasmExclusive: true }, { dataDir: dir })
const p = join(dir, 'c.db')
const size = (f) => (existsSync(f) ? statSync(f).size : null)
const snap = (tag) => ({ tag, db: size(p), wal: size(p + '-wal') })
const out = []
let db = eng.factory(p)
out.push({ journal: db.pragma('journal_mode = WAL'), locking: db.pragma('locking_mode', { simple: true }), autockpt: db.pragma('wal_autocheckpoint', { simple: true }) })
db.exec('CREATE TABLE t(x)'); const ins = db.prepare('INSERT INTO t VALUES (?)')
db.transaction(() => { for (let i = 0; i < 3000; i++) ins.run('y'.repeat(200)) })()
out.push(snap('after-insert'))
out.push({ explicitCheckpoint: db.pragma('wal_checkpoint(TRUNCATE)') }, snap('after-explicit-checkpoint'))
db.transaction(() => { for (let i = 0; i < 100; i++) ins.run('z') })()
out.push(snap('after-more'))
db.close(); out.push(snap('after-close'), { vfs: eng.vfs.stats.xTruncate, lastError: eng.vfs.lastError() })
db = eng.factory(p); out.push({ countAfterReopen: db.prepare('select count(*) n from t').get().n }); db.close(); out.push(snap('after-reopen-close'))
rmSync(dir, { recursive: true, force: true })
writeFileSync(join(ROOT, 'evidence', 'wasm-checkpoint-probe.json'), JSON.stringify(out, null, 2)); console.log(JSON.stringify(out))
