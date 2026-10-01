// Verbatim-faithful port of the two TeamUQ 1.6.8 backend-isolation primitives, copied from
// teamuq-electron @ b8b96cb3 (= 1.6.8 release; code tree 7d34947e5). TS -> ESM JS with no
// behavioural change. Source of truth:
//   - buildBackendPermissionFlags / launchPath:
//       packages/platform/plugin-runtime/src/main/externalBackend/backendLaunch.ts:34-63
//   - runPermissionSelfCheck / SELF_CHECK_FAILURE_CODES:
//       apps/plugin-host/src/external/selfCheck.ts:8-128
// The real host (external/index.ts:98-110) calls runPermissionSelfCheck(init) at boot and
// refuses to start when report.ok is false. The real launcher (backendLaunch.ts:127-133,
// spawnRunAsNodeBackend:155) spawns the Electron binary as Node (ELECTRON_RUN_AS_NODE=1) with
// nodeArgs = buildBackendPermissionFlags(...). This module reproduces both exactly.
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as workerThreads from 'node:worker_threads'

// --- backendLaunch.ts ---

const FORBIDDEN_PATH_CHARACTERS = /[\u0000-\u001f\u007f",]/u

function launchPath(value, windows) {
  if (!path.isAbsolute(value)) throw new Error('backend_path_unsupported: a launch path is not absolute')
  if (FORBIDDEN_PATH_CHARACTERS.test(value)) throw new Error('backend_path_unsupported: forbidden character')
  if (!windows && value.includes('\\')) throw new Error('backend_path_unsupported: a launch path contains a backslash')
  const resolved = windows ? path.win32.resolve(value) : path.posix.resolve(value)
  return windows ? resolved.split('\\').join('/') : resolved
}

export function buildBackendPermissionFlags(input, windows = process.platform === 'win32') {
  const readable = new Set()
  for (const candidate of [input.bootstrapFile, input.installDir, input.dataDir, ...input.assetDirs]) readable.add(launchPath(candidate, windows))
  const flags = ['--permission']
  for (const target of readable) flags.push(`--allow-fs-read=${target}`)
  flags.push(`--allow-fs-write=${launchPath(input.dataDir, windows)}`)
  if (input.allowAddons) flags.push('--allow-addons')
  return flags
}

// --- selfCheck.ts ---

export const SELF_CHECK_FAILURE_CODES = Object.freeze([
  'permission_model_inactive',
  'read_scope_wrong',
  'write_scope_wrong',
  'child_process_allowed',
  'worker_allowed',
  'addon_flag_mismatch',
  'write_outside_allowed',
  'read_outside_allowed',
  'data_dir_not_writable',
  'self_check_error',
])

const DENIED = 'ERR_ACCESS_DENIED'

function codeOf(error) {
  return error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'unknown'
}

export function runPermissionSelfCheck(init, host = process) {
  const probes = {}
  let failure = null
  const expect = (name, passed, code) => {
    probes[name] = passed ? 'ok' : 'fail'
    if (!passed && failure === null) failure = code
  }
  const finish = () => ({ ok: failure === null, code: failure, allowAddons: init.allowAddons, probes })

  const permission = host.permission
  if (permission === undefined || permission === null || typeof permission.has !== 'function') {
    probes['permission'] = 'absent'
    failure = 'permission_model_inactive'
    return finish()
  }
  probes['permission'] = 'active'
  try {
    const assetDirs = Object.values(init.assetPacks)
    expect('scope_read', [init.installDir, init.dataDir, ...assetDirs].every((target) => permission.has('fs.read', target)), 'read_scope_wrong')
    expect('scope_read_home', !permission.has('fs.read', os.homedir()) && !permission.has('fs.read', os.tmpdir()), 'read_scope_wrong')
    expect('scope_write_data', permission.has('fs.write', init.dataDir), 'write_scope_wrong')
    expect('scope_write_narrow', !permission.has('fs.write', init.installDir) && !permission.has('fs.write', os.tmpdir()) && !permission.has('fs.write', os.homedir()), 'write_scope_wrong')
    expect('scope_child', !permission.has('child'), 'child_process_allowed')
    expect('scope_worker', !permission.has('worker'), 'worker_allowed')
    probes['scope_addon_reported'] = String(permission.has('addon'))

    const outside = path.join(os.tmpdir(), `.teamuq-ext-probe-${host.pid}`)
    try {
      fs.writeFileSync(outside, '')
      try { fs.unlinkSync(outside) } catch {}
      probes['write_outside'] = 'allowed'
      if (failure === null) failure = 'write_outside_allowed'
    } catch (error) {
      expect('write_outside', codeOf(error) === DENIED, 'write_outside_allowed')
    }
    try {
      fs.readFileSync(path.join(os.homedir(), '.teamuq-ext-probe-missing'))
      probes['read_outside'] = 'allowed'
      if (failure === null) failure = 'read_outside_allowed'
    } catch (error) {
      expect('read_outside', codeOf(error) === DENIED, 'read_outside_allowed')
    }
    try {
      const child = childProcess.spawn('teamuq-ext-probe-missing-command', [], { stdio: 'ignore' })
      child.on('error', () => undefined)
      probes['child_process'] = 'allowed'
      if (failure === null) failure = 'child_process_allowed'
    } catch (error) {
      expect('child_process', codeOf(error) === DENIED, 'child_process_allowed')
    }
    try {
      const worker = new workerThreads.Worker(path.join(os.tmpdir(), 'teamuq-ext-probe-missing.js'))
      worker.on('error', () => undefined)
      void worker.terminate()
      probes['worker_threads'] = 'allowed'
      if (failure === null) failure = 'worker_allowed'
    } catch (error) {
      expect('worker_threads', codeOf(error) === DENIED, 'worker_allowed')
    }
    try {
      host.dlopen({ exports: {} }, path.join(init.dataDir, 'teamuq-ext-probe-missing.node'))
      probes['addon'] = 'loaded'
      if (failure === null) failure = 'addon_flag_mismatch'
    } catch (error) {
      const code = codeOf(error)
      probes['addon_code'] = code
      expect('addon', init.allowAddons ? code !== 'ERR_DLOPEN_DISABLED' && code !== DENIED : code === 'ERR_DLOPEN_DISABLED', 'addon_flag_mismatch')
    }
    const marker = path.join(init.dataDir, '.teamuq-ext-probe')
    try {
      fs.writeFileSync(marker, '')
      fs.unlinkSync(marker)
      probes['data_write'] = 'ok'
    } catch {
      probes['data_write'] = 'fail'
      if (failure === null) failure = 'data_dir_not_writable'
    }
  } catch {
    failure = failure ?? 'self_check_error'
  }
  return finish()
}
