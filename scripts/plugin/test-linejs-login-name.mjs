// QR login device name: the plugin's QR login sends LINE_LOGIN_DEVICE_NAME as the systemName and modelName of the QR v3 login
// (qrCodeLoginV2ForSecure), not LINEJS's defaults (linejs-v2 / evex-device); the device type stays ANDROIDSECONDARY.
//
// The real LINEJS 3.6.4 BaseClient / Login / RequestClient run the flow (requestSQR2 → qrCodeLoginV2ForSecure → the thrift struct).
// Only the LINE round trips are replaced: the Login steps before the final call, RequestClient.request (it records the thrift struct
// instead of sending it), and the E2EE / ready() calls after it. Every fetch handed to LINEJS throws and is counted: nothing reaches LINE.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const { BaseClient } = await import('@evex-dev/linejs/base')
const { Client, loginWithQR } = await import('@evex-dev/linejs')
const { LINE_LOGIN_DEVICE_NAME, loginWithNamedQR, nameQrLogin } = await import('../../src/plugin/backend/linejsLoginName.ts')
const { LineJsMediaService } = await import('../../src/plugin/backend/linejsMedia.ts')

const LINEJS_DEFAULTS = ['linejs-v2', 'evex-device']
const QR_URL = 'https://line.me/R/au/lgn/sq/test-session'
const NONCE = 'nonce-test-1'
const PIN = '246810'

// LINEJS does not export Login / RequestClient / E2EE: reach their prototypes through one client (constructing it sends nothing).
const probe = new BaseClient({ device: 'ANDROIDSECONDARY', fetch: async () => { throw new Error('probe never fetches') } })
const LoginProto = Object.getPrototypeOf(probe.loginProcess)
const RequestProto = Object.getPrototypeOf(probe.request)
const E2EEProto = Object.getPrototypeOf(probe.e2ee)

/** A fetch that never reaches the network: every call is counted and refused. */
function noNetwork() {
  const calls = []
  const fetch = async (input) => { calls.push(String(input?.url ?? input)); throw Object.assign(new Error('test: no network'), { code: 'TEST_NO_NETWORK' }) }
  return { fetch, calls }
}

/**
 * Replaces LINE's side of the QR v3 login for this test (node:test restores every mock after the test). `pin`: the certificate check
 * fails, so LINEJS asks for a PIN (createPinCode → pincall → checkPinCodeVerified) before the final call.
 * Returns the recorded qrCodeLoginV2ForSecure calls: `args` as the Login method received them, `struct` as RequestClient got it.
 */
function fakeLine(t, { pin = false } = {}) {
  const sent = []
  t.mock.method(LoginProto, 'createSession', async () => ({ 1: 'sqr-test-session' }))
  t.mock.method(LoginProto, 'createQrCodeForSecure', async () => ({ 1: QR_URL, 2: 1, 3: 1, 4: NONCE }))
  t.mock.method(LoginProto, 'checkQrCodeVerified', async () => true)
  t.mock.method(LoginProto, 'getQrCert', async () => 'qr-cert')
  t.mock.method(LoginProto, 'verifyCertificate', async () => { if (pin) throw new Error('test: certificate not accepted') })
  t.mock.method(LoginProto, 'createPinCode', async () => ({ 1: PIN }))
  t.mock.method(LoginProto, 'checkPinCodeVerified', async () => true)
  t.mock.method(LoginProto, 'ready', async () => {})
  t.mock.method(E2EEProto, 'registerE2EEKeyPair', async () => {})
  t.mock.method(E2EEProto, 'verifyLoginKey', async () => {})
  const v2 = t.mock.method(LoginProto, 'qrCodeLoginV2ForSecure') // spy: calls the real LINEJS method
  t.mock.method(RequestProto, 'request', async (value, methodName, protocolType, parse, requestPath) => {
    if (methodName !== 'qrCodeLoginV2ForSecure') throw new Error(`test: unexpected LINE call ${methodName}`)
    sent.push({ value, protocolType, parse, requestPath })
    return { 3: { 1: 'access-token-test', 2: 'refresh-token-test', 3: 1_700_000_000, 6: 3600 }, 6: {} }
  })
  return {
    calls: () => v2.mock.calls.map((call) => ({ args: call.arguments, struct: sent[v2.mock.calls.indexOf(call)] })),
    sent,
  }
}

/** The fields of the QrCodeLoginV2ForSecureRequest struct, by thrift field id (1 authSessionId, 2 systemName, 3 modelName, 4 autoLogin, 5 nonce). */
function requestFields(sent) {
  const [[type, id, fields]] = sent.value
  assert.equal(type, 12)
  assert.equal(id, 1)
  return Object.fromEntries(fields.map(([, fieldId, value]) => [fieldId, value]))
}

function assertNamed(line) {
  const calls = line.calls()
  assert.equal(calls.length, 1, 'the QR v3 login ends with exactly one qrCodeLoginV2ForSecure call')
  const [authSessionId, nonce, modelName, systemName, autoLoginIsRequired] = calls[0].args
  assert.equal(authSessionId, 'sqr-test-session')
  assert.equal(nonce, NONCE)
  assert.equal(modelName, LINE_LOGIN_DEVICE_NAME)
  assert.equal(systemName, LINE_LOGIN_DEVICE_NAME)
  assert.equal(autoLoginIsRequired, undefined, 'autoLoginIsRequired keeps the LINEJS default')
  assert.equal(line.sent.length, 1)
  const fields = requestFields(line.sent[0])
  assert.equal(line.sent[0].requestPath, '/acct/lgn/sq/v1')
  assert.equal(fields[2], LINE_LOGIN_DEVICE_NAME, 'systemName on the wire (field 2)')
  assert.equal(fields[3], LINE_LOGIN_DEVICE_NAME, 'modelName on the wire (field 3)')
  assert.equal(fields[4], true)
  assert.equal(fields[5], NONCE)
  for (const value of Object.values(fields)) assert.ok(!LINEJS_DEFAULTS.includes(value), `LINEJS default ${value} was sent`)
}

test('the device name is one named constant: 快組隊 人人有AI LINE待辦管理', () => {
  assert.equal(LINE_LOGIN_DEVICE_NAME, '快組隊 人人有AI LINE待辦管理')
})

test('control: stock LINEJS loginWithQR sends its defaults (linejs-v2 / evex-device) through the same fake LINE — the harness sees the real names', async (t) => {
  const line = fakeLine(t)
  const net = noNetwork()
  await loginWithQR({ onReceiveQRUrl() {}, onPincodeRequest() {} }, { device: 'ANDROIDSECONDARY', fetch: net.fetch })
  const fields = requestFields(line.sent[0])
  assert.equal(fields[2], 'linejs-v2')
  assert.equal(fields[3], 'evex-device')
  assert.deepEqual(net.calls, [])
})

test('QR v3 login: qrCodeLoginV2ForSecure receives the constant as systemName and modelName; device stays ANDROIDSECONDARY; no network', async (t) => {
  const line = fakeLine(t)
  const net = noNetwork()
  const qrUrls = []
  const pins = []
  const client = await loginWithNamedQR({ onReceiveQRUrl: (url) => { qrUrls.push(url) }, onPincodeRequest: (pin) => { pins.push(pin) } }, { device: 'ANDROIDSECONDARY', fetch: net.fetch })
  assertNamed(line)
  assert.ok(client instanceof Client)
  assert.equal(client.base.device, 'ANDROIDSECONDARY')
  assert.equal(client.base.authToken, 'access-token-test')
  assert.equal(qrUrls.length, 1)
  assert.ok(qrUrls[0].startsWith(QR_URL), 'the QR URL reaches onReceiveQRUrl')
  assert.deepEqual(pins, [])
  assert.deepEqual(net.calls, [])
})

test('QR v3 login with a PIN: the PIN reaches onPincodeRequest and the final call still carries the constant', async (t) => {
  const line = fakeLine(t, { pin: true })
  const net = noNetwork()
  const pins = []
  await loginWithNamedQR({ onReceiveQRUrl() {}, onPincodeRequest: (pin) => { pins.push(pin) } }, { device: 'ANDROIDSECONDARY', fetch: net.fetch })
  assert.deepEqual(pins, [PIN])
  assertNamed(line)
  assert.deepEqual(net.calls, [])
})

test('the name is set on this login only: another LINEJS client built afterwards still has the stock method', async (t) => {
  fakeLine(t)
  const net = noNetwork()
  await loginWithNamedQR({ onReceiveQRUrl() {}, onPincodeRequest() {} }, { device: 'ANDROIDSECONDARY', fetch: net.fetch })
  const other = new BaseClient({ device: 'ANDROIDSECONDARY', fetch: net.fetch })
  assert.equal(Object.hasOwn(other.loginProcess, 'qrCodeLoginV2ForSecure'), false)
  assert.equal(other.loginProcess.qrCodeLoginV2ForSecure, LoginProto.qrCodeLoginV2ForSecure)
})

test('fails closed: a Login without qrCodeLoginV2ForSecure is refused before any QR is shown', () => {
  assert.throws(() => nameQrLogin({}), { code: 'LINEJS_LOGIN_NAME_UNSUPPORTED' })
})

test('LineJsMediaService default QR login (no adapter) sends the constant and commits the session: authenticated, fresh session id; no network', async (t) => {
  const line = fakeLine(t)
  const net = noNetwork()
  t.mock.method(globalThis, 'fetch', net.fetch)
  const root = await mkdtemp(path.join(os.tmpdir(), 'line-todo-linejs-login-name-'))
  const service = await LineJsMediaService.create(root, { encodeQr: async () => 'data:image/png;base64,qr' })
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }) })
  assert.deepEqual(await service.startLogin(), { status: 'pending' })
  const deadline = Date.now() + 10_000
  let status = await service.status()
  while (status.login.status !== 'authenticated' && Date.now() < deadline) {
    assert.notEqual(status.login.status, 'failed', JSON.stringify(status.login))
    await new Promise((resolve) => setTimeout(resolve, 10))
    status = await service.status()
  }
  assert.equal(status.login.status, 'authenticated')
  assertNamed(line)
  assert.match(service.currentSessionId() ?? '', /^[0-9a-f-]{36}$/)
  assert.equal(service.loginActive(), false)
  assert.deepEqual(net.calls, [])
})
