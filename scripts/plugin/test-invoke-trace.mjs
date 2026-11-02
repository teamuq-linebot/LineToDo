// Invoke trace (src/plugin/backend/invokeTrace.ts + the Dispatcher hook): the backend leaves a record of every call's start / end / duration / result code and of event-loop stalls,
// so a Core "30 s timeout fence" can be traced to the method that caused it. Covered here:
//   * the START record is on disk before the handler runs — and survives a blocked event loop and SIGKILL (a real child process)
//   * END records carry duration and an ok / error code; slow calls are marked; long polls are not
//   * event-loop stalls are recorded with how long and which calls overlapped
//   * the log is size-bounded (rotation) and an in-flight call stays on disk across a rotation
//   * the log never contains argument values, results or error messages (structural whitelist + planted markers)
//   * a log that cannot be written never changes a call's outcome
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { Dispatcher, INTERNAL_API_PATHS, SUPPORTED_API_PATHS, UNSUPPORTED_API_PATHS } from '../../src/plugin/backend/dispatcher.ts'
import { EventHub } from '../../src/plugin/backend/eventHub.ts'
import { ALLOWED_FIELDS, InvokeTrace, TRACE_DEFAULTS } from '../../src/plugin/backend/invokeTrace.ts'
import { INVOKE_TRACE_RELATIVE_FILE, createPluginBackend } from '../../src/plugin/backend/assemble.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tempDir = (name) => mkdtempSync(join(tmpdir(), `invoke-trace-${name}-`))

async function until(probe, { timeout = 10_000, step = 10, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`)
    await sleep(step)
  }
}

/** Parsed records of a log file (empty when it does not exist). Every line must be valid JSON. */
function readRecords(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}
const readAll = (file) => [...readRecords(`${file}.1`), ...readRecords(file)]
const rawText = (file) => [`${file}.1`, file].filter((f) => existsSync(f)).map((f) => readFileSync(f, 'utf8')).join('')

const fakeApi = (overrides = {}) => ({
  ping: async () => ({ ok: true }),
  db: {
    todos: { list: async (q) => [{ id: 't1', q }], update: async () => { throw new Error('boom: update failed') } },
    messages: { list: async () => [] }
  },
  ...overrides
})

function make({ api = fakeApi(), traceOptions = {}, dispatcherOptions = {} } = {}) {
  const dir = tempDir('d')
  const file = join(dir, 'logs', 'invoke-trace.log')
  const trace = new InvokeTrace({ file, timer: false, pid: 4242, ...traceOptions })
  const hub = new EventHub()
  const dispatcher = new Dispatcher({ getApi: () => api, hub, queue: { stats: () => ({}) }, info: () => ({}), trace, ...dispatcherOptions })
  return {
    dir, file, trace, dispatcher, hub,
    call: (path, ...args) => dispatcher.call(path.split('.').slice(0, path.startsWith('db.') ? 2 : 1).join('.'), { path, args }),
    cleanup: () => { trace.stop(); dispatcher.dispose(); hub.dispose(); rmSync(dir, { recursive: true, force: true }) }
  }
}

// ───────────── start record first ─────────────

test('the start record is already on disk when the handler runs (and the end record is not yet)', async () => {
  let seenInHandler = null
  const where = { file: '' }
  const api = fakeApi({ db: { todos: { list: async () => { seenInHandler = readRecords(where.file).filter((r) => r.ev === 'start' || r.ev === 'end'); return [] } } } })
  const t2 = make({ api })
  where.file = t2.file
  try {
    await t2.call('db.todos.list', { chatId: 'c1' })
    assert.equal(seenInHandler.length, 1, 'exactly the start record existed while the handler ran')
    assert.deepEqual({ ev: seenInHandler[0].ev, m: seenInHandler[0].m, p: seenInHandler[0].p, argc: seenInHandler[0].argc, seq: seenInHandler[0].seq }, { ev: 'start', m: 'db.todos', p: 'db.todos.list', argc: 1, seq: 1 })
    const all = readRecords(t2.file)
    assert.deepEqual(all.map((r) => r.ev), ['boot', 'start', 'end'])
    assert.equal(all[2].seq, 1)
    assert.equal(all[2].res, 'ok')
  } finally { t2.cleanup() }
})

test('a SIGKILLed backend whose event loop is blocked leaves the unfinished call as the last record', { timeout: 60_000 }, async () => {
  const dir = tempDir('kill-sync')
  const file = join(dir, 'invoke-trace.log')
  const child = spawn(process.execPath, ['--experimental-strip-types', '--experimental-loader=./scripts/ts-test-loader.mjs', join('scripts', 'plugin', 'fixtures', 'invoke-trace-hang-child.mjs'), file, 'sync'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d })
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })))
  try {
    await until(() => readRecords(file).some((r) => r.ev === 'start' && r.p === 'db.messages.list') || child.exitCode !== null, { timeout: 50_000, message: `the hanging call to start (stderr: ${stderr.slice(0, 400)})` })
    await sleep(600) // long enough for several sampler ticks IF the loop were alive
    child.kill('SIGKILL')
    assert.equal((await exited).signal, 'SIGKILL')
    const records = readRecords(file)
    const hung = records.find((r) => r.ev === 'start' && r.p === 'db.messages.list')
    assert.ok(hung, 'the start of the hanging call is on disk')
    assert.equal(records.at(-1).seq, hung.seq, 'it is the last thing written')
    assert.equal(records.at(-1).ev, 'start')
    assert.ok(!records.some((r) => r.seq === hung.seq && r.ev === 'end'), 'no end record for it')
    assert.ok(!records.some((r) => r.ev === 'stop' || r.ev === 'inflight' || r.ev === 'loop_stall'), 'a blocked loop writes nothing else: no stop, no heartbeat, no stall')
    assert.ok(records.some((r) => r.ev === 'end' && r.p === 'ping' && r.res === 'ok'), 'the earlier call finished normally')
    assert.ok(!rawText(file).includes('CHILD-SECRET-TEXT'), 'no argument value')
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a SIGKILLed backend whose call never settles shows a heartbeat (loop alive) and still no end record', { timeout: 60_000 }, async () => {
  const dir = tempDir('kill-async')
  const file = join(dir, 'invoke-trace.log')
  const child = spawn(process.execPath, ['--experimental-strip-types', '--experimental-loader=./scripts/ts-test-loader.mjs', join('scripts', 'plugin', 'fixtures', 'invoke-trace-hang-child.mjs'), file, 'async'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d })
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })))
  try {
    await until(() => readRecords(file).filter((r) => r.ev === 'inflight').length >= 2 || child.exitCode !== null, { timeout: 50_000, message: `heartbeats (stderr: ${stderr.slice(0, 400)})` })
    child.kill('SIGKILL')
    assert.equal((await exited).signal, 'SIGKILL')
    const records = readRecords(file)
    const hung = records.find((r) => r.ev === 'start' && r.p === 'db.messages.list')
    assert.ok(hung)
    assert.ok(!records.some((r) => r.seq === hung.seq && r.ev === 'end'))
    const beat = records.find((r) => r.ev === 'inflight')
    assert.ok(beat.calls.some((c) => c.seq === hung.seq && c.p === 'db.messages.list' && c.age >= 50), 'the heartbeat names the call and how long it has been open')
    assert.ok(!records.some((r) => r.ev === 'loop_stall'), 'the loop was never blocked')
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})

// ───────────── end record: duration, code, slow marker ─────────────

test('end records carry duration and result code; slow calls are marked, long polls are not', async () => {
  let tick = 0
  const t = make({ traceOptions: { monoClock: () => (tick += 3000), slowMs: 2000 } }) // every call "takes" 3000 ms
  try {
    await t.call('ping')
    await t.call('db.todos.update')
    await t.call('db.todos.nope')
    await t.dispatcher.call('db.todos', { path: 'ping' })
    await t.dispatcher.call('job', { path: 'job.poll', args: [{ jobId: 'zzz' }] })
    const ends = readRecords(t.file).filter((r) => r.ev === 'end')
    assert.deepEqual(ends.map((r) => [r.p, r.res, r.ms, r.slow === true]), [
      ['ping', 'ok', 3000, true],
      ['db.todos.update', 'api_error', 3000, true],
      ['?', 'path_unknown', 3000, true], // not a known path: logged as "?" (see the unknown-path test below)
      ['ping', 'method_mismatch', 3000, true],
      ['job.poll', 'job_not_found', 3000, false]
    ])
  } finally { t.cleanup() }
})

test('a fast call is not marked slow and defaults are documented values', async () => {
  assert.equal(TRACE_DEFAULTS.slowMs, 2000)
  assert.equal(TRACE_DEFAULTS.stallMs, 1000)
  const t = make()
  try {
    await t.call('ping')
    const end = readRecords(t.file).find((r) => r.ev === 'end')
    assert.ok(end.ms < 2000)
    assert.equal(end.slow, undefined)
  } finally { t.cleanup() }
})

test('a call converted to a job gets end(pending) and later job_end with the same seq', async () => {
  const api = fakeApi({ db: { todos: { list: () => new Promise((r) => setTimeout(() => r([{ id: 'x' }]), 120)), update: () => new Promise((_, rej) => setTimeout(() => rej(new Error('late boom')), 120)) } } })
  const t = make({ api, dispatcherOptions: { softDeadlineMs: 20 } })
  try {
    const first = await t.call('db.todos.list')
    assert.equal(first.pending, true)
    const second = await t.call('db.todos.update')
    assert.equal(second.pending, true)
    await until(() => readRecords(t.file).filter((r) => r.ev === 'job_end').length === 2, { message: 'two job_end records' })
    const records = readRecords(t.file)
    const list = records.filter((r) => r.p === 'db.todos.list')
    assert.deepEqual(list.map((r) => r.ev), ['start', 'end', 'job_end'])
    assert.equal(list[1].res, 'pending')
    assert.equal(list[2].res, 'ok')
    assert.ok(list[2].ms >= 100, `job_end covers the whole job (${list[2].ms} ms)`)
    assert.equal(list[2].seq, list[0].seq)
    assert.equal(records.filter((r) => r.p === 'db.todos.update' && r.ev === 'job_end')[0].res, 'api_error')
    assert.ok(!rawText(t.file).includes('late boom'))
  } finally { t.cleanup() }
})

// ───────────── event-loop stall / heartbeat ─────────────

test('a blocked event loop is recorded as loop_stall with the length and the overlapping call', async () => {
  const api = fakeApi({ db: { todos: { list: async () => { const until = Date.now() + 250; while (Date.now() < until) { /* hold the loop */ } return [] } } } })
  const dir = tempDir('stall')
  const file = join(dir, 'invoke-trace.log')
  const trace = new InvokeTrace({ file, pid: 1, tickMs: 10, stallMs: 100 })
  const dispatcher = new Dispatcher({ getApi: () => api, hub: new EventHub(), queue: { stats: () => ({}) }, info: () => ({}), trace })
  try {
    await sleep(40) // let the sampler settle
    await dispatcher.call('db.todos', { path: 'db.todos.list', args: [] })
    const stall = await until(() => readRecords(file).find((r) => r.ev === 'loop_stall'), { message: 'a loop_stall record' })
    assert.ok(stall.lagMs >= 150 && stall.lagMs < 1500, `lagMs=${stall.lagMs}`)
    assert.match(stall.from, /^\d{4}-\d{2}-\d{2}T/)
    assert.ok(stall.calls.some((c) => c.p === 'db.todos.list' && c.open === false && c.age >= 200), 'the call that held the loop is named')
    const end = readRecords(file).find((r) => r.ev === 'end')
    assert.ok(end.ms >= 200, 'its own end record shows the same duration')
  } finally { trace.stop(); dispatcher.dispose(); rmSync(dir, { recursive: true, force: true }) }
})

test('short pauses below the stall threshold are not recorded', async () => {
  const dir = tempDir('nostall')
  const file = join(dir, 'invoke-trace.log')
  const trace = new InvokeTrace({ file, tickMs: 10, stallMs: 400 })
  try {
    await sleep(30)
    const until2 = Date.now() + 80
    while (Date.now() < until2) { /* 80 ms pause */ }
    await sleep(60)
    assert.ok(!readRecords(file).some((r) => r.ev === 'loop_stall'))
  } finally { trace.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('slow open calls produce rate-limited inflight heartbeats; finished or waiting calls do not', async () => {
  const api = fakeApi({ db: { todos: { list: () => new Promise(() => undefined) } } })
  const t = make({ api, traceOptions: { slowMs: 30, heartbeatMs: 40, tickMs: 10, timer: true } })
  try {
    void t.call('db.todos.list')
    await until(() => readRecords(t.file).filter((r) => r.ev === 'inflight').length >= 2, { message: 'two heartbeats' })
    const beats = readRecords(t.file).filter((r) => r.ev === 'inflight')
    assert.ok(beats[0].calls[0].age >= 30)
    assert.equal(beats[0].calls[0].p, 'db.todos.list')
    const gap = Date.parse(beats[1].t) - Date.parse(beats[0].t)
    assert.ok(gap >= 25, `heartbeats are spaced (${gap} ms)`)
  } finally { t.cleanup() }
  const quiet = make({ traceOptions: { slowMs: 30, heartbeatMs: 20, tickMs: 10, timer: true } })
  try {
    await quiet.call('ping')
    await sleep(120)
    assert.ok(!readRecords(quiet.file).some((r) => r.ev === 'inflight'), 'nothing open -> no heartbeat')
  } finally { quiet.cleanup() }
})

// ───────────── size bound / rotation ─────────────

test('the log is size-bounded: it rotates to <file>.1 (one generation) and an in-flight call stays on disk', async () => {
  const MAX = 3000
  const api = fakeApi({ db: { todos: { list: () => new Promise(() => undefined) } } })
  const t = make({ api, traceOptions: { maxBytes: MAX } })
  try {
    void t.call('db.todos.list') // never finishes
    const hungSeq = 1
    for (let i = 0; i < 300; i += 1) await t.call('ping')
    assert.ok(existsSync(`${t.file}.1`), 'rotated at least once')
    assert.ok(!existsSync(`${t.file}.2`), 'only one old generation is kept')
    assert.ok(statSync(t.file).size <= MAX, `current ${statSync(t.file).size} <= ${MAX}`)
    assert.ok(statSync(`${t.file}.1`).size <= MAX, `old ${statSync(`${t.file}.1`).size} <= ${MAX}`)
    const all = readAll(t.file) // every line of both files is valid JSON (readRecords throws otherwise)
    const shows = (r) => (r.ev === 'start' && r.seq === hungSeq && r.p === 'db.todos.list') || (r.ev === 'carry' && r.calls.some((c) => c.seq === hungSeq && c.p === 'db.todos.list'))
    assert.ok(all.some(shows), 'rotation did not drop the unfinished call')
    assert.ok(readRecords(t.file).some(shows), 'the CURRENT file (not only the old one) still shows the unfinished call')
    assert.ok(readRecords(t.file).some((r) => r.ev === 'carry'), 'it is there because rotation carried it over')
    assert.ok(all.filter((r) => r.ev === 'end').length < 300, 'the oldest records were really discarded')
  } finally { t.cleanup() }
})

test('default limits: 1 MiB per file, so the log stays near 2 MiB at most', () => {
  assert.equal(TRACE_DEFAULTS.maxBytes, 1024 * 1024)
})

// ───────────── no content in the log ─────────────

const MARKERS = ['SECRET-MSG-王小明', 'SECRET-CONTACT-Alice', 'SECRET-KEY-0123abcd', 'SECRET-PATH-xyz', 'SECRET-ERR-MSG', 'SECRET-RESULT-TEXT', 'SECRET-CODE']

test('the log contains no argument values, results, error messages or names: whitelist of fields + planted markers', async () => {
  const bigText = `SECRET-RESULT-TEXT ${'x'.repeat(70_000)}`
  const api = fakeApi({
    db: {
      todos: {
        list: async (q) => [{ text: 'SECRET-RESULT-TEXT', q }],
        update: async () => { throw new Error('SECRET-ERR-MSG 王小明') },
        get: async () => ({ __fail: true, code: 'SECRET-CODE has spaces', message: 'SECRET-ERR-MSG' }),
        moveColumn: async () => bigText
      },
      messages: { list: async () => [{ sender: 'SECRET-CONTACT-Alice', text: 'SECRET-MSG-王小明' }] }
    }
  })
  const hub = { open: () => { throw new Error('SECRET-ERR-MSG from hub') }, stats: () => ({}), dispose() {} }
  const t = make({ api, dispatcherOptions: { hub } })
  const args = { text: 'SECRET-MSG-王小明', contact: 'SECRET-CONTACT-Alice', key: 'SECRET-KEY-0123abcd', nested: [{ deep: 'SECRET-MSG-王小明' }] }
  try {
    await t.call('db.todos.list', args, 'SECRET-KEY-0123abcd')
    await t.call('db.messages.list', args)
    await t.call('db.todos.update', args)
    await t.call('db.todos.get', args)
    const chunked = await t.call('db.todos.moveColumn', args)
    assert.equal(chunked.chunked, true)
    await t.dispatcher.call('db.todos SECRET-PATH-xyz', { path: 'db.todos.list SECRET-PATH-xyz', args: [args] })
    await t.dispatcher.call('SECRET-PATH-xyz', { path: 'SECRET-PATH-xyz.list', args: [args] })
    await t.dispatcher.call('db.todos', { path: 'SECRET-PATH-xyz', args: [args] })
    await t.dispatcher.call('db.todos', { path: { toString: () => 'SECRET-PATH-xyz' }, args: [args] })
    await t.dispatcher.call('db.todos', { path: 'db.todos.list', args: 'SECRET-MSG-王小明' })
    await t.dispatcher.call({ toString: () => 'SECRET-PATH-xyz' }, 'SECRET-MSG-王小明')
    await assert.rejects(t.dispatcher.call('events', { path: 'events.open', args: [args] }), /SECRET-ERR-MSG/)
    t.trace.begin({ method: 'db.todos', path: 'db.todos.list', argc: 1, argBytes: 5 }).fail(Object.assign(new Error('SECRET-ERR-MSG'), { name: 'SECRET NAME with spaces' }))

    const text = rawText(t.file)
    for (const marker of MARKERS) assert.ok(!text.includes(marker), `marker leaked: ${marker}`)
    assert.ok(!/王小明|Alice|0123abcd/.test(text))

    // structural proof: only whitelisted keys; every string value is a plain token (names, ISO times, result codes), every other value a number/boolean
    const TOKEN = /^[A-Za-z0-9_.:+\-?]*$/
    const visit = (value, where) => {
      if (Array.isArray(value)) { value.forEach((v, i) => visit(v, `${where}[${i}]`)); return }
      if (value !== null && typeof value === 'object') {
        for (const [key, v] of Object.entries(value)) { assert.ok(ALLOWED_FIELDS.has(key), `unexpected field "${key}" at ${where}`); visit(v, `${where}.${key}`) }
        return
      }
      if (typeof value === 'string') assert.match(value, TOKEN, where)
      else assert.ok(typeof value === 'number' || typeof value === 'boolean', `${where}: ${typeof value}`)
    }
    for (const record of readRecords(t.file)) visit(record, record.ev)

    const startOfFirst = readRecords(t.file).find((r) => r.ev === 'start' && r.p === 'db.todos.list')
    assert.equal(startOfFirst.argc, 2)
    assert.equal(startOfFirst.argB, Buffer.byteLength(JSON.stringify([args, 'SECRET-KEY-0123abcd'])), 'only the size of the arguments is recorded')
    const ends = readRecords(t.file).filter((r) => r.ev === 'end')
    assert.ok(ends.some((r) => r.res === 'other'), 'a result code that is not a plain code is replaced by "other"')
    assert.ok(ends.some((r) => r.res === 'chunked' && typeof r.bytes === 'number'))
    assert.ok(ends.some((r) => r.res === 'threw' && r.err === 'Error'))
    assert.ok(readRecords(t.file).some((r) => r.ev === 'start' && r.p === '?' && r.m === '?'), 'unknown method/path are logged as "?"')
  } finally { t.cleanup() }
})

// ───────────── only known paths are logged (review A-F2) ─────────────

const groupOf = (path) => (path.startsWith('db.') ? path.split('.').slice(0, 2).join('.') : path.split('.')[0])

test('an unknown path is logged as "?" even when it passes the format check and has a known group prefix', async () => {
  const t = make()
  try {
    const hostile = ['db.chats.AliceWang1234.Secret', 'line.Password123', 'ping.Secret', 'backend.zzzSECRET', 'db.todos.listSECRET', 'events.openSECRET', 'job.poll.extra', 'db.todos.identity.Password']
    for (const path of hostile) await t.dispatcher.call(groupOf(path), { path, args: [] })
    const text = rawText(t.file)
    for (const word of ['AliceWang1234', 'Secret', 'Password123', 'SECRET', 'Password', 'extra']) assert.ok(!text.includes(word), `leaked into the log: ${word}`)
    const starts = readRecords(t.file).filter((r) => r.ev === 'start')
    assert.equal(starts.length, hostile.length)
    for (const r of starts) assert.equal(r.p, '?')
    assert.ok(starts.some((r) => r.m === 'db.chats'), 'the (validated) group is still logged')
    for (const r of readRecords(t.file).filter((x) => x.ev === 'end')) assert.equal(r.p, '?')
  } finally { t.cleanup() }
})

test('every path the dispatcher knows (supported, explicitly unsupported, internal switch cases) is still logged verbatim', async () => {
  const source = readFileSync(join(ROOT, 'src', 'plugin', 'backend', 'dispatcher.ts'), 'utf8')
  const switchBody = source.slice(source.indexOf('switch (path) {'), source.indexOf('default: break'))
  const cases = [...switchBody.matchAll(/case '([A-Za-z0-9.]+)':/g)].map((m) => m[1])
  assert.ok(cases.length >= 15, `parsed ${cases.length} switch cases`)
  for (const c of cases) assert.ok(INTERNAL_API_PATHS.includes(c), `INTERNAL_API_PATHS is missing the switch case "${c}" (it would be logged as "?")`)
  const known = [...new Set([...SUPPORTED_API_PATHS, ...Object.keys(UNSUPPORTED_API_PATHS), ...INTERNAL_API_PATHS])]
  const t = make()
  try {
    for (const path of known) await t.dispatcher.call(groupOf(path), { path, args: [] })
    const starts = readRecords(t.file).filter((r) => r.ev === 'start')
    assert.deepEqual(starts.map((r) => r.p), known, 'every known path appears verbatim, in order')
  } finally { t.cleanup() }
})

// ───────────── rotation failure keeps recording (review A-F1) ─────────────

const TRACE_CALL = { method: 'db.todos', path: 'db.todos.list', argc: 0, argBytes: 0 }

test('a rotation that cannot rename (.1 is a non-empty directory) degrades to truncation: records keep coming, .1 is untouched', () => {
  const dir = tempDir('rotfail')
  const file = join(dir, 'l.log')
  mkdirSync(`${file}.1`)
  writeFileSync(join(`${file}.1`, 'keep.txt'), 'KEEP')
  const errors = []
  const trace = new InvokeTrace({ file, timer: false, pid: 1, maxBytes: 600, onError: (code) => errors.push(code) })
  try {
    trace.begin(TRACE_CALL) // seq 1: stays in flight
    for (let i = 0; i < 20; i += 1) trace.begin(TRACE_CALL).end('ok')
    const newest = trace.begin(TRACE_CALL).seq
    const records = readRecords(file)
    assert.equal(trace.dropped, 0, 'no record was lost to the failed rotation')
    assert.ok(records.some((r) => r.ev === 'start' && r.seq === newest), 'the newest call\'s start record is on disk')
    assert.ok(statSync(file).size <= 600, `current file stays bounded (${statSync(file).size})`)
    assert.ok(records.some((r) => r.ev === 'carry' && r.calls.some((c) => c.seq === 1)), 'the call still in flight was carried over the truncation')
    assert.equal(readFileSync(join(`${file}.1`, 'keep.txt'), 'utf8'), 'KEEP', 'the old .1 was not deleted')
    assert.equal(errors.length, 1, 'the failure is reported once, not once per rotation')

    // once the obstruction is gone the next rotation works again
    rmSync(`${file}.1`, { recursive: true, force: true })
    for (let i = 0; i < 20; i += 1) trace.begin(TRACE_CALL).end('ok')
    assert.ok(statSync(`${file}.1`).isFile(), 'rotation recovered')
    assert.equal(trace.dropped, 0)
  } finally { trace.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('the old .1 is only replaced by a successful rename: if the current file cannot be renamed, .1 keeps its content and recording continues', () => {
  const dir = tempDir('rotkeep')
  const file = join(dir, 'l.log')
  writeFileSync(`${file}.1`, 'OLD-GENERATION\n')
  const errors = []
  const trace = new InvokeTrace({ file, timer: false, pid: 1, maxBytes: 600, onError: (code) => errors.push(code) })
  try {
    trace.begin(TRACE_CALL).end('ok')
    rmSync(file, { force: true }) // the current file vanishes from under the open descriptor, so the next rename has nothing to move
    for (let i = 0; i < 2; i += 1) trace.begin(TRACE_CALL).end('ok') // enough for exactly one (failing) rotation
    const newest = trace.begin(TRACE_CALL).seq
    assert.deepEqual(errors, ['ENOENT'], 'the rename really failed')
    assert.equal(readFileSync(`${file}.1`, 'utf8').startsWith('OLD-GENERATION'), true, '.1 survived the failed rotation')
    assert.ok(readRecords(file).some((r) => r.ev === 'start' && r.seq === newest), 'the newest start record is on disk')
    assert.equal(trace.dropped, 0)
  } finally { trace.stop(); rmSync(dir, { recursive: true, force: true }) }
})

/** 目前行程開著的檔案描述子數（測試用：fstat 能成功的 fd）。 */
function openFdCount() {
  let n = 0
  for (let fd = 3; fd < 1024; fd += 1) { try { fstatSync(fd); n += 1 } catch { /* 沒開 */ } }
  return n
}

test('after stop() a late end / fail / job_end neither opens a descriptor nor appends: the file still ends with stop', () => {
  const dir = tempDir('afterstop')
  const file = join(dir, 'l.log')
  const baseline = openFdCount()
  const trace = new InvokeTrace({ file, timer: false, pid: 1 })
  try {
    assert.equal(openFdCount(), baseline + 1, 'the trace holds exactly one descriptor while running')
    const lateEnd = trace.begin(TRACE_CALL)
    const lateFail = trace.begin(TRACE_CALL)
    const job = trace.begin(TRACE_CALL)
    const jobDone = job.background()
    job.end('pending')
    trace.stop()
    assert.equal(openFdCount(), baseline, 'stop() released the descriptor')
    const before = readFileSync(file, 'utf8')
    assert.equal(readRecords(file).at(-1).ev, 'stop')

    lateEnd.end('ok')
    lateFail.fail(new Error('SECRET-ERR-MSG'))
    jobDone('ok')
    assert.equal(openFdCount(), baseline, 'late end/fail/job_end did not open a new descriptor')
    assert.equal(readFileSync(file, 'utf8'), before, 'nothing was appended after stop')
    assert.equal(readRecords(file).at(-1).ev, 'stop', 'the last record is still stop')
    assert.equal(trace.begin(TRACE_CALL).seq, 0, 'begin() after stop is a no-op call')
    trace.sample()
    assert.equal(openFdCount(), baseline)
    assert.equal(readFileSync(file, 'utf8'), before)
    assert.equal(trace.dropped, 0, 'skipping after stop is not a write failure')
  } finally { trace.stop(); rmSync(dir, { recursive: true, force: true }) }
})

/**
 * 載入一份「rename 與截斷都可以被注入失敗」的 invokeTrace 副本：只在輪替裡兩個真正碰檔案系統的呼叫前加 failIo()，其他字元不動。
 * 為什麼要副本：真的檔案系統很難做出「rename 與截斷都失敗、但 append 仍成功」（Windows 上唯讀檔連 append 都開不了），而這正是文件宣稱的硬上限情境。
 */
async function loadInjectableTrace(dir) {
  let source = readFileSync(join(ROOT, 'src', 'plugin', 'backend', 'invokeTrace.ts'), 'utf8')
  const patch = (from, to) => {
    assert.equal(source.split(from).length - 1, 1, 'injection anchor present exactly once: ' + from)
    source = source.replace(from, to)
  }
  patch('renameSync(this.o.file, this.rotated)', 'failIo(); renameSync(this.o.file, this.rotated)')
  patch("try { writeFileSync(this.o.file, '') }", "try { failIo(); writeFileSync(this.o.file, '') }")
  source += "\nfunction failIo(): void { if ((globalThis as any).__invokeTraceFailIo) throw Object.assign(new Error('injected'), { code: 'EBUSY' }) }\n"
  const copy = join(dir, 'invokeTrace.injectable.ts')
  writeFileSync(copy, source)
  return import(pathToFileURL(copy).href)
}

test('hard cap: when rename AND truncation both fail the file stops at 2 x maxBytes, and once the obstruction is gone the very next call is recorded again', async () => {
  const dir = tempDir('hardcap')
  const file = join(dir, 'l.log')
  const { InvokeTrace: Injectable } = await loadInjectableTrace(dir)
  const maxBytes = 4096
  const errors = []
  const trace = new Injectable({ file, timer: false, pid: 1, maxBytes, onError: (code) => errors.push(code) })
  try {
    globalThis.__invokeTraceFailIo = true
    let calls = 0
    while (trace.dropped === 0 && calls < 5000) { trace.begin(TRACE_CALL).end('ok'); calls += 1 }
    assert.ok(trace.dropped > 0, 'the hard cap was reached (records are being dropped)')
    assert.ok(statSync(file).size <= maxBytes * 2, 'file never exceeds the hard cap while blocked')
    assert.ok(statSync(file).size > maxBytes, 'it did keep appending past maxBytes before the cap')
    for (let i = 0; i < 100; i += 1) trace.begin(TRACE_CALL).end('ok') // still blocked: still dropping, still bounded
    assert.ok(statSync(file).size <= maxBytes * 2)
    assert.deepEqual(errors, ['EBUSY'], 'reported once')

    globalThis.__invokeTraceFailIo = false // the obstruction clears
    const droppedBefore = trace.dropped
    const seq = trace.begin(TRACE_CALL).seq
    assert.ok(readRecords(file).some((r) => r.ev === 'start' && r.seq === seq), 'the first start after recovery is in the file')
    assert.equal(trace.dropped, droppedBefore, 'nothing more is dropped after recovery')
    assert.ok(statSync(file).isFile() && statSync(file).size <= maxBytes, 'the file was rotated/truncated back under maxBytes')
    for (let i = 0; i < 200; i += 1) trace.begin(TRACE_CALL).end('ok')
    assert.equal(trace.dropped, droppedBefore, 'and it stays healthy')
  } finally { globalThis.__invokeTraceFailIo = false; trace.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('the trace never deletes files itself (rotation only renames over .1)', () => {
  const source = readFileSync(join(ROOT, 'src', 'plugin', 'backend', 'invokeTrace.ts'), 'utf8')
  assert.ok(!/\bunlink(Sync)?\b|\brmSync\b|\brm\(/.test(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), 'no delete call in invokeTrace.ts')
})

test('a log file deleted while the backend runs is recreated by the next sample (the held descriptor does not keep writing to a deleted file)', () => {
  const dir = tempDir('recreate')
  const file = join(dir, 'logs', 'l.log')
  const trace = new InvokeTrace({ file, timer: false, pid: 1 })
  try {
    trace.begin(TRACE_CALL).end('ok')
    rmSync(file, { force: true })
    trace.sample()
    const seq = trace.begin(TRACE_CALL).seq
    assert.ok(existsSync(file), 'the log exists again')
    assert.ok(readRecords(file).some((r) => r.ev === 'start' && r.seq === seq))
  } finally { trace.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('record sizes match the documented numbers (docs/invoke-trace.md): about 130 bytes per record, at most 170, over every known path', () => {
  const dir = tempDir('size')
  const file = join(dir, 'l.log')
  const trace = new InvokeTrace({ file, timer: false, pid: 123456 })
  try {
    for (const path of [...SUPPORTED_API_PATHS, ...INTERNAL_API_PATHS]) {
      for (const argBytes of [2, 180, 2400]) trace.begin({ method: groupOf(path), path, argc: 1, argBytes }).end('ok')
    }
    const sizes = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(1).map((line) => Buffer.byteLength(line) + 1)
    const avg = sizes.reduce((a, c) => a + c, 0) / sizes.length
    assert.ok(Math.max(...sizes) <= 170, `max record ${Math.max(...sizes)} bytes`)
    assert.ok(avg >= 110 && avg <= 150, `average record ${avg.toFixed(1)} bytes`)
  } finally { trace.stop(); rmSync(dir, { recursive: true, force: true }) }
})

// ───────────── logging never changes a call ─────────────

test('an unwritable log changes nothing: same envelopes, one error notification', async () => {
  const run = async (traceOptions) => {
    const errors = []
    const dir = tempDir('unwritable')
    const file = traceOptions === 'dir' ? dir : join(dir, 'invoke-trace.log')
    const trace = traceOptions === null ? undefined : new InvokeTrace({ file, timer: false, onError: (code) => errors.push(code) })
    const hub = new EventHub()
    const d = new Dispatcher({ getApi: () => fakeApi(), hub, queue: { stats: () => ({}) }, info: () => ({}), softDeadlineMs: 20, ...(trace ? { trace } : {}) })
    const out = []
    for (const [method, params] of [
      ['ping', { path: 'ping' }], ['db.todos', { path: 'db.todos.list', args: [{ a: 1 }] }], ['db.todos', { path: 'db.todos.update', args: [] }],
      ['db.todos', { path: 'db.todos.nope' }], ['ping', { path: 'db.todos.list' }], ['zzz', {}], ['ping', null], ['db.todos', { path: 'db.todos.list', args: 'x' }]
    ]) out.push(await d.call(method, params))
    trace?.stop(); d.dispose(); hub.dispose()
    rmSync(dir, { recursive: true, force: true })
    return { out, errors }
  }
  const plain = await run(null)
  const traced = await run('file')
  const broken = await run('dir')
  assert.deepEqual(traced.out, plain.out, 'tracing does not change any envelope')
  assert.deepEqual(broken.out, plain.out, 'a log that cannot be written does not either')
  assert.deepEqual(traced.errors, [])
  assert.equal(broken.errors.length, 1, 'reported once, not once per call')
})

test('a slow job that is converted to pending behaves as before (envelope shape) with tracing on', async () => {
  const api = fakeApi({ db: { todos: { list: () => new Promise((r) => setTimeout(() => r([]), 80)) } } })
  const withTrace = make({ api, dispatcherOptions: { softDeadlineMs: 20 } })
  const hub = new EventHub()
  const bare = new Dispatcher({ getApi: () => api, hub, queue: { stats: () => ({}) }, info: () => ({}), softDeadlineMs: 20 })
  try {
    const a = await withTrace.call('db.todos.list')
    const b = await bare.call('db.todos', { path: 'db.todos.list', args: [] })
    assert.deepEqual({ ...a, jobId: '' }, { ...b, jobId: '' })
    const polled = await withTrace.dispatcher.call('job', { path: 'job.poll', args: [{ jobId: a.jobId, waitMs: 2000 }] })
    assert.deepEqual(polled, { ok: true, value: [] })
  } finally { withTrace.cleanup(); bare.dispose(); hub.dispose() }
})

// ───────────── whole assembly ─────────────

function fakeLinePort() {
  return {
    start() {}, stop() {},
    status: () => ({ state: 'running', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 }),
    onMessage: () => () => undefined, onStatus: () => () => undefined, getMessagesSince: async () => []
  }
}

test('createPluginBackend writes <dataDir>/logs/invoke-trace.log by default, writes stop on dispose, and trace:false turns it off', async () => {
  assert.equal(INVOKE_TRACE_RELATIVE_FILE, join('logs', 'invoke-trace.log'))
  const dataDir = tempDir('assembly')
  const backend = await createPluginBackend({ pluginId: 'tuqdev.line-todo', version: '9.9.9', dataDir, line: fakeLinePort() })
  const file = join(dataDir, INVOKE_TRACE_RELATIVE_FILE)
  try {
    const reply = await backend.call('ping', { path: 'ping', args: [] })
    assert.equal(reply.ok, true)
    const records = readRecords(file)
    assert.deepEqual(records.slice(0, 1).map((r) => [r.ev, r.ver, r.slowMs, r.stallMs]), [['boot', '9.9.9', 2000, 1000]])
    assert.ok(records.some((r) => r.ev === 'start' && r.p === 'ping'))
    assert.ok(records.some((r) => r.ev === 'end' && r.p === 'ping' && r.res === 'ok'))
  } finally { await backend.dispose() }
  assert.equal(readRecords(file).at(-1).ev, 'stop', 'a clean shutdown ends with stop')
  rmSync(dataDir, { recursive: true, force: true })

  const quietDir = tempDir('assembly-off')
  const quiet = await createPluginBackend({ pluginId: 'p', version: '1', dataDir: quietDir, line: fakeLinePort(), trace: false })
  try {
    await quiet.call('ping', { path: 'ping', args: [] })
    assert.ok(!existsSync(join(quietDir, 'logs')))
  } finally { await quiet.dispose(); rmSync(quietDir, { recursive: true, force: true }) }
})
