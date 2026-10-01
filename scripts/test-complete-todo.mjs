import test from 'node:test'
import assert from 'node:assert/strict'
import { createCompleteTodoRegistry, runCompleteTodo } from '../src/renderer/store/completeTodo.ts'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test('completion announces persisted state before a slow board refresh', async () => {
  const refresh = deferred()
  const events = []
  const resultPromise = runCompleteTodo(
    async () => { events.push('write-confirmed'); return true },
    () => refresh.promise,
    () => events.push('refresh-started')
  )

  await Promise.resolve()
  assert.deepEqual(events, ['write-confirmed', 'refresh-started'])
  refresh.resolve()
  assert.deepEqual(await resultPromise, { write: 'confirmed', refresh: 'confirmed' })
})

test('a failed write never runs refresh or reports persistence success', async () => {
  let refreshed = false
  const result = await runCompleteTodo(
    async () => { throw new Error('main unavailable') },
    async () => { refreshed = true }
  )

  assert.deepEqual(result, { write: 'failed', refresh: 'not-run', error: 'main unavailable' })
  assert.equal(refreshed, false)
})

test('a refresh failure keeps confirmed write separate and can be retried by the caller', async () => {
  let confirmed = false
  const result = await runCompleteTodo(
    async () => true,
    async () => { throw new Error('list timeout') },
    () => { confirmed = true }
  )

  assert.equal(confirmed, true)
  assert.deepEqual(result, { write: 'confirmed', refresh: 'failed', error: 'list timeout' })
})

test('same TODO pending write survives card unsubscribe/remount and suppresses duplicate write', async () => {
  const registry = createCompleteTodoRegistry()
  const write = deferred()
  const refresh = deferred()
  let updateStatusCalls = 0
  const firstWrite = () => { updateStatusCalls += 1; return write.promise }
  const firstRefresh = () => refresh.promise

  const firstCardRun = registry.run('todo-1', firstWrite, firstRefresh)
  const firstCardListener = () => {}
  const unsubscribeFirstCard = registry.subscribe('todo-1', firstCardListener)
  assert.deepEqual(registry.getSnapshot('todo-1'), { phase: 'writing' })
  unsubscribeFirstCard()

  // Filtering unmounts the card. Its replacement reads the same owner snapshot.
  const secondCardListener = () => {}
  const unsubscribeSecondCard = registry.subscribe('todo-1', secondCardListener)
  assert.deepEqual(registry.getSnapshot('todo-1'), { phase: 'writing' })
  registry.reconcileAfterRefresh()
  assert.deepEqual(registry.getSnapshot('todo-1'), { phase: 'writing' })
  const remountedCardRun = registry.run(
    'todo-1',
    async () => { updateStatusCalls += 1; return true },
    async () => {}
  )
  assert.strictEqual(remountedCardRun, firstCardRun)
  assert.equal(updateStatusCalls, 1)

  write.resolve(true)
  await Promise.resolve()
  assert.deepEqual(registry.getSnapshot('todo-1'), { phase: 'refreshing' })
  refresh.resolve()
  assert.deepEqual(await firstCardRun, { write: 'confirmed', refresh: 'confirmed' })
  assert.equal(updateStatusCalls, 1)
  assert.equal(registry.getSnapshot('todo-1'), null)
  unsubscribeSecondCard()
})

test('confirmed write with refresh error retries refresh only after card remount', async () => {
  const registry = createCompleteTodoRegistry()
  let updateStatusCalls = 0
  let listCalls = 0
  const firstResult = await registry.run(
    'todo-2',
    async () => { updateStatusCalls += 1; return true },
    async () => { listCalls += 1; throw new Error('list timeout') }
  )

  assert.deepEqual(firstResult, { write: 'confirmed', refresh: 'failed', error: 'list timeout' })
  assert.deepEqual(registry.getSnapshot('todo-2'), { phase: 'refresh-error', message: 'list timeout' })

  // A remounted card's main completion action must reuse the confirmed-write record.
  const retryResult = await registry.run(
    'todo-2',
    async () => { updateStatusCalls += 1; return true },
    async () => { listCalls += 1 }
  )
  assert.deepEqual(retryResult, { write: 'confirmed', refresh: 'confirmed' })
  assert.equal(updateStatusCalls, 1)
  assert.equal(listCalls, 2)
  assert.equal(registry.getSnapshot('todo-2'), null)
})

test('successful refresh clears terminal operation state so a later legal completion can write again', async () => {
  const registry = createCompleteTodoRegistry()
  let updateStatusCalls = 0
  const write = async () => { updateStatusCalls += 1; return true }
  const refresh = async () => {}

  assert.deepEqual(await registry.run('todo-3', write, refresh), {
    write: 'confirmed', refresh: 'confirmed'
  })
  assert.equal(registry.getSnapshot('todo-3'), null)

  // Models a later completion after the successful lifecycle has converged
  // (for example, the TODO was reopened through the existing status action).
  assert.deepEqual(await registry.run('todo-3', write, refresh), {
    write: 'confirmed', refresh: 'confirmed'
  })
  assert.equal(updateStatusCalls, 2)
  assert.equal(registry.getSnapshot('todo-3'), null)
})

test('a later successful board refresh clears settled error state after another status action', async () => {
  const registry = createCompleteTodoRegistry()
  let updateStatusCalls = 0
  const failedRefreshResult = await registry.run(
    'todo-4',
    async () => { updateStatusCalls += 1; return true },
    async () => { throw new Error('first list timeout') }
  )
  assert.equal(failedRefreshResult.write, 'confirmed')
  assert.deepEqual(registry.getSnapshot('todo-4'), { phase: 'refresh-error', message: 'first list timeout' })

  // useTodos calls this after any later successful read (including a reopen or
  // other status mutation), so stale completion-error state cannot fence a
  // future, legitimate completion of the same TODO.
  registry.reconcileAfterRefresh()
  assert.equal(registry.getSnapshot('todo-4'), null)
  assert.deepEqual(await registry.run(
    'todo-4',
    async () => { updateStatusCalls += 1; return true },
    async () => {}
  ), { write: 'confirmed', refresh: 'confirmed' })
  assert.equal(updateStatusCalls, 2)
})
