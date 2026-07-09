import { useEffect, useState } from 'react'
import type { TodoDTO } from '../types/api'

/**
 * DraftReplyDialog — 「草擬回覆」對話框（IMPLEMENTATION_PLAN.md §5 todos:draftReply）。
 *
 * MVP：只草擬不送出。開啟即呼叫 qwen 產一段草稿；可重新產生、可複製。
 * 真正送出（driver_post）延後，按鈕明示「不會送出」。
 */

interface Props {
  todo: TodoDTO
  chatName: string | null
  onClose: () => void
}

export function DraftReplyDialog({ todo, chatName, onClose }: Props): JSX.Element {
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function generate(): Promise<void> {
    setLoading(true)
    setError(null)
    setCopied(false)
    try {
      const res = await window.api.db.todos.draftReply(todo.id)
      if (res.error) {
        setError(res.error)
        setDraft('')
      } else {
        setDraft(res.draft ?? '')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void generate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todo.id])

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(draft)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('複製失敗（剪貼簿不可用）')
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>草擬回覆</strong>
          <button className="ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-sub muted">
          給「{chatName ?? todo.chatId}」 · 針對：{todo.title}
        </div>

        {loading ? (
          <div className="draft-box muted">AI 草擬中…</div>
        ) : error ? (
          <div className="draft-box draft-err">{error}</div>
        ) : (
          <textarea
            className="draft-box draft-text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={5}
            spellCheck={false}
          />
        )}

        <div className="modal-actions">
          <span className="muted draft-note">
            MVP：只草擬，<strong>不會送出</strong>。複製後請自行貼到 LINE。
          </span>
          <span style={{ flex: 1 }} />
          <button className="ghost" onClick={() => void generate()} disabled={loading}>
            重新產生
          </button>
          <button onClick={() => void copy()} disabled={loading || !draft}>
            {copied ? '已複製 ✓' : '複製'}
          </button>
        </div>
      </div>
    </div>
  )
}
