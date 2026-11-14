/**
 * linejsMediaStream.ts — Pro 的串流下載器（X1；implementation-plan.md §2、implementation-plan-v2.md X1、history-download.md §5–§6）。
 *
 * `streamDownload(locator, session, target, opts)`：以 MediaLocator 為輸入，從 OBS 串流下載一個照片／影片／檔案，不限大小、
 * 記憶體固定（約一個網路區塊＋64 KiB 判斷緩衝＋256 KiB 寫入批次，與檔案大小無關），位元組只在 backend 與磁碟之間流動。
 *
 *   fetch body → [E2EE] 扣住最後 32 B（HMAC sign）→ HMAC-SHA256(macKey) 累計密文 ‖ AES-256-CTR 解密
 *              → 前 64 KiB 明文判斷魔術位元組（照片、影片；不符立刻中止，不建 part）
 *              → part 檔（0600；呼叫端給路徑，續傳用同一個）
 *   結束：HMAC（timingSafeEqual）→ 大小 → fsync → 照片 ≤64 MiB 再做完整容器驗證 → target.commit(part)
 *
 *   - 續傳：part 截到 16 B 的倍數 N；E2EE 以同一組 encKey／nonce 把 part 明文重新加密餵回 HMAC（CTR 是 XOR，不必存密文），
 *     decipher 的 IV = nonce＋N/16；送 `Range: bytes=N-`。回 200 就截掉 part、用這個回應從頭寫；回應帶 content-encoding 就關閉續傳。
 *     伺服器不支援 Range 時一律從頭重試（P0 R5／P0b U6 之前的預設）。
 *   - 重試：transient 以指數退避（1 s 起、上限 60 s）最多 5 次；HMAC 不符刪 part、從頭重試一次，再不符判定失敗。
 *   - 長度與完整性（X1b）：已知宣告大小時，先看收到的長度——比預期短就是連線截斷（transient OBS_TRUNCATED，從 part 續傳），
 *     不判成永久的 HMAC／SIZE 失敗（L-1）。E2EE 以 HMAC 為準：HMAC 通過但大小與宣告不符時只記錄、保留檔案（L-2）；
 *     非 E2EE 沒有 HMAC，大小不符仍判 SIZE_MISMATCH。
 *     rate_limited、auth 讓共用限流全域暫停並回 paused；DISK_LOW（statfs 保留 2 GiB）回 paused、保留 part。
 *   - 中止：opts.signal 中止 → 正在進行的 fetch 被中止、part 保留，回 paused（ABORTED）；之後該下載情境裡新的 LINEJS／OBS 呼叫一律拒絕。
 *   - 逾時：等回應標頭最多 30 s、兩個區塊之間最多 60 s 沒有資料；逾時會真的中止 fetch。
 *   - log 只有種類、傳輸方式、優先順序、分類、碼與位元組數；沒有 id、URL、token、keyMaterial。
 */
import { createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto'
import { open, readFile, statfs as fsStatfs, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { deriveFileKeys } from '../../main/media/decrypt'
import type { FileKeys } from '../../main/media/decrypt'
import * as linejsAutoDownload from './linejsAutoDownload.mjs'
import { createLineJsMediaFetch } from './linejsMedia'
import {
  buildObsRequest, classifyObsOutcome, keyMaterialBytes, lineJsContextAbortError, locatorProblem, runInLineJsContext, sharedObsLimiter
} from './linejsObs'
import type { MediaLocator, ObsClass, ObsLimiter, ObsPriority, Outcome } from './linejsObs'

export type { MediaLocator, Outcome, ObsClass, ObsPriority } from './linejsObs'

/** 落點（X2a 的 sink 提供）：part 檔路徑、statfs 量測的目錄，以及驗證完成後把 part 放到最終位置的 commit。 */
export interface SinkTarget {
  /** part 檔的絕對路徑（同一個 stem 續傳時給同一個；不存在就新建，flag wx、0600）。 */
  partPath: string
  /** statfs 量測剩餘空間的目錄（dataDir）。 */
  statfsDir: string
  /**
   * HMAC、大小與格式都驗證過、part 已 fsync 之後呼叫。拋出的錯誤依 `class` 對應（review-x2a F-2b）：
   *   - `class: 'unsupported'`（內容不符、名稱衝突、路徑不安全…）→ 終態 failed/unsupported/<code>，不再重抓；
   *   - `code: 'ENOSPC'` → paused/disk_low，part 保留；
   *   - 其他（I/O）→ transient SINK_COMMIT_FAILED，part 保留（sink 沒刪就從 part 續傳）。
   */
  commit(partPath: string, info: { mime: string; bytes: number }): Promise<void>
}

export interface StreamSession {
  client: any
  sessionId: string
  /** 開始每一次嘗試前檢查；回 false → paused（auth / SESSION_GONE）。 */
  isCurrent?: () => boolean
}

export interface StreamOptions {
  signal: AbortSignal
  priority: ObsPriority
  /** 以下都是可省略的依賴（測試注入）。 */
  limiter?: ObsLimiter
  fetch?: (request: Request) => Promise<Response>
  statfs?: (dir: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>
  reserveBytes?: number
  diskCheckEveryBytes?: number
  maxAttempts?: number
  backoffMs?: (attempt: number) => number
  headersTimeoutMs?: number
  idleTimeoutMs?: number
  log?: (line: string) => void
}

export const DISK_RESERVE_BYTES = 2 * 1024 ** 3
export const DISK_CHECK_EVERY_BYTES = 64 * 1024 ** 2
export const SNIFF_BYTES = 64 * 1024
export const IMAGE_FULL_CHECK_MAX_BYTES = 64 * 1024 ** 2
export const STREAM_MAX_ATTEMPTS = 5
export const HEADERS_TIMEOUT_MS = 30_000
export const IDLE_TIMEOUT_MS = 60_000
const HMAC_BYTES = 32
const WRITE_BATCH_BYTES = 256 * 1024
const REHASH_CHUNK_BYTES = 1024 * 1024
/** Full container check of a finished image (same function assemble.ts hands to the outbound sender; not in the .d.mts). */
const detectSupportedImageMime = (linejsAutoDownload as unknown as { detectSupportedImageMime(bytes: Uint8Array): string | null }).detectSupportedImageMime
const defaultBackoff =(attempt: number) => Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1))

type Failed = Extract<Outcome, { status: 'failed' | 'paused' }>
const failed = (cls: ObsClass, code: string): Failed => ({ status: 'failed', class: cls, code })
const paused = (cls: ObsClass, code: string, retryAfterMs?: number): Failed => (retryAfterMs === undefined ? { status: 'paused', class: cls, code } : { status: 'paused', class: cls, code, retryAfterMs })
const ABORTED = (): Failed => paused('transient', 'ABORTED')

/** 前 64 KiB（或整個小檔）明文的格式判斷。檔案沒有魔術位元組可判斷（E2EE 靠 HMAC、非 E2EE 靠大小）。 */
export function sniffPlaintext(kind: MediaLocator['kind'], head: Buffer): { ok: true; mime: string } | { ok: false; code: string } {
  const ascii = (a: number, b: number) => head.length >= b ? head.toString('latin1', a, b) : ''
  if (kind === 'FILE') return { ok: true, mime: 'application/octet-stream' }
  if (kind === 'IMAGE') {
    if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ok: true, mime: 'image/png' }
    if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { ok: true, mime: 'image/jpeg' }
    if (ascii(0, 4) === 'GIF8') return { ok: true, mime: 'image/gif' }
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { ok: true, mime: 'image/webp' }
    return { ok: false, code: 'CONTENT_NOT_PLAINTEXT' }
  }
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12)
    if (brand === 'qt  ') return { ok: true, mime: 'video/quicktime' }
    // the same list the sink's detectSupportedVideoMime refuses (F-2a): a brand accepted here and refused there would download the whole object for nothing
    if (linejsAutoDownload.isUnsupportedVideoBrand(brand)) return { ok: false, code: 'VIDEO_TYPE_UNSUPPORTED' }
    return { ok: true, mime: 'video/mp4' }
  }
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return { ok: true, mime: 'video/webm' }
  return { ok: false, code: 'CONTENT_NOT_PLAINTEXT' }
}

/** AES-256-CTR 的 IV 從 `offset`（16 的倍數）開始：128-bit 計數器加上 offset/16。 */
export function ctrIvAt(nonce: Buffer, offset: number): Buffer {
  if (offset % 16 !== 0) throw Object.assign(new Error('CTR offset not aligned'), { code: 'CTR_OFFSET_UNALIGNED' })
  const counter = (BigInt(`0x${nonce.toString('hex')}`) + BigInt(offset / 16)) & ((1n << 128n) - 1n)
  return Buffer.from(counter.toString(16).padStart(32, '0'), 'hex')
}

async function partSize(partPath: string): Promise<number> {
  try { const handle = await open(partPath, 'r'); try { return (await handle.stat()).size } finally { await handle.close() } } catch { return 0 }
}
const removePart = (partPath: string) => unlink(partPath).catch(() => {})

/** 一次嘗試的結果：完成、HMAC 不符（刪 part）、或一個要回報／重試的 outcome（`noResume`：之後不要再送 Range）。 */
type Attempt = { kind: 'done'; bytes: number; mime: string } | { kind: 'hmac' } | { kind: 'outcome'; outcome: Failed; noResume?: boolean }

/**
 * 串流下載一個媒體。回傳：done（已 commit）、failed（終態或重試用完）、paused（限流、登入、磁碟空間、中止；條件解除後可再呼叫，
 * 會從 part 續傳）。
 */
export async function streamDownload(locator: MediaLocator, session: StreamSession, target: SinkTarget, opts: StreamOptions): Promise<Outcome> {
  const log = (line: string) => { try { opts.log?.(line) } catch { /* logging never breaks a download */ } }
  const label = `kind=${locator?.kind} transport=${locator?.transport} priority=${opts.priority}`
  const report = (outcome: Outcome): Outcome => {
    if (outcome.status === 'done') log(`stream_done ${label} bytes=${outcome.bytes} mime=${outcome.mime}`)
    else log(`stream_${outcome.status} ${label} class=${outcome.class} code=${outcome.code}`)
    return outcome
  }
  const problem = locatorProblem(locator)
  if (problem) return report(failed(problem.class, problem.code))
  if (opts.signal.aborted) return report(ABORTED())
  log(`stream_start ${label}`)
  return report(await runInLineJsContext('download', () => new StreamJob(locator, session, target, opts).run(), opts.signal))
}

class StreamJob {
  private readonly limiter: ObsLimiter
  private readonly fetch: (request: Request) => Promise<Response>
  private readonly statfs: NonNullable<StreamOptions['statfs']>
  private readonly reserve: number
  private readonly diskEvery: number
  private readonly e2ee: boolean
  private keys: FileKeys | null = null
  private resumable = true
  // plain fields, not TypeScript parameter properties: the tests load this file with node --experimental-strip-types
  private readonly locator: MediaLocator
  private readonly session: StreamSession
  private readonly target: SinkTarget
  private readonly opts: StreamOptions

  constructor(locator: MediaLocator, session: StreamSession, target: SinkTarget, opts: StreamOptions) {
    this.locator = locator
    this.session = session
    this.target = target
    this.opts = opts
    this.limiter = opts.limiter ?? sharedObsLimiter
    this.fetch = opts.fetch ?? createLineJsMediaFetch()
    this.statfs = opts.statfs ?? ((dir) => fsStatfs(dir))
    this.reserve = opts.reserveBytes ?? DISK_RESERVE_BYTES
    this.diskEvery = opts.diskCheckEveryBytes ?? DISK_CHECK_EVERY_BYTES
    this.e2ee = locator.transport === 'e2ee'
  }

  /** 記錄一行（只有種類、碼與位元組數；log 失敗不影響下載）。 */
  private note(line: string) { try { this.opts.log?.(line) } catch { /* logging never breaks a download */ } }

  /** 明文總長（已知時）。 */
  private get declared(): number | null { return Number.isSafeInteger(this.locator.declaredBytes) ? this.locator.declaredBytes as number : null }

  private async diskOk(alreadyHave: number): Promise<boolean> {
    let free: number
    try {
      const s = await this.statfs(this.target.statfsDir)
      free = Number(s.bavail) * Number(s.bsize)
    } catch { return true /* statfs unavailable: the write itself reports ENOSPC */ }
    const remaining = this.declared === null ? 0 : Math.max(0, this.declared - alreadyHave)
    return free >= remaining + this.reserve
  }

  private sleep(ms: number): Promise<void> {
    const signal = this.opts.signal
    return new Promise((resolve) => {
      if (ms <= 0 || signal.aborted) { resolve(); return }
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
      const timer = setTimeout(done, ms)
      signal.addEventListener('abort', done, { once: true })
    })
  }

  async run(): Promise<Outcome> {
    if (this.e2ee) this.keys = deriveFileKeys(keyMaterialBytes(this.locator.keyMaterial) as Buffer)
    try {
      let transientFailures = 0
      let hmacRetried = false
      for (;;) {
        if (this.opts.signal.aborted) return ABORTED()
        if (this.session.isCurrent && !this.session.isCurrent()) return paused('auth', 'SESSION_GONE')
        const have = await partSize(this.target.partPath)
        const start = this.resumable ? have - (have % 16) : 0
        if (!(await this.diskOk(start))) return paused('disk_low', 'DISK_LOW')
        // review-x1 L-3: sessionId and isCurrent ride along, so only the current session can lift another session's 401 pause
        const ticket = await this.limiter.acquire(this.opts.priority, { signal: this.opts.signal, sessionId: this.session.sessionId, isCurrent: this.session.isCurrent })
        if (!ticket.ok) return ticket.outcome
        let attempt: Attempt
        try { attempt = await this.attempt(start) } finally { ticket.release() }
        if (attempt.kind === 'done') return { status: 'done', bytes: attempt.bytes, mime: attempt.mime }
        if (attempt.kind === 'hmac') {
          await removePart(this.target.partPath)
          if (hmacRetried) return failed('undecryptable', 'HMAC_MISMATCH')
          hmacRetried = true
          this.opts.log?.(`stream_retry kind=${this.locator.kind} code=HMAC_MISMATCH from=0`)
          continue
        }
        const outcome = attempt.outcome
        if (attempt.noResume) this.resumable = false
        if (outcome.status === 'paused') return outcome
        if (outcome.class === 'rate_limited') { this.limiter.pauseRateLimited(outcome.retryAfterMs ?? 0); return paused('rate_limited', outcome.code, outcome.retryAfterMs) }
        if (outcome.class === 'auth') { this.limiter.pauseAuth(this.session.sessionId); return paused('auth', outcome.code) }
        if (outcome.class === 'transient') {
          transientFailures++
          if (transientFailures >= (this.opts.maxAttempts ?? STREAM_MAX_ATTEMPTS)) return outcome
          this.opts.log?.(`stream_retry kind=${this.locator.kind} code=${outcome.code} attempt=${transientFailures}`)
          await this.sleep((this.opts.backoffMs ?? defaultBackoff)(transientFailures))
          continue
        }
        // terminal (expired, forbidden, undecryptable, unsupported): the object will not become usable, the part is useless
        await removePart(this.target.partPath)
        return outcome
      }
    } finally { this.keys?.derived.fill(0) }
  }

  /** 把 part 前 `n` B 的明文重新加密成原本的密文，餵給新的 HMAC（續傳時）。 */
  private async rehash(hmac: ReturnType<typeof createHmac>, n: number) {
    const keys = this.keys as FileKeys
    const cipher = createCipheriv('aes-256-ctr', keys.encKey, keys.nonce)
    const handle = await open(this.target.partPath, 'r')
    try {
      const buf = Buffer.alloc(Math.min(REHASH_CHUNK_BYTES, Math.max(1, n)))
      for (let pos = 0; pos < n;) {
        const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, n - pos), pos)
        if (bytesRead <= 0) throw Object.assign(new Error('part shorter than expected'), { code: 'PART_IO' })
        hmac.update(cipher.update(buf.subarray(0, bytesRead)))
        pos += bytesRead
      }
    } finally { await handle.close() }
  }

  private async attempt(start: number): Promise<Attempt> {
    const signal = this.opts.signal
    const controller = new AbortController()
    let timedOut = false
    let handle: FileHandle | null = null
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    let held: Response | null = null
    // An abort or a timeout aborts the request's signal AND cancels the body reader directly, so it never depends on the signal reaching
    // the network layer (a pending read then ends at once; the loop below tells abort / timeout apart from a real end of stream).
    const stop = () => { controller.abort(); void reader?.cancel().catch(() => {}) }
    const arm = (ms: number) => setTimeout(() => { timedOut = true; stop() }, ms)
    const onAbort = () => stop()
    signal.addEventListener('abort', onAbort, { once: true })
    let timer: ReturnType<typeof setTimeout> | null = arm(this.opts.headersTimeoutMs ?? HEADERS_TIMEOUT_MS)
    const clear = () => { if (timer) clearTimeout(timer); timer = null }
    const stopped = (): Attempt | null => signal.aborted ? { kind: 'outcome', outcome: ABORTED() } : timedOut ? { kind: 'outcome', outcome: failed('transient', 'OBS_TIMEOUT') } : null
    try {
      // a download context that has been aborted makes no new LINEJS / OBS call
      if (lineJsContextAbortError() || signal.aborted) return { kind: 'outcome', outcome: ABORTED() }
      let response: Response
      try {
        const pending = this.fetch(buildObsRequest(this.session.client, this.locator, { rangeStart: start, signal: controller.signal }))
        // the headers wait ends with the abort / timeout even if the fetch does not; a response that still arrives is cancelled
        let accepted = false
        const raced = new Promise<Response>((resolve, reject) => {
          const onStop = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          if (controller.signal.aborted) { onStop(); return }
          controller.signal.addEventListener('abort', onStop, { once: true })
          pending.then((value) => { controller.signal.removeEventListener('abort', onStop); accepted = !controller.signal.aborted; resolve(value) }, (error) => { controller.signal.removeEventListener('abort', onStop); reject(error) })
        })
        pending.then((late) => { if (!accepted) void late.body?.cancel().catch(() => {}) }, () => {})
        response = held = await raced
      } catch (error) {
        if (signal.aborted) return { kind: 'outcome', outcome: ABORTED() }
        const c = classifyObsOutcome({ error, timedOut })
        return { kind: 'outcome', outcome: failed(c.class, c.code) }
      }
      clear()
      const cancelBody = () => response.body?.cancel().catch(() => {})
      if (response.status !== 200 && response.status !== 206) {
        await cancelBody()
        if (response.status === 416 && start > 0) { await removePart(this.target.partPath); return { kind: 'outcome', outcome: failed('transient', 'RANGE_NOT_SATISFIABLE'), noResume: true } }
        const c = classifyObsOutcome({ status: response.status, headers: response.headers })
        return { kind: 'outcome', outcome: c.retryAfterMs === undefined ? failed(c.class, c.code) : { status: 'failed', class: c.class, code: c.code, retryAfterMs: c.retryAfterMs } }
      }
      const encoding = (response.headers.get('content-encoding') ?? '').trim().toLowerCase()
      const encoded = encoding !== '' && encoding !== 'identity'
      let offset = 0
      let objectTotal: number | null = null
      if (response.status === 206) {
        const range = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get('content-range') ?? '')
        if (encoded || !range || Number(range[1]) !== start) {
          // the bytes would not line up with the part: drop it and download from the beginning without Range
          await cancelBody()
          await removePart(this.target.partPath)
          return { kind: 'outcome', outcome: failed('transient', 'RANGE_MISMATCH'), noResume: true }
        }
        offset = start
        objectTotal = Number(range[3])
      } else {
        const length = Number(response.headers.get('content-length'))
        if (!encoded && response.headers.has('content-length') && Number.isSafeInteger(length)) objectTotal = length
      }
      const noResume = encoded
      const declared = this.declared
      const expectedTotal = declared === null ? null : declared + (this.e2ee ? HMAC_BYTES : 0)
      // L-2: E2EE 以 HMAC 為準——伺服器給的長度與宣告不符時照樣下載，結尾的 HMAC 決定收不收；非 E2EE 維持原判定（大小就是唯一的完整性依據）。
      if (!this.e2ee && expectedTotal !== null && objectTotal !== null && objectTotal !== expectedTotal) {
        await cancelBody()
        await removePart(this.target.partPath)
        return { kind: 'outcome', outcome: failed('undecryptable', 'SIZE_MISMATCH'), noResume }
      }

      // crypto state at `offset`
      const keys = this.keys
      let hmac: ReturnType<typeof createHmac> | null = null
      let decipher: ReturnType<typeof createDecipheriv> | null = null
      if (this.e2ee && keys) {
        hmac = createHmac('sha256', keys.macKey)
        if (offset > 0) await this.rehash(hmac, offset)
        decipher = createDecipheriv('aes-256-ctr', keys.encKey, ctrIvAt(keys.nonce, offset))
      }

      // part: from the beginning it is created only once the content passed the sniff; resuming truncates it to `offset`
      let written = offset
      let sniffed: { ok: true; mime: string } | null = null
      let sniffBuf: Buffer[] = []
      let sniffLen = 0
      if (offset > 0) {
        handle = await open(this.target.partPath, 'r+')
        await handle.truncate(offset)
        const head = Buffer.alloc(Math.min(SNIFF_BYTES, offset))
        await handle.read(head, 0, head.length, 0)
        if (head.length >= SNIFF_BYTES) {
          const s = sniffPlaintext(this.locator.kind, head)
          if (!s.ok) { await cancelBody(); return { kind: 'outcome', outcome: failed(s.code === 'CONTENT_NOT_PLAINTEXT' ? 'undecryptable' : 'unsupported', s.code) } }
          sniffed = s
        } else { sniffBuf = [head]; sniffLen = head.length }
      } else {
        // from the beginning (no Range sent, or the server ignored it with a 200): whatever part there was is replaced
        await removePart(this.target.partPath)
      }
      let batch: Buffer[] = []
      let batchLen = 0
      let nextDiskCheck = written + this.diskEvery
      const flush = async () => {
        if (!batchLen) return
        if (!handle) handle = await open(this.target.partPath, 'wx', 0o600)
        const data = batch.length === 1 ? batch[0] : Buffer.concat(batch, batchLen)
        batch = []
        batchLen = 0
        let pos = 0
        while (pos < data.length) { const { bytesWritten } = await handle.write(data, pos, data.length - pos, written); pos += bytesWritten; written += bytesWritten }
      }
      const pushPlain = async (plain: Buffer): Promise<Attempt | null> => {
        if (!plain.length) return null
        if (!sniffed) {
          sniffBuf.push(plain)
          sniffLen += plain.length
          if (sniffLen < SNIFF_BYTES) return null
          const head = Buffer.concat(sniffBuf, sniffLen)
          const s = sniffPlaintext(this.locator.kind, head.subarray(0, SNIFF_BYTES))
          if (!s.ok) return { kind: 'outcome', outcome: failed(s.code === 'CONTENT_NOT_PLAINTEXT' ? 'undecryptable' : 'unsupported', s.code) }
          sniffed = s
          sniffBuf = []
          sniffLen = 0
          // when resuming below 64 KiB the head started with the part's own bytes [0, offset): only what is new goes in
          plain = head.subarray(offset)
        }
        batch.push(plain)
        batchLen += plain.length
        if (batchLen >= WRITE_BATCH_BYTES) await flush()
        if (written >= nextDiskCheck) {
          nextDiskCheck = written + this.diskEvery
          if (!(await this.diskOk(written))) return { kind: 'outcome', outcome: paused('disk_low', 'DISK_LOW') }
        }
        return null
      }

      if (!response.body) return { kind: 'outcome', outcome: failed('transient', 'OBS_EMPTY_BODY'), noResume }
      reader = response.body.getReader()
      let hold = Buffer.alloc(0)
      let receivedEnd = offset
      const idleMs = this.opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS
      for (;;) {
        timer = arm(idleMs)
        let chunk: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>
        try { chunk = await reader.read() } catch (error) {
          clear()
          await flush().catch(() => {})
          const s = stopped()
          if (s) return s.kind === 'outcome' && s.outcome.code === 'OBS_TIMEOUT' ? { ...s, noResume } : s
          const c = classifyObsOutcome({ error, timedOut })
          return { kind: 'outcome', outcome: failed(c.class, c.code), noResume }
        }
        clear()
        // a read ended by stop() (abort / timeout cancelled the reader) is not the end of the object
        const halted = stopped()
        if (halted) { await flush().catch(() => {}); return halted.kind === 'outcome' && halted.outcome.code === 'OBS_TIMEOUT' ? { ...halted, noResume } : halted }
        if (chunk.done) break
        const value = Buffer.from(chunk.value.buffer, chunk.value.byteOffset, chunk.value.byteLength)
        receivedEnd += value.length
        let plain: Buffer
        if (hmac && decipher) {
          const joined = hold.length ? Buffer.concat([hold, value]) : value
          if (joined.length <= HMAC_BYTES) { hold = Buffer.from(joined); continue }
          const cipherPart = joined.subarray(0, joined.length - HMAC_BYTES)
          hold = Buffer.from(joined.subarray(joined.length - HMAC_BYTES))
          hmac.update(cipherPart)
          plain = decipher.update(cipherPart)
        } else plain = Buffer.from(value)
        const halt = await pushPlain(plain)
        if (halt) {
          await reader.cancel().catch(() => {})
          if (halt.kind === 'outcome' && halt.outcome.status === 'paused') await flush().catch(() => {})
          return halt
        }
        if (signal.aborted) { await flush().catch(() => {}); return { kind: 'outcome', outcome: ABORTED() } }
      }

      // end of stream. E2EE: every byte has been fed to the HMAC, so the sign is checked once, here; the truncation check uses it.
      const signOk = hmac ? hold.length === HMAC_BYTES && timingSafeEqual(hmac.digest(), hold) : null
      // A connection that ended cleanly but early is a truncation — transient OBS_TRUNCATED, resumed from the part — never a permanent
      // HMAC_MISMATCH / SIZE_MISMATCH / CONTENT_NOT_PLAINTEXT. Decided before the HMAC verdict and the size check:
      //   - the server gave the length (content-length / content-range) and less arrived;
      //   - L-1: no length from the server, the declared size is known, and less than it arrived. Exception (L-2): an E2EE stream whose
      //     sign verifies is complete — the declared size was wrong.
      const truncated = (objectTotal !== null && receivedEnd !== objectTotal)
        || (objectTotal === null && expectedTotal !== null && receivedEnd < expectedTotal && signOk !== true)
      if (!sniffed) {
        const head = Buffer.concat(sniffBuf, sniffLen)
        const s = sniffPlaintext(this.locator.kind, head)
        if (!s.ok) {
          // a prefix shorter than the sniff window says nothing about the object: keep what the part has and resume
          if (truncated) return { kind: 'outcome', outcome: failed('transient', 'OBS_TRUNCATED'), noResume }
          if (offset > 0) await removePart(this.target.partPath)
          return { kind: 'outcome', outcome: failed(s.code === 'CONTENT_NOT_PLAINTEXT' ? 'undecryptable' : 'unsupported', s.code) }
        }
        sniffed = s
        const fresh = head.subarray(offset)
        if (fresh.length) { batch.push(fresh); batchLen += fresh.length }
      }
      await flush()
      // what is in the part is a valid prefix, so the next attempt resumes from it
      if (truncated) return { kind: 'outcome', outcome: failed('transient', 'OBS_TRUNCATED'), noResume }
      if (signOk === false) return { kind: 'hmac' }
      const plainTotal = written
      // L-2: E2EE trusts the HMAC: a verified object whose size differs from the declaration is kept; the difference is only logged.
      if (hmac && declared !== null && plainTotal !== declared) this.note(`stream_note kind=${this.locator.kind} transport=e2ee code=SIZE_DECLARED_MISMATCH bytes=${plainTotal}`)
      else if (declared !== null && plainTotal !== declared) { await removePart(this.target.partPath); return { kind: 'outcome', outcome: failed('undecryptable', 'SIZE_MISMATCH') } }
      if (!handle) handle = await open(this.target.partPath, 'wx', 0o600)
      await handle.sync()
      await handle.close()
      handle = null
      let mime = (sniffed as { mime: string }).mime
      if (this.locator.kind === 'IMAGE' && plainTotal <= IMAGE_FULL_CHECK_MAX_BYTES) {
        const full = detectSupportedImageMime(await readFile(this.target.partPath))
        if (!full) { await removePart(this.target.partPath); return { kind: 'outcome', outcome: failed('unsupported', 'IMAGE_TYPE_UNSUPPORTED') } }
        mime = full
      }
      try { await this.target.commit(this.target.partPath, { mime, bytes: plainTotal }) } catch (error) {
        // F-2b: a deterministic refusal is terminal (run() drops the part, no re-download); only I/O is retried, from the part the sink kept
        const e = error as { class?: unknown; code?: unknown } | null
        if (e?.class === 'unsupported') return { kind: 'outcome', outcome: failed('unsupported', typeof e.code === 'string' && e.code ? e.code.slice(0, 64) : 'SINK_REJECTED') }
        if (e?.code === 'ENOSPC') return { kind: 'outcome', outcome: paused('disk_low', 'DISK_LOW') }
        return { kind: 'outcome', outcome: failed('transient', 'SINK_COMMIT_FAILED') }
      }
      return { kind: 'done', bytes: plainTotal, mime }
    } catch (error) {
      if (signal.aborted) return { kind: 'outcome', outcome: ABORTED() }
      const code = (error as { code?: unknown })?.code
      if (code === 'ENOSPC') return { kind: 'outcome', outcome: paused('disk_low', 'DISK_LOW') }
      return { kind: 'outcome', outcome: failed('transient', 'PART_IO') }
    } finally {
      clear()
      signal.removeEventListener('abort', onAbort)
      // never leave a response body open (a finished one ignores the cancel)
      if (reader) { await (reader as ReadableStreamDefaultReader<Uint8Array>).cancel().catch(() => {}); try { (reader as ReadableStreamDefaultReader<Uint8Array>).releaseLock() } catch { /* already released */ } }
      else await (held as Response | null)?.body?.cancel().catch(() => {})
      if (handle) await (handle as FileHandle).close().catch(() => {})
    }
  }
}
