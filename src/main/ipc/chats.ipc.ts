import { ipcMain } from 'electron'
import { listChats, setBlocked, getChat } from '../db/chats.repo'
import { dismissOpenTodosByChat } from '../db/todos.repo'
import { getSettings, updateSettings } from '../config/settings'
import type { ChatDTO } from '../db/dto'

/**
 * chats:* IPC handler。聊天室清單、黑名單切換、卡片三段忽略（封鎖對話 / 依關鍵字忽略）。
 */
export function registerChatsIpc(): void {
  ipcMain.handle(
    'chats:list',
    (_e, args: { includeBlocked?: boolean } = {}): ChatDTO[] =>
      listChats({ includeBlocked: args?.includeBlocked })
  )

  ipcMain.handle('chats:get', (_e, args: { chatId: string }): ChatDTO | null => {
    if (!args || typeof args.chatId !== 'string') return null
    return getChat(args.chatId)
  })

  ipcMain.handle(
    'chats:setBlocked',
    (
      _e,
      args: { chatId: string; blocked: boolean; reason?: string }
    ): ChatDTO | null => {
      if (!args || typeof args.chatId !== 'string') return null
      return setBlocked(args.chatId, !!args.blocked, args.reason ?? null)
    }
  )

  // 卡片「封鎖這個對話」：手動封鎖（不再送 LLM）+ 把該對話未完成代辦整批 dismissed（清看板）。
  ipcMain.handle(
    'chats:blockAndClear',
    (_e, args: { chatId: string }): { ok: boolean; dismissed: number } => {
      if (!args || typeof args.chatId !== 'string') return { ok: false, dismissed: 0 }
      setBlocked(args.chatId, true, 'manual')
      const dismissed = dismissOpenTodosByChat(args.chatId)
      return { ok: true, dismissed }
    }
  )

  // 卡片「依關鍵字忽略（此對話）」：把關鍵字加進該對話 ignore 表（持久化）+
  // 立即 dismissed 該對話中標題/備註已命中此關鍵字的未完成代辦。
  ipcMain.handle(
    'chats:addIgnoreKeyword',
    (
      _e,
      args: { chatId: string; keyword: string }
    ): { ok: boolean; dismissed: number; error?: string } => {
      if (!args || typeof args.chatId !== 'string') {
        return { ok: false, dismissed: 0, error: '缺少 chatId' }
      }
      const kw = (args.keyword ?? '').trim().toLowerCase()
      if (!kw) return { ok: false, dismissed: 0, error: '關鍵字不可為空' }

      const cur = getSettings().chatIgnoreKeywords
      const existing = cur[args.chatId] ?? []
      const nextKws = Array.from(new Set([...existing, kw]))
      updateSettings({ chatIgnoreKeywords: { ...cur, [args.chatId]: nextKws } })

      const dismissed = dismissOpenTodosByChat(args.chatId, kw)
      return { ok: true, dismissed }
    }
  )

  // 設定頁「解除」某對話的某個 ignore 關鍵字（反悔）。
  ipcMain.handle(
    'chats:removeIgnoreKeyword',
    (_e, args: { chatId: string; keyword: string }): { ok: boolean } => {
      if (!args || typeof args.chatId !== 'string') return { ok: false }
      const kw = (args.keyword ?? '').trim().toLowerCase()
      const cur = getSettings().chatIgnoreKeywords
      const existing = cur[args.chatId] ?? []
      const nextKws = existing.filter((k) => k !== kw)
      const nextMap = { ...cur }
      if (nextKws.length) nextMap[args.chatId] = nextKws
      else delete nextMap[args.chatId]
      updateSettings({ chatIgnoreKeywords: nextMap })
      return { ok: true }
    }
  )
}
