/** Stable contracts for the local, chat-scoped group topic projection. */
export type Relevance = 'action' | 'awareness' | 'unrelated' | 'unknown'
export type TopicRelation = 'about' | 'repost' | 'uncertain'

export interface TopicMessageInput {
  msgId: string
  ts: number
  direction: 'in' | 'out'
  text: string
}

export interface TopicDraft {
  ref: string
  title: string
  summary: string
}

export interface TopicAssignment {
  msgId: string
  topicRef: string | null
  relation: TopicRelation
  confidence: number
  relevance: Relevance
  relevanceEvidenceMsgIds: string[]
}

export interface TopicAnalysis {
  topics: TopicDraft[]
  assignments: TopicAssignment[]
}

export interface TopicView {
  topicId: string
  chatId: string
  title: string
  summary: string
  lastSourceTs: number
  evidenceCount: number
  evidenceMsgIds: string[]
  participantLowerBound: number | null
  userParticipation: 'i_participated' | 'unknown'
  relevance: Relevance
  relevanceEvidenceMsgIds: string[]
  relevanceEvidence: Array<{ relevance: Relevance; evidenceMsgIds: string[] }>
  observation: 'unknown'
  heat: 'unvalidated'
  trend: 'unknown'
}

export type TopicFailurePath = '$' | '$.topics' | '$.topics[*].ref' | '$.topics[*].title' | '$.topics[*].summary' | '$.assignments' | '$.assignments[*]' | '$.assignments[*].msgId' | '$.assignments[*].topicRef' | '$.assignments[*].relation' | '$.assignments[*].confidence' | '$.assignments[*].relevance' | '$.assignments[*].relevanceEvidenceMsgIds'
export type TopicValidationReason = 'invalid_shape' | 'invalid_value' | 'duplicate_ref' | 'duplicate_assignment' | 'unknown_message_ref' | 'unknown_topic_ref' | 'missing_assignment' | 'invalid_evidence' | 'too_many_topics'

export class TopicAnalysisValidationError extends Error {
  readonly path: TopicFailurePath
  readonly reason: TopicValidationReason
  constructor(path: TopicFailurePath, reason: TopicValidationReason) {
    super('invalid_output')
    this.name = 'TopicAnalysisValidationError'
    this.path = path
    this.reason = reason
  }
}

function invalid(path: TopicFailurePath, reason: TopicValidationReason): never {
  throw new TopicAnalysisValidationError(path, reason)
}

export function validateTopicAnalysis(value: unknown, input: TopicMessageInput[]): TopicAnalysis {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('$', 'invalid_shape')
  const root = value as Record<string, unknown>
  if (Object.keys(root).sort().join(',') !== 'assignments,topics' || !Array.isArray(root.topics) || !Array.isArray(root.assignments)) invalid('$', 'invalid_shape')
  const refs = new Set<string>()
  const topics: TopicDraft[] = root.topics.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('$.topics', 'invalid_shape')
    const t = raw as Record<string, unknown>
    if (Object.keys(t).sort().join(',') !== 'ref,summary,title') invalid('$.topics', 'invalid_shape')
    if (typeof t.ref !== 'string' || !/^[a-z0-9_-]{1,40}$/i.test(t.ref)) invalid('$.topics[*].ref', 'invalid_value')
    if (refs.has(t.ref)) invalid('$.topics[*].ref', 'duplicate_ref')
    if (typeof t.title !== 'string' || !t.title.trim() || t.title.length > 120) invalid('$.topics[*].title', 'invalid_value')
    if (typeof t.summary !== 'string' || !t.summary.trim() || t.summary.length > 500) invalid('$.topics[*].summary', 'invalid_value')
    refs.add(t.ref)
    return { ref: t.ref, title: t.title.trim(), summary: t.summary.trim() }
  })
  if (topics.length > 30) invalid('$.topics', 'too_many_topics')
  if (root.assignments.length !== input.length) invalid('$.assignments', root.assignments.length < input.length ? 'missing_assignment' : 'invalid_shape')
  const allowedIds = new Set(input.map((m) => m.msgId))
  const seen = new Set<string>()
  const assignments: TopicAssignment[] = root.assignments.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('$.assignments[*]', 'invalid_shape')
    const a = raw as Record<string, unknown>
    const keys = Object.keys(a).sort().join(',')
    if (keys !== 'confidence,msgId,relation,relevance,relevanceEvidenceMsgIds,topicRef') invalid('$.assignments[*]', 'invalid_shape')
    if (typeof a.msgId !== 'string') invalid('$.assignments[*].msgId', 'invalid_value')
    if (!allowedIds.has(a.msgId)) invalid('$.assignments[*].msgId', 'unknown_message_ref')
    if (seen.has(a.msgId)) invalid('$.assignments[*].msgId', 'duplicate_assignment')
    if (a.topicRef !== null && (typeof a.topicRef !== 'string' || !refs.has(a.topicRef))) invalid('$.assignments[*].topicRef', 'unknown_topic_ref')
    if (!['about','repost','uncertain'].includes(String(a.relation))) invalid('$.assignments[*].relation', 'invalid_value')
    if (!['action','awareness','unrelated','unknown'].includes(String(a.relevance))) invalid('$.assignments[*].relevance', 'invalid_value')
    if (typeof a.confidence !== 'number' || !Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1) invalid('$.assignments[*].confidence', 'invalid_value')
    if (!Array.isArray(a.relevanceEvidenceMsgIds) || !a.relevanceEvidenceMsgIds.every((id) => typeof id === 'string' && allowedIds.has(id))) invalid('$.assignments[*].relevanceEvidenceMsgIds', 'invalid_evidence')
    if (new Set(a.relevanceEvidenceMsgIds as string[]).size !== a.relevanceEvidenceMsgIds.length) invalid('$.assignments[*].relevanceEvidenceMsgIds', 'invalid_evidence')
    if (a.relevance === 'unknown' && (a.relevanceEvidenceMsgIds as string[]).length !== 0) invalid('$.assignments[*].relevanceEvidenceMsgIds', 'invalid_evidence')
    if (a.relevance !== 'unknown' && (a.relevanceEvidenceMsgIds as string[]).length === 0) invalid('$.assignments[*].relevanceEvidenceMsgIds', 'invalid_evidence')
    seen.add(a.msgId)
    return { msgId: a.msgId, topicRef: a.topicRef as string | null, relation: a.relation as TopicRelation, confidence: a.confidence, relevance: a.relevance as Relevance, relevanceEvidenceMsgIds: [...a.relevanceEvidenceMsgIds] as string[] }
  })
  if (seen.size !== allowedIds.size) invalid('$.assignments', 'missing_assignment')
  return { topics, assignments }
}
