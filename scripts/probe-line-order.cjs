// probe-line-order —— driver_post Batch 3：LINE 本機 DB 唯讀 adapter（design-v3 §8.3、M25、M26、D5）。
//
// 用 production 的 src/main/driver/{lineOrder,order}.ts（esbuild 打包）。只讀 DB（唯讀複本、用完即刪），
// 不碰 LINE 畫面。輸出只有計數、名次、旗標與耗時（不含任何聊天室名稱；Keep筆記的名次除外）。
//   ① snapshot ×2：R* 摘要、兩次讀取的前 60 名是否相同、最新更新距今、單次讀取耗時（成本量測）
//   ② D5：金鑰快取檔不存在時 → line_key_unavailable；以 procmem stub 計數證明 lineOrder 從不呼叫 scanRegions（正向對照：
//      不帶 skipRecover 的 getKey 會呼叫），而且沒有新增 linekey-scan-* 目錄
//   ③ M26：%TEMP% 的 linedb-*／linekey-scan-* 目錄數在前後相同
//
// 執行：npx electron scripts/probe-line-order.cjs（exit 0 = ①②③ 全部符合）

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const esbuild = require('esbuild')

let app = null
try { app = require('electron').app } catch { app = null }

const ENTRY = `
export { createLineOrder } from './src/main/driver/lineOrder.ts'
export { orderRStar, SELF_CHAT_NAME } from './src/main/driver/order.ts'
`

function tempDirs() {
  let linedb = 0, linekey = 0
  for (const e of fs.readdirSync(os.tmpdir(), { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    if (e.name.startsWith('linedb-')) linedb++
    if (e.name.startsWith('linekey-scan-')) linekey++
  }
  return { linedb, linekey }
}

async function main() {
  const root = path.join(__dirname, '..')
  const entryFile = path.join(root, '__probe_lineorder_entry.ts')
  const outFile = path.join(root, '__probe_lineorder.bundle.cjs')
  const stubEntry = path.join(root, '__probe_lineorder_stub_entry.ts')
  const stubOut = path.join(root, '__probe_lineorder_stub.bundle.cjs')
  const cleanup = () => { for (const f of [entryFile, outFile, stubEntry, stubOut]) { try { fs.rmSync(f, { force: true }) } catch (_) {} } }
  const results = []
  const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond }); console.log(`[probe-line-order] ${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' ' + detail : ''}`) }
  try {
    fs.writeFileSync(entryFile, ENTRY, 'utf8')
    await esbuild.build({ entryPoints: [entryFile], bundle: true, platform: 'node', format: 'cjs', outfile: outFile, absWorkingDir: root, logLevel: 'silent', external: ['electron', 'better-sqlite3', 'better-sqlite3-multiple-ciphers', 'koffi'] })
    const m = require(outFile)
    // D5 用：native/procmem 換成計數 stub（不讀任何程序記憶體）
    fs.writeFileSync(stubEntry, `export { createLineOrder } from './src/main/driver/lineOrder.ts'\nexport { getKey } from './src/main/line/engine/linekey.ts'\n`, 'utf8')
    const stubProcmem = {
      name: 'stub-procmem',
      setup(b) {
        b.onResolve({ filter: /native[\\/]procmem$/ }, () => ({ path: 'procmem-stub', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export function scanRegions() { globalThis.__procmemScanCalls = (globalThis.__procmemScanCalls || 0) + 1; return 0 }', loader: 'js' }))
      }
    }
    await esbuild.build({ entryPoints: [stubEntry], bundle: true, platform: 'node', format: 'cjs', outfile: stubOut, absWorkingDir: root, logLevel: 'silent', plugins: [stubProcmem], external: ['electron', 'better-sqlite3', 'better-sqlite3-multiple-ciphers', 'koffi'] })
    const before = tempDirs()
    console.log(`[probe-line-order] temp before linedbDirs=${before.linedb} linekeyScanDirs=${before.linekey}`)

    // ① 兩次快照
    const cacheFile = path.join(process.env.APPDATA || '', 'line-todo', '.linekey')
    const lo = m.createLineOrder({ cacheFile })
    const t1 = Date.now()
    const a = await lo.snapshot()
    const firstMs = Date.now() - t1
    if (!a.ok) { check('① snapshot A', false, `code=${a.code} problem=${lo.lastProblem()}`) }
    else {
      const t2 = Date.now()
      const b = await lo.snapshot()
      const secondMs = Date.now() - t2
      check('① snapshot A/B ok', b.ok, b.ok ? '' : 'code=' + b.code)
      if (b.ok) {
        const A = a.value, B = b.value
        const RA = m.orderRStar(A.rows), RB = m.orderRStar(B.rows)
        const pinned = RA.filter((r) => r.pinned).length
        const hidden = A.rows.filter((r) => r.hidden).length
        const nullNames = RA.filter((r) => !r.name).length
        const unread = A.rows.filter((r) => r.unread > 0).length
        const midTypes = {}; for (const r of A.rows) midTypes[r.midType] = (midTypes[r.midType] || 0) + 1
        const status = {}; for (const r of A.rows) status[r.status] = (status[r.status] || 0) + 1
        const keepRank = RA.findIndex((r) => r.name === m.SELF_CHAT_NAME && r.chatId === A.selfMid)
        const same60 = RA.slice(0, 60).map((r) => r.chatId).join() === RB.slice(0, 60).map((r) => r.chatId).join()
        const pinnedBlock = RA.slice(0, pinned).every((r) => r.pinned) && RA.slice(pinned).every((r) => !r.pinned)
        const sortedInSegments = RA.every((r, i) => i === 0 || RA[i - 1].pinned !== r.pinned || RA[i - 1].lastUpdated >= r.lastUpdated)
        console.log(`[probe-line-order] R* rows=${A.rows.length} visible=${RA.length} hidden=${hidden} pinned=${pinned} nullNames=${nullNames} unread>0=${unread} midType=${JSON.stringify(midTypes)} status=${JSON.stringify(status)} selfMid=${A.selfMid ? 'present' : 'null'} Keep筆記rank=${keepRank}`)
        console.log(`[probe-line-order] cost firstSnapshotMs(getKey from cache + copy/decrypt + query)=${firstMs} secondSnapshotMs(key cached)=${secondMs} readMsA=${A.readMs} readMsB=${B.readMs} newestUpdateAgeS=${Math.round((Date.now() - B.newestUpdate) / 1000)} top60SameAcrossReads=${same60}`)
        check('① R* structure: pinned block first, each segment by lastUpdated DESC', pinnedBlock && sortedInSegments)
        check('① self chat resolves to Keep筆記', keepRank >= 0, 'rank=' + keepRank)
      }
    }

    // ② D5：沒有快取金鑰 → line_key_unavailable，且不掃描 LINE 記憶體。
    //   另外打包一份把 native/procmem 換成「只計數、回傳空」的 stub 的版本：scanRegions 被呼叫就代表會掃記憶體。
    //   正向對照：同一份 stub bundle 直接呼叫 getKey（不帶 skipRecover）必須讓計數 > 0，證明偵測有效
    //   （stub 不讀任何記憶體；對照只會多一次 DB 唯讀複製，用完即刪）。
    const savedEnv = process.env.LINE_DB_KEY
    delete process.env.LINE_DB_KEY
    const mid = tempDirs()
    const s = require(stubOut)
    globalThis.__procmemScanCalls = 0
    const missingCache = path.join(os.tmpdir(), 'probe-no-such-linekey-' + process.pid)
    const lo2 = s.createLineOrder({ cacheFile: missingCache })
    const t3 = Date.now()
    const r2 = await lo2.snapshot()
    const d5Ms = Date.now() - t3
    const scansD5 = globalThis.__procmemScanCalls
    const afterD5 = tempDirs()
    globalThis.__procmemScanCalls = 0
    const ctrlKey = s.getKey({ cacheFile: missingCache, skipEnv: true, cache: false })
    const scansCtrl = globalThis.__procmemScanCalls
    if (savedEnv !== undefined) process.env.LINE_DB_KEY = savedEnv
    check('② D5 no cached key → line_key_unavailable', !r2.ok && r2.code === 'line_key_unavailable', (r2.ok ? 'ok' : 'code=' + r2.code) + ` ms=${d5Ms}`)
    check('② D5 lineOrder never calls procmem.scanRegions (no LINE memory scan)', scansD5 === 0, `scanCalls=${scansD5}`)
    check('② D5 positive control: getKey without skipRecover does reach scanRegions (stub)', scansCtrl > 0 && ctrlKey === null, `scanCalls=${scansCtrl} key=${ctrlKey === null ? 'null' : 'non-null'}`)
    check('② D5 no new linekey-scan-* dir from lineOrder', afterD5.linekey === mid.linekey, `before=${mid.linekey} after=${afterD5.linekey}`)

    // ③ M26
    const after = tempDirs()
    console.log(`[probe-line-order] temp after linedbDirs=${after.linedb} linekeyScanDirs=${after.linekey}`)
    check('③ M26 temp dirs unchanged', after.linedb === before.linedb && after.linekey === before.linekey)

    const failed = results.filter((r) => !r.ok)
    console.log(`[probe-line-order] ${results.length - failed.length}/${results.length} passed`)
    return failed.length === 0 ? 0 : 1
  } catch (err) {
    console.error('[probe-line-order] ERROR', String(err && err.message ? err.message : err).slice(0, 200))
    return 1
  } finally {
    cleanup()
  }
}

if (app && app.whenReady) app.whenReady().then(() => main()).then((c) => app.exit(c))
else main().then((c) => process.exit(c))
