// probe-driver-settings —— driver_post Batch 2 驗收 M2：設定相容、合併與 fillOnly 強制。
//
// 用 production 的 src/main/config/settings.ts（esbuild 打包），暫存 userData（結束時刪除）。
// 兩條路徑都測：runtime 的 createSettingsStore（實例）與模組層 getSettings/updateSettings。
//   S1 舊 settings.json（沒有 driverPost）→ 預設 { enabled:true, mode:'fillOnly', verifyReadByDb:true }
//   S2 patch 只給 mode → enabled 不變
//   S3 非法 mode → 保持現值（仍是 fillOnly）
//   S4 patch 其他欄位（pollIntervalSec）→ driverPost 不被洗掉
//   S5 settings.json 存有 fillAndSend → 載入後是 fillOnly；patch 送 fillAndSend 也是 fillOnly
//   S6 verifyReadByDb（使用者裁定：預設開、可關）：關閉後落檔、重新載入仍為 false；非法值保持現值
//
// 執行：npx electron scripts/probe-driver-settings.cjs（exit 0 = 全數 PASS）

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const esbuild = require('esbuild')

let app = null
try { app = require('electron').app } catch { app = null }

const ENTRY = `export { createSettingsStore, configureSettingsHost, getSettings, updateSettings, normalizeDriverPost, SEND_UNLOCKED } from './src/main/config/settings.ts'\n`

async function main() {
  const root = path.join(__dirname, '..')
  const entryFile = path.join(root, '__probe_settings_entry.ts')
  const outFile = path.join(root, '__probe_settings.bundle.cjs')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-driver-settings-'))
  const cleanup = () => { for (const f of [entryFile, outFile]) { try { fs.rmSync(f, { force: true }) } catch (_) {} } try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) {} }
  const results = []
  const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond }); console.log(`[probe-settings] ${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' ' + detail : ''}`) }
  const secrets = { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() }
  const DEF = JSON.stringify({ enabled: true, mode: 'fillOnly', verifyReadByDb: true })
  try {
    fs.writeFileSync(entryFile, ENTRY, 'utf8')
    await esbuild.build({ entryPoints: [entryFile], bundle: true, platform: 'node', format: 'cjs', outfile: outFile, absWorkingDir: root, logLevel: 'silent', external: ['electron'] })
    const m = require(outFile)
    check('S0 SEND_UNLOCKED is false', m.SEND_UNLOCKED === false)

    // ── 實例路徑（createSettingsStore）──
    const dirA = path.join(tmp, 'a'); fs.mkdirSync(dirA)
    fs.writeFileSync(path.join(dirA, 'settings.json'), JSON.stringify({ pollIntervalSec: 42, aiProvider: 'claudeCli' }), 'utf8')
    let st = m.createSettingsStore({ userDataDir: dirA, secrets })
    check('S1 old settings.json → driverPost defaults (instance)', JSON.stringify(st.get().driverPost) === DEF && st.get().pollIntervalSec === 42, JSON.stringify(st.get().driverPost))
    st.update({ driverPost: { enabled: false } })
    st.update({ driverPost: { mode: 'fillOnly' } })
    check('S2 patch only mode keeps enabled=false (instance)', st.get().driverPost.enabled === false && st.get().driverPost.mode === 'fillOnly')
    st.update({ driverPost: { mode: 'bogus' } })
    check('S3 illegal mode keeps current (instance)', st.get().driverPost.mode === 'fillOnly' && st.get().driverPost.enabled === false)
    st.update({ pollIntervalSec: 77 })
    check('S4 patching another field keeps driverPost (instance)', st.get().driverPost.enabled === false && st.get().pollIntervalSec === 77 && st.get().aiProvider === 'claudeCli')
    st.update({ driverPost: { mode: 'fillAndSend' } })
    check('S5 patch fillAndSend → fillOnly (instance)', st.get().driverPost.mode === 'fillOnly')
    st.update({ driverPost: { verifyReadByDb: false } })
    st.update({ driverPost: { enabled: true } })
    st.update({ driverPost: { verifyReadByDb: 'no' } })
    const onDisk = JSON.parse(fs.readFileSync(path.join(dirA, 'settings.json'), 'utf8')).driverPost
    check('S6 verifyReadByDb=false persisted; illegal value keeps current (instance)', st.get().driverPost.verifyReadByDb === false && onDisk.verifyReadByDb === false && onDisk.enabled === true, JSON.stringify(onDisk))
    st = m.createSettingsStore({ userDataDir: dirA, secrets })
    check('S6 reload keeps verifyReadByDb=false (instance)', st.get().driverPost.verifyReadByDb === false && st.get().driverPost.enabled === true)
    const dirB = path.join(tmp, 'b'); fs.mkdirSync(dirB)
    fs.writeFileSync(path.join(dirB, 'settings.json'), JSON.stringify({ driverPost: { enabled: true, mode: 'fillAndSend' } }), 'utf8')
    const stB = m.createSettingsStore({ userDataDir: dirB, secrets })
    check('S5 settings.json with fillAndSend loads as fillOnly; verifyReadByDb defaults true (instance)', stB.get().driverPost.mode === 'fillOnly' && stB.get().driverPost.verifyReadByDb === true, JSON.stringify(stB.get().driverPost))

    // ── 模組層路徑（getSettings / updateSettings）──
    const dirC = path.join(tmp, 'c'); fs.mkdirSync(dirC)
    fs.writeFileSync(path.join(dirC, 'settings.json'), JSON.stringify({ pollIntervalSec: 30, driverPost: { mode: 'fillAndSend' } }), 'utf8')
    m.configureSettingsHost({ userDataDir: dirC, safeStorage: secrets })
    check('S1/S5 module getSettings: fillAndSend → fillOnly, missing fields default', JSON.stringify(m.getSettings().driverPost) === DEF, JSON.stringify(m.getSettings().driverPost))
    m.updateSettings({ driverPost: { enabled: false } })
    m.updateSettings({ driverPost: { mode: 'fillAndSend' } })
    check('S2/S5 module: patch mode keeps enabled; fillAndSend → fillOnly', m.getSettings().driverPost.enabled === false && m.getSettings().driverPost.mode === 'fillOnly')
    m.updateSettings({ driverPost: { mode: 'weird' } })
    check('S3 module: illegal mode keeps current', m.getSettings().driverPost.mode === 'fillOnly')
    m.updateSettings({ driverPost: { verifyReadByDb: false } })
    m.updateSettings({ concurrency: 2 })
    const disk = JSON.parse(fs.readFileSync(path.join(dirC, 'settings.json'), 'utf8'))
    check('S4/S6 module: other patch keeps driverPost; verifyReadByDb=false persisted', disk.driverPost.verifyReadByDb === false && disk.driverPost.enabled === false && disk.concurrency === 2, JSON.stringify(disk.driverPost))

    // ── normalizeDriverPost 單元 ──
    const d = { enabled: true, mode: 'fillOnly', verifyReadByDb: true }
    check('N1 normalize(null) → defaults', JSON.stringify(m.normalizeDriverPost(null, d)) === DEF)
    check('N2 normalize keeps valid booleans', JSON.stringify(m.normalizeDriverPost({ enabled: false, verifyReadByDb: false }, d)) === JSON.stringify({ enabled: false, mode: 'fillOnly', verifyReadByDb: false }))

    const failed = results.filter((r) => !r.ok)
    console.log(`[probe-settings] ${results.length - failed.length}/${results.length} passed`)
    return failed.length === 0 ? 0 : 1
  } catch (err) {
    console.error('[probe-settings] ERROR', err && err.stack ? err.stack : err)
    return 1
  } finally {
    cleanup()
  }
}

if (app && app.whenReady) app.whenReady().then(() => main()).then((c) => app.exit(c))
else main().then((c) => process.exit(c))
