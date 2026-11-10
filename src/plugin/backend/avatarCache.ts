import { createHash } from 'node:crypto'
import { promises as fsPromises } from 'node:fs'
import { join } from 'node:path'

export const AVATAR_CACHE_DIR = 'avatar-cache'
const ORIGIN = 'https://profile.line-scdn.net'
const SQUARE_ORIGIN = 'https://obs.line-scdn.net'
const MAX_FAILURE_ENTRIES = 512
const MIME_EXT = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const)
type AvatarMime = keyof typeof MIME_EXT

export interface AvatarCacheFs {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
  readFile(path: string): Promise<Uint8Array>
  readdir(path: string): Promise<string[]>
  rename(from: string, to: string): Promise<void>
  stat(path: string): Promise<{ size: number; mtimeMs: number; isFile(): boolean }>
  unlink(path: string): Promise<void>
  writeFile(path: string, data: Uint8Array, options: { flag: 'wx' }): Promise<void>
}

export interface AvatarFetchResponse {
  status: number
  ok: boolean
  url?: string
  headers: { get(name: string): string | null }
  body: null | { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel?(): Promise<void> } }
  arrayBuffer?(): Promise<ArrayBuffer>
}

export interface AvatarCacheOptions {
  dataDir: string
  fetchImpl?: (url: string, init: { method: 'GET'; redirect: 'manual'; signal: AbortSignal }) => Promise<AvatarFetchResponse>
  fs?: AvatarCacheFs
  maxImageBytes?: number
  maxConcurrent?: number
  failureBackoffMs?: number
  timeoutMs?: number
  now?(): number
}

export interface AvatarCacheResult { path: string; mime: AvatarMime; size: number; cached: boolean }
export interface AvatarCache { get(input: { identity: string; locator: string | null | undefined }): Promise<AvatarCacheResult | null> }

export function avatarCacheKey(identity: string, locator: string): string {
  return createHash('sha256').update(identity, 'utf8').update('\0').update(locator, 'utf8').digest('hex')
}

function safeImageUrl(locator: string): string | null {
  if (!locator || locator.length > 2048 || /[\u0000-\u0020\\]/u.test(locator)) return null
  const rawPath = locator.startsWith('/')
    ? locator.split(/[?#]/u, 1)[0]
    : locator.replace(/^https:\/\/[^/]+/iu, '').split(/[?#]/u, 1)[0] || '/'
  if (!rawPath || /%2f|%5c/i.test(rawPath)) return null
  try {
    const rawDecoded = decodeURIComponent(rawPath)
    if (rawDecoded.includes('\\') || rawDecoded.split('/').some((part) => part === '.' || part === '..')) return null
  } catch { return null }
  let url: URL
  try {
    if (locator.startsWith('/')) {
      if (locator.startsWith('//')) return null
      url = new URL(locator, locator.startsWith('/0h') ? SQUARE_ORIGIN : ORIGIN)
    } else {
      url = new URL(locator)
    }
  } catch { return null }
  const squareOrigin = url.origin === SQUARE_ORIGIN
  if (url.protocol !== 'https:' || (url.origin !== ORIGIN && !squareOrigin) || url.username || url.password || url.port || url.hash) return null
  if (squareOrigin && (!/^\/0h[A-Za-z0-9_-]+$/u.test(url.pathname) || url.search)) return null
  if (/%2f|%5c/i.test(url.pathname) || url.pathname.split('/').some((part) => part === '.' || part === '..')) return null
  try {
    const decoded = decodeURIComponent(url.pathname)
    if (decoded.includes('\\') || decoded.split('/').some((part) => part === '.' || part === '..')) return null
  } catch { return null }
  return url.toString()
}

function identifyImage(bytes: Uint8Array, mimeHeader: string | null): AvatarMime | null {
  const mime = (mimeHeader ?? '').split(';', 1)[0].trim().toLowerCase() as AvatarMime
  if (!(mime in MIME_EXT)) return null
  const jpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
  const png = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  const webp = bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  if ((mime === 'image/jpeg' && jpeg) || (mime === 'image/png' && png) || (mime === 'image/webp' && webp)) return mime
  return null
}

async function readBounded(response: AvatarFetchResponse, limit: number): Promise<Uint8Array | null> {
  if (!response.body) {
    if (!response.arrayBuffer) return null
    const bytes = new Uint8Array(await response.arrayBuffer())
    return bytes.length <= limit ? bytes : null
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      const chunk = part.value ?? new Uint8Array()
      total += chunk.byteLength
      if (total > limit) {
        await reader.cancel?.().catch(() => undefined)
        return null
      }
      chunks.push(chunk)
    }
  } catch { return null }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

export function createAvatarCache(options: AvatarCacheOptions): AvatarCache {
  const fs = options.fs ?? fsPromises
  const dir = join(options.dataDir, AVATAR_CACHE_DIR)
  const maxImageBytes = options.maxImageBytes ?? 2 * 1024 * 1024
  const maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? 4))
  const backoffMs = options.failureBackoffMs ?? 60_000
  const timeoutMs = options.timeoutMs ?? 10_000
  const now = options.now ?? Date.now
  const flights = new Map<string, Promise<AvatarCacheResult | null>>()
  const failures = new Map<string, number>()
  const rememberFailure = (key: string): void => {
    failures.set(key, now() + backoffMs)
    while (failures.size > MAX_FAILURE_ENTRIES) failures.delete(failures.keys().next().value as string)
  }
  let active = 0
  const waiters: Array<() => void> = []

  const acquire = async (): Promise<() => void> => {
    if (active >= maxConcurrent) await new Promise<void>((resolve) => waiters.push(resolve))
    else active += 1
    return () => {
      const next = waiters.shift()
      if (next) next()
      else active -= 1
    }
  }
  const fileNames = async (): Promise<Array<{ name: string; size: number; mtimeMs: number }>> => {
    let names: string[]
    try { names = await fs.readdir(dir) } catch { return [] }
    const files: Array<{ name: string; size: number; mtimeMs: number }> = []
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.(?:jpg|png|webp)$/u.test(name)) continue
      try {
        const file = join(dir, name)
        const s = await fs.stat(file)
        if (!s.isFile()) continue
        const checksum = await fs.stat(`${file}.sha256`).catch(() => null)
        files.push({ name, size: s.size + (checksum?.size ?? 0), mtimeMs: s.mtimeMs })
      } catch { /* concurrently removed */ }
    }
    return files
  }
  const probe = async (key: string): Promise<string | undefined> => {
    for (const ext of Object.values(MIME_EXT)) {
      const name = `${key}.${ext}`
      try { if ((await fs.stat(join(dir, name))).isFile()) return name } catch { /* 不是這個副檔名 */ }
    }
    return undefined
  }
  const load = async (identity: string, locator: string, url: string): Promise<AvatarCacheResult | null> => {
    const release = await acquire()
    try {
      const key = avatarCacheKey(identity, locator)
      // 命中時依 key 直接 stat 三種副檔名，不掃整個目錄；找不到才退回列舉（舊檔名、手動放入的檔案）。
      const cachedName = (await probe(key)) ?? (await fileNames()).find((f) => f.name.startsWith(key + '.'))?.name
      if (cachedName) {
        const ext = cachedName.slice(key.length + 1)
        const mime = (Object.entries(MIME_EXT).find(([, e]) => e === ext)?.[0]) as AvatarMime | undefined
        const cachedPath = join(dir, cachedName)
        try {
          const data = new Uint8Array(await fs.readFile(cachedPath))
          const expectedChecksum = Buffer.from(await fs.readFile(`${cachedPath}.sha256`)).toString('utf8').trim()
          const actualChecksum = createHash('sha256').update(data).digest('hex')
          if (mime && /^[a-f0-9]{64}$/u.test(expectedChecksum) && expectedChecksum === actualChecksum && identifyImage(data, mime) && data.length <= maxImageBytes) {
            return { path: `${AVATAR_CACHE_DIR}/${cachedName}`, mime, size: data.length, cached: true }
          }
          await fs.unlink(cachedPath).catch(() => undefined)
          await fs.unlink(`${cachedPath}.sha256`).catch(() => undefined)
        } catch {
          // Missing/corrupt checksum metadata is a stale entry; remove both files so the next fetch can replace it.
          await fs.unlink(cachedPath).catch(() => undefined)
          await fs.unlink(`${cachedPath}.sha256`).catch(() => undefined)
        }
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let response: AvatarFetchResponse
      let bytes: Uint8Array | null
      try {
        response = await (options.fetchImpl ?? fetch as unknown as NonNullable<AvatarCacheOptions['fetchImpl']>)(url, { method: 'GET', redirect: 'manual', signal: controller.signal })
        if (!response.ok || response.status < 200 || response.status >= 300) { rememberFailure(key); return null }
        if (response.url) {
          const final = safeImageUrl(response.url)
          if (!final || final !== url) { rememberFailure(key); return null }
        }
        bytes = await readBounded(response, maxImageBytes)
      } catch { rememberFailure(key); return null }
      finally { clearTimeout(timer) }
      const mime = bytes && identifyImage(bytes, response.headers.get('content-type'))
      if (!bytes || !mime || bytes.length > maxImageBytes) { rememberFailure(key); return null }
      const name = `${key}.${MIME_EXT[mime]}`
      const target = join(dir, name)
      const temp = join(dir, `.${name}.${createHash('sha256').update(String(now())).digest('hex').slice(0, 8)}.tmp`)
      const checksumTarget = `${target}.sha256`
      const checksumTemp = `${temp}.sha256`
      try {
        await fs.mkdir(dir, { recursive: true })
        // A manually removed image can leave its private checksum sidecar behind; discard the orphan before rebuilding.
        await fs.unlink(checksumTarget).catch(() => undefined)
        await fs.writeFile(temp, bytes, { flag: 'wx' })
        await fs.rename(temp, target)
        const checksum = createHash('sha256').update(bytes).digest('hex')
        await fs.writeFile(checksumTemp, new TextEncoder().encode(checksum), { flag: 'wx' })
        await fs.rename(checksumTemp, checksumTarget)
      } catch {
        await fs.unlink(temp).catch(() => undefined)
        await fs.unlink(checksumTemp).catch(() => undefined)
        await fs.unlink(target).catch(() => undefined)
        await fs.unlink(checksumTarget).catch(() => undefined)
        rememberFailure(key)
        return null
      }
      failures.delete(key)
      return { path: `${AVATAR_CACHE_DIR}/${name}`, mime, size: bytes.length, cached: false }
    } finally { release() }
  }

  return {
    async get(input) {
      if (!input || typeof input.identity !== 'string' || !input.identity || input.identity.length > 512 || typeof input.locator !== 'string') return null
      const locator = input.locator
      const url = safeImageUrl(locator)
      if (!url) return null
      const key = avatarCacheKey(input.identity, locator)
      if ((failures.get(key) ?? 0) > now()) return null
      const existing = flights.get(key)
      if (existing) return existing
      const promise = load(input.identity, locator, url).finally(() => flights.delete(key))
      flights.set(key, promise)
      return promise
    }
  }
}
