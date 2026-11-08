import type { Database } from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { LlmProviderError, type LlmErrorCode, type LlmProvider } from '../../llm/provider/types'
import { GROUP_TOPICS_BUNDLE_ENABLED, GROUP_TOPICS_JSON_SCHEMA, GROUP_TOPICS_PROMPT, GROUP_TOPICS_PROMPT_HASH, GROUP_TOPICS_PROMPT_VERSION, GROUP_TOPICS_SCHEMA_HASH, GROUP_TOPICS_SCHEMA_VERSION } from './prompts/bundle'
import { TopicAnalysisValidationError, validateTopicAnalysis, type TopicFailurePath, type TopicValidationReason } from './domain'
import { completedInputExists, countBacklogMessages, countPendingMessages, GROUP_TOPICS_VALIDATOR_VERSION, isEnabled, listTopics, loadPendingMessages, loadTopicCandidates, recordFailure, saveAnalysis, setEnabled, todoRefs, type TopicFailureStage, type TopicProviderKind } from './repository'
import { getMessagesByChatAndIds } from '../../db/messages.repo'
import { listChats } from '../../db/chats.repo'
import { isTodoExtractEnabled } from '../../db/chatTodoPrefs.repo'
import { advanceIdentityIndex, beginIdentitySourceAttempt, captureIdentitySnapshot, recallTopicIdentityCandidates, recordIdentitySourceAttempt, releaseIdentitySourceAttempt } from '../../db/identity.repo'
import { IDENTITY_QUERY_VERSION, type IdentityCandidate } from '../../../shared/identityDecision'

const versions = { promptVersion: GROUP_TOPICS_PROMPT_VERSION, promptHash: GROUP_TOPICS_PROMPT_HASH, schemaVersion: GROUP_TOPICS_SCHEMA_VERSION, schemaHash: GROUP_TOPICS_SCHEMA_HASH, validatorVersion: GROUP_TOPICS_VALIDATOR_VERSION }
export const GROUP_TOPICS_BATCH_SIZE = 20
export const GROUP_TOPICS_USER_CHAR_LIMIT=7500
/** 總覽每群最多回傳的議題數（回應大小上限）；單群詳情仍走 list。 */
export const GROUP_TOPICS_OVERVIEW_TOPIC_LIMIT=30
export const GROUP_TOPICS_OVERVIEW_BYTE_LIMIT=48*1024

export function fitTopicRequestPayload(existingLocalTopics:Array<{ref:string;title:string;summary:string}>,candidates:IdentityCandidate[],messages:Array<{msgId:string;ts:number;direction:'in'|'out';text:string}>,candidateTruncated:boolean,limit:number=GROUP_TOPICS_USER_CHAR_LIMIT):{user:string;candidates:IdentityCandidate[];candidateTruncated:boolean} {
  let local=[...existingLocalTopics]
  let history=[...candidates]
  const sourceMessages=messages.map((message)=>({...message}))
  let truncated=candidateTruncated
  const render=()=>JSON.stringify({existingLocalTopics:local,historicalCandidates:history.map((candidate)=>({entityType:candidate.entityType,entityId:candidate.entityId,title:candidate.title,summary:candidate.summary,recallReasons:candidate.recallReasons})),historicalCandidatesTruncated:truncated,messages:sourceMessages})
  while(local.length>0&&render().length>limit)local.pop()
  while(history.length>0&&render().length>limit){history=history.slice(0,Math.floor(history.length/2));truncated=true}
  let cap=400
  while(render().length>limit&&cap>=20){
    for(const message of sourceMessages) if(message.text.length>cap) message.text=message.text.slice(0,cap)+'…'
    cap=Math.floor(cap/2)
  }
  const user=render()
  if(user.length>limit) throw new Error('group_topics_input_too_large')
  return {user,candidates:history,candidateTruncated:truncated}
}

type TopicRow = ReturnType<typeof listTopics>[number]

export interface GroupTopicsOverviewRow {
  chatId: string
  name: string | null
  enabled: boolean
  topics: ReturnType<typeof listTopics>
  topicCount?: number
  compacted?: boolean
  pendingCount: number
  backlogCount: number
}

export interface GroupTopicsService {
  enable(chatId: string, enabled: boolean): { ok: boolean }
  /** `combined`：合併整理正在背景運作（只在 ok 時帶）；面板據此改用「補分析舊訊息」的文案。 */
  list(chatId: string): { ok: boolean; topics: ReturnType<typeof listTopics>; combined?: boolean }
  overview(): GroupTopicsOverviewRow[]
  pendingCount(chatId: string): number
  todoRefs(topicId: string): ReturnType<typeof todoRefs>
  analyze(chatId: string, resolveProvider: () => LlmProvider | null): Promise<{ ok: boolean; reason?: string; failure?: {stage:TopicFailureStage;path:TopicFailurePath|null;code:LlmErrorCode|'invalid_json'|'persistence_failed'|TopicValidationReason}; count?: number; analyzedCount?: number }>
}

export function requestSchemaForBatch(messages:Array<{msgId:string}>,candidates:IdentityCandidate[]): unknown {
  const schema=GROUP_TOPICS_JSON_SCHEMA as unknown as {properties:Record<string,unknown>}
  const properties=schema.properties as Record<string,Record<string,unknown>>
  const assignments=properties.assignments as Record<string,unknown>
  const items=assignments.items as {properties:Record<string,unknown>}
  const itemProperties=items.properties as Record<string,Record<string,unknown>>
  const msgIds=messages.map((message)=>message.msgId)
  const identity=properties.identityDecisions as Record<string,unknown>
  const identityItems=identity.items as {properties:Record<string,Record<string,unknown>>}
  const identityProperties=identityItems.properties
  const candidateIds=candidates.map((candidate)=>candidate.entityId)
  return {...GROUP_TOPICS_JSON_SCHEMA,properties:{...properties,
    identityDecisions:{...identity,maxItems:30,items:{...identityItems,properties:{...identityProperties,candidateId:{...identityProperties.candidateId,enum:[null,...candidateIds]},evidenceMsgIds:{...identityProperties.evidenceMsgIds,maxItems:Math.min(20,msgIds.length),items:{type:'string',enum:msgIds}}}}},
    assignments:{...assignments,minItems:msgIds.length,maxItems:msgIds.length,items:{...items,properties:{...itemProperties,msgId:{...itemProperties.msgId,enum:msgIds},relevanceEvidenceMsgIds:{...itemProperties.relevanceEvidenceMsgIds,maxItems:msgIds.length,items:{type:'string',enum:msgIds}}}}}}}
}

const COMPACT_TITLE_CHARS=60
const COMPACT_SUMMARY_CHARS=120
const COMPACT_EVIDENCE_IDS=3

function clip(text:string,max:number):string {
  const chars=Array.from(text)
  return chars.length<=max?text:chars.slice(0,max).join('')+'…'
}

function compactTopic(topic:TopicRow):TopicRow {
  const ids=(list:string[])=>list.slice(0,COMPACT_EVIDENCE_IDS)
  return {...topic,title:clip(topic.title,COMPACT_TITLE_CHARS),summary:clip(topic.summary,COMPACT_SUMMARY_CHARS),evidenceMsgIds:ids(topic.evidenceMsgIds),relevanceEvidenceMsgIds:ids(topic.relevanceEvidenceMsgIds),relevanceEvidence:topic.relevanceEvidence.map((item)=>({...item,evidenceMsgIds:ids(item.evidenceMsgIds)}))}
}

const byteLength=(value:unknown):number=>Buffer.byteLength(JSON.stringify(value))

/**
 * 把 overview 裁到 limit 位元組以內（小於 dispatcher 的單次回應預算，所以不會被分段）。
 * 規則：1. 放得下就原樣回傳；2. 全部議題縮短（標題、摘要、證據 id 只留前幾筆），該群標 compacted；
 * 3. 還是太大就從所有群中最舊的議題開始整筆丟掉（依 lastSourceTs），topicCount 保留真實總數；
 * 4. 議題丟光仍超過才丟群：先未啟用的，再最後一個。
 */
export function fitOverviewToBudget(rows:GroupTopicsOverviewRow[],limit:number):GroupTopicsOverviewRow[] {
  if (byteLength(rows)<=limit) return rows
  let fitted=rows.map((row)=>{
    const topics=row.topics.map(compactTopic)
    const changed=topics.some((topic,i)=>byteLength(topic)<byteLength(row.topics[i]))
    return changed?{...row,topics,compacted:true}:row
  })
  let size=byteLength(fitted)
  while (size>limit) {
    let victim=-1
    for (let i=0;i<fitted.length;i+=1) {
      const topics=fitted[i].topics
      if (!topics.length) continue
      if (victim<0 || topics[topics.length-1].lastSourceTs<fitted[victim].topics[fitted[victim].topics.length-1].lastSourceTs) victim=i
    }
    if (victim<0) break
    const topics=fitted[victim].topics
    size-=byteLength(topics[topics.length-1])+1
    fitted=fitted.map((row,i)=>i===victim?{...row,topics:topics.slice(0,-1)}:row)
  }
  while (size>limit && fitted.length>0) {
    let drop=fitted.findIndex((row)=>!row.enabled)
    if (drop<0) drop=fitted.length-1
    size-=byteLength(fitted[drop])+1
    fitted=fitted.filter((_,i)=>i!==drop)
  }
  return fitted
}

function safeProviderKind(value:unknown):TopicProviderKind {
  return value==='http'||value==='cli'?value:'unknown'
}

function safeProviderCode(error:unknown):LlmErrorCode {
  if (!(error instanceof LlmProviderError)) return 'unknown'
  const codes:LlmErrorCode[]=['not_installed','not_authenticated','timeout','rate_limited','quota_exceeded','bad_output','invalid_config','transport','unknown']
  return codes.includes(error.code)?error.code:'unknown'
}

export interface GroupTopicsServiceOptions {
  /** 合併整理（待辦＋議題一次 AI 呼叫）正在背景運作：analyze 與 pendingCount／backlogCount 只算集合 B（processed=1 且尚無議題決策）。 */
  isCombinedActive?: () => boolean
}

export function createGroupTopicsService(db: Database, options: GroupTopicsServiceOptions = {}): GroupTopicsService {
  const combinedActive = (chatId: string): boolean => options.isCombinedActive?.() === true && isTodoExtractEnabled(db, chatId)
  const analysisLocks = new Map<string, Promise<void>>()
  return {
    enable(chatId, enabled) { return { ok: setEnabled(db, chatId, enabled) } },
    pendingCount(chatId) {
      const chat = db.prepare('SELECT 1 AS x FROM chats WHERE chat_id=?').get(chatId)
      if (!chat || !isEnabled(db,chatId)) return 0
      return combinedActive(chatId) ? countPendingMessages(db,chatId,100,{processedFilter:'processed'}) : countPendingMessages(db,chatId)
    },
    list(chatId) {
      const chat = db.prepare('SELECT 1 AS x FROM chats WHERE chat_id=?').get(chatId)
      if (!chat || !isEnabled(db, chatId)) return { ok: false, topics: [] }
      return { ok: true, topics: listTopics(db, chatId), ...(combinedActive(chatId) ? { combined: true } : {}) }
    },
    overview() {
      const rows = listChats(db).filter((chat) => chat.isGroup).map((chat): GroupTopicsOverviewRow => {
        const enabled = isEnabled(db, chat.chatId)
        const pendingCount = enabled ? countPendingMessages(db, chat.chatId) : 0
        const backlogCount = enabled ? (combinedActive(chat.chatId) ? countBacklogMessages(db, chat.chatId) : pendingCount) : 0
        const all = enabled ? listTopics(db, chat.chatId) : []
        return { chatId: chat.chatId, name: chat.name, enabled, topics: all.slice(0, GROUP_TOPICS_OVERVIEW_TOPIC_LIMIT), topicCount: all.length, pendingCount, backlogCount }
      })
      return fitOverviewToBudget(rows, GROUP_TOPICS_OVERVIEW_BYTE_LIMIT)
    },
    todoRefs(topicId) { return todoRefs(db, topicId) },
    async analyze(chatId, resolveProvider) {
      const previous = analysisLocks.get(chatId) ?? Promise.resolve()
      let release!: () => void
      const current = new Promise<void>((resolve) => { release = resolve })
      analysisLocks.set(chatId,current)
      await previous
      try {
      if (!GROUP_TOPICS_BUNDLE_ENABLED) return { ok: false, reason: 'unavailable' }
      const chat = db.prepare('SELECT 1 AS x FROM chats WHERE chat_id=?').get(chatId)
      if (!chat) return { ok: false, reason: 'unsupported_chat' }
      if (!isEnabled(db, chatId)) return { ok: false, reason: 'disabled' }
      const messages = combinedActive(chatId)
        ? loadPendingMessages(db, chatId, GROUP_TOPICS_BATCH_SIZE, 100, { processedFilter: 'processed' })
        : loadPendingMessages(db, chatId, GROUP_TOPICS_BATCH_SIZE, 100)
      if (!messages.length) return { ok: true, count: listTopics(db, chatId).length, analyzedCount: 0 }
      if(!advanceIdentityIndex(db,chatId,'topic')) return {ok:false,reason:'identity_indexing'}
      const recalled=recallTopicIdentityCandidates(db,chatId,messages.map((message)=>message.text),messages.map((message)=>message.msgId))
      if(!recalled.ready) return {ok:false,reason:'identity_indexing'}
      const sourceRows=getMessagesByChatAndIds(chatId,messages.map((message)=>message.msgId),db)
      if(sourceRows.length!==messages.length) return {ok:false,reason:'source_changed'}
      let provider: LlmProvider | null = null
      let providerResolveFailed = false
      try { provider = resolveProvider() } catch { providerResolveFailed = true }
      let payloadLimit=GROUP_TOPICS_USER_CHAR_LIMIT
      try {
        const room=provider?.userPayloadLimit?.({jsonSchema:{name:'group_topics',schema:requestSchemaForBatch(messages,recalled.candidates)},conversation:{chatId,kind:'groupTopics'}})
        if(typeof room==='number'&&Number.isFinite(room)) payloadLimit=Math.max(0,Math.min(GROUP_TOPICS_USER_CHAR_LIMIT,Math.floor(room)))
      } catch { /* no usable room report: keep the default cap */ }
      let fitted:{user:string;candidates:IdentityCandidate[];candidateTruncated:boolean}
      try { fitted=fitTopicRequestPayload(loadTopicCandidates(db,chatId),recalled.candidates,messages.map((m)=>({msgId:m.msgId,ts:m.ts,direction:m.direction,text:m.text})),recalled.truncated,payloadLimit) }
      catch { return {ok:false,reason:'input_too_large'} }
      const candidateIds=new Set(fitted.candidates.map((candidate)=>candidate.entityId))
      const candidateRevisions=recalled.candidateRevisions.filter((candidate)=>candidateIds.has(candidate.entityId))
      const identitySnapshot=captureIdentitySnapshot(db,chatId,sourceRows,fitted.candidateTruncated,candidateRevisions)
      if(!identitySnapshot) return {ok:false,reason:'source_changed'}
      if (completedInputExists(db, chatId, messages, versions)) return { ok: true, count: listTopics(db, chatId).length, analyzedCount: 0 }
      const userPayload=fitted.user
      if (providerResolveFailed) {
        const failure={stage:'provider_resolve' as const,path:null,code:'invalid_config' as const,reason:'provider_unavailable',providerKind:'unknown' as const}
        try { recordFailure(db,chatId,messages,versions,failure) } catch { /* retryable; no source rows change */ }
        return { ok: false, reason: 'provider_unavailable', failure:{stage:failure.stage,path:failure.path,code:failure.code} }
      }
      if (!provider) {
        const failure={stage:'provider_resolve' as const,path:null,code:'invalid_config' as const,reason:'provider_unavailable',providerKind:'unknown' as const}
        try { recordFailure(db,chatId,messages,versions,failure) } catch { /* retryable; no source rows change */ }
        return { ok: false, reason: 'provider_unavailable', failure:{stage:failure.stage,path:failure.path,code:failure.code} }
      }
      const providerKind=safeProviderKind(provider.kind)
      let effectiveProviderFingerprint:string|null=null
      try { effectiveProviderFingerprint=await provider.runtimeFingerprint?.()??null } catch { return {ok:false,reason:'provider_unavailable'} }
      const lease=beginIdentitySourceAttempt(db,chatId,identitySnapshot,userPayload,createHash('sha256').update(JSON.stringify({provider:provider.id,kind:provider.kind,effectiveProviderFingerprint,prompt:GROUP_TOPICS_PROMPT_HASH,schema:GROUP_TOPICS_SCHEMA_HASH,query:IDENTITY_QUERY_VERSION})).digest('hex'),new Date(),'topic')
      if(!lease.lease) return {ok:false,reason:'identity_'+(lease.reason??'lease_unavailable')}
      let response
      try {
        response = await provider.complete({
          system: GROUP_TOPICS_PROMPT,
          user: userPayload,
          temperature: 0,
          jsonSchema: { name: 'group_topics', schema: requestSchemaForBatch(messages,fitted.candidates) },
          conversation: { chatId, kind: 'groupTopics' },
          onAdditionalUserPayload: (serializedUserPayload) => recordIdentitySourceAttempt(db,lease.lease!,serializedUserPayload,new Date(),false).ok
        })
      } catch (error) {
        releaseIdentitySourceAttempt(db,lease.lease,true)
        const code=safeProviderCode(error)
        const failure={stage:'provider_complete' as const,path:null,code,reason:code,providerKind}
        try { recordFailure(db,chatId,messages,versions,failure) } catch { /* retryable; no source rows change */ }
        return { ok:false,reason:'analysis_failed',failure:{stage:failure.stage,path:null,code} }
      }
      let raw:unknown
      try { raw=response.structured ?? JSON.parse(response.text) as unknown } catch {
        releaseIdentitySourceAttempt(db,lease.lease,true)
        const failure={stage:'response_decode' as const,path:null,code:'invalid_json' as const,reason:'invalid_json',providerKind}
        try { recordFailure(db,chatId,messages,versions,failure) } catch { /* retryable; no source rows change */ }
        return {ok:false,reason:'analysis_failed',failure:{stage:failure.stage,path:null,code:failure.code}}
      }
      let result
      try { result = validateTopicAnalysis(raw, messages,{candidates:fitted.candidates,candidatesTruncated:fitted.candidateTruncated}) } catch (error) {
        releaseIdentitySourceAttempt(db,lease.lease,true)
        const validation=error instanceof TopicAnalysisValidationError?error:null
        const path=validation?.path ?? '$'
        const code:TopicValidationReason=validation?.reason ?? 'invalid_shape'
        const failure={stage:'domain_validate' as const,path,code:'invalid_output' as const,reason:code,providerKind}
        try { recordFailure(db,chatId,messages,versions,failure) } catch { /* retryable; no source rows change */ }
        return {ok:false,reason:'analysis_failed',failure:{stage:failure.stage,path,code}}
      }
      let saved:boolean|'inactive'
      try {
        saved = saveAnalysis(db, chatId, messages, result, versions,{snapshot:identitySnapshot,sourceLease:lease.lease,candidates:fitted.candidates,candidatesTruncated:fitted.candidateTruncated})
      } catch {
        releaseIdentitySourceAttempt(db,lease.lease,true)
        const failure={stage:'persist' as const,path:null,code:'persistence_failed' as const,reason:'persistence_failed',providerKind}
        try { recordFailure(db,chatId,messages,versions,failure) } catch { /* failed transaction keeps input retryable */ }
        return {ok:false,reason:'analysis_failed',failure:{stage:failure.stage,path:null,code:failure.code}}
      }
        if (saved === 'inactive') {
          const current = db.prepare('SELECT 1 AS x FROM chats WHERE chat_id=?').get(chatId)
          if (!current) return { ok: false, reason: 'unsupported_chat' }
          return { ok: false, reason: 'disabled' }
        }
        if (!saved) {
          const current=db.prepare(`SELECT p.enabled FROM chats c LEFT JOIN group_topic_preferences p ON p.chat_id=c.chat_id WHERE c.chat_id=?`).get(chatId) as {enabled:number|null}|undefined
          if(!current) return {ok:false,reason:'unsupported_chat'}
          if(current.enabled!==1) return {ok:false,reason:'disabled'}
          return { ok: true, count: listTopics(db, chatId).length, analyzedCount: 0 }
        }
        return { ok: true, count: listTopics(db, chatId).length, analyzedCount: messages.length }
      } finally {
        release()
        if (analysisLocks.get(chatId) === current) analysisLocks.delete(chatId)
      }
    }
  }
}
