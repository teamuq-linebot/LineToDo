const { app } = require('electron')
const esbuild = require('esbuild')
const Module = require('node:module')
const path = require('node:path')
const { mkdirSync } = require('node:fs')
const fakeRoot = process.env.LINE_TODO_FAKE_FIXTURE_ROOT
if (!fakeRoot) throw new Error('LINE_TODO_FAKE_FIXTURE_ROOT must point to report-owned fake-fixtures')
mkdirSync(fakeRoot,{recursive:true})
app.setPath('userData',path.join(fakeRoot,'electron-userdata-core'))
app.setPath('sessionData',path.join(fakeRoot,'electron-session-core'))

const source = `
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from './src/main/db/database.ts'
import { migrate } from './src/main/db/migrate.ts'
import { createRepositories } from './src/main/db/repositories.ts'
import { runOnce } from './src/main/pipeline/runOnce.ts'
import { reviewLastDays } from './src/main/pipeline/backfill.ts'
import { buildUserPayload } from './src/main/llm/extractPrompt.ts'
import { EXTRACT_SYSTEM_PROMPT } from './src/main/llm/extractPrompt.ts'
import { createLineTodoApplication } from './src/core/application.ts'
import { EventEmitter } from 'node:events'

async function smoke(){
const root=mkdtempSync(join(tmpdir(),'line-todo-not-mine-fake-'));let opened=null
const active=['pending','waiting_reply','scheduled','suggested_done']
const fixtureMsg=(id,chatId='fake-chat')=>({msgId:id,chatId,chat:'Synthetic',isGroup:true,ts:Date.now(),time:new Date().toISOString(),direction:'in',sender:'Other',text:'Synthetic fixture text',contentType:0})
try {
  const file=join(root,'store.db'); opened=openDatabase({dbPath:file}); let db=opened.db, repos=createRepositories(db)
  repos.chats.upsert({chatId:'fake-chat',name:'Synthetic',isGroup:true,seenAt:new Date().toISOString()})
  const ids=[]
  for(const status of active){const t=repos.todos.create({chatId:'fake-chat',bucket:'todo',title:'fixture '+status,status,sourceMsgIds:[status==='pending'?'i:src-pending':'src-'+status]});ids.push(t.id)}
  repos.todos.create({chatId:'fake-chat',bucket:'todo',title:'legacy dismissed',status:'dismissed',sourceMsgIds:[]})
  db.exec('DROP TABLE todo_correction_effects; DROP TABLE todo_classification_corrections; DROP TABLE todo_not_mine_events; PRAGMA user_version=4')
  assert.deepEqual(migrate(db),{from:4,to:6})
  assert.equal(db.pragma('user_version',{simple:true}),6)
  assert.equal(repos.todos.get(ids[0]).title,'fixture pending')
  assert.equal(repos.notMine.list().length,0,'legacy dismissed rows are never backfilled')
  console.log('schema-v4-to-v6 compatibility PASS (existing rows preserved; no dismissed backfill)')
  const atomicTodo=repos.todos.create({chatId:'fake-chat',bucket:'todo',title:'atomic rollback fixture',sourceMsgIds:[]})
  db.exec("CREATE TRIGGER fail_not_mine_todo_update BEFORE UPDATE OF status ON todos WHEN NEW.id='"+atomicTodo.id+"' AND NEW.status='dismissed' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END")
  assert.throws(()=>repos.notMine.mark(atomicTodo.id,'other'),/fixture rollback/)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM todo_not_mine_events WHERE todo_id=?').get(atomicTodo.id).n,0,'event insert rolls back with todo update')
  db.exec('DROP TRIGGER fail_not_mine_todo_update')
  repos.messages.insert(fixtureMsg('src-pending'))
  for(let i=0;i<active.length;i++){
    const marked=repos.notMine.mark(ids[i],'other_person_assigned','synthetic note');assert.ok(marked.feedbackId)
    const review=repos.notMine.get(marked.feedbackId);assert.ok(review)
    if(i===0) { assert.equal(review.evidence[0]?.text,'Synthetic fixture text');assert.equal(Object.hasOwn(review.evidence[0],'key_material'),false,'source DTO must not expose key material');assert.equal(JSON.stringify(review.evidence).includes('key_material'),false) }
    else assert.equal(review.missingSourceMsgIds.includes('src-'+active[i]),true)
    assert.equal(repos.todos.get(ids[i]).status,'dismissed')
    const restored=repos.notMine.reopen(marked.feedbackId);assert.equal(restored.ok,true);assert.equal(repos.todos.get(ids[i]).status,active[i])
  }
  const legacy=repos.todos.list().some(x=>x.title==='legacy dismissed');assert.equal(legacy,false)
  const target=repos.todos.create({chatId:'fake-chat',bucket:'todo',title:'correction fixture',sourceMsgIds:['source-one']})
  repos.messages.insert(fixtureMsg('source-one'))
  const marked=repos.notMine.mark(target.id,'unclear_context');assert.ok(marked.feedbackId)
  const saved=repos.notMine.analyze(marked.feedbackId,{analysisVersion:'not-mine-analysis-v1',inferredCauseCode:'other_person_assigned',summary:'First stored evidence analysis.',providerId:'http',modelId:'fake',suggestedCondition:'Only when another sender assigns a task.',suggestedEffect:'Do not classify it as mine.'});assert.equal(saved,true)
  assert.equal(repos.notMine.analyze(marked.feedbackId,{analysisVersion:'not-mine-analysis-v1',inferredCauseCode:'other_person_assigned',summary:'Second stored evidence analysis.',providerId:'http',modelId:'fake',suggestedCondition:'Only when another sender assigns a task.',suggestedEffect:'Do not classify it as mine.'}),true)
  const analysisReview=repos.notMine.get(marked.feedbackId);assert.equal(analysisReview.analysis.summary,'Second stored evidence analysis.');assert.deepEqual(analysisReview.analysisHistory.map(x=>x.summary),['First stored evidence analysis.','Second stored evidence analysis.'],'reanalysis must append while retaining earlier analysis');assert.equal(db.prepare("SELECT COUNT(*) n FROM todo_not_mine_events WHERE parent_feedback_id=? AND event_type='analysis_saved'").get(marked.feedbackId).n,2)
  assert.equal(repos.notMine.apply(marked.feedbackId,'Only when another sender assigns a task.','Do not classify it as mine.').ok,true)
  let rules=repos.notMine.corrections('fake-chat');assert.equal(rules.length,1)
  assert.match(EXTRACT_SYSTEM_PROMPT,/chatScopedClassificationCorrections/);assert.match(EXTRACT_SYSTEM_PROMPT,/condition/);assert.match(EXTRACT_SYSTEM_PROMPT,/其他聊天室/)
  const rule=rules[0], otherChat='other-chat';repos.chats.upsert({chatId:otherChat,name:'Other synthetic',isGroup:true,seenAt:new Date().toISOString()})
  const payloads=[];let effects=[]
  const fakeExtract=async input=>{const payload=JSON.parse(buildUserPayload(input));payloads.push(payload);return {importance:'fyi',newTodos:[],resolved:[],updates:[]}}
  const runMessage=fixtureMsg('run-source');const otherRunMessage=fixtureMsg('other-run-source',otherChat)
  const assertPayloadScope=(stage)=>{const own=payloads.find(p=>p.chat.chatId==='fake-chat'),other=payloads.find(p=>p.chat.chatId===otherChat);assert.ok(own,stage+' fake-chat payload captured');const correction=own.chatScopedClassificationCorrections;assert.deepEqual(correction,[{id:rule.id,revision:rule.revision,condition:rule.condition,effect:rule.effect,scope:'this chat only'}],stage+' exact correction identity, revision, condition, effect, and declared scope');const ownIds=own.newMessages.map(m=>m.msgId);assert.deepEqual(effects.filter(x=>x.stage===stage)[0].msgs,ownIds,stage+' exact corrected message IDs');assert.ok(other,stage+' other-chat negative payload captured');assert.equal(Object.hasOwn(other,'chatScopedClassificationCorrections'),false,stage+' correction must not leak to another chat');assert.equal(effects.filter(x=>x.stage===stage).some(x=>x.chat===otherChat),false,stage+' other chat must not create correction effect')}
  await runOnce({db,config:{blocklist:{nameKeywords:[],senderKeywords:[],contentTypeNoiseOnly:[],minTextLenForLLM:0},concurrency:1,recentContextLimit:5,chatIgnoreKeywords:{}},watchSource:async()=>({messages:[runMessage,otherRunMessage],bridge:'ok'}),extractFn:fakeExtract,correctionsForChat:id=>id==='fake-chat'?repos.notMine.corrections(id):[],onCorrectionsApplied:(chat,msgs,rs)=>rs.forEach(r=>{effects.push({stage:'runOnce',chat,msgs,rule:r});repos.notMine.effect(r,chat,msgs,'runOnce')})})
  assertPayloadScope('runOnce')
  payloads.length=0
  const backMessage=fixtureMsg('back-source');const otherBackMessage=fixtureMsg('other-back-source',otherChat)
  await reviewLastDays(2,{db,now:()=>Date.now(),config:{blocklist:{nameKeywords:[],senderKeywords:[],contentTypeNoiseOnly:[],minTextLenForLLM:0},concurrency:1,recentContextLimit:5,chatIgnoreKeywords:{}},fetchWindow:async()=>({messages:[backMessage,otherBackMessage]}),extractFn:fakeExtract,correctionsForChat:id=>id==='fake-chat'?repos.notMine.corrections(id):[],onCorrectionsApplied:(chat,msgs,rs)=>rs.forEach(r=>{effects.push({stage:'reviewLastDays',chat,msgs,rule:r});repos.notMine.effect(r,chat,msgs,'reviewLastDays')})})
  assertPayloadScope('reviewLastDays')
  const longMessageIds=Array.from({length:205},(_,i)=>'message-'+i);repos.notMine.effect(rule,'fake-chat',longMessageIds,'runOnce');assert.deepEqual(JSON.parse(db.prepare('SELECT message_ids FROM todo_correction_effects ORDER BY created_at DESC,rowid DESC LIMIT 1').get().message_ids),longMessageIds,'effect audit retains every message ID without silent truncation')
  assert.equal(repos.notMine.apply(marked.feedbackId,'A revised evidence-based condition.','A revised chat-only effect.').ok,true)
  assert.equal(repos.notMine.get(marked.feedbackId).correction.revision,2)
  const latestRule=repos.notMine.listCorrections()[0];assert.equal(latestRule.revision,2);assert.equal(repos.notMine.setEnabled(latestRule.id,false).ok,true);assert.equal(repos.notMine.corrections('fake-chat').length,0)
  assert.equal(repos.notMine.listCorrections()[0].enabled,false,'disabled correction stays manageable after reopening its feedback')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM todo_correction_effects').get().n,effects.length+1)
  console.log('atomic mark rollback, mark/evidence/reopen, append-only analysis history, secret DTO negative assertion, revisioned correction exact payload + cross-chat negative assertions at both extraction entries, complete effect ID audit PASS')
  opened.close()

  const appFile=join(root,'app.db'), emitter=new EventEmitter(), scheduler=Object.assign(emitter,{getStatus:()=>({running:false,busy:false,intervalSec:1,lastRunAt:null,lineBridge:'unknown',llmStatus:'unknown',hasApiKey:true,lastError:null}),start(){},stop:async()=>{},triggerNow:async()=>({}),setRunning:async()=>({})})
  let providerCalls=0,appDb
  const provider={id:'http',kind:'http',health:async()=>({ok:true,summary:'fake',details:{}}),complete:async()=>{providerCalls++;return {text:JSON.stringify({inferredCauseCode:'other_person_assigned',summary:'Based on stored evidence only.',suggestedCondition:'Another sender assigns.',suggestedEffect:'Do not assign to me.'}),meta:{provider:'http',model:'fake-model',durationMs:1}}}}
  const store={get:()=>({chatIgnoreKeywords:{},pollIntervalSec:1,concurrency:1,recentContextLimit:5,blocklist:{nameKeywords:[],senderKeywords:[],contentTypeNoiseOnly:[],minTextLenForLLM:0},openAtLogin:false,reconcile:{enabled:false,scopeMonths:0},aiBaseUrl:'',aiProvider:'http',claudeCli:{execPath:'',model:'',timeoutMs:15000},codexCli:{execPath:'',model:'',timeoutMs:15000}}),update(){},isSafeStorageAvailable:()=>false,setApiKey(){},clearApiKey(){},hasSafeStorageKey:()=>false}
  const appRuntime=await createLineTodoApplication({dataDir:root,dbPath:appFile,onDatabase:d=>appDb=d,scheduler,settings:store,pipelineConfig:{getDefaults:()=>({blocklist:store.get().blocklist,concurrency:1,recentContextLimit:5,chatIgnoreKeywords:{}}),getQwenConfig:()=>({apiKey:null,baseURL:'',timeoutMs:1,source:'none'}),isProviderConfigured:()=>true},providers:{resolveProvider:()=>provider},makeExtract:()=>null,line:{start(){},stop(){},status:()=>({state:'stopped',lastMessageAt:null,messageCount:0,lastError:null,restarts:0}),onMessage:()=>()=>{},onStatus:()=>()=>{},getMessagesSince:async()=>[]},media:{open:async()=>({ok:false}),saveAs:async()=>({ok:false})},app:{ping:()=>({ok:true,ts:1,version:'test'}),openDataFolder:async()=>({ok:true}),openOriginal:async()=>({ok:true})}})
  const ar=createRepositories(appDb);ar.chats.upsert({chatId:'api-chat',name:'Fake',isGroup:false,seenAt:new Date().toISOString()});const apiTodo=ar.todos.create({chatId:'api-chat',bucket:'todo',title:'API fixture',sourceMsgIds:[]})
  const apiMark=await appRuntime.api.db.todos.markNotMine(apiTodo.id,'unclear_context');assert.equal(apiMark.ok,true);assert.equal(providerCalls,0,'marking must not call AI')
  const noProviderRuntime=await createLineTodoApplication({dataDir:root,dbPath:join(root,'no-provider.db'),scheduler:Object.assign(new EventEmitter(),{getStatus:()=>({}),start(){},stop:async()=>{}}),settings:store,pipelineConfig:{getDefaults:()=>({}),getQwenConfig:()=>({}),isProviderConfigured:()=>false},providers:{resolveProvider:()=>null},makeExtract:()=>null,line:{start(){},stop(){},status:()=>({state:'stopped',lastMessageAt:null,messageCount:0,lastError:null,restarts:0}),onMessage:()=>()=>{},onStatus:()=>()=>{},getMessagesSince:async()=>[]},media:{open:async()=>({ok:false}),saveAs:async()=>({ok:false})},app:{ping:()=>({ok:true,ts:1,version:'test'}),openDataFolder:async()=>({ok:true}),openOriginal:async()=>({ok:true})}})
  const noChat=noProviderRuntime.api.db.todos;const ndb=openDatabase({dbPath:join(root,'no-provider.db')}),nr=createRepositories(ndb.db);nr.chats.upsert({chatId:'np',name:'Fake',isGroup:false,seenAt:new Date().toISOString()});const nt=nr.todos.create({chatId:'np',bucket:'todo',title:'No provider',sourceMsgIds:[]});const nm=await noChat.markNotMine(nt.id,'other');assert.equal(nm.ok,true);assert.equal((await noChat.getNotMineReview(nm.feedbackId)).todo.title,'No provider');assert.match((await noChat.analyzeNotMine(nm.feedbackId)).reason,/尚未設定/);assert.equal((await noChat.reopenNotMine(nm.feedbackId)).ok,true);await noProviderRuntime.dispose();ndb.close()
  assert.equal(providerCalls,0);const result=await appRuntime.api.db.todos.analyzeNotMine(apiMark.feedbackId);assert.equal(result.ok,true);assert.equal(providerCalls,1);await appRuntime.dispose()
  console.log('application-owned API fake provider gate PASS (mark=0 calls, explicit analysis=1 call; no-provider mark/evidence/reopen PASS)')
  console.log('ipc/preload/UI closure static assertion: '+(['todos:markNotMine','todos:analyzeNotMine','todos:applyNotMineCorrection'].every(x=>require('node:fs').readFileSync('src/main/ipc/application.ipc.ts','utf8').includes(x)&&require('node:fs').readFileSync('src/preload/index.ts','utf8').includes(x))?'PASS':'FAIL'))
} catch(error) { console.error('FAKE FIXTURE ASSERTION:',error); throw error } finally { try{opened?.close()}catch{};rmSync(root,{recursive:true,force:true}) }
}
void smoke().catch(error=>{console.error(error);process.exitCode=1})
`

app.whenReady().then(async () => {
  try {
    const result=await esbuild.build({stdin:{contents:source,sourcefile:'smoke-not-mine.ts',resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,external:['electron','better-sqlite3','openai','koffi']})
    const filename=path.join(process.cwd(),'scripts','.smoke-not-mine.bundle.cjs')
    const compiled=new Module(filename,module);compiled.filename=filename;compiled.paths=Module._nodeModulePaths(process.cwd());compiled._compile(result.outputFiles[0].text,filename)
    app.quit()
  } catch(error) { console.error(error); app.exit(1) }
})
