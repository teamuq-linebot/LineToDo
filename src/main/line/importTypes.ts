import type { RawLineMessage } from './types'

export interface LineSourceCursor {
  createdTime: number
  rowId: number
}

/** Main-process-only item. senderMid/accountMid must never leave import persistence. */
export interface LineImportItem {
  message: RawLineMessage
  sourceRowId: number
  senderMid: string | null
  accountMid: string | null
}

export interface LineImportBatch {
  batchId: string
  source: 'line-watch' | 'line-backfill'
  cursorFrom: LineSourceCursor
  cursorTo: LineSourceCursor
  hasMore: boolean
  observedAt: string
  items: LineImportItem[]
}
