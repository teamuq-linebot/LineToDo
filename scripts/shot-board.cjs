// shot-board.cjs — Electron 截圖驗收 harness（看板 UI）。
//
// 載入「已 build 的 renderer + preload」，但 IPC 由本 harness 直接以 better-sqlite3
// 讀 seeded DB 回應（不 spawn watch_json.py / 不打 qwen），確保在無 LINE / 無金鑰環境
// 也能截到真實渲染畫面。驗證點：renderer 透過真正的 preload contextBridge 把 seeded
// todos 渲染成四欄看板。
//
// 用法：node_modules/.../electron.exe scripts/shot-board.cjs <userDataDir> <outPng> [tab]
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const userDataDir = process.argv[2]
const outPng = process.argv[3] || path.join(userDataDir, 'board.png')
const tab = process.argv[4] || 'board'
if (!userDataDir) {
  console.error('usage: electron shot-board.cjs <userDataDir> <outPng> [tab]')
  process.exit(2)
}
app.setPath('userData', userDataDir)

const projectRoot = path.resolve(__dirname, '..')
const Database = require(path.join(projectRoot, 'node_modules', 'better-sqlite3'))
const db = new Database(path.join(userDataDir, 'line-todo.db'))
db.pragma('foreign_keys = ON')

// ── 最小 IPC：對齊 preload 會 invoke 的通道（只實作看板/設定頁讀的）──
function todoRowToDTO(r) {
  let src = []
  try {
    src = JSON.parse(r.source_msg_ids)
  } catch {}
  return {
    id: r.id, chatId: r.chat_id, bucket: r.bucket, status: r.status,
    title: r.title, detail: r.detail, priority: r.priority, dueAt: r.due_at,
    sourceMsgIds: src, confidence: r.confidence, completionEvidence: r.completion_evidence,
    createdAt: r.created_at, updatedAt: r.updated_at, resolvedAt: r.resolved_at
  }
}
function chatRowToDTO(r) {
  return {
    chatId: r.chat_id, name: r.name, isGroup: r.is_group === 1, blocked: r.blocked === 1,
    blockReason: r.block_reason, firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at
  }
}
function msgRowToDTO(r) {
  return {
    msgId: r.msg_id, chatId: r.chat_id, ts: r.ts, timeIso: r.time_iso,
    direction: r.direction, sender: r.sender, text: r.text, contentType: r.content_type,
    processed: r.processed === 1, ingestedAt: r.ingested_at
  }
}

ipcMain.handle('todos:list', (_e, q = {}) => {
  let sql = 'SELECT * FROM todos'
  const params = []
  if (q.statuses && q.statuses.length) {
    sql += ` WHERE status IN (${q.statuses.map(() => '?').join(',')})`
    params.push(...q.statuses)
  } else {
    sql += " WHERE status != 'dismissed'"
  }
  sql += ' ORDER BY priority ASC, updated_at DESC'
  return db.prepare(sql).all(...params).map(todoRowToDTO)
})
ipcMain.handle('chats:list', (_e, a = {}) => {
  const where = a && a.includeBlocked ? '' : 'WHERE blocked = 0'
  return db.prepare(`SELECT * FROM chats ${where} ORDER BY last_seen_at DESC`).all().map(chatRowToDTO)
})
ipcMain.handle('chats:setBlocked', (_e, a) => {
  db.prepare('UPDATE chats SET blocked=?, block_reason=? WHERE chat_id=?')
    .run(a.blocked ? 1 : 0, a.blocked ? (a.reason || 'manual') : null, a.chatId)
  const r = db.prepare('SELECT * FROM chats WHERE chat_id=?').get(a.chatId)
  return r ? chatRowToDTO(r) : null
})
ipcMain.handle('messages:list', (_e, q = {}) => {
  let sql = 'SELECT * FROM messages'
  const params = []
  if (q.chatId) { sql += ' WHERE chat_id=?'; params.push(q.chatId) }
  sql += ' ORDER BY ts DESC'
  if (q.limit) { sql += ' LIMIT ?'; params.push(q.limit) }
  return db.prepare(sql).all(...params).map(msgRowToDTO)
})
ipcMain.handle('todos:updateStatus', (_e, a) => {
  const term = a.status === 'done' || a.status === 'dismissed'
  db.prepare("UPDATE todos SET status=?, updated_at=?, resolved_at=CASE WHEN ? IN ('done','dismissed') THEN ? ELSE NULL END WHERE id=?")
    .run(a.status, new Date().toISOString(), a.status, term ? new Date().toISOString() : null, a.id)
  const r = db.prepare('SELECT * FROM todos WHERE id=?').get(a.id)
  return r ? todoRowToDTO(r) : null
})
ipcMain.handle('todos:update', (_e, a) => {
  const r = db.prepare('SELECT * FROM todos WHERE id=?').get(a.id)
  return r ? todoRowToDTO(r) : null
})
ipcMain.handle('todos:draftReply', () => ({ error: '截圖環境未啟用 qwen' }))
ipcMain.handle('chats:openOriginal', () => ({ ok: false, error: '截圖環境' }))
ipcMain.handle('pipeline:status', () => ({
  running: true, busy: false, intervalSec: 30, lastRunAt: new Date().toISOString(),
  lineBridge: 'ok', llmStatus: 'disabled', hasApiKey: false, lastError: null
}))
ipcMain.handle('pipeline:runOnce', () => ({
  runId: 's', lineBridge: 'skipped', llmStatus: 'ok', newMsgs: 0, chatsSeen: 0,
  chatsProcessed: 0, chatsSkippedNoise: 0, chatsFailed: 0, todosCreated: 0, todosMerged: 0,
  todosResolvedDone: 0, todosSuggestedDone: 0, createdIds: [], resolvedIds: [], updatedIds: [], note: null
}))
const fakeSettings = () => ({
  pollIntervalSec: 30, concurrency: 2, recentContextLimit: 10,
  blocklist: { nameKeywords: ['官方', '促銷', '股票'], senderKeywords: [], contentTypeNoiseOnly: [7], minTextLenForLLM: 2 },
  hasApiKey: false, apiKeySource: 'none', safeStorageAvailable: true
})
ipcMain.handle('settings:get', () => fakeSettings())
ipcMain.handle('settings:update', () => fakeSettings())
ipcMain.handle('app:openDataFolder', () => ({ ok: true }))
ipcMain.handle('messages:recent', () => [])
ipcMain.handle('line:status', () => ({ state: 'stopped', lastMessageAt: null, messageCount: 0, lastError: null, restarts: 0 }))

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 820, show: false,
    webPreferences: {
      preload: path.join(projectRoot, 'out', 'preload', 'index.js'),
      contextIsolation: true, sandbox: true // 對齊真實 app（window.ts）；sandbox 模式才認此 preload 輸出
    }
  })
  win.webContents.on('console-message', (_e, _lvl, msg) => {
    console.log('[renderer]', msg)
  })
  win.webContents.on('preload-error', (_e, p, err) => {
    console.log('[preload-error]', p, err && err.message)
  })
  await win.loadFile(path.join(projectRoot, 'out', 'renderer', 'index.html'))

  const hasApi = await win.webContents.executeJavaScript('typeof window.api')
  console.log('[shot] typeof window.api =', hasApi)

  // 切到指定分頁（board 預設；settings 時點「設定」tab）
  if (tab !== 'board') {
    await win.webContents.executeJavaScript(`
      (function(){
        const btns = [...document.querySelectorAll('.app-tabs .tab')];
        const target = ${JSON.stringify(tab === 'settings' ? '設定' : tab === 'stream' ? '即時訊息流' : '看板')};
        const b = btns.find(x => x.textContent.trim() === target);
        if (b) b.click();
        return !!b;
      })();
    `)
  }

  // 等 React 渲染 + IPC 回應完成
  await new Promise((r) => setTimeout(r, 1500))

  // 第 5 個參數 'bottom' → 捲到主區底部（看設定頁的逐 chat toggle 清單）
  if (process.argv[5] === 'bottom') {
    await win.webContents.executeJavaScript(
      "document.querySelector('.app-main').scrollTo(0, 99999)"
    )
    await new Promise((r) => setTimeout(r, 400))
  }

  const colCount = await win.webContents.executeJavaScript(
    "document.querySelectorAll('.kb-column').length"
  )
  const cardCount = await win.webContents.executeJavaScript(
    "document.querySelectorAll('.todo-card').length"
  )
  const setFields = await win.webContents.executeJavaScript(
    "JSON.stringify({sections:document.querySelectorAll('.set-section').length, kwChips:document.querySelectorAll('.kw-chip').length, chatToggles:document.querySelectorAll('.chat-toggle-row').length, apiKeyField:document.querySelectorAll('.set-keyrow').length})"
  )
  console.log('[shot] settingsDom=' + setFields)
  const img = await win.webContents.capturePage()
  fs.writeFileSync(outPng, img.toPNG())
  console.log(`[shot] tab=${tab} columns=${colCount} cards=${cardCount} -> ${outPng}`)

  // 第 6 個參數 'action' → 點第一張卡的「完成」鈕，驗證 IPC 狀態轉移有落 DB。
  if (process.argv[6] === 'action' && tab === 'board') {
    const before = db.prepare("SELECT COUNT(*) n FROM todos WHERE status='done'").get().n
    await win.webContents.executeJavaScript(
      "[...document.querySelectorAll('.todo-card:not(.done):not(.suggested) .ok-btn')][0]?.click()"
    )
    await new Promise((r) => setTimeout(r, 600))
    const after = db.prepare("SELECT COUNT(*) n FROM todos WHERE status='done'").get().n
    console.log(`[shot] action: done count ${before} -> ${after}`)
  }

  db.close()
  app.quit()
})
