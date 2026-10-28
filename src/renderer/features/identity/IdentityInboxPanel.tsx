import { useEffect, useMemo, useState } from 'react'
import type { ChatDTO, IdentityEntityTypeDTO, IdentityInspectDTO, IdentityReviewItemDTO, TodoTopicRelationDTO, TopicLinkProposalDTO } from '../../../shared/api'
import { useLineTodoApi } from '../../platform/LineTodoApi'

const reasonText:Record<string,string>={
  same_active_action:'可能是同一件進行中的事',same_completed_action:'可能是已完成的舊工作',reschedule:'可能是同一工作改期',fresh_occurrence:'可能是新一輪工作',distinct_action:'可能是同主題的另一項工作',
  ambiguous_candidates:'候選仍有歧義',insufficient_evidence:'證據不足',candidate_cap:'候選或輸入超過安全上限',related_topic:'可能與既有議題相關'
}
const stateText:Record<IdentityReviewItemDTO['state'],string>={open:'待確認',stale:'資料已變更，需重看',resolved:'已處理',dismissed:'已略過'}
const failureText:Record<string,string>={revision_conflict:'這項工作已被更新，請重新讀取後再操作',candidate_conflict:'候選項目已變更，工作仍保留',scope_denied:'目前群組權限不允許此關聯',identity_indexing:'歷史索引仍在整理，請稍後再試',source_missing:'來源訊息已不存在，工作仍保留',provider_unavailable:'AI 目前不可用，工作仍保留',input_too_large:'來源與候選超出安全輸入上限，工作仍保留',source_or_candidate_stale:'來源或候選已變更，工作仍保留'}

function draftRecord(value:unknown):Record<string,unknown>{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>: {}}
function text(value:unknown,fallback=''):string{return typeof value==='string'?value:fallback}

export function IdentityInboxPanel():JSX.Element{
  const api=useLineTodoApi()
  const identity=api.db.todos.identity
  const [chats,setChats]=useState<ChatDTO[]>([])
  const [chatId,setChatId]=useState('')
  const [entityType,setEntityType]=useState<IdentityEntityTypeDTO>('todo')
  const [items,setItems]=useState<IdentityReviewItemDTO[]>([])
  const [next,setNext]=useState<string|null>(null)
  const [selectedId,setSelectedId]=useState('')
  const [detail,setDetail]=useState<IdentityInspectDTO|null>(null)
  const [relations,setRelations]=useState<TodoTopicRelationDTO[]>([])
  const [links,setLinks]=useState<TopicLinkProposalDTO[]>([])
  const [loading,setLoading]=useState(false)
  const [busy,setBusy]=useState(false)
  const [notice,setNotice]=useState('')
  const [error,setError]=useState('')
  const selected=items.find((item)=>item.decisionId===selectedId)??items[0]??null
  const draft=draftRecord(detail?.item.draft??selected?.draft)
  const title=text(draft.title,draftRefLabel(selected))
  const groups=useMemo(()=>chats.filter((chat)=>chat.isGroup&&!chat.blocked),[chats])

  useEffect(()=>{
    let active=true
    void api.db.chats.list(false).then((rows)=>{if(active){setChats(rows);setChatId((current)=>current||rows[0]?.chatId||'')}}).catch((loadError:unknown)=>{if(active)setError(loadError instanceof Error?loadError.message:'聊天室清單載入失敗')})
    return()=>{active=false}
  },[api])

  async function load(reset=true):Promise<void>{
    if(!identity)return
    setLoading(true);setError('')
    try{
      const page=await identity.listPending({entityType,...(chatId?{chatId}:{}),...(reset?{}:next?{after:{decisionId:next}}:{}),limit:50})
      setItems((current)=>reset?page.items:[...current,...page.items])
      setNext(page.next?.decisionId??null)
      if(reset)setSelectedId(page.items[0]?.decisionId??'')
    }catch(loadError){setError(loadError instanceof Error?loadError.message:'延期工作載入失敗')}
    finally{setLoading(false)}
  }

  useEffect(()=>{void load(true)},[identity,entityType,chatId])
  useEffect(()=>{
    let active=true
    if(!identity||!chatId){setRelations([]);setLinks([]);return()=>{active=false}}
    void Promise.all([identity.todoTopicRelations(chatId),api.groupTopics?.linkProposals?.(chatId)??Promise.resolve([])]).then(([todoTopic,topicLinks])=>{
      if(active){setRelations(todoTopic);setLinks(topicLinks)}
    }).catch((loadError:unknown)=>{if(active)setError(loadError instanceof Error?loadError.message:'關聯候選載入失敗')})
    return()=>{active=false}
  },[identity,api.groupTopics,chatId])
  useEffect(()=>{
    let active=true
    if(!identity||!selected){setDetail(null);return()=>{active=false}}
    setDetail(null)
    void identity.inspect({entityType:selected.entityType,decisionId:selected.decisionId}).then((value)=>{if(active)setDetail(value)}).catch((loadError:unknown)=>{if(active)setError(loadError instanceof Error?loadError.message:'來源證據載入失敗')})
    return()=>{active=false}
  },[identity,selected?.entityType,selected?.decisionId,selected?.decisionRevision])

  async function refreshAfterAction(message:string):Promise<void>{
    setNotice(message);setError('');
    await load(true)
    if(chatId&&identity){
      try{const [todoTopic,topicLinks]=await Promise.all([identity.todoTopicRelations(chatId),api.groupTopics?.linkProposals?.(chatId)??Promise.resolve([])]);setRelations(todoTopic);setLinks(topicLinks)}catch{/* show action result; a later refresh retries these lists */}
    }
  }

  async function resolve(choice:{outcome:'existing'|'new'|'link'|'dismiss';candidateType?:IdentityEntityTypeDTO;candidateId?:string;relationKind?:'recurrence'|'related_action'|'follow_up'|'same_topic'}):Promise<void>{
    if(!identity||!selected||busy)return
    setBusy(true);setError('');setNotice('')
    try{
      const result=await identity.resolve({entityType:selected.entityType,decisionId:selected.decisionId,expectedDecisionRevision:selected.decisionRevision,expectedCandidateRevisions:selected.candidateRevisions,...choice})
      if(!result.ok){const message=failureText[result.reason]??`無法處理這項工作（${result.reason}）；工作仍保留`;await load(true);setError(message);return}
      await refreshAfterAction(result.state==='dismissed'?'已略過這筆延期草稿；原有 Todo／Topic 保留。':'已處理延期身份；切回看板或群組議題時會讀取更新後的資料。')
    }catch(actionError){const message=actionError instanceof Error?actionError.message:'處理失敗；工作仍保留';await load(true);setError(message)}
    finally{setBusy(false)}
  }

  async function retry():Promise<void>{
    if(!identity||!selected||busy)return
    setBusy(true);setError('');setNotice('正在用目前來源與候選重新判斷…')
    try{
      const result=await identity.retry({entityType:selected.entityType,decisionId:selected.decisionId,expectedDecisionRevision:selected.decisionRevision})
      if(!result.ok){const message=failureText[result.reason]??`重新判斷失敗（${result.reason}）；工作仍保留`;await load(true);setError(message)}
      else await refreshAfterAction('重新判斷完成；你可以檢視建議後再決定是否套用。')
    }catch(actionError){setError(actionError instanceof Error?actionError.message:'重新判斷失敗；工作仍保留')}
    finally{setBusy(false)}
  }

  async function resolveTodoTopicRelation(relation:TodoTopicRelationDTO,choice:'confirm'|'reject'):Promise<void>{
    if(!identity||busy)return
    setBusy(true);setError('');setNotice('')
    try{
      const result=await identity.resolveTodoTopicRelation({relationId:relation.relationId,expectedRevision:relation.revision,expectedTodoRevision:relation.todoRevision,expectedTopicRevision:relation.topicRevision,choice})
      if(!result.ok){const message=failureText[result.reason??'']??`關聯未更新（${result.reason??'unknown'}）；Todo 與 Topic 均保留`;await refreshAfterAction('');setError(message)}
      else await refreshAfterAction(choice==='confirm'?'已確認 Todo 與議題的關聯；兩個獨立項目都保留。':'已拒絕這條關聯；兩個獨立項目都保留。')
    }catch(actionError){setError(actionError instanceof Error?actionError.message:'關聯更新失敗；兩個項目都保留')}
    finally{setBusy(false)}
  }

  async function resolveTopicLink(link:TopicLinkProposalDTO,choice:'accept'|'reject'):Promise<void>{
    if(!api.groupTopics?.resolveLinkProposal||busy)return
    setBusy(true);setError('');setNotice('')
    try{
      const result=await api.groupTopics.resolveLinkProposal({linkId:link.linkId,expectedLinkRevision:link.linkRevision,leftTopicRevision:link.leftRevision,rightTopicRevision:link.rightRevision,choice})
      if(!result.ok){const message=failureText[result.reason??'']??`跨群關聯未更新（${result.reason??'unknown'}）；兩個議題均保留`;await refreshAfterAction('');setError(message)}
      else await refreshAfterAction(choice==='accept'?'已確認跨群議題關聯；兩個議題都保留，沒有合併或刪除。':'已拒絕跨群議題關聯；兩個議題都保留。')
    }catch(actionError){setError(actionError instanceof Error?actionError.message:'跨群關聯更新失敗；兩個議題都保留')}
    finally{setBusy(false)}
  }

  if(!identity)return <section className="identity-inbox"><h2>延期工作與關聯</h2><p className="muted">此版本未提供 identity review API。</p></section>

  return <section className="identity-inbox" aria-label="延期工作與關聯">
    <header className="identity-inbox-head"><div><h2>延期工作與關聯</h2><p>查看來源、歷史候選與理由；每次操作只處理一筆。拒絕關聯不會刪除獨立 Todo 或 Topic。</p></div><button type="button" onClick={()=>void load(true)} disabled={loading||busy}>重新整理</button></header>
    <div className="identity-inbox-filters">
      <label>工作類型<select value={entityType} onChange={(event)=>setEntityType(event.target.value as IdentityEntityTypeDTO)}><option value="todo">Todo 身份</option><option value="topic">Topic 身份</option></select></label>
      <label>聊天室<select value={chatId} onChange={(event)=>setChatId(event.target.value)}><option value="">所有聊天室</option>{chats.map((chat)=><option key={chat.chatId} value={chat.chatId}>{chat.name??chat.chatId}{chat.blocked?'（已封鎖）':''}</option>)}</select></label>
    </div>
    {error&&<p className="identity-error" role="alert">{error}</p>}{notice&&<p className="identity-notice" role="status">{notice}</p>}
    <div className="identity-inbox-columns">
      <aside className="identity-list" aria-label="延期清單">
        <h3>{entityType==='todo'?'Todo':'Topic'} 延期項目</h3>
        {loading&&<p className="muted" role="status">正在載入…</p>}
        {!loading&&items.length===0&&<p className="muted">目前沒有待確認項目。</p>}
        {items.map((item)=><button key={item.decisionId} type="button" className={`identity-list-item${selected?.decisionId===item.decisionId?' selected':''}`} onClick={()=>setSelectedId(item.decisionId)}>
          <strong>{text(draftRecord(item.draft).title,item.draftRef)}</strong><span>{stateText[item.state]} · {item.chatId}</span><small>{item.reasonCodes.map((reason)=>reasonText[reason]??reason).join('、')}</small>
        </button>)}
        {next&&<button type="button" disabled={loading||busy} onClick={()=>void load(false)}>載入更多</button>}
      </aside>
      <article className="identity-detail" aria-label="延期項目詳情">
        {!selected&&<p className="muted">選取一筆工作查看來源與候選。</p>}
        {selected&&<>
          <div className="identity-detail-head"><div><span className={`identity-state ${selected.state}`}>{stateText[detail?.item.state??selected.state]}</span><h3>{title||selected.draftRef}</h3></div><button type="button" onClick={()=>void retry()} disabled={busy||!['open','stale'].includes(selected.state)}>重新判斷</button></div>
          <p className="identity-reason">理由：{(detail?.item.reasonCodes??selected.reasonCodes).map((reason)=>reasonText[reason]??reason).join('、')||'尚未提供'}</p>
          {(detail?.item.state??selected.state)==='stale'&&<p className="identity-stale">來源、候選或權限已變更。工作仍保留；請重新檢視後再操作。</p>}
          {detail?.item.suggestedDecision&&<div className="identity-suggestion"><strong>重新判斷建議</strong><span>{reasonText[detail.item.suggestedDecision.reasonCode]??detail.item.suggestedDecision.reasonCode} · {detail.item.suggestedDecision.confidenceBand} 信心</span><button type="button" disabled={busy||detail.item.suggestedDecision.outcome==='defer'} onClick={()=>{const suggestion=detail.item.suggestedDecision!;void resolve({outcome:suggestion.outcome==='update_existing'?'existing':suggestion.outcome==='link'?'link':'new',...(suggestion.candidateType?{candidateType:suggestion.candidateType}:{}),...(suggestion.candidateId?{candidateId:suggestion.candidateId}:{}),...(suggestion.relationKind?{relationKind:suggestion.relationKind}:{})})}}>採用建議</button></div>}
          <section><h4>來源證據</h4>{detail?.sourceEvidence.length?detail.sourceEvidence.map((message)=><div key={message.msgId} className="identity-evidence"><small>{message.direction==='in'?'對方':'我方'} · {message.timeIso} · {message.msgId}</small><p>{message.text||'（沒有文字內容）'}</p></div>):<p className="muted">來源訊息資料目前不可讀；工作仍保留。</p>}</section>
          <section><h4>候選歷史項目（{selected.candidates.length}）</h4>{selected.candidates.length===0&&<p className="muted">沒有候選；可建立新項目或先保留。</p>}
            {selected.candidates.map((candidate)=><div key={`${candidate.entityType}:${candidate.entityId}`} className="identity-candidate"><div><strong>{candidate.title}</strong><small>{candidate.entityType==='todo'?'Todo':'Topic'} · {candidate.status??'狀態未知'} · {candidate.recallReasons.map((reason)=>reason==='exact_title'?'標題相似':reason==='source_overlap'?'來源重疊':reason==='history_alias'?'歷史名稱':'內容線索').join('、')}</small>{candidate.summary&&<p>{candidate.summary}</p>}</div>
              <div className="identity-actions">
                {candidate.entityType===selected.entityType&&<button type="button" disabled={busy} onClick={()=>void resolve({outcome:'existing',candidateType:candidate.entityType,candidateId:candidate.entityId})}>更新此項目</button>}
                {selected.entityType==='todo'&&candidate.entityType==='topic'&&<button type="button" disabled={busy} onClick={()=>void resolve({outcome:'link',candidateType:'topic',candidateId:candidate.entityId,relationKind:'same_topic'})}>連結此議題</button>}
                {candidate.entityType===selected.entityType&&<button type="button" disabled={busy} onClick={()=>void resolve({outcome:'link',candidateType:candidate.entityType,candidateId:candidate.entityId,relationKind:candidate.status==='done'?'recurrence':'related_action'})}>建立關聯</button>}
              </div>
            </div>)}
          </section>
          <div className="identity-actions identity-footer"><button type="button" disabled={busy} onClick={()=>void resolve({outcome:'new'})}>建立新項目</button><button type="button" disabled={busy} onClick={()=>void resolve({outcome:'dismiss'})}>略過這筆草稿</button></div>
        </>}
      </article>
    </div>
    <section className="identity-relations"><h3>Todo 與 Topic 關聯 · {groups.find((group)=>group.chatId===chatId)?.name??chatId??'選取群組'}</h3>
      {!chatId&&<p className="muted">選取聊天室後檢視關聯。</p>}
      {relations.map((relation)=><div className="identity-relation" key={relation.relationId}><div><strong>{relation.todoTitle} ↔ {relation.topicTitle}</strong><small>{relation.relationType==='same_topic'?'同一議題':'相關工作'} · {relation.status} · 來源 {relation.sourceMsgIds.join(', ')||'無'}</small></div>{relation.status==='proposed'&&<div className="identity-actions"><button type="button" disabled={busy} onClick={()=>void resolveTodoTopicRelation(relation,'confirm')}>確認關聯</button><button type="button" disabled={busy} onClick={()=>void resolveTodoTopicRelation(relation,'reject')}>拒絕關聯</button></div>}</div>)}
      {links.map((link)=><div className="identity-relation" key={link.linkId}><div><strong>{link.leftTitle} ↔ {link.rightTitle}</strong><small>{link.leftChatName??link.leftChatId} · {link.rightChatName??link.rightChatId} · {link.relation} · 事件證據 {link.eventEvidenceMsgIds.join(', ')||'無'}</small>{(link.stale||!link.permissionAllowed)&&<em>候選或跨群權限已變更，需重新分析。</em>}</div>{link.status==='proposed'&&!link.stale&&link.permissionAllowed&&<div className="identity-actions"><button type="button" disabled={busy} onClick={()=>void resolveTopicLink(link,'accept')}>確認跨群關聯</button><button type="button" disabled={busy} onClick={()=>void resolveTopicLink(link,'reject')}>拒絕跨群關聯</button></div>}</div>)}
      {chatId&&relations.length===0&&links.length===0&&<p className="muted">目前沒有待處理關聯。</p>}
    </section>
  </section>
}

function draftRefLabel(item:IdentityReviewItemDTO|null):string{return item?item.draftRef:'延期工作'}
