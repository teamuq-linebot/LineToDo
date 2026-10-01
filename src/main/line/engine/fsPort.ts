/**
 * fsPort.ts — LINE 引擎的檔案系統／行程 port（介面 + 共用純邏輯，零 I/O）。
 *
 * `linedb` / `linekey` / `watchEngine` / `media/decrypt` 不直接 import `node:fs`、
 * `node:child_process`，一律經由 `LineFsPort`。實作：
 *   - standalone：`NodeLineFsPort`（`nodeLineFsPort.ts`，現行 node:fs + tasklist，行為不變）。
 *   - plugin（Phase 1）：koffi 包 Win32 讀 `%LOCALAPPDATA%\LINE\...`，工作區落在 dataDir。
 *
 * 方法分三組，各自對應宿主權限邊界：
 *   1. LINE 來源讀取（LINE 目錄，外掛內須走 native）：readDir / stat / exists / readFile / copyFile。
 *   2. 引擎工作區與狀態檔（宿主可寫目錄；snapshot 暫存、`.linekey`、checkpoint）：
 *      makeTempDir / removeDir / ensureDir / readTextFile / writeTextFile / renameFile。
 *   3. 行程：listProcessIds（取代 `execFileSync('tasklist')`）。
 *
 * 錯誤語意比照 node:fs：讀不到就 throw，由呼叫端決定吞或拋（呼叫端原本的 try/catch 不變）。
 */
import { join } from 'node:path'

/** 目錄項目（等同 `readdirSync(dir, { withFileTypes: true })` 的 Dirent 判斷；symlink 兩者皆 false）。 */
export interface LineDirEntry {
  name: string
  isFile: boolean
  isDirectory: boolean
}

/** 檔案大小與奈秒 mtime（`statSync(p, { bigint: true })` 的 size/mtimeNs）。 */
export interface LineFileStat {
  size: number
  mtimeNs: bigint
}

export interface LineFsPort {
  // ── 1. LINE 來源讀取 ──
  /** 列出目錄項目；目錄不存在或無權限時 throw。 */
  readDir(dir: string): LineDirEntry[]
  /** 取檔案大小與 mtime；不存在時 throw。 */
  stat(path: string): LineFileStat
  exists(path: string): boolean
  readFile(path: string): Buffer
  /** 複製單檔（來源通常在 LINE 目錄，目的在引擎工作區）。 */
  copyFile(src: string, dst: string): void

  // ── 2. 引擎工作區與狀態檔 ──
  /** 在實作決定的暫存根目錄下建立唯一子目錄（standalone＝os.tmpdir()；plugin＝dataDir 底下）。 */
  makeTempDir(prefix: string): string
  /** 遞迴刪除目錄（不存在不報錯）。 */
  removeDir(dir: string): void
  ensureDir(dir: string): void
  readTextFile(path: string): string
  writeTextFile(path: string, data: string): void
  renameFile(from: string, to: string): void

  // ── 3. 行程 ──
  /** 指定映像名（如 `LINE.exe`）的所有 PID，依系統列舉順序；查不到或列舉失敗回空陣列。 */
  listProcessIds(imageName: string): number[]
}

/**
 * findDbPath — 主訊息 DB = `dbDir` 下最大那顆 `qw<hex>.edb`（檔名不含 '_'）。
 * 逐字搬自 linedb.ts `findDb()`（對齊 linekey.py:27-33 `find_db`）；目錄讀不到回 null。
 */
export function findDbPath(fs: LineFsPort, dbDir: string): string | null {
  let entries: string[]
  try {
    entries = fs.readDir(dbDir).map((entry) => entry.name)
  } catch {
    return null
  }
  const cands = entries
    .filter((f) => f.startsWith('qw') && f.endsWith('.edb') && !f.includes('_'))
    .map((f) => join(dbDir, f))
  if (cands.length === 0) return null
  let best = cands[0]
  let bestSize = -1
  for (const p of cands) {
    let size = -1
    try {
      size = fs.stat(p).size
    } catch {
      size = -1
    }
    if (size > bestSize) {
      bestSize = size
      best = p
    }
  }
  return best
}

/** snapshot 複製的副檔名順序（edb → -wal → -shm），對齊 linedb.py open_db 的迴圈。 */
export const SNAPSHOT_EXTS = ['', '-wal', '-shm'] as const

/**
 * copySnapshot — 把 `src` 的 edb/-wal/-shm（存在者）複製到 `dstDir/<name>`，回目的 edb 路徑。
 * 逐字搬自 linedb.ts `openDb()` 的複製迴圈；任一檔複製失敗即 throw（與原行為相同）。
 */
export function copySnapshot(fs: LineFsPort, src: string, dstDir: string, name = 'm.edb'): string {
  const dst = join(dstDir, name)
  for (const ext of SNAPSHOT_EXTS) {
    if (fs.exists(src + ext)) {
      fs.copyFile(src + ext, dst + ext)
    }
  }
  return dst
}
