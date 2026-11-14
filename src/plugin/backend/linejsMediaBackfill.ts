/**
 * linejsMediaBackfill.ts — X4 舊圖片回填與啟動對帳（implementation-plan.md §5.2 X4；implementation-plan-v2.md X4）。
 *
 * 啟動時跑一次：v1 自動下載（X2b 之前）已完成的照片在 `<dataDir>/linejs-downloads/.teamuq/<聊天室>/<檔名>`，顯示鏈只讀
 * `media-saved/<stem>.<ext>`（media.ts 先查 media-saved 再查 media-cache，所以不必再連一份到 media-cache）。這裡把它們以 hard link
 * 放進 media-saved：同一個 inode、不多佔空間，原檔保留不動。
 *
 *   1. 讀 v1 ledger（`auto-download-ledger.json`，唯讀；X2b 之後 v1 store 是 frozen，不會再修剪或改寫它）。項目的位置（savedRoot、
 *      chatFolder、savedName）只在 v1 裡有，v2 匯入時沒有帶過去。
 *   2. 只處理 status completed、kind IMAGE、位置在 `<dataDir>/linejs-downloads/.teamuq` 底下的項目（自訂的絕對路徑可能在別的磁碟，
 *      hard link 不能跨磁碟，也不該把 dataDir 外的檔連進來）→ 逐段確認是一般檔、不經過連結、大小與 v1 紀錄相同。
 *      `.teamuq` 本身是連結（junction／symlink）或 realpath 不在 realpath(linejs-downloads) 底下 → 整次不連、記 code、不算完成（review-x2b F-6）。
 *   3. 已經落地（sink.existing）→ 不連，只把 ledger 記成 done（v1 匯入的 V1_COMPLETED 標記改成 origin backfill）。
 *   4. 依內容判斷格式（detectSupportedImageMime，完整容器驗證）；判斷不出（例如 P0 R2 說的密文）→ 不連，ledger 記
 *      `failed／transient／LEGACY_INVALID`（不是終態：使用者仍可用「下載原檔」重新抓）。
 *   5. link(舊檔 → media-saved/.<stem>.<uuid>.part) → 共用 sink 的 commit（同一把 stem 鎖、大小與內容驗證、不覆寫的 link 落地、移除 part）。
 *      落地後 media-saved/<stem>.<ext> 與舊檔是同一個 inode；任何失敗都只移除 part 這個名稱，舊檔與既有的落點檔都不會被改寫或刪除。
 *   6. ledger v2 記 `origin:'backfill'`、done（recordExternal：冪等，已經是 done 就不寫）。
 *
 * 不支援 hard link（FAT／exFAT、網路磁碟：EPERM、ENOTSUP、EXDEV…）→ **跳過並記 code**（LEGACY_LINK_UNSUPPORTED），不退回 copy：
 *   - X4 的不變量是「空間不增加」，copy 會讓每張舊圖多佔一份；
 *   - `.teamuq` 與 media-saved 都在同一個 dataDir 底下，只有整個 dataDir 在不支援 hard link 的磁碟上才會遇到，那時舊檔仍在原處
 *     （設定頁可匯出），照片也可以從 LINE Cache 或「下載原檔」補回；
 *   - 這種狀態不算完成，下次啟動會再試（成本只有讀 v1 與 stat）。
 *
 * 冪等與「一次性」：結果寫在 `linejs-downloads/backfill-state.json`（v1 檔的 sha256 + 是否完成）。v1 沒變而且上次完成 → 不再掃描。
 * 強制重跑也一樣：已落地的只會回 exists，不會多一個連結、不會改 ledger。
 *
 * 啟動對帳的另一半：media-saved 裡崩潰留下的孤兒 part（`.<stem>.<uuid>.part`）——不是任何 ledger 紀錄的 partName（續傳要用）、
 * 而且超過 24 小時沒動（saveBytes 的 part 只活幾秒）→ 移除。unlink 只移除這個名稱：若它與落點檔是同一個 inode（review-x2a-r2 N-1），
 * 落點檔不受影響。ledger 讀不到時不清（不知道哪些 part 還有用）。v2 沒有「重新下載描述檔」（Q3 走電腦版那一列，不存 E2EE chunks），
 * 所以 IP1 的「刪除已完成項目的描述檔」不適用。
 *
 * 已接受的殘餘風險（review-m2 R2-01）：hard link 會繞過顯示鏈的包含檢查；這裡只連 `<dataDir>/linejs-downloads/.teamuq` 裡的檔。
 * log 只有計數與代碼，沒有路徑、檔名、聊天室或 id。
 */
import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { MAX_AUTO_DOWNLOAD_BYTES, MEDIA_LEDGER_V1_NAME, detectSupportedImageMime, mediaStem, writeFileDurable } from './linejsAutoDownload.mjs'
import type { MediaLedger } from './linejsAutoDownload.mjs'
import type { LineJsMediaSink } from './linejsMediaSink'
import { SAVED_MEDIA_DIR } from './media'

export const BACKFILL_STATE_NAME = 'backfill-state.json'
/** 孤兒 part 至少要這麼久沒動才移除。 */
export const ORPHAN_PART_MIN_AGE_MS = 24 * 60 * 60_000
const LEGACY_DIR = '.teamuq'
const PART_NAME = /^\.([0-9a-f]{32})\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$/
const OWNER_RE = /^[0-9a-f]{64}$/
/** 不支援 hard link 的 errno（與 sink 的 LINK_UNSUPPORTED 同一組）。 */
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EINVAL', 'EISDIR', 'EMLINK'])
const STATE_TEMP_RE = /^backfill-state\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$/

/** OriginalDownloadService 的子集（共用的 sink 與 ledger；I-1）。 */
export interface BackfillOriginals {
  readonly sink: LineJsMediaSink
  readonly ledger: MediaLedger
  ledgerReady(): Promise<boolean>
  recordExternal(owner: string, stem: string, kind: 'IMAGE', origin: 'backfill', outcome: { status: 'done'; bytes: number; mime: string } | { status: 'failed'; class: string; code: string }): Promise<boolean>
}

export interface BackfillOptions {
  dataDir: string
  originals: BackfillOriginals
  signal?: AbortSignal
  /** 強制重跑（忽略 backfill-state.json 的「已完成」）。 */
  force?: boolean
  now?: () => number
  log?: (line: string) => void
  /** 測試注入：取代 fs.link（模擬不支援 hard link 的磁碟）。 */
  link?: (existingPath: string, newPath: string) => Promise<void>
}

export interface BackfillReport {
  /** UP_TO_DATE：v1 沒變而且上次已完成，沒有掃描；NO_V1：沒有 v1 ledger；LEDGER_UNAVAILABLE：ledger v2 讀不到，不動任何東西。 */
  skipped: 'UP_TO_DATE' | 'NO_V1' | 'LEDGER_UNAVAILABLE' | 'ABORTED' | null
  complete: boolean
  counts: { candidates: number; linked: number; exists: number; invalid: number; missing: number; outside: number; unsafe: number; linkUnsupported: number; failed: number; orphansRemoved: number }
}

interface V1Item { key?: unknown; kind?: unknown; status?: unknown; messageId?: unknown; chatId?: unknown; chatFolder?: unknown; savedName?: unknown; savedRoot?: unknown; bytes?: unknown }

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const errCode = (error: unknown) => String((error as { code?: unknown } | null)?.code ?? 'ERROR').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'ERROR'
const plainSegment = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 255 && s !== '.' && s !== '..' && path.basename(s) === s && !/[\\/:\u0000]/.test(s)
const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

/** 啟動時一次性對帳。永遠不 throw（錯誤只記 code）。 */
export async function runBackfill(options: BackfillOptions): Promise<BackfillReport> {
  const counts: BackfillReport['counts'] = { candidates: 0, linked: 0, exists: 0, invalid: 0, missing: 0, outside: 0, unsafe: 0, linkUnsupported: 0, failed: 0, orphansRemoved: 0 }
  const log = (line: string) => { try { options.log?.(`[backfill] ${line}`) } catch { /* logging never breaks the backfill */ } }
  const report = (skipped: BackfillReport['skipped'], complete: boolean): BackfillReport => {
    log(`skipped=${skipped ?? '-'} complete=${complete} ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`)
    return { skipped, complete, counts }
  }
  try {
    const { originals } = options
    // a ledger that could not be loaded is never written over (same rule as the downloader): nothing is linked or cleaned meanwhile
    if (!(await originals.ledgerReady())) return report('LEDGER_UNAVAILABLE', false)
    const downloads = path.join(options.dataDir, 'linejs-downloads')
    counts.orphansRemoved = await removeOrphanParts(options, originals).catch(() => 0)
    let v1Bytes: Buffer
    try { v1Bytes = await readFile(path.join(downloads, MEDIA_LEDGER_V1_NAME)) } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== 'ENOENT') { log(`code=V1_UNREADABLE_${errCode(error)}`); return report(null, false) }
      return report('NO_V1', true)
    }
    const v1Sig = sha(v1Bytes)
    const state = await readState(downloads)
    if (!options.force && state?.v1Sig === v1Sig && state.complete === true) return report('UP_TO_DATE', true)
    let items: V1Item[] = []
    try { const doc = JSON.parse(v1Bytes.toString('utf8')); items = Array.isArray(doc?.items) ? doc.items : [] } catch { log('code=V1_CORRUPT'); return report(null, false) }

    const legacyRoot = path.resolve(downloads, LEGACY_DIR)
    // review-x2b F-6: `.teamuq` itself must be a plain directory (lstat: not a link / junction), and its realpath must be inside the
    // realpath of linejs-downloads — otherwise a junction would hard-link files from outside dataDir into media-saved. Not complete:
    // nothing is linked, the next start looks again (cost: reading v1 and two stats)
    const rootCheck = await checkLegacyRoot(downloads, legacyRoot)
    if (rootCheck.code) { log(`code=${rootCheck.code}`); return report(null, false) }
    const realRoot = rootCheck.realRoot
    let transient = 0
    let n = 0
    for (const item of items) {
      if (options.signal?.aborted) return report('ABORTED', false)
      if (++n % 50 === 0) await yieldLoop()
      if (item?.kind !== 'IMAGE' || item.status !== 'completed') continue
      counts.candidates++
      const outcome = await backfillOne(item, { options, originals, legacyRoot, realRoot })
      counts[outcome.count]++
      if (outcome.transient) transient++
      if (outcome.code) log(`item code=${outcome.code}`)
    }
    const complete = transient === 0
    await writeState(downloads, { version: 1, v1Sig, complete, at: (options.now ?? Date.now)() }).catch((error) => log(`code=STATE_WRITE_FAILED_${errCode(error)}`))
    return report(null, complete)
  } catch (error) {
    log(`code=BACKFILL_FAILED_${errCode(error)}`)
    return report(null, false)
  }
}

/**
 * F-6：`<dataDir>/linejs-downloads/.teamuq` 的檢查（依序）。
 *   - 不存在 → realRoot null（沿用原本的路徑：每一項都會是 outside／unsafe，什麼都不連）。
 *   - realpath(.teamuq) 不在 realpath(linejs-downloads) 底下 → LEGACY_ROOT_OUTSIDE（junction／symlink 指到 dataDir 外）。
 *   - lstat 是連結（symlink、junction，就算指向 linejs-downloads 裡面）或不是目錄 → LEGACY_ROOT_LINK。
 *   - 讀不到 → LEGACY_ROOT_<errno>。
 */
async function checkLegacyRoot(downloads: string, legacyRoot: string): Promise<{ realRoot: string | null; code: string | null }> {
  let st: Awaited<ReturnType<typeof lstat>>
  try { st = await lstat(legacyRoot) } catch (error) {
    return (error as { code?: unknown } | null)?.code === 'ENOENT' ? { realRoot: null, code: null } : { realRoot: null, code: `LEGACY_ROOT_${errCode(error)}` }
  }
  let realDownloads: string
  let realRoot: string
  try { [realDownloads, realRoot] = await Promise.all([realpath(downloads), realpath(legacyRoot)]) } catch (error) { return { realRoot: null, code: `LEGACY_ROOT_${errCode(error)}` } }
  const rel = path.relative(realDownloads, realRoot)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { realRoot: null, code: 'LEGACY_ROOT_OUTSIDE' }
  if (st.isSymbolicLink() || !st.isDirectory()) return { realRoot: null, code: 'LEGACY_ROOT_LINK' }
  return { realRoot, code: null }
}

type Count = keyof BackfillReport['counts']

async function backfillOne(item: V1Item, ctx: { options: BackfillOptions; originals: BackfillOriginals; legacyRoot: string; realRoot: string | null }): Promise<{ count: Count; transient?: boolean; code?: string }> {
  const { originals, legacyRoot, realRoot } = ctx
  const owner = typeof item.key === 'string' ? item.key.split('\0')[0] : ''
  const messageId = String(item.messageId ?? '')
  if (!OWNER_RE.test(owner) || !/^\d{1,32}$/.test(messageId)) return { count: 'unsafe', code: 'LEGACY_ITEM_INVALID' }
  // only files inside <dataDir>/linejs-downloads/.teamuq (a custom absolute v1 path may be another disk or outside dataDir); v1 stored the
  // realpath of that root, so both the literal and the canonical form are accepted
  const saved = typeof item.savedRoot === 'string' ? path.resolve(item.savedRoot).toLowerCase() : null
  if (!saved || (saved !== legacyRoot.toLowerCase() && saved !== realRoot?.toLowerCase())) return { count: 'outside', code: 'LEGACY_OUTSIDE_ROOT' }
  if (!realRoot || !plainSegment(item.chatFolder) || !plainSegment(item.savedName)) return { count: 'unsafe', code: 'LEGACY_PATH_UNSAFE' }
  const dir = path.join(realRoot, item.chatFolder)
  const file = path.join(dir, item.savedName)
  let size: number
  try {
    const dirStat = await lstat(dir)
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory() || (await realpath(dir)) !== dir) return { count: 'unsafe', code: 'LEGACY_PATH_UNSAFE' }
    const st = await lstat(file)
    if (st.isSymbolicLink() || !st.isFile() || (await realpath(file)) !== file) return { count: 'unsafe', code: 'LEGACY_PATH_UNSAFE' }
    size = st.size
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === 'ENOENT' ? { count: 'missing', code: 'LEGACY_MISSING' } : { count: 'failed', transient: true, code: `LEGACY_STAT_${errCode(error)}` }
  }
  if (size <= 0 || (Number.isSafeInteger(item.bytes) && item.bytes !== size)) return { count: 'missing', code: 'LEGACY_SIZE_MISMATCH' }
  if (size > MAX_AUTO_DOWNLOAD_BYTES) return { count: 'invalid', code: 'LEGACY_TOO_LARGE' }
  const stem = mediaStem(`i:${messageId}`)

  // already landed (receive / history / outbound wrote it, or an earlier backfill): never a second link; the ledger only learns it is done
  const landed = await originals.sink.existing(stem, 'IMAGE').catch(() => null)
  if (landed) {
    await originals.recordExternal(owner, stem, 'IMAGE', 'backfill', { status: 'done', bytes: landed.bytes, mime: landed.mime })
    return { count: 'exists' }
  }
  let mime: string | null
  try { mime = detectSupportedImageMime(await readFile(file)) } catch (error) { return { count: 'failed', transient: true, code: `LEGACY_READ_${errCode(error)}` } }
  if (!mime) {
    // not an image the display chain can show (e.g. ciphertext saved by the old path): not linked; the original can still be downloaded
    await originals.recordExternal(owner, stem, 'IMAGE', 'backfill', { status: 'failed', class: 'transient', code: 'LEGACY_INVALID' })
    return { count: 'invalid', code: 'LEGACY_INVALID' }
  }
  let target: Awaited<ReturnType<LineJsMediaSink['targetFor']>>
  try { target = await originals.sink.targetFor({ stem, kind: 'IMAGE', origin: 'backfill', chatId: typeof item.chatId === 'string' && item.chatId ? item.chatId : 'legacy' }) } catch (error) {
    return { count: 'failed', transient: (error as { class?: unknown } | null)?.class !== 'unsupported', code: `SINK_${errCode(error)}` }
  }
  try {
    try { await (ctx.options.link ?? link)(file, target.partPath) } catch (error) {
      const code = errCode(error)
      if (LINK_UNSUPPORTED.has(code)) return { count: 'linkUnsupported', transient: true, code: 'LEGACY_LINK_UNSUPPORTED' }
      return { count: 'failed', transient: true, code: `LEGACY_LINK_${code}` }
    }
    // the shared sink lands it: stem lock, size and content checks, no-overwrite link, part removed (only that name)
    await target.commit(target.partPath, { mime, bytes: size })
    const result = target.result
    if (!result) return { count: 'failed', transient: true, code: 'SINK_NO_RESULT' }
    await originals.recordExternal(owner, stem, 'IMAGE', 'backfill', { status: 'done', bytes: result.bytes, mime: result.mime })
    return { count: result.status === 'written' ? 'linked' : 'exists' }
  } catch (error) {
    const e = error as { class?: unknown } | null
    return { count: 'failed', transient: e?.class !== 'unsupported', code: errCode(error) }
  } finally {
    // the part is only another name of the old file: removing it never touches the old file or a landed one
    await unlink(target.partPath).catch(() => {})
  }
}

/** media-saved 裡的孤兒 part：不是任何 ledger 紀錄的 partName，而且超過 ORPHAN_PART_MIN_AGE_MS 沒動。 */
async function removeOrphanParts(options: BackfillOptions, originals: BackfillOriginals): Promise<number> {
  const dir = path.join(options.dataDir, SAVED_MEDIA_DIR)
  let names: string[]
  try { names = await readdir(dir) } catch { return 0 }
  const referenced = new Set<string>()
  for (const entry of originals.ledger.entries.values()) if (entry.partName) referenced.add(entry.partName)
  const now = (options.now ?? Date.now)()
  let removed = 0
  for (const name of names) {
    if (!PART_NAME.test(name) || referenced.has(name)) continue
    const abs = path.join(dir, name)
    try {
      const st = await lstat(abs)
      if (!st.isFile() || st.isSymbolicLink() || now - st.mtimeMs < ORPHAN_PART_MIN_AGE_MS) continue
      await unlink(abs)
      removed++
    } catch { /* gone or busy: next start */ }
  }
  return removed
}

interface BackfillState { version: 1; v1Sig: string; complete: boolean; at: number }

async function readState(dir: string): Promise<BackfillState | null> {
  try {
    const v = JSON.parse(await readFile(path.join(dir, BACKFILL_STATE_NAME), 'utf8'))
    return v && v.version === 1 && typeof v.v1Sig === 'string' && typeof v.complete === 'boolean' ? v as BackfillState : null
  } catch { return null }
}

async function writeState(dir: string, state: BackfillState): Promise<void> {
  await mkdir(dir, { recursive: true })
  for (const name of await readdir(dir).catch(() => [] as string[])) if (STATE_TEMP_RE.test(name)) await unlink(path.join(dir, name)).catch(() => {})
  const target = path.join(dir, BACKFILL_STATE_NAME)
  const temp = `${target}.${randomUUID()}.part`
  await writeFileDurable(temp, JSON.stringify(state))
  try { await rename(temp, target) } catch (error) { await unlink(temp).catch(() => {}); throw error }
}
