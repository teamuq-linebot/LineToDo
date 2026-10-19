// Launches the plugin-backend stand-in (e44-backend-child.mjs) under the TeamUQ 1.6.8 backend contract:
//   Electron 44.2.0 as Node (ELECTRON_RUN_AS_NODE=1, 1.6.8 env allowlist) + buildBackendPermissionFlags()
//   (verbatim copy of backendLaunch.ts) with allowAddons=true, host bootstrap OUTSIDE installDir.
// Stages an installDir the way the plugin package will look: backend/index.mjs (esbuild bundle),
// vendor/sqlite3mc-wasm/{sqlite3.mjs,sqlite3.wasm} (kind:'code'), and koffi (kind:'native', Phase 5 swaps in the shim).
import { copyFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, WASM_DIR, bundle, electronRunAsNode, findElectron44 } from './runtimes.mjs'
import { buildBackendPermissionFlags } from './teamuq-contract.mjs'

/** Build the plugin install stage under `stageDir`. Returns installDir. */
export async function stageInstallDir(stageDir) {
  const installDir = join(stageDir, 'install')
  mkdirSync(join(installDir, 'backend'), { recursive: true })
  mkdirSync(join(installDir, 'vendor', 'sqlite3mc-wasm'), { recursive: true })
  for (const f of ['sqlite3.mjs', 'sqlite3.wasm']) copyFileSync(join(WASM_DIR, f), join(installDir, 'vendor', 'sqlite3mc-wasm', f))
  for (const pkg of ['koffi', join('@koromix', 'koffi-win32-x64')]) {
    const from = join(ROOT, 'node_modules', pkg)
    if (!existsSync(from)) throw new Error(`koffi package missing: ${from} (run npm ci --ignore-scripts)`)
    cpSync(from, join(installDir, 'node_modules', pkg), { recursive: true })
  }
  writeFileSync(join(installDir, 'package.json'), '{"name":"line-todo-e44-contract-stage","private":true}\n')
  await bundle({
    entry: join(ROOT, 'scripts', 'lib', 'e44-backend-child.mjs'),
    outfile: join(installDir, 'backend', 'index.mjs'),
    format: 'esm',
    target: 'node24',
    // koffi is loaded from the stage's node_modules by explicit path (loadKoffi), never bundled.
    external: ['koffi'],
    alias: { 'better-sqlite3-multiple-ciphers': join(ROOT, 'scripts', 'lib', 'stub-bsqlite.mjs') },
  })
  return installDir
}

/** Run the stage under the 1.6.8 contract. Returns { exitCode, result, stdout, stderr, flags, command }. */
export async function runE44Contract({ workRoot, fixtureDir, linedir, expected, int64 = 'exact', experimentalFlag = false }) {
  const exe = findElectron44()
  const installDir = await stageInstallDir(workRoot)
  const dataDir = join(workRoot, 'data')
  const hostDir = join(workRoot, 'host')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(hostDir, { recursive: true })
  const bootstrapFile = join(hostDir, 'host-bootstrap.mjs')
  writeFileSync(bootstrapFile, `await import(${JSON.stringify(pathToFileURL(join(installDir, 'backend', 'index.mjs')).href)})\n`)

  const init = { version: 1, pluginId: 'tuqdev.line-todo-phase1-test', installDir, dataDir, entry: bootstrapFile, assetPacks: {}, allowAddons: true, corePackaged: true }
  let flags = buildBackendPermissionFlags({ bootstrapFile, installDir, dataDir, assetDirs: [], allowAddons: true })
  if (experimentalFlag) flags = flags.map((f) => (f === '--permission' ? '--experimental-permission' : f))
  const cfg = { fixtureDir, linedir, expected, int64 }
  const args = [bootstrapFile, Buffer.from(JSON.stringify(init)).toString('base64url'), Buffer.from(JSON.stringify(cfg)).toString('base64url')]
  const r = electronRunAsNode(exe, args, { flags, cwd: dataDir })
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT:'))
  let result = null
  if (line) {
    try { result = JSON.parse(line.slice('RESULT:'.length)) } catch (e) { result = { parseError: String(e) } }
  }
  return {
    exitCode: r.status,
    signal: r.signal,
    result,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    flags,
    exe,
    installDir,
    dataDir,
    command: `ELECTRON_RUN_AS_NODE=1 "${exe}" ${[...flags, bootstrapFile, '<base64url init>', '<base64url cfg>'].join(' ')}`,
  }
}
