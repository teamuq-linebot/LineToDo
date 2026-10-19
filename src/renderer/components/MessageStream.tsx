import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RawLineMessage, LineBridgeStatus } from '../types/api'
import { useLineStream } from '../hooks/useLineStream'
import { formatCallRecord } from '../lib/callRecord'
import { MediaFileActions, MediaImage } from './MediaView'

interface ConversationSummary {
  chatId: string
  name: string
  isGroup: boolean
  latest: RawLineMessage
  count: number
}

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

/** bytes → 「NN.N KB」/「NN.N MB」（< 1 KB 顯示 B）；null/undefined 回空字串。 */
function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

function messageTimeLabel(message: RawLineMessage): string {
  const time = message.time ?? ''
  return time.length >= 16 ? time.slice(11, 16) : time || '--:--'
}

function compareMessages(a: RawLineMessage, b: RawLineMessage): number {
  return a.ts - b.ts || a.time.localeCompare(b.time)
}

function avatarMark(label: string, isGroup: boolean): string {
  if (isGroup) return '群'
  return [...label.trim()][0] ?? '友'
}

function previewText(message: RawLineMessage): string {
  if (message.unsent) return '已收回訊息'
  if (message.contentType === 1) return '圖片'
  if (message.contentType === 14) return message.origFilename || '檔案'
  return formatCallRecord(message.text)?.replace(/\s+/g, ' ').trim() || '訊息'
}

/**
 * 依 contentType 渲染訊息內容，並沿用目前宿主提供的媒體能力。
 * bytes/key material 不會進入 renderer；這裡只接收現有 msgId、檔名與大小欄位。
 */
function MessageContent({
  m,
  onOpenLightbox
}: {
  m: RawLineMessage
  onOpenLightbox: (url: string) => void
}): JSX.Element {
  const [fileErr, setFileErr] = useState('')

  if (m.contentType === 1 && m.msgId) {
    return <MediaImage msgId={m.msgId} as="div" onOpenLightbox={onOpenLightbox} />
  }

  if (m.contentType === 14 && m.msgId) {
    const id = m.msgId
    return (
      <>
        <span className="sm-file">
          <span className="sm-file-icon">📎</span>
          <span className="sm-file-name">{m.origFilename ?? '檔案'}</span>
          <span className="sm-file-size">{formatSize(m.fileSize)}</span>
          <MediaFileActions msgId={id} onError={setFileErr} />
        </span>
        {fileErr && (
          <span className="chat-file-error" role="alert">
            {fileErr}
          </span>
        )}
      </>
    )
  }

  return <>{formatCallRecord(m.text)}</>
}

function MessageRow({
  m,
  onOpenLightbox
}: {
  m: RawLineMessage
  onOpenLightbox: (url: string) => void
}): JSX.Element {
  const incoming = m.direction === 'in'
  const sender = m.sender || (incoming ? '對方' : '我')
  return (
    <li className={`chat-message ${incoming ? 'incoming' : 'outgoing'}`}>
      {incoming && (
        <span className="chat-message-avatar" aria-hidden="true" title={sender}>
          {avatarMark(sender, false)}
        </span>
      )}
      <div className="chat-message-content">
        <span className="chat-message-sender">{sender}</span>
        <div className="chat-message-bubble">
          {m.unsent && <span className="unsent-badge">🚫 已收回</span>}
          <div className={m.unsent ? 'chat-message-body sm-unsent' : 'chat-message-body'}>
            <MessageContent m={m} onOpenLightbox={onOpenLightbox} />
          </div>
        </div>
        <time className="chat-message-time">{messageTimeLabel(m)}</time>
      </div>
    </li>
  )
}

export function MessageStream(): JSX.Element {
  const { messages, status, error } = useLineStream()
  const st = statusLabel(status)
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const messageLogRef = useRef<HTMLDivElement | null>(null)
  const previousChatIdRef = useRef<string | null>(null)
  const pinnedToBottomRef = useRef(true)

  const conversations = useMemo(() => {
    const byChat = new Map<string, ConversationSummary>()
    for (const message of messages) {
      const current = byChat.get(message.chatId)
      if (!current) {
        byChat.set(message.chatId, {
          chatId: message.chatId,
          name: message.chat || '未命名聊天室',
          isGroup: message.isGroup,
          latest: message,
          count: 1
        })
        continue
      }
      current.count += 1
      if (compareMessages(message, current.latest) > 0) {
        current.latest = message
        current.name = message.chat || current.name
        current.isGroup = message.isGroup
      }
    }
    return [...byChat.values()].sort((a, b) => compareMessages(b.latest, a.latest))
  }, [messages])

  const activeConversation = conversations.find((chat) => chat.chatId === selectedChatId) ?? conversations[0] ?? null
  const activeChatId = activeConversation?.chatId ?? null
  const activeMessages = useMemo(() => {
    if (!activeChatId) return []
    return messages
      .filter((message) => message.chatId === activeChatId)
      .sort(compareMessages)
  }, [messages, activeChatId])
  const latestActiveMessage = activeMessages[activeMessages.length - 1] ?? null

  // 切換聊天室時前往最新訊息；收到新訊息時，只有使用者仍在底部才跟著捲動。
  useLayoutEffect(() => {
    const log = messageLogRef.current
    if (!log) return
    if (previousChatIdRef.current !== activeChatId) {
      previousChatIdRef.current = activeChatId
      pinnedToBottomRef.current = true
    }
    if (pinnedToBottomRef.current) log.scrollTop = log.scrollHeight
  }, [activeChatId, latestActiveMessage])

  // Esc 關閉 lightbox。
  useEffect(() => {
    if (!lightboxSrc) return
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setLightboxSrc(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [lightboxSrc])

  return (
    <section className="stream chat-stream">
      <div className="stream-bar">
        <span className={`dot ${st.cls}`} />
        <span className="stream-status">LINE 橋接：{st.text}</span>
        {status && status.restarts > 0 && <span className="muted">（重啟 {status.restarts} 次）</span>}
        <span className="muted stream-count">{messages.length} 則</span>
      </div>
      {error && <div className="set-notice err stream-error" role="alert">{error}</div>}

      {messages.length === 0 ? (
        <div className="stream-empty muted">
          尚無訊息。正在輪詢 LINE 資料庫；有新訊息（或近期訊息）時會即時出現在這裡。
          <br />
          若顯示「橋接錯誤」，常見原因：LINE 未開啟（金鑰需從其記憶體讀取）或金鑰已過期。
        </div>
      ) : (
        <div className="chat-workspace">
          <aside className="chat-sidebar" aria-label="聊天室列表">
            <div className="chat-sidebar-heading">
              <h2>聊天室</h2>
              <span>{conversations.length}</span>
            </div>
            <ul className="chat-list">
              {conversations.map((chat) => {
                const active = chat.chatId === activeChatId
                const previewSender = chat.latest.direction === 'out' ? '我' : chat.latest.sender
                return (
                  <li key={chat.chatId}>
                    <button
                      type="button"
                      className={`chat-list-item${active ? ' active' : ''}`}
                      aria-pressed={active}
                      onClick={() => setSelectedChatId(chat.chatId)}
                    >
                      <span className={`chat-avatar${chat.isGroup ? ' group' : ''}`} aria-hidden="true">
                        {avatarMark(chat.name, chat.isGroup)}
                      </span>
                      <span className="chat-list-copy">
                        <span className="chat-list-line">
                          <span className="chat-list-name" title={chat.name}>{chat.name}</span>
                          <time className="chat-list-time">{messageTimeLabel(chat.latest)}</time>
                        </span>
                        <span className="chat-list-preview">
                          {previewSender && <span className="chat-list-sender">{previewSender}：</span>}
                          {previewText(chat.latest)}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </aside>

          <section className="chat-pane" aria-label={activeConversation?.name ?? '聊天室內容'}>
            {activeConversation && (
              <header className="chat-pane-header">
                <span className={`chat-avatar chat-pane-avatar${activeConversation.isGroup ? ' group' : ''}`} aria-hidden="true">
                  {avatarMark(activeConversation.name, activeConversation.isGroup)}
                </span>
                <div className="chat-pane-title">
                  <h2>{activeConversation.name}</h2>
                  <span>{activeConversation.isGroup ? '群組' : '私人聊天'} · {activeConversation.count} 則訊息</span>
                </div>
              </header>
            )}
            <div
              className="chat-message-log"
              ref={messageLogRef}
              role="log"
              aria-label="選定聊天室訊息"
              aria-live="polite"
              onScroll={(event) => {
                const log = event.currentTarget
                pinnedToBottomRef.current = log.scrollHeight - log.scrollTop - log.clientHeight < 96
              }}
            >
              <ol className="chat-message-list">
                {activeMessages.map((message, index) => (
                  <MessageRow
                    key={`${message.chatId}-${message.ts}-${message.sender}-${index}`}
                    m={message}
                    onOpenLightbox={setLightboxSrc}
                  />
                ))}
              </ol>
            </div>
          </section>
        </div>
      )}

      {lightboxSrc && (
        <div className="sm-lightbox" onClick={() => setLightboxSrc(null)}>
          <img src={lightboxSrc} alt="圖片放大" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </section>
  )
}
