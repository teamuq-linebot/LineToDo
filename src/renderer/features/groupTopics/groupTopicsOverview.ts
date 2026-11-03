import type { GroupTopicDTO, GroupTopicsOverviewDTO } from '../../../shared/api'

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

export function overviewToEntries(rows: GroupTopicsOverviewDTO[]): GroupTopicsOverviewEntry[] {
  return rows.map((row) => ({
    chat: { chatId: row.chatId, name: row.name },
    status: row.enabled ? 'enabled' : 'disabled',
    topics: row.topics
  }))
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
