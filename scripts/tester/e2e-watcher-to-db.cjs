// e2e-watcher-to-db.cjs — TESTER acceptance harness (does NOT modify app source).
//
// Drives the *real* production code path: LineWatcher (spawns the real
// watch_json.py --follow) -> insertMessage() -> real better-sqlite3 DB.
//
// Proves acceptance points (1) sidecar yields LINE messages AND they get written
// to the `messages` table, and (2) SQLite actually has rows.
//
// Method:
//   - esbuild-bundle the REAL src modules (LineWatcher + database + messages.repo),
//     external electron/better-sqlite3 (Electron runtime provides them).
//   - temp userData DB via LINE_TODO_DB_PATH.
//   - Seed line-cua-win/.watch_json_state with an OLD last_ts so the very first
//     --follow poll emits a backlog of real recent LINE messages (otherwise the
//     stat-gate / fresh-checkpoint would emit 0). We BACK UP and RESTORE the
//     original checkpoint so we don't disturb the user's real App state.
//   - Wire watcher 'message' -> insertMessage (exactly like main/index.ts does).
//   - Run ~20s, then report counts + samples from the DB.
//
// Run: npx electron scripts/tester/e2e-watcher-to-db.cjs
const { app } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const esbuild = require('esbuild')

const ROOT = path.resolve(__dirname, '..', '..')
const LINE_REPO = path.join(ROOT, 'line-cua-win')
const STATE_FILE = path.join(LINE_REPO, '.watch_json_state')

const ENTRY = `
export { LineWatcher } from './src/main/line/watcher.ts'
export { getDb, closeDb } from './src/main/db/database.ts'
export { insertMessage, countMessages, listMessages } from './src/main/db/messages.repo.ts'
export { listChats } from './src/main/db/chats.repo.ts'
`

app.whenReady().then(async () => {
  const entryFile = path.join(ROOT, '__e2e_watcher_entry.ts')
  const outFile = path.join(ROOT, '__e2e_watcher.bundle.cjs')
  let stateBackup = null
  let hadState = false

  const cleanup = () => {
    try { fs.rmSync(entryFile, { force: true }) } catch {}
    try { fs.rmSync(outFile, { force: true }) } catch {}
    // restore the user's real checkpoint
    try {
      if (hadState && stateBackup !== null) fs.writeFileSync(STATE_FILE, stateBackup)
      else if (!hadState) fs.rmSync(STATE_FILE, { force: true })
    } catch (e) { console.error('[e2e] state restore failed:', e) }
  }

  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-todo-e2e-'))
    process.env.LINE_TODO_DB_PATH = path.join(tmpDir, 'line-todo.db')

    // Back up real checkpoint, then seed an OLD last_ts to force a backlog emit.
    try {
      stateBackup = fs.readFileSync(STATE_FILE, 'utf8'); hadState = true
    } catch { hadState = false }
    const sinceMs = Date.now() - 2 * 24 * 3600 * 1000 // 2 days ago
    fs.writeFileSync(STATE_FILE, JSON.stringify({ last_ts: sinceMs, sig: null }))
    console.log('[e2e] seeded checkpoint last_ts=' + sinceMs + ' (hadOriginal=' + hadState + ')')

    fs.writeFileSync(entryFile, ENTRY, 'utf8')
    await esbuild.build({
      entryPoints: [entryFile], bundle: true, platform: 'node', format: 'cjs',
      outfile: outFile, external: ['electron', 'better-sqlite3'],
      absWorkingDir: ROOT, logLevel: 'silent'
    })
    const m = require(outFile)
    m.getDb()
    console.log('[e2e] db-ready=' + process.env.LINE_TODO_DB_PATH)
    console.log('[e2e] initial countMessages=' + m.countMessages())

    const watcher = new m.LineWatcher({
      python: path.join(LINE_REPO, '.venv', 'Scripts', 'python.exe'),
      script: path.join(LINE_REPO, 'src', 'watch_json.py'),
      intervalSec: 5,
      limit: 80
    })

    let received = 0
    let insertedTotal = 0
    let firstMsgSample = null
    const statuses = []

    watcher.on('status', (s) => { statuses.push(s.state) })
    watcher.on('log', (l) => { if (/error|fatal|exit/i.test(l)) console.log('[e2e][watcher-log]', l) })
    watcher.on('message', (msg) => {
      received += 1
      if (!firstMsgSample) firstMsgSample = msg
      // EXACTLY mirrors main/index.ts: persist each live message.
      try {
        const res = m.insertMessage(msg)
        insertedTotal += res.inserted
      } catch (e) {
        console.error('[e2e] insertMessage failed:', e)
      }
    })

    watcher.start()
    console.log('[e2e] watcher started; collecting for ~20s ...')

    await new Promise((r) => setTimeout(r, 20000))
    watcher.stop()

    // Report from the REAL DB.
    const cm = m.countMessages()
    const chats = m.listChats({ includeBlocked: true })
    const sample = m.listMessages({ limit: 5 })
    console.log('[e2e] watcher.received(events)=' + received)
    console.log('[e2e] insert.inserted(rows)=' + insertedTotal)
    console.log('[e2e] DB countMessages=' + cm)
    console.log('[e2e] DB countChats=' + chats.length)
    console.log('[e2e] statuses=' + JSON.stringify([...new Set(statuses)]))
    if (firstMsgSample) {
      console.log('[e2e] firstMsgSample=' + JSON.stringify({
        chat: firstMsgSample.chat, chatId: firstMsgSample.chatId.slice(0, 10) + '...',
        ts: firstMsgSample.ts, dir: firstMsgSample.direction, sender: firstMsgSample.sender,
        text: (firstMsgSample.text || '').slice(0, 24)
      }))
    }
    console.log('[e2e] DB.messages.sample=' + JSON.stringify(sample.map((r) => ({
      chatId: r.chatId.slice(0, 8) + '..', dir: r.direction, text: (r.text || '').slice(0, 18), processed: r.processed
    }))))

    const pass = cm > 0 && cm === insertedTotal && chats.length > 0
    console.log('[e2e] PASS=' + pass)

    m.closeDb()
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    cleanup()
    app.exit(pass ? 0 : 1)
  } catch (err) {
    console.error('[e2e] FAILED: ' + (err && err.stack ? err.stack : err))
    cleanup()
    app.exit(1)
  }
})
