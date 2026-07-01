// 啟動驗證腳本：以 electron-vite preview 啟動已 build 的 app，
// 等待固定秒數後優雅關閉。捕捉 main 進程是否成功到達「視窗建立」階段。
// 退出碼：0 = 視窗建立成功；1 = 啟動失敗 / 逾時未見就緒訊號。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')

const child = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['electron-vite', 'preview'],
  {
    cwd: projectRoot,
    env: {
      ...process.env,
      // 軟體渲染，避免無頭環境缺 GPU 而崩潰
      ELECTRON_DISABLE_GPU: '1'
    },
    shell: process.platform === 'win32'
  }
)

let sawReady = false
let output = ''

function scan(buf) {
  const s = buf.toString()
  output += s
  process.stdout.write(s)
  // electron-vite preview 啟動後會印 build/preview 訊息；
  // 我們額外靠 main 進程的 console 來判斷視窗已建立（見下方 inject）。
  if (s.includes('[smoke] window-created')) {
    sawReady = true
    cleanup(0)
  }
}

let done = false
function cleanup(code) {
  if (done) return
  done = true
  try {
    child.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    process.exit(code)
  }, 1500)
}

child.stdout.on('data', scan)
child.stderr.on('data', scan)
child.on('exit', (code) => {
  if (!done) {
    console.error(`\n[smoke] electron exited early code=${code}`)
    process.exit(sawReady ? 0 : 1)
  }
})

// 安全逾時：20 秒沒看到就緒訊號就判失敗
setTimeout(() => {
  if (!sawReady) {
    console.error('\n[smoke] timeout: never saw window-created signal')
    cleanup(1)
  }
}, 20000)
