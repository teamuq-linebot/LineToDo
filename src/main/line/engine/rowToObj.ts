/**
 * rowToObj — 把 LINE DB 的 `_message` row 轉成 NDJSON 契約物件的**純函式**。
 *
 * 移植自 `line-cua-win/src/watch_json.py` 的 `row_to_obj`(:186-220)、
 * `_media_fields`(:85-131)、`_call_label`(:134-183)，行為 byte-level parity。
 * 對應 port-plan §1（NDJSON 契約）、§5 Batch 3、§3.4。
 *
 * 本檔為 Batch 3：**純函式，無 IO、無 DB、無平台 API、無時區系統呼叫**。
 * 需要上下文的欄位（`time` / `chat` / `sender`）由呼叫端（Batch 1/4）以參數注入：
 *   - `iso(ts)`：本地時區、秒精度、無時區後綴的 ISO 字串（= `linedb.iso`）。
 *   - `chatName`：已解析好的顯示名（= `linedb.chat_name(chatId)`），未解出為 null。
 *   - `senderName`：`_from` 的顯示名（= `linedb.chat_name(_from)`），未解出為 null。
 *   - `myMid`：自己的 mid（= `linedb.my_mid`），用來判 direction。
 *
 * 所有 JSON parse 全程 tolerant：欄位缺失/壞 JSON → null，永不 throw。
 */
import type { RawLineMessage } from '../types'

/**
 * 一列 `_message` 的原始欄位（對應 watch_json `new_messages` 的 SELECT 順序）。
 * 皆為 LINE DB 原值，未經任何上下文解析。
 */
export interface MessageRow {
  /** `_chatId` */
  chatId: string
  /** `_createdTime`（epoch ms） */
  createdTime: number
  /** `_from`（發送者 mid） */
  from: string
  /** `_text`（可能為 null / 空字串） */
  text: string | null
  /** `_contentType`（可能為 null） */
  contentType: number | null
  /** `_id`（原生訊息 id，可能為 null） */
  id: string | number | null
  /** `_contentMetadata`（JSON 字串或 null） */
  contentMetadata: string | null
  /** `_contentInfo`（JSON 字串或 null） */
  contentInfo: string | null
  /** `_attribute`（收回旗標，==1 為已收回） */
  attribute: number | null
}

/** `rowToObj` 需要呼叫端注入的上下文（時區 / DB 查詢結果）。 */
export interface RowContext {
  /** `_from == myMid` 時 direction 為 'out'。 */
  myMid: string | null
  /** 本地時區 ISO 格式化（= `linedb.iso`）；ts 為 0/falsy 時回 null。 */
  iso: (ts: number) => string | null
  /** chatId 的顯示名（= `chat_name(chatId)`）；未解出為 null。 */
  chatName: string | null
  /** `_from` 的顯示名（= `chat_name(_from)`）；未解出為 null。 */
  senderName: string | null
}

/** `_media_fields` 的五個媒體欄位（全 null = 非 E2EE 可解媒體）。 */
export interface MediaFields {
  keyMaterial: string | null
  fileName: string | null
  fileSize: number | null
  oid: string | null
  sid: string | null
}

const MEDIA_NULL: MediaFields = {
  keyMaterial: null,
  fileName: null,
  fileSize: null,
  oid: null,
  sid: null,
}

// LINE message _contentType -> label for non-text messages（= linedb.CT）
const CT: Record<number, string | null> = {
  0: null,
  1: '[image]',
  2: '[video]',
  3: '[audio]',
  6: '[call]',
  7: '[sticker]',
  13: '[contact]',
  14: '[file]',
  16: '[album]',
}

const CALL_CAUSE: Record<number, string> = {
  17: '📞 忙線未接',
  18: '📞 未接來電',
  21: '📞 已拒接',
  77: '📞 已取消通話',
  127: '📞 通話失敗',
}

/** tolerant JSON.parse：非字串 / 壞 JSON → null，永不 throw。 */
function parseJsonTolerant(raw: string | null | undefined): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * py `int(x)`（十進位、tolerant）的對等：接受數字或可轉整數的字串，
 * 失敗回 null。用於 `FILE_SIZE`（字串）與 `CAUSE`/`DURATION`。
 * 對齊 Python `int()`：整數字串（含前後空白、正負號）成功；空字串/非數字/浮點字串失敗。
 */
function toInt(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? Math.trunc(raw) : null
  }
  if (typeof raw === 'string') {
    const s = raw.trim()
    // Python int() 只接受純整數（含符號），不吃小數點/科學記號。
    if (!/^[+-]?\d+$/.test(s)) return null
    const n = Number.parseInt(s, 10)
    return Number.isNaN(n) ? null : n
  }
  return null
}

/**
 * DURATION (ms) -> 人類標籤。<60s: 'N 秒'; >=60s: 'M 分 S 秒'。
 * 對齊 py `_fmt_call_duration`（`secs = round(ms/1000)`）。
 * 注意：Python round 用 banker's rounding，但 DURATION 為整數毫秒，
 * ms/1000 落在 .5 邊界極罕見；此處採 Python round 語意（round-half-to-even）以求 parity。
 */
function fmtCallDuration(ms: number): string {
  const secs = pyRound(ms / 1000)
  if (ms < 60000) {
    return `${secs} 秒`
  }
  return `${Math.floor(secs / 60)} 分 ${secs % 60} 秒`
}

/** Python 3 round()：round-half-to-even（banker's rounding）。 */
function pyRound(x: number): number {
  const floor = Math.floor(x)
  const diff = x - floor
  if (diff < 0.5) return floor
  if (diff > 0.5) return floor + 1
  // 正好 .5 → 取偶數
  return floor % 2 === 0 ? floor : floor + 1
}

/**
 * ct=6 通話 -> 依 `_contentMetadata` 的 TYPE/DURATION/CAUSE 產中文標籤。
 * 對齊 `watch_json.py:_call_label`。metadata 缺失/壞 / CAUSE 不可用 → null
 * （呼叫端回退到原始 `_text`/CT 行為）。
 */
export function callLabel(cmetaRaw: string | null): string | null {
  const meta = parseJsonTolerant(cmetaRaw)
  if (!isPlainObject(meta)) return null
  const typ = meta['TYPE']
  if (typ === 'G') return '👥 群組通話'
  const icon = typ === 'V' ? '📹' : '📞'
  const kind = typ === 'V' ? '視訊' : '語音'
  const cause = toInt(meta['CAUSE'])
  if (cause === null) return null // 缺失/亂碼 CAUSE -> 回退原始 _text
  if (cause === 16) {
    const durRaw = toInt(meta['DURATION'])
    const dur = durRaw === null ? 0 : durRaw
    if (dur > 0) {
      return `${icon} ${kind}通話・${fmtCallDuration(dur)}`
    }
    return '📞 通話'
  }
  if (cause in CALL_CAUSE) {
    return CALL_CAUSE[cause]
  }
  return '📞 通話' // known-int 但未識別的 CAUSE
}

/**
 * E2EE 媒體欄位（供 line-todo 定位 + 解密本機 `.eimg`）。
 * 對齊 `watch_json.py:_media_fields`。Gate（Phase 0）：僅 contentType 1(image)/
 * 14(file) 且 `_contentInfo` 帶非空 `keyMaterial` 才給真值，其餘全 null。
 */
export function mediaFields(
  cmetaRaw: string | null,
  cinfoRaw: string | null,
  ct: number | null,
  text: string | null,
): MediaFields {
  if (ct !== 1 && ct !== 14) return { ...MEDIA_NULL }
  const info = parseJsonTolerant(cinfoRaw)
  if (!isPlainObject(info)) return { ...MEDIA_NULL }
  const keyMaterial = info['keyMaterial']
  if (!keyMaterial) return { ...MEDIA_NULL } // 非 E2EE / 不可解 -> 維持 null
  let meta = parseJsonTolerant(cmetaRaw)
  if (!isPlainObject(meta)) meta = {}
  const metaObj = meta as Record<string, unknown>
  // fileName: 僅檔案(ct=14)；_contentInfo.fileName 優先，否則 _text。
  // 圖片無原名。絕不讀 _contentMetadata.FILE_NAME（實測為空）。
  let fileName: string | null = null
  if (ct === 14) {
    const infoName = info['fileName']
    if (infoName) {
      fileName = infoName as string
    } else {
      fileName = text ? text : null
    }
  }
  // fileSize: _contentMetadata.FILE_SIZE — 大寫、字串存放，parse int，失敗 null。
  let fileSize: number | null = null
  const rawSize = metaObj['FILE_SIZE']
  if (rawSize !== undefined && rawSize !== null) {
    fileSize = toInt(rawSize)
  }
  const oid = metaObj['OID']
  const sid = metaObj['SID']
  return {
    keyMaterial: keyMaterial as string,
    fileName,
    fileSize,
    oid: oid === undefined ? null : (oid as string | null),
    sid: sid === undefined ? null : (sid as string | null),
  }
}

/**
 * 一列 `_message` -> App 的 NDJSON 契約物件。
 * 對齊 `watch_json.py:row_to_obj`。上下文欄位由 `ctx` 注入（純函式，不碰 DB/時區）。
 */
export function rowToObj(row: MessageRow, ctx: RowContext): RawLineMessage {
  const ct = row.contentType
  const text = row.text
  // body：ct=6 先試 call label，否則 text 或 CT label / [type=N]。
  // 注意 parity：py `f"[type={ct}]"` 對 None 產出字面 "None"（非 "null"），須逐字對齊。
  const ctLabel = (): string => {
    const label = ct !== null && ct in CT ? CT[ct] : undefined
    return (label ?? undefined) || `[type=${ct === null || ct === undefined ? 'None' : ct}]`
  }
  let body: string
  if (ct === 6) {
    body = callLabel(row.contentMetadata) || (text ? text : ctLabel())
  } else {
    body = text ? text : ctLabel()
  }
  const direction: 'in' | 'out' = row.from === ctx.myMid ? 'out' : 'in'
  const media = mediaFields(row.contentMetadata, row.contentInfo, ct, text)
  const c = row.chatId
  return {
    msgId: row.id !== null && row.id !== undefined ? String(row.id) : null,
    chat: ctx.chatName || c,
    chatId: c,
    // 1:1 是 "u" 開頭；其餘（group "c"、room "m"、Square "t"、unknown）-> group。
    isGroup: c ? c.slice(0, 1) !== 'u' : true,
    ts: row.createdTime,
    time: ctx.iso(row.createdTime) as string,
    direction,
    sender: direction === 'out' ? 'me' : ctx.senderName || row.from,
    text: body,
    contentType: ct !== null && ct !== undefined ? ct : 0,
    // 已收回旗標；_attribute==1 與 UNSENT 全庫 1:1。None/非數字 -> false。
    unsent: row.attribute === 1,
    // E2EE 媒體欄位 — null 除非 ct∈{1,14} 且有 keyMaterial。
    ...media,
  }
}
