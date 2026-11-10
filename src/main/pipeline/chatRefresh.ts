import type { Database } from 'better-sqlite3'
import { createHash } from 'node:crypto'
import type { MessageDTO } from '../db/dto'
import { getByChatSince, listMessages } from '../db/messages.repo'
import { getChat } from '../db/chats.repo'
import { isTodoExtractEnabled } from '../db/chatTodoPrefs.repo'
import { getOpenTodosByChat } from '../db/todos.repo'
import { advanceIdentityIndex, beginIdentitySourceAttempt, captureIdentitySnapshot, recallTodoIdentityCandidates, releaseIdentitySourceAttempt, tableExists } from '../db/identity.repo'
import { isEnabled as isTopicsEnabled } from '../features/groupTopics/repository'
import { getPipelineDefaults, type PipelineDefaults } from '../config/defaults'
import { isBatchNoise } from './blocklist'
import { applyChatExtract } from './runOnce'
import type { ApplyTally, ChatExtractInput } from './runOnce'
import { buildUserPayload, EXTRACT_SYSTEM_PROMPT } from '../llm/extractPrompt'
import { EXTRACT_JSON_SCHEMA, type ExtractResult } from '../llm/schema'
import { IDENTITY_QUERY_VERSION } from '../../shared/identityDecision'

/**
 * chatRefresh.ts：「重新整理最近 N 天」，只針對一個聊天室。
 *
 * - 來源：app DB 內該聊天室 N 天內的全部訊息（含 processed=1 的），不向 LINE 引擎重撈。
 * - 待辦：沿用回顧的逐日切片與 identity 流程，但不經 ReviewLedger（ledger 會讓同一批訊息第二次整個跳過）；
 *   套用時 `refreshOnly`：已完成／已忽略的待辦不建卡、不改回；來源已屬於既有待辦的草稿不再建卡。
 * - 議題：交給 deps.topicRefresh（groupTopics 服務的 refreshWindow），同樣分析全部訊息。
 * - 開關：待辦開才跑待辦、議題開才跑議題；兩者皆關回 disabled。
 * - 不寫 messages.processed 以外的任何列；不改 schema。
 */

const DAY_MS = 24 * 60 * 60 * 1000
export const CHAT_REFRESH_MIN_DAYS = 1
export const CHAT_REFRESH_MAX_DAYS = 365

/** 只接受 1–365 的整數；其餘（0、366、小數、NaN、非數字）一律 null。 */
export function parseChatRefreshDays(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  return value >= CHAT_REFRESH_MIN_DAYS && value <= CHAT_REFRESH_MAX_DAYS ? value : null
}

export interface TopicRefreshOutcome {
  ok: boolean
  reason?: string
  analyzedCount: number
  batches: number
}

export interface ChatRefreshDeps {
  db: Database
  nowFn?: () => number
  config?: PipelineDefaults
  /** 待辦抽取函式（與回顧相同的 ExtractFn）；null＝沒有可用的 AI。 */
  extractFn: ((input: ChatExtractInput) => Promise<ExtractResult>) | null
  /** extractFn 是否由 ExtractQueue 代管 identity attempt（外掛）。 */
  identityAttemptManagedByQueue?: boolean
  correctionsForChat?: (chatId: string) => Array<{ id: string; revision: number; condition: string; effect: string }>
  onCorrectionsPayloadBuilt?: (chatId: string, messageIds: string[], rules: Array<{ id: string; revision: number; condition: string; effect: string }>) => void
  /** 議題重新分析；省略＝議題不參與（等同議題關閉）。 */
  topicRefresh?: (chatId: string, sinceMs: number) => Promise<TopicRefreshOutcome>
  /** host AI 是否就緒（未安裝、未登入、模型無法載入都是 false）；省略＝視為就緒。false 時不送任何請求，直接回 ai_unavailable。 */
  aiReady?: () => Promise<boolean>
}

export interface ChatRefreshResult {
  ok: boolean
  /** already_queued／already_running：同一聊天室已在排隊或執行中，這次不重複加入（外掛的排隊層產生）。 */
  reason?: 'invalid_days' | 'unsupported_chat' | 'disabled' | 'ai_unavailable' | 'already_queued' | 'already_running'
  days: number | null
  sinceMs: number | null
  /** failed 時 reason 是底層失敗原因碼（如 extract_await_timeout、transport），不再吞掉。 */
  todo: { ran: boolean; messages: number; aiCalls: number; todosCreated: number; todosMerged: number; todosResolvedDone: number; failed: boolean; reason?: string }
  topics: { ran: boolean; aiCalls: number; analyzed: number; batches: number; failed: boolean; reason?: string }
}

export function emptyResult(days: number | null, sinceMs: number | null, reason?: ChatRefreshResult['reason']): ChatRefreshResult {
  return {
    ok: false,
    ...(reason ? { reason } : {}),
    days,
    sinceMs,
    todo: { ran: false, messages: 0, aiCalls: 0, todosCreated: 0, todosMerged: 0, todosResolvedDone: 0, failed: false },
    topics: { ran: false, aiCalls: 0, analyzed: 0, batches: 0, failed: false }
  }
}

/** 依 sinceMs 起算的日切片（與回顧的 sliceByDay 同一規則）。 */
function sliceByDay(msgs: MessageDTO[], sinceMs: number): MessageDTO[][] {
  const output: MessageDTO[][] = []
  let current: MessageDTO[] = []
  let currentDay = -1
  for (const message of msgs) {
    const day = Math.floor((message.ts - sinceMs) / DAY_MS)
    if (day !== currentDay) { if (current.length) output.push(current); current = []; currentDay = day }
    current.push(message)
  }
  if (current.length) output.push(current)
  return output
}

type TodoLeg = ChatRefreshResult['todo']

const REASON_CODE = /^[a-z0-9_]{2,40}$/

/** 失敗原因碼：優先取錯誤的 `.code`（AiPortError、host 錯誤），否則取 Error 訊息（佇列的 extract_await_timeout 等）；都不是短代碼時 'unknown'。 */
function failureReason(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && REASON_CODE.test(code)) return code
  const message = error instanceof Error ? error.message : ''
  return REASON_CODE.test(message) ? message : 'unknown'
}

/**
 * groupTopics 的 refreshWindow 結果 → TopicRefreshOutcome。第一批失敗時外層 reason 是 `analysis_failed`，
 * 真正原因在 failure.code（如 transport），所以優先取 failure.code。
 */
export function topicRefreshOutcome(r: { ok: boolean; reason?: string; failure?: { code: string }; analyzedCount: number; batches: number }): TopicRefreshOutcome {
  return { ok: r.ok, reason: r.failure?.code ?? r.reason, analyzedCount: r.analyzedCount, batches: r.batches }
}

async function refreshTodos(chatId: string, sinceMs: number, nowMs: number, deps: ChatRefreshDeps, cfg: PipelineDefaults): Promise<TodoLeg> {
  const db = deps.db
  const extractFn = deps.extractFn!
  const msgs = getByChatSince(chatId, sinceMs, db)
  const leg: TodoLeg = { ran: true, messages: msgs.length, aiCalls: 0, todosCreated: 0, todosMerged: 0, todosResolvedDone: 0, failed: false }
  if (msgs.length === 0 || isBatchNoise(msgs, cfg.blocklist)) return leg

  const chat = getChat(chatId, db)
  const chatMeta = { chatId, name: chat?.name ?? msgs[0]?.sender ?? null, isGroup: chat?.isGroup ?? false }
  const nowIso = new Date(nowMs).toISOString()
  const managed = deps.identityAttemptManagedByQueue === true
  try {
    if (!advanceIdentityIndex(db, chatId, 'todo')) throw new Error('todo_identity_index_building')
    if (tableExists(db, 'discussion_topics') && !advanceIdentityIndex(db, chatId, 'topic')) throw new Error('topic_identity_index_building')
    for (const slice of sliceByDay(msgs, sinceMs)) {
      const first = slice[0]
      const recentContext = cfg.recentContextLimit > 0 ? listMessages({ chatId, beforeTs: first.ts, limit: cfg.recentContextLimit }, db).reverse() : []
      const openTodos = getOpenTodosByChat(chatId, db)
      const recalled = recallTodoIdentityCandidates(db, chatId, slice.map((m) => m.text ?? ''), slice.map((m) => m.msgId))
      if (!recalled.ready) throw new Error('todo_identity_index_not_ready')
      const identitySnapshot: ChatExtractInput['identitySnapshot'] | null = captureIdentitySnapshot(db, chatId, slice, recalled.truncated, recalled.candidateRevisions)
      if (!identitySnapshot) throw new Error('todo_identity_source_state_missing')
      const classificationCorrections = deps.correctionsForChat?.(chatId) ?? []
      const input: ChatExtractInput = {
        now: nowIso, chat: chatMeta, newMessages: slice, recentContext, openTodos,
        identityCandidates: recalled.candidates, identityCandidatesTruncated: recalled.truncated, identitySnapshot,
        identityAttemptManagedByQueue: managed,
        classificationCorrections,
        ...(classificationCorrections.length && deps.onCorrectionsPayloadBuilt
          ? { onCorrectionsPayloadBuilt: () => deps.onCorrectionsPayloadBuilt!(chatId, slice.map((m) => m.msgId), classificationCorrections) }
          : {})
      }
      const lease = managed ? null : beginIdentitySourceAttempt(db, chatId, identitySnapshot, buildUserPayload(input),
        createHash('sha256').update(JSON.stringify({ system: EXTRACT_SYSTEM_PROMPT, schema: EXTRACT_JSON_SCHEMA.schema, identityQuery: IDENTITY_QUERY_VERSION })).digest('hex'))
      if (lease && !lease.lease) throw new Error('todo_identity_lease_' + (lease.reason ?? 'unavailable'))
      if (lease?.lease) identitySnapshot.sourceLease = lease.lease
      let extract: ExtractResult
      leg.aiCalls += 1
      try { extract = await extractFn(input) } catch (error) {
        if (lease?.lease) releaseIdentitySourceAttempt(db, lease.lease, true)
        throw error
      }
      const sourceLease = input.identitySnapshot.sourceLease ?? lease?.lease
      if (!sourceLease) throw new Error('todo_identity_source_lease_missing')
      const tally: ApplyTally = { todosCreated: 0, todosMerged: 0, todosResolvedDone: 0, todosSuggestedDone: 0, createdIds: [], resolvedIds: [], updatedIds: [] }
      try {
        applyChatExtract({ db, cfg, now: nowIso, identity: {
          snapshot: identitySnapshot, sourceLease, candidates: input.identityCandidates, candidatesTruncated: input.identityCandidatesTruncated,
          selectedMessageIds: slice.map((m) => m.msgId), targetType: 'todo', allowedTodoIds: openTodos.map((todo) => todo.id), refreshOnly: true
        } }, chatId, slice.map((m) => m.msgId), extract, tally)
      } catch (error) { releaseIdentitySourceAttempt(db, sourceLease, true); throw error }
      leg.todosCreated += tally.todosCreated
      leg.todosMerged += tally.todosMerged
      leg.todosResolvedDone += tally.todosResolvedDone
    }
  } catch (error) {
    leg.failed = true
    leg.reason = failureReason(error)
  }
  return leg
}

interface RefreshGate { days: number; nowMs: number; sinceMs: number; todoOn: boolean; topicsOn: boolean }

/** 開始前的守門：不合法就回結果（不碰 AI、不碰資料）；通過就回排程需要的參數。 */
async function gateChatRefresh(chatId: string, days: unknown, deps: ChatRefreshDeps): Promise<ChatRefreshResult | RefreshGate> {
  const parsed = parseChatRefreshDays(days)
  if (parsed === null) return emptyResult(null, null, 'invalid_days')
  const nowMs = (deps.nowFn ?? (() => Date.now()))()
  const sinceMs = nowMs - parsed * DAY_MS
  const db = deps.db
  if (!getChat(chatId, db)) return emptyResult(parsed, sinceMs, 'unsupported_chat')
  const todoOn = isTodoExtractEnabled(db, chatId)
  const topicsOn = !!deps.topicRefresh && isTopicsEnabled(db, chatId)
  if (!todoOn && !topicsOn) return emptyResult(parsed, sinceMs, 'disabled')
  if (!deps.extractFn || !(deps.aiReady ? await deps.aiReady().catch(() => false) : true)) return emptyResult(parsed, sinceMs, 'ai_unavailable')
  return { days: parsed, nowMs, sinceMs, todoOn, topicsOn }
}

/**
 * 只做守門（同 refreshChatLastDays 開頭）：回傳不需要排隊的結果（參數錯誤、聊天室不存在、開關全關、AI 未就緒），
 * 通過則回 null。外掛的排隊層用它讓這幾種情況立即回報，不要排在別的聊天室後面等。
 */
export async function precheckChatRefresh(chatId: string, days: unknown, deps: ChatRefreshDeps): Promise<ChatRefreshResult | null> {
  const gate = await gateChatRefresh(chatId, days, deps)
  return 'ok' in gate ? gate : null
}

/**
 * 重新整理一個聊天室最近 N 天。N 不合法 → invalid_days；聊天室不存在 → unsupported_chat；
 * 待辦與議題都關 → disabled；AI 未就緒（或沒有抽取函式）→ ai_unavailable，不送任何請求、不進佇列等待。
 */
export async function refreshChatLastDays(chatId: string, days: unknown, deps: ChatRefreshDeps): Promise<ChatRefreshResult> {
  const gate = await gateChatRefresh(chatId, days, deps)
  if ('ok' in gate) return gate
  const { todoOn, topicsOn, nowMs, sinceMs } = gate
  const cfg = deps.config ?? getPipelineDefaults()

  const result = emptyResult(gate.days, sinceMs)
  let ok = true
  if (todoOn) {
    result.todo = await refreshTodos(chatId, sinceMs, nowMs, deps, cfg)
    if (result.todo.failed) ok = false
  }
  if (topicsOn) {
    const outcome = await deps.topicRefresh!(chatId, sinceMs)
    result.topics = {
      ran: true,
      aiCalls: outcome.batches,
      analyzed: outcome.analyzedCount,
      batches: outcome.batches,
      failed: !outcome.ok,
      ...(outcome.ok ? {} : { reason: outcome.reason ?? 'analysis_failed' })
    }
    if (!outcome.ok) ok = false
  }
  result.ok = ok
  return result
}
