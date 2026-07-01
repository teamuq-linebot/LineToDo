import { useEffect, useRef, useState } from 'react'
import type { RawLineMessage, LineBridgeStatus } from '../types/api'

/**
 * useLineStream — 訂閱 main 推來的 LINE 即時訊息與橋接狀態。
 *
 * 掛載時：
 *   1. 先 invoke messages.recent() 回放 backlog（避免漏掉掛載前到達的訊息）。
 *   2. invoke line.status() 取得目前橋接狀態。
 *   3. 訂閱 line.onMessage / line.onStatus，之後即時更新。
 * 卸載時自動 unsubscribe。
 */
const MAX_RENDER = 500

export interface UseLineStream {
  messages: RawLineMessage[]
  status: LineBridgeStatus | null
}

export function useLineStream(): UseLineStream {
  const [messages, setMessages] = useState<RawLineMessage[]>([])
  const [status, setStatus] = useState<LineBridgeStatus | null>(null)
  // 用 key 去重（同一則訊息可能既在 backlog 又在後續 push）
  const seen = useRef<Set<string>>(new Set())

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

  useEffect(() => {
    let active = true

    void window.api.messages.recent().then((backlog) => {
      if (active && backlog.length) add(backlog)
    })
    void window.api.line.status().then((s) => {
      if (active) setStatus(s)
    })

    const offMsg = window.api.line.onMessage((m) => {
      // 觀測點：證明 renderer 收到 main 推來的訊息（main 在 DEBUG 模式會轉這行到 stdout）
      console.log(`[stream] recv ${m.time} [${m.chat}] ${m.sender}: ${m.text.slice(0, 40)}`)
      add([m])
    })
    const offStatus = window.api.line.onStatus((s) => setStatus(s))

    return () => {
      active = false
      offMsg()
      offStatus()
    }
  }, [])

  return { messages, status }
}
