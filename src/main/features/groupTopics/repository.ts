import { createHash, randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { TopicAnalysis, TopicMessageInput, TopicView } from './domain'

export const GROUP_TOPICS_SCHEMA_VERSION = 1

/** Additive, feature-owned schema; failure is caught by the composition root and disables this feature only. */
export function ensureGroupTopicsSchema(db: Database): void {
  const tx = db.transaction(() => db.exec(`
    CREATE TABLE IF NOT EXISTS group_topics_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS group_topic_preferences (
      chat_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), cross_chat_enabled INTEGER NOT NULL DEFAULT 0 CHECK(cross_chat_enabled IN (0,1)), updated_at TEXT NOT NULL,
      FOREIGN KEY(chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS discussion_topics (
      topic_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, local_ref TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
      created_at TEXT NOT NULL, last_source_ts INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      UNIQUE(chat_id,local_ref), FOREIGN KEY(chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_discussion_topics_chat_ts ON discussion_topics(chat_id,last_source_ts DESC);
    CREATE TABLE IF NOT EXISTS topic_analysis_runs (
      run_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, input_digest TEXT NOT NULL, prompt_version TEXT NOT NULL,
      prompt_hash TEXT NOT NULL, schema_version TEXT NOT NULL, schema_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('complete','failed')),
      error_code TEXT, created_at TEXT NOT NULL, UNIQUE(chat_id,input_digest), FOREIGN KEY(chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS topic_message_decisions (
      chat_id TEXT NOT NULL, msg_id TEXT NOT NULL, run_id TEXT NOT NULL, disposition TEXT NOT NULL CHECK(disposition IN ('assigned','not_topic','uncertain')),
      PRIMARY KEY(chat_id,msg_id), FOREIGN KEY(msg_id) REFERENCES messages(msg_id) ON DELETE CASCADE,
      FOREIGN KEY(run_id) REFERENCES topic_analysis_runs(run_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS topic_evidence (
      topic_id TEXT NOT NULL, msg_id TEXT NOT NULL, relation TEXT NOT NULL CHECK(relation IN ('about','repost','uncertain')),
      confidence REAL NOT NULL, relevance TEXT NOT NULL CHECK(relevance IN ('action','awareness','unrelated','unknown')),
      relevance_evidence_msg_ids TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(topic_id,msg_id),
      FOREIGN KEY(topic_id) REFERENCES discussion_topics(topic_id) ON DELETE CASCADE,
      FOREIGN KEY(msg_id) REFERENCES messages(msg_id) ON DELETE CASCADE,
      FOREIGN KEY(run_id) REFERENCES topic_analysis_runs(run_id) ON DELETE CASCADE
    );
    DELETE FROM topic_evidence WHERE rowid NOT IN (SELECT MAX(rowid) FROM topic_evidence GROUP BY msg_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_evidence_one_topic_per_message ON topic_evidence(msg_id);
    CREATE TABLE IF NOT EXISTS topic_links (
      link_id TEXT PRIMARY KEY, left_topic_id TEXT NOT NULL, right_topic_id TEXT NOT NULL,
      relation TEXT NOT NULL CHECK(relation IN ('same_occurrence','follow_up','related','unrelated','unknown')),
      identity_evidence TEXT NOT NULL CHECK(identity_evidence IN ('verified','unknown')),
      event_evidence_msg_ids TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('proposed','accepted','rejected')),
      created_at TEXT NOT NULL, CHECK(left_topic_id <> right_topic_id),
      FOREIGN KEY(left_topic_id) REFERENCES discussion_topics(topic_id) ON DELETE CASCADE,
      FOREIGN KEY(right_topic_id) REFERENCES discussion_topics(topic_id) ON DELETE CASCADE
    );
    INSERT OR IGNORE INTO group_topics_meta(key,value) VALUES ('schema_version','1');
  `))
  tx()
}

export function setEnabled(db: Database, chatId: string, enabled: boolean): boolean {
  const chat = db.prepare('SELECT is_group,blocked FROM chats WHERE chat_id=?').get(chatId) as { is_group: number; blocked: number } | undefined
  if (!chat || chat.is_group !== 1 || chat.blocked === 1) return false
  db.prepare(`INSERT INTO group_topic_preferences(chat_id,enabled,updated_at) VALUES(?,?,?)
    ON CONFLICT(chat_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at`).run(chatId, Number(enabled), new Date().toISOString())
  return true
}

export function setCrossChatEnabled(db: Database, chatId: string, enabled: boolean): boolean {
  const chat = db.prepare('SELECT is_group,blocked FROM chats WHERE chat_id=?').get(chatId) as { is_group: number; blocked: number } | undefined
  if (!chat || chat.is_group !== 1 || chat.blocked === 1 || !isEnabled(db, chatId)) return false
  db.prepare(`INSERT INTO group_topic_preferences(chat_id,enabled,cross_chat_enabled,updated_at) VALUES(?,1,?,?)
    ON CONFLICT(chat_id) DO UPDATE SET cross_chat_enabled=excluded.cross_chat_enabled,updated_at=excluded.updated_at`).run(chatId, Number(enabled), new Date().toISOString())
  return true
}

export function crossChatIsEnabled(db: Database, chatId: string): boolean {
  return (db.prepare('SELECT cross_chat_enabled FROM group_topic_preferences WHERE chat_id=?').get(chatId) as { cross_chat_enabled: number } | undefined)?.cross_chat_enabled === 1
}

export function isEnabled(db: Database, chatId: string): boolean {
  return (db.prepare('SELECT enabled FROM group_topic_preferences WHERE chat_id=?').get(chatId) as { enabled: number } | undefined)?.enabled === 1
}

export function loadMessages(db: Database, chatId: string, limit = 100): TopicMessageInput[] {
  const rows = db.prepare(`SELECT msg_id,ts,direction,text FROM messages WHERE chat_id=? AND unsent=0 AND content_type=0 AND text IS NOT NULL AND trim(text)<>'' ORDER BY ts DESC,msg_id DESC LIMIT ?`).all(chatId, Math.max(1, Math.min(100, limit))) as Array<{ msg_id: string; ts: number; direction: 'in'|'out'; text: string }>
  return rows.reverse().map((row) => ({ msgId: row.msg_id, ts: row.ts, direction: row.direction, text: row.text.slice(0, 3000) }))
}

export function loadTopicCandidates(db: Database, chatId: string): Array<{ref:string;title:string;summary:string}> {
  return db.prepare('SELECT local_ref AS ref,title,summary FROM discussion_topics WHERE chat_id=? ORDER BY last_source_ts DESC LIMIT 100').all(chatId) as Array<{ref:string;title:string;summary:string}>
}

type AnalysisVersions={promptVersion:string;promptHash:string;schemaVersion:string;schemaHash:string;validatorVersion:string}

export function saveAnalysis(db: Database, chatId: string, input: TopicMessageInput[], result: TopicAnalysis, versions: AnalysisVersions): boolean {
  const digest = completionDigest(input, versions)
  const runId = randomUUID()
  const now = new Date().toISOString()
  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT state FROM topic_analysis_runs WHERE chat_id=? AND input_digest=?').get(chatId,digest) as { state: string } | undefined
    if (existing?.state === 'complete') return false
    db.prepare(`INSERT INTO topic_analysis_runs(run_id,chat_id,input_digest,prompt_version,prompt_hash,schema_version,schema_hash,state,error_code,created_at)
      VALUES(?,?,?,?,?,?,?,'complete',NULL,?) ON CONFLICT(chat_id,input_digest) DO UPDATE SET run_id=excluded.run_id,
      prompt_version=excluded.prompt_version,prompt_hash=excluded.prompt_hash,schema_version=excluded.schema_version,schema_hash=excluded.schema_hash,state='complete',error_code=NULL,created_at=excluded.created_at`).run(runId,chatId,digest,versions.promptVersion,versions.promptHash,versions.schemaVersion,versions.schemaHash,now)
    const refs = new Map<string,string>()
    for (const topic of result.topics) {
      const topicId = randomUUID(); refs.set(topic.ref,topicId)
      db.prepare(`INSERT INTO discussion_topics(topic_id,chat_id,local_ref,title,summary,created_at,last_source_ts,revision)
        VALUES(?,?,?,?,?,?,?,1) ON CONFLICT(chat_id,local_ref) DO UPDATE SET title=excluded.title,summary=excluded.summary,
        last_source_ts=max(discussion_topics.last_source_ts,excluded.last_source_ts),revision=discussion_topics.revision+1`)
        .run(topicId,chatId,topic.ref,topic.title,topic.summary,now,input.at(-1)?.ts ?? Date.now())
      const existingTopic = db.prepare('SELECT topic_id FROM discussion_topics WHERE chat_id=? AND local_ref=?').get(chatId,topic.ref) as {topic_id:string}
      refs.set(topic.ref,existingTopic.topic_id)
    }
    const allowed = new Set(input.map((m) => m.msgId))
    const changedIds = [...allowed]
    const changedTopics = changedIds.length ? db.prepare(`SELECT DISTINCT topic_id FROM topic_evidence WHERE msg_id IN (${changedIds.map(()=>'?').join(',')})`).all(...changedIds) as Array<{topic_id:string}> : []
    const staleLinks = db.prepare("SELECT link_id,left_topic_id,right_topic_id,event_evidence_msg_ids FROM topic_links WHERE status='proposed'").all() as Array<{link_id:string;left_topic_id:string;right_topic_id:string;event_evidence_msg_ids:string}>
    const changedTopicIds = new Set(changedTopics.map((row)=>row.topic_id))
    const deleteLink = db.prepare('DELETE FROM topic_links WHERE link_id=?')
    for (const link of staleLinks) {
      let evidenceIds: string[] = []
      try { evidenceIds = JSON.parse(link.event_evidence_msg_ids) as string[] } catch { /* malformed historical refs are invalidated */ }
      if (changedTopicIds.has(link.left_topic_id) || changedTopicIds.has(link.right_topic_id) || evidenceIds.some((id)=>allowed.has(id))) deleteLink.run(link.link_id)
    }
    if (changedIds.length) {
      db.prepare(`DELETE FROM topic_evidence WHERE msg_id IN (${changedIds.map(()=>'?').join(',')})`).run(...changedIds)
      db.prepare(`DELETE FROM topic_message_decisions WHERE chat_id=? AND msg_id IN (${changedIds.map(()=>'?').join(',')})`).run(chatId,...changedIds)
    }
    const writeDecision = db.prepare(`INSERT INTO topic_message_decisions(chat_id,msg_id,run_id,disposition) VALUES(?,?,?,?)
      ON CONFLICT(chat_id,msg_id) DO UPDATE SET run_id=excluded.run_id,disposition=excluded.disposition`)
    const writeEvidence = db.prepare(`INSERT INTO topic_evidence(topic_id,msg_id,relation,confidence,relevance,relevance_evidence_msg_ids,run_id)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(topic_id,msg_id) DO UPDATE SET relation=excluded.relation,confidence=excluded.confidence,
      relevance=excluded.relevance,relevance_evidence_msg_ids=excluded.relevance_evidence_msg_ids,run_id=excluded.run_id`)
    for (const assignment of result.assignments) {
      const topicId = assignment.topicRef ? refs.get(assignment.topicRef) : undefined
      writeDecision.run(chatId,assignment.msgId,runId,topicId ? (assignment.relation==='uncertain'?'uncertain':'assigned') : 'not_topic')
      if (topicId) writeEvidence.run(topicId,assignment.msgId,assignment.relation,assignment.confidence,assignment.relevance,
        JSON.stringify(assignment.relevanceEvidenceMsgIds.filter((id)=>allowed.has(id))),runId)
    }
    // Candidate recall only: this lexical overlap cannot verify either participant identity
    // or that two groups mean the same occurrence. Persist as unknown/proposed with local evidence refs.
    if (crossChatIsEnabled(db, chatId)) {
      const tokenize = (text: string): Set<string> => new Set((text.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((w) => !['這個','那個','我們','可以','今天','明天','目前','問題','群組','有人','about','from','with'].includes(w)))
      const current = result.topics.map((t) => ({ id: refs.get(t.ref)!, words: tokenize(`${t.title} ${t.summary}`) })).filter((x) => x.words.size >= 2)
      const enabledRows = db.prepare(`SELECT t.topic_id,t.chat_id,t.title,t.summary FROM discussion_topics t
        JOIN group_topic_preferences p ON p.chat_id=t.chat_id JOIN chats c ON c.chat_id=t.chat_id
        WHERE p.enabled=1 AND p.cross_chat_enabled=1 AND c.is_group=1 AND c.blocked=0 AND t.chat_id<>?`).all(chatId) as Array<{topic_id:string;chat_id:string;title:string;summary:string}>
      const insertLink = db.prepare(`INSERT INTO topic_links(link_id,left_topic_id,right_topic_id,relation,identity_evidence,event_evidence_msg_ids,status,created_at)
        VALUES(?,?,?,'unknown','unknown',?,'proposed',?)`)
      const existsLink = db.prepare(`SELECT 1 FROM topic_links WHERE (left_topic_id=? AND right_topic_id=?) OR (left_topic_id=? AND right_topic_id=?)`)
      const sourceIds = (topicId:string):string[] => (db.prepare('SELECT msg_id FROM topic_evidence WHERE topic_id=? ORDER BY msg_id LIMIT 20').all(topicId) as Array<{msg_id:string}>).map((r)=>r.msg_id)
      let created=0
      for (const local of current) for (const candidate of enabledRows) {
        if(created>=100) break
        const words = tokenize(`${candidate.title} ${candidate.summary}`)
        const shared = [...local.words].filter((w)=>words.has(w))
        if(shared.length<2) continue
        const pair=[local.id,candidate.topic_id].sort()
        if(existsLink.get(pair[0],pair[1],pair[1],pair[0])) continue
        insertLink.run(randomUUID(),pair[0],pair[1],JSON.stringify([...new Set([...sourceIds(pair[0]),...sourceIds(pair[1])])]),now)
        created++
      }
    }
    return true
  })
  return tx()
}

export function listTopics(db: Database, chatId: string): TopicView[] {
  const rows = db.prepare(`SELECT t.topic_id,t.chat_id,t.title,t.summary,t.last_source_ts,
      COUNT(e.msg_id) AS evidence_count,GROUP_CONCAT(e.msg_id) AS evidence_msg_ids,
      NULL AS relevance,NULL AS relevance_evidence
      FROM discussion_topics t LEFT JOIN topic_evidence e ON e.topic_id=t.topic_id WHERE t.chat_id=?
      GROUP BY t.topic_id ORDER BY t.last_source_ts DESC LIMIT 100`).all(chatId) as Array<{topic_id:string;chat_id:string;title:string;summary:string;last_source_ts:number;evidence_count:number;evidence_msg_ids:string|null;relevance:string|null;relevance_evidence:string|null}>
  const identityTableReady = (db.prepare("SELECT 1 AS yes FROM sqlite_master WHERE type='table' AND name='message_participants'").get() as {yes:number}|undefined)?.yes === 1
  const participants = identityTableReady ? db.prepare(`SELECT e.topic_id,COUNT(DISTINCT p.participant_key) AS n FROM topic_evidence e
    JOIN message_participants p ON p.msg_id=e.msg_id WHERE e.topic_id IN (SELECT topic_id FROM discussion_topics WHERE chat_id=?)
    AND p.scope='chat' AND p.identity_status='keyed' AND p.participant_key IS NOT NULL GROUP BY e.topic_id`).all(chatId) as Array<{topic_id:string;n:number}> : []
  const participantCount = new Map(participants.map((r)=>[r.topic_id,r.n]))
  const relevanceByTopic=new Map<string,Map<string,Set<string>>>()
  const participationByTopic=new Set<string>()
  for (const row of db.prepare(`SELECT DISTINCT e.topic_id FROM topic_evidence e JOIN messages m ON m.msg_id=e.msg_id WHERE m.chat_id=? AND m.direction='out'`).all(chatId) as Array<{topic_id:string}>) participationByTopic.add(row.topic_id)
  const relevanceRows=db.prepare(`SELECT topic_id,relevance,relevance_evidence_msg_ids FROM topic_evidence
    WHERE topic_id IN (SELECT topic_id FROM discussion_topics WHERE chat_id=?)`).all(chatId) as Array<{topic_id:string;relevance:string;relevance_evidence_msg_ids:string}>
  for(const row of relevanceRows){
    let categories=relevanceByTopic.get(row.topic_id);if(!categories){categories=new Map();relevanceByTopic.set(row.topic_id,categories)}
    let refs=categories.get(row.relevance);if(!refs){refs=new Set();categories.set(row.relevance,refs)}
    try{for(const id of JSON.parse(row.relevance_evidence_msg_ids) as string[])refs.add(id)}catch{/* invalid stored evidence stays absent */}
  }
  return rows.map((r)=>{const categories=relevanceByTopic.get(r.topic_id)??new Map();const grouped=[...categories.entries()].map(([category,ids])=>({relevance:category as TopicView['relevance'],evidenceMsgIds:[...ids]}));return {topicId:r.topic_id,chatId:r.chat_id,title:r.title,summary:r.summary,lastSourceTs:r.last_source_ts,evidenceCount:r.evidence_count,evidenceMsgIds:r.evidence_msg_ids?.split(',').filter(Boolean)??[],participantLowerBound:identityTableReady?(participantCount.get(r.topic_id)??0):null,
    userParticipation:participationByTopic.has(r.topic_id)?'i_participated' as const:'unknown' as const,
    relevance:'unknown' as const,relevanceEvidenceMsgIds:grouped.flatMap((x)=>x.evidenceMsgIds),relevanceEvidence:grouped,
    observation:'unknown',heat:'unvalidated',trend:'unknown'}
  })
}

export function listLinkCandidates(db: Database, chatId: string): Array<{linkId:string;otherChatName:string|null;topicTitle:string;relation:'unknown';identityEvidence:'unknown';eventEvidenceCount:number;eventEvidenceMsgIds:string[]}> {
  const requester=db.prepare('SELECT is_group,blocked FROM chats WHERE chat_id=?').get(chatId) as {is_group:number;blocked:number}|undefined
  if (!requester || requester.is_group!==1 || requester.blocked===1 || !isEnabled(db,chatId) || !crossChatIsEnabled(db,chatId)) return []
  const rows=db.prepare(`SELECT l.link_id,l.event_evidence_msg_ids,other.name AS other_chat_name,t.title AS topic_title
    FROM topic_links l JOIN discussion_topics here ON here.topic_id=l.left_topic_id OR here.topic_id=l.right_topic_id
    JOIN discussion_topics t ON t.topic_id=CASE WHEN here.topic_id=l.left_topic_id THEN l.right_topic_id ELSE l.left_topic_id END
    JOIN chats other ON other.chat_id=t.chat_id
    JOIN chats own ON own.chat_id=here.chat_id
    JOIN group_topic_preferences hp ON hp.chat_id=here.chat_id AND hp.enabled=1 AND hp.cross_chat_enabled=1
    JOIN group_topic_preferences op ON op.chat_id=t.chat_id AND op.enabled=1 AND op.cross_chat_enabled=1
    WHERE here.chat_id=? AND own.is_group=1 AND own.blocked=0 AND other.is_group=1 AND other.blocked=0
      AND l.status='proposed' AND l.identity_evidence='unknown' ORDER BY other.name,t.title LIMIT 100`).all(chatId) as Array<{link_id:string;other_chat_name:string|null;topic_title:string;event_evidence_msg_ids:string}>
  return rows.map((r)=>{const refs=JSON.parse(r.event_evidence_msg_ids) as string[];return {linkId:r.link_id,otherChatName:r.other_chat_name,topicTitle:r.topic_title,relation:'unknown',identityEvidence:'unknown',eventEvidenceCount:refs.length,eventEvidenceMsgIds:refs}})
}

export function todoRefs(db: Database, topicId: string): Array<{todoId:string;status:string;bucket:string;matchedMsgIds:string[]}> {
  const topic = db.prepare(`SELECT t.chat_id,c.is_group,c.blocked,p.enabled FROM discussion_topics t JOIN chats c ON c.chat_id=t.chat_id
    JOIN group_topic_preferences p ON p.chat_id=t.chat_id WHERE t.topic_id=?`).get(topicId) as {chat_id:string;is_group:number;blocked:number;enabled:number}|undefined
  if(!topic || topic.is_group!==1 || topic.blocked===1 || topic.enabled!==1) return []
  const rows = db.prepare('SELECT id,status,bucket,source_msg_ids FROM todos WHERE chat_id=?').all(topic.chat_id) as Array<{id:string;status:string;bucket:string;source_msg_ids:string}>
  const sourceIds = new Set((db.prepare('SELECT msg_id FROM topic_evidence WHERE topic_id=?').all(topicId) as Array<{msg_id:string}>).map((r)=>r.msg_id))
  return rows.map((todo)=>({todo,matched: (JSON.parse(todo.source_msg_ids) as string[]).filter((id)=>sourceIds.has(id))})).filter(({matched})=>matched.length>0)
    .map(({todo,matched})=>({todoId:todo.id,status:todo.status,bucket:todo.bucket,matchedMsgIds:matched}))
}

export const GROUP_TOPICS_VALIDATOR_VERSION='group-topics-validator-v2'
function completionDigest(input:TopicMessageInput[],versions:AnalysisVersions):string {
  return createHash('sha256').update(JSON.stringify({messages:input.map((m)=>[m.msgId,m.ts,m.direction,m.text]),promptVersion:versions.promptVersion,promptHash:versions.promptHash,schemaVersion:versions.schemaVersion,schemaHash:versions.schemaHash,validatorVersion:versions.validatorVersion}),'utf8').digest('hex')
}

export function recordFailure(db: Database, chatId: string, input: TopicMessageInput[], versions: AnalysisVersions, errorCode='analysis_failed'): void {
  const digest=completionDigest(input,versions)
  db.prepare(`INSERT INTO topic_analysis_runs(run_id,chat_id,input_digest,prompt_version,prompt_hash,schema_version,schema_hash,state,error_code,created_at)
    VALUES(?,?,?,?,?, ?,?,'failed',?,?) ON CONFLICT(chat_id,input_digest) DO UPDATE SET state='failed',error_code=excluded.error_code,created_at=excluded.created_at WHERE topic_analysis_runs.state<>'complete'`)
    .run(randomUUID(),chatId,digest,versions.promptVersion,versions.promptHash,versions.schemaVersion,versions.schemaHash,errorCode,new Date().toISOString())
}

export function completedInputExists(db: Database, chatId: string, input: TopicMessageInput[], versions: AnalysisVersions): boolean {
  const digest=completionDigest(input,versions)
  return !!db.prepare("SELECT 1 FROM topic_analysis_runs WHERE chat_id=? AND input_digest=? AND state='complete'").get(chatId,digest)
}
