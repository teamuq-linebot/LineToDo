// probe-locate-stress —— design-v3 Batch 1 驗收 M3d：0c-B 合成壓力測試（閘門 G2、G3）。
//
// 用 production 的 src/main/driver/{lineOrder,order,locate,identify}.ts（esbuild 打包），不重寫規則。
//   - R* 取自真實 LINE 本機 DB（lineOrder.snapshot：唯讀複本、用完即刪；名稱只在記憶體中）。
//     --synthetic-db 時改用合成名稱（不讀 DB），只供離線自測。
//   - 螢幕：R* 前 ~70 名中隨機取 11 列完整可見窗（螢幕第 1–11 列），目標取窗內非邊緣列。
//   - OCR 錯誤依 Batch 0 型態產生並加重（同 v3-09）：空讀取 15%、掉 1 字 35%、再掉 1 字 15%、替換 25%、
//     中英交界掉字 30%、結尾多字 15%、開頭圖示字 20%。兩種相關性：3 組讀取各自獨立／完全相同（悲觀）。
//   - 8 種擾動（DB 不變，只改畫面）＋ 3 種結構情境（目標和相鄰列同時間、±2 內有 null 名稱、±2 內有同名；
//     每次試驗另外隨機套用 8 種擾動之一）。
//   - 「點錯」＝規則接受，但畫面上該列顯示的不是目標聊天室。
//   - 亂數用 mulberry32（週期 2^32）；並回報不重複的試驗數（G2 以不重複試驗計）。
// 輸出只有計數（不含任何名稱）。exit 0 ⇔ 所有格子點錯 0 次且總次數 ≥ 80,000。
//
// 執行：npx electron scripts/probe-locate-stress.cjs --trials 5000 --seed 20260929

const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const esbuild = require('esbuild')

let app = null
try { app = require('electron').app } catch { app = null }

const ENTRY = `
export { createLineOrder } from './src/main/driver/lineOrder.ts'
export { orderRStar } from './src/main/driver/order.ts'
export { locateTarget, indexOrder, findAnchors } from './src/main/driver/locate.ts'
export { normalizeName, lev } from './src/main/driver/identify.ts'
`

function arg(name, def) {
  const i = process.argv.indexOf(name)
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def
}

async function main() {
  const TRIALS = Number(arg('--trials', 5000))
  const SEED = Number(arg('--seed', 20260929))
  const SYNTH = process.argv.includes('--synthetic-db')
  // --only <文字>：只跑名稱含此文字的格子（診斷用；會改變亂數序列）。--diagnose：點錯時印出結構（只有名次差與距離，不含名稱）。
  const ONLY = arg('--only', '')
  const DIAG = process.argv.includes('--diagnose')
  const root = path.join(__dirname, '..')
  const entryFile = path.join(root, '__probe_stress_entry.ts')
  const outFile = path.join(root, '__probe_stress.bundle.cjs')
  const cleanup = () => { for (const f of [entryFile, outFile]) { try { fs.rmSync(f, { force: true }) } catch (_) {} } }
  try {
    fs.writeFileSync(entryFile, ENTRY, 'utf8')
    await esbuild.build({
      entryPoints: [entryFile], bundle: true, platform: 'node', format: 'cjs', outfile: outFile, absWorkingDir: root, logLevel: 'silent',
      external: ['electron', 'better-sqlite3', 'better-sqlite3-multiple-ciphers', 'koffi']
    })
    const m = require(outFile)

    // mulberry32（週期 2^32）。注意：v3-09 的 `(seed * 1103515245 + 12345) & 0x7fffffff` 在 JS 會超過 2^53
    // 而失去精度，實測任何 seed 都落入長度 10,466 的循環，試驗大量重複；正式版不得沿用。
    let seed = SEED >>> 0
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) >>> 0
      let t = seed
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    // 試驗簽章，用來回報「不重複的試驗數」。64-bit（SHA-1 前 16 hex）：32-bit FNV 在 80,000 筆時預期約 0.75 次
    // 假碰撞，會讓「不重複 ≥ 80,000」的判定誤報失敗（Batch 1–4 盤點修正）；64-bit 的預期假碰撞約 2×10⁻¹⁰。
    const sig64 = (str) => crypto.createHash('sha1').update(str).digest('hex').slice(0, 16)
    const distinctAll = new Set()
    const pick = (a) => a[Math.floor(rnd() * a.length)]
    const CJK = '的一是不了人我在有他這中大來上個們到說國和地也子時道出而要於就下得可你年生'.split('')
    const LAT = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('')

    // ── R*（真實 DB；名稱只在記憶體）──
    let rows
    let dbMs = 0
    if (SYNTH) {
      const T0 = 1_900_000_000_000
      rows = Array.from({ length: 650 }, (_, i) => ({ chatId: 's' + i, lastUpdated: T0 - i * 7000, pinned: i % 37 === 0, hidden: false, unread: 0, midType: 0, status: 1, name: Array.from({ length: 3 + (i % 6) }, () => pick(CJK)).join('') }))
    } else {
      const lo = m.createLineOrder({ cacheFile: path.join(process.env.APPDATA || '', 'line-todo', '.linekey') })
      const t = Date.now()
      const snap = await lo.snapshot()
      dbMs = Date.now() - t
      if (!snap.ok) { console.log(`[probe-stress] ABORT lineOrder=${snap.code} problem=${lo.lastProblem()}`); return 2 }
      rows = snap.value.rows
    }
    const P = m.orderRStar(rows)
    const idx0 = m.indexOrder(P)
    const pinnedCount = P.filter((r) => r.pinned).length
    console.log(`[probe-stress] source=${SYNTH ? 'synthetic' : 'line-db'} dbReadMs=${dbMs} rows=${P.length} names=${idx0.names.length} uniqueNames=${idx0.uniqRank.size} nullNames=${idx0.norms.filter((n) => !n).length} pinned=${pinnedCount} trialsPerCell=${TRIALS} seed=${SEED}`)

    // ── 合成 OCR（v3-09 的型態與比率）──
    const variant = (s, p) => ({ norm: m.normalizeName(s), penalty: p, truncated: false })
    function ocrOnce(name) {
      if (!name || rnd() < 0.15) return []
      let c = [...name]
      if (rnd() < 0.35 && c.length > 2) c.splice(Math.floor(rnd() * c.length), 1)
      if (rnd() < 0.15 && c.length > 3) c.splice(Math.floor(rnd() * c.length), 1)
      if (rnd() < 0.25 && c.length) c[Math.floor(rnd() * c.length)] = pick(rnd() < 0.5 ? CJK : LAT)
      const b = c.findIndex((ch, i) => i > 0 && /[a-z0-9]/.test(c[i - 1]) !== /[a-z0-9]/.test(ch))
      if (b > 0 && rnd() < 0.3) c.splice(b - (rnd() < 0.5 ? 1 : 0), 1)
      if (rnd() < 0.15) { c.push(pick(CJK)); if (rnd() < 0.5) c.push(pick(LAT)) }
      const s = c.join('')
      let out = [variant(s, 0)]
      if (rnd() < 0.2) out = [variant(pick(LAT) + s, 0), variant(s, 0.5)]
      return out.filter((v) => v.norm.length)
    }
    const readings = (name, correlated) => {
      if (correlated) { const r = ocrOnce(name); return [r, r, r] }
      return [ocrOnce(name), ocrOnce(name), ocrOnce(name)]
    }
    const fakeName = () => m.normalizeName(Array.from({ length: 3 + Math.floor(rnd() * 6) }, () => pick(CJK)).join(''))

    // ── 擾動（DB 不變，只改畫面清單 S）──
    const W = 11
    const PERT = {
      none: (S) => S,
      insertUnknown: (S, s) => { const x = [...S]; x.splice(s + 1 + Math.floor(rnd() * W), 0, { chatId: 'fake', name: fakeName() }); return x },
      insertTwinOfTarget: (S, s, k) => { const x = [...S]; x.splice(k + (rnd() < 0.5 ? 0 : 1), 0, { chatId: 'twin', name: S[k].name }); return x },
      deleteOne: (S, s) => { const x = [...S]; x.splice(s + 1 + Math.floor(rnd() * W), 1); return x },
      swapTargetNeighbour: (S, s, k) => { const x = [...S]; const j = k + (rnd() < 0.5 ? -1 : 1); if (x[j]) [x[k], x[j]] = [x[j], x[k]]; return x },
      moveTargetToTop: (S, s, k) => { const x = [...S]; const [t] = x.splice(k, 1); x.splice(pinnedCount, 0, t); return x },
      moveOtherToTop: (S, s, k) => { const x = [...S]; const i = Math.min(x.length - 1, k + 1 + Math.floor(rnd() * 5)); const [t] = x.splice(i, 1); x.splice(pinnedCount, 0, t); return x },
      filter30: (S) => S.filter(() => rnd() > 0.3)
    }
    const PERT_NAMES = Object.keys(PERT)

    // ── 結構情境：回傳 { dbOrder, idx, screenBase, targetId } 或 null（此試驗不適用）──
    const STRUCT = {
      tieNeighbour: (k) => {
        // DB 端目標和相鄰列同時間（LINE 的相對順序未定義）；畫面上兩者的順序隨機。
        const j = k + (rnd() < 0.5 ? -1 : 1)
        if (!P[j] || P[j].pinned !== P[k].pinned) return null
        const mod = P.map((r) => (r.chatId === P[j].chatId ? { ...r, lastUpdated: P[k].lastUpdated } : r))
        const dbOrder = m.orderRStar(mod)
        const a = dbOrder.findIndex((r) => r.chatId === P[k].chatId)
        const b = dbOrder.findIndex((r) => r.chatId === P[j].chatId)
        const screenBase = [...dbOrder]
        if (rnd() < 0.5) [screenBase[a], screenBase[b]] = [screenBase[b], screenBase[a]]
        return { dbOrder, idx: m.indexOrder(dbOrder), screenBase, targetId: P[k].chatId }
      },
      nullNearby: (k) => {
        // DB 端 ±2 內某一列名稱解析不到（null）；畫面上仍顯示它的真實名稱。
        const j = k + pick([-2, -1, 1, 2])
        if (!P[j] || !P[j].name) return null
        const dbOrder = P.map((r, i) => (i === j ? { ...r, name: null } : r))
        return { dbOrder, idx: m.indexOrder(dbOrder), screenBase: P, targetId: P[k].chatId }
      },
      twinNearby: (k) => {
        // ±2 內某一列和目標同名（DB 與畫面一致）。
        const j = k + pick([-2, -1, 1, 2])
        if (!P[j]) return null
        const dbOrder = P.map((r, i) => (i === j ? { ...r, name: P[k].name } : r))
        return { dbOrder, idx: m.indexOrder(dbOrder), screenBase: dbOrder, targetId: P[k].chatId }
      }
    }

    const cells = []
    const t0 = Date.now()
    /** 點錯的結構診斷：只印名次差（相對目標）、距離、可讀長度與路徑，不印任何名稱。 */
    function diagnose(label, correlated, sc, s, rowsIn, out, idx, dbOrder, S) {
      const a = idx.rankById.get(sc.targetId)
      const tn = idx.norms[a]
      const rel = (c) => { const r = idx.rankById.get(c.chatId); return r === undefined ? 'X' : (r - a >= 0 ? '+' : '') + (r - a) }
      const nm = (c) => (c.name ? m.normalizeName(c.name) : '')
      const { anchors } = m.findAnchors(rowsIn, idx)
      const rows = []
      for (let j = out.row - 3; j <= out.row + 3; j++) {
        const c = S[s + j]; const ri = rowsIn.find((q) => q.index === j)
        if (!c || !ri) continue
        const an = anchors.find((q) => q.row === j)
        const rd = ri.readings[0]
        const best = rd.length ? Math.min(...rd.map((v) => m.lev(v.norm, tn))) : null
        rows.push({ row: j, shows: rel(c), shownVsTargetLev: m.lev(nm(c), tn), readLen: rd.length ? Math.max(...rd.map((v) => [...v.norm].length)) : 0, readingVsTargetLev: best, anchorVotes: an ? (an.rank - a >= 0 ? '+' : '') + (an.rank - a) : '-', anchorVoteCorrect: an ? an.chatId === c.chatId : null })
      }
      const tie = dbOrder.map((r, i) => i).filter((i) => i !== a && dbOrder[i].lastUpdated === dbOrder[a].lastUpdated && dbOrder[i].pinned === dbOrder[a].pinned).map((i) => i - a)
      console.log('[probe-stress] WRONG-DIAG ' + JSON.stringify({ cell: label + '/' + (correlated ? 'c' : 'i'), meta: sc.meta || null, path: out.path, row: out.row, offset: out.offset, expectedOffsetFromScreen: s, targetLen: [...tn].length, tieNeighboursRel: tie, rows }))
    }
    function runCell(label, correlated, setup) {
      if (ONLY && !label.includes(ONLY)) return
      const st = { cell: label, correlated, trials: 0, accept: 0, wrong: 0, wrongPaths: '', codes: {}, distinct: new Set() }
      let guard = 0
      while (st.trials < TRIALS && guard++ < TRIALS * 20) {
        const s = Math.floor(rnd() * 60)
        const k = s + 2 + Math.floor(rnd() * (W - 2)) // 螢幕第 2..10 列（非邊緣）
        if (!P[k] || !idx0.norms[k] || [...idx0.norms[k]].length < 2) continue
        const sc = setup(s, k)
        if (!sc) continue
        const { dbOrder, idx, screen: S, targetId } = sc
        const view = S.slice(s + 1, s + 1 + W)
        if (view.length < W) continue
        const rowsIn = view.map((c, i) => ({ index: i + 1, readings: readings(c.name ? m.normalizeName(c.name) : fakeName(), correlated) }))
        const out = m.locateTarget(rowsIn, dbOrder, targetId, idx)
        st.trials++
        const sig = sig64(label + (correlated ? '|c|' : '|i|') + s + '|' + targetId + '|' + view.map((c) => c.chatId).join(',') + '|' + rowsIn.map((r) => r.readings.map((v) => v.map((x) => x.norm + '/' + x.penalty).join('+')).join(';')).join('#'))
        st.distinct.add(sig)
        distinctAll.add(sig)
        if (out.ok) {
          st.accept++
          const shown = S[s + out.row]
          if (!shown || shown.chatId !== targetId) {
            st.wrong++; st.wrongPaths += out.path
            if (DIAG) diagnose(label, correlated, sc, s, rowsIn, out, idx, dbOrder, S)
          }
        } else st.codes[out.code] = (st.codes[out.code] || 0) + 1
      }
      cells.push(st)
      const pct = (100 * st.accept / Math.max(1, st.trials)).toFixed(1)
      console.log(`[probe-stress] ${(label + '/' + (correlated ? 'correlated' : 'independent')).padEnd(46)} trials=${st.trials} distinct=${st.distinct.size} accept=${st.accept} (${pct}%) WRONG=${st.wrong}${st.wrong ? ' paths=' + st.wrongPaths : ''} stops=${JSON.stringify(st.codes)} t=${Math.round((Date.now() - t0) / 1000)}s`)
    }

    for (const correlated of [false, true]) {
      for (const pn of PERT_NAMES) {
        runCell(pn, correlated, (s, k) => ({ dbOrder: P, idx: idx0, screen: PERT[pn](P, s, k), targetId: P[k].chatId }))
      }
    }
    for (const correlated of [false, true]) {
      for (const [sn, sf] of Object.entries(STRUCT)) {
        runCell('struct:' + sn + '+randomPert', correlated, (s, k) => {
          const b = sf(k)
          if (!b) return null
          const pn = pick(PERT_NAMES)
          const kk = b.screenBase.findIndex((r) => r.chatId === b.targetId)
          return { dbOrder: b.dbOrder, idx: b.idx, screen: PERT[pn](b.screenBase, s, kk), targetId: b.targetId, meta: { pert: pn, tieSwapped: b.screenBase.some((r, i) => r.chatId !== b.dbOrder[i].chatId) } }
        })
      }
    }

    const total = cells.reduce((a, c) => a + c.trials, 0)
    const wrong = cells.reduce((a, c) => a + c.wrong, 0)
    const pertTotal = cells.filter((c) => !c.cell.startsWith('struct:')).reduce((a, c) => a + c.trials, 0)
    const noneInd = cells.find((c) => c.cell === 'none' && !c.correlated)
    const noneCor = cells.find((c) => c.cell === 'none' && c.correlated)
    const accInd = noneInd ? noneInd.accept / noneInd.trials : NaN
    const accCor = noneCor ? noneCor.accept / noneCor.trials : NaN
    const minCell = Math.min(...cells.map((c) => c.trials))
    const pertDistinct = cells.filter((c) => !c.cell.startsWith('struct:')).reduce((a, c) => a + c.distinct.size, 0)
    const minDistinct = Math.min(...cells.map((c) => c.distinct.size))
    // 「≥ 80,000 次」以不重複的試驗計；每格不重複試驗數也要 ≥ TRIALS × 0.99（容許極少數雜湊碰撞或真重複）。
    const g2 = wrong === 0 && pertDistinct >= 80000 && minCell >= TRIALS && minDistinct >= TRIALS * 0.99
    const g3 = accInd >= 0.8 && accCor >= 0.5
    console.log(`[probe-stress] TOTAL trials=${total} distinct=${distinctAll.size} (8×2 perturbation cells: trials=${pertTotal} distinct=${pertDistinct}; structural=${total - pertTotal}) minCell=${minCell} minDistinct=${minDistinct} WRONG=${wrong} upper95≈${(3 / Math.max(1, distinctAll.size)).toExponential(2)} ms=${Date.now() - t0}`)
    console.log(`[probe-stress] G2 wrongClicks=0 over ≥80000 distinct perturbation trials (all cells ≥ ${TRIALS}): ${g2 ? 'PASS' : 'FAIL'}`)
    console.log(`[probe-stress] G3 none/independent accept=${(accInd * 100).toFixed(1)}% (≥80%) none/correlated accept=${(accCor * 100).toFixed(1)}% (≥50%): ${g3 ? 'PASS' : 'FAIL'}`)
    return g2 ? 0 : 1
  } catch (err) {
    console.error('[probe-stress] ERROR', String(err && err.message ? err.message : err).slice(0, 300))
    return 1
  } finally {
    cleanup()
  }
}

if (app && app.whenReady) app.whenReady().then(() => main()).then((c) => app.exit(c))
else main().then((c) => process.exit(c))
