import { createHash } from 'node:crypto'

export type ChatKind = 'group' | 'non_group' | 'unknown'
export type ProfilePromptSource = 'chat' | 'matrix' | 'legacy' | 'default'
export type ChatProfileRuleKind = 'todo' | 'topic'
export interface ChatProfileRuleSuggestion { kind: ChatProfileRuleKind; chatKind: ChatKind; natureId: string; baseRule: string; baseProfileRevision: string; draftRule: string; changes: string[]; modelId: string | null }
export const CHAT_PROFILE_CONFIG_KEY = 'line-todo.chat-profiles.v1'
export const CHAT_PROFILE_KEY_PREFIX = 'line-todo.chat-profile.v1.'
export const CHAT_PROFILE_SAFETY_VERSION = 'credential-redaction-v1'
export const CHAT_PROFILE_CONTRACT_VERSION = 'todo-topic-contract-v1'
export const BUILTIN_CHAT_NATURES = [
  { id: 'work_project', label: '工作／專案協作', todo: '聚焦責任人、交付內容與進度；未承諾的事項不建立個人待辦。', topic: '整理議題、決議、負責人與進度，保留未決事項。' },
  { id: 'time_schedule', label: '時間／行程協調', todo: '區分提議、接受與確認；保留日期及時間的不確定性。', topic: '分開記錄提議、接受、確認與尚未確定的安排。' },
  { id: 'announcement_event', label: '公告／活動資訊', todo: '公告或活動資訊不代表使用者已參與或承諾執行。', topic: '整理公告事實與明確決定，不推定參與或同意。' },
  { id: 'social_life', label: '社交／生活互動', todo: '一般互動、分享或即時配合不硬轉成決議或個人待辦。', topic: '保留交流脈絡，不將寒暄或個人回應升格為全體決議。' },
  { id: 'mixed_unclassified', label: '混合／未分類', todo: '先分辨不同事項與責任；保留未知，不強行歸類。', topic: '先拆分議題，分別保留狀態、證據與未知資訊。' }
] as const

export interface ChatProfileNature { id: string; label: string; archived?: boolean }
export interface ChatProfileCell { todoInstruction: string; topicInstruction: string; edited?: boolean }
export interface ChatProfileConfig {
  schemaVersion: 1
  revision: string
  customNatures: ChatProfileNature[]
  matrix: Record<ChatKind, Record<string, ChatProfileCell>>
  updatedAt: string
}
export interface ChatProfileOverride {
  natureId: string
  todoOverride: string | null
  topicOverride: string | null
  revision: string
  resetLegacyTodo: boolean
}
export interface ChatProfileSnapshot {
  chatId: string; chatKind: ChatKind; natureId: string; natureLabel: string
  todo: { instruction: string; source: ProfilePromptSource }
  topic: { instruction: string; source: Exclude<ProfilePromptSource, 'legacy'> }
  myName: { value: string | null; source: 'chat' | 'global' | 'none' }
  revision: string; archivedNature: boolean; warning?: 'metadata_unknown' | 'profile_invalid' | 'archived_nature'
}

const hash = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v)
}
export const chatProfileKey = (chatId: string): string => `${CHAT_PROFILE_KEY_PREFIX}${hash(chatId)}`

export function createDefaultChatProfileConfig(): ChatProfileConfig {
  const matrix = {} as ChatProfileConfig['matrix']
  for (const kind of ['group', 'non_group', 'unknown'] as const) {
    matrix[kind] = Object.fromEntries(BUILTIN_CHAT_NATURES.map(n => [n.id, { todoInstruction: n.todo, topicInstruction: n.topic, edited: false }]))
  }
  const base = { schemaVersion: 1 as const, customNatures: [], matrix, updatedAt: new Date(0).toISOString() }
  return { ...base, revision: hash(canonical(base)) }
}

export function validateChatProfileConfig(value: unknown): ChatProfileConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Partial<ChatProfileConfig>
  if (v.schemaVersion !== 1 || !Array.isArray(v.customNatures) || !v.matrix || typeof v.matrix !== 'object') return null
  const ids = new Set<string>(BUILTIN_CHAT_NATURES.map(n => n.id))
  for (const n of v.customNatures) {
    if (!n || typeof n.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(n.id) || ids.has(n.id) || typeof n.label !== 'string' || !n.label.trim() || [...n.label.trim()].length > 40) return null
    ids.add(n.id)
  }
  for (const kind of ['group', 'non_group', 'unknown'] as const) {
    const cells = v.matrix[kind]
    if (!cells || typeof cells !== 'object') return null
    for (const id of ids) {
      const cell = cells[id]
      if (!cell || typeof cell.todoInstruction !== 'string' || typeof cell.topicInstruction !== 'string' || cell.todoInstruction.length > 12_000 || cell.topicInstruction.length > 12_000) return null
    }
  }
  const out = { schemaVersion: 1 as const, customNatures: v.customNatures, matrix: v.matrix, updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : '' }
  return { ...out, revision: hash(canonical(out)) }
}

export function resolveChatProfile(input: {
  chatId: string; chatKind: ChatKind; natureId?: string; config?: ChatProfileConfig | null; override?: ChatProfileOverride | null
  legacyChatPrompt?: string | null; legacyGlobalPrompt?: string | null; chatMyName?: string | null; globalMyName?: string | null
}): ChatProfileSnapshot {
  const config = input.config ?? createDefaultChatProfileConfig()
  const requestedNature = input.natureId ?? input.override?.natureId
  const natureId = requestedNature && (config.matrix[input.chatKind]?.[requestedNature] || config.customNatures.some(n => n.id === requestedNature)) ? requestedNature : 'mixed_unclassified'
  const nature = [...BUILTIN_CHAT_NATURES, ...config.customNatures].find(n => n.id === natureId)
  const cell = config.matrix[input.chatKind]?.[natureId] ?? config.matrix.unknown[natureId] ?? createDefaultChatProfileConfig().matrix.unknown.mixed_unclassified
  const legacyActive = (!input.natureId || input.natureId === 'mixed_unclassified' && !cell.edited) && natureId === 'mixed_unclassified'
  // A legacy per-chat prompt is an explicit chat override. Only the global legacy
  // prompt is a compatibility fallback for mixed/unconfigured profiles.
  const legacyChatTodo = !input.override?.resetLegacyTodo ? input.legacyChatPrompt : null
  const legacyTodo = legacyChatTodo ?? (legacyActive ? input.legacyGlobalPrompt : null)
  const todoInstruction = input.override?.todoOverride ?? legacyTodo ?? (cell.todoInstruction || BUILTIN_CHAT_NATURES[4].todo)
  const todoSource: ProfilePromptSource = input.override?.todoOverride != null || legacyChatTodo != null ? 'chat' : legacyTodo ? 'legacy' : cell.todoInstruction ? 'matrix' : 'default'
  const topicInstruction = input.override?.topicOverride ?? cell.topicInstruction
  const revisionData = { config: config.revision, chatId: input.chatId, chatKind: input.chatKind, natureId, todoInstruction, topicInstruction, myName: input.chatMyName ?? input.globalMyName ?? null, safety: CHAT_PROFILE_SAFETY_VERSION, contract: CHAT_PROFILE_CONTRACT_VERSION }
  return { chatId: input.chatId, chatKind: input.chatKind, natureId, natureLabel: nature?.label ?? '混合／未分類', todo: { instruction: todoInstruction, source: todoSource }, topic: { instruction: topicInstruction, source: input.override?.topicOverride != null ? 'chat' : 'matrix' }, myName: { value: input.chatMyName ?? input.globalMyName ?? null, source: input.chatMyName ? 'chat' : input.globalMyName ? 'global' : 'none' }, revision: hash(canonical(revisionData)), archivedNature: nature && 'archived' in nature ? Boolean(nature.archived) : false, ...(input.chatKind === 'unknown' ? { warning: 'metadata_unknown' as const } : {}) }
}
