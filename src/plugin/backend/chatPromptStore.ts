import { createHash } from 'node:crypto'
import { MY_NAME_MAX_CHARS, PROMPT_MAX_CHARS, PromptError, validateMyName } from '../../shared/promptSettings'

export const CHAT_PROMPT_KEY_PREFIX = 'line-todo.chat-prompt.v1.'
const CHAT_ID_MAX_CHARS = 512

export interface ChatPromptOverride {
  readonly prompt: string | null
  readonly myName: string | null
}

export interface ChatPromptRead {
  readonly override: ChatPromptOverride
  readonly corrupt: boolean
}

export interface ChatPromptListEntry {
  readonly chatId: string
  readonly override: ChatPromptOverride
}

export interface ChatPromptStatement {
  get(...params: unknown[]): unknown
  run(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

export interface ChatPromptDatabase {
  prepare(sql: string): ChatPromptStatement
}

export interface ChatPromptStore {
  get(chatId: string): ChatPromptRead
  put(chatId: string, override: ChatPromptOverride): void
  list(): ChatPromptListEntry[]
  chatExists(chatId: string): boolean
}

export const EMPTY_CHAT_PROMPT_OVERRIDE: ChatPromptOverride = Object.freeze({ prompt: null, myName: null })

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 只雜湊，不限長度：抽取路徑（get）不能因為 chatId 形狀丟錯讓該對話永久退避；長度限制只在對外 API 驗證與 put。 */
export function chatPromptKey(chatId: string): string {
  if (typeof chatId !== 'string') throw new PromptError('chat_unknown')
  return `${CHAT_PROMPT_KEY_PREFIX}${createHash('sha256').update(chatId, 'utf8').digest('hex')}`
}

function parseOverride(value: unknown, expectedChatId: string): ChatPromptOverride | null {
  if (!isRecord(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 4 || !['schemaVersion', 'chatId', 'prompt', 'myName'].every((key) => Object.hasOwn(value, key))) return null
  if (value.schemaVersion !== 1 || value.chatId !== expectedChatId) return null
  const { prompt, myName } = value
  if (prompt !== null && (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.length > PROMPT_MAX_CHARS)) return null
  if (myName !== null) {
    if (typeof myName !== 'string') return null
    try { if (validateMyName(myName) !== myName || [...myName].length > MY_NAME_MAX_CHARS) return null } catch { return null }
  }
  if (prompt === null && myName === null) return null
  return { prompt: prompt as string | null, myName: myName as string | null }
}

export function createChatPromptStore(options: { readonly getDatabase: () => ChatPromptDatabase | null }): ChatPromptStore {
  const database = (): ChatPromptDatabase => {
    try {
      const db = options.getDatabase()
      if (db !== null) return db
    } catch { /* an unopened or closing app database is unavailable */ }
    throw new PromptError('chat_prompt_unavailable')
  }
  const guarded = <T>(run: (db: ChatPromptDatabase) => T): T => {
    const db = database()
    try { return run(db) } catch (error) {
      if (error instanceof PromptError) throw error
      throw new PromptError('chat_prompt_unavailable')
    }
  }
  const decode = (raw: unknown, chatId: string): ChatPromptRead => {
    if (typeof raw !== 'string') return { override: EMPTY_CHAT_PROMPT_OVERRIDE, corrupt: true }
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { return { override: EMPTY_CHAT_PROMPT_OVERRIDE, corrupt: true } }
    const override = parseOverride(parsed, chatId)
    return override === null ? { override: EMPTY_CHAT_PROMPT_OVERRIDE, corrupt: true } : { override, corrupt: false }
  }
  return {
    get(chatId) {
      const key = chatPromptKey(chatId)
      return guarded((db) => {
        const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value?: unknown } | undefined
        return row === undefined ? { override: EMPTY_CHAT_PROMPT_OVERRIDE, corrupt: false } : decode(row.value, chatId)
      })
    },
    put(chatId, override) {
      if (typeof chatId !== 'string' || chatId.length === 0 || chatId.length > CHAT_ID_MAX_CHARS) throw new PromptError('chat_unknown')
      const key = chatPromptKey(chatId)
      guarded((db) => {
        if (override.prompt === null && override.myName === null) {
          db.prepare('DELETE FROM app_settings WHERE key = ?').run(key)
          return
        }
        const value = JSON.stringify({ schemaVersion: 1, chatId, prompt: override.prompt, myName: override.myName })
        db.prepare('INSERT INTO app_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
      })
    },
    list() {
      return guarded((db) => {
        const rows = db.prepare('SELECT key, value FROM app_settings WHERE key LIKE ? ORDER BY key').all(`${CHAT_PROMPT_KEY_PREFIX}%`) as Array<{ key?: unknown; value?: unknown }>
        const entries: ChatPromptListEntry[] = []
        for (const row of rows) {
          if (typeof row.key !== 'string' || typeof row.value !== 'string') continue
          let parsed: unknown
          try { parsed = JSON.parse(row.value) } catch { continue }
          const chatId = isRecord(parsed) && typeof parsed.chatId === 'string' ? parsed.chatId : null
          if (chatId === null || chatId.length === 0 || chatId.length > CHAT_ID_MAX_CHARS || chatPromptKey(chatId) !== row.key) continue
          const override = parseOverride(parsed, chatId)
          if (override !== null) entries.push({ chatId, override })
        }
        return entries
      })
    },
    chatExists(chatId) {
      if (typeof chatId !== 'string' || chatId.length === 0 || chatId.length > CHAT_ID_MAX_CHARS) return false
      return guarded((db) => db.prepare('SELECT 1 AS found FROM chats WHERE chat_id = ?').get(chatId) !== undefined)
    }
  }
}
