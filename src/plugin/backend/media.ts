/**
 * media.ts — 外掛 backend 的媒體服務（設計 v2 §4.4）：解密 LINE E2EE 圖片、寫進 dataDir、讓 UI 以 asset URL 取得。
 *
 * standalone 用 `linemedia://media/<msgId>` 特權協定把明文 bytes 串給 renderer；1.6.8 外掛 view 的 CSP
 * （`pluginCsp.ts:15-26`）`img-src` 只有 `tuqplugin://<id>`、`data:`、`blob:`，沒有 `linemedia:`，所以改成：
 *
 *   view  ──backend.call('media', {path:'media.prepare', args:[msgId]})──►  backend
 *   backend：查 DB 列（key_material／file_size）→ `createMediaDecryptor`（共用 `media/decrypt.ts`；候選檔向本地圖片索引 `mediaIndex.ts` 查，絕不同步走訪 LINE Cache）
 *            → 明文寫進 `<dataDir>/media-cache/<sha256(msgId) 前 32 碼>.<ext>`（先寫暫存檔再 rename）→ 回 `{path}`
 *   view  ──window.tuqPlugin.assets.url(path)──►  `tuqplugin://<id>/data/media-cache/<name>`（host 的 data 唯讀服務，支援 Range）
 *
 * 約束（皆對照 1.6.8 `pluginDataFiles.ts` 的 `auditEntryName`／`segmentsOf`）：
 *   - 檔名只用 hex + 副檔名：不含 `:`（msgId 形如 `i:123`）、不以 `.` 開頭、單段 ≤ 100 字元；
 *   - 副檔名限 jpg／png／gif／webp（host 的 MIME 表有這些；`.bin` 在 `<img>` 上沒用，直接回 unsupported_format）；
 *   - 只服務 content_type = 1（圖片），與 standalone 的 protocol handler 一致；檔案（14）外掛版不提供開啟／另存；
 *   - 快取總量有上限（預設 256 MiB），超過就依 mtime 由舊到新刪到 80%（LINE Cache 還在時隨時可以重新解密）。
 *   - 查不到候選檔就立刻回 `not_cached`（訊息文字區分「LINE 還沒下載」與「索引建立中」），並請索引排一次（節流過的）delta；索引不可用（建表失敗）回 `media_unavailable`。
 *
 * 隱私：只在記憶體處理明文，寫檔只寫進自己的 dataDir；不 log keyMaterial／明文／bytes（只回結構化的錯誤碼）。
 */
import { createHash } from 'node:crypto'
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { PNG } from 'pngjs'
import type { LineFsPort } from '../../main/line/engine/fsPort'
import type { MediaDecryptor } from '../../main/media/decrypt'
import { MEDIA_INDEX_OFF_STATUS } from './mediaIndex'
import type { MediaIndex, MediaIndexStatus } from './mediaIndex'

export const MEDIA_CACHE_DIR = 'media-cache'
export const STICKER_CACHE_DIR = 'sticker-cache'
/**
 * 落點契約（docs：implementation-plan §1）：Pro 把自動保存的照片、影片寫進 `media-saved/`，檔案的原檔進 `saved-files/`，中繼資料是 `media-saved/<stem>.file.json`。
 * 這裡只讀取：免費版永遠不寫入 `media-saved/`，所以免費版的結果與改動前相同。`media-saved/` 不受 `media-cache` 的快取上限修剪。
 */
export const SAVED_MEDIA_DIR = 'media-saved'
export const SAVED_FILE_DIR = 'saved-files'
const SAVED_META_SUFFIX = '.file.json'
const SAVED_META_MAX_BYTES = 16 * 1024
const SAVED_SEGMENT_MAX = 255
const PREVIEW_SEGMENT_MAX = 100
const CONTENT_TYPE_VIDEO = 2
const CONTENT_TYPE_FILE = 14
const STICKER_MAX_BYTES = 1024 * 1024
const STICKER_MAX_EDGE = 2048
const STICKER_MAX_PIXELS = 4_000_000
/** `not_cached` 的訊息裡固定帶這個字：索引還在建立（renderer 據此自動重試；錯誤碼維持 `not_cached`）。LINE 還沒下載時訊息不含它。 */
export const MEDIA_INDEX_BUILDING_TOKEN = 'index_building'
/** content_type：1 = 圖片。 */
const CONTENT_TYPE_IMAGE = 1
const MIME_TO_EXT: Readonly<Record<string, string>> = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' })
const EXT_TO_MIME: Readonly<Record<string, string>> = Object.freeze({ jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' })
const EXTS = Object.keys(EXT_TO_MIME)
const VIDEO_EXT_TO_MIME: Readonly<Record<string, string>> = Object.freeze({ mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' })
const VIDEO_EXTS = Object.keys(VIDEO_EXT_TO_MIME)

export type MediaFailureCode =
  | 'invalid_args' | 'media_unavailable' | 'not_found' | 'not_image' | 'no_key'
  | 'not_cached' | 'hmac_miss' | 'decrypt_error' | 'unsupported_format' | 'write_failed'
  | 'not_video' | 'not_file' | 'not_saved' | 'saved_invalid' | 'saved_meta_invalid' | 'saved_size_mismatch' | 'saved_missing' | 'saved_link'

export type MediaPrepareResult =
  | { ok: true; /** 相對 dataDir、以 `/` 分隔，直接餵 `assets.url()`。 */ path: string; mime: string; size: number; cached: boolean }
  | { ok: false; code: MediaFailureCode; message: string }

/** `media.savedFile`：`absPath` 只給畫面顯示與複製（宿主沒有開啟／另存能力）；`previewPath`（相對 dataDir）只在影像、影片、音訊時才有。 */
export type SavedFileResult =
  | { ok: true; name: string; bytes: number; mime: string; absPath: string; previewPath?: string }
  | { ok: false; code: MediaFailureCode; message: string }

/** `<stem>.file.json` 驗證後的形狀。 */
interface SavedMeta { name: string; bytes: number; mime: string; rel: string }

/** `ok` 帶 lstat 看到的 dev／ino（bigint：Windows 的 file index 超過 2^53，轉成 number 會失真）與大小，供開檔後比對。 */
type ChainResult = { status: 'ok'; abs: string; dev: bigint; ino: bigint; size: number } | { status: 'missing' | 'link' | 'not_file' }

/**
 * `root` 的實際路徑加上分隔符；解不出來回 null。一律用 `realpathSync.native`：只有它會解開指向磁碟區 GUID 的 junction，
 * JS 版的 `realpathSync` 認為那是一般目錄、照字面回傳原路徑。
 */
function realPrefix(root: string): string | null {
  try {
    const real = realpathSync.native(root)
    return real.endsWith(sep) ? real : real + sep
  } catch { return null }
}

/** `abs` 的實際路徑在 `prefix`（`realPrefix(root)`）底下；解不出實際路徑＝不在。 */
function realInside(prefix: string, abs: string): boolean {
  try { return realpathSync.native(abs).startsWith(prefix) } catch { return false }
}

/**
 * 以 root 為根逐段 lstat（不跟隨連結），中間段必須是目錄、最後一段必須是一般檔案。以下任一情況回 `link`：
 *   - lstat 回報為 symlink（含指向磁碟機路徑 `X:\…` 的 junction）；
 *   - 這一段的實際路徑（`realpathSync.native`）不在 `realpathSync.native(root)` 底下。指向磁碟區 GUID（`\\?\Volume{…}\…`）的 junction，
 *     libuv 的 lstat 回報成一般目錄、看不出是連結，只能靠這一步擋；中間目錄（例如 `media-saved` 本身）也逐段檢查，
 *     所以連結後面的檔案存不存在都不會被探知。
 * lstat 與之後的使用之間仍有時間差：要讀內容的呼叫端（meta）必須再以 open＋fstat 比對 dev／ino／大小（`readVerified`）。
 * 路徑段本身的合法性（不越界、不以 `.` 開頭）由呼叫端先用 `safeSavedRel` 擋掉。
 */
function lstatChain(root: string, segments: readonly string[]): ChainResult {
  if (segments.length === 0) return { status: 'not_file' }
  let prefix: string | null | undefined
  let current = root
  for (let i = 0; i < segments.length; i += 1) {
    current = join(current, segments[i])
    let stat: BigIntStats
    try { stat = lstatSync(current, { bigint: true }) } catch (error) { return { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'not_file' } }
    if (stat.isSymbolicLink()) return { status: 'link' }
    // 第一段存在才解 root 的實際路徑：沒有 media-saved／saved-files 的免費版不多做任何事，結果與改動前相同（missing）。
    if (prefix === undefined) prefix = realPrefix(root)
    if (prefix === null || !realInside(prefix, current)) return { status: 'link' }
    if (i === segments.length - 1) return stat.isFile() ? { status: 'ok', abs: current, dev: stat.dev, ino: stat.ino, size: Number(stat.size) } : { status: 'not_file' }
    if (!stat.isDirectory()) return { status: 'not_file' }
  }
  return { status: 'not_file' }
}

/**
 * 讀 `lstatChain` 驗過的檔：先 open 再 fstat，開到的必須就是 lstat 看過的那個檔（dev、ino、大小都相同），才讀內容；
 * 擋住 lstat 與讀取之間被換成別的檔（ino 不同）或被改寫（大小不同）。讀完再確認一次實際路徑仍在 root 底下。任何不一致或讀取失敗都回 null。
 */
function readVerified(root: string, chain: Extract<ChainResult, { status: 'ok' }>): Buffer | null {
  let fd: number | null = null
  try {
    fd = openSync(chain.abs, 'r')
    const opened = fstatSync(fd, { bigint: true })
    if (!opened.isFile() || opened.dev !== chain.dev || opened.ino !== chain.ino || opened.size !== BigInt(chain.size)) return null
    const bytes = Buffer.alloc(chain.size)
    let offset = 0
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (n === 0) return null
      offset += n
    }
    const prefix = realPrefix(root)
    if (prefix === null || !realInside(prefix, chain.abs)) return null
    return bytes
  } catch {
    return null
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* 已關閉 */ } }
  }
}

/** `rel` 必須是 `saved-files/<段>/…`：不得含反斜線、冒號、NUL，不得是絕對路徑，每段非空、不是 `.`／`..`、不以 `.` 開頭、不以點或空白結尾。 */
function safeSavedRel(rel: string): string[] | null {
  if (rel.length === 0 || rel.length > 300 || /[\\:\u0000]/.test(rel) || rel.startsWith('/')) return null
  const segments = rel.split('/')
  if (segments[0] !== SAVED_FILE_DIR || segments.length < 2) return null
  for (const s of segments) {
    if (s.length === 0 || s === '.' || s === '..' || s.startsWith('.') || s.endsWith('.') || s.endsWith(' ') || s.length > SAVED_SEGMENT_MAX) return null
  }
  return segments
}

function parseSavedMeta(value: unknown): SavedMeta | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (v.v !== 1) return null
  if (typeof v.name !== 'string' || v.name.length === 0 || v.name.length > SAVED_SEGMENT_MAX) return null
  if (typeof v.mime !== 'string' || v.mime.length === 0 || v.mime.length > 127) return null
  if (typeof v.bytes !== 'number' || !Number.isSafeInteger(v.bytes) || v.bytes < 0) return null
  if (typeof v.rel !== 'string') return null
  return { name: v.name, bytes: v.bytes, mime: v.mime, rel: v.rel }
}

const savedImageResult = (hit: { name: string; ext: string; size: number }): MediaPrepareResult =>
  ({ ok: true, path: `${SAVED_MEDIA_DIR}/${hit.name}`, mime: EXT_TO_MIME[hit.ext], size: hit.size, cached: true })
const savedVideoResult = (hit: { name: string; ext: string; size: number }): MediaPrepareResult =>
  ({ ok: true, path: `${SAVED_MEDIA_DIR}/${hit.name}`, mime: VIDEO_EXT_TO_MIME[hit.ext], size: hit.size, cached: true })

/** 只需要 `prepare().get()` 的 DB 形狀（better-sqlite3 與測試 adapter 都符合）。 */
export interface MediaDb {
  prepare(sql: string): { get(...args: unknown[]): unknown }
}

interface MediaRow {
  key_material: string | null
  file_size: number | null
  content_type: number
}

export interface PluginMediaOptions {
  dataDir: string
  /** 取得目前的 app DB（backend 停止後回 null）。 */
  getDb(): MediaDb | null
  /** 解密器；null＝LINE Cache 目錄未知（`media.prepare` 回 media_unavailable，不猜路徑）。解密器的候選檔來源必須是 `index`。 */
  decryptor: MediaDecryptor | null
  /** 圖片索引（和解密器用的是同一個）；null＝沒有 LINE Cache（`media.prepare` 回 media_unavailable）。這裡不會做任何同步走訪。 */
  index: MediaIndex | null
  /** 快取上限（bytes）；預設 256 MiB。 */
  maxCacheBytes?: number
  /** Fixed LINE Data/Sticker root plus native-only safe file access. */
  stickerRoot?: string
  stickerFs?: Pick<LineFsPort, 'readUniqueChildDirectoryFile' | 'readAppOwnedFile' | 'writeAppOwnedFileAtomic'>
}

export interface PluginMedia {
  prepare(msgId: unknown): MediaPrepareResult
  /** ct=2：只查 `media-saved/`（mp4／mov／webm）；沒有就 `not_cached`。 */
  prepareVideo(msgId: unknown): MediaPrepareResult
  prepareSticker(msgId: unknown): MediaPrepareResult
  /** ct=14：讀取並驗證 `media-saved/<stem>.file.json` 與它指向的檔案。 */
  savedFile(msgId: unknown): SavedFileResult
  stats(): { cacheFiles: number; cacheBytes: number; prepared: number; written: number; reindexes: number; index: MediaIndexStatus }
}

const fail = (code: MediaFailureCode, message: string): { ok: false; code: MediaFailureCode; message: string } => ({ ok: false, code, message })

/** 快取檔名主幹（sha256(msgId) 前 32 碼 hex）。 */
export function mediaCacheStem(msgId: string): string {
  return createHash('sha256').update(msgId, 'utf8').digest('hex').slice(0, 32)
}

export function createPluginMedia(options: PluginMediaOptions): PluginMedia {
  const dir = join(options.dataDir, MEDIA_CACHE_DIR)
  const cap = options.maxCacheBytes ?? 256 * 1024 * 1024
  const counters = { prepared: 0, written: 0, reindexes: 0 }
  const stickerDir = join(options.dataDir, STICKER_CACHE_DIR)

  const decodeSticker = (bytes: Buffer): boolean => {
    try {
      if (bytes.length < 45 || bytes.length > STICKER_MAX_BYTES || !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return false
      if (bytes.toString('ascii', 12, 16) !== 'IHDR') return false
      const width = bytes.readUInt32BE(16)
      const height = bytes.readUInt32BE(20)
      if (!width || !height || width > STICKER_MAX_EDGE || height > STICKER_MAX_EDGE || width * height > STICKER_MAX_PIXELS) return false
      // APNG has different animation semantics; this slice intentionally serves static PNG only.
      let offset = 8
      while (offset + 12 <= bytes.length) {
        const length = bytes.readUInt32BE(offset)
        if (length > bytes.length - offset - 12) return false
        const type = bytes.toString('ascii', offset + 4, offset + 8)
        if (type === 'acTL') return false
        offset += length + 12
        if (type === 'IEND') break
      }
      const image = PNG.sync.read(bytes, { checkCRC: true })
      return image.width === width && image.height === height
    } catch { return false }
  }

  const writeStickerCache = (msgId: string, bytes: Buffer): string | null => {
    const name = `${createHash('sha256').update(msgId, 'utf8').digest('hex')}.png`
    const appFs = options.stickerFs
    try {
      if (typeof appFs?.readAppOwnedFile !== 'function' || typeof appFs.writeAppOwnedFileAtomic !== 'function') return null
      // mkdir only creates this one app-owned child; all reads/writes below reopen and verify it through native handles.
      try { mkdirSync(stickerDir) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      let current: Buffer | null
      try { current = appFs.readAppOwnedFile(options.dataDir, STICKER_CACHE_DIR, name, STICKER_MAX_BYTES) }
      catch { return null }
      if (current && decodeSticker(current)) return `${STICKER_CACHE_DIR}/${name}`
      appFs.writeAppOwnedFileAtomic(options.dataDir, STICKER_CACHE_DIR, name, bytes)
      return `${STICKER_CACHE_DIR}/${name}`
    } catch { return null }
  }

  const existing = (stem: string): { name: string; ext: string; size: number } | null => {
    for (const ext of EXTS) {
      const name = `${stem}.${ext}`
      try {
        const stat = statSync(join(dir, name))
        if (stat.isFile() && stat.size > 0) return { name, ext, size: stat.size }
      } catch { /* 沒有這個副檔名的快取 */ }
    }
    return null
  }

  const listCache = (): Array<{ name: string; size: number; mtimeMs: number }> => {
    let names: string[]
    try { names = readdirSync(dir) } catch { return [] }
    const out: Array<{ name: string; size: number; mtimeMs: number }> = []
    for (const name of names) {
      if (name.startsWith('.')) continue
      try {
        const stat = statSync(join(dir, name))
        if (stat.isFile()) out.push({ name, size: stat.size, mtimeMs: stat.mtimeMs })
      } catch { /* 被別人刪了 */ }
    }
    return out
  }

  /** 超過上限就刪最舊的，直到 ≤ 80%（`keep` 是剛寫入、不能刪的檔）。 */
  const prune = (keep: string): void => {
    const files = listCache()
    let total = files.reduce((n, f) => n + f.size, 0)
    if (total <= cap) return
    const target = Math.floor(cap * 0.8)
    for (const file of files.filter((f) => f.name !== keep).sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= target) break
      try { rmSync(join(dir, file.name), { force: true }); total -= file.size } catch { /* 下輪再清 */ }
    }
  }

  const decryptOnce = (row: MediaRow): ReturnType<MediaDecryptor['decrypt']> =>
    options.decryptor!.decrypt({ keyMaterial: row.key_material as string, fileSize: row.file_size as number })

  /** `media-saved/<stem>.<ext>`（不跟隨連結；`media-saved` 與檔案的實際路徑都必須在 dataDir 底下；只認一般檔案且大小大於 0）。 */
  const existingSaved = (stem: string, exts: readonly string[]): { name: string; ext: string; size: number } | null => {
    for (const ext of exts) {
      const name = `${stem}.${ext}`
      const chain = lstatChain(options.dataDir, [SAVED_MEDIA_DIR, name])
      if (chain.status === 'ok' && chain.size > 0) return { name, ext, size: chain.size }
    }
    return null
  }
  const existingSavedImage = (stem: string) => existingSaved(stem, EXTS)
  const existingSavedVideo = (stem: string) => existingSaved(stem, VIDEO_EXTS)

  /** 讀 DB 列（只取 prepare 需要的欄位）。查詢失敗回 `ok:false`，不 throw。 */
  const loadRow = (db: MediaDb, msgId: string): { ok: true; row: MediaRow | undefined } | { ok: false } => {
    try {
      return { ok: true, row: db.prepare('SELECT key_material, file_size, content_type FROM messages WHERE msg_id = ?').get(msgId) as MediaRow | undefined }
    } catch {
      return { ok: false }
    }
  }

  /** 沒有解密器或索引時：只有 media-saved 的圖片命中才能回（不需要解密、索引、key）；其餘由呼叫端回 media_unavailable。 */
  const savedImageOnly = (msgId: string): MediaPrepareResult | null => {
    const db = options.getDb()
    if (!db) return null
    const loaded = loadRow(db, msgId)
    if (!loaded.ok || !loaded.row || loaded.row.content_type !== CONTENT_TYPE_IMAGE) return null
    const saved = existingSavedImage(mediaCacheStem(msgId))
    return saved ? savedImageResult(saved) : null
  }

  return {
    prepare(rawMsgId: unknown): MediaPrepareResult {
      if (typeof rawMsgId !== 'string' || rawMsgId.length === 0 || rawMsgId.length > 200) return fail('invalid_args', 'msgId must be a non-empty string')
      // 沒有解密器或索引時，media-saved 的命中仍然可以回；其餘情況維持改動前的結果。
      if (!options.decryptor || !options.index) return savedImageOnly(rawMsgId) ?? fail('media_unavailable', 'the LINE cache directory is unknown')
      const db = options.getDb()
      if (!db) return fail('media_unavailable', 'the database is not open')
      const msgId = rawMsgId
      const loaded = loadRow(db, msgId)
      if (!loaded.ok) return fail('media_unavailable', 'the database is not readable')
      const row = loaded.row
      if (!row) return fail('not_found', 'no such message')
      if (row.content_type !== CONTENT_TYPE_IMAGE) return fail('not_image', 'only images are served in the plugin')

      // 順序：media-saved（Pro 寫入，不修剪）優先於 media-cache；命中時不需要 key 也不需要解密器。
      const stem = mediaCacheStem(msgId)
      const saved = existingSavedImage(stem)
      if (saved) { counters.prepared += 1; return savedImageResult(saved) }
      if (!row.key_material || typeof row.file_size !== 'number') return fail('no_key', 'the message has no decryption info')
      counters.prepared += 1

      const hit = existing(stem)
      if (hit) return { ok: true, path: `${MEDIA_CACHE_DIR}/${hit.name}`, mime: EXT_TO_MIME[hit.ext], size: hit.size, cached: true }

      // 沒有索引就沒有候選檔：建表失敗時整個功能關閉，不退回任何同步走訪（快取命中上面已經處理過，不需要索引）。
      if (!options.index.isAvailable()) return fail('media_unavailable', 'the media index is unavailable')
      const res = decryptOnce(row)
      if (res.status === 'not-cached') {
        // LINE 可能晚一點才把 .eimg 下載到 Cache：請索引排一次 delta（節流與單一執行都在索引內），這次立刻回覆。
        counters.reindexes += 1
        options.index.noteMiss()
        return fail('not_cached', options.index.isReady() ? 'not downloaded in LINE yet' : `the LINE cache index is still being built (索引建立中; ${MEDIA_INDEX_BUILDING_TOKEN}), try again shortly`)
      }
      if (res.status === 'hmac-miss') return fail('hmac_miss', 'the cached file does not match the key')
      if (res.status !== 'ok' || !res.bytes) return fail('decrypt_error', 'decryption failed')
      const ext = MIME_TO_EXT[res.mime ?? '']
      if (!ext) return fail('unsupported_format', `unsupported image format (${res.mime ?? 'unknown'})`)

      const name = `${stem}.${ext}`
      const target = join(dir, name)
      const temporary = join(dir, `.${name}.${process.pid}.tmp`)
      try {
        mkdirSync(dir, { recursive: true })
        writeFileSync(temporary, res.bytes, { flag: 'w' })
        renameSync(temporary, target)
      } catch {
        try { rmSync(temporary, { force: true }) } catch { /* 暫存檔留著無害（隱藏檔名，host 不會列出） */ }
        return fail('write_failed', 'could not write the media cache')
      }
      counters.written += 1
      prune(name)
      return { ok: true, path: `${MEDIA_CACHE_DIR}/${name}`, mime: EXT_TO_MIME[ext], size: res.bytes.length, cached: false }
    },
    prepareVideo(rawMsgId: unknown): MediaPrepareResult {
      if (typeof rawMsgId !== 'string' || rawMsgId.length === 0 || rawMsgId.length > 200) return fail('invalid_args', 'msgId must be a non-empty string')
      const db = options.getDb()
      if (!db) return fail('media_unavailable', 'the database is not open')
      const loaded = loadRow(db, rawMsgId)
      if (!loaded.ok) return fail('media_unavailable', 'the database is not readable')
      if (!loaded.row) return fail('not_found', 'no such message')
      if (loaded.row.content_type !== CONTENT_TYPE_VIDEO) return fail('not_video', 'only videos are served by prepareVideo')
      const saved = existingSavedVideo(mediaCacheStem(rawMsgId))
      if (saved) return savedVideoResult(saved)
      return fail('not_cached', 'the video is not saved yet')
    },
    savedFile(rawMsgId: unknown): SavedFileResult {
      if (typeof rawMsgId !== 'string' || rawMsgId.length === 0 || rawMsgId.length > 200) return fail('invalid_args', 'msgId must be a non-empty string')
      const db = options.getDb()
      if (!db) return fail('media_unavailable', 'the database is not open')
      const loaded = loadRow(db, rawMsgId)
      if (!loaded.ok) return fail('media_unavailable', 'the database is not readable')
      if (!loaded.row) return fail('not_found', 'no such message')
      if (loaded.row.content_type !== CONTENT_TYPE_FILE) return fail('not_file', 'only files have a saved file record')
      const metaChain = lstatChain(options.dataDir, [SAVED_MEDIA_DIR, `${mediaCacheStem(rawMsgId)}${SAVED_META_SUFFIX}`])
      if (metaChain.status === 'missing') return fail('not_saved', 'the file has not been saved')
      if (metaChain.status === 'link') return fail('saved_link', 'the saved record is a link or resolves outside the data directory and is not followed')
      if (metaChain.status !== 'ok') return fail('saved_meta_invalid', 'the saved record is not a regular file')
      if (metaChain.size > SAVED_META_MAX_BYTES) return fail('saved_meta_invalid', 'the saved record is too large')
      const metaBytes = readVerified(options.dataDir, metaChain)
      if (!metaBytes) return fail('saved_meta_invalid', 'the saved record changed while it was being read or is unreadable')
      let meta: SavedMeta | null
      try { meta = parseSavedMeta(JSON.parse(metaBytes.toString('utf8'))) } catch { meta = null }
      if (!meta) return fail('saved_meta_invalid', 'the saved record is unreadable')
      const segments = safeSavedRel(meta.rel)
      if (!segments) return fail('saved_invalid', 'the saved path is not allowed')
      // 字面上的越界檢查（縱深防禦）；實際路徑是否在 dataDir 底下由下面的 lstatChain 以 realpath 逐段確認。
      const root = resolve(options.dataDir)
      if (!resolve(root, ...segments).startsWith(root + sep)) return fail('saved_invalid', 'the saved path is outside the data directory')
      const target = lstatChain(options.dataDir, segments)
      if (target.status === 'missing') return fail('saved_missing', 'the saved file is missing')
      if (target.status === 'link') return fail('saved_link', 'the saved file is a link or resolves outside the data directory and is not followed')
      if (target.status !== 'ok') return fail('saved_invalid', 'the saved path is not a regular file')
      if (target.size !== meta.bytes) return fail('saved_size_mismatch', 'the saved file size does not match its record')
      const previewable = /^(image|video|audio)\//.test(meta.mime) && segments.every((s) => s.length <= PREVIEW_SEGMENT_MAX)
      return { ok: true, name: meta.name, bytes: meta.bytes, mime: meta.mime, absPath: target.abs, ...(previewable ? { previewPath: segments.join('/') } : {}) }
    },
    prepareSticker(rawMsgId: unknown): MediaPrepareResult {
      if (typeof rawMsgId !== 'string' || rawMsgId.length === 0 || rawMsgId.length > 200) return fail('invalid_args', '貼圖訊息無法辨識')
      const db = options.getDb()
      if (!db || !options.stickerRoot || typeof options.stickerFs?.readUniqueChildDirectoryFile !== 'function' || typeof options.stickerFs.readAppOwnedFile !== 'function' || typeof options.stickerFs.writeAppOwnedFileAtomic !== 'function') return fail('media_unavailable', '本機貼圖服務目前無法使用')
      let row: { content_type: number; sticker_id: string | null; sticker_package_id: string | null } | undefined
      try {
        row = db.prepare('SELECT content_type, sticker_id, sticker_package_id FROM messages WHERE msg_id = ?').get(rawMsgId) as typeof row
      } catch { return fail('media_unavailable', '無法讀取貼圖資訊') }
      if (!row || row.content_type !== 7) return fail('not_found', '找不到貼圖訊息')
      const validId = (value: unknown): value is string => typeof value === 'string' && /^\d{1,20}$/.test(value)
      if (!validId(row.sticker_package_id) || !validId(row.sticker_id)) return fail('not_found', '貼圖資訊不完整')
      let resolved: { matches: number; bytes?: Buffer }
      try { resolved = options.stickerFs.readUniqueChildDirectoryFile(options.stickerRoot, row.sticker_package_id, `${row.sticker_id}.png`, STICKER_MAX_BYTES) }
      catch { return fail('not_found', '找不到可用的本機貼圖') }
      if (resolved.matches !== 1 || !resolved.bytes) return fail('not_found', '找不到唯一的本機貼圖')
      if (!decodeSticker(resolved.bytes)) return fail('unsupported_format', '本機貼圖檔案無法解碼')
      const path = writeStickerCache(rawMsgId, resolved.bytes)
      if (!path) return fail('write_failed', '無法暫存本機貼圖')
      return { ok: true, path, mime: 'image/png', size: resolved.bytes.length, cached: false }
    },
    stats() {
      const files = existsSync(dir) ? listCache() : []
      return { cacheFiles: files.length, cacheBytes: files.reduce((n, f) => n + f.size, 0), ...counters, index: options.index ? options.index.status() : { ...MEDIA_INDEX_OFF_STATUS } }
    }
  }
}
