import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { getDb } from './database'
import type { TodoDTO } from './dto'

/**
 * todos.repo — 代辦 CRUD + 狀態轉移 + 取某 chat 未完成 todo（餵 LLM 去重）。
 *
 * 本輪（DB 持久化）提供基礎能力；看板 UI / LLM 抽取在 M2/M3 串接。
 * source_msg_ids 在 DB 是 JSON 字串，repo 對外用 string[]。
 */

interface TodoRow {
  id: string
  chat_id: string
  bucket: TodoDTO['bucket']
  status: TodoDTO['status']
  title: string
  detail: string | null
  priority: number
  due_at: string | null
  source_msg_ids: string
  confidence: number
  completion_evidence: string | null
  created_at: string
  updated_at: string
  resolved_at: string | null
}

function rowToDTO(r: TodoRow): TodoDTO {
  let sourceMsgIds: string[] = []
  try {
    const parsed = JSON.parse(r.source_msg_ids)
    if (Array.isArray(parsed)) sourceMsgIds = parsed.map(String)
  } catch {
    /* 落庫保證是 JSON 陣列；解析失敗就給空陣列，不讓查詢整個炸掉 */
  }
  return {
    id: r.id,
    chatId: r.chat_id,
    bucket: r.bucket,
    status: r.status,
    title: r.title,
    detail: r.detail,
    priority: r.priority,
    dueAt: r.due_at,
    sourceMsgIds,
    confidence: r.confidence,
    completionEvidence: r.completion_evidence,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolvedAt: r.resolved_at
  }
}

/** status 是否為「已結案」（resolved_at 該被填）。 */
const TERMINAL_STATUSES = new Set<TodoDTO['status']>(['done', 'dismissed'])

export interface CreateTodoInput {
  chatId: string
  bucket: TodoDTO['bucket']
  title: string
  status?: TodoDTO['status']
  detail?: string | null
  priority?: number
  dueAt?: string | null
  sourceMsgIds?: string[]
  confidence?: number
  completionEvidence?: string | null
}

/** 建立一筆 todo（id 由 App 產生 uuid）。回傳建立後的 DTO。 */
export function createTodo(input: CreateTodoInput, db: Database = getDb()): TodoDTO {
  const now = new Date().toISOString()
  const id = randomUUID()
  const status = input.status ?? 'pending'
  db.prepare(
    `INSERT INTO todos
       (id, chat_id, bucket, status, title, detail, priority, due_at,
        source_msg_ids, confidence, completion_evidence, created_at, updated_at, resolved_at)
     VALUES
       (@id, @chatId, @bucket, @status, @title, @detail, @priority, @dueAt,
        @sourceMsgIds, @confidence, @completionEvidence, @now, @now,
        @resolvedAt)`
  ).run({
    id,
    chatId: input.chatId,
    bucket: input.bucket,
    status,
    title: input.title,
    detail: input.detail ?? null,
    priority: input.priority ?? 2,
    dueAt: input.dueAt ?? null,
    sourceMsgIds: JSON.stringify(input.sourceMsgIds ?? []),
    confidence: input.confidence ?? 0.5,
    completionEvidence: input.completionEvidence ?? null,
    now,
    resolvedAt: TERMINAL_STATUSES.has(status) ? now : null
  })
  return getTodo(id, db) as TodoDTO
}

/** 取單筆（查無回 null）。 */
export function getTodo(id: string, db: Database = getDb()): TodoDTO | null {
  const row = db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as
    | TodoRow
    | undefined
  return row ? rowToDTO(row) : null
}

export interface ListTodosQuery {
  statuses?: TodoDTO['status'][]
  buckets?: TodoDTO['bucket'][]
  chatId?: string
  sortBy?: TodoSortBy
  sortDirection?: TodoSortDirection
}

export type TodoSortBy = 'updatedAt' | 'createdAt' | 'dueAt' | 'priority'
export type TodoSortDirection = 'asc' | 'desc'

const TODO_SORT_COLUMNS: Record<TodoSortBy, string> = {
  updatedAt: 'updated_at',
  createdAt: 'created_at',
  dueAt: 'due_at',
  priority: 'priority'
}

const TODO_SORT_DIRECTIONS: Record<TodoSortDirection, string> = {
  asc: 'ASC',
  desc: 'DESC'
}

/**
 * 列代辦（看板）。預設排除 dismissed。
 * 依 priority 升冪（高優先在前）、再 updated_at 由新到舊。
 */
export function listTodos(
  query: ListTodosQuery = {},
  db: Database = getDb()
): TodoDTO[] {
  const conds: string[] = []
  const params: unknown[] = []

  if (query.statuses && query.statuses.length) {
    conds.push(`status IN (${query.statuses.map(() => '?').join(',')})`)
    params.push(...query.statuses)
  } else {
    conds.push(`status != 'dismissed'`)
  }
  if (query.buckets && query.buckets.length) {
    conds.push(`bucket IN (${query.buckets.map(() => '?').join(',')})`)
    params.push(...query.buckets)
  }
  if (query.chatId) {
    conds.push('chat_id = ?')
    params.push(query.chatId)
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const orderBy = buildListTodosOrderBy(query)
  const rows = db
    .prepare(`SELECT * FROM todos ${where} ${orderBy}`)
    .all(...params) as TodoRow[]
  return rows.map(rowToDTO)
}

function buildListTodosOrderBy(query: ListTodosQuery): string {
  if (!query.sortBy) return 'ORDER BY priority ASC, updated_at DESC'

  const column = TODO_SORT_COLUMNS[query.sortBy]
  const direction = TODO_SORT_DIRECTIONS[query.sortDirection ?? 'desc']
  if (!column || !direction) return 'ORDER BY priority ASC, updated_at DESC'

  if (query.sortBy === 'dueAt') {
    return `ORDER BY due_at IS NULL ASC, ${column} ${direction}, priority ASC, updated_at DESC`
  }
  if (query.sortBy === 'priority') {
    return `ORDER BY ${column} ${direction}, updated_at DESC, created_at DESC`
  }
  return `ORDER BY ${column} ${direction}, priority ASC, id ASC`
}

/** 該 chat 目前「未完成」代辦（餵 LLM 去重 / 完成偵測用，IMPLEMENTATION_PLAN §6.5）。 */
export function getOpenTodosByChat(chatId: string, db: Database = getDb()): TodoDTO[] {
  const rows = db
    .prepare(
      `SELECT * FROM todos
       WHERE chat_id = ?
         AND status IN ('pending','waiting_reply','scheduled','suggested_done')
       ORDER BY priority ASC, updated_at DESC`
    )
    .all(chatId) as TodoRow[]
  return rows.map(rowToDTO)
}

/**
 * 把某 chat 目前「未完成」的代辦整批設為 dismissed（忽略）。
 * - 不帶 keyword：整個對話的未完成代辦全部 dismissed（封鎖對話時清空看板用）。
 * - 帶 keyword（已小寫）：只 dismissed 標題 / 備註含該關鍵字者（依關鍵字忽略時用）。
 * 回傳實際異動筆數。
 */
export function dismissOpenTodosByChat(
  chatId: string,
  keyword?: string,
  db: Database = getDb()
): number {
  const now = new Date().toISOString()
  const params: Record<string, unknown> = { chatId, now }
  let sql =
    `UPDATE todos SET status = 'dismissed', updated_at = @now, resolved_at = @now
     WHERE chat_id = @chatId
       AND status IN ('pending','waiting_reply','scheduled','suggested_done')`
  const kw = keyword?.trim().toLowerCase()
  if (kw) {
    sql += ` AND (lower(title) LIKE @kw OR lower(IFNULL(detail, '')) LIKE @kw)`
    params.kw = `%${kw}%`
  }
  return db.prepare(sql).run(params).changes
}

/** 狀態轉移。進入 done/dismissed 會填 resolved_at；離開則清掉。回傳更新後 DTO（查無回 null）。 */
export function updateStatus(
  id: string,
  status: TodoDTO['status'],
  db: Database = getDb()
): TodoDTO | null {
  const now = new Date().toISOString()
  const resolvedAt = TERMINAL_STATUSES.has(status) ? now : null
  const info = db
    .prepare(
      `UPDATE todos SET status = ?, updated_at = ?,
         resolved_at = CASE WHEN ? IN ('done','dismissed') THEN ? ELSE NULL END
       WHERE id = ?`
    )
    .run(status, now, status, resolvedAt, id)
  if (info.changes === 0) return null
  return getTodo(id, db)
}

export interface UpdateTodoPatch {
  title?: string
  detail?: string | null
  priority?: number
  dueAt?: string | null
  bucket?: TodoDTO['bucket']
  sourceMsgIds?: string[]
}

/** 編輯欄位（手動改 bucket/標題等）。只更新有給的欄位。回傳更新後 DTO（查無回 null）。 */
export function updateTodo(
  id: string,
  patch: UpdateTodoPatch,
  db: Database = getDb()
): TodoDTO | null {
  const sets: string[] = []
  const params: Record<string, unknown> = { id }
  if (patch.title !== undefined) {
    sets.push('title = @title')
    params.title = patch.title
  }
  if (patch.detail !== undefined) {
    sets.push('detail = @detail')
    params.detail = patch.detail
  }
  if (patch.priority !== undefined) {
    sets.push('priority = @priority')
    params.priority = patch.priority
  }
  if (patch.dueAt !== undefined) {
    sets.push('due_at = @dueAt')
    params.dueAt = patch.dueAt
  }
  if (patch.bucket !== undefined) {
    sets.push('bucket = @bucket')
    params.bucket = patch.bucket
    // RC3：手動把 bucket 搬到 'schedule' 時，連動把「非 terminal 且非 scheduled」的 status
    // 升為 'scheduled'，避免手動搬移後 bucket/status 語意漂移（僅此一條連動）。
    if (patch.bucket === 'schedule') {
      const cur = getTodo(id, db)
      if (cur && !TERMINAL_STATUSES.has(cur.status) && cur.status !== 'scheduled') {
        sets.push(`status = 'scheduled'`)
      }
    }
  }
  if (patch.sourceMsgIds !== undefined) {
    sets.push('source_msg_ids = @sourceMsgIds')
    params.sourceMsgIds = JSON.stringify(patch.sourceMsgIds)
  }
  if (sets.length === 0) return getTodo(id, db)

  sets.push('updated_at = @updatedAt')
  params.updatedAt = new Date().toISOString()

  const info = db
    .prepare(`UPDATE todos SET ${sets.join(', ')} WHERE id = @id`)
    .run(params)
  if (info.changes === 0) return null
  return getTodo(id, db)
}

export interface ReclassifyTodoPatch {
  bucket: TodoDTO['bucket']
  dueAt?: string | null
}

/**
 * 重新分類（升級/搬移）的 DB 原子操作：事件型代辦時間確定後 → 行程，或在 bucket 間互搬。
 *   - 早退：todo 不存在或 status 為 terminal（done/dismissed）→ 不動作，回 0。
 *   - F5（status 依 bucket 全向同步，避免反向漂移）：算 desiredStatus——
 *     現 status 為 'suggested_done' 則保留（不動建議完成狀態）；否則依新 bucket 取
 *     canonical active status：todo→'pending'、waiting→'waiting_reply'、schedule→'scheduled'。
 *   - F4（dueAt=null 不可抹掉既有 due_at）：只有給「具體值」（patch.dueAt != null）才覆寫；
 *     null/undefined 都保留現值。
 *   - F1（idempotent no-op guard）：bucket / status / due_at 三者皆與目標一致 → 不發 UPDATE、回 0，
 *     避免重寫 updated_at 造成上游每輪 emit / 看板抖動。
 *   - 否則發 UPDATE 設 bucket / status / due_at / updated_at。
 * 回傳實際異動筆數（早退或 no-op 回 0）。
 */
export function reclassifyTodo(
  id: string,
  patch: ReclassifyTodoPatch,
  db: Database = getDb()
): number {
  const cur = getTodo(id, db)
  if (!cur || TERMINAL_STATUSES.has(cur.status)) return 0

  // F5：bucket → canonical active status（全向同步）。
  const BUCKET_ACTIVE_STATUS: Record<TodoDTO['bucket'], TodoDTO['status']> = {
    todo: 'pending',
    waiting: 'waiting_reply',
    schedule: 'scheduled'
  }
  const desiredStatus: TodoDTO['status'] =
    cur.status === 'suggested_done'
      ? cur.status
      : BUCKET_ACTIVE_STATUS[patch.bucket]

  // F4：dueAt=null/undefined 都保留現值，只有具體值才覆寫。
  const newDueAt = patch.dueAt != null ? patch.dueAt : cur.dueAt

  // F1：三者皆已是目標值就不落庫，避免重寫 updated_at 觸發上游每輪 emit。
  if (
    cur.bucket === patch.bucket &&
    cur.status === desiredStatus &&
    cur.dueAt === newDueAt
  ) {
    return 0
  }

  return db
    .prepare(
      `UPDATE todos
         SET bucket = @bucket, status = @status, due_at = @dueAt, updated_at = @updatedAt
       WHERE id = @id`
    )
    .run({
      id,
      bucket: patch.bucket,
      status: desiredStatus,
      dueAt: newDueAt,
      updatedAt: new Date().toISOString()
    }).changes
}

/** 看板四欄（repo 不可 import renderer 的 buckets.ts，故在此自定）。 */
export type TodoColumn = TodoDTO['bucket'] | 'done'

/**
 * 看板拖曳「手動搬移」的 DB 原子操作（使用者權威；非 qwen 自動路徑，故與 reclassifyTodo 分立）。
 *   - 早退：todo 不存在 → 回 null。
 *   - active 欄(todo/waiting/schedule)：bucket=該欄、status=canonical active
 *     （todo→pending / waiting→waiting_reply / schedule→scheduled）、resolved_at=NULL
 *     （不論原 status；涵蓋否決 suggested_done、取消 done）。
 *   - done 欄：status='done'、resolved_at= 已 done 則保留現值 否則 now、bucket 維持現值。
 *   - 冪等 no-op：目標 (bucket,status,resolved_at) 三元組與現值全等 → 不發 UPDATE、
 *     回現值 DTO（防抖，避免重寫 updated_at）。
 * 回傳更新後 DTO；no-op 回現值 DTO；查無回 null。
 */
export function moveTodoToColumn(
  id: string,
  toColumn: TodoColumn,
  db: Database = getDb()
): TodoDTO | null {
  const cur = getTodo(id, db)
  if (!cur) return null

  const now = new Date().toISOString()

  // canonical active 對照（本地定義；不抽共用常數、不動 reclassifyTodo）。
  const CANON_ACTIVE: Record<TodoDTO['bucket'], TodoDTO['status']> = {
    todo: 'pending',
    waiting: 'waiting_reply',
    schedule: 'scheduled'
  }

  let bucket: TodoDTO['bucket']
  let status: TodoDTO['status']
  let resolvedAt: string | null
  if (toColumn === 'done') {
    bucket = cur.bucket
    status = 'done'
    resolvedAt = cur.status === 'done' ? cur.resolvedAt : now
  } else {
    bucket = toColumn
    status = CANON_ACTIVE[toColumn]
    resolvedAt = null
  }

  // 冪等 no-op：三元組全等現值 → 不落庫、回現值 DTO（防抖，勿重寫 updated_at）。
  if (cur.bucket === bucket && cur.status === status && cur.resolvedAt === resolvedAt) {
    return cur
  }

  const info = db
    .prepare(
      `UPDATE todos
         SET bucket = @bucket, status = @status, resolved_at = @resolvedAt, updated_at = @now
       WHERE id = @id`
    )
    .run({ id, bucket, status, resolvedAt, now })
  return info.changes === 0 ? null : getTodo(id, db)
}

/**
 * 把新來源訊息併進既有 todo 的 source_msg_ids（去重聯集），並更新 updated_at。
 * App 端近似去重命中既有 todo 時用（§6.5 第 3 點）：更新而非新增。
 * 回傳更新後 DTO（查無回 null）。
 */
export function mergeSources(
  id: string,
  newSourceMsgIds: string[],
  db: Database = getDb()
): TodoDTO | null {
  const cur = getTodo(id, db)
  if (!cur) return null
  const union = Array.from(new Set([...cur.sourceMsgIds, ...newSourceMsgIds]))
  const info = db
    .prepare(
      'UPDATE todos SET source_msg_ids = ?, updated_at = ? WHERE id = ?'
    )
    .run(JSON.stringify(union), new Date().toISOString(), id)
  if (info.changes === 0) return null
  return getTodo(id, db)
}

/**
 * 完成偵測落地（§6.6）：把某 todo 標完成（或建議完成），寫入 completion_evidence。
 *   - toDone=true  → status='done'、resolved_at=now
 *   - toDone=false → status='suggested_done'（不填 resolved_at）
 * 回傳更新後 DTO（查無回 null）。
 */
export function resolveTodo(
  id: string,
  evidence: string,
  toDone: boolean,
  db: Database = getDb()
): TodoDTO | null {
  const now = new Date().toISOString()
  const status: TodoDTO['status'] = toDone ? 'done' : 'suggested_done'
  const resolvedAt = toDone ? now : null
  const info = db
    .prepare(
      `UPDATE todos
         SET status = ?, completion_evidence = ?, updated_at = ?, resolved_at = ?
       WHERE id = ?`
    )
    .run(status, evidence, now, resolvedAt, id)
  if (info.changes === 0) return null
  return getTodo(id, db)
}

/** 計數（evidence / 測試用）。 */
export function countTodos(db: Database = getDb()): number {
  const r = db.prepare('SELECT COUNT(*) AS n FROM todos').get() as { n: number }
  return r.n
}
