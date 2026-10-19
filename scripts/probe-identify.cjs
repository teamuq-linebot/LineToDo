// probe-identify —— design-v3 Batch 1 驗收 M3：讀取變體、距離、標題局部判定。
//
// 用 production 的 src/main/driver/identify.ts、locate.ts（esbuild 打包），不重寫規則。
// 案例：design-v2 §4.9 中和變體／距離有關的 1–6、16–18，Batch 0 的 Keep 標題真實讀取型態
// （`*keep記`、`*ep筆記`、空字串；圖示字元以單一字母代替），以及標題局部判定（design-v3 §4 C2）。
// 全部是合成資料，不碰 LINE。
//
// 執行：npx electron scripts/probe-identify.cjs（exit 0 = 全數 PASS）

const path = require('node:path')
const fs = require('node:fs')
const esbuild = require('esbuild')

let app = null
try { app = require('electron').app } catch { app = null }

const ENTRY = `
export * from './src/main/driver/identify.ts'
export { judgeOpen, indexOrder, LOCATE_RULES } from './src/main/driver/locate.ts'
export { orderRStar } from './src/main/driver/order.ts'
`

// ── 合成 OCR 行 ─────────────────────────────────────────────────────────
// text 以空白切成「字」（Windows OCR 的 OcrWord）；每個字元寬 12 px、字距 2 px、字高 15。
function line(text, opt = {}) {
  const y = opt.y ?? 100
  let x = opt.x ?? 10
  const words = []
  for (const w of String(text).split(' ').filter(Boolean)) {
    const n = [...w].length
    const h = opt.heights?.[words.length] ?? 15
    words.push({ text: w, rect: { x, y: y + (15 - h), w: 12 * n, h } })
    x += 12 * n + (opt.gap ?? 2)
  }
  const x1 = words.length ? words[0].rect.x : x
  const x2 = words.length ? words[words.length - 1].rect.x + words[words.length - 1].rect.w : x
  return { text: words.map((w) => w.text).join(' '), rect: { x: x1, y, w: x2 - x1, h: 15 }, words }
}
const STRIP = { x: 0, y: 92, w: 600, h: 31 } // 中心 y=107.5，行中心 107.5

function title(texts) {
  const byConfig = {}
  ;['T1', 'T2', 'T3'].forEach((c, i) => {
    const t = texts[i]
    byConfig[c] = t === '' || t == null ? [] : [line(t)]
  })
  return byConfig
}

// design-v2 §4.9 的候選集合，排成一個 R*（名次即陣列位置，沒有釘選）。
const C_NAMES = ['2024專案A組', '2024專案B組', '家族旅遊', '家族', '王小明', 'Keep筆記', '台北業務部週會討論群', '台北業務部週會討論群2', 'abc123', '家族群組', 'Hello', '週末爬山隊', '讀書會', '社區管委會', '公司福委會']
function makeOrder(names) {
  const t0 = 1_900_000_000_000
  return names.map((name, i) => ({ chatId: 'c' + String(i).padStart(3, '0'), lastUpdated: t0 - i * 1000, pinned: false, hidden: false, unread: 0, midType: 0, status: 1, name }))
}

async function main() {
  const root = path.join(__dirname, '..')
  const entryFile = path.join(root, '__probe_identify_entry.ts')
  const outFile = path.join(root, '__probe_identify.bundle.cjs')
  const cleanup = () => { for (const f of [entryFile, outFile]) { try { fs.rmSync(f, { force: true }) } catch (_) {} } }
  const results = []
  const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond }); console.log(`[probe-identify] ${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' ' + detail : ''}`) }
  try {
    fs.writeFileSync(entryFile, ENTRY, 'utf8')
    await esbuild.build({ entryPoints: [entryFile], bundle: true, platform: 'node', format: 'cjs', outfile: outFile, absWorkingDir: root, logLevel: 'silent' })
    const m = require(outFile)
    const R = m.IDENTIFY_RULES
    const keepN = m.normalizeName('Keep筆記')
    const vOf = (t) => m.readingVariants(t === '' ? null : line(t))
    const s = (t, target) => m.score(vOf(t), m.normalizeName(target))

    // ── 正規化與門檻 ──
    check('N0 normalize Keep筆記 → keep筆記', keepN === 'keep筆記', keepN)
    check('N1 fullwidth/space/confusables', m.normalizeName('Ｋｅｅｐ 筆記') === 'keep筆記' && m.normalizeName('Hello') === 'he110' && m.normalizeName('ABC 123') === 'abc123')
    check('N2 thresholds L=6', R.maxErr(6) === 2 && R.gap(6) === 2 && R.readableMinLen(6) === 3)

    // ── design-v2 §4.9 #1–6（距離與可讀門檻）──
    check('#1 Keep筆記 exact s=0', s('Keep筆記', 'Keep筆記') === 0)
    check('#1 empty reading unreadable', !m.isReadable(vOf(''), 6))
    check('#2 "X keep記" dropLead 1.5', s('X keep 記', 'Keep筆記') === 1.5, 'variants=' + JSON.stringify(vOf('X keep 記').map((v) => [v.norm.length, v.penalty])))
    check('#3a "X ep 筆 記" ≤ maxErr', s('X ep 筆 記', 'Keep筆記') <= R.maxErr(6))
    check('#3b "X keep 記" ≤ maxErr', s('X keep 記', 'Keep筆記') <= R.maxErr(6))
    check('#3c "keep 記 ab" = 3 (weak, 可讀)', s('keep 記 ab', 'Keep筆記') === 3 && m.isReadable(vOf('keep 記 ab'), 6))
    check('#4 "K e e p 筆 記" s=0 (字間空格)', s('K e e p 筆 記', 'Keep筆記') === 0)
    check('#5 empty ×3 unreadable', ['', '', ''].every((t) => !m.isReadable(vOf(t), 6)))
    check('#6 "筆記"/"ep"/空 unreadable (長度 < 3)', ['筆 記', 'ep', ''].every((t) => !m.isReadable(vOf(t), 6)))
    // ── #16–18 ──
    check('#16 "家族群組 (12)" stripMembers s=0', s('家 族 群 組 (12)', '家族群組') === 0)
    check('#17 "Hell0" = Hello s=0', s('Hell0', 'Hello') === 0)
    check('#18 "ABC 123" = abc123 s=0', s('ABC 123', 'abc123') === 0)
    // ── 截斷（前綴距離）──
    check('T1 truncated prefix distance', s('台北業務部週會討…', '台北業務部週會討論群') === 0 && s('台北業務部週會討…', '台北業務部週會討論群2') === 0)
    check('T2 truncated < 4 chars not usable', s('台北…', '台北業務部') === Infinity)
    // ── 名稱行取法 ──
    const merged = m.rowNameLine([line('Keep', { y: 100 }), line('筆 記', { x: 70, y: 101 }), line('預覽第二行', { y: 130 })])
    check('L1 rowNameLine merges top visual line only', merged && m.normalizeName(merged.text) === 'keep筆記', merged ? 'len=' + m.normalizeName(merged.text).length : 'null')
    const far = { text: 'Keep 筆記 12:30', rect: { x: 10, y: 100, w: 400, h: 15 }, words: [...line('Keep 筆 記').words, { text: '12:30', rect: { x: 300, y: 100, w: 40, h: 15 } }] }
    check('L2 leftmost segment drops far words', m.readingVariants(far).some((v) => v.norm === 'keep筆記' && v.penalty === 0))
    const art = line('Keep 筆 記 x', { heights: [15, 15, 15, 6] })
    check('L3 artifact (height < 0.6×median) dropped', m.readingVariants(art)[0].norm === 'keep筆記')

    // ── Batch 0 Keep 標題真實讀取型態（圖示字元以 Q 代替；'?' 為 h=10 殘影）──
    const b0 = [
      { name: 'B0-T1 "*keep記"', text: 'Q keep 記 ?', expect: 1.5 },
      { name: 'B0-T2 "*keep記"', text: 'Q keep 記', expect: 1.5 },
      { name: 'B0-T3 "*ep筆記"', text: 'Q ep 筆 記 ?', expect: 2 }
    ]
    for (const c of b0) {
      const d = s(c.text, 'Keep筆記')
      check(c.name + ' distance', d === c.expect && d <= R.maxErr(6), 'd=' + d)
    }

    // ── 標題局部判定（design-v3 §4 C2）──
    const order = makeOrder(C_NAMES)
    const idx = m.indexOrder(order)
    const byId = (name) => order.find((r) => r.name === name).chatId
    const judge = (target, texts, extra = {}) => {
      const k = order.findIndex((r) => r.name === target)
      const t = m.titleReadings(title(texts), STRIP, ['T1', 'T2', 'T3'])
      return m.judgeOpen({ targetRow: 5, offset: k - 5, targetChatId: byId(target), selectedBefore: 'selectedBefore' in extra ? extra.selectedBefore : 2, selectedAfter: 'selectedAfter' in extra ? extra.selectedAfter : 5, titleHashBefore: 'h0', titleHashAfter: extra.after ?? 'h1', title: t, order, idx })
    }
    const expectOk = (name, r) => check(name, r.ok, r.ok ? `sim=${r.evidence.titleSim} gap=${r.evidence.titleGap} pass=${r.evidence.titlePass}` : 'code=' + r.code)
    const expectCode = (name, r, code) => check(name, !r.ok && r.code === code, r.ok ? 'ok' : 'code=' + r.code)

    expectOk('J1 Keep: "Keep筆記", 空, 空 → PASS', judge('Keep筆記', ['Keep 筆 記', '', '']))
    expectOk('J2 Keep: Batch 0 三組（*keep記、*keep記、*ep筆記）→ PASS', judge('Keep筆記', ['Q keep 記 ?', 'Q keep 記', 'Q ep 筆 記 ?']))
    expectOk('J3 Keep: "X keep記" ×3 → PASS', judge('Keep筆記', ['X keep 記', 'X keep 記', 'X keep 記']))
    expectOk('J4 Keep: "Xep筆記"、"Xkeep記"、"keep記ab" → PASS', judge('Keep筆記', ['X ep 筆 記', 'X keep 記', 'keep 記 ab']))
    expectOk('J5 Keep: 字間空格 → PASS', judge('Keep筆記', ['K e e p 筆 記', '', '']))
    expectCode('J6 Keep: 空×3 → title_unreadable', judge('Keep筆記', ['', '', '']), 'title_unreadable')
    expectCode('J7 Keep: "筆記"、"ep"、空 → title_unreadable', judge('Keep筆記', ['筆 記', 'ep', '']), 'title_unreadable')
    expectOk('J8 家族群組 "(12)" → PASS', judge('家族群組', ['家 族 群 組 (12)', '', '']))
    expectOk('J9 Hello "Hell0" → PASS', judge('Hello', ['Hell0', '', '']))
    expectOk('J10 abc123 "ABC 123" → PASS', judge('abc123', ['ABC 123', '', '']))
    // 局部集合：鄰居（±2）比目標更近 → 停止
    expectCode('J11 家族 ← 讀到「家族旅遊」（鄰居嚴格更近）→ 停止', judge('家族', ['家 族 旅 遊', '家 族', '家 族']), 'title_identifies_other')
    expectCode('J12 2024專案A組 ← 讀到「2024專案B組」→ 停止', judge('2024專案A組', ['2024 專 案 B 組', '', '']), 'title_identifies_other')
    // 全域否決：遠處有把握的他者
    expectCode('J13 Keep ← 讀到「讀書會」（遠處、有把握）→ title_identifies_other', judge('Keep筆記', ['讀 書 會', 'Keep 筆 記', '']), 'title_identifies_other')
    // 差距不足（局部相似名稱在 ±2 內）→ 無法確認
    expectCode('J14 台北業務部週會討論群 ← 截斷讀取（鄰居同前綴）→ title_unconfirmed', judge('台北業務部週會討論群', ['台 北 業 務 部 週 會 討 …', '', '']), 'title_unconfirmed')
    // selectedBefore 對應的聊天室列入局部集合（點擊沒有生效、仍開著前一個聊天室）
    {
      // 名次 9 的「Keep筆記本」和目標只差 1 字（< G=2）。它只有在 selectedBefore 被列入局部集合時才會影響判定。
      const order2 = makeOrder(['甲乙丙丁', '戊己庚辛', '家族', '王小明', '讀書會', '週末爬山隊', 'Keep筆記', '社區管委會', '公司福委會', 'Keep筆記本', '其他群組'])
      const idx2 = m.indexOrder(order2)
      const k = 6
      const t = m.titleReadings(title(['Keep 筆 記', '', '']), STRIP, ['T1', 'T2', 'T3'])
      const run = (selectedBefore) => m.judgeOpen({ targetRow: 4, offset: k - 4, targetChatId: order2[k].chatId, selectedBefore, selectedAfter: 4, titleHashBefore: 'a', titleHashAfter: 'b', title: t, order: order2, idx: idx2 })
      expectCode('J15 selectedBefore（名次 9「Keep筆記本」）列入局部集合 → 差距不足 → title_unconfirmed', run(7), 'title_unconfirmed')
      expectOk('J15b 對照：selectedBefore 讀不到時同一讀取 → PASS', run(null))
    }
    // C1
    expectCode('J16 C1 選取列不是目標 → click_missed', judge('Keep筆記', ['Keep 筆 記', '', ''], { selectedAfter: 6 }), 'click_missed')
    expectCode('J17 C1 選取讀不到 → click_missed', judge('Keep筆記', ['Keep 筆 記', '', ''], { selectedAfter: null }), 'click_missed')
    expectCode('J18 C1 選取改變但標題 hash 沒變 → click_missed', judge('Keep筆記', ['Keep 筆 記', '', ''], { after: 'h0' }), 'click_missed')
    expectOk('J19 C1 目標原本就開著（selectedBefore==r）且 hash 沒變 → 可通過', judge('Keep筆記', ['Keep 筆 記', '', ''], { selectedBefore: 5, after: 'h0' }))

    const failed = results.filter((r) => !r.ok)
    console.log(`[probe-identify] ${results.length - failed.length}/${results.length} passed`)
    return failed.length === 0 ? 0 : 1
  } catch (err) {
    console.error('[probe-identify] ERROR', err && err.stack ? err.stack : err)
    return 1
  } finally {
    cleanup()
  }
}

if (app && app.whenReady) app.whenReady().then(() => main()).then((c) => app.exit(c))
else main().then((c) => process.exit(c))
