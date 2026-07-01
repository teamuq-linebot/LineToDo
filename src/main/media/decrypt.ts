import { hkdfSync, createHmac, createDecipheriv, timingSafeEqual } from 'node:crypto'
import { readdirSync, statSync, readFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

/**
 * decrypt.ts — 本機離線解密 LINE E2EE 媒體（`.eimg`）核心（純函式，零新依賴）。
 *
 * 逐字對齊 PoC 配方（output/sw/line-media-recall-investigate-20260701/eimg_decrypt_poc.md，
 * 源自 evex-dev/linejs `base/e2ee/mod.ts`），已實測 byte-for-byte PASS：
 *
 *   HKDF-SHA256(ikm=keyMaterial(32B), salt=32×0x00, info="FileEncryption", L=76)
 *     → encKey = derived[0:32]（AES-256 金鑰）
 *       macKey = derived[32:64]（HMAC-SHA256 金鑰）
 *       nonce  = derived[64:76] ++ 0x00000000（12B + 4B 零 = 16B CTR 初始 counter/IV）
 *   .eimg 佈局：[ ciphertext : fileSize bytes ][ sign : 32 bytes ]
 *   完整性：HMAC-SHA256(macKey, ciphertext) 以 timingSafeEqual 比對 sign
 *   解密：AES-256-CTR(encKey, nonce).decrypt(ciphertext) → 明文長度 == fileSize
 *
 * 定位（決策 2 / §4.8）：掃 `%LOCALAPPDATA%\LINE\Cache` 下所有 `*.eimg`，取
 *   statSync().size == fileSize + 32 的候選（通常 0–2 個），逐一算 HMAC，
 *   命中尾 32B 者即正解（確定性裁決，不依賴 chatHash/OID 推導）。
 *
 * 隱私（§7）：本函式全程只在記憶體處理明文；不寫任何持久檔、
 *   絕不 log keyMaterial / 明文 / 完整 ciphertext（log 由呼叫端以 msgId + 原因為之）。
 */

/** 解密輸入。皆為「只 Python 讀得到、且不隨時間變」的 DB 穩定欄位。 */
export interface DecryptMediaInput {
  /** `_message._contentInfo.keyMaterial`，base64（解碼後 32 bytes IKM）。 */
  keyMaterial: string
  /** 明文位元組數（`_contentMetadata.FILE_SIZE`）；`.eimg == fileSize + 32`。 */
  fileSize: number
  /** 選配：覆寫快取根目錄（測試用；預設 `%LOCALAPPDATA%\LINE\Cache`）。 */
  cacheDir?: string
}

/**
 * 解密結果狀態：
 * - `ok`         命中並成功解出明文（附 bytes/mime）
 * - `not-cached` 掃不到 size==fileSize+32 的候選（未快取，屬預期，非錯誤）
 * - `hmac-miss`  有候選但 HMAC 全部驗不過（金鑰/檔不匹配）
 * - `error`      解密/讀檔擲例外
 */
export type DecryptMediaStatus = 'ok' | 'not-cached' | 'hmac-miss' | 'error'

/** 解密結果。明文只在 `status==='ok'` 時附於 `bytes`（僅記憶體，呼叫端負責生命週期）。 */
export interface DecryptMediaResult {
  status: DecryptMediaStatus
  bytes?: Buffer
  mime?: string
}

const HMAC_LEN = 32
const HKDF_INFO = Buffer.from('FileEncryption')
const HKDF_SALT = Buffer.alloc(32, 0)
const HKDF_LEN = 76

/** 預設快取根：`%LOCALAPPDATA%\LINE\Cache`（用 process.env.LOCALAPPDATA）。 */
function defaultCacheDir(): string {
  return join(process.env.LOCALAPPDATA ?? '', 'LINE', 'Cache')
}

/**
 * 由明文前幾 bytes 判 MIME（magic number）。
 * 非圖片一律 application/octet-stream；檔案類之後由呼叫端用副檔名補。
 */
function detectMime(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif'
  }
  // webp：RIFF（52 49 46 46）起頭，且 offset 8 起為 WEBP（57 45 42 50）
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return 'application/octet-stream'
}

/**
 * 記憶化快取索引：size(bytes) → 該 size 的 `.eimg` 絕對路徑陣列。
 *
 * 策略（M2 效能）：module 級單一索引 + `indexedDir` 記錄「目前索引是為哪個 cacheDir 建的」。
 *   - **lazy build**：首次用到、或換了 cacheDir（未來多帳號 / 測試）才 walk 全 Cache 一次；
 *     之後同一 dir 的每次呼叫直接查 map，免重掃 ~37k 檔（原本每張 <img> 各全掃一次 → 阻塞 main）。
 *   - **失效 / 新檔**：查無候選且索引非本次剛建時，做「一次性 rebuild 後重試」（以 `freshlyBuilt`
 *     旗標確保單次呼叫至多重建一次、不進無限重建），以吸收「索引建立後才新增的 `.eimg`」。
 *   - `resetMediaCacheIndex()` 供測試 / 未來 fs 事件失效時強制下次重建。
 */
let cacheIndex: Map<number, string[]> | null = null
let indexedDir: string | null = null

/**
 * 遞迴 walk `dir`，把所有 `.eimg` 依 `statSync().size` 收進 `index`。
 * 目錄不存在/無權限、單檔 stat 失敗皆跳過（不中斷整體掃描）；不追蹤 symlink（避免循環）。
 */
function walkEimg(dir: string, index: Map<number, string[]>): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkEimg(full, index)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.eimg')) {
      try {
        const size = statSync(full).size
        const arr = index.get(size)
        if (arr) arr.push(full)
        else index.set(size, [full])
      } catch {
        // 單檔 stat 失敗 → 跳過此檔
      }
    }
  }
}

/** 為 `dir` 全掃一次並替換記憶化索引。 */
function buildCacheIndex(dir: string): void {
  const index = new Map<number, string[]>()
  walkEimg(dir, index)
  cacheIndex = index
  indexedDir = dir
}

/** 清空記憶化索引；下次 `decryptCachedMedia` 會 lazy 重建（測試 / 未來 fs 事件失效用）。 */
export function resetMediaCacheIndex(): void {
  cacheIndex = null
  indexedDir = null
}

/**
 * 本機離線解密一則已快取的 E2EE 媒體。
 *
 * 不連網、不接觸 LINE server、不用 authToken；只用本機 keyMaterial + 本機快取 `.eimg`。
 * 失敗一律回結構化狀態（不 throw、不 log 敏感值），由呼叫端決定 fallback/log。
 */
export function decryptCachedMedia(input: DecryptMediaInput): DecryptMediaResult {
  try {
    const ikm = Buffer.from(input.keyMaterial, 'base64')

    // 金鑰派生（HKDF-SHA256）
    const derived = Buffer.from(hkdfSync('sha256', ikm, HKDF_SALT, HKDF_INFO, HKDF_LEN))
    const encKey = derived.subarray(0, 32)
    const macKey = derived.subarray(32, 64)
    const nonce = Buffer.concat([derived.subarray(64, 76), Buffer.alloc(4, 0)]) // 16B CTR IV

    // 定位：size == fileSize + 32 的候選（查記憶化索引；查無則一次性 rebuild 重試新檔）
    const targetSize = input.fileSize + HMAC_LEN
    const dir = input.cacheDir ?? defaultCacheDir()

    // 首次用到、或換了 cacheDir → lazy 建索引一次（freshlyBuilt＝本次呼叫「已建/已重試」旗標）
    let freshlyBuilt = false
    if (cacheIndex === null || indexedDir !== dir) {
      buildCacheIndex(dir)
      freshlyBuilt = true
    }
    let candidates = cacheIndex!.get(targetSize) ?? []
    // 查無候選且索引非本次剛建 → 可能是建索引後才新增的 .eimg，重建一次再查（至多一次）
    if (candidates.length === 0 && !freshlyBuilt) {
      buildCacheIndex(dir)
      candidates = cacheIndex!.get(targetSize) ?? []
    }
    if (candidates.length === 0) return { status: 'not-cached' }

    // 逐一以 HMAC 確定性裁決；命中者即正解
    for (const file of candidates) {
      let data: Buffer
      try {
        data = readFileSync(file)
      } catch {
        continue
      }
      if (data.length !== targetSize) continue

      const ciphertext = data.subarray(0, data.length - HMAC_LEN)
      const sign = data.subarray(data.length - HMAC_LEN)
      const calc = createHmac('sha256', macKey).update(ciphertext).digest()
      if (calc.length !== sign.length || !timingSafeEqual(calc, sign)) continue

      // 解密（AES-256-CTR，串流）：明文長度 == ciphertext 長度 == fileSize
      const decipher = createDecipheriv('aes-256-ctr', encKey, nonce)
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      return { status: 'ok', bytes: plaintext, mime: detectMime(plaintext) }
    }

    // 有候選但 HMAC 全部驗不過
    return { status: 'hmac-miss' }
  } catch {
    return { status: 'error' }
  }
}
