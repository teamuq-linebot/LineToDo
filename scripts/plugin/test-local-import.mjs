import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertSafeOutput,
  assertVersionIncrease,
  compareVersions,
  parseArgs as parseBuildArgs,
  parseVersion,
  readInstalledMetadata,
  PLUGIN_ID,
  AUTHORING_TOOL_CORE,
  TARGET_CORE,
  TARGET_PLATFORM,
} from './build-local-import.mjs'
import { assertApprovalBindings, parseArgs as parseSignArgs, runAfterApproval } from './sign-local-import.mjs'

test('strict three-part numeric versions accept 0.2.7 and reject prerelease labels', () => {
  assert.deepEqual(parseVersion('0.2.7'), [0, 2, 7])
  assert.equal(compareVersions('0.2.7', '0.2.6'), 1)
  assert.equal(assertVersionIncrease('0.2.7', '0.2.6'), true)
  assert.throws(() => parseVersion('0.2.4-dev.1'), /三段數字/u)
  assert.throws(() => parseVersion('0.2'), /三段數字/u)
  assert.throws(() => assertVersionIncrease('0.2.6', '0.2.6'), /嚴格高於/u)
  assert.throws(() => assertVersionIncrease('0.2.5', '0.2.6'), /嚴格高於/u)
})

test('first-install is explicit only when the plugin install root is absent; unknown source and ambiguous manifests are refused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'line-todo-install-state-'))
  try {
    const pluginRoot = path.join(root, 'tuqdev.line-todo')
    const missingPath = path.join(pluginRoot, 'manifest.json')
    assert.equal(readInstalledMetadata(missingPath).state, 'first-install')
    fs.mkdirSync(pluginRoot)
    assert.throws(() => readInstalledMetadata(missingPath), /拒絕假設 first-install/u)
    for (const version of ['0.2.6', '0.2.7']) {
      const dir = path.join(pluginRoot, version)
      fs.mkdirSync(dir)
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: PLUGIN_ID, version, trustTier: 'full-trust', permissions: [] }))
    }
    assert.throws(() => readInstalledMetadata(missingPath), /無法唯一識別/u)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('output paths require a safe absolute task-owned location', () => {
  const boundaries = { repo: 'C:\\teamuq\\teamuq-plugins\\line-todo', home: 'C:\\Users\\david', localAppData: 'C:\\Users\\david\\AppData\\Local' }
  assert.equal(assertSafeOutput('C:\\teamuq\\teamuq-plugins\\output\\local-import-run', boundaries), 'C:\\teamuq\\teamuq-plugins\\output\\local-import-run')
  assert.throws(() => assertSafeOutput('relative\\run', boundaries), /絕對路徑/u)
  assert.throws(() => assertSafeOutput('C:\\teamuq\\teamuq-plugins\\line-todo\\build\\run', boundaries), /source tree/u)
  assert.throws(() => assertSafeOutput('C:\\Users\\david\\Downloads\\run', boundaries), /profile/u)
  assert.throws(() => assertSafeOutput('C:\\Users\\david\\AppData\\Local\\TeamUQ\\run', { ...boundaries, home: 'C:\\Users\\other' }), /LocalAppData/u)
})

test('build caller keeps dry-run, validate-only, and prepare behavior distinct', () => {
  assert.equal(parseBuildArgs(['--dry-run', '--tool', 'C:\\tools\\tuq-plugin-tool.mjs']).dryRun, true)
  assert.equal(parseBuildArgs(['--validate-only', '--tool', 'C:\\tools\\tuq-plugin-tool.mjs']).validateOnly, true)
  assert.throws(() => parseBuildArgs(['--dry-run', '--validate-only']), /不可同時/u)
  assert.throws(() => parseBuildArgs(['--sign']), /未知參數/u)
})

test('sign caller requires an explicit safe mode and receipt for approved signing', () => {
  assert.equal(parseSignArgs(['--check', '--run-dir', 'C:\\teamuq\\teamuq-plugins\\output\\run']).mode, '--check')
  assert.throws(() => parseSignArgs(['--approved-sign', '--run-dir', 'C:\\teamuq\\teamuq-plugins\\output\\run']), /--approval/u)
  assert.throws(() => parseSignArgs(['--sign', '--run-dir', 'C:\\teamuq\\teamuq-plugins\\output\\run']), /未知簽章/u)
  assert.throws(() => parseSignArgs(['--check', '--approved-sign', '--run-dir', 'C:\\teamuq\\teamuq-plugins\\output\\run']), /只能指定/u)
})

test('approval must exactly match all fresh bindings', () => {
  const bindings = {
    task_id: 'line-todo-release-0.2.7-20261101',
    plugin_id: PLUGIN_ID,
    version: '0.2.7',
    installed_state: 'first-install',
    installed_version: null,
    platform: TARGET_PLATFORM,
    source_identity_sha256: 'a'.repeat(64),
    request_sha256: 'b'.repeat(64),
    wrapper_sha256: 'c'.repeat(64),
    devkit_sha256: 'd'.repeat(64),
    stage_index_sha256: 'e'.repeat(64),
    unsigned_archive_sha256: 'f'.repeat(64),
    unsigned_integrity_sha256: '1'.repeat(64),
    preflight_sha256: '2'.repeat(64),
    core_version: TARGET_CORE,
    devkit_built_from_core: AUTHORING_TOOL_CORE,
  }
  const receipt = { status: 'approved', reviewer: 'independent reviewer', approvedAt: '2026-10-30T05:00:00Z', bindings }
  assert.equal(assertApprovalBindings(receipt, bindings), receipt)
  assert.throws(() => assertApprovalBindings({ ...receipt, bindings: { ...bindings, unsigned_archive_sha256: '0'.repeat(64) } }, bindings), /不完全相符/u)
  assert.throws(() => assertApprovalBindings({ ...receipt, status: 'pending' }, bindings), /不是 approved/u)
})

test('stale approval is rejected before the private-action callback runs', async () => {
  const expected = { request_sha256: 'a'.repeat(64), unsigned_archive_sha256: 'b'.repeat(64) }
  let privateActionCalls = 0
  const stale = { status: 'approved', reviewer: 'fixture reviewer', approvedAt: '2026-10-30T05:00:00Z', bindings: { request_sha256: 'stale' } }
  await assert.rejects(runAfterApproval(stale, expected, async () => { privateActionCalls += 1 }))
  assert.equal(privateActionCalls, 0)
  const fresh = { ...stale, bindings: expected }
  await runAfterApproval(fresh, expected, async () => { privateActionCalls += 1 })
  assert.equal(privateActionCalls, 1)
})
