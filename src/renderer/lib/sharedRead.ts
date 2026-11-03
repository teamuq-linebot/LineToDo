/**
 * 同一個 api 上、同一個 key 的讀取在進行中時共用同一個 Promise（結束後就釋放，下一次讀取會重新送出）。
 * 用於同一頁多個元件在掛載時各自讀同一份唯讀資料（例如 pipeline.status、settings.get），避免重複佔用 host 呼叫名額。
 */
const inflight = new WeakMap<object, Map<string, Promise<unknown>>>()

export function sharedRead<T>(owner: object, key: string, read: () => Promise<T>): Promise<T> {
  let reads = inflight.get(owner)
  if (!reads) {
    reads = new Map()
    inflight.set(owner, reads)
  }
  const existing = reads.get(key)
  if (existing) return existing as Promise<T>
  const pending: Promise<T> = read().finally(() => {
    if (reads.get(key) === pending) reads.delete(key)
  })
  reads.set(key, pending)
  return pending
}
