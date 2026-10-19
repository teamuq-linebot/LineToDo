// Runs INSIDE the permissioned child (Electron run-as-node with --permission + --allow-fs-*
// [+ --allow-addons]). Reproduces the 1.6.8 backend boot self-check, then runs the native-addon
// vs node:fs experiments. Emits one JSON object on stdout (RESULT:<json>) for the launcher.
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { runPermissionSelfCheck } from './teamuq-contract.mjs'

const require = createRequire(import.meta.url)

function codeOf(e) { return e && typeof e.code === 'string' ? e.code : (e ? String(e.message).split('\n')[0] : 'unknown') }

// argv: [electron, script, <base64 init>, <base64 cfg>]
const init = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'))
const cfg = JSON.parse(Buffer.from(process.argv[3], 'base64url').toString('utf8'))

const result = {
  runtime: { node: process.versions.node, electron: process.versions.electron ?? null, modules_abi: process.versions.modules, napi: process.versions.napi ?? null },
  permissionActive: typeof process.permission === 'object',
  selfCheck: null,
  experiments: {},
}

// --- 1.6.8 boot self-check (authoritative gate) ---
result.selfCheck = runPermissionSelfCheck(init)

// --- control group (f): plain node:fs must be denied outside dataDir ---
const control = {}
try {
  const txt = fs.readFileSync(cfg.outsideReadFixture, 'utf8')
  control.nodeFsReadOutside = { ok: true, denied: false, bytes: txt.length }
} catch (e) {
  control.nodeFsReadOutside = { ok: false, denied: codeOf(e) === 'ERR_ACCESS_DENIED', code: codeOf(e) }
}
try {
  fs.writeFileSync(cfg.outsideWriteTarget + '.nodefs', 'should-be-denied')
  control.nodeFsWriteOutside = { ok: true, denied: false }
} catch (e) {
  control.nodeFsWriteOutside = { ok: false, denied: codeOf(e) === 'ERR_ACCESS_DENIED', code: codeOf(e) }
}
try {
  const inside = fs.readFileSync(cfg.insideDataFixture, 'utf8')
  control.nodeFsReadInsideDataDir = { ok: true, bytes: inside.length }
} catch (e) {
  control.nodeFsReadInsideDataDir = { ok: false, code: codeOf(e) }
}
// existsSync on an outside path: this is the exact call better-sqlite3's JS wrapper makes.
try {
  const ex = fs.existsSync(cfg.outsidePlainDb)
  control.nodeFsExistsSyncOutside = { threw: false, returned: ex }
} catch (e) {
  control.nodeFsExistsSyncOutside = { threw: true, code: codeOf(e) }
}
result.experiments.control_nodefs = control

// --- (a)+(b) koffi Win32 read/write outside dataDir ---
try {
  const { koffiReadFile, koffiWriteFile, koffiVersion } = await import('./win32-koffi.mjs')
  const read = koffiReadFile(cfg.outsideReadFixture)
  const write = koffiWriteFile(cfg.outsideWriteTarget, cfg.writePayload)
  const verify = koffiReadFile(cfg.outsideWriteTarget)
  result.experiments.koffi = {
    loaded: true, version: koffiVersion,
    read_outside: read,
    write_outside: write,
    write_verify_readback: verify,
  }
} catch (e) {
  result.experiments.koffi = { loaded: false, error: codeOf(e) }
}

// --- (c) better-sqlite3-multiple-ciphers open DB outside dataDir (+ cipher variant) ---
try {
  const Database = require('better-sqlite3-multiple-ciphers')
  const sq = { loaded: true }

  // plain synthetic DB, created outside dataDir by the launcher, opened readonly here
  try {
    const db = new Database(cfg.outsidePlainDb, { readonly: true, fileMustExist: true })
    const rows = db.prepare('select id, label from spike order by id').all()
    db.close()
    sq.open_plain_outside = { ok: true, rows }
  } catch (e) { sq.open_plain_outside = { ok: false, code: codeOf(e) } }

  // cipher variant: create + read an encrypted DB OUTSIDE dataDir (also proves native write bypass)
  try {
    const KEY = cfg.cipherKey
    const w = new Database(cfg.outsideCipherDb)
    w.pragma(`key='${KEY}'`)
    w.exec('create table secret(id integer primary key, v text)')
    w.prepare('insert into secret(id, v) values (?, ?)').run(1, 'cipher-ok')
    w.close()
    // reopen with correct key
    const r = new Database(cfg.outsideCipherDb, { fileMustExist: true })
    r.pragma(`key='${KEY}'`)
    const row = r.prepare('select v from secret where id=1').get()
    r.close()
    // confirm it is really encrypted: opening without key must fail to read
    let wrongKeyDenied = false
    try {
      const n = new Database(cfg.outsideCipherDb, { fileMustExist: true })
      n.prepare('select v from secret where id=1').get()
      n.close()
    } catch (e) { wrongKeyDenied = true; sq.cipher_nokey_error = codeOf(e) }
    sq.cipher_outside = { ok: true, readBack: row ? row.v : null, encryptedConfirmed: wrongKeyDenied }
  } catch (e) { sq.cipher_outside = { ok: false, code: codeOf(e) } }

  // Isolation probe: is the block purely better-sqlite3's JS-wrapper guard
  // (lib/database.js:64 `fs.existsSync(path.dirname(filename))`), or is the native SQLite file
  // open ALSO gated? Neutralise ONLY that one fs.existsSync guard, then retry the native open.
  try {
    const nodeFs = require('fs')
    const realExists = nodeFs.existsSync
    nodeFs.existsSync = () => true
    try {
      const db = new Database(cfg.outsidePlainDb, { readonly: true, fileMustExist: true })
      const rows = db.prepare('select id, label from spike order by id').all()
      db.close()
      sq.open_plain_outside_guard_neutralised = { ok: true, rows, note: 'native SQLite open bypassed the permission model once the JS fs.existsSync guard was removed' }
    } catch (e) {
      sq.open_plain_outside_guard_neutralised = { ok: false, code: codeOf(e) }
    } finally {
      nodeFs.existsSync = realExists
    }
  } catch (e) {
    sq.guard_probe_error = codeOf(e)
  }

  result.experiments.bsqlite = sq
} catch (e) {
  result.experiments.bsqlite = { loaded: false, error: codeOf(e) }
}

// --- (e) re-run the boot self-check AFTER the native addons are actually dlopen'd into this
// process, to prove loading them does not flip any isolation probe ---
result.selfCheckAfterAddons = runPermissionSelfCheck(init)

process.stdout.write('RESULT:' + JSON.stringify(result) + '\n')
