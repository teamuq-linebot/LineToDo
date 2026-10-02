// Paths for the .tuqplugin packaging chain. Nothing here writes outside this repository's `dist/`.
//
// G-08 / G-09 (TeamUQ plugin developer guide, "快速開始"): the package is validated and packed by the official author tool
// (scripts/plugin/vendor/tuq-plugin-tool.mjs: `validate` + `pack --unsigned`). The previous chain — teamuq-electron's test fixture packer and
// 1.6.8 validators taken from a pinned commit, signed with the shared development key — is gone from the default chain: it reads no teamuq-electron
// checkout and no key file. Only the separate dev-signed variant (names at the end of this file) still does, for 0.1.1 → current-version updates on 1.6.8.
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
/** Build output (gitignored): the package, its build.json, the stage directory the tool packs, and the intermediate bundles. */
export const DIST = join(ROOT, 'dist', 'plugin-package')
export const WORK = join(DIST, '.work')

// ── The development-key-signed variant (build-plugin-devsigned.mjs / verify-devsigned.mjs) ──────────────────────────────────────────────────────
// Only for machines that already run 0.1.1 (dev-signed) on TeamUQ 1.6.8. The default chain above imports none of the names below.

/** Output of the dev-signed variant (gitignored), next to the unsigned package's folder. */
export const DIST_DEVSIGNED = join(ROOT, 'dist', 'plugin-package-devsigned')
/** teamuq-electron checkout (read only): Core's own packer / validators are taken from pinned commits with `git archive`, never from the working tree. */
export const TE_DIR = process.env.TEAMUQ_ELECTRON_DIR ?? 'C:/teamuq/teamuq-electron'
/** TeamUQ 1.6.8 release commit (code tree 7d34947e5): the Core whose packer signs the variant and whose review it must pass. */
export const TE_COMMIT = process.env.TE_COMMIT ?? 'b8b96cb3'
/**
 * The shared local development signing key (keyId dev-e6301dd7a2967155, the file 0.1.1 / ai-lover / speech-funasr were signed with).
 * The private key stays where it is; this repository only ever stores the PATH. Override with LINE_TODO_DEV_KEY.
 */
export const DEV_KEY_FILE = process.env.LINE_TODO_DEV_KEY ?? 'C:/teamuq/teamuq-plugins/speech-funasr/keys/dev-key.json'
export const DEV_KEY_ID = 'dev-e6301dd7a2967155'
/** The public key file users import into TeamUQ (read only). Override with LINE_TODO_DEV_PUB. */
export const DEV_PUB_FILE = process.env.LINE_TODO_DEV_PUB ?? 'C:/teamuq/teamuq-plugins/_install/windows/dev-e6301dd7a2967155.pub'
/** The release users have installed (0.1.1, dev-signed; read only): the update base for the update check. Override with LINE_TODO_PREVIOUS. */
export const PREVIOUS_RELEASE = Object.freeze({
  file: process.env.LINE_TODO_PREVIOUS ?? 'C:/teamuq/teamuq-plugins/_install/windows/tuqdev.line-todo-0.1.1-win.tuqplugin',
  sha256: '4155ab48abd3b69f2b100ecda881fb3a6807f9c314d4915fc383ad3cf15ac571',
})
