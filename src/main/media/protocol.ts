import { app, dialog, ipcMain, protocol, shell } from 'electron'
import { writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { getDb } from '../db/database'
import { decryptCachedMedia, type DecryptMediaStatus } from './decrypt'

/**
 * protocol.ts — linemedia:// 特權協定 + 媒體 IPC（M7）。
 *
 * 資料流（media_feature_plan §3 決策 3 / §4.5 / §4.6）：
 *   圖片（content_type=1）→ renderer `<img src="linemedia://media/<msgId>">`
 *     → protocol.handle 查 DB 列 → decryptCachedMedia → 串流明文 bytes（僅記憶體）。
 *   檔案（content_type=14）→ 不走 protocol/renderer bytes，改 IPC media:open / media:saveAs
 *     （main 解密 → 暫存/使用者選路 → shell/dialog）。
 *
 * 安全（§1-E / §4.4 / §7）：
 *   - keyMaterial 只在 main 讀 DB → 傳給 decrypt，明文/檔案 bytes 永不進 renderer。
 *   - log 只記 msgId + 原因分類；絕不 log keyMaterial / 明文 / 完整 ciphertext。
 *   - 全程 try/catch：protocol 最差回 404、IPC 最差回 { ok:false }，不中斷即時訊息流。
 */

const SCHEME = 'linemedia'
/** content_type：1 = 圖片（走 protocol）、14 = 檔案（走 IPC）。 */
const CONTENT_TYPE_IMAGE = 1

/** 自 messages 表取的解密所需欄位（key_material 只在 main 內流動）。 */
interface MediaRow {
  key_material: string | null
  file_size: number | null
  content_type: number
  orig_filename: string | null
}

/** 以 msg_id 直接查 messages 列（getDb()；不經 repo，避免把 key_material 帶進 DTO）。 */
function queryMediaRow(msgId: string): MediaRow | undefined {
  return getDb()
    .prepare(
      'SELECT key_material, file_size, content_type, orig_filename FROM messages WHERE msg_id = ?'
    )
    .get(msgId) as MediaRow | undefined
}

/** 解析 `linemedia://media/<msgId>` → msgId（decodeURIComponent；失敗回 null）。 */
function parseMsgId(rawUrl: string): string | null {
  try {
    const raw = new URL(rawUrl).pathname.replace(/^\/+/, '')
    if (!raw) return null
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

/** 解密狀態 → 使用者可讀訊息（IPC 用；不含敏感值）。 */
function statusToMessage(status: DecryptMediaStatus): string {
  switch (status) {
    case 'not-cached':
      return '尚未下載，請在 LINE 開啟'
    case 'hmac-miss':
      return '媒體驗證失敗'
    default:
      return '媒體載入失敗'
  }
}

/** mime → 副檔名（無 orig_filename 的圖片暫存/另存命名用）。 */
function extForMime(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
      return '.jpg'
    case 'image/png':
      return '.png'
    case 'image/gif':
      return '.gif'
    default:
      return '.bin'
  }
}

/**
 * 檔名淨化（Fix-C 安全硬化）：orig_filename 源自 LINE 對話資料，可能含目錄成分或 `..`，
 * 直接用於寫暫存檔／組 defaultPath 會有目錄穿越或覆寫風險。步驟：
 *   1. 正規化 `\` 為 `/` 後取 basename，去掉任何目錄成分。
 *   2. 將 Windows 非法字元 `< > : " | ? *`、殘留路徑分隔字元與控制字元替換為 `_`。
 *   3. 消除 `..` 片段、去除結尾的點與空白（Windows 不接受）。
 * 淨化後為空字串時回傳 ''，由 pickFileName 退回安全預設。
 */
function sanitize(name: string): string {
  return basename(name.replace(/\\/g, '/'))
    .replace(/[<>:"|?*/\\\u0000-\u001f]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/[.\s]+$/g, '')
}

/**
 * 決定暫存／建議檔名：優先淨化後的 orig_filename，淨化後為空時退回
 * 安全預設 `media_<淨化 msgId>.<mime 副檔名或 bin>`（保證非空且無目錄成分）。
 */
function pickFileName(msgId: string, origFilename: string | null, mime: string): string {
  if (origFilename && origFilename.trim()) {
    const safe = sanitize(origFilename)
    if (safe) return safe
  }
  return `media_${sanitize(msgId) || 'file'}${extForMime(mime)}`
}

type DecryptedForMsg =
  | { ok: true; bytes: Buffer; mime: string; origFilename: string | null }
  | { ok: false; error: string }

/** 查列 + 解密（IPC 共用）。key_material/file_size 缺料或解密失敗一律回結構化錯誤。 */
function decryptForMsg(msgId: string): DecryptedForMsg {
  const row = queryMediaRow(msgId)
  if (!row) return { ok: false, error: '找不到訊息' }
  if (!row.key_material || typeof row.file_size !== 'number') {
    return { ok: false, error: '缺少解密資訊' }
  }
  const res = decryptCachedMedia({ keyMaterial: row.key_material, fileSize: row.file_size })
  if (res.status !== 'ok' || !res.bytes) {
    return { ok: false, error: statusToMessage(res.status) }
  }
  return {
    ok: true,
    bytes: res.bytes,
    mime: res.mime ?? 'application/octet-stream',
    origFilename: row.orig_filename
  }
}

/**
 * 宣告 linemedia:// 為特權 scheme。**須在 app ready 前、module 頂層階段呼叫**
 * （registerSchemesAsPrivileged 之後才 app.ready）。bypassCSP:false 讓此 scheme 仍受 CSP 管束。
 */
export function registerLinemediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: false
      }
    }
  ])
}

/**
 * 註冊 linemedia:// handler（app ready 後）。
 * 僅服務「content_type=1（圖片）且 key_material+file_size 有值」的列；其餘一律 404。
 */
export function registerLinemediaHandler(): void {
  protocol.handle(SCHEME, (req): Response => {
    try {
      const msgId = parseMsgId(req.url)
      if (!msgId) {
        console.warn('[media] bad-request (no msgId)')
        return new Response(null, { status: 404 })
      }

      const row = queryMediaRow(msgId)
      if (
        !row ||
        row.content_type !== CONTENT_TYPE_IMAGE ||
        !row.key_material ||
        typeof row.file_size !== 'number'
      ) {
        console.warn(`[media] bad-request msgId=${msgId}`)
        return new Response(null, { status: 404 })
      }

      const res = decryptCachedMedia({ keyMaterial: row.key_material, fileSize: row.file_size })
      if (res.status === 'ok' && res.bytes) {
        return new Response(res.bytes, {
          headers: { 'Content-Type': res.mime ?? 'application/octet-stream' }
        })
      }

      // not-cached=預期（info）、hmac-miss=金鑰/檔不匹配（warn）、其餘 error。
      if (res.status === 'not-cached') console.info(`[media] not-cached msgId=${msgId}`)
      else if (res.status === 'hmac-miss') console.warn(`[media] hmac-miss msgId=${msgId}`)
      else console.error(`[media] decrypt-fail msgId=${msgId}`)
      return new Response(null, { status: 404 })
    } catch (err) {
      console.error(`[media] protocol-error ${err instanceof Error ? err.name : 'unknown'}`)
      return new Response(null, { status: 404 })
    }
  })
}

/**
 * 註冊媒體檔案 IPC（檔案 bytes 完全不進 renderer）。
 *   media:open   → 解密 → 寫 app.getPath('temp') 暫存（檔名經 sanitize，確保落在 temp 內）→ shell.openPath
 *   media:saveAs → 解密 → dialog.showSaveDialog（defaultPath=淨化後 basename，使用者仍可自選目錄）→ 寫使用者選路
 */
export function registerMediaIpc(): void {
  ipcMain.handle(
    'media:open',
    async (_e, args: { msgId: string }): Promise<{ ok: boolean; error?: string }> => {
      if (!args || typeof args.msgId !== 'string') return { ok: false, error: '缺少 msgId' }
      try {
        const dec = decryptForMsg(args.msgId)
        if (!dec.ok) {
          console.warn(`[media] open-miss msgId=${args.msgId}`)
          return { ok: false, error: dec.error }
        }
        // pickFileName 回傳已淨化、無目錄成分的 basename；join 後必落在 temp 內，無穿越風險。
        const tmpPath = join(
          app.getPath('temp'),
          pickFileName(args.msgId, dec.origFilename, dec.mime)
        )
        writeFileSync(tmpPath, dec.bytes)
        const openErr = await shell.openPath(tmpPath)
        if (openErr) {
          console.warn(`[media] open-fail msgId=${args.msgId}`)
          return { ok: false, error: openErr }
        }
        return { ok: true }
      } catch (err) {
        console.error(
          `[media] open-error msgId=${args.msgId} ${err instanceof Error ? err.name : 'unknown'}`
        )
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'media:saveAs',
    async (
      _e,
      args: { msgId: string }
    ): Promise<{ ok: boolean; canceled?: boolean; error?: string }> => {
      if (!args || typeof args.msgId !== 'string') return { ok: false, error: '缺少 msgId' }
      try {
        const dec = decryptForMsg(args.msgId)
        if (!dec.ok) {
          console.warn(`[media] saveas-miss msgId=${args.msgId}`)
          return { ok: false, error: dec.error }
        }
        // defaultPath 只用淨化後 basename 當預設檔名；使用者仍可自選目錄，最終路徑由 dialog 決定。
        const defaultPath = pickFileName(args.msgId, dec.origFilename, dec.mime)
        const { canceled, filePath } = await dialog.showSaveDialog({ defaultPath })
        if (canceled || !filePath) return { ok: false, canceled: true }
        writeFileSync(filePath, dec.bytes)
        return { ok: true }
      } catch (err) {
        console.error(
          `[media] saveas-error msgId=${args.msgId} ${err instanceof Error ? err.name : 'unknown'}`
        )
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}
