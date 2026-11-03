// Persistent LINE snapshot (src/main/line/engine/lineSnapshot.ts) and the single entry point + shared key (lineAccess.ts), through the production wiring (assemble.ts).
//
// Store level (a counting fs port over a synthetic LINE directory — no real LINE, DB or key is touched):
//   * unchanged signatures copy nothing (reuse); a changed -wal copies only the -wal (never the -shm, never the edb); a wal reset / edb change falls back to a full copy
//   * the guards: edb changing while the -wal is being copied, a different -wal header, an edb that keeps changing during a full copy
//   * the 'any' policy never stats the source and never copies; single-flight; a persisted meta is reused after a restart, a broken one is not
//   * leases: the swap waits for every lease, shouldYield() tells holders to let go, a lease that is never released fails the update instead of hanging it
//   * the copy is asynchronous: with the real koffi `.async` CopyFileW the event loop keeps ticking while 64 MB are copied (a blocking control proves the monitor is not vacuous)
// Access level: a corrupted local copy heals itself once; a stale key is renewed once; 'any' never resolves a key.
// Wiring level: createPluginBackend installs the access, backend.info reports lineSnapshot / keyHeld, and — signatures unchanged — 10 polls, 5 avatar reads, a reconcile fingerprint and a
// key re-validation copy nothing; snap / bg events land in invoke-trace.log.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { configureLineEnginePorts, getLineEnginePorts, resetLineEnginePorts } from '../../src/main/line/engine/enginePorts.ts'
import { createLineAccess } from '../../src/main/line/engine/lineAccess.ts'
import { LineSnapshotStore } from '../../src/main/line/engine/lineSnapshot.ts'
import { createNodeLineFsPort } from '../../src/main/line/engine/nodeLineFsPort.ts'
import { createWin32LineFsPort } from '../../src/main/line/engine/native/win32fs.ts'
import { getAvatarMetadata, getLineImportBatch, resetNow } from '../../src/main/line/engine/watchEngine.ts'
import { getSourceMonthlyFingerprint } from '../../src/main/pipeline/reconcile.ts'
import { createPluginBackend } from '../../src/plugin/backend/assemble.ts'

const GOOD_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
let savedKeyEnv
test.before(() => { savedKeyEnv = process.env.LINE_DB_KEY; delete process.env.LINE_DB_KEY })
test.after(() => { resetLineEnginePorts(); if (savedKeyEnv !== undefined) process.env.LINE_DB_KEY = savedKeyEnv })
const STALE_KEY = '00112233445566778899aabbccddeeff'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const busyWait = (ms) => { const end = performance.now() + ms; while (performance.now() < end) { /* blocks like a synchronous 270 MB copy */ } }
async function until(predicate, { timeout = 8000, step = 10, message = 'condition' } = {}) {
  const t0 = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - t0 > timeout) assert.fail(`timed out waiting for ${message}`)
    await sleep(step)
  }
}
/** Largest CPU-busy gap between 10 ms ticks: min(wall gap, CPU time burned in the gap). A loop that is really blocked burns CPU for the whole gap; a process that is just not scheduled on a starved machine does not. */
function loopMonitor() {
  let last = performance.now()
  let lastCpu = process.cpuUsage()
  let max = 0
  let maxWall = 0
  const timer = setInterval(() => {
    const now = performance.now()
    const cpu = process.cpuUsage()
    max = Math.max(max, Math.min(now - last, ((cpu.user - lastCpu.user) + (cpu.system - lastCpu.system)) / 1000))
    maxWall = Math.max(maxWall, now - last)
    last = now
    lastCpu = cpu
  }, 10)
  return { maxGapMs: () => max, maxWallGapMs: () => maxWall, reset: () => { max = 0; maxWall = 0; last = performance.now(); lastCpu = process.cpuUsage() }, stop: () => clearInterval(timer) }
}

let tick = 0
/** Moves a file's mtime forward by a distinct amount so its signature changes even when the size does not. */
function bump(path) { const t = new Date(Date.now() + (++tick) * 5000); utimesSync(path, t, t) }
/** A WAL "generation": the 32-byte header identifies it (salts / checkpoint sequence in the real format). */
const walHeader = (gen) => createHash('sha256').update(`wal-generation-${gen}`).digest().subarray(0, 32)

/** A synthetic LINE directory + a counting fs port (copies, source stats, text reads) + hooks to interleave changes with copies. */
function stage({ edbBytes = 256 * 1024, walBytes = 64 * 1024 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'line-snapshot-'))
  const lineDir = join(root, 'LINE', 'Data', 'db')
  const dataDir = join(root, 'data')
  const snapDir = join(dataDir, 'line-engine', 'snapshot')
  mkdirSync(lineDir, { recursive: true })
  mkdirSync(join(dataDir, 'line-engine'), { recursive: true })
  const src = join(lineDir, 'qw0001.edb')
  writeFileSync(src, Buffer.alloc(edbBytes, 5))
  writeFileSync(`${src}-shm`, Buffer.alloc(32 * 1024, 9))
  const writeWal = (gen, bytes) => { writeFileSync(`${src}-wal`, Buffer.concat([walHeader(gen), Buffer.alloc(bytes, 3 + gen)])); bump(`${src}-wal`) }
  const growWal = (bytes) => { appendFileSync(`${src}-wal`, Buffer.alloc(bytes, 7)); bump(`${src}-wal`) }
  writeWal(1, walBytes)

  const base = createNodeLineFsPort({ tempRoot: join(dataDir, 'line-engine') })
  const calls = { copy: [], copyAsync: [], stat: [], textReads: [] }
  const hooks = { afterCopyAsync: null }
  const fs = {
    readDir: (d) => base.readDir(d),
    stat: (p) => { calls.stat.push(p); return base.stat(p) },
    exists: (p) => base.exists(p),
    readFile: (p) => base.readFile(p),
    copyFile: (s, d) => { calls.copy.push(s); base.copyFile(s, d) },
    copyFileAsync: async (s, d) => { calls.copyAsync.push(s); await base.copyFileAsync(s, d); hooks.afterCopyAsync?.(s, d) },
    readHead: (p, n) => base.readHead(p, n),
    makeTempDir: (p) => base.makeTempDir(p),
    removeDir: (d) => base.removeDir(d),
    ensureDir: (d) => base.ensureDir(d),
    readTextFile: (p) => { calls.textReads.push(p); return base.readTextFile(p) },
    writeTextFile: (p, t) => base.writeTextFile(p, t),
    renameFile: (a, b) => base.renameFile(a, b),
    listProcessIds: () => [4242]
  }
  const state = { opens: [], closed: [], pragmas: [], goodKeys: new Set([GOOD_KEY]) }
  const sqlite = {
    name: 'fake',
    open(path) {
      state.opens.push(path)
      const bytes = readFileSync(path)
      const corrupt = bytes.includes(Buffer.from('CORRUPT'))
      let key = ''
      return {
        pragma(source) { state.pragmas.push(source); const m = /^key='(.*)'$/.exec(source); if (m) key = m[1]; return [] },
        prepare(sql) {
          return {
            get() { if (/sqlite_master/.test(sql)) { if (corrupt || !state.goodKeys.has(key)) throw new Error('file is not a database'); return { 'count(*)': 1 } } return undefined },
            all() { if (corrupt || !state.goodKeys.has(key)) throw new Error('file is not a database'); return [] }
          }
        },
        close() { state.closed.push(path) }
      }
    }
  }
  const copiesOf = (suffix) => [...calls.copy, ...calls.copyAsync].filter((p) => p.endsWith(suffix)).length
  return {
    root, lineDir, dataDir, snapDir, src, fs, calls, hooks, state, sqlite, writeWal, growWal, copiesOf,
    totalCopies: () => calls.copy.length + calls.copyAsync.length,
    srcStats: () => calls.stat.filter((p) => p.startsWith(src)).length,
    store: (extra = {}) => new LineSnapshotStore({ fs, dir: snapDir, ...extra }),
    localEdb: () => readFileSync(join(snapDir, 'cur', 'm.edb')),
    localWal: () => readFileSync(join(snapDir, 'cur', 'm.edb-wal')),
    cleanup: () => { resetLineEnginePorts(); rmSync(root, { recursive: true, force: true }) }
  }
}

// ───────────── store: reuse / wal-only / fallbacks ─────────────

test('reuse: with unchanged signatures nothing is copied; the first acquire copies edb + -wal (never the -shm) into a copy byte-identical to the source', async () => {
  const s = stage()
  try {
    const store = s.store()
    const first = await store.acquire(s.src, 'fresh')
    assert.equal(first.path, join(s.snapDir, 'cur', 'm.edb'))
    assert.deepEqual(s.calls.copyAsync.map((p) => p.slice(s.lineDir.length)), [`\\qw0001.edb`, `\\qw0001.edb-wal`])
    assert.deepEqual(s.localEdb(), readFileSync(s.src))
    assert.deepEqual(s.localWal(), readFileSync(`${s.src}-wal`))
    assert.equal(existsSync(join(s.snapDir, 'cur', 'm.edb-shm')), false, 'the -shm is never copied')
    assert.deepEqual([first.source.edb[0], first.source.wal[0]], [256 * 1024, 32 + 64 * 1024])
    first.release()
    const copies = s.totalCopies()
    for (let i = 0; i < 10; i += 1) (await store.acquire(s.src, 'fresh')).release()
    assert.equal(s.totalCopies(), copies, 'ten more acquires copied nothing')
    assert.equal(s.calls.copy.length, 0, 'and no synchronous copy ever happened')
    assert.deepEqual({ ...store.stats(), lastMs: null }, { reuse: 10, walCopies: 0, fullCopies: 1, invalidations: 0, copiedBytes: 256 * 1024 + 32 + 64 * 1024, syncCopies: 0, lastKind: 'reuse', lastMs: null })
  } finally { s.cleanup() }
})

test('wal-only: when only the -wal changed (same header) just the -wal is copied; the local copy equals the source; no edb and no -shm copy', async () => {
  const s = stage()
  try {
    const store = s.store()
    ;(await store.acquire(s.src, 'fresh')).release()
    const edbCopies = s.copiesOf('qw0001.edb')
    s.growWal(48 * 1024)
    const lease = await store.acquire(s.src, 'fresh')
    assert.equal(s.copiesOf('qw0001.edb'), edbCopies, 'the edb was not copied again')
    assert.equal(s.copiesOf('qw0001.edb-wal'), 2, 'one more -wal copy')
    assert.equal(s.copiesOf('-shm'), 0, 'the -shm is never copied')
    assert.deepEqual(s.localWal(), readFileSync(`${s.src}-wal`))
    assert.deepEqual(s.localEdb(), readFileSync(s.src))
    assert.equal(lease.source.wal[0], 32 + 64 * 1024 + 48 * 1024)
    lease.release()
    assert.equal(store.stats().walCopies, 1)
    assert.equal(store.stats().fullCopies, 1)
    assert.equal(existsSync(join(s.snapDir, 'next')), false, 'the staging directory is cleaned up')
    // and the new signature is the reuse baseline: nothing more to copy
    const total = s.totalCopies()
    ;(await store.acquire(s.src, 'fresh')).release()
    assert.equal(s.totalCopies(), total)
  } finally { s.cleanup() }
})

test('wal reset: a different -wal header (new salt / checkpoint) with an unchanged edb is not trusted — back to a full copy', async () => {
  const s = stage()
  try {
    const store = s.store()
    ;(await store.acquire(s.src, 'fresh')).release()
    s.writeWal(2, 8 * 1024) // a new generation of the same-sized-or-smaller file
    const edbCopies = s.copiesOf('qw0001.edb')
    const lease = await store.acquire(s.src, 'fresh')
    assert.equal(s.copiesOf('qw0001.edb'), edbCopies + 1, 'the edb was copied again')
    assert.deepEqual(s.localWal(), readFileSync(`${s.src}-wal`))
    lease.release()
    assert.deepEqual({ w: store.stats().walCopies, f: store.stats().fullCopies }, { w: 0, f: 2 }, 'the wal copy was discarded, the full copy counted')
  } finally { s.cleanup() }
})

test('wal-only guard: the edb changing while the -wal is being copied discards the wal copy (full copy instead); same-header growth of the wal while the edb is stable is fine', async () => {
  const s = stage()
  try {
    const store = s.store()
    ;(await store.acquire(s.src, 'fresh')).release()
    s.growWal(4096)
    let first = true
    s.hooks.afterCopyAsync = (from) => { if (first && from.endsWith('-wal')) { first = false; bump(s.src) } } // LINE checkpoints while we copy the -wal
    const lease = await store.acquire(s.src, 'fresh')
    lease.release()
    assert.deepEqual({ w: store.stats().walCopies, f: store.stats().fullCopies }, { w: 0, f: 2 })
    assert.deepEqual(s.localEdb(), readFileSync(s.src))
    s.hooks.afterCopyAsync = null
    const total = s.totalCopies()
    ;(await store.acquire(s.src, 'fresh')).release()
    assert.equal(s.totalCopies(), total, 'the full copy recorded the post-change signature: reuse')
  } finally { s.cleanup() }
})

test('full copy: an edb that changes during the copy is copied again; if it never settles the third attempt is accepted but recorded with its pre-copy signature, so the next acquire copies again', async () => {
  const s = stage()
  try {
    const store = s.store()
    let changes = 1
    s.hooks.afterCopyAsync = (from) => { if (changes > 0 && from.endsWith('-wal')) { changes -= 1; bump(s.src) } }
    const lease = await store.acquire(s.src, 'fresh')
    lease.release()
    assert.equal(s.copiesOf('qw0001.edb'), 2, 'one redo')
    assert.equal(store.stats().fullCopies, 1, 'it is still one logical full copy')
    s.hooks.afterCopyAsync = null
    const total = s.totalCopies()
    ;(await store.acquire(s.src, 'fresh')).release()
    assert.equal(s.totalCopies(), total, 'the settled copy is the reuse baseline')

    const s2 = stage()
    try {
      const store2 = s2.store()
      s2.hooks.afterCopyAsync = (from) => { if (from.endsWith('-wal')) bump(s2.src) } // never settles
      const l2 = await store2.acquire(s2.src, 'fresh')
      assert.equal(s2.copiesOf('qw0001.edb'), 3, 'the first copy and at most two redos')
      const preCopy = l2.source.edb[1]
      l2.release()
      s2.hooks.afterCopyAsync = null
      const l3 = await store2.acquire(s2.src, 'fresh')
      assert.equal(s2.copiesOf('qw0001.edb'), 4, 'the recorded signature is the pre-copy one, which no longer matches: copy again')
      assert.notEqual(l3.source.edb[1], preCopy)
      l3.release()
    } finally { s2.cleanup() }
  } finally { s.cleanup() }
})

test('walOnly:false, or a port without readHead, always copies everything when the wal changed; a stale snapshot older than fullResyncMs gets a full copy instead of wal-only — but an unchanged source stays a zero-copy reuse', async () => {
  const s = stage()
  try {
    const store = s.store({ walOnly: false })
    ;(await store.acquire(s.src, 'fresh')).release()
    s.growWal(100)
    ;(await store.acquire(s.src, 'fresh')).release()
    assert.deepEqual({ w: store.stats().walCopies, f: store.stats().fullCopies }, { w: 0, f: 2 })
  } finally { s.cleanup() }
  const s2 = stage()
  try {
    let clock = 1_000_000
    const store = s2.store({ fullResyncMs: 60_000, now: () => clock })
    ;(await store.acquire(s2.src, 'fresh')).release()
    clock += 59_000
    s2.growWal(100)
    ;(await store.acquire(s2.src, 'fresh')).release()
    assert.equal(store.stats().walCopies, 1, 'inside the resync window: wal-only')
    clock += 61_000
    ;(await store.acquire(s2.src, 'fresh')).release()
    assert.equal(store.stats().fullCopies, 1, 'unchanged source: still reuse after the window')
    s2.growWal(100)
    ;(await store.acquire(s2.src, 'fresh')).release()
    assert.equal(store.stats().fullCopies, 2, 'past the window the next change is a full copy, not wal-only')
    assert.equal(store.stats().walCopies, 1)
  } finally { s2.cleanup() }
  const s3 = stage()
  try {
    const noHead = { ...s3.fs, readHead: undefined }
    const store = new LineSnapshotStore({ fs: noHead, dir: s3.snapDir })
    ;(await store.acquire(s3.src, 'fresh')).release()
    s3.growWal(100)
    ;(await store.acquire(s3.src, 'fresh')).release()
    assert.equal(store.stats().walCopies, 0, 'without readHead the header guard cannot run, so wal-only is never used')
  } finally { s3.cleanup() }
})

test('a port without copyFileAsync falls back to the synchronous copy and the store counts it', async () => {
  const s = stage()
  try {
    const sync = { ...s.fs, copyFileAsync: undefined }
    const store = new LineSnapshotStore({ fs: sync, dir: s.snapDir })
    ;(await store.acquire(s.src, 'fresh')).release()
    assert.equal(store.stats().syncCopies, 2)
    assert.equal(s.calls.copyAsync.length, 0)
    assert.deepEqual(s.localEdb(), readFileSync(s.src))
  } finally { s.cleanup() }
})

// ───────────── store: any / single-flight / persistence ─────────────

test("'any' never copies and never stats the source: no snapshot yet = null; with one it hands out the existing copy even though the source has changed", async () => {
  const s = stage()
  try {
    const store = s.store()
    assert.equal(await store.acquire(s.src, 'any'), null)
    assert.equal(await store.acquire(null, 'any'), null)
    assert.equal(s.totalCopies(), 0)
    assert.equal(s.srcStats(), 0)
    ;(await store.acquire(s.src, 'fresh')).release()
    s.growWal(1000) // the source moved on; 'any' does not care
    const copies = s.totalCopies()
    const statsBefore = s.srcStats()
    const lease = await store.acquire(s.src, 'any')
    assert.ok(lease)
    assert.equal(lease.path, join(s.snapDir, 'cur', 'm.edb'))
    lease.release()
    assert.equal((await store.acquire(null, 'any')).release(), undefined)
    assert.equal(s.totalCopies(), copies, "no copy for 'any'")
    assert.equal(s.srcStats(), statsBefore, "no stat of the source for 'any'")
    assert.equal(await store.acquire(join(s.lineDir, 'qw9999.edb'), 'any'), null, 'a snapshot of a different source file is not handed out')
    assert.equal(store.stats().reuse, 0, "'any' is not counted as a reuse")
  } finally { s.cleanup() }
})

test('single-flight: concurrent acquires on a changed -wal share one update', async () => {
  const s = stage()
  try {
    const store = s.store()
    ;(await store.acquire(s.src, 'fresh')).release()
    s.growWal(2048)
    const wal = s.copiesOf('qw0001.edb-wal')
    const leases = await Promise.all([store.acquire(s.src, 'fresh'), store.acquire(s.src, 'fresh'), store.acquire(s.src, 'fresh')])
    assert.equal(s.copiesOf('qw0001.edb-wal') - wal, 1, 'one wal copy for three callers')
    assert.deepEqual({ w: store.stats().walCopies, f: store.stats().fullCopies }, { w: 1, f: 1 })
    assert.ok(leases.every((l) => l.path === leases[0].path))
    for (const l of leases) l.release()
  } finally { s.cleanup() }
})

test('persistence: a new store over the same directory reuses the previous meta (zero copies after a restart); a broken meta, a truncated copy or another source file are not trusted; a leftover staging directory is removed', async () => {
  const s = stage()
  try {
    ;(await s.store().acquire(s.src, 'fresh')).release()
    const copies = s.totalCopies()
    mkdirSync(join(s.snapDir, 'next'), { recursive: true })
    writeFileSync(join(s.snapDir, 'next', 'm.edb'), 'half a copy')
    mkdirSync(join(s.snapDir, 'cur.old'), { recursive: true })
    writeFileSync(join(s.snapDir, 'cur.old', 'm.edb'), 'the previous snapshot set aside by a swap that never finished')
    const restarted = s.store()
    ;(await restarted.acquire(s.src, 'fresh')).release()
    assert.equal(s.totalCopies(), copies, 'restart: reuse, no copy')
    assert.equal(restarted.stats().reuse, 1)
    assert.equal(existsSync(join(s.snapDir, 'next')), false, 'leftover next/ removed')
    assert.equal(existsSync(join(s.snapDir, 'cur.old')), false, 'leftover cur.old removed even when nothing needs to be copied')
    // the first poll after a restart typically only needs the -wal
    s.growWal(512)
    const again = s.store()
    ;(await again.acquire(s.src, 'fresh')).release()
    assert.deepEqual({ w: again.stats().walCopies, f: again.stats().fullCopies }, { w: 1, f: 0 })

    writeFileSync(join(s.snapDir, 'meta.json'), '{not json')
    const broken = s.store()
    ;(await broken.acquire(s.src, 'fresh')).release()
    assert.equal(broken.stats().fullCopies, 1, 'broken meta: full copy')

    writeFileSync(join(s.snapDir, 'cur', 'm.edb'), Buffer.alloc(10)) // a copy cut short by a crash
    const truncated = s.store()
    ;(await truncated.acquire(s.src, 'fresh')).release()
    assert.equal(truncated.stats().fullCopies, 1, 'local size does not match the meta: full copy')

    const other = join(s.lineDir, 'qw0002.edb')
    writeFileSync(other, Buffer.alloc(1024, 1))
    const moved = s.store()
    ;(await moved.acquire(other, 'fresh')).release()
    assert.equal(moved.stats().fullCopies, 1, 'another source file: full copy')
  } finally { s.cleanup() }
})

test('a backend that never uses the store leaves nothing in the data directory (lazy initialisation)', async () => {
  const s = stage()
  try {
    s.store()
    assert.equal(existsSync(s.snapDir), false)
    await s.store().acquire(s.src, 'any')
    assert.equal(existsSync(s.snapDir), false)
  } finally { s.cleanup() }
})

// ───────────── store: leases, shouldYield ─────────────

test('leases: the swap waits for every lease; shouldYield() is true while an update waits, the old copy stays intact for the holder, and after release the new copy is in place', async () => {
  const s = stage()
  try {
    const store = s.store()
    const held = await store.acquire(s.src, 'fresh')
    assert.equal(held.shouldYield(), false, 'nothing is waiting')
    const oldWal = s.localWal()
    s.growWal(4096)
    let done = false
    const updating = store.acquire(s.src, 'fresh').then((lease) => { done = true; return lease })
    await until(() => held.shouldYield(), { message: 'shouldYield() to turn true' })
    await sleep(60)
    assert.equal(done, false, 'the swap is waiting for the lease')
    assert.deepEqual(s.localWal(), oldWal, 'the holder still sees the old -wal')
    // an "any" caller during the pending swap waits for it (and then gets the new copy)
    let anyDone = false
    const anyLease = store.acquire(s.src, 'any').then((lease) => { anyDone = true; return lease })
    await sleep(30)
    assert.equal(anyDone, false)
    held.release()
    held.release() // idempotent
    const fresh = await updating
    assert.ok(await anyLease)
    ;(await anyLease).release()
    assert.deepEqual(s.localWal(), readFileSync(`${s.src}-wal`))
    assert.equal(fresh.shouldYield(), false, 'nothing is waiting any more')
    fresh.release()
  } finally { s.cleanup() }
})

test('a lease that is never released fails the update (snapshot_busy) instead of hanging it; the copy stays intact and the next acquire works once the lease is gone', async () => {
  const s = stage()
  try {
    const store = s.store({ leaseWaitMs: 60 })
    const held = await store.acquire(s.src, 'fresh')
    const before = s.localWal()
    s.growWal(300)
    await assert.rejects(() => store.acquire(s.src, 'fresh'), /snapshot_busy/)
    assert.deepEqual(s.localWal(), before)
    assert.equal(existsSync(join(s.snapDir, 'next')), false)
    held.release()
    ;(await store.acquire(s.src, 'fresh')).release()
    assert.deepEqual(s.localWal(), readFileSync(`${s.src}-wal`))
  } finally { s.cleanup() }
})

test('a failing copy leaves the old snapshot and meta untouched and the error reaches the caller', async () => {
  const s = stage()
  try {
    const store = s.store()
    ;(await store.acquire(s.src, 'fresh')).release()
    const before = readFileSync(join(s.snapDir, 'cur', 'm.edb'))
    writeFileSync(s.src, Buffer.alloc(300 * 1024, 6))
    bump(s.src)
    const failing = { ...s.fs, copyFileAsync: async () => { throw new Error('EBUSY: copy failed') } }
    const broken = new LineSnapshotStore({ fs: failing, dir: s.snapDir })
    await assert.rejects(() => broken.acquire(s.src, 'fresh'), /EBUSY/)
    assert.deepEqual(readFileSync(join(s.snapDir, 'cur', 'm.edb')), before, 'the previous copy is still there')
    const anyLease = await broken.acquire(s.src, 'any')
    assert.ok(anyLease, "and 'any' can still read it")
    anyLease.release()
  } finally { s.cleanup() }
})

test('the process dying in the middle of a full swap leaves no meta behind: the next start does a full copy instead of trusting a half-replaced snapshot (and clears the leftover cur.old)', async () => {
  const s = stage()
  try {
    ;(await s.store().acquire(s.src, 'fresh')).release()
    writeFileSync(s.src, Buffer.alloc(300 * 1024, 6))
    bump(s.src)
    // "process death": the swap's rename fails and from then on nothing works any more (no rollback is possible)
    let dead = false
    const crashing = Object.fromEntries(Object.entries(s.fs).map(([name, fn]) => [name, (...args) => {
      if (dead) throw new Error('EPERM: the process is gone')
      if (name === 'renameFile' && args[0].endsWith('next')) { dead = true; throw new Error('EPERM: rename failed (crash)') }
      return fn(...args)
    }]))
    const crashed = new LineSnapshotStore({ fs: crashing, dir: s.snapDir })
    await assert.rejects(() => crashed.acquire(s.src, 'fresh'), /EPERM/)
    assert.equal(existsSync(join(s.snapDir, 'meta.json')), false, 'the old meta was deleted before the swap, so it cannot describe the half-replaced directory')
    assert.equal(existsSync(join(s.snapDir, 'cur.old')), true, 'the previous snapshot was set aside, not deleted')
    const copies = s.copiesOf('qw0001.edb')
    const restarted = s.store()
    ;(await restarted.acquire(s.src, 'fresh')).release()
    assert.equal(s.copiesOf('qw0001.edb'), copies + 1, 'the restart copied in full')
    assert.deepEqual(s.localEdb(), readFileSync(s.src))
    assert.equal(existsSync(join(s.snapDir, 'cur.old')), false, 'the leftover is cleared')
  } finally { s.cleanup() }
})

test('N2: a swap that fails (an external process holds a file, the rename is refused — the process is still alive) puts the last good snapshot back: cur and meta are restored, any still gets the old copy, and the next fresh acquire retries', async () => {
  for (const [label, refuse] of [
    ['next -> cur', (from, to) => from.endsWith('next') && to.endsWith('cur')],
    ['cur -> cur.old', (from, to) => from.endsWith('cur') && to.endsWith('cur.old')]
  ]) {
    const s = stage()
    try {
      ;(await s.store().acquire(s.src, 'fresh')).release()
      const oldEdb = s.localEdb()
      const oldWal = s.localWal()
      const oldMeta = readFileSync(join(s.snapDir, 'meta.json'), 'utf8')
      writeFileSync(s.src, Buffer.alloc(300 * 1024, 6))
      bump(s.src)
      let refusing = true
      const flaky = { ...s.fs, renameFile: (from, to) => { if (refusing && refuse(from, to)) throw new Error(`EPERM: rename ${label} refused`); s.fs.renameFile(from, to) } }
      const store = new LineSnapshotStore({ fs: flaky, dir: s.snapDir })
      await assert.rejects(() => store.acquire(s.src, 'fresh'), /EPERM/, label)
      assert.deepEqual(s.localEdb(), oldEdb, `${label}: the last good edb is back in place`)
      assert.deepEqual(s.localWal(), oldWal, `${label}: and its -wal`)
      assert.equal(readFileSync(join(s.snapDir, 'meta.json'), 'utf8'), oldMeta, `${label}: the meta that describes it is restored`)
      assert.equal(existsSync(join(s.snapDir, 'cur.old')), false, `${label}: nothing is left set aside`)
      assert.equal(existsSync(join(s.snapDir, 'next')), false)
      const anyLease = await store.acquire(s.src, 'any')
      assert.ok(anyLease, `${label}: any (avatars) still gets the old snapshot`)
      assert.equal(anyLease.path, join(s.snapDir, 'cur', 'm.edb'))
      anyLease.release()
      refusing = false
      const copies = s.copiesOf('qw0001.edb')
      ;(await store.acquire(s.src, 'fresh')).release()
      assert.equal(s.copiesOf('qw0001.edb'), copies + 1, `${label}: the next fresh acquire copies again`)
      assert.deepEqual(s.localEdb(), readFileSync(s.src))
    } finally { s.cleanup() }
  }
})

test('N1: a full-copy swap (the edb changed) also waits for every lease; the holder keeps the old copy until it lets go', async () => {
  const s = stage()
  try {
    const store = s.store()
    const held = await store.acquire(s.src, 'fresh')
    const oldEdb = s.localEdb()
    writeFileSync(s.src, Buffer.alloc(300 * 1024, 6))
    bump(s.src)
    let done = false
    const updating = store.acquire(s.src, 'fresh').then((lease) => { done = true; return lease })
    await until(() => held.shouldYield(), { message: 'shouldYield() to turn true' })
    await sleep(80)
    assert.equal(done, false, 'the full swap is waiting for the lease')
    assert.deepEqual(s.localEdb(), oldEdb, 'the holder still sees the old edb')
    assert.equal(existsSync(join(s.snapDir, 'cur.old')), false)
    held.release()
    const fresh = await updating
    assert.deepEqual(s.localEdb(), readFileSync(s.src))
    fresh.release()
  } finally { s.cleanup() }
})

test('N3: close() makes the store quiet — fresh is refused, any gives null, an update waiting for a lease fails at once and swaps nothing, a late invalidate() touches no file', async () => {
  const s = stage()
  try {
    const store = s.store()
    const held = await store.acquire(s.src, 'fresh')
    const oldWal = s.localWal()
    const oldMeta = readFileSync(join(s.snapDir, 'meta.json'), 'utf8')
    s.growWal(2048)
    const updating = store.acquire(s.src, 'fresh')
    const settled = updating.then(() => 'ok', (error) => error.message)
    await until(() => held.shouldYield(), { message: 'the update to be in flight' })
    await until(() => s.copiesOf('qw0001.edb-wal') >= 2, { message: 'the -wal copy to be done' })
    await sleep(40) // by now the update is parked in waitForLeases()
    await store.close()
    assert.match(await settled, /snapshot_closed/, 'the waiting update failed at once instead of after leaseWaitMs')
    assert.deepEqual(s.localWal(), oldWal, 'nothing was swapped in')
    assert.equal(readFileSync(join(s.snapDir, 'meta.json'), 'utf8'), oldMeta)
    assert.equal(existsSync(join(s.snapDir, 'next')), false)
    await assert.rejects(() => store.acquire(s.src, 'fresh'), /snapshot_closed/)
    assert.equal(await store.acquire(s.src, 'any'), null)
    store.invalidate()
    assert.equal(readFileSync(join(s.snapDir, 'meta.json'), 'utf8'), oldMeta, 'invalidate() after close does not delete the meta')
    assert.equal(store.stats().invalidations, 0)
    held.release()
    await store.close()
  } finally { s.cleanup() }
})

test('N3: an update that is mid-copy when close() is called cannot be waited for forever (close returns after waitMs) and, when its copy finishes, it does not swap or write a meta', async () => {
  const s = stage()
  try {
    ;(await s.store().acquire(s.src, 'fresh')).release()
    const oldWal = s.localWal()
    const oldMeta = readFileSync(join(s.snapDir, 'meta.json'), 'utf8')
    s.growWal(4096)
    let open
    const gate = new Promise((resolve) => { open = resolve })
    const slow = { ...s.fs, copyFileAsync: async (from, to) => { await s.fs.copyFileAsync(from, to); await gate } }
    const store = new LineSnapshotStore({ fs: slow, dir: s.snapDir, leaseWaitMs: 400 })
    const held = await store.acquire(s.src, 'any') // a reader is still on the old copy when the copy finishes
    const updating = store.acquire(s.src, 'fresh').then(() => 'swapped', (error) => error.message)
    await sleep(40)
    const t0 = Date.now()
    await store.close(50)
    assert.ok(Date.now() - t0 < 1000, 'close() gave up waiting for the copy')
    open()
    assert.match(await updating, /snapshot_closed/, 'the finished copy found the store closed (it did not wait for the reader that still holds a lease, nor fail with snapshot_busy)')
    held.release()
    assert.deepEqual(s.localWal(), oldWal, 'the old -wal is untouched')
    assert.equal(readFileSync(join(s.snapDir, 'meta.json'), 'utf8'), oldMeta, 'and so is the meta')
    assert.equal(existsSync(join(s.snapDir, 'next')), false, 'the staging directory was cleaned up')
    assert.deepEqual({ w: store.stats().walCopies, f: store.stats().fullCopies }, { w: 0, f: 0 })
  } finally { s.cleanup() }
})

test('N3: a closed store refuses even a zero-copy reuse and hands nothing to any', async () => {
  const s = stage()
  try {
    const store = s.store()
    ;(await store.acquire(s.src, 'fresh')).release()
    await store.close()
    await assert.rejects(() => store.acquire(s.src, 'fresh'), /snapshot_closed/)
    assert.equal(await store.acquire(s.src, 'any'), null)
    assert.equal(store.stats().reuse, 0)
  } finally { s.cleanup() }
})

test('N3: the meta says there is a -wal but the local one is gone (a half-cleaned directory): that is not a reuse — full copy', async () => {
  const s = stage()
  try {
    const store = s.store()
    ;(await store.acquire(s.src, 'fresh')).release()
    rmSync(join(s.snapDir, 'cur', 'm.edb-wal'))
    const lease = await store.acquire(s.src, 'fresh')
    lease.release()
    assert.equal(store.stats().fullCopies, 2)
    assert.deepEqual(s.localWal(), readFileSync(`${s.src}-wal`))
  } finally { s.cleanup() }
})

test('invalidate(): the next fresh acquire is a full copy; a wal-only update that was in flight does not swap in a result computed against the invalidated copy', async () => {
  const s = stage()
  try {
    const store = s.store()
    ;(await store.acquire(s.src, 'fresh')).release()
    store.invalidate()
    assert.equal(await store.acquire(s.src, 'any'), null, 'nothing valid to hand out')
    ;(await store.acquire(s.src, 'fresh')).release()
    assert.deepEqual({ f: store.stats().fullCopies, i: store.stats().invalidations }, { f: 2, i: 1 })

    s.growWal(2000)
    s.hooks.afterCopyAsync = (from) => { if (from.endsWith('-wal')) store.invalidate() }
    ;(await store.acquire(s.src, 'fresh')).release()
    s.hooks.afterCopyAsync = null
    assert.deepEqual({ w: store.stats().walCopies, f: store.stats().fullCopies }, { w: 0, f: 3 }, 'fell back to a full copy')
  } finally { s.cleanup() }
})

// ───────────── the copy is asynchronous ─────────────

test('harness: copying a 64 MB source through the real koffi `.async` CopyFileW keeps the event loop free (catastrophe ceiling: no gap of 1 s or more); a blocking copy is caught by the same monitor', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'line-snapshot-async-'))
  const monitor = loopMonitor()
  try {
    const lineDir = join(root, 'LINE', 'db')
    mkdirSync(lineDir, { recursive: true })
    const src = join(lineDir, 'qw0001.edb')
    const fd = openSync(src, 'w')
    const chunk = Buffer.alloc(1024 * 1024, 7)
    for (let i = 0; i < 64; i += 1) writeSync(fd, chunk)
    closeSync(fd)
    writeFileSync(`${src}-wal`, Buffer.concat([walHeader(1), Buffer.alloc(4 * 1024 * 1024, 2)]))

    const port = createWin32LineFsPort({ workspaceRoot: join(root, 'data', 'line-engine') })
    const store = new LineSnapshotStore({ fs: port, dir: join(root, 'data', 'line-engine', 'snapshot') })
    await sleep(30)
    monitor.reset()
    const lease = await store.acquire(src, 'fresh')
    await sleep(20)
    const gap = monitor.maxGapMs()
    lease.release()
    assert.equal(statSync(join(root, 'data', 'line-engine', 'snapshot', 'cur', 'm.edb')).size, 64 * 1024 * 1024)
    assert.equal(port.copyStats.async, 2, 'edb and -wal went through koffi .async')
    assert.equal(port.copyStats.syncFallback, 0)
    assert.equal(store.stats().syncCopies, 0)
    assert.ok(gap < 1_000, `the event loop stalled for ${gap.toFixed(0)} ms while 64 MB were copied (catastrophe ceiling 1,000 ms; a copy that blocks takes the whole copy time, the control below blocks for 400 ms)`)

    // the start-up sweep of orphaned temp copies (linedb-* / linekey-scan-*) must not touch the persistent snapshot directory
    const restarted = createWin32LineFsPort({ workspaceRoot: join(root, 'data', 'line-engine') })
    assert.equal(restarted.sweptOrphans, 0)
    assert.ok(existsSync(join(root, 'data', 'line-engine', 'snapshot', 'cur', 'm.edb')), 'the snapshot survives a port restart')

    // control: the same measurement over a port that copies synchronously (here: a 400 ms blocking copy) does see the stall
    const nodePort = createNodeLineFsPort()
    const blocking = Object.assign(Object.create(nodePort), { copyFileAsync: undefined, copyFile: (a, b) => { busyWait(400); nodePort.copyFile(a, b) } })
    const blockingStore = new LineSnapshotStore({ fs: blocking, dir: join(root, 'data', 'blocking-snapshot') })
    monitor.reset()
    await blockingStore.acquire(src, 'fresh')
    await sleep(20)
    // the control only has to show that a blocking copy opens a gap at all: that is the WALL gap (the 400 ms spin is wall-clock based, on a starved machine it burns less CPU than that)
    assert.ok(monitor.maxWallGapMs() >= 350, `the monitor is not vacuous: it saw a ${monitor.maxWallGapMs().toFixed(0)} ms wall gap (${monitor.maxGapMs().toFixed(0)} ms busy) for a blocking copy`)
    assert.ok(blockingStore.stats().syncCopies >= 1)

    // R2 fallback: with koffi `.async` switched off the port copies synchronously and counts it
    const noAsync = createWin32LineFsPort({ workspaceRoot: join(root, 'data2', 'line-engine'), asyncCopy: false })
    const fallbackStore = new LineSnapshotStore({ fs: noAsync, dir: join(root, 'data2', 'snapshot') })
    ;(await fallbackStore.acquire(src, 'fresh')).release()
    assert.deepEqual(noAsync.copyStats, { async: 0, syncFallback: 2 })
    assert.equal(statSync(join(root, 'data2', 'snapshot', 'cur', 'm.edb')).size, 64 * 1024 * 1024)
  } finally {
    monitor.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ───────────── access: self-healing, key renewal, 'any' ─────────────

function accessStage(s, { cacheKey = GOOD_KEY, scanner } = {}) {
  configureLineEnginePorts({ fs: s.fs, sqlite: s.sqlite, dbDir: s.lineDir })
  const store = s.store()
  const access = createLineAccess({ store })
  const cacheFile = join(s.dataDir, '.linekey')
  if (cacheKey) writeFileSync(cacheFile, cacheKey)
  return { store, access, keyOpts: { cacheFile, ...(scanner ? { scanner } : {}) } }
}
const scannerFinding = (key, stats = { started: 0 }) => ({
  stats,
  scan: async (_pid, onChunk) => { stats.started += 1; if (key) await onChunk(Buffer.from(`zz ${key} zz`, 'latin1')) }
})

test('access fresh: the key comes from .linekey without a validating copy, the snapshot open is the validation, and the key is then held in memory only', async () => {
  const s = stage()
  try {
    const { store, access, keyOpts } = accessStage(s)
    assert.equal(access.keyHeld(), false)
    const opened = await access.open({ dbPath: s.src, policy: 'fresh', keyOpts })
    assert.equal(access.keyHeld(), true)
    assert.equal(s.calls.copy.length, 0, 'no synchronous validating copy (the old decrypts() copied the whole DB)')
    assert.equal(s.totalCopies(), 2, 'one full copy: edb + -wal')
    assert.deepEqual(s.state.opens, [join(s.snapDir, 'cur', 'm.edb')], 'opened the persistent snapshot, not a temp copy')
    assert.equal(s.state.pragmas.some((p) => /wal_checkpoint/.test(p)), false, 'the persistent snapshot is never checkpointed (a read-write engine would fold the -wal into the local edb)')
    assert.equal(opened.source.edb[0], 256 * 1024)
    opened.cleanup()
    opened.cleanup()
    assert.equal(s.state.closed.length, 1, 'cleanup closes once and releases the lease (a later update is not blocked)')
    s.growWal(100)
    ;(await store.acquire(s.src, 'fresh')).release()
    // the held key is used: no further key resolution
    s.calls.textReads.length = 0
    ;(await access.open({ dbPath: s.src, policy: 'fresh', keyOpts })).cleanup()
    assert.equal(s.calls.textReads.length, 0, '.linekey is not read again while the key is held')
  } finally { s.cleanup() }
})

test('access fresh: a corrupted local copy heals itself — invalidate, one full copy, open again — and it happens once, not in a loop', async () => {
  const s = stage()
  try {
    const { store, access, keyOpts } = accessStage(s)
    ;(await access.open({ dbPath: s.src, policy: 'fresh', keyOpts })).cleanup()
    writeFileSync(join(s.snapDir, 'cur', 'm.edb'), Buffer.concat([Buffer.alloc(256 * 1024 - 7, 1), Buffer.from('CORRUPT')])) // same size as the meta expects, wrong content
    const fullBefore = store.stats().fullCopies
    const opened = await access.open({ dbPath: s.src, policy: 'fresh', keyOpts })
    opened.cleanup()
    assert.deepEqual({ f: store.stats().fullCopies - fullBefore, i: store.stats().invalidations }, { f: 1, i: 1 })
    assert.deepEqual(s.localEdb(), readFileSync(s.src), 'the local copy is the source again')
    assert.equal(access.keyHeld(), true, 'the key was not blamed')

    // a copy that is corrupt even right after a full copy is not retried forever: the key is renewed once, then the error surfaces
    const scanner = scannerFinding(null)
    const harsh = accessStage(s, { scanner: scanner.scan })
    s.state.goodKeys.clear()
    harsh.access.forgetKey()
    await assert.rejects(() => harsh.access.open({ dbPath: s.src, policy: 'fresh', keyOpts: harsh.keyOpts }), /decryption failed|key unavailable/i)
    assert.ok(scanner.stats.started <= 1, `at most one key renewal (scanner started ${scanner.stats.started})`)
  } finally { s.cleanup() }
})

test('access fresh: with no cached key the memory scan finds it and the only copy is the verifier single edb copy — no validating openDb copy of the whole database', async () => {
  const s = stage()
  try {
    const finder = scannerFinding(GOOD_KEY)
    const { access, keyOpts } = accessStage(s, { cacheKey: null, scanner: finder.scan })
    ;(await access.open({ dbPath: s.src, policy: 'fresh', keyOpts })).cleanup()
    assert.equal(finder.stats.started, 1)
    assert.equal(s.calls.copy.length, 1, 'only the BatchVerifier copy (edb) — the old final decrypts() added a full edb + -wal + -shm copy')
    assert.equal(s.totalCopies(), 3, 'plus the snapshot copy (edb + -wal)')
    assert.equal(readFileSync(join(s.dataDir, '.linekey'), 'utf8'), GOOD_KEY)
  } finally { s.cleanup() }
})

test('access any: a snapshot that cannot be opened gives null without blaming anything — the key stays held, the snapshot is not invalidated; the next fresh open heals it', async () => {
  const s = stage()
  try {
    const { store, access, keyOpts } = accessStage(s)
    ;(await access.open({ dbPath: s.src, policy: 'fresh', keyOpts })).cleanup()
    writeFileSync(join(s.snapDir, 'cur', 'm.edb'), Buffer.concat([Buffer.alloc(256 * 1024 - 7, 1), Buffer.from('CORRUPT')]))
    assert.equal(await access.open({ dbPath: s.src, policy: 'any', keyOpts }), null)
    assert.equal(access.keyHeld(), true, 'a failed read for an avatar does not throw the key away')
    assert.equal(store.stats().invalidations, 0)
    assert.equal(s.state.opens.length, 2)
    ;(await access.open({ dbPath: s.src, policy: 'fresh', keyOpts })).cleanup()
    assert.equal(store.stats().invalidations, 1, 'the import path is the one that heals it')
    const opened = await access.open({ dbPath: s.src, policy: 'any', keyOpts })
    assert.ok(opened)
    opened.cleanup()
  } finally { s.cleanup() }
})

test('access fresh: a stale key is renewed exactly once (re-resolved with validation, which finds the real key) and the new key is held; a key that cannot be found fails with the caller\'s own error', async () => {
  const s = stage()
  try {
    const finder = scannerFinding(GOOD_KEY)
    const { access, keyOpts } = accessStage(s, { cacheKey: STALE_KEY, scanner: finder.scan })
    const opened = await access.open({ dbPath: s.src, policy: 'fresh', keyOpts })
    opened.cleanup()
    assert.equal(finder.stats.started, 1, 'one memory scan')
    assert.equal(access.keyHeld(), true)
    assert.equal(readFileSync(join(s.dataDir, '.linekey'), 'utf8'), GOOD_KEY, 'the renewed key is cached for the next start')
    s.calls.textReads.length = 0
    ;(await access.open({ dbPath: s.src, policy: 'fresh', keyOpts })).cleanup()
    assert.equal(finder.stats.started, 1, 'no second scan')

    const s2 = stage()
    try {
      const nothing = scannerFinding(null)
      const stage2 = accessStage(s2, { cacheKey: STALE_KEY, scanner: nothing.scan })
      class NoKey extends Error {}
      await assert.rejects(() => stage2.access.open({ dbPath: s2.src, policy: 'fresh', keyOpts: stage2.keyOpts, keyMissing: () => new NoKey('mine') }), NoKey)
      assert.equal(nothing.stats.started, 1)
      assert.equal(stage2.access.keyHeld(), false)
    } finally { s2.cleanup() }
  } finally { s.cleanup() }
})

test("access any: without a held key it returns null and resolves nothing — no .linekey read, no scan, no copy; with a key it reads the existing copy and never copies", async () => {
  const s = stage()
  try {
    const scanner = scannerFinding(GOOD_KEY)
    const { store, access, keyOpts } = accessStage(s, { scanner: scanner.scan })
    assert.equal(await access.open({ dbPath: s.src, policy: 'any', keyOpts }), null)
    assert.equal(scanner.stats.started, 0)
    assert.equal(s.calls.textReads.filter((p) => p.endsWith('.linekey')).length, 0)
    assert.equal(s.totalCopies(), 0)

    ;(await access.open({ dbPath: s.src, policy: 'fresh', keyOpts })).cleanup()
    const copies = s.totalCopies()
    s.growWal(300) // moved on: 'any' still reads the existing copy
    const reads = s.calls.textReads.length
    const opened = await access.open({ dbPath: s.src, policy: 'any', keyOpts })
    assert.ok(opened)
    opened.cleanup()
    assert.equal(s.totalCopies(), copies)
    assert.equal(s.calls.textReads.length, reads, 'no key file read for any')
    assert.equal(store.stats().reuse, 0)

    // the opened handle carries shouldYield(): true while a fresh update waits for this lease
    const holder = await access.open({ dbPath: s.src, policy: 'any', keyOpts })
    assert.equal(holder.shouldYield(), false)
    const pending = store.acquire(s.src, 'fresh')
    await until(() => holder.shouldYield(), { message: 'shouldYield() on the opened handle' })
    holder.cleanup()
    ;(await pending).release()
    assert.equal(store.stats().walCopies, 1)

    access.forgetKey()
    assert.equal(await access.open({ dbPath: s.src, policy: 'any', keyOpts }), null, 'a forgotten key means null again, not a rescan')
    assert.equal(scanner.stats.started, 0)
  } finally { s.cleanup() }
})

test('access: a query that hits a corrupt page invalidates the snapshot, so the next fresh open copies again', async () => {
  const s = stage()
  try {
    const { store, access, keyOpts } = accessStage(s)
    const opened = await access.open({ dbPath: s.src, policy: 'fresh', keyOpts })
    // the fake engine decides corruption at open time; flip the engine so that a later query reports a malformed image
    s.state.goodKeys.clear()
    assert.throws(() => opened.con.prepare('SELECT count(*) FROM sqlite_master').get(), /not a database/)
    opened.cleanup()
    s.state.goodKeys.add(GOOD_KEY)
    assert.equal(store.stats().invalidations, 1)
    const full = store.stats().fullCopies
    ;(await access.open({ dbPath: s.src, policy: 'fresh', keyOpts })).cleanup()
    assert.equal(store.stats().fullCopies, full + 1)
  } finally { s.cleanup() }
})

// ───────────── production wiring through createPluginBackend ─────────────

const info = async (backend) => (await backend.call('backend', { path: 'backend.info', args: [] })).value
const lineStatus = async (backend) => (await backend.call('line', { path: 'line.status', args: [] })).value
const readTrace = (dataDir) => {
  const file = join(dataDir, 'logs', 'invoke-trace.log')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
}

test('wiring: createPluginBackend installs the access; info.lineSnapshot / keyHeld count it; with unchanged signatures 10 polls + 5 avatar reads + 1 reconcile fingerprint + 1 key re-validation copy nothing, avatars stay under 100 ms; a changed -wal is one wal-only copy; snap and bg events reach invoke-trace.log', { timeout: 60_000 }, async () => {
  const s = stage()
  writeFileSync(join(s.dataDir, 'settings.json'), JSON.stringify({ version: 1, reconcile: { enabled: true, scopeMonths: 0 } }))
  writeFileSync(join(s.dataDir, '.linekey'), GOOD_KEY)
  let backend
  try {
    backend = await createPluginBackend({
      pluginId: 'tuqdev.line-todo', version: 'test', dataDir: s.dataDir,
      linePorts: { fs: s.fs, sqlite: s.sqlite, dbDir: s.lineDir },
      watcher: { intervalSec: 3600, startupDelayMs: 20 },
      snapshot: { walOnly: true },
      trace: { eventMinMs: 0 }
    })
    await until(async () => (await lineStatus(backend)).state === 'running', { message: 'the first import' })
    await until(async () => (await info(backend)).lineSnapshot.reuse >= 1 || (await info(backend)).lineSnapshot.fullCopies >= 1, { message: 'the snapshot to exist' })
    await sleep(400) // the boot reconcile (it shares the startup delay) has run too
    const first = await info(backend)
    assert.equal(first.keyHeld, true)
    assert.equal(first.lineSnapshot.fullCopies, 1, 'one full copy served the poll and the reconcile')
    assert.equal(first.lineSnapshot.syncCopies, 0)
    assert.equal(s.calls.copy.length, 0, 'nothing in the production chain copies synchronously: no decrypts() validation copy, no openDb temp copy')

    // unchanged source from here on
    const keyOpts = { cacheFile: join(s.dataDir, '.linekey') }
    const engine = { stateFile: join(s.dataDir, '.watch_json_state'), keyOpts }
    const copies = s.totalCopies()
    const before = (await info(backend)).lineSnapshot
    for (let i = 0; i < 10; i += 1) await getLineImportBatch({ ...engine, cursor: { createdTime: 0, rowId: 0 }, source: 'line-backfill' }) // an explicit cursor bypasses the stat gate
    const avatarMs = []
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now()
      const answer = await backend.call('media', { path: 'media.avatar.prepareChats', args: [['chat-1', 'chat-2']] })
      avatarMs.push(performance.now() - t0)
      assert.equal(answer.ok, true)
    }
    await getSourceMonthlyFingerprint({ keyOpts })
    getLineEnginePorts().access.forgetKey()
    await getLineImportBatch({ ...engine, cursor: { createdTime: 0, rowId: 0 }, source: 'line-backfill' }) // the key is resolved again (cache, no validating copy) and validated by opening the snapshot
    const after = (await info(backend)).lineSnapshot
    assert.equal(s.totalCopies(), copies, 'zero copies of any kind')
    assert.equal(after.fullCopies + after.walCopies, before.fullCopies + before.walCopies)
    assert.equal(after.reuse - before.reuse, 12, '10 polls + 1 reconcile + 1 key re-validation went through acquire(fresh) as reuse')
    assert.ok(Math.max(...avatarMs) < 1_000, `avatar reads took ${avatarMs.map((n) => n.toFixed(1)).join(', ')} ms (catastrophe ceiling 1,000 ms; zero copies and zero opens are asserted above)`)
    assert.equal((await info(backend)).keyHeld, true)
    // avatars through the real dispatcher chain also answered for 'any' while the DB gave nothing: empty maps, not errors
    assert.deepEqual((await backend.call('media', { path: 'media.avatar.prepareChats', args: [['chat-1']] })).value, { paths: {}, names: {} })

    // a -wal that grew (same header): exactly one wal-only copy, through the same chain
    s.growWal(4096)
    await getLineImportBatch({ ...engine, cursor: { createdTime: 0, rowId: 0 }, source: 'line-backfill' })
    const grown = (await info(backend)).lineSnapshot
    assert.deepEqual({ w: grown.walCopies - after.walCopies, f: grown.fullCopies - after.fullCopies }, { w: 1, f: 0 })
    assert.equal(grown.lastKind, 'wal')
    assert.deepEqual(s.localWal(), readFileSync(`${s.src}-wal`))

    // the recent-unsent scan hooks into the end of a pipeline run
    await backend.call('pipeline', { path: 'pipeline.runOnce', args: [] })
    await until(() => readTrace(s.dataDir).some((e) => e.ev === 'bg' && e.p === 'unsent_scan'), { message: 'the unsent scan bg event' })

    const events = readTrace(s.dataDir)
    const snaps = events.filter((e) => e.ev === 'snap')
    assert.ok(snaps.some((e) => e.m === 'full' && e.bytes > 0), 'a snap/full event was written')
    assert.ok(snaps.some((e) => e.m === 'wal' && e.bytes > 0), 'a snap/wal event was written')
    const phases = new Set(events.filter((e) => e.ev === 'bg').map((e) => e.p))
    for (const p of ['poll', 'reconcile', 'quick_check', 'unsent_scan']) assert.ok(phases.has(p), `a bg event for ${p} (saw ${[...phases].join(',')})`)
    assert.ok(events.every((e) => e.ev !== 'snap' && e.ev !== 'bg' || (typeof e.ms === 'number' && typeof e.from === 'string')))
  } finally {
    await backend?.dispose()
    s.cleanup()
  }
})

test('wiring: snapshot:{enabled:false} keeps the old flow — no access installed, no lineSnapshot, a temp copy per open, and the cache key is validated by a copy as before', { timeout: 30_000 }, async () => {
  const s = stage()
  writeFileSync(join(s.dataDir, 'settings.json'), JSON.stringify({ version: 1, reconcile: { enabled: false, scopeMonths: 0 } }))
  writeFileSync(join(s.dataDir, '.linekey'), GOOD_KEY)
  let backend
  try {
    backend = await createPluginBackend({
      pluginId: 'tuqdev.line-todo', version: 'test', dataDir: s.dataDir,
      linePorts: { fs: s.fs, sqlite: s.sqlite, dbDir: s.lineDir },
      watcher: { intervalSec: 3600, startupDelayMs: 20 },
      snapshot: { enabled: false }
    })
    await until(async () => (await lineStatus(backend)).state === 'running', { message: 'the first import' })
    const state = await info(backend)
    assert.equal(state.lineSnapshot, null)
    assert.equal(state.keyHeld, false)
    assert.equal(getLineEnginePorts().access, undefined)
    assert.ok(s.calls.copy.length >= 2, 'the old flow copies synchronously (key validation + the poll)')
    assert.equal(existsSync(s.snapDir), false)
    assert.deepEqual(readdirSync(join(s.dataDir, 'line-engine')).filter((n) => n.startsWith('linedb-')), [], 'temp copies are cleaned up as before')
  } finally {
    await backend?.dispose()
    s.cleanup()
  }
})

test('standalone / no access installed: the key is resolved as before (synchronously, no scan guard), every open copies edb + -wal + -shm into a temp directory, nothing lands in a snapshot directory, and a missing key surfaces each caller own error type', { timeout: 30_000 }, async () => {
  const s = stage()
  try {
    // LINE is "not running": the old flow must not go looking at another process's memory
    configureLineEnginePorts({ fs: { ...s.fs, listProcessIds: () => [] }, sqlite: s.sqlite, dbDir: s.lineDir })
    const keyOpts = { cacheFile: join(s.dataDir, '.linekey') }
    const stateFile = join(s.dataDir, '.watch_json_state')
    const cursor = { createdTime: 0, rowId: 0 }
    await assert.rejects(() => getLineImportBatch({ stateFile, keyOpts, cursor }), (error) => error.name === 'KeyUnavailableError')
    await assert.rejects(() => resetNow({ stateFile, keyOpts }), (error) => error.name === 'KeyUnavailableError')
    await assert.rejects(() => getSourceMonthlyFingerprint({ keyOpts }), (error) => error.name === 'ReconcileKeyUnavailableError')
    assert.equal(s.totalCopies(), 0)

    writeFileSync(keyOpts.cacheFile, GOOD_KEY)
    await getLineImportBatch({ stateFile, keyOpts, cursor })
    assert.deepEqual(s.calls.copy.map((p) => p.slice(s.lineDir.length)), [
      '\\qw0001.edb', '\\qw0001.edb-wal', '\\qw0001.edb-shm', // the cache key validated by opening a full copy (decrypts)
      '\\qw0001.edb', '\\qw0001.edb-wal', '\\qw0001.edb-shm' // and the copy the poll actually reads
    ])
    assert.equal(s.calls.copyAsync.length, 0, 'the old flow never uses the asynchronous copy')
    await getSourceMonthlyFingerprint({ keyOpts })
    assert.equal(s.calls.copy.length, 12, 'every call copies again')
    assert.equal(existsSync(s.snapDir), false)
    assert.deepEqual(readdirSync(join(s.dataDir, 'line-engine')), [], 'temp copies are removed')
    assert.equal(getLineEnginePorts().access, undefined)
  } finally { s.cleanup() }
})

test('wiring: avatars use the old key policy when the snapshot is off (no env / .linekey) and never throw into the dispatcher when the new path has nothing to offer', { timeout: 30_000 }, async () => {
  const s = stage()
  try {
    const keyOpts = { cacheFile: join(s.dataDir, '.linekey') }
    writeFileSync(keyOpts.cacheFile, GOOD_KEY)
    // LINE is "not running" here: the old flow must not go looking at another process's memory
    configureLineEnginePorts({ fs: { ...s.fs, listProcessIds: () => [] }, sqlite: s.sqlite, dbDir: s.lineDir })
    // legacy ('any' without access): .linekey is skipped, so with no scanner and no env the key cannot be found: the error type is the engine's own
    await assert.rejects(() => getAvatarMetadata({ chatIds: ['c1'] }, { dbPath: s.src, keyOpts }), /key unavailable/i)
    // with access but nothing yet: an empty result
    const store = s.store()
    configureLineEnginePorts({ access: createLineAccess({ store }) })
    assert.deepEqual(await getAvatarMetadata({ chatIds: ['c1'] }, { dbPath: s.src, keyOpts }), { chats: {}, messages: {} })
    assert.equal(s.totalCopies(), 0)
  } finally { s.cleanup() }
})
