import { useState } from 'react'
import type { ChatDTO } from '../../types/api'

/**
 * BlocklistEditor — 降噪黑名單編輯（IMPLEMENTATION_PLAN.md §7.1）。
 *
 * 兩部分：
 *   1) nameKeywords：chat 名稱含關鍵字即自動 block。可增刪。
 *   2) 逐 chat toggle：列出所有 chat（含已 block），切換黑名單狀態。
 */

interface Props {
  nameKeywords: string[]
  chats: ChatDTO[]
  onKeywordsChange: (next: string[]) => void
  onToggleChat: (chatId: string, blocked: boolean) => void
}

export function BlocklistEditor({
  nameKeywords,
  chats,
  onKeywordsChange,
  onToggleChat
}: Props): JSX.Element {
  const [newKw, setNewKw] = useState('')

  function addKeyword(): void {
    const kw = newKw.trim()
    if (!kw || nameKeywords.includes(kw)) {
      setNewKw('')
      return
    }
    onKeywordsChange([...nameKeywords, kw])
    setNewKw('')
  }

  function removeKeyword(kw: string): void {
    onKeywordsChange(nameKeywords.filter((k) => k !== kw))
  }

  return (
    <div className="set-field">
      <label className="set-label">降噪黑名單</label>
      <div className="muted set-hint">
        名稱含以下任一關鍵字的聊天室會自動排除（不送抽取引擎）。
      </div>

      <div className="kw-list">
        {nameKeywords.map((kw) => (
          <span key={kw} className="kw-chip">
            {kw}
            <button className="kw-x" onClick={() => removeKeyword(kw)} title="移除">
              ✕
            </button>
          </span>
        ))}
        {nameKeywords.length === 0 && <span className="muted">（無關鍵字）</span>}
      </div>

      <div className="set-keyrow">
        <input
          className="set-input"
          placeholder="新增關鍵字（例如：促銷）"
          value={newKw}
          onChange={(e) => setNewKw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addKeyword()
          }}
        />
        <button onClick={addKeyword} disabled={!newKw.trim()}>
          新增
        </button>
      </div>

      <div className="set-subhead">逐聊天室控制（{chats.length}）</div>
      <div className="chat-toggle-list">
        {chats.length === 0 ? (
          <span className="muted">尚無聊天室資料（App 收到 LINE 訊息後會出現）。</span>
        ) : (
          chats.map((c) => (
            <label key={c.chatId} className="chat-toggle-row">
              <input
                type="checkbox"
                checked={c.blocked}
                onChange={(e) => onToggleChat(c.chatId, e.target.checked)}
              />
              <span className="chat-toggle-name">
                {c.isGroup ? '👥 ' : '💬 '}
                {c.name ?? c.chatId}
              </span>
              {c.blocked && c.blockReason && (
                <span className="muted chat-toggle-reason">{c.blockReason}</span>
              )}
            </label>
          ))
        )}
      </div>
    </div>
  )
}
