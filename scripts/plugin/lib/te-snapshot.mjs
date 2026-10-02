// Loads TeamUQ Core's own plugin code (manifest schema, support evaluation, artifact review: zip + integrity + signature, update policy,
// authoring packer) from a PINNED teamuq-electron commit. `git archive` writes the needed source directories into a work directory under dist/
// (teamuq-electron is only read), esbuild bundles them, and the result is the real @teamuq/plugin-sdk + @teamuq/plugin-artifact code of that
// commit (not the working tree, which is newer).
//
// Used by the dev-signed variant (build-plugin-devsigned.mjs, verify-devsigned.mjs): loadTe168() = TeamUQ 1.6.8 (b8b96cb3), loadTe171() = the
// Core the vendored tuq-plugin-tool was built from (1.7.1). The default (unsigned) chain does not use this file.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { TE_COMMIT, TE_DIR, WORK } from './paths.mjs'

const PATHS = ['packages/plugin-sdk', 'packages/platform/plugin-artifact', 'tsconfig.node.json']
const TAR = process.platform === 'win32' ? 'C:/Windows/System32/tar.exe' : 'tar'

export const snapshotDir = (commit = TE_COMMIT, workDir = WORK) => path.join(workDir, `te-${commit}`)
export const SNAPSHOT_DIR = snapshotDir()

export function extractSnapshot(commit = TE_COMMIT, workDir = WORK) {
  const dir = snapshotDir(commit, workDir)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const tarFile = path.join(workDir, `te-${commit}.tar`)
  const archived = spawnSync('git', ['-C', TE_DIR, 'archive', '--format=tar', `--output=${tarFile}`, commit, ...PATHS], { encoding: 'utf8' })
  if (archived.status !== 0) throw new Error(`git archive ${commit} failed: ${archived.stderr}`)
  const untar = spawnSync(TAR, ['-xf', tarFile, '-C', dir], { encoding: 'utf8' })
  if (untar.status !== 0) throw new Error(`cannot unpack ${tarFile}: ${untar.stderr}`)
  fs.rmSync(tarFile, { force: true })
  return dir
}

/** The full commit id `commit` names in teamuq-electron (for the evidence). */
export function resolveCommit(commit = TE_COMMIT) {
  const rev = spawnSync('git', ['-C', TE_DIR, 'rev-parse', '--verify', `${commit}^{commit}`], { encoding: 'utf8' })
  if (rev.status !== 0) throw new Error(`teamuq-electron has no commit ${commit}: ${rev.stderr}`)
  return rev.stdout.trim()
}

/**
 * Bundles `lines(art, sdkEntry)` (ES export statements; `art(rel)` is a plugin-artifact src path) from the snapshot of `commit` and imports it.
 * Returns the module namespace plus { dir, commit }.
 */
export async function loadTeModules({ commit = TE_COMMIT, workDir = WORK, name = 'validators', lines }) {
  const dir = extractSnapshot(commit, workDir)
  const sdkEntry = path.join(dir, 'packages', 'plugin-sdk', 'src', 'index.ts').replace(/\\/g, '/')
  const art = (rel) => JSON.stringify(path.join(dir, 'packages', 'platform', 'plugin-artifact', 'src', rel).replace(/\\/g, '/'))
  const entry = path.join(dir, `${name}-entry.ts`)
  fs.writeFileSync(entry, [...lines(art, JSON.stringify(sdkEntry)), ''].join('\n'))
  const outfile = path.join(dir, `${name}.mjs`)
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    alias: { '@teamuq/plugin-sdk': sdkEntry, yauzl: path.join(TE_DIR, 'node_modules', 'yauzl'), zod: path.join(TE_DIR, 'node_modules', 'zod') },
    // zod and yauzl are resolved from the teamuq-electron install (the versions its lockfile pins); only the SOURCE is pinned.
    nodePaths: [path.join(TE_DIR, 'node_modules')],
    tsconfig: path.join(dir, 'tsconfig.node.json'),
    logLevel: 'error',
    legalComments: 'none',
    banner: { js: "import { createRequire as __teCreateRequire } from 'node:module';\nconst require = __teCreateRequire(import.meta.url);" },
  })
  const mod = await import(`${pathToFileURL(outfile).href}?${Date.now()}`)
  return { ...mod, dir, commit }
}

const COMMON = (art, sdk) => [
  `export * as sdk from ${sdk}`,
  `export { reviewArtifact } from ${art('install/reviewArtifact')}`,
  `export { assertUpdateAllowed } from ${art('install/updatePolicy')}`,
  `export { createDevKeyStore } from ${art('trust/devKeyStore')}`,
  `export { TEAMUQ_TRUST_ANCHORS } from ${art('trust/signature')}`,
  `export { PLUGIN_ARTIFACT_LIMITS, ASSET_PACK_LIMITS } from ${art('zip/zipReader')}`,
  `export { parseIntegrity, assertCoverage, auditNativeContent } from ${art('integrity')}`,
]

/** { sdk, artifact }: the 1.6.8 validators (the 0.1.1 chain's loader; kept with the same shape). */
export async function loadTeValidators() {
  const mod = await loadTeModules({
    commit: TE_COMMIT,
    lines: (art, sdk) => [...COMMON(art, sdk), `export { verifyIntegritySignature } from ${art('trust/signature')}`],
  })
  return { sdk: mod.sdk, artifact: mod, dir: mod.dir, commit: TE_COMMIT }
}

/** TeamUQ 1.6.8 (b8b96cb3): the validators, the update policy and the authoring packer (packArtifact: stage → integrity → signature → reviewArtifact → file). */
export function loadTe168({ workDir = WORK } = {}) {
  return loadTeModules({
    commit: TE_COMMIT,
    workDir,
    name: 'core-168',
    lines: (art, sdk) => [...COMMON(art, sdk), `export { packArtifact } from ${art('authoring/packArtifact')}`],
  })
}

/** TeamUQ 1.7.1 at `commit` (the commit the vendored tuq-plugin-tool was built from): the validators and the update policy. */
export function loadTe171({ commit, workDir = WORK }) {
  return loadTeModules({ commit, workDir, name: 'core-171', lines: COMMON })
}
