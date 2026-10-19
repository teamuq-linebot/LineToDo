// Builds the plugin backend into one self-contained ESM file (`<installDir>/backend/index.mjs`) and proves what is (not) in it.
//
//   node scripts/plugin/build-backend.mjs [--out <dir>]      (default: dist/plugin-backend)
//
// What the bundle is allowed to contain (TeamUQ 1.6.8 full-trust backend contract + design v2 §3/§4.3):
//   * no child_process / worker_threads  -> the host self-check really spawns; success = the backend is refused at boot
//   * no electron                        -> the backend is plain Node (run-as-node)
//   * no better-sqlite3-multiple-ciphers -> LINE DB is read with the WASM engine; that native addon has no ABI-149 build
//   * no openai / provider / CLI modules -> the backend never calls an LLM (UI does, through ai:chat)
//   * no network modules                 -> node:http(s)/net/tls/dns/dgram are not imported
//   * the app DB driver is better-sqlite3 13.0.2 (alias `better-sqlite3-plugin`), never the standalone 11.x build
// koffi is the only native-addon package. Two modes (`buildBackendBundle({ koffi })`):
//   'external' (default, the Phase 2/3/4 test stages): the bare `import 'koffi'` stays external and is loaded from a staged node_modules.
//   'inline'   (Phase 5, the .tuqplugin): koffi's own JS is bundled and its loader is replaced by an addon shim: it requires exactly
//              `<installDir>/backend/native/win32-x64/koffi.node` (an integrity-listed native file) and never probes node_modules / PATH / cwd / resourcesPath.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const STUBS = join(ROOT, 'src', 'plugin', 'backend', 'stubs')
const norm = (p) => p.replace(/\\/g, '/')

/** Modules replaced inside the plugin bundle (see the header of each stub for why). Keys are extension-less absolute paths. */
function stubMap() {
  const m = new Map()
  const provider = join(STUBS, 'llmProvider.ts')
  m.set(norm(join(ROOT, 'src', 'main', 'llm', 'provider')), provider)
  m.set(norm(join(ROOT, 'src', 'main', 'llm', 'provider', 'index')), provider)
  m.set(norm(join(ROOT, 'src', 'main', 'llm', 'qwenClient')), join(STUBS, 'qwenClient.ts'))
  m.set(norm(join(ROOT, 'src', 'main', 'line', 'engine', 'nodeLineFsPort')), join(STUBS, 'nodeLineFsPort.ts'))
  m.set(norm(join(ROOT, 'src', 'main', 'line', 'engine', 'betterSqliteCipherEngine')), join(STUBS, 'betterSqliteCipherEngine.ts'))
  return m
}

function stubPlugin() {
  const map = stubMap()
  return {
    name: 'line-todo-plugin-stubs',
    setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: join(STUBS, 'electron.cjs') }))
      b.onResolve({ filter: /^\.\.?\// }, (args) => {
        const abs = norm(resolve(args.resolveDir, args.path)).replace(/\.(ts|js|mjs|cjs)$/, '')
        const hit = map.get(abs)
        return hit ? { path: hit } : undefined
      })
    },
  }
}

const FORBIDDEN_TEXT = [
  [/child_process/, 'child_process'],
  [/worker_threads/, 'worker_threads'],
  [/better-sqlite3-multiple-ciphers/, 'better-sqlite3-multiple-ciphers'],
  [/(?:from\s*|require\(\s*|import\(\s*)["']electron["']/, 'electron import'],
  [/node:(?:http|https|http2|net|tls|dns|dgram)["']/, 'network module'],
]

const FORBIDDEN_INPUTS = [
  [/node_modules\/better-sqlite3-multiple-ciphers\//, 'better-sqlite3-multiple-ciphers package'],
  [/node_modules\/better-sqlite3\//, 'better-sqlite3 (standalone 11.x) package'],
  [/node_modules\/openai\//, 'openai SDK'],
  [/src\/main\/llm\/cli\//, 'LLM CLI runner'],
  [/src\/main\/llm\/provider\/(claudeCli|codexCli|httpOpenAi)/, 'LLM provider implementation'],
  [/src\/main\/driver\//, 'driver_post (UIA / PowerShell)'],
  [/src\/main\/ipc\//, 'electron ipc'],
  [/src\/main\/media\/(protocol|backup)/, 'electron media protocol/backup'],
  [/src\/main\/index\.ts$/, 'standalone entry'],
]

const REQUIRED_INPUTS = [
  [/node_modules\/better-sqlite3-plugin\/lib\/index\.js$/, 'better-sqlite3 13.0.2 (plugin alias)'],
  [/src\/plugin\/backend\/index\.ts$/, 'plugin backend entry'],
  [/src\/plugin\/backend\/stubs\/llmProvider\.ts$/, 'provider stub'],
]

/**
 * Addon shim for koffi 3.1.0 (inline mode). koffi's own entry (`src/koffi/index.js` for `import`, `index.cjs` for `require`) picks its native
 * module with `loadStatic(pkg) ?? loadDynamic(dirname, ...)`, which probes `@koromix/koffi-*`, `build/koffi/*` and `process.resourcesPath`.
 * Inside a plugin the only legitimate location is the fixed, integrity-listed `backend/native/win32-x64/koffi.node`, so both calls are replaced
 * by one `require` of that path. The patch asserts its needles: a different koffi version fails the build instead of silently shipping a probing loader.
 */
const KOFFI_NODE_EXPR = '__ltKoffiNode'
const KOFFI_PATCHES = [
  {
    filter: /node_modules[\\/]koffi[\\/]src[\\/]koffi[\\/]index\.js$/,
    needles: [['import { loadStatic } from "./src/static.js";', ''], ['var native = loadStatic(pkg) ?? loadDynamic(import.meta.dirname, pkg, triplets);', `var native = require2(${KOFFI_NODE_EXPR});`]],
  },
  {
    filter: /node_modules[\\/]koffi[\\/]src[\\/]koffi[\\/]index\.cjs$/,
    needles: [['var { loadStatic } = require("./src/static.cjs");', ''], ['var native = loadStatic(pkg) ?? loadDynamic2(__dirname, pkg, triplets);', `var native = require2(${KOFFI_NODE_EXPR});`]],
  },
]

export function patchKoffiLoader(source, needles) {
  let out = source
  for (const [from, to] of needles) {
    if (!out.includes(from)) throw new Error(`koffi loader patch: expected text not found (koffi ${KOFFI_EXPECTED_VERSION} expected): ${from}`)
    out = out.replace(from, () => to)
  }
  return out
}
export const KOFFI_EXPECTED_VERSION = '3.1.0'

function koffiShimPlugin() {
  return {
    name: 'line-todo-koffi-addon-shim',
    setup(b) {
      for (const { filter, needles } of KOFFI_PATCHES) {
        b.onLoad({ filter }, (args) => {
          const pkg = JSON.parse(readFileSync(join(dirname(args.path), '..', '..', 'package.json'), 'utf8'))
          if (pkg.version !== KOFFI_EXPECTED_VERSION) throw new Error(`koffi ${pkg.version} found, the addon shim is written for ${KOFFI_EXPECTED_VERSION}`)
          return { contents: patchKoffiLoader(readFileSync(args.path, 'utf8'), needles), loader: 'js', resolveDir: dirname(args.path) }
        })
      }
    },
  }
}

const INLINE_KOFFI_BANNER = [
  "import { fileURLToPath as __ltFileURLToPath } from 'node:url';",
  "import { dirname as __ltDirname, join as __ltJoin } from 'node:path';",
  'const __ltFile = __ltFileURLToPath(import.meta.url);',
  'const __ltDir = __ltDirname(__ltFile);',
  `const ${KOFFI_NODE_EXPR} = __ltJoin(__ltDir, 'native', 'win32-x64', 'koffi.node');`,
].join('\n')

/** Allowed external imports of the bundle: koffi (external mode only) + node built-ins that cannot spawn or open sockets (async_hooks: AsyncLocalStorage, used by the Phase 4 AI relay to tag which core method is asking the model). */
const ALLOWED_NODE_BUILTINS = new Set(['fs', 'path', 'os', 'util', 'url', 'crypto', 'events', 'module', 'perf_hooks', 'buffer', 'assert', 'stream', 'string_decoder', 'timers', 'v8', 'zlib', 'tty', 'async_hooks'])

/** Pure analysis (also used by the test with synthetic input). Returns { ok, problems, summary }. */
export function analyzeBundle({ text, metafile, outfile, koffi = 'external' }) {
  const problems = []
  for (const [re, label] of FORBIDDEN_TEXT) if (re.test(text)) problems.push(`bundle text contains ${label}`)
  const inputs = Object.keys(metafile.inputs).map(norm)
  for (const [re, label] of FORBIDDEN_INPUTS) {
    const hit = inputs.find((i) => re.test(i))
    if (hit) problems.push(`bundle input ${hit} (${label})`)
  }
  for (const [re, label] of REQUIRED_INPUTS) if (!inputs.some((i) => re.test(i))) problems.push(`required input missing: ${label}`)
  const out = metafile.outputs[Object.keys(metafile.outputs).find((o) => norm(o).endsWith(norm(outfile).split('/').pop())) ?? '']
  const externals = out ? out.imports.filter((i) => i.external).map((i) => i.path) : []
  const bad = externals.filter((p) => !(koffi === 'external' && p === 'koffi') && !(ALLOWED_NODE_BUILTINS.has(p.replace(/^node:/, ''))))
  if (bad.length) problems.push(`unexpected external imports: ${[...new Set(bad)].join(', ')}`)
  if (koffi === 'external') {
    if (!externals.includes('koffi')) problems.push('koffi is not imported (procmem / win32fs need it)')
  } else {
    // inline: koffi's JS is in the bundle and loads ONLY backend/native/win32-x64/koffi.node (the addon shim); no @koromix/* package, no probing loader
    if (!inputs.some((i) => /node_modules\/koffi\/src\/koffi\/index\.js$/.test(i))) problems.push('koffi is not bundled (procmem / win32fs need it)')
    if (!text.includes(KOFFI_NODE_EXPR)) problems.push('the koffi addon shim is not in the bundle')
    for (const [re, label] of [[/@koromix\/koffi-/, 'a @koromix/koffi-* platform package'], [/resourcesPath/, 'process.resourcesPath probing'], [/loadStatic|loadDynamic/, "koffi's probing loaders"]]) if (re.test(text)) problems.push(`inline koffi bundle references ${label}`)
    const stray = inputs.filter((i) => /node_modules\/@koromix\//.test(i) || /node_modules\/koffi\/src\/koffi\/src\/static/.test(i))
    for (const i of stray) problems.push(`bundle input ${i} (koffi platform package / static loader)`)
  }
  return {
    ok: problems.length === 0,
    problems,
    summary: {
      inputs: inputs.length,
      externals: [...new Set(externals)].sort(),
      bytes: out?.bytes ?? null,
      moduleGroups: {
        plugin: inputs.filter((i) => i.startsWith('src/plugin/')).length,
        main: inputs.filter((i) => i.startsWith('src/main/')).length,
        core: inputs.filter((i) => i.startsWith('src/core/')).length,
        betterSqlite3Plugin: inputs.filter((i) => i.includes('node_modules/better-sqlite3-plugin/')).length,
        zod: inputs.filter((i) => i.includes('node_modules/zod/')).length,
        otherNodeModules: [...new Set(inputs.filter((i) => i.includes('node_modules/') && !i.includes('node_modules/better-sqlite3-plugin/') && !i.includes('node_modules/zod/')).map((i) => i.split('node_modules/')[1].split('/')[0]))].sort(),
      },
    },
  }
}

export async function buildBackendBundle({ outfile, koffi = 'external' }) {
  if (koffi !== 'external' && koffi !== 'inline') throw new Error(`koffi must be 'external' or 'inline', not ${koffi}`)
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  mkdirSync(dirname(outfile), { recursive: true })
  const result = await build({
    entryPoints: [join(ROOT, 'src', 'plugin', 'backend', 'index.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: koffi === 'external' ? ['koffi'] : [],
    // The standalone build keeps better-sqlite3 11.x (Electron 31); the plugin backend must load 13.0.2 (N-API, Electron 44).
    alias: { 'better-sqlite3': 'better-sqlite3-plugin' },
    plugins: koffi === 'inline' ? [stubPlugin(), koffiShimPlugin()] : [stubPlugin()],
    // CJS code inside the bundle (better-sqlite3's loader requires the .node addon by an absolute path) needs a real `require`.
    banner: { js: "import { createRequire as __lineTodoCreateRequire } from 'node:module';\nconst require = __lineTodoCreateRequire(import.meta.url);" + (koffi === 'inline' ? '\n' + INLINE_KOFFI_BANNER : '') },
    define: { __LINE_TODO_PLUGIN_VERSION__: JSON.stringify(version) },
    metafile: true,
    legalComments: 'none',
    logLevel: 'error',
    absWorkingDir: ROOT,
  })
  const text = readFileSync(outfile, 'utf8')
  const analysis = analyzeBundle({ text, metafile: result.metafile, outfile, koffi })
  return { outfile, text, metafile: result.metafile, analysis, version, koffi }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--out')
  const outDir = resolve(ROOT, at >= 0 ? process.argv[at + 1] : join('dist', 'plugin-backend'))
  const { outfile, metafile, analysis } = await buildBackendBundle({ outfile: join(outDir, 'index.mjs'), koffi: process.argv.includes('--inline-koffi') ? 'inline' : 'external' })
  writeFileSync(join(outDir, 'metafile.json'), JSON.stringify(metafile))
  writeFileSync(join(outDir, 'analysis.json'), JSON.stringify(analysis, null, 2))
  console.log(JSON.stringify({ outfile, ...analysis }, null, 2))
  process.exit(analysis.ok ? 0 : 1)
}
