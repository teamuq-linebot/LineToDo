/**
 * teamuqTask.ts — 外掛 AI 對話要掛在哪個 TeamUQ Task 上（0.2.1）。
 *
 * TeamUQ 每一輪 `host.ai.complete` 都會開一個 Session。沒帶 `taskId` 時，Core 會臨時建一個「系統對話 · host.ai」Task，用完就刪掉，
 * 留下的 Session 在 TeamUQ 的對話看板上變成「Task 關聯待確認」。所以外掛自己建一般的 Project「LINE 待辦」與 Task「AI 整理 LINE 訊息」
 * （Program API `data.projects.create`／`data.tasks.create`，manifest 宣告 `program:data:projects:write`、`program:data:tasks:write`），
 * 每一輪都帶這個 `taskId`；對話就照一般途徑歸在這個 Task 底下。
 *
 *   - id 存在 dataDir 的 `teamuq-task.json`，重新啟動後沿用；
 *   - 使用者在 TeamUQ 刪掉這個 Task：host 回 `task_not_found`，呼叫端 `forget(taskId)` 後下一次重建（Project 還在就沿用）；
 *     建 Task 時 Project 也不在了（`not_found`），就連 Project 一起重建；
 *   - 建不起來（舊 Core 沒有 `context.host.program`、使用者沒允許這兩個權限、Core 暫時不可用）：回 null，這一輪照舊不帶 `taskId`，
 *     `retryMs` 之後再試，AI 功能不受影響。
 *
 * 不 import electron、不做網路 I/O；時間是注入的。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { PluginProgramApiV1 } from '@teamuq/plugin-sdk'

export const TEAMUQ_PROJECT_NAME = 'LINE 待辦'
export const TEAMUQ_TASK_NAME = 'AI 整理 LINE 訊息'
export const TEAMUQ_TASK_DESCRIPTION = 'LINE 待辦外掛在背景用 TeamUQ 的 AI 整理 LINE 訊息（抽取待辦、草擬回覆、分析）；每一輪 AI 對話都歸在這個 Task。'

export interface TeamuqTaskBinding {
  /** 這一輪要帶的 `taskId`；null＝建不起來，這一輪不帶。 */
  resolve(): Promise<string | null>
  /** host 說這個 Task 不在了（`task_not_found`）：忘掉它，下一次 `resolve` 重建。 */
  forget(taskId: string): void
}

export interface TeamuqTaskBindingOptions {
  /** `context.host.program`；舊 Core 沒有＝永遠回 null。 */
  program?: Pick<PluginProgramApiV1, 'call'>
  /** 存 id 的檔案；null＝只放記憶體（測試）。 */
  file: string | null
  now?(): number
  /** 建不起來之後多久再試。 */
  retryMs?: number
  /** 診斷輸出；不含訊息內容。 */
  log?: (event: string, detail?: Record<string, unknown>) => void
}

interface Stored { projectId: string | null; taskId: string | null }

class ProgramError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.code = code }
}

const ID_PATTERN = /^[1-9][0-9]{0,18}$/
const idOf = (value: unknown): string | null => (typeof value === 'string' && ID_PATTERN.test(value) ? value : null)

export function createTeamuqTaskBinding(options: TeamuqTaskBindingOptions): TeamuqTaskBinding {
  const now = options.now ?? Date.now
  const retryMs = options.retryMs ?? 60_000
  const log = (event: string, detail?: Record<string, unknown>): void => { try { options.log?.(event, detail) } catch { /* 診斷失敗不影響流程 */ } }

  const load = (): Stored => {
    if (options.file === null || !existsSync(options.file)) return { projectId: null, taskId: null }
    try {
      const parsed = JSON.parse(readFileSync(options.file, 'utf8')) as Partial<Stored>
      return { projectId: idOf(parsed.projectId), taskId: idOf(parsed.taskId) }
    } catch { return { projectId: null, taskId: null } }
  }
  const save = (): void => {
    if (options.file === null) return
    try {
      const tmp = `${options.file}.tmp`
      writeFileSync(tmp, JSON.stringify(stored))
      renameSync(tmp, options.file)
    } catch (error) { log('save failed', { error: error instanceof Error ? error.name : typeof error }) }
  }

  const stored = load()
  let retryAt = 0
  let inFlight: Promise<string | null> | null = null

  const createdId = (reply: Readonly<{ ok: true; result: { id: string } }> | Readonly<{ ok: false; error: { code: string } }>): string => {
    if (!reply.ok) throw new ProgramError(reply.error.code)
    const id = idOf(reply.result.id)
    if (id === null) throw new ProgramError('invalid_reply')
    return id
  }

  const createProject = async (): Promise<string> => {
    stored.projectId = createdId(await options.program!.call('data.projects.create', { name: TEAMUQ_PROJECT_NAME }))
    save()
    log('project created')
    return stored.projectId
  }

  const createTask = async (projectId: string): Promise<string> =>
    createdId(await options.program!.call('data.tasks.create', { name: TEAMUQ_TASK_NAME, description: TEAMUQ_TASK_DESCRIPTION, projectId }))

  const ensure = async (): Promise<string | null> => {
    try {
      let projectId = stored.projectId ?? await createProject()
      let taskId: string
      try { taskId = await createTask(projectId) } catch (error) {
        if (!(error instanceof ProgramError) || error.code !== 'not_found') throw error
        projectId = await createProject()
        taskId = await createTask(projectId)
      }
      stored.taskId = taskId
      save()
      log('task created')
      return taskId
    } catch (error) {
      retryAt = now() + retryMs
      log('task unavailable', { code: error instanceof ProgramError ? error.code : error instanceof Error ? error.name : typeof error })
      return null
    }
  }

  return {
    resolve() {
      if (stored.taskId !== null) return Promise.resolve(stored.taskId)
      if (options.program === undefined || now() < retryAt) return Promise.resolve(null)
      inFlight ??= ensure().finally(() => { inFlight = null })
      return inFlight
    },
    forget(taskId) {
      if (stored.taskId !== taskId) return
      stored.taskId = null
      retryAt = 0
      save()
      log('task forgotten')
    }
  }
}
