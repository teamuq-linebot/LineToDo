import type { Database } from 'better-sqlite3'
import type { LlmProvider } from '../../llm/provider'
import { GROUP_TOPICS_BUNDLE_ENABLED, GROUP_TOPICS_JSON_SCHEMA, GROUP_TOPICS_PROMPT, GROUP_TOPICS_PROMPT_HASH, GROUP_TOPICS_PROMPT_VERSION, GROUP_TOPICS_SCHEMA_HASH, GROUP_TOPICS_SCHEMA_VERSION } from './prompts/bundle'
import { validateTopicAnalysis } from './domain'
import { completedInputExists, crossChatIsEnabled, GROUP_TOPICS_VALIDATOR_VERSION, isEnabled, listLinkCandidates, listTopics, loadMessages, loadTopicCandidates, recordFailure, saveAnalysis, setCrossChatEnabled, setEnabled, todoRefs } from './repository'

const versions = { promptVersion: GROUP_TOPICS_PROMPT_VERSION, promptHash: GROUP_TOPICS_PROMPT_HASH, schemaVersion: GROUP_TOPICS_SCHEMA_VERSION, schemaHash: GROUP_TOPICS_SCHEMA_HASH, validatorVersion: GROUP_TOPICS_VALIDATOR_VERSION }

export interface GroupTopicsService {
  enable(chatId: string, enabled: boolean): { ok: boolean }
  enableCrossChat(chatId: string, enabled: boolean): { ok: boolean }
  list(chatId: string): { ok: boolean; topics: ReturnType<typeof listTopics> }
  listLinkCandidates(chatId: string): ReturnType<typeof listLinkCandidates>
  crossChatEnabled(chatId: string): boolean
  todoRefs(topicId: string): ReturnType<typeof todoRefs>
  analyze(chatId: string, resolveProvider: () => LlmProvider | null): Promise<{ ok: boolean; reason?: string; count?: number }>
}

export function createGroupTopicsService(db: Database): GroupTopicsService {
  return {
    enable(chatId, enabled) { return { ok: setEnabled(db, chatId, enabled) } },
    enableCrossChat(chatId, enabled) { return { ok: setCrossChatEnabled(db, chatId, enabled) } },
    crossChatEnabled(chatId) { return isEnabled(db, chatId) && crossChatIsEnabled(db, chatId) },
    listLinkCandidates(chatId) { return listLinkCandidates(db, chatId) },
    list(chatId) {
      const chat = db.prepare('SELECT is_group,blocked FROM chats WHERE chat_id=?').get(chatId) as {is_group:number;blocked:number}|undefined
      if (!chat || chat.is_group !== 1 || chat.blocked === 1 || !isEnabled(db, chatId)) return { ok: false, topics: [] }
      return { ok: true, topics: listTopics(db, chatId) }
    },
    todoRefs(topicId) { return todoRefs(db, topicId) },
    async analyze(chatId, resolveProvider) {
      if (!GROUP_TOPICS_BUNDLE_ENABLED) return { ok: false, reason: 'unavailable' }
      const chat = db.prepare('SELECT is_group,blocked FROM chats WHERE chat_id=?').get(chatId) as {is_group:number;blocked:number}|undefined
      if (!chat || chat.is_group !== 1 || chat.blocked === 1) return { ok: false, reason: 'unsupported_chat' }
      if (!isEnabled(db, chatId)) return { ok: false, reason: 'disabled' }
      const messages = loadMessages(db, chatId)
      if (!messages.length) return { ok: false, reason: 'no_messages' }
      if (completedInputExists(db, chatId, messages, versions)) return { ok: true, count: listTopics(db, chatId).length }
      let provider: LlmProvider | null
      try { provider = resolveProvider() } catch { return { ok: false, reason: 'provider_unavailable' } }
      if (!provider) return { ok: false, reason: 'provider_unavailable' }
      try {
        const response = await provider.complete({
          system: GROUP_TOPICS_PROMPT,
          user: JSON.stringify({ existingLocalTopics: loadTopicCandidates(db, chatId), messages: messages.map((m) => ({ msgId: m.msgId, ts: m.ts, direction: m.direction, text: m.text })) }),
          temperature: 0,
          jsonSchema: { name: 'group_topics', schema: GROUP_TOPICS_JSON_SCHEMA }
        })
        const raw = response.structured ?? JSON.parse(response.text) as unknown
        const result = validateTopicAnalysis(raw, messages)
        if (!saveAnalysis(db, chatId, messages, result, versions)) return { ok: true, count: 0 }
        return { ok: true, count: listTopics(db, chatId).length }
      } catch (error) {
        const code = error instanceof Error && /^[a-z_]{1,40}$/.test(error.message) ? error.message : 'analysis_failed'
        try { recordFailure(db, chatId, messages, versions, code) } catch { /* feature remains retryable; do not affect todo */ }
        return { ok: false, reason: 'analysis_failed' }
      }
    }
  }
}
