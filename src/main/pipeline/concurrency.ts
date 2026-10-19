/**
 * concurrency.ts — 極簡 p-limit（不引外部相依，IMPLEMENTATION_PLAN.md §2 / §6.1）。
 *
 * qwen 並發保守（1–2）；用一個固定大小的 in-flight 計數 + 等待佇列控住同時 request 數。
 * 回傳一個包裝函式：把 async task 包進來，超過上限的會排隊，前面完成才放行。
 */
export function createLimiter(concurrency: number): <T>(task: () => Promise<T>) => Promise<T> {
  const max = Math.max(1, Math.floor(concurrency) || 1)
  let active = 0
  const queue: Array<() => void> = []

  const next = (): void => {
    if (active >= max) return
    const run = queue.shift()
    if (run) {
      active += 1
      run()
    }
  }

  return function limit<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = (): void => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active -= 1
            next()
          })
      }
      queue.push(run)
      next()
    })
  }
}

/** 以指定並發跑一批 task，全部 settle 後回傳結果（保序）。個別失敗不影響其他。 */
export async function mapLimited<I, O>(
  items: I[],
  concurrency: number,
  fn: (item: I, index: number) => Promise<O>
): Promise<PromiseSettledResult<O>[]> {
  const limit = createLimiter(concurrency)
  return Promise.allSettled(items.map((item, i) => limit(() => fn(item, i))))
}
