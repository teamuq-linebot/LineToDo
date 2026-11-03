import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import NativeDatabase from 'better-sqlite3-plugin'
import { test } from 'node:test'
import { createBetterSqlite3AppEngine } from '../src/main/db/appDbEngine.ts'
import { openDatabase } from '../src/main/db/database.ts'
import { createTodo, getOpenTodosByChat, listTodos, updateStatus } from '../src/main/db/todos.repo.ts'
import { getMessagesByChatAndIds, insertMessages } from '../src/main/db/messages.repo.ts'
import { migrate } from '../src/main/db/migrate.ts'
import { SCHEMA_VERSION, SOURCE_CACHE_DDL } from '../src/main/db/schema.ts'
import { advanceIdentityIndex, beginIdentitySourceAttempt, captureIdentitySnapshot, explainIdentityCandidateQuery, listIdentityBackfillIssues, recallTodoIdentityCandidates, recallTopicIdentityCandidates, releaseIdentitySourceAttempt } from '../src/main/db/identity.repo.ts'
import { readChatSourceState } from '../src/main/db/sourceCache.ts'
import { applyChatExtract, buildTodoApply } from '../src/main/pipeline/runOnce.ts'
import { runOnce } from '../src/main/pipeline/runOnce.ts'
import { reviewLastDays } from '../src/main/pipeline/backfill.ts'
import { ExtractQueue } from '../src/plugin/backend/extractQueue.ts'
import { ReviewCoordinator, ReviewLedger } from '../src/plugin/backend/reviewRun.ts'
import { getPipelineDefaults } from '../src/main/config/defaults.ts'
import { ensureGroupTopicsSchema, GROUP_TOPICS_SCHEMA_VERSION, setCrossChatEnabled, setEnabled } from '../src/main/features/groupTopics/repository.ts'
import { createGroupTopicsService } from '../src/main/features/groupTopics/service.ts'
import { createIdentityRetryService } from '../src/main/identity/retryService.ts'
import { explainIdentityInboxQueryPlan, explainTopicLinkProposalQueryPlan, listIdentityInbox, listTodoRelationsForTodo, listTodoTopicRelationsForChat, listTodoTopicRelationsForTopic, listTopicLinkProposals, resolveIdentityDecision, resolveTodoTopicRelation, resolveTopicLinkProposal, retryIdentityDecision } from '../src/main/identity/reviewPorts.ts'
import { EXTRACT_JSON_SCHEMA, validateExtractResult } from '../src/main/llm/schema.ts'
import { extractTodos } from '../src/main/llm/extractor.ts'

const NOW='2026-10-28T05:00:00.000Z'
const SESSION=createHash('sha256').update('identity-test-session-v1').digest('hex')
const stored=(id)=>`i:${id}`

function openFixture(dbPath=':memory:'){
  const engine=createBetterSqlite3AppEngine({driver:NativeDatabase})
  return openDatabase({dbPath,engine})
}

function rawMessage(id,chatId='identity-chat',ts=1000,text='alpha beta action'){
  return {msgId:id,chat:`Chat ${chatId}`,chatId,isGroup:true,ts,time:new Date(ts).toISOString().slice(0,19),direction:'in',sender:'Alice',text,contentType:0}
}

function addMessage(db,id,ts,text,chatId='identity-chat'){
  insertMessages([rawMessage(id,chatId,ts,text)],db)
  return stored(id)
}

function drainIndex(db,chatId,type,batch=30){
  for(let i=0;i<100;i+=1){if(advanceIdentityIndex(db,chatId,type,batch))return}
  throw new Error(`${type}_identity_index_did_not_finish`)
}

function buildWork(db,chatId,msgIds,{truncated=false}={}){
  const rows=getMessagesByChatAndIds(chatId,msgIds,db)
  assert.equal(rows.length,msgIds.length)
  drainIndex(db,chatId,'todo')
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='discussion_topics'").get())drainIndex(db,chatId,'topic')
  const recalled=recallTodoIdentityCandidates(db,chatId,rows.map((row)=>row.text??''),msgIds)
  assert.equal(recalled.ready,true)
  const candidatesTruncated=truncated||recalled.truncated
  const snapshot=captureIdentitySnapshot(db,chatId,rows,candidatesTruncated,recalled.candidateRevisions)
  assert.ok(snapshot)
  const started=beginIdentitySourceAttempt(db,chatId,snapshot,JSON.stringify({source:msgIds}),SESSION,new Date())
  assert.ok(started.lease,started.reason)
  snapshot.sourceLease=started.lease
  return {rows,recalled,snapshot,candidatesTruncated,lease:started.lease,openTodos:getOpenTodosByChat(chatId,db)}
}

function todoDraft(msgId,draftRef='draft_1',overrides={}){
  return {draftRef,bucket:'todo',title:'完成 alpha beta action',detail:null,priority:2,dueAt:null,confidence:0.9,sourceMsgIds:[msgId],...overrides}
}

function todoDecision(msgId,draftRef,overrides={}){
  return {draftRef,outcome:'new',candidateType:null,candidateId:null,relationKind:null,reasonCode:'insufficient_evidence',confidenceBand:'high',evidenceMsgIds:[msgId],...overrides}
}

function runTodoApply(db,chatId,msgId,work,extract){
  const tally={todosCreated:0,todosMerged:0,todosResolvedDone:0,todosSuggestedDone:0,createdIds:[],resolvedIds:[],updatedIds:[]}
  applyChatExtract({db,cfg:getPipelineDefaults(),now:NOW,identity:{
    snapshot:work.snapshot,sourceLease:work.lease,candidates:work.recalled.candidates,candidatesTruncated:work.candidatesTruncated,
    selectedMessageIds:[msgId],targetType:'todo',allowedTodoIds:work.openTodos.map((todo)=>todo.id)
  }},chatId,[msgId],extract,tally)
  return tally
}

function newExtract(msgId,decision,draft=todoDraft(msgId,decision.draftRef)){
  return {importance:'action',newTodos:[draft],identityDecisions:[decision],resolved:[],updates:[]}
}

function identityExtractor(input){
  const msgId=input.newMessages[0].msgId
  const candidate=input.identityCandidates.find((item)=>item.entityType==='todo')
  const decision=candidate
    ? todoDecision(msgId,'live-draft',{outcome:'update_existing',candidateType:'todo',candidateId:candidate.entityId,relationKind:null,reasonCode:'same_active_action'})
    : todoDecision(msgId,'live-draft')
  return newExtract(msgId,decision,todoDraft(msgId,'live-draft',{title:'完成 alpha beta service action'}))
}

function legacyV6(){
  const db=new NativeDatabase(':memory:');db.pragma('foreign_keys=ON')
  db.exec([
    'CREATE TABLE chats(chat_id TEXT PRIMARY KEY,name TEXT,is_group INTEGER NOT NULL DEFAULT 0,blocked INTEGER NOT NULL DEFAULT 0,block_reason TEXT,first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL);',
    "CREATE TABLE messages(msg_id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,ts INTEGER NOT NULL,time_iso TEXT NOT NULL,direction TEXT NOT NULL CHECK(direction IN ('in','out')),sender TEXT,text TEXT,content_type INTEGER NOT NULL DEFAULT 0,processed INTEGER NOT NULL DEFAULT 0,ingested_at TEXT NOT NULL,key_material TEXT,orig_filename TEXT,file_size INTEGER,media_backed_up INTEGER NOT NULL DEFAULT 0,unsent INTEGER NOT NULL DEFAULT 0,FOREIGN KEY(chat_id) REFERENCES chats(chat_id));",
    'CREATE INDEX idx_messages_chat_ts ON messages(chat_id,ts);',
    'CREATE TABLE todos(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,bucket TEXT NOT NULL,status TEXT NOT NULL,title TEXT NOT NULL,detail TEXT,priority INTEGER NOT NULL DEFAULT 2,due_at TEXT,source_msg_ids TEXT NOT NULL,confidence REAL NOT NULL DEFAULT .5,completion_evidence TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,resolved_at TEXT,FOREIGN KEY(chat_id) REFERENCES chats(chat_id));',
    "INSERT INTO chats VALUES('legacy-chat','Legacy',1,0,NULL,'2026-01-01','2026-01-02');",
    "INSERT INTO messages(msg_id,chat_id,ts,time_iso,direction,sender,text,content_type,processed,ingested_at,unsent) VALUES('legacy-msg','legacy-chat',10,'2026-01-01T00:00:10','in','A','legacy source',0,1,'2026-01-02',0);",
    "INSERT INTO todos(id,chat_id,bucket,status,title,source_msg_ids,created_at,updated_at,resolved_at) VALUES('legacy-todo','legacy-chat','todo','done','Legacy task','[\"legacy-msg\"]','2026-01-01','2026-01-02','2026-01-02');",
    'PRAGMA user_version=6;'
  ].join('\n'))
  return db
}

test('Core v7 upgrades add identity objects transactionally and preserves the Phase 1 layout',()=>{
  const db=legacyV6()
  try{
    db.exec(SOURCE_CACHE_DDL);db.pragma('user_version=7')
    const before=db.prepare('SELECT id,source_msg_ids,status FROM todos').get()
    assert.deepEqual(migrate(db),{from:7,to:8})
    assert.equal(db.pragma('user_version',{simple:true}),SCHEMA_VERSION)
    assert.deepEqual(db.prepare('SELECT id,source_msg_ids,status FROM todos').get(),before)
    assert.equal(db.prepare('SELECT entity_revision FROM todos WHERE id=?').get('legacy-todo').entity_revision,1)
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='todo_identity_decisions'").get())
    assert.equal(db.pragma('foreign_key_check').length,0)
  }finally{db.close()}
})

test('file-backed native restart preserves identity index, defer inbox, exact source progress and cache checkpoint',()=>{
  const scratch='C:/teamuq/teamuq-plugins/output/linetodo-cache-identity-implementation-20261028/developer/phase2/scratch/native-identity-reopen'
  mkdirSync(scratch,{recursive:true})
  const folder=mkdtempSync(join(scratch,'fixture-'))
  const file=join(folder,'line-todo.db')
  let opened=openFixture(file);let db=opened.db;const chatId='identity-chat'
  try{
    const oldSource=addMessage(db,'reopen-existing-source',900,'alpha beta completed action')
    createTodo({chatId,bucket:'todo',status:'done',title:'Alpha beta completed action',sourceMsgIds:[oldSource]},db)
    drainIndex(db,chatId,'todo');drainIndex(db,chatId,'topic')
    const deferSource=addMessage(db,'reopen-defer-source',1000,'alpha beta unclear request')
    const work=buildWork(db,chatId,[deferSource],{truncated:true})
    const oldCandidate=work.recalled.candidates.find((candidate)=>candidate.entityType==='todo')
    assert.ok(oldCandidate)
    const defer=todoDecision(deferSource,'d-reopen',{outcome:'defer',candidateType:'todo',candidateId:oldCandidate.entityId,relationKind:null,reasonCode:'candidate_cap',confidenceBand:'low'})
    runTodoApply(db,chatId,deferSource,work,newExtract(deferSource,defer,todoDraft(deferSource,'d-reopen',{title:'Alpha beta unclear request'})))
    const before=readChatSourceState(db,chatId)
    assert.equal(before.windowComplete,true)
    assert.equal(db.prepare("SELECT state FROM identity_index_meta WHERE chat_id=? AND entity_type='todo'").get(chatId).state,'ready')
  }finally{opened.close()}
  opened=openFixture(file);db=opened.db
  try{
    ensureGroupTopicsSchema(db)
    assert.equal(db.prepare('SELECT processed FROM messages WHERE msg_id=?').get(stored('reopen-defer-source')).processed,1)
    assert.equal(readChatSourceState(db,chatId).windowComplete,true)
    assert.equal(db.prepare("SELECT state FROM identity_index_meta WHERE chat_id=? AND entity_type='todo'").get(chatId).state,'ready')
    assert.ok(db.prepare('SELECT 1 FROM todo_identity_terms WHERE chat_id=? AND todo_id=?').get(chatId,db.prepare("SELECT id FROM todos WHERE title='Alpha beta completed action'").get().id))
    const inbox=listIdentityInbox(db,'todo',{chatId,limit:10})
    assert.equal(inbox.items.length,1)
    assert.equal(inbox.items[0].state,'open')
    assert.deepEqual(inbox.items[0].sourceMsgIds,[stored('reopen-defer-source')])
    const retried=retryIdentityDecision(db,'todo',inbox.items[0].decisionId,inbox.items[0].decisionRevision)
    assert.equal(retried.ok,true)
    if(!retried.ok) throw new Error(retried.reason)
    assert.equal(retried.item.decisionRevision,2)
    assert.equal(db.pragma('foreign_key_check').length,0)
  }finally{opened.close()}
})

test('Core v7 to v8 injected DDL failure rolls back identity DDL and entity revision column',()=>{
  const db=legacyV6()
  try{
    db.exec(SOURCE_CACHE_DDL)
    db.exec('CREATE VIEW identity_index_meta AS SELECT 1 AS incompatible; PRAGMA user_version=7;')
    assert.throws(()=>migrate(db))
    assert.equal(db.pragma('user_version',{simple:true}),7)
    const columns=db.prepare('PRAGMA table_info(todos)').all().map((column)=>column.name)
    assert.equal(columns.includes('entity_revision'),false)
    assert.equal(db.prepare("SELECT type FROM sqlite_master WHERE name='todo_identity_decisions'").get(),undefined)
    assert.equal(db.prepare('SELECT source_msg_ids FROM todos WHERE id=?').get('legacy-todo').source_msg_ids,'["legacy-msg"]')
  }finally{db.close()}
})

test('GroupTopics v2 to v3 adds historical identity storage without changing topic/evidence IDs',()=>{
  const opened=openFixture();const db=opened.db
  try{
    const msgId=addMessage(db,'topic-v2-source',1000,'alpha beta topic')
    ensureGroupTopicsSchema(db)
    const chatId='identity-chat'
    const runId='topic-run-v2'
    db.prepare(`INSERT INTO discussion_topics(topic_id,chat_id,local_ref,title,summary,created_at,last_source_ts,revision) VALUES(?,?,?,?,?,?,?,1)`).run('topic-existing',chatId,'local-old','Alpha beta topic','Old summary',NOW,1000)
    db.prepare(`INSERT INTO topic_analysis_runs(run_id,chat_id,input_digest,prompt_version,prompt_hash,schema_version,schema_hash,state,created_at) VALUES(?,?,?,?,?,?,?,'complete',?)`).run(runId,chatId,'d'.repeat(64),'p','p'.repeat(64),'s','s'.repeat(64),NOW)
    db.prepare(`INSERT INTO topic_evidence(topic_id,msg_id,relation,confidence,relevance,relevance_evidence_msg_ids,run_id) VALUES(?,?,'about',.8,'unknown','[]',?)`).run('topic-existing',msgId,runId)
    const keepEvidence=db.prepare('SELECT topic_id,msg_id FROM topic_evidence').get()
    db.exec(`
      DROP TRIGGER trg_topics_identity_insert; DROP TRIGGER trg_topics_identity_update;
      DROP TRIGGER trg_topic_evidence_identity_insert; DROP TRIGGER trg_topic_evidence_identity_update; DROP TRIGGER trg_topic_evidence_identity_delete;
      DROP TRIGGER trg_topic_links_identity_insert; DROP TRIGGER trg_topic_links_identity_update; DROP TRIGGER trg_topic_links_identity_delete;
      DROP TABLE topic_link_identity_events; DROP TABLE topic_identity_events; DROP TABLE topic_identity_decision_sources; DROP TABLE topic_identity_decisions;
      DROP TABLE topic_identity_aliases; DROP TABLE topic_identity_terms; DROP INDEX ux_discussion_topics_chat_id; DROP INDEX idx_topic_evidence_source;
      DROP INDEX idx_topic_links_left_status; DROP INDEX idx_topic_links_right_status;
      ALTER TABLE topic_links DROP COLUMN stale_at;
      DELETE FROM identity_index_meta WHERE chat_id='identity-chat' AND entity_type='topic';
      UPDATE group_topics_meta SET value='2' WHERE key='schema_version';
    `)
    ensureGroupTopicsSchema(db)
    assert.equal(GROUP_TOPICS_SCHEMA_VERSION,3)
    assert.equal(db.prepare("SELECT value FROM group_topics_meta WHERE key='schema_version'").get().value,'3')
    assert.deepEqual(db.prepare('SELECT topic_id,msg_id FROM topic_evidence').get(),keepEvidence)
    assert.equal(db.prepare('SELECT topic_id FROM discussion_topics WHERE local_ref=?').get('local-old').topic_id,'topic-existing')
    assert.equal(db.pragma('foreign_key_check').length,0)
  }finally{opened.close()}
})

test('strict decision validation rejects invented candidates, unselected evidence and candidate-cap new outcomes',()=>{
  const candidate={entityType:'todo',entityId:'todo-1',title:'Alpha beta',summary:null,status:'pending',bucket:'todo',dueAt:null,sourceMsgIds:[],recallReasons:['token_overlap'],completionEventTs:null}
  const context={candidates:[candidate],candidatesTruncated:false,selectedMessageIds:['i:m1'],targetType:'todo',allowedTodoIds:['todo-1']}
  const valid={importance:'action',newTodos:[todoDraft('i:m1','d1')],identityDecisions:[todoDecision('i:m1','d1',{outcome:'update_existing',candidateType:'todo',candidateId:'todo-1',reasonCode:'same_active_action',relationKind:null})],resolved:[],updates:[]}
  assert.equal(validateExtractResult(valid,context).identityDecisions.length,1)
  assert.throws(()=>validateExtractResult({...valid,identityDecisions:[{...valid.identityDecisions[0],candidateId:'invented'}]},context),/invalid_identity_decision|candidate_not_supplied/u)
  assert.throws(()=>validateExtractResult({...valid,identityDecisions:[{...valid.identityDecisions[0],evidenceMsgIds:['other']}]},context),/invalid_identity_decision|unselected_or_duplicate_evidence/u)
  assert.throws(()=>validateExtractResult({...valid,identityDecisions:[todoDecision('i:m1','d1')]},{...context,candidatesTruncated:true}),/invalid_identity_decision|candidate_context_truncated/u)
  assert.throws(()=>validateExtractResult({...valid,identityDecisions:[{...valid.identityDecisions[0],revision:1}]},context),(error)=>Array.isArray(error?.issues)&&error.issues.some((issue)=>issue.code==='unrecognized_keys'))
})

test('standalone decoder schema constrains candidate and evidence IDs to application-supplied context',async()=>{
  const opened=openFixture();const db=opened.db
  try{
    const msgId=addMessage(db,'schema-context',1000,'alpha beta action')
    const message=getMessagesByChatAndIds('identity-chat',[msgId],db)[0]
    const candidate={entityType:'todo',entityId:'trusted-todo',title:'Alpha beta',summary:null,status:'pending',bucket:'todo',dueAt:null,sourceMsgIds:[],recallReasons:['token_overlap'],completionEventTs:null}
    let requestSchema
    const provider={id:'http',kind:'http',health:async()=>({ok:true,summary:'fixture',details:{}}),complete:async(request)=>{
      requestSchema=request.jsonSchema.schema
      return {text:'',structured:{importance:'action',newTodos:[todoDraft(msgId,'schema-draft')],identityDecisions:[todoDecision(msgId,'schema-draft')],resolved:[],updates:[]},meta:{provider:'http',model:'fixture',durationMs:0}}
    }}
    const result=await extractTodos(provider,{now:NOW,chat:{chatId:'identity-chat',name:'Identity',isGroup:true},newMessages:[message],recentContext:[],openTodos:[],identityCandidates:[candidate],identityCandidatesTruncated:false},{})
    assert.equal(result.newTodos[0].sourceMsgIds[0],msgId)
    const properties=requestSchema.properties.identityDecisions.items.properties
    assert.deepEqual(properties.candidateId.enum,[null,'trusted-todo'])
    assert.deepEqual(properties.evidenceMsgIds.items.enum,[msgId])
    assert.deepEqual(requestSchema.properties.newTodos.items.properties.sourceMsgIds.items.enum,[msgId])
  }finally{opened.close()}
})

test('tainted identity attempt rotates the shared cache session even when the prompt/model fingerprint is unchanged',()=>{
  const opened=openFixture();const db=opened.db;const chatId='identity-chat'
  try{
    const msgId=addMessage(db,'taint-row',1000,'alpha beta action')
    const work=buildWork(db,chatId,[msgId])
    const firstEpoch=readChatSourceState(db,chatId).sessionEpoch
    releaseIdentitySourceAttempt(db,work.lease,true)
    const second=beginIdentitySourceAttempt(db,chatId,work.snapshot,'{"same":"payload"}',SESSION,new Date(NOW))
    assert.ok(second.lease,second.reason)
    const state=readChatSourceState(db,chatId)
    assert.ok(state.sessionEpoch>firstEpoch)
    assert.equal(state.tainted,false)
    releaseIdentitySourceAttempt(db,second.lease,false)
  }finally{opened.close()}
})

test('historical Todo index covers every status beyond 100 rows, keeps aliases, and uses indexed plans',()=>{
  const opened=openFixture();const db=opened.db
  try{
    const chatId='identity-chat';
    const messages=Array.from({length:160},(_,i)=>rawMessage(`history-${i}`,chatId,1000+i,'alpha beta source '+i))
    insertMessages(messages,db)
    const statuses=['pending','waiting_reply','scheduled','suggested_done','done','dismissed']
    const insert=db.prepare(`INSERT INTO todos(id,chat_id,bucket,status,title,detail,priority,due_at,source_msg_ids,confidence,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    for(let i=0;i<160;i+=1) insert.run(`todo-${String(i).padStart(3,'0')}`,chatId,'todo',statuses[i%statuses.length],`Alpha beta ${i}`,null,2,null,JSON.stringify([stored(`history-${i}`)]),.8,NOW,NOW)
    drainIndex(db,chatId,'todo',25);drainIndex(db,chatId,'topic',25)
    const indexed=db.prepare(`SELECT COUNT(DISTINCT todo_id) AS count FROM todo_identity_terms WHERE chat_id=? AND term='t:alpha'`).get(chatId).count
    assert.equal(indexed,160)
    const recalled=recallTodoIdentityCandidates(db,chatId,['alpha beta source'],[stored('history-4'),stored('history-5')])
    assert.equal(recalled.ready,true);assert.ok(recalled.candidates.length<=50);assert.equal(recalled.truncated,true)
    assert.ok(recalled.candidates.some((candidate)=>candidate.status==='done'))
    assert.ok(recalled.candidates.some((candidate)=>candidate.status==='dismissed'))
    const longTerms=Array.from({length:600},(_,index)=>`boundedtoken${index}`).join(' ')
    assert.equal(recallTodoIdentityCandidates(db,chatId,[longTerms],[]).truncated,true,'term-budget omissions force defer instead of assuming new')
    const plan=explainIdentityCandidateQuery(db,'todo',chatId,['alpha beta source'],[stored('history-0')])
    assert.ok(plan.some((row)=>/SEARCH/i.test(row.detail)&&/todo_identity_terms|todo_identity_sources/i.test(row.detail)),JSON.stringify(plan))
    const inboxPlan=explainIdentityInboxQueryPlan(db,'todo',chatId)
    assert.ok(inboxPlan.some((row)=>/SEARCH/i.test(row.detail)&&/idx_todo_identity_decisions_(inbox|keyset)/i.test(row.detail)),JSON.stringify(inboxPlan))
    const before=db.prepare('SELECT title,entity_revision FROM todos WHERE id=?').get('todo-003')
    updateStatus('todo-003','done',db)
    drainIndex(db,chatId,'todo',25)
    const aliased=recallTodoIdentityCandidates(db,chatId,['alpha beta 3'],[])
    assert.ok(aliased.candidates.some((candidate)=>candidate.entityId==='todo-003'&&candidate.recallReasons.includes('history_alias')))
    assert.equal(db.prepare('SELECT entity_revision FROM todos WHERE id=?').get('todo-003').entity_revision,before.entity_revision+1)

    ensureGroupTopicsSchema(db)
    const insertTopic=db.prepare('INSERT INTO discussion_topics(topic_id,chat_id,local_ref,title,summary,created_at,last_source_ts,revision) VALUES(?,?,?,?,?,?,?,1)')
    for(let i=0;i<130;i+=1) insertTopic.run(`topic-${String(i).padStart(3,'0')}`,chatId,`ref-${i}`,`TopicAlpha TopicBeta ${i}`,'Older summary '+i,NOW,5000-i)
    drainIndex(db,chatId,'topic',20)
    assert.equal(db.prepare(`SELECT COUNT(DISTINCT topic_id) AS count FROM topic_identity_terms WHERE chat_id=? AND term='t:topicalpha'`).get(chatId).count,130)
    const topicRecall=recallTopicIdentityCandidates(db,chatId,['topicalpha topicbeta recurring event'])
    assert.equal(topicRecall.ready,true);assert.ok(topicRecall.candidates.length<=50);assert.equal(topicRecall.truncated,true)
    const topicPlan=explainIdentityCandidateQuery(db,'topic',chatId,['topicalpha topicbeta'],[])
    assert.ok(topicPlan.some((row)=>/SEARCH/i.test(row.detail)&&/topic_identity_terms/i.test(row.detail)),JSON.stringify(topicPlan))
  }finally{opened.close()}
})

test('legacy malformed and orphan Todo source references are reported without rewriting source_msg_ids',()=>{
  const opened=openFixture();const db=opened.db;const chatId='identity-chat'
  try{
    addMessage(db,'valid-source-for-chat',1000,'alpha beta')
    const insert=db.prepare(`INSERT INTO todos(id,chat_id,bucket,status,title,source_msg_ids,created_at,updated_at) VALUES(?,?,'todo','pending',?,?,?,?)`)
    insert.run('bad-json-todo',chatId,'Malformed source','not-json',NOW,NOW)
    insert.run('orphan-todo',chatId,'Orphan source','["i:other-chat-message"]',NOW,NOW)
    drainIndex(db,chatId,'todo')
    assert.equal(db.prepare('SELECT source_msg_ids FROM todos WHERE id=?').get('bad-json-todo').source_msg_ids,'not-json')
    assert.equal(db.prepare('SELECT source_msg_ids FROM todos WHERE id=?').get('orphan-todo').source_msg_ids,'["i:other-chat-message"]')
    const issues=listIdentityBackfillIssues(db,{chatId,state:'open'})
    assert.deepEqual(issues.map((issue)=>issue.issueKind).sort(),['malformed_source_json','orphan_source_ref'])
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM todo_identity_sources WHERE chat_id=?').get(chatId).count,0)
    assert.equal(db.prepare("SELECT state FROM identity_index_meta WHERE chat_id=? AND entity_type='todo'").get(chatId).state,'ready')
  }finally{opened.close()}
})

test('identity index term overflow remains not-ready and is visible to the migration diagnostics port',()=>{
  const opened=openFixture();const db=opened.db;const chatId='overflow-chat'
  try{
    addMessage(db,'overflow-source',1000,'overflow source',chatId)
    const terms=Array.from({length:600},(_,index)=>`uniqueoverflow${index}`).join(' ')
    db.prepare(`INSERT INTO todos(id,chat_id,bucket,status,title,source_msg_ids,created_at,updated_at) VALUES(?,?,'todo','pending',?,'[]',?,?)`).run('overflow-todo',chatId,terms,NOW,NOW)
    assert.equal(advanceIdentityIndex(db,chatId,'todo',10),false)
    assert.equal(db.prepare("SELECT state FROM identity_index_meta WHERE chat_id=? AND entity_type='todo'").get(chatId).state,'failed')
    const issues=listIdentityBackfillIssues(db,{chatId,state:'open'})
    assert.equal(issues[0].issueKind,'term_limit_exceeded')
  }finally{opened.close()}
})

test('Todo new/update/defer/resolve and exact acknowledgement share the source lease transaction',()=>{
  const opened=openFixture();const db=opened.db;const chatId='identity-chat'
  try{
    const first=addMessage(db,'todo-new',1000,'alpha beta action')
    drainIndex(db,chatId,'todo');drainIndex(db,chatId,'topic')
    const work1=buildWork(db,chatId,[first])
    const create=todoDecision(first,'d-create')
    const tally1=runTodoApply(db,chatId,first,work1,newExtract(first,create))
    assert.equal(tally1.todosCreated,1)
    const canonical=tally1.createdIds[0]
    assert.equal(db.prepare('SELECT processed FROM messages WHERE msg_id=?').get(first).processed,1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM todo_identity_decisions').get().count,1)

    const second=addMessage(db,'todo-reschedule',1500,'alpha beta action moves to Friday')
    const work2=buildWork(db,chatId,[second])
    const candidate=work2.recalled.candidates.find((item)=>item.entityType==='todo'&&item.entityId===canonical)
    assert.ok(candidate)
    const update=todoDecision(second,'d-update',{outcome:'update_existing',candidateType:'todo',candidateId:canonical,relationKind:null,reasonCode:'reschedule'})
    const tally2=runTodoApply(db,chatId,second,work2,newExtract(second,update,todoDraft(second,'d-update',{title:'完成 alpha beta action',bucket:'schedule',dueAt:'2030-10-30T09:00:00.000Z'})))
    assert.equal(tally2.todosCreated,0);assert.equal(tally2.todosMerged,1)
    assert.equal(listTodos({chatId},db)[0].id,canonical)
    assert.equal(getOpenTodosByChat(chatId,db).find((todo)=>todo.id===canonical).status,'scheduled')
    assert.deepEqual(JSON.parse(db.prepare('SELECT source_msg_ids FROM todos WHERE id=?').get(canonical).source_msg_ids),[first,second])

    const third=addMessage(db,'todo-defer',1600,'alpha beta unclear next step')
    const work3=buildWork(db,chatId,[third],{truncated:true})
    const defer=todoDecision(third,'d-defer',{outcome:'defer',candidateType:null,candidateId:null,relationKind:null,reasonCode:'candidate_cap',confidenceBand:'low'})
    const tally3=runTodoApply(db,chatId,third,work3,newExtract(third,defer,todoDraft(third,'d-defer',{title:'釐清 alpha beta 下一步'})))
    assert.equal(tally3.todosCreated,0)
    assert.equal(db.prepare('SELECT processed FROM messages WHERE msg_id=?').get(third).processed,1)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM todo_identity_decisions WHERE state='open'").get().count,1)
    const inbox=listIdentityInbox(db,'todo',{chatId,limit:10})
    assert.equal(inbox.items.length,1)
    const retry=retryIdentityDecision(db,'todo',inbox.items[0].decisionId,inbox.items[0].decisionRevision)
    assert.equal(retry.ok,true)
    if(!retry.ok) throw new Error(retry.reason)
    assert.equal(retry.item.decisionRevision,inbox.items[0].decisionRevision+1)
    const resolved=resolveIdentityDecision(db,{entityType:'todo',decisionId:retry.item.decisionId,expectedDecisionRevision:retry.item.decisionRevision,expectedCandidateRevisions:retry.item.candidateRevisions,outcome:'new'})
    assert.equal(resolved.ok,true)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM todo_identity_decisions WHERE state='resolved'").get().count,3)
    assert.equal(db.pragma('foreign_key_check').length,0)
  }finally{opened.close()}
})

test('identity retry uses the trusted source/candidate context once, records every serialized attempt, and leaves the user to confirm the suggestion',async()=>{
  const opened=openFixture();const db=opened.db;const chatId='identity-chat'
  try{
    const source=addMessage(db,'retry-ai-source',2000,'Alpha request: please book a room for Friday')
    drainIndex(db,chatId,'todo');drainIndex(db,chatId,'topic')
    const work=buildWork(db,chatId,[source],{truncated:true})
    const defer=todoDecision(source,'retry_ai_draft',{outcome:'defer',candidateType:null,candidateId:null,relationKind:null,reasonCode:'insufficient_evidence',confidenceBand:'low'})
    runTodoApply(db,chatId,source,work,newExtract(source,defer,todoDraft(source,'retry_ai_draft',{title:'Book a room Friday'})))
    const deferred=listIdentityInbox(db,'todo',{chatId}).items[0]
    let calls=0;let submittedUser=''
    const provider={id:'http',kind:'http',runtimeFingerprint:async()=> 'fixture-effective-model-effort',health:async()=>({ok:true,summary:'fixture',details:{}}),complete:async(request)=>{
      calls+=1;submittedUser=request.user
      const context=JSON.parse(request.user)
      assert.equal(context.sourceEvidence[0].msgId,source)
      assert.equal(context.sourceEvidence[0].text,'Alpha request: please book a room for Friday')
      assert.equal(Object.hasOwn(context,'candidateRevisions'),false,'application revisions are not serialized to the model')
      assert.equal(Object.hasOwn(context,'selectedFingerprints'),false,'private source fingerprints are not serialized')
      assert.equal(Object.hasOwn(context,'sessionFingerprint'),false,'cache session identity is not serialized')
      assert.equal(request.onAdditionalUserPayload('repair request bytes'),true)
      return {text:'',structured:[todoDecision(source,'retry_ai_draft',{outcome:'new',candidateType:null,candidateId:null,relationKind:null,reasonCode:'fresh_occurrence',confidenceBand:'high'})],meta:{provider:'http',model:'fixture',durationMs:1}}
    }}
    const service=createIdentityRetryService(db)
    const result=await service.retry({entityType:'todo',decisionId:deferred.decisionId,expectedDecisionRevision:deferred.decisionRevision},()=>provider)
    assert.equal(result.ok,true,JSON.stringify(result))
    if(!result.ok)throw new Error(result.reason)
    assert.equal(calls,1,'one explicit retry performs one re-evaluation')
    assert.equal(result.item.decisionRevision,deferred.decisionRevision+1)
    assert.equal(result.item.state,'open','a suggestion does not resolve the defer without user confirmation')
    assert.equal(result.item.suggestedDecision.outcome,'new')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM todos WHERE chat_id=?').get(chatId).count,0,'no canonical Todo is silently created')
    assert.equal(db.prepare('SELECT processed FROM messages WHERE msg_id=?').get(source).processed,1,'the prior owning-feature acknowledgement remains exact')
    const state=readChatSourceState(db,chatId)
    assert.equal(state.submittedRequests,2,'primary and repair/retry bytes are both accounted once')
    assert.equal(state.submittedUserUtf8Bytes,Buffer.byteLength(submittedUser,'utf8')+Buffer.byteLength('repair request bytes','utf8'))
    const retryEvents=db.prepare("SELECT payload_json FROM todo_identity_events WHERE decision_id=? AND action='retried' ORDER BY event_revision").all(deferred.decisionId)
    assert.equal(retryEvents.length,2,'one audit event records the user retry and one records the evaluated suggestion')
    assert.equal(JSON.parse(retryEvents.at(-1).payload_json).suggestedDecision.outcome,'new')
  }finally{opened.close()}
})

test('a deferred Todo is marked stale when the Topic candidate corpus changes and remains retrievable',()=>{
  const opened=openFixture();const db=opened.db;const chatId='identity-chat'
  try{
    ensureGroupTopicsSchema(db)
    const source=addMessage(db,'defer-with-topic',1000,'alpha beta project action unclear')
    db.prepare('INSERT INTO discussion_topics(topic_id,chat_id,local_ref,title,summary,created_at,last_source_ts,revision) VALUES(?,?,?,?,?,?,?,1)')
      .run('topic-alpha',chatId,'alpha','Alpha beta project','Old topic',NOW,900)
    drainIndex(db,chatId,'todo');drainIndex(db,chatId,'topic')
    const work=buildWork(db,chatId,[source])
    const decision=todoDecision(source,'d-topic-defer',{outcome:'defer',candidateType:'topic',candidateId:'topic-alpha',relationKind:null,reasonCode:'insufficient_evidence',confidenceBand:'low'})
    runTodoApply(db,chatId,source,work,newExtract(source,decision,todoDraft(source,'d-topic-defer',{title:'Alpha beta project action'})))
    const open=listIdentityInbox(db,'todo',{chatId}).items[0]
    assert.equal(open.state,'open')
    db.prepare('INSERT INTO discussion_topics(topic_id,chat_id,local_ref,title,summary,created_at,last_source_ts,revision) VALUES(?,?,?,?,?,?,?,1)')
      .run('topic-new',chatId,'new-topic','Unrelated new subject','New topic',NOW,1100)
    const stale=listIdentityInbox(db,'todo',{chatId}).items[0]
    assert.equal(stale.state,'stale','a change to the related Topic candidate corpus stales the Todo defer')
    assert.equal(db.prepare('SELECT processed FROM messages WHERE msg_id=?').get(source).processed,1)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM todo_identity_events e WHERE e.decision_id=? AND e.action='stale'").get(stale.decisionId).count,1)
  }finally{opened.close()}
})

test('production automatic runOnce and historical backfill both require the identity lease/apply path',async()=>{
  const live=openFixture();const liveDb=live.db
  try{
    const liveId=addMessage(liveDb,'run-once-identity',1000,'alpha beta service action')
    const result=await runOnce({db:liveDb,watchSource:async()=>({messages:[],bridge:'ok'}),extractFn:async(input)=>identityExtractor(input)})
    assert.equal(result.chatsProcessed,1)
    assert.equal(result.todosCreated,1)
    assert.equal(liveDb.prepare('SELECT processed FROM messages WHERE msg_id=?').get(liveId).processed,1)
    assert.equal(liveDb.prepare('SELECT COUNT(*) AS count FROM todo_identity_decisions').get().count,1)
  }finally{live.close()}

  const review=openFixture();const reviewDb=review.db
  try{
    const backfillId=stored('backfill-identity')
    const reviewResult=await reviewLastDays(1,{db:reviewDb,now:()=>1_000_000,fetchWindow:async()=>({messages:[rawMessage('backfill-identity','identity-chat',1000,'alpha beta service action')]}),extractFn:async(input)=>identityExtractor(input)})
    assert.equal(reviewResult.chatsProcessed,1)
    assert.equal(reviewResult.todosCreated,1)
    assert.equal(reviewDb.prepare('SELECT processed FROM messages WHERE msg_id=?').get(backfillId).processed,1)
    assert.equal(reviewDb.prepare('SELECT COUNT(*) AS count FROM todo_identity_decisions').get().count,1)
  }finally{review.close()}
})

test('backfill through the real ExtractQueue shares one guarded lease across bounded AI parts before atomic apply',async()=>{
  const opened=openFixture();const db=opened.db;const chatId='identity-chat'
  const queue=new ExtractQueue({db,getConfig:getPipelineDefaults,maxUserChars:4500})
  try{
    const raws=[
      rawMessage('review-part-1',chatId,1000,'alpha beta review action one '+('a'.repeat(2600))),
      rawMessage('review-part-2',chatId,1100,'alpha beta review action two '+('b'.repeat(2600))),
      rawMessage('review-part-3',chatId,1200,'alpha beta review action three '+('c'.repeat(2600)))
    ]
    const extractFn=(input)=>queue.request(input)
    extractFn.identityAttemptManagedByQueue=true
    const reviewPromise=reviewLastDays(1,{db,now:()=>1_000_000,fetchWindow:async()=>({messages:raws}),extractFn})
    let returned=0
    for(let attempt=0;attempt<10&&returned<3;attempt+=1){
      await new Promise((resolve)=>setImmediate(resolve))
      const pulled=queue.pull({max:1})
      if(!pulled.items.length) continue
      const item=pulled.items[0]
      const payload=JSON.parse(item.user)
      const msgId=payload.newMessages[0].msgId
      const draftRef='backfill_'+msgId.replace(/[^a-z0-9]/giu,'_')
      const response=newExtract(msgId,todoDecision(msgId,draftRef),todoDraft(msgId,draftRef,{title:'處理 '+draftRef}))
      const committed=queue.commit({results:[{itemId:item.itemId,ok:true,result:response}]})
      assert.equal(committed.results[0].status,'accepted')
      returned+=1
    }
    assert.equal(returned,3)
    const result=await reviewPromise
    assert.equal(result.chatsProcessed,1)
    assert.equal(result.todosCreated,3)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE chat_id=? AND processed=1').get(chatId).count,3)
    assert.equal(db.prepare('SELECT active_lease_id FROM chat_context_cache WHERE chat_id=?').get(chatId).active_lease_id,null)
  }finally{queue.dispose();opened.close()}
})

test('backfill refreshes a changed selected source body, safely repartitions the await group, then applies once with the refreshed full snapshot',async()=>{
  const opened=openFixture();const db=opened.db;const chatId='identity-chat'
  const queue=new ExtractQueue({db,getConfig:getPipelineDefaults,maxUserChars:4500})
  try{
    const raws=[rawMessage('repart-1',chatId,2000,'first short message'),rawMessage('repart-2',chatId,2100,'second short message')]
    const extractFn=(input)=>queue.request(input);extractFn.identityAttemptManagedByQueue=true
    const reviewPromise=reviewLastDays(1,{db,now:()=>1_000_000,fetchWindow:async()=>({messages:raws}),extractFn})
    for(let wait=0;wait<10&&queue.stats().awaiting===0;wait+=1)await new Promise((resolve)=>setImmediate(resolve))
    assert.equal(queue.stats().awaiting,1,'the original short synthetic slice is one await part')
    db.prepare('UPDATE messages SET text=? WHERE chat_id=? AND msg_id=?').run('first refreshed source '+'a'.repeat(2900),chatId,stored('repart-1'))
    db.prepare('UPDATE messages SET text=? WHERE chat_id=? AND msg_id=?').run('second refreshed source '+'b'.repeat(2900),chatId,stored('repart-2'))
    const returned=new Set()
    for(let pull=0;pull<20&&returned.size<2;pull+=1){
      await new Promise((resolve)=>setImmediate(resolve))
      const page=queue.pull({max:1})
      const item=page.items[0]
      if(!item)continue
      const payload=JSON.parse(item.user)
      const message=payload.newMessages[0]
      assert.ok(message.text.includes('refreshed source'),'each leased part uses the current SQLite source body')
      const draftRef=`repart_${message.msgId.replace(/[^a-z0-9]/giu,'_')}`
      const response=newExtract(message.msgId,todoDecision(message.msgId,draftRef),todoDraft(message.msgId,draftRef,{title:`處理 ${draftRef}`}))
      const committed=queue.commit({results:[{itemId:item.itemId,ok:true,result:response}]})
      assert.equal(committed.results[0].status,'accepted')
      returned.add(message.msgId)
    }
    assert.deepEqual([...returned].sort(),[stored('repart-1'),stored('repart-2')].sort())
    const result=await reviewPromise
    assert.equal(result.chatsProcessed,1)
    assert.equal(result.todosCreated,2)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE chat_id=? AND processed=1').get(chatId).count,2)
    assert.equal(db.prepare('SELECT active_lease_id FROM chat_context_cache WHERE chat_id=?').get(chatId).active_lease_id,null)
  }finally{queue.dispose();opened.close()}
})

test('ReviewCoordinator ledger records a backfill slice only after the identity apply receipt',async()=>{
  const opened=openFixture();const db=opened.db;const chatId='identity-chat';const nowMs=1_000_000
  const ledger=new ReviewLedger({now:()=>nowMs})
  const review=new ReviewCoordinator({ledger,now:()=>nowMs})
  const wrapped=review.wrapExtract(async(input)=>identityExtractor(input))
  try{
    const raw=rawMessage('ledger-apply-retry',chatId,1000,'alpha beta review ledger')
    db.exec(`CREATE TRIGGER reject_review_identity_apply BEFORE INSERT ON todo_identity_decisions BEGIN SELECT RAISE(ABORT,'reject_review_apply'); END;`)
    const failed=await reviewLastDays(1,{db,now:()=>nowMs,fetchWindow:async()=>({messages:[raw]}),extractFn:wrapped})
    assert.equal(failed.chatsFailed,1)
    assert.equal(ledger.has(stored('ledger-apply-retry')),false,'AI success without canonical/ack commit does not enter the durable ledger')
    assert.equal(db.prepare('SELECT processed FROM messages WHERE msg_id=?').get(stored('ledger-apply-retry')).processed,0)
    db.exec('DROP TRIGGER reject_review_identity_apply;')
    const succeeded=await reviewLastDays(1,{db,now:()=>nowMs+1000,fetchWindow:async()=>({messages:[raw]}),extractFn:wrapped})
    assert.equal(succeeded.chatsProcessed,1)
    assert.equal(ledger.has(stored('ledger-apply-retry')),true,'the receipt records the slice after its atomic apply succeeds')
    assert.equal(db.prepare('SELECT processed FROM messages WHERE msg_id=?').get(stored('ledger-apply-retry')).processed,1)
  }finally{opened.close()}
})

test('production ExtractQueue pulls the trusted candidate context and commits identity plus exact processed IDs atomically',async()=>{
  const opened=openFixture();const db=opened.db;const chatId='identity-chat'
  const queue=new ExtractQueue({db,getConfig:getPipelineDefaults})
  try{
    const msgId=addMessage(db,'queue-identity',1000,'alpha beta queue action')
    const cycle=await runOnce({db,watchSource:async()=>({messages:[],bridge:'ok'}),extractFn:async()=>{throw new Error('sink path must not call local extractor')},extractSink:queue})
    assert.equal(cycle.chatsSkipped,1)
    const pull=queue.pull({max:1})
    assert.equal(pull.items.length,1)
    const payload=JSON.parse(pull.items[0].user)
    assert.ok(Array.isArray(payload.historicalCandidates))
    assert.equal(payload.newMessages[0].msgId,msgId)
    const result=queue.commit({results:[{itemId:pull.items[0].itemId,ok:true,result:newExtract(msgId,todoDecision(msgId,'queue_draft'))}]})
    assert.equal(result.results[0].status,'applied')
    assert.equal(db.prepare('SELECT processed FROM messages WHERE msg_id=?').get(msgId).processed,1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM todos WHERE chat_id=?').get(chatId).count,1)
    assert.equal(readChatSourceState(db,chatId).activeLeaseId,null)
  }finally{queue.dispose();opened.close()}
})

test('ExtractQueue refreshes historical candidates between bounded parts after each canonical commit',async()=>{
  const opened=openFixture();const db=opened.db;const chatId='identity-chat'
  const queue=new ExtractQueue({db,getConfig:getPipelineDefaults,maxUserChars:4500})
  try{
    const ids=[
      addMessage(db,'queue-part-1',1000,'alpha beta shared task '+('a'.repeat(2600))),
      addMessage(db,'queue-part-2',1100,'alpha beta shared task update '+('b'.repeat(2600))),
      addMessage(db,'queue-part-3',1200,'alpha beta distinct follow-up '+('c'.repeat(2600)))
    ]
    await runOnce({db,watchSource:async()=>({messages:[],bridge:'ok'}),extractFn:async()=>{throw new Error('sink path must not call local extractor')},extractSink:queue})
    const firstPull=queue.pull({max:1});assert.equal(firstPull.items.length,1)
    const firstMsg=JSON.parse(firstPull.items[0].user).newMessages[0].msgId
    assert.equal(firstMsg,ids[0])
    const firstResult=queue.commit({results:[{itemId:firstPull.items[0].itemId,ok:true,result:newExtract(ids[0],todoDecision(ids[0],'part-1'),todoDraft(ids[0],'part-1',{title:'Alpha beta shared task'}))}]})
    assert.equal(firstResult.results[0].status,'applied')

    const secondPull=queue.pull({max:1});assert.equal(secondPull.items.length,1)
    const secondPayload=JSON.parse(secondPull.items[0].user)
    const existingTodo=secondPayload.historicalCandidates.find((candidate)=>candidate.entityType==='todo')
    assert.ok(existingTodo,'the next part sees the Todo committed by the preceding part')
    assert.equal(secondPayload.newMessages[0].msgId,ids[1])
    const secondDecision=todoDecision(ids[1],'part-2',{outcome:'update_existing',candidateType:'todo',candidateId:existingTodo.entityId,relationKind:null,reasonCode:'same_active_action'})
    const secondResult=queue.commit({results:[{itemId:secondPull.items[0].itemId,ok:true,result:newExtract(ids[1],secondDecision,todoDraft(ids[1],'part-2',{title:'Alpha beta shared task'}))}]})
    assert.equal(secondResult.results[0].status,'applied')

    const thirdPull=queue.pull({max:1});assert.equal(thirdPull.items.length,1)
    const thirdPayload=JSON.parse(thirdPull.items[0].user)
    const target=thirdPayload.historicalCandidates.find((candidate)=>candidate.entityType==='todo')
    const thirdDecision=todoDecision(ids[2],'part-3',{outcome:'link',candidateType:'todo',candidateId:target.entityId,relationKind:'related_action',reasonCode:'distinct_action'})
    const thirdResult=queue.commit({results:[{itemId:thirdPull.items[0].itemId,ok:true,result:newExtract(ids[2],thirdDecision,todoDraft(ids[2],'part-3',{title:'Prepare alpha beta follow-up'}))}]})
    assert.equal(thirdResult.results[0].status,'applied')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM todos WHERE chat_id=?').get(chatId).count,2)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE chat_id=? AND processed=1").get(chatId).count,3)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM todo_identity_relations WHERE relation_type='related_action'").get().count,1)
  }finally{queue.dispose();opened.close()}
})

test('completed action source time preserves the old canonical ID; a later occurrence gets a recurrence ID',()=>{
  const opened=openFixture();const db=opened.db;const chatId='identity-chat'
  try{
    const first=addMessage(db,'temporal-first',1000,'alpha beta complete report')
    drainIndex(db,chatId,'todo');drainIndex(db,chatId,'topic')
    const work1=buildWork(db,chatId,[first])
    const tally=runTodoApply(db,chatId,first,work1,newExtract(first,todoDecision(first,'d-first')))
    const canonical=tally.createdIds[0]
    const completion=addMessage(db,'temporal-completion',2000,'alpha beta report delivered')
    const work2=buildWork(db,chatId,[completion])
    const resolution={importance:'action',newTodos:[],identityDecisions:[],resolved:[{todoId:canonical,evidence:'已交付',evidenceMsgIds:[completion]}],updates:[]}
    runTodoApply(db,chatId,completion,work2,resolution)
    assert.equal(db.prepare('SELECT status FROM todos WHERE id=?').get(canonical).status,'done')
    const completedAt=db.prepare(`SELECT json_extract(e.payload_json,'$.completionEventTs') AS ts FROM todo_identity_events e JOIN todo_identity_decisions d ON d.decision_id=e.decision_id WHERE d.canonical_todo_id=? AND e.action='resolved_existing'`).get(canonical).ts
    assert.equal(completedAt,2000)

    const backfill=addMessage(db,'temporal-backfill',1500,'alpha beta complete report old source')
    const work3=buildWork(db,chatId,[backfill])
    const same=todoDecision(backfill,'d-same-completed',{outcome:'update_existing',candidateType:'todo',candidateId:canonical,relationKind:null,reasonCode:'same_completed_action'})
    const sameTally=runTodoApply(db,chatId,backfill,work3,newExtract(backfill,same,todoDraft(backfill,'d-same-completed')))
    assert.equal(sameTally.todosCreated,0)
    assert.equal(db.prepare('SELECT status FROM todos WHERE id=?').get(canonical).status,'done')
    assert.deepEqual(JSON.parse(db.prepare('SELECT source_msg_ids FROM todos WHERE id=?').get(canonical).source_msg_ids),[first,backfill])

    const next=addMessage(db,'temporal-next',2500,'alpha beta complete report again')
    const work4=buildWork(db,chatId,[next])
    const recurrence=todoDecision(next,'d-next',{outcome:'new',candidateType:'todo',candidateId:canonical,relationKind:'recurrence',reasonCode:'fresh_occurrence'})
    const nextTally=runTodoApply(db,chatId,next,work4,newExtract(next,recurrence,todoDraft(next,'d-next',{title:'再次完成 alpha beta report'})))
    assert.equal(nextTally.todosCreated,1)
    const newId=nextTally.createdIds[0]
    assert.notEqual(newId,canonical)
    assert.equal(db.prepare("SELECT relation_type,status FROM todo_identity_relations WHERE chat_id=? AND (left_todo_id=? OR right_todo_id=?)").get(chatId,newId,newId).relation_type,'recurrence')
    assert.equal(listTodoRelationsForTodo(db,chatId,newId)[0].relationType,'recurrence')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM todos WHERE chat_id=?').get(chatId).count,2)

    const legacySource=addMessage(db,'temporal-legacy-done',2600,'legacy alpha beta action')
    const legacyTodo=createTodo({chatId,bucket:'todo',title:'Legacy alpha beta action',sourceMsgIds:[legacySource]},db)
    updateStatus(legacyTodo.id,'done',db)
    drainIndex(db,chatId,'todo')
    const uncertainSource=addMessage(db,'temporal-missing-event',3500,'legacy alpha beta action again')
    const work5=buildWork(db,chatId,[uncertainSource])
    const unsupportedRecurrence=todoDecision(uncertainSource,'d-unknown-event',{outcome:'new',candidateType:'todo',candidateId:legacyTodo.id,relationKind:'recurrence',reasonCode:'fresh_occurrence'})
    const uncertainTally=runTodoApply(db,chatId,uncertainSource,work5,newExtract(uncertainSource,unsupportedRecurrence,todoDraft(uncertainSource,'d-unknown-event',{title:'Legacy alpha beta action'})))
    assert.equal(uncertainTally.todosCreated,0)
    assert.equal(db.prepare('SELECT processed FROM messages WHERE msg_id=?').get(uncertainSource).processed,1)
    assert.equal(db.prepare("SELECT state FROM todo_identity_decisions WHERE draft_ref='d-unknown-event'").get().state,'open')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM todos WHERE id=?').get(legacyTodo.id).count,1)
  }finally{opened.close()}
})

test('Todo to Topic link retains two canonical IDs and rolls back the full source transaction on failure',async()=>{
  const opened=openFixture();const db=opened.db;const chatId='identity-chat'
  try{
    ensureGroupTopicsSchema(db)
    const topicSource=addMessage(db,'topic-seed',1000,'alpha beta project discussion')
    setEnabled(db,chatId,true)
    const service=createGroupTopicsService(db)
    const provider={id:'codexCli',kind:'cli',health:async()=>({ok:true,summary:'fixture',details:{}}),complete:async()=>({text:'',structured:{
      topics:[{ref:'alpha_beta',title:'Alpha beta project',summary:'Project discussion'}],
      identityDecisions:[{draftRef:'alpha_beta',outcome:'new',candidateType:null,candidateId:null,relationKind:null,reasonCode:'related_topic',confidenceBand:'high',evidenceMsgIds:[topicSource]}],
      assignments:[{msgId:topicSource,topicRef:'alpha_beta',relation:'about',confidence:.9,relevance:'unknown',relevanceEvidenceMsgIds:[]}]
    },meta:{provider:'codexCli',model:'fixture',durationMs:0}})}
    const analyzed=await service.analyze(chatId,()=>provider)
    assert.equal(analyzed.ok,true)
    const topic=db.prepare('SELECT topic_id FROM discussion_topics WHERE chat_id=?').get(chatId).topic_id
    const todoPlan=explainIdentityCandidateQuery(db,'todo',chatId,['alpha beta'],[topicSource])
    const topicPlan=explainIdentityCandidateQuery(db,'topic',chatId,['alpha beta'],[topicSource])
    const topicInboxPlan=explainIdentityInboxQueryPlan(db,'topic',chatId)
    assert.ok(topicPlan.some((row)=>/SEARCH/i.test(row.detail)&&/topic_identity_terms/i.test(row.detail)),JSON.stringify(topicPlan))
    assert.ok(topicInboxPlan.some((row)=>/SEARCH/i.test(row.detail)&&/idx_topic_identity_decisions_(inbox|keyset)/i.test(row.detail)),JSON.stringify(topicInboxPlan))
    console.log('IDENTITY_QUERY_PLANS '+JSON.stringify({todo:todoPlan,topic:topicPlan,todoInbox:explainIdentityInboxQueryPlan(db,'todo',chatId),topicInbox:topicInboxPlan}))
    const uncertainSource=addMessage(db,'topic-defer-source',1500,'gamma delta unclear discussion')
    let deferCalls=0
    const deferProvider={...provider,complete:async()=>{deferCalls+=1;return {text:'',structured:{
      topics:[{ref:'gamma_delta',title:'Gamma delta discussion',summary:'Unclear next step'}],
      identityDecisions:[{draftRef:'gamma_delta',outcome:'defer',candidateType:null,candidateId:null,relationKind:null,reasonCode:'insufficient_evidence',confidenceBand:'low',evidenceMsgIds:[uncertainSource]}],
      assignments:[{msgId:uncertainSource,topicRef:'gamma_delta',relation:'uncertain',confidence:.3,relevance:'unknown',relevanceEvidenceMsgIds:[]}]
    },meta:{provider:'codexCli',model:'fixture',durationMs:0}}}}
    const deferred=await service.analyze(chatId,()=>deferProvider)
    assert.equal(deferred.ok,true)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM discussion_topics WHERE chat_id=?').get(chatId).count,1)
    assert.equal(db.prepare("SELECT disposition FROM topic_message_decisions WHERE chat_id=? AND msg_id=?").get(chatId,uncertainSource).disposition,'uncertain')
    assert.equal(service.pendingCount(chatId),0)
    await service.analyze(chatId,()=>deferProvider)
    assert.equal(deferCalls,1,'an open Topic defer is not polled into another AI call')
    assert.equal(listIdentityInbox(db,'topic',{chatId,limit:10}).items[0].state,'open')
    const todoSource=addMessage(db,'todo-topic-link',2000,'alpha beta project arrange supplier call')
    drainIndex(db,chatId,'todo');drainIndex(db,chatId,'topic')
    const work=buildWork(db,chatId,[todoSource])
    const link=todoDecision(todoSource,'d-topic-link',{outcome:'link',candidateType:'topic',candidateId:topic,relationKind:'same_topic',reasonCode:'related_topic'})
    const secondDraft=todoDraft(todoSource,'d-second-action',{title:'整理 alpha beta supplier invoice'})
    const secondLink=todoDecision(todoSource,'d-second-action',{outcome:'link',candidateType:'topic',candidateId:topic,relationKind:'same_topic',reasonCode:'distinct_action'})
    const twoActions={importance:'action',newTodos:[todoDraft(todoSource,'d-topic-link',{title:'安排 alpha beta supplier call'}),secondDraft],identityDecisions:[link,secondLink],resolved:[],updates:[]}
    const tally=runTodoApply(db,chatId,todoSource,work,twoActions)
    assert.equal(tally.createdIds.length,2,'two distinct actions from one source message retain two canonical Todo IDs')
    const todoId=tally.createdIds[0]
    assert.ok(todoId);assert.notEqual(todoId,topic)
    assert.deepEqual(db.prepare('SELECT chat_id,todo_id,topic_id,relation_type,status FROM todo_topic_identity_relations').get(),{chat_id:chatId,todo_id:todoId,topic_id:topic,relation_type:'same_topic',status:'proposed'})
    assert.equal(service.todoRefs(topic).length,0,'the semantic relation is retained independently of message source overlap')
    const semanticLinks=listTodoTopicRelationsForTopic(db,topic)
    assert.deepEqual(semanticLinks.map((relation)=>relation.todoId).sort(),[...tally.createdIds].sort())
    assert.ok(semanticLinks.every((relation)=>relation.relationType==='same_topic'&&JSON.stringify(relation.sourceMsgIds)==JSON.stringify([todoSource])))
    const chatRelations=listTodoTopicRelationsForChat(db,chatId)
    assert.ok(chatRelations.some((relation)=>relation.todoId===todoId&&relation.topicId===topic&&relation.revision===1))
    assert.equal(service.todoRefs(topic).length,0,'the API relation projection also does not depend on source-id intersection')
    const decisionId=db.prepare("SELECT decision_id FROM todo_identity_decisions WHERE draft_ref='d-topic-link'").get().decision_id
    const topicRevision=db.prepare('SELECT revision FROM discussion_topics WHERE topic_id=?').get(topic).revision
    const todoRevision=db.prepare('SELECT entity_revision FROM todos WHERE id=?').get(todoId).entity_revision
    const relationId=db.prepare('SELECT relation_id FROM todo_topic_identity_relations WHERE todo_id=?').get(todoId).relation_id
    const accepted=resolveTodoTopicRelation(db,{relationId,expectedRevision:1,expectedTodoRevision:todoRevision,expectedTopicRevision:topicRevision,choice:'confirm'})
    assert.equal(accepted.ok,true)
    assert.equal(listTodoTopicRelationsForTopic(db,topic).find((relation)=>relation.relationId===relationId).relationStatus,'confirmed')
    const secondTodo=tally.createdIds[1]
    const secondRelation=db.prepare('SELECT relation_id FROM todo_topic_identity_relations WHERE todo_id=?').get(secondTodo).relation_id
    const rejected=resolveTodoTopicRelation(db,{relationId:secondRelation,expectedRevision:1,expectedTodoRevision:db.prepare('SELECT entity_revision FROM todos WHERE id=?').get(secondTodo).entity_revision,expectedTopicRevision:topicRevision,choice:'reject'})
    assert.equal(rejected.ok,true)
    assert.equal(db.prepare('SELECT status FROM todo_topic_identity_relations WHERE relation_id=?').get(secondRelation).status,'rejected')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM todos WHERE chat_id=?').get(chatId).count,2,'rejecting a relation preserves both independent Todo rows')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM discussion_topics WHERE chat_id=?').get(chatId).count,1)

    const staleSource=addMessage(db,'todo-topic-stale-link',2500,'alpha beta project reserve another supplier')
    drainIndex(db,chatId,'todo');drainIndex(db,chatId,'topic')
    const staleWork=buildWork(db,chatId,[staleSource])
    const staleDecision=todoDecision(staleSource,'d-topic-stale',{outcome:'link',candidateType:'topic',candidateId:topic,relationKind:'same_topic',reasonCode:'related_topic'})
    const staleTally=runTodoApply(db,chatId,staleSource,staleWork,newExtract(staleSource,staleDecision,todoDraft(staleSource,'d-topic-stale',{title:'預約 alpha beta supplier'})))
    const staleTodo=staleTally.createdIds[0]
    const staleRelation=db.prepare('SELECT relation_id FROM todo_topic_identity_relations WHERE todo_id=?').get(staleTodo).relation_id
    const staleTodoRevision=db.prepare('SELECT entity_revision FROM todos WHERE id=?').get(staleTodo).entity_revision
    const staleTopicRevision=db.prepare('SELECT revision FROM discussion_topics WHERE topic_id=?').get(topic).revision
    setEnabled(db,chatId,false)
    const denied=resolveTodoTopicRelation(db,{relationId:staleRelation,expectedRevision:1,expectedTodoRevision:staleTodoRevision,expectedTopicRevision:staleTopicRevision,choice:'confirm'})
    assert.deepEqual(denied,{ok:false,reason:'scope_denied'})
    assert.equal(db.prepare('SELECT status FROM todo_topic_identity_relations WHERE relation_id=?').get(staleRelation).status,'stale')
    setEnabled(db,chatId,true)
    assert.throws(()=>db.prepare(`INSERT INTO todo_identity_relations(relation_id,chat_id,left_todo_id,right_todo_id,relation_type,status,decision_id,created_at) VALUES(?,?,?,?,?,'proposed',?,?)`).run('self-relation',chatId,todoId,todoId,'recurrence',decisionId,NOW))
    assert.throws(()=>db.prepare(`INSERT INTO todo_topic_identity_relations(relation_id,chat_id,todo_id,topic_id,relation_type,status,decision_id,revision,created_at) VALUES(?,?,?, ?,?,'invalid',?,1,?)`).run('bad-state',chatId,todoId,topic,'same_topic',decisionId,NOW))
    assert.throws(()=>db.prepare(`INSERT INTO todo_topic_identity_relations(relation_id,chat_id,todo_id,topic_id,relation_type,status,decision_id,revision,created_at) VALUES(?,?,?,?,?,'proposed',?,1,?)`).run('wrong-chat','other-chat',todoId,topic,'same_topic',decisionId,NOW))
    assert.throws(()=>db.prepare(`INSERT INTO todo_topic_identity_relations(relation_id,chat_id,todo_id,topic_id,relation_type,status,decision_id,revision,created_at) VALUES(?,?,?,?,?,'proposed',?,1,?)`).run('duplicate-semantic-link',chatId,todoId,topic,'same_topic',decisionId,NOW))

    const failSource=addMessage(db,'todo-rollback',3000,'alpha beta force rollback')
    const failWork=buildWork(db,chatId,[failSource])
    const todoCountBefore=db.prepare('SELECT COUNT(*) AS count FROM todos WHERE chat_id=?').get(chatId).count
    db.exec(`CREATE TRIGGER reject_identity_decision BEFORE INSERT ON todo_identity_decisions BEGIN SELECT RAISE(ABORT,'fixture_apply_failure'); END;`)
    assert.throws(()=>runTodoApply(db,chatId,failSource,failWork,newExtract(failSource,todoDecision(failSource,'d-fail'))),/fixture_apply_failure/u)
    assert.equal(db.prepare('SELECT processed FROM messages WHERE msg_id=?').get(failSource).processed,0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM todos WHERE chat_id=?').get(chatId).count,todoCountBefore)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM todo_identity_decisions WHERE draft_ref='d-fail'").get().count,0)
    assert.equal(db.prepare('SELECT active_lease_id FROM chat_context_cache WHERE chat_id=?').get(chatId).active_lease_id,failWork.lease.leaseId,'failed transaction does not partially clear lease state')
    db.exec('DROP TRIGGER reject_identity_decision;')
  }finally{opened.close()}
})

test('cross-chat Topic link ports recheck both endpoint revisions and live permissions without merging Topics',()=>{
  const opened=openFixture();const db=opened.db
  try{
    ensureGroupTopicsSchema(db)
    const leftChat='left-chat';const rightChat='right-chat'
    addMessage(db,'left-source',1000,'left group message',leftChat)
    addMessage(db,'right-source',1100,'right group message',rightChat)
    setEnabled(db,leftChat,true);setEnabled(db,rightChat,true)
    setCrossChatEnabled(db,leftChat,true);setCrossChatEnabled(db,rightChat,true)
    const insertTopic=db.prepare('INSERT INTO discussion_topics(topic_id,chat_id,local_ref,title,summary,created_at,last_source_ts,revision) VALUES(?,?,?,?,?,?,?,1)')
    insertTopic.run('left-topic',leftChat,'left','Shared alpha topic','Left summary',NOW,1000)
    insertTopic.run('right-topic',rightChat,'right','Shared alpha topic','Right summary',NOW,1100)
    drainIndex(db,leftChat,'topic');drainIndex(db,rightChat,'topic')
    assert.deepEqual(recallTopicIdentityCandidates(db,leftChat,['Shared alpha topic']).candidates.map((candidate)=>candidate.entityId),['left-topic'])
    const insertLink=(id)=>{
      db.prepare(`INSERT INTO topic_links(link_id,left_topic_id,right_topic_id,relation,identity_evidence,event_evidence_msg_ids,status,created_at) VALUES(?,?,?,'unknown','unknown','[]','proposed',?)`).run(id,'left-topic','right-topic',NOW)
      db.prepare(`INSERT INTO topic_link_identity_events(event_id,link_id,event_revision,actor,action,left_topic_revision,right_topic_revision,permission_snapshot_json,created_at) VALUES(?,?,1,'system','proposed',1,1,?,?)`).run(`event-${id}`,id,JSON.stringify({leftCrossChat:true,rightCrossChat:true}),NOW)
    }
    insertLink('cross-link-accepted')
    const linkPlan=explainTopicLinkProposalQueryPlan(db,leftChat)
    console.log('TOPIC_LINK_PROPOSAL_QUERY_PLAN '+JSON.stringify(linkPlan))
    assert.ok(linkPlan.some((row)=>/SEARCH/i.test(row.detail)&&/idx_topic_links_(left|right)_status/i.test(row.detail)),JSON.stringify(linkPlan))
    const listed=listTopicLinkProposals(db,{chatId:leftChat})[0]
    assert.equal(listed.permissionAllowed,true)
    const accepted=resolveTopicLinkProposal(db,{linkId:listed.linkId,expectedLinkRevision:listed.linkRevision,leftTopicRevision:listed.leftRevision,rightTopicRevision:listed.rightRevision,choice:'accept'})
    assert.equal(accepted.ok,true)
    assert.equal(db.prepare('SELECT status,identity_evidence FROM topic_links WHERE link_id=?').get(listed.linkId).status,'accepted')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM discussion_topics WHERE topic_id IN (?,?)').get('left-topic','right-topic').count,2)

    insertTopic.run('right-topic-reject',rightChat,'reject','Shared alpha follow-up','Independent right topic',NOW,1200)
    drainIndex(db,rightChat,'topic')
    insertLink('cross-link-rejected')
    db.prepare('UPDATE topic_links SET right_topic_id=? WHERE link_id=?').run('right-topic-reject','cross-link-rejected')
    const rejectListed=listTopicLinkProposals(db,{chatId:leftChat}).find((item)=>item.linkId==='cross-link-rejected')
    assert.ok(rejectListed)
    const rejected=resolveTopicLinkProposal(db,{linkId:rejectListed.linkId,expectedLinkRevision:rejectListed.linkRevision,leftTopicRevision:rejectListed.leftRevision,rightTopicRevision:rejectListed.rightRevision,choice:'reject'})
    assert.equal(rejected.ok,true)
    assert.equal(db.prepare('SELECT status FROM topic_links WHERE link_id=?').get('cross-link-rejected').status,'rejected')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM discussion_topics WHERE topic_id IN (?,?,?)').get('left-topic','right-topic','right-topic-reject').count,3,'rejecting a cross-chat link preserves both canonical Topics')

    insertLink('cross-link-stale')
    setCrossChatEnabled(db,rightChat,false)
    const denied=resolveTopicLinkProposal(db,{linkId:'cross-link-stale',expectedLinkRevision:1,leftTopicRevision:1,rightTopicRevision:1,choice:'accept'})
    assert.deepEqual(denied,{ok:false,reason:'scope_denied'})
    assert.ok(db.prepare('SELECT stale_at FROM topic_links WHERE link_id=?').get('cross-link-stale').stale_at)
    assert.equal(db.prepare("SELECT action FROM topic_link_identity_events WHERE link_id=? ORDER BY event_revision DESC LIMIT 1").get('cross-link-stale').action,'stale')
  }finally{opened.close()}
})

test('Topic prompt candidate-budget truncation records visible defer and removes the source from automatic polling',async()=>{
  const opened=openFixture();const db=opened.db;const chatId='identity-chat'
  try{
    const source=addMessage(db,'topic-budget-source',1000,'alpha project topic has an ambiguous follow-up')
    ensureGroupTopicsSchema(db);setEnabled(db,chatId,true)
    const insert=db.prepare('INSERT INTO discussion_topics(topic_id,chat_id,local_ref,title,summary,created_at,last_source_ts,revision) VALUES(?,?,?,?,?,?,?,1)')
    for(let i=0;i<60;i+=1) insert.run(`budget-topic-${i}`,chatId,`budget-${i}`,`Alpha project topic ${i}`,('alpha project activity summary ').repeat(6),NOW,1000-i)
    drainIndex(db,chatId,'topic',25)
    const service=createGroupTopicsService(db)
    let providerCalls=0;let payloadText=''
    const provider={id:'http',kind:'http',health:async()=>({ok:true,summary:'fixture',details:{}}),complete:async(request)=>{
      providerCalls+=1;payloadText=request.user
      const payload=JSON.parse(request.user);assert.equal(payload.historicalCandidatesTruncated,true)
      return {text:'',structured:{topics:[{ref:'ambiguous',title:'Alpha project follow-up',summary:'Unclear follow-up'}],
        identityDecisions:[{draftRef:'ambiguous',outcome:'defer',candidateType:null,candidateId:null,relationKind:null,reasonCode:'candidate_cap',confidenceBand:'low',evidenceMsgIds:[source]}],
        assignments:[{msgId:source,topicRef:'ambiguous',relation:'uncertain',confidence:.2,relevance:'unknown',relevanceEvidenceMsgIds:[]}]},meta:{provider:'http',model:'fixture',durationMs:0}}
    }}
    const first=await service.analyze(chatId,()=>provider)
    assert.equal(first.ok,true,JSON.stringify(first))
    assert.equal(providerCalls,1)
    assert.ok(payloadText.length<=7500)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM discussion_topics WHERE chat_id=?').get(chatId).count,60)
    assert.equal(db.prepare("SELECT disposition FROM topic_message_decisions WHERE chat_id=? AND msg_id=?").get(chatId,source).disposition,'uncertain')
    assert.equal(db.prepare("SELECT state,reason_codes_json FROM topic_identity_decisions WHERE chat_id=?").get(chatId).state,'open')
    assert.equal(service.pendingCount(chatId),0)
    await service.analyze(chatId,()=>provider)
    assert.equal(providerCalls,1,'the stored defer is not automatically submitted again')
  }finally{opened.close()}
})

test('GroupTopics keeps its user-priority provider path and rotates its durable epoch when the effective Host model/effort fingerprint changes',async()=>{
  const opened=openFixture();const db=opened.db;const chatId='identity-chat'
  try{
    ensureGroupTopicsSchema(db)
    const firstSource=addMessage(db,'topic-host-fingerprint-a',4000,'Synthetic group discussed a venue reservation')
    setEnabled(db,chatId,true)
    let effective='host-model-a-effort-low';let calls=0
    const provider={id:'codexCli',kind:'cli',runtimeFingerprint:async()=>effective,health:async()=>({ok:true,summary:'synthetic',details:{}}),complete:async(request)=>{
      calls+=1
      assert.equal(typeof request.onAdditionalUserPayload,'function','the actual Host provider can report each repair payload')
      assert.equal(request.onAdditionalUserPayload('topic repair bytes'),true)
      const source=JSON.parse(request.user).messages[0].msgId
      return {text:'',structured:{topics:[],identityDecisions:[],assignments:[{msgId:source,topicRef:null,relation:'uncertain',confidence:.2,relevance:'unknown',relevanceEvidenceMsgIds:[]}]},meta:{provider:'codexCli',model:'fixture',durationMs:1}}
    }}
    const service=createGroupTopicsService(db)
    const first=await service.analyze(chatId,()=>provider)
    assert.equal(first.ok,true,JSON.stringify(first))
    assert.equal(calls,1)
    assert.equal(readChatSourceState(db,chatId).submittedRequests,2,'Topic primary and repair attempts are counted from the final user payload')
    const stateA=readChatSourceState(db,chatId)
    const firstFingerprint=stateA.sessionFingerprint

    const secondSource=addMessage(db,'topic-host-fingerprint-b',5000,'Synthetic group agreed to reserve a different venue')
    effective='host-model-b-effort-high'
    const second=await service.analyze(chatId,()=>provider)
    assert.equal(second.ok,true,JSON.stringify(second))
    assert.equal(calls,2,'Topic analysis is a separate user-priority provider call')
    const stateB=readChatSourceState(db,chatId)
    assert.notEqual(stateB.sessionFingerprint,firstFingerprint,'the current effective Host model and effort participate in the Topic epoch fingerprint')
    assert.equal(stateB.sessionEpoch,stateA.sessionEpoch+1)
    assert.equal(db.prepare('SELECT processed FROM messages WHERE msg_id=?').get(firstSource).processed,0,'Topic progress does not acknowledge Todo')
    assert.equal(db.prepare('SELECT processed FROM messages WHERE msg_id=?').get(secondSource).processed,0,'both messages remain outside Todo processed progress')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM topic_message_decisions WHERE chat_id=?').get(chatId).count,2,'the separate Topic checkpoint records each source decision')
  }finally{opened.close()}
})

test('Phase 0: buildTodoApply returns an unexecuted body; skipSnapshotAssert and identityVersions behave as documented',()=>{
  const opened=openFixture();const db=opened.db;const chatId='identity-chat'
  try{
    const ctxFor=(work,msgId,extra={})=>({db,cfg:getPipelineDefaults(),now:NOW,identity:{
      snapshot:work.snapshot,sourceLease:work.lease,candidates:work.recalled.candidates,candidatesTruncated:work.candidatesTruncated,
      selectedMessageIds:[msgId],targetType:'todo',allowedTodoIds:work.openTodos.map((todo)=>todo.id)
    },...extra})
    const tally=()=>({todosCreated:0,todosMerged:0,todosResolvedDone:0,todosSuggestedDone:0,createdIds:[],resolvedIds:[],updatedIds:[]})
    const id1=addMessage(db,'p0-src-1',1000,'alpha beta action one')
    const work1=buildWork(db,chatId,[id1])
    const body1=buildTodoApply(ctxFor(work1,id1),chatId,[id1],newExtract(id1,todoDecision(id1,'d1'),todoDraft(id1,'d1')),tally())
    assert.equal(typeof body1,'function')
    assert.equal(listTodos({},db).length,0,'building has no side effects')
    db.transaction(body1)()
    assert.equal(listTodos({},db).length,1)
    const row1=db.prepare('SELECT prompt_version,schema_version FROM todo_identity_decisions WHERE chat_id=?').get(chatId)
    assert.deepEqual(row1,{prompt_version:'extract-identity-v1',schema_version:'extract-result-v3'})

    const id2=addMessage(db,'p0-src-2',2000,'gamma delta other thing')
    releaseIdentitySourceAttempt(db,work1.lease,false)
    const work2=buildWork(db,chatId,[id2])
    work2.snapshot.identityRevision+=1
    const extract2=newExtract(id2,todoDecision(id2,'d2'),todoDraft(id2,'d2',{title:'gamma delta other thing'}))
    const t2=tally()
    assert.throws(()=>db.transaction(buildTodoApply(ctxFor(work2,id2),chatId,[id2],extract2,t2))(),/identity_candidate_set_stale/)
    assert.equal(listTodos({},db).length,1)
    db.transaction(buildTodoApply(ctxFor(work2,id2,{identityVersions:{promptVersion:'extract-combined-v1',schemaVersion:'extract-combined-schema-v1'}}),chatId,[id2],extract2,t2,{skipSnapshotAssert:true}))()
    assert.equal(listTodos({},db).length,2)
    const row2=db.prepare("SELECT prompt_version,schema_version FROM todo_identity_decisions WHERE draft_ref='d2'").get()
    assert.deepEqual(row2,{prompt_version:'extract-combined-v1',schema_version:'extract-combined-schema-v1'})
  }finally{opened.db.close()}
})
