import { z } from 'zod'

/** Model-facing identity outcomes are suggestions; every identifier is checked against
 * application-captured candidate/source context before any canonical write. */
export const IDENTITY_QUERY_VERSION = 'identity-query-v2'
export const IDENTITY_REASON_CODES = [
  'same_active_action', 'same_completed_action', 'reschedule', 'fresh_occurrence', 'distinct_action',
  'ambiguous_candidates', 'insufficient_evidence', 'candidate_cap', 'related_topic'
] as const
export const IDENTITY_RELATIONS = ['recurrence', 'related_action', 'follow_up', 'same_topic'] as const

export const IdentityDecisionSchema = z.object({
  draftRef: z.string().regex(/^[a-z0-9_-]{1,40}$/i),
  outcome: z.enum(['update_existing', 'new', 'link', 'defer']),
  candidateType: z.enum(['todo', 'topic']).nullable(),
  candidateId: z.string().min(1).max(128).nullable(),
  relationKind: z.enum(IDENTITY_RELATIONS).nullable(),
  reasonCode: z.enum(IDENTITY_REASON_CODES),
  confidenceBand: z.enum(['low', 'medium', 'high']),
  evidenceMsgIds: z.array(z.string().min(1).max(256)).min(1).max(20)
}).strict()

export type IdentityDecision = z.infer<typeof IdentityDecisionSchema>
export interface IdentityCandidate {
  entityType: 'todo' | 'topic'
  entityId: string
  title: string
  summary: string | null
  status: string | null
  bucket: string | null
  dueAt: string | null
  sourceMsgIds: string[]
  recallReasons: Array<'source_overlap' | 'exact_title' | 'token_overlap' | 'history_alias'>
  completionEventTs: number | null
}

/** Trusted context kept by the application. It is not accepted from the model output. */
export interface IdentityContextSnapshot {
  sourceEpoch: number
  scopeRevision: number
  identityRevision: number
  topicIdentityRevision: number
  queryVersion: string
  candidatesTruncated: boolean
  candidateRevisions: Array<{ entityType: 'todo' | 'topic'; entityId: string; revision: number }>
  selectedFingerprints: Array<{ msgId: string; contentFingerprint: string }>
}

export interface IdentityValidationContext {
  candidates: IdentityCandidate[]
  candidatesTruncated: boolean
  selectedMessageIds: string[]
  targetType: 'todo' | 'topic'
  allowedTodoIds?: string[]
}

export class IdentityDecisionValidationError extends Error {
  readonly path: string
  readonly reason: string
  constructor(path: string, reason: string) {
    super('invalid_identity_decision')
    this.name = 'IdentityDecisionValidationError'
    this.path=path
    this.reason=reason
  }
}

/** Validate all draft refs, candidate IDs, relation types and evidence against trusted input. */
export function validateIdentityDecisions(
  raw: unknown,
  draftRefs: string[],
  context: IdentityValidationContext
): IdentityDecision[] {
  const parsed = z.array(IdentityDecisionSchema).safeParse(raw)
  if (!parsed.success || parsed.data.length !== draftRefs.length) {
    throw new IdentityDecisionValidationError('identityDecisions', 'missing_or_invalid_decision')
  }
  const drafts = new Set(draftRefs)
  const seen = new Set<string>()
  const candidates = new Map(context.candidates.map((candidate) => [`${candidate.entityType}:${candidate.entityId}`, candidate]))
  const selected = new Set(context.selectedMessageIds)
  for (const decision of parsed.data) {
    if (!drafts.has(decision.draftRef) || seen.has(decision.draftRef)) {
      throw new IdentityDecisionValidationError('identityDecisions.draftRef', 'unknown_or_duplicate_draft_ref')
    }
    if (!decision.evidenceMsgIds.every((id) => selected.has(id)) || new Set(decision.evidenceMsgIds).size !== decision.evidenceMsgIds.length) {
      throw new IdentityDecisionValidationError('identityDecisions.evidenceMsgIds', 'unselected_or_duplicate_evidence')
    }
    if (context.candidatesTruncated) {
      if (decision.outcome !== 'defer') throw new IdentityDecisionValidationError('identityDecisions.outcome', 'candidate_context_truncated')
    }
    if (decision.candidateId === null) {
      if (decision.candidateType !== null || decision.relationKind !== null || decision.outcome === 'update_existing' || decision.outcome === 'link') {
        throw new IdentityDecisionValidationError('identityDecisions.candidateId', 'candidate_required_or_fields_inconsistent')
      }
    } else {
      if (decision.candidateType === null || !candidates.has(`${decision.candidateType}:${decision.candidateId}`)) {
        throw new IdentityDecisionValidationError('identityDecisions.candidateId', 'candidate_not_supplied')
      }
      if (decision.outcome === 'new' && decision.relationKind !== null && decision.relationKind !== 'recurrence') {
        throw new IdentityDecisionValidationError('identityDecisions.relationKind', 'new_candidate_only_supports_recurrence')
      }
      if(decision.outcome==='new'&&decision.relationKind==='recurrence'&&decision.candidateType!==context.targetType){
        throw new IdentityDecisionValidationError('identityDecisions.candidateType','recurrence_target_type_mismatch')
      }
      if (decision.outcome === 'defer' && decision.relationKind !== null) throw new IdentityDecisionValidationError('identityDecisions.relationKind', 'defer_cannot_link')
      if (decision.outcome === 'update_existing' && (decision.candidateType !== context.targetType || decision.relationKind !== null)) {
        throw new IdentityDecisionValidationError('identityDecisions.outcome', 'update_requires_same_type_candidate')
      }
      if (decision.outcome === 'link') {
        if (!decision.relationKind) throw new IdentityDecisionValidationError('identityDecisions.relationKind', 'link_requires_relation')
        if (decision.relationKind === 'same_topic' && decision.candidateType !== 'topic') throw new IdentityDecisionValidationError('identityDecisions.candidateType', 'same_topic_requires_topic')
        if (decision.relationKind !== 'same_topic' && decision.candidateType !== context.targetType) throw new IdentityDecisionValidationError('identityDecisions.candidateType', 'relation_target_type_mismatch')
      }
    }
    if (decision.outcome === 'update_existing' && decision.reasonCode !== 'same_active_action' && decision.reasonCode !== 'same_completed_action' && decision.reasonCode !== 'reschedule') {
      throw new IdentityDecisionValidationError('identityDecisions.reasonCode', 'update_reason_not_supported')
    }
    seen.add(decision.draftRef)
  }
  if (seen.size !== drafts.size) throw new IdentityDecisionValidationError('identityDecisions', 'missing_draft_decision')
  return parsed.data
}

