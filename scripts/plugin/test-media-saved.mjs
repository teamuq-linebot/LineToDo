// media-saved（M1，共用顯示鏈 backend）：media.prepare 先查 <dataDir>/media-saved/（Pro 寫入；免費版永遠是空的），再查 media-cache/。
// 同時新增 media.prepareVideo（ct=2，只看 media-saved）與 media.savedFile（ct=14，讀 <stem>.file.json 並驗證）。
// 測試用合成的 DB、解密器與索引，不碰真實 LINE 或 TeamUQ 資料。
//
// 「免費版中性」案例（neutral）只用既有 API，改動前後都必須綠燈：media-saved 不存在時，prepare 的每個結果與改動前一致。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs, { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import test from 'node:test'

import { Dispatcher } from '../../src/plugin/backend/dispatcher.ts'
import { EventHub } from '../../src/plugin/backend/eventHub.ts'
import { createPluginMedia, mediaCacheStem } from '../../src/plugin/backend/media.ts'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)])
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 3)])
const STEM = mediaCacheStem('i:1')
const VIDEO_STEM = mediaCacheStem('i:v1')
const FILE_STEM = mediaCacheStem('i:f1')

function tmpDataDir() { return mkdtempSync(join(tmpdir(), 'media-saved-')) }
function row(over = {}) { return { key_material: 'AAAA', file_size: 100, content_type: 1, ...over } }
/** rows: Map<msgId, row>；rows 為 null＝資料庫未開。`throwOnQuery` 模擬查詢失敗。 */
function db(rows, { throwOnQuery = false } = {}) {
  return { prepare: () => ({ get: (id) => { if (throwOnQuery) throw new Error('locked'); return rows.get(id) } }) }
}
function decryptor(result) {
  const calls = { decrypt: 0 }
  return { calls, decrypt() { calls.decrypt += 1; return typeof result === 'function' ? result() : result } }
}
function fakeIndex({ available = true, ready = true } = {}) {
  const calls = { noteMiss: 0, isAvailable: 0, isReady: 0 }
  return {
    calls,
    candidates: () => [], onUnreadable() {}, markStale() {}, start() {}, async dispose() {},
    noteMiss() { calls.noteMiss += 1 },
    isAvailable() { calls.isAvailable += 1; return available },
    isReady() { calls.isReady += 1; return ready },
    status() { return { available, ready, rows: 0 } }
  }
}
function makeMedia(dataDir, { rows = new Map([['i:1', row()]]), dec = null, idx = null, throwOnQuery = false, cap } = {}) {
  return createPluginMedia({
    dataDir,
    getDb: () => (rows === null ? null : db(rows, { throwOnQuery })),
    decryptor: dec,
    index: idx,
    ...(cap ? { maxCacheBytes: cap } : {})
  })
}
function put(dataDir, relPath, bytes) {
  const abs = join(dataDir, ...relPath.split('/'))
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, bytes)
  return abs
}
/** 寫 `media-saved/<i:f1 的 stem>.file.json`（v:1），欄位可覆寫。 */
function writeMeta(dataDir, rel, over = {}) {
  mkdirSync(join(dataDir, 'media-saved'), { recursive: true })
  writeFileSync(join(dataDir, 'media-saved', `${FILE_STEM}.file.json`), JSON.stringify({ v: 1, name: 'report.pdf', bytes: 1234, mime: 'application/pdf', rel, ...over }))
}

// ───────────── 免費版中性（改動前後都要綠）─────────────

test('neutral: with no media-saved directory, every media.prepare result equals the pre-change result (codes, messages, paths, cached flag, no writes to media-saved)', () => {
  const ready = fakeIndex()
    const notReady = fakeIndex({ ready: false })
    const unavailable = fakeIndex({ available: false })
    const scenarios = [
      ['no decryptor and no index', { dec: null, idx: null }, 'i:1', { ok: false, code: 'media_unavailable', message: 'the LINE cache directory is unknown' }],
      ['index unavailable', { dec: decryptor({ status: 'ok', bytes: PNG, mime: 'image/png' }), idx: unavailable }, 'i:1', { ok: false, code: 'media_unavailable', message: 'the media index is unavailable' }],
      ['not downloaded, index ready', { dec: decryptor({ status: 'not-cached' }), idx: ready }, 'i:1', { ok: false, code: 'not_cached', message: 'not downloaded in LINE yet' }],
      ['not downloaded, index still building', { dec: decryptor({ status: 'not-cached' }), idx: notReady }, 'i:1', { ok: false, code: 'not_cached', message: `the LINE cache index is still being built (索引建立中; ${'index_building'}), try again shortly` }],
      ['decrypt ok png', { dec: decryptor({ status: 'ok', bytes: PNG, mime: 'image/png' }), idx: ready }, 'i:1', { ok: true, path: `media-cache/${STEM}.png`, mime: 'image/png', size: PNG.length, cached: false }],
      ['database not open', { rows: null, dec: decryptor({ status: 'ok', bytes: PNG, mime: 'image/png' }), idx: ready }, 'i:1', { ok: false, code: 'media_unavailable', message: 'the database is not open' }],
      ['database not open and no decryptor', { rows: null, dec: null, idx: null }, 'i:1', { ok: false, code: 'media_unavailable', message: 'the LINE cache directory is unknown' }],
      ['database query fails', { throwOnQuery: true, dec: decryptor({ status: 'ok', bytes: PNG, mime: 'image/png' }), idx: ready }, 'i:1', { ok: false, code: 'media_unavailable', message: 'the database is not readable' }],
      ['database query fails and no decryptor', { throwOnQuery: true, dec: null, idx: null }, 'i:1', { ok: false, code: 'media_unavailable', message: 'the LINE cache directory is unknown' }],
      ['message not found', { rows: new Map(), dec: decryptor({ status: 'ok', bytes: PNG, mime: 'image/png' }), idx: ready }, 'i:1', { ok: false, code: 'not_found', message: 'no such message' }],
      ['message not found and no decryptor', { rows: new Map(), dec: null, idx: null }, 'i:1', { ok: false, code: 'media_unavailable', message: 'the LINE cache directory is unknown' }],
      ['not an image', { rows: new Map([['i:1', row({ content_type: 14 })]]), dec: decryptor({ status: 'ok', bytes: PNG, mime: 'image/png' }), idx: ready }, 'i:1', { ok: false, code: 'not_image', message: 'only images are served in the plugin' }],
      ['not an image and no decryptor', { rows: new Map([['i:1', row({ content_type: 14 })]]), dec: null, idx: null }, 'i:1', { ok: false, code: 'media_unavailable', message: 'the LINE cache directory is unknown' }],
      ['no key material', { rows: new Map([['i:1', row({ key_material: null })]]), dec: decryptor({ status: 'ok', bytes: PNG, mime: 'image/png' }), idx: ready }, 'i:1', { ok: false, code: 'no_key', message: 'the message has no decryption info' }],
      ['hmac mismatch', { dec: decryptor({ status: 'hmac-miss' }), idx: ready }, 'i:1', { ok: false, code: 'hmac_miss', message: 'the cached file does not match the key' }],
      ['decrypt error', { dec: decryptor({ status: 'error' }), idx: ready }, 'i:1', { ok: false, code: 'decrypt_error', message: 'decryption failed' }],
      ['unsupported mime', { dec: decryptor({ status: 'ok', bytes: PNG, mime: 'image/bmp' }), idx: ready }, 'i:1', { ok: false, code: 'unsupported_format', message: 'unsupported image format (image/bmp)' }],
      ['invalid msgId', { dec: decryptor({ status: 'ok', bytes: PNG, mime: 'image/png' }), idx: ready }, undefined, { ok: false, code: 'invalid_args', message: 'msgId must be a non-empty string' }]
    ]
    // 每個情境用全新的 dataDir：decrypt 成功會寫 media-cache，不能讓前一個情境的快取影響後面的結果。
    for (const [name, opts, msgId, expected] of scenarios) {
      const dataDir = tmpDataDir()
      try {
        assert.deepEqual(makeMedia(dataDir, opts).prepare(msgId), expected, `scenario: ${name}`)
        assert.equal(existsSync(join(dataDir, 'media-saved')), false, `scenario ${name}: media-saved is not created`)
      } finally { rmSync(dataDir, { recursive: true, force: true }) }
    }
    // 既有 media-cache 的快取命中：沒有解密器或索引時，在檢查目錄之前就回 media_unavailable（改動前後相同）。
    const cacheDir = tmpDataDir()
    try {
      put(cacheDir, `media-cache/${STEM}.jpg`, JPG)
      assert.deepEqual(makeMedia(cacheDir, { dec: null, idx: null }).prepare('i:1'), { ok: false, code: 'media_unavailable', message: 'the LINE cache directory is unknown' })
      assert.deepEqual(makeMedia(cacheDir, { dec: decryptor({ status: 'ok', bytes: PNG, mime: 'image/png' }), idx: ready }).prepare('i:1'), { ok: true, path: `media-cache/${STEM}.jpg`, mime: 'image/jpeg', size: JPG.length, cached: true }, 'with the decryptor and index, the cache hit is served')
    } finally { rmSync(cacheDir, { recursive: true, force: true }) }
})

// ───────────── media.prepare：media-saved 優先 ─────────────

test('media.prepare serves a saved image without a decryptor, an index or a key, and never decrypts it', () => {
  const dataDir = tmpDataDir()
  try {
    put(dataDir, `media-saved/${STEM}.png`, PNG)
    const dec = decryptor({ status: 'ok', bytes: JPG, mime: 'image/jpeg' })
    const bare = makeMedia(dataDir, { rows: new Map([['i:1', row({ key_material: null })]]), dec: null, idx: null })
    assert.deepEqual(bare.prepare('i:1'), { ok: true, path: `media-saved/${STEM}.png`, mime: 'image/png', size: PNG.length, cached: true })
    const withDec = makeMedia(dataDir, { rows: new Map([['i:1', row({ key_material: null })]]), dec, idx: fakeIndex() })
    assert.equal(withDec.prepare('i:1').path, `media-saved/${STEM}.png`)
    assert.equal(dec.calls.decrypt, 0, 'a saved file is served without touching the decryptor')
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})

test('media.prepare prefers media-saved over media-cache for the same message', () => {
  const dataDir = tmpDataDir()
  try {
    put(dataDir, `media-cache/${STEM}.jpg`, JPG)
    put(dataDir, `media-saved/${STEM}.png`, PNG)
    const res = makeMedia(dataDir, { dec: decryptor({ status: 'ok', bytes: JPG, mime: 'image/jpeg' }), idx: fakeIndex() }).prepare('i:1')
    assert.deepEqual(res, { ok: true, path: `media-saved/${STEM}.png`, mime: 'image/png', size: PNG.length, cached: true })
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})

test('media.prepare: a saved entry that is a symlink or a directory is not served; the cache and LINE decide as before', (t) => {
  const dataDir = tmpDataDir()
  const outside = tmpDataDir()
  try {
    const target = put(outside, 'loot.png', PNG)
    mkdirSync(join(dataDir, 'media-saved'), { recursive: true })
    try { symlinkSync(target, join(dataDir, 'media-saved', `${STEM}.png`), 'file') } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip(`file symlink needs privilege: ${error.code}`); return }
      throw error
    }
    const media = makeMedia(dataDir, { dec: decryptor({ status: 'not-cached' }), idx: fakeIndex() })
    assert.equal(media.prepare('i:1').code, 'not_cached', 'a symlink in media-saved is not followed')
    mkdirSync(join(dataDir, 'media-saved', `${mediaCacheStem('i:2')}.png`))
    assert.equal(makeMedia(dataDir, { rows: new Map([['i:2', row()]]), dec: decryptor({ status: 'not-cached' }), idx: fakeIndex() }).prepare('i:2').code, 'not_cached', 'a directory in media-saved is not served')
  } finally { rmSync(dataDir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
})

test('media.prepare never creates media-saved and never writes into it', () => {
  const dataDir = tmpDataDir()
  try {
    makeMedia(dataDir, { dec: decryptor({ status: 'ok', bytes: PNG, mime: 'image/png' }), idx: fakeIndex() }).prepare('i:1')
    assert.equal(existsSync(join(dataDir, 'media-saved')), false)
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})

// ───────────── media.prepareVideo（ct=2，只看 media-saved）─────────────

test('prepareVideo returns a saved mp4, mov or webm with its MIME; a message without a saved file is not_cached; no decryptor is needed', () => {
  const dataDir = tmpDataDir()
  try {
    const bytes = Buffer.alloc(300, 1)
    const rows = new Map([['i:v1', row({ content_type: 2 })], ['i:v2', row({ content_type: 2 })], ['i:v3', row({ content_type: 2 })], ['i:v4', row({ content_type: 2 })]])
    put(dataDir, `media-saved/${mediaCacheStem('i:v1')}.mp4`, bytes)
    put(dataDir, `media-saved/${mediaCacheStem('i:v2')}.mov`, bytes)
    put(dataDir, `media-saved/${mediaCacheStem('i:v3')}.webm`, bytes)
    const dec = decryptor({ status: 'ok', bytes, mime: 'video/mp4' })
    const media = makeMedia(dataDir, { rows, dec: null, idx: null })
    assert.deepEqual(media.prepareVideo('i:v1'), { ok: true, path: `media-saved/${mediaCacheStem('i:v1')}.mp4`, mime: 'video/mp4', size: 300, cached: true })
    assert.deepEqual(media.prepareVideo('i:v2'), { ok: true, path: `media-saved/${mediaCacheStem('i:v2')}.mov`, mime: 'video/quicktime', size: 300, cached: true })
    assert.deepEqual(media.prepareVideo('i:v3'), { ok: true, path: `media-saved/${mediaCacheStem('i:v3')}.webm`, mime: 'video/webm', size: 300, cached: true })
    const miss = media.prepareVideo('i:v4')
    assert.equal(miss.ok, false)
    assert.equal(miss.code, 'not_cached', 'no saved file: 影片尚未下載 on the UI side')
    assert.equal(dec.calls.decrypt, 0)
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})

test('prepareVideo: an image message is not_video, an unknown message is not_found, no database is media_unavailable, invalid args are invalid_args', () => {
  const dataDir = tmpDataDir()
  try {
    const rows = new Map([['i:1', row({ content_type: 1 })]])
    const media = makeMedia(dataDir, { rows })
    assert.equal(media.prepareVideo('i:1').code, 'not_video')
    assert.equal(media.prepareVideo('i:none').code, 'not_found')
    assert.equal(media.prepareVideo(undefined).code, 'invalid_args')
    assert.equal(makeMedia(dataDir, { rows: null }).prepareVideo('i:1').code, 'media_unavailable')
    assert.equal(makeMedia(dataDir, { rows, throwOnQuery: true }).prepareVideo('i:1').code, 'media_unavailable')
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})

// ───────────── media.savedFile（ct=14）─────────────

const REL = 'saved-files/潘-chat--0123456789/20261113-101010_report.pdf'
function saveFileFixture(dataDir, meta = {}, { rel = REL, bytes = 1234, msgRow = row({ content_type: 14 }), body = Buffer.alloc(1234, 5) } = {}) {
  put(dataDir, rel, body)
  const json = JSON.stringify({ v: 1, name: 'report.pdf', bytes, mime: 'application/pdf', rel, ...meta })
  put(dataDir, `media-saved/${FILE_STEM}.file.json`, json)
  return new Map([['i:f1', msgRow]])
}

test('savedFile returns the verified entry: name, bytes, mime and an absolute path inside dataDir; previewPath only for image, video and audio types', () => {
  const dataDir = tmpDataDir()
  try {
    const rows = saveFileFixture(dataDir)
    const res = makeMedia(dataDir, { rows }).savedFile('i:f1')
    assert.deepEqual(res, { ok: true, name: 'report.pdf', bytes: 1234, mime: 'application/pdf', absPath: join(dataDir, ...REL.split('/')) })
    assert.ok(join(res.absPath).startsWith(dataDir), 'absolute path is inside dataDir')

    const imgRel = 'saved-files/chat--0123456789/a.png'
    put(dataDir, imgRel, PNG)
    put(dataDir, `media-saved/${mediaCacheStem('i:f2')}.file.json`, JSON.stringify({ v: 1, name: 'a.png', bytes: PNG.length, mime: 'image/png', rel: imgRel }))
    const rows2 = new Map([['i:f2', row({ content_type: 14 })]])
    const img = makeMedia(dataDir, { rows: rows2 }).savedFile('i:f2')
    assert.equal(img.previewPath, imgRel, 'a previewable type carries the relative path for assets.url()')
    assert.equal(img.ok, true)
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})

test('savedFile refuses unsafe rel values (traversal, absolute, drive, backslash, wrong prefix, dot segments, colon, NUL, empty)', () => {
  const dataDir = tmpDataDir()
  try {
    const bad = [
      '../outside.txt', 'saved-files/../../outside.txt', 'saved-files/../media-cache/x.png', '/etc/passwd', 'C:/Windows/win.ini', 'C:\\Windows\\win.ini',
      'saved-files\\..\\..\\x.txt', 'media-cache/x.png', 'saved-files/.hidden/x.txt', 'saved-files/a/./b.txt', 'saved-files//x.txt',
      'saved-files/a/b:stream.txt', 'saved-files/a/x\u0000.txt', '', 'saved-files/', 'saved-files/a/..'
    ]
    for (const rel of bad) {
      const rows = saveFileFixture(dataDir, {}, { rel: 'saved-files/ok/safe.bin' })
      writeFileSync(join(dataDir, 'media-saved', `${FILE_STEM}.file.json`), JSON.stringify({ v: 1, name: 'x', bytes: 1234, mime: 'application/octet-stream', rel }))
      const res = makeMedia(dataDir, { rows }).savedFile('i:f1')
      assert.equal(res.ok, false, `rel ${JSON.stringify(rel)} must be refused`)
      assert.equal(res.code, 'saved_invalid', `rel ${JSON.stringify(rel)}`)
      assert.equal('absPath' in res, false)
    }
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})

test('savedFile refuses a size that does not match the file, a missing file, corrupt or wrong-shaped metadata', () => {
  const dataDir = tmpDataDir()
  try {
    let rows = saveFileFixture(dataDir, { bytes: 999 })
    assert.equal(makeMedia(dataDir, { rows }).savedFile('i:f1').code, 'saved_size_mismatch')

    rows = saveFileFixture(dataDir)
    rmSync(join(dataDir, ...REL.split('/')))
    assert.equal(makeMedia(dataDir, { rows }).savedFile('i:f1').code, 'saved_missing')

    const metaPath = join(dataDir, 'media-saved', `${FILE_STEM}.file.json`)
    const shapes = ['{"v":1,', '[]', 'null', '"text"', JSON.stringify({ v: 2, name: 'n', bytes: 1, mime: 'a/b', rel: REL }), JSON.stringify({ v: 1, bytes: 1234, mime: 'a/b', rel: REL }), JSON.stringify({ v: 1, name: 'n', bytes: -1, mime: 'a/b', rel: REL }), JSON.stringify({ v: 1, name: 'n', bytes: 1.5, mime: 'a/b', rel: REL }), JSON.stringify({ v: 1, name: 'n', bytes: '1234', mime: 'a/b', rel: REL })]
    for (const shape of shapes) {
      rows = saveFileFixture(dataDir)
      writeFileSync(metaPath, shape)
      const res = makeMedia(dataDir, { rows }).savedFile('i:f1')
      assert.equal(res.ok, false, `meta ${shape}`)
      assert.equal(res.code, 'saved_meta_invalid', `meta ${shape}`)
    }
    rows = saveFileFixture(dataDir)
    writeFileSync(metaPath, 'x'.repeat(64 * 1024))
    assert.equal(makeMedia(dataDir, { rows }).savedFile('i:f1').code, 'saved_meta_invalid', 'an oversized metadata file is not read')
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})

test('savedFile: no metadata is not_saved (the free version), a non-file message is not_file, no database is media_unavailable', () => {
  const dataDir = tmpDataDir()
  try {
    const rows = new Map([['i:f1', row({ content_type: 14 })]])
    assert.equal(makeMedia(dataDir, { rows }).savedFile('i:f1').code, 'not_saved')
    const other = saveFileFixture(dataDir, {}, { msgRow: row({ content_type: 1 }) })
    assert.equal(makeMedia(dataDir, { rows: other }).savedFile('i:f1').code, 'not_file')
    assert.equal(makeMedia(dataDir, { rows: null }).savedFile('i:f1').code, 'media_unavailable')
    assert.equal(makeMedia(dataDir, { rows: new Map() }).savedFile('i:f1').code, 'not_found')
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})

test('savedFile refuses an entry whose directory (junction) points outside dataDir', (t) => {
  const dataDir = tmpDataDir()
  const outside = tmpDataDir()
  try {
    put(outside, 'secret.txt', Buffer.alloc(1234, 9))
    mkdirSync(join(dataDir, 'saved-files'), { recursive: true })
    try { symlinkSync(outside, join(dataDir, 'saved-files', 'chat--link'), 'junction') } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip(`junction needs privilege: ${error.code}`); return }
      throw error
    }
    // 只寫 metadata，不經過連結寫入任何檔案（連結指向 dataDir 之外）。
    writeMeta(dataDir, 'saved-files/chat--link/secret.txt', { name: 'secret.txt', bytes: 1234, mime: 'text/plain' })
    const rows = new Map([['i:f1', row({ content_type: 14 })]])
    const res = makeMedia(dataDir, { rows }).savedFile('i:f1')
    assert.equal(res.ok, false)
    assert.equal(res.code, 'saved_link', 'a junction on the path is refused, not followed')
  } finally { rmSync(dataDir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
})

test('savedFile refuses a file symlink inside saved-files and a symlinked metadata file', (t) => {
  const dataDir = tmpDataDir()
  const outside = tmpDataDir()
  try {
    const target = put(outside, 'secret.bin', Buffer.alloc(1234, 9))
    const rel = 'saved-files/chat--a/linked.bin'
    mkdirSync(join(dataDir, 'saved-files', 'chat--a'), { recursive: true })
    mkdirSync(join(dataDir, 'media-saved'), { recursive: true })
    try { symlinkSync(target, join(dataDir, ...rel.split('/')), 'file') } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip(`file symlink needs privilege: ${error.code}`); return }
      throw error
    }
    writeMeta(dataDir, rel, { name: 'linked.bin', bytes: 1234, mime: 'application/octet-stream' })
    const rows = new Map([['i:f1', row({ content_type: 14 })]])
    assert.equal(makeMedia(dataDir, { rows }).savedFile('i:f1').code, 'saved_link', 'a symlink file is refused')

    mkdirSync(join(dataDir, 'media-saved'), { recursive: true })
    const metaLink = join(dataDir, 'media-saved', `${mediaCacheStem('i:f3')}.file.json`)
    const jsonTarget = put(outside, 'meta.json', JSON.stringify({ v: 1, name: 'n', bytes: 1234, mime: 'a/b', rel: 'saved-files/chat--a/linked.bin' }))
    symlinkSync(jsonTarget, metaLink, 'file')
    assert.equal(makeMedia(dataDir, { rows: new Map([['i:f3', row({ content_type: 14 })]]) }).savedFile('i:f3').code, 'saved_link', 'a symlinked metadata file is refused')
  } finally { rmSync(dataDir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
})

// ───────────── prune 與 dispatcher ─────────────

test('prune trims only media-cache: a saved file is never removed, and the cache is still pruned to its target', () => {
  const dataDir = tmpDataDir()
  try {
    const keep = put(dataDir, `media-saved/${mediaCacheStem('i:saved')}.png`, Buffer.alloc(5000, 1))
    for (let i = 0; i < 3; i += 1) put(dataDir, `media-cache/${mediaCacheStem(`old${i}`)}.png`, Buffer.alloc(600, 2))
    const media = makeMedia(dataDir, { rows: new Map([['i:1', row()]]), dec: decryptor({ status: 'ok', bytes: PNG, mime: 'image/png' }), idx: fakeIndex(), cap: 1000 })
    assert.equal(media.prepare('i:1').ok, true)
    assert.equal(existsSync(keep), true, 'media-saved is outside the cache budget')
    const remaining = ['old0', 'old1', 'old2'].filter((k) => existsSync(join(dataDir, 'media-cache', `${mediaCacheStem(k)}.png`)))
    assert.ok(remaining.length < 3, 'the cache was pruned')
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})

test('dispatcher routes media.prepareVideo and media.savedFile through the media group and returns in-band envelopes', async () => {
  const dataDir = tmpDataDir()
  try {
    const rows = saveFileFixture(dataDir)
    put(dataDir, `media-saved/${mediaCacheStem('i:v1')}.mp4`, Buffer.alloc(300, 1))
    rows.set('i:v1', row({ content_type: 2 }))
    const media = makeMedia(dataDir, { rows })
    const hub = new EventHub()
    const d = new Dispatcher({ getApi: () => ({}), hub, queue: { stats: () => ({}) }, media })
    const video = await d.call('media', { path: 'media.prepareVideo', args: ['i:v1'] })
    assert.deepEqual(video, { ok: true, value: { ok: true, path: `media-saved/${mediaCacheStem('i:v1')}.mp4`, mime: 'video/mp4', size: 300, cached: true } })
    const file = await d.call('media', { path: 'media.savedFile', args: ['i:f1'] })
    assert.equal(file.ok, true)
    assert.equal(file.value.name, 'report.pdf')
    assert.equal(file.value.absPath, join(dataDir, ...REL.split('/')))
    const noMedia = new Dispatcher({ getApi: () => ({}), hub, queue: { stats: () => ({}) } })
    assert.equal((await noMedia.call('media', { path: 'media.prepareVideo', args: ['i:v1'] })).code, 'media_unavailable')
    assert.equal((await noMedia.call('media', { path: 'media.savedFile', args: ['i:f1'] })).code, 'media_unavailable')
    d.dispose(); noMedia.dispose(); hub.dispose()
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})

// ───────────── R-M01：實際路徑必須在 dataDir 底下（磁碟區 GUID junction、realpath 越界）；讀 meta 時比對 ino 與大小 ─────────────

/**
 * 在 `link` 建一個指向 `targetDir` 的「磁碟區 GUID」junction（`\\?\Volume{…}\<子路徑>`）。libuv 的 lstat 把這種 junction 回報成一般目錄，
 * 所以逐段 lstat 擋不住。不是 Windows、或 mountvol／mklink 失敗時回 `{ skip: 原因 }`。
 */
function volumeJunction(link, targetDir) {
  if (process.platform !== 'win32') return { skip: 'volume GUID junctions exist only on Windows' }
  const real = realpathSync.native(targetDir)
  const mv = spawnSync('mountvol', [real.slice(0, 3), '/L'], { encoding: 'utf8' })
  const guid = (mv.stdout ?? '').trim()
  if (mv.status !== 0 || !/^\\\\\?\\Volume\{[0-9a-fA-F-]+\}\\$/.test(guid)) return { skip: `mountvol gave no volume GUID for ${real.slice(0, 3)} (exit ${mv.status}): ${(mv.stderr ?? '').trim()}` }
  const mk = spawnSync('cmd', ['/c', 'mklink', '/J', link, guid + real.slice(3)], { encoding: 'utf8' })
  let st = null
  try { st = lstatSync(link) } catch { /* 沒建成 */ }
  if (mk.status !== 0 || !st) return { skip: `mklink /J to a volume GUID path failed (exit ${mk.status}): ${(mk.stderr || mk.stdout || '').trim()}` }
  return { reportedAsDirectory: st.isDirectory() && !st.isSymbolicLink() }
}
/** 先以非遞迴 rmdirSync 拆掉 junction（遞迴刪除會把磁碟區 junction 當目錄走進去），拆掉後才遞迴刪暫存目錄；拆不掉就留著並讓測試失敗。 */
function cleanupWithJunction(link, ...dirs) {
  try { lstatSync(link); rmdirSync(link) } catch (error) { if (error.code !== 'ENOENT') throw new Error(`junction ${link} could not be removed; temp dirs left in place: ${dirs.join(', ')}`) }
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
}

test('R-M01 volume junction in saved-files: savedFile refuses a saved file reached through a volume-GUID junction (lstat sees a plain directory)', (t) => {
  const dataDir = tmpDataDir()
  const outside = tmpDataDir()
  const link = join(dataDir, 'saved-files', 'chat--vol')
  try {
    put(outside, 'secret.txt', Buffer.alloc(1234, 9))
    mkdirSync(join(dataDir, 'saved-files'), { recursive: true })
    const made = volumeJunction(link, outside)
    if (made.skip) { t.skip(made.skip); return }
    assert.equal(made.reportedAsDirectory, true, 'precondition: lstat reports the volume junction as a directory, not a link')
    writeMeta(dataDir, 'saved-files/chat--vol/secret.txt', { name: 'secret.txt', bytes: 1234, mime: 'image/png' })
    const res = makeMedia(dataDir, { rows: new Map([['i:f1', row({ content_type: 14 })]]) }).savedFile('i:f1')
    assert.equal(res.ok, false, 'a file outside dataDir is not reported as saved')
    assert.equal(res.code, 'saved_link')
    assert.equal('absPath' in res, false)
    assert.equal('previewPath' in res, false)
  } finally { cleanupWithJunction(link, dataDir, outside) }
})

test('R-M01 volume junction as media-saved (meta path): savedFile does not read a record that lives outside dataDir', (t) => {
  const dataDir = tmpDataDir()
  const outside = tmpDataDir()
  const link = join(dataDir, 'media-saved')
  try {
    const rel = 'saved-files/chat--a/ok.bin'
    put(dataDir, rel, Buffer.alloc(1234, 5)) // 檔案本身在 dataDir 裡；只有紀錄在外面
    put(outside, `${FILE_STEM}.file.json`, JSON.stringify({ v: 1, name: 'planted.bin', bytes: 1234, mime: 'application/octet-stream', rel }))
    const made = volumeJunction(link, outside)
    if (made.skip) { t.skip(made.skip); return }
    assert.equal(made.reportedAsDirectory, true, 'precondition: lstat reports the volume junction as a directory, not a link')
    const res = makeMedia(dataDir, { rows: new Map([['i:f1', row({ content_type: 14 })]]) }).savedFile('i:f1')
    assert.equal(res.ok, false, 'a record outside dataDir is not trusted')
    assert.equal(res.code, 'saved_link')
  } finally { cleanupWithJunction(link, dataDir, outside) }
})

test('R-M01 volume junction as media-saved itself: prepare and prepareVideo do not serve an image or video that lives outside dataDir', (t) => {
  const dataDir = tmpDataDir()
  const outside = tmpDataDir()
  const link = join(dataDir, 'media-saved')
  try {
    put(outside, `${STEM}.png`, PNG)
    put(outside, `${VIDEO_STEM}.mp4`, Buffer.alloc(300, 1))
    const made = volumeJunction(link, outside)
    if (made.skip) { t.skip(made.skip); return }
    assert.equal(made.reportedAsDirectory, true, 'precondition: lstat reports the volume junction as a directory, not a link')
    const rows = new Map([['i:1', row({ key_material: null })], ['i:v1', row({ content_type: 2 })]])
    assert.deepEqual(makeMedia(dataDir, { rows, dec: null, idx: null }).prepare('i:1'), { ok: false, code: 'media_unavailable', message: 'the LINE cache directory is unknown' }, 'no decryptor: the outside image is not served')
    const dec = decryptor({ status: 'not-cached' })
    assert.equal(makeMedia(dataDir, { rows: new Map([['i:1', row()]]), dec, idx: fakeIndex() }).prepare('i:1').code, 'not_cached', 'with the decryptor: falls through to LINE as if nothing were saved')
    assert.equal(makeMedia(dataDir, { rows }).prepareVideo('i:v1').code, 'not_cached', 'the outside video is not served')
  } finally { cleanupWithJunction(link, dataDir, outside) }
})

/** 暫時把 `realpathSync.native` 換掉：`redirect(path)` 回字串＝假裝這個路徑的實際位置在那裡（模擬任何讓實際路徑越出 dataDir 的連結）。 */
function withRealpath(redirect, body) {
  const original = fs.realpathSync.native
  fs.realpathSync.native = (p, ...rest) => redirect(String(p)) ?? original(p, ...rest)
  try { return body() } finally { fs.realpathSync.native = original }
}

test('R-M01 realpath outside dataDir: the record, the saved file and a saved image are all refused when their real path leaves dataDir', () => {
  const dataDir = tmpDataDir()
  const outside = tmpDataDir()
  try {
    const rows = saveFileFixture(dataDir)
    rows.set('i:1', row({ key_material: null }))
    put(dataDir, `media-saved/${STEM}.png`, PNG)
    const away = (suffix) => (p) => (p.endsWith(suffix) ? join(outside, 'elsewhere', suffix) : null)
    const metaRes = withRealpath(away(`${FILE_STEM}.file.json`), () => makeMedia(dataDir, { rows }).savedFile('i:f1'))
    assert.equal(metaRes.ok, false, 'the record whose real path is outside dataDir is not read')
    assert.equal(metaRes.code, 'saved_link')
    const fileRes = withRealpath(away('20261113-101010_report.pdf'), () => makeMedia(dataDir, { rows }).savedFile('i:f1'))
    assert.equal(fileRes.ok, false, 'the saved file whose real path is outside dataDir is not reported')
    assert.equal(fileRes.code, 'saved_link')
    const dirRes = withRealpath((p) => (p.endsWith(`${sep}media-saved`) ? join(outside, 'media-saved') : null), () => makeMedia(dataDir, { rows }).savedFile('i:f1'))
    assert.equal(dirRes.ok, false, 'a media-saved directory whose real path is outside dataDir is not used')
    assert.equal(dirRes.code, 'saved_link')
    const imgRes = withRealpath(away(`${STEM}.png`), () => makeMedia(dataDir, { rows, dec: null, idx: null }).prepare('i:1'))
    assert.deepEqual(imgRes, { ok: false, code: 'media_unavailable', message: 'the LINE cache directory is unknown' }, 'a saved image whose real path is outside dataDir is not served')
    // 對照：不改 realpath 時，同一組資料都會成功（上面的拒絕確實來自包含檢查）。
    assert.equal(makeMedia(dataDir, { rows }).savedFile('i:f1').ok, true)
    assert.equal(makeMedia(dataDir, { rows, dec: null, idx: null }).prepare('i:1').ok, true)
  } finally { rmSync(dataDir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
})

const SAVED_META_SUFFIX_FOR_TEST = '.file.json'
/** 暫時包住 `openSync`：開 meta 檔之前先執行 `before(path)`（模擬 lstat 與 open 之間被換檔或被改寫）。回傳觸發次數。 */
function withOpenHook(before, body) {
  const original = fs.openSync
  let fired = 0
  fs.openSync = (p, ...rest) => {
    if (String(p).endsWith(SAVED_META_SUFFIX_FOR_TEST)) { fired += 1; before(String(p)) }
    return original(p, ...rest)
  }
  syncBuiltinESMExports()
  try { return { result: body(), fired: () => fired } } finally { fs.openSync = original; syncBuiltinESMExports() }
}

test('R-M01 TOCTOU ino: a record swapped for another file between lstat and open is refused (same size, different file)', () => {
  const dataDir = tmpDataDir()
  try {
    const rows = saveFileFixture(dataDir)
    const metaPath = join(dataDir, 'media-saved', `${FILE_STEM}.file.json`)
    const original = JSON.stringify({ v: 1, name: 'report.pdf', bytes: 1234, mime: 'application/pdf', rel: REL })
    const swapped = JSON.stringify({ v: 1, name: 'REPORT.pdf', bytes: 1234, mime: 'application/pdf', rel: REL })
    assert.equal(Buffer.byteLength(swapped), Buffer.byteLength(original), 'the swapped record has the same size, so only the file identity differs')
    const { result, fired } = withOpenHook((p) => { writeFileSync(`${p}.new`, swapped); renameSync(`${p}.new`, p) }, () => makeMedia(dataDir, { rows }).savedFile('i:f1'))
    assert.equal(result.ok, false, 'a record that is not the file lstat saw is not used')
    assert.equal(result.code, 'saved_meta_invalid')
    assert.equal(fired() >= 1, true, 'the record was opened (open, then fstat)')
    assert.equal(existsSync(metaPath), true)
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})

test('R-M01 TOCTOU size: a record that grows between lstat and open (same file) is refused', () => {
  const dataDir = tmpDataDir()
  try {
    const rows = saveFileFixture(dataDir)
    const { result, fired } = withOpenHook((p) => appendFileSync(p, '    '), () => makeMedia(dataDir, { rows }).savedFile('i:f1'))
    assert.equal(result.ok, false, 'a record whose size changed after lstat is not used')
    assert.equal(result.code, 'saved_meta_invalid')
    assert.equal(fired() >= 1, true, 'the record was opened (open, then fstat)')
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})

test('R-M01 guard: a dataDir reached through an ordinary junction still serves its own saved files and images', (t) => {
  const real = tmpDataDir()
  const holder = tmpDataDir()
  const alias = join(holder, 'alias')
  try {
    const rows = saveFileFixture(real)
    rows.set('i:1', row({ key_material: null }))
    put(real, `media-saved/${STEM}.png`, PNG)
    try { symlinkSync(real, alias, 'junction') } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip(`junction needs privilege: ${error.code}`); return }
      throw error
    }
    const res = makeMedia(alias, { rows }).savedFile('i:f1')
    assert.equal(res.ok, true, 'the real path is inside the real dataDir')
    assert.equal(res.absPath, join(alias, ...REL.split('/')))
    assert.equal(makeMedia(alias, { rows, dec: null, idx: null }).prepare('i:1').path, `media-saved/${STEM}.png`)
  } finally { cleanupWithJunction(alias, holder, real) }
})
