import { useState } from 'react'
import { useLineTodoApi } from '../../platform/LineTodoApi'
import { refreshFailureText } from './refreshFailure'

const REFRESH_DAYS_MIN = 1
const REFRESH_DAYS_MAX = 365

/** 只接受 1–365 的整數字串；其餘回 null（按鈕不可用）。 */
export function parseRefreshDays(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return value >= REFRESH_DAYS_MIN && value <= REFRESH_DAYS_MAX ? value : null
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const days = parseRefreshDays(text)
  const canRun = !busy && days !== null && (todoOn || topicsOn)

  async function run(): Promise<void> {
    if (!canRun || days === null) return
    setBusy(true)
    setError('')
    try {
      const result = await lineTodoApi.pipeline.refreshChat(chatId, days)
      if (!result.ok) setError(refreshFailureText(result))
    } catch {
      setError('重新整理失敗，請稍後再試')
    } finally {
      setBusy(false)
    }
  }

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
      <button type="button" disabled={!canRun} onClick={() => void run()}>{busy ? '重新整理中…' : '重新整理'}</button>
      {error && <p className="group-topics-error" role="alert">{error}</p>}
    </div>
  )
}
