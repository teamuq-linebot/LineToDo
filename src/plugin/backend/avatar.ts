import type { AvatarCache } from './avatarCache'
import type { LineAvatarMetadataBatch } from '../../main/line/engine/watchEngine'
import type { LineAvatarSource } from '../../main/line/engine/linedb'

export interface AvatarMetadataReader {
  read(input: { chatIds?: readonly string[]; chatId?: string; msgIds?: readonly string[] }): Promise<LineAvatarMetadataBatch>
}

export interface AvatarDb {
  prepare(sql: string): { run(...args: unknown[]): unknown }
}

export interface PluginAvatars {
  prepareChats(chatIds: unknown): Promise<{ paths: Record<string, string>; names: Record<string, string> }>
  prepareMessages(chatId: unknown, msgIds: unknown): Promise<{ paths: Record<string, string>; names: Record<string, string> }>
}

const squareHashPattern = /^0h[A-Za-z0-9_-]+$/u
const goodText = (value: string | null): value is string => typeof value === 'string' && value.trim().length > 0

function locatorFor(source: LineAvatarSource): string | null {
  if (!goodText(source.locator)) return null
  if (source.source === 'square') {
    return squareHashPattern.test(source.locator)
      ? `https://obs.line-scdn.net/${source.locator}`
      : null
  }
  return source.source === 'profile' ? source.locator : null
}

function boundedIds(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 180))].slice(0, max)
}

export function createPluginAvatars(options: {
  cache: AvatarCache
  reader: AvatarMetadataReader
  getDb(): AvatarDb | null
}): PluginAvatars {
  const updateChatName = (chatId: string, name: string | null): void => {
    if (!goodText(name)) return
    const db = options.getDb()
    if (!db) return
    db.prepare(`UPDATE chats SET name=? WHERE chat_id=? AND
      (name IS NULL OR trim(name)='' OR name=chat_id OR name IN ('未命名群組','LINE 聯絡人'))`).run(name, chatId)
  }
  const updateMessageSender = (msgId: string, sender: LineAvatarSource): void => {
    if (!goodText(sender.displayName)) return
    const db = options.getDb()
    if (!db) return
    // This is a display-only repair. Do not touch processed, message ids, todos, topics, or source content.
    db.prepare(`UPDATE messages SET sender=? WHERE msg_id=? AND
      (sender IS NULL OR trim(sender)='' OR sender='未知發話者' OR sender=?)`).run(sender.displayName, msgId, sender.identity)
  }

  return {
    async prepareChats(rawIds) {
      const chatIds = boundedIds(rawIds, 100)
      if (chatIds.length === 0) return { paths: {}, names: {} }
      const sources = (await options.reader.read({ chatIds })).chats
      const paths: Record<string, string> = {}
      const names: Record<string, string> = {}
      await Promise.all(chatIds.map(async (chatId) => {
        const source = sources[chatId]
        if (!source) return
        if (goodText(source.displayName)) {
          names[chatId] = source.displayName
          updateChatName(chatId, source.displayName)
        }
        const locator = locatorFor(source)
        if (!locator) return
        const result = await options.cache.get({ identity: source.identity, locator })
        if (result) paths[chatId] = result.path
      }))
      return { paths, names }
    },

    async prepareMessages(rawChatId, rawMsgIds) {
      if (typeof rawChatId !== 'string' || rawChatId.length === 0 || rawChatId.length > 128) return { paths: {}, names: {} }
      const msgIds = boundedIds(rawMsgIds, 200)
      if (msgIds.length === 0) return { paths: {}, names: {} }
      const sources = (await options.reader.read({ chatId: rawChatId, msgIds })).messages
      const paths: Record<string, string> = {}
      const names: Record<string, string> = {}
      await Promise.all(msgIds.map(async (msgId) => {
        const source = sources[msgId]
        if (!source) return
        if (goodText(source.displayName)) {
          names[msgId] = source.displayName
          updateMessageSender(msgId, source)
        }
        const locator = locatorFor(source)
        if (!locator) return
        const result = await options.cache.get({ identity: source.identity, locator })
        if (result) paths[msgId] = result.path
      }))
      return { paths, names }
    }
  }
}
