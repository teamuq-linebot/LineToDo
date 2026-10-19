import type { ChatDTO } from '../../shared/api'

export type MicrotaskScheduler = (callback: () => void) => void

export function buildChatNameMap(chats: ChatDTO[]): Record<string, { name: string | null; isGroup: boolean }> {
  const map: Record<string, { name: string | null; isGroup: boolean }> = {}
  for (const chat of chats) map[chat.chatId] = { name: chat.name, isGroup: chat.isGroup }
  return map
}

/** Coalesce queued refreshes and allow at most one trailing refresh while busy. */
export function createChatRefreshScheduler(
  refresh: (isActive: () => boolean) => Promise<void>,
  schedule: MicrotaskScheduler = queueMicrotask,
  onError: (error: unknown) => void = (error) => console.error('[useTodos] loadChats 失敗：', error)
): { request: () => void; dispose: () => void } {
  let active = true
  let running = false
  let scheduled = false
  let dirty = false

  const request = (): void => {
    if (!active) return
    if (running) {
      dirty = true
      return
    }
    if (scheduled) return
    scheduled = true
    schedule(() => {
      scheduled = false
      if (!active) return
      running = true
      dirty = false
      void refresh(() => active)
        .catch(onError)
        .finally(() => {
          running = false
          if (active && dirty) {
            dirty = false
            request()
          }
        })
    })
  }

  return {
    request,
    dispose: () => {
      active = false
      dirty = false
    }
  }
}
