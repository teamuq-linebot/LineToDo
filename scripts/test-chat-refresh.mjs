import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { performance } from 'node:perf_hooks'
import { buildChatNameMap, createChatRefreshScheduler } from '../src/renderer/store/chatRefreshScheduler.ts'

const chats = [
  { chatId: 'one', name: '一對一', isGroup: false },
  { chatId: 'blocked', name: '封鎖群組', isGroup: true }
]

function fakeClock() {
  const queue = []
  return {
    schedule(callback) { queue.push(callback) },
    flush() { while (queue.length) queue.shift()() },
    get size() { return queue.length }
  }
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
}

test('同一事件迴圈的固定 burst 合併成一次並保持完整 chat map parity', async (t) => {
  const clock = fakeClock()
  const state = { map: {} }
  let calls = 0
  const list = async (includeBlocked) => {
    assert.equal(includeBlocked, true)
    calls += 1
    return chats
  }
  const baselineRefresh = async () => {
    state.map = buildChatNameMap(await list(true))
  }
  const beforeStart = performance.now()
  await Promise.all(Array.from({ length: 40 }, () => baselineRefresh()))
  const beforeElapsedMs = performance.now() - beforeStart
  calls = 0

  const scheduler = createChatRefreshScheduler(async (isActive) => {
    const result = await list(true)
    if (isActive()) state.map = buildChatNameMap(result)
  }, clock.schedule)
  const afterStart = performance.now()
  for (let index = 0; index < 40; index += 1) scheduler.request()
  assert.equal(calls, 0)
  clock.flush()
  await settle()
  const afterElapsedMs = performance.now() - afterStart

  assert.equal(calls, 1)
  assert.deepEqual(state.map, buildChatNameMap(chats))
  t.diagnostic(JSON.stringify({
    fixture: '40 events; 2 fake chat DTOs; list(true); disposable in-memory state',
    before: { calls: 40, elapsedMs: Number(beforeElapsedMs.toFixed(3)) },
    after: { calls, elapsedMs: Number(afterElapsedMs.toFixed(3)) },
    limit: 'synthetic call-count/timing only; no Electron, LINE source, DB, provider, or UI frame claim'
  }))
  scheduler.dispose()
})

test('events during an in-flight refresh schedule exactly one trailing refresh', async () => {
  const clock = fakeClock()
  const state = { map: {} }
  let calls = 0
  let releaseFirst
  const scheduler = createChatRefreshScheduler(async (isActive) => {
    calls += 1
    if (calls === 1) {
      await new Promise((resolve) => { releaseFirst = resolve })
      return
    }
    if (isActive()) state.map = buildChatNameMap(chats)
  }, clock.schedule)

  scheduler.request()
  clock.flush()
  assert.equal(calls, 1)
  for (let index = 0; index < 12; index += 1) scheduler.request()
  releaseFirst()
  await settle()
  assert.equal(clock.size, 1)
  clock.flush()
  await settle()
  assert.equal(calls, 2)
  assert.deepEqual(state.map, buildChatNameMap(chats))
  scheduler.dispose()
})

test('dispose cancels queued work and prevents in-flight state adoption', async () => {
  const clock = fakeClock()
  let calls = 0
  let release
  let stateWrites = 0
  const queued = createChatRefreshScheduler(async () => { calls += 1 }, clock.schedule)
  queued.request()
  queued.dispose()
  clock.flush()
  assert.equal(calls, 0)

  const running = createChatRefreshScheduler(async (isActive) => {
    await new Promise((resolve) => { release = resolve })
    if (isActive()) stateWrites += 1
  }, clock.schedule)
  running.request()
  clock.flush()
  running.dispose()
  release()
  await settle()
  assert.equal(stateWrites, 0)
})

test('a rejected refresh reports the error and a later event retries', async () => {
  const clock = fakeClock()
  const errors = []
  let calls = 0
  const scheduler = createChatRefreshScheduler(async () => {
    calls += 1
    if (calls === 1) throw new Error('fixture rejection')
  }, clock.schedule, (error) => errors.push(error.message))

  scheduler.request()
  clock.flush()
  await settle()
  assert.deepEqual(errors, ['fixture rejection'])
  scheduler.request()
  clock.flush()
  await settle()
  assert.equal(calls, 2)
  scheduler.dispose()
})

test('persisted-message chat refresh does not add a todo-list refresh', async () => {
  const source = await readFile(new URL('../src/renderer/store/useTodos.ts', import.meta.url), 'utf8')
  assert.match(source, /api\.db\.onMessagesPersisted\(chatRefresh\.request\)/)
  assert.match(source, /api\.db\.todos\.list\(/)
  assert.doesNotMatch(source, /onMessagesPersisted\(\(\)\s*=>\s*\{\s*void refresh\(/)
})
