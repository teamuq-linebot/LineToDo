// probe-driver-host —— driver_post Batch 3：helper v3 的唯讀指令實測（design-v3 §8.2）。
//
// 用 production 的 src/main/driver/psHost.ts＋resources/line-driver/line-uia-host.ps1。
// **只呼叫唯讀指令**：hello、beginSession/endSession、locateLine、probeAnchors、readSearch、readList（PrintWindow＋
// 記憶體內 OCR）、readListGeometry、readTitle、readEdit。以白名單包裝 port，任何其他指令（切前景、點擊、寫入）一律拋錯。
// 不點擊、不捲動、不寫搜尋框、不開聊天室、不切前景。
// 輸出只有計數、布林與耗時：不印任何 OCR 原文或聊天室名稱（標題只回報「是否像 Keep筆記」）。
// 另外用 production 的 lineOrder＋locate 在記憶體中推定錨點與位移（只印計數）。
// M5／M26：前後比較 %TEMP%、userData、worktree 的 png/bmp 數量（含新 mtime）與 linedb-*／linekey-scan-* 目錄數；
// 任何一項改變、或送出唯讀白名單以外的指令 → exit 1。
//
// 執行：npx electron scripts/probe-driver-host.cjs（LINE 沒開時 locateLine=not_running，仍 exit 0）

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const esbuild = require('esbuild')

let app = null
try { app = require('electron').app } catch { app = null }

const ENTRY = `
export { createPsHost } from './src/main/driver/psHost.ts'
export { ROW_CONFIGS, TITLE_CONFIGS } from './src/main/driver/port.ts'
export { rowReadings, titleReadings, normalizeName, score, isReadable, IDENTIFY_RULES } from './src/main/driver/identify.ts'
export { findAnchors, indexOrder, LOCATE_RULES } from './src/main/driver/locate.ts'
export { orderRStar } from './src/main/driver/order.ts'
export { createLineOrder } from './src/main/driver/lineOrder.ts'
`

/** M5／M26：影像檔（png/bmp）與 LINE DB 暫存目錄計數。只數數量與 mtime，不開檔。 */
function countImages(dir, since, depth = 0, acc = { total: 0, fresh: 0 }) {
  if (depth > 12) return acc
  let ents
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') countImages(p, since, depth + 1, acc); continue }
    if (!/.(png|bmp)$/i.test(e.name)) continue
    acc.total++
    try { if (since !== null && fs.statSync(p).mtimeMs >= since) acc.fresh++ } catch { /* vanished */ }
  }
  return acc
}
function tempDbDirs() {
  let n = 0
  for (const e of fs.readdirSync(os.tmpdir(), { withFileTypes: true })) if (e.isDirectory() && (e.name.startsWith('linedb-') || e.name.startsWith('linekey-scan-'))) n++
  return n
}

const READ_ONLY = new Set(['hello', 'beginSession', 'endSession', 'locateLine', 'probeAnchors', 'readSearch', 'readList', 'readListGeometry', 'readTitle', 'readEdit', 'telemetry', 'dispose', 'helperPid'])

async function main() {
  const root = path.join(__dirname, '..')
  const entryFile = path.join(root, '__probe_host_entry.ts')
  const outFile = path.join(root, '__probe_host.bundle.cjs')
  const cleanup = () => { for (const f of [entryFile, outFile]) { try { fs.rmSync(f, { force: true }) } catch (_) {} } }
  const sent = []
  const out = (s) => console.log('[probe-host] ' + s)
  let host = null
  try {
    fs.writeFileSync(entryFile, ENTRY, 'utf8')
    await esbuild.build({ entryPoints: [entryFile], bundle: true, platform: 'node', format: 'cjs', outfile: outFile, absWorkingDir: root, logLevel: 'silent', external: ['electron', 'better-sqlite3', 'better-sqlite3-multiple-ciphers', 'koffi'] })
    const m = require(outFile)
    const raw = m.createPsHost({ scriptPath: path.join(root, 'resources', 'line-driver', 'line-uia-host.ps1'), log: () => {} })
    host = new Proxy(raw, {
      get(t, k) {
        const v = t[k]
        if (typeof v !== 'function') return v
        if (!READ_ONLY.has(String(k))) return () => { throw new Error('probe refuses non-read-only command: ' + String(k)) }
        return (...a) => { sent.push(String(k)); return v.apply(t, a) }
      }
    })

    const IMG_ROOTS = { temp: os.tmpdir(), userData: path.join(process.env.APPDATA || '', 'line-todo'), worktree: root }
    const startedAt = Date.now() - 1000
    const imgBefore = Object.fromEntries(Object.entries(IMG_ROOTS).map(([k, d]) => [k, countImages(d, null).total]))
    const dbDirsBefore = tempDbDirs()
    out(`M5 images before temp=${imgBefore.temp} userData=${imgBefore.userData} worktree=${imgBefore.worktree}; M26 linedb/linekey-scan dirs before=${dbDirsBefore}`)
    const finish = (code) => {
      const after = Object.fromEntries(Object.entries(IMG_ROOTS).map(([k, d]) => [k, countImages(d, startedAt)]))
      const dbDirsAfter = tempDbDirs()
      const imgOk = Object.keys(IMG_ROOTS).every((k) => after[k].total === imgBefore[k] && after[k].fresh === 0)
      out(`M5 images after temp=${after.temp.total}(new ${after.temp.fresh}) userData=${after.userData.total}(new ${after.userData.fresh}) worktree=${after.worktree.total}(new ${after.worktree.fresh}) unchanged=${imgOk}`)
      out(`M26 linedb/linekey-scan dirs after=${dbDirsAfter} unchanged=${dbDirsAfter === dbDirsBefore}`)
      const onlyRead = [...new Set(sent)].every((c) => READ_ONLY.has(c))
      out(`commandsSent=${[...new Set(sent)].join(',')} onlyReadOnly=${onlyRead}`)
      return code === 0 && imgOk && dbDirsAfter === dbDirsBefore && onlyRead ? 0 : 1
    }
    const t0 = Date.now()
    const hello = await host.hello()
    out(`hello protocol=${hello.protocol} ps=${hello.psVersion} languageMode=${hello.languageMode} ocrZhHant=${hello.ocrLanguages.includes('zh-Hant-TW')} dpi=${hello.dpiAwareness} coldStartMs=${Date.now() - t0}`)
    await host.beginSession()
    const loc = await host.locateLine()
    out(`locateLine status=${loc.status}${loc.status === 'ok' ? ` iconic=${loc.iconic} otherTopLevel=${loc.otherTopLevel.length} exeVersion=${loc.exeVersion}` : ''}`)
    if (loc.status !== 'ok') { out('LINE not available — read-only probe ends here'); await host.endSession(); return finish(0) }
    // LINE 最小化時：不還原（還原會切前景，不在唯讀授權內）。UIA 唯讀指令照常執行；PrintWindow 預期擷取不到（capture_blank），
    // 這正是 postDraft S2 要先 activateLine({restore:true}) 的原因。完整擷取／OCR 需要使用者先把 LINE 視窗打開後重跑。
    if (loc.iconic) out('LINE is minimized — no restore (not authorized); UIA reads continue, PrintWindow capture expected blank')

    const anchors = await host.probeAnchors()
    out(`probeAnchors ok=${anchors.ok} missing=${anchors.missing.length}`)
    const search = await host.readSearch()
    out(`readSearch empty=${search === ''}`)

    const t1 = Date.now()
    const list = await host.readList({ configs: m.ROW_CONFIGS })
    const listMs = Date.now() - t1
    if (!list.ok) {
      out(`readList refusal=${list.refusal} ms=${listMs}${loc.iconic ? ' (expected while minimized)' : ''}`)
      const g0 = await host.readListGeometry()
      out(`readListGeometry ok=${g0.ok}${g0.ok ? '' : ' refusal=' + g0.refusal}`)
      // 最小化時 UIA 樹收合：標題／輸入框節點不存在，helper 回報例外（production 對應 line_ui_unrecognized）。只印例外類別。
      const tryRead = async (label, fn, fmt) => { try { const r = await fn(); out(`${label} ${fmt(r)}`) } catch (e) { out(`${label} threw=${e && e.name ? e.name : 'Error'}`) } }
      await tryRead('readTitle', () => host.readTitle({ configs: m.TITLE_CONFIGS }), (r) => `ok=${r.ok}${r.ok ? ' blank=' + r.value.blank : ' refusal=' + r.refusal}`)
      await tryRead('readEdit', () => host.readEdit(), (r) => `ok=${r.ok}${r.ok ? ` empty=${r.value.value === ''}` : ''}`)
      await host.endSession()
      out(`fullCaptureExercised=false`)
      return finish(loc.iconic ? 0 : 1)
    }
    const rows = list.value.rows
    const full = rows.filter((r) => r.rect.h > 0 && r.visibleH >= m.LOCATE_RULES.fullyVisible * r.rect.h)
    const selReadable = rows.filter((r) => r.selected !== null).length
    const selected = rows.filter((r) => r.selected === true).length
    const lineCounts = { R1: 0, R2: 0, R3: 0 }
    let readable = 0
    const locRows = full.map((r) => {
      for (const c of m.ROW_CONFIGS) lineCounts[c] += (r.ocr && r.ocr[c] ? r.ocr[c].length : 0)
      const rds = m.rowReadings(r.ocr, m.ROW_CONFIGS)
      readable += rds.filter((v) => m.isReadable(v, 2)).length
      return { index: r.index, readings: rds }
    })
    const hashesOk = rows.every((r) => typeof r.hash === 'string' && /^[0-9A-F]{64}$/.test(r.hash) || r.visibleH === 0)
    out(`readList ms=${listMs} rows=${rows.length} fullyVisible=${full.length} stable=${list.value.stable} rowHeight=${full[0] ? full[0].rect.h : '-'} selectionReadable=${selReadable}/${rows.length} selected=${selected} ocrLines=${JSON.stringify(lineCounts)} readableReadings=${readable}/${full.length * 3} sha256Hashes=${hashesOk}`)

    const g = await host.readListGeometry()
    const sameGeo = g.ok && full.every((r) => { const x = g.value.rows.find((q) => q.index === r.index); return x && x.hash === r.hash && x.rect.y === r.rect.y })
    out(`readListGeometry ok=${g.ok} sameIndexRectHashAsReadList=${sameGeo} ocrAbsent=${g.ok && g.value.rows.every((r) => !r.ocr)}`)

    const t2 = Date.now()
    const title = await host.readTitle({ configs: m.TITLE_CONFIGS })
    const titleMs = Date.now() - t2
    if (title.ok) {
      const tr = m.titleReadings(title.value.byConfig, title.value.stripRect, m.TITLE_CONFIGS)
      const keep = m.normalizeName('Keep筆記')
      const keepLike = tr.readings.map((v) => (m.isReadable(v, 6) && m.score(v, keep) <= m.IDENTIFY_RULES.maxErr(6) ? 1 : 0))
      out(`readTitle ms=${titleMs} blank=${title.value.blank} stripH=${title.value.stripRect.h} lines=${m.TITLE_CONFIGS.map((c) => (title.value.byConfig[c] || []).length).join('/')} readable=${tr.readings.filter((v) => m.isReadable(v, 2)).length}/3 keepLike(T1/T2/T3)=${keepLike.join('/')}`)
    } else out(`readTitle refusal=${title.refusal}`)

    const edit = await host.readEdit()
    out(`readEdit ok=${edit.ok}${edit.ok ? ` empty=${edit.value.value === ''} hasFocus=${edit.value.hasFocus}` : ''}`)
    await host.endSession()

    // 記憶體內：以 DB 名次推定錨點與位移（只印計數）
    const lo = m.createLineOrder({ cacheFile: path.join(process.env.APPDATA || '', 'line-todo', '.linekey') })
    const snap = await lo.snapshot()
    if (snap.ok) {
      const R = m.orderRStar(snap.value.rows)
      const idx = m.indexOrder(R)
      const { anchors: an, conflictRows } = m.findAnchors(locRows, idx)
      const offs = {}; for (const a of an) offs[a.offset] = (offs[a.offset] || 0) + 1
      out(`anchors=${an.length} conflictRows=${conflictRows.size} offsetHistogram=${JSON.stringify(offs)} unanimous=${Object.keys(offs).length === 1} minAnchorsMet=${an.length >= m.LOCATE_RULES.minAnchors}`)
    } else out(`lineOrder snapshot failed code=${snap.code}`)

    const t = host.telemetry()
    out(`userActivityDuringProbe=${t.activity} fullCaptureExercised=true`)
    await host.dispose()
    return finish(0)
  } catch (err) {
    console.error('[probe-host] ERROR', String(err && err.message ? err.message : err).slice(0, 200))
    return 1
  } finally {
    try { if (host) await host.dispose() } catch (_) {}
    cleanup()
  }
}

if (app && app.whenReady) app.whenReady().then(() => main()).then((c) => app.exit(c))
else main().then((c) => process.exit(c))
