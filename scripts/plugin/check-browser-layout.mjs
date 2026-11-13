// Real-browser layout check for the zoom (up to 200%) + responsive layout work.  `npm run check:browser-layout`
//
// Not part of test:plugin (needs a Chromium-family browser; there is none on CI machines): with no browser it prints SKIP and exits 0.
// It bundles the REAL renderer (scripts/plugin/fixtures/browser-layout-entry.tsx, fake in-memory api) together with src/renderer/styles/index.css into one HTML file,
// opens it in a headless Chrome / Edge over the DevTools protocol and, for every scene x zoom x effective width, sets the viewport to (effective x zoom),
// stores the zoom in localStorage (lt-zoom, applied by the real installZoom) and measures the DOM:
//   - no horizontal page scrollbar, no inner horizontal scroller, no text clipped without an ellipsis
//   - no button / input / link / summary cut off by an ancestor or the viewport
//   - popups (modals, lightbox, menus) are inside the viewport
//   - breakpoints follow the EFFECTIVE width (window / zoom): the board is 2 columns up to 1000 and 4 from 1001, chat is single column up to 760 (and 761 is two columns)
//   - the chat title bar (status line, 重試, 診斷 opened) does not overlap itself and stays inside the viewport
//   - the board draws 30 cards per column first and 30 more each time the column is scrolled to its bottom (scene board-lazy: 804 finished cards, scrolled to the end batch by batch)
// Options:  --zooms=1,1.25  --widths=640,1024  --scenes=board,settings  --shots=<dir>  --shot-zooms=2  --shot-widths=640  --list
// Browser:  LINE_TODO_BROWSER / CHROME_PATH / CHROMIUM_PATH, else the usual Edge / Chrome / Chromium install paths.
// Robustness: every DevTools call has a CDP_TIMEOUT_MS deadline and a closed / crashed connection rejects at once, so no call can hang the script (it used to exit 13 on an unsettled await).
//   A run that hits one of those restarts the browser and is retried (CDP_ATTEMPTS tries in all), then FAILS with a plain message.
//   On every way out the whole browser process tree (not just the root process) and the temp profile are removed.
import { spawn, spawnSync } from 'node:child_process'
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
const CDP_TIMEOUT_MS = 30000
const CDP_ATTEMPTS = 3

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
  const cssPath = args.css === 'deployed' ? join(ROOT, 'dist', 'dev-link', 'ui', 'main.css') : join(ROOT, 'src', 'renderer', 'styles', 'index.css')
  const css = readFileSync(cssPath, 'utf8')
  const html = join(workDir, 'page.html')
  const photoFixture = args.scenes?.split(',').includes('stream-photo-cache') ? (() => {
    const root = 'C:/Users/david/.teamuq/plugins/data/tuqdev.line-todo/media-cache'
    const assets = [
      ['i:actual-photo-a', '1a5912a72e9f4de8a306a4bf3adaf750.jpg', 149943, '2026-11-04T20:09:23.862+08:00'],
      ['i:actual-photo-b', '81d4927ad49bdaaafa3e3a4ff2311274.jpg', 160696, '2026-11-04T20:09:22.717+08:00'],
      ['i:actual-photo-c', 'ca2c5437b64b055948e785a6e60580cf.jpg', 142386, '2026-11-04T20:09:20.665+08:00']
    ]
    const urls = {}
    const rows = assets.map(([msgId, filename, fileSize, timeIso]) => {
      urls[msgId] = `data:image/jpeg;base64,${readFileSync(join(root, filename)).toString('base64')}`
      return { msgId, chatId: 'c1', ts: Date.parse(timeIso), timeIso: timeIso.slice(0, 19), direction: 'in', sender: '潘奕奇', text: null, contentType: 1, processed: true, ingestedAt: timeIso, origFilename: null, fileSize, unsent: false }
    })
    return { rows, urls }
  })() : null
  const fixtureScript = photoFixture ? `<script>window.__actualPhotoFixture=${JSON.stringify(photoFixture).replace(/</g, '\\u003c')}</script>` : ''
  writeFileSync(html, `<!DOCTYPE html><html data-theme="light"><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div>${fixtureScript}<script>${js}</script></body></html>`)
  return pathToFileURL(html).href
}

// ───────────── DevTools protocol ─────────────

/** a DevTools-level failure (no answer in time, connection closed, browser gone): the run is retried on a fresh browser; anything else is a real finding */
class CdpError extends Error {}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** Kills the browser's whole process tree (proc.kill() alone leaves the renderer / GPU / crashpad children running), then anything still started with this profile, then removes the profile. Synchronous and safe to call twice. */
function teardown(proc, workDir) {
  const profile = join(workDir, 'profile')
  try {
    if (proc?.pid) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 20000 })
      else { try { process.kill(-proc.pid, 'SIGKILL') } catch { proc.kill('SIGKILL') } }
    }
  } catch { /* already gone */ }
  try {
    if (process.platform === 'win32') {
      const script = 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:LT_PROFILE) } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }'
      spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true, timeout: 30000, env: { ...process.env, LT_PROFILE: profile } })
    } else spawnSync('pkill', ['-9', '-f', profile], { stdio: 'ignore', timeout: 10000 })
  } catch { /* nothing left to find */ }
  sleepSync(300)
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch { /* the work dir removal at the end tries again */ }
}

async function launch(workDir) {
  const port = 9300 + Math.floor(Math.random() * 600)
  const proc = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${port}`, `--user-data-dir=${join(workDir, 'profile')}`, '--window-size=1400,900', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore', detached: process.platform !== 'win32' })
  proc.on('error', () => { /* shows up as "did not open a debugging page" */ })
  let page
  for (let i = 0; i < 120 && !page; i += 1) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json()).find((t) => t.type === 'page') } catch { /* not up yet */ }
    if (!page) await sleep(250)
  }
  if (!page) { teardown(proc, workDir); throw new CdpError('the browser did not open a debugging page') }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  try { await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('websocket failed')); setTimeout(() => j(new Error('websocket open timed out')), 10000) }) } catch (error) { teardown(proc, workDir); throw new CdpError(String(error.message)) }
  let id = 0
  const pending = new Map()
  const errors = []
  let dead = ''
  const failAll = (why) => { dead ||= why; for (const [i, p] of pending) { clearTimeout(p.timer); p.reject(new CdpError(dead)); pending.delete(i) } }
  ws.onclose = () => failAll('the DevTools connection closed')
  ws.onerror = () => failAll('the DevTools connection failed')
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); clearTimeout(p.timer); pending.delete(d.id); p.resolve(d) }
    else if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text)
    else if (d.method === 'Inspector.targetCrashed') failAll('the page crashed')
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (dead) { reject(new CdpError(dead)); return }
    const i = ++id
    const timer = setTimeout(() => { pending.delete(i); reject(new CdpError(`no answer to ${method} within ${CDP_TIMEOUT_MS} ms`)) }, CDP_TIMEOUT_MS)
    pending.set(i, { resolve, reject, timer })
    try { ws.send(JSON.stringify({ id: i, method, params })) } catch (error) { clearTimeout(timer); pending.delete(i); reject(new CdpError(`could not send ${method}: ${error.message}`)) }
  })
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
  const close = () => { dead ||= 'closed'; try { ws.close() } catch { /* closed */ } teardown(proc, workDir) }
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

async function runPhotoGeometry(h) {
  await h.ev(`document.querySelector('.chat-list-item')?.click()`)
  await sleep(600)
  await h.ev(`(() => {
    const list = document.querySelector('.chat-message-list')
    const makeImage = (name, width, height) => {
      const media = document.createElement('div'); media.className = 'sm-media'
      const image = document.createElement('img'); image.className = 'sm-thumb'; image.alt = name
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '"><rect width="100%" height="100%" fill="#9ec2f5"/></svg>'
      image.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg)
      media.appendChild(image); return media
    }
    // Mock-api fixture shaped exactly like MessageStream's PhotoGroupRow / MediaImage DOM.
    const incoming = document.createElement('li'); incoming.className = 'chat-message incoming chat-message-photo-group'; incoming.dataset.photoCount = '3'
    const avatar = document.createElement('span'); avatar.className = 'chat-message-avatar'; avatar.textContent = '測'
    const incomingContent = document.createElement('div'); incomingContent.className = 'chat-message-content'
    const sender = document.createElement('span'); sender.className = 'chat-message-sender'; sender.textContent = '測試發話者'
    const incomingBottom = document.createElement('div'); incomingBottom.className = 'chat-message-bottom-row'
    const incomingBubble = document.createElement('div'); incomingBubble.className = 'chat-message-bubble attachment'
    const grid = document.createElement('div'); grid.className = 'chat-message-photo-grid chat-message-photo-grid-three'
    for (const [name, width, height] of [['group-1', 1600, 900], ['group-2', 1200, 900], ['group-3', 900, 1200]]) grid.appendChild(makeImage(name, width, height))
    incomingBubble.appendChild(grid); const incomingTime = document.createElement('time'); incomingTime.className = 'chat-message-time'; incomingTime.textContent = '20:09'
    incomingBottom.appendChild(incomingBubble); incomingBottom.appendChild(incomingTime); incomingContent.appendChild(sender); incomingContent.appendChild(incomingBottom)
    incoming.appendChild(avatar); incoming.appendChild(incomingContent); list.appendChild(incoming)
    const fixtures = [['landscape', 1600, 900], ['portrait', 900, 1600], ['small', 640, 480]]
    for (const [name, width, height] of fixtures) {
      const row = document.createElement('li')
      row.className = 'chat-message outgoing chat-message-photo'
      const content = document.createElement('div'); content.className = 'chat-message-content'
      const bottom = document.createElement('div'); bottom.className = 'chat-message-bottom-row'
      const time = document.createElement('time'); time.className = 'chat-message-time'; time.textContent = '15:51'
      const bubble = document.createElement('div'); bubble.className = 'chat-message-bubble attachment photo-attachment'
      const body = document.createElement('div'); body.className = 'chat-message-body'
      body.appendChild(makeImage(name, width, height)); bubble.appendChild(body)
      bottom.appendChild(time); bottom.appendChild(bubble); content.appendChild(bottom); row.appendChild(content); list.appendChild(row)
    }
    return true
  })()`)
  await h.ev(`Promise.all(Array.from(document.querySelectorAll('.chat-message-photo-group img.sm-thumb, .chat-message.outgoing.chat-message-photo img.sm-thumb'), (image) => image.decode().catch(() => undefined)))`)
  await h.ev(`(() => { const log = document.querySelector('.chat-message-log'); log.scrollTop = log.scrollHeight; return true })()`)
  await sleep(200)
  const boxes = await h.ev(`Array.from(document.querySelectorAll('.chat-message.outgoing.chat-message-photo')).filter((row) => row.querySelector('.sm-thumb')).map((row) => {
    const rect = (selector) => { const element = selector === '.chat-message' ? row : row.querySelector(selector); const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } }
    const image = row.querySelector('.sm-thumb')
    return { nativeWidth: image.naturalWidth, nativeHeight: image.naturalHeight, row: rect('.chat-message'), content: rect('.chat-message-content'), wrapper: rect('.sm-media'), image: rect('.sm-thumb'), time: rect('.chat-message-time'), timeGap: rect('.sm-thumb').left - rect('.chat-message-time').right }
  })`)
  if (boxes.length !== 3) {
    const diagnostic = await h.ev(`({ rows: document.querySelectorAll('.chat-message').length, photos: document.querySelectorAll('.chat-message-photo').length, images: document.querySelectorAll('.sm-thumb').length, ids: Array.from(document.querySelectorAll('.chat-message-photo')).map((row) => ({ cls: row.className, text: row.textContent?.slice(0, 80) })) })`)
    throw new Error(`expected 3 outgoing realistic photo rows, got ${boxes.length}; ${JSON.stringify(diagnostic)}`)
  }
  const edges = boxes.map((box) => box.image.right)
  if (Math.max(...edges) - Math.min(...edges) > 1) throw new Error(`outgoing image right edges differ: ${edges.join(', ')}`)
  for (const [i, box] of boxes.entries()) {
    if (box.nativeWidth === 0 || box.nativeHeight === 0) throw new Error(`photo ${i} native image did not load: ${JSON.stringify(box)}`)
    if (box.time.right > box.image.left || box.image.left - box.time.right > 8) throw new Error(`photo ${i} time is not adjacent to its actual image: ${JSON.stringify(box)}`)
    if (Math.abs(box.time.bottom - box.image.bottom) > 5) throw new Error(`photo ${i} time is not aligned with the image lower edge: ${JSON.stringify(box)}`)
  }
  const widths = boxes.map((box) => box.image.width)
  if (new Set(widths.map((width) => Math.round(width))).size < 2) throw new Error(`fixture did not preserve varied intrinsic image widths: ${widths.join(', ')}`)
  const incomingGroup = await h.ev(`(() => { const row = document.querySelector('.chat-message-photo-group'); return row ? { count: row.querySelectorAll('.chat-message-photo-grid img').length, header: row.querySelector('.chat-message-sender')?.textContent, time: row.querySelector('.chat-message-time')?.textContent, visible: row.getBoundingClientRect().width > 0 && row.querySelectorAll('.chat-message-photo-grid img').length === 3, native: Array.from(row.querySelectorAll('img')).map((image) => [image.naturalWidth, image.naturalHeight]) } : null })()`)
  if (!incomingGroup?.visible || incomingGroup.native.some(([width, height]) => width === 0 || height === 0)) throw new Error(`same-minute incoming triple fixture failed: ${JSON.stringify(incomingGroup)}`)
  h.photoBoxes = { incomingGroup, outgoingRows: boxes }
  h.note = `photo img-right=${edges.map((edge) => edge.toFixed(1)).join('/')}; image-widths=${widths.map((width) => width.toFixed(1)).join('/')}; time-adjacent=true`
}

async function runPhotoCache(h) {
  await h.ev(`document.querySelector('.chat-list-item')?.click()`)
  await sleep(700)
  await h.ev(`Promise.all(Array.from(document.querySelectorAll('.chat-message-photo-group img.sm-thumb'), (image) => image.decode().catch(() => undefined)))`)
  await h.ev(`(() => { const log = document.querySelector('.chat-message-log'); if (log) log.scrollTop = log.scrollHeight; return true })()`)
  await sleep(500)
  const facts = await h.ev(`(() => {
    const row = document.querySelector('.chat-message-photo-group')
    if (!row) return null
    const grid = row.querySelector('.chat-message-photo-grid')
    const images = Array.from(grid?.querySelectorAll('img.sm-thumb') ?? [])
    const layers = [row, row.querySelector('.chat-message-bubble'), grid, ...images.flatMap((image) => [image.parentElement, image])].filter(Boolean)
    return { count: images.length, mediaStates: Array.from(row.querySelectorAll('.sm-media-missing')).map((node) => node.textContent), sender: row.querySelector('.chat-message-sender')?.textContent, time: row.querySelector('.chat-message-time')?.textContent,
      dataAvatarId: row.getAttribute('data-avatar-message-id'), uniqueSources: new Set(images.map((image) => image.currentSrc)).size,
      images: images.map((image) => { const r = image.getBoundingClientRect(); return { natural: [image.naturalWidth, image.naturalHeight], box: [r.left, r.top, r.right, r.bottom] } }),
      layers: layers.map((element) => { const style = getComputedStyle(element); const r = element.getBoundingClientRect(); return { tag: element.tagName, cls: element.className?.baseVal ?? element.className, opacity: style.opacity, filter: style.filter, transform: style.transform, viewTransitionName: style.viewTransitionName, box: [r.left, r.top, r.right, r.bottom], background: style.backgroundColor } }),
      avatarRequested: Boolean(window.__actualPhotoAvatarRequests?.some((request) => Array.isArray(request.ids) && request.ids.includes('i:actual-photo-c')))
    }
  })()`)
  if (!facts || facts.count !== 3 || facts.uniqueSources !== 3) {
    const diagnostic = await h.ev(`({ mediaLookupCount: window.__actualPhotoMediaLookups?.length ?? 0, mediaProvidedCount: window.__actualPhotoMediaLookups?.filter((item) => item.supplied).length ?? 0, avatarRequestedGroup: Boolean(window.__actualPhotoAvatarRequests?.some((request) => Array.isArray(request.ids) && request.ids.includes('i:actual-photo-c'))), rows: document.querySelectorAll('.chat-message').length, groups: document.querySelectorAll('.chat-message-photo-group').length, images: document.querySelectorAll('.sm-thumb').length })`)
    throw new Error(`actual media assets missing or duplicated in renderer: ${JSON.stringify(facts)}`)
  }
  if (facts.images.some(({ natural }) => natural[0] !== 1474 || natural[1] !== 1110)) throw new Error(`actual cache dimensions did not survive the production MediaImage branch: ${JSON.stringify(facts.images)}`)
  const rects = facts.images.map(({ box }) => box)
  const overlaps = []
  for (let a = 0; a < rects.length; a += 1) for (let b = a + 1; b < rects.length; b += 1) {
    if (Math.min(rects[a][2], rects[b][2]) > Math.max(rects[a][0], rects[b][0]) && Math.min(rects[a][3], rects[b][3]) > Math.max(rects[a][1], rects[b][1])) overlaps.push([a, b])
  }
  if (overlaps.length) throw new Error(`actual photo grid images geometrically overlap: ${JSON.stringify(overlaps)}`)
  if (!facts.avatarRequested) throw new Error('real MessageStream group row did not request its first-message avatar through the visible-row observer')
  const diagnosticsBeforeClick = await h.ev(`({ closed: !document.querySelector('.stream-diag')?.open, textareaCount: document.querySelectorAll('.stream-diag-photo-tools textarea').length })`)
  if (!diagnosticsBeforeClick.closed || diagnosticsBeforeClick.textareaCount !== 0) throw new Error('photo diagnostics should remain opt-in while the existing panel is closed')
  const photoDiagnostics = await h.ev(`(async () => {
    const panel = document.querySelector('.stream-diag')
    if (!panel) return { error: 'panel missing' }
    panel.open = true
    await new Promise((resolve) => setTimeout(resolve, 40))
    const button = Array.from(panel.querySelectorAll('button')).find((item) => item.textContent.includes('收集／複製圖片顯示資訊'))
    if (!button) return { error: 'button missing' }
    button.click()
    await new Promise((resolve) => setTimeout(resolve, 80))
    const textarea = panel.querySelector('textarea[aria-label="圖片顯示資訊，可手動複製"]')
    return textarea ? { payload: textarea.value, status: panel.querySelector('[role="status"]')?.textContent ?? '' } : { error: 'fallback payload missing' }
  })()`)
  if (!photoDiagnostics.payload) throw new Error(`opt-in photo diagnostics failed: ${JSON.stringify(photoDiagnostics)}`)
  const parsedDiagnostics = JSON.parse(photoDiagnostics.payload)
  const diagText = photoDiagnostics.payload
  if (parsedDiagnostics.imageCount !== 3 || parsedDiagnostics.distinctSourceCount !== 3 || parsedDiagnostics.groups[0]?.images[0]?.natural?.width !== 1474) throw new Error('photo diagnostics omitted the actual visible group rendering facts')
  if (/actual-photo|data:image|tuqplugin:|https?:\/\/|msgId|chatId|潘奕奇|毛多多/i.test(diagText)) throw new Error('photo diagnostics leaked an identifier, message text, or raw URL')
  const serializedLayers = JSON.stringify(parsedDiagnostics.groups.flatMap((group) => group.images.flatMap((image) => image.layers)))
  if (/url\(|https?:\/\//i.test(serializedLayers) || parsedDiagnostics.groups.some((group) => group.images.some((image) => image.layers.some((layer) => typeof layer.hasBackgroundImage !== 'boolean')))) throw new Error('photo diagnostics emitted a background image URL or source value')
  const zoom = await h.ev(`localStorage.getItem('lt-zoom') ?? '1'`)
  if (shotDir && shotWidths.includes(1280)) await h.shot(join(shotDir, `actual-cache-preview__zoom${zoom}__eff1280.png`))
  await h.ev(`document.querySelector('.chat-message-photo-grid img.sm-thumb')?.click()`)
  await sleep(200)
  const lightbox = await h.ev(`(() => { const image = document.querySelector('.sm-lightbox img'); return image ? { src: image.currentSrc, natural: [image.naturalWidth, image.naturalHeight], box: (() => { const r = image.getBoundingClientRect(); return [r.width, r.height] })() } : null })()`)
  const previewSource = await h.ev(`document.querySelector('.chat-message-photo-grid img.sm-thumb')?.currentSrc ?? null`)
  if (!lightbox || lightbox.src !== previewSource || lightbox.natural[0] !== 1474 || lightbox.natural[1] !== 1110) throw new Error('lightbox did not render the same original 1474x1110 URL as preview')
  h.actualPhotoFacts = {
    count: facts.count,
    uniqueSources: facts.uniqueSources,
    images: facts.images,
    layers: facts.layers,
    avatarRequested: facts.avatarRequested,
    overlaps,
    diagnostics: { imageCount: parsedDiagnostics.imageCount, distinctSourceCount: parsedDiagnostics.distinctSourceCount, hasSensitiveValues: false, manualCopyFallback: photoDiagnostics.status.includes('手動複製') }
  }
  h.actualLightboxFacts = { sameUrl: lightbox.src === previewSource, natural: lightbox.natural, box: lightbox.box }
  h.note = `actual cache imgs=${facts.count}, natural=1474x1110 x3, distinct URLs=${facts.uniqueSources}, overlap=${overlaps.length}, avatar-request=true, lightbox-same-url=true, opt-in-diagnostics=3-without-identifiers`
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
  { id: 'stream-photo-geometry', tab: 'stream', height: 1100, widths: [1280], cols: 'chat', expect: ['.chat-message'], run: runPhotoGeometry },
  { id: 'stream-photo-cache', tab: 'stream', height: 1100, widths: [1280], cols: 'chat', photoCache: true, expect: ['.chat-message-photo-group img.sm-thumb'], run: runPhotoCache },
  { id: 'stream-topicsTodos', tab: 'stream', cols: 'chat', expect: ['.chat-topics-todos-content', '.group-topic-card', '.chat-todo-card'], run: async (h) => { await h.ev(`document.querySelector('.chat-list-item')?.click()`); await sleep(400); await h.ev(textClick('.chat-pane-view-toggle button', '議題與待辦')); await waitVisible(h, '.group-topic-card') } },
  { id: 'stream-aiSettings', tab: 'stream', cols: 'chat', expect: ['.chat-pane-view-toggle'], run: async (h) => { await h.ev(`document.querySelector('.chat-list-item')?.click()`); await sleep(400); await h.ev(textClick('.chat-pane-view-toggle button', 'AI')); await sleep(500) } },
  { id: 'stream-lightbox', tab: 'stream', cols: 'chat', expect: ['.sm-lightbox img'], run: async (h) => { await h.ev(LIGHTBOX); await sleep(300) } },
  { id: 'topics', tab: 'topics', expect: ['.group-topics-panel', '.topics-table', '.topics-row'], run: async (h) => { await waitVisible(h, '.topics-row') } },
  { id: 'settings', tab: 'settings', expect: ['.settings-wrap'], run: async () => { await sleep(400) } },
  { id: 'settings-view', tab: 'settings', mode: 'settings', expect: ['.settings-wrap'], run: async () => { await sleep(400) } },
  { id: 'profile-matrix', tab: 'settings', mode: 'profile-matrix', widths: [420, 1280], expect: ['.profile-matrix-settings'], run: async (h) => { await h.clickSel('.profile-matrix-settings > summary', 0); await sleep(250) } },
  { id: 'chat-profile-assist', tab: 'settings', mode: 'chat-profile-assist', widths: [420, 1280], expect: ['[data-testid="chat-profile-panel"]', '[data-testid="chat-profile-assist"]'] },
  // chat title bar: the bridge status line (dot, text, 重試, 重啟 N 次, 診斷) lives in the header; F5 of the chat-menu review
  { id: 'header-chat', tab: 'stream', phase: 'timeout', widths: [420, 640, 1280], cols: 'chat', expect: ['.stream-status', '.stream-retry', '.stream-diag'] },
  { id: 'header-diag', tab: 'stream', phase: 'timeout', widths: [420, 640, 1280], cols: 'chat', expect: ['.stream-diag[open]', '.stream-diag-body'], run: async (h) => { await h.clickSel('.stream-diag > summary', 0); await sleep(500) } }
]
// the breakpoints themselves, inclusive: chat 760 = single column / 761 = two; board 1000 = two columns / 1001 = four
const BOUNDARIES = [
  { widths: [CONTAINER_CHAT_ONE, CONTAINER_CHAT_ONE + 1], scenes: ['stream-list', 'stream-chat'] },
  { widths: [CONTAINER_BOARD_TWO, CONTAINER_BOARD_TWO + 1], scenes: ['board'] }
]

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
let h = null
let cleaned = false
/** closes the browser (whole process tree) and deletes the temp dir; runs on every way out, including a crash of this script */
const cleanup = () => {
  if (cleaned) return
  cleaned = true
  try { h?.close() } catch { /* already closed */ }
  let lastError = null
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try { rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); lastError = null; break } catch (error) { lastError = error }
    teardown(null, workDir) // something started with this profile is still alive and holds a handle: kill it again, then retry
    sleepSync(1000)
  }
  if (lastError) console.log(`warning: could not remove ${workDir}: ${lastError.message}`)
}
process.on('exit', cleanup)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130))
process.on('uncaughtException', (error) => { console.log(`check:browser-layout crashed: ${error?.stack ?? error}`); process.exit(2) })
process.on('unhandledRejection', (error) => { console.log(`check:browser-layout crashed: ${error?.stack ?? error}`); process.exit(2) })
// a script-level backstop for anything the per-call deadlines miss: nothing here may run for more than 25 minutes (a full pass takes ~3)
setTimeout(() => { console.log('check:browser-layout FAIL — overall 25 minute limit reached'); process.exit(3) }, 25 * 60 * 1000).unref()

h = await launch(workDir)

const supported = await h.ev("CSS.supports('container-type', 'inline-size')")
if (!supported) { cleanup(); skip(`${h.version} has no container queries`) }

h.center = (selector, n = 0) => h.ev(`(() => { const e = document.querySelectorAll(${JSON.stringify(selector)})[${n}]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 } })()`)
h.clickSel = async (selector, n = 0, button = 'left') => { const c = await h.center(selector, n); if (!c) return false; await h.click(c.x, c.y, button); return true }

async function waitFor(expression, ms = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { try { if (await h.ev(expression)) return true } catch (error) { if (error instanceof CdpError) throw error /* else: navigating */ } await sleep(60) }
  return false
}

async function restartBrowser() {
  try { h.close() } catch { /* already closed */ }
  Object.assign(h, await launch(workDir))
}

async function openScene(scene, z, eff) {
  await h.send('Emulation.setDeviceMetricsOverride', { width: Math.round(eff * z), height: Math.round((scene.height ?? EFF_H) * z), deviceScaleFactor: 1, mobile: false })
  const query = [scene.mode ? `mode=${scene.mode}` : '', scene.many ? 'many=1' : '', scene.phase ? `phase=${scene.phase}` : '', scene.photoCache ? 'photo-cache=1' : ''].filter(Boolean).join('&')
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
for (const group of BOUNDARIES) {
  for (const id of group.scenes) {
    const scene = SCENES.find((s) => s.id === id)
    if (only && !only.includes(id)) continue
    for (const z of ZOOMS) for (const eff of group.widths) runs.push({ scene, z, eff, boundary: true })
  }
}

console.log(`check:browser-layout — ${h.version}, ${runs.length} runs (zooms ${ZOOMS.join('/')}, effective widths ${WIDTHS.join('/')} + header 420 + boundary chat 760/761, board 1000/1001)`)
for (const { scene, z, eff, boundary } of runs) {
  let bad = []
  let m = null
  const label0 = `${scene.id} zoom ${z} eff ${eff}${boundary ? ' (boundary)' : ''}`
  for (let attempt = 1; attempt <= CDP_ATTEMPTS; attempt += 1) {
    h.errors.length = 0
    h.note = ''
    bad = []
    m = null
    try {
      await openScene(scene, z, eff)
      if (scene.run) await scene.run(h)
      await sleep(300)
      m = await h.ev(MEASURE)
      m.errors = h.errors.slice(0, 2)
      bad = await judge(h, scene, z, eff, m)
      if (shotDir && shotZooms.includes(z) && shotWidths.includes(eff) && !boundary) await h.shot(join(shotDir, `${scene.id}__zoom${z}__eff${eff}.png`))
      break
    } catch (error) {
      if (!(error instanceof CdpError)) { bad = [`run failed: ${String(error).slice(0, 200)}`]; break }
      const last = attempt === CDP_ATTEMPTS
      console.log(`${last ? 'GIVE UP' : 'RETRY'} ${label0}: ${error.message} (attempt ${attempt} of ${CDP_ATTEMPTS})`)
      if (last) { bad = [`the browser stopped answering ${CDP_ATTEMPTS} times in a row: ${error.message}`]; break }
      try { await restartBrowser() } catch (restartError) { bad = [`the browser could not be restarted: ${restartError.message}`]; break }
    }
  }
  const label = `${scene.id} zoom ${z} eff ${eff}${boundary ? ' (boundary)' : ''}`
  results.push({ label, ok: bad.length === 0, bad, boardCols: m?.boardCols ?? null, wsCols: m?.wsCols ?? null, note: h.note, photoBoxes: h.photoBoxes ?? null, actualPhotoFacts: h.actualPhotoFacts ?? null, actualLightboxFacts: h.actualLightboxFacts ?? null })
  if (bad.length) { failures += 1; console.log(`FAIL ${label}\n     ${bad.join('\n     ')}`) } else console.log(`PASS ${label}${m?.boardCols ? ` board=${m.boardCols}col` : ''}${m?.wsCols ? ` chat=${m.wsCols}col` : ''}${h.note ? ` ${h.note}` : ''}`)
}

if (shotDir) writeFileSync(join(shotDir, 'results.json'), JSON.stringify(results, null, 1))
cleanup()
console.log(failures === 0 ? `check:browser-layout PASS — ${runs.length}/${runs.length}` : `check:browser-layout FAIL — ${failures} of ${runs.length}`)
process.exit(failures === 0 ? 0 : 1)
