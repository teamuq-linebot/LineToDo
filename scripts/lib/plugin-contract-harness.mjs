// Stages the plugin the way the .tuqplugin installer will lay it out and runs it under the TeamUQ 1.6.8 backend contract:
//   Electron 44.2.0 as Node (ELECTRON_RUN_AS_NODE=1, 1.6.8 env allowlist) + buildBackendPermissionFlags() (verbatim backendLaunch.ts)
//   with allowAddons=true and the host bootstrap OUTSIDE installDir.
//
//   <stage>/install/package.json
//   <stage>/install/backend/index.mjs                                   <- the production backend bundle (scripts/plugin/build-backend.mjs)
//   <stage>/install/backend/native/win32-x64/better_sqlite3.node        <- better-sqlite3 13.0.2 prebuild (kind:'native')
//   <stage>/install/vendor/sqlite3mc-wasm/{sqlite3.mjs,sqlite3.wasm}    <- kind:'code'
//   <stage>/install/node_modules/{koffi,@koromix/koffi-win32-x64}       <- koffi (Phase 5 replaces this with the addon shim)
//   <stage>/host/host-bootstrap.mjs                                     <- scripts/lib/plugin-host-standin.mjs, bundled
//   <stage>/data                                                        <- dataDir
import { copyFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildBackendBundle } from '../plugin/build-backend.mjs'
import { ROOT, WASM_DIR, bundle, electronRunAsNode, findElectron44 } from './runtimes.mjs'
import { buildBackendPermissionFlags } from './teamuq-contract.mjs'

export async function stagePlugin(stageDir) {
  const installDir = join(stageDir, 'install')
  mkdirSync(join(installDir, 'backend', 'native', 'win32-x64'), { recursive: true })
  mkdirSync(join(installDir, 'vendor', 'sqlite3mc-wasm'), { recursive: true })
  for (const f of ['sqlite3.mjs', 'sqlite3.wasm']) copyFileSync(join(WASM_DIR, f), join(installDir, 'vendor', 'sqlite3mc-wasm', f))
  const bsqlite = join(ROOT, 'node_modules', 'better-sqlite3-plugin', 'prebuilds', 'win32-x64.node')
  if (!existsSync(bsqlite)) throw new Error(`better-sqlite3 13.0.2 prebuild missing: ${bsqlite} (run npm ci --ignore-scripts)`)
  copyFileSync(bsqlite, join(installDir, 'backend', 'native', 'win32-x64', 'better_sqlite3.node'))
  for (const pkg of ['koffi', join('@koromix', 'koffi-win32-x64')]) {
    const from = join(ROOT, 'node_modules', pkg)
    if (!existsSync(from)) throw new Error(`koffi package missing: ${from} (run npm ci --ignore-scripts)`)
    cpSync(from, join(installDir, 'node_modules', pkg), { recursive: true })
  }
  writeFileSync(join(installDir, 'package.json'), '{"name":"line-todo-contract-stage","private":true}\n')
  const built = await buildBackendBundle({ outfile: join(installDir, 'backend', 'index.mjs') })
  return { installDir, built }
}

/**
 * `stage(workRoot)` -> { installDir, built } lays out the install directory. The default is the test stage above (bundle + staged koffi package);
 * Phase 5's test-plugin-package.mjs passes a stage that UNPACKS THE SIGNED .tuqplugin instead, so the shipped bytes themselves run under the 1.6.8 contract.
 */
export async function runPluginContract({ workRoot, lineLocation, preseed, scenario, timeoutMs = 240_000, stage = stagePlugin }) {
  const exe = findElectron44()
  const { installDir, built } = await stage(workRoot)
  const dataDir = join(workRoot, 'data')
  const hostDir = join(workRoot, 'host')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(hostDir, { recursive: true })
  if (preseed) preseed({ dataDir })
  const bootstrapFile = join(hostDir, 'host-bootstrap.mjs')
  await bundle({ entry: join(ROOT, 'scripts', 'lib', 'plugin-host-standin.mjs'), outfile: bootstrapFile, format: 'esm', target: 'node24' })
  const init = {
    version: 1, pluginId: 'tuqdev.line-todo', installDir, dataDir, entry: join(installDir, 'backend', 'index.mjs'),
    // lineLocation: the fake LINE folder for the bundle's test entry activateAt (G-06: nothing goes through context.settings any more)
    assetPacks: {}, allowAddons: true, corePackaged: true, ...(lineLocation ? { lineLocation } : {}),
  }
  const flags = buildBackendPermissionFlags({ bootstrapFile, installDir, dataDir, assetDirs: [], allowAddons: true })
  const args = [bootstrapFile, Buffer.from(JSON.stringify(init)).toString('base64url'), Buffer.from(JSON.stringify(scenario)).toString('base64url')]
  const r = electronRunAsNode(exe, args, { flags, cwd: dataDir, timeout: timeoutMs })
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT:'))
  let result = null
  if (line) {
    try { result = JSON.parse(line.slice('RESULT:'.length)) } catch (e) { result = { parseError: String(e) } }
  }
  return {
    exitCode: r.status, signal: r.signal, result, stdout: r.stdout || '', stderr: r.stderr || '', flags, exe, installDir, dataDir, built,
    command: `ELECTRON_RUN_AS_NODE=1 "${exe}" ${[...flags, bootstrapFile, '<base64url init>', '<base64url scenario>'].join(' ')}`,
  }
}
