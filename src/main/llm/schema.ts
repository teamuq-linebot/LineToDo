import { z } from 'zod'

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
  evidence: z.string().min(1)
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
  resolved: z.array(ResolvedSchema),
  // .default([]) 確保不含 updates 的舊式 JSON 仍可解析（向後相容）。
  updates: z.array(UpdatedTodoSchema).default([])
})

export type ExtractResult = z.infer<typeof ExtractResultSchema>
export type NewTodo = z.infer<typeof NewTodoSchema>
export type ResolvedTodo = z.infer<typeof ResolvedSchema>
export type UpdatedTodo = z.infer<typeof UpdatedTodoSchema>

// ── JSON Schema：傳給 qwen 約束生成（§6.3 全文）─────────────
export const EXTRACT_JSON_SCHEMA = {
  name: 'line_todo_extraction',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['newTodos', 'resolved', 'updates', 'importance'],
    properties: {
      importance: { type: 'string', enum: ['action', 'fyi', 'noise'] },
      newTodos: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['bucket', 'title', 'priority', 'confidence', 'sourceMsgIds'],
          properties: {
            bucket: { type: 'string', enum: ['todo', 'waiting', 'schedule'] },
            title: { type: 'string', minLength: 1 },
            detail: { type: ['string', 'null'] },
            priority: { type: 'integer', enum: [1, 2, 3] },
            dueAt: { type: ['string', 'null'], description: 'ISO8601 或 null' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            sourceMsgIds: { type: 'array', items: { type: 'string' }, minItems: 1 }
          }
        }
      },
      resolved: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['todoId', 'evidence'],
          properties: {
            todoId: { type: 'string' },
            evidence: { type: 'string', minLength: 1 }
          }
        }
      },
      updates: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['todoId', 'bucket', 'dueAt', 'evidence'],
          properties: {
            todoId: { type: 'string' },
            bucket: { type: 'string', enum: ['todo', 'waiting', 'schedule'] },
            dueAt: { type: ['string', 'null'], description: 'ISO8601 或 null' },
            evidence: { type: 'string', minLength: 1 }
          }
        }
      }
    }
  }
} as const

/**
 * 解析 + 驗證模型回傳字串。
 * - JSON.parse 失敗 → throw（呼叫端標該 chat partial、不中斷整輪）。
 * - zod 驗證失敗 → throw ZodError（同上）。
 * 回傳已淨化的 ExtractResult（detail/dueAt 統一成 string | null）。
 */
export function parseExtractResult(raw: string): ExtractResult {
  const json = JSON.parse(raw) as unknown
  const parsed = ExtractResultSchema.parse(json)
  // 正規化 optional → null，給下游 DB 寫入用穩定型別。
  return {
    importance: parsed.importance,
    newTodos: parsed.newTodos.map((t) => ({
      bucket: t.bucket,
      title: t.title,
      detail: t.detail ?? null,
      priority: t.priority,
      dueAt: t.dueAt ?? null,
      confidence: t.confidence,
      sourceMsgIds: t.sourceMsgIds
    })),
    resolved: parsed.resolved.map((r) => ({ todoId: r.todoId, evidence: r.evidence })),
    updates: parsed.updates.map((u) => ({
      todoId: u.todoId,
      bucket: u.bucket,
      dueAt: u.dueAt ?? null,
      evidence: u.evidence
    }))
  }
}
