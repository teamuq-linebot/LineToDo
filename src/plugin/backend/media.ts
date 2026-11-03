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
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MediaDecryptor } from '../../main/media/decrypt'
import { MEDIA_INDEX_OFF_STATUS } from './mediaIndex'
import type { MediaIndex, MediaIndexStatus } from './mediaIndex'

export const MEDIA_CACHE_DIR = 'media-cache'
/** `not_cached` 的訊息裡固定帶這個字：索引還在建立（renderer 據此自動重試；錯誤碼維持 `not_cached`）。LINE 還沒下載時訊息不含它。 */
export const MEDIA_INDEX_BUILDING_TOKEN = 'index_building'
/** content_type：1 = 圖片。 */
const CONTENT_TYPE_IMAGE = 1
const MIME_TO_EXT: Readonly<Record<string, string>> = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' })
const EXT_TO_MIME: Readonly<Record<string, string>> = Object.freeze({ jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' })
const EXTS = Object.keys(EXT_TO_MIME)

export type MediaFailureCode =
  | 'invalid_args' | 'media_unavailable' | 'not_found' | 'not_image' | 'no_key'
  | 'not_cached' | 'hmac_miss' | 'decrypt_error' | 'unsupported_format' | 'write_failed'

export type MediaPrepareResult =
  | { ok: true; /** 相對 dataDir、以 `/` 分隔，直接餵 `assets.url()`。 */ path: string; mime: string; size: number; cached: boolean }
  | { ok: false; code: MediaFailureCode; message: string }

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
}

export interface PluginMedia {
  prepare(msgId: unknown): MediaPrepareResult
  stats(): { cacheFiles: number; cacheBytes: number; prepared: number; written: number; reindexes: number; index: MediaIndexStatus }
}

const fail = (code: MediaFailureCode, message: string): MediaPrepareResult => ({ ok: false, code, message })

/** 快取檔名主幹（sha256(msgId) 前 32 碼 hex）。 */
export function mediaCacheStem(msgId: string): string {
  return createHash('sha256').update(msgId, 'utf8').digest('hex').slice(0, 32)
}

export function createPluginMedia(options: PluginMediaOptions): PluginMedia {
  const dir = join(options.dataDir, MEDIA_CACHE_DIR)
  const cap = options.maxCacheBytes ?? 256 * 1024 * 1024
  const counters = { prepared: 0, written: 0, reindexes: 0 }

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

  return {
    prepare(rawMsgId: unknown): MediaPrepareResult {
      if (typeof rawMsgId !== 'string' || rawMsgId.length === 0 || rawMsgId.length > 200) return fail('invalid_args', 'msgId must be a non-empty string')
      if (!options.decryptor || !options.index) return fail('media_unavailable', 'the LINE cache directory is unknown')
      const db = options.getDb()
      if (!db) return fail('media_unavailable', 'the database is not open')
      const msgId = rawMsgId
      let row: MediaRow | undefined
      try {
        row = db.prepare('SELECT key_material, file_size, content_type FROM messages WHERE msg_id = ?').get(msgId) as MediaRow | undefined
      } catch {
        return fail('media_unavailable', 'the database is not readable')
      }
      if (!row) return fail('not_found', 'no such message')
      if (row.content_type !== CONTENT_TYPE_IMAGE) return fail('not_image', 'only images are served in the plugin')
      if (!row.key_material || typeof row.file_size !== 'number') return fail('no_key', 'the message has no decryption info')
      counters.prepared += 1

      const stem = mediaCacheStem(msgId)
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
    stats() {
      const files = existsSync(dir) ? listCache() : []
      return { cacheFiles: files.length, cacheBytes: files.reduce((n, f) => n + f.size, 0), ...counters, index: options.index ? options.index.status() : { ...MEDIA_INDEX_OFF_STATUS } }
    }
  }
}
