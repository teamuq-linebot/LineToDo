// X2a sink and ledger v2 (implementation-plan-v2.md X2a; implementation-plan.md §1 落點契約; review-m R-M07; review-m2 R2-01; review-x1 I-1, L-2).
// The sink writes where main's media.ts reads (media-saved/<stem>.<ext>, saved-files/… + media-saved/<stem>.file.json); every case below reads the
// result back through M1's createPluginMedia (media.prepare / prepareVideo / savedFile). Downloads go through X1 streamDownload with a fake OBS.
// Nothing here talks to LINE or reads credentials.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createCipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto'
import { lstatSync, mkdtempSync, realpathSync, rmdirSync, rmSync, symlinkSync } from 'node:fs'
import fsp, { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  LineJsMediaSink, partNameFor, previewAllowed, safeSegment, savedFilePlacement, savedRecordProblem, savedRelProblem,
  SAVED_META_SUFFIX, SAVED_PREVIEW_SEGMENT_MAX, SAVED_REL_MAX, SAVED_SEGMENT_MAX
} from '../../src/plugin/backend/linejsMediaSink.ts'
import {
  MEDIA_LEDGER_NAME, MEDIA_LEDGER_TERMINAL_MAX, MEDIA_LEDGER_V1_NAME, MediaLedger, detectSupportedVideoMime, isTerminalNegative, ledgerBlocks,
  ledgerFingerprint, ledgerOwner, mediaStem
} from '../../src/plugin/backend/linejsAutoDownload.mjs'
// review-x2a fix1 additions are read from the namespace, so on a base without them only the tests that use them fail
import * as autoDownload from '../../src/plugin/backend/linejsAutoDownload.mjs'
import { SAVED_FILE_DIR, SAVED_MEDIA_DIR, createPluginMedia, mediaCacheStem } from '../../src/plugin/backend/media.ts'
import { sniffPlaintext, streamDownload } from '../../src/plugin/backend/linejsMediaStream.ts'
import { ObsLimiter } from '../../src/plugin/backend/linejsObs.ts'
import { createLineJsMediaFetch } from '../../src/plugin/backend/linejsMedia.ts'
import { AutoDownloadStore } from '../../src/plugin/backend/linejsAutoDownload.mjs'
import { OriginalDownloadService, releaseSharedLedger } from '../../src/plugin/backend/linejsOriginals.ts'
// X4: loaded on first use, so this file still loads on a base without the module (only the X4 tests fail there)
const runBackfill = async (options) => (await import('../../src/plugin/backend/linejsMediaBackfill.ts')).runBackfill(options)

globalThis.fetch = async () => { throw Object.assign(new Error('network disabled in this test'), { code: 'TEST_NO_NETWORK' }) }

const KIB = 1024
const MIB = 1024 * 1024
const ME = 'u0123456789abcdef0123456789abcdef'
const FRIEND = 'ufedcba9876543210fedcba9876543210'
const GROUP = 'c11112222333344445555666677778888'
const OID = 'oidSYNTHETIC0123456789abcdefXYZ'
const IMG_ID = '6100000000000000001'
const VID_ID = '6100000000000000002'
const FILE_ID = '6100000000000000003'
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))
const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const stemOf = (id) => mediaCacheStem(`i:${id}`)
const SENT_AT = new Date(2026, 10, 14, 9, 8, 7).getTime()

// ───────────────────────── fixtures (same recipe as test-linejs-media-stream.mjs) ─────────────────────────

function keysOf(km) {
  const d = Buffer.from(hkdfSync('sha256', km, Buffer.alloc(0), Buffer.from('FileEncryption'), 76))
  return { encKey: d.subarray(0, 32), macKey: d.subarray(32, 64), nonce: Buffer.concat([d.subarray(64, 76), Buffer.alloc(4)]) }
}
function encrypt(plain, km) {
  const k = keysOf(km)
  const cipher = createCipheriv('aes-256-ctr', k.encKey, k.nonce)
  const enc = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([enc, createHmac('sha256', k.macKey).update(enc).digest()])
}
function pattern(n, seed = 7) {
  const b = Buffer.alloc(n)
  let x = seed >>> 0
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24 }
  return b
}
function mp4(n, seed = 3, brand = 'isom') {
  const b = pattern(n, seed)
  Buffer.from([0, 0, 0, 0x20]).copy(b, 0)
  b.write('ftyp', 4, 'latin1')
  b.write(brand, 8, 'latin1')
  return b
}
function png(width = 120, height = 80, seed = 7) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii')
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0, 0)
    return Buffer.concat([head, data, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  const rows = pattern((width * 3 + 1) * height, seed)
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows, { level: 0 })), chunk('IEND', Buffer.alloc(0))])
}
function fakeClient() {
  return { base: { authToken: 'synthetic-token', request: { systemType: 'ANDROIDSECONDARY\t14.0.0\tAndroid OS\t13', getHeader: () => ({ 'x-line-access': 'synthetic-token', 'accept-encoding': 'gzip' }) } } }
}
/** Fake OBS: pathname → Buffer; `gate` holds the body after `gateAt` bytes. */
function obsServer(objects, opts = {}) {
  const requests = []
  const fetch = async (request) => {
    const url = new URL(request.url)
    requests.push({ path: url.pathname, range: request.headers.get('range') })
    const body = objects.get(url.pathname)
    if (!body) return new Response('', { status: 404 })
    const m = /^bytes=(\d+)-$/.exec(request.headers.get('range') ?? '')
    const start = m ? Number(m[1]) : 0
    const headers = { 'content-length': String(body.length - start) }
    if (m) headers['content-range'] = `bytes ${start}-${body.length - 1}/${body.length}`
    let pos = start
    let sent = 0
    const stream = new ReadableStream({
      start(controller) { request.signal.addEventListener('abort', () => { try { controller.error(new DOMException('aborted', 'AbortError')) } catch { /* closed */ } }, { once: true }) },
      async pull(controller) {
        if (opts.gate && sent >= (opts.gateAt ?? 0)) await opts.gate
        if (pos >= body.length) { controller.close(); return }
        const end = Math.min(body.length, pos + 64 * KIB)
        controller.enqueue(new Uint8Array(body.subarray(pos, end)))
        sent += end - pos
        pos = end
      }
    })
    return new Response(stream, { status: m ? 206 : 200, headers })
  }
  return { fetch, requests }
}
const roomy = async () => ({ bavail: 1e12 / 4096, bsize: 4096 })
const streamOpts = (fetch, over = {}) => ({ signal: new AbortController().signal, priority: 'user', limiter: new ObsLimiter(), statfs: roomy, backoffMs: () => 0, fetch: createLineJsMediaFetch(fetch), ...over })
const session = { client: fakeClient(), sessionId: 's1' }

async function workdir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'line-todo-x2a-sink-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
/** M1's reader over the same dataDir: rows by msgId, no decryptor / index (only media-saved can answer). */
function m1(dataDir, rows) {
  return createPluginMedia({ dataDir, getDb: () => ({ prepare: () => ({ get: (id) => rows.get(id) }) }), decryptor: null, index: null })
}
const ROWS = new Map([[`i:${IMG_ID}`, { content_type: 1, key_material: null, file_size: null }], [`i:${VID_ID}`, { content_type: 2, key_material: null, file_size: null }], [`i:${FILE_ID}`, { content_type: 14, key_material: null, file_size: null }]])
const parts = async (dataDir) => (await readdir(path.join(dataDir, SAVED_MEDIA_DIR)).catch(() => [])).filter((n) => n.endsWith('.part'))
const DISPLAY_NAME = /^[0-9a-f]{32}\.(?:jpg|png|gif|webp|mp4|mov|webm|file\.json)$/

// ───────────────────────── 1. three kinds → M1 reads them back ─────────────────────────

test('X2a-1 three kinds written through streamDownload + sink: M1 media.prepare (image), prepareVideo (video) and savedFile (file) all answer ok', async (t) => {
  const dir = await workdir(t)
  const sink = new LineJsMediaSink({ dataDir: dir })
  const image = png(160, 90, 3)
  const km = randomBytes(32)
  const video = mp4(900 * KIB + 5, 9)
  const fileBytes = randomBytes(200 * KIB + 7)
  const obs = obsServer(new Map([[`/r/talk/m/${IMG_ID}`, image], [`/r/talk/emv/${OID}`, encrypt(video, km)], [`/r/talk/emf/${OID}`, encrypt(fileBytes, km)]]))
  // image (plain)
  const imgTarget = await sink.targetFor({ stem: stemOf(IMG_ID), kind: 'IMAGE', origin: 'history', chatId: FRIEND })
  assert.equal((await streamDownload({ stem: stemOf(IMG_ID), kind: 'IMAGE', messageId: IMG_ID, chatId: FRIEND, transport: 'plain', declaredBytes: image.length, origin: 'history' }, session, imgTarget, streamOpts(obs.fetch))).status, 'done')
  assert.deepEqual(imgTarget.result, { status: 'written', kind: 'IMAGE', rel: `${SAVED_MEDIA_DIR}/${stemOf(IMG_ID)}.png`, bytes: image.length, mime: 'image/png' })
  // video (E2EE)
  const vidTarget = await sink.targetFor({ stem: stemOf(VID_ID), kind: 'VIDEO', origin: 'receive', chatId: GROUP })
  assert.equal((await streamDownload({ stem: stemOf(VID_ID), kind: 'VIDEO', messageId: VID_ID, chatId: GROUP, transport: 'e2ee', sid: 'emv', oid: OID, keyMaterial: km, declaredBytes: video.length, origin: 'receive' }, session, vidTarget, streamOpts(obs.fetch))).status, 'done')
  assert.equal(vidTarget.result.rel, `${SAVED_MEDIA_DIR}/${stemOf(VID_ID)}.mp4`)
  // file (E2EE)
  const fileTarget = await sink.targetFor({ stem: stemOf(FILE_ID), kind: 'FILE', origin: 'history', chatId: GROUP, chatName: '專案群組', fileName: '報告 v2.pdf', sentAt: SENT_AT })
  assert.equal((await streamDownload({ stem: stemOf(FILE_ID), kind: 'FILE', messageId: FILE_ID, chatId: GROUP, transport: 'e2ee', sid: 'emf', oid: OID, keyMaterial: km, declaredBytes: fileBytes.length, origin: 'history' }, session, fileTarget, streamOpts(obs.fetch))).status, 'done')
  const chatHash = sha(GROUP).slice(0, 10)
  assert.deepEqual(fileTarget.result, { status: 'written', kind: 'FILE', rel: `${SAVED_FILE_DIR}/專案群組--${chatHash}/20261114-090807_報告 v2.pdf`, bytes: fileBytes.length, mime: 'application/pdf' })

  const media = m1(dir, ROWS)
  const p = media.prepare(`i:${IMG_ID}`)
  assert.deepEqual(p, { ok: true, path: `${SAVED_MEDIA_DIR}/${stemOf(IMG_ID)}.png`, mime: 'image/png', size: image.length, cached: true })
  assert.deepEqual(media.prepareVideo(`i:${VID_ID}`), { ok: true, path: `${SAVED_MEDIA_DIR}/${stemOf(VID_ID)}.mp4`, mime: 'video/mp4', size: video.length, cached: true })
  const f = media.savedFile(`i:${FILE_ID}`)
  assert.equal(f.ok, true, JSON.stringify(f))
  assert.deepEqual({ name: f.name, bytes: f.bytes, mime: f.mime }, { name: '報告 v2.pdf', bytes: fileBytes.length, mime: 'application/pdf' })
  assert.equal(f.absPath, path.join(dir, ...fileTarget.result.rel.split('/')))
  assert.equal(f.previewPath, undefined, 'a pdf has no preview')
  // contents byte-identical, nothing left over
  assert.deepEqual(await readFile(path.join(dir, ...imgTarget.result.rel.split('/'))), image)
  assert.equal(sha(await readFile(path.join(dir, ...vidTarget.result.rel.split('/')))), sha(video))
  assert.deepEqual(await readFile(path.join(dir, ...fileTarget.result.rel.split('/'))), fileBytes)
  assert.deepEqual(await parts(dir), [])
  // an image-type file gets previewPath (every segment the sink makes is ≤100)
  const photo = png(40, 30, 5)
  const r = await sink.saveBytes({ stem: stemOf('6100000000000000004'), kind: 'FILE', origin: 'outbound', chatId: GROUP, chatName: 'x'.repeat(400), fileName: `${'長'.repeat(300)}.png`, sentAt: SENT_AT }, photo, 'application/octet-stream')
  const media2 = m1(dir, new Map([['i:6100000000000000004', { content_type: 14 }]]))
  const f2 = media2.savedFile('i:6100000000000000004')
  assert.equal(f2.ok, true, JSON.stringify(f2))
  assert.equal(f2.mime, 'image/png')
  assert.equal(f2.previewPath, r.rel)
  assert.ok(r.rel.split('/').every((s) => s.length <= SAVED_PREVIEW_SEGMENT_MAX))
})

test('X2a-1b content decides the extension: a QuickTime brand is saved as .mov, a webm as .webm; a declared MIME that the content contradicts is refused (nothing written)', async (t) => {
  const dir = await workdir(t)
  const sink = new LineJsMediaSink({ dataDir: dir })
  const mov = mp4(70 * KIB, 4, 'qt  ')
  assert.equal((await sink.saveBytes({ stem: stemOf('7001'), kind: 'VIDEO', origin: 'outbound', chatId: GROUP }, mov, 'video/quicktime')).rel, `${SAVED_MEDIA_DIR}/${stemOf('7001')}.mov`)
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), pattern(5000)])
  assert.equal((await sink.saveBytes({ stem: stemOf('7002'), kind: 'VIDEO', origin: 'outbound', chatId: GROUP }, webm, 'video/webm')).rel, `${SAVED_MEDIA_DIR}/${stemOf('7002')}.webm`)
  await assert.rejects(sink.saveBytes({ stem: stemOf('7003'), kind: 'IMAGE', origin: 'outbound', chatId: GROUP }, png(), 'image/jpeg'), { code: 'SINK_CONTENT_MISMATCH' })
  await assert.rejects(sink.saveBytes({ stem: stemOf('7004'), kind: 'VIDEO', origin: 'outbound', chatId: GROUP }, pattern(4000), 'video/mp4'), { code: 'SINK_CONTENT_MISMATCH' })
  const media = m1(dir, new Map([['i:7001', { content_type: 2 }], ['i:7002', { content_type: 2 }], ['i:7003', { content_type: 1 }]]))
  assert.equal(media.prepareVideo('i:7001').mime, 'video/quicktime')
  assert.equal(media.prepareVideo('i:7002').mime, 'video/webm')
  assert.equal(media.prepare('i:7003').ok, false)
  assert.deepEqual(await parts(dir), [])
})

// ───────────────────────── 2. R-M07: one counterexample per rule ─────────────────────────

test('X2a-2 R-M07 each rule has a counterexample that is refused — by the sink\'s validator and by M1\'s savedFile', async (t) => {
  const dir = await workdir(t)
  const stem = stemOf(FILE_ID)
  const good = { v: 1, name: 'a.pdf', bytes: 5, mime: 'application/pdf', rel: `${SAVED_FILE_DIR}/chat--0123456789/a.pdf` }
  await mkdir(path.join(dir, SAVED_FILE_DIR, 'chat--0123456789'), { recursive: true })
  await writeFile(path.join(dir, SAVED_FILE_DIR, 'chat--0123456789', 'a.pdf'), Buffer.from('%PDF-'))
  const json = (over) => Buffer.from(JSON.stringify({ ...good, ...over }), 'utf8')
  const media = m1(dir, ROWS)
  const viaM1 = async (bytes, rel = good.rel, size = 5) => {
    await mkdir(path.join(dir, SAVED_MEDIA_DIR), { recursive: true })
    await writeFile(path.join(dir, SAVED_MEDIA_DIR, `${stem}${SAVED_META_SUFFIX}`), bytes)
    return media.savedFile(`i:${FILE_ID}`)
  }
  assert.equal(savedRecordProblem(json({}), 5), null, 'control: the good record passes')
  assert.equal((await viaM1(json({}))).ok, true, 'control: M1 reads the good record')
  const longSeg = 'x'.repeat(SAVED_SEGMENT_MAX + 1)
  const cases = [
    ['BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), json({})]), 'BOM', 'saved_meta_invalid'],
    ['v must be 1', json({ v: 2 }), 'VERSION', 'saved_meta_invalid'],
    ['rel longer than 300', json({ rel: `${SAVED_FILE_DIR}/${'d'.repeat(200)}/${'f'.repeat(SAVED_REL_MAX - 200 - SAVED_FILE_DIR.length - 1)}` }), 'REL_LENGTH', 'saved_invalid'],
    ['a segment longer than 255', json({ rel: `${SAVED_FILE_DIR}/${longSeg}` }), 'SEGMENT_LENGTH', 'saved_invalid'],
    ['a segment starting with .', json({ rel: `${SAVED_FILE_DIR}/.chat/a.pdf` }), 'SEGMENT_DOT', 'saved_invalid'],
    ['a segment ending with .', json({ rel: `${SAVED_FILE_DIR}/chat./a.pdf` }), 'SEGMENT_DOT', 'saved_invalid'],
    ['.. traversal', json({ rel: `${SAVED_FILE_DIR}/../a.pdf` }), 'SEGMENT_DOT', 'saved_invalid'],
    ['size larger than the file', json({ bytes: 6 }), 'SIZE_MISMATCH', 'saved_size_mismatch'],
    ['size smaller than the file', json({ bytes: 4 }), 'SIZE_MISMATCH', 'saved_size_mismatch'],
  ]
  for (const [label, bytes, sinkCode, m1Code] of cases) {
    assert.equal(savedRecordProblem(bytes, 5), sinkCode, `sink: ${label}`)
    const out = await viaM1(bytes)
    assert.deepEqual([out.ok, out.code], [false, m1Code], `M1: ${label} → ${JSON.stringify(out)}`)
  }
  assert.equal(savedRelProblem(`${SAVED_FILE_DIR}/${'d'.repeat(SAVED_REL_MAX)}`), 'REL_LENGTH')
  // previewPath only when every segment is ≤100: a 101-char segment is valid (≤255) but gets no preview
  const seg101 = `${'p'.repeat(97)}.png`
  assert.equal(seg101.length, 101)
  await mkdir(path.join(dir, SAVED_FILE_DIR, 'chat--0123456789'), { recursive: true })
  await writeFile(path.join(dir, SAVED_FILE_DIR, 'chat--0123456789', seg101), png(4, 4))
  const size = (await stat(path.join(dir, SAVED_FILE_DIR, 'chat--0123456789', seg101))).size
  const rel101 = `${SAVED_FILE_DIR}/chat--0123456789/${seg101}`
  assert.equal(savedRecordProblem(json({ rel: rel101, bytes: size, mime: 'image/png' }), size), null)
  assert.equal(previewAllowed(rel101, 'image/png'), false)
  const out101 = await viaM1(json({ rel: rel101, bytes: size, mime: 'image/png' }))
  assert.equal(out101.ok, true)
  assert.equal(out101.previewPath, undefined, 'M1 gives no previewPath for a segment over 100')
  const rel100 = `${SAVED_FILE_DIR}/chat--0123456789/${seg101.slice(1)}`
  await writeFile(path.join(dir, ...rel100.split('/')), png(4, 4))
  assert.equal(previewAllowed(rel100, 'image/png'), true)
  assert.equal((await viaM1(json({ rel: rel100, bytes: size, mime: 'image/png' }))).previewPath, rel100)
})

test('X2a-2b the record the sink writes: no BOM, v:1, exact size, rel valid and inside dataDir; the sink refuses a commit whose size differs from the part (part removed)', async (t) => {
  const dir = await workdir(t)
  const sink = new LineJsMediaSink({ dataDir: dir })
  const bytes = randomBytes(12_345)
  const r = await sink.saveBytes({ stem: stemOf(FILE_ID), kind: 'FILE', origin: 'outbound', chatId: GROUP, chatName: 'Team', fileName: 'data.bin', sentAt: SENT_AT }, bytes, 'application/x-custom')
  const raw = await readFile(path.join(dir, SAVED_MEDIA_DIR, `${stemOf(FILE_ID)}${SAVED_META_SUFFIX}`))
  assert.equal(raw[0], 0x7b, 'starts with { (no BOM)')
  const meta = JSON.parse(raw.toString('utf8'))
  assert.deepEqual(meta, { v: 1, name: 'data.bin', bytes: bytes.length, mime: 'application/x-custom', rel: r.rel })
  assert.equal(savedRecordProblem(raw, (await stat(path.join(dir, ...r.rel.split('/')))).size), null)
  // size must match exactly
  const target = await sink.targetFor({ stem: stemOf('7101'), kind: 'IMAGE', origin: 'history', chatId: GROUP })
  await writeFile(target.partPath, png())
  await assert.rejects(target.commit(target.partPath, { mime: 'image/png', bytes: png().length + 1 }), { code: 'SINK_SIZE_MISMATCH' })
  assert.deepEqual(await parts(dir), [], 'the untrusted part is removed')
  await assert.rejects(target.commit(path.join(dir, 'elsewhere.part'), { mime: 'image/png', bytes: 1 }), { code: 'SINK_PART_UNKNOWN' })
})

// ───────────────────────── 3. I-1: part names are outside the display chain ─────────────────────────

test('X2a-3 I-1 part files are .<stem>.<uuid>.part: never a name the display chain reads; a download in flight is not served, then the finished file is', async (t) => {
  const dir = await workdir(t)
  const stem = stemOf(VID_ID)
  for (let i = 0; i < 50; i++) {
    const name = partNameFor(stem)
    assert.match(name, /^\.[0-9a-f]{32}\.[0-9a-f-]{36}\.part$/)
    assert.equal(DISPLAY_NAME.test(name), false, name)
    assert.ok(name.startsWith('.'), 'the host never serves a dot-name')
  }
  assert.throws(() => partNameFor('../x'), { code: 'SINK_STEM_INVALID' })
  const sink = new LineJsMediaSink({ dataDir: dir })
  const km = randomBytes(32)
  const video = mp4(1 * MIB, 13)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const obs = obsServer(new Map([[`/r/talk/emv/${OID}`, encrypt(video, km)]]), { gate, gateAt: 512 * KIB })
  const target = await sink.targetFor({ stem, kind: 'VIDEO', origin: 'history', chatId: GROUP })
  const running = streamDownload({ stem, kind: 'VIDEO', messageId: VID_ID, chatId: GROUP, transport: 'e2ee', sid: 'emv', oid: OID, keyMaterial: km, declaredBytes: video.length, origin: 'history' }, session, target, streamOpts(obs.fetch))
  for (let i = 0; i < 200 && (await parts(dir)).length === 0; i++) await tick()
  const inFlight = await readdir(path.join(dir, SAVED_MEDIA_DIR))
  assert.deepEqual(inFlight, [target.partName], 'only the dot-part exists while downloading')
  const media = m1(dir, ROWS)
  assert.deepEqual([media.prepareVideo(`i:${VID_ID}`).ok, media.prepareVideo(`i:${VID_ID}`).code], [false, 'not_cached'], 'the part is not served')
  release()
  assert.equal((await running).status, 'done')
  assert.equal(media.prepareVideo(`i:${VID_ID}`).ok, true)
  // a resumed download reuses the ledger's part name only when it belongs to the same stem
  const reuse = await sink.targetFor({ stem: stemOf('7201'), kind: 'IMAGE', origin: 'history', chatId: GROUP }, { partName: partNameFor(stemOf('7201')) })
  const foreign = partNameFor(stemOf('7202'))
  const fresh = await sink.targetFor({ stem: stemOf('7201'), kind: 'IMAGE', origin: 'history', chatId: GROUP }, { partName: foreign })
  assert.notEqual(fresh.partName, foreign)
  assert.ok(reuse.partName.startsWith(`.${stemOf('7201')}.`))
  assert.ok(fresh.partName.startsWith(`.${stemOf('7201')}.`))
  assert.equal((await sink.targetFor({ stem: stemOf('7201'), kind: 'IMAGE', origin: 'history', chatId: GROUP }, { partName: '../../evil.part' })).partName.startsWith(`.${stemOf('7201')}.`), true)
})

// ───────────────────────── 4. traversal (..) ─────────────────────────

test('X2a-4 hostile chat and file names never leave saved-files: .., separators, drive letters, dot-only, reserved names, trailing dots/spaces, control characters', async (t) => {
  const dir = await workdir(t)
  const sink = new LineJsMediaSink({ dataDir: dir })
  const hostile = [
    ['..', '..'], ['../..', '../../../outside.txt'], ['..\\..\\', '..\\..\\win.ini'], ['C:\\Windows', 'C:\\Windows\\x.dll'], ['/etc', '/etc/passwd'],
    ['...', '...'], ['CON', 'NUL.txt'], ['chat. ', 'name. . '], ['a\u0000b', 'c\u0001d\u007f.txt'], ['．．／．．', '．．／x.txt'], ['\\\\?\\Volume', '\\\\server\\share\\f'],
    ['', ''], [' ', '.hidden'], ['a/../../b', 'x/../../../../y.pdf'],
  ]
  const root = path.join(dir, SAVED_FILE_DIR)
  let n = 0
  for (const [chatName, fileName] of hostile) {
    const id = String(7300 + n++)
    const r = await sink.saveBytes({ stem: stemOf(id), kind: 'FILE', origin: 'history', chatId: GROUP, chatName, fileName, sentAt: SENT_AT }, Buffer.from(`body ${id}`), 'application/octet-stream')
    assert.equal(r.status, 'written', `${JSON.stringify([chatName, fileName])}`)
    assert.equal(savedRelProblem(r.rel), null, r.rel)
    const segments = r.rel.split('/')
    assert.equal(segments.length, 3, r.rel)
    assert.ok(segments.every((s) => s !== '..' && s !== '.' && !s.startsWith('.') && !/[\\/:\u0000-\u001f]/.test(s)), r.rel)
    const abs = path.resolve(dir, ...segments)
    assert.ok(abs.startsWith(root + path.sep), `${abs} is inside saved-files`)
    const out = m1(dir, new Map([[`i:${id}`, { content_type: 14 }]])).savedFile(`i:${id}`)
    assert.equal(out.ok, true, `${r.rel}: ${JSON.stringify(out)}`)
  }
  // nothing was created next to saved-files / media-saved
  assert.deepEqual((await readdir(dir)).sort(), [SAVED_FILE_DIR, SAVED_MEDIA_DIR].sort())
  assert.equal((await readdir(root)).length, new Set(hostile.map(([c]) => savedFilePlacement({ chatId: GROUP, chatName: c }, SENT_AT).chatDir)).size, 'one folder per sanitized chat name, all inside saved-files')
  // pure helpers
  assert.equal(safeSegment('..', 100, 'f'), 'f')
  assert.equal(safeSegment('../../x', 100, 'f'), '_.._x')
  assert.ok(savedFilePlacement({ chatId: GROUP, chatName: '../..', fileName: '../../../a' }, SENT_AT).rel.split('/').every((s) => s !== '..'))
  // a stem that is not 32 hex never becomes a path
  await assert.rejects(sink.saveBytes({ stem: '../../x', kind: 'IMAGE', origin: 'history', chatId: GROUP }, png(), 'image/png'), { code: 'SINK_STEM_INVALID' })
  await assert.rejects(sink.targetFor({ stem: `${'a'.repeat(31)}/`, kind: 'IMAGE', origin: 'history', chatId: GROUP }), { code: 'SINK_STEM_INVALID' })
  // a media-saved that is a regular file (not a directory) is refused, nothing written elsewhere
  const other = await mkdtemp(path.join(os.tmpdir(), 'line-todo-x2a-sink-'))
  t.after(() => rm(other, { recursive: true, force: true }))
  await writeFile(path.join(other, SAVED_MEDIA_DIR), 'not a directory')
  await assert.rejects(new LineJsMediaSink({ dataDir: other }).saveBytes({ stem: stemOf('7399'), kind: 'IMAGE', origin: 'history', chatId: GROUP }, png(), 'image/png'), { code: 'SINK_PATH_UNSAFE' })
})

// ───────────────────────── 5. one stem, two origins → one write ─────────────────────────

test('X2a-5 the same stem from two origins is written once: sequential (receive download, then outbound bytes) and concurrent (history download and outbound together)', async (t) => {
  const dir = await workdir(t)
  const sink = new LineJsMediaSink({ dataDir: dir })
  const image = png(200, 100, 21)
  const obs = obsServer(new Map([[`/r/talk/m/${IMG_ID}`, image]]))
  const stem = stemOf(IMG_ID)
  const locator = { stem, kind: 'IMAGE', messageId: IMG_ID, chatId: FRIEND, transport: 'plain', declaredBytes: image.length }
  // sequential
  const first = await sink.targetFor({ stem, kind: 'IMAGE', origin: 'receive', chatId: FRIEND })
  assert.equal((await streamDownload({ ...locator, origin: 'receive' }, session, first, streamOpts(obs.fetch))).status, 'done')
  assert.equal(first.result.status, 'written')
  const finalPath = path.join(dir, ...first.result.rel.split('/'))
  const before = await stat(finalPath)
  const other = png(200, 100, 99) // the outbound copy differs (it must not replace the saved one)
  const second = await sink.saveBytes({ stem, kind: 'IMAGE', origin: 'outbound', chatId: FRIEND }, other, 'image/png')
  assert.deepEqual(second, { status: 'exists', kind: 'IMAGE', rel: first.result.rel, bytes: image.length, mime: 'image/png' })
  assert.deepEqual(await readFile(finalPath), image, 'the first write stays')
  assert.equal((await stat(finalPath)).mtimeMs, before.mtimeMs)
  assert.equal(sink.writes.get(stem), 1)
  // a later download of the same stem: commit sees it and drops its part
  const third = await sink.targetFor({ stem, kind: 'IMAGE', origin: 'history', chatId: FRIEND })
  assert.equal((await streamDownload({ ...locator, origin: 'history' }, session, third, streamOpts(obs.fetch))).status, 'done')
  assert.equal(third.result.status, 'exists')
  assert.equal(sink.writes.get(stem), 1)
  assert.deepEqual(await parts(dir), [])

  // concurrent: a file (FILE kind) from history and from outbound at once
  const fstem = stemOf(FILE_ID)
  const bytes = randomBytes(64 * KIB + 1)
  const km = randomBytes(32)
  const obsF = obsServer(new Map([[`/r/talk/emf/${OID}`, encrypt(bytes, km)]]))
  const spec = { stem: fstem, kind: 'FILE', chatId: GROUP, chatName: 'G', fileName: 'same.zip', sentAt: SENT_AT }
  const target = await sink.targetFor({ ...spec, origin: 'history' })
  const [a, b] = await Promise.all([
    streamDownload({ stem: fstem, kind: 'FILE', messageId: FILE_ID, chatId: GROUP, transport: 'e2ee', sid: 'emf', oid: OID, keyMaterial: km, declaredBytes: bytes.length, origin: 'history' }, session, target, streamOpts(obsF.fetch)).then(() => target.result),
    sink.saveBytes({ ...spec, origin: 'outbound' }, bytes, 'application/zip'),
  ])
  assert.deepEqual([a.status, b.status].sort(), ['exists', 'written'])
  assert.equal(a.rel, b.rel)
  assert.equal(sink.writes.get(fstem), 1)
  const files = await readdir(path.join(dir, SAVED_FILE_DIR, `G--${sha(GROUP).slice(0, 10)}`))
  assert.deepEqual(files, ['20261114-090807_same.zip'], 'one saved file, no suffixed duplicate')
  assert.deepEqual(await parts(dir), [])
  assert.equal(m1(dir, ROWS).savedFile(`i:${FILE_ID}`).ok, true)
  // two different messages with the same name in the same second: the second gets a stem suffix (never overwrites)
  const otherStem = stemOf('7501')
  const r = await sink.saveBytes({ ...spec, stem: otherStem, origin: 'history' }, Buffer.from('another'), 'application/zip')
  assert.equal(r.rel.split('/').at(-1), `20261114-090807_same_${otherStem.slice(0, 8)}.zip`)
})

// ───────────────────────── 6. ledger v2 ─────────────────────────

test('X2a-6 ledger v2: owner + stem is the key; v2 fields; one entry across origins; persisted atomically and read back (running → queued)', async (t) => {
  const dir = await workdir(t)
  let now = 1_000_000
  const ledger = new MediaLedger(dir, { now: () => now })
  await ledger.load()
  const owner = ledgerOwner(ME)
  assert.match(owner, /^[0-9a-f]{64}$/)
  const stem = mediaStem(`i:${VID_ID}`)
  assert.equal(stem, stemOf(VID_ID), 'mediaStem equals media.ts mediaCacheStem')
  const fp = ledgerFingerprint(OID, 'emv')
  assert.match(fp, /^[0-9a-f]{16}$/)
  assert.equal(fp, sha(`${OID}\0emv`).slice(0, 16))
  ledger.begin(owner, stem, { origin: 'receive', kind: 'VIDEO', declaredBytes: 1234, fingerprint: fp, sessionId: 's1' })
  ledger.begin(owner, stem, { origin: 'history', kind: 'VIDEO' })
  assert.equal(ledger.entries.size, 1, 'a second origin does not open a second entry')
  const part = partNameFor(stem)
  ledger.running(owner, stem, { partName: part })
  now += 10
  await ledger.flush()
  const raw = JSON.parse(await readFile(path.join(dir, MEDIA_LEDGER_NAME), 'utf8'))
  assert.equal(raw.version, 2)
  assert.deepEqual(raw.items, [{ owner, stem, origin: 'receive', kind: 'VIDEO', state: 'running', class: null, code: null, attempts: 0, nextAt: null, bytesDone: 0, declaredBytes: 1234, fingerprint: fp, createdAt: 1_000_000, updatedAt: 1_000_000, sessionId: 's1', partName: part }])
  assert.ok(!JSON.stringify(raw).includes('keyMaterial'))
  assert.deepEqual((await readdir(dir)).filter((n) => n.endsWith('.part')), [], 'atomic write left no temp file')
  const reloaded = new MediaLedger(dir, { now: () => now })
  await reloaded.load()
  assert.equal(reloaded.get(owner, stem).state, 'queued', 'running is not resumed as running after a restart')
  assert.equal(reloaded.get(owner, stem).partName, part, 'the part name survives for resume')
  // outcomes
  reloaded.record(owner, stem, { status: 'paused', class: 'rate_limited', code: 'OBS_HTTP_429', retryAfterMs: 60_000 })
  assert.deepEqual([reloaded.get(owner, stem).state, reloaded.get(owner, stem).nextAt, reloaded.get(owner, stem).attempts], ['paused', now + 60_000, 0])
  reloaded.record(owner, stem, { status: 'failed', class: 'transient', code: 'OBS_NETWORK' })
  assert.deepEqual([reloaded.get(owner, stem).state, reloaded.get(owner, stem).attempts, reloaded.get(owner, stem).nextAt], ['failed', 1, now + 30_000])
  reloaded.record(owner, stem, { status: 'done', bytes: 1234, mime: 'video/mp4' })
  const done = reloaded.get(owner, stem)
  assert.deepEqual([done.state, done.class, done.code, done.bytesDone, done.partName], ['done', null, null, 1234, undefined])
  // another owner, same stem: a separate entry
  reloaded.begin(ledgerOwner(FRIEND), stem, { origin: 'history', kind: 'VIDEO' })
  assert.equal(reloaded.entries.size, 2)
  assert.throws(() => reloaded.begin(owner, '../x', { origin: 'history', kind: 'VIDEO' }), { code: 'LEDGER_KEY_INVALID' })
})

test('X2a-7 ledger reads v1: auto-download-ledger.json (version 1) is imported as v2 entries keyed by owner + stem; the v1 file is not modified', async (t) => {
  const dir = await workdir(t)
  const ownerKey = ledgerOwner(ME)
  const v1 = {
    version: 1, overflowCount: 0, items: [
      { key: `${ownerKey}\0${GROUP}\0${IMG_ID}\0IMAGE`, chatId: GROUP, messageId: IMG_ID, kind: 'IMAGE', chatFolder: 'f', name: 'a.jpg', status: 'completed', bytes: 999, attempts: 0, createdAt: 5, updatedAt: 6, metadata: { type: 'IMAGE', declaredBytes: null }, savedName: 'a.jpg', savedRoot: 'C:/x' },
      { key: `${ownerKey}\0${GROUP}\0${FILE_ID}\0FILE`, chatId: GROUP, messageId: FILE_ID, kind: 'FILE', chatFolder: 'f', name: 'b.pdf', status: 'failed', bytes: 0, attempts: 5, errorCode: 'ATTACHMENT_TOO_LARGE', createdAt: 7, updatedAt: 8, metadata: { type: 'FILE', declaredBytes: 30000000 } },
      { key: `unassigned\0${FRIEND}\0${VID_ID}\0IMAGE`, chatId: FRIEND, messageId: VID_ID, kind: 'IMAGE', status: 'paused', attempts: 1, createdAt: 9, updatedAt: 10, metadata: {} },
      { key: 'garbage', messageId: 'x', kind: 'IMAGE', status: 'completed' },
    ]
  }
  const v1Bytes = Buffer.from(JSON.stringify(v1))
  await writeFile(path.join(dir, MEDIA_LEDGER_V1_NAME), v1Bytes)
  const ledger = new MediaLedger(dir)
  const counts = await ledger.load()
  assert.equal(counts.migratedFromV1, 3, 'the malformed v1 item is skipped')
  const img = ledger.get(ownerKey, mediaStem(`i:${IMG_ID}`))
  assert.deepEqual([img.origin, img.kind, img.state, img.code, img.bytesDone], ['receive', 'IMAGE', 'done', 'V1_COMPLETED', 999])
  const file = ledger.get(ownerKey, mediaStem(`i:${FILE_ID}`))
  assert.deepEqual([file.state, file.class, file.code, file.attempts, file.declaredBytes], ['failed', 'transient', 'ATTACHMENT_TOO_LARGE', 5, 30000000])
  assert.equal(isTerminalNegative(file), false, 'v1 failures are not permanent terminals')
  assert.equal(ledger.get('unassigned', mediaStem(`i:${VID_ID}`)).state, 'queued')
  assert.deepEqual(await readFile(path.join(dir, MEDIA_LEDGER_V1_NAME)), v1Bytes, 'v1 file untouched')
  await ledger.flush()
  const again = new MediaLedger(dir)
  assert.equal((await again.load()).total, 3, 'after the first flush the v2 file is read')
  assert.equal(again.migratedFromV1, 0)
  // review-x2a F-4 (ADJ-X2A-02): a broken file is set aside and the ledger starts empty — it no longer throws (X2a-fix1 F-4 has the details)
  await writeFile(path.join(dir, MEDIA_LEDGER_NAME), '{broken')
  const broken = new MediaLedger(dir, { log: () => {} })
  assert.equal((await broken.load()).total, 0)
  assert.ok(broken.quarantined && broken.quarantined.startsWith(`${MEDIA_LEDGER_NAME}.corrupt-`))
})

test('X2a-8 terminals: expired / undecryptable are permanent until the fingerprint (OID, SID) changes; forbidden only for the same session; SIZE_MISMATCH is never permanent (L-2)', async (t) => {
  const dir = await workdir(t)
  let now = 5_000
  const ledger = new MediaLedger(dir, { now: () => now })
  await ledger.load()
  const owner = ledgerOwner(ME)
  const fp = ledgerFingerprint(OID, 'emi')
  const s1 = mediaStem('i:1'), s2 = mediaStem('i:2'), s3 = mediaStem('i:3'), s4 = mediaStem('i:4')
  for (const s of [s1, s2, s3, s4]) ledger.begin(owner, s, { origin: 'history', kind: 'IMAGE', fingerprint: fp })
  ledger.record(owner, s1, { status: 'failed', class: 'expired', code: 'OBS_HTTP_404' })
  ledger.record(owner, s2, { status: 'failed', class: 'undecryptable', code: 'HMAC_MISMATCH' })
  ledger.record(owner, s3, { status: 'failed', class: 'undecryptable', code: 'SIZE_MISMATCH' })
  ledger.record(owner, s4, { status: 'failed', class: 'forbidden', code: 'OBS_HTTP_403' }, { sessionId: 'sess-A' })
  assert.equal(ledgerBlocks(ledger.get(owner, s1, { fingerprint: fp })), true)
  assert.equal(ledgerBlocks(ledger.get(owner, s2, { fingerprint: fp })), true)
  assert.equal(ledger.get(owner, s1).nextAt, null, 'a terminal has no retry time')
  const size = ledger.get(owner, s3, { fingerprint: fp })
  assert.equal(isTerminalNegative(size), false, 'SIZE_MISMATCH is not a permanent terminal')
  assert.equal(ledgerBlocks(size, { sessionId: 'sess-A' }), false)
  assert.equal(size.nextAt, now + 30_000, 'SIZE_MISMATCH gets a retry time like any retryable failure')
  assert.equal(ledger.counts().terminalNegative, 2)
  assert.equal(ledgerBlocks(ledger.get(owner, s4), { sessionId: 'sess-A' }), true)
  assert.equal(ledgerBlocks(ledger.get(owner, s4), { sessionId: 'sess-B' }), false, 'another session may try again')
  // begin does not overwrite a permanent terminal
  ledger.begin(owner, s1, { origin: 'receive', kind: 'IMAGE', fingerprint: fp })
  assert.equal(ledger.get(owner, s1).state, 'failed')
  // the message row's OID / SID changed → the terminal is void
  const fp2 = ledgerFingerprint('oidNEW', 'emi')
  assert.equal(ledger.get(owner, s1, { fingerprint: fp2 }), null)
  assert.equal(ledger.get(owner, s2, { fingerprint: fp2 }), null)
  assert.equal(ledger.counts().terminalNegative, 0)
  assert.equal(ledger.begin(owner, s1, { origin: 'history', kind: 'IMAGE', fingerprint: fp2 }).state, 'queued')
  // a terminal survives a restart, and its fingerprint check still works afterwards
  ledger.record(owner, s1, { status: 'failed', class: 'expired', code: 'OBS_HTTP_410' })
  await ledger.flush()
  const reloaded = new MediaLedger(dir, { now: () => now })
  await reloaded.load()
  assert.equal(ledgerBlocks(reloaded.get(owner, s1, { fingerprint: fp2 })), true)
  assert.equal(reloaded.get(owner, s1, { fingerprint: fp }), null)
})

test('X2a-9 at most 20 000 terminal negative records: past the cap the oldest are dropped; non-terminal entries are never dropped for it', async (t) => {
  const dir = await workdir(t)
  assert.equal(MEDIA_LEDGER_TERMINAL_MAX, 20_000)
  let now = 1
  const ledger = new MediaLedger(dir, { now: () => now++ })
  await ledger.load()
  const owner = ledgerOwner(ME)
  const keep = [mediaStem('i:keep-1'), mediaStem('i:keep-2')]
  ledger.begin(owner, keep[0], { origin: 'history', kind: 'IMAGE' })
  ledger.record(owner, keep[0], { status: 'failed', class: 'transient', code: 'OBS_NETWORK' })
  ledger.begin(owner, keep[1], { origin: 'history', kind: 'IMAGE' })
  ledger.record(owner, keep[1], { status: 'failed', class: 'undecryptable', code: 'SIZE_MISMATCH' })
  const total = MEDIA_LEDGER_TERMINAL_MAX + 7
  const stems = []
  for (let i = 0; i < total; i++) {
    const s = mediaStem(`i:t${i}`)
    stems.push(s)
    ledger.begin(owner, s, { origin: 'history', kind: 'IMAGE' })
    ledger.record(owner, s, { status: 'failed', class: i % 2 ? 'expired' : 'undecryptable', code: i % 2 ? 'OBS_HTTP_404' : 'HMAC_MISMATCH' })
  }
  assert.equal(ledger.counts().terminalNegative, MEDIA_LEDGER_TERMINAL_MAX)
  for (let i = 0; i < 7; i++) assert.equal(ledger.get(owner, stems[i]), null, `oldest #${i} dropped`)
  assert.ok(ledger.get(owner, stems[7]), 'the 8th oldest is kept')
  assert.ok(ledger.get(owner, stems.at(-1)), 'the newest is kept')
  assert.ok(ledger.get(owner, keep[0]) && ledger.get(owner, keep[1]), 'non-terminal entries (transient, SIZE_MISMATCH) are kept')
  await ledger.flush()
  const reloaded = new MediaLedger(dir)
  const counts = await reloaded.load()
  assert.equal(counts.terminalNegative, MEDIA_LEDGER_TERMINAL_MAX)
  assert.equal(counts.total, MEDIA_LEDGER_TERMINAL_MAX + 2)
  // a smaller cap is enforced on load as well
  const small = new MediaLedger(dir, { terminalMax: 10 })
  assert.equal((await small.load()).terminalNegative, 10)
  assert.ok(small.get(owner, stems.at(-1)))
  assert.equal(small.get(owner, stems.at(-11)), null)
})

// ───────────────────────── 7. detectSupportedVideoMime (ported, header only) ─────────────────────────

test('X2a-10 detectSupportedVideoMime: header only, no size cap; mp4 / mov by brand, webm by EBML; HEIF/AVIF and other bytes are not video; a declared type must be compatible', () => {
  assert.equal(detectSupportedVideoMime(mp4(16, 1, 'isom')), 'video/mp4')
  assert.equal(detectSupportedVideoMime(mp4(16, 1, 'mp42')), 'video/mp4')
  assert.equal(detectSupportedVideoMime(mp4(16, 1, 'qt  ')), 'video/quicktime')
  assert.equal(detectSupportedVideoMime(mp4(16, 1, 'heic')), null)
  assert.equal(detectSupportedVideoMime(mp4(16, 1, 'avif')), null)
  assert.equal(detectSupportedVideoMime(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2])), 'video/webm')
  assert.equal(detectSupportedVideoMime(png()), null)
  assert.equal(detectSupportedVideoMime(Buffer.alloc(8)), null)
  assert.equal(detectSupportedVideoMime(mp4(16, 1, 'isom'), 'video/webm'), null)
  assert.equal(detectSupportedVideoMime(mp4(16, 1, 'qt  '), 'video/mp4'), 'video/quicktime', 'the content decides mp4 vs mov')
  assert.equal(detectSupportedVideoMime(mp4(16, 1, 'isom'), 'application/octet-stream'), 'video/mp4')
  const header = mp4(64 * KIB, 2)
  assert.equal(detectSupportedVideoMime(header), 'video/mp4', 'a 64 KiB header of a file of any size is enough')
})

// ───────────────────────── review-x2a fix1（F-1 … F-7、I-2） ─────────────────────────

/**
 * Replace one node:fs/promises function until the test ends. The modules under test hold named imports of node:fs/promises;
 * module.syncBuiltinESMExports() makes those bindings follow the replacement (and the restore).
 */
function interceptFs(t, name, make) {
  const original = fsp[name]
  fsp[name] = make(original)
  syncBuiltinESMExports()
  t.after(() => { fsp[name] = original; syncBuiltinESMExports() })
}
/** Observe every FileHandle#sync until the test ends. */
async function interceptSync(t, onSync) {
  const probe = path.join(os.tmpdir(), `line-todo-x2a-sync-${randomUUID()}`)
  const handle = await fsp.open(probe, 'w')
  const proto = Object.getPrototypeOf(handle)
  await handle.close()
  await rm(probe, { force: true })
  const original = proto.sync
  proto.sync = function sync(...args) { onSync(); return original.apply(this, args) }
  t.after(() => { proto.sync = original })
}
const errno = (code, from, to) => Object.assign(new Error(`${code}: synthetic, link '${from}' -> '${to}'`), { code })
const fileSpec = (id, over = {}) => ({ stem: stemOf(id), kind: 'FILE', origin: 'history', chatId: GROUP, chatName: 'Team', fileName: 'report.pdf', sentAt: SENT_AT, ...over })
const fileRows = (...ids) => new Map(ids.map((id) => [`i:${id}`, { content_type: 14 }]))
const e2eeFile = (id, km, bytes) => ({ stem: stemOf(id), kind: 'FILE', messageId: id, chatId: GROUP, transport: 'e2ee', sid: 'emf', oid: OID, keyMaterial: km, declaredBytes: bytes, origin: 'history' })

/** Two stems whose saved-files name is the same, committed at the same time (odd rounds: one through a stream target's commit). */
async function crossStemRounds(t, rounds, base) {
  const out = { rounds, wrong: 0, rejected: 0, sameRel: 0 }
  for (let run = 0; run < rounds; run++) {
    const dir = await workdir(t)
    const sink = new LineJsMediaSink({ dataDir: dir })
    const a = { id: String(base + run * 2), bytes: Buffer.alloc(4096, 0x41) }
    const b = { id: String(base + run * 2 + 1), bytes: Buffer.alloc(4096, 0x42) } // same size, different content
    let first
    if (run % 2) {
      const target = await sink.targetFor(fileSpec(a.id))
      await writeFile(target.partPath, a.bytes)
      first = target.commit(target.partPath, { mime: 'application/pdf', bytes: a.bytes.length }).then(() => target.result)
    } else first = sink.saveBytes(fileSpec(a.id), a.bytes, 'application/pdf')
    const settled = await Promise.allSettled([first, sink.saveBytes(fileSpec(b.id), b.bytes, 'application/pdf')])
    out.rejected += settled.filter((s) => s.status === 'rejected').length
    if (settled.every((s) => s.status === 'fulfilled') && settled[0].value.rel === settled[1].value.rel) out.sameRel++
    const media = m1(dir, fileRows(a.id, b.id))
    for (const x of [a, b]) {
      const r = media.savedFile(`i:${x.id}`)
      if (!r.ok || !(await readFile(r.absPath)).equals(x.bytes)) out.wrong++
    }
  }
  return out
}

test('X2a-fix1 F-1 cross-stem race: two messages whose saved-files name is the same, committed at the same time, never overwrite or delete each other (20 rounds, hard link; 20 rounds, the no-hard-link fallback)', async (t) => {
  const native = await crossStemRounds(t, 20, 8200)
  assert.deepEqual(native, { rounds: 20, wrong: 0, rejected: 0, sameRel: 0 }, 'hard link landing')
  // a volume without hard links: link fails with EPERM → the sink falls back to a lock keyed by the final path + lstat + rename
  let linkCalls = 0
  interceptFs(t, 'link', () => async (from, to) => { linkCalls++; throw errno('EPERM', from, to) })
  const fallback = await crossStemRounds(t, 20, 8300)
  assert.ok(linkCalls > 0, 'the landing tried a hard link first')
  assert.deepEqual(fallback, { rounds: 20, wrong: 0, rejected: 0, sameRel: 0 }, 'fallback landing')
})

test('X2a-fix1 F-2a one brand list: every HEIF/AVIF brand is refused by the stream sniff and by the sink detector alike; an avis "video" costs one request and ends terminal', async (t) => {
  const brands = autoDownload.UNSUPPORTED_VIDEO_BRANDS
  assert.ok(Array.isArray(brands), 'the brand list is one exported constant')
  for (const b of ['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'avif', 'avis']) assert.ok(brands.includes(b), b)
  for (const b of brands) {
    assert.deepEqual(sniffPlaintext('VIDEO', mp4(64 * KIB, 1, b)), { ok: false, code: 'VIDEO_TYPE_UNSUPPORTED' }, `stream sniff ${b}`)
    assert.equal(detectSupportedVideoMime(mp4(64 * KIB, 1, b)), null, `sink detector ${b}`)
  }
  for (const b of ['isom', 'mp42', 'qt  ']) assert.equal(sniffPlaintext('VIDEO', mp4(64 * KIB, 1, b)).mime, detectSupportedVideoMime(mp4(64 * KIB, 1, b)), `both accept ${b} the same way`)
  const dir = await workdir(t)
  const sink = new LineJsMediaSink({ dataDir: dir })
  const km = randomBytes(32)
  const video = mp4(300 * KIB + 3, 5, 'avis')
  const obs = obsServer(new Map([[`/r/talk/emv/${OID}`, encrypt(video, km)]]))
  const stem = stemOf('8401')
  const target = await sink.targetFor({ stem, kind: 'VIDEO', origin: 'history', chatId: GROUP })
  const out = await streamDownload({ stem, kind: 'VIDEO', messageId: '8401', chatId: GROUP, transport: 'e2ee', sid: 'emv', oid: OID, keyMaterial: km, declaredBytes: video.length, origin: 'history' }, session, target, streamOpts(obs.fetch))
  assert.deepEqual(out, { status: 'failed', class: 'unsupported', code: 'VIDEO_TYPE_UNSUPPORTED' })
  assert.equal(obs.requests.length, 1, 'one request, no re-download')
  assert.deepEqual(await readdir(path.join(dir, SAVED_MEDIA_DIR)), [], 'no part, nothing landed')
})

test('X2a-fix1 F-2b the sink\'s refusals carry a class: content, stem, unsafe path and name conflict are unsupported — through the stream that is one request and a terminal outcome, never a transient re-download', async (t) => {
  const dir = await workdir(t)
  const sink = new LineJsMediaSink({ dataDir: dir })
  await assert.rejects(sink.saveBytes({ stem: stemOf('8501'), kind: 'IMAGE', origin: 'outbound', chatId: GROUP }, png(), 'image/jpeg'), { code: 'SINK_CONTENT_MISMATCH', class: 'unsupported' })
  await assert.rejects(sink.saveBytes({ stem: 'not-a-stem', kind: 'IMAGE', origin: 'outbound', chatId: GROUP }, png(), 'image/png'), { code: 'SINK_STEM_INVALID', class: 'unsupported' })
  const km = randomBytes(32)
  const bytes = randomBytes(100 * KIB)
  // unsafe path: the chat folder is a regular file
  const blocked = fileSpec('8502', { chatName: 'Blocked' })
  await mkdir(path.join(dir, SAVED_FILE_DIR), { recursive: true })
  await writeFile(path.join(dir, SAVED_FILE_DIR, savedFilePlacement(blocked, SENT_AT).chatDir), 'not a directory')
  const obs1 = obsServer(new Map([[`/r/talk/emf/${OID}`, encrypt(bytes, km)]]))
  const out1 = await streamDownload(e2eeFile('8502', km, bytes.length), session, await sink.targetFor(blocked), streamOpts(obs1.fetch))
  assert.deepEqual(out1, { status: 'failed', class: 'unsupported', code: 'SINK_PATH_UNSAFE' })
  assert.equal(obs1.requests.length, 1)
  assert.deepEqual(await parts(dir), [], 'a terminal refusal drops the part')
  // name conflict: every saved-files name is taken
  interceptFs(t, 'link', (original) => async (from, to) => { if (String(to).includes(`${path.sep}${SAVED_FILE_DIR}${path.sep}`)) throw errno('EEXIST', from, to); return original(from, to) })
  const obs2 = obsServer(new Map([[`/r/talk/emf/${OID}`, encrypt(bytes, km)]]))
  const out2 = await streamDownload(e2eeFile('8503', km, bytes.length), session, await sink.targetFor(fileSpec('8503')), streamOpts(obs2.fetch))
  assert.deepEqual(out2, { status: 'failed', class: 'unsupported', code: 'SINK_NAME_CONFLICT' })
  assert.equal(obs2.requests.length, 1, 'a name conflict is not downloaded again')
  assert.deepEqual(await parts(dir), [])
})

test('X2a-fix1 F-2c / I-2 an I/O error at commit is transient, carries only the errno code (no path), and keeps the part: the commit succeeds from it later, and the stream resumes with Range instead of downloading again', async (t) => {
  const dir = await workdir(t)
  const sink = new LineJsMediaSink({ dataDir: dir })
  const failNext = { suffix: null }
  interceptFs(t, 'link', (original) => async (from, to) => {
    if (failNext.suffix && String(to).endsWith(failNext.suffix)) { failNext.suffix = null; throw errno('EIO', from, to) }
    return original(from, to)
  })
  // a target's commit
  const img = png()
  const stem = stemOf('8601')
  const target = await sink.targetFor({ stem, kind: 'IMAGE', origin: 'history', chatId: GROUP })
  await writeFile(target.partPath, img)
  failNext.suffix = `${stem}.png`
  const err = await target.commit(target.partPath, { mime: 'image/png', bytes: img.length }).then(() => null, (e) => e)
  assert.deepEqual([err?.code, err?.class, err?.message], ['EIO', 'transient', 'EIO'], 'no absolute path in the error (I-2)')
  assert.deepEqual(await readFile(target.partPath), img, 'the part is kept')
  await target.commit(target.partPath, { mime: 'image/png', bytes: img.length })
  assert.equal(target.result.status, 'written')
  assert.equal(m1(dir, new Map([['i:8601', { content_type: 1 }]])).prepare('i:8601').ok, true)
  // saveBytes: the same error, no path either
  failNext.suffix = `${stemOf('8602')}.png`
  const err2 = await sink.saveBytes({ stem: stemOf('8602'), kind: 'IMAGE', origin: 'outbound', chatId: GROUP }, img, 'image/png').then(() => null, (e) => e)
  assert.deepEqual([err2?.code, err2?.class, err2?.message], ['EIO', 'transient', 'EIO'])
  // the stream: the first commit fails with EIO → transient retry that resumes from the kept part
  const km = randomBytes(32)
  const video = mp4(300 * KIB + 5, 9)
  const obs = obsServer(new Map([[`/r/talk/emv/${OID}`, encrypt(video, km)]]))
  const vstem = stemOf('8603')
  failNext.suffix = `${vstem}.mp4`
  const vt = await sink.targetFor({ stem: vstem, kind: 'VIDEO', origin: 'history', chatId: GROUP })
  const out = await streamDownload({ stem: vstem, kind: 'VIDEO', messageId: '8603', chatId: GROUP, transport: 'e2ee', sid: 'emv', oid: OID, keyMaterial: km, declaredBytes: video.length, origin: 'history' }, session, vt, streamOpts(obs.fetch))
  assert.deepEqual(out, { status: 'done', bytes: video.length, mime: 'video/mp4' })
  assert.equal(obs.requests.length, 2)
  const m = /^bytes=(\d+)-$/.exec(String(obs.requests[1].range))
  assert.ok(m && Number(m[1]) > 0, `the retry resumed from the part (range ${obs.requests[1].range})`)
  assert.deepEqual(await readFile(path.join(dir, SAVED_MEDIA_DIR, `${vstem}.mp4`)), video)
  // a sink whose dataDir cannot be used: the error names no path either
  const notDir = path.join(dir, 'plain-file')
  await writeFile(notDir, 'x')
  const err3 = await new LineJsMediaSink({ dataDir: notDir }).saveBytes({ stem: stemOf('8604'), kind: 'IMAGE', origin: 'outbound', chatId: GROUP }, img, 'image/png').then(() => null, (e) => e)
  assert.ok(err3 && typeof err3.code === 'string', 'rejected')
  assert.equal(err3.message, err3.code)
  assert.equal(String(err3.stack ?? '').split('\n')[0].includes(dir), false)
})

test('X2a-fix1 F-3 bidi controls and zero-width characters are removed from every path segment and from the record name', async (t) => {
  // U+200C／U+200D（ZWNJ／ZWJ）are kept since X2a-fix2 N-3 (see the N-3 test below)
  const invisible = [0x200b, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff].map((c) => String.fromCharCode(c))
  for (const ch of invisible) assert.equal(safeSegment(`a${ch}b`, 100, 'x'), 'ab', `U+${ch.charCodeAt(0).toString(16)}`)
  assert.equal(safeSegment(invisible.join(''), 100, 'fallback'), 'fallback')
  const dir = await workdir(t)
  const sink = new LineJsMediaSink({ dataDir: dir })
  const r = await sink.saveBytes(fileSpec('8701', { chatName: '\u202Eroom\u200B', fileName: 'invoice\u202Efdp\u2066.exe\uFEFF' }), Buffer.from('body'), 'application/octet-stream')
  const re = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/
  assert.equal(re.test(r.rel), false, JSON.stringify(r.rel))
  assert.match(r.rel, /^saved-files\/room--[0-9a-f]{10}\/\d{8}-\d{6}_invoicefdp\.exe$/)
  const meta = JSON.parse(await readFile(path.join(dir, SAVED_MEDIA_DIR, `${stemOf('8701')}${SAVED_META_SUFFIX}`), 'utf8'))
  assert.equal(meta.name, 'invoicefdp.exe')
  assert.equal(m1(dir, fileRows('8701')).savedFile('i:8701').ok, true)
})

test('X2a-fix1 F-4 durability: the part saveBytes writes, the .file.json and the ledger flush are fsynced before their link / rename', async (t) => {
  const events = []
  await interceptSync(t, () => events.push('sync'))
  interceptFs(t, 'link', (original) => async (from, to) => { events.push(`land:${path.basename(String(to))}`); return original(from, to) })
  interceptFs(t, 'rename', (original) => async (from, to) => { events.push(`land:${path.basename(String(to))}`); return original(from, to) })
  const synced = (index) => index > 0 && events.slice(0, index).includes('sync')
  const dir = await workdir(t)
  const sink = new LineJsMediaSink({ dataDir: dir })
  events.length = 0
  await sink.saveBytes({ stem: stemOf('8801'), kind: 'IMAGE', origin: 'outbound', chatId: GROUP }, png(), 'image/png')
  assert.ok(synced(events.indexOf(`land:${stemOf('8801')}.png`)), `image part: ${events.join(',')}`)
  events.length = 0
  const r = await sink.saveBytes(fileSpec('8802'), Buffer.from('file body'), 'application/pdf')
  const landFile = events.indexOf(`land:${r.rel.split('/').at(-1)}`)
  const landMeta = events.indexOf(`land:${stemOf('8802')}${SAVED_META_SUFFIX}`)
  assert.ok(synced(landFile), `file part: ${events.join(',')}`)
  assert.ok(landMeta > landFile && events.slice(landFile + 1, landMeta).includes('sync'), `record: ${events.join(',')}`)
  const ledger = new MediaLedger(dir)
  await ledger.load()
  events.length = 0
  ledger.begin(ledgerOwner(ME), stemOf('8803'), { origin: 'history', kind: 'IMAGE' })
  await ledger.flush()
  assert.ok(synced(events.indexOf(`land:${MEDIA_LEDGER_NAME}`)), `ledger: ${events.join(',')}`)
})

test('X2a-fix1 F-4 ledger recovery: an empty or unparsable media-ledger.json is moved to .corrupt-<ms> and the ledger starts empty (one code-only log line, v1 not re-imported); leftover temp files are removed on load; a newer version still refuses', async (t) => {
  const ownerKey = ledgerOwner(ME)
  const v1 = JSON.stringify({ version: 1, items: [{ key: `${ownerKey}\0${GROUP}\0${IMG_ID}\0IMAGE`, chatId: GROUP, messageId: IMG_ID, kind: 'IMAGE', status: 'completed', bytes: 9, createdAt: 1, updatedAt: 2, metadata: {} }] })
  const NOW = 1_700_000_000_123
  for (const [label, content, code] of [['empty', '', 'LEDGER_EMPTY'], ['blank', ' \r\n', 'LEDGER_EMPTY'], ['half', '{"version":2,"items":[{"owner":"', 'LEDGER_CORRUPT'], ['null', 'null', 'LEDGER_CORRUPT'], ['array', '[]', 'LEDGER_CORRUPT'], ['number', '7', 'LEDGER_CORRUPT']]) {
    const dir = await workdir(t)
    await writeFile(path.join(dir, MEDIA_LEDGER_NAME), content)
    await writeFile(path.join(dir, MEDIA_LEDGER_V1_NAME), v1)
    const lines = []
    const ledger = new MediaLedger(dir, { now: () => NOW, log: (line) => lines.push(line) })
    assert.equal((await ledger.load()).total, 0, label)
    assert.deepEqual(lines, [`code=${code}`], `${label}: one line, only the code`)
    assert.equal(await readFile(path.join(dir, `${MEDIA_LEDGER_NAME}.corrupt-${NOW}`), 'utf8'), content, `${label}: the original is kept aside`)
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, MEDIA_LEDGER_NAME), 'utf8')), { version: 2, items: [] }, `${label}: an empty v2 is on disk at once`)
    const again = new MediaLedger(dir, { log: (line) => lines.push(line) })
    assert.equal((await again.load()).total, 0, `${label}: the next start reads the empty v2, v1 is not imported`)
    assert.equal(lines.length, 1)
  }
  // temp files left by a crashed flush are removed; nothing else is
  const dir = await workdir(t)
  await writeFile(path.join(dir, `${MEDIA_LEDGER_NAME}.${randomUUID()}.part`), '{"version":2')
  await writeFile(path.join(dir, 'unrelated.part'), 'keep')
  await writeFile(path.join(dir, `${MEDIA_LEDGER_NAME}.corrupt-1`), 'keep')
  await new MediaLedger(dir).load()
  assert.deepEqual((await readdir(dir)).sort(), [`${MEDIA_LEDGER_NAME}.corrupt-1`, 'unrelated.part'])
  // a newer format is not "corrupt": it still refuses and stays untouched
  await writeFile(path.join(dir, MEDIA_LEDGER_NAME), '{"version":3,"items":[]}')
  await assert.rejects(new MediaLedger(dir, { log: () => {} }).load(), { code: 'LEDGER_VERSION' })
  assert.equal(await readFile(path.join(dir, MEDIA_LEDGER_NAME), 'utf8'), '{"version":3,"items":[]}')
  // a broken v1 (no v2 yet): not imported, not modified, one code-only line
  const dir2 = await workdir(t)
  await writeFile(path.join(dir2, MEDIA_LEDGER_V1_NAME), '{"version":1,')
  const lines = []
  assert.equal((await new MediaLedger(dir2, { log: (line) => lines.push(line) }).load()).total, 0)
  assert.deepEqual(lines, ['code=LEDGER_V1_CORRUPT'])
  assert.equal(await readFile(path.join(dir2, MEDIA_LEDGER_V1_NAME), 'utf8'), '{"version":1,')
})

test('X2a-fix1 F-5 size is verified before landing: a part whose size differs never reaches the landing, not even briefly; a part that changes between the check and the landing is withdrawn from the landing', async (t) => {
  const dir = await workdir(t)
  const sink = new LineJsMediaSink({ dataDir: dir })
  const img = png()
  const saved = () => readdir(path.join(dir, SAVED_MEDIA_DIR))
  const stem = stemOf('8901')
  const target = await sink.targetFor({ stem, kind: 'IMAGE', origin: 'history', chatId: GROUP })
  await writeFile(target.partPath, img)
  await assert.rejects(target.commit(target.partPath, { mime: 'image/png', bytes: img.length + 1 }), { code: 'SINK_SIZE_MISMATCH' })
  assert.deepEqual(await saved(), [], 'no landed file, no part')
  assert.equal(sink.writes.get(stem), undefined, 'the mismatched part never landed')
  // the part grows between the size check and the landing
  const stem2 = stemOf('8902')
  const grow = (original) => async (from, to) => { if (path.basename(String(to)) === `${stem2}.png`) await appendFile(from, Buffer.from([0])); return original(from, to) }
  interceptFs(t, 'link', grow)
  interceptFs(t, 'rename', grow)
  await assert.rejects(sink.saveBytes({ stem: stem2, kind: 'IMAGE', origin: 'outbound', chatId: GROUP }, img, 'image/png'), { code: 'SINK_SIZE_MISMATCH' })
  assert.deepEqual(await saved(), [], 'the landed file was withdrawn')
  assert.equal(m1(dir, new Map([['i:8902', { content_type: 1 }]])).prepare('i:8902').ok, false)
})

test('X2a-fix1 F-6 orphans left by crashes (file landed, record never written) do not make the stem a permanent name conflict, and are never deleted', async (t) => {
  const dir = await workdir(t)
  const sink = new LineJsMediaSink({ dataDir: dir })
  const spec = fileSpec('9001', { fileName: 'a.zip' })
  const p0 = savedFilePlacement(spec, SENT_AT)
  const p1 = savedFilePlacement(spec, SENT_AT, spec.stem.slice(0, 8))
  await mkdir(path.join(dir, SAVED_FILE_DIR, p0.chatDir), { recursive: true })
  await writeFile(path.join(dir, ...p0.rel.split('/')), 'orphan 1')
  await writeFile(path.join(dir, ...p1.rel.split('/')), 'orphan 2')
  const rels = new Set([p0.rel, p1.rel])
  // two orphans, then six more crashes of the same stem (each loses the record and leaves the file behind)
  for (let i = 0; i < 7; i++) {
    const r = await sink.saveBytes(spec, Buffer.from(`real ${i}`), 'application/zip')
    assert.equal(r.status, 'written', `attempt ${i}`)
    assert.match(r.rel, /_[0-9a-f]{8}-[0-9a-f]{6}\.zip$/)
    assert.equal(rels.has(r.rel), false, 'a new name every time')
    rels.add(r.rel)
    const shown = m1(dir, fileRows('9001')).savedFile('i:9001')
    assert.equal(shown.ok, true)
    assert.equal((await readFile(shown.absPath)).toString(), `real ${i}`)
    if (i < 6) await rm(path.join(dir, SAVED_MEDIA_DIR, `${spec.stem}${SAVED_META_SUFFIX}`))
  }
  assert.equal((await readFile(path.join(dir, ...p0.rel.split('/')))).toString(), 'orphan 1', 'orphans are not deleted')
  assert.equal((await readFile(path.join(dir, ...p1.rel.split('/')))).toString(), 'orphan 2')
  assert.equal((await readdir(path.join(dir, SAVED_FILE_DIR, p0.chatDir))).length, 9)
})

/** A volume-GUID junction (`\\?\Volume{…}\<path>`): libuv's lstat reports it as a plain directory. Same helper as test-media-saved.mjs. */
function volumeJunction(link, targetDir) {
  if (process.platform !== 'win32') return { skip: 'volume GUID junctions exist only on Windows' }
  const real = realpathSync.native(targetDir)
  const mv = spawnSync('mountvol', [real.slice(0, 3), '/L'], { encoding: 'utf8' })
  const guid = (mv.stdout ?? '').trim()
  if (mv.status !== 0 || !/^\\\\\?\\Volume\{[0-9a-fA-F-]+\}\\$/.test(guid)) return { skip: `mountvol gave no volume GUID (exit ${mv.status})` }
  const mk = spawnSync('cmd', ['/c', 'mklink', '/J', link, guid + real.slice(3)], { encoding: 'utf8' })
  let st = null
  try { st = lstatSync(link) } catch { /* not created */ }
  if (mk.status !== 0 || !st) return { skip: `mklink /J to a volume GUID path failed (exit ${mk.status})` }
  return { reportedAsDirectory: st.isDirectory() && !st.isSymbolicLink() }
}
/** Remove only the link itself (non-recursive rmdir), then the temp dirs; a link that cannot be removed leaves everything in place and fails. */
function removeLinkThenDirs(link, ...dirs) {
  try { lstatSync(link); rmdirSync(link) } catch (error) { if (error.code !== 'ENOENT') throw new Error(`link ${link} could not be removed; temp dirs left in place: ${dirs.join(', ')}`) }
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
}
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'line-todo-x2a-link-'))

test('X2a-fix1 F-7 (RX8) ensureDir refuses links on the path — a junction, a directory symlink, and a volume-GUID junction that lstat reports as a plain directory; nothing is written outside dataDir', async (t) => {
  const img = png()
  { // junction as media-saved
    const dir = tmp(); const outside = tmp(); const link = path.join(dir, SAVED_MEDIA_DIR)
    try {
      symlinkSync(outside, link, 'junction')
      const sink = new LineJsMediaSink({ dataDir: dir })
      await assert.rejects(sink.saveBytes({ stem: stemOf('9101'), kind: 'IMAGE', origin: 'outbound', chatId: GROUP }, img, 'image/png'), { code: 'SINK_PATH_UNSAFE' })
      await assert.rejects(sink.targetFor({ stem: stemOf('9101'), kind: 'IMAGE', origin: 'history', chatId: GROUP }), { code: 'SINK_PATH_UNSAFE' })
      assert.deepEqual(await readdir(outside), [])
    } finally { removeLinkThenDirs(link, dir, outside) }
  }
  { // directory symlink as the chat folder (needs the symlink privilege; skipped without it)
    const dir = tmp(); const outside = tmp()
    const spec = fileSpec('9102', { chatName: 'Sym' })
    const link = path.join(dir, SAVED_FILE_DIR, savedFilePlacement(spec, SENT_AT).chatDir)
    try {
      await mkdir(path.join(dir, SAVED_FILE_DIR), { recursive: true })
      let made = true
      try { symlinkSync(outside, link, 'dir') } catch (error) { if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error; made = false; t.diagnostic(`directory symlink skipped: ${error.code}`) }
      if (made) {
        await assert.rejects(new LineJsMediaSink({ dataDir: dir }).saveBytes(spec, Buffer.from('x'), 'application/pdf'), { code: 'SINK_PATH_UNSAFE' })
        assert.deepEqual(await readdir(outside), [])
      }
    } finally { removeLinkThenDirs(link, dir, outside) }
  }
  { // volume-GUID junction as the chat folder: only the realpath containment check can see it
    const dir = tmp(); const outside = tmp()
    const spec = fileSpec('9103', { chatName: 'Vol' })
    const link = path.join(dir, SAVED_FILE_DIR, savedFilePlacement(spec, SENT_AT).chatDir)
    try {
      await mkdir(path.join(dir, SAVED_FILE_DIR), { recursive: true })
      const made = volumeJunction(link, outside)
      if (made.skip) { t.skip(made.skip); return }
      assert.equal(made.reportedAsDirectory, true, 'precondition: lstat reports the volume junction as a directory, not a link')
      await assert.rejects(new LineJsMediaSink({ dataDir: dir }).saveBytes(spec, Buffer.from('x'), 'application/pdf'), { code: 'SINK_PATH_UNSAFE' })
      assert.deepEqual(await readdir(outside), [], 'nothing written outside dataDir')
    } finally { removeLinkThenDirs(link, dir, outside) }
  }
})

// ───────────────────────── X2a-fix2（review-x2a-r2 N-1、N-2、N-3） ─────────────────────────

/** A fake OBS whose body breaks right after the headers on every request (206 with the right content-range when a Range is asked). */
function brokenBodyServer(objects) {
  const ranges = []
  const fetch = async (request) => {
    const url = new URL(request.url)
    const body = objects.get(url.pathname)
    if (!body) return new Response('', { status: 404 })
    const range = request.headers.get('range')
    ranges.push(range)
    const m = /^bytes=(\d+)-$/.exec(range ?? '')
    const start = m ? Number(m[1]) : 0
    const headers = { 'content-length': String(body.length - start) }
    if (m) headers['content-range'] = `bytes ${start}-${body.length - 1}/${body.length}`
    const stream = new ReadableStream({ pull(controller) { controller.error(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })) } })
    return new Response(stream, { status: m ? 206 : 200, headers })
  }
  return { fetch, ranges }
}

test('X2a-fix2 N-1 crash between link and unlink(part): the resume never reuses the part that is the landed file (nlink 2) or a part of a stem already landed; the landed file stays byte-for-byte the same', async (t) => {
  const dir = await workdir(t)
  const sink = new LineJsMediaSink({ dataDir: dir })
  const km = randomBytes(32)
  const video = mp4(300 * KIB + 5, 11) // size % 16 = 5: a resume from this part would start 5 bytes before the end and truncate there
  const id = '9201'
  const stem = stemOf(id)
  const spec = { stem, kind: 'VIDEO', origin: 'history', chatId: GROUP }
  const locator = { stem, kind: 'VIDEO', messageId: id, chatId: GROUP, transport: 'e2ee', sid: 'emv', oid: OID, keyMaterial: km, declaredBytes: video.length, origin: 'history' }
  const target = await sink.targetFor(spec)
  // the process "dies" right after link(part, final), before unlink(part): that one unlink fails, so the part name outlives the landing
  let armed = false
  interceptFs(t, 'link', (original) => async (from, to) => { const v = await original(from, to); if (path.resolve(String(from)) === path.resolve(target.partPath)) armed = true; return v })
  interceptFs(t, 'unlink', (original) => async (p) => { if (armed && path.resolve(String(p)) === path.resolve(target.partPath)) { armed = false; throw errno('EBUSY', p, '') } return original(p) })
  const obs = obsServer(new Map([[`/r/talk/emv/${OID}`, encrypt(video, km)]]))
  assert.equal((await streamDownload(locator, session, target, streamOpts(obs.fetch))).status, 'done')
  const finalAbs = path.join(dir, SAVED_MEDIA_DIR, `${stem}.mp4`)
  assert.equal((await stat(finalAbs)).nlink, 2, 'precondition: the part and the landed file are one inode')
  // restart: the ledger still holds the part name, the resume hands it back
  const t2 = await sink.targetFor(spec, { partName: target.partName })
  assert.notEqual(t2.partName, target.partName, 'a part with nlink > 1 is never resumed')
  assert.equal(await stat(target.partPath).then(() => true, () => false), false, 'the alias name is removed')
  assert.equal((await stat(finalAbs)).nlink, 1, 'removing the alias leaves the landed file as the only name')
  assert.deepEqual(await readFile(finalAbs), video, 'removing the alias does not change the landed file')
  // the resume itself, with a network that breaks after the headers every time (the P9 probe): the landed file is untouched
  const broken = brokenBodyServer(new Map([[`/r/talk/emv/${OID}`, encrypt(video, km)]]))
  const out = await streamDownload(locator, session, t2, streamOpts(broken.fetch, { maxAttempts: 2 }))
  assert.equal(out.status, 'failed')
  assert.deepEqual(broken.ranges, [null, null], 'no Range: nothing was resumed from the landed file')
  assert.deepEqual(await readFile(finalAbs), video, 'the landed file is byte-for-byte the same after the failed resume')
  assert.deepEqual((await sink.existing(stem, 'VIDEO'))?.bytes, video.length)
  // a fresh download of the same stem only sees `exists`
  const t3 = await sink.targetFor(spec)
  const obs3 = obsServer(new Map([[`/r/talk/emv/${OID}`, encrypt(video, km)]]))
  await streamDownload(locator, session, t3, streamOpts(obs3.fetch))
  assert.equal(t3.result?.status, 'exists')
  assert.deepEqual(await readFile(finalAbs), video)
  assert.equal(m1(dir, new Map([[`i:${id}`, { content_type: 2 }]])).prepareVideo(`i:${id}`).ok, true)
  // a leftover part (nlink 1) of a stem that has already landed is not resumed either
  const leftover = path.join(dir, SAVED_MEDIA_DIR, partNameFor(stem))
  await writeFile(leftover, video.subarray(0, 100 * KIB))
  const t4 = await sink.targetFor(spec, { partName: path.basename(leftover) })
  assert.notEqual(t4.partName, path.basename(leftover))
  assert.equal(await stat(leftover).then(() => true, () => false), false, 'the leftover part is removed')
  assert.deepEqual(await readFile(finalAbs), video)
  // nlink > 1 on its own, the stem not landed (e.g. a file's landing link happened, its record never did): the part shares its inode
  // with another name, so it is not resumed and that other name keeps its bytes even when the resume's network breaks
  const third = stemOf('9203')
  const otherName = path.join(dir, 'other-name.bin')
  const otherBytes = video.subarray(0, 100 * KIB + 5)
  await writeFile(otherName, otherBytes)
  const aliasPart = path.join(dir, SAVED_MEDIA_DIR, partNameFor(third))
  await fsp.link(otherName, aliasPart)
  assert.equal(await sink.existing(third, 'VIDEO'), null, 'precondition: this stem has not landed')
  const t6 = await sink.targetFor({ ...spec, stem: third }, { partName: path.basename(aliasPart) })
  assert.notEqual(t6.partName, path.basename(aliasPart), 'a part with nlink > 1 is not resumed even when its stem has not landed')
  const broken6 = brokenBodyServer(new Map([[`/r/talk/emv/${OID}`, encrypt(video, km)]]))
  await streamDownload({ ...locator, stem: third, messageId: '9203' }, session, t6, streamOpts(broken6.fetch, { maxAttempts: 1 }))
  assert.deepEqual(broken6.ranges, [null])
  assert.deepEqual(await readFile(otherName), otherBytes, 'the other name of that inode is untouched')
  // control: a genuine part (nlink 1, the stem not landed) is still resumed
  const other = stemOf('9202')
  const genuine = path.join(dir, SAVED_MEDIA_DIR, partNameFor(other))
  await writeFile(genuine, video.subarray(0, 100 * KIB))
  const t5 = await sink.targetFor({ ...spec, stem: other }, { partName: path.basename(genuine) })
  assert.equal(t5.partName, path.basename(genuine), 'a part that is not an alias and whose stem has not landed is resumed')
})

test('X2a-fix2 N-2 ENOSPC from link at commit: through the stream the outcome is paused/disk_low, the part is kept, and a later call resumes from it with Range', async (t) => {
  const dir = await workdir(t)
  const sink = new LineJsMediaSink({ dataDir: dir })
  const km = randomBytes(32)
  const video = mp4(200 * KIB + 3, 4)
  const id = '9301'
  const stem = stemOf(id)
  const spec = { stem, kind: 'VIDEO', origin: 'history', chatId: GROUP }
  const locator = { stem, kind: 'VIDEO', messageId: id, chatId: GROUP, transport: 'e2ee', sid: 'emv', oid: OID, keyMaterial: km, declaredBytes: video.length, origin: 'history' }
  let enospc = 0
  interceptFs(t, 'link', (original) => async (from, to) => { if (enospc === 0 && String(to).endsWith(`${stem}.mp4`)) { enospc++; throw errno('ENOSPC', from, to) } return original(from, to) })
  const obs = obsServer(new Map([[`/r/talk/emv/${OID}`, encrypt(video, km)]]))
  const target = await sink.targetFor(spec)
  const out = await streamDownload(locator, session, target, streamOpts(obs.fetch))
  assert.deepEqual(out, { status: 'paused', class: 'disk_low', code: 'DISK_LOW' })
  assert.equal(enospc, 1)
  assert.equal(obs.requests.length, 1, 'ENOSPC is not retried inside the call (no transient re-download)')
  assert.deepEqual(await readFile(target.partPath), video, 'the part is kept, complete')
  assert.equal(await sink.existing(stem, 'VIDEO'), null, 'nothing landed')
  const t2 = await sink.targetFor(spec, { partName: target.partName })
  assert.equal(t2.partName, target.partName, 'the kept part is resumed')
  const out2 = await streamDownload(locator, session, t2, streamOpts(obs.fetch))
  assert.deepEqual(out2, { status: 'done', bytes: video.length, mime: 'video/mp4' })
  const m = /^bytes=(\d+)-$/.exec(String(obs.requests[1]?.range))
  assert.ok(m && Number(m[1]) > 0, `resumed with Range (${obs.requests[1]?.range})`)
  assert.deepEqual(await readFile(path.join(dir, SAVED_MEDIA_DIR, `${stem}.mp4`)), video)
})

test('X2a-fix2 N-3 INVISIBLE keeps ZWJ / ZWNJ (family emoji, Persian, Devanagari stay intact) and removes U+00AD, U+061C, U+180E, U+2060-2064, U+206A-206F with the earlier bidi / zero-width set', async (t) => {
  const cp = (...codes) => String.fromCodePoint(...codes)
  const kept = {
    familyEmoji: cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467),
    persianZwnj: cp(0x0645, 0x06cc, 0x200c, 0x062e, 0x0648, 0x0627, 0x0647, 0x0645),
    devanagariZwj: cp(0x0915, 0x094d, 0x200d, 0x0937),
  }
  for (const [name, value] of Object.entries(kept)) assert.equal(safeSegment(value, 100, 'x'), value, `${name} is kept as is`)
  const removed = [0x00ad, 0x061c, 0x180e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f,
    0x200b, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff]
  for (const c of removed) assert.equal(safeSegment(`a${cp(c)}b`, 100, 'x'), 'ab', `U+${c.toString(16).toUpperCase().padStart(4, '0')} is removed`)
  // through the sink: a file whose name and chat carry both kinds keeps the joiners and loses the rest, in the path and in the record
  const dir = await workdir(t)
  const sink = new LineJsMediaSink({ dataDir: dir })
  const fileName = `${kept.familyEmoji}${cp(0x00ad)}${kept.persianZwnj}${cp(0x2060, 0x061c)}.pdf`
  const r = await sink.saveBytes(fileSpec('9401', { chatName: `${kept.devanagariZwj}${cp(0x180e, 0x206a)}`, fileName }), Buffer.from('body'), 'application/pdf')
  assert.ok(r.rel.includes(`/${kept.devanagariZwj}--`), JSON.stringify(r.rel))
  assert.ok(r.rel.endsWith(`_${kept.familyEmoji}${kept.persianZwnj}.pdf`), JSON.stringify(r.rel))
  const meta = JSON.parse(await readFile(path.join(dir, SAVED_MEDIA_DIR, `${stemOf('9401')}${SAVED_META_SUFFIX}`), 'utf8'))
  assert.equal(meta.name, `${kept.familyEmoji}${kept.persianZwnj}.pdf`)
  assert.equal(m1(dir, fileRows('9401')).savedFile('i:9401').ok, true)
})

// ───────────────────────── X4 old photos backfilled by hard link; startup reconcile (implementation-plan.md §5.2 X4; v2 X4) ─────────────────────────
// The v1 ledger and the .teamuq tree are written by a real (non-frozen) AutoDownloadStore, as the pre-X2b version did. The backfill runs against
// the real OriginalDownloadService (its shared sink and ledger v2). Junctions only inside the test's own temp dir.

const X4_OWNER = ledgerOwner(ME)
const x4Id = (n) => String(9500000000000000000n + BigInt(n))

/** A dataDir whose v1 ledger holds `items` ({ n, kind, bytes, complete }); returns the legacy path of each completed item. */
async function x4Setup(t, items, { originals = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'line-todo-x4-backfill-'))
  const dataDir = path.join(root, 'plugin')
  const writer = new AutoDownloadStore(path.join(dataDir, 'linejs-downloads'))
  await writer.init()
  writer.setOwner(ME)
  const legacy = new Map()
  for (const it of items) {
    const id = x4Id(it.n)
    const kind = it.kind ?? 'IMAGE'
    await writer.enqueue({ chatId: GROUP, chatName: 'Legacy Room', message: { raw: { id } }, kind, metadata: { name: kind === 'IMAGE' ? `${id}.jpg` : 'doc.pdf' } })
    if (it.complete !== false) {
      await writer.saveFile(writer.keyFor(GROUP, id, kind), it.bytes)
      const job = writer.jobs.get(writer.keyFor(GROUP, id, kind))
      legacy.set(it.n, path.join(job.savedRoot, job.chatFolder, job.savedName))
    }
  }
  await writer.close()
  let service = null
  const logs = []
  if (originals) {
    service = new OriginalDownloadService({
      dataDir,
      session: { outboundSession: async () => null, isCurrentSession: () => false, onSessionChange: () => () => {} },
      localAccountMid: async () => ME,
      getDb: () => null,
      limiter: new ObsLimiter(),
      fetch: async () => { throw Object.assign(new Error('no network'), { code: 'TEST_NO_NETWORK' }) },
      log: (line) => logs.push(line),
    })
  }
  t.after(async () => { await service?.dispose(); releaseSharedLedger(dataDir); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })
  const run = (over = {}) => runBackfill({ dataDir, originals: service, log: (line) => logs.push(line), ...over })
  const savedPng = (n) => path.join(dataDir, SAVED_MEDIA_DIR, `${stemOf(x4Id(n))}.png`)
  return { root, dataDir, writer, legacy, originals: service, logs, run, savedPng }
}
const big = async (p) => fsp.stat(p, { bigint: true })
const ledgerBytes = async (dataDir) => readFile(path.join(dataDir, 'linejs-downloads', MEDIA_LEDGER_NAME))

test('X4-1 completed v1 photos are hard-linked into media-saved: same inode (nlink 2, no extra space), original kept byte-for-byte, M1 serves them, ledger v2 origin backfill', async (t) => {
  const photos = [png(60, 40, 3), png(50, 30, 5)]
  const s = await x4Setup(t, [{ n: 1, bytes: photos[0] }, { n: 2, bytes: photos[1] }, { n: 3, bytes: png(), complete: false }, { n: 4, kind: 'FILE', bytes: Buffer.from('%PDF-1.4 legacy') }])
  const before = new Map()
  for (const [n, p] of s.legacy) before.set(n, sha(await readFile(p)))
  const r = await s.run()
  assert.equal(r.complete, true)
  assert.deepEqual({ candidates: r.counts.candidates, linked: r.counts.linked }, { candidates: 2, linked: 2 }, JSON.stringify(r))
  for (const n of [1, 2]) {
    const [a, b] = await Promise.all([big(s.legacy.get(n)), big(s.savedPng(n))])
    assert.equal(a.ino, b.ino, 'same inode')
    assert.equal(a.dev, b.dev)
    assert.equal(b.nlink, 2n, 'one copy of the data, two names')
    assert.equal(sha(await readFile(s.legacy.get(n))), before.get(n), 'original untouched')
    assert.ok((await readFile(s.savedPng(n))).equals(photos[n - 1]))
    const id = x4Id(n)
    assert.equal(m1(s.dataDir, new Map([[`i:${id}`, { content_type: 1, key_material: null, file_size: null }]])).prepare(`i:${id}`).ok, true)
    const entry = s.originals.ledger.get(X4_OWNER, stemOf(id))
    assert.deepEqual({ origin: entry.origin, state: entry.state, code: entry.code }, { origin: 'backfill', state: 'done', code: null }, 'the V1_COMPLETED marker became a backfill record')
  }
  assert.deepEqual(await parts(s.dataDir), [], 'no part left')
  assert.ok(!(await readdir(path.join(s.dataDir, SAVED_MEDIA_DIR))).some((n) => n.startsWith(stemOf(x4Id(3)))), 'a v1 item that never completed is not backfilled')
  for (const line of s.logs) for (const secret of [s.dataDir, 'Legacy Room', GROUP, x4Id(1)]) assert.ok(!line.includes(secret), `log leaks: ${line}`)
})

test('X4-2 idempotent: a second start does not scan (UP_TO_DATE); a forced run links nothing more, keeps the inode and nlink, and leaves ledger v2 byte-identical', async (t) => {
  const s = await x4Setup(t, [{ n: 11, bytes: png(40, 30, 11) }, { n: 12, bytes: png(41, 31, 12) }])
  assert.equal((await s.run()).counts.linked, 2)
  await s.originals.flushNow()
  const ledger1 = await ledgerBytes(s.dataDir)
  const ino1 = (await big(s.savedPng(11))).ino
  const again = await s.run()
  assert.equal(again.skipped, 'UP_TO_DATE')
  const forced = await s.run({ force: true })
  assert.deepEqual({ linked: forced.counts.linked, exists: forced.counts.exists, complete: forced.complete }, { linked: 0, exists: 2, complete: true })
  await s.originals.flushNow()
  assert.ok((await ledgerBytes(s.dataDir)).equals(ledger1), 'ledger v2 unchanged by the forced run')
  const st = await big(s.savedPng(11))
  assert.equal(st.ino, ino1)
  assert.equal(st.nlink, 2n, 'no third name')
  assert.deepEqual(await parts(s.dataDir), [])
})

test('X4-3 a broken legacy file (ciphertext, not an image) is never linked: legacy_invalid in ledger v2 (not terminal: the original can still be downloaded); the file stays as it was', async (t) => {
  const cipher = randomBytes(9000)
  const s = await x4Setup(t, [{ n: 21, bytes: cipher }])
  const r = await s.run()
  assert.equal(r.counts.invalid, 1)
  assert.equal(r.counts.linked, 0)
  assert.ok((await readFile(s.legacy.get(21))).equals(cipher))
  assert.equal((await big(s.legacy.get(21))).nlink, 1n)
  assert.ok(!(await readdir(path.join(s.dataDir, SAVED_MEDIA_DIR)).catch(() => [])).some((n) => n.startsWith(stemOf(x4Id(21)))))
  const entry = s.originals.ledger.get(X4_OWNER, stemOf(x4Id(21)))
  assert.deepEqual({ state: entry.state, class: entry.class, code: entry.code }, { state: 'failed', class: 'transient', code: 'LEGACY_INVALID' })
  assert.equal(isTerminalNegative(entry), false)
  assert.ok(s.logs.some((l) => l.includes('code=LEGACY_INVALID')))
})

test('X4-4 an existing file is never overwritten: a landed <stem>.jpg (other bytes) wins and no <stem>.png appears; an unusable 0-byte <stem>.png at the target stays as it was', async (t) => {
  const s = await x4Setup(t, [{ n: 31, bytes: png(30, 30, 31) }, { n: 32, bytes: png(32, 32, 32) }])
  const savedDir = path.join(s.dataDir, SAVED_MEDIA_DIR)
  await mkdir(savedDir, { recursive: true })
  const receivedJpg = path.join(savedDir, `${stemOf(x4Id(31))}.jpg`)
  const received = Buffer.from('a jpeg written earlier by receive (stand-in bytes)')
  await writeFile(receivedJpg, received)
  const blocker = s.savedPng(32)
  await writeFile(blocker, Buffer.alloc(0))
  const blockerIno = (await big(blocker)).ino
  const r = await s.run()
  assert.equal(r.counts.exists, 1, JSON.stringify(r))
  assert.ok((await readFile(receivedJpg)).equals(received), 'the landed file is byte-identical')
  await assert.rejects(() => fsp.stat(s.savedPng(31)), { code: 'ENOENT' })
  assert.equal(r.counts.failed, 1, 'name taken by an unusable file: refused, not overwritten')
  assert.equal(r.complete, true, 'a name conflict is not retried every start')
  const after = await big(blocker)
  assert.equal(after.size, 0n)
  assert.equal(after.ino, blockerIno, 'the same file, never replaced')
  assert.equal((await big(s.legacy.get(32))).nlink, 1n, 'the legacy file has no new name left behind')
  assert.deepEqual(await parts(s.dataDir), [])
})

test('X4-5 no hard link support (EPERM / EXDEV …): skipped with a code — no copy, no extra space, nothing changed; not complete, so the next start tries again and links', async (t) => {
  const bytes = png(44, 33, 41)
  const s = await x4Setup(t, [{ n: 41, bytes }])
  for (const code of ['EPERM', 'EXDEV', 'ENOTSUP']) {
    const r = await s.run({ link: async () => { throw Object.assign(new Error(`link refused /secret/${code}`), { code }) } })
    assert.equal(r.counts.linkUnsupported, 1, code)
    assert.equal(r.complete, false)
    await assert.rejects(() => fsp.stat(s.savedPng(41)), { code: 'ENOENT' }, 'no copy')
    assert.equal((await big(s.legacy.get(41))).nlink, 1n)
  }
  assert.ok(s.logs.some((l) => l.includes('code=LEGACY_LINK_UNSUPPORTED')))
  assert.ok(!s.logs.join('\n').includes('/secret/'))
  const later = await s.run()
  assert.equal(later.counts.linked, 1, 'the next start (hard links available) links it')
  assert.equal((await big(s.legacy.get(41))).ino, (await big(s.savedPng(41))).ino)
})

test('X4-6 scope: an item outside <dataDir>/linejs-downloads/.teamuq, a chat folder that is a junction, a ".." name and a missing file are never linked; nothing outside is touched', async (t) => {
  const s = await x4Setup(t, [{ n: 51, bytes: png(20, 20, 51) }, { n: 52, bytes: png(21, 21, 52) }, { n: 53, bytes: png(22, 22, 53) }, { n: 54, bytes: png(23, 23, 54) }])
  const v1File = path.join(s.dataDir, 'linejs-downloads', MEDIA_LEDGER_V1_NAME)
  const doc = JSON.parse(await readFile(v1File, 'utf8'))
  const byId = (n) => doc.items.find((i) => i.messageId === x4Id(n))
  // 51: savedRoot outside the legacy tree (a custom absolute v1 path)
  const outside = path.join(s.root, 'elsewhere')
  await mkdir(path.join(outside, byId(51).chatFolder), { recursive: true })
  await writeFile(path.join(outside, byId(51).chatFolder, byId(51).savedName), png(20, 20, 51))
  byId(51).savedRoot = outside
  // 52: its chat folder replaced by a junction to a directory outside dataDir (the test's own temp dir)
  const target = path.join(s.root, 'junction-target')
  await mkdir(target, { recursive: true })
  await writeFile(path.join(target, byId(52).savedName), png(21, 21, 52))
  const chatDir52 = path.join(byId(52).savedRoot, byId(52).chatFolder)
  byId(52).chatFolder = `${byId(52).chatFolder}-j`
  symlinkSync(target, path.join(byId(52).savedRoot, byId(52).chatFolder), 'junction')
  // 53: a traversal name; 54: the file is gone
  byId(53).savedName = '..'
  await rm(s.legacy.get(54))
  await writeFile(v1File, JSON.stringify(doc))
  const r = await s.run()
  assert.deepEqual({ outside: r.counts.outside, unsafe: r.counts.unsafe, missing: r.counts.missing, linked: r.counts.linked }, { outside: 1, unsafe: 2, missing: 1, linked: 0 }, JSON.stringify(r))
  assert.deepEqual((await readdir(path.join(s.dataDir, SAVED_MEDIA_DIR)).catch(() => [])).filter((n) => !n.startsWith('.')), [])
  assert.equal((await big(path.join(target, byId(52).savedName))).nlink, 1n)
  assert.ok(lstatSync(chatDir52).isDirectory())
})

test('X4-9 review-x2b F-6 (P5): <dataDir>/linejs-downloads/.teamuq itself a junction to a directory outside dataDir (inside the test temp dir) → nothing linked, the outside file keeps nlink 1, code LEGACY_ROOT_OUTSIDE (realpath check), not complete; once it is a plain directory again the next start links', async (t) => {
  const bytes = png(30, 20, 9)
  const s = await x4Setup(t, [{ n: 91, bytes }])
  const legacy = path.join(s.dataDir, 'linejs-downloads', '.teamuq')
  const outside = path.join(s.root, 'outside-tree')
  await fsp.rename(legacy, outside)
  symlinkSync(outside, legacy, 'junction')
  const chatFolder = (await readdir(outside))[0]
  const outsideFile = path.join(outside, chatFolder, (await readdir(path.join(outside, chatFolder)))[0])
  const r = await s.run()
  assert.equal(r.counts.linked, 0, JSON.stringify(r))
  assert.equal(r.complete, false, 'not complete: tried again at the next start')
  assert.ok(s.logs.some((l) => l === '[backfill] code=LEGACY_ROOT_OUTSIDE'), s.logs.join(' | '))
  assert.equal(await readFile(s.savedPng(91)).catch(() => null), null, 'nothing in media-saved')
  assert.equal((await big(outsideFile)).nlink, 1n, 'the outside file got no second name')
  // the junction removed (only the link: the target stays) and the tree moved back: the next start links it
  rmdirSync(legacy)
  assert.ok(lstatSync(outsideFile).isFile(), 'removing the junction left its target alone')
  await fsp.rename(outside, legacy)
  const again = await s.run()
  assert.deepEqual({ linked: again.counts.linked, complete: again.complete }, { linked: 1, complete: true }, JSON.stringify(again))
  assert.ok((await readFile(s.savedPng(91))).equals(bytes))
})

test('X4-10 review-x2b F-6: .teamuq a junction even to a directory inside linejs-downloads (realpath inside) is refused by lstat → nothing linked, code LEGACY_ROOT_LINK, not complete', async (t) => {
  const s = await x4Setup(t, [{ n: 92, bytes: png(31, 21, 10) }])
  const legacy = path.join(s.dataDir, 'linejs-downloads', '.teamuq')
  const inside = path.join(s.dataDir, 'linejs-downloads', 'teamuq-real')
  await fsp.rename(legacy, inside)
  symlinkSync(inside, legacy, 'junction')
  const chatFolder = (await readdir(inside))[0]
  const insideFile = path.join(inside, chatFolder, (await readdir(path.join(inside, chatFolder)))[0])
  const r = await s.run()
  assert.deepEqual({ linked: r.counts.linked, complete: r.complete }, { linked: 0, complete: false }, JSON.stringify(r))
  assert.ok(s.logs.some((l) => l === '[backfill] code=LEGACY_ROOT_LINK'), s.logs.join(' | '))
  assert.equal(await readFile(s.savedPng(92)).catch(() => null), null)
  assert.equal((await big(insideFile)).nlink, 1n)
  rmdirSync(legacy)
})

test('X4-7 a ledger v2 that cannot be loaded (newer version) stops the backfill before anything is linked or cleaned', async (t) => {
  const s = await x4Setup(t, [{ n: 61, bytes: png(20, 20, 61) }], { originals: false })
  await writeFile(path.join(s.dataDir, 'linejs-downloads', MEDIA_LEDGER_NAME), JSON.stringify({ version: 3, items: [] }))
  const service = new OriginalDownloadService({
    dataDir: s.dataDir, session: { outboundSession: async () => null, isCurrentSession: () => false, onSessionChange: () => () => {} },
    localAccountMid: async () => ME, getDb: () => null, limiter: new ObsLimiter(), fetch: async () => { throw new Error('no network') },
  })
  t.after(() => service.dispose())
  const r = await runBackfill({ dataDir: s.dataDir, originals: service })
  assert.equal(r.skipped, 'LEDGER_UNAVAILABLE')
  await assert.rejects(() => fsp.stat(path.join(s.dataDir, SAVED_MEDIA_DIR, `${stemOf(x4Id(61))}.png`)), { code: 'ENOENT' })
  assert.equal(JSON.parse(await readFile(path.join(s.dataDir, 'linejs-downloads', MEDIA_LEDGER_NAME), 'utf8')).version, 3, 'the newer ledger is not written over')
})

test('X4-8 startup reconcile removes orphan parts (old, not referenced by the ledger) — also one that is a second name of a landed file — and keeps referenced or fresh ones', async (t) => {
  const s = await x4Setup(t, [{ n: 71, bytes: png(20, 20, 71) }])
  const dir = path.join(s.dataDir, SAVED_MEDIA_DIR)
  await mkdir(dir, { recursive: true })
  const landedStem = stemOf(x4Id(72))
  const landed = path.join(dir, `${landedStem}.png`)
  await writeFile(landed, png(25, 25, 72))
  const oldOrphan = path.join(dir, partNameFor(stemOf(x4Id(73))))
  await writeFile(oldOrphan, 'half a download')
  const aliasOrphan = path.join(dir, partNameFor(landedStem))
  await fsp.link(landed, aliasOrphan)
  const referencedName = partNameFor(stemOf(x4Id(74)))
  await writeFile(path.join(dir, referencedName), 'resume me')
  assert.equal(await s.originals.ledgerReady(), true)
  s.originals.ledger.begin(X4_OWNER, stemOf(x4Id(74)), { origin: 'history', kind: 'VIDEO' })
  s.originals.ledger.running(X4_OWNER, stemOf(x4Id(74)), { partName: referencedName })
  const fresh = path.join(dir, partNameFor(stemOf(x4Id(75))))
  await writeFile(fresh, 'being written right now')
  const old = new Date(Date.now() - 2 * 24 * 60 * 60_000)
  for (const p of [oldOrphan, aliasOrphan, path.join(dir, referencedName)]) await fsp.utimes(p, old, old)
  const landedBytes = await readFile(landed)
  const r = await s.run()
  assert.equal(r.counts.orphansRemoved, 2)
  await assert.rejects(() => fsp.stat(oldOrphan), { code: 'ENOENT' })
  await assert.rejects(() => fsp.stat(aliasOrphan), { code: 'ENOENT' })
  assert.ok((await readFile(landed)).equals(landedBytes), 'the landed file keeps its bytes (only the extra name went)')
  assert.equal((await big(landed)).nlink, 1n)
  await assert.doesNotReject(() => fsp.stat(path.join(dir, referencedName)), 'a part the ledger still points at is kept')
  await assert.doesNotReject(() => fsp.stat(fresh), 'a fresh part is kept')
})
