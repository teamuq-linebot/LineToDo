/**
 * win32fs.ts — `LineFsPort` 的外掛實作：用 koffi 包 Win32，不經過 Node fs 權限層。
 *
 * 為什麼：1.6.8 完全信任級 backend 以 `--permission` 啟動，Node fs 只能讀 installDir／dataDir、寫 dataDir，
 * 讀 `%LOCALAPPDATA%\LINE\...` 會被 `ERR_ACCESS_DENIED`；`child_process` 被禁止（所以 `tasklist` 也不能用）。
 * koffi 是純 Win32 FFI（N-API，不重編），不經過 Node 的 fs 模組，權限模型看不到也擋不到
 * （native spike §3 實測；這也是 manifest 必須宣告 `native:addons` 的原因）。
 *
 * 分工（對應 LineFsPort 的三組方法）：
 *   1. LINE 來源讀取（readDir／stat／exists／readFile／copyFile）→ koffi：
 *      FindFirstFileW／GetFileAttributesExW／GetFileAttributesW／CreateFileW+ReadFile／CopyFileW。
 *      檔案以 FILE_SHARE_READ|WRITE|DELETE 開啟，LINE 開著時也讀得到。
 *   2. 引擎工作區與狀態檔 → node:fs，但**只限 `workspaceRoot`（dataDir 底下）**；權限模型就是邊界。
 *   3. 行程列舉 → Toolhelp32（取代 `execFileSync('tasklist')`）。
 *
 * 唯讀鐵律：LINE 來源端只有讀取與複製「出來」，沒有任何寫入／刪除 LINE 目錄的呼叫。
 *
 * koffi 的載入點是可注入的（`loadKoffi`）：外掛打包後要從固定路徑載入（addon shim，Phase 5），
 * 不做 PATH／PWD probing。預設用 `createRequire(import.meta.url)('koffi')`。
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, win32 } from 'node:path'

import type { LineDirEntry, LineFileStat, LineFsPort } from '../fsPort'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KoffiApi = any

export interface Win32LineFsPortOptions {
  /** 引擎工作區根目錄（dataDir 底下；snapshot 暫存、.linekey、checkpoint 都放這裡）。會自動建立。 */
  workspaceRoot: string
  /** koffi 載入點；預設 `createRequire(import.meta.url)('koffi')`。 */
  loadKoffi?: () => KoffiApi
}

export class Win32Error extends Error {
  readonly code: string
  readonly win32Code: number
  constructor(op: string, path: string, win32Code: number) {
    const code = win32Code === 2 || win32Code === 3 ? 'ENOENT' : win32Code === 5 ? 'EACCES' : win32Code === 32 ? 'EBUSY' : 'EIO'
    super(`${code}: ${op} failed (win32 error ${win32Code}): ${path}`)
    this.name = 'Win32Error'
    this.code = code
    this.win32Code = win32Code
  }
}

const INVALID_FILE_ATTRIBUTES = 0xffffffff
const FILE_ATTRIBUTE_DIRECTORY = 0x10
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400
const IO_REPARSE_TAG_SYMLINK = 0xa000000c
const GENERIC_READ = 0x80000000
const FILE_SHARE_ALL = 0x1 | 0x2 | 0x4 // READ | WRITE | DELETE
const OPEN_EXISTING = 3
const FILE_ATTRIBUTE_NORMAL = 0x80
const TH32CS_SNAPPROCESS = 0x2
const READ_CHUNK = 8 * 1024 * 1024
/** FILETIME（1601-01-01，100ns）→ Unix epoch ns（與 `statSync(p,{bigint:true}).mtimeNs` 同一個換算）。 */
const FILETIME_UNIX_EPOCH_100NS = 116444736000000000n

interface Win32Api {
  koffi: KoffiApi
  GetFileAttributesW: (p: string) => number
  GetFileAttributesExW: (p: string, level: number, out: Record<string, number>) => boolean
  CopyFileW: (src: string, dst: string, failIfExists: boolean) => boolean
  CreateFileW: (p: string, access: number, share: number, sec: null, disp: number, flags: number, tmpl: null) => unknown
  GetFileSizeEx: (h: unknown, out: number[]) => boolean
  ReadFile: (h: unknown, buf: Uint8Array, n: number, read: number[], ov: null) => boolean
  CloseHandle: (h: unknown) => boolean
  FindFirstFileW: (pattern: string, out: Record<string, unknown>) => unknown
  FindNextFileW: (h: unknown, out: Record<string, unknown>) => boolean
  FindClose: (h: unknown) => boolean
  CreateToolhelp32Snapshot: (flags: number, pid: number) => unknown
  Process32FirstW: (h: unknown, out: Record<string, unknown>) => boolean
  Process32NextW: (h: unknown, out: Record<string, unknown>) => boolean
  GetLastError: () => number
  FindData: unknown
  ProcessEntry: unknown
}

const apiCache = new WeakMap<object, Win32Api>()

function bindApi(koffi: KoffiApi): Win32Api {
  const cached = apiCache.get(koffi)
  if (cached) return cached
  const k32 = koffi.load('kernel32.dll')
  const FileTime = koffi.struct('LT_FILETIME', { dwLowDateTime: 'uint32_t', dwHighDateTime: 'uint32_t' })
  koffi.struct('LT_WIN32_FILE_ATTRIBUTE_DATA', {
    dwFileAttributes: 'uint32_t',
    ftCreationTime: FileTime,
    ftLastAccessTime: FileTime,
    ftLastWriteTime: FileTime,
    nFileSizeHigh: 'uint32_t',
    nFileSizeLow: 'uint32_t',
  })
  const FindData = koffi.struct('LT_WIN32_FIND_DATAW', {
    dwFileAttributes: 'uint32_t',
    ftCreationTime: FileTime,
    ftLastAccessTime: FileTime,
    ftLastWriteTime: FileTime,
    nFileSizeHigh: 'uint32_t',
    nFileSizeLow: 'uint32_t',
    dwReserved0: 'uint32_t',
    dwReserved1: 'uint32_t',
    cFileName: koffi.array('char16_t', 260, 'String'),
    cAlternateFileName: koffi.array('char16_t', 14, 'String'),
  })
  const ProcessEntry = koffi.struct('LT_PROCESSENTRY32W', {
    dwSize: 'uint32_t',
    cntUsage: 'uint32_t',
    th32ProcessID: 'uint32_t',
    th32DefaultHeapID: 'uintptr_t',
    th32ModuleID: 'uint32_t',
    cntThreads: 'uint32_t',
    th32ParentProcessID: 'uint32_t',
    pcPriClassBase: 'int32_t',
    dwFlags: 'uint32_t',
    szExeFile: koffi.array('char16_t', 260, 'String'),
  })
  const api: Win32Api = {
    koffi,
    GetFileAttributesW: k32.func('uint32 __stdcall GetFileAttributesW(str16 lpFileName)'),
    GetFileAttributesExW: k32.func(
      'bool __stdcall GetFileAttributesExW(str16 lpFileName, int fInfoLevelId, _Out_ LT_WIN32_FILE_ATTRIBUTE_DATA* lpFileInformation)',
    ),
    CopyFileW: k32.func('bool __stdcall CopyFileW(str16 lpExistingFileName, str16 lpNewFileName, bool bFailIfExists)'),
    CreateFileW: k32.func(
      'void* __stdcall CreateFileW(str16 lpFileName, uint32 dwDesiredAccess, uint32 dwShareMode, void* lpSecurityAttributes, uint32 dwCreationDisposition, uint32 dwFlagsAndAttributes, void* hTemplateFile)',
    ),
    GetFileSizeEx: k32.func('bool __stdcall GetFileSizeEx(void* hFile, _Out_ int64_t* lpFileSize)'),
    ReadFile: k32.func(
      'bool __stdcall ReadFile(void* hFile, _Out_ uint8_t* lpBuffer, uint32 nNumberOfBytesToRead, _Out_ uint32* lpNumberOfBytesRead, void* lpOverlapped)',
    ),
    CloseHandle: k32.func('bool __stdcall CloseHandle(void* hObject)'),
    FindFirstFileW: k32.func('void* __stdcall FindFirstFileW(str16 lpFileName, _Out_ LT_WIN32_FIND_DATAW* lpFindFileData)'),
    FindNextFileW: k32.func('bool __stdcall FindNextFileW(void* hFindFile, _Out_ LT_WIN32_FIND_DATAW* lpFindFileData)'),
    FindClose: k32.func('bool __stdcall FindClose(void* hFindFile)'),
    CreateToolhelp32Snapshot: k32.func('void* __stdcall CreateToolhelp32Snapshot(uint32 dwFlags, uint32 th32ProcessID)'),
    Process32FirstW: k32.func('bool __stdcall Process32FirstW(void* hSnapshot, _Inout_ LT_PROCESSENTRY32W* lppe)'),
    Process32NextW: k32.func('bool __stdcall Process32NextW(void* hSnapshot, _Inout_ LT_PROCESSENTRY32W* lppe)'),
    GetLastError: k32.func('uint32 __stdcall GetLastError()'),
    FindData,
    ProcessEntry,
  }
  apiCache.set(koffi, api)
  return api
}

/** HANDLE 是否無效（NULL 或 INVALID_HANDLE_VALUE）。 */
function isInvalidHandle(koffi: KoffiApi, h: unknown): boolean {
  if (h === null || h === undefined) return true
  const addr = koffi.address(h) as bigint
  return addr === 0n || addr === 0xffffffffffffffffn
}

function fileTimeToUnixNs(ft: { dwLowDateTime: number; dwHighDateTime: number }): bigint {
  const t = (BigInt(ft.dwHighDateTime) << 32n) | BigInt(ft.dwLowDateTime)
  return (t - FILETIME_UNIX_EPOCH_100NS) * 100n
}

/**
 * 引擎在 `workspaceRoot` 底下建的暫存快照目錄前綴（`linedb.ts` 的 `openDb`、`linekey.ts` 的 `BatchVerifier`）。
 * 它們是 LINE 加密資料庫的副本（約 200 MB）；正常流程在 `finally` 裡刪除，backend 被強制結束時沒有機會刪，所以啟動時清掃（review F4）。
 */
export const ENGINE_TEMP_PREFIXES: readonly string[] = ['linedb-', 'linekey-scan-']

export class Win32LineFsPort implements LineFsPort {
  private readonly api: Win32Api
  private readonly workspaceRoot: string
  /** 建構時清掉的殘留快照目錄數（診斷／測試）。 */
  readonly sweptOrphans: number

  constructor(options: Win32LineFsPortOptions) {
    const load = options.loadKoffi ?? (() => createRequire(import.meta.url)('koffi'))
    this.api = bindApi(load())
    this.workspaceRoot = options.workspaceRoot
    mkdirSync(this.workspaceRoot, { recursive: true })
    this.sweptOrphans = this.sweepOrphans()
  }

  /**
   * 清掉 `workspaceRoot` 底下殘留的暫存快照目錄（只刪 `ENGINE_TEMP_PREFIXES` 開頭的「目錄」；其他檔案與目錄，例如 `.linekey`、checkpoint，一律不碰）。
   * workspaceRoot 是 dataDir 底下專屬於這個 backend 的資料夾，一個外掛同時只有一個 backend 行程，所以建構時不會有「別人正在用」的快照。
   * 刪不掉的（檔案被占用等）略過、不丟錯：清掃是盡力而為，不能讓 backend 起不來。
   */
  private sweepOrphans(): number {
    let removed = 0
    let entries: Array<{ name: string; isDirectory(): boolean }>
    try { entries = readdirSync(this.workspaceRoot, { withFileTypes: true }) } catch { return 0 }
    for (const entry of entries) {
      if (!entry.isDirectory() || !ENGINE_TEMP_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue
      try { rmSync(join(this.workspaceRoot, entry.name), { recursive: true, force: true }); removed += 1 } catch { /* 盡力而為 */ }
    }
    return removed
  }

  // ── 1. LINE 來源讀取（koffi） ──

  readDir(dir: string): LineDirEntry[] {
    const a = this.api
    const data: Record<string, unknown> = {}
    const h = a.FindFirstFileW(win32.join(dir, '*'), data)
    if (isInvalidHandle(a.koffi, h)) throw new Win32Error('FindFirstFileW', dir, a.GetLastError())
    const out: LineDirEntry[] = []
    try {
      do {
        const name = data.cFileName as string
        if (name === '.' || name === '..') continue
        const attrs = data.dwFileAttributes as number
        const isSymlink =
          (attrs & FILE_ATTRIBUTE_REPARSE_POINT) !== 0 && (data.dwReserved0 as number) === IO_REPARSE_TAG_SYMLINK
        const isDir = (attrs & FILE_ATTRIBUTE_DIRECTORY) !== 0
        // 比照 Dirent：symlink 兩者皆 false。
        out.push({ name, isFile: !isSymlink && !isDir, isDirectory: !isSymlink && isDir })
      } while (a.FindNextFileW(h, data))
    } finally {
      a.FindClose(h)
    }
    return out
  }

  stat(path: string): LineFileStat {
    const a = this.api
    const data: Record<string, number> = {}
    if (!a.GetFileAttributesExW(path, 0, data)) throw new Win32Error('GetFileAttributesExW', path, a.GetLastError())
    const size = Number((BigInt(data.nFileSizeHigh) << 32n) | BigInt(data.nFileSizeLow))
    const ft = data.ftLastWriteTime as unknown as { dwLowDateTime: number; dwHighDateTime: number }
    return { size, mtimeNs: fileTimeToUnixNs(ft) }
  }

  exists(path: string): boolean {
    return this.api.GetFileAttributesW(path) !== INVALID_FILE_ATTRIBUTES
  }

  readFile(path: string): Buffer {
    const a = this.api
    const h = a.CreateFileW(path, GENERIC_READ, FILE_SHARE_ALL, null, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, null)
    if (isInvalidHandle(a.koffi, h)) throw new Win32Error('CreateFileW', path, a.GetLastError())
    try {
      const sizeOut: number[] = [0]
      if (!a.GetFileSizeEx(h, sizeOut)) throw new Win32Error('GetFileSizeEx', path, a.GetLastError())
      const total = Number(sizeOut[0])
      const buf = Buffer.alloc(total)
      let done = 0
      while (done < total) {
        const want = Math.min(READ_CHUNK, total - done)
        const chunk = Buffer.alloc(want)
        const read: number[] = [0]
        if (!a.ReadFile(h, chunk, want, read, null)) throw new Win32Error('ReadFile', path, a.GetLastError())
        if (read[0] === 0) break
        chunk.copy(buf, done, 0, read[0])
        done += read[0]
      }
      return done === total ? buf : buf.subarray(0, done)
    } finally {
      a.CloseHandle(h)
    }
  }

  copyFile(src: string, dst: string): void {
    // bFailIfExists=false：與 fs.copyFileSync 預設（覆寫）一致。
    if (!this.api.CopyFileW(src, dst, false)) throw new Win32Error('CopyFileW', src, this.api.GetLastError())
  }

  // ── 2. 引擎工作區與狀態檔（node:fs，僅限 dataDir 底下） ──

  makeTempDir(prefix: string): string {
    return mkdtempSync(join(this.workspaceRoot, prefix))
  }

  removeDir(dir: string): void {
    rmSync(dir, { recursive: true, force: true })
  }

  ensureDir(dir: string): void {
    mkdirSync(dir, { recursive: true })
  }

  readTextFile(path: string): string {
    return readFileSync(path, 'utf8')
  }

  writeTextFile(path: string, data: string): void {
    writeFileSync(path, data, 'utf8')
  }

  renameFile(from: string, to: string): void {
    renameSync(from, to)
  }

  // ── 3. 行程（Toolhelp32，取代 tasklist） ──

  listProcessIds(imageName: string): number[] {
    const a = this.api
    const target = imageName.toLowerCase()
    let snap: unknown
    try {
      snap = a.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    } catch {
      return []
    }
    if (isInvalidHandle(a.koffi, snap)) return []
    const pids: number[] = []
    try {
      const entry: Record<string, unknown> = { dwSize: a.koffi.sizeof(a.ProcessEntry) }
      let ok = a.Process32FirstW(snap, entry)
      while (ok) {
        if (String(entry.szExeFile).toLowerCase() === target) pids.push(entry.th32ProcessID as number)
        ok = a.Process32NextW(snap, entry)
      }
    } catch {
      // 列舉失敗：回目前已收集的結果（與 NodeLineFsPort 的「失敗回 []」同一個容忍度）
    } finally {
      a.CloseHandle(snap)
    }
    return pids
  }
}

export function createWin32LineFsPort(options: Win32LineFsPortOptions): LineFsPort {
  return new Win32LineFsPort(options)
}
