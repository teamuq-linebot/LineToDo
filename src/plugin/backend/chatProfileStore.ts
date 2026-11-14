import { CHAT_PROFILE_CONFIG_KEY, chatProfileKey, createDefaultChatProfileConfig, resolveChatProfile, validateChatProfileConfig } from '../../shared/chatProfiles'
import type { ChatProfileConfig, ChatProfileOverride, ChatKind } from '../../shared/chatProfiles'
import { randomUUID } from 'node:crypto'

export interface ProfileDb { prepare(sql: string): { get(...p: unknown[]): unknown; run(...p: unknown[]): unknown } }
export class ProfileStoreError extends Error {
  readonly code: 'revision_conflict'|'storage_unavailable'|'corrupt_config'|'invalid_input'
  constructor(code: 'revision_conflict'|'storage_unavailable'|'corrupt_config'|'invalid_input') { super(code); this.code = code }
}
export function createChatProfileStore(getDb: () => ProfileDb | null) {
  const db = () => { const v = getDb(); if (!v) throw new ProfileStoreError('storage_unavailable'); return v }
  const read = (key: string) => db().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as {value?:unknown}|undefined
  const write = (key:string, value:unknown) => db().prepare('INSERT INTO app_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value))
  const validNature = (id: unknown): id is string => typeof id === 'string' && Boolean(createDefaultChatProfileConfig().matrix.group[id] || createDefaultChatProfileConfig().matrix.unknown[id] || createDefaultChatProfileConfig().matrix.non_group[id] || (() => { try { return thisConfig().customNatures.some(n => n.id === id) } catch { return false } })())
  const thisConfig = () => { const row=read(CHAT_PROFILE_CONFIG_KEY); if(!row) return createDefaultChatProfileConfig(); if(typeof row.value!=='string') return createDefaultChatProfileConfig(); try { return validateChatProfileConfig(JSON.parse(row.value)) ?? createDefaultChatProfileConfig() } catch { return createDefaultChatProfileConfig() } }
  const validRow = (v: any, chatId: string): v is ChatProfileOverride & { schemaVersion: 1 } => Boolean(v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).every(k => ['schemaVersion','chatId','natureId','todoOverride','topicOverride','revision','resetLegacyTodo'].includes(k)) && v.schemaVersion===1 && v.chatId===chatId && validNature(v.natureId) && (v.todoOverride===null || typeof v.todoOverride==='string' && v.todoOverride.length<=12000) && (v.topicOverride===null || typeof v.topicOverride==='string' && v.topicOverride.length<=12000) && typeof v.revision==='string' && v.revision.length>0 && typeof v.resetLegacyTodo==='boolean')
  return {
    getConfig(): ChatProfileConfig { const row=read(CHAT_PROFILE_CONFIG_KEY); if (!row) return createDefaultChatProfileConfig(); if(typeof row.value!=='string') throw new ProfileStoreError('corrupt_config'); let v:unknown; try{v=JSON.parse(row.value)}catch{throw new ProfileStoreError('corrupt_config')} const c=validateChatProfileConfig(v); if(!c) throw new ProfileStoreError('corrupt_config'); return c },
    saveConfig(value:unknown, expected:unknown) { const current=this.getConfig(); if(expected!==current.revision) throw new ProfileStoreError('revision_conflict'); const next=validateChatProfileConfig(value); if(!next) throw new ProfileStoreError('invalid_input'); write(CHAT_PROFILE_CONFIG_KEY,next); return this.getConfig() },
    getChat(chatId:string): ChatProfileOverride|null { const row=read(chatProfileKey(chatId)); if(!row) return null; try { const v=JSON.parse(String(row.value)); return validRow(v,chatId) ? v : null } catch { return null } },
    hasInvalidChat(chatId:string): boolean { const row=read(chatProfileKey(chatId)); if(!row) return false; try { return !validRow(JSON.parse(String(row.value)),chatId) } catch { return true } },
    saveChat(chatId:string, value:unknown, expected:unknown) { const prior=this.getChat(chatId); if((prior?.revision??'new')!==expected) throw new ProfileStoreError('revision_conflict'); if(!value||typeof value!=='object'||Array.isArray(value)) throw new ProfileStoreError('invalid_input'); const v=value as any; if(Object.keys(v).some(k=>!['natureId','todoOverride','topicOverride','resetLegacyTodo'].includes(k))||!Object.hasOwn(v,'natureId')||!Object.hasOwn(v,'todoOverride')||!Object.hasOwn(v,'topicOverride')||!validNature(v.natureId)||(v.todoOverride!==null&&typeof v.todoOverride!=='string')||(v.topicOverride!==null&&typeof v.topicOverride!=='string')||v.todoOverride?.length>12000||v.topicOverride?.length>12000||(v.resetLegacyTodo!==undefined&&typeof v.resetLegacyTodo!=='boolean')) throw new ProfileStoreError('invalid_input'); const revision=randomUUID(); const out={schemaVersion:1,chatId,natureId:v.natureId,todoOverride:v.todoOverride,topicOverride:v.topicOverride,revision,resetLegacyTodo:v.resetLegacyTodo===true}; write(chatProfileKey(chatId),out); return out as ChatProfileOverride },
    resetChat(chatId:string, field:'todo'|'topic'|'all', expected:unknown) { const prior=this.getChat(chatId); if((prior?.revision??'new')!==expected) throw new ProfileStoreError('revision_conflict'); const next={natureId:prior?.natureId??'mixed_unclassified',todoOverride:field==='topic'?prior?.todoOverride??null:null,topicOverride:field==='todo'?prior?.topicOverride??null:null,resetLegacyTodo:true}; return this.saveChat(chatId,next,expected) },
    chatKind(chatId:string):ChatKind { try { const row=db().prepare('SELECT is_group FROM chats WHERE chat_id = ?').get(chatId) as {is_group?:unknown}|undefined; return row?.is_group===1?'group':row?.is_group===0?'non_group':'unknown' } catch { return 'unknown' } }
  }
}

/** Stable callable API over the profile store and existing legacy prompt/name sources. */
export function createChatProfileService(options: {
  store: ReturnType<typeof createChatProfileStore>
  legacy(chatId: string): { chatPrompt: string|null; chatName: string|null }
  global(): { prompt: string|null; myName: string|null }
}) {
  const validChatId = (id: unknown): string => {
    if (typeof id !== 'string' || !id || id.length > 512) throw new ProfileStoreError('invalid_input')
    return id
  }
  return {
    getConfig: () => options.store.getConfig(),
    saveConfig: (config: unknown, expectedRevision: unknown) => options.store.saveConfig(config, expectedRevision),
    getChat: (chatId: string) => options.store.getChat(validChatId(chatId)),
    saveChat: (chatId: string, value: unknown, expectedRevision: unknown) => options.store.saveChat(validChatId(chatId), value, expectedRevision),
    resolve(chatId: string, natureId?: string) {
      const id = validChatId(chatId)
      const legacy = options.legacy(id)
      const global = options.global()
      const snapshot = resolveChatProfile({ chatId: id, chatKind: options.store.chatKind(id), natureId, config: options.store.getConfig(), override: options.store.getChat(id), legacyChatPrompt: legacy.chatPrompt, legacyGlobalPrompt: global.prompt, chatMyName: legacy.chatName, globalMyName: global.myName })
      return options.store.hasInvalidChat(id) ? { ...snapshot, warning: 'profile_invalid' as const } : snapshot
    }
  }
}
