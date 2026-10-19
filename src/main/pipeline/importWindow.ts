import type { CommitLineImportResult } from '../db/lineImport.repo'
import type { LineImportBatch, LineSourceCursor } from '../line/importTypes'
import type { RawLineMessage } from '../line/types'

export interface ImportWindowResult {
  messages: RawLineMessage[]
  commits: CommitLineImportResult[]
}

/** Drain every composite-cursor page and durably commit each page before exposing it to a backfill consumer. */
export async function fetchAndCommitImportWindow(
  sinceMs: number,
  fetchBatch: (cursor: LineSourceCursor, opts: { limit: number }) => Promise<LineImportBatch>,
  commitBatch: (batch: LineImportBatch) => CommitLineImportResult,
  limit = 20000,
  signal?: AbortSignal,
): Promise<ImportWindowResult> {
  const messages: RawLineMessage[] = []
  const commits: CommitLineImportResult[] = []
  let cursor: LineSourceCursor = { createdTime: sinceMs, rowId: Number.MAX_SAFE_INTEGER }
  for (let pageNo = 0; pageNo < 10000; pageNo += 1) {
    if (signal?.aborted) throw new Error('LINE backfill aborted')
    const batch = await fetchBatch(cursor, { limit })
    if (signal?.aborted) throw new Error('LINE backfill aborted')
    if (batch.cursorFrom.createdTime !== cursor.createdTime || batch.cursorFrom.rowId !== cursor.rowId) {
      throw new Error('LINE backfill cursor mismatch')
    }
    commits.push(commitBatch(batch))
    messages.push(...batch.items.map((item) => item.message))
    if (!batch.hasMore) return { messages, commits }
    if (batch.cursorTo.createdTime < cursor.createdTime ||
        (batch.cursorTo.createdTime === cursor.createdTime && batch.cursorTo.rowId <= cursor.rowId)) {
      throw new Error('LINE backfill cursor did not advance')
    }
    cursor = batch.cursorTo
  }
  throw new Error('LINE backfill exceeded page safety limit')
}
