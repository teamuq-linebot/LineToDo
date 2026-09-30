import type { Database } from 'better-sqlite3'
import { LlmProviderError, type LlmErrorCode, type LlmProvider } from '../../llm/provider/types'
import { GROUP_TOPICS_BUNDLE_ENABLED, GROUP_TOPICS_JSON_SCHEMA, GROUP_TOPICS_PROMPT, GROUP_TOPICS_PROMPT_HASH, GROUP_TOPICS_PROMPT_VERSION, GROUP_TOPICS_SCHEMA_HASH, GROUP_TOPICS_SCHEMA_VERSION } from './prompts/bundle'
import { TopicAnalysisValidationError, validateTopicAnalysis, type TopicFailurePath, type TopicValidationReason } from './domain'
import { completedInputExists, countPendingMessages, crossChatIsEnabled, GROUP_TOPICS_VALIDATOR_VERSION, isEnabled, listLinkCandidates, listTopics, loadPendingMessages, loadTopicCandidates, recordFailure, saveAnalysis, setCrossChatEnabled, setEnabled, todoRefs, type TopicFailureStage, type TopicProviderKind } from './repository'

const versions = { promptVersion: GROUP_TOPICS_PROMPT_VERSION, promptHash: GROUP_TOPICS_PROMPT_HASH, schemaVersion: GROUP_TOPICS_SCHEMA_VERSION, schemaHash: GROUP_TOPICS_SCHEMA_HASH, validatorVersion: GROUP_TOPICS_VALIDATOR_VERSION }
export const GROUP_TOPICS_BATCH_SIZE = 20

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

function requestSchemaForBatch(messages:Array<{msgId:string}>): unknown {
  const schema=GROUP_TOPICS_JSON_SCHEMA as unknown as {properties:Record<string,unknown>}
  const properties=schema.properties as Record<string,Record<string,unknown>>
  const assignments=properties.assignments as Record<string,unknown>
  const items=assignments.items as {properties:Record<string,unknown>}
  const itemProperties=items.properties as Record<string,Record<string,unknown>>
  const msgIds=messages.map((message)=>message.msgId)
  return {...GROUP_TOPICS_JSON_SCHEMA,properties:{...properties,assignments:{...assignments,minItems:msgIds.length,maxItems:msgIds.length,items:{...items,properties:{...itemProperties,msgId:{...itemProperties.msgId,enum:msgIds},relevanceEvidenceMsgIds:{...itemProperties.relevanceEvidenceMsgIds,maxItems:msgIds.length,items:{type:'string',enum:msgIds}}}}}}}
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
    crossChatEnabled(chatId) { return isEnabled(db, chatId) && crossChatIsEnabled(db, chatId) },
    pendingCount(chatId) {
      const chat = db.prepare('SELECT is_group,blocked FROM chats WHERE chat_id=?').get(chatId) as {is_group:number;blocked:number}|undefined
      if (!chat || chat.is_group !== 1 || chat.blocked === 1 || !isEnabled(db,chatId)) return 0
      return countPendingMessages(db,chatId)
    },
    listLinkCandidates(chatId) { return listLinkCandidates(db, chatId) },
    list(chatId) {
      const chat = db.prepare('SELECT is_group,blocked FROM chats WHERE chat_id=?').get(chatId) as {is_group:number;blocked:number}|undefined
      if (!chat || chat.is_group !== 1 || chat.blocked === 1 || !isEnabled(db, chatId)) return { ok: false, topics: [] }
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
      const chat = db.prepare('SELECT is_group,blocked FROM chats WHERE chat_id=?').get(chatId) as {is_group:number;blocked:number}|undefined
      if (!chat || chat.is_group !== 1 || chat.blocked === 1) return { ok: false, reason: 'unsupported_chat' }
      if (!isEnabled(db, chatId)) return { ok: false, reason: 'disabled' }
      const messages = loadPendingMessages(db, chatId, GROUP_TOPICS_BATCH_SIZE, 100)
      if (!messages.length) return { ok: true, count: listTopics(db, chatId).length, analyzedCount: 0 }
      if (completedInputExists(db, chatId, messages, versions)) return { ok: true, count: listTopics(db, chatId).length, analyzedCount: 0 }
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
      let response
      try {
        response = await provider.complete({
          system: GROUP_TOPICS_PROMPT,
          user: JSON.stringify({ existingLocalTopics: loadTopicCandidates(db, chatId), messages: messages.map((m) => ({ msgId: m.msgId, ts: m.ts, direction: m.direction, text: m.text })) }),
          temperature: 0,
          jsonSchema: { name: 'group_topics', schema: requestSchemaForBatch(messages) }
        })
      } catch (error) {
        const code=safeProviderCode(error)
        const failure={stage:'provider_complete' as const,path:null,code,reason:code,providerKind}
        try { recordFailure(db,chatId,messages,versions,failure) } catch { /* retryable; no source rows change */ }
        return { ok:false,reason:'analysis_failed',failure:{stage:failure.stage,path:null,code} }
      }
      let raw:unknown
      try { raw=response.structured ?? JSON.parse(response.text) as unknown } catch {
        const failure={stage:'response_decode' as const,path:null,code:'invalid_json' as const,reason:'invalid_json',providerKind}
        try { recordFailure(db,chatId,messages,versions,failure) } catch { /* retryable; no source rows change */ }
        return {ok:false,reason:'analysis_failed',failure:{stage:failure.stage,path:null,code:failure.code}}
      }
      let result
      try { result = validateTopicAnalysis(raw, messages) } catch (error) {
        const validation=error instanceof TopicAnalysisValidationError?error:null
        const path=validation?.path ?? '$'
        const code:TopicValidationReason=validation?.reason ?? 'invalid_shape'
        const failure={stage:'domain_validate' as const,path,code:'invalid_output' as const,reason:code,providerKind}
        try { recordFailure(db,chatId,messages,versions,failure) } catch { /* retryable; no source rows change */ }
        return {ok:false,reason:'analysis_failed',failure:{stage:failure.stage,path,code}}
      }
      let saved:boolean|'inactive'
      try {
        saved = saveAnalysis(db, chatId, messages, result, versions)
      } catch {
        const failure={stage:'persist' as const,path:null,code:'persistence_failed' as const,reason:'persistence_failed',providerKind}
        try { recordFailure(db,chatId,messages,versions,failure) } catch { /* failed transaction keeps input retryable */ }
        return {ok:false,reason:'analysis_failed',failure:{stage:failure.stage,path:null,code:failure.code}}
      }
        if (saved === 'inactive') {
          const current = db.prepare('SELECT is_group,blocked FROM chats WHERE chat_id=?').get(chatId) as {is_group:number;blocked:number}|undefined
          if (!current || current.is_group !== 1 || current.blocked === 1) return { ok: false, reason: 'unsupported_chat' }
          return { ok: false, reason: 'disabled' }
        }
        if (!saved) return { ok: true, count: listTopics(db, chatId).length, analyzedCount: 0 }
        return { ok: true, count: listTopics(db, chatId).length, analyzedCount: messages.length }
      } finally {
        release()
        if (analysisLocks.get(chatId) === current) analysisLocks.delete(chatId)
      }
    }
  }
}
