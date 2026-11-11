export interface PhotoMessageGroupCandidate {
  msgId?: string
  chatId: string
  time: string
  direction: 'in' | 'out'
  sender: string
  contentType: number
  unsent?: boolean
}

function exactTimestampMs(value: string): number | null {
  // Require an explicit full date/time and timezone; partial/local display times
  // are not sufficient evidence that two sends share an exact timestamp.
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value)
  if (!parts) return null
  const year = Number(parts[1])
  const month = Number(parts[2])
  const day = Number(parts[3])
  const hour = Number(parts[4])
  const minute = Number(parts[5])
  const second = Number(parts[6])
  const offsetHour = Number(parts[9] ?? 0)
  const offsetMinute = Number(parts[10] ?? 0)
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return null
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = month === 2 ? (leapYear ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31
  if (day < 1 || day > daysInMonth) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function eligible(message: PhotoMessageGroupCandidate): boolean {
  return message.contentType === 1 && Boolean(message.msgId) && Boolean(message.chatId) &&
    Boolean(message.sender.trim()) && (message.direction === 'in' || message.direction === 'out') &&
    message.unsent !== true && exactTimestampMs(message.time) !== null
}

/**
 * Combines only adjacent, fully identified image rows with identical sender,
 * direction, chat, and exact timestamp. This is a visual heuristic, not LINE
 * album metadata; callers retain every source message in each group.
 */
export function groupConsecutivePhotoMessages<T extends PhotoMessageGroupCandidate>(messages: readonly T[]): T[][] {
  const groups: T[][] = []
  for (const message of messages) {
    const previous = groups.at(-1)
    const first = previous?.[0]
    const canJoin = Boolean(first && eligible(message) && eligible(first) &&
      message.chatId === first.chatId && message.sender === first.sender &&
      message.direction === first.direction && exactTimestampMs(message.time) === exactTimestampMs(first.time))
    if (canJoin) previous!.push(message)
    else groups.push([message])
  }
  return groups
}
