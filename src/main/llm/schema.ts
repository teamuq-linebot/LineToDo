export {
  BUCKETS, IMPORTANCES, PRIORITIES, ExtractResultSchema, validateExtractResult, parseExtractResult
} from '../../shared/extractResult'
export type { ExtractResult, NewTodo, ResolvedTodo, UpdatedTodo } from '../../shared/extractResult'

/**
 * schema.ts — 抽取輸出的 JSON Schema（傳給 provider 做解碼層約束）。zod 驗證在 `src/shared/extractResult.ts`（單一真實來源，外掛 UI 也用）；
 * 兩者語意必須一致（IMPLEMENTATION_PLAN.md §6.3），改一處務必改另一處。
 */
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
