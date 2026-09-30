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

export function validateTopicAnalysis(value: unknown, input: TopicMessageInput[]): TopicAnalysis {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_output')
  const root = value as Record<string, unknown>
  if (Object.keys(root).sort().join(',') !== 'assignments,topics' || !Array.isArray(root.topics) || !Array.isArray(root.assignments)) throw new Error('invalid_output')
  const refs = new Set<string>()
  const topics: TopicDraft[] = root.topics.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid_output')
    const t = raw as Record<string, unknown>
    if (Object.keys(t).sort().join(',') !== 'ref,summary,title' || typeof t.ref !== 'string' || !/^[a-z0-9_-]{1,40}$/i.test(t.ref) || refs.has(t.ref) || typeof t.title !== 'string' || !t.title.trim() || t.title.length > 120 || typeof t.summary !== 'string' || !t.summary.trim() || t.summary.length > 500) throw new Error('invalid_output')
    refs.add(t.ref)
    return { ref: t.ref, title: t.title.trim(), summary: t.summary.trim() }
  })
  if (topics.length > 30 || root.assignments.length !== input.length) throw new Error('invalid_output')
  const allowedIds = new Set(input.map((m) => m.msgId))
  const seen = new Set<string>()
  const assignments: TopicAssignment[] = root.assignments.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid_output')
    const a = raw as Record<string, unknown>
    const keys = Object.keys(a).sort().join(',')
    if (keys !== 'confidence,msgId,relation,relevance,relevanceEvidenceMsgIds,topicRef' || typeof a.msgId !== 'string' || !allowedIds.has(a.msgId) || seen.has(a.msgId) || (a.topicRef !== null && (typeof a.topicRef !== 'string' || !refs.has(a.topicRef))) || !['about','repost','uncertain'].includes(String(a.relation)) || !['action','awareness','unrelated','unknown'].includes(String(a.relevance)) || typeof a.confidence !== 'number' || a.confidence < 0 || a.confidence > 1 || !Array.isArray(a.relevanceEvidenceMsgIds) || !a.relevanceEvidenceMsgIds.every((id) => typeof id === 'string' && allowedIds.has(id))) throw new Error('invalid_output')
    if (new Set(a.relevanceEvidenceMsgIds as string[]).size !== a.relevanceEvidenceMsgIds.length) throw new Error('invalid_output')
    if (a.relevance === 'unknown' && (a.relevanceEvidenceMsgIds as string[]).length !== 0) throw new Error('invalid_output')
    if (a.relevance !== 'unknown' && (a.relevanceEvidenceMsgIds as string[]).length === 0) throw new Error('invalid_output')
    seen.add(a.msgId)
    return { msgId: a.msgId, topicRef: a.topicRef as string | null, relation: a.relation as TopicRelation, confidence: a.confidence, relevance: a.relevance as Relevance, relevanceEvidenceMsgIds: [...a.relevanceEvidenceMsgIds] as string[] }
  })
  if (seen.size !== allowedIds.size) throw new Error('invalid_output')
  return { topics, assignments }
}
