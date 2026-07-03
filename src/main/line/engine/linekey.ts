/**
 * linekey.ts — 純 TS 取得 LINE-for-Windows DB 32-hex passphrase（Batch 2）。
 *
 * 逐一對照外部 Python 引擎 `line-cua-win/src/linekey.py`，行為求 parity。
 * LINE Desktop（Windows, Qt6）把歷史訊息 DB 以 wxSQLite3 /
 * QtCipherSqlitePlugin AES-128-CBC 加密，32-hex passphrase 僅存在執行中的
 * LINE.exe 程序記憶體（登入時由伺服器下發）。我們掃描程序記憶體找 32-hex
 * 候選，以「成功解密」確認——offset-independent，故 LINE 更新後仍可運作
 * （只要 LINE 在跑）。
 *
 * 金鑰解析順序（getKey，對齊 linekey.py:171-182 `get_key`）：
 *   1. $LINE_DB_KEY                          🟢 純 TS
 *   2. cache 檔（<userData>/.linekey）試解驗證  🟢 純 TS
 *   3. live recover（掃 LINE.exe 記憶體）      koffi FFI（native/procmem.ts）
 *
 * ★ 唯讀鐵律 ★：recover 只 ReadProcessMemory，嚴禁任何寫入 / 注入。
 * ★ 秘密不落 repo ★：cache 檔預設寫 userData（app.getPath('userData')），
 *   絕不寫入 repo 追蹤區、絕不進 git。
 *
 * 本檔為 Batch 2 新增，不改動任何現有執行路徑
 * （watcher/pipeline/lineBridge/types）。test-decrypt 驗證 import Batch 1 的
 * `openDb`，保持與 linedb.ts 一致。
 */
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3'

import { CIPHER, findDb, KDF_ITER, openDb } from './linedb'
import { scanRegions } from '../native/procmem'

/**
 * 快取檔預設路徑：<userData>/.linekey。
 *
 * py 放在 line-cua-win repo 根（不適合本 App）。改放 Electron 的 userData。
 * app.getPath 只在 Electron 主程序可用；於純 Node 測試環境（無 Electron）
 * 惰性 require 會失敗，此時 fallback 到環境變數推導的路徑，並允許呼叫端注入
 * 覆寫（見 getKey 的 opts.cacheFile）。
 */
function defaultCacheFile(): string {
  try {
    // 惰性載入：純 Node 測試不需 Electron。
    const electron = require('electron') as { app?: { getPath?: (n: string) => string } }
    const userData = electron?.app?.getPath?.('userData')
    if (userData) return join(userData, '.linekey')
  } catch {
    // 非 Electron 環境 —— 落到下方 fallback。
  }
  const base =
    process.env.LINE_TODO_USERDATA?.trim() ||
    (process.env.APPDATA ? join(process.env.APPDATA, 'line-todo') : process.cwd())
  return join(base, '.linekey')
}

/** getKey 選項（皆可注入，方便測試冷啟/自訂快取路徑）。 */
export interface GetKeyOptions {
  /** LINE DB 路徑；省略則 findDb()。 */
  dbPath?: string | null
  /** 快取檔路徑；省略則 <userData>/.linekey。 */
  cacheFile?: string
  /** 略過 env 段（測試 cache/recover 用）。 */
  skipEnv?: boolean
  /** 略過 cache 段（測試 cold recover 用）。 */
  skipCache?: boolean
  /** recover 命中後是否寫快取（預設 true）。 */
  cache?: boolean
}

/**
 * findPid(name) — 取指定執行檔的 PID。
 *
 * 對齊 linekey.py:36-47（`find_pid`）：用 `tasklist` CSV 輸出解析。Node 端
 * `tasklist` 穩定、無需額外 FFI（find_pid 不在 koffi 掃描熱路徑上）。回第一個
 * 命中的 PID，找不到回 null。
 */
export function findPid(name = 'LINE.exe'): number | null {
  let out: string
  try {
    out = execFileSync(
      'tasklist',
      ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true },
    )
  } catch {
    return null
  }
  const target = name.toLowerCase()
  for (const line of out.split(/\r?\n/)) {
    // CSV 格式："LINE.exe","12345","Console",...；用 py 同款 '","' 切法。
    const parts = line.split('","').map((p) => p.replace(/^"|"$/g, ''))
    if (parts.length >= 2 && parts[0].toLowerCase() === target) {
      const pid = parseInt(parts[1].trim(), 10)
      if (Number.isFinite(pid)) return pid
    }
  }
  return null
}

/** ASCII 32-hex（前後不得再接 hex，對齊 linekey.py:85 `_ASCII_RE`）。 */
const ASCII_RE = /(?<![0-9a-fA-F])[0-9a-fA-F]{32}(?![0-9a-fA-F])/g

/**
 * extractCandidates(bytes, seen, out) — 從一段記憶體 bytes 抽 32-hex 候選，
 * 去重後追加到 out。對齊 linekey.py:118-121 的雙編碼掃描：
 *   - ASCII：latin1 解碼後正則掃 [0-9a-fA-F]{32}。
 *   - UTF-16LE：每隔一 byte 取一（偶數 offset），若第奇數 byte 全 0（\x00）
 *     則視為 UTF-16LE 的 hex；等效 py 的 `(?:[0-9a-fA-F]\x00){32}`。
 */
function extractCandidates(bytes: Buffer, seen: Set<string>, out: string[]): void {
  // ASCII
  const asciiStr = bytes.toString('latin1')
  for (const m of asciiStr.matchAll(ASCII_RE)) {
    const key = m[0]
    if (!seen.has(key)) {
      seen.add(key)
      out.push(key)
    }
  }
  // UTF-16LE：取偶數 offset 的 byte，奇數 offset 須為 0。
  // 逐位掃：每個 UTF-16LE hex char = [hexByte, 0x00]。
  const isHex = (c: number): boolean =>
    (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)
  for (let i = 0; i + 63 < bytes.length; i++) {
    let ok = true
    for (let j = 0; j < 32; j++) {
      const lo = bytes[i + j * 2]
      const hi = bytes[i + j * 2 + 1]
      if (hi !== 0 || !isHex(lo)) {
        ok = false
        break
      }
    }
    if (ok) {
      let s = ''
      for (let j = 0; j < 32; j++) s += String.fromCharCode(bytes[i + j * 2])
      if (!seen.has(s)) {
        seen.add(s)
        out.push(s)
      }
      i += 63 // 跳過此候選（不重疊掃）
    }
  }
}

/** test-decrypt（單發）：用 openDb 開 copy 驗 sqlite_master，成功即 true。 */
function decrypts(dbPath: string, key: string): boolean {
  try {
    const { cleanup } = openDb(key, dbPath)
    cleanup()
    return true
  } catch {
    return false
  }
}

/**
 * BatchVerifier — recover 專用「一次複製、多次試解」的候選驗證器。
 *
 * py 的 `_decrypts` 每個候選都把整顆 ~200MB DB 複製到 temp 再開。實測 LINE.exe
 * 記憶體含約 1.2 萬個 32-hex 候選、真 key 常落在數千名之後 → 逐一 copy 會產生
 * 數百 GB I/O、耗時以小時計。這裡改成**複製一次**（edb 即可；驗 `sqlite_master`
 * 不需 WAL 內容）為 read-only immutable 來源，之後每個候選只開一條 read-only
 * 連線試 `key` pragma + `SELECT count(*) FROM sqlite_master`——**驗證條件與
 * py/`openDb` 逐字相同**，只是省去重複 copy。命中的 key 最後仍會過一次正規
 * `openDb`（snapshot+WAL merge）做最終確認，確保與日常開檔路徑一致。
 */
class BatchVerifier {
  private tmp: string
  private copyPath: string

  constructor(dbPath: string) {
    this.tmp = mkdtempSync(join(tmpdir(), 'linekey-scan-'))
    this.copyPath = join(this.tmp, 'm.edb')
    // 只複製主 edb（驗 sqlite_master 不需 -wal/-shm）。以 readonly 開私有 copy，
    // 不會動到來源、也不需 WAL merge。（不走 file: URI immutable —— 該形式在
    // better-sqlite3(-multiple-ciphers) 下解析為「目錄不存在」，見 spike 診斷。）
    copyFileSync(dbPath, this.copyPath)
  }

  /** 試一把 key：能 SELECT count(*) FROM sqlite_master 即 true。 */
  test(key: string): boolean {
    let con: Db | null = null
    try {
      // 開私有 copy（readonly，避免對共用 copy 寫 sidecar；spike 已驗
      // 好/壞 key 交錯開關不互相污染）。
      con = new Database(this.copyPath, {
        readonly: true,
        fileMustExist: true,
      }) as unknown as Db
      con.pragma(`cipher='${CIPHER}'`)
      con.pragma(`kdf_iter=${KDF_ITER}`)
      con.pragma(`key='${key}'`)
      con.prepare('SELECT count(*) FROM sqlite_master').get()
      return true
    } catch {
      return false
    } finally {
      if (con) {
        try {
          con.close()
        } catch {
          // ignore
        }
      }
    }
  }

  dispose(): void {
    try {
      rmSync(this.tmp, { recursive: true, force: true })
    } catch {
      // 非致命
    }
  }
}

/**
 * recoverKey(opts) — 掃 LINE.exe 記憶體找可解 DB 的 32-hex，命中即回並快取。
 *
 * 對齊 linekey.py:151-168（`recover_key`）：findDb → findPid → scanRegions
 * 逐 chunk 抽候選 → 逐一 test-decrypt → 命中即中止掃描、寫快取、回傳。
 * 找不到回 null。
 *
 * 效能：候選驗證走 BatchVerifier（複製一次、逐一試解），避免 py 逐候選 copy
 * 200MB 的數百 GB I/O。邊掃邊試：每個 chunk 抽出的新候選立即試解，命中即回
 * false 令 scanRegions 提早中止（省去累積全部候選）。命中後再過一次正規
 * openDb 做最終確認。
 */
export function recoverKey(opts: GetKeyOptions = {}): string | null {
  const dbPath = opts.dbPath ?? findDb()
  if (!dbPath) return null
  const pid = findPid('LINE.exe')
  if (!pid) return null

  const seen = new Set<string>()
  let hit: string | null = null
  const verifier = new BatchVerifier(dbPath)
  try {
    scanRegions(pid, (chunk) => {
      const fresh: string[] = []
      extractCandidates(chunk, seen, fresh)
      for (const key of fresh) {
        if (verifier.test(key)) {
          hit = key
          return false // 中止掃描
        }
      }
      return true
    })
  } finally {
    verifier.dispose()
  }

  // 最終確認：命中的 key 過一次正規 openDb（snapshot + WAL merge），確保與
  // 日常開檔路徑一致；理論上必過（BatchVerifier 已驗），失敗即視為未命中。
  if (hit && !decrypts(dbPath, hit)) hit = null

  if (hit && opts.cache !== false) {
    try {
      writeFileSync(opts.cacheFile ?? defaultCacheFile(), hit, { encoding: 'utf8' })
    } catch {
      // 快取寫入失敗非致命（對齊 py try/except OSError: pass）。
    }
  }
  return hit
}

/**
 * getKey(opts) — 解析 DB passphrase：env → cache → live recover。
 *
 * 對齊 linekey.py:171-182（`get_key`）：
 *   1. $LINE_DB_KEY（strip）直接用。
 *   2. cache 檔存在 → 讀出試解；LINE re-login 會 rotate key，故快取須經
 *      test-decrypt 驗證通過才採用，否則往下 recover。
 *   3. recoverKey()。
 *
 * 回傳 32-hex 或 null（三段皆 miss）。
 */
export function getKey(opts: GetKeyOptions = {}): string | null {
  const dbPath = opts.dbPath ?? findDb()

  // 1. env
  if (!opts.skipEnv) {
    const env = process.env.LINE_DB_KEY
    if (env && env.trim()) return env.trim()
  }

  // 2. cache（須 test-decrypt 驗證，rotate 後不採用舊 key）
  if (!opts.skipCache) {
    const cacheFile = opts.cacheFile ?? defaultCacheFile()
    if (existsSync(cacheFile)) {
      let cached = ''
      try {
        cached = readFileSync(cacheFile, 'utf8').trim()
      } catch {
        cached = ''
      }
      if (cached && dbPath && decrypts(dbPath, cached)) return cached
    }
  }

  // 3. live recover
  return recoverKey({ ...opts, dbPath })
}
