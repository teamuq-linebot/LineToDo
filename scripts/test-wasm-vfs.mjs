// Phase 1 — unit tests for the read-only node:fs VFS, the WASM engine contract and the int64 rules.
// Hermetic: plain Node 24 only (no Electron, no native sqlite). Plain DBs are written with node:sqlite; the encrypted
// cross-engine tests live in test-wasm-linedb.mjs and the 1.6.8/Electron 44 contract test in test-wasm-contract.mjs.
//
// Guards (acceptance criteria):
//   * BigInt offset trap: the WASM passes i64 offsets as BigInt; every position handed to fs.readSync must be a Number.
//     A BigInt-hostile fs wrapper throws on a BigInt position, so a regression fails loudly here.
//   * read-only: files are opened O_RDONLY only, never modified, writes fail, a missing file is never created.
//   * WAL: -wal frames are read without a usable on-disk -shm; a missing -wal is treated as empty; rollback DBs read.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { createWasmSqliteCipherEngine } from '../src/main/line/engine/wasmSqliteCipherEngine.ts'
import { toFsPosition } from '../src/main/line/engine/wasm/nodeFsReadOnlyVfs.ts'
import { applyInt64Mode, legacyStandaloneMsgId, normalizeMsgId, toSafeNumber } from '../src/main/line/engine/wasm/int64.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WASM_DIR = join(ROOT, 'vendor', 'sqlite3mc-wasm')
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

function withTemp(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const done = () => rmSync(dir, { recursive: true, force: true })
  try {
    const r = fn(dir)
    if (r && typeof r.then === 'function') return r.finally(done)
    done()
    return r
  } catch (e) {
    done()
    throw e
  }
}

/** A BigInt-hostile fs: throws if a position is not a Number (the trap), records every call. No write methods exist. */
function hostileFs() {
  const calls = { reads: [], opens: [], fstats: 0, closes: 0, stats: 0 }
  const fs = {
    constants: { O_RDONLY: nodeFs.constants.O_RDONLY },
    openSync(path, flags) {
      calls.opens.push({ path, flags })
      return nodeFs.openSync(path, flags)
    },
    readSync(fd, buffer, offset, length, position) {
      if (typeof position !== 'number') throw new TypeError(`BigInt-hostile fs: position must be a Number, got ${typeof position}`)
      if (!Number.isSafeInteger(position) || position < 0) throw new RangeError(`bad position ${position}`)
      calls.reads.push({ position, length })
      return nodeFs.readSync(fd, buffer, offset, length, position)
    },
    fstatSync(fd, options) {
      calls.fstats++
      return nodeFs.fstatSync(fd, options)
    },
    closeSync(fd) {
      calls.closes++
      return nodeFs.closeSync(fd)
    },
    statSync(path, options) {
      calls.stats++
      return nodeFs.statSync(path, options)
    },
  }
  return { fs, calls }
}

/**
 * Plain (unencrypted) fixtures in `dir`:
 *   wal/m.edb(+-wal,-shm): 1000 rows checkpointed, 200 more only in -wal, copied while the writer is open
 *   wal-checkpointed/m.edb: WAL-mode header, but -wal/-shm gone (writer closed after TRUNCATE checkpoint)
 *   rollback/m.edb: journal_mode=DELETE, 1000 rows
 */
function makePlainFixtures(dir) {
  const rows = (db, from, n) => {
    const ins = db.prepare('INSERT INTO t(id, big, txt) VALUES (?,?,?)')
    db.exec('BEGIN')
    for (let i = from; i < from + n; i++) ins.run(i, 500000000000000000n + BigInt(i), `row-${i}-${'x'.repeat(i % 50)}`)
    db.exec('COMMIT')
  }
  const make = (sub, journal) => {
    const d = join(dir, sub)
    mkdirSync(d, { recursive: true })
    const file = join(d, 'live.edb')
    const db = new DatabaseSync(file)
    db.exec(`PRAGMA journal_mode=${journal}`)
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, big INTEGER, txt TEXT)')
    return { d, file, db }
  }
  // WAL with frames only in the -wal
  {
    const { d, file, db } = make('wal', 'WAL')
    db.exec('PRAGMA wal_autocheckpoint=0')
    rows(db, 0, 1000)
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    rows(db, 1000, 200)
    for (const ext of ['', '-wal', '-shm']) copyFileSync(file + ext, join(d, 'm.edb' + ext))
    db.close()
    rmSync(file + '', { force: true })
  }
  // WAL header but no -wal at all
  {
    const { d, file, db } = make('wal-checkpointed', 'WAL')
    rows(db, 0, 1000)
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.close()
    copyFileSync(file, join(d, 'm.edb'))
  }
  // rollback journal
  {
    const { d, file, db } = make('rollback', 'DELETE')
    rows(db, 0, 1000)
    db.close()
    copyFileSync(file, join(d, 'm.edb'))
  }
  return {
    wal: join(dir, 'wal', 'm.edb'),
    walCheckpointed: join(dir, 'wal-checkpointed', 'm.edb'),
    rollback: join(dir, 'rollback', 'm.edb'),
  }
}

async function withShared(fn) {
  return fn(fixtures())
}

// Fixtures are built once and shared (no test modifies them; the mutating -shm test works on a copy).
let sharedDir = null
let sharedFixtures = null
function fixtures() {
  if (!sharedFixtures) {
    sharedDir = mkdtempSync(join(tmpdir(), 'wvfs-shared-'))
    sharedFixtures = makePlainFixtures(sharedDir)
  }
  return sharedFixtures
}
test.after(() => {
  if (sharedDir) rmSync(sharedDir, { recursive: true, force: true })
})

const countOf = (h) => h.prepare('SELECT count(*) AS c FROM t').get().c

// ─────────────────────────────────────────────────────────────────────────────

test('vendored SQLite3MultipleCiphers WASM files match PROVENANCE.json (byte-for-byte, not rewritten by autocrlf)', () => {
  const prov = JSON.parse(readFileSync(join(WASM_DIR, 'PROVENANCE.json'), 'utf8'))
  assert.equal(prov.version, '2.5.1')
  for (const [file, expected] of Object.entries(prov.files)) assert.equal(sha256(join(WASM_DIR, file)), expected, file)
})

test('BigInt offset guard: toFsPosition always yields a Number, rejects unsafe / negative offsets', () => {
  assert.equal(toFsPosition(0n), 0)
  assert.equal(toFsPosition(4096n), 4096)
  assert.equal(typeof toFsPosition(4096n), 'number')
  assert.equal(toFsPosition(2 ** 32 + 7), 2 ** 32 + 7)
  assert.equal(toFsPosition(BigInt(2 ** 40)), 2 ** 40) // > 4 GiB offsets stay exact
  assert.equal(toFsPosition(BigInt(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER)
  assert.throws(() => toFsPosition(BigInt(Number.MAX_SAFE_INTEGER) + 1n), RangeError)
  assert.throws(() => toFsPosition(-1n), RangeError)
  assert.throws(() => toFsPosition(-1), RangeError)
  assert.throws(() => toFsPosition(1.5), RangeError)
  assert.throws(() => toFsPosition(Number.NaN), RangeError)
})

test('BigInt offset guard: every fs.readSync position the VFS issues is a Number (BigInt-hostile fs wrapper)', async () => {
  await withShared(async (fx) => {
    // self-test of the trap detector itself
    const probe = hostileFs()
    const fd = probe.fs.openSync(fx.rollback, probe.fs.constants.O_RDONLY)
    assert.throws(() => probe.fs.readSync(fd, Buffer.alloc(4), 0, 4, 16n), /position must be a Number/)
    nodeFs.closeSync(fd)

    const { fs, calls } = hostileFs()
    const engine = await createWasmSqliteCipherEngine({ wasmDir: WASM_DIR, vfsFs: fs })
    for (const p of [fx.wal, fx.rollback, fx.walCheckpointed]) {
      const h = engine.open(p)
      assert.ok(countOf(h) >= 1000)
      h.close()
    }
    assert.ok(calls.reads.length > 20, 'the VFS must have issued many reads')
    assert.ok(calls.reads.every((r) => typeof r.position === 'number' && Number.isInteger(r.position)))
    // page reads land on page boundaries (4096 default), i.e. the Number conversion kept the exact offset
    assert.ok(calls.reads.some((r) => r.position > 0 && r.position % 4096 === 0))
  })
})

test('read-only: files are opened O_RDONLY only, never modified, SQL writes fail, RW-flag opens are downgraded', async () => {
  await withShared(async (fx) => {
    const before = Object.fromEntries(['', '-wal', '-shm'].map((e) => [e, existsSync(fx.wal + e) ? sha256(fx.wal + e) : null]))
    const { fs, calls } = hostileFs()
    const engine = await createWasmSqliteCipherEngine({ wasmDir: WASM_DIR, vfsFs: fs })

    const h = engine.open(fx.wal)
    assert.equal(countOf(h), 1200)
    // writes: SQLite itself refuses on a read-only connection (before any VFS write is attempted)
    assert.throws(() => h.prepare("INSERT INTO t(id, big, txt) VALUES (9999, 1, 'x')").get(), /readonly|READONLY/i)
    assert.throws(() => h.pragma('user_version=5'), /readonly|READONLY/i)
    h.close()

    // a connection that ASKS for read-write through the raw API is still read-only (xOpen downgrades via pOutFlags)
    const raw = new engine.sqlite3.oo1.DB({ filename: fx.wal, flags: 'w', vfs: engine.vfs.vfsName })
    assert.throws(() => raw.exec('CREATE TABLE nope(a)'), /readonly|READONLY/i)
    assert.equal(raw.selectValue('SELECT count(*) FROM t'), 1200)
    raw.close()

    assert.ok(calls.opens.length > 0)
    assert.ok(calls.opens.every((o) => o.flags === nodeFs.constants.O_RDONLY), 'every open must be O_RDONLY')
    assert.equal(engine.vfs.stats.rejectedWrites, 0)
    const after = Object.fromEntries(['', '-wal', '-shm'].map((e) => [e, existsSync(fx.wal + e) ? sha256(fx.wal + e) : null]))
    assert.deepEqual(after, before, 'main/-wal/-shm bytes must be untouched')
    assert.deepEqual(readdirSync(dirname(fx.wal)).sort(), ['m.edb', 'm.edb-shm', 'm.edb-wal'], 'no journal/temp file may appear')
  })
})

test('read-only: opening a missing file fails (CANTOPEN) and never creates it', async () => {
  await withTemp('wvfs-missing-', async (dir) => {
    const engine = await createWasmSqliteCipherEngine({ wasmDir: WASM_DIR })
    const missing = join(dir, 'does-not-exist.edb')
    assert.throws(() => engine.open(missing), /CANTOPEN|unable to open/i)
    assert.equal(existsSync(missing), false)
    assert.equal(existsSync(missing + '-wal'), false)
    assert.equal(engine.openConnections(), 0)
    assert.equal(engine.vfs.openFiles(), 0)
  })
})

test('WAL: frames that exist only in -wal are read; the on-disk -shm is ignored (garbage -shm cannot corrupt reads)', async () => {
  await withTemp('wvfs-wal-', async (dir) => {
    const fx = makePlainFixtures(dir)
    const engine = await createWasmSqliteCipherEngine({ wasmDir: WASM_DIR })
    const h = engine.open(fx.wal)
    assert.equal(countOf(h), 1200, '1000 checkpointed + 200 WAL-only rows')
    assert.equal(h.prepare('SELECT max(id) AS m FROM t').get().m, 1199)
    h.close()
    // replace the -shm with garbage and drop the file entirely: results must not change
    writeFileSync(fx.wal + '-shm', Buffer.alloc(32768, 0xab))
    let h2 = engine.open(fx.wal)
    assert.equal(countOf(h2), 1200)
    h2.close()
    rmSync(fx.wal + '-shm')
    h2 = engine.open(fx.wal)
    assert.equal(countOf(h2), 1200)
    h2.close()
    assert.equal(engine.vfs.openFiles(), 0)
    assert.equal(engine.vfs.shmNodes(), 0)
  })
})

test('WAL header without any -wal file reads as an empty log; rollback-journal DB reads', async () => {
  await withShared(async (fx) => {
    const engine = await createWasmSqliteCipherEngine({ wasmDir: WASM_DIR })
    assert.equal(existsSync(fx.walCheckpointed + '-wal'), false)
    const a = engine.open(fx.walCheckpointed)
    assert.equal(countOf(a), 1000)
    assert.equal(a.prepare('SELECT txt FROM t WHERE id=7').get().txt, 'row-7-xxxxxxx')
    a.close()
    const b = engine.open(fx.rollback)
    assert.equal(countOf(b), 1000)
    b.close()
    assert.equal(existsSync(fx.walCheckpointed + '-wal'), false, 'the VFS must not create a -wal')
    assert.equal(engine.vfs.openFiles(), 0)
  })
})

test('several connections on the same snapshot share one in-process wal-index and release it on close', async () => {
  await withShared(async (fx) => {
    const engine = await createWasmSqliteCipherEngine({ wasmDir: WASM_DIR })
    const a = engine.open(fx.wal)
    const b = engine.open(fx.wal)
    const c = engine.open(fx.rollback)
    assert.equal(engine.openConnections(), 3)
    assert.equal(countOf(a), 1200)
    assert.equal(countOf(b), 1200)
    assert.equal(countOf(c), 1000)
    assert.equal(engine.vfs.shmNodes(), 1, 'a and b share one wal-index node; the rollback DB has none')
    a.close()
    assert.equal(countOf(b), 1200)
    b.close()
    c.close()
    assert.equal(engine.openConnections(), 0)
    assert.equal(engine.vfs.openFiles(), 0)
    assert.equal(engine.vfs.shmNodes(), 0)
  })
})

test('the cipher layer sits on top of the node:fs VFS (sqlite3mc_vfs_create wrapper), and MEMFS is not used', async () => {
  const engine = await createWasmSqliteCipherEngine({ wasmDir: WASM_DIR })
  assert.match(engine.vfs.rawName, /^nodefs-ro(-\d+)?$/)
  assert.equal(engine.vfs.vfsName, 'multipleciphers-' + engine.vfs.rawName)
  assert.ok(engine.sqlite3.capi.sqlite3_vfs_find(engine.vfs.vfsName))
  assert.match(engine.info.sqlite3mc, /2\.5\.1/)
  assert.equal(engine.info.vfs, engine.vfs.vfsName)
  assert.equal(engine.name, 'sqlite3mc-wasm+nodefs-ro-vfs')
})

test('engine handle contract: prepare()/get()/all()/pragma()/close() behave like the better-sqlite3 subset linedb uses', async () => {
  await withShared(async (fx) => {
    const engine = await createWasmSqliteCipherEngine({ wasmDir: WASM_DIR })
    const h = engine.open(fx.rollback)
    // prepare() validates SQL eagerly (lineOrder.ts relies on a missing table throwing at prepare time)
    assert.throws(() => h.prepare('SELECT _name FROM _squareChat WHERE _squareChatMid = ?'), /no such table/i)
    // get() -> undefined when there is no row; all() -> []
    assert.equal(h.prepare('SELECT id FROM t WHERE id = ?').get(123456), undefined)
    assert.deepEqual(h.prepare('SELECT id FROM t WHERE id = ?').all(123456), [])
    // positional params, string / number binding, column aliases as keys
    assert.deepEqual(h.prepare('SELECT id AS i, txt FROM t WHERE id = ? AND txt LIKE ?').get(3, 'row-3-%'), { i: 3, txt: 'row-3-xxx' })
    assert.deepEqual(h.prepare('SELECT id FROM t ORDER BY id DESC LIMIT ?').all(2), [{ id: 999 }, { id: 998 }])
    // a statement object can be reused (lineOrder's squareStmt pattern)
    const st = h.prepare('SELECT txt FROM t WHERE id = ?')
    assert.equal(st.get(1).txt, 'row-1-x')
    assert.equal(st.get(2).txt, 'row-2-xx')
    // pragma() returns rows; wal_checkpoint is a no-op on the read-only engine (does not throw, writes nothing)
    assert.deepEqual(h.pragma('wal_checkpoint(TRUNCATE)'), [])
    assert.ok(Array.isArray(h.pragma('page_size')))
    assert.equal(h.pragma('page_size')[0].page_size, 4096)
    h.close()
    assert.doesNotThrow(() => h.close(), 'close() is idempotent')
    assert.throws(() => h.prepare('SELECT 1'), /closed/)
    assert.equal(engine.openConnections(), 0)
  })
})

test('int64 modes: exact keeps BigInt beyond 2^53, legacy-number matches standalone (lossy Number)', async () => {
  await withShared(async (fx) => {
    const exact = await createWasmSqliteCipherEngine({ wasmDir: WASM_DIR, int64: 'exact' })
    const legacy = await createWasmSqliteCipherEngine({ wasmDir: WASM_DIR, int64: 'legacy-number' })
    const sql = 'SELECT id, big FROM t WHERE id IN (0, 1, 2, 63) ORDER BY id'
    const he = exact.open(fx.rollback)
    const hl = legacy.open(fx.rollback)
    const re = he.prepare(sql).all()
    const rl = hl.prepare(sql).all()
    assert.deepEqual(re.map((r) => typeof r.id), ['number', 'number', 'number', 'number'], 'safe ints stay Number in both modes')
    assert.deepEqual(re.map((r) => r.big), [500000000000000000n, 500000000000000001n, 500000000000000002n, 500000000000000063n])
    assert.deepEqual(rl.map((r) => typeof r.big), ['number', 'number', 'number', 'number'])
    assert.deepEqual(rl.map((r) => r.big), [500000000000000000, 500000000000000000, 500000000000000000, 500000000000000064], 'lossy, like better-sqlite3')
    he.close()
    hl.close()
  })
})

test('int64 helpers: msgId normalisation, dedup-key rule and the standalone (lossy) key mapping', () => {
  // normalizeMsgId: bigint -> exact decimal string; everything else untouched (standalone no-op)
  assert.equal(normalizeMsgId(534567890123456789n), '534567890123456789')
  assert.equal(normalizeMsgId(42), 42)
  assert.equal(normalizeMsgId('500000000000000001'), '500000000000000001')
  assert.equal(normalizeMsgId(null), null)
  const buf = Buffer.from([1])
  assert.equal(normalizeMsgId(buf), buf)
  // applyInt64Mode
  assert.equal(applyInt64Mode(5n, 'exact'), 5n)
  assert.equal(applyInt64Mode(5n, 'legacy-number'), 5)
  assert.equal(applyInt64Mode('x', 'legacy-number'), 'x')
  // toSafeNumber never silently loses precision
  assert.equal(toSafeNumber(12n), 12)
  assert.equal(toSafeNumber(7), 7)
  assert.throws(() => toSafeNumber(534567890123456789n), RangeError)
  // standalone derives its key from String(Number(id)); the exact key maps onto it deterministically,
  // and distinct exact ids can collapse onto one standalone key (the collision the exact mode removes)
  assert.equal(legacyStandaloneMsgId('534567890123456789'), String(534567890123456789))
  assert.equal(legacyStandaloneMsgId('534567890123456789'), '534567890123456800')
  assert.equal(legacyStandaloneMsgId('500000000000000001'), legacyStandaloneMsgId('500000000000000002'))
  assert.notEqual('500000000000000001', '500000000000000002')
  assert.equal(legacyStandaloneMsgId('9007199254740991'), '9007199254740991', 'exact up to 2^53-1: keys identical to standalone')
})

test('runtimeLog is bounded (a polling backend must not accumulate sqlite3 log lines forever)', async () => {
  await withShared(async (fx) => {
    const engine = await createWasmSqliteCipherEngine({ wasmDir: WASM_DIR })
    for (let i = 0; i < 200; i++) {
      // a failing step makes sqlite3.mjs print "sqlite3_step() rc= 8 SQLITE_READONLY ..." to printErr
      const raw = new engine.sqlite3.oo1.DB({ filename: fx.rollback, flags: 'r', vfs: engine.vfs.vfsName })
      try {
        raw.selectObjects('PRAGMA user_version=5')
      } catch {
        /* expected */
      }
      raw.close()
    }
    assert.ok(engine.runtimeLog.length > 0, 'the log hook is live')
    assert.ok(engine.runtimeLog.length <= 50, 'and bounded')
    assert.equal(engine.initWarnings.every((w) => !/SQLITE_READONLY/.test(w)), true, 'init warnings stay init-only')
  })
})
