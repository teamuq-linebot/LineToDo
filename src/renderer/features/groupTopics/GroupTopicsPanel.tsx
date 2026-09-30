import { useEffect, useState } from 'react'
import type { ChatDTO, GroupTopicDTO, GroupTopicLinkCandidateDTO } from '../../../shared/api'

const relevanceText: Record<GroupTopicDTO['relevance'], string> = {
  action: '行動相關', awareness: '知會相關', unrelated: '無關', unknown: '不確定'
}

const failureCodeText: Record<string,string> = {
  invalid_shape: '輸出結構不符', invalid_value: '欄位值不符', duplicate_ref: '議題參照重複',
  duplicate_assignment: '訊息被重複指派', unknown_message_ref: '訊息參照不在本批輸入',
  unknown_topic_ref: '議題參照不存在', missing_assignment: '部分訊息沒有指派',
  invalid_evidence: '相關性證據不完整', too_many_topics: '議題數超出上限',
  invalid_json: '回應不是有效 JSON', persistence_failed: '結果保存失敗',
  not_installed: '找不到已設定的 AI 工具', not_authenticated: 'AI 工具尚未登入或驗證失敗',
  timeout: 'AI 工具逾時', rate_limited: 'AI 工具暫時限流', quota_exceeded: 'AI 額度不足',
  bad_output: 'AI 工具輸出無效', invalid_config: 'AI 設定無效', transport: 'AI 工具連線失敗', unknown: 'AI 工具發生未分類錯誤'
}

function safeFailureNotice(failure:{stage:string;path:string|null;code:string}):string {
  if (failure.stage==='provider_resolve') return 'AI provider 尚未就緒；訊息仍待處理，可檢查 AI 設定後重試'
  if (failure.stage==='provider_complete') return `AI provider 執行失敗：${failureCodeText[failure.code] ?? 'AI 工具執行失敗'}；訊息仍待處理，可重試`
  if (failure.stage==='response_decode') return 'AI 回應無法解碼；訊息仍待處理，可重試'
  if (failure.stage==='persist') return '議題結果保存失敗；訊息仍待處理，可重試'
  const pathLabels:Record<string,string>={
    '$':'輸出根節點','$.topics':'topics','$.topics[*].ref':'topics.ref','$.topics[*].title':'topics.title',
    '$.topics[*].summary':'topics.summary','$.assignments':'assignments','$.assignments[*]':'assignments[*]',
    '$.assignments[*].msgId':'assignments[*].msgId','$.assignments[*].topicRef':'assignments[*].topicRef',
    '$.assignments[*].relation':'assignments[*].relation','$.assignments[*].confidence':'assignments[*].confidence',
    '$.assignments[*].relevance':'assignments[*].relevance','$.assignments[*].relevanceEvidenceMsgIds':'assignments[*].relevanceEvidenceMsgIds'
  }
  return `AI 輸出契約未通過：${pathLabels[failure.path ?? '$'] ?? '輸出欄位'}，${failureCodeText[failure.code] ?? '格式不符'}；訊息仍待處理，可重試`
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
      setNotice(result.ok ? (result.analyzedCount === 0 ? '沒有新增訊息待處理；既有議題結果已保留' : `已整理 ${result.analyzedCount ?? 0} 則新訊息，議題共 ${result.count ?? 0} 項`) : result.failure ? safeFailureNotice(result.failure) : result.reason === 'provider_unavailable' ? 'AI provider 不可用；訊息仍待處理，可稍後重試' : '分析失敗；訊息仍待處理，可稍後重試')
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
      {enabled && <p>{busy ? '目前每批最多整理 20 則；若仍有待整理訊息，可再次執行。' : pending > 100 ? '有 100 則以上新訊息待整理；每批最多整理 20 則。' : pending > 0 ? `有 ${pending} 則新訊息待整理；每批最多整理 20 則。` : '沒有新增訊息待處理，既有議題結果已保留。'}</p>}
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
