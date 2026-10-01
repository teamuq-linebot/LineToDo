/**
 * aiOutputContract.ts — 「要求模型輸出 JSON」的 prompt 附註（設計 v2 §4.3 第 5 點）。
 *
 * TeamUQ 1.6.8 的 `ai:chat` 沒有 structured output（`aiChatContracts.ts:66-80` 的 request 沒有 schema 欄位），standalone 的 provider
 * 是把 JSON Schema 交給 API／CLI 做解碼層約束；外掛版只能把 schema 寫進 prompt，由 UI 端 parse + zod 驗證。
 * 這個檔案只產生那段附註文字（純函式、無 I/O），backend 在 `extract.system` 與 UI AI 橋接（aiTaskQueue）共用。
 */
import { EXTRACT_JSON_SCHEMA } from '../../main/llm/schema'

/** 把 JSON Schema 轉成附在 system prompt 後面的格式要求。 */
export function outputContractFor(schema: unknown): string {
  return [
    '【輸出格式（本通道沒有 structured output，請嚴格遵守）】',
    '- 只輸出「一個」JSON 物件，且必須完全符合下列 JSON Schema。',
    '- 不要輸出任何說明或前後綴文字；不要用 Markdown 或程式碼圍欄（```）包起來。',
    '- 不要輸出 schema 以外的欄位。',
    `JSON Schema：${JSON.stringify(schema)}`
  ].join('\n')
}

/** 抽取（`extract.system` 的 `format`）：UI 把它接在 system prompt 後面一起送給 ai:chat。 */
export const EXTRACT_OUTPUT_CONTRACT = outputContractFor(EXTRACT_JSON_SCHEMA.schema)
