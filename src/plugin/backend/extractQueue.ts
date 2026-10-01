/**
 * extractQueue.ts — 外掛版 AI 抽取的「供料／收料」（設計 v2 §4.3）。
 *
 * 1.6.8 的 `ai:chat` 只在 view 端可用、backend 沒有 AI，所以抽取的「大腦」在 UI（Phase 4 的 aiOrchestrator）。
 * backend 只做兩件事，而且**完全不打 LLM、不 spawn 任何東西**：
 *
 *   供料（outbox）：runOnce 的步驟 1-4（落庫、黑名單、噪音過濾、取未處理訊息按 chat 分組）照跑，
 *     但在呼叫 extractFn 之前停下，把每個 chat 的 `ChatExtractInput` 交給本佇列（`offer`）。
 *     本佇列依 `ai:chat` 的單輪輸入上限把 payload 切成 ≤ maxUserChars 的「片段」，UI 以 `pull` 領走（附租約）。
 *   收料（inbox）：UI 把 `ai:chat` 回來、已 parse 的 JSON 以 `commit` 送回；backend **重新用 zod 驗證**
 *     （格式錯誤 → 拒絕、該 chat 退避重排，訊息維持未處理），通過後走與 standalone 同一份落庫邏輯
 *     `applyChatExtract()`（近似去重、完成偵測、重新分類、標 processed）。
 *
 * 失敗語意對齊現行 runOnce：失敗的 chat 訊息**不**標 processed，下一輪重抽；per-chat 指數退避（對齊 ChatBackoff）。
 * 另提供 `request()`：呼叫端要「同步拿到結果」的情境（reviewLastDays 回顧）— 同一個 pull/commit 通道，
 * 結果不落庫、直接 resolve 給呼叫端（由呼叫端自己的流程落庫）。
 */
import { createHash, randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { PipelineDefaults } from '../../main/config/defaults'
import type { MessageDTO } from '../../main/db/dto'
import { finishRun, startRun } from '../../main/db/pipeline.repo'
import { EXTRACT_SYSTEM_PROMPT, buildUserPayload } from '../../main/llm/extractPrompt'
import { validateExtractResult } from '../../main/llm/schema'
import type { ExtractResult } from '../../main/llm/schema'
import { applyChatExtract } from '../../main/pipeline/runOnce'
import type { ApplyTally, ChatExtractInput, ExtractSink, RunOnceResult } from '../../main/pipeline/runOnce'

export const EXTRACT_SYSTEM_SHA256 = createHash('sha256').update(EXTRACT_SYSTEM_PROMPT).digest('hex')

/** `AI_CHAT_LIMITS.inputChars` 是 8000；留餘裕給 UI 加的包裝。 */
export const DEFAULT_MAX_USER_CHARS = 7500
const DEFAULT_LEASE_MS = 120_000
const DEFAULT_RETRY_BASE_MS = 30_000
const DEFAULT_RETRY_MAX_MS = 30 * 60_000
const DEFAULT_AWAIT_TIMEOUT_MS = 15 * 60_000
/** 單次 pull 回傳的 JSON 預算（host 上限 64 KiB，留餘裕給 envelope）。 */
const DEFAULT_PULL_BUDGET_BYTES = 40 * 1024
const DEFAULT_MAX_ITEMS_PER_PULL = 4

// ───────────────────────── 切片：把一個 chat 的輸入切成 ≤ maxChars 的 payload ─────────────────────────

export interface ExtractPart {
  /** 此片段的輸入（newMessages 只含這一片的訊息；recentContext／openTodos 可能被縮減）。 */
  input: ChatExtractInput
  /** 此片段涵蓋（要標 processed）的訊息 id。所有片段的 msgIds 合起來恰好等於原輸入的 newMessages。 */
  msgIds: string[]
  /** 已序列化的 user payload（≤ maxChars，除非單一訊息怎麼縮都放不下）。 */
  user: string
  /** 被截短文字的訊息數（單一訊息本身就超過預算時才會發生）。 */
  truncated: number
}

function takeLast<T>(items: T[], n: number): T[] {
  return n <= 0 ? [] : items.slice(-n)
}

function buildPayload(input: ChatExtractInput, newMessages: MessageDTO[], recentContext: MessageDTO[], openTodos: ChatExtractInput['openTodos']): string {
  return buildUserPayload({
    now: input.now,
    chat: input.chat,
    newMessages,
    recentContext,
    openTodos,
    classificationCorrections: input.classificationCorrections
    // 刻意不傳 onCorrectionsPayloadBuilt：那個稽核 hook 只在 payload 真的被領走（pull）時才呼叫。
  })
}

/**
 * 依字元預算切片。順序：先放滿新訊息；一則都放不下時先縮 recentContext（丟最舊的）、再截短該則文字。
 * 後一片的 recentContext 接在前一片的新訊息之後（最多 contextLimit 則）。openTodos 若單獨就吃掉一半預算，截成前綴。
 */
export function partitionExtractInput(input: ChatExtractInput, opts: { maxChars: number; contextLimit: number }): ExtractPart[] {
  const { maxChars } = opts
  const contextLimit = Math.max(0, opts.contextLimit)
  let openTodos = input.openTodos
  while (openTodos.length > 0 && buildPayload(input, [], [], openTodos).length > maxChars / 2) {
    openTodos = openTodos.slice(0, Math.floor(openTodos.length / 2))
  }

  const messages = input.newMessages
  const parts: ExtractPart[] = []
  let context = takeLast(input.recentContext, contextLimit)
  let index = 0
  while (index < messages.length) {
    let count = 0
    let user = ''
    let used = context
    let chunk: MessageDTO[] = []
    let truncated = 0
    for (;;) {
      const next = count + 1
      if (index + next > messages.length) break
      const candidate = buildPayload(input, messages.slice(index, index + next), used, openTodos)
      if (candidate.length > maxChars) break
      count = next
      user = candidate
    }
    if (count > 0) {
      chunk = messages.slice(index, index + count)
    } else {
      // 一則都放不下：先縮 context。
      let shrunk = context
      while (shrunk.length > 0 && count === 0) {
        shrunk = shrunk.slice(1)
        const candidate = buildPayload(input, [messages[index]], shrunk, openTodos)
        if (candidate.length <= maxChars) { count = 1; user = candidate; used = shrunk; chunk = [messages[index]] }
      }
      if (count === 0) {
        // 沒有 context 了仍放不下：截短這則訊息的文字（逐步縮到放得下為止）。
        const original = messages[index]
        let room = Math.max(50, maxChars - buildPayload(input, [{ ...original, text: '' }], [], openTodos).length)
        let cut: MessageDTO = { ...original, text: (original.text ?? '').slice(0, room) }
        user = buildPayload(input, [cut], [], openTodos)
        while (user.length > maxChars && room > 50) {
          room = Math.max(50, Math.floor(room * 0.8))
          cut = { ...original, text: (original.text ?? '').slice(0, room) }
          user = buildPayload(input, [cut], [], openTodos)
        }
        count = 1; used = []; chunk = [cut]; truncated = (original.text ?? '').length > room ? 1 : 0
      }
    }
    const taken = messages.slice(index, index + count)
    parts.push({
      input: { ...input, newMessages: chunk, recentContext: used, openTodos },
      msgIds: taken.map((m) => m.msgId),
      user,
      truncated
    })
    context = takeLast([...context, ...taken], contextLimit)
    index += count
  }
  return parts
}

// ───────────────────────── 佇列 ─────────────────────────

export interface ExtractQueueOptions {
  db: Database
  getConfig(): PipelineDefaults
  /** commit 落庫後回報一輪結果（外掛接到 `scheduler.recordExternalRun`，沿用 pipeline-run / todos-changed 事件）。 */
  onRun?(result: RunOnceResult): void
  /** 可領取的項目集合有變動（外掛接到事件通道，UI 不必空轉輪詢）。 */
  onPending?(info: { pending: number }): void
  now?(): number
  maxUserChars?: number
  leaseMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
  awaitTimeoutMs?: number
  pullBudgetBytes?: number
  maxItemsPerPull?: number
}

export interface PullItem {
  /** 本次租約的 id；commit 必須帶回（租約過期或被重新領走後舊 id 失效）。 */
  itemId: string
  chatId: string
  chatName: string | null
  /** 要送給 `ai:chat` 的 user 訊息（JSON 字串，已 ≤ maxUserChars）。system prompt 用 `extract.system` 取。 */
  user: string
  userChars: number
  messageCount: number
  /** 這個 chat 已失敗的次數（供 UI 顯示／節流）。 */
  attempts: number
  part: number
  parts: number
  truncatedMessages: number
}

export interface PullResult {
  ok: true
  items: PullItem[]
  pending: number
  leased: number
  systemSha256: string
  maxUserChars: number
  /** 沒有可領項目但有項目在退避時：最短還要等多久。 */
  retryAfterMs: number | null
}

export interface CommitRequestItem {
  itemId: string
  ok: boolean
  /** `ok:true` 時：UI 已 JSON.parse 的模型輸出（backend 會重新驗證）。 */
  result?: unknown
  /** `ok:false` 時：UI 端的失敗代碼（`rate_limited`、`provider_error`、`invalid_json`…）。 */
  failCode?: string
  /** 失敗時建議的退避毫秒（例如 `ai:chat` 的 retryAfterMs）。 */
  retryAfterMs?: number
}

export type CommitItemStatus = 'applied' | 'accepted' | 'rejected' | 'failed_recorded' | 'unknown_item' | 'bad_request' | 'apply_failed'

export interface CommitItemResult {
  itemId: string
  status: CommitItemStatus
  chatId?: string
  code?: string
  issues?: string[]
  createdIds?: string[]
  resolvedIds?: string[]
  updatedIds?: string[]
  /** 退避到何時（ms，相對現在）；只有失敗時有。 */
  retryInMs?: number
}

export interface CommitResult {
  ok: true
  results: CommitItemResult[]
  /** 這次 commit 產生的 pipeline run（有任何項目落庫時）。 */
  run: { runId: string; todosCreated: number; todosMerged: number; resolved: number; updated: number; chatsFailed: number } | null
  pending: number
}

interface AwaitGroup {
  resolve(value: ExtractResult): void
  reject(error: Error): void
  results: Array<ExtractResult | undefined>
  remaining: number
  timer: NodeJS.Timeout | null
  settled: boolean
}

interface Entry {
  id: string
  chatId: string
  chatName: string | null
  msgIds: string[]
  input: ChatExtractInput
  user: string
  truncated: number
  partIndex: number
  partCount: number
  mode: 'apply' | 'await'
  gen: number
  attempts: number
  notBefore: number
  state: 'pending' | 'leased'
  itemId: string | null
  leaseUntil: number
  group: AwaitGroup | null
}

function mergeResults(parts: ExtractResult[]): ExtractResult {
  const importance = parts.some((p) => p.importance === 'action') ? 'action' : parts.some((p) => p.importance === 'fyi') ? 'fyi' : 'noise'
  const seenResolved = new Set<string>()
  const seenUpdated = new Set<string>()
  return {
    importance,
    newTodos: parts.flatMap((p) => p.newTodos),
    resolved: parts.flatMap((p) => p.resolved).filter((r) => (seenResolved.has(r.todoId) ? false : (seenResolved.add(r.todoId), true))),
    updates: parts.flatMap((p) => p.updates).filter((u) => (seenUpdated.has(u.todoId) ? false : (seenUpdated.add(u.todoId), true)))
  }
}

function issuesOf(error: unknown): string[] {
  const issues = (error as { issues?: Array<{ path?: unknown[]; message?: string }> } | null)?.issues
  if (Array.isArray(issues)) return issues.slice(0, 5).map((i) => `${(i.path ?? []).join('.') || '(root)'}: ${i.message ?? 'invalid'}`)
  return [error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)]
}

export class ExtractQueue implements ExtractSink {
  private readonly opts: ExtractQueueOptions
  private readonly entries = new Map<string, Entry>()
  /** chat 級的失敗記憶（對齊 ChatBackoff）：跨 cycle 保留 attempts／notBefore，成功即清掉。 */
  private readonly chatFail = new Map<string, { attempts: number; notBefore: number }>()
  private gen = 0
  private disposed = false
  private lastPendingKey = ''

  constructor(opts: ExtractQueueOptions) {
    this.opts = opts
  }

  private now(): number { return this.opts.now ? this.opts.now() : Date.now() }
  private get maxChars(): number { return this.opts.maxUserChars ?? DEFAULT_MAX_USER_CHARS }

  // ── ExtractSink（供料）──

  beginCycle(): void {
    this.gen += 1
  }

  offer(input: ChatExtractInput, msgIds: string[]): void {
    if (this.disposed) return
    this.reap()
    const chatId = input.chat.chatId
    const wanted = new Set(msgIds)
    // 已被領走（租約中）的訊息不重複供料；其餘訊息照常排隊。
    const inflight = new Set<string>()
    for (const e of this.entries.values()) if (e.chatId === chatId && e.mode === 'apply' && e.state === 'leased') for (const id of e.msgIds) inflight.add(id)
    for (const [id, e] of this.entries) if (e.chatId === chatId && e.mode === 'apply' && e.state === 'pending') this.entries.delete(id)
    const fresh = input.newMessages.filter((m) => wanted.has(m.msgId) && !inflight.has(m.msgId))
    if (fresh.length === 0) return
    const parts = partitionExtractInput({ ...input, newMessages: fresh }, { maxChars: this.maxChars, contextLimit: this.opts.getConfig().recentContextLimit })
    const fail = this.chatFail.get(chatId)
    parts.forEach((part, partIndex) => {
      const id = randomUUID()
      this.entries.set(id, {
        id, chatId, chatName: input.chat.name, msgIds: part.msgIds, input: part.input, user: part.user, truncated: part.truncated,
        partIndex, partCount: parts.length, mode: 'apply', gen: this.gen, attempts: fail?.attempts ?? 0, notBefore: fail?.notBefore ?? 0,
        state: 'pending', itemId: null, leaseUntil: 0, group: null
      })
    })
  }

  endCycle(): void {
    for (const [id, e] of this.entries) if (e.mode === 'apply' && e.state === 'pending' && e.gen !== this.gen) this.entries.delete(id)
    this.announce()
  }

  /** 呼叫端要同步拿結果（reviewLastDays）：切片 → 同一個 pull/commit 通道 → 全部片段回來後合併 resolve。 */
  request(input: ChatExtractInput): Promise<ExtractResult> {
    if (this.disposed) return Promise.reject(new Error('extract queue disposed'))
    const chatId = input.chat.chatId
    const parts = partitionExtractInput(input, { maxChars: this.maxChars, contextLimit: this.opts.getConfig().recentContextLimit })
    if (parts.length === 0) return Promise.resolve({ importance: 'noise', newTodos: [], resolved: [], updates: [] })
    return new Promise<ExtractResult>((resolve, reject) => {
      const group: AwaitGroup = { resolve, reject, results: new Array(parts.length).fill(undefined), remaining: parts.length, timer: null, settled: false }
      const ids: string[] = []
      parts.forEach((part, partIndex) => {
        const id = randomUUID()
        ids.push(id)
        this.entries.set(id, {
          id, chatId, chatName: input.chat.name, msgIds: part.msgIds, input: part.input, user: part.user, truncated: part.truncated,
          partIndex, partCount: parts.length, mode: 'await', gen: -1, attempts: 0, notBefore: 0, state: 'pending', itemId: null, leaseUntil: 0, group
        })
      })
      group.timer = setTimeout(() => this.failGroup(group, new Error('extract_await_timeout')), this.opts.awaitTimeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS)
      group.timer.unref?.()
      this.announce()
    })
  }

  // ── outbox：pull ──

  pull(params: { max?: number; leaseMs?: number } = {}): PullResult {
    this.reap()
    const now = this.now()
    const maxItems = Math.min(Math.max(1, Math.floor(params.max ?? this.opts.maxItemsPerPull ?? DEFAULT_MAX_ITEMS_PER_PULL)), 16)
    const leaseMs = Math.min(Math.max(1000, params.leaseMs ?? this.opts.leaseMs ?? DEFAULT_LEASE_MS), 10 * 60_000)
    const budget = this.opts.pullBudgetBytes ?? DEFAULT_PULL_BUDGET_BYTES
    const busyChats = new Set<string>()
    for (const e of this.entries.values()) if (e.state === 'leased') busyChats.add(e.chatId)
    const items: PullItem[] = []
    let bytes = 0
    let soonest: number | null = null
    for (const e of this.entries.values()) {
      if (e.state !== 'pending') continue
      if (e.notBefore > now) { soonest = soonest === null ? e.notBefore : Math.min(soonest, e.notBefore); continue }
      if (busyChats.has(e.chatId)) continue // 同一個 chat 一次只領一片，後面的片段等前一片回來
      const item: PullItem = {
        itemId: randomUUID(), chatId: e.chatId, chatName: e.chatName, user: e.user, userChars: e.user.length, messageCount: e.msgIds.length,
        attempts: e.attempts, part: e.partIndex + 1, parts: e.partCount, truncatedMessages: e.truncated
      }
      const size = Buffer.byteLength(JSON.stringify(item))
      if (items.length > 0 && bytes + size > budget) break
      e.state = 'leased'
      e.itemId = item.itemId
      e.leaseUntil = now + leaseMs
      busyChats.add(e.chatId)
      bytes += size
      items.push(item)
      try { e.input.onCorrectionsPayloadBuilt?.() } catch { /* 稽核 hook 失敗不影響供料 */ }
      if (items.length >= maxItems) break
    }
    return {
      ok: true, items, pending: this.countState('pending'), leased: this.countState('leased'), systemSha256: EXTRACT_SYSTEM_SHA256,
      maxUserChars: this.maxChars, retryAfterMs: items.length === 0 && soonest !== null ? Math.max(0, soonest - now) : null
    }
  }

  // ── inbox：commit ──

  commit(params: { results: CommitRequestItem[] }): CommitResult {
    this.reap()
    const out: CommitItemResult[] = []
    const tally: ApplyTally & { chatsProcessed: number; chatsFailed: number } = {
      todosCreated: 0, todosMerged: 0, todosResolvedDone: 0, todosSuggestedDone: 0, createdIds: [], resolvedIds: [], updatedIds: [], chatsProcessed: 0, chatsFailed: 0
    }
    let runId: string | null = null
    const leased = new Map<string, Entry>()
    for (const e of this.entries.values()) if (e.state === 'leased' && e.itemId) leased.set(e.itemId, e)

    for (const item of params.results) {
      const itemId = typeof item?.itemId === 'string' ? item.itemId : ''
      if (!itemId || typeof item.ok !== 'boolean') { out.push({ itemId, status: 'bad_request', code: 'invalid_commit_item' }); continue }
      const entry = leased.get(itemId)
      if (!entry) { out.push({ itemId, status: 'unknown_item', code: 'lease_expired_or_unknown' }); continue }
      leased.delete(itemId)

      if (!item.ok) {
        const code = typeof item.failCode === 'string' && /^[a-z0-9_]{1,48}$/.test(item.failCode) ? item.failCode : 'ai_failed'
        const retryInMs = this.recordFailure(entry, code, item.retryAfterMs)
        tally.chatsFailed += 1
        out.push({ itemId, status: 'failed_recorded', chatId: entry.chatId, code, retryInMs })
        continue
      }

      let extract: ExtractResult
      try {
        extract = validateExtractResult(item.result)
      } catch (error) {
        const retryInMs = this.recordFailure(entry, 'invalid_result')
        tally.chatsFailed += 1
        out.push({ itemId, status: 'rejected', chatId: entry.chatId, code: 'invalid_result', issues: issuesOf(error), retryInMs })
        continue
      }

      if (entry.mode === 'await') {
        const group = entry.group!
        this.entries.delete(entry.id)
        if (!group.settled) {
          group.results[entry.partIndex] = extract
          group.remaining -= 1
          if (group.remaining === 0) this.settleGroup(group, mergeResults(group.results as ExtractResult[]))
        }
        out.push({ itemId, status: 'accepted', chatId: entry.chatId })
        continue
      }

      try {
        runId ??= startRun(this.opts.db)
        const local: ApplyTally = { todosCreated: 0, todosMerged: 0, todosResolvedDone: 0, todosSuggestedDone: 0, createdIds: [], resolvedIds: [], updatedIds: [] }
        applyChatExtract({ db: this.opts.db, cfg: this.opts.getConfig(), now: new Date(this.now()).toISOString() }, entry.chatId, entry.msgIds, extract, local)
        tally.todosCreated += local.todosCreated
        tally.todosMerged += local.todosMerged
        tally.todosResolvedDone += local.todosResolvedDone
        tally.todosSuggestedDone += local.todosSuggestedDone
        tally.createdIds.push(...local.createdIds)
        tally.resolvedIds.push(...local.resolvedIds)
        tally.updatedIds.push(...local.updatedIds)
        tally.chatsProcessed += 1
        this.entries.delete(entry.id)
        // 這個 chat 已經有一片成功 → 清掉失敗記憶（後面的片段不再被退避）。
        this.chatFail.delete(entry.chatId)
        out.push({ itemId, status: 'applied', chatId: entry.chatId, createdIds: local.createdIds, resolvedIds: local.resolvedIds, updatedIds: local.updatedIds })
      } catch (error) {
        const retryInMs = this.recordFailure(entry, 'apply_failed')
        tally.chatsFailed += 1
        out.push({ itemId, status: 'apply_failed', chatId: entry.chatId, code: 'apply_failed', issues: [error instanceof Error ? error.message.slice(0, 200) : 'unknown'], retryInMs })
      }
    }

    let run: CommitResult['run'] = null
    if (runId) {
      const llmStatus: RunOnceResult['llmStatus'] = tally.chatsFailed > 0 && tally.chatsProcessed > 0 ? 'partial' : tally.chatsFailed > 0 ? 'error' : 'ok'
      const result: RunOnceResult = {
        runId, lineBridge: 'ok', llmStatus, newMsgs: 0, chatsSeen: tally.chatsProcessed + tally.chatsFailed, chatsProcessed: tally.chatsProcessed,
        chatsSkippedNoise: 0, chatsSkipped: 0, chatsFailed: tally.chatsFailed, todosCreated: tally.todosCreated, todosMerged: tally.todosMerged,
        todosResolvedDone: tally.todosResolvedDone, todosSuggestedDone: tally.todosSuggestedDone, createdIds: tally.createdIds,
        resolvedIds: tally.resolvedIds, updatedIds: tally.updatedIds, note: null
      }
      try {
        finishRun(runId, { newMsgs: 0, chatsSeen: result.chatsSeen, todosCreated: result.todosCreated, todosResolved: result.resolvedIds.length, lineBridge: 'ok', llmStatus, note: null }, this.opts.db)
      } catch { /* 收尾記錄失敗不影響已落庫的結果 */ }
      try { this.opts.onRun?.(result) } catch { /* 事件推送失敗不影響落庫 */ }
      run = { runId, todosCreated: result.todosCreated, todosMerged: result.todosMerged, resolved: result.resolvedIds.length, updated: result.updatedIds.length, chatsFailed: result.chatsFailed }
    }
    this.announce()
    return { ok: true, results: out, run, pending: this.countState('pending') }
  }

  // ── 觀測 ──

  stats(): { pending: number; leased: number; awaiting: number; chatsBackingOff: number; gen: number } {
    const now = this.now()
    let awaiting = 0
    for (const e of this.entries.values()) if (e.mode === 'await') awaiting += 1
    let backing = 0
    for (const f of this.chatFail.values()) if (f.notBefore > now) backing += 1
    return { pending: this.countState('pending'), leased: this.countState('leased'), awaiting, chatsBackingOff: backing, gen: this.gen }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const e of this.entries.values()) if (e.group && !e.group.settled) this.failGroup(e.group, new Error('extract queue disposed'))
    this.entries.clear()
    this.chatFail.clear()
  }

  // ── 內部 ──

  private countState(state: Entry['state']): number {
    let n = 0
    for (const e of this.entries.values()) if (e.state === state) n += 1
    return n
  }

  /** 租約逾時的項目回到可領取（UI 掛了或看板被隱藏）。 */
  private reap(): void {
    const now = this.now()
    for (const e of this.entries.values()) {
      if (e.state === 'leased' && e.leaseUntil <= now) {
        e.state = 'pending'
        e.itemId = null
        e.leaseUntil = 0
        e.attempts += 1
      }
    }
  }

  private recordFailure(entry: Entry, code: string, retryAfterMs?: number): number {
    const now = this.now()
    if (entry.mode === 'await') {
      // 同步呼叫端（回顧）沿用 extractFn throw 語意：整個 chat 失敗，不在佇列內重試。
      this.entries.delete(entry.id)
      if (entry.group) this.failGroup(entry.group, new Error(code))
      return 0
    }
    const prev = this.chatFail.get(entry.chatId)
    const attempts = (prev?.attempts ?? entry.attempts) + 1
    const base = this.opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS
    const max = this.opts.retryMaxMs ?? DEFAULT_RETRY_MAX_MS
    const hinted = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.min(retryAfterMs, max) : 0
    const delay = Math.max(hinted, Math.min(base * 2 ** (attempts - 1), max))
    const notBefore = now + delay
    this.chatFail.set(entry.chatId, { attempts, notBefore })
    // 同一 chat 的所有待領片段都跟著退避。
    for (const e of this.entries.values()) if (e.chatId === entry.chatId && e.mode === 'apply') { e.attempts = attempts; e.notBefore = notBefore }
    entry.state = 'pending'
    entry.itemId = null
    entry.leaseUntil = 0
    return delay
  }

  private settleGroup(group: AwaitGroup, value: ExtractResult): void {
    if (group.settled) return
    group.settled = true
    if (group.timer) clearTimeout(group.timer)
    group.resolve(value)
  }

  private failGroup(group: AwaitGroup, error: Error): void {
    if (group.settled) return
    group.settled = true
    if (group.timer) clearTimeout(group.timer)
    for (const [id, e] of this.entries) if (e.group === group) this.entries.delete(id)
    group.reject(error)
    this.announce()
  }

  /** 可領項目集合變了才通知（每個 cycle 重新供料同樣的內容不會洗版）。 */
  private announce(): void {
    if (this.disposed) return
    const now = this.now()
    const ids: string[] = []
    for (const e of this.entries.values()) if (e.state === 'pending' && e.notBefore <= now) ids.push(`${e.chatId}:${e.msgIds[0]}:${e.msgIds.length}:${e.mode}`)
    const key = ids.sort().join('|')
    if (key === this.lastPendingKey) return
    this.lastPendingKey = key
    if (ids.length > 0) { try { this.opts.onPending?.({ pending: ids.length }) } catch { /* 通知失敗不影響佇列 */ } }
  }
}
