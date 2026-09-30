// probe-locate —— design-v3 Batch 1 驗收 M3c：定位規則 L1–L8 與開啟後確認 C1–C3（design-v3 §3、§4）。
//
// 用 production 的 src/main/driver/{order,locate,identify}.ts（esbuild 打包）。全部是合成資料，不碰 LINE。
// 畫面模型：螢幕第 0 列部分可見，第 1–11 列完整可見（同 0c-A 的觀察）；螢幕第 j 列顯示「畫面清單」的第 s+j 名。
// 「畫面清單」預設等於 DB 的 R*；各案例在畫面清單上做插入、刪除、對調等擾動（DB 不變）。
//
// 執行：npx electron scripts/probe-locate.cjs（exit 0 = 18/18 案例 PASS）

const path = require('node:path')
const fs = require('node:fs')
const esbuild = require('esbuild')

let app = null
try { app = require('electron').app } catch { app = null }

const ENTRY = `
export * from './src/main/driver/order.ts'
export * from './src/main/driver/locate.ts'
export { readingVariants, normalizeName, lev, titleReadings } from './src/main/driver/identify.ts'
`

// ── 合成名稱：固定 seed，名稱兩兩距離 ≥ 3（確保完美讀取都能成為錨點）──
let seed = 20260929 >>> 0
const rnd = () => { // mulberry32
  seed = (seed + 0x6d2b79f5) >>> 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const POOL = '春夏秋冬東南西北山川河海林森花草木石金銀銅鐵天地日月星雲風雨雪霜紅橙黃綠藍紫白黑晴陰光影龍虎鳳龜鶴鹿馬牛羊雞犬貓'.split('')
function lev(a, b) {
  const A = [...a], B = [...b]
  let prev = Array.from({ length: B.length + 1 }, (_, j) => j)
  for (let i = 1; i <= A.length; i++) {
    const cur = [i]
    for (let j = 1; j <= B.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[B.length]
}
function makeNames(n) {
  const out = []
  while (out.length < n) {
    const len = 4 + Math.floor(rnd() * 3)
    const s = Array.from({ length: len }, () => POOL[Math.floor(rnd() * POOL.length)]).join('')
    if (out.every((x) => lev(x, s) >= 3)) out.push(s)
  }
  return out
}

function line(text) {
  let x = 10
  const words = [...String(text)].filter((c) => c.trim()).map((c) => { const w = { text: c, rect: { x, y: 100, w: 12, h: 15 } }; x += 14; return w })
  return { text: words.map((w) => w.text).join(' '), rect: { x: 10, y: 100, w: Math.max(1, x - 12), h: 15 }, words }
}

async function main() {
  const root = path.join(__dirname, '..')
  const entryFile = path.join(root, '__probe_locate_entry.ts')
  const outFile = path.join(root, '__probe_locate.bundle.cjs')
  const cleanup = () => { for (const f of [entryFile, outFile]) { try { fs.rmSync(f, { force: true }) } catch (_) {} } }
  const cases = []
  const sub = []
  const check = (name, cond, detail = '') => { sub.push({ name, ok: !!cond }); console.log(`[probe-locate]   ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' ' + detail : ''}`); return !!cond }
  const kase = (name, fn) => {
    console.log(`[probe-locate] ── ${name}`)
    const before = sub.length
    try { fn() } catch (e) { check('threw', false, String(e && e.stack || e)) }
    const ok = sub.slice(before).every((r) => r.ok) && sub.length > before
    cases.push({ name, ok })
    console.log(`[probe-locate] ${ok ? 'PASS' : 'FAIL'} ${name}`)
  }
  try {
    fs.writeFileSync(entryFile, ENTRY, 'utf8')
    await esbuild.build({ entryPoints: [entryFile], bundle: true, platform: 'node', format: 'cjs', outfile: outFile, absWorkingDir: root, logLevel: 'silent' })
    const m = require(outFile)
    const T0 = 1_900_000_000_000
    const NAMES = makeNames(80)
    const mkOrder = (names, opt = {}) => names.map((name, i) => ({ chatId: 'c' + String(i).padStart(3, '0'), lastUpdated: T0 - i * 1000 - (opt.timeOf ? opt.timeOf(i) : 0), pinned: false, hidden: false, unread: 0, midType: 0, status: 1, name }))
    const perfect = (name) => { const v = m.readingVariants(line(name)); return [v, v, v] }
    const empty = () => [[], [], []]
    /** 畫面：螢幕第 1..11 列完整可見，第 j 列顯示 list[s+j]；readable 決定哪些列有完美讀取（其他列讀取為空）。 */
    const screen = (list, s, readable, override = {}) => {
      const rows = []
      for (let j = 1; j <= 11; j++) {
        const c = list[s + j]
        if (override[j]) rows.push({ index: j, readings: override[j] })
        else rows.push({ index: j, readings: c && c.name && readable.has(j) ? perfect(c.name) : empty() })
      }
      return rows
    }
    const OBS = new Set([1, 4, 5, 7, 9, 10]) // 0c-A 的錨點列號
    const ALL = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    const loc = (rows, order, id) => m.locateTarget(rows, order, id)
    const desc = (r) => (r.ok ? `ok path=${r.path} row=${r.row} off=${r.offset} anchors=${r.anchors.length}` : `code=${r.code}${r.visibility ? ' vis=' + JSON.stringify(r.visibility) : ''}${r.offset !== undefined ? ' off=' + r.offset : ''}`)

    const P = mkOrder(NAMES)

    kase('① 位移 12、6 錨點（重現 0c-A 結構）；B 路徑（G2 收緊後要求 r±1、r±2 都是錨點）', () => {
      const k = 12 + 8
      const rows = screen(P, 12, OBS)
      const r = loc(rows, P, P[k].chatId)
      // 0c-A 的 B 列（r±1 是錨點、r−2 不是）：收緊前會走 B，收緊後停止（fail-closed，只影響可用性）
      check('0c-A structure: offset 12 from 6 anchors; row 8 (only r±1 anchors) → row_unconfirmed after tightening', !r.ok && r.code === 'row_unconfirmed' && r.offset === 12 && r.anchors === 6, desc(r))
      const rb = loc(screen(P, 12, new Set([1, 4, 5, 6, 7, 9, 10])), P, P[k].chatId)
      check('r±1 and r±2 anchors, target row unreadable → path B row 8 offset 12', rb.ok && rb.path === 'B' && rb.row === 8 && rb.offset === 12 && rb.anchors.length === 7, desc(rb))
    })
    kase('② T 路徑', () => {
      const r = loc(screen(P, 12, OBS), P, P[12 + 5].chatId)
      check('ok path T row 5', r.ok && r.path === 'T' && r.row === 5, desc(r))
    })
    kase('③ 目標在邊緣 → target_not_visible(edge)', () => {
      const top = loc(screen(P, 12, OBS), P, P[12 + 1].chatId)
      check('first full row → edge/top', !top.ok && top.code === 'target_not_visible' && top.visibility.direction === 'edge' && top.visibility.edgeSide === 'top', desc(top))
      const bottom = loc(screen(P, 12, ALL), P, P[12 + 11].chatId)
      check('last full row → edge/bottom', !bottom.ok && bottom.code === 'target_not_visible' && bottom.visibility.direction === 'edge' && bottom.visibility.edgeSide === 'bottom', desc(bottom))
      const oneSide = loc(screen(P, 12, new Set([1, 2, 3, 5])), P, P[12 + 8].chatId)
      check('no anchor below target → edge/bottom', !oneSide.ok && oneSide.code === 'target_not_visible' && oneSide.visibility.direction === 'edge', desc(oneSide))
    })
    kase('④ 錨點 2 個 → list_unrecognized', () => {
      const r = loc(screen(P, 12, new Set([2, 9])), P, P[12 + 5].chatId)
      check('list_unrecognized', !r.ok && r.code === 'list_unrecognized', desc(r))
    })
    kase('⑤ 錨點之間插入一列 → list_order_mismatch', () => {
      const S = [...P]; S.splice(12 + 6, 0, { chatId: 'fake', name: '未知聊天室甲' })
      const r = loc(screen(S, 12, OBS), P, P[12 + 8].chatId)
      check('list_order_mismatch', !r.ok && r.code === 'list_order_mismatch', desc(r))
    })
    kase('⑥ 目標位置插入同名未知列 → 停止（§3.3 回歸）', () => {
      for (const k of [12 + 5, 12 + 8]) {
        for (const at of [k, k + 1]) {
          const S = [...P]; S.splice(at, 0, { chatId: 'twin', name: P[k].name })
          const r = loc(screen(S, 12, ALL), P, P[k].chatId)
          const clickedChat = r.ok ? S[12 + r.row] : null
          check(`k=${k} twin at ${at === k ? 'target' : 'target+1'} → stop`, !r.ok, desc(r) + (clickedChat ? ' WOULD-CLICK=' + clickedChat.chatId : ''))
        }
      }
    })
    kase('⑦ 目標和鄰居對調 → 停止', () => {
      for (const d of [-1, 1]) {
        const k = 12 + 6
        const S = [...P]; [S[k], S[k + d]] = [S[k + d], S[k]]
        const r = loc(screen(S, 12, ALL), P, P[k].chatId)
        check(`swap with ${d > 0 ? 'k+1' : 'k-1'} → stop`, !r.ok, desc(r))
      }
    })
    kase('⑧ 目標名次在可見範圍外 → 方向和列數正確', () => {
      const below = loc(screen(P, 12, OBS), P, P[12 + 15].chatId)
      check('below 4', !below.ok && below.code === 'target_not_visible' && below.visibility.direction === 'below' && below.visibility.rows === 4, desc(below))
      const above = loc(screen(P, 12, OBS), P, P[5].chatId)
      check('above 8', !above.ok && above.code === 'target_not_visible' && above.visibility.direction === 'above' && above.visibility.rows === 8, desc(above))
    })
    kase('⑨ 局部否決 → row_unconfirmed', () => {
      // 目標「abcdefgh」、鄰居「ab」：讀取「abcx」離鄰居 2（< 目標 5），但不在鄰居的 maxErr(2)=0 內（不觸發全域否決）
      const names = [...NAMES.slice(0, 19), 'ab', 'abcdefgh', ...NAMES.slice(19, 40)]
      const O = mkOrder(names)
      const k = 20
      const rows = screen(O, 12, new Set([1, 4, 5, 7, 9, 10]), { 8: [m.readingVariants(line('abcx')), [], []] })
      const r = loc(rows, O, O[k].chatId)
      check('row_unconfirmed', !r.ok && r.code === 'row_unconfirmed', desc(r))
    })
    kase('⑩ 全域否決 → row_identifies_other', () => {
      // 目標列清楚讀到遠處的聊天室。若那個名稱唯一，該列本身會成為位移不一致的錨點（L3 先停止）；
      // 這裡讓遠處名稱重複（名次 60、61 同名，不能當錨點），專測 L5。
      const base = [...NAMES.slice(0, 70)]
      base[61] = base[60]
      const O = mkOrder(base)
      const k = 12 + 8
      const rows = screen(O, 12, OBS, { 8: perfect(O[60].name) })
      const r = loc(rows, O, O[k].chatId)
      check('row_identifies_other with the far chat', !r.ok && r.code === 'row_identifies_other' && r.otherChatId === O[60].chatId, desc(r))
      const unique = loc(screen(P, 12, OBS, { 8: perfect(P[60].name) }), P, P[k].chatId)
      check('unique far name on target row → stops earlier (list_order_mismatch)', !unique.ok && unique.code === 'list_order_mismatch', desc(unique))
      // L1 收緊（盤點補做）：同一列一組有把握地讀到非 uniq 名稱、另一組讀到 uniq 名稱 → 衝突列，不是錨點
      const pv = (name) => m.readingVariants(line(name))
      const mixed = screen(O, 12, OBS, { 4: [pv(O[16].name), pv(O[60].name), []] })
      const fa = m.findAnchors(mixed, m.indexOrder(O))
      check('L1 tightened: uniq vote + confident non-uniq reading → conflict row (no anchor)', fa.conflictRows.has(4) && !fa.anchors.some((a) => a.row === 4), `conflict=${[...fa.conflictRows].join(',')} anchors=${fa.anchors.map((a) => a.row).join(',')}`)
      // L7：目標列是衝突列 → 停止。衝突列必有一組讀取有把握地指向目標以外的名稱，所以 L5 會先以
      // row_identifies_other 停止；L7 是兜底（兩者都在點擊前停止）。r±1 都是錨點（B 路徑條件成立）也不能通過。
      const conflictTarget = screen(O, 12, new Set([1, 4, 5, 7, 9, 10]), { 8: [pv(O[20].name), pv(O[45].name), []] })
      const r7 = loc(conflictTarget, O, O[20].chatId)
      check('L7 target row is a conflict row → stop even though r±1 are anchors', !r7.ok && (r7.code === 'row_identifies_other' || r7.code === 'row_unconfirmed'), desc(r7))
    })
    kase('⑪ ±2 內有 null 名稱：非 T/B 路徑 → 停止', () => {
      // 目標名稱在遠處重複（不能當錨點，排除 T）；r±1 讀取為空（排除 B）；目標列完美讀取（A 條件）。
      const base = [...NAMES.slice(0, 60)]
      base[70 - 10] = base[20] // 名次 60 和目標同名
      const withNull = mkOrder(base).map((r, i) => (i === 21 ? { ...r, name: null } : r))
      const rowsOf = (O) => screen(O, 12, new Set([1, 4, 5, 10, 11]), { 8: perfect(O[20].name) })
      const r1 = loc(rowsOf(withNull), withNull, withNull[20].chatId)
      check('null neighbour → row_unconfirmed', !r1.ok && r1.code === 'row_unconfirmed', desc(r1))
      const ctrl = mkOrder(base)
      const r2 = loc(rowsOf(ctrl), ctrl, ctrl[20].chatId)
      check('control (no null) → path A', r2.ok && r2.path === 'A' && r2.row === 8, desc(r2))
    })
    kase('⑫ 遠處同名 → 不受影響', () => {
      const base = [...NAMES.slice(0, 60)]
      base[55] = base[20]
      const O = mkOrder(base)
      const r = loc(screen(O, 12, OBS, { 8: perfect(O[20].name) }), O, O[20].chatId)
      check('ok on the right row (A/B), not T (name not unique)', r.ok && r.row === 8 && r.path !== 'T', desc(r))
    })
    kase('⑬ 可見範圍跨越釘選邊界 → 正確；改用釘選時間排序 → list_order_mismatch', () => {
      // 19 個釘選：釘選時間與訊息時間無關。R* = 釘選依訊息時間 ++ 其餘依訊息時間。
      const raws = NAMES.slice(0, 60).map((name, i) => ({ _id: 'p' + String(i).padStart(3, '0'), _lastUpdatedTime: T0 - ((i * 7919) % 60) * 1000, _unreadCount: 0, _status: 1, _midType: 0, pin: i < 19 ? 1000 + ((i * 37) % 19) : (i % 5 === 0 ? -1 : 0), hidden: 0, name }))
      const rows = raws.map((r) => m.toOrderRow(r, r.name))
      const R = m.orderRStar(rows)
      const k = 19 + 2 // 未釘選第 2 名；可見範圍 13..23 跨越邊界（18/19）
      const S = screen(R, 12, ALL, { 9: empty() })
      const r = loc(S, R, R[k].chatId)
      check('R* → ok, window spans pinned boundary', r.ok && r.row === k - 12 && R[13].pinned && !R[23].pinned, desc(r))
      const byPinTime = [...rows.filter((x) => x.pinned).sort((a, b) => {
        const pa = raws.find((q) => q._id === a.chatId).pin, pb = raws.find((q) => q._id === b.chatId).pin
        return pb - pa || (a.chatId < b.chatId ? -1 : 1)
      }), ...rows.filter((x) => !x.pinned).sort((a, b) => b.lastUpdated - a.lastUpdated || (a.chatId < b.chatId ? -1 : 1))]
      const bad = loc(S, byPinTime, R[k].chatId)
      check('pin-time ordering → list_order_mismatch', !bad.ok && bad.code === 'list_order_mismatch', desc(bad))
    })
    kase('⑭ 同時間鄰居：只有 T/B 通過', () => {
      const base = [...NAMES.slice(0, 60)]
      base[55] = base[20] // 讓目標不能當錨點（排除 T），用來測 A 與 B
      const tie = mkOrder(base).map((r, i) => (i === 21 ? { ...r, lastUpdated: T0 - 20 * 1000 } : r))
      const plain = mkOrder(base)
      const aRows = (O) => screen(O, 12, new Set([1, 4, 5, 10, 11]), { 8: perfect(O[20].name) })
      const noTie = loc(aRows(plain), plain, plain[20].chatId)
      check('control: no tie → path A', noTie.ok && noTie.path === 'A', desc(noTie))
      const tieA = loc(aRows(tie), tie, tie[20].chatId)
      check('tie → A not allowed → row_unconfirmed', !tieA.ok && tieA.code === 'row_unconfirmed', desc(tieA))
      const tieB = loc(screen(tie, 12, new Set([1, 4, 5, 6, 7, 9, 10]), { 8: perfect(tie[20].name) }), tie, tie[20].chatId)
      check('tie + r±1、r±2 anchors → path B', tieB.ok && tieB.path === 'B', desc(tieB))
      // G2 回歸（0c-B 正式版找到的點錯結構）：目標 T 和上一名 N 同時間；畫面上 T 排到 N 上面，
      // 未知聊天室 X 插在 N 後面（補進 T 原位）；T 是最上面一個可讀列之上（讀不到），上方沒有其他錨點。
      // 錨點（N、+1、+2）位移一致，r=X 的列、r±1 是錨點；收緊前走 B → 點到 X。
      const tieUp = mkOrder(NAMES.slice(0, 60)).map((r, i) => (i === 20 ? { ...r, lastUpdated: T0 - 19 * 1000 } : r))
      const S = [...tieUp]; [S[19], S[20]] = [S[20], S[19]]; S.splice(21, 0, { chatId: 'x-unknown', name: '未知聊天室乙丙' })
      const reg = loc(screen(S, 12, new Set([8, 9, 10, 11])), tieUp, tieUp[20].chatId)
      const wouldClick = reg.ok ? S[12 + reg.row].chatId : null
      check('regression: tie swap + unknown row in target slot → stop (no click on X)', !reg.ok, desc(reg) + (wouldClick ? ' WOULD-CLICK=' + wouldClick : ''))
      // 對照（只在本 probe 程序記憶體內）：把 bracketB 暫時設回 design-v3 原值 1，同一案例會被接受並點到 X，證明回歸案例有效
      const saved = m.LOCATE_RULES.bracketB
      m.LOCATE_RULES.bracketB = 1
      let old
      try { old = loc(screen(S, 12, new Set([8, 9, 10, 11])), tieUp, tieUp[20].chatId) } finally { m.LOCATE_RULES.bracketB = saved }
      check('control: with the pre-tightening rule (bracketB=1) the same case is accepted on X (the found wrong click)', old.ok && old.path === 'B' && S[12 + old.row].chatId === 'x-unknown', desc(old))
      const uniqTie = mkOrder(NAMES.slice(0, 60)).map((r, i) => (i === 21 ? { ...r, lastUpdated: T0 - 20 * 1000 } : r))
      const tieT = loc(screen(uniqTie, 12, new Set([1, 4, 8, 10, 11])), uniqTie, uniqTie[20].chatId)
      check('tie + target is its own anchor → path T', tieT.ok && tieT.path === 'T', desc(tieT))
    })
    kase('⑮ 全部讀取為空 → list_unrecognized', () => {
      const r = loc(screen(P, 12, new Set()), P, P[12 + 5].chatId)
      check('list_unrecognized', !r.ok && r.code === 'list_unrecognized', desc(r))
    })
    kase('⑯ 自己的聊天室名稱解析為 Keep筆記', () => {
      const lookup = { chatName: (id) => (id === 'u_other' ? '某人' : null), squareChatName: (id) => (id === 'm_sq' ? '社群聊天' : null) }
      check('selfMid → Keep筆記', m.resolveDisplayName('u_self', 0, 'u_self', lookup) === 'Keep筆記')
      check('chatName used for others', m.resolveDisplayName('u_other', 0, 'u_self', lookup) === '某人')
      check('midType 4 → _squareChat._name', m.resolveDisplayName('m_sq', 4, 'u_self', lookup) === '社群聊天')
      check('unresolvable → null', m.resolveDisplayName('m_sq', 0, 'u_self', lookup) === null && m.resolveDisplayName('x', 2, null, lookup) === null)
    })
    kase('⑰ DB-A≠DB-B → list_changing（L8）', () => {
      const k = 12 + 8
      const rows = screen(P, 12, OBS)
      const res = loc(rows, P, P[k].chatId)
      const ranges = m.stableRanges(res, rows, k)
      const now = T0 + 60_000
      const fresh = { newestUpdate: T0, now, captureStable: true }
      check('identical → ok', m.orderStable(P, P, ranges, fresh).ok)
      const B = [...P]; [B[15], B[16]] = [B[16], B[15]]
      const r1 = m.orderStable(P, B, ranges, fresh)
      check('change inside window → order_changed', !r1.ok && r1.reason === 'order_changed', JSON.stringify(r1))
      const B2 = [...P]; [B2[70], B2[71]] = [B2[71], B2[70]]
      check('change far outside ranges → ok', m.orderStable(P, B2, ranges, fresh).ok)
      const r3 = m.orderStable(P, P, ranges, { newestUpdate: now - 1200, now, captureStable: true })
      check('newest update < 5 s → recent_update', !r3.ok && r3.reason === 'recent_update')
      const r4 = m.orderStable(P, P, ranges, { ...fresh, captureStable: false })
      check('unstable capture → capture_unstable', !r4.ok && r4.reason === 'capture_unstable')
    })
    kase('⑱ C1–C3 各自的通過和失敗', () => {
      const k = 12 + 8
      const STRIP = { x: 0, y: 92, w: 600, h: 31 }
      const tl = (texts) => {
        const byConfig = {}
        ;['T1', 'T2', 'T3'].forEach((c, i) => { byConfig[c] = texts[i] ? [line(texts[i])] : [] })
        return m.titleReadings(byConfig, STRIP, ['T1', 'T2', 'T3'])
      }
      const J = (o) => m.judgeOpen({ targetRow: 8, offset: 12, targetChatId: P[k].chatId, selectedBefore: 3, selectedAfter: 8, titleHashBefore: 'A', titleHashAfter: 'B', title: tl([P[k].name, '', '']), order: P, ...o })
      const ok = J({})
      check('C1+C2 pass', ok.ok && ok.evidence.selectionMatched && ok.evidence.titlePass === 1, JSON.stringify(ok.ok ? { sim: ok.evidence.titleSim, gap: ok.evidence.titleGap } : ok))
      check('C1 fail: selected other row → click_missed', J({ selectedAfter: 9 }).code === 'click_missed')
      check('C1 fail: title hash unchanged after selection change → click_missed', J({ titleHashAfter: 'A' }).code === 'click_missed')
      check('C2 fail: title reads neighbour (k+1) → title_identifies_other', J({ title: tl([P[k + 1].name, '', '']) }).code === 'title_identifies_other')
      check('C2 fail: title reads previously open chat (selectedBefore) → stop', !J({ title: tl([P[3 + 12].name, '', '']) }).ok)
      check('C2 fail: unreadable → title_unreadable', J({ title: tl(['', '', '']) }).code === 'title_unreadable')
      const snap = (unreads) => ({ rows: P.map((r, i) => ({ ...r, unread: unreads[i] ?? 0 })), selfMid: null, takenAt: 0, newestUpdate: 0, readMs: 0 })
      const before = snap({ [k]: 2, 30: 5 })
      check('C3 target cleared → target_cleared', m.dbAck(before, snap({ 30: 5 }), P[k].chatId).verdict === 'target_cleared')
      check('C3 no change → no_change', m.dbAck(before, before, P[k].chatId).verdict === 'no_change')
      const other = m.dbAck(before, snap({ [k]: 2 }), P[k].chatId)
      check('C3 other cleared, target not → other_cleared (stop)', other.verdict === 'other_cleared' && other.otherChatId === P[30].chatId)
      check('C3 negative unread treated as 0', m.dbAck(snap({ 30: -2 }), snap({}), P[k].chatId).verdict === 'no_change')
    })

    const failed = cases.filter((c) => !c.ok)
    console.log(`[probe-locate] ${cases.length - failed.length}/${cases.length} cases passed (${sub.filter((s) => s.ok).length}/${sub.length} assertions)`)
    return failed.length === 0 && cases.length === 18 ? 0 : 1
  } catch (err) {
    console.error('[probe-locate] ERROR', err && err.stack ? err.stack : err)
    return 1
  } finally {
    cleanup()
  }
}

if (app && app.whenReady) app.whenReady().then(() => main()).then((c) => app.exit(c))
else main().then((c) => process.exit(c))
