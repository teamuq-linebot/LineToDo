// Runs INSIDE the permissioned child (Electron run-as-node + the exact 1.6.8
// buildBackendPermissionFlags output). Order mirrors a real full-trust backend boot:
//   1. 1.6.8 runPermissionSelfCheck (authoritative gate; host refuses to boot when ok=false)
//   2. control: node:fs read of the outside "LINE" fixture must be ERR_ACCESS_DENIED
//   3. (optional) koffi CopyFileW snapshot of edb/-wal/-shm into dataDir  [stated precondition]
//   4. load the SQLite engine (WASM or better-sqlite3-mc), re-run self-check
//   5. correctness: open WAL + rollback snapshots with linedb.ts cipher params, run the
//      linedb.ts query suite, wrong-key rejection
//   6. benchmark: N x (copy, open+verify+checkpoint, one incremental watch batch)
//   7. key-scan throughput (linekey.ts BatchVerifier pattern)
// Emits RESULT:<json> on stdout.
import * as fs from 'node:fs'
import { join } from 'node:path'
import { runPermissionSelfCheck } from './teamuq-contract.mjs'
import { runSuite, watchBatch, newMessagesAfter, listChats, TAIL_SQL } from './linedb-queries.mjs'

const init = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'))
const cfg = JSON.parse(Buffer.from(process.argv[3], 'base64url').toString('utf8'))
const code = (e) => (e && typeof e.code === 'string' ? e.code : (e ? String(e.message).split('\n')[0].slice(0, 200) : 'unknown'))
const ms = (x) => Math.round(x * 100) / 100
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? ms(s[Math.floor((s.length - 1) / 2)]) : null }
const mem = () => { const m = process.memoryUsage(); return { rssMB: Math.round(m.rss / 1048576), heapUsedMB: Math.round(m.heapUsed / 1048576), externalMB: Math.round(m.external / 1048576), arrayBuffersMB: Math.round(m.arrayBuffers / 1048576) } }

const R = {
  runtime: { node: process.versions.node, electron: process.versions.electron ?? null, modules_abi: process.versions.modules },
  permissionActive: typeof process.permission === 'object' && process.permission !== null,
  cfgEcho: { engine: cfg.engine, copyVia: cfg.copyVia, iters: cfg.iters },
}

R.selfCheckBoot = runPermissionSelfCheck(init)

// 2. control — the outside DB must NOT be reachable through node:fs
try { fs.readFileSync(cfg.outside.walEdb); R.controlNodeFsOutside = { denied: false } } catch (e) { R.controlNodeFsOutside = { denied: code(e) === 'ERR_ACCESS_DENIED', code: code(e) } }
try { R.controlExistsOutside = { threw: false, value: fs.existsSync(cfg.outside.walEdb) } } catch (e) { R.controlExistsOutside = { threw: true, code: code(e) } }

// 3. snapshot helper
let koffi = null
if (cfg.copyVia === 'koffi') {
  try { koffi = await import('./win32-copy.mjs'); R.koffi = { loaded: true, version: koffi.koffiVersion } } catch (e) { R.koffi = { loaded: false, code: code(e) } }
}
function snapshot(kind, tag) {
  const dir = join(init.dataDir, `snap-${tag}`)
  fs.mkdirSync(dir, { recursive: true })
  const dst = join(dir, 'm.edb')
  if (cfg.copyVia === 'koffi') {
    const t0 = performance.now()
    const r = koffi.koffiSnapshot(cfg.outside[kind === 'wal' ? 'walEdb' : 'rollbackEdb'], dst)
    if (!r.ok) throw new Error('koffi copy failed ' + JSON.stringify(r))
    return { path: dst, dir, copyMs: performance.now() - t0, copied: r.copied }
  }
  // preplaced by the launcher (no addons at all in this run)
  return { path: join(init.dataDir, 'preplaced', kind, 'm.edb'), dir: null, copyMs: 0, copied: 'preplaced' }
}
const rmDir = (d) => { if (d) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } }

// 4. engine
const memBefore = mem()
let t0 = performance.now()
let eng
try {
  eng = await (cfg.engine === 'wasm' ? import('./engine-wasm.mjs') : import('./engine-bsqlite.mjs')).then((m) => m.loadEngine())
  R.engine = { loaded: true, loadMs: ms(performance.now() - t0), info: eng.info }
} catch (e) {
  R.engine = { loaded: false, code: code(e), stack: String(e.stack).split('\n').slice(0, 4) }
}
R.memAfterEngineLoad = mem()
R.memBefore = memBefore
R.selfCheckAfterEngine = runPermissionSelfCheck(init)

const exp = cfg.expected
const openOpts = cfg.engine === 'wasm' ? { exclusive: true } : {}

if (R.engine.loaded) {
  // 5a. WASM only: default locking mode on a WAL snapshot (documents the shm limitation)
  if (cfg.engine === 'wasm') {
    const s = snapshot('wal', 'nonexcl')
    try { const o = eng.openSnapshot(s.path, exp.key, exp.cipher, exp.kdfIter, { exclusive: false }); R.walDefaultLocking = { ok: true, count: o.adapter.get('SELECT count(*) AS c FROM _message', []).c }; o.cleanup() } catch (e) { R.walDefaultLocking = { ok: false, error: String(e.inner || e.message).slice(0, 200) } }
    rmDir(s.dir)
  }
  // 5b. correctness on both fixtures
  R.correctness = {}
  for (const kind of ['wal', 'rollback']) {
    const s = snapshot(kind, `c-${kind}`)
    try {
      const o = eng.openSnapshot(s.path, exp.key, exp.cipher, exp.kdfIter, openOpts)
      const suite = runSuite(o.adapter, { ...exp[kind], cursorAtWalBoundary: exp.wal.cursorAtWalBoundary })
      R.correctness[kind] = {
        ok: true, copied: s.copied, journalMode: o.journalMode, checkpoint: o.checkpoint,
        countMatches: suite.messageCount.value === exp[kind].messageCount,
        digestMatches: suite.messageDigest.value === exp[kind].messageDigest,
        maxRowMatches: suite.tail.ok && suite.tail.value.rid === exp[kind].maxRow.rowId && suite.tail.value.m === exp[kind].maxRow.createdTime,
        suite,
      }
      o.cleanup()
    } catch (e) { R.correctness[kind] = { ok: false, error: String(e.inner || e.message).slice(0, 300) } }
    rmDir(s.dir)
  }
  // 5c. wrong key must be rejected
  {
    const s = snapshot('wal', 'wrongkey')
    try { const o = eng.openSnapshot(s.path, 'ffffffffffffffffffffffffffffffff', exp.cipher, exp.kdfIter, openOpts); o.cleanup(); R.wrongKey = { rejected: false } } catch (e) { R.wrongKey = { rejected: true, error: String(e.inner || e.message).slice(0, 120) } }
    rmDir(s.dir)
  }
  // 6. benchmark
  const B = []
  for (let i = 0; i < cfg.iters; i++) {
    const s = snapshot('wal', `b${i}`)
    const it = { copyMs: ms(s.copyMs) }
    let t = performance.now()
    const o = eng.openSnapshot(s.path, exp.key, exp.cipher, exp.kdfIter, openOpts)
    it.openTotalMs = ms(performance.now() - t)
    it.open = Object.fromEntries(Object.entries(o.timings).map(([k, v]) => [k, ms(v)]))
    it.memAfterOpen = mem()
    t = performance.now(); const wb = watchBatch(o.adapter, exp.wal.cursorAtWalBoundary, 500); it.watchBatchMs = ms(performance.now() - t); it.watchBatchRows = wb.items.length; it.watchBatchHasMore = wb.hasMore
    t = performance.now(); const raw = newMessagesAfter(o.adapter, exp.wal.cursorAtWalBoundary, null, 501); it.rawIncrementalMs = ms(performance.now() - t); it.rawIncrementalRows = raw.length
    t = performance.now(); listChats(o.adapter, 50); it.listChats50Ms = ms(performance.now() - t)
    t = performance.now(); o.adapter.get(TAIL_SQL, []); it.tailMs = ms(performance.now() - t)
    t = performance.now(); o.cleanup(); it.closeMs = ms(performance.now() - t)
    rmDir(s.dir)
    B.push(it)
  }
  R.bench = {
    iters: B,
    median: {
      copyMs: median(B.map((b) => b.copyMs)), openTotalMs: median(B.map((b) => b.openTotalMs)),
      loadBytesMs: median(B.map((b) => b.open.loadBytesMs)), openVerifyMs: median(B.map((b) => b.open.openVerifyMs)), checkpointMs: median(B.map((b) => b.open.checkpointMs)),
      watchBatchMs: median(B.map((b) => b.watchBatchMs)), rawIncrementalMs: median(B.map((b) => b.rawIncrementalMs)), listChats50Ms: median(B.map((b) => b.listChats50Ms)), tailMs: median(B.map((b) => b.tailMs)),
      openPlusWatchBatchMs: median(B.map((b) => b.openTotalMs + b.watchBatchMs)),
    },
    first: B[0] ? { openTotalMs: B[0].openTotalMs, watchBatchMs: B[0].watchBatchMs } : null,
  }
  R.memEnd = mem()
  // 7. key scan
  {
    const s = snapshot('rollback', 'scan')
    const keys = []
    for (let i = 0; i < cfg.scanCandidates; i++) keys.push(i.toString(16).padStart(32, '0').replace(/^0/, 'a'))
    keys.push(exp.key)
    const t = performance.now()
    const res = eng.keyScan(s.path, keys, exp.cipher, exp.kdfIter)
    const total = performance.now() - t
    R.keyScan = { candidates: keys.length, totalMs: ms(total), perCandidateMs: ms(total / keys.length), hits: res.filter(Boolean).length, rightKeyHit: res.at(-1) === true }
    rmDir(s.dir)
  }
}
R.selfCheckEnd = runPermissionSelfCheck(init)
process.stdout.write('RESULT:' + JSON.stringify(R) + '\n')
