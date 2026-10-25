// A plugin backend that is KILLED (SIGKILL, no dispose, no shutdown) while an AI call is outstanding — what Core's crash restart (design D:445) and its 24 hour re-fork leave behind.
// Run by scripts/plugin/test-residency.mjs with the same flags as the other tests:
//   node --experimental-strip-types --experimental-loader=./scripts/ts-test-loader.mjs scripts/plugin/fixtures/residency-crash-child.mjs <dataDir>
// It ingests two LINE messages, runs one pipeline cycle so the backend's worker leases the chat and calls context.host.ai.complete — which never answers — and then prints
//   READY <json>
// and waits for the kill. Nothing is written by this file except through the backend itself (dataDir).
import { createPluginBackend } from '../../../src/plugin/backend/assemble.ts'
import { backendMethodFor } from '../../../src/shared/pluginWire.ts'
import { createMockTuqAi } from '../../lib/mock-tuq-ai.mjs'
import { RESIDENT, createResidencyStandin } from '../../lib/residency-standin.mjs'

const dataDir = process.argv[2]
const listeners = new Set()
let running = false
const line = {
  start() { running = true },
  stop() { running = false },
  status: () => ({ state: running ? 'running' : 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 }),
  onMessage(cb) { listeners.add(cb); return () => listeners.delete(cb) },
  onStatus() { return () => {} },
  getMessagesSince: async () => [],
}
const raw = (i, text) => { const t = 1_700_000_000_000 + i * 1000; return { msgId: `m${i}`, chat: 'Alice', chatId: 'u-alice', isGroup: false, ts: t, time: new Date(t).toISOString(), direction: 'in', sender: 'Alice', text, contentType: 0 } }

const ai = createMockTuqAi({ reply: () => new Promise(() => undefined) })
const residency = createResidencyStandin({ mode: 'present', initial: RESIDENT })
const backend = await createPluginBackend({
  pluginId: 'tuqdev.line-todo', version: '4.0.0', dataDir, line, hostAi: ai.ai, residency: residency.api,
  ai: { config: { busyRetryMs: 10, providerRetryMs: 150, optionsTtlMs: 20 }, worker: { pollIntervalMs: 60, unavailableRetryMs: 40 } },
})
const call = async (path, ...args) => backend.call(backendMethodFor(path), { path, args })
for (const listener of listeners) {
  listener(raw(1, '請幫我寄報價單給客戶'))
  listener(raw(2, '下午三點開會，記得帶合約'))
}
await call('pipeline.runOnce')
const waitUntil = async (probe) => { for (let i = 0; i < 500; i += 1) { if (await probe()) return true; await new Promise((resolve) => setTimeout(resolve, 20)) } return false }
const leased = await waitUntil(async () => ai.stats.completes >= 1)
const messages = (await call('db.messages.list', { chatId: 'u-alice' })).value
const stats = (await call('extract.stats')).value
process.stdout.write(`READY ${JSON.stringify({ pid: process.pid, leased, messages: messages.length, processed: messages.filter((m) => m.processed).length, extract: stats })}\n`)
setInterval(() => undefined, 1000)
