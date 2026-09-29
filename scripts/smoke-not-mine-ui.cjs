const { app, BrowserWindow } = require('electron')
const esbuild = require('esbuild')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

const source=`
import React,{useState} from 'react'
import {createRoot} from 'react-dom/client'
import {TodoCard} from './src/renderer/components/Board/TodoCard.tsx'
import {NotMineReviewPanel} from './src/renderer/components/Board/NotMineReviewPanel.tsx'
const todo={id:'todo-fixture',chatId:'chat-fixture',bucket:'todo',status:'pending',title:'合成待辦',detail:'synthetic only',priority:2,dueAt:null,sourceMsgIds:['source-fixture'],confidence:.8,completionEvidence:null,createdAt:'2026-01-01',updatedAt:'2026-01-01',resolvedAt:null}
const state={marked:false,analysis:null,correction:null,providerCalls:0,lastRule:null,reopened:false}
const api={db:{todos:{markNotMine:async(id,reason)=>{state.marked=true;state.reason=reason;return{ok:true,feedbackId:'feedback-fixture'}},listNotMine:async()=>state.marked&&!state.reopened?[{feedbackId:'feedback-fixture',todo,reasonCode:'unclear_context',note:null,markedAt:'fixture-time',analysis:state.analysis,correction:state.correction}]:[],listNotMineCorrections:async()=>state.correction?[{...state.correction,feedbackId:'feedback-fixture',todoId:todo.id,chatId:todo.chatId,updatedAt:'fixture-time'}]:[],getNotMineReview:async()=>({feedbackId:'feedback-fixture',todo,reasonCode:'unclear_context',note:null,markedAt:'fixture-time',analysis:state.analysis,correction:state.correction,evidence:[{msgId:'source-fixture',chatId:'chat-fixture',ts:1,timeIso:'fixture-time',direction:'in',sender:'其他人',text:'合成來源訊息',contentType:0,processed:false,ingestedAt:'fixture-time',origFilename:null,fileSize:null,unsent:false}],missingSourceMsgIds:[]}),analyzeNotMine:async()=>{state.providerCalls++;state.analysis={inferredCauseCode:'other_person_assigned',summary:'可能是其他發話者交辦；這是依保存訊息推論。',providerId:'http',modelId:'fake-provider',analyzedAt:'fixture-time',suggestedCondition:'其他發話者明確交辦時',suggestedEffect:'不要歸為我的待辦'};return{ok:true,...state.analysis,suggestedCondition:state.analysis.suggestedCondition,suggestedEffect:state.analysis.suggestedEffect}},applyNotMineCorrection:async(_id,condition,effect)=>{state.lastRule={condition,effect,chatId:todo.chatId};state.correction={id:'rule-fixture',revision:1,condition,effect,enabled:true};return{ok:true}},setNotMineCorrectionEnabled:async(_id,enabled)=>{state.correction.enabled=enabled;return{ok:true}},reopenNotMine:async()=>{state.reopened=true;return{ok:true}}}}}
function App(){const [marked,setMarked]=useState(false),[review,setReview]=useState(false);const actions={onComplete(){},onConfirmDone(){},onRejectSuggested(){},onIgnore(){},onMarkNotMine:async()=>{await api.db.todos.markNotMine(todo.id,'unclear_context');setMarked(true);setReview(true)},onIgnoreByKeyword(){},onBlockChat(){},onSnooze(){},onReopen(){},onOpenChat(){},onDraftReply(){},onEdit(){},onSetViewedLocal(){}};return <main>{!marked&&<TodoCard todo={todo} chatName="合成聊天室" isGroup viewedLocally={false} actions={actions} dnd={{dragging:false,onDragStart(){},onDragEnd(){}}}/ >}{review&&<NotMineReviewPanel api={api} onClose={()=>setReview(false)} onChanged={()=>{}}/>}<output id="harness-state">{JSON.stringify(state)}</output></main>}
window.__fakeState=state;window.confirm=()=>true;createRoot(document.getElementById('root')).render(<App/>);window.__ready=true
`

app.whenReady().then(async()=>{
  let win;const temp=mkdtempSync(path.join(tmpdir(),'line-todo-not-mine-ui-'))
  try{
    const built=await esbuild.build({stdin:{contents:source,sourcefile:'not-mine-ui-harness.tsx',resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',write:false,jsx:'automatic'})
    const js=built.outputFiles[0].text
    writeFileSync(path.join(temp,'harness.js'),js);writeFileSync(path.join(temp,'index.html'),'<!doctype html><html><body><div id="root"></div><script src="./harness.js"></script></body></html>')
    win=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}})
    await win.loadFile(path.join(temp,'index.html'))
    const run=async code=>win.webContents.executeJavaScript(code)
    await run(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.includes('更多'));if(!b)throw Error('TodoCard menu trigger missing');b.click()})()`)
    await run(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.includes('不是我的'));if(!b)throw Error('not-mine menu action missing');b.click()})()`)
    await run(`new Promise(r=>setTimeout(r,30))`)
    if(!(await run(`window.__fakeState.marked`)))throw Error('mark action did not update fake feedback')
    await run(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText==='合成待辦');if(!b)throw Error('marked item missing from review list');b.click()})()`)
    await run(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.includes('分析可能原因'));if(!b)throw Error('analysis action missing');b.click()})()`)
    await run(`new Promise(r=>setTimeout(r,50))`)
    const split=await run(`({facts:document.body.innerText.includes('紀錄可見'),inference:document.body.innerText.includes('可能原因（分析推論）'),calls:window.__fakeState.providerCalls})`)
    if(!split.facts||!split.inference||split.calls!==1)throw Error('facts/inference or explicit analyze UI gate failed: '+JSON.stringify(split))
    await run(`(()=>{const a=[...document.querySelectorAll('textarea')];if(a.length!==2)throw Error('editable correction fields missing');for(const [el,value] of [[a[0],'改過的聊天室限定條件'],[a[1],'改過的未來抽取效果']]){const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))}})()`)
    await run(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.includes('檢視並確認套用'));if(!b)throw Error('apply confirmation action missing');b.click()})()`)
    await run(`new Promise(r=>setTimeout(r,40))`)
    const rule=await run('window.__fakeState.lastRule')
    if(!rule||rule.chatId!=='chat-fixture'||rule.condition!=='改過的聊天室限定條件'||rule.effect!=='改過的未來抽取效果')throw Error('edited chat-scoped rule not applied after confirmation: '+JSON.stringify(rule))
    await run(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText==='停用');if(!b)throw Error('disable action missing');b.click()})()`)
    await run(`new Promise(r=>setTimeout(r,25))`)
    if((await run('window.__fakeState.correction.enabled'))!==false)throw Error('disable action did not take effect')
    await run(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText==='復原待辦');if(!b)throw Error('reopen action missing');b.click()})()`)
    await run(`new Promise(r=>setTimeout(r,25))`)
    if(!(await run('window.__fakeState.reopened')))throw Error('reopen action missing')
    if(!(await run(`document.body.innerText.includes('已套用的聊天限定修正')`)))throw Error('reopened feedback correction is not manageable')
    await run(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText==='重新啟用');if(!b)throw Error('correction management action missing after reopen');b.click()})()`)
    await run(`new Promise(r=>setTimeout(r,25))`)
    if(!(await run('window.__fakeState.correction.enabled')))throw Error('correction re-enable through persistent list failed')
    await run(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText==='停用');if(!b)throw Error('persistent correction disable action missing');b.click()})()`)
    await run(`new Promise(r=>setTimeout(r,25))`)
    if((await run('window.__fakeState.correction.enabled'))!==false)throw Error('correction disable through persistent list failed')
    console.log('renderer UI fake interaction PASS: TodoCard mark → visible review/source facts + separated inference → explicit provider analysis → edited candidate confirm → chat scope → disable → reopen → persistent correction management/disable')
    win.close();rmSync(temp,{recursive:true,force:true});app.quit()
  }catch(error){console.error(error);try{win?.close()}catch{};try{rmSync(temp,{recursive:true,force:true})}catch{};app.exit(1)}
})
