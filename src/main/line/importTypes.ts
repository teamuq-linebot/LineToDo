import type { RawLineMessage } from './types'
import type { LineAvatarSource } from './engine/linedb'

export interface LineSourceCursor {
  createdTime: number
  rowId: number
}

/** Main-process-only item. senderMid is for the identity provider and the avatar tables only; accountMid is never persisted. */
export interface LineImportItem {
  message: RawLineMessage
  sourceRowId: number
  senderMid: string | null
  accountMid: string | null
}

/** Avatar metadata read from the LINE DB that is already open for this batch (opt-in: `avatarMeta`). Main-process only. */
export interface LineImportAvatarMeta {
  chats: Array<{ chatId: string; source: LineAvatarSource }>
  senders: Array<{ chatId: string; senderMid: string; source: LineAvatarSource }>
}

export interface LineImportBatch {
  batchId: string
  source: 'line-watch' | 'line-backfill'
  cursorFrom: LineSourceCursor
  cursorTo: LineSourceCursor
  hasMore: boolean
  observedAt: string
  items: LineImportItem[]
  avatarMeta?: LineImportAvatarMeta
}
