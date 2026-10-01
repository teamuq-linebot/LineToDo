// Phase 1 — the WASM LINE DB engine inside the TeamUQ 1.6.8 backend contract.
//
// Launches a plugin-backend stand-in the way the 1.6.8 host does: Electron 44.2.0 as Node (ELECTRON_RUN_AS_NODE=1, env
// allowlist) with buildBackendPermissionFlags() — `--permission --allow-fs-read=<bootstrap,installDir,dataDir>
// --allow-fs-write=<dataDir> --allow-addons` — and a host bootstrap outside installDir. Inside it:
//   * the host's runPermissionSelfCheck (verbatim selfCheck.ts) must pass before the engine loads, after koffi + WASM are
//     loaded, and at the end;
//   * Node fs must be unable to see the fixtures (so only koffi can copy the snapshot into dataDir);
//   * the production linedb suite runs through Win32LineFsPort (koffi) + the WASM engine + read-only node:fs VFS, over
//     synthetic encrypted fixtures that live OUTSIDE dataDir, and must equal the standalone (Electron 31) reference.
// Both int64 modes are exercised. Needs Electron 44 and Electron 31 (see scripts/lib/runtimes.mjs).
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { runE44Contract } from './lib/e44-harness.mjs'
import { diffSuites } from './lib/compare.mjs'
import { generateFixtures, makeTempRoot, rmQuiet, runStandaloneReference } from './lib/runtimes.mjs'

let setup = null
function getSetup() {
  if (!setup) {
    setup = (async () => {
      const root = makeTempRoot('wasm-contract-')
      const fixtureDir = join(root, 'fixtures')
      const expected = generateFixtures(fixtureDir)
      const linedir = join(root, 'linedir')
      mkdirSync(linedir, { recursive: true })
      for (const ext of ['', '-wal', '-shm']) copyFileSync(join(fixtureDir, 'wal', 'm.edb' + ext), join(linedir, 'qw0f0f.edb' + ext))
      writeFileSync(join(linedir, 'qw0f0f_sibling.edb'), Buffer.alloc(8))
      const reference = await runStandaloneReference({ fixtureDir, expected, workDir: root })
      return { root, fixtureDir, linedir, expected, reference }
    })()
  }
  return setup
}
test.after(async () => {
  if (setup) rmQuiet((await setup).root)
})

const runs = new Map()
async function runContract(int64) {
  if (!runs.has(int64)) {
    runs.set(
      int64,
      (async () => {
        const s = await getSetup()
        const workRoot = join(s.root, `e44-${int64}`)
        mkdirSync(workRoot, { recursive: true })
        return runE44Contract({ workRoot, fixtureDir: s.fixtureDir, linedir: s.linedir, expected: s.expected, int64 })
      })(),
    )
  }
  return runs.get(int64)
}

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

for (const int64 of ['exact', 'legacy-number']) {
  test(`Electron 44.2.0 + 1.6.8 backend flags (int64=${int64}): backend loads koffi + WASM engine, all self-checks pass, linedb suite equals standalone`, async () => {
    const { fixtureDir, expected, reference } = await getSetup()
    const r = await runContract(int64)
    assert.equal(r.exitCode, 0, `backend exit code (stderr: ${r.stderr.slice(0, 600)})`)
    assert.ok(r.result, `RESULT line present (stdout: ${r.stdout.slice(0, 600)})`)
    assert.equal(r.result.fatal, undefined, r.result.fatal)

    // runtime + launch contract
    assert.equal(r.result.runtime.electron, '44.2.0')
    assert.equal(r.result.runtime.abi, '149')
    assert.match(r.result.runtime.node, /^v24\./)
    assert.equal(r.flags[0], '--permission')
    assert.ok(r.flags.includes('--allow-addons'))
    assert.ok(r.flags.some((f) => f === `--allow-fs-write=${r.dataDir.replace(/\\/g, '/')}`))
    assert.ok(!r.flags.some((f) => /allow-child-process|allow-worker/.test(f)), 'no child/worker allowance')
    assert.deepEqual(r.result.argvFlags, r.flags, 'the backend really ran with exactly these flags')

    // self-checks: boot, after koffi + WASM are loaded, end
    assertSelfCheckPassed('boot', r.result.selfCheckBoot)
    assertSelfCheckPassed('afterEngine', r.result.selfCheckAfterEngine)
    assertSelfCheckPassed('end', r.result.selfCheckEnd)

    // engine
    assert.equal(r.result.engine.name, 'sqlite3mc-wasm+nodefs-ro-vfs')
    assert.match(r.result.engine.info.sqlite3mc, /2\.5\.1/)
    assert.equal(r.result.engine.int64, int64)
    assert.ok(r.result.engine.initWarnings.every((w) => /opfs/i.test(w)), 'only the known OPFS-unavailable notes')

    // isolation controls: Node fs cannot see the fixtures; the VFS (Node fs) cannot open them; koffi can
    for (const c of ['nodeFsReadOutside', 'nodeFsListOutside', 'nodeFsWriteOutside']) {
      assert.equal(r.result.controls[c].denied, true, c)
      assert.equal(r.result.controls[c].code, 'ERR_ACCESS_DENIED', c)
    }
    assert.equal(r.result.controls.vfsDirectOpenOutside.denied, true)
    assert.equal(r.result.controls.koffiSeesFixture, true)
    assert.equal(existsSync(join(fixtureDir, 'should-not-exist.txt')), false)

    // query results: equal to the standalone reference and to the writer
    assert.deepEqual(diffSuites(reference, r.result.suite, { int64Mode: int64 }), [])
    for (const kind of ['wal', 'rollback']) {
      assert.equal(r.result.suite.variants[kind].messageDigest.value, expected[kind].messageDigest, `${kind} digest == writer`)
      assert.equal(r.result.suite.variants[kind].messageCount.value, expected[kind].messageCount)
    }
    for (const kind of ['wal', 'rollback', 'int64']) {
      assert.equal(r.result.suite.wrongKey[kind].value, JSON.stringify({ error: 'decryption failed — wrong key or cipher params' }), `${kind} wrong key`)
    }
    if (int64 === 'exact') {
      assert.deepEqual(r.result.suite.variants.int64.int64MsgIds.value.msgIds.map(String), expected.int64.exactIds)
      assert.equal(r.result.suite.variants.int64.int64MsgIds.value.bigint, false, 'no BigInt escapes linedb')
    } else {
      assert.deepEqual(r.result.suite.variants.int64.int64MsgIds.value.msgIds.map(String), expected.int64.legacyKeys)
    }

    // koffi findDb -> copy -> WASM with no explicit path
    assert.equal(r.result.findDb.replace(/\\/g, '/').split('/').pop(), 'qw0f0f.edb')
    assert.equal(r.result.viaFindDb.count, expected.wal.messageCount)

    // read-only, leak-free
    assert.equal(r.result.leaks.openConnections, 0)
    assert.equal(r.result.leaks.vfsOpenFiles, 0)
    assert.equal(r.result.leaks.vfsShmNodes, 0)
    assert.deepEqual(r.result.leaks.workspaceEntries, [], 'snapshot temp dirs cleaned up')
    assert.equal(r.result.leaks.vfsStats.rejectedWrites, 0)
    assert.ok(r.result.leaks.vfsStats.reads > 100)

    // stderr carries only Node's own --allow-addons notice
    const noisy = r.stderr.split('\n').filter((l) => l.trim() && !/PERM0001|trace-warnings|--allow-addons/.test(l))
    assert.deepEqual(noisy, [], 'no unexpected stderr output')
  })
}

test('the contract harness is the verbatim 1.6.8 launch contract (drift guard against the TeamUQ source when it is available)', () => {
  const src = 'C:/teamuq/teamuq-electron/packages/platform/plugin-runtime/src/main/externalBackend/backendLaunch.ts'
  if (!existsSync(src)) return // TeamUQ checkout not present on this machine: the copied contract is still what ran above
  const text = readFileSync(src, 'utf8')
  for (const fragment of ["'--permission'", '--allow-fs-read=', '--allow-fs-write=', '--allow-addons']) assert.ok(text.includes(fragment), fragment)
  assert.ok(!text.includes('--allow-child-process'), 'the 1.6.8 host does not grant child_process')
})
