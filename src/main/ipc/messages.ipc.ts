import { ipcMain } from 'electron'
import {
  listMessages,
  getRecentByChat,
  getByChatSince,
  countMessages,
  type ListMessagesQuery
} from '../db/messages.repo'
import type { MessageDTO } from '../db/dto'

/**
 * messages:* IPC handler。讓 renderer 從持久化 DB 查訊息鏡像。
 *
 * 注意：與既有 'messages:recent'（main ring buffer 回放）並存且不同義 —
 *   - messages:recent       = 本 session 記憶體最近 N 則（watcher.ts，不落庫也能用）
 *   - messages:list         = DB 持久化查詢（重啟後仍在）
 *   - messages:recentByChat = DB 某 chat 最近 N 則（LLM 上下文 / 對話視圖）
 */
export function registerMessagesIpc(): void {
  ipcMain.handle(
    'messages:list',
    (_e, query: ListMessagesQuery = {}): MessageDTO[] => listMessages(query)
  )

  ipcMain.handle(
    'messages:recentByChat',
    (_e, args: { chatId: string; limit?: number }): MessageDTO[] => {
      if (!args || typeof args.chatId !== 'string') return []
      return getRecentByChat(args.chatId, args.limit ?? 30)
    }
  )

  // messages:byChatSince = 某 chat 在 ts >= sinceMs 的完整時間窗（來源訊息彈窗「過去 24h」用）。
  // 回傳依 ts 由舊到新、無筆數上限（見 getByChatSince）。
  ipcMain.handle(
    'messages:byChatSince',
    (_e, args: { chatId: string; sinceMs: number }): MessageDTO[] => {
      if (!args || typeof args.chatId !== 'string' || typeof args.sinceMs !== 'number') {
        return []
      }
      return getByChatSince(args.chatId, args.sinceMs)
    }
  )

  ipcMain.handle(
    'messages:count',
    (_e, args: { chatId?: string } = {}): number => countMessages(args?.chatId)
  )
}
