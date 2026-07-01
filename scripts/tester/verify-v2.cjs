// 加強驗證（v2）：純讀 App 真實 DB 做指標筆查 + 統計，最後做一筆 todos:update edit smoke
// （透過真 updateTodo 後端：改某 todo 的 bucket → 再讀回確認 DB 真的變，然後改回原值）。
// 對齊 App 身份。除了 edit smoke 的兩次 update 外不寫入。
// 執行：electron scripts/tester/verify-v2.cjs
const { app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const esbuild = require('esbuild')

app.setName('line-todo')
try { app.setPath('userData', path.join(app.getPath('appData'), 'line-todo')) } catch (_) {}

// 用真 repo 的 updateTodo（走 App 後端，等同 todos:update IPC 呼叫的函式）。
const ENTRY = `
export { getDb, closeDb } from './src/main/db/database.ts'
export { listTodos, getTodo, updateTodo, countTodos } from './src/main/db/todos.repo.ts'
export { countMessages, getByChatSince } from './src/main/db/messages.repo.ts'
export { getLastRun } from './src/main/db/pipeline.repo.ts'
`

app.whenReady().then(async () => {
  const root = path.join(__dirname, '..', '..')
  const entryFile = path.join(root, '__verify_entry.ts')
  const outFile = path.join(root, '__verify.bundle.cjs')
  const cleanup = () => {
    try { fs.rmSync(entryFile, { force: true }) } catch (_) {}
    try { fs.rmSync(outFile, { force: true }) } catch (_) {}
  }
  let m = null
  try {
    fs.writeFileSync(entryFile, ENTRY, 'utf8')
    await esbuild.build({
      entryPoints: [entryFile], bundle: true, platform: 'node', format: 'cjs',
      outfile: outFile, external: ['electron', 'better-sqlite3', 'openai'],
      absWorkingDir: root, logLevel: 'silent'
    })
    m = require(outFile)
    m.getDb()

    const all = m.listTodos({})
    console.log('[v2] TOTAL todos=' + all.length + ' messages=' + m.countMessages())

    // ── 統計 ──
    const bucket = {}; const status = {}
    let emptyTitle = 0
    for (const t of all) {
      bucket[t.bucket] = (bucket[t.bucket] || 0) + 1
      status[t.status] = (status[t.status] || 0) + 1
      const tt = (t.title || '').trim()
      if (!tt || ['title', '代辦', '待辦', '事項'].includes(tt)) emptyTitle += 1
    }
    console.log('[v2] BUCKET=' + JSON.stringify(bucket))
    console.log('[v2] STATUS=' + JSON.stringify(status))
    const doneish = (status.done || 0) + (status.suggested_done || 0)
    console.log('[v2] DONE+SUGGESTED=' + doneish + ' (完成偵測作用指標, 應>0)')
    console.log('[v2] EMPTY-OR-PLACEHOLDER-TITLE=' + emptyTitle + ' (應=0)')

    // ── 指標筆查 1：組聚（6/29 流量變現組）應為 schedule ──
    const meetup = all.filter((t) => /組聚|流量變現|6\/29|6月29/.test(t.title) ||
      /6\/29|06\/29|06-29|2026-06-29/.test(t.dueAt || ''))
    console.log('[v2] 組聚-RELATED count=' + meetup.length)
    for (const t of meetup) {
      console.log('  [meetup] ' + JSON.stringify({ bucket: t.bucket, status: t.status, due: t.dueAt, title: t.title }))
    }
    const meetupSchedule = meetup.filter((t) => t.bucket === 'schedule')
    console.log('[v2] 組聚-as-SCHEDULE=' + meetupSchedule.length + '/' + meetup.length)

    // ── 指標筆查 2：所有「有 dueAt 的活動類（參加/出席/報名/聚/會/餐會）」分類正確率 ──
    const eventLike = all.filter((t) => t.dueAt && /參加|出席|報名|受邀|聚|餐會|會議|大會|茶敘|年會/.test(t.title))
    const eventSched = eventLike.filter((t) => t.bucket === 'schedule')
    console.log('[v2] EVENT-LIKE(有dueAt+活動詞) total=' + eventLike.length + ' asSchedule=' + eventSched.length)
    for (const t of eventLike) {
      console.log('  [event] ' + JSON.stringify({ bucket: t.bucket, due: t.dueAt, title: t.title }))
    }

    // ── 大群覆蓋：找窗口內訊息量最大的 chat，確認該 chat 有抽到 todo（B2 生效）──
    const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000
    const chatIds = [...new Set(all.map((t) => t.chatId))]
    // 找全 DB 中窗口訊息最多的前 5 chat
    const Database = require('better-sqlite3')
    const rdb = new Database(path.join(app.getPath('userData'), 'line-todo.db'), { readonly: true })
    const bigChats = rdb.prepare(
      'SELECT m.chat_id, COUNT(*) n, c.blocked FROM messages m JOIN chats c ON c.chat_id=m.chat_id WHERE m.ts>=? AND c.blocked=0 GROUP BY m.chat_id ORDER BY n DESC LIMIT 5'
    ).all(sinceMs)
    console.log('[v2] TOP-5-BIG-CHATS(window, not blocked)=' + JSON.stringify(bigChats))
    for (const bc of bigChats) {
      const todosInChat = all.filter((t) => t.chatId === bc.chat_id)
      // 抽到的 todo 其來源訊息最早日期（驗 B2：能抽到較舊日期的代辦）
      let earliestSrcTs = null
      for (const t of todosInChat) {
        for (const sid of t.sourceMsgIds) {
          const r = rdb.prepare('SELECT ts FROM messages WHERE msg_id=?').get(sid)
          if (r && (earliestSrcTs === null || r.ts < earliestSrcTs)) earliestSrcTs = r.ts
        }
      }
      console.log('  [big] chat=' + bc.chat_id + ' winMsgs=' + bc.n + ' todos=' + todosInChat.length +
        ' earliestSrcDate=' + (earliestSrcTs ? new Date(earliestSrcTs).toISOString() : '(none)'))
    }
    rdb.close()

    // ── EDIT SMOKE：對任一 todo 改 bucket → 確認 DB 真的變 → 改回 ──
    if (all.length > 0) {
      const target = all[0]
      const orig = target.bucket
      const newBucket = orig === 'todo' ? 'schedule' : 'todo'
      const upd = m.updateTodo(target.id, { bucket: newBucket })
      const readBack = m.getTodo(target.id)
      const changed = !!upd && readBack && readBack.bucket === newBucket && readBack.bucket !== orig
      console.log('[v2] EDIT-SMOKE id=' + target.id + ' orig=' + orig + ' set=' + newBucket +
        ' readBack=' + (readBack && readBack.bucket) + ' updatedAtChanged=' + (upd && upd.updatedAt !== target.updatedAt) +
        ' OK=' + changed)
      // 改回原值（不污染最終看板截圖）
      const restored = m.updateTodo(target.id, { bucket: orig })
      console.log('[v2] EDIT-SMOKE restored bucket=' + (restored && restored.bucket) + ' (back to ' + orig + ')')
    } else {
      console.log('[v2] EDIT-SMOKE SKIPPED (no todos)')
    }

    console.log('[v2] LAST-RUN=' + JSON.stringify(m.getLastRun()))
    m.closeDb()
    cleanup()
    app.exit(0)
  } catch (err) {
    console.error('[v2] FAILED: ' + (err && err.stack ? err.stack : err))
    try { m && m.closeDb && m.closeDb() } catch (_) {}
    cleanup()
    app.exit(1)
  }
})
