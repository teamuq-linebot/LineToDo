// Phase 0 port 單元測試（node:test）。
//
// 1. NodeLineFsPort 對 fixture 目錄的 find / copy / list / stat 與 Phase 0 之前的 node:fs 直呼
//    行為逐項一致（legacy* 函式為改動前程式碼的逐字副本）。
// 2. 組裝根注入（configureLineEnginePorts）確實接管 linedb / linekey / watchEngine 的 I/O，
//    且 openDb 的開檔序列（copy → open → cipher → kdf_iter → key → 驗解 → checkpoint → cleanup）不變。
// 3. media/decrypt 經 LineFsPort 解合成 .eimg；AppDbEngine 只注入 driver／nativeBinding。
//
// 不碰真 LINE、真 DB、真金鑰：全部是暫存目錄裡的合成檔案。
import assert from 'node:assert/strict'
import { createCipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { NodeLineFsPort, createNodeLineFsPort, parseTasklistCsv } from '../src/main/line/engine/nodeLineFsPort.ts'
import { copySnapshot, findDbPath } from '../src/main/line/engine/fsPort.ts'
import {
  configureLineEnginePorts, getLineEnginePorts, resetLineEnginePorts, DEFAULT_LINE_DB_DIR
} from '../src/main/line/engine/enginePorts.ts'
import { DB_DIR, findDb, openDb } from '../src/main/line/engine/linedb.ts'
import { findPid, getKey } from '../src/main/line/engine/linekey.ts'
import { loadState, saveState, saveStateStrict, walSig } from '../src/main/line/engine/watchEngine.ts'
import { createMediaDecryptor } from '../src/main/media/decrypt.ts'
import { createBetterSqlite3AppEngine } from '../src/main/db/appDbEngine.ts'
import { openDatabase } from '../src/main/db/database.ts'
import SqliteTestAdapter from './sqlite-test-adapter.mjs'

// ── legacy（Phase 0 之前）逐字副本 ──────────────────────────────────────────

/** linedb.ts findDb()（DB_DIR 參數化）。 */
function legacyFindDb(dbDir) {
  let entries
  try { entries = readdirSync(dbDir) } catch { return null }
  const cands = entries.filter((f) => f.startsWith('qw') && f.endsWith('.edb') && !f.includes('_')).map((f) => join(dbDir, f))
  if (cands.length === 0) return null
  let best = cands[0]
  let bestSize = -1
  for (const p of cands) {
    let size = -1
    try { size = statSync(p).size } catch { size = -1 }
    if (size > bestSize) { bestSize = size; best = p }
  }
  return best
}

/** linedb.ts openDb() 的複製迴圈。 */
function legacyCopySnapshot(src, dstDir) {
  const path = join(dstDir, 'm.edb')
  for (const ext of ['', '-wal', '-shm']) {
    if (existsSync(src + ext)) copyFileSync(src + ext, path + ext)
  }
  return path
}

/** watchEngine.ts walSig()。 */
function legacyWalSig(src) {
  const sig = { edb: null, '-wal': null }
  for (const ext of ['', '-wal']) {
    const p = (src || '') + ext
    try {
      const st = statSync(p, { bigint: true })
      sig[ext === '' ? 'edb' : '-wal'] = [Number(st.size), Number(st.mtimeNs)]
    } catch { /* null */ }
  }
  return sig
}

/** linekey.ts findPid() 的 tasklist CSV 解析段。 */
function legacyParsePid(out, name) {
  const target = name.toLowerCase()
  for (const line of out.split(/\r?\n/)) {
    const parts = line.split('","').map((p) => p.replace(/^"|"$/g, ''))
    if (parts.length >= 2 && parts[0].toLowerCase() === target) {
      const pid = parseInt(parts[1].trim(), 10)
      if (Number.isFinite(pid)) return pid
    }
  }
  return null
}

/** media/decrypt.ts walkEimg()。 */
function legacyWalkEimg(dir, index) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) legacyWalkEimg(full, index)
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.eimg')) {
      try { const size = statSync(full).size; const arr = index.get(size); if (arr) arr.push(full); else index.set(size, [full]) } catch { /* skip */ }
    }
  }
}

function portWalkEimg(fs, dir, index) {
  let entries
  try { entries = fs.readDir(dir) } catch { return }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory) portWalkEimg(fs, full, index)
    else if (entry.isFile && entry.name.toLowerCase().endsWith('.eimg')) {
      try { const size = fs.stat(full).size; const arr = index.get(size); if (arr) arr.push(full); else index.set(size, [full]) } catch { /* skip */ }
    }
  }
}

// ── fixture ────────────────────────────────────────────────────────────────

function withTemp(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

/** 合成 LINE db 目錄：多顆 qw*.edb、含 '_' 的 sibling（最大但須排除）、非 qw 檔、同名樣式的子目錄。 */
function makeDbDir(root) {
  const dbDir = join(root, 'db')
  mkdirSync(dbDir)
  writeFileSync(join(dbDir, 'qwaaaa.edb'), Buffer.alloc(1000, 1))
  writeFileSync(join(dbDir, 'qwbbbb.edb'), Buffer.alloc(4096, 2))
  writeFileSync(join(dbDir, 'qwbbbb.edb-wal'), Buffer.alloc(777, 3))
  writeFileSync(join(dbDir, 'qwbbbb.edb-shm'), Buffer.alloc(32768, 4))
  writeFileSync(join(dbDir, 'qwcccc_e2ee.edb'), Buffer.alloc(9000, 5))
  writeFileSync(join(dbDir, 'other.edb'), Buffer.alloc(20000, 6))
  writeFileSync(join(dbDir, 'qwdddd.edb.bak'), Buffer.alloc(30000, 7))
  mkdirSync(join(dbDir, 'qwzzzz.edb'))
  return dbDir
}

const listing = (dir) => readdirSync(dir).sort()

// ── 1. NodeLineFsPort vs legacy ────────────────────────────────────────────

test('findDbPath(NodeLineFsPort) picks the same main DB as the legacy findDb', () => withTemp('lfp-find-', (root) => {
  const fs = new NodeLineFsPort()
  const dbDir = makeDbDir(root)
  const expected = legacyFindDb(dbDir)
  assert.equal(expected, join(dbDir, 'qwbbbb.edb'))
  assert.equal(findDbPath(fs, dbDir), expected)
  // 目錄不存在 → 兩者皆 null；空目錄 → 兩者皆 null。
  assert.equal(findDbPath(fs, join(root, 'missing')), legacyFindDb(join(root, 'missing')))
  assert.equal(findDbPath(fs, join(root, 'missing')), null)
  mkdirSync(join(root, 'empty'))
  assert.equal(findDbPath(fs, join(root, 'empty')), legacyFindDb(join(root, 'empty')))
}))

test('copySnapshot(NodeLineFsPort) copies the same edb/-wal/-shm set byte-for-byte as the legacy loop', () => withTemp('lfp-copy-', (root) => {
  const fs = new NodeLineFsPort()
  const dbDir = makeDbDir(root)
  // 帶 -wal/-shm 的 DB 與只有主檔的 DB 兩種情境。
  for (const name of ['qwbbbb.edb', 'qwaaaa.edb']) {
    const src = join(dbDir, name)
    const legacyDir = mkdtempSync(join(root, 'legacy-'))
    const portDir = mkdtempSync(join(root, 'port-'))
    const legacyPath = legacyCopySnapshot(src, legacyDir)
    const portPath = copySnapshot(fs, src, portDir)
    assert.equal(portPath, join(portDir, 'm.edb'))
    assert.deepEqual(listing(portDir), listing(legacyDir))
    for (const file of listing(legacyDir)) {
      assert.deepEqual(readFileSync(join(portDir, file)), readFileSync(join(legacyDir, file)), file)
    }
    assert.equal(legacyPath.endsWith('m.edb'), true)
  }
  // 來源不存在：兩者都不複製任何檔、不 throw。
  const emptyDir = mkdtempSync(join(root, 'none-'))
  copySnapshot(fs, join(dbDir, 'nope.edb'), emptyDir)
  assert.deepEqual(listing(emptyDir), [])
}))

test('readDir/stat/exists/readFile match node:fs (Dirent kinds, bigint mtime, sizes)', () => withTemp('lfp-list-', (root) => {
  const fs = new NodeLineFsPort()
  const dbDir = makeDbDir(root)
  const expected = readdirSync(dbDir, { withFileTypes: true })
    .map((e) => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory() }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const actual = fs.readDir(dbDir).sort((a, b) => a.name.localeCompare(b.name))
  assert.deepEqual(actual, expected)
  assert.equal(actual.find((e) => e.name === 'qwzzzz.edb').isDirectory, true)
  assert.throws(() => fs.readDir(join(root, 'missing')))

  const p = join(dbDir, 'qwbbbb.edb-wal')
  const st = statSync(p, { bigint: true })
  assert.deepEqual(fs.stat(p), { size: Number(st.size), mtimeNs: st.mtimeNs })
  assert.equal(fs.stat(p).size, statSync(p).size)
  assert.throws(() => fs.stat(join(dbDir, 'missing.edb')))
  assert.equal(fs.exists(p), true)
  assert.equal(fs.exists(join(dbDir, 'missing.edb')), false)
  assert.deepEqual(fs.readFile(p), readFileSync(p))
}))

test('walSig via the port equals the legacy statSync-based signature', () => withTemp('lfp-sig-', (root) => {
  const dbDir = makeDbDir(root)
  for (const src of [join(dbDir, 'qwbbbb.edb'), join(dbDir, 'qwaaaa.edb'), join(dbDir, 'missing.edb'), null]) {
    assert.deepEqual(walSig(src), legacyWalSig(src), String(src))
  }
}))

test('media cache walk via the port indexes the same .eimg files as the legacy walk', () => withTemp('lfp-eimg-', (root) => {
  const cache = join(root, 'Cache')
  mkdirSync(join(cache, 'a', 'b'), { recursive: true })
  writeFileSync(join(cache, 'x.eimg'), Buffer.alloc(64))
  writeFileSync(join(cache, 'a', 'y.EIMG'), Buffer.alloc(64))
  writeFileSync(join(cache, 'a', 'b', 'z.eimg'), Buffer.alloc(100))
  writeFileSync(join(cache, 'a', 'b', 'not-media.jpg'), Buffer.alloc(100))
  const legacy = new Map()
  const viaPort = new Map()
  legacyWalkEimg(cache, legacy)
  portWalkEimg(new NodeLineFsPort(), cache, viaPort)
  const norm = (m) => [...m.entries()].map(([k, v]) => [k, [...v].sort()]).sort((a, b) => a[0] - b[0])
  assert.deepEqual(norm(viaPort), norm(legacy))
  assert.equal(viaPort.get(64).length, 2)
}))

test('listProcessIds parses tasklist CSV like the legacy findPid', () => {
  const out = [
    '"System Idle Process","0","Services","0","8 K"',
    '"line.exe","4321","Console","1","120,000 K"',
    '"LINE.exe","1234","Console","1","300,000 K"',
    '"LINEUpdater.exe","999","Console","1","1,000 K"',
    ''
  ].join('\r\n')
  assert.deepEqual(parseTasklistCsv(out, 'LINE.exe'), [4321, 1234])
  assert.equal(parseTasklistCsv(out, 'LINE.exe')[0], legacyParsePid(out, 'LINE.exe'))
  const none = 'INFO: No tasks are running which match the specified criteria.\r\n'
  assert.deepEqual(parseTasklistCsv(none, 'LINE.exe'), [])
  assert.equal(legacyParsePid(none, 'LINE.exe'), null)
})

test('listProcessIds finds this node process through real tasklist', { skip: process.platform !== 'win32' }, () => {
  const pids = new NodeLineFsPort().listProcessIds('node.exe')
  assert.ok(pids.includes(process.pid), `pid ${process.pid} not in ${pids.length} node.exe pids`)
  assert.deepEqual(new NodeLineFsPort().listProcessIds('definitely-not-running-xyz.exe'), [])
})

test('workspace ops: makeTempDir honours tempRoot, removeDir is force-recursive, text files round-trip', () => withTemp('lfp-ws-', (root) => {
  const fs = createNodeLineFsPort({ tempRoot: root })
  const tmp = fs.makeTempDir('linedb-')
  assert.equal(tmp.startsWith(join(root, 'linedb-')), true)
  fs.ensureDir(join(tmp, 'a', 'b'))
  fs.writeTextFile(join(tmp, 'a', 'b', 's.tmp'), '中文 state')
  fs.renameFile(join(tmp, 'a', 'b', 's.tmp'), join(tmp, 'a', 'b', 's.json'))
  assert.equal(fs.readTextFile(join(tmp, 'a', 'b', 's.json')), '中文 state')
  fs.removeDir(tmp)
  assert.equal(existsSync(tmp), false)
  fs.removeDir(tmp) // 不存在也不 throw（rmSync force）
  // 預設 tempRoot＝os.tmpdir()
  const def = new NodeLineFsPort().makeTempDir('lfp-default-')
  assert.equal(def.startsWith(join(tmpdir(), 'lfp-default-')), true)
  rmSync(def, { recursive: true, force: true })
}))

// ── 2. 組裝根注入 ──────────────────────────────────────────────────────────

/** posix 化路徑（Windows 上 path.join 產生反斜線；fake 一律以 '/' 記錄與比對）。 */
const n = (p) => p.replace(/\\/g, '/')

/** 記錄所有呼叫的 fake LineFsPort（純記憶體）。 */
function fakeFs(files = {}) {
  const calls = []
  const store = new Map(Object.entries(files))
  const fs = {
    calls,
    store,
    readDir: (dir) => { dir = n(dir); calls.push(['readDir', dir]); return [...store.keys()].filter((k) => k.startsWith(dir + '/')).map((k) => ({ name: k.slice(dir.length + 1), isFile: true, isDirectory: false })) },
    stat: (p) => { p = n(p); calls.push(['stat', p]); if (!store.has(p)) throw new Error('ENOENT'); return { size: store.get(p).length, mtimeNs: 1n } },
    exists: (p) => { p = n(p); calls.push(['exists', p]); return store.has(p) },
    readFile: (p) => { p = n(p); calls.push(['readFile', p]); if (!store.has(p)) throw new Error('ENOENT'); return Buffer.from(store.get(p)) },
    copyFile: (s, d) => { s = n(s); d = n(d); calls.push(['copyFile', s, d]); store.set(d, store.get(s)) },
    makeTempDir: (prefix) => { calls.push(['makeTempDir', prefix]); return `/ws/${prefix}1` },
    removeDir: (d) => { calls.push(['removeDir', n(d)]) },
    ensureDir: (d) => { calls.push(['ensureDir', n(d)]) },
    readTextFile: (p) => { p = n(p); calls.push(['readTextFile', p]); if (!store.has(p)) throw new Error('ENOENT'); return String(store.get(p)) },
    writeTextFile: (p, data) => { p = n(p); calls.push(['writeTextFile', p]); store.set(p, data) },
    renameFile: (a, b) => { a = n(a); b = n(b); calls.push(['renameFile', a, b]); store.set(b, store.get(a)); store.delete(a) },
    listProcessIds: (name) => { calls.push(['listProcessIds', name]); return name === 'LINE.exe' ? [77, 88] : [] }
  }
  return fs
}

/** fake 引擎：記錄 open/pragma/prepare/close 順序；wrongKey 時 key 之後的驗解 throw。 */
function fakeEngine({ wrongKey = false } = {}) {
  const log = []
  return {
    log,
    name: 'fake',
    open(path, options) {
      log.push(['open', n(path), options ?? null])
      let keyed = false
      return {
        pragma(source) { log.push(['pragma', source]); if (source.startsWith('key=')) keyed = true; return [] },
        prepare(sql) {
          log.push(['prepare', sql])
          return {
            get: () => { if (keyed && wrongKey) throw new Error('file is not a database'); return { 'count(*)': 3 } },
            all: () => []
          }
        },
        close() { log.push(['close']) }
      }
    }
  }
}

test('registry: unconfigured ports fall back to Node defaults and the standalone dbDir', () => {
  resetLineEnginePorts()
  const ports = getLineEnginePorts()
  assert.equal(ports.dbDir, DEFAULT_LINE_DB_DIR)
  assert.equal(DB_DIR, DEFAULT_LINE_DB_DIR)
  assert.equal(ports.fs instanceof NodeLineFsPort, true)
  assert.equal(ports.sqlite.name, 'better-sqlite3-multiple-ciphers')
  assert.equal(getLineEnginePorts().fs, ports.fs, 'defaults are created once')
})

test('openDb runs the unchanged snapshot/cipher sequence through the injected ports', (t) => {
  t.after(resetLineEnginePorts)
  const fs = fakeFs({ '/line/db/qwmain.edb': 'E'.repeat(10), '/line/db/qwmain.edb-wal': 'W', '/line/db/qwsmall.edb': 'e' })
  const engine = fakeEngine()
  configureLineEnginePorts({ fs, sqlite: engine, dbDir: '/line/db' })

  assert.equal(n(findDb()), '/line/db/qwmain.edb')
  const { con, cleanup } = openDb('0123456789abcdef0123456789abcdef')
  assert.equal(typeof con.prepare, 'function')
  assert.deepEqual(fs.calls.filter((c) => c[0] === 'copyFile'), [
    ['copyFile', '/line/db/qwmain.edb', '/ws/linedb-1/m.edb'],
    ['copyFile', '/line/db/qwmain.edb-wal', '/ws/linedb-1/m.edb-wal']
  ])
  assert.deepEqual(engine.log, [
    ['open', '/ws/linedb-1/m.edb', null],
    ['pragma', "cipher='aes128cbc'"],
    ['pragma', 'kdf_iter=1'],
    ['pragma', "key='0123456789abcdef0123456789abcdef'"],
    ['prepare', 'SELECT count(*) FROM sqlite_master'],
    ['pragma', 'wal_checkpoint(TRUNCATE)']
  ])
  cleanup()
  assert.deepEqual(engine.log.at(-1), ['close'])
  assert.deepEqual(fs.calls.at(-1), ['removeDir', '/ws/linedb-1'])
})

test('openDb wrong key: closes, removes the workspace and throws the fixed JSON error', (t) => {
  t.after(resetLineEnginePorts)
  const fs = fakeFs({ '/line/db/qwmain.edb': 'E' })
  const engine = fakeEngine({ wrongKey: true })
  configureLineEnginePorts({ fs, sqlite: engine, dbDir: '/line/db' })
  assert.throws(() => openDb('ffffffffffffffffffffffffffffffff'), (error) => {
    assert.deepEqual(JSON.parse(error.message), { error: 'decryption failed — wrong key or cipher params' })
    return true
  })
  assert.deepEqual(engine.log.at(-1), ['close'])
  assert.deepEqual(fs.calls.at(-1), ['removeDir', '/ws/linedb-1'])
})

test('openDb with no DB in the injected dbDir reports that dir', (t) => {
  t.after(resetLineEnginePorts)
  configureLineEnginePorts({ fs: fakeFs(), sqlite: fakeEngine(), dbDir: '/nowhere' })
  assert.throws(() => openDb('00000000000000000000000000000000'), (error) => {
    assert.deepEqual(JSON.parse(error.message), { error: 'LINE message DB not found', dir: '/nowhere' })
    return true
  })
})

test('linekey: findPid and the key cache go through the injected ports', (t) => {
  t.after(resetLineEnginePorts)
  const fs = fakeFs({ '/line/db/qwmain.edb': 'E', '/data/.linekey': ' 0123456789abcdef0123456789abcdef \n' })
  const engine = fakeEngine()
  configureLineEnginePorts({ fs, sqlite: engine, dbDir: '/line/db' })
  assert.equal(findPid('LINE.exe'), 77)
  assert.equal(findPid('Other.exe'), null)
  const key = getKey({ skipEnv: true, skipRecover: true, cacheFile: '/data/.linekey' })
  assert.equal(key, '0123456789abcdef0123456789abcdef')
  assert.deepEqual(fs.calls.filter((c) => c[0] === 'readTextFile'), [['readTextFile', '/data/.linekey']])
  // cache 檔不存在 + skipRecover → null，且不讀檔。
  assert.equal(getKey({ skipEnv: true, skipRecover: true, cacheFile: '/data/missing' }), null)
})

test('watchEngine state files go through the injected ports', (t) => {
  t.after(resetLineEnginePorts)
  const fs = fakeFs()
  configureLineEnginePorts({ fs })
  const state = { last_ts: 5, cursor: { createdTime: 5, rowId: 2 }, sig: null }
  saveStateStrict('/data/state/.watch_json_state', state)
  assert.deepEqual(fs.calls.slice(0, 3), [
    ['ensureDir', '/data/state'],
    ['writeTextFile', '/data/state/.watch_json_state.tmp'],
    ['renameFile', '/data/state/.watch_json_state.tmp', '/data/state/.watch_json_state']
  ])
  assert.deepEqual(loadState('/data/state/.watch_json_state'), state)
  saveState('/data/s2', { last_ts: 1, sig: null })
  assert.deepEqual(loadState('/data/s2'), { last_ts: 1, cursor: undefined, sig: null })
  assert.deepEqual(loadState('/data/missing'), { last_ts: 0, sig: null })
})

// ── 3. media decrypt / AppDbEngine ─────────────────────────────────────────

/** 依 decrypt.ts 檔頭配方產生合成 .eimg。 */
function makeEimg(plain) {
  const ikm = randomBytes(32)
  const derived = Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(32, 0), Buffer.from('FileEncryption'), 76))
  const nonce = Buffer.concat([derived.subarray(64, 76), Buffer.alloc(4, 0)])
  const cipher = createCipheriv('aes-256-ctr', derived.subarray(0, 32), nonce)
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
  const sign = createHmac('sha256', derived.subarray(32, 64)).update(ciphertext).digest()
  return { keyMaterial: ikm.toString('base64'), file: Buffer.concat([ciphertext, sign]) }
}

test('media decryptor finds and decrypts a synthetic .eimg through NodeLineFsPort and an injected fs', () => withTemp('lfp-media-', (root) => {
  const cache = join(root, 'Cache')
  mkdirSync(join(cache, 'chat'), { recursive: true })
  const plain = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), randomBytes(200)])
  const { keyMaterial, file } = makeEimg(plain)
  writeFileSync(join(cache, 'chat', 'm.eimg'), file)
  writeFileSync(join(cache, 'decoy.eimg'), randomBytes(file.length)) // 同 size 但 HMAC 不符

  const viaNode = createMediaDecryptor({ cacheDir: cache }).decrypt({ keyMaterial, fileSize: plain.length })
  assert.equal(viaNode.status, 'ok')
  assert.equal(viaNode.mime, 'image/png')
  assert.deepEqual(viaNode.bytes, plain)
  assert.equal(createMediaDecryptor({ cacheDir: cache }).decrypt({ keyMaterial, fileSize: plain.length + 1 }).status, 'not-cached')

  const injected = fakeFs({ '/cache/q.eimg': file })
  injected.readDir = (dir) => dir === '/cache' ? [{ name: 'q.eimg', isFile: true, isDirectory: false }] : []
  const viaFake = createMediaDecryptor({ fs: injected, cacheDir: '/cache' }).decrypt({ keyMaterial, fileSize: plain.length })
  assert.equal(viaFake.status, 'ok')
  assert.deepEqual(viaFake.bytes, plain)
  assert.deepEqual(injected.calls.map((c) => c[0]), ['stat', 'readFile'])
}))

test('AppDbEngine injects only the better-sqlite3 driver and nativeBinding', () => {
  const seen = []
  class RecordingDriver { constructor(...args) { seen.push(args) } }
  createBetterSqlite3AppEngine({ driver: RecordingDriver }).open('/data/a.db')
  createBetterSqlite3AppEngine({ driver: RecordingDriver, nativeBinding: '/install/better_sqlite3.node' }).open('/data/b.db')
  assert.deepEqual(seen, [['/data/a.db'], ['/data/b.db', { nativeBinding: '/install/better_sqlite3.node' }]])
})

test('openDatabase opens, health-checks and migrates through an injected AppDbEngine', () => withTemp('lfp-appdb-', (root) => {
  const opened = []
  const engine = { name: 'test', open: (path) => { opened.push(path); return new SqliteTestAdapter(path) } }
  const dbPath = join(root, 'nested', 'line-todo.db')
  const result = openDatabase({ dbPath, engine })
  try {
    assert.deepEqual(opened, [dbPath])
    assert.equal(result.health.ok, true)
    assert.ok(result.db.pragma('user_version', { simple: true }) > 0)
  } finally {
    result.close()
  }
}))
