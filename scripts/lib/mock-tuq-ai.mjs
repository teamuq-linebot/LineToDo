// A mock `context.host.ai` (the BACKEND side of TeamUQ's ai:chat) that reproduces Core 1.7.15's behaviour. Read-only references (teamuq-electron @ v1.7.15, bf4801ecc):
//   packages/plugin-sdk/src/aiChatContracts.ts                           limits, strict request schemas (complete: fresh | existing Session), error / failure codes, event kinds (incl. contentSaved)
//   apps/plugin-host/src/external/hostServices.ts                        the backend client: input validation (plugin_host_request_invalid), `complete` = one call
//                                                                        (310 s host timeout), failures are Errors with `.code` = the envelope's error, events reach only OPEN sessions' listeners
//   packages/platform/plugin-runtime/src/main/aiChat/aiChatOneShot.ts    complete: reserveSessionSlot (session_limit | busy), checkTurn (rate_limited | quota_exhausted),
//                                                                        provider_not_ready / model_unavailable, the new Session is closed on every result path
//   packages/platform/plugin-runtime/src/main/externalBackend/backendHostServices.ts   backend calls always count as visible (no view_not_visible), same rate-limit window as a view
//
// The numeric limits and code lists come from scripts/plugin/fixtures/ai-chat-contract-1.8.10.json (generated from the contract file by
// gen-ai-contract-fixture.mjs); test-ai-orchestrator asserts this mock and the backend AI port (src/plugin/backend/hostAi.ts) agree with it.
//
// Not reproduced (and not needed by the port): images, attachSession / resume, the hidden-input credit exception (backend calls are never hidden).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMockTuqAiFor } from './mock-tuq-ai-core.mjs'

export const CONTRACT = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'fixtures', 'ai-chat-contract-1.8.10.json'), 'utf8'))

/** See mock-tuq-ai-core.mjs for the options. */
export const createMockTuqAi = (options = {}) => createMockTuqAiFor(CONTRACT, options)
