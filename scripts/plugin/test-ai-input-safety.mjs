import test from 'node:test'
import assert from 'node:assert/strict'
import { projectAiInputSafely } from '../../src/shared/aiInputSafety.ts'
import { createExtractWorker } from '../../src/plugin/backend/extractWorker.ts'

test('deep safety preparation redacts credential formats and nested serialized JSON while preserving ordinary content', () => {
  const canaries = [
    'Authorization: Bearer synthetic-auth-canary-123',
    'Bearer synthetic-bearer-canary-1234567890',
    'access_token=synthetic-access-canary',
    'refresh-token: synthetic-refresh-canary',
    'password="synthetic-password-canary"',
    'private_key=synthetic-private-canary',
    '-----BEGIN PRIVATE KEY-----\nsynthetic-pem-canary\n-----END PRIVATE KEY-----',
    'https://synthetic-user-canary:synthetic-url-pass-canary@example.invalid/path'
  ]
  const nested = JSON.stringify({ system: 'Project Orion ETA is pending', messages: [{ text: canaries[0] }], history: JSON.stringify({ todo: canaries.slice(1) }) })
  const result = projectAiInputSafely(nested)
  assert.equal(result.status, 'redacted')
  assert.ok(result.redactionCount >= canaries.length)
  for (const canary of canaries) assert.equal(result.payload.includes(canary), false, `leaked ${canary.slice(0, 18)}`)
  assert.match(result.payload, /Project Orion ETA is pending/)
  assert.match(result.payload, /\[REDACTED:CREDENTIAL\]/)
  assert.equal(result.safetyVersion.length > 0, true)
})

test('deep safety preparation preserves normal technical and business text', () => {
  const input = JSON.stringify({ text: 'Bearer is a protocol term; API-key rotation plan, Project Orion, ETA 2026-11-12, JSON schema and Q4 handoff.' })
  const result = projectAiInputSafely(input)
  assert.equal(result.status, 'ready')
  assert.equal(result.payload, input)
})

test('invalid or oversized preparation fails closed without exposing input', () => {
  const invalid = projectAiInputSafely(null)
  assert.equal(invalid.status, 'blocked')
  assert.equal('payload' in invalid, false)
  const oversized = projectAiInputSafely('synthetic-oversize-canary'.repeat(100_000))
  assert.equal(oversized.status, 'blocked')
  assert.equal('payload' in oversized, false)
})

test('combined ExtractWorker sends redacted system, user and retry callback payload to its provider port', async () => {
  let provided
  let callbackAccepted
  let pending = true
  const queue = {
    touch() {}, hasPending: () => pending, progress() {},
    pull: () => ({ items: [{ itemId: 'synthetic-item', chatId: 'synthetic-chat', topics: true, user: JSON.stringify({ messages: [{ text: 'api_key=synthetic-combined-user-canary' }] }), onAdditionalUserPayload: (payload) => { assert.equal(payload.includes('synthetic-combined-repair-canary'), false); return true } }], retryAfterMs: null }),
    commit: () => { pending = false; return { results: [{ status: 'applied' }] } }, release() {}
  }
  const port = {
    ready: async () => true, blockedFor: () => 0,
    complete: async (req) => {
      provided = req
      callbackAccepted = req.onAdditionalUserPayload(JSON.stringify({ repair: 'password=synthetic-combined-repair-canary' }))
      return { value: {}, text: '{}', model: 'mock' }
    }
  }
  const worker = createExtractWorker({ queue, port, system: () => 'API-key: synthetic-combined-system-canary; Project Orion', config: { pollIntervalMs: 60_000 } })
  worker.start()
  await worker.idle()
  worker.stop()
  assert.equal(provided.system.includes('synthetic-combined-system-canary'), false)
  assert.equal(provided.user.includes('synthetic-combined-user-canary'), false)
  assert.match(provided.system, /Project Orion/)
  assert.equal(callbackAccepted, true)
})

test('combined blocked preparation never calls provider or logs the raw input', async () => {
  const raw = 'synthetic-blocked-input-canary'.repeat(70_000)
  let called = 0
  let logged = ''
  let pending = true
  const queue = {
    touch() {}, hasPending: () => pending, progress() {},
    pull: () => ({ items: [{ itemId: 'blocked-item', chatId: 'synthetic-chat', user: raw }], retryAfterMs: null }),
    commit: ({ results }) => { pending = false; assert.equal(results[0].failCode, 'payload_unavailable'); return { results: [{ status: 'failed' }] } }, release() {}
  }
  const worker = createExtractWorker({ queue, port: { ready: async () => true, blockedFor: () => 0, complete: async () => { called += 1; return { value: {}, text: '{}', model: null } } }, system: () => 'safe system', log: (_event, detail) => { logged += JSON.stringify(detail ?? {}) }, config: { pollIntervalMs: 60_000 } })
  worker.start()
  await worker.idle()
  worker.stop()
  assert.equal(called, 0)
  assert.equal(logged.includes('synthetic-blocked-input-canary'), false)
})
