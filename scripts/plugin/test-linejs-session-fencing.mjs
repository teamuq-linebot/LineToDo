// LINEJS session fencing for outbound sends (LineJsMediaService): a fresh session id per installed client, and the QR login commit race
// (REVIEW-LOGIN-CANCEL-COMMIT-001): a cancel / timeout / logout / dispose that completes while the login continuation is committing the
// session must never make the cancelled login the live client. Synthetic LINEJS stand-ins only; nothing talks to LINE.
//
// The commit interleaving is made deterministic by intercepting fs/promises.rename (module.syncBuiltinESMExports updates the named ESM
// binding linejsMedia.ts imported): the cancel is started right after the session file is renamed into place and before the continuation
// resumes — the window the review reproduced.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const fsp = require('node:fs/promises')
const realRename = fsp.rename
const realUnlink = fsp.unlink
const realReadFile = fsp.readFile
let renameHook = null
/** while > 0, removing linejs-session.json waits this long first: a restore started meanwhile gets every chance to read the file */
let sessionUnlinkDelayMs = 0
/** while set, removing linejs-login-attempt.json waits for this promise first (holds a login's cleanup open — fix3) */
let attemptUnlinkHold = null
/** while set, reading linejs-session.json waits for this promise first (holds a restore before it knows whether a session is saved — fix3) */
let sessionReadHold = null
fsp.rename = (from, to) => (renameHook ? renameHook(from, to) : realRename(from, to))
fsp.unlink = async (file) => {
  if (sessionUnlinkDelayMs > 0 && path.basename(String(file)) === 'linejs-session.json') await new Promise((resolve) => setTimeout(resolve, sessionUnlinkDelayMs))
  if (attemptUnlinkHold && path.basename(String(file)) === 'linejs-login-attempt.json') await attemptUnlinkHold
  return realUnlink(file)
}
fsp.readFile = async (file, ...rest) => {
  if (sessionReadHold && path.basename(String(file)) === 'linejs-session.json') await sessionReadHold
  return realReadFile(file, ...rest)
}
syncBuiltinESMExports()
test.after(() => { fsp.rename = realRename; fsp.unlink = realUnlink; fsp.readFile = realReadFile; syncBuiltinESMExports() })

const { LineJsMediaService } = await import('../../src/plugin/backend/linejsMedia.ts')

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))
/** waits for `promise` (a state the test observes, not a guessed delay); fails with `label` if it is not reached within `ms` */
const reached = (promise, label, ms = 10_000) => {
  let timer
  return Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`never reached: ${label}`)), ms) })]).finally(() => clearTimeout(timer))
}
const exists = (file) => access(file).then(() => true, () => false)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function fakeClient(mid = 'uQRACCOUNT001') {
  const events = new EventEmitter()
  // off() ignores an undefined listener, like LINEJS's TypedEventEmitter (logout/dispose call off(…, undefined) when nothing is receiving)
  const client = { authToken: `token-${mid}`, listens: 0, on: events.on.bind(events), off: (event, listener) => { if (listener) events.off(event, listener) }, listen() { client.listens++ }, base: { profile: { mid }, on() {} } }
  return client
}

async function setup(t, { receive = false, tokenLogin } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'line-todo-linejs-fencing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dataDir = path.join(root, 'plugin')
  if (receive) {
    await fsp.mkdir(dataDir, { recursive: true })
    await writeFile(path.join(dataDir, 'linejs-settings.json'), JSON.stringify({ receiveEnabled: true }))
  }
  const qrClient = fakeClient()
  const tokenCalls = []
  const service = await LineJsMediaService.create(dataDir, {
    loginWithQR: async (_callbacks, init) => { await init.storage.set('linejs-auth-token', qrClient.authToken); return qrClient },
    loginWithAuthToken: async (token, init) => { tokenCalls.push(token); return tokenLogin ? tokenLogin(token, init) : fakeClient('uRESTORED0001') }
  })
  t.after(() => service.dispose())
  const sessions = []
  service.onSessionChange((id) => sessions.push(id))
  return { dataDir, service, qrClient, tokenCalls, sessions, sessionFile: path.join(dataDir, 'linejs-session.json') }
}

async function loginSettled(service) {
  for (let i = 0; i < 200; i++) {
    const state = await service.status()
    if (state.login.status !== 'pending') return state
    await tick()
  }
  assert.fail('login never settled')
}

/** start a login whose session rename is followed — before the continuation resumes — by `interrupt()` */
async function loginInterruptedAtCommit(env, interrupt) {
  let interrupted = false
  renameHook = async (from, to) => {
    await realRename(from, to)
    if (path.basename(to) === 'linejs-session.json' && !interrupted) { interrupted = true; renameHook = null; void interrupt() }
  }
  sessionUnlinkDelayMs = 40
  try {
    await env.service.startLogin()
    for (let i = 0; i < 200 && !interrupted; i++) await tick()
    assert.ok(interrupted, 'the commit rename happened')
    await tick(120)
  } finally { renameHook = null; sessionUnlinkDelayMs = 0 }
}

test('control: an uninterrupted QR login installs the client with a fresh session id; logout clears it; the next login gets a different id', async (t) => {
  const env = await setup(t)
  assert.equal(env.service.currentSessionId(), null)
  assert.equal(await env.service.outboundSession(), null)
  await env.service.startLogin()
  assert.equal((await loginSettled(env.service)).login.status, 'authenticated')
  const first = env.service.currentSessionId()
  assert.match(first, UUID)
  const session = await env.service.outboundSession()
  assert.equal(session.sessionId, first)
  assert.equal(session.client, env.qrClient)
  assert.equal(session.ownerMid, 'uQRACCOUNT001')
  assert.equal(env.service.isCurrentSession(first, env.qrClient), true)
  assert.equal(env.service.isCurrentSession(first, {}), false)
  assert.deepEqual(await env.service.outboundPeek(), { state: 'ready', sessionId: first, ownerMid: 'uQRACCOUNT001' })
  assert.ok(await exists(env.sessionFile))

  await env.service.logout()
  assert.equal(env.service.currentSessionId(), null)
  assert.equal(env.service.isCurrentSession(first, env.qrClient), false)
  assert.equal((await env.service.outboundPeek()).state, 'not_logged_in')

  await env.service.startLogin()
  await loginSettled(env.service)
  const second = env.service.currentSessionId()
  assert.match(second, UUID)
  assert.notEqual(second, first)
  assert.deepEqual(env.sessions, [first, null, second])
})

for (const [label, interrupt, expected] of [
  ['user cancel', (service) => service.cancelLogin(), 'cancelled'],
  ['120 s timeout', (service) => service.cancelLogin('LOGIN_TIMEOUT'), 'failed'],
  ['logout', (service) => service.logout(), 'idle']
]) {
  test(`QR commit race: a ${label} completing during the session rename never installs the cancelled login (no client, no session file, no receiver)`, async (t) => {
    const env = await setup(t, { receive: true })
    await loginInterruptedAtCommit(env, () => interrupt(env.service))
    const state = await env.service.status()
    assert.equal(state.login.status, expected)
    if (expected === 'failed') assert.equal(state.login.error.code, 'LOGIN_TIMEOUT')
    assert.equal(env.service.currentSessionId(), null)
    assert.deepEqual(env.sessions.filter((id) => id !== null), [], 'no client was ever installed (not even briefly); a logout only emits clears')
    assert.equal(env.qrClient.listens, 0, 'the cancelled account never started receiving')
    assert.equal(await exists(env.sessionFile), false, 'the committed session file was removed')
    assert.equal(await env.service.outboundSession(), null)
    assert.ok(!env.tokenCalls.includes(env.qrClient.authToken), 'a restore never brought the cancelled token back')
  })
}

test('QR commit race: dispose completing during the session rename never installs the client and leaves no session file', async (t) => {
  const env = await setup(t, { receive: true })
  await loginInterruptedAtCommit(env, () => env.service.dispose())
  assert.equal(env.service['client'], null)
  assert.equal(env.service.currentSessionId(), null)
  assert.equal(env.qrClient.listens, 0)
  assert.equal(await exists(env.sessionFile), false)
})

test('outboundSession waits for a restore in progress instead of answering null; outboundPeek reports restoring, then ready', async (t) => {
  let finish
  const restored = fakeClient('uRESTORED0001')
  const env = await setup(t, { tokenLogin: () => new Promise((resolve) => { finish = () => resolve(restored) }) })
  assert.equal((await env.service.outboundPeek()).state, 'not_logged_in', 'no saved session')
  await fsp.mkdir(env.dataDir, { recursive: true })
  await writeFile(env.sessionFile, JSON.stringify({ 'linejs-auth-token': 'saved-token' }))
  const status = env.service.status() // starts the restore (network-bound in production)
  await tick()
  assert.equal((await env.service.outboundPeek()).state, 'restoring')
  let answered = false
  const pending = env.service.outboundSession().then((value) => { answered = true; return value })
  await tick(20)
  assert.equal(answered, false, 'still waiting for the restore')
  finish()
  const session = await pending
  await status
  assert.equal(session.client, restored)
  assert.equal(session.ownerMid, 'uRESTORED0001')
  assert.match(session.sessionId, UUID)
  assert.deepEqual(await env.service.outboundPeek(), { state: 'ready', sessionId: session.sessionId, ownerMid: 'uRESTORED0001' })
  assert.deepEqual(env.tokenCalls, ['saved-token'])
})

test('outboundPeek starts a background restore of a saved session without waiting for it, and does not retry a failed restore immediately', async (t) => {
  let calls = 0
  const env = await setup(t, { tokenLogin: async () => { calls++; throw Object.assign(new Error('network down'), { code: 'NETWORK' }) } })
  await fsp.mkdir(env.dataDir, { recursive: true })
  await writeFile(env.sessionFile, JSON.stringify({ 'linejs-auth-token': 'saved-token' }))
  assert.equal((await env.service.outboundPeek()).state, 'restoring')
  await tick(20)
  assert.equal(calls, 1)
  assert.equal((await env.service.outboundPeek()).state, 'not_logged_in', 'a failed restore is reported, not retried on every status')
  assert.equal(calls, 1)
})

// ── D5 (REV-CL-002/003): a QR login in progress owns the session; polled status() never token-logs the stale session over it ──

/** a service whose QR login shows a QR and then waits for `confirm()`, and whose token login is scripted by the test */
async function pendingQrSetup(t, { tokenLogin }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'line-todo-linejs-pending-qr-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dataDir = path.join(root, 'plugin')
  await fsp.mkdir(dataDir, { recursive: true })
  const sessionFile = path.join(dataDir, 'linejs-session.json')
  await writeFile(sessionFile, JSON.stringify({ 'linejs-auth-token': 'stale-token' }))
  const qrClient = fakeClient()
  const tokenCalls = []
  let confirm
  const service = await LineJsMediaService.create(dataDir, {
    encodeQr: async (value) => `qr:${value}`,
    loginWithQR: async (callbacks, init) => {
      await callbacks.onReceiveQRUrl('line://au/q/pending')
      await new Promise((resolve) => { confirm = resolve })
      await init.storage.set('linejs-auth-token', qrClient.authToken)
      return qrClient
    },
    loginWithAuthToken: async (token, init) => { tokenCalls.push(token); return tokenLogin(token, init) }
  })
  t.after(() => service.dispose())
  return { service, tokenCalls, sessionFile, qrClient, confirm: () => confirm() }
}
const rejected = () => Object.assign(new Error('LINE token rejected (synthetic)'), { code: 'TOKEN_REJECTED' })

test('REV-CL-002: while a QR login is pending, status() polls and outboundPeek run no token login of the saved session and never replace the pending login or its QR', async (t) => {
  const env = await pendingQrSetup(t, { tokenLogin: async () => { throw rejected() } })
  assert.deepEqual(await env.service.startLogin(), { status: 'pending' })
  let state
  for (let i = 0; i < 100; i++) { state = await env.service.status(); if (state.login.qr) break; await tick() }
  assert.deepEqual(state.login, { status: 'pending', qr: 'qr:line://au/q/pending' })
  for (let i = 0; i < 5; i++) assert.deepEqual((await env.service.status()).login, { status: 'pending', qr: 'qr:line://au/q/pending' }, `poll ${i} keeps the QR`)
  assert.equal((await env.service.outboundPeek()).state, 'not_logged_in', 'peek does not start a restore during the login')
  await tick(20)
  assert.deepEqual(env.tokenCalls, [], 'no token login of the stale session while the QR login is pending')
  env.confirm()
  const settled = await loginSettled(env.service)
  assert.equal(settled.login.status, 'authenticated')
  assert.deepEqual(env.tokenCalls, [])
  assert.equal(env.service.currentSessionId() !== null, true, 'the QR login became the session')
})

test('REV-CL-002: a restore that fails after a QR login has started does not overwrite it, and a failed restore is not retried on every status() poll', async (t) => {
  let fail
  let atTokenLogin
  const restoreAtNetwork = new Promise((resolve) => { atTokenLogin = resolve })
  // the first restore is held until the login has started; any later one is rejected at once (so a missing back-off fails fast, not by hanging)
  const env = await pendingQrSetup(t, { tokenLogin: () => { atTokenLogin(); return fail ? Promise.reject(rejected()) : new Promise((_resolve, reject) => { fail = () => reject(rejected()) }) } })
  const polled = env.service.status() // starts a restore of the stale token (network-bound in production)
  // the restore reads the session file before its token login: wait for it to reach the network stage (a fixed tick raced that file read)
  await reached(restoreAtNetwork, 'the restore reached its token login')
  assert.equal(env.tokenCalls.length, 1)
  assert.deepEqual(await env.service.startLogin(), { status: 'pending' })
  fail()
  const during = await polled
  assert.equal(during.login.status, 'pending', 'the restore failure does not replace the login that started meanwhile')
  await env.service.cancelLogin()
  for (let i = 0; i < 5; i++) await env.service.status()
  assert.equal(env.tokenCalls.length, 1, 'status() polls after a failed restore do not token-login again within the back-off')
})

test('REV-CL-003: startLogin while another login is pending answers joined, and the joined call starts nothing new', async (t) => {
  const env = await pendingQrSetup(t, { tokenLogin: async () => { throw rejected() } })
  assert.deepEqual(await env.service.startLogin(), { status: 'pending' }, 'the first caller owns the login')
  assert.deepEqual(await env.service.startLogin(), { status: 'pending', joined: true }, 'a second caller joins it')
  env.confirm()
  assert.equal((await loginSettled(env.service)).login.status, 'authenticated')
})

// ── 2026-11-13 login PIN (AC1/AC2), status never waiting on LINE (AC3) and login priority over the backlog drain (AC3/AC4) ──
// LINEJS requestSQR2: QR ("qrcall") → the phone scans → verifyCertificate fails on a new device → createPinCode → "pincall" (onPincodeRequest)
// → checkPinCodeVerified long-polls until the PIN is typed on the phone → qrCodeLoginV2ForSecure. The stand-in below plays that sequence.

const { LineWatcher } = await import('../../src/main/line/watcher.ts')
const { Dispatcher } = await import('../../src/plugin/backend/dispatcher.ts')
const { EventHub } = await import('../../src/plugin/backend/eventHub.ts')
const { InvokeTrace } = await import('../../src/plugin/backend/invokeTrace.ts')

const PIN = '482913'

/** a service whose QR login waits for `scan(pin?)` (a pin = LINE asks for it) and then for `confirm()` / `reject(error)` */
async function pinSetup(t, { loginTimeoutMs, tokenLogin, saved } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'line-todo-linejs-pin-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dataDir = path.join(root, 'plugin')
  await fsp.mkdir(dataDir, { recursive: true })
  const sessionFile = path.join(dataDir, 'linejs-session.json')
  if (saved) await writeFile(sessionFile, JSON.stringify({ 'linejs-auth-token': saved }))
  const qrClient = fakeClient()
  const attempts = []
  const tokenCalls = []
  const service = await LineJsMediaService.create(dataDir, {
    loginTimeoutMs,
    encodeQr: async (value) => `qr:${value}`,
    loginWithQR: async (callbacks, init) => {
      const attempt = {}
      attempt.scanned = new Promise((resolve) => { attempt.scan = resolve })
      attempt.done = new Promise((resolve, reject) => { attempt.confirm = resolve; attempt.reject = reject })
      attempts.push(attempt)
      await callbacks.onReceiveQRUrl(`line://au/q/pin-${attempts.length}`)
      const pin = await attempt.scanned
      if (pin) callbacks.onPincodeRequest(pin)
      await attempt.done
      await init.storage.set('linejs-auth-token', qrClient.authToken)
      return qrClient
    },
    loginWithAuthToken: async (token, init) => { tokenCalls.push(token); return tokenLogin ? tokenLogin(token, init) : fakeClient('uRESTORED0001') }
  })
  t.after(() => service.dispose())
  return { root, dataDir, sessionFile, service, qrClient, attempts, tokenCalls }
}

async function loginUntil(service, predicate, label, max = 400) {
  let state
  for (let i = 0; i < max; i++) { state = await service.status(); if (predicate(state.login)) return state.login; await tick() }
  assert.fail(`login never reached: ${label} (last ${JSON.stringify(state?.login?.status)})`)
}

/** every regular file under `dir`, read as bytes (the PIN must not be in any of them) */
async function filesContaining(dir, needle) {
  const hits = []
  const walk = async (current) => {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && (await fsp.readFile(full)).includes(Buffer.from(needle))) hits.push(path.relative(dir, full))
    }
  }
  await walk(dir)
  return hits
}

/** console output written while `run()` runs (the PIN must not be in it) */
async function captureConsole(run) {
  const lines = []
  const names = ['log', 'info', 'warn', 'error', 'debug']
  const saved = names.map((name) => console[name])
  for (const name of names) console[name] = (...args) => { lines.push(args.map(String).join(' ')) }
  try { await run() } finally { names.forEach((name, i) => { console[name] = saved[i] }) }
  return lines.join('\n')
}

test('PIN (AC1/AC2): after the scan LINE asks for a PIN → status() carries it instead of the QR (also through the Dispatcher); typing it completes the login → authenticated without a pin; the PIN reaches no file (session, attempt, invoke trace) and no console output', async (t) => {
  const env = await pinSetup(t)
  const logs = path.join(env.dataDir, 'logs')
  await fsp.mkdir(logs, { recursive: true })
  const trace = new InvokeTrace({ file: path.join(logs, 'invoke-trace.log') })
  const hub = new EventHub()
  const dispatcher = new Dispatcher({ getApi: () => ({}), hub, queue: {}, info: () => ({}), linejsMedia: env.service, trace })
  t.after(() => { dispatcher.dispose(); hub.dispose(); trace.stop() })
  const viaDispatcher = async () => {
    const envelope = await dispatcher.call('linejsMedia', { path: 'linejsMedia.status', args: [] })
    assert.equal(envelope.ok, true)
    return envelope.value.login
  }
  const output = await captureConsole(async () => {
    assert.deepEqual(await env.service.startLogin(), { status: 'pending' })
    assert.deepEqual(await loginUntil(env.service, (login) => Boolean(login.qr), 'QR'), { status: 'pending', qr: 'qr:line://au/q/pin-1' })
    assert.equal(env.service.loginActive(), true)
    env.attempts[0].scan(PIN)
    assert.deepEqual(await loginUntil(env.service, (login) => Boolean(login.pin), 'PIN'), { status: 'pending', pin: PIN }, 'the PIN replaces the scanned QR')
    assert.deepEqual(await viaDispatcher(), { status: 'pending', pin: PIN }, 'linejsMedia.status (the views’ path) carries the PIN')
    for (let i = 0; i < 3; i++) assert.equal((await env.service.status()).login.pin, PIN, `poll ${i} keeps the PIN while LINE waits for it`)
    assert.equal(env.service.loginActive(), true)
    assert.deepEqual(await filesContaining(env.root, PIN), [], 'while shown, the PIN is in no file (attempt storage, invoke trace)')
    env.attempts[0].confirm()
    const settled = await loginSettled(env.service)
    assert.deepEqual(settled.login, { status: 'authenticated' }, 'authenticated, no pin left in the view')
    assert.deepEqual(await viaDispatcher(), { status: 'authenticated' })
  })
  assert.equal(env.service.loginActive(), false)
  assert.equal(env.service['loginState'].pin, undefined, 'the PIN is dropped from memory once the login is done')
  assert.ok(await exists(env.sessionFile), 'the confirmed login saved its session')
  assert.deepEqual(await filesContaining(env.root, PIN), [], 'the PIN is in no file afterwards (session, trace)')
  assert.ok(!output.includes(PIN), 'the PIN never reached console output')
  const traced = await fsp.readFile(path.join(logs, 'invoke-trace.log'), 'utf8')
  assert.match(traced, /linejsMedia\.status/, 'the trace did record the status calls (so the scan above looked at a written trace)')
})

test('PIN timeout (AC2): the PIN gets a fresh login window; if it is not typed in time the login fails with LOGIN_TIMEOUT, nothing of the PIN is kept, and 重試 starts a new QR', async (t) => {
  const env = await pinSetup(t, { loginTimeoutMs: 400 })
  const started = Date.now()
  await env.service.startLogin()
  await loginUntil(env.service, (login) => Boolean(login.qr), 'QR')
  await new Promise((resolve) => setTimeout(resolve, 250))
  env.attempts[0].scan(PIN)
  await loginUntil(env.service, (login) => Boolean(login.pin), 'PIN')
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, started + 500 - Date.now())))
  assert.deepEqual((await env.service.status()).login, { status: 'pending', pin: PIN }, 'past the first window: the PIN restarted it')
  const failed = await loginUntil(env.service, (login) => login.status !== 'pending', 'timeout', 600)
  assert.deepEqual(failed, { status: 'failed', error: { code: 'LOGIN_TIMEOUT', message: 'LINE 登入逾時，請重新開始。' } }, 'a retryable timeout, no pin')
  assert.equal(env.service.loginActive(), false)
  assert.deepEqual(await env.service.startLogin(), { status: 'pending' }, 'retry starts a new login')
  assert.deepEqual(await loginUntil(env.service, (login) => Boolean(login.qr), 'new QR'), { status: 'pending', qr: 'qr:line://au/q/pin-2' })
})

test('PIN rejected (AC2): LINE failing after the PIN → failed with a fixed code and no pin; the retry gets a new QR and a new PIN and completes', async (t) => {
  const env = await pinSetup(t)
  await env.service.startLogin()
  await loginUntil(env.service, (login) => Boolean(login.qr), 'QR')
  env.attempts[0].scan(PIN)
  await loginUntil(env.service, (login) => Boolean(login.pin), 'PIN')
  env.attempts[0].reject(Object.assign(new Error('checkPinCodeVerified timed out (synthetic)'), { code: 'PIN_TIMEOUT' }))
  const failed = await loginUntil(env.service, (login) => login.status !== 'pending', 'failure')
  assert.deepEqual(failed, { status: 'failed', error: { code: 'PIN_TIMEOUT', message: 'LINE 連線失敗（PIN_TIMEOUT）' } })
  await env.service.startLogin()
  assert.deepEqual(await loginUntil(env.service, (login) => login.qr === 'qr:line://au/q/pin-2', 'new QR'), { status: 'pending', qr: 'qr:line://au/q/pin-2' })
  env.attempts[1].scan('135790')
  assert.equal((await loginUntil(env.service, (login) => Boolean(login.pin), 'new PIN')).pin, '135790')
  env.attempts[1].confirm()
  assert.deepEqual((await loginSettled(env.service)).login, { status: 'authenticated' })
})

test('PIN from a cancelled login is ignored: a late onPincodeRequest after cancel (or of an old generation) never shows a PIN', async (t) => {
  const env = await pinSetup(t)
  await env.service.startLogin()
  await loginUntil(env.service, (login) => Boolean(login.qr), 'QR')
  await env.service.cancelLogin()
  env.attempts[0].scan(PIN)
  await tick(20)
  assert.deepEqual((await env.service.status()).login, { status: 'cancelled' })
})

test('status (AC3): a restore of the saved session that hangs on LINE never holds status() — it answers within ~2 s with restoring; the restore finishing later shows authenticated', async (t) => {
  let finish
  const restored = fakeClient('uRESTORED0001')
  const env = await pinSetup(t, { saved: 'saved-token', tokenLogin: () => new Promise((resolve) => { finish = () => resolve(restored) }) })
  const t0 = Date.now()
  const answered = await Promise.race([env.service.status(), new Promise((resolve) => setTimeout(() => resolve('still waiting after 6 s'), 6_000))])
  const took = Date.now() - t0
  assert.notEqual(answered, 'still waiting after 6 s', 'status() must not wait for the network token login')
  assert.ok(took < 4_000, `status answered in ${took} ms`)
  assert.deepEqual(answered.login, { status: 'restoring' })
  const t1 = Date.now()
  assert.deepEqual((await env.service.status()).login, { status: 'restoring' }, 'a poll during the same restore does not start another one')
  assert.ok(Date.now() - t1 < 4_000)
  assert.deepEqual(env.tokenCalls, ['saved-token'])
  finish()
  await tick(10)
  assert.deepEqual((await env.service.status()).login, { status: 'authenticated' })
})

test('status (AC3): a slow restore that fails after status() answered is recorded (failed) and backed off — no token login on every poll', async (t) => {
  const env = await pinSetup(t, { saved: 'stale-token', tokenLogin: () => new Promise((_resolve, reject) => setTimeout(() => reject(rejected()), 2_400)) })
  const first = await env.service.status()
  assert.deepEqual(first.login, { status: 'restoring' })
  await new Promise((resolve) => setTimeout(resolve, 700))
  const after = await env.service.status()
  assert.deepEqual(after.login, { status: 'failed', error: { code: 'TOKEN_REJECTED', message: 'LINE 連線失敗（TOKEN_REJECTED）' } })
  for (let i = 0; i < 5; i++) await env.service.status()
  assert.equal(env.tokenCalls.length, 1, 'the failed restore is not retried within the back-off')
})

test('drain priority (AC3/AC4): while a QR login is active (QR, PIN) the watcher defers its backlog drain; when the login ends the drain continues', async (t) => {
  const env = await pinSetup(t)
  const watcher = new LineWatcher({ intervalSec: 3600, drainBacklog: true, deferDrain: () => env.service.loginActive() })
  t.after(() => watcher.stop())
  let drains = 0
  watcher.poll = async (trigger) => { if (trigger === 'drain') drains++ }
  watcher['scheduleDrain']()
  await tick(30)
  assert.equal(drains, 1, 'no login: the next backlog batch is read at once')

  await env.service.startLogin()
  await loginUntil(env.service, (login) => Boolean(login.qr), 'QR')
  watcher['scheduleDrain']()
  await tick(700)
  assert.equal(drains, 1, 'QR shown: the backlog drain waits')
  env.attempts[0].scan(PIN)
  await loginUntil(env.service, (login) => Boolean(login.pin), 'PIN')
  await tick(700)
  assert.equal(drains, 1, 'PIN shown: still waiting')
  env.attempts[0].confirm()
  await loginSettled(env.service)
  await tick(800)
  assert.equal(drains, 2, 'login done: the drain continues')
  watcher.stop()
  watcher['scheduleDrain']()
  await tick(30)
  assert.equal(drains, 2, 'a stopped watcher schedules nothing')
})

// ── fix3 (2026-11-13): what status() publishes and whether the login is still active change in one step ──
// The login's file cleanup (removing linejs-login-attempt.json) is held open below, so the window between "outcome visible" and "login
// ended" — a few ms of real disk I/O that made the PIN test flaky — is wide and deterministic instead of a matter of luck.

/** holds every removal of linejs-login-attempt.json until the returned release() */
function holdAttemptCleanup() {
  let release
  attemptUnlinkHold = new Promise((resolve) => { release = resolve })
  return () => { release(); attemptUnlinkHold = null }
}

test('login end (fix3): the step that makes status() read authenticated also ends the login — loginActive() (the watcher\'s deferDrain) is false at once and the backlog drain resumes, even while the attempt cleanup is still running', async (t) => {
  const env = await pinSetup(t)
  const watcher = new LineWatcher({ intervalSec: 3600, drainBacklog: true, deferDrain: () => env.service.loginActive() })
  t.after(() => watcher.stop())
  let drains = 0
  watcher.poll = async (trigger) => { if (trigger === 'drain') drains++ }
  await env.service.startLogin()
  await loginUntil(env.service, (login) => Boolean(login.qr), 'QR')
  const release = holdAttemptCleanup()
  try {
    env.attempts[0].scan()
    env.attempts[0].confirm()
    assert.deepEqual(await loginUntil(env.service, (login) => login.status !== 'pending', 'outcome'), { status: 'authenticated' })
    assert.notEqual(env.service['loginStorageGuard'], null, 'precondition: the login\'s cleanup is still held open (the window is being tested)')
    assert.equal(env.service.loginActive(), false, 'authenticated is visible, so the login is over (not active until its cleanup ends)')
    watcher['scheduleDrain']()
    await tick(30)
    assert.equal(drains, 1, 'the backlog drain is not deferred by a login that already succeeded')
  } finally { release() }
})

test('login end (fix3): failed is published only after the attempt cleanup, together with the end of the login — never failed while still active; 重試 then starts a new login (not joined to the failed one)', async (t) => {
  const env = await pinSetup(t)
  await env.service.startLogin()
  await loginUntil(env.service, (login) => Boolean(login.qr), 'QR')
  env.attempts[0].scan(PIN)
  await loginUntil(env.service, (login) => Boolean(login.pin), 'PIN')
  const release = holdAttemptCleanup()
  try {
    env.attempts[0].reject(Object.assign(new Error('checkPinCodeVerified timed out (synthetic)'), { code: 'PIN_TIMEOUT' }))
    await tick(30)
    assert.notEqual(env.service['loginStorageGuard'], null, 'precondition: the login\'s cleanup is still held open (the window is being tested)')
    const during = (await env.service.status()).login
    assert.equal(during.status === 'failed', env.service.loginActive() === false, `the outcome is visible exactly when the login is over (saw ${during.status}, active ${env.service.loginActive()})`)
  } finally { release() }
  assert.deepEqual(await loginUntil(env.service, (login) => login.status !== 'pending', 'failure'), { status: 'failed', error: { code: 'PIN_TIMEOUT', message: 'LINE 連線失敗（PIN_TIMEOUT）' } })
  assert.equal(env.service.loginActive(), false)
  assert.deepEqual(await env.service.startLogin(), { status: 'pending' }, '重試 right after the failure owns a new login (no joined)')
  assert.deepEqual(await loginUntil(env.service, (login) => Boolean(login.qr), 'new QR'), { status: 'pending', qr: 'qr:line://au/q/pin-2' })
})

test('restoring (fix3): a restore that finds no saved session never reads restoring — a status() poll during its file read shows the real state (here idle), not 正在恢復已儲存的 LINE 登入', async (t) => {
  const env = await pinSetup(t)
  let release
  sessionReadHold = new Promise((resolve) => { release = resolve })
  let first
  try {
    first = env.service.status() // starts a restore; it is held at the session-file read
    await tick()
    assert.notEqual(env.service['restoreController'], null, 'the restore is running (held at its file read), so the poll below is inside the window')
    assert.deepEqual((await env.service.status()).login, { status: 'idle' }, 'nothing is saved: no restoring')
  } finally { release(); sessionReadHold = null }
  assert.deepEqual((await first).login, { status: 'idle' })
  assert.deepEqual(env.tokenCalls, [], 'no saved session, no token login')
})
