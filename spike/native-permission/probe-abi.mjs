// Probe: which runtime are we in, and do the two native addons load here?
// Prints a JSON line so callers can capture it as evidence.
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const out = {
  runtime: {
    node: process.versions.node,
    electron: process.versions.electron ?? null,
    modules_abi: process.versions.modules,
    napi: process.versions.napi ?? null,
    v8: process.versions.v8,
  },
  koffi: { loaded: false },
  bsqlite: { loaded: false },
}

try {
  const koffi = require('koffi')
  out.koffi.loaded = true
  out.koffi.version = koffi.version ?? null
  // sanity: declare a trivial Win32 call to prove the FFI engine initialised
  const k32 = koffi.load('kernel32.dll')
  const GetCurrentProcessId = k32.func('uint32_t __stdcall GetCurrentProcessId()')
  out.koffi.GetCurrentProcessId = GetCurrentProcessId()
} catch (e) {
  out.koffi.error = { code: e.code ?? null, message: String(e.message).split('\n')[0] }
}

try {
  const Database = require('better-sqlite3-multiple-ciphers')
  const db = new Database(':memory:')
  out.bsqlite.loaded = true
  out.bsqlite.select1 = db.prepare('select 1 as x').get().x
  db.close()
} catch (e) {
  out.bsqlite.error = { code: e.code ?? null, message: String(e.message).split('\n')[0] }
}

console.log(JSON.stringify(out, null, 2))
