import type { Database } from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { LlmProviderError, type LlmErrorCode, type LlmProvider } from '../../llm/provider/types'
import { GROUP_TOPICS_BUNDLE_ENABLED, GROUP_TOPICS_JSON_SCHEMA, GROUP_TOPICS_PROMPT, GROUP_TOPICS_PROMPT_HASH, GROUP_TOPICS_PROMPT_VERSION, GROUP_TOPICS_SCHEMA_HASH, GROUP_TOPICS_SCHEMA_VERSION } from './prompts/bundle'
import { TopicAnalysisValidationError, validateTopicAnalysis, type TopicFailurePath, type TopicValidationReason } from './domain'
import { completedInputExists, countPendingMessages, crossChatIsEnabled, GROUP_TOPICS_VALIDATOR_VERSION, isEnabled, listLinkCandidates, listTopics, loadPendingMessages, loadTopicCandidates, recordFailure, saveAnalysis, setCrossChatEnabled, setEnabled, todoRefs, type TopicFailureStage, type TopicProviderKind } from './repository'
import { getMessagesByChatAndIds } from '../../db/messages.repo'
import { advanceIdentityIndex, beginIdentitySourceAttempt, captureIdentitySnapshot, recallTopicIdentityCandidates, recordIdentitySourceAttempt, releaseIdentitySourceAttempt } from '../../db/identity.repo'
import { IDENTITY_QUERY_VERSION, type IdentityCandidate } from '../../../shared/identityDecision'

const versions = { promptVersion: GROUP_TOPICS_PROMPT_VERSION, promptHash: GROUP_TOPICS_PROMPT_HASH, schemaVersion: GROUP_TOPICS_SCHEMA_VERSION, schemaHash: GROUP_TOPICS_SCHEMA_HASH, validatorVersion: GROUP_TOPICS_VALIDATOR_VERSION }
export const GROUP_TOPICS_BATCH_SIZE = 20
export const GROUP_TOPICS_USER_CHAR_LIMIT=7500

function fitTopicRequestPayload(existingLocalTopics:Array<{ref:string;title:string;summary:string}>,candidates:IdentityCandidate[],messages:Array<{msgId:string;ts:number;direction:'in'|'out';text:string}>,candidateTruncated:boolean):{user:string;candidates:IdentityCandidate[];candidateTruncated:boolean} {
  let local=[...existingLocalTopics]
  let history=[...candidates]
  const sourceMessages=messages.map((message)=>({...message}))
  let truncated=candidateTruncated
  const render=()=>JSON.stringify({existingLocalTopics:local,historicalCandidates:history.map((candidate)=>({entityType:candidate.entityType,entityId:candidate.entityId,title:candidate.title,summary:candidate.summary,recallReasons:candidate.recallReasons})),historicalCandidatesTruncated:truncated,messages:sourceMessages})
  while(local.length>0&&render().length>GROUP_TOPICS_USER_CHAR_LIMIT)local.pop()
  while(history.length>0&&render().length>GROUP_TOPICS_USER_CHAR_LIMIT){history=history.slice(0,Math.floor(history.length/2));truncated=true}
  let cap=400
  while(render().length>GROUP_TOPICS_USER_CHAR_LIMIT&&cap>=20){
    for(const message of sourceMessages) if(message.text.length>cap) message.text=message.text.slice(0,cap)+'…'
    cap=Math.floor(cap/2)
  }
  const user=render()
  if(user.length>GROUP_TOPICS_USER_CHAR_LIMIT) throw new Error('group_topics_input_too_large')
  return {user,candidates:history,candidateTruncated:truncated}
}

export interface GroupTopicsService {
  enable(chatId: string, enabled: boolean): { ok: boolean }
  enableCrossChat(chatId: string, enabled: boolean): { ok: boolean }
  list(chatId: string): { ok: boolean; topics: ReturnType<typeof listTopics> }
  listLinkCandidates(chatId: string): ReturnType<typeof listLinkCandidates>
  crossChatEnabled(chatId: string): boolean
  pendingCount(chatId: string): number
  todoRefs(topicId: string): ReturnType<typeof todoRefs>
  analyze(chatId: string, resolveProvider: () => LlmProvider | null): Promise<{ ok: boolean; reason?: string; failure?: {stage:TopicFailureStage;path:TopicFailurePath|null;code:LlmErrorCode|'invalid_json'|'persistence_failed'|TopicValidationReason}; count?: number; analyzedCount?: number }>
}

function requestSchemaForBatch(messages:Array<{msgId:string}>,candidates:IdentityCandidate[]): unknown {
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

function safeProviderKind(value:unknown):TopicProviderKind {
  return value==='http'||value==='cli'?value:'unknown'
}

function safeProviderCode(error:unknown):LlmErrorCode {
  if (!(error instanceof LlmProviderError)) return 'unknown'
  const codes:LlmErrorCode[]=['not_installed','not_authenticated','timeout','rate_limited','quota_exceeded','bad_output','invalid_config','transport','unknown']
  return codes.includes(error.code)?error.code:'unknown'
}

export function createGroupTopicsService(db: Database): GroupTopicsService {
  const analysisLocks = new Map<string, Promise<void>>()
  return {
    enable(chatId, enabled) { return { ok: setEnabled(db, chatId, enabled) } },
    enableCrossChat(chatId, enabled) { return { ok: setCrossChatEnabled(db, chatId, enabled) } },
    crossChatEnabled(chatId) {
      const chat = db.prepare('SELECT is_group,blocked FROM chats WHERE chat_id=?').get(chatId) as {is_group:number;blocked:number}|undefined
      return !!chat && chat.is_group === 1 && chat.blocked !== 1 && isEnabled(db, chatId) && crossChatIsEnabled(db, chatId)
    },
    pendingCount(chatId) {
      const chat = db.prepare('SELECT blocked FROM chats WHERE chat_id=?').get(chatId) as {blocked:number}|undefined
      if (!chat || chat.blocked === 1 || !isEnabled(db,chatId)) return 0
      return countPendingMessages(db,chatId)
    },
    listLinkCandidates(chatId) { return listLinkCandidates(db, chatId) },
    list(chatId) {
      const chat = db.prepare('SELECT blocked FROM chats WHERE chat_id=?').get(chatId) as {blocked:number}|undefined
      if (!chat || chat.blocked === 1 || !isEnabled(db, chatId)) return { ok: false, topics: [] }
      return { ok: true, topics: listTopics(db, chatId) }
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
      const chat = db.prepare('SELECT blocked FROM chats WHERE chat_id=?').get(chatId) as {blocked:number}|undefined
      if (!chat || chat.blocked === 1) return { ok: false, reason: 'unsupported_chat' }
      if (!isEnabled(db, chatId)) return { ok: false, reason: 'disabled' }
      const messages = loadPendingMessages(db, chatId, GROUP_TOPICS_BATCH_SIZE, 100)
      if (!messages.length) return { ok: true, count: listTopics(db, chatId).length, analyzedCount: 0 }
      if(!advanceIdentityIndex(db,chatId,'topic')) return {ok:false,reason:'identity_indexing'}
      const recalled=recallTopicIdentityCandidates(db,chatId,messages.map((message)=>message.text),messages.map((message)=>message.msgId))
      if(!recalled.ready) return {ok:false,reason:'identity_indexing'}
      const sourceRows=getMessagesByChatAndIds(chatId,messages.map((message)=>message.msgId),db)
      if(sourceRows.length!==messages.length) return {ok:false,reason:'source_changed'}
      let fitted:{user:string;candidates:IdentityCandidate[];candidateTruncated:boolean}
      try { fitted=fitTopicRequestPayload(loadTopicCandidates(db,chatId),recalled.candidates,messages.map((m)=>({msgId:m.msgId,ts:m.ts,direction:m.direction,text:m.text})),recalled.truncated) }
      catch { return {ok:false,reason:'input_too_large'} }
      const candidateIds=new Set(fitted.candidates.map((candidate)=>candidate.entityId))
      const candidateRevisions=recalled.candidateRevisions.filter((candidate)=>candidateIds.has(candidate.entityId))
      const identitySnapshot=captureIdentitySnapshot(db,chatId,sourceRows,fitted.candidateTruncated,candidateRevisions)
      if(!identitySnapshot) return {ok:false,reason:'source_changed'}
      if (completedInputExists(db, chatId, messages, versions)) return { ok: true, count: listTopics(db, chatId).length, analyzedCount: 0 }
      const userPayload=fitted.user
      let provider: LlmProvider | null
      try { provider = resolveProvider() } catch {
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
          const current = db.prepare('SELECT blocked FROM chats WHERE chat_id=?').get(chatId) as {blocked:number}|undefined
          if (!current || current.blocked === 1) return { ok: false, reason: 'unsupported_chat' }
          return { ok: false, reason: 'disabled' }
        }
        if (!saved) {
          const current=db.prepare(`SELECT c.blocked,p.enabled FROM chats c LEFT JOIN group_topic_preferences p ON p.chat_id=c.chat_id WHERE c.chat_id=?`).get(chatId) as {blocked:number;enabled:number|null}|undefined
          if(!current||current.blocked===1) return {ok:false,reason:'unsupported_chat'}
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
