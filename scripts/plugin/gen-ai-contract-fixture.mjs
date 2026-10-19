// Regenerates scripts/plugin/fixtures/ai-chat-contract-b8b96cb3.json from the READ-ONLY TeamUQ 1.6.8 source (git show; nothing in TeamUQ is touched):
//   packages/plugin-sdk/src/aiChatContracts.ts @ b8b96cb3  (limits, error codes, failure codes, efforts, event kinds)
// The committed JSON is what test-ai-orchestrator's mock `window.tuqPlugin.ai` and the orchestrator's AI_CHAT_REFERENCE are checked against (drift guard),
// so the gate never needs the TeamUQ checkout; run this script only to refresh the fixture.
//
//   node scripts/plugin/gen-ai-contract-fixture.mjs [path-to-teamuq-electron]
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPO = process.argv[2] ?? 'C:/teamuq/teamuq-electron'
const COMMIT = 'b8b96cb3'
const FILE = 'packages/plugin-sdk/src/aiChatContracts.ts'
const source = execFileSync('git', ['-C', REPO, 'show', `${COMMIT}:${FILE}`], { encoding: 'utf8', maxBuffer: 1 << 24 })

const between = (text, start, end) => {
  const a = text.indexOf(start)
  if (a < 0) throw new Error(`missing ${start}`)
  const b = text.indexOf(end, a + start.length)
  if (b < 0) throw new Error(`missing ${end}`)
  return text.slice(a + start.length, b)
}
const evaluate = (code) => new Function(`return (${code})`)()

const limits = evaluate(`{${between(source, 'export const AI_CHAT_LIMITS = Object.freeze({', '})')}}`)
const efforts = evaluate(`[${between(source, 'export const AI_CHAT_EFFORTS = Object.freeze([', '] as const)')}]`)
const errorCodes = evaluate(`[${between(source, 'export const AI_CHAT_ERROR_CODES = Object.freeze([', '] as const)')}]`)
const failureCodes = evaluate(`[${between(between(source, 'export const AiChatFailureSchema', 'AiChatTurnEventSchema'), "code: z.enum([", '])')}]`)
const eventKinds = [...between(source, 'export const AiChatFailureSchema', 'export const AiChatAttachedSchema').matchAll(/kind: z\.literal\('([A-Za-z]+)'\)/g)].map((m) => m[1])
const providerStates = evaluate(`[${between(source, "state: z.enum([", '])')}]`)

const out = { source: { repo: 'teamuq-electron', commit: COMMIT, file: FILE }, limits, efforts, errorCodes, failureCodes, eventKinds, providerStates }
const target = join(ROOT, 'scripts', 'plugin', 'fixtures', 'ai-chat-contract-b8b96cb3.json')
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`)
console.log(JSON.stringify(out))
