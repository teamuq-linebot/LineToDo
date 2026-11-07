// Builds the development link folder (dist/dev-link) for TeamUQ「從資料夾連結」, from the same bundle and manifest as the package.
//
//   node scripts/plugin/build-dev-link.mjs            build once (npm run dev:plugin)
//   node scripts/plugin/build-dev-link.mjs --watch    build once, then rebuild on every save of a watched source (npm run dev:plugin:watch)
//
// The folder is updated in place (lib/devLink.mjs): unchanged files are not rewritten, a native .node that is locked by a running backend stops the build
// with a plain message, and only files this build wrote before (and no longer writes) are removed. The manifest is the package manifest (id tuqdev.line-todo).
// Watched (--watch): src/plugin and src/shared (UI, backend, notices, shared types), vendor/sqlite3mc-wasm, scripts/plugin/lib, and the three bundle
// scripts build-ui.mjs / build-backend.mjs / build-plugin.mjs. dist/ is never watched, so the build's own writes cannot loop.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectPackageFiles } from './build-plugin.mjs'
import { DEV_LINK_DIR, DEV_LINK_STATE, DEV_LINK_WORK, DevLinkLockedError, devLinkFiles, syncDevLink } from './lib/devLink.mjs'
import { PLUGIN_ID, buildManifest, resolveResidentOption } from './lib/manifest.mjs'
import { ROOT } from './lib/paths.mjs'
import { parseArgs } from './lib/pack.mjs'

const WATCHED = Object.freeze([
  { dir: path.join(ROOT, 'src', 'plugin'), recursive: true },
  { dir: path.join(ROOT, 'src', 'shared'), recursive: true },
  { dir: path.join(ROOT, 'vendor', 'sqlite3mc-wasm'), recursive: true },
  { dir: path.join(ROOT, 'scripts', 'plugin', 'lib'), recursive: true },
  { dir: path.join(ROOT, 'scripts', 'plugin'), recursive: false, match: /^build-(?:ui|backend|plugin)\.mjs$/ },
])

/** One build: returns the sync report plus the manifest id and the file list it produced. */
export async function buildDevLink({ dir = DEV_LINK_DIR, stateFile = DEV_LINK_STATE, workDir = DEV_LINK_WORK, resident = resolveResidentOption({}) } = {}) {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  const { files } = await collectPackageFiles({ workDir })
  const manifest = buildManifest({ version, resident })
  const outputs = devLinkFiles({ manifest, files })
  let report
  try {
    report = syncDevLink({ dir, stateFile, files: outputs })
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
  return { ...report, manifestId: PLUGIN_ID, version, outputs: outputs.map((file) => file.path) }
}

function printReport(result) {
  console.log(`dev link folder: ${result.dir}`)
  console.log(`manifest id: ${result.manifestId}  version: ${result.version}`)
  console.log(`files in folder: ${result.outputs.length}  written: ${result.written.length}  unchanged: ${result.unchanged.length}  removed: ${result.removed.length}`)
  for (const rel of result.outputs) console.log(`  ${rel}${result.written.includes(rel) ? '  (written)' : ''}`)
  for (const rel of result.removed) console.log(`  removed: ${rel}`)
}

function startWatch(run) {
  let timer = null
  let busy = false
  let again = false
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(execute, 300)
  }
  const execute = async () => {
    if (busy) {
      again = true
      return
    }
    busy = true
    console.log(`[${new Date().toISOString()}] rebuilding`)
    try {
      printReport(await run())
    } catch (error) {
      console.error(error instanceof DevLinkLockedError ? error.message : `build failed: ${error.stack ?? error}`)
    } finally {
      busy = false
    }
    if (again) {
      again = false
      schedule()
    }
  }
  for (const watched of WATCHED) {
    fs.watch(watched.dir, { recursive: watched.recursive }, (_event, name) => {
      if (watched.match && !watched.match.test(String(name ?? ''))) return
      schedule()
    })
  }
  console.log('watching:')
  for (const watched of WATCHED) console.log(`  ${path.relative(ROOT, watched.dir).split(path.sep).join('/')}${watched.recursive ? '/**' : ' (build-*.mjs only)'}`)
  console.log('Ctrl+C to stop.')
  return execute()
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  const resident = resolveResidentOption({ args, env: process.env })
  if (args.watch) {
    await startWatch(() => buildDevLink({ resident }))
  } else {
    try {
      printReport(await buildDevLink({ resident }))
    } catch (error) {
      console.error(error instanceof DevLinkLockedError ? error.message : `build failed: ${error.stack ?? error}`)
      process.exitCode = 1
    }
  }
}
