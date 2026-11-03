// Phase 3 — createPluginLineTodoApi() (src/renderer/platform/pluginApi.ts) against a mock `window.tuqPlugin`.
//
// The mock host is faithful to the 1.6.8 view bridge (pluginViewBridge.ts:88-95 + backendInvokeContracts.ts): `backend.call(method, params)` validates
// that params are pure JSON (no undefined, finite numbers, arrays <= 4096), request and response are each <= 64 KiB, and rejects with Error(<code>) on host
// failures. Behind it sits the REAL backend (createPluginBackend on a fake LINE port, node:sqlite test adapter) or the real Dispatcher with a fake api,
// so the adapter <-> dispatcher wire format (envelopes, chunks, jobs, event long-poll, unsupported paths) is exercised end to end.
//
// Proves: adapter returns correct values; on* subscriptions receive long-poll events; polling stops after unsubscribe and after dispose;
// unsupported APIs answer an explicit `unsupported_in_plugin` (and the capability flags that hide them in the UI line up with them); media goes through assets.url.
import assert from 'node:assert/strict'
import { createCipheriv, createHmac, hkdfSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createNodeLineFsPort } from '../../src/main/line/engine/nodeLineFsPort.ts'
import { createPluginBackend } from '../../src/plugin/backend/assemble.ts'
import { createIdentityE2EFixture } from './identity-e2e-fixture.mjs'
import { Dispatcher } from '../../src/plugin/backend/dispatcher.ts'
import { EventHub } from '../../src/plugin/backend/eventHub.ts'
import { CAPABILITY_API_PATHS, PLUGIN_CAPABILITIES, STANDALONE_CAPABILITIES } from '../../src/renderer/platform/capabilities.ts'
import {
  PluginApiError, PluginBackendError, PluginUnsupportedError, createPluginLineTodoApi
} from '../../src/renderer/platform/pluginApi.ts'
import { createMockTuqAi } from '../lib/mock-tuq-ai.mjs'
import { CallCancelledError, Limiter, toWire } from '../../src/renderer/platform/pluginTransport.ts'
import { RESOURCES } from './lib/manifest.mjs'
import { backendMethodFor } from '../../src/shared/pluginWire.ts'

// ───────────── the mock host ─────────────

const LIMIT = 64 * 1024
const isJson = (value, depth = 0) => {
  if (depth > 40) return false
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 4096 && value.every((v) => isJson(v, depth + 1))
  if (typeof value === 'object') return Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every((v) => isJson(v, depth + 1))
  return false // undefined, function, bigint, symbol
}
const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength

/**
 * `backend`: anything with `call(method, params)`; swap it with `.target` to simulate a restart.
 *
 * Busy semantics are the real 1.6.8 ones (review F1): the backend controller refuses a call when the calls already being handled reach the manifest's
 * `resources.maxSessions` (backendController.ts:395, `BackendError('plugin_backend_busy')`); `maxSessions` defaults to the value in the plugin manifest
 * (scripts/plugin/lib/manifest.mjs), not to a made-up number. `busyCode` is what the VIEW sees: the invoke gate turns the controller's busy error into
 * `plugin_backend_unavailable` (backendInvokeGate.ts:156-160), so tests run both spellings. `state.busyRejections` counts the refusals.
 */
function makeHost({ target, assetsOrigin = 'tuqplugin://tuqdev.line-todo', maxSessions = RESOURCES.maxSessions, busyCode = 'plugin_backend_busy' }) {
  const state = {
    target, calls: [], inFlight: 0, maxInFlight: 0, busyRejections: 0, maxSessions, failNext: null, hold: null,
    // 'events.pull' can be held to simulate a slow or stalled backend
  }
  const host = {
    backend: {
      async call(method, params) {
        // the view bridge's schema: method regex, JSON params, size limit
        if (!/^[A-Za-z0-9._@-]{1,64}$/.test(method)) throw new Error('backend_invoke_invalid')
        if (!isJson(params)) throw new Error('backend_invoke_invalid')
        if (bytes(params) > LIMIT) throw new Error('backend_invoke_too_large')
        const record = { method, path: params.path, args: params.args }
        state.calls.push(record)
        if (state.inFlight >= state.maxSessions) { state.busyRejections += 1; throw new Error(busyCode) }
        state.inFlight += 1
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
        try {
          if (state.failNext) { const error = state.failNext; state.failNext = null; throw new Error(error) }
          if (state.hold && params.path === 'events.pull') await state.hold.promise
          const result = await state.target.call(method, JSON.parse(JSON.stringify(params)))
          const wire = JSON.parse(JSON.stringify(result ?? null))
          if (bytes(wire) > LIMIT) throw new Error('backend_invoke_too_large')
          return wire
        } finally { state.inFlight -= 1 }
      }
    },
    assets: { url: (path) => `${assetsOrigin}/data/${String(path).split('/').map(encodeURIComponent).join('/')}` }
  }
  return { host, state, count: (path) => state.calls.filter((c) => c.path === path).length }
}

const FAST_EVENTS = { waitMs: 150, idleStopMs: 30, backoffBaseMs: 10, backoffMaxMs: 40, minLoopMs: 5 }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(predicate, { timeout = 3000, step = 10, message = 'condition' } = {}) {
  const t0 = Date.now()
  while (!predicate()) {
    if (Date.now() - t0 > timeout) assert.fail(`timed out waiting for ${message}`)
    await sleep(step)
  }
}

function raw(i, { chatId = 'u-alice', chat = 'Alice', text, ts } = {}) {
  const t = ts ?? 1_700_000_000_000 + i * 1000
  return { msgId: `m${i}`, chat, chatId, isGroup: false, ts: t, time: new Date(t).toISOString(), direction: 'in', sender: chat, text: text ?? `請幫我處理第 ${i} 件事情，明天要交`, contentType: 0 }
}

function fakeLine() {
  const messageListeners = new Set()
  const statusListeners = new Set()
  let running = false
  const port = {
    start() { running = true }, stop() { running = false },
    status: () => ({ state: running ? 'running' : 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 }),
    onMessage(cb) { messageListeners.add(cb); return () => messageListeners.delete(cb) },
    onStatus(cb) { statusListeners.add(cb); return () => statusListeners.delete(cb) },
    getMessagesSince: async () => []
  }
  return { port, emit: (m) => messageListeners.forEach((cb) => cb(m)) }
}

const okResult = (msgIds, title = '回覆報價單') => ({
  importance: 'action',
  newTodos: [{ draftRef:`draft_${String(msgIds[0]??'none').replace(/[^a-z0-9_-]/giu,'_')}`, bucket: 'todo', title, detail: null, priority: 2, dueAt: null, confidence: 0.9, sourceMsgIds: msgIds.slice(0, 1) }],
  identityDecisions: msgIds.length ? [{draftRef:`draft_${String(msgIds[0]).replace(/[^a-z0-9_-]/giu,'_')}`,outcome:'new',candidateType:null,candidateId:null,relationKind:null,reasonCode:'insufficient_evidence',confidenceBand:'high',evidenceMsgIds:msgIds.slice(0,1)}] : [],
  resolved: [], updates: []
})

const fenced = (value) => '```json\n' + JSON.stringify(value) + '\n```'
/** The model: an extraction prompt gets one todo citing the first message of the payload; a draft prompt gets a draft. */
const defaultReply = (ctx) => (ctx.system.includes('草擬') ? '好的，我明天回覆您' : fenced(okResult([JSON.parse(ctx.user).newMessages[0].msgId])))
const asyncUntil = async (probe, { timeout = 4000, step = 10, message = 'condition' } = {}) => {
  const t0 = Date.now()
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() - t0 > timeout) assert.fail(`timed out waiting for ${message}`)
    await sleep(step)
  }
}

/** Real backend (with a mock `context.host.ai` — the backend answers its own extraction since 0.2.0) + adapter. */
async function withBackend(options, body) {
  const dataDir = mkdtempSync(join(tmpdir(), 'plugin-adapter-'))
  const line = fakeLine()
  const ai = createMockTuqAi({ reply: options.reply ?? defaultReply })
  options.setup?.(ai)
  const backend = await createPluginBackend({
    pluginId: 'tuqdev.line-todo', version: '7.7.7', dataDir, line: line.port, extract: { retryBaseMs: 20 },
    hostAi: ai.ai, ai: { config: { optionsTtlMs: 20, providerRetryMs: 100 }, worker: { pollIntervalMs: 40, unavailableRetryMs: 30 } }, ...options.backend
  })
  const mock = makeHost({ target: backend, ...options.host })
  const api = createPluginLineTodoApi({ host: mock.host, events: FAST_EVENTS, ...options.api })
  try { await body({ api, backend, line, mock, dataDir, ai }) } finally {
    api.dispose()
    await backend.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
}

// ───────────── adapter returns correct values ─────────────

test('adapter: request/response methods reach the backend and return its values (messages, chats, todos, settings, pipeline, ping)', async () => {
  await withBackend({}, async ({ api, line, mock }) => {
    assert.equal((await api.ping()).version, '7.7.7')
    assert.equal((await api.line.status()).state, 'running')
    line.emit(raw(1, { text: '請幫我寄報價單給客戶' }))
    line.emit(raw(2, { text: '下午三點開會，記得帶合約' }))
    assert.equal((await api.messages.recent()).length, 2)

    const chats = await api.db.chats.list()
    assert.deepEqual(chats.map((c) => c.chatId), ['u-alice'])
    assert.equal((await api.db.chats.get('u-alice')).name, 'Alice')
    assert.equal(await api.db.chats.get('nobody'), null)
    const messages = await api.db.messages.list({ chatId: 'u-alice' })
    assert.equal(messages.length, 2)
    assert.equal(await api.db.messages.count('u-alice'), 2)
    // trailing undefined arguments are dropped, not turned into null (recentByChat(chatId, limit = 30))
    assert.equal((await api.db.messages.recentByChat('u-alice')).length, 2)
    assert.equal((await api.db.messages.recentByChat('u-alice', 1)).length, 1)
    assert.deepEqual(await api.db.todos.list(), [])

    // the AI extraction loop: the pipeline supplies, the backend's own worker answers through host.ai.complete (the view only reads)
    const status = await api.pipeline.runOnce()
    assert.equal(status.todosCreated, 0)
    const todos = await asyncUntil(async () => { const list = await api.db.todos.list(); return list.length === 1 ? list : null }, { message: 'the worker to create the todo' })
    assert.equal((await api.plugin.extract.stats()).pending, 0)
    assert.equal((await api.plugin.aiStatus()).counters.extracted, 1)
    assert.equal(mock.count('extract.pull') + mock.count('extract.commit') + mock.count('extract.system'), 0, 'no extraction RPC from the view')
    assert.equal(todos[0].title, '回覆報價單')
    assert.equal((await api.db.todos.updateStatus(todos[0].id, 'done')).status, 'done')
    assert.equal((await api.db.todos.moveColumn(todos[0].id, 'todo')).status, 'pending')
    assert.equal((await api.plugin.info()).plugin, 'tuqdev.line-todo')

    // settings round trip; the plugin build never exposes a key
    const settings = await api.settings.get()
    assert.equal(settings.hasApiKey, true)
    assert.equal(settings.safeStorageAvailable, false)
    assert.equal((await api.settings.update({ pollIntervalSec: 45 })).pollIntervalSec, 45)
    assert.equal(await api.settings.hasSafeStorageKey(), false)
    assert.equal((await api.pipeline.status()).running, true)
    assert.equal(api.driver, undefined, 'no driver_post in the plugin build')
  })
})

test('adapter: identity list/inspect/retry/resolve and both relation decisions use the existing allow-listed method groups',async()=>{
  const calls=[]
  const target={async call(method,request){
    calls.push({method,...request})
    const values={
      'db.todos.identity.listPending':{items:[]},
      'db.todos.identity.inspect':null,
      'db.todos.identity.retry':{ok:false,reason:'provider_unavailable'},
      'db.todos.identity.resolve':{ok:false,reason:'revision_conflict'},
      'db.todos.identity.todoTopicRelations':[],
      'db.todos.identity.resolveTodoTopicRelation':{ok:true,status:'rejected',revision:2},
      'groupTopics.linkProposals':[],
      'groupTopics.resolveLinkProposal':{ok:true,status:'rejected',linkRevision:2}
    }
    return {ok:true,value:values[request.path]}
  }}
  const mock=makeHost({target})
  const api=createPluginLineTodoApi({host:mock.host,events:{enabled:false}})
  try{
    assert.deepEqual(await api.db.todos.identity.listPending({entityType:'todo',chatId:'synthetic-chat'}),{items:[]})
    assert.equal(await api.db.todos.identity.inspect({entityType:'todo',decisionId:'decision-1'}),null)
    assert.equal((await api.db.todos.identity.retry({entityType:'todo',decisionId:'decision-1',expectedDecisionRevision:1})).reason,'provider_unavailable')
    assert.equal((await api.db.todos.identity.resolve({entityType:'todo',decisionId:'decision-1',expectedDecisionRevision:1,expectedCandidateRevisions:[],outcome:'new'})).reason,'revision_conflict')
    assert.deepEqual(await api.db.todos.identity.todoTopicRelations('synthetic-chat'),[])
    assert.equal((await api.db.todos.identity.resolveTodoTopicRelation({relationId:'relation-1',expectedRevision:1,expectedTodoRevision:1,expectedTopicRevision:1,choice:'reject'})).status,'rejected')
    assert.deepEqual(await api.groupTopics.linkProposals('synthetic-chat'),[])
    assert.equal((await api.groupTopics.resolveLinkProposal({linkId:'link-1',expectedLinkRevision:1,leftTopicRevision:1,rightTopicRevision:1,choice:'reject'})).status,'rejected')
    assert.ok(calls.filter((call)=>call.path.startsWith('db.todos.identity.')).every((call)=>call.method==='db.todos'))
    assert.ok(calls.filter((call)=>call.path.startsWith('groupTopics.')).every((call)=>call.method==='groupTopics'))
  }finally{api.dispose()}
})

test('A15 adapter: hostAi.chatPrompts and prompts.saveName map to the settings method group with the exact paths and args; the read paths are replay-safe, the write paths are not',async()=>{
  const calls=[]
  const summary={chatId:'u-alice',hasPrompt:true,myName:'阿華',revision:'r1'}
  const target={async call(method,request){
    calls.push({method,path:request.path,args:request.args})
    const values={
      'settings.prompt.saveName':{myName:'王小明',nameRevision:'n2'},
      'settings.chatPrompt.get':{chatId:'u-alice',revision:'r0'},
      'settings.chatPrompt.save':{chatId:'u-alice',revision:'r1'},
      'settings.chatPrompt.reset':{chatId:'u-alice',revision:'r0'},
      'settings.chatPrompt.list':{items:[summary]}
    }
    return {ok:true,value:values[request.path]}
  }}
  const mock=makeHost({target})
  const api=createPluginLineTodoApi({host:mock.host,events:{enabled:false}})
  try{
    assert.equal((await api.hostAi.prompts.saveName('王小明','n1')).nameRevision,'n2')
    assert.equal((await api.hostAi.chatPrompts.get('u-alice')).revision,'r0')
    assert.equal((await api.hostAi.chatPrompts.save('u-alice',{prompt:'P',myName:null},'r0')).revision,'r1')
    assert.equal((await api.hostAi.chatPrompts.reset('u-alice','r1')).revision,'r0')
    assert.deepEqual(await api.hostAi.chatPrompts.list(),[summary],'list unwraps { items }')
    assert.deepEqual(calls,[
      {method:'settings',path:'settings.prompt.saveName',args:[{myName:'王小明',expectedNameRevision:'n1'}]},
      {method:'settings',path:'settings.chatPrompt.get',args:[{chatId:'u-alice'}]},
      {method:'settings',path:'settings.chatPrompt.save',args:[{chatId:'u-alice',prompt:'P',myName:null,expectedRevision:'r0'}]},
      {method:'settings',path:'settings.chatPrompt.reset',args:[{chatId:'u-alice',expectedRevision:'r1'}]},
      {method:'settings',path:'settings.chatPrompt.list',args:[]}
    ])
    const transport=await import('../../src/renderer/platform/pluginTransport.ts')
    for(const path of ['settings.chatPrompt.get','settings.chatPrompt.list'])assert.equal(transport.isReplaySafePath(path),true,path)
    for(const path of ['settings.chatPrompt.save','settings.chatPrompt.reset','settings.prompt.saveName'])assert.equal(transport.isReplaySafePath(path),false,path)
  }finally{api.dispose()}
})

test('adapter/runtime: a real automatic defer is inspectable, explicit retry re-evaluates with fake Host AI, and user resolve creates the canonical Todo',async()=>{
  const fixture=await createIdentityE2EFixture()
  const api=fixture.api
  try{
    fixture.emitSyntheticMessage('請先確認合成群組的會議時間')
    const seeded=await fixture.seedDeferredItem()
    const listed=await asyncUntil(async()=>{const page=await api.db.todos.identity.listPending({entityType:'todo',chatId:'synthetic-group'});return page.items.length===1?page:null},{message:'deferred identity inbox item'})
    assert.equal(listed.items[0].decisionId,seeded.decisionId)
    assert.equal(listed.items[0].state,'open')
    const inspected=await api.db.todos.identity.inspect({entityType:'todo',decisionId:listed.items[0].decisionId})
    assert.equal(inspected.sourceEvidence[0].text,'請先確認合成群組的會議時間')
    assert.deepEqual(inspected.item.sourceMsgIds,[listed.items[0].sourceMsgIds[0]])
    const reevaluated=await api.db.todos.identity.retry({entityType:'todo',decisionId:listed.items[0].decisionId,expectedDecisionRevision:listed.items[0].decisionRevision})
    assert.equal(reevaluated.ok,true,JSON.stringify(reevaluated))
    assert.equal(reevaluated.item.suggestedDecision.reasonCode,'fresh_occurrence')
    assert.equal(reevaluated.item.state,'open','the AI suggestion is reviewable and is not silently committed')
    const resolved=await api.db.todos.identity.resolve({entityType:'todo',decisionId:reevaluated.item.decisionId,expectedDecisionRevision:reevaluated.item.decisionRevision,expectedCandidateRevisions:reevaluated.item.candidateRevisions,outcome:'new'})
    assert.equal(resolved.ok,true,JSON.stringify(resolved))
    assert.equal((await api.db.todos.list()).length,1)
    assert.equal((await api.db.todos.identity.listPending({entityType:'todo',chatId:'synthetic-group'})).items.length,0)
    assert.ok(fixture.calls.filter((call)=>call.path==='db.todos.identity.listPending').length>=2)
    assert.equal(fixture.calls.filter((call)=>call.path==='db.todos.identity.inspect').length,1)
    assert.equal(fixture.calls.filter((call)=>call.path==='db.todos.identity.retry').length,1)
    assert.equal(fixture.calls.filter((call)=>call.path==='db.todos.identity.resolve').length,1)
  }finally{await fixture.dispose()}
})

test('adapter/runtime: the same synthetic renderer fixture creates and rejects a cross-chat Topic proposal without deleting either Topic',async()=>{
  const fixture=await createIdentityE2EFixture()
  try{
    const proposals=await fixture.seedCrossChatTopicLinks()
    assert.equal(proposals.length,1)
    const proposal=proposals[0]
    assert.equal(proposal.permissionAllowed,true)
    assert.notEqual(proposal.leftChatId,proposal.rightChatId)
    const beforeLeft=await fixture.api.groupTopics.list(proposal.leftChatId)
    const beforeRight=await fixture.api.groupTopics.list(proposal.rightChatId)
    assert.equal(beforeLeft.topics.length,1)
    assert.equal(beforeRight.topics.length,1)
    const rejected=await fixture.api.groupTopics.resolveLinkProposal({linkId:proposal.linkId,expectedLinkRevision:proposal.linkRevision,leftTopicRevision:proposal.leftRevision,rightTopicRevision:proposal.rightRevision,choice:'reject'})
    assert.equal(rejected.ok,true,JSON.stringify(rejected))
    assert.equal(rejected.status,'rejected')
    assert.equal((await fixture.api.groupTopics.list(proposal.leftChatId)).topics.length,1)
    assert.equal((await fixture.api.groupTopics.list(proposal.rightChatId)).topics.length,1)
  }finally{await fixture.dispose()}
})

test('adapter/runtime: a retried Todo may propose an independent Topic link without source-id intersection, and rejecting the link keeps both entities',async()=>{
  const fixture=await createIdentityE2EFixture({retryOutcome:'link'})
  const api=fixture.api
  try{
    await fixture.seedCrossChatTopicLinks()
    fixture.emitSyntheticMessage('請預約合成 meeting room reservation',{msgId:'fixture-todo-link',chatId:'synthetic-group',chat:'合成群組'})
    const deferred=await fixture.seedDeferredItem()
    const retry=await api.db.todos.identity.retry({entityType:'todo',decisionId:deferred.decisionId,expectedDecisionRevision:deferred.decisionRevision})
    assert.equal(retry.ok,true,JSON.stringify(retry))
    if(!retry.ok)throw new Error(retry.reason)
    const target=retry.item.suggestedDecision
    assert.equal(target.outcome,'link')
    assert.equal(target.candidateType,'topic')
    const resolved=await api.db.todos.identity.resolve({entityType:'todo',decisionId:retry.item.decisionId,expectedDecisionRevision:retry.item.decisionRevision,expectedCandidateRevisions:retry.item.candidateRevisions,outcome:'link',candidateType:'topic',candidateId:target.candidateId,relationKind:'same_topic'})
    assert.equal(resolved.ok,true,JSON.stringify(resolved))
    const relations=await api.db.todos.identity.todoTopicRelations('synthetic-group')
    const relation=relations.find((item)=>item.todoId===resolved.canonicalId&&item.topicId===target.candidateId)
    assert.ok(relation,'the product relation list exposes the link even when Todo source ids do not intersect the Topic evidence')
    const rejected=await api.db.todos.identity.resolveTodoTopicRelation({relationId:relation.relationId,expectedRevision:relation.revision,expectedTodoRevision:relation.todoRevision,expectedTopicRevision:relation.topicRevision,choice:'reject'})
    assert.equal(rejected.ok,true,JSON.stringify(rejected))
    assert.equal(rejected.status,'rejected')
    assert.ok(await api.db.todos.get(resolved.canonicalId),'rejecting the relation keeps the Todo')
    assert.equal((await api.groupTopics.list('synthetic-group')).topics.length,1,'rejecting the relation keeps the Topic')
  }finally{await fixture.dispose()}
})

test('adapter: failures are typed — in-band backend errors, host errors, malformed envelopes, bad arguments', async () => {
  await withBackend({}, async ({ api, mock }) => {
    await assert.rejects(api.plugin.invoke('no.such.path'), (e) => e instanceof PluginApiError && e.code === 'path_unknown' && e.path === 'no.such.path')
    await assert.rejects(api.plugin.invoke('__proto__'), (e) => e instanceof PluginApiError && e.code === 'path_unknown')
    mock.state.failNext = 'plugin_backend_crashed'
    await assert.rejects(api.db.chats.list(), (e) => e instanceof PluginBackendError && e.code === 'plugin_backend_crashed')
    mock.state.failNext = 'backend_invoke_timeout'
    await assert.rejects(api.ping(), (e) => e instanceof PluginBackendError && /timeout/.test(e.message))
    assert.equal((await api.ping()).ok, true, 'the adapter keeps working after a host failure')
    // arguments the host would refuse never leave the view
    const before = mock.state.calls.length
    await assert.rejects(api.plugin.invoke('ping', [10n]), (e) => e.code === 'invalid_args')
    await assert.rejects(api.plugin.invoke('ping', [{ nested: { n: 5n } }]), (e) => e.code === 'invalid_args')
    await assert.rejects(api.plugin.invoke('ping', ['x'.repeat(70_000)]), (e) => e.code === 'request_too_large')
    await assert.rejects(api.plugin.invoke('ping', [1, 2, 3, 4, 5, 6, 7, 8, 9]), (e) => e.code === 'invalid_args')
    assert.equal(mock.state.calls.length, before, 'none of them reached the host')
  })
  // a host that answers with something that is not an envelope
  for (const bad of [null, 'text', 42, [], { value: 1 }, { ok: 'yes' }]) {
    const api = createPluginLineTodoApi({ host: { backend: { call: async () => bad }, assets: { url: String } }, events: FAST_EVENTS })
    await assert.rejects(api.ping(), (e) => e instanceof PluginApiError && e.code === 'bad_response', JSON.stringify(bad))
    api.dispose()
  }
  assert.throws(() => createPluginLineTodoApi({ host: {} }), TypeError)
})

test('adapter: wire format — trailing undefined dropped, JSON round trip, size and count limits, concurrency limiter', async () => {
  assert.deepEqual(toWire('a.b', [1, undefined, undefined]), { path: 'a.b', args: [1] })
  assert.deepEqual(toWire('a.b', [{ x: 1, y: undefined }, undefined]), { path: 'a.b', args: [{ x: 1 }] })
  assert.deepEqual(toWire('a.b', [undefined, 2]), { path: 'a.b', args: [null, 2] })
  const limiter = new Limiter(3)
  let active = 0
  let peak = 0
  await Promise.all(Array.from({ length: 12 }, () => limiter.run(async () => { active += 1; peak = Math.max(peak, active); await sleep(5); active -= 1 })))
  assert.equal(peak, 3)
  assert.deepEqual(limiter.stats(), { active: 0, waiting: 0 })
  // many simultaneous calls from the UI never exceed the cap (an explicit maxConcurrentCalls is honoured)
  await withBackend({ api: { maxConcurrentCalls: 2 } }, async ({ api, mock }) => {
    await Promise.all(Array.from({ length: 30 }, () => api.db.chats.list()))
    assert.ok(mock.state.maxInFlight <= 2, `max in flight ${mock.state.maxInFlight}`)
  })
})

// ───────────── review F1: the UI never exceeds the manifest's maxSessions; a busy answer is retried with backoff ─────────────

/** What a board view does when it opens (status, settings, lists, AI status) plus 10 images — all at once, with the event long poll running. */
async function loadBoardLikeBurst(api) {
  const media = Array.from({ length: 10 }, (_, i) => api.media.assetUrl(`i:m${i}`))
  return Promise.all([
    api.pipeline.status(), api.settings.get(), api.db.todos.list(), api.db.chats.list(), api.line.status(), api.pipeline.loadStats(),
    api.plugin.extract.stats(), api.plugin.aiStatus({ refresh: true }), api.plugin.reviewStatus(), api.plugin.info(),
    ...media
  ])
}

for (const busyCode of ['plugin_backend_busy', 'plugin_backend_unavailable']) {
  test(`F1 (${busyCode}): the fake host judges busy by the manifest maxSessions (${RESOURCES.maxSessions}); a board-like burst with the long poll running never exceeds it and is never refused`, async () => {
    assert.equal(RESOURCES.maxSessions, 4, 'the manifest says 4 (1.6.8 Core limit)')
    await withBackend({ host: { busyCode } }, async ({ api, line, mock }) => {
      assert.equal(mock.state.maxSessions, RESOURCES.maxSessions, 'the fake host takes its limit from the manifest, not from a constant of its own')
      const events = []
      const off = api.line.onMessage((m) => events.push(m.msgId)) // starts the event long poll (it holds one slot of the view's budget)
      await until(() => mock.count('events.pull') >= 1, { message: 'the long poll to start' })
      for (let round = 0; round < 3; round += 1) {
        await loadBoardLikeBurst(api)
        line.emit(raw(round + 1))
      }
      await until(() => events.length === 3, { message: 'events still arrive through the long poll during the bursts' })
      assert.equal(mock.state.busyRejections, 0, 'the host never had to refuse a call')
      assert.ok(mock.state.maxInFlight <= RESOURCES.maxSessions, `max in flight ${mock.state.maxInFlight} <= maxSessions ${RESOURCES.maxSessions}`)
      const transport = api.plugin.transportStats()
      assert.ok(transport.maxActive <= 3, `the board's own budget is 3 (long poll + 2); saw ${transport.maxActive}`)
      assert.equal(transport.busyRetries, 0)
      assert.ok(mock.state.maxInFlight >= 2, 'the burst really ran concurrently (the test is not vacuous)')
      off()
    })
  })
}

test('F1: board view (budget 3, long poll) and settings view (budget 1, no poll) open at the same time against one host: the sum stays within maxSessions', async () => {
  await withBackend({}, async ({ api: board, line, mock }) => {
    const settings = createPluginLineTodoApi({ host: mock.host, maxConcurrentCalls: 1, events: { ...FAST_EVENTS, enabled: false } })
    try {
      const got = []
      board.line.onMessage((m) => got.push(m.msgId))
      settings.pipeline.onStatus(() => got.push('never')) // the settings view subscribes too, but opens no poll
      await until(() => mock.count('events.pull') >= 1, { message: 'the board long poll' })
      for (let round = 0; round < 4; round += 1) {
        await Promise.all([loadBoardLikeBurst(board), Promise.all(Array.from({ length: 8 }, () => settings.settings.get()))])
      }
      line.emit(raw(1))
      await until(() => got.includes('i:m1'), { message: 'the board still gets its events' })
      assert.equal(mock.count('events.open'), 1, 'only the board opened an event session')
      assert.equal(mock.state.busyRejections, 0)
      assert.ok(mock.state.maxInFlight <= RESOURCES.maxSessions, `both views together: max in flight ${mock.state.maxInFlight}`)
      assert.ok(settings.plugin.transportStats().maxActive <= 1)
      assert.deepEqual(got.filter((x) => x === 'never'), [])
    } finally { settings.dispose() }
  })
})

test('F1: the fake host is not vacuous — the old shape (6 concurrent calls, no retry) is refused by a host that applies maxSessions', async () => {
  await withBackend({ api: { maxConcurrentCalls: 6, busyRetry: { attempts: 0 } } }, async ({ api, mock }) => {
    const settled = await Promise.allSettled(Array.from({ length: 10 }, () => api.db.chats.list()))
    assert.ok(mock.state.busyRejections > 0, 'the host refused calls above maxSessions')
    assert.ok(settled.some((r) => r.status === 'rejected' && r.reason instanceof PluginBackendError && r.reason.code === 'plugin_backend_busy'))
  })
})

test('F1: a busy host answer is retried with exponential backoff (the slot is released while waiting); both spellings; bounded; a closed transport stops retrying', async () => {
  for (const busyCode of ['plugin_backend_busy', 'plugin_backend_unavailable']) {
    const delays = []
    const calls = []
    let busyFor = 3
    const host = {
      backend: { call: async (method, params) => { calls.push(params.path); if (busyFor > 0) { busyFor -= 1; throw new Error(busyCode) } return { ok: true, value: params.path } } },
      assets: { url: String }
    }
    const api = createPluginLineTodoApi({ host, events: { ...FAST_EVENTS, enabled: false }, busyRetry: { baseMs: 100, maxMs: 1000, random: () => 0.5, sleep: async (ms) => { delays.push(ms) } } })
    assert.equal(await api.plugin.invoke('ping'), 'ping', `succeeds after the host stops being busy (${busyCode})`)
    assert.deepEqual(delays, [100, 200, 400], 'exponential backoff from 100 ms')
    assert.equal(calls.length, 4)
    assert.equal(api.plugin.transportStats().busyRetries, 3)
    assert.equal(api.plugin.transportStats().active, 0, 'no slot is held after the call')

    // a permanently busy host: bounded retries (4) and then the host code reaches the caller
    delays.length = 0
    busyFor = Infinity
    await assert.rejects(api.plugin.invoke('ping'), (e) => e instanceof PluginBackendError && e.code === busyCode)
    assert.equal(delays.length, 4)
    api.dispose()
  }
  // other host failures are not retried; backoff is capped; closing the transport during a backoff ends the call with 'disposed'
  let n = 0
  const crashed = createPluginLineTodoApi({ host: { backend: { call: async () => { n += 1; throw new Error('plugin_backend_crashed') } }, assets: { url: String } }, events: { enabled: false } })
  await assert.rejects(crashed.plugin.invoke('ping'), (e) => e.code === 'plugin_backend_crashed')
  assert.equal(n, 1, 'a crash is not a busy answer: no retry')
  crashed.dispose()
  const capped = []
  const never = createPluginLineTodoApi({ host: { backend: { call: async () => { throw new Error('plugin_backend_busy') } }, assets: { url: String } }, events: { enabled: false }, busyRetry: { attempts: 6, baseMs: 400, maxMs: 1000, random: () => 0.5, sleep: async (ms) => { capped.push(ms) } } })
  await assert.rejects(never.plugin.invoke('ping'))
  assert.deepEqual(capped, [400, 800, 1000, 1000, 1000, 1000])
  never.dispose()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const closing = createPluginLineTodoApi({ host: { backend: { call: async () => { throw new Error('plugin_backend_busy') } }, assets: { url: String } }, events: { enabled: false }, busyRetry: { sleep: () => gate } })
  const pending = closing.plugin.invoke('ping')
  await sleep(20)
  closing.dispose()
  release()
  await assert.rejects(pending, (e) => e instanceof PluginApiError && e.code === 'disposed')
})

test('F1: a long job (reviewLastDays) does not hold a slot between polls — other requests keep flowing with a budget of 3, long poll included', async () => {
  const hub = new EventHub()
  let finish
  const fakeApi = { pipeline: { runOnce: () => new Promise((resolve) => { finish = resolve }) }, ping: async () => ({ ok: true }) }
  const dispatcher = new Dispatcher({ getApi: () => fakeApi, hub, queue: { stats: () => ({}) }, softDeadlineMs: 20, maxJobWaitMs: 60 })
  const mock = makeHost({ target: { call: (m, p) => dispatcher.call(m, p) } })
  const api = createPluginLineTodoApi({ host: mock.host, jobPollWaitMs: 40, events: FAST_EVENTS })
  try {
    api.line.onMessage(() => undefined) // long poll running
    await until(() => mock.count('events.pull') >= 1, { message: 'the long poll' })
    const job = api.pipeline.runOnce()
    await until(() => mock.count('job.poll') >= 2, { message: 'the job to be polled' })
    for (let i = 0; i < 5; i += 1) assert.equal((await api.ping()).ok, true)
    finish({ runId: 'r', todosCreated: 1 })
    assert.deepEqual(await job, { runId: 'r', todosCreated: 1 })
    assert.equal(mock.state.busyRejections, 0)
    assert.ok(mock.state.maxInFlight <= 3)
  } finally { api.dispose(); dispatcher.dispose(); hub.dispose() }
})

test('adapter: a result above the 64 KiB response limit comes back in chunks and is reassembled exactly; a long call becomes a job that is polled to completion', async () => {
  await withBackend({ backend: { dispatcher: { responseBudgetBytes: 3000 } } }, async ({ api, line, mock }) => {
    for (let i = 1; i <= 40; i += 1) line.emit(raw(i, { text: `第 ${i} 則：${'很長的內容'.repeat(30)}` }))
    const all = await api.db.messages.list({ chatId: 'u-alice', limit: 100 })
    assert.equal(all.length, 40)
    assert.ok(all.every((m) => m.text.includes('很長的內容')))
    assert.ok(mock.count('result.chunk') > 3, 'delivered through result.chunk')
    assert.ok(mock.state.calls.every((c) => c.method === backendMethodFor(c.path)))
  })
  // a call slower than the soft deadline: the real Dispatcher turns it into a job; the adapter polls job.poll until it is done
  const hub = new EventHub()
  const fakeApi = { pipeline: { runOnce: async () => { await sleep(120); return { runId: 'r1', todosCreated: 2 } } } }
  const dispatcher = new Dispatcher({ getApi: () => fakeApi, hub, queue: { stats: () => ({}) }, softDeadlineMs: 20, maxJobWaitMs: 40 })
  const mock = makeHost({ target: { call: (m, p) => dispatcher.call(m, p) } })
  const api = createPluginLineTodoApi({ host: mock.host, jobPollWaitMs: 30, events: FAST_EVENTS })
  assert.deepEqual(await api.pipeline.runOnce(), { runId: 'r1', todosCreated: 2 })
  assert.ok(mock.count('job.poll') >= 1, 'polled the job')
  // a job that outlives the view is abandoned cleanly on dispose
  fakeApi.pipeline.runOnce = async () => { await sleep(400); return {} }
  const pending = api.pipeline.runOnce()
  await sleep(60)
  api.dispose()
  await assert.rejects(pending, (e) => e instanceof PluginApiError && e.code === 'disposed')
  dispatcher.dispose()
  hub.dispose()
})

// ───────────── on* subscriptions receive long-poll events ─────────────

test('events: on* subscriptions receive the backend events through the long poll (in order, once, no key material); one session serves every subscriber', async () => {
  await withBackend({}, async ({ api, line, mock, ai }) => {
    const seen = { message: [], persisted: [], run: [], todos: [], status: [], pipelineStatus: [] }
    const offs = [
      api.line.onMessage((m) => seen.message.push(m)),
      api.line.onMessage((m) => seen.message.push({ second: m.msgId })),
      api.db.onMessagesPersisted((e) => seen.persisted.push(e)),
      api.pipeline.onRun((r) => seen.run.push(r)),
      api.pipeline.onTodosChanged((e) => seen.todos.push(e)),
      api.line.onStatus((s) => seen.status.push(s)),
      api.pipeline.onStatus((s) => seen.pipelineStatus.push(s))
    ]
    await until(() => api.plugin.eventsStats().sessionId !== null && mock.count('events.pull') >= 1, { message: 'the poll to start' })
    line.emit(raw(1, { text: '請幫我寄報價單給客戶' }))
    line.emit(raw(2, { text: '下午三點開會，記得帶合約' }))
    await until(() => seen.message.filter((m) => m.msgId).length === 2 && seen.persisted.length >= 1, { message: 'line-message + messages-persisted events' })
    assert.deepEqual(seen.message.filter((m) => m.msgId).map((m) => m.msgId), ['i:m1', 'i:m2'], 'ordered, each once')
    assert.deepEqual(seen.message.filter((m) => m.second).map((m) => m.second), ['i:m1', 'i:m2'], 'a second subscriber to the same event also receives them')
    assert.ok(seen.message.every((m) => !('keyMaterial' in m)))
    assert.equal(seen.persisted.reduce((n, e) => n + e.inserted, 0), 2)

    // a run (the backend's worker answers the supply) produces pipeline-run and todos-changed
    await api.pipeline.runOnce()
    await until(() => seen.todos.some((e) => e.createdIds.length === 1) && seen.run.length >= 2, { message: 'todos-changed and pipeline-run' })
    const created = (await api.db.todos.list()).map((t) => t.id)
    assert.deepEqual(seen.todos.find((e) => e.createdIds.length === 1).createdIds, created)
    // the AI status is an event too (the board's status line)
    const aiEvents = []
    const offAi = api.plugin.onAiStatus((status) => aiEvents.push(status.state))
    ai.control.set({ providerState: 'not_logged_in' })
    await api.plugin.aiStatus({ refresh: true })
    await until(() => aiEvents.includes('unavailable'), { message: 'ai-status event' })
    offAi()

    assert.equal(mock.count('events.open'), 1, 'one long-poll session for all subscribers')
    assert.equal(api.plugin.eventsStats().listeners, 7, 'listener bookkeeping')
    for (const off of offs) off()
  })
})

test('events: after the last unsubscribe the poll stops and the session is closed; a new subscriber starts it again', async () => {
  await withBackend({}, async ({ api, line, mock }) => {
    const got = []
    const off = api.line.onMessage((m) => got.push(m.msgId))
    await until(() => mock.count('events.pull') >= 1, { message: 'the first pull' })
    line.emit(raw(1))
    await until(() => got.length === 1, { message: 'the first event' })
    const sessionA = api.plugin.eventsStats().sessionId
    off()
    await until(() => mock.count('events.close') === 1, { message: 'events.close after unsubscribe' })
    assert.equal(mock.state.calls.find((c) => c.path === 'events.close').args[0].sessionId, sessionA)
    await sleep(60)
    const pullsAfterStop = mock.count('events.pull')
    await sleep(250)
    assert.equal(mock.count('events.pull'), pullsAfterStop, 'no more pulls once everyone unsubscribed')
    assert.equal(api.plugin.eventsStats().running, false)
    line.emit(raw(2))
    await sleep(80)
    assert.deepEqual(got, ['i:m1'], 'nothing is delivered to an unsubscribed listener')

    // re-subscribing inside the grace period does not churn the session (React StrictMode mount/unmount/mount)
    const offB = api.line.onMessage((m) => got.push(m.msgId))
    offB()
    const offC = api.line.onMessage((m) => got.push(m.msgId))
    await sleep(120)
    assert.equal(mock.count('events.open'), 2, 'one new session for the new subscription, not one per mount')
    assert.equal(api.plugin.eventsStats().running, true)
    line.emit(raw(3))
    await until(() => got.includes('i:m3'), { message: 'an event on the restarted poll' })
    offC()
  })
})

test('events: dispose stops the polling for good — the session is closed once, no pull is sent afterwards, nothing is delivered, later requests reject', async () => {
  await withBackend({ api: { events: { ...FAST_EVENTS, waitMs: 400, idleStopMs: 1000 } } }, async ({ api, backend, line, mock }) => {
    const got = []
    api.line.onMessage((m) => got.push(m.msgId))
    api.pipeline.onTodosChanged(() => got.push('todos'))
    await until(() => mock.count('events.pull') >= 1, { message: 'a long poll in flight' })
    const t0 = Date.now()
    api.dispose()
    // the backend releases the waiting long poll because the session was closed, not after its 400 ms timeout
    await until(() => backend.diagnostics().eventSessions === 0, { timeout: 300, message: 'the backend session to be closed' })
    assert.ok(Date.now() - t0 < 300)
    assert.equal(mock.count('events.close'), 1)
    const pulls = mock.count('events.pull')
    line.emit(raw(1))
    await sleep(500)
    assert.equal(mock.count('events.pull'), pulls, 'no pull after dispose')
    assert.equal(mock.count('events.open'), 1)
    assert.deepEqual(got, [])
    await assert.rejects(api.ping(), (e) => e instanceof PluginApiError && e.code === 'disposed')
    assert.equal(api.line.onMessage(() => undefined)(), undefined, 'subscribing after dispose is a harmless no-op')
    assert.equal(api.plugin.eventsStats().running, false)
    api.dispose() // idempotent
  })
})

test('events: a ring overflow (gap) or a lost session triggers a resync — empty todos-changed / messages-persisted plus fresh status events — and the stream continues', async () => {
  await withBackend({ backend: { hub: { maxEvents: 4 } } }, async ({ api, line, mock }) => {
    const log = []
    api.db.onMessagesPersisted((e) => log.push(['persisted', e.inserted]))
    api.pipeline.onTodosChanged((e) => log.push(['todos', e.createdIds.length]))
    api.pipeline.onStatus((s) => log.push(['pipeline-status', s.running]))
    api.line.onStatus((s) => log.push(['line-status', s.state]))
    const live = []
    api.line.onMessage((m) => live.push(m.msgId))
    await until(() => mock.count('events.pull') >= 1, { message: 'the poll' })
    // stall the poll while a burst rolls the 4-event ring over
    let release
    mock.state.hold = { promise: new Promise((resolve) => { release = resolve }) }
    await sleep(200) // the in-flight pull (waitMs 150) returns; the next one is held
    for (let i = 1; i <= 12; i += 1) line.emit(raw(i))
    log.length = 0
    mock.state.hold = null
    release()
    await until(() => log.some(([k]) => k === 'todos') && log.some(([k]) => k === 'persisted'), { message: 'the resync events' })
    await until(() => log.some(([k]) => k === 'pipeline-status') && log.some(([k]) => k === 'line-status'), { message: 'status re-pulled after the gap' })
    assert.deepEqual(log.find(([k]) => k === 'todos'), ['todos', 0], 'resync todos-changed carries no ids: the board reloads')
    // and later events keep flowing on the same session
    line.emit(raw(99))
    await until(() => live.includes('i:m99'), { message: 'a live event after the resync' })
    assert.equal(mock.count('events.open'), 1, 'a gap does not need a new session')
  })
})

test('events: the backend restarting (session_not_found) reopens the session and resyncs; temporary host failures back off and recover', async () => {
  const dirs = [mkdtempSync(join(tmpdir(), 'plugin-adapter-a-')), mkdtempSync(join(tmpdir(), 'plugin-adapter-b-'))]
  const lineA = fakeLine()
  const lineB = fakeLine()
  const backendA = await createPluginBackend({ pluginId: 'p', version: '1', dataDir: dirs[0], line: lineA.port })
  const mock = makeHost({ target: backendA })
  const diagnostics = []
  const api = createPluginLineTodoApi({ host: mock.host, events: { ...FAST_EVENTS, onDiagnostic: (d) => diagnostics.push(d) } })
  let backendB = null
  try {
    const got = []
    const resyncs = []
    api.line.onMessage((m) => got.push(m.msgId))
    api.pipeline.onTodosChanged((e) => resyncs.push(e.createdIds.length))
    await until(() => mock.count('events.pull') >= 1, { message: 'the poll' })
    lineA.emit(raw(1))
    await until(() => got.length === 1, { message: 'event from backend A' })

    // a host-level outage: calls reject with the host's error code; the pump backs off and retries
    mock.state.failNext = 'plugin_backend_crashed'
    await until(() => diagnostics.some((d) => d.kind === 'error'), { message: 'the outage to be noticed' })

    // the backend is replaced (crash + restart): the old session id is unknown to the new instance
    backendB = await createPluginBackend({ pluginId: 'p', version: '2', dataDir: dirs[1], line: lineB.port })
    mock.state.target = backendB
    await backendA.dispose()
    await until(() => diagnostics.some((d) => d.kind === 'reopen'), { message: 'the session to be reopened' })
    await until(() => mock.count('events.open') >= 2, { message: 'a new session' })
    await until(() => resyncs.length >= 1, { message: 'the resync after the restart' })
    lineB.emit(raw(2))
    await until(() => got.includes('i:m2'), { message: 'an event from backend B' })
    assert.equal((await api.ping()).version, '2', 'requests go to the new backend')
  } finally {
    api.dispose()
    await backendA.dispose().catch(() => undefined)
    await backendB?.dispose()
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  }
})

// ───────────── unsupported in the plugin build ─────────────

test('unsupported: driver is absent; CLI / endpoint / key / saveAs / open / data folder / original chat answer an explicit unsupported_in_plugin, and the UI capability flags that hide them line up', async () => {
  await withBackend({}, async ({ api, mock }) => {
    assert.equal(api.driver, undefined)
    const explicit = (r) => {
      assert.equal(r.ok ?? false, false)
      assert.match(String(r.error ?? r.summary), /^unsupported_in_plugin/)
    }
    explicit(await api.media.open('i:m1'))
    explicit(await api.media.saveAs('i:m1'))
    explicit(await api.db.chats.openOriginal('u-alice'))
    explicit(await api.pipeline.testQwen())
    explicit(await api.pipeline.testAiProvider())
    explicit(await api.settings.setApiKey('sk-secret'))
    assert.deepEqual(await api.settings.clearApiKey(), { ok: false })
    assert.deepEqual(await api.app.openDataFolder(), { ok: false })
    // the secret key never reached the backend as anything but a refused call (the backend ignores it)
    assert.equal((await api.settings.get()).apiKeySource, 'none')

    // the raw channel throws a typed error
    // G-07: driver is not a backend method group: the view refuses the path itself (it never reaches the host; Core would refuse it as backend_method_not_allowed)
    await assert.rejects(api.plugin.invoke('driver.postDraft', [{ todoId: 'x', text: 'y' }]), (e) => e instanceof PluginApiError && !(e instanceof PluginUnsupportedError) && e.code === 'path_unknown')
    // the AI features are NOT unsupported any more: they run in the backend (host.ai.complete)
    await assert.doesNotReject(api.plugin.invoke('db.todos.draftReply', ['t1']))
    await assert.doesNotReject(api.plugin.invoke('groupTopics.analyze', ['c1']))

    // every capability that the plugin turns off maps to API paths the backend refuses (or to `driver`, which the adapter omits)
    const off = Object.entries(PLUGIN_CAPABILITIES).filter(([key, value]) => key !== 'host' && value === false).map(([key]) => key)
    assert.deepEqual(off.sort(), ['aiProviderSelection', 'apiKey', 'customAiEndpoint', 'driverPost', 'extractConcurrency', 'mediaFileActions', 'openAtLogin', 'openDataFolder', 'openOriginalChat'])
    for (const [capability, paths] of Object.entries(CAPABILITY_API_PATHS)) {
      assert.equal(PLUGIN_CAPABILITIES[capability], false, `${capability} is off in the plugin`)
      assert.equal(STANDALONE_CAPABILITIES[capability], true, `${capability} stays on in standalone`)
      for (const path of paths) {
        if (path === 'driver') { assert.equal(api.driver, undefined); continue }
        await assert.rejects(api.plugin.invoke(path, ['x']), (e) => e instanceof PluginUnsupportedError, `${capability}: ${path}`)
      }
    }
    assert.ok(Object.values(STANDALONE_CAPABILITIES).every((v) => v === true || v === 'standalone'), 'standalone keeps everything on')
    assert.equal(mock.count('driver.postDraft'), 0, 'driver.* never leaves the view')
  })
})

test('AI seam: draftReply / analyzeNotMine / group analysis are plain backend calls; when the AI cannot work they fail explicitly in the shape of their own result type (never fake success)', async () => {
  await withBackend({ setup: (ai) => ai.control.set({ providerState: 'not_logged_in' }) }, async ({ api, mock, ai }) => {
    // a todo that does not exist: the backend says so before any AI is needed
    assert.deepEqual(await api.db.todos.draftReply('t1'), { error: '找不到該代辦' })
    assert.equal((await api.db.todos.analyzeNotMine('f1')).ok, false)
    assert.equal((await api.groupTopics.analyze('c1')).ok, false)
    assert.equal(mock.count('db.todos.draftReply'), 1, 'the call really went to the backend: the view has no AI of its own')
    assert.equal(ai.stats.completes, 0)
    assert.equal(ai.control.liveSessions(), 0)
  })
  await withBackend({}, async ({ api, line, ai }) => {
    line.emit(raw(1, { text: '請幫我寄報價單給客戶' }))
    await api.pipeline.runOnce()
    const todo = (await asyncUntil(async () => { const list = await api.db.todos.list(); return list.length === 1 ? list : null }, { message: 'a todo' }))[0]
    assert.equal((await api.db.todos.draftReply(todo.id)).draft, '好的，我明天回覆您')
    ai.control.set({ providerState: 'not_logged_in' })
    await api.plugin.aiStatus({ refresh: true })
    const failed = await api.db.todos.draftReply(todo.id)
    assert.equal(failed.draft, undefined)
    assert.match(failed.error, /Codex 目前無法使用/)
  })
})

// ───────────── media through assets.url ─────────────

const IKM_B64 = Buffer.alloc(32, 7).toString('base64')
function makeEimg(plain) {
  const derived = Buffer.from(hkdfSync('sha256', Buffer.from(IKM_B64, 'base64'), Buffer.alloc(32, 0), Buffer.from('FileEncryption'), 76))
  const nonce = Buffer.concat([derived.subarray(64, 76), Buffer.alloc(4, 0)])
  const cipher = createCipheriv('aes-256-ctr', derived.subarray(0, 32), nonce)
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([ciphertext, createHmac('sha256', derived.subarray(32, 64)).update(ciphertext).digest()])
}

test('media: assetUrl() asks the backend to decrypt into dataDir and returns the host assets.url for the cached file; failures are null; a hit is not asked twice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-adapter-media-'))
  const cacheDir = join(root, 'LINE', 'Cache')
  mkdirSync(cacheDir, { recursive: true })
  const plain = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1200, 0x41)])
  writeFileSync(join(cacheDir, 'x.eimg'), makeEimg(plain))
  try {
    await withBackend({ backend: { media: { fs: createNodeLineFsPort(), cacheDir } } }, async ({ api, line, mock, dataDir }) => {
      line.emit({ ...raw(1, { text: '[image]' }), contentType: 1, keyMaterial: IKM_B64, fileSize: plain.length, fileName: null })
      line.emit({ ...raw(2, { text: '[image]' }), contentType: 1, keyMaterial: IKM_B64, fileSize: 77, fileName: null }) // never downloaded
      const url = await api.media.assetUrl('i:m1')
      assert.match(url, /^tuqplugin:\/\/tuqdev\.line-todo\/data\/media-cache\/[0-9a-f]{32}\.png$/)
      assert.ok(existsSync(join(dataDir, 'media-cache', url.split('/').pop())), 'the file the URL points at is in dataDir')
      assert.equal(await api.media.assetUrl('i:m1'), url)
      assert.equal(mock.count('media.prepare'), 1, 'the second lookup is served from the adapter cache')
      assert.equal(await api.media.assetUrl('i:m2'), null, 'not downloaded in LINE yet -> null (the UI shows 尚未下載)')
      assert.equal(await api.media.assetUrl('i:nope'), null)
    })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('review: when the AI cannot work reviewLastDays answers "not connected" at once with the reason (it would otherwise wait 15 minutes for results nobody delivers); otherwise it rides the job channel while the backend worker answers', async () => {
  await withBackend({ setup: (ai) => ai.control.set({ providerState: 'not_logged_in' }) }, async ({ api, mock }) => {
    const t0 = Date.now()
    const review = await api.pipeline.reviewLastDays(3)
    assert.ok(Date.now() - t0 < 500)
    assert.equal(review.ok, false)
    assert.equal(review.hasApiKey, true, 'the UI must not tell the user to enter an API key')
    assert.equal(review.days, 3)
    assert.match(review.note, /尚未登入/)
    assert.equal(mock.count('pipeline.reviewLastDays'), 1, 'the backend was asked and refused')
  })
  const dataDir = mkdtempSync(join(tmpdir(), 'plugin-adapter-review-'))
  const line = fakeLine()
  line.port.getMessagesSince = async () => [raw(1, { text: '提醒我週五前交付報告', ts: Date.now() - 1000 }), raw(2, { text: '另外發票也要開', ts: Date.now() - 500 })]
  // the model takes ~100 ms, slower than the backend's 30 ms soft deadline, so the call turns into a job
  const ai = createMockTuqAi({ reply: (ctx) => ({ text: fenced(okResult([JSON.parse(ctx.user).newMessages[0].msgId], '交付週五報告')), delay: () => sleep(100) }) })
  const backend = await createPluginBackend({ pluginId: 'p', version: '1', dataDir, line: line.port, dispatcher: { softDeadlineMs: 30, maxJobWaitMs: 200 }, hostAi: ai.ai, ai: { config: { optionsTtlMs: 20 }, worker: { pollIntervalMs: 40 } } })
  const mock = makeHost({ target: backend })
  const api = createPluginLineTodoApi({ host: mock.host, jobPollWaitMs: 100, events: FAST_EVENTS })
  try {
    const result = await api.pipeline.reviewLastDays(7)
    assert.equal(result.ok, true)
    assert.equal(result.todosCreated, 1)
    assert.ok(mock.count('job.poll') >= 1, 'the long review became a job')
    assert.deepEqual((await api.db.todos.list()).map((t) => t.title), ['交付週五報告'])
  } finally {
    api.dispose()
    await backend.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ───────────── chat tab remount: queued avatar calls can be dropped, avatar requests are de-duplicated and remembered ─────────────

test('Limiter: a queued task can be cancelled before it starts; a running task and the queue behind it are unaffected', async () => {
  const limiter = new Limiter(1)
  let releaseRunning
  const ran = []
  const running = limiter.run(async () => { ran.push('running'); await new Promise((resolve) => { releaseRunning = resolve }); return 'done' })
  const early = new AbortController()
  const late = new AbortController()
  const cancelled = limiter.run(async () => { ran.push('cancelled'); return 'no' }, { signal: early.signal })
  const kept = limiter.run(async () => { ran.push('kept'); return 'kept' }, { signal: late.signal })
  assert.deepEqual(limiter.stats(), { active: 1, waiting: 2 })
  early.abort()
  await assert.rejects(cancelled, (e) => e instanceof CallCancelledError)
  assert.deepEqual(limiter.stats(), { active: 1, waiting: 1 }, 'the cancelled task left the queue at once')
  const alreadyAborted = new AbortController()
  alreadyAborted.abort()
  await assert.rejects(limiter.run(async () => 'x', { signal: alreadyAborted.signal }), (e) => e instanceof CallCancelledError)
  assert.deepEqual(limiter.stats(), { active: 1, waiting: 1 }, 'an already aborted signal never enters the queue')
  releaseRunning()
  assert.equal(await running, 'done')
  assert.equal(await kept, 'kept')
  assert.deepEqual(ran, ['running', 'kept'])
  assert.deepEqual(limiter.stats(), { active: 0, waiting: 0 })
  // aborting after the task started does nothing to it
  const started = new AbortController()
  let finish
  const inFlight = limiter.run(() => new Promise((resolve) => { finish = resolve }), { signal: started.signal })
  started.abort()
  finish('still ran')
  assert.equal(await inFlight, 'still ran')
  assert.deepEqual(limiter.stats(), { active: 0, waiting: 0 })
})

/** a host with gates: `hold(path)` makes the next calls of that path wait for `release(path)`; every call is logged in order */
function gatedHost({ fail = new Set() } = {}) {
  const log = []
  const held = new Map()
  const holding = new Set()
  const hold = (path) => { holding.add(path) }
  const release = (path) => { holding.delete(path); for (const open of held.get(path) ?? []) open(); held.set(path, []) }
  const pathsFor = (ids) => Object.fromEntries(ids.map((id) => [id, `avatar-cache/${id}.jpg`]))
  const namesFor = (ids) => Object.fromEntries(ids.map((id) => [id, `N ${id}`]))
  const host = {
    assets: { url: (p) => `asset://${p}` },
    backend: {
      async call(_method, params) {
        const { path, args = [] } = params
        log.push({ path, args })
        if (holding.has(path)) await new Promise((resolve) => { held.set(path, [...(held.get(path) ?? []), resolve]) })
        if (path === 'media.avatar.prepareMessages') {
          const ids = args[1]
          if (ids.some((id) => fail.has(id))) throw new Error('plugin_backend_crashed')
          if (ids.includes('i:chunked')) return { ok: true, chunked: true, resultId: 'r1', chunks: 2 }
          return { ok: true, value: { paths: pathsFor(ids), names: namesFor(ids) } }
        }
        if (path === 'media.avatar.prepareChats') return { ok: true, value: { paths: pathsFor(args[0]), names: namesFor(args[0]) } }
        if (path === 'result.chunk') {
          const text = JSON.stringify({ paths: pathsFor(['i:chunked']), names: namesFor(['i:chunked']) })
          const half = Math.ceil(text.length / 2)
          return { ok: true, value: { data: args[0].index === 0 ? text.slice(0, half) : text.slice(half) } }
        }
        return { ok: true, value: path }
      }
    }
  }
  const avatarFlight = { now: 0, peak: 0 }
  const inner = host.backend.call
  host.backend.call = async (method, params) => {
    const isAvatar = String(params.path).startsWith('media.avatar.')
    if (isAvatar) { avatarFlight.now += 1; avatarFlight.peak = Math.max(avatarFlight.peak, avatarFlight.now) }
    try { return await inner(method, params) } finally { if (isAvatar) avatarFlight.now -= 1 }
  }
  const avatarCalls = (path = 'media.avatar.prepareMessages') => log.filter((entry) => entry.path === path)
  return { host, log, hold, release, avatarCalls, avatarFlight }
}

test('avatar requests: duplicates are sent once, known results are remembered, identical in-flight requests are merged, chat scope is separate', async () => {
  const g = gatedHost()
  const api = createPluginLineTodoApi({ host: g.host, maxConcurrentCalls: 1, events: { enabled: false } })
  try {
    g.hold('ping')
    const blocker = api.plugin.invoke('ping') // fills the only slot, so the avatar calls below queue behind it
    await until(() => g.log.length === 1, { message: 'the blocker to start' })
    const first = api.media.messageAvatarUrls('c1', ['i:1', 'i:2', 'i:1'])
    const second = api.media.messageAvatarUrls('c1', ['i:2', 'i:1'])
    await sleep(10)
    assert.equal(api.plugin.transportStats().waiting, 1, 'the two identical requests share one queued call')
    g.release('ping')
    await blocker
    const [a, b] = await Promise.all([first, second])
    assert.deepEqual(a, { urls: { 'i:1': 'asset://avatar-cache/i:1.jpg', 'i:2': 'asset://avatar-cache/i:2.jpg' }, names: { 'i:1': 'N i:1', 'i:2': 'N i:2' } })
    assert.deepEqual(b, a)
    assert.deepEqual(g.avatarCalls().map((c) => c.args), [['c1', ['i:1', 'i:2']]])

    const partial = await api.media.messageAvatarUrls('c1', ['i:2', 'i:3'])
    assert.deepEqual(Object.keys(partial.urls).sort(), ['i:2', 'i:3'])
    assert.deepEqual(g.avatarCalls().map((c) => c.args[1]), [['i:1', 'i:2'], ['i:3']], 'only the unknown id was sent')
    await api.media.messageAvatarUrls('c1', ['i:3', 'i:1'])
    assert.equal(g.avatarCalls().length, 2, 'a fully known request sends nothing')

    await api.media.messageAvatarUrls('c2', ['i:1'])
    assert.deepEqual(g.avatarCalls().map((c) => c.args), [['c1', ['i:1', 'i:2']], ['c1', ['i:3']], ['c2', ['i:1']]], 'the same msgId in another chat is a different avatar')

    await api.media.avatarUrls(['c1', 'c2', 'c1'])
    await api.media.avatarUrls(['c2', 'c1'])
    assert.deepEqual(g.avatarCalls('media.avatar.prepareChats').map((c) => c.args), [[['c1', 'c2']]])
  } finally { api.dispose() }
})

test('avatar requests: a failed answer is not remembered; an empty id list sends nothing', async () => {
  const g = gatedHost({ fail: new Set(['i:bad']) })
  const api = createPluginLineTodoApi({ host: g.host, events: { enabled: false }, busyRetry: { attempts: 0 } })
  try {
    assert.deepEqual(await api.media.messageAvatarUrls('c1', ['i:bad']), { urls: {}, names: {} })
    assert.deepEqual(await api.media.messageAvatarUrls('c1', ['i:bad']), { urls: {}, names: {} })
    assert.equal(g.avatarCalls().length, 2, 'a failure is retried')
    assert.deepEqual(await api.media.messageAvatarUrls('c1', []), { urls: {}, names: {} })
    assert.equal(g.avatarCalls().length, 2, 'an empty id list sends nothing')
  } finally { api.dispose() }
})

test('avatar requests: abort drops a queued request (the backend never sees it); a request someone else still waits for survives; a started call finishes and is remembered', async () => {
  const g = gatedHost()
  const api = createPluginLineTodoApi({ host: g.host, maxConcurrentCalls: 1, events: { enabled: false } })
  try {
    g.hold('ping')
    const blocker = api.plugin.invoke('ping')
    await until(() => g.log.length === 1, { message: 'the blocker to start' })

    const lone = new AbortController()
    const dropped = api.media.messageAvatarUrls('c1', ['i:9'], { signal: lone.signal })
    await sleep(5)
    assert.equal(api.plugin.transportStats().waiting, 1)
    lone.abort()
    assert.deepEqual(await dropped, { urls: {}, names: {} }, 'an aborted request resolves empty')
    assert.equal(api.plugin.transportStats().waiting, 0, 'its queued backend call left the queue')

    const sharedA = new AbortController()
    const leaving = api.media.messageAvatarUrls('c1', ['i:20'], { signal: sharedA.signal })
    const staying = api.media.messageAvatarUrls('c1', ['i:20'])
    await sleep(5)
    assert.equal(api.plugin.transportStats().waiting, 1, 'merged into one queued call')
    sharedA.abort()
    assert.deepEqual(await leaving, { urls: {}, names: {} })
    assert.equal(api.plugin.transportStats().waiting, 1, 'another caller still needs it: not dropped')

    g.release('ping')
    await blocker
    assert.deepEqual((await staying).urls, { 'i:20': 'asset://avatar-cache/i:20.jpg' })
    assert.deepEqual(g.avatarCalls().map((c) => c.args[1]), [['i:20']], 'i:9 was never sent; i:20 was sent once')

    const retry = await api.media.messageAvatarUrls('c1', ['i:9'])
    assert.deepEqual(Object.keys(retry.urls), ['i:9'], 'a dropped request does not poison later requests for the same id')

    g.hold('media.avatar.prepareMessages')
    const startedAbort = new AbortController()
    const started = api.media.messageAvatarUrls('c1', ['i:30'], { signal: startedAbort.signal })
    await until(() => g.avatarCalls().some((c) => c.args[1].includes('i:30')), { message: 'the call to start' })
    startedAbort.abort()
    assert.deepEqual(await started, { urls: {}, names: {} })
    const merged = api.media.messageAvatarUrls('c1', ['i:30', 'i:31'])
    await sleep(10)
    g.release('media.avatar.prepareMessages')
    assert.deepEqual(Object.keys((await merged).urls).sort(), ['i:30', 'i:31'])
    assert.deepEqual(g.avatarCalls().map((c) => c.args[1]).slice(-2), [['i:30'], ['i:31']], 'a new request merges into the call that already started and only sends the rest')
    const before = g.avatarCalls().length
    await api.media.messageAvatarUrls('c1', ['i:30'])
    assert.equal(g.avatarCalls().length, before, 'the aborted-but-started call was kept')
  } finally { api.dispose() }
})

test('avatar requests: aborting after the call started does not cancel its result.chunk reads', async () => {
  const g = gatedHost()
  const api = createPluginLineTodoApi({ host: g.host, events: { enabled: false } })
  try {
    g.hold('result.chunk')
    const abort = new AbortController()
    const pending = api.media.messageAvatarUrls('c1', ['i:chunked'], { signal: abort.signal })
    await until(() => g.log.some((entry) => entry.path === 'result.chunk'), { message: 'the first chunk read' })
    abort.abort()
    assert.deepEqual(await pending, { urls: {}, names: {} })
    g.release('result.chunk')
    await until(() => g.log.filter((entry) => entry.path === 'result.chunk').length === 2, { message: 'both chunks to be read after the abort' })
    await sleep(10)
    const calls = g.log.length
    const again = await api.media.messageAvatarUrls('c1', ['i:chunked'])
    assert.deepEqual(Object.keys(again.urls), ['i:chunked'], 'the reassembled answer was remembered')
    assert.equal(g.log.length, calls)
  } finally { api.dispose() }
})

// ───────────── in-flight slow avatar calls must not hold the whole host call budget ─────────────

test('avatar calls: at most one is in flight at the default budget of 3, so two other host calls can always be sent; every avatar still loads', async () => {
  const g = gatedHost()
  const api = createPluginLineTodoApi({ host: g.host, events: { enabled: false } })
  try {
    assert.equal(api.plugin.transportStats().limit, 3)
    g.hold('media.avatar.prepareMessages')
    const ids = Array.from({ length: 6 }, (_, index) => `i:${index + 1}`)
    const loads = ids.map((id) => api.media.messageAvatarUrls('c1', [id]))
    await sleep(20)
    assert.equal(g.avatarCalls().length, 1, 'only one avatar call has been sent; the rest wait outside the host call queue')
    assert.equal(api.plugin.transportStats().active, 1)
    assert.equal(api.plugin.transportStats().waiting, 0)

    g.hold('ping')
    g.hold('line.status')
    const ping = api.plugin.invoke('ping')
    const status = api.plugin.invoke('line.status')
    await until(() => g.log.some((e) => e.path === 'ping') && g.log.some((e) => e.path === 'line.status'), { message: 'two non-avatar calls reach the host while an avatar call is in flight' })
    assert.equal(api.plugin.transportStats().active, 3)
    g.release('ping')
    g.release('line.status')
    assert.equal(await ping, 'ping')
    assert.equal(await status, 'line.status')
    assert.equal(g.avatarCalls().length, 1, 'the avatar call is still the only one sent')

    for (let round = 0; round < ids.length; round += 1) {
      await until(() => g.avatarCalls().length === round + 1, { message: `avatar call ${round + 1} to be sent` })
      g.release('media.avatar.prepareMessages')
      g.hold('media.avatar.prepareMessages')
    }
    g.release('media.avatar.prepareMessages')
    const results = await Promise.all(loads)
    assert.equal(g.avatarFlight.peak, 1, 'never more than one avatar call at the host')
    results.forEach((result, index) => assert.deepEqual(result.urls, { [ids[index]]: `asset://avatar-cache/${ids[index]}.jpg` }, `avatar ${ids[index]} loaded`))
    assert.deepEqual(g.avatarCalls().map((c) => c.args[1][0]), ids, 'every avatar was requested exactly once, in order')
    assert.equal(api.plugin.transportStats().active, 0)
  } finally { api.dispose() }
})

test('avatar calls: the budget scales (limit 5 -> 3 avatar calls, 2 always free); a budget of 1 still lets avatars through one at a time', async () => {
  const wide = gatedHost()
  const five = createPluginLineTodoApi({ host: wide.host, maxConcurrentCalls: 5, events: { enabled: false } })
  try {
    wide.hold('media.avatar.prepareMessages')
    const loads = Array.from({ length: 6 }, (_, index) => five.media.messageAvatarUrls('c1', [`i:${index + 1}`]))
    await until(() => wide.avatarCalls().length === 3, { message: 'three avatar calls in flight' })
    await sleep(20)
    assert.equal(wide.avatarCalls().length, 3)
    wide.release('media.avatar.prepareMessages')
    await Promise.all(loads)
    assert.equal(wide.avatarFlight.peak, 3)
  } finally { five.dispose() }
  const narrow = gatedHost()
  const one = createPluginLineTodoApi({ host: narrow.host, maxConcurrentCalls: 1, events: { enabled: false } })
  try {
    const results = await Promise.all([one.media.messageAvatarUrls('c1', ['i:1']), one.media.messageAvatarUrls('c1', ['i:2'])])
    assert.deepEqual(results.map((r) => Object.keys(r.urls)), [['i:1'], ['i:2']])
  } finally { one.dispose() }
})

test('avatar calls: the background slot is held for the whole call (chunked answer), so the next avatar call cannot slip in between the chunks', async () => {
  const g = gatedHost()
  const api = createPluginLineTodoApi({ host: g.host, events: { enabled: false } })
  try {
    const [chunked, plain] = await Promise.all([api.media.messageAvatarUrls('c1', ['i:chunked']), api.media.messageAvatarUrls('c1', ['i:2'])])
    assert.deepEqual(Object.keys(chunked.urls), ['i:chunked'])
    assert.deepEqual(Object.keys(plain.urls), ['i:2'])
    assert.deepEqual(g.log.map((e) => (e.path === 'media.avatar.prepareMessages' ? `prepare:${e.args[1][0]}` : e.path)), ['prepare:i:chunked', 'result.chunk', 'result.chunk', 'prepare:i:2'])
  } finally { api.dispose() }
})

test('avatar calls: abort drops a batch that waits for a background slot (never sent); the call in flight finishes', async () => {
  const g = gatedHost()
  const api = createPluginLineTodoApi({ host: g.host, events: { enabled: false } })
  try {
    g.hold('media.avatar.prepareMessages')
    const running = api.media.messageAvatarUrls('c1', ['i:1'])
    await until(() => g.avatarCalls().length === 1, { message: 'the first avatar call to be in flight' })
    const lone = new AbortController()
    const waiting = api.media.messageAvatarUrls('c1', ['i:2'], { signal: lone.signal })
    const kept = api.media.messageAvatarUrls('c1', ['i:3'])
    await sleep(10)
    assert.equal(api.plugin.transportStats().background.waiting, 2)
    lone.abort()
    assert.deepEqual(await waiting, { urls: {}, names: {} })
    assert.equal(api.plugin.transportStats().background.waiting, 1, 'the aborted batch left the wait at once')
    g.release('media.avatar.prepareMessages')
    assert.deepEqual(Object.keys((await running).urls), ['i:1'])
    assert.deepEqual(Object.keys((await kept).urls), ['i:3'])
    assert.deepEqual(g.avatarCalls().map((c) => c.args[1]), [['i:1'], ['i:3']], 'i:2 never reached the host')
    assert.deepEqual(Object.keys((await api.media.messageAvatarUrls('c1', ['i:2'])).urls), ['i:2'], 'an aborted id is requested again later')
  } finally { api.dispose() }
})
