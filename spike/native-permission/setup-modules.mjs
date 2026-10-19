// Stage the native modules needed for the spike into a local node_modules.
// Copies from the line-todo main tree's node_modules (built for Electron 31);
// better-sqlite3-multiple-ciphers is rebuilt for Electron 44 ABI by rebuild step.
import { cpSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const SRC = 'C:/teamuq/line-todo/node_modules'
const DST = new URL('./node_modules/', import.meta.url).pathname.replace(/^\//, '')

const pkgs = [
  'koffi',
  '@koromix/koffi-win32-x64',
  'better-sqlite3-multiple-ciphers',
  'bindings',
  'file-uri-to-path',
]

for (const p of pkgs) {
  const from = join(SRC, p)
  const to = join(DST, p)
  if (!existsSync(from)) {
    console.error('MISSING', from)
    continue
  }
  mkdirSync(join(to, '..'), { recursive: true })
  cpSync(from, to, { recursive: true, dereference: true })
  console.log('copied', p)
}
console.log('done; DST=', DST)
