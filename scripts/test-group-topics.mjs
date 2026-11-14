import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import NativeDatabase from 'better-sqlite3-plugin'
import test from 'node:test'
import { SCHEMA_DDL } from '../src/main/db/schema.ts'
import { createGroupTopicsService, fitOverviewToBudget, GROUP_TOPICS_OVERVIEW_BYTE_LIMIT, GROUP_TOPICS_OVERVIEW_TOPIC_LIMIT } from '../src/main/features/groupTopics/service.ts'
import { ensureGroupTopicsSchema } from '../src/main/features/groupTopics/repository.ts'
import { createTopicBackground } from '../src/main/features/groupTopics/background.ts'
import { ensureChatTodoPrefsSchema, setTodoExtractEnabled } from '../src/main/db/chatTodoPrefs.repo.ts'
import { ensureLineImportSchema } from '../src/main/db/lineImport.repo.ts'
import { buildTopicSave, completedInputExists, countPendingMessages, GROUP_TOPICS_VALIDATOR_VERSION, loadMessages, loadPendingMessages, listTopics, saveAnalysis, selectTopicTargets, todoRefs } from '../src/main/features/groupTopics/repository.ts'
import { COMBINED_BUNDLE_ENABLED, COMBINED_JSON_SCHEMA, COMBINED_PROMPT_HASH, COMBINED_PROMPT_VERSION, COMBINED_SCHEMA_HASH, COMBINED_SCHEMA_VERSION, COMBINED_TOPIC_SECTION, GROUP_TOPICS_BUNDLE_ENABLED, GROUP_TOPICS_JSON_SCHEMA, GROUP_TOPICS_PROMPT, GROUP_TOPICS_PROMPT_HASH, GROUP_TOPICS_PROMPT_VERSION, GROUP_TOPICS_SCHEMA_HASH, GROUP_TOPICS_SCHEMA_VERSION } from '../src/main/features/groupTopics/prompts/bundle.ts'
import { makeHttpProvider } from '../src/main/llm/provider/httpOpenAi.ts'
import { LlmProviderError } from '../src/main/llm/provider/types.ts'
import { loadGroupTopicsOverview, overviewOmissionNotice, overviewToEntries } from '../src/renderer/features/groupTopics/groupTopicsOverview.ts'
import { buildTopicRows, filterTopicRows, formatTopicTime, sortTopicRows } from '../src/renderer/features/groupTopics/topicRows.ts'

function dbFixture(filename = ':memory:') {
  const db = new NativeDatabase(filename)
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

function withIdentityDecisions(result,user) {
  if(!result||!Array.isArray(result.topics)||Array.isArray(result.identityDecisions))return result
  const payload=JSON.parse(user)
  const candidates=payload.historicalCandidates??[]
  const messages=payload.messages??[]
  return {...result,identityDecisions:result.topics.map((topic)=>{
    const existing=candidates.find((candidate)=>candidate.entityType==='topic'&&candidate.title.trim().toLocaleLowerCase()===topic.title.trim().toLocaleLowerCase())
    const evidence=(result.assignments??[]).filter((assignment)=>assignment.topicRef===topic.ref).map((assignment)=>assignment.msgId).filter((id)=>messages.some((message)=>message.msgId===id))
    const evidenceMsgIds=evidence.length?evidence:[messages[0]?.msgId].filter(Boolean)
    return {draftRef:topic.ref,outcome:existing?'update_existing':'new',candidateType:existing?'topic':null,candidateId:existing?.entityId??null,relationKind:null,reasonCode:existing?'same_active_action':'insufficient_evidence',confidenceBand:'high',evidenceMsgIds}
  })}
}

function fakeProvider(result, capture = () => {}) {
  return { kind:'http', complete: async (req) => {
    capture(req)
    const output=withIdentityDecisions(result,req.user)
    return { text: JSON.stringify(output), meta: { provider:'http',model:'fake',durationMs:0 } }
  } }
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
  ensureChatTodoPrefsSchema(db)
  setTodoExtractEnabled(db,'group-a',false)
  const service = createGroupTopicsService(db)
  let calls = 0
  const providerA = fakeProvider(analysisA, (req) => { calls++; assert.match(req.system,/ONE chat only/); assert.equal(JSON.parse(req.user).messages[0].msgId,'a1'); assert.equal(Object.hasOwn(JSON.parse(req.user).messages[0],'sender'),false); assert.equal(/participant_key|sender_mid|account_mid|_from/i.test(req.user),false) })
  assert.deepEqual(await service.analyze('group-a',()=>providerA),{ok:false,reason:'disabled'})
  assert.equal(calls,0)
  assert.deepEqual(service.enable('group-a',true),{ok:true})
  assert.deepEqual(await service.analyze('group-a',()=>providerA),{ok:true,count:2,analyzedCount:2})
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
  assert.deepEqual(await service.analyze('group-a',()=>providerA),{ok:true,count:2,analyzedCount:0})
  assert.equal(calls,1)
  db.close()
})

test('standalone provider and additional-payload callback receive only deep-redacted content', async () => {
  const db=dbFixture()
  db.prepare("UPDATE messages SET text=? WHERE msg_id='a1'").run('Authorization: Bearer synthetic-standalone-canary; Project Orion schedule')
  const service=createGroupTopicsService(db,{resolveProfile:()=>({topic:{instruction:'Keep API-key=synthetic-profile-canary hidden',source:'default'},revision:'rev-canary'})})
  const provider={kind:'http',complete:async(req)=>{
    assert.equal(req.user.includes('synthetic-standalone-canary'),false)
    assert.equal(req.system.includes('synthetic-profile-canary'),false)
    assert.match(req.user,/Project Orion schedule/)
    assert.equal(req.onAdditionalUserPayload(JSON.stringify({repair:'refresh_token=synthetic-callback-canary'})),true)
    return {text:JSON.stringify(withIdentityDecisions(analysisA,req.user)),meta:{provider:'http',model:'mock',durationMs:0}}
  },userPayloadLimit:()=>7500}
  service.enable('group-a',true)
  const result=await service.analyze('group-a',()=>provider)
  assert.equal(result.ok,true)
  db.close()
})

test('direct chat topics are opt-in, stay chat-local, retain todo references, and never enter group candidates', async () => {
  const db=dbFixture(); const service=createGroupTopicsService(db)
  const directResult={topics:[{ref:'direct-orion',title:'Project Orion in a private chat',summary:'A private discussion about the Orion launch.'}],assignments:[
    {msgId:'d1',topicRef:'direct-orion',relation:'about',confidence:.8,relevance:'unknown',relevanceEvidenceMsgIds:[]}
  ]}
  let directCalls=0
  const directProvider=fakeProvider(directResult,(req)=>{
    directCalls++
    const input=JSON.parse(req.user)
    assert.deepEqual(input.messages.map((message)=>message.msgId),['d1'])
    assert.equal(req.user.includes('a1'),false)
    assert.equal(req.user.includes('b1'),false)
  })
  assert.deepEqual(service.list('dm'),{ok:false,topics:[]})
  assert.equal(service.pendingCount('dm'),0)
  assert.deepEqual(await service.analyze('dm',()=>directProvider),{ok:false,reason:'disabled'})
  assert.equal(directCalls,0)
  assert.deepEqual(service.enable('dm',true),{ok:true})
  assert.equal(service.pendingCount('dm'),1)
  const todo=db.prepare(`INSERT INTO todos(id,chat_id,bucket,title,source_msg_ids,created_at,updated_at)
    VALUES('todo-dm','dm','todo','私人聊天室的既有待辦','["d1"]','now','now')`)
  todo.run()
  assert.deepEqual(await service.analyze('dm',()=>directProvider),{ok:true,count:1,analyzedCount:1})
  assert.equal(directCalls,1)
  const ownTopic=service.list('dm')
  assert.equal(ownTopic.ok,true)
  assert.equal(ownTopic.topics.length,1)
  assert.equal(ownTopic.topics[0].chatId,'dm')
  assert.deepEqual(service.todoRefs(ownTopic.topics[0].topicId),[{todoId:'todo-dm',status:'pending',bucket:'todo',matchedMsgIds:['d1']}])
  assert.deepEqual(service.list('group-a'),{ok:true,topics:[]})
  assert.equal(service.enableCrossChat,undefined)
  assert.equal(service.crossChatEnabled,undefined)
  assert.equal(service.listLinkCandidates,undefined)

  service.enable('dm',false)
  assert.deepEqual(service.list('dm'),{ok:false,topics:[]})
  assert.equal(service.pendingCount('dm'),0)
  assert.deepEqual(service.enable('dm',true),{ok:true})
  db.prepare("UPDATE chats SET blocked=1 WHERE chat_id='dm'").run()
  assert.equal(service.list('dm').ok,false,'a leftover ignore flag (migration not done yet) keeps the topic switch closed')
  db.prepare("UPDATE chats SET blocked=0 WHERE chat_id='dm'").run()
  assert.equal(service.list('dm').ok,true,'once the flag is cleared the stored switch applies')
  service.enable('dm',false)
  assert.deepEqual(service.list('dm'),{ok:false,topics:[]})
  assert.equal(service.pendingCount('dm'),0)
  assert.deepEqual(await service.analyze('dm',()=>{throw new Error('disabled chat must not resolve a provider')}),{ok:false,reason:'disabled'})
  assert.deepEqual(service.enable('missing-chat',true),{ok:false})
  assert.deepEqual(service.list('missing-chat'),{ok:false,topics:[]})
  assert.equal(service.pendingCount('missing-chat'),0)
  assert.deepEqual(await service.analyze('missing-chat',()=>{throw new Error('missing chat must not resolve a provider')}),{ok:false,reason:'unsupported_chat'})
  db.close()
})

test('labeled summaries over the former 500-char ceiling round-trip through analysis/storage, and legacy summaries remain readable', async () => {
  const db = dbFixture()
  const service = createGroupTopicsService(db)
  service.enable('group-a', true)
  const summary = ['背景：'.concat('場地討論'.repeat(220)), '討論重點：交通與容量', '共識／結論：未定', '待釐清：預算', '演進：尚無新進展'].join('\n')
  assert.ok(summary.length > 500 && summary.length <= 2000)
  const analysis = {
    topics:[{ref:'meeting',title:'活動場地',summary}],
    assignments:[
      {msgId:'a1',topicRef:'meeting',relation:'about',confidence:.9,relevance:'unknown',relevanceEvidenceMsgIds:[]},
      {msgId:'a2',topicRef:'meeting',relation:'about',confidence:.8,relevance:'unknown',relevanceEvidenceMsgIds:[]}
    ]
  }
  assert.deepEqual(await service.analyze('group-a',()=>fakeProvider(analysis)),{ok:true,count:1,analyzedCount:2})
  assert.equal(service.list('group-a').topics[0].summary,summary)
  db.prepare("UPDATE discussion_topics SET summary='舊版純摘要仍可讀' WHERE chat_id='group-a'").run()
  assert.equal(service.list('group-a').topics[0].summary,'舊版純摘要仍可讀')
  db.close()
})

test('X1 cross-group lexical recall is retired: overlapping terms create no topic_links even with legacy cross_chat_enabled rows', async () => {
  const db=dbFixture(); const service=createGroupTopicsService(db)
  service.enable('group-a',true); service.enable('group-b',true)
  db.prepare('UPDATE group_topic_preferences SET cross_chat_enabled=1 WHERE chat_id IN (?,?)').run('group-a','group-b')
  await service.analyze('group-a',()=>fakeProvider(analysisA))
  const resultB={topics:[{ref:'budget',title:'Orion budget',summary:'Project Orion budget timeline.'}],assignments:[{msgId:'b1',topicRef:'budget',relation:'about',confidence:.7,relevance:'unknown',relevanceEvidenceMsgIds:[]}]}
  const analysed=await service.analyze('group-b',()=>fakeProvider(resultB))
  assert.equal(analysed.ok,true)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM topic_links').get().n,0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM topic_link_identity_events').get().n,0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM discussion_topics').get().n>=2,true)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM group_topic_preferences WHERE cross_chat_enabled=1').get().n,2)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM todos').get().n,0)
  db.close()
})

test('X2 pre-existing proposed links and stale_at semantics are unchanged by the retired recall', async () => {
  const db=dbFixture(); const service=createGroupTopicsService(db)
  service.enable('group-a',true)
  db.prepare(`INSERT INTO discussion_topics(topic_id,chat_id,local_ref,title,summary,created_at,last_source_ts) VALUES('peer-x2','group-b','peer','Peer subject','Peer summary','now',3)`).run()
  await service.analyze('group-a',()=>fakeProvider(analysisA))
  const topic=listTopics(db,'group-a')[0]
  db.prepare(`INSERT INTO topic_links(link_id,left_topic_id,right_topic_id,relation,identity_evidence,event_evidence_msg_ids,status,created_at) VALUES('keep-link',?,'peer-x2','unknown','unknown','["a1","b1"]','proposed','now')`).run(topic.topicId)
  const row=db.prepare("SELECT relation,identity_evidence,status,stale_at FROM topic_links WHERE link_id='keep-link'").get()
  assert.deepEqual({...row},{relation:'unknown',identity_evidence:'unknown',status:'proposed',stale_at:null})
  db.close()
})

test('authorized message reclassification atomically replaces old evidence and exact TODO source references', async () => {
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
  const stored=db.prepare("SELECT prompt_version,prompt_hash,schema_version,schema_hash FROM topic_analysis_runs WHERE chat_id='group-a' LIMIT 1").get()
  assert.equal(saveAnalysis(db,'group-a',loadMessages(db,'group-a'),second,{promptVersion:stored.prompt_version,promptHash:stored.prompt_hash,schemaVersion:stored.schema_version,schemaHash:stored.schema_hash,validatorVersion:GROUP_TOPICS_VALIDATOR_VERSION}),true)
  const rows=db.prepare('SELECT t.title,e.msg_id FROM topic_evidence e JOIN discussion_topics t ON t.topic_id=e.topic_id').all()
  assert.deepEqual(rows.map(({title,msg_id})=>({title,msg_id})),[{title:'New subject',msg_id:'a1'}])
  assert.equal(db.prepare("SELECT COUNT(*) n FROM topic_links WHERE link_id='old-link'").get().n,1)
  assert.ok(db.prepare("SELECT stale_at FROM topic_links WHERE link_id='old-link'").get().stale_at)
  assert.equal(db.prepare("SELECT action FROM topic_link_identity_events WHERE link_id='old-link'").get().action,'stale')
  assert.equal(todoRefs(db,oldTopic.topicId).length,0)
  const newTopic=listTopics(db,'group-a').find((t)=>t.title==='New subject')
  assert.deepEqual(todoRefs(db,newTopic.topicId).map((ref)=>ref.matchedMsgIds),[['a1']])
  db.close()
})

test('the topic prompt groups by discussion subject without forcing every chat into meeting notes', () => {
  assert.ok(!GROUP_TOPICS_PROMPT.includes('meeting-note style record'))
  assert.ok(GROUP_TOPICS_PROMPT.includes('Group messages by the subject being discussed, not by individual action items'))
  assert.ok(GROUP_TOPICS_PROMPT.includes('Do not invent people, dates, sources, decisions, or consensus'))
  assert.ok(GROUP_TOPICS_PROMPT.includes('Announcements are topics too'))
})

test('topic summary validator accepts labeled meeting notes and rejects summaries beyond the shared 2000-char contract', async () => {
  const { validateTopicAnalysis } = await import('../src/main/features/groupTopics/domain.ts')
  const summary = ['背景：群組討論活動場地', '討論重點：比較交通與容量', '共識／結論：未定', '待釐清：預算', '演進：新增候選'].join('\\n')
  const valid = { topics:[{ref:'meeting',title:'活動場地',summary}], assignments:[] }
  assert.equal(validateTopicAnalysis(valid, []).topics[0].summary, summary)
  assert.throws(() => validateTopicAnalysis({ ...valid, topics:[{ ...valid.topics[0], summary:'x'.repeat(2001) }] }, []), { reason:'invalid_value', path:'$.topics[*].summary' })
})

test('a prompt hash change does not requeue analyzed messages: decided messages are never selected again', async () => {
  const db=dbFixture(); const service=createGroupTopicsService(db); service.enable('group-a',true)
  await service.analyze('group-a',()=>fakeProvider(analysisA))
  assert.equal(db.prepare("SELECT COUNT(*) n FROM topic_message_decisions WHERE chat_id='group-a'").get().n,2,'the per-message decisions exist: they are what keeps the messages out of the queue')
  db.prepare("UPDATE topic_analysis_runs SET prompt_hash='hash-before-the-prompt-change' WHERE chat_id='group-a'").run()
  assert.deepEqual(loadPendingMessages(db,'group-a').map((m)=>m.msgId),[])
  assert.deepEqual(selectTopicTargets(db,'group-a',['a1','a2']),[])
  let calls=0
  assert.deepEqual(await service.analyze('group-a',()=>fakeProvider(analysisA,()=>{calls++})),{ok:true,count:2,analyzedCount:0})
  assert.equal(calls,0)
  db.prepare("DELETE FROM topic_message_decisions WHERE chat_id='group-a'").run()
  assert.deepEqual(loadPendingMessages(db,'group-a').map((m)=>m.msgId).sort(),['a1','a2'],'positive control: with the decisions gone the same messages are selected again, so the empty selections above prove the decisions (not the runs table) decide')
  assert.deepEqual(selectTopicTargets(db,'group-a',['a1','a2']).sort(),['a1','a2'])
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

test('standalone caller sends the shared profile rule and a changed profile revision invalidates completion dedupe', async () => {
  const db=dbFixture(); let revision='rev-a'; let rule='topic rule A'; let sent=[]
  const profile=()=>({chatId:'group-a',chatKind:'group',natureId:'work_project',natureLabel:'Work',todo:{instruction:'todo',source:'matrix'},topic:{instruction:rule,source:'matrix'},myName:{value:null,source:'none'},revision,archivedNature:false})
  const service=createGroupTopicsService(db,{resolveProfile:profile}); service.enable('group-a',true)
  const provider=fakeProvider(analysisA,(req)=>sent.push(req.system))
  assert.equal((await service.analyze('group-a',()=>provider)).analyzedCount,2)
  assert.ok(sent[0].includes('topic rule A')&&sent[0].includes('rev-a'))
  db.prepare("DELETE FROM topic_message_decisions WHERE chat_id='group-a'").run()
  revision='rev-b'; rule='topic rule B'
  const next=fakeProvider(analysisA,(req)=>sent.push(req.system))
  assert.equal((await service.analyze('group-a',()=>next)).analyzedCount,2)
  assert.ok(sent[1].includes('topic rule B')&&sent[1].includes('rev-b'))
  const run=db.prepare("SELECT prompt_hash FROM topic_analysis_runs WHERE chat_id='group-a' ORDER BY created_at DESC LIMIT 1").get()
  assert.ok(run.prompt_hash)
  db.close()
})

test('malformed outputs are rejected and stored only as safe retryable error codes', async () => {
  const db=dbFixture(); const service=createGroupTopicsService(db); service.enable('group-a',true)
  const failed=await service.analyze('group-a',()=>fakeProvider({topics:[],assignments:[]}))
  assert.deepEqual(failed,{ok:false,reason:'analysis_failed',failure:{stage:'domain_validate',path:'$.assignments',code:'missing_assignment'}})
  assert.equal(db.prepare("SELECT state FROM topic_analysis_runs ORDER BY created_at DESC LIMIT 1").get().state,'failed')
  assert.equal(db.prepare("SELECT error_code FROM topic_analysis_runs ORDER BY created_at DESC LIMIT 1").get().error_code,'invalid_output')
  assert.deepEqual({...db.prepare("SELECT failure_stage,failure_path,failure_reason,provider_kind FROM topic_analysis_runs ORDER BY created_at DESC LIMIT 1").get()},{failure_stage:'domain_validate',failure_path:'$.assignments',failure_reason:'missing_assignment',provider_kind:'http'})
  assert.equal(db.prepare('SELECT COUNT(*) n FROM discussion_topics').get().n,0)
  db.close()
})

test('production HTTP adapter sends the exact batch contract without unsupported uniqueItems', async () => {
  const db=dbFixture(); const service=createGroupTopicsService(db); service.enable('group-a',true)
  let sentBody
  const fetch=async (_url,init) => {
    sentBody=JSON.parse(String(init.body))
    const input=sentBody.messages.find((message)=>message.role==='user').content
    return new Response(JSON.stringify({id:'synthetic',object:'chat.completion',created:1,model:'mock-model',choices:[{index:0,message:{role:'assistant',content:JSON.stringify(withIdentityDecisions(analysisA,input))},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{status:200,headers:{'content-type':'application/json'}})
  }
  const provider=makeHttpProvider({apiKey:'synthetic-secret-canary',baseURL:'https://mock.invalid/v1',model:'mock-model',maxRetries:0,fetch})
  const result=await service.analyze('group-a',()=>provider)
  assert.deepEqual(result,{ok:true,count:2,analyzedCount:2})
  const assignments=sentBody.response_format.json_schema.schema.properties.assignments
  assert.equal(assignments.minItems,2)
  assert.equal(assignments.maxItems,2)
  assert.deepEqual(assignments.items.properties.msgId.enum,['a1','a2'])
  assert.equal(assignments.items.properties.relevanceEvidenceMsgIds.maxItems,2)
  assert.deepEqual(assignments.items.properties.relevanceEvidenceMsgIds.items.enum,['a1','a2'])
  const unsupportedPaths=(node,path='$')=>{
    if(Array.isArray(node)) return node.flatMap((value,index)=>unsupportedPaths(value,`${path}[${index}]`))
    if(!node||typeof node!=='object') return []
    return [...(Object.hasOwn(node,'uniqueItems')?[`${path}.uniqueItems`]:[]),...Object.entries(node).flatMap(([key,value])=>unsupportedPaths(value,`${path}.${key}`))]
  }
  assert.deepEqual(unsupportedPaths(sentBody.response_format.json_schema.schema),[])
  const knownUnsupported={...sentBody.response_format.json_schema.schema,properties:{...sentBody.response_format.json_schema.schema.properties,assignments:{...assignments,items:{...assignments.items,properties:{...assignments.items.properties,relevanceEvidenceMsgIds:{...assignments.items.properties.relevanceEvidenceMsgIds,uniqueItems:true}}}}}}
  assert.deepEqual(unsupportedPaths(knownUnsupported),['$.properties.assignments.items.properties.relevanceEvidenceMsgIds.uniqueItems'])
  assert.equal(db.prepare('SELECT COUNT(*) n FROM topic_message_decisions WHERE chat_id=\'group-a\'').get().n,2)
  db.close()
})

test('duplicate evidence IDs are rejected by the domain even though provider schema omits uniqueItems', async () => {
  const db=dbFixture(); const service=createGroupTopicsService(db); service.enable('group-a',true)
  const duplicate={topics:[{ref:'orion',title:'Project Orion',summary:'Planning.'}],assignments:[
    {msgId:'a1',topicRef:'orion',relation:'about',confidence:.8,relevance:'action',relevanceEvidenceMsgIds:['a1','a1']},
    {msgId:'a2',topicRef:'orion',relation:'about',confidence:.8,relevance:'unknown',relevanceEvidenceMsgIds:[]}
  ]}
  const result=await service.analyze('group-a',()=>fakeProvider(duplicate))
  assert.deepEqual(result,{ok:false,reason:'analysis_failed',failure:{stage:'domain_validate',path:'$.assignments[*].relevanceEvidenceMsgIds',code:'invalid_evidence'}})
  assert.equal(service.pendingCount('group-a'),2)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM topic_message_decisions').get().n,0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM topic_message_checkpoints').get().n,0)
  db.close()
})

test('production HTTP LlmProviderError mapping and malformed body persist only safe enums and fixed paths', async () => {
  const db=dbFixture(); const service=createGroupTopicsService(db); service.enable('group-a',true)
  const fetch=async () => new Response(JSON.stringify({error:{message:'synthetic-private-response-canary',type:'server_error',param:null,code:'rate_limited'}}),{status:429,headers:{'content-type':'application/json'}})
  const provider=makeHttpProvider({apiKey:'synthetic-secret-canary',baseURL:'https://mock.invalid/v1',model:'mock-model',maxRetries:0,fetch})
  const mapped=await provider.complete({system:'synthetic',user:'{}'}).then(()=>null,(error)=>error)
  assert.ok(mapped instanceof LlmProviderError)
  assert.equal(mapped.code,'rate_limited')
  const result=await service.analyze('group-a',()=>provider)
  assert.deepEqual(result,{ok:false,reason:'analysis_failed',failure:{stage:'provider_complete',path:null,code:'rate_limited'}})
  let stored=db.prepare("SELECT failure_stage,failure_path,failure_reason,provider_kind,error_code FROM topic_analysis_runs WHERE chat_id='group-a'").get()
  assert.deepEqual({...stored},{failure_stage:'provider_complete',failure_path:null,failure_reason:'rate_limited',provider_kind:'http',error_code:'rate_limited'})
  const bodyCanaryFetch=async () => new Response(JSON.stringify({id:'synthetic',object:'chat.completion',created:1,model:'mock-model',choices:[{index:0,message:{role:'assistant',content:'synthetic-raw-output-canary'},finish_reason:'stop'}]}),{status:200,headers:{'content-type':'application/json'}})
  const malformed=makeHttpProvider({apiKey:'synthetic-secret-canary',baseURL:'https://mock.invalid/v1',model:'mock-model',maxRetries:0,fetch:bodyCanaryFetch})
  const decoded=await service.analyze('group-a',()=>malformed)
  assert.deepEqual(decoded,{ok:false,reason:'analysis_failed',failure:{stage:'response_decode',path:null,code:'invalid_json'}})
  stored=db.prepare("SELECT failure_stage,failure_path,failure_reason,provider_kind,error_code FROM topic_analysis_runs WHERE chat_id='group-a'").get()
  assert.deepEqual({...stored},{failure_stage:'response_decode',failure_path:null,failure_reason:'invalid_json',provider_kind:'http',error_code:'invalid_json'})
  const durable=JSON.stringify(db.prepare('SELECT * FROM topic_analysis_runs').all())
  assert.equal(durable.includes('synthetic-private-response-canary'),false)
  assert.equal(durable.includes('synthetic-raw-output-canary'),false)
  assert.equal(durable.includes('synthetic-secret-canary'),false)
  assert.equal(Object.hasOwn(decoded.failure,'detail'),false)
  assert.equal(service.pendingCount('group-a'),2)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM topic_message_decisions').get().n,0)
  db.close()
})

test('legacy analysis run table upgrades additively and retains rows', () => {
  const db=new NativeDatabase(':memory:'); db.pragma('foreign_keys=ON'); db.exec(SCHEMA_DDL)
  db.exec(`CREATE TABLE topic_analysis_runs (run_id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,input_digest TEXT NOT NULL,prompt_version TEXT NOT NULL,prompt_hash TEXT NOT NULL,schema_version TEXT NOT NULL,schema_hash TEXT NOT NULL,state TEXT NOT NULL,error_code TEXT,created_at TEXT NOT NULL,UNIQUE(chat_id,input_digest))`)
  db.prepare(`INSERT INTO topic_analysis_runs VALUES('legacy-run','synthetic-chat','digest','p','ph','s','sh','failed','invalid_output','2026-09-30')`).run()
  ensureGroupTopicsSchema(db)
  const columns=new Set(db.prepare('PRAGMA table_info(topic_analysis_runs)').all().map((column)=>column.name))
  for(const name of ['failure_stage','failure_path','failure_reason','provider_kind']) assert.equal(columns.has(name),true)
  assert.deepEqual({...db.prepare("SELECT run_id,state,error_code FROM topic_analysis_runs WHERE run_id='legacy-run'").get()},{run_id:'legacy-run',state:'failed',error_code:'invalid_output'})
  assert.throws(()=>db.prepare("UPDATE topic_analysis_runs SET failure_stage='raw provider response' WHERE run_id='legacy-run'").run())
  db.close()
})

test('failed run diagnostics survive reopen, remain retryable, and clear after durable success', async () => {
  const dir=mkdtempSync(join(tmpdir(),'line-todo-topics-safe-failure-')); const filename=join(dir,'topics.sqlite')
  let db
  try {
    db=dbFixture(filename); let service=createGroupTopicsService(db); service.enable('group-a',true)
    const failing={kind:'cli',complete:async()=>{throw new LlmProviderError('timeout','synthetic-private-message','synthetic-private-detail')}}
    const result=await service.analyze('group-a',()=>failing)
    assert.deepEqual(result,{ok:false,reason:'analysis_failed',failure:{stage:'provider_complete',path:null,code:'timeout'}})
    const failure=db.prepare("SELECT failure_stage,failure_path,failure_reason,provider_kind,error_code FROM topic_analysis_runs WHERE chat_id='group-a'").get()
    assert.deepEqual({...failure},{failure_stage:'provider_complete',failure_path:null,failure_reason:'timeout',provider_kind:'cli',error_code:'timeout'})
    assert.equal(service.pendingCount('group-a'),2)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM topic_message_decisions').get().n,0)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM topic_message_checkpoints').get().n,0)
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM topic_analysis_runs').all()).includes('synthetic-private'),false)
    db.close(); db=null

    db=new NativeDatabase(filename); db.pragma('foreign_keys=ON'); ensureGroupTopicsSchema(db); service=createGroupTopicsService(db)
    assert.equal(service.pendingCount('group-a'),2)
    const retry=await service.analyze('group-a',()=>fakeProvider(analysisA))
    assert.deepEqual(retry,{ok:true,count:2,analyzedCount:2})
    assert.equal(service.pendingCount('group-a'),0)
    const recovered=db.prepare("SELECT state,failure_stage,failure_path,failure_reason,provider_kind,error_code FROM topic_analysis_runs WHERE chat_id='group-a'").get()
    assert.deepEqual({...recovered},{state:'complete',failure_stage:null,failure_path:null,failure_reason:null,provider_kind:null,error_code:null})
    db.close(); db=null

    db=new NativeDatabase(filename); db.pragma('foreign_keys=ON'); ensureGroupTopicsSchema(db)
    assert.equal(db.prepare("SELECT COUNT(*) n FROM discussion_topics WHERE chat_id='group-a'").get().n,2)
    assert.equal(db.prepare("SELECT COUNT(*) n FROM topic_message_decisions WHERE chat_id='group-a'").get().n,2)
    assert.equal(db.prepare("SELECT COUNT(*) n FROM topic_analysis_runs WHERE chat_id='group-a' AND state='complete'").get().n,1)
    db.close(); db=null
  } finally {
    if(db?.open) db.close()
    rmSync(dir,{recursive:true,force:true})
  }
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
  const provider={kind:'http',complete:async(req)=>{const supplied=JSON.parse(req.user).messages;const result={topics:[{ref:'launch',title:'Project Orion launch',summary:'Repeated launch update.'}],assignments:supplied.map((m)=>({msgId:m.msgId,topicRef:'launch',relation:'repost',confidence:.9,relevance:'unknown',relevanceEvidenceMsgIds:[]}))};return {text:JSON.stringify(withIdentityDecisions(result,req.user)),meta:{provider:'http',model:'mock',durationMs:0}}}}
  assert.deepEqual(await service.analyze('group-a',()=>provider),{ok:true,count:1,analyzedCount:20})
  assert.deepEqual(await service.analyze('group-a',()=>provider),{ok:true,count:1,analyzedCount:10})
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

test('new runs analyze only pending messages, preserve stable topics and prior evidence, and checkpoint no-topic decisions', async () => {
  const db=dbFixture(); const service=createGroupTopicsService(db); service.enable('group-a',true)
  const first={topics:[{ref:'orion',title:'Project Orion',summary:'Project Orion planning.'}],assignments:[
    {msgId:'a1',topicRef:'orion',relation:'about',confidence:.8,relevance:'unknown',relevanceEvidenceMsgIds:[]},
    {msgId:'a2',topicRef:null,relation:'uncertain',confidence:.2,relevance:'unknown',relevanceEvidenceMsgIds:[]}
  ]}
  let received=[]; let calls=0
  const firstProvider=fakeProvider(first,(req)=>{calls++;received.push(JSON.parse(req.user))})
  assert.deepEqual(await service.analyze('group-a',()=>firstProvider),{ok:true,count:1,analyzedCount:2})
  assert.equal(service.pendingCount('group-a'),0)
  assert.deepEqual(await service.analyze('group-a',()=>firstProvider),{ok:true,count:1,analyzedCount:0})
  assert.equal(calls,1)
  db.prepare(`INSERT INTO messages(msg_id,chat_id,ts,time_iso,direction,sender,text,content_type,processed,ingested_at)
    VALUES('a3','group-a',3,'2026-09-30T00:00:03Z','in','同名','More Project Orion planning',0,0,'2026-09-30')`).run()
  const next={topics:[{ref:'orion',title:'Project Orion',summary:'Project Orion planning continues.'}],assignments:[
    {msgId:'a3',topicRef:'orion',relation:'about',confidence:.8,relevance:'unknown',relevanceEvidenceMsgIds:[]}
  ]}
  const secondProvider=fakeProvider(next,(req)=>{calls++;received.push(JSON.parse(req.user))})
  assert.equal(service.pendingCount('group-a'),1)
  assert.deepEqual(await service.analyze('group-a',()=>secondProvider),{ok:true,count:1,analyzedCount:1})
  assert.deepEqual(received[1].messages.map((m)=>m.msgId),['a3'])
  assert.equal(received[1].existingLocalTopics.some((t)=>t.ref==='orion'),true)
  const rows=db.prepare(`SELECT t.topic_id,t.local_ref,e.msg_id FROM discussion_topics t JOIN topic_evidence e ON e.topic_id=t.topic_id WHERE t.chat_id='group-a' ORDER BY e.msg_id`).all()
  assert.deepEqual(rows.map((r)=>[r.local_ref,r.msg_id]),[['orion','a1'],['orion','a3']])
  assert.equal(new Set(rows.map((r)=>r.topic_id)).size,1)
  assert.equal(db.prepare("SELECT disposition FROM topic_message_decisions WHERE msg_id='a2'").get().disposition,'not_topic')
  await service.analyze('group-a',()=>secondProvider)
  assert.equal(calls,2)
  db.close()
})

test('failed pending batch remains retryable and same-chat concurrent calls share one provider run', async () => {
  const db=dbFixture(); const service=createGroupTopicsService(db); service.enable('group-a',true)
  const invalid=fakeProvider({topics:[],assignments:[]})
  assert.deepEqual(await service.analyze('group-a',()=>invalid),{ok:false,reason:'analysis_failed',failure:{stage:'domain_validate',path:'$.assignments',code:'missing_assignment'}})
  assert.equal(service.pendingCount('group-a'),2)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM topic_message_decisions').get().n,0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM topic_message_checkpoints').get().n,0)
  let release
  let calls=0
  const valid={topics:[{ref:'orion',title:'Project Orion',summary:'Planning.'}],assignments:[
    {msgId:'a1',topicRef:'orion',relation:'about',confidence:.8,relevance:'unknown',relevanceEvidenceMsgIds:[]},
    {msgId:'a2',topicRef:'orion',relation:'about',confidence:.8,relevance:'unknown',relevanceEvidenceMsgIds:[]}
  ]}
  const provider={complete:(req)=>{calls++;return new Promise((resolve)=>{release=(response)=>resolve({...response,text:JSON.stringify(withIdentityDecisions(valid,req.user))})})}}
  const first=service.analyze('group-a',()=>provider)
  const second=service.analyze('group-a',()=>provider)
  await new Promise((resolve)=>setImmediate(resolve))
  assert.equal(calls,1)
  release({meta:{provider:'fake',model:'fake',durationMs:0}})
  assert.equal((await first).ok,true)
  assert.equal((await second).analyzedCount,0)
  assert.equal(calls,1)
  assert.equal(service.pendingCount('group-a'),0)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM topic_message_decisions WHERE chat_id='group-a'").get().n,2)
  db.close()
})

test('late arrival at the baseline timestamp is pending regardless of its smaller message id', async () => {
  const db=dbFixture(); const service=createGroupTopicsService(db); service.enable('group-a',true)
  const baseline={topics:[{ref:'orion',title:'Project Orion',summary:'Planning.'}],assignments:[
    {msgId:'a1',topicRef:'orion',relation:'about',confidence:.8,relevance:'unknown',relevanceEvidenceMsgIds:[]},
    {msgId:'a2',topicRef:'orion',relation:'about',confidence:.8,relevance:'unknown',relevanceEvidenceMsgIds:[]}
  ]}
  await service.analyze('group-a',()=>fakeProvider(baseline))
  const checkpoint=db.prepare("SELECT baseline_ts,baseline_msg_id FROM topic_message_checkpoints WHERE chat_id='group-a'").get()
  assert.equal(checkpoint.baseline_ts,1); assert.equal(checkpoint.baseline_msg_id,'a1')
  db.prepare(`INSERT INTO messages(msg_id,chat_id,ts,time_iso,direction,sender,text,content_type,processed,ingested_at)
    VALUES('0-late','group-a',1,'2026-09-30T00:00:01Z','in','sender','Late Orion planning update',0,0,'2026-09-30')`).run()
  assert.equal(service.pendingCount('group-a'),1)
  let received=[]
  const followup={topics:[{ref:'orion',title:'Project Orion',summary:'Planning continues.'}],assignments:[
    {msgId:'0-late',topicRef:'orion',relation:'about',confidence:.8,relevance:'unknown',relevanceEvidenceMsgIds:[]}
  ]}
  const result=await service.analyze('group-a',()=>fakeProvider(followup,(req)=>{received=JSON.parse(req.user).messages.map((m)=>m.msgId)}))
  assert.deepEqual(result,{ok:true,count:1,analyzedCount:1})
  assert.deepEqual(received,['0-late'])
  assert.equal(service.pendingCount('group-a'),0)
  db.close()
})

test('disable during provider wait prevents commit and preserves pending messages', async () => {
  for (const mode of ['disabled']) {
    const db=dbFixture(); const service=createGroupTopicsService(db); service.enable('group-a',true)
    let enteredResolve
    const entered=new Promise((resolve)=>{enteredResolve=resolve})
    let responseResolve
    const response=new Promise((resolve)=>{responseResolve=resolve})
    let calls=0
    const provider={complete:(req)=>{calls++;enteredResolve();return response.then((value)=>({...value,text:JSON.stringify(withIdentityDecisions(analysisA,req.user))}))}}
    const pending=service.analyze('group-a',()=>provider)
    await entered
    service.enable('group-a',false)
    responseResolve({meta:{provider:'fake',model:'fake',durationMs:0}})
    assert.deepEqual(await pending,{ok:false,reason:'disabled'})
    assert.equal(calls,1)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM discussion_topics').get().n,0)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM topic_evidence').get().n,0)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM topic_message_decisions').get().n,0)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM topic_message_checkpoints').get().n,0)
    assert.equal(db.prepare("SELECT COUNT(*) n FROM topic_analysis_runs WHERE state='complete'").get().n,0)
    service.enable('group-a',true)
    assert.equal(service.pendingCount('group-a'),2)
    db.close()
  }
})

test('pending selection is capped to the latest 100 eligible messages', () => {
  const db=dbFixture();
  const insert=db.prepare(`INSERT INTO messages(msg_id,chat_id,ts,time_iso,direction,sender,text,content_type,processed,ingested_at)
    VALUES(?, 'group-a', ?, '2026-09-30T00:00:00Z','in','sender','pending body',0,0,'2026-09-30')`)
  for(let i=0;i<150;i++) insert.run(`pending-${i}`,100+i)
  assert.equal(countPendingMessages(db,'group-a'),101)
  db.close()
})

test('more than 100 arrivals drain in bounded 20-message batches without skipping pending messages', async () => {
  const db=dbFixture(); let service=createGroupTopicsService(db); service.enable('group-a',true)
  const seed={topics:[{ref:'orion',title:'Project Orion',summary:'Planning.'}],assignments:[
    {msgId:'a1',topicRef:'orion',relation:'about',confidence:.8,relevance:'unknown',relevanceEvidenceMsgIds:[]},
    {msgId:'a2',topicRef:'orion',relation:'about',confidence:.8,relevance:'unknown',relevanceEvidenceMsgIds:[]}
  ]}
  await service.analyze('group-a',()=>fakeProvider(seed))
  const insert=db.prepare(`INSERT INTO messages(msg_id,chat_id,ts,time_iso,direction,sender,text,content_type,processed,ingested_at)
    VALUES(?, 'group-a', 10, '2026-09-30T00:00:10Z','in','sender','Project Orion update',0,0,'2026-09-30')`)
  for(let i=0;i<250;i++) insert.run(`new-${String(i).padStart(3,'0')}`)
  const drain = async () => {
    let sent=[]
    const provider=fakeProvider(null,(req)=>{sent=JSON.parse(req.user).messages})
    provider.complete=async(req)=>{
      sent=JSON.parse(req.user).messages
      const result={topics:[{ref:'orion',title:'Project Orion',summary:'Planning continues.'}],assignments:sent.map((m)=>({msgId:m.msgId,topicRef:'orion',relation:'about',confidence:.8,relevance:'unknown',relevanceEvidenceMsgIds:[]}))}
      return {text:JSON.stringify(withIdentityDecisions(result,req.user)),meta:{provider:'fake',model:'fake',durationMs:0}}
    }
    const result=await service.analyze('group-a',()=>provider)
    return {result,sent}
  }
  assert.equal(service.pendingCount('group-a'),101)
  let remaining=250
  while(remaining>0){
    service=createGroupTopicsService(db)
    const batch=await drain()
    assert.equal(batch.sent.length,Math.min(20,remaining))
    assert.equal(batch.sent.length<=20,true)
    remaining-=batch.sent.length
    assert.equal(service.pendingCount('group-a'),remaining===0?0:Math.min(101,remaining))
  }
  const ids=db.prepare("SELECT msg_id FROM topic_message_decisions WHERE chat_id='group-a'").all().map((r)=>r.msg_id)
  assert.equal(ids.length,252)
  assert.equal(new Set(ids).size,252)
  const topicIds=db.prepare("SELECT DISTINCT e.topic_id FROM topic_evidence e JOIN messages m ON m.msg_id=e.msg_id WHERE m.chat_id='group-a'").all()
  assert.equal(topicIds.length,1)
  assert.equal(db.prepare("SELECT evidence_count FROM (SELECT COUNT(*) AS evidence_count FROM topic_evidence WHERE topic_id=?)").get(topicIds[0].topic_id).evidence_count,252)
  db.close()
})

test('file-backed SQLite close and reopen preserves topics, decisions, checkpoint, and provider idempotence', async () => {
  const dir=mkdtempSync(join(tmpdir(),'line-todo-topics-reopen-'))
  const filename=join(dir,'topics.sqlite')
  let db
  try {
    db=dbFixture(filename); let service=createGroupTopicsService(db); service.enable('group-a',true)
    assert.deepEqual(await service.analyze('group-a',()=>fakeProvider(analysisA)),{ok:true,count:2,analyzedCount:2})
    const originalTopic=db.prepare("SELECT topic_id FROM discussion_topics WHERE chat_id='group-a' AND local_ref='launch'").get().topic_id
    const originalDecisions=db.prepare("SELECT msg_id,disposition FROM topic_message_decisions WHERE chat_id='group-a' ORDER BY msg_id").all().map(({msg_id,disposition})=>({msg_id,disposition}))
    const checkpoint=db.prepare("SELECT baseline_ts,baseline_msg_id FROM topic_message_checkpoints WHERE chat_id='group-a'").get()
    const originalCheckpoint={baseline_ts:checkpoint.baseline_ts,baseline_msg_id:checkpoint.baseline_msg_id}
    db.close()

    db=new NativeDatabase(filename); db.pragma('foreign_keys=ON'); service=createGroupTopicsService(db)
    db.prepare(`INSERT INTO messages(msg_id,chat_id,ts,time_iso,direction,sender,text,content_type,processed,ingested_at)
      VALUES('a3','group-a',3,'2026-09-30T00:00:03Z','in','sender','More Orion launch planning',0,0,'2026-09-30')`).run()
    const followup={topics:[{ref:'launch',title:'Project Orion launch meeting',summary:'Project Orion launch planning continues.'}],assignments:[
      {msgId:'a3',topicRef:'launch',relation:'about',confidence:.8,relevance:'unknown',relevanceEvidenceMsgIds:[]}
    ]}
    let calls=0; let sent=[]
    const provider=fakeProvider(followup,(req)=>{calls++;sent=JSON.parse(req.user).messages.map((m)=>m.msgId)})
    assert.equal(service.pendingCount('group-a'),1)
    assert.deepEqual(await service.analyze('group-a',()=>provider),{ok:true,count:2,analyzedCount:1})
    assert.deepEqual(sent,['a3']); assert.equal(calls,1)
    assert.equal(db.prepare("SELECT topic_id FROM discussion_topics WHERE chat_id='group-a' AND local_ref='launch'").get().topic_id,originalTopic)
    assert.deepEqual(db.prepare("SELECT msg_id,disposition FROM topic_message_decisions WHERE chat_id='group-a' ORDER BY msg_id").all().map(({msg_id,disposition})=>({msg_id,disposition})),[
      ...originalDecisions,{msg_id:'a3',disposition:'assigned'}
    ])
    const checkpointAfter=db.prepare("SELECT baseline_ts,baseline_msg_id FROM topic_message_checkpoints WHERE chat_id='group-a'").get()
    assert.deepEqual({baseline_ts:checkpointAfter.baseline_ts,baseline_msg_id:checkpointAfter.baseline_msg_id},originalCheckpoint)
    db.close()

    db=new NativeDatabase(filename); db.pragma('foreign_keys=ON'); service=createGroupTopicsService(db)
    let replayCalls=0
    assert.deepEqual(await service.analyze('group-a',()=>{replayCalls++;return provider}),{ok:true,count:2,analyzedCount:0})
    assert.equal(replayCalls,0); assert.equal(calls,1)
    assert.equal(service.pendingCount('group-a'),0)
    assert.equal(db.prepare("SELECT COUNT(*) n FROM topic_message_decisions WHERE chat_id='group-a'").get().n,3)
    assert.equal(db.prepare("SELECT topic_id FROM discussion_topics WHERE chat_id='group-a' AND local_ref='launch'").get().topic_id,originalTopic)
    db.close()
  } finally {
    if (db?.open) db.close()
    rmSync(dir,{recursive:true,force:true})
  }
})

test('renderer overview requests every group and keeps disabled and failed groups distinct', async () => {
  const calls = []
  const topic = { topicId: 'topic-a', chatId: 'group-a', title: '群甲議題', summary: '測試摘要。', evidenceCount: 1, evidenceMsgIds: [] }
  const overview = await loadGroupTopicsOverview([
    { chatId: 'group-a', name: '群甲' },
    { chatId: 'group-b', name: '群乙' },
    { chatId: 'group-c', name: '群丙' }
  ], async (chatId) => {
    calls.push(chatId)
    if (chatId === 'group-a') return { ok: true, topics: [topic] }
    if (chatId === 'group-b') return { ok: false, topics: [] }
    throw new Error('synthetic query failure')
  })

  assert.deepEqual(calls, ['group-a', 'group-b', 'group-c'])
  assert.deepEqual(overview.map(({ chat, status, topics, error }) => ({ chatId: chat.chatId, status, topics: topics.length, error })), [
    { chatId: 'group-a', status: 'enabled', topics: 1, error: undefined },
    { chatId: 'group-b', status: 'disabled', topics: 0, error: undefined },
    { chatId: 'group-c', status: 'failed', topics: 0, error: 'synthetic query failure' }
  ])
})

test('Phase 0: loadPendingMessages new options default to the previous behaviour and filter as documented', () => {
  const db=dbFixture()
  const insert=db.prepare(`INSERT INTO messages(msg_id,chat_id,ts,time_iso,direction,sender,text,content_type,processed,unsent,ingested_at)
    VALUES(?, 'group-a', ?, '2026-09-30T00:00:00Z','in','sender',?,?,?,?,'2026-09-30')`)
  insert.run('p-done',10,'processed body',0,1,0)
  insert.run('p-new',11,'fresh body',0,0,0)
  insert.run('p-unsent',12,'unsent body',0,0,1)
  insert.run('p-media',13,null,1,0,0)
  insert.run('p-blank',14,'   ',0,0,0)
  const ids=(rows)=>rows.map((m)=>m.msgId)
  const base=ids(loadPendingMessages(db,'group-a'))
  assert.deepEqual(base,['a1','a2','p-done','p-new'])
  assert.deepEqual(ids(loadPendingMessages(db,'group-a',100,100,{})),base)
  assert.deepEqual(ids(loadPendingMessages(db,'group-a',100,100,{processedFilter:'any'})),base)
  assert.deepEqual(ids(loadPendingMessages(db,'group-a',100,100,{processedFilter:'unprocessed'})),['a1','a2','p-new'])
  assert.deepEqual(ids(loadPendingMessages(db,'group-a',100,100,{processedFilter:'processed'})),['p-done'])
  assert.deepEqual(ids(loadPendingMessages(db,'group-a',100,100,{restrictToMsgIds:['p-new','a2','p-unsent','p-media','nope']})),['a2','p-new'])
  assert.deepEqual(ids(loadPendingMessages(db,'group-a',100,100,{restrictToMsgIds:[]})),[])
  assert.deepEqual(ids(loadPendingMessages(db,'group-a',100,100,{restrictToMsgIds:['a1','a2','p-done'],processedFilter:'unprocessed'})),['a1','a2'])
  db.close()
})

test('Phase 0: selectTopicTargets applies the same eligibility rules as loadPendingMessages (text only, undecided, checkpoint)', async () => {
  const db=dbFixture(); const service=createGroupTopicsService(db); service.enable('group-a',true)
  const insert=db.prepare(`INSERT INTO messages(msg_id,chat_id,ts,time_iso,direction,sender,text,content_type,processed,unsent,ingested_at)
    VALUES(?, 'group-a', ?, '2026-09-30T00:00:00Z','in','sender',?,?,0,?,'2026-09-30')`)
  insert.run('t-unsent',20,'unsent body',0,1)
  insert.run('t-media',21,null,1,0)
  insert.run('t-text',22,'real text',0,0)
  assert.deepEqual(selectTopicTargets(db,'group-a',[]),[])
  assert.deepEqual(selectTopicTargets(db,'group-a',['t-text','a1','t-unsent','t-media','b1','missing']),['a1','t-text'])
  const first={topics:[],assignments:[
    {msgId:'a1',topicRef:null,relation:'uncertain',confidence:.1,relevance:'unknown',relevanceEvidenceMsgIds:[]},
    {msgId:'a2',topicRef:null,relation:'uncertain',confidence:.1,relevance:'unknown',relevanceEvidenceMsgIds:[]},
    {msgId:'t-text',topicRef:null,relation:'uncertain',confidence:.1,relevance:'unknown',relevanceEvidenceMsgIds:[]}
  ]}
  assert.deepEqual(await service.analyze('group-a',()=>fakeProvider(first)),{ok:true,count:0,analyzedCount:3})
  assert.deepEqual(selectTopicTargets(db,'group-a',['a1','a2','t-text']),[], 'decided messages are no longer targets')
  insert.run('t-late',30,'later text',0,0)
  insert.run('t-old',0,'older than the checkpoint',0,0)
  assert.deepEqual(selectTopicTargets(db,'group-a',['t-late','t-old','a1']),['t-late'])
  assert.deepEqual(loadPendingMessages(db,'group-a').map((m)=>m.msgId),['t-late'])
  db.close()
})

test('Phase 0: buildTopicSave().tx() writes exactly what saveAnalysis writes', () => {
  const versions={promptVersion:'v',promptHash:'h',schemaVersion:'s',schemaHash:'sh',validatorVersion:GROUP_TOPICS_VALIDATOR_VERSION}
  const dump=(db)=>JSON.stringify([
    db.prepare('SELECT chat_id,local_ref,title,summary FROM discussion_topics ORDER BY local_ref').all(),
    db.prepare('SELECT msg_id,relation,relevance FROM topic_evidence ORDER BY msg_id').all(),
    db.prepare('SELECT msg_id,disposition FROM topic_message_decisions ORDER BY msg_id').all(),
    db.prepare('SELECT baseline_msg_id FROM topic_message_checkpoints').all()
  ])
  const run=(mode)=>{
    const db=dbFixture(); createGroupTopicsService(db).enable('group-a',true)
    const input=loadMessages(db,'group-a')
    if(mode==='save') assert.equal(saveAnalysis(db,'group-a',input,analysisA,versions),true)
    else {
      const built=buildTopicSave(db,'group-a',input,analysisA,versions)
      assert.deepEqual(built.selectedRows,[])
      assert.equal(built.tx(),true)
      assert.equal(built.tx(),false, 'a second run of the same input is already complete')
    }
    const out=dump(db); db.close(); return out
  }
  assert.equal(run('build'),run('save'))
})

test('Phase 2: the generated v5/v4 bundle exports and topic schema are enabled', () => {
  assert.equal(GROUP_TOPICS_BUNDLE_ENABLED, true)
  assert.equal(GROUP_TOPICS_PROMPT_VERSION, 'group-topics-v5')
  assert.equal(GROUP_TOPICS_SCHEMA_VERSION, 'topic-output-v4')
  assert.match(GROUP_TOPICS_PROMPT_HASH, /^[a-f0-9]{64}$/)
  assert.match(GROUP_TOPICS_SCHEMA_HASH, /^[a-f0-9]{64}$/)
  assert.equal(GROUP_TOPICS_JSON_SCHEMA.properties.topics.items.properties.summary.maxLength, 2000)
})

test('Phase 2: the combined bundle has its own versions and tracked hashes distinct from the topic bundle', () => {
  assert.equal(COMBINED_BUNDLE_ENABLED, true)
  assert.equal(COMBINED_PROMPT_VERSION, 'extract-combined-v2')
  assert.equal(COMBINED_SCHEMA_VERSION, 'extract-combined-schema-v2')
  assert.match(COMBINED_PROMPT_HASH, /^[a-f0-9]{64}$/)
  assert.match(COMBINED_SCHEMA_HASH, /^[a-f0-9]{64}$/)
  for (const hash of [COMBINED_PROMPT_HASH, COMBINED_SCHEMA_HASH]) assert.ok(![GROUP_TOPICS_PROMPT_HASH, GROUP_TOPICS_SCHEMA_HASH].includes(hash))
  assert.ok(COMBINED_TOPIC_SECTION.length > 0)
  assert.equal(COMBINED_JSON_SCHEMA.additionalProperties, false)
  assert.deepEqual(COMBINED_JSON_SCHEMA.required, ['todo', 'topic'])
})

test('Phase 0: selectTopicTargets does not filter on messages.processed (processed=1 undecided messages are valid targets)', () => {
  const db=dbFixture(); createGroupTopicsService(db).enable('group-a',true)
  const insert=db.prepare(`INSERT INTO messages(msg_id,chat_id,ts,time_iso,direction,sender,text,content_type,processed,unsent,ingested_at)
    VALUES(?, 'group-a', ?, '2026-09-30T00:00:00Z','in','sender',?,0,?,0,'2026-09-30')`)
  insert.run('s-done',40,'already processed by the todo pipeline',1)
  insert.run('s-new',41,'not yet processed',0)
  assert.deepEqual(selectTopicTargets(db,'group-a',['s-done','s-new']),['s-done','s-new'])
  assert.deepEqual(selectTopicTargets(db,'group-a',['s-done']),['s-done'])
  assert.deepEqual(loadPendingMessages(db,'group-a',100,100,{processedFilter:'processed'}).map((m)=>m.msgId).filter((id)=>id.startsWith('s-')),['s-done'])
  db.close()
})

function seedHeavyGroup(db, chatId, name, { topics = 30, summaryChars = 300, evidence = 8, tsBase = 1_766_000_000_000 } = {}) {
  db.pragma('foreign_keys=OFF')
  db.prepare("INSERT OR IGNORE INTO chats(chat_id,name,is_group,blocked,first_seen_at,last_seen_at) VALUES(?,?,1,0,'2026-09-30','2026-09-30')").run(chatId, name)
  const insertTopic = db.prepare('INSERT INTO discussion_topics(topic_id,chat_id,local_ref,title,summary,created_at,last_source_ts) VALUES(?,?,?,?,?,?,?)')
  const insertMsg = db.prepare("INSERT INTO messages(msg_id,chat_id,ts,time_iso,direction,sender,text,content_type,processed,ingested_at) VALUES(?,?,?,?,'in','x','t',0,1,'2026-09-30')")
  const insertEvidence = db.prepare("INSERT INTO topic_evidence(topic_id,msg_id,relation,confidence,relevance,relevance_evidence_msg_ids,run_id) VALUES(?,?,'about',0.9,'action',?,'heavy-run')")
  for (let t = 0; t < topics; t += 1) {
    const topicId = 'topic-' + chatId + '-' + String(t).padStart(3, '0') + '-' + 'x'.repeat(24)
    insertTopic.run(topicId, chatId, 'ref-' + t, '議'.repeat(25), '摘'.repeat(summaryChars), '2026-09-30', tsBase + t)
    const ids = Array.from({ length: evidence }, (_, k) => chatId + '-m' + String(t).padStart(3, '0') + String(k) + '1'.repeat(14))
    for (const id of ids) { insertMsg.run(id, chatId, tsBase + t, '2026-09-30T00:00:00Z'); insertEvidence.run(topicId, id, JSON.stringify(ids)) }
  }
}

const OVERVIEW_BYTE_CEILING = 56 * 1024

test('overview stays under the dispatcher response budget at realistic volume (many groups x 30 topics x 300-char summaries x 8 evidence ids) and says what was trimmed', () => {
  const db = dbFixture()
  const service = createGroupTopicsService(db)
  const names = ['群丙', '群丁', '群戊', '群己', '群庚']
  names.forEach((name, i) => { seedHeavyGroup(db, 'heavy-' + i, name, { tsBase: 1_766_000_000_000 + i * 1000 }); service.enable('heavy-' + i, true) })
  const rows = service.overview()
  const bytes = Buffer.byteLength(JSON.stringify(rows))
  assert.ok(bytes <= GROUP_TOPICS_OVERVIEW_BYTE_LIMIT, 'serialized overview ' + bytes + ' B must be <= ' + GROUP_TOPICS_OVERVIEW_BYTE_LIMIT)
  assert.ok(GROUP_TOPICS_OVERVIEW_BYTE_LIMIT < OVERVIEW_BYTE_CEILING, 'the limit sits below the dispatcher budget (64 KiB - 8 KiB)')
  const heavy = rows.filter((row) => row.chatId.startsWith('heavy-'))
  assert.equal(heavy.length, 5, 'every group stays listed even when its topics are trimmed')
  for (const row of heavy) {
    assert.equal(row.topicCount, 30, 'the true topic total is reported so the UI can say how many were left out')
    assert.ok(row.topics.length <= 30)
    for (const topic of row.topics) assert.ok(topic.evidenceCount === 8, 'evidenceCount keeps the true count')
  }
  const total = heavy.reduce((n, row) => n + row.topics.length, 0)
  assert.ok(total < 150, 'something had to be trimmed at this volume')
  assert.ok(heavy.some((row) => row.compacted === true), 'compaction is flagged')
  const kept = heavy.flatMap((row) => row.topics.map((topic) => topic.lastSourceTs))
  const dropped = heavy.reduce((n, row) => n + (row.topicCount - row.topics.length), 0)
  assert.ok(dropped > 0 || heavy.every((row) => row.compacted))
  if (dropped > 0) {
    const newestDropped = Math.max(...heavy.flatMap((row) => service.list(row.chatId).topics.filter((t) => !row.topics.some((k) => k.topicId === t.topicId)).map((t) => t.lastSourceTs)))
    assert.ok(newestDropped <= Math.min(...kept), 'only the oldest topics are dropped')
  }
  assert.equal(service.list('heavy-0').topics[0].summary.length, 300, 'the single-group detail is never trimmed')
  assert.equal(service.list('heavy-0').topics[0].evidenceMsgIds.length, 8)
  db.close()
})

test('overview probe from review: 2 groups x 30 topics x 300-char summaries is within the limit', () => {
  const db = dbFixture()
  const service = createGroupTopicsService(db)
  for (const [i, name] of ['群丙', '群丁'].entries()) { seedHeavyGroup(db, 'probe-' + i, name, { evidence: 8 }); service.enable('probe-' + i, true) }
  const bytes = Buffer.byteLength(JSON.stringify(service.overview()))
  assert.ok(bytes <= GROUP_TOPICS_OVERVIEW_BYTE_LIMIT, 'serialized overview ' + bytes + ' B')
  db.close()
})

test('overview that already fits is returned untouched (no compaction flag, full evidence)', () => {
  const db = dbFixture()
  const service = createGroupTopicsService(db)
  seedHeavyGroup(db, 'small', '小群', { topics: 3, summaryChars: 40, evidence: 2 }); service.enable('small', true)
  const row = service.overview().find((r) => r.chatId === 'small')
  assert.equal(row.compacted, undefined)
  assert.equal(row.topics.length, 3)
  assert.deepEqual(row.topics, service.list('small').topics)
  db.close()
})

test('overview aggregates every group in one read: enabled flag, capped recent topics, pending counts; disabled groups carry no topics; direct chats are left out', async () => {
  const db = dbFixture()
  const service = createGroupTopicsService(db)
  assert.deepEqual(service.overview().map((row) => [row.chatId, row.enabled, row.topics.length, row.pendingCount, row.backlogCount]).sort(), [['group-a', true, 0, 2, 2], ['group-b', true, 0, 1, 1]])
  service.enable('group-a', true)
  const before = service.overview().find((row) => row.chatId === 'group-a')
  assert.equal(before.enabled, true)
  assert.equal(before.pendingCount, 2, 'two undecided messages are pending')
  assert.equal(before.backlogCount, before.pendingCount, 'phase 1: the backlog equals the pending count')
  await service.analyze('group-a', () => fakeProvider(analysisA))
  const rows = service.overview()
  const a = rows.find((row) => row.chatId === 'group-a')
  assert.deepEqual(a.topics, service.list('group-a').topics, 'the aggregate carries exactly what list returns for the group')
  assert.equal(a.pendingCount, 0)
  assert.equal(rows.find((row) => row.chatId === 'group-b').topics.length, 0)
  assert.equal(rows.some((row) => row.chatId === 'dm'), false)
  assert.ok(JSON.stringify(rows).length < 64 * 1024, 'the aggregate stays well under the 64 KiB response budget')
  const insertTopic = db.prepare('INSERT INTO discussion_topics(topic_id,chat_id,local_ref,title,summary,created_at,last_source_ts) VALUES(?,?,?,?,?,?,?)')
  for (let i = 0; i < 40; i += 1) insertTopic.run('bulk-' + i, 'group-b', 'ref-' + i, '大量議題' + i, '摘要', '2026-09-30', 100 + i)
  service.enable('group-b', true)
  const capped = service.overview().find((row) => row.chatId === 'group-b')
  assert.equal(capped.topics.length, GROUP_TOPICS_OVERVIEW_TOPIC_LIMIT, 'at most N recent topics per group')
  assert.equal(capped.topics[0].title, '大量議題39', 'newest first, same order as list')
  assert.equal(service.list('group-b').topics.length, 40, 'single-group list is not capped by the overview limit')
  db.close()
})

// ───────────── 群組議題列表（topicRows）：列的組成、篩選、排序、時間格式 ─────────────

const listTopic = (topicId, chatId, title, lastSourceTs, summary = '摘要') => ({ topicId, chatId, title, summary, lastSourceTs, evidenceCount: 1, evidenceMsgIds: [] })

test('topic list rows: only enabled groups contribute rows, one row per topic, unnamed groups get a fallback name', () => {
  const rows = buildTopicRows([
    { chat: { chatId: 'g1', name: 'Alpha' }, status: 'enabled', topics: [listTopic('t1', 'g1', 'a1', 100), listTopic('t2', 'g1', 'a2', 200)] },
    { chat: { chatId: 'g2', name: 'Beta' }, status: 'enabled', topics: [] },
    { chat: { chatId: 'g3', name: null }, status: 'disabled', topics: [] },
    { chat: { chatId: 'g4', name: 'Delta' }, status: 'failed', topics: [], error: 'synthetic' },
    { chat: { chatId: 'g5', name: null }, status: 'enabled', topics: [listTopic('t5', 'g5', 'e1', 50)] }
  ])
  assert.deepEqual(rows.map((row) => [row.chatName, row.topic.title]), [['Alpha', 'a1'], ['Alpha', 'a2'], ['未命名群組', 'e1']])
  assert.equal(new Set(rows.map((row) => row.key)).size, 3, 'row keys are unique')
})

test('topic list rows preserve a clear overview-compacted marker for each shortened note', () => {
  const [row] = buildTopicRows([{ chat:{chatId:'g1',name:'Alpha'},status:'enabled',compacted:true,topics:[listTopic('t1','g1','planning',300)] }])
  assert.equal(row.overviewCompacted,true)
})

test('overview whole-topic budget omission reaches a visible group/count notice when short notes cannot compact', () => {
  const topic = (groupIndex, index) => ({
    topicId: `t-${groupIndex}-${index}`, chatId: `g-${groupIndex}`, localRef: `r-${index}`, title: '短標題', summary: '短摘要',
    createdAt: '2026-09-30', lastSourceTs: groupIndex * 1000 + index, evidenceCount: 2,
    evidenceMsgIds: ['m-a', 'm-b'], relevance: 'action', relevanceEvidenceMsgIds: ['m-a'], relevanceEvidence: [],
    userParticipation: 'unknown', participantLowerBound: 0, observation: 'unknown', heat: 'unvalidated', trend: 'unknown'
  })
  const source = Array.from({ length: 120 }, (_, groupIndex) => ({
    chatId: `g-${groupIndex}`, name: `群 ${groupIndex}`, enabled: true,
    topics: Array.from({ length: 30 }, (_, index) => topic(groupIndex, index)), topicCount: 30,
    pendingCount: 0, backlogCount: 0
  }))
  const fitted = fitOverviewToBudget(source, GROUP_TOPICS_OVERVIEW_BYTE_LIMIT)
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= GROUP_TOPICS_OVERVIEW_BYTE_LIMIT)
  assert.ok(fitted.some((group) => group.topics.length === 0 && group.topicCount === 30), 'at least one group loses all its topics')
  assert.ok(fitted.some((group) => group.topics.length < group.topicCount && group.compacted === true), 'whole-topic omission is marked even though short fields did not compact')
  const entries = overviewToEntries(fitted)
  const notice = overviewOmissionNotice(entries)
  assert.match(notice, /省略 \d+ 則議題/)
  assert.match(notice, /涉及 \d+ 個群組/)
  assert.match(notice, /開啟單群議題可閱讀完整紀錄/)

  const groupOverflow = fitOverviewToBudget(Array.from({ length: 600 }, (_, index) => ({
    chatId: `empty-${index}`, name: `群 ${index}`, enabled: false, topics: [], topicCount: 0, pendingCount: 0, backlogCount: 0
  })), GROUP_TOPICS_OVERVIEW_BYTE_LIMIT)
  assert.ok(Buffer.byteLength(JSON.stringify(groupOverflow)) <= GROUP_TOPICS_OVERVIEW_BYTE_LIMIT)
  assert.ok(groupOverflow[0].omittedGroupCount > 0, 'whole-group removal is carried in a surviving row')
  assert.match(overviewOmissionNotice(overviewToEntries(groupOverflow)), /群組整筆省略/)
})

const listRows = () => buildTopicRows([
  { chat: { chatId: 'g-beta', name: 'Beta' }, status: 'enabled', topics: [listTopic('r1', 'g-beta', 'c-task', 300)] },
  { chat: { chatId: 'g-alpha', name: 'Alpha' }, status: 'enabled', topics: [listTopic('r2', 'g-alpha', 'a-task', 100), listTopic('r3', 'g-alpha', 'b-task', 400)] },
  { chat: { chatId: 'g-gamma', name: 'Gamma' }, status: 'enabled', topics: [listTopic('r4', 'g-gamma', 'd-task', 200, '本週預算審核')] }
])
const order = (rows) => rows.map((row) => row.topic.topicId)

test('topic list sort: 最後更新 newest first by default and both directions work; text ties fall back to newest first', () => {
  const rows = listRows()
  assert.deepEqual(order(sortTopicRows(rows, 'updated', 'desc')), ['r3', 'r1', 'r4', 'r2'])
  assert.deepEqual(order(sortTopicRows(rows, 'updated', 'asc')), ['r2', 'r4', 'r1', 'r3'])
  assert.deepEqual(order(sortTopicRows(rows, 'title', 'asc')), ['r2', 'r3', 'r1', 'r4'])
  assert.deepEqual(order(sortTopicRows(rows, 'title', 'desc')), ['r4', 'r1', 'r3', 'r2'])
  assert.deepEqual(order(sortTopicRows(rows, 'chat', 'asc')), ['r3', 'r2', 'r1', 'r4'], 'Alpha (newest first inside the tie), Beta, Gamma')
  assert.deepEqual(order(sortTopicRows(rows, 'chat', 'desc')), ['r4', 'r1', 'r3', 'r2'], 'the tie keeps newest first in descending order too')
  assert.deepEqual(order(rows), ['r1', 'r2', 'r3', 'r4'], 'sorting does not mutate the input')
})

test('topic list filter: chat filter, case-insensitive keyword over chat name / title / summary, and every keyword must match', () => {
  const rows = listRows()
  assert.deepEqual(order(filterTopicRows(rows, { chatId: null, query: '' })), ['r1', 'r2', 'r3', 'r4'])
  assert.deepEqual(order(filterTopicRows(rows, { chatId: null, query: '   ' })), ['r1', 'r2', 'r3', 'r4'], 'whitespace-only query matches everything')
  assert.deepEqual(order(filterTopicRows(rows, { chatId: 'g-alpha', query: '' })), ['r2', 'r3'], 'chat filter')
  assert.deepEqual(order(filterTopicRows(rows, { chatId: null, query: 'ALPHA' })), ['r2', 'r3'], 'chat name matches, case-insensitive')
  assert.deepEqual(order(filterTopicRows(rows, { chatId: null, query: 'a-TASK' })), ['r2'], 'title matches, case-insensitive')
  assert.deepEqual(order(filterTopicRows(rows, { chatId: null, query: '預算' })), ['r4'], 'summary matches')
  assert.deepEqual(order(filterTopicRows(rows, { chatId: null, query: 'alpha b-task' })), ['r3'], 'two keywords both have to match')
  assert.deepEqual(order(filterTopicRows(rows, { chatId: 'g-alpha', query: 'b-task' })), ['r3'], 'chat filter and keyword combine')
  assert.deepEqual(order(filterTopicRows(rows, { chatId: 'g-beta', query: 'b-task' })), [], 'no match gives an empty list')
})

test('topic list time: MM/DD HH:mm in local time, empty for an invalid timestamp', () => {
  assert.equal(formatTopicTime(new Date(2026, 10, 9, 7, 5).getTime()), '11/09 07:05')
  assert.equal(formatTopicTime(Number.NaN), '')
})

function backgroundCandidates(db) {
  const seen = []
  let scheduled = null
  const background = createTopicBackground({
    db,
    service: { pendingCount: (chatId) => { seen.push(chatId); return 0 }, analyze: async () => ({ ok: false, reason: 'unused' }) },
    resolveProvider: () => null,
    active: () => true,
    setTimer: (fn) => { scheduled = fn; return () => {} },
    config: { startDelayMs: 0 }
  })
  background.start()
  scheduled()
  background.stop()
  return seen
}

test('default-on: a group with no topic row follows its todo switch (on: analyzed and combined); an explicit row 0 closes it', async () => {
  const db = dbFixture()
  ensureChatTodoPrefsSchema(db)
  const service = createGroupTopicsService(db)
  assert.equal(service.list('group-a').ok, true, 'no row and todo on: the topic switch is on')
  assert.equal(service.overview().find((row) => row.chatId === 'group-a').enabled, true)
  assert.equal(createGroupTopicsService(db, { isCombinedActive: () => true }).list('group-a').combined, true, 'the default-on group joins the combined pass')
  let calls = 0
  const provider = fakeProvider(analysisA, () => { calls++ })
  assert.deepEqual(await service.analyze('group-a', () => provider), { ok: true, count: 2, analyzedCount: 2 })
  assert.equal(calls, 1, 'the default-on group is sent to topic extraction')
  db.prepare(`INSERT INTO todos(id,chat_id,bucket,title,source_msg_ids,created_at,updated_at)
    VALUES('todo-a','group-a','todo','群甲既有待辦','["a1"]','now','now')`).run()
  const launch = service.list('group-a').topics.find((topic) => topic.title === 'Project Orion launch meeting')
  assert.deepEqual(service.todoRefs(launch.topicId), [{ todoId: 'todo-a', status: 'pending', bucket: 'todo', matchedMsgIds: ['a1'] }])
  assert.deepEqual(backgroundCandidates(db), [], 'a todo-on group is never a topic-background candidate')
  assert.equal(service.enable('group-a', false).ok, true)
  assert.equal(service.list('group-a').ok, false, 'an explicit row 0 closes the group')
  assert.deepEqual(await service.analyze('group-a', () => { throw new Error('closed group must not resolve a provider') }), { ok: false, reason: 'disabled' })
  db.close()
})

test('default-on: a group with no topic row and its todo switch off stays closed and is not a topic-background candidate', async () => {
  const db = dbFixture()
  ensureChatTodoPrefsSchema(db)
  setTodoExtractEnabled(db, 'group-a', false)
  const service = createGroupTopicsService(db)
  assert.equal(service.list('group-a').ok, false, 'no row and todo off: closed')
  assert.equal(service.overview().find((row) => row.chatId === 'group-a').enabled, false)
  assert.deepEqual(await service.analyze('group-a', () => { throw new Error('closed group must not resolve a provider') }), { ok: false, reason: 'disabled' })
  assert.deepEqual(backgroundCandidates(db), [], 'no row and todo off is not a background candidate')
  db.close()
})

test('default-on: an explicit row decides; row 1 opens a todo-off group as the only background candidate, row 0 closes it', () => {
  const db = dbFixture()
  ensureChatTodoPrefsSchema(db)
  setTodoExtractEnabled(db, 'group-a', false)
  setTodoExtractEnabled(db, 'group-b', false)
  const service = createGroupTopicsService(db)
  assert.equal(service.enable('group-a', true).ok, true)
  assert.equal(service.enable('group-b', false).ok, true)
  assert.equal(service.list('group-a').ok, true, 'row 1 opens the group whatever its todo switch says')
  assert.equal(service.list('group-b').ok, false, 'row 0 closes the group')
  assert.deepEqual(backgroundCandidates(db), ['group-a'], 'only the todo-off group with row 1 is a background candidate')
  db.close()
})

test('default-on: blocked groups and direct chats without a row stay closed; a direct chat with an explicit row is unchanged', async () => {
  const db = dbFixture()
  ensureChatTodoPrefsSchema(db)
  db.prepare("UPDATE chats SET blocked=1 WHERE chat_id='group-b'").run()
  const service = createGroupTopicsService(db)
  assert.equal(service.list('group-b').ok, false, 'blocked group: closed even with no row and todo on')
  assert.deepEqual(await service.analyze('group-b', () => { throw new Error('blocked group must not resolve a provider') }), { ok: false, reason: 'disabled' })
  assert.equal(service.list('dm').ok, false, 'a direct chat without a row stays closed')
  assert.deepEqual(await service.analyze('dm', () => { throw new Error('direct chat must not resolve a provider') }), { ok: false, reason: 'disabled' })
  assert.equal(service.enable('dm', true).ok, true)
  assert.equal(service.list('dm').ok, true, 'a direct chat with an explicit row 1 is opt-in as before')
  db.close()
})
