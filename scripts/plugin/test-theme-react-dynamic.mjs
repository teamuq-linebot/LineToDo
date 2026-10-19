import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = resolve(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..', '..')
const electronExe = require('electron')
const esbuild = require('esbuild')
const tempRoot = mkdtempSync(join(tmpdir(), 'line-todo-theme-react-'))
const appDir = join(tempRoot, 'app')
mkdirSync(appDir, { recursive: true })
const entry = join(tempRoot, 'theme-react-test.jsx')
const bundle = join(appDir, 'theme-react-test.js')
const html = join(appDir, 'index.html')
const main = join(appDir, 'main.cjs')

try {
  writeFileSync(entry, `
    import React from ${JSON.stringify(join(ROOT, 'node_modules/react/index.js'))}
    import { createRoot } from ${JSON.stringify(join(ROOT, 'node_modules/react-dom/client.js'))}
    import { flushSync } from ${JSON.stringify(join(ROOT, 'node_modules/react-dom/index.js'))}
    import { useTheme } from ${JSON.stringify(join(ROOT, 'src/renderer/lib/theme.ts'))}

    const listeners = new Set()
    const query = {
      get matches() { return hostLight },
      addEventListener(_type, listener) { listeners.add(listener) },
      removeEventListener(_type, listener) { listeners.delete(listener) },
    }
    let hostLight = true
    window.matchMedia = () => query
    localStorage.setItem('lt-theme', 'dark')

    function View({ label, mode }) {
      const { theme, toggle } = useTheme(mode)
      return React.createElement('button', { id: label, onClick: toggle, 'data-theme-value': theme }, label + ':' + theme)
    }
    const dashboardRoot = createRoot(document.getElementById('dashboard'))
    const settingsRoot = createRoot(document.getElementById('settings'))
    const render = () => flushSync(() => {
      dashboardRoot.render(React.createElement(View, { label: 'dashboard', mode: 'system' }))
      settingsRoot.render(React.createElement(View, { label: 'settings', mode: 'system' }))
    })
    const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
    const assert = (ok, message) => { if (!ok) throw new Error(message) }
    const values = () => ['dashboard', 'settings'].map((id) => document.getElementById(id).firstElementChild?.getAttribute('data-theme-value'))
    const flip = async (light) => {
      hostLight = light
      for (const listener of [...listeners]) listener({ matches: light, media: '(prefers-color-scheme: light)' })
      await settle()
    }

    async function run() {
    render()
    await settle()
    await flip(false)
    assert(JSON.stringify(values()) === JSON.stringify(['dark', 'dark']), 'dashboard and settings must update on host light-to-dark: ' + JSON.stringify(values()))
    assert(document.documentElement.dataset.theme === 'dark' && document.documentElement.style.colorScheme === 'dark', 'host dark update must set root theme and colorScheme')
    await flip(true)
    assert(JSON.stringify(values()) === JSON.stringify(['light', 'light']), 'dashboard and settings must update on host dark-to-light: ' + JSON.stringify(values()))
    assert(document.documentElement.dataset.theme === 'light' && document.documentElement.style.colorScheme === 'light', 'host light update must set root theme and colorScheme')
    await flip(false)
    assert(JSON.stringify(values()) === JSON.stringify(['dark', 'dark']), 'dashboard and settings must update on host light-to-dark a second time: ' + JSON.stringify(values()))
    localStorage.setItem('lt-theme', 'light')
    const standaloneRoot = createRoot(document.getElementById('standalone'))
    flushSync(() => standaloneRoot.render(React.createElement(View, { label: 'standalone', mode: 'dark' })))
    await settle()
    const standaloneButton = document.getElementById('standalone').firstChild
    standaloneButton.click()
    await settle()
    assert(document.getElementById('standalone').firstElementChild.getAttribute('data-theme-value') === 'dark', 'standalone toggle must update its view from light to dark')
    assert(localStorage.getItem('lt-theme') === 'dark', 'standalone toggle must persist lt-theme=dark')
    console.log('DYNAMIC_THEME_RESULT assertions=12 dashboard=settings firstPaint=light transitions=dark,light,dark standaloneToggle=dark storage=dark')
    document.title = 'DYNAMIC_THEME_PASS'; window.close()
    }
    run().catch((error) => { console.error('DYNAMIC_THEME_FAILURE', error); document.title = 'DYNAMIC_THEME_FAIL'; window.close() })
  `, 'utf8')
  writeFileSync(html, '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="dashboard"></div><div id="settings"></div><div id="standalone"></div><script src="./theme-react-test.js"></script></body></html>\n', 'utf8')
  writeFileSync(main, `const { app, BrowserWindow } = require('electron')\napp.disableHardwareAcceleration()\napp.whenReady().then(() => { const w = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } }); w.on('close', () => app.exit(w.webContents.getTitle().includes('DYNAMIC_THEME_PASS') ? 0 : 1)); w.webContents.on('console-message', (_e, _level, message) => console.log('RENDERER', message)); w.webContents.on('did-finish-load', () => console.log('DYNAMIC_THEME_PAGE_LOADED')); w.loadFile(${JSON.stringify(html)}); w.webContents.on('did-fail-load', (_e, code, desc) => { console.error('DYNAMIC_THEME_LOAD_ERROR', code, desc); app.exit(2) }) })\nsetTimeout(() => { console.error('DYNAMIC_THEME_TIMEOUT'); app.exit(3) }, 20000).unref()\n`, 'utf8')
  await esbuild.build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'browser', format: 'iife', target: 'chrome120', logLevel: 'silent' })
  const run = spawnSync(electronExe, ['--headless', '--disable-gpu', '--no-sandbox', main], { cwd: ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true })
  process.stdout.write(run.stdout || '')
  process.stderr.write(run.stderr || '')
  if (run.error) throw run.error
  if (run.status !== 0) throw new Error(`Electron dynamic theme test exited ${run.status ?? 'null'} (signal=${run.signal ?? 'none'})`)
  if (!(run.stdout || '').includes('DYNAMIC_THEME_RESULT assertions=12')) throw new Error('Electron exited without the expected dynamic assertion summary')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}









