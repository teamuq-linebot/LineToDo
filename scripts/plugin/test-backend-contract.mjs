// Phase 2 — the plugin backend bundle under the TeamUQ 1.6.8 backend contract (Electron 44.2.0 run-as-node + 1.6.8 permission flags +
// self-check), against a FAKE LINE source: a synthetic SQLite3MC-encrypted LINE DB that lives OUTSIDE dataDir, so Node fs cannot see it
// and only koffi (copy snapshot) + the WASM engine can read it. Needs Electron 31 (fixture writer) and Electron 44 (see scripts/lib/runtimes.mjs).
//
// What is proven (the host/view is scripts/lib/plugin-host-standin.mjs, which calls the production bundle's activate(context)):
//   * activate succeeds; runPermissionSelfCheck passes at boot, after activate (koffi + WASM + better-sqlite3 13.0.2 loaded) and after dispose
//   * one round: read snapshot -> app DB (better-sqlite3 13.0.2) -> chats / messages / todos readable through api.invoke
//   * ExtractQueue supplies work, a UI-style JSON result becomes a todo, malformed results are rejected
//   * the event session receives new-message events (long poll + capability session)
//   * dispose leaves no DB connection, watcher, timer or other handle behind
//   * the bundle contains no child_process / worker_threads / better-sqlite3-multiple-ciphers
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { analyzeBundle } from './build-backend.mjs'
import { runPluginContract } from '../lib/plugin-contract-harness.mjs'
import { generateFixtures, makeTempRoot, rmQuiet } from '../lib/runtimes.mjs'

let setup = null
function getSetup() {
  if (!setup) {
    setup = (async () => {
      const root = makeTempRoot('plugin-contract-')
      const fixtureDir = join(root, 'fixtures')
      const expected = generateFixtures(fixtureDir, { baseN: 900, walN: 120 })
      // the fake LINE dir: main DB only; the -wal/-shm appear later (the scenario copies them in with koffi)
      const linedir = join(root, 'linedir')
      mkdirSync(linedir, { recursive: true })
      copyFileSync(join(fixtureDir, 'wal', 'm.edb'), join(linedir, 'qw0f0f.edb'))
      const scenario = { linedir, walSourceDir: join(fixtureDir, 'wal'), expected: { baseCount: expected.wal.baseOnly.messageCount, fullCount: expected.wal.messageCount } }
      const run = await runPluginContract({
        workRoot: join(root, 'run'),
        settings: { lineDbDir: linedir, linePollSec: 1, lineBatchLimit: 300 },
        // the key a real backend would recover from LINE's memory; here it is the synthetic fixture key, cached the way the backend caches it
        preseed: ({ dataDir }) => writeFileSync(join(dataDir, '.linekey'), expected.key),
        scenario,
      })
      return { root, fixtureDir, linedir, expected, scenario, run }
    })()
  }
  return setup
}
test.after(async () => {
  if (setup) rmQuiet((await setup).root)
})

function assertSelfCheckPassed(label, report) {
  assert.ok(report, `${label}: report present`)
  assert.equal(report.ok, true, `${label}: ok (code=${report.code})`)
  assert.equal(report.code, null)
  assert.equal(report.allowAddons, true)
  assert.equal(report.probes.permission, 'active')
  const failed = Object.entries(report.probes).filter(([, v]) => v === 'fail' || v === 'allowed' || v === 'absent')
  assert.deepEqual(failed, [], `${label}: no failed probe`)
  for (const probe of ['scope_read', 'scope_write_data', 'scope_write_narrow', 'scope_child', 'scope_worker', 'write_outside', 'read_outside', 'child_process', 'worker_threads', 'addon', 'data_write']) {
    assert.equal(report.probes[probe], 'ok', `${label}: probe ${probe}`)
  }
}

test('Electron 44.2.0 + 1.6.8 flags: the production backend bundle activates; self-check passes at boot, after activate and after dispose', async () => {
  const { run } = await getSetup()
  assert.equal(run.exitCode, 0, `exit code (stderr: ${run.stderr.slice(0, 800)})`)
  const r = run.result
  assert.ok(r, `RESULT present (stdout: ${run.stdout.slice(0, 800)})`)
  assert.equal(r.fatal, undefined, r.fatal)
  assert.equal(r.runtime.electron, '44.2.0')
  assert.equal(r.runtime.abi, '149')
  assert.match(r.runtime.node, /^v24\./)
  assert.equal(run.flags[0], '--permission')
  assert.ok(run.flags.includes('--allow-addons'))
  assert.ok(!run.flags.some((f) => /allow-child-process|allow-worker/.test(f)), 'no child/worker allowance')
  assert.deepEqual(r.argvFlags, run.flags, 'the backend really ran with exactly these flags')
  assertSelfCheckPassed('boot', r.selfCheckBoot)
  assertSelfCheckPassed('afterActivate', r.selfCheckAfterActivate)
  assertSelfCheckPassed('end', r.selfCheckEnd)
  assert.deepEqual(r.handlerKeys, ['call', 'diagnostics', 'dispose', 'openSession'])
  assert.ok(r.activateMs < 30_000, `activate took ${r.activateMs} ms (host boot timeout is 30 s in the manifest draft)`)
  // stderr carries only Node's own --allow-addons notice
  const noisy = run.stderr.split('\n').filter((l) => l.trim() && !/PERM0001|trace-warnings|--allow-addons/.test(l))
  assert.deepEqual(noisy, [], 'no unexpected stderr output')
})

test('fake LINE source -> koffi snapshot + WASM -> app DB (better-sqlite3 13.0.2) -> chats / messages / todos through api.invoke', async () => {
  const { run, expected } = await getSetup()
  const r = run.result
  assert.equal(r.fatal, undefined, r.fatal)
  assert.equal(r.info.plugin, 'tuqdev.line-todo')
  assert.match(r.info.electron, /^44\./)
  assert.deepEqual(r.info.appDb, { sqlite: '3.53.4' }, 'the app DB runs on better-sqlite3 13.0.2 (SQLite 3.53.4), not the standalone 11.10.0 (3.49.2)')
  assert.equal(r.baseImport.count, expected.wal.baseOnly.messageCount, 'every row of the fake LINE DB was imported')
  assert.equal(r.baseImport.status.state, 'running')
  assert.equal(r.baseImport.status.lastError, null)
  assert.ok(r.reads.chats.ok && r.reads.chats.count >= 100, `chats: ${JSON.stringify(r.reads.chats).slice(0, 200)}`)
  assert.ok(r.reads.chats.sample.chatId && 'name' in r.reads.chats.sample)
  assert.equal(r.reads.messagesPage.count, 60)
  assert.ok(r.reads.messagesPage.first.msgId.startsWith('i:'))
  assert.ok(r.reads.messagesAll.ok)
  assert.equal(r.reads.messagesAll.count, expected.wal.baseOnly.messageCount)
  assert.ok(r.reads.messagesAll.viaChunks > 1, 'a result far above 64 KiB was delivered in chunks')
  assert.deepEqual(r.reads.todos, [])
  assert.equal(r.reads.ping.ok, true)
  // the DB files exist in dataDir, nothing outside
  assert.ok(r.afterDispose.dataDir.includes('line-todo.db'))
  assert.ok(r.afterDispose.dataDir.includes('.watch_json_state'))
})

test('the 64 KiB invoke limit is never exceeded in either direction', async () => {
  const { run } = await getSetup()
  const { wire } = run.result
  assert.ok(wire.calls > 50)
  assert.ok(wire.maxRequestBytes < wire.limit, `max request ${wire.maxRequestBytes}`)
  assert.ok(wire.maxResponseBytes < wire.limit, `max response ${wire.maxResponseBytes}`)
})

test('event session: new LINE messages arrive as line-message / messages-persisted events (long poll and capability session)', async () => {
  const { run, expected } = await getSetup()
  const r = run.result
  const walRows = expected.wal.messageCount - expected.wal.baseOnly.messageCount
  assert.equal(r.newMessages.count, expected.wal.messageCount)
  assert.equal(r.newMessages.byType['line-message'], walRows, 'one line-message event per new message')
  assert.ok(r.newMessages.byType['messages-persisted'] >= 1)
  assert.equal(r.newMessages.persisted.reduce((n, p) => n + p.inserted, 0) > 0, true)
  assert.equal(r.newMessages.seqs.strictlyIncreasing, true)
  assert.equal(r.newMessages.firstLineMessage.direction === 'in' || r.newMessages.firstLineMessage.direction === 'out', true)
  assert.ok(typeof r.newMessages.firstLineMessage.chatId === 'string')
  assert.equal('keyMaterial' in r.newMessages.firstLineMessage, false, 'key material never leaves the backend')
  assert.equal(r.capabilitySession.events > 0, true)
  assert.ok(r.capabilitySession.types.includes('line-message'))
  assert.ok(r.capabilitySession.maxMessageBytes <= 16 * 1024)
})

test('ExtractQueue: supplies work, UI JSON results become todos, malformed results are rejected, failures back off', async () => {
  const { run } = await getSetup()
  const e = run.result.extract
  assert.equal(e.systemChars > 1000, true)
  assert.match(e.systemSha, /^[0-9a-f]{64}$/)
  assert.ok(e.run.chatsSeen > 3 && e.run.chatsSkipped > 3, 'the run collected chats instead of extracting')
  assert.equal(e.run.todosCreated, 0)
  assert.equal(e.pulled, 6)
  assert.ok(e.itemChars.every((n) => n <= 7500), 'every item fits the ai:chat input budget')
  assert.equal(e.stats0.leased, 6)
  assert.deepEqual(e.commitGood, ['applied', 'applied', 'applied'])
  assert.equal(e.commitGoodRun.todosCreated, 3)
  assert.equal(e.todos.length, 3)
  assert.deepEqual(e.todos.map((t) => t.chatId).sort(), [...e.validChatIds].sort())
  e.todos.forEach((t) => assert.ok(e.sourceIdsOfValid.some((id) => t.sourceMsgIds.includes(id))))
  assert.equal(e.commitBad.status, 'rejected')
  assert.equal(e.commitBad.code, 'invalid_result')
  assert.ok(e.commitBad.issues.length > 0)
  assert.equal(e.commitFail.status, 'failed_recorded')
  assert.ok(e.commitFail.retryInMs >= 60_000)
  assert.equal(e.commitUnknown.status, 'unknown_item')
  for (const processed of e.processed.valid) assert.ok(processed.every((p) => p === true), 'committed chats are marked processed')
  assert.ok(e.processed.malformed.some((p) => p === false), 'a rejected result never marks messages processed')
  assert.ok(e.processed.failed.some((p) => p === false))
  assert.ok(e.todosChanged.some((t) => t.createdIds.length === 3), 'commit emitted todos-changed')
  assert.equal(e.statsAfter.chatsBackingOff, 2)
  const types = run.result.eventsAfterExtract
  assert.ok(types.types.includes('todos-changed') && types.types.includes('pipeline-run') && types.types.includes('extract-pending'))
})

test('unsupported paths answer in-band; unknown paths and methods are refused', async () => {
  const { run } = await getSetup()
  const x = run.result.refusals
  assert.equal(x.driver.code, 'unsupported_in_plugin')
  assert.equal(x.draft.route, 'ui_ai_chat')
  assert.equal(x.proto.code, 'path_unknown')
  assert.equal(x.ctor.code, 'path_unknown')
  assert.equal(x.unknown.code, 'path_unknown')
  assert.equal(x.badMethod.code, 'method_unknown')
})

test('deactivate: no DB connection, watcher, timer or other handle is left; the backend answers backend_stopped; the owner lock is released', async () => {
  const { run } = await getSetup()
  const r = run.result
  const before = r.diagnosticsBeforeDispose
  assert.equal(before.appDbOpen, true)
  assert.ok(before.lineEngine.openConnections >= 0)
  assert.ok(before.eventSessions >= 2, 'long-poll + capability sessions were open')
  const after = r.afterDispose
  assert.equal(after.diagnostics.disposed, true)
  assert.equal(after.diagnostics.appDbOpen, false, 'app DB connection closed')
  assert.deepEqual(after.diagnostics.lineEngine, { openConnections: 0, vfsOpenFiles: 0, vfsShmNodes: 0 }, 'WASM connections / VFS files closed')
  assert.equal(after.diagnostics.eventSessions, 0)
  assert.deepEqual(after.diagnostics.extract, { pending: 0, leased: 0, awaiting: 0 })
  assert.equal(after.call.code, 'backend_stopped')
  assert.equal(after.ownerLock, false)
  assert.deepEqual(after.lineEngineDir, [], 'no snapshot working directory left in dataDir')
  assert.ok(r.closingPoll.code === 'backend_stopped' || r.closingPoll.value?.closed === true, 'a long poll that was waiting during dispose is released')
  assert.ok(r.disposeMs < 3000, `dispose took ${r.disposeMs} ms`)
  // no leaked handle of any kind compared with the state before activate
  const leaked = Object.entries(r.resourcesEnd).filter(([kind, n]) => n > (r.resourcesBaseline[kind] ?? 0))
  assert.deepEqual(leaked, [], `leaked handles (baseline ${JSON.stringify(r.resourcesBaseline)}, end ${JSON.stringify(r.resourcesEnd)})`)
  assert.ok(!r.logs.some((l) => /error/i.test(l) && !/PERM|OPFS|opfs/i.test(l)), `unexpected error logs: ${r.logs.filter((l) => /error/i.test(l)).join(' | ')}`)
})

test('the backend bundle contains no child_process / worker_threads / better-sqlite3-multiple-ciphers / electron / provider code', async () => {
  const { run } = await getSetup()
  const { built } = run
  assert.deepEqual(built.analysis.problems, [])
  assert.equal(built.analysis.ok, true)
  for (const needle of ['child_process', 'worker_threads', 'better-sqlite3-multiple-ciphers']) {
    assert.equal(built.text.includes(needle), false, `bundle text must not mention ${needle}`)
  }
  assert.deepEqual(built.analysis.summary.externals.filter((p) => p !== 'koffi' && !p.startsWith('node:')).sort(), ['fs', 'path', 'util'], 'bare built-ins only from better-sqlite3 13 (fs/path/util)')
  assert.deepEqual(built.analysis.summary.moduleGroups.otherNodeModules, [])
  // the staged install dir, the vendor WASM and koffi do not mention them either
  const vendor = readFileSync(join(run.installDir, 'vendor', 'sqlite3mc-wasm', 'sqlite3.mjs'), 'utf8')
  assert.equal(/child_process|worker_threads/.test(vendor), false)
  assert.equal(existsSync(join(run.installDir, 'backend', 'native', 'win32-x64', 'better_sqlite3.node')), true)
})

test('the bundle analysis really flags forbidden content (guard is not vacuous)', () => {
  const metafile = {
    inputs: { 'src/plugin/backend/index.ts': {}, 'node_modules/better-sqlite3-plugin/lib/index.js': {}, 'src/plugin/backend/stubs/llmProvider.ts': {}, 'node_modules/better-sqlite3-multiple-ciphers/lib/util.js': {}, 'src/main/llm/cli/run.ts': {} },
    outputs: { 'out/index.mjs': { bytes: 10, imports: [{ path: 'koffi', external: true }, { path: 'node:child_process', external: true }, { path: 'node:worker_threads', external: true }] } },
  }
  const verdict = analyzeBundle({ text: 'import "node:child_process"; import("node:worker_threads"); const x = "better-sqlite3-multiple-ciphers"', metafile, outfile: 'out/index.mjs' })
  assert.equal(verdict.ok, false)
  const joined = verdict.problems.join('\n')
  for (const needle of ['child_process', 'worker_threads', 'better-sqlite3-multiple-ciphers', 'LLM CLI runner', 'unexpected external imports']) assert.ok(joined.includes(needle), needle)
})
