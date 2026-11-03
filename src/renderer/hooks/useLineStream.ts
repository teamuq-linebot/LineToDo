import { useLineTodoApi } from '../platform/LineTodoApi'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { RawLineMessage, LineBridgeStatus } from '../types/api'
import type { BackendDiagnostics, BackendPhase } from '../platform/pluginTransport'
import { backendErrorText, isViewCallTimeout } from '../lib/backendError'

/**
 * useLineStream — 訂閱 main 推來的 LINE 即時訊息與橋接狀態。
 *
 * 掛載時：
 *   1. 先 invoke messages.recent() 回放 backlog（避免漏掉掛載前到達的訊息）。
 *   2. invoke line.status() 取得目前橋接狀態。
 *   3. 訂閱 line.onMessage / line.onStatus，之後即時更新。
 * 卸載時自動 unsubscribe。
 * 1、2 失敗時（外掛版：backend 沒起來、權限被撤銷…）`error` 帶原因，畫面顯示它（G-02），不留未處理的 rejection。
 * 1、2 是 core 通道的呼叫（pluginTransport.ts 的 `laneFor`），不會被頭像／圖片／AI 狀態佔滿名額；等不到回覆時 transport 以 `view_call_timeout` 放棄，
 * 這種逾時由狀態列的 phase（「讀取逾時」＋「重試」）顯示，不另外疊一則紅色錯誤；`retry()` 重做 1、2。
 */
const MAX_RENDER = 500

export interface UseLineStream {
  messages: RawLineMessage[]
  status: LineBridgeStatus | null
  /** 讀取 backlog／橋接狀態失敗的原因；沒有失敗（或只是畫面端等待逾時）＝null。 */
  error: string | null
  /** 重新讀取 backlog 與橋接狀態（逾時或失敗後的「重試」）；兩個呼叫都結束才 resolve，不會 reject。 */
  retry(): Promise<void>
}

/** 外掛版 adapter 的 `api.plugin` 提供的後端階段與診斷；standalone 沒有（`null`），畫面維持原本的文字。 */
export interface BackendPhaseSource {
  backendPhase(): BackendPhase
  onBackendPhase(listener: (phase: BackendPhase) => void): () => void
  backendDiagnostics(): BackendDiagnostics
  info(): Promise<Record<string, unknown>>
}

/** 以形狀判斷（不 import 外掛傳輸層，standalone bundle 不需要它）。 */
export function backendPhaseSourceOf(api: unknown): BackendPhaseSource | null {
  const plugin = api !== null && typeof api === 'object' ? (api as { plugin?: unknown }).plugin : undefined
  if (plugin === null || typeof plugin !== 'object') return null
  const candidate = plugin as Partial<BackendPhaseSource>
  return typeof candidate.backendPhase === 'function' && typeof candidate.onBackendPhase === 'function' && typeof candidate.backendDiagnostics === 'function' && typeof candidate.info === 'function'
    ? (plugin as BackendPhaseSource)
    : null
}

/** 目前的後端階段；standalone（沒有 phase 來源）回 `{ source: null, phase: null }`。 */
export function useBackendPhase(): { source: BackendPhaseSource | null; phase: BackendPhase | null } {
  const api = useLineTodoApi()
  const source = useMemo(() => backendPhaseSourceOf(api), [api])
  const [phase, setPhase] = useState<BackendPhase | null>(() => source?.backendPhase() ?? null)
  useEffect(() => {
    if (!source) { setPhase(null); return undefined }
    setPhase(source.backendPhase())
    return source.onBackendPhase(setPhase)
  }, [source])
  return { source, phase }
}

export function useLineStream(): UseLineStream {
  const api = useLineTodoApi()
  const [messages, setMessages] = useState<RawLineMessage[]>([])
  const [status, setStatus] = useState<LineBridgeStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 用 key 去重（同一則訊息可能既在 backlog 又在後續 push）
  const seen = useRef<Set<string>>(new Set())
  const activeRef = useRef(true)

  function keyOf(m: RawLineMessage): string {
    return `${m.chatId}:${m.ts}:${m.sender}:${m.text}`
  }

  function add(incoming: RawLineMessage[]): void {
    setMessages((prev) => {
      const fresh = incoming.filter((m) => {
        const k = keyOf(m)
        if (seen.current.has(k)) return false
        seen.current.add(k)
        return true
      })
      if (fresh.length === 0) return prev
      // 新訊息放最上面（最新在頂），裁掉超量
      const next = [...fresh.reverse(), ...prev]
      return next.length > MAX_RENDER ? next.slice(0, MAX_RENDER) : next
    })
  }

  function load(): Promise<void> {
    const failed = (err: unknown, prefix: string): void => {
      if (activeRef.current && !isViewCallTimeout(err)) setError(backendErrorText(err, prefix))
    }
    const recent = api.messages.recent().then((backlog) => {
      if (activeRef.current && backlog.length) add(backlog)
    }, (err: unknown) => failed(err, '讀取最近訊息失敗'))
    const bridge = api.line.status().then((s) => {
      if (activeRef.current) setStatus(s)
    }, (err: unknown) => failed(err, '讀取 LINE 橋接狀態失敗'))
    return Promise.all([recent, bridge]).then(() => undefined)
  }

  function retry(): Promise<void> {
    if (activeRef.current) setError(null)
    return load()
  }

  useEffect(() => {
    activeRef.current = true
    void load()

    const offMsg = api.line.onMessage((m) => {
      // 觀測點：證明 renderer 收到 main 推來的訊息（main 在 DEBUG 模式會轉這行到 stdout）
      console.log(`[stream] recv ${m.time} [${m.chat}] ${m.sender}: ${m.text.slice(0, 40)}`)
      add([m])
    })
    const offStatus = api.line.onStatus((s) => { setStatus(s); setError(null) })

    return () => {
      activeRef.current = false
      offMsg()
      offStatus()
    }
  }, [])

  return { messages, status, error, retry }
}
