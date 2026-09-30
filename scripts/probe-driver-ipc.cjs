// probe-driver-ipc —— driver_post Batch 5 驗收：IPC 接線（driver.ipc.ts ↔ preload api.driver ↔ renderer）。
//
// 用 production 的 src/main/driver/index.ts（createDriver）與 src/main/ipc/driver.ipc.ts（esbuild 打包），
// 以及 electron-vite build 產出的 preload（out/preload/index.js；先跑 `npm run build`）。
// LINE 端全部是假 port（LineUiPortV3、LineOrderPort 注入 createDriver）：不 spawn helper、不讀 LINE DB、不碰 LINE。
// renderer 是隱藏的 BrowserWindow（contextIsolation＋sandbox，和 production window.ts 相同），
// 所有呼叫都從 renderer 的 window.api.driver 發出，經 ipcRenderer.invoke → ipcMain → driver → 假 port。
//
// 驗證：
//   A  preload 暴露 api.driver 五個方法；driver:status 的請求／回應（含 targetProblem，訊息來自 messages.ts）
//   B  driver:postDraft 成功；進度事件送到 renderer（階段順序、attemptId）；waitingForQuiet（activate／click／fill）
//      開始時 true、該動作回來後 false；failure 結果的 body／tail／message
//   C  設定關閉：postDraft→disabled、focusLine／clearFilled→disabled，port 沒有任何呼叫；重新開啟後同一個 attempt 仍可用
//   D  focusLine／clearFilled 的四種後續：4b 清除成功、4c 清除被拒（edit_changed／title_changed）、
//      4d 切到 LINE 時聊天室已變（title_changed、activated=true）、4f 超過 5 分鐘（attempt_expired，不呼叫 port）；
//      另外 focused、清除後作廢、下一次 postDraft 清除舊 attempt、busy、參數錯誤
//   E  非主視窗的 webContents 呼叫被拒；進度只推給主視窗
//   review F1（FR- 開頭）：
//     D13–D15 focusLine 時 helper 回 user_busy → renderer 收到 code=user_busy、activated=false、messages.ts 文案；
//             focusEdit 帶 Q_focus；放開後再按一次可以成功
//     P6–P10  psHost ↔ 假 helper（node，取代 PowerShell；照 line-uia-host.ps1 focusEdit 分支的順序：守門 → 切前景 → 標題 →
//             最後一刻安靜 → 放游標）：按鍵按著／未滿安靜期 → user_busy 而且沒有切前景；放開後才切；psHost 帶 quiet 與 guarded 逾時
//     H1–H5   line-uia-host.ps1 靜態結構檢查（只讀文字，不執行）：所有把 LINE 帶到前景的呼叫都在 Raise-LineGuarded 內、
//             而且在「要求無按鍵」的 QuietGate 失敗返回之後；activateLine、focusEdit 只經由它切前景
//
// 執行：npx electron scripts/probe-driver-ipc.cjs（exit 0 = 全數 PASS）

const path = require('node:path')
const fs = require('node:fs')
const esbuild = require('esbuild')

const { app, BrowserWindow } = require('electron')

const ENTRY = `
export { createDriver } from './src/main/driver/index.ts'
export { registerDriverIpc, createProgressPusher, DRIVER_PROGRESS_CHANNEL } from './src/main/ipc/driver.ipc.ts'
export { messageFor, followUpMessage, HAND_BACK_FAILED_NOTE, FOLLOW_UP_EXPIRED_NOTE, FOCUS_USER_BUSY_NOTE, detailsText } from './src/main/driver/messages.ts'
export { PortCommandError, QUIET, HOST_TIMEOUTS_MS } from './src/main/driver/port.ts'
export { createPsHost } from './src/main/driver/psHost.ts'
`

// 假 helper（取代 PowerShell；只給 P 段的 psHost 傳輸測試）：JSON Lines，guardedClick／readSearch 先送一個 waitingForQuiet 事件。
const FAKE_HELPER = `
const rl = require('node:readline').createInterface({ input: process.stdin })
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ id: 0, ok: true, result: { protocol: 3, psVersion: 'fake', languageMode: 'FullLanguage', ocrLanguages: ['zh-Hant-TW'], dpiAwareness: 'per_monitor_v2', pid: process.pid }, activity: false })
rl.on('line', (line) => {
  const req = JSON.parse(line)
  if (req.cmd === 'shutdown') { out({ id: req.id, ok: true, result: { bye: true }, activity: false }); process.exit(0) }
  if (req.cmd === 'guardedClick' || req.cmd === 'readSearch') out({ id: req.id, event: 'waitingForQuiet', maxWaitMs: (req.args && req.args.quiet && req.args.quiet.maxWaitMs) || 3000 })
  if (req.cmd === 'focusEdit') { focusEdit(req); return }
  setTimeout(() => {
    if (req.cmd === 'guardedClick') out({ id: req.id, ok: true, result: { clicked: false, dryRun: true, selectedIndexAfter: null }, activity: false, quietWaitMs: 700 })
    else if (req.cmd === 'readSearch') out({ id: req.id, ok: true, result: { value: '' }, activity: false })
    else out({ id: req.id, ok: false, error: 'unknown_cmd', activity: false })
  }, 50)
})
// focusEdit：照 line-uia-host.ps1 的 focusEdit 分支（Raise-LineGuarded）的順序。使用者的鍵盤／閒置狀態由 STATE 檔模擬
// （{ keysDown, idleMs, lateInput }），每 50 ms 重讀一次；所有「會改變 LINE 的動作」寫進 TRACE 檔。
const fs = require('node:fs')
const trace = (s) => fs.appendFileSync(process.env.PROBE_TRACE, s + '\\n')
const state = () => JSON.parse(fs.readFileSync(process.env.PROBE_STATE, 'utf8'))
function focusEdit(req) {
  const q = (req.args && req.args.quiet) || {}
  trace('args ' + JSON.stringify(q))
  const min = Math.max(Number(q.minIdleMs) || 500, 500) // RAISE_FLOOR_MS.focus
  const max = Number(q.maxWaitMs) || 3000
  const quietNow = () => { const s = state(); return s.idleMs >= min && !s.keysDown } // requireNoKeys 一律 true
  if (!quietNow()) out({ id: req.id, event: 'waitingForQuiet', maxWaitMs: max })
  const t0 = Date.now()
  const loop = () => {
    if (quietNow()) {
      trace('raise') // ShowWindow／SetForegroundWindow
      const s = state()
      if (s.lateInput || !quietNow()) { trace('refuse user_busy late'); out({ id: req.id, ok: false, refusal: 'user_busy', detail: 'late', activity: true, quietWaitMs: Date.now() - t0 }); return }
      trace('setFocus')
      out({ id: req.id, ok: true, result: { focused: true }, activity: false, quietWaitMs: Date.now() - t0 })
      return
    }
    if (Date.now() - t0 > max) { trace('refuse user_busy'); out({ id: req.id, ok: false, refusal: 'user_busy', detail: '', activity: true, quietWaitMs: Date.now() - t0 }); return }
    setTimeout(loop, 50)
  }
  loop()
}
`

// ── 合成世界（同 probe-driver-statemachine）──
let seed = 424242 >>> 0
const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const POOL = '春夏秋冬東南西北山川河海林森花草木石金銀銅鐵天地日月星雲風雨雪霜紅橙黃綠藍紫白黑晴陰光影龍虎鳳龜鶴鹿馬牛羊雞犬貓'.split('')
function lev(a, b) { const A = [...a], B = [...b]; let prev = Array.from({ length: B.length + 1 }, (_, j) => j); for (let i = 1; i <= A.length; i++) { const cur = [i]; for (let j = 1; j <= B.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1)); prev = cur } return prev[B.length] }
const NAMES = []
while (NAMES.length < 60) { const s = Array.from({ length: 4 + Math.floor(rnd() * 3) }, () => POOL[Math.floor(rnd() * POOL.length)]).join(''); if (NAMES.every((x) => lev(x, s) >= 3)) NAMES.push(s) }
const T0 = Date.now() - 10 * 60 * 1000
const ROWS = NAMES.map((name, i) => ({ chatId: 'c' + String(i).padStart(2, '0'), lastUpdated: T0 - i * 60_000, pinned: false, hidden: false, unread: 0, midType: 0, status: 1, name }))
const S = 12 // 位移
const ocrLine = (text, y) => {
  let x = 60
  const words = [...String(text)].filter((c) => c.trim()).map((c) => { const w = { text: c, rect: { x, y, w: 12, h: 15 } }; x += 14; return w })
  return { text: words.map((w) => w.text).join(' '), rect: { x: 60, y, w: Math.max(1, x - 62), h: 15 }, words }
}
// todo → chat：todo-1＝名次 20（螢幕第 8 列）；todo-far＝名次 45（在可見範圍下方）；todo-noname＝沒有名稱
const TODOS = { 'todo-1': 'c20', 'todo-far': 'c45', 'todo-noname': 'c-noname' }

async function main() {
  const root = path.join(__dirname, '..')
  const preload = path.join(root, 'out', 'preload', 'index.js')
  if (!fs.existsSync(preload)) { console.error('[probe-ipc] missing out/preload/index.js — run `npm run build` first'); return 2 }
  const entryFile = path.join(root, '__probe_ipc_entry.ts')
  const outFile = path.join(root, '__probe_ipc.bundle.cjs')
  const extraFiles = []
  const cleanup = () => { for (const f of [entryFile, outFile, ...extraFiles]) { try { fs.rmSync(f, { force: true }) } catch (_) {} } }
  const results = []
  const check = (name, ok, info = '') => { results.push({ name, ok: !!ok }); console.log(`[probe-ipc] ${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`) }
  let win = null
  let other = null
  let dispose = null
  const tmp = process.env.TEMP || require('node:os').tmpdir()
  const lineTmpDirs = () => { try { return fs.readdirSync(tmp).filter((n) => /^(linedb-|linekey-scan-)/.test(n)).length } catch (_) { return -1 } }
  const tmpBefore = lineTmpDirs()
  try {
    fs.writeFileSync(entryFile, ENTRY, 'utf8')
    await esbuild.build({ entryPoints: [entryFile], bundle: true, platform: 'node', format: 'cjs', outfile: outFile, absWorkingDir: root, logLevel: 'silent', external: ['electron', 'koffi', 'better-sqlite3', 'better-sqlite3-multiple-ciphers'] })
    const m = require(outFile)

    // ── 假 port ──
    const calls = []
    const cfg = {
      quietOn: new Set(), // 'activateLine' | 'guardedClick' | 'setEdit'：這些指令會先送 waitingForQuiet
      focusEdit: 'ok', // 'ok' | 'title_changed' | 'throw_not_running'
      clear: 'ok', // 'ok' | 'edit_mismatch' | 'title_changed'
      readListDelayMs: 0,
      postTitleText: null, // null＝目標名稱；'' ＝讀不到
      handBack: true
    }
    let quietListener = null
    let clicked = false
    const focusQuiet = []
    const rowRect = (j) => ({ x: 0, y: 100 + 71 * j - 41, w: 300, h: 71 })
    const listRows = () => {
      const out = []
      for (let j = 0; j <= 11; j++) {
        const chat = ROWS[S + j]
        const partial = j === 0
        const r = { index: j, rect: rowRect(j), visibleH: partial ? 30 : 71, hash: 'h-' + (chat ? chat.chatId : 'none') + '-' + j, selected: j === 3 }
        if (!partial) { const line = chat ? [ocrLine(chat.name, 100 + 71 * j - 30)] : []; r.ocr = { R1: line, R2: line, R3: line } }
        out.push(r)
      }
      return out
    }
    const titleOf = (text, hash) => { const line = text ? [ocrLine(text, 20)] : []; return { ok: true, value: { byConfig: { T1: line, T2: line, T3: line }, stripRect: { x: 0, y: 10, w: 600, h: 31 }, stripHash: hash, blank: !text } } }
    const quiet = async (cmd, q) => {
      if (cfg.quietOn.has(cmd) && quietListener) { quietListener({ command: cmd, maxWaitMs: q.maxWaitMs }); await new Promise((r) => setTimeout(r, 60)) }
    }
    const targetName = ROWS[20].name
    const ui = {
      hello: async () => { calls.push('hello'); return { protocol: 3, psVersion: '5.1', languageMode: 'FullLanguage', ocrLanguages: ['zh-Hant-TW'], dpiAwareness: 'per_monitor_v2', pid: 1 } },
      beginSession: async () => { calls.push('beginSession'); clicked = false },
      endSession: async () => { calls.push('endSession') },
      locateLine: async () => { calls.push('locateLine'); return { status: 'ok', pid: 100, iconic: false, exeVersion: 'fake', otherTopLevel: [] } },
      probeAnchors: async () => { calls.push('probeAnchors'); return { ok: true, missing: [] } },
      readSearch: async () => { calls.push('readSearch'); return '' },
      readList: async () => { calls.push('readList'); if (cfg.readListDelayMs) await new Promise((r) => setTimeout(r, cfg.readListDelayMs)); return { ok: true, value: { rows: listRows(), listRect: { x: 0, y: 59, w: 300, h: 800 }, stable: true, snapshotId: 1 } } },
      readListGeometry: async () => { calls.push('readListGeometry'); return { ok: true, value: { rows: listRows().map(({ ocr, ...r }) => r), listRect: { x: 0, y: 59, w: 300, h: 800 }, stable: true, snapshotId: 2 } } },
      readTitle: async () => { calls.push('readTitle'); if (!clicked) return titleOf(ROWS[S + 3].name, 'title-before'); return titleOf(cfg.postTitleText === null ? targetName : cfg.postTitleText, 'title-after') },
      activateLine: async (a) => { calls.push('activateLine'); await quiet('activateLine', a.quiet); return { ok: true, value: { foreground: true } } },
      guardedClick: async (a) => { calls.push('guardedClick'); await quiet('guardedClick', a.quiet); clicked = true; return { ok: true, value: { clicked: true, selectedIndexAfter: a.row.index } } },
      waitTitleStable: async () => { calls.push('waitTitleStable'); return { ok: true, value: { stripHash: 'title-after' } } },
      readEdit: async () => { calls.push('readEdit'); return { ok: true, value: { value: '', hasFocus: false } } },
      setEdit: async (text, hash, q) => { calls.push('setEdit'); await quiet('setEdit', q); return { ok: true, value: { readback: text } } },
      clearEditIfEquals: async () => { calls.push('clearEditIfEquals'); return cfg.clear === 'ok' ? { ok: true, value: { cleared: true } } : { ok: false, refusal: cfg.clear } },
      focusEdit: async (hash, q) => {
        calls.push('focusEdit')
        focusQuiet.push(q)
        if (cfg.focusEdit === 'throw_not_running') throw new m.PortCommandError('focusEdit', 'line_not_running')
        if (cfg.focusEdit === 'user_busy_late') return { ok: false, refusal: 'user_busy', detail: 'late' }
        return cfg.focusEdit === 'ok' ? { ok: true, value: { focused: true } } : { ok: false, refusal: cfg.focusEdit, detail: '' }
      },
      handBackFocus: async () => { calls.push('handBackFocus'); return { ok: true, value: { handedBack: cfg.handBack } } },
      telemetry: () => ({ activity: false, quietWaitMs: {} }),
      onQuietWait: (l) => { quietListener = l },
      dispose: async () => { calls.push('dispose') }
    }
    const order = { snapshot: async () => { calls.push('order.snapshot'); return { ok: true, value: { rows: ROWS.map((r) => ({ ...r })), selfMid: 'self-mid', takenAt: Date.now(), newestUpdate: T0, readMs: 1 } } } }

    // ── 設定與時鐘 ──
    const settings = { enabled: true, mode: 'fillOnly', verifyReadByDb: true }
    let clock = 0
    const now = () => Date.now() + clock
    const logs = []
    let handBackFailed = 0

    // ── 視窗與 IPC ──
    const makeWin = () => new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true } })
    win = makeWin()
    other = makeWin()
    const driver = m.createDriver({
      getSettings: () => settings,
      getTodo: (id) => (TODOS[id] ? { chatId: TODOS[id] } : null),
      getChatName: (chatId) => ROWS.find((r) => r.chatId === chatId)?.name ?? null,
      lineTodoHwnd: () => 4242n,
      onHandBackFailed: () => { handBackFailed++ },
      pushProgress: m.createProgressPusher(() => (win && !win.isDestroyed() ? win.webContents : null)),
      log: (l) => logs.push(l),
      ui,
      order,
      now,
      sleep: async () => {}
    })
    dispose = m.registerDriverIpc({ driver, isTrustedSender: (wc) => wc === win.webContents })
    const html = 'data:text/html;charset=utf-8,' + encodeURIComponent('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>probe</body></html>')
    await Promise.all([win.loadURL(html), other.loadURL(html)])
    const R = (js) => win.webContents.executeJavaScript(js)
    const RO = (js) => other.webContents.executeJavaScript(js)
    await R(`window.__ev = []; window.__unsub = window.api.driver.onProgress((p) => window.__ev.push(p)); true`)
    await RO(`window.__ev = []; window.api.driver.onProgress((p) => window.__ev.push(p)); true`)
    const takeEvents = async () => R(`(() => { const e = window.__ev; window.__ev = []; return e })()`)
    const nextRun = () => { clock += 4000 } // 避開 rate_limited（3 s）
    const J = (o) => JSON.stringify(o)

    // ═════ A：preload 與 driver:status ═════
    const shape = await R(`Object.keys(window.api.driver).sort().join(',') + '|' + Object.values(window.api.driver).every((f) => typeof f === 'function')`)
    check('A1 preload exposes api.driver {status,postDraft,focusLine,clearFilled,onProgress}', shape === 'clearFilled,focusLine,onProgress,postDraft,status|true', shape)
    const st1 = await R(`window.api.driver.status({ todoId: 'todo-1' })`)
    check('A2 driver:status request/response', st1.enabled === true && st1.mode === 'fillOnly' && st1.sendAvailable === false && st1.busy === false && st1.lastHostProblem === null && st1.targetProblem === null, J(st1))
    const st2 = await R(`window.api.driver.status({ todoId: 'todo-noname' })`)
    check('A3 status targetProblem chat_name_missing (message from messages.ts)', st2.targetProblem && st2.targetProblem.code === 'chat_name_missing' && st2.targetProblem.message === m.messageFor('chat_name_missing', { stage: 'preflight' }), J(st2.targetProblem))
    const st3 = await R(`window.api.driver.status({ todoId: 'nope' })`)
    check('A4 status targetProblem todo_not_found', st3.targetProblem && st3.targetProblem.code === 'todo_not_found', J(st3.targetProblem))
    const st4 = await R(`window.api.driver.status()`)
    check('A5 status without todoId → targetProblem null', st4.targetProblem === null && st4.enabled === true)
    check('A6 status touched no LINE port', calls.length === 0, calls.join(','))

    // ═════ B：postDraft 與進度事件 ═════
    nextRun()
    cfg.quietOn = new Set(['activateLine', 'guardedClick', 'setEdit'])
    const r1 = await R(`window.api.driver.postDraft({ todoId: 'todo-1', text: '好的，明天見。' })`)
    const ev1 = await takeEvents()
    check('B1 postDraft ok filled via IPC', r1.ok === true && r1.outcome === 'filled' && r1.locate.row === 8 && r1.chatName === ROWS[20].name, r1.ok ? `row=${r1.locate.row}` : r1.code)
    check('B2 success display fields (details from messages.detailsText, ttl 5 min, expiredNote)', r1.ok && r1.details === m.detailsText(r1.locate, r1.open) && r1.handBackNote === null && r1.followUpTtlMs === 300000 && r1.expiredNote === m.FOLLOW_UP_EXPIRED_NOTE)
    const stages = ev1.filter((e) => e.waitingForQuiet === undefined).map((e) => e.stage)
    const wantStages = ['host_start', 'locate_line', 'read_order', 'read_list', 'locate_row', 'activate_line', 'open_chat', 'verify_open', 'check_input_empty', 'fill', 'hand_back', 'cleanup']
    check('B3 progress events reach renderer in stage order', J(stages) === J(wantStages), stages.join(','))
    check('B4 every progress event carries the result attemptId', ev1.length > 0 && ev1.every((e) => e.attemptId === r1.attemptId))
    const qev = ev1.filter((e) => e.waitingForQuiet !== undefined).map((e) => `${e.waitingForQuiet ? 'T' : 'F'}:${e.stage}:${e.quietAction ?? '-'}:${e.quietMaxWaitMs ?? '-'}`)
    check('B5 waitingForQuiet true→false around activate/click/fill', J(qev) === J(['T:activate_line:activate:3000', 'F:activate_line:-:-', 'T:open_chat:click:3000', 'F:open_chat:-:-', 'T:fill:fill:3000', 'F:fill:-:-']), qev.join(' '))
    const iClickT = ev1.findIndex((e) => e.waitingForQuiet === true && e.quietAction === 'click')
    const iClickF = ev1.findIndex((e, i) => i > iClickT && e.waitingForQuiet === false)
    const iVerify = ev1.findIndex((e) => e.stage === 'verify_open')
    check('B6 quiet(click) cleared before verify_open', iClickT >= 0 && iClickT < iClickF && iClickF < iVerify)

    // 沒有安靜期等待 → 不送 waitingForQuiet
    nextRun()
    cfg.quietOn = new Set()
    const r2 = await R(`window.api.driver.postDraft({ todoId: 'todo-1', text: '收到' })`)
    const ev2 = await takeEvents()
    check('B7 no quiet wait → no waitingForQuiet events', r2.ok && ev2.every((e) => e.waitingForQuiet === undefined))

    // 失敗結果：target_not_visible（沒碰 LINE 畫面以外的東西）
    nextRun()
    const r3 = await R(`window.api.driver.postDraft({ todoId: 'todo-far', text: '收到' })`)
    check('B8 failure result over IPC: target_not_visible below, body/tail/message', !r3.ok && r3.code === 'target_not_visible' && r3.visibility && r3.visibility.direction === 'below' && typeof r3.body === 'string' && r3.tail === '沒有開啟任何聊天室，LINE 也沒有被切到前景。' && r3.message === r3.body + r3.tail, r3.ok ? 'ok?' : `${r3.code} ${J(r3.visibility)}`)
    await takeEvents()

    // 失敗結果：本文已說明 LINE 狀態的碼（title_unreadable）→ message 不重複尾句，但 tail（副作用列）仍在
    nextRun()
    cfg.postTitleText = ''
    const r4 = await R(`window.api.driver.postDraft({ todoId: 'todo-1', text: '收到' })`)
    cfg.postTitleText = null
    check('B9 self-described failure: message=body, tail=side-effect row (chatOpened)', !r4.ok && r4.code === 'title_unreadable' && r4.message === r4.body && r4.tail === '已開啟一個聊天室（可能已變成已讀），但沒有填入草稿。' && r4.lineSideEffects.chatOpened === true, r4.ok ? 'ok?' : `${r4.code} tail=${r4.tail}`)
    await takeEvents()

    // 參數錯誤、舊 renderer 的 fillAndSend
    nextRun()
    const r5 = await R(`window.api.driver.postDraft({ todoId: 5, text: { evil: true } })`)
    check('B10 malformed postDraft args → invalid_request (preflight, no tail)', !r5.ok && r5.code === 'invalid_request' && r5.stage === 'preflight' && r5.tail === null)
    nextRun()
    const r6 = await R(`window.api.driver.postDraft({ todoId: 'todo-1', text: 'x', mode: 'fillAndSend' })`)
    check('B11 mode fillAndSend → send_not_available', !r6.ok && r6.code === 'send_not_available')

    // 交還焦點失敗
    nextRun()
    cfg.handBack = false
    const r7 = await R(`window.api.driver.postDraft({ todoId: 'todo-1', text: '收到' })`)
    cfg.handBack = true
    check('B12 handedBack=false → handBackNote from messages.ts, onHandBackFailed called', r7.ok && r7.handedBack === false && r7.handBackNote === m.HAND_BACK_FAILED_NOTE && handBackFailed === 1)
    await takeEvents()

    // ═════ D：後續動作（4 種結果＋其他）═════
    nextRun()
    const A = await R(`window.api.driver.postDraft({ todoId: 'todo-1', text: '後續測試' })`)
    await takeEvents()
    const name = ROWS[20].name
    cfg.focusEdit = 'ok'
    const f1 = await R(`window.api.driver.focusLine(${J(A.attemptId)})`)
    check('D1 focusLine ok → focused', f1.ok && f1.action === 'focusLine' && f1.outcome === 'focused' && f1.message === m.followUpMessage('focusLine', { outcome: 'focused' }, name), J(f1))
    cfg.focusEdit = 'title_changed'
    const f2 = await R(`window.api.driver.focusLine(${J(A.attemptId)})`)
    check('D2 [4d] focusLine title changed → title_changed, activated=true', !f2.ok && f2.action === 'focusLine' && f2.code === 'title_changed' && f2.activated === true && f2.message === m.followUpMessage('focusLine', { code: 'title_changed' }, name), J(f2))
    cfg.focusEdit = 'ok'
    cfg.clear = 'edit_mismatch'
    const c1 = await R(`window.api.driver.clearFilled(${J(A.attemptId)})`)
    check('D3 [4c] clearFilled content changed → edit_changed', !c1.ok && c1.action === 'clearFilled' && c1.code === 'edit_changed' && c1.activated === false && c1.message === m.followUpMessage('clearFilled', { code: 'edit_changed' }), J(c1))
    cfg.clear = 'title_changed'
    const c2 = await R(`window.api.driver.clearFilled(${J(A.attemptId)})`)
    check('D4 [4c] clearFilled chat switched → title_changed (same 4c message)', !c2.ok && c2.code === 'title_changed' && c2.action === 'clearFilled' && c2.message === c1.message, J(c2))
    check('D5 4c and 4d messages differ (renderer can tell them apart by action)', f2.message !== c2.message)
    cfg.clear = 'ok'
    const c3 = await R(`window.api.driver.clearFilled(${J(A.attemptId)})`)
    check('D6 [4b] clearFilled ok → cleared', c3.ok && c3.action === 'clearFilled' && c3.outcome === 'cleared' && c3.message === m.followUpMessage('clearFilled', { outcome: 'cleared' }, name), J(c3))
    const n0 = calls.length
    const c4 = await R(`window.api.driver.clearFilled(${J(A.attemptId)})`)
    check('D7 attempt consumed after clear → attempt_expired, no port call', !c4.ok && c4.code === 'attempt_expired' && calls.length === n0)

    nextRun()
    const B = await R(`window.api.driver.postDraft({ todoId: 'todo-1', text: '過期測試' })`)
    await takeEvents()
    clock += 5 * 60 * 1000 + 1000
    const n1 = calls.length
    const e1 = await R(`window.api.driver.focusLine(${J(B.attemptId)})`)
    const e2 = await R(`window.api.driver.clearFilled(${J(B.attemptId)})`)
    check('D8 [4f] after 5 min → attempt_expired for both, message = expiredNote, no port call', !e1.ok && e1.code === 'attempt_expired' && !e2.ok && e2.code === 'attempt_expired' && e1.message === m.FOLLOW_UP_EXPIRED_NOTE && e1.message === B.expiredNote && calls.length === n1, `${J(e1)} calls+${calls.length - n1}`)

    nextRun()
    const C = await R(`window.api.driver.postDraft({ todoId: 'todo-1', text: '清除舊 attempt' })`)
    nextRun()
    const D = await R(`window.api.driver.postDraft({ todoId: 'nope', text: 'x' })`)
    const g1 = await R(`window.api.driver.focusLine(${J(C.attemptId)})`)
    check('D9 next postDraft (even failing) clears previous attempt', C.ok && !D.ok && D.code === 'todo_not_found' && !g1.ok && g1.code === 'attempt_expired')
    const g2 = await R(`window.api.driver.focusLine('d-unknown')`)
    const g3 = await R(`window.api.driver.focusLine(123)`)
    check('D10 unknown attemptId → attempt_expired; non-string → invalid_request', !g2.ok && g2.code === 'attempt_expired' && !g3.ok && g3.code === 'invalid_request')

    nextRun()
    const E = await R(`window.api.driver.postDraft({ todoId: 'todo-1', text: 'busy 測試' })`)
    await takeEvents()
    nextRun()
    cfg.readListDelayMs = 600
    const pending = R(`window.__p = window.api.driver.postDraft({ todoId: 'todo-1', text: 'running' }); true`)
    await pending
    await new Promise((r) => setTimeout(r, 200))
    const stBusy = await R(`window.api.driver.status({ todoId: 'todo-1' })`)
    const b1 = await R(`window.api.driver.focusLine(${J(E.attemptId)})`)
    const doneRun = await R(`window.__p`)
    cfg.readListDelayMs = 0
    check('D11 during postDraft: status.busy=true, followUp → busy', stBusy.busy === true && !b1.ok && b1.code === 'busy' && doneRun.ok === true, `busy=${stBusy.busy} f=${b1.ok ? 'ok' : b1.code}`)
    await takeEvents()

    nextRun()
    const F = await R(`window.api.driver.postDraft({ todoId: 'todo-1', text: 'not running 測試' })`)
    await takeEvents()
    cfg.focusEdit = 'throw_not_running'
    const h1 = await R(`window.api.driver.focusLine(${J(F.attemptId)})`)
    cfg.focusEdit = 'ok'
    check('D12 helper reports line_not_running → line_not_running', !h1.ok && h1.code === 'line_not_running' && h1.message === m.followUpMessage('focusLine', { code: 'line_not_running' }), J(h1))

    // review F1：focusLine 的 helper 守門（user_busy）經 IPC 到 renderer
    nextRun()
    const K = await R(`window.api.driver.postDraft({ todoId: 'todo-1', text: 'F1 測試' })`)
    await takeEvents()
    focusQuiet.length = 0
    cfg.focusEdit = 'user_busy'
    const k1 = await R(`window.api.driver.focusLine(${J(K.attemptId)})`)
    cfg.focusEdit = 'user_busy_late'
    const k2 = await R(`window.api.driver.focusLine(${J(K.attemptId)})`)
    cfg.focusEdit = 'ok'
    const k3 = await R(`window.api.driver.focusLine(${J(K.attemptId)})`)
    check('FR-D13 [F1] focusLine, helper user_busy (keys held / not quiet) → code user_busy, activated=false, messages.ts text', K.ok && !k1.ok && k1.action === 'focusLine' && k1.code === 'user_busy' && k1.activated === false && k1.message === m.followUpMessage('focusLine', { code: 'user_busy' }, ROWS[20].name) && k1.message === m.FOCUS_USER_BUSY_NOTE, J(k1))
    check('FR-D14 [F1] helper user_busy detail=late → activated=true', !k2.ok && k2.code === 'user_busy' && k2.activated === true, J(k2))
    check('FR-D15 [F1] focusEdit always gets Q_focus {minIdleMs:500,maxWaitMs:3000,requireNoKeysDown:true}; retry after release → focused', focusQuiet.length === 3 && focusQuiet.every((q) => J(q) === J({ minIdleMs: 500, maxWaitMs: 3000, requireNoKeysDown: true })) && k3.ok && k3.outcome === 'focused', J(focusQuiet))

    // ═════ C：設定關閉 ═════
    nextRun()
    const G = await R(`window.api.driver.postDraft({ todoId: 'todo-1', text: '設定測試' })`)
    await takeEvents()
    settings.enabled = false
    const n2 = calls.length
    nextRun()
    const s1 = await R(`window.api.driver.status({ todoId: 'todo-noname' })`)
    const s2 = await R(`window.api.driver.postDraft({ todoId: 'todo-1', text: '關閉時' })`)
    const s3 = await R(`window.api.driver.focusLine(${J(G.attemptId)})`)
    const s4 = await R(`window.api.driver.clearFilled(${J(G.attemptId)})`)
    const evOff = await takeEvents()
    check('C1 disabled: status.enabled=false, targetProblem not evaluated', s1.enabled === false && s1.targetProblem === null)
    check('C2 disabled: postDraft → disabled (preflight, message from messages.ts)', !s2.ok && s2.code === 'disabled' && s2.stage === 'preflight' && s2.message === m.messageFor('disabled', { stage: 'preflight' }))
    check('C3 disabled: focusLine/clearFilled → disabled', !s3.ok && s3.code === 'disabled' && !s4.ok && s4.code === 'disabled')
    check('C4 disabled: no LINE port call, no progress event', calls.length === n2 && evOff.length === 0, `calls+${calls.length - n2} ev=${evOff.length}`)
    settings.enabled = true
    const s5 = await R(`window.api.driver.focusLine(${J(G.attemptId)})`)
    check('C5 re-enabled: same attempt still valid (disabled only rejected)', s5.ok && s5.outcome === 'focused')

    // ═════ E：來源與推送範圍 ═════
    let rejected = ''
    try { await RO(`window.api.driver.status({ todoId: 'todo-1' })`) } catch (e) { rejected = String(e && e.message ? e.message : e) }
    let rejected2 = ''
    try { await RO(`window.api.driver.postDraft({ todoId: 'todo-1', text: 'x' })`) } catch (e) { rejected2 = String(e && e.message ? e.message : e) }
    check('E1 non-main webContents is rejected (status, postDraft)', /untrusted sender/.test(rejected) && /untrusted sender/.test(rejected2), rejected.slice(0, 80))
    const otherEv = await RO(`window.__ev.length`)
    check('E2 progress is pushed only to the main window', otherEv === 0, `other window events=${otherEv}`)

    // ═════ P：psHost 傳輸層解析 waitingForQuiet 事件（假 helper，不是 PowerShell，不碰 LINE）═════
    {
      const cp = require('node:child_process')
      const origSpawn = cp.spawn
      const fakeFile = path.join(root, '__probe_ipc_fake_helper.cjs')
      fs.writeFileSync(fakeFile, FAKE_HELPER, 'utf8')
      const spawned = []
      cp.spawn = (cmd, args, opts) => { spawned.push(path.basename(String(cmd))); return origSpawn(process.execPath, [fakeFile], { ...opts, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }) }
      try {
        const host = m.createPsHost({ scriptPath: 'unused.ps1', powershellPath: 'powershell-not-used.exe' })
        const heard = []
        host.onQuietWait((e) => heard.push(e))
        await host.hello()
        const g = await host.guardedClick({ row: { index: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, hash: 'h' }, windowRows: [], quiet: { minIdleMs: 500, maxWaitMs: 3000 }, dryRun: true })
        const s = await host.readSearch()
        host.onQuietWait(null)
        const g2 = await host.guardedClick({ row: { index: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, hash: 'h' }, windowRows: [], quiet: { minIdleMs: 500, maxWaitMs: 2500 }, dryRun: true })
        await host.dispose()
        check('P1 psHost forwards helper waitingForQuiet event for guardedClick (command, maxWaitMs) before the response', J(heard) === J([{ command: 'guardedClick', maxWaitMs: 3000 }]) && g.ok && g.value.clicked === false, J(heard))
        check('P2 event on a non-guarded command (readSearch) is ignored; response still resolves', s === '' && heard.length === 1)
        check('P3 listener removed (null) → no callback; response still resolves', g2.ok && heard.length === 1)
        check('P4 telemetry quietWaitMs recorded from response', host.telemetry().quietWaitMs.guardedClick === 700)
        check('P5 fake helper only (spawn intercepted; no PowerShell started)', spawned.length === 1 && spawned[0] === 'powershell-not-used.exe', spawned.join(','))

        // ── review F1：focusEdit 的 helper 守門（協定層；假 helper 照 ps1 的順序）──
        const traceFile = path.join(root, '__probe_ipc_fake_trace.txt')
        const stateFile = path.join(root, '__probe_ipc_fake_state.json')
        extraFiles.push(traceFile, stateFile)
        process.env.PROBE_TRACE = traceFile
        process.env.PROBE_STATE = stateFile
        const setState = (s) => fs.writeFileSync(stateFile, J(s), 'utf8')
        const readTrace = () => { try { return fs.readFileSync(traceFile, 'utf8').split('\n').filter(Boolean) } catch (_) { return [] } }
        const resetTrace = () => fs.writeFileSync(traceFile, '', 'utf8')
        setState({ keysDown: false, idleMs: 10000 })
        resetTrace()
        const host2 = m.createPsHost({ scriptPath: 'unused.ps1', powershellPath: 'powershell-not-used.exe' })
        const QF = { minIdleMs: 500, maxWaitMs: 300, requireNoKeysDown: true }
        try {
          await host2.hello()
          // P6 按鍵一直按著（例如按住 Enter）
          setState({ keysDown: true, idleMs: 10000 })
          resetTrace()
          const p6 = await host2.focusEdit('h', QF)
          const t6 = readTrace()
          check('FR-P6 [F1] key held for the whole wait → user_busy, LINE NOT raised, no caret', !p6.ok && p6.refusal === 'user_busy' && p6.detail === '' && !t6.includes('raise') && !t6.includes('setFocus'), `${J(p6)} trace=${t6.join('|')}`)
          // P7 沒有按鍵，但距離上次輸入未滿安靜期（例如剛放開 Enter 就又連按）
          setState({ keysDown: false, idleMs: 200 })
          resetTrace()
          const p7 = await host2.focusEdit('h', QF)
          const t7 = readTrace()
          check('FR-P7 [F1] idle < 500 ms (quiet period not met) → user_busy, LINE NOT raised', !p7.ok && p7.refusal === 'user_busy' && !t7.includes('raise'), `${J(p7)} trace=${t7.join('|')}`)
          // P8 按著 Enter，250 ms 後放開並安靜 → 放開之後才切前景
          setState({ keysDown: true, idleMs: 10000 })
          resetTrace()
          const t0 = Date.now()
          const rel = setTimeout(() => setState({ keysDown: false, idleMs: 600 }), 250)
          const p8 = await host2.focusEdit('h', { minIdleMs: 500, maxWaitMs: 2000, requireNoKeysDown: true })
          clearTimeout(rel)
          const t8 = readTrace()
          check('FR-P8 [F1] key released + quiet → raised only after release, then caret (order: raise → setFocus)', p8.ok && p8.value.focused === true && Date.now() - t0 >= 240 && t8.indexOf('raise') >= 0 && t8.indexOf('raise') < t8.indexOf('setFocus'), `${J(p8)} trace=${t8.join('|')}`)
          // P9 切前景之後、放游標之前又有輸入 → late，不放游標
          setState({ keysDown: false, idleMs: 10000, lateInput: true })
          resetTrace()
          const p9 = await host2.focusEdit('h', QF)
          const t9 = readTrace()
          check('FR-P9 [F1] input after raise, before caret → user_busy detail=late, caret NOT placed', !p9.ok && p9.refusal === 'user_busy' && p9.detail === 'late' && !t9.includes('setFocus'), `${J(p9)} trace=${t9.join('|')}`)
          // P10 psHost 原樣帶 quiet；逾時用 guarded（安靜期最多 3 s，超過 default 3 s 也不會被當成逾時）
          setState({ keysDown: true, idleMs: 10000 })
          resetTrace()
          const p10 = await host2.focusEdit('h', m.QUIET.focus)
          const t10 = readTrace()
          check('FR-P10 [F1] psHost sends Q_focus verbatim and waits the full quiet window (guarded timeout > 3 s) → user_busy, not port timeout', !p10.ok && p10.refusal === 'user_busy' && t10[0] === 'args ' + J(m.QUIET.focus) && !t10.includes('raise') && m.HOST_TIMEOUTS_MS.guarded > m.QUIET.focus.maxWaitMs, `${J(p10)} trace=${t10.join('|')}`)
        } finally {
          await host2.dispose()
        }
      } finally {
        cp.spawn = origSpawn
        try { fs.rmSync(fakeFile, { force: true }) } catch (_) {}
      }
    }

    // ═════ H：line-uia-host.ps1 靜態結構（只讀文字、不執行 PowerShell）═════
    {
      const src = fs.readFileSync(path.join(root, 'resources', 'line-driver', 'line-uia-host.ps1'), 'utf8')
      const lines = src.split(/\r?\n/)
      const code = (l) => l.replace(/#.*$/, '') // 去掉 PS 註解（本檔字串常值不含 #）
      // 函式 Raise-LineGuarded 的範圍：從宣告行到下一個頂層的 '}'。
      const fStart = lines.findIndex((l) => /^function Raise-LineGuarded\b/.test(l))
      let fEnd = -1
      for (let i = fStart + 1; fStart >= 0 && i < lines.length; i++) { if (/^\}/.test(lines[i])) { fEnd = i; break } }
      const inRaise = (i) => i > fStart && i < fEnd
      // 所有把 LINE 帶到前景的呼叫：SetForegroundWindow($l.hwnd)、ShowWindow($l.hwnd, …)（C# DllImport 宣告不算）。
      const raiseCalls = []
      const fgAll = []
      lines.forEach((l, i) => {
        const c = code(l)
        if (/\[LineHostNative\]::(SetForegroundWindow|ShowWindow)\(/.test(c)) fgAll.push({ i, t: c.trim() })
        if (/\[LineHostNative\]::(SetForegroundWindow|ShowWindow)\(\$l\.hwnd/.test(c)) raiseCalls.push(i)
      })
      check('FR-H1 [F1] every call that brings LINE forward is inside Raise-LineGuarded', fStart >= 0 && fEnd > fStart && raiseCalls.length === 2 && raiseCalls.every(inRaise), `fn=${fStart + 1}..${fEnd + 1} calls=${raiseCalls.map((i) => i + 1).join(',')}`)
      const others = fgAll.filter((x) => !inRaise(x.i))
      check('FR-H2 [F1] the only other SetForegroundWindow targets line-todo ($target, handBackFocus), not LINE', others.length === 1 && /SetForegroundWindow\(\$target\)/.test(others[0].t), others.map((x) => `${x.i + 1}:${x.t}`).join(' ; '))
      const gateIdx = lines.findIndex((l, i) => inRaise(i) && /QuietGate\([^)]*\$true[^)]*\)\)\s*\{\s*return @\{ ok = \$false/.test(code(l)))
      check('FR-H3 [F1] inside Raise-LineGuarded: QuietGate(requireNoKeys=$true) with early return precedes every raise call', gateIdx >= 0 && raiseCalls.every((i) => i > gateIdx), `gate=${gateIdx + 1}`)
      const branch = (name) => { const s = lines.findIndex((l) => new RegExp(`^\\s+'${name}' \\{`).test(l)); let e = s; for (let i = s + 1; i < lines.length; i++) { if (/^\s+'[A-Za-z]+' \{/.test(lines[i]) || /^\s+default \{/.test(lines[i])) { e = i; break } } return { s, e, body: lines.slice(s, e).map(code).join('\n') } }
      const act = branch('activateLine')
      const foc = branch('focusEdit')
      const viaRaise = (b) => b.s >= 0 && /Raise-LineGuarded/.test(b.body) && /if \(-not \$g\.ok\) \{ Refuse \$id 'user_busy'/.test(b.body) && !/SetForegroundWindow|ShowWindow/.test(b.body)
      check('FR-H4 [F1] activateLine and focusEdit raise LINE only via Raise-LineGuarded and refuse user_busy when the gate fails', viaRaise(act) && viaRaise(foc), `activateLine=${viaRaise(act)} focusEdit=${viaRaise(foc)}`)
      check('FR-H5 [F1] focusEdit re-checks StillQuiet(requireNoKeys) right before SetFocus (late → user_busy)', /StillQuiet\(\$g\.min, \$true\)\) \{ Refuse \$id 'user_busy' 'late'[\s\S]*\.SetFocus\(\)/.test(foc.body), '')
    }

    // ═════ 稽核 log ═════
    check('F1 audit/follow-up log lines have no CJK (no names/drafts)', logs.length > 0 && logs.every((l) => !/[一-鿿]/.test(l)), `${logs.length} lines`)
    const tmpAfter = lineTmpDirs()
    check('F2 no LINE DB copy / key scan dirs created in %TEMP% (fake order port only)', tmpBefore >= 0 && tmpAfter === tmpBefore, `linedb-*/linekey-scan-* ${tmpBefore}→${tmpAfter}`)

    const failed = results.filter((r) => !r.ok)
    console.log(`[probe-ipc] port calls total=${calls.length} (fake ports only; no helper spawned, no LINE DB read)`)
    console.log(`[probe-ipc] ${results.length - failed.length}/${results.length} passed`)
    return failed.length === 0 ? 0 : 1
  } catch (err) {
    console.error('[probe-ipc] ERROR', err && err.stack ? err.stack : err)
    return 1
  } finally {
    try { dispose && dispose() } catch (_) {}
    for (const w of [win, other]) { try { w && !w.isDestroyed() && w.destroy() } catch (_) {} }
    cleanup()
  }
}

app.whenReady().then(() => main()).then((c) => app.exit(c))
