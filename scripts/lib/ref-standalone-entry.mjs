// Bundled (esbuild, cjs) and run under Electron 31 run-as-node: the STANDALONE reference engine.
// linedb.ts runs with its defaults — NodeLineFsPort + the real better-sqlite3-multiple-ciphers — exactly as
// the standalone app does. argv[2] = base64url JSON { fixtureDir, expected }.
import * as linedb from '../../src/main/line/engine/linedb.ts'
import { runAllVariants } from './linedb-suite.mjs'

const { fixtureDir, expected } = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'))
const result = runAllVariants(linedb, { fixtureDir, expected })
result.runtime = { electron: process.versions.electron, node: process.version, abi: process.versions.modules }
process.stdout.write('RESULT:' + JSON.stringify(result) + '\n')
