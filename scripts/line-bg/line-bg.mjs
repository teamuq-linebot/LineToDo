// line-bg.mjs — LINE 背景 Chrome：用專用 profile 在背景（headless、靜音）跑 LINE Chrome 外掛，供 line-todo 的「用 Chrome 發送」經 CDP（127.0.0.1:19223）使用。
//
//   node scripts/line-bg/line-bg.mjs login    開一個看得見的視窗，第一次登入 LINE 用（登入後執行 stop，再 start）
//   node scripts/line-bg/line-bg.mjs start    在背景啟動（headless、--mute-audio），載入 LINE 外掛並開好 LINE 分頁
//   node scripts/line-bg/line-bg.mjs status   回報：是否在跑、外掛是否載入、LINE 是否已登入
//   node scripts/line-bg/line-bg.mjs stop     以 CDP Browser.close 關閉（只關這個專用 Chrome）
//
// 資料位置：%USERPROFILE%\.teamuq\tools\line-bg\{profile,extension}；可用 LINE_BG_HOME 覆寫。
// LINE 外掛：正式版 Chrome 不支援 --load-extension，所以每次啟動都用 CDP Extensions.loadUnpacked 載入一份副本
// （從共用瀏覽器已安裝的 LINE 外掛複製，去掉 Chrome 保留的 _metadata；manifest 帶 key，所以外掛 ID 不變，登入狀態留在 profile）。
// 來源可用 LINE_BG_EXTENSION_SOURCE 指定另一個已解開的 LINE 外掛資料夾。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LINE_ID = 'ophjlpahpchlmihnnnihgmmeilfjmjjc'
const LINE_INDEX_URL = `chrome-extension://${LINE_ID}/index.html`
const PORT = 19223
const HOME = process.env.LINE_BG_HOME ?? path.join(os.homedir(), '.teamuq', 'tools', 'line-bg')
const PROFILE_DIR = path.join(HOME, 'profile')
const EXT_DIR = path.join(HOME, 'extension')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function chromePath() {
  const candidates = [
    process.env.LINE_BG_CHROME,
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe')
  ].filter(Boolean)
  const found = candidates.find((p) => fs.existsSync(p))
  if (!found) throw new Error('找不到 chrome.exe（可用 LINE_BG_CHROME 指定）')
  return found
}

/** 和本機 Chrome 主版本一致的一般 User-Agent（headless 預設的 UA 帶 HeadlessChrome）。 */
function userAgent(chrome) {
  const dir = path.dirname(chrome)
  const version = fs.readdirSync(dir).filter((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n)).sort((a, b) => cmpVersion(b, a))[0]
  const major = version ? version.split('.')[0] : '155'
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

function cmpVersion(a, b) {
  const pa = a.split(/[._]/).map(Number)
  const pb = b.split(/[._]/).map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

/** 找已安裝的 LINE 外掛（最新版本資料夾）。 */
function extensionSource() {
  if (process.env.LINE_BG_EXTENSION_SOURCE) return process.env.LINE_BG_EXTENSION_SOURCE
  const profilesRoot = path.join(os.homedir(), '.teamuq', 'tools', 'shared-browser', 'state', 'profiles')
  const versions = []
  for (const root of fs.existsSync(profilesRoot) ? fs.readdirSync(profilesRoot) : []) {
    const userData = path.join(profilesRoot, root)
    for (const profile of fs.readdirSync(userData)) {
      const extRoot = path.join(userData, profile, 'Extensions', LINE_ID)
      if (!fs.existsSync(extRoot)) continue
      for (const v of fs.readdirSync(extRoot)) {
        if (fs.existsSync(path.join(extRoot, v, 'manifest.json'))) versions.push({ version: v, dir: path.join(extRoot, v) })
      }
    }
  }
  versions.sort((a, b) => cmpVersion(b.version, a.version))
  if (!versions.length) throw new Error('找不到已安裝的 LINE Chrome 外掛（可用 LINE_BG_EXTENSION_SOURCE 指定資料夾）')
  return versions[0].dir
}

/** 複製一份可「載入未封裝」的副本：去掉 _metadata（底線開頭的保留名稱，_locales 除外）；版本相同就沿用。 */
function prepareExtension() {
  const src = extensionSource()
  const srcVersion = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8')).version
  const current = fs.existsSync(path.join(EXT_DIR, 'manifest.json')) ? JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8')).version : null
  if (current !== srcVersion) {
    fs.rmSync(EXT_DIR, { recursive: true, force: true })
    fs.cpSync(src, EXT_DIR, { recursive: true, filter: (p) => path.relative(src, p).split(path.sep)[0] !== '_metadata' })
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'))
  if (typeof manifest.key !== 'string') throw new Error('LINE 外掛的 manifest 沒有 key，載入後外掛 ID 會改變、登入狀態無法沿用')
  return { dir: EXT_DIR, version: manifest.version }
}

async function getJson(pathname, init) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, { signal: AbortSignal.timeout(3000), ...init })
  if (!res.ok) throw new Error(`${pathname} → ${res.status}`)
  return res.json()
}

async function running() {
  try {
    return await getJson('/json/version')
  } catch {
    return null
  }
}

/** 對一個 CDP WebSocket 端點送一串指令。 */
async function cdp(wsUrl, run) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('CDP 連線失敗')), { once: true })
  })
  let next = 1
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data))
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  try {
    return await run(send)
  } finally {
    ws.close()
  }
}

async function launch({ headless }) {
  if (await running()) throw new Error(`port ${PORT} 已經有 Chrome 在跑；先執行 stop`)
  fs.mkdirSync(PROFILE_DIR, { recursive: true })
  const ext = prepareExtension()
  const chrome = chromePath()
  const args = [
    `--user-data-dir=${PROFILE_DIR}`,
    `--remote-debugging-port=${PORT}`,
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-agent=${userAgent(chrome)}`,
    ...(headless ? ['--headless'] : []),
    'about:blank'
  ]
  spawn(chrome, args, { detached: true, stdio: 'ignore', windowsHide: headless }).unref()
  let version = null
  for (let i = 0; i < 60 && !(version = await running()); i++) await sleep(250)
  if (!version) throw new Error('Chrome 沒有在 15 秒內開好 CDP')
  const id = await cdp(version.webSocketDebuggerUrl, async (send) => (await send('Extensions.loadUnpacked', { path: ext.dir })).id)
  if (id !== LINE_ID) throw new Error(`載入的外掛 ID 是 ${id}，不是 LINE（${LINE_ID}）`)
  const tab = await ensureLineTab()
  return { extension: { id, version: ext.version }, lineTab: tab.id }
}

async function ensureLineTab() {
  const targets = await getJson('/json/list')
  const tab = targets.find((t) => t.type === 'page' && t.url.startsWith(LINE_INDEX_URL))
  return tab ?? getJson(`/json/new?${encodeURIComponent(LINE_INDEX_URL)}`, { method: 'PUT' })
}

/** LINE 分頁的狀態：ready＝已登入（有聊天導覽列）；login＝停在登入畫面；loading＝還沒好。 */
async function lineState(tab) {
  return cdp(`ws://127.0.0.1:${PORT}/devtools/page/${tab.id}`, async (send) => {
    for (let i = 0; i < 40; i++) {
      const r = await send('Runtime.evaluate', {
        returnByValue: true,
        expression: `(() => document.querySelector('[class*="gnb-module__nav_list"]') ? 'ready' : (document.querySelector('input[type="password"], img[alt*="QR" i], canvas') ? 'login' : 'loading'))()`
      }).catch(() => ({ result: { value: 'loading' } }))
      const state = r.result?.value
      if (state === 'ready' || (state === 'login' && i > 8)) return state
      await sleep(250)
    }
    return 'loading'
  })
}

async function status() {
  const version = await running()
  if (!version) return { running: false }
  const targets = await getJson('/json/list')
  const tab = targets.find((t) => t.type === 'page' && t.url.startsWith(LINE_INDEX_URL)) ?? null
  const worker = targets.some((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${LINE_ID}/`))
  return {
    running: true,
    browser: version.Browser,
    headless: /Headless/i.test(version['User-Agent'] ?? '') || null,
    extensionWorker: worker,
    lineTab: tab ? tab.id : null,
    line: tab ? await lineState(tab) : 'no_tab'
  }
}

async function stop() {
  const version = await running()
  if (!version) return { stopped: false, reason: 'not_running' }
  await cdp(version.webSocketDebuggerUrl, (send) => send('Browser.close').catch(() => undefined))
  for (let i = 0; i < 40 && (await running()); i++) await sleep(250)
  return { stopped: !(await running()) }
}

async function main() {
  const cmd = process.argv[2]
  let out
  if (cmd === 'start') out = { ...(await launch({ headless: true })), ...(await status()) }
  else if (cmd === 'login') {
    out = { ...(await launch({ headless: false })), next: '請在剛開的 Chrome 視窗登入 LINE；登入完成後執行 stop，再執行 start 改在背景跑。' }
  } else if (cmd === 'status') out = await status()
  else if (cmd === 'stop') out = await stop()
  else {
    console.error('用法：node scripts/line-bg/line-bg.mjs <login|start|status|stop>')
    process.exit(2)
  }
  console.log(JSON.stringify(out, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
