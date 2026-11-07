import { KanbanBoard } from './Board/KanbanBoard'

/**
 * 總覽只顯示原本的待辦看板（今日摘要＋四欄）。
 */
export function OverviewPage(): JSX.Element {
  return (
    <div className="overview-page">
      <KanbanBoard />
    </div>
  )
}
