import { createHash } from 'node:crypto'

export const AI_SESSION_MAP_KEY_PREFIX = 'line-todo.ai-chat-session.v1.'

export interface AiSessionMapEffective {
  readonly providerId: string
  readonly modelId: string
  readonly effort: string | null
}

export interface AiSessionMapRecord {
  readonly chatId: string
  readonly hostSessionId: string
  readonly effective: AiSessionMapEffective
  readonly continuityFingerprint: string
}

export interface AiSessionMapStore {
  get(chatId: string): Promise<AiSessionMapRecord | null>
  put(record: AiSessionMapRecord): Promise<void>
  remove(chatId: string): Promise<void>
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

function mapKey(chatId: string): string {
  if (typeof chatId !== 'string' || chatId.length === 0 || chatId.length > 512) throw new AiSessionMapStoreError('corrupt')
  return `${AI_SESSION_MAP_KEY_PREFIX}${createHash('sha256').update(chatId, 'utf8').digest('hex')}`
}

function parseEffective(value: unknown): AiSessionMapEffective | null {
  if (!isRecord(value) || !exactKeys(value, ['providerId', 'modelId', 'effort'])) return null
  if (typeof value.providerId !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/u.test(value.providerId)) return null
  if (typeof value.modelId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/u.test(value.modelId)) return null
  if (value.effort !== null && (typeof value.effort !== 'string' || !['minimal', 'low', 'medium', 'high', 'xhigh'].includes(value.effort))) return null
  return { providerId: value.providerId, modelId: value.modelId, effort: value.effort as string | null }
}

function parseRecord(value: unknown, expectedChatId: string): AiSessionMapRecord {
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'chatId', 'hostSessionId', 'effective', 'continuityFingerprint'])) throw new AiSessionMapStoreError('corrupt')
  const effective = parseEffective(value.effective)
  if (value.schemaVersion !== 1 || value.chatId !== expectedChatId || !canonicalSessionId(value.hostSessionId) || effective === null || typeof value.continuityFingerprint !== 'string' || !/^[0-9a-f]{64}$/u.test(value.continuityFingerprint)) throw new AiSessionMapStoreError('corrupt')
  return { chatId: expectedChatId, hostSessionId: value.hostSessionId, effective, continuityFingerprint: value.continuityFingerprint }
}

function parseInput(record: AiSessionMapRecord): AiSessionMapRecord {
  if (!isRecord(record)) throw new AiSessionMapStoreError('corrupt')
  return parseRecord({ schemaVersion: 1, ...record }, record.chatId)
}

export function createAiSessionMapStore(options: { readonly getDatabase: () => AiSessionMapDatabase | null }): AiSessionMapStore {
  const database = (): AiSessionMapDatabase => {
    try {
      const db = options.getDatabase()
      if (db !== null) return db
    } catch { /* an unopened/closing app database is unavailable */ }
    throw new AiSessionMapStoreError('unavailable')
  }

  return {
    async get(chatId) {
      const key = mapKey(chatId)
      try {
        const row = database().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value?: unknown } | undefined
        if (row === undefined) return null
        if (typeof row.value !== 'string') throw new AiSessionMapStoreError('corrupt')
        let value: unknown
        try { value = JSON.parse(row.value) } catch { throw new AiSessionMapStoreError('corrupt') }
        return parseRecord(value, chatId)
      } catch (error) {
        if (error instanceof AiSessionMapStoreError) throw error
        throw new AiSessionMapStoreError('unavailable')
      }
    },
    async put(input) {
      const record = parseInput(input)
      const key = mapKey(record.chatId)
      const value = JSON.stringify({ schemaVersion: 1, ...record })
      try {
        database().prepare('INSERT INTO app_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
      } catch {
        throw new AiSessionMapStoreError('unavailable')
      }
    },
    async remove(chatId) {
      const key = mapKey(chatId)
      try { database().prepare('DELETE FROM app_settings WHERE key = ?').run(key) } catch { throw new AiSessionMapStoreError('unavailable') }
    },
  }
}
