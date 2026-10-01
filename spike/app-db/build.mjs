// Bundle harness/appdb-entry.ts + the UNMODIFIED line-todo src/main/db/** into build/appdb.bundle.mjs
// with esbuild (the same tool line-todo's own smoke scripts use; taken read-only from the line-todo
// main tree). `better-sqlite3` is redirected to harness/shim-better-sqlite3.mjs.
// Writes evidence/build-manifest.json (sha256 of every bundled source). Usage: node build.mjs
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const WORKTREE = resolve(ROOT, '..', '..')
const require = createRequire(import.meta.url)
const esbuild = require('C:/teamuq/line-todo/node_modules/esbuild')
mkdirSync(join(ROOT, 'build'), { recursive: true }); mkdirSync(join(ROOT, 'evidence'), { recursive: true })
const SHIM = join(ROOT, 'harness', 'shim-better-sqlite3.mjs')

const result = await esbuild.build({
  entryPoints: [join(ROOT, 'harness', 'appdb-entry.ts')],
  outfile: join(ROOT, 'build', 'appdb.bundle.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node20', metafile: true, logLevel: 'warning',
  plugins: [{ name: 'redirect-better-sqlite3', setup(b) { b.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: SHIM })) } }],
})
const inputs = Object.keys(result.metafile.inputs).map((p) => {
  const abs = resolve(process.cwd(), p)
  return { file: abs.startsWith(WORKTREE) ? abs.slice(WORKTREE.length + 1).replaceAll('\\', '/') : abs, sha256: createHash('sha256').update(readFileSync(abs)).digest('hex') }
}).sort((a, b) => a.file.localeCompare(b.file))
const out = join(ROOT, 'build', 'appdb.bundle.mjs')
writeFileSync(join(ROOT, 'evidence', 'build-manifest.json'), JSON.stringify({ esbuild: esbuild.version, bundle: 'build/appdb.bundle.mjs', bundleSha256: createHash('sha256').update(readFileSync(out)).digest('hex'), lineTodoDbSources: inputs.filter((i) => i.file.startsWith('src/')), harnessSources: inputs.filter((i) => !i.file.startsWith('src/')) }, null, 2))
console.log(JSON.stringify({ ok: true, esbuild: esbuild.version, inputs: inputs.length, srcFiles: inputs.filter((i) => i.file.startsWith('src/')).map((i) => i.file) }))
