import { useCallback, useState } from 'react'
import { KanbanBoard } from './Board/KanbanBoard'
import { GroupTopicsPanel } from '../features/groupTopics/GroupTopicsPanel'
import { parseBoolean, usePersistentState } from '../lib/uiState'

/**
 * 總覽：上方是原本的看板（今日摘要＋四欄），下方是可摺疊的群組議題區。
 * 議題區等看板第一次載入完成才掛載；摺疊時不掛載，所以不發任何請求。
 */
export function OverviewPage(): JSX.Element {
  const [topicsOpen, setTopicsOpen] = usePersistentState<boolean>('overview.topicsOpen', true, parseBoolean)
  const [boardLoaded, setBoardLoaded] = useState(false)
  const onFirstLoaded = useCallback(() => setBoardLoaded(true), [])

  return (
    <div className="overview-page">
      <KanbanBoard onFirstLoaded={onFirstLoaded} />
      <section className="overview-topics" aria-label="群組議題">
        <button
          type="button"
          className="overview-topics-toggle"
          aria-expanded={topicsOpen}
          onClick={() => setTopicsOpen(!topicsOpen)}
        >
          <span aria-hidden="true">{topicsOpen ? '▾' : '▸'}</span> 群組議題
        </button>
        {topicsOpen && !boardLoaded && <p className="muted" role="status">等待待辦載入完成後顯示群組議題…</p>}
        {topicsOpen && boardLoaded && <GroupTopicsPanel hideTitle />}
      </section>
    </div>
  )
}
