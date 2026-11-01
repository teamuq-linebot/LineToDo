import { useCallback, useEffect, useRef, useState } from 'react'
import type { TodoDTO } from '../../types/api'
import { useLineTodoApi } from '../../platform/LineTodoApi'
import { backendErrorText } from '../../lib/backendError'
import { fmtDue, isOverdue, isSuggestedDone, priorityLabel } from '../../components/Board/buckets'

interface Props {
  chatId: string
  chatName: string
}

function statusLabel(status: TodoDTO['status']): string {
  switch (status) {
    case 'pending': return '待辦'
    case 'waiting_reply': return '等回覆'
    case 'scheduled': return '行程'
    case 'suggested_done': return '建議完成，待確認'
    case 'done': return '已完成'
    case 'dismissed': return '已忽略'
  }
}

/** 只讀顯示目前聊天室的未完成待辦；不在聊天室面板增加寫入動作。 */
export function ChatTodosPanel({ chatId, chatName }: Props): JSX.Element {
  const api = useLineTodoApi()
  const requestVersion = useRef(0)
  const [todos, setTodos] = useState<TodoDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const version = ++requestVersion.current
    setLoading(true)
    setError(null)
    try {
      const rows = await api.db.todos.openByChat(chatId)
      if (requestVersion.current !== version) return
      setTodos(rows)
    } catch (loadError) {
      if (requestVersion.current !== version) return
      setError(backendErrorText(loadError, '讀取此聊天室待辦失敗'))
    } finally {
      if (requestVersion.current === version) setLoading(false)
    }
  }, [api, chatId])

  useEffect(() => {
    void load()
    const offTodos = api.pipeline.onTodosChanged(() => { void load() })
    return () => {
      requestVersion.current += 1
      offTodos()
    }
  }, [api, load])

  return (
    <section className="chat-todos-content" aria-label={`${chatName}的待辦`}>
      <header className="chat-todos-heading">
        <h3>此聊天室待辦</h3>
        <span>{chatName}</span>
      </header>
      {loading && <p className="muted" role="status">正在載入「{chatName}」的待辦…</p>}
      {error && (
        <p className="chat-todos-error" role="alert">
          {error}
          <button type="button" className="link-btn" onClick={() => void load()}>重試</button>
        </p>
      )}
      {!loading && !error && todos.length === 0 && <p className="muted">此聊天室目前沒有未完成待辦。</p>}
      {!error && todos.length > 0 && (
        <div className="chat-todo-list" aria-label={`${chatName}的未完成待辦清單`}>
          {todos.map((todo) => {
            const priority = priorityLabel(todo.priority)
            const due = fmtDue(todo.dueAt)
            const suggested = isSuggestedDone(todo)
            const overdue = isOverdue(todo.dueAt)
            return (
              <article
                key={todo.id}
                className={`todo-card chat-todo-card${suggested ? ' suggested' : ''}${overdue ? ' overdue' : ''}`}
              >
                <div className="card-top">
                  <strong className="card-title">{todo.title}</strong>
                  <span className={`prio-badge ${priority.cls}`}>{priority.text}</span>
                </div>
                <div className="card-meta">
                  <span>{statusLabel(todo.status)}</span>
                  <span>來源訊息 {todo.sourceMsgIds.length} 則</span>
                  {due && <span className={`card-due${overdue ? ' overdue' : ''}`}>期限 {due}</span>}
                </div>
                {(todo.detail || todo.completionEvidence) && (
                  <details className="chat-todo-details">
                    <summary>完整細節</summary>
                    {todo.detail && <p className="card-detail">{todo.detail}</p>}
                    {todo.completionEvidence && <p className="card-evidence">完成線索：{todo.completionEvidence}</p>}
                  </details>
                )}
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
