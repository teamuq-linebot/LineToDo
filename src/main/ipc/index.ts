import { registerMessagesIpc } from './messages.ipc'
import { registerChatsIpc } from './chats.ipc'
import { registerTodosIpc } from './todos.ipc'

/**
 * registerDbIpc — 集中註冊所有「DB 持久化」相關 IPC handler。
 * 由 main/index.ts 在 app ready 後呼叫一次。
 *
 * 註：即時訊息流的 line:* / messages:recent / app:ping 仍直接註冊在 index.ts，
 * 不在此處（那些不依賴 DB）。本檔只聚合 DB 查詢類通道。
 */
export function registerDbIpc(): void {
  registerMessagesIpc()
  registerChatsIpc()
  registerTodosIpc()
}
