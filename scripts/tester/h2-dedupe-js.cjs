// H2 複驗（JS / App 端）：證明「同 chat/同 ts/同 text、_id 不同」兩列
// 經 App 端 deriveMsgId + insertMessages(INSERT OR IGNORE) 不再被當重複丟掉。
//
// 讀 h2_msgid_python.py 產出的 h2_rows.json（真正由 watch_json.row_to_obj 產的物件），
// 餵真正的 messages.repo.insertMessages（非重寫），斷言 inserted=2。
// 反證：把同兩列的 msgId 清空（模擬舊版只用 hash）→ 同批撞鍵 → inserted=1（被吃掉）。
// 由 `npx electron scripts/tester/h2-dedupe-js.cjs` 執行。

const { app } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const esbuild = require('esbuild')

const ENTRY = `
export { deriveMsgId } from './src/main/db/schema.ts'
export { getDb, closeDb } from './src/main/db/database.ts'
export { insertMessages, countMessages, listMessages } from './src/main/db/messages.repo.ts'
`

app.whenReady().then(async () => {
  const root = path.join(__dirname, '..', '..')
  const entryFile = path.join(root, '__h2_entry.ts')
  const outFile = path.join(root, '__h2.bundle.cjs')
  const cleanup = () => {
    try { fs.rmSync(entryFile, { force: true }) } catch (_) {}
    try { fs.rmSync(outFile, { force: true }) } catch (_) {}
  }
  try {
    const rowsPath = path.join(__dirname, 'h2_rows.json')
    const rows = JSON.parse(fs.readFileSync(rowsPath, 'utf8'))
    const { a, b, c } = rows

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-todo-h2-'))
    process.env.LINE_TODO_DB_PATH = path.join(tmpDir, 'line-todo.db')

    fs.writeFileSync(entryFile, ENTRY, 'utf8')
    await esbuild.build({
      entryPoints: [entryFile], bundle: true, platform: 'node', format: 'cjs',
      outfile: outFile, external: ['electron', 'better-sqlite3', 'openai'],
      absWorkingDir: root, logLevel: 'silent'
    })
    const m = require(outFile)
    m.getDb()

    // RawLineMessage 形狀（messages.repo 期望 .chat/.chatId/.isGroup/.ts/.time/.direction/.sender/.text/.contentType/.msgId）
    // h2_rows.json 已是該形狀（watch_json NDJSON 契約一致），直接用。
    const A = a, B = b

    // ── deriveMsgId：A/B 應得不同 i: 鍵 ──
    const keyA = m.deriveMsgId(A)
    const keyB = m.deriveMsgId(B)
    console.log('[h2js] deriveMsgId(A)=' + keyA)
    console.log('[h2js] deriveMsgId(B)=' + keyB)

    // 反證：若無 msgId（舊版），A/B 會撞成同一 d: 鍵
    const A_noid = { ...A, msgId: null }
    const B_noid = { ...B, msgId: null }
    const keyA_old = m.deriveMsgId(A_noid)
    const keyB_old = m.deriveMsgId(B_noid)
    console.log('[h2js] OLD deriveMsgId(A no _id)=' + keyA_old)
    console.log('[h2js] OLD deriveMsgId(B no _id)=' + keyB_old)

    // ── 端到端：insertMessages 同批兩列（新版，有 msgId）→ 應 inserted=2 ──
    const res = m.insertMessages([A, B])
    console.log('[h2js] insertMessages(new) attempted=' + res.attempted + ' inserted=' + res.inserted + ' countMessages=' + m.countMessages())

    // ── 反證：另開 temp DB，灌「無 msgId」同兩列 → 舊行為撞鍵 → inserted=1 ──
    m.closeDb()
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'line-todo-h2old-'))
    process.env.LINE_TODO_DB_PATH = path.join(tmpDir2, 'line-todo.db')
    m.getDb()
    const resOld = m.insertMessages([A_noid, B_noid])
    console.log('[h2js] insertMessages(OLD no _id) attempted=' + resOld.attempted + ' inserted=' + resOld.inserted + ' countMessages=' + m.countMessages())

    // ── 斷言 ──
    const checks = {
      newKeysDistinct: keyA !== keyB && keyA.startsWith('i:') && keyB.startsWith('i:'),
      oldKeysCollide: keyA_old === keyB_old && keyA_old.startsWith('d:'), // 舊法撞鍵（漏吃證明）
      newInsertedBoth: res.attempted === 2 && res.inserted === 2,         // 新版：兩列都落庫
      oldInsertedOne: resOld.inserted === 1                                // 舊版：被吃掉成一筆
    }
    const ok = Object.values(checks).every(Boolean)
    console.log('[h2js] checks=' + JSON.stringify(checks))
    console.log('[h2js] ALL-ASSERTIONS-PASS=' + ok)

    m.closeDb()
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
    try { fs.rmSync(tmpDir2, { recursive: true, force: true }) } catch (_) {}
    cleanup()
    app.exit(ok ? 0 : 1)
  } catch (err) {
    console.error('[h2js] FAILED: ' + (err && err.stack ? err.stack : err))
    cleanup()
    app.exit(1)
  }
})
