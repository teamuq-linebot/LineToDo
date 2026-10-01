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
//   * Phase 3 media (second run, scenario mode 'media'): an E2EE image in the fake LINE cache (outside dataDir, only koffi can read it) is decrypted by the
//     backend into dataDir/media-cache and is servable through the host's /data/<path> rules (what `assets.url()` points at); failures are in-band codes
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { analyzeBundle } from './build-backend.mjs'
import { runPluginContract } from '../lib/plugin-contract-harness.mjs'
import { ROOT, electronRunAsNode, findBsqliteMcDir, findElectron31, generateFixtures, makeTempRoot, rmQuiet } from '../lib/runtimes.mjs'

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
        // the boot self-reconcile (settings reconcile.enabled) has its own scenario below; here it would race the first import and add duplicate line-message events
        preseed: ({ dataDir }) => {
          writeFileSync(join(dataDir, '.linekey'), expected.key)
          writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ version: 1, reconcile: { enabled: false, scopeMonths: 0 } }))
        },
        scenario,
      })
      return { root, fixtureDir, linedir, expected, scenario, run }
    })()
  }
  return setup
}
let reconcileSetup = null
function getReconcileSetup() {
  if (!reconcileSetup) {
    reconcileSetup = (async () => {
      const root = makeTempRoot('plugin-contract-reconcile-')
      const fixtureDir = join(root, 'fixtures')
      const expected = generateFixtures(fixtureDir, { baseN: 900, walN: 120 })
      const linedir = join(root, 'linedir')
      mkdirSync(linedir, { recursive: true })
      copyFileSync(join(fixtureDir, 'wal', 'm.edb'), join(linedir, 'qw0f0f.edb'))
      // an empty app DB against a LINE DB with months of history: the default settings (reconcile.enabled=true) must fill the gaps by themselves
      const run = await runPluginContract({
        workRoot: join(root, 'run'),
        settings: { lineDbDir: linedir, linePollSec: 1, lineBatchLimit: 300 },
        preseed: ({ dataDir }) => writeFileSync(join(dataDir, '.linekey'), expected.key),
        scenario: { mode: 'reconcile', expected: { baseCount: expected.wal.baseOnly.messageCount } },
      })
      return { root, expected, run }
    })()
  }
  return reconcileSetup
}

let mediaSetup = null
function getMediaSetup() {
  if (!mediaSetup) {
    mediaSetup = (async () => {
      const root = makeTempRoot('plugin-contract-media-')
      const fixtureDir = join(root, 'fixtures')
      mkdirSync(fixtureDir, { recursive: true })
      const gen = electronRunAsNode(findElectron31(), [join(ROOT, 'scripts', 'lib', 'gen-line-media-fixture.cjs'), fixtureDir], { env: { BSQLITE3MC_DIR: findBsqliteMcDir() } })
      if (gen.status !== 0) throw new Error(`media fixture generator failed (exit ${gen.status}):
${gen.stderr}
${gen.stdout}`)
      const expected = JSON.parse(readFileSync(join(fixtureDir, 'expected.json'), 'utf8'))
      const cacheDir = join(fixtureDir, 'cache')
      const run = await runPluginContract({
        workRoot: join(root, 'run'),
        settings: { lineDbDir: join(fixtureDir, 'linedir'), lineCacheDir: cacheDir, linePollSec: 1, lineBatchLimit: 300 },
        preseed: ({ dataDir }) => writeFileSync(join(dataDir, '.linekey'), expected.key),
        scenario: { mode: 'media', cacheDir, expected },
      })
      return { root, expected, run, cacheDir }
    })()
  }
  return mediaSetup
}
test.after(async () => {
  if (setup) rmQuiet((await setup).root)
  if (mediaSetup) rmQuiet((await mediaSetup).root)
  if (reconcileSetup) rmQuiet((await reconcileSetup).root)
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

test('AI relay (Phase 4) under the real permission model: core draftReply -> relay provider -> ai.pull / ai.commit; extract.system carries the output format; bad kinds are refused', async () => {
  const { run } = await getSetup()
  const a = run.result.aiRelay
  assert.deepEqual(a.systemFormat, { isString: true, mentionsSchema: true, chars: a.systemFormat.chars })
  assert.ok(a.systemFormat.chars > 500)
  assert.deepEqual({ kind: a.task.kind, expectJson: a.task.expectJson, draftPrompt: a.task.draftPrompt, userMentionsTodo: a.task.userMentionsTodo }, { kind: 'draftReply', expectJson: false, draftPrompt: true, userMentionsTodo: true })
  assert.ok(a.task.userChars > 20 && a.task.userChars <= 7500)
  assert.equal(a.commit, 'accepted')
  assert.deepEqual(a.result, { ok: true, value: { draft: '好的，我今天處理。' } })
  assert.deepEqual(a.badKind, { ok: false, code: 'invalid_args' })
  assert.deepEqual(a.stats, { pending: 0, leased: 0, consumerActive: true })
})

test('review tracking (Phase 4 repair) in the production bundle under the real permission model: review.status answers, an empty-window review completes and is single-flight bookkeeping-clean', async () => {
  const { run } = await getSetup()
  const r = run.result.reviewStatus
  assert.deepEqual(r.idle, { state: 'idle', running: false, resumable: 0 })
  assert.equal(r.empty.ok, true)
  assert.equal(r.empty.resultOk, true)
  assert.equal(r.empty.chatsSeen, 0)
  assert.deepEqual(r.after, { state: 'done', running: false })
  assert.equal(r.info, 'done')
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

// ───────────── Phase 3: media under the real 1.6.8 permission model ─────────────

test('media: under Electron 44 + 1.6.8 flags the backend decrypts a LINE-cache image that Node fs cannot see (koffi only) into dataDir/media-cache; the host /data/<path> rules serve it; self-check stays green', async () => {
  const { run, expected, cacheDir } = await getMediaSetup()
  assert.equal(run.exitCode, 0, `exit code (stderr: ${run.stderr.slice(0, 800)})`)
  const r = run.result
  assert.ok(r, `RESULT present (stdout: ${run.stdout.slice(0, 800)})`)
  assert.equal(r.fatal, undefined, r.fatal)
  assert.equal(r.runtime.electron, '44.2.0')
  assertSelfCheckPassed('boot', r.selfCheckBoot)
  assertSelfCheckPassed('afterActivate', r.selfCheckAfterActivate)
  assertSelfCheckPassed('end', r.selfCheckEnd)
  const m = r.media
  assert.equal(m.importedCount, expected.messageCount, 'the fake LINE DB (with media rows) was imported')
  assert.equal(m.nodeFsOnLineCache, 'ERR_ACCESS_DENIED', 'the 1.6.8 permission model hides the LINE Cache from Node fs: the backend can only reach it through koffi')
  assert.ok(cacheDir && !cacheDir.startsWith(run.dataDir), 'the LINE cache is outside dataDir')

  const served = []
  for (const [name, ext, mime] of [['png', 'png', 'image/png'], ['jpeg', 'jpg', 'image/jpeg'], ['gif', 'gif', 'image/gif']]) {
    const entry = m.results[name]
    const want = expected.messages[name]
    assert.equal(entry.first.ok, true, `${name}: ${JSON.stringify(entry.first)}`)
    assert.equal(entry.first.value.cached, false)
    assert.equal(entry.first.value.mime, mime)
    assert.equal(entry.first.value.size, want.size)
    assert.match(entry.first.value.path, new RegExp(`^media-cache/[0-9a-f]{32}\.${ext}$`))
    assert.equal(entry.second.value.cached, true, 'second request is served from the cache')
    assert.equal(entry.second.value.path, entry.first.value.path)
    // what the host's /data/<path> file service would answer for assets.url(path): 200 with the right type and exactly the plaintext
    assert.deepEqual(entry.served, { status: 200, type: mime, size: want.size, sha256: want.sha256 }, `${name}: served bytes are the decrypted plaintext`)
    assert.equal(entry.servedUrl, `tuqplugin://tuqdev.line-todo/data/${entry.first.value.path}`)
    served.push(entry.first.value.path.split('/').pop())
  }
  assert.deepEqual(m.cacheDirListing, [...served].sort(), 'only the three decryptable images are in dataDir/media-cache (no temp files)')
  assert.equal(m.info.written, 3)
  assert.equal(m.info.cacheFiles, 3)
})

test('media: undownloaded, wrong-key and non-image files are in-band failures; open/saveAs stay unsupported; the data service refuses hidden, dotted and directory paths', async () => {
  const { run } = await getMediaSetup()
  const m = run.result.media
  assert.equal(m.results.notcached.first.code, 'not_cached')
  assert.equal(m.results.wrongkey.first.code, 'hmac_miss', 'a same-size candidate that fails the HMAC is never used')
  assert.equal(m.results.text.first.code, 'unsupported_format')
  assert.equal(m.unsupported.open.code, 'unsupported_in_plugin')
  assert.equal(m.unsupported.saveAs.code, 'unsupported_in_plugin')
  for (const t of m.traversal) assert.ok(t.status === 403, `${t.path} is refused by the host data service rules (${JSON.stringify(t)})`)
})

test('media: dispose after the media run leaves no handle, no snapshot directory and no lock (the media path adds no timers or watchers)', async () => {
  const { run } = await getMediaSetup()
  const r = run.result
  assert.equal(r.afterDispose.diagnostics.disposed, true)
  assert.equal(r.afterDispose.diagnostics.appDbOpen, false)
  assert.deepEqual(r.afterDispose.diagnostics.lineEngine, { openConnections: 0, vfsOpenFiles: 0, vfsShmNodes: 0 })
  assert.equal(r.afterDispose.ownerLock, false)
  assert.deepEqual(r.afterDispose.lineEngineDir, [])
  const leaked = Object.entries(r.resourcesEnd).filter(([kind, n]) => n > (r.resourcesBaseline[kind] ?? 0))
  assert.deepEqual(leaked, [], `leaked handles (baseline ${JSON.stringify(r.resourcesBaseline)}, end ${JSON.stringify(r.resourcesEnd)})`)
})

// ───────────── Phase 3: boot self-reconcile under the real permission model ─────────────

test('reconcile: with the default settings the backend fills the months its first import missed through the real WASM engine + koffi fs without duplicating rows, advances its checkpoint in dataDir, and releases its lock', async () => {
  const { run, expected } = await getReconcileSetup()
  assert.equal(run.exitCode, 0, `exit code (stderr: ${run.stderr.slice(0, 800)})`)
  const r = run.result
  assert.ok(r, `RESULT present (stdout: ${run.stdout.slice(0, 800)})`)
  assert.equal(r.fatal, undefined, r.fatal)
  assertSelfCheckPassed('boot', r.selfCheckBoot)
  assertSelfCheckPassed('afterActivate', r.selfCheckAfterActivate)
  assertSelfCheckPassed('end', r.selfCheckEnd)
  const c = r.reconcile
  // progress events are best effort in this scenario: the first import emits 904 line-message events (> the 512-event ring), so early progress events
  // may have rolled out (the hub says gap:true and the UI resyncs). Whatever is still in the ring must be a healthy run; the exact phase order is a unit test.
  assert.ok(c.phases.every((p) => ['scanning', 'backfilling', 'done'].includes(p.phase)), `progress phases: ${JSON.stringify(c.phases)}`)
  if (c.phases.some((p) => p.phase === 'done')) assert.equal(c.phases.at(-1).done, c.phases.at(-1).total)
  assert.ok(c.log.some((l) => /gaps=[1-9]\d* backfilling=\d+ remainder=false/.test(l)), `a gap was found and backfilled: ${c.log.join(' | ')}`)
  assert.equal(c.finalCount, expected.wal.baseOnly.messageCount)
  assert.equal(c.listed, c.distinctMsgIds, 'the watcher import and the reconcile backfill overlapped without creating a duplicate row')
  assert.ok(c.log.some((l) => /checkpoint advanced/.test(l)), `log: ${c.log.join(' | ')}`)
  assert.ok(c.log.some((l) => /backfilled inserted=\d+/.test(l)))
  assert.ok(c.dataDir.includes('reconcile-state.json') && c.state && c.state.last_ts > 0, 'the checkpoint file lives in dataDir')
  assert.equal(c.lockPresent, false, 'single-flight lock released')
  assert.equal(c.status.lastError, null)
  const leaked = Object.entries(r.resourcesEnd).filter(([kind, n]) => n > (r.resourcesBaseline[kind] ?? 0))
  assert.deepEqual(leaked, [], 'no handle left after dispose')
})
