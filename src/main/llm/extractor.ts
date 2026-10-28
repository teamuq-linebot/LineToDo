import { EXTRACT_SYSTEM_PROMPT, buildUserPayload } from './extractPrompt'
import type { BuildUserPayloadInput } from './extractPrompt'
import { EXTRACT_JSON_SCHEMA, validateExtractResult } from './schema'
import type { ExtractResult } from './schema'
import type { LlmProvider } from './provider/types'

/**
 * extractor.ts — 單一 chat 的抽取核心（IMPLEMENTATION_PLAN.md §6.1）。
 *
 * 職責只剩兩件事：組 request（system prompt + user payload + json schema）、驗證輸出。
 * 「怎麼把 schema 送給端點」（response_format ⇄ guided_json fallback）屬傳輸細節，
 * 已搬進 provider/httpOpenAi.ts（design.md §1.5）。
 *
 * 失敗（網路 / 逾時 / 解析 / 驗證）一律 throw；pipeline 呼叫端 catch 後把該 chat 標 partial、
 * 不中斷整輪（§6.1 / §8）。本模組不碰 DB、不讀金鑰，純函式好測。
 */

export interface ExtractOptions {
  temperature?: number
  /** 單次呼叫 wall-clock 上限（ms）。HTTP provider 忽略（以建構時設定為準）。 */
  timeoutMs?: number
}

function requestSchemaForInput(input:BuildUserPayloadInput):unknown {
  const schema=EXTRACT_JSON_SCHEMA.schema as {properties:Record<string,unknown>}
  const properties=schema.properties as Record<string,Record<string,unknown>>
  const selectedIds=input.newMessages.map((message)=>message.msgId)
  const todoIds=input.openTodos.map((todo)=>todo.id)
  const todos=properties.newTodos as {items:{properties:Record<string,Record<string,unknown>>}}
  const newTodoProperties=todos.items.properties
  const resolved=properties.resolved as {items:{properties:Record<string,Record<string,unknown>>}}
  const resolvedProperties=resolved.items.properties
  const updates=properties.updates as {items:{properties:Record<string,Record<string,unknown>>}}
  const updateProperties=updates.items.properties
  const decisions=properties.identityDecisions as {items:{properties:Record<string,Record<string,unknown>>}}
  const decisionProperties=decisions.items.properties
  const candidateTypes=[...new Set((input.identityCandidates??[]).map((candidate)=>candidate.entityType))]
  const candidateIds=(input.identityCandidates??[]).map((candidate)=>candidate.entityId)
  return {
    ...EXTRACT_JSON_SCHEMA,
    schema:{
      ...schema,
      properties:{
        ...properties,
        newTodos:{...todos,items:{...todos.items,properties:{...newTodoProperties,sourceMsgIds:{...newTodoProperties.sourceMsgIds,items:{type:'string',enum:selectedIds}}}}},
        resolved:{...resolved,items:{...resolved.items,properties:{...resolvedProperties,todoId:{...resolvedProperties.todoId,...(todoIds.length?{enum:todoIds}:{})},evidenceMsgIds:{...resolvedProperties.evidenceMsgIds,items:{type:'string',enum:selectedIds}}}}},
        updates:{...updates,items:{...updates.items,properties:{...updateProperties,todoId:{...updateProperties.todoId,...(todoIds.length?{enum:todoIds}:{})}}}},
        identityDecisions:{...decisions,items:{...decisions.items,properties:{
          ...decisionProperties,
          candidateType:{...decisionProperties.candidateType,enum:[null,...candidateTypes]},
          candidateId:{...decisionProperties.candidateId,enum:[null,...candidateIds]},
          evidenceMsgIds:{...decisionProperties.evidenceMsgIds,items:{type:'string',enum:selectedIds}}
        }}}
      }
    }
  }
}

/**
 * 對單一 chat 做抽取。input 同 buildUserPayload 的入參。
 * 回傳已驗證的 ExtractResult。任何階段失敗 throw。
 */
export async function extractTodos(
  provider: LlmProvider,
  input: BuildUserPayloadInput,
  opts: ExtractOptions
): Promise<ExtractResult> {
  const user = buildUserPayload(input)
  input.onCorrectionsPayloadBuilt?.()
  const res = await provider.complete({
    system: EXTRACT_SYSTEM_PROMPT,
    user,
    temperature: opts.temperature ?? 0.1,
    jsonSchema: requestSchemaForInput(input) as typeof EXTRACT_JSON_SCHEMA,
    timeoutMs: opts.timeoutMs
  })

  // provider 原生回物件時直接用（省一次 stringify→parse 往返）；否則 parse 文字。
  const value = res.structured !== undefined ? res.structured : (JSON.parse(res.text) as unknown)
  return validateExtractResult(value, {
    candidates: input.identityCandidates ?? [],
    candidatesTruncated: input.identityCandidatesTruncated === true,
    selectedMessageIds: input.newMessages.map((message) => message.msgId),
    targetType: 'todo',
    allowedTodoIds: input.openTodos.map((todo) => todo.id)
  })
}
