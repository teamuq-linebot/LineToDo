// probe-driver-statemachine —— driver_post Batch 4 驗收 M4：狀態機 v3 的每個失敗路徑（design-v3 §5、§6、§11 M4）。
//
// 用 production 的 src/main/driver/postDraft.ts（esbuild 打包）＋可腳本化的假 port（LineUiPortV3、LineOrderPort）。
// 不碰 LINE、不 spawn helper。合成世界：R* 60 名（名稱兩兩距離 ≥ 3），螢幕第 0 列部分可見、第 1–11 列完整可見，
// 位移 12；目標預設是名次 20（螢幕第 8 列）。OCR 預設完美。
//
// 每個情境斷言：code、stage、draftLeftInLine、lineSideEffects（activated／chatOpened），以及呼叫紀錄：
//   - 沒有任何寫入搜尋框的呼叫
//   - S6（activate_line）之前沒有 activateLine（最小化還原除外，restore=true）
//   - guardedClick 只在 open_chat，且點的是 DB 名次＋位移算出的列（I4、I13）
//   - setEdit 只在 fill，且只在 C1、C2 通過、C3 沒有否決之後（I1）
//   - list_changing 最多重試 1 次（readList ≤ 2 次）
//   - 寫入之後的失敗路徑不再點擊或寫入（I9）
//   - activateLine／guardedClick／setEdit 都帶預先登記的安靜期（I5：Q_act 300、Q_click 500、Q_fill 500＋無按鍵、W 3 s）
//     review F1 之後：Q_act 也要求無按鍵；成功後的 focusEdit 帶 Q_focus（500＋無按鍵、W 3 s）
// review F1／F3 補充（FR- 開頭的案例）：
//   - F3：點擊已送出但沒有拿到結果（port 逾時、整體逾時、helper 結束）→ chatOpenUncertain，尾句「可能已開啟」，
//     不得出現「沒有開啟任何聊天室」；helper 明確拒絕點擊時仍是「沒有開啟」。
//   - F1：focusLine 時 helper 回 user_busy → 後續結果 code=user_busy、activated=false（detail late → true），訊息來自 messages.ts。
// 另外：每個 DriverPostErrorCode 至少一個情境；VisibilityHint.edgeSide；lineSideEffects.activated 在
// row_changed、occluded、user_busy、最小化還原等路徑的值（Manager 補充）。
//
// 執行：npx electron scripts/probe-driver-statemachine.cjs（exit 0 = 全數 PASS）

const path = require('node:path')
const fs = require('node:fs')
const esbuild = require('esbuild')

let app = null
try { app = require('electron').app } catch { app = null }

const ENTRY = `
export { createPostDraft } from './src/main/driver/postDraft.ts'
export { PortTimeoutError, PortUnavailableError, PortCommandError } from './src/main/driver/port.ts'
export { normalizeName } from './src/main/driver/identify.ts'
export { CHAT_OPEN_UNCERTAIN_TAIL, FOCUS_USER_BUSY_NOTE, followUpMessage } from './src/main/driver/messages.ts'
`

const ALL_CODES = ['disabled', 'busy', 'rate_limited', 'invalid_request', 'text_too_long', 'send_not_available', 'todo_not_found', 'chat_name_missing', 'chat_name_unverifiable', 'test_allowlist_blocked', 'host_unavailable', 'powershell_restricted', 'ocr_unavailable', 'line_db_unavailable', 'line_key_unavailable', 'line_not_running', 'line_no_window', 'line_multiple_windows', 'line_activate_failed', 'line_capture_failed', 'line_ui_unrecognized', 'line_search_active', 'user_busy', 'target_not_in_line', 'list_changing', 'list_unrecognized', 'list_order_mismatch', 'target_not_visible', 'row_unconfirmed', 'row_identifies_other', 'row_changed', 'occluded', 'click_missed', 'title_unreadable', 'title_unconfirmed', 'title_identifies_other', 'title_changed', 'opened_other_suspected', 'draft_present', 'fill_readback_mismatch', 'timeout', 'internal']

// ── 合成名稱 ──
let seed = 424242 >>> 0
const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const POOL = '春夏秋冬東南西北山川河海林森花草木石金銀銅鐵天地日月星雲風雨雪霜紅橙黃綠藍紫白黑晴陰光影龍虎鳳龜鶴鹿馬牛羊雞犬貓'.split('')
function lev(a, b) { const A = [...a], B = [...b]; let prev = Array.from({ length: B.length + 1 }, (_, j) => j); for (let i = 1; i <= A.length; i++) { const cur = [i]; for (let j = 1; j <= B.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1)); prev = cur } return prev[B.length] }
const NAMES = []
while (NAMES.length < 70) { const s = Array.from({ length: 4 + Math.floor(rnd() * 3) }, () => POOL[Math.floor(rnd() * POOL.length)]).join(''); if (NAMES.every((x) => lev(x, s) >= 3)) NAMES.push(s) }

const T0 = Date.now() - 10 * 60 * 1000 // 最新更新在 10 分鐘前（L8 的 5 s 新鮮度條件成立）
const ocrLine = (text, y) => {
  let x = 60
  const words = [...String(text)].filter((c) => c.trim()).map((c) => { const w = { text: c, rect: { x, y, w: 12, h: 15 } }; x += 14; return w })
  return { text: words.map((w) => w.text).join(' '), rect: { x: 60, y, w: Math.max(1, x - 62), h: 15 }, words }
}

/** 世界：DB 列（R* 順序即陣列順序）、畫面清單、螢幕位移。 */
function makeWorld(o = {}) {
  const names = o.names ?? NAMES.slice(0, 60)
  const rows = names.map((name, i) => ({ chatId: 'c' + String(i).padStart(2, '0'), lastUpdated: T0 - i * 60_000, pinned: false, hidden: false, unread: 0, midType: 0, status: 1, name }))
  const screen = o.screen ? o.screen(rows) : rows
  return { rows, screen, s: o.s ?? 12, targetRank: o.targetRank ?? 20, selfMid: o.selfMid ?? 'self-mid' }
}

function snapshotOf(rows, extra = {}) {
  return { rows: rows.map((r) => ({ ...r })), selfMid: extra.selfMid ?? 'self-mid', takenAt: Date.now(), newestUpdate: T0, readMs: 5 }
}

async function main() {
  const root = path.join(__dirname, '..')
  const entryFile = path.join(root, '__probe_sm_entry.ts')
  const outFile = path.join(root, '__probe_sm.bundle.cjs')
  const cleanup = () => { for (const f of [entryFile, outFile]) { try { fs.rmSync(f, { force: true }) } catch (_) {} } }
  const results = []
  const seen = new Set()
  try {
    fs.writeFileSync(entryFile, ENTRY, 'utf8')
    await esbuild.build({ entryPoints: [entryFile], bundle: true, platform: 'node', format: 'cjs', outfile: outFile, absWorkingDir: root, logLevel: 'silent', external: ['electron'] })
    const m = require(outFile)

    /**
     * 建立一次執行的假 port 與 deps。o 可覆寫各指令（回傳值或函式）。
     * 呼叫紀錄 calls：{ cmd, stage, args }。
     */
    function harness(o = {}) {
      const W = o.world ?? makeWorld()
      const calls = []
      let stage = 'preflight'
      const rowRect = (j) => ({ x: 0, y: 100 + 71 * j - 41, w: 300, h: 71 })
      const listRows = () => {
        const out = []
        for (let j = 0; j <= 11; j++) {
          const chat = W.screen[W.s + j]
          const partial = j === 0
          const r = { index: j, rect: rowRect(j), visibleH: partial ? 30 : 71, hash: 'h-' + (chat ? chat.chatId : 'none') + '-' + j, selected: (o.selectedBefore ?? 3) === j }
          if (o.selectionUnreadable && j === 5) r.selected = null
          if (!partial) {
            const text = o.rowText ? o.rowText(j, chat) : chat && chat.name ? chat.name : ''
            const line = text ? [ocrLine(text, 100 + 71 * j - 30)] : []
            r.ocr = { R1: line, R2: line, R3: line }
          }
          out.push(r)
        }
        return out
      }
      const titleOf = (text, hash) => {
        const line = text ? [ocrLine(text, 20)] : []
        return { ok: true, value: { byConfig: { T1: line, T2: line, T3: line }, stripRect: { x: 0, y: 10, w: 600, h: 31 }, stripHash: hash, blank: !text } }
      }
      let listCalls = 0
      let titleCalls = 0
      let clicked = false
      let restored = false
      const ui = {
        hello: async () => { calls.push({ cmd: 'hello', stage }); if (o.helloThrows) throw new m.PortUnavailableError('spawn_failed'); return { protocol: 3, psVersion: '5.1', languageMode: o.languageMode ?? 'FullLanguage', ocrLanguages: o.ocrLanguages ?? ['zh-Hant-TW', 'en-US'], dpiAwareness: 'per_monitor_v2', pid: 1 } },
        beginSession: async () => { calls.push({ cmd: 'beginSession', stage }) },
        endSession: async () => { calls.push({ cmd: 'endSession', stage }) },
        locateLine: async () => { calls.push({ cmd: 'locateLine', stage }); return o.locate ?? { status: 'ok', pid: 100, iconic: !!o.iconic, exeVersion: '26.4.2.3957', otherTopLevel: o.otherTopLevel ?? [] } },
        // Batch 3 實測：LINE 最小化時 UIA 樹收合，probeAnchors 缺 5 個節點；還原後才正常。
        probeAnchors: async () => { calls.push({ cmd: 'probeAnchors', stage }); if (o.iconic && !restored) return { ok: false, missing: ['MainChatPanel', 'ChatMessagePanel', 'ChatMessageView', 'MessageInputPanel', 'AutoSuggestTextArea'] }; return o.anchors ?? { ok: true, missing: [] } },
        readSearch: async () => { calls.push({ cmd: 'readSearch', stage }); return o.search ?? '' },
        readList: async (a) => {
          calls.push({ cmd: 'readList', stage, args: a }); listCalls++
          if (o.readListHang) await new Promise((r) => setTimeout(r, o.readListHang))
          if (o.readList) return o.readList(listCalls)
          return { ok: true, value: { rows: listRows(), listRect: { x: 0, y: 59, w: 300, h: 800 }, stable: o.unstable ? false : true, snapshotId: listCalls } }
        },
        readListGeometry: async () => {
          calls.push({ cmd: 'readListGeometry', stage })
          const rows = listRows().map(({ ocr, ...r }) => r)
          if (o.geometryChanged) rows[5].hash = 'changed'
          return { ok: true, value: { rows, listRect: { x: 0, y: 59, w: 300, h: 800 }, stable: true, snapshotId: 99 } }
        },
        readTitle: async (a) => {
          calls.push({ cmd: 'readTitle', stage, args: a }); titleCalls++
          if (!clicked) return titleOf(o.preTitle ?? W.screen[W.s + (o.selectedBefore ?? 3)]?.name ?? '', 'title-before')
          if (o.postTitle) return o.postTitle(titleCalls)
          return titleOf(W.rows[W.targetRank].name, o.postTitleHash ?? 'title-after')
        },
        activateLine: async (a) => {
          calls.push({ cmd: 'activateLine', stage, args: a })
          if (a.restore && o.restoreRefusal) return { ok: false, refusal: o.restoreRefusal }
          if (a.restore) restored = true
          if (!a.restore && o.activateRefusal) return { ok: false, refusal: o.activateRefusal }
          return { ok: true, value: { foreground: a.restore ? o.restoreForeground ?? true : o.foreground ?? true } }
        },
        guardedClick: async (a) => {
          calls.push({ cmd: 'guardedClick', stage, args: a })
          if (o.clickThrows) throw o.clickThrows()
          if (o.clickHang) await new Promise((res) => setTimeout(res, o.clickHang))
          if (o.clickRefusal) return { ok: false, refusal: o.clickRefusal }
          clicked = true
          return { ok: true, value: { clicked: true, selectedIndexAfter: o.selectedAfter !== undefined ? o.selectedAfter : a.row.index } }
        },
        waitTitleStable: async () => { calls.push({ cmd: 'waitTitleStable', stage }); return o.titleUnstable ? { ok: false, refusal: 'title_changed', detail: 'unstable' } : { ok: true, value: { stripHash: 'title-after' } } },
        readEdit: async () => { calls.push({ cmd: 'readEdit', stage }); if (o.readEditThrows) throw new Error('boom'); return { ok: true, value: { value: o.editValue ?? '', hasFocus: false } } },
        setEdit: async (text, hash, quiet) => {
          calls.push({ cmd: 'setEdit', stage, args: { hash, quiet } })
          if (o.setEditTimeout) throw new m.PortTimeoutError('setEdit')
          if (o.setEditHang) await new Promise((res) => setTimeout(res, o.setEditHang))
          if (o.setEditRefusal) return { ok: false, refusal: o.setEditRefusal }
          return { ok: true, value: { readback: o.readback ?? text } }
        },
        clearEditIfEquals: async () => { calls.push({ cmd: 'clearEditIfEquals', stage }); return o.clearRefusal ? { ok: false, refusal: 'edit_mismatch' } : { ok: true, value: { cleared: true } } },
        focusEdit: async (hash, quiet) => {
          calls.push({ cmd: 'focusEdit', stage, args: { hash, quiet } })
          if (o.focusRefusal) return { ok: false, refusal: o.focusRefusal, detail: o.focusDetail }
          return { ok: true, value: { focused: true } }
        },
        handBackFocus: async () => { calls.push({ cmd: 'handBackFocus', stage }); return { ok: true, value: { handedBack: o.handBack ?? true } } },
        telemetry: () => ({ activity: false, quietWaitMs: {} }),
        dispose: async () => { calls.push({ cmd: 'dispose', stage }) }
      }
      let snaps = 0
      const order = {
        snapshot: async () => {
          snaps++
          calls.push({ cmd: 'order.snapshot', stage, n: snaps })
          if (o.snapshot) { const r = o.snapshot(snaps, W); if (r) return r }
          return { ok: true, value: snapshotOf(W.rows, { selfMid: W.selfMid }) }
        }
      }
      const logs = []
      let handBackFailed = 0
      const deps = {
        ui, order,
        getSettings: () => ({ enabled: o.enabled ?? true, mode: 'fillOnly', verifyReadByDb: o.verifyReadByDb ?? true }),
        getTodo: (id) => (id === 'todo-1' ? { chatId: o.todoChatId ?? W.rows[W.targetRank].chatId } : null),
        getChatName: (chatId) => (o.dbName !== undefined ? o.dbName : (W.rows.find((r) => r.chatId === chatId)?.name ?? '某聊天室')),
        testAllowlist: () => o.allowlist ?? null,
        lineTodoHwnd: () => 4242n,
        onHandBackFailed: () => { handBackFailed++ },
        progress: (p) => { stage = p.stage },
        log: (l) => logs.push(l),
        sleep: async () => {},
        wholeOperationMs: o.wholeOperationMs
      }
      const svc = m.createPostDraft(deps)
      return { svc, calls, logs, W, get handBackFailed() { return handBackFailed } }
    }

    const REQ = { todoId: 'todo-1', text: '好的，明天下午三點見。\r\n謝謝！' }

    function invariants(h, r, expectRow) {
      const errs = []
      const cmds = h.calls.map((c) => c.cmd)
      if (cmds.some((c) => /search/i.test(c) && c !== 'readSearch')) errs.push('search write call present')
      const q = (x) => JSON.stringify(x && { minIdleMs: x.minIdleMs, maxWaitMs: x.maxWaitMs, requireNoKeysDown: !!x.requireNoKeysDown })
      for (const c of h.calls) {
        // I5（design-v2 §6.2）：三個會改變 LINE 狀態的動作都帶預先登記的安靜期（Q_act 300、Q_click 500、Q_fill 500＋無按鍵，W 3 s）
        // review F1：切前景（activateLine）也要求沒有按鍵按著（只准收緊）。
        if (c.cmd === 'activateLine' && q(c.args.quiet) !== q({ minIdleMs: 300, maxWaitMs: 3000, requireNoKeysDown: true })) errs.push('I5 activateLine quiet ' + q(c.args.quiet))
        if (c.cmd === 'focusEdit' && q(c.args.quiet) !== q({ minIdleMs: 500, maxWaitMs: 3000, requireNoKeysDown: true })) errs.push('I5 focusEdit quiet ' + q(c.args.quiet))
        if (c.cmd === 'guardedClick' && q(c.args.quiet) !== q({ minIdleMs: 500, maxWaitMs: 3000 })) errs.push('I5 guardedClick quiet ' + q(c.args.quiet))
        if (c.cmd === 'setEdit' && q(c.args.quiet) !== q({ minIdleMs: 500, maxWaitMs: 3000, requireNoKeysDown: true })) errs.push('I5 setEdit quiet ' + q(c.args.quiet))
        if (c.cmd === 'guardedClick' && c.args.dryRun) errs.push('unexpected dryRun in production path')
        if (c.cmd === 'activateLine' && !(c.stage === 'activate_line' || (c.stage === 'locate_line' && c.args && c.args.restore === true))) errs.push('activateLine before S6 at ' + c.stage)
        if (c.cmd === 'guardedClick' && c.stage !== 'open_chat') errs.push('guardedClick outside open_chat')
        if (c.cmd === 'setEdit' && c.stage !== 'fill') errs.push('setEdit outside fill')
      }
      const click = h.calls.find((c) => c.cmd === 'guardedClick')
      if (click && expectRow !== undefined && click.args.row.index !== expectRow) errs.push(`clicked row ${click.args.row.index} != expected ${expectRow}`)
      if (click) {
        const wr = click.args.windowRows.map((w) => w.index).join(',')
        if (wr !== '1,2,3,4,5,6,7,8,9,10,11') errs.push('windowRows not all fully visible rows: ' + wr)
      }
      if (h.calls.filter((c) => c.cmd === 'readList').length > 2) errs.push('readList > 2 (list_changing retried more than once)')
      if (h.calls.filter((c) => c.cmd === 'guardedClick').length > 1) errs.push('more than one click')
      const iSet = cmds.indexOf('setEdit')
      if (iSet >= 0) {
        const after = cmds.slice(iSet + 1)
        if (after.some((c) => c === 'guardedClick' || c === 'setEdit' || c === 'activateLine')) errs.push('LINE touched after write')
        if (!cmds.slice(0, iSet).includes('readTitle')) errs.push('setEdit without title read')
      }
      if (!r.ok && r.stage === 'preflight' && cmds.some((c) => c !== 'order.snapshot')) errs.push('preflight failure touched LINE UI: ' + cmds.join(','))
      if (h.logs.some((l) => /[一-鿿]/.test(l))) errs.push('audit log contains CJK (possible name leak)')
      return errs
    }

    async function scenario(name, opts, expect) {
      const h = harness(opts)
      let r
      if (expect.run) r = await expect.run(h)
      else r = await h.svc.postDraft(expect.req ?? REQ)
      const errs = invariants(h, r, expect.row)
      if (expect.ok) {
        if (!r.ok) errs.push('expected ok, got ' + r.code + '@' + r.stage)
      } else {
        if (r.ok) errs.push('expected ' + expect.code + ', got ok')
        else {
          if (r.code !== expect.code) errs.push(`code ${r.code} != ${expect.code}`)
          if (expect.stage && r.stage !== expect.stage) errs.push(`stage ${r.stage} != ${expect.stage}`)
          if (expect.left && r.draftLeftInLine !== expect.left) errs.push(`left ${r.draftLeftInLine} != ${expect.left}`)
          if (expect.activated !== undefined && r.lineSideEffects.activated !== expect.activated) errs.push(`activated ${r.lineSideEffects.activated} != ${expect.activated}`)
          if (expect.opened !== undefined && r.lineSideEffects.chatOpened !== expect.opened) errs.push(`chatOpened ${r.lineSideEffects.chatOpened} != ${expect.opened}`)
          if (r.lineSideEffects.searchChanged !== false || r.lineSideEffects.searchRestored !== false) errs.push('searchChanged/Restored not false')
          if (typeof r.message !== 'string' || !r.message) errs.push('empty message')
          seen.add(r.code)
        }
      }
      if (expect.check) { try { const e = expect.check(r, h); if (e) errs.push(e) } catch (ex) { errs.push('check threw: ' + ex.message) } }
      const ok = errs.length === 0
      results.push({ name, ok })
      const summary = r.ok ? `ok path=${r.locate.path} row=${r.locate.row} dbAck=${r.open.dbAck} handedBack=${r.handedBack}` : `${r.code}@${r.stage} left=${r.draftLeftInLine} activated=${r.lineSideEffects.activated} opened=${r.lineSideEffects.chatOpened}`
      console.log(`[probe-sm] ${ok ? 'PASS' : 'FAIL'} ${name} → ${summary}${ok ? '' : ' :: ' + errs.join(' | ')}`)
    }

    const setOf = (h) => h.calls.map((c) => c.cmd)
    const noSetEdit = (r, h) => (setOf(h).includes('setEdit') ? 'setEdit was called' : null)
    const noClick = (r, h) => (setOf(h).includes('guardedClick') ? 'guardedClick was called' : null)
    const noActivate = (r, h) => (setOf(h).includes('activateLine') ? 'activateLine was called' : null)

    // ── 成功路徑 ──
    await scenario('OK-1 happy path (T), C3 no_change, handed back', {}, { ok: true, row: 8, check: (r) => (r.locate.row === 8 && r.locate.offset === 12 && r.open.dbAck === 'no_change' && r.handedBack === true ? null : 'evidence mismatch') })
    await scenario('OK-2 verifyReadByDb=false → dbAck skipped, only 2 DB reads', { verifyReadByDb: false }, { ok: true, row: 8, check: (r, h) => (r.open.dbAck === 'skipped' && h.calls.filter((c) => c.cmd === 'order.snapshot').length === 2 ? null : 'dbAck/DB reads') })
    await scenario('OK-3 DB-C unavailable → dbAck na, continue', { snapshot: (n) => (n === 3 ? { ok: false, code: 'line_db_unavailable' } : null) }, { ok: true, row: 8, check: (r) => (r.open.dbAck === 'na' ? null : 'dbAck ' + r.open.dbAck) })
    await scenario('OK-4 target already open (selectedBefore==r, title hash unchanged)', { selectedBefore: 8, postTitleHash: 'title-before' }, { ok: true, row: 8 })
    await scenario('OK-5 C3 target_cleared recorded', { snapshot: (n, W) => { const rows = W.rows.map((r, i) => ({ ...r, unread: i === W.targetRank && n < 3 ? 2 : 0 })); return { ok: true, value: snapshotOf(rows) } } }, { ok: true, row: 8, check: (r) => (r.open.dbAck === 'target_cleared' ? null : 'dbAck ' + r.open.dbAck) })
    await scenario('OK-6 hand back fails → handedBack=false, onHandBackFailed', { handBack: false }, { ok: true, row: 8, check: (r, h) => (r.handedBack === false && h.handBackFailed === 1 ? null : 'handBack') })
    await scenario('OK-7 minimized: restore then continue (activated set before S6)', { iconic: true }, { ok: true, row: 8, check: (r, h) => { const c = setOf(h); return c.filter((x) => x === 'activateLine').length !== 2 ? 'expected 2 activateLine' : !(c.indexOf('readSearch') < c.indexOf('activateLine') && c.indexOf('activateLine') < c.indexOf('probeAnchors')) ? 'order must be readSearch → restore → probeAnchors: ' + c.join(',') : null } })
    await scenario('OK-8 allowlist Keep筆記 == selfMid', { allowlist: ['Keep筆記'], world: makeWorld({ selfMid: 'c20' }) }, { ok: true, row: 8 })
    await scenario('OK-9 list_changing once then stable → ok (1 retry)', { snapshot: (n, W) => (n === 2 ? { ok: true, value: snapshotOf(W.rows.map((r, i) => (i === 14 ? { ...W.rows[15], lastUpdated: r.lastUpdated } : i === 15 ? { ...W.rows[14], lastUpdated: r.lastUpdated } : r))) } : null) }, { ok: true, row: 8, check: (r, h) => (h.calls.filter((c) => c.cmd === 'readList').length === 2 ? null : 'expected 2 readList') })

    // ── S0 preflight ──
    await scenario('disabled', { enabled: false }, { code: 'disabled', stage: 'preflight', activated: false, opened: false })
    await scenario('send_not_available', {}, { code: 'send_not_available', stage: 'preflight', req: { ...REQ, mode: 'fillAndSend' } })
    await scenario('invalid_request (blank)', {}, { code: 'invalid_request', stage: 'preflight', req: { todoId: 'todo-1', text: '  \r\n ' } })
    await scenario('text_too_long', {}, { code: 'text_too_long', stage: 'preflight', req: { todoId: 'todo-1', text: 'x'.repeat(5001) } })
    await scenario('todo_not_found', {}, { code: 'todo_not_found', stage: 'preflight', req: { todoId: 'nope', text: 'hi' } })
    await scenario('chat_name_missing', { dbName: null }, { code: 'chat_name_missing', stage: 'preflight' })
    await scenario('chat_name_unverifiable (emoji-only)', { dbName: '🎉🎉' }, { code: 'chat_name_unverifiable', stage: 'preflight' })
    await scenario('test_allowlist_blocked (chatId not listed)', { allowlist: ['c99'] }, { code: 'test_allowlist_blocked', stage: 'preflight', check: (r, h) => (setOf(h).length === 0 ? null : 'touched something') })
    await scenario('test_allowlist_blocked (Keep筆記 ≠ target)', { allowlist: ['Keep筆記'] }, { code: 'test_allowlist_blocked', stage: 'preflight', check: (r, h) => (setOf(h).join() === 'order.snapshot' ? null : 'calls ' + setOf(h).join()) })
    await scenario('busy + rate_limited', {}, {
      code: 'busy',
      run: async (h) => {
        const slow = harness({ readListHang: 50 })
        const p1 = slow.svc.postDraft(REQ)
        const r2 = await slow.svc.postDraft(REQ)
        await p1
        const r3 = await slow.svc.postDraft(REQ)
        if (!(r3 && !r3.ok && r3.code === 'rate_limited')) throw new Error('expected rate_limited, got ' + (r3.ok ? 'ok' : r3.code))
        seen.add('rate_limited')
        h.calls.push(...[])
        return r2
      }
    })

    // ── S1 host ──
    await scenario('host_unavailable', { helloThrows: true }, { code: 'host_unavailable', stage: 'host_start', activated: false })
    await scenario('powershell_restricted', { languageMode: 'ConstrainedLanguage' }, { code: 'powershell_restricted', stage: 'host_start' })
    await scenario('ocr_unavailable', { ocrLanguages: ['en-US'] }, { code: 'ocr_unavailable', stage: 'host_start' })

    // ── S2 ──
    await scenario('line_not_running', { locate: { status: 'not_running' } }, { code: 'line_not_running', stage: 'locate_line', activated: false })
    await scenario('line_no_window', { locate: { status: 'no_window', pid: 5 } }, { code: 'line_no_window', stage: 'locate_line' })
    await scenario('line_multiple_windows (2 main windows)', { locate: { status: 'multiple_windows', pid: 5, count: 2 } }, { code: 'line_multiple_windows', stage: 'locate_line' })
    await scenario('line_multiple_windows (popped-out chat window)', { otherTopLevel: ['ChatWindow'] }, { code: 'line_multiple_windows', stage: 'locate_line', activated: false })
    await scenario('line_ui_unrecognized (anchors)', { anchors: { ok: false, missing: ['LcListView'] } }, { code: 'line_ui_unrecognized', stage: 'locate_line' })
    await scenario('line_search_active', { search: 'a' }, { code: 'line_search_active', stage: 'locate_line', activated: false, check: noActivate })
    await scenario('minimized + search active → line_search_active before any restore', { iconic: true, search: 'a' }, { code: 'line_search_active', stage: 'locate_line', activated: false, check: noActivate })
    await scenario('minimized: restore refused → user_busy, activated=false', { iconic: true, restoreRefusal: 'user_busy' }, { code: 'user_busy', stage: 'locate_line', activated: false, opened: false })
    await scenario('minimized: restore not foreground → line_activate_failed, activated=true', { iconic: true, restoreForeground: false }, { code: 'line_activate_failed', stage: 'locate_line', activated: true, opened: false })
    await scenario('minimized then list_order_mismatch → activated=true, opened=false', { iconic: true, world: makeWorld({ screen: (rows) => { const x = [...rows]; x.splice(17, 0, { chatId: 'fake', name: '完全陌生的聊天室' }); return x } }) }, { code: 'list_order_mismatch', stage: 'locate_row', activated: true, opened: false, check: noClick })

    // ── S3 ──
    await scenario('line_db_unavailable (DB-A)', { snapshot: () => ({ ok: false, code: 'line_db_unavailable' }) }, { code: 'line_db_unavailable', stage: 'read_order', activated: false })
    await scenario('line_key_unavailable (no cached key; no memory scan)', { snapshot: () => ({ ok: false, code: 'line_key_unavailable' }) }, { code: 'line_key_unavailable', stage: 'read_order', activated: false, check: (r) => (/金鑰/.test(r.message) ? null : 'message') })
    await scenario('target_not_in_line (hidden)', { snapshot: (n, W) => ({ ok: true, value: snapshotOf(W.rows.map((r, i) => (i === W.targetRank ? { ...r, hidden: true } : r))) }) }, { code: 'target_not_in_line', stage: 'read_order' })
    await scenario('chat_name_unverifiable (LINE name unresolvable)', { snapshot: (n, W) => ({ ok: true, value: snapshotOf(W.rows.map((r, i) => (i === W.targetRank ? { ...r, name: null } : r))) }) }, { code: 'chat_name_unverifiable', stage: 'read_order' })

    // ── S4 ──
    await scenario('line_capture_failed (readList)', { readList: () => ({ ok: false, refusal: 'capture_blank' }) }, { code: 'line_capture_failed', stage: 'read_list', activated: false })
    await scenario('line_ui_unrecognized (selection unreadable)', { selectionUnreadable: true }, { code: 'line_ui_unrecognized', stage: 'read_list' })

    // ── S5 ──
    await scenario('list_changing (DB-A≠DB-B twice; exactly 1 retry)', { snapshot: (n, W) => ({ ok: true, value: snapshotOf(n % 2 === 0 ? W.rows.map((r, i) => (i === 14 ? { ...W.rows[15], lastUpdated: r.lastUpdated } : i === 15 ? { ...W.rows[14], lastUpdated: r.lastUpdated } : r)) : W.rows) }) }, { code: 'list_changing', stage: 'locate_row', activated: false, check: (r, h) => (h.calls.filter((c) => c.cmd === 'readList').length === 2 ? noClick(r, h) : 'readList count') })
    await scenario('list_changing (recent update < 5 s)', { snapshot: (n, W) => ({ ok: true, value: { ...snapshotOf(W.rows), newestUpdate: Date.now() } }) }, { code: 'list_changing', stage: 'locate_row' })
    await scenario('list_changing (capture unstable)', { unstable: true }, { code: 'list_changing', stage: 'locate_row' })
    await scenario('list_unrecognized (all OCR empty)', { rowText: () => '' }, { code: 'list_unrecognized', stage: 'locate_row', activated: false, check: noClick })
    await scenario('list_order_mismatch (unknown row inserted)', { world: makeWorld({ screen: (rows) => { const x = [...rows]; x.splice(17, 0, { chatId: 'fake', name: '完全陌生的聊天室' }); return x } }) }, { code: 'list_order_mismatch', stage: 'locate_row', activated: false, opened: false })
    await scenario('target_not_visible below (hint)', { world: makeWorld({ targetRank: 30 }) }, { code: 'target_not_visible', stage: 'locate_row', activated: false, check: (r) => (r.visibility && r.visibility.direction === 'below' && r.visibility.rows === 7 && /下方約 7 列/.test(r.message) ? null : JSON.stringify(r.visibility)) })
    await scenario('target_not_visible above (hint)', { world: makeWorld({ targetRank: 4 }) }, { code: 'target_not_visible', stage: 'locate_row', check: (r) => (r.visibility && r.visibility.direction === 'above' && r.visibility.rows === 9 ? null : JSON.stringify(r.visibility)) })
    await scenario('target_not_visible edge top (edgeSide)', { world: makeWorld({ targetRank: 13 }) }, { code: 'target_not_visible', stage: 'locate_row', check: (r) => (r.visibility && r.visibility.direction === 'edge' && r.visibility.edgeSide === 'top' && /上緣/.test(r.message) ? null : JSON.stringify(r.visibility)) })
    await scenario('target_not_visible edge bottom (edgeSide)', { world: makeWorld({ targetRank: 23 }) }, { code: 'target_not_visible', stage: 'locate_row', check: (r) => (r.visibility && r.visibility.edgeSide === 'bottom' && /下緣/.test(r.message) ? null : JSON.stringify(r.visibility)) })
    await scenario('row_unconfirmed (local veto)', { world: makeWorld({ names: [...NAMES.slice(0, 19), 'ab', 'abcdefgh', ...NAMES.slice(19, 58)] }), rowText: (j, c) => (j === 8 ? 'abcx' : c && c.name ? c.name : '') }, { code: 'row_unconfirmed', stage: 'locate_row', check: noClick })
    await scenario('row_identifies_other (reads a far duplicated name)', { world: makeWorld({ names: (() => { const n = NAMES.slice(0, 60); n[51] = n[50]; return n })() }), rowText: (j, c) => (j === 8 ? NAMES[50] : c && c.name ? c.name : '') }, { code: 'row_identifies_other', stage: 'locate_row', check: (r, h) => (r.otherChatName === NAMES[50] ? noClick(r, h) : 'otherChatName') })

    // ── S6 ──
    await scenario('user_busy at S6 → activated=false', { activateRefusal: 'user_busy' }, { code: 'user_busy', stage: 'activate_line', activated: false, opened: false, check: noClick })
    await scenario('line_activate_failed at S6 → activated=true', { foreground: false }, { code: 'line_activate_failed', stage: 'activate_line', activated: true, opened: false, check: noClick })
    await scenario('row_changed at S6 (geometry re-check) → activated=true', { geometryChanged: true }, { code: 'row_changed', stage: 'activate_line', activated: true, opened: false, check: (r, h) => (noClick(r, h) || (/沒有開啟任何聊天室（LINE 已被切到前景）。$/.test(r.message) ? null : 'tail')) })

    // ── S7 ──
    await scenario('row_changed at S7 (helper refusal) → activated=true', { clickRefusal: 'row_changed' }, { code: 'row_changed', stage: 'open_chat', activated: true, opened: false, left: 'none', check: noSetEdit })
    await scenario('occluded → activated=true, opened=false', { clickRefusal: 'occluded' }, { code: 'occluded', stage: 'open_chat', activated: true, opened: false, check: noSetEdit })
    await scenario('user_busy at S7 → activated=true', { clickRefusal: 'user_busy' }, { code: 'user_busy', stage: 'open_chat', activated: true, opened: false, check: noSetEdit })
    await scenario('timeout (title never stable)', { titleUnstable: true }, { code: 'timeout', stage: 'open_chat', activated: true, opened: true, check: noSetEdit })

    // ── S8 ──
    await scenario('click_missed (selected other row)', { selectedAfter: 9 }, { code: 'click_missed', stage: 'verify_open', activated: true, opened: true, left: 'none', check: (r, h) => noSetEdit(r, h) || (/請到 LINE 確認目前開啟的聊天室。已開啟一個聊天室（可能已變成已讀），但沒有填入草稿。$/.test(r.message) ? null : 'message/tail') })
    await scenario('click_missed (title hash unchanged after selection change)', { postTitleHash: 'title-before' }, { code: 'click_missed', stage: 'verify_open', opened: true, check: noSetEdit })
    await scenario('title_unreadable (reread once)', { postTitle: () => ({ ok: true, value: { byConfig: { T1: [], T2: [], T3: [] }, stripRect: { x: 0, y: 10, w: 600, h: 31 }, stripHash: 'title-after', blank: true } }) }, { code: 'title_unreadable', stage: 'verify_open', opened: true, check: (r, h) => (h.calls.filter((c) => c.cmd === 'readTitle').length === 3 ? noSetEdit(r, h) : 'readTitle count') })
    await scenario('title_unconfirmed', { postTitle: () => ({ ok: true, value: { byConfig: { T1: [ocrLine('完全無關的文字內容', 20)], T2: [], T3: [] }, stripRect: { x: 0, y: 10, w: 600, h: 31 }, stripHash: 'title-after', blank: false } }) }, { code: 'title_unconfirmed', stage: 'verify_open', opened: true, check: noSetEdit })
    await scenario('title_identifies_other (neighbour opened)', { postTitle: () => ({ ok: true, value: { byConfig: { T1: [ocrLine(NAMES[21], 20)], T2: [], T3: [] }, stripRect: { x: 0, y: 10, w: 600, h: 31 }, stripHash: 'title-after', blank: false } }) }, { code: 'title_identifies_other', stage: 'verify_open', opened: true, check: (r, h) => (r.otherChatName === NAMES[21] ? noSetEdit(r, h) : 'otherChatName') })
    await scenario('opened_other_suspected (C3 other_cleared)', { snapshot: (n, W) => ({ ok: true, value: snapshotOf(W.rows.map((r, i) => ({ ...r, unread: i === 33 && n < 3 ? 4 : 0 }))) }) }, { code: 'opened_other_suspected', stage: 'verify_open', opened: true, check: (r, h) => (r.otherChatName === NAMES[33] ? noSetEdit(r, h) : 'otherChatName') })
    await scenario('C3 off: same DB change does not stop (verifyReadByDb=false)', { verifyReadByDb: false, snapshot: (n, W) => ({ ok: true, value: snapshotOf(W.rows.map((r, i) => ({ ...r, unread: i === 33 && n < 3 ? 4 : 0 }))) }) }, { ok: true, row: 8, check: (r) => (r.open.dbAck === 'skipped' ? null : 'dbAck') })

    // ── S10 / S11 ──
    await scenario('draft_present (edit not empty)', { editValue: '使用者自己的字' }, { code: 'draft_present', stage: 'check_input_empty', opened: true, left: 'none', check: noSetEdit })
    await scenario('draft_present (helper refusal edit_not_empty)', { setEditRefusal: 'edit_not_empty' }, { code: 'draft_present', stage: 'fill', left: 'none' })
    await scenario('title_changed (helper refusal)', { setEditRefusal: 'title_changed' }, { code: 'title_changed', stage: 'fill', left: 'none', activated: true, opened: true })
    await scenario('user_busy at S11 → activated=true, opened=true', { setEditRefusal: 'user_busy' }, { code: 'user_busy', stage: 'fill', left: 'none', activated: true, opened: true })
    await scenario('fill_readback_mismatch, cleared → left none', { readback: '好的' }, { code: 'fill_readback_mismatch', stage: 'fill', left: 'none', check: (r, h) => (setOf(h).includes('clearEditIfEquals') ? null : 'no clear') })
    await scenario('fill_readback_mismatch, clear refused → left filled_in_identified', { readback: '好的', clearRefusal: true }, { code: 'fill_readback_mismatch', stage: 'fill', left: 'filled_in_identified' })
    await scenario('timeout during setEdit → left unknown', { setEditTimeout: true }, { code: 'timeout', stage: 'fill', left: 'unknown', opened: true })
    await scenario('timeout (whole operation, helper hangs) → dispose, no later calls', { readListHang: 400, wholeOperationMs: 100 }, {
      code: 'timeout',
      check: (r, h) => {
        const cmds = setOf(h)
        const iDisp = cmds.indexOf('dispose')
        if (iDisp < 0) return 'dispose not called'
        return null
      }
    })
    await scenario('timeout (whole operation while setEdit in flight) → left unknown', { setEditHang: 400, wholeOperationMs: 150 }, { code: 'timeout', stage: 'fill', left: 'unknown', opened: true })
    await scenario('internal (unexpected exception)', { readEditThrows: true }, { code: 'internal', stage: 'check_input_empty', opened: true, check: noSetEdit })

    // 逾時取消後，abandoned run 不得再呼叫任何 port（等 hang 結束再檢查）
    {
      const h = harness({ readListHang: 300, wholeOperationMs: 50 })
      const r = await h.svc.postDraft(REQ)
      await new Promise((res) => setTimeout(res, 500))
      const iDisp = h.calls.findIndex((c) => c.cmd === 'dispose')
      const later = h.calls.slice(iDisp + 1).map((c) => c.cmd)
      const ok = !r.ok && r.code === 'timeout' && iDisp >= 0 && later.length === 0
      results.push({ name: 'timeout-cancel: no port calls after dispose', ok })
      console.log(`[probe-sm] ${ok ? 'PASS' : 'FAIL'} timeout-cancel: no port calls after dispose → later=[${later.join(',')}]`)
    }

    // ── review F3：點擊已送出但沒有拿到結果 → 「可能已開啟」，不得說「沒有開啟任何聊天室」──
    const uncertain = (r) =>
      r.lineSideEffects.chatOpenUncertain === true && r.lineSideEffects.chatOpened === false && r.tail === m.CHAT_OPEN_UNCERTAIN_TAIL &&
      r.message.endsWith(m.CHAT_OPEN_UNCERTAIN_TAIL) && !/沒有開啟任何聊天室/.test(r.message) && !/沒有開啟任何聊天室/.test(r.tail)
        ? null
        : `fx=${JSON.stringify(r.lineSideEffects)} tail=${r.tail}`
    await scenario('FR-F3a port timeout during guardedClick → 可能已開啟（audit opened=?）', { clickThrows: () => new m.PortTimeoutError('guardedClick') }, { code: 'timeout', stage: 'open_chat', activated: true, opened: false, left: 'none', check: (r, h) => noSetEdit(r, h) || uncertain(r) || (h.logs.some((l) => / opened=\? /.test(l)) ? null : 'audit opened=? missing') })
    await scenario('FR-F3b whole-operation timeout while guardedClick in flight → 可能已開啟', { clickHang: 400, wholeOperationMs: 150 }, { code: 'timeout', stage: 'open_chat', activated: true, opened: false, check: (r, h) => noSetEdit(r, h) || uncertain(r) })
    await scenario('FR-F3c helper exited during guardedClick → host_unavailable, 可能已開啟', { clickThrows: () => new m.PortUnavailableError('helper_exited:exit') }, { code: 'host_unavailable', stage: 'open_chat', activated: true, opened: false, check: (r, h) => noSetEdit(r, h) || uncertain(r) })
    await scenario('FR-F3d helper refused the click (user_busy) → definitely not opened, no uncertain flag', { clickRefusal: 'user_busy' }, { code: 'user_busy', stage: 'open_chat', activated: true, opened: false, check: (r) => (r.lineSideEffects.chatOpenUncertain === undefined && r.tail === '沒有開啟任何聊天室（LINE 已被切到前景）。' ? null : 'tail ' + r.tail) })
    await scenario('FR-F3e click ok, then title unstable → chatOpened=true, no uncertain flag', { titleUnstable: true }, { code: 'timeout', stage: 'open_chat', opened: true, check: (r) => (r.lineSideEffects.chatOpenUncertain === undefined && r.tail === '已開啟一個聊天室（可能已變成已讀），但沒有填入草稿。' ? null : 'tail ' + r.tail) })
    await scenario('FR-F3f timeout before the click is sent (readList hang) → no uncertain flag', { readListHang: 400, wholeOperationMs: 100 }, { code: 'timeout', opened: false, check: (r) => (r.lineSideEffects.chatOpenUncertain === undefined ? null : 'flag set before click') })

    // ── review F1：focusLine 時 helper 守門不通過（user_busy）──
    {
      const run = async (o) => {
        const h = harness(o)
        const r = await h.svc.postDraft(REQ)
        const f = await h.svc.focusLine(r.ok ? r.attemptId : '-')
        return { h, r, f, fe: h.calls.filter((c) => c.cmd === 'focusEdit') }
      }
      const a = await run({ focusRefusal: 'user_busy' })
      const b = await run({ focusRefusal: 'user_busy', focusDetail: 'late' })
      const cOpts = {}
      const c = await run(cOpts)
      const retry = await (async () => {
        const o = { focusRefusal: 'user_busy' }
        const h = harness(o)
        const r = await h.svc.postDraft(REQ)
        const f1 = await h.svc.focusLine(r.attemptId)
        delete o.focusRefusal
        const f2 = await h.svc.focusLine(r.attemptId)
        return { f1, f2, h, r }
      })()
      const busyMsg = m.followUpMessage('focusLine', { code: 'user_busy' }, '任何名稱')
      const cases = [
        ['FR-F1a focusLine: helper user_busy (not switched) → code user_busy, activated=false, message = FOCUS_USER_BUSY_NOTE',
          a.r.ok && !a.f.ok && a.f.code === 'user_busy' && a.f.activated === false && a.f.message === m.FOCUS_USER_BUSY_NOTE && busyMsg === m.FOCUS_USER_BUSY_NOTE && a.fe.length === 1,
          JSON.stringify(a.f)],
        ['FR-F1b focusLine: helper user_busy detail=late → activated=true (LINE switched, caret not placed)',
          b.r.ok && !b.f.ok && b.f.code === 'user_busy' && b.f.activated === true, JSON.stringify(b.f)],
        ['FR-F1c focusEdit always carries Q_focus {500, 3000, requireNoKeysDown}; invariants hold',
          c.r.ok && c.f.ok && c.fe.length === 1 && [a, b, c].every((x) => invariants(x.h, x.r).length === 0),
          JSON.stringify(c.fe[0] && c.fe[0].args.quiet)],
        ['FR-F1d after user_busy the attempt stays valid: releasing keys and pressing again → focused',
          retry.r.ok && !retry.f1.ok && retry.f1.code === 'user_busy' && retry.f2.ok && retry.f2.outcome === 'focused', `${JSON.stringify(retry.f1.code)} → ${JSON.stringify(retry.f2.ok && retry.f2.outcome)}`],
        ['FR-F1e follow-up log line has no CJK', [a, b, c, retry].every((x) => x.h.logs.every((l) => !/[一-鿿]/.test(l))) && a.h.logs.some((l) => /action=focusLine result=user_busy/.test(l))]
      ]
      for (const [name, ok, info] of cases) { results.push({ name, ok: !!ok }); console.log(`[probe-sm] ${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' :: ' + info}`) }
    }

    // ── 訊息文案（ui-prototype-notes §5 #2、#5、#6、#7；使用者核可）──
    {
      const h1 = harness({ world: makeWorld({ targetRank: 30 }) })
      const r1 = await h1.svc.postDraft(REQ)
      const h2 = harness({})
      const r2 = await h2.svc.postDraft({ ...REQ, mode: 'fillAndSend' })
      const h3 = harness({ setEditTimeout: true })
      const r3 = await h3.svc.postDraft(REQ)
      const h4 = harness({ world: makeWorld({ targetRank: 30 }) })
      const r4 = await h4.svc.postDraft(REQ)
      const msgs = [
        ['#2 target_not_visible asks to press 「填入 LINE」 again', !r1.ok && /再按一次「填入 LINE」。沒有開啟任何聊天室，LINE 也沒有被切到前景。$/.test(r1.message)],
        ['#7 preflight failure has no tail sentence', !r2.ok && r2.message === '自動送出目前還沒開放。請使用「填入 LINE」，再自己在 LINE 按 Enter。'],
        ['#6 draftLeftInLine=unknown tail', !r3.ok && r3.draftLeftInLine === 'unknown' && /無法確認草稿是否已填入。請到 LINE 檢查「[^」]+」的輸入框，確認內容後再決定要不要送出。$/.test(r3.message)],
        ['audit log has no CJK / names', [h1, h2, h3, h4].every((h) => h.logs.every((l) => !/[一-鿿]/.test(l)))]
      ]
      for (const [name, ok] of msgs) { results.push({ name: 'msg ' + name, ok: !!ok }); console.log(`[probe-sm] ${ok ? 'PASS' : 'FAIL'} msg ${name}`) }
    }

    // ── 覆蓋率 ──
    const missing = ALL_CODES.filter((c) => !seen.has(c))
    const cover = missing.length === 0
    results.push({ name: 'every DriverPostErrorCode has ≥1 scenario', ok: cover })
    console.log(`[probe-sm] ${cover ? 'PASS' : 'FAIL'} error-code coverage ${ALL_CODES.length - missing.length}/${ALL_CODES.length}${missing.length ? ' missing=' + missing.join(',') : ''}`)

    const failed = results.filter((r) => !r.ok)
    console.log(`[probe-sm] ${results.length - failed.length}/${results.length} passed`)
    return failed.length === 0 ? 0 : 1
  } catch (err) {
    console.error('[probe-sm] ERROR', err && err.stack ? err.stack : err)
    return 1
  } finally {
    cleanup()
  }
}

if (app && app.whenReady) app.whenReady().then(() => main()).then((c) => app.exit(c))
else main().then((c) => process.exit(c))
