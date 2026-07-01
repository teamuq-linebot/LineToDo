import type { RawLineMessage, LineBridgeStatus } from '../types/api'
import { useLineStream } from '../hooks/useLineStream'
import { formatCallRecord } from '../lib/callRecord'

/**
 * MessageStream — 「即時訊息流」清單。
 * 顯示 main 經由 watch_json.py 即時推來的 LINE 新訊息（最新在頂），
 * 並在頂部顯示 LINE 橋接狀態（啟動/運行/錯誤）。
 *
 * 本里程碑的可視驗收點：App 啟動後，這個清單應出現 LINE 新訊息（或近期訊息）。
 */

function statusLabel(s: LineBridgeStatus | null): { text: string; cls: string } {
  if (!s) return { text: '連線中…', cls: '' }
  switch (s.state) {
    case 'running':
      return { text: `運行中 · 已收 ${s.messageCount} 則`, cls: 'ok' }
    case 'starting':
      return { text: '啟動中…', cls: '' }
    case 'error':
      return { text: `橋接錯誤：${s.lastError ?? '未知'}（將自動重試）`, cls: 'err' }
    case 'stopped':
    default:
      return { text: '已停止', cls: '' }
  }
}

function MessageRow({ m }: { m: RawLineMessage }): JSX.Element {
  const arrow = m.direction === 'out' ? '→' : '←'
  const hhmm = m.time?.length >= 16 ? m.time.slice(11, 16) : m.time
  return (
    <li className={`msg-row ${m.direction}`}>
      <span className="msg-time">{hhmm}</span>
      <span className="msg-arrow">{arrow}</span>
      <span className="msg-chat" title={m.chatId}>
        {m.isGroup ? '👥 ' : ''}
        {m.chat}
      </span>
      <span className="msg-sender">{m.sender}</span>
      <span className="msg-text">{formatCallRecord(m.text)}</span>
    </li>
  )
}

export function MessageStream(): JSX.Element {
  const { messages, status } = useLineStream()
  const st = statusLabel(status)

  return (
    <section className="stream">
      <div className="stream-bar">
        <span className={`dot ${st.cls}`} />
        <span className="stream-status">LINE 橋接：{st.text}</span>
        {status && status.restarts > 0 && (
          <span className="muted">（重啟 {status.restarts} 次）</span>
        )}
        <span className="muted" style={{ marginLeft: 'auto' }}>
          {messages.length} 則
        </span>
      </div>

      {messages.length === 0 ? (
        <div className="stream-empty muted">
          尚無訊息。watch_json.py 正在輪詢 LINE；有新訊息（或近期訊息）時會即時出現在這裡。
          <br />
          若顯示「橋接錯誤」，常見原因：LINE 未開啟（金鑰需從其記憶體讀取）或金鑰已過期。
        </div>
      ) : (
        <ul className="stream-list">
          {messages.map((m, i) => (
            <MessageRow key={`${m.chatId}-${m.ts}-${i}`} m={m} />
          ))}
        </ul>
      )}
    </section>
  )
}
