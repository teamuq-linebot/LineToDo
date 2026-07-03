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
 */
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3'
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// cipher 參數 —— 逐字對齊 linekey.py:23-24。
export const CIPHER = 'aes128cbc'
export const KDF_ITER = 1

/** %LOCALAPPDATA%\LINE\Data\db —— 對齊 linekey.py:19。 */
export const DB_DIR = join(process.env.LOCALAPPDATA || '', 'LINE', 'Data', 'db')

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
  let entries: string[]
  try {
    entries = readdirSync(DB_DIR)
  } catch {
    return null
  }
  const cands = entries
    .filter((f) => f.startsWith('qw') && f.endsWith('.edb') && !f.includes('_'))
    .map((f) => join(DB_DIR, f))
  if (cands.length === 0) return null
  let best = cands[0]
  let bestSize = -1
  for (const p of cands) {
    let size = -1
    try {
      size = statSync(p).size
    } catch {
      size = -1
    }
    if (size > bestSize) {
      bestSize = size
      best = p
    }
  }
  return best
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
  const src = srcPath ?? findDb()
  if (!src) {
    throw new Error(JSON.stringify({ error: 'LINE message DB not found', dir: DB_DIR }))
  }
  const tmp = mkdtempSync(join(tmpdir(), 'linedb-'))
  const path = join(tmp, 'm.edb')
  const cleanup = (): void => {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      // 非致命
    }
  }
  // 複製 edb + -wal + -shm（若存在），照 py 迴圈。
  for (const ext of ['', '-wal', '-shm']) {
    if (existsSync(src + ext)) {
      copyFileSync(src + ext, path + ext)
    }
  }
  let con: Db
  try {
    // 開 COPY read-write，讓 WAL merge 進來（最新訊息可見）。
    con = new Database(path) as unknown as Db
  } catch (e) {
    cleanup()
    throw e
  }
  try {
    // PRAGMA 順序逐字對齊 py：cipher → kdf_iter → key。
    // better-sqlite3(-multiple-ciphers) 的 pragma() 用 "name=value" 字串形式
    // （對照 scripts/spike/ciphers-spike.cjs 已驗證的正確寫法）。
    con.pragma(`cipher='${CIPHER}'`)
    con.pragma(`kdf_iter=${KDF_ITER}`)
    con.pragma(`key='${key}'`)
    // 驗解密 —— 錯 key / 錯 cipher 參數會在此拋。
    con.prepare('SELECT count(*) FROM sqlite_master').get()
  } catch {
    try {
      con.close()
    } catch {
      // ignore
    }
    cleanup()
    throw new Error(
      JSON.stringify({ error: 'decryption failed — wrong key or cipher params' }),
    )
  }
  try {
    con.pragma('wal_checkpoint(TRUNCATE)')
  } catch {
    // 非致命（對齊 py 的 try/except pass）
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
    .get(chatId) as
    | {
        _displayNameOverridden: string | null
        _displayName: string | null
        _targetProfileDetail: string | null
      }
    | undefined
  if (ct) {
    if (ct._displayNameOverridden) return ct._displayNameOverridden
    if (ct._displayName) return ct._displayName
    if (ct._targetProfileDetail) {
      try {
        const pn = (JSON.parse(ct._targetProfileDetail) as { profileName?: string })
          .profileName
        if (pn) return pn
      } catch {
        // 壞 JSON -> 跳過（對齊 py except Exception: pass）
      }
    }
  }
  return null
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
    'SELECT _chatId,_createdTime,_from,_text,_contentType,_id,' +
    '_contentMetadata,_contentInfo,_attribute FROM _message ' +
    'WHERE _createdTime > ?'
  const args: Array<number | string> = [sinceTs]
  if (cid) {
    q += ' AND _chatId=?'
    args.push(cid)
  }
  q += ' ORDER BY _createdTime LIMIT ?'
  args.push(limit)
  const rows = con.prepare(q).all(...args) as Array<{
    _chatId: string
    _createdTime: number
    _from: string | null
    _text: string | null
    _contentType: number | null
    _id: number | string | null
    _contentMetadata: string | null
    _contentInfo: string | null
    _attribute: number | null
  }>
  return rows.map((r) => ({
    chatId: r._chatId,
    createdTime: r._createdTime,
    from: r._from,
    text: r._text,
    contentType: r._contentType,
    msgId: r._id,
    contentMetadata: r._contentMetadata,
    contentInfo: r._contentInfo,
    attribute: r._attribute,
  }))
}
