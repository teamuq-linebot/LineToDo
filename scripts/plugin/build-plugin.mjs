// Builds the line-todo plugin package (.tuqplugin): a COMPOSED full-trust plugin (sandboxed board + settings views, own backend).
//
//   node scripts/plugin/build-plugin.mjs [--out <dir>] [--suffix name]        (default out: dist/plugin-package)
//
// Chain (TeamUQ plugin developer guide, "快速開始"; G-08 / G-09):
//   1. esbuild UI (build-ui.mjs, CSP-checked) + esbuild backend (build-backend.mjs, `koffi: 'inline'`: koffi's JS is bundled and loads ONLY
//      backend/native/win32-x64/koffi.node) + the two pinned native modules + the WASM SQLite3MC engine + licences;
//   2. all of it is laid out as a STAGE directory (<out>/stage) with manifest.json (lib/manifest.mjs);
//   3. the official author tool (scripts/plugin/vendor/tuq-plugin-tool.mjs, sha256-checked) runs `validate <stage>` and then
//      `pack <stage> --unsigned --out <file> --overrides <overrides.json>` for TeamUQ 1.7.1 on win32-x64. `pack` writes integrity.json and the zip and
//      reviews the result with the same reviewArtifact Core uses at install time. The overrides only restate each file's integrity kind
//      (the two .node files are `native` + platform; html / css / wasm stay `code` as before); everything else is the tool's default.
// No signature: the package is unsigned (Core installs it and labels it 未簽章). No teamuq-electron checkout, test fixture or key file is read.
// The tool's exact command lines, exit codes and output are kept in <file>.build.json.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildBackendBundle } from './build-backend.mjs'
import { buildPluginUi } from './build-ui.mjs'
import { DIST, ROOT, WORK } from './lib/paths.mjs'
import { parseArgs, sha256Hex } from './lib/pack.mjs'
import { BACKEND_METHODS, NATIVE_FILES, PERMISSIONS, PLUGIN_ID, RESOURCES, buildManifest } from './lib/manifest.mjs'
import { TARGET, assertToolIntact, packUnsigned, validateStage } from './lib/tuqTool.mjs'

/** Pinned native binaries: a different npm install cannot silently change what gets packed. */
export const PINNED_NATIVE = Object.freeze({
  koffi: { pkg: '@koromix/koffi-win32-x64', version: '3.1.0', sha256: 'f83df5e836a3d7cdffff9ed2ae1300c2e67225892df94930775be533b21e619b' },
  betterSqlite3: { pkg: 'better-sqlite3-plugin', version: '13.0.2', sha256: 'ecfb86221a674a6cdba63b1ac162b99386a61d0e38934b6c3dfcd9da11b6ee26' },
})

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts))
const nodeModule = (...parts) => path.join(ROOT, 'node_modules', ...parts)

function pinnedNative(spec, file) {
  const version = JSON.parse(fs.readFileSync(nodeModule(...spec.pkg.split('/'), 'package.json'), 'utf8')).version
  if (version !== spec.version) throw new Error(`${spec.pkg} ${version} is installed, ${spec.version} is pinned`)
  const data = fs.readFileSync(file)
  const actual = sha256Hex(data)
  if (actual !== spec.sha256) throw new Error(`${file}: sha256 ${actual} differs from the pinned ${spec.sha256}`)
  return data
}

/** { files, reports }: everything that goes into the package except manifest / integrity (each file with the integrity kind it must have). */
export async function collectPackageFiles({ workDir }) {
  fs.rmSync(workDir, { recursive: true, force: true })
  fs.mkdirSync(workDir, { recursive: true })

  const backend = await buildBackendBundle({ outfile: path.join(workDir, 'backend', 'index.mjs'), koffi: 'inline' })
  if (!backend.analysis.ok) throw new Error(`backend bundle rejected: ${backend.analysis.problems.join('; ')}`)
  const ui = await buildPluginUi({ outDir: path.join(workDir, 'ui') })
  if (!ui.analysis.ok) throw new Error(`UI bundle rejected: ${ui.analysis.problems.join('; ')}`)

  const koffiNode = pinnedNative(PINNED_NATIVE.koffi, nodeModule('@koromix', 'koffi-win32-x64', 'win32_x64', 'koffi.node'))
  const sqliteNode = pinnedNative(PINNED_NATIVE.betterSqlite3, nodeModule('better-sqlite3-plugin', 'prebuilds', 'win32-x64.node'))

  const wasmDir = path.join(ROOT, 'vendor', 'sqlite3mc-wasm')
  const provenance = JSON.parse(fs.readFileSync(path.join(wasmDir, 'PROVENANCE.json'), 'utf8'))
  for (const [name, expected] of Object.entries(provenance.files)) {
    const actual = sha256Hex(fs.readFileSync(path.join(wasmDir, name)))
    if (actual !== expected) throw new Error(`vendor/sqlite3mc-wasm/${name}: sha256 ${actual} differs from PROVENANCE.json ${expected}`)
  }

  const files = []
  const add = (rel, data, kind, platform) => files.push({ path: rel, data: Buffer.isBuffer(data) ? data : Buffer.from(data), kind, ...(platform === undefined ? {} : { platform }) })
  // UI: html / js / css are code, the icon is an asset. The directory is flat (build-ui.mjs); sorted so the order is stable.
  for (const name of fs.readdirSync(path.join(workDir, 'ui')).sort()) {
    if (/^(?:analysis|metafile)\.json$/.test(name)) continue
    add(`ui/${name}`, fs.readFileSync(path.join(workDir, 'ui', name)), 'code')
  }
  add('ui/icon.png', read('src', 'plugin', 'ui', 'icon.png'), 'asset')
  add('backend/index.mjs', fs.readFileSync(path.join(workDir, 'backend', 'index.mjs')), 'code')
  // native modules (listed in manifest.native.files, integrity kind 'native' + platform)
  const nativeData = { [NATIVE_FILES[0].path]: koffiNode, [NATIVE_FILES[1].path]: sqliteNode }
  for (const entry of NATIVE_FILES) add(entry.path, nativeData[entry.path], 'native', entry.platform)
  // the WASM LINE-DB engine: `.wasm` is not a native library for the artifact classifier (.node/.dll/.dylib/.so are), so it is code
  add('vendor/sqlite3mc-wasm/sqlite3.mjs', fs.readFileSync(path.join(wasmDir, 'sqlite3.mjs')), 'code')
  add('vendor/sqlite3mc-wasm/sqlite3.wasm', fs.readFileSync(path.join(wasmDir, 'sqlite3.wasm')), 'code')
  add('vendor/sqlite3mc-wasm/PROVENANCE.json', fs.readFileSync(path.join(wasmDir, 'PROVENANCE.json')), 'asset')
  // licences
  add('LICENSES/THIRD_PARTY_NOTICES.md', read('src', 'plugin', 'THIRD_PARTY_NOTICES.md'), 'asset')
  add('LICENSES/koffi-LICENSE.txt', fs.readFileSync(nodeModule('koffi', 'LICENSE.txt')), 'asset')
  add('LICENSES/better-sqlite3-LICENSE.txt', fs.readFileSync(nodeModule('better-sqlite3-plugin', 'LICENSE')), 'asset')
  add('LICENSES/zod-LICENSE.txt', fs.readFileSync(nodeModule('zod', 'LICENSE')), 'asset')
  add('LICENSES/react-LICENSE.txt', fs.readFileSync(nodeModule('react', 'LICENSE')), 'asset')

  return { files, backendAnalysis: backend.analysis, uiAnalysis: ui.analysis }
}

/** The tool's default integrity kind for a staged file (packages/platform/plugin-artifact/src/authoring/stageFiles.ts): .mjs/.js/.cjs = code, else asset. */
export const defaultKind = (rel) => (/\.(?:mjs|js|cjs)$/i.test(rel) ? 'code' : 'asset')

/** Overrides for `pack --overrides`: only the files whose kind (or platform) differs from the tool's default. */
export function kindOverrides(files) {
  return files
    .filter((file) => file.kind !== defaultKind(file.path) || file.platform !== undefined)
    .map((file) => ({ path: file.path, kind: file.kind, ...(file.platform === undefined ? {} : { platform: file.platform }) }))
}

/** Writes the stage directory (manifest.json + every file) that the tool validates and packs. */
export function writeStage(stageDir, manifest, files) {
  fs.rmSync(stageDir, { recursive: true, force: true })
  fs.mkdirSync(stageDir, { recursive: true })
  fs.writeFileSync(path.join(stageDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  for (const file of files) {
    const target = path.join(stageDir, ...file.path.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, file.data)
  }
}

const toolRun = (run) => ({ command: run.command, exit: run.exit, stdout: run.json ?? run.stdout.trim(), stderr: run.stderr.trim() })

/**
 * Builds the package into `outDir`: `<outDir>/stage/`, `<outDir>/overrides.json`, `<outDir>/<outName>`. Returns { file, zip, manifest, files, report, outName }.
 * Throws (after recording the tool output in `report`) when `validate` or `pack` does not exit 0.
 */
export async function buildPackage({ outDir = DIST, workDir = path.join(WORK, 'bundle'), suffix = '' } = {}) {
  const version = JSON.parse(read('package.json').toString('utf8')).version
  const tool = assertToolIntact()
  const { files, backendAnalysis, uiAnalysis } = await collectPackageFiles({ workDir })
  const manifest = buildManifest({ version })
  const outName = `${PLUGIN_ID}-${version}-win${suffix}.tuqplugin`
  const stageDir = path.join(outDir, `stage${suffix}`)
  const overridesFile = path.join(outDir, `overrides${suffix}.json`)
  const file = path.join(outDir, outName)
  fs.mkdirSync(outDir, { recursive: true })
  writeStage(stageDir, manifest, files)
  const overrides = kindOverrides(files)
  fs.writeFileSync(overridesFile, `${JSON.stringify(overrides, null, 2)}\n`)
  fs.rmSync(file, { force: true })

  const report = {
    file: outName,
    pluginId: manifest.id,
    version,
    tool: { ...tool, file: path.relative(ROOT, tool.file).split(path.sep).join('/') },
    target: { ...TARGET },
    signer: 'unsigned',
    minCoreVersion: manifest.minCoreVersion,
    trustTier: manifest.trustTier,
    permissions: [...PERMISSIONS],
    backendMethods: [...BACKEND_METHODS],
    resources: { ...RESOURCES },
    nativeFiles: NATIVE_FILES.map((entry) => entry.path),
    overrides,
    backendBundle: backendAnalysis.summary,
    uiBundle: uiAnalysis.summary,
    pinnedNative: PINNED_NATIVE,
    files: Object.fromEntries(files.map((f) => [f.path, { size: f.data.length, sha256: sha256Hex(f.data), kind: f.kind, ...(f.platform === undefined ? {} : { platform: f.platform }) }])),
    manifest,
  }
  const validated = validateStage(stageDir)
  report.validate = toolRun(validated)
  if (validated.exit !== 0) {
    const error = new Error(`tuq-plugin-tool validate failed (exit ${validated.exit}): ${validated.stderr.trim()}`)
    error.report = report
    throw error
  }
  const packed = packUnsigned(stageDir, file, overridesFile)
  report.pack = toolRun(packed)
  if (packed.exit !== 0) {
    const error = new Error(`tuq-plugin-tool pack --unsigned failed (exit ${packed.exit}): ${packed.stderr.trim()}`)
    error.report = report
    throw error
  }
  const zip = fs.readFileSync(file)
  report.bytes = zip.length
  report.sha256 = sha256Hex(zip)
  if (packed.json?.sha256 !== report.sha256) throw new Error(`the tool reported sha256 ${packed.json?.sha256}, the file has ${report.sha256}`)
  return { file, zip, manifest, files, report, outName, stageDir, overridesFile }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  const outDir = path.resolve(ROOT, args.out ? String(args.out) : DIST)
  let built
  try {
    built = await buildPackage({ outDir, suffix: args.suffix ? `-${args.suffix}` : '' })
  } catch (error) {
    if (error.report) console.error(JSON.stringify({ validate: error.report.validate, pack: error.report.pack }, null, 2))
    throw error
  }
  fs.writeFileSync(`${built.file}.build.json`, JSON.stringify(built.report, null, 2))
  console.error(`${built.outName}  ${(built.zip.length / 1024).toFixed(1)} KiB  sha256 ${built.report.sha256}  signer unsigned  (validate exit ${built.report.validate.exit}, pack exit ${built.report.pack.exit})`)
}
