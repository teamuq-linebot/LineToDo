/**
 * pluginEvents.ts — backend 事件 → `LineTodoApi` 的 `on*` 訂閱（設計 v2 §4.6，Phase 2 報告 §6 的長輪詢傳輸）。
 *
 * 1.6.8 的 sandbox view 沒有 IPC push；對自己的 backend 只有 `backend.call`（request/response）。所以事件走長輪詢：
 *
 *   events.open  → { sessionId, seq }                       （只收開啟之後的新事件；seq 當 afterSeq）
 *   events.pull  { sessionId, afterSeq, waitMs }  → { events:[{seq,type,payload}], seq, gap, closed }
 *   events.close { sessionId }
 *
 * 規則（對照 backend `eventHub.ts`）：
 *   - 只有「至少有一個訂閱者」時才輪詢；最後一個訂閱者離開、`idleStopMs` 內沒有人再訂閱就停止並 `events.close`（避免 React
 *     StrictMode 的 mount／unmount／mount 造成 session 抖動）。`dispose()` 立即停止；停止後不會再發出任何 `events.pull`。
 *   - 同一時間只有一條輪詢（EventHub 的 session 上限 4，超過會踢最閒置的）。停止／重啟各自獨立（每條迴圈有自己的 Run 控制權）。
 *   - 回應遺失／重送安全：每次以 `afterSeq` 重問，不會遺失也不會重複。
 *   - `gap:true`（ring 已滾掉：大量匯入時 line-message 事件會把 512 則的 ring 滾過去）、`session_not_found`（backend 重啟或 session 閒置過期）、
 *     事件 payload 被壓成 `{overflow:true}`：都無法逐則補回，改成「重新同步」——對 `todos-changed`／`messages-persisted` 發一個空事件、
 *     並重拉 `pipeline.status`／`line.status` 後以 `pipeline-status`／`line-status` 發出，讓看板整個重載。
 *   - 失敗（backend 暫時不可用）以指數退避重試，永不 throw 到訂閱者。
 */

export const PLUGIN_EVENT_TYPES = [
  'line-message', 'line-status', 'messages-persisted', 'pipeline-run', 'pipeline-status',
  'todos-changed', 'backfill-progress', 'reconcile-progress', 'extract-pending'
] as const
export type PluginEventType = (typeof PLUGIN_EVENT_TYPES)[number]

export interface PluginEventPumpOptions {
  /** 發 `events.*`（不經一般請求的併發限制）。 */
  call(path: string, args: unknown[]): Promise<unknown>
  /** 重新同步時重拉狀態用（可選）；回傳要補發的 `[type, payload]`。 */
  resync?(): Promise<Array<[PluginEventType, unknown]>>
  /** 每次長輪詢最久等多久（backend 上限 4 s）。 */
  waitMs?: number
  /** 最後一個訂閱者離開後多久才真的停止。 */
  idleStopMs?: number
  /** 失敗退避：第 n 次失敗等 `min(base * 2^(n-1), max)`。 */
  backoffBaseMs?: number
  backoffMaxMs?: number
  /** 一輪（pull 回來沒有事件）最短間隔，防止 backend 立即回空時變成忙迴圈。 */
  minLoopMs?: number
  /** 診斷用：重新同步／重開 session 的原因。 */
  onDiagnostic?(event: { kind: 'resync' | 'reopen' | 'error'; detail: string }): void
}

type Listener = (payload: unknown) => void

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 一條輪詢迴圈的控制權（停止／重啟各自獨立，舊迴圈不會被新迴圈的狀態復活）。 */
interface Run {
  stopped: boolean
  sessionId: string | null
  wake: (() => void) | null
}

export class PluginEventPump {
  private readonly o: Required<Omit<PluginEventPumpOptions, 'resync' | 'onDiagnostic'>> & Pick<PluginEventPumpOptions, 'resync' | 'onDiagnostic'>
  private readonly listeners = new Map<PluginEventType, Set<Listener>>()
  private current: Run | null = null
  private readonly loops = new Set<Promise<void>>()
  private disposed = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private pulls = 0

  constructor(options: PluginEventPumpOptions) {
    this.o = { waitMs: 3500, idleStopMs: 1000, backoffBaseMs: 500, backoffMaxMs: 15_000, minLoopMs: 200, ...options }
  }

  /** 診斷／測試：目前是否有輪詢迴圈在跑、累計發出過幾次 `events.pull`。 */
  stats(): { running: boolean; pulls: number; listeners: number; sessionId: string | null } {
    return { running: this.current !== null, pulls: this.pulls, listeners: this.listenerCount(), sessionId: this.current?.sessionId ?? null }
  }

  private listenerCount(): number {
    let n = 0
    for (const set of this.listeners.values()) n += set.size
    return n
  }

  subscribe(type: PluginEventType, listener: Listener): () => void {
    if (this.disposed) return () => undefined
    let set = this.listeners.get(type)
    if (!set) this.listeners.set(type, (set = new Set()))
    set.add(listener)
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    if (this.current === null) this.start()
    let active = true
    return () => {
      if (!active) return
      active = false
      set.delete(listener)
      if (this.listenerCount() === 0 && !this.disposed) this.scheduleIdleStop()
    }
  }

  private scheduleIdleStop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.o.idleStopMs <= 0) { this.stop(); return }
    this.idleTimer = setTimeout(() => { this.idleTimer = null; if (this.listenerCount() === 0) this.stop() }, this.o.idleStopMs)
  }

  /** 卸載：立即停止；之後 subscribe 不再有任何作用。 */
  dispose(): void {
    this.disposed = true
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    this.listeners.clear()
    this.stop()
  }

  private start(): void {
    const run: Run = { stopped: false, sessionId: null, wake: null }
    this.current = run
    const loop: Promise<void> = this.run(run).finally(() => { this.loops.delete(loop) })
    this.loops.add(loop)
  }

  private stop(): void {
    const run = this.current
    this.current = null
    if (!run) return
    run.stopped = true
    run.wake?.()
    // 立刻關掉 session：backend 會放掉還在等的長輪詢（不用等它自己逾時）；這條迴圈之後不會再發任何 events.pull。
    const sessionId = run.sessionId
    run.sessionId = null
    if (sessionId !== null) this.closeSession(sessionId)
  }

  private closeSession(sessionId: string): void {
    try { void this.o.call('events.close', [{ sessionId }]).catch(() => undefined) } catch { /* transport 已關閉 */ }
  }

  /** 等待所有輪詢迴圈完全結束（測試用）。 */
  async settled(): Promise<void> { await Promise.all([...this.loops]) }

  private sleep(run: Run, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => { clearTimeout(timer); if (run.wake === done) run.wake = null; resolve() }
      const timer = setTimeout(done, ms)
      run.wake = done
    })
  }

  private async openSession(): Promise<{ sessionId: string; seq: number }> {
    const opened = await this.o.call('events.open', [{}])
    if (!isRecord(opened) || typeof opened.sessionId !== 'string' || typeof opened.seq !== 'number') throw new Error('events.open returned an unexpected value')
    return { sessionId: opened.sessionId, seq: opened.seq }
  }

  private async run(run: Run): Promise<void> {
    let afterSeq = 0
    let failures = 0
    let needResync = false
    let opened = false
    while (!run.stopped) {
      try {
        if (run.sessionId === null) {
          const session = await this.openSession()
          run.sessionId = session.sessionId
          if (run.stopped) break // stop() 發生在 open 進行中：session 由迴圈尾端關掉
          afterSeq = session.seq
          // 第一次開 session 只收之後的事件；之後（重開）代表中間可能漏了事件。
          if (opened) needResync = true
          opened = true
        }
        if (needResync) {
          needResync = false
          await this.resync(run)
          if (run.stopped) break
        }
        const started = Date.now()
        this.pulls += 1
        const pulled = await this.o.call('events.pull', [{ sessionId: run.sessionId, afterSeq, waitMs: this.o.waitMs }])
        if (run.stopped) break
        failures = 0
        if (!isRecord(pulled)) throw new Error('events.pull returned an unexpected value')
        if (pulled.closed === true) { run.sessionId = null; this.o.onDiagnostic?.({ kind: 'reopen', detail: 'session closed by backend' }); continue }
        if (typeof pulled.seq === 'number') afterSeq = pulled.seq
        let lost = pulled.gap === true
        const events = Array.isArray(pulled.events) ? pulled.events : []
        for (const event of events) {
          if (run.stopped) break
          if (!isRecord(event) || typeof event.type !== 'string') continue
          const payload = event.payload
          if (isRecord(payload) && payload.overflow === true) { lost = true; continue }
          this.dispatch(event.type, payload)
        }
        if (run.stopped) break
        if (lost) { this.o.onDiagnostic?.({ kind: 'resync', detail: pulled.gap === true ? 'gap' : 'overflow' }); await this.resync(run) }
        if (events.length === 0 && Date.now() - started < this.o.minLoopMs) await this.sleep(run, this.o.minLoopMs)
      } catch (error) {
        if (run.stopped) break
        const code = isRecord(error) && typeof error.code === 'string' ? error.code : ''
        if (code === 'session_not_found') {
          // backend 重啟或 session 閒置過期：重開 session、重新同步，不算退避。
          run.sessionId = null
          this.o.onDiagnostic?.({ kind: 'reopen', detail: code })
          continue
        }
        failures += 1
        this.o.onDiagnostic?.({ kind: 'error', detail: error instanceof Error ? error.message : String(error) })
        // 失敗時 backend 可能已經重啟：恢復後補一次重新同步。
        needResync = true
        await this.sleep(run, Math.min(this.o.backoffBaseMs * 2 ** (failures - 1), this.o.backoffMaxMs))
      }
    }
    // 迴圈在 open 之後才被停止的情況：session 還沒被 stop() 關到。
    const sessionId = run.sessionId
    run.sessionId = null
    if (sessionId !== null) this.closeSession(sessionId)
  }

  private async resync(run: Run): Promise<void> {
    this.dispatch('todos-changed', { createdIds: [], resolvedIds: [], updatedIds: [] })
    this.dispatch('messages-persisted', { chatIds: [], inserted: 0 })
    if (!this.o.resync) return
    try {
      for (const [type, payload] of await this.o.resync()) if (!run.stopped) this.dispatch(type, payload)
    } catch { /* 狀態重拉失敗：下一個真實事件會再帶來狀態 */ }
  }

  private dispatch(type: string, payload: unknown): void {
    const set = this.listeners.get(type as PluginEventType)
    if (!set || set.size === 0) return
    for (const listener of [...set]) {
      try { listener(payload) } catch (error) { console.error('[plugin-events] listener failed:', error) }
    }
  }
}
