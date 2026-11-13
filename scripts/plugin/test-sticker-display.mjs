import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import pngjs from 'pngjs'
import { createPluginMedia } from '../../src/plugin/backend/media.ts'
import { createWin32LineFsPort } from '../../src/main/line/engine/native/win32fs.ts'

const { PNG } = pngjs
const evidenceRoot = join(process.cwd(), '.teamuq', 'evidence', 'local-sticker-display-20261112', 'scratch', 'developer', 'runtime-test-data')
mkdirSync(evidenceRoot, { recursive: true })

function tempDir(prefix) { return mkdtempSync(join(evidenceRoot, prefix)) }
function png(width = 2, height = 2) {
  const image = new PNG({ width, height })
  image.data.fill(255)
  return PNG.sync.write(image)
}
function dbFor(row) {
  const statements = []
  return {
    statements,
    prepare(sql) {
      statements.push(sql)
      assert.equal(sql, 'SELECT content_type, sticker_id, sticker_package_id FROM messages WHERE msg_id = ?')
      return { get(msgId) { assert.equal(msgId, 'i:639965811251347972'); return row } }
    }
  }
}
function mediaFor({ row, lookup, dataDir = tempDir('cache-') }) {
  const db = dbFor(row)
  const appCache = join(dataDir, 'sticker-cache')
  const stickerFs = {
    readUniqueChildDirectoryFile: lookup,
    readAppOwnedFile(root, directoryName, fileName, maxBytes) {
      const target = join(root, directoryName, fileName)
      try {
        const stat = lstatSync(target)
        if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) throw new Error('unsafe fake cache entry')
        return readFileSync(target)
      } catch (error) { if (error.code === 'ENOENT') return null; throw error }
    },
    writeAppOwnedFileAtomic(root, directoryName, fileName, bytes) {
      const dir = join(root, directoryName)
      mkdirSync(dir, { recursive: true })
      const temp = join(dir, `._test-${process.pid}.tmp`)
      writeFileSync(temp, bytes)
      renameSync(temp, join(dir, fileName))
    }
  }
  return {
    db,
    dataDir,
    appCache,
    media: createPluginMedia({ dataDir, getDb: () => db, decryptor: null, index: null, stickerRoot: 'C:\\LINE\\Data\\Sticker', stickerFs })
  }
}

test('CT7 private metadata resolves one static PNG, decodes it, and writes only a hashed app-owned asset', () => {
  const bytes = png(105, 120)
  let safeReads = 0
  const { media, db, dataDir } = mediaFor({
    row: { content_type: 7, sticker_id: '13', sticker_package_id: '1' },
    lookup: (root, pkg, file, maxBytes) => {
      safeReads += 1
      assert.equal(root, 'C:\\LINE\\Data\\Sticker')
      assert.equal(pkg, '1')
      assert.equal(file, '13.png')
      assert.equal(maxBytes, 1024 * 1024)
      return { matches: 1, bytes }
    }
  })
  const result = media.prepareSticker('i:639965811251347972')
  assert.equal(result.ok, true)
  assert.equal(result.mime, 'image/png')
  assert.equal(result.size, bytes.length)
  assert.equal(result.path, `sticker-cache/${createHash('sha256').update('i:639965811251347972').digest('hex')}.png`)
  assert.deepEqual(readFileSync(join(dataDir, result.path)), bytes)
  assert.equal(safeReads, 1)
  assert.equal(db.statements.length, 1)
  assert.equal(PNG.sync.read(readFileSync(join(dataDir, result.path))).width, 105)
  const repeated = media.prepareSticker('i:639965811251347972')
  assert.equal(repeated.ok, true)
  assert.equal(repeated.path, result.path, 'a repeated same-msgId prepare is idempotent and stays in the same opaque cache asset')
})

test('CT7 missing, invalid, ambiguous, malformed and over-limit candidates fail closed before asset creation', () => {
  const good = png()
  const cases = [
    { row: { content_type: 7, sticker_id: null, sticker_package_id: '1' }, matches: 1, bytes: good, expected: 'not_found' },
    { row: { content_type: 7, sticker_id: '../13', sticker_package_id: '1' }, matches: 1, bytes: good, expected: 'not_found' },
    { row: { content_type: 7, sticker_id: '13', sticker_package_id: '1' }, matches: 0, expected: 'not_found' },
    { row: { content_type: 7, sticker_id: '13', sticker_package_id: '1' }, matches: 2, bytes: good, expected: 'not_found' },
    { row: { content_type: 7, sticker_id: '13', sticker_package_id: '1' }, matches: 1, bytes: Buffer.from('not a png'), expected: 'unsupported_format' },
    { row: { content_type: 7, sticker_id: '13', sticker_package_id: '1' }, matches: 1, bytes: png(2049, 1), expected: 'unsupported_format' },
    { row: { content_type: 7, sticker_id: '13', sticker_package_id: '1' }, matches: 1, bytes: Buffer.alloc(1024 * 1024 + 1), expected: 'unsupported_format' },
    { row: { content_type: 1, sticker_id: '13', sticker_package_id: '1' }, matches: 1, bytes: good, expected: 'not_found' }
  ]
  for (const item of cases) {
    let safeReads = 0
    const { media, dataDir } = mediaFor({ row: item.row, lookup: () => { safeReads += 1; return { matches: item.matches, bytes: item.bytes } } })
    const result = media.prepareSticker('i:639965811251347972')
    assert.equal(result.ok, false)
    assert.equal(result.code, item.expected)
    assert.equal(safeReads, item.row.content_type === 7 && item.row.sticker_id === '13' ? 1 : 0)
    assert.equal(existsSync(join(dataDir, 'sticker-cache')), false)
  }
  const unavailable = createPluginMedia({ dataDir: tempDir('unavailable-'), getDb: () => dbFor({ content_type: 7, sticker_id: '13', sticker_package_id: '1' }), decryptor: null, index: null })
  assert.equal(unavailable.prepareSticker('i:639965811251347972').code, 'media_unavailable')
})

test('native safe reader decodes the traced real LINE PNG and enforces bounded uniqueness and source reparse rejection in scratch fixtures', (t) => {
  const workspace = tempDir('native-workspace-')
  const port = createWin32LineFsPort({ workspaceRoot: join(workspace, 'work') })
  const actual = port.readUniqueChildDirectoryFile(
    'C:\\Users\\david\\AppData\\Local\\LINE\\Data\\Sticker', '1', '13.png', 1024 * 1024
  )
  assert.equal(actual.matches, 1)
  assert.ok(actual.bytes)
  assert.equal(createHash('sha256').update(actual.bytes).digest('hex'), 'b0d58da6ff56e735d143c4312cc73a4ccf2d8068d2fbba3800224469ee2f4c56')
  assert.deepEqual([PNG.sync.read(actual.bytes).width, PNG.sync.read(actual.bytes).height], [105, 120])

  const root = join(workspace, 'Sticker')
  const packageDir = join(root, '1')
  mkdirSync(join(packageDir, '100'), { recursive: true })
  mkdirSync(join(packageDir, '101'), { recursive: true })
  writeFileSync(join(packageDir, '100', '13.png'), png())
  writeFileSync(join(packageDir, '101', '13.png'), png())
  const outsidePackage = join(workspace, 'outside-package')
  mkdirSync(join(outsidePackage, '999'), { recursive: true })
  writeFileSync(join(outsidePackage, '999', '13.png'), png())
  const originalReadDirBoundedHandle = port.readDirBoundedHandle.bind(port)
  const movedPackage = `${packageDir}-replaced`
  let moved = false
  let packageRenameBlocked = false
  let redirected = false
  let observedNames = []
  port.readDirBoundedHandle = (directoryHandle, directory, cap) => {
    try { renameSync(packageDir, movedPackage); moved = true } catch { packageRenameBlocked = true }
    if (moved) {
      try { symlinkSync(outsidePackage, packageDir, 'junction'); redirected = true }
      catch { renameSync(movedPackage, packageDir); moved = false }
    }
    const entries = originalReadDirBoundedHandle(directoryHandle, directory, cap)
    observedNames = entries.map((entry) => entry.name).sort()
    return entries
  }
  try {
    if (redirected) assert.throws(() => port.readUniqueChildDirectoryFile(root, '1', '13.png', 1024 * 1024), /sticker path escaped root/)
    else assert.deepEqual(port.readUniqueChildDirectoryFile(root, '1', '13.png', 1024 * 1024), { matches: 2 })
  } finally {
    port.readDirBoundedHandle = originalReadDirBoundedHandle
    if (redirected) unlinkSync(packageDir)
    if (moved) renameSync(movedPackage, packageDir)
  }
  assert.equal(packageRenameBlocked || redirected, true, 'the race probe either confirms the checked identity lock or replaces the path before handle-relative enumeration')
  assert.deepEqual(observedNames, ['100', '101'], 'enumeration through the checked handle sees original entries even when the path alias is replaced')

  const wideRoot = join(workspace, 'WideSticker')
  mkdirSync(join(wideRoot, '1'), { recursive: true })
  for (let index = 0; index < 257; index += 1) mkdirSync(join(wideRoot, '1', String(index)))
  assert.throws(() => port.readUniqueChildDirectoryFile(wideRoot, '1', '13.png', 1024 * 1024), /entry cap exceeded/)

  const outside = join(workspace, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, '13.png'), png())
  const reparseRoot = join(workspace, 'ReparseSticker')
  mkdirSync(join(reparseRoot, '1'), { recursive: true })
  let linked = false
  try { symlinkSync(outside, join(reparseRoot, '1', '100'), 'junction'); linked = true } catch (error) {
    t.diagnostic(`junction fixture unavailable in this Windows account: ${error.code ?? error.name}`)
  }
  if (linked) assert.throws(() => port.readUniqueChildDirectoryFile(reparseRoot, '1', '13.png', 1024 * 1024), /unsafe sticker (?:path component|reparse entry)/)
})

test('native app cache uses handle-contained atomic create/read/replace and rejects cache-root or target reparse paths', (t) => {
  const workspace = tempDir('native-app-cache-')
  const port = createWin32LineFsPort({ workspaceRoot: join(workspace, 'work') })
  const dataDir = join(workspace, 'data')
  const cacheDir = join(dataDir, 'sticker-cache')
  const name = `${'c'.repeat(64)}.png`
  mkdirSync(cacheDir, { recursive: true })
  const first = png(2, 2)
  const second = png(3, 2)
  const staleTemp = join(cacheDir, `._sticker-${'a'.repeat(32)}.tmp`)
  writeFileSync(staleTemp, Buffer.alloc(512, 0xa5))
  port.writeAppOwnedFileAtomic(dataDir, 'sticker-cache', name, first)
  assert.equal(existsSync(staleTemp), false, 'a stale app-owned regular temp is reclaimed before cache quota/listing')
  assert.deepEqual(port.readAppOwnedFile(dataDir, 'sticker-cache', name, 1024 * 1024), first)
  port.writeAppOwnedFileAtomic(dataDir, 'sticker-cache', name, second)
  assert.deepEqual(port.readAppOwnedFile(dataDir, 'sticker-cache', name, 1024 * 1024), second, 'replace is atomic relative to the checked directory handle')
  assert.deepEqual(readdirSync(cacheDir), [name], 'temporary file was renamed or removed')

  const api = port.api
  const moveFileEx = api.MoveFileExW
  const getLastError = api.GetLastError
  api.MoveFileExW = () => false
  api.GetLastError = () => 5
  assert.throws(() => port.writeAppOwnedFileAtomic(dataDir, 'sticker-cache', name, first), /MoveFileExW failed/)
  api.MoveFileExW = moveFileEx
  api.GetLastError = getLastError
  assert.deepEqual(readdirSync(cacheDir), [name], 'a failed atomic commit deletes its temporary through the open file handle')

  const outside = join(workspace, 'outside')
  mkdirSync(outside)
  const outsideFile = join(outside, name)
  writeFileSync(outsideFile, first)
  const rootLink = join(workspace, 'data-root-link')
  let rootLinked = false
  try { symlinkSync(dataDir, rootLink, 'junction'); rootLinked = true } catch (error) {
    t.diagnostic(`dataDir junction fixture unavailable in this Windows account: ${error.code ?? error.name}`)
  }
  if (rootLinked) {
    assert.throws(() => port.readAppOwnedFile(rootLink, 'sticker-cache', name, 1024 * 1024), /unsafe app asset path component/)
    assert.throws(() => port.writeAppOwnedFileAtomic(rootLink, 'sticker-cache', name, second), /unsafe app asset path component/)
    assert.deepEqual(readFileSync(join(cacheDir, name)), second, 'a dataDir junction receives no redirected read/write')
  }
  let directoryLink = false
  try { symlinkSync(outside, join(dataDir, 'cache-link'), 'junction'); directoryLink = true } catch (error) {
    t.diagnostic(`cache junction fixture unavailable in this Windows account: ${error.code ?? error.name}`)
  }
  if (directoryLink) {
    assert.throws(() => port.readAppOwnedFile(dataDir, 'cache-link', name, 1024 * 1024), /unsafe app asset path component/)
    assert.throws(() => port.writeAppOwnedFileAtomic(dataDir, 'cache-link', name, second), /unsafe app asset path component/)
    assert.deepEqual(readFileSync(outsideFile), first, 'a cache-root junction receives no writes')
  }

  const targetLink = join(cacheDir, `${'d'.repeat(64)}.png`)
  let fileLink = false
  try { symlinkSync(outsideFile, targetLink, 'file'); fileLink = true } catch (error) {
    t.diagnostic(`cache target symlink fixture unavailable in this Windows account: ${error.code ?? error.name}`)
  }
  if (fileLink) {
    assert.throws(() => port.readAppOwnedFile(dataDir, 'sticker-cache', `${'d'.repeat(64)}.png`, 1024 * 1024), /unsafe app asset path component/)
    assert.throws(() => port.writeAppOwnedFileAtomic(dataDir, 'sticker-cache', `${'d'.repeat(64)}.png`, second), /unsafe app asset path component/)
    assert.deepEqual(readFileSync(outsideFile), first, 'an existing target symlink is neither read through nor replaced with external content')
  }

  // Every wildcard match, including malformed temp names, must consume the
  // bounded maintenance budget before validation can skip it.
  const malformedDataDir = join(workspace, 'malformed-data')
  const malformedCache = join(malformedDataDir, 'sticker-cache')
  mkdirSync(malformedCache, { recursive: true })
  for (let index = 0; index < 257; index += 1) writeFileSync(join(malformedCache, `._sticker-malformed-${index}.tmp`), Buffer.alloc(0))
  assert.throws(() => port.writeAppOwnedFileAtomic(malformedDataDir, 'sticker-cache', name, first), /stale-temp entry cap exceeded/)
  assert.equal(readdirSync(malformedCache).filter((entry) => entry.startsWith('._sticker-malformed-')).length, 257, 'malformed app cache entries are not deleted during fail-closed maintenance')
})
