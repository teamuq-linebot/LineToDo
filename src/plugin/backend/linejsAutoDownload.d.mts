export const MAX_AUTO_DOWNLOAD_BYTES: number
export const MAX_SAVED_FILE_CHUNK_BYTES: number
export class AutoDownloadStore {
  constructor(dataDir: string, options?: Record<string, unknown>)
  dataDir: string
  ownerKey: string | null
  enabled: boolean
  jobs: Map<string, any>
  init(): Promise<unknown>
  close(): Promise<void>
  setOwner(accountId: string): void
  snapshot(): Record<string, any>
  keyFor(chatId: string, messageId: string, kind: string): string
  enqueue(input: Record<string, any>): Promise<any>
  saveFile(key: string, body: Uint8Array, options?: { signal?: AbortSignal }): Promise<any>
  retry(key: string): Promise<any>
  readSavedChunk(key: string, offset: number, length: number): Promise<{ name: string; size: number; offset: number; data: string } | null>
  flush(): Promise<void>
}

// X2a
export function detectSupportedImageMime(body: Uint8Array): string | null
export function detectSupportedVideoMime(head: Uint8Array, declared?: string): string | null
export const UNSUPPORTED_VIDEO_BRANDS: readonly string[]
export function isUnsupportedVideoBrand(brand: string): boolean
export function writeFileDurable(file: string, data: string | Uint8Array): Promise<void>
export const MEDIA_LEDGER_NAME: string
export const MEDIA_LEDGER_V1_NAME: string
export const MEDIA_LEDGER_TERMINAL_MAX: number
export const MEDIA_LEDGER_RETRY_COOLDOWN_MS: number
export function mediaStem(msgId: string): string
export function ledgerOwner(accountId: string): string
export function ledgerFingerprint(oid: string | undefined | null, sid: string | undefined | null): string
export type MediaLedgerState = 'queued' | 'running' | 'paused' | 'done' | 'failed'
export interface MediaLedgerEntry {
  owner: string
  stem: string
  origin: 'history' | 'receive' | 'outbound' | 'backfill'
  kind: 'IMAGE' | 'VIDEO' | 'FILE'
  state: MediaLedgerState
  class: string | null
  code: string | null
  attempts: number
  nextAt: number | null
  bytesDone: number
  declaredBytes: number | null
  sessionId?: string
  fingerprint: string | null
  partName?: string
  createdAt: number
  updatedAt: number
}
export function isTerminalNegative(entry: MediaLedgerEntry | null | undefined): boolean
export function ledgerBlocks(entry: MediaLedgerEntry | null | undefined, context?: { sessionId?: string | null }): boolean
export class MediaLedger {
  constructor(dir: string, options?: { now?: () => number; terminalMax?: number; log?: (line: string) => void })
  readonly file: string
  readonly v1File: string
  entries: Map<string, MediaLedgerEntry>
  terminalCount: number
  migratedFromV1: number
  quarantined: string | null
  load(): Promise<ReturnType<MediaLedger['counts']>>
  key(owner: string, stem: string): string
  get(owner: string, stem: string, options?: { fingerprint?: string }): MediaLedgerEntry | null
  begin(owner: string, stem: string, fields: { origin: MediaLedgerEntry['origin']; kind: MediaLedgerEntry['kind']; declaredBytes?: number | null; fingerprint?: string | null; sessionId?: string }): MediaLedgerEntry
  running(owner: string, stem: string, fields?: { partName?: string; sessionId?: string }): MediaLedgerEntry | null
  record(owner: string, stem: string, outcome: { status: 'done'; bytes: number; mime: string } | { status: 'failed' | 'paused'; class: string; code: string; retryAfterMs?: number }, context?: { sessionId?: string; bytesDone?: number }): MediaLedgerEntry | null
  put(entry: MediaLedgerEntry): MediaLedgerEntry
  remove(owner: string, stem: string): boolean
  evict(): number
  counts(): { total: number; queued: number; running: number; paused: number; done: number; failed: number; terminalNegative: number; migratedFromV1: number }
  flush(): Promise<void>
}
