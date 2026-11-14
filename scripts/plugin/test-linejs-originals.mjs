// X6 舊訊息下載原檔（implementation-plan-v2.md §2 X6；history-download.md §5–§6；Manager 裁決：批次範圍、ledger 收斂、I-1、I-2、I-4、
// N-1 協調層、X1 L-3 的 401 暫停語意、節制、status 不呼叫 LINE）。
// 假 client、假 OBS、假 app DB、假電腦版 LINE DB；寫入只在 os.tmpdir() 底下。沒有真 LINE、不讀憑證（全域 fetch 換成會丟錯的假函式）。
// 測試名稱以 [A#]（v2 驗收項目）與 [M#]（Manager 裁決）標示對應關係。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { OriginalDownloadService, releaseSharedLedger, sharedMediaLedger, sharedMediaSink } from '../../src/plugin/backend/linejsOriginals.ts'
// fix1 symbols through the namespace (the file still loads on 0841bcd, where they do not exist: those tests fail there, the rest run)
import * as Originals from '../../src/plugin/backend/linejsOriginals.ts'
import { LINEJS_ORIGINALS_PATHS, ORIGINALS_LIMITS } from '../../src/shared/linejsOriginals.ts'
import { ObsLimiter, OBS_AUTH_PAUSE_MAX_MS, OBS_RATE_LIMIT_MAX_MS } from '../../src/plugin/backend/linejsObs.ts'
import { createLineJsMediaFetch } from '../../src/plugin/backend/linejsMedia.ts'
import { SAVED_MEDIA_DIR, createPluginMedia, mediaCacheStem } from '../../src/plugin/backend/media.ts'
import { ledgerFingerprint, ledgerOwner, MEDIA_LEDGER_NAME, MediaLedger } from '../../src/plugin/backend/linejsAutoDownload.mjs'
import { Dispatcher, INTERNAL_API_PATHS, SUPPORTED_API_PATHS } from '../../src/plugin/backend/dispatcher.ts'
import { EventHub } from '../../src/plugin/backend/eventHub.ts'
import { BACKEND_METHOD_GROUPS, backendMethodFor } from '../../src/shared/pluginWire.ts'

globalThis.fetch = async () => { throw Object.assign(new Error('network disabled in this test'), { code: 'TEST_NO_NETWORK' }) }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const KIB = 1024
const ME = 'u0123456789abcdef0123456789abcdef'
const FRIEND = 'ufedcba9876543210fedcba9876543210'
const GROUP = 'c11112222333344445555666677778888'
const CHAT_NAME = 'Team Alpha Secret Room'
const SQUARE = 't99998888777766665555444433332222'
const OID_IMG = 'oidIMAGE0123456789abcdefXYZ'
const OID_VID = 'oidVIDEO0123456789abcdefXYZ'
const OID_FILE = 'oidFILE0123456789abcdefXYZ'
const FILE_NAME = 'quarterly-report-confidential.pdf'
const TS = new Date(2026, 9, 1, 12, 0, 0).getTime()
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))
const stemOf = (id) => mediaCacheStem(`i:${id}`)

// ───────────────────────── fixtures ─────────────────────────

function keysOf(km) {
  const d = Buffer.from(hkdfSync('sha256', km, Buffer.alloc(0), Buffer.from('FileEncryption'), 76))
  return { encKey: d.subarray(0, 32), macKey: d.subarray(32, 64), nonce: Buffer.concat([d.subarray(64, 76), Buffer.alloc(4)]) }
}
function encrypt(plain, km) {
  const k = keysOf(km)
  const c = createCipheriv('aes-256-ctr', k.encKey, k.nonce)
  const enc = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([enc, createHmac('sha256', k.macKey).update(enc).digest()])
}
function pattern(n, seed = 7) { const b = Buffer.alloc(n); let x = seed >>> 0; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24 } return b }
function mp4(n, seed = 3) { const b = pattern(n, seed); Buffer.from([0, 0, 0, 0x20]).copy(b, 0); b.write('ftyp', 4, 'latin1'); b.write('isom', 8, 'latin1'); return b }
function png(w = 60, h = 40, seed = 7) {
  const chunk = (type, data) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii'); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0, 0); return Buffer.concat([head, data, crc]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const rows = pattern((w * 3 + 1) * h, seed); for (let y = 0; y < h; y++) rows[y * (w * 3 + 1)] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows, { level: 0 })), chunk('IEND', Buffer.alloc(0))])
}

/** A fake LINEJS client: GET headers carry its token; base.on/emit for update:authtoken. Every method call is counted. */
function fakeClient(token) {
  const listeners = new Map()
  const calls = { getHeader: 0, on: 0 }
  const base = {
    authToken: token,
    profile: { mid: ME },
    request: { systemType: 'ANDROIDSECONDARY\t14.0.0\tAndroid OS\t13', getHeader: () => { calls.getHeader++; return { 'x-line-access': token, 'accept-encoding': 'gzip' } } },
    on: (event, fn) => { calls.on++; listeners.set(event, [...(listeners.get(event) ?? []), fn]) },
    emit: (event, ...args) => { for (const fn of listeners.get(event) ?? []) fn(...args) },
  }
  return { base, calls }
}
const makeSession = (sid, mid = ME) => ({ client: fakeClient(`token-${sid}`), sessionId: sid, ownerMid: mid })

/** The LINEJS session port: outboundSession counts its calls; install() switches the session and notifies like LineJsMediaService. */
function fakeSessions(initial = makeSession('sess-1')) {
  const listeners = new Set()
  const port = {
    current: initial,
    calls: { outbound: 0, isCurrent: 0 },
    outboundSession: async () => { port.calls.outbound++; return port.current },
    isCurrentSession: (sid, client) => { port.calls.isCurrent++; return Boolean(port.current) && port.current.sessionId === sid && port.current.client === client },
    onSessionChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    install(next) { port.current = next; for (const fn of [...listeners]) fn(next ? next.sessionId : null) },
  }
  return port
}

/**
 * Fake OBS. `respond({path, token, n})` may return {status, headers} for a request; `gate` holds the body of request #gateRequest
 * (default 1) after `gateAt` bytes until the promise resolves. `holdFor({path, n})` may return a promise that holds the body of THAT
 * request after `gateAt` bytes (every request it answers for, e.g. each resume of one video).
 */
function obsServer(objects, opts = {}) {
  const requests = []
  const fetch = async (request) => {
    const url = new URL(request.url)
    const token = request.headers.get('x-line-access')
    const n = requests.length + 1
    requests.push({ path: url.pathname, range: request.headers.get('range'), token, at: Date.now() })
    const rule = opts.respond?.({ path: url.pathname, token, n })
    if (rule) return new Response('', { status: rule.status, headers: rule.headers ?? {} })
    const body = objects.get(url.pathname)
    if (!body) return new Response('', { status: 404 })
    const m = /^bytes=(\d+)-$/.exec(request.headers.get('range') ?? '')
    const start = m ? Number(m[1]) : 0
    const headers = { 'content-length': String(body.length - start) }
    if (m) headers['content-range'] = `bytes ${start}-${body.length - 1}/${body.length}`
    const gated = opts.gate && n === (opts.gateRequest ?? 1)
    const held = opts.holdFor?.({ path: url.pathname, n }) ?? null
    let pos = start
    let sent = 0
    const stream = new ReadableStream({
      start(controller) { request.signal.addEventListener('abort', () => { try { controller.error(new DOMException('aborted', 'AbortError')) } catch { /* closed */ } }, { once: true }) },
      async pull(controller) {
        if (gated && sent >= (opts.gateAt ?? 0)) await opts.gate
        if (held && sent >= (opts.gateAt ?? 0)) await held
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

/** App DB rows (messages, chats) behind the `prepare(sql).get(id)` shape both the service and M1's media reader use. */
function fakeDb(rows, chats = new Map([[GROUP, { chat_id: GROUP, name: CHAT_NAME }]])) {
  const calls = { messages: 0, chats: 0 }
  return {
    calls,
    db: { prepare: (sql) => ({ get: (id) => { if (/FROM messages/.test(sql)) { calls.messages++; return rows.get(id) } if (/FROM chats/.test(sql)) { calls.chats++; return chats.get(id) } return undefined } }) },
  }
}
const row = (id, over = {}) => ({ msg_id: `i:${id}`, chat_id: GROUP, ts: TS, content_type: 1, key_material: null, file_size: null, media_oid: null, media_sid: null, orig_filename: null, unsent: 0, ...over })

const removeDir = (dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
async function workdir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'line-todo-x6-originals-'))
  t.after(() => removeDir(dir))
  return dir
}
const roomy = async () => ({ bavail: 1e12 / 4096, bsize: 4096 })
async function until(fn, label = 'condition', ms = 8000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await tick(5)
  }
}

/**
 * One service over a temp dataDir with every port faked. Returns the service plus the fakes and their counters.
 * `items`: Map id → { row, obs?: [path, body], desktop?: row } ; `opts` overrides.
 */
async function harness(t, items, opts = {}) {
  // a dir the harness makes is removed in the same hook, after the service is disposed (no flush can race the removal)
  const dir = opts.dir ?? await mkdtemp(path.join(os.tmpdir(), 'line-todo-x6-originals-'))
  const rows = new Map()
  const objects = new Map()
  const desktop = new Map()
  for (const [id, it] of items) {
    rows.set(`i:${id}`, it.row)
    if (it.obs) objects.set(it.obs[0], it.obs[1])
    if (it.desktop) desktop.set(`${it.row.chat_id}|${it.row.ts}`, [...(desktop.get(`${it.row.chat_id}|${it.row.ts}`) ?? []), it.desktop])
  }
  const app = fakeDb(rows, opts.chats)
  const sessions = opts.sessions ?? fakeSessions()
  const obs = obsServer(objects, opts.obs ?? {})
  const counts = { localMid: 0, desktop: 0, localImage: 0 }
  const logs = []
  const traces = []
  const limiter = opts.limiter ?? new ObsLimiter()
  const service = new OriginalDownloadService({
    dataDir: dir,
    session: sessions,
    localAccountMid: async () => { counts.localMid++; return opts.localMidFn ? opts.localMidFn() : opts.localMid === undefined ? ME : opts.localMid },
    getDb: () => app.db,
    desktopRows: async (chatId, createdTime) => {
      counts.desktop++
      const n = counts.desktop
      if (opts.desktopDelay) await tick(opts.desktopDelay(n))
      return desktop.get(`${chatId}|${createdTime}`) ?? []
    },
    ...(opts.localImage ? { localImage: (input) => { counts.localImage++; return opts.localImage(input) } } : {}),
    limiter,
    fetch: createLineJsMediaFetch(obs.fetch),
    stream: { statfs: roomy, backoffMs: () => 0, maxAttempts: 2, ...opts.stream },
    limits: { requestIntervalMs: 0, autoRetryDelayMs: 60_000, ...opts.limits },
    ...(opts.accountReadTimeoutMs ? { accountReadTimeoutMs: opts.accountReadTimeoutMs } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    log: (line) => logs.push(line),
    trace: (phase, ms) => traces.push({ phase, ms }),
  })
  t.after(async () => { await service.dispose(); if (!opts.dir) await removeDir(dir) })
  const media = createPluginMedia({ dataDir: dir, getDb: () => app.db, decryptor: null, index: null })
  return { dir, service, sessions, obs, app, counts, logs, traces, limiter, media, rows, objects }
}

// item builders
function e2eePhoto(id, over = {}) {
  const km = randomBytes(32)
  const body = over.body ?? png(60, 40, Number(id) % 97)
  const oid = over.oid ?? `${OID_IMG}${id}`
  return { km, body, oid, row: row(id, { content_type: 1, key_material: km.toString('base64'), file_size: body.length, media_oid: oid, media_sid: 'emi', ...over.row }), obs: [`/r/talk/emi/${oid}`, encrypt(body, km)] }
}
function plainPhoto(id) {
  const body = png(50, 30, 11)
  return { body, row: row(id, { content_type: 1, media_oid: `plain${id}`, media_sid: 'm', file_size: body.length }), obs: [`/r/talk/m/${id}`, body] }
}
function video(id, size = 300 * KIB + 7) {
  const km = randomBytes(32)
  const body = mp4(size, Number(id) % 89)
  const oid = `${OID_VID}${id}`
  return {
    km, body, oid,
    row: row(id, { content_type: 2 }),
    desktop: { _id: id, _contentType: 2, _contentMetadata: JSON.stringify({ OID: oid, SID: 'emv', FILE_SIZE: String(body.length) }), _contentInfo: JSON.stringify({ keyMaterial: km.toString('base64') }) },
    obs: [`/r/talk/emv/${oid}`, encrypt(body, km)],
  }
}
function file(id) {
  const km = randomBytes(32)
  const body = randomBytes(90 * KIB + 3)
  const oid = `${OID_FILE}${id}`
  return { km, body, oid, row: row(id, { content_type: 14, key_material: km.toString('base64'), file_size: body.length, media_oid: oid, media_sid: 'emf', orig_filename: FILE_NAME }), obs: [`/r/talk/emf/${oid}`, encrypt(body, km)] }
}
const partsIn = async (dir) => (await readdir(path.join(dir, SAVED_MEDIA_DIR)).catch(() => [])).filter((n) => n.endsWith('.part'))

// ───────────────────────── A1 four kinds ─────────────────────────

test('[A1][M7][M6] E2EE photo, non-E2EE photo, video (key from the desktop row) and file all complete; M1 serves them; begin carried the fingerprint; logs carry codes only', async (t) => {
  const items = new Map([['6100000000000000001', e2eePhoto('6100000000000000001')], ['6100000000000000002', plainPhoto('6100000000000000002')], ['6100000000000000003', video('6100000000000000003')], ['6100000000000000004', file('6100000000000000004')]])
  const h = await harness(t, items)
  for (const id of items.keys()) assert.ok(['queued', 'running'].includes((await h.service.request(`i:${id}`)).state), id)
  await h.service.whenIdle()
  const st = await h.service.status([...items.keys()].map((id) => `i:${id}`))
  assert.deepEqual(st.items.map((i) => i.state), ['done', 'done', 'done', 'done'])
  assert.equal(h.obs.requests.length, 4, 'one OBS request each')
  assert.deepEqual(h.obs.requests.map((r) => r.path), [...items.values()].map((it) => it.obs[0]))
  // M1 reads them back
  const [p1, p2, v, f] = [...items.keys()]
  assert.equal(h.media.prepare(`i:${p1}`).ok, true)
  assert.equal(h.media.prepare(`i:${p2}`).ok, true)
  assert.equal(h.media.prepareVideo(`i:${v}`).ok, true)
  const saved = h.media.savedFile(`i:${f}`)
  assert.equal(saved.ok, true)
  assert.deepEqual(await readFile(saved.absPath), items.get(f).body)
  assert.deepEqual(await readFile(path.join(h.dir, SAVED_MEDIA_DIR, `${stemOf(v)}.mp4`)), items.get(v).body)
  assert.equal(h.counts.desktop, 1, 'only the video needed the desktop row')
  assert.ok(h.traces.some((x) => x.phase === 'originals_locator' && Number.isFinite(x.ms)), 'the desktop read time is traced')
  // I-4: every entry carries the fingerprint of its OID / SID (the video's from the desktop row)
  const owner = ledgerOwner(ME)
  assert.equal(h.service.ledger.get(owner, stemOf(p1)).fingerprint, ledgerFingerprint(items.get(p1).oid, 'emi'))
  assert.equal(h.service.ledger.get(owner, stemOf(p2)).fingerprint, ledgerFingerprint(`plain${p2}`, 'm'))
  assert.equal(h.service.ledger.get(owner, stemOf(v)).fingerprint, ledgerFingerprint(items.get(v).oid, 'emv'))
  assert.equal(h.service.ledger.get(owner, stemOf(f)).fingerprint, ledgerFingerprint(items.get(f).oid, 'emf'))
  for (const id of items.keys()) assert.equal(h.service.ledger.get(owner, stemOf(id)).state, 'done')
  // I-2: no path, chat id / name, file name, message id, OID, token or session id in any log line
  const text = h.logs.join('\n')
  assert.ok(h.logs.length > 0)
  for (const secret of [h.dir, path.basename(h.dir), GROUP, CHAT_NAME, FILE_NAME, 'quarterly', ...items.keys(), OID_IMG, OID_VID, OID_FILE, 'token-', 'sess-1', ME]) assert.equal(text.includes(secret), false, `log leaks ${secret}`)
  assert.equal(/\d{12,}/.test(text), false, 'no long numeric id in the logs')
})

// ───────────────────────── A2 local short-circuits ─────────────────────────

test('[A2] the five local short-circuits send no OBS request: already landed, expired, undecryptable, forbidden in the same session, unsupported SID', async (t) => {
  const ids = ['7001', '7002', '7003', '7004', '7005']
  const items = new Map(ids.map((id) => [id, e2eePhoto(id)]))
  items.set('7005', e2eePhoto('7005', { row: { media_sid: 'emx' } }))
  const h = await harness(t, items)
  await sharedMediaLedger(h.dir).loaded
  const owner = ledgerOwner(ME)
  const fp = (id) => ledgerFingerprint(items.get(id).oid, 'emi')
  await sharedMediaSink(h.dir).saveBytes({ stem: stemOf('7001'), kind: 'IMAGE', origin: 'outbound', chatId: GROUP }, items.get('7001').body, 'image/png')
  for (const [id, cls, code, sid] of [['7002', 'expired', 'OBS_HTTP_404'], ['7003', 'undecryptable', 'HMAC_MISMATCH'], ['7004', 'forbidden', 'OBS_HTTP_403', 'sess-1']]) {
    h.service.ledger.begin(owner, stemOf(id), { origin: 'history', kind: 'IMAGE', fingerprint: fp(id), sessionId: 'sess-1' })
    h.service.ledger.record(owner, stemOf(id), { status: 'failed', class: cls, code }, { sessionId: sid })
  }
  const out = []
  for (const id of ids) out.push(await h.service.request(`i:${id}`))
  await h.service.whenIdle()
  assert.deepEqual(out.map((v) => v.state), ['done', 'expired', 'undecryptable', 'forbidden', 'unsupported'])
  assert.equal(out[4].code, 'SID_UNSUPPORTED')
  assert.equal(h.obs.requests.length, 0, 'no OBS request')
  assert.equal(h.service.counters.requests, 0)
})

// ───────────────────────── A3 single-flight ─────────────────────────

test('[A3][M1] single-flight: the same stem clicked 5 times while it downloads, plus a batch that includes it, sends exactly 1 request', async (t) => {
  let release
  const gate = new Promise((r) => { release = r })
  const v = video('7101', 400 * KIB + 1)
  const h = await harness(t, new Map([['7101', v]]), { obs: { gate, gateAt: 128 * KIB } })
  assert.equal((await h.service.request('i:7101')).state, 'queued')
  await until(() => h.obs.requests.length === 1, 'the first request')
  const clicks = await Promise.all([1, 2, 3, 4].map(() => h.service.request('i:7101')))
  assert.ok(clicks.every((c) => c.state === 'running'), JSON.stringify(clicks))
  const batch = await h.service.batchStart(GROUP, ['i:7101'])
  assert.deepEqual(batch.accepted, ['i:7101'], 'the batch joins the running work')
  assert.deepEqual(h.service.queueState().jobs, 1)
  release()
  await h.service.whenIdle()
  assert.equal(h.obs.requests.length, 1, 'exactly one OBS request')
  assert.equal((await h.service.status(['i:7101'])).items[0].state, 'done')
})

// ───────────────────────── A4 expired survives a restart ─────────────────────────

test('[A4] 404 → expired; after a restart status still answers expired from the ledger on disk and nothing calls LINE', async (t) => {
  const p = e2eePhoto('7201')
  const h = await harness(t, new Map([['7201', p]]), { obs: { respond: () => ({ status: 404 }) } })
  await h.service.request('i:7201')
  await h.service.whenIdle()
  assert.equal((await h.service.status(['i:7201'])).items[0].state, 'expired')
  assert.equal(h.obs.requests.length, 1)
  await h.service.dispose()
  assert.ok(JSON.parse(await readFile(path.join(h.dir, 'linejs-downloads', MEDIA_LEDGER_NAME), 'utf8')).items.some((e) => e.class === 'expired'), 'expired is on disk')
  // restart: a fresh ledger loaded from disk, fresh fakes
  releaseSharedLedger(h.dir)
  const sessions = fakeSessions(null)
  const h2 = await harness(t, new Map([['7201', p]]), { dir: h.dir, sessions })
  sessions.install(makeSession('sess-9'))
  await until(async () => (await h2.service.status(['i:7201'])).items[0].state !== 'needs_login', 'the restored session')
  const before = { outbound: sessions.calls.outbound, localMid: h2.counts.localMid, desktop: h2.counts.desktop, requests: h2.obs.requests.length }
  const st = await h2.service.status(['i:7201'])
  assert.equal(st.items[0].state, 'expired')
  assert.deepEqual({ outbound: sessions.calls.outbound, localMid: h2.counts.localMid, desktop: h2.counts.desktop, requests: h2.obs.requests.length }, before, 'status called nothing')
  assert.equal((await h2.service.request('i:7201')).state, 'expired')
  assert.equal(h2.obs.requests.length, 0, 'no OBS request after the restart')
})

// ───────────────────────── A5 429 ─────────────────────────

test('[A5][M10] 429 pauses everything: the next work is not sent while the pause lasts', async (t) => {
  const a = e2eePhoto('7301')
  const b = e2eePhoto('7302')
  const h = await harness(t, new Map([['7301', a], ['7302', b]]), { obs: { respond: ({ n }) => (n === 1 ? { status: 429, headers: { 'retry-after': '120' } } : null) } })
  await h.service.request('i:7301')
  await until(async () => (await h.service.status(['i:7301'])).items[0].state === 'paused', 'the 429 pause')
  await h.service.request('i:7302')
  await tick(60)
  h.service.kick()
  await tick(20)
  const st = await h.service.status(['i:7301', 'i:7302'])
  assert.deepEqual(st.items.map((i) => [i.state, i.code]), [['paused', 'rate_limited'], ['paused', 'rate_limited']])
  assert.equal(st.paused?.reason, 'rate_limited')
  assert.equal(h.obs.requests.length, 1, 'nothing else was sent')
  assert.ok(h.limiter.state().pausedMs > 100_000, 'the shared OBS limiter is paused for Retry-After')
})

// ───────────────────────── A6 / M9 401 ─────────────────────────

test('[A6][M9] 401 pauses only that session; a new session (same account) resumes the parked work and sends it with the new session', async (t) => {
  const a = e2eePhoto('7401')
  const b = e2eePhoto('7402')
  const h = await harness(t, new Map([['7401', a], ['7402', b]]), { obs: { respond: ({ token }) => (token === 'token-sess-1' ? { status: 401 } : null) } })
  await h.service.request('i:7401')
  await until(async () => (await h.service.status(['i:7401'])).items[0].state === 'paused', 'the 401 pause')
  await h.service.request('i:7402')
  await tick(40)
  assert.deepEqual((await h.service.status(['i:7401', 'i:7402'])).items.map((i) => [i.state, i.code]), [['paused', 'auth'], ['paused', 'auth']])
  assert.equal(h.obs.requests.length, 1, 'the same session sends nothing more')
  assert.equal(h.limiter.authPausedSession(), 'sess-1')
  h.sessions.install(makeSession('sess-2'))
  await h.service.whenIdle()
  assert.deepEqual((await h.service.status(['i:7401', 'i:7402'])).items.map((i) => i.state), ['done', 'done'])
  assert.deepEqual(h.obs.requests.map((r) => r.token), ['token-sess-1', 'token-sess-2', 'token-sess-2'])
  assert.equal(h.limiter.authPausedSession(), null, 'the new session lifted the old pause in the shared limiter (acquire carried isCurrent)')
})

test('[M9] a token refresh (update:authtoken) of the paused session lifts its 401 pause at once', async (t) => {
  const a = e2eePhoto('7451')
  const h = await harness(t, new Map([['7451', a]]), { obs: { respond: ({ n }) => (n === 1 ? { status: 401 } : null) } })
  await h.service.request('i:7451')
  await until(async () => (await h.service.status(['i:7451'])).items[0].state === 'paused', 'the 401 pause')
  await tick(20)
  assert.equal(h.obs.requests.length, 1)
  h.sessions.current.client.base.emit('update:authtoken', 'new-token')
  await h.service.whenIdle()
  assert.equal((await h.service.status(['i:7451'])).items[0].state, 'done')
  assert.deepEqual(h.obs.requests.map((r) => r.token), ['token-sess-1', 'token-sess-1'], 'resumed on the same session')
})

test('[M9] ObsLimiter (L-3): a 401 flushes only the waiters of that session; a stale session cannot lift it; the current one can; it also ends by resumeAuth or after its time limit', async () => {
  let now = 1_000_000
  const limiter = new ObsLimiter({ concurrency: 1, now: () => now })
  const holder = await limiter.acquire('user', { sessionId: 's1' })
  assert.equal(holder.ok, true)
  const w1 = limiter.acquire('user', { sessionId: 's1' })
  const w2 = limiter.acquire('receive', { sessionId: 's2' })
  let w2done = false
  void w2.then(() => { w2done = true })
  limiter.pauseAuth('s1')
  assert.deepEqual(await w1, { ok: false, outcome: { status: 'paused', class: 'auth', code: 'OBS_AUTH_PAUSED' } })
  await tick(5)
  assert.equal(w2done, false, 'the other session\'s waiter stays queued')
  holder.release()
  const g2 = await w2
  assert.equal(g2.ok, true, 'and gets the slot')
  g2.release()
  // a stale session (not current) does not lift s1's pause; s1 stays paused
  const stale = await limiter.acquire('user', { sessionId: 's0', isCurrent: () => false })
  stale.release()
  assert.equal(limiter.authPausedSession(), 's1')
  assert.equal((await limiter.acquire('user', { sessionId: 's1' })).ok, false)
  // the current session lifts it
  const cur = await limiter.acquire('user', { sessionId: 's3', isCurrent: () => true })
  cur.release()
  assert.equal(limiter.authPausedSession(), null)
  // resumeAuth (token refresh) and the time limit
  limiter.pauseAuth('s3')
  limiter.resumeAuth('s3')
  const r3 = await limiter.acquire('user', { sessionId: 's3' }); assert.equal(r3.ok, true); r3.release()
  limiter.pauseAuth('s4')
  assert.equal((await limiter.acquire('user', { sessionId: 's4' })).ok, false)
  now += OBS_AUTH_PAUSE_MAX_MS + 1
  const r4 = await limiter.acquire('user', { sessionId: 's4' }); assert.equal(r4.ok, true, 'the pause has a time limit'); r4.release()
  assert.equal(limiter.state().authPaused, false)
})

// ───────────────────────── A7 account mismatch ─────────────────────────

test('[A7] account mismatch (desktop LINE account differs from the LINEJS login) → account_mismatch, 0 requests; an unreadable desktop account fails closed too', async (t) => {
  const items = new Map([['7501', e2eePhoto('7501')], ['7502', e2eePhoto('7502')]])
  const h = await harness(t, items, { localMid: FRIEND })
  assert.deepEqual(await h.service.request('i:7501'), { msgId: 'i:7501', state: 'account_mismatch', code: 'ACCOUNT_MISMATCH' })
  const b = await h.service.batchStart(GROUP, ['i:7501', 'i:7502'])
  assert.deepEqual(b.accepted, [])
  assert.ok(b.skipped.every((s) => s.state === 'account_mismatch'))
  assert.equal((await h.service.status(['i:7501'])).items[0].state, 'account_mismatch')
  assert.equal(h.obs.requests.length, 0)
  const h2 = await harness(t, new Map([['7503', e2eePhoto('7503')]]), { localMid: null })
  assert.deepEqual(await h2.service.request('i:7503'), { msgId: 'i:7503', state: 'account_mismatch', code: 'ACCOUNT_UNVERIFIED' })
  assert.equal(h2.obs.requests.length, 0)
})

// ───────────────────────── A8 unsupported ─────────────────────────

test('[A8] unsent, a d: id and a Square chat are unsupported with 0 requests (decided before the session is touched)', async (t) => {
  const items = new Map([['7601', e2eePhoto('7601', { row: { unsent: 1 } })], ['7602', e2eePhoto('7602', { row: { chat_id: SQUARE } })], ['7603', e2eePhoto('7603', { row: { content_type: 7 } })]])
  const h = await harness(t, items)
  assert.deepEqual(await h.service.request('i:7601'), { msgId: 'i:7601', state: 'unsupported', code: 'UNSENT' })
  assert.deepEqual(await h.service.request('d:0123456789abcdef'), { msgId: 'd:0123456789abcdef', state: 'unsupported', code: 'MESSAGE_ID_UNSUPPORTED' })
  assert.deepEqual(await h.service.request('i:7602'), { msgId: 'i:7602', state: 'unsupported', code: 'CHAT_UNSUPPORTED' })
  assert.deepEqual(await h.service.request('i:7603'), { msgId: 'i:7603', state: 'unsupported', code: 'CONTENT_TYPE_UNSUPPORTED' })
  assert.equal(h.obs.requests.length, 0)
  assert.equal(h.sessions.calls.outbound, 0)
})

// ───────────────────────── A9 / M1 batch ─────────────────────────

test('[A9][M1] batch of 60 → 50 accepted (10 truncated); cancel: queued items go back to idle, the running one is aborted and its part is kept', async (t) => {
  let release
  const gate = new Promise((r) => { release = r })
  t.after(() => release())
  const items = new Map()
  items.set('8000', video('8000', 500 * KIB + 3))
  for (let i = 1; i < 60; i++) items.set(String(8000 + i), e2eePhoto(String(8000 + i)))
  const h = await harness(t, items, { obs: { gate, gateAt: 192 * KIB } })
  const ids = [...items.keys()].map((id) => `i:${id}`)
  const out = await h.service.batchStart(GROUP, ids)
  assert.equal(out.accepted.length, ORIGINALS_LIMITS.batchMax)
  assert.equal(out.accepted.length, 50)
  assert.equal(out.truncated, 10)
  assert.deepEqual(out.accepted, ids.slice(0, 50))
  await until(() => h.obs.requests.length === 1, 'the first batch request')
  await tick(50)
  assert.equal((await h.service.status([ids[0]])).items[0].state, 'running')
  const view = (await h.service.status([ids[0]])).batch
  assert.deepEqual([view.total, view.state], [50, 'running'])
  assert.deepEqual(await h.service.batchCancel(out.batchId), { cancelled: 50 })
  await h.service.whenIdle()
  const st = await h.service.status(ids.slice(0, 50))
  assert.ok(st.items.every((i) => i.state === 'idle'), JSON.stringify(st.items.filter((i) => i.state !== 'idle')))
  assert.equal(st.batch.state, 'cancelled')
  assert.equal(h.obs.requests.length, 1, 'nothing else was sent')
  const parts = await partsIn(h.dir)
  assert.equal(parts.length, 1, 'the aborted download kept its part')
  assert.ok((await stat(path.join(h.dir, SAVED_MEDIA_DIR, parts[0]))).size > 0)
  assert.equal(h.service.ledger.get(ledgerOwner(ME), stemOf('8000')).partName, parts[0], 'the ledger remembers it for a resume')
  // a second batch is possible once the first is over; one running batch at a time
  release()
  const again = await h.service.batchStart(GROUP, [ids[0]])
  assert.deepEqual(again.accepted, [ids[0]])
  assert.deepEqual(await h.service.batchStart(GROUP, [ids[1]]), { error: 'BATCH_ACTIVE', batchId: again.batchId })
  await h.service.whenIdle()
  assert.equal((await h.service.status([ids[0]])).items[0].state, 'done')
  assert.match(String(h.obs.requests[1].range), /^bytes=\d+-$/, 'the second batch resumed the kept part with Range')
})

test('[M1] a batch takes photos, videos and files; a single click is served while a batch download is still running', async (t) => {
  let release
  const gate = new Promise((r) => { release = r })
  t.after(() => release())
  const items = new Map([['8101', video('8101', 500 * KIB + 1)], ['8102', file('8102')], ['8103', e2eePhoto('8103')], ['8104', e2eePhoto('8104')]])
  const h = await harness(t, items, { obs: { gate, gateAt: 192 * KIB } })
  const b = await h.service.batchStart(GROUP, ['i:8101', 'i:8102', 'i:8103'])
  assert.deepEqual(b.accepted, ['i:8101', 'i:8102', 'i:8103'], 'video and file are accepted into a batch')
  await until(() => h.obs.requests.length === 1, 'the batch video')
  assert.equal((await h.service.request('i:8104')).state, 'queued')
  await until(async () => (await h.service.status(['i:8104'])).items[0].state === 'done', 'the single click')
  assert.equal((await h.service.status(['i:8101'])).items[0].state, 'running', 'the batch download is still held')
  release()
  await h.service.whenIdle()
  assert.deepEqual((await h.service.status(['i:8101', 'i:8102', 'i:8103', 'i:8104'])).items.map((i) => i.state), ['done', 'done', 'done', 'done'])
  const view = (await h.service.status(['i:8101'])).batch
  assert.deepEqual([view.total, view.done, view.remaining, view.state], [3, 3, 0, 'finished'])
  assert.equal(h.media.prepareVideo('i:8101').ok, true)
  assert.equal(h.media.savedFile('i:8102').ok, true)
})

// ───────────────────────── A10 / M10 throttling ─────────────────────────

test('[A10][M10] the hourly cap holds (counted at the fetch, local refusals are pauses, not attempts); work resumes when the window frees', async (t) => {
  let now = 5_000_000_000
  const items = new Map(['8201', '8202', '8203', '8204', '8205'].map((id) => [id, e2eePhoto(id)]))
  const h = await harness(t, items, { now: () => now, limits: { requestsPerHour: 3 } })
  for (const id of items.keys()) await h.service.request(`i:${id}`)
  await until(async () => (await h.service.status(['i:8205'])).items[0].state === 'paused' && h.service.queueState().running === 0 && h.service.queueState().queued === 2, 'the hourly pause')
  assert.equal(h.obs.requests.length, 3, 'no more than the cap reached OBS')
  const st = await h.service.status([...items.keys()].map((id) => `i:${id}`))
  assert.deepEqual(st.items.map((i) => i.state), ['done', 'done', 'done', 'paused', 'paused'])
  assert.equal(st.paused?.reason, 'hourly_limit')
  assert.ok(st.items.slice(3).every((i) => i.code === 'hourly_limit'))
  assert.equal(h.service.ledger.get(ledgerOwner(ME), stemOf('8204')).attempts, 0, 'a local refusal is not an attempt')
  now += ORIGINALS_LIMITS.requestWindowMs + 1
  h.service.kick()
  await h.service.whenIdle()
  assert.equal(h.obs.requests.length, 5)
  assert.deepEqual((await h.service.status(['i:8204', 'i:8205'])).items.map((i) => i.state), ['done', 'done'])
})

test('[M10] consecutive OBS requests keep the minimum interval; the limits live in one constant marked for P0b calibration', async (t) => {
  assert.equal(ORIGINALS_LIMITS.requestIntervalMs, 1000)
  assert.equal(ORIGINALS_LIMITS.requestsPerHour, 200)
  assert.equal(ORIGINALS_LIMITS.batchMax, 50)
  assert.equal(ORIGINALS_LIMITS.statusMax, 200)
  const shared = readFileSync(path.join(ROOT, 'src', 'shared', 'linejsOriginals.ts'), 'utf8')
  assert.ok(shared.includes('待 P0b 校正'), 'marked for P0b calibration')
  const items = new Map(['8301', '8302', '8303'].map((id) => [id, e2eePhoto(id)]))
  const h = await harness(t, items, { limits: { requestIntervalMs: 80 } })
  for (const id of items.keys()) await h.service.request(`i:${id}`)
  await h.service.whenIdle()
  const at = h.obs.requests.map((r) => r.at)
  assert.equal(at.length, 3)
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 78, `gap ${at[i] - at[i - 1]} ms`)
})

// ───────────────────────── A11 status never calls LINE ─────────────────────────

test('[A11][M11] status reads only local state: no outboundSession, no desktop LINE DB, no account read, no client call, no OBS request', async (t) => {
  const items = new Map([['8401', e2eePhoto('8401')], ['8402', video('8402')], ['8403', e2eePhoto('8403')]])
  const h = await harness(t, items, { obs: { respond: ({ path: p }) => (p.includes('8403') ? { status: 404 } : null) } })
  await h.service.request('i:8401')
  await h.service.request('i:8403')
  await h.service.whenIdle()
  const client = h.sessions.current.client
  const snap = () => ({ outbound: h.sessions.calls.outbound, desktop: h.counts.desktop, localMid: h.counts.localMid, header: client.calls.getHeader, requests: h.obs.requests.length })
  const before = snap()
  const st = await h.service.status(['i:8401', 'i:8402', 'i:8403', 'd:x', 'i:999', 'nonsense'])
  assert.deepEqual(st.items.map((i) => i.state), ['done', 'idle', 'expired', 'unsupported', 'unsupported', 'unsupported'])
  assert.deepEqual(snap(), before, 'status called nothing outside the process')
  // logged out: status still answers from local state without trying to restore the session
  h.sessions.install(null)
  const st2 = await h.service.status(['i:8401', 'i:8402'])
  assert.deepEqual(st2.items.map((i) => i.state), ['done', 'needs_login'])
  assert.equal(h.sessions.calls.outbound, before.outbound)
  await assert.rejects(h.service.status(new Array(201).fill('i:8401')), { code: 'INVALID_ARGS' })
})

// ───────────────────────── A12 LINE Cache ─────────────────────────

test('[A12] a photo LINE already has in its Cache is decrypted locally: no OBS request', async (t) => {
  const p = e2eePhoto('8501')
  const h = await harness(t, new Map([['8501', p]]), { localImage: ({ keyMaterial, fileSize }) => (keyMaterial === p.km.toString('base64') && fileSize === p.body.length ? { bytes: p.body, mime: 'image/png' } : null) })
  assert.deepEqual(await h.service.request('i:8501'), { msgId: 'i:8501', state: 'done' })
  assert.equal(h.obs.requests.length, 0)
  assert.equal(h.counts.localImage, 1)
  assert.equal(h.media.prepare('i:8501').ok, true)
  assert.equal(h.service.ledger.get(ledgerOwner(ME), stemOf('8501')).state, 'done')
})

// ───────────────────────── M2 attempts cap ─────────────────────────

test('[M2] transient failures are capped: after maxAttempts the item is failed_retry_exhausted, never retried automatically (batch / receive skip it), only by hand after the cooldown', async (t) => {
  let failing = true
  const p = e2eePhoto('8601')
  const h = await harness(t, new Map([['8601', p]]), {
    obs: { respond: () => (failing ? { status: 503 } : null) },
    stream: { maxAttempts: 1 },
    limits: { maxAttempts: 2, autoRetryDelayMs: 0, retryCooldownMs: 150 },
  })
  await h.service.request('i:8601')
  await until(async () => (await h.service.status(['i:8601'])).items[0].state === 'failed_retry_exhausted', 'retry exhausted', 4000)
  await h.service.whenIdle()
  await tick(80)
  assert.equal(h.obs.requests.length, 2, 'exactly maxAttempts calls (each with one request), then no automatic retry')
  const entry = h.service.ledger.get(ledgerOwner(ME), stemOf('8601'))
  assert.deepEqual([entry.state, entry.code, entry.attempts], ['failed', 'RETRY_EXHAUSTED', 2])
  const b = await h.service.batchStart(GROUP, ['i:8601'])
  assert.deepEqual(b.skipped.map((s) => s.state), ['failed_retry_exhausted'], 'a batch skips it')
  assert.deepEqual(await h.service.enqueue(['i:8601'], { origin: 'receive' }), { queued: 0, skipped: 1 }, 'the receive path skips it')
  const early = await h.service.request('i:8601')
  assert.equal(early.state, 'failed_retry_exhausted', 'a manual retry inside the cooldown is refused')
  assert.ok(early.retryAt > 0)
  assert.equal(h.obs.requests.length, 2)
  await tick(170)
  failing = false
  assert.equal((await h.service.request('i:8601')).state, 'queued', 'by hand after the cooldown')
  await h.service.whenIdle()
  assert.equal((await h.service.status(['i:8601'])).items[0].state, 'done')
  assert.equal(h.obs.requests.length, 3)
})

// ───────────────────────── M3 / M4 ledger ─────────────────────────

test('[M3] ledger total cap: past ledgerTotalMax the oldest done entries go first, then the oldest non-terminal ones; terminal and active entries stay', async (t) => {
  const h = await harness(t, new Map(), { limits: { ledgerTotalMax: 10 } })
  await sharedMediaLedger(h.dir).loaded
  const owner = ledgerOwner(ME)
  const L = h.service.ledger
  const stems = []
  const add = (n, outcome) => { for (let i = 0; i < n; i++) { const s = stemOf(`9${stems.length}`); stems.push(s); L.begin(owner, s, { origin: 'history', kind: 'IMAGE', fingerprint: '0123456789abcdef' }); if (outcome) L.record(owner, s, outcome) } }
  add(8, { status: 'done', bytes: 1, mime: 'image/png' })
  add(4, { status: 'failed', class: 'transient', code: 'OBS_NETWORK' })
  add(2, { status: 'failed', class: 'expired', code: 'OBS_HTTP_404' })
  assert.equal(L.entries.size, 14)
  assert.equal(h.service.enforceTotalCap(), 4)
  const left = [...L.entries.values()]
  assert.equal(left.length, 10)
  assert.equal(left.filter((e) => e.state === 'done').length, 4, 'the four oldest done went first')
  assert.ok(!left.some((e) => stems.slice(0, 4).includes(e.stem)))
  assert.equal(left.filter((e) => e.class === 'expired').length, 2)
  // no done left to drop: the oldest non-terminal go next, terminal negatives never
  for (const e of left.filter((x) => x.state === 'done')) L.remove(owner, e.stem)
  add(6, { status: 'failed', class: 'transient', code: 'OBS_NETWORK' })
  assert.equal(L.entries.size, 12)
  assert.equal(h.service.enforceTotalCap(), 2)
  assert.equal([...L.entries.values()].filter((e) => e.class === 'expired').length, 2)
  assert.equal(ORIGINALS_LIMITS.ledgerTotalMax, 50_000)
})

test('[M4] ledger flush cost (each flush rewrites the whole JSON) is measured, and the service coalesces flushes', async (t) => {
  const dir = await workdir(t)
  const ledger = new MediaLedger(dir)
  await ledger.load()
  const owner = ledgerOwner(ME)
  const N = 50_000
  for (let i = 0; i < N; i++) { const s = stemOf(`5${i}`); ledger.begin(owner, s, { origin: 'history', kind: 'IMAGE', fingerprint: '0123456789abcdef', sessionId: 'sess-1' }); ledger.record(owner, s, { status: 'done', bytes: 1234, mime: 'image/png' }) }
  const t0 = performance.now()
  await ledger.flush()
  const ms = performance.now() - t0
  const bytes = (await stat(path.join(dir, MEDIA_LEDGER_NAME))).size
  t.diagnostic(`ledger flush: ${N} entries, ${bytes} bytes (${(bytes / N).toFixed(0)} B/entry), ${ms.toFixed(0)} ms`)
  console.log(`[M4] ledger flush: ${N} entries, ${bytes} bytes (${(bytes / N).toFixed(0)} B/entry), ${ms.toFixed(0)} ms`)
  assert.ok(bytes / N < 450, 'a few hundred bytes per entry')
  // the service: many state changes in a burst → at most two flushes (one now, one trailing), everything on disk afterwards
  const items = new Map(['8701', '8702', '8703', '8704', '8705', '8706'].map((id) => [id, e2eePhoto(id)]))
  const h = await harness(t, items, { limits: { ledgerFlushMinIntervalMs: 60_000 } })
  for (const id of items.keys()) await h.service.request(`i:${id}`)
  await h.service.whenIdle()
  await tick(20)
  assert.ok(h.service.counters.flushes <= 1, `${h.service.counters.flushes} flushes for ${items.size * 3} ledger changes`)
  await h.service.flushNow()
  const onDisk = JSON.parse(await readFile(path.join(h.dir, 'linejs-downloads', MEDIA_LEDGER_NAME), 'utf8')).items
  assert.equal(onDisk.filter((e) => e.state === 'done').length, items.size)
})

// ───────────────────────── M5 single sink ─────────────────────────

test('[M5] one sink for the whole system: services on the same dataDir share the sink and the ledger, and src creates LineJsMediaSink in exactly one place', async (t) => {
  const dir = await workdir(t)
  const a = await harness(t, new Map(), { dir })
  const b = await harness(t, new Map(), { dir })
  assert.equal(a.service.sink, b.service.sink)
  assert.equal(a.service.sink, sharedMediaSink(dir))
  assert.equal(a.service.ledger, b.service.ledger)
  const hits = []
  const srcRoot = path.join(ROOT, 'src')
  for (const rel of readdirSync(srcRoot, { recursive: true })) {
    if (!/\.(ts|tsx|mjs|js)$/.test(rel)) continue
    const text = readFileSync(path.join(srcRoot, rel), 'utf8')
    const n = text.split('new LineJsMediaSink(').length - 1
    if (n) hits.push([rel.replaceAll('\\', '/'), n])
  }
  assert.deepEqual(hits, [['plugin/backend/linejsOriginals.ts', 1]])
})

// ───────────────────────── M8 resume pre-check ─────────────────────────

test('[M8] before a download (or a resume) starts, a stem that has landed meanwhile is simply done: no request, no part', async (t) => {
  let release
  const gate = new Promise((r) => { release = r })
  t.after(() => release())
  const v = video('8801', 400 * KIB + 1)
  const p = e2eePhoto('8802')
  const h = await harness(t, new Map([['8801', v], ['8802', p]]), { obs: { gate, gateAt: 128 * KIB } })
  await h.service.request('i:8801')
  await until(() => h.obs.requests.length === 1, 'the first download')
  assert.equal((await h.service.request('i:8802')).state, 'queued', 'waits behind the first in its lane')
  // the photo lands through another origin (e.g. outbound) while it waits
  await sharedMediaSink(h.dir).saveBytes({ stem: stemOf('8802'), kind: 'IMAGE', origin: 'outbound', chatId: GROUP }, p.body, 'image/png')
  release()
  await h.service.whenIdle()
  assert.equal((await h.service.status(['i:8802'])).items[0].state, 'done')
  assert.deepEqual(h.obs.requests.map((r) => r.path), [v.obs[0]], 'no request for the landed stem')
  assert.ok(h.logs.some((l) => l.includes('code=ALREADY_LANDED')))
  assert.deepEqual(await partsIn(h.dir), [])
})

// ───────────────────────── M12 receive interface ─────────────────────────

test('[M12] enqueue(origin:\'receive\') is the interface X2b will call: it queues with receive priority and the ledger records origin receive', async (t) => {
  const p = e2eePhoto('8901')
  const h = await harness(t, new Map([['8901', p]]))
  assert.deepEqual(await h.service.enqueue(['i:8901', 'd:zz'], { origin: 'receive' }), { queued: 1, skipped: 1 })
  await h.service.whenIdle()
  assert.equal((await h.service.status(['i:8901'])).items[0].state, 'done')
  assert.equal(h.service.ledger.get(ledgerOwner(ME), stemOf('8901')).origin, 'receive')
  await assert.rejects(h.service.enqueue(['i:8901'], { origin: 'history' }), { code: 'INVALID_ARGS' })
  // without a session the receive path queues nothing (and asks no one to log in)
  const h2 = await harness(t, new Map([['8902', e2eePhoto('8902')]]), { sessions: fakeSessions(null) })
  assert.deepEqual(await h2.service.enqueue(['i:8902'], { origin: 'receive' }), { queued: 0, skipped: 1 })
})

// ───────────────────────── dispatcher wiring ─────────────────────────

test('[A13] dispatcher: linejsMedia.original.* ride the existing linejsMedia method group (no new group), are known paths, validate their arguments, and answer unavailable without the service', async (t) => {
  assert.deepEqual([...LINEJS_ORIGINALS_PATHS], ['linejsMedia.original.request', 'linejsMedia.original.status', 'linejsMedia.original.cancel', 'linejsMedia.original.batchStart', 'linejsMedia.original.batchCancel'])
  for (const p of LINEJS_ORIGINALS_PATHS) {
    assert.equal(backendMethodFor(p), 'linejsMedia')
    assert.ok(SUPPORTED_API_PATHS.includes(p), `${p} supported`)
    assert.ok(INTERNAL_API_PATHS.includes(p), `${p} internal switch case`)
  }
  assert.equal(BACKEND_METHOD_GROUPS.includes('linejsMedia.original'), false)
  const p = e2eePhoto('9901')
  const h = await harness(t, new Map([['9901', p]]))
  const hub = new EventHub()
  const d = new Dispatcher({ getApi: () => ({}), hub, queue: {}, info: () => ({}), linejsOriginals: h.service })
  const none = new Dispatcher({ getApi: () => ({}), hub, queue: {}, info: () => ({}) })
  t.after(() => { d.dispose(); none.dispose(); hub.dispose() })
  const call = (path, args, dispatcher = d) => dispatcher.call('linejsMedia', { path, args })
  assert.equal((await call('linejsMedia.original.request', [{ msgId: 'i:9901' }])).ok, true)
  await h.service.whenIdle()
  const st = await call('linejsMedia.original.status', [{ msgIds: ['i:9901'] }])
  assert.equal(st.ok, true)
  assert.equal(st.value.items[0].state, 'done')
  assert.equal((await call('linejsMedia.original.status', [{ msgIds: new Array(201).fill('i:9901') }])).code, 'invalid_args')
  assert.equal((await call('linejsMedia.original.request', [{ msgId: 'i:9901', extra: 1 }])).code, 'invalid_args')
  assert.equal((await call('linejsMedia.original.request', ['i:9901'])).code, 'invalid_args')
  const started = await call('linejsMedia.original.batchStart', [{ chatId: GROUP, msgIds: ['i:9901'] }])
  assert.equal(started.ok, true)
  assert.equal((await call('linejsMedia.original.batchCancel', [{ batchId: started.value.batchId }])).ok, true)
  assert.equal((await call('linejsMedia.original.cancel', [{ msgId: 'i:9901' }])).ok, true)
  assert.equal((await d.call('linejsOutbound', { path: 'linejsMedia.original.status', args: [{ msgIds: [] }] })).code, 'method_mismatch')
  for (const path of LINEJS_ORIGINALS_PATHS) assert.equal((await call(path, [{}], none)).code, 'linejs_originals_unavailable', path)
})

// ───────────────────────── fix1（review-x6 F-1…F-8、I-2、I-4、I-5、I-6；Manager 裁決 ADJ-X6-02） ─────────────────────────

const sha256 = (b) => createHash('sha256').update(b).digest('hex')
const throttleFile = (dir) => path.join(dir, 'linejs-downloads', 'originals-throttle.json')
const ledgerFile = (dir) => path.join(dir, 'linejs-downloads', MEDIA_LEDGER_NAME)

test('[F-1] single-flight across the two lanes: a single click and a batch admit the same video at the same time (either desktop read slow) → one job, one OBS request, the file lands once', async (t) => {
  for (const slow of [1, 2]) {
    let release
    const gate = new Promise((r) => { release = r })
    t.after(() => release())
    const id = `920${slow}`
    const v = video(id, 400 * KIB + 3)
    const h = await harness(t, new Map([[id, v]]), { obs: { gate, gateAt: 64 * KIB }, desktopDelay: (n) => (n === slow ? 150 : 0) })
    let maxBusy = 0
    const sampler = setInterval(() => { const q = h.service.queueState(); maxBusy = Math.max(maxBusy, q.running, q.jobs) }, 1)
    const [single, batch] = await Promise.all([h.service.request(`i:${id}`), h.service.batchStart(GROUP, [`i:${id}`])])
    await tick(250)
    clearInterval(sampler)
    assert.ok(['queued', 'running'].includes(single.state), JSON.stringify(single))
    assert.deepEqual(batch.accepted, [`i:${id}`], 'the batch joins the same work')
    assert.equal(maxBusy, 1, `slow read #${slow}: one job for one stem`)
    assert.equal(h.obs.requests.length, 1, `slow read #${slow}: one OBS request`)
    release()
    await h.service.whenIdle()
    assert.equal(h.obs.requests.length, 1)
    assert.deepEqual(await readFile(path.join(h.dir, SAVED_MEDIA_DIR, `${stemOf(id)}.mp4`)), v.body)
    assert.equal((await h.service.status([`i:${id}`])).items[0].state, 'done')
    assert.deepEqual(await partsIn(h.dir), [])
  }
})

test('[F-2] a batch is not finished while it is still admitting: it stays running, a second batch is refused, batchCancel cancels the video and keeps its part', async (t) => {
  let release
  const gate = new Promise((r) => { release = r })
  t.after(() => release())
  const p = e2eePhoto('9301')
  const v = video('9302', 400 * KIB + 3)
  const v2 = video('9303')
  const h = await harness(t, new Map([['9301', p], ['9302', v], ['9303', v2]]), { obs: { gate, gateRequest: 2, gateAt: 192 * KIB }, desktopDelay: () => 150 })
  const started = h.service.batchStart(GROUP, ['i:9301', 'i:9302'])
  // the photo (no desktop read) is done while the video's desktop read is still slow
  await until(async () => (await h.service.status(['i:9301'])).items[0].state === 'done', 'the photo')
  const during = (await h.service.status(['i:9301'])).batch
  assert.equal(during.state, 'running', 'not finished during the admission')
  assert.equal((await h.service.batchStart(GROUP, ['i:9303'])).error, 'BATCH_ACTIVE', 'one batch at a time, also while it is admitting')
  const out = await started
  assert.deepEqual(out.accepted, ['i:9301', 'i:9302'])
  await until(() => h.obs.requests.length === 2, 'the video request')
  await tick(30)
  const view = (await h.service.status(['i:9302'])).batch
  assert.deepEqual([view.state, view.total, view.done, view.remaining], ['running', 2, 1, 1])
  assert.equal((await h.service.batchStart(GROUP, ['i:9303'])).error, 'BATCH_ACTIVE')
  assert.deepEqual(await h.service.batchCancel(out.batchId), { cancelled: 1 })
  await h.service.whenIdle()
  release()
  await tick(30)
  const st = await h.service.status(['i:9302'])
  assert.equal(st.items[0].state, 'idle')
  assert.equal(st.batch.state, 'cancelled')
  assert.equal(h.obs.requests.length, 2, 'the video was not sent again')
  assert.equal((await partsIn(h.dir)).length, 1, 'the aborted video kept its part')
})

test('[F-2] batchCancel while the batch is still admitting stops the admission: nothing is queued or sent', async (t) => {
  const v = video('9311')
  const p = e2eePhoto('9312')
  const h = await harness(t, new Map([['9311', v], ['9312', p]]), { desktopDelay: () => 150 })
  const started = h.service.batchStart(GROUP, ['i:9311', 'i:9312'])
  await tick(30)
  const view = (await h.service.status([])).batch
  assert.equal(view.state, 'running')
  assert.deepEqual(await h.service.batchCancel(view.batchId), { cancelled: 0 })
  const out = await started
  await h.service.whenIdle()
  assert.equal(h.obs.requests.length, 0)
  assert.deepEqual(out.accepted, [])
  assert.deepEqual(out.skipped.map((s) => [s.msgId, s.code]), [['i:9311', 'BATCH_CANCELLED'], ['i:9312', 'BATCH_CANCELLED']])
  assert.equal(h.service.queueState().jobs, 0)
  assert.equal((await h.service.status([])).batch.state, 'cancelled')
})

test('[F-3] the previous account\'s parked work + a 401 on the new account\'s session: no busy loop, and the previous account\'s work goes back to idle', async (t) => {
  let mid = ME
  const sessions = fakeSessions(makeSession('sess-1', ME))
  const a = e2eePhoto('9401')
  const b = e2eePhoto('9402')
  const h = await harness(t, new Map([['9401', a], ['9402', b]]), { sessions, localMidFn: () => mid, obs: { respond: () => ({ status: 401 }) } })
  await h.service.request('i:9401')
  await until(async () => (await h.service.status(['i:9401'])).items[0].state === 'paused', 'the 401 pause of sess-1')
  // the desktop and LINEJS both move to another account
  mid = FRIEND
  sessions.install(makeSession('sess-2', FRIEND))
  await tick(30)
  assert.equal((await h.service.request('i:9402')).state, 'queued', 'the new session and the desktop agree (the account cache was dropped with the old session)')
  await until(() => h.obs.requests.length === 2, 'the 401 of sess-2')
  await tick(30)
  const before = { isCurrent: sessions.calls.isCurrent, logs: h.logs.length }
  await tick(300)
  const loops = sessions.calls.isCurrent - before.isCurrent
  assert.ok(loops <= 5, `${loops} run() iterations in 300 ms`)
  assert.ok(h.logs.length - before.logs <= 5, `${h.logs.length - before.logs} log lines in 300 ms`)
  assert.equal(h.obs.requests.length, 2)
  assert.equal(h.service.queueState().jobs, 1, 'only the current account\'s work is left')
  const old = h.service.ledger.get(ledgerOwner(ME), stemOf('9401'))
  assert.ok(!old || !['queued', 'running'].includes(old.state), JSON.stringify(old))
  const st = await h.service.status(['i:9401', 'i:9402'])
  assert.deepEqual(st.items.map((i) => [i.state, i.code]), [['idle', undefined], ['paused', 'auth']])
  assert.equal(st.paused?.reason, 'auth')
})

test('[F-3][F-5] a session of another account, or a logout, aborts the running download (part kept) and drops the queued work; nothing restarts by itself', async (t) => {
  for (const next of ['other-account', 'logout']) {
    let release
    const gate = new Promise((r) => { release = r })
    t.after(() => release())
    let mid = ME
    const sessions = fakeSessions(makeSession('sess-1', ME))
    const id = next === 'logout' ? '9501' : '9511'
    const pid = next === 'logout' ? '9502' : '9512'
    const v = video(id, 400 * KIB + 3)
    const p = e2eePhoto(pid)
    const h = await harness(t, new Map([[id, v], [pid, p]]), { sessions, localMidFn: () => mid, obs: { gate, gateAt: 192 * KIB } })
    await h.service.request(`i:${id}`)
    await until(() => h.obs.requests.length === 1, 'the video request')
    assert.equal((await h.service.request(`i:${pid}`)).state, 'queued', 'waits behind the video in its lane')
    if (next === 'logout') sessions.install(null)
    else { mid = FRIEND; sessions.install(makeSession('sess-2', FRIEND)) }
    await until(() => h.service.queueState().jobs === 0, `${next}: every job of the previous account is gone`, 4000)
    release()
    await tick(50)
    assert.equal(h.obs.requests.length, 1, `${next}: nothing more was sent`)
    const parts = await partsIn(h.dir)
    assert.equal(parts.length, 1, `${next}: the aborted download kept its part`)
    const entry = h.service.ledger.get(ledgerOwner(ME), stemOf(id))
    assert.deepEqual([entry.state, entry.partName], ['paused', parts[0]])
    assert.equal(await readFile(path.join(h.dir, SAVED_MEDIA_DIR, `${stemOf(id)}.mp4`)).catch(() => null), null, `${next}: the video did not land`)
    // the same account comes back: both are idle, nothing is sent until the user asks again
    mid = ME
    sessions.install(makeSession('sess-3', ME))
    await tick(50)
    assert.equal(h.obs.requests.length, 1)
    assert.deepEqual((await h.service.status([`i:${id}`, `i:${pid}`])).items.map((i) => i.state), ['idle', 'idle'])
  }
})

test('[F-4] the account check right before sending is never cached: a desktop account switch (or an unreadable account) inside the 60 s admission cache is admitted but never sent; after the TTL the admission itself refuses', async (t) => {
  let now = 1_800_000_000_000
  let mid = ME
  const ids = ['9601', '9602', '9603', '9604', '9605', '9606']
  const h = await harness(t, new Map(ids.map((id) => [id, e2eePhoto(id)])), { now: () => now, localMidFn: () => mid })
  assert.equal((await h.service.request('i:9601')).state, 'queued')
  await h.service.whenIdle()
  assert.equal(h.obs.requests.length, 1)
  // the desktop switches inside the cache: admitted from the cache, but the send-time read refuses it
  mid = FRIEND
  now += 10_000
  assert.equal((await h.service.request('i:9602')).state, 'queued', 'admitted from the 60 s cache')
  await h.service.whenIdle()
  assert.equal(h.obs.requests.length, 1, 'the send-time check read the desktop account again: not sent')
  assert.equal((await h.service.status(['i:9602'])).items[0].state, 'account_mismatch')
  // back to the same account, past the TTL: the admission reads it again and lets it through
  mid = ME
  now += 60_001
  assert.equal((await h.service.request('i:9603')).state, 'queued', 'after the TTL the admission reads the account again')
  await h.service.whenIdle()
  assert.equal(h.obs.requests.length, 2)
  // unreadable inside the cache: admitted, not sent (fail-closed at send time); review-x6-r2 N-3: held and tried again, not dropped
  mid = null
  now += 10_000
  assert.equal((await h.service.request('i:9604')).state, 'queued', 'admitted from the cache')
  await until(() => h.logs.some((l) => l.includes('code=ACCOUNT_UNVERIFIED')), 'the send-time account check')
  assert.equal(h.obs.requests.length, 2, 'an unreadable desktop account at send time fails closed')
  mid = ME
  now += 60_001
  h.service.kick()
  await h.service.whenIdle()
  assert.equal(h.obs.requests.length, 3, 'sent once the desktop account reads again')
  now += 1_000
  assert.equal((await h.service.request('i:9605')).state, 'queued')
  await h.service.whenIdle()
  assert.equal(h.obs.requests.length, 4)
  // a switch after the TTL: the admission itself refuses it
  mid = FRIEND
  now += 60_001
  assert.deepEqual(await h.service.request('i:9606'), { msgId: 'i:9606', state: 'account_mismatch', code: 'ACCOUNT_MISMATCH' })
  assert.equal(h.obs.requests.length, 4)
})

test('[I-2] request compares the accounts before outboundSession(): an unreadable desktop account, or an installed session of another account, never asks the session port (no token login)', async (t) => {
  const h = await harness(t, new Map([['9701', e2eePhoto('9701')]]), { localMid: null })
  assert.deepEqual(await h.service.request('i:9701'), { msgId: 'i:9701', state: 'account_mismatch', code: 'ACCOUNT_UNVERIFIED' })
  assert.equal(h.sessions.calls.outbound, 0, 'the session port was not asked (no restore, no token login)')
  const sessions = fakeSessions(null)
  const h2 = await harness(t, new Map([['9702', e2eePhoto('9702')]]), { sessions, localMid: FRIEND })
  sessions.install(makeSession('sess-1', ME))
  await until(() => sessions.calls.outbound === 1, 'the installed session is noted')
  await tick(5)
  assert.deepEqual(await h2.service.request('i:9702'), { msgId: 'i:9702', state: 'account_mismatch', code: 'ACCOUNT_MISMATCH' })
  assert.equal(sessions.calls.outbound, 1, 'an installed session of another account is compared without asking the port again')
  assert.equal(h.obs.requests.length + h2.obs.requests.length, 0)
})

test('[F-6] the hourly budget survives a restart (a small file next to the ledger): the capped item stays paused and nothing is sent', async (t) => {
  const items = new Map(['9801', '9802', '9803'].map((id) => [id, e2eePhoto(id)]))
  const dir = await workdir(t)
  const h1 = await harness(t, items, { dir, limits: { requestsPerHour: 2 } })
  for (const id of items.keys()) await h1.service.request(`i:${id}`)
  await until(async () => (await h1.service.status(['i:9803'])).items[0].code === 'hourly_limit', 'the hourly pause')
  assert.equal(h1.obs.requests.length, 2)
  await h1.service.dispose()
  const saved = JSON.parse(await readFile(throttleFile(dir), 'utf8'))
  assert.equal(saved.times.length, 2, 'both request times are on disk')
  releaseSharedLedger(dir)
  const h2 = await harness(t, items, { dir, limits: { requestsPerHour: 2 } })
  const v = await h2.service.request('i:9803')
  await tick(80)
  h2.service.kick()
  await tick(20)
  assert.deepEqual([v.state, v.code], ['paused', 'hourly_limit'])
  assert.equal(h2.obs.requests.length, 0, 'still capped after the restart')
  assert.equal((await h2.service.status(['i:9803'])).paused?.reason, 'hourly_limit')
})

test('[F-6] a 429 pause survives a restart: from the throttle file, and from the ledger\'s rate_limited nextAt alone', async (t) => {
  for (const keepThrottle of [true, false]) {
    const id = keepThrottle ? '9811' : '9812'
    const p = e2eePhoto(id)
    const dir = await workdir(t)
    const h1 = await harness(t, new Map([[id, p]]), { dir, obs: { respond: () => ({ status: 429, headers: { 'retry-after': '600' } }) } })
    await h1.service.request(`i:${id}`)
    await until(async () => (await h1.service.status([`i:${id}`])).items[0].state === 'paused', 'the 429 pause')
    await h1.service.dispose()
    const onDisk = JSON.parse(await readFile(ledgerFile(dir), 'utf8')).items[0]
    assert.equal(onDisk.class, 'rate_limited')
    assert.ok(onDisk.nextAt - Date.now() > 500_000)
    if (keepThrottle) assert.ok(JSON.parse(await readFile(throttleFile(dir), 'utf8')).rateLimitedUntil - Date.now() > 500_000, 'the pause end is on disk')
    else await unlink(throttleFile(dir))
    releaseSharedLedger(dir)
    const h2 = await harness(t, new Map([[id, p]]), { dir })
    const v = await h2.service.request(`i:${id}`)
    await tick(60)
    h2.service.kick()
    await tick(20)
    assert.deepEqual([v.state, v.code], ['paused', 'rate_limited'], `keepThrottle=${keepThrottle}`)
    assert.equal(h2.obs.requests.length, 0, `keepThrottle=${keepThrottle}: nothing sent after the restart`)
    const st = await h2.service.status([`i:${id}`])
    assert.equal(st.paused?.reason, 'rate_limited')
    assert.ok(st.paused.untilMs - Date.now() > 500_000)
    assert.ok(h2.limiter.state().pausedMs > 500_000, 'the shared OBS limiter is paused again too')
  }
})

test('[F-6] a damaged throttle file starts empty and logs a code only; the file is written atomically (no temp file left)', async (t) => {
  const dir = await workdir(t)
  await mkdir(path.join(dir, 'linejs-downloads'), { recursive: true })
  await writeFile(throttleFile(dir), '{"version":1,"times":[1,2', 'utf8')
  const p = e2eePhoto('9821')
  const h = await harness(t, new Map([['9821', p]]), { dir })
  await h.service.request('i:9821')
  await h.service.whenIdle()
  assert.equal(h.obs.requests.length, 1, 'started empty')
  const line = h.logs.find((l) => l.includes('THROTTLE_CORRUPT'))
  assert.ok(line, 'one log line with the code')
  assert.equal(/[\\/]|linejs-downloads|throttle\.json/.test(line), false, line)
  await h.service.dispose()
  const saved = JSON.parse(await readFile(throttleFile(dir), 'utf8'))
  assert.deepEqual([saved.version, saved.times.length], [1, 1])
  assert.deepEqual((await readdir(path.join(dir, 'linejs-downloads'))).filter((n) => n.startsWith('originals-throttle.json.')), [])
})

test('[F-7] status never writes the ledger: no flush, the file keeps its bytes and mtime', async (t) => {
  const items = new Map([['9911', e2eePhoto('9911')], ['9912', e2eePhoto('9912')]])
  const h = await harness(t, items, { obs: { respond: ({ path: p }) => (p.includes('9912') ? { status: 404 } : null) }, limits: { ledgerFlushMinIntervalMs: 5 } })
  await h.service.request('i:9911')
  await h.service.request('i:9912')
  await h.service.whenIdle()
  await tick(30)
  await h.service.flushNow()
  // a trailing flush scheduled earlier may still be writing: wait for the ledger's write chain before the snapshot
  await h.service.ledger.flushChain
  await tick(20)
  const snap = async () => ({ flushes: h.service.counters.flushes, sha: sha256(await readFile(ledgerFile(h.dir))), mtime: (await stat(ledgerFile(h.dir))).mtimeMs })
  const before = await snap()
  for (let i = 0; i < 3; i++) await h.service.status(['i:9911', 'i:9912', 'i:1'])
  await tick(40)
  assert.deepEqual(await snap(), before)
})

test('[F-7][F-8] desktop row reader: one parameterized statement, one open reused across reads, released when idle or when the snapshot asks to yield; a miss on a reused connection opens again once', async (t) => {
  const { createDesktopRowReader, DESKTOP_ROW_SQL } = Originals
  assert.equal(typeof createDesktopRowReader, 'function')
  assert.equal(DESKTOP_ROW_SQL, 'SELECT _id,_contentType,_contentMetadata,_contentInfo FROM _message WHERE _chatId=? AND _createdTime=?')
  const prepared = []
  const calls = []
  let opens = 0
  let closes = 0
  let yieldNow = false
  const table = new Map([[`${GROUP}|${TS}`, [{ _id: '1', _contentType: 2, _contentMetadata: null, _contentInfo: null }]]])
  const open = async () => {
    opens++
    await tick(5)
    return { con: { prepare: (sql) => { prepared.push(sql); return { all: (...args) => { calls.push(args); return table.get(`${args[0]}|${args[1]}`) ?? [] } } } }, cleanup: () => { closes++ }, shouldYield: () => yieldNow }
  }
  const reader = createDesktopRowReader(open, { idleMs: 40 })
  t.after(() => reader.close())
  for (let i = 0; i < 5; i++) assert.equal((await reader.rows(GROUP, TS)).length, 1)
  assert.equal(opens, 1, 'one open for five reads')
  assert.ok(prepared.length >= 1 && prepared.every((sql) => sql === DESKTOP_ROW_SQL), 'only the parameterized statement is prepared')
  assert.deepEqual(calls, new Array(5).fill([GROUP, TS]), 'the values travel as parameters')
  await tick(90)
  assert.equal(closes, 1, 'released after the idle time')
  const both = await Promise.all([reader.rows(GROUP, TS), reader.rows(GROUP, TS)])
  assert.deepEqual(both.map((r) => r.length), [1, 1])
  assert.equal(opens, 2, 'two concurrent reads share one open')
  yieldNow = true
  await reader.rows(GROUP, TS)
  assert.deepEqual([opens, closes], [3, 3], 'a snapshot that asks to yield is released before the read and right after it')
  yieldNow = false
  await reader.rows(GROUP, TS)
  assert.deepEqual(await reader.rows(GROUP, TS + 1), [])
  assert.equal(opens, 5, 'a miss on a reused connection is tried once more on a fresh one')
  reader.close()
  assert.equal(closes, opens, 'every open was closed')
  assert.ok(Number.isFinite(reader.stats().lastQueryMs) && reader.stats().queries >= 8)
  assert.ok(prepared.every((sql) => sql === DESKTOP_ROW_SQL))
})

test('[F-8] measurement: one desktop row query on a synthetic _message table (100 000 rows; without and with an index on _chatId,_createdTime), the open reused by the reader', async (t) => {
  const { createDesktopRowReader } = Originals
  assert.equal(typeof createDesktopRowReader, 'function')
  const { DatabaseSync } = await import('node:sqlite')
  const dir = await workdir(t)
  const file = path.join(dir, 'synthetic-line.db')
  const N = 100_000
  const CHATS = 200
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE _message (_id INTEGER, _chatId TEXT, _createdTime INTEGER, _contentType INTEGER, _contentMetadata TEXT, _contentInfo TEXT)')
  const ins = db.prepare('INSERT INTO _message VALUES (?, ?, ?, ?, ?, ?)')
  db.exec('BEGIN')
  for (let i = 0; i < N; i++) ins.run(600000 + i, `c${String(i % CHATS).padStart(32, '0')}`, TS + i * 1000, i % 3 === 0 ? 2 : 1, '{"OID":"x","SID":"emv"}', '{"keyMaterial":"k"}')
  db.exec('COMMIT')
  db.close()
  const measure = async () => {
    let opens = 0
    let openMs = 0
    const open = async () => { const t0 = performance.now(); opens++; const con = new DatabaseSync(file, { readOnly: true }); openMs += performance.now() - t0; return { con, cleanup: () => con.close(), shouldYield: () => false } }
    const reader = createDesktopRowReader(open, { idleMs: 60_000 })
    const ms = []
    for (let k = 0; k < 20; k++) {
      const i = (k * 4999) % N
      const t0 = performance.now()
      const rows = await reader.rows(`c${String(i % CHATS).padStart(32, '0')}`, TS + i * 1000)
      ms.push(performance.now() - t0)
      assert.equal(rows.length, 1)
      assert.equal(Number(rows[0]._id), 600000 + i)
    }
    reader.close()
    const sorted = [...ms].sort((a, b) => a - b)
    return { opens, openMs: Number(openMs.toFixed(2)), firstMs: Number(ms[0].toFixed(2)), medianMs: Number(sorted[10].toFixed(2)), maxMs: Number(sorted[19].toFixed(2)), lastQueryMs: reader.stats().lastQueryMs }
  }
  const noIndex = await measure()
  const db2 = new DatabaseSync(file)
  db2.exec('CREATE INDEX ix_chat_time ON _message(_chatId, _createdTime)')
  db2.close()
  const withIndex = await measure()
  const line = `[F-8] desktop row query, synthetic unencrypted _message ${N} rows / ${CHATS} chats (node:sqlite; the real LINE DB is SQLCipher and its open also derives the key): no index ${JSON.stringify(noIndex)}; index(_chatId,_createdTime) ${JSON.stringify(withIndex)}`
  t.diagnostic(line)
  console.log(line)
  assert.equal(noIndex.opens, 1, 'one open for 20 reads')
  assert.equal(withIndex.opens, 1)
})

test('[I-4] the total cap never evicts an entry that holds a part, nor a RETRY_EXHAUSTED one (its manual-only meaning would be lost)', async (t) => {
  const h = await harness(t, new Map(), { limits: { ledgerTotalMax: 4 } })
  await sharedMediaLedger(h.dir).loaded
  const owner = ledgerOwner(ME)
  const L = h.service.ledger
  const mk = (n) => stemOf(`96${n}`)
  const begin = (n) => L.begin(owner, mk(n), { origin: 'history', kind: 'VIDEO', fingerprint: '0123456789abcdef' })
  // oldest first: two with a part, one RETRY_EXHAUSTED, then three plain transient failures
  for (const n of [1, 2]) { begin(n); L.running(owner, mk(n), { partName: `.${mk(n)}.${randomUUID()}.part` }); L.record(owner, mk(n), { status: 'paused', class: 'transient', code: 'ABORTED' }) }
  begin(3); L.record(owner, mk(3), { status: 'failed', class: 'transient', code: 'OBS_NETWORK' }); L.put({ ...L.get(owner, mk(3)), code: 'RETRY_EXHAUSTED' })
  for (const n of [4, 5, 6]) { begin(n); L.record(owner, mk(n), { status: 'failed', class: 'transient', code: 'OBS_NETWORK' }) }
  assert.equal(L.entries.size, 6)
  assert.equal(h.service.enforceTotalCap(), 2)
  const left = new Set([...L.entries.values()].map((e) => e.stem))
  for (const n of [1, 2, 3, 6]) assert.ok(left.has(mk(n)), `entry ${n} stays`)
  // only protected entries over the cap: none is evicted (the cap is exceeded and said so with a code)
  const h2 = await harness(t, new Map(), { limits: { ledgerTotalMax: 2 } })
  await sharedMediaLedger(h2.dir).loaded
  const L2 = h2.service.ledger
  for (const n of [1, 2]) { L2.begin(owner, mk(n), { origin: 'history', kind: 'VIDEO', fingerprint: '0123456789abcdef' }); L2.running(owner, mk(n), { partName: `.${mk(n)}.${randomUUID()}.part` }) }
  L2.begin(owner, mk(3), { origin: 'history', kind: 'IMAGE', fingerprint: '0123456789abcdef' }); L2.record(owner, mk(3), { status: 'failed', class: 'transient', code: 'OBS_NETWORK' }); L2.put({ ...L2.get(owner, mk(3)), code: 'RETRY_EXHAUSTED' })
  assert.equal(h2.service.enforceTotalCap(), 0)
  assert.equal(L2.entries.size, 3)
  assert.ok(h2.logs.some((l) => l.includes('code=CAP_EXCEEDED')))
})

test('[I-5] a batch never takes over the user\'s own click: no batchId on it, batchCancel leaves it running — also when the click comes after the batch', async (t) => {
  for (const clickFirst of [true, false]) {
    let release
    const gate = new Promise((r) => { release = r })
    t.after(() => release())
    const id = clickFirst ? '9951' : '9952'
    const v = video(id, 400 * KIB + 3)
    const h = await harness(t, new Map([[id, v]]), { obs: { gate, gateAt: 64 * KIB } })
    let b
    if (clickFirst) {
      await h.service.request(`i:${id}`)
      await until(() => h.obs.requests.length === 1, 'the clicked video')
      b = await h.service.batchStart(GROUP, [`i:${id}`])
      assert.deepEqual(b.accepted, [`i:${id}`])
      assert.equal((await h.service.status([`i:${id}`])).items[0].batchId, undefined, 'the clicked work carries no batchId')
    } else {
      b = await h.service.batchStart(GROUP, [`i:${id}`])
      await until(() => h.obs.requests.length === 1, 'the batch video')
      assert.equal((await h.service.request(`i:${id}`)).state, 'running')
    }
    assert.deepEqual(await h.service.batchCancel(b.batchId), { cancelled: 0 }, `clickFirst=${clickFirst}: the user's click is not the batch's to cancel`)
    release()
    await h.service.whenIdle()
    assert.equal((await h.service.status([`i:${id}`])).items[0].state, 'done', `clickFirst=${clickFirst}`)
    assert.equal(h.obs.requests.length, 1)
  }
})

test('[I-6] a failed ledger flush is tried again later with a backoff, without any further change', async (t) => {
  const p = e2eePhoto('9961')
  const h = await harness(t, new Map([['9961', p]]), { limits: { ledgerFlushMinIntervalMs: 20 } })
  await sharedMediaLedger(h.dir).loaded
  const L = h.service.ledger
  const real = L.flush.bind(L)
  let failing = true
  let failed = 0
  L.flush = () => { if (!failing) return real(); failed++; return Promise.reject(Object.assign(new Error('disk'), { code: 'EIO' })) }
  t.after(() => { delete L.flush })
  await h.service.request('i:9961')
  await h.service.whenIdle()
  await until(() => failed >= 1, 'a failed flush')
  await tick(80)
  failing = false
  const before = h.service.counters.flushes
  await until(async () => { try { return JSON.parse(await readFile(ledgerFile(h.dir), 'utf8')).items.some((e) => e.state === 'done') } catch { return false } }, 'the retried flush', 3000)
  assert.ok(h.service.counters.flushes > before)
  assert.ok(h.logs.some((l) => l.includes('code=FLUSH_FAILED_EIO')))
})

// ───────────────────────── review-x6-r2（X67 補合）：N-1～N-4、節制檔原子寫入（M6） ─────────────────────────

test('[N-1] cancel() while the stem is still being admitted (desktop read 150 ms): the cancel wins — 0 OBS requests, no job, no ledger entry; a later click still downloads it', async (t) => {
  const v = video('7711')
  const h = await harness(t, new Map([['7711', v]]), { desktopDelay: () => 150 })
  const req = h.service.request('i:7711')
  await tick(30)
  const c = await h.service.cancel('i:7711')
  assert.equal(c.state, 'idle', 'nothing is queued yet when the cancel answers')
  assert.deepEqual(await req, { msgId: 'i:7711', state: 'idle', code: 'ABORTED' })
  await tick(100)
  await h.service.whenIdle()
  assert.equal(h.obs.requests.length, 0, 'a cancel during the admission is not lost')
  assert.equal(h.service.queueState().jobs, 0)
  assert.equal(h.service.ledger.get(ledgerOwner(ME), stemOf('7711')), null, 'the entry begun during the admission is undone')
  assert.equal((await h.service.status(['i:7711'])).items[0].state, 'idle')
  assert.ok(h.logs.some((l) => /originals_job kind=VIDEO origin=history state=idle code=ABORTED/.test(l)))
  // the mark does not outlive that admission: the next click downloads the video
  assert.equal((await h.service.request('i:7711')).state, 'queued')
  await h.service.whenIdle()
  assert.equal(h.obs.requests.length, 1)
  assert.equal((await h.service.status(['i:7711'])).items[0].state, 'done')
})

function misuseDesktopSource(table, state) {
  // a source that behaves like a closed SQLite connection after cleanup (statement.all throws SQLITE_MISUSE) and only sees rows up to its snapshot epoch
  const epoch = state.epoch
  let closed = false
  state.opens++
  return {
    con: { prepare: () => ({ all: (chatId, ts) => { if (closed) throw Object.assign(new Error('The database connection is not open'), { code: 'SQLITE_MISUSE' }); state.queries++; return (table.get(`${chatId}|${ts}`) ?? []).filter((r) => r.epoch <= epoch) } }) },
    cleanup: () => { closed = true; state.cleanups++ },
    shouldYield: () => state.yieldNow,
  }
}

test('[N-2] desktop row reader: two concurrent reads — one misses on the reused connection (or the snapshot asks to yield) and lets it go; the other never hits SQLITE_MISUSE, and every connection is closed exactly once', async (t) => {
  const { createDesktopRowReader } = Originals
  // (a) a miss on the reused connection (a newer row) retires it while the other read still holds it
  const a = { epoch: 1, opens: 0, cleanups: 0, queries: 0, yieldNow: false }
  const tableA = new Map([[`${GROUP}|${TS}`, [{ _id: '1', epoch: 1 }]], [`${GROUP}|${TS + 1}`, [{ _id: '2', epoch: 2 }]]])
  const readerA = createDesktopRowReader(async () => misuseDesktopSource(tableA, a), { idleMs: 1000 })
  t.after(() => readerA.close())
  assert.equal((await readerA.rows(GROUP, TS)).length, 1) // warm: the connection has been used once
  a.epoch = 2 // a newer snapshot exists; the held connection still sees epoch 1
  const resultsA = await Promise.allSettled([readerA.rows(GROUP, TS + 1), readerA.rows(GROUP, TS)])
  assert.deepEqual(resultsA.map((r) => (r.status === 'fulfilled' ? r.value.length : r.reason?.code)), [1, 1], 'no read failed on a connection released by the other read')
  // (b) the snapshot asks to yield while both reads share the connection
  const b = { epoch: 1, opens: 0, cleanups: 0, queries: 0, yieldNow: false }
  const tableB = new Map([[`${GROUP}|${TS}`, [{ _id: '1', epoch: 1 }]]])
  const readerB = createDesktopRowReader(async () => misuseDesktopSource(tableB, b), { idleMs: 1000 })
  t.after(() => readerB.close())
  assert.equal((await readerB.rows(GROUP, TS)).length, 1)
  const p1 = readerB.rows(GROUP, TS)
  const p2 = readerB.rows(GROUP, TS)
  b.yieldNow = true // after both took the held connection, before their queries run
  const resultsB = await Promise.allSettled([p1, p2])
  assert.deepEqual(resultsB.map((r) => (r.status === 'fulfilled' ? r.value.length : r.reason?.code)), [1, 1])
  readerA.close()
  readerB.close()
  assert.equal(a.cleanups, a.opens, 'every connection (a) was closed, once')
  assert.equal(b.cleanups, b.opens, 'every connection (b) was closed, once')
})

test('[N-3] the desktop account cannot be read right before sending: the job is held and tried again (log ACCOUNT_UNVERIFIED, never ACCOUNT_MISMATCH), sent once it reads; only a proven mismatch drops it', async (t) => {
  let now = 1_800_000_000_000
  let mid = ME
  const ids = ['7731', '7732', '7733']
  const h = await harness(t, new Map(ids.map((id) => [id, e2eePhoto(id)])), { now: () => now, localMidFn: () => mid })
  assert.equal((await h.service.request('i:7731')).state, 'queued', 'admitted (the desktop account read fine)')
  mid = null // e.g. the snapshot is being replaced when the job is about to run
  await until(() => h.logs.some((l) => l.includes('code=ACCOUNT_UNVERIFIED')), 'the send-time account check')
  await tick(20)
  assert.equal(h.obs.requests.length, 0, 'nothing is sent while the account cannot be verified')
  assert.equal(h.service.queueState().jobs, 1, 'the job is held, not dropped')
  assert.equal((await h.service.status(['i:7731'])).items[0].state, 'queued', 'still queued (waiting to try again), not account_mismatch')
  assert.equal(h.logs.some((l) => l.includes('ACCOUNT_MISMATCH')), false, 'an unreadable account is not logged as a mismatch')
  // still unreadable at the next try: held again
  now += 60_001
  h.service.kick()
  await until(() => h.logs.filter((l) => l.includes('code=ACCOUNT_UNVERIFIED')).length >= 2, 'the second try')
  assert.equal(h.obs.requests.length, 0)
  // readable again: sent and landed
  mid = ME
  now += 60_001
  h.service.kick()
  await h.service.whenIdle()
  assert.equal(h.obs.requests.length, 1)
  assert.equal((await h.service.status(['i:7731'])).items[0].state, 'done')
  // a batch item behind it: the batch is not finished while its item is held
  const out = await h.service.batchStart(GROUP, ['i:7732'])
  assert.deepEqual(out.accepted, ['i:7732'])
  mid = null
  await until(() => h.logs.filter((l) => l.includes('code=ACCOUNT_UNVERIFIED')).length >= 3, 'the batch item is held')
  assert.equal((await h.service.status(['i:7732'])).batch.state, 'running', 'the batch waits for the held item')
  mid = ME
  now += 60_001
  h.service.kick()
  await h.service.whenIdle()
  const st = await h.service.status(['i:7732'])
  assert.deepEqual([st.items[0].state, st.batch.state, st.batch.done], ['done', 'finished', 1])
  // a proven mismatch at send time: dropped, logged as ACCOUNT_MISMATCH, nothing sent
  assert.equal((await h.service.request('i:7733')).state, 'queued')
  mid = FRIEND
  await h.service.whenIdle()
  assert.equal(h.obs.requests.length, 2, 'not sent with the other account')
  assert.equal(h.service.queueState().jobs, 0, 'a mismatch drops the job')
  assert.ok(h.logs.some((l) => l.includes('state=idle code=ACCOUNT_MISMATCH')))
})

test('[N-4] a 429 pause restored from the throttle file (or the ledger\'s nextAt) is capped at X1\'s OBS_RATE_LIMIT_MAX_MS (6 h), not 24 h', async (t) => {
  assert.equal(OBS_RATE_LIMIT_MAX_MS, 6 * 60 * 60_000)
  const p = e2eePhoto('7741')
  const dir = await workdir(t)
  await mkdir(path.join(dir, 'linejs-downloads'), { recursive: true })
  const until20h = Date.now() + 20 * 60 * 60_000 // a clock that went back, or a damaged file
  await writeFile(throttleFile(dir), JSON.stringify({ version: 1, times: [], rateLimitedUntil: until20h }), 'utf8')
  const h = await harness(t, new Map([['7741', p]]), { dir })
  const v = await h.service.request('i:7741')
  assert.deepEqual([v.state, v.code], ['paused', 'rate_limited'])
  const st = await h.service.status(['i:7741'])
  const left = st.paused.untilMs - Date.now()
  assert.ok(left <= OBS_RATE_LIMIT_MAX_MS + 1000, `the service pause is capped at 6 h (left ${Math.round(left / 60_000)} min)`)
  assert.ok(left > OBS_RATE_LIMIT_MAX_MS - 60_000, 'and is not shorter than that')
  const limiterLeft = h.limiter.state().pausedMs
  assert.ok(limiterLeft <= OBS_RATE_LIMIT_MAX_MS + 1000 && limiterLeft > OBS_RATE_LIMIT_MAX_MS - 60_000, `the shared limiter pause is capped too (${Math.round(limiterLeft / 60_000)} min)`)
  assert.equal(h.obs.requests.length, 0)
})

test('[N-4][M6] the throttle file is replaced atomically: written to a temp name (…json.<uuid>.part) and renamed; while a write is in progress the previous file is still whole; no temp file is left', async (t) => {
  const fsp = (await import('node:fs/promises')).default
  const { syncBuiltinESMExports } = await import('node:module')
  const items = new Map([['7751', e2eePhoto('7751')], ['7752', e2eePhoto('7752')]])
  const h = await harness(t, items)
  await h.service.request('i:7751')
  await h.service.whenIdle()
  await until(async () => { try { return JSON.parse(await readFile(throttleFile(h.dir), 'utf8')).times.length === 1 } catch { return false } }, 'the first throttle write')
  const original = fsp.open
  const opened = []
  const seenDuring = []
  fsp.open = async (file, ...rest) => {
    const name = path.basename(String(file))
    if (name.startsWith('originals-throttle.json')) {
      opened.push(name)
      // the file other readers would see while this write is in progress (sync read: no re-entry into this hook)
      try { seenDuring.push(JSON.parse(readFileSync(throttleFile(h.dir), 'utf8')).times.length) } catch (error) { seenDuring.push(error.code ?? 'UNPARSABLE') }
      await tick(60)
    }
    return original(file, ...rest)
  }
  syncBuiltinESMExports()
  t.after(() => { fsp.open = original; syncBuiltinESMExports() })
  await h.service.request('i:7752')
  await h.service.whenIdle()
  fsp.open = original
  syncBuiltinESMExports()
  assert.ok(opened.length >= 1, 'the second request wrote the throttle file')
  assert.ok(opened.every((n) => /^originals-throttle\.json\.[0-9a-f-]{36}\.part$/.test(n)), `only temp names are opened for writing: ${JSON.stringify(opened)}`)
  assert.deepEqual(seenDuring, opened.map(() => 1), 'the previous file stays whole while the new one is written')
  assert.equal(JSON.parse(await readFile(throttleFile(h.dir), 'utf8')).times.length, 2)
  assert.deepEqual((await readdir(path.join(h.dir, 'linejs-downloads'))).filter((n) => n.startsWith('originals-throttle.json.')), [])
})

// ───────────────────────── review-x2b F-3：接收自動排的工作的每小時請求子上限 ─────────────────────────

test('[X2B-F3] receive\'s own hourly request share: once used up only receive\'s automatic jobs wait (no global pause) — a click goes on; the share is in originals-throttle.json and survives a restart', async (t) => {
  assert.equal(Originals.ORIGINALS_RECEIVE_REQUESTS_PER_HOUR, 100)
  const r1 = e2eePhoto('8971')
  const r2 = e2eePhoto('8972')
  const u = e2eePhoto('8973')
  const items = new Map([['8971', r1], ['8972', r2], ['8973', u]])
  const h = await harness(t, items, { limits: { receiveRequestsPerHour: 1 } })
  await h.service.enqueueDetailed(['i:8971'], { origin: 'receive' })
  await h.service.whenIdle()
  assert.equal(h.obs.requests.length, 1)
  const v = await h.service.enqueueDetailed(['i:8972'], { origin: 'receive' })
  assert.equal(v.items[0].state, 'paused', JSON.stringify(v.items[0]))
  assert.equal(v.items[0].code, 'hourly_limit')
  await tick(50)
  assert.equal(h.obs.requests.length, 1, 'the second receive job waits')
  const q = h.service.queueState()
  assert.deepEqual({ receiveHourly: q.receiveHourly, globalPause: q.globalPause }, { receiveHourly: true, globalPause: null })
  assert.equal((await h.service.status(['i:8972'])).paused, null, 'no global pause in the status view')
  await h.service.request('i:8973')
  await until(async () => (await h.service.status(['i:8973'])).items[0].state === 'done', 'the click')
  assert.equal(h.obs.requests.length, 2)
  // a click on the waiting receive job makes it the user's: it is sent at once
  await h.service.request('i:8972')
  await until(async () => (await h.service.status(['i:8972'])).items[0].state === 'done', 'the clicked receive job')
  assert.equal(h.obs.requests.length, 3)
  await h.service.dispose()
  const throttle = JSON.parse(await readFile(path.join(h.dir, 'linejs-downloads', Originals.ORIGINALS_THROTTLE_NAME), 'utf8'))
  assert.equal(throttle.times.length, 3)
  assert.equal(throttle.receiveTimes.length, 1, 'only the automatic receive request counts against the share')
  // restart within the hour: the share is still used up
  releaseSharedLedger(h.dir)
  const r3 = e2eePhoto('8974')
  const h2 = await harness(t, new Map([['8974', r3]]), { dir: h.dir, limits: { receiveRequestsPerHour: 1 } })
  const v2 = await h2.service.enqueueDetailed(['i:8974'], { origin: 'receive' })
  assert.equal(v2.items[0].state, 'paused', JSON.stringify(v2.items[0]))
  await tick(50)
  assert.equal(h2.obs.requests.length, 0)
})

// ───────────────────────── review-x2b 車道佔用：使用者的單格搶先接收中的大檔 ─────────────────────────

test('[X2B-PRE] lane preemption: a receive video holding the interactive lane yields to a user click within 2 s; it resumes later from its part (Range), lands byte-identical, and its attempts do not grow', async (t) => {
  let release
  const gate = new Promise((r) => { release = r })
  t.after(() => release())
  const v = video('8981', 1024 * KIB + 5)
  const p = e2eePhoto('8982')
  const h = await harness(t, new Map([['8981', v], ['8982', p]]), { obs: { gate, gateAt: 192 * KIB } })
  const a = await h.service.enqueueDetailed(['i:8981'], { origin: 'receive' })
  assert.ok(['queued', 'running'].includes(a.items[0].state), JSON.stringify(a.items[0]))
  // the first 192 KiB arrive, then the body is held (the stream flushes the part when it is aborted)
  await until(() => h.obs.requests.length === 1, 'the video request')
  await tick(100)
  assert.equal((await h.service.status(['i:8981'])).items[0].state, 'running')
  const t0 = Date.now()
  assert.equal((await h.service.request('i:8982')).state, 'queued', 'the click waits for the lane')
  await until(() => h.obs.requests.some((r) => r.path === p.obs[0]), 'the user click starts', 2000)
  const waited = Date.now() - t0
  assert.ok(waited <= 2000, `the user click started after ${waited} ms`)
  await until(async () => (await h.service.status(['i:8982'])).items[0].state === 'done', 'the click is done')
  assert.equal(h.service.counters.preemptions, 1)
  assert.ok(h.logs.some((l) => /^originals_job kind=VIDEO origin=receive state=preempted count=1$/.test(l)), h.logs.join('\n'))
  await h.service.whenIdle()
  const owner = ledgerOwner(ME)
  assert.equal(h.service.ledger.get(owner, stemOf('8981')).attempts ?? 0, 0, 'the preemption did not count an attempt')
  assert.deepEqual(await readFile(path.join(h.dir, SAVED_MEDIA_DIR, `${stemOf('8981')}.mp4`)), v.body, 'the resumed video is byte-identical')
  const videoRequests = h.obs.requests.filter((r) => r.path === v.obs[0])
  assert.equal(videoRequests.length, 2, 'one request before, one resume after')
  assert.match(String(videoRequests[1].range), /^bytes=[1-9]\d*-$/, 'resumed from the kept part with Range')
  assert.deepEqual(await partsIn(h.dir), [])
  assert.equal((await h.service.status(['i:8981'])).items[0].state, 'done')
})

test('[X2B-PRE] a receive photo is not preempted: the user click waits for it (photos finish in seconds)', async (t) => {
  let release
  const gate = new Promise((r) => { release = r })
  t.after(() => release())
  const r = e2eePhoto('8983')
  const u = e2eePhoto('8984')
  const h = await harness(t, new Map([['8983', r], ['8984', u]]), { obs: { gate, gateAt: 0 } })
  await h.service.enqueueDetailed(['i:8983'], { origin: 'receive' })
  await until(() => h.obs.requests.length === 1, 'the receive photo request')
  assert.equal((await h.service.request('i:8984')).state, 'queued')
  await tick(300)
  assert.equal(h.obs.requests.length, 1, 'the click waits')
  assert.equal(h.service.counters.preemptions, 0)
  release()
  await h.service.whenIdle()
  assert.deepEqual(h.obs.requests.map((q) => q.path), [r.obs[0], u.obs[0]])
  assert.deepEqual((await h.service.status(['i:8983', 'i:8984'])).items.map((i) => i.state), ['done', 'done'])
})

test('[X2B-PRE] no preemption loop: one receive video yields at most PREEMPT_MAX_PER_JOB (3) times; the 4th click waits until it is done; attempts stay 0 and the video is byte-identical', async (t) => {
  assert.equal(Originals.PREEMPT_MAX_PER_JOB, 3)
  assert.equal(Originals.PREEMPT_MIN_BYTES, 8 * 1024 * 1024)
  let releaseVideo
  const videoHold = new Promise((r) => { releaseVideo = r })
  t.after(() => releaseVideo())
  const v = video('8985', 1024 * KIB + 9)
  const clicks = ['8986', '8987', '8988', '8989']
  const items = new Map([['8985', v], ...clicks.map((id) => [id, e2eePhoto(id)])])
  // every video request is held after 192 KiB of its body (more than the stream's 64 KiB sniff head, so each run adds to the part)
  const h = await harness(t, items, { obs: { holdFor: ({ path: p }) => (p === v.obs[0] ? videoHold : null), gateAt: 192 * KIB } })
  await h.service.enqueueDetailed(['i:8985'], { origin: 'receive' })
  const videoRequests = () => h.obs.requests.filter((r) => r.path === v.obs[0]).length
  for (let k = 0; k < 3; k++) {
    await until(() => videoRequests() === k + 1, `video run ${k + 1}`)
    await tick(50)
    await h.service.request(`i:${clicks[k]}`)
    await until(async () => (await h.service.status([`i:${clicks[k]}`])).items[0].state === 'done', `click ${k + 1}`, 4000)
  }
  await until(() => videoRequests() === 4, 'video run 4')
  assert.equal(h.service.counters.preemptions, 3)
  await h.service.request(`i:${clicks[3]}`)
  await tick(300)
  assert.ok(!h.obs.requests.some((r) => r.path === items.get(clicks[3]).obs[0]), 'the 4th click waits: the video is not preempted again')
  assert.equal(h.service.counters.preemptions, 3)
  releaseVideo()
  await h.service.whenIdle()
  const order = h.obs.requests.map((r) => r.path)
  assert.ok(order.indexOf(items.get(clicks[3]).obs[0]) > order.lastIndexOf(v.obs[0]), 'the 4th click ran after the video')
  const ranges = h.obs.requests.filter((r) => r.path === v.obs[0]).map((r) => (r.range ? Number(/^bytes=(\d+)-$/.exec(r.range)?.[1]) : 0))
  assert.equal(ranges[0], 0)
  assert.ok(ranges.slice(1).every((n, i) => n > ranges[i]), `every resume continues further into the part: ${ranges.join(',')}`)
  assert.equal(h.service.ledger.get(ledgerOwner(ME), stemOf('8985')).attempts ?? 0, 0)
  assert.deepEqual(await readFile(path.join(h.dir, SAVED_MEDIA_DIR, `${stemOf('8985')}.mp4`)), v.body)
  assert.deepEqual((await h.service.status(clicks.map((id) => `i:${id}`))).items.map((i) => i.state), ['done', 'done', 'done', 'done'])
})

// ───────────────────────── review-x67（X5 批補修）：L-1 服務層級的帳號暫停、L-2 審查探針 S1 移植 ─────────────────────────

test('[L-1] the desktop account stays unreadable while 19 jobs wait (user clicks, receive, a batch on the other lane): over 11 s of real time the service reads the account at most 3 times and logs ACCOUNT_UNVERIFIED at most twice; nothing is sent until it reads, then everything is', async (t) => {
  let mid = ME
  const clicks = Array.from({ length: 14 }, (_, i) => String(8801 + i)) // the first one is the slow download in front
  const received = Array.from({ length: 5 }, (_, i) => String(8821 + i))
  const batched = '8831'
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const h = await harness(t, new Map([...clicks, ...received, batched].map((id) => [id, e2eePhoto(id)])), { localMidFn: () => mid, obs: { gate, gateAt: 0 } })
  for (const id of clicks) assert.equal((await h.service.request(`i:${id}`)).state, 'queued')
  const recv = await h.service.enqueueDetailed(received.map((id) => `i:${id}`), { origin: 'receive' })
  assert.equal(recv.queued, received.length, 'the receive rows are queued behind the clicks (same lane)')
  await until(() => h.obs.requests.length === 1, 'the first click is downloading')
  // the snapshot is being replaced from now on; the first download finishes 600 ms later and frees the lane
  mid = null
  const reads0 = h.counts.localMid
  const t0 = Date.now()
  setTimeout(release, 600)
  // a batch admitted from the 60 s admission cache: its job runs on the batch lane at once and is the first to meet the unreadable account
  assert.deepEqual((await h.service.batchStart(GROUP, [`i:${batched}`])).accepted, [`i:${batched}`])
  await until(() => h.service.queueState().running === 0 && h.obs.requests.length === 1 && h.service.queueState().jobs === 19, 'the first download is done, 19 jobs wait')
  await tick(Math.max(0, 11_000 - (Date.now() - t0)))
  const reads = h.counts.localMid - reads0
  const holdLines = h.logs.filter((l) => l.includes('code=ACCOUNT_UNVERIFIED'))
  t.diagnostic(`L-1 jobs=${h.service.queueState().jobs} elapsed=${Date.now() - t0}ms desktop account reads=${reads} ACCOUNT_UNVERIFIED lines=${holdLines.length} obs=${h.obs.requests.length}`)
  assert.equal(h.obs.requests.length, 1, 'nothing more is sent while the desktop account cannot be read')
  assert.ok(reads >= 1 && reads <= 3, `the whole service read the desktop account ${reads} times in ${Date.now() - t0} ms (each job on its own would be about 19 x 3)`)
  assert.ok(holdLines.length >= 1 && holdLines.length <= 2, `ACCOUNT_UNVERIFIED lines: ${holdLines.length}`)
  assert.equal(h.logs.some((l) => l.includes('ACCOUNT_MISMATCH')), false)
  assert.equal(h.service.queueState().jobs, 19, 'every held job is still queued (none dropped)')
  const st = await h.service.status([`i:${clicks[1]}`, `i:${received[0]}`, `i:${batched}`])
  assert.deepEqual(st.items.map((v) => v.state), ['queued', 'queued', 'queued'], 'held cells (click, receive, batch) show queued, not account_mismatch')
  assert.equal(st.batch.state, 'running', 'the batch waits for its held item')
  // readable again: the next read (at most ACCOUNT_RETRY_MS later) lifts the hold and every job is sent
  mid = ME
  await until(() => h.obs.requests.length >= 2, 'sending resumes after the next read', 8000)
  await h.service.whenIdle()
  assert.equal(h.obs.requests.length, 20)
  const done = await h.service.status([...clicks, ...received, batched].map((id) => `i:${id}`))
  assert.ok(done.items.every((v) => v.state === 'done'), JSON.stringify(done.items.map((v) => v.state)))
  assert.equal(done.batch.state, 'finished')
})

test('[L-2][S1] a cancel during an admission that ends early (desktop account unreadable → ACCOUNT_UNVERIFIED) leaves no mark: the next click queues and downloads (review-x67 S1, mutation K4a)', async (t) => {
  let mid = null
  const h = await harness(t, new Map([['8951', e2eePhoto('8951')]]), { localMidFn: async () => { await tick(120); return mid } })
  const reqP = h.service.request('i:8951')
  await tick(40)
  await h.service.cancel('i:8951') // the stem is still being admitted (the account read takes 120 ms): a cancel mark is set
  const first = await reqP
  assert.deepEqual([first.state, first.code], ['account_mismatch', 'ACCOUNT_UNVERIFIED'], 'the admission ended before the mark was used')
  mid = ME
  const second = await h.service.request('i:8951')
  assert.equal(second.state, 'queued', 'a later click is not swallowed by an old cancel')
  await h.service.whenIdle()
  assert.equal(h.obs.requests.length, 1)
  assert.equal((await h.service.status(['i:8951'])).items[0].state, 'done')
})

// ───────────────────────── review-x5（X5-fix）：F-1 帳號暫停期間的點擊與批次、F-3 登出／換 session 清掉暫停、Info 讀帳號逾時 ─────────────────────────

test('[X5F-1][RX5-P3] a click inside the account hold, with the desktop account readable again, is answered at once without a desktop read: account_mismatch / ACCOUNT_UNVERIFIED (never ACCOUNT_MISMATCH; the cell offers 重試) and nothing is queued (mutation RM1); once the hold is over the cell is idle and the same click queues and downloads', async (t) => {
  let mid = null
  let n = 0
  const h = await harness(t, new Map([['8721', e2eePhoto('8721')], ['8722', e2eePhoto('8722')]]), { localMidFn: () => { n++; return n === 1 ? ME : mid } })
  assert.equal((await h.service.request('i:8721')).state, 'queued')
  await until(() => h.logs.some((l) => l.includes('code=ACCOUNT_UNVERIFIED')), 'the send-time read failed: service hold')
  mid = ME
  const readsBefore = n
  const v = await h.service.request('i:8722')
  assert.equal(n - readsBefore, 0, 'no desktop read during the hold (accepted design L-1; review-x5 RM1)')
  assert.deepEqual([v.state, v.code], ['account_mismatch', 'ACCOUNT_UNVERIFIED'], 'answered as "cannot read the desktop account right now"')
  assert.equal(h.service.queueState().jobs, 1, 'the click inside the hold queued nothing')
  await h.service.whenIdle()
  assert.equal((await h.service.status(['i:8721'])).items[0].state, 'done', 'the held job is sent once the account is readable')
  assert.equal((await h.service.status(['i:8722'])).items[0].state, 'idle', 'after the hold the cell that got ACCOUNT_UNVERIFIED is idle')
  assert.equal((await h.service.request('i:8722')).state, 'queued', 'the retry after the hold is queued')
  await h.service.whenIdle()
  assert.equal((await h.service.status(['i:8722'])).items[0].state, 'done')
  assert.equal(h.obs.requests.length, 2)
  assert.equal(h.logs.some((l) => l.includes('ACCOUNT_MISMATCH')), false)
})

test('[X5F-1][RX5-P2] a batch started inside the account hold (the desktop account stays unreadable) queues nothing: every cell is skipped as ACCOUNT_UNVERIFIED, the service batch ends with 0 items and nothing is sent — the view explains it instead of 補抓完成 (0 個)', async (t) => {
  let n = 0
  const h = await harness(t, new Map([['8711', e2eePhoto('8711')], ['8712', e2eePhoto('8712')], ['8713', e2eePhoto('8713')]]), { localMidFn: () => { n++; return n === 1 ? ME : null } })
  assert.equal((await h.service.request('i:8711')).state, 'queued')
  await until(() => h.logs.some((l) => l.includes('code=ACCOUNT_UNVERIFIED')), 'the send-time read failed: service hold')
  const b = await h.service.batchStart(GROUP, ['i:8712', 'i:8713'])
  assert.deepEqual(b.accepted, [])
  assert.deepEqual(b.skipped.map((s) => [s.msgId, s.state, s.code]), [['i:8712', 'account_mismatch', 'ACCOUNT_UNVERIFIED'], ['i:8713', 'account_mismatch', 'ACCOUNT_UNVERIFIED']])
  const st = await h.service.status(['i:8711', 'i:8712', 'i:8713'])
  assert.deepEqual([st.batch.state, st.batch.total], ['finished', 0], 'the service batch ended with nothing in it')
  assert.deepEqual(st.items.map((i) => i.state), ['queued', 'idle', 'idle'], 'the held click stays queued; the skipped cells are idle')
  assert.equal(h.obs.requests.length, 0, 'nothing sent')
})

test('[X5F-3][RX5-P1] logout and login again inside an account hold: the hold of the old session is gone — the first click after the new login reads the (readable) desktop account and is queued and downloaded', async (t) => {
  let mid = null
  let n = 0
  const sessions = fakeSessions(makeSession('sess-1', ME))
  const h = await harness(t, new Map([['8701', e2eePhoto('8701')], ['8702', e2eePhoto('8702')]]), { sessions, localMidFn: () => { n++; return n === 1 ? ME : mid } })
  assert.equal((await h.service.request('i:8701')).state, 'queued')
  await until(() => h.logs.some((l) => l.includes('code=ACCOUNT_UNVERIFIED')), 'the send-time read failed: service hold')
  mid = ME
  sessions.install(null)
  await until(() => h.service.queueState().jobs === 0, 'logout dropped the job')
  sessions.install(makeSession('sess-2', ME))
  await tick(20)
  const readsBefore = n
  const v = await h.service.request('i:8702')
  assert.deepEqual([v.state, v.code], ['queued', undefined], `after a logout + login the click is answered ${v.state}/${v.code}`)
  assert.ok(n - readsBefore >= 1, 'the desktop account was read for the admission')
  await h.service.whenIdle()
  assert.equal(h.obs.requests.length, 1)
  assert.equal((await h.service.status(['i:8702'])).items[0].state, 'done')
})

test('[X5F-3] a logout inside an account hold lifts it by itself: a click while logged out (desktop account readable again) asks for the LINE login (needs_login), not 暫時讀不到帳號 (mutation: logout keeps accountHold)', async (t) => {
  let mid = null
  let n = 0
  const sessions = fakeSessions(makeSession('sess-1', ME))
  const h = await harness(t, new Map([['8731', e2eePhoto('8731')], ['8732', e2eePhoto('8732')]]), { sessions, localMidFn: () => { n++; return n === 1 ? ME : mid } })
  assert.equal((await h.service.request('i:8731')).state, 'queued')
  await until(() => h.logs.some((l) => l.includes('code=ACCOUNT_UNVERIFIED')), 'the send-time read failed: service hold')
  mid = ME
  sessions.install(null)
  await until(() => h.service.queueState().jobs === 0, 'logout dropped the job')
  const v = await h.service.request('i:8732')
  assert.deepEqual([v.state, v.code], ['needs_login', 'SESSION_NOT_READY'], `a click after the logout is answered ${v.state}/${v.code}`)
  assert.equal(h.obs.requests.length, 0)
})

test('[X5F-3] switching to another session inside an account hold (no logout in between) lifts the hold and its log flag: the desktop account is read again at once, and the new session\'s hold writes its own ACCOUNT_UNVERIFIED line; nothing is sent until the account is readable', async (t) => {
  let mid = null
  let n = 0
  const sessions = fakeSessions(makeSession('sess-1', ME))
  const h = await harness(t, new Map([['8741', e2eePhoto('8741')]]), { sessions, localMidFn: () => { n++; return n === 1 ? ME : mid } })
  assert.equal((await h.service.request('i:8741')).state, 'queued')
  await until(() => h.logs.some((l) => l.includes('code=ACCOUNT_UNVERIFIED')), 'the send-time read failed: service hold')
  const readsBefore = n
  const t0 = Date.now()
  // same account, new session (a token login): the held job follows it; the old session's 5 s hold must not hold it
  sessions.install(makeSession('sess-2', ME))
  await until(() => h.logs.filter((l) => l.includes('code=ACCOUNT_UNVERIFIED')).length === 2, 'the new session reads at once and its hold logs its own line', 2500)
  assert.ok(n - readsBefore >= 1 && Date.now() - t0 < 2500, `read again ${n - readsBefore} time(s) within ${Date.now() - t0} ms of the switch`)
  assert.equal(h.obs.requests.length, 0, 'nothing sent while unreadable')
  mid = ME
  await h.service.whenIdle()
  assert.equal(h.obs.requests.length, 1)
  assert.equal((await h.service.status(['i:8741'])).items[0].state, 'done')
})

test('[X5F-I] the shared desktop-account read is bounded (ACCOUNT_READ_TIMEOUT_MS = 30 s; shortened here): two clicks sharing a read that never answers are both answered ACCOUNT_UNVERIFIED after the timeout instead of waiting forever; a send-time read that never answers turns into the account hold and frees the lane; later reads work again (review-x5 Info)', async (t) => {
  assert.equal(Originals.ACCOUNT_READ_TIMEOUT_MS, 30_000, 'the production timeout')
  const pending = []
  // read #1 (shared by two clicks) hangs; #2 (an admission) answers; #3 (the send-time read) hangs; then every read answers
  const plan = ['stuck', 'ok', 'stuck']
  const h = await harness(t, new Map([['8761', e2eePhoto('8761')], ['8762', e2eePhoto('8762')]]), {
    localMidFn: () => ((plan.shift() ?? 'ok') === 'stuck' ? new Promise((resolve) => pending.push(resolve)) : ME),
    accountReadTimeoutMs: 300,
  })
  try {
    const t0 = Date.now()
    const answers = await Promise.race([Promise.all([h.service.request('i:8761'), h.service.request('i:8762')]), tick(5000).then(() => null)])
    assert.ok(answers, 'the clicks were answered (not stuck behind a read that never ends)')
    assert.deepEqual(answers.map((v) => [v.state, v.code]), [['account_mismatch', 'ACCOUNT_UNVERIFIED'], ['account_mismatch', 'ACCOUNT_UNVERIFIED']])
    assert.equal(h.counts.localMid, 1, 'both clicks shared one read')
    assert.ok(Date.now() - t0 >= 250, `answered after the timeout (${Date.now() - t0} ms)`)
    assert.equal(h.service.queueState().jobs, 0)
    // the send-time read hangs: the job goes back to the queue under the account hold and the lane is free again
    assert.equal((await h.service.request('i:8761')).state, 'queued')
    await until(() => h.logs.some((l) => l.includes('code=ACCOUNT_UNVERIFIED')), 'the hung send-time read became the account hold', 3000)
    assert.equal(h.service.queueState().running, 0, 'nothing waits on the hung read')
    assert.equal(h.logs.filter((l) => l === 'originals_account code=ACCOUNT_READ_TIMEOUT').length, 2, 'each timed-out read wrote one code-only line')
    assert.equal(h.obs.requests.length, 0)
    await h.service.whenIdle()
    assert.equal(h.obs.requests.length, 1, 'the next read answered and the job was sent')
    assert.equal(h.counts.localMid, 4)
  } finally { for (const resolve of pending) resolve(null) }
})

// ───────────────────────── review-fix-final NF-2（RVF-T1 收進正式測試）、NF-3（搶先不看被擋住的單格）─────────────────────────

test('[NF-2][RVF-T1] warm account cache + a send-time read that never answers: nothing is sent until a read answers (the timeout is never treated as the cached account; mutation R5)', async (t) => {
  const pending = []
  let hang = false
  const h = await harness(t, new Map([['8771', e2eePhoto('8771')], ['8772', e2eePhoto('8772')]]), {
    localMidFn: () => (hang ? new Promise((resolve) => pending.push(resolve)) : ME),
    accountReadTimeoutMs: 200,
  })
  try {
    // warm: one click downloads (the session is noted, the admission cache holds ME)
    await h.service.request('i:8771')
    await h.service.whenIdle()
    assert.equal(h.obs.requests.length, 1)
    // the second click is admitted from the 60 s cache (no read), then the send-time read hangs
    hang = true
    assert.equal((await h.service.request('i:8772')).state, 'queued')
    await tick(700)
    t.diagnostic(`requests=${h.obs.requests.length} logs=${JSON.stringify(h.logs.filter((l) => /ACCOUNT/.test(l)))}`)
    assert.equal(h.obs.requests.length, 1, 'nothing sent while the desktop account cannot be read')
    assert.ok(h.logs.some((l) => l.includes('code=ACCOUNT_READ_TIMEOUT')))
  } finally { for (const resolve of pending) resolve(null) }
})

test('[NF-3][X2B-PRE] a user click that is held (the hourly cap is used up: global pause hourly_limit) does not preempt the running receive video — it could not start anyway; the video runs to the end in one request (mutation R10)', async (t) => {
  let releaseVideo
  const videoHold = new Promise((r) => { releaseVideo = r })
  t.after(() => releaseVideo())
  const v = video('8775', 1024 * KIB + 13)
  const b = e2eePhoto('8776')
  const u = e2eePhoto('8777')
  // one request per hour: the receive video takes it; the batch photo on the other lane is refused locally → global pause hourly_limit
  const h = await harness(t, new Map([['8775', v], ['8776', b], ['8777', u]]), { limits: { requestsPerHour: 1 }, obs: { holdFor: ({ path: p }) => (p === v.obs[0] ? videoHold : null), gateAt: 192 * KIB } })
  await h.service.enqueueDetailed(['i:8775'], { origin: 'receive' })
  await until(() => h.obs.requests.length === 1, 'the receive video request')
  await tick(50)
  const started = await h.service.batchStart(GROUP, ['i:8776'])
  assert.deepEqual(started.accepted, ['i:8776'])
  await until(() => h.service.queueState().globalPause === 'hourly_limit', 'the batch photo hit the hourly cap')
  const click = await h.service.request('i:8777')
  assert.deepEqual([click.state, click.code], ['paused', 'hourly_limit'], 'the click is held by the hourly cap')
  await tick(300)
  assert.equal(h.service.counters.preemptions, 0, 'a held click never preempts')
  assert.equal((await h.service.status(['i:8775'])).items[0].state, 'running', 'the video keeps the lane')
  releaseVideo()
  await until(async () => (await h.service.status(['i:8775'])).items[0].state === 'done', 'the video lands')
  assert.equal(h.obs.requests.filter((r) => r.path === v.obs[0]).length, 1, 'one request, never cut and resumed')
  assert.deepEqual(await readFile(path.join(h.dir, SAVED_MEDIA_DIR, `${stemOf('8775')}.mp4`)), v.body)
  assert.equal(h.obs.requests.filter((r) => r.path === u.obs[0]).length, 0, 'the held click sent nothing')
})
