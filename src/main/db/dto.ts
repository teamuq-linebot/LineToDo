/**
 * dto.ts — repo 對外回傳的 camelCase 資料傳輸物件（DTO）。
 *
 * DB 列是 snake_case（schema.ts 的 *Row）；跨 IPC 給 renderer 的型別統一 camelCase，
 * 與 RawLineMessage 等既有 renderer 型別風格一致。repo 內部做 Row → DTO 轉換。
 */

export interface ChatDTO {
  chatId: string
  name: string | null
  isGroup: boolean
  blocked: boolean
  blockReason: string | null
  firstSeenAt: string
  lastSeenAt: string
}

export interface MessageDTO {
  msgId: string
  chatId: string
  ts: number
  timeIso: string
  direction: 'in' | 'out'
  sender: string | null
  text: string | null
  contentType: number
  processed: boolean
  ingestedAt: string
  /** 檔案原名（檔案訊息）；圖片/非媒體為 null。key_material 絕不進 DTO。 */
  origFilename: string | null
  /** 明文位元組數（媒體）；非媒體為 null。 */
  fileSize: number | null
}

/** todos 列的 camelCase DTO（M2/M3 看板用；本輪先定義，repo 提供基本 CRUD）。 */
export interface TodoDTO {
  id: string
  chatId: string
  bucket: 'todo' | 'waiting' | 'schedule'
  status:
    | 'pending'
    | 'waiting_reply'
    | 'scheduled'
    | 'done'
    | 'suggested_done'
    | 'dismissed'
  title: string
  detail: string | null
  priority: number
  dueAt: string | null
  sourceMsgIds: string[]
  confidence: number
  completionEvidence: string | null
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
}
