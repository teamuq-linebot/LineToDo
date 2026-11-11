import { createHash } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { deriveMsgId, MESSAGE_PARTICIPANTS_DDL } from './schema'
import { insertMessages } from './messages.repo'
import type { LineImportBatch } from '../line/importTypes'
import type { ParticipantIdentityProvider } from '../line/identity'
import { isLineAvatarSchemaReady, writeImportAvatarMeta } from './lineAvatar.repo'

export const LINE_IMPORT_SCHEMA_VERSION = 1

export function isLineImportSchemaReady(db: Database): boolean {
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('line_import_meta','message_participants','line_import_batches')`).all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name)).size === 3
}

/** Additive import-owned tables. Kept outside core user_version so failure cannot block TODO startup. */
export function ensureLineImportSchema(db: Database): void {
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS line_import_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      ${MESSAGE_PARTICIPANTS_DDL}
      CREATE TABLE IF NOT EXISTS line_import_batches (
        batch_id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK(source IN ('line-watch','line-backfill')),
        cursor_from_created_time INTEGER NOT NULL,
        cursor_from_row_id INTEGER NOT NULL,
        cursor_to_created_time INTEGER NOT NULL,
        cursor_to_row_id INTEGER NOT NULL,
        row_count INTEGER NOT NULL,
        keyed_identity_count INTEGER NOT NULL,
        unknown_identity_count INTEGER NOT NULL,
        has_more INTEGER NOT NULL CHECK(has_more IN (0,1)),
        coverage_status TEXT NOT NULL CHECK(coverage_status IN ('complete','partial','unknown')),
        observed_at TEXT NOT NULL,
        committed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_line_import_batches_source_cursor ON line_import_batches(source,cursor_to_created_time,cursor_to_row_id);
    `)
    db.prepare('INSERT OR IGNORE INTO line_import_meta(key,value) VALUES (\'schema_version\',?)').run(String(LINE_IMPORT_SCHEMA_VERSION))
  })
  tx()
}

export interface CommitLineImportResult {
  inserted: number
  insertedMsgIds: string[]
  mediaBackfilled: number
  unsentMarked: number
  metadataBackfilled: number
  chatIds: string[]
  receiptInserted: boolean
  keyedIdentityCount: number
  unknownIdentityCount: number
}

function epochFor(provider: ParticipantIdentityProvider): string | null {
  try { return provider.epoch() } catch { return null }
}

/**
 * Atomically persists legacy message rows, local pseudonyms and source coverage.
 * Apart from the account MID and `participant_key`, a raw sender MID exists only in this call frame and in the sender-profile table that
 * lineAvatar.repo.ts owns (incoming messages only, never the account MID). SQL always binds it as a parameter.
 */
export function commitLineImportBatch(
  db: Database,
  batch: LineImportBatch,
  identity: ParticipantIdentityProvider,
  options: { processedBeforeMs?: number } = {},
): CommitLineImportResult {
  const epoch = epochFor(identity)
  const committedAt = new Date().toISOString()
  const tx = db.transaction((): CommitLineImportResult => {
    if (epoch) {
      const current = db.prepare('SELECT value FROM line_import_meta WHERE key=\'identity_epoch\'').get() as { value: string } | undefined
      if (current && current.value !== epoch) {
        db.prepare(`UPDATE message_participants SET participant_key=NULL, scope='unknown', key_version=NULL,
          identity_status='unknown', identity_reason='identity_epoch_changed'`).run()
      }
      db.prepare(`INSERT INTO line_import_meta(key,value) VALUES ('identity_epoch',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(epoch)
    } else {
      db.prepare(`UPDATE message_participants SET participant_key=NULL, scope='unknown', key_version=NULL,
        identity_status='unknown', identity_reason='safe_storage_unavailable' WHERE participant_key IS NOT NULL`).run()
    }

    const inserted = insertMessages(batch.items.map((item) => item.message), db)
    const processedBeforeMs = options.processedBeforeMs
    if (processedBeforeMs !== undefined && inserted.insertedMsgIds.length) {
      const insertedTs = new Map(batch.items.map((item) => [deriveMsgId(item.message), item.message.ts]))
      const oldIds = inserted.insertedMsgIds.filter((id) => {
        const ts = insertedTs.get(id)
        return ts !== undefined && ts < processedBeforeMs
      })
      const markOldProcessed = db.prepare('UPDATE messages SET processed=1 WHERE msg_id=? AND processed=0')
      for (const id of oldIds) markOldProcessed.run(id)
    }
    const upsertParticipant = db.prepare(`INSERT INTO message_participants
      (msg_id,chat_id,participant_key,scope,key_version,identity_status,identity_reason,is_me)
      VALUES (@msgId,@chatId,@participantKey,@scope,@keyVersion,@status,@reason,@isMe)
      ON CONFLICT(msg_id) DO UPDATE SET chat_id=excluded.chat_id, participant_key=excluded.participant_key,
        scope=excluded.scope,key_version=excluded.key_version,identity_status=excluded.identity_status,
        identity_reason=excluded.identity_reason,is_me=excluded.is_me`)
    let keyedIdentityCount = 0
    let unknownIdentityCount = 0
    for (const item of batch.items) {
      const msgId = deriveMsgId(item.message)
      const resolved = (() => {
        try { return identity.resolve({ senderMid: item.senderMid, accountMid: item.accountMid, chatId: item.message.chatId }) }
        catch { return { participantKey: null, scope: 'unknown' as const, keyVersion: null, status: 'unknown' as const, reason: 'identity_failure' as const } }
      })()
      const knownSelf = item.senderMid !== null && item.accountMid !== null
        ? Number(item.senderMid === item.accountMid) : null
      const status = resolved.participantKey ? 'keyed' : 'unknown'
      if (status === 'keyed') keyedIdentityCount++
      else unknownIdentityCount++
      if (status === 'unknown' && identity.persistUnknown === false) continue
      upsertParticipant.run({ msgId, chatId: item.message.chatId,
        participantKey: resolved.participantKey, scope: resolved.scope, keyVersion: resolved.keyVersion,
        status, reason: resolved.reason ?? (status === 'unknown' ? 'identity_failure' : null), isMe: knownSelf })
    }

    // Additive and best effort: a failure rolls back only this savepoint, never the messages, participants or receipt.
    if (batch.avatarMeta && isLineAvatarSchemaReady(db)) {
      try { db.transaction(() => writeImportAvatarMeta(db, batch, Date.now(), committedAt))() } catch { /* avatars are refreshed later (layered reader, backfill) */ }
    }

    const receipt = db.prepare(`INSERT OR IGNORE INTO line_import_batches
      (batch_id,source,cursor_from_created_time,cursor_from_row_id,cursor_to_created_time,cursor_to_row_id,
       row_count,keyed_identity_count,unknown_identity_count,has_more,coverage_status,observed_at,committed_at)
      VALUES (@batchId,@source,@fromTime,@fromRow,@toTime,@toRow,@rowCount,@keyed,@unknown,@hasMore,@coverage,@observed,@committed)`)
    const receiptInserted = receipt.run({ batchId: batch.batchId, source: batch.source,
      fromTime: batch.cursorFrom.createdTime, fromRow: batch.cursorFrom.rowId,
      toTime: batch.cursorTo.createdTime, toRow: batch.cursorTo.rowId,
      rowCount: batch.items.length, keyed: keyedIdentityCount, unknown: unknownIdentityCount,
      hasMore: Number(batch.hasMore), coverage: batch.hasMore ? 'partial' : 'complete',
      observed: batch.observedAt, committed: committedAt }).changes > 0
    return { inserted: inserted.inserted, insertedMsgIds: inserted.insertedMsgIds,
      mediaBackfilled: inserted.mediaBackfilled, unsentMarked: inserted.unsentMarked,
      metadataBackfilled: inserted.metadataBackfilled,
      chatIds: inserted.chatIds, receiptInserted, keyedIdentityCount, unknownIdentityCount }
  })
  return tx()
}

/** Stable receipt id helper for synthetic import fixtures. */
export function lineImportBatchId(source: string, from: { createdTime: number; rowId: number }, to: { createdTime: number; rowId: number }): string {
  return createHash('sha256').update(`${source}\0${from.createdTime}:${from.rowId}\0${to.createdTime}:${to.rowId}`).digest('hex')
}
