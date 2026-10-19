import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { AiProviderId, NotMineCorrectionDTO, NotMineFeedbackDTO, NotMineReasonCode, NotMineReviewDTO, TodoDTO } from '../../shared/api'
import { getTodo } from './todos.repo'
import { getMessagesByIds } from './messages.repo'

type EventRow = { feedback_id: string; todo_id: string; event_type: string; previous_status: TodoDTO['status'] | null; reason_code: NotMineReasonCode | null; note: string | null; source_msg_ids: string; analysis_json: string | null; parent_feedback_id: string | null; created_at: string }
type CorrectionRow = { id: string; revision: number; condition_text: string; effect_text: string; enabled: number }
const ACTIVE = ['pending', 'waiting_reply', 'scheduled', 'suggested_done'] as const
const now = (): string => new Date().toISOString()

function currentEvent(db: Database, todoId: string): EventRow | undefined {
  return db.prepare(`SELECT * FROM todo_not_mine_events WHERE todo_id=? AND event_type IN ('marked_not_mine','reopened') ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(todoId) as EventRow | undefined
}
function parseIds(value: string): string[] { try { const x = JSON.parse(value); return Array.isArray(x) ? x.map(String) : [] } catch { return [] } }
function dto(db: Database, row: EventRow): NotMineFeedbackDTO | null {
  const todo = getTodo(row.todo_id, db); if (!todo) return null
  const correction = db.prepare('SELECT id,revision,condition_text,effect_text,enabled FROM todo_classification_corrections WHERE feedback_id=? ORDER BY revision DESC LIMIT 1').get(row.feedback_id) as CorrectionRow | undefined
  const historyRows = db.prepare(`SELECT analysis_json FROM todo_not_mine_events WHERE parent_feedback_id=? AND event_type='analysis_saved' ORDER BY created_at, rowid`).all(row.feedback_id) as Array<{analysis_json:string|null}>
  const analysisHistory: NonNullable<NotMineFeedbackDTO['analysis']>[] = []
  for (const saved of historyRows) if (saved.analysis_json) { try { analysisHistory.push(JSON.parse(saved.analysis_json) as NonNullable<NotMineFeedbackDTO['analysis']>) } catch { /* malformed event is omitted */ } }
  // Preserve visibility for records created before v6, when only the latest analysis
  // was stored on the marked event. New analyses always use append-only child events.
  if (!analysisHistory.length && row.analysis_json) { try { analysisHistory.push(JSON.parse(row.analysis_json) as NonNullable<NotMineFeedbackDTO['analysis']>) } catch { /* malformed legacy payload is omitted */ } }
  const analysis = analysisHistory.at(-1) ?? null
  return { feedbackId: row.feedback_id, todo, reasonCode: row.reason_code ?? 'other', note: row.note, markedAt: row.created_at,
    analysis, analysisHistory, correction: correction ? { id: correction.id, revision: correction.revision, condition: correction.condition_text, effect: correction.effect_text, enabled: correction.enabled === 1 } : null }
}

export function markNotMine(db: Database, todoId: string, reasonCode: NotMineReasonCode, note?: string): { feedbackId?: string; error?: string } {
  const tx = db.transaction(() => {
    const todo = getTodo(todoId, db); if (!todo) return { error: '找不到待辦' }
    if (currentEvent(db, todoId)?.event_type === 'marked_not_mine') return { error: '此待辦已標記' }
    if (!(ACTIVE as readonly string[]).includes(todo.status)) return { error: '目前狀態不可標記' }
    const feedbackId = randomUUID(), at = now()
    db.prepare(`INSERT INTO todo_not_mine_events(feedback_id,todo_id,event_type,previous_status,reason_code,note,source_msg_ids,created_at)
      VALUES(?,?,'marked_not_mine',?,?,?,?,?)`).run(feedbackId, todoId, todo.status, reasonCode, note?.slice(0, 300) ?? null, JSON.stringify(todo.sourceMsgIds), at)
    db.prepare(`UPDATE todos SET status='dismissed',resolved_at=?,updated_at=? WHERE id=? AND status=?`).run(at, at, todoId, todo.status)
    return { feedbackId }
  })
  return tx()
}

export function listNotMine(db: Database): NotMineFeedbackDTO[] {
  const rows = db.prepare(`SELECT e.* FROM todo_not_mine_events e WHERE e.event_type IN ('marked_not_mine','reopened')
    AND e.rowid=(SELECT x.rowid FROM todo_not_mine_events x WHERE x.todo_id=e.todo_id AND x.event_type IN ('marked_not_mine','reopened') ORDER BY x.created_at DESC,x.rowid DESC LIMIT 1)
    AND e.event_type='marked_not_mine' ORDER BY e.created_at DESC LIMIT 500`).all() as EventRow[]
  return rows.map((r) => dto(db,r)).filter((x): x is NotMineFeedbackDTO => !!x)
}
export function getNotMineReview(db: Database, feedbackId: string): NotMineReviewDTO | null {
  const row = db.prepare(`SELECT * FROM todo_not_mine_events WHERE feedback_id=? AND event_type='marked_not_mine'`).get(feedbackId) as EventRow | undefined
  if (!row || currentEvent(db,row.todo_id)?.feedback_id !== feedbackId) return null
  const base = dto(db,row); if (!base) return null
  const ids = parseIds(row.source_msg_ids), evidence = getMessagesByIds(ids,db), found = new Set(evidence.map((m) => m.msgId))
  return { ...base, evidence, missingSourceMsgIds: ids.filter((id) => !found.has(id)) }
}
export function saveAnalysis(db: Database, feedbackId: string, value: { analysisVersion: string; inferredCauseCode: string; summary: string; providerId: AiProviderId; modelId: string | null; suggestedCondition?: string; suggestedEffect?: string }): boolean {
  const row = db.prepare(`SELECT * FROM todo_not_mine_events WHERE feedback_id=? AND event_type='marked_not_mine'`).get(feedbackId) as EventRow | undefined
  if (!row || currentEvent(db,row.todo_id)?.feedback_id !== feedbackId) return false
  const at = now(), payload = JSON.stringify({ ...value, analyzedAt: at })
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO todo_not_mine_events(feedback_id,todo_id,event_type,source_msg_ids,analysis_json,parent_feedback_id,created_at) VALUES(?,?,'analysis_saved',?,?,?,?)`).run(randomUUID(),row.todo_id,row.source_msg_ids,payload,feedbackId,at)
  })
  tx(); return true
}
export function reopenNotMine(db: Database, feedbackId: string): { ok: boolean; error?: string } {
  const tx = db.transaction(() => {
    const row = db.prepare(`SELECT * FROM todo_not_mine_events WHERE feedback_id=? AND event_type='marked_not_mine'`).get(feedbackId) as EventRow | undefined
    if (!row || currentEvent(db,row.todo_id)?.feedback_id !== feedbackId) return { ok:false,error:'標記已變更，請重新整理' }
    const todo = getTodo(row.todo_id,db)
    if (!todo || todo.status !== 'dismissed') return { ok:false,error:'待辦狀態已變更，無法復原' }
    const status = row.previous_status ?? 'pending', at=now()
    db.prepare('UPDATE todos SET status=?,resolved_at=NULL,updated_at=? WHERE id=? AND status=\'dismissed\'').run(status,at,row.todo_id)
    db.prepare(`INSERT INTO todo_not_mine_events(feedback_id,todo_id,event_type,source_msg_ids,created_at) VALUES(?,?,'reopened',?,?)`).run(randomUUID(),row.todo_id,row.source_msg_ids,at)
    return {ok:true}
  })
  return tx()
}
export function applyCorrection(db: Database, feedbackId: string, condition: string, effect: string): {ok:boolean;error?:string} {
  const review = getNotMineReview(db,feedbackId); if (!review) return {ok:false,error:'標記已變更，請重新整理'}
  const c=condition.trim(), e=effect.trim(); if (!c || !e || c.length>500 || e.length>500) return {ok:false,error:'條件與效果需為 1 至 500 字'}
  const current=db.prepare('SELECT * FROM todo_classification_corrections WHERE feedback_id=? ORDER BY revision DESC LIMIT 1').get(feedbackId) as CorrectionRow|undefined
  const at=now(), id=randomUUID(), rev=(current?.revision ?? 0)+1
  const tx=db.transaction(()=>{
    db.prepare('INSERT INTO todo_classification_corrections(id,feedback_id,chat_id,revision,condition_text,effect_text,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)').run(id,feedbackId,review.todo.chatId,rev,c,e,at,at)
    db.prepare(`INSERT INTO todo_not_mine_events(feedback_id,todo_id,event_type,source_msg_ids,correction_id,correction_revision,created_at) VALUES(?,?,'correction_applied',?,?,?,?)`).run(randomUUID(),review.todo.id,JSON.stringify(review.todo.sourceMsgIds),id,rev,at)
  })
  tx(); return {ok:true}
}
export function setCorrectionEnabled(db: Database, correctionId: string, enabled: boolean): {ok:boolean;error?:string} {
  const row=db.prepare('SELECT * FROM todo_classification_corrections WHERE id=?').get(correctionId) as (CorrectionRow & {feedback_id:string;chat_id:string})|undefined
  if(!row) return {ok:false,error:'找不到修正條件'}
  const latest=db.prepare('SELECT MAX(revision) revision FROM todo_classification_corrections WHERE feedback_id=?').get(row.feedback_id) as {revision:number|null}
  if(latest.revision!==row.revision) return {ok:false,error:'修正已更新，請重新整理'}
  const event=db.prepare(`SELECT * FROM todo_not_mine_events WHERE feedback_id=? AND event_type='marked_not_mine'`).get(row.feedback_id) as EventRow|undefined
  if(!event) return {ok:false,error:'找不到來源回饋'}
  const at=now(), tx=db.transaction(()=>{
    db.prepare('UPDATE todo_classification_corrections SET enabled=?,updated_at=? WHERE id=? AND revision=?').run(enabled?1:0,at,row.id,row.revision)
    db.prepare(`INSERT INTO todo_not_mine_events(feedback_id,todo_id,event_type,source_msg_ids,correction_id,correction_revision,created_at) VALUES(?,?,?,?,?,?,?)`).run(randomUUID(),event.todo_id,enabled?'correction_applied':'correction_disabled',event.source_msg_ids,row.id,row.revision,at)
  }); tx(); return {ok:true}
}
export function listCorrections(db:Database): NotMineCorrectionDTO[] {
  return db.prepare(`SELECT c.id,c.feedback_id AS feedbackId,e.todo_id AS todoId,c.chat_id AS chatId,c.revision,c.condition_text AS condition,c.effect_text AS effect,c.enabled,c.updated_at AS updatedAt
    FROM todo_classification_corrections c JOIN todo_not_mine_events e ON e.feedback_id=c.feedback_id AND e.event_type='marked_not_mine'
    WHERE c.revision=(SELECT MAX(x.revision) FROM todo_classification_corrections x WHERE x.feedback_id=c.feedback_id)
    ORDER BY c.updated_at DESC LIMIT 500`).all().map((r:any)=>({...r,enabled:r.enabled===1})) as NotMineCorrectionDTO[]
}
export function activeCorrections(db: Database, chatId: string): Array<{id:string;revision:number;condition:string;effect:string}> {
  return db.prepare(`SELECT c.id,c.revision,c.condition_text AS condition,c.effect_text AS effect FROM todo_classification_corrections c WHERE c.chat_id=? AND c.enabled=1 AND c.revision=(SELECT MAX(x.revision) FROM todo_classification_corrections x WHERE x.feedback_id=c.feedback_id) ORDER BY c.created_at`).all(chatId) as Array<{id:string;revision:number;condition:string;effect:string}>
}
export function recordCorrectionEffect(db: Database, rule: {id:string;revision:number}, chatId:string, messageIds:string[], stage:'runOnce'|'reviewLastDays'): void {
  db.prepare('INSERT INTO todo_correction_effects(id,correction_id,revision,chat_id,message_ids,stage,created_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),rule.id,rule.revision,chatId,JSON.stringify(messageIds),stage,now())
}
