// 一次性實跑：用「現行金鑰」讓 App 自己跑過去 7 天（reviewLastDays(7)），
// 走完全真實路徑（真 qwen client + 真 watch_json.py --since + App 真實 userData DB / keyPath），
// 證明 todos 真的被 qwen 判出來並寫進 App 的 SQLite。
//
// 與 probe-pipeline-dryrun.cjs 的差異（關鍵）：
//   - 不設 LINE_TODO_DB_PATH → 用 App 預設 userData/line-todo.db（真實 DB）。
//   - 不注入 extractFn / fetchWindow → reviewLastDays 用預設 makeQwenExtractFn()(真 qwen)
//     與 spawnSinceSource(真 spawn watch_json.py --since)。
//   - 金鑰：讀 eval/.qwen-key → 用 App 自己的 setApiKey()(safeStorage 加密)寫進真實 keyPath，
//     並 setSafeStorageReader(readApiKeyFromSafeStorage) 注入，確認 getQwenConfig source=safeStorage。
//   - monkey-patch OpenAI.chat.completions.create 計數 qwen 呼叫次數 / 計時 / 抓錯誤。
//
// 金鑰全程遮罩（7te8…Ak）。執行：electron scripts/tester/run-review-real.cjs

const { app, safeStorage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const esbuild = require('esbuild')
const OpenAI = require('openai')

// ⚠️ 關鍵：直接用 `electron <script>` 跑時，Electron 不會讀 App package.json 的 name，
// app.getPath('userData') 會回退到預設 "Electron" 目錄 → 寫到「錯的」DB / keyPath。
// GUI App 的 package.json name = "line-todo"，故在 whenReady 之前對齊 App 身份，
// 確保金鑰與 DB 落在 GUI App 真正使用的 userData（...\Roaming\line-todo）。
app.setName('line-todo')
try { app.setPath('userData', path.join(app.getPath('appData'), 'line-todo')) } catch (_) {}

function maskKey(k) {
  if (!k || typeof k !== 'string') return '(none)'
  const s = k.trim()
  if (s.length <= 6) return '***'
  return s.slice(0, 4) + '…' + s.slice(-2)
}

// 把 App main 的真實函式 re-export 成 CJS bundle（external runtime 提供的原生/重模組）。
const ENTRY = `
export { reviewLastDays } from './src/main/pipeline/backfill.ts'
export { getQwenConfig, hasQwenKey, setSafeStorageReader } from './src/main/config/qwen.ts'
export { setApiKey, readApiKeyFromSafeStorage, hasSafeStorageKey, isSafeStorageAvailable } from './src/main/config/settings.ts'
export { getDb, closeDb } from './src/main/db/database.ts'
export { listTodos, countTodos } from './src/main/db/todos.repo.ts'
export { getLastRun } from './src/main/db/pipeline.repo.ts'
`

app.whenReady().then(async () => {
  const root = path.join(__dirname, '..', '..') // scripts/tester → repo root
  const entryFile = path.join(root, '__review_entry.ts')
  const outFile = path.join(root, '__review.bundle.cjs')
  const cleanup = () => {
    try { fs.rmSync(entryFile, { force: true }) } catch (_) {}
    try { fs.rmSync(outFile, { force: true }) } catch (_) {}
  }
  let m = null

  // ── qwen 呼叫計數器（monkey-patch，外掛在真實 OpenAI 上）────────────
  const qstat = { calls: 0, ok: 0, err: 0, totalMs: 0, errors: [] }
  const origCreate = OpenAI.Chat.Completions.prototype.create
  OpenAI.Chat.Completions.prototype.create = function patched(...args) {
    const started = Date.now()
    qstat.calls += 1
    let p
    try {
      p = origCreate.apply(this, args)
    } catch (e) {
      qstat.err += 1
      qstat.errors.push(String(e && e.message ? e.message : e))
      throw e
    }
    if (p && typeof p.then === 'function') {
      return p.then(
        (res) => { qstat.ok += 1; qstat.totalMs += Date.now() - started; return res },
        (e) => {
          qstat.err += 1
          qstat.totalMs += Date.now() - started
          qstat.errors.push(String(e && e.message ? e.message : e))
          throw e
        }
      )
    }
    qstat.ok += 1
    qstat.totalMs += Date.now() - started
    return p
  }

  try {
    const userData = app.getPath('userData')
    console.log('[review] userData=' + userData)
    console.log('[review] dbPath=' + path.join(userData, 'line-todo.db'))
    console.log('[review] keyPath=' + path.join(userData, 'qwen.key'))
    console.log('[review] LINE_TODO_DB_PATH override=' + (process.env.LINE_TODO_DB_PATH || '(unset, using userData)'))

    // 確保不被 env 金鑰污染來源判定（我們要證明走 safeStorage）。
    delete process.env.QWEN_API_KEY

    fs.writeFileSync(entryFile, ENTRY, 'utf8')
    await esbuild.build({
      entryPoints: [entryFile], bundle: true, platform: 'node', format: 'cjs',
      outfile: outFile, external: ['electron', 'better-sqlite3', 'openai'],
      absWorkingDir: root, logLevel: 'silent'
    })
    m = require(outFile)

    // ── 步驟 1：金鑰進 App safeStorage（用 App 自己的機制）──────────────
    console.log('[review] safeStorage.available=' + safeStorage.isEncryptionAvailable())
    const keyFile = path.join(root, 'eval', '.qwen-key')
    const rawKey = fs.readFileSync(keyFile, 'utf8').trim()
    console.log('[review] eval/.qwen-key loaded mask=' + maskKey(rawKey) + ' len=' + rawKey.length)

    // 用 App 自己的 setApiKey()（safeStorage.encryptString → 寫真實 keyPath()）。
    m.setApiKey(rawKey)
    console.log('[review] setApiKey() done → hasSafeStorageKey=' + m.hasSafeStorageKey())

    // 注入 reader（正式 App 在 whenReady 做的事），讓 getQwenConfig 走 safeStorage。
    m.setSafeStorageReader(m.readApiKeyFromSafeStorage)
    const cfg = m.getQwenConfig()
    console.log('[review] getQwenConfig source=' + cfg.source + ' hasApiKey=' + (cfg.apiKey !== null) +
      ' baseURL=' + cfg.baseURL + ' model=' + cfg.model + ' keyMask=' + maskKey(cfg.apiKey))
    if (cfg.source !== 'safeStorage' || cfg.apiKey === null) {
      throw new Error('金鑰未經 safeStorage 生效（source=' + cfg.source + '）')
    }

    // ── 跑前 DB 基準（真實 userData DB）──────────────────────────────
    m.getDb()
    const before = {
      todos: m.countTodos(),
      lastRun: m.getLastRun()
    }
    console.log('[review] BEFORE countTodos=' + before.todos +
      ' lastRunId=' + (before.lastRun ? before.lastRun.id : '(none)'))

    // ── 步驟 2：實跑 reviewLastDays(7)（真 qwen + 真 watch_json --since）──
    const t0 = Date.now()
    let progressLast = null
    const res = await m.reviewLastDays(7, {
      onProgress: (p) => {
        // 節流：只在 phase 變化或每 +5 chat 印一次，避免洗版。
        if (!progressLast || progressLast.phase !== p.phase ||
            (p.total > 0 && p.processed - (progressLast.processed || 0) >= 5) ||
            p.phase === 'done') {
          console.log('[review] progress phase=' + p.phase + ' ' + p.processed + '/' + p.total)
          progressLast = { phase: p.phase, processed: p.processed }
        }
      }
    })
    const elapsedMs = Date.now() - t0

    // ── 步驟 3：驗證 evidence ────────────────────────────────────────
    console.log('[review] RESULT=' + JSON.stringify({
      ok: res.ok, hasApiKey: res.hasApiKey, days: res.days,
      sinceMs: res.sinceMs, sinceIso: new Date(res.sinceMs).toISOString(),
      newMsgs: res.newMsgs, chatsSeen: res.chatsSeen, chatsProcessed: res.chatsProcessed,
      chatsSkippedNoise: res.chatsSkippedNoise, chatsFailed: res.chatsFailed,
      todosCreated: res.todosCreated, todosMerged: res.todosMerged,
      todosResolvedDone: res.todosResolvedDone, todosSuggestedDone: res.todosSuggestedDone,
      note: res.note
    }))

    const after = {
      todos: m.countTodos(),
      lastRun: m.getLastRun()
    }

    // bucket 分佈（全表）+ 本次新建 todos 抽樣
    const allTodos = m.listTodos({})
    const dist = { todo: 0, waiting: 0, schedule: 0 }
    for (const t of allTodos) {
      if (dist[t.bucket] !== undefined) dist[t.bucket] += 1
    }
    const statusDist = {}
    for (const t of allTodos) statusDist[t.status] = (statusDist[t.status] || 0) + 1

    const createdSet = new Set(res.createdIds || [])
    const createdSample = allTodos
      .filter((t) => createdSet.has(t.id))
      .slice(0, 12)
      .map((t) => ({ chat: t.chatId, bucket: t.bucket, status: t.status, title: t.title, due: t.dueAt, conf: t.confidence }))

    console.log('[review] DB-AFTER countTodos=' + after.todos + ' (before=' + before.todos + ', delta=' + (after.todos - before.todos) + ')')
    console.log('[review] BUCKET-DIST(all-open+closed)=' + JSON.stringify(dist))
    console.log('[review] STATUS-DIST(all)=' + JSON.stringify(statusDist))
    console.log('[review] CREATED-SAMPLE=' + JSON.stringify(createdSample))
    console.log('[review] PIPELINE-RUN(last)=' + JSON.stringify(after.lastRun))

    console.log('[review] QWEN-STATS calls=' + qstat.calls + ' ok=' + qstat.ok + ' err=' + qstat.err +
      ' totalMs=' + qstat.totalMs + ' avgMs=' + (qstat.calls ? Math.round(qstat.totalMs / qstat.calls) : 0))
    if (qstat.errors.length) {
      console.log('[review] QWEN-ERRORS(' + qstat.errors.length + ')=' + JSON.stringify(qstat.errors.slice(0, 8)))
    } else {
      console.log('[review] QWEN-ERRORS=(none)')
    }
    console.log('[review] ELAPSED-TOTAL-MS=' + elapsedMs + ' (' + (elapsedMs / 1000).toFixed(1) + 's)')

    // 抽出總筆數（qwen 判出，含 merge 的） = created + merged + resolvedDone + suggestedDone
    const extractedTotal = res.todosCreated + res.todosMerged + res.todosResolvedDone + res.todosSuggestedDone
    console.log('[review] QWEN-EXTRACTED-TOTAL(created+merged+done+suggested)=' + extractedTotal)

    const verdict = {
      keyViaSafeStorage: cfg.source === 'safeStorage',
      ran: res.hasApiKey === true,
      wroteTodos: res.todosCreated > 0 || after.todos > before.todos,
      hasPipelineRun: !!after.lastRun && after.lastRun.note && after.lastRun.note.indexOf('backfill') >= 0
    }
    console.log('[review] VERDICT=' + JSON.stringify(verdict))

    m.closeDb()
    cleanup()
    app.exit(0)
  } catch (err) {
    console.error('[review] FAILED: ' + (err && err.stack ? err.stack : err))
    try { m && m.closeDb && m.closeDb() } catch (_) {}
    cleanup()
    app.exit(1)
  }
})
