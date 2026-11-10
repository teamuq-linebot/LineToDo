import { useEffect, useMemo, useRef, useState } from 'react'
import type { GroupTopicDTO } from '../../../shared/api'
import { ChatSwitch } from '../../components/ChatSwitch'
import { useHostCapabilities, useLineTodoApi } from '../../platform/LineTodoApi'
import { createOverviewRefresher, loadGroupTopicsOverview, overviewToEntries, type GroupTopicsOverviewChat, type GroupTopicsOverviewEntry } from './groupTopicsOverview'
import { TopicsTable } from './TopicsTable'
import { buildTopicRows, filterTopicRows, formatTopicTime, relevanceText, sortTopicRows, type TopicSortDir, type TopicSortKey } from './topicRows'

const ALL_GROUPS = '__all_groups__'

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

function topicMetaText(topic: GroupTopicDTO): string {
  const count = `${topic.evidenceCount} 則訊息`
  const time = formatTopicTime(topic.lastSourceTs)
  return time ? `最後更新 ${time} · ${count}` : count
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? `${fallback}：${error.message}` : fallback
}

interface Props {
  /** 提供時固定顯示此聊天室的議題，並隱藏全域群組選單。 */
  chatId?: string
  /** 嵌入聊天時指定聊天室類型；全域群組面板固定為群組。 */
  chatIsGroup?: boolean
  /** 嵌入聊天時顯示當前聊天室名稱。 */
  chatName?: string | null
  /** 嵌入聊天時使用較緊湊的標題與內容區。 */
  embedded?: boolean
  /** 外層（總覽頁）已提供標題時，不重複顯示面板自己的 h2。 */
  hideTitle?: boolean
}

export function GroupTopicsPanel({ chatId: scopedChatId, chatIsGroup = true, chatName, embedded = false, hideTitle = false }: Props = {}): JSX.Element {
  const lineTodoApi = useLineTodoApi()
  const caps = useHostCapabilities()
  const api = lineTodoApi.groupTopics
  const [chats, setChats] = useState<GroupTopicsOverviewChat[]>([])
  const viaOverview = !scopedChatId && !embedded && typeof api?.overview === 'function'
  // 全域模式（群組議題分頁）：列表永遠顯示全部已啟用群組的議題；篩選只決定列表範圍，篩到單一聊天室時才有該群的開關與分析按鈕。
  const globalMode = !scopedChatId && !embedded
  const [filterChatId, setFilterChatId] = useState(ALL_GROUPS)
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<TopicSortKey>('updated')
  const [sortDir, setSortDir] = useState<TopicSortDir>('desc')
  const overviewRefresh = useRef<(() => void) | null>(null)
  const chatId = scopedChatId ?? (globalMode && filterChatId !== ALL_GROUPS ? filterChatId : '')
  const selectedChatIsGroup = scopedChatId ? chatIsGroup : true
  const chatLabel = selectedChatIsGroup ? '群組' : '聊天室'
  const [enabled, setEnabled] = useState(false)
  const [topics, setTopics] = useState<GroupTopicDTO[]>([])
  const [overviewGroups, setOverviewGroups] = useState<GroupTopicsOverviewEntry[]>([])
  const [legacyOverviewLoading, setOverviewLoading] = useState(false)
  const [overviewLoaded, setOverviewLoaded] = useState(false)
  const [chatsLoaded, setChatsLoaded] = useState(false)
  const [overviewError, setOverviewError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(0)
  const [combined, setCombined] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [settling, setSettling] = useState(false)
  const requestVersion = useRef(0)
  const currentChatId = useRef(chatId)
  currentChatId.current = chatId

  useEffect(() => {
    if (viaOverview) return undefined
    let active = true
    void lineTodoApi.db.chats.list().then((rows) => {
      if (!active) return
      const groups = rows.filter((chat) => chat.isGroup)
      setChats(groups)
      setChatsLoaded(true)
    }).catch((loadError: unknown) => {
      if (active) {
        setChatsLoaded(true)
        setError(errorMessage(loadError, '讀取群組清單失敗'))
      }
    })
    return () => { active = false }
  }, [lineTodoApi, viaOverview])

  useEffect(() => {
    if (viaOverview) return undefined
    let active = true
    overviewRefresh.current = null
    if (!globalMode || !api || chats.length === 0) {
      setOverviewGroups([])
      setOverviewLoading(false)
      setOverviewError('')
      return () => { active = false }
    }

    const load = (): Promise<void> => loadGroupTopicsOverview(chats, api.list).then((groups) => {
      if (active) setOverviewGroups(groups)
    }).catch((loadError: unknown) => {
      if (active) setOverviewError(errorMessage(loadError, '群組議題總覽載入失敗'))
    })
    setOverviewGroups([])
    setOverviewError('')
    setOverviewLoading(true)
    void load().finally(() => {
      if (active) setOverviewLoading(false)
    })
    overviewRefresh.current = () => { void load() }
    return () => { active = false; overviewRefresh.current = null }
  }, [api, chats, globalMode, viaOverview])

  useEffect(() => {
    if (!viaOverview || !api) return undefined
    let active = true
    const load = async (): Promise<void> => {
      try {
        const rows = await api.overview!()
        if (!active) return
        setChats(rows.map((row) => ({ chatId: row.chatId, name: row.name })))
        setOverviewGroups(overviewToEntries(rows))
        setOverviewError('')
        setOverviewLoaded(true)
      } catch (loadError) {
        if (active) setOverviewError(errorMessage(loadError, '群組議題總覽載入失敗'))
      }
    }
    setOverviewError('')
    setOverviewLoaded(false)
    const refresher = createOverviewRefresher(load)
    overviewRefresh.current = () => refresher.request()
    refresher.request()
    // 只在這一輪真的有議題被寫入時才重拉（待辦-only 的輪次議題總覽不會變，省下一次 host 呼叫）。
    const stopListening = lineTodoApi.pipeline.onRun((run) => { if (run.topicChatIds && run.topicChatIds.length > 0) refresher.request() })
    return () => {
      active = false
      overviewRefresh.current = null
      refresher.dispose()
      stopListening()
    }
  }, [api, lineTodoApi, viaOverview])

  useEffect(() => {
    const version = ++requestVersion.current
    setTopics([])
    setEnabled(false)
    setPending(0)
    setCombined(false)
    setNotice('')
    setError('')
    setLoadError('')
    setBusy(false)
    setSettling(false)

    if (!api || !chatId) {
      setLoading(false)
      return () => { if (requestVersion.current === version) requestVersion.current += 1 }
    }

    setLoading(true)
    void loadChatTopics(chatId, version).catch((loadError: unknown) => {
      if (requestVersion.current === version) setLoadError(errorMessage(loadError, '議題資料載入失敗'))
    }).finally(() => {
      if (requestVersion.current === version) setLoading(false)
    })

    return () => { if (requestVersion.current === version) requestVersion.current += 1 }
  }, [api, chatId, selectedChatIsGroup])

  function stillShowing(chatIdAtStart: string, versionAtStart: number): boolean {
    return requestVersion.current === versionAtStart && currentChatId.current === chatIdAtStart
  }

  async function loadChatTopics(chatIdAtStart: string, versionAtStart: number): Promise<void> {
    if (!api || !chatIdAtStart) return
    const [result, pendingCount] = await Promise.all([
      api.list(chatIdAtStart),
      api.pendingCount(chatIdAtStart)
    ])
    if (!stillShowing(chatIdAtStart, versionAtStart)) return
    setEnabled(result.ok)
    setCombined(result.combined === true)
    setTopics(result.topics)
    setPending(pendingCount)
    setLoadError('')
  }

  async function retryTopics(): Promise<void> {
    if (!api || !chatId || loading) return
    const target = chatId
    const version = requestVersion.current
    setLoadError('')
    setLoading(true)
    try {
      await loadChatTopics(target, version)
    } catch (loadError: unknown) {
      if (stillShowing(target, version)) setLoadError(errorMessage(loadError, '議題資料載入失敗'))
    } finally {
      if (stillShowing(target, version)) setLoading(false)
    }
  }

  async function refresh(chatIdAtStart: string, versionAtStart: number): Promise<void> {
    if (!api || !chatIdAtStart) return
    const [result, pendingCount] = await Promise.all([
      api.list(chatIdAtStart), api.pendingCount(chatIdAtStart)
    ])
    if (!stillShowing(chatIdAtStart, versionAtStart)) return
    setEnabled(result.ok)
    setCombined(result.combined === true)
    setTopics(result.topics)
    setPending(pendingCount)
    setLoadError('')
  }

  async function toggleEnabled(value: boolean): Promise<void> {
    if (!api || !chatId || busy) return
    const target = chatId
    const version = requestVersion.current
    const previous = enabled
    setBusy(true)
    setError('')
    setNotice('')
    setEnabled(value)
    try {
      const result = await api.setEnabled(target, value)
      overviewRefresh.current?.()
      if (!stillShowing(target, version)) return
      if (!result.ok) {
        setEnabled(previous)
        setError('切換失敗，請再試一次')
        return
      }
      if (!value) {
        setTopics([])
        setPending(0)
      } else {
        setSettling(true)
        try {
          await refresh(target, version)
        } catch (refreshError) {
          if (stillShowing(target, version)) setLoadError(errorMessage(refreshError, '議題資料載入失敗'))
        } finally {
          if (stillShowing(target, version)) setSettling(false)
        }
      }
    } catch (actionError) {
      if (stillShowing(target, version)) {
        setEnabled(previous)
        setError('切換失敗，請再試一次')
      }
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
    setNotice(`正在分析此${chatLabel}最近訊息…`)
    try {
      const result = await api.analyze(target)
      overviewRefresh.current?.()
      if (!stillShowing(target, version)) return
      if (result.ok) {
        setNotice(result.analyzedCount === 0
          ? '沒有新增訊息待處理；既有議題結果已保留'
          : `已整理 ${result.analyzedCount ?? 0} 則新訊息，議題共 ${result.count ?? 0} 項`)
      } else if (result.failure) {
        setError(safeFailureNotice(result.failure))
      } else if (result.reason?.startsWith('unsupported_in_plugin')) {
        setError('議題的 AI 分析由 TeamUQ 的 ai:chat 提供，外掛尚未接上；既有議題與訊息不受影響')
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

  async function openSourceChat(target: string): Promise<void> {
    if (!target) return
    const version = requestVersion.current
    try {
      const result = await lineTodoApi.db.chats.openOriginal(target)
      // 版本號在聊天室切換時才會遞增，列表的列可能屬於其他聊天室，所以這裡只比對版本。
      if (requestVersion.current !== version) return
      if (!result.ok) setError(result.error ? `無法開啟來源聊天室：${result.error}` : '無法開啟來源聊天室')
      else setNotice('已開啟來源聊天室')
    } catch (actionError) {
      if (requestVersion.current === version) setError(errorMessage(actionError, '無法開啟來源聊天室'))
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

  const overviewLoading = viaOverview ? !overviewLoaded && !overviewError : globalMode && (!chatsLoaded || legacyOverviewLoading)
  const heading = embedded ? `此${chatLabel}的議題` : '群組議題'
  const topicsTitle = `此${chatLabel}的議題`
  const currentChatName = chatName ?? chats.find((chat) => chat.chatId === chatId)?.name ?? chatId
  const topicRowsAll = useMemo(() => (globalMode ? buildTopicRows(overviewGroups) : []), [globalMode, overviewGroups])
  const visibleTopicRows = useMemo(
    () => sortTopicRows(filterTopicRows(topicRowsAll, { chatId: filterChatId === ALL_GROUPS ? null : filterChatId, query }), sortKey, sortDir),
    [topicRowsAll, filterChatId, query, sortKey, sortDir]
  )
  const trimmedOverview = overviewGroups.some((group) => group.status === 'enabled' && ((group.topicCount ?? group.topics.length) > group.topics.length || !!group.compacted))

  function sortBy(key: TopicSortKey): void {
    if (key === sortKey) {
      setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortKey(key)
    setSortDir(key === 'updated' ? 'desc' : 'asc')
  }

  return (
    <section className={`settings-section group-topics-panel topics-recap${embedded ? ' embedded' : ''}`} aria-label={heading}>
      {!embedded && !hideTitle && <h2>{heading}</h2>}
      {!embedded && <details className="group-topics-help">
        <summary>議題分析說明與群組設定</summary>
        <p>議題分析需逐群啟用。已開啟「議題與待辦合併整理」時，新訊息的議題會在「立即整理」與背景整理時一併產生，舊訊息可用「補分析舊訊息」手動補上；否則需手動執行分析。所有群組總覽只讀取各群既有結果，不會自動啟用或分析群組。熱度、趨勢與觀測完整性尚未校準，會保持不確定。</p>
      </details>}
      {(embedded || chatId) && <div className="group-topics-head"><h3>聊天室近況</h3>{chatId && api && !loading && !loadError && <ChatSwitch label={`${topicsTitle}開關`} checked={enabled} busy={busy} onChange={(value) => void toggleEnabled(value)} testId="topics-switch" />}</div>}
      {!api && <p className="muted">此版本未提供議題分析功能。</p>}
      {embedded && !chatId && <p className="muted">目前沒有選取中的聊天室。</p>}
      {error && !chatId && <p className="group-topics-error" role="alert">{error}</p>}
      {globalMode && (
        <section className="group-topics-list" aria-label="群組議題列表">
          {overviewError && <p className="group-topics-error" role="alert">{overviewError}</p>}
          {overviewLoading && <p className="muted" role="status">載入中…</p>}
          {!overviewLoading && overviewGroups.filter((group) => group.status === 'failed').map((group) => (
            <p key={group.chat.chatId} className="group-topics-error" role="alert">讀取「{group.chat.name ?? '未命名群組'}」議題失敗：{group.error ?? '未知錯誤'}</p>
          ))}
          {!overviewLoading && !overviewError && topicRowsAll.length === 0 && <p className="muted">尚無議題</p>}
          {!overviewLoading && topicRowsAll.length > 0 && (
            <>
              <div className="topics-tools">
                <input type="search" aria-label="搜尋議題" placeholder="搜尋" value={query} onChange={(event) => setQuery(event.target.value)} />
                <label className="group-topics-group-select">聊天室
                  <select value={filterChatId} onChange={(event) => setFilterChatId(event.target.value)}>
                    <option value={ALL_GROUPS}>全部</option>
                    {chats.map((chat) => <option key={chat.chatId} value={chat.chatId}>{chat.name ?? '未命名群組'}</option>)}
                  </select>
                </label>
              </div>
              {trimmedOverview && <p className="muted" role="note">部分議題已縮短或未列出</p>}
              <TopicsTable
                rows={visibleTopicRows}
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={sortBy}
                resetKey={`${sortKey}|${sortDir}|${query}|${filterChatId}`}
                canOpenChat={caps.openOriginalChat === true}
                onOpenChat={(target) => void openSourceChat(target)}
                onShowTodoRefs={(topic) => void showTodoRefs(topic)}
              />
            </>
          )}
        </section>
      )}
      {chatId && (
        <>
          {loading && <p className="muted" role="status">正在載入「{currentChatName}」的議題…</p>}
          {loadError && <div className="group-topics-error group-topics-load-error" role="alert"><span>{loadError}</span><button type="button" className="link-btn" onClick={() => void retryTopics()} disabled={loading}>重試議題</button></div>}
          {error && <p className="group-topics-error" role="alert">{error}</p>}
          {notice && <p className="group-topics-notice" role="status">{notice}</p>}
          {!loading && api && (
            <>
              {enabled && !settling && <div className="group-topics-controls">
                {combined
                  ? (!embedded && (pending > 0 || busy)) && <button type="button" disabled={!api || !enabled || busy} onClick={() => void runAnalysis()}>{busy ? '補分析中…' : '補分析舊訊息'}</button>
                  : !embedded && <button type="button" disabled={!api || !enabled || busy} onClick={() => void runAnalysis()}>{busy ? '分析中…' : `分析最近${chatLabel}訊息`}</button>}
              </div>}
              {enabled && !settling && !globalMode && (
                <div className="group-topics-results">
                  {topics.length === 0 ? <p className="muted">尚無分析結果。</p> : topics.map((topic) => (
                    <article key={topic.topicId} className="group-topic-card">
                      <strong>{topic.title}</strong>
                      <p>{topic.summary}</p>
                      <small className="group-topic-meta" data-testid="group-topic-meta">{topicMetaText(topic)}</small>
                      <details data-testid="group-topic-details">
                        <summary>品質與來源細節（來源 {topic.evidenceCount} 則）</summary>
                        <small>本人參與：{topic.userParticipation === 'i_participated' ? '來源含本人送出的訊息' : '不確定'}。模型相關性描述（未驗證）：{topic.relevanceEvidence.length ? topic.relevanceEvidence.map((item) => `${relevanceText[item.relevance]}（參照 ${item.evidenceMsgIds.length} 則）`).join('、') : relevanceText[topic.relevance]}。已連結訊息 {topic.evidenceCount} 則（可能含重貼）；已知參與者下界 {topic.participantLowerBound ?? '不明'}。觀測完整性未校準；熱度未校準；趨勢不確定。</small>
                        {topic.evidenceMsgIds.length > 0 ? <ul>{topic.evidenceMsgIds.map((id) => <li key={id}><code>{id}</code></li>)}</ul> : <p className="muted">目前沒有可列出的來源訊息參照。</p>}
                      </details>
                      {caps.openOriginalChat && <button type="button" className="ghost" onClick={() => void openSourceChat(chatId)}>開啟來源聊天室</button>}
                      <button type="button" className="ghost" onClick={() => void showTodoRefs(topic)}>檢查既有待辦關聯</button>
                    </article>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}
