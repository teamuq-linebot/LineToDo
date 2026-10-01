// Stage the (non-WASM) modules this spike needs into ./node_modules, by copying from the sibling
// spike/native-permission/node_modules (which itself was staged from the line-todo main tree, i.e.
// the exact koffi 3.1.0 and better-sqlite3-multiple-ciphers 11.10.0 binaries line-todo ships,
// built for Electron 31 / ABI 125).
//   - koffi (+ @koromix/koffi-win32-x64): used inside the permissioned child to CopyFileW the
//     "LINE" snapshot into dataDir (the stated precondition), N-API so it loads on ABI 149 too.
//   - better-sqlite3-multiple-ciphers (+ bindings, file-uri-to-path): fixture generator and the
//     Electron-31 baseline engine only.
// The WASM engine itself is NOT an npm package: it is the official SQLite3MultipleCiphers WASM
// release asset, fetched + SHA-256 verified by scripts/fetch-sqlite3mc-wasm.mjs into ./vendor.
import { cpSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const SRC = join(ROOT, '..', 'native-permission', 'node_modules')
const DST = join(ROOT, 'node_modules')
const pkgs = ['koffi', '@koromix/koffi-win32-x64', 'better-sqlite3-multiple-ciphers', 'bindings', 'file-uri-to-path']
let missing = 0
for (const p of pkgs) {
  const from = join(SRC, p)
  if (!existsSync(from)) { console.error('MISSING', from); missing++; continue }
  mkdirSync(dirname(join(DST, p)), { recursive: true })
  cpSync(from, join(DST, p), { recursive: true, dereference: true })
  console.log('copied', p)
}
process.exit(missing ? 1 : 0)
