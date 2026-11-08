import { KanbanBoard } from './Board/KanbanBoard'

/**
 * 總覽只顯示待辦看板（篩選列＋四欄）。
 */
export function OverviewPage(): JSX.Element {
  return (
    <div className="overview-page">
      <KanbanBoard />
    </div>
  )
}
