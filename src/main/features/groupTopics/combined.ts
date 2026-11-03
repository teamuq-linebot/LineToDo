/**
 * combined.ts — 待辦＋議題合併回覆（`{ todo, topic }`）的純函式封裝：外層驗證、容錯、至少一邊可用、拆分與議題候選過濾。
 * 沒有 I/O、不碰資料庫；兩個既有驗證器（validateExtractResult、validateTopicAnalysis）原封不動，這裡只負責呼叫它們。
 */
import { validateExtractResult } from '../../../shared/extractResult'
import type { ExtractIdentityValidationContext, ExtractResult } from '../../../shared/extractResult'
import type { IdentityCandidate } from '../../../shared/identityDecision'
import { validateTopicAnalysis } from './domain'
import type { TopicAnalysis, TopicMessageInput } from './domain'

/** user payload 的可選 `topic` 鍵（算出來是空集合時整個鍵不送）。 */
export interface CombinedTopicPayload {
  targetMsgIds: string[]
  existingLocalTopics: Array<{ ref: string; title: string; summary: string }>
}

/** 外層封裝正確、且至少一邊可用的回覆；topic 缺席時為 null。 */
export interface CombinedEnvelope {
  todo: unknown
  topic: unknown | null
}

export type CombinedEnvelopeResult = { ok: true; value: CombinedEnvelope } | { ok: false; reason: string }

export interface CombinedSplitContext {
  /** 與純待辦路徑完全相同的嚴格驗證 context（含 allowedTodoIds、selectedMessageIds）。 */
  todo: ExtractIdentityValidationContext
  /** 省略（或 targets 為空）＝這個 part 沒有送 topic，回覆裡的 topic 一律視為缺席。 */
  topic?: { targets: TopicMessageInput[]; candidates: IdentityCandidate[]; candidatesTruncated: boolean }
}

export type CombinedTodoSplit = { ok: true; value: ExtractResult } | { ok: false; error: unknown }
export type CombinedTopicSplit = { state: 'ok'; value: TopicAnalysis } | { state: 'fail'; error: unknown } | { state: 'absent' }
export interface CombinedSplit { todo: CombinedTodoSplit; topic: CombinedTopicSplit }

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function reasonOf(error: unknown): string {
  const issues = (error as { issues?: Array<{ path?: unknown[]; message?: string }> } | null)?.issues
  if (Array.isArray(issues)) return issues.slice(0, 4).map((i) => `${(i.path ?? []).join('.') || '(root)'}: ${i.message ?? 'invalid'}`).join('；')
  return String(error instanceof Error ? error.message : error).slice(0, 160)
}

/** 議題候選過濾：驗證議題時 `candidates` 只留 entityType==='topic'（待辦與議題共用同一份清單送出）。 */
export function topicCandidatesOnly(candidates: IdentityCandidate[]): IdentityCandidate[] {
  return candidates.filter((candidate) => candidate.entityType === 'topic')
}

/** topic 的外形檢查（worker 層用；嚴格驗證在 splitCombined）。 */
function topicShapeUsable(topic: unknown): boolean {
  if (!isPlainObject(topic)) return false
  return Object.keys(topic).sort().join(',') === 'assignments,identityDecisions,topics'
    && Array.isArray(topic.topics) && Array.isArray(topic.assignments) && Array.isArray(topic.identityDecisions)
}

/**
 * worker 層驗證：只檢查「外層封裝正確」與「至少一邊可用」，兩邊的嚴格驗證留給 commit。
 * - 回覆沒有 `todo` 鍵、但整包通過 validateExtractResult：容錯成 `{ todo: 整包, topic: null }`。
 * - 兩邊都不可用：ok:false，讓 port 重問一次。
 */
export function validateCombinedEnvelope(value: unknown): CombinedEnvelopeResult {
  if (!isPlainObject(value)) return { ok: false, reason: '(root): 必須是 JSON 物件' }
  if (!('todo' in value)) {
    try { return { ok: true, value: { todo: validateExtractResult(value), topic: null } } } catch (error) {
      return { ok: false, reason: `(root): 需要 todo 與 topic 兩個欄位；${reasonOf(error)}` }
    }
  }
  const extra = Object.keys(value).filter((key) => key !== 'todo' && key !== 'topic')
  if (extra.length) return { ok: false, reason: `(root): 不可有 todo、topic 以外的欄位（${extra.slice(0, 4).join('、')}）` }
  const topic = value.topic === undefined ? null : value.topic
  let todoReason: string | null = null
  let todo: unknown = value.todo
  try { todo = validateExtractResult(value.todo) } catch (error) { todoReason = reasonOf(error) }
  if (todoReason === null || topicShapeUsable(topic)) return { ok: true, value: { todo, topic } }
  return { ok: false, reason: `todo: ${todoReason}` }
}

/**
 * commit 層：兩邊各自用嚴格 context 驗證。
 * - 待辦：validateExtractResult(todo, ctx.todo)，與純待辦路徑相同。
 * - 議題：validateTopicAnalysis(topic, targets, { candidates: 只含 topic 類, candidatesTruncated })。
 * 回覆已是 worker 層正規化後的 `{ todo, topic }`；也接受未經正規化的原始值（先走 validateCombinedEnvelope 的容錯）。
 */
export function splitCombined(value: unknown, ctx: CombinedSplitContext): CombinedSplit {
  let envelope: CombinedEnvelope
  if (isPlainObject(value) && 'todo' in value && Object.keys(value).every((key) => key === 'todo' || key === 'topic')) {
    envelope = { todo: value.todo, topic: value.topic === undefined ? null : value.topic }
  } else {
    const flat = validateCombinedEnvelope(value)
    if (!flat.ok) {
      const error = new Error(flat.reason)
      return { todo: { ok: false, error }, topic: { state: 'absent' } }
    }
    envelope = flat.value
  }
  let todo: CombinedTodoSplit
  try { todo = { ok: true, value: validateExtractResult(envelope.todo, ctx.todo) } } catch (error) { todo = { ok: false, error } }
  let topic: CombinedTopicSplit
  const sent = ctx.topic && ctx.topic.targets.length > 0 ? ctx.topic : null
  if (!sent || envelope.topic === null) topic = { state: 'absent' }
  else {
    try {
      topic = { state: 'ok', value: validateTopicAnalysis(envelope.topic, sent.targets, { candidates: topicCandidatesOnly(sent.candidates), candidatesTruncated: sent.candidatesTruncated }) }
    } catch (error) { topic = { state: 'fail', error } }
  }
  return { todo, topic }
}
