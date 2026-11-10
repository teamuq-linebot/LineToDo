import { useEffect, useRef, useState } from 'react'
import { useLineTodoApi } from '../../platform/LineTodoApi'
import type { ChatRefreshQueueStatus } from '../../../shared/api'
import { refreshErrorText, refreshFailureText, refreshSummaryText } from './refreshFailure'

const REFRESH_DAYS_MIN = 1
const REFRESH_DAYS_MAX = 365
const STATUS_POLL_MS = 1500
const IDLE: ChatRefreshQueueStatus = { state: 'idle', ahead: 0 }
/** 已被後端接受（排隊中、已開始，或同一聊天室已在排隊／執行）：不是錯誤，之後由狀態查詢顯示進度。 */
const ACCEPTED: ReadonlySet<string> = new Set(['queued', 'already_queued', 'already_running'])

/** 只接受 1–365 的整數字串；其餘回 null（按鈕不可用）。 */
export function parseRefreshDays(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return value >= REFRESH_DAYS_MIN && value <= REFRESH_DAYS_MAX ? value : null
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : ''
}

interface Props {
  /** 目前開啟的聊天室；只重新整理這一個。 */
  chatId: string
  /** 該聊天室的待辦抽取開關（與聊天室清單共用的 prefs 狀態）。 */
  todoOn: boolean
  /** 該聊天室的議題開關（與聊天室清單共用的 prefs 狀態）。 */
  topicsOn: boolean
}

/** 「議題與待辦」頁籤最上方：天數輸入＋「重新整理」按鈕。待辦與議題依該聊天室目前的開關處理；兩者皆關時不可用。 */
export function ChatRefreshControl({ chatId, todoOn, topicsOn }: Props): JSX.Element {
  const lineTodoApi = useLineTodoApi()
  const [text, setText] = useState('7')
  const [startingChat, setStartingChat] = useState<string | null>(null)
  const [known, setKnown] = useState<{ chatId: string; status: ChatRefreshQueueStatus }>({ chatId, status: IDLE })
  const [error, setError] = useState('')
  // 每次後端接受重新整理後遞增，讓狀態查詢立刻重讀一次（不等下一個定時點）。
  const [pollNonce, setPollNonce] = useState(0)
  const chatRef = useRef(chatId)
  chatRef.current = chatId

  const starting = startingChat === chatId
  const status = known.chatId === chatId ? known.status : IDLE
  const busy = starting || status.state !== 'idle'
  const days = parseRefreshDays(text)
  const canRun = !busy && days !== null && (todoOn || topicsOn)

  useEffect(() => {
    setError('')
  }, [chatId])

  // 只有目前這個聊天室的控制項會輪詢：掛載、切換聊天室、或後端接受重新整理時讀一次狀態；
  // 讀到排隊中或執行中才每 STATUS_POLL_MS 再讀，變成 idle 就停（同一時間最多一個輪詢計時器）。
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const load = (): void => {
      lineTodoApi.pipeline.refreshChatStatus(chatId).then((next) => {
        if (!alive) return
        setKnown({ chatId, status: next })
        if (next.state !== 'idle') timer = setTimeout(load, STATUS_POLL_MS)
      }, () => {
        if (alive) setKnown({ chatId, status: IDLE })
      })
    }
    load()
    return () => {
      alive = false
      if (timer !== null) clearTimeout(timer)
    }
  }, [chatId, lineTodoApi, pollNonce])

  async function run(): Promise<void> {
    if (!canRun || days === null) return
    const target = chatId
    setStartingChat(target)
    setError('')
    try {
      const result = await lineTodoApi.pipeline.refreshChat(target, days)
      if (ACCEPTED.has(result.reason ?? '')) {
        // 後端已接受（立即回應，不等整理完成）：先依回傳的 ahead 顯示，再由狀態查詢校正。
        if (result.reason === 'queued') {
          const ahead = result.ahead ?? 0
          setKnown({ chatId: target, status: { state: ahead > 0 ? 'queued' : 'running', ahead } })
        }
        setPollNonce((n) => n + 1)
      } else if (chatRef.current === target && !result.ok) {
        setError(refreshFailureText(result))
      }
    } catch (caught) {
      if (chatRef.current === target) setError(refreshErrorText(errorCode(caught)))
    } finally {
      setStartingChat((current) => (current === target ? null : current))
    }
  }

  const label = status.state === 'queued' ? `排隊中（前面 ${status.ahead} 個）` : busy ? '整理中…' : '重新整理'
  // 上次排隊執行的結果（只在 idle 顯示）；失敗顯示原因短字，成功顯示筆數摘要。
  const finished = status.state === 'idle' ? status.last : undefined

  return (
    <div className="group-topics-controls chat-refresh-control" data-testid="chat-refresh-control" style={{ marginBottom: 12 }}>
      <label>
        <input
          type="number"
          className="set-input"
          aria-label="重新整理天數"
          min={REFRESH_DAYS_MIN}
          max={REFRESH_DAYS_MAX}
          step={1}
          value={text}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
          style={{ width: 84 }}
        />
        <span>天</span>
      </label>
      <button type="button" disabled={!canRun} onClick={() => void run()}>{label}</button>
      {error && <p className="group-topics-error" role="alert">{error}</p>}
      {!error && finished && (finished.ok
        ? <p className="muted" role="status" data-testid="chat-refresh-last">{refreshSummaryText(finished.result)}</p>
        : <p className="group-topics-error" role="alert" data-testid="chat-refresh-last">{refreshFailureText(finished.result)}</p>)}
    </div>
  )
}
