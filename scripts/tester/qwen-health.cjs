// qwen 服務健檢：用 eval/.qwen-key 打 /v1/models + 一次極小 chat.completions，
// 確認 502 是暫時還是持續。金鑰遮罩。執行：electron scripts/tester/qwen-health.cjs
const { app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const OpenAI = require('openai')

app.setName('line-todo')
try { app.setPath('userData', path.join(app.getPath('appData'), 'line-todo')) } catch (_) {}

app.whenReady().then(async () => {
  try {
    const key = fs.readFileSync(path.join(__dirname, '..', '..', 'eval', '.qwen-key'), 'utf8').trim()
    const client = new OpenAI({ apiKey: key, baseURL: 'https://qwen.tuq.tw/v1', timeout: 30000, maxRetries: 0 })
    // 1) models
    let modelsOk = false, modelsErr = null
    try {
      const r = await client.models.list()
      modelsOk = true
      console.log('[health] models OK count=' + r.data.length + ' first=' + (r.data[0] && r.data[0].id))
    } catch (e) {
      modelsErr = (e && (e.status ? e.status + ' ' : '') + (e.message || String(e)))
      console.log('[health] models FAIL=' + modelsErr)
    }
    // 2) tiny chat completion
    let chatOk = false, chatErr = null
    try {
      const c = await client.chat.completions.create({
        model: 'qwen36-fp8', temperature: 0,
        messages: [{ role: 'user', content: 'reply with the single word: ok' }]
      })
      chatOk = true
      console.log('[health] chat OK content=' + JSON.stringify(c.choices[0].message.content).slice(0, 40))
    } catch (e) {
      chatErr = (e && (e.status ? e.status + ' ' : '') + (e.message || String(e)))
      console.log('[health] chat FAIL=' + chatErr)
    }
    console.log('[health] VERDICT=' + JSON.stringify({ modelsOk, chatOk, serviceUp: modelsOk && chatOk }))
    app.exit(0)
  } catch (err) {
    console.error('[health] FAILED: ' + (err && err.stack ? err.stack : err))
    app.exit(1)
  }
})
