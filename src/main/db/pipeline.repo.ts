import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { getDb } from './database'

/**
 * pipeline.repo — 每輪 pipeline 執行記錄（pipeline_runs，IMPLEMENTATION_PLAN.md §4 / §8）。
 * 可觀測 / 除錯：每輪開一筆（started_at），收尾補 counts 與狀態。
 */

export type LineBridge = 'ok' | 'error' | 'skipped'
export type LlmStatus = 'ok' | 'partial' | 'error'

export interface PipelineRunDTO {
  id: string
  startedAt: string
  finishedAt: string | null
  newMsgs: number
  chatsSeen: number
  todosCreated: number
  todosResolved: number
  lineBridge: LineBridge
  llmStatus: LlmStatus
  note: string | null
}

interface PipelineRunRow {
  id: string
  started_at: string
  finished_at: string | null
  new_msgs: number
  chats_seen: number
  todos_created: number
  todos_resolved: number
  line_bridge: LineBridge
  llm_status: LlmStatus
  note: string | null
}

function rowToDTO(r: PipelineRunRow): PipelineRunDTO {
  return {
    id: r.id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    newMsgs: r.new_msgs,
    chatsSeen: r.chats_seen,
    todosCreated: r.todos_created,
    todosResolved: r.todos_resolved,
    lineBridge: r.line_bridge,
    llmStatus: r.llm_status,
    note: r.note
  }
}

/** 開一筆 run（started_at = now）。回傳 id。 */
export function startRun(db: Database = getDb()): string {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO pipeline_runs (id, started_at, line_bridge, llm_status)
     VALUES (?, ?, 'ok', 'ok')`
  ).run(id, new Date().toISOString())
  return id
}

export interface FinishRunInput {
  newMsgs?: number
  chatsSeen?: number
  todosCreated?: number
  todosResolved?: number
  lineBridge?: LineBridge
  llmStatus?: LlmStatus
  note?: string | null
}

/** 收尾一筆 run（finished_at = now + counts/狀態）。回傳更新後 DTO。 */
export function finishRun(
  id: string,
  input: FinishRunInput,
  db: Database = getDb()
): PipelineRunDTO | null {
  db.prepare(
    `UPDATE pipeline_runs SET
       finished_at    = @finishedAt,
       new_msgs       = @newMsgs,
       chats_seen     = @chatsSeen,
       todos_created  = @todosCreated,
       todos_resolved = @todosResolved,
       line_bridge    = @lineBridge,
       llm_status     = @llmStatus,
       note           = @note
     WHERE id = @id`
  ).run({
    id,
    finishedAt: new Date().toISOString(),
    newMsgs: input.newMsgs ?? 0,
    chatsSeen: input.chatsSeen ?? 0,
    todosCreated: input.todosCreated ?? 0,
    todosResolved: input.todosResolved ?? 0,
    lineBridge: input.lineBridge ?? 'ok',
    llmStatus: input.llmStatus ?? 'ok',
    note: input.note ?? null
  })
  return getRun(id, db)
}

export function getRun(id: string, db: Database = getDb()): PipelineRunDTO | null {
  const row = db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(id) as
    | PipelineRunRow
    | undefined
  return row ? rowToDTO(row) : null
}

/** 最近一筆 run（pipeline:status 用）。 */
export function getLastRun(db: Database = getDb()): PipelineRunDTO | null {
  const row = db
    .prepare('SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT 1')
    .get() as PipelineRunRow | undefined
  return row ? rowToDTO(row) : null
}

/** `chats_seen` 的歷史分佈（設定頁延遲試算的預設值來源）。 */
export interface ChatsSeenStats {
  /** 取樣到的輪數（母體大小）。< 20 時不足以估算，呼叫端應退回保守預設。 */
  sampleRuns: number
  chatsSeenP50: number
  chatsSeenP90: number
  /** 歷來（不限取樣視窗）單輪最多處理過的聊天室數；反映開機自我對帳的一次性尖峰。 */
  chatsSeenMax: number
}

/** 最近幾輪納入分位數統計。 */
export const CHATS_SEEN_SAMPLE_RUNS = 200

/** nearest-rank 分位數（sorted 需已由小到大）。 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx]
}

/**
 * 每輪實際處理的聊天室數（`chats_seen`）分佈。
 *
 * **只取 `llm_status = 'ok'` 的輪次**：抽取失敗的訊息刻意不標 `processed`，
 * 下一輪會再看到同一批，所以 provider 持續失敗時 `chats_seen` 會爬成一個假高原
 * （本機實測 32–35），拿它當「正常負載」會又一次高估。成功輪次才是穩態負載。
 *
 * `chatsSeenMax` 刻意不受取樣視窗限制：它要代表的是「開機自我對帳那種一次性尖峰」，
 * 而那種輪次本來就稀有，落在最近 200 輪裡的機率很低。
 */
export function getChatsSeenStats(
  sampleRuns = CHATS_SEEN_SAMPLE_RUNS,
  db: Database = getDb()
): ChatsSeenStats {
  const n = Math.min(Math.max(sampleRuns, 1), 5000)
  const rows = db
    .prepare(
      `SELECT chats_seen FROM pipeline_runs
       WHERE llm_status = 'ok' AND finished_at IS NOT NULL
       ORDER BY started_at DESC
       LIMIT ?`
    )
    .all(n) as { chats_seen: number }[]
  const sorted = rows.map((r) => r.chats_seen).sort((a, b) => a - b)
  const maxRow = db
    .prepare(
      `SELECT MAX(chats_seen) AS n FROM pipeline_runs
       WHERE llm_status = 'ok' AND finished_at IS NOT NULL`
    )
    .get() as { n: number | null } | undefined
  return {
    sampleRuns: sorted.length,
    chatsSeenP50: percentile(sorted, 0.5),
    chatsSeenP90: percentile(sorted, 0.9),
    chatsSeenMax: maxRow?.n ?? 0
  }
}
