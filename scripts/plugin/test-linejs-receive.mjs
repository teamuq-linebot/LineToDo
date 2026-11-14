// X2b 自動接收（implementation-plan-v2.md §2 X2b，Q3 = 以電腦版訊息為準；review-x1 I-6；review-x2a I-1、I-5）。
// app DB 用 node:sqlite（真的 SQLite：rowid 游標的語意與 better-sqlite3 相同）；LINEJS client、OBS、session、電腦版帳號都是假的。
// 寫入只在 os.tmpdir() 底下；全域 fetch 換成會丟錯的假函式（沒有真 LINE、不讀憑證）。
// 測試名稱：[A#] v2 X2b 驗收；[R#] 派工單要求（R1 關閉不排、R2 out、R3 收回、R4 message 處理器、R5 守門、R6 共用限流、R7 優先順序、
// R8 大量落庫、R9 游標持久化、R10 首次開啟只看新列、R11 I-5 遷移）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createCipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { LineJsReceiveService, RECEIVE_CURSOR_NAME, RECEIVE_LIMITS } from '../../src/plugin/backend/linejsReceive.ts'
import { OriginalDownloadService, releaseSharedLedger, sharedMediaLedger } from '../../src/plugin/backend/linejsOriginals.ts'
import { ObsLimiter } from '../../src/plugin/backend/linejsObs.ts'
import { LineJsMediaService, createLineJsMediaFetch } from '../../src/plugin/backend/linejsMedia.ts'
import { SAVED_MEDIA_DIR, createPluginMedia, mediaCacheStem } from '../../src/plugin/backend/media.ts'
import { AutoDownloadStore, MEDIA_LEDGER_NAME, MEDIA_LEDGER_V1_NAME, MediaLedger, ledgerOwner } from '../../src/plugin/backend/linejsAutoDownload.mjs'

globalThis.fetch = async () => { throw Object.assign(new Error('network disabled in this test'), { code: 'TEST_NO_NETWORK' }) }

const KIB = 1024
const ME = 'u0123456789abcdef0123456789abcdef'
const OTHER = 'u99999999999999999999999999999999'
const GROUP = 'c11112222333344445555666677778888'
const CHAT_NAME = 'Receive Room Secret'
const TS = new Date(2026, 10, 1, 9, 0, 0).getTime()
const HOUR = 60 * 60_000
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(fn, label = 'condition', ms = 8000) {
  const end = Date.now() + ms
  for (;;) {
    if (await fn()) return
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await tick(5)
  }
}
const stemOf = (id) => mediaCacheStem(`i:${id}`)
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

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
function png(w = 40, h = 30, seed = 7) {
  const chunk = (type, data) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii'); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0, 0); return Buffer.concat([head, data, crc]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const rows = Buffer.alloc((w * 3 + 1) * h); for (let i = 0; i < rows.length; i++) rows[i] = (i * seed + (i >> 5)) & 0xff
  for (let y = 0; y < h; y++) rows[y * (w * 3 + 1)] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows, { level: 0 })), chunk('IEND', Buffer.alloc(0))])
}

/** The app DB tables the receive scan, X6 and M1 read (same column names as src/main/db/schema.ts). */
function appDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE chats (chat_id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE messages (msg_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, ts INTEGER NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('in','out')),
      content_type INTEGER NOT NULL DEFAULT 0, ingested_at TEXT NOT NULL, key_material TEXT, orig_filename TEXT, file_size INTEGER, media_oid TEXT, media_sid TEXT,
      sticker_id TEXT, sticker_package_id TEXT, unsent INTEGER NOT NULL DEFAULT 0);`)
  db.prepare('INSERT INTO chats (chat_id, name) VALUES (?, ?)').run(GROUP, CHAT_NAME)
  return db
}
/** The app DB with the app_settings table (src/main/db/schema.ts): receive keeps its DB identity there (review-x2b F-1). */
function appDbWithSettings() {
  const db = appDb()
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);')
  return db
}
/**
 * What the watcher's batch commit does (insertMessages): INSERT OR IGNORE of a batch in one transaction, one ingested_at.
 * `ts` (the LINE message time) defaults to the real now: a message that arrives while receive is on (review-x2b F-1 scans ts >= sinceTs);
 * a test about history passes an old ts.
 */
function persist(db, rows) {
  const now = new Date().toISOString()
  const stmt = db.prepare(`INSERT OR IGNORE INTO messages (msg_id, chat_id, ts, direction, content_type, ingested_at, key_material, orig_filename, file_size, media_oid, media_sid, unsent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  db.exec('BEGIN')
  for (const r of rows) stmt.run(r.msgId ?? `i:${r.id}`, r.chatId ?? GROUP, r.ts ?? Date.now(), r.direction ?? 'in', r.ct ?? 1, now, r.key ?? null, r.fileName ?? null, r.size ?? null, r.oid ?? null, r.sid ?? null, r.unsent ? 1 : 0)
  db.exec('COMMIT')
}
const textRow = (id) => ({ id, ct: 0 })

/**
 * A receive switch like LineJsMediaService's (receiveEnabled + onReceiveEnabledChange). `set` resolves once the receive service has
 * handled the change (its listener runs async: cancel / fresh cursor / save).
 */
function makeSwitch(initial) {
  const listeners = new Set()
  const s = {
    on: initial,
    receiveEnabled: () => s.on,
    onReceiveEnabledChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    async set(next) { if (next === s.on) return; s.on = next; for (const fn of [...listeners]) fn(next); await tick(30) },
  }
  return s
}

/**
 * A fake X6 port: every enqueue is recorded; `policy(id)` decides the admission view (default queued); status() answers `settle(id)`
 * for ids it accepted (default done). Either may return a state string or `{ state, code }`. cancelReceive counts.
 */
function fakeOriginals({ policy = () => 'queued', settle = () => 'done' } = {}) {
  const view = (id, v) => (typeof v === 'string' ? { msgId: id, state: v } : { msgId: id, ...v })
  const port = {
    calls: [],
    handed: new Map(),
    statusCalls: 0,
    cancels: 0,
    async enqueueDetailed(ids, options) {
      assert.equal(options.origin, 'receive')
      port.calls.push([...ids])
      for (const id of ids) port.handed.set(id, (port.handed.get(id) ?? 0) + 1)
      return { items: ids.map((id) => view(id, policy(id))) }
    },
    async status(ids) { port.statusCalls++; return { items: ids.map((id) => view(id, settle(id))) } },
    cancelReceive() { port.cancels++; return 0 },
  }
  return port
}

const removeDir = (dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
async function workdir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'line-todo-x2b-receive-'))
  t.after(() => removeDir(dir))
  return dir
}
/** Fake clock for the receive service (X6 keeps the real one). */
function clock(start = TS) { const c = { t: start, now: () => c.t, advance(ms) { c.t += ms } }; return c }
const QUIET = { minTickMs: 0, pollMs: 1e9, deferMs: 1e9 }

function receiveOver(t, { dir, db, originals, session = { currentSessionId: () => 'sess-1' }, sw = makeSwitch(true), limits = {}, now, logs = [] }) {
  const svc = new LineJsReceiveService({ dataDir: dir, getDb: () => db, originals, session, receiveSwitch: sw, limits: { ...QUIET, ...limits }, ...(now ? { now } : {}), log: (line) => logs.push(line) })
  t.after(() => svc.dispose())
  return svc
}

// ── real X6 harness (fake OBS, fake LINEJS session) ──

function fakeClient(token) {
  const listeners = new Map()
  const base = {
    authToken: token, profile: { mid: ME },
    request: { systemType: 'ANDROIDSECONDARY\t14.0.0\tAndroid OS\t13', getHeader: () => ({ 'x-line-access': token, 'accept-encoding': 'gzip' }) },
    on: (event, fn) => { listeners.set(event, [...(listeners.get(event) ?? []), fn]) },
  }
  return { base }
}
function fakeSessions() {
  const listeners = new Set()
  const port = {
    current: { client: fakeClient('token-1'), sessionId: 'sess-1', ownerMid: ME },
    calls: { outbound: 0 },
    outboundSession: async () => { port.calls.outbound++; return port.current },
    isCurrentSession: (sid, client) => Boolean(port.current) && port.current.sessionId === sid && port.current.client === client,
    onSessionChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    currentSessionId: () => port.current?.sessionId ?? null,
    /** switch the session (null = logout) and notify like LineJsMediaService */
    install(next) { port.current = next; for (const fn of [...listeners]) fn(next ? next.sessionId : null) },
  }
  return port
}
function obsServer(objects, opts = {}) {
  const requests = []
  const fetch = async (request) => {
    const url = new URL(request.url)
    const n = requests.length + 1
    requests.push({ path: url.pathname, n })
    const rule = opts.respond?.({ path: url.pathname, n })
    if (rule) return new Response('', { status: rule.status, headers: rule.headers ?? {} })
    const body = objects.get(url.pathname)
    if (!body) return new Response('', { status: 404 })
    const held = opts.hold?.get(url.pathname)
    if (held) await held
    return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } })
  }
  return { fetch, requests }
}
const roomy = async () => ({ bavail: 1e12 / 4096, bsize: 4096 })

async function realHarness(t, opts = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'line-todo-x2b-real-'))
  const db = opts.db ?? appDb()
  const objects = new Map()
  const obs = obsServer(objects, opts.obs ?? {})
  const sessions = opts.sessions ?? fakeSessions()
  const env = { localMid: ME }
  const logs = []
  // one fake clock for both services (X6's 60 s admission cache of the desktop account and receive's defer use the same time)
  const c = clock(Date.now())
  const originals = new OriginalDownloadService({
    dataDir: dir, session: sessions,
    localAccountMid: opts.localAccountMid ?? (async () => env.localMid),
    getDb: () => db,
    limiter: new ObsLimiter(),
    fetch: createLineJsMediaFetch(obs.fetch),
    stream: { statfs: roomy, backoffMs: () => 0, maxAttempts: 2, ...opts.stream },
    limits: { requestIntervalMs: 0, autoRetryDelayMs: 60_000, ...opts.limits },
    now: c.now,
    log: (line) => logs.push(line),
  })
  const sw = opts.sw ?? makeSwitch(true)
  const receive = new LineJsReceiveService({ dataDir: dir, getDb: () => db, originals, session: sessions, receiveSwitch: sw, limits: { ...QUIET, ...opts.receiveLimits }, now: c.now, log: (line) => logs.push(line) })
  const media = createPluginMedia({ dataDir: dir, getDb: () => db, decryptor: null, index: null })
  t.after(async () => { await receive.dispose(); await originals.dispose(); releaseSharedLedger(dir); db.close(); await removeDir(dir) })
  /** an E2EE photo row + its OBS object */
  const photo = (id, over = {}) => {
    const km = randomBytes(32)
    const body = png(40, 30, Number(String(id).slice(-3)) % 97 + 1)
    const oid = `oidRECV${id}`
    objects.set(`/r/talk/emi/${oid}`, encrypt(body, km))
    return { id, ct: 1, key: km.toString('base64'), size: body.length, oid, sid: 'emi', body, ...over }
  }
  return { dir, db, obs, objects, sessions, env, logs, originals, receive, sw, clock: c, media, photo }
}

// ───────────────────────── A1 / A3 / A4 / R2 / R3 ─────────────────────────

test('[A1] a photo row the watcher persists after receive is on is downloaded automatically; media.prepare serves it; the ledger origin is receive', async (t) => {
  const h = await realHarness(t)
  const p = h.photo('7100000000000000001')
  persist(h.db, [p])
  await h.receive.tick()
  assert.equal(h.receive.state().accepted, 1, `handed to X6: ${JSON.stringify(h.receive.state())} ${JSON.stringify(h.receive.counters)} ${h.logs.join(" | ")}`)
  await h.originals.whenIdle()
  assert.equal(h.obs.requests.length, 1)
  const served = h.media.prepare(`i:${p.id}`)
  assert.equal(served.ok, true, JSON.stringify(served))
  assert.deepEqual(await readFile(path.join(h.dir, served.path)), p.body)
  assert.equal(h.originals.ledger.get(ledgerOwner(ME), stemOf(p.id)).origin, 'receive')
  await h.receive.tick()
  assert.equal(h.receive.state().outstanding, 0, 'settled: done')
  // nothing is handed twice: another persisted event with no new rows hands nothing
  persist(h.db, [textRow('7100000000000000002')])
  await h.receive.tick()
  assert.equal(h.obs.requests.length, 1)
})

test('[A3][R2] rows sent by the account itself (direction out) are handled too', async (t) => {
  const port = fakeOriginals()
  const dir = await workdir(t)
  const db = appDb()
  t.after(() => db.close())
  const svc = receiveOver(t, { dir, db, originals: port })
  await svc.tick()
  persist(db, [{ id: '7200000000000000001', ct: 1, direction: 'out' }, { id: '7200000000000000002', ct: 2, direction: 'out' }, { id: '7200000000000000003', ct: 14, direction: 'in' }])
  await svc.tick()
  assert.deepEqual(port.calls, [['i:7200000000000000001', 'i:7200000000000000002', 'i:7200000000000000003']])
})

test('[A4][R3] recalled rows (unsent=1) are skipped; non-media rows, d: ids and other content types are never handed; the cursor moves past them', async (t) => {
  const port = fakeOriginals()
  const dir = await workdir(t)
  const db = appDb()
  t.after(() => db.close())
  const svc = receiveOver(t, { dir, db, originals: port })
  await svc.tick()
  persist(db, [
    { id: '7300000000000000001', ct: 1, unsent: true },
    textRow('7300000000000000002'),
    { msgId: 'd:local-1', ct: 1 },
    { id: '7300000000000000004', ct: 7 },
    { id: '7300000000000000005', ct: 14 },
  ])
  await svc.tick()
  assert.deepEqual(port.calls, [['i:7300000000000000005']])
  assert.equal(svc.counters.skippedUnsent, 1)
  assert.equal(svc.counters.skippedId, 1)
  assert.equal(svc.state().afterRowid, 5)
})

// ───────────────────────── A2 / R1 receive off ─────────────────────────

test('[A2][R1] receive off: nothing is scanned or handed; switching off cancels what receive queued (a user click keeps its job); off → on starts after the rows of the off period', async (t) => {
  const port = fakeOriginals({ settle: () => 'queued' })
  const dir = await workdir(t)
  const db = appDb()
  t.after(() => db.close())
  persist(db, [{ id: '7400000000000000001', ct: 1 }])
  const sw = makeSwitch(false)
  const svc = receiveOver(t, { dir, db, originals: port, sw })
  persist(db, [{ id: '7400000000000000002', ct: 1 }])
  await svc.tick()
  assert.deepEqual(port.calls, [], 'off from the start: nothing')
  // on: only rows persisted after the switch
  await sw.set(true)
  await svc.tick()
  assert.deepEqual(port.calls, [], 'the rows before the switch are history')
  persist(db, [{ id: '7400000000000000003', ct: 1 }])
  await svc.tick()
  assert.deepEqual(port.calls, [['i:7400000000000000003']])
  // off: cancelReceive, and rows persisted while off are never handed — not even after it is switched on again
  await sw.set(false)
  assert.equal(port.cancels, 1)
  assert.equal(svc.state().outstanding, 0)
  persist(db, [{ id: '7400000000000000004', ct: 1 }])
  await svc.tick()
  await svc.tick()
  assert.equal(port.calls.length, 1, 'off: no enqueue')
  await sw.set(true)
  persist(db, [{ id: '7400000000000000005', ct: 1 }])
  await svc.tick()
  assert.deepEqual(port.calls.at(-1), ['i:7400000000000000005'])
  assert.ok(!port.handed.has('i:7400000000000000004'))
})

test('[A2][R1] switching receive off cancels the receive jobs in X6, never a job the user clicked; nothing else is sent', async (t) => {
  const hold = new Map()
  let release
  const h = await realHarness(t, { obs: { hold } })
  const a = h.photo('7410000000000000001')
  const b = h.photo('7410000000000000002')
  const c = h.photo('7410000000000000003')
  hold.set(`/r/talk/emi/${a.oid}`, new Promise((resolve) => { release = resolve }))
  persist(h.db, [a, b, c])
  await h.receive.tick()
  assert.equal(h.receive.state().accepted, 3)
  // the user clicks c (it becomes the user's job); then receive is switched off
  assert.ok(['queued', 'running'].includes((await h.originals.request(`i:${c.id}`)).state))
  await h.sw.set(false)
  release()
  await h.originals.whenIdle()
  const st = await h.originals.status([`i:${a.id}`, `i:${b.id}`, `i:${c.id}`])
  assert.equal(st.items[1].state, 'idle', 'queued receive job → idle')
  assert.equal(st.items[2].state, 'done', 'the user\'s job ran')
  assert.ok(!h.obs.requests.some((r) => r.path.endsWith(b.oid)), 'b never sent')
})

// ───────────────────────── R4 LINEJS message handler ─────────────────────────

test('[R4] the LINEJS message handler keeps only the account / session state: IMAGE, VIDEO, FILE and own messages are never downloaded; the v1 ledger is not written', async (t) => {
  const dir = await workdir(t)
  const events = new EventEmitter()
  const calls = { getData: 0, downloadMessageData: 0, listen: 0 }
  const client = {
    authToken: 'fixture-token', on: events.on.bind(events), off: events.off.bind(events), listen() { calls.listen++ },
    base: { profile: { mid: ME }, on() {}, obs: { async downloadMessageData() { calls.downloadMessageData++; return new Blob([Buffer.from('x')]) } } },
  }
  const service = await LineJsMediaService.create(path.join(dir, 'plugin'), { loginWithQR: async (_cb, init) => { await init.storage.set('linejs-auth-token', 'fixture-token'); return client } })
  t.after(() => service.dispose())
  await service.startLogin()
  for (let i = 0; i < 100 && (await service.status()).login.status !== 'authenticated'; i++) await tick()
  const seen = []
  service.onReceiveEnabledChange((on) => seen.push(on))
  await service.setReceiveEnabled(true)
  await service.setReceiveEnabled(true)
  assert.deepEqual(seen, [true], 'the switch observer fires once per change')
  assert.equal(service.receiveEnabled(), true)
  assert.equal(calls.listen, 1, 'the listen loop still runs (session / token state)')
  const message = (id, kind, self = false) => ({ isMyMessage: self, to: { type: 'GROUP', id: GROUP }, from: { id: OTHER }, raw: { id, contentType: kind, hasContent: true, contentMetadata: { FILE_NAME: 'a.pdf' } }, async getData() { calls.getData++; return new Blob([png()]) } })
  for (const [id, kind, self] of [['1', 'IMAGE'], ['2', 'VIDEO'], ['3', 'FILE'], ['4', 'IMAGE', true]]) events.emit('message', message(id, kind, self))
  await tick(60)
  assert.deepEqual({ getData: calls.getData, downloadMessageData: calls.downloadMessageData }, { getData: 0, downloadMessageData: 0 })
  const st = await service.status()
  assert.equal(st.receiver, 'active')
  assert.equal(st.downloads.pending + st.downloads.completed + st.downloads.failed, 0)
  await assert.rejects(() => readFile(path.join(dir, 'plugin', 'linejs-downloads', MEDIA_LEDGER_V1_NAME)), { code: 'ENOENT' }, 'the frozen v1 store never writes its ledger')
  assert.deepEqual(await service.retry('anything'), { status: 'disabled' })
  await service.setReceiveEnabled(false)
  assert.deepEqual(seen, [true, false])
})

// ───────────────────────── R5 gates ─────────────────────────

test('[R5] no installed session: nothing is handed and the session port is never asked (no token login from receive); the rows wait behind the cursor', async (t) => {
  const port = fakeOriginals()
  const dir = await workdir(t)
  const db = appDb()
  t.after(() => db.close())
  const session = { current: null, currentSessionId: () => session.current }
  const svc = receiveOver(t, { dir, db, originals: port, session })
  await svc.tick()
  persist(db, [{ id: '7500000000000000001', ct: 1 }])
  await svc.tick()
  await svc.tick()
  assert.deepEqual(port.calls, [])
  session.current = 'sess-2'
  await svc.tick()
  assert.deepEqual(port.calls, [['i:7500000000000000001']], 'handed once the session is there')
})

test('[R5] account mismatch / session not ready (X6 gates): 0 OBS requests; the rows stay outstanding (not lost) and are handed again once the account matches', async (t) => {
  const h = await realHarness(t, { receiveLimits: { deferMs: 30_000 } })
  h.env.localMid = OTHER
  const p = h.photo('7510000000000000001')
  persist(h.db, [p])
  await h.receive.tick()
  assert.equal(h.obs.requests.length, 0, 'account mismatch: nothing sent')
  assert.equal(h.receive.state().outstanding, 1)
  assert.equal(h.receive.state().accepted, 0)
  // not due yet
  await h.receive.tick()
  assert.equal(h.obs.requests.length, 0)
  h.env.localMid = ME
  // past receive's defer (30 s) and X6's 60 s admission cache of the desktop account
  h.clock.advance(61_000)
  await h.receive.tick()
  await h.originals.whenIdle()
  assert.equal(h.obs.requests.length, 1)
  assert.equal(h.media.prepare(`i:${p.id}`).ok, true)
})

// ───────────────────────── R6 shared hourly cap and 429 (I-6) ─────────────────────────

test('[R6][I-6] receive shares the hourly cap with history downloads: once history used it up, the receive job is paused (hourly_limit) and sends nothing', async (t) => {
  const h = await realHarness(t, { limits: { requestsPerHour: 1 } })
  const history = h.photo('7600000000000000001')
  const received = h.photo('7600000000000000002')
  // an old row (persisted before receive is on) downloaded by the user: origin history uses the one request of the hour
  await h.sw.set(false)
  persist(h.db, [history])
  await h.sw.set(true)
  await h.originals.request(`i:${history.id}`)
  await h.originals.whenIdle()
  assert.equal(h.obs.requests.length, 1)
  assert.equal(h.originals.ledger.get(ledgerOwner(ME), stemOf(history.id)).origin, 'history')
  persist(h.db, [received])
  await h.receive.tick()
  await tick(50)
  assert.equal(h.obs.requests.length, 1, 'the receive job did not get a request')
  assert.equal(h.originals.queueState().globalPause, 'hourly_limit')
  const st = await h.originals.status([`i:${received.id}`])
  assert.equal(st.items[0].state, 'paused')
})

test('[R6][I-6] a 429 from a user download pauses receive too (one shared global pause): the receive job is not sent', async (t) => {
  const h = await realHarness(t, { obs: { respond: ({ n }) => (n === 1 ? { status: 429, headers: { 'retry-after': '600' } } : null) } })
  const sw = h.sw
  await sw.set(false)
  const user = h.photo('7610000000000000001')
  persist(h.db, [user])
  await sw.set(true)
  await h.originals.request(`i:${user.id}`)
  await tick(80)
  assert.equal(h.obs.requests.length, 1)
  assert.equal(h.originals.queueState().globalPause, 'rate_limited')
  const received = h.photo('7610000000000000002')
  persist(h.db, [received])
  await h.receive.tick()
  await tick(80)
  assert.equal(h.obs.requests.length, 1, 'paused: no request for the receive job')
  assert.equal((await h.originals.status([`i:${received.id}`])).items[0].state, 'paused')
})

// ───────────────────────── R7 priority ─────────────────────────

test('[R7] priority user > receive > batch: a user click queued behind receive jobs runs next; a running batch never holds receive back', async (t) => {
  const hold = new Map()
  let releaseFirst
  let releaseBatch
  const h = await realHarness(t, { obs: { hold } })
  const r1 = h.photo('7700000000000000001')
  const r2 = h.photo('7700000000000000002')
  const r3 = h.photo('7700000000000000003')
  const batch = h.photo('7700000000000000009')
  const user = h.photo('7700000000000000010')
  hold.set(`/r/talk/emi/${r1.oid}`, new Promise((resolve) => { releaseFirst = resolve }))
  hold.set(`/r/talk/emi/${batch.oid}`, new Promise((resolve) => { releaseBatch = resolve }))
  await h.sw.set(false)
  persist(h.db, [batch, user])
  await h.sw.set(true)
  // a batch job runs (held) in its own lane
  await h.originals.batchStart(GROUP, [`i:${batch.id}`])
  for (let i = 0; i < 100 && !h.obs.requests.some((r) => r.path.endsWith(batch.oid)); i++) await tick()
  persist(h.db, [r1, r2, r3])
  await h.receive.tick()
  for (let i = 0; i < 100 && !h.obs.requests.some((r) => r.path.endsWith(r1.oid)); i++) await tick()
  assert.ok(h.obs.requests.some((r) => r.path.endsWith(r1.oid)), 'receive runs while the batch job is still running')
  await h.originals.request(`i:${user.id}`)
  releaseFirst()
  for (let i = 0; i < 200 && h.obs.requests.length < 3; i++) await tick()
  const order = h.obs.requests.map((r) => r.path.split('/').pop())
  assert.equal(order[2], user.oid, `user before the queued receive jobs: ${order.join(',')}`)
  releaseBatch()
  await h.originals.whenIdle()
  assert.equal(h.obs.requests.length, 5)
})

// ───────────────────────── R8 flood ─────────────────────────

test('[R8] a desktop sync of 1,000 media rows at once: at most 10 outstanding at a time and at most 100 handed per hour; every row is handed exactly once over time', async (t) => {
  const port = fakeOriginals()
  const dir = await workdir(t)
  const db = appDb()
  t.after(() => db.close())
  const c = clock()
  const svc = receiveOver(t, { dir, db, originals: port, now: c.now })
  await svc.tick()
  const rows = Array.from({ length: 1000 }, (_, i) => ({ id: String(7800000000000000000n + BigInt(i)), ct: [1, 2, 14][i % 3] }))
  persist(db, rows)
  await svc.tick()
  assert.equal(port.calls.length, 1)
  assert.equal(port.calls[0].length, RECEIVE_LIMITS.window, 'one tick hands at most the window')
  assert.equal(RECEIVE_LIMITS.window, 10)
  assert.equal(RECEIVE_LIMITS.perHour, 100)
  // within the first hour: never more than 100 handed, never more than 10 outstanding
  for (let i = 0; i < 60; i++) { c.advance(1000); await svc.tick(); assert.ok(svc.state().outstanding <= 10) }
  const handedFirstHour = [...port.handed.values()].reduce((a, b) => a + b, 0)
  assert.equal(handedFirstHour, 100, 'the hourly cap stops the hand-off')
  c.advance(30 * 60_000)
  await svc.tick()
  assert.equal([...port.handed.values()].reduce((a, b) => a + b, 0), 100, 'still within the hour')
  // over the next hours everything goes, once each
  for (let hour = 0; hour < 12; hour++) { c.advance(HOUR); for (let i = 0; i < 12; i++) { c.advance(1000); await svc.tick() } }
  assert.equal(port.handed.size, 1000, 'no row lost')
  assert.ok([...port.handed.values()].every((n) => n === 1), 'no row handed twice')
})

// ───────────────────────── R9 cursor persisted ─────────────────────────

test('[R9] the cursor is persisted: a restart hands neither settled rows again nor misses rows persisted while it was down; outstanding rows are handed again', async (t) => {
  const dir = await workdir(t)
  const db = appDb()
  t.after(() => db.close())
  const settled = new Set(['i:7900000000000000001', 'i:7900000000000000002'])
  const portA = fakeOriginals({ settle: (id) => (settled.has(id) ? 'done' : 'queued') })
  const a = new LineJsReceiveService({ dataDir: dir, getDb: () => db, originals: portA, session: { currentSessionId: () => 's' }, receiveSwitch: makeSwitch(true), limits: QUIET })
  await a.tick()
  persist(db, [1, 2, 3].map((n) => ({ id: `790000000000000000${n}`, ct: 1 })))
  await a.tick()
  await a.tick() // status: 1 and 2 done, 3 still queued
  assert.equal(a.state().outstanding, 1)
  await a.dispose()
  const cursor = JSON.parse(await readFile(path.join(dir, 'linejs-downloads', RECEIVE_CURSOR_NAME), 'utf8'))
  assert.equal(cursor.afterRowid, 3)
  assert.deepEqual(cursor.outstanding, ['i:7900000000000000003'])
  // while it is down the watcher persists two more rows
  persist(db, [4, 5].map((n) => ({ id: `790000000000000000${n}`, ct: 2 })))
  const portB = fakeOriginals()
  const b = receiveOver(t, { dir, db, originals: portB })
  await b.tick()
  assert.deepEqual(portB.calls.flat().sort(), ['i:7900000000000000003', 'i:7900000000000000004', 'i:7900000000000000005'])
  assert.ok(!portB.handed.has('i:7900000000000000001') && !portB.handed.has('i:7900000000000000002'), 'settled rows are not handed again')
})

test('[R9] after a restart the re-handed outstanding row that had already landed costs 0 OBS requests and is written once (X6 short-circuit)', async (t) => {
  const h = await realHarness(t)
  const p = h.photo('7910000000000000001')
  persist(h.db, [p])
  await h.receive.tick()
  await h.originals.whenIdle()
  assert.equal(h.obs.requests.length, 1)
  // crash before the receive service saw the result: the cursor file still lists the row as outstanding
  await h.receive.dispose()
  const file = path.join(h.dir, 'linejs-downloads', RECEIVE_CURSOR_NAME)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).outstanding, [`i:${p.id}`])
  const again = new LineJsReceiveService({ dataDir: h.dir, getDb: () => h.db, originals: h.originals, session: h.sessions, receiveSwitch: h.sw, limits: QUIET })
  t.after(() => again.dispose())
  await again.tick()
  assert.equal(again.state().outstanding, 0, 'X6 answered done at once')
  assert.equal(h.obs.requests.length, 1, 'no second request')
  assert.equal(h.originals.sink.writes.get(stemOf(p.id)), 1)
})

// ───────────────────────── R10 first enable ─────────────────────────

test('[R10] the first time receive is on (no cursor file) only rows persisted after that are handed — no backfill of the history; a corrupt cursor file is a fresh start too', async (t) => {
  const dir = await workdir(t)
  const db = appDb()
  t.after(() => db.close())
  persist(db, Array.from({ length: 30 }, (_, i) => ({ id: String(7950000000000000000n + BigInt(i)), ct: 1 })))
  const port = fakeOriginals()
  const svc = receiveOver(t, { dir, db, originals: port })
  await svc.tick()
  assert.deepEqual(port.calls, [], 'history is not received')
  assert.equal(svc.state().afterRowid, 30)
  await svc.dispose()
  await writeFile(path.join(dir, 'linejs-downloads', RECEIVE_CURSOR_NAME), '{"version":1,"enabled":true,"afterRowid":"oops"')
  persist(db, [{ id: '7950000000000000100', ct: 1 }])
  const logs = []
  const port2 = fakeOriginals()
  const svc2 = receiveOver(t, { dir, db, originals: port2, logs })
  await svc2.tick()
  assert.deepEqual(port2.calls, [])
  assert.ok(logs.some((l) => l.includes('code=CURSOR_CORRUPT')))
  persist(db, [{ id: '7950000000000000101', ct: 1 }])
  await svc2.tick()
  assert.deepEqual(port2.calls, [['i:7950000000000000101']])
})

test('[R10] an app DB whose MAX(rowid) is below the cursor (replaced DB) resets the cursor without backfilling', async (t) => {
  const dir = await workdir(t)
  const db = appDb()
  t.after(() => db.close())
  await mkdir(path.join(dir, 'linejs-downloads'), { recursive: true })
  await writeFile(path.join(dir, 'linejs-downloads', RECEIVE_CURSOR_NAME), JSON.stringify({ version: 1, enabled: true, afterRowid: 500, sinceTs: Date.now() - 60_000, dbId: null, outstanding: [], handed: [] }))
  persist(db, [1, 2, 3].map((n) => ({ id: `796000000000000000${n}`, ct: 1 })))
  const port = fakeOriginals()
  const logs = []
  const svc = receiveOver(t, { dir, db, originals: port, logs })
  await svc.tick()
  assert.deepEqual(port.calls, [])
  assert.equal(svc.state().afterRowid, 3)
  assert.ok(logs.some((l) => l.includes('code=CURSOR_RESET')))
})

// ───────────────────────── R11 I-5 migration ─────────────────────────

test('[R11][I-5] v1 → v2: the frozen v1 ledger is never rewritten or pruned (a 100-day-old completed item survives); v2 imports it once, only while v2 does not exist', async (t) => {
  const dir = await workdir(t)
  const plugin = path.join(dir, 'plugin')
  const downloads = path.join(plugin, 'linejs-downloads')
  const old = TS - 100 * 24 * HOUR
  const writer = new AutoDownloadStore(downloads, { now: () => old })
  await writer.init()
  writer.setOwner(ME)
  for (const id of ['8000000000000000001', '8000000000000000002']) await writer.enqueue({ chatId: GROUP, chatName: 'room', message: { raw: { id } }, kind: 'IMAGE', metadata: { name: `${id}.jpg` } })
  await writer.saveFile(writer.keyFor(GROUP, '8000000000000000001', 'IMAGE'), png())
  await writer.close()
  const v1File = path.join(downloads, MEDIA_LEDGER_V1_NAME)
  const before = sha(await readFile(v1File))
  // the production service (frozen store): create, enable receive, dispose — v1 untouched (the old completed item was not pruned by the 90-day TTL)
  const service = await LineJsMediaService.create(plugin)
  await service.dispose()
  assert.equal(sha(await readFile(v1File)), before, 'v1 ledger byte-identical')
  const items = JSON.parse(await readFile(v1File, 'utf8')).items
  assert.equal(items.length, 2)
  // v2 does not exist: imported once
  const first = sharedMediaLedger(plugin)
  const counts = await first.loaded
  assert.equal(counts.migratedFromV1, 2)
  assert.equal(first.ledger.get(ledgerOwner(ME), stemOf('8000000000000000001')).code, 'V1_COMPLETED')
  await first.ledger.flush()
  releaseSharedLedger(plugin)
  // v2 exists now: never imported again (v1 is frozen, so nothing completed after the import can be missed)
  const second = new MediaLedger(downloads)
  const again = await second.load()
  assert.equal(again.migratedFromV1, 0)
  assert.equal(again.total, 2)
  assert.equal(sha(await readFile(v1File)), before)
  await assert.doesNotReject(() => readFile(path.join(downloads, MEDIA_LEDGER_NAME)))
})

// ───────────────────────── review-x2b fixes (F-1 … F-7; probes P1 P1b P2 P2b P3 P4 P7 rewritten as regressions) ─────────────────────────

const DAY = 24 * HOUR
const YEAR_AGO = () => Date.now() - 365 * DAY
/** history rows (a year old) — what the initial import, a re-import or a replaced DB persists */
const historyRows = (base, n, ts = YEAR_AGO()) => Array.from({ length: n }, (_, i) => ({ id: String(base + BigInt(i)), ct: 1, ts: ts + i * 1000 }))
const drain = async (svc, rounds = 40) => { for (let i = 0; i < rounds; i++) await svc.tick() }

test('[F-1][P1] rows of a year-old history persisted AFTER receive is on (initial import resuming) are never handed; a new message and an offline-synced one (ts after sinceTs, persisted later) are', async (t) => {
  const port = fakeOriginals()
  const dir = await workdir(t)
  const db = appDb()
  t.after(() => db.close())
  persist(db, historyRows(8200000000000000000n, 5))
  const sw = makeSwitch(false)
  const svc = receiveOver(t, { dir, db, originals: port, sw })
  await svc.tick()
  await sw.set(true)
  const since = svc.state().sinceTs
  assert.ok(since <= Date.now() - RECEIVE_LIMITS.sinceBufferMs + 50 && since > Date.now() - RECEIVE_LIMITS.sinceBufferMs - 5000, `sinceTs = switch-on − ${RECEIVE_LIMITS.sinceBufferMs} ms`)
  assert.equal(RECEIVE_LIMITS.sinceBufferMs, 5 * 60_000)
  persist(db, historyRows(8200000000000000100n, 30)) // the import drains the rest of the history
  await drain(svc)
  assert.equal(port.handed.size, 0, `history rows handed: ${port.handed.size}`)
  // a new message, and one sent 1 min after switch-on that the desktop synced late (persisted after newer rows)
  persist(db, [{ id: '8200000000000000500', ct: 1 }])
  persist(db, [{ id: '8200000000000000501', ct: 14, ts: since + RECEIVE_LIMITS.sinceBufferMs + 60_000 }])
  await drain(svc, 3)
  assert.deepEqual([...port.handed.keys()].sort(), ['i:8200000000000000500', 'i:8200000000000000501'])
})

test('[F-1][P2] a replaced app DB (another identity in app_settings) with a larger MAX(rowid) and recent rows: a fresh start (sinceTs now, cursor MAX, DB_CHANGED) — nothing of it is handed; a new row is', async (t) => {
  const dir = await workdir(t)
  const a = appDbWithSettings()
  persist(a, historyRows(8210000000000000000n, 5))
  const sw = makeSwitch(true)
  const logs = []
  const svcA = new LineJsReceiveService({ dataDir: dir, getDb: () => a, originals: fakeOriginals(), session: { currentSessionId: () => 's' }, receiveSwitch: sw, limits: QUIET, log: (l) => logs.push(l) })
  await svcA.tick()
  await svcA.dispose()
  const cursor = JSON.parse(await readFile(path.join(dir, 'linejs-downloads', RECEIVE_CURSOR_NAME), 'utf8'))
  assert.equal(cursor.afterRowid, 5)
  assert.match(String(cursor.dbId), /^[0-9a-f-]{36}$/, 'the DB identity is in the cursor file')
  assert.equal(a.prepare('SELECT value FROM app_settings WHERE key = ?').get('line-todo.linejs-receive.db-id.v1').value, cursor.dbId)
  // the same DB after a restart: resumed, not a fresh start
  const portA2 = fakeOriginals()
  const svcA2 = new LineJsReceiveService({ dataDir: dir, getDb: () => a, originals: portA2, session: { currentSessionId: () => 's' }, receiveSwitch: sw, limits: QUIET, log: (l) => logs.push(l) })
  persist(a, [{ id: '8210000000000000100', ct: 1 }])
  await svcA2.tick()
  assert.deepEqual(portA2.calls, [['i:8210000000000000100']])
  await svcA2.dispose()
  assert.ok(!logs.some((l) => l.includes('DB_CHANGED')))
  // line-todo.db deleted and re-imported: 40 rows, some of them recent, rowids past the old cursor
  const b = appDbWithSettings()
  persist(b, [...historyRows(8211000000000000000n, 30), ...historyRows(8211000000000001000n, 10, Date.now() - 60_000)])
  const portB = fakeOriginals()
  const svcB = receiveOver(t, { dir, db: b, originals: portB, logs })
  await drain(svcB)
  assert.equal(portB.handed.size, 0, `rows of the replaced DB handed: ${portB.handed.size}`)
  assert.ok(logs.some((l) => l === '[receive] code=DB_CHANGED'), logs.join(' | '))
  assert.equal(svcB.state().afterRowid, 40)
  persist(b, [{ id: '8211000000000002000', ct: 2 }])
  await svcB.tick()
  assert.deepEqual(portB.calls, [['i:8211000000000002000']])
})

test('[F-1][P2] a replaced app DB without a readable identity (no app_settings): the history rows after the old cursor are kept out by sinceTs', async (t) => {
  const dir = await workdir(t)
  const a = appDb()
  persist(a, historyRows(8220000000000000000n, 5))
  const sw = makeSwitch(true)
  const svcA = new LineJsReceiveService({ dataDir: dir, getDb: () => a, originals: fakeOriginals(), session: { currentSessionId: () => 's' }, receiveSwitch: sw, limits: QUIET })
  await svcA.tick()
  await svcA.dispose()
  const b = appDb()
  persist(b, historyRows(8221000000000000000n, 40))
  const portB = fakeOriginals()
  const svcB = receiveOver(t, { dir, db: b, originals: portB, sw })
  await drain(svcB)
  assert.equal(portB.handed.size, 0, `rows 6..40 of the replaced DB handed: ${portB.handed.size}`)
})

test('[F-1][P2b] a DB replaced by an empty one resets the cursor (CURSOR_RESET) and keeps sinceTs: the re-imported history is not handed; a new message after it is', async (t) => {
  const dir = await workdir(t)
  let db = appDb()
  persist(db, historyRows(8230000000000000000n, 50))
  const port = fakeOriginals()
  const logs = []
  const svc = new LineJsReceiveService({ dataDir: dir, getDb: () => db, originals: port, session: { currentSessionId: () => 's' }, receiveSwitch: makeSwitch(true), limits: QUIET, log: (l) => logs.push(l) })
  t.after(() => svc.dispose())
  await svc.tick()
  const since = svc.state().sinceTs
  db = appDb()
  await svc.tick()
  assert.ok(logs.some((l) => l.includes('CURSOR_RESET')), logs.join(' | '))
  assert.equal(svc.state().sinceTs, since, 'sinceTs kept across the reset')
  persist(db, historyRows(8230000000000000000n, 20))
  await drain(svc)
  assert.equal(port.handed.size, 0, `re-imported history handed: ${port.handed.size}`)
  persist(db, [{ id: '8230000000000000900', ct: 1 }])
  await svc.tick()
  assert.deepEqual(port.calls, [['i:8230000000000000900']])
})

test('[F-5][P1b] receive switched on while the cursor file is still loading: the switch-on moment is kept — three photos persisted right after it are handed', async (t) => {
  const dir = await workdir(t)
  const db = appDb()
  t.after(() => db.close())
  persist(db, historyRows(8240000000000000000n, 5))
  const sw = makeSwitch(false)
  const port = fakeOriginals()
  const svc = receiveOver(t, { dir, db, originals: port, sw })
  await sw.set(true) // the listener fires synchronously, before load() (started in the constructor) has finished
  persist(db, [1, 2, 3].map((n) => ({ id: `824000000000000010${n}`, ct: 1 })))
  await drain(svc, 5)
  assert.deepEqual([...port.handed.keys()].sort(), ['i:8240000000000000101', 'i:8240000000000000102', 'i:8240000000000000103'], JSON.stringify(svc.state()))
})

test('[F-5] receive switched on while the app DB is not ready: once it is, the rows persisted after the switch are handed (scanned from the start, the history kept out by sinceTs)', async (t) => {
  const dir = await workdir(t)
  const db = appDb()
  t.after(() => db.close())
  let ready = null
  const sw = makeSwitch(false)
  const port = fakeOriginals()
  const svc = new LineJsReceiveService({ dataDir: dir, getDb: () => ready, originals: port, session: { currentSessionId: () => 's' }, receiveSwitch: sw, limits: QUIET })
  t.after(() => svc.dispose())
  await svc.tick()
  await sw.set(true) // no DB yet: no MAX(rowid) to start from
  await svc.tick()
  persist(db, historyRows(8250000000000000000n, 20))
  persist(db, [{ id: '8250000000000000100', ct: 1 }, { id: '8250000000000000101', ct: 14 }])
  ready = db
  await drain(svc, 4)
  assert.deepEqual([...port.handed.keys()].sort(), ['i:8250000000000000100', 'i:8250000000000000101'])
})

test('[F-2][P3] a receive job the user cancels (取消 in X7) is closed: never handed to X6 again, nothing is downloaded for it', async (t) => {
  const hold = new Map()
  let release
  const h = await realHarness(t, { obs: { hold }, receiveLimits: { deferMs: 30_000 } })
  const u = h.photo('8260000000000000001') // a user click occupies the single interactive lane
  const r = h.photo('8260000000000000002') // a new photo receive queues behind it
  hold.set(`/r/talk/emi/${u.oid}`, new Promise((resolve) => { release = resolve }))
  await h.sw.set(false)
  persist(h.db, [u])
  await h.sw.set(true)
  await h.originals.request(`i:${u.id}`)
  for (let i = 0; i < 100 && !h.obs.requests.length; i++) await tick()
  persist(h.db, [r])
  await h.receive.tick()
  assert.equal(h.receive.state().accepted, 1, 'receive handed the new photo (queued behind the user job)')
  assert.equal((await h.originals.cancel(`i:${r.id}`)).state, 'idle', 'the user cancelled it')
  release()
  await h.originals.whenIdle()
  await h.receive.tick() // status → idle after it had been accepted → closed
  assert.equal(h.receive.state().outstanding, 0)
  assert.equal(h.receive.counters.closedIdle, 1)
  h.clock.advance(30_001)
  await h.receive.tick()
  await h.originals.whenIdle()
  assert.equal(h.obs.requests.filter((q) => q.path.endsWith(r.oid)).length, 0, 'the cancelled photo was not downloaded by receive')
  assert.equal((await h.originals.status([`i:${r.id}`])).items[0].state, 'idle')
})

test('[F-2] idle at admission: APP_DB_UNAVAILABLE / LEDGER_UNAVAILABLE / SERVICE_STOPPED are tried again later; any other idle (ABORTED: cancelled during admission) is closed', async (t) => {
  const dir = await workdir(t)
  const db = appDb()
  t.after(() => db.close())
  const c = clock(Date.now())
  const seen = new Map()
  const first = { 'i:8270000000000000001': 'APP_DB_UNAVAILABLE', 'i:8270000000000000002': 'LEDGER_UNAVAILABLE', 'i:8270000000000000003': 'SERVICE_STOPPED', 'i:8270000000000000004': 'ABORTED' }
  const port = fakeOriginals({ policy: (id) => { const n = (seen.get(id) ?? 0) + 1; seen.set(id, n); return n === 1 ? { state: 'idle', code: first[id] } : 'queued' }, settle: () => 'queued' })
  const svc = receiveOver(t, { dir, db, originals: port, now: c.now, limits: { deferMs: 30_000 } })
  await svc.tick()
  persist(db, Object.keys(first).map((id) => ({ id: id.slice(2), ct: 1 })))
  await svc.tick()
  assert.equal(svc.state().outstanding, 3, 'the ABORTED one is closed')
  assert.equal(svc.counters.closedIdle, 1)
  c.advance(30_001)
  await svc.tick()
  assert.deepEqual(port.calls.at(-1).sort(), ['i:8270000000000000001', 'i:8270000000000000002', 'i:8270000000000000003'])
  assert.equal(svc.state().accepted, 3)
  assert.equal(port.handed.get('i:8270000000000000004'), 1, 'never handed again')
})

test('[F-3][P4] receive\'s share of the hourly requests is 100 REQUESTS (not rows): 14 failing receive rows stop at 100 requests; the user click then downloads at once (no global pause)', async (t) => {
  const userOid = 'oidRECV8280000000000000099'
  // X1 tries 5 times per run, X6 runs 3 times: up to 15 requests per failing row
  const h = await realHarness(t, { obs: { respond: ({ path: p }) => (p.endsWith(userOid) ? null : { status: 503 }) }, stream: { maxAttempts: 5 }, limits: { autoRetryDelayMs: 0 } })
  const rows = Array.from({ length: 14 }, (_, i) => h.photo(String(8280000000000000000n + BigInt(i))))
  persist(h.db, rows)
  for (let i = 0; i < 600 && !h.originals.queueState().receiveHourly; i++) { await h.receive.tick(); await tick(5) }
  await tick(50)
  const q = h.originals.queueState()
  assert.equal(q.receiveHourly, true, JSON.stringify(q))
  assert.equal(q.globalPause, null, 'only receive waits — no global pause')
  const receiveRequests = h.obs.requests.length
  assert.equal(receiveRequests, 100, `receive used exactly its 100 requests: ${receiveRequests}`)
  assert.ok(h.receive.counters.handedOff <= 14, `far below receive's 100 rows/h — the requests are what is capped: ${h.receive.counters.handedOff} rows handed`)
  // an old photo (history, not received) the user clicks
  const user = h.photo('8280000000000000099', { ts: Date.now() - DAY })
  persist(h.db, [user])
  const v = await h.originals.request(`i:${user.id}`)
  assert.ok(['queued', 'running'].includes(v.state), JSON.stringify(v))
  await until(async () => (await h.originals.status([`i:${user.id}`])).items[0].state === 'done', 'the user download', 4000)
  assert.equal(h.obs.requests.filter((r) => r.path.endsWith(userOid)).length, 1)
  assert.equal(h.obs.requests.length, 101, 'receive sent nothing more')
  const held = await h.originals.status([`i:${rows[13].id}`])
  assert.ok(['paused', 'queued'].includes(held.items[0].state), JSON.stringify(held.items[0]))
  assert.equal(held.paused, null, 'the status view shows no global pause to the user')
})

test('[F-4][P7] a photo row persisted before its locator is complete is tried again (bounded): after the watcher fills the columns by UPDATE it is downloaded; one that stays incomplete is closed after 3 tries', async (t) => {
  const h = await realHarness(t)
  const p = h.photo('8290000000000000001')
  const q = h.photo('8290000000000000002')
  persist(h.db, [{ id: p.id, ct: 1 }, { id: q.id, ct: 1 }]) // no key / oid / sid yet; no desktopRows port → LOCATOR_INCOMPLETE
  await h.receive.tick()
  assert.equal(h.receive.state().outstanding, 2, 'kept for a later try')
  assert.equal(h.receive.counters.locatorDeferred, 2)
  h.db.prepare('UPDATE messages SET key_material=?, file_size=?, media_oid=?, media_sid=? WHERE msg_id=?').run(p.key, p.size, p.oid, p.sid, `i:${p.id}`)
  await h.receive.tick()
  assert.equal(h.obs.requests.length, 0, 'not due yet')
  assert.equal(RECEIVE_LIMITS.locatorRetryMs, 60_000)
  assert.equal(RECEIVE_LIMITS.locatorRetries, 3)
  for (let i = 0; i < 3; i++) { h.clock.advance(60_001); await h.receive.tick(); await h.originals.whenIdle() }
  await h.receive.tick()
  assert.equal(h.obs.requests.length, 1, 'the completed row was received')
  assert.ok(h.obs.requests[0].path.endsWith(p.oid))
  assert.equal(h.media.prepare(`i:${p.id}`).ok, true)
  assert.equal(h.receive.state().outstanding, 0, 'the incomplete one is closed after 3 more tries')
  assert.equal(h.receive.counters.locatorDeferred, 1 + 3, 'p once, q three times')
  h.clock.advance(10 * 60_000)
  await h.receive.tick()
  assert.equal(h.receive.counters.locatorDeferred, 4, 'never tried again')
})

test('[F-7][V3] the hourly hand-off budget survives a restart: rows handed before it count against the hour after it', async (t) => {
  const dir = await workdir(t)
  const db = appDb()
  t.after(() => db.close())
  const c = clock(Date.now())
  const sw = makeSwitch(true)
  const limits = { ...QUIET, perHour: 2 }
  const a = new LineJsReceiveService({ dataDir: dir, getDb: () => db, originals: fakeOriginals(), session: { currentSessionId: () => 's' }, receiveSwitch: sw, limits, now: c.now })
  await a.tick()
  persist(db, [1, 2].map((n) => ({ id: `830000000000000000${n}`, ct: 1 })))
  await a.tick()
  await a.tick() // both done
  assert.equal(a.state().handedLastHour, 2)
  await a.dispose()
  c.advance(10 * 60_000)
  persist(db, [3, 4].map((n) => ({ id: `830000000000000000${n}`, ct: 1 })))
  const port = fakeOriginals()
  const b = receiveOver(t, { dir, db, originals: port, sw, limits, now: c.now })
  await b.tick()
  assert.deepEqual(port.calls, [], 'the hour is used up across the restart')
  assert.equal(b.state().handedLastHour, 2)
  c.advance(HOUR)
  await b.tick()
  assert.deepEqual(port.calls, [['i:8300000000000000003', 'i:8300000000000000004']])
})

test('[F-7][V5] session not ready at admission (needs_login) is not a result: the row stays outstanding and is handed again later', async (t) => {
  const dir = await workdir(t)
  const db = appDb()
  t.after(() => db.close())
  const c = clock(Date.now())
  let ready = false
  const port = fakeOriginals({ policy: () => (ready ? 'queued' : { state: 'needs_login', code: 'SESSION_NOT_READY' }) })
  const svc = receiveOver(t, { dir, db, originals: port, now: c.now, limits: { deferMs: 30_000 } })
  await svc.tick()
  persist(db, [{ id: '8310000000000000001', ct: 1 }])
  await svc.tick()
  assert.equal(svc.state().outstanding, 1)
  assert.equal(svc.state().accepted, 0)
  ready = true
  c.advance(30_001)
  await svc.tick()
  assert.equal(port.handed.get('i:8310000000000000001'), 2, 'handed again')
  assert.equal(svc.state().accepted, 1)
})

// ───────────────────────── review-fix-final NF-1（登出後再登入）、NF-4（status 暫時讀不到 app DB）─────────────────────────

/**
 * Reviewer probe N2's setup: a user click holds the single interactive lane, a new photo row is handed by receive and queued behind it
 * (accepted). `opts.db` / `persistTo`: the app DB the harness uses and the real one rows are written to (NF-4 wraps it).
 */
async function acceptedBehindClick(t, base, opts = {}) {
  const hold = new Map()
  let release
  const h = await realHarness(t, { obs: { hold }, receiveLimits: { deferMs: 30_000, pollMs: 5_000 }, ...(opts.db ? { db: opts.db } : {}) })
  const into = opts.persistTo ?? h.db
  const u = h.photo(String(base + 1n))
  const r = h.photo(String(base + 2n))
  hold.set(`/r/talk/emi/${u.oid}`, new Promise((resolve) => { release = resolve }))
  await h.sw.set(false)
  persist(into, [u])
  await h.sw.set(true)
  await h.originals.request(`i:${u.id}`)
  for (let i = 0; i < 100 && !h.obs.requests.length; i++) await tick()
  persist(into, [r])
  await h.receive.tick()
  assert.equal(h.receive.state().accepted, 1, 'receive handed the new photo (queued behind the user click)')
  const reqs = () => h.obs.requests.filter((q) => q.path.endsWith(r.oid)).length
  return { h, u, r, release: () => release(), reqs }
}

/** logout while the row is accepted: X6 drops every job; receive keeps the row (it never reads status without a session) */
async function logoutWhileAccepted(s) {
  const { h, r } = s
  h.sessions.install(null)
  s.release()
  await h.originals.whenIdle()
  h.clock.advance(5_001); await h.receive.tick()
  h.clock.advance(60_000); await h.receive.tick()
  assert.equal(h.receive.state().outstanding, 1, 'kept while logged out')
  assert.equal((await h.originals.status([`i:${r.id}`])).items[0].state, 'needs_login')
}

test('[NF-1][N2] logout, then login again with the SAME account: the accepted receive row X6 dropped at the logout is handed again and downloaded once (only a user cancel closes it)', async (t) => {
  const s = await acceptedBehindClick(t, 8320000000000000000n)
  const { h, r } = s
  await logoutWhileAccepted(s)
  h.sessions.install({ client: fakeClient('token-2'), sessionId: 'sess-2', ownerMid: ME })
  await tick(20)
  const st = (await h.originals.status([`i:${r.id}`])).items[0]
  assert.deepEqual([st.state, st.code], ['idle', 'SESSION_ENDED'], 'X6 tells a logout drop apart from a user cancel')
  for (let k = 0; k < 4; k++) { await h.receive.tick(); h.clock.advance(30_001); await h.originals.whenIdle() }
  assert.equal(s.reqs(), 1, 'handed again after the login and downloaded once')
  assert.equal(h.media.prepare(`i:${r.id}`).ok, true)
  assert.equal(h.receive.counters.closedIdle, 0, 'never closed')
  assert.equal(h.receive.counters.rehanded, 1)
  assert.equal(h.receive.state().outstanding, 0, 'settled once it landed')
  assert.equal((await h.originals.status([`i:${r.id}`])).items[0].state, 'done')
})

test('[NF-1][ADJ-X2BF-01] logout, then login with ANOTHER account (the desktop LINE switched too): the accepted row is closed — never handed again under the new account, 0 requests for it', async (t) => {
  const s = await acceptedBehindClick(t, 8330000000000000000n)
  const { h, r } = s
  await logoutWhileAccepted(s)
  h.env.localMid = OTHER
  h.sessions.install({ client: fakeClient('token-3'), sessionId: 'sess-3', ownerMid: OTHER })
  await tick(20)
  const st = (await h.originals.status([`i:${r.id}`])).items[0]
  assert.deepEqual([st.state, st.code], ['idle', undefined], 'another account: a plain idle')
  for (let k = 0; k < 4; k++) { await h.receive.tick(); h.clock.advance(30_001); await h.originals.whenIdle() }
  assert.equal(s.reqs(), 0, 'not downloaded under the new account')
  assert.equal(h.receive.counters.closedIdle, 1)
  assert.equal(h.receive.counters.rehanded, 0)
  assert.equal(h.receive.state().outstanding, 0)
})

test('[NF-1] logout and a same-account login, then the user cancels the cell before receive asks again: the user cancel closes it — 0 requests', async (t) => {
  const s = await acceptedBehindClick(t, 8340000000000000000n)
  const { h, r } = s
  await logoutWhileAccepted(s)
  h.sessions.install({ client: fakeClient('token-4'), sessionId: 'sess-4', ownerMid: ME })
  await tick(20)
  const c = await h.originals.cancel(`i:${r.id}`)
  assert.deepEqual([c.state, c.code], ['idle', undefined], 'after the cancel: a plain idle')
  for (let k = 0; k < 4; k++) { await h.receive.tick(); h.clock.advance(30_001); await h.originals.whenIdle() }
  assert.equal(s.reqs(), 0)
  assert.equal(h.receive.counters.closedIdle, 1)
  assert.equal(h.receive.counters.rehanded, 0)
})

test('[NF-4][N9] status cannot read the app DB for a moment (idle / APP_DB_UNAVAILABLE) while X6 still holds the accepted row: not closed — deferred, handed again later (it joins X6\'s job), settled once it lands; downloaded once', async (t) => {
  let failMsgRead = false
  const real = appDb()
  const db = {
    prepare: (sql) => { if (failMsgRead && /FROM messages WHERE msg_id/.test(sql)) throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' }); return real.prepare(sql) },
    close: () => real.close(),
  }
  const s = await acceptedBehindClick(t, 8350000000000000000n, { db, persistTo: real })
  const { h, r } = s
  failMsgRead = true
  const st = (await h.originals.status([`i:${r.id}`])).items[0]
  assert.deepEqual([st.state, st.code], ['idle', 'APP_DB_UNAVAILABLE'])
  await h.receive.tick()
  failMsgRead = false
  assert.equal(h.receive.counters.closedIdle, 0, 'a failed read is not a result')
  assert.equal(h.receive.state().outstanding, 1)
  assert.equal(h.receive.state().accepted, 0, 'deferred: handed again later')
  assert.equal(h.receive.counters.deferred, 1)
  h.clock.advance(30_001)
  await h.receive.tick()
  assert.equal(h.receive.state().accepted, 1, 'handed again: it joined the job X6 still has')
  s.release()
  await h.originals.whenIdle()
  await h.receive.tick()
  assert.equal(s.reqs(), 1, 'downloaded once')
  assert.equal(h.receive.state().outstanding, 0, 'settled (done)')
  assert.equal(h.receive.counters.closedIdle, 0)
})

// ───────────────────────── RF2 (review-final-r2): logout while a job unwinds / is in flight; the same account again ─────────────────────────

test('[RF2-1] cancel → logout race: the user cancels a RUNNING receive job whose send-time account read is still pending, logs out before that job has unwound, then logs in again with the SAME account — the cancelled row stays closed (0 requests)', async (t) => {
  const pending = []
  let calls = 0
  const h = await realHarness(t, { receiveLimits: { deferMs: 30_000, pollMs: 5_000 }, localAccountMid: () => (++calls === 2 ? new Promise((resolve) => pending.push(resolve)) : ME) })
  const r = h.photo('7990000000000000101')
  const reqs = () => h.obs.requests.filter((q) => q.path.endsWith(r.oid)).length
  persist(h.db, [r])
  await h.receive.tick()
  for (let i = 0; i < 200 && !pending.length; i++) await tick()
  assert.equal(pending.length, 1, 'the send-time read of the running job is pending')
  assert.equal(h.receive.state().accepted, 1)
  await h.originals.cancel(`i:${r.id}`) // 取消 in X7
  h.sessions.install(null) // logout while the cancelled job is still unwinding
  for (const resolve of pending) resolve(ME)
  await h.originals.whenIdle()
  h.sessions.install({ client: fakeClient('token-2'), sessionId: 'sess-2', ownerMid: ME })
  await tick(20)
  const st = (await h.originals.status([`i:${r.id}`])).items[0]
  for (let k = 0; k < 4; k++) { await h.receive.tick(); h.clock.advance(30_001); await h.originals.whenIdle() }
  t.diagnostic(`statusAfterLogin=${JSON.stringify(st)} counters=${JSON.stringify(h.receive.counters)} requests=${reqs()}`)
  assert.equal(reqs(), 0, 'a row the user cancelled is never downloaded without a user action')
  assert.equal(h.receive.counters.rehanded, 0, 'the logout did not record it as dropped')
})

test('[RF2-2] a receive job RUNNING at the logout (request in flight), same-account login: handed again, the file lands once with the right bytes, no request after it landed', async (t) => {
  const hold = new Map()
  let release
  const h = await realHarness(t, { obs: { hold }, receiveLimits: { deferMs: 30_000, pollMs: 5_000 } })
  const r = h.photo('7990000000000000201')
  const reqs = () => h.obs.requests.filter((q) => q.path.endsWith(r.oid)).length
  hold.set(`/r/talk/emi/${r.oid}`, new Promise((resolve) => { release = resolve }))
  persist(h.db, [r])
  await h.receive.tick()
  for (let i = 0; i < 200 && !h.obs.requests.length; i++) await tick()
  assert.equal(reqs(), 1, 'in flight')
  h.sessions.install(null)
  hold.delete(`/r/talk/emi/${r.oid}`)
  release()
  await h.originals.whenIdle()
  h.clock.advance(5_001); await h.receive.tick()
  h.sessions.install({ client: fakeClient('token-2'), sessionId: 'sess-2', ownerMid: ME })
  await tick(20)
  const st = (await h.originals.status([`i:${r.id}`])).items[0]
  for (let k = 0; k < 4; k++) { await h.receive.tick(); h.clock.advance(30_001); await h.originals.whenIdle() }
  const afterLanded = reqs()
  for (let k = 0; k < 4; k++) { await h.receive.tick(); h.clock.advance(30_001); await h.originals.whenIdle() }
  const files = (await readdir(path.join(h.dir, SAVED_MEDIA_DIR))).filter((f) => f.startsWith(mediaCacheStem(`i:${r.id}`)))
  const saved = files.length ? await readFile(path.join(h.dir, SAVED_MEDIA_DIR, files[0])) : null
  t.diagnostic(`statusAfterLogin=${JSON.stringify(st)} counters=${JSON.stringify(h.receive.counters)} requests=${reqs()} files=${JSON.stringify(files)}`)
  assert.ok(saved && Buffer.compare(saved, r.body) === 0, 'landed with the original bytes')
  assert.ok(reqs() <= 2, 'at most the aborted request + one more')
  assert.equal(reqs(), afterLanded, 'nothing more once it landed')
  assert.equal(h.receive.state().outstanding, 0)
})

test('[RF2-2] logout, then the same account is back and receive hands the row again, but the download fails (OBS 404): the status is failed or expired — never idle / SESSION_ENDED', async (t) => {
  const s = await acceptedBehindClick(t, 8360000000000000000n)
  const { h, r } = s
  await logoutWhileAccepted(s)
  h.objects.delete(`/r/talk/emi/${r.oid}`) // OBS has no such object any more: every request answers 404
  h.sessions.install({ client: fakeClient('token-5'), sessionId: 'sess-5', ownerMid: ME })
  await tick(20)
  for (let k = 0; k < 4; k++) { await h.receive.tick(); h.clock.advance(30_001); await h.originals.whenIdle() }
  const st = (await h.originals.status([`i:${r.id}`])).items[0]
  t.diagnostic(`statusAfterLogin=${JSON.stringify(st)} counters=${JSON.stringify(h.receive.counters)} requests=${s.reqs()}`)
  assert.equal(h.receive.counters.rehanded, 1, 'handed again after the same-account login')
  assert.ok(s.reqs() >= 1, 'the download was tried')
  assert.ok(['failed', 'expired'].includes(st.state), `status after the failed download: ${JSON.stringify(st)}`)
  assert.notEqual(st.code, 'SESSION_ENDED', 'a finished job is not reported as a logout drop')
})

// ───────────────────────── log hygiene ─────────────────────────

test('[LOG] receive log lines carry only events, counts and codes — no message id, chat id or path', async (t) => {
  const h = await realHarness(t)
  h.env.localMid = OTHER
  const p = h.photo('8100000000000000001')
  persist(h.db, [p])
  await h.receive.tick()
  h.env.localMid = ME
  await h.sw.set(false)
  await h.sw.set(true)
  const receiveLines = h.logs.filter((l) => l.startsWith('[receive]'))
  assert.ok(receiveLines.length >= 2)
  for (const line of h.logs) for (const secret of [p.id, GROUP, CHAT_NAME, h.dir, p.oid]) assert.ok(!line.includes(secret), `log leaks: ${line}`)
})
