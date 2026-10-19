// Standalone smoke test (no permission flags): prove the koffi Win32 read/write wrapper works.
import { koffiReadFile, koffiWriteFile } from './win32-koffi.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const target = join(tmpdir(), `koffi-smoke-${process.pid}.txt`)
const w = koffiWriteFile(target, 'hello-from-koffi')
const r = koffiReadFile(target)
console.log(JSON.stringify({ target, write: w, read: r }, null, 2))
