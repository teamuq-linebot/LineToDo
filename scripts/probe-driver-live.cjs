// probe-driver-live —— driver_post Batch 5 實機驗證（design-v3 §9.3 0c-C；M8、M13–M16b、M23、M24、M26、M27）。
//
// ⚠ 這支會碰 LINE（啟動 helper、UIA、PrintWindow＋記憶體內 OCR、讀 LINE 本機 DB 的唯讀複本；happy 會點擊並填入 Keep筆記）。
//    2026-09-30 使用者裁定「不做實機測試」：本檔依設計寫好，**不得執行**。要執行需要使用者另外授權，並同時滿足：
//      1. 環境變數 LINE_TODO_DRIVER_TEST_ALLOW=Keep筆記（只允許 Keep筆記＝_profile._mid）
//      2. 命令列帶 --confirm-live
//    缺任何一項就直接結束（exit 3），不 import 任何碰 LINE 的模組。
//
// 規則（design-v3 §10 開發期強制規定）：只開 Keep筆記；送出 0 則；不寫搜尋框、不捲動；輸出只有計數、錯誤碼、名次與列號，
// 不印任何聊天室名稱（Keep筆記 除外）、OCR 原文或草稿。
//
// 用法：npx electron scripts/probe-driver-live.cjs --confirm-live --scenario <name> [--repeat N] [--tamper 1..4]
//   locate-only   C-1：只定位不點擊（S6 之前攔下），印出位移、列號、路徑、錨點數；--repeat 5
//   happy         C-2：完整流程（點 Keep → C1–C3 → 填入 → 讀回 → clearFilled）；--repeat 3
//   db-tamper     C-3：在記憶體竄改 DB 快照後只定位不點擊；--tamper 1 對調 2 上方插入 3 刪除一筆 4 假 chatId
//   guard-dryrun  C-4：guardedClick dryRun，竄改一個非目標列的 hash → 必須 row_changed、沒有點擊
//   title-other   C-5：Keep 已開著，目標改成假聊天室（局部集合含 Keep筆記）→ title_identifies_other／title_unconfirmed，沒有 setEdit
//   not-visible   C-6：請使用者先把列表捲到看不到 Keep → target_not_visible（方向），LINE 沒有被切到前景
//   search-active C-7：請使用者先在 LINE 搜尋框打一個字 → line_search_active，搜尋框內容不變
//   follow-guard  M23：happy 後把記憶體中的 approvedTitleHash 換成假值 → focusLine 只切前景並回 title_changed、clearFilled 被拒

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const SELF = 'Keep筆記'
const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def }
const allow = (process.env.LINE_TODO_DRIVER_TEST_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean)
if (!process.argv.includes('--confirm-live') || allow.length !== 1 || allow[0] !== SELF) {
  console.error('[probe-live] refused: needs --confirm-live and LINE_TODO_DRIVER_TEST_ALLOW=Keep筆記 (user decided on 2026-09-30: no live test).')
  process.exit(3)
}

const esbuild = require('esbuild')
const { app } = require('electron')

const ENTRY = `
export { createDriver } from './src/main/driver/index.ts'
export { createPsHost } from './src/main/driver/psHost.ts'
export { createLineOrder } from './src/main/driver/lineOrder.ts'
export { allowSetForeground } from './src/main/driver/foreground.ts'
export { orderRStar, SELF_CHAT_NAME } from './src/main/driver/order.ts'
export { indexOrder, locateTarget, judgeOpen, LOCATE_RULES } from './src/main/driver/locate.ts'
export { rowReadings, titleReadings } from './src/main/driver/identify.ts'
export { ROW_CONFIGS, TITLE_CONFIGS, QUIET } from './src/main/driver/port.ts'
`

function tempCounts() {
  const tmp = process.env.TEMP || os.tmpdir()
  const userData = path.join(process.env.APPDATA || '', 'line-todo')
  const count = (dir, re) => { try { return fs.readdirSync(dir).filter((n) => re.test(n)).length } catch (_) { return -1 } }
  return { lineTmp: count(tmp, /^(linedb-|linekey-scan-)/), tmpImg: count(tmp, /\.(png|bmp)$/i), userImg: count(userData, /\.(png|bmp)$/i) }
}

async function main() {
  const root = path.join(__dirname, '..')
  const entryFile = path.join(root, '__probe_live_entry.ts')
  const outFile = path.join(root, '__probe_live.bundle.cjs')
  const cleanup = () => { for (const f of [entryFile, outFile]) { try { fs.rmSync(f, { force: true }) } catch (_) {} } }
  const scenario = arg('--scenario', 'locate-only')
  const repeat = Math.max(1, Number(arg('--repeat', '1')) || 1)
  const before = tempCounts()
  const results = []
  const check = (name, ok, info = '') => { results.push({ name, ok: !!ok }); console.log(`[probe-live] ${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`) }
  let ui = null
  try {
    fs.writeFileSync(entryFile, ENTRY, 'utf8')
    await esbuild.build({ entryPoints: [entryFile], bundle: true, platform: 'node', format: 'cjs', outfile: outFile, absWorkingDir: root, logLevel: 'silent', external: ['electron', 'koffi', 'better-sqlite3', 'better-sqlite3-multiple-ciphers'] })
    const m = require(outFile)
    const lo = m.createLineOrder({ cacheFile: path.join(process.env.APPDATA || '', 'line-todo', '.linekey') })
    const s0 = await lo.snapshot()
    if (!s0.ok || !s0.value.selfMid) { console.log(`[probe-live] ABORT lineOrder=${s0.ok ? 'no_self_mid' : s0.code}`); return 2 }
    const selfMid = s0.value.selfMid

    // ── DB 快照竄改（C-3；A、B 同樣竄改，讓 L8 通過、由定位規則判斷）──
    const tamper = Number(arg('--tamper', '0'))
    const FAKE = 'zz-probe-fake'
    const tamperRows = (rows) => {
      if (!tamper) return rows
      const rs = m.orderRStar(rows)
      const k = rs.findIndex((r) => r.chatId === selfMid)
      const byId = new Map(rows.map((r) => [r.chatId, r]))
      const self = byId.get(selfMid)
      const nb = rs[k - 1] && byId.get(rs[k - 1].chatId)
      if (!self || !nb) return rows
      const out = rows.map((r) => ({ ...r }))
      const at = (id) => out.find((r) => r.chatId === id)
      if (tamper === 1) { const a = at(selfMid), b = at(nb.chatId); const t = a.lastUpdated; a.lastUpdated = b.lastUpdated; b.lastUpdated = t }
      if (tamper === 2) out.push({ ...self, chatId: FAKE + '-above', name: 'ZZ測試不存在聊天室', lastUpdated: self.lastUpdated + 1, unread: 0 })
      if (tamper === 3) { const del = rs[k - 2]; if (del) return out.filter((r) => r.chatId !== del.chatId) }
      if (tamper === 4) out.push({ ...self, chatId: FAKE, name: 'ZZ測試不存在聊天室', lastUpdated: self.lastUpdated + 1, unread: 0 })
      return out
    }
    const order = { snapshot: async () => { const r = await lo.snapshot(); return r.ok ? { ok: true, value: { ...r.value, rows: tamperRows(r.value.rows) } } : r } }

    // ── UI port：真實 helper，外面包一層紀錄（locate-only 在 S6 之前攔下）──
    const scriptPath = path.join(root, 'resources', 'line-driver', 'line-uia-host.ps1')
    ui = m.createPsHost({ scriptPath, allowSetForeground: m.allowSetForeground, log: () => {} })
    const calls = []
    const locateOnly = ['locate-only', 'db-tamper', 'not-visible', 'search-active'].includes(scenario)
    const wrapped = new Proxy(ui, {
      get(target, prop) {
        const v = target[prop]
        if (typeof v !== 'function') return v
        return (...a) => {
          calls.push(String(prop))
          if (locateOnly && prop === 'activateLine' && !(a[0] && a[0].restore)) return Promise.reject(new Error('probe_stop_before_activate'))
          if (locateOnly && (prop === 'guardedClick' || prop === 'setEdit' || prop === 'focusEdit' || prop === 'clearEditIfEquals')) return Promise.reject(new Error('probe_forbidden_' + String(prop)))
          return v.apply(target, a)
        }
      }
    })
    const logs = []
    const target = tamper === 4 ? FAKE : selfMid
    const driver = m.createDriver({
      getSettings: () => ({ enabled: true, mode: 'fillOnly', verifyReadByDb: true }),
      getTodo: (id) => (id === 'probe-keep' ? { chatId: target } : null),
      getChatName: () => SELF,
      lineTodoHwnd: () => null,
      log: (l) => logs.push(l),
      ui: wrapped,
      order
    })
    const audit = () => { const l = logs.filter((x) => x.startsWith('[driver] attempt=')).pop() || ''; const g = (k) => (l.match(new RegExp(k + '=([^ ]+)')) || [])[1]; return { result: g('result'), stage: g('stage'), off: g('off'), row: g('row'), path: g('path'), anchors: g('anchors'), rank: g('rank'), dbMs: g('dbMs'), ms: g('ms') } }
    const TEXT = '（probe 測試文字，會自動清除）'
    const post = async () => { await new Promise((r) => setTimeout(r, 3100)); return driver.postDraft({ todoId: 'probe-keep', text: TEXT }) }

    if (scenario === 'locate-only' || scenario === 'not-visible' || scenario === 'db-tamper') {
      const seen = []
      for (let i = 0; i < repeat; i++) {
        calls.length = 0
        const r = await post()
        const a = audit()
        seen.push(a)
        console.log(`[probe-live] run ${i + 1}: result=${a.result} stage=${a.stage} rank=${a.rank} off=${a.off} row=${a.row} path=${a.path} anchors=${a.anchors} dbMs=${a.dbMs} ms=${a.ms}`)
        const noFg = !calls.includes('guardedClick') && !calls.includes('setEdit')
        if (scenario === 'locate-only') check(`C-1 run ${i + 1}: located, stopped before S6, no click/write`, !r.ok && a.stage === 'activate_line' && a.result === 'internal' && noFg)
        if (scenario === 'not-visible') check(`C-6 run ${i + 1}: target_not_visible (${r.visibility && r.visibility.direction}), no activate/click`, !r.ok && r.code === 'target_not_visible' && noFg && !calls.includes('activateLine'))
        if (scenario === 'db-tamper') check(`C-3 tamper ${tamper}: stopped before click (${r.ok ? 'ok' : r.code})`, !r.ok && ['list_order_mismatch', 'row_unconfirmed', 'row_identifies_other'].includes(r.code) && noFg)
      }
      if (scenario === 'locate-only' && seen.length > 1) check('C-1 all runs same offset and row', seen.every((s) => s.off === seen[0].off && s.row === seen[0].row))
    } else if (scenario === 'search-active') {
      const s1 = await ui.readSearch()
      const r = await post()
      const s2 = await ui.readSearch()
      check('C-7 line_search_active; search box unchanged; no activate/click', !r.ok && r.code === 'line_search_active' && s1 === s2 && s1 !== '' && !calls.includes('activateLine'), `len=${s1.length}`)
    } else if (scenario === 'happy' || scenario === 'follow-guard') {
      for (let i = 0; i < repeat; i++) {
        const r = await post()
        const a = audit()
        console.log(`[probe-live] run ${i + 1}: result=${a.result} rank=${a.rank} off=${a.off} row=${a.row} path=${a.path} anchors=${a.anchors} dbMs=${a.dbMs} ms=${a.ms}`)
        check(`C-2 run ${i + 1}: filled, selection matched, dbAck not other_cleared`, r.ok && r.open.selectionMatched && r.open.dbAck !== 'other_cleared' && r.open.titlePass >= 1, r.ok ? `dbAck=${r.open.dbAck} titlePass=${r.open.titlePass}` : r.code)
        if (!r.ok) continue
        if (scenario === 'follow-guard') {
          // M23：把記憶體中的 approvedTitleHash 換成假值（不切換到其他聊天室）
          const rec = driver.takeFollowUp(r.attemptId)
          const real = rec ? rec.approvedTitleHash : null
          if (rec) rec.approvedTitleHash = 'fake-hash'
          const f = await driver.focusLine(r.attemptId)
          const c = await driver.clearFilled(r.attemptId)
          check('M23 fake approvedTitleHash: focusLine → title_changed, clearFilled refused', !!rec && !f.ok && f.code === 'title_changed' && !c.ok, `${f.ok ? 'ok' : f.code} / ${c.ok ? 'ok' : c.code}`)
          if (rec) rec.approvedTitleHash = real
        }
        const c = await driver.clearFilled(r.attemptId)
        const e = await ui.readEdit()
        check(`C-2 run ${i + 1}: clearFilled → cleared, input empty`, c.ok && c.outcome === 'cleared' && e.ok && e.value.value === '', c.ok ? '' : c.code)
      }
    } else if (scenario === 'guard-dryrun') {
      await ui.hello(); await ui.beginSession()
      const list = await ui.readList({ configs: m.ROW_CONFIGS })
      if (!list.ok) { check('C-4 readList', false, list.refusal); return 1 }
      const full = list.value.rows.filter((r) => r.rect.h > 0 && r.visibleH >= m.LOCATE_RULES.fullyVisible * r.rect.h)
      const t = full[Math.floor(full.length / 2)]
      const windowRows = full.map((r) => ({ index: r.index, rect: r.rect, hash: r.index === full[0].index ? 'tampered' : r.hash }))
      const g = await ui.guardedClick({ row: { index: t.index, rect: t.rect, hash: t.hash }, windowRows, quiet: m.QUIET.click, dryRun: true })
      check('C-4 dryRun with tampered non-target hash → row_changed, no click', !g.ok && g.refusal === 'row_changed', g.ok ? 'ok?' : g.refusal)
      await ui.endSession()
    } else if (scenario === 'title-other') {
      await ui.hello(); await ui.beginSession()
      const list = await ui.readList({ configs: m.ROW_CONFIGS })
      const sel = list.ok ? list.value.rows.find((r) => r.selected === true) : null
      const t = await ui.readTitle({ configs: m.TITLE_CONFIGS })
      const snap = await lo.snapshot()
      if (!sel || !t.ok || !snap.ok) { check('C-5 inputs', false); return 1 }
      const rows = snap.value.rows.concat([{ ...snap.value.rows.find((r) => r.chatId === selfMid), chatId: 'zz-title-fake', name: 'ZZ測試不存在聊天室' }])
      const rs = m.orderRStar(rows)
      const k = rs.findIndex((r) => r.chatId === 'zz-title-fake')
      const j = m.judgeOpen({ targetRow: sel.index, offset: k - sel.index, targetChatId: 'zz-title-fake', selectedBefore: sel.index, selectedAfter: sel.index, titleHashBefore: t.value.stripHash, titleHashAfter: t.value.stripHash, title: m.titleReadings(t.value.byConfig, t.value.stripRect, m.TITLE_CONFIGS), order: rs, idx: m.indexOrder(rs) })
      check('C-5 fake target with Keep open → title_identifies_other/title_unconfirmed; setEdit never called', !j.ok && ['title_identifies_other', 'title_unconfirmed'].includes(j.code) && !calls.includes('setEdit'), j.ok ? 'ok?' : j.code)
      await ui.endSession()
    } else {
      console.error('[probe-live] unknown --scenario ' + scenario)
      return 2
    }

    const after = tempCounts()
    check('M26 %TEMP% linedb-*/linekey-scan-* unchanged', after.lineTmp === before.lineTmp, `${before.lineTmp}→${after.lineTmp}`)
    check('M5 png/bmp count unchanged in %TEMP% and userData', after.tmpImg === before.tmpImg && after.userImg === before.userImg, `${before.tmpImg}→${after.tmpImg}, ${before.userImg}→${after.userImg}`)
    check('M24 audit log lines have no CJK (names never logged)', logs.every((l) => !/[一-鿿]/.test(l)))
    const failed = results.filter((r) => !r.ok)
    console.log(`[probe-live] ${results.length - failed.length}/${results.length} passed`)
    return failed.length === 0 ? 0 : 1
  } catch (err) {
    console.error('[probe-live] ERROR', err && err.message ? err.message : err)
    return 1
  } finally {
    try { ui && (await ui.dispose()) } catch (_) {}
    cleanup()
  }
}

app.whenReady().then(() => main()).then((c) => app.exit(c))
