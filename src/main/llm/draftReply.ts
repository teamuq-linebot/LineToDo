import type OpenAI from 'openai'
import type { TodoDTO } from '../db/dto'
import type { MessageDTO } from '../db/dto'

/**
 * draftReply.ts — 為「等回覆 / 待辦」草擬一則回覆（IMPLEMENTATION_PLAN.md §5 todos:draftReply）。
 *
 * MVP 只「草擬」不送出（真送出 driver_post 延後）。本模組純呼叫 qwen，回一段繁中文字草稿。
 * 不碰 DB、不讀金鑰；qwen client 與 model 由呼叫端傳入（金鑰即用即丟）。
 * 失敗一律 throw，IPC 呼叫端 catch 後回友善錯誤。
 */

const DRAFT_SYSTEM_PROMPT = `你是使用者的 LINE 訊息助理，幫使用者「草擬」一則要傳給對方的回覆。
規則：
- 用繁體中文，語氣自然、口語、有禮貌，符合一般 LINE 對話習慣（簡短、不要像公文）。
- 只輸出「要傳出去的訊息本文」，不要加任何前後綴、不要解釋、不要用引號或 Markdown 包起來。
- 依據提供的「代辦事項」與「最近對話」推測使用者想表達的意思，幫他把話講清楚。
- 若是在等對方回覆某件事，草擬的內容應該是「禮貌地追問 / 跟進」那件事。
- 長度以 1~3 句為原則，不要長篇大論。
- 你只是草稿，不會真的送出；使用者會自己過目後再決定。`

export interface DraftReplyInput {
  todo: Pick<TodoDTO, 'bucket' | 'title' | 'detail'>
  chatName: string | null
  isGroup: boolean
  /** 該 chat 最近數則訊息（舊到新），給 LLM 推測語境。 */
  recentMessages: Pick<MessageDTO, 'direction' | 'sender' | 'text' | 'timeIso'>[]
}

function buildDraftUserPayload(input: DraftReplyInput): string {
  const lines = input.recentMessages.map((m) => {
    const who = m.direction === 'out' ? '我' : m.sender || '對方'
    return `${who}：${m.text ?? ''}`
  })
  const bucketLabel =
    input.todo.bucket === 'waiting'
      ? '等對方回覆'
      : input.todo.bucket === 'schedule'
        ? '行程安排'
        : '我的待辦'
  return JSON.stringify(
    {
      聊天室: input.chatName ?? '(未命名)',
      是否群組: input.isGroup,
      代辦分類: bucketLabel,
      代辦標題: input.todo.title,
      代辦補充: input.todo.detail ?? '',
      最近對話: lines
    },
    null,
    2
  )
}

export interface DraftReplyOptions {
  model: string
  temperature?: number
}

/** 呼叫 qwen 產一段回覆草稿。回傳純文字（已 trim）。 */
export async function draftReply(
  qwen: OpenAI,
  input: DraftReplyInput,
  opts: DraftReplyOptions
): Promise<string> {
  const res = await qwen.chat.completions.create({
    model: opts.model,
    temperature: opts.temperature ?? 0.5,
    messages: [
      { role: 'system', content: DRAFT_SYSTEM_PROMPT },
      { role: 'user', content: buildDraftUserPayload(input) }
    ]
  })
  const content = res.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('qwen 回應沒有可用的草稿內容')
  }
  return content.trim()
}
