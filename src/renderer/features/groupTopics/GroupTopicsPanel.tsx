import { useEffect, useRef, useState } from 'react'
import type { ChatDTO, GroupTopicDTO, GroupTopicLinkCandidateDTO } from '../../../shared/api'
import { useHostCapabilities, useLineTodoApi } from '../../platform/LineTodoApi'

const relevanceText: Record<GroupTopicDTO['relevance'], string> = {
  action: '行動相關', awareness: '知會相關', unrelated: '無關', unknown: '不確定'
}

const failureCodeText: Record<string, string> = {
  invalid_shape: '輸出結構不符', invalid_value: '欄位值不符', duplicate_ref: '議題參照重複',
  duplicate_assignment: '訊息被重複指派', unknown_message_ref: '訊息參照不在本批輸入',
  unknown_topic_ref: '議題參照不存在', missing_assignment: '部分訊息沒有指派',
  invalid_evidence: '相關性證據不完整', too_many_topics: '議題數超出上限',
  invalid_json: '回應不是有效 JSON', persistence_failed: '結果保存失敗',
  not_installed: '找不到已設定的 AI 工具', not_authenticated: 'AI 工具尚未登入或驗證失敗',
  timeout: 'AI 工具逾時', rate_limited: 'AI 工具暫時限流', quota_exceeded: 'AI 額度不足',
  bad_output: 'AI 工具輸出無效', invalid_config: 'AI 設定無效', transport: 'AI 工具連線失敗', unknown: 'AI 工具發生未分類錯誤'
}

function safeFailureNotice(failure: { stage: string; path: string | null; code: string }): string {
  if (failure.stage === 'provider_resolve') return 'AI provider 尚未就緒；訊息仍待處理，可檢查 AI 設定後重試'
  if (failure.stage === 'provider_complete') return `AI provider 執行失敗：${failureCodeText[failure.code] ?? 'AI 工具執行失敗'}；訊息仍待處理，可重試`
  if (failure.stage === 'response_decode') return 'AI 回應無法解碼；訊息仍待處理，可重試'
  if (failure.stage === 'persist') return '議題結果保存失敗；訊息仍待處理，可重試'
  const pathLabels: Record<string, string> = {
    '$': '輸出根節點', '$.topics': 'topics', '$.topics[*].ref': 'topics.ref', '$.topics[*].title': 'topics.title',
    '$.topics[*].summary': 'topics.summary', '$.assignments': 'assignments', '$.assignments[*]': 'assignments[*]',
    '$.assignments[*].msgId': 'assignments[*].msgId', '$.assignments[*].topicRef': 'assignments[*].topicRef',
    '$.assignments[*].relation': 'assignments[*].relation', '$.assignments[*].confidence': 'assignments[*].confidence',
    '$.assignments[*].relevance': 'assignments[*].relevance', '$.assignments[*].relevanceEvidenceMsgIds': 'assignments[*].relevanceEvidenceMsgIds'
  }
  return `AI 輸出契約未通過：${pathLabels[failure.path ?? '$'] ?? '輸出欄位'}，${failureCodeText[failure.code] ?? '格式不符'}；訊息仍待處理，可重試`
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? `${fallback}：${error.message}` : fallback
}

interface Props {
  /** 提供時固定顯示此對話的議題，並隱藏全域群組選單。 */
  chatId?: string
  /** 嵌入聊天時使用較緊湊的標題與內容區。 */
  embedded?: boolean
}

export function GroupTopicsPanel({ chatId: scopedChatId, embedded = false }: Props = {}): JSX.Element {
  const lineTodoApi = useLineTodoApi()
  const caps = useHostCapabilities()
  const api = lineTodoApi.groupTopics
  const [chats, setChats] = useState<ChatDTO[]>([])
  const [globalChatId, setGlobalChatId] = useState('')
  const chatId = scopedChatId ?? globalChatId
  const [enabled, setEnabled] = useState(false)
  const [crossEnabled, setCrossEnabled] = useState(false)
  const [topics, setTopics] = useState<GroupTopicDTO[]>([])
  const [links, setLinks] = useState<GroupTopicLinkCandidateDTO[]>([])
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(0)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const requestVersion = useRef(0)
  const currentChatId = useRef(chatId)
  currentChatId.current = chatId

  useEffect(() => {
    let active = true
    void lineTodoApi.db.chats.list(false).then((rows) => {
      if (!active) return
      const groups = rows.filter((chat) => chat.isGroup && !chat.blocked)
      setChats(groups)
      setGlobalChatId((current) => current || groups[0]?.chatId || '')
    }).catch((loadError: unknown) => {
      if (active) setError(errorMessage(loadError, '讀取群組清單失敗'))
    })
    return () => { active = false }
  }, [lineTodoApi])

  useEffect(() => {
    const version = ++requestVersion.current
    setTopics([])
    setLinks([])
    setEnabled(false)
    setCrossEnabled(false)
    setPending(0)
    setNotice('')
    setError('')
    setBusy(false)

    if (!api || !chatId) {
      setLoading(false)
      return () => { if (requestVersion.current === version) requestVersion.current += 1 }
    }

    setLoading(true)
    void Promise.all([
      api.list(chatId),
      api.crossChatEnabled(chatId),
      api.linkCandidates(chatId),
      api.pendingCount(chatId)
    ]).then(([result, cross, candidates, pendingCount]) => {
      if (requestVersion.current !== version) return
      setEnabled(result.ok)
      setTopics(result.topics)
      setCrossEnabled(cross)
      setLinks(candidates)
      setPending(pendingCount)
    }).catch((loadError: unknown) => {
      if (requestVersion.current === version) setError(errorMessage(loadError, '議題資料載入失敗；可重新選取群組後重試'))
    }).finally(() => {
      if (requestVersion.current === version) setLoading(false)
    })

    return () => { if (requestVersion.current === version) requestVersion.current += 1 }
  }, [api, chatId])

  function stillShowing(chatIdAtStart: string, versionAtStart: number): boolean {
    return requestVersion.current === versionAtStart && currentChatId.current === chatIdAtStart
  }

  async function refresh(chatIdAtStart: string, versionAtStart: number): Promise<void> {
    if (!api || !chatIdAtStart) return
    const [result, candidates, pendingCount] = await Promise.all([
      api.list(chatIdAtStart), api.linkCandidates(chatIdAtStart), api.pendingCount(chatIdAtStart)
    ])
    if (!stillShowing(chatIdAtStart, versionAtStart)) return
    setEnabled(result.ok)
    setTopics(result.topics)
    setLinks(candidates)
    setPending(pendingCount)
  }

  async function toggleEnabled(value: boolean): Promise<void> {
    if (!api || !chatId || busy) return
    const target = chatId
    const version = requestVersion.current
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await api.setEnabled(target, value)
      if (!stillShowing(target, version)) return
      if (!result.ok) {
        setError('僅可為未封鎖群組啟用議題分析。')
        return
      }
      setEnabled(value)
      setNotice(value ? '已為此群組啟用議題分析' : '已停用；既有本機議題保留')
      if (!value) {
        setTopics([])
        setLinks([])
        setPending(0)
      } else {
        await refresh(target, version)
      }
    } catch (actionError) {
      if (stillShowing(target, version)) setError(errorMessage(actionError, '更新議題設定失敗'))
    } finally {
      if (stillShowing(target, version)) setBusy(false)
    }
  }

  async function runAnalysis(): Promise<void> {
    if (!api || !chatId || busy || !enabled) return
    const target = chatId
    const version = requestVersion.current
    setBusy(true)
    setError('')
    setNotice('正在分析此群最近訊息…')
    try {
      const result = await api.analyze(target)
      if (!stillShowing(target, version)) return
      if (result.ok) {
        setNotice(result.analyzedCount === 0
          ? '沒有新增訊息待處理；既有議題結果已保留'
          : `已整理 ${result.analyzedCount ?? 0} 則新訊息，議題共 ${result.count ?? 0} 項`)
      } else if (result.failure) {
        setError(safeFailureNotice(result.failure))
      } else if (result.reason?.startsWith('unsupported_in_plugin')) {
        setError('群組議題的 AI 分析由 TeamUQ 的 ai:chat 提供，外掛尚未接上；既有議題與訊息不受影響')
      } else if (result.reason === 'provider_unavailable') {
        setError('AI provider 不可用；訊息仍待處理，可稍後重試')
      } else {
        setError('分析失敗；訊息仍待處理，可稍後重試')
      }
      await refresh(target, version)
    } catch (actionError) {
      if (stillShowing(target, version)) setError(errorMessage(actionError, '分析失敗；訊息仍待處理，可稍後重試'))
    } finally {
      if (stillShowing(target, version)) setBusy(false)
    }
  }

  async function toggleCrossChat(value: boolean): Promise<void> {
    if (!api || !chatId || busy || !enabled) return
    const target = chatId
    const version = requestVersion.current
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await api.setCrossChatEnabled(target, value)
      if (!stillShowing(target, version)) return
      if (!result.ok) {
        setError('請先啟用此群議題分析。')
        return
      }
      setCrossEnabled(value)
      setNotice(value ? '已開啟跨群語意候選；人物一致性仍標為不確定' : '已停用跨群候選')
      if (value) {
        const candidates = await api.linkCandidates(target)
        if (stillShowing(target, version)) setLinks(candidates)
      }
    } catch (actionError) {
      if (stillShowing(target, version)) setError(errorMessage(actionError, '更新跨群候選設定失敗'))
    } finally {
      if (stillShowing(target, version)) setBusy(false)
    }
  }

  async function openSourceGroup(): Promise<void> {
    if (!chatId) return
    const target = chatId
    const version = requestVersion.current
    try {
      const result = await lineTodoApi.db.chats.openOriginal(target)
      if (!stillShowing(target, version)) return
      if (!result.ok) setError(result.error ? `無法開啟來源群組：${result.error}` : '無法開啟來源群組')
      else setNotice('已開啟來源群組')
    } catch (actionError) {
      if (stillShowing(target, version)) setError(errorMessage(actionError, '無法開啟來源群組'))
    }
  }

  async function showTodoRefs(topic: GroupTopicDTO): Promise<void> {
    if (!api) return
    const target = chatId
    const version = requestVersion.current
    try {
      const refs = await api.todoRefs(topic.topicId)
      if (!stillShowing(target, version)) return
      setNotice(refs.length ? `對應既有待辦 ${refs.length} 項；待辦仍由原管線管理` : '此議題沒有精確來源重疊的既有待辦')
    } catch (actionError) {
      if (stillShowing(target, version)) setError(errorMessage(actionError, '檢查既有待辦關聯失敗'))
    }
  }

  const heading = embedded ? '此群組的議題' : '群組議題'
  const currentGroupName = chats.find((chat) => chat.chatId === chatId)?.name ?? chatId

  return (
    <section className={`settings-section group-topics-panel${embedded ? ' embedded' : ''}`} aria-label={heading}>
      {!embedded && <h2>{heading}</h2>}
      {!embedded && <p>議題分析需逐群啟用並手動執行。熱度、趨勢與觀測完整性尚未校準，會保持不確定。</p>}
      {embedded && <div className="group-topics-head"><h3>{heading}</h3><span>{currentGroupName}</span></div>}
      {!api && <p className="muted">此版本未提供議題分析功能。</p>}
      {!embedded && chats.length === 0 && <p className="muted">目前沒有可用群組。</p>}
      {embedded && !chatId && <p className="muted">目前沒有選取中的群組。</p>}
      {!embedded && chats.length > 0 && (
        <label className="group-topics-group-select">群組
          <select value={chatId} onChange={(event) => setGlobalChatId(event.target.value)}>
            {chats.map((chat) => <option key={chat.chatId} value={chat.chatId}>{chat.name ?? '未命名群組'}</option>)}
          </select>
        </label>
      )}
      {chatId && (
        <>
          {loading && <p className="muted" role="status">正在載入「{currentGroupName}」的議題…</p>}
          {error && <p className="group-topics-error" role="alert">{error}</p>}
          {notice && <p className="group-topics-notice" role="status">{notice}</p>}
          {!loading && api && (
            <>
              <div className="group-topics-controls">
                <label><input type="checkbox" checked={enabled} disabled={!api || busy} onChange={(event) => void toggleEnabled(event.target.checked)} /> 啟用此群議題分析</label>
                <label><input type="checkbox" checked={crossEnabled} disabled={!api || !enabled || busy} onChange={(event) => void toggleCrossChat(event.target.checked)} /> 顯示跨群語意候選（人物一致性不會由此確認）</label>
                <button type="button" disabled={!api || !enabled || busy} onClick={() => void runAnalysis()}>{busy ? '分析中…' : '分析最近群組訊息'}</button>
              </div>
              {enabled && <p className="group-topics-pending">{busy ? '目前每批最多整理 20 則；若仍有待整理訊息，可再次執行。' : pending > 100 ? '有 100 則以上新訊息待整理；每批最多整理 20 則。' : pending > 0 ? `有 ${pending} 則新訊息待整理；每批最多整理 20 則。` : '沒有新增訊息待處理，既有議題結果已保留。'}</p>}
              {enabled && (
                <div className="group-topics-results">
                  <h3>此群近期議題</h3>
                  {topics.length === 0 ? <p className="muted">尚無分析結果。</p> : topics.map((topic) => (
                    <article key={topic.topicId} className="group-topic-card">
                      <strong>{topic.title}</strong>
                      <p>{topic.summary}</p>
                      <small>本人參與：{topic.userParticipation === 'i_participated' ? '來源含本人送出的訊息' : '不確定'}。模型相關性描述（未驗證）：{topic.relevanceEvidence.length ? topic.relevanceEvidence.map((item) => `${relevanceText[item.relevance]}（參照 ${item.evidenceMsgIds.length} 則）`).join('、') : relevanceText[topic.relevance]}。已連結訊息 {topic.evidenceCount} 則（可能含重貼）；已知參與者下界 {topic.participantLowerBound ?? '不明'}。熱度：未校準；趨勢：不確定。</small>
                      {topic.evidenceMsgIds.length > 0 && <details><summary>來源訊息參照（{topic.evidenceMsgIds.length}）</summary><ul>{topic.evidenceMsgIds.map((id) => <li key={id}><code>{id}</code></li>)}</ul></details>}
                      {caps.openOriginalChat && <button type="button" className="ghost" onClick={() => void openSourceGroup()}>開啟來源群組</button>}
                      <button type="button" className="ghost" onClick={() => void showTodoRefs(topic)}>檢查既有待辦關聯</button>
                    </article>
                  ))}
                  {crossEnabled && <section className="group-topic-cross-chat" aria-label="跨群候選">
                    <h3>跨群候選</h3>
                    {links.length === 0 ? <p className="muted">目前沒有足夠語意候選。</p> : links.map((link) => <p key={link.linkId}>{link.otherChatName ?? '其他群組'}：{link.topicTitle} — 關係不確定、人物一致性不確定（候選證據 {link.eventEvidenceCount} 則：{link.eventEvidenceMsgIds.join('、')}）</p>)}
                  </section>}
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}
