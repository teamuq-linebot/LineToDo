// Synthetic LINE-shaped fixture WITH E2EE media (Phase 3 contract test). Runs under Electron 31 run-as-node (no permission flags) with the
// better-sqlite3-multiple-ciphers 11.10.0 binary line-todo (standalone) ships; same cipher parameter sequence linedb.ts uses.
// Everything is synthetic: the DB key and every media key are made-up constants; no real LINE data, key or cache file is read.
//
// Produces, in <outDir>:
//   linedir/qw0f0f.edb                 journal_mode=DELETE; chats, 4 text messages and 6 image messages (content type 1) whose `_contentInfo` carries a
//                                      `keyMaterial` and `_contentMetadata` a `FILE_SIZE`, exactly the shape rowToObj.mediaFields() reads
//   cache/Cache-like tree              LINE's `Cache\...\*.eimg` files (HKDF-SHA256 + AES-256-CTR + HMAC trailer, the recipe media/decrypt.ts reverses)
//   expected.json                      { key, messageCount, messages: { <name>: { msgId, kind, sha256, size } } }
//
// kinds: png / jpeg / gif (cached, decryptable), notcached (no .eimg), wrongkey (a same-size candidate encrypted with another key), text (an image row
//        whose plaintext is not an image: unsupported_format)
// Usage: ELECTRON_RUN_AS_NODE=1 BSQLITE3MC_DIR=<node_modules/better-sqlite3-multiple-ciphers> electron31.exe scripts/lib/gen-line-media-fixture.cjs <outDir>
'use strict'
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
if (!process.env.BSQLITE3MC_DIR) throw new Error('BSQLITE3MC_DIR is required')
const Database = require(process.env.BSQLITE3MC_DIR)
const outDir = process.argv[2]
if (!outDir) throw new Error('usage: gen-line-media-fixture.cjs <outDir>')

const KEY = '0123456789abcdef0123456789abcdef' // synthetic DB key (32-hex, LINE-shaped)
const ME = 'u' + 'f'.repeat(32)
const ALICE = 'u' + 'a'.repeat(32)
const BOB = 'u' + 'b'.repeat(32)

const ikm = (n) => Buffer.alloc(32, n)
function encryptEimg(plain, keyMaterial) {
  const derived = Buffer.from(crypto.hkdfSync('sha256', keyMaterial, Buffer.alloc(32, 0), Buffer.from('FileEncryption'), 76))
  const nonce = Buffer.concat([derived.subarray(64, 76), Buffer.alloc(4, 0)])
  const cipher = crypto.createCipheriv('aes-256-ctr', derived.subarray(0, 32), nonce)
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([ciphertext, crypto.createHmac('sha256', derived.subarray(32, 64)).update(ciphertext).digest()])
}
const filler = (n, seed) => { const b = Buffer.alloc(n); let s = seed; for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; b[i] = s & 0xff } return b }
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), filler(2300, 1)])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), filler(1500, 2)])
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), filler(900, 3)])
const NOT_AN_IMAGE = Buffer.from('this plaintext is not an image, it is just text '.repeat(8))

const images = [
  { name: 'png', kind: 'png', plain: PNG, key: ikm(11), cached: true },
  { name: 'jpeg', kind: 'jpeg', plain: JPEG, key: ikm(12), cached: true },
  { name: 'gif', kind: 'gif', plain: GIF, key: ikm(13), cached: true },
  { name: 'notcached', kind: 'notcached', plain: filler(777, 4), key: ikm(14), cached: false },
  { name: 'wrongkey', kind: 'wrongkey', plain: filler(640, 5), key: ikm(15), cached: false, decoyKey: ikm(99) },
  { name: 'text', kind: 'text', plain: NOT_AN_IMAGE, key: ikm(16), cached: true },
]

fs.mkdirSync(path.join(outDir, 'linedir'), { recursive: true })
const file = path.join(outDir, 'linedir', 'qw0f0f.edb')
for (const ext of ['', '-wal', '-shm', '-journal']) { try { fs.rmSync(file + ext) } catch {} }
const db = new Database(file)
db.pragma("cipher='aes128cbc'")
db.pragma('kdf_iter=1')
db.pragma(`key='${KEY}'`)
db.pragma('journal_mode=DELETE')
for (const stmt of [
  'CREATE TABLE _profile(_mid TEXT)',
  'CREATE TABLE _chat(_id TEXT PRIMARY KEY, _lastUpdatedTime INTEGER, _lastMessage TEXT)',
  'CREATE TABLE _groupChat(_chatMid TEXT PRIMARY KEY, _chatName TEXT)',
  'CREATE TABLE _square(_mid TEXT PRIMARY KEY, _name TEXT)',
  'CREATE TABLE _contact(_mid TEXT PRIMARY KEY, _displayNameOverridden TEXT, _displayName TEXT, _targetProfileDetail TEXT)',
  'CREATE TABLE _message(_id TEXT, _chatId TEXT, _createdTime INTEGER, _from TEXT, _text TEXT, _contentType INTEGER, _contentMetadata TEXT, _contentInfo TEXT, _attribute INTEGER)',
  'CREATE INDEX idx_message_created ON _message(_createdTime)',
  'CREATE INDEX idx_message_chat_created ON _message(_chatId, _createdTime)',
]) db.exec(stmt)
db.prepare('INSERT INTO _profile(_mid) VALUES (?)').run(ME)
const contact = db.prepare('INSERT INTO _contact VALUES (?,?,?,?)')
contact.run(ALICE, null, 'Alice', null)
contact.run(BOB, null, 'Bob', null)
const t0 = new Date(2026, 8, 20, 10, 0, 0).getTime()
const chat = db.prepare('INSERT INTO _chat VALUES (?,?,?)')
chat.run(ALICE, t0 + 100000, 'last')
chat.run(BOB, t0 + 100000, 'last')
const ins = db.prepare('INSERT INTO _message(_id,_chatId,_createdTime,_from,_text,_contentType,_contentMetadata,_contentInfo,_attribute) VALUES (?,?,?,?,?,?,?,?,?)')

const expected = { key: KEY, messageCount: 0, messages: {} }
let i = 0
const nextId = () => String(600000000000000000n + BigInt(++i))
for (const text of ['早安，今天的進度如何？', '我晚點把報價單寄給你', '收到，謝謝', '圖片我先傳給你']) {
  const id = nextId()
  ins.run(id, ALICE, t0 + i * 1000, ALICE, text, 0, null, null, 0)
  expected.messageCount += 1
}
const cacheRoot = path.join(outDir, 'cache', 'AB', 'cd')
fs.mkdirSync(cacheRoot, { recursive: true })
for (const image of images) {
  const id = nextId()
  const meta = JSON.stringify({ OBS_POP: 'b', FILE_SIZE: String(image.plain.length) })
  const info = JSON.stringify({ keyMaterial: image.key.toString('base64') })
  ins.run(id, BOB, t0 + i * 1000, BOB, null, 1, meta, info, 0)
  expected.messageCount += 1
  if (image.cached) fs.writeFileSync(path.join(cacheRoot, `${image.name}-${crypto.randomBytes(4).toString('hex')}.eimg`), encryptEimg(image.plain, image.key))
  // a candidate with the right size that was encrypted with ANOTHER key (the HMAC must reject it)
  if (image.decoyKey) fs.writeFileSync(path.join(cacheRoot, `${image.name}-decoy.eimg`), encryptEimg(image.plain, image.decoyKey))
  expected.messages[image.name] = { msgId: `i:${id}`, kind: image.kind, size: image.plain.length, sha256: crypto.createHash('sha256').update(image.plain).digest('hex') }
}
db.close()
fs.writeFileSync(path.join(outDir, 'expected.json'), JSON.stringify(expected, null, 2))
console.log(JSON.stringify({ ok: true, messageCount: expected.messageCount }))
