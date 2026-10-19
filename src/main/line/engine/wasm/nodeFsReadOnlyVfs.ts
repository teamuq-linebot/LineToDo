/**
 * nodeFsReadOnlyVfs.ts — SQLite3MultipleCiphers WASM 用的**唯讀** node:fs VFS（外掛 backend 專用）。
 *
 * 為什麼存在：1.6.8 完全信任級 backend 只能用 Node fs 讀 installDir／dataDir、寫 dataDir，
 * 而 LINE DB 的 snapshot（edb／-wal／-shm）由 koffi 複製進 dataDir。WASM 預設的 MEMFS 要把整檔讀進
 * WASM heap（196 MB DB 峰值 RSS 約 820 MB）；這個 VFS 改成 xRead 直接 `fs.readSync` 到 WASM heap，
 * 不做整檔副本（同規模峰值約 90–140 MB，見 wasm-vfs spike 報告 §3(d)）。
 *
 * 範圍（Manager 裁定，Phase 1）：
 *   - **只讀**。檔案一律 `O_RDONLY` 開啟；xWrite／xTruncate／xSync／xDelete 一律回錯，不碰磁碟。
 *     要求 READWRITE／CREATE 的 open 會被降級成唯讀並在 pOutFlags 回報 SQLITE_OPEN_READONLY
 *     （跟 unix VFS 在檔案不可寫時的行為一致）。不支援 fsync、temp 檔（`TEMP_STORE=2`，
 *     本 build 預設全放記憶體）。
 *   - **不支援跨程序鎖**。xLock／xShmLock 只是行程內的鎖表；shm（wal-index）放在 WASM heap，
 *     磁碟上的 `-shm` 從不讀寫（第一次開檔由 SQLite 從 `-wal` 重建）。這對「只屬於這個 backend 的
 *     私有 snapshot」成立，絕不可拿來開另一個程序同時在寫的檔案。
 *   - 不使用 MEMFS。
 *
 * 分層：`sqlite3mc_vfs_create(name, 0)` 把本 VFS 包在 cipher 層底下，產生 `multipleciphers-<name>`；
 * 連線用這個名字開檔，頁的解密由 cipher 層負責，本 VFS 只搬 bytes。
 *
 * ⚠ BigInt offset 陷阱（wasm-vfs spike §0 條件 3）：WASM 的 i64 參數（xRead 的 iOfst）是 BigInt。
 * 傳 BigInt 給 `fs.readSync/writeSync` 的 position，在某些路徑會被靜默忽略（改成讀／寫「目前檔案位置」），
 * 結果是讀到錯誤的頁。所以所有 position 一律經 {@link toFsPosition} 轉成 Number（超出安全整數就明確報錯）。
 * `scripts/test-wasm-vfs.mjs` 用 spy fs 守住這一點。
 */
import * as nodeFs from 'node:fs'

/** VFS 實際用到的 node:fs 子集（可注入 spy／fake；預設是 node:fs）。 */
export interface VfsFs {
  openSync(path: string, flags: number): number
  readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number
  fstatSync(fd: number, options: { bigint: true }): { size: bigint }
  closeSync(fd: number): void
  statSync(path: string, options: { throwIfNoEntry: false }): unknown
  constants: { O_RDONLY: number }
}

export interface ReadOnlyVfsStats {
  opens: number
  reads: number
  readBytes: number
  /** 被拒絕的寫入類呼叫（xWrite／xTruncate／xSync／xDelete）次數；正常讀取路徑應為 0。 */
  rejectedWrites: number
}

export interface InstalledReadOnlyVfs {
  /** 原始（未包 cipher）VFS 名稱。 */
  rawName: string
  /** 包了 cipher 層的 VFS 名稱；`new oo1.DB({ vfs })` 用這個。 */
  vfsName: string
  stats: ReadOnlyVfsStats
  /** 目前尚未關閉的檔案數（洩漏檢查用）。 */
  openFiles(): number
  /** 目前存活的 shm（wal-index）節點數（洩漏檢查用）。 */
  shmNodes(): number
  /** 最近一次 VFS 內部錯誤（node errno code 或訊息），供診斷。 */
  lastError(): string | null
}

export interface InstallReadOnlyVfsOptions {
  /** VFS 名稱，預設 `nodefs-ro`。 */
  name?: string
  /** 注入 fs（測試用）。預設 node:fs。 */
  fs?: VfsFs
}

/**
 * 把 WASM 傳來的 offset（i64 → BigInt，或 Number）轉成 `fs.readSync` 可安全使用的 Number position。
 * 負值或超出 `Number.MAX_SAFE_INTEGER` 一律 throw（呼叫端轉成 SQLITE_IOERR_READ），
 * 絕不把 BigInt 往下傳。
 */
export function toFsPosition(offset: bigint | number): number {
  const n = typeof offset === 'bigint' ? Number(offset) : offset
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`VFS offset out of range: ${String(offset)}`)
  }
  return n
}

// SQLite result / flag constants（sqlite.org/rescode.html、sqlite3.h）。
const C = {
  BUSY: 5,
  READONLY: 8,
  IOERR: 10,
  NOTFOUND: 12,
  CANTOPEN: 14,
  IOERR_READ: 266,
  IOERR_SHORT_READ: 522,
  IOERR_FSTAT: 1802,
  IOERR_DELETE: 2570,
  IOERR_SHMSIZE: 4874,
  IOERR_SHMMAP: 5386,
  OPEN_READONLY: 0x1,
  OPEN_READWRITE: 0x2,
  OPEN_CREATE: 0x4,
  OPEN_DELETEONCLOSE: 0x8,
  OPEN_EXCLUSIVE: 0x10,
  OPEN_WAL: 0x80000,
  ACCESS_READWRITE: 1,
  LOCK_NONE: 0,
  LOCK_SHARED: 1,
  LOCK_RESERVED: 2,
  LOCK_PENDING: 3,
  LOCK_EXCLUSIVE: 4,
  SHM_UNLOCK: 1,
  SHM_SHARED: 4,
  SHM_NLOCK: 8,
} as const

interface OpenFile {
  /** `-1` 表示「虛擬空檔」（唯讀連線要求開不存在的 -wal 時，視為 0 byte）。 */
  fd: number
  path: string
  flags: number
  lock: number
  shm: ShmNode | null
}

interface ShmSlot {
  shared: Set<number>
  excl: number
}

interface ShmNode {
  regions: number[]
  size: number
  refs: Set<number>
  slots: ShmSlot[]
}

interface LockEntry {
  shared: Set<number>
  reserved: number
  pending: number
  exclusive: number
}

// sqlite3 WASM API 的型別由 sqlite3.mjs 在執行期提供，這裡刻意不宣告完整型別。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sqlite3Api = any

export function installReadOnlyNodeFsVfs(
  sqlite3: Sqlite3Api,
  options: InstallReadOnlyVfsOptions = {},
): InstalledReadOnlyVfs {
  const fs: VfsFs = options.fs ?? (nodeFs as unknown as VfsFs)
  const name = options.name ?? 'nodefs-ro'
  const { capi, wasm } = sqlite3
  const files = new Map<number, OpenFile>()
  const lockTable = new Map<string, LockEntry>()
  const shmTable = new Map<string, ShmNode>()
  const stats: ReadOnlyVfsStats = { opens: 0, reads: 0, readBytes: 0, rejectedWrites: 0 }
  let lastErr: unknown = null

  const fail = (e: unknown, rc: number): number => {
    lastErr = e
    return rc
  }
  const reject = (rc: number): number => {
    stats.rejectedWrites++
    return rc
  }
  const lockOf = (p: string): LockEntry => {
    let l = lockTable.get(p)
    if (!l) {
      l = { shared: new Set(), reserved: 0, pending: 0, exclusive: 0 }
      lockTable.set(p, l)
    }
    return l
  }

  const io = {
    xClose(pFile: number): number {
      const f = files.get(pFile)
      if (!f) return 0
      files.delete(pFile)
      const l = lockOf(f.path)
      l.shared.delete(pFile)
      if (l.reserved === pFile) l.reserved = 0
      if (l.pending === pFile) l.pending = 0
      if (l.exclusive === pFile) l.exclusive = 0
      if (!l.shared.size && !l.reserved && !l.pending && !l.exclusive) lockTable.delete(f.path)
      try {
        if (f.fd >= 0) fs.closeSync(f.fd)
      } catch (e) {
        return fail(e, C.IOERR)
      }
      return 0
    },
    xRead(pFile: number, pDest: number, n: number, off: bigint | number): number {
      const f = files.get(pFile)
      if (!f) return C.IOERR_READ
      try {
        const heap: Uint8Array = wasm.heap8u()
        const dst = Number(pDest)
        const base = toFsPosition(off)
        let got = 0
        if (f.fd >= 0) {
          while (got < n) {
            // position 一律是 Number（見檔頭的 BigInt 陷阱）。
            const r = fs.readSync(f.fd, heap, dst + got, n - got, base + got)
            if (r === 0) break
            got += r
          }
        }
        stats.reads++
        stats.readBytes += got
        if (got < n) {
          heap.fill(0, dst + got, dst + n)
          return C.IOERR_SHORT_READ
        }
        return 0
      } catch (e) {
        return fail(e, C.IOERR_READ)
      }
    },
    xWrite(): number {
      return reject(C.READONLY)
    },
    xTruncate(): number {
      return reject(C.READONLY)
    },
    xSync(): number {
      return reject(C.READONLY)
    },
    xFileSize(pFile: number, pSz: number): number {
      const f = files.get(pFile)
      if (!f) return C.IOERR_FSTAT
      try {
        wasm.poke64(pSz, f.fd >= 0 ? fs.fstatSync(f.fd, { bigint: true }).size : 0n)
        return 0
      } catch (e) {
        return fail(e, C.IOERR_FSTAT)
      }
    },
    xLock(pFile: number, level: number): number {
      const f = files.get(pFile)
      if (!f) return C.IOERR
      if (f.lock >= level) return 0
      const l = lockOf(f.path)
      const other = (h: number): boolean => h !== 0 && h !== pFile
      if (level === C.LOCK_SHARED) {
        if (other(l.pending) || other(l.exclusive)) return C.BUSY
        l.shared.add(pFile)
        f.lock = C.LOCK_SHARED
        return 0
      }
      if (level === C.LOCK_RESERVED) {
        if (other(l.reserved) || other(l.pending) || other(l.exclusive)) return C.BUSY
        l.reserved = pFile
        f.lock = C.LOCK_RESERVED
        return 0
      }
      if (other(l.pending) || other(l.exclusive)) return C.BUSY
      l.pending = pFile
      f.lock = Math.max(f.lock, C.LOCK_PENDING)
      if (level === C.LOCK_PENDING) return 0
      for (const h of l.shared) if (h !== pFile) return C.BUSY
      l.exclusive = pFile
      f.lock = C.LOCK_EXCLUSIVE
      return 0
    },
    xUnlock(pFile: number, level: number): number {
      const f = files.get(pFile)
      if (!f) return 0
      if (f.lock <= level) return 0
      const l = lockOf(f.path)
      if (level < C.LOCK_EXCLUSIVE && l.exclusive === pFile) l.exclusive = 0
      if (level < C.LOCK_PENDING && l.pending === pFile) l.pending = 0
      if (level < C.LOCK_RESERVED && l.reserved === pFile) l.reserved = 0
      if (level < C.LOCK_SHARED) l.shared.delete(pFile)
      f.lock = level
      return 0
    },
    xCheckReservedLock(pFile: number, pOut: number): number {
      const f = files.get(pFile)
      const l = f ? lockOf(f.path) : null
      wasm.poke32(pOut, l && (l.reserved || l.pending || l.exclusive) ? 1 : 0)
      return 0
    },
    xFileControl(): number {
      return C.NOTFOUND
    },
    xSectorSize(): number {
      return 4096
    },
    xDeviceCharacteristics(): number {
      return 0
    },
  }

  const shm = {
    xShmMap(pFile: number, iRegion: number, szRegion: number, _bExtend: number, pp: number): number {
      const f = files.get(pFile)
      if (!f) return C.IOERR_SHMMAP
      try {
        let node = shmTable.get(f.path)
        if (!node) {
          node = {
            regions: [],
            size: szRegion,
            refs: new Set(),
            slots: Array.from({ length: C.SHM_NLOCK }, () => ({ shared: new Set<number>(), excl: 0 })),
          }
          shmTable.set(f.path, node)
        }
        if (node.size !== szRegion) return C.IOERR_SHMSIZE
        node.refs.add(pFile)
        f.shm = node
        // 唯讀連線也要能重建 wal-index：shm 是私有 heap 記憶體，不是磁碟檔，所以不管 bExtend 都配置。
        for (let i = node.regions.length; i <= iRegion; i++) {
          const p = Number(wasm.alloc(szRegion))
          wasm.heap8u().fill(0, p, p + szRegion)
          node.regions[i] = p
        }
        wasm.pokePtr(pp, node.regions[iRegion] || 0)
        return 0
      } catch (e) {
        return fail(e, C.IOERR_SHMMAP)
      }
    },
    xShmLock(pFile: number, ofst: number, n: number, flags: number): number {
      const f = files.get(pFile)
      const node = f?.shm
      if (!node) return C.IOERR_SHMMAP
      const slots = node.slots.slice(ofst, ofst + n)
      if (flags & C.SHM_UNLOCK) {
        for (const s of slots) {
          s.shared.delete(pFile)
          if (s.excl === pFile) s.excl = 0
        }
        return 0
      }
      if (flags & C.SHM_SHARED) {
        for (const s of slots) if (s.excl && s.excl !== pFile) return C.BUSY
        for (const s of slots) s.shared.add(pFile)
        return 0
      }
      for (const s of slots) {
        if (s.excl && s.excl !== pFile) return C.BUSY
        for (const h of s.shared) if (h !== pFile) return C.BUSY
      }
      for (const s of slots) s.excl = pFile
      return 0
    },
    xShmBarrier(): void {},
    xShmUnmap(pFile: number): number {
      const f = files.get(pFile)
      const node = f?.shm
      if (!f || !node) return 0
      for (const s of node.slots) {
        s.shared.delete(pFile)
        if (s.excl === pFile) s.excl = 0
      }
      node.refs.delete(pFile)
      f.shm = null
      if (!node.refs.size) {
        for (const p of node.regions) if (p) wasm.dealloc(p)
        shmTable.delete(f.path)
      }
      return 0
    },
  }

  // io_methods iVersion 2：有 xShm*，WAL DB 才能在不寫磁碟 -shm 的情況下讀。
  const ioStruct = new capi.sqlite3_io_methods()
  ioStruct.$iVersion = 2
  sqlite3.vfs.installVfs({ io: { struct: ioStruct, methods: { ...io, ...shm } } })

  const vfsStruct = new capi.sqlite3_vfs()
  const dflt = new capi.sqlite3_vfs(capi.sqlite3_vfs_find(null))
  vfsStruct.$iVersion = 2
  vfsStruct.$szOsFile = capi.sqlite3_file.structInfo.sizeof
  vfsStruct.$mxPathname = 1024
  vfsStruct.$xRandomness = dflt.$xRandomness
  vfsStruct.$xSleep = dflt.$xSleep
  dflt.dispose()

  const methods = {
    xOpen(_pVfs: number, zName: number, pFile: number, flags: number, pOutFlags: number): number {
      let path: string
      try {
        // 沒有檔名＝temp 檔（只有寫入路徑會要）。唯讀 VFS 不提供。
        if (!zName || !wasm.peek8(zName)) return C.CANTOPEN
        path = wasm.cstrToJs(zName) as string
        let fd: number
        try {
          fd = fs.openSync(path, fs.constants.O_RDONLY)
        } catch (e) {
          // 唯讀連線仍會要求開（可能不存在的）-wal：視為 0 byte 虛擬檔，SQLite 會當作沒有 frame。
          if ((e as NodeJS.ErrnoException)?.code === 'ENOENT' && flags & C.OPEN_WAL) {
            fd = -1
          } else {
            throw e
          }
        }
        files.set(pFile, { fd, path, flags, lock: C.LOCK_NONE, shm: null })
        const sf = new capi.sqlite3_file(pFile)
        sf.$pMethods = ioStruct.pointer
        sf.dispose()
        if (pOutFlags) {
          const out =
            (flags & ~(C.OPEN_READWRITE | C.OPEN_CREATE | C.OPEN_DELETEONCLOSE | C.OPEN_EXCLUSIVE)) |
            C.OPEN_READONLY
          wasm.poke32(pOutFlags, out)
        }
        stats.opens++
        return 0
      } catch (e) {
        return fail(e, C.CANTOPEN)
      }
    },
    xDelete(): number {
      return reject(C.IOERR_DELETE)
    },
    xAccess(_pVfs: number, zName: number, flags: number, pOut: number): number {
      let ok = 0
      try {
        // ACCESS_READWRITE：這個 VFS 永遠不可寫。ACCESS_EXISTS／READ：看檔案在不在。
        if (flags !== C.ACCESS_READWRITE) {
          ok = fs.statSync(wasm.cstrToJs(zName) as string, { throwIfNoEntry: false }) ? 1 : 0
        }
      } catch {
        ok = 0
      }
      wasm.poke32(pOut, ok)
      return 0
    },
    xFullPathname(_pVfs: number, zName: number, nOut: number, pOut: number): number {
      const i = wasm.cstrncpy(pOut, zName, nOut)
      return i < nOut ? 0 : C.CANTOPEN
    },
    xCurrentTime(_pVfs: number, pOut: number): number {
      wasm.poke(pOut, 2440587.5 + Date.now() / 86400000, 'double')
      return 0
    },
    xCurrentTimeInt64(_pVfs: number, pOut: number): number {
      wasm.poke(pOut, 2440587.5 * 86400000 + Date.now(), 'i64')
      return 0
    },
    xGetLastError(_pVfs: number, nOut: number, pOut: number): number {
      const e = lastErr as { code?: string; message?: string } | null
      lastErr = null
      if (e && nOut > 0) {
        const s = wasm.allocCString(String(e.code || e.message).slice(0, nOut - 1))
        try {
          wasm.cstrncpy(pOut, s, nOut)
        } finally {
          wasm.dealloc(s)
        }
      }
      return 0
    },
  }
  sqlite3.vfs.installVfs({ vfs: { struct: vfsStruct, methods, name } })

  const rc: number = capi.sqlite3mc_vfs_create(name, 0)
  if (rc !== 0) throw new Error(`sqlite3mc_vfs_create(${name}) rc=${rc}`)
  const wrapped = `multipleciphers-${name}`
  if (!capi.sqlite3_vfs_find(wrapped)) throw new Error(`cipher-wrapped VFS not found: ${wrapped}`)

  return {
    rawName: name,
    vfsName: wrapped,
    stats,
    openFiles: () => files.size,
    shmNodes: () => shmTable.size,
    lastError: () => {
      const e = lastErr as { code?: string; message?: string } | null
      return e ? String(e.code || e.message) : null
    },
  }
}
