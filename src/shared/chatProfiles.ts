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

// Synchronous and byte-for-byte SHA-256 for both Node and the sandboxed browser view.
// Keep profile revisions stable across the backend and renderer without importing node:crypto into UI bundles.
const SHA256_K = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
]
const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))
const hash = (value: string): string => {
  const input = new TextEncoder().encode(value)
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64
  const data = new Uint8Array(paddedLength)
  data.set(input); data[input.length] = 0x80
  new DataView(data.buffer).setBigUint64(paddedLength - 8, BigInt(input.length) * 8n, false)
  const state = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]
  const words = new Uint32Array(64)
  for (let offset = 0; offset < data.length; offset += 64) {
    const view = new DataView(data.buffer, offset, 64)
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(i * 4, false)
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15], y = words[i - 2]
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0
    }
    let [a,b,c,d,e,f,g,h] = state
    for (let i = 0; i < 64; i++) {
      const sum1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const choice = (e & f) ^ (~e & g)
      const t1 = (h + sum1 + choice + SHA256_K[i] + words[i]) >>> 0
      const sum0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (sum0 + majority) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    state[0] = (state[0] + a) >>> 0; state[1] = (state[1] + b) >>> 0
    state[2] = (state[2] + c) >>> 0; state[3] = (state[3] + d) >>> 0
    state[4] = (state[4] + e) >>> 0; state[5] = (state[5] + f) >>> 0
    state[6] = (state[6] + g) >>> 0; state[7] = (state[7] + h) >>> 0
  }
  return state.map((word) => word.toString(16).padStart(8, '0')).join('')
}
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
