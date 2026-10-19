// 啟動「真正的」已 build app（out/main/index.js），用隔離的 userData 目錄，
// 觀察 main 進程是否：
//   1) 開 DB 並跑 migration（看 [db] opened ... log）
//   2) 視窗建立（[smoke] window-created）
//   3) watcher 落庫（若 LINE 開著，會看到 [db] insertMessage 隱含的 evt；
//      無 LINE 也沒關係，本 probe 只證 DB 初始化 + 真實 app 路徑可走通）
// 之後本 probe 退出，呼叫端再用 sqlite 檢查 DB 檔的表與列數。
//
// 用法：node scripts/probe-app-launch.mjs <userDataDir>
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')
const userDataDir = process.argv[2]
if (!userDataDir) {
  console.error('usage: node probe-app-launch.mjs <userDataDir>')
  process.exit(2)
}

// 直接以 electron 跑已 build 的 main bundle（out/main/index.js），
// 以 --user-data-dir 隔離，避免污染真實 userData。
const child = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['electron', '.', `--user-data-dir=${userDataDir}`],
  {
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_DISABLE_GPU: '1', LINE_TODO_DEBUG: '1' },
    shell: process.platform === 'win32'
  }
)

let sawDb = false
let sawWindow = false
let output = ''
let done = false

function finish(code) {
  if (done) return
  done = true
  try { child.kill('SIGTERM') } catch {}
  setTimeout(() => {
    try { child.kill('SIGKILL') } catch {}
    console.log(`[applaunch] sawDb=${sawDb} sawWindow=${sawWindow}`)
    process.exit(code)
  }, 1200)
}

function scan(buf) {
  const s = buf.toString()
  output += s
  process.stdout.write(s)
  if (s.includes('[db] opened')) sawDb = true
  if (s.includes('[smoke] window-created')) sawWindow = true
  // DB 初始化 + 視窗建立都看到就夠了（再多等也只是 watcher 輪詢）
  if (sawDb && sawWindow) {
    // 多等 3.5s 讓 watcher 至少跑一輪 --once（若 LINE 開著會落庫）
    setTimeout(() => finish(0), 3500)
  }
}

child.stdout.on('data', scan)
child.stderr.on('data', scan)
child.on('exit', (code) => {
  if (!done) {
    console.error(`[applaunch] electron exited early code=${code}`)
    process.exit(sawDb && sawWindow ? 0 : 1)
  }
})

setTimeout(() => {
  if (!done) {
    console.error('[applaunch] timeout waiting for db+window')
    finish(sawDb && sawWindow ? 0 : 1)
  }
}, 25000)
