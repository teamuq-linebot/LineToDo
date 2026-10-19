// probe-driver-ui —— driver_post Batch 6 驗收輔助：把 production 的 DraftReplyDialog.tsx、DriverPostSettings.tsx
// 掛在隱藏的 BrowserWindow（假 api，沒有 preload、沒有 IPC），逐一重現已核可原型的狀態，檢查 DOM，並截下
// **line-todo 自己的畫面**（webContents.capturePage，不是螢幕擷取，不含 LINE）供對照原型。
//
// 失敗／成功／後續結果的文字全部用 production 的 src/main/driver/messages.ts 產生（node 端打包），
// 驗證對話框顯示的是 messages.ts 的文字，而不是元件自己寫的。
// Enter 行為用 webContents.sendInputEvent（受信任的按鍵事件）驗證：成功後按 Enter＝「切到 LINE」、不會觸發焦點所在的其他按鈕。
//
// review F1／F2／F3（UI-F 開頭）：
//   F1 按住 Enter（sendInputEvent 的 isAutoRepeat，並確認 DOM 真的收到 repeat=true）只在放開時觸發一次；只有自動重複、
//      沒有在成功畫面按下的 Enter 不觸發；連按兩下只觸發一次（進行中、以及 1 秒內）；focusLine user_busy 的文案。
//   F2 handedBack=false 時畫面不同時出現「按 Enter 會直接送出」與「在這裡按 Enter……不會送出」。
//   F3 點擊結果不確定（chatOpenUncertain）時顯示「可能已開啟」，不出現「沒有開啟任何聊天室」。
//
// 不碰 LINE、不 spawn helper、不讀 LINE DB。
// 執行：npx electron scripts/probe-driver-ui.cjs [--shots <dir>]（exit 0 = 全數 PASS）

const path = require('node:path')
const fs = require('node:fs')
const esbuild = require('esbuild')
const { app, BrowserWindow } = require('electron')

const X = '王小明' // 原型的假名
const argShots = (() => { const i = process.argv.indexOf('--shots'); return i > 0 ? process.argv[i + 1] : null })()

const PAGE_ENTRY = `
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DraftReplyDialog } from './src/renderer/components/DraftReplyDialog'
import { DriverPostSettings } from './src/renderer/components/Settings/DriverPostSettings'
import { LineTodoApiProvider } from './src/renderer/platform/LineTodoApi'

const w: any = window
w.__calls = []
let progressCb: any = null
const S = () => w.__scenario
const api: any = {
  db: { todos: { draftReply: async () => ({ draft: S().draft }) } },
  settings: { get: async () => ({ driverPost: { enabled: S().status ? S().status.enabled : true, mode: 'fillOnly', verifyReadByDb: S().verifyRead } }) },
  driver: {
    status: async () => { w.__calls.push('status'); if (S().status === 'reject') throw new Error('No handler registered'); return S().status },
    postDraft: (_req: any) => { w.__calls.push('postDraft'); if (S().post === 'pending') return new Promise((r) => { w.__resolvePost = r }); return Promise.resolve(S().post) },
    focusLine: (_id: any) => { w.__calls.push('focusLine'); if (S().focus === 'pending') return new Promise((r) => { w.__resolveFocus = r }); return Promise.resolve(S().focus) },
    clearFilled: async () => { w.__calls.push('clearFilled'); return S().clear },
    onProgress: (cb: any) => { progressCb = cb; return () => { progressCb = null } }
  }
}
w.__emit = (p: any) => progressCb && progressCb(p)
const todo: any = { id: 'todo-1', chatId: 'c-1', title: '確認週五交貨時間', bucket: 'todo', status: 'open' }

function Settings() {
  const [view, setView] = useState<any>({ driverPost: S().settingsDp })
  return (
    <div className="settings-wrap" style={{ padding: 24 }}>
      <div className="settings-head"><h2>設定</h2></div>
      <DriverPostSettings view={view} onPatch={(p) => { w.__calls.push('patch:' + JSON.stringify(p)); setView({ driverPost: { ...view.driverPost, ...p } }) }} />
    </div>
  )
}

const root = createRoot(document.getElementById('root')!)
let n = 0
w.__mount = (kind: string) => {
  n++
  w.__calls = []
  w.__closed = 0
  root.render(
    <LineTodoApiProvider api={api}>
      {kind === 'settings' ? <Settings key={n} /> : (
        <div key={n}>
          <button id="opener">草擬回覆</button>
          <DraftReplyDialog todo={todo} chatName={S().chatName === undefined ? '${X}' : S().chatName} onClose={() => { w.__closed++ }} />
        </div>
      )}
    </LineTodoApiProvider>
  )
}
`

async function main() {
  const root = path.join(__dirname, '..')
  const pageEntry = path.join(root, '__probe_ui_page.tsx')
  const pageOut = path.join(root, '__probe_ui_page.js')
  const htmlFile = path.join(root, '__probe_ui_page.html')
  const nodeEntry = path.join(root, '__probe_ui_node.ts')
  const nodeOut = path.join(root, '__probe_ui_node.cjs')
  const cleanup = () => { for (const f of [pageEntry, pageOut, htmlFile, nodeEntry, nodeOut]) { try { fs.rmSync(f, { force: true }) } catch (_) {} } }
  const results = []
  const check = (name, ok, info = '') => { results.push({ name, ok: !!ok }); console.log(`[probe-ui] ${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`) }
  const shotsDir = argShots
  if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true })
  let win = null
  try {
    fs.writeFileSync(pageEntry, PAGE_ENTRY, 'utf8')
    await esbuild.build({ entryPoints: [pageEntry], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: pageOut, absWorkingDir: root, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' } })
    fs.writeFileSync(nodeEntry, `export { messageParts, detailsText, followUpMessage, HAND_BACK_FAILED_NOTE, FOLLOW_UP_EXPIRED_NOTE, FOCUS_USER_BUSY_NOTE, CHAT_OPEN_UNCERTAIN_TAIL, messageFor } from './src/main/driver/messages.ts'\n`, 'utf8')
    await esbuild.build({ entryPoints: [nodeEntry], bundle: true, platform: 'node', format: 'cjs', outfile: nodeOut, absWorkingDir: root, logLevel: 'silent' })
    const m = require(nodeOut)
    const css = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles', 'index.css'), 'utf8')
    fs.writeFileSync(htmlFile, `<!DOCTYPE html><html lang="zh-Hant-TW" data-theme="dark"><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script src="./__probe_ui_page.js"></script></body></html>`, 'utf8')

    win = new BrowserWindow({ show: false, width: 900, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(htmlFile)
    const R = (js) => win.webContents.executeJavaScript(js)
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const J = (o) => JSON.stringify(o)
    let shotN = 0
    const shot = async (name) => {
      if (!shotsDir) return
      shotN++
      // 隱藏視窗的繪製可能落後 DOM：強制重繪並等兩個 frame 再擷取。
      win.webContents.invalidate()
      await R(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`)
      await sleep(150)
      const img = await win.webContents.capturePage()
      fs.writeFileSync(path.join(shotsDir, `${String(shotN).padStart(2, '0')}-${name}.png`), img.toPNG())
    }
    const key = async (keyCode) => {
      win.webContents.focus()
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
      if (keyCode === 'Return' || keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
      await sleep(120)
    }
    // 分開送 keyDown／keyUp；repeat=true 時帶 isAutoRepeat（OS 按住不放時的自動重複）。
    const keyDown = (keyCode, repeat = false) => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, ...(repeat ? { modifiers: ['isAutoRepeat'] } : {}) })
      if (keyCode === 'Return') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', ...(repeat ? { modifiers: ['isAutoRepeat'] } : {}) })
    }
    const keyUp = (keyCode) => win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    // 記錄 DOM 實際收到的 Enter keydown（確認 isAutoRepeat 真的變成 KeyboardEvent.repeat，測試不是空轉）。
    const watchKeys = () => R(`window.__keys = []; document.addEventListener('keydown', (e) => { if (e.key === 'Enter') window.__keys.push(e.repeat) }, true); true`)
    const text = (sel) => R(`(() => { const e = document.querySelector(${J(sel)}); return e ? e.textContent : null })()`)
    const btn = (label) => R(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${J(label)}); return b ? { disabled: b.disabled, primary: !b.classList.contains('ghost'), exists: true } : { exists: false } })()`)
    const clickBtn = (label) => R(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${J(label)}); if (b) b.click(); return !!b })()`)
    const calls = () => R(`window.__calls.slice()`)

    // 共用資料
    const DRAFT = '王先生您好，週五的交貨時間我們這邊確認可以在下午兩點前送達。如果時間需要調整，再麻煩跟我說，謝謝！'
    const ST = (o = {}) => ({ enabled: true, mode: 'fillOnly', sendAvailable: false, busy: false, lastHostProblem: null, targetProblem: null, ...o })
    const fx = (o = {}) => ({ activated: !!o.activated, searchChanged: false, searchRestored: false, chatOpened: !!o.opened, ...(o.uncertain ? { chatOpenUncertain: true } : {}) })
    const fail = (code, stage, o = {}) => {
      const ctx = { chatName: X, otherChatName: o.other, visibility: o.visibility, stage, draftLeftInLine: o.left ?? 'none', lineSideEffects: fx(o) }
      const p = m.messageParts(code, ctx)
      return { ok: false, attemptId: 'a1', code, message: p.tail && p.inMessage ? p.body + p.tail : p.body, body: p.body, tail: p.tail, stage, draftLeftInLine: ctx.draftLeftInLine, lineSideEffects: ctx.lineSideEffects, ...(o.visibility ? { visibility: o.visibility } : {}) }
    }
    const locate = { rank: 26, pinned: false, offset: 22, anchors: 6, path: 'T', row: 4 }
    const open = { selectionMatched: true, titleSim: 1, titleGap: 3, titlePass: 3, dbAck: 'no_change', seenTitle: X }
    const okResult = (o = {}) => ({ ok: true, outcome: 'filled', attemptId: 'a1', chatName: X, locate, open, handedBack: o.handedBack ?? true, elapsedMs: 15000, details: m.detailsText(locate, open), handBackNote: o.handedBack === false ? m.HAND_BACK_FAILED_NOTE : null, followUpTtlMs: o.ttl ?? 300000, expiredNote: m.FOLLOW_UP_EXPIRED_NOTE })
    const fu = (action, r) => (r.outcome ? { ok: true, action, outcome: r.outcome, message: m.followUpMessage(action, r, X) } : { ok: false, action, code: r.code, message: m.followUpMessage(action, r, X), activated: !!r.activated })
    const scenario = async (sc, kind = 'dialog') => {
      await R(`window.__scenario = ${J({ draft: DRAFT, verifyRead: true, status: ST(), post: okResult(), focus: fu('focusLine', { outcome: 'focused' }), clear: fu('clearFilled', { outcome: 'cleared' }), ...sc })}; window.__mount(${J(kind)}); true`)
      await sleep(250)
    }
    const runTo = async (post) => { await R(`window.__scenario.post = ${J(post)}; true`); await clickBtn('填入 LINE'); await sleep(200) }

    // ── 1 初始（可填入）──
    await scenario({})
    const b1 = await btn('填入 LINE')
    const c1 = await btn('複製')
    const intro = await text('.dp-area .set-notice')
    const focus1 = await R(`document.activeElement && document.activeElement.tagName`)
    check('UI-1 init: 「填入 LINE」 primary+enabled, 「複製」 secondary, intro notice, textarea focused', b1.exists && !b1.disabled && b1.primary && c1.exists && !c1.primary && /不會送出/.test(intro || '') && /看得到/.test(intro || '') && focus1 === 'TEXTAREA', `${J(b1)} ${J(c1)} focus=${focus1}`)
    await shot('init')

    // ── 1b 功能已關閉 ──
    await scenario({ status: ST({ enabled: false }) })
    const b1b = await btn('填入 LINE')
    const c1b = await btn('複製')
    check('UI-1b disabled: no 「填入 LINE」, 「複製」 primary, MVP note, settings hint', !b1b.exists && c1b.primary && /只草擬/.test((await text('.draft-note')) || '') && /設定 › 填入 LINE/.test((await text('.dp-area')) || ''))
    await shot('init-off')

    // ── 主機沒有 driver（例如驗收模式）→ 只能複製 ──
    await scenario({ status: 'reject' })
    const bR = await btn('填入 LINE')
    check('UI-1b\' host without driver IPC → copy-only (no fill button, no settings hint)', !bR.exists && (await text('.dp-area')) === null)

    // ── 1c 聊天室沒有名稱 ──
    const tp = { code: 'chat_name_missing', message: m.messageFor('chat_name_missing', { stage: 'preflight' }) }
    await scenario({ status: ST({ targetProblem: tp }), chatName: null })
    const b1c = await btn('填入 LINE')
    const reason = await text('.dp-reason')
    const desc = await R(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '填入 LINE'); const id = b && b.getAttribute('aria-describedby'); return id ? document.getElementById(id).textContent : null })()`)
    check('UI-1c no name: 「填入 LINE」 disabled, reason under button = messages.ts text, aria-describedby', b1c.exists && b1c.disabled && reason === tp.message && desc === tp.message, reason)
    await shot('init-noname')

    // ── 1d 環境問題 ──
    const hp = { code: 'ocr_unavailable', message: m.messageFor('ocr_unavailable', { stage: 'host_start' }) }
    await scenario({ status: ST({ lastHostProblem: hp }) })
    const b1d = await btn('填入 LINE')
    check('UI-1d host problem: warn notice with messages.ts text, 「填入 LINE」 disabled', b1d.disabled && ((await text('.set-notice.warn')) || '').includes(hp.message.replace(/\s+/g, ' ').slice(0, 20)))
    await shot('init-host')

    // ── 2 填入中（分段進度）──
    await scenario({ post: 'pending' })
    await clickBtn('填入 LINE')
    await sleep(100)
    for (const stage of ['host_start', 'locate_line', 'read_order', 'read_list', 'locate_row', 'activate_line', 'open_chat', 'verify_open']) await R(`window.__emit({ attemptId: 'a1', stage: ${J(stage)} }); true`)
    await sleep(150)
    const run = await R(`(() => ({
      count: document.querySelector('.dp-steps-head .muted').textContent,
      cur: document.querySelector('.dp-steps li.cur').textContent,
      done: document.querySelectorAll('.dp-steps li.done').length,
      ro: document.querySelector('textarea').readOnly,
      allDisabled: [...document.querySelectorAll('.modal button')].every((b) => b.disabled),
      busy: document.querySelector('.modal').getAttribute('aria-busy'),
      sep: !!document.querySelector('.dp-steps li.dp-sep'),
      focus: document.activeElement && document.activeElement.textContent
    }))()`)
    check('UI-2 running: step 5/7 「確認開啟的是…（含已讀檢查）」, textarea readonly, all buttons & ✕ disabled, aria-busy, separator', run.count === '第 5 / 7 段' && /確認開啟的是「王小明」（含已讀檢查）/.test(run.cur) && run.done === 4 && run.ro === true && run.allDisabled && run.busy === 'true' && run.sep, J(run))
    check('UI-2 focus moved to progress title', run.focus === '填入 LINE 進行中')
    await key('Escape')
    const closedDuring = await R(`window.__closed`)
    await R(`document.querySelector('.modal-backdrop').click(); true`)
    const closedDuring2 = await R(`window.__closed`)
    check('UI-2 Esc / backdrop click do not close while running', closedDuring === 0 && closedDuring2 === 0)
    await shot('running-step5')

    // ── 3 等候安靜期 ──
    await R(`window.__emit({ attemptId: 'a1', stage: 'open_chat' }); window.__emit({ attemptId: 'a1', stage: 'open_chat', waitingForQuiet: true, quietAction: 'click', quietMaxWaitMs: 3000 }); true`)
    await sleep(400)
    const q = await R(`(() => { const n = document.querySelector('.dp-area .set-notice.warn'); return n ? { t: n.textContent, bar: !!n.querySelector('.dp-bar'), cur: document.querySelector('.dp-steps li.cur').textContent } : null })()`)
    check('UI-3 quiet wait: 「請暫時放開滑鼠與鍵盤…」, click text, countdown bar, step 4', q && /請暫時放開滑鼠與鍵盤/.test(q.t) && /正要在 LINE 點擊「王小明」這一列/.test(q.t) && /最多再等/.test(q.t) && q.bar && /切到 LINE，開啟/.test(q.cur), q ? q.t.slice(0, 60) : 'none')
    await shot('quiet-click')
    await R(`window.__emit({ attemptId: 'a1', stage: 'open_chat', waitingForQuiet: false }); true`)
    await sleep(150)
    const qGone = await R(`!document.querySelector('.dp-area .set-notice.warn')`)
    check('UI-3 quiet box disappears on waitingForQuiet:false', qGone)
    await R(`window.__emit({ attemptId: 'a1', stage: 'fill', waitingForQuiet: true, quietAction: 'fill', quietMaxWaitMs: 3000 }); true`)
    await sleep(150)
    const qf = await text('.dp-area .set-notice.warn')
    check('UI-3 quiet wait (fill) uses fill wording', /正要把草稿填入「王小明」的輸入框/.test(qf || '') && /不會填入/.test(qf || ''))
    await R(`window.__resolvePost(${J(okResult())}); true`)
    await sleep(250)

    // ── 4 填入成功 ──
    const s4 = await R(`(() => ({
      h: document.querySelector('.dp-result.ok h3').textContent,
      focus: document.activeElement && document.activeElement.tagName,
      details: document.querySelector('.dp-result details p').textContent,
      hint: document.querySelector('.dp-result .dp-sub').textContent
    }))()`)
    check('UI-4 success: 「✓ 已填入：王小明」, heading focused, details = messages.detailsText', /已填入：王小明/.test(s4.h) && s4.focus === 'H3' && s4.details === m.detailsText(locate, open), J(s4))
    check('UI-4 buttons: 切到 LINE / 從 LINE 清除這段草稿 / 關閉; 「複製」 still enabled', (await btn('切到 LINE')).exists && (await btn('從 LINE 清除這段草稿')).exists && (await btn('關閉')).exists && !(await btn('複製')).disabled)
    check('UI-4 hint states Enter = 切到 LINE (ui-decisions #2)', /按 Enter 等同按「切到 LINE」/.test(s4.hint), s4.hint)
    await shot('success')
    // Enter（受信任按鍵）在標題上 → 切到 LINE
    await key('Return')
    let cs = await calls()
    check('UI-4 Enter on heading → focusLine (not send, not other buttons)', cs.filter((c) => c === 'focusLine').length === 1 && !cs.includes('clearFilled'), cs.join(','))
    // Enter 在「從 LINE 清除這段草稿」上 → 仍然是切到 LINE，不會清除
    // （review F1 之後，一次觸發後 1 秒內的 Enter 不再觸發——這裡是隔一段時間的另一次按壓，所以先等過防連發時間。）
    await sleep(1100)
    await R(`[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '從 LINE 清除這段草稿').focus(); true`)
    await key('Return')
    cs = await calls()
    check('UI-4 Enter while focus is on 「清除」 → focusLine, clearFilled NOT called', cs.filter((c) => c === 'focusLine').length === 2 && !cs.includes('clearFilled'), cs.join(','))
    // Enter 在 textarea → 換行，不觸發
    await R(`document.querySelector('textarea').focus(); true`)
    await key('Return')
    cs = await calls()
    check('UI-4 Enter in textarea → newline only, no focusLine', cs.filter((c) => c === 'focusLine').length === 2)
    // 「切到 LINE」成功的訊息
    const okMsg = await text('.dp-inline-msg.ok')
    check('UI-4 focusLine ok message from messages.ts', okMsg === m.followUpMessage('focusLine', { outcome: 'focused' }, X), okMsg)

    // ── review F1：按住／連按 Enter ──
    const focusCount = async () => (await calls()).filter((c) => c === 'focusLine').length
    const heading = () => R(`document.querySelector('.dp-result h3').focus(); true`)
    // F1a 按住 Enter：1 次按下＋6 次自動重複，focusLine 還沒回來（進行中）
    await scenario({ focus: 'pending' })
    await runTo(okResult())
    await watchKeys()
    await heading()
    win.webContents.focus()
    keyDown('Return')
    for (let i = 0; i < 6; i++) { await sleep(35); keyDown('Return', true) }
    await sleep(150)
    const heldKeys = await R(`window.__keys.slice()`)
    const duringHold = await focusCount()
    keyUp('Return')
    await sleep(150)
    const afterRelease = await focusCount()
    check('UI-F1a DOM really received auto-repeat Enter (KeyboardEvent.repeat=true ×6)', heldKeys.length === 7 && heldKeys[0] === false && heldKeys.slice(1).every((x) => x === true), J(heldKeys))
    check('UI-F1a holding Enter: nothing fires while held (repeats ignored); exactly 1 focusLine on release', duringHold === 0 && afterRelease === 1, `held=${duringHold} released=${afterRelease}`)
    // 放開之後再來幾次自動重複（例如按鍵狀態錯亂）＋放開：進行中，不再觸發
    for (let i = 0; i < 3; i++) keyDown('Return', true)
    keyUp('Return')
    await sleep(150)
    check('UI-F1a stray auto-repeat Enter + keyUp without a fresh press → no extra focusLine', (await focusCount()) === 1, String(await focusCount()))
    await R(`window.__resolveFocus(${J(fu('focusLine', { outcome: 'focused' }))}); true`)
    await sleep(100)

    // F1b 只有自動重複（這次按壓不是在成功畫面上按下的，例如按著 Enter 時畫面變成成功）→ 放開也不觸發
    await scenario({})
    await runTo(okResult())
    await heading()
    win.webContents.focus()
    for (let i = 0; i < 5; i++) { keyDown('Return', true); await sleep(30) }
    keyUp('Return')
    await sleep(200)
    check('UI-F1b auto-repeat-only Enter (press began before the success screen) → no focusLine at all', (await focusCount()) === 0, String(await focusCount()))

    // F1c 連按兩下（兩次完整按壓，間隔約 40 ms），focusLine 立刻回來 → 只觸發一次
    await scenario({})
    await runTo(okResult())
    await heading()
    win.webContents.focus()
    keyDown('Return'); await sleep(20); keyUp('Return'); await sleep(40)
    keyDown('Return'); await sleep(20); keyUp('Return')
    await sleep(250)
    check('UI-F1c double Enter (≈40 ms apart), focusLine resolves instantly → exactly 1 focusLine', (await focusCount()) === 1, String(await focusCount()))
    // 連按兩下，focusLine 還沒回來（進行中）→ 只觸發一次
    await scenario({ focus: 'pending' })
    await runTo(okResult())
    await heading()
    win.webContents.focus()
    keyDown('Return'); await sleep(20); keyUp('Return'); await sleep(300)
    keyDown('Return'); await sleep(20); keyUp('Return')
    await sleep(250)
    check('UI-F1c double Enter while focusLine is in flight (≈300 ms apart) → exactly 1 focusLine', (await focusCount()) === 1, String(await focusCount()))
    await R(`window.__resolveFocus(${J(fu('focusLine', { outcome: 'focused' }))}); true`)
    await sleep(100)
    // 按住 Enter 時 Enter 不會啟動焦點所在的按鈕（清除）
    await scenario({})
    await runTo(okResult())
    await R(`[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '從 LINE 清除這段草稿').focus(); true`)
    win.webContents.focus()
    keyDown('Return')
    for (let i = 0; i < 4; i++) { await sleep(30); keyDown('Return', true) }
    keyUp('Return')
    await sleep(200)
    const csHold = await calls()
    check('UI-F1d holding Enter on 「清除」 → 1 focusLine, clearFilled NOT called', csHold.filter((c) => c === 'focusLine').length === 1 && !csHold.includes('clearFilled'), csHold.join(','))

    // F1e helper 守門不通過（user_busy）→ messages.ts 文案；之後放開再按一次仍可觸發
    await scenario({ focus: fu('focusLine', { code: 'user_busy' }) })
    await runTo(okResult())
    await clickBtn('切到 LINE')
    await sleep(200)
    const sBusy = await R(`(() => { const e = document.querySelector('.dp-inline-msg.warn'); return e ? { t: e.textContent, role: e.getAttribute('role') } : null })()`)
    check('UI-F1e focusLine user_busy → warn alert = messages.FOCUS_USER_BUSY_NOTE', sBusy && sBusy.role === 'alert' && sBusy.t === m.FOCUS_USER_BUSY_NOTE && sBusy.t === m.followUpMessage('focusLine', { code: 'user_busy' }, X), J(sBusy))
    await shot('success-focus-user-busy')

    // ── 4b 已清除 ──
    await scenario({})
    await runTo(okResult())
    await clickBtn('從 LINE 清除這段草稿')
    await sleep(200)
    const s4b = await R(`(() => ({ h: document.querySelector('.dp-result.ok h3').textContent, msg: (document.querySelector('.dp-inline-msg.ok') || {}).textContent, focusBtn: !![...document.querySelectorAll('.dp-acts button')].find((x) => x.textContent.trim() === '切到 LINE'), details: !!document.querySelector('.dp-result details') }))()`)
    check('UI-4b cleared: heading 「已清除：王小明 的草稿」, message from messages.ts, only 關閉', /已清除：王小明 的草稿/.test(s4b.h) && s4b.msg === m.followUpMessage('clearFilled', { outcome: 'cleared' }, X) && !s4b.focusBtn && !s4b.details, J(s4b))
    await key('Return')
    check('UI-4b Enter after clear does not call focusLine', !(await calls()).includes('focusLine'))
    await shot('success-cleared')

    // ── 4c 清除被拒 ──
    await scenario({ clear: fu('clearFilled', { code: 'edit_changed' }) })
    await runTo(okResult())
    await clickBtn('從 LINE 清除這段草稿')
    await sleep(200)
    const s4c = await R(`(() => { const e = document.querySelector('.dp-inline-msg.warn'); return e ? { t: e.textContent, role: e.getAttribute('role') } : null })()`)
    check('UI-4c clear refused: warn alert with messages.ts 4c text', s4c && s4c.role === 'alert' && s4c.t === m.followUpMessage('clearFilled', { code: 'edit_changed' }, X), J(s4c))
    await shot('success-clear-refused')

    // ── 4d 切到 LINE 時聊天室已變 ──
    await scenario({ focus: fu('focusLine', { code: 'title_changed', activated: true }) })
    await runTo(okResult())
    await clickBtn('切到 LINE')
    await sleep(200)
    const s4d = await text('.dp-inline-msg.warn')
    check('UI-4d focus changed: warn with messages.ts 4d text', s4d === m.followUpMessage('focusLine', { code: 'title_changed' }, X), s4d)
    await shot('success-focus-changed')

    // ── 4e 無法切回 line-todo ──
    await scenario({})
    await runTo(okResult({ handedBack: false }))
    const s4e = await text('.dp-inline-msg.warn')
    check('UI-4e handedBack=false: note = messages.HAND_BACK_FAILED_NOTE', s4e === m.HAND_BACK_FAILED_NOTE, s4e)
    // review F2：同一畫面不得同時說「按 Enter 會直接送出」和「在這裡按 Enter……不會送出」
    const f2 = await R(`(() => { const s = document.querySelector('.dp-result.ok'); return { all: s.textContent, sub: s.querySelector('.dp-sub').textContent, modal: document.querySelector('.modal').textContent } })()`)
    const saysSends = /按 Enter 會直接送出/.test(f2.modal)
    const saysNoSend = /按 Enter[^。]*不會送出/.test(f2.modal)
    check('UI-F2 handedBack=false: warns 「按 Enter 會直接送出」 and does NOT also say 「在這裡按 Enter…不會送出」', saysSends && !saysNoSend && !/Enter/.test(f2.sub) && /分鐘內有效/.test(f2.sub), `sends=${saysSends} noSend=${saysNoSend} sub=${f2.sub}`)
    await shot('success-noback')
    // 對照：handedBack=true 時仍顯示 Enter 提示，而且不出現「會直接送出」
    await scenario({})
    await runTo(okResult())
    const f2b = await R(`document.querySelector('.modal').textContent`)
    check('UI-F2 handedBack=true: Enter hint shown, no 「會直接送出」 warning (no contradiction either way)', /在這裡按 Enter 等同按「切到 LINE」/.test(f2b) && !/按 Enter 會直接送出/.test(f2b))

    // ── 4f 超過 5 分鐘（用短 TTL 模擬）──
    await scenario({})
    await runTo(okResult({ ttl: 300 }))
    await sleep(500)
    const s4f = await R(`(() => ({ note: [...document.querySelectorAll('.dp-inline-msg.warn')].map((e) => e.textContent), f: [...document.querySelectorAll('.dp-acts button')].filter((x) => x.disabled).map((x) => x.textContent.trim()) }))()`)
    check('UI-4f expired: expiredNote from messages.ts, 切到 LINE / 清除 disabled', s4f.note.includes(m.FOLLOW_UP_EXPIRED_NOTE) && s4f.f.includes('切到 LINE') && s4f.f.includes('從 LINE 清除這段草稿'), J(s4f))
    await R(`document.querySelector('.dp-result h3').focus(); true`)
    await key('Return')
    check('UI-4f Enter after expiry does nothing', !(await calls()).includes('focusLine'))
    await shot('success-expired')

    // ── 失敗狀態 ──
    const failCase = async (name, r, want) => {
      await scenario({})
      await runTo(r)
      const d = await R(`(() => { const s = document.querySelector('.dp-result'); if (!s) return null; const eff = s.querySelector('.dp-effect'); return { cls: s.className, role: s.getAttribute('role'), h: s.querySelector('h3').textContent, body: s.querySelector('h3 + p').textContent, eff: eff ? eff.textContent : null, effCls: eff ? eff.className : null, nv: !!s.querySelector('.nv'), big: (s.querySelector('.nv-big') || {}).textContent || null, tech: s.querySelector('details p').textContent, focus: document.activeElement && document.activeElement.tagName } })()`)
      const copy = await btn('複製')
      const fillB = await btn('填入 LINE')
      const errs = []
      if (!d) errs.push('no result block')
      else {
        if (d.body !== r.body) errs.push('body != messages.ts body')
        if (r.tail && d.eff && d.eff.replace(/^[✓⚠]\s/, '') !== r.tail) errs.push('effect != messages.ts tail: ' + d.eff)
        if (!r.tail && d.eff) errs.push('unexpected effect row')
        if (want.h && d.h !== want.h) errs.push('header ' + d.h)
        if (want.tone !== undefined && d.cls !== ('dp-result ' + want.tone).trim()) errs.push('tone ' + d.cls)
        if (want.effCls && d.effCls !== want.effCls) errs.push('effCls ' + d.effCls)
        if (want.big && d.big !== want.big) errs.push('big ' + d.big)
        if (d.role !== 'alert') errs.push('role')
        if (d.focus !== 'H3') errs.push('focus ' + d.focus)
        if (!d.tech.includes(r.code)) errs.push('tech details lacks code')
        if (want.copyPrimary !== undefined && copy.primary !== want.copyPrimary) errs.push('copyPrimary ' + copy.primary)
        if (copy.disabled) errs.push('copy disabled')
        if (fillB.disabled) errs.push('fill disabled')
      }
      check(`UI-${name}`, errs.length === 0, errs.join(' | ') || (d && d.h))
      await shot(name.replace(/\s.*/, ''))
    }
    await failCase('5 target_not_visible below', fail('target_not_visible', 'locate_row', { visibility: { direction: 'below', rows: 14 } }), { h: '請先在 LINE 捲動聊天列表', tone: '', big: '往下捲 ↓ 約 14 列', copyPrimary: false })
    await failCase('5b target_not_visible above', fail('target_not_visible', 'locate_row', { visibility: { direction: 'above', rows: 9 } }), { h: '請先在 LINE 捲動聊天列表', tone: '', big: '往上捲 ↑ 約 9 列' })
    await failCase('5c target_not_visible edge(bottom)', fail('target_not_visible', 'locate_row', { visibility: { direction: 'edge', rows: 0, edgeSide: 'bottom' } }), { h: '請把「王小明」捲離列表邊緣', tone: '', big: '稍微往下捲 1–2 列' })
    await failCase('6 title_unconfirmed (chat opened)', fail('title_unconfirmed', 'verify_open', { activated: true, opened: true }), { h: '已停止，沒有填入（有開啟聊天室）', tone: 'err', effCls: 'dp-effect opened' })
    await failCase('7 line_not_running', fail('line_not_running', 'locate_line'), { h: '已停止，沒有填入', tone: '', effCls: 'dp-effect' })
    await failCase('7b line_no_window', fail('line_no_window', 'locate_line'), { tone: '' })
    await failCase('7c line_activate_failed', fail('line_activate_failed', 'locate_line'), { tone: '' })
    await failCase('8 user_busy (activated)', fail('user_busy', 'open_chat', { activated: true }), { tone: '', effCls: 'dp-effect' })
    await failCase('9a row_unconfirmed (copy primary)', fail('row_unconfirmed', 'locate_row'), { tone: 'warn', copyPrimary: true })
    await failCase('9b click_missed (opened)', fail('click_missed', 'verify_open', { activated: true, opened: true }), { tone: 'err', effCls: 'dp-effect opened' })
    await failCase('9c timeout (draft unknown)', fail('timeout', 'fill', { activated: true, opened: true, left: 'unknown' }), { h: '已停止，請到 LINE 檢查輸入框', tone: 'err', effCls: 'dp-effect unknown' })
    await failCase('9d disabled (preflight, no effect row)', fail('disabled', 'preflight'), { tone: 'warn' })
    // review F3：點擊結果不確定（逾時）→ 「可能已開啟」，不得出現「沒有開啟任何聊天室」
    const f3r = fail('timeout', 'open_chat', { activated: true, uncertain: true })
    await failCase('F3 timeout while click pending (chatOpenUncertain)', f3r, { h: '已停止，沒有填入（可能已開啟聊天室）', tone: 'err', effCls: 'dp-effect opened' })
    const f3 = await R(`(() => { const s = document.querySelector('.dp-result'); return { all: s.textContent, bold: (s.querySelector('.dp-effect b:not([aria-hidden])') || {}).textContent || null } })()`)
    check('UI-F3 uncertain open: tail = messages.CHAT_OPEN_UNCERTAIN_TAIL, emphasises 「可能已開啟一個聊天室」, never 「沒有開啟任何聊天室」', f3r.tail === m.CHAT_OPEN_UNCERTAIN_TAIL && f3.all.includes(m.CHAT_OPEN_UNCERTAIN_TAIL) && f3.bold === '可能已開啟一個聊天室' && !/沒有開啟任何聊天室/.test(f3.all), J(f3))

    // ── 10 設定頁 ──
    await scenario({ settingsDp: { enabled: true, mode: 'fillOnly', verifyReadByDb: true } }, 'settings')
    const s10 = await R(`(() => {
      const sec = document.querySelector('section.set-section');
      const send = [...sec.querySelectorAll('input[type=radio]')].find((i) => i.value === 'fillAndSend');
      const only = [...sec.querySelectorAll('input[type=radio]')].find((i) => i.value === 'fillOnly');
      return { title: sec.querySelector('.set-section-title').textContent, sendDisabled: send.disabled, onlyChecked: only.checked, lock: sec.querySelector('.prov-card.locked .prov-speed').textContent, switches: sec.querySelectorAll('input[role=switch]').length, notice: sec.querySelector('.set-notice-title').textContent }
    })()`)
    check('UI-10 settings: section 「填入 LINE」, 自動送出 disabled + 「尚未開放」, fillOnly checked, 2 switches, 使用前須知', s10.title === '填入 LINE' && s10.sendDisabled && s10.onlyChecked && s10.lock === '尚未開放' && s10.switches === 2 && s10.notice === '使用前須知', J(s10))
    await shot('settings')
    await R(`document.querySelectorAll('section.set-section input[role=switch]')[0].click(); true`)
    await sleep(150)
    const s10b = await R(`(() => { const sec = document.querySelector('section.set-section'); const sw = sec.querySelectorAll('input[role=switch]'); return { verifyDisabled: sw[1].disabled, fieldsetDisabled: sec.querySelector('fieldset').disabled, dep: !!sec.querySelector('.set-notice.dep-off'), calls: window.__calls } })()`)
    check('UI-10 master switch off → patch {enabled:false}, 已讀檢查 & 模式 disabled, notice dimmed', s10b.verifyDisabled && s10b.fieldsetDisabled && s10b.dep && s10b.calls.includes('patch:{"enabled":false}'), J(s10b))
    await shot('settings-off')
    await R(`document.querySelectorAll('section.set-section input[role=switch]')[0].click(); true`)
    await sleep(100)
    await R(`document.querySelectorAll('section.set-section input[role=switch]')[1].click(); true`)
    await sleep(100)
    check('UI-10 已讀檢查 switch → patch {verifyReadByDb:false}', (await calls()).includes('patch:{"verifyReadByDb":false}'))

    const failed = results.filter((r) => !r.ok)
    console.log(`[probe-ui] screenshots=${shotN}${shotsDir ? ' dir=' + shotsDir : ''} (line-todo renderer only; no LINE)`)
    console.log(`[probe-ui] ${results.length - failed.length}/${results.length} passed`)
    return failed.length === 0 ? 0 : 1
  } catch (err) {
    console.error('[probe-ui] ERROR', err && err.stack ? err.stack : err)
    return 1
  } finally {
    try { win && !win.isDestroyed() && win.destroy() } catch (_) {}
    cleanup()
  }
}

app.whenReady().then(() => main()).then((c) => app.exit(c))
