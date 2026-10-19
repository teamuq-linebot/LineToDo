// Which fd-based node:fs calls survive the 1.6.8 permission flags on Electron 44? (the WASM nodefs VFS
// needs read/write/truncate/fsync/fstat on fds of files inside dataDir). Writes evidence/fd-ops-e44.json.
// Usage: node scripts/probe-fd-ops.mjs
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildBackendPermissionFlags } from '../harness/teamuq-contract.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const E44 = 'C:/teamuq/teamuq-electron/node_modules/electron/dist/electron.exe'
const runRoot = mkdtempSync(join(tmpdir(), 'teamuq-appdb-fdops-'))
const dataDir = join(runRoot, 'data'); mkdirSync(dataDir)
const hostDir = join(runRoot, 'host'); mkdirSync(hostDir)
const child = join(hostDir, 'fd-ops-child.mjs')
writeFileSync(child, `
import * as fs from 'node:fs'
const dataDir = process.argv[2]
const f = dataDir + '/fd-probe.bin'
const R = { permission: !!process.permission }
const t = (k, fn) => { try { const v = fn(); R[k] = { ok: true, v: typeof v === 'object' && v ? (v.size ?? 'obj') : v } } catch (e) { R[k] = { ok: false, code: e.code, msg: String(e.message).slice(0, 120) } } }
let fd
t('openSync_w+', () => (fd = fs.openSync(f, 'w+'), 'fd'))
t('writeSync', () => fs.writeSync(fd, Buffer.from('hello world'), 0, 11, 0))
t('readSync', () => fs.readSync(fd, Buffer.alloc(5), 0, 5, 0))
t('fstatSync', () => fs.fstatSync(fd))
t('ftruncateSync', () => fs.ftruncateSync(fd, 5))
t('fsyncSync', () => fs.fsyncSync(fd))
t('fdatasyncSync', () => fs.fdatasyncSync(fd))
t('closeSync', () => fs.closeSync(fd))
t('statSync_path', () => fs.statSync(f))
t('truncateSync_path', () => fs.truncateSync(f, 2))
t('accessSync', () => fs.accessSync(f, fs.constants.R_OK | fs.constants.W_OK))
t('unlinkSync', () => fs.unlinkSync(f))
process.stdout.write(JSON.stringify(R))
`)
const flags = buildBackendPermissionFlags({ bootstrapFile: child, installDir: ROOT, dataDir, assetDirs: [], allowAddons: true })
const r = spawnSync(E44, [...flags, child, dataDir], { env: { ELECTRON_RUN_AS_NODE: '1', SystemRoot: process.env.SystemRoot, PATH: process.env.PATH }, encoding: 'utf8', timeout: 60000 })
const out = { electron: E44, flags, exitCode: r.status, result: (() => { try { return JSON.parse(r.stdout) } catch { return r.stdout } })(), stderr: (r.stderr || '').split('\n').filter((l) => l && !l.includes('PERM0001') && !l.includes('trace-warnings')) }
rmSync(runRoot, { recursive: true, force: true })
writeFileSync(join(ROOT, 'evidence', 'fd-ops-e44.json'), JSON.stringify(out, null, 2))
console.log(JSON.stringify(out.result, null, 1)); process.exit(r.status === 0 ? 0 : 1)
