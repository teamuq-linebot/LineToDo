export type CompleteTodoResult =
  | { write: 'confirmed'; refresh: 'confirmed' }
  | { write: 'confirmed'; refresh: 'failed'; error: string }
  | { write: 'failed'; refresh: 'not-run'; error: string }

export type CompleteTodoSnapshot =
  | null
  | { phase: 'writing' | 'refreshing' }
  | { phase: 'write-error' | 'refresh-error'; message: string }

export interface CompleteTodoRegistry {
  getSnapshot: (id: string) => CompleteTodoSnapshot
  subscribe: (id: string, listener: () => void) => () => void
  reconcileAfterRefresh: () => void
  run: (
    id: string,
    write: () => Promise<boolean>,
    refresh: () => Promise<void>,
    onWriteConfirmed?: () => void
  ) => Promise<CompleteTodoResult>
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Preserve the boundary between persisted TODO state and its later renderer refresh. */
export async function runCompleteTodo(
  write: () => Promise<boolean>,
  refresh: () => Promise<void>,
  onWriteConfirmed?: () => void
): Promise<CompleteTodoResult> {
  try {
    if (!await write()) return { write: 'failed', refresh: 'not-run', error: '找不到此待辦' }
  } catch (error) {
    return { write: 'failed', refresh: 'not-run', error: errorText(error) }
  }

  onWriteConfirmed?.()
  try {
    await refresh()
    return { write: 'confirmed', refresh: 'confirmed' }
  } catch (error) {
    return { write: 'confirmed', refresh: 'failed', error: errorText(error) }
  }
}

/**
 * Own completion state by TODO id for one renderer API identity. The registry
 * outlives individual TodoCard mounts, so filtering/remounting cannot forget an
 * in-flight write or retry a write already confirmed by the backend.
 */
export function createCompleteTodoRegistry(): CompleteTodoRegistry {
  const snapshots = new Map<string, Exclude<CompleteTodoSnapshot, null>>()
  const listeners = new Map<string, Set<() => void>>()
  const inFlight = new Map<string, Promise<CompleteTodoResult>>()

  function publish(id: string, snapshot: CompleteTodoSnapshot): void {
    if (snapshot) snapshots.set(id, snapshot)
    else snapshots.delete(id)
    for (const listener of listeners.get(id) ?? []) listener()
  }

  return {
    getSnapshot: (id) => snapshots.get(id) ?? null,
    reconcileAfterRefresh: () => {
      for (const [id, snapshot] of snapshots) {
        // A successful independent list refresh resolves stale error UI. Keep
        // all active writes/refresh retries fenced until their own promise ends.
        if (!inFlight.has(id) && (snapshot.phase === 'write-error' || snapshot.phase === 'refresh-error')) {
          publish(id, null)
        }
      }
    },
    subscribe: (id, listener) => {
      let todoListeners = listeners.get(id)
      if (!todoListeners) {
        todoListeners = new Set()
        listeners.set(id, todoListeners)
      }
      todoListeners.add(listener)
      return () => {
        todoListeners?.delete(listener)
        if (todoListeners?.size === 0) listeners.delete(id)
      }
    },
    run: (id, write, refresh, onWriteConfirmed) => {
      const existing = inFlight.get(id)
      if (existing) return existing

      const current = snapshots.get(id)
      const retryConfirmedRefresh = current?.phase === 'refresh-error'
      if (retryConfirmedRefresh) publish(id, { phase: 'refreshing' })
      else publish(id, { phase: 'writing' })

      const operation = (async (): Promise<CompleteTodoResult> => {
        if (retryConfirmedRefresh) {
          try {
            await refresh()
            publish(id, null)
            return { write: 'confirmed', refresh: 'confirmed' }
          } catch (error) {
            const message = errorText(error)
            publish(id, { phase: 'refresh-error', message })
            return { write: 'confirmed', refresh: 'failed', error: message }
          }
        }

        try {
          if (!await write()) {
            const error = '找不到此待辦'
            publish(id, { phase: 'write-error', message: error })
            return { write: 'failed', refresh: 'not-run', error }
          }
        } catch (error) {
          const message = errorText(error)
          publish(id, { phase: 'write-error', message })
          return { write: 'failed', refresh: 'not-run', error: message }
        }

        publish(id, { phase: 'refreshing' })
        try {
          onWriteConfirmed?.()
        } catch {
          // A view callback must not override the backend's confirmed-write state.
        }
        try {
          await refresh()
          publish(id, null)
          return { write: 'confirmed', refresh: 'confirmed' }
        } catch (error) {
          const message = errorText(error)
          publish(id, { phase: 'refresh-error', message })
          return { write: 'confirmed', refresh: 'failed', error: message }
        }
      })()

      inFlight.set(id, operation)
      void operation.then(
        () => { if (inFlight.get(id) === operation) inFlight.delete(id) },
        () => { if (inFlight.get(id) === operation) inFlight.delete(id) }
      )
      return operation
    }
  }
}
