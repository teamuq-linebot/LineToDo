// Paths and pins for the .tuqplugin packaging chain (Phase 5). Nothing here writes outside this repository's `dist/`.
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
/** Build output (gitignored): the signed package, build.json and the intermediate bundles. */
export const DIST = join(ROOT, 'dist', 'plugin-package')
export const WORK = join(DIST, '.work')

/** teamuq-electron checkout (read only). The packer and every 1.6.8 validator are taken from the pinned commit with `git show` / `git archive`, never from the working tree. */
export const TE_DIR = process.env.TEAMUQ_ELECTRON_DIR ?? 'C:/teamuq/teamuq-electron'
/** TeamUQ 1.6.8 release commit (code tree 7d34947e5). */
export const TE_COMMIT = process.env.TE_COMMIT ?? 'b8b96cb3'

/**
 * The shared local development signing key (keyId dev-e6301dd7a2967155, the same file ai-lover and speech-funasr use).
 * The private key stays where it is; this repository only ever stores the PATH. Override with LINE_TODO_DEV_KEY.
 */
export const DEV_KEY_FILE = process.env.LINE_TODO_DEV_KEY ?? 'C:/teamuq/teamuq-plugins/speech-funasr/keys/dev-key.json'
export const DEV_KEY_ID = 'dev-e6301dd7a2967155'
