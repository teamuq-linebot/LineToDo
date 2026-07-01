/**
 * RawLineMessage — 一則 LINE 訊息的型別，對齊 watch_json.py 的 NDJSON 欄位契約
 * （IMPLEMENTATION_PLAN.md §3）。watcher.ts 逐行 JSON.parse 後得到此型別。
 */
export interface RawLineMessage {
  /**
   * LINE _message._id — 原生全域唯一訊息 id，App 端去重的真鍵。
   * 罕見無 _id 的列為 null，此時 deriveMsgId() 退回欄位組合 hash。
   */
  msgId: string | null
  /** 顯示名稱；chat_name(chatId) 或回退 chatId */
  chat: string
  /** LINE _chatId 原值（唯一鍵） */
  chatId: string
  /** chatId[:1] !== "u"（fail-closed：非 1:1 一律當 group） */
  isGroup: boolean
  /** epoch 毫秒（= _createdTime） */
  ts: number
  /** 本地 ISO8601、秒精度、無時區後綴 */
  time: string
  /** "in" = 別人 / "out" = 自己 */
  direction: 'in' | 'out'
  /** "me"（out 時）或 sender 顯示名 */
  sender: string
  /** 文字內容；非文字訊息為 CT label（如 "[image]"） */
  text: string
  /** _contentType 原始 int（0 = 文字） */
  contentType: number
  // ── 媒體訊息（E2EE）解密輸入 —— 皆 optional，向後相容非媒體/舊列 ──
  // 由橋接（watch_json.py）自 LINE DB `_contentInfo`/`_contentMetadata` 額外吐出；
  // 只留 main/DB，keyMaterial 永不跨橋到 renderer（media_feature_plan §4.2/4.4）。
  /** base64（32B）金鑰素材；非 E2EE 媒體/文字為 null */
  keyMaterial?: string | null
  /** 檔案原名（檔案訊息）；圖片為 null */
  fileName?: string | null
  /** 明文位元組數（`.eimg == fileSize + 32`）；非媒體為 null */
  fileSize?: number | null
  /** OBS object id（選配，OBS 路 D 預留） */
  oid?: string | null
  /** OBS service id（選配） */
  sid?: string | null
}

/** LINE 橋接（watch_json.py 子程序）目前狀態。 */
export type LineBridgeState = 'starting' | 'running' | 'error' | 'stopped'

export interface LineBridgeStatus {
  state: LineBridgeState
  /** 最近一則收到訊息的本地時間（ISO 或顯示用字串），尚無則 null */
  lastMessageAt: string | null
  /** 本 session 累計轉送的訊息數 */
  messageCount: number
  /** 最近一次錯誤訊息（state==='error' 時有意義） */
  lastError: string | null
  /** 子程序自啟動以來重啟次數 */
  restarts: number
}
