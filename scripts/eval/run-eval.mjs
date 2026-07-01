// ⚠️  隱私警告 / PRIVACY WARNING
// eval/window-messages.json 與 eval/gold-*.json 含真實 LINE 第三方對話個資
//（人名、家長群組訊息、含敏感資訊的 URL 等），已列入 .gitignore。
// 禁止將上述檔案提交至任何公開版控（git commit / push / PR）。
// 若需可分享或 CI 用的回歸樣本，請改用去識別化版本：
//   - 人名 → 匿名代號（A、B、C…）
//   - 含密碼 / token 的 URL → 全數遮罩（https://example.com/***）
// ──────────────────────────────────────────────────────────────────────────
// run-eval.mjs — qwen-vs-gold 一致性 eval harness。
//
// 目的（使用者最在意）：驗證 App 引擎 qwen 的判斷，與 Claude 產出的 gold 是否一致。
//
// 三段流程：
//   1) 讀 eval/window-messages.json，依聊天室（chat）分組。
//   2) 用「App 真實管線同一份」EXTRACT_SYSTEM_PROMPT + EXTRACT_JSON_SCHEMA + extractTodos
//      （經 esbuild 即時編譯 src/main/llm/*.ts，不重寫常數，避免漂移）逐 chat 呼叫 qwen
//      → 聚合成扁平 todo 清單 → 寫 eval/qwen-output.json。
//   3) diff qwen-output.json vs eval/gold-2026-06-25_26.json：
//      chat + 標題模糊比對做配對，算 Recall / Precision / bucket 一致率 / completed 一致率，
//      逐筆列分歧；輸出到 stdout 與 eval/eval-report.md。
//
// 金鑰：優先讀 gitignored 檔 eval/.qwen-key（避免進命令列 / env log），其次 process.env.QWEN_API_KEY。
//       缺金鑰 → 不呼叫 qwen，印「缺金鑰：gold+harness 已就緒，待填金鑰後重跑」並 exit 0
//       （仍跑讀檔 / 分組 / 既有 qwen-output 的 diff，證明 harness 可跑）。
//
// 由 `npm run eval` 執行。需先用 App 的 build 流程安裝 esbuild（devDependency 已含）。

import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..') // scripts/eval → repo root
const EVAL_DIR = join(ROOT, 'eval')

const WINDOW_FILE = join(EVAL_DIR, 'window-messages.json')
const GOLD_FILE = join(EVAL_DIR, 'gold-2026-06-25_26.json')
const QWEN_OUT_FILE = join(EVAL_DIR, 'qwen-output.json')
const REPORT_FILE = join(EVAL_DIR, 'eval-report.md')
const KEY_FILE = join(EVAL_DIR, '.qwen-key')

const baseURL = (process.env.QWEN_BASE_URL || 'https://qwen.tuq.tw/v1').trim()
const model = (process.env.QWEN_MODEL || 'qwen36-fp8').trim()

// ── bucket 映射：gold 用中文，App qwen schema 用英文。配對時統一成 canonical。──
const BUCKET_EN2CANON = { todo: 'todo', waiting: 'waiting', schedule: 'schedule' }
const BUCKET_ZH2CANON = { 待辦: 'todo', 等回覆: 'waiting', 行程: 'schedule' }
function canonBucketFromQwen(b) {
  return BUCKET_EN2CANON[b] ?? String(b)
}
function canonBucketFromGold(b) {
  return BUCKET_ZH2CANON[b] ?? String(b)
}

// ── 金鑰讀取：檔案優先（避免進 env / argv log），其次 env。回傳遮罩後可印的版本另算。──
function loadApiKey() {
  if (existsSync(KEY_FILE)) {
    const k = readFileSync(KEY_FILE, 'utf8').trim()
    if (k) return { key: k, source: 'eval/.qwen-key' }
  }
  const envK = (process.env.QWEN_API_KEY || '').trim()
  if (envK) return { key: envK, source: 'env:QWEN_API_KEY' }
  return { key: '', source: 'none' }
}
function maskKey(k) {
  if (!k) return '(none)'
  if (k.length <= 8) return '****'
  return k.slice(0, 4) + '...' + k.slice(-2) + ` (len=${k.length})`
}

// ── 標題正規化 + 模糊相似度（配對用）────────────────────────────
// 中文沒有空白邊界，用「字元 bigram 的 Dice 係數」做穩定的模糊比對；外加去雜訊正規化。
function normalizeText(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\s　]+/g, '') // 去所有空白（含全形）
    // 去標點 / emoji / 括號等雜訊，只留中日韓字、英數
    .replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}a-z0-9]/gu, '')
}
function bigrams(s) {
  const out = new Map()
  if (s.length === 1) {
    out.set(s, 1)
    return out
  }
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2)
    out.set(g, (out.get(g) || 0) + 1)
  }
  return out
}
function diceSim(a, b) {
  const na = normalizeText(a)
  const nb = normalizeText(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  const ga = bigrams(na)
  const gb = bigrams(nb)
  let inter = 0
  let totalA = 0
  let totalB = 0
  for (const v of ga.values()) totalA += v
  for (const v of gb.values()) totalB += v
  for (const [g, va] of ga) {
    const vb = gb.get(g)
    if (vb) inter += Math.min(va, vb)
  }
  const denom = totalA + totalB
  return denom === 0 ? 0 : (2 * inter) / denom
}

// chat 名稱正規化（配對的「硬條件」之一，先比 chat 再比 title）。
function normalizeChat(s) {
  return normalizeText(s)
}

// ── esbuild 即時編譯 App 真實管線（與 smoke-qwen.mjs 同款手法，避免常數漂移）──
const ENTRY = `
export { buildUserPayload } from './src/main/llm/extractPrompt.ts'
export { makeQwen } from './src/main/llm/qwenClient.ts'
export { extractTodos } from './src/main/llm/extractor.ts'
`
async function loadAppPipeline() {
  // bundle 必須落在 ROOT 內，runtime 才能沿目錄上溯解析到 ROOT/node_modules 的 external `openai`
  // （放系統 tmpdir 會 ERR_MODULE_NOT_FOUND）。entry + bundle 皆建在 ROOT/.eval-tmp。
  const tmp = mkdtempSync(join(ROOT, '.eval-tmp-'))
  const entryFile = join(ROOT, '__eval_entry.ts')
  const outFile = join(tmp, 'eval.bundle.mjs')
  writeFileSync(entryFile, ENTRY, 'utf8')
  try {
    await build({
      entryPoints: [entryFile],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: outFile,
      external: ['openai'],
      absWorkingDir: ROOT,
      logLevel: 'silent'
    })
    const mod = await import(pathToFileURL(outFile).href)
    return { mod, cleanup: () => { try { rmSync(entryFile, { force: true }) } catch {} ; try { rmSync(tmp, { recursive: true, force: true }) } catch {} } }
  } catch (e) {
    try { rmSync(entryFile, { force: true }) } catch {}
    try { rmSync(tmp, { recursive: true, force: true }) } catch {}
    throw e
  }
}

// ── window-messages 的 message → App MessageDTO 映射 ──────────────
// window 形態: { id, time, ts, direction, sender, text }
// MessageDTO  : { msgId, chatId, ts, timeIso, direction, sender, text, contentType, processed, ingestedAt }
function toMessageDTO(m, chatId) {
  return {
    msgId: String(m.id),
    chatId,
    ts: m.ts ?? 0,
    timeIso: m.time ?? '',
    direction: m.direction === 'out' ? 'out' : 'in',
    sender: m.sender ?? null,
    text: m.text ?? null,
    contentType: 0, // window 檔只含文字訊息；App schema 文字為 0
    processed: false,
    ingestedAt: m.time ?? ''
  }
}

// ── 讀 + 分組 window-messages ───────────────────────────────────
function loadWindowChats() {
  const raw = JSON.parse(readFileSync(WINDOW_FILE, 'utf8'))
  const chats = Array.isArray(raw?.chats) ? raw.chats : []
  return {
    window: raw?.window ?? null,
    chatCount: raw?.chatCount ?? chats.length,
    messageCount: raw?.messageCount ?? chats.reduce((n, c) => n + (c.messages?.length || 0), 0),
    chats: chats.map((c) => ({
      chatId: c.chatId,
      name: c.name ?? null,
      isGroup: !!c.isGroup,
      messages: Array.isArray(c.messages) ? c.messages : []
    }))
  }
}

// ── 呼叫 qwen 逐 chat 抽取 → 扁平 todo 清單 ─────────────────────
async function runQwen(appMod, apiKey, windowData) {
  const now = (windowData.window?.end || new Date().toISOString()).slice(0, 19)
  const client = appMod.makeQwen({ apiKey, baseURL, timeoutMs: 90000 })

  const flat = []
  const perChatErrors = []
  let chatIdx = 0
  for (const chat of windowData.chats) {
    chatIdx++
    if (!chat.messages.length) continue
    const input = {
      now,
      chat: { chatId: chat.chatId, name: chat.name, isGroup: chat.isGroup },
      newMessages: chat.messages.map((m) => toMessageDTO(m, chat.chatId)),
      recentContext: [],
      openTodos: [] // cold-start：harness 無既有 todo，故 resolved 預期為空（見報告語意落差說明）
    }
    process.stderr.write(`[eval] qwen chat ${chatIdx}/${windowData.chats.length} "${chat.name ?? chat.chatId}" (${input.newMessages.length} msgs)...\n`)
    try {
      const res = await appMod.extractTodos(client, input, { model, structuredMode: 'auto' })
      for (const t of res.newTodos) {
        flat.push({
          chat: chat.name ?? chat.chatId,
          chatId: chat.chatId,
          bucket: t.bucket, // en
          title: t.title,
          detail: t.detail ?? null,
          priority: t.priority,
          dueAt: t.dueAt ?? null,
          confidence: t.confidence,
          completed: false, // cold-start 下不會有 resolved；此處統一 false
          importance: res.importance,
          sourceMsgIds: t.sourceMsgIds
        })
      }
      // resolved（cold-start 多半為空，仍記下供觀察）
      for (const r of res.resolved) {
        flat.push({
          chat: chat.name ?? chat.chatId,
          chatId: chat.chatId,
          bucket: 'todo',
          title: `(resolved) ${r.evidence}`.slice(0, 60),
          detail: r.evidence,
          priority: 3,
          dueAt: null,
          confidence: 0.5,
          completed: true,
          importance: res.importance,
          sourceMsgIds: [],
          _resolvedTodoId: r.todoId
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      perChatErrors.push({ chat: chat.name ?? chat.chatId, error: msg })
      process.stderr.write(`[eval]   chat 失敗（標 partial，不中斷）: ${msg}\n`)
    }
  }
  return { todos: flat, errors: perChatErrors, now }
}

// ── 配對 + 指標 ─────────────────────────────────────────────────
const SIM_THRESHOLD = 0.5 // title bigram-Dice 配對門檻（同 chat 內）

function loadGold() {
  const g = JSON.parse(readFileSync(GOLD_FILE, 'utf8'))
  return g.map((t, i) => ({
    idx: i,
    id: t.id,
    title: t.title,
    chat: t.chat,
    bucketCanon: canonBucketFromGold(t.bucket),
    bucketRaw: t.bucket,
    priority: t.priority,
    completed: !!t.completed,
    completionEvidence: t.completionEvidence ?? null,
    sourceHint: t.sourceHint ?? null
  }))
}

function normalizeQwen(todos) {
  return todos.map((t, i) => ({
    idx: i,
    title: t.title,
    chat: t.chat,
    bucketCanon: canonBucketFromQwen(t.bucket),
    bucketRaw: t.bucket,
    priority: t.priority,
    completed: !!t.completed,
    confidence: t.confidence
  }))
}

// 貪婪最佳配對：同 chat（normalize 後相等）為硬條件，title Dice >= 門檻；
// 取相似度最高且未被佔用的配對。回傳 pairs / goldOnly / qwenOnly。
function matchPairs(goldList, qwenList) {
  const candidates = []
  for (const g of goldList) {
    for (const q of qwenList) {
      if (normalizeChat(g.chat) !== normalizeChat(q.chat)) continue
      const sim = diceSim(g.title, q.title)
      if (sim >= SIM_THRESHOLD) candidates.push({ g, q, sim })
    }
  }
  candidates.sort((a, b) => b.sim - a.sim)
  const usedG = new Set()
  const usedQ = new Set()
  const pairs = []
  for (const c of candidates) {
    if (usedG.has(c.g.idx) || usedQ.has(c.q.idx)) continue
    usedG.add(c.g.idx)
    usedQ.add(c.q.idx)
    pairs.push(c)
  }
  const goldOnly = goldList.filter((g) => !usedG.has(g.idx)) // gold 有、qwen 漏 → 影響 Recall
  const qwenOnly = qwenList.filter((q) => !usedQ.has(q.idx)) // qwen 有、gold 無 → 影響 Precision
  return { pairs, goldOnly, qwenOnly }
}

function computeMetrics(pairs, goldOnly, qwenOnly) {
  const matched = pairs.length
  const goldTotal = matched + goldOnly.length
  const qwenTotal = matched + qwenOnly.length
  const recall = goldTotal ? matched / goldTotal : 0
  const precision = qwenTotal ? matched / qwenTotal : 0
  let bucketAgree = 0
  let completedAgree = 0
  for (const p of pairs) {
    if (p.g.bucketCanon === p.q.bucketCanon) bucketAgree++
    if (p.g.completed === p.q.completed) completedAgree++
  }
  return {
    matched,
    goldTotal,
    qwenTotal,
    recall,
    precision,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    bucketAgreeRate: matched ? bucketAgree / matched : 0,
    completedAgreeRate: matched ? completedAgree / matched : 0,
    bucketAgree,
    completedAgree
  }
}

function pct(x) {
  return (100 * x).toFixed(1) + '%'
}

function buildReport({ haveQwen, qwenSource, qwenErrors, windowData, goldList, qwenList, match, metrics, now }) {
  const lines = []
  lines.push('# qwen-vs-gold 一致性 eval 報告')
  lines.push('')
  lines.push(`- 產生時間: ${new Date().toISOString()}`)
  lines.push(`- now（餵給 qwen 的相對時間基準）: ${now}`)
  lines.push(`- 輸入窗口: ${windowData.window ? windowData.window.start + ' ~ ' + windowData.window.end : '(unknown)'}`)
  lines.push(`- 輸入: ${windowData.chatCount} 聊天室 / ${windowData.messageCount} 則訊息`)
  lines.push(`- qwen 來源: ${haveQwen ? 'this run（' + qwenSource + '）或既有 qwen-output.json' : '未呼叫（缺金鑰）'}`)
  lines.push(`- gold 筆數: ${goldList.length}；qwen 筆數: ${qwenList.length}`)
  lines.push('')

  if (!haveQwen && qwenList.length === 0) {
    lines.push('> 缺金鑰且無既有 qwen-output.json：本次僅驗證 harness 可讀檔 / 分組 / 比對流程；待填金鑰後重跑取得真實一致率。')
    lines.push('')
    return lines.join('\n')
  }

  lines.push('## 配對方法')
  lines.push('- 硬條件：聊天室名稱正規化（去空白/標點/emoji、小寫）後須相等。')
  lines.push(`- 軟條件：標題以「字元 bigram 的 Dice 係數」模糊比對，門檻 ≥ ${SIM_THRESHOLD}（中文無詞邊界，bigram-Dice 較穩）。`)
  lines.push('- 配對策略：所有候選依相似度由高到低貪婪佔用，一對一。')
  lines.push('- bucket 映射：gold 待辦/等回覆/行程 ↔ qwen todo/waiting/schedule。')
  lines.push('')
  lines.push('## 指標定義')
  lines.push('- **Recall** = 配對數 / gold 總數（gold 有、qwen 漏者拉低 → 漏抽）。')
  lines.push('- **Precision** = 配對數 / qwen 總數（qwen 有、gold 無者拉低 → 多抽/幻覺）。')
  lines.push('- **bucket 一致率** = 配對中 bucket(canonical) 相同的比例。')
  lines.push('- **completed 一致率** = 配對中 completed 旗標相同的比例。')
  lines.push('')
  lines.push('### ⚠️ completed 語意落差（誠實標註）')
  lines.push('gold 的 `completed` 是 Claude 看「整段兩日對話」後、判定某事在窗口內已被完成。')
  lines.push('但 App 真實管線是**增量式**：todo 先被建立、後續訊息才透過 `resolved`（需 openTodos 有既有 todo）標完成。')
  lines.push('本 harness 為**冷啟動單次呼叫**（openTodos=[]），qwen 通常不會輸出 resolved，故 qwen 端 completed 幾乎全為 false。')
  lines.push('因此「completed 一致率」會系統性偏低，反映的是**管線型態差異**而非 qwen 判斷錯誤；')
  lines.push('要真正比對完成偵測，需另建「兩段式（先抽 day1 → 帶 openTodos 抽 day2）」eval，屬後續工作。')
  lines.push('')

  lines.push('## 總體指標')
  lines.push('')
  lines.push('| 指標 | 值 |')
  lines.push('|---|---|')
  lines.push(`| 配對數 (matched) | ${metrics.matched} |`)
  lines.push(`| gold 總數 | ${metrics.goldTotal} |`)
  lines.push(`| qwen 總數 | ${metrics.qwenTotal} |`)
  lines.push(`| Recall | ${pct(metrics.recall)} |`)
  lines.push(`| Precision | ${pct(metrics.precision)} |`)
  lines.push(`| F1 | ${pct(metrics.f1)} |`)
  lines.push(`| bucket 一致率 | ${pct(metrics.bucketAgreeRate)} (${metrics.bucketAgree}/${metrics.matched}) |`)
  lines.push(`| completed 一致率 | ${pct(metrics.completedAgreeRate)} (${metrics.completedAgree}/${metrics.matched}) — 受上述語意落差影響 |`)
  lines.push('')

  if (qwenErrors && qwenErrors.length) {
    lines.push('## qwen 逐 chat 失敗（標 partial、不中斷整輪）')
    for (const e of qwenErrors) lines.push(`- ${e.chat}: ${e.error}`)
    lines.push('')
  }

  lines.push('## 配對逐筆（含 bucket / completed 分歧）')
  lines.push('')
  lines.push('| sim | chat | gold title | qwen title | bucket(g/q) | bucket一致 | done(g/q) | done一致 |')
  lines.push('|---|---|---|---|---|---|---|---|')
  for (const p of match.pairs.slice().sort((a, b) => b.sim - a.sim)) {
    const bOk = p.g.bucketCanon === p.q.bucketCanon ? '✅' : '❌'
    const dOk = p.g.completed === p.q.completed ? '✅' : '❌'
    lines.push(
      `| ${p.sim.toFixed(2)} | ${trunc(p.g.chat, 14)} | ${trunc(p.g.title, 28)} | ${trunc(p.q.title, 28)} | ${p.g.bucketCanon}/${p.q.bucketCanon} | ${bOk} | ${p.g.completed}/${p.q.completed} | ${dOk} |`
    )
  }
  lines.push('')

  lines.push('## gold 有、qwen 漏（拉低 Recall — 潛在漏抽）')
  lines.push('')
  if (match.goldOnly.length === 0) lines.push('（無）')
  else {
    lines.push('| chat | gold title | bucket | done |')
    lines.push('|---|---|---|---|')
    for (const g of match.goldOnly) lines.push(`| ${trunc(g.chat, 16)} | ${trunc(g.title, 40)} | ${g.bucketCanon} | ${g.completed} |`)
  }
  lines.push('')

  lines.push('## qwen 有、gold 無（拉低 Precision — 潛在多抽/幻覺）')
  lines.push('')
  if (match.qwenOnly.length === 0) lines.push('（無）')
  else {
    lines.push('| chat | qwen title | bucket | conf |')
    lines.push('|---|---|---|---|')
    for (const q of match.qwenOnly) lines.push(`| ${trunc(q.chat, 16)} | ${trunc(q.title, 40)} | ${q.bucketCanon} | ${q.confidence ?? ''} |`)
  }
  lines.push('')

  return lines.join('\n')
}

function trunc(s, n) {
  const str = String(s ?? '').replace(/\|/g, '/').replace(/\n/g, ' ')
  return str.length > n ? str.slice(0, n - 1) + '…' : str
}

// ── 主流程 ──────────────────────────────────────────────────────
async function main() {
  // 前置檢查
  for (const [label, f] of [['window-messages', WINDOW_FILE], ['gold', GOLD_FILE]]) {
    if (!existsSync(f)) {
      console.error(`[eval] 缺檔: ${label} (${f})`)
      process.exit(1)
    }
  }

  const windowData = loadWindowChats()
  const goldRaw = loadGold()
  console.log(`[eval] 讀入 window: ${windowData.chatCount} chats / ${windowData.messageCount} msgs；gold: ${goldRaw.length} 筆`)
  console.log(`[eval] 依聊天室分組完成（${windowData.chats.filter((c) => c.messages.length).length} 個非空 chat）`)

  const { key: apiKey, source: keySource } = loadApiKey()

  let qwenList = []
  let haveQwen = false
  let qwenErrors = []
  let now = (windowData.window?.end || new Date().toISOString()).slice(0, 19)

  if (apiKey) {
    console.log(`[eval] 金鑰來源: ${keySource}，金鑰: ${maskKey(apiKey)}（已遮罩）`)
    console.log(`[eval] baseURL=${baseURL} model=${model} → 開始逐 chat 呼叫 qwen...`)
    let app
    try {
      app = await loadAppPipeline()
    } catch (e) {
      console.error('[eval] esbuild 編譯 App 管線失敗:', e instanceof Error ? e.message : e)
      process.exit(1)
    }
    try {
      const r = await runQwen(app.mod, apiKey, windowData)
      writeFileSync(
        QWEN_OUT_FILE,
        JSON.stringify(
          { meta: { now: r.now, baseURL, model, generatedAt: new Date().toISOString(), keySource }, errors: r.errors, todos: r.todos },
          null,
          2
        ),
        'utf8'
      )
      console.log(`[eval] 已寫 qwen-output.json（${r.todos.length} 筆，${r.errors.length} chat 失敗）`)
      qwenList = r.todos
      qwenErrors = r.errors
      now = r.now
      haveQwen = true
    } finally {
      app.cleanup()
    }
  } else {
    // 缺金鑰：優雅略過 qwen 段。若已有既存 qwen-output.json 仍跑 diff（證明流程）。
    console.log('缺金鑰：gold+harness 已就緒，待填金鑰後重跑')
    console.log('[eval] 金鑰讀取順序：eval/.qwen-key（gitignored）→ env QWEN_API_KEY，皆無。')
    if (existsSync(QWEN_OUT_FILE)) {
      try {
        const prev = JSON.parse(readFileSync(QWEN_OUT_FILE, 'utf8'))
        qwenList = Array.isArray(prev?.todos) ? prev.todos : []
        qwenErrors = Array.isArray(prev?.errors) ? prev.errors : []
        now = prev?.meta?.now || now
        haveQwen = qwenList.length > 0
        console.log(`[eval] 偵測到既有 qwen-output.json（${qwenList.length} 筆）→ 仍對它跑 diff。`)
      } catch {
        console.log('[eval] 既有 qwen-output.json 解析失敗，跳過。')
      }
    } else {
      console.log('[eval] 無既有 qwen-output.json → 本次僅做讀檔/分組/diff dry-run（qwen 段優雅略過）。')
    }
  }

  // diff
  const goldList = goldRaw
  const qwenNorm = normalizeQwen(qwenList)
  const match = matchPairs(goldList, qwenNorm)
  const metrics = computeMetrics(match.pairs, match.goldOnly, match.qwenOnly)

  // stdout 摘要
  console.log('')
  console.log('==================== EVAL 摘要 ====================')
  console.log(`配對 matched=${metrics.matched} | gold=${metrics.goldTotal} | qwen=${metrics.qwenTotal}`)
  console.log(`Recall=${pct(metrics.recall)}  Precision=${pct(metrics.precision)}  F1=${pct(metrics.f1)}`)
  console.log(`bucket 一致率=${pct(metrics.bucketAgreeRate)} (${metrics.bucketAgree}/${metrics.matched})`)
  console.log(`completed 一致率=${pct(metrics.completedAgreeRate)} (${metrics.completedAgree}/${metrics.matched})  [受 cold-start 語意落差影響]`)
  console.log(`gold 有/qwen 漏 = ${match.goldOnly.length}；qwen 有/gold 無 = ${match.qwenOnly.length}`)
  if (!haveQwen) console.log('（注意：qwen 端為空 → 上述多為 dry-run 數字；填金鑰後重跑才有實質一致率）')
  console.log('===================================================')

  // 寫報告
  const report = buildReport({
    haveQwen,
    qwenSource: keySource,
    qwenErrors,
    windowData,
    goldList,
    qwenList: qwenNorm,
    match,
    metrics,
    now
  })
  writeFileSync(REPORT_FILE, report, 'utf8')
  console.log(`[eval] 報告已寫: ${REPORT_FILE}`)

  process.exit(0)
}

main().catch((err) => {
  console.error('[eval] FATAL:', err instanceof Error ? err.stack : err)
  process.exit(1)
})
