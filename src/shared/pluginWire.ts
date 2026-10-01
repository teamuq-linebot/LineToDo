/**
 * pluginWire.ts — 外掛 view 與 backend 之間「線上格式」的共用上限（view 與 backend 都 import；不依賴 DOM／Node）。
 *
 * TeamUQ 1.6.8 對 `backend.call` 的請求與回應各 ≤ 64 KiB（位元組，`backendInvokeContracts.ts` 的 `payloadBytes`）。
 * 上限一律用「UTF-8 位元組」表達，不用字元數：中文每字 3 位元組，字元上限會讓 view 端的位元組檢查先擋掉（review F8）。
 */

/** 單一請求的位元組上限：host 的 64 KiB 留一點餘裕給 envelope。 */
export const MAX_REQUEST_BYTES = 60 * 1024

/**
 * `ai.commit` 單一回覆文字的位元組上限（UTF-8）。小於 `MAX_REQUEST_BYTES`，餘量給 `{path,args:[{results:[{taskId,ok,model,…}]}]}` 的外框
 * 與 JSON 跳脫（換行、引號各多 1 位元組）。view 端送出前以 `fitReplyText()` 保證不會超過；backend 以同一個數字拒絕超出的文字。
 */
export const AI_COMMIT_TEXT_MAX_BYTES = 48 * 1024

/** 回覆被截斷時附加的標記（只用在純文字草稿；JSON 輸出不截斷，改回報 `reply_too_long`）。 */
export const REPLY_TRUNCATED_MARK = '\n…（回覆過長，已截斷）'

const encoder = new TextEncoder()

/** 字串的 UTF-8 位元組數。 */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).byteLength
}

/** 字串放進 JSON 之後（含跳脫，不含兩側引號）的 UTF-8 位元組數。 */
export function jsonStringBytes(text: string): number {
  return encoder.encode(JSON.stringify(text)).byteLength - 2
}

/** 這段文字能不能放進一個 `ai.commit` 請求：原文位元組 ≤ `AI_COMMIT_TEXT_MAX_BYTES`，且 JSON 跳脫後 ≤ 請求上限減去外框預留。 */
export function textFitsCommit(text: string, envelopeReserveBytes = 2048): boolean {
  return utf8Bytes(text) <= AI_COMMIT_TEXT_MAX_BYTES && jsonStringBytes(text) <= MAX_REQUEST_BYTES - envelopeReserveBytes
}

/** 不切開 surrogate pair 的前綴。 */
function safePrefix(text: string, length: number): string {
  if (length >= text.length) return text
  const code = text.charCodeAt(length - 1)
  return code >= 0xd800 && code <= 0xdbff ? text.slice(0, length - 1) : text.slice(0, length)
}

export type FittedReply = { ok: true; text: string; truncated: boolean } | { ok: false; code: 'reply_too_long' }

/**
 * 讓回覆文字能放進一個 `ai.commit` 請求。放得下就原樣回傳；放不下時：
 *   - `allowTruncate`（純文字草稿）：二分搜尋最長的前綴（連同截斷標記）使它放得下；
 *   - 否則（JSON 輸出，截斷會壞掉）：回 `reply_too_long`，讓 backend 把這次工作記成失敗，而不是送出殘缺的 JSON。
 */
export function fitReplyText(text: string, allowTruncate: boolean, envelopeReserveBytes = 2048): FittedReply {
  if (textFitsCommit(text, envelopeReserveBytes)) return { ok: true, text, truncated: false }
  if (!allowTruncate) return { ok: false, code: 'reply_too_long' }
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (textFitsCommit(safePrefix(text, mid) + REPLY_TRUNCATED_MARK, envelopeReserveBytes)) low = mid
    else high = mid - 1
  }
  const kept = safePrefix(text, low)
  return kept.length === 0 ? { ok: false, code: 'reply_too_long' } : { ok: true, text: kept + REPLY_TRUNCATED_MARK, truncated: true }
}
