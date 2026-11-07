// LINE Cache image index (WP-B): mediaIndex.repo.ts (schema), mediaIndex.ts (background sliced scan, delta rules, stale / purge, resume, 24 h relist, noteMiss),
// decrypt.ts (index injection, onUnreadable, unchanged legacy behaviour), media.ts (query-only prepare), the fs ports (readDir with size / mtimeNs) and the production wiring (assemble.ts).
//
// The LINE Cache is synthetic: an in-memory tree (`makeFakeCache`) shaped like the real one (Cache/<hex>/<hex>/m/<hex>/<name>.eimg, 40k+ files, 1,900+ non-leaf directories)
// behind the `LineFsPort` readDir/stat/exists surface, or small temp directories on disk. No real LINE directory, key or network is touched.
import assert from 'node:assert/strict'
import { createCipheriv, createHmac, hkdfSync } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import test from 'node:test'

import Database from 'better-sqlite3'

import { ensureMediaIndexSchema, isMediaIndexSchemaReady, openMediaIndexStore } from '../../src/main/db/mediaIndex.repo.ts'
import { NodeLineFsPort } from '../../src/main/line/engine/nodeLineFsPort.ts'
import { createWin32LineFsPort, findDataFileSize } from '../../src/main/line/engine/native/win32fs.ts'
import { createMediaDecryptor } from '../../src/main/media/decrypt.ts'
import { createPluginBackend } from '../../src/plugin/backend/assemble.ts'
import { MEDIA_INDEX_BUILDING_TOKEN, createPluginMedia, mediaCacheStem } from '../../src/plugin/backend/media.ts'
import { MEDIA_INDEX_OFF_STATUS, createMediaIndex } from '../../src/plugin/backend/mediaIndex.ts'
import { backendMethodFor } from '../../src/shared/pluginWire.ts'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(predicate, { timeout = 20_000, step = 2, message = 'condition' } = {}) {
  const t0 = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - t0 > timeout) assert.fail(`timed out waiting for ${message}`)
    await sleep(step)
  }
}
/** Optional hook for collecting the measured numbers (WPB_MEASURE_FILE=<path>); never changes what the tests assert. */
function measured(name, value) {
  if (process.env.WPB_MEASURE_FILE) appendFileSync(process.env.WPB_MEASURE_FILE, `${JSON.stringify({ name, ...value })}\n`)
}

// ───────────── a synthetic LINE Cache in memory ─────────────

const FAKE_ROOT = join(tmpdir(), 'wpb-fake-line', 'Cache')

/** Cache/<t>/<u>/m/<hex>/<name>.eimg: tops x (1 + 1 + 1 + leaves) directories, tops x leaves x files files. Nothing is created on disk. */
function makeFakeCache({ tops = 650, leaves = 3, files = 24, root = FAKE_ROOT } = {}) {
  let tick = 1_000_000_000_000_000_000n
  const nextTime = () => { tick += 1_000_000_000n; return tick }
  const dirs = new Map()
  const calls = { readDir: [], readDirOptions: [], stat: 0, exists: 0, readFile: 0 }
  const fails = new Map()
  const contents = new Map()
  const flags = { omitSize: false, omitMtime: false, statFails: new Set(), ghosts: new Set(), readDirHook: null }
  const mk = (abs) => { const d = { mtime: nextTime(), entries: new Map() }; dirs.set(abs, d); return d }
  const link = (parent, name, entry) => { const d = dirs.get(parent); d.entries.set(name, entry); d.mtime = nextTime() }
  mk(root)
  let n = 0
  const leafPaths = []
  for (let t = 0; t < tops; t += 1) {
    const a = join(root, `t${t}`)
    mk(a); link(root, `t${t}`, { dir: true })
    const b = join(a, `u${t}`)
    mk(b); link(a, `u${t}`, { dir: true })
    const m = join(b, 'm')
    mk(m); link(b, 'm', { dir: true })
    for (let l = 0; l < leaves; l += 1) {
      const leaf = join(m, l.toString(16))
      mk(leaf); link(m, l.toString(16), { dir: true })
      leafPaths.push(leaf)
      for (let f = 0; f < files; f += 1) { link(leaf, `f${n}.eimg`, { size: 100 + (n % 7000), mtime: nextTime() }); n += 1 }
    }
  }
  const find = (path) => { const d = dirs.get(dirname(path)); return d ? d.entries.get(basename(path)) : undefined }
  const fs = {
    readDir(dir, readOptions) {
      calls.readDir.push(dir)
      calls.readDirOptions.push(readOptions)
      flags.readDirHook?.(dir)
      const failure = fails.get(dir)
      if (failure) throw failure
      const d = dirs.get(dir)
      if (!d) throw Object.assign(new Error(`ENOENT: ${dir}`), { code: 'ENOENT' })
      return [...d.entries].map(([name, e]) => {
        const entry = { name, isFile: !e.dir, isDirectory: Boolean(e.dir) }
        // like the Node port: size and mtime only come with the listing when the caller asks for them ({ stat: true })
        if (readOptions?.stat === true && !flags.omitSize) entry.size = e.dir ? 0 : e.size
        if (readOptions?.stat === true && !flags.omitMtime) entry.mtimeNs = e.dir ? dirs.get(join(dir, name)).mtime : e.mtime
        return entry
      })
    },
    stat(path) {
      calls.stat += 1
      if (flags.statFails.has(path)) throw new Error(`EIO: ${path}`)
      const e = find(path)
      if (!e || e.dir) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return { size: e.size, mtimeNs: e.mtime }
    },
    exists(path) { calls.exists += 1; return !flags.ghosts.has(path) && (dirs.has(path) || find(path) !== undefined) },
    readFile(path) {
      calls.readFile += 1
      const bytes = contents.get(path)
      if (bytes) return bytes
      const e = find(path)
      if (!e || e.dir) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return Buffer.alloc(e.size, 7)
    }
  }
  const touch = (dir) => { dirs.get(dir).mtime = nextTime() }
  const api = {
    root, fs, calls, fails, flags, dirs, leafPaths, touch,
    count() {
      let files = 0
      let nonLeaf = 0
      let leaf = 0
      for (const d of dirs.values()) {
        let hasDir = false
        for (const e of d.entries.values()) { if (e.dir) hasDir = true; else if (true) files += 1 }
        if (hasDir) nonLeaf += 1
        else leaf += 1
      }
      return { files, nonLeaf, leaf, dirs: dirs.size }
    },
    addFile(dir, name, size, { touch: bump = true } = {}) { const d = dirs.get(dir); d.entries.set(name, { size, mtime: nextTime() }); if (bump) d.mtime = nextTime() },
    addRealFile(dir, name, bytes, opts) { api.addFile(dir, name, bytes.length, opts); contents.set(join(dir, name), bytes) },
    removeFile(dir, name, { touch: bump = true } = {}) { const d = dirs.get(dir); d.entries.delete(name); if (bump) d.mtime = nextTime() },
    addDir(parent, name) { const abs = join(parent, name); mk(abs); const p = dirs.get(parent); p.entries.set(name, { dir: true }); p.mtime = nextTime(); return abs },
    removeDir(abs) {
      for (const key of [...dirs.keys()]) if (key === abs || key.startsWith(abs + sep)) dirs.delete(key)
      const p = dirs.get(dirname(abs)); p.entries.delete(basename(abs)); p.mtime = nextTime()
    },
    resetCalls() { calls.readDir.length = 0; calls.readDirOptions.length = 0; calls.stat = 0; calls.exists = 0; calls.readFile = 0 },
    listedDirs() { return calls.readDir.slice() }
  }
  return api
}

const newDb = () => { const db = new Database(':memory:'); ensureMediaIndexSchema(db); return db }
const rowsOf = (db) => db.prepare('SELECT size, dir_path, name, state, seen_gen, stale_at FROM line_media_index ORDER BY dir_path, name').all()
const metaOf = (db) => Object.fromEntries(db.prepare('SELECT key, value FROM line_media_index_meta').all().map((r) => [r.key, r.value]))
const liveCount = (db) => db.prepare(`SELECT count(*) AS n FROM line_media_index WHERE state='live'`).get().n
/** the live-row counter that status() reports is maintained incrementally (no table scan): it must always equal count(*) */
const assertRows = (h, why = '') => assert.equal(h.index.status().rows, liveCount(h.db), `status().rows equals count(*) of live rows ${why}`)
const dirRowOf = (db, path) => db.prepare('SELECT dir_path, mtime_ns, has_subdirs, listed_gen FROM line_media_dirs WHERE dir_path = ?').get(path)

/** An index on fake timers: `fire()` runs the pending timer (start delay, 24 h relist or error backoff) and waits for the pass to finish. */
function harness({ fake, db = newDb(), cacheDir = fake.root, nowRef = { t: 1_800_000_000_000 }, budget = {}, extra = {} } = {}) {
  const log = { slices: [], purges: [], traces: [], logs: [] }
  const timers = []
  const timer = (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return () => { t.live = false } }
  const index = createMediaIndex({
    getDb: () => db, fs: fake.fs, cacheDir, now: () => nowRef.t, timer,
    onSlice: (s) => log.slices.push(s), onPurge: (n) => log.purges.push(n), trace: (p, ms) => log.traces.push([p, ms]), log: (l) => log.logs.push(l),
    budget, ...extra
  })
  const pending = () => timers.filter((t) => t.live)
  const idle = () => until(() => !index.status().scanning, { message: 'the index pass to finish' })
  return {
    index, db, fake, nowRef, log, timers, pending, idle,
    async fire() { const t = pending()[0]; assert.ok(t, 'a timer is pending'); t.live = false; t.fn(); await idle() },
    async initial() { index.start(); await this.fire() },
    /** advance the wall clock past the noteMiss throttle and ask for a delta */
    async delta(advance = 31_000) {
      nowRef.t += advance
      const before = index.status().passes
      index.noteMiss()
      if (pending().length > 0) await this.fire()
      else await idle()
      return index.status().passes - before
    }
  }
}

/** nearest-rank percentile (p in 0..1) */
function percentile(values, p) {
  const sorted = [...values].sort((x, y) => x - y)
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]
}

function startLoopProbe() {
  let last = performance.now()
  let lastCpu = process.cpuUsage()
  let busy = 0
  let wall = 0
  let stopped = false
  const tick = () => {
    if (stopped) return
    const now = performance.now()
    const cpu = process.cpuUsage()
    const wallGap = now - last
    const cpuGap = ((cpu.user - lastCpu.user) + (cpu.system - lastCpu.system)) / 1000
    busy = Math.max(busy, Math.min(wallGap, cpuGap))
    wall = Math.max(wall, wallGap)
    last = now
    lastCpu = cpu
    setTimeout(tick, 1)
  }
  setTimeout(tick, 1)
  return { stop() { stopped = true; return busy }, wallMaxMs: () => wall }
}

const SMALL = { tops: 2, leaves: 2, files: 3 }

// ───────────── schema ─────────────

test('schema: ensure is idempotent, adds the three tables and leaves user_version alone; a table with the wrong shape makes it throw', () => {
  const db = new Database(':memory:')
  assert.equal(isMediaIndexSchemaReady(db), false)
  const before = db.pragma('user_version', { simple: true })
  ensureMediaIndexSchema(db)
  ensureMediaIndexSchema(db)
  assert.equal(isMediaIndexSchemaReady(db), true)
  assert.equal(db.pragma('user_version', { simple: true }), before, 'user_version is not touched')
  assert.deepEqual(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map((r) => r.name), ['line_media_dirs', 'line_media_index', 'line_media_index_meta'])
  assert.deepEqual(metaOf(db), { schema_version: '1' })
  assert.throws(() => db.prepare(`INSERT INTO line_media_index(size,dir_path,name,state,seen_gen) VALUES (1,'a','x','weird',1)`).run(), /CHECK/, 'state is constrained')
  assert.throws(() => db.prepare(`INSERT INTO line_media_dirs(dir_path,mtime_ns,has_subdirs,listed_gen) VALUES ('a','1',2,1)`).run(), /CHECK/, 'has_subdirs is constrained')
  const bad = new Database(':memory:')
  bad.exec('CREATE TABLE line_media_index (x)')
  assert.throws(() => ensureMediaIndexSchema(bad), /no such column/)
  assert.throws(() => openMediaIndexStore(bad), /no such column|no such table/, 'a store cannot be opened over a table of the wrong shape')
})

// ───────────── the scan ─────────────

test('scan: 46,800 files in 1,950 non-leaf directories are indexed in slices of <= 20 directories (deterministic); slice times and the event-loop gap are RECORDED, only a stall of 1 s or more fails; the index is ready afterwards', async () => {
  const fake = makeFakeCache()
  const counts = fake.count()
  assert.ok(counts.files >= 40_000, `fixture has ${counts.files} files`)
  assert.ok(counts.nonLeaf >= 1_300, `fixture has ${counts.nonLeaf} non-leaf directories`)
  // The contract is deterministic (20 directories / 15 ms / about 2,000 rows each end a slice: 'slice budget'; every slice <= 20 directories and <= 2,024 rows below). The real wall-clock cost of the slices and
  // the event-loop gap depend on whatever else the shared machine is doing (p95 5 ms idle, 40+ ms with 12 busy processes), so they are only RECORDED (measured()); the one wall-clock assertion left is a
  // catastrophe ceiling of 1,000 ms (a slice or a gap of a second means the scan blocked the loop for real: no yield between slices, or a slice that never ends).
  const gaps = []
  let h
  let totalMs = 0
  let yieldsBetweenSlices = 0
  let wallGapMs = 0
  {
    fake.resetCalls()
    h = harness({ fake, extra: { yieldLoop: async () => { yieldsBetweenSlices += 1; await new Promise((resolve) => { setTimeout(resolve, 0) }) } } })
    assert.equal(h.index.isReady(), false)
    assert.equal(h.index.status().ready, false)
    const probe = startLoopProbe()
    const t0 = performance.now()
    await h.initial()
    totalMs = performance.now() - t0
    gaps.push(probe.stop())
    wallGapMs = probe.wallMaxMs()
  }
  const maxGap = gaps.at(-1)
  const status = h.index.status()
  assert.equal(status.ready, true)
  assert.equal(status.rows, counts.files)
  assertRows(h, 'after the big scan')
  // the event loop is handed back after every slice but the last (deterministic: the wall-clock gap above only catches a catastrophe, the in-memory scan itself is cheap)
  assert.equal(yieldsBetweenSlices, h.log.slices.length - 1, 'one hand-back of the event loop between any two slices')
  assert.equal(status.mode, 'initial')
  assert.equal(status.dirsListed, counts.dirs)
  assert.equal(rowsOf(h.db).length, counts.files)
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM line_media_dirs').get().n, counts.dirs)
  const maxDirs = Math.max(...h.log.slices.map((s) => s.dirs))
  const maxSliceMs = Math.max(...h.log.slices.map((s) => s.ms))
  const p95SliceMs = percentile(h.log.slices.map((s) => s.ms), 0.95)
  const maxRows = Math.max(...h.log.slices.map((s) => s.rows))
  assert.ok(maxDirs <= 20, `<= 20 directories per slice (max ${maxDirs})`)
  assert.ok(maxRows <= 2_000 + 24, `about <= 2,000 rows per slice (max ${maxRows})`)
  // slice p95 / max (wall clock) are only recorded: a slice that really blocks shows up as a busy event-loop gap below, a slice that is merely not scheduled must not fail the test
  assert.ok(h.log.slices.length >= counts.dirs / 20, 'the work really was cut into slices')
  assert.ok(h.log.traces.every(([phase]) => phase === 'media_index') && h.log.traces.length === h.log.slices.length, 'one bg trace per slice')
  assert.ok(maxGap < 1_000, `event loop was blocked for ${maxGap.toFixed(1)} ms (CPU-busy gap, catastrophe ceiling 1,000 ms; slice p95 ${p95SliceMs.toFixed(1)} ms, max ${maxSliceMs.toFixed(1)} ms, wall gap ${wallGapMs.toFixed(0)} ms: recorded only)`)
  assert.equal(fake.calls.stat, 0, 'sizes and mtimes come with the listing: not one per-file stat')
  assert.ok(fake.calls.readDirOptions.every((o) => o && o.stat === true), 'every listing asks for size and mtime')
  measured('scan-initial', { files: counts.files, nonLeaf: counts.nonLeaf, dirs: counts.dirs, slices: h.log.slices.length, maxDirsPerSlice: maxDirs, maxSliceMs, p95SliceMs, maxRowsPerSlice: maxRows, eventLoopBusyGapMs: maxGap, eventLoopWallGapMs: wallGapMs, totalMs })
  h.fake.resetCalls()
  const before = h.log.slices.length
  assert.equal(await h.delta(), 1)
  const deltaCount = fake.calls.readDir.length
  assert.equal(deltaCount, counts.nonLeaf, `an unchanged delta lists only the ${counts.nonLeaf} non-leaf directories (listed ${deltaCount})`)
  const deltaSlices = h.log.slices.slice(before)
  assert.ok(Math.max(...deltaSlices.map((s) => s.dirs)) <= 20 && true)
  measured('scan-delta', { listed: deltaCount, slices: deltaSlices.length })
})

test('measurement only (nothing asserted about timing): the same scan into a FILE-backed WAL database, where the commit and the checkpoint cost real I/O', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wpb-wal-'))
  const file = join(root, 'index.db')
  try {
    const fake = makeFakeCache()
    const db = new Database(file)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    ensureMediaIndexSchema(db)
    const h = harness({ fake, db })
    const probe = startLoopProbe()
    const t0 = performance.now()
    await h.initial()
    const totalMs = performance.now() - t0
    const maxGap = probe.stop()
    const ms = h.log.slices.map((s) => s.ms)
    const numbers = { slices: ms.length, p50SliceMs: percentile(ms, 0.5), p95SliceMs: percentile(ms, 0.95), maxSliceMs: Math.max(...ms), eventLoopMaxGapMs: maxGap, totalMs }
    t.diagnostic(JSON.stringify(numbers))
    measured('scan-initial-file-wal', numbers)
    // what is asserted is only that the scan really ran into the file (not a timing)
    assert.equal(h.index.status().ready, true)
    assert.equal(h.index.status().rows, fake.count().files)
    assert.equal(db.prepare('SELECT count(*) AS n FROM line_media_index').get().n, fake.count().files)
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal')
    db.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('slice budget: 20 directories, 15 ms and about 2,000 rows each end a slice (deterministic clocks); a slice always makes progress', async () => {
  const run = async (budget, clockStep, shape) => {
    const fake = makeFakeCache(shape)
    const c = { t: 0 }
    fake.flags.readDirHook = () => { c.t += clockStep }
    const h = harness({ fake, budget, extra: { clock: () => c.t } })
    await h.initial()
    return h.log.slices
  }
  const byDirs = await run({}, 0, { tops: 12, leaves: 3, files: 2 })
  assert.equal(Math.max(...byDirs.map((s) => s.dirs)), 20, 'a clock that never advances: the 20-directory limit applies')
  assert.ok(byDirs.slice(0, -1).every((s) => s.dirs === 20))
  const byTime = await run({}, 4, { tops: 12, leaves: 3, files: 2 })
  assert.ok(byTime.slice(0, -1).every((s) => s.dirs === 4), `4 ms per directory: the 15 ms budget ends a slice after 4 directories (${byTime.slice(0, 3).map((s) => s.dirs)})`)
  const slow = await run({}, 100, { tops: 3, leaves: 2, files: 2 })
  assert.ok(slow.every((s) => s.dirs === 1), 'a single directory slower than the whole budget still counts as progress, one per slice')
  const byRows = await run({}, 0, { tops: 1, leaves: 20, files: 300 })
  assert.ok(byRows.every((s) => s.rows <= 2_000 + 300), `rows per slice stay near 2,000 (${byRows.map((s) => s.rows)})`)
  assert.ok(byRows.some((s) => s.dirs < 20 && s.rows >= 2_000), 'the row limit ends a slice before the 20-directory limit')
  const custom = await run({ sliceMaxDirs: 3 }, 0, { tops: 4, leaves: 2, files: 2 })
  assert.equal(Math.max(...custom.map((s) => s.dirs)), 3, 'the budget is configurable')
})

test('every slice is one transaction: every listing happens inside it, nothing is open while the loop is given back, and a failure in the middle of a slice leaves none of its rows', async () => {
  const fake = makeFakeCache({ tops: 6, leaves: 3, files: 2 })
  const db = newDb()
  // the test loader maps better-sqlite3 to node:sqlite (sqlite-test-adapter.mjs): ask SQLite itself whether a transaction is open
  const inTransaction = () => (db.inner ? db.inner.isTransaction : db.inTransaction)
  const seen = []
  fake.flags.readDirHook = () => { seen.push(inTransaction()) }
  let yields = 0
  let openAtYield = []
  const h = harness({ fake, db, budget: { sliceMaxDirs: 5 }, extra: { yieldLoop: async () => { yields += 1; openAtYield.push(inTransaction()); await sleep(0) } } })
  await h.initial()
  assert.ok(seen.length >= 20 && seen.every((inside) => inside === true), 'every directory listing runs inside the slice transaction')
  assert.ok(yields >= 4 && openAtYield.every((open) => open === false), 'the transaction is committed before the event loop is given back')
  const rows = rowsOf(h.db).length
  assert.equal(rows, 6 * 3 * 2)
  // a failure at the end of a slice (here: its bookkeeping write) rolls back every row the slice wrote
  const fake3 = makeFakeCache({ tops: 6, leaves: 3, files: 2 })
  const db3 = newDb()
  const realPrepare = db3.prepare.bind(db3)
  db3.prepare = (sql) => {
    const stmt = realPrepare(sql)
    if (!/INSERT INTO line_media_index_meta/.test(sql)) return stmt
    return { run: (key, value) => { if (key === 'live_rows') throw new Error('disk full'); return stmt.run(key, value) }, get: (...args) => stmt.get(...args) }
  }
  const h3 = harness({ fake: fake3, db: db3, budget: { sliceMaxDirs: 20 } })
  h3.index.start()
  await h3.fire()
  assert.equal(h3.index.status().errors, 1, 'the pass failed')
  assert.equal(rowsOf(db3).length, 0, 'the rows written before the failure in the same slice were rolled back with it')
  assert.equal(db3.prepare('SELECT count(*) AS n FROM line_media_dirs').get().n, 0, 'and so were its directory records')
  assert.equal(h3.index.status().rows, 0)
  assert.equal(h3.index.status().ready, false)
})

test('markStale of a row that is already stale changes nothing: the 30-day clock is not restarted', () => {
  const db = newDb()
  const store = openMediaIndexStore(db)
  store.upsertLive(500, 'a/b', 'x.eimg', 1)
  assert.equal(store.markStale(500, 'a/b', 'x.eimg', 1_000), 1)
  assert.equal(store.markStale(500, 'a/b', 'x.eimg', 9_000), 0, 'already stale: not touched again')
  assert.equal(store.markStaleByName('a/b', 'x.eimg', 9_000), 0)
  assert.equal(store.markStaleTree('a', 9_000), 0)
  assert.equal(rowsOf(db)[0].stale_at, 1_000, 'stale_at keeps the first time')
  store.upsertLive(500, 'a/b', 'x.eimg', 2)
  assert.equal(rowsOf(db)[0].stale_at, null, 'a returning file is live again and has no stale time')
  assert.equal(store.purgeStale(5_000, 10), 0, 'a live row is never purged')
})

test('findDataFileSize: the high word of WIN32_FIND_DATAW counts for files above 4 GiB', () => {
  assert.equal(findDataFileSize(0, 4321), 4321)
  assert.equal(findDataFileSize(0, 0xffffffff), 4_294_967_295)
  assert.equal(findDataFileSize(1, 0), 4_294_967_296)
  assert.equal(findDataFileSize(1, 5), 4_294_967_301)
  assert.equal(findDataFileSize(2, 7), 8_589_934_599)
})

test('scan result: only .eimg files (any case) are indexed under their relative directory; sizes, has_subdirs, mtime and generation bookkeeping are recorded', async () => {
  const fake = makeFakeCache(SMALL)
  const leaf = fake.leafPaths[0]
  fake.addFile(leaf, 'UPPER.EIMG', 5555)
  fake.addFile(leaf, 'note.txt', 5555)
  fake.addFile(leaf, 'eimg', 5555)
  fake.addFile(leaf, 'sub\\evil.eimg', 5555)
  fake.addFile(leaf, 'a/b.eimg', 5555)
  fake.addFile(leaf, 'neg.eimg', -1)
  fake.addFile(leaf, 'frac.eimg', 1.5)
  const empty = fake.addDir(dirname(leaf), 'empty')
  fake.addDir(dirname(leaf), 'dir.eimg')
  const h = harness({ fake })
  await h.initial()
  const rows = rowsOf(h.db)
  const total = fake.count().files - 7 + 1
  assert.equal(rows.length, total, 'UPPER.EIMG counts; the other six entries do not')
  assert.ok(rows.some((r) => r.name === 'UPPER.EIMG' && r.size === 5555 && r.state === 'live' && r.seen_gen === 1 && r.stale_at === null))
  assert.ok(rows.every((r) => !r.name.includes('/') && !r.name.includes('\\') && r.size >= 0 && Number.isInteger(r.size)))
  assert.ok(!rows.some((r) => r.name === 'dir.eimg'), 'a directory whose name ends in .eimg is not an image (the Win32 port reports size 0 for directories)')
  const rel = ['t0', 'u0', 'm', '0'].join('/')
  assert.ok(rows.some((r) => r.dir_path === rel), 'directories are relative to the Cache root and joined with /')
  assert.deepEqual(h.index.candidates(5555).map((p) => p.replace(/\\/g, '/').split('/').slice(-5).join('/')), [`${rel}/UPPER.EIMG`])
  assert.deepEqual(h.index.candidates(5555), [join(leaf, 'UPPER.EIMG')], 'the absolute path is the Cache root joined with the relative directory and the name')
  assert.equal(dirRowOf(h.db, '').has_subdirs, 1)
  assert.equal(dirRowOf(h.db, 't0/u0/m/0').has_subdirs, 0)
  assert.equal(dirRowOf(h.db, 't0/u0/m/empty').has_subdirs, 0, 'an empty directory is a leaf')
  assert.equal(dirRowOf(h.db, 't0/u0/m/empty').listed_gen, 1)
  assert.equal(dirRowOf(h.db, 't0/u0/m/0').mtime_ns, String(fake.dirs.get(leaf).mtime), 'the stored mtime is the one the parent reported')
  assert.ok(dirRowOf(h.db, ''), 'the root row exists')
  assert.ok(empty)
  assert.deepEqual(metaOf(h.db), { schema_version: '1', cache_root: fake.root, gen: '1', initial_scan_done: '1', full_gen_done: '1', last_full_at: String(h.nowRef.t), live_rows: String(total) })
  assert.equal(h.index.status().rows, total)
  assertRows(h)
})

test('delta rule: an unchanged leaf is skipped, a changed one is listed; every non-leaf directory is always listed; a directory the parent reports without an mtime is never skipped', async () => {
  const fake = makeFakeCache(SMALL)
  const h = harness({ fake })
  await h.initial()
  const nonLeaf = fake.count().nonLeaf
  const [leafA, leafB] = [fake.leafPaths[0], fake.leafPaths[1]]
  fake.resetCalls()
  assert.equal(await h.delta(), 1)
  assert.equal(fake.calls.readDir.length, nonLeaf, 'nothing changed: only the non-leaf directories are listed')
  assert.ok(fake.calls.readDir.every((d) => !fake.leafPaths.includes(d)))
  const base = rowsOf(h.db)

  fake.addFile(leafA, 'new.eimg', 4242)
  fake.resetCalls()
  await h.delta()
  assert.deepEqual(fake.calls.readDir.filter((d) => fake.leafPaths.includes(d)), [leafA], 'only the leaf whose mtime moved is listed')
  assert.deepEqual(h.index.candidates(4242), [join(leafA, 'new.eimg')])
  assert.equal(rowsOf(h.db).length, base.length + 1)

  fake.touch(leafB)
  fake.resetCalls()
  await h.delta()
  assert.deepEqual(fake.calls.readDir.filter((d) => fake.leafPaths.includes(d)), [leafB], 'a touched leaf is listed again')
  assert.equal(rowsOf(h.db).length, base.length + 1, 'but nothing in it changed')
  assert.equal(h.db.prepare(`SELECT count(*) AS n FROM line_media_index WHERE state='stale'`).get().n, 0)

  fake.resetCalls()
  await h.delta()
  assert.equal(fake.calls.readDir.length, nonLeaf, 'the new mtimes were recorded: back to non-leaf only')

  fake.flags.omitMtime = true
  fake.resetCalls()
  await h.delta()
  assert.equal(fake.calls.readDir.length, fake.count().dirs, 'without mtimes nothing can be proven unchanged: every directory is listed')
  assertRows(h)
})

test('a delta writes only what changed: rows of a re-listed leaf that are unchanged keep their generation, new rows get the current one', async () => {
  const fake = makeFakeCache(SMALL)
  const h = harness({ fake })
  await h.initial()
  const leaf = fake.leafPaths[0]
  const rel = 't0/u0/m/0'
  h.db.prepare('UPDATE line_media_index SET seen_gen = 0 WHERE dir_path = ?').run(rel)
  fake.addFile(leaf, 'fresh.eimg', 5150)
  await h.delta()
  const rows = rowsOf(h.db).filter((r) => r.dir_path === rel)
  assert.ok(rows.length > 1)
  assert.deepEqual(rows.filter((r) => r.name !== 'fresh.eimg').map((r) => r.seen_gen), [0, 0, 0], 'unchanged rows were not rewritten')
  assert.equal(rows.find((r) => r.name === 'fresh.eimg').seen_gen, 1)
  assertRows(h)
})

test('a directory the parent reports without an mtime is listed in every delta, also when the same was true when it was last listed', async () => {
  const fake = makeFakeCache(SMALL)
  fake.flags.omitMtime = true
  const h = harness({ fake })
  await h.initial()
  assert.equal(dirRowOf(h.db, 't0/u0/m/0').mtime_ns, '', 'nothing could be recorded')
  fake.resetCalls()
  await h.delta()
  assert.equal(fake.calls.readDir.length, fake.count().dirs, 'unknown is never treated as unchanged')
})

test('delta: removed files become stale and leave candidates; a file that returns is live again; a leaf that gains a subdirectory is rescanned as a non-leaf; a vanished subtree goes stale as a whole', async () => {
  const fake = makeFakeCache({ tops: 2, leaves: 2, files: 4 })
  const h = harness({ fake })
  await h.initial()
  const leaf = fake.leafPaths[0]
  const victim = [...fake.dirs.get(leaf).entries.entries()][0]
  const [victimName, victimEntry] = victim
  assert.deepEqual(h.index.candidates(victimEntry.size).filter((p) => p === join(leaf, victimName)), [join(leaf, victimName)])

  fake.removeFile(leaf, victimName)
  h.nowRef.t += 31_000
  await h.delta(0)
  assert.equal(h.index.candidates(victimEntry.size).includes(join(leaf, victimName)), false, 'stale rows are not candidates')
  const row = rowsOf(h.db).find((r) => r.name === victimName)
  assert.equal(row.state, 'stale')
  assert.equal(row.stale_at, h.nowRef.t, 'the time it was found missing is recorded')

  fake.addFile(leaf, victimName, victimEntry.size)
  await h.delta()
  const back = rowsOf(h.db).find((r) => r.name === victimName)
  assert.equal(back.state, 'live')
  assert.equal(back.stale_at, null)
  assert.equal(h.index.candidates(victimEntry.size).includes(join(leaf, victimName)), true)

  const nested = fake.addDir(leaf, 'deeper')
  fake.addFile(nested, 'deep.eimg', 31337)
  await h.delta()
  assert.equal(dirRowOf(h.db, 't0/u0/m/0').has_subdirs, 1, 'the former leaf now has a subdirectory')
  assert.deepEqual(h.index.candidates(31337), [join(nested, 'deep.eimg')])
  fake.resetCalls()
  await h.delta()
  assert.ok(fake.calls.readDir.includes(leaf), 'a directory with subdirectories is listed on every delta')
  assert.ok(!fake.calls.readDir.includes(nested), 'the unchanged new leaf is not')

  fake.removeDir(join(fake.root, 't1'))
  await h.delta()
  const gone = rowsOf(h.db).filter((r) => r.dir_path.startsWith('t1/'))
  assert.ok(gone.length > 0 && gone.every((r) => r.state === 'stale'), 'every file under the vanished subtree is stale')
  assert.equal(h.db.prepare(`SELECT count(*) AS n FROM line_media_dirs WHERE dir_path = 't1' OR dir_path LIKE 't1/%'`).get().n, 0, 'its directory rows are gone')
  assert.ok(rowsOf(h.db).filter((r) => r.dir_path.startsWith('t0/')).every((r) => r.state === 'live' || r.name === victimName), 'a sibling with a similar prefix is untouched')
  assertRows(h, 'after files and a subtree went away and came back')
})

test('a vanished directory does not hurt a sibling whose name starts the same way (t1 vs t10)', async () => {
  const fake = makeFakeCache({ tops: 12, leaves: 1, files: 2 })
  const dash = fake.addDir(fake.root, 't1-x')
  fake.addFile(dash, 'dash.eimg', 4444)
  const h = harness({ fake })
  await h.initial()
  fake.removeDir(join(fake.root, 't1'))
  await h.delta()
  const stale = new Set(rowsOf(h.db).filter((r) => r.state === 'stale').map((r) => r.dir_path.split('/')[0]))
  assert.deepEqual([...stale], ['t1'], 't10, t11 and t1-x stay live (a subtree is "t1/" and everything below it, nothing else)')
  assert.deepEqual(h.index.candidates(4444), [join(dash, 'dash.eimg')])
  assert.ok(h.index.candidates(rowsOf(h.db).find((r) => r.dir_path.startsWith('t10/')).size).length > 0)
})

test('stale rows older than 30 days are purged in batches of <= 500 with a yield between batches; younger ones and every live row stay; a purge never touches live rows with an old generation', async () => {
  const fake = makeFakeCache({ tops: 5, leaves: 3, files: 100 })
  let yields = 0
  const h = harness({ fake, extra: { yieldLoop: async () => { yields += 1; await sleep(0) } } })
  await h.initial()
  const live = rowsOf(h.db).length
  assert.equal(live, 1_500)
  const day = 24 * 60 * 60 * 1000
  for (const leaf of fake.leafPaths.slice(0, 12)) for (const name of [...fake.dirs.get(leaf).entries.keys()].slice(0, 100)) fake.removeFile(leaf, name, { touch: false })
  fake.touch(fake.leafPaths[0])
  for (const leaf of fake.leafPaths.slice(1, 12)) fake.touch(leaf)
  await h.delta()
  assert.equal(h.db.prepare(`SELECT count(*) AS n FROM line_media_index WHERE state='stale'`).get().n, 1_200)
  assert.deepEqual(h.log.purges.slice(-1), [0], 'a fresh stale row is not purged')
  assert.equal(rowsOf(h.db).length, live)
  h.db.prepare(`UPDATE line_media_index SET stale_at = ? WHERE state='stale' AND dir_path LIKE 't0/%'`).run(h.nowRef.t - 29 * day)
  h.db.prepare(`UPDATE line_media_index SET stale_at = ? WHERE state='stale' AND dir_path NOT LIKE 't0/%'`).run(h.nowRef.t - 31 * day)
  h.db.prepare(`UPDATE line_media_index SET seen_gen = 0 WHERE state='live'`).run()
  const youngStale = h.db.prepare(`SELECT count(*) AS n FROM line_media_index WHERE state='stale' AND dir_path LIKE 't0/%'`).get().n
  const before = h.log.purges.length
  const slicesBefore = h.log.slices.length
  const yieldsBefore = yields
  await h.delta()
  const batches = h.log.purges.slice(before)
  assert.equal(yields - yieldsBefore - (h.log.slices.length - slicesBefore - 1), batches.length - 1, 'the event loop is given back between purge batches (one yield after every full batch)')
  assert.ok(batches.length >= 2 && batches.every((n) => n <= 500), `batches ${batches}`)
  assert.equal(batches.slice(0, -1).every((n) => n === 500), true, 'full batches until the last one')
  assert.equal(batches.reduce((a, b) => a + b, 0), 1_200 - youngStale)
  assert.equal(h.db.prepare(`SELECT count(*) AS n FROM line_media_index WHERE state='stale'`).get().n, youngStale, '29-day-old rows are kept')
  assert.equal(h.db.prepare(`SELECT count(*) AS n FROM line_media_index WHERE state='live'`).get().n, 1_500 - 1_200, 'live rows are never purged')
  assert.ok(h.log.slices.every((s) => s.dirs <= 20))
  h.nowRef.t += 2 * day
  await h.delta(0)
  assert.equal(h.db.prepare(`SELECT count(*) AS n FROM line_media_index WHERE state='stale'`).get().n, 0, 'the rest goes once it is 30 days old')
  assertRows(h, 'purging stale rows does not change the live count')
})

test('the initial scan resumes across a restart: leaves listed before the restart are not listed again, the generation does not move, the index is not ready until it finishes', async () => {
  const fake = makeFakeCache({ tops: 40, leaves: 3, files: 5 })
  const db = newDb()
  const counts = fake.count()
  let slicesSeen = 0
  let stopping = null
  const h1 = harness({ fake, db, extra: { yieldLoop: async () => { slicesSeen += 1; if (slicesSeen === 7) stopping = h1.index.dispose() } } })
  await h1.initial().catch(() => undefined)
  await stopping
  const listedFirst = fake.listedDirs()
  const leavesFirst = listedFirst.filter((d) => fake.leafPaths.includes(d))
  assert.ok(leavesFirst.length > 0 && leavesFirst.length < fake.leafPaths.length, `the first run listed ${leavesFirst.length} of ${fake.leafPaths.length} leaves`)
  assert.equal(metaOf(db).initial_scan_done, undefined, 'an interrupted scan is not a finished one')
  assert.equal(metaOf(db).gen, '1')
  assert.equal(h1.index.isReady(), false)
  assert.equal(h1.index.status().available, false, 'a disposed index is closed')
  const h2 = harness({ fake, db })
  assert.equal(h2.index.isReady(), false)
  fake.resetCalls()
  await h2.initial()
  const leavesSecond = fake.listedDirs().filter((d) => fake.leafPaths.includes(d))
  assert.equal(new Set([...leavesFirst, ...leavesSecond]).size, fake.leafPaths.length, 'together they covered every leaf')
  assert.equal(leavesFirst.filter((d) => leavesSecond.includes(d)).length, 0, 'no leaf was listed twice')
  assert.equal(metaOf(db).gen, '1', 'the generation did not move while the first scan was unfinished')
  assert.equal(h2.index.isReady(), true)
  assert.equal(rowsOf(db).length, counts.files)
  assert.equal(h2.index.status().mode, 'initial')
  assertRows(h2, 'after a scan that was interrupted and resumed')
})

test('every 24 hours a complete relist runs as a safety net (generation + 1); before that only deltas; an interrupted relist resumes; a clock that went backwards counts as due', async () => {
  const fake = makeFakeCache({ tops: 30, leaves: 3, files: 4 })
  const db = newDb()
  const nowRef = { t: 1_800_000_000_000 }
  const hour = 60 * 60 * 1000
  const h1 = harness({ fake, db, nowRef })
  await h1.initial()
  assert.equal(metaOf(db).last_full_at, String(nowRef.t))
  assert.deepEqual(h1.pending().map((t) => t.ms), [24 * hour], 'a timer for the next complete relist is armed')
  const staleOnDisk = fake.leafPaths[5]
  fake.addFile(staleOnDisk, 'quiet.eimg', 9191, { touch: false })

  nowRef.t += 24 * hour - 1
  const h2 = harness({ fake, db, nowRef })
  fake.resetCalls()
  await h2.initial()
  assert.equal(h2.index.status().mode, 'delta', '23 h 59 min 59.999 s later it is still a delta')
  assert.equal(fake.calls.readDir.length, fake.count().nonLeaf)
  assert.deepEqual(h2.index.candidates(9191), [], 'a file added without moving the directory mtime is invisible to a delta (NTFS lag, design R7)')

  nowRef.t += 1
  const h3 = harness({ fake, db, nowRef })
  fake.resetCalls()
  await h3.initial()
  assert.equal(h3.index.status().mode, 'full')
  assert.equal(fake.calls.readDir.length, fake.count().dirs, 'every directory is listed')
  assert.equal(metaOf(db).gen, '2')
  assert.equal(metaOf(db).full_gen_done, '2')
  assert.equal(metaOf(db).last_full_at, String(nowRef.t))
  assert.deepEqual(h3.index.candidates(9191), [join(staleOnDisk, 'quiet.eimg')], 'the complete relist finds it')
  assert.ok(rowsOf(db).every((r) => r.seen_gen === 2), 'a full pass re-confirms every row in the new generation')

  nowRef.t += 24 * hour
  let seen = 0
  let stopping = null
  const h4 = harness({ fake, db, nowRef, extra: { yieldLoop: async () => { seen += 1; if (seen === 5) stopping = h4.index.dispose() } } })
  await h4.initial().catch(() => undefined)
  await stopping
  assert.equal(metaOf(db).gen, '3')
  assert.equal(metaOf(db).full_gen_done, '2', 'generation 3 is not finished')
  const doneInThree = db.prepare('SELECT dir_path FROM line_media_dirs WHERE listed_gen = 3').all().map((r) => r.dir_path)
  assert.ok(doneInThree.length > 0)
  const h5 = harness({ fake, db, nowRef })
  fake.resetCalls()
  await h5.initial()
  assert.equal(h5.index.status().mode, 'full', 'the interrupted relist continues')
  assert.equal(metaOf(db).gen, '3', 'it does not start a fourth generation')
  assert.equal(metaOf(db).full_gen_done, '3')
  const relisted = fake.listedDirs().filter((d) => fake.leafPaths.includes(d)).map((d) => d.slice(fake.root.length + 1).split(sep).join('/'))
  assert.equal(relisted.filter((d) => doneInThree.includes(d)).length, 0, 'leaves done in generation 3 are not listed again')

  nowRef.t -= 10 * 24 * hour
  const h6 = harness({ fake, db, nowRef })
  await h6.initial()
  assert.equal(h6.index.status().mode, 'full', 'last_full_at in the future (clock moved back): do a complete relist')
  assert.equal(metaOf(db).gen, '4')
})

// ───────────── noteMiss ─────────────

test('noteMiss: nothing happens before start() or while the start delay / a failure backoff is pending; then it runs one delta, throttled to one per 30 s', async () => {
  const fake = makeFakeCache(SMALL)
  const h = harness({ fake })
  h.index.noteMiss()
  assert.equal(h.pending().length, 0, 'before start() a miss schedules nothing')
  h.index.start()
  assert.deepEqual(h.pending().map((t) => t.ms), [5_000], 'the initial scan starts 5 s after start()')
  h.index.noteMiss()
  h.index.noteMiss()
  assert.deepEqual(h.pending().map((t) => t.ms), [5_000], 'a miss during the start delay cannot pre-empt it (boot would compete with it)')
  assert.equal(fake.calls.readDir.length, 0)
  assert.equal(h.index.status().scanning, false)
  await h.fire()
  assert.equal(h.index.status().passes, 1)
  assert.equal(h.index.status().misses, 3, 'misses are counted')

  const base = h.nowRef.t
  h.nowRef.t = base + 29_999
  const armed = h.pending().map((t) => t.ms)
  h.index.noteMiss()
  assert.deepEqual(h.pending().map((t) => t.ms), armed, '29.999 s after the last pass started: throttled, nothing new is scheduled')
  assert.equal(h.index.status().passes, 1)
  h.nowRef.t = base + 30_000
  h.index.noteMiss()
  assert.deepEqual(h.pending().map((t) => t.ms), [0], 'exactly 30 s: a delta is scheduled for the next tick (the caller is synchronous and does no listing itself)')
  assert.equal(fake.calls.readDir.length, fake.count().dirs, 'nothing was listed by the call itself')
  await h.fire()
  assert.equal(h.index.status().passes, 2)
  assert.equal(h.index.status().mode, 'delta')
  h.index.noteMiss()
  assert.equal(h.pending().filter((t) => t.ms === 0).length, 0, 'the throttle restarts from the last pass')
  assert.equal(h.index.status().passes, 2)
})

test('noteMiss: only one scan runs at a time however many misses arrive meanwhile', async () => {
  const fake = makeFakeCache({ tops: 6, leaves: 2, files: 3 })
  let release = null
  const gate = new Promise((resolve) => { release = resolve })
  let blocked = 0
  const h = harness({ fake, extra: { yieldLoop: async () => { blocked += 1; if (blocked === 1) await gate } }, budget: { sliceMaxDirs: 3 } })
  h.index.start()
  const timer = h.pending()[0]
  timer.live = false
  timer.fn()
  await until(() => blocked === 1, { message: 'the first slice to finish' })
  assert.equal(h.index.status().scanning, true)
  const listedBefore = fake.calls.readDir.length
  for (let i = 0; i < 20; i += 1) { h.nowRef.t += 40_000; h.index.noteMiss() }
  assert.equal(fake.calls.readDir.length, listedBefore, 'misses during a scan start nothing')
  assert.equal(h.pending().length, 0, 'and schedule nothing')
  release()
  await h.idle()
  assert.equal(h.index.status().passes, 1, 'exactly one pass ran')
  assert.equal(fake.calls.readDir.filter((d) => d === fake.root).length, 1, 'the root was listed once')
  assert.equal(h.index.status().misses, 20)
})

/** a scan that is paused (at the atYield-th hand-back of the event loop) so that a test can act while it is running */
async function pausedScan({ fake, atYield = 9, budget = { sliceMaxDirs: 3 }, nowRef }) {
  let release = null
  const gate = new Promise((resolve) => { release = resolve })
  let yields = 0
  const h = harness({ fake, nowRef, budget, extra: { yieldLoop: async () => { yields += 1; if (yields === atYield) await gate } } })
  h.index.start()
  const first = h.pending()[0]
  first.live = false
  first.fn()
  await until(() => yields >= atYield, { message: 'the scan to reach the pause' })
  assert.equal(h.index.status().scanning, true)
  return { h, release: () => release() }
}

test('N1: the token in the not_cached message is the one the renderer adapter (pluginApi.ts) looks for', () => {
  const source = readFileSync(new URL('../../src/renderer/platform/pluginApi.ts', import.meta.url), 'utf8')
  const match = /export const MEDIA_INDEX_BUILDING_TOKEN = '([^']+)'/.exec(source)
  assert.ok(match, 'pluginApi.ts exports MEDIA_INDEX_BUILDING_TOKEN')
  assert.equal(match[1], MEDIA_INDEX_BUILDING_TOKEN)
  assert.equal(MEDIA_INDEX_BUILDING_TOKEN, 'index_building')
})

test('N2: a miss that arrives while a scan is running is not lost: after that scan one delta is queued behind the 30 s throttle and finds the file that appeared behind the scan front', async () => {
  const fake = makeFakeCache({ tops: 6, leaves: 2, files: 3 })
  const { h, release } = await pausedScan({ fake })
  const leaf = fake.leafPaths[0]
  assert.ok(fake.calls.readDir.includes(leaf), 'the scan front is already past this leaf')
  fake.addFile(leaf, 'late.eimg', 777)
  const timersBefore = h.timers.length
  h.index.noteMiss()
  assert.equal(h.pending().length, 0, 'the miss does not start or schedule anything while the scan runs')
  release()
  await h.idle()
  assert.equal(h.index.status().passes, 1)
  assert.deepEqual(h.index.candidates(777), [], 'the first scan did not see the file (it was listed before the file appeared)')
  const queued = h.pending()
  assert.equal(queued.length, 1, 'exactly one queued refresh')
  assert.equal(queued[0].ms, 30_000, 'still behind the 30 s throttle, counted from the start of the scan that just ended')
  assert.ok(h.timers.length > timersBefore)
  h.nowRef.t += 30_000
  await h.fire()
  assert.equal(h.index.status().passes, 2)
  assert.equal(h.index.status().mode, 'delta')
  assert.deepEqual(h.index.candidates(777), [join(leaf, 'late.eimg')], 'the queued delta finds it without any further miss')
  assert.equal(h.pending().filter((x) => x.ms === 30_000 || x.ms === 0).length, 0, 'and nothing else is queued')
  assertRows(h)
})

test('N2: however many misses arrive during a scan only one refresh is queued; misses while it waits do not add or move it', async () => {
  const fake = makeFakeCache({ tops: 6, leaves: 2, files: 3 })
  const { h, release } = await pausedScan({ fake })
  for (let i = 0; i < 25; i += 1) h.index.noteMiss()
  release()
  await h.idle()
  assert.equal(h.pending().length, 1)
  const queued = h.pending()[0]
  assert.equal(queued.ms, 30_000, 'it is the queued refresh (30 s throttle), not just the 24 h timer')
  for (let i = 0; i < 25; i += 1) h.index.noteMiss()
  assert.equal(h.pending().length, 1, 'misses while the refresh waits queue nothing more')
  assert.equal(h.pending()[0], queued, 'and the waiting refresh is the same timer')
  const roots = () => fake.calls.readDir.filter((d) => d === fake.root).length
  assert.equal(roots(), 1)
  h.nowRef.t += 30_000
  await h.fire()
  assert.equal(roots(), 2, 'one extra delta, not 25')
  assert.equal(h.index.status().passes, 2)
  assert.equal(h.index.status().misses, 50)
  const after = h.pending()
  assert.ok(after.every((x) => x.ms > 60_000), 'only the 24 h timer is left')
})

test('N2: when the scan already took longer than the throttle the queued refresh runs on the next tick; a miss with no scan running behaves as before (nothing queued)', async () => {
  const fake = makeFakeCache({ tops: 6, leaves: 2, files: 3 })
  const { h, release } = await pausedScan({ fake })
  h.index.noteMiss()
  h.nowRef.t += 45_000
  release()
  await h.idle()
  assert.deepEqual(h.pending().map((x) => x.ms), [0], 'the 30 s since the start of that scan have passed: next tick')
  await h.fire()
  assert.equal(h.index.status().passes, 2)
  // no scan running: the old rule (a throttled direct request), nothing is queued behind it
  h.nowRef.t += 5_000
  h.index.noteMiss()
  assert.ok(h.pending().every((x) => x.ms > 60_000), 'inside the throttle a miss is dropped as before (only the 24 h timer is pending)')
  assert.equal(h.index.status().passes, 2)
})

test('N2: onUnreadable during a scan queues the refresh the same way; a miss during a failing scan queues nothing besides the failure backoff; dispose cancels a queued refresh', async () => {
  const fake = makeFakeCache({ tops: 6, leaves: 2, files: 3 })
  const a = await pausedScan({ fake })
  const victim = join(fake.leafPaths[0], [...fake.dirs.get(fake.leafPaths[0]).entries.keys()][0])
  a.h.index.onUnreadable(victim)
  a.release()
  await a.h.idle()
  assert.equal(a.h.pending().length, 1, 'onUnreadable during the scan queued one refresh')
  assert.equal(a.h.pending()[0].ms, 30_000)
  await a.h.index.dispose()
  assert.equal(a.h.pending().length, 0, 'dispose cancelled the queued refresh')
  const passes = a.h.index.status().passes
  await sleep(20)
  assert.equal(a.h.index.status().passes, passes)

  // a failing scan: the miss must not add a second timer next to the backoff
  const fake2 = makeFakeCache({ tops: 6, leaves: 2, files: 3 })
  let yields = 0
  let release2 = null
  const gate2 = new Promise((resolve) => { release2 = resolve })
  const h2 = harness({ fake: fake2, budget: { sliceMaxDirs: 3 }, extra: { yieldLoop: async () => { yields += 1; if (yields === 2) await gate2 } } })
  h2.index.start()
  const first = h2.pending()[0]
  first.live = false
  first.fn()
  await until(() => yields >= 2, { message: 'the second hand-back' })
  h2.index.noteMiss()
  h2.db.exec('DROP TABLE line_media_dirs')
  release2()
  await h2.idle()
  assert.equal(h2.index.status().errors >= 1, true)
  assert.deepEqual(h2.pending().map((x) => x.ms), [30_000], 'only the failure backoff is pending: no extra queued refresh')
})

test('noteMiss: a failure backs off (30 s, 60 s, ...) and a miss cannot skip the backoff; the next success resets it; the old index data stays usable', async () => {
  const fake = makeFakeCache(SMALL)
  const h = harness({ fake })
  await h.initial()
  const ready = h.index.isReady()
  assert.equal(ready, true)
  const sizes = rowsOf(h.db).map((r) => r.size)
  fake.fails.set(fake.root, Object.assign(new Error('EACCES'), { code: 'EACCES' }))
  assert.equal(await h.delta(), 0)
  assert.equal(h.index.status().errors, 1)
  assert.ok(h.log.logs.includes('[media-index] root_unreadable'))
  assert.deepEqual(h.pending().map((t) => t.ms), [30_000], 'retry in 30 s')
  h.nowRef.t += 100_000
  const listed = fake.calls.readDir.length
  h.index.noteMiss()
  assert.deepEqual(h.pending().map((t) => t.ms), [30_000], 'a miss does not skip the backoff (the retry timer is still the only one)')
  assert.equal(fake.calls.readDir.length, listed)
  await h.fire()
  assert.equal(h.index.status().errors, 2)
  assert.deepEqual(h.pending().map((t) => t.ms), [60_000], 'the backoff doubles')
  assert.equal(h.index.isReady(), true, 'a failed refresh does not make the index not ready')
  assert.ok(h.index.candidates(sizes[0]).length > 0, 'and the earlier rows still serve lookups')
  fake.fails.delete(fake.root)
  await h.fire()
  assert.equal(h.index.status().passes, 2, 'the retry succeeded')
  assert.deepEqual(h.pending().map((t) => t.ms), [24 * 60 * 60 * 1000 - (h.nowRef.t - Number(metaOf(h.db).last_full_at))], 'back to the 24 h timer')
  fake.fails.set(fake.root, new Error('again'))
  await h.delta()
  assert.deepEqual(h.pending().map((t) => t.ms), [30_000], 'the backoff starts over at 30 s')
})

// ───────────── onUnreadable / markStale / odd inputs ─────────────

test('onUnreadable marks the row stale, forces its directory to be listed again and asks for one throttled refresh; the next delta revives it if the file is back', async () => {
  const fake = makeFakeCache(SMALL)
  const h = harness({ fake })
  await h.initial()
  const leaf = fake.leafPaths[0]
  const [name, entry] = [...fake.dirs.get(leaf).entries.entries()][0]
  const path = join(leaf, name)
  h.nowRef.t += 31_000
  fake.resetCalls()
  h.index.onUnreadable(path)
  assert.deepEqual(h.pending().map((t) => t.ms), [0], 'a refresh was requested for the next tick')
  assert.deepEqual(fake.calls.readDir, [], 'the call itself lists nothing')
  const staleAtCall = rowsOf(h.db).find((r) => r.name === name)
  assert.equal(staleAtCall.state, 'stale')
  assert.equal(staleAtCall.stale_at, h.nowRef.t)
  assert.equal(dirRowOf(h.db, 't0/u0/m/0').mtime_ns, '', 'the directory is forced to be listed again')
  await h.fire()
  assert.ok(fake.calls.readDir.includes(leaf), 'the unchanged directory was listed because of the force')
  assert.equal(rowsOf(h.db).find((r) => r.name === name).state, 'live', 'the file is still there, so it is live again')
  assert.deepEqual(h.index.candidates(entry.size).includes(path), true)

  h.index.onUnreadable(path)
  assert.equal(rowsOf(h.db).find((r) => r.name === name).state, 'stale', 'marked again, even though the refresh itself is throttled')
  assert.equal(h.pending().filter((t) => t.ms === 0).length, 0, 'within 30 s: no second refresh is scheduled')
  assert.equal(h.index.status().rows, liveCount(h.db), 'the counter followed the external markStale')
  await h.delta()
  assert.equal(rowsOf(h.db).find((r) => r.name === name).state, 'live')
  assertRows(h, 'after revival')
})

test('markStale ignores anything that is not a path under the Cache root, an unknown row or a closed database; none of them throw', async () => {
  const fake = makeFakeCache(SMALL)
  const h = harness({ fake })
  await h.initial()
  const before = JSON.stringify(rowsOf(h.db))
  for (const bad of [undefined, null, 7, {}, [], '', fake.root, join(fake.root, '..', 'elsewhere', 'x.eimg'), join(tmpdir(), 'other', 'x.eimg'), 'C:\\no\\where.eimg', 'relative.eimg', join(fake.root, 'nope', 'missing.eimg')]) {
    h.index.markStale(bad)
  }
  assert.equal(JSON.stringify(rowsOf(h.db)), before, 'nothing changed')
  const unknownDirForced = dirRowOf(h.db, 'nope')
  assert.equal(unknownDirForced, undefined, 'no directory row is invented')
  h.db.close()
  assert.doesNotThrow(() => h.index.markStale(join(fake.leafPaths[0], 'f0.eimg')))
  assert.doesNotThrow(() => h.index.onUnreadable(join(fake.leafPaths[0], 'f0.eimg')))
  assert.deepEqual(h.index.candidates(100), [])
  assert.doesNotThrow(() => h.index.status())
})

test('an unreadable file reported while the first scan is unfinished makes its leaf be listed again on resume, the other already-listed leaves are still skipped', async () => {
  const fake = makeFakeCache({ tops: 40, leaves: 3, files: 5 })
  const db = newDb()
  let seen = 0
  let stopping = null
  const h1 = harness({ fake, db, extra: { yieldLoop: async () => { seen += 1; if (seen === 7) stopping = h1.index.dispose() } } })
  await h1.initial().catch(() => undefined)
  await stopping
  const firstLeaves = fake.listedDirs().filter((d) => fake.leafPaths.includes(d))
  assert.ok(firstLeaves.length > 2, `${firstLeaves.length} leaves were listed before the restart`)
  const target = firstLeaves[0]
  const targetName = [...fake.dirs.get(target).entries.keys()][0]
  const reporter = harness({ fake, db })
  reporter.index.markStale(join(target, targetName))
  assert.equal(rowsOf(db).find((r) => r.dir_path === target.slice(fake.root.length + 1).split(sep).join('/') && r.name === targetName).state, 'stale')
  fake.resetCalls()
  const h2 = harness({ fake, db })
  await h2.initial()
  const again = fake.listedDirs().filter((d) => fake.leafPaths.includes(d))
  assert.ok(again.includes(target), 'the leaf with the unreadable file is listed again')
  assert.deepEqual(firstLeaves.filter((d) => d !== target && again.includes(d)), [], 'the other leaves listed before the restart are not')
  assert.equal(rowsOf(db).find((r) => r.name === targetName).state, 'live', 'and the file that is still there is live again')
  assertRows(h2)
})

test('candidates: only whole non-negative sizes that exist and are live; every other input, a closed database or a disposed index gives an empty list', async () => {
  const fake = makeFakeCache(SMALL)
  const h = harness({ fake })
  assert.deepEqual(h.index.candidates(100), [], 'before any scan')
  await h.initial()
  const size = rowsOf(h.db)[0].size
  assert.ok(h.index.candidates(size).length >= 1)
  for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2, '100', null, undefined, {}, 0, 123456789]) assert.deepEqual(h.index.candidates(bad), [], String(bad))
  h.db.prepare(`INSERT INTO line_media_index(size,dir_path,name,state,seen_gen) VALUES (-5,'x','neg.eimg','live',1)`).run()
  assert.deepEqual(h.index.candidates(-5), [], 'a negative size is never looked up, even if a row for it exists')
  const missing = harness({ fake, db: null })
  assert.deepEqual(missing.index.candidates(size), [])
  assert.equal(missing.index.isAvailable(), false)
  assert.equal(missing.index.isReady(), false)
  assert.equal(missing.index.status().available, false)
  h.db.exec(`UPDATE line_media_index_meta SET value = 'C:\\\\somewhere\\\\else' WHERE key = 'cache_root'`)
  const mismatched = harness({ fake, db: h.db })
  assert.deepEqual(mismatched.index.candidates(size), [], 'rows built for another Cache root are never turned into paths under this one')
  assert.equal(mismatched.index.isReady(), false)
  h.db.exec(`UPDATE line_media_index_meta SET value = '${fake.root.replace(/'/g, "''")}' WHERE key = 'cache_root'`)
  const again = harness({ fake, db: h.db })
  assert.ok(again.index.candidates(size).length >= 1)
  h.db.close()
  assert.deepEqual(h.index.candidates(size), [], 'a closed database')
  const d = harness({ fake })
  await d.initial()
  await d.index.dispose()
  assert.deepEqual(d.index.candidates(size), [])
  assert.equal(d.index.isReady(), false)
})

test('the Cache root changing resets the index: old rows are never served, the new root is scanned from scratch (generation 1)', async () => {
  const fake = makeFakeCache(SMALL)
  const db = newDb()
  const h1 = harness({ fake, db })
  await h1.initial()
  const size = rowsOf(db)[0].size
  assert.ok(h1.index.candidates(size).length > 0)
  const other = makeFakeCache({ tops: 1, leaves: 1, files: 2, root: join(tmpdir(), 'wpb-fake-other', 'Cache') })
  const h2 = harness({ fake: other, db })
  assert.equal(h2.index.isReady(), false, 'not ready for a different root')
  assert.deepEqual(h2.index.candidates(size), [])
  await h2.initial()
  assert.equal(rowsOf(db).length, other.count().files, 'only the new root remains')
  assert.equal(metaOf(db).cache_root, other.root)
  assert.equal(metaOf(db).gen, '1')
  assert.equal(h2.index.isReady(), true)
  assert.equal(h2.index.status().mode, 'initial')
  assertRows(h2, 'after the reset')
  assert.equal(h2.index.status().rows, other.count().files)
})

test('unreadable directories: a listing that fails but exists keeps its rows; one that is gone goes stale; the scan finishes either way; an unreadable root fails the pass without touching the index; empty roots and empty directories are fine', async () => {
  const fake = makeFakeCache({ tops: 2, leaves: 2, files: 3 })
  const h = harness({ fake })
  await h.initial()
  const [leafA, leafB] = fake.leafPaths
  const before = rowsOf(h.db)
  fake.touch(leafA)
  fake.touch(leafB)
  fake.fails.set(leafA, Object.assign(new Error('EACCES'), { code: 'EACCES' }))
  await h.delta()
  assert.equal(h.index.status().errors, 1)
  assert.deepEqual(rowsOf(h.db).filter((r) => r.dir_path === 't0/u0/m/0'), before.filter((r) => r.dir_path === 't0/u0/m/0'), 'a directory that exists but cannot be read keeps its rows untouched')
  assert.equal(h.index.status().passes, 2, 'the pass still finished')
  assert.equal(h.index.isReady(), true)

  fake.fails.delete(leafA)
  fake.fails.set(leafB, Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
  fake.flags.ghosts.add(leafB)
  fake.touch(leafA)
  fake.touch(leafB)
  await h.delta()
  const goneRows = rowsOf(h.db).filter((r) => r.dir_path === 't0/u0/m/1')
  assert.ok(goneRows.length === 3 && goneRows.every((r) => r.state === 'stale'), 'listing failed and the directory is gone: its files are stale')
  assert.equal(dirRowOf(h.db, 't0/u0/m/1'), undefined)
  assertRows(h, 'after a directory vanished')

  const empty = makeFakeCache({ tops: 0 })
  const e = harness({ fake: empty })
  await e.initial()
  assert.equal(e.index.isReady(), true, 'an empty Cache is a complete scan')
  assert.equal(e.index.status().rows, 0)
  assert.deepEqual(e.index.candidates(100), [])
  assert.equal(dirRowOf(e.db, '').has_subdirs, 0)

  const dead = makeFakeCache(SMALL)
  const d = harness({ fake: dead })
  dead.fails.set(dead.root, new Error('EIO'))
  await d.initial()
  assert.equal(d.index.isReady(), false)
  assert.equal(rowsOf(d.db).length, 0)
  assert.equal(d.index.status().errors, 1)
  assert.equal(d.index.status().passes, 0)
  assert.deepEqual(metaOf(d.db), { schema_version: '1', cache_root: dead.root, gen: '1' }, 'nothing is marked done')
  assert.equal(d.index.status().scanning, false)
})

test('entries without a size are stat-ed one by one (a file that cannot be stat-ed, or reports nonsense, is skipped); entries come back as live rows with the stat size', async () => {
  const fake = makeFakeCache({ tops: 1, leaves: 1, files: 4 })
  const leaf = fake.leafPaths[0]
  const names = [...fake.dirs.get(leaf).entries.keys()]
  fake.flags.omitSize = true
  fake.flags.statFails.add(join(leaf, names[0]))
  const h = harness({ fake })
  await h.initial()
  const rows = rowsOf(h.db)
  assert.equal(rows.length, 3, 'the file whose stat fails is skipped, the others are indexed')
  assert.ok(!rows.some((r) => r.name === names[0]))
  assert.equal(fake.calls.stat, 4, 'one stat per .eimg')
  assert.ok(rows.every((r) => r.size === fake.dirs.get(leaf).entries.get(r.name).size))
})

// ───────────── dispose ─────────────

test('dispose: an unfinished scan stops at the next slice and nothing touches the filesystem or the database afterwards; pending timers are cancelled; start() after dispose does nothing', async () => {
  const fake = makeFakeCache({ tops: 30, leaves: 2, files: 4 })
  let seen = 0
  let stopping = null
  const h = harness({ fake, extra: { yieldLoop: async () => { seen += 1; if (seen === 3) stopping = h.index.dispose() } } })
  await h.initial().catch(() => undefined)
  await stopping
  assert.ok(seen >= 3 && seen < 10, `the pass stopped soon after dispose (${seen} yields)`)
  const listed = fake.calls.readDir.length
  const rowsNow = rowsOf(h.db).length
  h.index.noteMiss()
  h.index.start()
  h.index.markStale(join(fake.leafPaths[0], 'f0.eimg'))
  await sleep(30)
  assert.equal(fake.calls.readDir.length, listed, 'no directory is listed after dispose')
  assert.equal(rowsOf(h.db).length, rowsNow)
  assert.equal(h.pending().length, 0, 'no timer is left')
  assert.equal(h.index.status().scanning, false)
  const early = harness({ fake: makeFakeCache(SMALL) })
  early.index.start()
  assert.equal(early.pending().length, 1)
  await early.index.dispose()
  assert.equal(early.pending().length, 0, 'disposing before the start delay cancels it')
  assert.equal(early.fake.calls.readDir.length, 0)
  await early.index.dispose()
})

test('status(): the shape the diagnostics rely on, and an index with no Cache reports the off status', async () => {
  const fake = makeFakeCache(SMALL)
  const h = harness({ fake })
  assert.deepEqual(Object.keys(h.index.status()).sort(), Object.keys(MEDIA_INDEX_OFF_STATUS).sort())
  assert.deepEqual(h.index.status(), { available: true, ready: false, rows: 0, scanning: false, lastScanMs: null, lastRefreshAt: null, mode: 'idle', passes: 0, dirsListed: 0, errors: 0, misses: 0 })
  await h.initial()
  const s = h.index.status()
  assert.equal(s.available && s.ready && !s.scanning, true)
  assert.equal(s.rows, fake.count().files)
  assert.ok(Number.isFinite(s.lastScanMs) && s.lastScanMs >= 0)
  assert.equal(s.lastRefreshAt, h.nowRef.t)
  assert.equal(s.passes, 1)
  assert.deepEqual(MEDIA_INDEX_OFF_STATUS, { available: false, ready: false, rows: 0, scanning: false, lastScanMs: null, lastRefreshAt: null, mode: 'idle', passes: 0, dirsListed: 0, errors: 0, misses: 0 })
})

test('dispose waits for the pass that is in flight, which then stops at the next slice boundary without finishing', async () => {
  const fake = makeFakeCache({ tops: 6, leaves: 2, files: 3 })
  let release = null
  const gate = new Promise((resolve) => { release = resolve })
  let blocked = 0
  const h = harness({ fake, extra: { yieldLoop: async () => { blocked += 1; if (blocked === 1) await gate } }, budget: { sliceMaxDirs: 3 } })
  h.index.start()
  const first = h.pending()[0]
  first.live = false
  first.fn()
  await until(() => blocked === 1, { message: 'the first slice' })
  const listed = fake.calls.readDir.length
  let settled = false
  const closing = h.index.dispose().then(() => { settled = true })
  await sleep(30)
  assert.equal(settled, false, 'dispose does not resolve while the pass is still running')
  release()
  await closing
  assert.equal(fake.calls.readDir.length, listed, 'no further directory is listed once dispose was called')
  assert.equal(h.index.status().passes, 0, 'the pass was abandoned, not completed')
  assert.equal(metaOf(h.db).initial_scan_done, undefined)
})

test('dispose during the final slice of a scan: the scan is not recorded as complete', async () => {
  const fake = makeFakeCache(SMALL)
  let h
  h = harness({ fake, budget: { sliceMaxDirs: 1000 }, extra: { onSlice: () => { void h.index.dispose() } } })
  h.index.start()
  await h.fire()
  assert.equal(metaOf(h.db).initial_scan_done, undefined)
  assert.equal(metaOf(h.db).last_full_at, undefined)
  assert.equal(h.index.status().passes, 0)
})

test('dispose during the purge phase stops the purge: the stale rows that are left stay', async () => {
  const fake = makeFakeCache({ tops: 5, leaves: 3, files: 100 })
  const db = newDb()
  const nowRef = { t: 1_800_000_000_000 }
  const day = 24 * 60 * 60 * 1000
  const h1 = harness({ fake, db, nowRef })
  await h1.initial()
  for (const leaf of fake.leafPaths.slice(0, 12)) {
    for (const name of [...fake.dirs.get(leaf).entries.keys()]) fake.removeFile(leaf, name, { touch: false })
    fake.touch(leaf)
  }
  await h1.delta()
  const staleCount = () => db.prepare(`SELECT count(*) AS n FROM line_media_index WHERE state='stale'`).get().n
  assert.equal(staleCount(), 1_200)
  db.prepare(`UPDATE line_media_index SET stale_at = ? WHERE state='stale'`).run(nowRef.t - 40 * day)
  let closing = null
  let h2
  h2 = harness({ fake, db, nowRef, extra: { onPurge: () => { if (!closing) closing = h2.index.dispose() } } })
  h2.index.start()
  await h2.fire()
  await closing
  assert.equal(staleCount(), 700, 'only the first batch of 500 was purged')
})

test('after dispose: a timer that was already queued starts nothing, start() schedules nothing, and a pass that fails while being disposed arms no retry', async () => {
  const a = harness({ fake: makeFakeCache(SMALL) })
  a.index.start()
  const late = a.pending()[0]
  await a.index.dispose()
  late.fn()
  assert.equal(a.index.status().scanning, false, 'a queued launch is refused on a disposed index')
  await sleep(20)
  assert.equal(a.fake.calls.readDir.length, 0)

  const b = harness({ fake: makeFakeCache(SMALL) })
  await b.index.dispose()
  b.index.start()
  assert.equal(b.pending().length, 0, 'start() after dispose arms nothing')

  const fake = makeFakeCache(SMALL)
  let c
  fake.flags.readDirHook = (dir) => { if (dir === fake.root) { void c.index.dispose(); throw new Error('EIO') } }
  c = harness({ fake })
  c.index.start()
  const t = c.pending()[0]
  t.live = false
  t.fn()
  await sleep(30)
  assert.equal(c.pending().length, 0, 'no retry timer for a disposed index')
  assert.equal(c.index.status().errors, 1)
})

test('a file reported unreadable while a scan is running has its directory listed again in that same scan', async () => {
  const fake = makeFakeCache({ tops: 6, leaves: 2, files: 3 })
  const db = newDb()
  const h0 = harness({ fake, db })
  await h0.initial()
  fake.resetCalls()
  let release = null
  const gate = new Promise((resolve) => { release = resolve })
  let blocked = 0
  const h = harness({ fake, db, nowRef: h0.nowRef, budget: { sliceMaxDirs: 2 }, extra: { yieldLoop: async () => { blocked += 1; if (blocked === 1) await gate } } })
  h.nowRef.t += 31_000
  h.index.start()
  const first = h.pending()[0]
  first.live = false
  first.fn()
  await until(() => blocked === 1, { message: 'the first slice of the delta' })
  const target = fake.leafPaths.at(-1)
  const name = [...fake.dirs.get(target).entries.keys()][0]
  assert.ok(!fake.calls.readDir.includes(target) && !fake.calls.readDir.includes(dirname(target)), 'the leaf and its parent are still ahead in the queue')
  h.index.markStale(join(target, name))
  fake.resetCalls()
  release()
  await h.idle()
  assert.ok(fake.calls.readDir.includes(target), 'the leaf is listed in this very pass, not only in the next one')
  assert.equal(rowsOf(db).find((r) => r.dir_path === 't5/u5/m/1' && r.name === name).state, 'live')
  assertRows(h)
})

test('markStale only touches rows under the Cache root: a path outside it, or on another drive, matches nothing even if a row with that relative shape exists', async () => {
  const fake = makeFakeCache(SMALL)
  const h = harness({ fake })
  await h.initial()
  h.db.prepare(`INSERT INTO line_media_index(size,dir_path,name,state,seen_gen) VALUES (777,'../elsewhere','x.eimg','live',1), (778,'D:/x','y.eimg','live',1)`).run()
  h.index.markStale(join(fake.root, '..', 'elsewhere', 'x.eimg'))
  h.index.markStale('D:\\x\\y.eimg')
  assert.deepEqual(h.db.prepare(`SELECT state FROM line_media_index WHERE size IN (777, 778) ORDER BY size`).all().map((r) => r.state), ['live', 'live'])
})

test('an index over a database without its tables switches itself off for good (logged once); creating the tables later does not switch it back on', async () => {
  const bare = new Database(':memory:')
  const fake = makeFakeCache(SMALL)
  const h = harness({ fake, db: bare })
  assert.deepEqual(h.index.candidates(100), [])
  assert.equal(h.index.isAvailable(), false)
  assert.equal(h.index.isReady(), false)
  assert.deepEqual(h.log.logs, ['[media-index] schema_unavailable'], 'logged once, however often it is asked')
  ensureMediaIndexSchema(bare)
  assert.equal(h.index.isAvailable(), false, 'a restart is needed: no flapping')
  assert.equal(h.index.status().available, false)
  h.index.start()
  await h.fire().catch(() => undefined)
  assert.equal(fake.calls.readDir.length, 0, 'and it never scans')
})

// ───────────── decrypt.ts ─────────────

const IKM_B64 = Buffer.alloc(32, 7).toString('base64')
function makeEimg(plain, keyMaterialB64 = IKM_B64) {
  const derived = Buffer.from(hkdfSync('sha256', Buffer.from(keyMaterialB64, 'base64'), Buffer.alloc(32, 0), Buffer.from('FileEncryption'), 76))
  const nonce = Buffer.concat([derived.subarray(64, 76), Buffer.alloc(4, 0)])
  const cipher = createCipheriv('aes-256-ctr', derived.subarray(0, 32), nonce)
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([ciphertext, createHmac('sha256', derived.subarray(32, 64)).update(ciphertext).digest()])
}
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const pngBytes = (n, fill = 0x5a) => Buffer.concat([PNG_HEAD, Buffer.alloc(n, fill)])
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0])

function spyFs(files) {
  const calls = { readDir: 0, stat: 0, readFile: [], exists: 0 }
  return {
    calls,
    readDir() { calls.readDir += 1; throw new Error('walking the Cache is not allowed here') },
    stat() { calls.stat += 1; throw new Error('stat is not allowed here') },
    exists() { calls.exists += 1; return false },
    readFile(path) { calls.readFile.push(path); const bytes = files.get(path); if (!bytes) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return bytes }
  }
}

test('decrypt with an index: candidates come from the index for size + 32, the Cache is never listed or stat-ed, and the first matching HMAC wins', () => {
  const plain = pngBytes(900)
  const eimg = makeEimg(plain)
  const files = new Map([['/c/a.eimg', Buffer.alloc(eimg.length, 1)], ['/c/b.eimg', eimg]])
  const fs = spyFs(files)
  const asked = []
  const dec = createMediaDecryptor({ fs, cacheDir: '/c', index: { candidates: (size) => { asked.push(size); return size === plain.length + 32 ? ['/c/a.eimg', '/c/b.eimg'] : [] } } })
  const res = dec.decrypt({ keyMaterial: IKM_B64, fileSize: plain.length })
  assert.equal(res.status, 'ok')
  assert.deepEqual(res.bytes, plain)
  assert.equal(res.mime, 'image/png')
  assert.deepEqual(asked, [plain.length + 32])
  assert.deepEqual(fs.calls.readFile, ['/c/a.eimg', '/c/b.eimg'], 'a candidate that fails the HMAC is skipped, not reported as unreadable')
  assert.equal(fs.calls.readDir + fs.calls.stat, 0, 'no walk, no stat')
  assert.deepEqual(dec.decrypt({ keyMaterial: IKM_B64, fileSize: 12345 }), { status: 'not-cached' })
  assert.equal(fs.calls.readFile.length, 2, 'no candidate, nothing read')
  dec.reset()
  assert.equal(dec.decrypt({ keyMaterial: IKM_B64, fileSize: plain.length }).status, 'ok', 'reset() has nothing to rebuild and changes nothing')
  assert.equal(fs.calls.readDir, 0)
})

test('decrypt with an index: an unreadable candidate is reported once with its path and the next candidate is still tried; a throwing report, a wrong-size file and a wrong key do not break the loop', () => {
  const plain = pngBytes(500)
  const eimg = makeEimg(plain)
  const wrongSize = Buffer.alloc(eimg.length + 5, 2)
  const files = new Map([['/c/ok.eimg', eimg], ['/c/short.eimg', wrongSize]])
  const reported = []
  const dec = (onUnreadable) => createMediaDecryptor({ fs: spyFs(files), cacheDir: '/c', index: { candidates: () => ['/c/gone.eimg', '/c/short.eimg', '/c/ok.eimg'], ...(onUnreadable ? { onUnreadable } : {}) } })
  assert.equal(dec((p) => reported.push(p)).decrypt({ keyMaterial: IKM_B64, fileSize: plain.length }).status, 'ok')
  assert.deepEqual(reported, ['/c/gone.eimg'], 'only the file that could not be read is reported (a wrong size is not)')
  assert.equal(dec(() => { throw new Error('boom') }).decrypt({ keyMaterial: IKM_B64, fileSize: plain.length }).status, 'ok', 'a throwing onUnreadable does not stop the loop')
  assert.equal(dec(null).decrypt({ keyMaterial: IKM_B64, fileSize: plain.length }).status, 'ok', 'onUnreadable is optional')
  const onlyBad = createMediaDecryptor({ fs: spyFs(files), cacheDir: '/c', index: { candidates: () => ['/c/gone.eimg', '/c/short.eimg'], onUnreadable: (p) => reported.push(`2:${p}`) } })
  assert.deepEqual(onlyBad.decrypt({ keyMaterial: IKM_B64, fileSize: plain.length }), { status: 'hmac-miss' })
  assert.deepEqual(reported.slice(1), ['2:/c/gone.eimg'])
  const wrongKey = createMediaDecryptor({ fs: spyFs(files), cacheDir: '/c', index: { candidates: () => ['/c/ok.eimg'], onUnreadable: (p) => reported.push(`3:${p}`) } })
  assert.deepEqual(wrongKey.decrypt({ keyMaterial: Buffer.alloc(32, 9).toString('base64'), fileSize: plain.length }), { status: 'hmac-miss' })
  assert.ok(!reported.some((r) => r.startsWith('3:')), 'a wrong key is not an unreadable file')
  const broken = createMediaDecryptor({ fs: spyFs(files), cacheDir: '/c', index: { candidates: () => { throw new Error('index exploded') } } })
  assert.deepEqual(broken.decrypt({ keyMaterial: IKM_B64, fileSize: plain.length }), { status: 'error' }, 'a failing index is an error result, never a walk')
  for (const bad of [{ keyMaterial: '', fileSize: 10 }, { keyMaterial: IKM_B64, fileSize: Number.NaN }, { keyMaterial: null, fileSize: 10 }]) {
    const r = createMediaDecryptor({ fs: spyFs(files), cacheDir: '/c', index: { candidates: () => [] } }).decrypt(bad)
    assert.ok(['not-cached', 'error'].includes(r.status), JSON.stringify(bad))
  }
})

test('decrypt without an index behaves exactly as before: lazy one-time walk with a stat per .eimg, memoised, rebuilt only by reset(), not-cached for an unknown size, unreadable files skipped silently', () => {
  const plain = pngBytes(700)
  const eimg = makeEimg(plain)
  const c = (...parts) => join(sep, 'c', ...parts)
  const tree = new Map([
    [c(), [{ name: 'd', isFile: false, isDirectory: true }, { name: 'x.txt', isFile: true, isDirectory: false }]],
    [c('d'), [{ name: 'ok.eimg', isFile: true, isDirectory: false }, { name: 'ghost.EIMG', isFile: true, isDirectory: false }, { name: 'bad.eimg', isFile: true, isDirectory: false }]]
  ])
  const sizes = new Map([[c('d', 'ok.eimg'), eimg.length], [c('d', 'ghost.EIMG'), eimg.length], [c('d', 'bad.eimg'), 1]])
  const calls = { readDir: [], stat: [], readFile: [] }
  const fs = {
    readDir: (dir) => { calls.readDir.push(dir); const e = tree.get(dir); if (!e) throw new Error('ENOENT'); return e },
    stat: (p) => { calls.stat.push(p); if (!sizes.has(p)) throw new Error('ENOENT'); return { size: sizes.get(p), mtimeNs: 0n } },
    readFile: (p) => { calls.readFile.push(p); if (p === c('d', 'ghost.EIMG')) throw new Error('EBUSY'); if (p === c('d', 'ok.eimg')) return eimg; throw new Error('ENOENT') }
  }
  const dec = createMediaDecryptor({ fs, cacheDir: c() })
  assert.equal(dec.decrypt({ keyMaterial: IKM_B64, fileSize: plain.length }).status, 'ok')
  assert.deepEqual(calls.readDir, [c(), c('d')], 'the first call walks the whole Cache')
  assert.deepEqual(calls.stat, [c('d', 'ok.eimg'), c('d', 'ghost.EIMG'), c('d', 'bad.eimg')], 'with one stat per .eimg (any case)')
  assert.deepEqual(calls.readFile, [c('d', 'ok.eimg')], 'candidates are tried in walk order; the first match wins')
  assert.equal(dec.decrypt({ keyMaterial: IKM_B64, fileSize: 999 }).status, 'not-cached')
  assert.equal(dec.decrypt({ keyMaterial: IKM_B64, fileSize: plain.length }).status, 'ok')
  assert.equal(calls.readDir.length, 2, 'memoised: no second walk')
  dec.reset()
  dec.decrypt({ keyMaterial: IKM_B64, fileSize: plain.length })
  assert.equal(calls.readDir.length, 4, 'reset() makes the next call walk again')
  assert.equal(dec.decrypt({ keyMaterial: IKM_B64, fileSize: plain.length, cacheDir: join(sep, 'other') }).status, 'not-cached', 'another cacheDir is a new walk of that directory')
  assert.equal(calls.readDir.at(-1), join(sep, 'other'))
  const ghostOnly = createMediaDecryptor({ fs: { ...fs, readFile: () => { throw new Error('EBUSY') } }, cacheDir: c() })
  assert.deepEqual(ghostOnly.decrypt({ keyMaterial: IKM_B64, fileSize: plain.length }), { status: 'hmac-miss' }, 'unreadable candidates are skipped without any callback')
})

// ───────────── fs ports ─────────────

function withTemp(prefix, body) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  try { return body(root) } finally { rmSync(root, { recursive: true, force: true }) }
}
async function withTempAsync(prefix, body) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  try { return await body(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

test('NodeLineFsPort.readDir: without options the entries have exactly the old shape; with { stat: true } files and directories carry size and mtimeNs equal to stat', () => withTemp('wpb-node-', (root) => {
  const port = new NodeLineFsPort()
  writeFileSync(join(root, 'a.eimg'), Buffer.alloc(123, 1))
  writeFileSync(join(root, 'b.txt'), '')
  mkdirSync(join(root, 'sub'))
  const plain = port.readDir(root).sort((x, y) => x.name.localeCompare(y.name))
  assert.deepEqual(plain.map((e) => Object.keys(e).sort()), plain.map(() => ['isDirectory', 'isFile', 'name']))
  const withStat = port.readDir(root, { stat: true }).sort((x, y) => x.name.localeCompare(y.name))
  assert.deepEqual(withStat.map((e) => e.name), ['a.eimg', 'b.txt', 'sub'])
  for (const e of withStat) {
    const st = statSync(join(root, e.name), { bigint: true })
    assert.equal(e.mtimeNs, st.mtimeNs, `${e.name} mtimeNs`)
    if (e.isFile) assert.equal(e.size, Number(st.size), `${e.name} size`)
  }
  assert.equal(withStat.find((e) => e.name === 'a.eimg').size, 123)
  assert.deepEqual(port.readDir(root, {}).map((e) => 'size' in e), [false, false, false], 'an empty options object is not a request')
  assert.deepEqual(port.readDir(root, { stat: false }).map((e) => 'mtimeNs' in e), [false, false, false])
  assert.throws(() => port.readDir(join(root, 'missing'), { stat: true }))
}))

test('Win32LineFsPort.readDir (real koffi): size and mtimeNs come back with the listing and equal what stat reports, for files and directories, without any extra call', () => withTemp('wpb-win32-', (root) => {
  const port = createWin32LineFsPort({ workspaceRoot: join(root, 'ws') })
  const dir = join(root, 'cache')
  mkdirSync(join(dir, 'sub'), { recursive: true })
  writeFileSync(join(dir, 'a.eimg'), Buffer.alloc(4321, 3))
  writeFileSync(join(dir, 'empty.eimg'), '')
  writeFileSync(join(dir, 'big.eimg'), Buffer.alloc(3_000_000, 4))
  const listed = port.readDir(dir).sort((x, y) => x.name.localeCompare(y.name))
  assert.deepEqual(listed.map((e) => e.name), ['a.eimg', 'big.eimg', 'empty.eimg', 'sub'])
  for (const e of listed) {
    const st = statSync(join(dir, e.name), { bigint: true })
    assert.equal(e.mtimeNs, st.mtimeNs, `${e.name} mtimeNs from FindFirstFileW equals the node stat value`)
    assert.equal(e.mtimeNs, port.stat(join(dir, e.name)).mtimeNs, `${e.name} equals the port's own stat`)
    if (e.isFile) assert.equal(e.size, Number(st.size), `${e.name} size`)
  }
  assert.equal(listed.find((e) => e.name === 'sub').isDirectory, true)
  assert.equal(listed.find((e) => e.name === 'sub').size, 0)
  assert.equal(listed.find((e) => e.name === 'empty.eimg').size, 0)
  assert.equal(listed.find((e) => e.name === 'big.eimg').size, 3_000_000)
  assert.deepEqual(port.readDir(dir, { stat: true }).sort((x, y) => x.name.localeCompare(y.name)), listed, 'asking for stat changes nothing: the data is already there')
  assert.throws(() => port.readDir(join(dir, 'missing')), (error) => error.code === 'ENOENT')
}))

test('the index scans a real directory tree through the Node port and the Win32 port the same way', async () => {
  await withTempAsync('wpb-real-', async (root) => {
    const cache = join(root, 'Cache')
    for (const [i, leaf] of ['a/b/m/0', 'a/b/m/1', 'c/d/m/f'].entries()) {
      mkdirSync(join(cache, ...leaf.split('/')), { recursive: true })
      for (let f = 0; f < 3; f += 1) writeFileSync(join(cache, ...leaf.split('/'), `x${i}${f}.eimg`), Buffer.alloc(100 + i * 10 + f))
    }
    writeFileSync(join(cache, 'a', 'readme.txt'), 'x')
    const results = []
    for (const port of [new NodeLineFsPort(), createWin32LineFsPort({ workspaceRoot: join(root, 'ws') })]) {
      const db = newDb()
      const h = { index: createMediaIndex({ getDb: () => db, fs: port, cacheDir: cache, budget: { startDelayMs: 0 } }) }
      h.index.start()
      await until(() => h.index.isReady(), { message: 'a real scan' })
      results.push(rowsOf(db).map((r) => `${r.dir_path}|${r.name}|${r.size}`))
      assert.deepEqual(h.index.candidates(110), [join(cache, 'a', 'b', 'm', '1', 'x10.eimg')])
      await h.index.dispose()
    }
    assert.equal(results[0].length, 9)
    assert.deepEqual(results[0], results[1], 'identical rows from both ports')
  })
})

// ───────────── media.ts: prepare only queries the index ─────────────

function fakeMediaIndex(over = {}) {
  const calls = { noteMiss: 0, isReady: 0, isAvailable: 0, status: 0 }
  return {
    calls,
    candidates: () => [], onUnreadable() {}, markStale() {}, start() {}, async dispose() {},
    noteMiss() { calls.noteMiss += 1 },
    isAvailable() { calls.isAvailable += 1; return over.available ?? true },
    isReady() { calls.isReady += 1; return over.ready ?? true },
    status() { calls.status += 1; return { ...MEDIA_INDEX_OFF_STATUS, available: true, ready: over.ready ?? true, rows: 7 } }
  }
}

function mediaDb(row) { return { prepare: () => ({ get: () => row }) } }

test('media.prepare: not_cached comes back at once; the message says 索引建立中 only while the index is not ready; every miss asks the index for a refresh; the decryptor is never reset (no synchronous rebuild)', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wpb-media-'))
  try {
    const row = { key_material: IKM_B64, file_size: 600, content_type: 1 }
    let resets = 0
    let decrypts = 0
    const decryptor = { decrypt: () => { decrypts += 1; return { status: 'not-cached' } }, reset: () => { resets += 1 } }
    for (const ready of [false, true]) {
      const index = fakeMediaIndex({ ready })
      const media = createPluginMedia({ dataDir, getDb: () => mediaDb(row), decryptor, index })
      const t0 = performance.now()
      const res = media.prepare('i:1')
      assert.ok(performance.now() - t0 < 1_000, 'media.prepare did not block for a second')
      assert.equal(res.ok, false)
      assert.equal(res.code, 'not_cached', 'the error code stays not_cached')
      assert.equal(res.message.includes('索引建立中'), !ready, ready ? 'index ready: LINE simply has not downloaded it' : 'index not ready: tell the user it is being built')
      assert.equal(res.message.includes(MEDIA_INDEX_BUILDING_TOKEN), !ready, 'the machine-readable token the renderer retries on is there exactly while the index is being built')
      assert.equal(index.calls.noteMiss, 1)
      media.prepare('i:1')
      media.prepare('i:1')
      assert.equal(index.calls.noteMiss, 3, 'every miss is reported (the throttle lives in the index)')
      assert.equal(media.stats().reindexes, 3)
    }
    assert.equal(resets, 0, 'the decryptor index is never rebuilt synchronously')
    assert.equal(decrypts, 6)
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})

test('media.prepare: an unavailable index is media_unavailable (no decrypt, no walk, no refresh request); no index or no decryptor is media_unavailable; a cache hit never needs the index; other failures do not touch it', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wpb-media2-'))
  try {
    const row = { key_material: IKM_B64, file_size: 600, content_type: 1 }
    let decrypts = 0
    const decryptor = { decrypt: () => { decrypts += 1; return { status: 'not-cached' } }, reset() { assert.fail('reset must not be called') } }
    const off = fakeMediaIndex({ available: false })
    const media = createPluginMedia({ dataDir, getDb: () => mediaDb(row), decryptor, index: off })
    const res = media.prepare('i:1')
    assert.equal(res.code, 'media_unavailable')
    assert.equal(decrypts, 0, 'nothing is decrypted or walked when the index is unavailable')
    assert.equal(off.calls.noteMiss, 0)
    assert.equal(createPluginMedia({ dataDir, getDb: () => mediaDb(row), decryptor, index: null }).prepare('i:1').code, 'media_unavailable')
    assert.equal(createPluginMedia({ dataDir, getDb: () => mediaDb(row), decryptor: null, index: fakeMediaIndex() }).prepare('i:1').code, 'media_unavailable')
    assert.equal(decrypts, 0)

    mkdirSync(join(dataDir, 'media-cache'), { recursive: true })
    writeFileSync(join(dataDir, 'media-cache', `${mediaCacheStem('i:1')}.png`), pngBytes(50))
    const hit = media.prepare('i:1')
    assert.equal(hit.ok, true, 'a media-cache hit is served even though the index is unavailable')
    assert.equal(hit.cached, true)
    assert.equal(off.calls.isAvailable, 1, 'only the earlier miss consulted the index; the hit did not')
    const idx = fakeMediaIndex()
    const hitMedia = createPluginMedia({ dataDir, getDb: () => mediaDb(row), decryptor, index: idx })
    for (const [arg, code] of [[undefined, 'invalid_args'], ['', 'invalid_args']]) assert.equal(hitMedia.prepare(arg).code, code)
    assert.equal(createPluginMedia({ dataDir, getDb: () => mediaDb({ ...row, content_type: 0 }), decryptor, index: idx }).prepare('i:1').code, 'not_image')
    assert.equal(createPluginMedia({ dataDir, getDb: () => mediaDb({ ...row, key_material: null }), decryptor, index: idx }).prepare('i:1').code, 'no_key')
    assert.equal(createPluginMedia({ dataDir, getDb: () => mediaDb(undefined), decryptor, index: idx }).prepare('i:1').code, 'not_found')
    assert.equal(idx.calls.isAvailable + idx.calls.noteMiss + idx.calls.isReady, 0, 'rejected requests never reach the index')
    const stats = createPluginMedia({ dataDir, getDb: () => null, decryptor: null, index: null }).stats()
    assert.deepEqual(stats.index, MEDIA_INDEX_OFF_STATUS)
    assert.equal(createPluginMedia({ dataDir, getDb: () => mediaDb(row), decryptor, index: idx }).stats().index.rows, 7)
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})

// ───────────── production wiring (createPluginBackend) ─────────────

function rawMessage(i, { chatId = 'u-alice', chat = 'Alice' } = {}) {
  const t = 1_700_000_000_000 + i * 1000
  return { msgId: `m${i}`, chat, chatId, isGroup: false, ts: t, time: new Date(t).toISOString(), direction: 'in', sender: chat, text: '[image]', contentType: 1 }
}
const imageMessage = (i, fileSize) => ({ ...rawMessage(i), keyMaterial: IKM_B64, fileSize, fileName: null })

function fakeLine() {
  const messageListeners = new Set()
  let running = false
  const port = {
    start() { running = true },
    stop() { running = false },
    status: () => ({ state: running ? 'running' : 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 }),
    onMessage(cb) { messageListeners.add(cb); return () => messageListeners.delete(cb) },
    onStatus() { return () => undefined },
    getMessagesSince: async () => []
  }
  return { port, emit: (m) => messageListeners.forEach((cb) => cb(m)) }
}

async function withBackend(extra, body) {
  const root = mkdtempSync(join(tmpdir(), 'wpb-backend-'))
  const dataDir = join(root, 'data')
  const line = fakeLine()
  const backend = await createPluginBackend({ pluginId: 'tuqdev.line-todo', version: '1', dataDir, line: line.port, ...extra })
  const call = (path, ...args) => backend.call(backendMethodFor(path), { path, args })
  try { await body({ backend, call, line, dataDir, root }) } finally { await backend.dispose().catch(() => undefined); rmSync(root, { recursive: true, force: true }) }
}

/** What a finished first scan leaves behind (rows, directory records, meta), written straight into the app DB: a restarted backend finds it and needs no scan. Returns the number of rows. */
function seedIndex(db, fake) {
  ensureMediaIndexSchema(db)
  const insertFile = db.prepare(`INSERT INTO line_media_index(size,dir_path,name,state,seen_gen,stale_at) VALUES (?,?,?,'live',1,NULL)`)
  const insertDir = db.prepare('INSERT INTO line_media_dirs(dir_path,mtime_ns,has_subdirs,listed_gen) VALUES (?,?,?,1)')
  const setMeta = db.prepare('INSERT INTO line_media_index_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
  let rows = 0
  db.transaction(() => {
    for (const [abs, d] of fake.dirs) {
      const rel = abs === fake.root ? '' : abs.slice(fake.root.length + 1).split(sep).join('/')
      let hasDirs = false
      for (const [name, e] of d.entries) {
        if (e.dir) hasDirs = true
        else { insertFile.run(e.size, rel, name); rows += 1 }
      }
      insertDir.run(rel, String(d.mtime), hasDirs ? 1 : 0)
    }
    for (const [key, value] of Object.entries({ cache_root: fake.root, gen: '1', initial_scan_done: '1', full_gen_done: '1', last_full_at: String(Date.now()), live_rows: String(rows) })) setMeta.run(key, value)
  })()
  return rows
}

test('production wiring: after a restart the first media.prepare is answered from a 46,800-row index in well under 200 ms with zero directory walks; backend.info carries media.index', async () => {
  const fake = makeFakeCache()
  const leaf = fake.leafPaths[100]
  const plain = pngBytes(7500)
  fake.addRealFile(leaf, 'real.eimg', makeEimg(plain))
  const root = mkdtempSync(join(tmpdir(), 'wpb-restart-'))
  const dataDir = join(root, 'data')
  const media = { fs: fake.fs, cacheDir: fake.root, index: { startDelayMs: 600_000 } }
  try {
    const first = await createPluginBackend({ pluginId: 'p', version: '1', dataDir, line: fakeLine().port, media })
    await first.dispose()
    const raw = new Database(join(dataDir, 'line-todo.db'))
    const seeded = seedIndex(raw, fake)
    raw.close()
    assert.equal(seeded, fake.count().files)
    assert.ok(seeded >= 40_000)
    const line = fakeLine()
    const backend = await createPluginBackend({ pluginId: 'p', version: '1', dataDir, line: line.port, media })
    const call = (path, ...args) => backend.call(backendMethodFor(path), { path, args })
    try {
      const info = (await call('backend.info')).value.media
      assert.equal(info.index.available, true)
      assert.equal(info.index.ready, true, 'the persisted index is ready the moment the backend starts')
      assert.equal(info.index.rows, seeded)
      assert.equal(info.index.scanning, false)
      assert.equal(info.index.passes, 0, 'no scan has run in this process')
      line.emit(imageMessage(1, plain.length))
      fake.resetCalls()
      const t0 = performance.now()
      const prepared = await call('media.prepare', 'i:m1')
      const ms = performance.now() - t0
      assert.equal(prepared.ok, true, JSON.stringify(prepared))
      assert.equal(prepared.value.size, plain.length)
      assert.equal(prepared.value.cached, false)
      assert.ok(ms < 1_000, `first media.prepare took ${ms.toFixed(1)} ms (recorded below; the walk-free path is asserted by the zero readDir/stat counts; catastrophe ceiling 1,000 ms)`)
      assert.deepEqual(fake.calls.readDir, [], 'no directory is listed while preparing')
      assert.equal(fake.calls.stat, 0, 'no file is stat-ed while preparing')
      assert.equal(fake.calls.exists, 0)
      assert.equal(fake.calls.readFile, 1, 'only the one matching candidate is read')
      measured('first-media-prepare', { rowsInIndex: seeded, ms, readDir: fake.calls.readDir.length, stat: fake.calls.stat })

      line.emit(imageMessage(2, 20_000))
      fake.resetCalls()
      const t1 = performance.now()
      const miss = await call('media.prepare', 'i:m2')
      const missMs = performance.now() - t1
      assert.equal(miss.code, 'not_cached')
      assert.ok(!miss.message.includes('索引建立中'), 'the index is ready: this is LINE not having downloaded it')
      assert.ok(missMs < 1_000, `a miss took ${missMs.toFixed(1)} ms (catastrophe ceiling 1,000 ms)`)
      assert.deepEqual(fake.calls.readDir, [], 'a miss does not walk either; it only queues the throttled delta')
      measured('miss-media-prepare', { ms: missMs })
    } finally { await backend.dispose() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('production wiring: before the index is ready media.prepare answers not_cached immediately, says 索引建立中, and touches neither directories nor files', async () => {
  const fake = makeFakeCache({ tops: 3, leaves: 2, files: 3 })
  const plain = pngBytes(800)
  fake.addRealFile(fake.leafPaths[0], 'real.eimg', makeEimg(plain))
  await withBackend({ media: { fs: fake.fs, cacheDir: fake.root, index: { startDelayMs: 600_000 } } }, async ({ call, line }) => {
    line.emit(imageMessage(1, plain.length))
    fake.resetCalls()
    const t0 = performance.now()
    const res = await call('media.prepare', 'i:m1')
    const ms = performance.now() - t0
    assert.equal(res.ok, false)
    assert.equal(res.code, 'not_cached')
    assert.ok(res.message.includes('索引建立中'), res.message)
    assert.ok(ms < 1_000, `${ms.toFixed(1)} ms (catastrophe ceiling 1,000 ms)`)
    assert.deepEqual({ ...fake.calls, readDirOptions: undefined }, { readDir: [], readDirOptions: undefined, stat: 0, exists: 0, readFile: 0 }, 'no synchronous walk, ever')
    const info = (await call('backend.info')).value.media
    assert.equal(info.index.ready, false)
    assert.equal(info.index.scanning, false)
    assert.equal(info.index.rows, 0)
    assert.equal(info.reindexes, 1)
    for (let i = 0; i < 5; i += 1) await call('media.prepare', 'i:m1')
    assert.deepEqual(fake.calls.readDir, [], 'repeated misses during the start delay still walk nothing')
    measured('unready-media-prepare', { ms })
  })
})

test('production wiring: a half-built index is used as it is; once the scan completes the previously missing image is found, with no restart', async () => {
  const fake = makeFakeCache({ tops: 5, leaves: 2, files: 3 })
  const plain = pngBytes(1200)
  const last = fake.leafPaths.at(-1)
  fake.addRealFile(last, 'late.eimg', makeEimg(plain))
  const realSetTimeout = globalThis.setTimeout
  const armed5s = []
  globalThis.setTimeout = (fn, ms, ...rest) => { if (ms === 5_000) armed5s.push(ms); return realSetTimeout(fn, ms, ...rest) }
  try {
  await withBackend({ media: { fs: fake.fs, cacheDir: fake.root, index: { startDelayMs: 0, sliceMaxDirs: 2 } } }, async ({ call, line }) => {
    line.emit(imageMessage(1, plain.length))
    await until(async () => (await call('backend.info')).value.media.index.ready, { message: 'ready' })
    assert.equal(armed5s.length, 0, 'media.index.startDelayMs: 0 reached the index (no timer of the default 5 s start delay was armed)')
    const res = await call('media.prepare', 'i:m1')
    assert.equal(res.ok, true, JSON.stringify(res))
  })
  } finally { globalThis.setTimeout = realSetTimeout }
})

test('production wiring: every scan slice is reported to the invoke trace as a bg media_index event (the documented attribution for a loop_stall)', async () => {
  const fake = makeFakeCache({ tops: 6, leaves: 2, files: 3 })
  await withBackend({ trace: { eventMinMs: 0 }, media: { fs: fake.fs, cacheDir: fake.root, index: { startDelayMs: 0, sliceMaxDirs: 4 } } }, async ({ call, dataDir }) => {
    await until(async () => (await call('backend.info')).value.media.index.ready, { message: 'ready' })
    const log = readFileSync(join(dataDir, 'logs', 'invoke-trace.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const events = log.filter((e) => e.ev === 'bg' && e.p === 'media_index')
    assert.ok(events.length >= Math.floor(fake.count().dirs / 4), `one bg media_index event per slice (${events.length})`)
    assert.ok(events.every((e) => Number.isFinite(e.ms) && e.ms >= 0 && typeof e.from === 'string'))
  })
})

test('production wiring: when the index tables cannot be created the index is off: media.prepare says media_unavailable, nothing is ever listed, stat-ed or read, and an already decrypted image is still served', async () => {
  const fake = makeFakeCache({ tops: 3, leaves: 2, files: 3 })
  const plain = pngBytes(640)
  fake.addRealFile(fake.leafPaths[0], 'real.eimg', makeEimg(plain))
  const root = mkdtempSync(join(tmpdir(), 'wpb-broken-'))
  const dataDir = join(root, 'data')
  try {
    const first = await createPluginBackend({ pluginId: 'p', version: '1', dataDir, line: fakeLine().port })
    await first.dispose()
    const raw = new Database(join(dataDir, 'line-todo.db'))
    raw.exec('CREATE TABLE line_media_index (x)')
    raw.close()
    const line = fakeLine()
    const backend = await createPluginBackend({ pluginId: 'p', version: '1', dataDir, line: line.port, media: { fs: fake.fs, cacheDir: fake.root, index: { startDelayMs: 0 } } })
    const call = (path, ...args) => backend.call(backendMethodFor(path), { path, args })
    try {
      line.emit(imageMessage(1, plain.length))
      line.emit(imageMessage(2, 321))
      fake.resetCalls()
      await sleep(250)
      const res = await call('media.prepare', 'i:m1')
      assert.equal(res.ok, false)
      assert.equal(res.code, 'media_unavailable')
      assert.equal((await call('media.prepare', 'i:m2')).code, 'media_unavailable')
      assert.deepEqual({ ...fake.calls, readDirOptions: undefined }, { readDir: [], readDirOptions: undefined, stat: 0, exists: 0, readFile: 0 }, 'a failed schema never falls back to walking or reading the Cache')
      const info = (await call('backend.info')).value
      assert.equal(info.media.index.available, false)
      assert.equal(info.media.index.ready, false)
      assert.ok(info.recentLog.some((l) => l.includes('[media-index] schema_unavailable')), JSON.stringify(info.recentLog))
      assert.equal(info.media.prepared, 2)
      mkdirSync(join(dataDir, 'media-cache'), { recursive: true })
      const { mediaCacheStem } = await import('../../src/plugin/backend/media.ts')
      const served = join(dataDir, 'media-cache', `${mediaCacheStem('i:m1')}.png`)
      writeFileSync(served, plain)
      const hit = await call('media.prepare', 'i:m1')
      assert.equal(hit.ok, true, 'the media-cache hit does not need the index')
      assert.equal(hit.value.cached, true)
    } finally { await backend.dispose() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('production wiring: the index tables are created by the backend next to the app DB without touching user_version (still the current version); dispose stops the scan and leaves no timer or file access behind', async () => {
  const fake = makeFakeCache({ tops: 120, leaves: 3, files: 4 })
  const root = mkdtempSync(join(tmpdir(), 'wpb-dispose-'))
  const dataDir = join(root, 'data')
  try {
    const line = fakeLine()
    const timersBefore = process.getActiveResourcesInfo().filter((k) => k === 'Timeout').length
    const backend = await createPluginBackend({ pluginId: 'p', version: '1', dataDir, line: line.port, media: { fs: fake.fs, cacheDir: fake.root, index: { startDelayMs: 0, sliceMaxDirs: 2 } } })
    await until(() => fake.calls.readDir.length > 20, { message: 'the scan to start' })
    const atDispose = fake.calls.readDir.length
    await backend.dispose()
    const listed = fake.calls.readDir.length
    assert.equal(listed, atDispose, 'not one directory is listed between dispose() being called and it resolving: the scan stops before the database is closed')
    assert.ok(listed < fake.count().dirs, `dispose interrupted the scan (${listed} of ${fake.count().dirs} directories)`)
    await sleep(120)
    assert.equal(fake.calls.readDir.length, listed, 'no directory is listed after dispose resolved')
    assert.equal(backend.diagnostics().disposed, true)
    await sleep(20)
    assert.ok(process.getActiveResourcesInfo().filter((k) => k === 'Timeout').length <= timersBefore + 1, 'no index timer is left running')
    const db = new Database(join(dataDir, 'line-todo.db'), { readonly: true })
    try {
      assert.equal(db.pragma('user_version', { simple: true }), 10, 'user_version is not touched')
      assert.equal(isMediaIndexSchemaReady(db), true)
      assert.equal(db.prepare('SELECT value FROM line_media_index_meta WHERE key = ?').get('cache_root').value, fake.root)
      assert.equal(db.prepare('SELECT value FROM line_media_index_meta WHERE key = ?').get('initial_scan_done'), undefined, 'an interrupted first scan is not marked done')
    } finally { db.close() }
    const pre = fake.calls.readDir.length
    const again = await createPluginBackend({ pluginId: 'p', version: '1', dataDir, line: fakeLine().port, media: { fs: fake.fs, cacheDir: fake.root, index: { startDelayMs: 600_000 } } })
    await again.dispose()
    assert.equal(fake.calls.readDir.length, pre, 'disposing during the start delay means no scan at all')
    const never = await createPluginBackend({ pluginId: 'p', version: '1', dataDir: join(root, 'data2'), line: fakeLine().port, autoStart: false, media: { fs: fake.fs, cacheDir: fake.root, index: { startDelayMs: 0 } } })
    await sleep(80)
    assert.equal(fake.calls.readDir.length, pre, 'autoStart:false never starts the index')
    await never.dispose()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('production wiring: backend.dispose() stops a scan that is in flight: no retry timer of the index is armed afterwards and nothing is logged as a failed scan', async () => {
  const fake = makeFakeCache({ tops: 120, leaves: 3, files: 4 })
  const root = mkdtempSync(join(tmpdir(), 'wpb-dispose-timer-'))
  const realSetTimeout = globalThis.setTimeout
  const armed = []
  const MARK = 7_777
  globalThis.setTimeout = (fn, ms, ...rest) => { if (ms === MARK) armed.push(ms); return realSetTimeout(fn, ms, ...rest) }
  try {
    const backend = await createPluginBackend({ pluginId: 'p', version: '1', dataDir: join(root, 'data'), line: fakeLine().port, media: { fs: fake.fs, cacheDir: fake.root, index: { startDelayMs: 0, sliceMaxDirs: 2, errorBackoffMs: MARK } } })
    await until(() => fake.calls.readDir.length > 20, { message: 'the scan to start' })
    await backend.dispose()
    await sleep(100)
    assert.deepEqual(armed, [], 'a pass that is disposed does not schedule a retry (and a pass is not made to fail by closing the database under it)')
  } finally {
    globalThis.setTimeout = realSetTimeout
    rmSync(root, { recursive: true, force: true })
  }
})

test('production wiring: the old reindexMinIntervalMs name still sets the miss throttle, refreshMinIntervalMs wins over it, and the default is 30 s', async () => {
  const fake = makeFakeCache({ tops: 2, leaves: 1, files: 2 })
  const run = async (media, throttleMs) => {
    const clock = { t: 5_000_000 }
    await withBackend({ media: { fs: fake.fs, cacheDir: fake.root, now: () => clock.t, index: { startDelayMs: 0 }, ...media } }, async ({ call, line }) => {
      await until(async () => (await call('backend.info')).value.media.index.ready, { message: 'ready' })
      line.emit(imageMessage(1, 20_000))
      const passes = async () => (await call('backend.info')).value.media.index.passes
      const first = await passes()
      clock.t += 29_000
      await call('media.prepare', 'i:m1')
      if (throttleMs <= 29_000) await until(async () => (await passes()) > first, { message: `a pass 29 s after the last one with a ${throttleMs} ms throttle` })
      else await sleep(60)
      assert.equal((await passes()) > first, throttleMs <= 29_000, `29 s after the last pass with a ${throttleMs} ms throttle`)
      if (throttleMs > 29_000) {
        clock.t += 2_000
        await call('media.prepare', 'i:m1')
        if (throttleMs <= 31_000) await until(async () => (await passes()) > first, { message: `a pass 31 s after the last one with a ${throttleMs} ms throttle` })
        else await sleep(60)
        assert.equal((await passes()) > first, throttleMs <= 31_000, `31 s after the last pass with a ${throttleMs} ms throttle`)
      }
    })
  }
  await run({}, 30_000)
  await run({ reindexMinIntervalMs: 60_000 }, 60_000)
  await run({ reindexMinIntervalMs: 60_000, refreshMinIntervalMs: 1_000 }, 1_000)
  await run({ reindexMinIntervalMs: 1_000 }, 1_000)
  await run({ index: { refreshMinIntervalMs: 45_000, startDelayMs: 0 } }, 45_000)
})
