import type { GroupTopicDTO } from '../../../shared/api'

export interface GroupTopicsOverviewChat {
  chatId: string
  name: string | null
}

export type GroupTopicsOverviewEntry = {
  chat: GroupTopicsOverviewChat
  status: 'enabled' | 'disabled' | 'failed'
  topics: GroupTopicDTO[]
  error?: string
}

export async function loadGroupTopicsOverview(
  chats: GroupTopicsOverviewChat[],
  list: (chatId: string) => Promise<{ ok: boolean; topics: GroupTopicDTO[] }>
): Promise<GroupTopicsOverviewEntry[]> {
  return Promise.all(chats.map(async (chat): Promise<GroupTopicsOverviewEntry> => {
    try {
      const result = await list(chat.chatId)
      return {
        chat,
        status: result.ok ? 'enabled' : 'disabled',
        topics: result.topics
      }
    } catch (error) {
      return {
        chat,
        status: 'failed',
        topics: [],
        error: error instanceof Error && error.message ? error.message : '未知錯誤'
      }
    }
  }))
}
