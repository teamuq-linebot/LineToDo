// probe-breaker —— Batch 7「provider 級熔斷 + per-chat 指數退避」的可執行驗證。
//
// 用「真正的」PipelineScheduler + runOnce + repos（非重寫），只注入兩樣東西：
//   1) 會計數的假 extractFn（取代真 provider）→ 「冷卻期間沒有任何 provider 呼叫」
//      這件事直接用呼叫次數證明，不是用宣稱的。CLI provider 下一次呼叫 = 一次進程 spawn，
//      所以「呼叫數 0」就等於「spawn 數 0」。
//   2) 假時鐘的 ProviderBreaker / ChatBackoff → 冷卻到期不必真的等 15 分鐘。
//
// 場景：
//   S0 正常路徑不誤傷（連跑 3 輪成功 → 熔斷器保持關閉、連續全滅計數 0）
//   S1 可重試錯誤全滅 → 第 1 輪不熔斷（避免一次抖動就鎖 15 分鐘）、第 2 輪熔斷
//   S2 冷卻期間零呼叫，且訊息**沒有**被標成已處理（解除後還抽得到）
//   S3 冷卻到期自動恢復
//   S4 不可重試錯誤（not_authenticated）第一輪就熔斷
//   S5 使用者按「立即執行」（triggerNow 預設 userInitiated）立刻解除
//   S6 設定變更（notifySettingsChanged）立刻解除
//   S7 熔斷狀態用既有欄位呈現：llmStatus='disabled' + lastError 含原因/剩餘時間/解除方式
//   S8 per-chat 退避：10 個裡壞 1 個時熔斷器不動作，該 chat 由退避節流
//
// 由 `npx electron scripts/probe-breaker.cjs` 執行（npm run probe:breaker）。

const { app } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const esbuild = require('esbuild')

const ENTRY = `
export { PipelineScheduler } from './src/main/pipeline/scheduler.ts'
export { ProviderBreaker, ChatBackoff, BREAKER_COOLDOWN_MS } from './src/main/pipeline/breaker.ts'
export { LlmProviderError } from './src/main/llm/provider/types.ts'
export { getDb, closeDb } from './src/main/db/database.ts'
export { getPipelineDefaults } from './src/main/config/defaults.ts'
export { countMessages, getUnprocessedForPipeline } from './src/main/db/messages.repo.ts'
export { makeHttpProvider } from './src/main/llm/provider/httpOpenAi.ts'
`

// 三個普通 1:1 聊天室（名稱不含「官方」等自動黑名單關鍵字）。
const CHATS = [
  { chatId: 'uprobe1', name: 'Abby' },
  { chatId: 'uprobe2', name: 'Ben' },
  { chatId: 'uprobe3', name: 'Cara' }
]
const FAIL_CHAT = 'uprobe2'
const BASE_TS = 1719381600000

function msgsForRound(round) {
  return CHATS.map((c, i) => ({
    msgId: 'probe-brk-' + c.chatId + '-r' + round,
    chat: c.name,
    chatId: c.chatId,
    isGroup: false,
    ts: BASE_TS + round * 60000 + i * 1000,
    time: '2026-06-26T15:40:00',
    direction: 'in',
    sender: c.name,
    text: '幫我把報價單下午寄出，順便確認金額',
    contentType: 0
  }))
}

const failures = []
function check(name, cond, extra) {
  const line = (cond ? '[PASS] ' : '[FAIL] ') + name + (extra ? ' :: ' + extra : '')
  console.log('[probe-brk] ' + line)
  if (!cond) failures.push(name)
}

/**
 * S9：假 OpenAI 相容端點 → 驗證 httpOpenAi 的 error code 對映。
 * 每個 case 指定要回的狀態碼與 body，跑真的 provider.complete()，檢查拋出的
 * LlmProviderError.code，並確認 userMessage 仍含原始端點訊息（資訊只增不減）。
 */
async function runHttpMappingChecks(m) {
  const http = require('node:http')
  let scenario = null
  const server = http.createServer((req, res) => {
    res.writeHead(scenario.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: scenario.message, type: scenario.type, code: scenario.code } }))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  const provider = m.makeHttpProvider({
    apiKey: 'probe-fake-key-not-used',
    baseURL: 'http://127.0.0.1:' + port + '/v1',
    model: 'probe-model',
    timeoutMs: 8000,
    maxRetries: 0
  })

  const cases = [
    { name: '401 → not_authenticated', status: 401, message: 'Incorrect API key provided: sk-xxx', code: 'invalid_api_key', expect: 'not_authenticated' },
    { name: '403 → not_authenticated', status: 403, message: 'Country not supported', code: null, expect: 'not_authenticated' },
    { name: '429 → rate_limited（可重試，不熔斷）', status: 429, message: 'Rate limit reached for gpt-4 in org org-1', code: 'rate_limit_exceeded', expect: 'rate_limited' },
    { name: '429+insufficient_quota → quota_exceeded（不可重試，熔斷）', status: 429, message: 'You exceeded your current quota', code: 'insufficient_quota', expect: 'quota_exceeded' },
    { name: '500 → 不分類，原樣往上拋（維持 Batch 1 行為）', status: 500, message: 'internal server error', code: null, expect: null }
  ]

  for (const c of cases) {
    scenario = c
    let thrown = null
    try {
      await provider.complete({ system: 's', user: 'u', temperature: 0.1 })
    } catch (e) {
      thrown = e
    }
    const isProviderErr = thrown instanceof m.LlmProviderError
    if (c.expect === null) {
      check('S9 ' + c.name, !!thrown && !isProviderErr, thrown && thrown.constructor.name)
    } else {
      check('S9 ' + c.name, isProviderErr && thrown.code === c.expect,
        (isProviderErr ? thrown.code : String(thrown && thrown.constructor.name)))
      check('S9 ' + c.name + ' 保留原始端點訊息',
        isProviderErr && thrown.message.indexOf(c.message) >= 0, isProviderErr ? thrown.message : '')
    }
  }

  // 連不上（server 已關）→ transport，仍可重試、不該立刻熔斷。
  await new Promise((r) => server.close(r))
  let connErr = null
  try {
    await provider.complete({ system: 's', user: 'u', temperature: 0.1 })
  } catch (e) {
    connErr = e
  }
  check('S9 連線失敗 → transport（可重試）',
    connErr instanceof m.LlmProviderError && connErr.code === 'transport',
    connErr && (connErr.code || connErr.constructor.name))
}

// userData 導到 temp：讓 settings.json 走乾淨預設（aiProvider='http'），不污染真實 app 資料。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-todo-brk-'))
app.setPath('userData', tmpDir)
process.env.LINE_TODO_DB_PATH = path.join(tmpDir, 'line-todo.db')
// 讓 isProviderConfigured() 回 true（hasApiKey），才能觀察到「llmStatus 因熔斷而 disabled」
// 而不是「因為沒金鑰所以 disabled」。這把假金鑰永遠不會被使用（extractFn 已注入）。
process.env.QWEN_API_KEY = 'probe-fake-key-not-used'

app.whenReady().then(async () => {
  const root = path.join(__dirname, '..')
  const entryFile = path.join(root, '__brk_entry.ts')
  const outFile = path.join(root, '__brk.bundle.cjs')
  const cleanup = () => {
    try { fs.rmSync(entryFile, { force: true }) } catch (_) {}
    try { fs.rmSync(outFile, { force: true }) } catch (_) {}
  }

  try {
    fs.writeFileSync(entryFile, ENTRY, 'utf8')
    await esbuild.build({
      entryPoints: [entryFile], bundle: true, platform: 'node', format: 'cjs',
      outfile: outFile, external: ['electron', 'better-sqlite3', 'openai'],
      absWorkingDir: root, logLevel: 'silent'
    })
    const m = require(outFile)
    m.getDb()

    const COOLDOWN_MS = 15 * 60 * 1000
    let clock = Date.now()
    const now = () => clock

    const breaker = new m.ProviderBreaker({ cooldownMs: COOLDOWN_MS, now })
    const backoff = new m.ChatBackoff({ now })

    // ── 假 provider：計數 + 依 mode 決定成功/失敗 ──────────────────
    let mode = 'ok'
    let calls = 0
    const callsByChat = {}
    const makeExtract = () => async (input) => {
      calls += 1
      callsByChat[input.chat.chatId] = (callsByChat[input.chat.chatId] || 0) + 1
      if (mode === 'retryable') throw new Error('socket hang up')
      if (mode === 'fatal') {
        throw new m.LlmProviderError(
          'not_authenticated',
          'Claude CLI 尚未登入，請在終端機執行 claude 完成登入後再試'
        )
      }
      if (mode === 'onechat' && input.chat.chatId === FAIL_CHAT) throw new Error('boom')
      return { importance: 'fyi', newTodos: [], resolved: [], updates: [] }
    }

    let round = 0
    const watchSource = async () => {
      round += 1
      return { messages: msgsForRound(round), bridge: 'ok' }
    }

    const sched = new m.PipelineScheduler({ watchSource, makeExtract, breaker, backoff })
    // 不呼叫 start()：完全由 triggerNow 驅動，不開任何計時器。
    // userInitiated:false = 「排程自動跑的一輪」（不解除熔斷）；true = 使用者按「立即執行」。
    const tick = () => sched.triggerNow({ userInitiated: false })

    const provider = m.getPipelineDefaults()
    console.log('[probe-brk] pollIntervalSec=' + provider.pollIntervalSec + ' concurrency=' + provider.concurrency)

    // ── S0 正常路徑不誤傷 ────────────────────────────────────
    mode = 'ok'
    const okRounds = [await tick(), await tick(), await tick()]
    check('S0 三輪成功都有跑 LLM', calls === 9, 'calls=' + calls)
    check('S0 熔斷器保持關閉', breaker.snapshot().open === false)
    check('S0 連續全滅計數為 0', breaker.snapshot().consecutiveWipeouts === 0,
      'wipeouts=' + breaker.snapshot().consecutiveWipeouts)
    check('S0 llmStatus=ok', okRounds[2].llmStatus === 'ok', okRounds[2].llmStatus)
    check('S0 沒有 chat 被跳過', okRounds[2].chatsSkipped === 0)
    check('S0 status.lastError 沒有熔斷訊息', sched.getStatus().lastError === null,
      String(sched.getStatus().lastError))

    // ── S1 可重試錯誤全滅：第 1 輪不熔斷、第 2 輪熔斷 ──────────
    mode = 'retryable'
    const callsBeforeW1 = calls
    const w1 = await tick()
    check('S1 第 1 輪全滅（3 chat 全失敗）', w1.chatsFailed === 3 && w1.chatsProcessed === 0,
      'failed=' + w1.chatsFailed + ' processed=' + w1.chatsProcessed)
    check('S1 第 1 輪 llmStatus=error', w1.llmStatus === 'error', w1.llmStatus)
    check('S1 第 1 輪「不」熔斷（一次抖動不鎖 15 分鐘）', breaker.snapshot().open === false)
    check('S1 第 1 輪確實打了 3 次 provider', calls - callsBeforeW1 === 3, 'delta=' + (calls - callsBeforeW1))

    const callsBeforeW2 = calls
    const w2 = await tick()
    check('S1 第 2 輪仍會重試（寬限 1 次，退避不餓死熔斷器）', calls - callsBeforeW2 === 3,
      'delta=' + (calls - callsBeforeW2))
    check('S1 第 2 輪連續全滅 → 熔斷開啟', breaker.snapshot().open === true)
    check('S1 冷卻剩餘 ≈15 分鐘', Math.abs(breaker.snapshot().remainingMs - COOLDOWN_MS) < 5000,
      'remainingMs=' + breaker.snapshot().remainingMs)

    // ── S7 熔斷狀態怎麼呈現給 UI（只用既有欄位）────────────────
    const st = sched.getStatus()
    check('S7 hasApiKey 仍為 true（不是缺金鑰）', st.hasApiKey === true)
    check('S7 llmStatus 覆寫為 disabled', st.llmStatus === 'disabled', st.llmStatus)
    check('S7 lastError 含「為什麼停了」', !!st.lastError && st.lastError.indexOf('AI 引擎已暫停') === 0, String(st.lastError))
    check('S7 lastError 含「還要多久」', !!st.lastError && /\d+ 分鐘後自動重試/.test(st.lastError))
    check('S7 lastError 含「怎麼解除」', !!st.lastError && st.lastError.indexOf('立即執行') >= 0)
    console.log('[probe-brk] UI 看到的 lastError=' + st.lastError)
    check('S7 PipelineStatus 欄位集合未變（無新增 IPC 欄位）',
      JSON.stringify(Object.keys(st).sort()) === JSON.stringify(
        ['busy', 'hasApiKey', 'intervalSec', 'lastError', 'lastRunAt', 'lineBridge', 'llmStatus', 'running'].sort()),
      Object.keys(st).sort().join(','))

    // ── S2 冷卻期間零呼叫，且訊息不被吞掉 ──────────────────────
    const callsAtOpen = calls
    const unprocessedAtOpen = m.getUnprocessedForPipeline(2000).length
    const c1 = await tick()
    const c2 = await tick()
    check('S2 冷卻期間 provider 呼叫數 = 0（CLI 下 = 零 spawn）', calls === callsAtOpen,
      'callsAtOpen=' + callsAtOpen + ' now=' + calls)
    check('S2 冷卻期間所有 chat 被跳過', c1.chatsSkipped === 3 && c2.chatsSkipped === 3,
      'c1=' + c1.chatsSkipped + ' c2=' + c2.chatsSkipped)
    check('S2 冷卻期間不算 failed（否則 llmStatus 永遠 error）', c1.chatsFailed === 0 && c2.chatsFailed === 0)
    check('S2 冷卻期間訊息「不」被標成已處理（代辦不會遺失）',
      m.getUnprocessedForPipeline(2000).length > unprocessedAtOpen,
      'before=' + unprocessedAtOpen + ' after=' + m.getUnprocessedForPipeline(2000).length)

    // ── S3 冷卻到期自動恢復 ──────────────────────────────────
    clock += COOLDOWN_MS + 1000
    check('S3 到期後熔斷自動解除', breaker.snapshot().open === false)
    check('S3 到期後 status 不再顯示熔斷訊息', sched.getStatus().lastError !== st.lastError)
    mode = 'ok'
    const callsBeforeR = calls
    const rec = await tick()
    check('S3 恢復後重新呼叫 provider', calls - callsBeforeR === 3, 'delta=' + (calls - callsBeforeR))
    check('S3 恢復後那些訊息真的被抽了（沒在冷卻期被吞）', rec.chatsProcessed === 3,
      'processed=' + rec.chatsProcessed)
    check('S3 恢復後 llmStatus 回 ok', sched.getStatus().llmStatus === 'ok', sched.getStatus().llmStatus)

    // ── S4 不可重試錯誤第一輪就熔斷 ─────────────────────────
    mode = 'fatal'
    const f1 = await tick()
    const fsnap = breaker.snapshot()
    check('S4 not_authenticated 第 1 輪就熔斷', fsnap.open === true)
    check('S4 熔斷 code 被保留', fsnap.code === 'not_authenticated', String(fsnap.code))
    check('S4 熔斷原因用 provider 的 userMessage',
      fsnap.reason === 'Claude CLI 尚未登入，請在終端機執行 claude 完成登入後再試', String(fsnap.reason))
    check('S4 該輪確實失敗了 3 個 chat', f1.chatsFailed === 3, 'failed=' + f1.chatsFailed)
    const callsAfterFatal = calls
    await tick()
    check('S4 熔斷後下一輪零呼叫', calls === callsAfterFatal, 'delta=' + (calls - callsAfterFatal))

    // ── S5 使用者按「立即執行」立刻解除 ─────────────────────
    mode = 'ok'
    const callsBeforeManual = calls
    const manual = await sched.triggerNow() // 預設 userInitiated:true
    check('S5 立即執行解除熔斷', breaker.snapshot().open === false)
    check('S5 立即執行當輪就重新呼叫 provider', calls - callsBeforeManual === 3,
      'delta=' + (calls - callsBeforeManual))
    check('S5 立即執行當輪有抽到東西', manual.chatsProcessed === 3, 'processed=' + manual.chatsProcessed)

    // ── S6 設定變更立刻解除 ─────────────────────────────────
    mode = 'fatal'
    await tick()
    check('S6 前置：再次熔斷', breaker.snapshot().open === true)
    sched.notifySettingsChanged()
    check('S6 設定變更解除熔斷', breaker.snapshot().open === false)
    check('S6 設定變更也清空 per-chat 退避', sched.backoffSnapshot().length === 0,
      JSON.stringify(sched.backoffSnapshot()))
    mode = 'ok'
    const callsBeforeS6 = calls
    await tick()
    check('S6 設定變更後當輪即恢復呼叫', calls - callsBeforeS6 === 3, 'delta=' + (calls - callsBeforeS6))

    // ── S8 per-chat 退避（10 個裡壞 1 個：熔斷器管不到的缺口）──
    sched.notifySettingsChanged() // 清乾淨狀態
    mode = 'onechat'
    const before1 = calls
    const p1 = await tick()
    check('S8 第 1 輪 3 個 chat 都被呼叫', calls - before1 === 3, 'delta=' + (calls - before1))
    check('S8 第 1 輪 partial（2 成功 1 失敗）',
      p1.llmStatus === 'partial' && p1.chatsProcessed === 2 && p1.chatsFailed === 1,
      p1.llmStatus + ' processed=' + p1.chatsProcessed + ' failed=' + p1.chatsFailed)
    check('S8 部分失敗不會熔斷', breaker.snapshot().open === false)

    const before2 = calls
    const p2 = await tick()
    check('S8 第 2 輪仍給壞 chat 一次機會（寬限 1 次）', calls - before2 === 3, 'delta=' + (calls - before2))
    check('S8 第 2 輪後壞 chat 進入退避', sched.backoffSnapshot().some((e) => e.chatId === FAIL_CHAT && e.remainingMs > 0),
      JSON.stringify(sched.backoffSnapshot()))

    const before3 = calls
    const failCallsBefore = callsByChat[FAIL_CHAT] || 0
    const p3 = await tick()
    check('S8 第 3 輪壞 chat 被跳過（只打 2 次）', calls - before3 === 2, 'delta=' + (calls - before3))
    check('S8 壞 chat 這輪零呼叫', (callsByChat[FAIL_CHAT] || 0) === failCallsBefore,
      'before=' + failCallsBefore + ' after=' + (callsByChat[FAIL_CHAT] || 0))
    check('S8 chatsSkipped 記到 1', p3.chatsSkipped === 1, 'skipped=' + p3.chatsSkipped)
    check('S8 被跳過的 chat 不算 failed → llmStatus 不是 error', p3.llmStatus === 'ok', p3.llmStatus)
    check('S8 熔斷器全程未動作', breaker.snapshot().open === false)

    // 退避到期後該 chat 回來；成功即清空計數。
    clock += 40 * 60 * 1000
    mode = 'ok'
    const before4 = calls
    await tick()
    check('S8 退避到期後壞 chat 回到抽取隊列', calls - before4 === 3, 'delta=' + (calls - before4))
    check('S8 成功後退避計數被清空', sched.backoffSnapshot().length === 0,
      JSON.stringify(sched.backoffSnapshot()))

    // ── S9 HTTP provider 的 error code 對映（Batch 7 補完）──────
    // 起一個假端點回各種狀態碼，跑真的 complete()，證明 (a) code 分類正確、
    // (b) 原始 SDK 訊息**沒有被抹掉**（Batch 1 的顧慮）。
    await runHttpMappingChecks(m)

    console.log('[probe-brk] total-extract-calls=' + calls + ' byChat=' + JSON.stringify(callsByChat))
    console.log('[probe-brk] countMessages=' + m.countMessages())
    console.log('[probe-brk] ALL-ASSERTIONS-PASS=' + (failures.length === 0))
    if (failures.length) console.log('[probe-brk] FAILED=' + JSON.stringify(failures))
    m.closeDb()
    cleanup()
    app.exit(failures.length === 0 ? 0 : 1)
  } catch (err) {
    console.error('[probe-brk] ERROR', err)
    cleanup()
    app.exit(1)
  }
})
