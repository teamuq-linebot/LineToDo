// Review repair (F2 / F6 / F7) — the plugin backend's start-up path under the 1.6.8 backend contract:
//   * activate() returns BEFORE the first key extraction and the first import start (the host sends boot-ack after activate(); bootTimeoutSec is 30)
//   * a long LINE-memory scan yields to the event loop: call() keeps answering and the event loop never stalls for long while it runs
//   * a key that cannot be found backs off (no full memory scan every 15 s) and is retried later; "LINE is not running" is not a failed scan
//   * dispose during a scan cancels it at the next yield point and leaves no snapshot directory behind
//   * the boot reconcile shares the single scan with the watcher (single-flight) and its default key cache path is dataDir/.linekey, not the process cwd (F6)
//   * the watcher's log lines never carry message content (F7)
//
// The LINE side is fake: a "database" file nobody can read, a SQLite port that only accepts one key, and an injected memory scanner that burns CPU the way
// a real scan does (the production koffi scanner is exercised against real memory by the Electron 44 contract test, which runs with a cached key).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { configureLineEnginePorts, resetLineEnginePorts } from '../../src/main/line/engine/enginePorts.ts'
import { RecoverGuard, getKey, getKeyAsync, recoverKeyAsync } from '../../src/main/line/engine/linekey.ts'
import { createNodeLineFsPort } from '../../src/main/line/engine/nodeLineFsPort.ts'
import { LineWatcher } from '../../src/main/line/watcher.ts'
import { createPluginBackend } from '../../src/plugin/backend/assemble.ts'

const GOOD_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const busyWait = (ms) => { const end = performance.now() + ms; while (performance.now() < end) { /* a real scan burns CPU like this */ } }
async function until(predicate, { timeout = 8000, step = 10, message = 'condition' } = {}) {
  const t0 = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - t0 > timeout) assert.fail(`timed out waiting for ${message}`)
    await sleep(step)
  }
}

/** Measures how long the event loop is stalled (largest gap between 10 ms ticks). */
function loopMonitor() {
  let last = performance.now()
  let max = 0
  const timer = setInterval(() => { const now = performance.now(); max = Math.max(max, now - last); last = now }, 10)
  return { maxGapMs: () => max, reset: () => { max = 0; last = performance.now() }, stop: () => clearInterval(timer) }
}

const md5hex = (n) => createHash('md5').update(`candidate-${n}`).digest('hex') // 32 hex characters, none of them the key

/** A memory scanner: `chunks` chunks that each cost `chunkMs` of CPU and hold one 32-hex candidate; the good key sits in chunk `keyAt` (or nowhere). */
function fakeScanner({ chunks, chunkMs, keyAt = null }) {
  const stats = { started: 0, chunks: 0, finished: 0, startedAt: 0 }
  const scan = async (pid, onChunk) => {
    stats.started += 1
    stats.startedAt = Date.now()
    for (let i = 0; i < chunks; i += 1) {
      busyWait(chunkMs)
      stats.chunks += 1
      const candidate = i === keyAt ? GOOD_KEY : md5hex(i)
      if ((await onChunk(Buffer.from(`zz ${candidate} zz`, 'latin1'))) === false) { stats.finished += 1; return }
    }
    stats.finished += 1
  }
  return { scan, stats }
}

/** The fake LINE install: a directory with one "database" and the ports the engine needs. `lineRunning` controls whether LINE.exe is found. */
function makeStage() {
  const root = mkdtempSync(join(tmpdir(), 'plugin-startup-'))
  const dbDir = join(root, 'LINE', 'Data', 'db')
  const dataDir = join(root, 'data')
  mkdirSync(dbDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dbDir, 'qw0001.edb'), Buffer.alloc(64 * 1024, 5))
  // LINE reads / reconcile off by default: tests that want the boot reconcile turn it on
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ version: 1, reconcile: { enabled: false, scopeMonths: 0 } }))
  const state = { lineRunning: true, opened: [] }
  const fs = Object.assign(createNodeLineFsPort({ tempRoot: join(dataDir, 'line-engine') }), { listProcessIds: () => (state.lineRunning ? [4242] : []) })
  mkdirSync(join(dataDir, 'line-engine'), { recursive: true })
  const sqlite = {
    name: 'fake',
    open(path) {
      let key = ''
      return {
        pragma(source) { const m = /^key='(.*)'$/.exec(source); if (m) key = m[1]; return [] },
        prepare(sql) {
          return {
            get() { if (/sqlite_master/.test(sql) && key !== GOOD_KEY) throw new Error('file is not a database'); return /sqlite_master/.test(sql) ? { 'count(*)': 1 } : undefined },
            all() { if (key !== GOOD_KEY) throw new Error('file is not a database'); return [] }
          }
        },
        close() { state.opened.push(path) }
      }
    }
  }
  return { root, dbDir, dataDir, fs, sqlite, state, linePorts: { fs, sqlite, dbDir }, cleanup: () => { resetLineEnginePorts(); rmSync(root, { recursive: true, force: true }) } }
}

const info = async (backend) => (await backend.call('backend', { path: 'backend.info', args: [] })).value
const lineStatus = async (backend) => (await backend.call('line', { path: 'line.status', args: [] })).value
const ping = async (backend) => backend.call('ping', { path: 'ping', args: [] })

let savedKeyEnv
test.before(() => { savedKeyEnv = process.env.LINE_DB_KEY; delete process.env.LINE_DB_KEY })
test.after(() => { resetLineEnginePorts(); if (savedKeyEnv !== undefined) process.env.LINE_DB_KEY = savedKeyEnv })

// ───────────── F2: activate() does not wait for the key scan or the first import ─────────────

test('F2: activate() returns before the key scan and the first import begin; during the scan call() keeps answering and the event loop is never stalled; the import then completes', async () => {
  const stage = makeStage()
  const scanner = fakeScanner({ chunks: 100, chunkMs: 10, keyAt: 99 }) // ~1 s of CPU in total
  const monitor = loopMonitor()
  let backend
  try {
    const t0 = Date.now()
    backend = await createPluginBackend({
      pluginId: 'tuqdev.line-todo', version: 'test', dataDir: stage.dataDir, linePorts: stage.linePorts,
      watcher: { intervalSec: 3600, startupDelayMs: 150 },
      keyRecovery: { scanner: scanner.scan, guard: { yieldSliceMs: 5 } }
    })
    const activateMs = Date.now() - t0
    assert.ok(activateMs < 400, `activate took ${activateMs} ms`)
    assert.equal(scanner.stats.started, 0, 'activate() returned before the key scan began (the first poll is deferred)')
    assert.equal((await lineStatus(backend)).state, 'starting', 'the watcher is up, its first poll has not run yet')

    await until(() => scanner.stats.started === 1, { message: 'the deferred first poll to start scanning' })
    assert.ok(scanner.stats.startedAt - t0 >= 140, 'the scan started only after the startup delay')
    monitor.reset()

    // while ~1 s of scanning is going on: calls are answered promptly (the event loop is shared, not monopolised)
    const latencies = []
    while (scanner.stats.finished === 0) {
      const t = performance.now()
      const answer = await ping(backend)
      latencies.push(performance.now() - t)
      assert.equal(answer.ok, true)
      await sleep(15)
    }
    assert.ok(latencies.length >= 8, `only ${latencies.length} calls fitted into the scan: the scan was not interleaved`)
    assert.ok(Math.max(...latencies) < 150, `slowest call during the scan took ${Math.max(...latencies).toFixed(1)} ms`)
    assert.ok(monitor.maxGapMs() < 150, `the event loop stalled for ${monitor.maxGapMs().toFixed(1)} ms during the scan`)

    // the key was found and the first import ran on it
    await until(async () => (await lineStatus(backend)).state === 'running', { message: 'the first import to finish' })
    assert.equal(readFileSync(join(stage.dataDir, '.linekey'), 'utf8'), GOOD_KEY, 'the key is cached in dataDir')
    const state = await info(backend)
    assert.equal(state.keyRecovery.scans, 1)
    assert.equal(state.keyRecovery.blocked, false)
  } finally {
    monitor.stop()
    await backend?.dispose()
    stage.cleanup()
  }
})

test('F2 (control): the same measurement DOES see a stalled event loop when the scan never yields — the monitor is not vacuous', async () => {
  const stage = makeStage()
  const scanner = fakeScanner({ chunks: 60, chunkMs: 10, keyAt: 59 }) // ~0.6 s of CPU
  const monitor = loopMonitor()
  let backend
  try {
    backend = await createPluginBackend({
      pluginId: 'tuqdev.line-todo', version: 'test', dataDir: stage.dataDir, linePorts: stage.linePorts,
      watcher: { intervalSec: 3600, startupDelayMs: 50 },
      // a guard whose "yield" resolves immediately (a microtask) is the old synchronous behaviour in disguise
      keyRecovery: { scanner: scanner.scan, guard: { yieldSliceMs: 5, yieldFn: async () => undefined } }
    })
    // with a blocking scan the timer callback that runs it cannot be interrupted: by the time anything else runs it is over
    await until(() => scanner.stats.finished === 1, { message: 'the scan to finish' })
    await sleep(40) // let the monitor's overdue tick record the gap
    assert.ok(monitor.maxGapMs() > 400, `without yielding the loop stalls for the whole scan; measured ${monitor.maxGapMs().toFixed(1)} ms`)
  } finally {
    monitor.stop()
    await backend?.dispose()
    stage.cleanup()
  }
})

test('F2: a key that cannot be found backs off — no memory scan every poll; the next scan happens only after the backoff, which doubles; the backend stays responsive and reports it', async () => {
  const stage = makeStage()
  const scanner = fakeScanner({ chunks: 20, chunkMs: 3, keyAt: null }) // never finds it
  let clock = 1_000_000
  let backend
  try {
    backend = await createPluginBackend({
      pluginId: 'tuqdev.line-todo', version: 'test', dataDir: stage.dataDir, linePorts: stage.linePorts,
      watcher: { intervalSec: 0.05, startupDelayMs: 10 }, // a poll every 50 ms (the real default is 15 s)
      keyRecovery: { scanner: scanner.scan, guard: { now: () => clock, minBackoffMs: 30_000, maxBackoffMs: 120_000, yieldSliceMs: 5 } }
    })
    await until(() => scanner.stats.finished === 1, { message: 'the first scan' })
    await sleep(700) // ~14 more polls
    assert.equal(scanner.stats.started, 1, 'the polls that follow a failed scan do not scan again')
    let state = await info(backend)
    assert.equal(state.keyRecovery.scans, 1)
    assert.equal(state.keyRecovery.blocked, true)
    assert.equal(state.keyRecovery.retryInMs, 30_000)
    assert.equal(state.line.state, 'error')
    assert.match(String(state.line.lastError), /key/i)
    assert.equal((await ping(backend)).ok, true, 'still answering')

    clock += 29_999
    await sleep(200)
    assert.equal(scanner.stats.started, 1, 'one millisecond before the backoff ends: still no scan')
    clock += 2
    await until(() => scanner.stats.started === 2, { message: 'the second scan once the backoff is over' })
    await until(() => scanner.stats.finished === 2, { message: 'the second scan to end' })
    await sleep(300)
    assert.equal(scanner.stats.started, 2)
    state = await info(backend)
    assert.equal(state.keyRecovery.retryInMs, 60_000, 'the backoff doubled')

    // the backoff keeps doubling until it reaches the cap
    for (const [started, expected] of [[3, 120_000], [4, 120_000]]) {
      clock += 130_000
      await until(() => scanner.stats.started === started, { message: `scan #${started}` })
      await until(() => scanner.stats.finished === started, { message: `scan #${started} to end` })
      await sleep(150)
      assert.equal((await info(backend)).keyRecovery.retryInMs, expected, `after scan #${started}`)
    }
  } finally {
    await backend?.dispose()
    stage.cleanup()
  }
})

test('F2: "LINE is not running" is cheap and is not a failed scan — no backoff, so the first poll after LINE starts begins scanning at once', async () => {
  const stage = makeStage()
  stage.state.lineRunning = false
  const scanner = fakeScanner({ chunks: 10, chunkMs: 2, keyAt: 9 })
  let backend
  try {
    backend = await createPluginBackend({
      pluginId: 'tuqdev.line-todo', version: 'test', dataDir: stage.dataDir, linePorts: stage.linePorts,
      watcher: { intervalSec: 0.05, startupDelayMs: 10 },
      keyRecovery: { scanner: scanner.scan, guard: { minBackoffMs: 60_000, yieldSliceMs: 5 } }
    })
    await sleep(400)
    assert.equal(scanner.stats.started, 0, 'no LINE.exe, nothing to scan')
    const idle = await info(backend)
    assert.equal(idle.keyRecovery.blocked, false, 'not running is not a failed scan: no backoff')
    assert.equal(idle.line.state, 'error')
    stage.state.lineRunning = true
    await until(async () => (await lineStatus(backend)).state === 'running', { message: 'the import once LINE appears' })
    assert.equal(scanner.stats.started, 1)
  } finally {
    await backend?.dispose()
    stage.cleanup()
  }
})

test('F2: dispose() during a scan cancels it at the next yield point, waits for the scan to clean up, and leaves no snapshot directory behind', async () => {
  const stage = makeStage()
  const scanner = fakeScanner({ chunks: 400, chunkMs: 10, keyAt: null }) // 4 s if it were left alone
  let backend
  try {
    backend = await createPluginBackend({
      pluginId: 'tuqdev.line-todo', version: 'test', dataDir: stage.dataDir, linePorts: stage.linePorts,
      watcher: { intervalSec: 3600, startupDelayMs: 10 },
      keyRecovery: { scanner: scanner.scan, guard: { yieldSliceMs: 5 } }
    })
    await until(() => scanner.stats.chunks >= 5, { message: 'the scan to be under way' })
    assert.ok(readdirSync(join(stage.dataDir, 'line-engine')).some((name) => name.startsWith('linekey-scan-')), 'the verifier snapshot exists while scanning')
    const t0 = Date.now()
    await backend.dispose()
    const disposeMs = Date.now() - t0
    assert.ok(disposeMs < 1000, `dispose took ${disposeMs} ms`)
    assert.equal(scanner.stats.finished, 1, 'the scan was cancelled and has already returned when dispose() resolved')
    const chunksAtDispose = scanner.stats.chunks
    assert.ok(chunksAtDispose < 400)
    await sleep(200)
    assert.equal(scanner.stats.chunks, chunksAtDispose, 'no scanning after dispose')
    assert.deepEqual(readdirSync(join(stage.dataDir, 'line-engine')), [], 'the verifier snapshot (a copy of the LINE database) was removed')
    backend = null
  } finally {
    await backend?.dispose()
    stage.cleanup()
  }
})

test('F2/F6: the boot reconcile and the watcher share ONE scan (single-flight), and the reconcile finds the cached key in dataDir/.linekey without depending on the process cwd', async () => {
  const stage = makeStage()
  writeFileSync(join(stage.dataDir, 'settings.json'), JSON.stringify({ version: 1, reconcile: { enabled: true, scopeMonths: 0 } }))
  const scanner = fakeScanner({ chunks: 40, chunkMs: 8, keyAt: 39 })
  const cwdBefore = process.cwd()
  let backend
  try {
    backend = await createPluginBackend({
      pluginId: 'tuqdev.line-todo', version: 'test', dataDir: stage.dataDir, linePorts: stage.linePorts,
      watcher: { intervalSec: 3600, startupDelayMs: 20 },
      keyRecovery: { scanner: scanner.scan, guard: { yieldSliceMs: 5 } }
    })
    await until(async () => (await lineStatus(backend)).state === 'running', { message: 'the first import' })
    await sleep(600) // the reconcile (it waits for the same startup delay) ran against the same key
    const state = await info(backend)
    assert.equal(state.keyRecovery.scans, 1, 'watcher and reconcile share one scan')
    assert.equal(scanner.stats.started, 1)
    assert.ok(existsSync(join(stage.dataDir, '.linekey')))
    assert.ok(!existsSync(join(cwdBefore, '.linekey')), 'nothing was written next to the process cwd')
    assert.ok(state.recentLog.every((line) => !/reconcile\] failed/.test(line)), `reconcile log: ${state.recentLog.join(' | ')}`)
  } finally {
    await backend?.dispose()
    stage.cleanup()
  }
})

// ───────────── the guard and the cooperative key functions themselves ─────────────

test('getKeyAsync / recoverKeyAsync: single-flight, cancel, env first, no cache or scan while backing off; the synchronous getKey stays synchronous (standalone path)', async () => {
  const stage = makeStage()
  configureLineEnginePorts(stage.linePorts)
  try {
    const scanner = fakeScanner({ chunks: 30, chunkMs: 3, keyAt: 29 })
    const guard = new RecoverGuard({ yieldSliceMs: 2 })
    const opts = { dbPath: join(stage.dbDir, 'qw0001.edb'), cacheFile: join(stage.dataDir, '.linekey'), recoverGuard: guard, scanner: scanner.scan }
    const [a, b] = await Promise.all([getKeyAsync(opts), getKeyAsync(opts)])
    assert.equal(a, GOOD_KEY)
    assert.equal(b, GOOD_KEY)
    assert.equal(scanner.stats.started, 1, 'two concurrent callers, one scan')
    assert.equal(guard.scans, 1)
    // the second call finds the cache the first one wrote: no scan
    assert.equal(await getKeyAsync(opts), GOOD_KEY)
    assert.equal(scanner.stats.started, 1)

    // env wins, even while backing off
    guard.noteScanFailure()
    assert.equal(guard.blocked(), true)
    process.env.LINE_DB_KEY = 'ee'.repeat(16)
    try { assert.equal(await getKeyAsync(opts), 'ee'.repeat(16)) } finally { delete process.env.LINE_DB_KEY }
    // backing off: neither the (valid) cache nor a scan is touched
    const opened = stage.state.opened.length
    assert.equal(await getKeyAsync(opts), null)
    assert.equal(stage.state.opened.length, opened, 'no snapshot was opened while backing off')

    // cancel: a scan that is under way ends and reports "not found"
    const slow = fakeScanner({ chunks: 500, chunkMs: 5, keyAt: null })
    const guard2 = new RecoverGuard({ yieldSliceMs: 2 })
    const pending = recoverKeyAsync({ dbPath: opts.dbPath, cacheFile: join(stage.dataDir, '.linekey2'), recoverGuard: guard2, scanner: slow.scan })
    await until(() => slow.stats.chunks >= 3, { message: 'the scan to run' })
    guard2.cancel()
    assert.equal(await pending, null)
    assert.ok(slow.stats.chunks < 500)
    assert.equal(guard2.blocked(), false, 'a cancelled scan is not a failure')
    assert.deepEqual(readdirSync(join(stage.dataDir, 'line-engine')), [], 'the verifier snapshot is gone')

    // the standalone shape is untouched: getKey() is synchronous and returns the value itself, not a promise
    const sync = getKey({ skipEnv: true, skipRecover: true, cacheFile: join(stage.dataDir, '.linekey'), dbPath: opts.dbPath })
    assert.equal(sync, GOOD_KEY)
    assert.equal(typeof sync.then, 'undefined')
    assert.equal(getKey({ skipEnv: true, skipRecover: true, cacheFile: join(stage.dataDir, 'nope') }), null)
  } finally {
    stage.cleanup()
  }
})

test('RecoverGuard: exponential backoff from minBackoffMs, capped at maxBackoffMs, reset by a success', () => {
  let now = 5_000
  const guard = new RecoverGuard({ now: () => now, minBackoffMs: 1000, maxBackoffMs: 5000 })
  assert.equal(guard.blocked(), false)
  const seen = []
  for (let i = 0; i < 5; i += 1) { guard.noteScanFailure(); seen.push(guard.retryInMs()); now += guard.retryInMs() }
  assert.deepEqual(seen, [1000, 2000, 4000, 5000, 5000])
  assert.equal(guard.blocked(), false)
  guard.noteScanFailure()
  assert.equal(guard.blocked(), true)
  guard.noteSuccess()
  assert.equal(guard.blocked(), false)
  guard.noteScanFailure()
  assert.equal(guard.retryInMs(), 1000, 'success reset the sequence')
})

// ───────────── F7: log lines carry no message content ─────────────

test('F7: a malformed message is logged by field type only — the message text, sender and chat never reach any log line', () => {
  const watcher = new LineWatcher({ intervalSec: 3600 })
  const lines = []
  watcher.on('log', (line) => lines.push(line))
  const secret = 'SECRET-CANARY-訊息內容-0912345678'
  watcher.emitMessage({ chatId: 12345, ts: 'not-a-number', text: secret, sender: `寄件人-${secret}`, chat: `群組-${secret}` })
  watcher.emitMessage({ ts: 1, text: secret })
  assert.equal(lines.length, 2)
  assert.deepEqual(lines, ['[watcher] skip malformed message: chatId=number ts=string', '[watcher] skip malformed message: chatId=undefined ts=number'])
  for (const line of lines) assert.equal(line.includes('SECRET') || line.includes('寄件人') || line.includes('群組'), false)
})
