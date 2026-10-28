import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { getMessagesByChatAndIds } from '../db/messages.repo'
import { createTodo, getTodo, updateTodo } from '../db/todos.repo'
import { advanceIdentityIndex, captureIdentitySnapshot, insertIdentityEvent, recallTodoIdentityCandidates, recallTopicIdentityCandidates, refreshTodoIdentityTerms, syncTopicIdentityTerms, tableExists } from '../db/identity.repo'
import { readChatSourceState, runImmediateTransaction } from '../db/sourceCache'
import { IDENTITY_QUERY_VERSION, type IdentityCandidate, type IdentityContextSnapshot, type IdentityDecision } from '../../shared/identityDecision'
import { assertIdentitySnapshotCurrent } from '../db/identity.repo'

export type IdentityEntityType='todo'|'topic'
export interface IdentityCandidateRevision { entityType:IdentityEntityType;entityId:string;revision:number }
export interface IdentityReviewItem {
  entityType:IdentityEntityType
  decisionId:string
  chatId:string
  sourceDigest:string
  draftRef:string
  outcome:'update_existing'|'new'|'link'|'defer'
  state:'open'|'stale'|'resolved'|'dismissed'
  canonicalId:string|null
  decisionRevision:number
  sourceEpoch:number
  scopeRevision:number
  identityRevision:number
  topicIdentityRevision:number
  draft:unknown
  reasonCodes:string[]
  candidates:IdentityCandidate[]
  candidateRevisions:IdentityCandidateRevision[]
  sourceMsgIds:string[]
  suggestedDecision?:IdentityDecision|null
  updatedAt:string
}

type DecisionRow={decision_id:string;chat_id:string;source_digest:string;draft_ref:string;outcome:IdentityReviewItem['outcome'];state:IdentityReviewItem['state'];canonical_id:string|null;decision_revision:number;source_epoch:number;scope_revision:number;identity_revision:number;topic_identity_revision?:number;draft_json:string;candidate_snapshot_json:string;reason_codes_json:string;updated_at:string}

function parseJson<T>(raw:string,fallback:T):T { try{return JSON.parse(raw) as T}catch{return fallback} }
function decisionTable(type:IdentityEntityType):string{return type==='todo'?'todo_identity_decisions':'topic_identity_decisions'}
function sourceTable(type:IdentityEntityType):string{return type==='todo'?'todo_identity_decision_sources':'topic_identity_decision_sources'}
function eventTable(type:IdentityEntityType):'todo_identity_events'|'topic_identity_events'{return type==='todo'?'todo_identity_events':'topic_identity_events'}
function canonicalColumn(type:IdentityEntityType):string{return type==='todo'?'canonical_todo_id':'canonical_topic_id'}
function currentIdentityRevision(db:Database,chatId:string,type:IdentityEntityType):number {
  const state=readChatSourceState(db,chatId)
  return type==='todo'?state?.todoIdentityRevision??-1:state?.topicIdentityRevision??-1
}
function revisionOf(db:Database,type:IdentityEntityType,chatId:string,id:string):number|null {
  const row=type==='todo'
    ? db.prepare('SELECT entity_revision AS revision FROM todos WHERE chat_id=? AND id=?').get(chatId,id) as {revision:number}|undefined
    : db.prepare('SELECT revision FROM discussion_topics WHERE chat_id=? AND topic_id=?').get(chatId,id) as {revision:number}|undefined
  return row?.revision??null
}
function snapshotRevisions(raw:string):IdentityCandidateRevision[] {
  const parsed=parseJson<{revisions?:unknown}>(raw,{})
  return Array.isArray(parsed.revisions)?parsed.revisions.filter((value):value is IdentityCandidateRevision=>!!value&&typeof value==='object'&&['todo','topic'].includes(String((value as IdentityCandidateRevision).entityType))&&typeof (value as IdentityCandidateRevision).entityId==='string'&&typeof (value as IdentityCandidateRevision).revision==='number'):[]
}
function candidateDtos(db:Database,chatId:string,revisions:IdentityCandidateRevision[]):IdentityCandidate[] {
  return revisions.flatMap((ref):IdentityCandidate[]=>{
    if(ref.entityType==='todo'){
      const row=db.prepare('SELECT id,title,detail,status,bucket,due_at FROM todos WHERE chat_id=? AND id=?').get(chatId,ref.entityId) as {id:string;title:string;detail:string|null;status:string;bucket:string;due_at:string|null}|undefined
      return row?[{entityType:'todo' as const,entityId:row.id,title:row.title,summary:row.detail,status:row.status,bucket:row.bucket,dueAt:row.due_at,sourceMsgIds:[],recallReasons:['token_overlap' as const],completionEventTs:null}]:[]
    }
    const row=db.prepare('SELECT topic_id,title,summary FROM discussion_topics WHERE chat_id=? AND topic_id=?').get(chatId,ref.entityId) as {topic_id:string;title:string;summary:string}|undefined
    return row?[{entityType:'topic' as const,entityId:row.topic_id,title:row.title,summary:row.summary,status:null,bucket:null,dueAt:null,sourceMsgIds:[],recallReasons:['token_overlap' as const],completionEventTs:null}]:[]
  })
}

function markStale(db:Database,type:IdentityEntityType,row:DecisionRow,now:string):void {
  if(row.state!=='open') return
  const state=readChatSourceState(db,row.chat_id)
  const currentRevision=currentIdentityRevision(db,row.chat_id,type)
  const revisions=snapshotRevisions(row.candidate_snapshot_json)
  const candidateStale=revisions.some((candidate)=>revisionOf(db,candidate.entityType,row.chat_id,candidate.entityId)!==candidate.revision)
  const relatedTopicStale=type==='todo'&&state?.topicIdentityRevision!==row.topic_identity_revision
  if(!state||state.sourceEpoch!==row.source_epoch||state.scopeRevision!==row.scope_revision||currentRevision!==row.identity_revision||relatedTopicStale||candidateStale){
    db.prepare(`UPDATE ${decisionTable(type)} SET state='stale',updated_at=? WHERE decision_id=? AND state='open' AND decision_revision=?`).run(now,row.decision_id,row.decision_revision)
    const eventRevision=(db.prepare(`SELECT COALESCE(MAX(event_revision),0)+1 AS revision FROM ${eventTable(type)} WHERE decision_id=?`).get(row.decision_id) as {revision:number}).revision
    insertIdentityEvent(db,{decisionId:row.decision_id,revision:eventRevision,actor:'system',action:'stale',payload:{sourceEpoch:state?.sourceEpoch??null,scopeRevision:state?.scopeRevision??null,identityRevision:currentRevision,candidateStale},table:eventTable(type)})
  }
}

function toItem(db:Database,type:IdentityEntityType,row:DecisionRow):IdentityReviewItem {
  const revisions=snapshotRevisions(row.candidate_snapshot_json)
  const sourceIds=(db.prepare(`SELECT msg_id FROM ${sourceTable(type)} WHERE decision_id=? ORDER BY ordinal`).all(row.decision_id) as Array<{msg_id:string}>).map((source)=>source.msg_id)
  const latestEvaluation=db.prepare(`SELECT payload_json FROM ${eventTable(type)} WHERE decision_id=? AND action='retried' ORDER BY event_revision DESC LIMIT 1`).get(row.decision_id) as {payload_json:string}|undefined
  const latestPayload=latestEvaluation?parseJson<{evaluated?:unknown;suggestedDecision?:unknown}>(latestEvaluation.payload_json,{}):{}
  const suggestedDecision=latestPayload.evaluated===true&&latestPayload.suggestedDecision&&typeof latestPayload.suggestedDecision==='object'?latestPayload.suggestedDecision as IdentityDecision:null
  return {
    entityType:type,decisionId:row.decision_id,chatId:row.chat_id,sourceDigest:row.source_digest,draftRef:row.draft_ref,
    outcome:row.outcome,state:row.state,canonicalId:row.canonical_id,decisionRevision:row.decision_revision,
    sourceEpoch:row.source_epoch,scopeRevision:row.scope_revision,identityRevision:row.identity_revision,topicIdentityRevision:row.topic_identity_revision??row.identity_revision,
    draft:parseJson(row.draft_json,null),reasonCodes:parseJson(row.reason_codes_json,[]),candidates:candidateDtos(db,row.chat_id,revisions),candidateRevisions:revisions,sourceMsgIds:sourceIds,suggestedDecision,updatedAt:row.updated_at
  }
}

export function inspectIdentityDecision(db:Database,type:IdentityEntityType,decisionId:string):{item:IdentityReviewItem;messages:Array<{msgId:string;ts:number;timeIso:string;direction:'in'|'out';sender:string|null;text:string|null}>}|null {
  const row=db.prepare(`SELECT decision_id,chat_id,source_digest,draft_ref,outcome,state,${canonicalColumn(type)} AS canonical_id,decision_revision,source_epoch,scope_revision,identity_revision,${type==='todo'?'topic_identity_revision,':''}draft_json,candidate_snapshot_json,reason_codes_json,updated_at FROM ${decisionTable(type)} WHERE decision_id=?`).get(decisionId) as DecisionRow|undefined
  if(!row) return null
  if(row.state==='open') markStale(db,type,row,new Date().toISOString())
  const current=db.prepare(`SELECT decision_id,chat_id,source_digest,draft_ref,outcome,state,${canonicalColumn(type)} AS canonical_id,decision_revision,source_epoch,scope_revision,identity_revision,${type==='todo'?'topic_identity_revision,':''}draft_json,candidate_snapshot_json,reason_codes_json,updated_at FROM ${decisionTable(type)} WHERE decision_id=?`).get(decisionId) as DecisionRow
  const sourceIds=(db.prepare(`SELECT msg_id FROM ${sourceTable(type)} WHERE decision_id=? ORDER BY ordinal`).all(decisionId) as Array<{msg_id:string}>).map((source)=>source.msg_id)
  const messages=getMessagesByChatAndIds(current.chat_id,sourceIds,db).map((source)=>({msgId:source.msgId,ts:source.ts,timeIso:source.timeIso,direction:source.direction,sender:source.sender,text:source.text}))
  return {item:toItem(db,type,current),messages}
}

export function listIdentityInbox(db:Database,type:IdentityEntityType,input:{chatId?:string;after?:{decisionId:string};limit?:number}={}):{items:IdentityReviewItem[];next?:{decisionId:string}} {
  const limit=Math.max(1,Math.min(100,Math.floor(input.limit??50)))
  const where=["state IN ('open','stale')"]
  const params:unknown[]=[]
  if(input.chatId){where.push('chat_id=?');params.push(input.chatId)}
  if(input.after){where.push('decision_id>?');params.push(input.after.decisionId)}
  const rows=db.prepare(`SELECT decision_id,chat_id,source_digest,draft_ref,outcome,state,${canonicalColumn(type)} AS canonical_id,decision_revision,source_epoch,scope_revision,identity_revision,${type==='todo'?'topic_identity_revision,':''}draft_json,candidate_snapshot_json,reason_codes_json,updated_at FROM ${decisionTable(type)} WHERE ${where.join(' AND ')} ORDER BY decision_id LIMIT ?`)
    .all(...params,limit+1) as DecisionRow[]
  const page=rows.slice(0,limit)
  const now=new Date().toISOString()
  const tx=db.transaction(()=>{for(const row of page) markStale(db,type,row,now)})
  runImmediateTransaction(tx)
  const refreshed=page.map((row)=>{
    const current=db.prepare(`SELECT decision_id,chat_id,source_digest,draft_ref,outcome,state,${canonicalColumn(type)} AS canonical_id,decision_revision,source_epoch,scope_revision,identity_revision,${type==='todo'?'topic_identity_revision,':''}draft_json,candidate_snapshot_json,reason_codes_json,updated_at FROM ${decisionTable(type)} WHERE decision_id=?`).get(row.decision_id) as DecisionRow
    return toItem(db,type,current)
  })
  const last=rows.length>limit?page.at(-1):undefined
  return {items:refreshed,...(last?{next:{decisionId:last.decision_id}}:{})}
}

export function explainIdentityInboxQueryPlan(db:Database,type:IdentityEntityType,chatId:string):Array<{id:number;parent:number;notused:number;detail:string}> {
  return db.prepare(`EXPLAIN QUERY PLAN SELECT decision_id,updated_at FROM ${decisionTable(type)} WHERE chat_id=? AND state IN ('open','stale') ORDER BY decision_id LIMIT 50`).all(chatId) as Array<{id:number;parent:number;notused:number;detail:string}>
}

export function listTodoTopicRelationsForTopic(db:Database,topicId:string):Array<{relationId:string;chatId:string;todoId:string;title:string;status:string;bucket:string;relationType:'same_topic'|'related_action';relationStatus:'proposed'|'confirmed'|'rejected'|'stale';decisionId:string;sourceMsgIds:string[]}> {
  const active=db.prepare(`SELECT t.chat_id FROM discussion_topics t JOIN chats c ON c.chat_id=t.chat_id JOIN group_topic_preferences p ON p.chat_id=t.chat_id
    WHERE t.topic_id=? AND c.is_group=1 AND c.blocked=0 AND p.enabled=1`).get(topicId) as {chat_id:string}|undefined
  if(!active) return []
  const rows=db.prepare(`SELECT r.relation_id,r.chat_id,r.todo_id,t.title,t.status,t.bucket,r.relation_type,r.status AS relation_status,r.decision_id
    FROM todo_topic_identity_relations r JOIN todos t ON t.chat_id=r.chat_id AND t.id=r.todo_id
    WHERE r.chat_id=? AND r.topic_id=? ORDER BY r.created_at,r.relation_id LIMIT 100`).all(active.chat_id,topicId) as Array<{relation_id:string;chat_id:string;todo_id:string;title:string;status:string;bucket:string;relation_type:'same_topic'|'related_action';relation_status:'proposed'|'confirmed'|'rejected'|'stale';decision_id:string}>
  return rows.map((row)=>({relationId:row.relation_id,chatId:row.chat_id,todoId:row.todo_id,title:row.title,status:row.status,bucket:row.bucket,relationType:row.relation_type,relationStatus:row.relation_status,decisionId:row.decision_id,sourceMsgIds:(db.prepare('SELECT msg_id FROM todo_identity_decision_sources WHERE decision_id=? ORDER BY ordinal').all(row.decision_id) as Array<{msg_id:string}>).map((source)=>source.msg_id)}))
}

export function listTodoTopicRelationsForChat(db:Database,chatId:string):Array<{relationId:string;chatId:string;todoId:string;todoTitle:string;todoStatus:string;todoRevision:number;topicId:string;topicTitle:string;topicRevision:number;relationType:'same_topic'|'related_action';status:'proposed'|'confirmed'|'rejected'|'stale';revision:number;decisionId:string;sourceMsgIds:string[]}> {
  const active=db.prepare(`SELECT 1 AS yes FROM chats c JOIN group_topic_preferences p ON p.chat_id=c.chat_id WHERE c.chat_id=? AND c.is_group=1 AND c.blocked=0 AND p.enabled=1`).get(chatId)
  if(!active) return []
  const rows=db.prepare(`SELECT r.relation_id,r.chat_id,r.todo_id,t.title AS todo_title,t.status AS todo_status,t.entity_revision AS todo_revision,
      r.topic_id,topic.title AS topic_title,topic.revision AS topic_revision,r.relation_type,r.status,r.revision,r.decision_id
    FROM todo_topic_identity_relations r JOIN todos t ON t.chat_id=r.chat_id AND t.id=r.todo_id
    JOIN discussion_topics topic ON topic.chat_id=r.chat_id AND topic.topic_id=r.topic_id
    WHERE r.chat_id=? ORDER BY r.created_at,r.relation_id LIMIT 200`).all(chatId) as Array<{relation_id:string;chat_id:string;todo_id:string;todo_title:string;todo_status:string;todo_revision:number;topic_id:string;topic_title:string;topic_revision:number;relation_type:'same_topic'|'related_action';status:'proposed'|'confirmed'|'rejected'|'stale';revision:number;decision_id:string}>
  return rows.map((row)=>({relationId:row.relation_id,chatId:row.chat_id,todoId:row.todo_id,todoTitle:row.todo_title,todoStatus:row.todo_status,todoRevision:row.todo_revision,topicId:row.topic_id,topicTitle:row.topic_title,topicRevision:row.topic_revision,relationType:row.relation_type,status:row.status,revision:row.revision,decisionId:row.decision_id,sourceMsgIds:(db.prepare('SELECT msg_id FROM todo_identity_decision_sources WHERE decision_id=? ORDER BY ordinal').all(row.decision_id) as Array<{msg_id:string}>).map((source)=>source.msg_id)}))
}

export function listTodoRelationsForTodo(db:Database,chatId:string,todoId:string):Array<{relationId:string;leftTodoId:string;leftTitle:string;rightTodoId:string;rightTitle:string;relationType:'recurrence'|'related_action'|'follow_up';status:'proposed'|'confirmed'|'rejected';decisionId:string;sourceMsgIds:string[]}> {
  const rows=db.prepare(`SELECT r.relation_id,r.left_todo_id,l.title AS left_title,r.right_todo_id,rr.title AS right_title,r.relation_type,r.status,r.decision_id
    FROM todo_identity_relations r JOIN todos l ON l.chat_id=r.chat_id AND l.id=r.left_todo_id
    JOIN todos rr ON rr.chat_id=r.chat_id AND rr.id=r.right_todo_id
    WHERE r.chat_id=? AND (r.left_todo_id=? OR r.right_todo_id=?) ORDER BY r.created_at,r.relation_id LIMIT 100`).all(chatId,todoId,todoId) as Array<{relation_id:string;left_todo_id:string;left_title:string;right_todo_id:string;right_title:string;relation_type:'recurrence'|'related_action'|'follow_up';status:'proposed'|'confirmed'|'rejected';decision_id:string}>
  return rows.map((row)=>({relationId:row.relation_id,leftTodoId:row.left_todo_id,leftTitle:row.left_title,rightTodoId:row.right_todo_id,rightTitle:row.right_title,relationType:row.relation_type,status:row.status,decisionId:row.decision_id,sourceMsgIds:(db.prepare('SELECT msg_id FROM todo_identity_decision_sources WHERE decision_id=? ORDER BY ordinal').all(row.decision_id) as Array<{msg_id:string}>).map((source)=>source.msg_id)}))
}

export interface TopicLinkProposalPortItem {
  linkId:string;leftTopicId:string;leftChatId:string;leftChatName:string|null;leftTitle:string;leftRevision:number
  rightTopicId:string;rightChatId:string;rightChatName:string|null;rightTitle:string;rightRevision:number
  relation:string;identityEvidence:'verified'|'unknown';status:'proposed'|'accepted'|'rejected';stale:boolean
  eventEvidenceMsgIds:string[];linkRevision:number;permissionAllowed:boolean
}

export function listTopicLinkProposals(db:Database,input:{chatId:string;limit?:number}):TopicLinkProposalPortItem[] {
  const limit=Math.max(1,Math.min(100,Math.floor(input.limit??50)))
  const rows=db.prepare(`WITH proposal_ids AS (
      SELECT l.link_id FROM topic_links l JOIN discussion_topics endpoint ON endpoint.topic_id=l.left_topic_id WHERE endpoint.chat_id=? AND l.status='proposed'
      UNION
      SELECT l.link_id FROM topic_links l JOIN discussion_topics endpoint ON endpoint.topic_id=l.right_topic_id WHERE endpoint.chat_id=? AND l.status='proposed'
    )
    SELECT l.link_id,l.relation,l.identity_evidence,l.status,l.stale_at,l.event_evidence_msg_ids,
      left_topic.topic_id AS left_topic_id,left_topic.chat_id AS left_chat_id,left_chat.name AS left_chat_name,left_chat.is_group AS left_is_group,left_chat.blocked AS left_blocked,
      left_pref.enabled AS left_enabled,left_pref.cross_chat_enabled AS left_cross,
      left_topic.title AS left_title,left_topic.revision AS left_revision,
      right_topic.topic_id AS right_topic_id,right_topic.chat_id AS right_chat_id,right_chat.name AS right_chat_name,right_chat.is_group AS right_is_group,right_chat.blocked AS right_blocked,
      right_pref.enabled AS right_enabled,right_pref.cross_chat_enabled AS right_cross,
      right_topic.title AS right_title,right_topic.revision AS right_revision
    FROM proposal_ids ids JOIN topic_links l ON l.link_id=ids.link_id
    JOIN discussion_topics left_topic ON left_topic.topic_id=l.left_topic_id
    JOIN discussion_topics right_topic ON right_topic.topic_id=l.right_topic_id
    JOIN chats left_chat ON left_chat.chat_id=left_topic.chat_id JOIN chats right_chat ON right_chat.chat_id=right_topic.chat_id
    LEFT JOIN group_topic_preferences left_pref ON left_pref.chat_id=left_topic.chat_id
    LEFT JOIN group_topic_preferences right_pref ON right_pref.chat_id=right_topic.chat_id
    ORDER BY l.created_at,l.link_id LIMIT ?`).all(input.chatId,input.chatId,limit) as Array<Record<string,unknown>>
  return rows.map((row)=>{
    const linkId=String(row.link_id)
    const eventRevision=(db.prepare('SELECT COALESCE(MAX(event_revision),0) AS revision FROM topic_link_identity_events WHERE link_id=?').get(linkId) as {revision:number}).revision
    const leftEnabled=row.left_enabled===1&&row.left_is_group===1&&row.left_blocked===0
    const rightEnabled=row.right_enabled===1&&row.right_is_group===1&&row.right_blocked===0
    const crossScope=String(row.left_chat_id)===String(row.right_chat_id)||(row.left_cross===1&&row.right_cross===1)
    let eventIds:string[]=[]
    try{eventIds=parseJson(String(row.event_evidence_msg_ids),[])}catch{/* malformed refs remain untrusted */}
    return {
      linkId,leftTopicId:String(row.left_topic_id),leftChatId:String(row.left_chat_id),leftChatName:row.left_chat_name as string|null,leftTitle:String(row.left_title),leftRevision:Number(row.left_revision),
      rightTopicId:String(row.right_topic_id),rightChatId:String(row.right_chat_id),rightChatName:row.right_chat_name as string|null,rightTitle:String(row.right_title),rightRevision:Number(row.right_revision),
      relation:String(row.relation),identityEvidence:row.identity_evidence as 'verified'|'unknown',status:row.status as 'proposed'|'accepted'|'rejected',stale:row.stale_at!==null,
      eventEvidenceMsgIds:eventIds,linkRevision:eventRevision,permissionAllowed:leftEnabled&&rightEnabled&&crossScope
    }
  })
}

export function explainTopicLinkProposalQueryPlan(db:Database,chatId:string):Array<{id:number;parent:number;notused:number;detail:string}> {
  return db.prepare(`EXPLAIN QUERY PLAN WITH proposal_ids AS (
      SELECT l.link_id FROM topic_links l JOIN discussion_topics endpoint ON endpoint.topic_id=l.left_topic_id WHERE endpoint.chat_id=? AND l.status='proposed'
      UNION
      SELECT l.link_id FROM topic_links l JOIN discussion_topics endpoint ON endpoint.topic_id=l.right_topic_id WHERE endpoint.chat_id=? AND l.status='proposed'
    ) SELECT l.link_id,left_topic.topic_id,right_topic.topic_id FROM proposal_ids ids JOIN topic_links l ON l.link_id=ids.link_id
      JOIN discussion_topics left_topic ON left_topic.topic_id=l.left_topic_id JOIN discussion_topics right_topic ON right_topic.topic_id=l.right_topic_id
      ORDER BY l.created_at,l.link_id LIMIT 50`).all(chatId,chatId) as Array<{id:number;parent:number;notused:number;detail:string}>
}

export type ResolveTopicLinkProposalResult={ok:true;linkId:string;status:'accepted'|'rejected';linkRevision:number}|{ok:false;reason:'not_found'|'revision_conflict'|'endpoint_stale'|'scope_denied'|'not_proposed'}

/** CAS for a single proposed Topic relation. Acceptance never merges either Topic and never upgrades unknown identity evidence. */
export function resolveTopicLinkProposal(db:Database,input:{linkId:string;expectedLinkRevision:number;leftTopicRevision:number;rightTopicRevision:number;choice:'accept'|'reject'}):ResolveTopicLinkProposalResult {
  const now=new Date().toISOString()
  const tx=db.transaction(()=>{
    const row=db.prepare(`SELECT l.status,l.stale_at,l.left_topic_id,l.right_topic_id,left_topic.chat_id AS left_chat_id,right_topic.chat_id AS right_chat_id,
      left_topic.revision AS left_revision,right_topic.revision AS right_revision,
      left_chat.is_group AS left_group,left_chat.blocked AS left_blocked,left_pref.enabled AS left_enabled,left_pref.cross_chat_enabled AS left_cross,
      right_chat.is_group AS right_group,right_chat.blocked AS right_blocked,right_pref.enabled AS right_enabled,right_pref.cross_chat_enabled AS right_cross
      FROM topic_links l JOIN discussion_topics left_topic ON left_topic.topic_id=l.left_topic_id
      JOIN discussion_topics right_topic ON right_topic.topic_id=l.right_topic_id
      JOIN chats left_chat ON left_chat.chat_id=left_topic.chat_id JOIN chats right_chat ON right_chat.chat_id=right_topic.chat_id
      LEFT JOIN group_topic_preferences left_pref ON left_pref.chat_id=left_topic.chat_id
      LEFT JOIN group_topic_preferences right_pref ON right_pref.chat_id=right_topic.chat_id WHERE l.link_id=?`).get(input.linkId) as Record<string,unknown>|undefined
    if(!row) return {ok:false,reason:'not_found'} as const
    if(row.status!=='proposed'||row.stale_at!==null) return {ok:false,reason:'not_proposed'} as const
    const eventRevision=(db.prepare('SELECT COALESCE(MAX(event_revision),0) AS revision FROM topic_link_identity_events WHERE link_id=?').get(input.linkId) as {revision:number}).revision
    if(eventRevision!==input.expectedLinkRevision) return {ok:false,reason:'revision_conflict'} as const
    if(Number(row.left_revision)!==input.leftTopicRevision||Number(row.right_revision)!==input.rightTopicRevision) return {ok:false,reason:'endpoint_stale'} as const
    const sameChat=String(row.left_chat_id)===String(row.right_chat_id)
    const active= row.left_group===1&&row.left_blocked===0&&row.left_enabled===1&&row.right_group===1&&row.right_blocked===0&&row.right_enabled===1
    const crossPermission=sameChat||(row.left_cross===1&&row.right_cross===1)
    if(!active||!crossPermission){
      db.prepare('UPDATE topic_links SET stale_at=? WHERE link_id=? AND stale_at IS NULL').run(now,input.linkId)
      const nextRevision=eventRevision+1
      db.prepare(`INSERT INTO topic_link_identity_events(event_id,link_id,event_revision,actor,action,left_topic_revision,right_topic_revision,permission_snapshot_json,created_at) VALUES(?,?,?,'system','stale',?,?,?,?)`)
        .run(randomUUID(),input.linkId,nextRevision,Number(row.left_revision),Number(row.right_revision),JSON.stringify({sameChat,leftEnabled:row.left_enabled===1,rightEnabled:row.right_enabled===1,crossPermission}),now)
      return {ok:false,reason:'scope_denied'} as const
    }
    const status=input.choice==='accept'?'accepted':'rejected'
    const changed=db.prepare("UPDATE topic_links SET status=? WHERE link_id=? AND status='proposed' AND stale_at IS NULL").run(status,input.linkId)
    if(changed.changes!==1) return {ok:false,reason:'revision_conflict'} as const
    const nextRevision=eventRevision+1
    db.prepare(`INSERT INTO topic_link_identity_events(event_id,link_id,event_revision,actor,action,left_topic_revision,right_topic_revision,permission_snapshot_json,created_at) VALUES(?,?,?,'user',?,?,?,?,?)`)
      .run(randomUUID(),input.linkId,nextRevision,status,Number(row.left_revision),Number(row.right_revision),JSON.stringify({sameChat,crossPermission}),now)
    return {ok:true,linkId:input.linkId,status,linkRevision:nextRevision} as const
  })
  return runImmediateTransaction(tx)
}

export type ResolveTodoTopicRelationResult={ok:true;relationId:string;status:'confirmed'|'rejected';revision:number}|{ok:false;reason:'not_found'|'revision_conflict'|'candidate_conflict'|'scope_denied'|'not_proposed'}

export function resolveTodoTopicRelation(db:Database,input:{relationId:string;expectedRevision:number;expectedTodoRevision:number;expectedTopicRevision:number;choice:'confirm'|'reject'}):ResolveTodoTopicRelationResult {
  const now=new Date().toISOString()
  const tx=db.transaction(()=>{
    const row=db.prepare(`SELECT r.chat_id,r.todo_id,r.topic_id,r.status,r.revision,r.decision_id,t.entity_revision,topic.revision AS topic_revision,c.is_group,c.blocked,p.enabled
      FROM todo_topic_identity_relations r JOIN todos t ON t.chat_id=r.chat_id AND t.id=r.todo_id
      JOIN discussion_topics topic ON topic.chat_id=r.chat_id AND topic.topic_id=r.topic_id
      JOIN chats c ON c.chat_id=r.chat_id LEFT JOIN group_topic_preferences p ON p.chat_id=r.chat_id WHERE r.relation_id=?`).get(input.relationId) as {chat_id:string;todo_id:string;topic_id:string;status:string;revision:number;decision_id:string;entity_revision:number;topic_revision:number;is_group:number;blocked:number;enabled:number|null}|undefined
    if(!row) return {ok:false,reason:'not_found'} as const
    if(row.status!=='proposed') return {ok:false,reason:'not_proposed'} as const
    if(row.revision!==input.expectedRevision) return {ok:false,reason:'revision_conflict'} as const
    if(row.entity_revision!==input.expectedTodoRevision||row.topic_revision!==input.expectedTopicRevision) return {ok:false,reason:'candidate_conflict'} as const
    if(row.is_group!==1||row.blocked===1||row.enabled!==1) {
      const changed=db.prepare("UPDATE todo_topic_identity_relations SET status='stale',revision=revision+1 WHERE relation_id=? AND status='proposed' AND revision=?").run(input.relationId,input.expectedRevision)
      if(changed.changes===1){
        db.prepare('UPDATE chat_context_cache SET todo_identity_revision=todo_identity_revision+1,state_version=state_version+1,updated_at=? WHERE chat_id=?').run(now,row.chat_id)
        const eventRevision=(db.prepare('SELECT COALESCE(MAX(event_revision),0)+1 AS revision FROM todo_identity_events WHERE decision_id=?').get(row.decision_id) as {revision:number}).revision
        insertIdentityEvent(db,{decisionId:row.decision_id,revision:eventRevision,actor:'system',action:'stale',payload:{relationId:input.relationId,reason:'scope_changed'},table:'todo_identity_events'})
      }
      return {ok:false,reason:'scope_denied'} as const
    }
    const status=input.choice==='confirm'?'confirmed':'rejected'
    const changed=db.prepare("UPDATE todo_topic_identity_relations SET status=?,revision=revision+1 WHERE relation_id=? AND status='proposed' AND revision=?").run(status,input.relationId,input.expectedRevision)
    if(changed.changes!==1) return {ok:false,reason:'revision_conflict'} as const
    db.prepare('UPDATE chat_context_cache SET todo_identity_revision=todo_identity_revision+1,state_version=state_version+1,updated_at=? WHERE chat_id=?').run(now,row.chat_id)
    const eventRevision=(db.prepare('SELECT COALESCE(MAX(event_revision),0)+1 AS revision FROM todo_identity_events WHERE decision_id=?').get(row.decision_id) as {revision:number}).revision
    insertIdentityEvent(db,{decisionId:row.decision_id,revision:eventRevision,actor:'user',action:input.choice==='confirm'?'relation_accepted':'relation_rejected',payload:{relationId:input.relationId,status,expectedTodoRevision:input.expectedTodoRevision,expectedTopicRevision:input.expectedTopicRevision},table:'todo_identity_events'})
    return {ok:true,relationId:input.relationId,status,revision:input.expectedRevision+1} as const
  })
  return runImmediateTransaction(tx)
}

export type RetryIdentityResult={ok:true;item:IdentityReviewItem;messages:Array<{msgId:string;ts:number;direction:'in'|'out';text:string}>;candidates:IdentityCandidate[];candidatesTruncated:boolean;snapshot:IdentityContextSnapshot}|{ok:false;reason:'not_found'|'revision_conflict'|'not_open'|'identity_indexing'|'source_missing'}

/** Explicit only: automatic polling never calls this port. It advances one decision revision and returns refreshed trusted context. */
export function retryIdentityDecision(db:Database,type:IdentityEntityType,decisionId:string,expectedDecisionRevision:number):RetryIdentityResult {
  const table=decisionTable(type)
  const row=db.prepare(`SELECT decision_id,chat_id,source_digest,draft_ref,outcome,state,${canonicalColumn(type)} AS canonical_id,decision_revision,source_epoch,scope_revision,identity_revision,${type==='todo'?'topic_identity_revision,':''}draft_json,candidate_snapshot_json,reason_codes_json,updated_at FROM ${table} WHERE decision_id=?`).get(decisionId) as DecisionRow|undefined
  if(!row) return {ok:false,reason:'not_found'}
  if(row.decision_revision!==expectedDecisionRevision) return {ok:false,reason:'revision_conflict'}
  if(row.state!=='open'&&row.state!=='stale') return {ok:false,reason:'not_open'}
  const sourceIds=(db.prepare(`SELECT msg_id FROM ${sourceTable(type)} WHERE decision_id=? ORDER BY ordinal`).all(decisionId) as Array<{msg_id:string}>).map((item)=>item.msg_id)
  const sourceRows=getMessagesByChatAndIds(row.chat_id,sourceIds,db)
  if(sourceRows.length!==sourceIds.length) return {ok:false,reason:'source_missing'}
  const textRows=sourceRows.map((source)=>({msgId:source.msgId,ts:source.ts,direction:source.direction,text:source.text??''}))
  if(type==='todo'&&!advanceIdentityIndex(db,row.chat_id,'todo')) return {ok:false,reason:'identity_indexing'}
  if(type==='todo'&&tableExists(db,'discussion_topics')&&!advanceIdentityIndex(db,row.chat_id,'topic')) return {ok:false,reason:'identity_indexing'}
  if(type==='topic'&&!advanceIdentityIndex(db,row.chat_id,'topic')) return {ok:false,reason:'identity_indexing'}
  const recall=type==='todo'?recallTodoIdentityCandidates(db,row.chat_id,textRows.map((message)=>message.text),sourceIds):recallTopicIdentityCandidates(db,row.chat_id,textRows.map((message)=>message.text))
  if(!recall.ready) return {ok:false,reason:'identity_indexing'}
  const state=readChatSourceState(db,row.chat_id)
  if(!state) return {ok:false,reason:'source_missing'}
  const now=new Date().toISOString()
  const revisions=recall.candidateRevisions
  const candidateSnapshotJson=JSON.stringify({candidateIds:revisions.map((candidate)=>candidate.entityId),revisions})
  const tx=db.transaction(()=>{
    const update=db.prepare(`UPDATE ${table} SET state='open',decision_revision=decision_revision+1,source_epoch=?,scope_revision=?,identity_revision=?,${type==='todo'?'topic_identity_revision=?,':''}candidate_snapshot_json=?,query_version=?,updated_at=? WHERE decision_id=? AND decision_revision=? AND state IN ('open','stale')`)
    const identityRevision=type==='topic'?state.topicIdentityRevision:state.todoIdentityRevision
    const values=type==='todo'?[state.sourceEpoch,state.scopeRevision,identityRevision,state.topicIdentityRevision,candidateSnapshotJson,IDENTITY_QUERY_VERSION,now,decisionId,expectedDecisionRevision]:[state.sourceEpoch,state.scopeRevision,identityRevision,candidateSnapshotJson,IDENTITY_QUERY_VERSION,now,decisionId,expectedDecisionRevision]
    const result=update.run(...values)
    if(result.changes!==1) return false
    const eventRevision=(db.prepare(`SELECT COALESCE(MAX(event_revision),0)+1 AS revision FROM ${eventTable(type)} WHERE decision_id=?`).get(decisionId) as {revision:number}).revision
    insertIdentityEvent(db,{decisionId,revision:eventRevision,actor:'user',action:'retried',payload:{fromDecisionRevision:expectedDecisionRevision,toDecisionRevision:expectedDecisionRevision+1,candidateRevisions:revisions},table:eventTable(type)})
    return true
  })
  if(!runImmediateTransaction(tx)) return {ok:false,reason:'revision_conflict'}
  const updated=db.prepare(`SELECT decision_id,chat_id,source_digest,draft_ref,outcome,state,${canonicalColumn(type)} AS canonical_id,decision_revision,source_epoch,scope_revision,identity_revision,${type==='todo'?'topic_identity_revision,':''}draft_json,candidate_snapshot_json,reason_codes_json,updated_at FROM ${table} WHERE decision_id=?`).get(decisionId) as DecisionRow
  const snapshot=captureIdentitySnapshot(db,row.chat_id,sourceRows,recall.truncated,revisions)
  if(!snapshot)return {ok:false,reason:'source_missing'}
  return {ok:true,item:toItem(db,type,updated),messages:textRows,candidates:recall.candidates,candidatesTruncated:recall.truncated,snapshot}
}

export function recordIdentityRetryEvaluation(db:Database,input:{entityType:IdentityEntityType;decisionId:string;expectedDecisionRevision:number;snapshot:IdentityContextSnapshot;suggestion:IdentityDecision}):IdentityReviewItem|null {
  const type=input.entityType,table=decisionTable(type)
  const row=db.prepare(`SELECT decision_id,chat_id,source_digest,draft_ref,outcome,state,${canonicalColumn(type)} AS canonical_id,decision_revision,source_epoch,scope_revision,identity_revision,${type==='todo'?'topic_identity_revision,':''}draft_json,candidate_snapshot_json,reason_codes_json,updated_at FROM ${table} WHERE decision_id=?`).get(input.decisionId) as DecisionRow|undefined
  if(!row||row.state!=='open'||row.decision_revision!==input.expectedDecisionRevision) return null
  try { assertIdentitySnapshotCurrent(db,row.chat_id,input.snapshot,type) } catch { return null }
  const storedRevisions=snapshotRevisions(row.candidate_snapshot_json)
  if(storedRevisions.length!==input.snapshot.candidateRevisions.length||storedRevisions.some((candidate)=>!input.snapshot.candidateRevisions.some((current)=>current.entityType===candidate.entityType&&current.entityId===candidate.entityId&&current.revision===candidate.revision))) return null
  const sourceIds=(db.prepare(`SELECT msg_id FROM ${sourceTable(type)} WHERE decision_id=? ORDER BY ordinal`).all(input.decisionId) as Array<{msg_id:string}>).map((source)=>source.msg_id)
  if(input.suggestion.draftRef!==row.draft_ref||!input.suggestion.evidenceMsgIds.every((id)=>sourceIds.includes(id))) return null
  const now=new Date().toISOString()
  const tx=db.transaction(()=>{
    const next=(db.prepare(`SELECT COALESCE(MAX(event_revision),0)+1 AS revision FROM ${eventTable(type)} WHERE decision_id=?`).get(input.decisionId) as {revision:number}).revision
    const changed=db.prepare(`UPDATE ${table} SET outcome=?,reason_codes_json=?,updated_at=? WHERE decision_id=? AND state='open' AND decision_revision=? AND source_epoch=? AND scope_revision=? AND identity_revision=?`).run(input.suggestion.outcome,JSON.stringify([input.suggestion.reasonCode]),now,input.decisionId,input.expectedDecisionRevision,input.snapshot.sourceEpoch,input.snapshot.scopeRevision,type==='todo'?input.snapshot.identityRevision:input.snapshot.topicIdentityRevision)
    if(changed.changes!==1) return false
    insertIdentityEvent(db,{decisionId:input.decisionId,revision:next,actor:'user',action:'retried',payload:{evaluated:true,decisionRevision:input.expectedDecisionRevision,suggestedDecision:input.suggestion,candidateRevisions:input.snapshot.candidateRevisions,sourceEpoch:input.snapshot.sourceEpoch,scopeRevision:input.snapshot.scopeRevision},table:eventTable(type)})
    return true
  })
  if(!runImmediateTransaction(tx)) return null
  const updated=db.prepare(`SELECT decision_id,chat_id,source_digest,draft_ref,outcome,state,${canonicalColumn(type)} AS canonical_id,decision_revision,source_epoch,scope_revision,identity_revision,${type==='todo'?'topic_identity_revision,':''}draft_json,candidate_snapshot_json,reason_codes_json,updated_at FROM ${table} WHERE decision_id=?`).get(input.decisionId) as DecisionRow
  return toItem(db,type,updated)
}

export type ResolveIdentityInput={entityType:IdentityEntityType;decisionId:string;expectedDecisionRevision:number;expectedCandidateRevisions:IdentityCandidateRevision[];outcome:'existing'|'new'|'link'|'dismiss';candidateType?:IdentityEntityType;candidateId?:string;relationKind?:'recurrence'|'related_action'|'follow_up'|'same_topic'}
export type ResolveIdentityResult={ok:true;canonicalId:string|null;state:'resolved'|'dismissed';decisionRevision:number}|{ok:false;reason:'not_found'|'revision_conflict'|'not_open'|'candidate_conflict'|'invalid_choice'|'scope_denied'}

/** User decision CAS for Phase3 API/UI consumers. Source references and candidates are rechecked in the same SQLite transaction. */
export function resolveIdentityDecision(db:Database,input:ResolveIdentityInput):ResolveIdentityResult {
  const type=input.entityType,table=decisionTable(type)
  const row=db.prepare(`SELECT decision_id,chat_id,source_digest,draft_ref,outcome,state,${canonicalColumn(type)} AS canonical_id,decision_revision,source_epoch,scope_revision,identity_revision,${type==='todo'?'topic_identity_revision,':''}draft_json,candidate_snapshot_json,reason_codes_json,updated_at FROM ${table} WHERE decision_id=?`).get(input.decisionId) as DecisionRow|undefined
  if(!row) return {ok:false,reason:'not_found'}
  if(row.decision_revision!==input.expectedDecisionRevision) return {ok:false,reason:'revision_conflict'}
  if(row.state!=='open'&&row.state!=='stale') return {ok:false,reason:'not_open'}
  const cachedRevisions=snapshotRevisions(row.candidate_snapshot_json)
  const requested=new Map(input.expectedCandidateRevisions.map((candidate)=>[`${candidate.entityType}:${candidate.entityId}`,candidate.revision]))
  if(input.expectedCandidateRevisions.length>50||requested.size!==input.expectedCandidateRevisions.length) return {ok:false,reason:'candidate_conflict'}
  if(input.expectedCandidateRevisions.some((candidate)=>!cachedRevisions.some((stored)=>stored.entityType===candidate.entityType&&stored.entityId===candidate.entityId&&stored.revision===candidate.revision))) return {ok:false,reason:'candidate_conflict'}
  const targetId=input.candidateId
  if((input.outcome==='existing'||input.outcome==='link')&&(!targetId||!input.candidateType||!cachedRevisions.some((candidate)=>candidate.entityType===input.candidateType&&candidate.entityId===targetId))) return {ok:false,reason:'invalid_choice'}
  if((input.outcome==='new'||input.outcome==='dismiss')&&(input.candidateId||input.candidateType)) return {ok:false,reason:'invalid_choice'}
  if(input.outcome==='link'&&!input.relationKind) return {ok:false,reason:'invalid_choice'}
  if((input.outcome==='existing'||input.outcome==='link')&&targetId&&input.candidateType){
    const key=`${input.candidateType}:${targetId}`
    if(!requested.has(key)||requested.get(key)!==revisionOf(db,input.candidateType,row.chat_id,targetId)) return {ok:false,reason:'candidate_conflict'}
  }
  const currentState=readChatSourceState(db,row.chat_id)
  if(!currentState||currentIdentityRevision(db,row.chat_id,type)!==row.identity_revision) return {ok:false,reason:'candidate_conflict'}
  if(type==='todo'&&currentState.topicIdentityRevision!==row.topic_identity_revision) return {ok:false,reason:'candidate_conflict'}
  if(currentState.scopeRevision!==row.scope_revision) return {ok:false,reason:'scope_denied'}
  for(const candidate of cachedRevisions) if(requested.has(`${candidate.entityType}:${candidate.entityId}`)&&revisionOf(db,candidate.entityType,row.chat_id,candidate.entityId)!==requested.get(`${candidate.entityType}:${candidate.entityId}`)) return {ok:false,reason:'candidate_conflict'}
  const sources=(db.prepare(`SELECT msg_id FROM ${sourceTable(type)} WHERE decision_id=? ORDER BY ordinal`).all(row.decision_id) as Array<{msg_id:string}>).map((source)=>source.msg_id)
  const sourceRows=getMessagesByChatAndIds(row.chat_id,sources,db)
  if(sourceRows.length!==sources.length) return {ok:false,reason:'candidate_conflict'}
  const draft=parseJson<Record<string,unknown>>(row.draft_json,{})
  const now=new Date().toISOString()
  const wasReady=type==='todo'?(db.prepare("SELECT state FROM identity_index_meta WHERE chat_id=? AND entity_type='todo'").get(row.chat_id) as {state:string}|undefined)?.state==='ready':(db.prepare("SELECT state FROM identity_index_meta WHERE chat_id=? AND entity_type='topic'").get(row.chat_id) as {state:string}|undefined)?.state==='ready'
  const tx=db.transaction(()=>{
    let canonicalId:string|null=null
    if(input.outcome==='dismiss') {
      canonicalId=null
    } else if(type==='todo') {
      const sourceMsgIds=Array.isArray(draft.sourceMsgIds)?draft.sourceMsgIds.filter((id):id is string=>typeof id==='string'):sources
      const title=typeof draft.title==='string'?draft.title:''
      const bucket=draft.bucket==='waiting'||draft.bucket==='schedule'?draft.bucket:'todo'
      if(!title.trim()) throw new Error('invalid_choice')
      if(input.outcome==='existing') {
        if(input.candidateType!=='todo'||!targetId) throw new Error('invalid_choice')
        const current=getTodo(targetId,db)
        if(!current||current.chatId!==row.chat_id) throw new Error('candidate_conflict')
        const union=[...new Set([...current.sourceMsgIds,...sourceMsgIds])]
        updateTodo(targetId,{title,detail:typeof draft.detail==='string'?draft.detail:null,priority:typeof draft.priority==='number'?draft.priority:current.priority,dueAt:typeof draft.dueAt==='string'?draft.dueAt:null,sourceMsgIds:union},db)
        canonicalId=targetId
      } else {
        const created=createTodo({chatId:row.chat_id,bucket,title,detail:typeof draft.detail==='string'?draft.detail:null,priority:typeof draft.priority==='number'?draft.priority:2,dueAt:typeof draft.dueAt==='string'?draft.dueAt:null,confidence:typeof draft.confidence==='number'?draft.confidence:.5,sourceMsgIds},db)
        canonicalId=created.id
        if(input.outcome==='link'&&targetId){
          if(input.candidateType==='todo'){
            const pair=[created.id,targetId].sort()
            db.prepare(`INSERT OR IGNORE INTO todo_identity_relations(relation_id,chat_id,left_todo_id,right_todo_id,relation_type,status,decision_id,created_at) VALUES(?,?,?,?,?,'proposed',?,?)`).run(randomUUID(),row.chat_id,pair[0],pair[1],input.relationKind==='recurrence'?'recurrence':input.relationKind==='follow_up'?'follow_up':'related_action',row.decision_id,now)
          } else if(input.candidateType==='topic'&&input.relationKind==='same_topic') {
            const valid=db.prepare(`SELECT t.topic_id FROM discussion_topics t JOIN chats c ON c.chat_id=t.chat_id JOIN group_topic_preferences p ON p.chat_id=t.chat_id WHERE t.chat_id=? AND t.topic_id=? AND c.is_group=1 AND c.blocked=0 AND p.enabled=1`).get(row.chat_id,targetId)
            if(!valid) throw new Error('scope_denied')
            db.prepare(`INSERT OR IGNORE INTO todo_topic_identity_relations(relation_id,chat_id,todo_id,topic_id,relation_type,status,decision_id,revision,created_at) VALUES(?,?,?,?,?,'proposed',?,1,?)`).run(randomUUID(),row.chat_id,created.id,targetId,'same_topic',row.decision_id,now)
          } else throw new Error('invalid_choice')
        }
      }
      if(canonicalId) refreshTodoIdentityTerms(db,row.chat_id,canonicalId,wasReady)
    } else {
      const title=typeof draft.title==='string'?draft.title:''
      const summary=typeof draft.summary==='string'?draft.summary:''
      if(!title.trim()||!summary.trim()) throw new Error('invalid_choice')
      if(input.outcome==='existing') {
        if(input.candidateType!=='topic'||!targetId) throw new Error('invalid_choice')
        const current=db.prepare('SELECT topic_id FROM discussion_topics WHERE chat_id=? AND topic_id=?').get(row.chat_id,targetId)
        if(!current) throw new Error('candidate_conflict')
        db.prepare('UPDATE discussion_topics SET title=?,summary=?,last_source_ts=max(last_source_ts,?) WHERE chat_id=? AND topic_id=?').run(title,summary,Math.max(...sourceRows.map((source)=>source.ts)),row.chat_id,targetId)
        canonicalId=targetId
      } else {
        canonicalId=randomUUID()
        db.prepare('INSERT INTO discussion_topics(topic_id,chat_id,local_ref,title,summary,created_at,last_source_ts,revision) VALUES(?,?,?,?,?,?,?,1)').run(canonicalId,row.chat_id,`review-${row.decision_id.slice(0,16)}`,title,summary,now,Math.max(...sourceRows.map((source)=>source.ts)))
        if(input.outcome==='link'&&targetId){
          if(input.candidateType!=='topic') throw new Error('invalid_choice')
          const pair=[canonicalId,targetId].sort();const linkId=randomUUID();
          db.prepare(`INSERT INTO topic_links(link_id,left_topic_id,right_topic_id,relation,identity_evidence,event_evidence_msg_ids,status,created_at) VALUES(?,?,?,?,'unknown',?,'proposed',?)`).run(linkId,pair[0],pair[1],input.relationKind==='recurrence'?'same_occurrence':input.relationKind==='follow_up'?'follow_up':'related',JSON.stringify(sources),now)
          const left=(db.prepare('SELECT revision FROM discussion_topics WHERE topic_id=?').get(pair[0]) as {revision:number}).revision
          const right=(db.prepare('SELECT revision FROM discussion_topics WHERE topic_id=?').get(pair[1]) as {revision:number}).revision
          db.prepare(`INSERT INTO topic_link_identity_events(event_id,link_id,event_revision,actor,action,left_topic_revision,right_topic_revision,permission_snapshot_json,created_at) VALUES(?,?,1,'user','proposed',?,?,?,?)`).run(randomUUID(),linkId,left,right,JSON.stringify({chatId:row.chat_id}),now)
        }
      }
      if(canonicalId) syncTopicIdentityTerms(db,row.chat_id,canonicalId,wasReady)
    }
    const newState:'resolved'|'dismissed'=input.outcome==='dismiss'?'dismissed':'resolved'
    const newOutcome=input.outcome==='dismiss'?'defer':input.outcome==='existing'?'update_existing':input.outcome==='link'?'link':'new'
    const column=canonicalColumn(type)
    const changed=db.prepare(`UPDATE ${table} SET state=?,outcome=?,${column}=?,decision_revision=decision_revision+1,updated_at=? WHERE decision_id=? AND decision_revision=? AND state IN ('open','stale')`).run(newState,newOutcome,canonicalId,now,row.decision_id,input.expectedDecisionRevision)
    if(changed.changes!==1) throw new Error('revision_conflict')
    const eventRevision=(db.prepare(`SELECT COALESCE(MAX(event_revision),0)+1 AS revision FROM ${eventTable(type)} WHERE decision_id=?`).get(row.decision_id) as {revision:number}).revision
    const action=input.outcome==='dismiss'?'dismissed':input.outcome==='existing'?'resolved_existing':input.outcome==='link'?'linked':'resolved_new'
    insertIdentityEvent(db,{decisionId:row.decision_id,revision:eventRevision,actor:'user',action,payload:{outcome:input.outcome,canonicalId,candidateType:input.candidateType??null,candidateId:targetId??null,expectedCandidateRevisions:input.expectedCandidateRevisions},table:eventTable(type)})
    return {canonicalId,state:newState}
  })
  try {
    const result=runImmediateTransaction(tx)
    return {ok:true,canonicalId:result.canonicalId,state:result.state,decisionRevision:input.expectedDecisionRevision+1}
  } catch(error) {
    const reason=error instanceof Error?error.message:''
    if(reason==='revision_conflict') return {ok:false,reason:'revision_conflict'}
    if(reason==='candidate_conflict') return {ok:false,reason:'candidate_conflict'}
    if(reason==='scope_denied') return {ok:false,reason:'scope_denied'}
    return {ok:false,reason:'invalid_choice'}
  }
}

