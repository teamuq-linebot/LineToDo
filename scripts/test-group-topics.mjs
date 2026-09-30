import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import test from 'node:test'
import { SCHEMA_DDL } from '../src/main/db/schema.ts'
import { createGroupTopicsService } from '../src/main/features/groupTopics/service.ts'
import { ensureGroupTopicsSchema } from '../src/main/features/groupTopics/repository.ts'
import { ensureLineImportSchema } from '../src/main/db/lineImport.repo.ts'
import { completedInputExists, GROUP_TOPICS_VALIDATOR_VERSION, loadMessages, listTopics, todoRefs } from '../src/main/features/groupTopics/repository.ts'
import { GROUP_TOPICS_JSON_SCHEMA, GROUP_TOPICS_PROMPT_HASH, GROUP_TOPICS_SCHEMA_HASH } from '../src/main/features/groupTopics/prompts/bundle.ts'

function dbFixture() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  db.exec(SCHEMA_DDL)
  ensureGroupTopicsSchema(db)
  ensureLineImportSchema(db)
  const insertChat = db.prepare(`INSERT INTO chats(chat_id,name,is_group,first_seen_at,last_seen_at) VALUES(?,?,1,?,?)`)
  insertChat.run('group-a','群甲','2026-09-30','2026-09-30')
  insertChat.run('group-b','群乙','2026-09-30','2026-09-30')
  db.prepare(`INSERT INTO chats(chat_id,name,is_group,first_seen_at,last_seen_at) VALUES('dm','私訊',0,'2026-09-30','2026-09-30')`).run()
  const msg = db.prepare(`INSERT INTO messages(msg_id,chat_id,ts,time_iso,direction,sender,text,content_type,processed,ingested_at)
    VALUES(?,?,?,?,?,'同名',?,0,0,'2026-09-30')`)
  msg.run('a1','group-a',1,'2026-09-30T00:00:01Z','in','Project Orion launch meeting')
  msg.run('a2','group-a',2,'2026-09-30T00:00:02Z','out','I will prepare the Orion launch deck')
  msg.run('b1','group-b',3,'2026-09-30T00:00:03Z','in','Project Orion budget timeline')
  msg.run('d1','dm',4,'2026-09-30T00:00:04Z','in','Project Orion launch meeting')
  return db
}

function fakeProvider(result, capture = () => {}) {
  return { complete: async (req) => { capture(req); return { text: JSON.stringify(result), meta: { provider:'http',model:'fake',durationMs:0 } } } }
}

const analysisA = {
  topics: [
    { ref:'launch', title:'Project Orion launch meeting', summary:'Project Orion launch planning deck.' },
    { ref:'person-followup', title:'Vendor slide request', summary:'A separate request to prepare a vendor presentation.' }
  ],
  assignments: [
    { msgId:'a1',topicRef:'launch',relation:'about',confidence:.8,relevance:'action',relevanceEvidenceMsgIds:['a1'] },
    { msgId:'a2',topicRef:'person-followup',relation:'about',confidence:.9,relevance:'awareness',relevanceEvidenceMsgIds:['a2'] }
  ]
}

test('group topic analysis is opt-in, chat-local, fail-closed, and never writes executable TODO state', async () => {
  const db = dbFixture()
  const service = createGroupTopicsService(db)
  let calls = 0
  const providerA = fakeProvider(analysisA, (req) => { calls++; assert.match(req.system,/ONE group chat/); assert.equal(JSON.parse(req.user).messages[0].msgId,'a1'); assert.equal(Object.hasOwn(JSON.parse(req.user).messages[0],'sender'),false); assert.equal(/participant_key|sender_mid|account_mid|_from/i.test(req.user),false) })
  assert.deepEqual(await service.analyze('group-a',()=>providerA),{ok:false,reason:'disabled'})
  assert.equal(calls,0)
  assert.deepEqual(service.enable('dm',true),{ok:false})
  assert.deepEqual(service.enable('group-a',true),{ok:true})
  assert.deepEqual(await service.analyze('group-a',()=>providerA),{ok:true,count:2})
  assert.equal(calls,1)
  const result=service.list('group-a')
  assert.equal(result.ok,true)
  assert.deepEqual(result.topics.flatMap((t)=>t.relevanceEvidence.map((entry)=>entry.relevance)).sort(),['action','awareness'])
  assert.equal(result.topics.find((t)=>t.title==='Project Orion launch meeting').userParticipation,'unknown')
  assert.equal(result.topics.find((t)=>t.title==='Vendor slide request').userParticipation,'i_participated')
  assert.ok(result.topics.every((t)=>t.observation==='unknown'&&t.heat==='unvalidated'&&t.trend==='unknown'))
  assert.equal(db.prepare('SELECT COUNT(*) n FROM todos').get().n,0)
  assert.equal(db.prepare('SELECT SUM(processed) n FROM messages').get().n,0)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM topic_message_decisions WHERE chat_id='group-a'").get().n,2)
  assert.equal(service.list('group-b').topics.length,0)
  assert.deepEqual(await service.analyze('group-a',()=>providerA),{ok:true,count:2})
  assert.equal(calls,1)
  db.close()
})

test('semantic cross-group recall is only a proposed unknown relation; chat-scoped identities never become same-person claims', async () => {
  const db=dbFixture(); const service=createGroupTopicsService(db)
  service.enable('group-a',true); service.enableCrossChat('group-a',true)
  service.enable('group-b',true); service.enableCrossChat('group-b',true)
  await service.analyze('group-a',()=>fakeProvider(analysisA))
  const resultB={topics:[{ref:'budget',title:'Orion budget',summary:'Project Orion budget timeline.'}],assignments:[{msgId:'b1',topicRef:'budget',relation:'about',confidence:.7,relevance:'unknown',relevanceEvidenceMsgIds:[]}]}
  await service.analyze('group-b',()=>fakeProvider(resultB))
  const candidates=service.listLinkCandidates('group-b')
  assert.equal(candidates.length,1)
  assert.equal(candidates[0].relation,'unknown')
  assert.equal(candidates[0].identityEvidence,'unknown')
  assert.equal(candidates[0].eventEvidenceCount,2)
  const stored=db.prepare('SELECT relation,identity_evidence,status FROM topic_links').get()
  assert.equal(stored.relation,'unknown'); assert.equal(stored.identity_evidence,'unknown'); assert.equal(stored.status,'proposed')
  assert.equal(service.listLinkCandidates('group-a').length,1)
  service.enable('group-b',false)
  assert.equal(service.listLinkCandidates('group-a').length,0)
  service.enable('group-b',true)
  service.enableCrossChat('group-b',false)
  assert.equal(service.listLinkCandidates('group-a').length,0)
  service.enableCrossChat('group-b',true)
  assert.equal(service.listLinkCandidates('group-a').length,1)
  assert.deepEqual(service.listLinkCandidates('group-a')[0].eventEvidenceMsgIds.sort(),['a1','b1'])
  db.prepare("UPDATE chats SET blocked=1 WHERE chat_id='group-b'").run()
  assert.equal(service.listLinkCandidates('group-a').length,0)
  db.prepare("UPDATE chats SET blocked=0 WHERE chat_id='group-b'").run()
  db.prepare("UPDATE chats SET blocked=1 WHERE chat_id='group-a'").run()
  assert.equal(service.listLinkCandidates('group-a').length,0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM todos').get().n,0)
  db.close()
})

test('reclassification atomically replaces old message evidence and exact TODO source references', async () => {
  const db=dbFixture(); const service=createGroupTopicsService(db); service.enable('group-a',true)
  const todo=db.prepare(`INSERT INTO todos(id,chat_id,bucket,title,source_msg_ids,created_at,updated_at) VALUES('todo-a','group-a','todo','Existing','["a1"]','now','now')`)
  todo.run()
  const first={topics:[{ref:'old',title:'Old subject',summary:'Old evidence topic.'}],assignments:[
    {msgId:'a1',topicRef:'old',relation:'about',confidence:.8,relevance:'unknown',relevanceEvidenceMsgIds:[]},
    {msgId:'a2',topicRef:null,relation:'uncertain',confidence:.2,relevance:'unknown',relevanceEvidenceMsgIds:[]}
  ]}
  await service.analyze('group-a',()=>fakeProvider(first))
  const oldTopic=listTopics(db,'group-a').find((t)=>t.title==='Old subject')
  assert.equal(todoRefs(db,oldTopic.topicId).length,1)
  db.prepare(`INSERT INTO discussion_topics(topic_id,chat_id,local_ref,title,summary,created_at,last_source_ts) VALUES('peer-topic','group-b','peer','Peer subject','Peer summary','now',3)`).run()
  db.prepare(`INSERT INTO topic_links(link_id,left_topic_id,right_topic_id,relation,identity_evidence,event_evidence_msg_ids,status,created_at)
    VALUES('old-link',?,'peer-topic','unknown','unknown','["a1","b1"]','proposed','now')`).run(oldTopic.topicId)
  db.prepare("UPDATE messages SET text='Reclassified subject changed' WHERE msg_id='a1'").run()
  const second={topics:[{ref:'new',title:'New subject',summary:'Replacement evidence topic.'}],assignments:[
    {msgId:'a1',topicRef:'new',relation:'about',confidence:.8,relevance:'unknown',relevanceEvidenceMsgIds:[]},
    {msgId:'a2',topicRef:null,relation:'uncertain',confidence:.2,relevance:'unknown',relevanceEvidenceMsgIds:[]}
  ]}
  await service.analyze('group-a',()=>fakeProvider(second))
  const rows=db.prepare('SELECT t.title,e.msg_id FROM topic_evidence e JOIN discussion_topics t ON t.topic_id=e.topic_id').all()
  assert.deepEqual(rows.map(({title,msg_id})=>({title,msg_id})),[{title:'New subject',msg_id:'a1'}])
  assert.equal(db.prepare("SELECT COUNT(*) n FROM topic_links WHERE link_id='old-link'").get().n,0)
  assert.equal(todoRefs(db,oldTopic.topicId).length,0)
  const newTopic=listTopics(db,'group-a').find((t)=>t.title==='New subject')
  assert.deepEqual(todoRefs(db,newTopic.topicId).map((ref)=>ref.matchedMsgIds),[['a1']])
  db.close()
})

test('completion key changes when prompt or schema contract versions change', async () => {
  const db=dbFixture(); const service=createGroupTopicsService(db); service.enable('group-a',true)
  await service.analyze('group-a',()=>fakeProvider(analysisA))
  const input=loadMessages(db,'group-a')
  const stored=db.prepare("SELECT prompt_version,prompt_hash,schema_version,schema_hash FROM topic_analysis_runs WHERE chat_id='group-a'").get()
  assert.ok(stored.prompt_version)
  const key={promptVersion:stored.prompt_version,promptHash:stored.prompt_hash,schemaVersion:stored.schema_version,schemaHash:stored.schema_hash,validatorVersion:GROUP_TOPICS_VALIDATOR_VERSION}
  assert.equal(completedInputExists(db,'group-a',input,key),true)
  assert.equal(completedInputExists(db,'group-a',input,{...key,promptVersion:'revised'}),false)
  assert.equal(completedInputExists(db,'group-a',input,{...key,promptHash:'revised'}),false)
  assert.equal(completedInputExists(db,'group-a',input,{...key,schemaVersion:'revised'}),false)
  assert.equal(completedInputExists(db,'group-a',input,{...key,schemaHash:'revised'}),false)
  assert.equal(completedInputExists(db,'group-a',input,{...key,validatorVersion:'revised'}),false)
  db.close()
})

test('malformed outputs are rejected and stored only as safe retryable error codes', async () => {
  const db=dbFixture(); const service=createGroupTopicsService(db); service.enable('group-a',true)
  const failed=await service.analyze('group-a',()=>fakeProvider({topics:[],assignments:[]}))
  assert.deepEqual(failed,{ok:false,reason:'analysis_failed'})
  assert.equal(db.prepare("SELECT state FROM topic_analysis_runs ORDER BY created_at DESC LIMIT 1").get().state,'failed')
  assert.equal(db.prepare("SELECT error_code FROM topic_analysis_runs ORDER BY created_at DESC LIMIT 1").get().error_code,'invalid_output')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM discussion_topics').get().n,0)
  db.close()
})

test('single-participant repeated messages retain local evidence but cannot produce hot/up or a multi-person claim', async () => {
  const db=dbFixture(); const service=createGroupTopicsService(db); service.enable('group-a',true)
  db.prepare("DELETE FROM messages WHERE chat_id='group-a'").run()
  const insert=db.prepare(`INSERT INTO messages(msg_id,chat_id,ts,time_iso,direction,sender,text,content_type,processed,ingested_at)
    VALUES(?, 'group-a', ?, '2026-09-30T00:00:00Z','in','同名','Project Orion launch update',0,0,'2026-09-30')`)
  const participant=db.prepare(`INSERT INTO message_participants(msg_id,chat_id,participant_key,scope,key_version,identity_status,is_me)
    VALUES(?, 'group-a','chat-scoped-synthetic','chat',1,'keyed',0)`)
  const assignments=[]
  for(let i=0;i<30;i++){const id=`spam-${i}`;insert.run(id,10+i);participant.run(id);assignments.push({msgId:id,topicRef:'launch',relation:'repost',confidence:.9,relevance:'unknown',relevanceEvidenceMsgIds:[]})}
  const result=await service.analyze('group-a',()=>fakeProvider({topics:[{ref:'launch',title:'Project Orion launch',summary:'Repeated launch update.'}],assignments}))
  assert.deepEqual(result,{ok:true,count:1})
  const topic=service.list('group-a').topics[0]
  assert.equal(topic.evidenceCount,30)
  assert.equal(topic.participantLowerBound,1)
  assert.equal(topic.heat,'unvalidated')
  assert.equal(topic.trend,'unknown')
  assert.equal(db.prepare('SELECT COUNT(DISTINCT participant_key) n FROM message_participants WHERE chat_id=\'group-a\'').get().n,1)
  db.close()
})

test('prompt bundle has tracked source hashes and strict JSON schema', () => {
  assert.match(GROUP_TOPICS_PROMPT_HASH,/^[a-f0-9]{64}$/)
  assert.match(GROUP_TOPICS_SCHEMA_HASH,/^[a-f0-9]{64}$/)
  assert.equal(GROUP_TOPICS_JSON_SCHEMA.additionalProperties,false)
  assert.equal(GROUP_TOPICS_JSON_SCHEMA.properties.assignments.items.additionalProperties,false)
})
