// Phase 3 — the plugin UI: (1) the shared components really hide what the plugin host cannot do while standalone keeps it, (2) the built bundle
// (dist/plugin-ui, built here into a temp dir) fits the 1.6.8 view sandbox: no inline script, no network API, no linemedia://, no window.api.
//
// (1) is a server render of the REAL components (SettingsPanel, App, MediaView) with each capability set (scripts/plugin/fixtures/ui-render-entry.tsx).
// (2) is scripts/plugin/build-ui.mjs's analyzeUiBundle on the real build, plus the same analysis fed synthetic bad input so the guard is not vacuous.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

import { ROOT, analyzeUiBundle, buildPluginUi } from './build-ui.mjs'
import { CORE_BACKEND_INVOKE_TITLE, CORE_PERMISSIONS_SECTION_TITLE, EXPECTED_FENCED_TEXT, EXPECTED_TIMEOUT_TEXT, PLUGIN_PAGE_PLACE_TEXT, RECOVERY_PROMISE, STALE_PERMISSION_NAME, VERSION_SPECIFIC_PLACE } from './lib/fenced-text.mjs'

const work = mkdtempSync(join(tmpdir(), 'plugin-ui-test-'))
test.after(() => rmSync(work, { recursive: true, force: true }))

let rendererPromise = null
function renderer() {
  rendererPromise ??= (async () => {
    const outfile = join(work, 'ui-render.mjs')
    await build({
      entryPoints: [resolve(ROOT, 'scripts', 'plugin', 'fixtures', 'ui-render-entry.tsx')],
      outfile, bundle: true, format: 'esm', platform: 'node', target: 'node24', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty' }, logLevel: 'error', absWorkingDir: ROOT,
      banner: { js: "import { createRequire as __r } from 'node:module'; const require = __r(import.meta.url);" },
    })
    const caps = await import(pathToFileURL(resolve(ROOT, 'src', 'renderer', 'platform', 'capabilities.ts')).href)
    return { ...(await import(pathToFileURL(outfile).href)), PLUGIN: caps.PLUGIN_CAPABILITIES, STANDALONE: caps.STANDALONE_CAPABILITIES }
  })()
  return rendererPromise
}

const VIEW = {
  pollIntervalSec: 30, concurrency: 2, recentContextLimit: 10,
  blocklist: { nameKeywords: [], senderKeywords: [], contentTypeNoiseOnly: [], minTextLenForLLM: 2 },
  chatIgnoreKeywords: {}, openAtLogin: false, reconcile: { enabled: true, scopeMonths: 0 },
  aiBaseUrl: '', aiProvider: 'http',
  claudeCli: { execPath: '', model: '', timeoutMs: 120000 }, codexCli: { execPath: '', model: '', timeoutMs: 120000 },
  driverPost: { enabled: false, mode: 'fillOnly', verifyReadByDb: true },
  hasApiKey: true, apiKeySource: 'none', safeStorageAvailable: false,
}

// ───────────── (1) the UI hides what the plugin host cannot do ─────────────

const HIDDEN_IN_PLUGIN = [
  ['CLI provider cards', '使用哪一個引擎'],
  ['Claude CLI', 'Claude CLI'],
  ['Codex CLI', 'Codex CLI'],
  ['custom AI endpoint', 'AI 端點（Base URL）'],
  ['API key field', 'API 金鑰'],
  ['provider health check', '測試連線'],
  ['driver_post settings', '填入 LINE'],
  ['open data folder', '開啟資料夾'],
  ['launch at login', '開機時自動啟動'],
  ['extract concurrency', '抽取並發數'],
]

test('settings: the plugin host hides provider choice / CLI / custom endpoint / API key / driver_post / data folder / login item and explains where AI comes from; standalone keeps all of it', async () => {
  const { renderSettings, PLUGIN, STANDALONE } = await renderer()
  const standalone = renderSettings(STANDALONE, VIEW)
  const plugin = renderSettings(PLUGIN, VIEW)
  for (const [label, needle] of HIDDEN_IN_PLUGIN) {
    assert.ok(standalone.includes(needle), `standalone still shows: ${label} (${needle})`)
    assert.ok(!plugin.includes(needle), `plugin hides: ${label} (${needle})`)
  }
  // what stays
  for (const kept of ['輪詢頻率（秒）', '自我對帳', '降噪', '黑名單', '逐對話關鍵字忽略']) assert.ok(plugin.includes(kept), `plugin keeps: ${kept}`)
  assert.ok(plugin.includes('data-testid="ai-by-host"') && plugin.includes('TeamUQ'), 'plugin explains that AI comes from TeamUQ')
  assert.ok(!standalone.includes('ai-by-host'))
  // the same component with a CLI provider selected (standalone) shows the CLI fields, the plugin never does
  const cli = { ...VIEW, aiProvider: 'claudeCli' }
  assert.ok(renderSettings(STANDALONE, cli).includes('CLI 執行檔路徑'))
  assert.ok(!renderSettings(PLUGIN, cli).includes('CLI 執行檔路徑'), 'even if the stored provider is a CLI, the plugin UI shows no CLI controls')
})

test('board: the plugin host has no in-board settings tab (settings is its own view); standalone keeps the four tabs', async () => {
  const { renderApp, PLUGIN, STANDALONE } = await renderer()
  const tabs = (html) => [...html.matchAll(/<button class="tab[^"]*">([^<]+)<\/button>/g)].map((m) => m[1])
  // App reads the theme from the DOM on first render; a server render has no DOM
  globalThis.document = { documentElement: { dataset: {} } }
  try {
    assert.deepEqual(tabs(renderApp(STANDALONE)), ['看板', '即時訊息流', '群組議題', '設定'])
    assert.deepEqual(tabs(renderApp(PLUGIN)), ['看板', '即時訊息流', '群組議題'])
  } finally { delete globalThis.document }
})

test('media: file open / save-as buttons are hidden in the plugin; images ask the host for a URL and know no URL scheme', async () => {
  const { renderFileActions, renderImage, PLUGIN, STANDALONE } = await renderer()
  const standalone = renderFileActions(STANDALONE)
  assert.ok(standalone.includes('開啟') && standalone.includes('另存'))
  assert.equal(renderFileActions(PLUGIN), '', 'no buttons for saveAs / open in the plugin')
  assert.match(renderImage(true, PLUGIN), /載入中/, 'with a host assetUrl the image waits for the URL')
  assert.match(renderImage(false, PLUGIN), /尚未下載/, 'a host without assetUrl shows 尚未下載 (the component never invents a linemedia:// URL)')
  assert.ok(!renderImage(false, STANDALONE).includes('linemedia'))
})

// ───────────── plugin developer guide conformance (G-02 / G-03 / G-04) ─────────────

test('G-02: settings that cannot be read show the reason and a retry button instead of 載入設定中… forever; a failed write is shown under the title', async () => {
  const { renderSettingsWith, PLUGIN, STANDALONE } = await renderer()
  const reason = '讀取設定失敗：TeamUQ 目前不讓這個外掛呼叫後端，所以讀不到 LINE 與待辦資料。'
  for (const caps of [PLUGIN, STANDALONE]) {
    const failed = renderSettingsWith(caps, undefined, { initialLoadError: reason })
    assert.ok(failed.includes('data-testid="settings-load-error"'))
    assert.ok(failed.includes(reason))
    assert.ok(failed.includes('重試'))
    assert.ok(!failed.includes('載入設定中'), 'not stuck on loading')
    assert.ok(renderSettingsWith(caps, undefined, {}).includes('載入設定中'), 'still loading when nothing failed yet')
  }
  const write = renderSettingsWith(PLUGIN, VIEW, { initialActionError: '設定沒有儲存：外掛後端暫時無法回應（可能正在啟動或忙碌），稍後再試。' })
  assert.ok(write.includes('data-testid="settings-action-error"') && write.includes('設定沒有儲存'))
  assert.ok(write.includes('輪詢頻率（秒）'), 'the form is still there')
})

test('G-03 / B1: the backend status line, when Core fences the plugin, names the three causes and the actions that work (no "comes back by itself"), says when the backend is down, and is absent when all is well', async () => {
  const { renderBackendBar } = await renderer()
  const revoked = renderBackendBar({ state: 'revoked', code: 'plugin_permission_denied' })
  assert.match(revoked, /role="alert"/)
  assert.match(revoked, /data-backend-link="revoked"/)
  for (const code of ['plugin_permission_denied', 'plugin_disabled']) {
    const html = renderBackendBar({ state: 'revoked', code })
    assert.match(html, /backend:invoke/, code)
    assert.match(html, /外掛被停用/, code)
    assert.match(html, /太久沒有回應而被 TeamUQ 隔離/, code)
    assert.ok(html.includes(`請到 ${PLUGIN_PAGE_PLACE_TEXT}，確認「${CORE_PERMISSIONS_SECTION_TITLE}」裡已允許「${CORE_BACKEND_INVOKE_TITLE}」，而且外掛是啟用的`), `${code}: where to go, the switch title on TeamUQ's plugin page (R1-N1, 0.1.3)`)
    assert.doesNotMatch(html, VERSION_SPECIFIC_PLACE, `${code}: 0.1.3 — no place that only one TeamUQ version has`)
    assert.match(html, /停用再啟用，或重新啟動 TeamUQ/, code)
    assert.doesNotMatch(html, /自動恢復|目前在 TeamUQ 中是停用狀態/, code)
    // tester r1 §3.2: word for word, so a paraphrased promise cannot slip in; R1-N1: never the name 「後端呼叫」
    assert.ok(html.includes(EXPECTED_FENCED_TEXT), `${code}: the fenced sentence, word for word`)
    assert.doesNotMatch(html, RECOVERY_PROMISE, code)
    assert.doesNotMatch(html, STALE_PERMISSION_NAME, code)
  }
  const timeout = renderBackendBar({ state: 'revoked', code: 'backend_invoke_timeout' })
  assert.match(timeout, /停用再啟用/)
  assert.doesNotMatch(timeout, /已重新啟動它/)
  assert.ok(timeout.includes(EXPECTED_TIMEOUT_TEXT), 'the timeout sentence, word for word')
  assert.doesNotMatch(timeout, RECOVERY_PROMISE)
  assert.ok(timeout.includes(`請到 ${PLUGIN_PAGE_PLACE_TEXT}，把它停用再啟用`), 'timeout: where to go (0.1.3)')
  assert.doesNotMatch(timeout, VERSION_SPECIFIC_PLACE, 'timeout: 0.1.3 — no place that only one TeamUQ version has')
  assert.match(renderBackendBar({ state: 'unavailable', code: 'plugin_backend_crashed' }), /意外結束/)
  assert.equal(renderBackendBar({ state: 'ok', code: null }), '')
  assert.equal(renderBackendBar({ state: 'unknown', code: null }), '')
})

test('G-04: a re-created plugin view restores the tab, the sort / filters and grouping from its saved UI state; standalone (no store) starts fresh as before', async () => {
  const { renderAppWithState, PLUGIN, STANDALONE } = await renderer()
  const active = (html) => html.match(/<button class="tab active">([^<]+)<\/button>/)?.[1]
  assert.equal(active(renderAppWithState(PLUGIN, null)), '看板')
  assert.equal(active(renderAppWithState(PLUGIN, { 'app.tab': 'topics' })), '群組議題')
  assert.equal(active(renderAppWithState(PLUGIN, { 'app.tab': 'settings' })), '看板', 'a saved settings tab falls back to the board where there is no settings tab')
  assert.equal(active(renderAppWithState(STANDALONE, { 'app.tab': 'settings' })), '設定')
  const board = renderAppWithState(PLUGIN, { 'board.sortBy': 'priority', 'board.sortDirection': 'asc', 'board.chatKindFilter': 'group', 'board.localViewedFilter': 'unviewed', 'board.groupByChat': true })
  assert.match(board, /<option value="priority" selected="">/)
  assert.match(board, /<option value="asc" selected="">/)
  assert.match(board, /<option value="group" selected="">/)
  assert.match(board, /<option value="unviewed" selected="">/)
  assert.match(board, /<input type="checkbox" checked=""/)
  const fresh = renderAppWithState(PLUGIN, { 'board.sortBy': 'not-a-sort' })
  assert.match(fresh, /<option value="updatedAt" selected="">/, 'a saved value of the wrong shape is ignored')
  assert.match(renderAppWithState(STANDALONE, null), /<option value="updatedAt" selected="">/)
})

// ───────────── (2) the bundle fits the 1.6.8 view sandbox ─────────────

let built = null
const getBuilt = () => (built ??= buildPluginUi({ outDir: join(work, 'plugin-ui') }))

test('bundle: the real build has no inline script, no event-handler attribute, no <base>/<iframe>/<form>, no CSP meta, and only relative same-origin references', async () => {
  const { files, analysis } = await getBuilt()
  assert.deepEqual(analysis.problems, [])
  assert.equal(analysis.ok, true)
  assert.deepEqual(Object.keys(files).sort(), ['index.html', 'main.css', 'main.js', 'settings.css', 'settings.html', 'settings.js', 'theme-boot.js'])
  for (const html of ['index.html', 'settings.html']) {
    const scripts = [...files[html].matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    assert.ok(scripts.length >= 2, `${html} loads external scripts`)
    for (const [, attrs, body] of scripts) {
      assert.match(attrs, /\bsrc="[A-Za-z0-9._-]+\.js"/, 'script src is a relative file')
      assert.equal(body.trim(), '', 'no inline script body')
    }
    assert.ok(!/<meta[^>]+Content-Security-Policy/i.test(files[html]))
  }
  assert.ok(!/\sstyle=/.test(files['index.html']) && !/\sonclick=/.test(files['index.html']))
})

test('bundle: the JavaScript has no outbound network API, no linemedia://, no window.api, no eval, no remote URL (other than inert XML-namespace / React error-decoder strings)', async () => {
  const { files } = await getBuilt()
  for (const name of ['main.js', 'settings.js', 'theme-boot.js']) {
    const text = files[name]
    for (const [label, re] of [
      ['linemedia', /linemedia/i], ['window.api', /window\s*\.\s*api\b/], ['fetch()', /\bfetch\s*\(/], ['XMLHttpRequest', /XMLHttpRequest/], ['WebSocket', /WebSocket/],
      ['EventSource', /EventSource/], ['sendBeacon', /sendBeacon/], ['eval()', /\beval\s*\(/], ['new Function', /new\s+Function\s*\(/],
    ]) assert.ok(!re.test(text), `${name} must not contain ${label}`)
    const remote = [...text.matchAll(/\bhttps?:\/\/[^\s"'`)<>\\]+/g)].map((m) => m[0]).filter((u) => !/^https?:\/\/(?:www\.w3\.org\/|reactjs\.org\/docs\/error-decoder\.html)/.test(u))
    assert.deepEqual(remote, [], `${name} remote URLs`)
  }
  // the one thing that talks to the backend is the view bridge
  assert.ok(files['main.js'].includes('tuqPlugin'), 'the bundle talks to window.tuqPlugin')
  // G-07: one backend method per API namespace (the manifest's backendMethods), no longer a single api.invoke
  assert.ok(!files['main.js'].includes("'api.invoke'") && !files['main.js'].includes('"api.invoke"'), 'the single api.invoke method is gone')
  for (const group of ['db.todos', 'pipeline', 'events', 'extract']) assert.ok(files['main.js'].includes(`"${group}"`) || files['main.js'].includes(`'${group}'`), `the method group ${group} is in the bundle`)
  assert.ok(files['main.js'].includes('events.pull'), 'and the long-poll event channel')
})

test('bundle: only renderer / shared / plugin-ui / react code is inside (no main-process, core, backend, preload, electron, native or provider module)', async () => {
  const { analysis, metafiles } = await getBuilt()
  const inputs = [...new Set(metafiles.flatMap((m) => Object.keys(m.inputs).map((i) => i.replace(/\\/g, '/'))))]
  assert.ok(inputs.some((i) => i === 'src/plugin/ui/main.tsx') && inputs.some((i) => i === 'src/plugin/ui/settings.tsx'))
  assert.ok(inputs.includes('src/renderer/platform/pluginApi.ts'))
  assert.ok(inputs.includes('src/plugin/ui/stubs/defaultEndpoint.ts') && !inputs.includes('src/renderer/lib/defaultEndpoint.ts'), 'the standalone endpoint placeholder was replaced by the stub')
  assert.ok(!inputs.some((i) => /^src\/(?:main|core|preload|plugin\/backend)\//.test(i)), 'no main/core/backend code')
  assert.equal(analysis.ok, true)
})

test('the bundle guard really flags forbidden content (it is not vacuous)', () => {
  const bad = analyzeUiBundle({
    files: {
      'index.html': '<!DOCTYPE html><html><head><base href="/"><meta http-equiv="Content-Security-Policy" content="x"><script>var a=1</script></head><body onload="go()"><iframe src="x"></iframe><script src="https://cdn.example/x.js"></script><form></form></body></html>',
      'main.js': 'fetch("https://api.example.com/x"); new WebSocket("wss://x.example"); const u="linemedia://media/1"; window.api.ping(); eval("1"); require("electron")',
      'main.css': '@import url("https://fonts.example/x.css");',
    },
    metafiles: [{ inputs: { 'src/main/index.ts': {}, 'src/renderer/App.tsx': {}, 'node_modules/electron/index.js': {}, 'src/renderer/lib/defaultEndpoint.ts': {}, 'vendor/other.js': {} } }],
  })
  assert.equal(bad.ok, false)
  const joined = bad.problems.join('\n')
  for (const needle of [
    'inline <script>', 'inline event handler', '<base>', '<iframe>', '<form>', 'CSP meta', 'script src is not a relative', 'fetch() call', 'WebSocket', '`linemedia`', '`window.api`', 'eval()',
    'node/electron require', 'remote URL', 'remote @import', 'main-process code', 'electron', 'standalone default AI endpoint', 'outside the allow-list',
  ]) assert.ok(joined.includes(needle), `expected a problem mentioning: ${needle}\n${joined}`)
  // and a clean synthetic bundle passes
  const good = analyzeUiBundle({
    files: { 'index.html': '<!DOCTYPE html><html><head><link rel="stylesheet" href="main.css"><script src="theme-boot.js"></script></head><body><div id="root"></div><script src="main.js"></script></body></html>', 'main.js': 'var x = "http://www.w3.org/2000/svg"', 'main.css': 'a{color:red}' },
    metafiles: [{ inputs: { 'src/renderer/App.tsx': {}, 'node_modules/react/index.js': {} } }],
  })
  assert.deepEqual(good.problems, [])
})

test('the plugin entry points are plain files in the repo (no template magic): the HTML pages reference exactly the scripts the build emits', () => {
  const ui = resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'src', 'plugin', 'ui')
  assert.match(readFileSync(join(ui, 'index.html'), 'utf8'), /<script src="main\.js"><\/script>/)
  assert.match(readFileSync(join(ui, 'settings.html'), 'utf8'), /<script src="settings\.js"><\/script>/)
  writeFileSync(join(work, 'probe.txt'), 'ok')
})
