/**
 * extractResult.ts — 抽取輸出的 zod schema 與驗證（純函式、只依賴 zod）。
 *
 * 原本在 src/main/llm/schema.ts；外掛 backend 的 ExtractWorker（src/plugin/backend/extractWorker.ts）要用「同一份」zod 驗證 host.ai.complete 回來的 JSON，
 * 而 UI bundle 不能含 main-process 程式碼（scripts/plugin/build-ui.mjs 的輸入白名單），所以搬到 shared。
 * `src/main/llm/schema.ts` 重新匯出這裡的全部符號，所有既有的 import 路徑與行為不變。
 */
import { z } from 'zod'
import { IdentityDecisionSchema, validateIdentityDecisions, type IdentityDecision, type IdentityValidationContext } from './identityDecision'

/**
 * schema.ts — 抽取輸出的「單一真實來源」。
 *
 * 兩個產物必須語意一致（IMPLEMENTATION_PLAN.md §6.3）：
 *   1) EXTRACT_JSON_SCHEMA：傳給 qwen response_format.json_schema（vLLM guided_json）做約束生成。
 *   2) ExtractResultSchema（zod）：模型回來後 runtime 二次驗證，避免模型越界 / 欄位漂移。
 *
 * 手寫 json_schema 常數 + zod runtime 驗證（規格 §2 備註的預設策略），不引 zod-to-json-schema，
 * 避免兩者漂移由「同一份規格、兩處手維護」承擔；改一處務必改另一處。
 */

// ── bucket / importance / priority 列舉（與 DB CHECK 對齊）──
export const BUCKETS = ['todo', 'waiting', 'schedule'] as const
export const IMPORTANCES = ['action', 'fyi', 'noise'] as const
export const PRIORITIES = [1, 2, 3] as const

// ── zod：runtime 驗證 ───────────────────────────────────────
const NewTodoSchema = z.object({
  draftRef: z.string().regex(/^[a-z0-9_-]{1,40}$/i).optional(),
  bucket: z.enum(BUCKETS),
  title: z.string().min(1),
  detail: z.string().nullable().optional(),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  dueAt: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1),
  sourceMsgIds: z.array(z.string()).min(1)
})

const ResolvedSchema = z.object({
  todoId: z.string().min(1),
  evidence: z.string().min(1),
  evidenceMsgIds: z.array(z.string().min(1)).min(1).max(20).optional()
})

// 既有代辦升級/重新分類（最典型：會議從「喬時間的代辦」→「時間確定的行程」）。
// 事件尚未發生/未完成，只是換 bucket；與 resolved（已完成/取消）、newTodos（建新卡）區別。
const UpdatedTodoSchema = z.object({
  todoId: z.string().min(1),
  bucket: z.enum(BUCKETS),
  dueAt: z.string().nullable().optional(),
  evidence: z.string().min(1)
})

export const ExtractResultSchema = z.object({
  importance: z.enum(IMPORTANCES),
  newTodos: z.array(NewTodoSchema),
  identityDecisions: z.array(IdentityDecisionSchema).optional(),
  resolved: z.array(ResolvedSchema),
  // .default([]) 確保不含 updates 的舊式 JSON 仍可解析（向後相容）。
  updates: z.array(UpdatedTodoSchema).default([])
})

export type ExtractResult = z.infer<typeof ExtractResultSchema>
export type NewTodo = z.infer<typeof NewTodoSchema>
export type ResolvedTodo = z.infer<typeof ResolvedSchema>
export type UpdatedTodo = z.infer<typeof UpdatedTodoSchema>

export interface ExtractIdentityValidationContext extends IdentityValidationContext {
  allowedTodoIds: string[]
}

/**
 * 驗證「已解析成 JS 值」的抽取結果。
 * - zod 驗證失敗 → throw ZodError（呼叫端標該 chat partial、不中斷整輪）。
 * 回傳已淨化的 ExtractResult（detail/dueAt 統一成 string | null）。
 *
 * 拆出這個入口是為了讓「原生就回物件」的 provider（Claude structured_output /
 * Codex out.json）不必為了餵 parseExtractResult 而先 stringify 再 parse 回來。
 * zod 驗證永遠在 provider 之外做（design.md §1.3），這裡是唯一的真實來源。
 */
export function validateExtractResult(value: unknown, identityContext?: ExtractIdentityValidationContext): ExtractResult {
  const parsed = ExtractResultSchema.parse(value)
  const identityDecisions: IdentityDecision[] = identityContext
    ? validateIdentityDecisions(parsed.identityDecisions, parsed.newTodos.map((todo) => todo.draftRef ?? ''), identityContext)
    : (parsed.identityDecisions ?? []) as IdentityDecision[]
  if (identityContext) {
    const selected = new Set(identityContext.selectedMessageIds)
    if (parsed.newTodos.some((todo) => todo.sourceMsgIds.some((id) => !selected.has(id)))) {
      throw new Error('newTodo_source_not_selected')
    }
    if (parsed.resolved.some((todo) => !todo.evidenceMsgIds?.length || todo.evidenceMsgIds.some((id)=>!selected.has(id)))) {
      throw new Error('resolved_evidence_not_selected')
    }
    const allowedTodoIds = new Set(identityContext.allowedTodoIds)
    if (parsed.resolved.some((todo) => !allowedTodoIds.has(todo.todoId)) || parsed.updates.some((todo) => !allowedTodoIds.has(todo.todoId))) {
      throw new Error('existing_todo_id_not_supplied')
    }
  }
  // 正規化 optional → null，給下游 DB 寫入用穩定型別。
  return {
    importance: parsed.importance,
    newTodos: parsed.newTodos.map((t) => ({
      ...(t.draftRef ? { draftRef:t.draftRef } : {}),
      bucket: t.bucket,
      title: t.title,
      detail: t.detail ?? null,
      priority: t.priority,
      dueAt: t.dueAt ?? null,
      confidence: t.confidence,
      sourceMsgIds: t.sourceMsgIds
    })),
    resolved: parsed.resolved.map((r) => ({ todoId: r.todoId, evidence: r.evidence, ...(r.evidenceMsgIds ? { evidenceMsgIds:[...r.evidenceMsgIds] } : {}) })),
    updates: parsed.updates.map((u) => ({
      todoId: u.todoId,
      bucket: u.bucket,
      dueAt: u.dueAt ?? null,
      evidence: u.evidence
    })),
    identityDecisions
  }
}

/**
 * 解析 + 驗證模型回傳字串（對外簽章不變；scripts/probe-* 依賴它）。
 * - JSON.parse 失敗 → throw（呼叫端標該 chat partial、不中斷整輪）。
 * - zod 驗證失敗 → throw ZodError（同上）。
 */
export function parseExtractResult(raw: string): ExtractResult {
  return validateExtractResult(JSON.parse(raw) as unknown)
}
