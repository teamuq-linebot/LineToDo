// X1 streaming downloader (implementation-plan-v2.md X1, implementation-plan.md §2 / §5.2, history-download.md §5–§6): synthetic E2EE fixtures
// encrypted with the same recipe, a fake OBS (Range, disconnects, statuses, gzip), fake statfs, and the real LINEJS 3.6.4 BaseClient for the
// X-Talk-Meta bytes and the R-07 register guard. Nothing here talks to LINE or reads credentials.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createCipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import v8 from 'node:v8'
import vm from 'node:vm'
import zlib from 'node:zlib'
import { BaseClient, InternalError } from '@evex-dev/linejs/base'
import { n as linejsWriteStruct } from '../../node_modules/@evex-dev/linejs/dist/thrift-Bc80GTa_.mjs'
import thrift from 'thrift'
import { streamDownload, ctrIvAt, sniffPlaintext, DISK_RESERVE_BYTES, SNIFF_BYTES } from '../../src/plugin/backend/linejsMediaStream.ts'
import {
  OBS_CLASSES, OBS_HTTP_CLASS, OBS_RATE_LIMIT_DEFAULT_MS, ObsLimiter, buildObsRequest, classifyObsOutcome, currentLineJsContext, installRegisterGuard,
  locatorProblem, obsTalkMeta, registerBlockedCount, runInLineJsContext, sharedObsLimiter
} from '../../src/plugin/backend/linejsObs.ts'
import { createLineJsMediaFetch, createLineJsSessionFetch, linejsUrlAllowed, LineJsMediaService } from '../../src/plugin/backend/linejsMedia.ts'
import { LineJsOutboundService } from '../../src/plugin/backend/linejsOutbound.ts'
import { deriveFileKeys } from '../../src/main/media/decrypt.ts'

// ── no network in this file: LineJsMediaService installs a session fetch over globalThis.fetch, so any LINEJS call a test forgot to stub
// would otherwise leave the machine. Every test that needs a fetch injects its own fake.
globalThis.fetch = async () => { throw Object.assign(new Error('network disabled in this test'), { code: 'TEST_NO_NETWORK' }) }

// ── injected secrets / identifiers: none may appear in any log line
const TOKEN = 'synthetic-auth-TOKEN-x1-7d1f'
const ME = 'u0123456789abcdef0123456789abcdef'
const FRIEND = 'ufedcba9876543210fedcba9876543210'
const GROUP = 'c11112222333344445555666677778888'
const MSG_ID = '6100000000000007919'
const OID = 'oidSYNTHETIC0123456789abcdefXYZ'
const KIB = 1024
const MIB = 1024 * 1024
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))
const sha = (buf) => createHash('sha256').update(buf).digest('hex')

// ───────────────────────── fixtures ─────────────────────────

/** Same recipe as LINEJS encryptByKeyMaterial / src/main/media/decrypt.ts: HKDF-SHA256(km, "", "FileEncryption", 76) → AES-256-CTR, then HMAC-SHA256(macKey, cipher). */
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
function mp4(n, seed = 3) {
  const b = pattern(n, seed)
  Buffer.from([0, 0, 0, 0x20]).copy(b, 0)
  b.write('ftypisom', 4, 'latin1')
  return b
}
function png(width = 300, height = 200, seed = 7) {
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

/** A LINEJS-shaped client: getHeader('GET') as LINEJS 3.6.4 builds it (Host, gzip, x-line-access). */
function fakeClient() {
  return {
    base: {
      authToken: TOKEN,
      request: {
        systemType: 'ANDROIDSECONDARY\t14.0.0\tAndroid OS\t13',
        getHeader: (method = 'POST') => ({ Host: 'legy.line-apps.com', accept: 'application/x-thrift', 'user-agent': 'Line/14.0.0', 'x-line-application': 'ANDROIDSECONDARY\t14.0.0\tAndroid OS\t13', 'content-type': 'application/x-thrift', 'x-lal': 'ja_JP', 'x-lpv': '1', 'x-lhm': method, 'accept-encoding': 'gzip', 'x-line-access': TOKEN })
      }
    }
  }
}

/**
 * Fake OBS. `objects`: pathname → Buffer. Per-request plan via `opts.plan(index, request)` → { status, headers, cutAfter, endAfter, noLength, gate, ignoreRange, encoding }.
 * Bodies honour the request signal (abort errors the stream); `cutAfter` errors the body after that many bytes of this response.
 */
function obsServer(objects, opts = {}) {
  const requests = []
  let pulled = 0
  const fetch = async (request) => {
    const url = new URL(request.url)
    const index = requests.length
    requests.push({ path: url.pathname, method: request.method, range: request.headers.get('range'), headers: Object.fromEntries(request.headers), signal: request.signal })
    const plan = opts.plan?.(index, request) ?? {}
    if (plan.hang) return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
    if (plan.status) return new Response(plan.body ?? '', { status: plan.status, headers: plan.headers ?? {} })
    const body = objects.get(url.pathname)
    if (!body) return new Response('', { status: 404 })
    const m = /^bytes=(\d+)-$/.exec(request.headers.get('range') ?? '')
    const ranged = m && opts.range !== false && !plan.ignoreRange
    const start = ranged ? Number(m[1]) : 0
    const headers = { 'content-length': String(body.length - start), 'accept-ranges': opts.range === false ? 'none' : 'bytes', ...(plan.encoding ? { 'content-encoding': plan.encoding } : {}) }
    if (ranged) headers['content-range'] = `bytes ${start}-${body.length - 1}/${body.length}`
    if (plan.noLength) delete headers['content-length'] // X1b L-1: a response without content-length (chunked)
    const chunk = opts.chunk ?? 64 * KIB
    let pos = start
    let sent = 0
    const stream = new ReadableStream({
      start(controller) { request.signal.addEventListener('abort', () => { try { controller.error(new DOMException('aborted', 'AbortError')) } catch { /* closed */ } }, { once: true }) },
      async pull(controller) {
        if (request.signal.aborted) return
        if (plan.gate && sent >= (plan.gateAt ?? 0)) { await plan.gate; if (request.signal.aborted) return }
        if (plan.cutAfter !== undefined && sent >= plan.cutAfter) { controller.error(Object.assign(new TypeError('terminated'), { code: 'ECONNRESET' })); return }
        // X1b L-1: `endAfter` closes the body cleanly (no error) after that many bytes — a connection that ended early
        if ((plan.endAfter !== undefined && sent >= plan.endAfter) || pos >= body.length) { controller.close(); return }
        let end = Math.min(body.length, pos + chunk)
        if (plan.cutAfter !== undefined) end = Math.min(end, start + plan.cutAfter)
        if (plan.endAfter !== undefined) end = Math.min(end, start + plan.endAfter)
        controller.enqueue(new Uint8Array(body.subarray(pos, end)))
        sent += end - pos
        pulled += end - pos
        pos = end
      }
    })
    return new Response(stream, { status: ranged ? 206 : 200, headers })
  }
  return { fetch, requests, pulled: () => pulled }
}

/** A temp dir removed after the test — after every LineJsMediaService registered with `own()` has been disposed (node:test runs t.after in registration order). */
async function workdir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'line-todo-x1-stream-'))
  const services = []
  workdir.own = (service) => { services.push(service); return service }
  t.after(async () => { for (const s of services) await s.dispose().catch(() => {}); await rm(dir, { recursive: true, force: true }) })
  await mkdir(path.join(dir, 'media-saved'), { recursive: true })
  return dir
}
/**
 * An EventEmitter-backed LINEJS client shell. `off` records every call and, like a strict emitter, throws on an undefined listener
 * (X1b: LineJsMediaService never calls off('message', undefined) — it checks for a receiver first).
 */
function clientShell(base) {
  const events = new EventEmitter()
  const offCalls = []
  const off = (name, handler) => {
    offCalls.push({ name, handler })
    if (typeof handler !== 'function') throw new TypeError('The "listener" argument must be of type function')
    events.off(name, handler)
  }
  return { events, offCalls, client: { authToken: TOKEN, on: events.on.bind(events), off, listen() {}, base } }
}
async function loggedIn(dir, client) {
  const service = workdir.own(await LineJsMediaService.create(path.join(dir, 'plugin'), { loginWithQR: async (_cb, init) => { await init.storage.set('linejs-auth-token', TOKEN); return client } }))
  await service.startLogin()
  for (let i = 0; i < 100 && (await service.status()).login.status !== 'authenticated'; i++) await tick()
  assert.equal((await service.status()).login.status, 'authenticated')
  return service
}
/** A minimal sink: the part lives in media-saved/.<stem>.part, commit renames it to <stem>.<ext>. */
function sinkFor(dir, stem) {
  const saved = path.join(dir, 'media-saved')
  const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm' }
  const commits = []
  return {
    commits,
    finalPath: (mime) => path.join(saved, `${stem}${ext[mime] ?? '.bin'}`),
    target: {
      partPath: path.join(saved, `.${stem}.part`),
      statfsDir: dir,
      async commit(partPath, info) { commits.push(info); await rename(partPath, path.join(saved, `${stem}${ext[info.mime] ?? '.bin'}`)) }
    }
  }
}
const roomy = async () => ({ bavail: 1e12 / 4096, bsize: 4096 })
const e2eeLocator = (over = {}) => ({ stem: 'stem-e2ee', kind: 'VIDEO', messageId: MSG_ID, chatId: GROUP, transport: 'e2ee', sid: 'emv', oid: OID, keyMaterial: randomBytes(32), origin: 'history', ...over })
const opts = (over = {}) => ({ signal: new AbortController().signal, priority: 'user', limiter: new ObsLimiter(), statfs: roomy, backoffMs: () => 0, ...over })
const listSaved = (dir) => readdir(path.join(dir, 'media-saved'))

// ───────────────────────── IP1 §5.2 X1 cases ─────────────────────────

test('IP1-1 1 GiB virtual E2EE video stream: heap peak stays under 64 MiB, result is byte-identical (sha256), part renamed by commit', async (t) => {
  const dir = await workdir(t)
  const km = randomBytes(32)
  const k = keysOf(km)
  const TOTAL = 1024 * MIB
  const CHUNK = 1 * MIB
  const block = pattern(CHUNK, 11)
  const plainHash = createHash('sha256')
  const enc = createCipheriv('aes-256-ctr', k.encKey, k.nonce)
  const mac = createHmac('sha256', k.macKey)
  let produced = 0
  let heapBase = 0
  let heapPeak = 0
  let abPeak = 0
  const sample = () => { const m = process.memoryUsage(); heapPeak = Math.max(heapPeak, m.heapUsed - heapBase); abPeak = Math.max(abPeak, m.arrayBuffers) }
  const fetch = async (request) => {
    assert.equal(request.headers.get('range'), null)
    let tailSent = false
    const body = new ReadableStream({
      pull(controller) {
        sample()
        if (produced >= TOTAL) {
          if (!tailSent) { tailSent = true; controller.enqueue(new Uint8Array(mac.digest())); return }
          controller.close(); return
        }
        const plain = produced === 0 ? mp4(CHUNK, 5) : block
        plainHash.update(plain)
        const c = enc.update(plain)
        mac.update(c)
        produced += plain.length
        controller.enqueue(new Uint8Array(c.buffer, c.byteOffset, c.length))
      }
    }, { highWaterMark: 0 })
    return new Response(body, { status: 200, headers: { 'content-length': String(TOTAL + 32) } })
  }
  const sink = sinkFor(dir, 'big')
  if (global.gc) global.gc()
  heapBase = process.memoryUsage().heapUsed
  const timer = setInterval(sample, 10)
  let outcome
  try {
    outcome = await streamDownload(e2eeLocator({ keyMaterial: km, declaredBytes: TOTAL }), { client: fakeClient(), sessionId: 's1' }, sink.target, opts({ fetch: createLineJsMediaFetch(fetch), statfs: undefined }))
  } finally { clearInterval(timer) }
  t.diagnostic(`heapUsed peak delta=${(heapPeak / MIB).toFixed(1)} MiB, arrayBuffers peak=${(abPeak / MIB).toFixed(1)} MiB`)
  assert.deepEqual(outcome, { status: 'done', bytes: TOTAL, mime: 'video/mp4' })
  assert.ok(heapPeak < 64 * MIB, `heap peak ${heapPeak} must stay under 64 MiB`)
  const final = sink.finalPath('video/mp4')
  assert.equal((await stat(final)).size, TOTAL)
  const fileHash = createHash('sha256')
  for await (const part of createReadStream(final, { highWaterMark: 4 * MIB })) fileHash.update(part)
  assert.equal(fileHash.digest('hex'), plainHash.digest('hex'))
  assert.deepEqual(await listSaved(dir), ['big.mp4'])
})

test('IP1-2 HMAC mismatch: the part is deleted, retried once from scratch, then failed undecryptable/HMAC_MISMATCH; nothing is left', async (t) => {
  const dir = await workdir(t)
  const km = randomBytes(32)
  const plain = mp4(700 * KIB)
  const object = encrypt(plain, km)
  object[object.length - 1] ^= 0x01 // tampered sign
  const obs = obsServer(new Map([[`/r/talk/emv/${OID}`, object]]))
  const sink = sinkFor(dir, 'tamper')
  const seenParts = []
  const target = { ...sink.target, commit: async () => assert.fail('a tampered object is never committed') }
  const outcome = await streamDownload(e2eeLocator({ keyMaterial: km, declaredBytes: plain.length }), { client: fakeClient(), sessionId: 's1' }, target, opts({
    fetch: createLineJsMediaFetch(async (request) => { seenParts.push((await listSaved(dir)).length); return obs.fetch(request) })
  }))
  assert.deepEqual(outcome, { status: 'failed', class: 'undecryptable', code: 'HMAC_MISMATCH' })
  assert.equal(obs.requests.length, 2, 'one retry from scratch')
  assert.equal(obs.requests[1].range, null, 'the retry does not resume from the deleted part')
  assert.deepEqual(seenParts, [0, 0], 'the part of the first attempt was deleted before the retry')
  assert.deepEqual(await listSaved(dir), [])
})

test('IP1-3 the first 64 KiB are not plaintext → stopped right there (no part, no file): plain transport serving ciphertext, and E2EE with a wrong key', async (t) => {
  const dir = await workdir(t)
  // (a) a non-E2EE image whose body is ciphertext-looking random bytes
  const random = randomBytes(8 * MIB)
  const obsA = obsServer(new Map([[`/r/talk/m/${MSG_ID}`, random]]))
  const a = await streamDownload({ stem: 'plain-cipher', kind: 'IMAGE', messageId: MSG_ID, chatId: FRIEND, transport: 'plain', origin: 'history' }, { client: fakeClient(), sessionId: 's1' }, sinkFor(dir, 'plain-cipher').target, opts({ fetch: createLineJsMediaFetch(obsA.fetch) }))
  assert.deepEqual(a, { status: 'failed', class: 'undecryptable', code: 'CONTENT_NOT_PLAINTEXT' })
  assert.ok(obsA.pulled() < 512 * KIB, `stopped at the sniff window (pulled ${obsA.pulled()} of ${random.length}; stream read-ahead included)`)
  assert.equal(obsA.requests.length, 1, 'never retried')
  // (b) an E2EE video downloaded with the wrong keyMaterial: the sniff stops it long before the HMAC
  const object = encrypt(mp4(8 * MIB), randomBytes(32))
  const obsB = obsServer(new Map([[`/r/talk/emv/${OID}`, object]]))
  const b = await streamDownload(e2eeLocator({ keyMaterial: randomBytes(32) }), { client: fakeClient(), sessionId: 's1' }, sinkFor(dir, 'wrong-key').target, opts({ fetch: createLineJsMediaFetch(obsB.fetch) }))
  assert.deepEqual(b, { status: 'failed', class: 'undecryptable', code: 'CONTENT_NOT_PLAINTEXT' })
  assert.ok(obsB.pulled() < 512 * KIB, `stopped at the sniff window (pulled ${obsB.pulled()} of ${object.length})`)
  assert.deepEqual(await listSaved(dir), [])
  // sniff table
  assert.equal(sniffPlaintext('VIDEO', mp4(64)).mime, 'video/mp4')
  assert.equal(sniffPlaintext('IMAGE', png()).mime, 'image/png')
  assert.equal(sniffPlaintext('IMAGE', Buffer.from([0xff, 0xd8, 0xff, 0xe0])).mime, 'image/jpeg')
  assert.equal(sniffPlaintext('VIDEO', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])).mime, 'video/webm')
  assert.equal(sniffPlaintext('VIDEO', Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypqt  ', 'latin1')])).mime, 'video/quicktime')
  assert.equal(sniffPlaintext('VIDEO', Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1')])).code, 'VIDEO_TYPE_UNSUPPORTED')
  assert.equal(sniffPlaintext('FILE', randomBytes(16)).ok, true)
})

test('IP1-4 resume: a disconnect at an unaligned offset resumes with Range from the 16-byte boundary and the result is byte-identical (E2EE and plain)', async (t) => {
  const dir = await workdir(t)
  // E2EE video
  const km = randomBytes(32)
  const plain = mp4(3 * MIB + 123, 21)
  const obs = obsServer(new Map([[`/r/talk/emv/${OID}`, encrypt(plain, km)]]), { chunk: 100_003, plan: (i) => (i === 0 ? { cutAfter: 1_000_003 } : {}) })
  const sink = sinkFor(dir, 'resume-e2ee')
  const outcome = await streamDownload(e2eeLocator({ keyMaterial: km, declaredBytes: plain.length }), { client: fakeClient(), sessionId: 's1' }, sink.target, opts({ fetch: createLineJsMediaFetch(obs.fetch) }))
  assert.deepEqual(outcome, { status: 'done', bytes: plain.length, mime: 'video/mp4' })
  assert.equal(obs.requests.length, 2)
  assert.equal(obs.requests[0].range, null)
  const n = Number(/^bytes=(\d+)-$/.exec(obs.requests[1].range)[1])
  assert.equal(n % 16, 0, 'resumes on a 16-byte boundary (CTR block)')
  assert.ok(n > 0 && n <= 1_000_003 - 32, `resumes from what was written (${n})`)
  assert.ok(sha(await readFile(sink.finalPath('video/mp4'))) === sha(plain), 'byte-identical after resume')
  // non-E2EE image (no HMAC): Range from the part's size
  const image = png(600, 400, 9)
  const obsP = obsServer(new Map([[`/r/talk/m/${MSG_ID}`, image]]), { chunk: 50_001, plan: (i) => (i === 0 ? { cutAfter: 200_007 } : {}) })
  const sinkP = sinkFor(dir, 'resume-plain')
  const p = await streamDownload({ stem: 'resume-plain', kind: 'IMAGE', messageId: MSG_ID, chatId: FRIEND, transport: 'plain', declaredBytes: image.length, origin: 'receive' }, { client: fakeClient(), sessionId: 's1' }, sinkP.target, opts({ fetch: createLineJsMediaFetch(obsP.fetch) }))
  assert.deepEqual(p, { status: 'done', bytes: image.length, mime: 'image/png' })
  assert.match(obsP.requests[1].range, /^bytes=\d+-$/)
  assert.deepEqual(await readFile(sinkP.finalPath('image/png')), image)
})

test('IP1-4b no Range: a server that answers 200 to the Range retries from scratch (byte-identical); gzip turns resume off; a later call resumes a kept part', async (t) => {
  const dir = await workdir(t)
  const km = randomBytes(32)
  const plain = mp4(2 * MIB + 77, 31)
  const object = encrypt(plain, km)
  // (a) server without Range support
  const obs = obsServer(new Map([[`/r/talk/emv/${OID}`, object]]), { range: false, plan: (i) => (i === 0 ? { cutAfter: 700_000 } : {}) })
  const sink = sinkFor(dir, 'norange')
  const a = await streamDownload(e2eeLocator({ keyMaterial: km, declaredBytes: plain.length }), { client: fakeClient(), sessionId: 's1' }, sink.target, opts({ fetch: createLineJsMediaFetch(obs.fetch) }))
  assert.equal(a.status, 'done')
  assert.equal(obs.requests.length, 2)
  assert.deepEqual(await readFile(sink.finalPath('video/mp4')), plain)
  // (b) a gzip-encoded response cut midway: the next attempt does not send Range at all
  const obsG = obsServer(new Map([[`/r/talk/emv/${OID}`, object]]), { plan: (i) => (i === 0 ? { cutAfter: 700_000, encoding: 'gzip' } : {}) })
  const sinkG = sinkFor(dir, 'gzip')
  const g = await streamDownload(e2eeLocator({ keyMaterial: km, declaredBytes: plain.length }), { client: fakeClient(), sessionId: 's1' }, sinkG.target, opts({ fetch: async (request) => obsG.fetch(request) }))
  assert.equal(g.status, 'done')
  assert.equal(obsG.requests[1].range, null, 'content-encoding disables resume')
  assert.deepEqual(await readFile(sinkG.finalPath('video/mp4')), plain)
  // (c) across calls: the first call is aborted midway (part kept), a second call resumes it with Range
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const obsC = obsServer(new Map([[`/r/talk/emv/${OID}`, object]]), { plan: (i) => (i === 0 ? { gate, gateAt: 512 * KIB } : {}) })
  const sinkC = sinkFor(dir, 'across')
  const controller = new AbortController()
  const first = streamDownload(e2eeLocator({ keyMaterial: km, declaredBytes: plain.length }), { client: fakeClient(), sessionId: 's1' }, sinkC.target, opts({ signal: controller.signal, fetch: createLineJsMediaFetch(obsC.fetch) }))
  for (let i = 0; i < 200 && obsC.pulled() < 512 * KIB; i++) await tick()
  await tick(30)
  controller.abort()
  release()
  assert.deepEqual(await first, { status: 'paused', class: 'transient', code: 'ABORTED' })
  const kept = (await stat(sinkC.target.partPath)).size
  assert.ok(kept > 0, 'the part is kept for resume')
  const second = await streamDownload(e2eeLocator({ keyMaterial: km, declaredBytes: plain.length }), { client: fakeClient(), sessionId: 's1' }, sinkC.target, opts({ fetch: createLineJsMediaFetch(obsC.fetch) }))
  assert.equal(second.status, 'done')
  assert.equal(obsC.requests.length, 2)
  assert.equal(obsC.requests[1].range, `bytes=${kept - (kept % 16)}-`)
  assert.deepEqual(await readFile(sinkC.finalPath('video/mp4')), plain)
})

test('IP1-5 DISK_LOW (2 GiB reserve): paused before any request; paused mid-stream with the part kept; resumes when space is back', async (t) => {
  const dir = await workdir(t)
  assert.equal(DISK_RESERVE_BYTES, 2 * 1024 ** 3)
  const km = randomBytes(32)
  const plain = mp4(3 * MIB, 41)
  const obs = obsServer(new Map([[`/r/talk/emv/${OID}`, encrypt(plain, km)]]))
  const sink = sinkFor(dir, 'disk')
  const low = async () => ({ bavail: (DISK_RESERVE_BYTES + plain.length - 1) / 4096, bsize: 4096 })
  const a = await streamDownload(e2eeLocator({ keyMaterial: km, declaredBytes: plain.length }), { client: fakeClient(), sessionId: 's1' }, sink.target, opts({ fetch: createLineJsMediaFetch(obs.fetch), statfs: low }))
  assert.deepEqual(a, { status: 'paused', class: 'disk_low', code: 'DISK_LOW' })
  assert.equal(obs.requests.length, 0, 'no request while the disk is low')
  // mid-stream: free space drops after 1 MiB
  let calls = 0
  const dropping = async () => (++calls === 1 ? { bavail: 1e12 / 4096, bsize: 4096 } : { bavail: 1, bsize: 4096 })
  const b = await streamDownload(e2eeLocator({ keyMaterial: km, declaredBytes: plain.length }), { client: fakeClient(), sessionId: 's1' }, sink.target, opts({ fetch: createLineJsMediaFetch(obs.fetch), statfs: dropping, diskCheckEveryBytes: 1 * MIB }))
  assert.deepEqual(b, { status: 'paused', class: 'disk_low', code: 'DISK_LOW' })
  const kept = (await stat(sink.target.partPath)).size
  assert.ok(kept >= 1 * MIB && kept < plain.length, `part kept (${kept})`)
  const c = await streamDownload(e2eeLocator({ keyMaterial: km, declaredBytes: plain.length }), { client: fakeClient(), sessionId: 's1' }, sink.target, opts({ fetch: createLineJsMediaFetch(obs.fetch) }))
  assert.equal(c.status, 'done')
  assert.match(obs.requests.at(-1).range, /^bytes=\d+-$/)
  assert.deepEqual(await readFile(sink.finalPath('video/mp4')), plain)
})

test('IP1-6 allowlist: only GET /r/talk/em[ivf]/<oid> is added; POST upload rules, /m/ paths and every other path are unchanged; the media fetch enforces it', async () => {
  for (const sid of ['emi', 'emv', 'emf']) {
    assert.equal(linejsUrlAllowed(`https://obs.line-apps.com/r/talk/${sid}/abc_DEF-123`, 'GET'), true, sid)
    assert.equal(linejsUrlAllowed(`https://obs.line-apps.com/r/talk/${sid}/abc_DEF-123`, 'POST'), false, `${sid} POST is not a download`)
  }
  for (const bad of ['https://obs.line-apps.com/r/talk/ema/abc', 'https://obs.line-apps.com/r/talk/emx/abc', 'https://obs.line-apps.com/r/talk/emi/a/b', 'https://obs.line-apps.com/r/talk/emi/a/../../m/x/y',
    'http://obs.line-apps.com/r/talk/emi/abc', 'https://obs.line-apps.com:444/r/talk/emi/abc', 'https://x@obs.line-apps.com/r/talk/emi/abc', 'https://legy.line-apps.com/r/talk/emi/abc',
    `https://obs.line-apps.com/r/talk/emi/${'a'.repeat(129)}`, `https://obs.line-apps.com/r/talk/emi/reqid-${randomUUID()}`, 'https://obs.line-apps.com/r/talk/emi/', 'https://obs.line-apps.com/r/talk/emi/a.b']) {
    assert.equal(linejsUrlAllowed(bad, 'GET'), false, bad)
  }
  assert.equal(linejsUrlAllowed(`https://obs.line-apps.com/r/talk/emi/${'a'.repeat(128)}`, 'GET'), true)
  // unchanged
  assert.equal(linejsUrlAllowed(`https://obs.line-apps.com/r/talk/emi/reqid-${randomUUID()}`, 'POST'), true)
  assert.equal(linejsUrlAllowed(`https://obs.line-apps.com/r/talk/emv/reqid-${randomUUID()}`, 'POST'), false)
  assert.equal(linejsUrlAllowed('https://obs.line-apps.com/r/talk/m/msg-1'), true)
  // the media fetch refuses before the network and keeps refusing redirects; it has no 25 MiB cap
  let called = 0
  const media = createLineJsMediaFetch(async () => { called++; return new Response('x') })
  await assert.rejects(() => media('https://obs.line-apps.com/r/talk/ema/abc'), { code: 'LINEJS_URL_DENIED' })
  await assert.rejects(() => media('https://obs.line-apps.com/r/talk/emi/abc', { method: 'POST' }), { code: 'LINEJS_URL_DENIED' })
  assert.equal(called, 0)
  await assert.rejects(() => createLineJsMediaFetch(async () => new Response(null, { status: 302, headers: { location: 'https://attacker.example/' } }))('https://obs.line-apps.com/r/talk/emv/abc'), { code: 'LINEJS_REDIRECT_DENIED' })
  const big = await createLineJsMediaFetch(async () => new Response(new Uint8Array(26 * MIB), { headers: { 'content-length': String(26 * MIB) } }))('https://obs.line-apps.com/r/talk/emv/abc')
  assert.equal((await big.arrayBuffer()).byteLength, 26 * MIB, 'no 25 MiB cap on media')
  // a locator outside the whitelist never makes a request
  const obs = obsServer(new Map())
  for (const [locator, code] of [[e2eeLocator({ sid: 'ema' }), 'SID_UNSUPPORTED'], [e2eeLocator({ oid: '../x' }), 'LOCATOR_INVALID'], [e2eeLocator({ oid: `reqid-${randomUUID()}` }), 'LOCATOR_INVALID'],
    [e2eeLocator({ keyMaterial: undefined }), 'KEY_MATERIAL_MISSING'], [e2eeLocator({ chatId: 'tSQUARE0001' }), 'CHAT_UNSUPPORTED'], [e2eeLocator({ messageId: 'd:abc' }), 'LOCATOR_INVALID']]) {
    const out = await streamDownload(locator, { client: fakeClient(), sessionId: 's1' }, { partPath: path.join(os.tmpdir(), `never-${randomUUID()}`), statfsDir: os.tmpdir(), commit: async () => assert.fail() }, opts({ fetch: obs.fetch }))
    assert.equal(out.status, 'failed')
    assert.equal(out.code, code)
  }
  assert.equal(obs.requests.length, 0)
  assert.equal(locatorProblem(e2eeLocator({ keyMaterial: undefined })).class, 'undecryptable')
})

test('IP1-7 log: lines carry only kind / transport / priority / class / code / bytes — never keyMaterial, token, OID, ids, chat or URL', async (t) => {
  const dir = await workdir(t)
  const km = randomBytes(32)
  const plain = mp4(300 * KIB)
  const object = encrypt(plain, km)
  const logs = []
  const log = (line) => logs.push(line)
  const obs = obsServer(new Map([[`/r/talk/emv/${OID}`, object]]), { plan: (i) => (i === 0 ? { cutAfter: 100_000 } : {}) })
  assert.equal((await streamDownload(e2eeLocator({ keyMaterial: km }), { client: fakeClient(), sessionId: 's1' }, sinkFor(dir, 'log').target, opts({ fetch: createLineJsMediaFetch(obs.fetch), log }))).status, 'done')
  const tampered = Buffer.from(object); tampered[10] ^= 1
  const obsT = obsServer(new Map([[`/r/talk/emv/${OID}`, tampered]]))
  await streamDownload(e2eeLocator({ keyMaterial: km }), { client: fakeClient(), sessionId: 's1' }, sinkFor(dir, 'log2').target, opts({ fetch: createLineJsMediaFetch(obsT.fetch), log }))
  const obs404 = obsServer(new Map(), { plan: () => ({ status: 404 }) })
  await streamDownload(e2eeLocator({ keyMaterial: km }), { client: fakeClient(), sessionId: 's1' }, sinkFor(dir, 'log3').target, opts({ fetch: createLineJsMediaFetch(obs404.fetch), log }))
  await streamDownload({ stem: 'p', kind: 'IMAGE', messageId: MSG_ID, chatId: FRIEND, transport: 'plain', origin: 'history' }, { client: fakeClient(), sessionId: 's1' }, sinkFor(dir, 'log4').target, opts({ fetch: createLineJsMediaFetch(obs404.fetch), log }))
  const text = logs.join('\n')
  assert.ok(logs.length >= 6, text)
  assert.match(text, /stream_done kind=VIDEO transport=e2ee priority=user bytes=\d+/)
  assert.match(text, /stream_failed .*class=undecryptable code=HMAC_MISMATCH/)
  assert.match(text, /stream_failed .*class=expired code=OBS_HTTP_404/)
  for (const secret of [km.toString('base64'), km.toString('hex'), km.toString('base64url'), TOKEN, OID, MSG_ID, GROUP, FRIEND, 'obs.line-apps', 'http', 'x-line', 'Talk-Meta']) {
    assert.ok(!text.includes(secret), `log leaks ${secret}`)
  }
})

// ───────────────────────── adapter: X-Talk-Meta and headers vs LINEJS 3.6.4 ─────────────────────────

test('ADAPTER X-Talk-Meta and the GET headers are byte-identical to LINEJS 3.6.4 downloadMediaByE2EE (captured from the real BaseClient); only accept-encoding becomes identity', async (t) => {
  const dir = await workdir(t)
  const memory = new Map()
  const storage = { get: async (k) => memory.get(k), getAll: async () => Object.fromEntries(memory), set: async (k, v) => { memory.set(k, v) }, delete: async (k) => { memory.delete(k) }, clear: async () => memory.clear(), migrate: async () => {} }
  const km = randomBytes(32)
  const plain = mp4(200 * KIB, 8)
  const object = encrypt(plain, km)
  const captured = []
  const base = new BaseClient({ device: 'ANDROIDSECONDARY', storage, fetch: async (request) => { captured.push(request); return new Response(object, { status: 200 }) } })
  base.authToken = TOKEN
  base.profile = { mid: ME }
  base.e2ee.decryptE2EEDataMessage = async () => ({ keyMaterial: km.toString('base64'), fileName: 'clip.mp4' })
  for (const id of [MSG_ID, '1', '9223372036854775807']) {
    captured.length = 0
    const file = await base.obs.downloadMediaByE2EE({ id, to: GROUP, contentMetadata: { OID, SID: 'emv' }, chunks: [Buffer.alloc(16)] })
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), plain, 'LINEJS decrypts the same fixture')
    const linejs = captured[0]
    const ours = buildObsRequest({ base }, e2eeLocator({ messageId: id, keyMaterial: km }))
    assert.equal(ours.url, linejs.url)
    assert.equal(ours.method, 'GET')
    assert.equal(ours.headers.get('x-talk-meta'), linejs.headers.get('x-talk-meta'))
    assert.equal(obsTalkMeta(id), Buffer.from(JSON.stringify({ message: Buffer.from(linejsWriteStruct([[11, 4, id], [15, 27, [12, []]]], thrift.TBinaryProtocol)).toString('base64') })).toString('base64'))
    const strip = (h) => Object.fromEntries([...h].filter(([k]) => k !== 'accept-encoding'))
    assert.deepEqual(strip(ours.headers), strip(linejs.headers), 'every other header is LINEJS getHeader("GET") verbatim')
    assert.equal(linejs.headers.get('accept-encoding'), 'gzip')
    assert.equal(ours.headers.get('accept-encoding'), 'identity')
  }
  // and our downloader gets the same plaintext from the same object
  const obs = obsServer(new Map([[`/r/talk/emv/${OID}`, object]]))
  const sink = sinkFor(dir, 'same')
  assert.equal((await streamDownload(e2eeLocator({ keyMaterial: km }), { client: { base }, sessionId: 's1' }, sink.target, opts({ fetch: createLineJsMediaFetch(obs.fetch) }))).status, 'done')
  assert.deepEqual(await readFile(sink.finalPath('video/mp4')), plain)
  // non-E2EE request: the URL and headers of LINEJS downloadMessageData
  const plainReq = buildObsRequest(fakeClient(), { stem: 'p', kind: 'IMAGE', messageId: MSG_ID, chatId: FRIEND, transport: 'plain', origin: 'history' }, { rangeStart: 4096 })
  assert.equal(plainReq.url, `https://obs.line-apps.com/r/talk/m/${MSG_ID}`)
  assert.deepEqual(Object.fromEntries(plainReq.headers), { accept: 'application/json, text/plain, */*', 'x-line-application': 'ANDROIDSECONDARY\t14.0.0\tAndroid OS\t13', 'x-line-access': TOKEN, 'accept-encoding': 'identity', range: 'bytes=4096-' })
  assert.equal(plainReq.redirect, 'manual')
})

test('ADAPTER deriveFileKeys (moved out of decrypt.ts) equals LINEJS deriveKeyMaterial; CTR IV at an offset decrypts the middle of an object', async () => {
  const base = new BaseClient({ device: 'ANDROIDSECONDARY', fetch: async () => { throw new Error('no network') } })
  for (let i = 0; i < 3; i++) {
    const km = randomBytes(32)
    const ours = deriveFileKeys(km)
    const theirs = await base.e2ee.deriveKeyMaterial(km)
    assert.deepEqual([ours.encKey, ours.macKey, ours.nonce], [theirs.encKey, theirs.macKey, theirs.nonce])
  }
  const km = randomBytes(32)
  const k = keysOf(km)
  const plain = pattern(4096)
  const enc = encrypt(plain, km).subarray(0, -32)
  const iv = ctrIvAt(k.nonce, 1024)
  const d = createCipheriv('aes-256-ctr', k.encKey, iv)
  assert.deepEqual(Buffer.concat([d.update(enc.subarray(1024)), d.final()]), plain.subarray(1024))
  assert.throws(() => ctrIvAt(k.nonce, 10), { code: 'CTR_OFFSET_UNALIGNED' })
  // counter carry across the 32-bit boundary of the nonce's last word
  const carry = ctrIvAt(Buffer.concat([Buffer.alloc(12, 0xab), Buffer.from([0xff, 0xff, 0xff, 0xff])]), 16)
  assert.equal(carry.toString('hex'), `${'ab'.repeat(11)}ac00000000`)
})

test('ADAPTER plain and file kinds: a PNG via /r/talk/m/<id> passes the full container check; a broken image is IMAGE_TYPE_UNSUPPORTED; an E2EE file has no magic bytes; declared size is enforced', async (t) => {
  const dir = await workdir(t)
  const image = png(120, 80, 5)
  const obs = obsServer(new Map([[`/r/talk/m/${MSG_ID}`, image]]))
  const sink = sinkFor(dir, 'png')
  assert.deepEqual(await streamDownload({ stem: 'png', kind: 'IMAGE', messageId: MSG_ID, chatId: FRIEND, transport: 'plain', origin: 'history' }, { client: fakeClient(), sessionId: 's1' }, sink.target, opts({ fetch: createLineJsMediaFetch(obs.fetch) })), { status: 'done', bytes: image.length, mime: 'image/png' })
  assert.deepEqual(sink.commits, [{ mime: 'image/png', bytes: image.length }])
  const broken = Buffer.concat([png(120, 80, 5).subarray(0, 200), Buffer.alloc(100)])
  const obsB = obsServer(new Map([[`/r/talk/m/${MSG_ID}`, broken]]))
  assert.deepEqual(await streamDownload({ stem: 'broken', kind: 'IMAGE', messageId: MSG_ID, chatId: FRIEND, transport: 'plain', origin: 'history' }, { client: fakeClient(), sessionId: 's1' }, sinkFor(dir, 'broken').target, opts({ fetch: createLineJsMediaFetch(obsB.fetch) })), { status: 'failed', class: 'unsupported', code: 'IMAGE_TYPE_UNSUPPORTED' })
  const km = randomBytes(32)
  const bytes = randomBytes(150_001)
  const obsF = obsServer(new Map([[`/r/talk/emf/${OID}`, encrypt(bytes, km)]]))
  const sinkF = sinkFor(dir, 'file')
  assert.deepEqual(await streamDownload(e2eeLocator({ kind: 'FILE', sid: 'emf', keyMaterial: km.toString('base64'), declaredBytes: bytes.length }), { client: fakeClient(), sessionId: 's1' }, sinkF.target, opts({ fetch: createLineJsMediaFetch(obsF.fetch) })), { status: 'done', bytes: bytes.length, mime: 'application/octet-stream' })
  assert.deepEqual(await readFile(sinkF.finalPath('application/octet-stream')), bytes)
  // X1b L-2: E2EE trusts the HMAC — a verified object whose size differs from the declaration is kept (only logged)
  const wrongSize = await streamDownload(e2eeLocator({ kind: 'FILE', sid: 'emf', keyMaterial: km, declaredBytes: bytes.length + 1 }), { client: fakeClient(), sessionId: 's1' }, sinkFor(dir, 'size').target, opts({ fetch: createLineJsMediaFetch(obsF.fetch) }))
  assert.deepEqual(wrongSize, { status: 'done', bytes: bytes.length, mime: 'application/octet-stream' })
  // non-E2EE keeps its rule: the declared size is the only integrity check
  const obsP = obsServer(new Map([[`/r/talk/m/${MSG_ID}`, bytes]]))
  const plainWrong = await streamDownload({ stem: 'psize', kind: 'FILE', messageId: MSG_ID, chatId: FRIEND, transport: 'plain', declaredBytes: bytes.length + 1, origin: 'history' }, { client: fakeClient(), sessionId: 's1' }, sinkFor(dir, 'psize').target, opts({ fetch: createLineJsMediaFetch(obsP.fetch) }))
  assert.deepEqual(plainWrong, { status: 'failed', class: 'undecryptable', code: 'SIZE_MISMATCH' })
  assert.deepEqual((await listSaved(dir)).sort(), ['file.bin', 'png.png', 'size.bin'])
})

// ───────────────────────── classification table ─────────────────────────

test('CLASSIFY 401 / 403 / 404 / 410 / 429 / 5xx / network error / timeout each map to their class; the HTTP table is one constant', async (t) => {
  assert.deepEqual({ ...OBS_HTTP_CLASS }, { 401: 'auth', 403: 'forbidden', 404: 'expired', 410: 'expired', 429: 'rate_limited', '5xx': 'transient', other: 'transient' })
  assert.equal(Object.isFrozen(OBS_HTTP_CLASS), true)
  assert.equal(OBS_CLASSES.length, 8)
  const c = (input) => classifyObsOutcome(input)
  assert.deepEqual(c({ status: 401 }), { class: 'auth', code: 'OBS_HTTP_401' })
  assert.deepEqual(c({ status: 403 }), { class: 'forbidden', code: 'OBS_HTTP_403' })
  assert.deepEqual(c({ status: 404 }), { class: 'expired', code: 'OBS_HTTP_404' })
  assert.deepEqual(c({ status: 410 }), { class: 'expired', code: 'OBS_HTTP_410' })
  assert.deepEqual(c({ status: 429 }), { class: 'rate_limited', code: 'OBS_HTTP_429', retryAfterMs: OBS_RATE_LIMIT_DEFAULT_MS })
  assert.deepEqual(c({ status: 429, headers: new Headers({ 'retry-after': '120' }) }), { class: 'rate_limited', code: 'OBS_HTTP_429', retryAfterMs: 120_000 })
  for (const s of [500, 502, 503, 599]) assert.deepEqual(c({ status: s }), { class: 'transient', code: `OBS_HTTP_${s}` })
  assert.deepEqual(c({ status: 400 }), { class: 'transient', code: 'OBS_HTTP_400' })
  assert.deepEqual(c({ error: Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' }) }), { class: 'transient', code: 'OBS_NETWORK' })
  assert.deepEqual(c({ error: new DOMException('aborted', 'AbortError'), timedOut: true }), { class: 'transient', code: 'OBS_TIMEOUT' })

  // end to end: each status through streamDownload
  const dir = await workdir(t)
  const run = async (plan, extra = {}) => {
    const obs = obsServer(new Map(), { plan })
    const out = await streamDownload(e2eeLocator(), { client: fakeClient(), sessionId: extra.sessionId ?? 's1' }, sinkFor(dir, randomUUID()).target, opts({ fetch: createLineJsMediaFetch(obs.fetch), ...extra }))
    return { out, n: obs.requests.length, obs }
  }
  for (const [status, expected] of [[404, { status: 'failed', class: 'expired', code: 'OBS_HTTP_404' }], [410, { status: 'failed', class: 'expired', code: 'OBS_HTTP_410' }], [403, { status: 'failed', class: 'forbidden', code: 'OBS_HTTP_403' }]]) {
    const { out, n } = await run(() => ({ status }))
    assert.deepEqual(out, expected)
    assert.equal(n, 1, `${status} is not retried`)
  }
  const s503 = await run(() => ({ status: 503 }), { maxAttempts: 3 })
  assert.deepEqual(s503.out, { status: 'failed', class: 'transient', code: 'OBS_HTTP_503' })
  assert.equal(s503.n, 3, 'transient retried up to maxAttempts')
  const net = await run(() => ({}), { fetch: async () => { throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' }) }, maxAttempts: 2 })
  assert.deepEqual(net.out, { status: 'failed', class: 'transient', code: 'OBS_NETWORK' })
  // timeout: the fetch is really aborted
  const hung = obsServer(new Map(), { plan: () => ({ hang: true }) })
  const started = Date.now()
  const to = await streamDownload(e2eeLocator(), { client: fakeClient(), sessionId: 's1' }, sinkFor(dir, 'to').target, opts({ fetch: createLineJsMediaFetch(hung.fetch), headersTimeoutMs: 40, maxAttempts: 2 }))
  assert.deepEqual(to, { status: 'failed', class: 'transient', code: 'OBS_TIMEOUT' })
  assert.equal(hung.requests.length, 2)
  assert.ok(hung.requests.every((r) => r.signal.aborted), 'the timed-out fetch was aborted')
  assert.ok(Date.now() - started < 5_000)
  // idle timeout mid-body also aborts
  let never
  const idleKm = randomBytes(32)
  const idle = obsServer(new Map([[`/r/talk/emv/${OID}`, encrypt(mp4(400 * KIB), idleKm)]]), { plan: () => ({ gate: new Promise((r) => { never = r }), gateAt: 128 * KIB }) })
  const it = await streamDownload(e2eeLocator({ keyMaterial: idleKm }),{ client: fakeClient(), sessionId: 's1' }, sinkFor(dir, 'idle').target, opts({ fetch: createLineJsMediaFetch(idle.fetch), idleTimeoutMs: 40, maxAttempts: 1 }))
  never()
  assert.deepEqual(it, { status: 'failed', class: 'transient', code: 'OBS_TIMEOUT' })
  assert.equal(idle.requests[0].signal.aborted, true)
  // 429 pauses the shared limiter: the next download is paused without a request; 401 pauses the same session only
  const limiter = new ObsLimiter()
  const r429 = await run(() => ({ status: 429, headers: { 'retry-after': '60' } }), { limiter })
  assert.deepEqual(r429.out, { status: 'paused', class: 'rate_limited', code: 'OBS_HTTP_429', retryAfterMs: 60_000 })
  const after429 = await run(() => ({ status: 404 }), { limiter })
  assert.equal(after429.out.status, 'paused')
  assert.equal(after429.out.class, 'rate_limited')
  assert.equal(after429.n, 0, 'nothing is sent while rate limited')
  const authLimiter = new ObsLimiter()
  const r401 = await run(() => ({ status: 401 }), { limiter: authLimiter })
  assert.deepEqual(r401.out, { status: 'paused', class: 'auth', code: 'OBS_HTTP_401' })
  const same = await run(() => ({ status: 404 }), { limiter: authLimiter })
  assert.deepEqual([same.out.class, same.out.code, same.n], ['auth', 'OBS_AUTH_PAUSED', 0])
  const other = await run(() => ({ status: 404 }), { limiter: authLimiter, sessionId: 's2' })
  assert.deepEqual([other.out.class, other.n], ['expired', 1], 'a new session lifts the auth pause')
})

// ───────────────────────── R-07 register guard (real LINEJS 3.6.4 E2EE code) ─────────────────────────

const notFound = () => new InternalError('TalkException', 'not found', { code: 'NOT_FOUND' })

/** The real LINEJS BaseClient on an in-memory storage; group key APIs answer NOT_FOUND, member keys answer our own key (so an unguarded tryRegister goes on to register). */
function realLinejs() {
  const memory = new Map()
  const storage = { get: async (k) => memory.get(k), getAll: async () => Object.fromEntries(memory), set: async (k, v) => { memory.set(k, v) }, delete: async (k) => { memory.delete(k) }, clear: async () => memory.clear(), migrate: async () => {} }
  const base = new BaseClient({ device: 'ANDROIDSECONDARY', storage, fetch: async () => { throw new Error('no network in this test') } })
  base.authToken = TOKEN
  base.profile = { mid: ME }
  const self = { keyId: 7, privKey: randomBytes(32).toString('base64'), pubKey: randomBytes(32).toString('base64') }
  memory.set(`e2eeKeys:${ME}`, JSON.stringify(self))
  memory.set('e2eeKeys:7', JSON.stringify(self))
  const counts = { register: 0, groupKey: 0, lastGroupKey: 0, lastPublicKeys: 0 }
  const talk = base.talk
  talk.getE2EEGroupSharedKey = async () => { counts.groupKey++; throw notFound() }
  talk.getLastE2EEGroupSharedKey = async () => { counts.lastGroupKey++; throw notFound() }
  talk.getLastE2EEPublicKeys = async () => { counts.lastPublicKeys++; return { [ME]: { keyId: 7, keyData: Buffer.alloc(32, 9) } } }
  talk.registerE2EEGroupKey = async () => { counts.register++; return {} }
  // every other key API answers locally too: nothing here may need the network
  talk.getE2EEPublicKeys = async () => { counts.other = (counts.other ?? 0) + 1; return [] }
  talk.negotiateE2EEPublicKey = async () => { counts.other = (counts.other ?? 0) + 1; return { specVersion: 2, publicKey: { keyId: 9, keyData: Buffer.alloc(32, 4) } } }
  const groupMessage = { id: MSG_ID, from: FRIEND, to: GROUP, toType: 2, contentType: 1, contentMetadata: { OID, SID: 'emi', e2eeVersion: '2' }, chunks: [Buffer.alloc(16), Buffer.alloc(16), Buffer.alloc(16), Buffer.from([0, 0, 0, 9]), Buffer.from([0, 0, 0, 3])] }
  return { base, storage, counts, groupMessage }
}
const outcomeOf = (p) => p.then(() => 'went through', (e) => e?.code ?? `other:${e?.message}`)

test('GUARD group key NOT_FOUND: receive / download / no context → registerE2EEGroupKey 0 calls, E2EE_GROUP_KEY_NOT_FOUND; outbound → 1 call; installed by LineJsMediaService.installClient', async (t) => {
  const root = await workdir(t)
  const { base, storage, counts, groupMessage } = realLinejs()
  const { client } = clientShell(base)
  await loggedIn(root, client)
  assert.equal(Object.prototype.hasOwnProperty.call(base.e2ee, 'tryRegisterE2EEGroupKey'), true, 'installClient put the guard on the live client')
  // the login commit points base.storage at the session file; the E2EE self key of this fixture lives in the in-memory storage
  base.storage = storage

  const decrypt = () => outcomeOf(base.e2ee.decryptE2EEDataMessage(groupMessage))
  assert.equal(await runInLineJsContext('receive', decrypt), 'E2EE_GROUP_KEY_NOT_FOUND')
  assert.equal(await runInLineJsContext('download', decrypt, new AbortController().signal), 'E2EE_GROUP_KEY_NOT_FOUND')
  assert.equal(await decrypt(), 'E2EE_GROUP_KEY_NOT_FOUND', 'no context is refused too (fail closed)')
  assert.equal(await runInLineJsContext('receive', () => outcomeOf(base.talk.registerE2EEGroupKey({ keyVersion: 1, chatMid: GROUP, keyIds: [], members: [], encryptedSharedKeys: [] }))), 'E2EE_GROUP_KEY_NOT_FOUND', 'the talk call itself is guarded too')
  assert.equal(counts.register, 0, 'registerE2EEGroupKey never reached the network layer')
  assert.equal(counts.lastPublicKeys, 0, 'tryRegisterE2EEGroupKey was stopped before reading member keys')
  assert.equal(counts.lastGroupKey, 3, 'the NOT_FOUND path was really taken (not vacuous)')
  assert.equal(registerBlockedCount(client), 4)

  await runInLineJsContext('outbound', () => outcomeOf(base.e2ee.getE2EELocalPublicKey(GROUP)))
  assert.equal(counts.register, 1, 'a user-initiated send still registers the missing group key')
  assert.equal(registerBlockedCount(client), 4)
})

/** LineJsOutboundService over the real LINEJS client whose sendMessage, like LINEJS encryptE2EEMessage, looks up the group key (NOT_FOUND → tryRegister). */
async function outboundHarness(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'line-todo-x1-outbound-'))
  const { base, counts } = realLinejs()
  const scheduled = []
  let n = 0
  base.talk.sendMessage = async (options) => {
    await base.e2ee.getE2EELocalPublicKey(options.to).catch(() => {})
    // work LINEJS might leave behind inside the send (a timer that only runs after the send has settled)
    scheduled.push(new Promise((resolve) => setTimeout(() => resolve(outcomeOf(base.e2ee.tryRegisterE2EEGroupKey(options.to))), 40)))
    return { id: `m-${++n}` }
  }
  const client = { base }
  installRegisterGuard(client)
  const session = {
    client, sessionId: randomUUID(),
    async outboundPeek() { return { state: 'ready', sessionId: session.sessionId, ownerMid: ME } },
    async outboundSession() { return { client, sessionId: session.sessionId, ownerMid: ME } },
    currentSessionId() { return session.sessionId },
    isCurrentSession(id, c) { return id === session.sessionId && c === client }
  }
  const service = new LineJsOutboundService({ dataDir, session, localAccountMid: async () => ME, chatKnown: async () => true, imageSniff: () => null })
  await service.init()
  t.after(async () => { await service.dispose(); await service['writeChain']; await rm(dataDir, { recursive: true, force: true }) })
  const send = async (text) => {
    const requestId = randomUUID()
    const sent = await service.send({ requestId, chatId: GROUP, sessionId: session.sessionId, kind: 'text', text })
    assert.ok(!sent.__fail, JSON.stringify(sent))
    for (let i = 0; i < 400; i++) { const view = await service.job({ requestId, chatId: GROUP }); if (view.status !== 'running') return view; await tick() }
    assert.fail('send never settled')
  }
  return { base, counts, client, send, scheduled }
}

test('GUARD (N-4) outbound sends register as usual; work deferred by a timer or a listener inside a receive context never blocks a later user send; outbound permission ends with the send', async (t) => {
  const h = await outboundHarness(t)
  assert.equal((await h.send('first')).status, 'completed')
  assert.equal(h.counts.register, 1, 'outbound send → register goes through')

  const bus = new EventEmitter()
  const views = []
  const contexts = {}
  let finished
  const allDone = new Promise((resolve) => { finished = resolve })
  await runInLineJsContext('receive', async () => {
    // inside the receive context: a direct register is refused ...
    assert.equal(await outcomeOf(h.base.e2ee.tryRegisterE2EEGroupKey(GROUP)), 'E2EE_GROUP_KEY_NOT_FOUND')
    // ... and work deferred from it carries the receive context: a listener registered here, and a timer scheduled here that later emits
    bus.on('user-send', async () => {
      contexts.listener = currentLineJsContext()
      views.push(await h.send('from a listener'))
      finished()
    })
    setTimeout(async () => {
      contexts.timer = currentLineJsContext()
      views.push(await h.send('from a receive timer'))
      contexts.afterSend = currentLineJsContext()
      bus.emit('user-send')
    }, 20)
  })
  await allDone
  assert.equal(contexts.timer.mode, 'receive', 'the timer callback really ran in the (closed) receive context — not vacuous')
  assert.equal(contexts.timer.open, false)
  assert.equal(contexts.afterSend.mode, 'receive')
  assert.equal(contexts.listener.mode, 'receive', 'the listener ran in the receive context too')
  assert.deepEqual(views.map((v) => v.status), ['completed', 'completed'])
  assert.equal(h.counts.register, 3, 'both deferred user sends registered (the receive context did not leak into them)')
  // the timer each send left behind runs after the send settled: the closed outbound context no longer grants register
  const late = await Promise.all(h.scheduled)
  assert.deepEqual(late, ['E2EE_GROUP_KEY_NOT_FOUND', 'E2EE_GROUP_KEY_NOT_FOUND', 'E2EE_GROUP_KEY_NOT_FOUND'])
  assert.equal(h.counts.register, 3)
  assert.equal(registerBlockedCount(h.client), 4)
})

// X2b：v1 的接收下載已停用（'message' 不再下載），原本後半段「each receive download enters its own」沒有下載可驗；改成驗 message 在 outbound
// 情境裡發出時也不會呼叫任何 LINEJS 下載。listen 迴圈仍在自己的 receive 情境（R-07）。
test('GUARD a receiver started from inside an outbound context (restore during a send) still listens in a receive context; a message emitted there starts no LINEJS download (X2b)', async (t) => {
  const root = await workdir(t)
  const seen = { downloads: 0 }
  const { events, client } = clientShell({ profile: { mid: ME }, on() {}, obs: { async downloadMessageData() { seen.downloads++; return new Blob([Buffer.from('%PDF-1.4 x')]) } } })
  client.listen = () => { seen.listen = currentLineJsContext() }
  const service = await loggedIn(root, client)
  await runInLineJsContext('outbound', () => service.setReceiveEnabled(true))
  for (let i = 0; i < 50 && !seen.listen; i++) await tick()
  assert.deepEqual(seen.listen, { mode: 'receive', open: true, aborted: false })
  await runInLineJsContext('outbound', async () => {
    events.emit('message', { isMyMessage: false, to: { type: 'GROUP', id: GROUP }, from: { id: FRIEND }, raw: { id: 'f-1', contentType: 'FILE', hasContent: true, contentMetadata: { FILE_NAME: 'a.pdf' } } })
  })
  await tick(50)
  assert.equal(seen.downloads, 0, 'no LINEJS download from a message')
  assert.equal((await service.status()).downloads.pending, 0)
})

// ───────────────────────── abort and R-05 ─────────────────────────

test('ABORT once the download context is aborted, new LINEJS / OBS calls from it are refused; an in-flight one is aborted; the downloader keeps the part and sends nothing more', async (t) => {
  // the session fetch (client.base.fetch) inside an aborted download context
  const seen = []
  const sessionFetch = createLineJsSessionFetch(async (input, init) => {
    seen.push(init?.signal)
    return new Promise((resolve, reject) => {
      if (init?.signal?.aborted) { reject(new DOMException('aborted', 'AbortError')); return }
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      setTimeout(() => resolve(new Response('ok')), 1_000)
    })
  }, new AbortController().signal)
  const controller = new AbortController()
  await runInLineJsContext('download', async () => {
    const inflight = sessionFetch('https://legy.line-apps.com/api/v4p/rs', { method: 'POST' })
    await tick()
    controller.abort()
    await assert.rejects(inflight, { name: 'AbortError' })
    await assert.rejects(() => sessionFetch('https://legy.line-apps.com/api/v4p/rs', { method: 'POST' }), { code: 'LINEJS_CONTEXT_ABORTED' })
    await assert.rejects(() => sessionFetch('https://obs.line-apps.com/r/talk/emv/abc'), { code: 'LINEJS_CONTEXT_ABORTED' })
  }, controller.signal)
  assert.equal(seen.length, 1, 'the refused calls never reached the network')
  // outside that context the same fetch works (and an outbound context is never refused)
  const okFetch = createLineJsSessionFetch(async () => new Response('ok'), new AbortController().signal)
  assert.equal(await (await okFetch('https://legy.line-apps.com/api/v4p/rs', { method: 'POST' })).text(), 'ok')
  assert.equal(await runInLineJsContext('outbound', async () => (await okFetch('https://legy.line-apps.com/api/v4p/rs', { method: 'POST' })).text()), 'ok')

  // the downloader: abort mid-body → paused ABORTED, request signal aborted, part kept, no more requests
  const dir = await workdir(t)
  const km = randomBytes(32)
  const plain = mp4(2 * MIB)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const obs = obsServer(new Map([[`/r/talk/emv/${OID}`, encrypt(plain, km)]]), { plan: () => ({ gate, gateAt: 512 * KIB }) })
  const sink = sinkFor(dir, 'abort')
  const ac = new AbortController()
  const running = streamDownload(e2eeLocator({ keyMaterial: km }), { client: fakeClient(), sessionId: 's1' }, sink.target, opts({ signal: ac.signal, fetch: createLineJsMediaFetch(obs.fetch) }))
  for (let i = 0; i < 200 && obs.pulled() < 512 * KIB; i++) await tick()
  await tick(30)
  ac.abort()
  assert.deepEqual(await running, { status: 'paused', class: 'transient', code: 'ABORTED' })
  release()
  await tick(50)
  assert.equal(obs.requests.length, 1)
  assert.equal(obs.requests[0].signal.aborted, true, 'the fetch itself was aborted')
  assert.ok((await stat(sink.target.partPath)).size > 0, 'part kept for resume')
  const again = await streamDownload(e2eeLocator({ keyMaterial: km }), { client: fakeClient(), sessionId: 's1' }, sink.target, opts({ signal: ac.signal, fetch: createLineJsMediaFetch(obs.fetch) }))
  assert.deepEqual(again, { status: 'paused', class: 'transient', code: 'ABORTED' })
  assert.equal(obs.requests.length, 1, 'an aborted signal makes no request')
  // a session that changed pauses before any request
  const gone = await streamDownload(e2eeLocator({ keyMaterial: km }), { client: fakeClient(), sessionId: 's1', isCurrent: () => false }, sink.target, opts({ fetch: createLineJsMediaFetch(obs.fetch) }))
  assert.deepEqual(gone, { status: 'paused', class: 'auth', code: 'SESSION_GONE' })
  assert.equal(obs.requests.length, 1)
})

test('R-05 the request signal is merged: a LINEJS AbortSignal.timeout really aborts the session fetch (unit and via the installed client.base.fetch)', async (t) => {
  const hang = (seen) => async (input, init) => {
    seen.push(init?.signal)
    return new Promise((_, reject) => {
      const signal = init?.signal
      if (!signal) return // never settles: the bug R-05 describes
      signal.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')), { once: true })
    })
  }
  const seen = []
  const fetch = createLineJsSessionFetch(hang(seen), new AbortController().signal)
  const t0 = Date.now()
  await assert.rejects(() => fetch('https://legy.line-apps.com/api/v4p/rs', { method: 'POST', signal: AbortSignal.timeout(40) }))
  assert.ok(Date.now() - t0 < 2_000)
  assert.equal(seen[0].aborted, true)
  // the session controller still aborts it as before
  const session = new AbortController()
  const fetch2 = createLineJsSessionFetch(hang([]), session.signal)
  const pending = fetch2('https://legy.line-apps.com/api/v4p/rs', { method: 'POST' })
  session.abort()
  await assert.rejects(pending)
  // via LineJsMediaService: the fetch installClient puts on the live client (LINEJS hands it a Request carrying its timeout signal)
  const root = await workdir(t)
  const original = globalThis.fetch
  const seen3 = []
  globalThis.fetch = hang(seen3) // captured by installClient; still no network (it never answers)
  let client
  try {
    ({ client } = clientShell({ profile: { mid: ME }, on() {} }))
    await loggedIn(root, client)
  } finally { globalThis.fetch = original }
  const t1 = Date.now()
  await assert.rejects(() => client.base.fetch(new Request('https://legy.line-apps.com/api/v4p/rs', { method: 'POST', signal: AbortSignal.timeout(40) })))
  assert.ok(Date.now() - t1 < 2_000, 'the timeout ended the call')
  assert.equal(seen3.at(-1).aborted, true, 'the network call saw the abort')
})

test('R-05/GC an abort still reaches the network call after garbage collection: createLineJsFetch keeps the Request signal chain alive for as long as the Response is held', async () => {
  v8.setFlagsFromString('--expose-gc')
  const forceGc = vm.runInNewContext('gc')
  for (const make of [createLineJsMediaFetch, (base) => createLineJsSessionFetch(base, new AbortController().signal)]) {
    const internals = []
    // like undici's fetch(): it builds its own Request from the one it is given and keeps only that
    const base = async (forwarded, init) => { const internal = new Request(forwarded, init); internals.push(internal); return new Response(new ReadableStream({ pull() { return new Promise(() => {}) } })) }
    const fetch = make(base)
    const held = []
    for (let i = 0; i < 20; i++) {
      const controller = new AbortController()
      const response = await fetch(new Request('https://obs.line-apps.com/r/talk/emv/abc', { signal: controller.signal }))
      held.push({ controller, response })
    }
    for (let i = 0; i < 5; i++) { forceGc(); await tick(10) }
    for (const h of held) h.controller.abort()
    assert.equal(internals.filter((r) => r.signal.aborted).length, 20, 'every abort reached the network-side Request')
  }
})

// ───────────────────────── shared limiter ─────────────────────────

test('LIMIT 3 batch jobs + 1 user job: the user job starts first; batch never holds more than one slot; global concurrency 2', async () => {
  const limiter = new ObsLimiter()
  const r1 = await limiter.acquire('receive')
  const r2 = await limiter.acquire('receive')
  const order = []
  const pending = [
    ...['b1', 'b2', 'b3'].map((name) => limiter.acquire('batch').then((a) => { order.push(name); return a })),
    limiter.acquire('user').then((a) => { order.push('user'); return a })
  ]
  await tick()
  assert.deepEqual(order, [], 'both slots busy')
  r1.release()
  await tick()
  assert.deepEqual(order, ['user'], 'the user job goes first although it was queued last')
  r2.release()
  await tick()
  assert.deepEqual(order, ['user', 'b1'])
  const user = await pending[3]
  const b1 = await pending[0]
  user.release()
  await tick()
  assert.deepEqual(order, ['user', 'b1'], 'a free slot is not given to a second batch job')
  assert.deepEqual(limiter.state().active, { user: 0, receive: 0, batch: 1 })
  const u2 = await limiter.acquire('user')
  assert.deepEqual(limiter.state().active, { user: 1, receive: 0, batch: 1 }, 'a manual download starts at once while batch runs')
  b1.release()
  await tick()
  assert.deepEqual(order, ['user', 'b1', 'b2'])
  u2.release()
  await tick()
  assert.deepEqual(order, ['user', 'b1', 'b2'], 'b3 waits behind b2 (one batch slot)')
  ;(await pending[1]).release()
  await tick()
  assert.deepEqual(order, ['user', 'b1', 'b2', 'b3'])
  ;(await pending[2]).release()
  assert.deepEqual(limiter.started, ['receive', 'receive', 'user', 'batch', 'user', 'batch', 'batch'])
  assert.equal(sharedObsLimiter instanceof ObsLimiter, true)
})

test('LIMIT end to end: with videos and files in a batch (user decision), a single manual download is never starved; priority user > receive > batch', async (t) => {
  const gates = new Map()
  // a failing assertion must not leave gated downloads (open part files, retries) keeping the test process alive: after the test every
  // gate is open, including the ones a retry would create later (registered before workdir, so it runs before the dir is removed)
  let opened = false
  t.after(() => { opened = true; for (const release of gates.values()) release() })
  const dir = await workdir(t)
  const limiter = new ObsLimiter()
  const km = randomBytes(32)
  const object = encrypt(mp4(600 * KIB), km)
  const order = []
  const fetch = createLineJsMediaFetch(async (request) => {
    const name = new URL(request.url).pathname.split('/').at(-1)
    order.push(name)
    const gate = opened ? Promise.resolve() : new Promise((resolve) => gates.set(name, resolve))
    return obsServer(new Map([[new URL(request.url).pathname, object]]), { plan: () => ({ gate, gateAt: 0 }) }).fetch(request)
  })
  const job = (oid, priority, kind = 'VIDEO') => streamDownload(e2eeLocator({ oid, keyMaterial: km, kind, sid: kind === 'FILE' ? 'emf' : 'emv' }), { client: fakeClient(), sessionId: 's1' }, sinkFor(dir, oid).target, opts({ limiter, priority, fetch }))
  const batchA = job('batchVideoA', 'batch')
  const batchB = job('batchFileB', 'batch', 'FILE')
  const batchC = job('batchVideoC', 'batch')
  await tick(20)
  const receive = job('receiveX', 'receive')
  const user = job('userClick', 'user')
  for (let i = 0; i < 100 && order.length < 2; i++) await tick()
  assert.deepEqual(order, ['batchVideoA', 'receiveX'], 'batch holds one slot; the other went to the next waiter (receive was queued before the user)')
  gates.get('receiveX')()
  await receive
  for (let i = 0; i < 100 && order.length < 3; i++) await tick()
  assert.deepEqual(order, ['batchVideoA', 'receiveX', 'userClick'], 'the user download starts before the remaining batch items')
  gates.get('userClick')()
  assert.equal((await user).status, 'done')
  gates.get('batchVideoA')()
  await batchA
  for (let i = 0; i < 100 && order.length < 4; i++) await tick()
  gates.get('batchFileB')()
  await batchB
  for (let i = 0; i < 100 && order.length < 5; i++) await tick()
  gates.get('batchVideoC')()
  await batchC
  assert.deepEqual(order, ['batchVideoA', 'receiveX', 'userClick', 'batchFileB', 'batchVideoC'])
})

test('LIMIT pauses: 429 releases queued waiters as paused and refuses new ones until it expires; an abort while queued leaves the queue', async () => {
  let now = 1_000_000
  const limiter = new ObsLimiter({ now: () => now })
  const a = await limiter.acquire('user')
  const b = await limiter.acquire('receive')
  const queued = limiter.acquire('batch')
  limiter.pauseRateLimited(60_000)
  assert.deepEqual(await queued, { ok: false, outcome: { status: 'paused', class: 'rate_limited', code: 'OBS_PAUSED', retryAfterMs: 60_000 } })
  assert.equal((await limiter.acquire('user')).ok, false)
  now += 60_001
  a.release(); b.release()
  const c = await limiter.acquire('user')
  assert.equal(c.ok, true)
  const d = await limiter.acquire('user')
  const ac = new AbortController()
  const waiting = limiter.acquire('user', { signal: ac.signal })
  ac.abort()
  assert.deepEqual(await waiting, { ok: false, outcome: { status: 'paused', class: 'transient', code: 'ABORTED' } })
  assert.equal(limiter.state().queued, 0)
  c.release(); d.release()
  assert.deepEqual(limiter.state(), { active: { user: 0, receive: 0, batch: 0 }, queued: 0, pausedMs: 0, authPaused: false })
})

// ───────────────────────── X1b (review-x1 L-1, L-2, L-5, L-6, I-7, dispose) ─────────────────────────

/** The size of `file`, or null when it does not exist. */
const sizeOf = (file) => stat(file).then((s) => s.size, () => null)

test('X1b L-1 E2EE without content-length, connection ends early (clean close): transient OBS_TRUNCATED, resumed with Range from the part — never HMAC_MISMATCH', async (t) => {
  const dir = await workdir(t)
  const km = randomBytes(32)
  const plain = mp4(3 * MIB + 123, 51)
  const object = encrypt(plain, km)
  const logs = []
  const obs = obsServer(new Map([[`/r/talk/emv/${OID}`, object]]), { chunk: 100_003, plan: (i) => (i === 0 ? { noLength: true, endAfter: 1_000_003 } : {}) })
  const sink = sinkFor(dir, 'trunc-e2ee')
  const partAtRequest = []
  const fetch = createLineJsMediaFetch(async (request) => { partAtRequest.push(await sizeOf(sink.target.partPath)); return obs.fetch(request) })
  const out = await streamDownload(e2eeLocator({ keyMaterial: km, declaredBytes: plain.length }), { client: fakeClient(), sessionId: 's1' }, sink.target, opts({ fetch, log: (l) => logs.push(l) }))
  assert.deepEqual(out, { status: 'done', bytes: plain.length, mime: 'video/mp4' })
  assert.equal(obs.requests.length, 2)
  assert.equal(obs.requests[0].headers['content-length'], undefined)
  assert.match(String(obs.requests[1].range), /^bytes=\d+-$/, 'the second attempt resumes (the part was not dropped as an HMAC failure)')
  assert.ok(partAtRequest[1] > 0, 'the truncated prefix stayed in the part')
  assert.ok(logs.some((l) => /stream_retry .*code=OBS_TRUNCATED/.test(l)), logs.join('\n'))
  assert.ok(!logs.some((l) => /HMAC_MISMATCH/.test(l)), 'never judged as an HMAC mismatch')
  assert.deepEqual(await readFile(sink.finalPath('video/mp4')), plain)
})

test('X1b L-1 truncated twice without Range support, without content-length: two transient retries from scratch, then done (was: permanent undecryptable/HMAC_MISMATCH)', async (t) => {
  const dir = await workdir(t)
  const km = randomBytes(32)
  const plain = mp4(2 * MIB + 77, 53)
  const obs = obsServer(new Map([[`/r/talk/emv/${OID}`, encrypt(plain, km)]]), { range: false, plan: (i) => (i < 2 ? { noLength: true, endAfter: 700_001 + i * 99_999 } : {}) })
  const sink = sinkFor(dir, 'trunc2')
  const out = await streamDownload(e2eeLocator({ keyMaterial: km, declaredBytes: plain.length }), { client: fakeClient(), sessionId: 's1' }, sink.target, opts({ fetch: createLineJsMediaFetch(obs.fetch) }))
  assert.deepEqual(out, { status: 'done', bytes: plain.length, mime: 'video/mp4' })
  assert.equal(obs.requests.length, 3)
  assert.deepEqual(await readFile(sink.finalPath('video/mp4')), plain)
})

test('X1b L-1 plain transport without content-length, connection ends early: transient, resumed, byte-identical (was: permanent undecryptable/SIZE_MISMATCH)', async (t) => {
  const dir = await workdir(t)
  const image = png(600, 400, 13)
  const obs = obsServer(new Map([[`/r/talk/m/${MSG_ID}`, image]]), { chunk: 50_001, plan: (i) => (i === 0 ? { noLength: true, endAfter: 200_007 } : {}) })
  const sink = sinkFor(dir, 'trunc-plain')
  const out = await streamDownload({ stem: 'trunc-plain', kind: 'IMAGE', messageId: MSG_ID, chatId: FRIEND, transport: 'plain', declaredBytes: image.length, origin: 'receive' }, { client: fakeClient(), sessionId: 's1' }, sink.target, opts({ fetch: createLineJsMediaFetch(obs.fetch) }))
  assert.deepEqual(out, { status: 'done', bytes: image.length, mime: 'image/png' })
  assert.match(String(obs.requests[1].range), /^bytes=\d+-$/)
  assert.deepEqual(await readFile(sink.finalPath('image/png')), image)
})

test('X1b L-1 a connection that ends inside the sniff window (4 plaintext bytes): transient, not CONTENT_NOT_PLAINTEXT', async (t) => {
  const dir = await workdir(t)
  const km = randomBytes(32)
  const plain = mp4(300 * KIB, 55)
  const obs = obsServer(new Map([[`/r/talk/emv/${OID}`, encrypt(plain, km)]]), { plan: (i) => (i === 0 ? { noLength: true, endAfter: 36 } : {}) })
  const sink = sinkFor(dir, 'trunc-head')
  const out = await streamDownload(e2eeLocator({ keyMaterial: km, declaredBytes: plain.length }), { client: fakeClient(), sessionId: 's1' }, sink.target, opts({ fetch: createLineJsMediaFetch(obs.fetch) }))
  assert.deepEqual(out, { status: 'done', bytes: plain.length, mime: 'video/mp4' })
  assert.equal(obs.requests.length, 2)
})

test('X1b L-2 E2EE: HMAC verifies but the size differs from the declaration → kept and only logged (with and without content-length, declared larger or smaller)', async (t) => {
  const dir = await workdir(t)
  const km = randomBytes(32)
  const plain = mp4(400 * KIB + 9, 57)
  const object = encrypt(plain, km)
  const cases = [['with-length-larger', plain.length + 5, {}], ['no-length-larger', plain.length + 5, { noLength: true }], ['no-length-smaller', plain.length - 5, { noLength: true }], ['with-length-smaller', plain.length - 5, {}]]
  for (const [name, declaredBytes, plan] of cases) {
    const logs = []
    const obs = obsServer(new Map([[`/r/talk/emv/${OID}`, object]]), { plan: () => plan })
    const sink = sinkFor(dir, name)
    const out = await streamDownload(e2eeLocator({ keyMaterial: km, declaredBytes }), { client: fakeClient(), sessionId: 's1' }, sink.target, opts({ fetch: createLineJsMediaFetch(obs.fetch), log: (l) => logs.push(l) }))
    assert.deepEqual(out, { status: 'done', bytes: plain.length, mime: 'video/mp4' }, name)
    assert.equal(obs.requests.length, 1, `${name}: one request, no retry`)
    assert.deepEqual(await readFile(sink.finalPath('video/mp4')), plain, name)
    assert.ok(logs.some((l) => l === `stream_note kind=VIDEO transport=e2ee code=SIZE_DECLARED_MISMATCH bytes=${plain.length}`), `${name}: ${logs.join(' | ')}`)
  }
  // a tampered object with a wrong declaration is still refused (the HMAC decides)
  const tampered = Buffer.from(object); tampered[100] ^= 1
  const obsT = obsServer(new Map([[`/r/talk/emv/${OID}`, tampered]]))
  const bad = await streamDownload(e2eeLocator({ keyMaterial: km, declaredBytes: plain.length + 5 }), { client: fakeClient(), sessionId: 's1' }, sinkFor(dir, 'tampered').target, opts({ fetch: createLineJsMediaFetch(obsT.fetch) }))
  assert.deepEqual(bad, { status: 'failed', class: 'undecryptable', code: 'HMAC_MISMATCH' })
  assert.ok(!(await listSaved(dir)).includes('tampered.mp4'))
})

test('X1b L-5 allowlist is case-sensitive: EMI / emV / R/TALK / Obs path variants are denied for GET and POST', async () => {
  for (const bad of ['https://obs.line-apps.com/r/talk/EMI/abc', 'https://obs.line-apps.com/r/talk/emV/abc', 'https://obs.line-apps.com/r/talk/Emf/abc', 'https://obs.line-apps.com/R/talk/emi/abc',
    'https://obs.line-apps.com/r/TALK/emi/abc', 'https://obs.line-apps.com/r/talk/M/msg-1', 'https://obs.line-apps.com/R/TALK/M/msg-1']) {
    assert.equal(linejsUrlAllowed(bad, 'GET'), false, `GET ${bad}`)
    assert.equal(linejsUrlAllowed(bad, 'POST'), false, `POST ${bad}`)
  }
  assert.equal(linejsUrlAllowed(`https://obs.line-apps.com/r/talk/EMI/reqid-${randomUUID()}`, 'POST'), false, 'upload path is case-sensitive too')
  assert.equal(linejsUrlAllowed('https://obs.line-apps.com/r/talk/emi/abc', 'GET'), true, 'control: the lower-case path is allowed')
  let called = 0
  await assert.rejects(() => createLineJsMediaFetch(async () => { called++; return new Response('x') })('https://obs.line-apps.com/r/talk/EMV/abc'), { code: 'LINEJS_URL_DENIED' })
  assert.equal(called, 0)
})

test('X1b L-6 end-of-stream SIZE_MISMATCH (plain, no content-length, more bytes than declared) deletes the part', async (t) => {
  const dir = await workdir(t)
  const bytes = randomBytes(300 * KIB + 3)
  const obs = obsServer(new Map([[`/r/talk/m/${MSG_ID}`, bytes]]), { plan: () => ({ noLength: true }) })
  const sink = sinkFor(dir, 'endsize')
  const target = { ...sink.target, commit: async () => assert.fail('a size mismatch is never committed') }
  const out = await streamDownload({ stem: 'endsize', kind: 'FILE', messageId: MSG_ID, chatId: FRIEND, transport: 'plain', declaredBytes: bytes.length - 7, origin: 'history' }, { client: fakeClient(), sessionId: 's1' }, target, opts({ fetch: createLineJsMediaFetch(obs.fetch) }))
  assert.deepEqual(out, { status: 'failed', class: 'undecryptable', code: 'SIZE_MISMATCH' })
  assert.equal(await sizeOf(sink.target.partPath), null, 'the part is deleted')
  assert.deepEqual(await listSaved(dir), [])
})

test('X1b L-6 a resumed download that ends in a terminal error (403 on the Range request) deletes the part it had resumed', async (t) => {
  const dir = await workdir(t)
  const km = randomBytes(32)
  const plain = mp4(2 * MIB, 59)
  const obs = obsServer(new Map([[`/r/talk/emv/${OID}`, encrypt(plain, km)]]), { plan: (i) => (i === 0 ? { cutAfter: 700_003 } : { status: 403 }) })
  const sink = sinkFor(dir, 'resume-403')
  const partAtRequest = []
  const fetch = createLineJsMediaFetch(async (request) => { partAtRequest.push(await sizeOf(sink.target.partPath)); return obs.fetch(request) })
  const out = await streamDownload(e2eeLocator({ keyMaterial: km, declaredBytes: plain.length }), { client: fakeClient(), sessionId: 's1' }, sink.target, opts({ fetch }))
  assert.deepEqual(out, { status: 'failed', class: 'forbidden', code: 'OBS_HTTP_403' })
  assert.match(String(obs.requests[1].range), /^bytes=\d+-$/, 'the 403 came on a resume')
  assert.ok(partAtRequest[1] > 0, 'a part existed when the terminal answer came')
  assert.equal(await sizeOf(sink.target.partPath), null, 'the terminal error deleted the resumed part')
  assert.deepEqual(await listSaved(dir), [])
})

// X2b：原本驗 v1 接收下載遇到群組金鑰 NOT_FOUND 時一次就失敗（I-7）。v1 接收下載已停用，'message' 不再呼叫 getData，所以改成驗：
// 同樣的群組訊息不會走到 LINEJS 解密（getData 0、getLastE2EEGroupSharedKey 0、register 0）。接收的下載改由 X6（linejsOriginals）處理，
// 它的群組金鑰 NOT_FOUND 判終態由 GUARD 測試（receive / download 情境 register 0 次、E2EE_GROUP_KEY_NOT_FOUND）涵蓋。
test('X1b I-7 / X2b receive: a group message no longer reaches LINEJS decryption from the message handler — getData 0, group-key lookups 0, register 0', async (t) => {
  const root = await workdir(t)
  const { base, storage, counts, groupMessage } = realLinejs()
  const { events, client } = clientShell(base)
  const service = await loggedIn(root, client)
  base.storage = storage
  await service.setReceiveEnabled(true)
  let getData = 0
  events.emit('message', { isMyMessage: false, to: { type: 'GROUP', id: GROUP }, from: { id: FRIEND }, raw: { id: '7001', contentType: 'IMAGE', hasContent: true },
    getData: () => { getData++; return base.e2ee.decryptE2EEDataMessage(groupMessage) } })
  await tick(1_300) // a v1 first retry would have run after 1 s
  const downloads = (await service.status()).downloads
  assert.equal(downloads.failed + downloads.pending + downloads.completed, 0, JSON.stringify(downloads))
  assert.equal(getData, 0, 'the handler never asks LINEJS for the data')
  assert.equal(counts.register, 0)
  assert.equal(counts.lastGroupKey, 0)
})

test('X1b dispose: off("message") is called only with the receiver\'s handler — never with undefined — and the store is closed', async (t) => {
  const root = await workdir(t)
  // never started a receiver
  const a = clientShell({ profile: { mid: ME }, on() {} })
  const idle = await loggedIn(root, a.client)
  await idle.dispose()
  assert.deepEqual(a.offCalls, [], 'no receiver → no off call')
  assert.equal(idle['store'].closed, true, 'dispose reached store.close')
  // with a receiver: removed with its own handler
  const b = clientShell({ profile: { mid: ME }, on() {} })
  const rootB = path.join(root, 'b')
  const active = await loggedIn(rootB, b.client)
  await active.setReceiveEnabled(true)
  assert.equal(b.events.listenerCount('message'), 1)
  await active.dispose()
  assert.equal(b.offCalls.length, 1)
  assert.equal(typeof b.offCalls[0].handler, 'function')
  assert.equal(b.events.listenerCount('message'), 0)
  assert.equal(active['store'].closed, true)
})

// ───────────────────────── review-x2a fix1 F-7 (RX1) ─────────────────────────

test('X2a-fix1 F-7 (RX1) consecutive truncations are capped: a server that ends every response early (with content-length) costs at most 5 attempts, then transient OBS_TRUNCATED', async (t) => {
  const dir = await workdir(t)
  const km = randomBytes(32)
  const plain = mp4(2 * MIB + 33, 57)
  const controller = new AbortController()
  // every response ends cleanly after 100 003 bytes; past 12 requests the test aborts instead of hanging (an uncapped loop would get there)
  const obs = obsServer(new Map([[`/r/talk/emv/${OID}`, encrypt(plain, km)]]), { chunk: 50_001, plan: (i) => { if (i >= 12) controller.abort(); return { endAfter: 100_003 } } })
  const sink = sinkFor(dir, 'trunc-cap')
  const logs = []
  const out = await streamDownload(e2eeLocator({ keyMaterial: km, declaredBytes: plain.length }), { client: fakeClient(), sessionId: 's1' }, sink.target, opts({ signal: controller.signal, fetch: createLineJsMediaFetch(obs.fetch), log: (l) => logs.push(l) }))
  assert.deepEqual(out, { status: 'failed', class: 'transient', code: 'OBS_TRUNCATED' })
  assert.equal(obs.requests.length, 5, 'STREAM_MAX_ATTEMPTS attempts, no more')
  assert.ok(obs.requests.slice(1).every((r) => /^bytes=\d+-$/.test(String(r.range))), 'each retry resumed from the part')
  assert.equal(logs.filter((l) => /stream_retry .*code=OBS_TRUNCATED/.test(l)).length, 4)
  assert.equal(sink.commits.length, 0)
})
