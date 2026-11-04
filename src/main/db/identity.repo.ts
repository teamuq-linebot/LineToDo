import { createHash, randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { IdentityCandidate, IdentityContextSnapshot } from '../../shared/identityDecision'
import { IDENTITY_QUERY_VERSION } from '../../shared/identityDecision'
import type { MessageDTO } from './dto'
import { fingerprintSourceMessage, readChatSourceState, runImmediateTransaction, sharedSourceRows, sourceSessionPolicy, type ChatSourceLease } from './sourceCache'

export type IdentityEntityType = 'todo' | 'topic'
export const IDENTITY_CANDIDATE_LIMIT = 50
export const IDENTITY_INDEX_BATCH = 100
export const IDENTITY_CONTEXT_CHARS = 1600
const IDENTITY_TERMS_PER_VALUE_LIMIT=500
const IDENTITY_QUERY_TERM_LIMIT=500

type IndexMeta = { state: 'building' | 'ready' | 'stale' | 'failed'; cursor_entity_id: string | null; tokenizer_version: string }

function nowIso(): string { return new Date().toISOString() }
function hasTable(db: Database, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
}

function rawIdentityTerms(value:string):string[] {
  const normalized = value.normalize('NFKC').toLocaleLowerCase().replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
  if (!normalized) return []
  const terms = new Set<string>()
  terms.add(`h:${createHash('sha256').update(normalized).digest('hex')}`)
  const runs = normalized.match(/[\p{L}\p{N}]+/gu) ?? []
  for (const run of runs) {
    if (run.length <= 32) terms.add(`t:${run}`)
    const chars = [...run]
    if (chars.length >= 2 && /\p{Script=Han}/u.test(run)) {
      for (let i = 0; i + 1 < chars.length; i += 1) terms.add(`t:${chars[i]}${chars[i + 1]}`)
    }
  }
  return [...terms].filter((term) => term.length <= 128)
}

export function identityTerms(value: string): string[] {
  return rawIdentityTerms(value).slice(0,IDENTITY_TERMS_PER_VALUE_LIMIT)
}

function boundedSearchTerms(texts:string[]):{terms:string[];truncated:boolean} {
  const terms=new Set<string>()
  let truncated=false
  for(const text of texts){
    const values=rawIdentityTerms(text)
    if(values.length>IDENTITY_TERMS_PER_VALUE_LIMIT) truncated=true
    for(const term of values.slice(0,IDENTITY_TERMS_PER_VALUE_LIMIT)){
      terms.add(term)
      if(terms.size>=IDENTITY_QUERY_TERM_LIMIT){truncated=true;break}
    }
    if(terms.size>=IDENTITY_QUERY_TERM_LIMIT) break
  }
  return {terms:[...terms],truncated}
}

function parseIds(raw: string): {ids:string[];malformed:boolean} {
  try {
    const value: unknown = JSON.parse(raw)
    if(!Array.isArray(value)) return {ids:[],malformed:true}
    const ids=value.filter((id):id is string=>typeof id==='string'&&id.length>0)
    return {ids:[...new Set(ids)],malformed:ids.length!==value.length}
  } catch { return {ids:[],malformed:true} }
}

function reportIdentityIssue(db:Database,chatId:string,entityType:IdentityEntityType,entityId:string,issueKind:'malformed_source_json'|'orphan_source_ref'|'term_limit_exceeded',detail:unknown,state:'open'|'resolved'='open'):void {
  const now=nowIso()
  db.prepare(`INSERT INTO identity_backfill_issues(issue_id,chat_id,entity_type,entity_id,issue_kind,detail_json,state,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?, ?,?) ON CONFLICT(chat_id,entity_type,entity_id,issue_kind,detail_json) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at`)
    .run(randomUUID(),chatId,entityType,entityId,issueKind,JSON.stringify(detail),state,now,now)
}

function indexTodoSources(db:Database,row:{chat_id:string;id:string},raw:string,role:'canonical'|'historical'):void {
  const parsed=parseIds(raw)
  if(parsed.malformed){
    const detail={sha256:createHash('sha256').update(raw).digest('hex'),bytes:Buffer.byteLength(raw,'utf8')}
    reportIdentityIssue(db,row.chat_id,'todo',row.id,'malformed_source_json',detail)
  } else {
    db.prepare("UPDATE identity_backfill_issues SET state='resolved',updated_at=? WHERE chat_id=? AND entity_type='todo' AND entity_id=? AND issue_kind='malformed_source_json'").run(nowIso(),row.chat_id,row.id)
  }
  const exists=db.prepare('SELECT 1 AS yes FROM messages WHERE chat_id=? AND msg_id=?')
  const insert=db.prepare('INSERT OR IGNORE INTO todo_identity_sources(chat_id,todo_id,msg_id,source_role) VALUES(?,?,?,?)')
  const currentRefs=new Set(parsed.ids)
  for(const msgId of parsed.ids){
    if(exists.get(row.chat_id,msgId)){
      insert.run(row.chat_id,row.id,msgId,role)
      db.prepare("UPDATE identity_backfill_issues SET state='resolved',updated_at=? WHERE chat_id=? AND entity_type='todo' AND entity_id=? AND issue_kind='orphan_source_ref' AND detail_json=?")
        .run(nowIso(),row.chat_id,row.id,JSON.stringify({msgId}))
    } else reportIdentityIssue(db,row.chat_id,'todo',row.id,'orphan_source_ref',{msgId},'open')
  }
  if(!parsed.malformed){
    const openOrphans=db.prepare("SELECT issue_id,detail_json FROM identity_backfill_issues WHERE chat_id=? AND entity_type='todo' AND entity_id=? AND issue_kind='orphan_source_ref' AND state='open'").all(row.chat_id,row.id) as Array<{issue_id:string;detail_json:string}>
    for(const issue of openOrphans){
      try{const detail=JSON.parse(issue.detail_json) as {msgId?:unknown};if(typeof detail.msgId==='string'&&!currentRefs.has(detail.msgId))db.prepare("UPDATE identity_backfill_issues SET state='resolved',updated_at=? WHERE issue_id=?").run(nowIso(),issue.issue_id)}catch{/* malformed issue details remain visible */}
    }
  }
}

function indexTodo(db: Database, row: { chat_id: string; id: string; entity_revision: number; title: string; detail: string | null; source_msg_ids: string }): boolean {
  db.prepare("DELETE FROM todo_identity_terms WHERE chat_id=? AND todo_id=? AND term_kind='current'").run(row.chat_id, row.id)
  const insertTerm = db.prepare('INSERT OR IGNORE INTO todo_identity_terms(chat_id,term,todo_id,indexed_revision,term_kind) VALUES(?,?,?,?,?)')
  let overflow=rawIdentityTerms(row.title).length>IDENTITY_TERMS_PER_VALUE_LIMIT||rawIdentityTerms(row.detail??'').length>IDENTITY_TERMS_PER_VALUE_LIMIT
  const titleTerms = identityTerms(row.title)
  for (const term of titleTerms) insertTerm.run(row.chat_id, term, row.id, row.entity_revision, 'current')
  for (const term of identityTerms(row.detail ?? '')) insertTerm.run(row.chat_id, term, row.id, row.entity_revision, 'current')
  indexTodoSources(db,row,row.source_msg_ids,'canonical')
  const aliases = db.prepare('SELECT alias_id,title,detail,entity_revision,source_msg_ids FROM todo_identity_aliases WHERE chat_id=? AND todo_id=?').all(row.chat_id,row.id) as Array<{alias_id:string;title:string;detail:string|null;entity_revision:number;source_msg_ids:string}>
  for (const alias of aliases) {
    if(rawIdentityTerms(alias.title).length>IDENTITY_TERMS_PER_VALUE_LIMIT||rawIdentityTerms(alias.detail??'').length>IDENTITY_TERMS_PER_VALUE_LIMIT) overflow=true
    for (const term of new Set([...identityTerms(alias.title), ...identityTerms(alias.detail ?? '')])) {
      insertTerm.run(row.chat_id, term, row.id, alias.entity_revision, 'historical')
    }
    indexTodoSources(db,row,alias.source_msg_ids,'historical')
  }
  if(overflow) reportIdentityIssue(db,row.chat_id,'todo',row.id,'term_limit_exceeded',{limit:IDENTITY_TERMS_PER_VALUE_LIMIT})
  else db.prepare("UPDATE identity_backfill_issues SET state='resolved',updated_at=? WHERE chat_id=? AND entity_type='todo' AND entity_id=? AND issue_kind='term_limit_exceeded'").run(nowIso(),row.chat_id,row.id)
  return overflow
}

function indexTopic(db: Database, row: { chat_id: string; topic_id: string; revision: number; title: string; summary: string }): boolean {
  db.prepare("DELETE FROM topic_identity_terms WHERE chat_id=? AND topic_id=? AND term_kind='current'").run(row.chat_id, row.topic_id)
  const insert = db.prepare('INSERT OR IGNORE INTO topic_identity_terms(chat_id,term,topic_id,indexed_revision,term_kind) VALUES(?,?,?,?,?)')
  let overflow=rawIdentityTerms(row.title).length>IDENTITY_TERMS_PER_VALUE_LIMIT||rawIdentityTerms(row.summary).length>IDENTITY_TERMS_PER_VALUE_LIMIT
  for (const term of new Set([...identityTerms(row.title), ...identityTerms(row.summary)])) insert.run(row.chat_id,term,row.topic_id,row.revision,'current')
  const aliases = db.prepare('SELECT title,summary,revision FROM topic_identity_aliases WHERE chat_id=? AND topic_id=?').all(row.chat_id,row.topic_id) as Array<{title:string;summary:string;revision:number}>
  for (const alias of aliases) {
    if(rawIdentityTerms(alias.title).length>IDENTITY_TERMS_PER_VALUE_LIMIT||rawIdentityTerms(alias.summary).length>IDENTITY_TERMS_PER_VALUE_LIMIT) overflow=true
    for (const term of new Set([...identityTerms(alias.title), ...identityTerms(alias.summary)])) insert.run(row.chat_id,term,row.topic_id,alias.revision,'historical')
  }
  if(overflow) reportIdentityIssue(db,row.chat_id,'topic',row.topic_id,'term_limit_exceeded',{limit:IDENTITY_TERMS_PER_VALUE_LIMIT})
  else db.prepare("UPDATE identity_backfill_issues SET state='resolved',updated_at=? WHERE chat_id=? AND entity_type='topic' AND entity_id=? AND issue_kind='term_limit_exceeded'").run(nowIso(),row.chat_id,row.topic_id)
  return overflow
}

function initializeMeta(db: Database, chatId: string, entityType: IdentityEntityType): IndexMeta {
  const table = entityType === 'todo' ? 'todos' : 'discussion_topics'
  const meta = db.prepare('SELECT state,cursor_entity_id,tokenizer_version FROM identity_index_meta WHERE chat_id=? AND entity_type=?').get(chatId,entityType) as IndexMeta | undefined
  if (!meta) {
    const count = hasTable(db,table) ? (db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE chat_id=?`).get(chatId) as {count:number}).count : 0
    const state = count === 0 ? 'ready' : 'building'
    db.prepare(`INSERT OR IGNORE INTO identity_index_meta(chat_id,entity_type,tokenizer_version,state,cursor_entity_id,last_error_code,updated_at)
      VALUES(?,?,? ,?,NULL,NULL,?)`).run(chatId,entityType,IDENTITY_QUERY_VERSION,state,nowIso())
    return db.prepare('SELECT state,cursor_entity_id,tokenizer_version FROM identity_index_meta WHERE chat_id=? AND entity_type=?').get(chatId,entityType) as IndexMeta
  }
  if (meta.tokenizer_version !== IDENTITY_QUERY_VERSION || meta.state === 'stale') {
    db.prepare("UPDATE identity_index_meta SET state='building',cursor_entity_id=NULL,tokenizer_version=?,last_error_code=NULL,updated_at=? WHERE chat_id=? AND entity_type=?")
      .run(IDENTITY_QUERY_VERSION,nowIso(),chatId,entityType)
    return { state:'building',cursor_entity_id:null,tokenizer_version:IDENTITY_QUERY_VERSION }
  }
  return meta
}

/** Indexes are resumable, bounded, and a caller may analyze only after the entire chat/type is ready. */
export function advanceIdentityIndex(db: Database, chatId: string, entityType: IdentityEntityType, batchSize = IDENTITY_INDEX_BATCH): boolean {
  if (entityType === 'topic' && !hasTable(db,'discussion_topics')) return true
  const meta = initializeMeta(db,chatId,entityType)
  if (meta.state === 'ready') return true
  if (meta.state === 'failed') return false
  const limit = Math.max(1,Math.min(500,Math.floor(batchSize)))
  const tx = db.transaction(() => {
    if (entityType === 'todo') {
      const rows = db.prepare(`SELECT id,chat_id,entity_revision,title,detail,source_msg_ids FROM todos WHERE chat_id=? AND (? IS NULL OR id>?) ORDER BY id LIMIT ?`)
        .all(chatId,meta.cursor_entity_id,meta.cursor_entity_id,limit) as Array<{id:string;chat_id:string;entity_revision:number;title:string;detail:string|null;source_msg_ids:string}>
      const overflow=rows.some((row)=>indexTodo(db,row))
      const next = rows.at(-1)?.id ?? meta.cursor_entity_id
      const more = db.prepare('SELECT 1 FROM todos WHERE chat_id=? AND (? IS NULL OR id>?) LIMIT 1').get(chatId,next,next)
      const state=overflow?'failed':more?'building':'ready'
      db.prepare('UPDATE identity_index_meta SET state=?,cursor_entity_id=?,last_error_code=?,updated_at=? WHERE chat_id=? AND entity_type=?')
        .run(state,overflow?meta.cursor_entity_id:more?next:null,overflow?'term_limit_exceeded':null,nowIso(),chatId,entityType)
      return !more&&!overflow
    }
    const rows = db.prepare(`SELECT topic_id,chat_id,revision,title,summary FROM discussion_topics WHERE chat_id=? AND (? IS NULL OR topic_id>?) ORDER BY topic_id LIMIT ?`)
      .all(chatId,meta.cursor_entity_id,meta.cursor_entity_id,limit) as Array<{topic_id:string;chat_id:string;revision:number;title:string;summary:string}>
    const overflow=rows.some((row)=>indexTopic(db,row))
    const next = rows.at(-1)?.topic_id ?? meta.cursor_entity_id
    const more = db.prepare('SELECT 1 FROM discussion_topics WHERE chat_id=? AND (? IS NULL OR topic_id>?) LIMIT 1').get(chatId,next,next)
    const state=overflow?'failed':more?'building':'ready'
    db.prepare('UPDATE identity_index_meta SET state=?,cursor_entity_id=?,last_error_code=?,updated_at=? WHERE chat_id=? AND entity_type=?')
      .run(state,overflow?meta.cursor_entity_id:more?next:null,overflow?'term_limit_exceeded':null,nowIso(),chatId,entityType)
    return !more&&!overflow
  })
  return runImmediateTransaction(tx)
}

export function identityIndexReady(db: Database, chatId: string, entityType: IdentityEntityType): boolean {
  if (entityType === 'topic' && !hasTable(db,'discussion_topics')) return true
  return (db.prepare('SELECT state FROM identity_index_meta WHERE chat_id=? AND entity_type=?').get(chatId,entityType) as {state:string}|undefined)?.state === 'ready'
}

function compactCandidates(candidates: IdentityCandidate[], truncated: boolean): { candidates: IdentityCandidate[]; truncated: boolean } {
  const bounded: IdentityCandidate[] = []
  let used = 0
  for (const candidate of candidates.slice(0,IDENTITY_CANDIDATE_LIMIT)) {
    const value = { ...candidate, title:candidate.title.slice(0,120), summary:candidate.summary?.slice(0,180) ?? null, sourceMsgIds:candidate.sourceMsgIds.slice(0,5) }
    const cost = JSON.stringify(value).length + 1
    if (used + cost > IDENTITY_CONTEXT_CHARS) { truncated = true; break }
    bounded.push(value); used += cost
  }
  return { candidates:bounded, truncated:truncated || candidates.length > bounded.length }
}

export function buildIdentityCandidateQuery(entityType:IdentityEntityType,chatId:string,texts:string[],sourceMsgIds:string[]):{sql:string|null;params:unknown[]} {
  const table = entityType === 'todo' ? 'todo_identity_terms' : 'topic_identity_terms'
  const idColumn = entityType === 'todo' ? 'todo_id' : 'topic_id'
  const entityTable = entityType === 'todo' ? 'todos' : 'discussion_topics'
  const revisionColumn = entityType === 'todo' ? 'entity_revision' : 'revision'
  const terms = boundedSearchTerms(texts).terms
  const sourceValues = sourceMsgIds.slice(0,100)
  if(terms.length===0&&sourceValues.length===0)return{sql:null,params:[]}
  if(terms.length===0&&sourceValues.length>0&&entityType==='todo'){
    const placeholders=sourceValues.map(()=>'?').join(',')
    return {sql:`SELECT e.id AS entity_id,e.title,e.detail AS summary,e.status,e.bucket,e.due_at,e.entity_revision AS revision,0 AS token_hits,0 AS exact_hit,0 AS alias_hit,1 AS source_hit
      FROM todo_identity_sources s JOIN todos e ON e.chat_id=s.chat_id AND e.id=s.todo_id
      WHERE s.chat_id=? AND s.msg_id IN (${placeholders}) GROUP BY e.id
      ORDER BY CASE e.status WHEN 'pending' THEN 0 WHEN 'waiting_reply' THEN 1 WHEN 'scheduled' THEN 2 WHEN 'suggested_done' THEN 3 WHEN 'done' THEN 4 ELSE 5 END,e.id LIMIT ?`,
      params:[chatId,...sourceValues,IDENTITY_CANDIDATE_LIMIT+1]}
  }
  if(terms.length===0&&sourceValues.length>0&&entityType==='topic'){
    const placeholders=sourceValues.map(()=>'?').join(',')
    return {sql:`SELECT t.topic_id AS entity_id,t.title,t.summary,NULL AS status,NULL AS bucket,NULL AS due_at,t.revision,0 AS token_hits,0 AS exact_hit,0 AS alias_hit,1 AS source_hit
      FROM discussion_topics t WHERE t.chat_id=? AND EXISTS(SELECT 1 FROM (
        SELECT e.msg_id FROM topic_evidence e WHERE e.topic_id=t.topic_id
        UNION SELECT s.msg_id FROM topic_identity_decision_sources s JOIN topic_identity_decisions d ON d.decision_id=s.decision_id WHERE d.chat_id=t.chat_id AND d.canonical_topic_id=t.topic_id
      ) source WHERE source.msg_id IN (${placeholders}))
      ORDER BY t.topic_id LIMIT ?`,params:[chatId,...sourceValues,IDENTITY_CANDIDATE_LIMIT+1]}
  }
  const placeholders = terms.map(()=>'?').join(',')
  const sourceSql = sourceValues.length ? (entityType==='todo'
    ? `EXISTS(SELECT 1 FROM todo_identity_sources s WHERE s.chat_id=e.chat_id AND s.todo_id=e.id AND s.msg_id IN (${sourceValues.map(()=>'?').join(',')}))`
    : `EXISTS(SELECT 1 FROM (SELECT s.msg_id FROM topic_evidence s WHERE s.topic_id=e.topic_id UNION SELECT dsrc.msg_id FROM topic_identity_decision_sources dsrc JOIN topic_identity_decisions d ON d.decision_id=dsrc.decision_id WHERE d.chat_id=e.chat_id AND d.canonical_topic_id=e.topic_id) s WHERE s.msg_id IN (${sourceValues.map(()=>'?').join(',')}))`) : '0'
  const sql = entityType === 'todo'
    ? `SELECT e.id AS entity_id,e.title,e.detail AS summary,e.status,e.bucket,e.due_at,e.entity_revision AS revision,
        SUM(CASE WHEN i.term_kind='current' THEN 1 ELSE 0 END) AS token_hits,
        MAX(CASE WHEN i.term LIKE 'h:%' AND i.term_kind='current' THEN 1 ELSE 0 END) AS exact_hit,
        MAX(CASE WHEN i.term_kind='historical' THEN 1 ELSE 0 END) AS alias_hit,
        ${sourceSql} AS source_hit
       FROM ${table} i JOIN ${entityTable} e ON e.chat_id=i.chat_id AND e.id=i.${idColumn} AND i.indexed_revision<=e.${revisionColumn}
       WHERE i.chat_id=? AND i.term IN (${placeholders}) GROUP BY e.id
       ORDER BY source_hit DESC,exact_hit DESC,token_hits DESC,CASE e.status WHEN 'pending' THEN 0 WHEN 'waiting_reply' THEN 1 WHEN 'scheduled' THEN 2 WHEN 'suggested_done' THEN 3 WHEN 'done' THEN 4 ELSE 5 END,e.id LIMIT ?`
    : `SELECT e.topic_id AS entity_id,e.title,e.summary,NULL AS status,NULL AS bucket,NULL AS due_at,e.revision,
        SUM(CASE WHEN i.term_kind='current' THEN 1 ELSE 0 END) AS token_hits,
        MAX(CASE WHEN i.term LIKE 'h:%' AND i.term_kind='current' THEN 1 ELSE 0 END) AS exact_hit,
        MAX(CASE WHEN i.term_kind='historical' THEN 1 ELSE 0 END) AS alias_hit,
        ${sourceSql} AS source_hit
       FROM ${table} i JOIN ${entityTable} e ON e.chat_id=i.chat_id AND e.topic_id=i.${idColumn} AND i.indexed_revision<=e.${revisionColumn}
       WHERE i.chat_id=? AND i.term IN (${placeholders}) GROUP BY e.topic_id
       ORDER BY exact_hit DESC,token_hits DESC,e.topic_id LIMIT ?`
  const params = [...sourceValues,chatId,...terms,IDENTITY_CANDIDATE_LIMIT+1]
  return {sql,params}
}

export function explainIdentityCandidateQuery(db:Database,entityType:IdentityEntityType,chatId:string,texts:string[],sourceMsgIds:string[]=[]):Array<{id:number;parent:number;notused:number;detail:string}> {
  const query=buildIdentityCandidateQuery(entityType,chatId,texts,sourceMsgIds)
  return query.sql?db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params) as Array<{id:number;parent:number;notused:number;detail:string}>:[]
}

function termMatchQuery(db: Database, entityType: IdentityEntityType, chatId: string, texts: string[], sourceMsgIds: string[]): { candidates: IdentityCandidate[]; truncated: boolean } {
  const termTruncated=boundedSearchTerms(texts).truncated
  const query=buildIdentityCandidateQuery(entityType,chatId,texts,sourceMsgIds)
  if (!query.sql) return { candidates:[], truncated:false }
  const rows = db.prepare(query.sql).all(...query.params) as Array<{entity_id:string;title:string;summary:string|null;status:string|null;bucket:string|null;due_at:string|null;revision:number;token_hits:number;exact_hit:number;alias_hit:number;source_hit:number}>
  const hitTruncated = rows.length > IDENTITY_CANDIDATE_LIMIT
  const records: IdentityCandidate[] = rows.slice(0,IDENTITY_CANDIDATE_LIMIT).map((row) => ({
    entityType,entityId:row.entity_id,title:row.title,summary:row.summary,status:row.status,bucket:row.bucket,dueAt:row.due_at,
    sourceMsgIds:entityType==='todo'
      ? (db.prepare('SELECT msg_id FROM todo_identity_sources WHERE chat_id=? AND todo_id=? ORDER BY msg_id LIMIT 5').all(chatId,row.entity_id) as Array<{msg_id:string}>).map(x=>x.msg_id)
      : (db.prepare('SELECT e.msg_id FROM topic_evidence e JOIN messages m ON m.msg_id=e.msg_id WHERE m.chat_id=? AND e.topic_id=? ORDER BY m.ts DESC,e.msg_id LIMIT 5').all(chatId,row.entity_id) as Array<{msg_id:string}>).map(x=>x.msg_id),
    recallReasons:[...(row.source_hit?['source_overlap' as const]:[]),...(row.exact_hit?['exact_title' as const]:[]),...(row.token_hits?['token_overlap' as const]:[]),...(row.alias_hit?['history_alias' as const]:[])],
    completionEventTs:entityType==='todo' ? latestCompletionEventTs(db,chatId,row.entity_id) : null
  }))
  return compactCandidates(records,hitTruncated||termTruncated)
}

export function recallTodoIdentityCandidates(db: Database, chatId: string, sourceTexts: string[], sourceMsgIds: string[]): { candidates:IdentityCandidate[];truncated:boolean;identityRevision:number;topicIdentityRevision:number;candidateRevisions:Array<{entityType:'todo'|'topic';entityId:string;revision:number}>;ready:boolean } {
  const ready = identityIndexReady(db,chatId,'todo') && identityIndexReady(db,chatId,'topic')
  const state = readChatSourceState(db,chatId)
  if (!ready || !state) return {candidates:[],truncated:false,identityRevision:state?.todoIdentityRevision ?? 0,topicIdentityRevision:state?.topicIdentityRevision ?? 0,candidateRevisions:[],ready:false}
  const todo = termMatchQuery(db,'todo',chatId,sourceTexts,sourceMsgIds)
  const topic = hasTable(db,'topic_identity_terms')?termMatchQuery(db,'topic',chatId,sourceTexts,sourceMsgIds):{candidates:[],truncated:false}
  const merged = [...todo.candidates,...topic.candidates].sort((a,b)=>{
    const score=(x:IdentityCandidate)=>x.recallReasons.includes('source_overlap')?0:x.recallReasons.includes('exact_title')?1:2
    return score(a)-score(b) || a.entityType.localeCompare(b.entityType) || a.entityId.localeCompare(b.entityId)
  })
  const compact = compactCandidates(merged,todo.truncated||topic.truncated)
  const revisions = compact.candidates.map((candidate)=>({entityType:candidate.entityType,entityId:candidate.entityId,revision: Number((db.prepare(candidate.entityType==='todo'?'SELECT entity_revision AS revision FROM todos WHERE chat_id=? AND id=?':'SELECT revision FROM discussion_topics WHERE chat_id=? AND topic_id=?').get(chatId,candidate.entityId) as {revision:number}|undefined)?.revision ?? 0)}))
  return {candidates:compact.candidates,truncated:compact.truncated,identityRevision:state.todoIdentityRevision,topicIdentityRevision:state.topicIdentityRevision,candidateRevisions:revisions,ready:true}
}

export function recallTopicIdentityCandidates(db:Database,chatId:string,sourceTexts:string[],sourceMsgIds:string[]=[]):{candidates:IdentityCandidate[];truncated:boolean;identityRevision:number;topicIdentityRevision:number;candidateRevisions:Array<{entityType:'todo'|'topic';entityId:string;revision:number}>;ready:boolean} {
  const state=readChatSourceState(db,chatId)
  if(!state||!identityIndexReady(db,chatId,'topic')) return {candidates:[],truncated:false,identityRevision:state?.todoIdentityRevision??0,topicIdentityRevision:state?.topicIdentityRevision??0,candidateRevisions:[],ready:false}
  const result=termMatchQuery(db,'topic',chatId,sourceTexts,sourceMsgIds)
  const revisions=result.candidates.map((candidate)=>({entityType:'topic' as const,entityId:candidate.entityId,revision:(db.prepare('SELECT revision FROM discussion_topics WHERE chat_id=? AND topic_id=?').get(chatId,candidate.entityId) as {revision:number}).revision}))
  return {candidates:result.candidates,truncated:result.truncated,identityRevision:state.todoIdentityRevision,topicIdentityRevision:state.topicIdentityRevision,candidateRevisions:revisions,ready:true}
}

export function captureIdentitySnapshot(db: Database, chatId: string, messages: MessageDTO[], candidatesTruncated: boolean, candidateRevisions: IdentityContextSnapshot['candidateRevisions']): IdentityContextSnapshot | null {
  const state = readChatSourceState(db,chatId)
  if (!state) return null
  return {
    sourceEpoch:state.sourceEpoch,scopeRevision:state.scopeRevision,identityRevision:state.todoIdentityRevision,topicIdentityRevision:state.topicIdentityRevision,
    queryVersion:IDENTITY_QUERY_VERSION,candidatesTruncated,
    candidateRevisions,
    selectedFingerprints:messages.map((message)=>({msgId:message.msgId,contentFingerprint:fingerprintSourceMessage(message)}))
  }
}

export function beginIdentitySourceAttempt(db:Database,chatId:string,snapshot:IdentityContextSnapshot,serializedUserPayload:string,sessionFingerprint:string,now=new Date(),targetType:IdentityEntityType='todo'):{lease:ChatSourceLease|null;reason:string|null} {
  const state=readChatSourceState(db,chatId)
  if (!state) return {lease:null,reason:'chat_missing'}
  if (state.sourceEpoch!==snapshot.sourceEpoch || state.scopeRevision!==snapshot.scopeRevision) return {lease:null,reason:'identity_source_or_scope_stale'}
  if (state.todoIdentityRevision!==snapshot.identityRevision || state.topicIdentityRevision!==snapshot.topicIdentityRevision) return {lease:null,reason:'identity_candidate_set_stale'}
  try { assertIdentitySnapshotCurrent(db,chatId,snapshot,targetType) } catch { return {lease:null,reason:'identity_candidate_or_source_stale'} }
  const leaseId=randomUUID()
  const expiresAt=new Date(now.getTime()+20*60_000).toISOString()
  const coordinator=sharedSourceRows(db)
  const acquired=coordinator.acquireLease(chatId,leaseId,expiresAt,now.toISOString())
  if (!acquired.ok) return {lease:null,reason:acquired.reason}
  const payloadBytes=Buffer.byteLength(serializedUserPayload,'utf8')
  const policy=sourceSessionPolicy(db)
  const overBudget=state.acceptedTurns>=policy.turns||state.submittedRequests>=policy.requests||state.submittedUserUtf8Bytes+payloadBytes>policy.userBytes
  const idleExpired=state.lastAcceptedAt!==null&&now.getTime()-Date.parse(state.lastAcceptedAt)>policy.idleMs
  const rotate=state.sessionFingerprint===sessionFingerprint&&(state.tainted||(policy.rollover==='epoch'&&(overBudget||idleExpired)))
  const session=coordinator.setSessionFingerprint(acquired.lease,sessionFingerprint,now.toISOString(),rotate)
  if (!session) return {lease:null,reason:'session_stale'}
  const attempt=recordIdentitySourceAttempt(db,session,serializedUserPayload,now)
  if (!attempt.ok) { coordinator.releaseLease(session,true,now.toISOString());return {lease:null,reason:attempt.reason} }
  return {lease:attempt.lease,reason:null}
}

export function recordIdentitySourceAttempt(db:Database,lease:ChatSourceLease,serializedUserPayload:string,now=new Date(),allowEpochRotate=true):{ok:true;userUtf8Bytes:number;lease:ChatSourceLease}|{ok:false;reason:string} {
  const coordinator=sharedSourceRows(db)
  const renewed=coordinator.renewLease(lease,new Date(now.getTime()+20*60_000).toISOString(),now.toISOString())
  if(!renewed)return{ok:false,reason:'lease_stale'}
  const state=readChatSourceState(db,renewed.chatId)
  if(!state)return{ok:false,reason:'chat_missing'}
  const payloadBytes=Buffer.byteLength(serializedUserPayload,'utf8')
  const policy=sourceSessionPolicy(db)
  const idleExpired=state.lastAcceptedAt!==null&&now.getTime()-Date.parse(state.lastAcceptedAt)>policy.idleMs
  const overBudget=state.acceptedTurns>=policy.turns||state.submittedRequests>=policy.requests||state.submittedUserUtf8Bytes+payloadBytes>policy.userBytes
  const rotate=state.tainted||idleExpired||(policy.rollover==='epoch'&&overBudget)
  if(rotate&&!allowEpochRotate)return{ok:false,reason:'attempt_limit'}
  // 外掛政策：Host Session 永遠接續，預算用完只歸零計數（資料庫的 CHECK 不允許放寬門檻），epoch 與 tainted 不動。
  const rolled=!rotate&&policy.rollover==='counters'&&overBudget?coordinator.resetSessionCounters(renewed,now.toISOString()):renewed
  const current=rotate&&state.sessionFingerprint?coordinator.setSessionFingerprint(renewed,state.sessionFingerprint,now.toISOString(),true):rolled
  if(!current)return{ok:false,reason:'session_stale'}
  const attempt=coordinator.beginAttempt(current,serializedUserPayload,now.toISOString())
  return attempt.ok?{ok:true,userUtf8Bytes:attempt.userUtf8Bytes,lease:current}:{ok:false,reason:attempt.reason}
}

export function releaseIdentitySourceAttempt(db:Database,lease:ChatSourceLease,taint=true):void {
  sharedSourceRows(db).releaseLease(lease,taint)
}

export function renewIdentitySourceLease(db:Database,lease:ChatSourceLease,now=new Date()):ChatSourceLease|null {
  return sharedSourceRows(db).renewLease(lease,new Date(now.getTime()+20*60_000).toISOString(),now.toISOString())
}

export function assertIdentitySnapshotCurrent(db: Database, chatId: string, snapshot: IdentityContextSnapshot, targetType: IdentityEntityType): void {
  const state = readChatSourceState(db,chatId)
  if (!state || state.sourceEpoch!==snapshot.sourceEpoch || state.scopeRevision!==snapshot.scopeRevision) throw new Error('identity_source_or_scope_stale')
  const revision = targetType==='todo' ? state.todoIdentityRevision : state.topicIdentityRevision
  const expectedRevision=targetType==='todo'?snapshot.identityRevision:snapshot.topicIdentityRevision
  if (revision!==expectedRevision) throw new Error('identity_candidate_set_stale')
  for (const candidate of snapshot.candidateRevisions) {
    const row = candidate.entityType==='todo'
      ? db.prepare('SELECT entity_revision AS revision FROM todos WHERE chat_id=? AND id=?').get(chatId,candidate.entityId) as {revision:number}|undefined
      : db.prepare('SELECT revision FROM discussion_topics WHERE chat_id=? AND topic_id=?').get(chatId,candidate.entityId) as {revision:number}|undefined
    if (!row || row.revision!==candidate.revision) throw new Error('identity_candidate_revision_stale')
  }
  const ids=snapshot.selectedFingerprints.map((row)=>row.msgId)
  if (ids.length) {
    const rows:Array<Record<string,unknown>>=[]
    for(let offset=0;offset<ids.length;offset+=900){
      const part=ids.slice(offset,offset+900)
      if(part.length) rows.push(...db.prepare(`SELECT * FROM messages WHERE chat_id=? AND msg_id IN (${part.map(()=>'?').join(',')})`).all(chatId,...part) as Array<Record<string,unknown>>)
    }
    const byId=new Map(rows.map((row)=>[String(row.msg_id),row]))
    for (const selected of snapshot.selectedFingerprints) {
      const row=byId.get(selected.msgId)
      if (!row) throw new Error('identity_source_row_stale')
      const source={msgId:String(row.msg_id),chatId:String(row.chat_id),ts:Number(row.ts),timeIso:String(row.time_iso),direction:row.direction as 'in'|'out',sender:row.sender as string|null,text:row.text as string|null,contentType:Number(row.content_type),processed:Number(row.processed)===1,ingestedAt:String(row.ingested_at),origFilename:row.orig_filename as string|null,fileSize:row.file_size as number|null,unsent:Number(row.unsent)===1}
      if (fingerprintSourceMessage(source as MessageDTO)!==selected.contentFingerprint) throw new Error('identity_source_row_stale')
    }
  }
}

export function deterministicSourceDigest(chatId: string, snapshot: IdentityContextSnapshot): string {
  return createHash('sha256').update(JSON.stringify({chatId,sourceEpoch:snapshot.sourceEpoch,selected:snapshot.selectedFingerprints,queryVersion:snapshot.queryVersion}),'utf8').digest('hex')
}

export function advanceIndexForExistingChats(db: Database, entityType: IdentityEntityType, batchSize=IDENTITY_INDEX_BATCH): number {
  if (entityType==='topic' && !hasTable(db,'discussion_topics')) return 0
  const chats=db.prepare('SELECT chat_id FROM chats ORDER BY chat_id').all() as Array<{chat_id:string}>
  let unfinished=0
  for (const chat of chats) if (!advanceIdentityIndex(db,chat.chat_id,entityType,batchSize)) unfinished+=1
  return unfinished
}

export function saveTodoAliasBeforeMutation(db: Database, chatId: string, todoId: string): void {
  const row=db.prepare('SELECT title,detail,source_msg_ids,entity_revision FROM todos WHERE chat_id=? AND id=?').get(chatId,todoId) as {title:string;detail:string|null;source_msg_ids:string;entity_revision:number}|undefined
  if (!row) return
  db.prepare('INSERT OR IGNORE INTO todo_identity_aliases(alias_id,chat_id,todo_id,title,detail,source_msg_ids,entity_revision,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(randomUUID(),chatId,todoId,row.title,row.detail,row.source_msg_ids,row.entity_revision,nowIso())
}

export function refreshTodoIdentityTerms(db: Database, chatId: string, todoId: string, preserveReady = false): void {
  const row=db.prepare('SELECT id,chat_id,entity_revision,title,detail,source_msg_ids FROM todos WHERE chat_id=? AND id=?').get(chatId,todoId) as {id:string;chat_id:string;entity_revision:number;title:string;detail:string|null;source_msg_ids:string}|undefined
  if (!row) return
  const overflow=indexTodo(db,row)
  if (preserveReady) db.prepare('UPDATE identity_index_meta SET state=?,cursor_entity_id=NULL,last_error_code=?,updated_at=? WHERE chat_id=? AND entity_type=\'todo\'').run(overflow?'failed':'ready',overflow?'term_limit_exceeded':null,nowIso(),chatId)
}

export function identityMetaState(db: Database, chatId:string, entityType:IdentityEntityType):string|null {
  return (db.prepare('SELECT state FROM identity_index_meta WHERE chat_id=? AND entity_type=?').get(chatId,entityType) as {state:string}|undefined)?.state ?? null
}

function latestCompletionEventTs(db:Database,chatId:string,todoId:string):number|null {
  if (!hasTable(db,'todo_identity_decisions')) return null
  const row=db.prepare(`SELECT e.payload_json FROM todo_identity_events e JOIN todo_identity_decisions d ON d.decision_id=e.decision_id
    WHERE d.chat_id=? AND d.canonical_todo_id=? AND e.action='resolved_existing' AND json_type(e.payload_json,'$.completionEventTs')='integer' ORDER BY e.created_at DESC,e.event_revision DESC LIMIT 1`).get(chatId,todoId) as {payload_json:string}|undefined
  if (!row) return null
  try {
    const value=JSON.parse(row.payload_json) as {completionEventTs?:unknown}
    return typeof value.completionEventTs==='number'&&Number.isFinite(value.completionEventTs)?value.completionEventTs:null
  } catch { return null }
}

export function syncTopicIdentityTerms(db: Database, chatId:string, topicId:string, preserveReady=false): void {
  const row=db.prepare('SELECT topic_id,chat_id,revision,title,summary FROM discussion_topics WHERE chat_id=? AND topic_id=?').get(chatId,topicId) as {topic_id:string;chat_id:string;revision:number;title:string;summary:string}|undefined
  if (!row) return
  const overflow=indexTopic(db,row)
  if (preserveReady) db.prepare('UPDATE identity_index_meta SET state=?,cursor_entity_id=NULL,last_error_code=?,updated_at=? WHERE chat_id=? AND entity_type=\'topic\'').run(overflow?'failed':'ready',overflow?'term_limit_exceeded':null,nowIso(),chatId)
}

export function insertIdentityEvent(db:Database, input:{decisionId:string;revision:number;actor:'ai'|'user'|'system';action:string;payload:unknown;table:'todo_identity_events'|'topic_identity_events'}):void {
  db.prepare(`INSERT INTO ${input.table}(event_id,decision_id,event_revision,actor,action,payload_json,created_at) VALUES(?,?,?,?,?,?,?)`)
    .run(randomUUID(),input.decisionId,input.revision,input.actor,input.action,JSON.stringify(input.payload),nowIso())
}

export function tableExists(db:Database, table:string):boolean { return hasTable(db,table) }

export function listIdentityBackfillIssues(db:Database,input:{chatId?:string;state?:'open'|'resolved';limit?:number}={}):Array<{issueId:string;chatId:string;entityType:IdentityEntityType;entityId:string;issueKind:'malformed_source_json'|'orphan_source_ref'|'term_limit_exceeded';detail:unknown;state:'open'|'resolved';createdAt:string;updatedAt:string}> {
  const where:string[]=[];const params:unknown[]=[]
  if(input.chatId){where.push('chat_id=?');params.push(input.chatId)}
  if(input.state){where.push('state=?');params.push(input.state)}
  const limit=Math.max(1,Math.min(200,Math.floor(input.limit??100)))
  const rows=db.prepare(`SELECT issue_id,chat_id,entity_type,entity_id,issue_kind,detail_json,state,created_at,updated_at FROM identity_backfill_issues ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY updated_at,issue_id LIMIT ?`).all(...params,limit) as Array<{issue_id:string;chat_id:string;entity_type:IdentityEntityType;entity_id:string;issue_kind:'malformed_source_json'|'orphan_source_ref'|'term_limit_exceeded';detail_json:string;state:'open'|'resolved';created_at:string;updated_at:string}>
  return rows.map((row)=>{
    let detail:unknown=null
    try{detail=JSON.parse(row.detail_json) as unknown}catch{/* stored detail remains visible as null */}
    return {issueId:row.issue_id,chatId:row.chat_id,entityType:row.entity_type,entityId:row.entity_id,issueKind:row.issue_kind,detail,state:row.state,createdAt:row.created_at,updatedAt:row.updated_at}
  })
}

