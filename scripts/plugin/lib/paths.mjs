// Paths for the .tuqplugin packaging chain. Nothing here writes outside this repository's `dist/`.
//
// G-08 / G-09 (TeamUQ plugin developer guide, "快速開始"): the package is validated and packed by the official author tool
// (scripts/plugin/vendor/tuq-plugin-tool.mjs: `validate` + `pack --unsigned`). The previous chain — teamuq-electron's test fixture packer and
// 1.6.8 validators taken from a pinned commit, signed with the shared development key — is gone: no teamuq-electron checkout and no key file are read.
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
/** Build output (gitignored): the package, its build.json, the stage directory the tool packs, and the intermediate bundles. */
export const DIST = join(ROOT, 'dist', 'plugin-package')
export const WORK = join(DIST, '.work')
