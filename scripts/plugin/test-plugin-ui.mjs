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

import { ROOT, analyzeUiBundle, buildPluginUi, pluginVersion } from './build-ui.mjs'
import { BACKEND_TRUST_REQUIREMENT, EXPECTED_FENCED_TEXT, EXPECTED_TIMEOUT_TEXT, PLUGIN_PAGE_PLACE_TEXT, RECOVERY_PROMISE, STALE_PERMISSION_NAME, VERSION_SPECIFIC_PLACE } from './lib/fenced-text.mjs'

const work = mkdtempSync(join(tmpdir(), 'plugin-ui-test-'))
test.after(() => rmSync(work, { recursive: true, force: true }))

let rendererPromise = null
function renderer() {
  rendererPromise ??= (async () => {
    const outfile = join(work, 'ui-render.mjs')
    await build({
      entryPoints: [resolve(ROOT, 'scripts', 'plugin', 'fixtures', 'ui-render-entry.tsx')],
      outfile, bundle: true, format: 'esm', platform: 'node', target: 'node24', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"', __LINE_TODO_PLUGIN_VERSION__: JSON.stringify(pluginVersion()) }, loader: { '.css': 'empty' }, logLevel: 'error', absWorkingDir: ROOT,
      banner: { js: "import { createRequire as __r } from 'node:module'; const require = __r(import.meta.url);" },
    })
    const caps = await import(pathToFileURL(resolve(ROOT, 'src', 'renderer', 'platform', 'capabilities.ts')).href)
    return { ...(await import(pathToFileURL(outfile).href)), PLUGIN: caps.PLUGIN_CAPABILITIES, STANDALONE: caps.STANDALONE_CAPABILITIES }
  })()
  return rendererPromise
}

const VIEW = {
  pollIntervalSec: 30, concurrency: 2, recentContextLimit: 10,
  blocklist: { contentTypeNoiseOnly: [], minTextLenForLLM: 2 },
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
  for (const kept of ['輪詢頻率（秒）', '自我對帳', '逐對話關鍵字忽略']) assert.ok(plugin.includes(kept), `plugin keeps: ${kept}`)
  for (const gone of ['降噪', '黑名單', '已忽略', '忽略對話', '恢復對話']) assert.equal(plugin.includes(gone), false, `plugin drops: ${gone}`)
  assert.ok(plugin.includes('data-testid="ai-by-host"') && plugin.includes('TeamUQ'), 'plugin explains that AI comes from TeamUQ')
  assert.ok(plugin.includes('TeamUQ 的 AI 歷史'), 'review F8: the conversations the AI organises are recorded in the TeamUQ AI history, and the settings page says so')
  assert.ok(!standalone.includes('ai-by-host'))
  // the same component with a CLI provider selected (standalone) shows the CLI fields, the plugin never does
  const cli = { ...VIEW, aiProvider: 'claudeCli' }
  assert.ok(renderSettings(STANDALONE, cli).includes('CLI 執行檔路徑'))
  assert.ok(!renderSettings(PLUGIN, cli).includes('CLI 執行檔路徑'), 'even if the stored provider is a CLI, the plugin UI shows no CLI controls')
})

test('settings: the in-app settings tab (operations) adds only the 整理 block; the plain settings view (plugin standalone view) does not have it', async () => {
  const { renderSettings, renderSettingsOps, PLUGIN, STANDALONE } = await renderer()
  for (const caps of [PLUGIN, STANDALONE]) {
    const plain = renderSettings(caps, VIEW)
    const ops = renderSettingsOps(caps, VIEW)
    assert.equal(plain.includes('data-testid="overview-ops"'), false)
    assert.ok(ops.includes('data-testid="overview-ops"') && ops.includes('整理'))
    for (const label of ['不是我的回查', '回顧最近 2 天', '補媒體金鑰(近7天)']) assert.ok(ops.includes(label), label)
    assert.ok(ops.includes('立即抓取'), 'the run button')
  }
  for (const gone of ['降噪', '黑名單', '已忽略', '忽略對話', '恢復對話']) assert.equal(renderSettingsOps(PLUGIN, VIEW).includes(gone), false, gone)
})

test('board: plugin and standalone both expose the five main tabs including group topics and purchase', async () => {
  const { renderApp, PLUGIN, STANDALONE } = await renderer()
  const tabs = (html) => [...html.matchAll(/<button class="tab[^"]*">([^<]+)<\/button>/g)].map((m) => m[1])
  // App reads the theme from the DOM on first render; a server render has no DOM
  globalThis.document = { documentElement: { dataset: {} } }
  try {
    assert.deepEqual(tabs(renderApp(STANDALONE)), ['總覽', '聊天', '購買', '群組議題', '設定'])
    assert.deepEqual(tabs(renderApp(PLUGIN)), ['總覽', '聊天', '購買', '群組議題', '設定'])
  } finally { delete globalThis.document }
})

test('group topics: actual table renders readable multiline notes by default and keeps todo/source controls in a closed disclosure', async () => {
  const { renderTopicMinutesTable } = await renderer()
  const summary = '背景：群組討論活動場地\n討論重點：比較交通與容量\n共識／結論：未定\n待釐清：預算\n演進：新增候選'
  const html = renderTopicMinutesTable(summary, true)
  assert.ok(html.includes('topic-minutes-summary'), 'the summary receives the multiline reading style')
  assert.ok(html.includes('背景：群組討論活動場地') && html.includes('待釐清：預算'), 'the note sections are rendered in the default table view')
  assert.ok(html.includes('總覽內容已縮短；開啟聊天室的單群議題可閱讀完整紀錄。'))
  assert.ok(html.includes('<details class="topics-disclosure">') && !html.includes('<details class="topics-disclosure" open>'), 'source and todo operations remain collapsed initially')
  assert.ok(html.includes('檢查既有待辦關聯'))
})

test('group topics: actual overview omission notice names affected group and topic counts even when a group has no remaining topic rows', async () => {
  const { renderTopicOverviewOmissionNotice } = await renderer()
  const html = renderTopicOverviewOmissionNotice([
    { chat: { chatId: 'g1', name: 'Alpha' }, status: 'enabled', topics: [], topicCount: 30, compacted: true },
    { chat: { chatId: 'g2', name: 'Beta' }, status: 'enabled', topics: [], topicCount: 10, compacted: true, omittedGroupCount: 3, omittedTopicCount: 12 }
  ])
  assert.match(html, /role="status"/)
  assert.match(html, /省略 52 則議題/)
  assert.match(html, /涉及 5 個群組/)
  assert.match(html, /其中 3 個群組整筆省略/)
})

test('header: the title row shows the plugin version, taken from package.json (the manifest/backend source), in plugin and standalone', async () => {
  const { renderApp, PLUGIN, STANDALONE } = await renderer()
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  assert.match(version, /^\d+\.\d+\.\d+/)
  globalThis.document = { documentElement: { dataset: {} } }
  try {
    for (const caps of [PLUGIN, STANDALONE]) {
      const header = /<header class="app-header">([\s\S]*?)<\/header>/.exec(renderApp(caps))?.[1] ?? ''
      assert.match(header, /<h1>line-todo<\/h1>/)
      assert.ok(header.includes(`<span class="app-version" title="外掛版本 ${version}">v${version}</span>`), `the version sits in the title row: ${header.slice(0, 200)}`)
    }
  } finally { delete globalThis.document }
})

test('media: file open / save-as buttons are hidden in the plugin; images ask the host for a URL and know no URL scheme', async () => {
  const { renderFileActions, renderImage, PLUGIN, STANDALONE } = await renderer()
  const standalone = renderFileActions(STANDALONE)
  assert.ok(standalone.includes('開啟') && standalone.includes('另存'))
  assert.equal(renderFileActions(PLUGIN), '', 'no buttons for saveAs / open in the plugin')
  assert.match(renderImage(true, PLUGIN), /載入中/, 'with a host assetUrl the image waits for the URL')
  assert.match(renderImage(false, PLUGIN), /class="advanced-entry-button"/, 'a missing image exposes the compact advanced entry (the component never invents a linemedia:// URL)')
  assert.ok(!renderImage(false, STANDALONE).includes('linemedia'))
})

// ───────────── X5：設定頁「LINE 附件下載」的文案（implementation-plan-v2.md §2 X5） ─────────────

const X5_STATUS = (over = {}) => ({
  available: true,
  login: { status: 'authenticated' },
  receiver: 'active',
  downloads: { pending: 0, active: 0, completed: 0, failed: 0, recent: [] },
  ...over,
})
const textOf = (html) => html.replace(/<[^>]+>/g, '')
const sectionOf = (html, testid) => { const m = new RegExp(`data-testid="${testid}"[^>]*>(.*?)</(?:div|p)>`).exec(html); return m ? textOf(m[1]) : null }

test('X5 settings: 接收 says it follows LINE desktop (no saving while the desktop is closed, caught up once it opens) and covers photos, videos and files including your own; 舊訊息下載, the hourly cap and the automatic pause on LINE rate limits are explained; the background switch is named', async () => {
  const { renderLineJsMediaPanel } = await renderer()
  const html = renderLineJsMediaPanel(X5_STATUS())
  assert.ok(html.includes('接收新照片、影片與檔案（含自己傳出的）'), 'the receive switch')
  assert.equal(html.includes('接收新圖片與檔案<'), false, 'the old label is gone')
  const receive = sectionOf(html, 'linejs-receive-help')
  assert.ok(receive, 'receive help is shown')
  for (const phrase of ['以 LINE 電腦版收到的訊息為準', '自動保存並顯示在聊天室', '電腦版沒開時不會自動保存', '之後打開電腦版，開啟接收後收到的訊息會陸續補上', 'LINE 已不提供的除外', '關閉畫面後繼續在背景執行']) assert.ok(receive.includes(phrase), phrase)
  // review-x5 F-4: only what arrives after receiving was turned on is caught up (X2b-fix: since-time = switch-on − 5 min, by message time)
  assert.equal(receive.includes('之後開了會補上'), false, 'the unqualified promise is gone')
  const history = sectionOf(html, 'linejs-history-help')
  assert.ok(history, 'old-message download help is shown')
  for (const phrase of ['舊訊息下載', '下載原檔', '補抓本頁原檔', '一次最多 50 個', '已過期']) assert.ok(history.includes(phrase), phrase)
  const limit = sectionOf(html, 'linejs-limit-help')
  assert.ok(limit, 'the limit help is shown')
  // review-x5 F-6: the cap counts requests (a retry counts too), shared by auto saving and old-message downloads
  for (const phrase of ['自動保存與舊訊息下載合計每小時最多向 LINE 下載 200 次', '重試也算', '超過或遇到 LINE 限流時會自動暫停', '稍後自動繼續']) assert.ok(limit.includes(phrase), phrase)
  const intro = sectionOf(html, 'linejs-media-intro')
  assert.ok(intro, 'the intro is shown')
  // review-x5 F-2: the desktop account IS read (only to compare it); outbound and the QR login change LINE, the desktop files are never changed
  for (const phrase of ['照片、影片與檔案', '掃描 QR code', '不會使用電腦版 LINE 的登入資料', '只確認兩邊是同一個帳號', '也不會更改電腦版 LINE 的檔案', '移除外掛時一併刪除']) assert.ok(intro.includes(phrase), phrase)
  for (const old of ['不會讀取電腦版 LINE 的登入狀態', '不會更改 LINE 的資料']) assert.equal(intro.includes(old), false, `untrue wording is gone: ${old}`)
  assert.equal(/只在你開啟接收後處理新訊息|接收新圖片與檔案。/.test(html), false, 'the old intro is gone')
  // no technical words in what the user reads
  for (const word of ['OBS', 'LINEJS', 'ledger', 'API', '429']) assert.equal(textOf(html).includes(word), false, word)
})

test('X5 settings: the old (v1) download list is read-only — no 重試 (v1 is frozen and retry answers disabled), the reason is said, photos have no 另存附件 any more; a v1 file can still be saved; nothing old → no old section', async () => {
  const { renderLineJsMediaPanel } = await renderer()
  const recent = [
    { key: 'k1', kind: 'IMAGE', name: 'a.jpg', status: 'failed', bytes: 10, errorCode: 'X' },
    { key: 'k2', kind: 'IMAGE', name: 'b.jpg', status: 'completed', bytes: 20 },
    { key: 'k3', kind: 'FILE', name: 'c.pdf', status: 'completed', bytes: 30 },
    { key: 'k4', kind: 'FILE', name: 'd.pdf', status: 'pending', bytes: 40 },
  ]
  const html = renderLineJsMediaPanel(X5_STATUS({ downloads: { pending: 1, active: 0, completed: 2, failed: 1, recent } }))
  const note = sectionOf(html, 'linejs-legacy-note')
  assert.ok(note, 'the read-only note is shown')
  for (const phrase of ['舊版下載紀錄（唯讀）', '舊版的下載方式已停用', '不能重試', '下載原檔']) assert.ok(note.includes(phrase), phrase)
  assert.equal(/>重試</.test(html), false, 'no 重試 button')
  assert.equal((html.match(/>另存附件</g) ?? []).length, 1, 'only the completed v1 file can be saved')
  assert.ok(html.includes('aria-label="舊版下載紀錄"'))
  assert.equal(/下載中|等待中/.test(textOf(html)), false, 'a frozen item is not shown as still downloading or waiting')
  assert.ok(textOf(html).includes('未完成'))
  const none = renderLineJsMediaPanel(X5_STATUS())
  assert.equal(none.includes('data-testid="linejs-legacy"'), false, 'no old records → no old section')
  assert.equal(none.includes('目前沒有下載項目'), false, 'the old empty sentence (it read as if nothing is being saved) is gone')
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
    assert.match(html, /外掛已停用/, code)
    assert.match(html, /太久沒有回應而被 TeamUQ 隔離/, code)
    assert.ok(html.includes(`請到 ${PLUGIN_PAGE_PLACE_TEXT}，確認執行範圍是「完全信任級」且外掛已啟用`), `${code}: where to go and check current trust/enablement guidance (0.1.3)`)
    assert.ok(html.includes(BACKEND_TRUST_REQUIREMENT), `${code}: current trust requirement is explicit`)
    assert.doesNotMatch(html,/backend:invoke|舊版 manifest 欄位/u,`${code}: no obsolete authorization-switch advice`)
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
  assert.equal(active(renderAppWithState(PLUGIN, null)), '總覽')
  assert.equal(active(renderAppWithState(PLUGIN, { 'app.tab': 'topics' })), '群組議題', 'the previously saved group-topics tab is restored')
  assert.equal(active(renderAppWithState(STANDALONE, { 'app.tab': 'topics' })), '群組議題')
  assert.equal(active(renderAppWithState(PLUGIN, { 'app.tab': 'identity' })), '總覽', 'a saved value from the removed review tab falls back to the overview')
  assert.equal(active(renderAppWithState(PLUGIN, { 'app.tab': 'settings' })), '設定')
  assert.equal(active(renderAppWithState(STANDALONE, { 'app.tab': 'settings' })), '設定')
  assert.equal(active(renderAppWithState(PLUGIN, { 'app.tab': 'unknown-tab' })), '總覽', 'unknown saved values still fall back to the overview')
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
  // the header version is injected from package.json at build time (never a literal in src/)
  assert.ok(files['main.js'].includes(`"${pluginVersion()}"`), 'main.js carries the package.json version for the title row')
})

test('bundle: only renderer / shared / plugin-ui / react code is inside (no main-process, core, backend, preload, electron, native or provider module)', async () => {
  const { analysis, metafiles } = await getBuilt()
  const inputs = [...new Set(metafiles.flatMap((m) => Object.keys(m.inputs).map((i) => i.replace(/\\/g, '/'))))]
  assert.ok(inputs.some((i) => i === 'src/plugin/ui/main.tsx') && inputs.some((i) => i === 'src/plugin/ui/settings.tsx'))
  assert.ok(!inputs.includes('src/plugin/ui/AiStatusBar.tsx'), 'the persistent AI status chip is not mounted in the plugin UI bundle')
  assert.ok(inputs.includes('src/renderer/platform/pluginApi.ts'))
  assert.ok(inputs.includes('src/plugin/ui/stubs/defaultEndpoint.ts') && !inputs.includes('src/renderer/lib/defaultEndpoint.ts'), 'the standalone endpoint placeholder was replaced by the stub')
  assert.ok(!inputs.some((i) => /^src\/(?:main|core|preload|plugin\/backend)\//.test(i)), 'no main/core/backend code')
  assert.equal(analysis.ok, true)
})

test('A18 bundle: the production board bundle mounts the per-chat AI settings (ChatPromptPanel, the "AI 設定" tab, the chatPrompt paths) and the settings bundle has the name field and the per-chat list', async () => {
  const { files, metafiles } = await getBuilt()
  const inputs = [...new Set(metafiles.flatMap((m) => Object.keys(m.inputs).map((i) => i.replaceAll(String.fromCharCode(92), '/'))))]
  assert.ok(inputs.includes('src/renderer/features/chatPrompt/ChatPromptPanel.tsx'), 'ChatPromptPanel is part of the production bundle')
  assert.ok(files['main.js'].includes('AI 設定') && files['main.js'].includes('chat-prompt-panel') && files['main.js'].includes('settings.chatPrompt.save'), 'board bundle: tab, panel and paths')
  assert.ok(files['settings.js'].includes('default-my-name') && files['settings.js'].includes('chat-overrides') && files['settings.js'].includes('settings.prompt.saveName'), 'settings bundle: name field, per-chat list, saveName path')
})

test('production bundle: root group-topics tab and one chat tab wire their topic panels', async () => {
  const { files, metafiles } = await getBuilt()
  const inputs = [...new Set(metafiles.flatMap((m) => Object.keys(m.inputs).map((i) => i.replaceAll(String.fromCharCode(92), '/'))))]
  assert.ok(inputs.includes('src/renderer/App.tsx'), 'App is part of the production board bundle')
  assert.ok(inputs.includes('src/renderer/components/MessageStream.tsx'), 'MessageStream is an actual production caller')
  assert.ok(inputs.includes('src/renderer/features/groupTopics/GroupTopicsPanel.tsx'), 'the existing topics panel is imported into the production bundle')
  assert.ok(inputs.includes('src/renderer/features/chatTodos/ChatTodosPanel.tsx'), 'the existing todos panel is imported into the production bundle')
  assert.ok(files['main.js'].includes('群組議題'), 'the built board exposes the top-level group-topics entry')
  assert.ok(files['main.js'].includes('議題 ▾') && files['main.js'].includes('代辦 ▾') && files['main.js'].includes('chat-insights-overlay'), 'the built chat pane exposes separate floating topics and todos menus')
})

test('production bundle: free chat omits the disabled composer, exposes the purchase tab and keeps the residency footer', async () => {
  const { files, metafiles } = await getBuilt()
  const inputs = [...new Set(metafiles.flatMap((m) => Object.keys(m.inputs).map((i) => i.replaceAll(String.fromCharCode(92), '/'))))]
  assert.ok(inputs.includes('src/plugin/ui/main.tsx'), 'the plugin entry is part of the board bundle')
  assert.ok(inputs.includes('src/plugin/ui/PluginRootLayout.tsx'), 'the plugin uses its flow layout wrapper')
  assert.ok(inputs.includes('src/plugin/ui/ResidencyStatus.tsx'), 'the visible residency status remains wired')
  assert.ok(inputs.includes('src/renderer/components/MessageStream.tsx'), 'the message view is part of the board bundle')
  assert.ok(!files['main.js'].includes('訊息功能尚未開啟') && !files['main.js'].includes('附加檔案功能尚未開啟') && !files['main.js'].includes('傳送功能尚未開啟'), 'the composer controls are removed from the production UI')
  for (const copy of ['購買', '購買方案', '目前尚未開放購買', '價格與付款方式尚未提供', 'LINE 進階功能包', '排程發送擴充包', '一次買斷', '未來規劃', '升級不保證補回過去未保存']) assert.ok(files['main.js'].includes(copy), `production UI includes truthful purchase copy: ${copy}`)
  assert.ok(files['main.js'].includes('residency-status-bar') && files['main.js'].includes('plugin-root-layout'), 'the status and renderer are connected through the root layout')
  assert.ok(files['main.css'].includes('.chat-message-view') && files['main.css'].includes('.residency-status-bar'), 'the production stylesheet keeps the message reader and host residency footer')
})

test('free chat renders compact exact-type advanced entries and the internal purchase tab', async () => {
  const { renderAppWithState, renderImage, renderMessageContent, PLUGIN } = await renderer()
  const purchase = renderAppWithState(PLUGIN, { 'app.tab': 'purchase' })
  assert.match(purchase, /購買方案/)
  assert.match(purchase, /LINE 進階功能包/)
  assert.match(purchase, /排程發送擴充包/)
  assert.match(purchase, /一次買斷/)
  assert.match(purchase, /目前尚未開放購買/)
  assert.match(purchase, /返回聊天/)
  assert.doesNotMatch(purchase, /NT\$|https?:\/\/|已購|付款成功|功能已解鎖/)
  const missing = renderImage(false, PLUGIN)
  assert.match(missing, /class="advanced-entry-button"/)
  assert.doesNotMatch(missing, /尚未下載/)
  const loading = renderImage(true, PLUGIN)
  assert.match(loading, /載入中…/)
  assert.doesNotMatch(loading, /advanced-entry-button/)
  assert.match(renderMessageContent(7, '[sticker]'), /貼圖・進階/)
  assert.match(renderMessageContent(0, '[sticker]'), /\[sticker\]/)
  assert.doesNotMatch(renderMessageContent(0, '[sticker]'), /貼圖・進階/)
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

test('L2: the first paint of the group-topics panel shows loading, never the empty-group sentence', async () => {
  const { renderGroupTopicsFirstPaint, PLUGIN } = await renderer()
  const html = renderGroupTopicsFirstPaint(PLUGIN)
  assert.ok(html.includes('載入中…'), 'loading line on first paint')
  assert.equal(html.includes('目前沒有可用群組'), false, 'no empty-group sentence before the first reply')
})
