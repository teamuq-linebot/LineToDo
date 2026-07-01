import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dirname } from 'node:path'
import type { Database } from 'better-sqlite3'
import { getDb } from '../db/database'
import type { MessageDTO, TodoDTO } from '../db/dto'
import {
  insertMessages,
  getByChatSince,
  listMessages,
  markProcessed
} from '../db/messages.repo'
import { getChat, setBlocked } from '../db/chats.repo'
import {
  createTodo,
  getOpenTodosByChat,
  mergeSources,
  reclassifyTodo,
  resolveTodo
} from '../db/todos.repo'
import { startRun, finishRun } from '../db/pipeline.repo'
import { getLineBridgeConfig } from '../config/lineBridge'
import { getPipelineDefaults } from '../config/defaults'
import type { PipelineDefaults } from '../config/defaults'
import { makeQwenExtractFn } from './runOnce'
import type { ChatExtractInput } from './runOnce'
import type { ExtractResult } from '../llm/schema'
import { evaluateChatAutoBlock, isBatchNoise, matchesChatIgnoreKeyword } from './blocklist'
import { findDuplicateOpenTodo } from './dedup'
import { mapLimited } from './concurrency'
import type { RawLineMessage } from '../line/types'

/**
 * backfill.ts — 「回顧過去 N 天」一次性補抓（重用 runOnce 既有抽取/去重/完成偵測邏輯，
 * 但走獨立的時間窗口來源：直接 spawn watch_json.py --since <epoch_ms>，而非吃 DB 未處理列）。
 *
 * 流程（對齊 IMPLEMENTATION_PLAN.md §8，但訊息來源是時間窗口而非 live drain）：
 *   1. 開一筆 pipeline_runs。
 *   2. spawn watch_json.py --since (now - N天) → 收 NDJSON → RawLineMessage[]。
 *   3. insertMessages：upsert chats（套自動黑名單）+ INSERT OR IGNORE messages（msg_id 去重）。
 *      → 讓抽出的 todo.sourceMsgIds 連得到 messages 表。
 *   4. 依 chatId 分組（用本窗口訊息；blocked chat 整組跳過）。
 *   5. 每個 chat：撈 openTodos 去重 → 套整批噪音黑名單 → 呼叫 extractTodos（並發節流）。
 *   6. upsert newTodos（近似去重命中則 merge）/ resolve resolved（schedule 未來不自動 done）。
 *      → 該 chat 窗口訊息標 processed=1（避免 live scheduler 重抽）。
 *   7. emit 進度（已處理/總聊天數）+ 收尾 pipeline_runs。
 *
 * 無金鑰（makeQwenExtractFn 回 null）→ 不抽 todo、回 hasApiKey:false，由 UI 提示填金鑰。
 * 失敗的 chat 標 fail 不中斷整輪；其訊息「不」標 processed（留待後續處理）。
 */

const DEFAULT_DAYS = 7
const SPAWN_TIMEOUT_MS = 180_000

export interface BackfillProgress {
  /** 已處理（含噪音/失敗）的聊天數。 */
  processed: number
  /** 本次窗口涉及的聊天總數。 */
  total: number
  /** 進度階段，UI 文案用。 */
  phase: 'fetching' | 'extracting' | 'done'
}

export interface ReviewLastDaysResult {
  ok: boolean
  hasApiKey: boolean
  days: number
  /** 窗口起點（epoch ms）。 */
  sinceMs: number
  newMsgs: number
  chatsSeen: number
  chatsProcessed: number
  chatsSkippedNoise: number
  chatsFailed: number
  todosCreated: number
  todosMerged: number
  todosResolvedDone: number
  todosSuggestedDone: number
  createdIds: string[]
  resolvedIds: string[]
  updatedIds: string[]
  note: string | null
}

export interface ReviewLastDaysDeps {
  /** 取窗口訊息。預設 spawn watch_json.py --since；測試可注入固定陣列。 */
  fetchWindow?: (sinceMs: number) => Promise<{ messages: RawLineMessage[]; error?: string }>
  /** 對單一 chat 抽取。預設 makeQwenExtractFn()；無金鑰回 null。 */
  extractFn?: ((input: ChatExtractInput) => Promise<ExtractResult>) | null
  /** 進度回呼（emit 給 IPC push）。 */
  onProgress?: (p: BackfillProgress) => void
  db?: Database
  now?: () => number
  config?: PipelineDefaults
}

/** bucket → 建立時 active 狀態（與 runOnce.bucketToActiveStatus 一致）。 */
function bucketToActiveStatus(bucket: TodoDTO['bucket']): TodoDTO['status'] {
  switch (bucket) {
    case 'waiting':
      return 'waiting_reply'
    case 'schedule':
      return 'scheduled'
    case 'todo':
    default:
      return 'pending'
  }
}

/** dueAt 是否仍在未來（與 runOnce.isFuture 一致）。 */
function isFuture(dueAt: string | null, nowMs: number): boolean {
  if (!dueAt) return false
  const due = Date.parse(dueAt)
  if (Number.isNaN(due)) return false
  return due > nowMs
}

/**
 * 預設窗口來源：spawn watch_json.py --since <epoch_ms>，逐行解析 NDJSON。
 * 與 watchSource.spawnWatchOnce 同風格（解析失敗的行跳過；exit!=0 / stderr error 回 error）。
 */
function spawnSinceSource(
  sinceMs: number
): Promise<{ messages: RawLineMessage[]; error?: string }> {
  const cfg = getLineBridgeConfig()
  const python = cfg.python
  const script = cfg.script
  return new Promise((resolve) => {
    const messages: RawLineMessage[] = []
    let errored = false
    let errorMsg: string | null = null
    let settled = false
    const finish = (res: { messages: RawLineMessage[]; error?: string }): void => {
      if (settled) return
      settled = true
      resolve(res)
    }

    let child
    try {
      child = spawn(
        python,
        [script, '--since', String(sinceMs), '--json', '--limit', '20000'],
        {
          cwd: dirname(script),
          env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
        }
      )
    } catch (err) {
      finish({ messages: [], error: err instanceof Error ? err.message : String(err) })
      return
    }

    const killTimer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already dead */
      }
      finish({ messages, error: `watch_json.py 逾時 ${SPAWN_TIMEOUT_MS}ms` })
    }, SPAWN_TIMEOUT_MS)

    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      const t = line.trim()
      if (!t) return
      try {
        const msg = JSON.parse(t) as RawLineMessage
        if (typeof msg.chatId === 'string' && typeof msg.ts === 'number') {
          messages.push(msg)
        }
      } catch {
        /* 非 JSON 行：跳過 */
      }
    })

    const errRl = createInterface({ input: child.stderr })
    errRl.on('line', (line) => {
      const t = line.trim()
      if (!t) return
      try {
        const obj = JSON.parse(t) as { error?: string }
        if (obj && typeof obj.error === 'string') {
          errored = true
          errorMsg = obj.error
        }
      } catch {
        /* 非 JSON stderr：忽略 */
      }
    })

    child.on('error', (err) => {
      clearTimeout(killTimer)
      finish({ messages: [], error: err.message })
    })

    child.on('exit', (code) => {
      clearTimeout(killTimer)
      rl.close()
      errRl.close()
      if (code === 2 || errored) {
        finish({ messages, error: errorMsg ?? `watch_json.py exited code ${code}` })
        return
      }
      finish({ messages })
    })
  })
}

/**
 * 回顧過去 days 天：拉窗口訊息 → 落庫 → 逐 chat 抽取 → upsert/resolve todos。
 * 重用既有抽取/去重/完成偵測/並發/黑名單邏輯，僅來源改為時間窗口。
 */
export async function reviewLastDays(
  days = DEFAULT_DAYS,
  deps: ReviewLastDaysDeps = {}
): Promise<ReviewLastDaysResult> {
  const db = deps.db ?? getDb()
  const nowFn = deps.now ?? (() => Date.now())
  const cfg = deps.config ?? getPipelineDefaults()
  const rules = cfg.blocklist
  const fetchWindow = deps.fetchWindow ?? spawnSinceSource
  // 未顯式注入 extractFn 時，現組 qwen extractFn（金鑰即用即丟）。null = 無金鑰。
  const extractFn =
    deps.extractFn === undefined ? makeQwenExtractFn() : deps.extractFn
  const emit = deps.onProgress ?? ((): void => {})

  const nowMs = nowFn()
  const sinceMs = nowMs - days * 24 * 60 * 60 * 1000

  const result: ReviewLastDaysResult = {
    ok: true,
    hasApiKey: extractFn !== null,
    days,
    sinceMs,
    newMsgs: 0,
    chatsSeen: 0,
    chatsProcessed: 0,
    chatsSkippedNoise: 0,
    chatsFailed: 0,
    todosCreated: 0,
    todosMerged: 0,
    todosResolvedDone: 0,
    todosSuggestedDone: 0,
    createdIds: [],
    resolvedIds: [],
    updatedIds: [],
    note: null
  }

  const runId = startRun(db)

  // 無金鑰：直接回報（不 spawn、不抽），讓 UI 提示填金鑰。
  if (extractFn === null) {
    result.ok = false
    result.note = '尚未設定 qwen 金鑰（請先到設定頁填金鑰）'
    finishRun(runId, { lineBridge: 'skipped', llmStatus: 'error', note: result.note }, db)
    emit({ processed: 0, total: 0, phase: 'done' })
    return result
  }

  // ── 1. 取窗口訊息 ──────────────────────────────────────────
  emit({ processed: 0, total: 0, phase: 'fetching' })
  const win = await fetchWindow(sinceMs)
  if (win.error) {
    result.ok = false
    result.note = `撈窗口訊息失敗: ${win.error}`
    finishRun(runId, { lineBridge: 'error', llmStatus: 'error', note: result.note }, db)
    emit({ processed: 0, total: 0, phase: 'done' })
    return result
  }

  // ── 2. 落庫 messages（去重）+ chats upsert（套自動黑名單）─────
  const ins = insertMessages(win.messages, db)
  result.newMsgs = ins.inserted
  for (const chatId of ins.chatIds) {
    const chat = getChat(chatId, db)
    if (!chat || chat.blocked) continue
    const verdict = evaluateChatAutoBlock(chat, rules)
    if (verdict.block) setBlocked(chatId, true, verdict.reason, db)
  }

  // ── 3. 依 chatId 分組（用本窗口的全部訊息；去重後 msg_id 對齊 DB）─
  // 用窗口訊息推導出 msgId → 再從 DB 取回對應 MessageDTO（含 processed 等欄位）。
  // 直接以「本窗口 chatId 清單」分組，並排除已被 block 的 chat。
  const byChat = new Map<string, MessageDTO[]>()
  for (const chatId of ins.chatIds) {
    const chat = getChat(chatId, db)
    if (chat?.blocked) continue
    // B2：直接 WHERE ts>=sinceMs 撈整個窗口（無 1000 筆上限），確保 7 天內超過 1000
    // 則的大群也完整送進 LLM；不再用 getRecentByChat（會被夾成最近 1000 筆）。
    const windowMsgs = getByChatSince(chatId, sinceMs, db)
    if (windowMsgs.length) byChat.set(chatId, windowMsgs)
  }
  result.chatsSeen = byChat.size

  if (byChat.size === 0) {
    finishRun(
      runId,
      { newMsgs: result.newMsgs, chatsSeen: 0, lineBridge: 'ok', llmStatus: 'ok' },
      db
    )
    emit({ processed: 0, total: 0, phase: 'done' })
    return result
  }

  const chatIds = [...byChat.keys()]
  const total = chatIds.length
  let processedCount = 0
  emit({ processed: 0, total, phase: 'extracting' })
  const nowIso = new Date(nowMs).toISOString()

  const DAY_MS = 24 * 60 * 60 * 1000
  /** 把該 chat 窗口訊息切成依時間序的逐日片段（升冪，空片不產出）。 */
  function sliceByDay(msgs: MessageDTO[]): MessageDTO[][] {
    const slices: MessageDTO[][] = []
    let cur: MessageDTO[] = []
    let bucketStart = -1
    for (const m of msgs) {
      const dayIdx = Math.floor((m.ts - sinceMs) / DAY_MS)
      if (dayIdx !== bucketStart) {
        if (cur.length) slices.push(cur)
        cur = []
        bucketStart = dayIdx
      }
      cur.push(m)
    }
    if (cur.length) slices.push(cur)
    return slices
  }

  /** 取某片段開始前的最近對話，作為上下文；不會被當成 newMessages 抽取。 */
  function getRecentContextBeforeSlice(
    chatId: string,
    slice: MessageDTO[]
  ): MessageDTO[] {
    const limit = cfg.recentContextLimit
    const first = slice[0]
    if (!first || limit <= 0) return []
    return listMessages({ chatId, beforeTs: first.ts, limit }, db).reverse()
  }

  /** 單一 chat 的處理結果差量（在 task 內完成落庫，回傳計數供主序列彙整）。 */
  interface ChatDelta {
    chatId: string
    kind: 'noise' | 'ok' | 'fail'
    todosCreated: number
    todosMerged: number
    todosResolvedDone: number
    todosSuggestedDone: number
    createdIds: string[]
    resolvedIds: string[]
    updatedIds: string[]
  }

  // ── 4–6. 每 chat：逐日增量抽取 + 落庫（並發節流）────────────────
  // Fix 2（完成偵測進回顧）：逐日(時間切片)按時間序處理，前片建立的 todo 會在後片成為
  //   openTodos，使 resolved[] 能在窗口內生效（消除假逾期）。
  // Fix B1（同輪去重）：單一 chat 落庫迴圈內維護 createdInThisChat，去重比對
  //   [...openTodos, ...createdInThisChat]，避免同一窗口同輪重複生同件事。
  // 落庫在 task 內完成：better-sqlite3 同步且各 call atomic、不同 chat 觸及不同列，
  //   故 await 點交錯不致資料競爭；計數差量回傳後在主序列彙整（單執行緒）。
  const settled = await mapLimited<string, ChatDelta>(
    chatIds,
    cfg.concurrency,
    async (chatId): Promise<ChatDelta> => {
      const msgs = byChat.get(chatId)!
      const msgIds = msgs.map((m) => m.msgId)
      const delta: ChatDelta = {
        chatId,
        kind: 'ok',
        todosCreated: 0,
        todosMerged: 0,
        todosResolvedDone: 0,
        todosSuggestedDone: 0,
        createdIds: [],
        resolvedIds: [],
        updatedIds: []
      }

      if (isBatchNoise(msgs, rules)) {
        delta.kind = 'noise'
        markProcessed(msgIds, db)
        processedCount += 1
        emit({ processed: processedCount, total, phase: 'extracting' })
        return delta
      }

      const chat = getChat(chatId, db)
      const chatMeta = {
        chatId,
        name: chat?.name ?? msgs[0]?.sender ?? null,
        isGroup: chat?.isGroup ?? false
      }
      // 窗口起點：DB 既有 openTodos；逐片把本輪新建的接上，供後片完成偵測 / 去重。
      const openTodos = getOpenTodosByChat(chatId, db)
      const createdInThisChat: TodoDTO[] = []
      const ignoreKw = cfg.chatIgnoreKeywords[chatId] ?? []

      try {
        for (const slice of sliceByDay(msgs)) {
          const recentContext = getRecentContextBeforeSlice(chatId, slice)
          const extract = await extractFn({
            now: nowIso,
            chat: chatMeta,
            // 本片訊息當「新訊息」；slice 前的最近訊息只作上下文，不參與新抽取。
            newMessages: slice,
            recentContext,
            // 餵入「DB 既有 + 本輪已建」未完成 todo，使後片能 resolve 前片所建（Fix 2）。
            openTodos: [...openTodos, ...createdInThisChat]
          })

          if (extract.importance !== 'noise') {
            for (const nt of extract.newTodos) {
              // 逐對話關鍵字忽略（第二層 per-chat 忽略）：命中就不建立此代辦。
              if (matchesChatIgnoreKeyword(nt, ignoreKw)) continue
              // Fix B1：同輪去重比對 [...openTodos, ...createdInThisChat]。
              const dup = findDuplicateOpenTodo(nt.title, [
                ...openTodos,
                ...createdInThisChat
              ])
              if (dup) {
                const merged = mergeSources(dup.id, nt.sourceMsgIds, db)
                if (merged) {
                  delta.todosMerged += 1
                  delta.updatedIds.push(dup.id)
                }
                continue
              }
              const created = createTodo(
                {
                  chatId,
                  bucket: nt.bucket,
                  status: bucketToActiveStatus(nt.bucket),
                  title: nt.title,
                  detail: nt.detail,
                  priority: nt.priority,
                  dueAt: nt.dueAt,
                  confidence: nt.confidence,
                  sourceMsgIds: nt.sourceMsgIds
                },
                db
              )
              delta.todosCreated += 1
              delta.createdIds.push(created.id)
              createdInThisChat.push(created)
            }
          }

          const resolvedIdsThisSlice = new Set<string>()
          for (const r of extract.resolved) {
            // 在「DB 既有 + 本輪已建」中找目標，使前片所建可在後片被完成偵測命中。
            const target =
              openTodos.find((t) => t.id === r.todoId) ??
              createdInThisChat.find((t) => t.id === r.todoId)
            if (!target) continue
            if (target.status === 'suggested_done' || target.status === 'done') continue
            const toDone = !(target.bucket === 'schedule' && isFuture(target.dueAt, nowMs))
            const updated = resolveTodo(target.id, r.evidence, toDone, db)
            if (updated) {
              // 標記記憶體鏡像狀態，避免後片重複 resolve 同一件（沿用 idempotent guard）。
              target.status = updated.status
              delta.resolvedIds.push(target.id)
              resolvedIdsThisSlice.add(target.id)
              if (toDone) delta.todosResolvedDone += 1
              else delta.todosSuggestedDone += 1
            }
          }

          // updates → 既有 todo 重新分類（比照 resolved 在 DB 既有 + 本輪已建中找目標）。
          for (const u of extract.updates ?? []) {
            const target =
              openTodos.find((t) => t.id === u.todoId) ??
              createdInThisChat.find((t) => t.id === u.todoId)
            if (!target) continue
            if (resolvedIdsThisSlice.has(target.id)) continue // 跳過本 slice 已 resolve 的 id，避免覆寫 resolve
            const changed = reclassifyTodo(u.todoId, { bucket: u.bucket, dueAt: u.dueAt }, db)
            if (changed > 0) {
              // 更新記憶體鏡像，使後片 slice 看到新分類。
              target.bucket = u.bucket
              if (u.bucket === 'schedule') target.status = 'scheduled'
              // 與 reclassifyTodo F4 對齊：只有具體值才覆寫鏡像 dueAt；null/undefined 都保留現值。
              if (u.dueAt != null) target.dueAt = u.dueAt
              delta.updatedIds.push(target.id)
            }
          }
        }
        markProcessed(msgIds, db)
      } catch (err) {
        delta.kind = 'fail'
        // 失敗 chat 訊息不標 processed（留待後續 live pipeline 或下次回顧）。
        void err
      }

      processedCount += 1
      emit({ processed: processedCount, total, phase: 'extracting' })
      return delta
    }
  )

  // ── 彙整各 chat 差量（主序列、單執行緒）────────────────────────
  for (const s of settled) {
    if (s.status === 'rejected') {
      result.chatsFailed += 1
      continue
    }
    const d = s.value
    if (d.kind === 'noise') {
      result.chatsSkippedNoise += 1
      continue
    }
    if (d.kind === 'fail') {
      result.chatsFailed += 1
      continue
    }
    result.chatsProcessed += 1
    result.todosCreated += d.todosCreated
    result.todosMerged += d.todosMerged
    result.todosResolvedDone += d.todosResolvedDone
    result.todosSuggestedDone += d.todosSuggestedDone
    result.createdIds.push(...d.createdIds)
    result.resolvedIds.push(...d.resolvedIds)
    result.updatedIds.push(...d.updatedIds)
  }

  // ── 7. 收尾 ────────────────────────────────────────────────
  const llmStatus =
    result.chatsFailed > 0 && result.chatsProcessed === 0
      ? 'error'
      : result.chatsFailed > 0
        ? 'partial'
        : 'ok'
  finishRun(
    runId,
    {
      newMsgs: result.newMsgs,
      chatsSeen: result.chatsSeen,
      todosCreated: result.todosCreated,
      todosResolved: result.resolvedIds.length,
      lineBridge: 'ok',
      llmStatus,
      note: `backfill ${days}d`
    },
    db
  )

  emit({ processed: total, total, phase: 'done' })
  return result
}

export interface BackfillMediaKeysResult {
  /** 取回窗口訊息數（= watch_json.py --since 回傳的訊息筆數）。 */
  scanned: number
  /** 既有列被補上媒體欄的筆數（取自 insertMessages 回傳的 media 補欄計數）。 */
  mediaBackfilled: number
}

export interface BackfillMediaKeysDeps {
  /** 取窗口訊息。預設 spawn watch_json.py --since；測試可注入固定陣列。 */
  fetchWindow?: (sinceMs: number) => Promise<{ messages: RawLineMessage[]; error?: string }>
  db?: Database
  now?: () => number
}

/**
 * 輕量 backfill：重讀「近 days 天」LINE 訊息並落庫，只補既有列的媒體欄
 * （key_material/orig_filename/file_size）。**不跑 LLM 抽取、不需 qwen 金鑰**，
 * 與 reviewLastDays（會跑 LLM、有 API 成本）不同。
 *
 * 重用 reviewLastDays 的窗口來源 spawnSinceSource（spawn watch_json.py --since，
 * --limit 20000 升冪截斷；7 天一般不觸頂）取回窗口訊息，取回後直接 insertMessages——
 * 落庫端（BF-1）已讓 insertMessages 對既有列補媒體欄。
 */
export async function backfillMediaKeys(
  days = DEFAULT_DAYS,
  deps: BackfillMediaKeysDeps = {}
): Promise<BackfillMediaKeysResult> {
  const db = deps.db ?? getDb()
  const nowFn = deps.now ?? (() => Date.now())
  const fetchWindow = deps.fetchWindow ?? spawnSinceSource

  const nowMs = nowFn()
  const sinceMs = nowMs - days * 24 * 60 * 60 * 1000

  const win = await fetchWindow(sinceMs)
  if (win.error) {
    throw new Error(`撈窗口訊息失敗: ${win.error}`)
  }

  const ins = insertMessages(win.messages, db)
  // mediaBackfilled 取自 insertMessages 回傳（BF-1 並行批新增的 media 補欄計數）。
  const mediaBackfilled = (ins as { mediaBackfilled?: number }).mediaBackfilled ?? 0

  return { scanned: win.messages.length, mediaBackfilled }
}
