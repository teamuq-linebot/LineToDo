import type { TodoDTO } from '../../types/api'

function formatTimestamp(value: number | string): string | null {
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Use the first available linked source time; otherwise identify the todo creation time honestly. */
export function todoTriggerLabel(todo: Pick<TodoDTO, 'sourceTriggeredAt' | 'createdAt'>): string {
  const sourceTime = typeof todo.sourceTriggeredAt === 'number' && Number.isFinite(todo.sourceTriggeredAt)
    ? formatTimestamp(todo.sourceTriggeredAt)
    : null
  if (sourceTime) return `觸發 ${sourceTime}`
  return `建立 ${formatTimestamp(todo.createdAt) ?? todo.createdAt}`
}
