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
