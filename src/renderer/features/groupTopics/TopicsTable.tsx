import { useCallback, useEffect, useRef, useState } from 'react'
import type { GroupTopicDTO } from '../../../shared/api'
import { formatTopicTime, relevanceText, type TopicRow, type TopicSortDir, type TopicSortKey } from './topicRows'

/**
 * 群組議題列表：一列一則議題，欄位為聊天室／議題／最後更新。
 * 分批渲染沿用看板欄的做法（見 components/Board/Column.tsx）：先畫前 TOPIC_PAGE_SIZE 列，哨兵進入視野再補一批。
 * resetKey（排序、搜尋、篩選）改變時回到第一批。
 */

export const TOPIC_PAGE_SIZE = 30

const SORT_KEYS: TopicSortKey[] = ['chat', 'title', 'updated']
const SORT_LABELS: Record<TopicSortKey, string> = { chat: '聊天室', title: '議題', updated: '最後更新' }

interface Props {
  rows: TopicRow[]
  sortKey: TopicSortKey
  sortDir: TopicSortDir
  onSort: (key: TopicSortKey) => void
  resetKey: string
  canOpenChat: boolean
  onOpenChat: (chatId: string) => void
  onShowTodoRefs: (topic: GroupTopicDTO) => void
}

function qualityText(topic: GroupTopicDTO): string {
  const participation = topic.userParticipation === 'i_participated' ? '來源含本人送出的訊息' : '不確定'
  const relevance = topic.relevanceEvidence.length
    ? topic.relevanceEvidence.map((item) => relevanceText[item.relevance]).join('、')
    : relevanceText[topic.relevance]
  return `本人參與：${participation}。模型相關性描述（未驗證）：${relevance}。觀測完整性未校準。`
}

export function TopicsTable({ rows, sortKey, sortDir, onSort, resetKey, canOpenChat, onOpenChat, onShowTodoRefs }: Props): JSX.Element {
  const [batch, setBatch] = useState({ key: resetKey, shown: TOPIC_PAGE_SIZE })
  let shown = batch.shown
  if (batch.key !== resetKey) {
    shown = TOPIC_PAGE_SIZE
    setBatch({ key: resetKey, shown })
  }
  const hasMore = rows.length > shown
  const visible = hasMore ? rows.slice(0, shown) : rows
  const sentinelRef = useRef<HTMLDivElement>(null)
  const loadMore = useCallback((all = false) => {
    setBatch((cur) => ({ key: resetKey, shown: all ? Number.MAX_SAFE_INTEGER : (cur.key === resetKey ? cur.shown : TOPIC_PAGE_SIZE) + TOPIC_PAGE_SIZE }))
  }, [resetKey])

  // 哨兵進入視野就補一批；每補一批重新觀察，所以批次仍填不滿畫面時會接著補。
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!hasMore || !sentinel) return
    if (typeof IntersectionObserver === 'undefined') {
      loadMore(true)
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore()
    }, { rootMargin: '0px 0px 160px 0px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, shown, loadMore])

  return (
    <table className="topics-table" data-testid="topics-table">
      <thead>
        <tr>
          {SORT_KEYS.map((key) => (
            <th
              key={key}
              scope="col"
              className={`topics-col-${key}`}
              aria-sort={sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
            >
              <button type="button" className="topics-sort" onClick={() => onSort(key)}>
                {SORT_LABELS[key]}
                {sortKey === key && <span aria-hidden="true">{sortDir === 'asc' ? ' ↑' : ' ↓'}</span>}
              </button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr><td colSpan={3} className="muted">沒有符合的議題</td></tr>
        )}
        {visible.map((row) => {
          const { topic } = row
          return (
            <tr key={row.key} className="topics-row" data-testid="topic-row">
              <td className="topics-col-chat">{row.chatName}</td>
              <td className="topics-col-topic">
                <strong className="card-title">{topic.title}</strong>
                {topic.summary && <p className="card-detail topic-minutes-summary">{topic.summary}</p>}
                {row.overviewCompacted && <p className="topic-overview-note">總覽內容已縮短；開啟聊天室的單群議題可閱讀完整紀錄。</p>}
                <details className="topics-disclosure">
                  <summary>細節（來源 {topic.evidenceMsgIds.length} 則）</summary>
                  <div className="card-meta">{qualityText(topic)}</div>
                  {topic.evidenceMsgIds.length > 0
                    ? <ul>{topic.evidenceMsgIds.map((id) => <li key={id}><code>{id}</code></li>)}</ul>
                    : <p className="muted">目前沒有可列出的來源訊息參照。</p>}
                  <div className="card-actions">
                    {canOpenChat && <button type="button" className="ghost" onClick={() => onOpenChat(row.chatId)}>開啟來源聊天室</button>}
                    <button type="button" className="ghost" onClick={() => onShowTodoRefs(topic)}>檢查既有待辦關聯</button>
                  </div>
                </details>
              </td>
              <td className="topics-col-time">{formatTopicTime(topic.lastSourceTs) || '-'}</td>
            </tr>
          )
        })}
        {hasMore && (
          <tr>
            <td colSpan={3} className="topics-sentinel-cell">
              <div ref={sentinelRef} className="topics-sentinel" data-testid="topics-sentinel" aria-hidden="true" />
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}
