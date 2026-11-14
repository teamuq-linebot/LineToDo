export interface PhotoMessageGroupCandidate {
  msgId?: string
  chatId: string
  time: string
  ts?: number
  direction: 'in' | 'out'
  sender: string
  contentType: number
  unsent?: boolean
}

function fullTimestampMs(value: string): number | null {
  // Historical DTOs and live LINE rows use a full local ISO timestamp without
  // a zone suffix; epoch-ms `ts` is the canonical instant when available.
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))?$/.exec(value)
  if (!parts) return null
  const year = Number(parts[1])
  const month = Number(parts[2])
  const day = Number(parts[3])
  const hour = Number(parts[4])
  const minute = Number(parts[5])
  const second = Number(parts[6])
  const millisecond = Number((parts[7] ?? '').padEnd(3, '0'))
  const offsetHour = Number(parts[10] ?? 0)
  const offsetMinute = Number(parts[11] ?? 0)
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return null
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = month === 2 ? (leapYear ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31
  if (day < 1 || day > daysInMonth) return null
  const parsed = Date.parse(value)
  if (!parts[8]) {
    const local = new Date(0)
    local.setFullYear(year, month - 1, day)
    local.setHours(hour, minute, second, millisecond)
    if (local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== day ||
      local.getHours() !== hour || local.getMinutes() !== minute || local.getSeconds() !== second || local.getMilliseconds() !== millisecond) return null
    return local.getTime()
  }
  return Number.isFinite(parsed) ? parsed : null
}

function timestampMs(message: PhotoMessageGroupCandidate): number | null {
  if (fullTimestampMs(message.time) === null) return null
  if (message.ts !== undefined) return Number.isSafeInteger(message.ts) ? message.ts : null
  return fullTimestampMs(message.time)
}

function eligible(message: PhotoMessageGroupCandidate): boolean {
  return message.contentType === 1 && Boolean(message.msgId) && Boolean(message.chatId) &&
    (message.direction === 'out' || (message.direction === 'in' && Boolean(message.sender?.trim()))) &&
    message.unsent !== true && timestampMs(message) !== null
}

function visibleMinute(message: PhotoMessageGroupCandidate): number | null {
  const timestamp = timestampMs(message)
  return timestamp === null ? null : Math.floor(timestamp / 60_000)
}

function sameSender(first: PhotoMessageGroupCandidate, next: PhotoMessageGroupCandidate): boolean {
  // Outgoing direction is the UI's definite self identity, even if a raw row
  // has no sender name. Incoming rows still need a known, matching sender.
  const firstSender = first.sender?.trim()
  const nextSender = next.sender?.trim()
  const unknownNames = new Set(['未知發話者', '未知', '(未知)', 'unknown'])
  return first.direction === 'out' && next.direction === 'out' ||
    first.direction === 'in' && next.direction === 'in' && Boolean(firstSender) && firstSender === nextSender && !unknownNames.has(firstSender!.toLowerCase())
}

/**
 * Combines only adjacent, fully identified image rows with identical sender,
 * direction, chat, sender identity, and visible timestamp minute. This is a visual heuristic, not LINE
 * album metadata; callers retain every source message in each group.
 */
export function groupConsecutivePhotoMessages<T extends PhotoMessageGroupCandidate>(messages: readonly T[]): T[][] {
  const groups: T[][] = []
  for (const message of messages) {
    const previous = groups.at(-1)
    const first = previous?.[0]
    const canJoin = Boolean(first && eligible(message) && eligible(first) &&
      message.chatId === first.chatId && sameSender(first, message) &&
      message.direction === first.direction && visibleMinute(message) === visibleMinute(first))
    if (canJoin) previous!.push(message)
    else groups.push([message])
  }
  return groups
}
