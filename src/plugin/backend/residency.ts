/**
 * residency.ts — backend 端的「背景執行」狀態追蹤（Core 的 `context.residency`，`background:resident`）。
 *
 * 規則（Core 設計 D:150-194、契約報告 A）：
 *   - 舊 Core 沒有 `context.residency`（或不是 `{ current(), onChange() }`）：追蹤器永遠是 `supported:false`，不訂閱、不回報任何事件，其餘行為與之前完全相同。
 *   - 啟動時讀一次 `current()`，之後只靠 `onChange` 更新。撤銷或降級**不會**送 `ext-permission-revoked`，所以 `onChange` 是唯一的通知來源。
 *   - 降級（`resident` → `on-demand`）不中斷行程，只是 Core 重新開始算閒置計時。本模組在降級時什麼也不做：沒有計時器、沒有輪詢、
 *     不呼叫任何宿主 API（不會為了「保活」而定期讀 `current()` 或呼叫 `host.ai`）；背景工作照舊只在有事做時才碰宿主。
 *   - `reason` 是開放集合：原樣保留（只過濾掉不是短字串的值），文字由 shared/residency.ts 決定，不認得的代碼走通用文字。
 *   - 讀不懂的值（形狀不對）忽略並保留上一個值；listener 丟錯不影響其他 listener。
 */
import { RESIDENCY_UNSUPPORTED, normalizeResidency, sameResidency } from '../../shared/residency'
import type { ResidencySnapshot } from '../../shared/residency'

/** Core 的 `context.residency` 中本外掛用到的部分（值一律當成不可信的 unknown，自己驗證）。 */
export interface ResidencySource {
  current(): unknown
  onChange(listener: (residency: unknown) => void): () => void
}

export interface ResidencyTracker {
  /** 目前已知的狀態（同步；不讀宿主）。 */
  snapshot(): ResidencySnapshot
  /** 狀態真的改變時通知（相同的值不重複通知）；回傳取消訂閱。 */
  onChange(listener: (snapshot: ResidencySnapshot) => void): () => void
  dispose(): void
}

/** `context.residency` 是不是可以用的形狀。 */
export function isResidencySource(value: unknown): value is ResidencySource {
  return value !== null && typeof value === 'object' && typeof (value as ResidencySource).current === 'function' && typeof (value as ResidencySource).onChange === 'function'
}

export function createResidencyTracker(source: unknown, log: (event: string, detail?: Record<string, unknown>) => void = () => undefined): ResidencyTracker {
  const listeners = new Set<(snapshot: ResidencySnapshot) => void>()
  let state: ResidencySnapshot = RESIDENCY_UNSUPPORTED
  let off: (() => void) | null = null
  let disposed = false

  const safeLog = (event: string, detail?: Record<string, unknown>): void => { try { log(event, detail) } catch { /* 診斷失敗不影響流程 */ } }

  const apply = (raw: unknown): void => {
    if (disposed) return
    const next = normalizeResidency(raw)
    if (next === null) { safeLog('residency ignored', { reason: 'unreadable' }); return }
    if (sameResidency(next, state)) return
    state = next
    safeLog('residency changed', { requested: next.requested, level: next.level, reason: next.reason })
    for (const listener of [...listeners]) {
      try { listener(next) } catch (error) { safeLog('residency listener failed', { message: error instanceof Error ? error.message.slice(0, 120) : 'unknown' }) }
    }
  }

  if (isResidencySource(source)) {
    try {
      const initial = normalizeResidency(source.current())
      if (initial !== null) state = initial
      else safeLog('residency unsupported', { reason: 'unreadable current()' })
      off = source.onChange(apply)
    } catch (error) {
      safeLog('residency unsupported', { reason: 'source threw', message: error instanceof Error ? error.message.slice(0, 120) : 'unknown' })
    }
  }

  return {
    snapshot: () => state,
    onChange(listener) {
      if (disposed) return () => undefined
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      if (disposed) return
      disposed = true
      listeners.clear()
      try { off?.() } catch { /* 已解除 */ }
      off = null
    }
  }
}
