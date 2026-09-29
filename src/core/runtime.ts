import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import type { LineTodoApi } from '../shared/api'

export const DATA_DIRECTORY_IN_USE = 'DATA_DIRECTORY_IN_USE'

export interface LineTodoHostPorts {
  dataDir: string
  api?: LineTodoApi
  start?(): Promise<void>
  stop?(): Promise<void>
  dispose?(): Promise<void>
  initialize?(): Promise<Pick<LineTodoRuntime, 'api' | 'start' | 'stop' | 'dispose'>>
}

export interface LineTodoRuntime {
  readonly api: LineTodoApi
  start(): Promise<void>
  stop(): Promise<void>
  dispose(): Promise<void>
}

interface LockRecord {
  pid: number
  hostname: string
  startedAt: string
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function acquireOwnerLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true })
  const path = join(resolve(dataDir), '.line-todo-owner.lock')
  const record: LockRecord = { pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx')
      try {
        writeFileSync(fd, JSON.stringify(record), 'utf8')
      } finally {
        closeSync(fd)
      }
      return () => {
        try {
          const existing = JSON.parse(readFileSync(path, 'utf8')) as LockRecord
          if (existing.pid === record.pid && existing.startedAt === record.startedAt) unlinkSync(path)
        } catch {
          // Another owner or operator changed the lock; never delete an unowned lock.
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (!existsSync(path)) continue
      try {
        const owner = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockRecord>
        // A lock from another machine or malformed lock is ambiguous and fails closed.
        if (owner.hostname !== hostname() || !Number.isInteger(owner.pid) || (owner.pid as number) > 0 && processIsAlive(owner.pid as number)) {
          throw Object.assign(new Error(`Line Todo data directory already has an owner (${String(owner.pid ?? 'unknown')})`), { code: DATA_DIRECTORY_IN_USE })
        }
        unlinkSync(path)
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === DATA_DIRECTORY_IN_USE) throw readError
        throw Object.assign(new Error('Line Todo owner lock is unreadable; refusing to take ownership'), { code: DATA_DIRECTORY_IN_USE })
      }
    }
  }
  throw Object.assign(new Error('Line Todo data directory owner lock is contended'), { code: DATA_DIRECTORY_IN_USE })
}

type State = 'created' | 'running' | 'stopped' | 'disposed'
const SUBSCRIPTION_METHODS = new Set(['onMessage', 'onStatus', 'onMessagesPersisted', 'onRun', 'onTodosChanged', 'onBackfillProgress', 'onReconcileProgress'])

export async function createLineTodoRuntime(ports: LineTodoHostPorts): Promise<LineTodoRuntime> {
  const releaseLock = acquireOwnerLock(ports.dataDir)
  let application: Pick<LineTodoRuntime, 'api' | 'start' | 'stop' | 'dispose'> | undefined
  try { application = await ports.initialize?.() } catch (error) { releaseLock(); throw error }
  const api = application?.api ?? ports.api
  const startHost = application?.start ?? ports.start
  const stopHost = application?.stop ?? ports.stop
  const disposeHost = application?.dispose ?? ports.dispose
  if (!api || !startHost || !stopHost) {
    releaseLock()
    throw new Error('Runtime requires an API and start/stop lifecycle ports')
  }
  let state: State = 'created'
  let transition: Promise<void> | null = null
  let activeCalls = 0
  let idleWaiters: Array<() => void> = []
  const waitForCalls = async (): Promise<void> => {
    if (activeCalls === 0) return
    await new Promise<void>((resolveIdle) => idleWaiters.push(resolveIdle))
  }
  const stopResources = async (): Promise<void> => {
    state = 'stopped'
    await stopHost()
    await waitForCalls()
  }
  const guarded = (target: unknown): unknown => {
    if (typeof target !== 'object' || target === null) return target
    return new Proxy(target as object, {
      get(object, key, receiver) {
        const value = Reflect.get(object, key, receiver) as unknown
        if (typeof value === 'function') {
          return (...args: unknown[]) => {
            if (state !== 'running' && !SUBSCRIPTION_METHODS.has(String(key))) throw new Error(`Line Todo runtime is ${state}`)
            let result: unknown
            try {
              result = Reflect.apply(value, object, args)
            } catch (error) {
              throw error
            }
            if (!result || typeof (result as PromiseLike<unknown>).then !== 'function') return result
            activeCalls += 1
            return Promise.resolve(result).finally(() => {
              activeCalls -= 1
              if (activeCalls === 0) idleWaiters.splice(0).forEach((wake) => wake())
            })
          }
        }
        return guarded(value)
      }
    })
  }

  const runtime: LineTodoRuntime = {
    api: guarded(api) as LineTodoApi,
    start(): Promise<void> {
      if (state === 'disposed') return Promise.reject(new Error('Line Todo runtime is disposed'))
      if (state === 'running') return transition ?? Promise.resolve()
      if (transition) return transition
      transition = (async () => {
        try {
          await startHost()
          state = 'running'
        } catch (error) {
          try { await stopHost() } catch { /* preserve startup failure */ }
          state = 'stopped'
          throw error
        } finally {
          transition = null
        }
      })()
      return transition
    },
    stop(): Promise<void> {
      if (state === 'disposed' || state === 'stopped' || state === 'created') {
        state = state === 'created' ? 'stopped' : state
        return transition ?? Promise.resolve()
      }
      if (transition) return transition.then(() => runtime.stop())
      transition = (async () => {
        try {
          await stopResources()
        } finally {
          transition = null
        }
      })()
      return transition
    },
    dispose(): Promise<void> {
      if (state === 'disposed') return transition ?? Promise.resolve()
      if (transition) return transition.then(() => runtime.dispose())
      transition = (async () => {
        let failure: unknown
        try {
          if (state === 'running') await stopResources()
          else if (state === 'created') state = 'stopped'
        } catch (error) { failure = error }
        try { await disposeHost?.() } catch (error) { failure ??= error }
        releaseLock()
        state = 'disposed'
        transition = null
        if (failure) throw failure
      })()
      return transition
    }
  }
  return runtime
}
