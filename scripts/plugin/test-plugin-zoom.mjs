// Screen zoom + the 整頁 button (line-todo plugin only; nothing in TeamUQ Core changes).
//   lib/zoom.ts            Ctrl + = / + / - / 0 and Ctrl + wheel move through [0.8, 0.9, 1.0, 1.1, 1.25]; the step is remembered (localStorage lt-zoom)
//   PresentationToggle     window.tuqPlugin.presentation.request('fullpage' | 'tab'), icon follows onChange, one short error line when refused, hidden without the API
//   placeFixedMenu         the card 「更多」menu is positioned correctly under CSS zoom (the real-browser check is in the dev report; this is the arithmetic)
//   bundle                 both view entries (board + settings) install the zoom; the pinned standalone index.html is untouched
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

import { reactProps, walk, install } from './fixtures/mini-dom.mjs'
import { ROOT, buildPluginUi } from './build-ui.mjs'
import { DEFAULT_ZOOM, WHEEL_STEP_DELTA, ZOOM_KEY, ZOOM_STEPS, installZoom, layoutScale, normalizeZoom, placeFixedMenu, stepZoom, zoomActionForKey } from '../../src/renderer/lib/zoom.ts'

const dom = install() // before react-dom loads
const work = mkdtempSync(join(tmpdir(), 'plugin-zoom-'))
test.after(() => { rmSync(work, { recursive: true, force: true }); dom.restore() })

// the bundle is built before any test is registered (a top-level await after test() calls lets node:test finish the file and run the after-hook early)
const outfile = join(work, 'zoom-ui.mjs')
await build({
  entryPoints: [resolve(ROOT, 'scripts', 'plugin', 'fixtures', 'zoom-entry.tsx')],
  outfile, bundle: true, format: 'esm', platform: 'node', target: 'node24', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', __LINE_TODO_PLUGIN_VERSION__: '"0.0.0"' }, loader: { '.css': 'empty' }, logLevel: 'error', absWorkingDir: ROOT,
  banner: { js: "import { createRequire as __r } from 'node:module'; const require = __r(import.meta.url);" },
})
const ui = await import(pathToFileURL(outfile).href)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(predicate, { timeout = 30_000, message = 'condition' } = {}) {
  const t0 = Date.now()
  while (!predicate()) {
    if (Date.now() - t0 > timeout) assert.fail(`timed out waiting for ${message}`)
    await sleep(5)
  }
}

// ───────────── zoom: the pure steps ─────────────

test('zoom: the steps are the TeamUQ main-window steps, default 1.0', () => {
  assert.deepEqual([...ZOOM_STEPS], [0.8, 0.9, 1.0, 1.1, 1.25])
  assert.equal(DEFAULT_ZOOM, 1)
  assert.equal(ZOOM_KEY, 'lt-zoom')
})

test('zoom: in / out walk the steps and stop at both ends; reset goes back to 1.0 from anywhere', () => {
  let z = DEFAULT_ZOOM
  const seenIn = []
  for (let i = 0; i < 6; i += 1) { z = stepZoom(z, 'in'); seenIn.push(z) }
  assert.deepEqual(seenIn, [1.1, 1.25, 1.25, 1.25, 1.25, 1.25], 'upper limit 1.25')
  const seenOut = []
  for (let i = 0; i < 8; i += 1) { z = stepZoom(z, 'out'); seenOut.push(z) }
  assert.deepEqual(seenOut, [1.1, 1.0, 0.9, 0.8, 0.8, 0.8, 0.8, 0.8], 'lower limit 0.8')
  for (const from of [0.8, 0.9, 1.1, 1.25]) assert.equal(stepZoom(from, 'reset'), 1)
})

test('zoom: stored garbage is normalized to a valid step (nearest step, junk → 1.0)', () => {
  assert.equal(normalizeZoom('1.25'), 1.25)
  assert.equal(normalizeZoom('0.86'), 0.9)
  assert.equal(normalizeZoom('5'), 1.25)
  assert.equal(normalizeZoom('0.1'), 0.8)
  for (const junk of [null, undefined, '', 'abc', NaN, -1, 0, {}, [], Infinity]) assert.equal(normalizeZoom(junk), 1, String(junk))
})

test('zoom keys: Ctrl+= Ctrl++ Ctrl+- Ctrl+0 (and numpad) map to in / in / out / reset; everything else maps to nothing', () => {
  const k = (key, extra = {}) => zoomActionForKey({ key, ctrlKey: true, ...extra })
  assert.equal(k('='), 'in')
  assert.equal(k('+', { shiftKey: true }), 'in')
  assert.equal(k('-'), 'out')
  assert.equal(k('_'), 'out')
  assert.equal(k('0'), 'reset')
  assert.equal(k('Add', { code: 'NumpadAdd' }), 'in')
  assert.equal(k('Subtract', { code: 'NumpadSubtract' }), 'out')
  // not Ctrl → nothing, whatever the key
  for (const key of ['=', '+', '-', '0', 'a', 'Enter', 'Escape']) assert.equal(zoomActionForKey({ key, ctrlKey: false }), null, `plain ${key}`)
  // other Ctrl combinations are not ours
  for (const key of ['a', 'c', 'v', 'z', 'f', '1', 'Enter']) assert.equal(k(key), null, `Ctrl+${key}`)
  assert.equal(k('=', { altKey: true }), null, 'Ctrl+Alt+= is left alone')
})

// ───────────── zoom: installed on a (fake) window ─────────────

function fakeEnv(initial) {
  const listeners = new Map()
  const target = {
    addEventListener(type, fn, options) { listeners.set(type, { fn, options }) },
    removeEventListener(type) { listeners.delete(type) },
  }
  const store = new Map(initial === undefined ? [] : [[ZOOM_KEY, initial]])
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)) } }
  const root = { style: { zoom: '' } }
  const fire = (type, init = {}) => {
    let prevented = false
    const event = { type, preventDefault() { prevented = true }, ...init }
    listeners.get(type)?.fn(event)
    return { prevented }
  }
  const key = (k, init = {}) => fire('keydown', { key: k, ctrlKey: true, ...init })
  const wheel = (deltaY, init = {}) => fire('wheel', { deltaY, ctrlKey: true, ...init })
  return { listeners, target, storage, store, root, fire, key, wheel }
}

test('zoom: Ctrl keys change the page zoom step by step, preventDefault, and persist every change', () => {
  const env = fakeEnv()
  const zoom = installZoom({ target: env.target, root: env.root, storage: env.storage })
  assert.equal(env.root.style.zoom, '', 'default 1.0 leaves the page untouched')
  assert.equal(env.key('=').prevented, true)
  assert.equal(env.root.style.zoom, '1.1'); assert.equal(env.store.get(ZOOM_KEY), '1.1')
  env.key('+', { shiftKey: true })
  assert.equal(env.root.style.zoom, '1.25')
  assert.equal(env.key('=').prevented, true, 'at the upper limit the key is still ours (no browser zoom)')
  assert.equal(env.root.style.zoom, '1.25', 'stays at 1.25')
  env.key('0')
  assert.equal(env.root.style.zoom, ''); assert.equal(env.store.get(ZOOM_KEY), '1')
  for (const expected of ['0.9', '0.8', '0.8']) { env.key('-'); assert.equal(env.root.style.zoom, expected) }
  assert.equal(env.store.get(ZOOM_KEY), '0.8')
  assert.equal(zoom.get(), 0.8)
  zoom.dispose()
  assert.equal(env.listeners.size, 0, 'dispose removes every listener')
})

test('zoom: the saved step is applied at start-up (restart keeps it); a corrupt saved value falls back to 1.0', () => {
  const env = fakeEnv('1.25')
  installZoom({ target: env.target, root: env.root, storage: env.storage })
  assert.equal(env.root.style.zoom, '1.25')
  const bad = fakeEnv('banana')
  installZoom({ target: bad.target, root: bad.root, storage: bad.storage })
  assert.equal(bad.root.style.zoom, '')
  const broken = fakeEnv()
  broken.storage.getItem = () => { throw new Error('denied') }
  broken.storage.setItem = () => { throw new Error('denied') }
  installZoom({ target: broken.target, root: broken.root, storage: broken.storage })
  broken.key('=')
  assert.equal(broken.root.style.zoom, '1.1', 'localStorage unavailable: the zoom still works, it is just not saved')
})

test('zoom: Ctrl+wheel up zooms in, down zooms out, one notch = one step, limits hold, and the browser default is cancelled', () => {
  const env = fakeEnv()
  installZoom({ target: env.target, root: env.root, storage: env.storage })
  assert.equal(env.listeners.get('wheel').options.passive, false, 'the wheel listener is not passive (needed for preventDefault)')
  assert.equal(env.listeners.get('wheel').options.capture, true)
  assert.equal(env.wheel(-WHEEL_STEP_DELTA).prevented, true)
  assert.equal(env.root.style.zoom, '1.1')
  env.wheel(-WHEEL_STEP_DELTA); env.wheel(-WHEEL_STEP_DELTA); env.wheel(-WHEEL_STEP_DELTA)
  assert.equal(env.root.style.zoom, '1.25', 'upper limit')
  for (let i = 0; i < 6; i += 1) env.wheel(WHEEL_STEP_DELTA)
  assert.equal(env.root.style.zoom, '0.8', 'lower limit')
  assert.equal(env.store.get(ZOOM_KEY), '0.8')
  env.wheel(-100000)
  assert.equal(env.root.style.zoom, '0.9', 'a huge delta is still one step')
})

test('zoom: trackpad pinch (many tiny Ctrl+wheel deltas) needs one notch worth of movement per step; a direction change starts over', () => {
  const env = fakeEnv()
  installZoom({ target: env.target, root: env.root, storage: env.storage })
  for (let i = 0; i < 9; i += 1) env.wheel(-10)
  assert.equal(env.root.style.zoom, '', '90 of 100: not yet')
  env.wheel(-10)
  assert.equal(env.root.style.zoom, '1.1', '100: one step')
  for (let i = 0; i < 5; i += 1) env.wheel(-15)
  env.wheel(15)
  env.wheel(15)
  assert.equal(env.root.style.zoom, '1.1', 'reversing discards the pending amount')
})

test('zoom: a wheel without Ctrl and ordinary keys are not touched (no preventDefault, no zoom change)', () => {
  const env = fakeEnv()
  installZoom({ target: env.target, root: env.root, storage: env.storage })
  assert.equal(env.wheel(-500, { ctrlKey: false }).prevented, false)
  assert.equal(env.wheel(500, { ctrlKey: false }).prevented, false)
  for (const k of ['=', '-', '0', 'a', 'Enter', 'ArrowDown', 'Tab', ' ']) assert.equal(env.key(k, { ctrlKey: false }).prevented, false, `plain ${k}`)
  for (const k of ['a', 'c', 'v', 'f']) assert.equal(env.key(k).prevented, false, `Ctrl+${k} (copy, paste, find…) stays with the page`)
  assert.equal(env.key('=', { ctrlKey: false, metaKey: false, altKey: true }).prevented, false)
  assert.equal(env.root.style.zoom, '')
  assert.equal(env.store.has(ZOOM_KEY), false, 'nothing was saved')
  // a no-Ctrl wheel in the middle of a Ctrl gesture does not leave a half step behind
  env.wheel(-60); env.wheel(-500, { ctrlKey: false }); env.wheel(-60)
  assert.equal(env.root.style.zoom, '', '60 + (reset) + 60 is not a step')
})

test('zoom: inside a text box Ctrl+= / - / 0 and Ctrl+wheel zoom like everywhere else (they mean nothing to text editing); typing is untouched', () => {
  const env = fakeEnv()
  installZoom({ target: env.target, root: env.root, storage: env.storage })
  const inField = { target: { tagName: 'TEXTAREA', isContentEditable: false } }
  assert.equal(env.key('=', inField).prevented, true)
  assert.equal(env.root.style.zoom, '1.1')
  env.wheel(WHEEL_STEP_DELTA, inField)
  assert.equal(env.root.style.zoom, '', 'back to 1.0')
  for (const k of ['a', 'Backspace', '-', '0', '=', 'ArrowLeft']) assert.equal(env.key(k, { ...inField, ctrlKey: false }).prevented, false, `typing ${k} in a field is untouched`)
  for (const k of ['a', 'c', 'v', 'x', 'z']) assert.equal(env.key(k, inField).prevented, false, `Ctrl+${k} in a field (select all / copy / paste / undo) is untouched`)
})

test('zoom: another view changing the saved step (storage event) updates this view; unrelated keys are ignored', () => {
  const env = fakeEnv()
  installZoom({ target: env.target, root: env.root, storage: env.storage })
  env.store.set(ZOOM_KEY, '0.9')
  env.fire('storage', { key: 'something-else' })
  assert.equal(env.root.style.zoom, '', 'unrelated key ignored')
  env.fire('storage', { key: ZOOM_KEY })
  assert.equal(env.root.style.zoom, '0.9')
  env.key('=')
  assert.equal(env.root.style.zoom, '', 'the next step continues from the synced value (0.9 → 1.0)')
})

test('zoom: installZoom without a window / document does nothing and does not throw (server render, tests)', () => {
  const saved = { window: globalThis.window, document: globalThis.document }
  delete globalThis.window; delete globalThis.document
  try {
    const z = installZoom()
    assert.equal(z.get(), 1)
    z.apply('in')
    z.dispose()
  } finally { globalThis.window = saved.window; globalThis.document = saved.document }
})

// ───────────── zoom: positions of the floating card menu ─────────────

test('placeFixedMenu: at scale 1 the arithmetic is the pre-zoom one (open below / open above / clamp); the menu is ~305 high so it needs 320 below', () => {
  const vp = { width: 1000, height: 800 }
  assert.deepEqual(placeFixedMenu({ top: 100, bottom: 130, right: 500 }, vp, 1), { top: 134, left: 332 })
  assert.deepEqual(placeFixedMenu({ top: 700, bottom: 730, right: 500 }, vp, 1), { bottom: 104, left: 332 })
  assert.deepEqual(placeFixedMenu({ top: 100, bottom: 130, right: 60 }, vp, 1), { top: 134, left: 8 }, 'left clamp')
  assert.ok('top' in placeFixedMenu({ top: 400, bottom: 430, right: 500 }, vp, 1), '370 below: still opens downwards')
  assert.ok('bottom' in placeFixedMenu({ top: 470, bottom: 500, right: 500 }, vp, 1), '300 below is less than the 305-high menu: opens upwards')
  assert.equal(placeFixedMenu({ top: 100, bottom: 130, right: 999 }, vp, 1).left, 1000 - 168 - 8, 'right clamp')
})

test('placeFixedMenu: under zoom the rect (screen px) is converted to the CSS lengths that land on the trigger, and the clamps are in screen px', () => {
  for (const scale of [0.8, 0.9, 1.1, 1.25]) {
    const vp = { width: 1000, height: 800 }
    const rect = { top: 100 * scale, bottom: 130 * scale, right: 500 * scale } // a trigger at layout (…, 100..130, right 500)
    const below = placeFixedMenu(rect, vp, scale)
    assert.ok(Math.abs(below.top - 134) < 1e-9 && Math.abs(below.left - 332) < 1e-9, `scale ${scale}: layout coordinates equal the unzoomed ones: ${JSON.stringify(below)}`)
    // the menu's right edge (left+168 css px → ×scale on screen) never leaves the viewport
    const edge = placeFixedMenu({ top: 100, bottom: 130, right: 995 }, vp, scale)
    assert.ok((edge.left + 168) * scale <= vp.width - 8 * scale + 1e-9, `scale ${scale}: clamped inside the screen`)
    // near the bottom: space is measured in screen px, so it opens upwards
    const above = placeFixedMenu({ top: 700, bottom: 730, right: 500 }, vp, scale)
    assert.ok('bottom' in above && !('top' in above), `scale ${scale}: opens upwards near the bottom`)
    assert.ok(Math.abs(above.bottom - ((800 - 700) / scale + 4)) < 1e-9)
  }
})

test('layoutScale: ratio of the measured probe width to its CSS width; 1 when unmeasurable', () => {
  const doc = (w) => ({ createElement: () => ({ style: {}, getBoundingClientRect: () => ({ width: w }), remove() {} }), body: { appendChild() {} } })
  assert.equal(layoutScale(doc(100)), 1)
  assert.equal(layoutScale(doc(125)), 1.25)
  assert.equal(layoutScale(doc(80)), 0.8)
  assert.equal(layoutScale(doc(0)), 1)
  assert.equal(layoutScale(null), 1)
  assert.equal(layoutScale({ createElement() { throw new Error('x') }, body: {} }), 1)
})

// ───────────── 整頁 button ─────────────


function fakePresentation({ mode = 'tab', refuse = null, throws = false } = {}) {
  const calls = []
  const listeners = new Set()
  let current = mode
  return {
    calls, listeners,
    emit(to, phase = 'after') { current = to; for (const l of [...listeners]) l({ phase, from: to === 'tab' ? 'fullpage' : 'tab', to, fullscreen: false, visible: true, reason: 'escape' }) },
    api: {
      async get() { return { mode: current, fullscreen: false, visible: true } },
      async request(m, options) {
        calls.push([m, options])
        if (throws) throw new Error('boom')
        if (refuse) return { ok: false, error: refuse }
        current = m
        return { ok: true, state: { mode: m, fullscreen: false, visible: true } }
      },
      onChange(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    },
  }
}
const withHost = async (presentation, body) => {
  if (presentation) dom.window.tuqPlugin = { presentation }
  else delete dom.window.tuqPlugin
  try { await body() } finally { delete dom.window.tuqPlugin }
}
const button = (view) => walk(view.container).find((el) => el.localName === 'button' && (el.getAttribute('class') ?? '').includes('presentation-toggle'))
const errorLine = (view) => walk(view.container).find((el) => (el.getAttribute('class') ?? '') === 'presentation-error')
const click = (el) => reactProps(el).onClick({ currentTarget: el })
const iconPath = (view) => walk(button(view)).find((el) => el.localName === 'path')?.getAttribute('d')

test('整頁 button: without window.tuqPlugin.presentation (standalone, plain browser) nothing is rendered', async () => {
  await withHost(null, async () => {
    const view = ui.mount(ui.toggleScene())
    await sleep(20)
    assert.equal(button(view), undefined)
    assert.equal(view.container.childNodes.length, 0)
    view.unmount()
  })
  await withHost({ get: async () => ({ mode: 'tab' }) }, async () => { // an object without request() is not a presentation API
    const view = ui.mount(ui.toggleScene())
    await sleep(20)
    assert.equal(button(view), undefined)
    view.unmount()
  })
})

test('整頁 button: icon + tooltip only (no text); click requests fullpage, then the icon and tooltip become 還原 and the next click requests tab', async () => {
  const host = fakePresentation()
  await withHost(host.api, async () => {
    const view = ui.mount(ui.toggleScene())
    await until(() => button(view), { message: 'button' })
    const b = button(view)
    assert.equal(b.getAttribute('title'), '整頁'); assert.equal(b.getAttribute('aria-label'), '整頁')
    assert.equal(view.container.textContent.trim(), '', 'icon only, no visible words')
    const tabIcon = iconPath(view)
    assert.ok(tabIcon)
    click(b)
    await until(() => button(view).getAttribute('title') === '還原', { message: 'mode becomes fullpage' })
    assert.deepEqual(host.calls.map((c) => c[0]), ['fullpage'])
    assert.notEqual(iconPath(view), tabIcon, 'the icon changes with the state')
    assert.equal(button(view).getAttribute('aria-label'), '還原')
    assert.equal(errorLine(view), undefined)
    click(button(view))
    await until(() => button(view).getAttribute('title') === '整頁', { message: 'mode returns to tab' })
    assert.deepEqual(host.calls.map((c) => c[0]), ['fullpage', 'tab'])
    assert.equal(iconPath(view), tabIcon)
    view.unmount()
    assert.equal(host.listeners.size, 0, 'unmount unsubscribes from onChange')
  })
})

test('整頁 button: starts from the host current mode, and follows onChange from outside (Esc, the host) without a click', async () => {
  const host = fakePresentation({ mode: 'fullpage' })
  await withHost(host.api, async () => {
    const view = ui.mount(ui.toggleScene())
    await until(() => button(view)?.getAttribute('title') === '還原', { message: 'initial fullpage' })
    host.emit('tab', 'before')
    await sleep(20)
    assert.equal(button(view).getAttribute('title'), '還原', 'a "before" phase is not the new state yet')
    host.emit('tab', 'after')
    await until(() => button(view).getAttribute('title') === '整頁', { message: 'Esc brought it back' })
    assert.deepEqual(host.calls, [], 'nothing was requested')
    host.emit('fullpage', 'after')
    await until(() => button(view).getAttribute('title') === '還原', { message: 'host switched to fullpage' })
    view.unmount()
  })
})

test('整頁 button: a refused request shows one short line (no codes, no sentence), keeps the mode, clears on the next success', async () => {
  const host = fakePresentation({ refuse: 'presentation_requires_focus' })
  await withHost(host.api, async () => {
    const view = ui.mount(ui.toggleScene())
    await until(() => button(view), { message: 'button' })
    click(button(view))
    await until(() => errorLine(view), { message: 'error line' })
    assert.equal(errorLine(view).textContent, ui.PRESENTATION_ERROR_TEXT)
    assert.ok(ui.PRESENTATION_ERROR_TEXT.length <= 12 && !/[\n。]/.test(ui.PRESENTATION_ERROR_TEXT), 'one short line')
    assert.equal(button(view).getAttribute('title'), '整頁', 'still tab')
    assert.equal(walk(view.container).filter((el) => (el.getAttribute('class') ?? '') === 'presentation-error').length, 1)
    // the host accepts now
    host.api.request = async (m) => { host.calls.push([m]); return { ok: true, state: { mode: m, fullscreen: false, visible: true } } }
    click(button(view))
    await until(() => button(view).getAttribute('title') === '還原' && !errorLine(view), { message: 'success clears the error' })
    view.unmount()
  })
  const thrower = fakePresentation({ throws: true })
  await withHost(thrower.api, async () => {
    const view = ui.mount(ui.toggleScene())
    await until(() => button(view), { message: 'button' })
    click(button(view))
    await until(() => errorLine(view), { message: 'a rejected promise is an error line too' })
    assert.equal(button(view).getAttribute('title'), '整頁')
    view.unmount()
  })
})

test('整頁 button: it sits in the plugin header after the tab row only when the host has presentation (App)', async () => {
  const host = fakePresentation()
  globalThis.document ??= dom.document
  await withHost(host.api, async () => {
    const html = ui.renderHeader(true)
    const header = /<header class="app-header">([\s\S]*?)<\/header>/.exec(html)?.[1] ?? ''
    assert.match(header, /<button type="button" class="theme-toggle presentation-toggle"[^>]*title="整頁"/)
    assert.ok(header.indexOf('</nav>') < header.indexOf('presentation-toggle'), 'after the tab row, on the same header row')
  })
  await withHost(null, async () => {
    for (const plugin of [true, false]) assert.ok(!ui.renderHeader(plugin).includes('presentation-toggle'), `no button without the API (plugin=${plugin})`)
  })
})

// ───────────── the real build ─────────────

test('bundle: board and settings views both install the zoom; the pinned standalone index.html and the plugin HTML stay free of inline script', async () => {
  const { files, metafiles, analysis } = await buildPluginUi({ outDir: join(work, 'plugin-ui') })
  assert.equal(analysis.ok, true)
  assert.ok(files['main.js'].includes('lt-zoom') && files['settings.js'].includes('lt-zoom'), 'both entries carry the zoom')
  assert.ok(files['main.js'].includes('presentation-toggle'), 'the board carries the 整頁 button')
  const inputs = [...new Set(metafiles.flatMap((m) => Object.keys(m.inputs).map((i) => i.replaceAll(String.fromCharCode(92), '/'))))]
  assert.ok(inputs.includes('src/renderer/lib/zoom.ts'))
  const main = readFileSync(join(ROOT, 'src', 'plugin', 'ui', 'main.tsx'), 'utf8')
  const settings = readFileSync(join(ROOT, 'src', 'plugin', 'ui', 'settings.tsx'), 'utf8')
  assert.match(main, /\binstallZoom\(\)/); assert.match(settings, /\binstallZoom\(\)/)
  for (const html of ['index.html', 'settings.html']) assert.ok(!/<script>[^<]/.test(files[html]), `${html} has no inline script`)
  // the CSP-pinned standalone page (sha256 of its inline script) was not touched by this feature
  const standalone = readFileSync(join(ROOT, 'src', 'renderer', 'index.html'), 'utf8')
  assert.ok(!standalone.includes('zoom'))
})
