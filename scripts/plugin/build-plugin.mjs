// Builds and signs the line-todo plugin package (.tuqplugin): a COMPOSED full-trust plugin (sandboxed board + settings views, own backend).
//
//   node scripts/plugin/build-plugin.mjs [--out <dir>] [--suffix name]        (default out: dist/plugin-package)
//
// Chain (same shape as ai-lover 0.3.0 / speech-funasr): esbuild UI (build-ui.mjs, CSP-checked) + esbuild backend (build-backend.mjs, `koffi: 'inline'`:
// koffi's JS is bundled and loads ONLY backend/native/win32-x64/koffi.node) + the two native modules + the WASM SQLite3MC engine as `code`,
// then the OFFICIAL packer (teamuq-electron plugin-artifact test fixture `buildPlugin`, taken from the pinned commit b8b96cb3 with git show)
// writes manifest.json + integrity.json + signature.json and the zip, signed with the shared development key (keyId dev-e6301dd7a2967155).
// The private key file is only READ for the signing call; its content never reaches this repository, build.json or any log.
//
// The output is deterministic: two builds of the same sources have the same sha256 (the zip has fixed timestamps, ed25519 signatures are deterministic).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildBackendBundle } from './build-backend.mjs'
import { buildPluginUi } from './build-ui.mjs'
import { DEV_KEY_FILE, DIST, ROOT, TE_COMMIT, WORK } from './lib/paths.mjs'
import { loadDevSigner, loadTeBuilder, parseArgs, sha256Hex } from './lib/pack.mjs'
import { BACKEND_METHODS, NATIVE_FILES, PERMISSIONS, PLUGIN_ID, PLATFORM_ID, RESOURCES, buildManifest } from './lib/manifest.mjs'

/** Pinned native binaries: a different npm install cannot silently change what gets signed. */
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

/** { files, manifest-independent inputs, reports }: everything that goes into the package except manifest/integrity/signature. */
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
  // UI: html / js / css are code, the icon is an asset. The directory is flat (build-ui.mjs); sorted so the zip order is stable.
  for (const name of fs.readdirSync(path.join(workDir, 'ui')).sort()) {
    if (/^(?:analysis|metafile)\.json$/.test(name)) continue
    add(`ui/${name}`, fs.readFileSync(path.join(workDir, 'ui', name)), 'code')
  }
  add('ui/icon.png', read('src', 'plugin', 'ui', 'icon.png'), 'asset')
  add('backend/index.mjs', fs.readFileSync(path.join(workDir, 'backend', 'index.mjs')), 'code')
  // native modules (listed in manifest.native.files, integrity kind 'native' + platform)
  const nativeData = { [NATIVE_FILES[0].path]: koffiNode, [NATIVE_FILES[1].path]: sqliteNode }
  for (const entry of NATIVE_FILES) add(entry.path, nativeData[entry.path], 'native', entry.platform)
  // the WASM LINE-DB engine: `.wasm` is NOT a native library in the 1.6.8 artifact classifier (entryNames.ts NATIVE_LIBRARY_EXTENSIONS = .node/.dll/.dylib/.so), so it is code
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

/** Builds + signs the package. Returns { zip, manifest, files, report, outName }. Does not write the package (the caller decides where). */
export async function buildPackage({ workDir = path.join(WORK, 'bundle'), suffix = '' } = {}) {
  const version = JSON.parse(read('package.json').toString('utf8')).version
  const signer = await loadDevSigner()
  const { buildPlugin, baseManifest } = await loadTeBuilder()
  const { files, backendAnalysis, uiAnalysis } = await collectPackageFiles({ workDir })
  const manifest = buildManifest({ baseManifest, version })
  const zip = buildPlugin({ signer, manifest, files })
  const outName = `${PLUGIN_ID}-${version}-win${suffix}.tuqplugin`
  const report = {
    file: outName,
    bytes: zip.length,
    sha256: sha256Hex(zip),
    signerKeyId: signer.keyId,
    signerKind: signer.kind,
    teCommit: TE_COMMIT,
    devKeyFile: DEV_KEY_FILE, // the PATH only; the key material is never written anywhere
    pluginId: manifest.id,
    version,
    minCoreVersion: manifest.minCoreVersion,
    trustTier: manifest.trustTier,
    permissions: [...PERMISSIONS],
    backendMethods: [...BACKEND_METHODS],
    resources: { ...RESOURCES },
    nativeFiles: NATIVE_FILES.map((entry) => entry.path),
    backendBundle: backendAnalysis.summary,
    uiBundle: uiAnalysis.summary,
    pinnedNative: PINNED_NATIVE,
    files: Object.fromEntries(files.map((file) => [file.path, { size: file.data.length, sha256: sha256Hex(file.data), kind: file.kind, ...(file.platform === undefined ? {} : { platform: file.platform }) }])),
    manifest,
  }
  return { zip, manifest, files, report, outName, signer: { keyId: signer.keyId } }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  const outDir = path.resolve(ROOT, args.out ? String(args.out) : DIST)
  const built = await buildPackage({ suffix: args.suffix ? `-${args.suffix}` : '' })
  fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, built.outName)
  fs.writeFileSync(outFile, built.zip)
  fs.writeFileSync(`${outFile}.build.json`, JSON.stringify(built.report, null, 2))
  console.error(`${built.outName}  ${(built.zip.length / 1024).toFixed(1)} KiB  sha256 ${built.report.sha256}  signer ${built.signer.keyId}`)
}
