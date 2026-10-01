// Builds the plugin UI (board view + settings view) into static files and proves they fit the TeamUQ 1.6.8 view sandbox.
//
//   node scripts/plugin/build-ui.mjs [--out <dir>]        (default: dist/plugin-ui)
//
// Output (flat; Phase 5 packs it under `ui/`):
//   index.html  main.js  main.css          board view   (manifest views[board].entry)
//   settings.html  settings.js  settings.css   settings view (views[settings].entry)
//   theme-boot.js                          the anti-flash theme script, as an external file (the CSP forbids inline script)
//
// The sandbox rules this checks (apps/desktop/src/main/pluginSurface/pluginCsp.ts @ b8b96cb3, lines 15-26, sent as a header on every HTML response):
//   default-src 'none'; script-src <origin>; style-src <origin> 'unsafe-inline'; img-src <origin> data: blob:; media-src <origin> blob: mediastream:;
//   font-src <origin> data:; connect-src <origin>; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'
// ...which means for us: no inline <script> / on*= attributes, no <base>/<iframe>/<object>/<embed>, no network API pointed anywhere but the plugin origin
// (the UI has none at all: everything goes through window.tuqPlugin.backend), no `linemedia://` (not in img-src), no `window.api` (standalone's preload).
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const UI_SRC = join(ROOT, 'src', 'plugin', 'ui')
const norm = (p) => p.replace(/\\/g, '/')

/** Modules replaced inside the plugin UI bundle (keys: extension-less absolute paths). */
function uiStubs() {
  return new Map([[norm(join(ROOT, 'src', 'renderer', 'lib', 'defaultEndpoint')), join(UI_SRC, 'stubs', 'defaultEndpoint.ts')]])
}

function stubPlugin() {
  const map = uiStubs()
  return {
    name: 'line-todo-ui-stubs',
    setup(b) {
      b.onResolve({ filter: /^\.\.?\// }, (args) => {
        const hit = map.get(norm(resolve(args.resolveDir, args.path)).replace(/\.(ts|tsx|js)$/, ''))
        return hit ? { path: hit } : undefined
      })
    },
  }
}

/** URLs that appear inside React / react-dom strings but are never requested (XML namespaces, error-message links). */
const INERT_URL_PREFIXES = [
  'http://www.w3.org/', 'https://www.w3.org/',
  'https://reactjs.org/docs/error-decoder.html', 'https://react.dev/errors', 'https://react.dev/link/', 'https://reactjs.org/link/',
]

const FORBIDDEN_JS = [
  [/linemedia/i, '`linemedia` (the standalone media scheme is not in the plugin CSP img-src)'],
  [/window\s*\.\s*api\b|window\s*\[\s*["']api["']\s*\]|globalThis\s*\.\s*api\b/, '`window.api` (standalone preload bridge)'],
  [/\bfetch\s*\(/, 'fetch() call'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bWebSocket\b/, 'WebSocket'],
  [/\bEventSource\b/, 'EventSource'],
  [/\bsendBeacon\b/, 'navigator.sendBeacon'],
  [/\bimportScripts\b/, 'importScripts'],
  [/\bnew\s+Worker\s*\(|\bSharedWorker\b|serviceWorker/, 'Worker / ServiceWorker'],
  [/\beval\s*\(/, 'eval()'],
  [/\bnew\s+Function\s*\(/, 'new Function()'],
  [/\bimport\s*\(\s*["'`]https?:/, 'dynamic import of a remote URL'],
  [/require\(\s*["'](?:electron|node:|fs|path|child_process)/, 'node/electron require'],
]

// Phase 4: 'node_modules/zod/' — the AI orchestrator validates model replies with the same zod schema the backend uses (src/shared/extractResult.ts: pure, imports only zod).
const ALLOWED_INPUT_ROOTS = ['src/renderer/', 'src/shared/', 'src/plugin/ui/', 'node_modules/react/', 'node_modules/react-dom/', 'node_modules/scheduler/', 'node_modules/zod/']
const FORBIDDEN_INPUTS = [
  [/^src\/main\//, 'main-process code'],
  [/^src\/core\//, 'core (backend) code'],
  [/^src\/plugin\/backend\//, 'plugin backend code'],
  [/^src\/preload\//, 'standalone preload'],
  [/node_modules\/electron\//, 'electron'],
  [/node_modules\/(?:better-sqlite3|koffi|openai)/, 'native / provider package'],
  [/^src\/renderer\/lib\/defaultEndpoint\.ts$/, 'standalone default AI endpoint (must be replaced by the UI stub)'],
]

function remoteUrls(text) {
  return [...text.matchAll(/\b(?:https?|wss?|ftp):\/\/[^\s"'`)<>\\]+/g)].map((m) => m[0]).filter((url) => !INERT_URL_PREFIXES.some((p) => url.startsWith(p)))
}

/** Pure analysis (also used by the test with synthetic input). `files`: { name: text }; `metafiles`: esbuild metafile objects. */
export function analyzeUiBundle({ files, metafiles = [] }) {
  const problems = []
  for (const [name, text] of Object.entries(files)) {
    if (name.endsWith('.html')) {
      const scripts = [...text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
      if (scripts.length === 0) problems.push(`${name}: no <script> at all`)
      for (const [, attrs, body] of scripts) {
        if (!/\bsrc\s*=\s*"[^"]+"/.test(attrs)) problems.push(`${name}: inline <script> (no src)`)
        else if (body.trim() !== '') problems.push(`${name}: <script src> with an inline body`)
        const src = (/\bsrc\s*=\s*"([^"]+)"/.exec(attrs) ?? [])[1] ?? ''
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(src)) problems.push(`${name}: script src is not a relative same-origin path: ${src}`)
      }
      if (/\son[a-z]+\s*=\s*["']/i.test(text.replace(/<!--[\s\S]*?-->/g, ''))) problems.push(`${name}: inline event handler attribute`)
      if (/javascript:/i.test(text)) problems.push(`${name}: javascript: URL`)
      const bare = text.replace(/<!--[\s\S]*?-->/g, '')
      for (const tag of ['base', 'iframe', 'frame', 'object', 'embed', 'form']) if (new RegExp(`<${tag}\\b`, 'i').test(bare)) problems.push(`${name}: <${tag}> is blocked by the CSP (frame-src/object-src/base-uri/form-action)`)
      if (/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy/i.test(bare)) problems.push(`${name}: CSP meta (the host sends the CSP header)`)
      for (const m of bare.matchAll(/\b(?:src|href)\s*=\s*"([^"]+)"/gi)) if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(m[1]) && !m[1].startsWith('data:')) problems.push(`${name}: external reference ${m[1]}`)
    } else if (name.endsWith('.js')) {
      for (const [re, label] of FORBIDDEN_JS) if (re.test(text)) problems.push(`${name}: contains ${label}`)
      const urls = remoteUrls(text)
      if (urls.length) problems.push(`${name}: remote URL(s): ${[...new Set(urls)].slice(0, 5).join(', ')}`)
    } else if (name.endsWith('.css')) {
      if (/@import\s+(?:url\()?["']?(?:https?:)?\/\//i.test(text)) problems.push(`${name}: remote @import`)
      const urls = remoteUrls(text)
      if (urls.length) problems.push(`${name}: remote URL(s): ${[...new Set(urls)].slice(0, 5).join(', ')}`)
    }
  }
  const inputs = [...new Set(metafiles.flatMap((m) => Object.keys(m.inputs).map(norm)))]
  for (const input of inputs) {
    const forbidden = FORBIDDEN_INPUTS.find(([re]) => re.test(input))
    if (forbidden) problems.push(`bundle input ${input} (${forbidden[1]})`)
    else if (!ALLOWED_INPUT_ROOTS.some((root) => input.startsWith(root))) problems.push(`bundle input outside the allow-list: ${input}`)
  }
  return {
    ok: problems.length === 0,
    problems,
    summary: {
      inputs: inputs.length,
      groups: {
        renderer: inputs.filter((i) => i.startsWith('src/renderer/')).length,
        pluginUi: inputs.filter((i) => i.startsWith('src/plugin/ui/')).length,
        shared: inputs.filter((i) => i.startsWith('src/shared/')).length,
        react: inputs.filter((i) => /^node_modules\/(?:react|react-dom|scheduler)\//.test(i)).length,
      },
    },
  }
}

export async function buildPluginUi({ outDir }) {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const metafiles = []
  for (const name of ['main', 'settings']) {
    const result = await build({
      entryPoints: [join(UI_SRC, `${name}.tsx`)],
      outfile: join(outDir, `${name}.js`),
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'chrome130',
      jsx: 'automatic',
      minify: true,
      legalComments: 'none',
      charset: 'utf8',
      // react / react-dom branch on process.env.NODE_ENV; the browser has no `process`.
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [stubPlugin()],
      metafile: true,
      logLevel: 'error',
      absWorkingDir: ROOT,
    })
    metafiles.push(result.metafile)
  }
  for (const file of ['index.html', 'settings.html', 'theme-boot.js']) copyFileSync(join(UI_SRC, file), join(outDir, file))
  const files = {}
  for (const name of readdirSync(outDir)) files[name] = readFileSync(join(outDir, name), 'utf8')
  const analysis = analyzeUiBundle({ files, metafiles })
  const sizes = Object.fromEntries(readdirSync(outDir).map((name) => [name, statSync(join(outDir, name)).size]))
  return { outDir, files, metafiles, analysis, sizes }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--out')
  const outDir = resolve(ROOT, at >= 0 ? process.argv[at + 1] : join('dist', 'plugin-ui'))
  const { analysis, sizes, metafiles } = await buildPluginUi({ outDir })
  writeFileSync(join(outDir, 'analysis.json'), JSON.stringify({ ...analysis, sizes }, null, 2))
  writeFileSync(join(outDir, 'metafile.json'), JSON.stringify(metafiles))
  console.log(JSON.stringify({ outDir, sizes, ...analysis }, null, 2))
  process.exit(analysis.ok ? 0 : 1)
}
