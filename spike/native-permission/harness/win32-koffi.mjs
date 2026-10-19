// koffi wrapper around Win32 file APIs (CreateFileW / ReadFile / WriteFile / CloseHandle).
// These are pure Win32 calls that never touch the Node fs layer, so the Node permission
// model (--permission / --allow-fs-*) cannot see or deny them.
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const koffi = require('koffi')

const k32 = koffi.load('kernel32.dll')

const GENERIC_READ = 0x80000000
const GENERIC_WRITE = 0x40000000
const FILE_SHARE_READ = 0x1
const OPEN_EXISTING = 3
const CREATE_ALWAYS = 2
const FILE_ATTRIBUTE_NORMAL = 0x80

const CreateFileW = k32.func('void* __stdcall CreateFileW(str16 lpFileName, uint32 dwDesiredAccess, uint32 dwShareMode, void* lpSecurityAttributes, uint32 dwCreationDisposition, uint32 dwFlagsAndAttributes, void* hTemplateFile)')
const ReadFile = k32.func('bool __stdcall ReadFile(void* hFile, _Out_ uint8_t* lpBuffer, uint32 nNumberOfBytesToRead, _Out_ uint32* lpNumberOfBytesRead, void* lpOverlapped)')
const WriteFile = k32.func('bool __stdcall WriteFile(void* hFile, uint8_t* lpBuffer, uint32 nNumberOfBytesToWrite, _Out_ uint32* lpNumberOfBytesWritten, void* lpOverlapped)')
const CloseHandle = k32.func('bool __stdcall CloseHandle(void* hObject)')
const GetLastError = k32.func('uint32 __stdcall GetLastError()')

const INVALID = 0xffffffffffffffffn

function isInvalid(handle) {
  if (handle === null) return true
  const addr = koffi.address(handle)
  return addr === 0n || addr === INVALID
}

export function koffiReadFile(filePath, maxBytes = 4096) {
  const h = CreateFileW(filePath, GENERIC_READ, FILE_SHARE_READ, null, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, null)
  if (isInvalid(h)) return { ok: false, lastError: GetLastError() }
  try {
    const buf = Buffer.alloc(maxBytes)
    const read = [0]
    const ok = ReadFile(h, buf, maxBytes, read, null)
    if (!ok) return { ok: false, lastError: GetLastError() }
    return { ok: true, bytesRead: read[0], text: buf.toString('utf8', 0, read[0]) }
  } finally {
    CloseHandle(h)
  }
}

export function koffiWriteFile(filePath, text) {
  const h = CreateFileW(filePath, GENERIC_WRITE, 0, null, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, null)
  if (isInvalid(h)) return { ok: false, lastError: GetLastError() }
  try {
    const buf = Buffer.from(text, 'utf8')
    const written = [0]
    const ok = WriteFile(h, buf, buf.length, written, null)
    if (!ok) return { ok: false, lastError: GetLastError() }
    return { ok: true, bytesWritten: written[0] }
  } finally {
    CloseHandle(h)
  }
}

export const koffiVersion = koffi.version
