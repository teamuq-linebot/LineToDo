// Synthetic LINE-shaped encrypted DB generator. Runs under Electron 31 run-as-node (NO permission
// flags; this plays the role of "LINE.exe writing its DB"), using the exact
// better-sqlite3-multiple-ciphers 11.10.0 binary line-todo ships, and the exact cipher parameter
// sequence linedb.ts uses (src/main/line/engine/linedb.ts:25-26,150-152):
//     PRAGMA cipher='aes128cbc' ; PRAGMA kdf_iter=1 ; PRAGMA key='<32-hex>'
// The key is a SYNTHETIC constant (not a LINE key). No real LINE data is read or used.
//
// Produces, in <outDir>:
//   rollback/m.edb                  journal_mode=DELETE, 100,000 messages
//   wal/m.edb, m.edb-wal, m.edb-shm journal_mode=WAL; 100,000 checkpointed + 2,000 newer messages
//                                   (+ chat/contact changes) that live ONLY in the -wal file,
//                                   snapshotted while the writer connection is still open
//                                   (same as copying a live LINE edb/wal/shm)
//   expected.json                   ground truth computed by the writer connection
//
// Usage: ELECTRON_RUN_AS_NODE=1 electron31.exe scripts/gen-fixture.cjs <outDir>
'use strict'
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3-multiple-ciphers'))

const outDir = process.argv[2]
if (!outDir) throw new Error('usage: gen-fixture.cjs <outDir>')
const KEY = '0123456789abcdef0123456789abcdef' // synthetic test key (32-hex, same shape as LINE key)
const CIPHER = 'aes128cbc'
const KDF_ITER = 1
const BASE_N = Number(process.argv[3] || 100000) // default 100k; larger only for the memory-scaling probe
const WAL_N = 2000

// deterministic PRNG
let seed = 0x5eed1234
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
function pick(a) { return a[Math.floor(rnd() * a.length)] }
function hex(n) { let s = ''; for (let i = 0; i < n; i++) s += '0123456789abcdef'[Math.floor(rnd() * 16)]; return s }

const SCHEMA = [
  'CREATE TABLE _profile(_mid TEXT)',
  'CREATE TABLE _chat(_id TEXT PRIMARY KEY, _lastUpdatedTime INTEGER, _lastMessage TEXT)',
  'CREATE TABLE _groupChat(_chatMid TEXT PRIMARY KEY, _chatName TEXT)',
  'CREATE TABLE _square(_mid TEXT PRIMARY KEY, _name TEXT)',
  'CREATE TABLE _contact(_mid TEXT PRIMARY KEY, _displayNameOverridden TEXT, _displayName TEXT, _targetProfileDetail TEXT)',
  'CREATE TABLE _message(_id TEXT, _chatId TEXT, _createdTime INTEGER, _from TEXT, _text TEXT, _contentType INTEGER, _contentMetadata TEXT, _contentInfo TEXT, _attribute INTEGER)',
  // ASSUMPTION: real LINE schema/indexes are unknown (we never read the real DB). We add the
  // indexes a reader of `_createdTime > ?` would need; both engines see the identical file.
  'CREATE INDEX idx_message_created ON _message(_createdTime)',
  'CREATE INDEX idx_message_chat_created ON _message(_chatId, _createdTime)',
  // int64 probe: LINE-style 18/19-digit integers beyond Number.MAX_SAFE_INTEGER
  'CREATE TABLE _int64probe(k TEXT, v INTEGER)',
]

const ME = 'u' + 'f'.repeat(32)
const WORDS = ['明天', '下午三點', '開會', '請幫忙', '確認', '報價單', '客戶', '專案', '進度', '回覆', 'OK', '收到', '謝謝', '🙏', '😀', 'deadline', '週五前', '交付', '付款', '發票', '提醒我', '記得', '待辦', '檔案', '已上傳']
function sentence() { const n = 3 + Math.floor(rnd() * 25); const w = []; for (let i = 0; i < n; i++) w.push(pick(WORDS)); return w.join(rnd() < 0.5 ? ' ' : '') }

function buildPeople() {
  const contacts = []
  for (let i = 0; i < 150; i++) {
    const mid = 'u' + hex(32)
    const mode = i % 3
    contacts.push({
      mid,
      over: mode === 0 ? `覆寫名${i}` : null,
      disp: mode === 1 ? `聯絡人${i}` : null,
      detail: i === 149 ? '{bad json' : mode === 2 ? JSON.stringify({ profileName: `檔案名${i}`, statusMessage: 'hi' }) : null,
    })
  }
  const groups = []
  for (let i = 0; i < 120; i++) groups.push({ mid: 'c' + hex(32), name: i === 7 ? '重複群組名' : i === 8 ? '重複群組名' : `專案群組${i}號🚀` })
  const squares = []
  for (let i = 0; i < 30; i++) squares.push({ mid: 'm' + hex(32), name: `社群${i}` })
  return { contacts, groups, squares }
}

function createDb(file, journal) {
  for (const ext of ['', '-wal', '-shm', '-journal']) { try { fs.rmSync(file + ext) } catch {} }
  const db = new Database(file)
  db.pragma(`cipher='${CIPHER}'`)
  db.pragma(`kdf_iter=${KDF_ITER}`)
  db.pragma(`key='${KEY}'`)
  db.pragma(`journal_mode=${journal}`)
  for (const s of SCHEMA) db.exec(s)
  return db
}

// Local-time month boundaries (machine TZ) to exercise strftime(...,'localtime') in reconcile.
function localMs(y, m, d, hh = 0, mi = 0, ss = 0, ms = 0) { return new Date(y, m - 1, d, hh, mi, ss, ms).getTime() }

function fill(db, people, startRowCount, n, t0, stepMs) {
  const { contacts, groups, squares } = people
  const chats = [...contacts.map((c) => c.mid), ...groups.map((g) => g.mid), ...squares.map((s) => s.mid)]
  const ins = db.prepare('INSERT INTO _message(_id,_chatId,_createdTime,_from,_text,_contentType,_contentMetadata,_contentInfo,_attribute) VALUES (?,?,?,?,?,?,?,?,?)')
  const cts = [0, 0, 0, 0, 0, 0, 1, 2, 3, 7, 6, 13, 14, 16]
  let t = t0
  const tx = db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const k = startRowCount + i
      // every 50th message shares the previous ms (rowid tie-break paging)
      if (k % 50 !== 0) t += 1 + Math.floor(rnd() * stepMs)
      const chat = pick(chats)
      const from = rnd() < 0.3 ? ME : (chat[0] === 'u' ? chat : pick(contacts).mid)
      const ct = pick(cts)
      const text = ct === 0 ? sentence() : null
      const meta = ct === 0 ? (rnd() < 0.2 ? JSON.stringify({ e2eeVersion: '2', MENTION: '{"MENTIONEES":[]}' }) : null) : JSON.stringify({ OBS_POP: 'b', FILE_NAME: `f${k}.bin`, FILE_SIZE: String(1000 + k) })
      const info = ct === 0 ? null : JSON.stringify({ size: 1000 + k })
      ins.run(String(500000000000000000n + BigInt(k)), chat, t, from, text, ct, meta, info, k % 7 === 0 ? 1 : 0)
    }
  })
  tx()
  return t
}

function boundaryRows(db, people) {
  // exact local-midnight month boundaries (inserted out of order; ORDER BY _createdTime handles it)
  const ins = db.prepare('INSERT INTO _message(_id,_chatId,_createdTime,_from,_text,_contentType,_contentMetadata,_contentInfo,_attribute) VALUES (?,?,?,?,?,?,?,?,?)')
  const c = people.groups[0].mid
  const marks = [localMs(2025, 3, 1, 0, 0, 0, 0), localMs(2025, 2, 28, 23, 59, 59, 999), localMs(2025, 7, 1, 0, 0, 0, 0), localMs(2025, 6, 30, 23, 59, 59, 999)]
  marks.forEach((ms, i) => ins.run(`boundary-${i}`, c, ms, ME, `月界測試${i}`, 0, null, null, 0))
}

function chatsAndPeople(db, people, lastT) {
  const { contacts, groups, squares } = people
  db.prepare('INSERT INTO _profile(_mid) VALUES (?)').run(ME)
  const ic = db.prepare('INSERT INTO _contact VALUES (?,?,?,?)')
  for (const c of contacts) ic.run(c.mid, c.over, c.disp, c.detail)
  const ig = db.prepare('INSERT INTO _groupChat VALUES (?,?)')
  for (const g of groups) ig.run(g.mid, g.name)
  const is = db.prepare('INSERT INTO _square VALUES (?,?)')
  for (const s of squares) is.run(s.mid, s.name)
  const ich = db.prepare('INSERT INTO _chat VALUES (?,?,?)')
  let t = lastT
  for (const id of [...contacts.map((c) => c.mid), ...groups.map((g) => g.mid), ...squares.map((s) => s.mid)]) { t -= 1000 + Math.floor(rnd() * 100000); ich.run(id, t, 'last') }
  const ip = db.prepare('INSERT INTO _int64probe VALUES (?,?)')
  ip.run('max', 9223372036854775807n); ip.run('lineLike', 534567890123456789n); ip.run('safe', 9007199254740991)
}

function digestRows(db) {
  const h = crypto.createHash('sha256')
  for (const r of db.prepare('SELECT rowid AS r,_id,_chatId,_createdTime,_from,_text,_contentType,_contentMetadata,_contentInfo,_attribute FROM _message ORDER BY rowid').raw().iterate()) h.update(JSON.stringify(r) + '\n')
  return h.digest('hex')
}

function truth(db) {
  return {
    messageCount: db.prepare('SELECT count(*) AS c FROM _message').get().c,
    maxRow: db.prepare('SELECT rowid AS rowId,_createdTime AS createdTime,_id AS id,_text AS text FROM _message ORDER BY _createdTime DESC, rowid DESC LIMIT 1').get(),
    chatCount: db.prepare('SELECT count(*) AS c FROM _chat').get().c,
    messageDigest: digestRows(db),
  }
}

fs.mkdirSync(outDir, { recursive: true })
const T0 = localMs(2025, 1, 1, 9)
const STEP = 400000 // ~ avg 200 s between messages -> 100k msgs span ~7.5 months (crosses month boundaries)
const expected = { key: KEY, cipher: CIPHER, kdfIter: KDF_ITER, generator: { electron: process.versions.electron, node: process.versions.node, abi: process.versions.modules }, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, tzOffsetMin: new Date().getTimezoneOffset() }

// --- rollback-journal fixture ---
{
  seed = 0x5eed1234
  const people = buildPeople()
  const dir = path.join(outDir, 'rollback'); fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'm.edb')
  const db = createDb(file, 'DELETE')
  expected.sqlite3mcVersion = db.prepare('select sqlite3mc_version() AS v').get().v
  expected.sqliteVersion = db.prepare('select sqlite_version() AS v').get().v
  const lastT = fill(db, people, 0, BASE_N, T0, STEP)
  boundaryRows(db, people)
  chatsAndPeople(db, people, lastT)
  expected.rollback = { ...truth(db), journalMode: db.pragma('journal_mode', { simple: true }), pageSize: db.pragma('page_size', { simple: true }) }
  db.close()
  expected.rollback.files = fs.readdirSync(dir).map((f) => ({ f, bytes: fs.statSync(path.join(dir, f)).size }))
}

// --- WAL fixture: base checkpointed, newest WAL_N rows only in -wal, snapshot while open ---
{
  seed = 0x5eed1234
  const people = buildPeople()
  const dir = path.join(outDir, 'wal'); fs.mkdirSync(dir, { recursive: true })
  const live = path.join(dir, 'live'); fs.mkdirSync(live, { recursive: true })
  const file = path.join(live, 'm.edb')
  const db = createDb(file, 'WAL')
  const lastT = fill(db, people, 0, BASE_N, T0, STEP)
  boundaryRows(db, people)
  chatsAndPeople(db, people, lastT)
  db.pragma('wal_checkpoint(TRUNCATE)')
  const base = truth(db)
  db.pragma('wal_autocheckpoint=0')
  const walFirst = db.prepare('SELECT max(rowid) AS r FROM _message').get().r + 1
  const lastT2 = fill(db, people, BASE_N, WAL_N, lastT + 60000, 5000)
  // chat/contact changes that exist only in the WAL
  db.prepare('UPDATE _chat SET _lastUpdatedTime=? WHERE _id=?').run(lastT2 + 1, people.groups[3].mid)
  db.prepare('INSERT INTO _contact VALUES (?,?,?,?)').run('u' + 'e'.repeat(32), null, 'WAL新聯絡人', null)
  db.prepare('INSERT INTO _chat VALUES (?,?,?)').run('u' + 'e'.repeat(32), lastT2 + 2, 'last')
  const full = truth(db)
  // snapshot the three files while the writer is still open (like copying a live LINE DB)
  for (const ext of ['', '-wal', '-shm']) fs.copyFileSync(file + ext, path.join(dir, 'm.edb' + ext))
  expected.wal = {
    ...full, journalMode: db.pragma('journal_mode', { simple: true }),
    baseOnly: { messageCount: base.messageCount, messageDigest: base.messageDigest },
    walFirstRowId: walFirst, walRows: WAL_N, walOnlyContact: 'u' + 'e'.repeat(32), walTouchedGroup: people.groups[3].mid,
    // incremental-read cursor used by the benchmark: the last checkpointed row (so the read
    // returns rows that exist only in the WAL)
    cursorAtWalBoundary: db.prepare('SELECT _createdTime AS createdTime, rowid AS rowId FROM _message WHERE rowid<? ORDER BY _createdTime DESC, rowid DESC LIMIT 1').get(walFirst),
  }
  db.close()
  fs.rmSync(live, { recursive: true, force: true })
  expected.wal.files = fs.readdirSync(dir).map((f) => ({ f, bytes: fs.statSync(path.join(dir, f)).size }))
}

// sanity: snapshot is really encrypted (no plaintext SQLite header, no plaintext text)
const head = fs.readFileSync(path.join(outDir, 'wal', 'm.edb')).subarray(0, 16).toString('latin1')
expected.encryptedHeaderCheck = { first16: Buffer.from(head, 'latin1').toString('hex'), isPlainSqliteHeader: head.startsWith('SQLite format 3') }
const walBuf = fs.readFileSync(path.join(outDir, 'wal', 'm.edb-wal'))
expected.walPlaintextLeak = walBuf.includes(Buffer.from('月界測試', 'utf8')) || walBuf.includes(Buffer.from('WAL新聯絡人', 'utf8'))
fs.writeFileSync(path.join(outDir, 'expected.json'), JSON.stringify(expected, null, 2))
console.log(JSON.stringify(expected, null, 2))
