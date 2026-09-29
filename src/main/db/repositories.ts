import type { Database } from 'better-sqlite3'
import * as chatsRepo from './chats.repo'
import * as messagesRepo from './messages.repo'
import * as todosRepo from './todos.repo'
import * as pipelineRepo from './pipeline.repo'

/** Instance-bound repository bundle; every closure below captures exactly one DB connection. */
export function createRepositories(db: Database) {
  return {
    chats: {
      upsert: (input: chatsRepo.UpsertChatInput) => chatsRepo.upsertChat(input, db),
      get: (chatId: string) => chatsRepo.getChat(chatId, db),
      list: (options: { includeBlocked?: boolean } = {}) => chatsRepo.listChats(options, db),
      setBlocked: (chatId: string, blocked: boolean, reason: string | null = null) => chatsRepo.setBlocked(chatId, blocked, reason, db)
    },
    messages: {
      insert: (message: Parameters<typeof messagesRepo.insertMessage>[0]) => messagesRepo.insertMessage(message, db),
      insertBatch: (messages: Parameters<typeof messagesRepo.insertMessages>[0]) => messagesRepo.insertMessages(messages, db),
      list: (query: messagesRepo.ListMessagesQuery = {}) => messagesRepo.listMessages(query, db),
      recentByChat: (chatId: string, limit = 30) => messagesRepo.getRecentByChat(chatId, limit, db),
      byChatSince: (chatId: string, sinceMs: number) => messagesRepo.getByChatSince(chatId, sinceMs, db),
      count: (chatId?: string) => messagesRepo.countMessages(chatId, db),
      countChatsWithRecent: (days = 7) => messagesRepo.countChatsWithRecentMessages(days, db),
      unprocessedForPipeline: (limit = 2000) => messagesRepo.getUnprocessedForPipeline(limit, db),
      markProcessed: (ids: string[]) => messagesRepo.markProcessed(ids, db)
    },
    todos: {
      create: (input: todosRepo.CreateTodoInput) => todosRepo.createTodo(input, db),
      get: (id: string) => todosRepo.getTodo(id, db),
      list: (query: todosRepo.ListTodosQuery = {}) => todosRepo.listTodos(query, db),
      openByChat: (chatId: string) => todosRepo.getOpenTodosByChat(chatId, db),
      dismissOpenByChat: (chatId: string, keyword?: string) => todosRepo.dismissOpenTodosByChat(chatId, keyword, db),
      updateStatus: (id: string, status: Parameters<typeof todosRepo.updateStatus>[1]) => todosRepo.updateStatus(id, status, db),
      update: (id: string, patch: todosRepo.UpdateTodoPatch) => todosRepo.updateTodo(id, patch, db),
      reclassify: (id: string, patch: todosRepo.ReclassifyTodoPatch) => todosRepo.reclassifyTodo(id, patch, db),
      moveColumn: (id: string, column: todosRepo.TodoColumn) => todosRepo.moveTodoToColumn(id, column, db),
      mergeSources: (id: string, msgIds: string[]) => todosRepo.mergeSources(id, msgIds, db),
      resolve: (id: string, evidence: string, toDone: boolean) => todosRepo.resolveTodo(id, evidence, toDone, db),
      count: () => todosRepo.countTodos(db)
    },
    pipeline: {
      startRun: () => pipelineRepo.startRun(db),
      finishRun: (id: string, input: pipelineRepo.FinishRunInput) => pipelineRepo.finishRun(id, input, db),
      getRun: (id: string) => pipelineRepo.getRun(id, db),
      getLastRun: () => pipelineRepo.getLastRun(db),
      getChatsSeenStats: (count = pipelineRepo.CHATS_SEEN_SAMPLE_RUNS) => pipelineRepo.getChatsSeenStats(count, db)
    }
  }
}

export type Repositories = ReturnType<typeof createRepositories>
