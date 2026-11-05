// The development link folder (dist/dev-link): the same plugin content as the packaged stage (lib/manifest.mjs + collectPackageFiles of build-plugin.mjs),
// written in place so that TeamUQ「從資料夾連結」can point at one fixed folder and pick up every rebuild.
// The manifest is the package manifest unchanged (id tuqdev.line-todo), so the folder matches the packaged stage byte for byte.
// No integrity.json / signature.json is written (the link is not a package).
// Pure file logic here; the build itself lives in build-dev-link.mjs.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './paths.mjs'

export const DEV_LINK_DIR = path.join(ROOT, 'dist', 'dev-link')
/** Remembers which files the last build wrote into DEV_LINK_DIR, so that only those (and only the ones no longer produced) are ever removed. Lives outside the folder. */
export const DEV_LINK_STATE = path.join(ROOT, 'dist', 'dev-link.state.json')
export const DEV_LINK_WORK = path.join(ROOT, 'dist', '.dev-link-work')

const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])
const FORBIDDEN_NAMES = new Set(['integrity.json', 'signature.json'])
const STATE_SCHEMA = 1

export class DevLinkLockedError extends Error {
  constructor(rel, cause) {
    super(
      `無法更新 ${rel}：這個檔案正被使用中（通常是外掛後端還在執行）。請先在 TeamUQ 停用或解除連結這個外掛，然後再重新執行建置。`,
      { cause },
    )
    this.name = 'DevLinkLockedError'
    this.rel = rel
  }
}

function assertSafeRelative(rel) {
  const ok = typeof rel === 'string' && rel.length > 0 && !rel.startsWith('/') && !rel.includes('\\') && !rel.includes(':') && rel.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
  if (!ok) throw new Error(`unsafe path in dev link output: ${JSON.stringify(rel)}`)
  if (FORBIDDEN_NAMES.has(rel.split('/').pop())) throw new Error(`${rel} must not be part of a dev link (a link is not a signed package)`)
}

/** The full output list of a dev link: manifest.json plus the package files, exactly as writeStage (build-plugin.mjs) lays them out. */
export function devLinkFiles({ manifest, files }) {
  const out = [{ path: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) }]
  for (const file of files) {
    assertSafeRelative(file.path)
    out.push({ path: file.path, data: Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data) })
  }
  return out
}

const toTarget = (dir, rel) => path.join(dir, ...rel.split('/'))

function isLockError(error) {
  return LOCK_CODES.has(error?.code)
}

function sameContent(target, data) {
  let stat
  try {
    stat = fs.statSync(target)
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  if (!stat.isFile()) throw new Error(`${target} exists and is not a regular file`)
  if (stat.size !== data.length) return false
  return fs.readFileSync(target).equals(data)
}

function readPrevious(stateFile, dir) {
  if (!fs.existsSync(stateFile)) return []
  let state
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  } catch {
    throw new Error(`${stateFile} is not readable JSON; delete it and rebuild (nothing will be removed from the folder in that run)`)
  }
  if (state?.schema !== STATE_SCHEMA || state.dir !== path.resolve(dir) || !Array.isArray(state.files)) return []
  return state.files.filter((rel) => {
    try {
      assertSafeRelative(rel)
      return true
    } catch {
      return false
    }
  })
}

function writeOrder(rels) {
  const rank = (rel) => (rel === 'manifest.json' ? 2 : rel.endsWith('.node') ? 0 : 1)
  return [...rels].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
}

function pruneEmptyParents(dir, target) {
  const root = path.resolve(dir)
  let current = path.dirname(target)
  while (path.resolve(current) !== root && path.resolve(current).startsWith(root + path.sep)) {
    if (fs.readdirSync(current).length > 0) break
    fs.rmdirSync(current)
    current = path.dirname(current)
  }
}

/**
 * Makes `dir` hold exactly `files` (plus whatever was there before that this build did not write):
 *   - `dir` itself is never removed or recreated; it is only created when missing;
 *   - a file is written only when its bytes differ (a `.node` that is unchanged is never opened for writing);
 *   - `.node` files are written first, so a locked native file stops the run before anything else changed; `manifest.json` is written last;
 *   - a file listed by the previous build and no longer produced is removed (then its empty folders); nothing else is ever deleted.
 * `write` is injectable for tests. Returns { dir, stateFile, written, unchanged, removed } (paths are relative, '/' separated).
 */
export function syncDevLink({ dir, stateFile, files, write = fs.writeFileSync }) {
  const wanted = new Map()
  for (const file of files) {
    assertSafeRelative(file.path)
    if (wanted.has(file.path)) throw new Error(`duplicate dev link output: ${file.path}`)
    wanted.set(file.path, file.data)
  }
  const previous = readPrevious(stateFile, dir)
  fs.mkdirSync(dir, { recursive: true })
  const report = { dir, stateFile, written: [], unchanged: [], removed: [] }

  for (const rel of writeOrder(wanted.keys())) {
    const target = toTarget(dir, rel)
    const data = wanted.get(rel)
    if (sameContent(target, data)) {
      report.unchanged.push(rel)
      continue
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    try {
      write(target, data)
    } catch (error) {
      if (isLockError(error) && rel.endsWith('.node')) throw new DevLinkLockedError(rel, error)
      throw error
    }
    report.written.push(rel)
  }

  for (const rel of previous) {
    if (wanted.has(rel)) continue
    const target = toTarget(dir, rel)
    if (!fs.existsSync(target)) continue
    try {
      fs.unlinkSync(target)
    } catch (error) {
      if (isLockError(error)) throw new DevLinkLockedError(rel, error)
      throw error
    }
    pruneEmptyParents(dir, target)
    report.removed.push(rel)
  }

  const state = { schema: STATE_SCHEMA, dir: path.resolve(dir), files: [...wanted.keys()].sort() }
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`)
  return report
}
