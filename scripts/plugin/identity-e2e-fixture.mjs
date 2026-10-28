/**
 * Isolated renderer/API fixture for the Phase 3 Playwright handoff.
 * It uses a task-owned SQLite DB, fake LINE events, and fake Host AI only.
 * No Electron app, customer DB, LINE login, provider token, or network is needed.
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPluginBackend } from '../../src/plugin/backend/assemble.ts'
import { createPluginLineTodoApi } from '../../src/renderer/platform/pluginApi.ts'
import { createMockTuqAi } from '../lib/mock-tuq-ai.mjs'

const REPO_ROOT=resolve(fileURLToPath(new URL('../..',import.meta.url)))
const DEFAULT_FIXTURE_ROOT=join(REPO_ROOT,'output','linetodo-cache-identity-implementation-20261028','e2e','renderer-fixtures')

function fakeLine(){
  const messages=new Set(),statuses=new Set()
  let running=false,count=0,lastMessageAt=null
  const port={
    start(){running=true;for(const listener of statuses)listener(port.status())},
    stop(){running=false;for(const listener of statuses)listener(port.status())},
    status(){return{state:running?'running':'stopped',lastMessageAt,messageCount:count,lastError:null,restarts:0}},
    onMessage(listener){messages.add(listener);return()=>messages.delete(listener)},
    onStatus(listener){statuses.add(listener);return()=>statuses.delete(listener)},
    async getMessagesSince(){return[]}
  }
  return {port,emit(message){count+=1;lastMessageAt=new Date(message.ts).toISOString();for(const listener of messages)listener(message)}}
}

function identityReply(context,options={}){
  const payload=JSON.parse(context.user)
  if(context.system.includes('重新判斷一筆')){
    const msgId=payload.sourceEvidence[0].msgId
    const topic=payload.historicalCandidates?.find((candidate)=>candidate.entityType==='topic')
    if(options.retryOutcome==='link'&&topic)return JSON.stringify([{draftRef:payload.draftRef,outcome:'link',candidateType:'topic',candidateId:topic.entityId,relationKind:'same_topic',reasonCode:'related_topic',confidenceBand:'high',evidenceMsgIds:[msgId]}])
    return JSON.stringify([{draftRef:payload.draftRef,outcome:'new',candidateType:null,candidateId:null,relationKind:null,reasonCode:'fresh_occurrence',confidenceBand:'high',evidenceMsgIds:[msgId]}])
  }
  if(context.system.includes('classify topics in ONE group chat only')){
    const msgIds=payload.messages.map((message)=>message.msgId)
    const outcome=options.topicDecisionOutcome==='defer'?'defer':'new'
    return JSON.stringify({
      topics:[{ref:'synthetic_topic',title:'合成 meeting room reservation',summary:'合成 meeting room booking'}],
      identityDecisions:[{draftRef:'synthetic_topic',outcome,candidateType:null,candidateId:null,relationKind:null,reasonCode:outcome==='defer'?'insufficient_evidence':'fresh_occurrence',confidenceBand:outcome==='defer'?'low':'high',evidenceMsgIds:[msgIds[0]]}],
      assignments:msgIds.map((msgId)=>({msgId,topicRef:'synthetic_topic',relation:'uncertain',confidence:.3,relevance:'unknown',relevanceEvidenceMsgIds:[]}))
    })
  }
  const msgId=payload.newMessages[0].msgId
  return JSON.stringify({importance:'action',newTodos:[{draftRef:'fixture_defer',bucket:'todo',title:'安排合成群組會議',detail:'先確認時段',priority:2,dueAt:null,confidence:.6,sourceMsgIds:[msgId]}],identityDecisions:[{draftRef:'fixture_defer',outcome:'defer',candidateType:null,candidateId:null,relationKind:null,reasonCode:'insufficient_evidence',confidenceBand:'low',evidenceMsgIds:[msgId]}],resolved:[],updates:[]})
}

export async function createIdentityE2EFixture(options={}){
  const fixtureRoot=resolve(options.fixtureRoot??DEFAULT_FIXTURE_ROOT)
  mkdirSync(fixtureRoot,{recursive:true})
  const fixtureDir=mkdtempSync(join(fixtureRoot,'identity-'))
  const dataDir=join(fixtureDir,'task-data')
  mkdirSync(dataDir,{recursive:true})
  const line=fakeLine()
  const ai=createMockTuqAi({reply:options.aiReply??((context)=>identityReply(context,options))})
  const calls=[]
  const backend=await createPluginBackend({
    pluginId:'tuqdev.line-todo',version:'phase3-fixture',dataDir,line:line.port,
    hostAi:ai.ai,
    ai:{config:{optionsTtlMs:20,providerRetryMs:100},worker:{pollIntervalMs:40,unavailableRetryMs:30}},
    review:{ledgerFile:null}
  })
  const host={
    backend:{call:(method,params)=>{calls.push({method,path:params?.path,args:params?.args??[]});return backend.call(method,params)}},
    assets:{url:(path)=>`http://127.0.0.1/fixture-assets/${String(path).split('/').map(encodeURIComponent).join('/')}`}
  }
  const api=createPluginLineTodoApi({host,events:{enabled:false},busyRetry:{attempts:0}})
  let disposed=false
  return {
    fixtureDir,dataDir,line,ai,backend,host,api,calls,
    browserBridge:host,
    emitSyntheticMessage(text='請先確認合成群組的會議時間',{msgId='fixture-1',chatId='synthetic-group',chat='合成群組'}={}){
      const ts=Date.now()
      line.emit({msgId,chat,chatId,isGroup:true,ts,time:new Date(ts).toISOString(),direction:'in',sender:'合成成員',text,contentType:0})
    },
    async seedDeferredItem(){
      await api.pipeline.runOnce()
      const deadline=Date.now()+10_000
      while(Date.now()<deadline){
        const result=await api.db.todos.identity.listPending({entityType:'todo',chatId:'synthetic-group',limit:10})
        if(result.items.length)return result.items[0]
        await new Promise((resolveDelay)=>setTimeout(resolveDelay,25))
      }
      throw new Error('synthetic_deferred_identity_not_created')
    },
    async seedDeferredTopic(chat={chatId:'synthetic-topic-group',chat:'合成 Topic 群組',msgId:'fixture-topic-defer-1'}){
      this.emitSyntheticMessage('合成群組正在討論 meeting room reservation，請先保留待確認議題',{...chat})
      const enabled=await api.groupTopics.setEnabled(chat.chatId,true)
      if(!enabled.ok)throw new Error(`synthetic_group_topics_enable_failed:${chat.chatId}`)
      const analysis=await api.groupTopics.analyze(chat.chatId)
      if(!analysis.ok)throw new Error(`synthetic_topic_analysis_failed:${JSON.stringify(analysis)}`)
      const result=await api.db.todos.identity.listPending({entityType:'topic',chatId:chat.chatId,limit:10})
      if(!result.items.length)throw new Error(`synthetic_deferred_topic_not_created:${chat.chatId}`)
      return result.items[0]
    },
    async seedCrossChatTopicLinks(){
      const chats=[{chatId:'synthetic-group',chat:'合成群組',msgId:'fixture-topic-a'},{chatId:'synthetic-group-b',chat:'另一合成群組',msgId:'fixture-topic-b'}]
      for(const chat of chats)this.emitSyntheticMessage('討論合成 meeting room reservation 與 booking',{...chat})
      for(const chat of chats){
        const enabled=await api.groupTopics.setEnabled(chat.chatId,true)
        if(!enabled.ok)throw new Error('synthetic_group_topics_enable_failed')
        const cross=await api.groupTopics.setCrossChatEnabled(chat.chatId,true)
        if(!cross.ok)throw new Error('synthetic_cross_chat_enable_failed')
      }
      for(const chat of chats){
        const result=await api.groupTopics.analyze(chat.chatId)
        if(!result.ok)throw new Error(`synthetic_topic_analysis_failed:${result.reason??'unknown'}`)
      }
      const links=await api.groupTopics.linkProposals('synthetic-group')
      if(links.length===0)throw new Error('synthetic_cross_chat_link_not_created')
      return links
    },
    async dispose(){
      if(disposed)return
      disposed=true
      api.dispose()
      await backend.dispose()
    }
  }
}
