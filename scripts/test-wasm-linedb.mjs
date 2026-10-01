// Phase 1 — cross-engine regression for the plugin LINE DB engine (SQLite3MultipleCiphers WASM + read-only node:fs VFS).
//
// Synthetic encrypted LINE-shaped DBs are written by the real standalone stack (Electron 31 + better-sqlite3-multiple-
// ciphers 11.10.0, aes128cbc, kdf_iter=1) — the "LINE.exe" role — in three shapes: WAL (with rows only in the -wal),
// rollback journal, and an int64 `_id INTEGER` variant. Then the production linedb.ts query layer is run
//   (1) through the standalone engine in Electron 31 (the reference), and
//   (2) through the WASM engine in Node 24 (both int64 modes), over NodeLineFsPort and over the koffi Win32LineFsPort,
// and the results must agree (deep-equal) and match the writer's ground truth. Wrong keys must fail. The int64 tests
// pin the dedup-key rule. No real LINE install, DB or key is touched.
//
// Needs Electron 31 + a built better-sqlite3-multiple-ciphers (see scripts/lib/runtimes.mjs for discovery / env vars).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync as nodeClose, copyFileSync, existsSync, fstatSync as nodeFstat, mkdirSync, openSync as nodeOpen, readFileSync, readSync as nodeRead, readdirSync, statSync as nodeStat, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { createWasmSqliteCipherEngine } from '../src/main/line/engine/wasmSqliteCipherEngine.ts'
import { configureLineEnginePorts, resetLineEnginePorts } from '../src/main/line/engine/enginePorts.ts'
import { createNodeLineFsPort } from '../src/main/line/engine/nodeLineFsPort.ts'
import { createWin32LineFsPort } from '../src/main/line/engine/native/win32fs.ts'
import { copySnapshot, findDbPath } from '../src/main/line/engine/fsPort.ts'
import * as linedb from '../src/main/line/engine/linedb.ts'
import { rowToObj } from '../src/main/line/engine/rowToObj.ts'
import { deriveMsgId } from '../src/main/db/schema.ts'
import { legacyStandaloneMsgId } from '../src/main/line/engine/wasm/int64.ts'
import { RAW_SQL, runAllVariants } from './lib/linedb-suite.mjs'
import { diffSuites } from './lib/compare.mjs'
import { ROOT, WASM_DIR, generateFixtures, makeTempRoot, rmQuiet, runStandaloneReference } from './lib/runtimes.mjs'

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

// ── one-time setup: fixtures (Electron 31 writer) + standalone reference run (Electron 31) ─────────────────────────
let setup = null
function getSetup() {
  if (!setup) {
    setup = (async () => {
      const root = makeTempRoot('wasm-linedb-')
      const fixtureDir = join(root, 'fixtures')
      const expected = generateFixtures(fixtureDir)
      // a LINE-style db directory: the wal fixture as the biggest qw*.edb, plus decoys findDbPath must ignore
      const linedir = join(root, 'linedir')
      mkdirSync(linedir, { recursive: true })
      for (const ext of ['', '-wal', '-shm']) copyFileSync(join(fixtureDir, 'wal', 'm.edb' + ext), join(linedir, 'qw0f0f.edb' + ext))
      copyFileSync(join(fixtureDir, 'int64', 'm.edb'), join(linedir, 'qw0a0a.edb'))
      writeFileSync(join(linedir, 'qw0f0f_sibling.edb'), Buffer.alloc(8))
      writeFileSync(join(linedir, 'notes.txt'), 'x')
      const reference = await runStandaloneReference({ fixtureDir, expected, workDir: root })
      return { root, fixtureDir, linedir, expected, reference }
    })()
  }
  return setup
}
test.after(async () => {
  resetLineEnginePorts()
  if (setup) rmQuiet((await setup).root)
})

/** Run the production linedb suite through an engine + fs port pair. */
async function suiteWith({ int64, fsPort, fixtureDir, expected, vfsFs }) {
  const engine = await createWasmSqliteCipherEngine({ wasmDir: WASM_DIR, int64, vfsFs })
  configureLineEnginePorts({ fs: fsPort, sqlite: engine })
  try {
    return { engine, result: runAllVariants(linedb, { fixtureDir, expected }) }
  } finally {
    resetLineEnginePorts()
  }
}

const kindsWithText = ['wal', 'rollback']

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('setup sanity: fixtures are really encrypted, the WAL fixture has rows only in the -wal, the reference ran on Electron 31', async () => {
  const { fixtureDir, expected, reference } = await getSetup()
  assert.equal(expected.encryptedHeaderCheck.isPlainSqliteHeader, false)
  assert.equal(expected.walPlaintextLeak, false)
  assert.ok(expected.wal.messageCount > expected.wal.baseOnly.messageCount, 'WAL-only rows exist')
  assert.ok(existsSync(join(fixtureDir, 'wal', 'm.edb-wal')))
  assert.equal(existsSync(join(fixtureDir, 'rollback', 'm.edb-wal')), false)
  assert.equal(expected.rollback.journalMode, 'delete')
  assert.equal(expected.wal.journalMode, 'wal')
  assert.equal(reference.runtime.electron, '31.7.7')
  assert.equal(reference.runtime.abi, '125')
})

test('WAL and rollback: WASM full-table digest, count and newest row equal the writer (and the standalone reference too)', async () => {
  const { fixtureDir, expected, reference } = await getSetup()
  const { result, engine } = await suiteWith({ int64: 'exact', fsPort: createNodeLineFsPort(), fixtureDir, expected })
  for (const kind of kindsWithText) {
    const v = result.variants[kind]
    const truth = expected[kind]
    assert.equal(v.messageCount.value, truth.messageCount, `${kind} count`)
    assert.equal(v.messageDigest.value, truth.messageDigest, `${kind} full-table digest equals the writer's`)
    assert.equal(v.tailSql.value.m, truth.maxRow.createdTime, `${kind} newest createdTime`)
    // the independent standalone reading agrees with the writer as well (guards against both engines reading the same wrong thing)
    assert.equal(reference.variants[kind].messageDigest.value, truth.messageDigest, `${kind} reference digest`)
  }
  assert.ok(result.variants.wal.messageCount.value > expected.wal.baseOnly.messageCount, 'rows that live only in the -wal are visible')
  assert.equal(result.variants.wal.newMessagesAfterBoundary.value.n, expected.wal.walRows, 'cursor at the WAL boundary returns exactly the WAL-only rows')
  assert.equal(engine.openConnections(), 0, 'no leaked connection')
  assert.equal(engine.vfs.openFiles(), 0)
  assert.equal(engine.vfs.shmNodes(), 0)
})

test('linedb queries: WASM results equal standalone better-sqlite3-multiple-ciphers results (exact and legacy-number int64 modes)', async () => {
  const { fixtureDir, expected, reference } = await getSetup()
  const exact = await suiteWith({ int64: 'exact', fsPort: createNodeLineFsPort(), fixtureDir, expected })
  assert.deepEqual(diffSuites(reference, exact.result, { int64Mode: 'exact' }), [])
  const legacy = await suiteWith({ int64: 'legacy-number', fsPort: createNodeLineFsPort(), fixtureDir, expected })
  // legacy-number is bit-for-bit the standalone behaviour, including the int64 variant
  assert.deepEqual(diffSuites(reference, legacy.result, { int64Mode: 'legacy-number' }), [])
  // sanity that the comparison is not vacuous
  assert.ok(Object.keys(reference.variants.wal).length >= 20)
  assert.ok(reference.variants.wal.pagingFullScan.value.n >= expected.wal.messageCount)
})

test('linedb queries over the koffi Win32LineFsPort (the plugin I/O path) equal the standalone results', async () => {
  const { root, fixtureDir, expected, reference } = await getSetup()
  const workspace = join(root, 'workspace-win32')
  const winFs = createWin32LineFsPort({ workspaceRoot: workspace })
  const { result, engine } = await suiteWith({ int64: 'exact', fsPort: winFs, fixtureDir, expected })
  assert.deepEqual(diffSuites(reference, result, { int64Mode: 'exact' }), [])
  assert.deepEqual(readdirSync(workspace), [], 'every snapshot temp dir was cleaned up')
  assert.equal(engine.openConnections(), 0)
})

test('wrong key fails with the fixed error, leaves no connection or snapshot behind, and does not poison later opens', async () => {
  const { root, fixtureDir, expected, reference } = await getSetup()
  const workspace = join(root, 'workspace-wrongkey')
  const winFs = createWin32LineFsPort({ workspaceRoot: workspace })
  const engine = await createWasmSqliteCipherEngine({ wasmDir: WASM_DIR })
  configureLineEnginePorts({ fs: winFs, sqlite: engine })
  try {
    for (const kind of ['wal', 'rollback', 'int64']) {
      const edb = join(fixtureDir, kind, 'm.edb')
      assert.throws(() => linedb.openDb('f'.repeat(32), edb), (e) => e.message === JSON.stringify({ error: 'decryption failed — wrong key or cipher params' }))
      assert.throws(() => linedb.openDb('0123456789abcdef0123456789abcde0', edb), /decryption failed/, 'one nibble off')
      assert.equal(engine.openConnections(), 0)
      assert.deepEqual(readdirSync(workspace), [], 'failed open removed its snapshot dir')
      // the right key still works afterwards (cipher state is per connection)
      const { con, cleanup } = linedb.openDb(expected.key, edb)
      assert.ok(con.prepare('SELECT count(*) AS c FROM _message').get().c > 0)
      cleanup()
      // exactly the same failure text as the standalone reference
      assert.equal(reference.wrongKey[kind].value, JSON.stringify({ error: 'decryption failed — wrong key or cipher params' }))
    }
    // the engine alone (no linedb): queries on a wrong-key connection throw SQLITE_NOTADB; no key at all fails too
    const snap = winFs.makeTempDir('raw-')
    const path = copySnapshot(winFs, join(fixtureDir, 'rollback', 'm.edb'), snap)
    const raw = engine.open(path)
    assert.throws(() => raw.prepare('SELECT count(*) FROM sqlite_master').get(), /NOTADB|not a database/i, 'no key')
    raw.pragma("cipher='aes128cbc'")
    raw.pragma('kdf_iter=1')
    raw.pragma("key='ffffffffffffffffffffffffffffffff'")
    assert.throws(() => raw.prepare('SELECT count(*) FROM sqlite_master').get(), /NOTADB|not a database/i, 'wrong key')
    raw.close()
    winFs.removeDir(snap)
  } finally {
    resetLineEnginePorts()
  }
  assert.equal(engine.openConnections(), 0)
})

test('the VFS reads the private snapshot copy, never the source files (which stay byte-identical)', async () => {
  const { root, fixtureDir, expected } = await getSetup()
  const sources = ['wal', 'rollback', 'int64'].flatMap((k) => ['', '-wal', '-shm'].map((e) => join(fixtureDir, k, 'm.edb' + e))).filter(existsSync)
  const before = sources.map(sha256)
  const workspace = join(root, 'workspace-spy')
  const winFs = createWin32LineFsPort({ workspaceRoot: workspace })
  const opened = []
  const spyFs = {
    constants: { O_RDONLY: 0 },
    openSync: (p, f) => {
      opened.push(p)
      return nodeOpen(p, f)
    },
    readSync: (...a) => nodeRead(...a),
    fstatSync: (...a) => nodeFstat(...a),
    closeSync: (...a) => nodeClose(...a),
    statSync: (...a) => nodeStat(...a),
  }
  const { result } = await suiteWith({ int64: 'exact', fsPort: winFs, fixtureDir, expected, vfsFs: spyFs })
  assert.ok(Object.keys(result.variants).length === 3)
  assert.ok(opened.length > 0)
  const w = workspace.replace(/\\/g, '/').toLowerCase()
  assert.ok(opened.every((p) => p.replace(/\\/g, '/').toLowerCase().startsWith(w + '/')), 'every VFS open is inside the workspace snapshot dir')
  assert.deepEqual(sources.map(sha256), before, 'LINE-side (source) files untouched')
})

test('int64 `_id`: exact mode keeps every id distinct (String(BigInt)); legacy-number reproduces the standalone dedup keys exactly', async () => {
  const { fixtureDir, expected, reference } = await getSetup()
  const keysFor = (rows) =>
    rows.map((r) =>
      deriveMsgId({
        // watchEngine.getMessagesSince -> rowToObj({ id: r.msgId }) -> message.msgId -> deriveMsgId
        ...(() => {
          const m = rowToObj(
            { chatId: r.chatId, createdTime: r.createdTime, from: r.from ?? '', text: r.text, contentType: r.contentType, id: r.msgId, contentMetadata: r.contentMetadata, contentInfo: r.contentInfo, attribute: r.attribute },
            { myMid: null, iso: () => null, chatName: null, senderName: null },
          )
          return { msgId: m.msgId, chatId: m.chatId, ts: m.ts, direction: m.direction, sender: m.sender, text: m.text }
        })(),
      }),
    )
  const readRows = async (int64) => {
    const engine = await createWasmSqliteCipherEngine({ wasmDir: WASM_DIR, int64 })
    configureLineEnginePorts({ fs: createNodeLineFsPort(), sqlite: engine })
    try {
      const { con, cleanup } = linedb.openDb(expected.key, join(fixtureDir, 'int64', 'm.edb'))
      try {
        return linedb.newMessages(con, 0, null, 500)
      } finally {
        cleanup()
      }
    } finally {
      resetLineEnginePorts()
    }
  }
  const t = expected.int64
  assert.ok(t.distinctExact > t.distinctLegacy, 'the fixture really has ids that standalone collapses (this is the standalone bug the exact mode avoids)')

  // exact: no BigInt escapes linedb, msgId is the lossless decimal string, keys are all distinct
  const exactRows = await readRows('exact')
  assert.equal(exactRows.length, t.exactIds.length)
  assert.ok(exactRows.every((r) => typeof r.msgId !== 'bigint'))
  assert.deepEqual(exactRows.map((r) => String(r.msgId)), t.exactIds)
  const exactKeys = keysFor(exactRows)
  assert.deepEqual(exactKeys, t.exactIds.map((id) => 'i:' + id))
  assert.equal(new Set(exactKeys).size, t.distinctExact)
  // rule: the exact key EQUALS the standalone key whenever the id survives a Number round-trip (|id| <= 2^53, or TEXT ids)
  const refKeys = keysFor(reference.variants.int64.int64MsgIds.value.msgIds.map((msgId, i) => ({ ...exactRows[i], msgId })))
  exactKeys.forEach((k, i) => {
    const id = t.exactIds[i]
    assert.equal(k === refKeys[i], String(Number(BigInt(id))) === id, `row ${i} (${id}): exact key equals standalone key iff the id is Number-safe`)
  })
  assert.equal(refKeys.length, t.legacyKeys.length)

  // legacy-number: bit-for-bit the standalone keys (including the collisions)
  const legacyRows = await readRows('legacy-number')
  const legacyKeys = keysFor(legacyRows)
  assert.deepEqual(legacyKeys, refKeys, 'identical to the standalone engine')
  assert.deepEqual(legacyKeys, t.legacyKeys.map((id) => 'i:' + id), 'and to the writer-side String(Number(_id))')
  assert.equal(new Set(legacyKeys).size, t.distinctLegacy)
  // and the documented mapping from an exact key to the standalone key
  t.exactIds.forEach((id, i) => assert.equal('i:' + legacyStandaloneMsgId(id), t.legacyKeys.map((k) => 'i:' + k)[i]))
})

test('TEXT `_id` (the wal / rollback fixtures): exact mode, legacy-number mode and standalone produce identical dedup keys', async () => {
  const { fixtureDir, expected } = await getSetup()
  const idsOf = async (int64) => {
    const engine = await createWasmSqliteCipherEngine({ wasmDir: WASM_DIR, int64 })
    configureLineEnginePorts({ fs: createNodeLineFsPort(), sqlite: engine })
    try {
      const { con, cleanup } = linedb.openDb(expected.key, join(fixtureDir, 'wal', 'm.edb'))
      try {
        return linedb.newMessages(con, 0, null, 100000).map((r) => 'i:' + String(r.msgId))
      } finally {
        cleanup()
      }
    } finally {
      resetLineEnginePorts()
    }
  }
  const a = await idsOf('exact')
  const b = await idsOf('legacy-number')
  assert.deepEqual(a, b)
  assert.equal(a.length, expected.wal.messageCount)
  assert.equal(new Set(a).size, a.length)
})

test('Win32LineFsPort (koffi) matches NodeLineFsPort on a LINE-style directory: readDir kinds, stat, exists, readFile, copy, findDbPath, pids', async () => {
  const { root, linedir } = await getSetup()
  const nodeFs = createNodeLineFsPort({ tempRoot: root })
  const winFs = createWin32LineFsPort({ workspaceRoot: join(root, 'workspace-parity') })
  const norm = (list) => list.map((e) => `${e.name}|${e.isFile}|${e.isDirectory}`).sort()
  assert.deepEqual(norm(winFs.readDir(linedir)), norm(nodeFs.readDir(linedir)))
  for (const name of ['qw0f0f.edb', 'qw0f0f.edb-wal', 'qw0f0f.edb-shm', 'notes.txt']) {
    const p = join(linedir, name)
    assert.deepEqual(winFs.stat(p), nodeFs.stat(p), `stat ${name} (size and mtimeNs)`)
    assert.equal(winFs.exists(p), true)
    assert.ok(winFs.readFile(p).equals(nodeFs.readFile(p)), `readFile ${name}`)
  }
  assert.equal(winFs.exists(join(linedir, 'nope.edb')), false)
  assert.throws(() => winFs.stat(join(linedir, 'nope.edb')), (e) => e.code === 'ENOENT')
  assert.throws(() => winFs.readDir(join(linedir, 'no-such-dir')), (e) => e.code === 'ENOENT')
  assert.throws(() => winFs.readFile(join(linedir, 'nope.edb')), (e) => e.code === 'ENOENT')
  // the biggest qw*.edb without '_' wins, decoys ignored — same answer from both ports
  assert.equal(findDbPath(winFs, linedir), findDbPath(nodeFs, linedir))
  assert.equal(findDbPath(winFs, linedir), join(linedir, 'qw0f0f.edb'))
  assert.equal(findDbPath(winFs, join(linedir, 'no-such-dir')), null)
  // snapshot copy: edb + -wal + -shm byte-identical
  const dst = winFs.makeTempDir('snap-')
  const out = copySnapshot(winFs, join(linedir, 'qw0f0f.edb'), dst)
  for (const ext of ['', '-wal', '-shm']) assert.equal(sha256(out + ext), sha256(join(linedir, 'qw0f0f.edb' + ext)))
  winFs.removeDir(dst)
  // process listing without child_process: this very process is node.exe
  assert.ok(winFs.listProcessIds('node.exe').includes(process.pid))
  assert.deepEqual(winFs.listProcessIds('no-such-image-xyz.exe'), [])
  // workspace ops stay node:fs-based and work
  const t = winFs.makeTempDir('w-')
  winFs.writeTextFile(join(t, 'a.txt'), 'hello')
  winFs.renameFile(join(t, 'a.txt'), join(t, 'b.txt'))
  assert.equal(winFs.readTextFile(join(t, 'b.txt')), 'hello')
  winFs.removeDir(t)
  assert.equal(existsSync(t), false)
})

test('findDb()/openDb() with no explicit path go through the injected port and dbDir (koffi readDir/stat/copy -> WASM)', async () => {
  const { root, linedir, expected } = await getSetup()
  const winFs = createWin32LineFsPort({ workspaceRoot: join(root, 'workspace-find') })
  const engine = await createWasmSqliteCipherEngine({ wasmDir: WASM_DIR })
  configureLineEnginePorts({ fs: winFs, sqlite: engine, dbDir: linedir })
  try {
    assert.equal(linedb.findDb(), join(linedir, 'qw0f0f.edb'))
    const { con, cleanup } = linedb.openDb(expected.key)
    try {
      assert.equal(con.prepare('SELECT count(*) AS c FROM _message').get().c, expected.wal.messageCount)
    } finally {
      cleanup()
    }
  } finally {
    resetLineEnginePorts()
  }
})

test('SQL drift guard: the raw SQL used by the suite still appears verbatim in the production modules', () => {
  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
  const watch = read('src/main/line/engine/watchEngine.ts')
  assert.ok(watch.includes(RAW_SQL.watchEngineTail), 'watchEngine tail query')
  const reconcile = read('src/main/pipeline/reconcile.ts')
  for (const fragment of [
    "SELECT strftime('%Y-%m', _createdTime/1000, 'unixepoch', 'localtime') AS ym, ",
    'COUNT(*) AS c, MIN(_createdTime) AS lo, MAX(_createdTime) AS hi ',
    'FROM _message ',
    'WHERE _createdTime IS NOT NULL ',
    'GROUP BY ym',
  ]) assert.ok(reconcile.includes(fragment), `reconcile: ${fragment}`)
  assert.equal(RAW_SQL.reconcileMonthly, "SELECT strftime('%Y-%m', _createdTime/1000, 'unixepoch', 'localtime') AS ym, COUNT(*) AS c, MIN(_createdTime) AS lo, MAX(_createdTime) AS hi FROM _message WHERE _createdTime IS NOT NULL GROUP BY ym")
  const order = read('src/main/driver/lineOrder.ts')
  assert.ok(order.includes(`'${RAW_SQL.lineOrderProfile}'`), 'lineOrder profile')
  assert.ok(order.includes(`'${RAW_SQL.lineOrderSquareChat}'`), 'lineOrder square chat')
})

// ── review F4: orphaned snapshot working directories are swept when the port starts ─────────────────────────────

test('F4: createWin32LineFsPort() sweeps linedb-* / linekey-scan-* snapshot directories left by a killed backend, and nothing else', () => {
  const root = makeTempRoot('wasm-linedb-sweep-')
  try {
    const workspace = join(root, 'line-engine')
    mkdirSync(workspace, { recursive: true })
    // what a backend killed in the middle of openDb() / BatchVerifier leaves behind: copies of the (encrypted) LINE database
    for (const dir of ['linedb-AbC123', 'linedb-zzzzzz', 'linekey-scan-Q1w2E3']) {
      mkdirSync(join(workspace, dir, 'nested'), { recursive: true })
      writeFileSync(join(workspace, dir, 'm.edb'), Buffer.alloc(4096, 7))
      writeFileSync(join(workspace, dir, 'm.edb-wal'), Buffer.alloc(512, 9))
      writeFileSync(join(workspace, dir, 'nested', 'x'), 'x')
    }
    // everything that is not a snapshot directory must survive: engine state, the key cache, other directories, a *file* that merely starts with the prefix
    mkdirSync(join(workspace, 'media-tmp'))
    writeFileSync(join(workspace, 'media-tmp', 'keep.bin'), 'keep')
    writeFileSync(join(workspace, '.linekey'), '0123456789abcdef0123456789abcdef')
    writeFileSync(join(workspace, '.watch_json_state'), '{}')
    writeFileSync(join(workspace, 'linedb-note.txt'), 'a file, not a snapshot directory')
    mkdirSync(join(workspace, 'Linedb-other-case-is-not-ours'))

    const port = createWin32LineFsPort({ workspaceRoot: workspace })
    assert.equal(port.sweptOrphans, 3, 'three snapshot directories were swept')
    assert.deepEqual(readdirSync(workspace).sort(), ['.linekey', '.watch_json_state', 'Linedb-other-case-is-not-ours', 'linedb-note.txt', 'media-tmp'].sort())
    assert.equal(readFileSync(join(workspace, 'media-tmp', 'keep.bin'), 'utf8'), 'keep')
    assert.equal(readFileSync(join(workspace, '.linekey'), 'utf8').length, 32)

    // idempotent; and the engine's own temp dirs (made after construction) are untouched until their owner removes them
    assert.equal(createWin32LineFsPort({ workspaceRoot: workspace }).sweptOrphans, 0)
    const live = port.makeTempDir('linedb-')
    assert.ok(existsSync(live))
    port.removeDir(live)
    assert.equal(existsSync(live), false)

    // a workspace that does not exist yet is created, nothing to sweep
    const fresh = createWin32LineFsPort({ workspaceRoot: join(root, 'brand-new', 'line-engine') })
    assert.equal(fresh.sweptOrphans, 0)
    assert.ok(existsSync(join(root, 'brand-new', 'line-engine')))
  } finally {
    rmQuiet(root)
  }
})
