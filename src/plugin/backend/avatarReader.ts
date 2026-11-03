import type { Database } from 'better-sqlite3'
import { isLineAvatarSchemaReady, persistFallbackAvatars, readLocalAvatars } from '../../main/db/lineAvatar.repo'
import type { LocalAvatarResult } from '../../main/db/lineAvatar.repo'
import { normalizeAvatarRequest } from '../../main/line/engine/watchEngine'
import type { AvatarMetadataReader } from './avatar'

/**
 * avatarReader.ts — 頭像的分層讀取（設計附錄 §5）：本地 DB → `any` snapshot（fallback，結果寫回本地）→ 空（畫面顯示文字頭像）。
 *
 * 本地命中時不開 LINE DB、不取 lease、不複製。fallback 只被問「本地沒有」的 id，查到的寫回本地（每則訊息最多慢一次）。
 * 查不到的結果在記憶體負向快取 10 分鐘（最多 2,000 筆）；fallback 丟例外或回 null 都當作沒有結果，不往外丟。
 * 每次呼叫都重新判斷本地表是否就緒（建表失敗或功能關閉時退回只走 fallback）。
 */

export type AvatarReadKind = 'local' | 'fallback' | 'miss' | 'write'

export interface LayeredAvatarReaderOptions {
  getDb(): Database | null
  fallback: AvatarMetadataReader
  now?(): number
  /** 計數（診斷用）：local／fallback／miss 是 id 的個數，write 是寫回本地的筆數。 */
  onStat?(kind: AvatarReadKind, n: number): void
}

const NEGATIVE_TTL_MS = 10 * 60 * 1000
const NEGATIVE_MAX = 2000

export function createLayeredAvatarReader(options: LayeredAvatarReaderOptions): AvatarMetadataReader {
  const now = options.now ?? Date.now
  const stat = (kind: AvatarReadKind, n: number): void => {
    if (n <= 0 || !options.onStat) return
    try { options.onStat(kind, n) } catch { /* 診斷不能影響讀取 */ }
  }
  const negative = new Map<string, number>()
  const isNegative = (key: string): boolean => {
    const until = negative.get(key)
    if (until === undefined) return false
    if (until > now()) return true
    negative.delete(key)
    return false
  }
  const remember = (key: string): void => {
    negative.delete(key)
    while (negative.size >= NEGATIVE_MAX) negative.delete(negative.keys().next().value as string)
    negative.set(key, now() + NEGATIVE_TTL_MS)
  }

  return {
    async read(input) {
      const request = normalizeAvatarRequest(input)
      const result: LocalAvatarResult = { chats: {}, messages: {} }
      const { chatIds, chatId, msgIds } = request
      if (chatIds.length === 0 && (!chatId || msgIds.length === 0)) return result

      const db = options.getDb()
      const ready = db !== null && isLineAvatarSchemaReady(db)
      if (ready) {
        try {
          const local = readLocalAvatars(db, request, now())
          Object.assign(result.chats, local.chats)
          Object.assign(result.messages, local.messages)
        } catch { /* 本地層讀不到：全部交給 fallback */ }
      }
      stat('local', Object.keys(result.chats).length + Object.keys(result.messages).length)

      const wantChats = chatIds.filter((id) => !(id in result.chats) && !isNegative(`c\0${id}`))
      const wantMsgs = chatId ? msgIds.filter((id) => !(id in result.messages) && !isNegative(`m\0${chatId}\0${id}`)) : []
      if (wantChats.length === 0 && wantMsgs.length === 0) return result

      const fetched: LocalAvatarResult = { chats: {}, messages: {}, accountMid: null }
      try {
        const answer = await options.fallback.read({ chatIds: wantChats, ...(chatId && wantMsgs.length > 0 ? { chatId, msgIds: wantMsgs } : {}) })
        fetched.accountMid = answer?.accountMid ?? null
        for (const id of wantChats) if (answer?.chats?.[id]) fetched.chats[id] = answer.chats[id]
        for (const id of wantMsgs) if (answer?.messages?.[id]) fetched.messages[id] = answer.messages[id]
      } catch { /* 沒有 snapshot、沒有金鑰或讀取失敗：當作沒有結果 */ }

      let misses = 0
      for (const id of wantChats) { if (!(id in fetched.chats)) { remember(`c\0${id}`); misses += 1 } }
      for (const id of wantMsgs) { if (!(id in fetched.messages)) { remember(`m\0${chatId}\0${id}`); misses += 1 } }
      stat('fallback', Object.keys(fetched.chats).length + Object.keys(fetched.messages).length)
      stat('miss', misses)
      if (ready && (Object.keys(fetched.chats).length > 0 || Object.keys(fetched.messages).length > 0)) {
        try { stat('write', persistFallbackAvatars(db, fetched, chatId, now())) } catch { /* 寫回失敗只影響快取，不影響回傳 */ }
      }
      Object.assign(result.chats, fetched.chats)
      Object.assign(result.messages, fetched.messages)
      return result
    }
  }
}
