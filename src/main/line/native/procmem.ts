/**
 * procmem.ts — koffi FFI 封裝 Win32 process-memory 唯讀掃描（Batch 2）。
 *
 * 逐一對照外部 Python 引擎 `line-cua-win/src/linekey.py` 的 `scan_candidates`
 * （ctypes 呼叫 kernel32）。此 TS 版改用 **koffi**（預編譯 N-API FFI，支援
 * Electron ABI、零編譯、無 Python）宣告同樣的 kernel32 簽章直呼：
 *   OpenProcess(PROCESS_QUERY_INFORMATION|PROCESS_VM_READ) → 迴圈
 *   VirtualQueryEx（打包 MEMORY_BASIC_INFORMATION）走 committed / 非 guard /
 *   非 noaccess 區 → ReadProcessMemory 分 ~4MB chunk 讀出。CloseHandle 釋放。
 *
 * ★ 唯讀鐵律 ★：只 ReadProcessMemory，**嚴禁** WriteProcessMemory / 任何寫入
 * 或注入。本模組不宣告任何寫入 API。
 *
 * 掃描結果（bytes）交回 linekey.ts 的正則抽 32-hex；本模組只負責「讀出原始
 * 記憶體 bytes」，不做候選抽取（保持 FFI 層薄、正則邏輯集中在 linekey.ts）。
 *
 * 本檔為 Batch 2 新增，不改動任何現有執行路徑。
 */
import koffi from 'koffi'

// ---- Win32 常數（逐字對齊 linekey.py:51-56） ----
const PROCESS_QUERY_INFORMATION = 0x0400
const PROCESS_VM_READ = 0x0010
const MEM_COMMIT = 0x1000
const PAGE_GUARD = 0x100
const PAGE_NOACCESS = 0x01

// 掃描參數（對齊 linekey.py:99-101）。
const CHUNK = 4 * 1024 * 1024
const OVERLAP = 80
// x64 使用者位址空間上限（對齊 linekey.py:104 的 0x7FFFFFFFFFFF）。
const MAX_ADDR = 0x7fffffffffff

/**
 * MEMORY_BASIC_INFORMATION（x64 版）。逐欄對齊 linekey.py 的 `_MBI`
 * （含兩個對齊填充 DWORD）。x64 下 sizeof 應為 48。指標欄用 uintptr_t
 * 讓 koffi 以整數回傳，避免 JS 端指標運算誤差。
 */
const MEMORY_BASIC_INFORMATION = koffi.struct('MEMORY_BASIC_INFORMATION', {
  BaseAddress: 'uintptr_t',
  AllocationBase: 'uintptr_t',
  AllocationProtect: 'uint32_t',
  __align1: 'uint32_t',
  RegionSize: 'size_t',
  State: 'uint32_t',
  Protect: 'uint32_t',
  Type: 'uint32_t',
  __align2: 'uint32_t',
})

interface Kernel32 {
  OpenProcess: (access: number, inherit: boolean, pid: number) => unknown
  VirtualQueryEx: (
    h: unknown,
    addr: number,
    mbi: Record<string, number>,
    len: number,
  ) => number
  ReadProcessMemory: (
    h: unknown,
    addr: number,
    buf: Uint8Array,
    size: number,
    read: number[],
  ) => boolean
  CloseHandle: (h: unknown) => boolean
  GetLastError: () => number
}

let _k32: Kernel32 | null = null

/** 惰性宣告 kernel32 簽章（只宣告唯讀所需，無任何寫入 API）。 */
function kernel32(): Kernel32 {
  if (_k32) return _k32
  const lib = koffi.load('kernel32.dll')
  _k32 = {
    OpenProcess: lib.func('__stdcall', 'OpenProcess', 'void*', [
      'uint32_t',
      'bool',
      'uint32_t',
    ]) as Kernel32['OpenProcess'],
    VirtualQueryEx: lib.func('__stdcall', 'VirtualQueryEx', 'size_t', [
      'void*',
      'uintptr_t',
      koffi.out(koffi.pointer(MEMORY_BASIC_INFORMATION)),
      'size_t',
    ]) as Kernel32['VirtualQueryEx'],
    ReadProcessMemory: lib.func('__stdcall', 'ReadProcessMemory', 'bool', [
      'void*',
      'uintptr_t',
      koffi.out('void*'),
      'size_t',
      koffi.out(koffi.pointer('size_t')),
    ]) as Kernel32['ReadProcessMemory'],
    CloseHandle: lib.func('__stdcall', 'CloseHandle', 'bool', ['void*']) as Kernel32['CloseHandle'],
    GetLastError: lib.func('__stdcall', 'GetLastError', 'uint32_t', []) as Kernel32['GetLastError'],
  }
  return _k32
}

/** koffi 對 void* 回傳 null（handle 開啟失敗）時的判別。 */
function isNullHandle(h: unknown): boolean {
  return h === null || h === undefined || koffi.address(h as never) === 0n
}

/**
 * scanRegions(pid, onChunk) — 走遍目標程序可讀記憶體，逐 chunk 把原始 bytes
 * 交給 callback。callback 回傳字面 false 可提早中止（例如已命中 key）。
 *
 * 逐步對齊 linekey.py:89-126（`scan_candidates`）：
 *   OpenProcess → while VirtualQueryEx → readable gate（committed / 非 guard /
 *   非 noaccess）→ 分 chunk ReadProcessMemory（含 OVERLAP 回退避免跨 chunk 漏字）
 *   → finally CloseHandle。
 *
 * ★ CloseHandle 於 finally 保證釋放，避免 handle leak。
 */
export function scanRegions(
  pid: number,
  onChunk: (bytes: Buffer) => boolean | void,
): void {
  const k = kernel32()
  const h = k.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid)
  if (isNullHandle(h)) {
    throw new Error(`OpenProcess failed (err=${k.GetLastError()})`)
  }
  const buf = Buffer.allocUnsafe(CHUNK)
  const mbiLen = koffi.sizeof(MEMORY_BASIC_INFORMATION)
  try {
    let addr = 0
    while (addr < MAX_ADDR) {
      const mbi: Record<string, number> = {}
      const ret = k.VirtualQueryEx(h, addr, mbi, mbiLen)
      if (ret === 0) break
      const base = mbi.BaseAddress || addr
      const size = mbi.RegionSize
      const readable =
        mbi.State === MEM_COMMIT &&
        (mbi.Protect & PAGE_GUARD) === 0 &&
        (mbi.Protect & 0xff) !== PAGE_NOACCESS
      if (readable && size) {
        let off = 0
        while (off < size) {
          const want = Math.min(CHUNK, size - off)
          const nread = [0]
          const ok = k.ReadProcessMemory(h, base + off, buf, want, nread)
          if (ok && nread[0]) {
            // 只把實際讀到的 bytes 交出去（copy，避免下一輪覆寫）。
            const chunk = Buffer.from(buf.subarray(0, nread[0]))
            if (onChunk(chunk) === false) return
          }
          // 對齊 py：滿 chunk 才回退 OVERLAP，避免跨 chunk 邊界漏掉候選。
          off += want === CHUNK ? want - OVERLAP : want
        }
      }
      addr = base + size
      // 防呆：VirtualQueryEx 若回退位址不前進，強制推進避免無限迴圈。
      if (addr <= base) addr = base + (size || 0x1000)
    }
  } finally {
    k.CloseHandle(h)
  }
}
