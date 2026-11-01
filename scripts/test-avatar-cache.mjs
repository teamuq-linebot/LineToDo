import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { createAvatarCache } from '../src/plugin/backend/avatarCache.ts'

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 0xff, 0xd9])
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
async function fixture(t) {
  void t
  const dataDir = 'isolated-plugin-data'
  const files = new Map()
  const modified = new Map()
  const fs = {
    async mkdir() {},
    async writeFile(path, data, { flag }) {
      if (flag === 'wx' && files.has(path)) throw new Error('EEXIST')
      files.set(path, Uint8Array.from(data))
      modified.set(path, Date.now())
    },
    async readFile(path) { if (!files.has(path)) throw new Error('ENOENT'); return Uint8Array.from(files.get(path)) },
    async readdir(path) {
      const prefix = path + '\\'
      return [...files.keys()].filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length)).filter((name) => !name.includes('\\'))
    },
    async stat(path) {
      const data = files.get(path)
      if (!data) throw new Error('ENOENT')
      return { size: data.length, mtimeMs: modified.get(path), isFile: () => true }
    },
    async rename(from, to) { if (!files.has(from)) throw new Error('ENOENT'); files.set(to, files.get(from)); modified.set(to, Date.now()); files.delete(from); modified.delete(from) },
    async unlink(path) { if (!files.delete(path)) throw new Error('ENOENT'); modified.delete(path) },
    async utimes(path, _atime, mtime) { if (!files.has(path)) throw new Error('ENOENT'); modified.set(path, mtime.getTime()) }
  }
  return { dataDir, fs, files }
}

function response(bytes, { status = 200, type = 'image/jpeg', url = 'https://profile.line-scdn.net/abc' } = {}) {
  return new Response(bytes, { status, headers: { 'content-type': type } , url })
}

test('cold fetch creates opaque asset; warm read and service restart reuse it; locator changes select new asset', async (t) => {
  const { dataDir, fs } = await fixture(t)
  let calls = 0
  const fetchImpl = async (_url, init) => { calls += 1; assert.equal(init.redirect, 'manual'); return response(JPEG) }
  const input = { identity: 'real-line-id', locator: '/abc' }
  const first = await createAvatarCache({ dataDir, fs, fetchImpl }).get(input)
  assert.deepEqual({ mime: first.mime, size: first.size, cached: first.cached }, { mime: 'image/jpeg', size: JPEG.length, cached: false })
  assert.match(first.path, /^avatar-cache\/[a-f0-9]{64}\.jpg$/u)
  assert.doesNotMatch(first.path, /real-line-id|abc/u)
  assert.deepEqual(await fs.readFile(join(dataDir, first.path)), JPEG)
  const warm = await createAvatarCache({ dataDir, fs, fetchImpl }).get(input)
  assert.equal(warm.path, first.path)
  assert.equal(warm.cached, true)
  assert.equal(calls, 1)
  const updated = await createAvatarCache({ dataDir, fs, fetchImpl: async () => { calls += 1; return response(PNG, { type: 'image/png', url: 'https://profile.line-scdn.net/def' }) } }).get({ ...input, locator: '/def' })
  assert.notEqual(updated.path, first.path)
  assert.equal(updated.mime, 'image/png')
  assert.equal(calls, 2)
})

test('same-length damaged cache bytes are discarded and refetched before reuse', async (t) => {
  const { dataDir, fs, files } = await fixture(t)
  let calls = 0
  const fetchImpl = async () => { calls += 1; return response(JPEG) }
  const input = { identity: 'square-member', locator: 'https://obs.line-scdn.net/0hExample_token' }
  const cold = await createAvatarCache({ dataDir, fs, fetchImpl }).get(input)
  const asset = join(dataDir, cold.path)
  const damaged = Uint8Array.from(files.get(asset))
  damaged.fill(0, 2, damaged.length - 2)
  files.set(asset, damaged)
  const repaired = await createAvatarCache({ dataDir, fs, fetchImpl }).get(input)
  assert.equal(repaired.cached, false, 'corrupted bytes are not returned as a warm hit')
  assert.equal(calls, 2, 'damaged persisted bytes are refetched')
  assert.deepEqual(await fs.readFile(asset), JPEG)
})

test('rejects unsafe hosts, URL tricks, traversal, and redirects without writing', async (t) => {
  const { dataDir, fs } = await fixture(t)
  let calls = 0
  const cache = createAvatarCache({ dataDir, fs, fetchImpl: async (_url, init) => { calls += 1; assert.equal(init.redirect, 'manual'); return new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } }) } })
  for (const locator of [
    'https://evil.example/x', 'http://profile.line-scdn.net/x', '//evil.example/x',
    'https://user:pass@profile.line-scdn.net/x', 'https://profile.line-scdn.net:444/x', 'a'.repeat(64),
    '/../../x', '/%2e%2e/x', '/a%2fb', '/a%5cb', '/x#fragment', '/a\\b', '/a\nheader',
    'https://profile.line-scdn.net/a/../safe', 'https://obs.line-scdn.net/not-an-avatar',
    'https://obs.line-scdn.net/0hValidToken?query=blocked', 'https://obs.evil.example/0hValidToken'
  ]) assert.equal(await cache.get({ identity: 'id', locator }), null, locator)
  assert.equal(calls, 0)
  assert.equal(await cache.get({ identity: 'id', locator: '/abc' }), null)
  assert.equal(calls, 1)
  assert.deepEqual(await fs.readdir(join(dataDir, 'avatar-cache')).catch(() => []), [])
  const mismatch = createAvatarCache({ dataDir, fs, fetchImpl: async () => ({
    ok: true, status: 200, url: 'https://evil.example/redirected',
    headers: { get: () => 'image/jpeg' }, body: null,
    arrayBuffer: async () => JPEG.slice().buffer
  }) })
  assert.equal(await mismatch.get({ identity: 'id-2', locator: '/abc' }), null, 'response URL must remain at requested official origin and path')
  assert.deepEqual(await fs.readdir(join(dataDir, 'avatar-cache')).catch(() => []), [])
})

test('accepts only the verified OpenChat OBS origin and observed hash path shape', async (t) => {
  const { dataDir, fs } = await fixture(t)
  let requested = ''
  const cache = createAvatarCache({ dataDir, fs, fetchImpl: async (url) => {
    requested = url
    return response(JPEG, { url: 'https://obs.line-scdn.net/0hHash_token-1' })
  } })
  const result = await cache.get({ identity: 'square-chat-id', locator: 'https://obs.line-scdn.net/0hHash_token-1' })
  assert.equal(requested, 'https://obs.line-scdn.net/0hHash_token-1')
  assert.equal(result.mime, 'image/jpeg')
  assert.match(result.path, /^avatar-cache\/[a-f0-9]{64}\.jpg$/u)
  assert.doesNotMatch(result.path, /square-chat-id|Hash_token/u)
})

test('rejects non-image, MIME/signature mismatch, and over-limit bodies; backs off failures', async (t) => {
  const { dataDir, fs } = await fixture(t)
  let calls = 0
  let clock = 100
  let fetchImpl = async () => { calls += 1; return response(new TextEncoder().encode('<html>'), { type: 'text/html' }) }
  const cache = createAvatarCache({ dataDir, fs, fetchImpl, maxImageBytes: 8, failureBackoffMs: 500, now: () => clock })
  assert.equal(await cache.get({ identity: 'id', locator: '/bad' }), null)
  assert.equal(await cache.get({ identity: 'id', locator: '/bad' }), null)
  assert.equal(calls, 1)
  clock += 501
  fetchImpl = async () => { calls += 1; return response(JPEG) }
  assert.equal(await cache.get({ identity: 'id', locator: '/bad' }), null, 'oversize body is rejected')
  assert.equal(calls, 2)
  assert.deepEqual(await fs.readdir(join(dataDir, 'avatar-cache')).catch(() => []), [])
})

test('single-flights same key, bounds concurrent distinct downloads, and enforces disk/entry budgets', async (t) => {
  const { dataDir, fs } = await fixture(t)
  let active = 0
  let peak = 0
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 15))
    active -= 1
    return response(JPEG)
  }
  const cache = createAvatarCache({ dataDir, fs, fetchImpl, maxConcurrent: 2, maxEntries: 2, maxCacheBytes: 160 })
  const same = await Promise.all(Array.from({ length: 8 }, () => cache.get({ identity: 'same', locator: '/same' })))
  assert.equal(calls, 1)
  assert.ok(same.every((r) => r.path === same[0].path))
  await Promise.all([1, 2, 3, 4].map((n) => cache.get({ identity: `id-${n}`, locator: `/u-${n}` })))
  assert.ok(peak <= 2)
  const names = (await fs.readdir(join(dataDir, 'avatar-cache'))).filter((name) => /^[a-f0-9]{64}\.(?:jpg|png|webp)$/u.test(name))
  assert.ok(names.length <= 2, `entries=${names.length}`)
  const sizes = await Promise.all(names.map(async (name) => {
    const file = join(dataDir, 'avatar-cache', name)
    return (await fs.stat(file)).size + (await fs.stat(`${file}.sha256`)).size
  }))
  assert.ok(sizes.reduce((a, b) => a + b, 0) <= 160)
})
