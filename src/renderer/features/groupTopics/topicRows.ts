import type { GroupTopicDTO } from '../../../shared/api'
import type { GroupTopicsOverviewEntry } from './groupTopicsOverview'

export type TopicSortKey = 'chat' | 'title' | 'updated'
export type TopicSortDir = 'asc' | 'desc'

/** 議題列表的一列：一則議題加上它所屬聊天室的名稱。 */
export interface TopicRow {
  key: string
  chatId: string
  chatName: string
  topic: GroupTopicDTO
  overviewCompacted?: boolean
}

export const relevanceText: Record<GroupTopicDTO['relevance'], string> = {
  action: '行動相關', awareness: '知會相關', unrelated: '無關', unknown: '不確定'
}

const collator = new Intl.Collator('zh-Hant')

/** 只取已啟用群組的議題；沒有議題的群組不會產生任何列。 */
export function buildTopicRows(groups: GroupTopicsOverviewEntry[]): TopicRow[] {
  const rows: TopicRow[] = []
  for (const group of groups) {
    if (group.status !== 'enabled') continue
    const chatName = group.chat.name ?? '未命名群組'
    for (const topic of group.topics) {
      rows.push({ key: `${group.chat.chatId}\u0000${topic.topicId}`, chatId: group.chat.chatId, chatName, topic, ...(group.compacted ? { overviewCompacted: true } : {}) })
    }
  }
  return rows
}

/** chatId 為 null 表示不依聊天室篩選；query 以空白切成多個詞，每個詞都要出現在聊天室名稱、標題或摘要中（不分大小寫）。 */
export function filterTopicRows(rows: TopicRow[], filter: { chatId: string | null; query: string }): TopicRow[] {
  const tokens = filter.query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return rows.filter((row) => {
    if (filter.chatId !== null && row.chatId !== filter.chatId) return false
    if (tokens.length === 0) return true
    const haystack = `${row.chatName}\n${row.topic.title}\n${row.topic.summary}`.toLowerCase()
    return tokens.every((token) => haystack.includes(token))
  })
}

/** 排序是穩定的；聊天室與標題欄位相同時，以最後更新新到舊排列。 */
export function sortTopicRows(rows: TopicRow[], key: TopicSortKey, dir: TopicSortDir): TopicRow[] {
  const sign = dir === 'asc' ? 1 : -1
  const newestFirst = (a: TopicRow, b: TopicRow): number => b.topic.lastSourceTs - a.topic.lastSourceTs
  const compare = (a: TopicRow, b: TopicRow): number => {
    if (key === 'updated') return (a.topic.lastSourceTs - b.topic.lastSourceTs) * sign
    const text = key === 'chat' ? collator.compare(a.chatName, b.chatName) : collator.compare(a.topic.title, b.topic.title)
    return text !== 0 ? text * sign : newestFirst(a, b)
  }
  return [...rows].sort(compare)
}

/** 「MM/DD HH:mm」；時間無效時回傳空字串。 */
export function formatTopicTime(ts: number): string {
  const date = new Date(ts)
  if (!Number.isFinite(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
