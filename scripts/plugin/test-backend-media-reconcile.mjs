// Phase 3 — unit tests for the backend wiring the board UI needs, on plain Node 24 with the node:sqlite test adapter:
//   * media: LINE E2EE image -> decrypted from the (fake) LINE cache -> written under dataDir/media-cache -> returned as an asset path the
//     1.6.8 host can serve through `assets.url()` (`/data/<path>`); failure codes; cache cap; re-index throttle; unsupported open/saveAs
//   * self-reconcile (`runReconcile`) and the recall scan are wired into createPluginBackend, progress goes to the EventHub
// (The same media path under the real 1.6.8 permission model + koffi fs is exercised by test-backend-contract.mjs, scenario "media".)
import assert from 'node:assert/strict'
import { createCipheriv, createHmac, hkdfSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createNodeLineFsPort } from '../../src/main/line/engine/nodeLineFsPort.ts'
import { Dispatcher } from '../../src/plugin/backend/dispatcher.ts'
import { EventHub } from '../../src/plugin/backend/eventHub.ts'
import { createPluginBackend } from '../../src/plugin/backend/assemble.ts'

// ───────────── helpers ─────────────

function raw(i, { chatId = 'u-alice', chat = 'Alice', isGroup = false, text, ts } = {}) {
  const t = ts ?? 1_700_000_000_000 + i * 1000
  return { msgId: `m${i}`, chat, chatId, isGroup, ts: t, time: new Date(t).toISOString(), direction: 'in', sender: chat, text: text ?? `請幫我處理第 ${i} 件事情，明天要交`, contentType: 0 }
}

function fakeLine() {
  const messageListeners = new Set()
  const statusListeners = new Set()
  let running = false
  const port = {
    start() { running = true },
    stop() { running = false },
    status: () => ({ state: running ? 'running' : 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 }),
    onMessage(cb) { messageListeners.add(cb); return () => messageListeners.delete(cb) },
    onStatus(cb) { statusListeners.add(cb); return () => statusListeners.delete(cb) },
    getMessagesSince: async () => []
  }
  return { port, emit: (m) => messageListeners.forEach((cb) => cb(m)) }
}

const IKM_B64 = Buffer.alloc(32, 7).toString('base64')

/** Mirror of the decrypt recipe in src/main/media/decrypt.ts (the "writer" side): [ciphertext][HMAC-SHA256(macKey, ciphertext)]. */
function makeEimg(plain, keyMaterialB64 = IKM_B64) {
  const derived = Buffer.from(hkdfSync('sha256', Buffer.from(keyMaterialB64, 'base64'), Buffer.alloc(32, 0), Buffer.from('FileEncryption'), 76))
  const nonce = Buffer.concat([derived.subarray(64, 76), Buffer.alloc(4, 0)])
  const cipher = createCipheriv('aes-256-ctr', derived.subarray(0, 32), nonce)
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([ciphertext, createHmac('sha256', derived.subarray(32, 64)).update(ciphertext).digest()])
}
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const pngBytes = (n, fill = 0x5a) => Buffer.concat([PNG_HEAD, Buffer.alloc(n, fill)])
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0])

/** The path rules the 1.6.8 host applies to `assets.url(path)` -> `/data/<path>` (pluginDataFiles.ts segmentsOf + entryNames.ts auditEntryName). */
export function assertHostServablePath(relative) {
  assert.ok(relative.length <= 200)
  assert.ok(!relative.includes('\\') && !relative.includes(':') && !relative.startsWith('/') && !/[<>"|?*\p{Cc}]/u.test(relative))
  for (const segment of relative.split('/')) {
    assert.ok(segment.length > 0 && segment.length <= 100, `segment length of ${segment}`)
    assert.ok(!segment.startsWith('.') && segment !== '..' && !segment.endsWith('.') && !segment.endsWith(' '), `segment ${segment}`)
  }
  assert.match(relative, /\.(jpg|png|gif|webp)$/, 'a type the host MIME table serves')
}

function imageMessage(i, { keyMaterial = IKM_B64, fileSize, contentType = 1, chatId = 'u-alice' } = {}) {
  return { ...raw(i, { chatId, text: '[image]' }), contentType, keyMaterial, fileSize, fileName: null }
}

function mediaFixture() {
  const root = mkdtempSync(join(tmpdir(), 'plugin-media-'))
  const cacheDir = join(root, 'LINE', 'Cache')
  mkdirSync(join(cacheDir, 'a', 'b'), { recursive: true })
  return { root, cacheDir, dataDir: join(root, 'data'), drop: (name, buf) => writeFileSync(join(cacheDir, 'a', 'b', name), buf), cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

async function withMediaBackend(fx, extra, body) {
  const line = fakeLine()
  const backend = await createPluginBackend({ pluginId: 'tuqdev.line-todo', version: '1', dataDir: fx.dataDir, line: line.port, media: { fs: createNodeLineFsPort(), cacheDir: fx.cacheDir, ...extra } })
  const call = (path, ...args) => backend.call('api.invoke', { path, args })
  try { await body({ backend, call, line }) } finally { await backend.dispose() }
}

// ───────────── media ─────────────

test('media: an image is decrypted from the LINE cache, written under dataDir/media-cache and handed out as a host-servable asset path', async () => {
  const fx = mediaFixture()
  const plain = pngBytes(3000)
  fx.drop('0001.eimg', makeEimg(plain))
  fx.drop('decoy.eimg', Buffer.alloc(plain.length + 32, 1)) // same size, wrong HMAC: must not be picked
  try {
    await withMediaBackend(fx, {}, async ({ call, line }) => {
      line.emit(imageMessage(1, { fileSize: plain.length }))
      const id = 'i:m1'
      const prepared = await call('media.prepare', id)
      assert.equal(prepared.ok, true, JSON.stringify(prepared))
      assert.equal(prepared.value.cached, false)
      assert.equal(prepared.value.mime, 'image/png')
      assert.equal(prepared.value.size, plain.length)
      assertHostServablePath(prepared.value.path)
      assert.ok(prepared.value.path.startsWith('media-cache/'))
      // the file really is in dataDir, byte for byte the plaintext (what assets.url -> /data/<path> will stream)
      assert.deepEqual(readFileSync(join(fx.dataDir, ...prepared.value.path.split('/'))), plain)
      assert.deepEqual(readdirSync(join(fx.dataDir, 'media-cache')).filter((n) => n.startsWith('.')), [], 'no temporary file left behind')

      // second call: served from the cache, no second write; { msgId } form works too
      const again = await call('media.prepare', { msgId: id })
      assert.equal(again.value.cached, true)
      assert.equal(again.value.path, prepared.value.path)
      assert.equal((await call('backend.info')).value.media.written, 1)
      // the cache survives the LINE cache going away (that is the point of writing it to dataDir)
      rmSync(fx.cacheDir, { recursive: true, force: true })
      assert.equal((await call('media.prepare', id)).value.cached, true)

      // key material never travels through the DB listing
      const messages = (await call('db.messages.list', { chatId: 'u-alice' })).value
      assert.equal(messages.length, 1)
      assert.ok(messages.every((m) => !('keyMaterial' in m) && !('key_material' in m)))
    })
  } finally { fx.cleanup() }
})

test('media: every failure is a structured in-band code and writes nothing; open / saveAs stay unsupported', async () => {
  const fx = mediaFixture()
  const plain = Buffer.concat([JPEG_HEAD, Buffer.alloc(500, 3)])
  fx.drop('wrongkey.eimg', makeEimg(Buffer.concat([JPEG_HEAD, Buffer.alloc(796, 3)]), Buffer.alloc(32, 9).toString('base64')))
  try {
    await withMediaBackend(fx, { reindexMinIntervalMs: 0 }, async ({ call, line }) => {
      line.emit(imageMessage(1, { fileSize: plain.length })) // not cached
      line.emit(imageMessage(2, { fileSize: 800 })) // a candidate of the right size exists, but it was encrypted with another key
      line.emit(raw(3, { text: '純文字' }))
      line.emit(imageMessage(4, { fileSize: 10, keyMaterial: null })) // no key material
      line.emit({ ...imageMessage(5, { fileSize: 10, contentType: 14 }), fileName: 'a.pdf' })
      const notAnImage = Buffer.from('this is not an image at all, just text')
      fx.drop('weird.eimg', makeEimg(notAnImage))
      line.emit(imageMessage(6, { fileSize: notAnImage.length }))
      const code = async (arg) => (await call('media.prepare', arg)).code
      assert.equal(await code('i:m1'), 'not_cached')
      assert.equal(await code('i:m2'), 'hmac_miss')
      assert.equal(await code('i:m3'), 'not_image')
      assert.equal(await code('i:m4'), 'no_key')
      assert.equal(await code('i:m5'), 'not_image', 'files (content type 14) are not served in the plugin')
      assert.equal(await code('i:m6'), 'unsupported_format')
      assert.equal(await code('i:nope'), 'not_found')
      for (const bad of [undefined, 7, '', 'x'.repeat(300), {}, { msgId: 5 }]) assert.equal(await code(bad), 'invalid_args', JSON.stringify(bad))
      assert.equal((await call('media.open', 'i:m1')).code, 'unsupported_in_plugin')
      assert.equal((await call('media.saveAs', 'i:m1')).code, 'unsupported_in_plugin')
      assert.ok(!existsSync(join(fx.dataDir, 'media-cache')) || readdirSync(join(fx.dataDir, 'media-cache')).length === 0, 'failures write nothing')
    })
  } finally { fx.cleanup() }
})

test('media: without a known LINE cache directory it says so instead of guessing; a .eimg that appears later is found, but the index is rebuilt at most once per interval', async () => {
  const fx = mediaFixture()
  try {
    const line = fakeLine()
    const backend = await createPluginBackend({ pluginId: 'p', version: '1', dataDir: fx.dataDir, line: line.port })
    try {
      line.emit(imageMessage(1, { fileSize: 10 }))
      assert.equal((await backend.call('api.invoke', { path: 'media.prepare', args: ['i:m1'] })).code, 'media_unavailable')
    } finally { await backend.dispose() }

    let clock = 1_000_000
    const plain = pngBytes(900)
    await withMediaBackend(fx, { reindexMinIntervalMs: 60_000, now: () => clock }, async ({ call, line: l }) => {
      l.emit(imageMessage(2, { fileSize: plain.length }))
      assert.equal((await call('media.prepare', 'i:m2')).code, 'not_cached')
      fx.drop('late.eimg', makeEimg(plain)) // LINE finishes the download after the index was built
      clock += 10_000
      assert.equal((await call('media.prepare', 'i:m2')).code, 'not_cached', 'not rebuilt more often than the interval')
      clock += 60_000
      const found = await call('media.prepare', 'i:m2')
      assert.equal(found.ok, true, JSON.stringify(found))
      assert.equal(found.value.size, plain.length)
    })
  } finally { fx.cleanup() }
})

test('media: the cache is capped (oldest files go first, the newest stays); a dispatcher without a media service refuses cleanly', async () => {
  const fx = mediaFixture()
  try {
    await withMediaBackend(fx, { maxCacheBytes: 10_000 }, async ({ call, line }) => {
      const paths = []
      for (let i = 0; i < 4; i += 1) {
        const n = 4000
        fx.drop(`p${i}.eimg`, makeEimg(pngBytes(n, 10 + i)))
        line.emit(imageMessage(i + 1, { fileSize: n + PNG_HEAD.length }))
        const r = await call('media.prepare', `i:m${i + 1}`)
        assert.equal(r.ok, true, JSON.stringify(r))
        paths.push(r.value.path.split('/').pop())
        await new Promise((resolve) => setTimeout(resolve, 20)) // distinct mtimes
      }
      const left = readdirSync(join(fx.dataDir, 'media-cache'))
      assert.ok(left.length < 4, `pruned (${left.length} left)`)
      assert.ok(left.includes(paths.at(-1)), 'the newest file is never pruned')
      assert.ok(!left.includes(paths[0]), 'the oldest file went first')
      const total = left.reduce((n, f) => n + statSync(join(fx.dataDir, 'media-cache', f)).size, 0)
      assert.ok(total <= 10_000, `cache bytes ${total}`)
    })
    const d = new Dispatcher({ getApi: () => ({}), hub: new EventHub(), queue: { stats: () => ({}) } })
    assert.equal((await d.call('api.invoke', { path: 'media.prepare', args: ['x'] })).code, 'media_unavailable')
    d.dispose()
  } finally { fx.cleanup() }
})

// ───────────── self-reconcile ─────────────

function monthFixture() {
  const month = new Date()
  month.setMonth(month.getMonth() - 2)
  month.setDate(10)
  month.setHours(12, 0, 0, 0)
  const ym = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`
  const history = [1, 2, 3].map((i) => raw(100 + i, { ts: month.getTime() + i * 60_000, text: `舊歷史第 ${i} 則` }))
  const deps = {
    getSourceFingerprint: async () => new Map([[ym, { count: history.length, lo: history[0].ts, hi: history.at(-1).ts }]]),
    getMessagesSince: async (since) => history.filter((m) => m.ts > since),
    sourceDbPath: null
  }
  return { ym, history, deps }
}

async function collectReconcilePhases(call, session, { until, tries = 40 }) {
  const phases = []
  let afterSeq = session.seq
  for (let i = 0; i < tries; i += 1) {
    const pulled = (await call('events.pull', { sessionId: session.sessionId, afterSeq, waitMs: 50 })).value
    afterSeq = pulled.seq
    for (const e of pulled.events) if (e.type === 'reconcile-progress') phases.push(e.payload.phase)
    if (until(phases)) break
  }
  return phases
}

test('reconcile: the boot reconcile runs through the same runReconcile, backfills the missing month into the app DB and reports progress as events', async () => {
  const { history, deps } = monthFixture()
  const dataDir = mkdtempSync(join(tmpdir(), 'plugin-reconcile-'))
  const line = fakeLine()
  const backend = await createPluginBackend({ pluginId: 'p', version: '1', dataDir, line: line.port, reconcile: deps })
  const call = (path, ...args) => backend.call('api.invoke', { path, args })
  try {
    const session = (await call('events.open', { sinceSeq: 0 })).value
    const phases = await collectReconcilePhases(call, session, { until: (p) => p.includes('done') })
    assert.deepEqual([...new Set(phases)], ['scanning', 'backfilling', 'done'])
    const stored = (await call('db.messages.list', { limit: 50 })).value
    assert.equal(stored.length, history.length, 'the missing month was backfilled')
    assert.ok(stored.every((m) => m.processed === true), 'history older than 7 days is stored as processed (no LLM budget burnt)')
    assert.ok(!existsSync(join(dataDir, '.reconcile_lock')), 'single-flight lock released')
    assert.ok(existsSync(join(dataDir, 'reconcile-state.json')), 'checkpoint advanced after a complete backfill')
  } finally {
    await backend.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('reconcile: the settings switch (reconcile.enabled=false) keeps it from running', async () => {
  const { deps } = monthFixture()
  const dataDir = mkdtempSync(join(tmpdir(), 'plugin-reconcile-off-'))
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ version: 1, reconcile: { enabled: false, scopeMonths: 0 } }))
  const line = fakeLine()
  let sourceReads = 0
  const backend = await createPluginBackend({ pluginId: 'p', version: '1', dataDir, line: line.port, reconcile: { ...deps, getSourceFingerprint: async () => { sourceReads += 1; return deps.getSourceFingerprint() } } })
  const call = (path, ...args) => backend.call('api.invoke', { path, args })
  try {
    assert.equal((await call('settings.get')).value.reconcile.enabled, false, 'the settings file was honoured')
    const session = (await call('events.open', { sinceSeq: 0 })).value
    assert.deepEqual(await collectReconcilePhases(call, session, { until: () => false, tries: 5 }), [])
    assert.equal(sourceReads, 0)
    assert.equal((await call('db.messages.list', { limit: 5 })).value.length, 0)
  } finally {
    await backend.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('reconcile: it is not wired for a bare fake LINE port (it would open the real LINE directory), and reconcile:false turns it off', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'plugin-reconcile-none-'))
  const a = await createPluginBackend({ pluginId: 'p', version: '1', dataDir: join(dataDir, 'a'), line: fakeLine().port })
  const b = await createPluginBackend({ pluginId: 'p2', version: '1', dataDir: join(dataDir, 'b'), line: fakeLine().port, reconcile: false })
  try {
    await new Promise((resolve) => setTimeout(resolve, 100))
    for (const backend of [a, b]) {
      const calls = (await backend.call('api.invoke', { path: 'events.open', args: [{ sinceSeq: 0 }] })).value
      const pulled = (await backend.call('api.invoke', { path: 'events.pull', args: [{ sessionId: calls.sessionId, afterSeq: 0 }] })).value
      assert.equal(pulled.events.some((e) => e.type === 'reconcile-progress'), false)
    }
    assert.equal(existsSync(join(dataDir, 'a', '.reconcile_lock')) || existsSync(join(dataDir, 'b', '.reconcile_lock')), false)
  } finally {
    await a.dispose()
    await b.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
