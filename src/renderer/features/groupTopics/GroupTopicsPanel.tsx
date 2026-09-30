import { useEffect, useState } from 'react'
import type { ChatDTO, GroupTopicDTO, GroupTopicLinkCandidateDTO } from '../../../shared/api'

const relevanceText: Record<GroupTopicDTO['relevance'], string> = {
  action: '行動相關', awareness: '知會相關', unrelated: '無關', unknown: '不確定'
}

export function GroupTopicsPanel(): JSX.Element {
  const api = window.api.groupTopics
  const [chats, setChats] = useState<ChatDTO[]>([])
  const [chatId, setChatId] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [crossEnabled, setCrossEnabled] = useState(false)
  const [topics, setTopics] = useState<GroupTopicDTO[]>([])
  const [links, setLinks] = useState<GroupTopicLinkCandidateDTO[]>([])
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState(0)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    void window.api.db.chats.list(false).then((rows) => {
      const groups = rows.filter((chat) => chat.isGroup && !chat.blocked)
      setChats(groups)
      setChatId((current) => current || groups[0]?.chatId || '')
    })
  }, [])

  useEffect(() => {
    let active = true
    if (!api || !chatId) { setTopics([]); setLinks([]); setEnabled(false); setCrossEnabled(false); setPending(0); return }
    void Promise.all([api.list(chatId), api.crossChatEnabled(chatId), api.linkCandidates(chatId), api.pendingCount(chatId)]).then(([result, cross, candidates, pendingCount]) => {
      if (!active) return
      setEnabled(result.ok)
      setTopics(result.topics)
      setCrossEnabled(cross)
      setLinks(candidates)
      setPending(pendingCount)
    }).catch(() => { if (active) setNotice('議題功能尚未啟用或資料庫不可用') })
    return () => { active = false }
  }, [api, chatId])

  const refresh = async (): Promise<void> => {
    if (!api || !chatId) return
    const [result, candidates, pendingCount] = await Promise.all([api.list(chatId), api.linkCandidates(chatId), api.pendingCount(chatId)])
    setEnabled(result.ok); setTopics(result.topics); setLinks(candidates); setPending(pendingCount)
  }

  const toggleEnabled = async (value: boolean): Promise<void> => {
    if (!api || !chatId) return
    const result = await api.setEnabled(chatId, value)
    setEnabled(result.ok && value)
    setNotice(result.ok ? (value ? '已為此群組啟用議題分析' : '已停用；既有本機議題保留') : '僅可為未封鎖群組啟用')
    if (!value) { setTopics([]); setLinks([]); setPending(0) }
    else await refresh()
  }

  const runAnalysis = async (): Promise<void> => {
    if (!api || !chatId) return
    setBusy(true); setNotice('正在分析此群最近訊息…')
    try {
      const result = await api.analyze(chatId)
      setNotice(result.ok ? (result.analyzedCount === 0 ? '沒有新增訊息待處理；既有議題結果已保留' : `已整理 ${result.analyzedCount ?? 0} 則新訊息，議題共 ${result.count ?? 0} 項`) : result.reason === 'provider_unavailable' ? 'AI provider 不可用；訊息仍待處理，可稍後重試' : '分析失敗；訊息仍待處理，可稍後重試')
      await refresh()
    } catch { setNotice('分析失敗；可稍後重試') }
    finally { setBusy(false) }
  }

  const toggleCrossChat = async (value: boolean): Promise<void> => {
    if (!api || !chatId) return
    const result = await api.setCrossChatEnabled(chatId, value)
    setCrossEnabled(result.ok && value)
    setNotice(result.ok ? (value ? '已開啟跨群語意候選；人物一致性仍標為不確定' : '已停用跨群候選') : '請先啟用此群議題分析')
  }

  return <section className="settings-section">
    <h2>群組議題</h2>
    <p>議題分析需逐群啟用並手動執行。熱度、趨勢與觀測完整性尚未校準，會保持不確定。</p>
    {!api && <p>此版本未提供議題分析功能。</p>}
    {chats.length === 0 ? <p>目前沒有可用群組。</p> : <>
      <label>群組 <select value={chatId} onChange={(event) => setChatId(event.target.value)}>
        {chats.map((chat) => <option key={chat.chatId} value={chat.chatId}>{chat.name ?? '未命名群組'}</option>)}
      </select></label>
      <p><label><input type="checkbox" checked={enabled} disabled={!api} onChange={(event) => void toggleEnabled(event.target.checked)} /> 啟用此群議題分析</label></p>
      <p><label><input type="checkbox" checked={crossEnabled} disabled={!api || !enabled} onChange={(event) => void toggleCrossChat(event.target.checked)} /> 顯示跨群語意候選（人物一致性不會由此確認）</label></p>
      <button type="button" disabled={!api || !enabled || busy} onClick={() => void runAnalysis()}>{busy ? '分析中…' : '分析最近群組訊息'}</button>
      {enabled && <p>{busy ? '目前訊息正在整理；若失敗可重試。' : pending > 100 ? '有 100 則以上新訊息待整理。' : pending > 0 ? `有 ${pending} 則新訊息待整理。` : '沒有新增訊息待處理，既有議題結果已保留。'}</p>}
      {notice && <p role="status">{notice}</p>}
      {enabled && <div>
        <h3>此群近期議題</h3>
        {topics.length === 0 ? <p>尚無分析結果。</p> : topics.map((topic) => <article key={topic.topicId} style={{ borderTop: '1px solid var(--border, #555)', padding: '10px 0' }}>
          <strong>{topic.title}</strong><p>{topic.summary}</p>
          <small>本人參與：{topic.userParticipation === 'i_participated' ? '來源含本人送出的訊息' : '不確定'}。模型相關性描述（未驗證）：{topic.relevanceEvidence.length ? topic.relevanceEvidence.map((item) => `${relevanceText[item.relevance]}（參照 ${item.evidenceMsgIds.length} 則）`).join('、') : relevanceText[topic.relevance]}。已連結訊息 {topic.evidenceCount} 則（可能含重貼）；已知參與者下界 {topic.participantLowerBound ?? '不明'}。熱度：未校準；趨勢：不確定。</small>
          {topic.evidenceMsgIds.length > 0 && <details><summary>來源訊息參照（{topic.evidenceMsgIds.length}）</summary><ul>{topic.evidenceMsgIds.map((id) => <li key={id}><code>{id}</code></li>)}</ul></details>}
          <button type="button" onClick={() => void window.api.db.chats.openOriginal(chatId)}>開啟來源群組</button>
          <button type="button" onClick={() => void api?.todoRefs(topic.topicId).then((refs) => setNotice(refs.length ? `對應既有待辦 ${refs.length} 項；待辦仍由原管線管理` : '此議題沒有精確來源重疊的既有待辦'))}>檢查既有待辦關聯</button>
        </article>)}
        {crossEnabled && <><h3>跨群候選</h3>{links.length === 0 ? <p>目前沒有足夠語意候選。</p> : links.map((link) => <p key={link.linkId}>{link.otherChatName ?? '其他群組'}：{link.topicTitle} — 關係不確定、人物一致性不確定（候選證據 {link.eventEvidenceCount} 則：{link.eventEvidenceMsgIds.join('、')}）</p>)}</>}
      </div>}
    </>}
  </section>
}
