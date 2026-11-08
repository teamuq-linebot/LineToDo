// Real-browser layout check for the zoom (up to 200%) + responsive layout work.  `npm run check:browser-layout`
//
// Not part of test:plugin (needs a Chromium-family browser; there is none on CI machines): with no browser it prints SKIP and exits 0.
// It bundles the REAL renderer (scripts/plugin/fixtures/browser-layout-entry.tsx, fake in-memory api) together with src/renderer/styles/index.css into one HTML file,
// opens it in a headless Chrome / Edge over the DevTools protocol and, for every scene x zoom x effective width, sets the viewport to (effective x zoom),
// stores the zoom in localStorage (lt-zoom, applied by the real installZoom) and measures the DOM:
//   - no horizontal page scrollbar, no inner horizontal scroller, no text clipped without an ellipsis
//   - no button / input / link / summary cut off by an ancestor or the viewport
//   - popups (modals, lightbox, menus) are inside the viewport
//   - breakpoints follow the EFFECTIVE width (window / zoom): the board is 2 columns up to 1000, chat is single column up to 760 (and 761 is two columns)
//   - the chat title bar (status line, 重試, 診斷 opened) does not overlap itself and stays inside the viewport
//   - the board draws 30 cards per column first and 30 more each time the column is scrolled to its bottom (scene board-lazy: 804 finished cards, scrolled to the end batch by batch)
// Options:  --zooms=1,1.25  --widths=640,1024  --scenes=board,settings  --shots=<dir>  --shot-zooms=2  --shot-widths=640  --list
// Browser:  LINE_TODO_BROWSER / CHROME_PATH / CHROMIUM_PATH, else the usual Edge / Chrome / Chromium install paths.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? true] : [a, true] }))
const list = (v, fallback) => (typeof v === 'string' ? v.split(',').map(Number) : fallback)

const ZOOMS = list(args.zooms, [1, 1.25, 1.5, 2])
const WIDTHS = list(args.widths, [640, 800, 1024, 1280])
const EFF_H = 720
const CONTAINER_BOARD_TWO = 1000
const CONTAINER_CHAT_ONE = 760

function skip(reason) { console.log(`SKIP check:browser-layout — ${reason}`); process.exit(0) }

function findBrowser() {
  const fromEnv = [process.env.LINE_TODO_BROWSER, process.env.CHROME_PATH, process.env.CHROMIUM_PATH].filter(Boolean)
  const local = process.env.LOCALAPPDATA ?? ''
  const candidates = [
    ...fromEnv,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', `${local}/Google/Chrome/Application/chrome.exe`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium'
  ]
  return candidates.find((p) => p && existsSync(p)) ?? null
}

const browserPath = findBrowser()
if (!browserPath) skip('no Chrome / Edge / Chromium found (set LINE_TODO_BROWSER to run it)')
if (typeof WebSocket === 'undefined' || typeof fetch === 'undefined') skip('this Node has no global WebSocket / fetch (needs Node 22+)')

let esbuild
try { esbuild = await import('esbuild') } catch { skip('esbuild is not installed') }

// ───────────── the page ─────────────

async function makePage(workDir) {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  const res = await esbuild.build({
    entryPoints: [resolve(ROOT, 'scripts', 'plugin', 'fixtures', 'browser-layout-entry.tsx')], write: false, bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', __LINE_TODO_PLUGIN_VERSION__: JSON.stringify(version) }, loader: { '.css': 'empty' }, logLevel: 'error', absWorkingDir: ROOT
  })
  const js = res.outputFiles[0].text.replace(/<\/script/g, '<\\/script')
  const css = readFileSync(join(ROOT, 'src', 'renderer', 'styles', 'index.css'), 'utf8')
  const html = join(workDir, 'page.html')
  writeFileSync(html, `<!DOCTYPE html><html data-theme="light"><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`)
  return pathToFileURL(html).href
}

// ───────────── DevTools protocol ─────────────

async function launch(workDir) {
  const port = 9300 + Math.floor(Math.random() * 600)
  const proc = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${port}`, `--user-data-dir=${join(workDir, 'profile')}`, '--window-size=1400,900', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' })
  let page
  for (let i = 0; i < 120 && !page; i += 1) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page') } catch { /* not up yet */ }
    if (!page) await sleep(250)
  }
  if (!page) { proc.kill(); throw new Error('the browser did not open a debugging page') }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('websocket failed')) })
  let id = 0
  const pending = new Map()
  const errors = []
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) }
    else if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text)
  }
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
    return r.result.result.value
  }
  await send('Page.enable'); await send('Runtime.enable')
  const click = async (x, y, button = 'left') => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1, buttons: button === 'left' ? 1 : 2 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 })
    await sleep(200)
  }
  const shot = async (file) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(file, Buffer.from(r.result.data, 'base64')) }
  const version = (await send('Browser.getVersion')).result?.product ?? 'unknown'
  const close = () => { try { ws.close() } catch { /* closed */ } proc.kill() }
  return { send, ev, click, shot, close, errors, version }
}

// ───────────── the measurement injected into the page ─────────────

const MEASURE = `(() => {
  const iw = innerWidth, ih = innerHeight
  const sel = (el) => { const c = (el.className && typeof el.className === 'string') ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''; return el.tagName.toLowerCase() + c }
  // visually-hidden helpers (.sr-only: 1px clipped box for screen readers) and the body of a closed <details> are not on screen
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); if (el.closest('.sr-only')) return false; const d = el.closest('details'); if (d && d !== el && !d.open && !el.closest('summary')) return false; return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' }
  const all = Array.from(document.querySelectorAll('body *')).filter(vis)
  const out = { iw, ih, docHScroll: document.documentElement.scrollWidth > iw + 1, docW: document.documentElement.scrollWidth, hscrollers: [], clipped: [], interactiveClipped: [], beyondViewport: [], headerOverlaps: [] }
  const seen = new Set()
  for (const el of all) {
    const cs = getComputedStyle(el)
    if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1) out.hscrollers.push({ el: sel(el), sw: el.scrollWidth, cw: el.clientWidth })
    if ((cs.overflowX === 'hidden' || cs.overflowX === 'clip') && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis') {
      const k = sel(el) + el.scrollWidth + '/' + el.clientWidth
      if (!seen.has(k)) { seen.add(k); out.clipped.push({ el: sel(el), sw: el.scrollWidth, cw: el.clientWidth, text: (el.textContent || '').trim().slice(0, 20) }) }
    }
  }
  const interactive = Array.from(document.querySelectorAll('button, a[href], input, select, textarea, summary, [role=menuitem], [role=tab]')).filter(vis)
  for (const el of interactive) {
    const r = el.getBoundingClientRect()
    let l = Math.max(0, r.left), rr = Math.min(iw, r.right), t = Math.max(0, r.top), b = Math.min(ih, r.bottom)
    let tt = t, bb = b, scrolledOut = false, anyScrollY = false
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p)
      if (cs.position === 'fixed') break
      const pr = p.getBoundingClientRect()
      const clipX = cs.overflowX !== 'visible', clipY = cs.overflowY !== 'visible'
      const scrollY = cs.overflowY === 'auto' || cs.overflowY === 'scroll'
      if (clipX) { l = Math.max(l, pr.left); rr = Math.min(rr, pr.right) }
      if (clipY && scrollY) { anyScrollY = true; if (r.bottom <= pr.top || r.top >= pr.bottom) scrolledOut = true; else { t = Math.max(t, pr.top); b = Math.min(b, pr.bottom) } }
      else if (clipY) { tt = Math.max(tt, pr.top); bb = Math.min(bb, pr.bottom) }
    }
    if (scrolledOut) continue
    const w = r.width, hgt = r.height
    const fx = w > 0 ? Math.max(0, rr - l) / w : 1
    const fy2 = hgt > 0 ? Math.max(0, Math.min(bb, Math.min(ih, r.bottom)) - Math.max(tt, Math.max(0, r.top))) / hgt : 1
    if (fx < 0.9 || (!anyScrollY && fy2 < 0.9)) out.interactiveClipped.push({ el: sel(el), text: (el.textContent || el.getAttribute('aria-label') || el.placeholder || '').trim().slice(0, 16), fx: Math.round(fx * 100) / 100, fy: Math.round(fy2 * 100) / 100, rect: [r.left, r.top, r.right, r.bottom].map(Math.round) })
  }
  for (const el of Array.from(document.querySelectorAll('.menu-pop, .kb-col-menu, [role=menu], .modal, .sm-lightbox img, .sm-lightbox'))) {
    if (!vis(el)) continue
    const r = el.getBoundingClientRect()
    if (r.right > iw + 1 || r.bottom > ih + 1 || r.left < -1 || r.top < -1) out.beyondViewport.push({ el: sel(el), rect: [r.left, r.top, r.right, r.bottom].map(Math.round), vp: [iw, ih] })
  }
  const header = document.querySelector('.app-header')
  if (header) {
    const items = Array.from(header.querySelectorAll('h1, .app-version, .dot, .stream-status, .stream-retry, .muted, .stream-diag > summary, .stream-diag-body, .app-tabs, .presentation-toggle, .presentation-error, .theme-toggle')).filter(vis)
    const rects = items.map((el) => ({ n: sel(el), r: el.getBoundingClientRect() }))
    for (let i = 0; i < rects.length; i += 1) for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i].r, c = rects[j].r
      if (a.left < c.right - 1 && c.left < a.right - 1 && a.top < c.bottom - 1 && c.top < a.bottom - 1 && !items[i].contains(items[j]) && !items[j].contains(items[i])) out.headerOverlaps.push(rects[i].n + ' x ' + rects[j].n)
    }
    out.headerH = Math.round(header.getBoundingClientRect().height)
    out.headerScrollW = header.scrollWidth - header.clientWidth
  }
  const ws = document.querySelector('.chat-workspace'); out.wsCols = ws ? getComputedStyle(ws).gridTemplateColumns.split(' ').length : null
  const kb = document.querySelector('.kb-board'); out.boardCols = kb ? getComputedStyle(kb).gridTemplateColumns.split(' ').length : null
  out.columnWidths = Array.from(document.querySelectorAll('.kb-column')).map((c) => Math.round(c.getBoundingClientRect().width))
  out.zoomStyle = document.documentElement.style.zoom
  out.interactiveClipped = out.interactiveClipped.slice(0, 8); out.clipped = out.clipped.slice(0, 8); out.hscrollers = out.hscrollers.slice(0, 6)
  return out
})()`

// ───────────── scenes ─────────────

/** 804 finished cards (4 of the base fixture + 800 from ?many=1): 30 drawn first, then every scroll to the bottom of the column adds whole batches of 30 until all 804 are there; the title keeps saying 804 throughout */
async function runLazyBoard(h) {
  const cards = () => h.ev("document.querySelectorAll('.col-done .todo-card').length")
  const count = () => h.ev("(document.querySelector('.col-done .kb-col-count') || {}).textContent")
  const first = await cards()
  if (first !== 30) throw new Error(`first batch is ${first} cards, wanted 30`)
  const TOTAL = 804
  if ((await count()) !== String(TOTAL)) throw new Error(`column count is ${await count()} before scrolling, wanted ${TOTAL}`)
  if (!(await h.ev("(() => { const b = document.querySelector('.col-done .kb-col-body'); return b.scrollHeight > b.clientHeight })()"))) throw new Error('the 30 first cards do not overflow the column')
  const seq = [first]
  for (let guard = 0; guard < 60 && seq[seq.length - 1] < TOTAL; guard += 1) {
    await h.ev("(() => { const b = document.querySelector('.col-done .kb-col-body'); b.scrollTop = b.scrollHeight })()")
    const t0 = Date.now()
    let n = seq[seq.length - 1]
    while (Date.now() - t0 < 4000 && n === seq[seq.length - 1]) { await sleep(40); n = await cards() }
    if (n === seq[seq.length - 1]) throw new Error(`stuck at ${n} cards after scrolling to the bottom (sequence ${seq.join(',')})`)
    seq.push(n)
  }
  await sleep(300)
  const last = await cards()
  if (last !== TOTAL) throw new Error(`ended at ${last} cards, wanted ${TOTAL} (sequence ${seq.join(',')})`)
  if ((await count()) !== String(TOTAL)) throw new Error('column count changed while loading')
  if (await h.ev("!!document.querySelector('.col-done .kb-col-sentinel')")) throw new Error('the sentinel is still there with everything drawn')
  if (seq.some((n, i) => i > 0 && (n - seq[i - 1]) % 30 !== 0 && n !== TOTAL)) throw new Error(`a batch was not a multiple of 30: ${seq.join(',')}`)
  h.note = `batches ${seq.length - 1}, first ${seq[0]}, second ${seq[1]}, last ${last}`
}

const textClick = (sel, text, n = 0) => `(() => { const l = Array.from(document.querySelectorAll(${JSON.stringify(sel)})).filter((e) => (e.textContent || '').includes(${JSON.stringify(text)})); return l[${n}] ? (l[${n}].click(), true) : false })()`
const LIGHTBOX = `(() => { const d = document.createElement('div'); d.className = 'sm-lightbox'; d.innerHTML = '<img alt="x" src="data:image/svg+xml;utf8,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%272400%27 height=%271800%27%3E%3Crect width=%272400%27 height=%271800%27 fill=%27%239ec2f5%27/%3E%3C/svg%3E">'; document.querySelector('.chat-stream').appendChild(d) })()`

/** run(h): drives the page; expect: selectors that must be visible afterwards (a scene that silently shows nothing must not pass); cols: which layout rule applies. */
const SCENES = [
  { id: 'board', tab: 'board', cols: 'board', expect: ['.kb-board', '.kb-column'] },
  { id: 'board-lazy', tab: 'board', many: true, widths: [640, 1024, 1280], cols: 'board', expect: ['.kb-board', '.col-done .todo-card'], run: runLazyBoard },
  { id: 'board-cardmenu', tab: 'board', cols: 'board', expect: ['.menu-pop'], run: async (h) => { await h.clickSel('.menu-trigger', 0) } },
  { id: 'board-cardmenu-low', tab: 'board', cols: 'board', expect: ['.menu-pop'], run: async (h) => { await h.ev('document.querySelectorAll(".kb-col-body")[0].scrollTop = 1e6'); await sleep(150); const first = '.kb-column:first-child .menu-trigger'; const n = await h.ev(`document.querySelectorAll('${first}').length`); const visible = await h.ev(`(() => { const l = Array.from(document.querySelectorAll('${first}')); let k = -1; l.forEach((e, i) => { const r = e.getBoundingClientRect(); if (r.top >= 0 && r.bottom <= innerHeight) k = i }); return k })()`); await h.clickSel(first, visible >= 0 ? visible : n - 1) } },
  { id: 'board-colmenu', tab: 'board', cols: 'board', expect: ['.kb-col-menu'], run: async (h) => { const c = await h.center('.kb-col-head', 0); if (c) await h.click(c.x - 20, c.y, 'right') } },
  { id: 'board-source-modal', tab: 'board', cols: 'board', expect: ['.source-modal'], run: async (h) => { await h.clickSel('.card-source .link-btn', 0); await sleep(300) } },
  { id: 'board-draft-modal', tab: 'board', cols: 'board', expect: ['.draft-modal'], run: async (h) => { await h.clickSel('.menu-trigger', 0); await h.ev(textClick('.menu-pop .menu-item', '草擬回覆')); await sleep(400) } },
  { id: 'stream-list', tab: 'stream', cols: 'chat', expect: ['.chat-workspace', '.chat-list-row'] },
  { id: 'stream-listmenu', tab: 'stream', cols: 'chat', expect: ['[role=menu]'], run: async (h) => { const c = await h.center('.chat-list-row', 2); if (c) await h.click(c.x, c.y, 'right') } },
  { id: 'stream-chat', tab: 'stream', cols: 'chat', expect: ['.chat-message'], run: async (h) => { await h.ev(`document.querySelector('.chat-list-item')?.click()`); await sleep(500) } },
  { id: 'stream-topicsTodos', tab: 'stream', cols: 'chat', expect: ['.chat-topics-todos-content', '.group-topic-card', '.chat-todo-card'], run: async (h) => { await h.ev(`document.querySelector('.chat-list-item')?.click()`); await sleep(400); await h.ev(textClick('.chat-pane-view-toggle button', '議題與待辦')); await waitVisible(h, '.group-topic-card') } },
  { id: 'stream-aiSettings', tab: 'stream', cols: 'chat', expect: ['.chat-pane-view-toggle'], run: async (h) => { await h.ev(`document.querySelector('.chat-list-item')?.click()`); await sleep(400); await h.ev(textClick('.chat-pane-view-toggle button', 'AI')); await sleep(500) } },
  { id: 'stream-lightbox', tab: 'stream', cols: 'chat', expect: ['.sm-lightbox img'], run: async (h) => { await h.ev(LIGHTBOX); await sleep(300) } },
  { id: 'topics', tab: 'topics', expect: ['.group-topics-panel', '.group-topic-card'], run: async (h) => { await waitVisible(h, '.group-topic-card') } },
  { id: 'settings', tab: 'settings', expect: ['.settings-wrap'], run: async () => { await sleep(400) } },
  { id: 'settings-view', tab: 'settings', mode: 'settings', expect: ['.settings-wrap'], run: async () => { await sleep(400) } },
  // chat title bar: the bridge status line (dot, text, 重試, 重啟 N 次, 診斷) lives in the header; F5 of the chat-menu review
  { id: 'header-chat', tab: 'stream', phase: 'timeout', widths: [420, 640, 1280], cols: 'chat', expect: ['.stream-status', '.stream-retry', '.stream-diag'] },
  { id: 'header-diag', tab: 'stream', phase: 'timeout', widths: [420, 640, 1280], cols: 'chat', expect: ['.stream-diag[open]', '.stream-diag-body'], run: async (h) => { await h.clickSel('.stream-diag > summary', 0); await sleep(500) } }
]
// the 760 / 761 breakpoint (inclusive 760 = single column)
const BOUNDARY = { widths: [760, 761], scenes: ['stream-list', 'stream-chat'] }

if (args.list) { console.log(SCENES.map((s) => s.id).join('\n')); process.exit(0) }

// ───────────── judging ─────────────

async function waitVisible(h, selector, ms = 20000) {
  for (let waited = 0; waited < ms; waited += 100) { if ((await visibleCount(h, selector)) > 0) return; await sleep(100) }
}

async function visibleCount(h, selector) {
  return h.ev(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' }).length`)
}

async function judge(h, scene, z, eff, m) {
  const bad = []
  if (m.errors.length) bad.push(`page error: ${m.errors[0]}`.slice(0, 200))
  for (const s of scene.expect ?? []) if ((await visibleCount(h, s)) === 0) bad.push(`missing ${s}`)
  if (m.docHScroll) bad.push(`page scrolls horizontally (scrollWidth ${m.docW} > ${m.iw})`)
  if (m.hscrollers.length) bad.push(`inner horizontal scroller ${JSON.stringify(m.hscrollers[0])}`)
  if (m.clipped.length) bad.push(`clipped text ${JSON.stringify(m.clipped[0])}`)
  if (m.interactiveClipped.length) bad.push(`control cut off ${JSON.stringify(m.interactiveClipped[0])}`)
  if (m.beyondViewport.length) bad.push(`popup outside the viewport ${JSON.stringify(m.beyondViewport[0])}`)
  if (m.headerOverlaps.length) bad.push(`title bar items overlap: ${m.headerOverlaps.slice(0, 3).join('; ')}`)
  if (m.headerScrollW > 1) bad.push(`title bar wider than its box by ${m.headerScrollW}px`)
  const expectedZoom = z === 1 ? '' : String(z)
  if (m.zoomStyle !== expectedZoom) bad.push(`zoom not applied (html zoom "${m.zoomStyle}", wanted "${expectedZoom}")`)
  if (scene.cols === 'board' && m.boardCols !== (eff <= CONTAINER_BOARD_TWO ? 2 : 4)) bad.push(`board has ${m.boardCols} columns at effective ${eff}`)
  if (scene.cols === 'chat' && m.wsCols !== null && m.wsCols !== (eff <= CONTAINER_CHAT_ONE ? 1 : 2)) bad.push(`chat has ${m.wsCols} columns at effective ${eff}`)
  return bad
}

// ───────────── run ─────────────

const workDir = mkdtempSync(join(tmpdir(), 'lt-layout-'))
const shotDir = typeof args.shots === 'string' ? resolve(args.shots) : null
if (shotDir) mkdirSync(shotDir, { recursive: true })
const shotZooms = list(args['shot-zooms'], [1, 2])
const shotWidths = list(args['shot-widths'], [640, 420])
const only = typeof args.scenes === 'string' ? args.scenes.split(',') : null
const url = await makePage(workDir)
const h = await launch(workDir)
const cleanup = () => { h.close(); setTimeout(() => { try { rmSync(workDir, { recursive: true, force: true }) } catch { /* the browser may still hold the profile */ } }, 800) }

const supported = await h.ev("CSS.supports('container-type', 'inline-size')")
if (!supported) { cleanup(); skip(`${h.version} has no container queries`) }

h.center = (selector, n = 0) => h.ev(`(() => { const e = document.querySelectorAll(${JSON.stringify(selector)})[${n}]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 } })()`)
h.clickSel = async (selector, n = 0, button = 'left') => { const c = await h.center(selector, n); if (!c) return false; await h.click(c.x, c.y, button); return true }

async function waitFor(expression, ms = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { try { if (await h.ev(expression)) return true } catch { /* navigating */ } await sleep(60) }
  return false
}

async function openScene(scene, z, eff) {
  await h.send('Emulation.setDeviceMetricsOverride', { width: Math.round(eff * z), height: Math.round(EFF_H * z), deviceScaleFactor: 1, mobile: false })
  const query = [scene.mode ? `mode=${scene.mode}` : '', scene.many ? 'many=1' : '', scene.phase ? `phase=${scene.phase}` : ''].filter(Boolean).join('&')
  await h.send('Page.navigate', { url: 'about:blank' })
  await h.send('Page.navigate', { url: url + (query ? `?${query}` : '') })
  await waitFor("document.readyState === 'complete' && location.protocol === 'file:'")
  await h.ev(`localStorage.clear(); localStorage.setItem('lt-ui:app.tab', JSON.stringify({ v: ${JSON.stringify(scene.tab)}, at: Date.now() })); localStorage.setItem('lt-zoom', ${JSON.stringify(String(z))}); window.__marker = 1`)
  await h.send('Page.reload')
  await waitFor("!window.__marker && document.readyState === 'complete' && document.querySelectorAll('#root *').length > 5")
  await sleep(450)
}

const results = []
let failures = 0
const runs = []
for (const scene of SCENES) {
  if (only && !only.includes(scene.id)) continue
  for (const z of ZOOMS) for (const eff of scene.widths ?? WIDTHS) runs.push({ scene, z, eff, boundary: false })
}
if (!only || BOUNDARY.scenes.some((s) => only.includes(s))) {
  for (const id of BOUNDARY.scenes) {
    const scene = SCENES.find((s) => s.id === id)
    if (only && !only.includes(id)) continue
    for (const z of ZOOMS) for (const eff of BOUNDARY.widths) runs.push({ scene, z, eff, boundary: true })
  }
}

console.log(`check:browser-layout — ${h.version}, ${runs.length} runs (zooms ${ZOOMS.join('/')}, effective widths ${WIDTHS.join('/')} + header 420 + boundary 760/761)`)
for (const { scene, z, eff, boundary } of runs) {
  h.errors.length = 0
  h.note = ''
  let bad = []
  let m = null
  try {
    await openScene(scene, z, eff)
    if (scene.run) await scene.run(h)
    await sleep(300)
    m = await h.ev(MEASURE)
    m.errors = h.errors.slice(0, 2)
    bad = await judge(h, scene, z, eff, m)
    if (shotDir && shotZooms.includes(z) && shotWidths.includes(eff) && !boundary) await h.shot(join(shotDir, `${scene.id}__zoom${z}__eff${eff}.png`))
  } catch (error) {
    bad = [`run failed: ${String(error).slice(0, 200)}`]
  }
  const label = `${scene.id} zoom ${z} eff ${eff}${boundary ? ' (boundary)' : ''}`
  results.push({ label, ok: bad.length === 0, bad, boardCols: m?.boardCols ?? null, wsCols: m?.wsCols ?? null })
  if (bad.length) { failures += 1; console.log(`FAIL ${label}\n     ${bad.join('\n     ')}`) } else console.log(`PASS ${label}${m?.boardCols ? ` board=${m.boardCols}col` : ''}${m?.wsCols ? ` chat=${m.wsCols}col` : ''}${h.note ? ` ${h.note}` : ''}`)
}

if (shotDir) writeFileSync(join(shotDir, 'results.json'), JSON.stringify(results, null, 1))
cleanup()
console.log(failures === 0 ? `check:browser-layout PASS — ${runs.length}/${runs.length}` : `check:browser-layout FAIL — ${failures} of ${runs.length}`)
await sleep(900)
process.exit(failures === 0 ? 0 : 1)
