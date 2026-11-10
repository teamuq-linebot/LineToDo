import type { ChatRefreshQueueStatus } from '../shared/api'

/**
 * 「重新整理最近 N 天」的排隊：不同聊天室依 FIFO 一個接一個跑；同一聊天室已在排隊或執行中就不重複加入。
 * `isBlocked`（回顧進行中）為真時先等著，每 `pollMs` 重新確認（回顧結束不會通知這裡）。
 */

interface Entry {
  chatId: string
  job: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

export interface ChatRefreshQueueOptions {
  isBlocked?(): boolean
  pollMs?: number
}

export class ChatRefreshQueue {
  private readonly waiting: Entry[] = []
  private running: Entry | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly opts: ChatRefreshQueueOptions

  constructor(opts: ChatRefreshQueueOptions = {}) {
    this.opts = opts
  }

  status(chatId: string): ChatRefreshQueueStatus {
    if (this.running?.chatId === chatId) return { state: 'running', ahead: 0 }
    const index = this.waiting.findIndex((entry) => entry.chatId === chatId)
    if (index < 0) return { state: 'idle', ahead: 0 }
    return { state: 'queued', ahead: index + (this.running ? 1 : 0) }
  }

  /** 同一聊天室已在排隊或執行中回 null（不重複加入）；否則排到最後，回傳這一筆的結果。 */
  enqueue<T>(chatId: string, job: () => Promise<T>): Promise<T> | null {
    if (this.status(chatId).state !== 'idle') return null
    return new Promise<T>((resolve, reject) => {
      this.waiting.push({ chatId, job, resolve: resolve as (value: unknown) => void, reject })
      this.pump()
    })
  }

  private pump(): void {
    if (this.running || this.waiting.length === 0) return
    if (this.opts.isBlocked?.()) {
      this.arm()
      return
    }
    const entry = this.waiting.shift()!
    this.running = entry
    // 先讓出執行權再把結果交給呼叫端：呼叫端拿到結果時，狀態已經不是 running。
    void new Promise<unknown>((resolve) => resolve(entry.job())).then(
      (value) => {
        this.running = null
        entry.resolve(value)
        this.pump()
      },
      (error: unknown) => {
        this.running = null
        entry.reject(error)
        this.pump()
      }
    )
  }

  private arm(): void {
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.pump()
    }, this.opts.pollMs ?? 1000)
  }
}
