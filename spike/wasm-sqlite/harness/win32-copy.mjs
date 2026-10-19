// koffi wrapper around kernel32!CopyFileW — the stated precondition "DB files are first copied
// into the plugin dataDir with koffi". Pure Win32, never touches Node fs, so it can read the
// (outside-dataDir) source under --permission. Same koffi 3.1.0 as line-todo / the previous spike.
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const koffi = require('koffi')
const k32 = koffi.load('kernel32.dll')
const CopyFileW = k32.func('bool __stdcall CopyFileW(str16 lpExistingFileName, str16 lpNewFileName, bool bFailIfExists)')
const GetLastError = k32.func('uint32 __stdcall GetLastError()')
const GetFileAttributesW = k32.func('uint32 __stdcall GetFileAttributesW(str16 lpFileName)')
const INVALID_FILE_ATTRIBUTES = 0xffffffff

export const koffiVersion = koffi.version
export function koffiExists(p) { return GetFileAttributesW(p) !== INVALID_FILE_ATTRIBUTES }
// linedb.ts: for ext of ['', '-wal', '-shm'] if exists(src+ext) copy(src+ext, dst+ext)
export function koffiSnapshot(src, dst) {
  const copied = []
  for (const ext of ['', '-wal', '-shm']) {
    if (!koffiExists(src + ext)) continue
    if (!CopyFileW(src + ext, dst + ext, false)) return { ok: false, ext, lastError: GetLastError(), copied }
    copied.push(ext || '(edb)')
  }
  return { ok: true, copied }
}
