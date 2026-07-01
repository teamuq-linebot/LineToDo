import type { Database } from 'better-sqlite3'
import type OpenAI from 'openai'
import { getDb } from '../db/database'
import type { MessageDTO, TodoDTO } from '../db/dto'
import {
  insertMessages,
  getUnprocessedForPipeline,
  getRecentByChat,
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
import type { LineBridge, LlmStatus } from '../db/pipeline.repo'
import type { RawLineMessage } from '../line/types'
import { getQwenConfig } from '../config/qwen'
import { getPipelineDefaults } from '../config/defaults'
import type { PipelineDefaults } from '../config/defaults'
import { makeQwen } from '../llm/qwenClient'
import { extractTodos } from '../llm/extractor'
import type { ExtractResult } from '../llm/schema'
import { evaluateChatAutoBlock, isBatchNoise, matchesChatIgnoreKeyword } from './blocklist'
import { findDuplicateOpenTodo } from './dedup'
import { mapLimited } from './concurrency'

/**
 * runOnce.ts — 串起一輪 pipeline（IMPLEMENTATION_PLAN.md §8）。
 *
 * 1. 開 pipeline_runs。
 * 2. 取本輪 LINE 新訊息（watchSource，可注入；正式為 watcher.ts spawn watch_json.py）。
 * 3. upsert chats（套自動黑名單）+ INSERT OR IGNORE messages（msg_id 去重）。
 * 4. 取「未處理且 chat 未 blocked」訊息，按 chatId 分組。
 * 5. 每 chat：撈 recentContext + openTodos → extractFn（qwen，並發≤2）→ ExtractResult。
 * 6. 落 newTodos（套近似去重）、套 resolved（完成偵測門檻）；來源訊息標 processed=1。
 * 7. 收尾 pipeline_runs；回傳結果供 IPC 推播。
 *
 * 依賴注入（watchSource / extractFn）讓本函式可在無真金鑰 / 無 LINE 下用 mock dry-run。
 */

export interface RunOnceDeps {
  /** 取得本輪 LINE 新訊息。正式版 spawn watch_json.py；測試版回固定陣列。 */
  watchSource: () => Promise<{ messages: RawLineMessage[]; bridge: LineBridge; error?: string }>
  /**
   * 對單一 chat 抽取。正式版呼叫 qwen；測試版回 mock。
   * 失敗 throw → 該 chat 標 partial，不中斷整輪。
   */
  extractFn: (input: ChatExtractInput) => Promise<ExtractResult>
  db?: Database
  now?: () => string
  config?: PipelineDefaults
}

export interface ChatExtractInput {
  now: string
  chat: { chatId: string; name: string | null; isGroup: boolean }
  newMessages: MessageDTO[]
  recentContext: MessageDTO[]
  openTodos: TodoDTO[]
}

export interface RunOnceResult {
  runId: string
  lineBridge: LineBridge
  llmStatus: LlmStatus
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

/** bucket → 該 todo 建立時的 active 狀態（§4 status 對應）。 */
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

/** dueAt 是否仍在未來（schedule 完成偵測門檻用，§6.6）。解析失敗當「非未來」。 */
function isFuture(dueAt: string | null, nowIso: string): boolean {
  if (!dueAt) return false
  const due = Date.parse(dueAt)
  const now = Date.parse(nowIso)
  if (Number.isNaN(due) || Number.isNaN(now)) return false
  return due > now
}

/**
 * 執行一輪 pipeline。所有 DB 寫入用注入的 db（預設 getDb()）。
 */
export async function runOnce(deps: RunOnceDeps): Promise<RunOnceResult> {
  const db = deps.db ?? getDb()
  const nowFn = deps.now ?? (() => new Date().toISOString())
  const cfg = deps.config ?? getPipelineDefaults()
  const rules = cfg.blocklist

  const runId = startRun(db)
  const result: RunOnceResult = {
    runId,
    lineBridge: 'ok',
    llmStatus: 'ok',
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

  // ── 2. 取本輪新訊息 ──────────────────────────────────────
  let watch: { messages: RawLineMessage[]; bridge: LineBridge; error?: string }
  try {
    watch = await deps.watchSource()
  } catch (err) {
    result.lineBridge = 'error'
    result.note = `watchSource 失敗: ${err instanceof Error ? err.message : String(err)}`
    finishRun(runId, { lineBridge: 'error', llmStatus: 'ok', note: result.note }, db)
    return result
  }
  result.lineBridge = watch.bridge
  if (watch.bridge === 'error') {
    result.note = watch.error ?? 'LINE 橋接失敗'
    finishRun(runId, { lineBridge: 'error', note: result.note }, db)
    return result
  }

  // ── 3. 落庫 messages（去重）+ chats upsert ───────────────
  const ins = insertMessages(watch.messages, db)
  result.newMsgs = ins.inserted

  // 對「本輪觸及的 chat」評估自動黑名單（只對尚未被手動/自動 block 的）。
  for (const chatId of ins.chatIds) {
    const chat = getChat(chatId, db)
    if (!chat || chat.blocked) continue
    const verdict = evaluateChatAutoBlock(chat, rules)
    if (verdict.block) {
      setBlocked(chatId, true, verdict.reason, db)
    }
  }

  // ── 4. 取未處理且未 blocked 的訊息，按 chatId 分組 ─────────
  const unprocessed = getUnprocessedForPipeline(2000, db)
  const byChat = new Map<string, MessageDTO[]>()
  for (const m of unprocessed) {
    const arr = byChat.get(m.chatId)
    if (arr) arr.push(m)
    else byChat.set(m.chatId, [m])
  }
  result.chatsSeen = byChat.size

  if (byChat.size === 0) {
    finishRun(
      runId,
      { newMsgs: result.newMsgs, chatsSeen: 0, lineBridge: result.lineBridge, llmStatus: 'ok' },
      db
    )
    return result
  }

  // ── 金鑰檢查：無金鑰 → LLM 階段優雅停用（不崩潰、不硬寫）──
  // 注意：dry-run 測試會直接注入 extractFn，不依賴金鑰；此檢查只在「正式 qwen extractFn」路徑有意義。
  // 為讓注入式測試也能跑，金鑰判斷交給呼叫端（main 組裝 extractFn 前判）。

  const now = nowFn()
  const chatIds = [...byChat.keys()]

  // ── 5–6. 每 chat 抽取 + 落庫（並發節流）────────────────
  type ChatOutcome =
    | { kind: 'noise'; chatId: string; msgIds: string[] }
    | { kind: 'ok'; chatId: string; msgIds: string[]; extract: ExtractResult }
    | { kind: 'fail'; chatId: string; msgIds: string[]; error: string }

  const settled = await mapLimited<string, ChatOutcome>(
    chatIds,
    cfg.concurrency,
    async (chatId): Promise<ChatOutcome> => {
      const msgs = byChat.get(chatId)!
      const msgIds = msgs.map((m) => m.msgId)

      // 整批噪音 → 跳過 LLM（仍標 processed，避免下輪重抽）。
      if (isBatchNoise(msgs, rules)) {
        return { kind: 'noise', chatId, msgIds }
      }

      const chat = getChat(chatId, db)
      const recentAll = getRecentByChat(chatId, cfg.recentContextLimit + msgs.length, db)
      const newIdSet = new Set(msgIds)
      const recentContext = recentAll
        .filter((m) => !newIdSet.has(m.msgId))
        .slice(-cfg.recentContextLimit)
      const openTodos = getOpenTodosByChat(chatId, db)

      try {
        const extract = await deps.extractFn({
          now,
          chat: {
            chatId,
            name: chat?.name ?? msgs[0]?.sender ?? null,
            isGroup: chat?.isGroup ?? false
          },
          newMessages: msgs,
          recentContext,
          openTodos
        })
        return { kind: 'ok', chatId, msgIds, extract }
      } catch (err) {
        return {
          kind: 'fail',
          chatId,
          msgIds,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )

  // ── 落庫：DB 寫入在主執行緒序列化（better-sqlite3 同步），避免交錯 ──
  for (const s of settled) {
    if (s.status === 'rejected') {
      result.chatsFailed += 1
      continue
    }
    const outcome = s.value

    if (outcome.kind === 'noise') {
      result.chatsSkippedNoise += 1
      markProcessed(outcome.msgIds, db)
      continue
    }

    if (outcome.kind === 'fail') {
      result.chatsFailed += 1
      // 失敗 chat 的訊息「不」標 processed → 下輪重試（§6.1 失敗該 chat 標 partial）。
      continue
    }

    // kind === 'ok'
    result.chatsProcessed += 1
    const { chatId, msgIds, extract } = outcome
    const openTodos = getOpenTodosByChat(chatId, db)

    // importance==='noise' → 不產 todo（第二道降噪，§7.1）。
    if (extract.importance !== 'noise') {
      const ignoreKw = cfg.chatIgnoreKeywords[chatId] ?? []
      for (const nt of extract.newTodos) {
        // 逐對話關鍵字忽略（第二層 per-chat 忽略）：命中就不建立此代辦。
        if (matchesChatIgnoreKeyword(nt, ignoreKw)) continue
        const dup = findDuplicateOpenTodo(nt.title, openTodos)
        if (dup) {
          // 近似去重命中 → 更新既有 todo 的來源，不新增。
          const merged = mergeSources(dup.id, nt.sourceMsgIds, db)
          if (merged) {
            result.todosMerged += 1
            result.updatedIds.push(dup.id)
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
        result.todosCreated += 1
        result.createdIds.push(created.id)
      }
    }

    // resolved → 完成偵測門檻（§6.6）。
    const resolvedIdsThisChat = new Set<string>()
    for (const r of extract.resolved) {
      const target = openTodos.find((t) => t.id === r.todoId)
      if (!target) continue // 模型給了不存在 / 不屬此 chat 的 id → 忽略
      // idempotent guard（H1 抖動修正，§6.6「只降不升、避免抖動」）：
      // suggested_done 仍被 getOpenTodosByChat 當 open 餵 LLM，若模型每輪重列入 resolved，
      // 而 target 已是 suggested_done/done，就會每輪重呼 resolveTodo（重寫 updated_at/evidence）、
      // 重 push resolvedIds → 上游每輪 emit todos-changed → 無限重觸發。
      // 已結案/建議完成者直接跳過：只有狀態真的轉變才落庫 + push（避免抖動）。
      if (target.status === 'suggested_done' || target.status === 'done') continue
      // schedule 且 due_at 仍在未來 → 不自動 done，改 suggested_done（避免把未發生行程判完成）。
      const toDone = !(target.bucket === 'schedule' && isFuture(target.dueAt, now))
      const updated = resolveTodo(target.id, r.evidence, toDone, db)
      if (updated) {
        result.resolvedIds.push(target.id)
        resolvedIdsThisChat.add(target.id)
        if (toDone) result.todosResolvedDone += 1
        else result.todosSuggestedDone += 1
      }
    }

    // updates → 既有 todo 重新分類（時間確定後 todo/waiting → schedule 升級）。
    for (const u of extract.updates ?? []) {
      // 比照 resolved：確認目標屬本 chat（找不到 → 忽略跨 chat / 不存在 id）。
      const target = openTodos.find((t) => t.id === u.todoId)
      if (!target) continue
      if (resolvedIdsThisChat.has(u.todoId)) continue // 跳過本輪已 resolve 的 id，避免覆寫 resolve
      const changed = reclassifyTodo(u.todoId, { bucket: u.bucket, dueAt: u.dueAt }, db)
      if (changed > 0) result.updatedIds.push(u.todoId)
    }

    // 該 chat 訊息標 processed=1。
    markProcessed(msgIds, db)
  }

  // ── llm_status 判定 ──────────────────────────────────────
  if (result.chatsFailed > 0 && result.chatsProcessed > 0) result.llmStatus = 'partial'
  else if (result.chatsFailed > 0 && result.chatsProcessed === 0) result.llmStatus = 'error'
  else result.llmStatus = 'ok'

  // ── 7. 收尾 ──────────────────────────────────────────────
  finishRun(
    runId,
    {
      newMsgs: result.newMsgs,
      chatsSeen: result.chatsSeen,
      todosCreated: result.todosCreated,
      todosResolved: result.resolvedIds.length,
      lineBridge: result.lineBridge,
      llmStatus: result.llmStatus,
      note: result.note
    },
    db
  )

  return result
}

/**
 * 組一個「正式 qwen extractFn」：用設定中的金鑰 / baseURL / model。
 * 無金鑰 → 回 null，呼叫端據此跳過 LLM 階段並在 UI 提示（不崩潰、不硬寫）。
 */
export function makeQwenExtractFn(): ((input: ChatExtractInput) => Promise<ExtractResult>) | null {
  const cfg = getQwenConfig()
  if (!cfg.apiKey) return null
  const client: OpenAI = makeQwen({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL,
    timeoutMs: cfg.timeoutMs
  })
  return (input: ChatExtractInput) =>
    extractTodos(
      client,
      {
        now: input.now,
        chat: input.chat,
        newMessages: input.newMessages,
        recentContext: input.recentContext,
        openTodos: input.openTodos
      },
      { model: cfg.model, structuredMode: 'auto' }
    )
}
