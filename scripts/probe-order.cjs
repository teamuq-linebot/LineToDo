// probe-order —— design-v3 Batch 1 驗收 M3b：排序規則 R*（design-v3 §1.4）。
//
// 用 production 的 src/main/driver/order.ts（esbuild 打包）。全部是合成列，不碰 LINE。
//   ① 釘選（_pinnedTime > 0）在前，兩段各依 _lastUpdatedTime 由新到舊（釘選內不是依釘選時間）
//   ② _pinnedTime = −1 不是釘選；0 不是釘選
//   ③ _hidden ≠ 0 排除
//   ④ 同時間：順序穩定（chatId 字典序），並被 timeTies() 標記；跨釘選邊界同時間不算
//   ⑤ 未讀負值視為 0；名稱空白視為 null
//
// 執行：npx electron scripts/probe-order.cjs（exit 0 = 全數 PASS）

const path = require('node:path')
const fs = require('node:fs')
const esbuild = require('esbuild')

let app = null
try { app = require('electron').app } catch { app = null }

const ENTRY = `export * from './src/main/driver/order.ts'\n`

async function main() {
  const root = path.join(__dirname, '..')
  const entryFile = path.join(root, '__probe_order_entry.ts')
  const outFile = path.join(root, '__probe_order.bundle.cjs')
  const cleanup = () => { for (const f of [entryFile, outFile]) { try { fs.rmSync(f, { force: true }) } catch (_) {} } }
  const results = []
  const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond }); console.log(`[probe-order] ${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' ' + detail : ''}`) }
  try {
    fs.writeFileSync(entryFile, ENTRY, 'utf8')
    await esbuild.build({ entryPoints: [entryFile], bundle: true, platform: 'node', format: 'cjs', outfile: outFile, absWorkingDir: root, logLevel: 'silent' })
    const m = require(outFile)
    const T = 1_900_000_000_000
    const raw = (id, t, pin, hidden = 0, unread = 0) => ({ _id: id, _lastUpdatedTime: t, _unreadCount: unread, _status: 1, _midType: 0, pin, hidden })

    // ① 釘選在前、各自依時間；釘選時間與排序無關
    const rows1 = [
      m.toOrderRow(raw('u_a', T - 5000, 0), 'A'),
      m.toOrderRow(raw('u_p_old_pin_new_msg', T - 1000, 100), 'P1'), // 釘選時間最早，但最新訊息
      m.toOrderRow(raw('u_p_new_pin_old_msg', T - 9000, 999), 'P2'), // 釘選時間最晚，但訊息較舊
      m.toOrderRow(raw('u_b', T - 2000, 0), 'B'),
      m.toOrderRow(raw('u_c', T - 100, 0), 'C')
    ]
    const o1 = m.orderRStar(rows1).map((r) => r.chatId)
    check('① pinned first, each segment by lastUpdated DESC (not by pin time)', JSON.stringify(o1) === JSON.stringify(['u_p_old_pin_new_msg', 'u_p_new_pin_old_msg', 'u_c', 'u_b', 'u_a']), o1.join(','))

    // ② −1 與 0 都不是釘選
    const r2 = [m.toOrderRow(raw('u_minus1', T - 10, -1), 'X'), m.toOrderRow(raw('u_zero', T - 20, 0), 'Y'), m.toOrderRow(raw('u_pin', T - 30, 5), 'Z')]
    check('② _pinnedTime −1 → not pinned', r2[0].pinned === false && r2[1].pinned === false && r2[2].pinned === true)
    const o2 = m.orderRStar(r2).map((r) => r.chatId)
    check('② −1 is ordered with the unpinned segment', JSON.stringify(o2) === JSON.stringify(['u_pin', 'u_minus1', 'u_zero']), o2.join(','))
    check('② null pin → not pinned', m.toOrderRow(raw('u_null', T, null), 'N').pinned === false)

    // ③ hidden 排除
    const r3 = [m.toOrderRow(raw('u_vis', T - 10, 0, 0), 'V'), m.toOrderRow(raw('u_hid', T, 0, 1), 'H'), m.toOrderRow(raw('u_hid_pin', T, 7, 2), 'HP')]
    const o3 = m.orderRStar(r3).map((r) => r.chatId)
    check('③ _hidden ≠ 0 excluded (pinned or not)', JSON.stringify(o3) === JSON.stringify(['u_vis']), o3.join(','))

    // ④ 同時間：穩定（chatId 字典序）且被標記
    const r4 = [
      m.toOrderRow(raw('u_z', T - 500, 0), 'Z'),
      m.toOrderRow(raw('u_m', T - 500, 0), 'M'),
      m.toOrderRow(raw('u_a', T - 500, 0), 'A'),
      m.toOrderRow(raw('u_first', T - 100, 0), 'F'),
      m.toOrderRow(raw('u_last', T - 900, 0), 'L'),
      m.toOrderRow(raw('u_pin_same_time', T - 900, 3), 'P')
    ]
    const orderA = m.orderRStar(r4)
    const orderB = m.orderRStar([...r4].reverse())
    const ids = orderA.map((r) => r.chatId)
    check('④ ties ordered by chatId, independent of input order', JSON.stringify(ids) === JSON.stringify(orderB.map((r) => r.chatId)) && JSON.stringify(ids) === JSON.stringify(['u_pin_same_time', 'u_first', 'u_a', 'u_m', 'u_z', 'u_last']), ids.join(','))
    const ties = m.timeTies(orderA)
    check('④ ties flagged (only the three same-time unpinned rows)', JSON.stringify(ties) === JSON.stringify([false, false, true, true, true, false]), JSON.stringify(ties))
    check('④ same time across pinned boundary is not a tie', m.sameTime(orderA, 0, 5) === false && m.sameTime(orderA, 2, 3) === true)

    // ⑤ 未讀負值、名稱空白
    const r5 = m.toOrderRow(raw('u_neg', T, 0, 0, -3), '   ')
    check('⑤ negative unread → 0; blank name → null', r5.unread === 0 && r5.name === null)
    check('⑤ positive unread kept', m.toOrderRow(raw('u_pos', T, 0, 0, 4), 'x').unread === 4)

    const failed = results.filter((r) => !r.ok)
    console.log(`[probe-order] ${results.length - failed.length}/${results.length} passed`)
    return failed.length === 0 ? 0 : 1
  } catch (err) {
    console.error('[probe-order] ERROR', err && err.stack ? err.stack : err)
    return 1
  } finally {
    cleanup()
  }
}

if (app && app.whenReady) app.whenReady().then(() => main()).then((c) => app.exit(c))
else main().then((c) => process.exit(c))
