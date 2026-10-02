import { useEffect, useState } from 'react'
import type { LineTodoApi, NotMineCorrectionDTO, NotMineFeedbackDTO, NotMineReviewDTO } from '../../../shared/api'
import { backendErrorText } from '../../lib/backendError'

// G-02：每個 backend 呼叫都有 catch，失敗原因顯示在 message（清單與單筆畫面都看得到），不留未處理的 rejection。

export function NotMineReviewPanel({api,onClose,onChanged}:{api:LineTodoApi;onClose:()=>void;onChanged:()=>void}):JSX.Element {
  const [items,setItems]=useState<NotMineFeedbackDTO[]>([]),[corrections,setCorrections]=useState<NotMineCorrectionDTO[]>([]),[selected,setSelected]=useState<NotMineReviewDTO|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
  const [condition,setCondition]=useState(''),[effect,setEffect]=useState('')
  async function load():Promise<void>{try{const [feedback,rules]=await Promise.all([api.db.todos.listNotMine(),api.db.todos.listNotMineCorrections()]);setItems(feedback);setCorrections(rules)}catch(e){setMessage(backendErrorText(e,'讀取回查清單失敗'))}}
  useEffect(()=>{void load()},[])
  async function open(id:string):Promise<void>{try{const r=await api.db.todos.getNotMineReview(id);setSelected(r);setCondition('');setEffect('')}catch(e){setMessage(backendErrorText(e,'讀取這筆回查失敗'))}}
  async function analyze():Promise<void>{if(!selected)return;setBusy(true);setMessage('');try{const r=await api.db.todos.analyzeNotMine(selected.feedbackId);if(!r.ok){setMessage(r.reason??'分析失敗');return}setMessage(`可能原因：${r.summary}（${r.providerId}/${r.modelId??'unknown'}）`);setCondition(r.suggestedCondition??'');setEffect(r.suggestedEffect??'');await open(selected.feedbackId);setCondition(r.suggestedCondition??'');setEffect(r.suggestedEffect??'')}catch(e){setMessage(backendErrorText(e,'分析失敗'))}finally{setBusy(false)}}
  async function apply():Promise<void>{if(!selected||!condition.trim()||!effect.trim())return;if(!window.confirm(`確認只對「${selected.todo.chatId}」後續抽取套用此條件？\n條件：${condition}\n效果：${effect}`))return;setBusy(true);try{const r=await api.db.todos.applyNotMineCorrection(selected.feedbackId,condition,effect);setMessage(r.ok?'已套用，可隨時停用':r.error??'套用失敗');await load();await open(selected.feedbackId);onChanged()}catch(e){setMessage(backendErrorText(e,'套用失敗'))}finally{setBusy(false)}}
  async function toggleCorrection(correction:NotMineCorrectionDTO|NonNullable<NotMineReviewDTO['correction']>):Promise<void>{try{const r=await api.db.todos.setNotMineCorrectionEnabled(correction.id,!correction.enabled);setMessage(r.ok?(correction.enabled?'已停用':'已啟用'):r.error??'更新失敗');await load();if(selected)await open(selected.feedbackId)}catch(e){setMessage(backendErrorText(e,'更新失敗'))}}
  async function reopen():Promise<void>{if(!selected)return;try{const r=await api.db.todos.reopenNotMine(selected.feedbackId);setMessage(r.ok?'已復原原待辦狀態':r.error??'復原失敗');await load();setSelected(null);onChanged()}catch(e){setMessage(backendErrorText(e,'復原失敗'))}}
  return <section className="not-mine-review" aria-label="不是我的待辦回查"><header><strong>不是我的（{items.length}）</strong><button onClick={onClose}>關閉</button></header>
    {!selected&&message&&<p role="status">{message}</p>}
    {!selected?<><h4>仍標記的待辦</h4><ul>{items.map(x=><li key={x.feedbackId}><button onClick={()=>void open(x.feedbackId)}>{x.todo.title}</button> · {x.todo.chatId} · {x.markedAt}</li>)}</ul><h4>已套用的聊天限定修正</h4>{corrections.length?corrections.map(c=><p key={c.id}>聊天室 {c.chatId} · revision {c.revision} · {c.enabled?'啟用中':'已停用'} · {c.condition} → {c.effect} <button onClick={()=>void toggleCorrection(c)}>{c.enabled?'停用':'重新啟用'}</button></p>):<p>尚無修正條件。</p>}</>:<div>
      <button onClick={()=>setSelected(null)}>← 清單</button><h3>{selected.todo.title}</h3><p>紀錄可見：分類 {selected.todo.bucket}；狀態 {selected.todo.status}；confidence {selected.todo.confidence}; 原因標記 {selected.reasonCode}。</p>
      <h4>來源訊息紀錄</h4>{selected.evidence.map(m=><blockquote key={m.msgId}>{m.timeIso} · {m.direction} · {m.sender??'未知'}：{m.text??'[無文字]'}</blockquote>)}{selected.missingSourceMsgIds.map(id=><p key={id}>找不到來源訊息：{id}</p>)}
      <h4>可能原因（分析推論）</h4>{selected.analysis?<p>{selected.analysis.summary} · {selected.analysis.providerId}/{selected.analysis.modelId??'unknown'} · {selected.analysis.analyzedAt}</p>:<p>尚未分析。按下分析會將最多 50 則來源訊息（每則文字最多 2,000 字）傳給目前設定的 AI provider。</p>}
      <button disabled={busy} onClick={()=>void analyze()}>分析可能原因</button>{message&&<p role="status">{message}</p>}
      <h4>聊天限定修正（需人工確認）</h4><label>條件 <textarea value={condition} onChange={e=>setCondition(e.target.value)} maxLength={500}/></label><label>效果 <textarea value={effect} onChange={e=>setEffect(e.target.value)} maxLength={500}/></label>
      <button disabled={busy||!condition.trim()||!effect.trim()} onClick={()=>void apply()}>檢視並確認套用</button>{selected.correction&&<p>revision {selected.correction.revision} · {selected.correction.enabled?'啟用中':'已停用'} <button onClick={()=>void toggleCorrection(selected.correction!)}>{selected.correction.enabled?'停用':'重新啟用'}</button></p>}
      <button onClick={()=>void reopen()}>復原待辦</button>
    </div>}</section>
}
