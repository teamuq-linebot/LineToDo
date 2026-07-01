// 只檢查 App safeStorage 金鑰現況（不解密回顯、不跑 pipeline）。
// 對齊 App 身份；讀真實 keyPath；若 safeStorage 已有金鑰 → hasApiKey=true。
// 金鑰一律遮罩。執行：electron scripts/tester/check-key.cjs
const { app, safeStorage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

app.setName('line-todo')
try { app.setPath('userData', path.join(app.getPath('appData'), 'line-todo')) } catch (_) {}

function maskKey(k) {
  if (!k || typeof k !== 'string') return '(none)'
  const s = k.trim()
  if (s.length <= 6) return '***'
  return s.slice(0, 4) + '…' + s.slice(-2)
}

app.whenReady().then(() => {
  try {
    const userData = app.getPath('userData')
    const keyPath = path.join(userData, 'qwen.key')
    const evalKey = path.join(__dirname, '..', '..', 'eval', '.qwen-key')
    const ssAvail = safeStorage.isEncryptionAvailable()
    const keyExists = fs.existsSync(keyPath)
    console.log('[key] userData=' + userData)
    console.log('[key] safeStorage.available=' + ssAvail)
    console.log('[key] qwen.key exists=' + keyExists + (keyExists ? (' size=' + fs.statSync(keyPath).size) : ''))

    // hasApiKey 判定（同 App hasSafeStorageKey()：檔在 + 後端可用）。
    let hasApiKey = keyExists && ssAvail
    let decMask = '(not-read)'
    if (hasApiKey) {
      try {
        const buf = fs.readFileSync(keyPath)
        const dec = safeStorage.decryptString(buf)
        decMask = maskKey(dec)
        hasApiKey = !!(dec && dec.trim())
      } catch (e) {
        decMask = '(decrypt-failed)'
        hasApiKey = false
      }
    }
    console.log('[key] hasApiKey(safeStorage)=' + hasApiKey + ' keyMask=' + decMask)

    // eval/.qwen-key 備援（注入用）。
    const evalExists = fs.existsSync(evalKey)
    let evalMask = '(none)'
    if (evalExists) {
      try { evalMask = maskKey(fs.readFileSync(evalKey, 'utf8')) } catch (_) {}
    }
    console.log('[key] eval/.qwen-key exists=' + evalExists + ' mask=' + evalMask)

    console.log('[key] VERDICT=' + JSON.stringify({ hasApiKey, needInject: !hasApiKey && evalExists }))
    app.exit(0)
  } catch (err) {
    console.error('[key] FAILED: ' + (err && err.stack ? err.stack : err))
    app.exit(1)
  }
})
