// Loads the TeamUQ 1.6.8 plugin validators (manifest schema, support evaluation, artifact review: zip + integrity + signature) from the
// PINNED teamuq-electron commit. `git archive` writes the needed source directories into dist/ (teamuq-electron is only read), esbuild bundles them,
// and the result is the real @teamuq/plugin-sdk + @teamuq/plugin-artifact code of that commit (not the working tree, which is newer).
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { TE_COMMIT, TE_DIR, WORK } from './paths.mjs'

const PATHS = ['packages/plugin-sdk', 'packages/platform/plugin-artifact', 'tsconfig.node.json']
const TAR = process.platform === 'win32' ? 'C:/Windows/System32/tar.exe' : 'tar'

export const SNAPSHOT_DIR = path.join(WORK, `te-${TE_COMMIT}`)

export function extractSnapshot() {
  fs.rmSync(SNAPSHOT_DIR, { recursive: true, force: true })
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true })
  const tarFile = path.join(WORK, `te-${TE_COMMIT}.tar`)
  const archived = spawnSync('git', ['-C', TE_DIR, 'archive', '--format=tar', `--output=${tarFile}`, TE_COMMIT, ...PATHS], { encoding: 'utf8' })
  if (archived.status !== 0) throw new Error(`git archive ${TE_COMMIT} failed: ${archived.stderr}`)
  const untar = spawnSync(TAR, ['-xf', tarFile, '-C', SNAPSHOT_DIR], { encoding: 'utf8' })
  if (untar.status !== 0) throw new Error(`cannot unpack ${tarFile}: ${untar.stderr}`)
  fs.rmSync(tarFile, { force: true })
  return SNAPSHOT_DIR
}

/** { sdk, artifact } : the pinned validators. `sdk.PluginManifestV2Schema`, `sdk.evaluateManifestSupport`, `artifact.reviewArtifact`, `artifact.createDevKeyStore`, ... */
export async function loadTeValidators() {
  const dir = extractSnapshot()
  const sdkEntry = path.join(dir, 'packages', 'plugin-sdk', 'src', 'index.ts')
  const art = (rel) => path.join(dir, 'packages', 'platform', 'plugin-artifact', 'src', rel).replace(/\\/g, '/')
  const entry = path.join(dir, 'validators-entry.ts')
  fs.writeFileSync(entry, [
    `export * as sdk from ${JSON.stringify(sdkEntry.replace(/\\/g, '/'))}`,
    `export { reviewArtifact } from ${JSON.stringify(art('install/reviewArtifact'))}`,
    `export { createDevKeyStore } from ${JSON.stringify(art('trust/devKeyStore'))}`,
    `export { verifyIntegritySignature, TEAMUQ_TRUST_ANCHORS } from ${JSON.stringify(art('trust/signature'))}`,
    `export { PLUGIN_ARTIFACT_LIMITS, ASSET_PACK_LIMITS } from ${JSON.stringify(art('zip/zipReader'))}`,
    `export { parseIntegrity, assertCoverage, auditNativeContent } from ${JSON.stringify(art('integrity'))}`,
    '',
  ].join('\n'))
  const outfile = path.join(dir, 'validators.mjs')
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    alias: { '@teamuq/plugin-sdk': sdkEntry, yauzl: path.join(TE_DIR, 'node_modules', 'yauzl'), zod: path.join(TE_DIR, 'node_modules', 'zod') },
    // zod and yauzl are resolved from the teamuq-electron install (zod 3.25.x / yauzl 3.4.0, the versions its lockfile pins); only the SOURCE is pinned.
    nodePaths: [path.join(TE_DIR, 'node_modules')],
    tsconfig: path.join(dir, 'tsconfig.node.json'),
    logLevel: 'error',
    legalComments: 'none',
    banner: { js: "import { createRequire as __teCreateRequire } from 'node:module';\nconst require = __teCreateRequire(import.meta.url);" },
  })
  const mod = await import(`${pathToFileURL(outfile).href}?${Date.now()}`)
  return { sdk: mod.sdk, artifact: mod, dir, commit: TE_COMMIT }
}
