import type { ChatRefreshLastResult, ChatRefreshQueueStatus } from '../shared/api'
import { emptyResult, parseChatRefreshDays, type ChatRefreshResult } from '../main/pipeline/chatRefresh'

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

export interface ChatRefreshServiceDeps {
  queue?: ChatRefreshQueue
  /** 守門（參數、聊天室、開關、AI）；回傳非 null 就是立即結果，不排隊。 */
  precheck(chatId: string, days: unknown): Promise<ChatRefreshResult | null>
  /** 排隊後真正執行的重新整理。 */
  run(chatId: string, days: unknown): Promise<ChatRefreshResult>
  now?(): number
}

export interface ChatRefreshService {
  refreshChat(chatId: string, days: unknown): Promise<ChatRefreshResult>
  refreshChatStatus(chatId: string): ChatRefreshQueueStatus
}

/**
 * pipeline.refreshChat 的組裝。守門通過後一律立即回應：排到後面回 reason `queued`（附 ahead），
 * 馬上開始也回 `queued`（ahead 0）；同一聊天室已在排隊或執行中回 already_*。實際執行在背景依序進行，
 * 結果存進每個聊天室的 last，由 refreshChatStatus 取得。呼叫端不會因此變成長時間的 pending job。
 */
export function createChatRefreshService(deps: ChatRefreshServiceDeps): ChatRefreshService {
  const queue = deps.queue ?? new ChatRefreshQueue()
  const now = deps.now ?? (() => Date.now())
  const last = new Map<string, ChatRefreshLastResult>()
  return {
    async refreshChat(chatId, days) {
      const early = await deps.precheck(chatId, days)
      if (early) return early
      const parsed = parseChatRefreshDays(days)
      const job = queue.enqueue(chatId, () => deps.run(chatId, days))
      if (!job) return emptyResult(parsed, null, queue.status(chatId).state === 'running' ? 'already_running' : 'already_queued')
      const { ahead } = queue.status(chatId)
      void job.then(
        (result) => { last.set(chatId, { ok: result.ok, finishedAtMs: now(), result }) },
        () => { last.set(chatId, { ok: false, finishedAtMs: now(), result: emptyResult(parsed, null, 'internal_error') }) }
      )
      return { ...emptyResult(parsed, null, 'queued'), ahead }
    },
    refreshChatStatus(chatId) {
      const status = queue.status(chatId)
      const finished = last.get(chatId)
      return finished ? { ...status, last: finished } : status
    }
  }
}
