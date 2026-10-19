// Spike-local synchronous node:fs VFS for the SQLite3MultipleCiphers WASM build.
// The stock WASM build only has Emscripten MEMFS VFSes in Node (no NODEFS compiled in), which cannot
// persist anything. This VFS maps sqlite3_vfs / sqlite3_io_methods v1 onto node:fs *Sync calls, so
// the database file (+ -journal / -wal) lives on real disk inside dataDir (fs.write is allowed there
// by the 1.6.8 flags; everything else is ERR_ACCESS_DENIED).
//   * io_methods iVersion=1: NO xShmMap -> WAL works only with PRAGMA locking_mode=EXCLUSIVE
//     (SQLite keeps the wal-index in heap memory instead of a -shm mapping).
//   * xLock/xUnlock are bookkeeping only (no OS lock): NOT safe for a second process on the same file.
import * as fs from 'node:fs'
import { resolve as resolvePath, join } from 'node:path'
import { randomUUID } from 'node:crypto'

// syncMode 'strict': xSync -> fs.fsyncSync (fails under the Node permission model: 'fsync API is disabled').
// syncMode 'skip-if-denied': ERR_ACCESS_DENIED from fsync is swallowed (counted) => data reaches the OS
// page cache (survives a process crash) but NOT guaranteed on power loss / OS crash (~ synchronous=OFF).
export function installNodeFsVfs(sqlite3, { name = 'nodefs', tempDir, syncMode = 'strict' }) {
  const { capi, wasm } = sqlite3
  const files = new Map() // pFile -> { fd, path, flags, lock }
  const stats = { xRead: 0, xWrite: 0, xSync: 0, xSyncSkippedDenied: 0, xTruncate: 0, opened: [], syncMode }
  let lastError = null
  const RC = (k) => capi[k] ?? ({ SQLITE_IOERR_FSTAT: 1802, SQLITE_IOERR_DELETE_NOENT: 5898 })[k] ?? capi.SQLITE_IOERR
  const enc = new TextEncoder()

  const io = new capi.sqlite3_io_methods()
  io.$iVersion = 1
  const ioMethods = {
    xClose(pFile) {
      const f = files.get(pFile); if (!f) return 0
      files.delete(pFile)
      try { fs.closeSync(f.fd); if (f.flags & capi.SQLITE_OPEN_DELETEONCLOSE) fs.rmSync(f.path, { force: true }); return 0 } catch (e) { lastError = e; return RC('SQLITE_IOERR_CLOSE') }
    },
    xRead(pFile, pDest, n, off) {
      const f = files.get(pFile); stats.xRead++
      const p = Number(pDest)
      const dst = wasm.heap8u().subarray(p, p + n)
      let got = 0
      try {
        while (got < n) { const r = fs.readSync(f.fd, dst, got, n - got, Number(off) + got); if (r === 0) break; got += r }
      } catch (e) { lastError = e; return RC('SQLITE_IOERR_READ') }
      if (got < n) { dst.fill(0, got); return RC('SQLITE_IOERR_SHORT_READ') }
      return 0
    },
    xWrite(pFile, pSrc, n, off) {
      const f = files.get(pFile); stats.xWrite++
      const p = Number(pSrc)
      const src = wasm.heap8u().subarray(p, p + n)
      try { let done = 0; while (done < n) done += fs.writeSync(f.fd, src, done, n - done, Number(off) + done); return 0 } catch (e) { lastError = e; return RC('SQLITE_IOERR_WRITE') }
    },
    xTruncate(pFile, sz) { stats.xTruncate++; try { fs.ftruncateSync(files.get(pFile).fd, Number(sz)); return 0 } catch (e) { lastError = e; return RC('SQLITE_IOERR_TRUNCATE') } },
    xSync(pFile) {
      stats.xSync++
      try { fs.fsyncSync(files.get(pFile).fd); return 0 } catch (e) {
        if (syncMode === 'skip-if-denied' && e.code === 'ERR_ACCESS_DENIED') { stats.xSyncSkippedDenied++; return 0 }
        lastError = e; return RC('SQLITE_IOERR_FSYNC')
      }
    },
    xFileSize(pFile, pSz) { try { wasm.poke64(pSz, BigInt(fs.fstatSync(files.get(pFile).fd).size)); return 0 } catch (e) { lastError = e; return RC('SQLITE_IOERR_FSTAT') } },
    xLock(pFile, lock) { files.get(pFile).lock = lock; return 0 },
    xUnlock(pFile, lock) { files.get(pFile).lock = lock; return 0 },
    xCheckReservedLock(pFile, pOut) { wasm.poke32(pOut, 0); return 0 },
    xFileControl() { return capi.SQLITE_NOTFOUND },
    xSectorSize() { return 4096 },
    xDeviceCharacteristics() { return 0 },
  }
  sqlite3.vfs.installVfs({ io: { struct: io, methods: ioMethods } })

  const vfs = new capi.sqlite3_vfs()
  vfs.$iVersion = 2
  vfs.$szOsFile = capi.sqlite3_file.structInfo.sizeof
  vfs.$mxPathname = 1024
  vfs.addOnDispose(vfs.$zName = wasm.allocCString(name))
  const dflt = new capi.sqlite3_vfs(capi.sqlite3_vfs_find(null))
  vfs.$xRandomness = dflt.$xRandomness
  vfs.$xSleep = dflt.$xSleep
  dflt.dispose()
  const vfsMethods = {
    xOpen(pVfs, zName, pFile, flags, pOutFlags) {
      try {
        let path
        if (zName && wasm.peek8(zName)) path = wasm.cstrToJs(zName)
        else { path = join(tempDir, `etilqs_${randomUUID()}`); flags |= capi.SQLITE_OPEN_DELETEONCLOSE }
        const exists = fs.existsSync(path)
        let mode
        if (flags & capi.SQLITE_OPEN_READONLY) mode = 'r'
        else if (exists) mode = 'r+'
        else if (flags & capi.SQLITE_OPEN_CREATE) mode = 'w+'
        else return capi.SQLITE_CANTOPEN
        const fd = fs.openSync(path, mode)
        files.set(pFile, { fd, path, flags, lock: 0 })
        stats.opened.push(path.split(/[\\/]/).pop())
        const f = new capi.sqlite3_file(pFile)
        f.$pMethods = io.pointer
        f.dispose()
        if (pOutFlags) wasm.poke32(pOutFlags, flags)
        return 0
      } catch (e) { lastError = e; return capi.SQLITE_CANTOPEN }
    },
    xDelete(pVfs, zName) {
      try { fs.unlinkSync(wasm.cstrToJs(zName)); return 0 } catch (e) { lastError = e; return e.code === 'ENOENT' ? RC('SQLITE_IOERR_DELETE_NOENT') : RC('SQLITE_IOERR_DELETE') }
    },
    xAccess(pVfs, zName, flags, pOut) {
      let ok = 0
      try { fs.accessSync(wasm.cstrToJs(zName), flags === capi.SQLITE_ACCESS_EXISTS ? fs.constants.F_OK : fs.constants.R_OK | fs.constants.W_OK); ok = 1 } catch { ok = 0 }
      wasm.poke32(pOut, ok)
      return 0
    },
    xFullPathname(pVfs, zName, nOut, pOut) {
      const bytes = enc.encode(resolvePath(wasm.cstrToJs(zName)))
      if (bytes.length + 1 > nOut) return capi.SQLITE_CANTOPEN
      const heap = wasm.heap8u(); const p = Number(pOut)
      heap.set(bytes, p); heap[p + bytes.length] = 0
      return 0
    },
    xGetLastError() { return 0 },
    xCurrentTime(pVfs, pOut) { wasm.poke(pOut, 2440587.5 + Date.now() / 86400000, 'double'); return 0 },
    xCurrentTimeInt64(pVfs, pOut) { wasm.poke(pOut, 2440587.5 * 86400000 + Date.now(), 'i64'); return 0 },
  }
  sqlite3.vfs.installVfs({ vfs: { struct: vfs, methods: vfsMethods } })
  return { name, stats, lastError: () => (lastError ? String(lastError.code || lastError.message) : null), openFiles: () => files.size }
}
