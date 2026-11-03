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
 *   - getLineImportBatch/commitAndAcknowledgeLineImportBatch：durable watch import。
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
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { getLineEnginePorts } from './enginePorts'
import { chatAvatarSource, chatName, findDb, iso, myMid, newMessagesAfter, senderAvatarSource, senderName, type Db, type LineAvatarSource, type NewMessageRow } from './linedb'
import { openLineDbFor } from './lineAccess'
import type { GetKeyOptions } from './linekey'
import { rowToObj } from './rowToObj'
import type { RawLineMessage } from '../types'
import type { LineImportAvatarMeta, LineImportBatch, LineImportItem, LineSourceCursor } from '../importTypes'

/** 預設每次 poll 的安全上限（對齊 watch_json.py argparse `--limit` default 500）。 */
export const DEFAULT_LIMIT = 500

/** checkpoint 檔內容（格式相容 py `.watch_json_state`）。 */
export interface WatchState {
  /** 已報過的最大 `_createdTime`（epoch ms）。 */
  last_ts: number
  /** Durable importer cursor; old last_ts-only state is replayed from origin safely. */
  cursor?: LineSourceCursor
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
  /** Backfill/reconcile upper bound (exclusive), so a month scan never commits rows owned by the next month. */
  createdTimeExclusive?: number
  /** getKey 選項透傳（測試冷啟/自訂快取用）。 */
  keyOpts?: GetKeyOptions
  /** 預設 false（standalone 逐字不變）。true＝順便用同一條已開的連線收集這批訊息的聊天室／發話者頭像來源，交給匯入端寫進本地頭像表。 */
  avatarMeta?: boolean
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
 * stat 經 `LineFsPort.stat`（standalone＝`statSync(p, { bigint: true })`）。
 */
export function walSig(src: string | null): WalSig {
  const fs = getLineEnginePorts().fs
  const sig: WalSig = { edb: null, '-wal': null }
  for (const ext of ['', '-wal'] as const) {
    const p = (src || '') + ext
    try {
      const st = fs.stat(p)
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
    const raw = getLineEnginePorts().fs.readTextFile(stateFile)
    const parsed = JSON.parse(raw) as Partial<WatchState>
    return {
      last_ts: typeof parsed.last_ts === 'number' ? parsed.last_ts : 0,
      cursor: parsed.cursor && typeof parsed.cursor.createdTime === 'number' && typeof parsed.cursor.rowId === 'number'
        ? parsed.cursor : undefined,
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
    const fs = getLineEnginePorts().fs
    const tmp = stateFile + '.tmp'
    fs.writeTextFile(tmp, JSON.stringify(s))
    fs.renameFile(tmp, stateFile)
  } catch {
    // 非致命；最差下次重報一批訊息（下游 msgId 去重會擋）。
  }
}

/** Strict checkpoint write used only after a durable import transaction succeeds. */
export function saveStateStrict(stateFile: string, s: WatchState): void {
  const fs = getLineEnginePorts().fs
  const tmp = stateFile + '.tmp'
  fs.ensureDir(dirname(stateFile))
  fs.writeTextFile(tmp, JSON.stringify(s))
  fs.renameFile(tmp, stateFile)
}

/**
 * 金鑰與開 DB 都集中在 lineAccess.ts 的 `openLineDbFor`：沒注入 access（standalone）＝同步 `getKey` + `openDb` 的舊流程，
 * 有 `keyOpts.recoverGuard`（外掛 backend）＝協作式 `getKeyAsync`（掃記憶體時讓出事件迴圈、single-flight、失敗退避；review F2）。
 * 三段金鑰皆 miss 時丟 KeyUnavailableError，讓下游辨識為 key 失敗。
 */
const keyUnavailable = (): Error => new KeyUnavailableError()

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
  // Legacy callers retain a RawLineMessage[] API, but use the same import page
  // reader/converter as live watch. Durable receipt/participant commit is owned by
  // the caller's existing persistence path until those backfill callers migrate.
  // Preserve the legacy `_createdTime > ms` contract while import callers use explicit composite cursors.
  const batch = await getLineImportBatch({ ...opts, avatarMeta: false, source: 'line-backfill', cursor: { createdTime: ms, rowId: Number.MAX_SAFE_INTEGER } })
  return batch.items.map((item) => item.message)
}

/**
 * 收集這批訊息的頭像來源：每個不同的聊天室一次 `chatAvatarSource`、每個不同的（聊天室, 發話者）一次 `senderAvatarSource`（自己的 accountMid 不收）。
 * 查詢數只和「不同的聊天室／發話者」有關（每個發話者 ≤7、每個聊天室 ≤8 次點查），和列數無關；任何一筆失敗都只是少一筆。
 */
export function collectAvatarMeta(con: Db, rows: readonly NewMessageRow[], accountMid: string | null): LineImportAvatarMeta {
  const meta: LineImportAvatarMeta = { chats: [], senders: [] }
  const seenChats = new Set<string>()
  const seenSenders = new Set<string>()
  for (const r of rows) {
    if (!seenChats.has(r.chatId)) {
      seenChats.add(r.chatId)
      try { meta.chats.push({ chatId: r.chatId, source: chatAvatarSource(con, r.chatId) }) } catch { /* 少一筆，不影響匯入 */ }
    }
    if (!accountMid || !r.from || r.from === accountMid) continue
    const key = `${r.chatId}\0${r.from}`
    if (seenSenders.has(key)) continue
    seenSenders.add(key)
    try { meta.senders.push({ chatId: r.chatId, senderMid: r.from, source: senderAvatarSource(con, r.chatId, r.from) }) } catch { /* 同上 */ }
  }
  return meta
}

/**
 * Read one import page without advancing the source checkpoint. The caller must
 * commit messages, participant pseudonyms and the receipt, then call
 * acknowledgeLineImportBatch. Cursor ordering is (createdTime, source rowid).
 */
export async function getLineImportBatch(
  opts: WatchEngineOptions & { source?: LineImportBatch['source']; cursor?: LineSourceCursor } = {},
): Promise<LineImportBatch> {
  const dbPath = opts.dbPath ?? findDb()
  const stateFile = opts.stateFile ?? defaultStateFile()
  const persisted = loadState(stateFile)
  const cursorFrom = opts.cursor ?? persisted.cursor ?? { createdTime: 0, rowId: 0 }
  const sourceSig = walSig(dbPath)
  if (!opts.cursor && persisted.cursor && persisted.sig !== null && sigEqual(persisted.sig, sourceSig)) {
    const batchId = createHash('sha256').update(`${opts.source ?? 'line-watch'}\0${cursorFrom.createdTime}:${cursorFrom.rowId}\0${cursorFrom.createdTime}:${cursorFrom.rowId}`).digest('hex')
    return { batchId, source: opts.source ?? 'line-watch', cursorFrom, cursorTo: cursorFrom, hasMore: false, observedAt: new Date().toISOString(), items: [] }
  }
  const { con, cleanup } = await openLineDbFor({ dbPath, policy: 'fresh', keyOpts: opts.keyOpts, keyMissing: keyUnavailable })
  try {
    const limit = opts.limit ?? DEFAULT_LIMIT
    const rows = newMessagesAfter(con, cursorFrom, opts.name, limit + 1, opts.createdTimeExclusive)
    const hasMore = rows.length > limit
    if (hasMore) rows.pop()
    const accountMid = myMid(con)
    const items: LineImportItem[] = rows.map((r) => {
      const message = rowToObj({ chatId: r.chatId, createdTime: r.createdTime, from: r.from ?? '', text: r.text,
        contentType: r.contentType, id: r.msgId, contentMetadata: r.contentMetadata, contentInfo: r.contentInfo,
        attribute: r.attribute }, {
        myMid: accountMid, iso: (ts) => iso(ts), chatName: chatName(con, r.chatId), senderName: r.from ? senderName(con, r.chatId, r.from) : null
      })
      return { message, sourceRowId: r.rowId, senderMid: r.from, accountMid }
    })
    const cursorTo = rows.length ? { createdTime: rows[rows.length - 1].createdTime, rowId: rows[rows.length - 1].rowId } : cursorFrom
    const batchId = createHash('sha256').update(`${opts.source ?? 'line-watch'}\0${cursorFrom.createdTime}:${cursorFrom.rowId}\0${cursorTo.createdTime}:${cursorTo.rowId}`).digest('hex')
    const avatarMeta = opts.avatarMeta ? collectAvatarMeta(con, rows, accountMid) : undefined
    return { batchId, source: opts.source ?? 'line-watch', cursorFrom, cursorTo, hasMore, observedAt: new Date().toISOString(), items, ...(avatarMeta ? { avatarMeta } : {}) }
  } finally {
    cleanup()
  }
}

export interface LineAvatarMetadataBatch {
  chats: Record<string, LineAvatarSource>
  messages: Record<string, LineAvatarSource>
  /** 這次讀取的來源所認得的自己的 MID（讀不到＝null）。只給本地頭像表的 write-through 排除自己用，avatar.ts 不使用。 */
  accountMid?: string | null
}

/** 頭像請求的輸入正規化（上限與格式）：getAvatarMetadata 與本地優先的 layered reader 共用。 */
export function normalizeAvatarRequest(
  input: { chatIds?: readonly string[]; chatId?: string; msgIds?: readonly string[] },
): { chatIds: string[]; chatId: string | null; msgIds: string[] } {
  const chatIds = [...new Set((input.chatIds ?? []).filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 128))].slice(0, 100)
  const chatId = typeof input.chatId === 'string' && input.chatId.length > 0 && input.chatId.length <= 128 ? input.chatId : null
  const msgIds = [...new Set((input.msgIds ?? []).filter((id) => typeof id === 'string' && /^i:.{1,160}$/u.test(id)))].slice(0, 200)
  return { chatIds, chatId, msgIds }
}

/**
 * Read only the requested visible chat identities and source message ids for avatar/name enrichment.
 * The caller keeps source ids/locators in the main process and sends only generated asset paths to UI.
 */
export async function getAvatarMetadata(
  input: { chatIds?: readonly string[]; chatId?: string; msgIds?: readonly string[] },
  opts: Pick<WatchEngineOptions, 'dbPath' | 'keyOpts'> = {},
): Promise<LineAvatarMetadataBatch> {
  const { chatIds, chatId, msgIds } = normalizeAvatarRequest(input)
  const result: LineAvatarMetadataBatch = { chats: {}, messages: {} }
  if (chatIds.length === 0 && (!chatId || msgIds.length === 0)) return result

  const dbPath = opts.dbPath ?? findDb()
  if (!dbPath) return result
  // Avatars accept a stale snapshot ('any'): they use only the key the import path already validated (in process memory) and the snapshot
  // that already exists, and never trigger a copy or a key scan. Nothing available yet = an empty result (text avatars), not an error.
  const opened = await openLineDbFor({ dbPath, policy: 'any', keyOpts: opts.keyOpts, keyMissing: keyUnavailable })
  if (!opened) return result
  const { con, cleanup } = opened
  try {
    try { result.accountMid = myMid(con) } catch { result.accountMid = null }
    for (const id of chatIds) result.chats[id] = chatAvatarSource(con, id)
    if (chatId && msgIds.length > 0) {
      const bySourceId = new Map<string, string>()
      for (const localId of msgIds) bySourceId.set(localId.slice(2), localId)
      for (const [sourceId, localId] of bySourceId) {
        let row: { _from: string | null } | undefined
        try {
          row = con.prepare('SELECT _from FROM _message WHERE _chatId=? AND CAST(_id AS TEXT)=? LIMIT 1').get(chatId, sourceId) as { _from: string | null } | undefined
        } catch { /* malformed or legacy source schema */ }
        if (row?._from) result.messages[localId] = senderAvatarSource(con, chatId, row._from)
      }
    }
  } finally {
    cleanup()
  }
  return result
}

export type AcknowledgeOptions = Pick<WatchEngineOptions, 'stateFile' | 'dbPath'> & {
  /** batch.hasMore 時不寫 stat-gate 簽章（讓下一輪 poll 繼續讀 backlog）。預設 false＝standalone 現行行為。 */
  openGateWhenMore?: boolean
}

/** Advance checkpoint only after the main-process DB commit has returned success. */
export function acknowledgeLineImportBatch(batch: LineImportBatch, opts: AcknowledgeOptions = {}): void {
  const stateFile = opts.stateFile ?? defaultStateFile()
  const state = loadState(stateFile)
  const current = state.cursor ?? { createdTime: 0, rowId: 0 }
  if (current.createdTime !== batch.cursorFrom.createdTime || current.rowId !== batch.cursorFrom.rowId) {
    throw new Error('LINE import cursor changed before batch acknowledgement')
  }
  state.cursor = batch.cursorTo
  state.last_ts = batch.cursorTo.createdTime
  // 預設（standalone）：記下 stat-gate 簽章。backlog 還沒讀完（hasMore）又要求不卡 gate 時留 null，下一輪 poll 才會接著讀，
  // 不會被「檔案沒變」的 gate 擋成空批（外掛首次匯入大量歷史訊息用）。
  state.sig = opts.openGateWhenMore && batch.hasMore ? null : walSig(opts.dbPath ?? findDb())
  saveStateStrict(stateFile, state)
}

/** The source cursor moves only after the caller's durable transaction resolves. */
export async function commitAndAcknowledgeLineImportBatch(
  batch: LineImportBatch,
  commit: (batch: LineImportBatch) => void | Promise<void>,
  opts: AcknowledgeOptions = {},
): Promise<void> {
  // Empty terminal pages are durable observations too; commit their receipt before acknowledging.
  await commit(batch)
  acknowledgeLineImportBatch(batch, opts)
}

/**
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
  const { con, cleanup } = await openLineDbFor({ dbPath, policy: 'fresh', keyOpts: opts.keyOpts, keyMissing: keyUnavailable })
  let ts: number
  try {
    const row = con.prepare('SELECT _createdTime AS m, rowid AS rid FROM _message ORDER BY _createdTime DESC, rowid DESC LIMIT 1').get() as
      | { m: number | null; rid: number }
      | undefined
    ts = (row && row.m) || 0
    saveState(stateFile, { last_ts: ts, cursor: row ? { createdTime: row.m ?? 0, rowId: row.rid } : { createdTime: 0, rowId: 0 }, sig: walSig(dbPath) })
  } finally {
    cleanup()
  }
  return ts
}
