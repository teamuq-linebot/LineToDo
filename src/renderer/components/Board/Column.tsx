import type { TodoDTO } from '../../types/api'
import type { ColumnDef } from './buckets'
import { TodoCard, type TodoCardActions } from './TodoCard'
import type { ChatNameMap } from '../../store/useTodos'
import type { BoardDnd } from './KanbanBoard'

/**
 * Column — 看板單欄（待辦 / 等回覆 / 行程 / 已完成）。
 * 頂部標題 + 計數；下方垂直排列該欄的卡片。
 */

interface Props {
  def: ColumnDef
  todos: TodoDTO[]
  chatMap: ChatNameMap
  actions: TodoCardActions
  groupByChat: boolean
  viewedLocalIds: Set<string>
  dnd: BoardDnd
}

interface TodoChatGroup {
  chatId: string
  todos: TodoDTO[]
}

function groupTodosByChat(todos: TodoDTO[]): TodoChatGroup[] {
  const groups: TodoChatGroup[] = []
  const seen = new Map<string, TodoChatGroup>()
  for (const todo of todos) {
    const existing = seen.get(todo.chatId)
    if (existing) {
      existing.todos.push(todo)
      continue
    }
    const group = { chatId: todo.chatId, todos: [todo] }
    seen.set(todo.chatId, group)
    groups.push(group)
  }
  return groups
}

export function Column({
  def,
  todos,
  chatMap,
  actions,
  groupByChat,
  viewedLocalIds,
  dnd
}: Props): JSX.Element {
  const groups = groupByChat ? groupTodosByChat(todos) : []

  function renderCard(todo: TodoDTO): JSX.Element {
    return (
      <TodoCard
        key={todo.id}
        todo={todo}
        chatName={chatMap[todo.chatId]?.name ?? null}
        isGroup={chatMap[todo.chatId]?.isGroup ?? false}
        viewedLocally={viewedLocalIds.has(todo.id)}
        showLocalViewed={def.id === 'done'}
        actions={actions}
        dnd={{
          dragging: dnd.draggingId === todo.id,
          onDragStart: dnd.onCardDragStart,
          onDragEnd: dnd.onCardDragEnd
        }}
      />
    )
  }

  return (
    <section
      className={`kb-column col-${def.id}${dnd.dragOverCol === def.id ? ' drop-active' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        dnd.onColumnDragOver(def.id)
      }}
      onDrop={(e) => {
        e.preventDefault()
        const id = e.dataTransfer.getData('text/plain') || dnd.draggingId || ''
        if (id) dnd.onColumnDrop(def.id, id)
      }}
    >
      <header className="kb-col-head">
        <span className="kb-col-title">{def.title}</span>
        <span className="kb-col-count">{todos.length}</span>
      </header>
      <div className="kb-col-body">
        {todos.length === 0 ? (
          <div className="kb-col-empty muted">{def.emptyHint}</div>
        ) : groupByChat ? (
          groups.map((group) => {
            const info = chatMap[group.chatId]
            return (
              <div key={group.chatId} className="todo-chat-group">
                <div className="todo-chat-group-head">
                  <span className="todo-chat-group-name" title={group.chatId}>
                    {info?.isGroup ? '👥 ' : '💬 '}
                    {info?.name ?? group.chatId}
                  </span>
                  <span className="todo-chat-group-count">{group.todos.length} 件</span>
                </div>
                <div className="todo-chat-group-items">{group.todos.map(renderCard)}</div>
              </div>
            )
          })
        ) : (
          todos.map(renderCard)
        )}
      </div>
    </section>
  )
}
