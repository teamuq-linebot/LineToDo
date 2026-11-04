import { createHash } from 'node:crypto'
import { CHAT_TASK_KINDS } from './chatSessionProtocol'

/**
 * v2 對照表：每個 scope（一個 LINE 聊天室，或全域 prompt 修正）一列，value 是它專屬的 opaque Host Session id。
 * v1 列（`line-todo.ai-chat-session.v1.`，每次換 fingerprint 就換新）一律不讀、不寫、不刪；它們指的舊 Session 留在 Core 不動。
 */
export const AI_SESSION_MAP_KEY_PREFIX = 'line-todo.ai-chat-session.v2.'
/** v1 前綴只用來讓測試證明它從未被碰；production 程式不使用。 */
export const AI_SESSION_MAP_V1_KEY_PREFIX = 'line-todo.ai-chat-session.v1.'
/** 「上次行程沒關乾淨的 Session」：開 Session 時寫、close 成功後清。 */
export const AI_SESSION_ACTIVE_KEY = `${AI_SESSION_MAP_KEY_PREFIX}active`
export const GLOBAL_SCOPE_KEY = 'global:main'

export const chatScopeKey = (chatId: string): string => `chat:${chatId}`

export interface AiSessionMapEffective {
  readonly providerId: string
  readonly modelId: string
  readonly effort: string | null
}

export interface AiSessionDocState {
  /** 這個 Session 已收過的規則文件版本（sha256 前 16 hex）。 */
  readonly rev: string
  readonly at: number
}

export interface AiSessionMapRecord {
  readonly scopeKey: string
  readonly hostSessionId: string
  readonly effective: AiSessionMapEffective
  readonly contractRevision: string
  /** 每種任務已送進這個 Session 的規則文件。 */
  readonly docs: Readonly<Record<string, AiSessionDocState>>
  /** 這個 Session 上次收到的 SourceCache epoch（只有抽取會用）。 */
  readonly epoch: number
  readonly createdAt: number
}

export interface AiSessionActiveRecord {
  readonly scopeKey: string
  readonly hostSessionId: string
}

export interface AiSessionMapStore {
  get(scopeKey: string): Promise<AiSessionMapRecord | null>
  put(record: AiSessionMapRecord): Promise<void>
  remove(scopeKey: string): Promise<void>
  getActive?(): Promise<AiSessionActiveRecord | null>
  putActive?(record: AiSessionActiveRecord): Promise<void>
  clearActive?(): Promise<void>
}

export interface AiSessionMapStatement {
  get(...params: unknown[]): unknown
  run(...params: unknown[]): unknown
}

export interface AiSessionMapDatabase {
  prepare(sql: string): AiSessionMapStatement
}

export class AiSessionMapStoreError extends Error {
  readonly code: 'unavailable' | 'corrupt'

  constructor(code: 'unavailable' | 'corrupt') {
    super(`ai_session_map_${code}`)
    this.name = 'AiSessionMapStoreError'
    this.code = code
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
const canonicalSessionId = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(value)) return false
  try { return BigInt(value) <= 9_223_372_036_854_775_807n } catch { return false }
}
const validScopeKey = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 520

function mapKey(scopeKey: string): string {
  if (!validScopeKey(scopeKey)) throw new AiSessionMapStoreError('corrupt')
  return `${AI_SESSION_MAP_KEY_PREFIX}${createHash('sha256').update(scopeKey, 'utf8').digest('hex')}`
}

function parseEffective(value: unknown): AiSessionMapEffective | null {
  if (!isRecord(value) || !exactKeys(value, ['providerId', 'modelId', 'effort'])) return null
  if (typeof value.providerId !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/u.test(value.providerId)) return null
  if (typeof value.modelId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/u.test(value.modelId)) return null
  if (value.effort !== null && (typeof value.effort !== 'string' || !['minimal', 'low', 'medium', 'high', 'xhigh'].includes(value.effort))) return null
  return { providerId: value.providerId, modelId: value.modelId, effort: value.effort as string | null }
}

function parseDocs(value: unknown): Record<string, AiSessionDocState> | null {
  if (!isRecord(value)) return null
  const docs: Record<string, AiSessionDocState> = {}
  for (const [kind, entry] of Object.entries(value)) {
    if (!(CHAT_TASK_KINDS as readonly string[]).includes(kind)) return null
    if (!isRecord(entry) || !exactKeys(entry, ['rev', 'at'])) return null
    if (typeof entry.rev !== 'string' || !/^[0-9a-f]{16}$/u.test(entry.rev) || typeof entry.at !== 'number' || !Number.isFinite(entry.at)) return null
    docs[kind] = { rev: entry.rev, at: entry.at }
  }
  return docs
}

function parseRecord(value: unknown, expectedScopeKey: string): AiSessionMapRecord {
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'scopeKey', 'hostSessionId', 'effective', 'contractRevision', 'docs', 'epoch', 'createdAt'])) throw new AiSessionMapStoreError('corrupt')
  const effective = parseEffective(value.effective)
  const docs = parseDocs(value.docs)
  if (value.schemaVersion !== 2 || value.scopeKey !== expectedScopeKey || !canonicalSessionId(value.hostSessionId) || effective === null || docs === null) throw new AiSessionMapStoreError('corrupt')
  if (typeof value.contractRevision !== 'string' || value.contractRevision.length === 0 || value.contractRevision.length > 64) throw new AiSessionMapStoreError('corrupt')
  if (typeof value.epoch !== 'number' || !Number.isSafeInteger(value.epoch) || value.epoch < 0) throw new AiSessionMapStoreError('corrupt')
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) throw new AiSessionMapStoreError('corrupt')
  return { scopeKey: expectedScopeKey, hostSessionId: value.hostSessionId, effective, contractRevision: value.contractRevision, docs, epoch: value.epoch, createdAt: value.createdAt }
}

function parseInput(record: AiSessionMapRecord): AiSessionMapRecord {
  if (!isRecord(record)) throw new AiSessionMapStoreError('corrupt')
  return parseRecord({ schemaVersion: 2, ...record }, record.scopeKey)
}

function parseActive(value: unknown): AiSessionActiveRecord {
  if (!isRecord(value) || !exactKeys(value, ['scopeKey', 'hostSessionId']) || !validScopeKey(value.scopeKey) || !canonicalSessionId(value.hostSessionId)) throw new AiSessionMapStoreError('corrupt')
  return { scopeKey: value.scopeKey, hostSessionId: value.hostSessionId }
}

export function createAiSessionMapStore(options: { readonly getDatabase: () => AiSessionMapDatabase | null }): AiSessionMapStore {
  const database = (): AiSessionMapDatabase => {
    try {
      const db = options.getDatabase()
      if (db !== null) return db
    } catch { /* an unopened/closing app database is unavailable */ }
    throw new AiSessionMapStoreError('unavailable')
  }
  const readRaw = (key: string): unknown => {
    const row = database().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value?: unknown } | undefined
    if (row === undefined) return undefined
    if (typeof row.value !== 'string') throw new AiSessionMapStoreError('corrupt')
    try { return JSON.parse(row.value) } catch { throw new AiSessionMapStoreError('corrupt') }
  }
  const upsert = (key: string, value: string): void => {
    database().prepare('INSERT INTO app_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }
  const wrap = <T>(work: () => T): T => {
    try { return work() } catch (error) {
      if (error instanceof AiSessionMapStoreError) throw error
      throw new AiSessionMapStoreError('unavailable')
    }
  }

  return {
    async get(scopeKey) {
      const key = mapKey(scopeKey)
      return wrap(() => {
        const value = readRaw(key)
        return value === undefined ? null : parseRecord(value, scopeKey)
      })
    },
    async put(input) {
      const record = parseInput(input)
      const key = mapKey(record.scopeKey)
      const value = JSON.stringify({ schemaVersion: 2, ...record })
      wrap(() => upsert(key, value))
    },
    async remove(scopeKey) {
      const key = mapKey(scopeKey)
      wrap(() => { database().prepare('DELETE FROM app_settings WHERE key = ?').run(key) })
    },
    async getActive() {
      return wrap(() => {
        const value = readRaw(AI_SESSION_ACTIVE_KEY)
        return value === undefined ? null : parseActive(value)
      })
    },
    async putActive(record) {
      const parsed = parseActive(record)
      wrap(() => upsert(AI_SESSION_ACTIVE_KEY, JSON.stringify(parsed)))
    },
    async clearActive() {
      wrap(() => { database().prepare('DELETE FROM app_settings WHERE key = ?').run(AI_SESSION_ACTIVE_KEY) })
    }
  }
}
