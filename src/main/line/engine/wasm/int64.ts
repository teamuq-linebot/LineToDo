/**
 * int64.ts — LINE DB INTEGER 欄位在不同引擎下的 int64 處理規則（去重鍵的來源）。
 *
 * 背景：standalone 的 better-sqlite3(-multiple-ciphers) 預設把 INTEGER 讀成 JS Number，超過
 * 2^53 的值會**失真**（例如 534567890123456789 → 534567890123456800）；`rowToObj` 再 `String(id)`，
 * `deriveMsgId` 做成 `i:<id>` 去重鍵。WASM 引擎（oo1）超出安全範圍的 INTEGER 會回 BigInt（精確）。
 *
 * 規則（外掛引擎，`Int64Mode`）：
 *   - `'exact'`（預設）：不丟精度。超出安全範圍的 INTEGER 以 BigInt 回傳，`linedb` 把 `msgId` 轉成
 *     `String(bigint)`（十進位、精確）。與 standalone 的差別**只在** `_id` 為 INTEGER 且 |值| > 2^53 時
 *     （standalone 的鍵是失真字串，且相近的 id 會撞成同一個鍵）；`_id` 為 TEXT（fixture 與目前所有
 *     已驗證的 LINE DB 形態）或 |值| ≤ 2^53 時，兩者的鍵逐字相同。
 *   - `'legacy-number'`：與 standalone 逐位元相同。所有 INTEGER 一律 `Number(...)`（失真照舊），
 *     `String(Number)` 後得到和 standalone 一模一樣的去重鍵。供「外掛要沿用 standalone 已存的鍵」使用。
 *
 * 真 LINE `_message._id` 的欄位型別尚未在真 DB 驗證（設計 v2 §9，Phase 6 清單第 8 項）。
 */

export type Int64Mode = 'exact' | 'legacy-number'

/** 引擎層：依模式把一個 SQLite 值轉成呼叫端看到的值。 */
export function applyInt64Mode(value: unknown, mode: Int64Mode): unknown {
  if (mode === 'legacy-number' && typeof value === 'bigint') return Number(value)
  return value
}

/**
 * `msgId` 正規化（linedb 層，所有引擎共用）：bigint → 十進位字串；其他型別（number／string／null）原樣回傳，絕不改動。
 * 對 standalone（引擎永遠回 number／string）是 no-op，行為不變。
 */
export function normalizeMsgId<T>(value: T): Exclude<T, bigint> | string {
  return (typeof value === 'bigint' ? value.toString() : value) as Exclude<T, bigint> | string
}

/** 把可能是 bigint 的整數欄位（rowid、_createdTime）轉成 Number；超出安全範圍時 throw，不靜默失真。 */
export function toSafeNumber<T>(value: T): Exclude<T, bigint> | number {
  if (typeof value !== 'bigint') return value as Exclude<T, bigint> // 非 bigint 一律原樣（含 standalone 的 number）
  const n = Number(value)
  if (!Number.isSafeInteger(n)) throw new RangeError(`integer column out of safe range: ${value}`)
  return n
}

/**
 * standalone 對同一個 INTEGER `_id` 會產生的（失真）鍵字串：`String(Number(exact))`。
 * 用來把外掛 `'exact'` 模式產生的鍵對映回 standalone 已存的鍵（遷移／比對用）。
 */
export function legacyStandaloneMsgId(exact: string): string {
  return String(Number(BigInt(exact)))
}
