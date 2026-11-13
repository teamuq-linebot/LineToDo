import type { GroupTopicDTO, GroupTopicsOverviewDTO } from '../../../shared/api'

export interface GroupTopicsOverviewChat {
  chatId: string
  name: string | null
}

export type GroupTopicsOverviewEntry = {
  chat: GroupTopicsOverviewChat
  status: 'enabled' | 'disabled' | 'failed'
  topics: GroupTopicDTO[]
  topicCount?: number
  compacted?: boolean
  omittedGroupCount?: number
  omittedTopicCount?: number
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

export function overviewToEntries(rows: GroupTopicsOverviewDTO[]): GroupTopicsOverviewEntry[] {
  return rows.map((row) => ({
    chat: { chatId: row.chatId, name: row.name },
    status: row.enabled ? 'enabled' : 'disabled',
    topics: row.topics,
    topicCount: row.topicCount,
    compacted: row.compacted,
    omittedGroupCount: row.omittedGroupCount,
    omittedTopicCount: row.omittedTopicCount
  }))
}

/** 預算裁切摘要，獨立於議題列，確保整群議題被省略時仍可見。 */
export function overviewOmissionNotice(groups: GroupTopicsOverviewEntry[]): string | null {
  const omittedGroups = groups.reduce((sum, group) => sum + (group.omittedGroupCount ?? 0), 0)
  const omittedTopics = groups.reduce((sum, group) => sum + Math.max(0, (group.topicCount ?? group.topics.length) - group.topics.length) + (group.omittedTopicCount ?? 0), 0)
  const groupsWithOmissions = groups.filter((group) => (group.topicCount ?? group.topics.length) > group.topics.length).length + omittedGroups
  if (omittedTopics === 0 && omittedGroups === 0) return null
  return `總覽因回應大小限制省略 ${omittedTopics} 則議題，涉及 ${groupsWithOmissions} 個群組${omittedGroups ? `（其中 ${omittedGroups} 個群組整筆省略）` : ''}；開啟單群議題可閱讀完整紀錄。`
}

export const OVERVIEW_REFRESH_MIN_INTERVAL_MS = 2000

/**
 * 把多次重拉請求合併成：同一時間最多一次進行中、兩次之間至少間隔 minIntervalMs。
 * 進行中又來的請求只留一次尾端重拉。dispose 後不再觸發。
 */
export function createOverviewRefresher(
  load: () => Promise<void>,
  minIntervalMs = OVERVIEW_REFRESH_MIN_INTERVAL_MS,
  timers: { set: (callback: () => void, ms: number) => unknown; clear: (handle: unknown) => void; now: () => number } = {
    set: (callback, ms) => setTimeout(callback, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now()
  }
): { request: () => void; dispose: () => void } {
  let active = true
  let running = false
  let dirty = false
  let timer: unknown = null
  let lastStart = Number.NEGATIVE_INFINITY

  const start = (): void => {
    timer = null
    if (!active) return
    running = true
    dirty = false
    lastStart = timers.now()
    void load().catch(() => undefined).finally(() => {
      running = false
      if (active && dirty) request()
    })
  }
  const request = (): void => {
    if (!active) return
    if (running) { dirty = true; return }
    if (timer !== null) return
    const wait = Math.max(0, lastStart + minIntervalMs - timers.now())
    timer = timers.set(start, wait)
  }
  return {
    request,
    dispose: () => {
      active = false
      dirty = false
      if (timer !== null) timers.clear(timer)
      timer = null
    }
  }
}
