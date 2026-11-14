// Chat outbound send (text / single image / single file): LineJsOutboundService behind the REAL Dispatcher.
// Stub LINEJS client (no network, no real LINE), stub session port, stub local LINE account, temp dataDir. Nothing here talks to LINE.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { LineJsOutboundService } from '../../src/plugin/backend/linejsOutbound.ts'
import { OriginalDownloadService, releaseSharedLedger } from '../../src/plugin/backend/linejsOriginals.ts'
import { LineJsReceiveService } from '../../src/plugin/backend/linejsReceive.ts'
import { ObsLimiter } from '../../src/plugin/backend/linejsObs.ts'
import { SAVED_MEDIA_DIR, createPluginMedia, mediaCacheStem } from '../../src/plugin/backend/media.ts'
import { ledgerOwner } from '../../src/plugin/backend/linejsAutoDownload.mjs'
import { Dispatcher, INTERNAL_API_PATHS, SUPPORTED_API_PATHS } from '../../src/plugin/backend/dispatcher.ts'
import { EventHub } from '../../src/plugin/backend/eventHub.ts'
import { detectSupportedImageMime } from '../../src/plugin/backend/linejsAutoDownload.mjs'
import { createLineJsFetch, linejsUrlAllowed } from '../../src/plugin/backend/linejsMedia.ts'
import { currentLineJsContext, lineJsRegisterAllowed } from '../../src/plugin/backend/linejsObs.ts'
import { BACKEND_METHOD_GROUPS, MAX_REQUEST_BYTES } from '../../src/shared/pluginWire.ts'
import { LINEJS_OUTBOUND_PATHS, OUTBOUND_LIMITS, outboundErrorText, outboundTextError } from '../../src/shared/linejsOutbound.ts'
import { Sha256, sha256Hex } from '../../src/shared/sha256.ts'
import { toWire } from '../../src/renderer/platform/pluginTransport.ts'
import { BACKEND_METHODS } from './lib/manifest.mjs'

const OWNER = 'uOWNERMID0001'
const PEER = 'uPEERMID00001'
const GROUP = 'cGROUPMID0001'
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

function png(width = 40, height = 30, seed = 7) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii')
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0, 0)
    return Buffer.concat([head, data, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let i = 0; i < rows.length; i++) rows[i] = (i * seed + (i >> 7)) & 0xff
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows, { level: 0 })), chunk('IEND', Buffer.alloc(0))])
}

function sessionStub(mid = OWNER) {
  const listeners = new Set()
  const s = {
    client: null, sessionId: null, ownerMid: mid,
    install(client) { s.client = client; s.sessionId = randomUUID(); for (const l of listeners) l(s.sessionId) },
    clear() { s.client = null; s.sessionId = null; for (const l of listeners) l(null) },
    async outboundPeek() { return s.client ? { state: 'ready', sessionId: s.sessionId, ownerMid: s.ownerMid } : { state: 'not_logged_in', sessionId: null, ownerMid: null } },
    async outboundSession() { return s.client ? { client: s.client, sessionId: s.sessionId, ownerMid: s.ownerMid } : null },
    currentSessionId() { return s.sessionId },
    isCurrentSession(id, client) { return s.sessionId !== null && s.sessionId === id && s.client === client },
    onSessionChange(listener) { listeners.add(listener); return () => listeners.delete(listener) }
  }
  return s
}

/** a LINEJS-shaped client; `behave.text` / `behave.media` decide what the SDK call does */
function sdkClient(behave = {}) {
  const calls = []
  let n = 0
  // X1b L-4: the LINEJS call context each SDK call ran in (R-07: only an open outbound context may register a group key)
  const contexts = []
  const seen = (method) => contexts.push({ method, context: currentLineJsContext(), registerAllowed: lineJsRegisterAllowed() })
  const client = {
    calls,
    contexts,
    base: {
      profile: { mid: OWNER },
      talk: { async sendMessage(options) { seen('sendMessage'); calls.push({ method: 'sendMessage', options }); return behave.text ? behave.text(options) : { id: `m-${++n}` } } },
      obs: {
        async uploadMediaByE2EE(options) {
          seen('uploadMediaByE2EE')
          calls.push({ method: 'uploadMediaByE2EE', options, bytes: Buffer.from(await options.data.arrayBuffer()), type: options.data.type })
          return behave.media ? behave.media(options) : { id: `m-${++n}` }
        }
      }
    }
  }
  return client
}

/** stop() of every harness service created in a test (by test context) */
const stoppers = new WeakMap()
const stopServices = async (t) => { for (const stop of stoppers.get(t) ?? []) await stop() }

/**
 * A temp dir removed after the test — only once every harness service of that test has stopped and its last journal write has landed.
 * node:test runs t.after hooks in registration order, so a plain rm hook registered before the harness ran while the service was still
 * writing its journal (settle() persists fire-and-forget): rm then failed with ENOTEMPTY on linejs-outbound (fix3).
 */
async function tempDir(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  // maxRetries: Windows can still report ENOTEMPTY / EBUSY for a moment after the last handle closed (x5 run2 false failure)
  t.after(async () => { await stopServices(t); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })
  return dir
}

async function harness(t, options = {}) {
  const dataDir = options.dataDir ?? await tempDir(t, 'line-todo-outbound-')
  const session = options.session ?? sessionStub()
  const client = options.client ?? sdkClient(options.behave)
  if (options.login !== false) session.install(client)
  const env = { localMid: OWNER, chats: new Set([PEER, GROUP]) }
  const logs = []
  const service = new LineJsOutboundService({
    dataDir, session,
    localAccountMid: async () => env.localMid,
    chatKnown: async (chatId) => env.chats.has(chatId),
    imageSniff: (bytes) => detectSupportedImageMime(bytes),
    log: (line) => logs.push(line),
    ...(options.watchdogMs ? { watchdogMs: options.watchdogMs } : {}),
    ...(options.hooks ? { hooks: options.hooks } : {}),
    ...(options.onSent ? { onSent: options.onSent } : {}),
    ...(options.stageIdleMs !== undefined ? { stageIdleMs: options.stageIdleMs } : {})
  })
  await service.init()
  const hub = new EventHub()
  const dispatcher = new Dispatcher({ getApi: () => ({}), hub, queue: {}, info: () => ({}), linejsOutbound: service })
  let stopping = null
  // stops once; then waits for the journal write chain (never rejects) so no write lands after the test's dirs are removed
  const stop = () => (stopping ??= (async () => { dispatcher.dispose(); hub.dispose(); await service.dispose(); await service['writeChain'] })())
  stoppers.set(t, [...(stoppers.get(t) ?? []), stop])
  t.after(stop)
  const rpc = (p, arg) => dispatcher.call('linejsOutbound', { path: `linejsOutbound.${p}`, args: arg === undefined ? [] : [arg] })
  const ok = async (p, arg) => { const env2 = await rpc(p, arg); assert.equal(env2.ok, true, `${p} → ${JSON.stringify(env2)}`); return env2.value }
  const code = async (p, arg) => { const env2 = await rpc(p, arg); assert.equal(env2.ok, false, `${p} should fail: ${JSON.stringify(env2)}`); return env2.code }
  const sid = () => session.sessionId
  const settled = async (requestId, chatId = PEER) => {
    for (let i = 0; i < 400; i++) { const view = await ok('job', { requestId, chatId }); if (view.status !== 'running') return view; await tick() }
    assert.fail('job never settled')
  }
  /** begin + every chunk; returns the stageId */
  const stage = async (bytes, { kind = 'file', filename = 'report.pdf', mime = 'application/pdf', chatId = PEER, requestId = randomUUID(), declaredSha } = {}) => {
    const begun = await ok('begin', { requestId, chatId, sessionId: sid(), kind, filename, mime, size: bytes.length, sha256: declaredSha ?? sha(bytes) })
    assert.equal(begun.chunkBytes, 32768)
    for (let offset = 0; offset < bytes.length; offset += begun.chunkBytes) {
      const part = bytes.subarray(offset, offset + begun.chunkBytes)
      const value = await ok('stageChunk', { stageId: begun.stageId, requestId, sessionId: sid(), offset, data: part.toString('base64'), sha256: sha(part) })
      assert.equal(value.received, offset + part.length)
    }
    return { stageId: begun.stageId, requestId }
  }
  return { dataDir, session, client, service, dispatcher, rpc, ok, code, sid, settled, stage, env, logs }
}

// ───────────── wiring ─────────────

test('wiring: method group is declared once, manifest carries it, all 7 paths are known to the dispatcher and logged verbatim', () => {
  assert.ok(BACKEND_METHOD_GROUPS.includes('linejsOutbound'))
  assert.ok(BACKEND_METHOD_GROUPS.length <= 32)
  assert.deepEqual(BACKEND_METHODS, [...BACKEND_METHOD_GROUPS], 'manifest backendMethods come from the same list')
  assert.equal(LINEJS_OUTBOUND_PATHS.length, 7)
  for (const p of LINEJS_OUTBOUND_PATHS) {
    assert.ok(SUPPORTED_API_PATHS.includes(p), `${p} supported`)
    assert.ok(INTERNAL_API_PATHS.includes(p), `${p} internal switch case`)
  }
})

test('gate: without the service every path answers linejs_outbound_unavailable (lineJsOutbound:false / no LINEJS session service)', async () => {
  const hub = new EventHub()
  const dispatcher = new Dispatcher({ getApi: () => ({}), hub, queue: {}, info: () => ({}) })
  try {
    for (const p of LINEJS_OUTBOUND_PATHS) assert.equal((await dispatcher.call('linejsOutbound', { path: p, args: [{}] })).code, 'linejs_outbound_unavailable', p)
    assert.equal((await dispatcher.call('linejsMedia', { path: 'linejsOutbound.send', args: [{}] })).code, 'method_mismatch')
  } finally { dispatcher.dispose(); hub.dispose() }
})

test('dispatcher validates arguments before the service: exactly one plain object, known fields, types and length caps', async (t) => {
  const h = await harness(t)
  const base = { requestId: randomUUID(), chatId: PEER, sessionId: h.sid(), kind: 'text', text: 'hi' }
  for (const args of [[], [base, base], ['x'], [[base]], [{ ...base, extra: 1 }], [{ ...base, text: 1 }], [{ ...base, text: 'x'.repeat(20_001) }], [{ ...base, chatId: undefined }]]) {
    assert.equal((await h.dispatcher.call('linejsOutbound', { path: 'linejsOutbound.send', args })).code, 'invalid_args', JSON.stringify(args).slice(0, 80))
  }
  assert.equal(await h.code('stageChunk', { stageId: 's', requestId: 'r', sessionId: 's', offset: -1, data: '', sha256: '' }), 'invalid_args')
  assert.equal(await h.code('job', { requestId: base.requestId, chatId: PEER, fence: 'yes' }), 'invalid_args')
  assert.equal(h.client.calls.length, 0)
})

test('shared pure-TS SHA-256 matches node:crypto (renderer hashes chunks and whole files with it)', () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 32768, 70001]) {
    const bytes = Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff))
    assert.equal(sha256Hex(bytes), sha(bytes), `n=${n}`)
    const inc = new Sha256(); for (let o = 0; o < n; o += 997) inc.update(bytes.subarray(o, o + 997))
    assert.equal(inc.digestHex(), sha(bytes))
  }
  assert.equal(sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

// ───────────── text ─────────────

test('text: status → ready; send records running then completed only with a non-empty SDK id; one SDK call with the exact target; nothing sensitive persisted or logged', async (t) => {
  const h = await harness(t)
  const status = await h.ok('status', { chatId: PEER })
  assert.equal(status.session.state, 'ready')
  assert.equal(status.session.sessionId, h.sid())
  assert.deepEqual(status.chat, { running: null, unresolved: [] })
  const requestId = randomUUID()
  const text = '明天 10 點開會 secret-text-123'
  const sent = await h.ok('send', { requestId, chatId: PEER, sessionId: h.sid(), kind: 'text', text })
  assert.equal(sent.requestId, requestId)
  assert.ok(['running', 'completed'].includes(sent.status))
  const done = await h.settled(requestId)
  assert.equal(done.status, 'completed')
  assert.deepEqual(done.result, { messageId: 'm-1' })
  assert.equal(h.client.calls.length, 1)
  assert.deepEqual(h.client.calls[0], { method: 'sendMessage', options: { to: PEER, text, e2ee: true } })
  const journal = await readFile(path.join(h.dataDir, 'linejs-outbound', 'journal.json'), 'utf8')
  for (const secret of [text, PEER, OWNER, 'secret-text']) assert.ok(!journal.includes(secret), `journal leaks ${secret}`)
  assert.ok(journal.includes(requestId))
  for (const secret of [text, PEER, OWNER]) assert.ok(!h.logs.join('\n').includes(secret), `log leaks ${secret}`)
})

test('text: same requestId is idempotent (one SDK call); a different chat with the same requestId is REQUEST_ID_CONFLICT', async (t) => {
  const h = await harness(t)
  const requestId = randomUUID()
  const request = { requestId, chatId: PEER, sessionId: h.sid(), kind: 'text', text: 'once' }
  await h.ok('send', request)
  await h.settled(requestId)
  const again = await h.ok('send', request)
  assert.equal(again.status, 'completed')
  assert.equal(h.client.calls.length, 1)
  assert.equal(await h.code('send', { ...request, chatId: GROUP }), 'REQUEST_ID_CONFLICT')
  assert.equal(await h.code('begin', { requestId, chatId: PEER, sessionId: h.sid(), kind: 'file', filename: 'a', mime: 'text/plain', size: 1, sha256: sha(Buffer.from('a')) }), 'ALREADY_DISPATCHED')
})

test('text limits: blank, control characters, >10,000 code points, >24,576 UTF-8 bytes; the largest allowed text still fits the 60 KiB wire', async (t) => {
  const h = await harness(t)
  const send = (text) => h.code('send', { requestId: randomUUID(), chatId: PEER, sessionId: h.sid(), kind: 'text', text })
  assert.equal(await send('   \n\t '), 'INVALID_TEXT')
  assert.equal(await send('a\u0000b'), 'INVALID_TEXT')
  assert.equal(await send('a\rb'), 'INVALID_TEXT')
  assert.equal(await send('字'.repeat(8193)), 'TEXT_TOO_LONG') // 24,579 bytes
  assert.equal(outboundTextError('a'.repeat(10_001)), 'TEXT_TOO_LONG')
  assert.equal(outboundTextError('a\nb\tc'), null)
  assert.equal(h.client.calls.length, 0)
  for (const worst of ['"'.repeat(10_000), '\\'.repeat(10_000), '\n'.repeat(9_999) + 'a', '字'.repeat(8192)]) {
    assert.equal(outboundTextError(worst), null)
    const wire = toWire('linejsOutbound.send', [{ requestId: randomUUID(), chatId: 'u' + 'x'.repeat(127), sessionId: randomUUID(), kind: 'text', text: worst }])
    assert.ok(Buffer.byteLength(JSON.stringify(wire)) < MAX_REQUEST_BYTES)
  }
})

// ───────────── attachments ─────────────

test('image: chunked staging (3 chunks) → send → uploadMediaByE2EE gets the exact bytes, sniffed MIME and a normalized name; the stage file is deleted', async (t) => {
  const h = await harness(t)
  const image = png(160, 140)
  assert.ok(image.length > 65536 && image.length < 98304, `fixture is ${image.length} bytes (3 chunks)`)
  assert.equal(detectSupportedImageMime(image), 'image/png')
  const { stageId, requestId } = await h.stage(image, { kind: 'image', filename: 'C:\\Users\\x\\photo.jpeg', mime: 'image/jpeg', chatId: GROUP })
  await h.ok('send', { requestId, chatId: GROUP, sessionId: h.sid(), kind: 'image', stageId })
  const done = await h.settled(requestId, GROUP)
  assert.equal(done.status, 'completed')
  assert.equal(done.size, image.length)
  const call = h.client.calls[0]
  assert.equal(call.method, 'uploadMediaByE2EE')
  assert.equal(call.options.oType, 'image')
  assert.equal(call.options.to, GROUP)
  assert.equal(call.options.filename, 'photo.png', 'path stripped, extension follows the sniffed type')
  assert.equal(call.type, 'image/png')
  assert.ok(call.bytes.equals(image))
  assert.deepEqual(await readdir(path.join(h.dataDir, 'linejs-outbound', 'staging')), [])
})

test('X1b L-4 media upload and text send run in an open outbound context (R-07: the only context that may register a missing group key)', async (t) => {
  const h = await harness(t)
  const image = png(40, 30)
  const staged = await h.stage(image, { kind: 'image', filename: 'a.png', mime: 'image/png', chatId: GROUP })
  await h.ok('send', { requestId: staged.requestId, chatId: GROUP, sessionId: h.sid(), kind: 'image', stageId: staged.stageId })
  assert.equal((await h.settled(staged.requestId, GROUP)).status, 'completed')
  const bytes = Buffer.from('%PDF-1.4 outbound context')
  const file = await h.stage(bytes, { kind: 'file', filename: 'a.pdf', mime: 'application/pdf', chatId: GROUP })
  await h.ok('send', { requestId: file.requestId, chatId: GROUP, sessionId: h.sid(), kind: 'file', stageId: file.stageId })
  assert.equal((await h.settled(file.requestId, GROUP)).status, 'completed')
  const textId = randomUUID()
  await h.ok('send', { requestId: textId, chatId: GROUP, sessionId: h.sid(), kind: 'text', text: 'hi' })
  assert.equal((await h.settled(textId, GROUP)).status, 'completed')
  const contexts = h.client.contexts
  assert.deepEqual(contexts.map((c) => c.method), ['uploadMediaByE2EE', 'uploadMediaByE2EE', 'sendMessage'])
  for (const seen of contexts) {
    assert.deepEqual(seen.context, { mode: 'outbound', open: true, aborted: false }, `${seen.method} ran in the outbound context`)
    assert.equal(seen.registerAllowed, true, `${seen.method} may register a group key`)
  }
  // control: outside any send the same probe says no
  assert.equal(lineJsRegisterAllowed(), false)
})

test('file: arbitrary bytes with an unsafe name → safe name, declared MIME only sanitized; duplicate last chunk is idempotent', async (t) => {
  const h = await harness(t)
  const bytes = Buffer.from(Array.from({ length: 40_000 }, (_, i) => (i * 13) & 0xff))
  const requestId = randomUUID()
  const begun = await h.ok('begin', { requestId, chatId: PEER, sessionId: h.sid(), kind: 'file', filename: '../ev<i>l:name?.pdf. ', mime: 'APPLICATION/PDF', size: bytes.length, sha256: sha(bytes) })
  const first = bytes.subarray(0, 32768)
  const chunk = { stageId: begun.stageId, requestId, sessionId: h.sid(), offset: 0, data: first.toString('base64'), sha256: sha(first) }
  await h.ok('stageChunk', chunk)
  assert.equal((await h.ok('stageChunk', chunk)).received, 32768, 'the same chunk again (lost response) is accepted once')
  const second = bytes.subarray(32768)
  await h.ok('stageChunk', { ...chunk, offset: 32768, data: second.toString('base64'), sha256: sha(second) })
  await h.ok('send', { requestId, chatId: PEER, sessionId: h.sid(), kind: 'file', stageId: begun.stageId })
  assert.equal((await h.settled(requestId)).status, 'completed')
  const call = h.client.calls[0]
  assert.equal(call.options.oType, 'file')
  assert.equal(call.options.filename, 'ev_i_l_name_.pdf')
  assert.equal(call.type, 'application/pdf')
  assert.ok(call.bytes.equals(bytes))
})

test('attachment checks: empty, >25 MiB, non-image / truncated image, out-of-order, bad chunk hash, non-canonical base64, whole-file mismatch, incomplete, one stage per session, discard', async (t) => {
  const h = await harness(t)
  const begin = (extra) => h.rpc('begin', { requestId: randomUUID(), chatId: PEER, sessionId: h.sid(), kind: 'file', filename: 'a.bin', mime: 'application/octet-stream', size: 10, sha256: sha(Buffer.alloc(10)), ...extra })
  assert.equal((await begin({ size: 0 })).code, 'EMPTY_FILE')
  assert.equal((await begin({ size: OUTBOUND_LIMITS.attachmentMaxBytes + 1 })).code, 'ATTACHMENT_TOO_LARGE')
  assert.equal((await begin({ kind: 'image', mime: 'image/bmp' })).code, 'INVALID_IMAGE_TYPE')

  // a "photo" that is not an image, and a truncated PNG: rejected by sniffing at send, never reach the SDK
  for (const bytes of [Buffer.from('this is not an image at all'), png().subarray(0, 60)]) {
    const { stageId, requestId } = await h.stage(bytes, { kind: 'image', filename: 'x.png', mime: 'image/png' })
    assert.equal(await h.code('send', { requestId, chatId: PEER, sessionId: h.sid(), kind: 'image', stageId }), 'INVALID_IMAGE_TYPE')
  }

  const bytes = Buffer.from(Array.from({ length: 70_000 }, (_, i) => i & 0xff))
  const requestId = randomUUID()
  const begun = await h.ok('begin', { requestId, chatId: PEER, sessionId: h.sid(), kind: 'file', filename: 'b.bin', mime: 'application/octet-stream', size: bytes.length, sha256: sha(bytes) })
  assert.equal((await begin({})).code, 'STAGE_BUSY', 'one stage per session')
  const part = (offset) => { const p = bytes.subarray(offset, offset + 32768); return { stageId: begun.stageId, requestId, sessionId: h.sid(), offset, data: p.toString('base64'), sha256: sha(p) } }
  assert.equal(await h.code('stageChunk', part(32768)), 'STAGE_OFFSET_MISMATCH')
  assert.equal(await h.code('stageChunk', { ...part(0), sha256: sha(Buffer.from('other')) }), 'STAGE_CHUNK_INVALID')
  // 32,768 bytes end in one padding char; the char before it carries 2 zero bits — setting one gives a string that decodes to the same bytes
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const canonical = part(0).data
  assert.ok(canonical.endsWith('=') && !canonical.endsWith('=='))
  const nonCanonical = canonical.slice(0, -2) + alphabet[alphabet.indexOf(canonical.at(-2)) | 1] + '='
  assert.ok(Buffer.from(nonCanonical, 'base64').equals(Buffer.from(canonical, 'base64')) && nonCanonical !== canonical)
  assert.equal(await h.code('stageChunk', { ...part(0), data: nonCanonical }), 'STAGE_CHUNK_INVALID')
  assert.equal(await h.code('stageChunk', { ...part(0), data: 'not base64!' }), 'STAGE_CHUNK_INVALID')
  await h.ok('stageChunk', part(0))
  assert.equal(await h.code('send', { requestId, chatId: PEER, sessionId: h.sid(), kind: 'file', stageId: begun.stageId }), 'STAGE_INCOMPLETE')
  assert.deepEqual(await h.ok('discard', { stageId: begun.stageId, requestId }), { discarded: true })
  assert.equal(await h.code('stageChunk', part(32768)), 'STAGE_EXPIRED')

  const lie = await h.stage(bytes, { declaredSha: sha(Buffer.from('different file')) })
  assert.equal(await h.code('send', { requestId: lie.requestId, chatId: PEER, sessionId: h.sid(), kind: 'file', stageId: lie.stageId }), 'STAGE_INTEGRITY_MISMATCH')
  assert.equal(h.client.calls.length, 0)
  assert.deepEqual(await readdir(path.join(h.dataDir, 'linejs-outbound', 'staging')), [])
})

// ───────────── target ─────────────

test('target: malformed chat, room/Square, chat not in the app DB, LINEJS account ≠ local LINE account, local account unreadable — all rejected before any SDK call', async (t) => {
  const h = await harness(t)
  const send = (chatId) => h.rpc('send', { requestId: randomUUID(), chatId, sessionId: h.sid(), kind: 'text', text: 'x' })
  assert.equal((await send('xNOTAMID')).code, 'INVALID_CHAT')
  assert.equal((await send('u')).code, 'INVALID_CHAT')
  assert.equal((await send('rROOM0001')).code, 'CHAT_UNSUPPORTED')
  assert.equal((await send('tSQUARE001')).code, 'CHAT_UNSUPPORTED')
  assert.equal((await send('uUNKNOWNCHAT1')).code, 'CHAT_NOT_FOUND')
  h.env.localMid = 'uSOMEONEELSE1'
  assert.equal((await send(PEER)).code, 'ACCOUNT_MISMATCH')
  assert.equal((await h.ok('status', { chatId: PEER })).session.state, 'account_mismatch')
  assert.equal((await h.ok('status', { chatId: PEER })).session.sessionId, null)
  h.env.localMid = null
  assert.equal((await send(PEER)).code, 'ACCOUNT_UNVERIFIED')
  assert.equal((await h.ok('status', {})).session.state, 'account_unverified')
  assert.equal(h.client.calls.length, 0)
})

// ───────────── result classification ─────────────

test('classification: only a non-empty string id is success; server rejection / closed client / denied URL / rejected upload are failed; everything else is unknown; never retried', async (t) => {
  const requestError = Object.assign(new Error(`Request internal failed, sendMessage(/S3) -> {"code":"NOT_A_MEMBER","reason":"${PEER} secret"}`), { name: 'RequestError', type: 'RequestError', data: { code: 'NOT_A_MEMBER', reason: `${PEER} secret` } })
  const cases = [
    [() => ({ id: '' }), 'unknown', 'SDK_RESULT_INVALID'],
    [() => ({}), 'unknown', 'SDK_RESULT_INVALID'],
    [() => ({ id: 12345 }), 'unknown', 'SDK_RESULT_INVALID'],
    [() => undefined, 'unknown', 'SDK_RESULT_INVALID'],
    [() => { throw requestError }, 'failed', 'SDK_SEND_REJECTED'],
    [() => { throw Object.assign(new Error('Request aborted: client has been disabled (logged out)'), { name: 'ClientClosed', type: 'ClientClosed' }) }, 'failed', 'CLIENT_CLOSED'],
    [() => { throw Object.assign(new Error('x'), { code: 'LINEJS_URL_DENIED' }) }, 'failed', 'LINEJS_URL_DENIED'],
    [() => { throw Object.assign(new Error('x'), { code: 'OBS_UPLOAD_REJECTED' }) }, 'failed', 'OBS_UPLOAD_REJECTED'],
    [() => { throw new TypeError('fetch failed') }, 'unknown', 'SEND_RESULT_UNKNOWN'],
    [() => { throw new DOMException('The operation was aborted', 'AbortError') }, 'unknown', 'SEND_RESULT_UNKNOWN'],
    [() => { throw new DOMException('timed out', 'TimeoutError') }, 'unknown', 'SEND_RESULT_UNKNOWN'],
    [() => { throw Object.assign(new Error('redirect'), { code: 'LINEJS_REDIRECT_DENIED' }) }, 'unknown', 'SEND_RESULT_UNKNOWN'],
    [() => { throw new Error('Request internal failed: status=502 headers=[] body=<>') }, 'unknown', 'SEND_RESULT_UNKNOWN']
  ]
  for (const [behaviour, status, errorCode] of cases) {
    const h = await harness(t, { behave: { text: behaviour } })
    const requestId = randomUUID()
    await h.ok('send', { requestId, chatId: PEER, sessionId: h.sid(), kind: 'text', text: 'classify me' })
    const view = await h.settled(requestId)
    assert.equal(view.status, status, errorCode)
    assert.equal(view.error.code, errorCode)
    assert.equal(view.result, undefined)
    assert.equal(h.client.calls.length, 1, 'never retried automatically')
    const text = JSON.stringify(view)
    for (const leak of [PEER, 'secret', 'Request internal', 'classify me']) assert.ok(!text.includes(leak), `job view leaks ${leak}`)
    if (errorCode === 'SDK_SEND_REJECTED') assert.equal(view.error.detail, 'NOT_A_MEMBER')
  }
})

test('unknown locks the chat (send and begin), status lists it, other chats still work; "我已確認" (acknowledge) unlocks', async (t) => {
  let fail = true
  const h = await harness(t, { behave: { text: () => { if (fail) throw new TypeError('network'); return { id: 'm-ok' } } } })
  const requestId = randomUUID()
  await h.ok('send', { requestId, chatId: PEER, sessionId: h.sid(), kind: 'text', text: 'maybe' })
  assert.equal((await h.settled(requestId)).status, 'unknown')
  fail = false
  assert.equal(await h.code('send', { requestId: randomUUID(), chatId: PEER, sessionId: h.sid(), kind: 'text', text: 'again' }), 'CHAT_UNRESOLVED_UNKNOWN')
  assert.equal(await h.code('begin', { requestId: randomUUID(), chatId: PEER, sessionId: h.sid(), kind: 'file', filename: 'a', mime: 'text/plain', size: 1, sha256: sha(Buffer.from('a')) }), 'CHAT_UNRESOLVED_UNKNOWN')
  const status = await h.ok('status', { chatId: PEER })
  assert.deepEqual(status.chat.unresolved.map((job) => job.requestId), [requestId])
  const other = randomUUID()
  await h.ok('send', { requestId: other, chatId: GROUP, sessionId: h.sid(), kind: 'text', text: 'group ok' })
  assert.equal((await h.settled(other, GROUP)).status, 'completed')
  assert.equal(await h.code('acknowledge', { requestId, chatId: GROUP }), 'REQUEST_ID_CONFLICT', 'only from the same chat')
  assert.equal((await h.ok('acknowledge', { requestId, chatId: PEER })).status, 'acknowledged')
  const next = randomUUID()
  await h.ok('send', { requestId: next, chatId: PEER, sessionId: h.sid(), kind: 'text', text: 'now ok' })
  assert.equal((await h.settled(next)).status, 'completed')
  assert.equal(h.client.calls.length, 3, 'the unknown send was never re-sent')
})

test('one running send at a time (OUTBOUND_BUSY)', async (t) => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const h = await harness(t, { behave: { text: async () => { await gate; return { id: 'slow' } } } })
  const first = randomUUID()
  await h.ok('send', { requestId: first, chatId: PEER, sessionId: h.sid(), kind: 'text', text: 'slow' })
  await tick(10)
  assert.equal((await h.ok('status', { chatId: PEER })).chat.running.requestId, first)
  assert.equal(await h.code('send', { requestId: randomUUID(), chatId: GROUP, sessionId: h.sid(), kind: 'text', text: 'second' }), 'OUTBOUND_BUSY')
  release()
  assert.equal((await h.settled(first)).status, 'completed')
})

// ───────────── session fencing ─────────────

test('session fencing: wrong sessionId, logged out, session change between chunks (stage dropped) and right before the SDK call (failed, SDK not called)', async (t) => {
  const changed = { at: null }
  const h = await harness(t, { hooks: { afterRunningJournal: () => { if (changed.at === 'sdk') h.session.install(sdkClient()) } } })
  assert.equal(await h.code('send', { requestId: randomUUID(), chatId: PEER, sessionId: randomUUID(), kind: 'text', text: 'x' }), 'SESSION_CHANGED')

  const bytes = Buffer.alloc(40_000, 7)
  const requestId = randomUUID()
  const begun = await h.ok('begin', { requestId, chatId: PEER, sessionId: h.sid(), kind: 'file', filename: 'a.bin', mime: 'application/octet-stream', size: bytes.length, sha256: sha(bytes) })
  const oldSession = h.sid()
  h.session.install(h.client) // re-login: same account, new session id
  await tick()
  const p = bytes.subarray(0, 32768)
  assert.equal(await h.code('stageChunk', { stageId: begun.stageId, requestId, sessionId: oldSession, offset: 0, data: p.toString('base64'), sha256: sha(p) }), 'SESSION_CHANGED')
  assert.deepEqual(await readdir(path.join(h.dataDir, 'linejs-outbound', 'staging')), [], 'the old session staging is gone')

  changed.at = 'sdk'
  const fenced = randomUUID()
  const firstClient = h.client
  await h.ok('send', { requestId: fenced, chatId: PEER, sessionId: h.sid(), kind: 'text', text: 'fenced' })
  const view = await h.settled(fenced)
  assert.equal(view.status, 'failed')
  assert.deepEqual(view.error, { code: 'SESSION_CHANGED', phase: 'session_guard' })
  assert.equal(firstClient.calls.length, 0, 'the SDK was never called')

  h.session.clear()
  assert.equal(await h.code('send', { requestId: randomUUID(), chatId: PEER, sessionId: oldSession, kind: 'text', text: 'x' }), 'SESSION_NOT_READY')
  assert.equal((await h.ok('status', { chatId: PEER })).session.state, 'not_logged_in')
})

// ───────────── restart, watchdog, fence ─────────────

test('restart: a running record becomes unknown (SEND_INTERRUPTED), left-over staging files are removed', async (t) => {
  const dataDir = await tempDir(t, 'line-todo-outbound-restart-')
  let release
  const h1 = await harness(t, { dataDir, behave: { text: () => new Promise((resolve) => { release = resolve }) } })
  const requestId = randomUUID()
  await h1.ok('send', { requestId, chatId: PEER, sessionId: h1.sid(), kind: 'text', text: 'in flight' })
  await tick(10)
  const leftover = path.join(dataDir, 'linejs-outbound', 'staging', `${randomUUID()}.part`)
  await writeFile(leftover, 'stale')
  await h1.service.dispose() // process goes away while the SDK call is running

  const h2 = await harness(t, { dataDir })
  const view = await h2.ok('job', { requestId, chatId: PEER })
  assert.equal(view.status, 'unknown')
  assert.deepEqual(view.error, { code: 'SEND_INTERRUPTED', phase: 'restart' })
  assert.deepEqual(await readdir(path.join(dataDir, 'linejs-outbound', 'staging')), [])
  assert.equal(await h2.code('send', { requestId: randomUUID(), chatId: PEER, sessionId: h2.sid(), kind: 'text', text: 'blocked' }), 'CHAT_UNRESOLVED_UNKNOWN')
  release?.({ id: 'late' })
})

test('watchdog: running longer than the limit becomes unknown; a later valid id from the same SDK call upgrades it to completed', async (t) => {
  let release
  const h = await harness(t, { watchdogMs: 30, behave: { text: () => new Promise((resolve) => { release = resolve }) } })
  const requestId = randomUUID()
  await h.ok('send', { requestId, chatId: PEER, sessionId: h.sid(), kind: 'text', text: 'slow' })
  const view = await h.settled(requestId)
  assert.equal(view.status, 'unknown')
  assert.deepEqual(view.error, { code: 'SEND_TIMEOUT_UNKNOWN', phase: 'watchdog' })
  release({ id: 'late-id' })
  await tick(20)
  const upgraded = await h.ok('job', { requestId, chatId: PEER })
  assert.equal(upgraded.status, 'completed')
  assert.deepEqual(upgraded.result, { messageId: 'late-id' })
  assert.equal(upgraded.error, undefined)
})

test('fence: job({fence:true}) for an unseen request writes a tombstone; a late send with that requestId is REQUEST_FENCED; a plain job query writes nothing', async (t) => {
  const h = await harness(t)
  const plain = randomUUID()
  assert.equal((await h.ok('job', { requestId: plain, chatId: PEER })).status, 'not_received')
  await h.ok('send', { requestId: plain, chatId: PEER, sessionId: h.sid(), kind: 'text', text: 'still allowed' })
  assert.equal((await h.settled(plain)).status, 'completed')

  const lost = randomUUID()
  assert.equal((await h.ok('job', { requestId: lost, chatId: PEER, fence: true })).status, 'not_received')
  assert.equal(await h.code('send', { requestId: lost, chatId: PEER, sessionId: h.sid(), kind: 'text', text: 'late' }), 'REQUEST_FENCED')
  assert.equal(h.client.calls.length, 1)
  const journal = JSON.parse(await readFile(path.join(h.dataDir, 'linejs-outbound', 'journal.json'), 'utf8'))
  assert.ok(journal.records.some((r) => r.requestId === lost && r.status === 'not_received'), 'the tombstone survives a restart')
})

test('journal: unwritable → JOURNAL_IO before any SDK call; unreadable journal is kept and sends stay off (fail-closed); full of unresolved → JOURNAL_FULL', async (t) => {
  const h = await harness(t)
  const journal = path.join(h.dataDir, 'linejs-outbound', 'journal.json')
  await rm(journal, { force: true })
  await mkdir(journal) // not a regular file any more
  assert.equal(await h.code('send', { requestId: randomUUID(), chatId: PEER, sessionId: h.sid(), kind: 'text', text: 'x' }), 'JOURNAL_IO')
  assert.equal(h.client.calls.length, 0)

  const corruptDir = await tempDir(t, 'line-todo-outbound-corrupt-')
  await mkdir(path.join(corruptDir, 'linejs-outbound'), { recursive: true })
  await writeFile(path.join(corruptDir, 'linejs-outbound', 'journal.json'), '{"version":1,"records":[{"broken":')
  const c = await harness(t, { dataDir: corruptDir })
  assert.equal(await c.code('send', { requestId: randomUUID(), chatId: PEER, sessionId: c.sid(), kind: 'text', text: 'x' }), 'JOURNAL_IO')
  assert.equal(await readFile(path.join(corruptDir, 'linejs-outbound', 'journal.json'), 'utf8'), '{"version":1,"records":[{"broken":', 'not overwritten')

  const fullDir = await tempDir(t, 'line-todo-outbound-full-')
  await mkdir(path.join(fullDir, 'linejs-outbound'), { recursive: true })
  const records = Array.from({ length: 100 }, (_, i) => ({ requestId: randomUUID(), kind: 'text', ownerKey: '0'.repeat(32), chatKey: i.toString(16).padStart(32, '0'), sessionId: '', status: 'unknown', error: { code: 'SEND_RESULT_UNKNOWN', phase: 'sdk_send' }, createdAt: 1, updatedAt: 1 }))
  await writeFile(path.join(fullDir, 'linejs-outbound', 'journal.json'), JSON.stringify({ version: 1, records }))
  const f = await harness(t, { dataDir: fullDir })
  assert.equal(await f.code('send', { requestId: randomUUID(), chatId: PEER, sessionId: f.sid(), kind: 'text', text: 'x' }), 'JOURNAL_FULL')
})

test('journal: while the journal is not understood, a fence keeps its tombstone in memory only — the original file stays byte-for-byte and sends stay JOURNAL_IO after a restart', async (t) => {
  const dataDir = await tempDir(t, 'line-todo-outbound-broken-fence-')
  const journal = path.join(dataDir, 'linejs-outbound', 'journal.json')
  await mkdir(path.dirname(journal), { recursive: true })
  // a journal this version cannot read (newer version) that holds an unresolved unknown
  const original = Buffer.from(JSON.stringify({ version: 2, records: [{ requestId: randomUUID(), status: 'unknown', chatKey: 'f'.repeat(32) }] }))
  await writeFile(journal, original)
  const h1 = await harness(t, { dataDir })
  assert.equal(await h1.code('send', { requestId: randomUUID(), chatId: PEER, sessionId: h1.sid(), kind: 'text', text: 'x' }), 'JOURNAL_IO')
  const lost = randomUUID()
  assert.equal((await h1.ok('job', { requestId: lost, chatId: PEER, fence: true })).status, 'not_received', 'the fence still answers (tombstone in memory)')
  assert.equal(await h1.code('send', { requestId: lost, chatId: PEER, sessionId: h1.sid(), kind: 'text', text: 'late' }), 'JOURNAL_IO')
  assert.ok((await readFile(journal)).equals(original), 'the unreadable journal is not overwritten by the fence')
  assert.equal(h1.client.calls.length, 0)
  await h1.service.dispose()

  const h2 = await harness(t, { dataDir })
  assert.equal(await h2.code('send', { requestId: randomUUID(), chatId: PEER, sessionId: h2.sid(), kind: 'text', text: 'after restart' }), 'JOURNAL_IO', 'still fail-closed after a restart')
  assert.ok((await readFile(journal)).equals(original), 'still byte-for-byte after the restart')
  assert.equal(h2.client.calls.length, 0)
})

test('errors to the view carry only a fixed code and fixed Chinese text', async (t) => {
  const h = await harness(t)
  const envelope = await h.rpc('send', { requestId: randomUUID(), chatId: 'uUNKNOWNCHAT1', sessionId: h.sid(), kind: 'text', text: 'private words' })
  assert.deepEqual(envelope, { ok: false, code: 'CHAT_NOT_FOUND', message: outboundErrorText('CHAT_NOT_FOUND') })
})

// ───────────── LINEJS fetch: OBS upload allowlist ─────────────

test('OBS upload: POST to /r/talk/em{i,f}/reqid-<uuid> and <oid>__ud-preview is allowed; GET or other paths are not; download paths unchanged', () => {
  const reqid = `reqid-${randomUUID()}`
  assert.equal(linejsUrlAllowed(`https://obs.line-apps.com/r/talk/emi/${reqid}`, 'POST'), true)
  assert.equal(linejsUrlAllowed(`https://obs.line-apps.com/r/talk/emf/${reqid}`, 'POST'), true)
  assert.equal(linejsUrlAllowed('https://obs.line-apps.com/r/talk/emi/abcDEF_123-x__ud-preview', 'POST'), true)
  assert.equal(linejsUrlAllowed(`https://obs.line-apps.com/r/talk/emi/${reqid}`), false, 'GET is not an upload')
  assert.equal(linejsUrlAllowed(`https://obs.line-apps.com/r/talk/emv/${reqid}`, 'POST'), false, 'video is out of scope')
  assert.equal(linejsUrlAllowed('https://obs.line-apps.com/r/talk/emi/reqid-not-a-uuid', 'POST'), false)
  assert.equal(linejsUrlAllowed(`https://obs.line-apps.com/r/talk/emi/${reqid}/../x`, 'POST'), false)
  assert.equal(linejsUrlAllowed(`https://attacker.example/r/talk/emi/${reqid}`, 'POST'), false)
  assert.equal(linejsUrlAllowed('https://obs.line-apps.com/r/talk/m/msg-1'), true)
})

test('OBS upload responses: non-2xx, redirect or missing x-obs-oid → OBS_UPLOAD_REJECTED (before talk.sendMessage); a good upload passes; downloads keep their redirect rule', async () => {
  const url = `https://obs.line-apps.com/r/talk/emi/reqid-${randomUUID()}`
  const post = (response) => createLineJsFetch(async () => response)(url, { method: 'POST', body: new Blob(['enc']) })
  assert.equal((await post(new Response('', { status: 201, headers: { 'x-obs-oid': 'oid-1' } }))).headers.get('x-obs-oid'), 'oid-1')
  await assert.rejects(() => post(new Response('no', { status: 500, headers: { 'x-obs-oid': 'oid-1' } })), { code: 'OBS_UPLOAD_REJECTED' })
  await assert.rejects(() => post(new Response('', { status: 200 })), { code: 'OBS_UPLOAD_REJECTED' })
  await assert.rejects(() => post(new Response(null, { status: 302, headers: { location: 'https://attacker.example/' } })), { code: 'OBS_UPLOAD_REJECTED' })
  await assert.rejects(() => createLineJsFetch(async () => new Response(null, { status: 302, headers: { location: 'https://x.example/' } }))('https://obs.line-apps.com/r/talk/m/known'), { code: 'LINEJS_REDIRECT_DENIED' })
  assert.equal(await (await createLineJsFetch(async () => new Response('ok'))('https://obs.line-apps.com/r/talk/m/known')).text(), 'ok', 'a download without x-obs-oid is fine')
})

// ───────────── X3 outbound write-back (implementation-plan.md §4, §5.2 X3; implementation-plan-v2.md X3) ─────────────
// Real OriginalDownloadService on the same dataDir (shared sink and ledger v2), a node:sqlite app DB for the chat name and for the X2b
// receive check. Ids from the stub SDK are LINE-shaped (digits) unless a test says otherwise.

const X3_ID = (n) => String(9100000000000000000n + BigInt(n))
const x3Stem = (id) => mediaCacheStem(`i:${id}`)

function x3AppDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE chats (chat_id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE messages (msg_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, ts INTEGER NOT NULL, direction TEXT NOT NULL, content_type INTEGER NOT NULL DEFAULT 0,
      ingested_at TEXT NOT NULL, key_material TEXT, orig_filename TEXT, file_size INTEGER, media_oid TEXT, media_sid TEXT, sticker_id TEXT, sticker_package_id TEXT,
      unsent INTEGER NOT NULL DEFAULT 0);`)
  db.prepare('INSERT INTO chats (chat_id, name) VALUES (?, ?)').run(GROUP, 'Outbound Room')
  db.prepare('INSERT INTO chats (chat_id, name) VALUES (?, ?)').run(PEER, 'Peer')
  return db
}

/** outbound harness + the originals service saveOutbound lives in; `onSent` defaults to originals.saveOutbound (as assemble wires it). */
async function x3Harness(t, options = {}) {
  const dataDir = await tempDir(t, 'line-todo-x3-')
  const db = x3AppDb()
  const session = sessionStub()
  const logs = []
  const requests = []
  const originals = new OriginalDownloadService({
    dataDir,
    session: { outboundSession: async () => (session.client ? { client: session.client, sessionId: session.sessionId, ownerMid: OWNER } : null), isCurrentSession: (sid, c) => session.isCurrentSession(sid, c), onSessionChange: (fn) => session.onSessionChange(fn) },
    localAccountMid: async () => OWNER,
    getDb: () => db,
    limiter: new ObsLimiter(),
    fetch: async (request) => { requests.push(new URL(request.url).pathname); return new Response('', { status: 404 }) },
    stream: { statfs: async () => ({ bavail: 1e12 / 4096, bsize: 4096 }), backoffMs: () => 0, maxAttempts: 1 },
    limits: { requestIntervalMs: 0 },
    log: (line) => logs.push(line),
  })
  const saves = []
  const onSent = options.onSent ?? ((sent) => { const p = originals.saveOutbound(sent); saves.push(p); return p })
  // stopServices runs once per temp dir of the test: the cleanup runs once
  let closing = null
  stoppers.set(t, [...(stoppers.get(t) ?? []), () => (closing ??= (async () => { await originals.dispose(); releaseSharedLedger(dataDir); db.close() })())])
  const h = await harness(t, { dataDir, session, onSent, ...options.harness })
  const idle = async () => { await Promise.allSettled(saves); await tick(10) }
  return { ...h, db, originals, saves, idle, originalsLogs: logs, requests }
}

test('X3 image sent → media-saved/<stem>.<ext> holds exactly the sent bytes (sniffed type), M1 serves it, ledger v2 records origin outbound', async (t) => {
  const id = X3_ID(1)
  const h = await x3Harness(t, { harness: { behave: { media: () => ({ id }) } } })
  const image = png(48, 32, 11)
  const { stageId, requestId } = await h.stage(image, { kind: 'image', filename: 'photo.jpeg', mime: 'image/jpeg', chatId: GROUP })
  await h.ok('send', { requestId, chatId: GROUP, sessionId: h.sid(), kind: 'image', stageId })
  assert.equal((await h.settled(requestId, GROUP)).status, 'completed')
  await h.idle()
  const file = path.join(h.dataDir, SAVED_MEDIA_DIR, `${x3Stem(id)}.png`)
  assert.ok((await readFile(file)).equals(image), 'same bytes as sent')
  const media = createPluginMedia({ dataDir: h.dataDir, getDb: () => ({ prepare: () => ({ get: () => ({ content_type: 1, key_material: null, file_size: image.length }) }) }), decryptor: null, index: null })
  assert.equal(media.prepare(`i:${id}`).ok, true)
  const entry = h.originals.ledger.get(ledgerOwner(OWNER), x3Stem(id))
  assert.equal(entry.origin, 'outbound')
  assert.equal(entry.state, 'done')
  assert.equal(h.originals.sink.writes.get(x3Stem(id)), 1)
  assert.equal(h.requests.length, 0, 'never downloaded again')
})

test('X3 file sent → saved-files/<chat>--<hash>/<time>_<name> plus media-saved/<stem>.file.json; M1 savedFile answers it', async (t) => {
  const id = X3_ID(2)
  const h = await x3Harness(t, { harness: { behave: { media: () => ({ id }) } } })
  const bytes = Buffer.from('%PDF-1.4 outbound write-back ' + 'x'.repeat(5000))
  const { stageId, requestId } = await h.stage(bytes, { kind: 'file', filename: 'minutes.pdf', mime: 'application/pdf', chatId: GROUP })
  await h.ok('send', { requestId, chatId: GROUP, sessionId: h.sid(), kind: 'file', stageId })
  assert.equal((await h.settled(requestId, GROUP)).status, 'completed')
  await h.idle()
  const media = createPluginMedia({ dataDir: h.dataDir, getDb: () => ({ prepare: () => ({ get: () => ({ content_type: 14 }) }) }), decryptor: null, index: null })
  const saved = media.savedFile(`i:${id}`)
  assert.equal(saved.ok, true, JSON.stringify(saved))
  assert.ok((await readFile(saved.absPath)).equals(bytes))
  const meta = JSON.parse(await readFile(path.join(h.dataDir, SAVED_MEDIA_DIR, `${x3Stem(id)}.file.json`), 'utf8'))
  assert.match(meta.rel, /^saved-files\/Outbound Room--[0-9a-f]{10}\/\d{8}-\d{6}_minutes\.pdf$/)
  assert.equal(h.originals.ledger.get(ledgerOwner(OWNER), x3Stem(id)).origin, 'outbound')
})

test('X3 a failing write-back never changes the send: sink error (media-saved is a file) and a throwing onSent both leave the send completed; logs carry only codes', async (t) => {
  const id = X3_ID(3)
  const h = await x3Harness(t, { harness: { behave: { media: () => ({ id }) } } })
  await writeFile(path.join(h.dataDir, SAVED_MEDIA_DIR), 'not a directory')
  const image = png(40, 30, 3)
  const staged = await h.stage(image, { kind: 'image', filename: 'a.png', mime: 'image/png', chatId: GROUP })
  await h.ok('send', { requestId: staged.requestId, chatId: GROUP, sessionId: h.sid(), kind: 'image', stageId: staged.stageId })
  assert.equal((await h.settled(staged.requestId, GROUP)).status, 'completed')
  await h.idle()
  assert.ok(h.originalsLogs.some((l) => /^originals_outbound kind=IMAGE code=[A-Za-z0-9_]+$/.test(l)), h.originalsLogs.join('\n'))
  for (const line of [...h.originalsLogs, ...h.logs]) for (const secret of [h.dataDir, GROUP, OWNER, id, 'a.png']) assert.ok(!line.includes(secret), `log leaks: ${line}`)
  // onSent that throws synchronously / rejects
  for (const onSent of [() => { throw Object.assign(new Error('boom /secret/path'), { code: 'EBOOM' }) }, async () => { throw Object.assign(new Error('late /secret/path'), { code: 'ELATE' }) }]) {
    const h2 = await harness(t, { onSent, behave: { media: () => ({ id: X3_ID(4) }) } })
    const s2 = await h2.stage(png(20, 20), { kind: 'image', filename: 'b.png', mime: 'image/png', chatId: PEER })
    await h2.ok('send', { requestId: s2.requestId, chatId: PEER, sessionId: h2.sid(), kind: 'image', stageId: s2.stageId })
    assert.equal((await h2.settled(s2.requestId)).status, 'completed')
    await tick(10)
    assert.ok(h2.logs.some((l) => /saved_failed kind=image code=E(BOOM|LATE)$/.test(l)), h2.logs.join('\n'))
    assert.ok(!h2.logs.join('\n').includes('/secret/path'))
  }
})

test('X3 unknown or failed sends write nothing; a watchdog unknown later upgraded to completed writes once; text and non-LINE ids are never saved', async (t) => {
  const calls = []
  const onSent = (sent) => { calls.push(sent.messageId) }
  // failed (server rejection) and unknown (no id)
  const failed = await harness(t, { onSent, behave: { media: () => { throw Object.assign(new Error('rejected'), { name: 'RequestError' }) } } })
  const f = await failed.stage(png(20, 20), { kind: 'image', filename: 'f.png', mime: 'image/png', chatId: PEER })
  await failed.ok('send', { requestId: f.requestId, chatId: PEER, sessionId: failed.sid(), kind: 'image', stageId: f.stageId })
  assert.equal((await failed.settled(f.requestId)).status, 'failed')
  const unknown = await harness(t, { onSent, behave: { media: () => ({}) } })
  const u = await unknown.stage(png(20, 20), { kind: 'image', filename: 'u.png', mime: 'image/png', chatId: PEER })
  await unknown.ok('send', { requestId: u.requestId, chatId: PEER, sessionId: unknown.sid(), kind: 'image', stageId: u.stageId })
  assert.equal((await unknown.settled(u.requestId)).status, 'unknown')
  assert.deepEqual(calls, [], 'nothing saved for failed / unknown')
  // watchdog: unknown first (nothing), then the late id upgrades it → saved once
  let release
  const slow = await harness(t, { onSent, watchdogMs: 30, behave: { media: () => new Promise((resolve) => { release = resolve }) } })
  const s = await slow.stage(png(20, 20), { kind: 'image', filename: 's.png', mime: 'image/png', chatId: PEER })
  await slow.ok('send', { requestId: s.requestId, chatId: PEER, sessionId: slow.sid(), kind: 'image', stageId: s.stageId })
  assert.equal((await slow.settled(s.requestId)).status, 'unknown')
  assert.deepEqual(calls, [])
  release({ id: X3_ID(5) })
  await tick(20)
  assert.deepEqual(calls, [X3_ID(5)])
  // text: never saved
  const text = await harness(t, { onSent })
  const tid = randomUUID()
  await text.ok('send', { requestId: tid, chatId: PEER, sessionId: text.sid(), kind: 'text', text: 'hi' })
  assert.equal((await text.settled(tid)).status, 'completed')
  assert.deepEqual(calls, [X3_ID(5)])
  // an SDK id that is not a LINE message id: the originals service refuses to name a file after it
  const odd = await x3Harness(t, { harness: { behave: { media: () => ({ id: 'm-1' }) } } })
  const o = await odd.stage(png(20, 20), { kind: 'image', filename: 'o.png', mime: 'image/png', chatId: GROUP })
  await odd.ok('send', { requestId: o.requestId, chatId: GROUP, sessionId: odd.sid(), kind: 'image', stageId: o.stageId })
  assert.equal((await odd.settled(o.requestId, GROUP)).status, 'completed')
  await odd.idle()
  assert.ok(odd.originalsLogs.includes('originals_outbound kind=IMAGE code=OUTBOUND_ID_INVALID'))
  assert.deepEqual((await readdir(path.join(odd.dataDir, SAVED_MEDIA_DIR)).catch(() => [])).filter((n) => !n.startsWith('.')), [])
})

test('X3 + X2b written once: the desktop row of the same message (direction out) reaches X6 through receive and is done at once — 0 OBS requests, one landing, origin stays outbound', async (t) => {
  const id = X3_ID(6)
  const h = await x3Harness(t, { harness: { behave: { media: () => ({ id }) } } })
  const image = png(44, 28, 5)
  const staged = await h.stage(image, { kind: 'image', filename: 'echo.png', mime: 'image/png', chatId: GROUP })
  // receive is on before the send; the watcher persists the desktop row of the sent message afterwards
  const receiveSwitch = { receiveEnabled: () => true, onReceiveEnabledChange: () => () => {} }
  const receive = new LineJsReceiveService({ dataDir: h.dataDir, getDb: () => h.db, originals: h.originals, session: { currentSessionId: () => h.sid() }, receiveSwitch, limits: { minTickMs: 0, pollMs: 1e9, deferMs: 1e9 } })
  stoppers.set(t, [() => receive.dispose(), ...(stoppers.get(t) ?? [])])
  await h.ok('send', { requestId: staged.requestId, chatId: GROUP, sessionId: h.sid(), kind: 'image', stageId: staged.stageId })
  assert.equal((await h.settled(staged.requestId, GROUP)).status, 'completed')
  await h.idle()
  h.db.prepare(`INSERT INTO messages (msg_id, chat_id, ts, direction, content_type, ingested_at, key_material, file_size, media_oid, media_sid)
    VALUES (?, ?, ?, 'out', 1, ?, ?, ?, ?, 'emi')`).run(`i:${id}`, GROUP, Date.now(), new Date().toISOString(), randomBytes(32).toString('base64'), image.length, `oidOUT${id}`)
  await receive.tick()
  assert.equal(receive.state().outstanding, 0, 'X6 answered done for the receive row')
  assert.equal(receive.counters.settled, 1)
  assert.equal(h.originals.counters.runs, 0, 'no download job was created')
  assert.equal(h.requests.length, 0, 'no OBS request')
  assert.equal(h.originals.sink.writes.get(x3Stem(id)), 1, 'landed once')
  assert.equal(h.originals.ledger.get(ledgerOwner(OWNER), x3Stem(id)).origin, 'outbound')
  const files = (await readdir(path.join(h.dataDir, SAVED_MEDIA_DIR))).filter((n) => !n.startsWith('.'))
  assert.deepEqual(files, [`${x3Stem(id)}.png`])
})

test('X3 a late SDK id for a send whose result is already final (failed, or completed already) never writes back — only the settle that makes it completed does (review-x2b F-7, mutation V8)', async (t) => {
  // white-box: no public path ends a running send while the SDK call is still out, so the test puts the record in a final state itself
  // (as a future cancel / fence would) right before the SDK answers with an id
  const calls = []
  let h = null
  h = await harness(t, {
    onSent: (sent) => { calls.push(sent.messageId) },
    behave: { media: () => { for (const r of h.service['records'].values()) if (r.status === 'running') { r.status = 'failed'; r.error = { code: 'TEST_FINAL', phase: 'sdk_send' } } return { id: X3_ID(8) } } },
  })
  const s = await h.stage(png(20, 20), { kind: 'image', filename: 'late.png', mime: 'image/png', chatId: PEER })
  await h.ok('send', { requestId: s.requestId, chatId: PEER, sessionId: h.sid(), kind: 'image', stageId: s.stageId })
  const view = await h.settled(s.requestId)
  assert.equal(view.status, 'failed', 'the final result stays')
  await tick(20)
  assert.deepEqual(calls, [], 'no write-back for a send that did not become completed')
  // a late answer for a send that is already completed (it carries its id already): the write-back is not done a second time
  let h2 = null
  h2 = await harness(t, {
    onSent: (sent) => { calls.push(sent.messageId) },
    behave: { media: () => { for (const r of h2.service['records'].values()) if (r.status === 'running') { r.status = 'completed'; r.messageId = X3_ID(12) } return { id: X3_ID(12) } } },
  })
  const s2 = await h2.stage(png(22, 22), { kind: 'image', filename: 'twice.png', mime: 'image/png', chatId: PEER })
  await h2.ok('send', { requestId: s2.requestId, chatId: PEER, sessionId: h2.sid(), kind: 'image', stageId: s2.stageId })
  assert.equal((await h2.settled(s2.requestId)).status, 'completed')
  await tick(20)
  assert.deepEqual(calls, [], 'a completed send is written back by the settle that completes it — never by a late duplicate answer')
})

test('X3 + X2b: the desktop row of a sent photo carrying another id (same chat, same size, same minute) logs code=OUTBOUND_ID_MISMATCH once, without ids; a row with the same id logs nothing (P0 R1 detection)', async (t) => {
  const ids = [X3_ID(9), X3_ID(11)]
  const h = await x3Harness(t, { harness: { behave: { media: () => ({ id: ids.shift() }) } } })
  const receiveSwitch = { receiveEnabled: () => true, onReceiveEnabledChange: () => () => {} }
  const receive = new LineJsReceiveService({ dataDir: h.dataDir, getDb: () => h.db, originals: h.originals, session: { currentSessionId: () => h.sid() }, receiveSwitch, limits: { minTickMs: 0, pollMs: 1e9, deferMs: 1e9 } })
  stoppers.set(t, [() => receive.dispose(), ...(stoppers.get(t) ?? [])])
  await receive.tick()
  const mismatchLines = () => h.originalsLogs.filter((l) => l.includes('OUTBOUND_ID_MISMATCH'))
  const sendImage = async (image, name) => {
    const staged = await h.stage(image, { kind: 'image', filename: name, mime: 'image/png', chatId: GROUP })
    await h.ok('send', { requestId: staged.requestId, chatId: GROUP, sessionId: h.sid(), kind: 'image', stageId: staged.stageId })
    assert.equal((await h.settled(staged.requestId, GROUP)).status, 'completed')
    await h.idle()
  }
  const outRow = (msgId, size) => h.db.prepare(`INSERT INTO messages (msg_id, chat_id, ts, direction, content_type, ingested_at, file_size)
    VALUES (?, ?, ?, 'out', 1, ?, ?)`).run(msgId, GROUP, Date.now(), new Date().toISOString(), size)
  // 1. the desktop row of the sent photo has another id than the SDK answered (P0 R1 does not hold)
  const first = png(44, 28, 6)
  await sendImage(first, 'one.png')
  outRow(`i:${X3_ID(10)}`, first.length)
  await receive.tick()
  assert.deepEqual(mismatchLines(), ['originals_outbound code=OUTBOUND_ID_MISMATCH'])
  assert.equal(h.originals.counters.outboundMismatch, 1)
  await receive.tick()
  assert.equal(mismatchLines().length, 1, 'once per write-back')
  // 2. the desktop row carries the SDK id: consistent, nothing logged
  const second = png(52, 30, 8)
  await sendImage(second, 'two.png')
  outRow(`i:${X3_ID(11)}`, second.length)
  await receive.tick()
  assert.equal(mismatchLines().length, 1)
  for (const line of h.originalsLogs) for (const secret of [X3_ID(9), X3_ID(10), X3_ID(11), GROUP]) assert.ok(!line.includes(secret), `log leaks: ${line}`)
})

test('X3 + X2b racing: the outbound write and a receive write of the same stem at the same moment still land one file (shared sink: stem lock + no-overwrite link)', async (t) => {
  const id = X3_ID(7)
  const h = await x3Harness(t)
  const image = png(36, 36, 9)
  const sent = { messageId: id, kind: 'image', chatId: GROUP, ownerMid: OWNER, body: image, mime: 'image/png', filename: 'race.png' }
  const results = await Promise.all([h.originals.saveOutbound(sent), h.originals.saveOutbound({ ...sent }), h.originals.sink.saveBytes({ stem: x3Stem(id), kind: 'IMAGE', origin: 'receive', chatId: GROUP }, image, 'image/png')])
  assert.deepEqual(results.map((r) => r.status).sort(), ['exists', 'exists', 'written'])
  assert.equal(h.originals.sink.writes.get(x3Stem(id)), 1)
})
