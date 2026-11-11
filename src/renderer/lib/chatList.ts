/** Local date label for the newest actual message. Missing/invalid timestamps stay unknown. */
export function chatMessageTimeLabel(timestamp: number | null, now = new Date()): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return '—'
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return '—'
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
  }
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

/** Newest real message first; unknown timestamps remain after known timestamps. */
export function compareChatMessageTimes(a: number | null, b: number | null): number {
  if (a === null || !Number.isFinite(a)) return b === null || !Number.isFinite(b) ? 0 : 1
  if (b === null || !Number.isFinite(b)) return -1
  return b - a
}
