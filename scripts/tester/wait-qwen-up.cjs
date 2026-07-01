// 輪詢 qwen /v1/models 直到服務恢復（成功）或達最大嘗試次數。成功 exit 0，逾時 exit 2。
// 每次嘗試印一行狀態。執行：electron scripts/tester/wait-qwen-up.cjs
const { app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const OpenAI = require('openai')

app.setName('line-todo')
try { app.setPath('userData', path.join(app.getPath('appData'), 'line-todo')) } catch (_) {}

const MAX_TRIES = 40        // 40 * 20s ≈ 13 分鐘
const INTERVAL_MS = 20000

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

app.whenReady().then(async () => {
  const key = fs.readFileSync(path.join(__dirname, '..', '..', 'eval', '.qwen-key'), 'utf8').trim()
  const client = new OpenAI({ apiKey: key, baseURL: 'https://qwen.tuq.tw/v1', timeout: 25000, maxRetries: 0 })
  for (let i = 1; i <= MAX_TRIES; i++) {
    try {
      const r = await client.models.list()
      console.log('[wait] try=' + i + ' QWEN-UP models=' + r.data.length)
      app.exit(0)
      return
    } catch (e) {
      const s = (e && e.status) ? e.status : '?'
      console.log('[wait] try=' + i + '/' + MAX_TRIES + ' down status=' + s)
      if (i < MAX_TRIES) await sleep(INTERVAL_MS)
    }
  }
  console.log('[wait] TIMEOUT qwen still down after ' + MAX_TRIES + ' tries')
  app.exit(2)
})
