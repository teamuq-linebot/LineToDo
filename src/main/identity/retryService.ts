import { createHash } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { IdentityRetryResultDTO } from '../../shared/api'
import { IDENTITY_QUERY_VERSION, IdentityDecisionValidationError, validateIdentityDecisions } from '../../shared/identityDecision'
import type { IdentityDecision } from '../../shared/identityDecision'
import { parseModelJson } from '../../shared/jsonReply'
import { LlmProviderError, type LlmProvider } from '../llm/provider/types'
import { getMessagesByChatAndIds } from '../db/messages.repo'
import { beginIdentitySourceAttempt, recordIdentitySourceAttempt, releaseIdentitySourceAttempt } from '../db/identity.repo'
import { recordIdentityRetryEvaluation, retryIdentityDecision } from './reviewPorts'

type IdentityEntityType = 'todo' | 'topic'

const IDENTITY_RETRY_SYSTEM = `你負責重新判斷一筆已延期的 LINE Todo 或群組議題身份。使用者提供的候選是完整但有上限的歷史候選；標題相同只代表候選線索，不代表同一件事。比較來源事件時間、工作內容、完成狀態、期限變更、重複發生與不同工作。證據不足、資料被截短或候選不確定時必須 defer。只輸出符合 JSON schema 的單筆 identity decision。`
const USER_CHAR_LIMIT = 7_000

interface RetryContext {
  entityType: IdentityEntityType
  draftRef: string
  draft: unknown
  messages: Array<{ msgId: string; ts: number; direction: 'in' | 'out'; text: string }>
  candidates: Array<{ entityType: IdentityEntityType; entityId: string; title: string; summary: string | null; status: string | null; bucket: string | null; dueAt: string | null; completionEventTs: number | null }>
  candidatesTruncated: boolean
}

function boundedPayload(context: RetryContext): { user: string; contextTruncated: boolean } {
  let titleLimit = 48
  let detailLimit = 180
  let messageLimit = 100
  const render = (): string => JSON.stringify({
    task: context.entityType,
    draftRef: context.draftRef,
    draft: (() => {
      const value = context.draft && typeof context.draft === 'object' ? { ...(context.draft as Record<string, unknown>) } : context.draft
      if (value && typeof value === 'object') {
        const copy = value as Record<string, unknown>
        if (typeof copy.title === 'string') copy.title = copy.title.slice(0, titleLimit)
        if (typeof copy.summary === 'string') copy.summary = copy.summary.slice(0, detailLimit)
        if (typeof copy.detail === 'string') copy.detail = copy.detail.slice(0, detailLimit)
        return copy
      }
      return value
    })(),
    sourceEvidence: context.messages.map((message) => ({ ...message, text: message.text.slice(0, messageLimit) })),
    historicalCandidates: context.candidates.map((candidate) => ({
      entityType: candidate.entityType,
      entityId: candidate.entityId,
      title: candidate.title.slice(0, titleLimit),
      status: candidate.status,
      bucket: candidate.bucket,
      dueAt: candidate.dueAt,
      completionEventTs: candidate.completionEventTs
    })),
    candidatesTruncated: context.candidatesTruncated,
    evidenceTextTruncated: context.messages.some((message) => message.text.length > messageLimit)
  })
  let user = render()
  while (user.length > USER_CHAR_LIMIT && (messageLimit > 24 || titleLimit > 20 || detailLimit > 48)) {
    messageLimit = Math.max(24, Math.floor(messageLimit / 2))
    titleLimit = Math.max(20, Math.floor(titleLimit / 2))
    detailLimit = Math.max(48, Math.floor(detailLimit / 2))
    user = render()
  }
  if (user.length > USER_CHAR_LIMIT) throw new Error('identity_retry_input_too_large')
  const contextTruncated = context.candidatesTruncated ||
    context.messages.some((message) => message.text.length > messageLimit) ||
    context.candidates.some((candidate) => candidate.title.length > titleLimit || (candidate.summary?.length ?? 0) > detailLimit)
  if (contextTruncated) {
    const value = JSON.parse(user) as { candidatesTruncated: boolean; evidenceTextTruncated: boolean }
    value.candidatesTruncated = true
    value.evidenceTextTruncated = true
    user = JSON.stringify(value)
  }
  return { user, contextTruncated }
}

function identitySchema(context: RetryContext): unknown {
  const candidateIds = context.candidates.map((candidate) => candidate.entityId)
  const evidenceIds = context.messages.map((message) => message.msgId)
  return {
    type: 'array', minItems: 1, maxItems: 1,
    items: {
      type: 'object', additionalProperties: false,
      required: ['draftRef', 'outcome', 'candidateType', 'candidateId', 'relationKind', 'reasonCode', 'confidenceBand', 'evidenceMsgIds'],
      properties: {
        draftRef: { type: 'string', enum: [context.draftRef] },
        outcome: { type: 'string', enum: ['update_existing', 'new', 'link', 'defer'] },
        candidateType: { type: ['string', 'null'], enum: [null, 'todo', 'topic'] },
        candidateId: { type: ['string', 'null'], enum: [null, ...candidateIds] },
        relationKind: { type: ['string', 'null'], enum: [null, 'recurrence', 'related_action', 'follow_up', 'same_topic'] },
        reasonCode: { type: 'string', enum: ['same_active_action', 'same_completed_action', 'reschedule', 'fresh_occurrence', 'distinct_action', 'ambiguous_candidates', 'insufficient_evidence', 'candidate_cap', 'related_topic'] },
        confidenceBand: { type: 'string', enum: ['low', 'medium', 'high'] },
        evidenceMsgIds: { type: 'array', minItems: 1, maxItems: Math.min(20, evidenceIds.length), items: { type: 'string', enum: evidenceIds } }
      }
    }
  }
}

export function createIdentityRetryService(db: Database) {
  return {
    async retry(input: { entityType: IdentityEntityType; decisionId: string; expectedDecisionRevision: number }, resolveProvider: () => LlmProvider | null): Promise<IdentityRetryResultDTO> {
      let provider: LlmProvider | null
      try { provider = resolveProvider() } catch { return { ok: false, reason: 'provider_unavailable' } }
      if (!provider) return { ok: false, reason: 'provider_unavailable' }
      let runtimeFingerprint: string | null = null
      try { runtimeFingerprint = await provider.runtimeFingerprint?.() ?? null } catch { return { ok: false, reason: 'provider_unavailable' } }
      const retried = retryIdentityDecision(db, input.entityType, input.decisionId, input.expectedDecisionRevision)
      if (!retried.ok) return retried
      const item = retried.item

      const sourceRows = getMessagesByChatAndIds(item.chatId, item.sourceMsgIds, db)
      if (sourceRows.length !== item.sourceMsgIds.length) return { ok: false, reason: 'source_missing', item }
      const context: RetryContext = {
        entityType: input.entityType,
        draftRef: item.draftRef,
        draft: item.draft,
        messages: retried.messages,
        candidates: retried.candidates.map(({ entityType, entityId, title, summary, status, bucket, dueAt, completionEventTs }) => ({ entityType, entityId, title, summary, status, bucket, dueAt, completionEventTs })),
        candidatesTruncated: retried.candidatesTruncated
      }
      let fitted: ReturnType<typeof boundedPayload>
      try { fitted = boundedPayload(context) } catch { return { ok: false, reason: 'input_too_large', item } }
      const schema = identitySchema(context)
      const system = `${IDENTITY_RETRY_SYSTEM}\n\n回應必須是單一陣列，恰好一筆 decision。候選／證據只能使用輸入內的 ID。若 candidatesTruncated 或 evidenceTextTruncated 為 true，只能 defer。`
      const sessionFingerprint = createHash('sha256').update(JSON.stringify({
        purpose: 'identity-review-retry', provider: provider.id, kind: provider.kind, runtimeFingerprint,
        system: createHash('sha256').update(system, 'utf8').digest('hex'), schema, query: IDENTITY_QUERY_VERSION
      }), 'utf8').digest('hex')
      const attempt = beginIdentitySourceAttempt(db, item.chatId, retried.snapshot, fitted.user, sessionFingerprint, new Date(), input.entityType)
      if (!attempt.lease) return { ok: false, reason: attempt.reason ?? 'source_stale', item }
      const lease = attempt.lease
      let raw: unknown
      try {
        const response = await provider.complete({
          system,
          user: fitted.user,
          temperature: 0,
          jsonSchema: { name: 'identity_retry', schema },
          onAdditionalUserPayload: (serializedUserPayload) => recordIdentitySourceAttempt(db, lease, serializedUserPayload, new Date(), false).ok
        })
        if (response.structured !== undefined) raw = response.structured
        else {
          const parsed = parseModelJson(response.text)
          if (!parsed.ok) throw new Error('identity_retry_invalid_json')
          raw = parsed.value
        }
      } catch (error) {
        releaseIdentitySourceAttempt(db, lease, true)
        return { ok: false, reason: error instanceof LlmProviderError ? error.code : 'provider_failed', item }
      }
      let suggestion: IdentityDecision
      try {
        const decisions = validateIdentityDecisions(raw, [item.draftRef], {
          candidates: retried.candidates,
          candidatesTruncated: fitted.contextTruncated,
          selectedMessageIds: item.sourceMsgIds,
          targetType: input.entityType
        })
        suggestion = decisions[0]
      } catch (error) {
        releaseIdentitySourceAttempt(db, lease, true)
        return { ok: false, reason: error instanceof IdentityDecisionValidationError ? error.reason : 'invalid_result', item }
      }
      const evaluated = recordIdentityRetryEvaluation(db, {
        entityType: input.entityType,
        decisionId: input.decisionId,
        expectedDecisionRevision: item.decisionRevision,
        snapshot: retried.snapshot,
        suggestion
      })
      if (!evaluated) {
        releaseIdentitySourceAttempt(db, lease, true)
        return { ok: false, reason: 'source_or_candidate_stale', item }
      }
      releaseIdentitySourceAttempt(db, lease, false)
      return { ok: true, item: evaluated }
    }
  }
}
