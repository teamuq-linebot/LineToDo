import { overviewOmissionNotice, type GroupTopicsOverviewEntry } from './groupTopicsOverview'

/** 議題列以外的預算提示；即使群組整批議題都被省略，仍可在空列表旁看到。 */
export function TopicOverviewOmissionNotice({ groups }: { groups: GroupTopicsOverviewEntry[] }): JSX.Element | null {
  const notice = overviewOmissionNotice(groups)
  return notice ? <p className="topic-overview-note" role="status">{notice}</p> : null
}
