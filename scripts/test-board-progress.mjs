import test from 'node:test'
import assert from 'node:assert/strict'
import { createProgressFrameCoalescer } from '../src/renderer/components/Board/progressFrame.ts'

function fakeFrames() {
  let nextId = 1
  const callbacks = new Map()
  return {
    request(callback) {
      const id = nextId++
      callbacks.set(id, callback)
      return id
    },
    cancel(id) { callbacks.delete(id) },
    flush() {
      const pending = [...callbacks.values()]
      callbacks.clear()
      for (const callback of pending) callback()
    },
    get size() { return callbacks.size }
  }
}

test('progress events coalesce to the latest value in one animation frame', () => {
  const frames = fakeFrames()
  const published = []
  const listener = createProgressFrameCoalescer(frames.request, frames.cancel, (value) => published.push(value))
  listener.push({ processed: 1, total: 5, phase: 'extracting' })
  listener.push({ processed: 2, total: 5, phase: 'extracting' })
  listener.push({ processed: 5, total: 5, phase: 'done' })

  assert.equal(frames.size, 1)
  frames.flush()
  assert.deepEqual(published, [{ processed: 5, total: 5, phase: 'done' }])
  assert.equal(frames.size, 0)
})

test('disposing cancels queued work and ignores later events', () => {
  const frames = fakeFrames()
  const published = []
  const listener = createProgressFrameCoalescer(frames.request, frames.cancel, (value) => published.push(value))
  listener.push({ processed: 1, total: 5, phase: 'extracting' })
  listener.dispose()
  frames.flush()
  listener.push({ processed: 5, total: 5, phase: 'done' })

  assert.equal(frames.size, 0)
  assert.deepEqual(published, [])
})
