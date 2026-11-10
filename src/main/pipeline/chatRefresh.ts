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
}

export interface ChatRefreshResult {
  ok: boolean
  reason?: 'invalid_days' | 'unsupported_chat' | 'disabled' | 'no_ai'
  days: number | null
  sinceMs: number | null
  todo: { ran: boolean; messages: number; aiCalls: number; todosCreated: number; todosMerged: number; todosResolvedDone: number; failed: boolean }
  topics: { ran: boolean; aiCalls: number; analyzed: number; batches: number; failed: boolean; reason?: string }
}

function emptyResult(days: number | null, sinceMs: number | null, reason?: ChatRefreshResult['reason']): ChatRefreshResult {
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
  } catch {
    leg.failed = true
  }
  return leg
}

/**
 * 重新整理一個聊天室最近 N 天。N 不合法 → invalid_days；聊天室不存在 → unsupported_chat；
 * 待辦與議題都關 → disabled；只有 AI 缺席且待辦是唯一要跑的部分 → no_ai。
 */
export async function refreshChatLastDays(chatId: string, days: unknown, deps: ChatRefreshDeps): Promise<ChatRefreshResult> {
  const parsed = parseChatRefreshDays(days)
  if (parsed === null) return emptyResult(null, null, 'invalid_days')
  const nowMs = (deps.nowFn ?? (() => Date.now()))()
  const sinceMs = nowMs - parsed * DAY_MS
  const db = deps.db
  if (!getChat(chatId, db)) return emptyResult(parsed, sinceMs, 'unsupported_chat')
  const todoOn = isTodoExtractEnabled(db, chatId)
  const topicsOn = !!deps.topicRefresh && isTopicsEnabled(db, chatId)
  if (!todoOn && !topicsOn) return emptyResult(parsed, sinceMs, 'disabled')
  const cfg = deps.config ?? getPipelineDefaults()

  const result = emptyResult(parsed, sinceMs)
  let ok = true
  if (todoOn) {
    if (!deps.extractFn) {
      result.todo = { ...result.todo, ran: true, failed: true }
      ok = false
      result.reason = 'no_ai'
    } else {
      result.todo = await refreshTodos(chatId, sinceMs, nowMs, deps, cfg)
      if (result.todo.failed) ok = false
    }
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
