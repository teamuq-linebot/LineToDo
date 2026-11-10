/**
 * linedb.ts — 純 TS 讀取 LINE-for-Windows 加密本機訊息 DB（Batch 1）。
 *
 * 逐一對照外部 Python 引擎 `line-cua-win/src/linedb.py`（＋`linekey.py` 的
 * `find_db`/cipher 參數），行為求 byte-level parity。用
 * `better-sqlite3-multiple-ciphers` 以 wxSQLite3 / QtCipherSqlitePlugin
 * AES-128-CBC（`PRAGMA cipher='aes128cbc'; kdf_iter=1; key=<32-hex>`）開啟，
 * 與 Python 端 `apsw-sqlite3mc` 同源、PRAGMA 介面一致。
 *
 * 開檔序列（照 py，嚴禁直接開 live edb）：先把 edb + -wal + -shm 三檔 snapshot
 * 複製到 temp 目錄，以 read-write 開啟 COPY 讓 WAL merge 進來（最新訊息可見），
 * 驗 `SELECT count(*) FROM sqlite_master`，再 `PRAGMA wal_checkpoint(TRUNCATE)`。
 *
 * 本批只新增此檔（含型別），不改動任何現有執行路徑（watcher/pipeline/lineBridge）。
 * 金鑰採注入式 `getKey()` callback（recover 屬 Batch 2）。
 *
 * I/O 一律經 port（Phase 0）：檔案系統走 `LineFsPort`、SQLite 引擎走 `SqliteEnginePort`，
 * 由組裝根經 `configureLineEnginePorts()` 注入；standalone 預設為 node:fs +
 * better-sqlite3-multiple-ciphers，行為與先前相同。
 */
import { copySnapshot, findDbPath } from './fsPort'
import { DEFAULT_LINE_DB_DIR, getLineEnginePorts } from './enginePorts'
import type { LineDbHandle } from './sqlitePort'
import { normalizeMsgId, toSafeNumber } from './wasm/int64'

/** 引擎中立的 LINE DB 連線型別（better-sqlite3 Database 結構相容）。 */
export type Db = LineDbHandle

// cipher 參數 —— 逐字對齊 linekey.py:23-24。
export const CIPHER = 'aes128cbc'
export const KDF_ITER = 1

/** %LOCALAPPDATA%\LINE\Data\db —— 對齊 linekey.py:19。實際搜尋目錄以注入的 `dbDir` 為準（預設即此值）。 */
export const DB_DIR = DEFAULT_LINE_DB_DIR

/**
 * LINE message _contentType -> label（非文字訊息）。
 * 逐字對齊 linedb.py:134-135 的 `CT` dict（含 0 -> null）。
 */
export const CT: Record<number, string | null> = {
  0: null,
  1: '[image]',
  2: '[video]',
  3: '[audio]',
  7: '[sticker]',
  6: '[call]',
  13: '[contact]',
  14: '[file]',
  16: '[album]',
}

/** `newMessages` 回傳的原始 row（對齊 watch_json.py `new_messages` 的 SELECT 欄位）。 */
export interface NewMessageRow {
  /** Source SQLite rowid; used only as a deterministic paging tie-breaker. */
  rowId: number
  chatId: string
  createdTime: number
  from: string | null
  text: string | null
  contentType: number | null
  msgId: number | string | null
  contentMetadata: string | null
  contentInfo: string | null
  attribute: number | null
}

/** 一筆 `_chat` 列（對齊 linedb.py `list_chats`）。 */
export interface ChatRow {
  chatId: string
  name: string | null
  lastUpdated: string | null
  isGroup: boolean
}

/**
 * findDb() — 主訊息 DB = 最大那顆 `qw<hex>.edb`（無 '_' 前綴 sibling）。
 * 逐字對齊 linekey.py:27-33（`find_db`）：glob `qw*.edb`、排除檔名含 '_'、取最大。
 */
export function findDb(): string | null {
  const { fs, dbDir } = getLineEnginePorts()
  return findDbPath(fs, dbDir)
}

/**
 * openSnapshotDb(path, key, options?) — 開一份已經就位的 snapshot：開檔 → PRAGMA → 驗解密 → WAL checkpoint。
 *
 * 從 `openDb` 抽出（步驟 2–5 逐字不變），讓持久 snapshot（lineSnapshot／lineAccess）複用同一段開檔與驗證，
 * 不必再複製一份 DB。`openDb` 的複製、錯誤包裝與 cleanup 順序和先前相同。
 *
 *   - 開檔失敗：原樣丟出引擎的錯誤。
 *   - PRAGMA／驗解 SQL 失敗：關掉連線，丟出 `decryption failed` 的 Error（訊息不變，原因放在 `cause`）。
 *   - `options.checkpoint === false`：不做 `wal_checkpoint(TRUNCATE)`。持久 snapshot 不可被改動（讀寫引擎的 checkpoint 會把 WAL 併進本地 edb），所以 lineAccess 傳 false；預設 true＝`openDb` 的舊行為。
 */
export function openSnapshotDb(path: string, key: string, options: { checkpoint?: boolean } = {}): Db {
  const { sqlite } = getLineEnginePorts()
  // 開 COPY read-write，讓 WAL merge 進來（最新訊息可見）。
  const con = sqlite.open(path)
  try {
    // PRAGMA 順序逐字對齊 py：cipher → kdf_iter → key。
    // better-sqlite3(-multiple-ciphers) 的 pragma() 用 "name=value" 字串形式
    // （對照 scripts/spike/ciphers-spike.cjs 已驗證的正確寫法）。
    con.pragma(`cipher='${CIPHER}'`)
    con.pragma(`kdf_iter=${KDF_ITER}`)
    con.pragma(`key='${key}'`)
    // 驗解密 —— 錯 key / 錯 cipher 參數會在此拋。
    con.prepare('SELECT count(*) FROM sqlite_master').get()
  } catch (cause) {
    try {
      con.close()
    } catch {
      // ignore
    }
    throw new Error(
      JSON.stringify({ error: 'decryption failed — wrong key or cipher params' }),
      { cause },
    )
  }
  if (options.checkpoint !== false) {
    try {
      con.pragma('wal_checkpoint(TRUNCATE)')
    } catch {
      // 非致命（對齊 py 的 try/except pass）
    }
  }
  return con
}

/**
 * openDb(key, srcPath?) — snapshot + 開 RW COPY + 驗解 + WAL checkpoint。
 *
 * 逐步對齊 linedb.py:30-57（`open_db`）：
 *   1. 複製 edb/-wal/-shm 三檔到 temp（若存在）。
 *   2. 以 read-write 開啟 COPY（讓 WAL merge 進來）。
 *   3. PRAGMA cipher → kdf_iter → key（順序照 py）。
 *   4. `SELECT count(*) FROM sqlite_master` 驗解密；失敗即拋。
 *   5. `PRAGMA wal_checkpoint(TRUNCATE)`（失敗吞掉，非致命）。
 *
 * 回傳 { con, cleanup }：呼叫端用完須呼叫 cleanup() 關連線 + 刪 temp 目錄
 * （對齊 py 的 atexit rmtree，但 TS 無 atexit 語意，改顯式交還）。
 */
export function openDb(
  key: string,
  srcPath?: string | null,
): { con: Db; cleanup: () => void } {
  const { fs, dbDir } = getLineEnginePorts()
  const src = srcPath ?? findDbPath(fs, dbDir)
  if (!src) {
    throw new Error(JSON.stringify({ error: 'LINE message DB not found', dir: dbDir }))
  }
  const tmp = fs.makeTempDir('linedb-')
  const cleanup = (): void => {
    try {
      fs.removeDir(tmp)
    } catch {
      // 非致命
    }
  }
  // 複製 edb + -wal + -shm（若存在），照 py 迴圈。
  const path = copySnapshot(fs, src, tmp, 'm.edb')
  let con: Db
  try {
    con = openSnapshotDb(path, key)
  } catch (e) {
    cleanup()
    throw e
  }
  const wrappedCleanup = (): void => {
    try {
      con.close()
    } catch {
      // ignore
    }
    cleanup()
  }
  return { con, cleanup: wrappedCleanup }
}

/** my_mid — 讀 `_profile._mid`。對齊 linedb.py:60-62。 */
export function myMid(con: Db): string | null {
  const r = con.prepare('SELECT _mid FROM _profile LIMIT 1').get() as
    | { _mid: string | null }
    | undefined
  return r ? r._mid : null
}

/** `_contact` 的欄位（原樣的欄位名）；contactLocator／contactName 只讀這幾個，缺欄位等同 NULL。 */
export interface ContactFields {
  _picturePath?: unknown
  _targetProfileDetail?: unknown
  _displayNameOverridden?: unknown
  _displayName?: unknown
}

/** LINE leaves `_contact._picturePath` NULL for some people but keeps the same path in `_targetProfileDetail` (JSON). Bad JSON or a missing field is simply "no picture". */
function detailPicturePath(detail: unknown): string | null {
  if (typeof detail !== 'string' || !detail.trim()) return null
  try {
    const path = (JSON.parse(detail) as { picturePath?: unknown } | null)?.picturePath
    return typeof path === 'string' && path.trim() ? path : null
  } catch {
    return null
  }
}

/** 聯絡人頭像 locator：先取 `_targetProfileDetail.picturePath`（目前的頭像），沒有（空白、缺欄位、壞 JSON）才取 `_picturePath`（可能已過期）。純函式。 */
export function contactLocator(row: ContactFields | null | undefined): string | null {
  const fromDetail = detailPicturePath(row?._targetProfileDetail)
  if (fromDetail) return fromDetail
  return typeof row?._picturePath === 'string' && row._picturePath.trim() ? row._picturePath : null
}

/** 聯絡人顯示名：_displayNameOverridden → _displayName → _targetProfileDetail.profileName（壞 JSON 跳過）。純函式。 */
export function contactName(row: ContactFields | null | undefined): string | null {
  if (!row) return null
  if (row._displayNameOverridden) return row._displayNameOverridden as string
  if (row._displayName) return row._displayName as string
  if (row._targetProfileDetail) {
    try {
      const pn = (JSON.parse(row._targetProfileDetail as string) as { profileName?: string }).profileName
      if (pn) return pn
    } catch {
      // 壞 JSON -> 跳過（對齊 py except Exception: pass）
    }
  }
  return null
}

/**
 * chatName — 把 chatId/mid 解成顯示名（1:1 / 群組 / community）。
 * 逐字對齊 linedb.py:65-92（`chat_name`）的解析順序與 fallback：
 *   _groupChat._chatName → _square._name → _contact
 *   (_displayNameOverridden → _displayName → _targetProfileDetail.profileName)。
 * _square 表可能不存在（py 用 try/except SQLError 吞掉）。
 */
export function chatName(con: Db, chatId: string): string | null {
  const g = con
    .prepare('SELECT _chatName FROM _groupChat WHERE _chatMid=?')
    .get(chatId) as { _chatName: string | null } | undefined
  if (g && g._chatName) return g._chatName

  // LINE Square chats are represented by _squareChat, not _square. Their chat
  // MID is still the canonical _chat._id, so keep the same key and resolve the
  // actual display name from the source row.
  try {
    const squareChat = con
      .prepare('SELECT _name FROM _squareChat WHERE _squareChatMid=?')
      .get(chatId) as { _name: string | null } | undefined
    if (squareChat?._name?.trim()) return squareChat._name
  } catch {
    // Older LINE schemas may not include Square tables.
  }

  try {
    const sq = con.prepare('SELECT _name FROM _square WHERE _mid=?').get(chatId) as
      | { _name: string | null }
      | undefined
    if (sq && sq._name) return sq._name
  } catch {
    // _square 表不存在 —— 對齊 py 的 except apsw.SQLError: pass
  }

  const ct = con
    .prepare(
      'SELECT _displayNameOverridden,_displayName,_targetProfileDetail FROM _contact WHERE _mid=?',
    )
    .get(chatId) as ContactFields | undefined
  return ct ? contactName(ct) : null
}

/** Resolve a sender's Square display name in the context of the active Square chat. */
export function squareMemberName(con: Db, chatId: string, senderMid: string): string | null {
  try {
    const row = con
      .prepare(
        'SELECT sm._displayName FROM _squareChat sc JOIN _squareMember sm ' +
          'ON sm._squareMid=sc._squareMid WHERE sc._squareChatMid=? AND sm._squareMemberMid=? LIMIT 1',
      )
      .get(chatId, senderMid) as { _displayName: string | null } | undefined
    return row?._displayName?.trim() ? row._displayName : null
  } catch {
    // Square tables are optional across LINE client versions.
    return null
  }
}

/** Resolve a sender using chat-scoped Square metadata before global contact names. */
export function senderName(con: Db, chatId: string, senderMid: string): string | null {
  return squareMemberName(con, chatId, senderMid) ?? chatName(con, senderMid)
}

export interface LineAvatarSource {
  /** Canonical LINE entity id; retained only in the main-process call path. */
  identity: string
  /** Profile path or the Square OBS hash. The caller validates/builds the final URL. */
  locator: string | null
  displayName: string | null
  source: 'profile' | 'square' | null
}

const SQUARE_OBS_HASH = /^0h[A-Za-z0-9_-]+$/u

function contactPicture(con: Db, identity: string): string | null {
  let row: { _picturePath?: string | null; _targetProfileDetail?: string | null } | undefined
  try {
    row = con.prepare('SELECT _picturePath,_targetProfileDetail FROM _contact WHERE _mid=?').get(identity) as typeof row
  } catch {
    try {
      row = con.prepare('SELECT _picturePath FROM _contact WHERE _mid=?').get(identity) as typeof row
    } catch {
      return null
    }
  }
  return contactLocator(row)
}

function profileSource(con: Db, identity: string): LineAvatarSource {
  let locator = contactPicture(con, identity)
  if (!locator) {
    try {
      const row = con.prepare('SELECT _picturePath FROM _profile WHERE _mid=?').get(identity) as { _picturePath?: string | null } | undefined
      if (typeof row?._picturePath === 'string' && row._picturePath.trim()) locator = row._picturePath
    } catch {
      // Older schemas can omit this optional table/column.
    }
  }
  return { identity, locator, displayName: chatName(con, identity), source: locator ? 'profile' : null }
}

/** Read chat image metadata without changing or deriving the canonical chat id. */
export function chatAvatarSource(con: Db, chatId: string): LineAvatarSource {
  try {
    const group = con.prepare('SELECT _picturePath FROM _groupChat WHERE _chatMid=?').get(chatId) as { _picturePath?: string | null } | undefined
    const groupPicture = groupLocator(group)
    if (groupPicture) {
      return { identity: chatId, locator: groupPicture, displayName: chatName(con, chatId), source: 'profile' }
    }
  } catch { /* optional LINE group schema */ }
  try {
    const square = con.prepare('SELECT _chatImageObsHash FROM _squareChat WHERE _squareChatMid=?').get(chatId) as { _chatImageObsHash?: string | null } | undefined
    const squarePicture = squareChatLocator(square)
    if (squarePicture) {
      return { identity: chatId, locator: squarePicture, displayName: chatName(con, chatId), source: 'square' }
    }
  } catch { /* optional LINE Square schema */ }
  return profileSource(con, chatId)
}

/** Read a sender image in the active chat's membership scope before general profile metadata. */
export function senderAvatarSource(con: Db, chatId: string, senderMid: string): LineAvatarSource {
  try {
    const member = con.prepare(
      'SELECT sm._displayName,sm._profileImageObsHash FROM _squareChat sc JOIN _squareMember sm ' +
        'ON sm._squareMid=sc._squareMid WHERE sc._squareChatMid=? AND sm._squareMemberMid=? LIMIT 1',
    ).get(chatId, senderMid) as { _displayName?: string | null; _profileImageObsHash?: string | null } | undefined
    if (member) {
      const hash = member._profileImageObsHash
      return {
        identity: senderMid,
        locator: typeof hash === 'string' && SQUARE_OBS_HASH.test(hash) ? hash : null,
        displayName: typeof member._displayName === 'string' && member._displayName.trim() ? member._displayName : null,
        source: typeof hash === 'string' && SQUARE_OBS_HASH.test(hash) ? 'square' : null,
      }
    }
  } catch { /* optional LINE Square schema */ }
  return profileSource(con, senderMid)
}

// ── 通訊錄同步用的分頁讀取（contactSync）──

/** keyset 游標：`rowid` 模式用 rowid 往後讀；WITHOUT ROWID 的表退回用主鍵欄位。 */
export interface KeysetCursor {
  mode: 'rowid' | 'key'
  after: number | string
}

export interface KeysetPage<T> {
  rows: T[]
  /** 下一頁的游標；null＝這張表讀完了。 */
  next: KeysetCursor | null
}

export interface GroupChatRow { _chatMid: string; _chatName?: unknown; _picturePath?: unknown }
export interface SquareChatRow { _squareChatMid: string; _name?: unknown; _chatImageObsHash?: unknown }
export interface ContactSourceRow extends ContactFields { _mid: string }

const ROWID_START = Number.MIN_SAFE_INTEGER
const chosenVariant = new WeakMap<object, Map<string, number>>()

function tableExists(con: Db, table: string): boolean {
  return con.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
}

/**
 * 通用 keyset 分頁。`variants` 由完整到精簡列出欄位組合（較舊的 LINE schema 可能缺欄位），用第一個查得動的；
 * 第一頁優先用 rowid，表是 WITHOUT ROWID 時退回主鍵欄位。不使用 OFFSET。表不存在回 null（呼叫端跳過這個 kind）；其他錯誤照丟。
 * 排序欄位的 NULL 與空字串在 key 模式下不會被讀到。
 */
function keysetRows<T extends object>(con: Db, table: string, keyCol: string, variants: readonly (readonly string[])[], cursor: KeysetCursor | null, limit: number): KeysetPage<T> | null {
  const modes: Array<KeysetCursor['mode']> = cursor ? [cursor.mode] : ['rowid', 'key']
  let lastError: unknown = null
  const memo = chosenVariant.get(con) ?? new Map<string, number>()
  chosenVariant.set(con, memo)
  for (const mode of modes) {
    const after = cursor ? cursor.after : mode === 'rowid' ? ROWID_START : ''
    const order = mode === 'rowid' ? 'rowid' : keyCol
    const head = mode === 'rowid' ? 'rowid AS _rowid,' : ''
    const known = memo.get(`${table}\0${mode}`)
    const all = variants.map((_, i) => i)
    const sequence = known === undefined ? all : [known, ...all.filter((i) => i !== known)]
    for (const index of sequence) {
      const sql = `SELECT ${head}${variants[index].join(',')} FROM ${table} WHERE ${order} > ? ORDER BY ${order} LIMIT ?`
      let rows: Array<Record<string, unknown>>
      try {
        rows = con.prepare(sql).all(after, limit) as Array<Record<string, unknown>>
      } catch (error) {
        lastError = error
        continue
      }
      memo.set(`${table}\0${mode}`, index)
      const out = rows.map((row) => {
        if (mode === 'rowid') { const { _rowid, ...rest } = row; void _rowid; return rest }
        return row
      }) as T[]
      if (rows.length < limit) return { rows: out, next: null }
      const lastRow = rows[rows.length - 1]
      const next: KeysetCursor = mode === 'rowid'
        ? { mode, after: toSafeNumber(lastRow._rowid as number | bigint) }
        : { mode, after: String(lastRow[keyCol]) }
      return { rows: out, next }
    }
  }
  if (!tableExists(con, table)) return null
  throw lastError ?? new Error('keyset_read_failed')
}

const CONTACT_VARIANTS = [
  ['_mid', '_picturePath', '_targetProfileDetail', '_displayNameOverridden', '_displayName'],
  ['_mid', '_picturePath', '_displayNameOverridden', '_displayName'],
  ['_mid', '_targetProfileDetail', '_displayNameOverridden', '_displayName'],
  ['_mid', '_picturePath', '_displayName'],
  ['_mid', '_displayName'],
  ['_mid'],
] as const
const GROUP_VARIANTS = [['_chatMid', '_chatName', '_picturePath'], ['_chatMid', '_chatName'], ['_chatMid', '_picturePath'], ['_chatMid']] as const
const SQUARE_CHAT_VARIANTS = [['_squareChatMid', '_name', '_chatImageObsHash'], ['_squareChatMid', '_name'], ['_squareChatMid']] as const

/** `_contact` 的一頁（缺表回 null；缺欄位退回較少的欄位組合）。 */
export function contactRowsAfter(con: Db, cursor: KeysetCursor | null, limit: number): KeysetPage<ContactSourceRow> | null {
  return keysetRows<ContactSourceRow>(con, '_contact', '_mid', CONTACT_VARIANTS, cursor, limit)
}

/** `_groupChat` 的一頁。 */
export function groupRowsAfter(con: Db, cursor: KeysetCursor | null, limit: number): KeysetPage<GroupChatRow> | null {
  return keysetRows<GroupChatRow>(con, '_groupChat', '_chatMid', GROUP_VARIANTS, cursor, limit)
}

/** `_squareChat` 的一頁（只有聊天室，不含 `_squareMember`）。 */
export function squareChatRowsAfter(con: Db, cursor: KeysetCursor | null, limit: number): KeysetPage<SquareChatRow> | null {
  return keysetRows<SquareChatRow>(con, '_squareChat', '_squareChatMid', SQUARE_CHAT_VARIANTS, cursor, limit)
}

/** 群組頭像 locator：`_picturePath`（非空白）。 */
export function groupLocator(row: Pick<GroupChatRow, '_picturePath'> | null | undefined): string | null {
  return typeof row?._picturePath === 'string' && row._picturePath.trim() ? row._picturePath : null
}

/** Square 聊天室頭像 locator：OBS hash 必須符合格式，否則沒有。 */
export function squareChatLocator(row: Pick<SquareChatRow, '_chatImageObsHash'> | null | undefined): string | null {
  const hash = row?._chatImageObsHash
  return typeof hash === 'string' && SQUARE_OBS_HASH.test(hash) ? hash : null
}

/**
 * iso(ms) — epoch 毫秒 -> 本地時區 ISO8601、秒精度、無時區後綴。
 *
 * ★ 本批最高優先 parity 點 ★
 * 逐字對齊 linedb.py:138-139：
 *   datetime.fromtimestamp(ms/1000).isoformat(timespec="seconds")
 * → **本地時區**、秒精度、無 'Z'/offset 後綴（如 "2026-07-03T14:05:09"）。
 * 絕不可用 Date.prototype.toISOString()（UTC）——那會使 time 欄系統性偏移。
 * ms 為 0/null/undefined 時回 null（對齊 py 的 `if ms` 短路）。
 */
export function iso(ms: number | null | undefined): string | null {
  if (!ms) return null
  const d = new Date(ms)
  // 手動以「本地時間」各欄位拼裝，避開 toISOString 的 UTC 轉換。
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const year = d.getFullYear()
  const month = p2(d.getMonth() + 1)
  const day = p2(d.getDate())
  const hh = p2(d.getHours())
  const mm = p2(d.getMinutes())
  const ss = p2(d.getSeconds())
  return `${year}-${month}-${day}T${hh}:${mm}:${ss}`
}

/**
 * listChats — 依 `_lastUpdatedTime` 降冪列 chat。對齊 linedb.py:95-110。
 * isGroup: chatId[:1] !== 'u'（fail-closed，非 1:1 一律當 group）。
 */
export function listChats(con: Db, limit = 50): ChatRow[] {
  const rows = con
    .prepare(
      'SELECT _id,_lastUpdatedTime,_lastMessage FROM _chat ORDER BY _lastUpdatedTime DESC LIMIT ?',
    )
    .all(limit) as Array<{ _id: string; _lastUpdatedTime: number | null }>
  return rows.map((r) => ({
    chatId: r._id,
    name: chatName(con, r._id),
    lastUpdated: iso(r._lastUpdatedTime),
    isGroup: r._id.slice(0, 1) !== 'u',
  }))
}

/**
 * resolveChat — name -> chatId。接受原始 chatId、精確名、或無歧義子字串。
 * 逐字對齊 linedb.py:113-130（`resolve_chat`）的優先序與歧義處理。
 * 歧義/找不到時拋 Error（訊息為 py 的 JSON 字串格式）。
 */
export function resolveChat(con: Db, name: string): string {
  const direct = con.prepare('SELECT 1 FROM _chat WHERE _id=? LIMIT 1').get(name)
  if (direct) return name

  const chats = listChats(con, 5000)
  const exact = chats.filter((c) => c.name === name)
  if (exact.length === 1) return exact[0].chatId
  if (exact.length > 1) {
    throw new Error(
      JSON.stringify({ error: 'ambiguous exact name', matches: exact.map((c) => c.name) }),
    )
  }
  const fuzzy = chats.filter((c) => c.name && c.name.includes(name))
  if (fuzzy.length === 1) return fuzzy[0].chatId
  if (fuzzy.length > 1) {
    throw new Error(
      JSON.stringify({ error: 'ambiguous name', matches: fuzzy.slice(0, 20).map((c) => c.name) }),
    )
  }
  throw new Error(JSON.stringify({ error: `no chat named '${name}'` }))
}

/** `_message` 查詢的原始列（引擎中立；WASM 引擎的 int64 欄位在超出安全範圍時是 bigint）。 */
interface RawMessageRow {
  _rowid: number | bigint
  _chatId: string
  _createdTime: number | bigint
  _from: string | null
  _text: string | null
  _contentType: number | null
  _id: number | string | bigint | null
  _contentMetadata: string | null
  _contentInfo: string | null
  _attribute: number | null
}

/**
 * 原始列 → NewMessageRow。bigint 規則（見 wasm/int64.ts）：`msgId` 的 bigint 轉成精確的十進位字串；
 * rowid／_createdTime 必須落在安全整數範圍（否則 throw，不靜默失真）。對 standalone（引擎只回
 * number／string）是 no-op。
 */
function mapMessageRow(r: RawMessageRow): NewMessageRow {
  return {
    rowId: toSafeNumber(r._rowid),
    chatId: r._chatId,
    createdTime: toSafeNumber(r._createdTime),
    from: r._from,
    text: r._text,
    contentType: r._contentType,
    msgId: normalizeMsgId(r._id),
    contentMetadata: r._contentMetadata,
    contentInfo: r._contentInfo,
    attribute: r._attribute,
  }
}

/**
 * newMessages — `_createdTime > since` 的新訊息原始 row（未轉 NDJSON 契約）。
 *
 * SQL 逐字對齊 watch_json.py:223-238（`new_messages`）的 SELECT 欄位、WHERE、
 * ORDER BY、LIMIT 與可選 `_chatId=?`（透過 resolveChat 解 name）。
 * 本函式只回原始 row；轉成 App NDJSON 契約物件（含媒體 gate / call label /
 * time）屬 Batch 3（rowToObj）。這裡回原始欄位讓 Batch 1 能對 py 逐筆 diff。
 */
export function newMessages(
  con: Db,
  sinceTs: number,
  name?: string | null,
  limit = 500,
): NewMessageRow[] {
  const cid = name ? resolveChat(con, name) : null
  let q =
    'SELECT rowid AS _rowid,_chatId,_createdTime,_from,_text,_contentType,_id,' +
    '_contentMetadata,_contentInfo,_attribute FROM _message ' +
    'WHERE _createdTime > ?'
  const args: Array<number | string> = [sinceTs]
  if (cid) {
    q += ' AND _chatId=?'
    args.push(cid)
  }
  q += ' ORDER BY _createdTime, rowid LIMIT ?'
  args.push(limit)
  const rows = con.prepare(q).all(...args) as RawMessageRow[]
  return rows.map(mapMessageRow)
}

/** 頭像回填用：一列「有發話者的訊息」（rowid、聊天室、訊息 id、發話者）。 */
export interface OlderSenderRow {
  rowId: number
  chatId: string
  msgId: string
  from: string
}

/** 目前最大的 `_message` rowid（沒有訊息回 0）。 */
export function maxMessageRowId(con: Db): number {
  const row = con.prepare('SELECT MAX(rowid) AS m FROM _message').get() as { m: number | bigint | null } | undefined
  return row?.m == null ? 0 : toSafeNumber(row.m)
}

/**
 * 頭像回填：rowid 小於 `before` 的訊息，由新到舊；只取有發話者、而且不是自己（`_from != accountMid`）的列。
 * 訊息 id 一律用 `normalizeMsgId`（和匯入時的 `i:` 後綴同一個規則），不用 CAST(_id AS TEXT)。
 */
export function olderSenderRows(con: Db, before: number, accountMid: string | null, limit: number): OlderSenderRow[] {
  const rows = con.prepare(
    'SELECT rowid AS _rowid,_chatId,_id,_from FROM _message WHERE rowid < ? AND _from IS NOT NULL AND _from != ? ORDER BY rowid DESC LIMIT ?',
  ).all(before, accountMid ?? '', limit) as Array<{ _rowid: number | bigint; _chatId: string; _id: number | string | bigint | null; _from: string }>
  const out: OlderSenderRow[] = []
  for (const r of rows) {
    const msgId = normalizeMsgId(r._id)
    if (msgId === null || msgId === '') continue
    out.push({ rowId: toSafeNumber(r._rowid), chatId: r._chatId, msgId: String(msgId), from: r._from })
  }
  return out
}

/**
 * Read one deterministic page after the composite LINE cursor. Timestamp ties are
 * completed with the source rowid so a limit boundary cannot skip same-ms rows.
 */
export function newMessagesAfter(
  con: Db,
  cursor: { createdTime: number; rowId: number },
  name?: string | null,
  limit = 500,
  createdTimeExclusive?: number,
): NewMessageRow[] {
  const cid = name ? resolveChat(con, name) : null
  let q =
    'SELECT rowid AS _rowid,_chatId,_createdTime,_from,_text,_contentType,_id,' +
    '_contentMetadata,_contentInfo,_attribute FROM _message ' +
    'WHERE (_createdTime > ? OR (_createdTime = ? AND rowid > ?))'
  const args: Array<number | string> = [cursor.createdTime, cursor.createdTime, cursor.rowId]
  if (cid) {
    q += ' AND _chatId=?'
    args.push(cid)
  }
  if (createdTimeExclusive !== undefined) {
    q += ' AND _createdTime < ?'
    args.push(createdTimeExclusive)
  }
  q += ' ORDER BY _createdTime, rowid LIMIT ?'
  args.push(limit)
  const rows = con.prepare(q).all(...args) as RawMessageRow[]
  return rows.map(mapMessageRow)
}
