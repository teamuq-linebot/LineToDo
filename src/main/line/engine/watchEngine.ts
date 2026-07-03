/**
 * watchEngine.ts — 純 TS in-process 編排層（Batch 4a）。
 *
 * 組合 Batch 1/2/3 三批引擎（`linedb` / `linekey` / `rowToObj`），對下游提供
 * async API，行為對照外部 Python 引擎 `line-cua-win/src/watch_json.py`（`poll` /
 * `new_messages` / `emit` / CLI arg）求 parity。取代原本三個 spawn 進入點的
 * 資料來源，但**本批只新增此檔（+型別）**，不改 watcher/pipeline/lineBridge/types。
 *
 * 對應 port-plan §5 Batch 4、§1（NDJSON 契約 + 輸出協定）、§8.6（checkpoint 遷移）。
 *
 * ── 提供的 async API（對照 watch_json.py 的 CLI 模式）──
 *   - getMessagesSince(ms, opts?)   → py `--since <ms>`：不吃 checkpoint、不改 state（backfill 用）
 *   - getNewMessagesOnce(opts?)     → py `--once`（預設）：自 checkpoint 讀 last_ts → 取增量 → 更新 checkpoint
 *   - resetNow(opts?)               → py `--reset-now`：checkpoint 設到目前最新訊息（不回舊訊息）
 *
 * ── stat-gate ──
 *   `(edb.size, edb.mtime_ns, wal.size, wal.mtime_ns)` 未變 → getNewMessagesOnce
 *   回空、跳過開 DB（省 ~200MB decrypt/copy）。逐字對照 watch_json.py `wal_sig`/`poll`。
 *   （getMessagesSince 為 backfill 用，不做 stat-gate，永遠開 DB。）
 *
 * ── checkpoint（★遷移註記，見 port-plan §8.6）──
 *   格式相容 py `.watch_json_state`：`{ last_ts, sig }`。**位置改放 line-todo 的
 *   `app.getPath('userData')` 下**（不寫回 line-cua-win repo 根、不進 git 追蹤區）。
 *   首次啟用：line-todo 從全新（空）checkpoint 起算，第一次 getNewMessagesOnce 會
 *   把 last_ts 設到目前最新訊息（若無舊 checkpoint 且無新訊息，見 poll 尾段），
 *   或回一批「> last_ts=0」的訊息——這批可能與舊 py checkpoint 已報過的訊息重疊，
 *   造成「重報一批舊訊息」。**此重報靠下游以 msgId 去重可擋**（deriveMsgId 用
 *   `i:<msgId>` 為真鍵），故可接受；此處於檔頭明確註記此行為。checkpoint 路徑
 *   設計成可注入（opts.stateFile），測試用臨時路徑。
 *
 * ── key 取得 ──
 *   呼叫 `linekey.getKey()`（env → cache → live recover）。三段皆 miss → 拋
 *   `KeyUnavailableError`，讓下游辨識 key 失敗（本批以 throw 表達，不重現 py
 *   exit code 2——那是 spawn 時代語意，Batch 4b 再對應下游整合）。
 *
 * ── 錯誤語意 ──
 *   - key 不可得 → throw KeyUnavailableError。
 *   - DB 找不到 / 解密失敗 → openDb 拋 Error（訊息為 py 風格 JSON 字串）。
 *   - 媒體解不了的 gate 已在 rowToObj（回 null，不 throw）。
 */
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Database as Db } from 'better-sqlite3'

import { chatName, findDb, iso, myMid, newMessages, openDb } from './linedb'
import { getKey, type GetKeyOptions } from './linekey'
import { rowToObj, type MessageRow, type RowContext } from './rowToObj'
import type { RawLineMessage } from '../types'

/** 預設每次 poll 的安全上限（對齊 watch_json.py argparse `--limit` default 500）。 */
export const DEFAULT_LIMIT = 500

/** checkpoint 檔內容（格式相容 py `.watch_json_state`）。 */
export interface WatchState {
  /** 已報過的最大 `_createdTime`（epoch ms）。 */
  last_ts: number
  /** stat-gate 簽章（edb/wal 的 size+mtime_ns）；未知為 null。 */
  sig: WalSig | null
}

/** wal_sig：edb + -wal 的 (size, mtime_ns)。對照 watch_json.py `wal_sig`。 */
export interface WalSig {
  /** 主 edb 的 [size, mtime_ns]；stat 失敗為 null。 */
  edb: [number, number] | null
  /** -wal 的 [size, mtime_ns]；stat 失敗為 null。 */
  ['-wal']: [number, number] | null
}

/** watchEngine 各 API 共用選項。 */
export interface WatchEngineOptions {
  /** LINE DB 路徑；省略則 findDb()。 */
  dbPath?: string | null
  /** checkpoint 檔路徑；省略則 <userData>/.watch_json_state。 */
  stateFile?: string
  /** 每次取訊上限（對齊 py --limit，default 500）。 */
  limit?: number
  /** 限定單一 chat（名稱或 chatId，對齊 py --name）。 */
  name?: string | null
  /** getKey 選項透傳（測試冷啟/自訂快取用）。 */
  keyOpts?: GetKeyOptions
}

/** key 三段（env/cache/recover）皆 miss 時拋此錯，讓下游辨識為 key 失敗。 */
export class KeyUnavailableError extends Error {
  constructor(message = 'LINE DB key unavailable (env/cache/recover all miss)') {
    super(message)
    this.name = 'KeyUnavailableError'
  }
}

/**
 * defaultStateFile — checkpoint 預設路徑：<userData>/.watch_json_state。
 *
 * py 放在 line-cua-win repo 根（`linekey.REPO_ROOT`）；本 App 改放 Electron 的
 * userData（見檔頭 §8.6 遷移註記）。app.getPath 只在 Electron 主程序可用；純
 * Node 測試環境惰性 require 失敗時 fallback 到 env 推導路徑，並允許呼叫端注入
 * 覆寫（opts.stateFile）。與 linekey.ts 的 defaultCacheFile 同款惰性載入策略。
 */
export function defaultStateFile(): string {
  try {
    const electron = require('electron') as { app?: { getPath?: (n: string) => string } }
    const userData = electron?.app?.getPath?.('userData')
    if (userData) return join(userData, '.watch_json_state')
  } catch {
    // 非 Electron 環境 —— 落到下方 fallback。
  }
  const base =
    process.env.LINE_TODO_USERDATA?.trim() ||
    (process.env.APPDATA ? join(process.env.APPDATA, 'line-todo') : process.cwd())
  return join(base, '.watch_json_state')
}

/**
 * walSig(src) — edb + -wal 的 (size, mtime_ns)，cheap「LINE DB 變了嗎」gate。
 * 逐字對照 watch_json.py `wal_sig`：對 "" 與 "-wal" 兩個 ext 各 stat 一次，
 * 記 (size, mtime_ns)；stat 失敗（檔不存在）該 ext 記 null。
 *
 * mtime_ns：Node `statSync(..., { bigint: true }).mtimeNs` 提供奈秒精度（與 py
 * `st_mtime_ns` 同單位）。轉 number 用於 JSON 序列化——ms epoch 的 ns 值
 * （~1.7e18）超過 Number.MAX_SAFE_INTEGER（9e15），故簽章比對只需「相等/不等」
 * 語意，這裡以字串化 bigint 轉 Number 會失精度但**兩次呼叫失精度方式一致**，
 * 比對仍正確（未變→同值、變了→不同值）。為穩妥直接存為 number（size 亦然）。
 */
export function walSig(src: string | null): WalSig {
  const sig: WalSig = { edb: null, '-wal': null }
  for (const ext of ['', '-wal'] as const) {
    const p = (src || '') + ext
    try {
      const st = statSync(p, { bigint: true })
      const key = ext === '' ? 'edb' : '-wal'
      sig[key] = [Number(st.size), Number(st.mtimeNs)]
    } catch {
      // 檔不存在 → 該 ext 記 null（對照 py except OSError）。
    }
  }
  return sig
}

/** 兩個 WalSig 是否相等（deep，對照 py dict 相等比對）。 */
function sigEqual(a: WalSig | null, b: WalSig | null): boolean {
  if (a === null || b === null) return a === b
  const pairEq = (x: [number, number] | null, y: [number, number] | null): boolean => {
    if (x === null || y === null) return x === y
    return x[0] === y[0] && x[1] === y[1]
  }
  return pairEq(a.edb, b.edb) && pairEq(a['-wal'], b['-wal'])
}

/**
 * loadState — 讀 checkpoint；不存在/壞 JSON → { last_ts: 0, sig: null }。
 * 對照 watch_json.py `load_state`（except → 預設）。
 */
export function loadState(stateFile: string): WatchState {
  try {
    const raw = readFileSync(stateFile, 'utf8')
    const parsed = JSON.parse(raw) as Partial<WatchState>
    return {
      last_ts: typeof parsed.last_ts === 'number' ? parsed.last_ts : 0,
      sig: parsed.sig ?? null,
    }
  } catch {
    return { last_ts: 0, sig: null }
  }
}

/**
 * saveState — 寫 checkpoint（非致命，寫失敗吞掉）。
 * 對照 watch_json.py `save_state`（except OSError: pass — 最差下次重報一批）。
 * 用「寫 temp + rename」避免併發讀到半寫檔（py 直接覆寫；此加固不改語意）。
 */
export function saveState(stateFile: string, s: WatchState): void {
  try {
    const tmp = stateFile + '.tmp'
    writeFileSync(tmp, JSON.stringify(s), 'utf8')
    renameSync(tmp, stateFile)
  } catch {
    // 非致命；最差下次重報一批訊息（下游 msgId 去重會擋）。
  }
}

/**
 * rowsToContract — 開好的 DB 連線上，取 since 之後的新訊息並轉 NDJSON 契約物件。
 *
 * 組合 linedb.newMessages（原始 row）+ linedb.chatName/myMid/iso（上下文）+
 * rowToObj（純函式契約轉換）。等同 watch_json.py `new_messages` 迴圈裡對每 row
 * 呼叫 `row_to_obj(con, me, ...)`——py 版 row_to_obj 內部即時查 chat_name(c)/
 * chat_name(frm)、算 iso(t)；這裡把那些查詢提到呼叫端注入（rowToObj 為純函式）。
 */
function rowsToContract(
  con: Db,
  sinceTs: number,
  name: string | null | undefined,
  limit: number,
): RawLineMessage[] {
  const me = myMid(con)
  const rows = newMessages(con, sinceTs, name, limit)
  const out: RawLineMessage[] = []
  for (const r of rows) {
    const msgRow: MessageRow = {
      chatId: r.chatId,
      createdTime: r.createdTime,
      // rowToObj.MessageRow.from 為 string；LINE row `_from` 可能為 null（系統列），
      // 以空字串代入使 direction 判定與 sender fallback 與 py 一致（py `frm==me`
      // 對 None 為 False → 'in'，sender 回 chat_name(None)||None）。這裡 senderName
      // 已由 chatName(null-ish) 解出，from 空字串僅作 sender 的最終 fallback。
      from: r.from ?? '',
      text: r.text,
      contentType: r.contentType,
      id: r.msgId,
      contentMetadata: r.contentMetadata,
      contentInfo: r.contentInfo,
      attribute: r.attribute,
    }
    const ctx: RowContext = {
      myMid: me,
      iso: (ts: number) => iso(ts),
      chatName: chatName(con, r.chatId),
      senderName: r.from ? chatName(con, r.from) : null,
    }
    out.push(rowToObj(msgRow, ctx))
  }
  return out
}

/**
 * resolveKeyOrThrow — 取 DB key；三段皆 miss 拋 KeyUnavailableError。
 * dbPath 透傳給 getKey（cache 段的 test-decrypt 需要它）。
 */
function resolveKeyOrThrow(dbPath: string | null, keyOpts?: GetKeyOptions): string {
  const key = getKey({ ...keyOpts, dbPath })
  if (!key) throw new KeyUnavailableError()
  return key
}

/**
 * getMessagesSince(ms, opts?) — 對照 py `--since <ms>`。
 *
 * **不吃 checkpoint、不改 state**（backfill / debug 用）。開 DB → newMessages(ms)
 * → 每 row 轉 rowToObj 契約 → 回 RawLineMessage[]。無 stat-gate（backfill 明確
 * 要求「無論 DB 是否變都要撈」）。
 */
export async function getMessagesSince(
  ms: number,
  opts: WatchEngineOptions = {},
): Promise<RawLineMessage[]> {
  const dbPath = opts.dbPath ?? findDb()
  const key = resolveKeyOrThrow(dbPath, opts.keyOpts)
  const limit = opts.limit ?? DEFAULT_LIMIT
  const { con, cleanup } = openDb(key, dbPath)
  try {
    return rowsToContract(con, ms, opts.name, limit)
  } finally {
    cleanup()
  }
}

/**
 * getNewMessagesOnce(opts?) — 對照 py `--once`（預設）+ `poll`。
 *
 * 自 checkpoint 讀 last_ts → stat-gate → 取增量 → 更新 checkpoint → 回增量。
 *
 * 逐步對照 watch_json.py `poll`：
 *   1. load_state()。
 *   2. wal_sig()；若 sig 未變且已有 last_ts → 回 []（跳過開 DB，省 decrypt/copy）。
 *   3. 開 DB、newMessages(last_ts)。
 *   4. 有新訊息 → last_ts = max(m.ts)；否則若尚無 last_ts → last_ts = MAX(_createdTime)。
 *   5. sig = 新 sig；save_state。
 *   6. 回新訊息（下游負責 emit / 入庫）。
 */
export async function getNewMessagesOnce(
  opts: WatchEngineOptions = {},
): Promise<RawLineMessage[]> {
  const dbPath = opts.dbPath ?? findDb()
  const stateFile = opts.stateFile ?? defaultStateFile()
  const limit = opts.limit ?? DEFAULT_LIMIT

  const s = loadState(stateFile)
  const sig = walSig(dbPath)
  // stat-gate：sig 未變且已有 last_ts → 跳過開 DB。
  if (s.sig !== null && sigEqual(s.sig, sig) && s.last_ts) {
    return []
  }

  const key = resolveKeyOrThrow(dbPath, opts.keyOpts)
  const { con, cleanup } = openDb(key, dbPath)
  let msgs: RawLineMessage[]
  try {
    msgs = rowsToContract(con, s.last_ts ?? 0, opts.name, limit)
    if (msgs.length > 0) {
      // reduce（非 Math.max(...spread)）：msgs 可達數十萬筆（首啟/backfill 大批），
      // 把大陣列 spread 進 Math.max 會爆 call stack（RangeError）。
      let maxTs = msgs[0].ts
      for (let i = 1; i < msgs.length; i++) {
        if (msgs[i].ts > maxTs) maxTs = msgs[i].ts
      }
      s.last_ts = maxTs
    } else if (!s.last_ts) {
      // 尚無 checkpoint 且無新訊息 → 起算點設到目前最新訊息（對照 py）。
      const row = con.prepare('SELECT MAX(_createdTime) AS m FROM _message').get() as
        | { m: number | null }
        | undefined
      s.last_ts = (row && row.m) || 0
    }
  } finally {
    cleanup()
  }
  s.sig = sig
  saveState(stateFile, s)
  return msgs
}

/**
 * resetNow(opts?) — 對照 py `--reset-now`。
 *
 * 把 checkpoint 設到目前最新訊息（last_ts = MAX(_createdTime)、sig = 現在 sig），
 * **不回舊訊息**。回設定後的 last_ts（對照 py stderr 的 `{"event":"reset","last_ts"}`
 * 狀態資訊；本批以回傳值表達，不走 stderr）。
 */
export async function resetNow(opts: WatchEngineOptions = {}): Promise<number> {
  const dbPath = opts.dbPath ?? findDb()
  const stateFile = opts.stateFile ?? defaultStateFile()
  const key = resolveKeyOrThrow(dbPath, opts.keyOpts)
  const { con, cleanup } = openDb(key, dbPath)
  let ts: number
  try {
    const row = con.prepare('SELECT MAX(_createdTime) AS m FROM _message').get() as
      | { m: number | null }
      | undefined
    ts = (row && row.m) || 0
  } finally {
    cleanup()
  }
  saveState(stateFile, { last_ts: ts, sig: walSig(dbPath) })
  return ts
}
