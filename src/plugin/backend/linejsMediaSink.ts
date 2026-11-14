/**
 * linejsMediaSink.ts — Pro 的落點 sink（X2a；implementation-plan.md §1 落點契約、implementation-plan-v2.md X2a）。
 *
 * 依 kind 決定落點（main 的 media.ts 只讀這些位置；免費版永遠不寫）：
 *   照片（IMAGE）→ media-saved/<stem>.<jpg|png|gif|webp>
 *   影片（VIDEO）→ media-saved/<stem>.<mp4|mov|webm>
 *   檔案（FILE） → saved-files/<聊天室安全名>--<sha256(chatId) 前 10>/<yyyyMMdd-HHmmss>_<原檔名安全化>
 *                 ＋ media-saved/<stem>.file.json：{v:1, name, bytes, mime, rel}
 *   寫入中     → media-saved/.<stem>.<uuid>.part（以點開頭：不在顯示鏈讀取的 `<stem>.<ext>`／`<stem>.file.json` 樣式內，宿主也不提供服務；I-1）
 *
 * 寫入一律「先寫 part → 驗證 → 原子 rename」。副檔名依內容判斷，不信任宣告。
 *
 * 落點契約（review-m R-M07，`<stem>.file.json` 寫入前由 `savedRecordProblem` 驗證，與 media.ts `savedFile` 的讀取規則相同）：
 *   - 位元組沒有 BOM，是 JSON 物件，`v` 為 1；name 1–255 字元；mime 是 type/subtype；bytes 是非負安全整數；
 *   - rel = `saved-files/…`：總長 ≤300、每段 1–255、不以 `.` 開頭或結尾、不以空白結尾，沒有 `\`、`:`、NUL；
 *   - bytes 與實際檔案大小完全相符；
 *   - 每段 ≤100 字元，畫面才會拿到 previewPath（media.ts 的規則）。sink 產生的每一段都 ≤100，影像／影片／音訊類的檔案都能預覽。
 *
 * 越界防護：stem 必須是 32 碼 hex；檔名、聊天室名逐段安全化（不可能產生 `..`、絕對路徑、磁碟代號或分隔符）；
 * 目錄逐段 lstat（不是連結、必須是目錄）且 realpath 必須在 dataDir 的 realpath 底下；最後再以 path.resolve 做字面包含檢查。
 *
 * 已接受的殘餘風險（review-m2 R2-01）：hard link 可以繞過包含檢查——saved-files 或 media-saved 裡的一個 hard link 與 dataDir 外的
 * 某個檔案共用同一個 inode，路徑字面與 realpath 都在 dataDir 內，任何包含檢查都看不出來。P3／X4 回填本來就以 hard link 把舊圖片
 * 連到 media-saved（不多佔空間），所以這是設計內的行為，不在這裡擋。
 *
 * 冪等：同一個 stem 不論從哪個 origin（receive、history、outbound、backfill）寫入，只會寫一次——每個 stem 一把行程內的鎖，
 * 鎖內先查既有落點，已存在就丟掉新的 part、回 `exists`，不覆寫。
 *
 * 不覆寫的落地（review-x2a F-1）：part 一律以 hard link 放到最終路徑（目標已存在 → EEXIST，換下一個名稱，絕不覆寫、絕不刪別人的檔），
 * 成功後才移除 part。磁碟不支援 hard link 時，退回「以最終路徑為鍵的行程內鎖＋lstat＋rename」。照片、影片的最終名稱含 stem，
 * 所以只會和同一個 stem 衝突；檔案（saved-files）的名稱可能與別則訊息相同，依序試：原名 → `_<stem 前 8>` → `_<stem 前 8>-<隨機 6 hex>`。
 *
 * 崩潰留下的孤兒檔（F-6）：檔案落地後、`.file.json` 寫入前崩潰，saved-files 會留下沒有紀錄的檔。不清理它們——原名不含 stem，
 * 無法和另一則訊息「已落地、紀錄尚未寫」的檔區分，刪錯就是 F-1 的錯置；改以換名重試，最後幾個名稱帶隨機尾碼，孤兒再多也不會讓
 * 該 stem 永久名稱衝突。孤兒只佔空間，留給回填／盤點處理。
 *
 * 錯誤分類（F-2b）：sink 拋出的錯誤都帶 `code` 與 `class`，訊息只有 code（不含路徑，I-2）。
 *   - `unsupported`（終態）：內容不符、名稱衝突、路徑不安全、stem／kind 無效、紀錄不合格——再下載一次結果也一樣。part 已移除。
 *   - `transient`：I/O 錯誤（原本的 errno code，例如 EBUSY、ENOSPC）——part 保留，下一次從 part 續傳；
 *     以及 part 不見或大小與呼叫端不符（SINK_PART_MISSING、SINK_SIZE_MISMATCH）——part 不可信，已移除。
 *
 * 耐久性（F-4）：part（saveBytes）與 `.file.json` 都先 fsync 再 link／rename。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { detectSupportedImageMime, detectSupportedVideoMime, writeFileDurable } from './linejsAutoDownload.mjs'
import { SAVED_FILE_DIR, SAVED_MEDIA_DIR } from './media'
import type { SinkTarget } from './linejsMediaStream'
import type { MediaKind, MediaOrigin } from './linejsObs'

export const SAVED_META_SUFFIX = '.file.json'
export const SAVED_REL_MAX = 300
export const SAVED_SEGMENT_MAX = 255
export const SAVED_PREVIEW_SEGMENT_MAX = 100
/** sink 自己產生的每一段都不超過這個長度（= 預覽門檻，所以預覽一定可用）。 */
const SEGMENT_BUDGET = SAVED_PREVIEW_SEGMENT_MAX
const IMAGE_FULL_CHECK_MAX_BYTES = 64 * 1024 ** 2
const HEAD_BYTES = 64 * 1024
const STEM = /^[0-9a-f]{32}$/
const PART_NAME = /^\.([0-9a-f]{32})\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$/
const IMAGE_EXT: Readonly<Record<string, string>> = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' })
const VIDEO_EXT: Readonly<Record<string, string>> = Object.freeze({ 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' })
/** 檔案的 MIME 依副檔名（宿主也是依副檔名決定 MIME）；表外的用呼叫端給的 MIME 或 octet-stream。 */
const FILE_MIME_BY_EXT: Readonly<Record<string, string>> = Object.freeze({
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
  pdf: 'application/pdf', txt: 'text/plain', zip: 'application/zip',
})
const MIME_TOKEN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/i

/**
 * 不可見的方向控制與格式字元（可偽裝副檔名，F-3；review-x2a-r2 N-3）：
 *   U+00AD（軟連字號）、U+061C（阿拉伯字母標記）、U+180E（蒙古文母音分隔）、U+200B（零寬空格）、U+200E–200F（LRM／RLM）、
 *   U+202A–202E（嵌入與覆寫）、U+2060–2064（字連接與不可見運算子）、U+2066–206F（隔離與已廢止的格式字元）、U+FEFF。
 * 刻意保留 U+200C（ZWNJ）與 U+200D（ZWJ）：家庭 emoji、波斯文、天城文的正常名稱需要它們，它們也不改變顯示方向。
 */
const INVISIBLE = /[\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g
/** hard link 不被支援時的 errno（FAT／exFAT、網路磁碟等）：改走鎖＋rename。 */
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EINVAL', 'EISDIR', 'EMLINK'])
/** 檔案名稱衝突時最多試幾個名稱（原名、stem 尾碼，其餘帶隨機尾碼）。 */
const NAME_ATTEMPTS = 8

export type SinkErrorClass = 'unsupported' | 'transient'
const coded = (code: string, cls: SinkErrorClass = 'unsupported') => Object.assign(new Error(code), { code, class: cls })
/** sink 外面看到的錯誤：已分類的照舊；其餘（fs 的 I/O 錯誤）→ transient，只留 errno code，不帶含路徑的訊息（I-2）。 */
function sinkError(error: unknown): Error {
  const e = error as { code?: unknown; class?: unknown } | null
  if (e && (e.class === 'unsupported' || e.class === 'transient') && typeof e.code === 'string') return error as Error
  const code = typeof e?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(e.code) ? e.code : 'SINK_IO'
  return coded(code, 'transient')
}

// ───────────────────────── 落點契約（R-M07） ─────────────────────────

/** rel 的問題（沒有問題回 null）。與 media.ts `safeSavedRel` 同一套規則。 */
export function savedRelProblem(rel: unknown): string | null {
  if (typeof rel !== 'string') return 'REL_TYPE'
  if (rel.length === 0 || rel.length > SAVED_REL_MAX) return 'REL_LENGTH'
  if (/[\\:\u0000]/.test(rel) || rel.startsWith('/')) return 'REL_CHARS'
  const segments = rel.split('/')
  if (segments[0] !== SAVED_FILE_DIR || segments.length < 2) return 'REL_PREFIX'
  for (const s of segments) {
    if (s.length === 0) return 'SEGMENT_EMPTY'
    if (s.length > SAVED_SEGMENT_MAX) return 'SEGMENT_LENGTH'
    if (s.startsWith('.') || s.endsWith('.')) return 'SEGMENT_DOT'
    if (s.endsWith(' ')) return 'SEGMENT_SPACE'
  }
  return null
}

/** `<stem>.file.json` 位元組的問題（沒有問題回 null）。`actualSize`：rel 指向的檔案實際大小（null＝不存在）。 */
export function savedRecordProblem(bytes: Uint8Array, actualSize: number | null): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'BOM'
  let value: unknown
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')) } catch { return 'NOT_JSON' }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'NOT_JSON'
  const v = value as Record<string, unknown>
  if (v.v !== 1) return 'VERSION'
  if (typeof v.name !== 'string' || v.name.length === 0 || v.name.length > SAVED_SEGMENT_MAX) return 'NAME'
  if (typeof v.mime !== 'string' || !MIME_TOKEN.test(v.mime)) return 'MIME'
  if (typeof v.bytes !== 'number' || !Number.isSafeInteger(v.bytes) || v.bytes < 0) return 'BYTES'
  const relProblem = savedRelProblem(v.rel)
  if (relProblem) return relProblem
  if (actualSize === null) return 'MISSING'
  if (actualSize !== v.bytes) return 'SIZE_MISMATCH'
  return null
}

/** 畫面會不會拿到 previewPath（media.ts 的規則：影像、影片、音訊，而且每段 ≤100）。 */
export function previewAllowed(rel: string, mime: string): boolean {
  return /^(image|video|audio)\//.test(mime) && rel.split('/').every((s) => s.length <= SAVED_PREVIEW_SEGMENT_MAX)
}

/** 寫入中的暫存檔名：`.<stem>.<uuid>.part`（以點開頭，不在顯示鏈讀取的樣式內）。 */
export function partNameFor(stem: string): string {
  if (!STEM.test(stem)) throw coded('SINK_STEM_INVALID')
  return `.${stem}.${randomUUID()}.part`
}

/** 依 UTF-16 長度截斷（不切斷代理對），media.ts 以 `.length` 計算段長。 */
function capLength(value: string, max: number): string {
  let out = ''
  for (const ch of value) { if (out.length + ch.length > max) break; out += ch }
  return out
}

/**
 * 一個路徑段的安全化：NFKC → 去掉方向控制與零寬字元 → 換掉 `<>:"/\|?*`、控制字元 → 去掉開頭的點與空白、截到 `max` →
 * 去掉結尾的點與空白 → 空的用 `fallback` → Windows 保留名加 `_`。結果不可能是 `.`、`..`、含分隔符或磁碟代號。
 */
export function safeSegment(value: unknown, max: number, fallback: string): string {
  let s = String(value ?? '').normalize('NFKC').replace(INVISIBLE, '').replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g, '_').replace(/\s+/g, ' ')
  s = s.replace(/^[.\s]+/, '')
  s = capLength(s, max - 1).replace(/[.\s]+$/, '')
  if (!s) s = fallback
  if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i.test(s)) s = `_${s}`
  return s
}

/** 本地時間 yyyyMMdd-HHmmss。 */
export function savedFileTimestamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 檔案的落點（不碰磁碟）：`saved-files/<聊天室>--<hash10>/<時間>_<名稱>`，每段 ≤100。`suffix` 給同名衝突用。 */
export function savedFilePlacement(spec: { chatId: string; chatName?: string; fileName?: string }, when: number, suffix = ''): { chatDir: string; fileSeg: string; rel: string } {
  const chatHash = createHash('sha256').update(String(spec.chatId), 'utf8').digest('hex').slice(0, 10)
  const chatDir = `${safeSegment(spec.chatName, SEGMENT_BUDGET - 12, 'chat')}--${chatHash}`
  // sanitized at full length first, so a long name keeps its extension; the base is capped below
  const name = safeSegment(spec.fileName, 4096, 'file')
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 && /^\.[A-Za-z0-9]{1,15}$/.test(name.slice(dot)) ? name.slice(dot) : ''
  const stamp = `${savedFileTimestamp(when)}_`
  const tail = suffix ? `_${suffix}` : ''
  const budget = SEGMENT_BUDGET - stamp.length - tail.length - ext.length
  const base = capLength(ext ? name.slice(0, dot) : name, budget).replace(/[.\s]+$/, '') || 'file'
  const fileSeg = `${stamp}${base}${tail}${ext}`
  return { chatDir, fileSeg, rel: `${SAVED_FILE_DIR}/${chatDir}/${fileSeg}` }
}

// ───────────────────────── sink ─────────────────────────

export interface SinkSpec {
  /** `mediaCacheStem('i:' + 訊息 id)`（32 碼 hex）。 */
  stem: string
  kind: MediaKind
  origin: MediaOrigin
  chatId: string
  /** 聊天室顯示名（檔案資料夾用；沒有就用 `chat`）。 */
  chatName?: string
  /** 原檔名（檔案用）。 */
  fileName?: string
  /** 訊息時間（ms；檔名的時間；沒有就用現在）。 */
  sentAt?: number
}

export type SinkResult = { status: 'written' | 'exists'; kind: MediaKind; rel: string; bytes: number; mime: string }
export type LineJsSinkTarget = SinkTarget & { readonly partName: string; readonly result: SinkResult | null }

const inside = (root: string, child: string) => child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep)

export class LineJsMediaSink {
  private readonly dataDir: string
  private readonly now: () => number
  private readonly locks = new Map<string, Promise<unknown>>()
  /**
   * 每個 stem 實際落地（link／rename 到落點成功）的次數（測試與 trace 用；同一個 stem 最多 1）。落地後驗證失敗而撤回的也算——
   * 大小不符的 part 必須在落地前就被擋下，這個計數證明它從未出現在落點。
   */
  readonly writes = new Map<string, number>()

  constructor(options: { dataDir: string; now?: () => number }) {
    this.dataDir = path.resolve(options.dataDir)
    this.now = options.now ?? Date.now
  }

  private check(spec: SinkSpec) {
    if (!spec || !STEM.test(String(spec.stem))) throw coded('SINK_STEM_INVALID')
    if (!['IMAGE', 'VIDEO', 'FILE'].includes(spec.kind)) throw coded('SINK_KIND_INVALID')
    if (spec.kind === 'FILE' && (typeof spec.chatId !== 'string' || !spec.chatId)) throw coded('SINK_CHAT_INVALID')
  }

  /** 同一個 stem 的工作串行執行（行程內）。 */
  private withLock<T>(stem: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(stem) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    const tail = run.catch(() => {})
    this.locks.set(stem, tail)
    void tail.then(() => { if (this.locks.get(stem) === tail) this.locks.delete(stem) })
    return run
  }

  /** dataDir 底下逐段確認（不是連結、是目錄、realpath 在 dataDir 內），沒有就建立。回傳絕對路徑。 */
  private async ensureDir(segments: string[]): Promise<string> {
    await mkdir(this.dataDir, { recursive: true })
    const root = await realpath(this.dataDir)
    let current = root
    for (const segment of segments) {
      if (!segment || segment === '.' || segment === '..' || segment.startsWith('.') || /[\\/:\u0000]/.test(segment)) throw coded('SINK_PATH_UNSAFE')
      current = path.join(current, segment)
      let st = await lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
      if (!st) {
        await mkdir(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
        st = await lstat(current)
      }
      if (st.isSymbolicLink() || !st.isDirectory()) throw coded('SINK_PATH_UNSAFE')
      if (!inside(root, await realpath(current))) throw coded('SINK_PATH_UNSAFE')
    }
    return current
  }

  /** 字面包含檢查（縱深防禦）：`rel` 解析後必須在 dataDir 底下。 */
  private absInside(rel: string): string {
    const abs = path.resolve(this.dataDir, ...rel.split('/'))
    if (!inside(this.dataDir, abs) || abs === this.dataDir) throw coded('SINK_PATH_UNSAFE')
    return abs
  }

  private async regularSize(abs: string): Promise<number | null> {
    try { const st = await lstat(abs); return st.isFile() && !st.isSymbolicLink() ? st.size : null } catch { return null }
  }

  /** 已經落地的媒體（照片、影片：任一副檔名的一般檔案且 >0 B；檔案：`.file.json` 通過 R-M07 且指向的檔案大小相符）。 */
  async existing(stem: string, kind: MediaKind): Promise<{ rel: string; bytes: number; mime: string } | null> {
    if (!STEM.test(String(stem))) throw coded('SINK_STEM_INVALID')
    if (kind === 'IMAGE' || kind === 'VIDEO') {
      for (const [mime, ext] of Object.entries(kind === 'IMAGE' ? IMAGE_EXT : VIDEO_EXT)) {
        const rel = `${SAVED_MEDIA_DIR}/${stem}.${ext}`
        const size = await this.regularSize(this.absInside(rel))
        if (size !== null && size > 0) return { rel, bytes: size, mime }
      }
      return null
    }
    const metaAbs = this.absInside(`${SAVED_MEDIA_DIR}/${stem}${SAVED_META_SUFFIX}`)
    if ((await this.regularSize(metaAbs)) === null) return null
    let bytes: Buffer
    try { bytes = await readFile(metaAbs) } catch { return null }
    let meta: { rel?: unknown; bytes?: unknown; mime?: unknown }
    try { meta = JSON.parse(bytes.toString('utf8')) } catch { return null }
    if (savedRelProblem(meta?.rel)) return null
    const size = await this.regularSize(this.absInside(meta.rel as string))
    if (savedRecordProblem(bytes, size)) return null
    return { rel: meta.rel as string, bytes: size as number, mime: String(meta.mime) }
  }

  /**
   * X1 streamDownload 的落點：part 在 `media-saved/.<stem>.<uuid>.part`（續傳時帶入 ledger 記下的 partName，必須屬於同一個 stem），
   * commit 時驗證並原子 rename。下載完成時落點已經存在（另一個 origin 先寫了）→ 丟掉 part，`result.status = 'exists'`。
   *
   * 續傳的 part 不可信時（review-x2a-r2 N-1）改用新的 partName，舊的那個 unlink：
   *   - 它的 nlink > 1：link 落地之後、unlink(part) 之前崩潰，part 與最終檔是同一個 inode，續傳的 truncate 會把已落地的檔就地截斷；
   *   - 這個 stem 已經落地（existing 命中）：part 只是殘留；
   *   - 它不是一般檔（連結或目錄）。
   * unlink 只移除 part 這個名稱：別名與最終檔共用的 inode 仍由最終檔的名稱持有，最終檔的內容不變。
   */
  async targetFor(spec: SinkSpec, options: { partName?: string } = {}): Promise<LineJsSinkTarget> {
    try {
      this.check(spec)
      const match = options.partName ? PART_NAME.exec(options.partName) : null
      let resumeName = match && match[1] === spec.stem ? options.partName as string : null
      const dir = await this.ensureDir([SAVED_MEDIA_DIR])
      if (resumeName) {
        const resumePath = path.join(dir, resumeName)
        const st = await lstat(resumePath).catch(() => null)
        if (st && (st.nlink > 1 || st.isSymbolicLink() || !st.isFile() || (await this.existing(spec.stem, spec.kind)))) {
          await unlink(resumePath).catch(() => {})
          resumeName = null
        }
      }
      const partName = resumeName ?? partNameFor(spec.stem)
      const partPath = path.join(dir, partName)
      let result: SinkResult | null = null
      return {
        partName,
        partPath,
        statfsDir: this.dataDir,
        get result() { return result },
        commit: async (committed: string, info: { mime: string; bytes: number }) => {
          if (path.resolve(committed) !== path.resolve(partPath)) throw coded('SINK_PART_UNKNOWN')
          try { result = await this.withLock(spec.stem, () => this.commitPart(spec, partPath, info)) } catch (error) { throw sinkError(error) }
        },
      }
    } catch (error) { throw sinkError(error) }
  }

  /** 記憶體裡的位元組（outbound 送出後、回填等）：同樣先寫 part（fsync）、驗證、不覆寫地落地；已存在就完全不寫。 */
  async saveBytes(spec: SinkSpec, bytes: Uint8Array, mime: string): Promise<SinkResult> {
    try {
      this.check(spec)
      return await this.withLock(spec.stem, async () => {
        const found = await this.existing(spec.stem, spec.kind)
        if (found) return { status: 'exists', kind: spec.kind, rel: found.rel, bytes: found.bytes, mime: found.mime }
        const dir = await this.ensureDir([SAVED_MEDIA_DIR])
        const partPath = path.join(dir, partNameFor(spec.stem))
        await writeFileDurable(partPath, bytes)
        // the bytes are in memory: nothing to resume from, so the part never outlives the call
        try { return await this.commitPart(spec, partPath, { mime, bytes: bytes.length }) } finally { await unlink(partPath).catch(() => {}) }
      })
    } catch (error) { throw sinkError(error) }
  }

  /**
   * 不覆寫的落地（F-1）：hard link `from` → `to`；`to` 已存在 → false（不覆寫、不刪任何東西）。成功時 `from` 仍在，由呼叫端移除。
   * 磁碟不支援 hard link → 以最終路徑為鍵的行程內鎖＋lstat＋rename（此時 `from` 已被移走）。
   */
  private async land(from: string, to: string): Promise<boolean> {
    try { await link(from, to); return true } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') return false
      if (!code || !LINK_UNSUPPORTED.has(code)) throw error
    }
    return this.withLock(`path:${to.toLowerCase()}`, async () => {
      if (await lstat(to).then(() => true, () => false)) return false
      await rename(from, to)
      return true
    })
  }

  /** 鎖內：驗證 part → 已存在就丟掉 part → 依 kind 不覆寫地落地（檔案再寫 `.file.json`）。 */
  private async commitPart(spec: SinkSpec, partPath: string, info: { mime: string; bytes: number }): Promise<SinkResult> {
    const partSize = await this.regularSize(partPath)
    if (partSize === null) throw coded('SINK_PART_MISSING', 'transient')
    // F-5 大小在落地前驗證：part 與呼叫端算的位元組數不同 → part 不可信，丟掉（下一次從頭來），不會出現在落點
    if (!Number.isSafeInteger(info.bytes) || partSize !== info.bytes) { await unlink(partPath).catch(() => {}); throw coded('SINK_SIZE_MISMATCH', 'transient') }
    const found = await this.existing(spec.stem, spec.kind)
    if (found) { await unlink(partPath).catch(() => {}); return { status: 'exists', kind: spec.kind, rel: found.rel, bytes: found.bytes, mime: found.mime } }
    if (spec.kind === 'FILE') return this.commitFile(spec, partPath, info.bytes, info.mime)

    // 照片、影片：副檔名依內容（宣告的 MIME 必須與內容相同）
    const table = spec.kind === 'IMAGE' ? IMAGE_EXT : VIDEO_EXT
    const ext = table[String(info.mime).toLowerCase()]
    const contentMime = await this.contentMime(spec.kind, partPath, partSize)
    if (!ext || contentMime !== String(info.mime).toLowerCase()) { await unlink(partPath).catch(() => {}); throw coded('SINK_CONTENT_MISMATCH') }
    const mediaDir = await this.ensureDir([SAVED_MEDIA_DIR])
    const rel = `${SAVED_MEDIA_DIR}/${spec.stem}.${ext}`
    this.absInside(rel)
    const finalAbs = path.join(mediaDir, `${spec.stem}.${ext}`)
    if (!(await this.land(partPath, finalAbs))) {
      // the name is taken: another writer of this stem (another sink instance) finished first, or something unusable sits there
      await unlink(partPath).catch(() => {})
      const other = await this.existing(spec.stem, spec.kind)
      if (other) return { status: 'exists', kind: spec.kind, rel: other.rel, bytes: other.bytes, mime: other.mime }
      throw coded('SINK_NAME_CONFLICT')
    }
    this.writes.set(spec.stem, (this.writes.get(spec.stem) ?? 0) + 1)
    // F-5 落地後再確認一次（part 在驗證與落地之間被改動）：不符就把剛落地的檔撤回（它是 link 獨佔建立的，一定是自己的）
    if ((await this.regularSize(finalAbs)) !== info.bytes) {
      await unlink(finalAbs).catch(() => {})
      await unlink(partPath).catch(() => {})
      throw coded('SINK_SIZE_MISMATCH', 'transient')
    }
    await unlink(partPath).catch(() => {})
    return { status: 'written', kind: spec.kind, rel, bytes: info.bytes, mime: contentMime }
  }

  /** 照片：≤64 MiB 做完整容器驗證，更大的看檔頭；影片：看檔頭（detectSupportedVideoMime）。 */
  private async contentMime(kind: MediaKind, partPath: string, size: number): Promise<string | null> {
    if (kind === 'IMAGE' && size <= IMAGE_FULL_CHECK_MAX_BYTES) return detectSupportedImageMime(await readFile(partPath))
    const handle = await open(partPath, 'r')
    try {
      const head = Buffer.alloc(Math.min(HEAD_BYTES, size))
      await handle.read(head, 0, head.length, 0)
      if (kind === 'VIDEO') return detectSupportedVideoMime(head)
      if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
      if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
      if (head.toString('latin1', 0, 4) === 'GIF8') return 'image/gif'
      if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
      return null
    } finally { await handle.close() }
  }

  private async commitFile(spec: SinkSpec, partPath: string, bytes: number, declaredMime: string): Promise<SinkResult> {
    const when = Number.isFinite(spec.sentAt) && (spec.sentAt as number) > 0 ? spec.sentAt as number : this.now()
    const dir = await this.ensureDir([SAVED_FILE_DIR, savedFilePlacement(spec, when).chatDir])
    // F-1／F-6 名稱依序試：原名 → `_<stem 前 8>`（同一聊天室、同一秒、同名的另一則訊息）→ `_<stem 前 8>-<隨機>`（崩潰留下的孤兒佔了前兩個）。
    // 每個名稱都以 link 獨佔建立：已存在就換下一個，絕不覆寫、絕不刪除既有的檔。
    let placement: ReturnType<typeof savedFilePlacement> | null = null
    for (let attempt = 0; attempt < NAME_ATTEMPTS && !placement; attempt++) {
      const suffix = attempt === 0 ? '' : attempt === 1 ? spec.stem.slice(0, 8) : `${spec.stem.slice(0, 8)}-${randomBytes(3).toString('hex')}`
      const candidate = savedFilePlacement(spec, when, suffix)
      // the rel the record will carry must pass R-M07 and stay inside dataDir literally; the file goes into the directory ensureDir verified
      if (savedRelProblem(candidate.rel)) { await unlink(partPath).catch(() => {}); throw coded('SINK_PATH_UNSAFE') }
      this.absInside(candidate.rel)
      if (await this.land(partPath, path.join(dir, candidate.fileSeg))) placement = candidate
    }
    if (!placement) { await unlink(partPath).catch(() => {}); throw coded('SINK_NAME_CONFLICT') }
    this.writes.set(spec.stem, (this.writes.get(spec.stem) ?? 0) + 1)
    const finalAbs = path.join(dir, placement.fileSeg)
    const ext = path.extname(placement.fileSeg).slice(1).toLowerCase()
    const mime = FILE_MIME_BY_EXT[ext] ?? (MIME_TOKEN.test(String(declaredMime)) && declaredMime !== 'application/octet-stream' ? String(declaredMime).toLowerCase() : 'application/octet-stream')
    const name = capLength(String(spec.fileName ?? '').normalize('NFKC').replace(INVISIBLE, '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim(), SAVED_SEGMENT_MAX) || placement.fileSeg
    let metaPart: string | null = null
    try {
      const mediaDir = await this.ensureDir([SAVED_MEDIA_DIR])
      metaPart = path.join(mediaDir, partNameFor(spec.stem))
      const actual = await this.regularSize(finalAbs)
      const record = Buffer.from(JSON.stringify({ v: 1, name, bytes, mime, rel: placement.rel }), 'utf8')
      const problem = savedRecordProblem(record, actual)
      if (problem) throw coded(`SINK_RECORD_${problem}`, problem === 'MISSING' || problem === 'SIZE_MISMATCH' ? 'transient' : 'unsupported')
      await writeFileDurable(metaPart, record)
      this.absInside(`${SAVED_MEDIA_DIR}/${spec.stem}${SAVED_META_SUFFIX}`)
      await rename(metaPart, path.join(mediaDir, `${spec.stem}${SAVED_META_SUFFIX}`))
    } catch (error) {
      // 沒有紀錄的檔案顯示鏈找不到：撤回（link 獨佔建立的，一定是自己的），下一次重新寫。
      // F-2c：I/O 錯誤保留 part（下一次從 part 續傳）；紀錄本身不合格或大小不符 → part 也不可信，丟掉。
      if (metaPart) await unlink(metaPart).catch(() => {})
      await unlink(finalAbs).catch(() => {})
      if (String((error as { code?: unknown })?.code).startsWith('SINK_')) await unlink(partPath).catch(() => {})
      throw error
    }
    await unlink(partPath).catch(() => {})
    return { status: 'written', kind: 'FILE', rel: placement.rel, bytes, mime }
  }
}
