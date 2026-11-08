import { createHash, randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { TopicAnalysis, TopicMessageInput, TopicView } from './domain'
import { getMessagesByChatAndIds, getRecentByChat } from '../../db/messages.repo'
import { assertIdentitySnapshotCurrent, identityMetaState, insertIdentityEvent, releaseIdentitySourceAttempt, syncTopicIdentityTerms } from '../../db/identity.repo'
import type { IdentityCandidate, IdentityContextSnapshot } from '../../../shared/identityDecision'
import { IDENTITY_QUERY_VERSION } from '../../../shared/identityDecision'
import { runImmediateTransaction, sharedSourceRows, type ChatSourceLease } from '../../db/sourceCache'

export const GROUP_TOPICS_SCHEMA_VERSION = 3

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
      error_code TEXT,
      failure_stage TEXT CHECK(failure_stage IS NULL OR failure_stage IN ('provider_resolve','provider_complete','response_decode','domain_validate','persist')),
      failure_path TEXT CHECK(failure_path IS NULL OR failure_path IN ('$','$.topics','$.topics[*].ref','$.topics[*].title','$.topics[*].summary','$.assignments','$.assignments[*]','$.assignments[*].msgId','$.assignments[*].topicRef','$.assignments[*].relation','$.assignments[*].confidence','$.assignments[*].relevance','$.assignments[*].relevanceEvidenceMsgIds')),
      failure_reason TEXT CHECK(failure_reason IS NULL OR failure_reason IN ('invalid_shape','invalid_value','duplicate_ref','duplicate_assignment','unknown_message_ref','unknown_topic_ref','missing_assignment','invalid_evidence','too_many_topics','invalid_json','provider_unavailable','invalid_config','not_authenticated','not_installed','timeout','rate_limited','quota_exceeded','bad_output','transport','unknown','persistence_failed','analysis_failed')),
      provider_kind TEXT CHECK(provider_kind IS NULL OR provider_kind IN ('http','cli','unknown')),
      created_at TEXT NOT NULL, UNIQUE(chat_id,input_digest), FOREIGN KEY(chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS topic_message_checkpoints (
      chat_id TEXT PRIMARY KEY, baseline_ts INTEGER NOT NULL, baseline_msg_id TEXT NOT NULL,
      FOREIGN KEY(chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE
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
    -- Existing topic evidence is preserved; conflicting rows leave this feature migration unready.
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
  // v1 -> v2: feature-owned triggers invalidate durable source leases when
  // GroupTopics scope preferences change. The additive columns, triggers and
  // version marker share this one feature-owned transaction.
  const upgrade = db.transaction(() => {
    const metaVersion = Number((db.prepare("SELECT value FROM group_topics_meta WHERE key='schema_version'").get() as {value:string}|undefined)?.value ?? '1')
    const columns = new Set((db.prepare('PRAGMA table_info(topic_analysis_runs)').all() as Array<{name:string}>).map((column) => column.name))
    const additiveColumns: Array<[string,string]> = [
      ['failure_stage', "TEXT CHECK(failure_stage IS NULL OR failure_stage IN ('provider_resolve','provider_complete','response_decode','domain_validate','persist'))"],
      ['failure_path', "TEXT CHECK(failure_path IS NULL OR failure_path IN ('$','$.topics','$.topics[*].ref','$.topics[*].title','$.topics[*].summary','$.assignments','$.assignments[*]','$.assignments[*].msgId','$.assignments[*].topicRef','$.assignments[*].relation','$.assignments[*].confidence','$.assignments[*].relevance','$.assignments[*].relevanceEvidenceMsgIds'))"],
      ['failure_reason', "TEXT CHECK(failure_reason IS NULL OR failure_reason IN ('invalid_shape','invalid_value','duplicate_ref','duplicate_assignment','unknown_message_ref','unknown_topic_ref','missing_assignment','invalid_evidence','too_many_topics','invalid_json','provider_unavailable','invalid_config','not_authenticated','not_installed','timeout','rate_limited','quota_exceeded','bad_output','transport','unknown','persistence_failed','analysis_failed'))"],
      ['provider_kind', "TEXT CHECK(provider_kind IS NULL OR provider_kind IN ('http','cli','unknown'))"]
    ]
    for (const [name, definition] of additiveColumns) {
      if (!columns.has(name)) db.exec(`ALTER TABLE topic_analysis_runs ADD COLUMN ${name} ${definition}`)
    }
    const hasSourceCache = (db.prepare("SELECT 1 AS yes FROM sqlite_master WHERE type='table' AND name='chat_context_cache'").get() as {yes:number}|undefined)?.yes === 1
    if (hasSourceCache) db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_group_topic_preferences_cache_after_insert
      AFTER INSERT ON group_topic_preferences
      BEGIN
        UPDATE chat_context_cache SET scope_revision=scope_revision+1,state_version=state_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id=NEW.chat_id;
      END;
      CREATE TRIGGER IF NOT EXISTS trg_group_topic_preferences_cache_after_update
      AFTER UPDATE OF enabled,cross_chat_enabled ON group_topic_preferences
      WHEN OLD.enabled IS NOT NEW.enabled OR OLD.cross_chat_enabled IS NOT NEW.cross_chat_enabled
      BEGIN
        UPDATE chat_context_cache SET scope_revision=scope_revision+1,state_version=state_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id=NEW.chat_id;
      END;
      CREATE TRIGGER IF NOT EXISTS trg_group_topic_preferences_cache_after_delete
      AFTER DELETE ON group_topic_preferences
      BEGIN
        UPDATE chat_context_cache SET scope_revision=scope_revision+1,state_version=state_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id=OLD.chat_id;
      END;
    `)
    if (metaVersion < 3) {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS ux_discussion_topics_chat_id ON discussion_topics(chat_id,topic_id);
        CREATE INDEX IF NOT EXISTS idx_topic_evidence_source ON topic_evidence(msg_id,topic_id);
        CREATE TABLE IF NOT EXISTS topic_identity_terms (
          chat_id TEXT NOT NULL, term TEXT NOT NULL CHECK(length(term) BETWEEN 1 AND 128), topic_id TEXT NOT NULL,
          indexed_revision INTEGER NOT NULL CHECK(indexed_revision>0), term_kind TEXT NOT NULL CHECK(term_kind IN ('current','historical')),
          PRIMARY KEY(chat_id,term,topic_id,term_kind),
          FOREIGN KEY(chat_id,topic_id) REFERENCES discussion_topics(chat_id,topic_id) ON DELETE RESTRICT ON UPDATE RESTRICT
        );
        CREATE INDEX IF NOT EXISTS idx_topic_identity_terms_entity ON topic_identity_terms(chat_id,topic_id,term_kind,indexed_revision);
        CREATE INDEX IF NOT EXISTS idx_topic_identity_terms_cross_chat ON topic_identity_terms(term,chat_id,topic_id);
        CREATE TABLE IF NOT EXISTS topic_identity_aliases (
          alias_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, topic_id TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision>0), created_at TEXT NOT NULL, UNIQUE(chat_id,topic_id,revision),
          FOREIGN KEY(chat_id,topic_id) REFERENCES discussion_topics(chat_id,topic_id) ON DELETE RESTRICT ON UPDATE RESTRICT
        );
        CREATE TABLE IF NOT EXISTS topic_identity_decisions (
          decision_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, source_digest TEXT NOT NULL CHECK(length(source_digest)=64), draft_ref TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK(outcome IN ('update_existing','new','link','defer')), state TEXT NOT NULL CHECK(state IN ('open','resolved','stale','dismissed')),
          canonical_topic_id TEXT, decision_revision INTEGER NOT NULL CHECK(decision_revision>=1), source_epoch INTEGER NOT NULL CHECK(source_epoch>=1),
          scope_revision INTEGER NOT NULL CHECK(scope_revision>=1), identity_revision INTEGER NOT NULL CHECK(identity_revision>=0),
          draft_json TEXT NOT NULL CHECK(json_valid(draft_json)), candidate_snapshot_json TEXT NOT NULL CHECK(json_valid(candidate_snapshot_json)),
          reason_codes_json TEXT NOT NULL CHECK(json_valid(reason_codes_json)), prompt_version TEXT NOT NULL, schema_version TEXT NOT NULL,
          query_version TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(chat_id,source_digest,draft_ref,decision_revision), UNIQUE(decision_id,chat_id),
          FOREIGN KEY(chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE ON UPDATE RESTRICT,
          FOREIGN KEY(chat_id,canonical_topic_id) REFERENCES discussion_topics(chat_id,topic_id) ON DELETE RESTRICT ON UPDATE RESTRICT
        );
        CREATE INDEX IF NOT EXISTS idx_topic_identity_decisions_keyset ON topic_identity_decisions(chat_id,state,decision_id);
        CREATE INDEX IF NOT EXISTS idx_topic_identity_decisions_canonical ON topic_identity_decisions(chat_id,canonical_topic_id);
        CREATE TABLE IF NOT EXISTS topic_identity_decision_sources (
          decision_id TEXT NOT NULL, chat_id TEXT NOT NULL, msg_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=0),
          evidence_role TEXT NOT NULL CHECK(evidence_role IN ('discussion','date','participant','counterevidence')),
          PRIMARY KEY(decision_id,msg_id), UNIQUE(decision_id,ordinal),
          FOREIGN KEY(decision_id,chat_id) REFERENCES topic_identity_decisions(decision_id,chat_id) ON DELETE CASCADE ON UPDATE RESTRICT,
          FOREIGN KEY(chat_id,msg_id) REFERENCES messages(chat_id,msg_id) ON DELETE RESTRICT ON UPDATE RESTRICT
        );
        CREATE INDEX IF NOT EXISTS idx_topic_identity_sources_inbox ON topic_identity_decision_sources(chat_id,msg_id,decision_id);
        CREATE TABLE IF NOT EXISTS topic_identity_events (
          event_id TEXT PRIMARY KEY, decision_id TEXT NOT NULL, event_revision INTEGER NOT NULL CHECK(event_revision>=1),
          actor TEXT NOT NULL CHECK(actor IN ('ai','user','system')),
          action TEXT NOT NULL CHECK(action IN ('created','deferred','stale','retried','resolved_existing','resolved_new','updated_existing','linked','dismissed')),
          payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), created_at TEXT NOT NULL, UNIQUE(decision_id,event_revision),
          FOREIGN KEY(decision_id) REFERENCES topic_identity_decisions(decision_id) ON DELETE RESTRICT ON UPDATE RESTRICT
        );
        CREATE TABLE IF NOT EXISTS topic_link_identity_events (
          event_id TEXT PRIMARY KEY, link_id TEXT NOT NULL, event_revision INTEGER NOT NULL CHECK(event_revision>=1),
          actor TEXT NOT NULL CHECK(actor IN ('user','system')),
          action TEXT NOT NULL CHECK(action IN ('proposed','accepted','rejected','deferred','stale')),
          left_topic_revision INTEGER NOT NULL CHECK(left_topic_revision>=1), right_topic_revision INTEGER NOT NULL CHECK(right_topic_revision>=1),
          permission_snapshot_json TEXT NOT NULL CHECK(json_valid(permission_snapshot_json)), created_at TEXT NOT NULL, UNIQUE(link_id,event_revision),
          FOREIGN KEY(link_id) REFERENCES topic_links(link_id) ON DELETE RESTRICT ON UPDATE RESTRICT
        );
      `)
      const linkColumns=new Set((db.prepare('PRAGMA table_info(topic_links)').all() as Array<{name:string}>).map((column)=>column.name))
      if(!linkColumns.has('stale_at')) db.exec('ALTER TABLE topic_links ADD COLUMN stale_at TEXT;')
      db.exec(`CREATE INDEX IF NOT EXISTS idx_topic_links_left_status ON topic_links(left_topic_id,status,stale_at);
        CREATE INDEX IF NOT EXISTS idx_topic_links_right_status ON topic_links(right_topic_id,status,stale_at);`)
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_topics_identity_insert AFTER INSERT ON discussion_topics BEGIN
          UPDATE chat_context_cache SET topic_identity_revision=topic_identity_revision+1,state_version=state_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id=NEW.chat_id;
          INSERT OR IGNORE INTO identity_index_meta(chat_id,entity_type,tokenizer_version,state,updated_at) VALUES(NEW.chat_id,'topic','identity-query-v2','stale',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
          UPDATE identity_index_meta SET state='stale',cursor_entity_id=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id=NEW.chat_id AND entity_type='topic';
        END;
        CREATE TRIGGER IF NOT EXISTS trg_topics_identity_update AFTER UPDATE OF chat_id,title,summary,last_source_ts ON discussion_topics
        WHEN OLD.chat_id IS NOT NEW.chat_id OR OLD.title IS NOT NEW.title OR OLD.summary IS NOT NEW.summary OR OLD.last_source_ts IS NOT NEW.last_source_ts BEGIN
          INSERT OR IGNORE INTO topic_identity_aliases(alias_id,chat_id,topic_id,title,summary,revision,created_at) VALUES(lower(hex(randomblob(16))),OLD.chat_id,OLD.topic_id,OLD.title,OLD.summary,OLD.revision,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
          UPDATE discussion_topics SET revision=revision+1 WHERE topic_id=NEW.topic_id;
          UPDATE chat_context_cache SET topic_identity_revision=topic_identity_revision+1,state_version=state_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id=OLD.chat_id OR chat_id=NEW.chat_id;
          UPDATE identity_index_meta SET state='stale',cursor_entity_id=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE (chat_id=OLD.chat_id OR chat_id=NEW.chat_id) AND entity_type='topic';
        END;
        CREATE TRIGGER IF NOT EXISTS trg_topic_evidence_identity_insert AFTER INSERT ON topic_evidence BEGIN
          UPDATE discussion_topics SET revision=revision+1 WHERE topic_id=NEW.topic_id;
          UPDATE chat_context_cache SET topic_identity_revision=topic_identity_revision+1,state_version=state_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id=(SELECT chat_id FROM discussion_topics WHERE topic_id=NEW.topic_id);
          UPDATE identity_index_meta SET state='stale',cursor_entity_id=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id=(SELECT chat_id FROM discussion_topics WHERE topic_id=NEW.topic_id) AND entity_type='topic';
        END;
        CREATE TRIGGER IF NOT EXISTS trg_topic_evidence_identity_update AFTER UPDATE OF topic_id,msg_id,relation,confidence,relevance,relevance_evidence_msg_ids ON topic_evidence BEGIN
          UPDATE discussion_topics SET revision=revision+1 WHERE topic_id=OLD.topic_id OR topic_id=NEW.topic_id;
          UPDATE chat_context_cache SET topic_identity_revision=topic_identity_revision+1,state_version=state_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id IN (SELECT chat_id FROM discussion_topics WHERE topic_id=OLD.topic_id OR topic_id=NEW.topic_id);
          UPDATE identity_index_meta SET state='stale',cursor_entity_id=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id IN (SELECT chat_id FROM discussion_topics WHERE topic_id=OLD.topic_id OR topic_id=NEW.topic_id) AND entity_type='topic';
        END;
        CREATE TRIGGER IF NOT EXISTS trg_topic_evidence_identity_delete AFTER DELETE ON topic_evidence BEGIN
          UPDATE discussion_topics SET revision=revision+1 WHERE topic_id=OLD.topic_id;
          UPDATE chat_context_cache SET topic_identity_revision=topic_identity_revision+1,state_version=state_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id=(SELECT chat_id FROM discussion_topics WHERE topic_id=OLD.topic_id);
          UPDATE identity_index_meta SET state='stale',cursor_entity_id=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id=(SELECT chat_id FROM discussion_topics WHERE topic_id=OLD.topic_id) AND entity_type='topic';
        END;
        CREATE TRIGGER IF NOT EXISTS trg_topic_links_identity_insert AFTER INSERT ON topic_links BEGIN
          UPDATE chat_context_cache SET topic_identity_revision=topic_identity_revision+1,state_version=state_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id IN (SELECT chat_id FROM discussion_topics WHERE topic_id=NEW.left_topic_id OR topic_id=NEW.right_topic_id);
        END;
        CREATE TRIGGER IF NOT EXISTS trg_topic_links_identity_update AFTER UPDATE OF relation,identity_evidence,event_evidence_msg_ids,status,stale_at ON topic_links BEGIN
          UPDATE chat_context_cache SET topic_identity_revision=topic_identity_revision+1,state_version=state_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id IN (SELECT chat_id FROM discussion_topics WHERE topic_id=OLD.left_topic_id OR topic_id=OLD.right_topic_id OR topic_id=NEW.left_topic_id OR topic_id=NEW.right_topic_id);
        END;
        CREATE TRIGGER IF NOT EXISTS trg_topic_links_identity_delete AFTER DELETE ON topic_links BEGIN
          UPDATE chat_context_cache SET topic_identity_revision=topic_identity_revision+1,state_version=state_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id IN (SELECT chat_id FROM discussion_topics WHERE topic_id=OLD.left_topic_id OR topic_id=OLD.right_topic_id);
        END;
      `)
      db.exec(`INSERT OR IGNORE INTO identity_index_meta(chat_id,entity_type,tokenizer_version,state,updated_at)
        SELECT c.chat_id,'topic','identity-query-v2',CASE WHEN EXISTS(SELECT 1 FROM discussion_topics t WHERE t.chat_id=c.chat_id) THEN 'building' ELSE 'ready' END,c.last_seen_at FROM chats c;`)
    }
    db.prepare("UPDATE group_topics_meta SET value=? WHERE key='schema_version'").run(String(GROUP_TOPICS_SCHEMA_VERSION))
  })
  upgrade()
}

export function setEnabled(db: Database, chatId: string, enabled: boolean): boolean {
  const chat = db.prepare('SELECT 1 AS x FROM chats WHERE chat_id=?').get(chatId)
  if (!chat) return false
  db.prepare(`INSERT INTO group_topic_preferences(chat_id,enabled,updated_at) VALUES(?,?,?)
    ON CONFLICT(chat_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at`).run(chatId, Number(enabled), new Date().toISOString())
  return true
}

export function isEnabled(db: Database, chatId: string): boolean {
  return (db.prepare('SELECT enabled FROM group_topic_preferences WHERE chat_id=?').get(chatId) as { enabled: number } | undefined)?.enabled === 1
}

export function loadMessages(db: Database, chatId: string, limit = 100): TopicMessageInput[] {
  const rows = db.prepare("SELECT msg_id FROM messages WHERE chat_id=? AND unsent=0 AND content_type=0 AND text IS NOT NULL AND trim(text)<>'' ORDER BY ts DESC,msg_id DESC LIMIT ?")
    .all(chatId, Math.max(1, Math.min(100, limit))) as Array<{ msg_id: string }>
  const sourceRows = getMessagesByChatAndIds(chatId, rows.reverse().map((row) => row.msg_id), db)
  return sourceRows
    .filter((row) => row.text !== null)
    .map((row) => ({ msgId: row.msgId, ts: row.ts, direction: row.direction, text: (row.text ?? '').slice(0, 3000) }))
}

export interface PendingMessageOptions {
  /** 只考慮這些 msgId（仍須符合所有既有的資格條件）。 */
  restrictToMsgIds?: string[]
  /** 依 messages.processed 篩選；預設 'any' ＝ 不篩。 */
  processedFilter?: 'any' | 'unprocessed' | 'processed'
}

/** loadPendingMessages 與 selectTopicTargets 共用的資格條件：純文字、unsent=0、符合 baseline／checkpoint 規則、尚無 decision。 */
function selectPendingMessageIds(db: Database, chatId: string, limit: number, initialWindow: number, opts: PendingMessageOptions = {}): string[] {
  const extra: string[] = []
  const extraParams: unknown[] = []
  if (opts.restrictToMsgIds) { extra.push('AND m.msg_id IN (SELECT value FROM json_each(?))'); extraParams.push(JSON.stringify(opts.restrictToMsgIds)) }
  if (opts.processedFilter === 'unprocessed') extra.push('AND m.processed=0')
  else if (opts.processedFilter === 'processed') extra.push('AND m.processed=1')
  const extraSql = extra.join(' ')
  const checkpoint = db.prepare(`SELECT baseline_ts,baseline_msg_id FROM topic_message_checkpoints WHERE chat_id=?`).get(chatId) as {baseline_ts:number;baseline_msg_id:string}|undefined
  const legacyCheckpoint = checkpoint ?? db.prepare(`SELECT m.ts,m.msg_id FROM topic_message_decisions d JOIN messages m ON m.msg_id=d.msg_id
    WHERE d.chat_id=? ORDER BY m.ts DESC,m.msg_id DESC LIMIT 1`).get(chatId) as {ts:number;msg_id:string}|undefined
  const rows = legacyCheckpoint
    ? db.prepare(`SELECT m.msg_id FROM messages m
      WHERE m.chat_id=? AND m.unsent=0 AND m.content_type=0 AND m.text IS NOT NULL AND trim(m.text)<>'' AND m.ts>=?
        AND NOT EXISTS (SELECT 1 FROM topic_message_decisions d WHERE d.chat_id=m.chat_id AND d.msg_id=m.msg_id) ${extraSql}
      ORDER BY m.ts,m.msg_id LIMIT ?`).all(chatId,'baseline_ts' in legacyCheckpoint ? legacyCheckpoint.baseline_ts : legacyCheckpoint.ts,...extraParams,limit) as Array<{msg_id:string}>
    : db.prepare(`SELECT m.msg_id FROM messages m
      WHERE m.chat_id=? AND m.unsent=0 AND m.content_type=0 AND m.text IS NOT NULL AND trim(m.text)<>''
        AND m.msg_id IN (SELECT recent.msg_id FROM messages recent WHERE recent.chat_id=? AND recent.unsent=0
          AND recent.content_type=0 AND recent.text IS NOT NULL AND trim(recent.text)<>''
          ORDER BY recent.ts DESC,recent.msg_id DESC LIMIT ?)
        AND NOT EXISTS (SELECT 1 FROM topic_message_decisions d WHERE d.chat_id=m.chat_id AND d.msg_id=m.msg_id) ${extraSql}
      ORDER BY m.ts,m.msg_id LIMIT ?`).all(chatId,chatId,initialWindow,...extraParams,limit) as Array<{msg_id:string}>
  return rows.map((row) => row.msg_id)
}

/** Only undecided messages in a bounded recent window are eligible for a new run. */
export function loadPendingMessages(db: Database, chatId: string, limit = 100, initialWindow = limit, opts: PendingMessageOptions = {}): TopicMessageInput[] {
  const boundedLimit = Math.max(1, Math.min(100, limit))
  const boundedInitialWindow = Math.max(boundedLimit, Math.min(100, initialWindow))
  const ids = selectPendingMessageIds(db, chatId, boundedLimit, boundedInitialWindow, opts)
  const sourceRows = getMessagesByChatAndIds(chatId, ids, db)
  return sourceRows
    .filter((row) => row.text !== null)
    .map((row) => ({ msgId: row.msgId, ts: row.ts, direction: row.direction, text: (row.text ?? '').slice(0,3000) }))
}

/** msgIds 中符合議題分析資格的子集（與 loadPendingMessages 同一組條件，含 checkpoint／最近 100 則視窗），依 ts、msgId 排序。 */
export function selectTopicTargets(db: Database, chatId: string, msgIds: string[]): string[] {
  if (!msgIds.length) return []
  return selectPendingMessageIds(db, chatId, Math.min(100, msgIds.length), 100, { restrictToMsgIds: msgIds })
}

/**
 * 集合 B（processed=1 且尚無議題決策）的真實數量：與 loadPendingMessages 同一組資格條件與視窗，但不受單次 100 則的上限截斷。
 * 合併整理開啟時，「補分析舊訊息」只處理這一集合。
 */
export function countBacklogMessages(db: Database, chatId: string): number {
  return selectPendingMessageIds(db, chatId, 1_000_000, 100, { processedFilter: 'processed' }).length
}

export function countPendingMessages(db: Database, chatId: string, limit = 100, opts: PendingMessageOptions = {}): number {
  const pending = loadPendingMessages(db,chatId,Math.min(100,limit),Math.min(100,limit),opts).length
  return pending === Math.min(100,limit) ? pending + 1 : pending
}

export function loadTopicCandidates(db: Database, chatId: string): Array<{ref:string;title:string;summary:string}> {
  return db.prepare('SELECT local_ref AS ref,title,summary FROM discussion_topics WHERE chat_id=? ORDER BY last_source_ts DESC LIMIT 100').all(chatId) as Array<{ref:string;title:string;summary:string}>
}

export type AnalysisVersions={promptVersion:string;promptHash:string;schemaVersion:string;schemaHash:string;validatorVersion:string}
export interface TopicIdentitySaveContext {
  snapshot:IdentityContextSnapshot
  sourceLease:ChatSourceLease
  candidates:IdentityCandidate[]
  candidatesTruncated:boolean
}

/**
 * 組成議題落庫的交易本體（尚未執行）與租約要比對的 selectedRows。saveAnalysis 是它的薄包裝。
 * `skipSnapshotAssert`：呼叫端已在同一交易內先行斷言過 identity 快照時略過本體開頭的 topic 快照斷言。
 *
 * 警告：開啟後本體內沒有任何替代的快照斷言。呼叫端必須在「同一個交易」、「本體執行之前」，
 * 對 todo 與 topic 兩類各呼叫一次 assertIdentitySnapshotCurrent；漏做就會在沒有任何提示下，
 * 以過期的候選快照提交。只有合併提交路徑應該傳 true。另外 wasIdentityReady 在 build 時取得，
 * 呼叫端要在交易內才呼叫 buildTopicSave，行為才與 saveAnalysis 一致。
 */
export function buildTopicSave(db: Database, chatId: string, input: TopicMessageInput[], result: TopicAnalysis, versions: AnalysisVersions, identity?:TopicIdentitySaveContext, opts: {skipSnapshotAssert?:boolean} = {}): { tx: () => boolean | 'inactive'; selectedRows: IdentityContextSnapshot['selectedFingerprints'] } {
  const digest = completionDigest(input, versions)
  const runId = randomUUID()
  const now = new Date().toISOString()
  const wasIdentityReady=identityMetaState(db,chatId,'topic')==='ready'
  const tx = db.transaction(() => {
    if(identity&&!opts.skipSnapshotAssert) assertIdentitySnapshotCurrent(db,chatId,identity.snapshot,'topic')
    const active = db.prepare(`SELECT p.enabled FROM chats c
      LEFT JOIN group_topic_preferences p ON p.chat_id=c.chat_id WHERE c.chat_id=?`).get(chatId) as {enabled:number|null}|undefined
    if (!active || active.enabled !== 1) return 'inactive' as const
    const existing = db.prepare('SELECT state FROM topic_analysis_runs WHERE chat_id=? AND input_digest=?').get(chatId,digest) as { state: string } | undefined
    if (existing?.state === 'complete') return false
    db.prepare(`INSERT INTO topic_analysis_runs(run_id,chat_id,input_digest,prompt_version,prompt_hash,schema_version,schema_hash,state,error_code,created_at)
      VALUES(?,?,?,?,?,?,?,'complete',NULL,?) ON CONFLICT(chat_id,input_digest) DO UPDATE SET run_id=excluded.run_id,
      prompt_version=excluded.prompt_version,prompt_hash=excluded.prompt_hash,schema_version=excluded.schema_version,schema_hash=excluded.schema_hash,state='complete',error_code=NULL,
      failure_stage=NULL,failure_path=NULL,failure_reason=NULL,provider_kind=NULL,created_at=excluded.created_at`).run(runId,chatId,digest,versions.promptVersion,versions.promptHash,versions.schemaVersion,versions.schemaHash,now)
    const refs = new Map<string,string>()
    const touchedTopicIds=new Set<string>()
    const identityByRef=new Map((result.identityDecisions??[]).map((decision)=>[decision.draftRef,decision]))
    const createTopic=(topic:TopicAnalysis['topics'][number]):string=>{
      const topicId=randomUUID()
      const localRefExists=db.prepare('SELECT 1 AS yes FROM discussion_topics WHERE chat_id=? AND local_ref=?').get(chatId,topic.ref)
      const localRef=localRefExists?`${topic.ref}-${runId.slice(0,8)}`:topic.ref
      db.prepare(`INSERT INTO discussion_topics(topic_id,chat_id,local_ref,title,summary,created_at,last_source_ts,revision) VALUES(?,?,?,?,?,?,?,1)`)
        .run(topicId,chatId,localRef,topic.title,topic.summary,now,input.at(-1)?.ts??Date.now())
      return topicId
    }
    for (const topic of result.topics) {
      const identityDecision=identity?identityByRef.get(topic.ref):undefined
      if(identity&&!identityDecision) throw new Error('topic_identity_decision_missing')
      let topicId:string|null=null
      if(identityDecision?.outcome==='update_existing'&&identity) {
        const revision=identity.snapshot.candidateRevisions.find((candidate)=>candidate.entityType==='topic'&&candidate.entityId===identityDecision.candidateId)
        const current=db.prepare('SELECT revision FROM discussion_topics WHERE chat_id=? AND topic_id=?').get(chatId,identityDecision.candidateId) as {revision:number}|undefined
        if(!revision||!current||current.revision!==revision.revision) throw new Error('topic_identity_candidate_stale')
        topicId=identityDecision.candidateId!
        db.prepare('UPDATE discussion_topics SET title=?,summary=?,last_source_ts=max(last_source_ts,?) WHERE chat_id=? AND topic_id=?')
          .run(topic.title,topic.summary,input.at(-1)?.ts??Date.now(),chatId,topicId)
      } else {
        topicId=createTopic(topic)
      }
      if(topicId) refs.set(topic.ref,topicId)
      if(topicId) touchedTopicIds.add(topicId)
      if(identity&&identityDecision){
        const decisionId=randomUUID()
        const decisionRevision=(db.prepare('SELECT COALESCE(MAX(decision_revision),0)+1 AS revision FROM topic_identity_decisions WHERE chat_id=? AND source_digest=? AND draft_ref=?').get(chatId,digest,topic.ref) as {revision:number}).revision
        const canonical=topicId
        const candidateIds=identityDecision.candidateId?[identityDecision.candidateId]:[]
        const revisions=candidateIds.map((id)=>identity.snapshot.candidateRevisions.find((candidate)=>candidate.entityType==='topic'&&candidate.entityId===id)??null)
        db.prepare(`INSERT INTO topic_identity_decisions(decision_id,chat_id,source_digest,draft_ref,outcome,state,canonical_topic_id,decision_revision,source_epoch,scope_revision,identity_revision,draft_json,candidate_snapshot_json,reason_codes_json,prompt_version,schema_version,query_version,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(decisionId,chatId,digest,topic.ref,identityDecision.outcome,'resolved',canonical,decisionRevision,identity.snapshot.sourceEpoch,identity.snapshot.scopeRevision,identity.snapshot.topicIdentityRevision,JSON.stringify(topic),JSON.stringify({candidateIds,revisions}),JSON.stringify([identityDecision.reasonCode]),versions.promptVersion,versions.schemaVersion,IDENTITY_QUERY_VERSION,now,now)
        const insertSource=db.prepare('INSERT INTO topic_identity_decision_sources(decision_id,chat_id,msg_id,ordinal,evidence_role) VALUES(?,?,?,?,?)')
        identityDecision.evidenceMsgIds.forEach((msgId,index)=>insertSource.run(decisionId,chatId,msgId,index,'discussion'))
        const eventAction=identityDecision.outcome==='link'?'linked':identityDecision.outcome==='update_existing'?'updated_existing':'resolved_new'
        insertIdentityEvent(db,{decisionId,revision:1,actor:'ai',action:eventAction,payload:{draftRef:topic.ref,candidateId:identityDecision.candidateId,reasonCode:identityDecision.reasonCode},table:'topic_identity_events'})
        if(identityDecision.outcome==='link'&&topicId&&identityDecision.candidateId){
          const pair=[topicId,identityDecision.candidateId].sort()
          const relation=identityDecision.relationKind==='recurrence'?'same_occurrence':identityDecision.relationKind==='follow_up'?'follow_up':'related'
          const eventEvidence=JSON.stringify(identityDecision.evidenceMsgIds)
          const linkId=randomUUID()
          db.prepare(`INSERT INTO topic_links(link_id,left_topic_id,right_topic_id,relation,identity_evidence,event_evidence_msg_ids,status,created_at) VALUES(?,?,?,?,'unknown',?,'proposed',?)`)
            .run(linkId,pair[0],pair[1],relation,eventEvidence,now)
          const leftRevision=(db.prepare('SELECT revision FROM discussion_topics WHERE topic_id=?').get(pair[0]) as {revision:number}).revision
          const rightRevision=(db.prepare('SELECT revision FROM discussion_topics WHERE topic_id=?').get(pair[1]) as {revision:number}).revision
          db.prepare(`INSERT INTO topic_link_identity_events(event_id,link_id,event_revision,actor,action,left_topic_revision,right_topic_revision,permission_snapshot_json,created_at) VALUES(?,?,1,'system','proposed',?,?,?,?)`)
            .run(randomUUID(),linkId,leftRevision,rightRevision,JSON.stringify({chatId,enabled:true,crossChat:false}),now)
        }
      }
    }
    const allowed = new Set(input.map((m) => m.msgId))
    const changedIds = [...allowed]
    const changedTopics = changedIds.length ? db.prepare(`SELECT DISTINCT topic_id FROM topic_evidence WHERE msg_id IN (${changedIds.map(()=>'?').join(',')})`).all(...changedIds) as Array<{topic_id:string}> : []
    const staleLinks = db.prepare("SELECT link_id,left_topic_id,right_topic_id,event_evidence_msg_ids FROM topic_links WHERE status='proposed' AND stale_at IS NULL").all() as Array<{link_id:string;left_topic_id:string;right_topic_id:string;event_evidence_msg_ids:string}>
    const changedTopicIds = new Set(changedTopics.map((row)=>row.topic_id))
    for (const link of staleLinks) {
      let evidenceIds: string[] = []
      try { evidenceIds = JSON.parse(link.event_evidence_msg_ids) as string[] } catch { /* malformed historical refs are invalidated */ }
      if (changedTopicIds.has(link.left_topic_id) || changedTopicIds.has(link.right_topic_id) || evidenceIds.some((id)=>allowed.has(id))) {
        db.prepare('UPDATE topic_links SET stale_at=? WHERE link_id=? AND stale_at IS NULL').run(now,link.link_id)
        const left=(db.prepare('SELECT revision FROM discussion_topics WHERE topic_id=?').get(link.left_topic_id) as {revision:number}|undefined)?.revision??1
        const right=(db.prepare('SELECT revision FROM discussion_topics WHERE topic_id=?').get(link.right_topic_id) as {revision:number}|undefined)?.revision??1
        const eventRevision=(db.prepare('SELECT COALESCE(MAX(event_revision),0)+1 AS revision FROM topic_link_identity_events WHERE link_id=?').get(link.link_id) as {revision:number}).revision
        db.prepare(`INSERT INTO topic_link_identity_events(event_id,link_id,event_revision,actor,action,left_topic_revision,right_topic_revision,permission_snapshot_json,created_at) VALUES(?,?,?,'system','stale',?,?,?,?)`)
          .run(randomUUID(),link.link_id,eventRevision,left,right,JSON.stringify({chatId,sourceChange:true}),now)
      }
    }
    const writeDecision = db.prepare(`INSERT INTO topic_message_decisions(chat_id,msg_id,run_id,disposition) VALUES(?,?,?,?)
      ON CONFLICT(chat_id,msg_id) DO UPDATE SET run_id=excluded.run_id,disposition=excluded.disposition`)
    const writeEvidence = (topicId:string,assignment:TopicAnalysis['assignments'][number])=>{
      const evidenceIds=JSON.stringify(assignment.relevanceEvidenceMsgIds.filter((id)=>allowed.has(id)))
      const existing=db.prepare('SELECT topic_id FROM topic_evidence WHERE msg_id=?').get(assignment.msgId) as {topic_id:string}|undefined
      if(existing){
        db.prepare(`UPDATE topic_evidence SET topic_id=?,relation=?,confidence=?,relevance=?,relevance_evidence_msg_ids=?,run_id=? WHERE msg_id=?`)
          .run(topicId,assignment.relation,assignment.confidence,assignment.relevance,evidenceIds,runId,assignment.msgId)
      } else {
        db.prepare(`INSERT INTO topic_evidence(topic_id,msg_id,relation,confidence,relevance,relevance_evidence_msg_ids,run_id) VALUES(?,?,?,?,?,?,?)`)
          .run(topicId,assignment.msgId,assignment.relation,assignment.confidence,assignment.relevance,evidenceIds,runId)
      }
      touchedTopicIds.add(topicId)
    }
    for (const assignment of result.assignments) {
      const topicId = assignment.topicRef ? refs.get(assignment.topicRef) : undefined
      writeDecision.run(chatId,assignment.msgId,runId,topicId ? (assignment.relation==='uncertain'?'uncertain':'assigned') : 'not_topic')
      if (topicId) writeEvidence(topicId,assignment)
      else {
        const previous=db.prepare('SELECT topic_id FROM topic_evidence WHERE msg_id=?').get(assignment.msgId) as {topic_id:string}|undefined
        if(previous){
          db.prepare(`UPDATE topic_evidence SET relation='uncertain',confidence=0,relevance='unknown',relevance_evidence_msg_ids='[]',run_id=? WHERE msg_id=?`).run(runId,assignment.msgId)
          touchedTopicIds.add(previous.topic_id)
        }
      }
    }
    const firstInput = input[0]
    if (firstInput) db.prepare(`INSERT OR IGNORE INTO topic_message_checkpoints(chat_id,baseline_ts,baseline_msg_id) VALUES(?,?,?)`)
      .run(chatId,firstInput.ts,firstInput.msgId)
    for(const row of changedTopics) touchedTopicIds.add(row.topic_id)
    for(const topicId of touchedTopicIds) syncTopicIdentityTerms(db,chatId,topicId,wasIdentityReady)
    return true
  })
  return { tx, selectedRows: identity?identity.snapshot.selectedFingerprints:[] }
}

export function saveAnalysis(db: Database, chatId: string, input: TopicMessageInput[], result: TopicAnalysis, versions: AnalysisVersions, identity?:TopicIdentitySaveContext): boolean | 'inactive' {
  const { tx, selectedRows } = buildTopicSave(db, chatId, input, result, versions, identity)
  if(!identity) return tx()
  if(!identity.sourceLease) throw new Error('topic_identity_source_lease_required')
  let innerResult:boolean|'inactive'=false
  let applyFailure:string|null=null
  try {
    const committed=sharedSourceRows(db).commitLease({
      lease:identity.sourceLease,selectedRows,fallbackRecent:()=>getRecentByChat(chatId,10,db),
      apply:()=>{
        innerResult=runImmediateTransaction(tx)
        if(innerResult!==true) {applyFailure=innerResult==='inactive'?'inactive':'already_complete';throw new Error(`topic_identity_${applyFailure}`)}
      }
    })
    if(!committed.ok) {releaseIdentitySourceAttempt(db,identity.sourceLease,true);return false}
    return innerResult
  } catch(error) {
    if(applyFailure!==null) releaseIdentitySourceAttempt(db,identity.sourceLease,true)
    if(applyFailure==='inactive') return 'inactive'
    if(applyFailure==='already_complete') return false
    throw error
  }
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

export function todoRefs(db: Database, topicId: string): Array<{todoId:string;status:string;bucket:string;matchedMsgIds:string[]}> {
  const topic = db.prepare(`SELECT t.chat_id,p.enabled FROM discussion_topics t JOIN chats c ON c.chat_id=t.chat_id
    JOIN group_topic_preferences p ON p.chat_id=t.chat_id WHERE t.topic_id=?`).get(topicId) as {chat_id:string;enabled:number}|undefined
  if(!topic || topic.enabled!==1) return []
  const rows = db.prepare('SELECT id,status,bucket,source_msg_ids FROM todos WHERE chat_id=?').all(topic.chat_id) as Array<{id:string;status:string;bucket:string;source_msg_ids:string}>
  const sourceIds = new Set((db.prepare('SELECT msg_id FROM topic_evidence WHERE topic_id=?').all(topicId) as Array<{msg_id:string}>).map((r)=>r.msg_id))
  return rows.map((todo)=>({todo,matched: (JSON.parse(todo.source_msg_ids) as string[]).filter((id)=>sourceIds.has(id))})).filter(({matched})=>matched.length>0)
    .map(({todo,matched})=>({todoId:todo.id,status:todo.status,bucket:todo.bucket,matchedMsgIds:matched}))
}

export const GROUP_TOPICS_VALIDATOR_VERSION='group-topics-validator-v4'
function completionDigest(input:TopicMessageInput[],versions:AnalysisVersions):string {
  return createHash('sha256').update(JSON.stringify({messages:input.map((m)=>[m.msgId,m.ts,m.direction,m.text]),promptVersion:versions.promptVersion,promptHash:versions.promptHash,schemaVersion:versions.schemaVersion,schemaHash:versions.schemaHash,validatorVersion:versions.validatorVersion}),'utf8').digest('hex')
}

export type TopicFailureStage='provider_resolve'|'provider_complete'|'response_decode'|'domain_validate'|'persist'
export type TopicProviderKind='http'|'cli'|'unknown'
export type TopicFailureRecord={stage:TopicFailureStage;code:string;path?:string|null;reason:string;providerKind:TopicProviderKind}

export function recordFailure(db: Database, chatId: string, input: TopicMessageInput[], versions: AnalysisVersions, failure:TopicFailureRecord): void {
  const digest=completionDigest(input,versions)
  db.prepare(`INSERT INTO topic_analysis_runs(run_id,chat_id,input_digest,prompt_version,prompt_hash,schema_version,schema_hash,state,error_code,failure_stage,failure_path,failure_reason,provider_kind,created_at)
    VALUES(?,?,?,?,?, ?,?,'failed',?,?,?,?,?,?) ON CONFLICT(chat_id,input_digest) DO UPDATE SET state='failed',error_code=excluded.error_code,failure_stage=excluded.failure_stage,failure_path=excluded.failure_path,failure_reason=excluded.failure_reason,provider_kind=excluded.provider_kind,created_at=excluded.created_at WHERE topic_analysis_runs.state<>'complete'`)
    .run(randomUUID(),chatId,digest,versions.promptVersion,versions.promptHash,versions.schemaVersion,versions.schemaHash,failure.code,failure.stage,failure.path ?? null,failure.reason,failure.providerKind,new Date().toISOString())
}

export function completedInputExists(db: Database, chatId: string, input: TopicMessageInput[], versions: AnalysisVersions): boolean {
  const digest=completionDigest(input,versions)
  return !!db.prepare("SELECT 1 FROM topic_analysis_runs WHERE chat_id=? AND input_digest=? AND state='complete'").get(chatId,digest)
}
