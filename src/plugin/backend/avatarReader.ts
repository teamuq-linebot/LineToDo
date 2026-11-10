import type { Database } from 'better-sqlite3'
import { isLineAvatarSchemaReady, readLocalAvatars } from '../../main/db/lineAvatar.repo'
import type { LocalAvatarResult } from '../../main/db/lineAvatar.repo'
import { normalizeAvatarRequest } from '../../main/line/engine/watchEngine'
import type { AvatarMetadataReader } from './avatar'

/**
 * avatarReader.ts — 頭像只讀本地 DB：非 Square 讀通訊錄表，Square 成員讀匯入時寫入的發話者表，其餘空（畫面顯示字母）。
 *
 * 不開 LINE DB、不取 lease、不複製；本地讀不到（表不見了、讀取丟例外）一律當作沒有結果，不往外丟。
 * 每次呼叫都重新判斷本地表是否就緒。
 */

export type AvatarReadKind = 'local' | 'miss'

export interface LayeredAvatarReaderOptions {
  getDb(): Database | null
  /** 通訊錄層（entity）要不要用；沒給就不用。每次讀取都重新問，旗標關掉或表不見了立刻沒有頭像。 */
  entityOn?(): boolean
  /** 計數（診斷用）：local 是有結果的 id 個數，miss 是沒有結果的 id 個數。 */
  onStat?(kind: AvatarReadKind, n: number): void
}

export function createLayeredAvatarReader(options: LayeredAvatarReaderOptions): AvatarMetadataReader {
  const stat = (kind: AvatarReadKind, n: number): void => {
    if (n <= 0 || !options.onStat) return
    try { options.onStat(kind, n) } catch { /* 診斷不能影響讀取 */ }
  }

  return {
    async read(input) {
      const request = normalizeAvatarRequest(input)
      const result: LocalAvatarResult = { chats: {}, messages: {} }
      const { chatIds, chatId, msgIds } = request
      if (chatIds.length === 0 && (!chatId || msgIds.length === 0)) return result

      const db = options.getDb()
      if (db !== null && isLineAvatarSchemaReady(db)) {
        try {
          let entity = false
          try { entity = options.entityOn?.() === true } catch { entity = false }
          const local = readLocalAvatars(db, request, { entity })
          Object.assign(result.chats, local.chats)
          Object.assign(result.messages, local.messages)
        } catch { /* 本地層讀不到：沒有結果 */ }
      }
      const found = Object.keys(result.chats).length + Object.keys(result.messages).length
      const asked = chatIds.length + (chatId ? msgIds.length : 0)
      stat('local', found)
      stat('miss', asked - found)
      return result
    }
  }
}
