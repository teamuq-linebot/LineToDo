import { app } from 'electron'
import { extname, join, relative, sep } from 'node:path'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { Database } from 'better-sqlite3'
import { getDb } from '../db/database'
import { decryptCachedMedia, resetMediaCacheIndex } from './decrypt'

/**
 * backup.ts — 把「可解密但未備份」的 LINE E2EE 媒體解密後存進本機備份夾（MB-2）。
 *
 * 定位：`decryptCachedMedia`（decrypt.ts）已能把 `.eimg` 於記憶體還原成明文；本模組
 *   把「已快取（可解出）且尚未備份（media_backed_up=0）」的圖片(ct=1)/檔案(ct=14)
 *   逐則落到 `app.getPath('userData')/media-backup/{對話夾}/{YYYY-MM}/`，並維護
 *   `backup-index.json` 目錄。單次處理量以 limit（預設 200）為界，剩下的下輪再補。
 *
 * 冪等：成功備份的列即 `UPDATE ... media_backed_up = 1`，之後不再入選；`not-cached`
 *   不標記（等 `.eimg` 快取後下輪重試）。目標檔已存在且同大小同內容 → 視為已備份、
 *   跳過寫入但仍標記＋補索引。
 *
 * 隱私（對齊 decrypt.ts §7 / protocol.ts §安全）：明文只寫進 media-backup 檔（備份本意）；
 *   **絕不 log keyMaterial / 明文 / bytes**（失敗只 log msgId + 原因分類）；索引不含金鑰。
 *
 * 硬性限制：只用 Node 內建 fs/path + 既有 decrypt/db，零新依賴；只新增本檔，不改既有檔
 *   （呼叫 hook 由 MB-3 負責）。
 */

/** content_type：1 = 圖片、14 = 檔案（與 protocol.ts 一致）。 */
const CONTENT_TYPE_IMAGE = 1

/** 待備份查詢結果（key_material 只在 main 內流動，不進 DTO/索引）。 */
interface BackupRow {
  msg_id: string
  chat_id: string
  ts: number
  time_iso: string
  content_type: number
  key_material: string | null
  orig_filename: string | null
  file_size: number | null
}

/** backup-index.json 單筆（不含任何金鑰/明文）。 */
interface BackupIndexEntry {
  msgId: string
  chatId: string
  chat: string
  ts: number
  timeIso: string
  type: 'image' | 'file'
  origFilename: string | null
  /** 相對 media-backup 根、以 `/` 分隔的路徑。 */
  path: string
  size: number
  backedAt: string
}

/**
 * 檔名/資料夾淨化：去 Windows 非法字元 `<>:"/\|?*`、控制字元、`..`（含更長的點串）、
 * 以及開頭/結尾的點與空白（Windows 不接受結尾點/空白）。淨化後可能為空字串，由呼叫端退回預設。
 */
function sanitize(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\.\.+/g, '')
    .replace(/^[.\s]+|[.\s]+$/g, '')
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 由 row.ts(epoch ms) 取日期；不合法時退回 time_iso，再退回 now。 */
function rowDate(ts: number, timeIso: string): Date {
  if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) {
    const d = new Date(ts)
    if (!Number.isNaN(d.getTime())) return d
  }
  const d2 = new Date(timeIso)
  if (!Number.isNaN(d2.getTime())) return d2
  return new Date()
}

/** 本地時間 `YYYY-MM`（月份分夾）。 */
function yearMonth(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}

/** 本地時間 `YYYYMMDD_HHmmss`（圖片檔名前綴）。 */
function stamp(d: Date): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

/** 圖片 mime → 副檔名（非圖片一律 bin）。 */
function extForImageMime(mime: string | undefined): string {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/png':
      return 'png'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    default:
      return 'bin'
  }
}

/** 目標檔已存在且與新明文同大小同內容 → 視為同一份（跳過寫入）。讀檔失敗保守回 false。 */
function sameContent(path: string, bytes: Buffer): boolean {
  try {
    if (statSync(path).size !== bytes.length) return false
    return readFileSync(path).equals(bytes)
  } catch {
    return false
  }
}

/**
 * 決定實際落點與是否需寫入：
 *   - 不存在 → 寫入。
 *   - 存在且同內容 → 不寫（已備份）。
 *   - 存在但內容不同：檔案類(allowSuffix)在副檔名前附 `_{last8}` 再判一次；圖片類（檔名已含
 *     msgId 末 8 碼，實務不衝突）則覆寫。
 */
function resolveTarget(
  dir: string,
  filename: string,
  bytes: Buffer,
  last8: string,
  allowSuffix: boolean
): { path: string; write: boolean } {
  const primary = join(dir, filename)
  if (!existsSync(primary)) return { path: primary, write: true }
  if (sameContent(primary, bytes)) return { path: primary, write: false }
  if (!allowSuffix) return { path: primary, write: true }

  const ext = extname(filename)
  const stem = filename.slice(0, filename.length - ext.length)
  const suffixed = join(dir, `${stem}_${last8}${ext}`)
  if (existsSync(suffixed) && sameContent(suffixed, bytes)) return { path: suffixed, write: false }
  return { path: suffixed, write: true }
}

/** 讀既有索引（壞 JSON / 非陣列 / 讀檔失敗一律當空陣列）。 */
function readIndex(indexPath: string): BackupIndexEntry[] {
  try {
    if (!existsSync(indexPath)) return []
    const parsed: unknown = JSON.parse(readFileSync(indexPath, 'utf8'))
    return Array.isArray(parsed) ? (parsed as BackupIndexEntry[]) : []
  } catch {
    return []
  }
}

/** 相對 media-backup 根、統一以 `/` 分隔（跨平台 JSON 可讀）。 */
function relFromRoot(root: string, full: string): string {
  return relative(root, full).split(sep).join('/')
}

/**
 * 掃描「可解密但未備份」的媒體，解密後存進備份夾並維護索引。main 端呼叫（同步）。
 *
 * @param db   DB 連線（預設單例）。
 * @param opts limit：單次處理上限（預設 200，避免暴量；剩下的下輪再處理）。
 * @returns    `{ backedUp, skipped, failed }` — backedUp=已備份（含既存同檔）、
 *             skipped=not-cached（未標記，待下輪）、failed=hmac-miss/error/缺 file_size（未標記）。
 */
export function backupNewMedia(
  db: Database = getDb(),
  opts?: { limit?: number; decrypt?: typeof decryptCachedMedia; resetIndex?: () => void }
): { backedUp: number; skipped: number; failed: number } {
  const limit = opts?.limit && opts.limit > 0 ? opts.limit : 200

  // 每輪備份起始先失效快取索引：整個迴圈只在首次 decrypt 時建一次（可涵蓋這輪剛快取好的
  // .eimg），之後所有 decrypt 共用同一份索引；not-cached 不再逐筆觸發全量重掃（修 O(N) 卡 UI）。
  if (opts?.resetIndex) opts.resetIndex()
  else resetMediaCacheIndex()

  const rows = db
    .prepare(
      `SELECT msg_id, chat_id, ts, time_iso, content_type, key_material, orig_filename, file_size
         FROM messages
        WHERE content_type IN (1, 14) AND key_material IS NOT NULL AND media_backed_up = 0
        ORDER BY ts
        LIMIT @limit`
    )
    .all({ limit }) as BackupRow[]

  let backedUp = 0
  let skipped = 0
  let failed = 0
  if (rows.length === 0) return { backedUp, skipped, failed }

  const backupRoot = join(app.getPath('userData'), 'media-backup')
  const indexPath = join(backupRoot, 'backup-index.json')

  // chat 顯示名查詢（memo，省重複查詢）。
  const nameStmt = db.prepare('SELECT name FROM chats WHERE chat_id = ?')
  const nameCache = new Map<string, string | null>()
  const chatDisplay = (chatId: string): string => {
    let name = nameCache.get(chatId)
    if (name === undefined) {
      const r = nameStmt.get(chatId) as { name: string | null } | undefined
      name = r?.name ?? null
      nameCache.set(chatId, name)
    }
    return name ?? chatId
  }

  const markStmt = db.prepare('UPDATE messages SET media_backed_up = 1 WHERE msg_id = ?')
  const index = readIndex(indexPath)
  let dirty = false

  try {
    for (const row of rows) {
      // TS narrow（WHERE 已保證 key_material 非 NULL；file_size 仍可能缺 → 無法解密）。
      if (!row.key_material || typeof row.file_size !== 'number') {
        console.warn(`[media-backup] skip-nofilesize msgId=${row.msg_id}`)
        failed++
        continue
      }

      const res = (opts?.decrypt ?? decryptCachedMedia)({ keyMaterial: row.key_material, fileSize: row.file_size })

      if (res.status === 'not-cached') {
        // 未快取屬預期：不標記，等 .eimg 快取後下輪再試。
        skipped++
        continue
      }
      if (res.status !== 'ok' || !res.bytes) {
        // hmac-miss / error：只 log msgId + 原因分類，不標記（可留待重試）。
        console.warn(`[media-backup] ${res.status} msgId=${row.msg_id}`)
        failed++
        continue
      }

      const bytes = res.bytes
      const display = chatDisplay(row.chat_id)
      const folder = sanitize(display) || sanitize(row.chat_id) || row.chat_id
      const date = rowDate(row.ts, row.time_iso)
      const dir = join(backupRoot, folder, yearMonth(date))
      const last8 = row.msg_id.slice(-8)
      const isImage = row.content_type === CONTENT_TYPE_IMAGE

      // 檔名：圖片→時間戳_末8碼.副檔名；檔案→淨化 orig_filename（空則 末8碼.bin）。
      let filename: string
      if (isImage) {
        filename = `${stamp(date)}_${last8}.${extForImageMime(res.mime)}`
      } else {
        const safe = sanitize(row.orig_filename ?? '')
        filename = safe || `${last8}.bin`
      }

      mkdirSync(dir, { recursive: true })
      const target = resolveTarget(dir, filename, bytes, last8, !isImage)
      if (target.write) writeFileSync(target.path, bytes)

      index.push({
        msgId: row.msg_id,
        chatId: row.chat_id,
        chat: display,
        ts: row.ts,
        timeIso: row.time_iso,
        type: isImage ? 'image' : 'file',
        origFilename: row.orig_filename,
        path: relFromRoot(backupRoot, target.path),
        size: bytes.length,
        backedAt: new Date().toISOString()
      })
      dirty = true

      markStmt.run(row.msg_id)
      backedUp++
    }
  } finally {
    // 即使中途意外拋出，也把已處理進度落盤，維持 DB 標記與索引一致。
    if (dirty) {
      mkdirSync(backupRoot, { recursive: true })
      writeFileSync(indexPath, JSON.stringify(index, null, 2))
    }
  }

  return { backedUp, skipped, failed }
}
